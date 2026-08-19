"""Where a belt discharges, and whose 梱包台 stands there — ONE rule, two readers.

``engine.build`` needs this to hand each 引き込み(spur) its own bench pool; the
closed-form oracle ``analytic`` needs the same answer to know how many servers
that pull-in has. They used to each carry their own copy of the arithmetic, and
the copies drifted the moment the rule got harder:

* a 引き込み drawn as ONE belt CROSSING the 本線 discharges at BOTH extremities
  (the trunk meets it in the middle). The engine learned that; the oracle kept
  reading ``points[-1]`` only and found half the benches — a real drawing came out
  4 benches in the run and 2 in the estimate.
* a bench within reach of two pull-ins belongs to the NEARER one, and to only
  one. The engine learned that; the oracle counted it for both — which reads the
  bank as having more servers than the floor has people, i.e. **rosier than the
  run**, the one direction invariant 5 forbids.

So the rule lives here once, as pure geometry: no simpy, no model classes, no
randomness, nothing but points and counts. Both readers import it, which is what
invariant 11 asks for — one source, not two copies and a parity test.
"""

from __future__ import annotations

import math

# A belt end / infeed this close to another belt's path is physically ON it. One
# drawn corner rounds to a few centimetres, so a metre-ish tolerance is what
# "they touch" means on a drawing; wider than that and two parallel lines running
# past each other would be spliced into one.
JOIN_TOL_M = 0.8
# Stations this close to a 引き込み(spur)'s discharge end are ITS 梱包台. A bench
# stands beside the belt end with room to work, so the reach is a couple of metres,
# not a couple of centimetres.
BENCH_REACH_M = 3.0

# ``bench_pools`` says one of three things about a 引き込み, and they are NOT the
# same thing (conflating the last two handed a spur the whole floor's capacity a
# second time — measured packer_utilization 1.28):
#
#   n > 0   — its own 梱包台 stand there: n servers, nobody else's.
#   CLOSED  — benches ARE drawn there but every count is 0. The pull-in is
#             deliberately unmanned, so it takes nothing at all.
#   UNSTAFFED — nobody is drawn there. A half-drawn line still runs: its loads
#             fall back to the shared pack pool.
#   LOST    — a bench IS within reach, but a NEARER pull-in owns it. Nobody is
#             left standing here, so this one takes nothing either. Falling back
#             to the shared floor instead made a bench-less 引き込み the most
#             attractive lane on the line (measured: 引き込み with 0 benches took
#             53 loads against a 1-bench neighbour's 20, and packer_utilization
#             1.675 — more servers than the drawing has people).
CLOSED = 0
LOST = -1
UNSTAFFED = None

#: The pull-in states that receive no load at all.
NO_HANDS = (CLOSED, LOST)


def project(p, pts, seglens=None) -> tuple[tuple[float, float], float]:
    """Nearest point ON the polyline ``pts`` to ``p``, plus its arc from the infeed.

    Projects onto every segment (clamped to its ends) rather than snapping to the
    nearest vertex — a picker standing beside the middle of a 30 m belt boards
    there, not at the far corner. First segment wins a tie, so the answer does not
    depend on iteration luck.

    ``seglens`` is the segment lengths when the caller already has them cached
    (the engine's ``ConveyorLine`` does); otherwise they are measured here.
    """
    px, py = float(p[0]), float(p[1])
    best_d2 = float("inf")
    best_xy = (float(pts[0][0]), float(pts[0][1]))
    best_arc = 0.0
    arc = 0.0
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        dx, dy = b[0] - a[0], b[1] - a[1]
        seg = seglens[i] if seglens is not None else math.hypot(dx, dy)
        if seg <= 1e-12:
            t = 0.0
        else:
            t = ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)
            t = 0.0 if t < 0.0 else min(t, 1.0)
        qx, qy = a[0] + dx * t, a[1] + dy * t
        d2 = (px - qx) ** 2 + (py - qy) ** 2
        if d2 < best_d2:
            best_d2, best_xy, best_arc = d2, (qx, qy), arc + seg * t
        arc += seg
    return best_xy, best_arc


