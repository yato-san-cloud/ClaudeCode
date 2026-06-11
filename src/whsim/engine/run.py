"""Run the simulation: one replication, or several aggregated."""

from __future__ import annotations

import random
from dataclasses import dataclass, field

import numpy as np
import simpy

from whsim.engine.build import Worker, build
from whsim.engine.processes import (
    agv_agent, forklift_agent, inspector_agent, order_source, packer_agent,
    picker_agent, putaway_source,
)
from whsim.schema.model import WarehouseModel

# Keep the animated replay short enough to stay smooth in the browser, even when
# the KPI run covers a full shift.
DEFAULT_REPLAY_WINDOW_S = 900.0


@dataclass
class RunResult:
    events: list[dict]
    heat: np.ndarray
    n_pickers: int
    n_packers: int
    duration_s: float
    n_agvs: int = 0
    n_put_wall: int = 0                     # 種まき put-wall stations (consolidation=="sort")
    consolidation: str = "pick"
    pick_method: str = "manual"
    workers: list[Worker] = field(default_factory=list)
    helpers: list[Worker] = field(default_factory=list)  # parallel-zone sub-tracks (replay)
    agvs: list[Worker] = field(default_factory=list)
    forklifts: list[Worker] = field(default_factory=list)
    packers: list[Worker] = field(default_factory=list)  # dedicated packer agents (staging mode)
    inspectors: list[Worker] = field(default_factory=list)  # 入荷検品 agents
    n_inspectors: int = 0
    staging_capacity: int = 0               # 仮置き buffer capacity (0 = disabled)
    replay_window_s: float = 0.0
    cost: dict = field(default_factory=dict)


