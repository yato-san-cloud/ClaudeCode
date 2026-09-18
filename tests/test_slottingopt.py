"""Slotting OPTIMIZATION + STORAGE STRATEGY (analytic, no sim)."""
import random

from whsim import slotting, slottingopt, storagestrategy, templates
from whsim.schema.model import (
    Item,
    Location,
    Order,
    OrderLine,
    Station,
    WarehouseModel,
)


def manhattan(a, b):
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def _line_model(n_slots: int = 8) -> WarehouseModel:
    """A one-aisle model: pack at x=0, slots at x=1..n along y=0."""
    m = WarehouseModel()
    m.resources.stations = [Station(id="pack", x=0.0, y=0.0, count=1)]
    m.locations = [
        Location(id=f"L{i}", zone="storage", x=float(i), y=0.0, capacity=100)
        for i in range(1, n_slots + 1)
    ]
    return m


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


# --- 併買アフィニティ + 季節性 -------------------------------------------------


def test_affinity_weight_zero_is_identical_to_legacy():
    """(a) affinity_weight=0 reproduces the historical assignment byte-for-byte,
    even when outbound orders exist (co-picks are learned but never applied)."""
    m = templates.load_template_model("retail_dc")
    # give it real co-picks so the matrix is non-empty
    skus = [it.sku for it in m.items[:20] if it.sku]
    m.orders.outbound = [
        Order(order_id=f"O{i}", lines=[OrderLine(sku=skus[i % len(skus)], qty=1),
                                       OrderLine(sku=skus[(i + 1) % len(skus)], qty=1)])
        for i in range(50)
    ]
    _randomize_slotting(m)
    legacy = slottingopt.optimize(m)                       # no affinity arg
    zero = slottingopt.optimize(m, affinity_weight=0.0)    # explicit 0
    assert zero.pairs_considered > 0                       # matrix WAS built
    assert zero.assignment == legacy.assignment            # ...but not applied
    assert zero.after == legacy.after
    assert zero.moves == legacy.moves


def _pair_model():
    """A + B always co-ordered; A is fast (grabs a near slot), B is slow (would
    otherwise be exiled far away). Filler C/D occupy the middle so B lands far in
    the legacy pegging."""
    m = _line_model(6)
    m.items = [
        Item(sku="A", pick_freq=0.90, case_qty=1),
        Item(sku="C", pick_freq=0.50, case_qty=1),
        Item(sku="D", pick_freq=0.40, case_qty=1),
        Item(sku="E", pick_freq=0.30, case_qty=1),
        Item(sku="B", pick_freq=0.02, case_qty=1),  # slow → far under COI
    ]
    m.orders.outbound = [
        Order(order_id=f"O{i}", lines=[OrderLine(sku="A", qty=1), OrderLine(sku="B", qty=1)])
        for i in range(30)
    ]
    return m


def _slot_of(plan, sku, model):
    lid = next(lid for lid, s in plan.assignment.items() if s == sku)
    loc = next(loc for loc in model.locations if loc.id == lid)
    return (loc.x, loc.y)


def test_affinity_pulls_copicked_pair_closer():
    """(b) a strong co-picked pair (A,B) sits closer with weight>0 than weight=0."""
    m = _pair_model()
    p0 = slottingopt.optimize(m, affinity_weight=0.0)
    p1 = slottingopt.optimize(m, affinity_weight=0.8)
    d0 = manhattan(_slot_of(p0, "A", m), _slot_of(p0, "B", m))
    d1 = manhattan(_slot_of(p1, "A", m), _slot_of(p1, "B", m))
    assert d1 < d0  # the pull shortens the A↔B walk


def test_affinity_reports_tour_delta():
    """(c) the estimated co-pick tour delta is reported and improves with affinity."""
    m = _pair_model()
    p0 = slottingopt.optimize(m, affinity_weight=0.0)
    p1 = slottingopt.optimize(m, affinity_weight=0.8)
    rep = slottingopt.affinity_report(m, 0.8, baseline=p0, plan=p1)
    assert rep["available"] is True
    assert rep["pairs_considered"] >= 1
    assert rep["tour_delta_est"] > 0  # affinity cuts inter-pick travel
    assert rep["tour_after_est"] < rep["tour_before_est"]


def test_affinity_unavailable_without_orders():
    """No outbound orders → affinity simply reports unavailable, never crashes."""
    m = _pair_model()
    m.orders.outbound = []
    p = slottingopt.optimize(m, affinity_weight=0.8)
    assert p.pairs_considered == 0
    rep = slottingopt.affinity_report(m, 0.8)
    assert rep["available"] is False


def test_seasonality_flags_a_shifting_sku():
    """(d) a SKU whose volume collapses month1→month2 is flagged (A→C)."""
    records = []
    # month 2026-01: HOT dominates (class A), others tiny
    records += [("2026-01", "HOT", 1000)]
    records += [("2026-01", s, 5) for s in ("X1", "X2", "X3", "X4")]
    # month 2026-02: HOT collapses, the Xs carry the volume
    records += [("2026-02", "HOT", 2)]
    records += [("2026-02", s, 400) for s in ("X1", "X2", "X3", "X4")]
    out = slottingopt.seasonality(records)
    assert out["available"] is True
    assert out["months_observed"] == 2
    flagged = {r["sku"]: r for r in out["rows"]}
    assert "HOT" in flagged
    assert flagged["HOT"]["old_class"] == "A"
    assert flagged["HOT"]["new_class"] == "C"
    assert flagged["HOT"]["direction"] == "down"
    assert len(flagged["HOT"]["trend"]) == 2


def test_seasonality_unavailable_without_dates():
    """(e) fewer than two dated months → unavailable, never crashes."""
    one = slottingopt.seasonality([("2026-01", "A", 10), ("2026-01", "B", 5)])
    assert one["available"] is False
    assert one["months_observed"] == 1
    # entirely empty / dateless input is also safe
    none = slottingopt.seasonality([])
    assert none["available"] is False
    assert none["rows"] == []
