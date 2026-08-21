"""共有可能ビューア（単一HTML書き出し）tests.

Covers ``whsim.export.htmlviewer.build_viewer_html`` (bare model + a real small
run) and the ``GET /api/projects/{name}/export/viewer`` endpoint. The load-bearing
invariant is that the output is FULLY SELF-CONTAINED: no external http(s) URLs
outside ``data:`` URIs / comments, so it opens from ``file://`` with no server.
"""

from __future__ import annotations

import json
import re

import pytest
from fastapi.testclient import TestClient

from whsim import kpis as kpi_mod
from whsim import templates
from whsim.engine.run import run_replications
from whsim.export.htmlviewer import build_viewer_html
from whsim.render.png2d import render as render_png
from whsim.render.replay import build_replay
from whsim.scorecard import build_scorecard
from whsim.schema.model import WarehouseModel
from whsim.web.app import app


# ---- helpers ----------------------------------------------------------------

# Match http(s) URLs, but NOT data:-URI payloads (base64 can't contain "http://"
# as a URL) and not schema/comment mentions. We look for a real "http://x"/"https"
# followed by a host char, then assert none survive outside a data: context.
_HTTP_RE = re.compile(r'https?://[A-Za-z0-9]')


def _external_urls(html: str) -> list[str]:
    """External http(s) references, excluding those inside inlined data: URIs."""
    # Strip data: URI payloads first (base64 image bytes) so a chance byte run
    # never trips the check.
    stripped = re.sub(r'data:[^"\')\s]+', '', html)
    return _HTTP_RE.findall(stripped)


def _small_run(model: WarehouseModel):
    model.simulation.duration_s = 900.0
    results, heat = run_replications(model, reps=1)
    metrics = kpi_mod.compute(results, model)
    replay = build_replay(model, results[0], metrics)
    return metrics, replay, heat


# ---- build_viewer_html ------------------------------------------------------

def test_bare_model_yields_valid_html_no_crash():
    html = build_viewer_html(WarehouseModel())
    assert html.startswith("<!DOCTYPE html>")
    assert "</html>" in html
    assert "実行結果がまだありません" in html
    assert not _external_urls(html)


def test_partial_inputs_are_guarded():
    # Missing replay -> no player; missing png -> no image. Still valid HTML.
    html = build_viewer_html(WarehouseModel(), replay=None, kpis=None,
                             scorecard=None, png_bytes=None)
    # No player element (the CSS rule may name the id, but the canvas + JS are gone).
    assert '<canvas id="wh-canvas"' not in html
    assert "__WHSIM_REPLAY__ = null" in html
    assert "data:image/png;base64," not in html
    assert not _external_urls(html)


def test_full_viewer_has_kpis_png_keyframes_and_no_external_urls(tmp_path):
    model = templates.load_template_model("ecommerce_small")
    metrics, replay, heat = _small_run(model)
    scorecard = build_scorecard(model, metrics)
    png = tmp_path / "p.png"
    render_png(model, heat, metrics, "test 100%", png)
    png_bytes = png.read_bytes()

    html = build_viewer_html(model, replay=replay, kpis=metrics,
                             scorecard=scorecard, png_bytes=png_bytes)

    # KPI numbers present (a headline metric rendered into a card).
    assert "主要KPI" in html
    assert "スループット" in html
    # Base64 image inlined, not linked.
    assert "data:image/png;base64," in html
    # Replay keyframes inlined for the player.
    assert "__WHSIM_REPLAY__" in html
    assert "wh-canvas" in html
    assert '"keyframes"' in html
    # Scorecard table.
    assert "採点表" in html
    # SELF-CONTAINED: zero external http(s) references.
    assert not _external_urls(html), _external_urls(html)
    # Size sanity: a real deliverable, but well under 5MB.
    assert 5_000 < len(html.encode("utf-8")) < 5_000_000


def test_ci_note_when_multi_rep(monkeypatch):
    # A ci block with metrics should surface a 95%CI annotation.
    kpis = {
        "throughput_per_hr": 120.0,
        "ci": {"n": 10, "confidence": 0.95, "metrics": {
            "throughput_per_hr": {"mean": 120.0, "half_width": 4.2, "n": 10}}},
    }
    html = build_viewer_html(WarehouseModel(), kpis=kpis)
    assert "95%CI" in html
    assert "n=10" in html


def test_brand_accent_applied():
    model = WarehouseModel()
    model.settings.brand.accent_color = "#ff5722"
    model.settings.brand.company_name = "テスト物流"
    html = build_viewer_html(model)
    assert "#ff5722" in html
    assert "テスト物流" in html


def test_script_injection_is_neutralised():
    # A replay carrying a "</script>" string must not break out of the tag.
    replay = {"meta": {"bounds": {"width": 10, "depth": 10}},
              "workers": [{"id": "</script><b>x", "keyframes": [[0, 1, 1, "walk"]]}]}
    html = build_viewer_html(WarehouseModel(), replay=replay)
    assert "</script><b>x" not in html
    assert "<\\/script>" in html


# ---- endpoint ---------------------------------------------------------------

@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def _make_project_with_run(name: str):
    from whsim.project import Project
    proj = Project.create(name, "ecommerce_small")
    model = proj.load_model()
    metrics, replay, heat = _small_run(model)
    rd = proj.new_run_dir()
    (rd / "kpis.json").write_text(json.dumps(metrics, ensure_ascii=False), "utf-8")
    (rd / "replay.json").write_text(json.dumps(replay, ensure_ascii=False), "utf-8")
    render_png(model, heat, metrics, "test 100%", rd / "layout_heatmap.png")
    return proj


def test_endpoint_returns_html_attachment_with_run(client):
    _make_project_with_run("demo")
    r = client.get("/api/projects/demo/export/viewer")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert "proposal_viewer.html" in r.headers.get("content-disposition", "")
    body = r.text
    assert body.startswith("<!DOCTYPE html>")
    assert "data:image/png;base64," in body
    assert "__WHSIM_REPLAY__" in body
    assert not _external_urls(body)


def test_endpoint_never_blocks_on_bare_project(client):
    from whsim.project import Project
    Project.create("empty", "ecommerce_small")
    r = client.get("/api/projects/empty/export/viewer")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    # No run yet, but a valid HTML still comes back.
    assert r.text.startswith("<!DOCTYPE html>")
    assert not _external_urls(r.text)
