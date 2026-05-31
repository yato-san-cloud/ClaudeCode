"""Run the simulation: one replication, or several aggregated."""

from __future__ import annotations

import random
from dataclasses import dataclass, field

import numpy as np
import simpy

from whsim.engine.build import Worker, build
from whsim.engine.processes import order_source, picker_agent
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
    workers: list[Worker] = field(default_factory=list)
    replay_window_s: float = 0.0


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
    env.process(order_source(world, rng))

    env.run(until=model.simulation.duration_s)
    return RunResult(
        events=world.events, heat=world.heat,
        n_pickers=world.n_pickers, n_packers=world.n_packers,
        duration_s=model.simulation.duration_s,
        workers=world.workers, replay_window_s=window,
    )


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
