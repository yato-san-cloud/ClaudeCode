"""Discrete-event processes (agent-based).

Two operating modes share the same pack stage:

* manual  — pickers pull orders (one, or up to batch_size for batch/zone/wave),
  walk a nearest-neighbour route recording trajectory keyframes, then pack.
* agv (goods-to-person) — a PIPELINE: AGV agents pull orders, physically fetch
  the totes (their own moving trajectories), and drop them in a ready queue;
  pickers then only handle + pack. AGVs and pickers run in parallel across
  orders, so the AGV fleet (not the picker) can become the real constraint and
  fewer pickers are needed.

**解析オラクル未対応 (known limitation).** ``analytic.py`` mirrors the engine's
work methods and the conveyor chain, but it does NOT yet mirror the three line
mechanics added here — 選択停止ゲート (``Conveyor.stop_gate``), 容器の有限循環
(``Process.container_pool``) and 引き込みの pull 方式 (``Process.divert_policy``).
All three are opt-in and every bundled model leaves them off, so the closed-form
estimate and the catalogue agreement pins (``tests/test_analytic_aisle_travel.py``)
are unaffected — but a model that turns one ON will get an estimate that ignores
it, and the estimate will read rosier than the run (invariant 5 in
docs/ARCHITECTURE.md: 「エンジンが持つ機構は解析側にも要る」). Mirroring them is the
next step, not a done one.
"""

from __future__ import annotations

import math
import random
import zlib

from whsim.engine.build import Worker, World
from whsim.engine.routing import leg_cells, manhattan, nearest_neighbor_route
from whsim.schema.model import Order, OrderLine


def _accumulate_heat(world: World, a, b) -> None:
    gh, gw = world.heat.shape
    for gx, gy in leg_cells(a, b, world.grid_m):
        if 0 <= gy < gh and 0 <= gx < gw:
            world.heat[gy, gx] += 1.0


# --- 通路干渉 (aisle interference) ------------------------------------------
# Direction names for the 4-neighbour lattice a walk decomposes into. A cell is
# contended PER DIRECTION, so two agents crossing the same cell the other way (or
# across it) never queue — a real aisle is wide enough to pass someone coming the
# other way, but not wide enough to overtake someone ahead of you.
_DIR_X = ("-x", "+x")
_DIR_Y = ("-y", "+y")

# Never-blocks guard: a single walk longer than this many cells falls back to the
# un-contended single timeout. At a 1 m pitch that is a 4 km leg, i.e. only a
# degenerate coordinate can reach it — but a walk must never turn into an
# unbounded pile of SimPy events.
MAX_CELL_STEPS = 4000

# A stand-still longer than this earns its own replay keyframe, so the drawn agent
# visibly STOPS instead of gliding through the cell it queued in front of. Shorter
# waits are left out on purpose: one keyframe per metre-scale hesitation would bury
# the replay payload in frames nobody can see.
WAIT_KEYFRAME_S = 2.0


def _axis_steps(u0: float, u1: float, fixed: float, grid: float, axis: int) -> list:
    """``[(cell, direction, metres)]`` for one straight run along a single axis.

    Splits the run at the lattice boundaries so each entry is the stretch spent
    inside ONE cell — which is what makes a cell a capacity-1 resource an agent
    holds for exactly as long as it is physically inside it."""
    out: list[tuple[tuple[int, int], str, float]] = []
    if abs(u1 - u0) <= 1e-9:
        return out
    up = u1 > u0
    dirn = (_DIR_X if axis == 0 else _DIR_Y)[1 if up else 0]
    fixed_i = math.floor(fixed / grid)
    u = u0
    for _ in range(MAX_CELL_STEPS + 1):
        if (u >= u1 - 1e-9) if up else (u <= u1 + 1e-9):
            break
        if up:
            ci = math.floor(u / grid)
            nxt = min((ci + 1) * grid, u1)
        else:
            # Moving down, a position exactly on a boundary is LEAVING the cell
            # above it, so the cell it is in is the one below.
            ci = math.ceil(u / grid) - 1
            nxt = max(ci * grid, u1)
        seg = abs(nxt - u)
        if seg > 1e-9:
            out.append((((ci, fixed_i) if axis == 0 else (fixed_i, ci)), dirn, seg))
        u = nxt
    return out


def _route_steps(pts, grid: float) -> tuple[list, dict]:
    """``(steps, corners)`` for a route: the cells it occupies and where it turns.

    ``corners`` maps a step INDEX to the route corner reached after that step, so
    the replay can keep emitting exactly one keyframe per corner while the walk
    itself is executed cell by cell. Both come out of one pass on purpose: two
    passes that disagree would put the drawn turn on the wrong cell."""
    if grid <= 0:
        grid = 1.0
    steps: list[tuple[tuple[int, int], str, float]] = []
    corners: dict[int, tuple[float, float]] = {}
    for a, b in zip(pts, pts[1:]):
        steps += _axis_steps(a[0], b[0], a[1], grid, 0)   # horizontal at y = ay
        steps += _axis_steps(a[1], b[1], b[0], grid, 1)   # vertical at x = bx
        if len(steps) > MAX_CELL_STEPS:
            return [], {}                                 # never-blocks (see above)
        corners[len(steps)] = (float(b[0]), float(b[1]))
    return steps, corners


def _cell_steps(pts, grid: float) -> list:
    """``[(cell, direction, metres)]`` an agent traverses along the route ``pts``.

    Same lattice as :func:`routing.leg_cells` (the congestion heatmap's, pitched
    by ``simulation.heatmap_grid_m``) and the same L-shaped x-then-y decomposition
    of a non-axis-aligned leg, so a walk's contended cells and its heat cannot
    disagree. Graph routes are already axis-aligned, so their legs yield one axis
    run each and the L never fires."""
    return _route_steps(pts, grid)[0]


def _walk_contended(world: World, w: Worker, d: float, total_t: float,
                    state: str, emit, emit_wait, pts) -> float:
    """Walk the route ``pts`` cell by cell, queueing behind whoever is in the way.

    **The model.** Each ``(cell, direction)`` of the walking lattice is a capacity-1
    resource. An agent seizes the cell it is about to enter, holds it for that
    cell's share of the leg's travel time, then releases it. A second agent
    entering the same cell the same way therefore waits for the first to clear —
    the aisle congestion the free-passage engine could not see. Opposite and
    crossing directions are independent: an aisle is wide enough to pass someone
    coming towards you, not wide enough to overtake someone ahead of you.

    **Deadlock is structural, not lucky.** The wait happens at the cell BOUNDARY
    and the agent holds nothing while it waits — the cell behind it is released
    *before* the next one is requested. Hold-and-wait, one of the four necessary
    conditions for circular wait, therefore never occurs, so no set of agents can
    close a cycle no matter how the routes are drawn. The forced pass below exists
    only for the residual liveness risk (several agents released at the same
    instant contending for one cell), never for correctness.

    **never-blocks.** Waiting past ``aisle_wait_cap`` x this cell's own traversal
    time gives up the request and walks through anyway, logging
    ``aisle_pass_forced``. A simulation that stalls tells the salesperson nothing.

    **What is in scope.** Everything that travels through ``_walk``: pickers (the
    pick sweep and the carry to pack/belt), 仮置き/梱包 carries, forklift putaway
    and 補充要員 replenishment trips. AGV travel does NOT go through ``_walk`` —
    it has its own coarser segment-mutex model (``process.agv_interference`` /
    :func:`_agv_travel`), which stays exactly as it was.

    Distance is untouched (``d`` is the same routed distance the free-passage walk
    charged); only TIME grows, by the seconds actually spent waiting.
    """
    env = world.env
    # ``corners`` keeps the replay at ONE keyframe per route corner: a keyframe per
    # cell would multiply the payload by the leg length in metres for no visible gain.
    steps, corners = _route_steps(pts, world.grid_m)
    span = sum(s[2] for s in steps)
    if not steps or span <= 1e-9:
        # Degenerate route (a zero-length walk, or a leg too long for the lattice
        # guard): fall back to the free-passage single timeout, exactly as the
        # legacy body does for a zero-length path.
        yield env.timeout(total_t)
        if world.recording():
            emit(pts[-1][0], pts[-1][1])
        return d
    for i, (cell, dirn, seg_m) in enumerate(steps):
        dt = total_t * seg_m / span
        if dt > 1e-9:
            lock = world.aisle_cell((cell[0], cell[1], dirn))
            req = lock.request()
            wait_start = env.now
            # Reneging request: race the cell against the forced-pass deadline. The
            # agent holds NOTHING here — the cell behind it was released last
            # iteration, so it can never be part of a hold-and-wait cycle.
            result = yield req | env.timeout(world.aisle_wait_cap * dt)
            waited = env.now - wait_start
            acquired = req in result
            if not acquired:
                # Give the request up completely. ``cancel`` alone is not enough:
                # if the cell was granted in the SAME instant the deadline fired,
                # the condition resolves on the timeout while the request is
                # already triggered — and a triggered request cancel() ignores
                # would hold that cell for the rest of the run, permanently
                # jamming an aisle nobody is standing in. ``release`` is the other
                # half of what ``with resource.request()`` does on exit, and it
                # tolerates a request that was never granted.
                req.cancel()
                lock.release(req)
                world.log(t=env.now, event="aisle_pass_forced", resource="aisle",
                          worker=w.id, cell=[cell[0], cell[1]], dirn=dirn, wait=waited)
            elif waited > 1e-9:
                world.log(t=env.now, event="aisle_wait", resource="aisle",
                          worker=w.id, cell=[cell[0], cell[1]], dirn=dirn, wait=waited)
            # A long stand-still is worth drawing: without it the replay lerps the
            # agent smoothly across a cell it actually stood still in front of.
            # "idle" is deliberate — the replay contract has no "wait" state and
            # inventing one would break every existing viewer.
            if waited > WAIT_KEYFRAME_S and world.recording():
                here = _step_point(pts, steps, i)
                emit_wait(here[0], here[1])
            yield env.timeout(dt)
            if acquired:
                lock.release(req)
        corner = corners.get(i + 1)
        if corner is not None and world.recording():
            emit(corner[0], corner[1])
    return d


