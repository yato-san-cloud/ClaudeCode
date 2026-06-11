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
def api_bi_volumes(name: str):
    """物量BI: base volumes aggregated in DuckDB. Pallet/case derivations are done
    client-side from provisional 仮値 (so sliders feel instant)."""
    from whsim import bi
    return bi.base_volumes(_open(name).load_model())


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
    vols = staffing.volumes_from_bi(bi.load_bi_config(_open(name)))
    if vols is None:
        return {"available": False}
    return {"available": True, "volumes": vols,
            "scenario": staffing.scenario_from_volumes(vols)}


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
async def api_import_shipments(name: str, shipments: UploadFile):
    """ETL: read a shipments file (CSV/Excel/JSON), auto-map its columns, and
    ingest it as the project's outbound orders so the BI views AND the SimPy run
    use the customer's REAL demand. Returns a summary {orders, lines, skus, …}.

    Honours 'never blocks': unreadable files 400 with a friendly message; a file
    with no usable rows returns ok:false (the model is left untouched)."""
    import pandas as pd  # noqa: F401  (load_table needs pandas importable)

    from whsim.analysis import ingest
    from whsim.analysis.data_io import (
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
    mapped = apply_mapping(df, initial_mapping(df, SHIPMENT_FIELDS), SHIPMENT_FIELDS)
    return ingest.ingest_shipments(_open(name), mapped)


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
