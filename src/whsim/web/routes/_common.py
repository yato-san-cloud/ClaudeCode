"""Shared helpers for the web API routers.

Pure functions over the whsim core (no router/app state), imported by every
``routes/*`` module so each router stays a thin, independently-testable slice.
The FastAPI app, static mount and the run-concurrency machinery live in
``whsim.web.app`` (see the note there): they intentionally stay in one module so
``whsim.web.app.run_replications`` / ``_inflight_runs`` remain monkeypatchable.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import HTTPException, UploadFile

from whsim.project import Project
from whsim.provenance import Source  # re-exported for routers

# Monte-Carlo replications behind every web run (variability is shown, not configured).
MONTE_CARLO_REPS = 10

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB hard cap on any single upload

__all__ = [
    "Source",
    "MONTE_CARLO_REPS",
    "MAX_UPLOAD_BYTES",
    "_safe_name",
    "_set_by_path",
    "_open",
    "_read_upload",
    "_project_dir",
    "_free_project_name",
    "_sample_zip_path",
    "_headline_values",
    "_analysis_payload",
    "_latest_compare",
    "_proposal_extras",
    "_call_export",
]


def _safe_name(name: str) -> str:
    """Validate a user-supplied identifier that becomes a filesystem path segment.

    Project names (and run/compare ids) are used directly under ``projects/`` and
    ``runs/`` (``base / name``), so an attacker-controlled ``..`` or path
    separator must never escape the workspace.

    Crucially we don't just *check* the raw name and pass it through: the actual
    on-disk segment is decided by ``whsim.project.safe_name`` (called inside
    ``Project.create`` / ``Project.open``), which silently transforms unsafe
    characters (``a:b`` -> ``a_b``, control chars -> ``_``, ...). The web layer
    used to apply a *different*, looser check, so path-building endpoints
    (delete / rename / duplicate / compare-png) computed ``projects/<raw>`` while
    the project actually lived at ``projects/<sanitised>`` -- a real bug that
    pointed those operations at the wrong (or a non-existent) directory.

    The fix: reject (400) anything that is not already in canonical form, i.e.
    any name the project sanitiser would have transformed. That keeps a single
    source of truth (the accepted name == the stored segment) and still rejects
    separators / NUL / dot-only names exactly as before.
    """
    name = (name or "").strip()
    if not name or set(name) <= {"."}:
        raise HTTPException(400, "invalid name")
    if "/" in name or "\\" in name or "\x00" in name or name in (".", ".."):
        raise HTTPException(400, "invalid name")
    # Single source of truth: the name must already be exactly what the project
    # sanitiser would store, so the segment used for path building can never
    # diverge from where the project actually lives on disk.
    from whsim.project import safe_name as _project_safe_name
    try:
        if _project_safe_name(name) != name:
            raise HTTPException(400, "invalid name")
    except (ValueError, TypeError):
        raise HTTPException(400, "invalid name")
    return name


def _set_by_path(model_dict: dict, path: str, value) -> str:
    """Set a dotted path like 'resources.workers.0.count'; return top subtree."""
    parts = path.split(".")
    cur = model_dict
    for p in parts[:-1]:
        cur = cur[int(p)] if p.isdigit() else cur[p]
    last = parts[-1]
    if last.isdigit():
        cur[int(last)] = value
    else:
        cur[last] = value
    return parts[0]


def _open(name: str) -> Project:
    name = _safe_name(name)
    try:
        return Project.open(name)
    except FileNotFoundError:
        raise HTTPException(404, f"no project {name!r}")


async def _read_upload(file: UploadFile, max_bytes: int = MAX_UPLOAD_BYTES) -> bytes:
    """Read an upload in chunks with a hard size cap so a huge (or malicious)
    file can't exhaust memory. Raises 413 once the cap is exceeded."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1 << 20)  # 1 MiB at a time
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(413, f"ファイルが大きすぎます（上限 {max_bytes // (1024 * 1024)}MB）。")
        chunks.append(chunk)
    return b"".join(chunks)


def _project_dir(name: str) -> Path:
    """Resolve a validated project name to its directory under PROJECTS_DIR.

    Read PROJECTS_DIR lazily on each call so tests that monkeypatch it (into a
    tmp dir) are honoured. The name is validated with ``_safe_name`` first, so
    no separator / traversal can escape the workspace."""
    from whsim.project import PROJECTS_DIR
    return PROJECTS_DIR / _safe_name(name)