def _step_point(pts, steps, i: int) -> tuple[float, float]:
    """Where the agent stands at the START of step ``i`` — the boundary it waits at.

    Walks the route's arc length up to that step. Replay-only (it never touches the
    clock), so an approximation here can never move a number."""
    want = sum(s[2] for s in steps[:i])
    acc = 0.0
    for a, b in zip(pts, pts[1:]):
        leg = [(a[0], a[1]), (b[0], a[1]), (b[0], b[1])]
        for p, q in zip(leg, leg[1:]):
            seg = abs(q[0] - p[0]) + abs(q[1] - p[1])
            if seg <= 1e-9:
                continue
            if acc + seg >= want - 1e-9:
                f = (want - acc) / seg
                return (p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f)
            acc += seg
    return (float(pts[-1][0]), float(pts[-1][1]))


def _walk(world: World, w: Worker, frm, to, speed: float, state: str, also=None):
    """``also`` (optional) mirrors every emitted keyframe onto extra replay tracks
    (the totes riding in this agent's hands), so goods follow the SAME real route
    as the worker carrying them. Replay-only: timing is untouched.

    With ``simulation.aisle_interference`` on, the walk is handed to
    :func:`_walk_contended`, which queues the agent behind whoever else is in the
    same aisle cell. OFF (the default) the body below is untouched — same single
    timeout, same keyframes, same RNG draw order."""
    d = world.dist(frm, to)            # measured override > wall-aware graph > Manhattan
    _accumulate_heat(world, frm, to)
    total_t = (d / speed) if speed > 0 else 0.0

    def _emit(x, y):
        w.kf(world.env.now, x, y, state)
        for tk in (also or ()):
            tk.kf(world.env.now, x, y, state)

    def _emit_wait(x, y):
        """A stand-still keyframe: the WORKER is idle, but the totes in its hands
        are still being carried — their state vocabulary has no 'idle'."""
        w.kf(world.env.now, x, y, "idle")
        for tk in (also or ()):
            tk.kf(world.env.now, x, y, state)

    if world.aisle_cells is not None and total_t > 1e-9:
        # 通路干渉 ON: same route, same distance, same corner keyframes — the walk
        # is merely interrupted wherever another agent is already in the cell.
        pts = world.path(frm, to)
        if world.recording():
            _emit(pts[0][0], pts[0][1])
        yield from _walk_contended(world, w, d, total_t, state, _emit, _emit_wait, pts)
        return d

    if not world.recording():
        yield world.env.timeout(total_t)
        return d
    # Emit the REAL aisle route as intermediate keyframes so the viewer (which lerps
    # between keyframes) makes the worker FOLLOW the aisles instead of cutting
    # straight through shelves. Total travel time is unchanged (d/speed): each
    # segment takes its share of the time, proportional to its on-route length.
    pts = world.path(frm, to)
    seglens = [((pts[i][0] - pts[i - 1][0]) ** 2 + (pts[i][1] - pts[i - 1][1]) ** 2) ** 0.5
               for i in range(1, len(pts))]
    pathlen = sum(seglens)
    _emit(pts[0][0], pts[0][1])
    if pathlen <= 1e-9:
        yield world.env.timeout(total_t)
        if world.recording():
            end = world.stand(to)
            _emit(end[0], end[1])
        return d
    for i in range(1, len(pts)):
        yield world.env.timeout(total_t * seglens[i - 1] / pathlen)
        if world.recording():
            _emit(pts[i][0], pts[i][1])
    return d


def _route_order(world: World, start, pts: list) -> list[int]:
    """Visiting order (indices into `pts`). Strategy shapes the route:
    discrete/batch/wave use nearest-neighbour; zone walks a strict S-shape by
    aisle column (no backtracking), modelling disciplined zone/aisle picking.

    ADDITIVE: when ``world.routing_policy == "optimized"`` the greedy/NN seed is
    improved with picktour 2-opt (shorter tours). This branch is opt-in only, so
    the default path below is byte-identical to the legacy engine."""
    if world.routing_policy == "optimized" and len(pts) > 2:
        from whsim.picktour import optimize
        return optimize(start, pts, world.dist)
    # Named picker-routing disciplines (s_shape / return / largest_gap): pure
    # visit-order policies over the pick points' own aisle structure. ADDITIVE —
    # any other value falls through to the historical branches below.
    if world.routing_policy in ("s_shape", "return", "largest_gap") and pts:
        from whsim.engine.pickroute import route_order
        return route_order(world.routing_policy, start, pts)
    if world.pick_strategy == "zone" and pts:
        # rank by actual aisle column (distinct x positions), serpentine in y
        cols = sorted({round(p[0], 1) for p in pts})
        rank = {c: r for r, c in enumerate(cols)}
        return sorted(range(len(pts)),
                      key=lambda i: (rank[round(pts[i][0], 1)],
                                     pts[i][1] if rank[round(pts[i][0], 1)] % 2 == 0
                                     else -pts[i][1]))
    return nearest_neighbor_route(start, pts)


def _board_conveyor(world: World, p):
    """Where a picker standing at ``p`` hands its totes to a belt.

    Returns ``(line, boarding_xy, arc)`` — the conveyor whose PATH runs nearest
    (each line projected onto its own segments, so boarding lands on the belt
    beside the picker, not on a far-away vertex), the boarding point, and its arc
    length from that line's infeed (how much belt is already behind it). ``None``
    when no conveyor is active. Lines are compared by walking (Manhattan) distance
    to their projected point, matching the metric the picker actually walks.

    Only the line's ENTRANCES are offered (``World.entry_conveyors``): on a chained
    line the 本線 and the 引き込み run right through the pick area, so boarding one
    of those would drop the tote in halfway down the chain — past the very stretch
    whose jam is supposed to reach back to this picker. With no chain authored the
    list is every active belt, i.e. the historical choice."""
    best = None
    for line in (world.entry_conveyors or world.conveyors):
        xy, arc = line.project(p)
        d = manhattan(p, xy)
        if best is None or d < best[0]:
            best = (d, line, xy, arc)
    if best is None:
        return None
    return best[1], best[2], best[3]


def putaway_source(world: World, rng: random.Random):
    """Generate inbound putaway tasks at a rate tied to outbound throughput
    (replenishment scales with demand) -- so forklift activity is data-driven,
    not decorative. A pallet covers several order-lines, hence the 0.3 factor."""
    env = world.env
    prof = world.model.orders.profile
    if world.model.orders.outbound:
        out_per_hr = len(world.model.orders.outbound) / max(
            world.model.simulation.duration_s / 3600.0, 1e-9)
    else:
        out_per_hr = prof.rate_per_hr * max(prof.peak_factor, 0.0)
    rate_per_s = max(out_per_hr * 0.3, 0.0) / 3600.0
    if rate_per_s <= 0:
        return
    # When inbound inspection is enabled, receipts queue for an inspector first;
    # otherwise they go straight to the forklift putaway queue (legacy).
    dest = world.inbound_store if world.inbound_store is not None else world.fork_store
    while env.now < world.model.simulation.duration_s:
        yield env.timeout(rng.expovariate(rate_per_s))
        yield dest.put(rng.choice(world.slot_xy))


def inspector_agent(world: World, ins: Worker, station_xy):
    """A dedicated 入荷検品 agent: pull a receipt from the inbound queue, inspect it
    at the dock, then release it to forklift putaway. One process per inspector, so
    inspector headcount is the stage's real constraint; inbound WIP is the queue it
    drains. Emits its own keyframes + inspect_done events for KPIs/replay."""
    env = world.env
    sx, sy = station_xy
    t_insp = world.inspect_time_s
    if world.recording():
        ins.kf(env.now, sx, sy, "idle")
    while True:
        slot = yield world.inbound_store.get()    # waits when no inbound work
        start = env.now
        if world.recording():
            ins.kf(env.now, sx, sy, "inspect")
        yield env.timeout(t_insp)
        world.log(t=env.now, event="inspect_done", busy=env.now - start,
                  resource="inspector", worker=ins.id)
        yield world.fork_store.put(slot)           # hand off to forklift putaway
        if world.recording():
            ins.kf(env.now, sx, sy, "idle")


def _do_putaway(world: World, f: Worker, slot):
    """One inbound putaway trip: ferry a pallet dock -> storage slot -> dock."""
    env = world.env
    trip_start = env.now
    # Both legs follow the REAL aisle route (``_walk``), so a forklift no longer
    # teleports through the racking on its way to a slot.
    yield from _walk(world, f, world.fork_home, slot, world.fork_speed, "putaway")
    yield env.timeout(8.0)  # place the pallet
    yield from _walk(world, f, slot, world.fork_home, world.fork_speed, "putaway")
    if world.recording():
        f.kf(env.now, world.fork_home[0], world.fork_home[1], "idle")
    world.log(t=env.now, event="forklift_done", busy=env.now - trip_start,
              resource="forklift", worker=f.id)


