"""人員タイムチャート endpoints: the analytic staffing solver, the editable
work-process master (CRUD), and the cross-scenario staffing comparison. All read
the project's best-available 物量 and staff it through the editable process flow —
no DES."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ._common import _open

router = APIRouter()


def _resolve_persisted_overlay(model, payload: dict, payload_key: str, attr: str):
    """Resolve a solver overlay (batch_schedule / shift_plan) with persistence.

    An explicit dict in the request wins and is written onto ``settings.<attr>``
    (an explicit ``{}`` intentionally clears it); anything else (absent / non-dict)
    falls back to the persisted value. Returns ``(value, changed)`` so the caller
    saves the model exactly once when any overlay actually changed."""
    incoming = payload.get(payload_key)
    persisted = getattr(model.settings, attr, {}) or {}
    if not isinstance(incoming, dict):
        return persisted, False
    if incoming != persisted:
        setattr(model.settings, attr, incoming)
        return incoming, True
    return incoming, False


@router.post("/api/projects/{name}/timetable/solve-staffing")
def api_timetable_solve_staffing(name: str, payload: dict | None = None):
    """人員タイムチャート 解析ソルバー: set an operating window (start–end hour) and a
    headcount cap (global and/or per-process), pull library productivity (3-tier
    実測>想定>既定), and analytically solve the per-hour headcount per process to
    clear the day's volume under the cap — honouring process precedence (入荷→格納,
    ピッキング→梱包→出荷) and a placement choice (前詰め vs 均等). Deterministic, no DES.

    Body (all optional): {start_hour, end_hour, cap, per_process_cap{id:n},
    dependencies{id:[upstream]}, placement('front'|'level'), volumes{id:vol}}.
    When `volumes` is omitted the project's best-available 物量 is derived
    (BI 仮値 > measured orders). never-blocks: no demand → {available:false}."""
    from whsim.analysis import staffing
    proj = _open(name)
    p = payload or {}
    vols = p.get("volumes")
    if not isinstance(vols, dict) or not any(float(v or 0) > 0 for v in vols.values()):
        vols = staffing.project_volumes(proj)
    if not vols or not any(float(v or 0) > 0 for v in vols.values()):
        return {"available": False,
                "message": "荷役物量がまだありません。マテリアルフローで物量を作成してください。"}
    model = proj.load_model()
    # バッチ投入スケジュール & シフト・休憩モデル: an explicit payload dict wins and is
    # persisted so the plan survives a reload (an explicit {} clears it); otherwise
    # the persisted schedule is used. Save the model once iff either overlay changed.
    batches, batches_changed = _resolve_persisted_overlay(
        model, p, "batches", "batch_schedule")
    shift_plan, shift_changed = _resolve_persisted_overlay(
        model, p, "shift_plan", "shift_plan")
    if batches_changed or shift_changed:
        proj.save_model(model)
    try:
        result = staffing.solve_staffing(
            vols, model=model,
            start_hour=int(p.get("start_hour", 9)),
            end_hour=int(p.get("end_hour", 18)),
            cap=(int(p["cap"]) if p.get("cap") else None),
            per_process_cap=p.get("per_process_cap") or {},
            dependencies=p.get("dependencies"),
            placement=str(p.get("placement", "level")),
            batches=batches,
            shift_plan=shift_plan,
        )
    except (TypeError, ValueError) as e:
        raise HTTPException(400, f"ソルバー入力が不正です: {e}") from e
    result["available"] = True
    result["volumes"] = {k: round(float(v), 1) for k, v in vols.items()}
    result["default_dependencies"] = staffing.default_dependencies()
    return result


@router.get("/api/projects/{name}/work-processes")
def api_work_processes_get(name: str):
    """The project's editable work-process master (custom list when set, else the
    engine default 6-process flow). Powers the 完全フリー工程 editor + material flow:
    each process has id/section/driver/prod/unit/depends. Also returns the driver
    catalogue (volume sources) and the engine default for a one-click reset."""
    from whsim.analysis import staffing
    proj = _open(name)
    return {
        "processes": staffing.flow_seed(proj.load_model()),
        "default": staffing.flow_seed(None),
        "drivers": [dict(d) for d in staffing.DRIVER_CATALOG],
    }


@router.post("/api/projects/{name}/work-processes")
def api_work_processes_save(name: str, payload: dict | None = None):
    """Persist an edited work-process master. Body: {processes: [{id, section,
    driver, prod, unit, depends}]}. Empty/absent processes ⇒ reset to the engine
    default. Tolerant: blank/duplicate ids are dropped, dangling/self dependencies
    are pruned so the precedence DAG stays valid. never-blocks."""
    from whsim.analysis import staffing
    from whsim.schema.model import WorkProcess
    proj = _open(name)
    model = proj.load_model()
    rows = (payload or {}).get("processes")
    # Only these drivers map to a volume母数 (cost._DRIVER_VOL / the solver). An
    # unknown driver would silently yield 0 volume → 0 cost, so coerce to out_lines.
    known_drivers = staffing.KNOWN_DRIVERS
    wps: list[WorkProcess] = []
    if isinstance(rows, list):
        seen: set[str] = set()
        for r in rows:
            if not isinstance(r, dict):
                continue
            pid = str(r.get("id") or "").strip()
            if not pid or pid in seen:
                continue
            seen.add(pid)
            try:
                prod = float(r.get("prod", r.get("productivity", 60)) or 60)
            except (TypeError, ValueError):
                prod = 60.0
            drv = str(r.get("driver") or "out_lines")
            if drv not in known_drivers:
                drv = "out_lines"
            wps.append(WorkProcess(
                id=pid,
                section=str(r.get("section") or "出荷"),
                driver=drv,
                prod=prod if prod > 0 else 60.0,
                unit=str(r.get("unit") or "行/h"),
                depends=[str(u) for u in (r.get("depends") or [])],
                role=str(r.get("role") or ""),
                zone=str(r.get("zone") or ""),
            ))
        ids = {w.id for w in wps}
        for w in wps:  # prune dangling / self edges → valid DAG
            w.depends = [u for u in w.depends if u in ids and u != w.id]
    model.process.work_processes = wps  # [] ⇒ reset to engine default
    proj.save_model(model)
    return {"processes": staffing.flow_seed(model), "saved": len(wps)}


@router.get("/api/projects/{name}/timetable/compare")
def api_timetable_compare(name: str, start_hour: int = 9, end_hour: int = 18,
                          cap: int = 0, placement: str = "level"):
    """Compare staffing across the CURRENT design and every saved scenario, under a
    shared operating window/cap — so a planner can park 「朝寄せ案」「夕締め案」
    「マルチ方式」 and read the peak人数 / 総工数 / 終了時刻 / 月額原価 / 作業方式
    delta. The same project demand is run through each scenario's design (its frozen
    batch schedule + work method + processes), isolating the OPERATIONS choice.
    never-blocks: no demand → {available:false}."""
    from whsim import cost as cost_mod, scenariostore, workmethod
    from whsim.analysis import staffing
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    vols = staffing.project_volumes(proj)
    avail = bool(vols and any(float(v or 0) > 0 for v in vols.values()))

    def kpis_for(model, label, sid):
        batches = getattr(model.settings, "batch_schedule", {}) or {}
        # The scenario's frozen シフト・休憩 overlay (settings.shift_plan) flows here so
        # 休憩帯/シフト caps + labour cost participate in the comparison.
        shift_plan = getattr(model.settings, "shift_plan", {}) or {}
        res = {}
        if avail:
            try:  # one pathological scenario must not 500 the whole comparison
                res = staffing.solve_staffing(
                    vols, model=model, start_hour=int(start_hour), end_hour=int(end_hour),
                    cap=(int(cap) or None), placement=str(placement), batches=batches,
                    shift_plan=shift_plan)
            except Exception:  # noqa: BLE001 — degrade this row, keep the rest
                res = {}
        try:
            c = cost_mod.estimate_cost(model)
        except Exception:  # noqa: BLE001 — cost is best-effort in a compare row
            c = {}
        method = "—"
        try:
            ps = model.process.pick_stage()
            if ps is not None and ps.work is not None:
                method = workmethod.method_name(ps.work)
            else:
                # No 5-axis work set → fall back to the legacy pick_strategy, mapped
                # to the unified taxonomy so the column reads meaningfully.
                method = {
                    "discrete": "シングルオーダー", "batch": "マルチオーダー",
                    "zone": "ゾーン（リレー）", "wave": "バッチ投入",
                }.get(getattr(model.process, "pick_strategy", ""), "—")
        except Exception:  # noqa: BLE001
            pass
        return {
            "id": sid, "label": label,
            "peak_headcount": res.get("peak_headcount"),
            "total_man_hours": res.get("total_man_hours"),
            "makespan_hour": res.get("makespan_hour"),
            "feasible": res.get("feasible"),
            "monthly_cost": c.get("total_yen_month"),
            "cost_per_order": c.get("cost_per_order"),
            "labour_cost_day": res.get("labour_cost_day"),
            "method": method,
            "batch_counts": {k: len(v) for k, v in batches.items() if v},
        }

    base = proj.load_model()
    base_md = base.model_dump()   # load once, overlay each scenario's frozen sections
    rows = [kpis_for(base, "現在の設計", "__current__")]
    for hdr in scenariostore.list_scenarios(proj):
        doc = scenariostore.get_scenario(proj, hdr["id"])
        if not doc:
            continue
        md = {**base_md, **{k: v for k, v in (doc.get("sections") or {}).items()}}
        try:
            m = WarehouseModel.model_validate(md)
        except Exception:  # noqa: BLE001 — a bad overlay is skipped, never fatal
            continue
        rows.append(kpis_for(m, hdr.get("label", hdr["id"]), hdr["id"]))
    return {"available": avail, "rows": rows}


# ---- 業務フロー・設備接続 (the ONE flow graph; see whsim/flowgraph.py) --------

@router.get("/api/projects/{name}/flow")
def api_flow_get(name: str):
    """The resolved flow graph + what it can be wired to.

    One payload for both flow surfaces (③設計フロー / ②マテリアルフロー): the nodes,
    the edges (authored or derived from `depends`), the physical objects an edge
    may reference, and the diagnostics. never-blocks: a bare project answers with
    an empty graph rather than an error."""
    from whsim import flowgraph, loadunit
    proj = _open(name)
    model = proj.load_model()
    g = flowgraph.resolve(model)
    return {
        "nodes": [{"id": n.id, "role": n.role, "zone": n.zone, "section": n.section,
                   "simulated": n.simulated} for n in g.nodes],
        "edges": [{"src": e.src, "dst": e.dst, "transport": e.transport,
                   "equipment_ref": e.equipment_ref, "share": e.share,
                   "derived": e.derived, "container_ref": e.container_ref,
                   "carrier_ref": e.carrier_ref} for e in g.edges],
        # 荷姿カタログ (資材マスタ). Always present, always defaulted — the screen
        # never has to ask the user to build one before it can draw.
        "load_units": loadunit.catalog(model),
        # everything an edge may bind to, with the label the UI should show
        "equipment": (
            [{"id": str(c.id), "kind": "conveyor", "label": f"コンベア {c.id}",
              "speed_mps": float(c.speed_mps),
              "points": [[float(x), float(y)] for x, y in
                         ((p[0], p[1]) for p in c.points if len(p) >= 2)]}
             for c in (model.resources.conveyors or [])]
            + [{"id": str(e.id), "kind": e.type, "label": f"{e.type} {e.id}",
                "count": int(e.count), "x": float(e.x), "y": float(e.y)}
               for e in (model.resources.equipment or [])]
        ),
        "roles": sorted(flowgraph.ENGINE_ROLES),
        "authored": bool(model.process.flow_edges),
        "diagnostics": flowgraph.diagnose(model),
    }


@router.post("/api/projects/{name}/flow")
def api_flow_save(name: str, payload: dict | None = None):
    """Persist authored flow edges. Body: {edges: [{src,dst,transport,
    equipment_ref,share}]}. Empty/absent ⇒ clear back to the DERIVED graph, so a
    user can always get back to "just follow the process order". Tolerant: edges
    naming unknown processes are dropped, unknown transports coerce to 人手."""
    from whsim import flowgraph
    from whsim.schema.model import FlowEdge
    proj = _open(name)
    model = proj.load_model()
    known = {n.id for n in flowgraph.resolve(model).nodes}
    means = {"manual", "conveyor", "agv", "forklift", "asrs"}

    edges: list[FlowEdge] = []
    rows = (payload or {}).get("edges")
    if isinstance(rows, list):
        for i, r in enumerate(rows):
            if not isinstance(r, dict):
                continue
            src, dst = str(r.get("src") or ""), str(r.get("dst") or "")
            if (src and src not in known) or (dst and dst not in known) or not dst:
                continue
            t = str(r.get("transport") or "manual")
            try:
                share = float(r.get("share", 1.0))
            except (TypeError, ValueError):
                share = 1.0
            edges.append(FlowEdge(
                id=str(r.get("id") or f"e{i}"), src=src, dst=dst,
                transport=t if t in means else "manual",
                equipment_ref=str(r.get("equipment_ref") or ""),
                share=min(max(share, 0.0), 1.0),
                container_ref=str(r.get("container_ref") or ""),
                carrier_ref=str(r.get("carrier_ref") or "")))
    model.process.flow_edges = edges
    proj.save_model(model)
    return {"saved": len(edges), "diagnostics": flowgraph.diagnose(model)}


@router.get("/api/projects/{name}/loadunits")
def api_loadunits_get(name: str):
    """荷姿カタログ (資材マスタ) + which ones the design references.

    Always answers with a full catalogue — the engine default when the project
    has never edited one — so the flow screen can offer 折コン/カゴ車 from the
    first click instead of demanding a materials master first."""
    from whsim import flowgraph, loadunit
    proj = _open(name)
    model = proj.load_model()
    return {
        "units": loadunit.catalog(model),
        "in_use": sorted(flowgraph.loadunits_in_use(model)),
        "default": loadunit.DEFAULT_UNITS,
        "base_units": sorted(loadunit.BASE_UNITS),
        "customised": bool(model.load_units),
    }


@router.post("/api/projects/{name}/loadunits")
def api_loadunits_save(name: str, payload: dict | None = None):
    """Persist an edited 荷姿カタログ. Body: {units:[{id,name,kind,capacity,
    footprint_m2}]}. Empty/absent ⇒ reset to the engine default. Tolerant:
    blank/duplicate ids dropped, non-positive capacities dropped."""
    from whsim import loadunit
    from whsim.schema.model import LoadUnit
    proj = _open(name)
    model = proj.load_model()
    kinds = {"container", "carrier", "pallet", "base"}
    rows = (payload or {}).get("units")
    out: list[LoadUnit] = []
    if isinstance(rows, list):
        seen: set[str] = set()
        for r in rows:
            if not isinstance(r, dict):
                continue
            uid = str(r.get("id") or "").strip()
            if not uid or uid in seen:
                continue
            seen.add(uid)
            cap: dict[str, float] = {}
            for k, v in (r.get("capacity") or {}).items():
                try:
                    f = float(v)
                except (TypeError, ValueError):
                    continue
                if f > 0:
                    cap[str(k)] = f
            try:
                foot = max(float(r.get("footprint_m2") or 0.0), 0.0)
            except (TypeError, ValueError):
                foot = 0.0
            kind = str(r.get("kind") or "container")
            out.append(LoadUnit(id=uid, name=str(r.get("name") or uid),
                                kind=kind if kind in kinds else "container",
                                capacity=cap, footprint_m2=foot,
                                provisional=bool(r.get("provisional", True))))
    model.load_units = out
    proj.save_model(model)
    return {"units": loadunit.catalog(model), "saved": len(out)}


@router.get("/api/projects/{name}/loadunits/convert")
def api_loadunits_convert(name: str, pieces: float = 0.0, cases: float = 0.0,
                          container: str = "", carrier: str = ""):
    """バラ/ケース → 容器 → 台車, with the arithmetic shown (`chain`).

    Lets the flow screen echo 「バラ2,500点 ÷30 = 84オリコン → 15カゴ台車」 the
    instant a 荷姿 is picked, without duplicating the formula in JS."""
    from whsim import loadunit
    model = _open(name).load_model()
    return loadunit.convert(model, pieces=pieces, cases=cases,
                            container_ref=container, carrier_ref=carrier)


@router.get("/api/projects/{name}/wip")
def api_wip(name: str, start_hour: int = 9, end_hour: int = 18,
            cap: int = 0, placement: str = "level"):
    """滞留カーブ: how much piles up between each pair of processes, in that leg's
    own 荷姿, plus the 台車 fleet and 仮置き坪 the day needs.

    Analytic (no DES), so a 荷姿 change re-costs the whole day instantly. Answers
    「検品前にカゴ車は最大何台溜まるか / 仮置きに何坪要るか / 台車を何台持てばいいか」.
    never-blocks: no volume ⇒ {available:false} rather than an error."""
    from whsim import wipcurve
    from whsim.analysis import staffing
    proj = _open(name)
    model = proj.load_model()
    vols = staffing.project_volumes(proj)
    if not vols or not any(float(v or 0) > 0 for v in vols.values()):
        return {"available": False, "reason": "物量が未取込です", "edges": [], "fleet": []}
    solved = staffing.solve_staffing(
        vols, model=model, start_hour=start_hour, end_hour=end_hour,
        cap=(int(cap) or None), placement=placement,
        batches=(model.settings.batch_schedule or None
                 if hasattr(model.settings, "batch_schedule") else None))
    base = {}
    try:
        from whsim import bi
        base = bi.base_volumes(model) or {}
    except Exception:      # noqa: BLE001 — no DuckDB/no data is not an error here
        base = {}
    out = wipcurve.all_edges(model, solved, base)
    out["window"] = {"start_hour": start_hour, "end_hour": end_hour}
    return out
