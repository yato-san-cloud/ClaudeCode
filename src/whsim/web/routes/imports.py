"""Tolerant data-import endpoints: customer ZIP, DXF/CAD, MapMaker (Map CSV /
.rmpm.json), measured distance matrices, unified tabular import, and the
"generate missing data" derivation. Every importer degrades to a friendly 400,
never a 500 (honours whsim's "never blocks" / tolerant-import invariants)."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, UploadFile

from ._common import Source, _open, _read_upload

router = APIRouter()


@router.post("/api/projects/{name}/import")
async def api_import(name: str, file: UploadFile):
    import tempfile
    from pathlib import Path
    proj = _open(name)
    # Write to a temp file; Project.import_zip copies it into the project's raw/.
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tf:
        tf.write(await _read_upload(file))
        tmp = Path(tf.name)
    try:
        res = proj.import_zip(tmp)
    finally:
        tmp.unlink(missing_ok=True)
    return {
        "files": res.files_seen,
        "updated": sorted(res.touched_subtrees),
        "warnings": res.warnings,
        "provenance_summary": proj.load_provenance().summary(),
    }


@router.post("/api/projects/{name}/import-cad")
async def api_import_cad(name: str, file: UploadFile):
    """Import a DXF floor plan -> merge its bounds/walls/zones into the layout."""
    from whsim import cad
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    data = await _read_upload(file)
    try:
        res = cad.import_dxf_bytes(data)
    except Exception as e:  # noqa: BLE001 — tolerant: never 500 on a bad drawing
        raise HTTPException(400, f"DXF を解析できませんでした: {e}")
    md = json.loads(proj.model_file.read_text("utf-8"))
    if res.get("bounds"):
        md["layout"]["bounds"] = res["bounds"]
    if res.get("walls"):
        md["layout"]["walls"] = res["walls"]
    if res.get("zones"):
        md["layout"]["zones"] = res["zones"]
    model = WarehouseModel.model_validate(md)
    proj.save_model(model)
    prov = proj.load_provenance()
    prov.mark("layout", Source.IMPORTED)
    proj.save_provenance(prov)
    return {"bounds": res.get("bounds"), "walls": len(res.get("walls", [])),
            "zones": len(res.get("zones", [])), "warnings": res.get("warnings", []),
            "stats": res.get("stats", {})}


@router.post("/api/projects/{name}/import-mapcsv")
async def api_import_mapcsv(name: str, file: UploadFile):
    """Import a MapMaker (Hitachi WorldMap) Map CSV -> shelves/walls/stations.

    SHELF areas become a storage zone's authored `shelves`; locations then
    materialise inside the drawn shelves (MapMaker SHELF → cells)."""
    from whsim import design, mapcsv
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    data = await _read_upload(file)
    try:
        res = mapcsv.import_mapcsv_bytes(data)
    except Exception as e:  # noqa: BLE001 — tolerant: never 500 on a bad map
        raise HTTPException(400, f"Map CSV を解析できませんでした: {e}")
    md = json.loads(proj.model_file.read_text("utf-8"))
    if res.get("bounds"):
        md["layout"]["bounds"] = res["bounds"]
    if res.get("walls"):
        md["layout"]["walls"] = res["walls"]
    if res.get("zones"):
        md["layout"]["zones"] = res["zones"]
    if res.get("stations"):
        md.setdefault("resources", {})["stations"] = res["stations"]
    model = WarehouseModel.model_validate(md)
    design.materialize_racks(model)   # authored shelves -> location cells
    design.synthesize_items(model)    # ensure demand so the sim stays runnable
    proj.save_model(model)
    prov = proj.load_provenance()
    prov.mark("layout", Source.IMPORTED)
    proj.save_provenance(prov)
    return {"bounds": res.get("bounds"),
            "shelves": res.get("stats", {}).get("shelves", 0),
            "walls": len(res.get("walls", [])), "zones": len(res.get("zones", [])),
            "stations": len(res.get("stations", [])),
            "locations": len(model.locations),
            "warnings": res.get("warnings", []), "stats": res.get("stats", {})}


@router.post("/api/projects/{name}/import-rmpm")
async def api_import_rmpm(name: str, file: UploadFile):
    """Import a MapMaker native ``.rmpm.json`` export -> named shelves/walls/stations.

    FreeShelfObjects keep their MapMaker name, which seeds the materialised
    location names so loaded stock data can later slot by shelf name."""
    from whsim import design, rmpm
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    data = await _read_upload(file)
    try:
        res = rmpm.import_rmpm_bytes(data)
    except Exception as e:  # noqa: BLE001 — tolerant: never 500 on a bad export
        raise HTTPException(400, f"rmpm を解析できませんでした: {e}")
    md = json.loads(proj.model_file.read_text("utf-8"))
    if res.get("bounds"):
        md["layout"]["bounds"] = res["bounds"]
    if res.get("walls"):
        md["layout"]["walls"] = res["walls"]
    if res.get("zones"):
        md["layout"]["zones"] = res["zones"]
    if res.get("stations"):
        md.setdefault("resources", {})["stations"] = res["stations"]
    model = WarehouseModel.model_validate(md)
    design.materialize_racks(model)   # named shelves -> named location cells
    design.synthesize_items(model)    # ensure demand so the sim stays runnable
    proj.save_model(model)
    prov = proj.load_provenance()
    prov.mark("layout", Source.IMPORTED)
    proj.save_provenance(prov)
    return {"bounds": res.get("bounds"),
            "shelves": res.get("stats", {}).get("shelves", 0),
            "walls": len(res.get("walls", [])), "zones": len(res.get("zones", [])),
            "stations": len(res.get("stations", [])),
            "locations": len(model.locations),
            "warnings": res.get("warnings", []), "stats": res.get("stats", {})}


# 在庫(master) maps the inventory schema; 商品マスタ(items) maps the item-master
# schema (SKU/商品名/入数(CS入数)/ABC) — the only source of 入数, which the 荷姿・
# 保管設備 chain needs. Both build model.items, but from different key fields.
_TABLE_FIELDS = {"shipments": "SHIPMENT_FIELDS", "inbound": "INBOUND_FIELDS",
                 "master": "INVENTORY_FIELDS", "items": "ITEM_FIELDS"}


@router.post("/api/projects/{name}/import-table")
async def api_import_table(name: str, file: UploadFile, kind: str = "shipments",
                           mapping: str | None = None):
    """Unified 入荷/出荷/商品マスタ import with column mapping.

    Loads a CSV/Excel, maps columns to whsim field keys (auto-detected, or the
    caller's `mapping` JSON), and builds model subtrees: 出荷→outbound orders,
    商品マスタ→items, 入荷→(counts; feeds 物量/analysis). Returns the *used* mapping +
    the file's columns so the UI can show/correct it. Tolerant: never 500."""
    import json as _json

    from whsim import design, tabular
    from whsim.analysis import data_io
    proj = _open(name)
    data = await _read_upload(file)
    fields = getattr(data_io, _TABLE_FIELDS.get(kind, "SHIPMENT_FIELDS"))
    try:
        df = data_io.load_table(data, file.filename)
    except Exception as e:  # noqa: BLE001 — tolerant
        raise HTTPException(400, f"表を読み込めませんでした: {e}")
    mp = _json.loads(mapping) if mapping else data_io.initial_mapping(df, fields)
    std = data_io.apply_mapping(df, mp, fields)

    model = proj.load_model()
    counts: dict = {}
    prov_key = "orders"
    if kind in ("master", "items"):
        items = tabular.build_items(std)
        if items:
            model.items = items
        counts["items"] = len(items)
        prov_key = "items"
    elif kind == "inbound":
        counts["inbound_lines"] = int(len(std))
    else:  # shipments
        orders = tabular.build_orders(std, model.simulation.duration_s or 3600.0)
        if orders:
            model.orders.outbound = orders
        counts["orders"] = len(orders)
        counts["lines"] = int(len(std))
    design.materialize_racks(model)   # re-peg onto storage slots
    proj.save_model(model)
    prov = proj.load_provenance()
    if counts.get("orders") or counts.get("items"):
        prov.mark(prov_key, Source.IMPORTED)
    proj.save_provenance(prov)
    # Persist the mapped table so ②分析「物量サマリ」 can rebuild its bundle from
    # the project itself (kind=master is the 在庫 table → "inventory").
    from whsim.analysis import tablestore
    store_key = {"shipments": "shipments", "inbound": "inbound",
                 "master": "inventory"}.get(kind)
    if store_key:
        tablestore.save_table(proj, store_key, std, {
            "filename": file.filename,
            "mapping": [{"field": f.label, "column": mp.get(f.key)} for f in fields],
        })
    return {
        "kind": kind, "counts": counts, "columns": list(df.columns),
        "mapping": {f.key: {"label": f.label, "required": f.required,
                            "column": mp.get(f.key)} for f in fields},
        "provenance_summary": prov.summary(),
    }


def _preview_counts(std, kind: str) -> dict:
    """Fast (no order objects) estimate of what an import WOULD produce, from the
    already-mapped frame. Vectorised pandas only — safe to call on every keystroke
    in the mapping modal."""
    import pandas as pd
    out: dict = {}
    if std is None or getattr(std, "empty", True):
        return out
    cols = set(std.columns)
    if "sku" in cols:
        sku = std["sku"].astype(str).str.strip()
        valid = sku[(sku != "") & (~sku.str.lower().isin(["nan", "none"]))]
        out["skus"] = int(valid.nunique())
    if "qty" in cols:
        out["units"] = int(pd.to_numeric(std["qty"], errors="coerce").fillna(0).clip(lower=0).sum())
    if kind in ("master", "items"):
        out["items"] = out.get("skus", 0)
    elif kind == "inbound":
        out["inbound_lines"] = int(len(std))
    else:  # shipments
        out["lines"] = int(len(std))
        out["orders"] = int(std["order_id"].astype(str).str.strip().nunique()) \
            if "order_id" in cols else int(len(std))
    return out


@router.post("/api/projects/{name}/import-preview")
async def api_import_preview(name: str, file: UploadFile, kind: str = "shipments",
                             mapping: str | None = None):
    """Read-only preview for the 取込プレビュー / 項目の紐付け modal.

    Parses the file, resolves (or applies the caller's) column mapping, and
    returns the resolved mapping + a data preview (first rows of the ORIGINAL
    columns) + the counts that WOULD result — WITHOUT writing anything to the
    project. Tolerant: a bad file is a friendly 400, never a 500."""
    import json as _json

    import pandas as pd
    from fastapi.concurrency import run_in_threadpool

    from whsim.analysis import data_io
    _open(name)  # validate the project exists (404 if not)
    data = await _read_upload(file)
    fields = getattr(data_io, _TABLE_FIELDS.get(kind, "SHIPMENT_FIELDS"))
    # PREVIEW: read only the top rows (like a BI tool) — the dock just needs the
    # header + a sample to map columns, NOT the whole month of data. Parse off the
    # event loop so a big file can't stall the server.
    PREVIEW_ROWS = 1000
    try:
        df = await run_in_threadpool(
            data_io.load_table, data, file.filename, None, PREVIEW_ROWS)
    except Exception as e:  # noqa: BLE001 — tolerant
        raise HTTPException(400, f"表を読み込めませんでした: {e}")
    mp = _json.loads(mapping) if mapping else data_io.initial_mapping(df, fields)
    std = data_io.apply_mapping(df, mp, fields)
    head = df.head(20)
    rows = [["" if pd.isna(v) else str(v) for v in row]
            for row in head.itertuples(index=False)]
    sampled = len(df) >= PREVIEW_ROWS  # the file likely has more rows than we read
    return {
        "kind": kind,
        "filename": file.filename,
        "columns": [str(c) for c in df.columns],
        "mapping": {f.key: {"label": f.label, "required": f.required,
                            "column": mp.get(f.key)} for f in fields},
        # counts are over the previewed sample only (件数 is a guide for mapping;
        # the real totals are computed on commit, which reads the whole file).
        "counts": _preview_counts(std, kind),
        "sampled": sampled,
        "preview": {"columns": [str(c) for c in df.columns], "rows": rows,
                    "preview_rows": int(len(df)), "sampled": sampled},
    }


@router.post("/api/projects/{name}/import-distances")
async def api_import_distances(name: str, file: UploadFile):
    """Import a measured shelf-to-shelf distance matrix (CSV/JSON) to refine routing."""
    from whsim import distances
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    data = await _read_upload(file)
    try:
        res = distances.import_distance_matrix_bytes(data, file.filename or "")
    except Exception as e:  # noqa: BLE001 — tolerant
        raise HTTPException(400, f"距離データを解析できませんでした: {e}")
    md = json.loads(proj.model_file.read_text("utf-8"))
    md["distance_overrides"] = res.get("pairs", {})
    proj.save_model(WarehouseModel.model_validate(md))
    return {"count": res.get("count", 0), "ids": len(res.get("ids", [])),
            "symmetric": res.get("symmetric", False),
            "warnings": res.get("warnings", [])}


@router.post("/api/projects/{name}/generate-missing")
def api_generate_missing(name: str):
    """不足データ作成: derive missing masters (商品マスタ/ピック頻度/在庫) from the
    real demand already in the model, then re-slot. Marked GENERATED in provenance
    so the % real-data figure never overstates inferred data."""
    from whsim import datagen, design
    proj = _open(name)
    model = proj.load_model()
    summary = datagen.generate_missing(model)
    design.materialize_racks(model)   # re-peg generated items onto storage slots
    proj.save_model(model)
    prov = proj.load_provenance()
    for st in summary.get("subtrees", []):
        prov.mark(st, Source.GENERATED)
    proj.save_provenance(prov)
    return {**summary, "provenance_summary": prov.summary()}
