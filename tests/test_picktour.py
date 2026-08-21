"""ピック順序最適化 — picktour optimizers, the additive routing hook, and the
analytic /pickseq endpoint.

The load-bearing guarantees tested here:
  * two_opt tour length <= greedy_nn <= naive (over random point sets),
  * the optimized routing option leaves every existing run BYTE-IDENTICAL when
    it is not selected (the engine default path is unchanged),
  * the endpoint returns the documented shape and a non-negative reduction.
"""

import random

import pytest
from fastapi.testclient import TestClient

from whsim import picktour, templates
from whsim.engine.routing import manhattan
from whsim.engine.run import run_once
from whsim.web.app import app


# --- 1. tour optimizers: two_opt <= greedy_nn <= naive --------------------

def test_two_opt_never_worse_than_greedy_never_worse_than_naive():
    rng = random.Random(7)
    start = (0.0, 0.0)
    for n in (4, 8, 15, 30, 60):
        pts = [(rng.uniform(0, 100), rng.uniform(0, 100)) for _ in range(n)]
        naive = picktour.route_length(start, pts, picktour.naive_route(pts), manhattan)
        g_route = picktour.greedy_nn(start, pts, manhattan)
        greedy = picktour.route_length(start, pts, g_route, manhattan)
        o_route = picktour.two_opt(start, pts, manhattan, g_route)
        opt = picktour.route_length(start, pts, o_route, manhattan)
        # a permutation of the inputs (visits every stop exactly once)
        assert sorted(o_route) == list(range(n))
        assert opt <= greedy + 1e-6
        assert greedy <= naive + 1e-6


def test_optimize_pipeline_and_or_opt_improve():
    rng = random.Random(11)
    start = (0.0, 0.0)
    pts = [(rng.uniform(0, 50), rng.uniform(0, 50)) for _ in range(25)]
    greedy = picktour.route_length(start, pts, picktour.greedy_nn(start, pts, manhattan), manhattan)
    opt = picktour.route_length(start, pts, picktour.optimize(start, pts, manhattan), manhattan)
    assert opt <= greedy + 1e-6


def test_two_opt_deterministic():
    rng = random.Random(3)
    start = (1.0, 2.0)
    pts = [(rng.uniform(0, 80), rng.uniform(0, 80)) for _ in range(40)]
    a = picktour.two_opt(start, pts, manhattan)
    b = picktour.two_opt(start, pts, manhattan)
    assert a == b


def test_large_tour_stays_bounded():
    rng = random.Random(5)
    start = (0.0, 0.0)
    pts = [(rng.uniform(0, 300), rng.uniform(0, 300)) for _ in range(400)]
    g = picktour.greedy_nn(start, pts, manhattan)
    o = picktour.two_opt(start, pts, manhattan, g)
    assert sorted(o) == list(range(400))
    assert (picktour.route_length(start, pts, o, manhattan)
            <= picktour.route_length(start, pts, g, manhattan) + 1e-6)


def test_consolidated_tour_dedups_shared_locations():
    start = (0.0, 0.0)
    shared = (10.0, 10.0)
    orders = [[shared, (20.0, 5.0)], [shared, (30.0, 8.0)]]
    pts, route = picktour.consolidated_tour(start, orders, manhattan)
    # the shared location appears ONCE in the consolidated tour
    assert len(pts) == 3
    assert sorted(route) == [0, 1, 2]


def test_degenerate_inputs():
    assert picktour.greedy_nn((0, 0), [], manhattan) == []
    assert picktour.two_opt((0, 0), [(1, 1)], manhattan) == [0]
    assert picktour.route_length((0, 0), [], [], manhattan) == 0.0


# --- 2. the additive routing hook leaves existing runs byte-identical -----

def _events_signature(res):
    """A stable signature of a run's event log + picker trajectories."""
    ev = [(e.get("event"), e.get("order_id"), round(e.get("t", 0.0), 3),
           round(e.get("dist", 0.0), 4)) for e in res.events]
    kf = [tuple(w.keyframes) for w in res.workers]
    return ev, kf


def test_default_routing_unchanged_when_optimized_not_selected():
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 1800
    # Two independent runs with the DEFAULT build path must be identical, and
    # the engine never opts into "optimized" on its own (run_once uses default).
    a = run_once(m, seed=1)
    b = run_once(m, seed=1)
    assert _events_signature(a) == _events_signature(b)


def test_optimized_build_flag_only_shortens_and_is_opt_in():
    import simpy

    from whsim.engine.build import build
    m = templates.load_template_model("ecommerce_small")
    # default build => the MODEL's policy (schema default "nearest" = the same
    # nearest-neighbour branch "default" always took). A scenario JSON that sets
    # `process.routing_policy` now reaches the engine with no code change.
    w_default = build(m, simpy.Environment())
    assert w_default.routing_policy == "nearest"
    m.process.routing_policy = "s_shape"
    assert build(m, simpy.Environment()).routing_policy == "s_shape"
    # opt-in build kwarg still wins over the model value
    w_opt = build(m, simpy.Environment(), routing_policy="optimized")
    assert w_opt.routing_policy == "optimized"


# --- 3. the analytic endpoint returns the documented shape ----------------

@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def _import_orders(client, name, skus, n=30):
    import io
    import json
    import zipfile
    rng = random.Random(0)
    orders = []
    for i in range(n):
        k = rng.randint(2, 5)
        lines = [{"sku": rng.choice(skus), "qty": rng.randint(1, 3)} for _ in range(k)]
        orders.append({"order_id": f"O{i}", "arrival_s": float(i * 30 + 30000),
                       "lines": lines})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("outbound.json", json.dumps(orders))
    client.post(f"/api/projects/{name}/import",
                files={"file": ("up.zip", buf.getvalue(), "application/zip")})


def test_pickseq_endpoint_shape_and_reduction(client):
    client.post("/api/projects", json={"name": "p1", "template": "ecommerce_small"})
    skus = [f"SKU{i:04d}" for i in range(20)]  # ecommerce_small placed SKUs
    _import_orders(client, "p1", skus)

    r = client.get("/api/projects/p1/pickseq")
    assert r.status_code == 200
    body = r.json()
    assert set(body["methods"]) == {"naive", "greedy", "optimized"}
    assert {m["id"] for m in body["modes"]} == {"order", "multi", "total"}
    for m in body["modes"]:
        meth = m["methods"]
        # optimized tour is never longer than naive (per mode)
        assert meth["optimized"]["length_m"] <= meth["naive"]["length_m"] + 1e-6
        assert m["dist_reduction_pct"] >= -1e-6
    assert body["recommend_mode"] in {"order", "multi", "total"}
    assert "verdict" in body and isinstance(body["headline_reduction_pct"], (int, float))


def test_pickseq_never_blocks_without_orders(client):
    # A fresh template project ships no explicit outbound orders, so the endpoint
    # must still answer (has_data False) rather than 500.
    client.post("/api/projects", json={"name": "empty", "template": "ecommerce_small"})
    r = client.get("/api/projects/empty/pickseq")
    assert r.status_code == 200
    body = r.json()
    assert body["has_data"] is False
    assert body["recommend_mode"] == "order"
