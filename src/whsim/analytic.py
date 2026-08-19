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

from whsim import beltgeom
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
# These two are no longer copies: ``whsim.beltgeom`` owns them, and the engine
# re-exports the same objects. A shared definition beats a mirrored constant plus
# a parity test — which is what invariant 11 asks for, and what the drifted 梱包台
# rule (engine 4 benches, oracle 2) cost when only the constants were shared.
_JOIN_TOL_M = beltgeom.JOIN_TOL_M
_BENCH_REACH_M = beltgeom.BENCH_REACH_M


# The four scalars a belt has — drawn length, tote pitch, speed and slot count.
# They live HERE, once, because ``linemech``'s three mechanism mirrors need the
# same four and a private copy of an engine default is how the two readers drift
# (invariant 11). Nothing below re-reads ``speed_mps``/``tote_pitch_m`` directly.

def belt_length(cv) -> float:
    """Drawn length of a belt, in metres (degenerate points ignored)."""
    pts = [p for p in (getattr(cv, "points", None) or []) if len(p) >= 2]
    return sum(math.dist((pts[i - 1][0], pts[i - 1][1]), (pts[i][0], pts[i][1]))
               for i in range(1, len(pts)))


def belt_pitch(cv) -> float:
    """Metres of belt one tote occupies (unstated/non-positive ⇒ 1 個/m)."""
    pitch = getattr(cv, "tote_pitch_m", None)
    pitch = float(pitch) if pitch else 0.0
    return pitch if pitch > 0.0 else _TOTE_PITCH_DEFAULT_M


def belt_speed(cv) -> float:
    """Belt speed in m/s (unstated/non-positive ⇒ ``build``'s own default)."""
    speed = float(getattr(cv, "speed_mps", 0.0) or 0.0)
    return speed if speed > 0.0 else _BELT_SPEED_FALLBACK


def belt_slots(cv) -> int:
    """How many totes fit on one belt — the engine's own slot rule.

    ``engine.build`` sizes each belt's slot pool as ``length / tote_pitch_m``
    (unstated or non-positive pitch ⇒ the historical 1 個/m), never below 1. The
    KPI layer reads this too, so "the belt is 80% full" means the same thing in
    the estimate, in the run and in the read-out (invariant 11: one source, not
    three copies of the arithmetic).
    """
    return max(1, int(belt_length(cv) / belt_pitch(cv)))


def _belt_rate(cv) -> float:
    """Totes/second a belt can pass a fixed point: speed ÷ tote pitch.

    This is the belt's OWN capacity, independent of what feeds it — a 0.3 m/s
    引き込み carrying 0.45 m totes passes 0.67 totes/s however fast the 本線 runs.
    """
    return belt_speed(cv) / belt_pitch(cv)


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

    Returns ``{"stages": [[cv…]…], "spurs": [cv…], "benches": {…}}``, or ``None``
    when no belt is in use — which is what keeps every conveyor-less model
    byte-identical. The intermediate facts it had to resolve on the way (``belts``
    / ``by_id`` / ``entries`` / ``spur_ids`` / ``succ``) come back with it: they
    are what ``linemech``'s three mechanism mirrors need, and re-deriving the
    chain a second time beside this one is exactly the drift invariant 11 forbids.
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
    # never a hand-over target — exactly build._attach_to's exclusion. The arc it
    # lands AT comes back too: a hand-over half way along the next belt only rides
    # the rest of it, which is what the mechanism mirrors charge for.
    geom = [(str(cv.id), [(p[0], p[1]) for p in cv.points]) for cv in belts]
    succ: dict[str, tuple[str, float]] = {}
    for a in belts:
        if str(a.id) in spur_only:
            continue
        hit = beltgeom.attach((a.points[-1][0], a.points[-1][1]), geom,
                              exclude=spur_only | {str(a.id)})
        if hit is not None:
            succ[str(a.id)] = hit

    # Layer the chain from its HEADS (an entry that something else feeds is not a
    # head — it is one link further down, and calling it parallel to its own
    # feeder would double the line's capacity).
    fed = {nid for nid, _arc in succ.values()}
    heads = [cv for cv in entries if str(cv.id) not in fed] or list(entries)
    stages: list[list] = []
    seen = set(spur_only)
    layer = [cv for cv in heads if str(cv.id) not in seen]
    seen |= {str(cv.id) for cv in layer}
    while layer:
        stages.append(layer)
        nxt: dict[str, object] = {}
        for cv in layer:
            nid = (succ.get(str(cv.id)) or (None, 0.0))[0]
            if nid and nid not in seen and nid not in nxt:
                nxt[nid] = by_id[nid]
        seen |= set(nxt)
        layer = list(nxt.values())
    if spurs:
        stages.append(spurs)
    if not stages:
        return None
    # 梱包台 per 引き込み, resolved by the SAME function ``engine.build`` calls.
    # Keeping a second copy here is what let the two drift: the engine learned
    # that a spur crossing the 本線 discharges at both extremities and that a
    # shared bench belongs to the nearer pull-in, and this module did not — so a
    # real drawing came out 4 benches in the run and 2 in the estimate, and a
    # bench between two spurs was counted twice (rosier than the run).
    stations = list(model.resources.stations or [])
    benches, claimed = beltgeom.bench_pools(
        [(str(cv.id), [(float(p[0]), float(p[1])) for p in cv.points]) for cv in spurs],
        [(str(cv.id), [(float(p[0]), float(p[1])) for p in cv.points]) for cv in belts],
        [(s.x, s.y, s.count) for s in stations],
        both={str(cv.id) for cv in spurs if getattr(cv, "discharge_both", False)})
    # 余り台 — 誰の持ち物でもない梱包台, i.e. ``World.spare_bench``. It is what a
    # pull-in nobody stands at may borrow, and when it is ZERO such a pull-in has
    # nobody at all: ``build`` then marks it ``closed``. Resolved HERE, beside the
    # ``claimed`` it is the complement of, so no reader has to pair this answer
    # with a second bench_pools call of its own (invariant 11).
    spare = sum(max(0, int(s.count)) for i, s in enumerate(stations)
                if i not in claimed)
    return {"stages": stages, "spurs": spurs, "benches": benches,
            # additive: the chain as it was resolved, for the mechanism mirrors
            "belts": belts, "by_id": by_id, "entries": entries,
            "spur_ids": spur_only, "succ": succ, "claimed": claimed,
            "spare": spare}


