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
    ready_store: simpy.Store                # AGV-fetched totes waiting for a picker
    fork_store: simpy.Store                 # inbound putaway tasks for forklifts
    packers: simpy.Resource
    belt: simpy.Resource                    # conveyor capacity (slots); full => jam
    has_conveyor: bool
    conveyor_transit: float                 # seconds end-to-end on the belt
    n_pickers: int
    n_packers: int
    n_agvs: int
    agv_speed: float
    pick_method: str                        # "manual" | "agv" | ...
    pick_strategy: str                      # "discrete" | "batch" | "zone" | "wave"
    batch_size: int
    home: tuple[float, float]               # workers start/return here (pack area)
    agv_home: tuple[float, float]           # AGV dock
    fork_home: tuple[float, float]          # forklift / receiving dock
    n_forklifts: int
    fork_speed: float
    slot_xy: list[tuple[float, float]]      # storage slots (forklift putaway targets)
    conveyor_points: list[tuple[float, float]]  # conveyor pickup points (if any)
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

    agvs = [e for e in model.resources.equipment if e.type == "agv"]
    n_agvs = sum(e.count for e in agvs)
    agv_speed = (sum(e.speed_mps for e in agvs) / len(agvs)) if agvs else 1.6
    # AGVs dock at the first AGV's position, else at the pack area.
    agv_home = (agvs[0].x, agvs[0].y) if agvs and (agvs[0].x or agvs[0].y) else home
    pick_method = model.process.pick_method()
    # AGV picking with no AGVs placed falls back to manual so it still runs.
    if pick_method == "agv" and n_agvs == 0:
        pick_method = "manual"

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

    # Batch/zone/wave gather several orders per trip; give each strategy a
    # distinct effective batch so the choice produces a real, correctly-signed
    # difference (more orders/trip -> less walking per order; wave pools most).
    strategy = model.process.pick_strategy
    bs = model.process.batch_size
    if strategy == "discrete":
        batch_size = 1
    elif strategy == "wave":
        batch_size = bs if bs > 1 else 8
    else:  # batch, zone
        batch_size = bs if bs > 1 else 4

    # Forklifts handle inbound putaway (their own moving 動線).
    forks = [e for e in model.resources.equipment if e.type == "forklift"]
    n_forklifts = sum(e.count for e in forks)
    fork_speed = (sum(e.speed_mps for e in forks) / len(forks)) if forks else 2.0
    recv = next((z for z in model.layout.zones if z.type == "receiving"), None)
    fork_home = ((recv.x + recv.w / 2, recv.y + recv.h / 2) if recv
                 else (forks[0].x, forks[0].y) if forks else (0.0, model.layout.bounds.depth / 2))
    slot_xy = [(loc.x, loc.y) for loc in model.locations] or [home]

    conveyor_points: list[tuple[float, float]] = []
    conveyor_len = 0.0
    conveyor_speed_sum = 0.0
    for cv in model.resources.conveyors:
        for p in cv.points:
            conveyor_points.append((p[0], p[1]))
        for a, b in zip(cv.points, cv.points[1:]):
            conveyor_len += abs(a[0] - b[0]) + abs(a[1] - b[1])
        conveyor_speed_sum += cv.speed_mps
    has_conveyor = bool(model.resources.conveyors) and conveyor_len > 0
    cv_speed = (conveyor_speed_sum / len(model.resources.conveyors)
                if model.resources.conveyors else 0.5) or 0.5
    belt_cap = max(1, int(conveyor_len))           # ~1 tote per metre of belt
    conveyor_transit = conveyor_len / cv_speed

    return World(
        env=env, model=model,
        order_store=simpy.Store(env),
        ready_store=simpy.Store(env),
        fork_store=simpy.Store(env),
        packers=simpy.Resource(env, capacity=n_packers),
        belt=simpy.Resource(env, capacity=belt_cap),
        has_conveyor=has_conveyor, conveyor_transit=conveyor_transit,
        n_pickers=n_pickers, n_packers=n_packers,
        n_agvs=n_agvs, agv_speed=max(agv_speed, 0.1), pick_method=pick_method,
        pick_strategy=strategy, batch_size=max(1, batch_size),
        home=home, agv_home=agv_home,
        fork_home=fork_home, n_forklifts=n_forklifts, fork_speed=max(fork_speed, 0.1),
        slot_xy=slot_xy, conveyor_points=conveyor_points,
        sku_xy=sku_xy, sku_ts=sku_ts,
        sku_weights=sku_weights, sku_list=sku_list,
        grid_m=grid_m, heat=heat, replay_window_s=replay_window_s,
    )