def forklift_agent(world: World, f: Worker, rng: random.Random):
    """Inbound putaway: pull a task, ferry a pallet dock -> storage slot -> dock.

    When replenishment is enabled WITHOUT dedicated replenishers, the same
    forklift fleet also drains the replenishment queue. We wait on BOTH stores
    with ``any_of`` and cancel the untaken get (SimPy's clean two-queue idiom);
    replenishment is serviced first when both fire at once, so an empty pick face
    (a picker blocked) takes priority over decorative inbound putaway."""
    env = world.env
    pos = world.fork_home
    if world.recording():
        f.kf(env.now, pos[0], pos[1], "idle")
    if world.replen_shared_forklift:
        while True:
            gr = world.replen_store.get()
            gf = world.fork_store.get()
            res = yield env.any_of([gr, gf])
            if gr in res:
                yield from _do_replenish(world, f, res[gr])
            else:
                gr.cancel()
            if gf in res:
                yield from _do_putaway(world, f, res[gf])
            else:
                gf.cancel()
        return
    while True:
        slot = yield world.fork_store.get()   # waits when there is no inbound work
        yield from _do_putaway(world, f, slot)


def _do_replenish(world: World, w: Worker, face: dict):
    """Service one replenishment task: travel reserve(fork_home) -> face, place,
    top the face up to its refill target, release any blocked picker (fire the
    face's replenished event), then return. Emits a ``replenish_done`` event."""
    env = world.env
    home = world.fork_home
    dest = face["xy"]
    fspeed = max(world.fork_speed, 0.1)
    start = env.now
    d1 = yield from _walk(world, w, home, dest, fspeed, "putaway")
    yield env.timeout(world.replen_place_s)   # top-up / place time
    # Refill the face and wake any pickers blocked on it BEFORE the return trip.
    face["qty"] = max(face["qty"], face["refill_to"])
    face["pending"] = False
    ev = face["event"]
    if ev is not None and not ev.triggered:
        face["event"] = None
        ev.succeed()
    yield from _walk(world, w, dest, home, fspeed, "putaway")
    if world.recording():
        w.kf(env.now, home[0], home[1], "idle")
    world.log(t=env.now, event="replenish_done", busy=env.now - start,
              dist=d1, loc=face["loc_id"], sku=face["sku"],
              resource="replenisher", worker=w.id)


def replenisher_agent(world: World, w: Worker):
    """A dedicated 補充要員: pull replenishment tasks and top the pick faces up.
    One process per replenisher, so the replenisher headcount is the stage's real
    constraint. Uses the forklift dock (``fork_home``) as the reserve source."""
    env = world.env
    if world.recording():
        w.kf(env.now, world.fork_home[0], world.fork_home[1], "idle")
    while True:
        face = yield world.replen_store.get()   # waits when no replenishment work
        yield from _do_replenish(world, w, face)


def _enqueue_replen(world: World, face: dict) -> None:
    """Queue ONE replenishment task for a face at/below its trigger. The
    ``pending`` flag dedups: no second task is queued for the same face until the
    current one completes (avoids a flood of tasks as qty crosses the trigger)."""
    if not face["pending"] and face["qty"] <= face["trigger"]:
        face["pending"] = True
        world.replen_store.put(face)   # unbounded store => put is synchronous


def _consume_face(world: World, w: Worker, xy, qty: int):
    """Decrement the pick face at ``xy`` by ``qty`` (真の在庫). An EMPTY face
    BLOCKS the picker on that face's replenished event (emitting a ``stockout_wait``
    with the wait seconds) until a replenishment tops it up. A position with no
    tracked face is infinite stock and returns immediately (never blocks)."""
    face = world.face_at(xy)
    if face is None:
        return
    env = world.env
    while face["qty"] <= 0:
        _enqueue_replen(world, face)
        ev = face["event"]
        if ev is None:
            ev = env.event()
            face["event"] = ev
        wait_start = env.now
        yield ev
        world.log(t=env.now, event="stockout_wait", wait=env.now - wait_start,
                  loc=face["loc_id"], sku=face["sku"],
                  resource="picker", worker=w.id)
    face["qty"] -= qty
    _enqueue_replen(world, face)


_GROUND = (0.0, 1, "manual", 0.0)  # default pick meta: ground 段, no vertical time


def _order_points(world: World, order: Order):
    """Parallel (points, qtys, tss, vss): vss[i] = (vertical_seconds, 段, mover,
    height_m) for picking each SKU's level — used for both the time and the
    2D/3D vertical animation. Ground/golden 段1 = (0, 1, 'manual', 0)."""
    pts, qtys, tss, vss = [], [], [], []
    for line in order.lines:
        xy = world.sku_xy.get(line.sku)
        if xy is None:
            continue
        pts.append(xy)
        qtys.append(line.qty)
        tss.append(world.sku_ts.get(line.sku, 1.5))
        vss.append(world.sku_pick.get(line.sku, _GROUND))
    return pts, qtys, tss, vss


def _agv_seg_key(a, b) -> tuple[int, int, bool]:
    """A COARSE aisle-segment id for one corner-to-corner AGV leg: the midpoint
    cell quantised to ~3 m plus the leg orientation. Coarse enough to be cheap
    (few distinct keys), fine enough that two AGVs in the same aisle stretch map
    to the SAME key and therefore contend on the same capacity-1 mutex."""
    midx = (a[0] + b[0]) / 2.0
    midy = (a[1] + b[1]) / 2.0
    horizontal = abs(b[0] - a[0]) >= abs(b[1] - a[1])
    return (round(midx / 3.0), round(midy / 3.0), horizontal)


def _route_keyframes(world: World, frm, to, t0: float, total_t: float):
    """Interior corners of the real route frm→to, each with the time it is reached.

    Yields ``(t, (x, y))`` for the corners BETWEEN the endpoints, spaced by arc
    length so the drawn agent moves at a constant speed along the route and
    arrives exactly at ``t0 + total_t``. The caller emits the endpoints itself,
    so an empty yield degrades to the straight two-keyframe track.

    Pure viz: it reads the graph but never touches the SimPy clock, so a caller
    can add real waypoints to a move without perturbing its timing.
    """
    if total_t <= 0.0:
        return
    pts = world.path(frm, to)
    if len(pts) < 3:
        return
    seglens = [((pts[i][0] - pts[i - 1][0]) ** 2 + (pts[i][1] - pts[i - 1][1]) ** 2) ** 0.5
               for i in range(1, len(pts))]
    pathlen = sum(seglens)
    if pathlen <= 1e-9:
        return
    acc = 0.0
    for i in range(1, len(pts) - 1):
        acc += seglens[i - 1]
        yield t0 + total_t * acc / pathlen, pts[i]


def _agv_travel(world: World, a: Worker, frm, to, depart_state: str, arrive_state: str):
    """One AGV travel move frm→to. Returns the travel distance.

    Interference OFF (``world.aisle_locks is None``): the legacy single-timeout
    move — byte-identical to the pre-feature engine (same distance, same two
    keyframes). Interference ON: walk the real aisle-graph waypoints, and for each
    corner-to-corner leg seize that leg's coarse segment mutex, hold it for the
    leg's traversal time, then release — so two AGVs can never occupy the same
    aisle stretch at once (extra AGVs queue). Waiting on a lock accumulates an
    ``agv_conflict`` event; a wait past ``agv_deadlock_s`` emits a one-shot
    ``agv_deadlock_warning`` and FORCE-PROCEEDS without the lock (an honest escape
    hatch — detection only, no resolution). Total travel time is still ≥ the
    unencumbered ``d / speed`` (the leg timeouts sum to it, plus any lock waits)."""
    env = world.env
    d = world.dist(frm, to)
    _accumulate_heat(world, frm, to)
    speed = world.agv_speed
    total_t = (d / speed) if speed > 0 else 0.0

    if world.aisle_locks is None:
        # Interference OFF: ONE timeout for the whole move, exactly as before, so
        # the event log, the KPIs and every downstream RNG draw are unchanged.
        # Only the replay TRACK is different: we emit the aisle route's corners
        # with back-dated timestamps, so the drawn AGV follows the aisles it was
        # actually charged for. Emitting two keyframes drew a straight line
        # through the racking (100% of legs in ecommerce_xl) at ~1/7 the real
        # speed, because world.dist had already charged the routed distance.
        # Timestamps are computed, not waited on -- kf() takes an explicit t.
        t0 = env.now
        if world.recording():
            start = world.stand(frm)
            a.kf(t0, start[0], start[1], depart_state)
        yield env.timeout(total_t)
        if world.recording():
            for t_i, p in _route_keyframes(world, frm, to, t0, total_t):
                a.kf(t_i, p[0], p[1], "travel")
            end = world.stand(to)
            a.kf(env.now, end[0], end[1], arrive_state)
        return d

    # --- interference ON: walk waypoints under per-segment mutexes ------------
    pts = world.path(frm, to)
    seglens = [((pts[i][0] - pts[i - 1][0]) ** 2 + (pts[i][1] - pts[i - 1][1]) ** 2) ** 0.5
               for i in range(1, len(pts))]
    pathlen = sum(seglens)
    if world.recording():
        # Endpoints are drawn at the aisle FACE (World.stand), not on the rack
        # centre-line a slot is addressed at -- otherwise the last metre of the
        # move is drawn straight into the racking. Only the DRAWN position moves;
        # ``pts`` still drives the segment mutexes and the timing below.
        start = world.stand(frm)
        a.kf(env.now, start[0], start[1], depart_state)
    if pathlen <= 1e-9 or total_t <= 0.0:
        yield env.timeout(total_t)
        if world.recording():
            end = world.stand(to)
            a.kf(env.now, end[0], end[1], arrive_state)
        return d
    for i in range(1, len(pts)):
        p0, p1 = pts[i - 1], pts[i]
        leg_t = total_t * seglens[i - 1] / pathlen
        seg = _agv_seg_key(p0, p1)
        lock = world.aisle_lock(seg)
        req = lock.request()
        wait_start = env.now
        # Reneging request: race the lock against the deadlock threshold.
        result = yield req | env.timeout(world.agv_deadlock_s)
        waited = env.now - wait_start
        acquired = req in result
        if not acquired:
            # Deadlock detected: give up the request and force-proceed WITHOUT the
            # lock (honest escape hatch — no resolution/replanning). One warning.
            req.cancel()
            world.log(t=env.now, event="agv_deadlock_warning", seg=repr(seg),
                      wait=waited, resource="agv", worker=a.id)
        elif waited > 1e-9:
            world.log(t=env.now, event="agv_conflict", seg=repr(seg),
                      wait=waited, resource="agv", worker=a.id)
        yield env.timeout(leg_t)                 # traverse the leg
        if acquired:
            lock.release(req)
        if world.recording():
            last = i == len(pts) - 1
            state = arrive_state if last else "travel"
            at = world.stand(to) if last else p1
            a.kf(env.now, at[0], at[1], state)
    return d


