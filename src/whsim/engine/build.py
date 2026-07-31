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

from whsim.engine.graph import AisleGraph, simplify_collinear
from whsim.engine.routing import manhattan
from whsim.schema.model import WarehouseModel
from whsim.workmethod import orders_per_trip as workmethod_orders_per_trip


@dataclass
class Worker:
    """One picker agent. Keyframes are (t, x, y, state) waypoints; viewers lerp
    position between consecutive frames, and apply `state` from each frame on.

    A `pick` (or `putaway`) keyframe MAY carry a 5th `meta` dict
    ``{"lv": 段, "by": "manual"|"forklift"|"crane", "h": pick-face height m}`` so
    the 2D/3D replay can raise the picker/forklift to the right level. Ground-level
    (段1) frames stay 4-tuples — byte-identical to the legacy contract."""

    id: str
    role: str
    keyframes: list[tuple] = field(default_factory=list)

    def kf(self, t: float, x: float, y: float, state: str, meta: dict | None = None) -> None:
        f = (round(t, 2), round(x, 3), round(y, 3), state)
        self.keyframes.append(f if meta is None else (*f, meta))


@dataclass
class Tote:
    """One physical unit of goods moving through the warehouse, as a replay track.

    Same keyframe contract as :class:`Worker` — ``(t, x, y, state)`` with the same
    rounding — so a viewer lerps a tote exactly like it lerps an agent. ``state``
    is one of ``"carry"`` (in a picker's hands), ``"belt"`` (riding a conveyor) or
    ``"pack"`` (at the discharge/pack point). Purely a replay artefact: the DES
    timing is unchanged whether or not a tote is being recorded."""

    id: str
    keyframes: list[tuple] = field(default_factory=list)

    def kf(self, t: float, x: float, y: float, state: str) -> None:
        self.keyframes.append((round(t, 2), round(x, 3), round(y, 3), state))


# Replay memory guard: at most this many tote tracks are recorded per run (the
# FIRST N totes inside the replay window; every later tote rides untracked). A
# busy shift can move tens of thousands of totes and each track is a list of
# keyframes, so an uncapped emitter would dwarf the worker tracks.
MAX_TOTE_TRACKS = 400

# Fallback belt speed for a conveyor authored with a non-positive speed (the
# schema defaults to 0.5 m/s; a hand-edited 0 must not divide by zero or freeze
# the belt -- never-blocks).
DEFAULT_CONVEYOR_SPEED_MPS = 0.5


@dataclass
class ConveyorLine:
    """ONE physical conveyor: its own polyline, speed and slot capacity.

    Geometry is the authored polyline ``points[0] -> ... -> points[-1]``; the LAST
    point is the discharge end (where totes leave the belt to be packed). A tote
    boards at the nearest point *on the path* (``project``) and rides only the
    REMAINING distance to the discharge end, so boarding next to the discharge is
    genuinely quicker than boarding at the infeed.

    ``belt`` is this line's own slot pool (~1 tote per metre of ITS length, min 1),
    so two conveyors jam independently and a slow pack stage backs up only the
    line that feeds it."""

    id: str
    points: list[tuple[float, float]]
    seglens: list[float]                    # euclidean length of each segment
    length: float                           # total path length (m)
    speed: float                            # m/s (> 0)
    capacity: int                           # slots (~1 tote / metre)
    belt: simpy.Resource

    def project(self, p) -> tuple[tuple[float, float], float]:
        """Nearest point ON the polyline to ``p`` + its arc length from the infeed.

        Projects onto every segment (clamped to its ends) rather than snapping to
        the nearest vertex -- a picker standing beside the middle of a 30 m belt
        boards there, not at the far corner."""
        px, py = float(p[0]), float(p[1])
        best_d2 = float("inf")
        best_xy = self.points[0]
        best_arc = 0.0
        arc = 0.0
        for i, (a, b) in enumerate(zip(self.points, self.points[1:])):
            dx, dy = b[0] - a[0], b[1] - a[1]
            seg = self.seglens[i]
            if seg <= 1e-12:
                t = 0.0
            else:
                t = ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)
                t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
            qx, qy = a[0] + dx * t, a[1] + dy * t
            d2 = (px - qx) ** 2 + (py - qy) ** 2
            if d2 < best_d2:
                best_d2, best_xy, best_arc = d2, (qx, qy), arc + seg * t
            arc += seg
        return best_xy, best_arc

    def remaining(self, arc: float) -> float:
        """Metres left from arc length ``arc`` to the discharge end."""
        return max(self.length - max(arc, 0.0), 0.0)

    def tail(self, arc: float) -> list[tuple[float, float]]:
        """Corner waypoints from arc length ``arc`` to the discharge end.

        The route a tote physically travels, so the replay can follow a BENT belt
        instead of cutting the corner (same idea as ``World.path`` for walkers)."""
        arc = max(arc, 0.0)
        acc = 0.0
        for i, seg in enumerate(self.seglens):
            if arc <= acc + seg + 1e-9:
                a, b = self.points[i], self.points[i + 1]
                t = ((arc - acc) / seg) if seg > 1e-12 else 0.0
                t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
                out = [(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)]
                for p in self.points[i + 1:]:
                    if math.dist(p, out[-1]) > 1e-9:   # drop a coincident head/corner
                        out.append(p)
                return out
            acc += seg
        return [self.points[-1]]


