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

from whsim.engine.graph import AisleGraph
from whsim.engine.routing import manhattan
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
    put_wall: simpy.Resource                # 種まき put-wall stations (capacity); full => sort queue
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
    # 5-axis work method (the engine drives picking from these; see
    # docs/WORK_METHOD_DESIGN.md). They are derived via Process.effective_work(),
    # so legacy pick_strategy/batch_size models keep running unchanged.
    zoning: str = "none"                    # C: "none" | "sequential" | "parallel"
    consolidation: str = "pick"             # D: "pick" 摘み取り | "sort" 種まき
    release: str = "continuous"             # E: "continuous" | "wave"
    wave_interval_s: float = 1800.0
    sort_time_s: float = 6.0                # 種まき: put-wall seconds per line
    n_zones: int = 1                        # picking zones for C (spatial bands)
    graph: AisleGraph | None = None         # wall-aware routing (when walls exist)
    use_graph: bool = False
    dist_overrides: dict = field(default_factory=dict)  # (rounded xy pair) -> metres
    workers: list[Worker] = field(default_factory=list)
    helpers: list[Worker] = field(default_factory=list)  # parallel-zone sub-tracks (replay only)
    events: list[dict] = field(default_factory=list)
    replay_window_s: float = 0.0            # only record keyframes up to this time
    zone_edges: list[float] = field(default_factory=list)  # x cut points dividing picking zones
    _helper_seq: int = 0                    # monotonic id source for helper tracks

    def log(self, **kw) -> None:
        self.events.append(kw)

    def helper_for(self, w: "Worker", zone: int) -> "Worker":
        """A lightweight replay-only sub-worker track for one concurrent zone leg
        of `w`. Parallel zoning runs several legs at the SAME simulated time, so
        they cannot share `w.kf` (their keyframes would interleave and the worker
        would appear to teleport). Each concurrent leg gets its own coherent
        track instead; the primary worker `w` stays put while they run."""
        self._helper_seq += 1
        h = Worker(id=f"{w.id}.z{zone}#{self._helper_seq}", role=f"{w.role}-zone")
        self.helpers.append(h)
        return h

    def zone_of(self, p: tuple[float, float]) -> int:
        """Which picking zone (0..n_zones-1) a pick point falls in. Zones are
        spatial x-bands across the storage area, so 'split by zone' (C axis) maps
        to disjoint regions a picker can own without crossing another's."""
        x = p[0]
        z = 0
        for edge in self.zone_edges:
            if x >= edge:
                z += 1
        return min(z, max(self.n_zones - 1, 0))

    @staticmethod
    def _key(a, b):
        return (round(a[0], 1), round(a[1], 1), round(b[0], 1), round(b[1], 1))

    def dist(self, a, b) -> float:
        """Travel distance a->b: measured override > wall-aware graph > Manhattan."""
        if self.dist_overrides:
            d = self.dist_overrides.get(self._key(a, b))
            if d is None:
                d = self.dist_overrides.get(self._key(b, a))
            if d is not None:
                return d
        if self.use_graph and self.graph is not None:
            return self.graph.distance(a, b)
        return manhattan(a, b)

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

    # Drive picking from the 5-axis work method. effective_work() derives it
    # from legacy pick_strategy/batch_size when not set explicitly, so old models
    # keep running identically. pick_strategy is still surfaced for routing.
    work = model.process.effective_work()
    strategy = model.process.pick_strategy
    bs = max(model.process.batch_size, work.orders_per_trip)
    # orders_per_trip (B) generalises batch_size: how many orders to pull per trip.
    # When the user left it at 1 but picked a strategy that implies batching,
    # fall back to a sensible default so the choice produces a real difference
    # (more orders/trip -> less walking per order; wave pools most).
    if work.orders_per_trip > 1:
        batch_size = work.orders_per_trip
    elif work.consolidation == "sort":
        batch_size = bs if bs > 1 else 8   # 種まき pools many orders into one sweep
    elif strategy == "discrete" and work.zoning == "none":
        batch_size = 1
    elif work.release == "wave":
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
    # Wall-aware routing graph (only meaningful when walls exist).
    graph = AisleGraph.from_model(model)
    use_graph = graph.enabled
    # Resolve measured shelf-to-shelf distances to a fast xy-keyed override map.
    dist_overrides: dict = {}
    if model.distance_overrides:
        loc_by_id = model.location_by_id()
        for key, d in model.distance_overrides.items():
            a_id, _, b_id = key.partition("|")
            la, lb = loc_by_id.get(a_id), loc_by_id.get(b_id)
            if la and lb:
                dist_overrides[World._key((la.x, la.y), (lb.x, lb.y))] = float(d)

    # --- Zoning (C): divide the picking area into spatial x-bands -----------
    # When zoning is on, pickers own disjoint x-bands of the storage region.
    # We cut the occupied x-range into n_zones equal slices; n_zones tracks the
    # picker headcount (capped) so 'parallel' actually parallelises across them.
    zoning = work.zoning
    n_zones = 1
    zone_edges: list[float] = []
    if zoning != "none":
        xs = [xy[0] for xy in sku_xy.values()]
        if xs and max(xs) > min(xs):
            n_zones = max(2, min(n_pickers, 4))
            lo, hi = min(xs), max(xs)
            span = (hi - lo) / n_zones
            zone_edges = [lo + span * (i + 1) for i in range(n_zones - 1)]

    # --- 種まき put wall (D): sortation stations for consolidation=="sort" ---
    # The wall is a capacitated resource so a slow sort backs up (queue), like a
    # real DAS / put-to-light wall. One station per pack station by default.
    put_wall_cap = max(1, n_packers)

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
        put_wall=simpy.Resource(env, capacity=put_wall_cap),
        belt=simpy.Resource(env, capacity=belt_cap),
        has_conveyor=has_conveyor, conveyor_transit=conveyor_transit,
        n_pickers=n_pickers, n_packers=n_packers,
        n_agvs=n_agvs, agv_speed=max(agv_speed, 0.1), pick_method=pick_method,
        pick_strategy=strategy, batch_size=max(1, batch_size),
        zoning=zoning, consolidation=work.consolidation, release=work.release,
        wave_interval_s=max(work.wave_interval_s, 1.0),
        sort_time_s=max(model.process.sort_time_s, 0.0),
        n_zones=n_zones, zone_edges=zone_edges,
        home=home, agv_home=agv_home,
        fork_home=fork_home, n_forklifts=n_forklifts, fork_speed=max(fork_speed, 0.1),
        slot_xy=slot_xy, conveyor_points=conveyor_points,
        sku_xy=sku_xy, sku_ts=sku_ts,
        sku_weights=sku_weights, sku_list=sku_list,
        grid_m=grid_m, heat=heat, replay_window_s=replay_window_s,
        graph=graph, use_graph=use_graph, dist_overrides=dist_overrides,
    )