def _spur_benches(model: WarehouseModel, spur) -> int | None:
    """梱包台 standing at ONE 引き込み's discharge ends — ``build``'s own rule.

    ``engine.build._wire_conveyor_chain`` gives each spur the stations within
    :data:`_BENCH_REACH_M` of where it discharges, and a tote holds that spur's
    slot until ITS bench is free. Pooling all 20 benches would make ten 2-bench
    引き込み look like one 20-server queue, which is exactly the mechanism the
    line was drawn to have.

    Three-valued like the engine's own answer: ``n`` benches, ``0`` = drawn but
    unmanned (the pull-in takes nothing at all), ``None`` = nobody drawn there
    (a half-drawn line falls back to the shared pack pool).
    """
    line = _belt_stages(model)
    if line is None:
        return beltgeom.UNSTAFFED
    return line["benches"].get(str(spur.id), beltgeom.UNSTAFFED)


# 通路干渉: ρ → 1 would price a crowded aisle as infinite service. The cap keeps
# the bound finite on a floor the geometry reads as tiny (it is a bound, not a
# prediction — see ``_aisle_congestion``).
_AISLE_RHO_CAP = 0.5


def _aisle_congestion(model: WarehouseModel, det: dict | None,
                      travel_m_per_order: float, lam: float, speed: float):
    """通路干渉が picker の歩行時間に足す待ち — an explicit UPPER bound.

    ``simulation.aisle_interference`` makes every walk leg contend for its
    ``(cell, direction)``: capacity 1, held ``g/v`` seconds per traversal. One cell
    is therefore M/M/1, a trip crosses ``travel/g`` of them, and **the cell pitch
    cancels**::

        wait/trip = (travel/g)·(g/v)·ρ/(1−ρ) = (travel/v)·ρ/(1−ρ)

    so interference is a pure multiplier on walk TIME, never on distance — which is
    what the engine pins too (``walk_total_m`` is byte-identical with the flag on).
    Little's law supplies ρ without a graph search: ``A = λ·travel/v`` agents are in
    motion over ``N = 2·aisles·ℓ/g`` directed cells (floored at a lap of the
    envelope, which is what keeps a one-aisle floor off the cap).

    **A bound, deliberately, and a loose one.** Same-direction contention between
    equal-speed agents is self-annihilating: the follower waits once and then trails
    by one cell for the rest of the run, so the engine pays ONE residual per
    encounter where M/M/1 charges one per cell. Measured over 21 configurations the
    bound sits 9.1x–23.0x above the run's picker wait and never below it. Loose in
    seconds, right-sized in utilisation — the true effect is 0.03–0.17% of walking
    time on the bundled catalogue, so the utilisation it moves (+0.000…+0.008) is
    the same order as the DES's own. An oracle may read congestion gloomier than the
    run; it must never read it rosier (invariant 5).

    ``None`` when the flag is off — which is every shipped template, so the
    catalogue is untouched.
    """
    if not model.simulation.aisle_interference:
        return None
    if travel_m_per_order <= 0.0 or lam <= 0.0 or speed <= 0.0:
        return None                      # GTP walks nowhere; never blocks
    g = float(model.simulation.heatmap_grid_m or 1.0) or 1.0
    cells = (2.0 * max(det["n_aisles"], 1) * max(det["run_len_m"], g) / g
             if det else 0.0)
    b = model.layout.bounds
    cells = max(cells, 2.0 * (b.width + b.depth) / g, 1.0)
    rho = min((lam * travel_m_per_order / speed) / cells, _AISLE_RHO_CAP)
    factor = rho / (1.0 - rho)
    return {"cell_utilization": rho,
            "wait_s_per_order_bound": (travel_m_per_order / speed) * factor,
            "wait_share_bound": factor / (1.0 + factor),
            "bound": "upper"}


def _open_spurs(line: dict) -> list:
    """The 引き込み that actually TAKE a tote — i.e. not the deliberately unmanned.

    ``engine.build`` does not wire a junction for a spur that has no hands, and it
    reaches that verdict TWICE:

    * its benches are all ``count: 0`` (deliberately unmanned) or the bench within
      its reach belongs to a NEARER pull-in — ``beltgeom.NO_HANDS``;
    * **or** nobody is drawn at it AND there is no 余り台 left to borrow. A spur
      with nobody drawn falls back to the shared pool, but that pool is the
      UNCLAIMED benches only (``World.spare_bench``) — every other bench is already
      being worked by the pull-in that owns it, so lending it books the same person
      twice. With ``spare == 0`` and something claimed, ``build``'s second pass
      (``if claimed and spare == 0``) closes every un-benched pull-in.

    Either way the pull-in receives nothing at all. Pricing it as an open lane
    would hand the bank capacity the floor has no people for — rosier than the run,
    which is the one direction invariant 5 forbids. Only the second case was
    missing here, and it is not academic: ``_conveyor_estimate`` summed such a
    belt's rate and slots into its stage, so the line's ceiling and its buffer both
    counted a lane nobody can unload.

    With NOTHING claimed the line is simply drawn without benches: everybody shares
    the pack pool, which is the historical never-blocks fallback and stays open.

    ⚠️ 停止線 also claim benches in ``build`` (the workers standing at the gate),
    which shrinks ``spare`` further and can close a pull-in this still calls open.
    A drawing with a gate is priced by ``linemech.gate``, not by the branch this
    feeds, so the gap is unreachable from ``_conveyor_estimate``'s own answer — but
    it is a gap, and it is the rosy side, so it belongs in the daylight.
    """
    benches = line.get("benches") or {}
    # ``build``'s ``s.bench is None`` — a pull-in with no private bench of its own.
    # A ``line`` without the key (a hand-built dict) reads as no 余り台, i.e. the
    # gloomy side: an oracle may be gloomier than the run, never rosier.
    unbenched = bool(line.get("claimed")) and not int(line.get("spare") or 0)
    out = []
    for cv in line["spurs"]:
        n = benches.get(str(cv.id), beltgeom.UNSTAFFED)
        if n in beltgeom.NO_HANDS:
            continue
        if unbenched and not (isinstance(n, int) and n > 0):
            continue
        out.append(cv)
    return out


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


