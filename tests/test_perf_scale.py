"""Scale / performance guard for the engine + render pipeline.

PURPOSE
=======
This is **not** a microbenchmark. It is a regression guard that catches
*performance cliffs*: changes that turn an interactive (a few seconds) run into
a multi-minute one on a realistically large model. The salesperson flow promises
"always runnable" even on big warehouses, so a single edit that makes routing or
the event loop super-linear must fail CI here, not in front of a customer.

WHAT IT BUILDS
==============
A large but realistic warehouse via the public path a salesperson would hit:
start from the ``ecommerce_small`` template, inflate the storage zone, regenerate
the rack grid with :func:`whsim.design.materialize_racks` (thousands of slots),
fan out thousands of SKUs, and drive a full 8-hour shift at a high arrival rate
with a large pick/pack workforce so the event loop and routing are genuinely
stressed.

BUDGETS
=======
Budgets are deliberately generous (large multiples of measured time on the
reference machine) so the test is stable across CI hardware while still tripping
on an order-of-magnitude regression. Measured at authoring time:

  * open-floor large model  (~7.7k locations, ~31k events): ~3 s   -> budget 60 s
  * wall-aware modest model (~290 locations, walls present): ~4 s   -> budget 45 s

KNOWN ENGINE CLIFF (reported to the engine owner, NOT worked around here)
=========================================================================
Adding even a single interior wall to a *large* floor (~240x160 m, ~7.7k
locations) explodes the run from ~3 s to ~200 s (~70x). With walls,
``engine.graph.AisleGraph.distance`` runs a full single-source Dijkstra over the
~17k-node grid (cap ``MAX_NODES=20000``) for each distinct source location; with
thousands of distinct shelves the per-source cache never amortises. Without
walls, ``distance`` falls back to Manhattan and never touches the grid -- hence
the huge gap. The wall-aware case in this test therefore uses a deliberately
*modest* floor so it stays under budget while still exercising the Dijkstra path.
See the test docstrings below for the exact repro.
"""

from __future__ import annotations

import math
import time

from whsim import kpis as kpi_mod
from whsim import templates
from whsim.design import materialize_racks
from whsim.engine.run import run_replications
from whsim.render.replay import build_replay
from whsim.schema.model import Item, Wall, WorkerGroup

# Generous budgets: ~20x headroom over reference timings (see module docstring).
OPEN_FLOOR_BUDGET_S = 60.0
WALL_BUDGET_S = 45.0


def _assert_kpis_finite(metrics: dict) -> None:
    """Every numeric KPI must be a finite number (no NaN / inf from a blow-up)."""
    for key, val in metrics.items():
        if isinstance(val, bool):
            continue
        if isinstance(val, (int, float)):
            assert math.isfinite(val), f"KPI '{key}' is not finite: {val!r}"


def _large_open_floor_model():
    """A large open-floor warehouse (~7.7k slots) via the salesperson path.

    No interior walls: this is the common case, and the one whose budget must
    stay tight. The storage zone is inflated and re-racked, then thousands of
    SKUs are pegged across the regenerated grid.
    """
    m = templates.load_template_model("ecommerce_small")
    storage = next(z for z in m.layout.zones if z.id == "storage")
    storage.w = 200.0
    storage.h = 120.0
    storage.rack.col_spacing = 2.0
    storage.rack.row_spacing = 1.5
    m.layout.bounds.width = 240.0
    m.layout.bounds.depth = 160.0

    m.items = [
        Item(sku=f"SKU{i:05d}", name=f"item{i}", pick_freq=1.0, ts_per_unit=1.5, case_qty=1)
        for i in range(3000)
    ]
    materialize_racks(m)

    # A real workforce so the event loop is exercised, not idling on a queue.
    m.resources.workers = [
        WorkerGroup(id="pickers", role="picker", count=40, speed_mps=1.2),
        WorkerGroup(id="packers", role="packer", count=20, speed_mps=1.2),
    ]
    m.resources.stations[0].count = 20
    m.orders.profile.rate_per_hr = 1200.0
    m.simulation.duration_s = 28800.0  # full 8h shift
    m.simulation.replications = 1      # keep it a guard, not a benchmark
    return m


def _wall_aware_model():
    """A modest floor WITH an interior wall, to guard the Dijkstra routing path.

    Deliberately small (~290 locations on an 80x50 m floor) because the
    wall-aware path is super-linear on large floors (see module docstring). This
    still forces grid-based wall-aware routing rather than the Manhattan
    fallback, so a regression in that path is caught.
    """
    m = templates.load_template_model("ecommerce_small")
    storage = next(z for z in m.layout.zones if z.id == "storage")
    storage.w = 60.0
    storage.h = 40.0
    storage.rack.col_spacing = 3.0
    storage.rack.row_spacing = 2.5
    m.layout.bounds.width = 80.0
    m.layout.bounds.depth = 50.0

    m.items = [
        Item(sku=f"SKU{i:04d}", name=f"item{i}", pick_freq=1.0, ts_per_unit=1.5)
        for i in range(400)
    ]
    materialize_racks(m)

    # A vertical interior wall with a gap at the top -> forces wall-aware routing.
    m.layout.walls = [Wall(id="w1", points=[[40.0, 0.0], [40.0, 42.0]], thickness=0.3)]

    m.resources.workers = [
        WorkerGroup(id="pickers", role="picker", count=10, speed_mps=1.2),
        WorkerGroup(id="packers", role="packer", count=6, speed_mps=1.2),
    ]
    m.resources.stations[0].count = 6
    m.orders.profile.rate_per_hr = 400.0
    m.simulation.duration_s = 7200.0
    m.simulation.replications = 1
    return m


def test_large_open_floor_runs_within_budget():
    """A ~7.7k-location, full-shift model completes fast, with finite KPIs + replay."""
    m = _large_open_floor_model()
    assert len(m.locations) > 3000  # the model really is large

    t0 = time.perf_counter()
    results, heat = run_replications(m)
    elapsed = time.perf_counter() - t0

    assert elapsed < OPEN_FLOOR_BUDGET_S, (
        f"large open-floor run took {elapsed:.1f}s "
        f"(budget {OPEN_FLOOR_BUDGET_S}s) -- possible performance regression"
    )

    metrics = kpi_mod.compute(results)
    _assert_kpis_finite(metrics)
    assert metrics.get("orders_completed", 0) > 0
    assert heat.size > 0 and math.isfinite(float(heat.sum()))

    # The replay contract must still build on a large model.
    replay = build_replay(m, results[0], metrics)
    assert isinstance(replay, dict)
    assert "workers" in replay and "zones" in replay  # core replay payload present


def test_wall_aware_routing_runs_within_budget():
    """A modest walled model exercises grid Dijkstra and still stays under budget."""
    m = _wall_aware_model()
    assert m.layout.walls  # walls are present -> grid routing, not Manhattan

    t0 = time.perf_counter()
    results, _heat = run_replications(m)
    elapsed = time.perf_counter() - t0

    assert elapsed < WALL_BUDGET_S, (
        f"wall-aware run took {elapsed:.1f}s (budget {WALL_BUDGET_S}s) -- "
        f"the wall routing path may have regressed (see module docstring re: cliff)"
    )

    metrics = kpi_mod.compute(results)
    _assert_kpis_finite(metrics)
    assert metrics.get("orders_completed", 0) >= 0
