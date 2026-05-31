"""Discrete-event processes (agent-based).

Demand flows into an order store. Each picker is its own SimPy process that
pulls an order, walks a nearest-neighbour route (recording trajectory
keyframes), carries it to a pack station, occupies the station for packing,
then returns home for the next order. Queueing at the (limited) pack stations
is what produces the packing bottleneck.
"""

from __future__ import annotations

import random

from whsim.engine.build import World, Worker
from whsim.engine.routing import leg_cells, manhattan, nearest_neighbor_route
from whsim.schema.model import Order, OrderLine


def _accumulate_heat(world: World, a, b) -> None:
    gh, gw = world.heat.shape
    for gx, gy in leg_cells(a, b, world.grid_m):
        if 0 <= gy < gh and 0 <= gx < gw:
            world.heat[gy, gx] += 1.0


def _walk(world: World, w: Worker, frm, to, speed: float, state: str):
    """Move a worker from->to, recording heat + trajectory keyframes."""
    d = manhattan(frm, to)
    _accumulate_heat(world, frm, to)
    if world.recording():
        w.kf(world.env.now, frm[0], frm[1], state)
    yield world.env.timeout(d / speed)
    if world.recording():
        w.kf(world.env.now, to[0], to[1], state)
    return d


def picker_agent(world: World, w: Worker, rng: random.Random):
    env = world.env
    speed = max(world.model.process.walk_speed_mps, 0.1)
    pack_time = max(world.model.process.pack_time_s, 0.0)
    pos = world.home
    if world.recording():
        w.kf(env.now, pos[0], pos[1], "idle")

    while True:
        item = yield world.order_store.get()
        order: Order = item["order"]
        arrival = item["arrival"]
        world.log(t=env.now, event="pick_start", order_id=order.order_id,
                  wait=env.now - arrival, resource="picker", worker=w.id)
        busy_start = env.now

        points, qtys, tss = [], [], []
        for line in order.lines:
            xy = world.sku_xy.get(line.sku)
            if xy is None:
                continue
            points.append(xy)
            qtys.append(line.qty)
            tss.append(world.sku_ts.get(line.sku, 1.5))

        total_dist = 0.0
        handle_time = sum(q * ts for q, ts in zip(qtys, tss))
        if world.pick_method == "agv":
            # Goods-to-person: AGVs ferry totes (a round trip per pick location);
            # the picker only handles, so its labour falls and the AGV fleet becomes
            # the constraint. Picker "busy" is handling time only.
            route = [points[i] for i in nearest_neighbor_route(world.home, points)]
            cur = world.home
            for dest in route:
                total_dist += 2 * manhattan(cur, dest)
                _accumulate_heat(world, cur, dest)
                cur = dest
            if route:
                areq = world.agvs.request()
                yield areq
                if world.recording():
                    w.kf(env.now, pos[0], pos[1], "pick")
                yield env.timeout(total_dist / world.agv_speed)   # AGV transport
                world.agvs.release(areq)
                world.log(t=env.now, event="agv_done", order_id=order.order_id,
                          busy=total_dist / world.agv_speed, resource="agv")
            yield env.timeout(handle_time)                         # picker handling
            picker_busy = handle_time
        else:
            if points:
                for idx in nearest_neighbor_route(pos, points):
                    dest = points[idx]
                    total_dist += yield from _walk(world, w, pos, dest, speed, "travel")
                    pos = dest
                    if world.recording():
                        w.kf(env.now, pos[0], pos[1], "pick")
                    yield env.timeout(qtys[idx] * tss[idx])   # pick dwell
            # carry to a pack station
            total_dist += yield from _walk(world, w, pos, world.home, speed, "carry")
            pos = world.home
            picker_busy = env.now - busy_start

        world.log(t=env.now, event="pick_done", order_id=order.order_id,
                  busy=picker_busy, dist=total_dist,
                  resource="picker", worker=w.id)

        # pack (contend for a station)
        pack_req_t = env.now
        preq = world.packers.request()
        yield preq
        pack_seize = env.now
        world.log(t=env.now, event="pack_start", order_id=order.order_id,
                  wait=pack_seize - pack_req_t, resource="packer", worker=w.id)
        if world.recording():
            w.kf(env.now, pos[0], pos[1], "pack")
        yield env.timeout(pack_time)
        world.packers.release(preq)
        world.log(t=env.now, event="pack_done", order_id=order.order_id,
                  busy=env.now - pack_seize, resource="packer", worker=w.id)

        world.log(t=env.now, event="order_complete", order_id=order.order_id,
                  cycle=env.now - arrival, dist=total_dist, due=order.due_s)
        if world.recording():
            w.kf(env.now, pos[0], pos[1], "idle")


def _sample_order(world: World, rng: random.Random, idx: int, t: float) -> Order:
    prof = world.model.orders.profile
    n_lines = max(1, int(rng.expovariate(1.0 / max(prof.lines_per_order_mean, 0.5))))
    lines = []
    for _ in range(n_lines):
        if not world.sku_list:
            break
        sku = rng.choices(world.sku_list, weights=world.sku_weights, k=1)[0]
        lines.append(OrderLine(sku=sku, qty=rng.randint(1, 3)))
    o = Order(order_id=f"G{idx:06d}", arrival_s=t, lines=lines)
    return o


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
    rate_per_s = max(prof.rate_per_hr, 0.0) / 3600.0
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
