"""生産性試算 — 解析的（動作時間ベース）なピッキング生産性。

The DES (engine/) is the heavyweight truth, but the SLC-style workflow wants a
**fast, explainable, layout-driven** productivity estimate FIRST — pick
オーダー/マルチ/トータル from the floor geometry (the MapMaker距離) and a
motion-time model, before paying for a full discrete-event run.

Model (per work method, all analytic — no simulation):

    tour ≈ 0.75·√(n_picks · pick_area)         # BHH random-tour length in a
           + 2·depot_dist                        #   W×D area + in/out leg
    t_trip = tour/walk_speed                      # 移動
           + n_picks·handle_s                     # 手扱い (pick)
           + (n_picks·sort_s if 種まき else 0)     # 仕分け (種まき only)
    lines/h  = n_picks  / t_trip · 3600
    orders/h = n_orders / t_trip · 3600

where n_orders = orders_per_trip (the method's batch), n_picks =
n_orders·lines_per_order. Batching amortises the tour over more lines (移動↓);
種まき(total) minimises the tour but adds a sort step (仕分け↑) — the classic
travel-vs-sort trade-off, computed in closed form.

Geometry comes straight from the model: the storage zones' footprint is the
pick area, and the dispatch (梱包台 / 出荷ゾーン) is the depot. Everything has a
default so a bare model still produces a sane number ("never blocks").
"""

from __future__ import annotations

import math

from whsim.schema.model import WarehouseModel
from whsim.workmethod import METHOD_PRESETS

# Motion-time defaults (editable via params). JP-warehouse-ish standards.
DEFAULTS = {
    "walk_speed_mps": 1.2,      # 歩行速度
    "handle_s_per_line": 6.0,   # 1行の手扱い時間（棚前の取り出し・確認）
    "sort_s_per_line": 4.0,     # 種まきの後仕分け（1行あたり）
    "lines_per_order": None,    # None → derive from orders, else override
    "tour_constant": 0.75,      # BHH 定数（矩形内ランダム巡回）
    "labour_cost_per_hour": 2000.0,
    "working_hours_per_day": 8.0,
}


def _pick_area_and_depot(model: WarehouseModel) -> tuple[float, float, float, float]:
    """(pick_area_m2, area_cx, area_cy, depot_dist_m) from the layout.

    pick area = union bbox of storage zones (else the whole floor); depot = the
    first 梱包台/station, else the centre of a packing/shipping zone, else the
    floor's bottom edge. depot_dist = centre-to-depot straight line."""
    b = model.layout.bounds
    stores = [z for z in model.layout.zones if z.type == "storage"]
    if stores:
        x0 = min(z.x for z in stores)
        x1 = max(z.x + z.w for z in stores)
        y0 = min(z.y for z in stores)
        y1 = max(z.y + z.h for z in stores)
    else:
        x0, y0, x1, y1 = 0.0, 0.0, b.width, b.depth
    area = max(1.0, (x1 - x0) * (y1 - y0))
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0

    depot = None
    if model.resources.stations:
        s = model.resources.stations[0]
        depot = (float(s.x), float(s.y))
    if depot is None:
        for zt in ("packing", "shipping"):
            z = next((q for q in model.layout.zones if q.type == zt), None)
            if z:
                depot = (z.x + z.w / 2.0, z.y + z.h / 2.0)
                break
    if depot is None:
        depot = (b.width / 2.0, 0.0)
    depot_dist = math.hypot(cx - depot[0], cy - depot[1])
    return area, cx, cy, depot_dist


def _lines_per_order(model: WarehouseModel) -> float:
    """Average lines/order from the outbound orders, else the demand profile."""
    orders = model.orders.outbound
    if orders:
        n = sum(len(o.lines) for o in orders)
        return max(1.0, n / max(1, len(orders)))
    return max(1.0, float(getattr(model.orders.profile, "lines_per_order_mean", 1.5) or 1.5))


