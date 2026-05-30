"""Run the simulation: one replication, or several aggregated."""

from __future__ import annotations

import random
from dataclasses import dataclass

import numpy as np
import simpy

from whsim.engine.build import build
from whsim.engine.processes import order_source
from whsim.schema.model import WarehouseModel


@dataclass
class RunResult:
    events: list[dict]
    heat: np.ndarray
    n_pickers: int
    n_packers: int
    duration_s: float


def run_once(model: WarehouseModel, seed: int | None = None) -> RunResult:
    rng = random.Random(model.simulation.random_seed if seed is None else seed)
    env = simpy.Environment()
    world = build(model, env)
    env.process(order_source(world, rng))
    env.run(until=model.simulation.duration_s)
    return RunResult(
        events=world.events,
        heat=world.heat,
        n_pickers=world.pickers.capacity,
        n_packers=world.packers.capacity,
        duration_s=model.simulation.duration_s,
    )


def run_replications(model: WarehouseModel) -> tuple[list[RunResult], np.ndarray]:
    """Run N replications with deterministic per-rep seeds; sum the heat grids."""
    reps = max(1, model.simulation.replications)
    results: list[RunResult] = []
    heat_sum: np.ndarray | None = None
    for r in range(reps):
        res = run_once(model, seed=model.simulation.random_seed + r)
        results.append(res)
        heat_sum = res.heat.copy() if heat_sum is None else heat_sum + res.heat
    assert heat_sum is not None
    return results, heat_sum / reps