@dataclass
class World:
    env: simpy.Environment
    model: WarehouseModel
    order_store: simpy.Store
    ready_store: simpy.Store                # AGV-fetched totes waiting for a picker
    fork_store: simpy.Store                 # inbound putaway tasks for forklifts
    packers: simpy.Resource
    put_wall: simpy.Resource                # 種まき put-wall stations (capacity); full => sort queue
    has_conveyor: bool
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
    sku_xy: dict[str, tuple[float, float]]
    sku_ts: dict[str, float]
    sku_pick: dict[str, tuple]
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
    # 自動仕分機(sorter): when a sorter Equipment is placed AND consolidation=="sort",
    # the sort phase runs an AUTOMATIC piece sorter (induction channels + destination
    # chutes with back-pressure) instead of the manual put wall. None = no sorter
    # (legacy manual wall path, byte-identical). Keys: xy, rate_per_hr, sort_s,
    # chutes, chute_capacity, channels, release_s, induction (Resource),
    # chute_containers (list[Container]). See _sorter_phase in processes.py.
    sorter: dict | None = None
    n_zones: int = 1                        # picking zones for C (spatial bands)
    # Pick-sequence policy (ADDITIVE; default keeps the legacy greedy/S-shape).
    # "default" = nearest-neighbour (discrete/batch/wave) or S-shape (zone);
    # "optimized" = run picktour 2-opt over the greedy seed for shorter tours.
    routing_policy: str = "default"
    graph: AisleGraph | None = None         # wall-aware routing (when walls exist)
    use_graph: bool = False
    dist_overrides: dict = field(default_factory=dict)  # (rounded xy pair) -> metres
    # コンベア搬送: one entry per authored conveyor (each with its own path,
    # speed and slot capacity). Empty ⇒ no conveyor (has_conveyor False) and the
    # engine takes the legacy carry-to-pack path unchanged.
    conveyors: list[ConveyorLine] = field(default_factory=list)
    workers: list[Worker] = field(default_factory=list)
    helpers: list[Worker] = field(default_factory=list)  # parallel-zone sub-tracks (replay only)
    totes: list[Tote] = field(default_factory=list)      # goods tracks (replay only)
    tote_cap: int = MAX_TOTE_TRACKS
    events: list[dict] = field(default_factory=list)
    replay_window_s: float = 0.0            # only record keyframes up to this time
    zone_edges: list[float] = field(default_factory=list)  # x cut points dividing picking zones
    # 仮置き(staging): finite buffer between pick and pack. None = disabled (legacy
    # inline pack). When present, pickers put totes here (blocking when full =
    # back-pressure) and dedicated packer agents pull from it.
    staging: simpy.Store | None = None
    staging_capacity: int = 0
    pack_xy: list[tuple[float, float]] = field(default_factory=list)  # packer agent stations
    # 入荷検品(inbound inspection): when enabled, receipts queue here for inspector
    # agents before forklift putaway. None = disabled (receipts go straight to fork).
    inbound_store: simpy.Store | None = None
    n_inspectors: int = 0
    inspect_time_s: float = 0.0
    # 在庫補充連鎖 (DES-internal inventory). None = disabled (pick faces have
    # infinite stock, byte-identical legacy path). When present:
    #   * replen_faces  — {face_key: dict(qty/trigger/refill_to/pending/event/xy)}
    #     per slotted pick face; picks decrement it and empty faces block pickers.
    #   * replen_store  — the replenishment task queue (each item is a face dict).
    #   * replen_shared_forklift — the forklift agents also drain replen_store
    #     (no dedicated replenishers); else dedicated replenisher agents do.
    replen_faces: dict | None = None
    replen_store: simpy.Store | None = None
    replen_place_s: float = 0.0
    replen_dedicated: int = 0               # dedicated replenisher agents to spawn
    n_replenishers: int = 0                 # effective servers (for utilisation denom)
    replen_shared_forklift: bool = False
    # AGV通路相互排他・簡易干渉モデル (opt-in). None = disabled (AGVs never contend for
    # aisle space — byte-identical legacy travel). When present it is a dict of
    # lazily-created SimPy Resource(capacity=1) mutexes keyed by a COARSE aisle
    # segment id, so at most one AGV occupies a ~3 m aisle stretch at a time and
    # extra AGVs queue in shared corridors. See agv_agent / _agv_travel in
    # processes.py. Only built when agv_interference AND the graph is active AND
    # n_agvs > 1.
    aisle_locks: dict | None = None
    agv_deadlock_s: float = 120.0           # lock wait past this ⇒ warn + force-proceed
    _helper_seq: int = 0                    # monotonic id source for helper tracks

    def log(self, **kw) -> None:
        self.events.append(kw)

    @staticmethod
    def _face_key(xy) -> tuple[float, float]:
        """Round a pick position to a stable key for the inventory-face map."""
        return (round(xy[0], 3), round(xy[1], 3))

    def face_at(self, xy) -> dict | None:
        """The inventory pick face at position ``xy`` (or None = infinite stock)."""
        if self.replen_faces is None:
            return None
        return self.replen_faces.get(self._face_key(xy))

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

    def path(self, a, b) -> list[tuple[float, float]]:
        """Corner waypoints a→b along the REAL route (wall-aware aisle graph), for
        replay/動線 viz. The viewer lerps between keyframes, so emitting the route's
        turns makes agents follow aisles instead of cutting straight through
        shelves. Collinear runs are collapsed to the few corner vertices. Falls back
        to the straight segment [a, b] when no graph is active or it cannot route —
        viz must never break the run."""
        if self.use_graph and self.graph is not None:
            try:
                wp = self.graph.path(a, b)
                if wp and len(wp) >= 2:
                    return simplify_collinear(wp)
            except Exception:  # noqa: BLE001 — fall back to the straight segment
                pass
        return [tuple(a), tuple(b)]

    def stand(self, p) -> tuple[float, float]:
        """Where an agent physically STANDS to serve point ``p``.

        Slots are addressed at the rack centre-line, but a picker stands in the
        aisle and reaches in — so every *stationary* keyframe at a slot (pick,
        putaway, replenish) is emitted here, matching the aisle node the router
        measures from. Without this the replay draws a half-rack-depth hop into
        and back out of the rack around every pick. Identity when no graph is
        active or the point is already on free floor."""
        if self.use_graph and self.graph is not None:
            try:
                return self.graph.access_point(p)
            except Exception:  # noqa: BLE001 — viz must never break the run
                pass
        return (float(p[0]), float(p[1]))

    def recording(self) -> bool:
        return self.env.now <= self.replay_window_s

    def new_tote(self, order_id: str) -> "Tote | None":
        """A replay track for one tote — or ``None`` when we are outside the replay
        window or past ``tote_cap`` (MAX_TOTE_TRACKS). Callers treat ``None`` as
        "move it, don't draw it", so the physics never depend on recording."""
        if not self.recording() or len(self.totes) >= self.tote_cap:
            return None
        t = Tote(id=f"tote-{order_id}")
        self.totes.append(t)
        return t

    def aisle_lock(self, seg) -> "simpy.Resource":
        """The mutex (capacity-1 Resource) for a coarse aisle segment, created on
        first use. Only reached when ``aisle_locks`` is not None (interference on)."""
        lk = self.aisle_locks.get(seg)
        if lk is None:
            lk = simpy.Resource(self.env, capacity=1)
            self.aisle_locks[seg] = lk
        return lk