def agv_agent(world: World, a: Worker):
    """AGV: pull an order, fetch its totes (move!), drop into the ready queue.

    Travel is delegated to :func:`_agv_travel`, which is byte-identical to the
    legacy move when AGV通路干渉 is off and seizes coarse aisle-segment mutexes
    (so extra AGVs queue in shared corridors) when it is on."""
    env = world.env
    pos = world.agv_home
    if world.recording():
        a.kf(env.now, pos[0], pos[1], "idle")
    while True:
        item = yield world.order_store.get()
        order = item["order"]
        points, _, _, _ = _order_points(world, order)
        # The AGV honours the SAME routing_policy dial as the pickers, so a
        # scenario JSON switches the fleet's discipline too. Only the EXPLICIT
        # policies divert; anything else (incl. the zone strategy's serpentine,
        # which is a picker-band concept) keeps the historical NN tour, so an
        # unstated policy is byte-identical.
        if world.routing_policy in ("s_shape", "return", "largest_gap") and points:
            from whsim.engine.pickroute import route_order as _pr_order
            route = [points[i] for i in _pr_order(world.routing_policy,
                                                  world.agv_home, points)]
        elif world.routing_policy == "optimized" and len(points) > 2:
            from whsim.picktour import optimize
            route = [points[i] for i in optimize(world.agv_home, points, world.dist)]
        else:
            route = [points[i] for i in nearest_neighbor_route(world.agv_home, points)]
        trip_start = env.now
        cur = world.agv_home
        for dest in route:
            yield from _agv_travel(world, a, cur, dest, "travel", "pickup")
            cur = dest
        yield from _agv_travel(world, a, cur, world.agv_home, "dropoff", "idle")
        world.log(t=env.now, event="agv_done", busy=env.now - trip_start,
                  resource="agv", worker=a.id)
        yield world.ready_store.put(item)


def _pull_batch(world: World, source, first):
    """First order plus up to orders_per_trip-1 more (B axis: まとめ度).

    Release (E axis): "wave" waits a release window so a fuller batch of orders
    accumulates before the sweep starts; "continuous" pulls whatever is already
    waiting. 種まき (sort) is inherently a wave-like total pick, so it also waits.
    """
    batch = [first]
    if world.batch_size <= 1 and world.consolidation != "sort":
        return batch
    if world.release == "wave":
        # Accumulate over the wave bucket, capped so the sim stays responsive.
        yield world.env.timeout(min(world.wave_interval_s, 120.0))
    elif world.consolidation == "sort":
        yield world.env.timeout(30.0)  # let a total-pick batch pile up
    while len(batch) < world.batch_size and source.items:
        batch.append((yield source.get()))
    return batch


def _totals_points(world: World, orders: list[Order]):
    """種まき (total picking): aggregate the batch's lines into SKU TOTALS, so a
    SKU stored in one place is visited ONCE for the whole batch (not per order).
    Returns parallel (points, qtys, tss, vss) lists keyed by distinct SKU."""
    totals: dict[str, int] = {}
    for o in orders:
        for line in o.lines:
            if world.sku_xy.get(line.sku) is None:
                continue
            totals[line.sku] = totals.get(line.sku, 0) + line.qty
    pts, qtys, tss, vss = [], [], [], []
    for sku, qty in totals.items():
        pts.append(world.sku_xy[sku])
        qtys.append(qty)
        tss.append(world.sku_ts.get(sku, 1.5))
        vss.append(world.sku_pick.get(sku, _GROUND))
    return pts, qtys, tss, vss


def _walk_route(world: World, w: Worker, start, points, qtys, tss, vss, speed):
    """Walk a routed sweep over `points`, picking each (handle = qty*ts + vertical
    access for the 段). Returns (end_position, total_distance). No pack."""
    pos = start
    total = 0.0
    for idx in _route_order(world, pos, points):
        dest = points[idx]
        total += yield from _walk(world, w, pos, dest, speed, "travel")
        pos = dest
        # 在庫補充連鎖: decrement this face's on-hand and BLOCK here if it is empty
        # (waits for a replenishment). No-op when replenishment is disabled.
        if world.replen_faces is not None:
            yield from _consume_face(world, w, dest, qtys[idx])
        vert_s, lv, by, h = vss[idx]
        if world.recording():
            # Upper 段 carry a meta dict so the 2D/3D replay raise the picker/forklift
            # to the level height; 段1 stays a clean 4-tuple (legacy contract).
            meta = {"lv": lv, "by": by, "h": h} if lv > 1 else None
            # Stand at the aisle face of the slot (see World.stand), not on the
            # rack centre-line the slot is addressed at.
            face = world.stand(pos)
            w.kf(world.env.now, face[0], face[1], "pick", meta)
        # handle = horizontal unit handling + vertical 段 access (lift/reach); the
        # replay dwell at this keyframe lengthens with the vertical time.
        yield world.env.timeout(qtys[idx] * tss[idx] + vert_s)
    return pos, total


def _pick_zone(world: World, w: Worker, results: dict, key, start,
               points, qtys, tss, vss, speed):
    """A parallel-zone sub-pick: walk this zone's points, store (dist) by key.
    Runs as its own SimPy process so zones progress concurrently (C: parallel)."""
    _pos, dist = yield from _walk_route(world, w, start, points, qtys, tss, vss, speed)
    results[key] = results.get(key, 0.0) + dist


def _split_by_zone(world: World, points, qtys, tss, vss):
    """Group parallel (points, qtys, tss, vss) by their picking zone (C axis).
    Returns {zone_index: (points, qtys, tss, vss)} in ascending zone order."""
    buckets: dict[int, tuple[list, list, list, list]] = {}
    for p, q, t, v in zip(points, qtys, tss, vss):
        z = world.zone_of(p)
        bp, bq, bt, bv = buckets.setdefault(z, ([], [], [], []))
        bp.append(p)
        bq.append(q)
        bt.append(t)
        bv.append(v)
    return dict(sorted(buckets.items()))


def _pick_phase(world: World, w: Worker, pos, points, qtys, tss, vss, speed):
    """Walk-and-pick a sweep honouring the zoning (C) axis. Returns
    (end_position, total_distance).

    * none       — one nearest-neighbour / S-shape sweep over all points.
    * sequential — pick-and-pass relay: walk the zones in spatial order, one
      after another (a single worker stands in for the relay's combined travel,
      so the route is disciplined zone-by-zone rather than free-roaming).
    * parallel   — split points across zones and pick them CONCURRENTLY as
      separate sub-processes, then join. Travel is the max zone leg (zones
      progress at once), not the sum, so parallel zoning cuts makespan.
    """
    if not points:
        return pos, 0.0

    if world.zoning == "none" or world.n_zones <= 1:
        return (yield from _walk_route(world, w, pos, points, qtys, tss, vss, speed))

    buckets = _split_by_zone(world, points, qtys, tss, vss)

    if world.zoning == "parallel":
        # Launch one sub-process per zone; they run at the same simulated time.
        # Each concurrent leg gets its OWN replay track (a helper sub-worker), so
        # the keyframes never interleave on a single worker (which would make it
        # teleport between zones). The primary worker `w` coordinates and stays
        # put for the parallel sweep, marked idle at `pos` for the makespan.
        results: dict[int, float] = {}
        procs = []
        if world.recording():
            w.kf(world.env.now, pos[0], pos[1], "idle")
        for z, (bp, bq, bt, bv) in buckets.items():
            helper = world.helper_for(w, z)
            procs.append(world.env.process(
                _pick_zone(world, helper, results, z, pos, bp, bq, bt, bv, speed)))
        for p in procs:
            yield p
        # makespan = the slowest zone (they overlapped), distance = sum walked.
        total = sum(results.values())
        if world.recording():
            w.kf(world.env.now, pos[0], pos[1], "idle")
        return pos, total

    # sequential (pick-and-pass relay): traverse zones in order, sweeping each.
    total = 0.0
    for _z, (bp, bq, bt, bv) in buckets.items():
        pos, d = yield from _walk_route(world, w, pos, bp, bq, bt, bv, speed)
        total += d
    return pos, total


def _sort_phase(world: World, w: Worker, orders, pos):
    """種まき put-wall stage (D, consolidation == "sort"): after a total pick,
    distribute the swept lines to destination orders. The wall is a capacitated
    SimPy resource, so when sorting can't keep up the lines queue (back-pressure
    like a real DAS / put-to-light wall). Each line costs sort_time_s."""
    env = world.env
    n_lines = sum(len(o.lines) for o in orders)
    if n_lines <= 0 or world.sort_time_s <= 0:
        return
    req = world.put_wall.request()
    wait_t = env.now
    yield req
    seize_t = env.now
    if world.recording():
        w.kf(env.now, pos[0], pos[1], "sort")
    yield env.timeout(n_lines * world.sort_time_s)
    world.put_wall.release(req)
    world.log(t=env.now, event="sort_done", order_id=orders[0].order_id,
              wait=seize_t - wait_t, busy=env.now - seize_t,
              n_lines=n_lines, resource="put_wall", worker=w.id)


