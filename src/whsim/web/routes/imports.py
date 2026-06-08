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


_TABLE_FIELDS = {"shipments": "SHIPMENT_FIELDS", "inbound": "INBOUND_FIELDS",
                 "master": "INVENTORY_FIELDS"}


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
    if kind == "master":
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
    return {
        "kind": kind, "counts": counts, "columns": list(df.columns),
        "mapping": {f.key: {"label": f.label, "required": f.required,
                            "column": mp.get(f.key)} for f in fields},
        "provenance_summary": prov.summary(),
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