def build(
    model: WarehouseModel,
    env: simpy.Environment | None = None,
    replay_window_s: float = 0.0,
    graph: AisleGraph | None = None,
    routing_policy: str = "default",
) -> World:
    """``graph`` (optional) injects a pre-built routing graph so replications
    over the SAME layout share one graph (and its distance caches) instead of
    rebuilding it per rep; ``None`` keeps the classic build-from-model path.

    ``routing_policy`` is ADDITIVE and defaults to ``"default"`` (the legacy
    greedy nearest-neighbour / zone S-shape). Pass ``"optimized"`` to route each
    pick with picktour's 2-opt instead — strictly shorter tours, opt-in only, so
    every existing run is byte-identical when left at the default."""
    env = env or simpy.Environment()

    workers = model.resources.workers
    n_pickers = sum(w.count for w in workers if w.role == "picker") or 1
    station = model.resources.stations[0] if model.resources.stations else None
    # 梱包台数 = the WHOLE bench line, not just the first entry. The editor places
    # every bench as its own Station (``designer/place.js`` writes ``count: 1``), so
    # a 20-bench packing line arrives as 20 entries and reading ``stations[0]``
    # alone modelled it as ONE bench. Summing is byte-identical for the single-group
    # form every template and importer produced before, and ``analytic`` counts the
    # same benches (they must not disagree about the pack stage's capacity).
    n_packers = sum(max(0, s.count) for s in model.resources.stations) or 1
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
    # sku_xy = pick position; sku_pick = per-visit pick meta carrying the vertical
    # access time AND the 段(level)/height/mover so the engine can both *time* the
    # lift and *animate* it (the 2D/3D replay raise the picker/forklift to height).
    from whsim import racktypes
    _lift = float(model.process.lift_speed_mps)
    _reach = float(model.process.manual_reach_s_per_m)

    def _pick_meta(loc):
        rt = getattr(loc, "rack_type", None)
        lv = int(getattr(loc, "level", 1) or 1)
        return (racktypes.vertical_pick_s(rt, lv, _lift, _reach),  # [0] seconds
                lv,                                                  # [1] 段(level)
                racktypes.mover(rt),                                 # [2] manual/forklift/crane
                racktypes.level_height_m(rt, lv))                    # [3] pick-face height (m)

    sku_xy: dict[str, tuple[float, float]] = {}
    sku_pick: dict[str, tuple] = {}
    sku_loc: dict[str, "object"] = {}       # sku -> the Location backing its pick face
    for it in model.items:
        if it.default_location and it.default_location in loc_by_id:
            loc = loc_by_id[it.default_location]
            sku_xy[it.sku] = (loc.x, loc.y)
            sku_pick[it.sku] = _pick_meta(loc)
            sku_loc[it.sku] = loc
    for loc in model.locations:
        if loc.sku and loc.sku not in sku_xy:
            sku_xy[loc.sku] = (loc.x, loc.y)
            sku_pick[loc.sku] = _pick_meta(loc)
            sku_loc[loc.sku] = loc

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
    # orders_per_trip (B) generalises batch_size: how many orders to pull per
    # trip. The rule lives in ``workmethod.orders_per_trip`` so the closed-form
    # oracle (analytic.estimate) resolves the SAME batch the engine sweeps.
    batch_size = workmethod_orders_per_trip(model)

    # Forklifts handle inbound putaway (their own moving 動線).
    forks = [e for e in model.resources.equipment if e.type == "forklift"]
    n_forklifts = sum(e.count for e in forks)
    fork_speed = (sum(e.speed_mps for e in forks) / len(forks)) if forks else 2.0
    recv = next((z for z in model.layout.zones if z.type == "receiving"), None)
    fork_home = ((recv.x + recv.w / 2, recv.y + recv.h / 2) if recv
                 else (forks[0].x, forks[0].y) if forks else (0.0, model.layout.bounds.depth / 2))
    slot_xy = [(loc.x, loc.y) for loc in model.locations] or [home]

    # --- コンベア搬送: one ConveyorLine per authored conveyor -----------------
    # Each belt keeps its OWN geometry, speed and capacity (~1 tote per metre of
    # its own length, min 1) instead of being merged into one virtual belt, so a
    # tote pays only the distance from where it boards to THAT line's discharge
    # end. Degenerate entries (<2 points, or every point coincident) are skipped
    # entirely — they are not physical transport (never blocks, never divides by
    # zero); a non-positive speed falls back to the schema default.
    # WHICH belts the design actually commits to. `None` = no leg of the flow
    # says 「コンベアで受け取る」, so no belt runs at all -- drawing a conveyor is no
    # longer enough to make every picker use it. An empty SET = "conveyor, but no
    # specific machine named", which keeps every drawn belt available (the
    # behaviour before flow edges existed). See flowgraph.conveyor_ids_in_use.
    from whsim import flowgraph
    try:
        designed = flowgraph.conveyor_ids_in_use(model)
    except Exception:      # noqa: BLE001 — a broken flow must not break the run
        designed = set()

    conveyor_lines: list[ConveyorLine] = []
    for cv in (model.resources.conveyors if designed is not None else []):
        if designed and str(cv.id) not in designed:
            continue          # a belt the design does not route through
        pts = [(float(p[0]), float(p[1])) for p in cv.points if len(p) >= 2]
        seglens = [math.dist(a, b) for a, b in zip(pts, pts[1:])]
        total = sum(seglens)
        if len(pts) < 2 or total <= 1e-9:
            continue
        speed = float(cv.speed_mps)
        if not (speed > 0.0):
            speed = DEFAULT_CONVEYOR_SPEED_MPS
        cap = max(1, int(total))
        conveyor_lines.append(ConveyorLine(
            id=cv.id, points=pts, seglens=seglens, length=total, speed=speed,
            capacity=cap, belt=simpy.Resource(env, capacity=cap)))
    # Wall-aware routing graph (only meaningful when walls exist). A caller may
    # inject a pre-built one (shared across replications of the same layout).
    if graph is None:
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

    # --- 自動仕分機(sorter): an automatic piece sorter for total picking (D=="sort").
    # When a sorter Equipment is placed, the sort phase inducts the swept lines onto
    # the machine (capacitated by its induction channels) and routes each line to a
    # destination chute (a finite buffer that back-pressures when full) — instead of
    # the manual put wall. Built whenever a sorter exists; the sort phase only uses
    # it when consolidation=="sort", so no sorter => the World.sorter stays None and
    # the legacy manual-wall path is byte-identical.
    sorters = [e for e in model.resources.equipment if e.type == "sorter" and e.count > 0]
    sorter: dict | None = None
    if sorters:
        se = sorters[0]
        rate = max(float(se.sorter_rate_per_hr), 1e-9)
        n_chutes = max(1, int(se.chutes))
        chute_cap = max(1, int(se.chute_capacity))
        channels = max(1, int(se.induction_workers))
        sorter = {
            "xy": (se.x, se.y) if (se.x or se.y) else None,
            "rate_per_hr": rate,
            "sort_s": 3600.0 / rate,               # seconds per line on the sorter
            "chutes": n_chutes,
            "chute_capacity": chute_cap,
            "channels": channels,
            "release_s": max(0.0, float(se.chute_release_s)),
            "induction": simpy.Resource(env, capacity=channels),
            "chute_containers": [simpy.Container(env, capacity=chute_cap, init=0)
                                 for _ in range(n_chutes)],
        }

    # 仮置き(staging) buffer: only the manual non-conveyor path uses it (the AGV
    # and conveyor paths already model their own buffering/back-pressure). A finite
    # simpy.Store blocks put() when full, giving real pick->pack back-pressure.
    staging_cap = max(0, int(model.process.staging_capacity))
    staging = simpy.Store(env, capacity=staging_cap) if staging_cap > 0 else None
    pack_xy = [(s.x, s.y) for s in model.resources.stations] or [home]

    # 入荷検品(inbound inspection) stage: receipts wait here for inspector agents
    # before forklift putaway (an explicit upstream WIP), when enabled.
    n_inspectors = max(0, int(model.process.inspector_count))
    inbound_store = simpy.Store(env) if n_inspectors > 0 else None
    inspect_time_s = max(0.0, float(model.process.inbound_inspection_time_s))

    # --- 在庫補充連鎖 (DES-internal inventory & replenishment) ----------------
    # Opt-in (Process.replenishment_enabled). Build one inventory face per slotted
    # pick position from its Location's qty/capacity. A SKU with no finite-capacity
    # location gets no face => effectively infinite stock (never blocks). Faces are
    # keyed by ROUNDED position so the picker's arrival point (== sku_xy coord)
    # resolves them in O(1) without threading the sku through the pick pipeline.
    replen_faces: dict | None = None
    replen_store = None
    replen_place_s = 0.0
    replen_dedicated = 0
    n_replenishers = 0
    replen_shared_forklift = False
    if model.process.replenishment_enabled:
        trig = max(0.0, float(model.process.replenish_trigger_frac))
        qfrac = max(0.0, float(model.process.replenish_qty_frac))
        replen_place_s = max(0.0, float(model.process.replenish_place_s))
        faces: dict[tuple[float, float], dict] = {}
        for sku, loc in sku_loc.items():
            cap = max(0, int(getattr(loc, "capacity", 0) or 0))
            if cap <= 0:
                continue                     # no finite capacity => infinite stock
            key = World._face_key((loc.x, loc.y))
            if key in faces:
                continue                     # one face per pick position
            q0 = int(loc.qty) if int(getattr(loc, "qty", 0) or 0) > 0 else cap
            faces[key] = {
                "xy": (loc.x, loc.y), "loc_id": loc.id, "sku": sku,
                "qty": q0, "capacity": cap,
                "trigger": cap * trig,
                "refill_to": max(1.0, cap * qfrac),
                "pending": False, "event": None,
            }
        replen_faces = faces
        replen_store = simpy.Store(env)
        # Who services replenishment: dedicated agents if asked, else the forklift
        # fleet shares the work, else auto-spawn one dedicated agent so an empty
        # face can never deadlock the picker (never-blocks).
        dedicated = max(0, int(model.process.replenishers))
        if dedicated > 0:
            replen_dedicated = dedicated
            n_replenishers = dedicated
        elif n_forklifts > 0:
            replen_shared_forklift = True
            n_replenishers = n_forklifts
        else:
            replen_dedicated = 1
            n_replenishers = 1

    # AGV通路相互排他: build the aisle-segment mutex map only when the feature is
    # opt-in enabled, the wall-aware graph is active (segments are meaningful), and
    # more than one AGV can actually contend. Otherwise None ⇒ AGVs travel the
    # legacy way and the run is byte-identical.
    aisle_locks = ({} if (model.process.agv_interference and use_graph and n_agvs > 1)
                   else None)

    has_conveyor = bool(conveyor_lines)

    return World(
        env=env, model=model,
        order_store=simpy.Store(env),
        ready_store=simpy.Store(env),
        fork_store=simpy.Store(env),
        packers=simpy.Resource(env, capacity=n_packers),
        put_wall=simpy.Resource(env, capacity=put_wall_cap),
        has_conveyor=has_conveyor, conveyors=conveyor_lines,
        n_pickers=n_pickers, n_packers=n_packers,
        n_agvs=n_agvs, agv_speed=max(agv_speed, 0.1), pick_method=pick_method,
        pick_strategy=strategy, batch_size=max(1, batch_size),
        routing_policy=routing_policy,
        zoning=zoning, consolidation=work.consolidation, release=work.release,
        wave_interval_s=max(work.wave_interval_s, 1.0),
        sort_time_s=max(model.process.sort_time_s, 0.0),
        sorter=sorter,
        n_zones=n_zones, zone_edges=zone_edges,
        home=home, agv_home=agv_home,
        fork_home=fork_home, n_forklifts=n_forklifts, fork_speed=max(fork_speed, 0.1),
        slot_xy=slot_xy,
        sku_xy=sku_xy, sku_ts=sku_ts, sku_pick=sku_pick,
        sku_weights=sku_weights, sku_list=sku_list,
        grid_m=grid_m, heat=heat, replay_window_s=replay_window_s,
        graph=graph, use_graph=use_graph, dist_overrides=dist_overrides,
        staging=staging, staging_capacity=staging_cap, pack_xy=pack_xy,
        inbound_store=inbound_store, n_inspectors=n_inspectors,
        inspect_time_s=inspect_time_s,
        replen_faces=replen_faces, replen_store=replen_store,
        replen_place_s=replen_place_s, replen_dedicated=replen_dedicated,
        n_replenishers=n_replenishers, replen_shared_forklift=replen_shared_forklift,
        aisle_locks=aisle_locks,
    )
