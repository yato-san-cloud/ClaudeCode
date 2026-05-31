"""FastAPI app: the salesperson-facing web product.

Wraps the whsim core (templates, importer, engine, KPIs, renderers) behind a
small REST API and serves the single-page frontend. The frontend lets a
salesperson pick a template, drop in a customer ZIP, confirm a few headline
numbers, run the simulation, and watch an animated 2D/3D replay -- all without
touching simulation vocabulary.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from whsim import analytic, kpis as kpi_mod, templates
from whsim.engine.run import DEFAULT_REPLAY_WINDOW_S, run_once
from whsim.project import Project
from whsim.provenance import Source
from whsim.render.png2d import render as render_png
from whsim.render.replay import build_replay

STATIC = Path(__file__).resolve().parent / "static"

app = FastAPI(title="whsim", version="0.1.0")


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


# ---- API --------------------------------------------------------------------

@app.get("/api/templates")
def api_templates():
    return templates.list_templates()


@app.get("/api/projects")
def api_projects():
    from whsim.project import PROJECTS_DIR
    if not PROJECTS_DIR.is_dir():
        return []
    return sorted(p.name for p in PROJECTS_DIR.iterdir()
                  if (p / "project.json").is_file())


@app.post("/api/projects")
def api_create(payload: dict):
    name = (payload.get("name") or "").strip()
    template = payload.get("template") or "ecommerce_small"
    if not name:
        raise HTTPException(400, "name required")
    proj = Project.create(name, template)
    return {"name": name, "template": template, "root": str(proj.root)}


@app.get("/api/projects/{name}/model")
def api_model(name: str):
    proj = _open(name)
    manifest = templates.load_manifest(proj.meta()["template_id"])
    model = proj.load_model()
    return {
        "name": name,
        "headline_fields": manifest.get("headline_fields", []),
        "headline_values": _headline_values(model.model_dump(), manifest),
        "provenance": proj.load_provenance().to_dict(),
        "provenance_summary": proj.load_provenance().summary(),
    }


@app.get("/api/projects/{name}/full")
def api_full(name: str):
    """The full model document, for the interactive design editor."""
    proj = _open(name)
    return JSONResponse(json.loads(proj.model_file.read_text("utf-8")))


@app.post("/api/projects/{name}/design")
def api_design(name: str, payload: dict):
    """Apply design edits (layout / resources / process). Re-materialises racks
    from storage zones so a layout change immediately affects routing & KPIs."""
    from whsim.design import materialize_racks
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    md = json.loads(proj.model_file.read_text("utf-8"))
    prov = proj.load_provenance()
    if payload.get("routes") is not None:
        md["routes"] = payload["routes"]  # manual flow-line studies
    for section in ("layout", "resources", "process"):
        if section in payload and payload[section] is not None:
            md[section] = payload[section]
            prov.mark(section, Source.INTERVIEW)
            if section == "layout":
                prov.mark("locations", Source.INTERVIEW)
    model = WarehouseModel.model_validate(md)
    if "layout" in payload:
        materialize_racks(model)
    proj.save_model(model)
    proj.save_provenance(prov)
    return {"ok": True, "provenance_summary": prov.summary(),
            "locations": len(model.locations)}


@app.post("/api/projects/{name}/import-cad")
async def api_import_cad(name: str, file: UploadFile):
    """Import a DXF floor plan -> merge its bounds/walls/zones into the layout."""
    from whsim import cad
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    data = await file.read()
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


@app.get("/api/projects/{name}/proposal.{fmt}")
def api_proposal(name: str, fmt: str):
    """Generate an editable PPTX or a PDF proposal from the latest run."""
    from whsim import export_doc
    if fmt not in ("pptx", "pdf"):
        raise HTTPException(404, "unknown format")
    proj = _open(name)
    rd = proj.latest_run_dir()
    if rd is None or not (rd / "kpis.json").is_file():
        raise HTTPException(404, "no run yet")
    kpis = json.loads((rd / "kpis.json").read_text("utf-8"))
    png = rd / "layout_heatmap.png"
    out = rd / f"proposal.{fmt}"
    prov = proj.load_provenance().summary()
    builder = export_doc.build_pptx if fmt == "pptx" else export_doc.build_pdf
    builder(kpis, proj.meta()["name"], prov, png if png.is_file() else None, out)
    media = ("application/vnd.openxmlformats-officedocument.presentationml.presentation"
             if fmt == "pptx" else "application/pdf")
    return FileResponse(out, media_type=media, filename=f"{name}_提案書.{fmt}")


@app.post("/api/projects/{name}/headline")
def api_headline(name: str, payload: dict):
    proj = _open(name)
    md = json.loads(proj.model_file.read_text("utf-8"))
    prov = proj.load_provenance()
    for path, value in payload.items():
        subtree = _set_by_path(md, path, value)
        prov.mark(subtree, Source.INTERVIEW)
    from whsim.schema.model import WarehouseModel
    proj.save_model(WarehouseModel.model_validate(md))
    proj.save_provenance(prov)
    return {"ok": True, "provenance_summary": prov.summary()}


@app.post("/api/projects/{name}/import")
async def api_import(name: str, file: UploadFile):
    import tempfile
    proj = _open(name)
    # Write to a temp file; Project.import_zip copies it into the project's raw/.
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tf:
        tf.write(await file.read())
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


@app.post("/api/projects/{name}/run")
def api_run(name: str):
    proj = _open(name)
    model = proj.load_model()
    window = min(DEFAULT_REPLAY_WINDOW_S, model.simulation.duration_s)
    res = run_once(model, replay_window_s=window)
    metrics = kpi_mod.compute([res])
    est = analytic.estimate(model)

    run_dir = proj.new_run_dir()
    (run_dir / "kpis.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2), "utf-8")
    import numpy as np
    np.save(run_dir / "heatmap.npy", res.heat)
    replay = build_replay(model, res, metrics)
    (run_dir / "replay.json").write_text(
        json.dumps(replay, ensure_ascii=False), "utf-8")
    render_png(model, res.heat, metrics, proj.load_provenance().summary(),
               run_dir / "layout_heatmap.png")
    return {"kpis": metrics, "estimate": est, "run": run_dir.name}


@app.post("/api/projects/{name}/run-scenarios")
def api_run_scenarios(name: str, payload: dict | None = None):
    """Run several what-ifs over the current model and return a comparison."""
    from whsim.engine.run import DEFAULT_REPLAY_WINDOW_S
    from whsim.engine.scenarios import (
        default_scenarios, payback_months, run_scenario,
    )
    from whsim.schema.model import Scenario
    proj = _open(name)
    base = proj.load_model()
    window = min(DEFAULT_REPLAY_WINDOW_S, base.simulation.duration_s)

    payload = payload or {}
    raw = payload.get("scenarios")
    scenarios = ([Scenario.model_validate(s) for s in raw] if raw
                 else default_scenarios(base))

    cmp_id = proj.new_run_dir().name.replace("run_", "compare_")
    cmp_dir = proj.runs_dir / cmp_id
    cmp_dir.mkdir(parents=True, exist_ok=True)
    prov = proj.load_provenance().summary()

    from whsim.engine.scenarios import apply_scenario
    results = []
    for i, sc in enumerate(scenarios):
        res, metrics = run_scenario(base, sc, replay_window_s=window)
        model_i = apply_scenario(base, sc)
        render_png(model_i, res.heat, metrics, prov, cmp_dir / f"s{i}.png")
        results.append({"name": sc.name, "description": sc.description,
                        "kpis": metrics,
                        "png_url": f"/api/projects/{name}/compare-png/{cmp_id}/{i}"})

    baseline = results[0]
    alternatives = results[1:]
    for alt in alternatives:
        pb = payback_months(baseline["kpis"], alt["kpis"])
        alt["kpis"]["payback_months"] = pb
    return {"compare_id": cmp_id, "baseline": baseline, "alternatives": alternatives}


@app.get("/api/projects/{name}/compare-png/{cmp}/{i}")
def api_compare_png(name: str, cmp: str, i: int):
    proj = _open(name)
    png = proj.runs_dir / cmp / f"s{i}.png"
    if not png.is_file():
        raise HTTPException(404, "no such comparison image")
    return FileResponse(png)


@app.get("/api/projects/{name}/replay")
def api_replay(name: str):
    proj = _open(name)
    rd = proj.latest_run_dir()
    if rd is None or not (rd / "replay.json").is_file():
        raise HTTPException(404, "no run yet")
    return JSONResponse(json.loads((rd / "replay.json").read_text("utf-8")))


@app.get("/api/projects/{name}/png")
def api_png(name: str):
    proj = _open(name)
    rd = proj.latest_run_dir()
    if rd is None or not (rd / "layout_heatmap.png").is_file():
        raise HTTPException(404, "no png yet")
    return FileResponse(rd / "layout_heatmap.png")


def _open(name: str) -> Project:
    try:
        return Project.open(name)
    except FileNotFoundError:
        raise HTTPException(404, f"no project {name!r}")


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


# ---- static frontend (mounted last so /api/* wins) --------------------------
app.mount("/", StaticFiles(directory=str(STATIC), html=True), name="static")