def _free_project_name(preferred: str) -> str:
    """Pick a non-colliding project name. Try `preferred`, then `demo-2`,
    `demo-3`, ... so the one-click demo never fails because a name is taken."""
    from whsim.project import PROJECTS_DIR

    def taken(n: str) -> bool:
        return (PROJECTS_DIR / n / "project.json").is_file()

    if not taken(preferred):
        return preferred
    base = preferred if preferred != "デモ" else "demo"
    i = 2
    while taken(f"{base}-{i}"):
        i += 1
    return f"{base}-{i}"


def _sample_zip_path() -> Path | None:
    """Locate the bundled sample ZIP under the repo's examples/, generating it
    on demand if the helper is available. Returns None if nothing can be found."""
    # Resolve examples/ relative to the installed package's repo root.
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / "examples" / "acme_upload.zip"
        if cand.is_file():
            return cand
    # Not present: try to generate it via the bundled script (best effort).
    for parent in here.parents:
        script = parent / "scripts" / "gen_sample_data.py"
        if script.is_file():
            try:
                import runpy
                runpy.run_path(str(script), run_name="__main__")
            except Exception:  # noqa: BLE001 — generation is best effort
                pass
            cand = parent / "examples" / "acme_upload.zip"
            return cand if cand.is_file() else None
    return None


def _headline_values(model_dict: dict, manifest: dict) -> dict:
    out = {}
    for f in manifest.get("headline_fields", []):
        path = f["path"]
        cur = model_dict
        try:
            for p in path.split("."):
                cur = cur[int(p)] if p.isdigit() else cur[p]
            out[path] = cur
        except (KeyError, IndexError, ValueError):
            out[path] = None
    return out


def _latest_compare(proj: Project) -> dict | None:
    """Load the most recent persisted scenario comparison (``compare_*/compare.json``),
    or None if no comparison has been run. Never raises."""
    try:
        comps = sorted(proj.runs_dir.glob("compare_*"))
    except Exception:  # noqa: BLE001
        return None
    for d in reversed(comps):
        f = d / "compare.json"
        if f.is_file():
            try:
                data = json.loads(f.read_text("utf-8"))
                if isinstance(data, dict):
                    return data
            except Exception:  # noqa: BLE001 — skip a corrupt record
                continue
    return None


def _proposal_extras(proj: Project, model, metrics: dict) -> dict:
    """Assemble the richer optional args for export_doc from project artifacts.

    Returns ``{"scenarios", "insights", "provenance"}``:
      - ``scenarios``: the latest persisted what-if comparison (baseline +
        alternatives w/ payback), or None.
      - ``insights``: the SAME recommendation list the analysis dashboard shows,
        reused via ``_analysis_payload`` so the two never drift.
      - ``provenance``: the "N% your data" summary string.
    Every step degrades to None on missing/broken data so export never 500s."""
    scenarios = _latest_compare(proj)
    insights = None
    try:
        insights = _analysis_payload(model, metrics, "run").get("insights")
    except Exception:  # noqa: BLE001 — insights are an enhancement, never required
        insights = None
    try:
        provenance = proj.load_provenance().summary()
    except Exception:  # noqa: BLE001
        provenance = None
    # 保管設計の試算 (間口/台数/坪数) so the proposal carries the equipment plan.
    try:
        from whsim import storage as _storage
        storage = _storage.estimate_storage(model, {})
        if not storage.get("has_data"):
            storage = None
    except Exception:  # noqa: BLE001 — storage section is an enhancement, optional
        storage = None
    return {"scenarios": scenarios, "insights": insights,
            "provenance": provenance, "storage": storage}