def _chute_of(order: Order, n_chutes: int) -> int:
    """Destination chute for an order = a stable hash of its id modulo the chute
    count. crc32 (not Python's salted hash) keeps chute assignment reproducible
    across processes so runs are deterministic."""
    return zlib.crc32((order.order_id or "").encode("utf-8")) % max(1, n_chutes)


def _chute_release(world: World, cont, release_s: float):
    """A sorted line dwells in its chute, then the store carton is pulled and the
    line departs (the chute frees one slot). Runs as its own process so chutes
    drain concurrently with induction — that is what makes a full chute a genuine
    (temporary) back-pressure rather than a deadlock."""
    if release_s > 0:
        yield world.env.timeout(release_s)
    yield cont.get(1)


def _sorter_phase(world: World, w: Worker, orders, pos):
    """自動仕分け stage (D, consolidation=="sort" WITH a sorter Equipment placed):
    after a total pick the picker walks the tote to the sorter induction point and
    inducts the swept lines onto the machine, which routes each line to its
    destination chute. The sorter is capacitated by its induction channels
    (induction_workers); each line rides the sorter for 3600/rate seconds; each
    destination chute is a finite buffer (chute_capacity lines) that back-pressures
    induction when full — the RaLC-style トータルピッキング＆店舗別仕分け core.

    Emits one ``sorter_done`` event per line (busy=sort time, wait=induction-channel
    queue, chute_wait=chute back-pressure, chute index, blocked flag). Returns the
    picker's end position (the induction point)."""
    env = world.env
    s = world.sorter
    speed = max(world.model.process.walk_speed_mps, 0.1)
    # Walk the tote to the sorter induction point (its placed position, else here).
    induct = s["xy"] if s["xy"] is not None else pos
    if induct != pos:
        yield from _walk(world, w, pos, induct, speed, "carry")
        pos = induct
    n_lines = sum(len(o.lines) for o in orders)
    if n_lines <= 0 or s["sort_s"] <= 0:
        return pos
    if world.recording():
        w.kf(env.now, pos[0], pos[1], "sort")
    n_chutes = s["chutes"]
    containers = s["chute_containers"]
    induction = s["induction"]
    sort_s = s["sort_s"]
    release_s = s["release_s"]
    for o in orders:
        chute = _chute_of(o, n_chutes)
        cont = containers[chute]
        for _line in o.lines:
            req = induction.request()
            wait_t = env.now
            yield req                       # queue for a free induction channel
            seize_t = env.now
            yield env.timeout(sort_s)       # ride the sorter to the chute
            block_t = env.now
            yield cont.put(1)               # arrive at chute; blocks when full (back-pressure)
            chute_wait = env.now - block_t
            induction.release(req)          # channel held through the block => real back-pressure
            env.process(_chute_release(world, cont, release_s))
            world.log(t=env.now, event="sorter_done", order_id=o.order_id,
                      wait=seize_t - wait_t, busy=sort_s, chute=chute,
                      chute_wait=chute_wait, blocked=1 if chute_wait > 1e-6 else 0,
                      resource="sorter", worker=w.id)
    return pos


def picker_agent(world: World, w: Worker, rng: random.Random):
    env = world.env
    speed = max(world.model.process.walk_speed_mps, 0.1)
    pack_time = max(world.model.process.pack_time_s, 0.0)
    agv_mode = world.pick_method == "agv"
    source = world.ready_store if agv_mode else world.order_store
    pos = world.home
    if world.recording():
        w.kf(env.now, pos[0], pos[1], "idle")

    while True:
        first = yield source.get()
        # The picker is OCCUPIED from the moment it claims an order, not from the
        # moment it starts walking. A wave/種まき release then holds it at the gate
        # while its bucket fills (``_pull_batch``) -- it is committed and can do
        # nothing else, so that hold is trip time. Excluding it read a saturated
        # thirdparty_3pl (8036 orders in, 3282 out) as a comfortable 86% picker.
        # Continuous release waits not at all here, so this is a no-op for it.
        busy_start = env.now
        batch = yield from _pull_batch(world, source, first)
        orders = [b["order"] for b in batch]
        arrivals = [b["arrival"] for b in batch]
        world.log(t=env.now, event="pick_start", order_id=orders[0].order_id,
                  wait=env.now - arrivals[0], resource="picker", worker=w.id,
                  n_orders=len(orders))

        # D axis: 種まき(sort) sweeps SKU TOTALS across the batch (each SKU
        # visited once); 摘み取り(pick) sweeps every order line as-is.
        if world.consolidation == "sort":
            points, qtys, tss, vss = _totals_points(world, orders)
        else:
            points, qtys, tss, vss = [], [], [], []
            for o in orders:
                p, q, t, v = _order_points(world, o)
                points += p
                qtys += q
                tss += t
                vss += v
        # handle = horizontal unit handling + the 段(level) vertical access time.
        handle_time = sum(q * t for q, t in zip(qtys, tss)) + sum(v[0] for v in vss)

        total_dist = 0.0
        board = None            # (ConveyorLine, boarding xy, arc from infeed)
        totes: list = []        # per-order replay tracks (None entries = untracked)
        if agv_mode:
            # totes already delivered by the AGV; the picker only handles
            if world.recording():
                w.kf(env.now, pos[0], pos[1], "pick")
            yield env.timeout(handle_time)
            picker_busy = handle_time
        else:
            # Pick phase honours the C axis (none / sequential relay / parallel).
            pos, total_dist = yield from _pick_phase(
                world, w, pos, points, qtys, tss, vss, speed)
            # 種まき: distribute the totals to destination orders. An automatic
            # sorter (when a sorter Equipment is placed) inducts the lines onto the
            # machine and routes them to destination chutes; otherwise the manual
            # put wall is used (byte-identical legacy path when no sorter exists).
            if world.consolidation == "sort":
                if world.sorter is not None:
                    pos = yield from _sorter_phase(world, w, orders, pos)
                else:
                    yield from _sort_phase(world, w, orders, pos)
            # carry to pack: a conveyor (if present) takes the long haul, so the
            # picker only walks to the nearest point ON a belt's path.
            board = _board_conveyor(world, pos)
            drop = board[1] if board is not None else world.home
            # The totes ride in the picker's hands over this leg: give each one a
            # replay track (subject to the window/cap) and mirror the carry route
            # onto it, so goods MOVE with the worker instead of appearing at the belt.
            if board is not None:
                totes = [world.new_tote(o.order_id, kind=board[0].load_kind)
                         for o in orders]
            total_dist += yield from _walk(world, w, pos, drop, speed, "carry",
                                           also=[t for t in totes if t is not None])
            pos = drop
            picker_busy = env.now - busy_start

        dist_per_order = total_dist / len(orders)

        if board is not None and not agv_mode:
            # The conveyor decouples pick from pack: the picker hands each tote
            # to the belt and is free again. So its busy time ends here (pick +
            # carry), logged now; packing happens downstream on its own process.
            world.log(t=env.now, event="pick_done", order_id=orders[0].order_id,
                      busy=picker_busy, dist=total_dist, lines=len(points),
                      resource="picker", worker=w.id)
            line, _board_xy, arc = board
            ride_m = line.remaining(arc)
            transit = ride_m / line.speed
            # Hand each tote to THIS line. Acquiring one of its slots BLOCKS when
            # that belt is full (downstream pack can't keep up) -> the jam
            # propagates back to the picker. The tote then rides the belt from its
            # boarding point to the discharge end and packs there, holding its slot
            # the whole time, modelling real accumulation.
            # Chained line (this belt hands on, a 引き込み branches off it, or a
            # 停止線 sorts what rides it) vs the single-belt line the engine has
            # always had. The branch is decided by the topology resolved at BUILD
            # time, so an unchained model takes the legacy code path unchanged —
            # same events, same RNG draws.
            chained = (line.next_line is not None or bool(line.junctions)
                       or line.gate is not None)
            for o, arr, tote in zip(orders, arrivals, totes):
                # 容器の有限確保: goods can only be PUT ON the line inside a
                # container, so an empty pool stops 投入 right here — the picker
                # stands at the belt holding the goods and the shortage backs up
                # into picking. No pool ⇒ not even a branch is taken (byte-identical).
                held_from = yield from _take_container(world, o)
                req_t = env.now
                slot = line.belt.request()
                yield slot   # blocks here when the conveyor is jammed
                waited = env.now - req_t
                world.log(t=env.now, event="conveyor_on", order_id=o.order_id,
                          resource="conveyor", conveyor=line.id, wait=waited,
                          blocked=1 if waited > 1e-6 else 0,
                          transit=transit, ride_m=ride_m,
                          leg=0, entry=1)
                ride = _convey_chain if chained else _convey_tote
                env.process(ride(world, o, arr, line, arc, slot,
                                 dist_per_order, tote,
                                 kind=line.load_kind, held_from=held_from))
            if world.recording():
                w.kf(env.now, pos[0], pos[1], "idle")
            continue

        # 仮置き(staging) path (manual only): decouple pick from pack. The picker
        # drops each tote into a FINITE staging buffer and is free again; dedicated
        # packer agents pull from it downstream. staging.put() BLOCKS when the
        # buffer is full -> real back-pressure to the picker (and explicit pack-WIP).
        # Deadlock-safe: the picker never consumes staging, so it never waits on
        # itself; only the dedicated packer_agent drains it.
        if world.staging is not None and not agv_mode:
            # picker busy = pick + carry only (packing is the packer's time now).
            world.log(t=env.now, event="pick_done", order_id=orders[0].order_id,
                      busy=picker_busy, dist=total_dist, lines=len(points),
                      resource="picker", worker=w.id)
            for o, arr in zip(orders, arrivals):
                tote = {"order": o, "arrival": arr, "ready_at": env.now,
                        "dist": dist_per_order}
                put_start = env.now
                yield world.staging.put(tote)   # blocks when staging is full
                blocked = env.now - put_start
                if blocked > 1e-6:
                    world.log(t=env.now, event="staging_block", order_id=o.order_id,
                              blocked=blocked, resource="staging", worker=w.id)
                world.log(t=env.now, event="staging_put", order_id=o.order_id,
                          wip=len(world.staging.items), resource="staging")
            if world.recording():
                w.kf(env.now, pos[0], pos[1], "idle")
            continue

        # Inline pack (manual AND AGV-handoff modes): the picker DOUBLES AS THE
        # PACKER, so it is genuinely occupied until packing finishes (queue wait
        # at the pack station + pack service). Picker "busy" is therefore defined
        # as pick/handle + carry + the time spent packing this batch -- otherwise
        # picker_utilization would exclude real occupancy and understate load
        # (diverging from the M/M/c oracle under overload). We log pick_done AFTER
        # the pack loop so its busy spans the whole occupied interval.
        # packer_utilization stays a meaningful measure of the pack-station
        # service time on its own. (`picker_busy` here is just the pick/carry
        # portion, retained for clarity; the logged busy below supersedes it.)
        for o, arr in zip(orders, arrivals):
            pack_req_t = env.now
            preq = world.packers.request()
            yield preq
            seize_t = env.now  # packer busy = service time only, not the queue wait
            world.log(t=env.now, event="pack_start", order_id=o.order_id,
                      wait=seize_t - pack_req_t, resource="packer", worker=w.id)
            if world.recording():
                w.kf(env.now, pos[0], pos[1], "pack")
            yield env.timeout(pack_time)
            world.packers.release(preq)
            world.log(t=env.now, event="pack_done", order_id=o.order_id,
                      busy=env.now - seize_t, resource="packer", worker=w.id)
            world.log(t=env.now, event="order_complete", order_id=o.order_id,
                      cycle=env.now - arr, dist=dist_per_order, due=o.due_s)
        # Picker was occupied (pick/handle + carry + pack) for this whole interval.
        world.log(t=env.now, event="pick_done", order_id=orders[0].order_id,
                  busy=env.now - busy_start, dist=total_dist, lines=len(points),
                  resource="picker", worker=w.id)
        if world.recording():
            w.kf(env.now, pos[0], pos[1], "idle")


