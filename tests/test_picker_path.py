"""Picker trajectories follow the REAL aisle route, not a straight line.

The replay viewer lerps between a worker's keyframes, so if a move emitted only
its endpoints the worker would cut diagonally through shelves. `World.path` returns
the wall-aware route's corner waypoints and `_walk` emits them, so the agent walks
the aisles. Total travel time is unchanged (it's still world.dist / speed).
"""

import math

from whsim.engine.build import build
from whsim.schema.model import ShelfArea, WarehouseModel, Zone


def _model_with_block() -> WarehouseModel:
    m = WarehouseModel()
    m.layout.bounds.width, m.layout.bounds.depth = 30, 20
    m.layout.zones = [Zone(id="storage", type="storage", x=0, y=0, w=30, h=20,
                           shelves=[ShelfArea(id="a", x=10, y=8, w=10, h=4,
                                              rack_type="pallet")])]
    return m


def test_world_path_detours_around_a_block():
    w = build(_model_with_block())
    assert w.use_graph
    a, b = (5.0, 10.0), (25.0, 10.0)      # straight line crosses the shelf block
    pts = w.path(a, b)
    # real endpoints are stitched on, and there is at least one corner (a detour).
    assert math.hypot(pts[0][0] - a[0], pts[0][1] - a[1]) < 1e-6
    assert math.hypot(pts[-1][0] - b[0], pts[-1][1] - b[1]) < 1e-6
    assert len(pts) > 2, pts
    # the polyline is at least the straight-line distance (it goes around).
    plen = sum(math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
               for i in range(1, len(pts)))
    assert plen >= math.hypot(b[0] - a[0], b[1] - a[1]) - 1e-6


def test_world_path_straight_on_open_floor():
    # No shelves/walls → no graph → the path is just the segment (viewer draws it).
    w = build(WarehouseModel())
    assert not w.use_graph
    a, b = (1.0, 1.0), (9.0, 7.0)
    assert w.path(a, b) == [a, b]


def test_run_emits_on_route_travel_keyframes():
    # A real template run: when the layout enables the wall-aware graph, at least one
    # worker travel leg must carry an intermediate (corner) keyframe — proof the
    # picker follows the aisle rather than a straight diagonal. Total time is
    # unchanged (asserted implicitly by the rest of the engine suite).
    from whsim import templates
    from whsim.engine.run import run_once
    m = templates.load_template_model("retail_dc")
    m.simulation.duration_s = 3600.0
    res = run_once(m, replay_window_s=3600.0)
    # Only meaningful when the graph is active (obstacles present).
    world_graphed = build(m).use_graph
    saw_turn = False
    for wk in res.workers:
        run_len = 0
        for kf in wk.keyframes:
            state = kf[3] if len(kf) > 3 else ""
            run_len = run_len + 1 if state == "travel" else 0
            if run_len >= 3:            # start + corner + end on one leg
                saw_turn = True
                break
        if saw_turn:
            break
    if world_graphed and res.workers:
        assert saw_turn
