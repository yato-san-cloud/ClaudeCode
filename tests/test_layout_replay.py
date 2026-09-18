"""2D/3D reflect the CURRENT design — not just the last run.

GET /replay returns a run-free *layout* replay (static objects, empty agent
tracks, layout_only=True) when there is no run yet OR the model was edited since
the last run; once fresh it serves the full run replay (with moving agents). This
is what makes a just-placed object show in 2D/3D before re-running.
"""
import json

import pytest
from fastapi.testclient import TestClient

from whsim.render.replay import build_layout_replay
from whsim.web.app import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def _mk(client, name="r3d", template="retail_dc"):
    assert client.post("/api/projects", json={"name": name, "template": template}).status_code == 200


def test_build_layout_replay_has_all_static_types():
    from whsim import templates
    rep = build_layout_replay(templates.load_template_model("retail_dc"))
    assert rep["layout_only"] is True
    # every placeable static type is present; agent tracks are empty (no run)
    for key in ("zones", "racks", "shelves", "walls", "doors", "equipment", "stations"):
        assert isinstance(rep[key], list)
    assert rep["zones"] and rep["racks"] and rep["walls"]
    assert rep["workers"] == [] and rep["agvs"] == [] and rep["congestion"] is None


def test_replay_serves_live_layout_then_run_then_edit(client):
    _mk(client)
    # 1) no run yet → live layout replay (never 404), reflects the template design
    r = client.get("/api/projects/r3d/replay")
    assert r.status_code == 200
    j = r.json()
    assert j.get("layout_only") is True and len(j["zones"]) > 0

    # 2) after a run → full replay (agents present, not layout_only)
    client.post("/api/projects/r3d/run")
    j = client.get("/api/projects/r3d/replay").json()
    assert not j.get("layout_only")
    assert len(j["workers"]) > 0

    # 3) place an object + save (NO re-run) → replay reflects it immediately
    import whsim.project as project_mod
    mf = project_mod.PROJECTS_DIR / "r3d" / "model.json"
    md = json.loads(mf.read_text("utf-8"))
    md["resources"]["equipment"].append(
        {"id": "sorter1", "type": "sorter", "x": 30.0, "y": 15.0, "count": 1})
    assert client.post("/api/projects/r3d/design",
                       json={"resources": md["resources"]}).status_code == 200
    j = client.get("/api/projects/r3d/replay").json()
    assert j.get("layout_only") is True               # stale run → live layout
    assert any(e["id"] == "sorter1" for e in j["equipment"])  # the placed object shows

    # 4) re-run → full replay again, still carrying the placed object
    client.post("/api/projects/r3d/run")
    j = client.get("/api/projects/r3d/replay").json()
    assert not j.get("layout_only") and len(j["workers"]) > 0
    assert any(e["id"] == "sorter1" for e in j["equipment"])
