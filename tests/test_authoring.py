"""Empty-floor authoring: the blank template starts with no locations, stays
runnable, and drawing a SHELF area creates location cells (MapMaker-style)."""

import pytest
from fastapi.testclient import TestClient

from whsim.web.app import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def test_blank_template_listed():
    assert "blank" in {t["template_id"] for t in TestClient(app).get("/api/templates").json()}


def test_blank_starts_empty_runs_then_shelf_creates_locations(client):
    assert client.post("/api/projects",
                       json={"name": "b", "template": "blank"}).status_code == 200

    full = client.get("/api/projects/b/full").json()
    zones = full["layout"]["zones"]
    assert full.get("locations", []) == []          # no dots from the start

    # empty floor is still runnable (never blocks)
    assert client.post("/api/projects/b/run").status_code == 200

    # draw a SHELF area in the storage zone -> locations materialise
    for z in zones:
        if z["type"] == "storage":
            z["shelves"] = [{"id": "s0", "x": z["x"] + 1, "y": z["y"] + 1,
                             "w": 2, "h": z["h"] - 2, "cell_w": 1.0, "cell_d": 1.0}]
    r = client.post("/api/projects/b/design", json={"layout": full["layout"]})
    assert r.status_code == 200
    assert r.json()["locations"] > 0
