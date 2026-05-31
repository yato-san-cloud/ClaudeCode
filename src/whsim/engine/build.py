"""Turn a validated WarehouseModel into a runnable SimPy world.

Engine v2: pickers are *individual* agents with a position, not an anonymous
resource pool. That makes the run produce a per-worker trajectory (keyframes)
which the 2D/3D viewers replay as motion -- "the simulation must move".
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import simpy

from whsim.schema.model import WarehouseModel


@dataclass
class Worker:
    """One picker agent. Keyframes are (t, x, y, state) waypoints; viewers lerp
    position between consecutive frames, and apply `state` from each frame on."""

    id: str
    role: str
    keyframes: list[tuple] = field(default_factory=list)

    def kf(self, t: float, x: float, y: float, state: str) -> None:
        self.keyframes.append((round(t, 2), round(x, 3), round(y, 3), state))


@dataclass
class World:
    env: simpy.Environment
    model: WarehouseModel
    order_store: simpy.Store
    packers: simpy.Resource
    n_pickers: int
    n_packers: int
    home: tuple[float, float]               # workers start/return here (pack area)
    sku_xy: dict[str, tuple[float, float]]
    sku_ts: dict[str, float]
    sku_weights: list[float]
    sku_list: list[str]
    grid_m: float
    heat: np.ndarray
    workers: list[Worker] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    replay_window_s: float = 0.0            # only record keyframes up to this time

    def log(self, **kw) -> None:
        self.events.append(kw)

    def recording(self) -> bool:
        return self.env.now <= self.replay_window_s


def build(
    model: WarehouseModel,
    env: simpy.Environment | None = None,
    replay_window_s: float = 0.0,
) -> World:
    env = env or simpy.Environment()

    workers = model.resources.workers
    n_pickers = sum(w.count for w in workers if w.role == "picker") or 1
    station = model.resources.stations[0] if model.resources.stations else None
    n_packers = (station.count if station else 1) or 1
    home = (station.x, station.y) if station else (0.0, 0.0)

    loc_by_id = model.location_by_id()
    sku_xy: dict[str, tuple[float, float]] = {}
    for it in model.items:
        if it.default_location and it.default_location in loc_by_id:
            loc = loc_by_id[it.default_location]
            sku_xy[it.sku] = (loc.x, loc.y)
    for loc in model.locations:
        if loc.sku and loc.sku not in sku_xy:
            sku_xy[loc.sku] = (loc.x, loc.y)

    sku_ts = {it.sku: it.ts_per_unit for it in model.items}
    by_sku = model.item_by_sku()
    sku_list = [it.sku for it in model.items if it.sku in sku_xy]
    sku_weights = [max(by_sku[s].pick_freq, 1e-6) for s in sku_list]

    grid_m = model.simulation.heatmap_grid_m or 1.0
    gw = max(1, math.ceil(model.layout.bounds.width / grid_m))
    gh = max(1, math.ceil(model.layout.bounds.depth / grid_m))
    heat = np.zeros((gh, gw), dtype=float)

    return World(
        env=env, model=model,
        order_store=simpy.Store(env),
        packers=simpy.Resource(env, capacity=n_packers),
        n_pickers=n_pickers, n_packers=n_packers,
        home=home, sku_xy=sku_xy, sku_ts=sku_ts,
        sku_weights=sku_weights, sku_list=sku_list,
        grid_m=grid_m, heat=heat, replay_window_s=replay_window_s,
    )
