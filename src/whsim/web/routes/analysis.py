"""Analysis & BI endpoints: the project analysis dashboard, the standalone
WMS-data analysis suite (sample / upload), the DuckDB-backed 物量/分析 BI views,
and the timetable derivation read back from the saved BI 仮値."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, UploadFile

from whsim import analytic

from ._common import Source, _analysis_payload, _open

router = APIRouter()


@router.get("/api/projects/{name}/bi/volumes")
def api_bi_volumes(name: str, nonworking: str | None = None):
    """物量BI: base volumes aggregated in DuckDB. Pallet/case derivations are done
    client-side from provisional 仮値 (so sliders feel instant). ``nonworking`` is a
    comma list of weekday indices (0=月) to drop from the working calendar (非稼働日)."""
    from whsim import bi
    nw = {int(x) for x in (nonworking or "").split(",") if x.strip().isdigit()}
    return bi.base_volumes(_open(name).load_model(), nw)


@router.get("/api/projects/{name}/bi/analysis")
def api_bi_analysis(name: str):
    """分析ビュー: ABC・曜日別物量・(あれば)日次/時間別の時系列を DuckDB で集計。
    データが無ければ各セクション空で返す（落ちない）。"""
    from whsim import bi
    return bi.analysis_views(_open(name).load_model())


@router.post("/api/projects/{name}/bi/apply")
def api_bi_apply(name: str, payload: dict | None = None):
    """仮値→派生物量をプロジェクト(bi.json)に保存し、orders サブツリーの
    provenance を GENERATED にマーク。本文: {cases_per_pallet, pallet_prod,
    lines_per_order?, peak_factor?}。"""
    from whsim import bi
    return bi.apply_derivation(_open(name), payload or {})


@router.get("/api/projects/{name}/timetable/from-bi")
def api_timetable_from_bi(name: str):
    """Read the BI-saved 仮値 derivation (bi.json) back into a timetable scenario,
    so the pallet-driven 格納 volume etc. feed 人員設計. {available:false} when no
    BI derivation has been applied yet."""
    from whsim import bi
    from whsim.analysis import staffing
    proj = _open(name)
    vols = staffing.volumes_from_bi(bi.load_bi_config(proj))
    if vols is None:
        return {"available": False}
    # Pass the model so the timetable productivities honour the 3-tier
    # (実測採用値 > 物流形態ベンチマーク > 既定) — adopted 実測 flows here too.
    return {"available": True, "volumes": vols,
            "scenario": staffing.scenario_from_volumes(vols, proj.load_model())}


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
    # バッチ投入スケジュール: explicit payload wins; else the persisted schedule. When
    # the payload carries one we persist it so the plan survives a reload. A payload
    # key present-but-empty ({}) intentionally clears the schedule.
    batches = p.get("batches")
    dirty = False
    if not isinstance(batches, dict):
        batches = getattr(model.settings, "batch_schedule", {}) or {}
    elif batches != (getattr(model.settings, "batch_schedule", {}) or {}):
        model.settings.batch_schedule = batches
        dirty = True
    # シフト・休憩モデル: same persistence pattern as the batch schedule — explicit
    # payload wins and is saved so the plan survives a reload; an explicit {} clears.
    shift_plan = p.get("shift_plan")
    if not isinstance(shift_plan, dict):
        shift_plan = getattr(model.settings, "shift_plan", {}) or {}
    elif shift_plan != (getattr(model.settings, "shift_plan", {}) or {}):
        model.settings.shift_plan = shift_plan
        dirty = True
    if dirty:
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
        "drivers": [
            {"id": "in_lines", "label": "入荷行数", "unit": "行/h"},
            {"id": "in_qty", "label": "入荷点数", "unit": "点/h"},
            {"id": "out_lines", "label": "出荷行数", "unit": "行/h"},
            {"id": "out_orders", "label": "出荷オーダー数", "unit": "件/h"},
        ],
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
    known_drivers = {"in_lines", "in_qty", "out_lines", "out_orders"}
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


@router.get("/api/analysis/sample")
def api_analysis_sample():
    """Run the full data-analysis suite on the bundled demo WMS dataset.

    Powers the データ分析 tab's「サンプルで試す」: no upload needed, returns the
    whole bundle (KPIs, insights, trend, ABC, peak, turnover, forecast, …)."""
    from whsim.analysis.report import sample_bundle
    return sample_bundle()


@router.post("/api/analysis/upload")
async def api_analysis_upload(shipments: UploadFile, inbound: UploadFile | None = None,
                              inventory: UploadFile | None = None):
    """Analyse uploaded WMS files (出荷 required; 入荷/在庫 optional).

    Columns are auto-mapped heuristically (data_io.initial_mapping); the standard
    suite then runs and returns the same bundle shape as /api/analysis/sample."""
    import pandas as pd

    from whsim.analysis import report
    from whsim.analysis.data_io import (
        INBOUND_FIELDS,
        INVENTORY_FIELDS,
        SHIPMENT_FIELDS,
        apply_mapping,
        initial_mapping,
        load_table,
    )

    async def load(uf, fields):
        if uf is None:
            return pd.DataFrame()
        raw = await uf.read()
        try:
            df = load_table(raw, uf.filename)
        except Exception as e:  # noqa: BLE001 — surface a friendly 400
            raise HTTPException(400, f"読込に失敗しました（{uf.filename}）: {e}") from e
        return apply_mapping(df, initial_mapping(df, fields), fields)

    ship = await load(shipments, SHIPMENT_FIELDS)
    if ship.empty:
        raise HTTPException(400, "出荷データを読み込めませんでした。列名をご確認ください。")
    inb = await load(inbound, INBOUND_FIELDS)
    inv = await load(inventory, INVENTORY_FIELDS)
    bundle = report.run_all(ship, inb, inv)
    bundle["source"] = "upload"
    return bundle


@router.post("/api/projects/{name}/import/shipments")
async def api_import_shipments(name: str, shipments: UploadFile,
                               items: UploadFile | None = None,
                               mapping: str | None = None):
    """ETL: read a shipments file (CSV/Excel/JSON), auto-map its columns, and
    ingest it as the project's outbound orders so the BI views AND the SimPy run
    use the customer's REAL demand. An OPTIONAL 商品マスタ file enriches SKUs with
    入数(case_qty)/名前/ABC so the 荷姿・保管設備 chain is accurate. ``mapping`` (JSON,
    field-key→column) overrides the auto-detected column mapping — the 取込プレビュー
    modal sends the user-confirmed/corrected mapping here. Returns a summary
    {orders, lines, skus, enriched, …} plus the resolved column `mapping`.

    Honours 'never blocks': unreadable files 400 with a friendly message; a file
    with no usable rows returns ok:false (the model is left untouched)."""
    import json as _json

    import pandas as pd  # noqa: F401  (load_table needs pandas importable)

    from whsim.analysis import ingest
    from whsim.analysis.data_io import (
        ITEM_FIELDS,
        SHIPMENT_FIELDS,
        apply_mapping,
        initial_mapping,
        load_table,
    )

    raw = await shipments.read()
    try:
        df = load_table(raw, shipments.filename)
    except Exception as e:  # noqa: BLE001 — surface a friendly 400
        raise HTTPException(400, f"読込に失敗しました（{shipments.filename}）: {e}") from e
    ship_map = _json.loads(mapping) if mapping else initial_mapping(df, SHIPMENT_FIELDS)
    mapped = apply_mapping(df, ship_map, SHIPMENT_FIELDS)

    items_df = None
    item_map = None
    if items is not None:
        iraw = await items.read()
        try:
            idf = load_table(iraw, items.filename)
            item_map = initial_mapping(idf, ITEM_FIELDS)
            items_df = apply_mapping(idf, item_map, ITEM_FIELDS)
        except Exception:  # noqa: BLE001 — master is optional; never fail the import
            items_df = None

    proj = _open(name)
    result = ingest.ingest_shipments(proj, mapped, items_df)
    # Surface the resolved column mapping (label → matched source column) so the
    # client can confirm/trust the auto-紐付け. None means "not found".
    src_by_key = {f.key: f.label for f in SHIPMENT_FIELDS}
    result["mapping"] = [{"field": src_by_key[k], "column": v}
                         for k, v in ship_map.items() if k in src_by_key]
    if item_map is not None:
        ilabel = {f.key: f.label for f in ITEM_FIELDS}
        result["item_mapping"] = [{"field": ilabel[k], "column": v}
                                  for k, v in item_map.items() if k in ilabel]
    if result.get("ok"):
        # Persist the mapped table + its 紐付け/クレンジング so ②分析「物量サマリ」
        # can re-analyse the project's own data without a re-upload.
        from whsim.analysis import tablestore
        tablestore.save_table(proj, "shipments", mapped, {
            "filename": shipments.filename,
            "mapping": result.get("mapping"),
            "item_mapping": result.get("item_mapping"),
            "cleansing": (result.get("summary") or {}).get("cleansing"),
        })
    return result


@router.get("/api/projects/{name}/analysis/bundle")
def api_project_analysis_bundle(name: str):
    """②分析「物量サマリ」 on the PROJECT's own imported data — no re-upload.

    Prefers the persisted import tables (``analysis/<key>.csv``, exact columns
    the user shipped); falls back to reconstructing a shipments frame from
    ``model.orders.outbound`` for projects ingested before tables were saved.
    Returns ``{"available": false}`` when the project has no demand data yet
    (the UI then points at ①取込) — never an error."""
    import pandas as pd  # noqa: F401 — report/ingest need pandas importable

    from whsim.analysis import ingest, report, tablestore
    proj = _open(name)
    ship = tablestore.load_saved_table(proj, "shipments")
    src = "project"
    if ship is None:
        model = proj.load_model()
        ship = ingest.orders_to_frame(model.orders.outbound)
        src = "project(model)"
        if ship.empty:
            return {"available": False}
    inb = tablestore.load_saved_table(proj, "inbound")
    inv = tablestore.load_saved_table(proj, "inventory")
    bundle = report.run_all(ship, inb, inv)
    bundle["available"] = True
    bundle["source"] = src
    bundle["meta"] = tablestore.load_meta(proj)
    # Honesty flag: template orders are PROVISIONAL — the UI must label the
    # dashboard 仮データ rather than claim it shows imported 実データ.
    try:
        v = proj.load_provenance().subtrees.get("orders")
        bundle["orders_imported"] = getattr(v, "value", v) in ("imported", "interview")
    except Exception:  # noqa: BLE001 — labelling only, never blocks the bundle
        bundle["orders_imported"] = False
    return bundle


@router.get("/api/projects/{name}/inventory-opt")
def api_inventory_opt(name: str, lead_time: float = 3.0, review: float = 0.0,
                      service_level: float = 0.95):
    """在庫最適化: SKU 別の 安全在庫・発注点 を出荷実績から解析的に試算する。

    ①取込で永続化した出荷テーブル (analysis/shipments.csv) を優先し、無ければ
    model.orders から復元 (物量サマリと同じ二段構え)。パラメータは query のみ
    (lead_time=LT日 / review=発注間隔R日〔0=発注点方式〕 / service_level=サービス率)
    で、スキーマには保存しない。需要データがまだ無ければ {available:false} を返す
    ── never-blocks。σ は観測期間の需要ゼロ日も含めて実測から直接求める。"""
    import pandas as pd  # noqa: F401 — inventoryopt / ingest need pandas importable

    from whsim.analysis import ingest, inventoryopt, tablestore
    proj = _open(name)
    ship = tablestore.load_saved_table(proj, "shipments")
    if ship is None:
        ship = ingest.orders_to_frame(proj.load_model().orders.outbound)
    if ship is None or ship.empty:
        return {"available": False,
                "message": "出荷データがまだありません。①取込で出荷実績を取り込んでください。"}
    return inventoryopt.analyze(ship, lead_time_days=lead_time, review_days=review,
                                service_level=service_level)


@router.get("/api/projects/{name}/storage")
def api_storage(name: str, stock_days: float | None = None, tsubo_rate: float | None = None,
                aisle_factor: float | None = None, bulk_cases: int | None = None,
                office_tsubo: float | None = None, bulk_rack_type: str | None = None,
                working_hours_per_day: float | None = None,
                crane_vx: float | None = None, crane_vy: float | None = None,
                crane_tfix: float | None = None, asrs_command: str | None = None):
    """保管設備の試算: 物量→必要保管機器(間口/台数/坪)→保管費。Query params override
    the 試算 defaults (在庫日数・坪単価・通路率・bulk閾値・事務所坪)。bulk_rack_type=asrs
    で bulk C品を自動倉庫に寄せ、クレーン諸元(vx/vy/tfix)から FEM 9.851 クレーン台数を算出。"""
    from whsim import storage
    params = {"stock_days": stock_days, "tsubo_rate": tsubo_rate,
              "aisle_factor": aisle_factor, "bulk_cases": bulk_cases,
              "office_tsubo": office_tsubo, "bulk_rack_type": bulk_rack_type,
              "working_hours_per_day": working_hours_per_day,
              "crane_vx": crane_vx, "crane_vy": crane_vy, "crane_tfix": crane_tfix,
              "asrs_command": asrs_command}
    return storage.estimate_storage(_open(name).load_model(), params)


@router.post("/api/projects/{name}/storage/apply-layout")
def api_storage_apply(name: str, payload: dict | None = None):
    """保管設計→レイアウト反映: size the equipment from demand (same params as
    GET /storage, via the JSON body) and author it into the largest storage zone
    as shelf runs (REPLACING that zone's shelves), re-materialise locations, and
    mark layout/locations GENERATED. Returns the placement summary."""
    from whsim import storage
    from whsim.design import materialize_racks
    from whsim.provenance import Source
    proj = _open(name)
    model = proj.load_model()
    est = storage.estimate_storage(model, payload or {})
    if not est.get("has_data"):
        return {"ok": False, "message": "配置できる保管物量がまだありません。"}
    placed = storage.place_equipment(model, est)
    materialize_racks(model)
    proj.save_model(model)
    prov = proj.load_provenance()
    prov.mark("layout", Source.GENERATED)
    prov.mark("locations", Source.GENERATED)
    proj.save_provenance(prov)
    return {"ok": True, **placed, "locations": len(model.locations),
            "provenance_summary": prov.summary(),
            "message": (f"{placed['placed']}台を{placed['shelves']}列に配置しました"
                        + (f"（{placed['unplaced']}台は入りきりません）" if placed["unplaced"] else "。"))}


@router.get("/api/projects/{name}/cost")
def api_cost(name: str, labor_cost_per_hour: float | None = None,
             fixed_labor_per_month: float | None = None,
             tsubo_rate_per_month: float | None = None,
             delivery_cost_per_cage: float | None = None,
             system_cost_per_month: float | None = None,
             overhead_rate: float | None = None,
             working_days_per_month: float | None = None,
             nonworking: str | None = None):
    """原価試算: analytic 6費目 build-up (no sim). Query params override Settings
    unit prices live (so the 原価試算 screen feels instant); persistence is via
    PUT /settings. Returns the per-category breakdown with formulas."""
    from whsim import cost
    params = {k: v for k, v in {
        "labor_cost_per_hour": labor_cost_per_hour,
        "fixed_labor_per_month": fixed_labor_per_month,
        "tsubo_rate_per_month": tsubo_rate_per_month,
        "delivery_cost_per_cage": delivery_cost_per_cage,
        "system_cost_per_month": system_cost_per_month,
        "overhead_rate": overhead_rate,
        "working_days_per_month": working_days_per_month,
    }.items() if v is not None}
    if nonworking:
        params["nonworking"] = nonworking
    return cost.estimate_cost(_open(name).load_model(), params)


@router.get("/api/projects/{name}/pickrate")
def api_pickrate(name: str, walk_speed_mps: float | None = None,
                 handle_s_per_line: float | None = None,
                 sort_s_per_line: float | None = None,
                 lines_per_order: float | None = None,
                 labour_cost_per_hour: float | None = None,
                 working_hours_per_day: float | None = None):
    """生産性試算: 解析的(動作時間)なピッキング生産性を全作業方式について算出。
    MapMaker距離(レイアウト幾何)×動作時間で、オーダー/マルチ/トータルを DES なしで
    即比較する SLC 流のステップ②。Query params override the motion-time standards."""
    from whsim import pickrate
    params = {"walk_speed_mps": walk_speed_mps, "handle_s_per_line": handle_s_per_line,
              "sort_s_per_line": sort_s_per_line, "lines_per_order": lines_per_order,
              "labour_cost_per_hour": labour_cost_per_hour,
              "working_hours_per_day": working_hours_per_day}
    return pickrate.estimate_pickrate(_open(name).load_model(), params)


@router.get("/api/benchmarks")
def api_benchmarks():
    """生産性ベンチマークライブラリ: 物流形態別の想定生産性プリセット一覧。"""
    from whsim import benchmarks
    return {"benchmarks": benchmarks.catalog()}


@router.post("/api/projects/{name}/benchmark/{bid}/apply")
def api_benchmark_apply(name: str, bid: str):
    """物流形態プリセットを適用: 想定生産性→settings.benchmark_productivity、
    坪単価等の計画値→settings。荷姿の計画値は応答で返し、クライアントが基礎物量に
    seed する。原価/タイムチャート/想定vs実測の"想定"がこのベンチマークに切替わる。"""
    from whsim import benchmarks
    from whsim.provenance import Source
    proj = _open(name)
    model = proj.load_model()
    res = benchmarks.apply(model, bid)
    if not res.get("ok"):
        return res
    proj.save_model(model)
    prov = proj.load_provenance()
    prov.mark("settings", Source.INTERVIEW)
    proj.save_provenance(prov)
    return res


@router.get("/api/projects/{name}/analysis")
def api_analysis(name: str):
    """Analysis-dashboard payload (the "分析" tab).

    Consolidates an analysis-tool-style summary INTO whsim: it reshapes the
    project's KPIs into insights ("指摘 -> 提案"), a hero/grouped KPI hierarchy,
    and a couple of small chart series. Honours whsim's "never blocks" invariant:
    if no SimPy run exists yet it falls back to the closed-form analytic estimate
    so the view always has something to show.
    """
    proj = _open(name)
    model = proj.load_model()
    rd = proj.latest_run_dir()
    source = "run"
    if rd is not None and (rd / "kpis.json").is_file():
        metrics = json.loads((rd / "kpis.json").read_text("utf-8"))
    else:
        # No heavyweight run yet: instant analytic estimate keeps the view alive.
        metrics = analytic.estimate(model)
        source = "estimate"
    return _analysis_payload(model, metrics, source)


@router.get("/api/projects/{name}/slotting")
def api_slotting(name: str, affinity_weight: float = 0.0, include_seasonality: int = 0):
    """棚割り: current weighted pick-distance, the optimisation preview (BEFORE vs
    AFTER + top SKU moves), and the storage-strategy recommendation — all analytic
    (no sim, no mutation). 'never blocks': a bare model returns placed=0 / strategy
    available=false rather than an error.

    Additive knobs: ``affinity_weight`` (0–1) blends a 併買 co-pick pull into the
    greedy (0 = the legacy result, byte-identical); ``include_seasonality=1`` adds a
    月次 ABC-drift 入替候補リスト from the saved shipments table (recommendation only)."""
    from whsim import slottingopt, storagestrategy
    proj = _open(name)
    model = proj.load_model()
    aff = min(1.0, max(0.0, float(affinity_weight)))
    base = slottingopt.optimize(model, affinity_weight=0.0)
    plan = base if aff <= 0.0 else slottingopt.optimize(model, affinity_weight=aff)
    out = {
        "optimization": slottingopt.plan_summary(plan),
        "strategy": storagestrategy.recommend(model),
        "affinity": slottingopt.affinity_report(model, aff, baseline=base, plan=plan),
    }
    if include_seasonality:
        out["seasonality"] = _seasonality_block(proj)
    return out


def _seasonality_block(proj) -> dict:
    """季節性: read the saved shipments table and hand (month, sku, qty) rows to the
    analytic seasonality solver. Tolerant — a missing table / dateless data returns
    the ``available=false`` shape rather than raising (never blocks)."""
    from whsim import slottingopt
    from whsim.analysis import tablestore
    df = tablestore.load_saved_table(proj, "shipments")
    if df is None or "date" not in df.columns or "sku" not in df.columns:
        return {"available": False, "months_observed": 0, "rows": [],
                "message": "月次の入替候補には、日付つき出荷データの取込が必要です。"}
    try:
        import pandas as pd
        d = df.dropna(subset=["date"]).copy()
        d["month"] = pd.to_datetime(d["date"], errors="coerce").dt.strftime("%Y-%m")
        d = d.dropna(subset=["month"])
        qty = d["qty"] if "qty" in d.columns else 1
        records = list(zip(d["month"], d["sku"].astype(str),
                           qty if "qty" in d.columns else [1] * len(d)))
    except Exception:  # noqa: BLE001 — a malformed table must not block the view
        return {"available": False, "months_observed": 0, "rows": [],
                "message": "出荷データの日付を解釈できませんでした。"}
    return slottingopt.seasonality(records)


@router.post("/api/projects/{name}/slotting/apply")
def api_slotting_apply(name: str, payload: dict | None = None):
    """棚割りを最適化して適用: write the optimised pegging onto item.default_location
    / loc.sku (NEVER the schema), persist, and mark locations as INTERVIEW-sourced.
    Returns the same summary as GET plus the placed count."""
    from whsim import slottingopt
    proj = _open(name)
    model = proj.load_model()
    aff = min(1.0, max(0.0, float((payload or {}).get("affinity_weight", 0.0) or 0.0)))
    plan = slottingopt.optimize(model, affinity_weight=aff)
    placed = slottingopt.apply_plan(model, plan)
    proj.save_model(model)
    prov = proj.load_provenance()
    prov.mark("locations", Source.INTERVIEW)
    proj.save_provenance(prov)
    summary = slottingopt.plan_summary(plan)
    summary["applied"] = placed
    summary["message"] = (
        f"{placed}SKUを最適スロットに割付。加重歩行距離を"
        f"{round(plan.reduction_pct * 100)}%短縮しました。"
        if plan.reduction > 0 else f"{placed}SKUを割付しました。"
    )
    return summary


@router.get("/api/projects/{name}/storage-strategy")
def api_storage_strategy(name: str, active_days: float | None = None):
    """保管戦略: フリーロケ vs 固定ロケ(リザーブ＋アクティブ) を velocity/cube/turnover
    から per-SKU + 全体で推奨。補充回数/日と 歩行短縮 vs 補充工数 のトレードオフ付き。"""
    from whsim import storagestrategy
    params = {"active_days": active_days} if active_days is not None else {}
    return storagestrategy.recommend(_open(name).load_model(), params)


@router.get("/api/projects/{name}/scorecard")
def api_scorecard(name: str):
    """採点表レール: the design's dependent variables (判定/人員/原価/生産性/坪数/
    連鎖) recomputed analytically (no DES, 爆速) on every edit. Composes the
    existing pure estimators into the fixed 6-row payload the right-dock rail
    renders, plus a `run` block (the last DES run's headline numbers) for its
    解析値 vs 実測 delta. Honours 'never blocks': a bare model returns 200 with
    all 6 rows (value="—" where there is no data); no run → run.exists=false."""
    from whsim import scorecard
    proj = _open(name)
    model = proj.load_model()
    run_metrics = None
    rd = proj.latest_run_dir()
    if rd is not None and (rd / "kpis.json").is_file():
        try:
            run_metrics = json.loads((rd / "kpis.json").read_text("utf-8"))
        except Exception:  # noqa: BLE001 — a corrupt run never wedges the rail
            run_metrics = None
    return scorecard.build_scorecard(model, run_metrics)


@router.get("/api/projects/{name}/scenarios")
def api_scenarios_list(name: str):
    """採点表レール Stage2: 保存済みシナリオ（名前つき設計スナップショット＋採点表）
    の一覧。各シナリオは保存時の scorecard を含むので、レールは現在値との
    デルタを round-trip なしで描ける。Tolerant: 壊れた1件は飛ばす。"""
    from whsim import scenariostore
    return {"scenarios": scenariostore.list_scenarios(_open(name))}


@router.post("/api/projects/{name}/scenarios")
def api_scenarios_save(name: str, payload: dict | None = None):
    """現在の設計（or 編集中セクション）を名前つきシナリオとして凍結保存。
    本文: {label, sections?}。sections があれば未保存の編集案をそのまま凍結する
    （ライブ採点と同じ overlay）。保存したシナリオのヘッダ（採点表込み）を返す。"""
    from whsim import scenariostore
    p = payload or {}
    label = str(p.get("label") or "").strip() or "シナリオ"
    return scenariostore.save_scenario(_open(name), label, p.get("sections"))


@router.delete("/api/projects/{name}/scenarios/{sid}")
def api_scenarios_delete(name: str, sid: str):
    from whsim import scenariostore
    return {"ok": scenariostore.delete_scenario(_open(name), sid)}


@router.post("/api/projects/{name}/scorecard")
def api_scorecard_live(name: str, payload: dict | None = None):
    """採点表レール (LIVE): same as GET, but score an *unsaved* in-memory model.

    The designer emits `whsim:design-dirty` with its current edit sections
    ({layout, resources, process, routes, settings}); the rail POSTs them here so
    the dependent variables move WHILE you drag a shelf — no save round-trip. The
    body sections are overlaid onto the saved model dict, re-validated, and scored.
    Tolerant: a missing/invalid section falls back to the saved model so the rail
    never wedges ('never blocks'). The run block still comes from the last DES run.
    """
    from whsim import scorecard
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    md = proj.load_model().model_dump()
    for key in ("layout", "resources", "process", "routes", "settings"):
        val = (payload or {}).get(key)
        if val is not None:
            md[key] = val
    try:
        model = WarehouseModel.model_validate(md)
    except Exception:  # noqa: BLE001 — bad edit sections → score the saved model
        model = proj.load_model()
    run_metrics = None
    rd = proj.latest_run_dir()
    if rd is not None and (rd / "kpis.json").is_file():
        try:
            run_metrics = json.loads((rd / "kpis.json").read_text("utf-8"))
        except Exception:  # noqa: BLE001 — a corrupt run never wedges the rail
            run_metrics = None
    return scorecard.build_scorecard(model, run_metrics)