# 引き込み(spur) bank: a chain over the TOTAL loads standing on the line. A 100 m
# belt drawn at a 2 cm pitch is 5000 slots and the walk is O(slots), so cap the
# state space — past this the line is saturated either way (a buffer that deep
# never drains inside one shift) and the estimate has to stay 爆速.
_BANK_MAX_STATES = 20000
# Nodes for the finite-horizon integral below. 40 is ~0.05 ms and the answer is
# stable to 1e-3 against 400.
_FILL_NODES = 40
_SQRT2 = math.sqrt(2.0)
# The queue's variance rate, in units of the M/M/1 value ``λ + capacity``. Twice,
# because the bank is NOT a fixed-rate server: below ``ΣK`` its rate ramps with
# occupancy (fewer 引き込み in play ⇒ fewer 梱包台 working), so the walk gets a push
# towards the top that a constant-rate diffusion has no term for. CALIBRATED, not
# derived: at the M/M/1 value the near-critical margin all but vanishes — measured
# over 18 h at 8 reps, a 5-spur bank at ρ_bank = 0.95 reads 0.5833 against a run's
# 0.5828, which is inside the run's own rep-to-rep spread and therefore a coin toss
# on the side invariant 5 forbids. Doubling it reads 0.6016. The cost is carried by
# lines at and over capacity, which are already being told they jam.
_FILL_VAR = 2.0


def _spur_serve_s(pack_time_s: float, benches: int, slots: int,
                  ride_s: float) -> float:
    """梱包台-seconds ONE load costs a 引き込み, ride-in dead time included.

    A 梱包台 that has just gone free cannot start again until a load is standing at
    it, and a load that turns in at the junction has to RIDE the 引き込み first. That
    ride is dead time on the bench — unless a load that has ALREADY ridden is
    waiting behind it, which is what the pull-in's spare slots are for: ``K − c``
    waiting positions drain at ``c/τ`` and so cover ``(K−c)·τ/c`` seconds of it.

    ``K ≤ c`` (slots at most benches — the short free-roller pull-in with no
    accumulation) covers nothing and pays the ride every cycle. That is a real
    capacity loss the bench count alone cannot show. Measured on a saturated
    5-spur bank of 2 slots / 2 benches (τ = 60 s), the real cycle is 61.5 s and the
    line passes 585/hr where the benches say 600 — so offering it its NOMINAL
    capacity already over-feeds it, and the whole line then saturates over a shift
    (DES ``conveyor_block_ratio`` 0.816 against a nominal-capacity reading of 0).
    With ``K ≥ c + 1`` the term vanishes on every realistic geometry — the measured
    cycle is τ to within 0.06% — which is why the bundled 出荷ライン (5 slots,
    2 benches, τ = 78 s) is untouched by it.
    """
    tau = max(pack_time_s, 1e-9)
    c = max(int(benches), 1)
    cover = max(int(slots) - c, 0) * tau / c
    return tau + max(0.0, float(ride_s) - cover)


def _bank_rate_profile(bank) -> list[float]:
    """梱包 completions/s available when ``N`` loads stand in the bank (N = 0…ΣK).

    貪欲ディバート takes the FIRST 引き込み with room, so loads pile into spur 1 until
    its slots are gone, then spur 2, and so on. That is measured, not assumed: a
    3-spur bank at ρ_bank = 0.7 takes 241/208/76 in junction order, and the 前詰め
    disappears exactly where the mechanism says it should — at ρ_bank = 1.0 every
    pull-in is saturated (243/243/239), and with a single slot each every load
    spills at once (117/117/116).

    Filling in JUNCTION order is therefore the engine's own order, and it is also
    the pessimistic one against the split this replaces: a spur holding ``n`` works
    ``min(n, c)`` benches, so concentrating ``N`` loads leaves more benches idle
    than spreading them. For a bank of identical pull-ins it is the fewest benches
    any arrangement of ``N`` could work; for a mixed bank the true minimum would
    concentrate into the pull-in with the fewest benches per slot instead, which
    the engine does not do — so what is modelled here is the run's ORDER, not a
    bound.
    """
    prof = [0.0]
    for c, k, serve in bank:
        for i in range(1, k + 1):
            prof.append(prof[-1] + (1.0 / serve if i <= c else 0.0))
    return prof


