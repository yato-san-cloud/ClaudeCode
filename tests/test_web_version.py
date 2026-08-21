"""/api/version — the header build badge's data source."""

from __future__ import annotations

from starlette.testclient import TestClient

from whsim.web.app import app


def test_api_version_shape():
    r = TestClient(app).get("/api/version")
    assert r.status_code == 200
    j = r.json()
    # Version always present (pyproject or installed metadata); never blocks.
    assert isinstance(j.get("version"), str) and j["version"]
    # Commit fields are best-effort: a short hash + ISO-ish time, or null
    # (e.g. wheel installs without git) — both shapes are valid.
    assert "commit" in j and "commit_time" in j
    if j["commit"] is not None:
        assert 6 <= len(j["commit"]) <= 16
        assert j["commit_time"]
