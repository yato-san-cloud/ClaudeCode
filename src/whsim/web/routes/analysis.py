"""Analysis & BI endpoints: the project analysis dashboard, the standalone
WMS-data analysis suite (sample / upload), the DuckDB-backed 物量/分析 BI views,
and the timetable derivation read back from the saved BI 仮値."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, UploadFile

from whsim import analytic

from ._common import _analysis_payload, _open

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
                               items: UploadFile | None = None):
    """ETL: read a shipments file (CSV/Excel/JSON), auto-map its columns, and
    ingest it as the project's outbound orders so the BI views AND the SimPy run
    use the customer's REAL demand. An OPTIONAL 商品マスタ file enriches SKUs with
    入数(case_qty)/名前/ABC so the 荷姿・保管設備 chain is accurate. Returns a
    summary {orders, lines, skus, enriched, …} plus the resolved column `mapping`
    (so the UI can show 何をどう取り込んだか — the 物量分析ツール「項目の紐付け確認」).

    Honours 'never blocks': unreadable files 400 with a friendly message; a file
    with no usable rows returns ok:false (the model is left untouched)."""
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
    ship_map = initial_mapping(df, SHIPMENT_FIELDS)
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

    result = ingest.ingest_shipments(_open(name), mapped, items_df)
    # Surface the resolved column mapping (label → matched source column) so the
    # client can confirm/trust the auto-紐付け. None means "not found".
    src_by_key = {f.key: f.label for f in SHIPMENT_FIELDS}
    result["mapping"] = [{"field": src_by_key[k], "column": v}
                         for k, v in ship_map.items() if k in src_by_key]
    if item_map is not None:
        ilabel = {f.key: f.label for f in ITEM_FIELDS}
        result["item_mapping"] = [{"field": ilabel[k], "column": v}
                                  for k, v in item_map.items() if k in ilabel]
    return result


@router.get("/api/projects/{name}/storage")
def api_storage(name: str, stock_days: float | None = None, tsubo_rate: float | None = None,
                aisle_factor: float | None = None, bulk_cases: int | None = None,
                office_tsubo: float | None = None):
    """保管設備の試算: 物量→必要保管機器(間口/台数/坪)→保管費。Query params override
    the 試算 defaults (在庫日数・坪単価・通路率・bulk閾値・事務所坪)."""
    from whsim import storage
    params = {"stock_days": stock_days, "tsubo_rate": tsubo_rate,
              "aisle_factor": aisle_factor, "bulk_cases": bulk_cases,
              "office_tsubo": office_tsubo}
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
