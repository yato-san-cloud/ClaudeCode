"""ピッカー経路方式の比較表 — the same order set walked four ways.

`engine/pickroute.py` gives the classic routing disciplines (S字/折り返し/最大
ギャップ) and `picktour.optimize` gives the 2-opt near-optimum. The question a
proposal actually has to answer is not "which heuristic is prettiest" but **how
many metres does this floor cost under each rule** — because a discipline is a
work instruction, and swapping one for another is free (no capex, no layout
change). This module answers it in closed form: every order's pick points are
routed by every policy and the trip lengths are summed.

No DES, no SimPy, no randomness beyond an explicit ``seed`` — so it is fast
enough to re-run while someone drags a rack, and the answer is reproducible.

Distance convention (matters, and is disclosed in ``assumptions``)
-----------------------------------------------------------------
* A *trip* is depot → the picks in the policy's order. The return leg to the
  depot is NOT added, matching ``picktour.route_length`` and the engine's
  per-trip walk accounting, so a metre here is the same metre the DES reports.
* The metric is the wall/rack-aware aisle graph (``engine.graph.AisleGraph``)
  when the model has anything to route around, else Manhattan — the same
  precedence ``World.dist`` uses, minus the measured-matrix override (a
  comparison of rules does not need per-shelf measurements to be fair, and
  loading them is the expensive part).

Never blocks: a model with no locations, no SKUs and no orders still answers,
with ``has_data: False`` and zeroes.
"""

from __future__ import annotations

import random
from collections.abc import Callable, Sequence

from whsim import picktour
from whsim.engine.pickroute import route_order
from whsim.engine.routing import manhattan, nearest_neighbor_route

Point = tuple[float, float]

DEFAULT_POLICIES = ("s_shape", "return", "largest_gap", "optimized")

# Human labels for the report (user-facing strings are Japanese by convention).
POLICY_LABELS = {
    "s_shape": "S字（蛇行）",
    "return": "折り返し",
    "largest_gap": "最大ギャップ",
    "nearest": "最近傍（現行既定）",
    "optimized": "2-opt 近似最適",
}


def _sku_points(model) -> dict[str, Point]:
    """SKU → its pick face (x, y).

    Mirrors ``engine.build``'s resolution order — an item's ``default_location``
    first, then any location that carries the SKU — so the comparison routes the
    same points the engine would walk. Kept local (a few lines) rather than
    building a whole ``World``: this module must stay import-light and SimPy-free.
    """
    loc_by_id = {loc.id: loc for loc in model.locations}
    xy: dict[str, Point] = {}
    for it in model.items:
        loc = loc_by_id.get(it.default_location) if it.default_location else None
        if loc is not None:
            xy[it.sku] = (float(loc.x), float(loc.y))
    for loc in model.locations:
        if loc.sku and loc.sku not in xy:
            xy[loc.sku] = (float(loc.x), float(loc.y))
    return xy


def _depot(model) -> Point:
    """Where a trip starts/ends: the pack area (first station), else the origin.

    Same rule as ``engine.build``'s ``home``."""
    stations = model.resources.stations
    if stations:
        return (float(stations[0].x), float(stations[0].y))
    return (0.0, 0.0)


def _sample_orders(model, sku_xy: dict[str, Point], n_orders: int, seed: int) -> list[list[Point]]:
    """Synthesise ``n_orders`` order line-sets from ``orders.profile``.

    A model that has never had shipment data imported still has a demand profile
    (every field defaults), so the comparison is answerable on day one. The shape
    mirrors the engine's own generator — exponential line count, pick-frequency
    weighted SKU choice — but is deliberately a local re-implementation: importing
    the engine's sampler would drag SimPy and a built ``World`` into what is a
    closed-form report. Deterministic in ``seed`` (its own ``random.Random``; the
    global RNG is never touched)."""
    prof = model.orders.profile
    by_sku = {it.sku: it for it in model.items}
    skus = [s for s in (it.sku for it in model.items) if s in sku_xy]
    weights = [max(by_sku[s].pick_freq, 1e-6) for s in skus]
    if not skus:
        return []
    rng = random.Random(seed)
    mean_lines = max(float(prof.lines_per_order_mean), 0.5)
    out: list[list[Point]] = []
    for _ in range(max(0, int(n_orders))):
        n_lines = max(1, int(rng.expovariate(1.0 / mean_lines)))
        pts = [sku_xy[rng.choices(skus, weights=weights, k=1)[0]] for _ in range(n_lines)]
        out.append(pts)
    return out


def _order_points(orders, sku_xy: dict[str, Point], n_orders: int) -> list[list[Point]]:
    """Explicit orders → their pick points, in arrival order, first ``n_orders``.

    Lines whose SKU is not placed anywhere are skipped (never blocks: a partial
    slotting still yields a comparable trip), and an order left with no placed
    line is dropped entirely."""
    ordered = sorted(orders, key=lambda o: (float(o.arrival_s), str(o.order_id)))
    out: list[list[Point]] = []
    for o in ordered:
        pts = [sku_xy[ln.sku] for ln in o.lines if ln.sku in sku_xy]
        if pts:
            out.append(pts)
        if 0 < n_orders <= len(out):
            break
    return out


