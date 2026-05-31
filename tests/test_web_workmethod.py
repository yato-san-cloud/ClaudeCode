"""Backend tests for the work-method endpoints and Stage.zone/work round-trip.

These back the floor-plan flow editor: the designer POSTs a 5-axis WorkMethod to
reverse-name it, asks for a recommendation, and saves flow edits (zone bindings +
the pick stage's 5-axis work) via POST /design. All must round-trip and stay
"always runnable".
"""

import pytest
from fastapi.testclient import TestClient

from whsim.web.app import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def test_workmethod_name_default(client):
    """Empty body -> the default single-order picking name + an explanation."""
    r = client.post("/api/workmethod/name", json={})
    assert r.status_code == 200
    body = r.json()
    assert "シングルオーダー" in body["name"]
    assert body["explain"]  # non-empty plain-language description


def test_workmethod_name_combinations(client):
    """A few axis combinations reverse-name to the familiar method names."""
    # 種まき (total picking / sort)
    r = client.post("/api/workmethod/name",
                    json={"consolidation": "sort", "orders_per_trip": 8})
    assert "種まき" in r.json()["name"]

    # goods-to-person (AGV)
    r = client.post("/api/workmethod/name", json={"transport": "agv"})
    assert "goods-to-person" in r.json()["name"]

    # multi-order (batch / cart)
    r = client.post("/api/workmethod/name", json={"orders_per_trip": 4})
    assert "マルチオーダー" in r.json()["name"]

    # zone (parallel)
    r = client.post("/api/workmethod/name", json={"zoning": "parallel"})
    assert "ゾーン" in r.json()["name"]


def test_workmethod_recommend(client):
    """The recommend endpoint returns the documented {work, name, reason} shape."""
    client.post("/api/projects", json={"name": "r1", "template": "ecommerce_small"})
    r = client.get("/api/projects/r1/workmethod/recommend")
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"work", "name", "reason"}
    # the suggested work is a valid 5-axis object the editor can load directly
    assert set(body["work"]) >= {
        "transport", "orders_per_trip", "zoning", "consolidation", "release",
    }
    assert body["name"] and body["reason"]


def test_recommend_unknown_project_404(client):
    assert client.get("/api/projects/nope/workmethod/recommend").status_code == 404


def test_design_roundtrips_stage_zone_and_work(client):
    """POST /design must persist Stage.zone (spatial binding) and the pick
    stage's 5-axis work, and the model must stay valid / reloadable."""
    client.post("/api/projects", json={"name": "d1", "template": "ecommerce_small"})
    full = client.get("/api/projects/d1/full").json()
    process = full["process"]

    # bind the pick stage to a zone and give it an explicit 5-axis work method
    pick = next(s for s in process["stages"] if s["id"] == "pick")
    pick["zone"] = "picking"
    pick["work"] = {
        "transport": "agv", "orders_per_trip": 6, "zoning": "parallel",
        "consolidation": "sort", "release": "wave", "wave_interval_s": 900.0,
    }
    # bind another stage's zone too (spatial flow ordering)
    recv = next(s for s in process["stages"] if s["id"] == "receive")
    recv["zone"] = "receiving"

    r = client.post("/api/projects/d1/design", json={"process": process})
    assert r.status_code == 200

    # reload and confirm the fields survived
    reloaded = client.get("/api/projects/d1/full").json()
    rpick = next(s for s in reloaded["process"]["stages"] if s["id"] == "pick")
    assert rpick["zone"] == "picking"
    assert rpick["work"]["transport"] == "agv"
    assert rpick["work"]["consolidation"] == "sort"
    assert rpick["work"]["wave_interval_s"] == 900.0
    rrecv = next(s for s in reloaded["process"]["stages"] if s["id"] == "receive")
    assert rrecv["zone"] == "receiving"

    # always runnable: the edited model still simulates
    client.post("/api/projects/d1/headline", json={"simulation.duration_s": 600})
    assert client.post("/api/projects/d1/run").status_code == 200


def test_design_accepts_null_work_and_zone(client):
    """Stages with no zone / no work (the unbound default) must save fine too."""
    client.post("/api/projects", json={"name": "d2", "template": "ecommerce_small"})
    full = client.get("/api/projects/d2/full").json()
    process = full["process"]
    for s in process["stages"]:
        s["zone"] = None
        s["work"] = None
    r = client.post("/api/projects/d2/design", json={"process": process})
    assert r.status_code == 200
