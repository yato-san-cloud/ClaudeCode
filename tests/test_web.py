"""Smoke test the web API end-to-end (template -> import -> run -> replay)."""

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from whsim.web.app import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # Isolate project workspaces under a temp dir.
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def test_full_flow(client):
    assert client.get("/api/templates").status_code == 200

    r = client.post("/api/projects", json={"name": "t1", "template": "ecommerce_small"})
    assert r.status_code == 200

    m = client.get("/api/projects/t1/model").json()
    assert m["headline_fields"]
    assert "実データ" in m["provenance_summary"]

    # tolerant import: a broken file must not 500 the request
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("outbound.json", json.dumps(
            [{"order_id": "O1", "arrival_s": 0, "lines": [{"sku": "SKU0000", "qty": 1}]}]))
        z.writestr("broken.json", "{nope")
    r = client.post("/api/projects/t1/import",
                    files={"file": ("up.zip", buf.getvalue(), "application/zip")})
    assert r.status_code == 200
    body = r.json()
    assert "orders" in body["updated"]
    assert any("broken.json" in w for w in body["warnings"])

    # shorten the sim so the test is fast
    client.post("/api/projects/t1/headline", json={"simulation.duration_s": 1200})
    r = client.post("/api/projects/t1/run")
    assert r.status_code == 200
    kpis = r.json()["kpis"]
    assert kpis["bottleneck"] in {"picking", "packing"}

    rep = client.get("/api/projects/t1/replay").json()
    assert rep["workers"] and rep["workers"][0]["keyframes"]
    assert client.get("/api/projects/t1/png").status_code == 200