def _queue_prefactor(prof: list[float], servers: int, lam: float) -> float:
    """P(a queue has formed behind the 梱包台 at all) — the bank's Erlang-C term.

    The horizon walk below prices the queue as if one always existed: its
    steady-state weight is the geometric tail ``(λ/capacity)^depth``, which is the
    tail of an M/M/**1** queue. A bank of ``c`` benches offered a third of its
    capacity almost never has a queue at all, and pricing the tail without the
    probability that it exists read a 6-bench pull-in at ρ_bank = 0.33 as blocking
    0.111 where the chain (and the run) say 0.002.

    So this is that probability, taken from the chain itself with an INFINITE tail
    (the belt is finite, but the picker behind it is not), and it is the same
    number for every stage: ``P(N ≥ L) = A·r^(L−servers)`` for every level ``L``
    above the benches, so ``A`` factors straight out.

    ``1.0`` at or over capacity — there is no stationary law to take it from, and
    a queue is certainly there.
    """
    m_bank = len(prof) - 1
    full = prof[m_bank]
    if full <= 0.0 or lam <= 0.0:
        return 1.0
    r = lam / full
    if r >= 1.0:
        return 1.0
    log_w = [0.0] * (m_bank + 1)
    acc = 0.0
    for n in range(1, m_bank + 1):
        acc += math.log(lam / prof[n])
        log_w[n] = acc
    top = max(log_w)
    w = [math.exp(v - top) for v in log_w]
    z = sum(w) + w[m_bank] * r / (1.0 - r)
    if w[m_bank] <= 0.0 or z <= 0.0:
        return 0.0
    log_a = (math.log(w[m_bank]) + (servers - m_bank) * math.log(r)
             - math.log(1.0 - r) - math.log(z))
    return 1.0 if log_a >= 0.0 else math.exp(log_a)


def _bank_chain(prof: list[float], extra: int, lam: float) -> list[float]:
    """Stationary law of that chain, with the upstream belts as its waiting room.

    Below ``ΣK`` the death rate RISES with occupancy (each further load puts one
    more 引き込み in play); above it the bank is full and the rate is flat, so the
    本線 and 検品ライン behind it are a plain queue in front of a fixed-rate server.
    That is the whole coupling in one birth-death chain: 引き込みが満杯 ⇒ 本線に滞留
    ⇒ 検品ラインが止まる ⇒ ピッカーが手放せない.

    Carried in logs: λ/rate can be tens and the chain hundreds of states long, so
    the raw product overflows long before the tail is reached.
    """
    m_bank = len(prof) - 1
    full = prof[m_bank]
    n_max = min(m_bank + max(extra, 0), _BANK_MAX_STATES)
    if lam <= 0.0:
        return [1.0] + [0.0] * n_max          # no arrivals ⇒ an empty line
    if full <= 0.0:
        # Nobody can pack at all: the bank fills once and never drains. This is the
        # closed form of ``pack_unmanned`` — every bench claimed and no 余り台 left,
        # so ``World.spare_bench`` has nothing to lend and the load stays put.
        return [0.0] * n_max + [1.0]
    log_pi = [0.0] * (n_max + 1)
    acc = 0.0
    for n in range(1, n_max + 1):
        acc += math.log(lam / (prof[n] if n <= m_bank else full))
        log_pi[n] = acc
    top = max(log_pi)
    pi = [math.exp(v - top) for v in log_pi]
    tot = sum(pi)
    return [p / tot for p in pi]


def _fill_share(depth: float, delta: float, var: float, horizon_s: float,
                tail: float | None = None) -> float:
    """Share of a run of length ``horizon_s`` that a queue ``depth`` deep is FULL.

    The loads standing behind the 梱包台 are a random walk started EMPTY and
    reflected at 0: drift ``delta = λ − capacity`` per second, variance rate
    ``var = λ + capacity``. By the reflection principle
    ``P(Q(t) ≥ depth) = Φ̄((d−δt)/σ√t) + e^{2δd/σ²}·Φ̄((d+δt)/σ√t)``, and what a run
    reports is that averaged over the run.

    This is the piece a stationary chain cannot supply, and it is not a refinement:
    the belt is a FINITE buffer but the picker behind it is not — a load that
    cannot be handed over waits in the picker's hands, so the queue is unbounded
    and at ρ = 1 it is null recurrent. It has no steady state at all; it grows like
    ``σ√t`` for ever, and how much of a shift a stage spends blocked is therefore a
    property of the SHIFT. Measured on a 6-spur bank at ρ_bank = 1.00, the 検品ライン
    is blocked 0.25 of an 8-hour run and 0.47 of an 18-hour one, where the
    finite-buffer stationary reading says 0.01 for both. This is a diffusion
    APPROXIMATION, not a bound: it is the heavy-traffic limit, so it is trustworthy
    near ρ = 1 (which is where it is asked) and merely indicative far from it — the
    other two readings in :func:`_overflow_cascade` cover those ends.

    ``depth`` is counted from the servers, not from the belt: the loads AT the
    梱包台 are in service, everything behind them is the queue. A 引き込み bank with
    no waiting room at all (slots = benches) therefore has depth 0 at its own level
    and this says nothing about it — the chain does, and it is an Erlang-B-shaped
    answer, not "always full".
    """
    if depth <= 0.0:
        return 0.0
    if horizon_s <= 0.0 or var <= 0.0:
        return 0.0
    sig = math.sqrt(var)
    # Steady-state weight of the "already been there" term. The reflection formula
    # carries ``2δd/σ²``, which is the HEAVY-TRAFFIC form of the queue's geometric
    # tail ``(λ/capacity)^d`` — the two agree to 1e-4 at ρ = 0.9 but the diffusion
    # decays too slowly further down (it reads 0.0025 where an idle line has 0). The
    # exact exponent costs nothing and is what makes an empty line read empty.
    boost = (depth * math.log(tail) if (tail is not None and 0.0 < tail < 1.0)
             else 2.0 * delta * depth / var)
    ex = math.exp(boost) if boost < 700.0 else None      # None ⇒ saturated
    acc = 0.0
    for i in range(1, _FILL_NODES + 1):
        # t = horizon·s²: the integrand moves fastest just after the run starts,
        # and this spaces the nodes there without a special case.
        s = (i - 0.5) / _FILL_NODES
        t = horizon_s * s * s
        sd = sig * math.sqrt(t)
        if ex is None:
            p = 1.0
        else:
            p = (0.5 * math.erfc((depth - delta * t) / sd / _SQRT2)
                 + ex * 0.5 * math.erfc((depth + delta * t) / sd / _SQRT2))
        acc += min(p, 1.0) * 2.0 * s / _FILL_NODES
    return min(max(acc, 0.0), 1.0)