def _call_export(builder, kpis, model_name, prov, png, out, extras: dict):
    """Call an export_doc builder, passing the richer optional args when the
    builder accepts them (export owner adds scenarios/insights/provenance). Falls
    back to the original positional signature if those params are absent, so the
    endpoint works against either version of export_doc."""
    try:
        return builder(kpis, model_name, prov, png, out,
                       scenarios=extras.get("scenarios"),
                       insights=extras.get("insights"),
                       provenance=extras.get("provenance"),
                       storage=extras.get("storage"))
    except TypeError:
        # Builder predates one of the optional params — retry without the newest
        # (storage), then fall back to the original positional signature.
        try:
            return builder(kpis, model_name, prov, png, out,
                           scenarios=extras.get("scenarios"),
                           insights=extras.get("insights"),
                           provenance=extras.get("provenance"))
        except TypeError:
            return builder(kpis, model_name, prov, png, out)


def _analysis_payload(model, metrics: dict, source: str) -> dict:
    """Reshape whsim KPIs into the analysis-dashboard contract.

    Output:
      {
        source: "run" | "estimate",
        verdict: str | None,
        insights: [{severity, icon, title, fact, metric, action}],
        kpis: {hero: [{label, value, unit, delta}],
               groups: [{label, items:[{label, value, unit}]}]},
        charts: {stages: {...}, cost: {...}},
      }
    Defensive: every metric is read with .get and a default, so a thin analytic
    estimate (few keys) renders just as safely as a full Monte-Carlo run.
    """
    def g(key, default=0.0):
        v = metrics.get(key, default)
        return v if isinstance(v, (int, float)) else default

    md = model.model_dump()

    def _worker_edit(role: str, label_fmt: str) -> dict | None:
        """Build an {path,value,label} edit that bumps a worker group's count by
        one, reading the real schema index from the model dump. Returns None if
        no such worker group exists (so we never emit an invalid path)."""
        groups = md.get("resources", {}).get("workers", []) or []
        for i, w in enumerate(groups):
            if w.get("role") == role:
                cnt = int(w.get("count", 0))
                return {"path": f"resources.workers.{i}.count", "value": cnt + 1,
                        "label": label_fmt.format(n=cnt + 1)}
        return None

    def _agv_edit() -> dict | None:
        """Enable / raise the AGV fleet count by one. Targets the first AGV-type
        equipment entry if present; otherwise None (no equipment list to edit)."""
        equip = md.get("resources", {}).get("equipment", []) or []
        for i, e in enumerate(equip):
            if e.get("type") == "agv":
                cnt = int(e.get("count", 0))
                verb = "を1台追加" if cnt > 0 else "を1台導入"
                return {"path": f"resources.equipment.{i}.count", "value": cnt + 1,
                        "label": f"AGV{verb}"}
        return None

    cur = metrics.get("currency", "¥")
    pickers = int(g("n_pickers", 0))
    packers = int(g("n_packers", 0))
    headcount = int(g("headcount", pickers + packers))
    bottleneck_jp = metrics.get("bottleneck_jp")
    bn_util = g("bottleneck_utilization", g("picker_utilization", 0.0))
    completion = g("completion_rate", 1.0)
    pick_wait = metrics.get("pick_wait_mean_s")
    sort_wait = g("sort_wait_mean_s", 0.0)
    cost_per_order = g("total_cost_per_order", 0.0)
    monthly_cost = g("monthly_cost", 0.0)
    can_handle = bool(metrics.get("can_handle_demand", not metrics.get("overloaded", False)))

    # --- insights: "指摘 -> 提案" ------------------------------------------
    insights: list[dict] = []

    # 1) Bottleneck / capacity (danger if demand not met, warn if hot).
    if bottleneck_jp:
        wait_min = (pick_wait / 60.0) if isinstance(pick_wait, (int, float)) else None
        add_stage = {"梱包": "梱包台を1台増設", "ピッキング": "ピッカーを1名増員",
                     "AGV搬送": "AGVを1台追加", "種まき仕分け": "仕分け間口を増設"}
        action = f"{add_stage.get(bottleneck_jp, '当該工程の能力を増強')}で改善を検討。"
        # Compute a concrete one-click remedy from the live model. Map the raw
        # bottleneck stage to a count-bump on the corresponding resource; only
        # attach when a valid path+value can be derived (else omit `edit`).
        bn_raw = metrics.get("bottleneck")
        if bn_raw == "packing":
            remedy = _worker_edit("packer", "梱包担当を{n}名に増員")
        elif bn_raw == "picking":
            remedy = _worker_edit("picker", "ピッカーを{n}名に増員")
        elif bn_raw == "agv":
            remedy = _agv_edit()
        else:
            remedy = None
        if not can_handle:
            wtxt = f"（待ち {wait_min:.1f}分）" if wait_min is not None else ""
            ins = {
                "severity": "danger", "icon": "alert",
                "title": f"{bottleneck_jp}がボトルネック{wtxt}",
                "fact": f"稼働率 <span class=\"num\">{round(bn_util * 100)}</span>% / "
                        f"出荷完了 <span class=\"num\">{round(completion * 100)}</span>%。",
                "metric": f"{round(bn_util * 100)}%",
                "action": action,
            }
            if remedy:
                ins["edit"] = remedy
            insights.append(ins)
        elif bn_util >= 0.85:
            ins = {
                "severity": "warn", "icon": "trend",
                "title": f"{bottleneck_jp}の稼働率が高水準",
                "fact": f"稼働率 <span class=\"num\">{round(bn_util * 100)}</span>%。"
                        f"需要増で逼迫の恐れ。",
                "metric": f"{round(bn_util * 100)}%",
                "action": f"繁忙時間帯の{bottleneck_jp}増強余地を確認。",
            }
            if remedy:
                ins["edit"] = remedy
            insights.append(ins)
        else:
            insights.append({
                "severity": "ok", "icon": "check",
                "title": f"{bottleneck_jp}に余力あり（需要をさばけます）",
                "fact": f"最繁忙工程の稼働率 <span class=\"num\">{round(bn_util * 100)}</span>%。",
                "metric": f"{round(bn_util * 100)}%",
            })

    # 2) Sort/put-wall queueing (warn) if material.
    if sort_wait >= 30.0:
        insights.append({
            "severity": "warn", "icon": "bars",
            "title": f"種まき仕分けで待ちが発生（平均 {sort_wait / 60.0:.1f}分）",
            "fact": f"間口数 <span class=\"num\">{int(g('n_put_wall', 0))}</span> 口。",
            "metric": f"{sort_wait / 60.0:.1f}分",
            "action": "仕分け間口の追加、または波の平準化を検討。",
        })

    # 3) AGV under/over-utilisation (info) when an AGV fleet is present.
    n_agvs = int(g("n_agvs", 0))
    if n_agvs:
        agv_u = g("agv_utilization", 0.0)
        ins = {
            "severity": "info", "icon": "info",
            "title": f"AGV {n_agvs}台の稼働率は {round(agv_u * 100)}%",
            "fact": "低稼働なら台数の見直し、高稼働なら増車の検討材料。",
            "metric": f"{round(agv_u * 100)}%",
        }
        # When the fleet is running hot, offer a one-click "add an AGV".
        if agv_u >= 0.85:
            remedy = _agv_edit()
            if remedy:
                ins["edit"] = remedy
        insights.append(ins)

    # 4) Cost-per-order (info) when costed.
    if cost_per_order > 0:
        insights.append({
            "severity": "info", "icon": "info",
            "title": "1件あたり処理コスト",
            "fact": f"人件費・設備費を合算。月次コスト概算 "
                    f"<span class=\"num\">{cur}{round(monthly_cost):,}</span>。",
            "metric": f"{cur}{cost_per_order:,.1f}",
        })

    # --- hero KPIs ----------------------------------------------------------
    hero: list[dict] = []
    tput = g("throughput_per_hr", g("capacity_orders_per_hr", 0.0))
    if tput:
        hero.append({"label": "処理能力", "value": round(tput),
                     "unit": "件/時", "delta": None})
    hero.append({"label": "出荷完了率", "value": round(completion * 100),
                 "unit": "%",
                 "delta": {"dir": "up" if completion >= 0.98 else "down",
                           "text": "需要をさばけます" if can_handle else "要注意"}})
    if bottleneck_jp:
        hero.append({"label": f"{bottleneck_jp}稼働率", "value": round(bn_util * 100),
                     "unit": "%",
                     "delta": {"dir": "down" if bn_util >= 0.85 else "up",
                               "text": "高負荷" if bn_util >= 0.85 else "余力あり"}})
    if cost_per_order > 0:
        hero.append({"label": "1件あたりコスト", "value": round(cost_per_order, 1),
                     "unit": cur, "delta": None})
    if len(hero) < 4 and headcount:
        hero.append({"label": "必要人員", "value": headcount, "unit": "名", "delta": None})

    # --- grouped standard KPIs ---------------------------------------------
    groups: list[dict] = []
    vol = [it for it in (
        {"label": "到着オーダー", "value": round(g("orders_arrived")), "unit": "件"},
        {"label": "完了オーダー", "value": round(g("orders_completed")), "unit": "件"},
        {"label": "総歩行距離", "value": round(g("walk_total_m")), "unit": "m"},
        {"label": "1件あたり歩行", "value": round(g("walk_per_order_m"), 1), "unit": "m"},
    ) if it["value"]]
    if vol:
        groups.append({"label": "ボリューム", "items": vol})

    eff = []
    if g("picker_utilization"):
        eff.append({"label": "ピッキング稼働率",
                    "value": round(g("picker_utilization") * 100), "unit": "%"})
    if g("packer_utilization"):
        eff.append({"label": "梱包稼働率",
                    "value": round(g("packer_utilization") * 100), "unit": "%"})
    if g("cycle_mean_s"):
        eff.append({"label": "平均サイクル",
                    "value": round(g("cycle_mean_s") / 60.0, 1), "unit": "分"})
    if g("on_time_rate"):
        eff.append({"label": "納期遵守率",
                    "value": round(g("on_time_rate") * 100), "unit": "%"})
    if eff:
        groups.append({"label": "効率指標", "items": eff})

    cost_items = []
    if cost_per_order > 0:
        cost_items.append({"label": "1件あたりコスト",
                           "value": round(cost_per_order, 1), "unit": cur})
    if monthly_cost > 0:
        cost_items.append({"label": "月次コスト",
                           "value": round(monthly_cost), "unit": cur})
    if g("monthly_opex") > 0:
        cost_items.append({"label": "月次運用費",
                           "value": round(g("monthly_opex")), "unit": cur})
    if headcount:
        cost_items.append({"label": "人員", "value": headcount, "unit": "名"})
    if cost_items:
        groups.append({"label": "コスト・人員", "items": cost_items})

    # --- charts -------------------------------------------------------------
    # (a) per-stage utilisation (bar): the congestion picture.
    stage_rows = [("ピッキング", g("picker_utilization")),
                  ("梱包", g("packer_utilization"))]
    if n_agvs:
        stage_rows.append(("AGV搬送", g("agv_utilization")))
    if int(g("n_put_wall", 0)):
        stage_rows.append(("種まき仕分け", g("sort_utilization")))
    stages_chart = {
        "labels": [r[0] for r in stage_rows],
        "values": [round(r[1] * 100, 1) for r in stage_rows],
        "peak_label": bottleneck_jp,
    }

    # (b) cost breakdown (bar) per order: labour vs equipment.
    labour_po = g("labour_cost_per_order")
    equip_po = g("equipment_cost_per_order")
    cost_chart = None
    if labour_po or equip_po:
        cost_chart = {
            "labels": ["人件費", "設備費"],
            "values": [round(labour_po, 2), round(equip_po, 2)],
            "currency": cur,
        }

    # (c) 生産性の内訳 (要素作業分解): picker presence = 移動 + 手扱い + 手待ち.
    # Only present for runs whose kpis carry the breakdown (older runs degrade).
    walk_s, handle_s, idle_s = g("picker_walk_s"), g("picker_handle_s"), g("picker_idle_s")
    prod_total = walk_s + handle_s + idle_s
    prod_chart = None
    if prod_total > 0:
        prod_chart = {
            "per_hr": round(g("orders_per_picker_hr"), 1),   # 件/人時
            "parts": [
                {"key": "walk", "label": "移動", "share": round(walk_s / prod_total, 3)},
                {"key": "handle", "label": "手扱い", "share": round(handle_s / prod_total, 3)},
                {"key": "idle", "label": "手待ち", "share": round(idle_s / prod_total, 3)},
            ],
        }

    return {
        "name": model.meta.name,
        "source": source,
        "verdict": metrics.get("verdict"),
        "insights": insights,
        "kpis": {"hero": hero[:4], "groups": groups},
        "charts": {"stages": stages_chart, "cost": cost_chart,
                   "productivity": prod_chart},
    }
