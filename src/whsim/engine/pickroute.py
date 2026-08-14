"""Classic single-picker routing disciplines (SPRP heuristics) as visit ORDERS.

The engine already had two ways to sequence one trip's picks: greedy
nearest-neighbour (``engine.routing.nearest_neighbor_route``) and a 2-opt local
search (``picktour.optimize``). Both are *metric* heuristics — they only look at
distances. Real warehouses are routed by *disciplines* instead: a written rule a
picker can follow without a computer, defined on the aisle structure of the
floor. This module implements the three textbook ones (Hall 1993 / Petersen
1997 / de Koster et al. 2007):

* ``s_shape``      — 蛇行 / traversal: enter every aisle that holds a pick and
  walk it end to end, snaking (first aisle front→back, next back→front, ...).
* ``return``       — 折り返し: enter each aisle from the FRONT cross-aisle, walk
  in to its deepest pick, come back out the same way.
* ``largest_gap``  — 最大ギャップ: in each aisle find the longest stretch with no
  picks (between two adjacent picks, or between a pick and an aisle end) and
  never walk it — the picks on the front side of that gap are taken from the
  front cross-aisle, the ones on the back side from the back cross-aisle. The
  first and last pick aisles are traversed end to end so the picker can change
  cross-aisle (the standard form).

Contract (deliberately tiny, matching ``processes._route_order``)
-----------------------------------------------------------------
``route_order(policy, start, pts) -> list[int]`` returns a permutation of the
indices of ``pts`` — the ORDER the picks are visited in. It never returns
coordinates and never walks: converting the order into metres (aisle graph,
measured overrides or Manhattan) and into keyframes is the engine's job.

**Order decides distance.** That is the premise the whole module rests on: for
rectilinear travel the trip length is fully determined by the sequence, because
the metric charges the cross-aisle hop and the walk out of an aisle as one
``|Δx| + |Δy|`` leg. So a discipline is expressible as a *sort*, and the same
order can be scored under Manhattan (analytic) or under the wall-aware graph
(DES) without the policy knowing which. The consequence to be honest about: a
metric that lets a picker cut sideways through racking will under-count an
S-shape's "walk to the end of the aisle" — the discipline is still the one that
was walked, the metre count is only as good as the metric it is scored with.

Aisle structure comes from the PICK POINTS, not from rack geometry
------------------------------------------------------------------
Aisles are the distinct ``round(x, 1)`` columns of ``pts`` (the same rule the
engine's zone branch already uses), and the aisle span is the y-range of ``pts``.
So this is a pure function of its arguments — no model, no ``rackgeom``, no
schema, no randomness — and it works on an imported layout that has no authored
racks at all (never blocks). The FRONT cross-aisle is the end nearer ``start``
(the depot side); the BACK is the other one.

Anything that is not one of the three names falls back to greedy
nearest-neighbour, so an unknown/typo'd policy string still routes.
"""

from __future__ import annotations

from whsim.engine.routing import nearest_neighbor_route

Point = tuple[float, float]

# Aisle identity: pick faces on the same rack column share an x within a few cm.
# 0.1 m is the same rounding ``processes._route_order`` uses for zone columns, so
# the two agree about what "an aisle" is.
_AISLE_ROUND = 1

POLICIES = ("s_shape", "return", "largest_gap")


def _aisles(pts: list[Point]) -> dict[float, list[int]]:
    """Group pick indices by aisle (their rounded x column)."""
    cols: dict[float, list[int]] = {}
    for i, p in enumerate(pts):
        cols.setdefault(round(float(p[0]), _AISLE_ROUND), []).append(i)
    return cols


def _aisle_sequence(start: Point, columns: list[float]) -> list[float]:
    """The order the aisles are worked, nearest-to-the-depot end first.

    Ascending x normally; descending when ``start`` sits nearer the high-x end,
    so a depot on the right does not send the picker across the whole floor
    before starting. Ties resolve to ascending (deterministic)."""
    lo, hi = columns[0], columns[-1]
    if abs(start[0] - hi) < abs(start[0] - lo):
        return list(reversed(columns))
    return list(columns)


