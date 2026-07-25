"""Closed-form fast estimate (M/M/c on the picking stage).

Returns KPIs in milliseconds for the drag-and-drop "instant gratification"
moment, while the heavyweight SimPy run catches up with a better answer. Same
input, same KPI shape -- so it also doubles as a cheap sanity oracle for the
discrete-event engine in tests.

Travel is AISLE-ROUTED (the model change this module was rebuilt around)
---------------------------------------------------------------------------
This oracle used to price travel as plain Manhattan distance -- straight
through the racking. The DES no longer does: ``engine.graph.AisleGraph``
registers every drawn rack run as an obstacle, so agents walk the aisles and
real travel is ~50% longer. The two answers therefore diverged structurally,
which is fatal for whsim's 「解析で当てる → DESで裏取り」 thesis: the instant
answer told a rosier story than the run that follows it.

Rather than pay for a graph search on the live path (building the routing grid
alone costs 40-70 ms on the bundled templates, before any Dijkstra), the fix is
the classic **aisle-travel formulation**, evaluated in closed form off the drawn
rack rectangles (``rackgeom.aisle_detour``, ~1 ms):

    travel/trip = 2·(depot leg + depot detour)          # out and back
                + (picks - 1)·hop                        # inter-pick hops
                + (aisles visited - 1)·hop detour        # ...that change aisle

A nearest-neighbour tour sweeps aisle by aisle, so at most
``min(picks, aisles) - 1`` of its ``picks - 1`` hops actually change aisle; the
rest stay in one aisle and pay no detour. Both detour terms are additive
constants derived from the rack-run length (see ``rackgeom.aisle_detour``), so
the whole correction is a handful of arithmetic ops and stays 爆速.

The trip is also amortised over the orders the engine really sweeps together
(``workmethod.orders_per_trip``, the engine's own rule) -- with aisle-routed
travel the depot round-trip is far too expensive to keep charging to every
order when the DES batches them.

No racking (a bare or unlaid-out model) ⇒ no detour, no batch ⇒ byte-identical
to the historical Manhattan behaviour. Never blocks.
"""

from __future__ import annotations

import math
import statistics

from whsim.engine.routing import manhattan
from whsim.rackgeom import aisle_detour
from whsim.schema.model import WarehouseModel
from whsim.workmethod import orders_per_trip


# Units picked per order LINE when demand comes from the profile rather than
# from imported orders: ``engine.processes._sample_order`` draws
# ``rng.randint(1, 3)``, i.e. a mean of 2. The oracle used to assume 1, which
# halved the handling term of every profile-driven estimate.
_PROFILE_UNITS_PER_LINE = 2.0


def _erlang_c(c: int, a: float) -> float:
    """Probability an arrival waits (Erlang C), offered load a = lambda/mu.

    The Erlang-B recursion is used instead of a literal ``a**n / n!`` sum: the
    batch solver below evaluates this a few dozen times per estimate, and a
    warehouse can carry hundreds of pickers -- the naive form is O(c^2) per call
    and overflows on the way. This is O(c), allocation-free and overflow-free.
    """
    if a <= 0:
        return 0.0
    if a >= c:  # overloaded: effectively always waits
        return 1.0
    # inv_b = 1 / B(n, a) built up by Erlang-B: B(n) = a·B(n-1) / (n + a·B(n-1)).
    inv_b = 1.0
    for n in range(1, c + 1):
        inv_b = 1.0 + inv_b * n / a
    b = 1.0 / inv_b                       # Erlang B blocking probability
    return b / (1.0 - (a / c) * (1.0 - b))


def _trip_travel_m(
    depot_leg: float,
    hop: float,
    n_picks: float,
    det: dict | None,
) -> float:
    """Metres walked on ONE picking trip that visits ``n_picks`` slots.

    Out-and-back to the pick area plus one hop per extra pick, with the
    aisle-network detour charged only on the hops that actually change aisle
    (a nearest-neighbour tour sweeps one aisle before moving to the next, so a
    trip with many picks per aisle detours far less per pick than a short one).
    """
    hops = max(n_picks - 1.0, 0.0)
    travel = 2.0 * depot_leg + hops * hop
    if det is not None:
        aisle_changes = min(hops, max(det["n_aisles"] - 1.0, 0.0))
        travel += aisle_changes * det["hop_extra_m"]
    return travel


def _release_window_s(model: WarehouseModel, b_cap: float) -> float:
    """Seconds a trip waits for a fuller batch — ``processes._pull_batch``'s wait.

    Mirrored from the engine so the oracle batches over the same window: a wave
    release holds for its (capped) bucket, a 種まき total-pick lets orders pile
    up briefly, and continuous release waits not at all.
    """
    work = model.process.effective_work()
    if b_cap <= 1 and work.consolidation != "sort":
        return 0.0                                   # no batching: no wait
    if work.release == "wave":
        return min(max(work.wave_interval_s, 1.0), 120.0)
    if work.consolidation == "sort":
        return 30.0
    return 0.0


