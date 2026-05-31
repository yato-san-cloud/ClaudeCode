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
