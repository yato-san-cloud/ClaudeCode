"""Location 棚番号 (address) + 段 (level): materialize_racks emits one location
per rack level, each with a deterministic, unique, stable structured address."""

import re

from whsim import racktypes, templates
from whsim.design import materialize_racks
from whsim.schema.model import Bounds, Layout, ShelfArea, WarehouseModel, Zone

ADDR_RE = re.compile(r"^[A-Z]+\d{2}-\d{2}-\d+(#\d+)?$")


def _native_shelf_model(rack_type="pallet"):
    """A blank floor with ONE natively-placed (un-named) storage shelf."""
    z = Zone(id="storage", type="storage", x=0, y=0, w=20, h=20,
             shelves=[ShelfArea(id="s0", name="", x=2, y=2, w=2, h=12,
                                rack_type=rack_type)])
    return WarehouseModel(layout=Layout(bounds=Bounds(width=30, depth=30), zones=[z]))


def test_addresses_are_unique_and_well_formed():
    m = templates.load_template_model("ecommerce_small")
    materialize_racks(m)
    addrs = [loc.address for loc in m.locations]
    assert all(a for a in addrs), "every location gets a non-empty 棚番号"
    assert len(set(addrs)) == len(addrs), "addresses are unique"
    assert all(ADDR_RE.match(a) for a in addrs), "addresses match 通路-連-段"


def test_natively_placed_shelf_gets_addresses():
    """The user's point: a shelf placed in ③設計 (no MapMaker name) STILL gets
    a structured 棚番号 on every location."""
    m = _native_shelf_model()
    materialize_racks(m)
    assert m.locations, "a placed shelf materialises locations"
    assert all(loc.address for loc in m.locations)
    assert len({loc.address for loc in m.locations}) == len(m.locations)


def test_locations_per_xy_equal_rack_levels():
    """Each (x,y) bay expands into exactly rack_type['levels'] stacked locations."""
    for rtid in ("pallet", "medium", "flow", "hanger"):
        m = _native_shelf_model(rtid)
        materialize_racks(m)
        levels = racktypes.get(rtid)["levels"]
        by_xy: dict[tuple[float, float], list[int]] = {}
        for loc in m.locations:
            by_xy.setdefault((loc.x, loc.y), []).append(loc.level)
        for xy, lvls in by_xy.items():
            assert len(lvls) == levels, f"{rtid} bay {xy}: {len(lvls)} != {levels}"
            assert sorted(lvls) == list(range(1, levels + 1))


def test_capacity_divided_across_levels():
    m = _native_shelf_model("pallet")
    materialize_racks(m)
    rt = racktypes.get("pallet")
    per_level = max(1, rt["capacity"] // rt["levels"])
    assert all(loc.capacity == per_level for loc in m.locations)


def test_addresses_stable_across_rematerialize():
    """Re-running materialize_racks on the same layout reproduces the exact same
    address for the same (x,y,level) — the slotting/pick-sequence sort key is
    durable."""
    m = templates.load_template_model("ecommerce_small")
    materialize_racks(m)
    first = {(loc.x, loc.y, loc.level): loc.address for loc in m.locations}
    materialize_racks(m)
    second = {(loc.x, loc.y, loc.level): loc.address for loc in m.locations}
    assert first == second


def test_authored_name_propagates_but_address_still_assigned():
    """A MapMaker-named shelf keeps its name in .name AND gets a structured
    address on every location."""
    z = Zone(id="storage", type="storage", x=0, y=0, w=20, h=20,
             shelves=[ShelfArea(id="s0", name="100-01", x=2, y=2, w=2, h=12,
                                rack_type="medium")])
    m = WarehouseModel(layout=Layout(bounds=Bounds(width=30, depth=30), zones=[z]))
    materialize_racks(m)
    assert any(loc.name.startswith("100-01") for loc in m.locations)
    assert all(loc.address for loc in m.locations)
