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
CLOSED = 0
UNSTAFFED = None


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


def discharge_ends(spur_pts, belts, spur_ids) -> list[tuple[float, float]]:
    """A 引き込み's discharge extremities — the ends that are NOT its infeed.

    Drawn as two halves each ending at its own benches, that is just
    ``points[-1]`` and nothing changes. Drawn as ONE belt CROSSING the 本線 —
    which is what a 引き込み physically is, and what ``rmpm``'s 北半/南半 merge
    produces — the trunk meets it in the MIDDLE and BOTH extremities discharge, to
    the benches on either side. Reading only ``points[-1]`` there finds one row and
    leaves the other row of 梱包台 unstaffed; the belt then jams with half the
    floor idle.

    Every end sitting on a trunk ⇒ fall back to ``points[-1]``, the historical
    answer (never blocks).
    """
    ends = [tuple(spur_pts[0]), tuple(spur_pts[-1])]
    free = [e for e in ends if attach(e, belts, spur_ids) is None]
    return free or [tuple(spur_pts[-1])]


def bench_pools(spurs, belts, stations, reach: float = BENCH_REACH_M):
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

    Also returns which stations were claimed, because a stop-line's own workers
    are whoever is left over — see ``engine.build``.
    """
    spur_ids = {sid for sid, _ in spurs}
    ends = {sid: discharge_ends(pts, belts, spur_ids) for sid, pts in spurs}

    owner: dict[int, tuple[float, str]] = {}
    for sid, _pts in spurs:
        for i, st in enumerate(stations):
            p = (float(st[0]), float(st[1]))
            d = min(math.dist(p, e) for e in ends[sid])
            if d <= reach and (i not in owner or d < owner[i][0]):
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
        else:
            pools[sid] = UNSTAFFED       # nobody drawn: shared-pool fallback
    return pools, claimed