def _distance_fn(model) -> tuple[Callable[[Point, Point], float], str]:
    """``(dist, metric_name)`` — aisle graph when it is meaningful, else Manhattan.

    A broken/absent layout must not break the report, so any failure to build the
    graph degrades to Manhattan rather than raising."""
    try:
        from whsim.engine.graph import AisleGraph
        g = AisleGraph.from_model(model)
    except Exception:  # noqa: BLE001 — routing detail must never break the report
        return manhattan, "manhattan"
    if g.enabled:
        return g.distance, "graph"
    return manhattan, "manhattan"


def _route(policy: str, start: Point, pts: Sequence[Point], dist) -> list[int]:
    """One trip's visiting order under ``policy``."""
    if policy == "optimized":
        return picktour.optimize(start, list(pts), dist)
    if policy == "nearest":
        return nearest_neighbor_route(start, list(pts))
    return route_order(policy, start, list(pts))


def compare(
    model,
    orders=None,
    policies: Sequence[str] = DEFAULT_POLICIES,
    n_orders: int = 50,
    seed: int = 42,
    dist: Callable[[Point, Point], float] | None = None,
) -> dict:
    """Total walking distance for the SAME order set under each routing policy.

    Parameters
    ----------
    model
        A ``WarehouseModel``. Supplies the pick faces, the depot and the metric.
    orders
        Explicit ``Order`` objects to route. ``None`` (default) uses the model's
        own ``orders.outbound`` when it has any, else samples ``n_orders`` from
        ``orders.profile`` with ``seed``.
    policies
        Which policies to score. Understood: the three disciplines from
        ``engine.pickroute`` plus ``"nearest"`` (the engine's current default,
        useful as the do-nothing column) and ``"optimized"`` (picktour 2-opt).
    n_orders
        How many orders to route (cap for explicit orders, count for sampled
        ones). ``<= 0`` means "all of them" for explicit orders.
    seed
        Only used when orders are sampled.
    dist
        Optional metric override, e.g. an already-built ``AisleGraph.distance``
        (building the graph dominates the runtime, so a caller that re-renders
        the table should build it once) or plain ``manhattan`` for an instant
        answer. ``None`` (default) resolves it from the model.

    Returns
    -------
    dict
        ``{"policies": {name: {"total_m", "per_order_m", "vs_best_pct", "label"}},
        "best": name, "n_orders": int, "assumptions": [...]}`` plus the additive
        keys ``has_data``, ``metric`` and ``orders_source``. ``vs_best_pct`` is
        how much longer than the best policy that policy walks (0.0 for the best).
        On a tie the policy listed FIRST in ``policies`` is named ``best`` — a
        rule a picker can follow beats a solver that only matched it.
    """
    names = [p for p in policies] or list(DEFAULT_POLICIES)
    sku_xy = _sku_points(model)

    if orders is not None:
        trips = _order_points(orders, sku_xy, n_orders)
        source = "given"
    elif model.orders.outbound:
        trips = _order_points(model.orders.outbound, sku_xy, n_orders)
        source = "model"
    else:
        trips = _sample_orders(model, sku_xy, n_orders, seed)
        source = "profile"

    if dist is None:
        dist, metric = _distance_fn(model)
    else:
        metric = "injected"
    start = _depot(model)

    totals: dict[str, float] = {}
    for name in names:
        total = 0.0
        for pts in trips:
            route = _route(name, start, pts, dist)
            total += picktour.route_length(start, pts, route, dist)
        totals[name] = total

    n = len(trips)
    best = min(totals, key=lambda k: (totals[k], names.index(k))) if totals else ""
    best_total = totals.get(best, 0.0)
    out_policies = {}
    for name in names:
        t = totals[name]
        out_policies[name] = {
            "label": POLICY_LABELS.get(name, name),
            "total_m": round(t, 2),
            "per_order_m": round(t / n, 2) if n else 0.0,
            "vs_best_pct": round((t - best_total) / best_total * 100.0, 2) if best_total > 0 else 0.0,
        }

    metric_note = {
        "graph": "距離は通路グラフ（壁・ラックを迂回）で測定",
        "manhattan": "距離はマンハッタン（障害物なし＝直交移動が可能な前提）で測定",
        "injected": "距離は呼び出し側が指定した尺度で測定",
    }[metric]
    source_note = {
        "given": "指定されたオーダーを対象に集計",
        "model": "取込済みの出荷オーダー（到着順）を対象に集計",
        "profile": f"出荷実績が無いため需要プロファイルから {n} 件を生成（seed={seed}・再現可能）",
    }[source]
    assumptions = [
        source_note,
        metric_note,
        "1トリップ＝デポ→各ピックの片道積算（復路はエンジンの1トリップ歩行距離と同じく含めない）",
        "通路は各ピック位置の x 列から導出（描かれたラック形状には依存しない）",
        "同一オーダー集合・同一デポ・同一距離尺度で比較（差は経路規律のみに由来）",
        "作業方式（バッチ/ゾーン等）は考慮しない。1オーダー1トリップの前提",
    ]
    if not trips:
        assumptions = [
            "ロケーション未配置または出荷オーダー・需要が無いため比較対象のトリップが0件",
            *assumptions[1:],
        ]

    return {
        "policies": out_policies,
        "best": best,
        "n_orders": n,
        "has_data": bool(trips),
        "metric": metric,
        "orders_source": source,
        "assumptions": assumptions,
    }
