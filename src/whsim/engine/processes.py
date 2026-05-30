"""The discrete-event processes: demand generation and the pick->pack flow."""

from __future__ import annotations

import random

from whsim.engine.build import World
from whsim.engine.routing import leg_cells, manhattan, nearest_neighbor_route
from whsim.schema.model import Order, OrderLine


def _accumulate_heat(world: World, a, b) -> None:
    gh, gw = world.heat.shape
    for gx, gy in leg_cells(a, b, world.grid_m):
        if 0 <= gy < gh and 0 <= gx < gw:
            world.heat[gy, gx] += 1.0


def pick_order(world: World, order: Order, rng: random.Random):
    env = world.env
    speed = max(world.model.process.walk_speed_mps, 0.1)
    pack_time = max(world.model.process.pack_time_s, 0.0)

    env_order_arrival = env.now
    world.log(t=env.now, event="order_arrive", order_id=order.order_id)

    # --- pick stage: seize a picker, then walk a nearest-neighbour route -------
    req = world.pickers.request()
    yield req
    pick_wait = env.now - env_order_arrival
    world.log(t=env.now, event="pick_start", order_id=order.order_id,
              wait=pick_wait, resource="picker")
    busy_start = env.now

    points, qtys, tss = [], [], []
    for line in order.lines:
        xy = world.sku_xy.get(line.sku)
        if xy is None:
            continue
        points.append(xy)
        qtys.append(line.qty)
        tss.append(world.sku_ts.get(line.sku, 1.5))

    cur = world.depot
    total_dist = 0.0
    if points:
        for idx in nearest_neighbor_route(cur, points):
            dest = points[idx]
            d = manhattan(cur, dest)
            total_dist += d
            _accumulate_heat(world, cur, dest)
            yield env.timeout(d / speed)           # travel
            yield env.timeout(qtys[idx] * tss[idx])  # handle (pick)
            cur = dest
    # return to pack/depot
    d = manhattan(cur, world.depot)
    total_dist += d
    _accumulate_heat(world, cur, world.depot)
    yield env.timeout(d / speed)

    world.pickers.release(req)
    world.log(t=env.now, event="pick_done", order_id=order.order_id,
              busy=env.now - busy_start, dist=total_dist, resource="picker")

    # --- pack stage ----------------------------------------------------------
    preq = world.packers.request()
    yield preq
    pack_seize = env.now
    world.log(t=env.now, event="pack_start", order_id=order.order_id,
              wait=env.now - busy_start - (env.now - pack_seize), resource="packer")
    yield env.timeout(pack_time)
    world.packers.release(preq)
    world.log(t=env.now, event="pack_done", order_id=order.order_id,
              busy=env.now - pack_seize, resource="packer")

    cycle = env.now - env_order_arrival
    world.log(t=env.now, event="order_complete", order_id=order.order_id,
              cycle=cycle, dist=total_dist, due=order.due_s)


def _sample_order(world: World, rng: random.Random, idx: int, t: float) -> Order:
    prof = world.model.orders.profile
    n_lines = max(1, int(rng.expovariate(1.0 / max(prof.lines_per_order_mean, 0.5))))
    lines = []
    for _ in range(n_lines):
        sku = rng.choices(world.sku_list, weights=world.sku_weights, k=1)[0] \
            if world.sku_list else None
        if sku is None:
            continue
        lines.append(OrderLine(sku=sku, qty=rng.randint(1, 3)))
    return Order(order_id=f"G{idx:06d}", arrival_s=t, lines=lines)


def order_source(world: World, rng: random.Random):
    """Replay explicit outbound orders, else generate from the demand profile."""
    env = world.env
    explicit = world.model.orders.outbound

    if explicit:
        for o in sorted(explicit, key=lambda x: x.arrival_s):
            delay = max(0.0, o.arrival_s - env.now)
            if delay:
                yield env.timeout(delay)
            env.process(pick_order(world, o, rng))
        return

    # Poisson arrivals from the profile, for the whole sim duration.
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
        env.process(pick_order(world, _sample_order(world, rng, idx, env.now), rng))
        idx += 1
