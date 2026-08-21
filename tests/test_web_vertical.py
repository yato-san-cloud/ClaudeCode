"""Backend tests for the 段(level) vertical-pick-time preview endpoint and the
process-knob round-trip that backs the 保管設計 vertical-time control.

GET /api/racktypes/vertical previews, per rack-type, the extra seconds to access
a pick at each level for a given lift speed / manual reach penalty (defaulting to
the model defaults). The two knobs (process.lift_speed_mps / manual_reach_s_per_m)
must persist via POST /design and survive a reload.
"""

import pytest
from fastapi.testclient import TestClient

from whsim.web.app import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def test_vertical_preview_default_shape(client):
    """No params -> model defaults, one row per rack type, level-aligned arrays."""
    from whsim import racktypes
    r = client.get("/api/racktypes/vertical")
    assert r.status_code == 200
    body = r.json()
    assert body["lift_speed_mps"] == 0.4
    assert body["manual_reach_s_per_m"] == 2.0
    assert body["defaults"] == {"lift_speed_mps": 0.4, "manual_reach_s_per_m": 2.0}
    rows = body["rack_types"]
    assert len(rows) == len(racktypes.ORDER)
    for row in rows:
        assert set(row) >= {"id", "label", "mover", "levels", "pitch_m", "vertical_s"}
        # one extra-seconds value per level
        assert len(row["vertical_s"]) == row["levels"]
        # ground 段 (level 1) is always free
        assert row["vertical_s"][0] == 0.0
        # vertical time grows monotonically with height
        assert row["vertical_s"] == sorted(row["vertical_s"])


def test_vertical_preview_params_override(client):
    """Slower lift / bigger reach penalty -> larger top-level times."""
    base = {r["id"]: r for r in client.get("/api/racktypes/vertical").json()["rack_types"]}
    slow = {r["id"]: r for r in
            client.get("/api/racktypes/vertical?lift=0.2&reach=4.0").json()["rack_types"]}
    # a manual rack with >1 level reacts to the reach knob
    light_top = lambda d: d["light"]["vertical_s"][-1]  # noqa: E731
    assert slow["light"]["mover"] == "manual"
    assert light_top(slow) > light_top(base)
    # a forklift rack reacts to the (slower) lift knob
    assert base["pallet"]["mover"] == "forklift"
    assert slow["pallet"]["vertical_s"][-1] > base["pallet"]["vertical_s"][-1]


def test_forklift_costs_more_than_manual_at_height(client):
    """Sanity oracle: a forklift hoist costs more than a manual reach at a
    comparable pick height (the engine charges the hoist up+down + mast setup)."""
    rows = {r["id"]: r for r in client.get("/api/racktypes/vertical").json()["rack_types"]}
    # pallet (forklift, 1.5m pitch) top level vs light (manual, 0.4m pitch) top level
    assert rows["pallet"]["vertical_s"][-1] > rows["light"]["vertical_s"][-1]


def test_process_knobs_roundtrip(client):
    """The two knobs persist via POST /design (process subtree) and reload."""
    client.post("/api/projects", json={"name": "v1", "template": "ecommerce_small"})
    full = client.get("/api/projects/v1/full").json()
    process = full["process"]
    process["lift_speed_mps"] = 0.25
    process["manual_reach_s_per_m"] = 3.5

    r = client.post("/api/projects/v1/design", json={"process": process})
    assert r.status_code == 200

    reloaded = client.get("/api/projects/v1/full").json()
    assert reloaded["process"]["lift_speed_mps"] == 0.25
    assert reloaded["process"]["manual_reach_s_per_m"] == 3.5
