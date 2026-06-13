"""Slotting OPTIMIZATION + STORAGE STRATEGY (analytic, no sim)."""
import random

from whsim import slotting, slottingopt, storagestrategy, templates
from whsim.schema.model import Item, Location, Station, WarehouseModel


def _randomize_slotting(m: WarehouseModel, seed: int = 1) -> float:
    """Peg every SKU to a random storage slot; return the weighted distance."""
    storage = [loc for loc in m.locations if loc.zone == "storage"]
    rnd = random.Random(seed)
    shuffled = storage[:]
    rnd.shuffle(shuffled)
    for loc in m.locations:
        loc.sku = None
    for it in m.items:
        it.default_location = None
    for loc, it in zip(shuffled, list(m.items)):
        loc.sku = it.sku
        it.default_location = loc.id
    return slottingopt.weighted_distance(m)


def test_optimizer_reduces_weighted_distance_vs_random():
    m = templates.load_template_model("retail_dc")
    before_random = _randomize_slotting(m)
    plan = slottingopt.optimize(m)
    # the greedy optimiser must beat a random assignment, and AFTER < BEFORE.
    assert plan.after < before_random
    assert plan.after <= plan.before
    assert plan.reduction_pct > 0.05  # a meaningful win on a real DC layout


def test_optimizer_puts_fastest_sku_at_nearest_slot():
    m = WarehouseModel()
    m.resources.stations = [Station(id="pack", x=0.0, y=0.0, count=1)]
    m.locations = [
        Location(id="near", zone="storage", x=1.0, y=0.0, capacity=100),
        Location(id="far", zone="storage", x=50.0, y=0.0, capacity=100),
    ]
    m.items = [
        Item(sku="FAST", pick_freq=0.9, case_qty=1, default_location="far"),
        Item(sku="SLOW", pick_freq=0.1, case_qty=1, default_location="near"),
    ]
    plan = slottingopt.optimize(m)
    assert plan.assignment["near"] == "FAST"
    assert plan.assignment["far"] == "SLOW"
    assert plan.after < plan.before  # the swap shortens weighted travel


def test_apply_writes_default_location_and_loc_sku():
    m = templates.load_template_model("ecommerce_small")
    _randomize_slotting(m)
    plan = slottingopt.optimize(m)
    placed = slottingopt.apply_plan(m, plan)
    assert placed == plan.placed > 0
    # every slotted location points back to its assigned SKU and vice-versa.
    for lid, sku in plan.assignment.items():
        loc = next(loc for loc in m.locations if loc.id == lid)
        assert loc.sku == sku
        it = next(it for it in m.items if it.sku == sku)
        assert it.default_location == lid
    # after apply, the live weighted distance matches the plan's AFTER.
    assert abs(slottingopt.weighted_distance(m) - plan.after) < 1e-6


def test_assign_inventory_optimize_strategy_reports_reduction():
    m = templates.load_template_model("retail_dc")
    _randomize_slotting(m)
    s = slotting.assign_inventory(m, strategy="optimize")
    assert s["strategy"] == "optimize"
    assert s["assigned"] > 0
    assert s["after_weighted_distance"] <= s["before_weighted_distance"]
    assert s["reduction_pct"] >= 0.0


def test_strategy_fast_small_is_reserve_active_slow_bulky_is_free():
    m = WarehouseModel()
    m.items = [
        Item(sku="FAST", pick_freq=0.7, case_qty=1),     # fast + small
        Item(sku="BULK", pick_freq=0.25, case_qty=48),   # slower + bulky
        Item(sku="TAIL", pick_freq=0.05, case_qty=4),    # long tail
    ]
    s = storagestrategy.recommend(m)
    assert s["available"]
    modes = {r["sku"]: r["mode"] for r in s["skus"]}
    assert modes["FAST"] == "reserve_active"   # golden zone pays for its 補充
    assert modes["BULK"] == "free"             # bulky → density beats walk
    assert s["recommended_mode"] == "reserve_active"
    # replenishment estimate for the fixed head is positive and finite.
    assert s["replenishment"]["moves_per_day"] > 0


def test_strategy_never_blocks_on_empty_model():
    m = WarehouseModel()
    m.items = []
    s = storagestrategy.recommend(m)
    assert s["available"] is False
    assert s["recommended_mode"] == "free"


def test_optimize_is_deterministic():
    m1 = templates.load_template_model("retail_dc")
    m2 = templates.load_template_model("retail_dc")
    p1 = slottingopt.optimize(m1)
    p2 = slottingopt.optimize(m2)
    assert p1.assignment == p2.assignment
    assert p1.after == p2.after
