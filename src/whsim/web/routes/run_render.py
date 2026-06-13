"""Run-artifact endpoints: the replay JSON, the proposal PNG, the per-scenario
comparison images, and the editable PPTX/PDF proposal export.

The heavy ``/run`` and ``/run-scenarios`` endpoints themselves stay in
``whsim.web.app`` together with the in-flight concurrency guard and the
``run_replications`` symbol, so the existing tests can monkeypatch
``whsim.web.app.run_replications`` / ``_inflight_runs`` against the same module
namespace the endpoints execute in."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from ._common import _call_export, _open, _proposal_extras, _safe_name

router = APIRouter()


@router.get("/api/projects/{name}/proposal.{fmt}")
def api_proposal(name: str, fmt: str):
    """Generate an editable PPTX or a PDF proposal from the latest run.

    Enriches the deliverable with the latest scenario comparison, the analysis
    dashboard's recommendations (shared via ``_analysis_payload``), and the
    provenance summary. Degrades gracefully: missing scenarios/insights are
    simply omitted, never a 500. Response/download behavior is unchanged."""
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
    try:
        extras = _proposal_extras(proj, proj.load_model(), kpis)
    except Exception:  # noqa: BLE001 — fall back to the bare proposal
        extras = {"scenarios": None, "insights": None, "provenance": prov}
    builder = export_doc.build_pptx if fmt == "pptx" else export_doc.build_pdf
    _call_export(builder, kpis, proj.meta()["name"], prov,
                 png if png.is_file() else None, out, extras)
    media = ("application/vnd.openxmlformats-officedocument.presentationml.presentation"
             if fmt == "pptx" else "application/pdf")
    return FileResponse(out, media_type=media, filename=f"{name}_提案書.{fmt}")


@router.get("/api/projects/{name}/compare-png/{cmp}/{i}")
def api_compare_png(name: str, cmp: str, i: int):
    proj = _open(name)
    cmp = _safe_name(cmp)
    png = proj.runs_dir / cmp / f"s{i}.png"
    if not png.is_file():
        raise HTTPException(404, "no such comparison image")
    return FileResponse(png)


@router.get("/api/projects/{name}/replay")
def api_replay(name: str):
    proj = _open(name)
    rd = proj.latest_run_dir()
    replay_file = (rd / "replay.json") if rd is not None else None
    # Use the stored run replay only while it is still FRESH — i.e. the model has
    # not been edited since that run. Otherwise (no run yet, or the layout changed)
    # return a run-free layout replay so 2D/3D reflect the CURRENT design
    # immediately; ▶実行 then refreshes it with the moving agents.
    if replay_file is not None and replay_file.is_file():
        try:
            fresh = proj.model_file.stat().st_mtime <= replay_file.stat().st_mtime
        except OSError:
            fresh = True
        if fresh:
            return JSONResponse(json.loads(replay_file.read_text("utf-8")))
    from whsim.render.replay import build_layout_replay
    return JSONResponse(build_layout_replay(proj.load_model()))


@router.get("/api/projects/{name}/png")
def api_png(name: str):
    proj = _open(name)
    rd = proj.latest_run_dir()
    if rd is None or not (rd / "layout_heatmap.png").is_file():
        raise HTTPException(404, "no png yet")
    return FileResponse(rd / "layout_heatmap.png")
