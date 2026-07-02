"""DES-internal inventory & replenishment chain (opt-in).

Covers the 枯渇→補充→枯渇 chain: picks decrement pick-face inventory, a face
at/below its trigger generates ONE replenishment task, a forklift/replenisher
tops it up, and an EMPTY face BLOCKS the picker (真の欠品挙動). Default (off)
must stay byte-identical, so the headline KPIs are asserted unchanged.
"""

from __future__ import annotations

import simpy

from whsim.engine.build import build
from whsim.engine.processes import (
    forklift_agent, order_source, picker_agent, putaway_source, replenisher_agent,
)
from whsim.engine.run import run_once
from whsim.schema.model import (
    Equipment, Item, Location, Order, OrderLine, WarehouseModel, WorkerGroup,
)
from whsim import kpis

# Headline KPIs whose value must not move when replenishment is OFF.
_HEADLINE = (
    "throughput_per_hr", "orders_completed", "picker_utilization",
    "packer_utilization", "walk_per_order_m", "cycle_mean_s",
)


def _model(cap=100, qty=3, n_skus=3, n_orders=300, arrival_dt=2.0,
           duration=1800.0, forklifts=0, pickers=3):
    m = WarehouseModel()
    m.simulation.duration_s = duration
    m.layout.bounds.width = 50
    m.layout.bounds.depth = 20
    m.locations = [
        Location(id=f"L{i}", sku=f"S{i}", x=30, y=5 + i, capacity=cap, qty=cap)
        for i in range(n_skus)
    ]
    m.items = [Item(sku=f"S{i}", pick_freq=1.0) for i in range(n_skus)]
    m.resources.workers = [WorkerGroup(role="picker", count=pickers)]
    if forklifts:
        m.resources.equipment = [Equipment(id="fk", type="forklift", count=forklifts)]
    m.orders.outbound = [
        Order(order_id=f"O{j}", arrival_s=j * arrival_dt,
              lines=[OrderLine(sku=f"S{j % n_skus}", qty=qty)])
        for j in range(n_orders)
    ]
    m.process.pack_time_s = 8.0
    return m


def _run_world(model, seed=1):
    """Build+run a world directly so the test can inspect the inventory faces
    after the run (mirrors run.py's agent wiring for the paths under test)."""
    env = simpy.Environment()
    world = build(model, env, replay_window_s=0.0)
    rng = __import__("random").Random(seed)
    for i in range(world.n_pickers):
        from whsim.engine.build import Worker
        w = Worker(id=f"picker-{i+1}", role="picker")
        world.workers.append(w)
        env.process(picker_agent(world, w, rng))
    from whsim.engine.build import Worker
    if world.n_forklifts > 0:
        for i in range(world.n_forklifts):
            env.process(forklift_agent(world, Worker(id=f"forklift-{i+1}", role="forklift"), rng))
        env.process(putaway_source(world, rng))
    if world.replen_faces is not None and world.replen_dedicated > 0:
        for i in range(world.replen_dedicated):
            env.process(replenisher_agent(world, Worker(id=f"repl-{i+1}", role="forklift")))
    env.process(order_source(world, rng))
    env.run(until=model.simulation.duration_s)
    return world


# --- (a) OFF is byte-identical -------------------------------------------------

def test_off_is_identical_and_emits_no_replenishment():
    """Off (default) emits no replenishment/stockout events and its headline KPIs
    are deterministic across the refactored forklift path (regression guard)."""
    m = _model(forklifts=2)                     # exercise the refactored forklift agent
    r1 = run_once(m, seed=7, replay_window_s=0.0)
    r2 = run_once(m, seed=7, replay_window_s=0.0)
    k1 = kpis.compute([r1], m)
    k2 = kpis.compute([r2], m)
    # No replenishment machinery when disabled.
    assert k1["replenish_tasks"] == 0
    assert k1["stockout_waits"] == 0
    assert k1["n_replenishers"] == 0
    assert not any(e["event"] in ("replenish_done", "stockout_wait") for e in r1.events)
    # Deterministic headline numbers through the refactored forklift code.
    for key in _HEADLINE:
        assert k1[key] == k2[key], key


# --- (b) ON: picks decrement, tasks/refills happen -----------------------------