def packer_agent(world: World, p: Worker, station_xy):
    """A dedicated packer agent: pull totes from the finite staging buffer and
    pack them at its station. The agent itself is the server (one process per
    packer), so the packer headcount + staging capacity are the real constraint
    (no separate resource pool). Emits its own trajectory keyframes and the
    pack_start/pack_done/order_complete events the KPI layer reads."""
    env = world.env
    pack_time = max(world.model.process.pack_time_s, 0.0)
    sx, sy = station_xy
    if world.recording():
        p.kf(env.now, sx, sy, "idle")
    while True:
        tote = yield world.staging.get()       # waits when staging is empty
        order = tote["order"]
        arr = tote["arrival"]
        dwell = env.now - tote.get("ready_at", env.now)   # time spent waiting in 仮置き
        world.log(t=env.now, event="staging_get", order_id=order.order_id,
                  wait=dwell, wip=len(world.staging.items),
                  resource="staging", worker=p.id)
        seize_t = env.now
        world.log(t=env.now, event="pack_start", order_id=order.order_id,
                  wait=0.0, resource="packer", worker=p.id)
        if world.recording():
            p.kf(env.now, sx, sy, "pack")
        yield env.timeout(pack_time)
        world.log(t=env.now, event="pack_done", order_id=order.order_id,
                  busy=env.now - seize_t, resource="packer", worker=p.id)
        world.log(t=env.now, event="order_complete", order_id=order.order_id,
                  cycle=env.now - arr, dist=tote.get("dist", 0.0), due=order.due_s)
        if world.recording():
            p.kf(env.now, sx, sy, "idle")


# --- 容器の有限循環 (finite container pool) ----------------------------------
# 折りたたみ容器は無限に湧かない。The pool is what turns "how many containers do we
# have to own?" from an opinion into a measurement: 投入 takes one and WAITS when
# none is free (so the shortage stops the line, exactly like a full belt does),
# 梱包完了 empties it, and it rides the 還流ベルト home. Unstated ⇒ world.container_pool
# is None ⇒ not one of these functions ever does anything (byte-identical).


def _take_container(world: World, order: Order):
    """Take one empty container for ``order`` — the moment it was taken, or ``None``.

    ``None`` means the model states no pool, i.e. 容器は無限: the caller's
    ``yield from`` returns immediately having yielded nothing, so the run keeps the
    exact event sequence (and RNG draw order) it had before pools existed."""
    pool = world.container_pool
    if pool is None:
        return None
    env = world.env
    t0 = env.now
    yield pool.get(1)          # blocks while every container is out on the line
    wait = env.now - t0
    world.log(t=env.now, event="container_take", order_id=order.order_id,
              resource="container", wait=wait, blocked=1 if wait > 1e-6 else 0,
              in_use=world.n_containers - pool.level, pool=world.n_containers)
    return env.now


def _release_container(world: World, held_from, at_xy, order: Order) -> None:
    """梱包完了 = 中身が出た ⇒ the container is empty and starts its way home.

    Fire-and-forget (its own process): the return trip is the CONTAINER's, not the
    goods', so nothing downstream of packing waits for it — but the pool does not
    get it back until it has actually travelled."""
    if held_from is None:
        return
    world.env.process(_container_return(world, held_from, at_xy, order))


def _container_return(world: World, held_from: float, at_xy, order: Order):
    """One empty container riding the 還流ベルト back to the pool.

    The return deck is geometry only (transit + the replay track): empty containers
    are not what jams a line, and giving the upper deck slots of its own would put
    the return deck's capacity into the conveyor KPIs of the line that does the
    work. ``return_time_s`` is everything else the round trip costs (折りたたみ・
    stacking・the walk back to the induction point)."""
    env = world.env
    line = world.container_return_line
    if line is not None:
        track = world.new_tote(f"{order.order_id}-empty", kind="empty",
                               belt_id=line.id)
        xy, arc = line.project(at_xy)
        if track is not None and world.recording():
            track.kf(env.now, xy[0], xy[1], "belt")
        yield from _ride_belt(world, line, arc, line.length, track)
    if world.container_return_s > 0.0:
        yield env.timeout(world.container_return_s)
    pool = world.container_pool
    yield pool.put(1)
    world.log(t=env.now, event="container_return", order_id=order.order_id,
              resource="container", held=env.now - held_from,
              in_use=world.n_containers - pool.level, pool=world.n_containers)


def _convey_tote(world: World, order: Order, arrival: float, line, arc: float,
                 slot, dist_per_order, tote=None, kind: str = "", held_from=None):
    """A tote on ONE conveyor: ride from its boarding point (arc length ``arc``
    from that line's infeed) to the line's discharge end, then pack -- holding its
    belt slot the whole time so a slow pack stage backs up the belt
    (accumulation/jam).

    Transit is the REMAINING path length / this line's speed, so a tote handed
    over near the discharge end rides for less time than one boarding at the far
    end. When ``tote`` is a replay track, keyframes are emitted at every corner of
    the remaining polyline (time-proportional, like ``_walk``) so a viewer lerping
    between them follows a bent belt instead of cutting the corner.

    ``kind`` (荷の種別) is carried for signature parity with :func:`_convey_chain`
    and is not consulted: only a 停止線 sorts on it, and a belt with one routes
    through the chained path. ``held_from`` is when this load's container was taken
    (``None`` = 容器は無限); packing empties it and sends it home."""
    env = world.env
    pack_time = max(world.model.process.pack_time_s, 0.0)
    board_t = env.now
    ride_m = line.remaining(arc)
    transit = ride_m / line.speed          # speed is guaranteed > 0 by build()
    pts = line.tail(arc)
    seglens = [((pts[i][0] - pts[i - 1][0]) ** 2 + (pts[i][1] - pts[i - 1][1]) ** 2) ** 0.5
               for i in range(1, len(pts))]
    pathlen = sum(seglens)
    if tote is not None and world.recording():
        tote.kf(env.now, pts[0][0], pts[0][1], "belt")
    if pathlen <= 1e-9 or tote is None:
        yield env.timeout(transit)
    else:
        for i in range(1, len(pts)):
            yield env.timeout(transit * seglens[i - 1] / pathlen)
            if world.recording():
                tote.kf(env.now, pts[i][0], pts[i][1], "belt")
    end = pts[-1]
    pack_req_t = env.now
    preq = world.packers.request()
    yield preq
    seize_t = env.now
    world.log(t=env.now, event="pack_start", order_id=order.order_id,
              wait=seize_t - pack_req_t, resource="packer")
    if tote is not None and world.recording():
        tote.kf(env.now, end[0], end[1], "pack")
    yield env.timeout(pack_time)
    world.packers.release(preq)
    line.belt.release(slot)   # leaves the belt only after packing completes
    _release_container(world, held_from, end, order)
    if tote is not None and world.recording():
        tote.kf(env.now, end[0], end[1], "pack")
    world.log(t=env.now, event="pack_done", order_id=order.order_id,
              busy=env.now - seize_t, resource="packer")
    # Slot occupancy = board -> release (transit + pack): the accumulation the
    # conveyor KPIs integrate for utilisation.
    world.log(t=env.now, event="conveyor_off", order_id=order.order_id,
              resource="conveyor", conveyor=line.id, transit=transit,
              ride_m=ride_m, occupancy=env.now - board_t,
              leg=0, last=1)
    world.log(t=env.now, event="order_complete", order_id=order.order_id,
              cycle=env.now - arrival, dist=dist_per_order, due=order.due_s)


