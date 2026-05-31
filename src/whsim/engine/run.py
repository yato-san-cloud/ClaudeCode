"""Run the simulation: one replication, or several aggregated."""

from __future__ import annotations

import random
from dataclasses import dataclass, field

import numpy as np
import simpy

from whsim.engine.build import Worker, build
from whsim.engine.processes import (
    agv_agent, forklift_agent, order_source, picker_agent, putaway_source,
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
    pick_method: str = "manual"
    workers: list[Worker] = field(default_factory=list)
    agvs: list[Worker] = field(default_factory=list)
    forklifts: list[Worker] = field(default_factory=list)
    replay_window_s: float = 0.0
    cost: dict = field(default_factory=dict)


def run_once(
    model: WarehouseModel,
    seed: int | None = None,
    replay_window_s: float | None = None,
) -> RunResult:
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
    env.process(order_source(world, rng))

    env.run(until=model.simulation.duration_s)
    return RunResult(
        events=world.events, heat=world.heat,
        n_pickers=world.n_pickers, n_packers=world.n_packers,
        duration_s=model.simulation.duration_s,
        n_agvs=world.n_agvs, pick_method=world.pick_method,
        workers=world.workers, agvs=agvs, forklifts=forklifts,
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


def run_replications(model: WarehouseModel) -> tuple[list[RunResult], np.ndarray]:
    """Run N replications with deterministic per-rep seeds; average the heat grid."""
    reps = max(1, model.simulation.replications)
    results: list[RunResult] = []
    heat_sum: np.ndarray | None = None
    for r in range(reps):
        res = run_once(model, seed=model.simulation.random_seed + r)
        results.append(res)
        heat_sum = res.heat.copy() if heat_sum is None else heat_sum + res.heat
    assert heat_sum is not None
    return results, heat_sum / reps
