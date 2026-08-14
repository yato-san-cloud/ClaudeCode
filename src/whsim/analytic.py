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
from whsim.rackgeom import aisle_block, aisle_detour, aisle_escape_m
from whsim.schema.model import WarehouseModel
from whsim.workmethod import orders_per_trip


# Units picked per order LINE when demand comes from the profile rather than
# from imported orders: ``engine.processes._sample_order`` draws
# ``rng.randint(1, 3)``, i.e. a mean of 2. The oracle used to assume 1, which
# halved the handling term of every profile-driven estimate.
_PROFILE_UNITS_PER_LINE = 2.0

# Stage label -> Japanese, for the stages this closed form actually prices. Keys
# are a SUBSET of ``kpis``' own bottleneck vocabulary on purpose: the two dicts
# share the ``bottleneck`` key, so they must not disagree about what a value
# means. (kpis additionally reports sort / sorter / replenish / conveyor, which
# only a run can measure.)
_BOTTLENECK_JP = {"picking": "ピッキング", "packing": "梱包", "agv": "AGV搬送"}

# How far a downstream stage must exceed picking before it is named the
# bottleneck (see ``estimate``).
_BOTTLENECK_MARGIN = 0.05


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


def _mean_abs_diff(xs, ys) -> float:
    """``E|X - Y|`` over two empirical samples, in O(n log n).

    Manhattan distance is separable, so the expected distance between a random
    boarding point and a random slot is this on x plus this on y. Doing it with a
    double loop would be O(n²) -- 360k distance calls on ``retail_dc`` -- which
    would cost this module the 爆速 budget it exists for.
    """
    if not xs or not ys:
        return 0.0
    ys = sorted(ys)
    m = len(ys)
    pref = [0.0] * (m + 1)
    for i, y in enumerate(ys):
        pref[i + 1] = pref[i] + y
    total = pref[m]
    acc = 0.0
    for x in xs:
        lo, hi = 0, m
        while lo < hi:                     # bisect: #{y <= x}
            mid = (lo + hi) // 2
            if ys[mid] <= x:
                lo = mid + 1
            else:
                hi = mid
        acc += x * lo - pref[lo] + (total - pref[lo]) - x * (m - lo)
    return acc / (len(xs) * m)


def _nearest_on_polyline(p, pts):
    """(nearest point, Manhattan distance) from ``p`` to a polyline.

    Mirrors ``engine.build.ConveyorLine.project`` + the Manhattan metric
    ``processes._board_conveyor`` compares lines by, without importing the engine
    (this module must stay sim-free and 爆速).
    """
    best = None
    for a, b in zip(pts, pts[1:]):
        vx, vy = b[0] - a[0], b[1] - a[1]
        span = vx * vx + vy * vy
        if span <= 1e-12:
            q = (a[0], a[1])
        else:
            t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / span
            t = min(1.0, max(0.0, t))
            q = (a[0] + vx * t, a[1] + vy * t)
        d = manhattan(p, q)
        if best is None or d < best[1]:
            best = (q, d)
    return best


def _belt_access(model: WarehouseModel):
    """``(back_leg, board_point, out_leg)`` for a model with a conveyor.

    With a conveyor the picker does NOT return to the packing station: it walks
    to the nearest point on a belt's path, hands the totes over and is free
    (``processes._board_conveyor``). Its NEXT trip then starts from there. So the
    two legs are different distances:

    * ``back_leg``  — mean slot→nearest-belt distance (a short sideways step).
    * ``out_leg``   — mean belt→slot distance, i.e. how far the picker walks from
      last trip's hand-off point to this trip's first pick.

    Charging the depot leg for both overstated ``pick_to_belt``'s walking by 16%;
    charging the short leg for both understated it by 32%.

    ``None`` when no usable conveyor is drawn, which keeps every conveyor-less
    model on exactly the historical depot-leg arithmetic.
    """
    lines = [cv.points for cv in model.resources.conveyors
             if cv.points and len(cv.points) >= 2]
    if not lines or not model.locations:
        return None
    # A belt often runs PAST the rack band as well as along its end, so the
    # Manhattan-nearest boarding point can sit beside the middle of a run. The
    # picker cannot cut across to it -- it must escape its aisle first, exactly
    # as it does reaching a depot. Pricing the belt leg as plain Manhattan read
    # pick_to_belt's carry 25% short (18.4 m against a measured 24.5 m).
    blk = aisle_block(model)
    total = 0.0
    boards = []
    for loc in model.locations:
        p = (loc.x, loc.y)
        near = min((_nearest_on_polyline(p, pts) for pts in lines), key=lambda r: r[1])
        total += near[1] + (aisle_escape_m(blk, near[0]) if blk else 0.0)
        boards.append(near[0])
    n = len(model.locations)
    board = (statistics.fmean(b[0] for b in boards),
             statistics.fmean(b[1] for b in boards))
    # E[dist(boarding point of a random slot, another random slot)] -- the mean
    # boarding point would NOT do here: E|mean(A) - B| < E|A - B| (Jensen), which
    # is exactly how the first cut of this came out 18% short.
    out_d = (_mean_abs_diff([b[0] for b in boards], [loc.x for loc in model.locations])
             + _mean_abs_diff([b[1] for b in boards], [loc.y for loc in model.locations]))
    if blk:                              # same escape on the way back out
        out_d += statistics.fmean(aisle_escape_m(blk, b) for b in boards)
    return total / n, board, out_d


