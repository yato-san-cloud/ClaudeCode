"""Material-flow / 荷役物量 authoring: flow seed, data-creation, scenario, API."""

from fastapi.testclient import TestClient

from whsim.analysis import staffing
from whsim.web.app import app


def test_flow_seed_is_the_process_chain():
    ids = [p["id"] for p in staffing.flow_seed()]
    assert ids == ["入荷検品", "格納", "ピッキング", "検品", "梱包", "出荷"]
    for p in staffing.flow_seed():
        assert p["unit"] and p["productivity"] > 0 and "driver" in p


def test_generate_fills_missing_from_one_number():
    v = staffing.generate_flow_volumes({"out_lines": 1000})
    assert v["ピッキング"] == 1000          # outbound lines drive picking
    assert v["格納"] > v["ピッキング"]        # putaway driven by pieces (qty)
    assert 0 < v["出荷"] < v["ピッキング"]    # orders < lines
    assert v["入荷検品"] > 0                  # inbound inferred from outbound


def test_generate_empty_is_zero():
    v = staffing.generate_flow_volumes({})
    assert all(x == 0 for x in v.values())


def test_scenario_from_volumes_solves():
    from whsim import timetable
    sc = staffing.scenario_from_volumes({"ピッキング": 1200, "梱包": 800, "出荷": 800})
    res = timetable.solve(sc["scenarios"]["実データ（平均日）"],
                          sc["processes"], sc["productivity"])
    assert res["peak_headcount"] > 0


def test_endpoints():
    c = TestClient(app)
    assert len(c.get("/api/materialflow/seed").json()["flow"]) == 6
    g = c.post("/api/materialflow/generate", json={"base": {"out_orders": 500}}).json()
    assert g["volumes"]["出荷"] > 0
    s = c.post("/api/materialflow/scenario", json={"volumes": {"ピッキング": 900}})
    assert s.status_code == 200 and s.json()["processes"]
