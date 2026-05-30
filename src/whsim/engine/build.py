"""Turn a validated WarehouseModel into a runnable SimPy world."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import simpy

from whsim.schema.model import WarehouseModel


@dataclass
class World:
    env: simpy.Environment
    model: WarehouseModel
    pickers: simpy.Resource
    packers: simpy.Resource
    depot: tuple[float, float]              # pickers start/return here (pack station)
    sku_xy: dict[str, tuple[float, float]]  # sku -> pick location
    sku_ts: dict[str, float]                # sku -> handling seconds per unit
    sku_weights: list[float]                # demand weights aligned with sku_list
    sku_list: list[str]
    grid_m: float
    heat: np.ndarray                        # congestion accumulator (gy, gx)
    events: list[dict] = field(default_factory=list)

    def log(self, **kw) -> None:
        self.events.append(kw)


def build(model: WarehouseModel, env: simpy.Environment | None = None) -> World:
    env = env or simpy.Environment()

    workers = model.resources.workers
    n_pickers = sum(w.count for w in workers if w.role == "picker") or 1
    station = model.resources.stations[0] if model.resources.stations else None
    n_packers = (station.count if station else 1) or 1
    depot = (station.x, station.y) if station else (0.0, 0.0)

    loc_by_id = model.location_by_id()
    sku_xy: dict[str, tuple[float, float]] = {}
    for it in model.items:
        loc = None
        if it.default_location and it.default_location in loc_by_id:
            loc = loc_by_id[it.default_location]
        if loc is not None:
            sku_xy[it.sku] = (loc.x, loc.y)
    # Fall back to any location that names the sku.
    for loc in model.locations:
        if loc.sku and loc.sku not in sku_xy:
            sku_xy[loc.sku] = (loc.x, loc.y)

    sku_ts = {it.sku: it.ts_per_unit for it in model.items}
    sku_list = [it.sku for it in model.items if it.sku in sku_xy]
    sku_weights = [max(model.item_by_sku()[s].pick_freq, 1e-6) for s in sku_list]

    grid_m = model.simulation.heatmap_grid_m or 1.0
    gw = max(1, math.ceil(model.layout.bounds.width / grid_m))
    gh = max(1, math.ceil(model.layout.bounds.depth / grid_m))
    heat = np.zeros((gh, gw), dtype=float)

    return World(
        env=env, model=model,
        pickers=simpy.Resource(env, capacity=n_pickers),
        packers=simpy.Resource(env, capacity=n_packers),
        depot=depot, sku_xy=sku_xy, sku_ts=sku_ts,
        sku_weights=sku_weights, sku_list=sku_list,
        grid_m=grid_m, heat=heat,
    )
