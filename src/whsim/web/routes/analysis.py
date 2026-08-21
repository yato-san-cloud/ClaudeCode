"""Analysis & BI endpoints: the project analysis dashboard, the standalone
WMS-data analysis suite (sample / upload / shipments ETL / project bundle), the
DuckDB-backed 物量/分析 BI views, and the timetable derivation read back from the
saved BI 仮値.

The 人員/timetable solver, 在庫・棚割り, ③設計 試算 (storage/cost/pickrate/benchmark)
and the 採点表/シナリオ rail live in their own concern-grouped route modules
(``staffing`` / ``inventory`` / ``design`` / ``scorecard``); this module is the
分析/BI slice."""

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