def _overflow_cascade(bank, upstream, lam: float, capacity: float,
                      horizon_s: float) -> list[float]:
    """P(a boarding onto each stage has to WAIT) — 引き込み stage first.

    The 逐次オーバーフロー縦続 the ``auto`` bank really is. ``_convey_chain`` turns into
    the FIRST junction with room, so the bank is an ORDERED hunt group, not the
    random split ``lam/len(spurs)`` prices: spur 1 is offered everything until its
    slots are gone, spur 2 takes what spills, and so on. And the overflow is not a
    LOSS — a load that finds every pull-in full stalls on the 本線 holding its slot,
    which is the back-pressure this whole model exists to show. So it is a QUEUE
    cascade: the bank is the (state-dependent) server, the belts behind it are its
    waiting room, and a stage blocks when everything DOWNSTREAM of it is full. The
    levels are therefore cumulative — 引き込み at ``ΣK``, 本線 at ``ΣK + K_trunk``,
    検品ライン at ``ΣK + K_trunk + K_entry`` — and they fill IN THAT ORDER.

    ``bank``     — the OPEN 引き込み in junction (arc) order as
                   ``(梱包台, slots, seconds of bench time per load)``; the third
                   entry is :func:`_spur_serve_s`.
    ``upstream`` — accumulating slots of each stage BEHIND the bank, nearest first.
    ``capacity`` — the line's ceiling in loads/s (``_conveyor_estimate``'s ``cap``).
    ``horizon_s``— the run this is compared against (``simulation.duration_s``).

    Per stage the answer is the WORST of three readings, because no one of them is
    honest across the whole range — and none of the three is a proven upper bound,
    so the ``max`` is the honesty, not any single term:

    * the **stationary chain**, right below capacity where the line settles long
      before the shift ends;
    * the **fluid fill** ``1 − C_i/((λ−capacity)·T)``, right above it. Charging ONE
      fill time for the whole buffer is what read the bundled 出荷ライン at 2× demand
      as blocking 0.00 where the run blocks 0.52: the 引き込み bank is full after
      1.9 h of the shift, the 本線 after 3.5 h and the 検品ライン after 6.2 h, so the
      three stages are blocked 0.99 / 0.90 / 0.46 of it and not one of them 0;
    * the **finite-horizon walk** :func:`_fill_share`, which is the only one of the
      three that says anything at all at ρ = 1, where there IS no steady state.

    Validated, not proved: over 270 synthetic bank configurations at 8 h the split
    it replaces reads rosier than the DES in 202 of them (worst −0.815) and this
    reads rosier in 2 (worst −0.001, ~1 blocked boarding in 850 = run noise).

    This prices 貪欲ディバート — ``Process.divert_policy == "auto"``, the default.
    Under "pull" nothing piles into the first pull-in (a load rides past a bench
    that is not free instead of waiting), so the water-filling profile above is the
    wrong shape; ``_line_estimate`` routes that case to ``linemech.pull`` before
    ``_conveyor_estimate`` is reached, and 停止線 likewise to ``linemech.gate``.
    """
    # A 引き込み with NO hands takes one load per slot and never gives it back, so
    # after the first minutes it is simply not part of the bank any more — which is
    # also what ``engine.build`` does with it (``closed`` ⇒ no junction is wired).
    levels_n = 1 + len(upstream)
    alive = [(int(c), int(k), float(s)) for c, k, s in bank
             if int(k) > 0 and int(c) > 0]
    if not alive:
        # Every pull-in is a dead end: nothing on this line is ever packed.
        return [1.0] * levels_n if bank else []
    if lam <= 0.0:
        # No arrivals ⇒ an empty line, which is what ``_bank_chain`` says too. The
        # diffusion below cannot say it: its geometric tail is ``(λ/capacity)^d``
        # and ``log(0)`` is not a number, so it falls back to the heavy-traffic
        # exponent and reads a warehouse with no orders as 5% blocked.
        return [0.0] * levels_n
    bank = alive
    prof = _bank_rate_profile(bank)
    m_bank = len(prof) - 1
    ups = [max(int(u), 0) for u in upstream]
    pi = _bank_chain(prof, sum(ups), max(lam, 0.0))

    lvl = m_bank
    levels = [lvl]
    for u in ups:
        lvl += u
        levels.append(lvl)

    # The line's REAL ceiling: the benches' nominal rate is not reachable when the
    # pull-ins are too short to keep them fed (``_spur_serve_s``), and the fill has
    # to be measured against what the line actually passes — otherwise an over-fed
    # line reads as merely critical (measured: 572/hr passed where the benches
    # say 600).
    cap_real = min(capacity, prof[m_bank])
    delta = lam - cap_real
    var = _FILL_VAR * (lam + cap_real)
    servers = sum(min(c, k) for c, k, _s in bank)
    prefactor = _queue_prefactor(prof, servers, lam)
    top = len(pi) - 1
    out = []
    for c_i in levels:
        p = sum(pi[c_i:]) if c_i <= top else 0.0
        if delta > 0.0 and horizon_s > 0.0:
            p = max(p, 1.0 - c_i / (delta * horizon_s))
        p = max(p, prefactor * _fill_share(c_i - servers, delta, var, horizon_s,
                                           tail=(lam / cap_real) if cap_real > 0.0
                                           else None))
        out.append(min(max(p, 0.0), 1.0))
    for i in range(len(out) - 2, -1, -1):
        out[i] = max(out[i], out[i + 1])   # downstream fills first, so it is fuller
    return out


# --- the model-side glue (still pure: it only reads the resolved line) --------

