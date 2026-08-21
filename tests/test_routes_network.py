"""経路ネットワーク自動生成 endpoint (POST /api/routes/network) + graph helpers."""
from fastapi.testclient import TestClient

from whsim.engine.graph import simplify_collinear
from whsim.web.app import app

client = TestClient(app)


def test_simplify_collinear_collapses_grid_runs():
    pts = [(0, 0), (1, 0), (2, 0), (3, 0), (3, 1), (3, 2), (5, 2)]
    out = simplify_collinear(pts)
    assert out == [(0, 0), (3, 0), (3, 2), (5, 2)]
    # endpoints always survive; short inputs pass through
    assert simplify_collinear([(0, 0), (9, 9)]) == [(0, 0), (9, 9)]


def test_network_detours_around_wall():
    # vertical wall at x=15 with a 3m gap at the top: a→b must go up and over.
    body = {
        "bounds": {"width": 30, "depth": 20},
        "walls": [{"points": [[15, 0], [15, 17]]}],
        "include_edges": True,
        "queries": [{"a": [5, 5], "b": [25, 5]}],
    }
    r = client.post("/api/routes/network", json=body)
    assert r.status_code == 200
    d = r.json()
    assert d["enabled"] is True
    assert len(d["edges"]) > 0
    path = d["paths"][0]
    assert path["distance_m"] > 30          # detour beats the 20m Manhattan L
    ys = [p[1] for p in path["points"]]
    assert max(ys) > 16                      # actually climbed over the gap
    # no edge crosses the wall (x=15, y<17): every edge stays on one side or
    # crosses above the wall's top.
    for (x1, y1, x2, y2) in d["edges"]:
        if (x1 - 15) * (x2 - 15) < 0:        # spans the wall x
            assert min(y1, y2) >= 16.0       # only above the gap


def test_network_routes_around_shelves():
    # a shelf slab across the middle: the path must leave the straight line.
    body = {
        "bounds": {"width": 20, "depth": 20},
        "shelves": [[2, 9, 16, 2]],
        "queries": [{"a": [10, 4], "b": [10, 16]}],
    }
    r = client.post("/api/routes/network", json=body)
    assert r.status_code == 200
    d = r.json()
    p = d["paths"][0]
    assert p["distance_m"] > 12.5            # straight would be 12
    xs = [pt[0] for pt in p["points"]]
    assert min(xs) < 2.5 or max(xs) > 17.5   # went around an end of the slab


def test_network_tolerates_garbage():
    r = client.post("/api/routes/network", json={
        "bounds": {"width": "x"}, "walls": [{"points": "junk"}, 7],
        "shelves": [["a"], [1, 2, 3], [0, 0, -5, 2]],
        "queries": [{"a": [1]}, {"b": [2, 2]}, {"a": [1, 1], "b": [3, 3]}],
    })
    assert r.status_code == 200
    d = r.json()
    assert len(d["paths"]) == 1              # only the valid query answered
    assert d["paths"][0]["distance_m"] >= 0
