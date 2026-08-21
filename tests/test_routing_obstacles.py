"""Shelves are routing obstacles: pickers detour down the aisles around racks."""

import math

from whsim.engine.graph import AisleGraph
from whsim.schema.model import ShelfArea, WarehouseModel, Zone


def test_route_detours_around_a_shelf_block():
    g = AisleGraph(30, 20, [], resolution=1.0, obstacle_rects=[(10, 8, 10, 4)])
    assert g.enabled
    a, b = (5, 10), (25, 10)            # straight line crosses the shelf
    straight = math.hypot(b[0] - a[0], b[1] - a[1])
    assert g.distance(a, b) > straight   # forced around it


def test_point_inside_shelf_snaps_to_aisle():
    g = AisleGraph(30, 20, [], resolution=1.0, obstacle_rects=[(10, 8, 10, 4)])
    # a location inside the rack still yields a finite, sensible aisle distance
    d = g.distance((15, 10), (25, 10))
    assert 0 < d < 100


def test_open_floor_unchanged():
    g = AisleGraph(30, 20, [], resolution=1.0)   # no walls, no shelves
    assert not g.enabled                          # callers fall back to Manhattan


def test_from_model_picks_up_shelf_obstacles():
    m = WarehouseModel()
    m.layout.bounds.width, m.layout.bounds.depth = 30, 20
    m.layout.zones = [Zone(id="storage", type="storage", x=0, y=0, w=30, h=20,
                           shelves=[ShelfArea(id="a", x=10, y=8, w=10, h=4, rack_type="pallet")])]
    g = AisleGraph.from_model(m)
    assert g.enabled
    assert g.distance((5, 10), (25, 10)) > 20