def attach(p, belts, exclude=()) -> tuple[str, float] | None:
    """The belt whose PATH ``p`` sits on, as ``(belt id, arc)`` — or ``None``.

    ``belts`` is ``[(id, points), ...]``. The nearest path within
    :data:`JOIN_TOL_M`, ties broken by belt id so the resolved topology is
    identical on every run.
    """
    skip = set(exclude)
    best = None
    for bid, pts in belts:
        if bid in skip or len(pts) < 2:
            continue
        xy, arc = project(p, pts)
        d = math.dist((float(p[0]), float(p[1])), xy)
        if d <= JOIN_TOL_M and (best is None or (d, bid) < (best[0], best[1])):
            best = (d, bid, arc)
    return (best[1], best[2]) if best is not None else None


def _seg_nearest(a0, a1, b0, b1):
    """Closest approach between two segments as ``(distance, t_a, t_b)``.

    Sampled rather than solved: the exact two-segment minimum is a short case
    analysis (parallel, one-endpoint, interior-interior) that is easy to get
    subtly wrong, and this is called a handful of times per belt pair at build
    time — never on the live estimate path. Endpoint projections both ways cover
    every case where the minimum is attained at an endpoint, which for two
    straight segments is every case except a true crossing, and a crossing is
    picked up by the interior sample sweep below at distance ~0.
    """
    best = None
    for t in (0.0, 0.25, 0.5, 0.75, 1.0):
        p = (a0[0] + (a1[0] - a0[0]) * t, a0[1] + (a1[1] - a0[1]) * t)
        q, u = project(p, [b0, b1])
        d = math.dist(p, q)
        seg_b = math.dist(b0, b1)
        if best is None or d < best[0]:
            best = (d, t, (u / seg_b) if seg_b > 1e-12 else 0.0)
    for u in (0.0, 0.25, 0.5, 0.75, 1.0):
        q = (b0[0] + (b1[0] - b0[0]) * u, b0[1] + (b1[1] - b0[1]) * u)
        p, t = project(q, [a0, a1])
        d = math.dist(p, q)
        seg_a = math.dist(a0, a1)
        if d < best[0]:
            best = (d, (t / seg_a) if seg_a > 1e-12 else 0.0, u)
    return best


def path_nearest(pts_a, pts_b):
    """Closest approach between two polylines as ``(distance, arc_a, arc_b)``."""
    best = None
    arc_a = 0.0
    for i in range(len(pts_a) - 1):
        la = math.dist(pts_a[i], pts_a[i + 1])
        arc_b = 0.0
        for j in range(len(pts_b) - 1):
            lb = math.dist(pts_b[j], pts_b[j + 1])
            d, t, u = _seg_nearest(pts_a[i], pts_a[i + 1], pts_b[j], pts_b[j + 1])
            if best is None or d < best[0]:
                best = (d, arc_a + la * t, arc_b + lb * u)
            arc_b += lb
        arc_a += la
    return best


def feed_point(spur_pts, belts, exclude=()):
    """Where a 引き込み is fed from: ``(host belt id, host arc, spur arc)``.

    A 引き込み drawn as two halves has its INFEED at ``points[0]``, sitting on the
    trunk — that is the historical rule and it is tried first, unchanged, so every
    existing drawing resolves to exactly the junction it always did.

    A 引き込み drawn as ONE belt CROSSING the 本線 has no endpoint on the trunk at
    all: the trunk meets it in the MIDDLE. The endpoint test then finds nothing,
    no junction is wired, and the belt is DEAD — it keeps its 梱包台 and never
    receives a single load, while every tote rides past to the end of the trunk
    and is packed out of the shared pool. That reads as a working line (the orders
    do complete) with the pull-ins doing nothing, which is the most expensive kind
    of wrong: the drawing's whole mechanism is silently absent.

    So when no end touches, fall back to where the two PATHS come closest.
    ``None`` = this belt is fed by nothing.
    """
    hit = attach(spur_pts[0], belts, exclude)
    if hit is not None:
        return hit[0], hit[1], 0.0
    skip = set(exclude)
    best = None
    for bid, pts in belts:
        if bid in skip or len(pts) < 2:
            continue
        near = path_nearest(spur_pts, pts)
        if near is None:
            continue
        d, s_arc, h_arc = near
        if d <= JOIN_TOL_M and (best is None or (d, bid) < (best[0], best[1])):
            best = (d, bid, h_arc, s_arc)
    return None if best is None else (best[1], best[2], best[3])


