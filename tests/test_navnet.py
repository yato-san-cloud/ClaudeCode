"""MapMaker-style waypoint navigation network (Delaunay over a free-space graph)."""

import math

from whsim.engine.navnet import NavNetwork
from whsim.schema.model import ShelfArea, WarehouseModel, Zone


def test_builds_delaunay_network_around_a_shelf():
    n = NavNetwork(30, 20, obstacles=[(10, 8, 10, 4)])
    assert len(n.waypoints) >= 8
    assert len(n.edges) > 0
    # no graph edge cuts through the rack
    for (i, j) in n.edges:
        assert n._seg_free(n.waypoints[i], n.waypoints[j])


def test_path_detours_around_obstacle():
    n = NavNetwork(30, 20, obstacles=[(10, 8, 10, 4)])
    a, b = (5, 10), (25, 10)
    assert not n._seg_free(a, b)                  # straight line is blocked
    assert n.distance(a, b) > math.hypot(20, 0)   # nav route is longer (detours)
    assert len(n.path(a, b)) >= 3                  # goes via waypoints


def test_clear_shot_is_direct():
    n = NavNetwork(30, 20, obstacles=[(10, 8, 10, 4)])
    a, b = (5, 2), (25, 2)                         # below the rack, clear
    assert n.path(a, b) == [a, b]


def test_to_dict_and_from_model():
    m = WarehouseModel()
    m.layout.bounds.width, m.layout.bounds.depth = 30, 20
    m.layout.zones = [Zone(id="storage", type="storage", x=0, y=0, w=30, h=20,
                           shelves=[ShelfArea(id="a", x=10, y=8, w=10, h=4)])]
    n = NavNetwork.from_model(m)
    d = n.to_dict()
    assert d["waypoints"] and d["edges"]
    assert all(len(p) == 2 for p in d["waypoints"])