def _stage_room(stage, lam: float) -> int:
    """Slots of a belt stage that can actually ACCUMULATE.

    A belt is a pipeline: at rate ``lam`` a share ``lam/rate`` of its slots is
    already under a MOVING load, so only the rest is waiting room. On the bundled
    本線 (66 slots, 0.83 loads/s) that is a third of it at 2× demand — counting it
    as free buffer puts the jam later than the run has it.
    """
    room = 0.0
    for cv in stage:
        room += belt_slots(cv) * max(0.0, 1.0 - lam / max(_belt_rate(cv), 1e-9))
    return int(room)


def _bank_of(line: dict, stages, spurs, n_packers: int,
             pack_time_s: float) -> list[tuple[int, int, float]]:
    """The open 引き込み as ``(梱包台, slots, serve_s)`` in JUNCTION (arc) order.

    Junction order is what ``engine.build`` sorts ``ConveyorLine.junctions`` by and
    what ``_convey_chain`` scans in, so it is the order loads pile up in. It is
    read off ``beltgeom.feed_point`` — the same function the builder uses, so a
    引き込み drawn as one belt CROSSING the 本線 lands at its crossing arc here too
    (invariant 11: share the rule, do not mirror it).

    梱包台 come from ``beltgeom.bench_pools``, the same answer the engine gets — and
    from the SAME call ``line["benches"]`` came from, via the ``claimed``/``spare``
    the line resolved with it. Re-running ``bench_pools`` here to recover the 余り台
    would pair one call's bench counts with another call's claim set, which is the
    drift invariant 11 is about (they differ once a pull-in is worked from both
    extremities and a belt is missing from the live stages).

    A pull-in with nobody drawn at it (``UNSTAFFED``) borrows the 余り台, which is
    exactly what ``World.spare_bench`` lends it, and shares them with every other
    un-benched end; with every bench already claimed there is nothing to borrow and
    the load STALLS (``pack_unmanned``) — ``0`` servers here, which makes the chain
    read that pull-in as a slot sink that never drains. Which is what it is.
    (``_open_spurs`` drops that pull-in outright, so what survives to here is the
    half-drawn line: something claimed, and 余り台 left to share.)
    """
    spur_ids = {str(cv.id) for cv in line["spurs"]}
    trunks = [cv for st in stages[:-1] for cv in st]
    order = {}
    for cv in spurs:
        hit = beltgeom.feed_point(
            [(float(p[0]), float(p[1])) for p in cv.points],
            [(str(t.id), [(float(p[0]), float(p[1])) for p in t.points])
             for t in trunks], exclude=spur_ids)
        order[str(cv.id)] = hit[1] if hit is not None else float("inf")
    ordered = sorted(spurs, key=lambda cv: (order[str(cv.id)], str(cv.id)))

    claimed = line.get("claimed") or set()
    spare = int(line.get("spare") or 0)
    borrowers = sum(1 for cv in ordered
                    if not isinstance(line["benches"].get(str(cv.id)), int))

    bank = []
    for cv in ordered:
        b = line["benches"].get(str(cv.id))
        if isinstance(b, int) and b > 0:
            c = b
        elif claimed:
            c = spare // max(borrowers, 1)          # 余り台 only, and shared
        else:
            c = max(1, n_packers // max(borrowers, 1))   # nothing claimed: the pool
        k = belt_slots(cv)
        bank.append((c, k, _spur_serve_s(pack_time_s, c, k,
                                         k / max(_belt_rate(cv), 1e-9))))
    return bank


def _steady_block(model: WarehouseModel, line: dict, lam: float,
                  n_packers: int, pack_time_s: float,
                  capacity: float = float("inf"),
                  horizon_s: float = 0.0) -> float:
    """Share of hand-overs that WAIT while the line is under its capacity.

    Below ``capacity_line`` the belt does not fill up for good, but it still
    blocks now and then — and 「どれくらい詰まりますか」 is exactly what a proposal is
    asked. The waiting happens at the 引き込み, not on the line as a whole: a load
    that cannot turn into a spur stands on the 本線, and standing on the 本線 IS the
    blocked state.

    Two readings, and the answer is the WORSE of them:

    * the historical per-spur SPLIT — offer each pull-in ``λ/n`` and average its
      ``_mmck_full``. It is a genuine upper bound while the bank is comfortably
      under capacity, which is the whole bundled catalogue, and it is kept as a
      FLOOR so nothing there moves by a single ulp;
    * :func:`_overflow_cascade` — the 逐次オーバーフロー縦続 the bank really is.

    The split alone was **rosier than the DES** from ρ_bank ≈ 0.85 upwards, which
    is the one direction invariant 5 forbids. 貪欲ディバート is not a random split:
    ``processes._convey_chain`` takes the FIRST junction with room, so spur 1 is
    offered everything until its slots fill (measured intake 236/229/189 on a
    3-spur bank at ρ_bank = 1.0, flattening to 87/87/86 at one slot per spur). And
    the docstring's old rationale — "an UPPER bound, deliberately, because the
    engine passes a full spur's load on to the next junction, so the bank is
    partially pooled and blocks somewhat less" — holds only BELOW capacity. At and
    above it, pooling means the bank saturates as a whole and essentially every
    load stalls, so the pooled truth is far WORSE than the split: the deliberate
    upper bound inverts into a lower bound. Measured over 270 synthetic
    configurations at 8 h, the split is rosy in 202 of them, worst −0.815; the
    shipped 出荷ライン at 2× demand blocks 0.52 in the run and read 0.00.

    Returned per BOARDING, not per load, so it is directly comparable with
    ``kpis``' ``conveyor_block_ratio``: a load rides one belt per stage, and each
    of those legs can be turned away.
    """
    stages = line["stages"]
    spurs = _open_spurs(line)
    legs = max(len(stages), 1)
    if not spurs:
        # The legacy single-belt line: the belt itself is the waiting room in
        # front of the pooled benches. Untouched, byte for byte.
        total_slots = sum(belt_slots(cv) for st in stages for cv in st)
        return _mmck_full(int(n_packers), lam * pack_time_s,
                          max(0, total_slots - int(n_packers))) / legs

    probs = []
    for cv in spurs:
        benches = line["benches"].get(str(cv.id))
        # ``_open_spurs`` has already dropped the ones with no hands, so what is
        # left is either a real count or UNSTAFFED (nobody drawn ⇒ the
        # half-drawn-line fallback onto the shared pack pool).
        if not (isinstance(benches, int) and benches > 0):
            benches = max(1, int(n_packers / len(spurs)))
        slots = belt_slots(cv)
        probs.append(_mmck_full(benches, (lam / len(spurs)) * pack_time_s,
                                max(0, slots - benches)))
    split = statistics.fmean(probs) / legs

    bank = _bank_of(line, stages, spurs, n_packers, pack_time_s)
    upstream = [_stage_room(st, lam) for st in reversed(stages[:-1])]
    parts = _overflow_cascade(bank, upstream, lam, capacity, float(horizon_s))
    return max(split, sum(parts) / legs) if parts else split


def _conveyor_estimate(model: WarehouseModel, lam: float, n_packers: int,
                       pack_time_s: float, horizon_s: float) -> dict | None:
    """Does this conveyor line jam, and if so when? ``None`` when there is no line.

    ``lam`` is the tote arrival rate (1 order = 1 tote, the engine's own rule:
    ``processes`` hands the belt one tote per order in the batch).
    """
    line = _belt_stages(model)
    if line is None:
        return None
    # A deliberately unmanned 引き込み is never wired to the trunk (``build`` skips
    # its junction), so it passes nothing at all. Summing its belt rate into the
    # spur stage would sell lane capacity the floor has no people for; the loads
    # go to the belt's own end and the shared pack pool instead, which is what
    # dropping it leaves behind.
    open_ids = {str(cv.id) for cv in _open_spurs(line)}
    closed_ids = {str(cv.id) for cv in line["spurs"]} - open_ids
    stages = [st for st in ([cv for cv in st if str(cv.id) not in closed_ids]
                            for st in line["stages"]) if st]
    if not stages:
        return None
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
    # The steady reading is needed on BOTH branches, and it needs the line's
    # ceiling and the run's horizon: the bank's own levels fill IN ORDER, and how
    # much of the shift each one spends full is a property of the shift.
    # ``stages`` is the LIVE topology, so a closed 引き込み is not counted as a leg.
    steady = _steady_block(model, {**line, "stages": stages}, lam, n_packers,
                           pack_time_s, cap, float(horizon_s))
    if jams:
        # Over the horizon the line runs free until it fills, then passes only
        # ``cap`` and every hand-over waits: boardings = λ·t_jam + cap·(T − t_jam).
        # That charges ONE fill time for the WHOLE buffer, which is why it read the
        # shipped 出荷ライン at 2× demand as 0.00 — its 引き込み bank is full after
        # 1.9 h of the shift, its 本線 after 3.5 h and its 検品ライン after 6.2 h. So
        # the cascade, which fills the levels one at a time, is taken when worse.
        span = max(float(horizon_s), 0.0) - (ttj or 0.0)
        blocked = cap * span if span > 0.0 else 0.0
        total = lam * (ttj or 0.0) + blocked
        ratio = max((blocked / total) if total > 0.0 else 1.0, steady)
    else:
        ratio = steady
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


# ライン運用の3機構 (不変条件17). All three are opt-in and OFF in every shipped
# template, so these three predicates are False for the whole catalogue and the
# modules below are never even imported — which is what keeps ``estimate`` inside
# its 50 ms budget (the editor re-estimates while the mouse is still down) and the
# catalogue byte-identical.

def _has_gate(model: WarehouseModel) -> bool:
    """Does any drawn belt carry a 停止線? (a dict is authored, ``None`` is not)"""
    return any(isinstance(getattr(cv, "stop_gate", None), dict) and cv.stop_gate
               for cv in (model.resources.conveyors or []))


def _line_estimate(model: WarehouseModel, lam: float, n_stations: int,
                   pack_time_s: float, horizon_s: float) -> dict | None:
    """The 搬送ライン block: the mechanism the model switched on, else the belt chain.

    ``_conveyor_estimate`` prices ONE homogeneous load riding a greedy chain into
    pooled 梱包台. Two authored mechanisms break that story, and each has its own
    closed form under ``whsim.linemech`` returning the same keys, so this picks one:

    * **pull型引き込み** (``Process.divert_policy == "pull"``) — a junction is a LOSS
      system, not a queue: what nobody has hands for rides past instead of waiting.
    * **選択停止ゲート** (``Conveyor.stop_gate``) — a stopped kind's belt ENDS at the
      stop line and it holds its slot there until the gate's own hands take it off.

    Pull wins when both are authored: it changes what happens at every junction,
    which is upstream of what the gate then sees. The gate's own benches are not
    counted twice in that case — ``pull.resolve`` reads them as the end pool, which
    is where the engine hands a stopped load anyway. (A line authored with both is
    the one combination neither closed form was validated on; it errs to the pull
    reading, which is the gloomier of the two.)

    ``None`` from a mechanism means "not in play on this drawing" and falls through,
    so a model can never lose the answer it has today (never-blocks).
    """
    pull_on = str(getattr(model.process, "divert_policy", "auto") or "auto") == "pull"
    gate_on = _has_gate(model)
    if pull_on or gate_on:
        line = _belt_stages(model)          # resolved ONCE and handed to the mirror
        if line is not None:
            if pull_on:
                from whsim.linemech import pull as _pull
                out = _pull.estimate(model, line, lam, n_stations, pack_time_s,
                                     horizon_s)
                if out is not None:
                    return out
            if gate_on:
                from whsim.linemech import gate as _gate
                out = _gate.gate_line_estimate(model, lam, n_stations, pack_time_s,
                                               horizon_s, line=line)
                if out is not None:
                    return out
    return _conveyor_estimate(model, lam, n_stations, pack_time_s, horizon_s)


def _container_estimate(model: WarehouseModel, lam: float, n_stations: int,
                        pack_time_s: float, batch: float,
                        horizon_s: float) -> dict | None:
    """容器の有限循環 — ADDITIVE, and deliberately with no feedback into the headline.

    ``engine.processes`` claims one 容器 at 投入 and gives it back at 梱包完了, so a
    pool that binds costs throughput. It is tempting to throttle λ by it the way the
    AGV fleet and the belt chain are throttled — but measured, the engine does NOT
    charge the 投入待ち to the picker (a container-starved line reads picker 0.110
    against 0.155 unstarved, i.e. the blocked picker is idle, not busy). Throttling
    would therefore push this oracle's picker utilisation BELOW the run's, and
    reading a stage rosier than the run is the one thing invariant 5 forbids. So the
    pool answers its own question — 「レンタルは何個要るのか」, residence, peak, and
    whether it binds — and leaves every other number alone.

    ``None`` unless a pool is authored AND a belt is in use, which is where the
    engine's only ``_take_container`` call site sits.
    """
    if not isinstance(getattr(model.process, "container_pool", None), dict):
        return None
    if not model.process.container_pool:
        return None
    line = _belt_stages(model)
    if line is None:
        return None
    from whsim.linemech import container as _container
    return _container.container_estimate(
        model, lam=lam, n_benches=n_stations, pack_time_s=pack_time_s,
        horizon_s=horizon_s, line=line, batch=batch)


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
    conveyor = _line_estimate(model, lam, n_stations, pack_time,
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

    # A JAMMED line makes the batch a certainty, not a queueing outcome. Once the
    # belt is full the picker cannot hand over, so the order store never empties
    # and every trip pulls the cap. Solving the fixed point on the THROTTLED λ
    # instead reads the store as nearly empty and returns 1.02-1.25 orders/trip
    # where the DES measures 3.2-3.4 — which then over-charges the per-order trip
    # and read picker_utilization 0.669 against a measured 0.543. Bundled
    # templates never jam, so the catalogue is untouched.
    batch = (b_cap if (conveyor is not None and conveyor["jams"])
             else _batch_per_trip(model, b_cap, c, lam, trip_time_s))

    service_s = trip_time_s(batch) / batch   # picker-seconds per ORDER
    travel = trip_travel_m(batch) / batch

    # 通路干渉: a contended aisle cell is a capacity-1 server, so the same metres
    # cost more SECONDS. Distance is untouched — the engine pins that. ``None``
    # when the flag is off (every shipped template) ⇒ nothing below moves.
    congestion = _aisle_congestion(model, det, travel, lam, speed)
    if congestion is not None:
        service_s += congestion["wait_s_per_order_bound"]

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

    # 容器の有限循環: one container per order, claimed at 投入 and returned at 梱包完了,
    # so the rate that matters is the one actually inducted onto the line — the same
    # ``pack_lam`` the benches see. ``batch`` because 投入 claims one per order the
    # trip sweeps, all at one instant. ``None`` unless a pool is authored, and it
    # rides INSIDE the conveyor block: the engine's only ``_take_container`` call
    # site is the belt hand-over, so a pool without a line cannot be claimed at all
    # — and the shape of every existing answer stays exactly as it was.
    containers = _container_estimate(model, pack_lam, n_stations, pack_time, batch,
                                     model.simulation.duration_s)
    if conveyor is not None and containers is not None:
        conveyor = {**conveyor, "containers": containers}

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
        # whether it jams, when, what binds it and how often a hand-over waits —
        # and when the model authored 選択停止 or pull型引き込み, it is that
        # mechanism's own closed form speaking (``whsim.linemech``), in the same
        # keys plus its own ``gate``/``policy`` read-outs. A 容器プール hangs off it
        # under ``containers``, because a container is claimed on the belt
        # hand-over path and nowhere else.
        "conveyor": conveyor,
        # ADDITIVE: ``None`` unless 通路干渉 is switched on. An explicit UPPER
        # bound on the walk-time penalty, labelled as one.
        "aisle_congestion": congestion,
        # ADDITIVE disclosure, never a claim. The travel above is a
        # NEAREST-NEIGHBOUR tour; the engine can walk s_shape / return /
        # largest_gap instead (``process.routing_policy``, and two shipped
        # templates already do). Mirroring the disciplines was measured and
        # REJECTED: the DES's own sensitivity is ≤1.5% of walk on 7 of 9 templates
        # and ≤0.013 utilisation everywhere — 6x inside the agreement pin — while a
        # closed form built on the engine's own ``route_order`` made the oracle
        # worse (mean walk error 6.8% → 10.0%, max 15.5% → 31.0%) and ROSIER,
        # because it amplifies ``_batch_per_trip``'s own batch error superlinearly
        # and every bundled depot faces mid-band. So say which tour this is
        # instead of pretending it is policy-aware. See ``routecompare`` for the
        # real per-policy answer (2x-60x over this module's whole time budget).
        "routing_policy": str(model.process.routing_policy or "nearest"),
        "routing_policy_mirrored":
            str(model.process.routing_policy or "nearest") == "nearest",
        "packer_utilization": pack_util,
        "bottleneck_utilization": min(binding, 1.0),
        "bottleneck": bottleneck,
        "bottleneck_jp": _BOTTLENECK_JP[bottleneck],
        "capacity_orders_per_hr": c * mu * 3600.0,
        "offered_orders_per_hr": rate_per_hr,
        "pick_wait_mean_s": wq if math.isfinite(wq) else None,
        "overloaded": binding >= 1.0,
    }