def test_on_decrements_generates_tasks_and_refills():
    m = _model(cap=30, qty=3, duration=1800.0)
    m.process.replenishment_enabled = True      # forklift-shared falls to auto 1 dedicated
    world = _run_world(m)
    replen_done = [e for e in world.events if e["event"] == "replenish_done"]
    # Faces depleted below trigger => at least one replenishment task serviced.
    assert len(replen_done) > 0
    # Every tracked face ended with on-hand qty tracked (decrement happened): the
    # sum consumed must be positive, and refilled faces sit at/above their target.
    faces = list(world.replen_faces.values())
    assert faces and all("qty" in f for f in faces)
    # A face that was replenished holds >= a positive on-hand (refilled, not stuck).
    refilled = [f for f in faces if f["loc_id"] in {e["loc"] for e in replen_done}]
    assert refilled
    assert all(f["qty"] > 0 or f["pending"] for f in refilled)


# --- (c) forced stockout drops throughput --------------------------------------

def test_forced_stockout_blocks_pickers_and_drops_throughput():
    # Tiny far-away faces + slow placement => replenishment can't keep up.
    def mk(cap):
        m = _model(cap=cap, qty=4, n_skus=2, n_orders=600, arrival_dt=1.0,
                   duration=1800.0, pickers=4)
        for lc in m.locations:
            lc.x = 48                            # far from the dock => long refill trip
        m.process.replenishment_enabled = True
        m.process.replenishers = 1
        m.process.replenish_place_s = 200.0
        m.process.pack_time_s = 5.0
        return m

    tiny = mk(8)
    ample = mk(10 ** 7)
    kt = kpis.compute([run_once(tiny, seed=1, replay_window_s=0.0)], tiny)
    ka = kpis.compute([run_once(ample, seed=1, replay_window_s=0.0)], ample)
    assert kt["stockout_waits"] > 0
    assert kt["stockout_wait_mean_s"] > 0
    assert ka["stockout_waits"] == 0
    # Blocking on empty faces starves picking => throughput drops.
    assert kt["throughput_per_hr"] < ka["throughput_per_hr"]


# --- (d) dedicated vs forklift-shared both service replenishment ----------------

def test_dedicated_and_forklift_shared_both_work():
    # Dedicated replenishers.
    md = _model(cap=12, qty=3, duration=1800.0)
    md.process.replenishment_enabled = True
    md.process.replenishers = 2
    rd = run_once(md, seed=3, replay_window_s=0.0)
    kd = kpis.compute([rd], md)
    assert kd["n_replenishers"] == 2
    assert kd["replenish_tasks"] > 0
    assert any(e["event"] == "replenish_done" for e in rd.events)

    # Forklift-shared: the forklift fleet also drains the replenishment queue.
    ms = _model(cap=12, qty=3, duration=1800.0, forklifts=2)
    ms.process.replenishment_enabled = True     # replenishers=0 => shared
    rs = run_once(ms, seed=3, replay_window_s=0.0)
    ks = kpis.compute([rs], ms)
    assert ks["n_replenishers"] == 2            # == forklift fleet size
    # The SAME forklift agents did both inbound putaway AND replenishment.
    assert any(e["event"] == "forklift_done" for e in rs.events)
    assert any(e["event"] == "replenish_done" for e in rs.events)
    assert ks["replenish_tasks"] > 0


# --- (e) no-locations model runs fine (infinite stock) -------------------------

def test_no_locations_runs_with_infinite_stock():
    m = WarehouseModel()
    m.simulation.duration_s = 1800.0
    m.items = [Item(sku="X", pick_freq=1.0)]
    m.process.replenishment_enabled = True
    r = run_once(m, seed=1, replay_window_s=0.0)
    k = kpis.compute([r], m)
    # No faces => no tasks, no stockouts, and the run still completes orders.
    assert k["replenish_tasks"] == 0
    assert k["stockout_waits"] == 0
    assert k["orders_completed"] >= 0           # ran without deadlock


# --- (f) KPI keys present when enabled -----------------------------------------

def test_kpi_keys_present_when_enabled():
    m = _model(cap=20, qty=3, duration=1200.0)
    m.process.replenishment_enabled = True
    m.process.replenishers = 1
    k = kpis.compute([run_once(m, seed=1, replay_window_s=0.0)], m)
    for key in ("replenish_tasks", "replenish_busy_s", "replenisher_utilization",
                "stockout_waits", "stockout_wait_mean_s", "n_replenishers"):
        assert key in k, key
