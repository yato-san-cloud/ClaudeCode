"""Tests for the "分析" analysis-dashboard endpoint (GET /…/analysis).

The view consumes a reshaped KPI payload. The endpoint must honour whsim's
"never blocks" invariant: even with no SimPy run it falls back to the instant
analytic estimate, so the view always has insights + KPIs to show. We exercise
both paths (estimate fallback and a real run) plus the 404 case.
"""

import pytest
from fastapi.testclient import TestClient

from whsim.web.app import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def _assert_shape(body):
    # Top-level contract.
    assert body["source"] in ("run", "estimate")
    assert isinstance(body["insights"], list)
    assert isinstance(body["kpis"], dict)
    assert isinstance(body["kpis"]["hero"], list)
    assert isinstance(body["kpis"]["groups"], list)
    assert len(body["kpis"]["hero"]) <= 4
    assert isinstance(body["charts"], dict)
    # Insight contract: "指摘 -> 提案" — every insight has severity/title/metric;
    # danger/warn carry an action, info never does (the view drops the chip).
    for ins in body["insights"]:
        assert ins["severity"] in ("danger", "warn", "info", "ok")
        assert ins["title"]
        assert "metric" in ins
        if ins["severity"] in ("danger", "warn"):
            assert ins.get("action")
    # Hero KPI contract.
    for h in body["kpis"]["hero"]:
        assert "label" in h and "value" in h
    # Stages chart is always present and label/value aligned.
    stages = body["charts"]["stages"]
    assert len(stages["labels"]) == len(stages["values"])


def test_analysis_estimate_fallback(client):
    """No run yet -> the analytic estimate keeps the view alive."""
    client.post("/api/projects", json={"name": "a1", "template": "ecommerce_small"})
    r = client.get("/api/projects/a1/analysis")
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "estimate"
    assert body["name"] == "a1"
    _assert_shape(body)
    # Even the thin analytic estimate keeps the view alive with hero KPIs
    # (e.g. 出荷完了率 / 稼働率) — whsim's "never blocks" invariant.
    assert body["kpis"]["hero"], "estimate should still surface hero KPIs"


def test_analysis_after_run(client):
    """A real (short) run -> source=run, verdict present, KPIs populated."""
    client.post("/api/projects", json={"name": "a2", "template": "ecommerce_small"})
    client.post("/api/projects/a2/headline", json={"simulation.duration_s": 1200})
    assert client.post("/api/projects/a2/run").status_code == 200

    r = client.get("/api/projects/a2/analysis")
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "run"
    assert isinstance(body["verdict"], str) and body["verdict"]
    _assert_shape(body)
    # A real run reports hero KPIs and at least the volume KPI group.
    assert body["kpis"]["hero"]
    assert body["kpis"]["groups"]


def test_analysis_unknown_project_404(client):
    assert client.get("/api/projects/does_not_exist/analysis").status_code == 404