def discharge_ends(spur_pts, belts, spur_ids, both: bool = False):
    """Where a 引き込み's loads LEAVE it — i.e. where its 梱包台 can stand.

    A belt runs one way, so a load fed anywhere along it rides forward and comes
    off at ``points[-1]``. That is the answer whether the spur is drawn as a half
    ending at its benches or as one belt crossing the 本線 — in the crossing case
    the far side is simply not reachable, and claiming its benches would sell
    packing capacity the line cannot deliver to.

    ``both`` is the drawing saying otherwise: an 無動力 (free-roller) pull-in is
    worked by hand from BOTH extremities, so the whole bench row either side is
    served. It is opt-in because a driven belt is the safe reading and the drawing
    usually does not say — see ``Conveyor.discharge_both``.
    """
    if not both:
        return [tuple(spur_pts[-1])]
    ends = [tuple(spur_pts[0]), tuple(spur_pts[-1])]
    free = [e for e in ends if attach(e, belts, spur_ids) is None]
    return free or [tuple(spur_pts[-1])]


def bench_pools(spurs, belts, stations, reach: float = BENCH_REACH_M, both=()):
    """How many 梱包台 each 引き込み owns: ``{spur id: n | CLOSED | UNSTAFFED}``.

    ``spurs`` is ``[(id, points), ...]`` in the order the caller resolved them,
    ``belts`` is every belt in play as ``[(id, points), ...]`` (spurs included —
    they are excluded from the attachment test by id), and ``stations`` is
    ``[(x, y, count), ...]``.

    Each bench belongs to the pull-in its worker actually reaches: the NEAREST
    one. Claiming first-come instead lets a wide reach steal a neighbour's bench
    (a real 4.5 m-pitch line with benches ±1.9 m came out 6/4/4/4/2 against the
    drawn 4/4/4/4/4). Ties go to the first spur in the caller's order, so the
    answer is deterministic.

    ``both`` is the set of spur ids worked from both extremities (see
    :func:`discharge_ends`).

    Also returns which stations were claimed, because a stop-line's own workers
    are whoever is left over — see ``engine.build``.
    """
    spur_ids = {sid for sid, _ in spurs}
    both = set(both)
    ends = {sid: discharge_ends(pts, belts, spur_ids, sid in both)
            for sid, pts in spurs}

    owner: dict[int, tuple[float, str]] = {}
    in_reach: dict[str, bool] = {sid: False for sid, _ in spurs}
    for sid, _pts in spurs:
        for i, st in enumerate(stations):
            p = (float(st[0]), float(st[1]))
            d = min(math.dist(p, e) for e in ends[sid])
            if d <= reach:
                in_reach[sid] = True
                if i not in owner or d < owner[i][0]:
                    owner[i] = (d, sid)

    pools: dict[str, int | None] = {}
    claimed: set[int] = set()
    for sid, _pts in spurs:
        mine = [i for i in range(len(stations)) if owner.get(i, (0.0, None))[1] == sid]
        n = sum(max(0, int(stations[i][2])) for i in mine)
        if n > 0:
            pools[sid] = n
            claimed.update(mine)
        elif mine:
            pools[sid] = CLOSED          # drawn but deliberately unmanned
        elif in_reach[sid]:
            pools[sid] = LOST            # in reach, but a nearer pull-in has it
        else:
            pools[sid] = UNSTAFFED       # nobody drawn: shared-pool fallback
    return pools, claimed