# --- ベルト連鎖 (chained belts) と 引き込み(spur) ------------------------------
# A real 出荷ライン is one machine made of many belts: 検品ライン → 本線 → 引き込み →
# 梱包台. Its defining behaviour is the jam travelling BACKWARDS along it — a full
# 引き込み holds totes on the 本線, which holds them on the 検品ライン, which is what
# finally stops the picker from letting go. Modelling each belt as its own world
# made every one of those couplings invisible.


def _belt_load(line) -> int:
    """How much work is standing in a belt: waiting for it + already on it."""
    return len(line.belt.queue) + line.belt.count


def _belt_room(line) -> bool:
    """Can a tote turn into ``line`` right now (nobody queued, a slot free)?"""
    return not line.belt.queue and line.belt.count < line.belt.capacity


def _bench_pool(world: World, line):
    """Who takes a tote off ``line`` at its end: its own 梱包台, else the shared pool.

    A 引き込み nobody stands at borrows the pack stations rather than refusing to
    deliver — the half-drawn-line fallback (never-blocks). What it borrows is the
    benches NOBODY ELSE claimed (``spare_bench``), not the whole floor: the shared
    ``packers`` pool counts every station including the private ones another
    引き込み is already working, so borrowing that books the same people twice
    (measured packer_utilization 1.675 on a floor of four). With every bench
    spoken for there is nothing to borrow, and the historical shared pool keeps
    the line moving rather than deadlocking it."""
    if line.bench is not None:
        return line.bench
    if world.spare_bench is not None:
        return world.spare_bench
    # No spare AND some bench is privately owned ⇒ every person on the floor is
    # standing at a 引き込み or a 停止線, so there is nobody at this belt end.
    # ``None`` says exactly that. Falling through to ``packers`` here is what made
    # a line whose every bench is claimed pack its overflow with the SAME people a
    # second time (measured packer_utilization 1.73 and a pull line out-throughput-
    # ing the greedy one it is physically a subset of).
    return None if world.benches_claimed else world.packers


def _bench_free(world: World, line) -> bool:
    """Is a 梱包台 at ``line`` FREE right now — i.e. is there a worker able to pull?

    Only the 引き込み方式 "pull" asks this. Free means idle this instant (nobody
    queued, a server unused): a load passing a bench whose operator is mid-carton
    is not taken, it rides on. That is the whole difference from 貪欲ディバート,
    where the load enters the spur regardless and waits there for the bench.

    A 引き込み with NO bench drawn at it has nobody to do the pulling, so under
    this policy it takes nothing. Asking the shared pack pool on its behalf
    inverted the entire mechanism: the empty pool is almost always free, so the
    pull-in with no workers became the most attractive lane on the line and took
    nearly THREE TIMES the load of its manned neighbour (53 against 20). The
    shared pool stays the fallback for 貪欲ディバート, where it is what keeps a
    half-drawn line running (never-blocks)."""
    if line.bench is None:
        return False
    pool = line.bench
    return not pool.queue and pool.count < pool.capacity


def _divert_wake(world: World, trunk):
    """The broadcast a tote stalled on ``trunk`` waits on: "some 引き込み off this
    trunk has freed a slot, look again".

    One shared event rather than a queue per spur, because a stalled tote is
    interested in EVERY spur from where it stands onwards — it cannot know in
    advance which one will free first. Created on first use and replaced once
    fired (the standard SimPy broadcast idiom), and nothing can be missed: the
    decision to wait and the registration happen without an intervening yield, so
    no release can slip between them."""
    ev = trunk.divert_wake
    if ev is None or ev.triggered:
        ev = world.env.event()
        trunk.divert_wake = ev
    return ev


def _signal_divert(spur) -> None:
    """A 引き込み just freed a slot — wake everyone stalled on its trunk.

    Waiters resume in the order they registered, i.e. the order they started
    waiting, and each re-scans SYNCHRONOUSLY (checking room and seizing the slot
    happen without a yield between them), so the longest-waiting tote that can use
    the freed slot is the one that gets it."""
    host = spur.host
    if host is None:
        return
    ev = host.divert_wake
    if ev is not None and not ev.triggered:
        host.divert_wake = None
        ev.succeed()


def _ride_belt(world: World, line, a0: float, a1: float, tote):
    """Ride ``line`` from arc ``a0`` to arc ``a1``, drawing the tote along the path.

    The caller has already emitted the keyframe at ``a0``; this emits every corner
    up to and including ``a1``, spaced by arc length, so a viewer lerping between
    keyframes follows a BENT belt instead of cutting its corners."""
    env = world.env
    total_t = max(a1 - a0, 0.0) / line.speed       # speed is guaranteed > 0 by build()
    pts = line.slice_pts(a0, a1)
    seglens = [math.dist(pts[i - 1], pts[i]) for i in range(1, len(pts))]
    pathlen = sum(seglens)
    if pathlen <= 1e-9 or tote is None:
        yield env.timeout(total_t)
        return
    for i in range(1, len(pts)):
        yield env.timeout(total_t * seglens[i - 1] / pathlen)
        if world.recording():
            tote.kf(env.now, pts[i][0], pts[i][1], "belt")


def _leg_on(world: World, order: Order, line, leg: int, arc: float, wait: float) -> None:
    """``conveyor_on`` for one belt of a chained ride (``leg`` 0 is the entrance,
    logged by the picker because that is who the jam blocks).

    ``ride_m``/``transit`` here are the belt AHEAD of the tote — how far it could
    ride — matching what the single-belt path has always logged at boarding. What
    it ACTUALLY rode is on the matching ``conveyor_off``, which can be shorter
    because the tote turned off at a 引き込み partway along."""
    ride_m = line.remaining(arc)
    world.log(t=world.env.now, event="conveyor_on", order_id=order.order_id,
              resource="conveyor", conveyor=line.id, wait=wait,
              blocked=1 if wait > 1e-6 else 0,
              transit=ride_m / line.speed, ride_m=ride_m,
              leg=leg, entry=0)


def _leg_off(world: World, order: Order, line, leg: int, arc_in: float,
             arc_out: float, board_t: float, last: int) -> None:
    """``conveyor_off`` for one belt of a chained ride: what it rode on THIS belt,
    and how long it held one of THIS belt's slots (``occupancy`` — the accumulation
    the conveyor KPIs integrate, so a tote stalled waiting for a full 引き込み shows
    up as occupancy of the 本線 it is standing on)."""
    ride_m = max(arc_out - arc_in, 0.0)
    world.log(t=world.env.now, event="conveyor_off", order_id=order.order_id,
              resource="conveyor", conveyor=line.id,
              transit=ride_m / line.speed, ride_m=ride_m,
              occupancy=world.env.now - board_t, leg=leg, last=last)


