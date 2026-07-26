"""Tests for the パラメータ自動掃引 (mini-OptQuest) — module + endpoint.

The sweep scores 作業方式 × 人員数 × まとめ数 analytically (no DES) and ranks them.
These pin the load-bearing contracts: deterministic ranking, the feasible-first
objective, the combo cap + truncated flag, the never-blocks empty state, and the
endpoint shape.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from whsim import sweep
from whsim.schema.model import WarehouseModel
from whsim.web.app import app

# A fixed, positive per-process volume set so every run is fully deterministic.
_VOLUMES = {
    "入荷検品": 600.0, "格納": 600.0, "ピッキング": 3200.0,
    "検品": 3200.0, "梱包": 1100.0, "出荷": 1100.0,
}


def _model() -> WarehouseModel:
    """A bare-but-valid model (defaults give one picker group + a storage zone)."""
    return WarehouseModel()


def test_available_false_on_empty_volumes():
    """No volumes (a project with no demand yet) → an honest, never-blocks reason."""
    m = _model()
    assert sweep.run_sweep(m, None)["available"] is False
    assert sweep.run_sweep(m, {})["available"] is False
    # all-zero volumes count as "no demand" too
    assert sweep.run_sweep(m, {"ピッキング": 0})["available"] is False


def test_ranking_is_deterministic():
    """Same inputs → byte-identical ranking (analytic, no randomness)."""
    m = _model()
    a = sweep.run_sweep(m, _VOLUMES)
    b = sweep.run_sweep(m, _VOLUMES)
    assert a["available"] and a["rows"]
    def key(res):
        return [(r["rank"], r["method_id"], r["orders_per_trip"], r["pickers"],
                 r["feasible"], r["monthly_cost"], r["peak"]) for r in res["rows"]]
    assert key(a) == key(b)
    # rank is a dense 1..N stamped in objective order
    assert [r["rank"] for r in a["rows"]] == list(range(1, len(a["rows"]) + 1))
    assert a["best"] == a["rows"][0]


def test_feasibility_dominates_cost():
    """The objective is lexicographic: every feasible combo outranks every
    infeasible one, regardless of the infeasible one's (possibly lower) cost."""
    m = _model()
    res = sweep.run_sweep(m, _VOLUMES)
    rows = res["rows"]
    feas = [r for r in rows if r["feasible"]]
    infeas = [r for r in rows if not r["feasible"]]
    assert feas and infeas, "need a mix of feasible/infeasible to exercise the rule"
    assert max(r["rank"] for r in feas) < min(r["rank"] for r in infeas)
    # within the feasible block, cost is non-decreasing by rank (then peak breaks ties)
    fs = sorted(feas, key=lambda r: r["rank"])
    costs = [r["monthly_cost"] for r in fs if r["monthly_cost"] is not None]
    assert costs == sorted(costs)


def test_default_grid_shape_and_budget():
    """The default grid stays under the cap and reports the objective + evaluated."""
    m = _model()
    res = sweep.run_sweep(m, _VOLUMES)
    assert res["evaluated"] <= sweep.MAX_COMBOS
    assert res["truncated"] is False
    assert res["objective"] and res["note"]
    assert res["current_pickers"] >= 1
    # multi is swept over orders_per_trip; the other methods sit at their preset opt
    multi_opts = {r["orders_per_trip"] for r in res["rows"] if r["method_id"] == "multi"}
    assert multi_opts == set(sweep._MULTI_OPTS)
    row = res["rows"][0]
    assert set(row) >= {"rank", "method_label", "pickers", "orders_per_trip", "feasible",
                        "makespan_hour", "peak", "total_man_hours", "monthly_cost",
                        "cost_per_order"}


def test_combo_cap_and_truncated_flag():
    """A pathological grid is trimmed to MAX_COMBOS and flagged truncated."""
    m = _model()
    grid = {"pickers": list(range(1, 60)),
            "orders_per_trip": [2, 4, 6, 8, 10, 12, 14, 16]}
    res = sweep.run_sweep(m, _VOLUMES, grid)
    assert res["evaluated"] <= sweep.MAX_COMBOS
    assert res["truncated"] is True


def test_picking_productivity_matches_pickrate_at_preset_opt():
    """The swept picking productivity reuses pickrate's closed form: at a method's
    own preset orders_per_trip it reproduces that method's estimate_pickrate row."""
    from whsim import pickrate, workmethod
    m = _model()
    est = pickrate.estimate_pickrate(m)
    geo = est["geometry"]
    for preset in workmethod.METHOD_PRESETS:
        opt = int(preset["work"].get("orders_per_trip", 1))
        is_sort = preset["work"].get("consolidation") == "sort"
        got = sweep._picking_lines_per_hour(geo, is_sort, opt)
        row = next(r for r in est["methods"] if r["label"] == preset["label"])
        # rounded geometry vs the row's unrounded internals → allow a small tol
        assert got == pytest.approx(row["lines_per_hour"], rel=0.03)


# ---- endpoint ---------------------------------------------------------------

@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def test_endpoint_unknown_project_404(client):
    assert client.post("/api/projects/nope/sweep", json={}).status_code == 404


def test_endpoint_shape(client):
    """POST /sweep returns 200 with the documented shape (available true/false)."""
    client.post("/api/projects", json={"name": "s1", "template": "ecommerce_small"})
    r = client.post("/api/projects/s1/sweep", json={})
    assert r.status_code == 200
    body = r.json()
    assert "available" in body
    if body["available"]:
        assert body["rows"] and body["best"]
        assert body["objective"] and "evaluated" in body
        assert "pick_stage_index" in body
        first = body["rows"][0]
        assert first["rank"] == 1
    else:
        assert body.get("reason")