def representative_day(model: WarehouseModel) -> WarehouseModel:
    """Pick one representative day to simulate when imported demand spans many days.

    The real-calendar ETL (``analysis.ingest``) anchors each order's ``arrival_s``
    to a Monday-00:00 offset so the BI views keep the true weekday/hour. That pushes
    every order past the default 8h window (first activity lands at ~08:00 = 28800s),
    so the engine would otherwise replay an empty pre-dawn window and process ZERO
    orders. Here we isolate the busiest single day (the sizing-relevant peak),
    re-base it so its first order starts at t=0, and size the window to that day's
    active span plus a drain tail — so utilisation/KPIs reflect a real working day
    instead of being diluted across nights and weekends. The saved multi-day orders
    are untouched (this returns a copy); profile / single-day demand passes through.
    """
    orders = model.orders.outbound
    if len(orders) < 2:
        return model
    days: dict[int, list] = {}
    for o in orders:
        days.setdefault(int((o.arrival_s or 0.0) // 86400), []).append(o)
    if len(days) < 2:
        return model  # already a single day — honour the authored window
    best = max(days, key=lambda d: (len(days[d]), -d))  # busiest; ties → earliest
    day_orders = days[best]
    first = min(o.arrival_s or 0.0 for o in day_orders)
    last = max(o.arrival_s or 0.0 for o in day_orders)
    m = model.model_copy(deep=True)
    rebased = []
    for o in day_orders:
        oo = o.model_copy(deep=True)
        oo.arrival_s = max(0.0, (o.arrival_s or 0.0) - first)
        rebased.append(oo)
    rebased.sort(key=lambda x: x.arrival_s)
    m.orders.outbound = rebased
    # Active span + a 2h drain tail so the last orders can complete; floored so a
    # degenerate (near-instant) day still produces a sane window.
    m.simulation.duration_s = max(3600.0, (last - first) + 2 * 3600.0)
    return m


def run_once(
    model: WarehouseModel,
    seed: int | None = None,
    replay_window_s: float | None = None,
) -> RunResult:
    model = representative_day(model)
    rng = random.Random(model.simulation.random_seed if seed is None else seed)
    env = simpy.Environment()
    window = DEFAULT_REPLAY_WINDOW_S if replay_window_s is None else replay_window_s
    window = min(window, model.simulation.duration_s)
    world = build(model, env, replay_window_s=window)

    for i in range(world.n_pickers):
        w = Worker(id=f"picker-{i+1}", role="picker")
        world.workers.append(w)
        env.process(picker_agent(world, w, rng))
    agvs: list[Worker] = []
    if world.pick_method == "agv":
        for i in range(world.n_agvs):
            a = Worker(id=f"agv-{i+1}", role="agv")
            agvs.append(a)
            env.process(agv_agent(world, a))
    forklifts: list[Worker] = []
    if world.n_forklifts > 0:
        for i in range(world.n_forklifts):
            fk = Worker(id=f"forklift-{i+1}", role="forklift")
            forklifts.append(fk)
            env.process(forklift_agent(world, fk, rng))
        env.process(putaway_source(world, rng))
    # Dedicated 入荷検品 agents inspect each inbound receipt before putaway.
    inspectors: list[Worker] = []
    if world.inbound_store is not None:
        for i in range(world.n_inspectors):
            ins = Worker(id=f"inspector-{i+1}", role="inspector")
            inspectors.append(ins)
            env.process(inspector_agent(world, ins, world.fork_home))
    # Dedicated packer agents drain the 仮置き(staging) buffer (manual staged mode).
    packers: list[Worker] = []
    if world.staging is not None and world.pick_method != "agv":
        for i in range(max(1, world.n_packers)):
            pk = Worker(id=f"packer-{i+1}", role="packer")
            packers.append(pk)
            env.process(packer_agent(world, pk, world.pack_xy[i % len(world.pack_xy)]))
    env.process(order_source(world, rng))

    env.run(until=model.simulation.duration_s)
    return RunResult(
        events=world.events, heat=world.heat,
        n_pickers=world.n_pickers, n_packers=world.n_packers,
        duration_s=model.simulation.duration_s,
        n_agvs=world.n_agvs,
        n_put_wall=(world.put_wall.capacity if world.consolidation == "sort" else 0),
        consolidation=world.consolidation, pick_method=world.pick_method,
        workers=world.workers, helpers=world.helpers, agvs=agvs, forklifts=forklifts,
        packers=packers, inspectors=inspectors, n_inspectors=world.n_inspectors,
        staging_capacity=world.staging_capacity,
        replay_window_s=window, cost=_cost_inputs(model),
    )


def _cost_inputs(model: WarehouseModel) -> dict:
    """Pack the cost parameters the KPI layer needs (kept out of the engine loop)."""
    rate = (model.resources.workers[0].labour_rate_per_hr
            if model.resources.workers else 0.0)
    agvs = [e for e in model.resources.equipment if e.type in ("agv", "asrs")]
    return {
        "labour_rate_per_hr": rate,
        "capex_total": sum(e.capex_each * e.count for e in agvs),
        "opex_per_hr_total": sum(e.opex_per_hr * e.count for e in agvs),
        "amortize_months": model.simulation.amortize_capex_months,
        "work_days_per_month": model.simulation.work_days_per_month,
        "shift_hours_per_day": model.simulation.shift_hours_per_day,
        "currency": model.simulation.currency,
    }


def run_replications(
    model: WarehouseModel, reps: int | None = None
) -> tuple[list[RunResult], np.ndarray]:
    """Monte-Carlo: run N replications with distinct seeds (different stochastic
    order sequences), average the heat grid. Only the first rep records the replay
    trajectory (the others exist purely to quantify variability)."""
    reps = max(1, reps if reps is not None else model.simulation.replications)
    results: list[RunResult] = []
    heat_sum: np.ndarray | None = None
    for r in range(reps):
        res = run_once(model, seed=model.simulation.random_seed + r,
                       replay_window_s=None if r == 0 else 0.0)
        results.append(res)
        heat_sum = res.heat.copy() if heat_sum is None else heat_sum + res.heat
    assert heat_sum is not None
    return results, heat_sum / reps
