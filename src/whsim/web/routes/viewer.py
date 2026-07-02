"""共有可能ビューア endpoint — a single self-contained HTML the salesperson mails.

``GET /api/projects/{name}/export/viewer`` assembles the project's latest run
(replay + KPIs, if any), the analytic scorecard, and the proposal PNG into ONE
read-only HTML file (no server, no external requests) via
:func:`whsim.export.htmlviewer.build_viewer_html`, and returns it as a download
attachment (``proposal_viewer.html``).

Never blocks: a project with no run still exports a valid HTML with a
「実行結果がまだありません」 notice.
"""

from __future__ import annotations

import json

from fastapi import APIRouter
from fastapi.responses import Response

from whsim.export.htmlviewer import build_viewer_html
from whsim.scorecard import build_scorecard

from ._common import _open

router = APIRouter()


def _latest_run_artifacts(proj) -> tuple[dict | None, dict | None, bytes | None]:
    """(replay, kpis, png_bytes) from the latest run — each None if absent."""
    replay = kpis = None
    png_bytes = None
    rd = proj.latest_run_dir()
    if rd is not None:
        kf = rd / "kpis.json"
        if kf.is_file():
            try:
                kpis = json.loads(kf.read_text("utf-8"))
            except Exception:  # noqa: BLE001 — corrupt artifact never blocks export
                kpis = None
        rf = rd / "replay.json"
        if rf.is_file():
            try:
                replay = json.loads(rf.read_text("utf-8"))
            except Exception:  # noqa: BLE001
                replay = None
        pf = rd / "layout_heatmap.png"
        if pf.is_file():
            try:
                png_bytes = pf.read_bytes()
            except OSError:
                png_bytes = None
    return replay, kpis, png_bytes


def _fresh_png(model, kpis: dict | None, provenance: str) -> bytes | None:
    """Render a proposal PNG on the fly (no run yet) so the viewer still shows a
    layout figure. Best-effort: any failure (missing docs extra, degenerate
    geometry) simply omits the image — never a 500."""
    try:
        import tempfile
        from pathlib import Path

        import numpy as np

        from whsim.render.png2d import render as render_png

        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "viewer.png"
            render_png(model, np.zeros((1, 1)), kpis or {}, provenance, out)
            return out.read_bytes()
    except Exception:  # noqa: BLE001 — layout figure is optional
        return None


@router.get("/api/projects/{name}/export/viewer")
def api_export_viewer(name: str):
    proj = _open(name)
    model = proj.load_model()
    replay, kpis, png_bytes = _latest_run_artifacts(proj)

    try:
        prov = proj.load_provenance().summary()
    except Exception:  # noqa: BLE001
        prov = ""
    if png_bytes is None:
        png_bytes = _fresh_png(model, kpis, prov)

    try:
        scorecard = build_scorecard(model, kpis)
    except Exception:  # noqa: BLE001 — scorecard is optional, never blocks
        scorecard = None

    html_str = build_viewer_html(
        model, replay=replay, kpis=kpis, scorecard=scorecard, png_bytes=png_bytes)

    headers = {
        "Content-Disposition": 'attachment; filename="proposal_viewer.html"',
    }
    return Response(content=html_str, media_type="text/html; charset=utf-8",
                    headers=headers)
