"""Closed-form fast estimate (M/M/c on the picking stage).

Returns KPIs in milliseconds for the drag-and-drop "instant gratification"
moment, while the heavyweight SimPy run catches up with a better answer. Same
input, same KPI shape -- so it also doubles as a cheap sanity oracle for the
discrete-event engine in tests.
"""

from __future__ import annotations

import math
import statistics

from whsim.engine.routing import manhattan
from whsim.schema.model import WarehouseModel


def _erlang_c(c: int, a: float) -> float:
    """Probability an arrival waits (Erlang C), offered load a = lambda/mu."""
    if a <= 0:
        return 0.0
    if a >= c:  # overloaded: effectively always waits
        return 1.0
    s = sum(a**n / math.factorial(n) for n in range(c))
    top = a**c / (math.factorial(c) * (1 - a / c))
    return top / (s + top)


def estimate(model: WarehouseModel) -> dict:
    speed = max(model.process.walk_speed_mps, 0.1)
    station = model.resources.stations[0] if model.resources.stations else None
    depot = (station.x, station.y) if station else (0.0, 0.0)

    # mean handling and round-trip travel per order
    if model.orders.outbound:
        lines_per = statistics.fmean(len(o.lines) for o in model.orders.outbound) or 1.0
        rate_per_hr = len(model.orders.outbound) / max(
            model.simulation.duration_s / 3600.0, 1e-9)
    else:
        lines_per = max(model.orders.profile.lines_per_order_mean, 1.0)
        # The engine scales the profile arrival rate by peak_factor
        # (engine.processes.order_source); the oracle must match it or it
        # under-estimates load on peak scenarios.
        rate_per_hr = (model.orders.profile.rate_per_hr
                       * max(model.orders.profile.peak_factor, 0.0))

    ts_mean = statistics.fmean(it.ts_per_unit for it in model.items) if model.items else 1.5
    handling = lines_per * ts_mean * 1.0  # ~1 unit/line assumed for the estimate

    if model.locations:
        avg_depot_dist = statistics.fmean(
            manhattan(depot, (loc.x, loc.y)) for loc in model.locations)
    else:
        avg_depot_dist = (model.layout.bounds.width + model.layout.bounds.depth) / 4
    # crude route length: out-and-back plus a little inter-pick travel
    travel = 2 * avg_depot_dist + max(lines_per - 1, 0) * avg_depot_dist * 0.3
    service_s = travel / speed + handling

    c = sum(w.count for w in model.resources.workers if w.role == "picker") or 1
    lam = rate_per_hr / 3600.0           # arrivals/s
    mu = 1.0 / max(service_s, 1e-6)      # service/s per picker
    a = lam / mu                         # offered load
    rho = a / c                          # utilization

    pw = _erlang_c(c, a)
    wq = pw / (c * mu - lam) if (c * mu - lam) > 0 else float("inf")

    return {
        "method": "analytic_mmc",
        "service_time_s": service_s,
        "picker_utilization": min(rho, 1.0),
        "capacity_orders_per_hr": c * mu * 3600.0,
        "offered_orders_per_hr": rate_per_hr,
        "pick_wait_mean_s": wq if math.isfinite(wq) else None,
        "overloaded": rho >= 1.0,
    }