def _convey_chain(world: World, order: Order, arrival: float, line, arc: float,
                  slot, dist_per_order, tote=None, kind: str = "", held_from=None):
    """One tote down a CHAINED line: hand-overs, 引き込み diverts, then 梱包.

    **Deadlock-freedom is structural, not lucky.** Every slot this process waits
    for is strictly DOWNSTREAM of the one it holds: a hand-over acquires the next
    belt's slot and only then releases the one behind it, and a 引き込み is entered
    from the trunk and never the reverse. So the wait-for graph only ever points
    forward and no set of totes can close a cycle. A belt already ridden is treated
    as the end of the line and the hop count is capped at the number of belts, so
    even a mis-drawn loop terminates.

    **引き込み選択 is GREEDY and WORK-CONSERVING** — deterministic, no RNG:

    * at a junction, turn into a spur there if one has room (both sides of the same
      junction are candidates: least loaded, ties by belt id);
    * otherwise advance to the next junction, but ONLY if some spur from there on
      has room;
    * if nothing downstream has room, stall AT THIS junction holding the 本線 slot
      — which is how a full 引き込み backs the 本線 up, one slot at a time, until
      the picker cannot let go;
    * a stalled tote is woken whenever ANY spur on this trunk frees a slot and
      re-scans from where it stands (:func:`_divert_wake`).

    The greed and the re-scan are what make it work-conserving, and that is not a
    refinement — it is the difference between a model and a fiction. Committing to
    a target spur at boarding fails BOTH ways: the tote sails past empty 引き込み
    it could have used, and once it has passed them it can never go back, so
    benches sit idle while totes stall. That produced the physically impossible
    reading of packing utilisation FALLING (to 0.62) as demand rose past capacity.
    A tote may only ever move forward, so the decision has to be taken at each
    junction with what is true there and then — which is also what the people on
    the line do: you take the tote in front of you when you have room for it.

    **引き込み方式 "pull" (``Process.divert_policy``) inverts who decides.** On the
    real line nothing diverts by itself: the operator whose 梱包台 just went free
    pulls the next container off the 本線. So under "pull" a load is taken in only
    where a bench is FREE as it arrives; where none is, it does NOT stall — it
    rides past (an unmanned 引き込み takes nothing) and ends up at the 停止線 with
    everything else nobody had hands for. Under the default "auto" the branch below
    is untouched, byte for byte.

    **停止線 (``Conveyor.stop_gate``)** ends the belt EARLY for the kinds it stops:
    the load rides to the gate arc, is taken off there (by the benches standing at
    the stop line, else the shared pool) and holds its slot until then, while loads
    of a passing kind never see the gate at all. That is how one belt carries
    検品済み容器 and 梱包済み完成品 at the same time and still sorts them.
    """
    env = world.env
    pack_time = max(world.model.process.pack_time_s, 0.0)
    pull = world.divert_policy == "pull"
    leg = 0
    hops = 0
    max_hops = max(1, len(world.conveyors))
    visited = {line.id}
    pack_wait = 0.0            # 引き込み待ち — charged to the pack stage's wait
    if tote is not None and world.recording():
        p0 = line.point_at(arc)
        tote.kf(env.now, p0[0], p0[1], "belt")

    while True:
        board_t = env.now
        arc_in = arc
        spur = None
        spur_slot = None
        spur_wait = 0.0
        # 停止線: for a load of a stopped kind THIS belt ends at the gate — it can
        # neither ride past it nor hand over beyond it. ``None`` (no gate, or a
        # kind that passes) leaves every arc below exactly as it was.
        # A stop line only stops what PASSES it: a load that boarded (or handed
        # over) downstream of the gate is already past it and rides on. Without
        # the ``>= arc`` test such a load was dragged BACKWARDS to the gate in
        # zero time and packed at the wrong place, and every 引き込み between it
        # and the gate vanished from its junction window.
        gate = (line.gate if (line.gate is not None and line.gate.stops(kind)
                              and line.gate.arc >= arc - 1e-9) else None)
        end_arc = line.length if gate is None else min(gate.arc, line.length)
        branches = ([(a, s) for a, s in line.junctions
                     if arc - 1e-9 <= a <= end_arc + 1e-9 and s.id not in visited]
                    if hops < max_hops else [])
        if branches:
            i = 0
            while True:
                arc_j = branches[i][0]
                if arc_j > arc + 1e-9:
                    yield from _ride_belt(world, line, arc, arc_j, tote)
                    arc = arc_j
                # Every 引き込み hanging off THIS junction — a trunk is normally
                # tapped from both sides at the same point (両側の引き込み).
                j = i
                while j < len(branches) and branches[j][0] <= arc_j + 1e-9:
                    j += 1
                here = [s for _a, s in branches[i:j]
                        if _belt_room(s) and (not pull or _bench_free(world, s))]
                if here:
                    # ``branches`` is id-ordered inside a junction and ``min`` keeps
                    # the first of equal keys ⇒ least loaded, ties by id ascending.
                    cand = min(here, key=_belt_load)
                    spur_slot = cand.belt.request()
                    yield spur_slot          # room was just checked: granted at once
                    spur = cand
                    break
                if pull:
                    # 作業者が引く: nobody here had a free hand, so the load simply
                    # goes past — it never waits ON the trunk for a bench to free up
                    # (that is the auto rule, and it is what hides an understaffed
                    # 引き込み behind a queue). Try the next pull-in; past the last
                    # one, ride on to the 停止線/末端.
                    if j < len(branches):
                        i = j
                        continue
                    break
                if j < len(branches) and any(_belt_room(s) for _a, s in branches[j:]):
                    i = j                    # room further down: go and take it
                    continue
                # Nothing from here on has room: stall HERE, holding the 本線 slot,
                # until some 引き込み frees up — then look again from this junction.
                wait0 = env.now
                yield _divert_wake(world, line)
                spur_wait += env.now - wait0

        if spur is not None:
            pack_wait += spur_wait
            hops += 1
            leg += 1
            _leg_on(world, order, spur, leg, spur.feed_arc, spur_wait)
            _leg_off(world, order, line, leg - 1, arc_in, arc, board_t, last=0)
            line.belt.release(slot)              # hand-over-hand: hold, then let go
            # The tote boards the 引き込み where the 本線 actually meets it, which
            # is its infeed for a half-drawn spur (``feed_arc`` 0.0, unchanged) and
            # the crossing point for one drawn as a single belt across the trunk.
            line, slot, arc = spur, spur_slot, spur.feed_arc
            visited.add(line.id)
            if tote is not None and world.recording():
                p0 = line.point_at(arc)
                tote.kf(env.now, p0[0], p0[1], "belt")
            continue

        yield from _ride_belt(world, line, arc, end_arc, tote)
        arc = end_arc
        if gate is not None:
            # 停止線: this load stops here and waits to be taken off the line,
            # holding its slot the whole time — so the queue behind it grows back
            # up the belt, which is precisely what a stop line does on the floor.
            world.log(t=env.now, event="conveyor_gate", order_id=order.order_id,
                      resource="conveyor", conveyor=line.id, kind=kind, arc=arc)
            break
        nxt = line.next_line
        if nxt is not None and nxt.id not in visited and hops < max_hops:
            req_t = env.now
            nslot = nxt.belt.request()
            yield nslot                          # blocks when the belt ahead is full
            waited = env.now - req_t
            _, nxt_arc = nxt.project(line.points[-1])
            hops += 1
            leg += 1
            _leg_on(world, order, nxt, leg, nxt_arc, waited)
            _leg_off(world, order, line, leg - 1, arc_in, arc, board_t, last=0)
            line.belt.release(slot)
            line, slot, arc = nxt, nslot, nxt_arc
            visited.add(line.id)
            if tote is not None and world.recording():
                p0 = line.point_at(arc)
                tote.kf(env.now, p0[0], p0[1], "belt")
            continue
        break

    # 梱包: at the 引き込み's OWN benches when the drawing puts benches at its end,
    # else at the shared pack pool (a spur nobody stands at still runs). A load
    # held at a 停止線 is taken off by whoever stands AT the stop line, which is a
    # different set of hands from the 引き込み's benches — and the same fallback
    # applies when the drawing puts nobody there.
    end = line.point_at(arc)
    pool = (gate.bench if (gate is not None and gate.bench is not None)
            else _bench_pool(world, line))
    if pool is None:
        # 誰も立っていない末端に着いた: この荷を取る人が居ない。スロットを持った
        # まま止まる＝ラインが詰まる、が物理的に正しい答え（人を発明しない）。
        # 図面が末端に人を置いていない設計は、実際そこで止まる。
        world.log(t=env.now, event="pack_unmanned", order_id=order.order_id,
                  resource="packer", conveyor=line.id, arc=arc)
        if tote is not None and world.recording():
            tote.kf(env.now, end[0], end[1], "belt")
        yield env.event()                    # never fires: the load stays put
        return
    pack_req_t = env.now
    preq = pool.request()
    yield preq
    seize_t = env.now
    # The 引き込み wait and the 梱包台 wait are both "this tote could not be packed
    # yet", so they land together on pack_start's existing wait field.
    world.log(t=env.now, event="pack_start", order_id=order.order_id,
              wait=pack_wait + (seize_t - pack_req_t), resource="packer")
    if tote is not None and world.recording():
        tote.kf(env.now, end[0], end[1], "pack")
    yield env.timeout(pack_time)
    pool.release(preq)
    # The tote occupies the 引き込み until it is packed: the belt AND the bench are
    # where it physically stands, so the slot is only freed now — and freeing it is
    # what lets a tote stalled on the trunk come in (no-op for a belt that is not a
    # 引き込み, which nobody is waiting on).
    line.belt.release(slot)
    _signal_divert(line)
    _release_container(world, held_from, end, order)
    if tote is not None and world.recording():
        tote.kf(env.now, end[0], end[1], "pack")
    world.log(t=env.now, event="pack_done", order_id=order.order_id,
              busy=env.now - seize_t, resource="packer")
    _leg_off(world, order, line, leg, arc_in, arc, board_t, last=1)
    world.log(t=env.now, event="order_complete", order_id=order.order_id,
              cycle=env.now - arrival, dist=dist_per_order, due=order.due_s)


def _sample_order(world: World, rng: random.Random, idx: int, t: float) -> Order:
    prof = world.model.orders.profile
    n_lines = max(1, int(rng.expovariate(1.0 / max(prof.lines_per_order_mean, 0.5))))
    lines = []
    for _ in range(n_lines):
        if not world.sku_list:
            break
        sku = rng.choices(world.sku_list, weights=world.sku_weights, k=1)[0]
        lines.append(OrderLine(sku=sku, qty=rng.randint(1, 3)))
    return Order(order_id=f"G{idx:06d}", arrival_s=t, lines=lines)


def order_source(world: World, rng: random.Random):
    """Feed the order store: replay explicit orders, else generate from profile."""
    env = world.env
    explicit = world.model.orders.outbound

    if explicit:
        for o in sorted(explicit, key=lambda x: x.arrival_s):
            delay = max(0.0, o.arrival_s - env.now)
            if delay:
                yield env.timeout(delay)
            world.log(t=env.now, event="order_arrive", order_id=o.order_id)
            yield world.order_store.put({"order": o, "arrival": env.now})
        return

    prof = world.model.orders.profile
    rate_per_s = max(prof.rate_per_hr, 0.0) * max(prof.peak_factor, 0.0) / 3600.0
    duration = world.model.simulation.duration_s
    idx = 0
    if rate_per_s <= 0:
        return
    while env.now < duration:
        yield env.timeout(rng.expovariate(rate_per_s))
        if env.now >= duration:
            break
        o = _sample_order(world, rng, idx, env.now)
        world.log(t=env.now, event="order_arrive", order_id=o.order_id)
        yield world.order_store.put({"order": o, "arrival": env.now})
        idx += 1
