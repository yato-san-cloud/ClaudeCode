"""Discrete-event processes (agent-based).

Two operating modes share the same pack stage:

* manual  — pickers pull orders (one, or up to batch_size for batch/zone/wave),
  walk a nearest-neighbour route recording trajectory keyframes, then pack.
* agv (goods-to-person) — a PIPELINE: AGV agents pull orders, physically fetch
  the totes (their own moving trajectories), and drop them in a ready queue;
  pickers then only handle + pack. AGVs and pickers run in parallel across
  orders, so the AGV fleet (not the picker) can become the real constraint and
  fewer pickers are needed.
"""

from __future__ import annotations

import random

from whsim.engine.build import Worker, World
from whsim.engine.routing import leg_cells, manhattan, nearest_neighbor_route
from whsim.schema.model import Order, OrderLine


def _accumulate_heat(world: World, a, b) -> None:
    gh, gw = world.heat.shape
    for gx, gy in leg_cells(a, b, world.grid_m):
        if 0 <= gy < gh and 0 <= gx < gw:
            world.heat[gy, gx] += 1.0


def _walk(world: World, w: Worker, frm, to, speed: float, state: str):
    d = world.dist(frm, to)            # measured override > wall-aware graph > Manhattan
    _accumulate_heat(world, frm, to)
    if world.recording():
        w.kf(world.env.now, frm[0], frm[1], state)
    yield world.env.timeout(d / speed)
    if world.recording():
        w.kf(world.env.now, to[0], to[1], state)
    return d


def _route_order(world: World, start, pts: list) -> list[int]:
    """Visiting order (indices into `pts`). Strategy shapes the route:
    discrete/batch/wave use nearest-neighbour; zone walks a strict S-shape by
    aisle column (no backtracking), modelling disciplined zone/aisle picking."""
    if world.pick_strategy == "zone" and pts:
        # rank by actual aisle column (distinct x positions), serpentine in y
        cols = sorted({round(p[0], 1) for p in pts})
        rank = {c: r for r, c in enumerate(cols)}
        return sorted(range(len(pts)),
                      key=lambda i: (rank[round(pts[i][0], 1)],
                                     pts[i][1] if rank[round(pts[i][0], 1)] % 2 == 0
                                     else -pts[i][1]))
    return nearest_neighbor_route(start, pts)


def _nearest_conveyor(world: World, p):
    if not world.conveyor_points:
        return None
    return min(world.conveyor_points, key=lambda q: manhattan(p, q))


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
    while env.now < world.model.simulation.duration_s:
        yield env.timeout(rng.expovariate(rate_per_s))
        yield world.fork_store.put(rng.choice(world.slot_xy))


def forklift_agent(world: World, f: Worker, rng: random.Random):
    """Inbound putaway: pull a task, ferry a pallet dock -> storage slot -> dock."""
    env = world.env
    pos = world.fork_home
    if world.recording():
        f.kf(env.now, pos[0], pos[1], "idle")
    while True:
        slot = yield world.fork_store.get()   # waits when there is no inbound work
        trip_start = env.now
        d1 = world.dist(world.fork_home, slot)
        _accumulate_heat(world, world.fork_home, slot)
        if world.recording():
            f.kf(env.now, world.fork_home[0], world.fork_home[1], "putaway")
        yield env.timeout(d1 / world.fork_speed)
        if world.recording():
            f.kf(env.now, slot[0], slot[1], "putaway")
        yield env.timeout(8.0)  # place the pallet
        _accumulate_heat(world, slot, world.fork_home)
        yield env.timeout(world.dist(slot, world.fork_home) / world.fork_speed)
        if world.recording():
            f.kf(env.now, world.fork_home[0], world.fork_home[1], "idle")
        world.log(t=env.now, event="forklift_done", busy=env.now - trip_start,
                  resource="forklift", worker=f.id)


def _order_points(world: World, order: Order):
    pts, qtys, tss = [], [], []
    for line in order.lines:
        xy = world.sku_xy.get(line.sku)
        if xy is None:
            continue
        pts.append(xy)
        qtys.append(line.qty)
        tss.append(world.sku_ts.get(line.sku, 1.5))
    return pts, qtys, tss


