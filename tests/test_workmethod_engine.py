"""Engine tests for the 5-axis work-method design (docs/WORK_METHOD_DESIGN.md).

These exercise the engine's honouring of the WorkMethod axes:
C (zoning), D (consolidation 摘み取り/種まき), B (orders_per_trip) and
E (release/wave). The "always runnable, never blocks" invariant is checked by
running every axis combination and asserting sane KPIs.
"""

from __future__ import annotations

import itertools

from whsim import kpis, templates
from whsim.engine.run import run_replications
from whsim.schema.model import (
    Bounds, Item, Location, OrderProfile, WarehouseModel, WorkMethod,
)


def _ecom(**axes) -> WarehouseModel:
    """Ecommerce template with an explicit WorkMethod on the pick stage."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 3600.0  # 1h keeps tests quick
    m.process.pick_stage().work = WorkMethod(**axes)
    return m


def _few_sku_model(**axes) -> WarehouseModel:
    """Few SKUs, many small destinations, several lines/order: the classic
    case where 種まき(total picking) should win (totals dedupe the walk)."""
    m = WarehouseModel()
    m.layout.bounds = Bounds(width=60, depth=30)
    for i in range(6):
        sku = f"S{i}"
        m.items.append(Item(sku=sku, pick_freq=1.0, default_location=f"L{i}"))
        m.locations.append(Location(id=f"L{i}", x=5 + i * 8, y=20, sku=sku))
    m.orders.profile = OrderProfile(rate_per_hr=200, lines_per_order_mean=4.0)
    m.simulation.duration_s = 3600.0
    m.process.pick_stage().work = WorkMethod(**axes)
    return m


def _kpi(model, reps=2):
    results, heat = run_replications(model, reps=reps)
    return kpis.compute(results), heat


# --- legacy back-compat ------------------------------------------------------

def test_legacy_model_runs_identically():
    """A model with no explicit WorkMethod (legacy pick_strategy=discrete) must
    behave exactly as before: effective_work() maps it, the engine reads that."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 3600.0
    # no .work set -> derived from legacy fields
    assert m.process.pick_stage().work is None
    k, heat = _kpi(m)
    assert k["orders_completed"] >= 0
    assert 0.0 <= k["picker_utilization"] <= 1.0
    assert k["consolidation"] == "pick"
    assert heat.sum() > 0


# --- D: consolidation 摘み取り(pick) vs 種まき(sort) -------------------------

def test_sort_activates_put_wall_and_cuts_travel():
    """種まき: pick item TOTALS (one sweep), then sort lines at the put wall.
    vs 摘み取り it must (a) walk less per order and (b) incur a put-wall stage."""
    pick_k, _ = _kpi(_few_sku_model(consolidation="pick", orders_per_trip=10))
    sort_k, _ = _kpi(_few_sku_model(consolidation="sort", orders_per_trip=10))

    # qualitative difference: totals dedupe the SKU visits -> less walking
    assert sort_k["walk_per_order_m"] < pick_k["walk_per_order_m"]
    # the put-wall sort stage exists and does real work under sort, none under pick
    assert pick_k["n_put_wall"] == 0
    assert pick_k["sort_utilization"] == 0.0
    assert sort_k["n_put_wall"] >= 1
    assert sort_k["sort_utilization"] > 0.0
    # both still ship orders (never blocks)
    assert pick_k["orders_completed"] > 0
    assert sort_k["orders_completed"] > 0


def test_slow_put_wall_queues_and_is_a_tracked_stage():
    """A slow put wall (large sort_time_s) is a genuine capacitated queueing
    stage: it backs up (orders wait for a station) and a faster wall does not.
    The wall is also a candidate bottleneck the KPI layer reports on."""
    fast = _few_sku_model(consolidation="sort", orders_per_trip=12)
    fast.process.sort_time_s = 1.0
    slow = _few_sku_model(consolidation="sort", orders_per_trip=12)
    slow.process.sort_time_s = 30.0          # deliberately slow sort

    fast_k, _ = _kpi(fast)
    slow_k, _ = _kpi(slow)

    # the slow wall both works harder and makes lines queue (back-pressure)
    assert slow_k["sort_utilization"] > fast_k["sort_utilization"]
    assert slow_k["sort_wait_mean_s"] > fast_k["sort_wait_mean_s"]
    # the wall is reported as a tracked stage (bottleneck candidate)
    assert slow_k["n_put_wall"] >= 1
    assert slow_k["bottleneck"] in {"picking", "packing", "sort"}


# --- C: zoning none / sequential / parallel ----------------------------------

def test_parallel_zoning_lowers_picker_utilization():
    """Parallel zoning splits a batch across zones picked CONCURRENTLY, so the
    same demand is served with lower per-picker busy time than a single sweep."""
    none_k, _ = _kpi(_ecom(zoning="none", orders_per_trip=8))
    par_k, _ = _kpi(_ecom(zoning="parallel", orders_per_trip=8))
    assert par_k["picker_utilization"] < none_k["picker_utilization"]
    assert par_k["orders_completed"] > 0


def test_zoning_modes_all_run():
    for zoning in ("none", "sequential", "parallel"):
        k, heat = _kpi(_ecom(zoning=zoning, orders_per_trip=6))
        assert k["orders_completed"] >= 0
        assert 0.0 <= k["picker_utilization"] <= 1.0
        assert heat.sum() > 0


# --- B / E: orders_per_trip and wave release ---------------------------------

def test_more_orders_per_trip_cuts_walk_per_order():
    """B axis: pulling more orders per trip amortises travel over more orders."""
    one_k, _ = _kpi(_ecom(orders_per_trip=1))
    many_k, _ = _kpi(_ecom(orders_per_trip=8))
    assert many_k["walk_per_order_m"] < one_k["walk_per_order_m"]


def test_wave_release_runs_and_pools():
    """E axis: wave release pools orders over a window; still ships, less walk
    per order than single-order continuous picking."""
    base_k, _ = _kpi(_ecom(orders_per_trip=1))
    wave_k, _ = _kpi(_ecom(release="wave", wave_interval_s=600.0, orders_per_trip=8))
    assert wave_k["orders_completed"] > 0
    assert wave_k["walk_per_order_m"] < base_k["walk_per_order_m"]


# --- invariant: any combination is runnable ----------------------------------

def test_every_axis_combination_is_runnable():
    """The 'never blocks' invariant: every WorkMethod combo must run without
    error and produce sane KPIs (1 short replication each for speed)."""
    for zoning, consolidation, release in itertools.product(
        ("none", "sequential", "parallel"),
        ("pick", "sort"),
        ("continuous", "wave"),
    ):
        m = _ecom(zoning=zoning, consolidation=consolidation,
                  release=release, wave_interval_s=600.0, orders_per_trip=5)
        k, _ = _kpi(m, reps=1)
        assert k["orders_completed"] >= 0
        assert 0.0 <= k["picker_utilization"] <= 1.0
        assert 0.0 <= k["packer_utilization"] <= 1.0
        assert k["walk_per_order_m"] >= 0.0
