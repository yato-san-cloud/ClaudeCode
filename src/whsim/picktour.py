"""Pick-sequence (tour) optimizers over an injected distance function.

The engine already greedily orders a pick by nearest-neighbour
(``engine.routing.nearest_neighbor_route``). This module goes BEYOND greedy: it
adds 2-opt (and a light Or-opt) local search that strictly improves a tour, plus
a multi-order / total-pick aggregator that fuses several orders' lines into ONE
consolidated tour.

Everything here is a **pure function** over a caller-supplied ``dist(a, b)``
metric (pass ``World.dist`` for wall-aware distance, or a Manhattan fallback for
a cheap analytic estimate). No SimPy, no schema, stdlib only — so it is trivially
testable and reusable from both the engine and the analytic endpoint.

Determinism: every routine is a deterministic function of its inputs (ties broken
by index), and the local-search loops are bounded so even a several-hundred-stop
tour stays fast.

Distance/length convention
--------------------------
A *route* is an ordering of indices into ``points``. A *tour length* is the sum
of leg distances from ``start`` through the points in route order. We do NOT add
a return leg back to ``start`` (the engine carries to pack separately), so the
length is directly comparable to the engine's per-trip walk distance.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

Point = tuple[float, float]
DistFn = Callable[[Point, Point], float]

# 2-opt is O(n^2) per sweep; cap work so a big tour can't stall the run.
_MAX_TWO_OPT_PASSES = 12
# Above this many stops, restrict 2-opt moves to a local neighbourhood window so
# the per-sweep cost grows ~linearly instead of quadratically.
_NEIGHBOURHOOD_THRESHOLD = 150
_NEIGHBOURHOOD_WINDOW = 40


def route_length(
    start: Point, points: Sequence[Point], route: Sequence[int], dist: DistFn
) -> float:
    """Total travel from ``start`` through ``points`` visited in ``route`` order.

    No return-to-start leg (matches the engine's per-trip walk accounting)."""
    if not route:
        return 0.0
    total = 0.0
    cur = start
    for i in route:
        total += dist(cur, points[i])
        cur = points[i]
    return total


def naive_route(points: Sequence[Point]) -> list[int]:
    """The baseline 'do nothing' ordering: visit points as given (input order).

    This stands in for a naive S-shape / list-order sweep — the worst of the
    three, used only as the upper-bound reference in comparisons."""
    return list(range(len(points)))


def greedy_nn(start: Point, points: Sequence[Point], dist: DistFn) -> list[int]:
    """Greedy nearest-neighbour visiting order (indices into ``points``).

    Same construction as ``engine.routing.nearest_neighbor_route`` but over an
    injected metric. Ties are broken by the lowest index, so it is deterministic.
    This is the baseline the 2-opt below is required to *match or beat*."""
    n = len(points)
    remaining = list(range(n))
    order: list[int] = []
    cur = start
    while remaining:
        best_i = remaining[0]
        best_d = dist(cur, points[best_i])
        for j in remaining[1:]:
            d = dist(cur, points[j])
            if d < best_d:
                best_d, best_i = d, j
        order.append(best_i)
        cur = points[best_i]
        remaining.remove(best_i)
    return order


def _seg_endpoints(start: Point, points: Sequence[Point], route: list[int], k: int) -> Point:
    """The point preceding position ``k`` in the walk (``start`` when k == 0)."""
    return start if k == 0 else points[route[k - 1]]


def two_opt(
    start: Point,
    points: Sequence[Point],
    dist: DistFn,
    route: Sequence[int] | None = None,
    max_passes: int = _MAX_TWO_OPT_PASSES,
) -> list[int]:
    """Improve a tour with 2-opt local search (segment reversal).

    Starts from ``route`` (or a greedy-NN tour when None) and repeatedly reverses
    any segment whose reversal shortens the open tour, until no improving move
    remains or ``max_passes`` is reached. Because every accepted move strictly
    decreases the length and we start from greedy-NN, the result is always
    ``<= greedy_nn`` length. Deterministic (first-improvement, scanned in order).

    For large tours (>= ``_NEIGHBOURHOOD_THRESHOLD`` stops) candidate ``j`` is
    restricted to a window after ``i`` so a sweep stays near-linear; the move set
    is a subset, so the monotone-improvement guarantee still holds.
    """
    if route is None:
        route = greedy_nn(start, points, dist)
    tour = list(route)
    n = len(tour)
    if n < 3:
        return tour

    window = _NEIGHBOURHOOD_WINDOW if n >= _NEIGHBOURHOOD_THRESHOLD else n

    for _ in range(max_passes):
        improved = False
        for i in range(n - 1):
            a = _seg_endpoints(start, points, tour, i)   # node before the segment
            b = points[tour[i]]                           # first node of segment
            j_max = min(n - 1, i + window)
            for j in range(i + 1, j_max + 1):
                c = points[tour[j]]                       # last node of segment
                # reversing tour[i..j] swaps edges (a-b, c-d) for (a-c, b-d)
                if j + 1 < n:
                    d = points[tour[j + 1]]
                    delta = (dist(a, c) + dist(b, d)) - (dist(a, b) + dist(c, d))
                else:
                    # segment runs to the end: only the entry edge a-b changes
                    delta = dist(a, c) - dist(a, b)
                if delta < -1e-9:
                    tour[i:j + 1] = reversed(tour[i:j + 1])
                    improved = True
                    b = points[tour[i]]                   # segment head moved
        if not improved:
            break
    return tour


def or_opt(
    start: Point,
    points: Sequence[Point],
    dist: DistFn,
    route: Sequence[int] | None = None,
    max_passes: int = 3,
) -> list[int]:
    """Light Or-opt: relocate short chains (length 1..3) to a better position.

    Complements 2-opt (which only reverses segments) by *moving* a small run of
    stops elsewhere in the tour. Every accepted relocation strictly shortens the
    open tour, so the result never exceeds the input length. Deterministic."""
    if route is None:
        route = greedy_nn(start, points, dist)
    tour = list(route)
    n = len(tour)
    if n < 3:
        return tour

    def leg(u: int, v: int) -> float:
        # distance between two *tour positions*, treating position -1 as start.
        pu = start if u < 0 else points[tour[u]]
        pv = points[tour[v]]
        return dist(pu, pv)

    for _ in range(max_passes):
        improved = False
        for seg_len in (1, 2, 3):
            i = 0
            while i + seg_len <= n:
                # cost of removing chain tour[i..i+seg_len-1]
                prev_i = i - 1
                nxt_i = i + seg_len
                removed = leg(prev_i, i)
                if nxt_i < n:
                    removed += leg(i + seg_len - 1, nxt_i)
                    closed = dist(
                        start if prev_i < 0 else points[tour[prev_i]],
                        points[tour[nxt_i]],
                    )
                else:
                    closed = 0.0
                gain_remove = removed - closed
                chain = tour[i:i + seg_len]
                best_delta = -1e-9
                best_pos = -1
                for k in range(n - seg_len + 1):
                    if i - 1 <= k <= i + seg_len:
                        continue  # inserting back where it came from
                    # build the candidate position in the post-removal list
                    rest = tour[:i] + tour[i + seg_len:]
                    if k > len(rest):
                        break
                    left = start if k == 0 else points[rest[k - 1]]
                    head = points[chain[0]]
                    tail = points[chain[-1]]
                    added = dist(left, head)
                    if k < len(rest):
                        right = points[rest[k]]
                        added += dist(tail, right) - dist(left, right)
                    delta = added - gain_remove
                    if delta < best_delta:
                        best_delta = delta
                        best_pos = k
                if best_pos >= 0:
                    rest = tour[:i] + tour[i + seg_len:]
                    tour = rest[:best_pos] + chain + rest[best_pos:]
                    improved = True
                i += 1
        if not improved:
            break
    return tour


def optimize(
    start: Point,
    points: Sequence[Point],
    dist: DistFn,
    use_or_opt: bool = True,
) -> list[int]:
    """The recommended pipeline: greedy-NN seed -> 2-opt (-> Or-opt).

    Returns a visiting order at least as short as greedy-NN. ``use_or_opt`` runs
    the light Or-opt pass after 2-opt for a further (optional) improvement; the
    result is re-2-opted so the two passes settle."""
    route = greedy_nn(start, points, dist)
    route = two_opt(start, points, dist, route)
    if use_or_opt and len(route) >= 4:
        route = or_opt(start, points, dist, route)
        route = two_opt(start, points, dist, route)
    return route


def consolidated_tour(
    start: Point,
    orders_points: Sequence[Sequence[Point]],
    dist: DistFn,
    optimize_tour: bool = True,
) -> tuple[list[Point], list[int]]:
    """Aggregate several orders' pick points into ONE consolidated tour.

    This is the multi-order / total variant: dedupe the union of all the orders'
    pick points (a location shared by two orders is visited once), then route the
    union as a single sweep. Returns ``(unique_points, route)`` where ``route``
    indexes ``unique_points``. With ``optimize_tour`` the route is 2-opt'd, else
    it is greedy-NN.

    Points are deduped on rounded coordinates (0.001 m) so floating jitter does
    not split a shared shelf into two stops; first occurrence wins (deterministic
    ordering)."""
    seen: dict[tuple[int, int], int] = {}
    unique: list[Point] = []
    for opts in orders_points:
        for p in opts:
            key = (round(p[0] * 1000), round(p[1] * 1000))
            if key not in seen:
                seen[key] = len(unique)
                unique.append(p)
    if not unique:
        return [], []
    route = (
        optimize(start, unique, dist) if optimize_tour
        else greedy_nn(start, unique, dist)
    )
    return unique, route