def agv_agent(world: World, a: Worker):
    """AGV: pull an order, fetch its totes (move!), drop into the ready queue."""
    env = world.env
    pos = world.agv_home
    if world.recording():
        a.kf(env.now, pos[0], pos[1], "idle")
    while True:
        item = yield world.order_store.get()
        order = item["order"]
        points, _, _ = _order_points(world, order)
        route = [points[i] for i in nearest_neighbor_route(world.agv_home, points)]
        trip_start = env.now
        cur = world.agv_home
        for dest in route:
            d = world.dist(cur, dest)
            _accumulate_heat(world, cur, dest)
            if world.recording():
                a.kf(env.now, cur[0], cur[1], "travel")
            yield env.timeout(d / world.agv_speed)
            if world.recording():
                a.kf(env.now, dest[0], dest[1], "pickup")
            cur = dest
        d = world.dist(cur, world.agv_home)
        _accumulate_heat(world, cur, world.agv_home)
        if world.recording():
            a.kf(env.now, cur[0], cur[1], "dropoff")
        yield env.timeout(d / world.agv_speed)
        if world.recording():
            a.kf(env.now, world.agv_home[0], world.agv_home[1], "idle")
        world.log(t=env.now, event="agv_done", busy=env.now - trip_start,
                  resource="agv", worker=a.id)
        yield world.ready_store.put(item)


def _pull_batch(world: World, source, first):
    """First order plus up to batch_size-1 more already waiting (batch/zone/wave).
    Wave picking waits a short release window first to accumulate a fuller batch."""
    batch = [first]
    if world.pick_strategy == "discrete":
        return batch
    if world.pick_strategy == "wave":
        yield world.env.timeout(30.0)  # release window: let orders pile up
    while len(batch) < world.batch_size and source.items:
        batch.append((yield source.get()))
    return batch


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
        batch = yield from _pull_batch(world, source, first)
        orders = [b["order"] for b in batch]
        arrivals = [b["arrival"] for b in batch]
        world.log(t=env.now, event="pick_start", order_id=orders[0].order_id,
                  wait=env.now - arrivals[0], resource="picker", worker=w.id,
                  n_orders=len(orders))
        busy_start = env.now

        points, qtys, tss = [], [], []
        for o in orders:
            p, q, t = _order_points(world, o)
            points += p
            qtys += q
            tss += t
        handle_time = sum(q * t for q, t in zip(qtys, tss))

        total_dist = 0.0
        if agv_mode:
            # totes already delivered by the AGV; the picker only handles
            if world.recording():
                w.kf(env.now, pos[0], pos[1], "pick")
            yield env.timeout(handle_time)
            picker_busy = handle_time
        else:
            if points:
                for idx in _route_order(world, pos, points):
                    dest = points[idx]
                    total_dist += yield from _walk(world, w, pos, dest, speed, "travel")
                    pos = dest
                    if world.recording():
                        w.kf(env.now, pos[0], pos[1], "pick")
                    yield env.timeout(qtys[idx] * tss[idx])
            # carry to pack: a conveyor (if present) takes the long haul, so the
            # picker only walks to the nearest conveyor pickup point.
            conv = _nearest_conveyor(world, pos)
            drop = conv if conv is not None else world.home
            total_dist += yield from _walk(world, w, pos, drop, speed, "carry")
            pos = drop
            picker_busy = env.now - busy_start

        dist_per_order = total_dist / len(orders)
        world.log(t=env.now, event="pick_done", order_id=orders[0].order_id,
                  busy=picker_busy, dist=total_dist, resource="picker", worker=w.id)

        if world.has_conveyor and not agv_mode:
            # Hand each tote to the conveyor. Acquiring a belt slot BLOCKS when the
            # belt is full (downstream pack can't keep up) -> the jam propagates
            # back to the picker. The tote rides the belt (transit) then packs,
            # holding its slot the whole time, modelling real accumulation.
            for o, arr in zip(orders, arrivals):
                slot = world.belt.request()
                yield slot   # blocks here when the conveyor is jammed
                world.log(t=env.now, event="conveyor_on", order_id=o.order_id,
                          resource="conveyor")
                env.process(_convey_tote(world, o, arr, slot, dist_per_order))
            if world.recording():
                w.kf(env.now, pos[0], pos[1], "idle")
            continue

        for o, arr in zip(orders, arrivals):
            pack_req_t = env.now
            preq = world.packers.request()
            yield preq
            seize_t = env.now  # busy = service time only, not the queue wait
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
        if world.recording():
            w.kf(env.now, pos[0], pos[1], "idle")


def _convey_tote(world: World, order: Order, arrival: float, slot, dist_per_order):
    """A tote on the conveyor: transit delay, then pack -- holding its belt slot
    the whole time so a slow pack stage backs up the belt (accumulation/jam)."""
    env = world.env
    pack_time = max(world.model.process.pack_time_s, 0.0)
    yield env.timeout(world.conveyor_transit)
    pack_req_t = env.now
    preq = world.packers.request()
    yield preq
    seize_t = env.now
    world.log(t=env.now, event="pack_start", order_id=order.order_id,
              wait=seize_t - pack_req_t, resource="packer")
    yield env.timeout(pack_time)
    world.packers.release(preq)
    world.belt.release(slot)   # leaves the belt only after packing completes
    world.log(t=env.now, event="pack_done", order_id=order.order_id,
              busy=env.now - seize_t, resource="packer")
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