def _trip_travel_m(
    depot_leg: float,
    hop: float,
    n_picks: float,
    det: dict | None,
    back_leg: float | None = None,
    aisle_extra: float | None = None,
) -> float:
    """Metres walked on ONE picking trip that visits ``n_picks`` slots.

    Out-and-back to the pick area plus one hop per extra pick, with the
    aisle-network detour charged only on the hops that actually change aisle
    (a nearest-neighbour tour sweeps one aisle before moving to the next, so a
    trip with many picks per aisle detours far less per pick than a short one).

    ``back_leg`` defaults to ``depot_leg`` (the symmetric round trip). A conveyor
    makes the two legs differ: the picker walks OUT from wherever it last dropped
    off, but only sideways to the nearest belt on the way BACK.

    ``aisle_extra`` overrides the per-aisle-change detour. It defaults to the
    nearest-neighbour figure (``hop_extra_m`` = l/3, entering and leaving an
    aisle at a random depth); a SERPENTINE sweep instead runs each aisle it
    enters end to end, which costs the full run length.
    """
    hops = max(n_picks - 1.0, 0.0)
    travel = depot_leg + (depot_leg if back_leg is None else back_leg) + hops * hop
    if det is not None:
        aisle_changes = min(hops, max(det["n_aisles"] - 1.0, 0.0))
        travel += aisle_changes * (det["hop_extra_m"] if aisle_extra is None
                                   else aisle_extra)
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
    are actually STANDING IN THE STORE the instant it pulls
    (``processes._pull_batch``). Two mechanisms put them there, and the trip
    takes whichever leaves more — they draw on the SAME store, so they are a
    max, never a sum.

    **Standing queue.** Not the time-average ``Lq``. A picker that had to wait
    for its first order found the store EMPTY — that is what waiting means — so
    it sweeps exactly one. Only a picker that found work already waiting gets a
    fuller trip, and even then only what is there::

        extra = C(c,a) · E[min(depth - 1, b_cap - 1)]
              = C(c,a) · rho·(1 - rho^(b_cap-1)) / (1 - rho)

    with ``C`` the Erlang-C probability of finding every picker busy and the
    store depth geometric in ``rho``. Charging ``Lq`` instead predicted trips of
    2.5–4.6 orders where the engine measures 1.3–1.9; since the headline metric
    is ``trip_metres / B``, that inflated batch is exactly why the oracle
    under-read walking by 10–25% on every batching template.

    **Release window** (wave / 種まき). Over one picker's window the store gains
    ``lam·W`` arrivals but LOSES the first order of every trip that starts in the
    meantime (rate ``lam/B``), because every other picker is sitting in an
    overlapping window competing for the same arrivals. The scoop is therefore
    self-limiting::

        B - 1 = lam·W·(B - 1)/B    =>    B = lam·W

    Charging the full ``lam·W`` to each picker independently read ``retail_dc``
    at 4.4 orders/trip against a measured 1.9.

    ``extra`` falls as B rises (a bigger sweep is cheaper per order, so the queue
    drains), which makes the queue branch strictly DECREASING in B — its fixed
    point is therefore unique and bisection finds it in a fixed number of cheap
    steps. (Plain iteration would oscillate between the extremes.)

    Degenerates cleanly: ``b_cap == 1`` or no demand ⇒ exactly 1, i.e. the
    single-order round trip this oracle has always priced.
    """
    if b_cap <= 1.0 or lam <= 0:
        return 1.0
    window = _release_window_s(model, b_cap)
    b_window = min(b_cap, lam * window) if window > 0.0 else 0.0

    def fill(b: float) -> float:
        a = lam * (trip_time_s(b) / b)               # offered load, orders
        rho = a / c
        if rho >= 1.0:
            queued = b_cap                           # saturated: sweep the cap
        else:
            k = b_cap - 1.0                          # room left after the first
            queued = (_erlang_c(c, a) * rho * (1.0 - rho ** k) / (1.0 - rho))
        return 1.0 + min(b_cap - 1.0, queued)

    if fill(1.0) <= 1.0:
        b_queue = 1.0
    elif fill(b_cap) >= b_cap:
        b_queue = b_cap
    else:
        lo, hi = 1.0, b_cap
        for _ in range(40):                          # ~1e-12 relative precision
            mid = (lo + hi) / 2.0
            if fill(mid) > mid:
                lo = mid
            else:
                hi = mid
        b_queue = (lo + hi) / 2.0
    return min(b_cap, max(1.0, b_queue, b_window))


def _sort_stops(model: WarehouseModel, b_cap: float):
    """種まき: how many DISTINCT SKUs one trip of ``b`` orders actually sweeps.

    ``processes._totals_points`` aggregates a 種まき batch's lines into SKU
    totals, so the picker walks to one stop PER DISTINCT SKU — not per line.
    How much that compresses is a property of **how the batch is formed**, which
    no closed form can recover from the schema alone: batching by destination
    saturates (every order wants the same fast movers), while batching by SKU
    block grows linearly in ``b``. Charging lines instead of stops read a real
    total-pick design at 100% picker utilisation against a measured 80%.

    So when the model carries explicit orders, measure it the way the engine
    batches them — over CONSECUTIVE FIFO windows (``processes._pull_batch`` pulls
    whatever is standing in the store, in arrival order). Two window sizes are
    enough: the value is interpolated between them, and both are sampled (≤32
    windows each) so this stays cheap enough for drag-time re-estimation.

    Returns ``None`` when there is nothing to measure (profile-driven demand),
    which keeps the historical "one stop per line" behaviour — never blocks.
    """
    orders = model.orders.outbound
    if not orders:
        return None
    n = len(orders)
    hi = max(1, min(int(math.ceil(b_cap)), n))

    def mean_distinct(k: int) -> float:
        step = max(1, (n - k + 1) // 32)
        total = count = 0
        for s in range(0, n - k + 1, step):
            skus = set()
            for o in orders[s:s + k]:
                skus.update(ln.sku for ln in o.lines)
            total += len(skus)
            count += 1
        return total / max(count, 1)

    d_lo = mean_distinct(1)
    d_hi = mean_distinct(hi) if hi > 1 else d_lo

    def stops(b: float) -> float:
        if hi <= 1:
            return d_lo
        t = (min(max(b, 1.0), float(hi)) - 1.0) / (hi - 1.0)
        return d_lo + t * (d_hi - d_lo)

    return stops


# ------------------------------------------------------------ コンベア詰まり
#
# The DES no longer runs each belt as a world of its own: ``engine.build``
# resolves the drawn belts into ONE chain (検品ライン → 本線 → 引き込み → 梱包台), a
# tote holds a slot on every belt it rides and releases the 引き込み's slot only
# when packing finishes. So a line offered more totes per second than it can pass
# fills up, the jam walks BACKWARDS along the chain, and the picker ends up
# holding totes it cannot hand over.
#
# That is a MECHANISM the engine has, so this oracle must have it too (invariant
# 5). Without it the instant estimate keeps promising a throughput the line
# physically cannot pass, and the run that is supposed to confirm it says the
# opposite — the exact failure this oracle exists to prevent. The closed form is
# the fluid one:
#
#     capacity_line = min( per-stage Σ(speed/pitch) , n梱包台 / pack_time )
#     time_to_jam   = slots up to the constraint / (λ − capacity_line)
#
# and BELOW capacity the line still blocks now and then, which is M/M/c/K's
# P(system full). No graph search, no simulation: a handful of arithmetic ops, so
# the estimate stays 爆速 for drag-time re-estimation.
#
# Which belts exist, which are boardable and which are 引き込み all come from the
# SAME source ``engine.build`` reads (``flowgraph``), so 解析 and DES can never be
# looking at different belts — the failure invariant 5 calls out by name.

# Mirrors of ``engine.build`` (kept local so this module stays sim-free and 爆速 —
# importing the builder would drag simpy/numpy onto the live path). Parity with
# the engine's own constants is pinned by tests/test_analytic_conveyor_jam.py.
_TOTE_PITCH_DEFAULT_M = 1.0     # unstated pitch ⇒ the historical 1 個/m
_BELT_SPEED_FALLBACK = 0.5      # build.DEFAULT_CONVEYOR_SPEED_MPS
_JOIN_TOL_M = 0.8               # build.JOIN_TOL_M — "this belt end is ON that path"
_BENCH_REACH_M = 3.0            # build.BENCH_REACH_M — 引き込み端に立つ梱包台


def belt_slots(cv) -> int:
    """How many totes fit on one belt — the engine's own slot rule.

    ``engine.build`` sizes each belt's slot pool as ``length / tote_pitch_m``
    (unstated or non-positive pitch ⇒ the historical 1 個/m), never below 1. The
    KPI layer reads this too, so "the belt is 80% full" means the same thing in
    the estimate, in the run and in the read-out (invariant 11: one source, not
    three copies of the arithmetic).
    """
    pts = [p for p in (getattr(cv, "points", None) or []) if len(p) >= 2]
    length = sum(math.dist((pts[i - 1][0], pts[i - 1][1]), (pts[i][0], pts[i][1]))
                 for i in range(1, len(pts)))
    pitch = getattr(cv, "tote_pitch_m", None)
    pitch = float(pitch) if pitch else 0.0
    return max(1, int(length / pitch)) if pitch > 0.0 else max(1, int(length))


def _belt_rate(cv) -> float:
    """Totes/second a belt can pass a fixed point: speed ÷ tote pitch.

    This is the belt's OWN capacity, independent of what feeds it — a 0.3 m/s
    引き込み carrying 0.45 m totes passes 0.67 totes/s however fast the 本線 runs.
    """
    speed = float(getattr(cv, "speed_mps", 0.0) or 0.0)
    if not (speed > 0.0):
        speed = _BELT_SPEED_FALLBACK
    pitch = getattr(cv, "tote_pitch_m", None)
    pitch = float(pitch) if pitch else 0.0
    return speed / (pitch if pitch > 0.0 else _TOTE_PITCH_DEFAULT_M)


def _dist_to_polyline(p, pts) -> float:
    """Euclidean distance from ``p`` to a polyline (``build._attach_to``'s test)."""
    best = float("inf")
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        vx, vy = b[0] - a[0], b[1] - a[1]
        span = vx * vx + vy * vy
        t = 0.0 if span <= 1e-12 else ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / span
        t = min(1.0, max(0.0, t))
        best = min(best, math.dist(p, (a[0] + vx * t, a[1] + vy * t)))
    return best


def _belt_stages(model: WarehouseModel):
    """The conveyor line the DESIGN commits to, as SERIAL stages.

    Mirrors ``engine.build._wire_conveyor_chain`` exactly, off the same three
    answers from ``flowgraph``:

    * ``conveyor_ids_in_use`` — which belts run at all (``None`` ⇒ no leg of the
      flow says 「コンベアで受け取る」 ⇒ no belt runs ⇒ this returns ``None``),
    * ``entry_conveyor_ids``  — which belts a PICKER may hand a tote to (empty ⇒
      every active belt is boardable, the behaviour from before belts chained),
    * ``pack_conveyor_ids``   — which belts are 引き込み(spurs) feeding 梱包台.

    A belt hands over to the belt its DISCHARGE end lands on (within
    :data:`_JOIN_TOL_M`), so the chain is read off the drawing, not authored. The
    result groups belts by their depth along that chain: belts at the same depth
    are PARALLEL (two 検品ライン feeding one 本線, ten 引き込み off it), so a stage
    passes the SUM of its belts' rates, while stages are in series so the line
    passes the MIN over stages. Reading ten 引き込み as if they were in series
    would price a 10-lane line as a 1-lane one and cry jam on a healthy design.

    Returns ``{"stages": [[cv…]…], "spurs": [cv…]}``, or ``None`` when no belt is
    in use — which is what keeps every conveyor-less model byte-identical.
    """
    # Degenerate entries (<2 points, or every point coincident) are not physical
    # transport — build() skips them, so this must too (never blocks).
    belts = []
    for cv in (model.resources.conveyors or []):
        pts = [(float(p[0]), float(p[1])) for p in (cv.points or []) if len(p) >= 2]
        if len(pts) >= 2 and sum(math.dist(pts[i - 1], pts[i])
                                 for i in range(1, len(pts))) > 1e-9:
            belts.append(cv)
    if not belts:
        return None

    from whsim import flowgraph

    def refs(fn) -> set[str]:
        try:
            return fn(model) or set()
        except Exception:      # noqa: BLE001 — a broken flow must not break the estimate
            return set()

    try:
        designed = flowgraph.conveyor_ids_in_use(model)
    except Exception:          # noqa: BLE001
        designed = set()
    if designed is None:
        return None            # drawing a belt is not designing one onto the flow
    if designed:
        belts = [cv for cv in belts if str(cv.id) in designed]
    if not belts:
        return None

    by_id = {str(cv.id): cv for cv in belts}
    spur_ids = {r for r in refs(flowgraph.pack_conveyor_ids) if r in by_id}
    entry_ids = [r for r in sorted(refs(flowgraph.entry_conveyor_ids)) if r in by_id]
    entries = [by_id[r] for r in entry_ids] or list(belts)
    spurs = [by_id[r] for r in sorted(spur_ids) if r not in {str(c.id) for c in entries}]
    spur_only = {str(c.id) for c in spurs}

    # 直列: a belt whose discharge end lands on another belt's path hands over to
    # it. A 引き込み is terminal on both sides (it ends at its benches), so it is
    # never a hand-over target — exactly build._attach_to's exclusion.
    succ: dict[str, str] = {}
    for a in belts:
        if str(a.id) in spur_only:
            continue
        end = (a.points[-1][0], a.points[-1][1])
        best = None
        for b in belts:
            if str(b.id) == str(a.id) or str(b.id) in spur_only:
                continue
            d = _dist_to_polyline(end, [(p[0], p[1]) for p in b.points])
            if d <= _JOIN_TOL_M and (best is None or (d, str(b.id)) < best[:2]):
                best = (d, str(b.id))
        if best is not None:
            succ[str(a.id)] = best[1]

    # Layer the chain from its HEADS (an entry that something else feeds is not a
    # head — it is one link further down, and calling it parallel to its own
    # feeder would double the line's capacity).
    fed = set(succ.values())
    heads = [cv for cv in entries if str(cv.id) not in fed] or list(entries)
    stages: list[list] = []
    seen = set(spur_only)
    layer = [cv for cv in heads if str(cv.id) not in seen]
    seen |= {str(cv.id) for cv in layer}
    while layer:
        stages.append(layer)
        nxt: dict[str, object] = {}
        for cv in layer:
            nid = succ.get(str(cv.id))
            if nid and nid not in seen and nid not in nxt:
                nxt[nid] = by_id[nid]
        seen |= set(nxt)
        layer = list(nxt.values())
    if spurs:
        stages.append(spurs)
    if not stages:
        return None
    return {"stages": stages, "spurs": spurs}


def _spur_benches(model: WarehouseModel, spur) -> int:
    """梱包台 standing at ONE 引き込み's discharge end — ``build``'s own rule.

    ``engine.build._wire_conveyor_chain`` gives each spur the stations within
    :data:`_BENCH_REACH_M` of where it discharges, and a tote holds that spur's
    slot until ITS bench is free. Pooling all 20 benches would make ten 2-bench
    引き込み look like one 20-server queue, which is exactly the mechanism the
    line was drawn to have.
    """
    end = (float(spur.points[-1][0]), float(spur.points[-1][1]))
    return sum(max(0, int(s.count)) for s in (model.resources.stations or [])
               if math.dist((float(s.x), float(s.y)), end) <= _BENCH_REACH_M)


def _mmck_full(c: int, a: float, k: int) -> float:
    """P(an arriving tote finds the line FULL) for M/M/c/(c+k).

    The steady-state companion to ``time_to_jam``: under the line's capacity the
    belt does not fill up for good, but it still blocks now and then — and "どれ
    くらい詰まりますか" is exactly what a proposal is asked. ``c`` is the 梱包台
    count (the servers) and ``k`` the belt slots in front of them (the waiting
    room).

    Built on the ratio recursion ``r_n = r_{n-1}·a/n`` (n ≤ c) / ``·a/c`` (n > c)
    rather than a literal ``a^n/n!``: a long line has hundreds of slots, and the
    naive form overflows on the way. O(c+k), allocation-free, no scipy.
    """
    if c <= 0 or a <= 0.0:
        return 0.0
    n_max = c + max(int(k), 0)
    r = total = 1.0
    for n in range(1, n_max + 1):
        r *= (a / n) if n <= c else (a / c)
        total += r
        if total > 1e290:                  # keep the recursion in range
            r /= 1e100
            total /= 1e100
    return r / total


def _steady_block(model: WarehouseModel, line: dict, lam: float,
                  n_packers: int, pack_time_s: float) -> float:
    """Share of hand-overs that WAIT while the line is under its capacity.

    Below ``capacity_line`` the belt does not fill up for good, but it still
    blocks now and then — and 「どれくらい詰まりますか」 is exactly what a proposal is
    asked. The waiting happens at the 引き込み, not on the line as a whole: a tote
    that cannot turn into a spur stands on the 本線, and standing on the 本線 IS the
    blocked state. So the loss system is ONE 引き込み — its own 梱包台 as servers
    (``_spur_benches``), its own slots as the waiting room — offered its share of
    the totes, averaged over the spurs. With no spur drawn (the legacy single-belt
    line) the belt itself is the waiting room in front of the pooled benches.

    This is an UPPER bound, deliberately: the engine passes a tote that finds its
    target spur full on to the NEXT junction, so the bank is partially pooled and
    really blocks somewhat less (measured ~3x less on the bundled line). An oracle
    may read a jam gloomier than the run; it must never read it rosier
    (invariant 5) — a proposal that promises a clear line and meets a jam on site
    is the failure this whole module exists to prevent.

    Returned per BOARDING, not per tote, so it is directly comparable with
    ``kpis``' ``conveyor_block_ratio``: a tote rides one belt per stage, and only
    the last of those legs can be turned away.
    """
    stages = line["stages"]
    spurs = line["spurs"]
    legs = max(len(stages), 1)
    if spurs:
        probs = []
        for cv in spurs:
            benches = _spur_benches(model, cv)
            if benches <= 0:                     # nobody stands there: pooled pack
                benches = max(1, int(n_packers / len(spurs)))
            slots = belt_slots(cv)
            probs.append(_mmck_full(benches, (lam / len(spurs)) * pack_time_s,
                                    max(0, slots - benches)))
        return statistics.fmean(probs) / legs
    total_slots = sum(belt_slots(cv) for st in stages for cv in st)
    return _mmck_full(int(n_packers), lam * pack_time_s,
                      max(0, total_slots - int(n_packers))) / legs


def _conveyor_estimate(model: WarehouseModel, lam: float, n_packers: int,
                       pack_time_s: float, horizon_s: float) -> dict | None:
    """Does this conveyor line jam, and if so when? ``None`` when there is no line.

    ``lam`` is the tote arrival rate (1 order = 1 tote, the engine's own rule:
    ``processes`` hands the belt one tote per order in the batch).
    """
    line = _belt_stages(model)
    if line is None:
        return None
    stages = line["stages"]
    rates = [sum(_belt_rate(cv) for cv in st) for st in stages]
    slots = [sum(belt_slots(cv) for cv in st) for st in stages]
    mu_pack = (n_packers / pack_time_s) if pack_time_s > 0 else float("inf")

    # The binding stage. Packing keeps the label on a tie: it is the stage the
    # rest of this oracle already models in detail, and naming a belt that merely
    # ties with it would send the proposal after the wrong fix.
    cap, binding, idx = mu_pack, "pack", len(stages)
    for i, r in enumerate(rates):
        if r < cap:
            cap = r
            idx = i
            binding = str(min(stages[i], key=lambda cv: (_belt_rate(cv), str(cv.id))).id)
    # Everything from the picker's hand-off up to and including the constraint is
    # buffer: it all starts empty and has to fill before the picker feels the jam.
    buffer_slots = sum(slots) if idx >= len(stages) else sum(slots[:idx + 1])

    jams = lam > cap and math.isfinite(cap)
    ttj = (buffer_slots / (lam - cap)) if jams and lam > cap else None
    if jams:
        # Over the horizon the line runs free until it fills, then passes only
        # ``cap`` and every hand-over waits: boardings = λ·t_jam + cap·(T − t_jam).
        span = max(float(horizon_s), 0.0) - (ttj or 0.0)
        blocked = cap * span if span > 0.0 else 0.0
        total = lam * (ttj or 0.0) + blocked
        ratio = (blocked / total) if total > 0.0 else 1.0
    else:
        ratio = _steady_block(model, line, lam, n_packers, pack_time_s)
    return {
        "jams": bool(jams),
        "time_to_jam_s": ttj,
        "capacity_per_hr": cap * 3600.0 if math.isfinite(cap) else None,
        "binding": binding,
        "block_ratio_est": min(max(ratio, 0.0), 1.0),
        # the two inputs a reader needs to re-do the arithmetic by hand
        "buffer_slots": buffer_slots,
        "offered_per_hr": lam * 3600.0,
    }


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

    # Handling seconds per LINE. With explicit orders, measure it directly as the
    # mean of ``qty × ts[sku]`` over the real lines. The product of the two means
    # (``ts_mean × units_per_line``) systematically OVER-charges whenever quantity
    # and per-unit time are negatively correlated — a broken-case line is many
    # units at a short unit time, a case line is one unit at a long one — which is
    # exactly the mix a convenience-store DC ships (+38% on the real order set
    # this was found on). Profile-driven demand (every bundled template) has no
    # lines to measure, so it keeps the product-of-means and nothing in the
    # catalogue moves.
    if model.orders.outbound:
        _ts_by_sku = {it.sku: it.ts_per_unit for it in model.items}
        handle_per_line = statistics.fmean(
            [ln.qty * _ts_by_sku.get(ln.sku, ts_mean)
             for o in model.orders.outbound for ln in o.lines] or [ts_mean])
    else:
        handle_per_line = ts_mean * units_per_line

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

    # A conveyor makes the trip's two legs ASYMMETRIC. The picker starts where it
    # last handed off (a point ON the belt) and walks out to the first pick, but
    # comes back only as far as the nearest belt beside its last pick.
    back_leg = None
    belt = _belt_access(model)
    if belt is not None:
        # Both legs already carry their own aisle-escape detour, priced at each
        # boarding point (see _belt_access) rather than at one depot.
        back_leg, _board, depot_leg = belt

    # GTP (AGV) mode: the AGV brings the totes to the picker, so the picker walks
    # NOTHING and is occupied only by handling + packing (engine.processes'
    # ``agv_mode`` branch). Charging it a picker's walk claimed 100% utilisation
    # where the engine measures 19%. The engine falls back to manual when no AGV
    # is actually placed (build.py), so mirror that condition exactly.
    n_agvs = sum(e.count for e in model.resources.equipment if e.type == "agv")
    gtp = model.process.pick_method() == "agv" and n_agvs > 0

    # When there is no conveyor, the picker DOUBLES AS THE PACKER and is occupied
    # through packing too (see engine.processes.picker_agent's busy definition).
    # The picker service time must include pack time, or this oracle understates
    # picker utilisation relative to the engine. A conveyor OR a 仮置き(staging)
    # buffer decouples pack onto its own downstream stage, so it is excluded.
    # In GTP mode neither decoupling applies -- both branches are guarded by
    # ``not agv_mode``, so a GTP picker always packs inline.
    has_conveyor = bool(model.resources.conveyors) and any(
        len(cv.points) >= 2 for cv in model.resources.conveyors)
    decoupled_pack = (not gtp) and (has_conveyor or model.process.staging_capacity > 0)
    pack_s = 0.0 if decoupled_pack else max(model.process.pack_time_s, 0.0)

    c = sum(w.count for w in model.resources.workers if w.role == "picker") or 1
    lam = rate_per_hr / 3600.0           # arrivals/s

    # GTP is a PIPELINE (AGV fetch -> ready queue -> picker handles), so the
    # picker cannot be offered work faster than the AGV fleet delivers it. When
    # the fleet saturates, the picker's arrival rate is the fleet's throughput,
    # not demand -- the engine's ready_store simply runs dry. Without this the
    # oracle read 0.311 against a measured 0.192.
    agv_util = agv_rate = None
    if gtp:
        agv_speed = ([e.speed_mps for e in model.resources.equipment
                      if e.type == "agv"] or [1.6])[0]
        # One AGV trip fetches ONE order's totes (the engine's agv_agent pulls a
        # single order per trip), out and back from its dock.
        agv_trip_s = _trip_travel_m(depot_leg, hop, max(lines_per, 1.0),
                                    det) / max(agv_speed, 0.1)
        agv_rate = n_agvs / agv_trip_s if agv_trip_s > 0 else float("inf")
        agv_util = min(lam / agv_rate, 1.0) if agv_rate > 0 else 1.0
        lam = min(lam, agv_rate)

    # コンベア詰まり: the belt chain is a capacitated stage DOWNSTREAM of the
    # picker, so — exactly like the AGV fleet above — it cannot be offered more
    # than it passes. Over capacity the 引き込み fill, the jam walks back up the
    # chain and the picker stands holding totes it cannot hand over, so demand
    # above ``capacity_line`` is simply not work the picker gets to do (the DES's
    # ``belt.request()`` blocking it, in closed form). ``None`` — no belt, or no
    # leg of the flow wired to one — leaves every other model untouched.
    # NOTE: ``n_stations``/``pack_time`` are resolved here because the line's
    # capacity needs them; the packing stage below reuses the same two values.
    n_stations = sum(max(0, s.count) for s in model.resources.stations) or 1
    pack_time = max(model.process.pack_time_s, 0.0)
    conveyor = _conveyor_estimate(model, lam, n_stations, pack_time,
                                  model.simulation.duration_s)
    if conveyor is not None and conveyor["jams"] and conveyor["capacity_per_hr"]:
        lam = min(lam, conveyor["capacity_per_hr"] / 3600.0)

    # ゾーン picking walks a strict SERPENTINE by aisle column, no backtracking
    # (the engine's ``_route_order``), so every aisle it enters is run end to end
    # instead of dipped into at l/3.
    serpentine = model.process.pick_strategy == "zone"
    aisle_extra = det["run_len_m"] if (serpentine and det) else None

    b_cap = float(max(1, orders_per_trip(model)))

    # --- 種まき(sort): the two mechanisms the engine has and this oracle needs --
    # 1. The sweep visits SKU TOTALS, not lines: ``processes._totals_points``
    #    collapses the batch's lines by SKU, so the picker STOPS once per
    #    distinct SKU. Handling is unchanged (the same units are moved).
    # 2. The picker then puts every line at the wall (``processes._sort_phase``),
    #    costing ``sort_time_s`` per line — pure occupancy this oracle otherwise
    #    charged nowhere.
    # Both are gated on consolidation == "sort", so every 摘み取り model — the
    # whole bundled catalogue — is byte-identical.
    sortation = model.process.effective_work().consolidation == "sort"
    sort_s = max(model.process.sort_time_s, 0.0) if sortation else 0.0
    stops_fn = _sort_stops(model, b_cap) if sortation else None

    def trip_stops(b: float) -> float:
        """棚前に立つ回数 (travel is charged per STOP, handling per LINE)."""
        if stops_fn is not None:
            return max(stops_fn(b), 1.0)
        return max(lines_per * b, 1.0)

    def trip_travel_m(b: float) -> float:
        """Metres a PICKER walks on one trip sweeping ``b`` orders. Zero in GTP."""
        if gtp:
            return 0.0
        return _trip_travel_m(depot_leg, hop, trip_stops(b), det,
                              back_leg, aisle_extra)

    # A wave/種まき release holds the picker at the gate while its bucket fills.
    # It has already claimed its first order, so that hold is trip time (the
    # engine counts it from the claim -- see processes.picker_agent).
    gate_s = 0.0 if gtp else _release_window_s(model, b_cap)

    def trip_time_s(b: float) -> float:
        """Seconds a picker is occupied by ONE trip that sweeps ``b`` orders."""
        n_lines = max(lines_per * b, 1.0)
        return (gate_s
                + trip_travel_m(b) / speed
                + n_lines * handle_per_line
                + n_lines * sort_s
                + b * pack_s)

    batch = _batch_per_trip(model, b_cap, c, lam, trip_time_s)

    service_s = trip_time_s(batch) / batch   # picker-seconds per ORDER
    travel = trip_travel_m(batch) / batch

    mu = 1.0 / max(service_s, 1e-6)      # service/s per picker
    a = lam / mu                         # offered load
    rho = a / c                          # utilization

    pw = _erlang_c(c, a)
    wq = pw / (c * mu - lam) if (c * mu - lam) > 0 else float("inf")

    # Pack stations are a capacitated stage of their own: the picker seizes one
    # even when it packs inline (``world.packers.request()``), and a decoupled
    # design hands the work to dedicated packers. Reporting only the picker would
    # call a design with too few benches 対応可能.
    # Packing sits DOWNSTREAM of picking, so like the GTP picker it cannot be
    # offered work faster than the stage ahead releases it. Charging it full
    # demand read a saturated thirdparty_3pl's benches at 100% against a measured
    # 68% -- the pickers simply never hand over that much.
    # Every bench on the line, not just the first entry — mirrors
    # ``engine.build``'s ``n_packers`` exactly (a packing line drawn bench by bench
    # arrives as one Station each). Identical for a single-group model. (Resolved
    # above, where the conveyor line's own capacity needed the same two values.)
    pack_lam = min(lam, c * mu)
    pack_util = min(pack_lam * pack_time / n_stations, 1.0) if pack_time > 0 else 0.0

    # The binding stage, in the SAME vocabulary ``kpis.compute`` uses -- the two
    # dicts share these key names, so a consumer must not have to know which one
    # it is holding.
    stages = {"picking": rho, "packing": pack_util}
    if agv_util is not None:
        stages["agv"] = agv_util
    bottleneck = max(stages, key=stages.get)
    # A downstream stage must CLEARLY beat picking to be named the constraint.
    # Picking is the stage this closed form models in detail, so a hair's-breadth
    # lead elsewhere is a co-bottleneck, not a finding -- and naming the wrong one
    # sends the proposal after the wrong fix.
    if bottleneck != "picking" and stages[bottleneck] - rho < _BOTTLENECK_MARGIN:
        bottleneck = "picking"
    binding = stages[bottleneck]

    return {
        "method": "analytic_mmc",
        "service_time_s": service_s,
        # Aisle-routed metres per order — directly comparable to the DES's
        # ``kpis.walk_per_order_m``, which is what makes 解析↔DES auditable.
        "walk_m_per_order": travel,
        "orders_per_trip": batch,
        "picker_utilization": min(rho, 1.0),
        # ADDITIVE: None outside GTP, so nothing downstream changes for a manual
        # model. In GTP these are what the proposal actually turns on.
        "agv_utilization": agv_util,
        # ADDITIVE: ``None`` unless the flow actually routes goods onto a belt, so
        # a conveyor-less model is untouched. When there IS a line this says
        # whether it jams, when, what binds it and how often a hand-over waits.
        "conveyor": conveyor,
        "packer_utilization": pack_util,
        "bottleneck_utilization": min(binding, 1.0),
        "bottleneck": bottleneck,
        "bottleneck_jp": _BOTTLENECK_JP[bottleneck],
        "capacity_orders_per_hr": c * mu * 3600.0,
        "offered_orders_per_hr": rate_per_hr,
        "pick_wait_mean_s": wq if math.isfinite(wq) else None,
        "overloaded": binding >= 1.0,
    }