def _batch_per_trip(
    model: WarehouseModel,
    b_cap: float,
    c: int,
    lam: float,
    trip_time_s,
) -> float:
    """How many orders one picking trip really sweeps (1 .. ``b_cap``).

    ``b_cap`` is only the engine's CAP; a picker can sweep no more orders than
    are actually waiting when it pulls. Those are the orders standing in the
    queue (M/M/c's ``Lq``) plus the ones that land during the release window,
    which is exactly what ``processes._pull_batch`` scoops up::

        B = 1 + min(b_cap - 1, lam·W + Lq(B))

    Lq falls as B rises (a bigger sweep is cheaper per order, so the queue
    drains), which makes the right-hand side strictly DECREASING in B — the
    fixed point is therefore unique and bisection finds it in a fixed number of
    cheap steps. (Plain iteration would oscillate between the extremes.)

    Degenerates cleanly: ``b_cap == 1`` or no demand ⇒ exactly 1, i.e. the
    single-order round trip this oracle has always priced.
    """
    if b_cap <= 1.0 or lam <= 0:
        return 1.0
    window = _release_window_s(model, b_cap)

    def fill(b: float) -> float:
        a = lam * (trip_time_s(b) / b)               # offered load, orders
        rho = a / c
        if rho >= 1.0:
            queued = b_cap                           # saturated: sweep the cap
        else:
            queued = _erlang_c(c, a) * rho / (1.0 - rho)
        return 1.0 + min(b_cap - 1.0, lam * window + queued)

    if fill(1.0) <= 1.0:
        return 1.0
    if fill(b_cap) >= b_cap:
        return b_cap
    lo, hi = 1.0, b_cap
    for _ in range(40):                              # ~1e-12 relative precision
        mid = (lo + hi) / 2.0
        if fill(mid) > mid:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def estimate(model: WarehouseModel) -> dict:
    speed = max(model.process.walk_speed_mps, 0.1)
    station = model.resources.stations[0] if model.resources.stations else None
    depot = (station.x, station.y) if station else (0.0, 0.0)

    # mean handling and round-trip travel per order
    if model.orders.outbound:
        lines_per = statistics.fmean(len(o.lines) for o in model.orders.outbound) or 1.0
        rate_per_hr = len(model.orders.outbound) / max(
            model.simulation.duration_s / 3600.0, 1e-9)
        qtys = [ln.qty for o in model.orders.outbound for ln in o.lines]
        units_per_line = statistics.fmean(qtys) if qtys else 1.0
    else:
        units_per_line = _PROFILE_UNITS_PER_LINE
        lines_per = max(model.orders.profile.lines_per_order_mean, 1.0)
        # The engine scales the profile arrival rate by peak_factor
        # (engine.processes.order_source); the oracle must match it or it
        # under-estimates load on peak scenarios.
        rate_per_hr = (model.orders.profile.rate_per_hr
                       * max(model.orders.profile.peak_factor, 0.0))

    ts_mean = statistics.fmean(it.ts_per_unit for it in model.items) if model.items else 1.5

    if model.locations:
        avg_depot_dist = statistics.fmean(
            manhattan(depot, (loc.x, loc.y)) for loc in model.locations)
    else:
        avg_depot_dist = (model.layout.bounds.width + model.layout.bounds.depth) / 4

    # The aisle network the DES routes on, in closed form off the drawn racks.
    # None (no racking / no layout) -> the historical straight-line behaviour.
    det = aisle_detour(model, depot)
    depot_leg = avg_depot_dist + (det["depot_extra_m"] if det else 0.0)
    hop = avg_depot_dist * 0.3           # crude inter-pick hop, as before

    # When there is no conveyor, the picker DOUBLES AS THE PACKER and is occupied
    # through packing too (see engine.processes.picker_agent's busy definition).
    # The picker service time must include pack time, or this oracle understates
    # picker utilisation relative to the engine. A conveyor OR a 仮置き(staging)
    # buffer decouples pack onto its own downstream stage, so it is excluded.
    has_conveyor = bool(model.resources.conveyors) and any(
        len(cv.points) >= 2 for cv in model.resources.conveyors)
    decoupled_pack = has_conveyor or model.process.staging_capacity > 0
    pack_s = 0.0 if decoupled_pack else max(model.process.pack_time_s, 0.0)

    c = sum(w.count for w in model.resources.workers if w.role == "picker") or 1
    lam = rate_per_hr / 3600.0           # arrivals/s

    def trip_time_s(b: float) -> float:
        """Seconds a picker is occupied by ONE trip that sweeps ``b`` orders."""
        n_picks = max(lines_per * b, 1.0)
        return (_trip_travel_m(depot_leg, hop, n_picks, det) / speed
                + n_picks * ts_mean * units_per_line
                + b * pack_s)

    b_cap = float(max(1, orders_per_trip(model)))
    batch = _batch_per_trip(model, b_cap, c, lam, trip_time_s)

    service_s = trip_time_s(batch) / batch   # picker-seconds per ORDER
    travel = _trip_travel_m(depot_leg, hop, max(lines_per * batch, 1.0), det) / batch

    mu = 1.0 / max(service_s, 1e-6)      # service/s per picker
    a = lam / mu                         # offered load
    rho = a / c                          # utilization

    pw = _erlang_c(c, a)
    wq = pw / (c * mu - lam) if (c * mu - lam) > 0 else float("inf")

    return {
        "method": "analytic_mmc",
        "service_time_s": service_s,
        # Aisle-routed metres per order — directly comparable to the DES's
        # ``kpis.walk_per_order_m``, which is what makes 解析↔DES auditable.
        "walk_m_per_order": travel,
        "orders_per_trip": batch,
        "picker_utilization": min(rho, 1.0),
        "capacity_orders_per_hr": c * mu * 3600.0,
        "offered_orders_per_hr": rate_per_hr,
        "pick_wait_mean_s": wq if math.isfinite(wq) else None,
        "overloaded": rho >= 1.0,
    }