def _depth_fn(start: Point, pts: list[Point]):
    """``(depth, span)`` — distance of a pick from the FRONT cross-aisle, and the
    aisle length.

    The front is the end of the y-range nearer ``start`` (the depot side), so a
    model whose picking area lies *below* the depot is handled by the same code
    with the axis flipped. ``span`` is the front-to-back length used by
    largest-gap (all aisles share the same two cross-aisles)."""
    ys = [float(p[1]) for p in pts]
    y_lo, y_hi = min(ys), max(ys)
    front_low = abs(float(start[1]) - y_lo) <= abs(float(start[1]) - y_hi)
    span = y_hi - y_lo

    def depth(i: int) -> float:
        y = float(pts[i][1])
        return (y - y_lo) if front_low else (y_hi - y)

    return depth, span


def _split_largest_gap(order_front_first: list[int], depth, span: float) -> tuple[list, list]:
    """Split one aisle's picks at its largest empty stretch.

    ``order_front_first`` is that aisle's picks sorted front→back. The gaps are
    the front end → first pick, every adjacent pair, and last pick → back end
    (``span``). Everything before the widest gap is reachable from the front,
    everything after it from the back — so the widest stretch is never walked.
    First maximum wins (deterministic); an all-equal aisle therefore splits at
    the front gap, i.e. is served from the back."""
    if not order_front_first:
        return [], []
    ds = [depth(i) for i in order_front_first]
    gaps = [ds[0]] + [ds[k] - ds[k - 1] for k in range(1, len(ds))] + [span - ds[-1]]
    g = max(range(len(gaps)), key=lambda k: (gaps[k], -k))
    return order_front_first[:g], order_front_first[g:]


def route_order(policy: str, start: Point, pts: list[Point]) -> list[int]:
    """Visiting order (indices into ``pts``) for one trip under ``policy``.

    ``policy`` ∈ ``{"s_shape", "return", "largest_gap"}``; anything else (and any
    degenerate input) falls back to greedy nearest-neighbour. Pure, deterministic
    and side-effect free — ties always break on the input index."""
    if not pts:
        return []
    if policy not in POLICIES or len(pts) == 1:
        return nearest_neighbor_route(start, list(pts))

    pts = [(float(p[0]), float(p[1])) for p in pts]
    cols = _aisles(pts)
    seq = _aisle_sequence(start, sorted(cols))
    depth, span = _depth_fn(start, pts)

    def front_first(ax: float) -> list[int]:
        return sorted(cols[ax], key=lambda i: (depth(i), i))

    if policy == "return":
        # Every aisle entered and left at the FRONT: walk in as deep as the
        # deepest pick, pick on the way in, walk back out. The walk back out is
        # not a visit, so the order is simply front→back per aisle — the metric
        # charges the return leg as part of the hop to the next aisle.
        order: list[int] = []
        for ax in seq:
            order += front_first(ax)
        return order

    if policy == "s_shape":
        # 蛇行: aisle 1 front→back, aisle 2 back→front, ... Only aisles that hold
        # a pick are entered (an empty aisle is skipped, not walked).
        order = []
        for k, ax in enumerate(seq):
            side = front_first(ax)
            order += side if k % 2 == 0 else list(reversed(side))
        return order

    # largest_gap. The first and last pick aisles are traversed end to end (that
    # is how the picker gets to the far cross-aisle and back); every aisle in
    # between is served twice — its back-side picks on the way out along the back
    # cross-aisle, its front-side picks on the way home along the front one.
    order = []
    order += front_first(seq[0])                       # out: traverse front→back
    middle = seq[1:-1]
    homeward: list[list[int]] = []
    for ax in middle:
        fs, bs = _split_largest_gap(front_first(ax), depth, span)
        # entered from the BACK, so the deepest-from-the-front pick comes first
        order += list(reversed(bs))
        homeward.append(fs)
    if len(seq) > 1:
        order += list(reversed(front_first(seq[-1])))  # back: traverse back→front
    for ax_front in reversed(homeward):                # home along the front aisle
        order += ax_front
    return order