def _daily_pick_lines(model: WarehouseModel) -> float:
    """出荷行数/日 — distinct-day average of outbound order lines (for headcount)."""
    orders = model.orders.outbound
    if not orders:
        prof = model.orders.profile
        rate = max(0.0, float(getattr(prof, "rate_per_hr", 0.0) or 0.0))
        hrs = max(1.0, float(getattr(model.simulation, "working_hours_per_day", 8.0) or 8.0))
        return rate * hrs * _lines_per_order(model)
    days = {int((o.arrival_s or 0.0) // 86400) for o in orders}
    total_lines = sum(len(o.lines) for o in orders)
    return total_lines / max(1, len(days))


def estimate_pickrate(model: WarehouseModel, params: dict | None = None) -> dict:
    """Analytic picking productivity for every work method. Pure; JSON-able."""
    p = {**DEFAULTS, **{k: v for k, v in (params or {}).items() if v is not None}}
    walk = max(0.1, float(p["walk_speed_mps"]))
    handle = max(0.0, float(p["handle_s_per_line"]))
    sort_s = max(0.0, float(p["sort_s_per_line"]))
    kk = max(0.1, float(p["tour_constant"]))
    rate = max(0.0, float(p["labour_cost_per_hour"]))
    hours = max(1.0, float(p["working_hours_per_day"]))

    area, _cx, _cy, depot = _pick_area_and_depot(model)
    lpo = float(p["lines_per_order"]) if p["lines_per_order"] else _lines_per_order(model)
    lpo = max(1.0, lpo)
    daily_lines = _daily_pick_lines(model)

    methods = []
    for preset in METHOD_PRESETS:
        work = preset["work"]
        opt = max(1, int(work.get("orders_per_trip", 1)))
        is_sort = work.get("consolidation") == "sort"
        n_picks = opt * lpo
        # tour: random-visit length in the pick area + the in/out depot leg.
        tour = kk * math.sqrt(max(1.0, n_picks) * area) + 2.0 * depot
        travel_s = tour / walk
        handle_total = n_picks * handle
        sort_total = (n_picks * sort_s) if is_sort else 0.0
        t_trip = max(1e-6, travel_s + handle_total + sort_total)
        lines_per_h = n_picks / t_trip * 3600.0
        orders_per_h = opt / t_trip * 3600.0
        travel_per_order = tour / opt
        sort_per_order = sort_total / opt
        cost_per_order = (t_trip / opt) / 3600.0 * rate
        pickers = math.ceil(daily_lines / max(1e-6, lines_per_h * hours)) if daily_lines else 0
        methods.append({
            "id": preset["id"], "label": preset["label"], "desc": preset["desc"],
            "orders_per_trip": opt, "consolidation": work.get("consolidation", "pick"),
            "lines_per_hour": round(lines_per_h, 1),
            "orders_per_hour": round(orders_per_h, 1),
            "travel_per_order_m": round(travel_per_order, 1),
            "sort_per_order_s": round(sort_per_order, 1),
            "seconds_per_order": round(t_trip / opt, 1),
            "cost_per_order": round(cost_per_order, 1),
            "pickers": pickers,
        })

    # recommend = highest lines/hour (≡ lowest cost/line) — the motion-time winner.
    best = max(methods, key=lambda m: m["lines_per_hour"])
    return {
        "has_layout": bool([z for z in model.layout.zones if z.type == "storage"]),
        "geometry": {"pick_area_m2": round(area, 1), "depot_dist_m": round(depot, 1),
                     "lines_per_order": round(lpo, 2), "daily_pick_lines": round(daily_lines)},
        "params": {"walk_speed_mps": walk, "handle_s_per_line": handle,
                   "sort_s_per_line": sort_s, "labour_cost_per_hour": int(rate),
                   "working_hours_per_day": hours},
        "methods": methods,
        "recommend_id": best["id"],
        "verdict": (f"{best['label']}が最速（{best['lines_per_hour']:.0f}行/h・"
                    f"¥{best['cost_per_order']:.0f}/件）。移動と仕分けの兼ね合いで選定。"),
    }
