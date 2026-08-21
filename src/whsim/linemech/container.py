"""容器の有限循環 (finite container pool) in CLOSED FORM — 「レンタルは何個要るのか」.

WHY THIS EXISTS (invariant 5)
-----------------------------
``engine.processes`` claims one 折りたたみ容器 per order **at 投入** — the instant the
picker hands the tote to the belt (``_take_container``, which BLOCKS while every
container is out, so a shortage backs up into picking) — and gives it back at
梱包完了 (``_release_container`` spawns a process that rides the 還流ベルト, waits
``return_time_s``, and only then ``pool.put(1)``). ``analytic.estimate`` did not
mirror any of it, so a model with a pool read rosier in the instant estimate than
in the run meant to confirm it: the exact failure invariant 5 exists to prevent.

It also answers, in ~150 µs, a question that today needs a full DES run:
**how many containers must the operation own or rent?**

THE MODEL
---------
The pool is a **closed queueing network with N tokens**, so Little's law is the
spine. One container's cycle::

    take ─┬─ ride the chain to its 梱包台 (deterministic, off the drawn belts)
          ├─ wait for a free bench          ← the ONLY load-dependent term
          └─ 梱包 (pack_time_s)
          ┌─ ride the 還流ベルト home  (delay only: the return deck takes no slots)
          └─ return_time_s

    R(x) = T_ride + W_bench(x) + S_pack + T_return           [residence, s]
    L(x) = X(x) · R(x)                                       [Little: mean out]
    X    = X(x*) where L(x*) = N, else X(λ)                  [throughput bound]
    P    = quantile of the M[b]/G/∞ occupancy                [PEAK = the rental qty]

The pool binds exactly when ``L(λ) > N``: more containers would be out than exist.
``L`` is non-decreasing in the offered rate (both factors are), so ``L(x) = N`` has
a UNIQUE root and bisection finds it in a fixed 60 steps (~20 µs); above it Little
pins the answer, ``X = N/R``. That is the same statement as ``X = min(λ, N/R(X))``,
written so the monotone quantity is the one being bisected. No simulation, no graph
search, no RNG — the whole estimate is ~250 µs on the bundled 13-belt line.

引き込み IS AN OVERFLOW CASCADE, NOT A POOLED BANK
--------------------------------------------------
``processes._convey_chain`` diverts GREEDILY: a tote turns into the first 引き込み
with a free slot and only rides on when that one is full. So a 4-spur trunk does
NOT behave like 8 pooled benches — the near spur runs at 97% while the far one
sees nothing (measured 116 / 70 / 3 / 0 loads on the four). Pricing the bank as
one M/M/8 read the bench wait at ~0 s against a measured 47 s, i.e. it under-read
the residence by 20% — and under-reading the residence under-buys containers.

The right closed form is the classic **overflow cascade**: spur *i* is M/M/c_i/K_i
(its own benches as servers, its own SLOTS as the waiting room — ``_belt_room`` is
a slot test), the blocked fraction ``B_i`` is offered to spur *i+1*, and the LAST
spur absorbs the remainder as an ordinary M/M/c queue (a tote that finds every
spur full stalls on the 本線 and is not lost). Predicted split: 113.6 / 71.7 / 3.6
/ 0 against the measured 116 / 70 / 3 / 0.

The carried loads then also weight the *geometry*: the trunk ride runs to the
mean CARRIED junction (predicted 8.4 m vs measured 8.41 m) and the empty rides
home from the mean CARRIED discharge point (40.4 s vs 40.41 s).

THE DRAWING IS READ THROUGH ``beltgeom``, NEVER RE-DERIVED
----------------------------------------------------------
Where a 引き込み is fed, how far it then rides, and whose 梱包台 stands at its end
are ``beltgeom``'s answers — the same ones ``engine.build`` and ``analytic`` use —
resolved once for all three mechanisms by ``linemech.bench_ledger`` /
``linemech.junctions``, over the chain ``analytic._belt_stages`` hands in. A
private copy of that arithmetic is exactly what let the two drift before, and the
drift is invisible from the outside because the orders still complete:

* a spur drawn as ONE belt CROSSING the 本線 is fed in its MIDDLE
  (``feed_point``/``feed_arc``), so it rides only the rest of its length — 8 m,
  not 16 m, on the reference drawing;
* a spur whose only bench belongs to a NEARER pull-in (``beltgeom.LOST``) or that
  is deliberately unmanned (``CLOSED``) gets no junction at all and must not be
  priced as a lane — counting that shared bench for both spurs reads a 2-lane bank
  where the floor has one pair of hands, i.e. ROSIER than the run;
* a spur nobody is drawn at borrows only the benches nobody claimed
  (``World.spare_bench``), and with every bench spoken for it takes nothing;
* ``Conveyor.discharge_both`` doubles the bank (2 → 4 on the same drawing).

WHAT IT DOES NOT MODEL (measured, so you know the shape of the error)
---------------------------------------------------------------------
One representative path per 荷の種別. Where that is not the line's shape, the
answer drifts and the drift has been measured rather than guessed:

* **two 検品ライン joining the 本線 at very different arcs**, where the late one
  boards PAST the whole bank: those loads see no junction at all and pile up at
  the belt end, which this prices as if they had been taken by the last 引き込み.
  Measured on a 4-spur line at saturation: residence 179 s against 500 s — ROSY,
  and the same with the gate armed or removed, so it is this, not the gate. The
  bundled ``line_inspection`` has that shape mildly and reads +17% (gloomy).
* **``divert_policy: "pull"``**: the cascade here is 貪欲ディバート's (slot-blocking
  M/M/c/K), not pull's loss system. Measured +27…+31% on residence — gloomy, so
  the rental quantity is over-bought rather than under-bought, but it is not the
  right mechanism. ``linemech.pull`` is.

INERT WITHOUT A POOL — provably
-------------------------------
``_take_container`` is called from exactly ONE place in the engine
(``processes.picker_agent``, inside the ``board is not None and not agv_mode``
branch), so a model with no pool — or no belt in use, or GTP — never touches a
container. :func:`container_estimate` returns ``None`` on those conditions before
it reads anything else.
"""

from __future__ import annotations

import math

from whsim import beltgeom
from whsim.analytic import _erlang_c as erlang_c
from whsim.analytic import belt_length, belt_slots, belt_speed
from whsim.linemech import bench_ledger, gate_stops, junctions, point_at, resolve_gate

# ``beltgeom`` is the ONE source for where a belt is fed, where it discharges and
# whose 梱包台 stands there; ``analytic`` is the one source for what a belt's four
# scalars are (length / pitch / speed / slots) and for the chain they hang on.
# ``engine.build`` reads the same two, so a private copy here is exactly what let
# the engine and the oracle drift before (a crossing 引き込み: 4 benches in the run,
# 2 in the estimate). Both are pure arithmetic — no simpy — so importing them costs
# nothing on the live path.

# How sure the rental quantity has to be: ``required_pool`` is the level the line
# is expected to exceed with at most this probability over the horizon. Calibrated
# against 20 seeds × 3 demand levels on the reference line — nominal 5% came out
# at 19-20/20 covered, nominal 10% at 18-20/20, i.e. the quantile means what it
# says. 0.05 rather than 0.10 because running out of containers stops the line,
# and one spare 折りたたみ容器 is cheaper than that.
_SIZING_RISK = 0.05

# Bisection budget for the binding fixed point: the bracket halves every step, so
# 60 steps is past float resolution and still ~20 µs.
_FIXED_POINT_STEPS = 60


# ------------------------------------------------------------- queueing pieces
#
# ``erlang_c`` is ``analytic._erlang_c``, imported rather than copied (invariant
# 11). ``mmck`` extends ``analytic._mmck_full``'s ratio recursion with the mean
# occupancy Little needs; its P(full) leg is parity-tested against it.


def mmck(c: int, a: float, k: int) -> tuple[float, float]:
    """``(P(system full), E[number in system])`` for M/M/c/(c+k).

    The same ratio recursion ``analytic._mmck_full`` uses (``r_n = r_{n-1}·a/n``
    for n ≤ c, ``·a/c`` above), extended to also return the mean occupancy — which
    is what Little turns into the tote's time in the 引き込み. O(c+k), no scipy.
    """
    if c <= 0:
        return 1.0, 0.0
    if a <= 0.0:
        return 0.0, 0.0
    n_max = c + max(int(k), 0)
    r = total = 1.0
    weighted = 0.0
    for n in range(1, n_max + 1):
        r *= (a / n) if n <= c else (a / c)
        total += r
        weighted += n * r
        if total > 1e290:
            r /= 1e100
            total /= 1e100
            weighted /= 1e100
    return r / total, weighted / total


def _poisson_tail_scan(mean: float, budget: float, threshold: float) -> int:
    """``max{k : budget · P(N = k−1) ≥ threshold}`` for ``N ~ Poisson(mean)``.

    Walks the ratio recursion ``p_k = p_{k-1}·mean/k`` outward from the MODE (the
    peak of a queue is always at or above its mean, and starting at 0 would
    underflow ``e^{-mean}`` for a big pool). Unimodality makes the scan
    monotone once past the mode, so it terminates in O(√mean) steps.
    """
    if mean <= 0.0 or budget <= 0.0:
        return 0
    mode = max(int(mean), 0)
    log_p = -mean + (mode * math.log(mean) if mode else 0.0) - math.lgamma(mode + 1.0)
    p = math.exp(log_p) if log_p > -700.0 else 0.0
    if budget * p < threshold:               # even the mode is not reached: walk DOWN
        k, pk = mode, p
        while k > 0:
            pk *= k / mean                   # p_{k-1} = p_k · k / mean
            k -= 1
            if budget * pk >= threshold:
                return k + 1
        return 0
    k = mode                                 # ...otherwise walk UP to the tail
    best = k + 1
    span = mean + 40.0 * math.sqrt(mean + 1.0)
    while k <= span:
        k += 1
        p *= mean / k
        if p <= 0.0:
            break
        if budget * p >= threshold:
            best = k + 1
        else:
            break
    return best


def peak_estimate(rate: float, residence_s: float, horizon_s: float,
                  batch: float = 1.0, risk: float | None = None) -> int:
    """Largest simultaneous in-use count expected over ``horizon_s``.

    Occupancy of an infinite-server queue under Poisson arrivals is POISSON
    distributed (M/G/∞ — insensitive to the residence DISTRIBUTION, which is why
    a deterministic 梱包 does not break it), and PASTA makes every arrival see
    that distribution. An arrival that finds ``k−1`` out pushes the level to
    ``k``, so::

        E[upcrossings to k over T] = rate · T · P(N = k−1),  N ~ Poisson(rate·R)

    ``risk = None`` (the default) returns the **expected max** — the largest ``k``
    still expected to be reached at least once, which is what
    ``kpis.containers_in_use_peak`` measures on one run of that length. A ``risk``
    of 0.10 instead returns the **sizing quantity**: the level that is exceeded
    with probability ≤ 10% (threshold ``−ln(1−risk)``), which is the number to
    rent.

    投入 is BATCHED — a trip claims one container per order it sweeps, back to
    back with no timeout between them — so the arrivals are compound Poisson:
    ``batch`` containers per event at ``rate/batch`` events per second, occupancy
    ``batch × Poisson(rate·R/batch)``. The peak then quantises to multiples of the
    batch, which is real and not an artefact: a picker never takes half a trip's
    worth of containers.
    """
    if rate <= 0.0 or residence_s <= 0.0 or horizon_s <= 0.0:
        return 0
    b = max(1.0, float(batch))
    threshold = 1.0 if risk is None else -math.log(1.0 - min(max(risk, 1e-9), 0.999999))
    k = _poisson_tail_scan(rate * residence_s / b, (rate / b) * horizon_s, threshold)
    return math.ceil(k * b)


# ------------------------------------------------------------- geometry pieces
#
# ``engine.build.ConveyorLine`` evaluated on the authored polylines: pure
# arithmetic over the drawn points, no graph search. The belt's own four scalars
# come from ``analytic`` (``belt_length``/``belt_speed``/``belt_slots``) so the
# oracle and the run cannot read different belts.

def _pts(cv) -> list[tuple[float, float]]:
    return [(float(p[0]), float(p[1])) for p in (getattr(cv, "points", None) or [])
            if len(p) >= 2]


def _length(pts) -> float:
    """Length of a polyline the caller already holds (a partial ride, a spur)."""
    return sum(math.dist(pts[i - 1], pts[i]) for i in range(1, len(pts)))


def _gate_arc(cv, kind: str) -> float | None:
    """``StopGate.stops(kind)`` ⇒ where THIS belt ends for a load of that kind.

    ``None`` = no gate, or a gate this kind passes. The gate itself is resolved by
    ``linemech.resolve_gate`` — one mirror of ``build._resolve_gate``, not one per
    mechanism.
    """
    g = resolve_gate(cv)
    return g[0] if (g is not None and gate_stops(g, kind)) else None


# --------------------------------------------------------------- the line, resolved

def entry_shares(model, entries) -> dict[str, float]:
    """Share of loads boarding each 荷の種別 (``Conveyor.load_kind``).

    One belt can carry two kinds at once and a 停止線 sends them to DIFFERENT pairs
    of hands (検品済容器 stops at the line, 梱包済完成品 rides on to カーブ), so a
    container's residence depends on which kind it is. ``processes._board_conveyor``
    offers only the ENTRANCES and takes the Manhattan-nearest projection, so the
    share is decided by which pick face is beside which entry belt. No locations ⇒
    equal shares (never-blocks).
    """
    kinds = [str(getattr(cv, "load_kind", "") or "") for cv in entries]
    if len(set(kinds)) <= 1:
        return {kinds[0] if kinds else "": 1.0}
    locs = model.locations or []
    if not locs:
        share = 1.0 / len(entries)
        out: dict[str, float] = {}
        for k in kinds:
            out[k] = out.get(k, 0.0) + share
        return out
    tally: dict[str, float] = {}
    paths = [(_pts(cv), k) for cv, k in zip(entries, kinds)]
    for loc in locs:
        p = (float(loc.x), float(loc.y))
        best = None
        for pts, k in paths:
            if len(pts) < 2:
                continue
            q = beltgeom.project(p, pts)[0]
            d = abs(p[0] - q[0]) + abs(p[1] - q[1])       # the picker's own metric
            if best is None or d < best[0]:
                best = (d, k)
        if best is not None:
            tally[best[1]] = tally.get(best[1], 0.0) + 1.0
    total = sum(tally.values())
    return {k: v / total for k, v in tally.items()} if total else {"": 1.0}


def resolve_line(model, line: dict, kind: str = "", ledger=None) -> dict:
    """The chain a container of ``kind`` rides, as the numbers the closed form needs.

    ``line`` is ``analytic._belt_stages(model)`` — the same chain resolution
    ``engine.build._wire_conveyor_chain`` produces, so 解析 and DES can never be
    looking at different belts (invariant 5).

    Returns ``{"trunk_s", "spurs": [{benches, slots, arc, ride_s, end}], "gate", …}``
    where ``trunk_s`` is the deterministic ride from the boarding point to the
    junction bank, and each spur carries what it needs to be one M/M/c/K stage.

    Three of ``engine.build``'s rules are load-bearing here and none of them is
    re-derived — the junction rule comes from :func:`linemech.junctions` and the
    bench ledger from :func:`linemech.bench_ledger`, which is what the other two
    mechanisms read too:

    * a 引き込み is fed at :func:`beltgeom.feed_point` — its infeed when that sits on
      the 本線 (every half-drawn spur, ``feed_arc`` 0), else where the two PATHS
      meet. A spur drawn as ONE belt CROSSING the trunk is fed in its MIDDLE, so it
      rides only ``length − feed_arc``, not its whole length.
    * a spur with no hands (``beltgeom.NO_HANDS`` — unmanned, or its bench claimed
      by a nearer pull-in) gets no junction at all: it takes nothing and must not
      appear in the cascade, or the bank is priced with servers the floor has not
      got — rosier than the run.
    * a spur nobody is DRAWN at borrows only the benches nobody else claimed
      (``World.spare_bench``), and if every bench is spoken for it takes nothing —
      the ledger has already closed it, exactly as ``build`` does.
    """
    stages = line["stages"]
    spur_ids = set(line["spur_ids"])

    # --- the trunk run: entry belt → hand-overs → the junction bank -----------
    trunk_stages = [[cv for cv in st if str(cv.id) not in spur_ids] for st in stages]
    trunk_stages = [st for st in trunk_stages if st]
    # Where each 引き込み hangs off its host is ``linemech.junctions`` — ``build``'s
    # own 枝分かれ rule, resolved once for all three mechanisms.
    spur_info = [{
        "id": j["spur"], "host": j["host"], "arc": j["arc"],
        "slots": belt_slots(j["cv"]), "benches": j["benches"],
        "end": _pts(j["cv"])[-1],
        "ride_s": max(belt_length(j["cv"]) - j["feed_arc"], 0.0) / belt_speed(j["cv"]),
    } for j in junctions(model, line, ledger) if len(_pts(j["cv"])) >= 2]

    trunk_s = 0.0
    trunk_slots = 0
    gate = None
    gate_belt = None
    gate_stage = None
    tail_end = None
    for si, stage in enumerate(trunk_stages):
        legs, ends = [], []
        for cv in stage:
            pts = _pts(cv)
            if len(pts) < 2:
                continue
            length = _length(pts)
            joins = [beltgeom.project(e, pts)[1] for e in (tail_end or [])
                     if beltgeom.distance_to(e, pts) <= beltgeom.JOIN_TOL_M]
            arc_in = (sum(joins) / len(joins)) if joins else 0.0
            arc_out = length
            # 停止線 only stops what PASSES it: a load that boarded (or handed over)
            # DOWNSTREAM of the gate is already past it and rides on. Without the
            # ``>= arc_in`` test the engine used to drag it backwards in zero time.
            g = _gate_arc(cv, kind)
            if g is not None and g >= arc_in - 1e-9:
                arc_out = min(arc_out, g)
                gate = {"end": point_at(pts, arc_out), "arc": arc_out,
                        "trunk_s": 0.0}
                gate_belt, gate_stage = str(cv.id), si
            if si + 1 < len(trunk_stages):     # hand over to the next 本線 stage
                nxt = [beltgeom.project(_pts(n)[0], pts)[1] for n in trunk_stages[si + 1]
                       if len(_pts(n)) >= 2
                       and beltgeom.distance_to(_pts(n)[0], pts) <= beltgeom.JOIN_TOL_M]
                if nxt:
                    arc_out = min(arc_out, sum(nxt) / len(nxt))
            legs.append((arc_in, arc_out, belt_speed(cv), pts))
            ends.append(point_at(pts, arc_out))
            trunk_slots += belt_slots(cv)
        if not legs:
            continue
        # The junction bank sits on the LAST trunk stage: the ride to it is priced
        # per spur below (weighted by what each one actually carries), so only the
        # run UP TO the bank is charged here. A 停止線 does NOT replace that bank —
        # it stands at the END of it and catches what no 引き込み had hands for, so
        # the spurs BEFORE it keep their lanes and the gate is the terminus. (The
        # ones beyond it are invisible to a stopped load: ``_convey_chain`` looks
        # for junctions only up to ``end_arc``.) Reading the gate as the only exit
        # priced a 10-bench bank as one 1-slot lane.
        bank = si + 1 == len(trunk_stages) and spur_info and (
            gate is None or gate_stage == si)
        if bank:
            arc_in, _out, sp, pts = legs[0]
            for s in spur_info:
                if gate is not None and s["arc"] > gate["arc"] + 1e-9:
                    continue                 # 停止線の先の引き込みは見えない
                s["trunk_s"] = max((s["arc"] or 0.0) - arc_in, 0.0) / sp
                s["host_pts"] = pts
            if gate is not None:
                gate["trunk_s"] = max(gate["arc"] - arc_in, 0.0) / sp
        else:
            trunk_s += sum((b - a) / sp for a, b, sp, _p in legs) / len(legs)
        tail_end = ends
    return {"trunk_s": trunk_s, "spurs": spur_info, "gate": gate,
            "trunk_slots": trunk_slots, "tail_end": (tail_end or [None])[0],
            "gate_belt": gate_belt}


def _cascade(spurs: list[dict], lam: float, s_pack: float, wait_cap: float,
             pack_cv2: float):
    """引き込みの貪欲ディバート as an OVERFLOW CASCADE. See the module docstring.

    Returns ``(wait_s, ride_s, return_pts, weights)`` — the mean bench wait a
    container suffers, the mean ride from the boarding point to its bench, and the
    discharge points it goes home from, each WEIGHTED BY WHAT EACH SPUR CARRIES.
    """
    offered = lam
    carried, waits, rides, pts = [], [], [], []
    for i, s in enumerate(spurs):
        c = max(int(s["benches"]), 0)
        if i == len(spurs) - 1:
            # A tote that finds every 引き込み full does NOT vanish: it stalls on the
            # 本線 (auto) holding a slot, so the LAST stage carries the whole
            # remainder with an effectively unbounded queue — the back-pressure
            # that ends at the picker. Erlang-C, capped by the closed network.
            w = _wait_mmc(c, offered, s_pack, wait_cap, pack_cv2)
            took = offered
        else:
            # A finite 引き込み: its own benches as servers, its own SLOTS as the
            # waiting room (``_belt_room`` is a slot test). What it cannot take is
            # offered to the next one — that IS 貪欲ディバート. No cap and no cv²
            # correction is needed here: the queue is bounded by the belt itself
            # (``L ≤ K``), and a nearly-full finite buffer is full whatever the
            # service distribution looks like, so M/M/c/K's occupancy is already
            # the right shape (validated to −0.4% on a 4-spur trunk).
            b, ell = mmck(c, offered * s_pack, max(0, int(s["slots"]) - c))
            took = offered * (1.0 - b)
            w = max(ell / took - s_pack, 0.0) if took > 0 else 0.0
            offered -= took
        if took <= 0.0:
            continue
        carried.append(took)
        waits.append(w)
        rides.append(s.get("trunk_s", 0.0) + s["ride_s"])
        pts.append(s["end"])
    total = sum(carried) or 1.0
    wait = sum(w * n for w, n in zip(waits, carried)) / total
    ride = sum(r * n for r, n in zip(rides, carried)) / total
    return wait, ride, pts, [n / total for n in carried]


def _wait_mmc(c: int, lam: float, s_pack: float, cap: float, cv2: float) -> float:
    """M/M/c wait at the benches, capped by what N containers can physically queue.

    ``cv2`` is the squared coefficient of variation of the pack service
    (Allen–Cunneen: ``W ≈ W_MMc·(1+cv²)/2``). The engine's 梱包 is DETERMINISTIC
    (``env.timeout(pack_time)``) so ``cv² = 0`` is not an optimistic fudge — it is
    the correct model of the code. Leaving it at the house M/M/c value read the
    wait 4.7× high once 梱包 passed ρ ≈ 0.8, which would have had the proposal rent
    twice the containers it needs.
    """
    if s_pack <= 0.0 or lam <= 0.0:
        return 0.0
    if c <= 0:
        # 誰も居ない末端 (an unmanned 停止線): nothing is served there, so a load
        # that reaches it waits as long as the pool and the belt physically allow.
        # Weighted by the overflow that actually gets that far — which is ~0 on a
        # line whose 引き込み absorb everything, so this stays quiet until it bites.
        return cap
    mu = 1.0 / s_pack
    if lam >= c * mu:
        return cap
    w = erlang_c(c, lam * s_pack) / (c * mu - lam) * (1.0 + cv2) / 2.0
    return min(w, cap)


def closed_wait_cap(n_pool: int, delay_s: float, s_pack: float, c: int) -> float:
    """The bench wait N circulating containers can possibly produce — exact MVA.

    The open Erlang-C form has a pole at ``λ → c·μ``: it sends R, and with it the
    fixed point, to infinity. But a CLOSED network cannot do that — with only N
    containers there are at most N−1 ahead of you, and most of them are away on
    the belts or the 還流ベルト rather than queueing. Mean Value Analysis is the
    textbook exact answer for that network (Reiser–Lavenberg for c servers)::

        R_q(n) = (S/c)·[1 + Q(n−1) + Σ_{j<c−1}(c−1−j)·P_j(n−1)]
        X(n)   = n / (Z + R_q(n));   Q(n) = X(n)·R_q(n)

    with ``Z`` the delay a container spends riding (loaded and empty) and
    ``return_time_s``. Capping the open wait with ``R_q(N) − S`` is what makes the
    estimate ALWAYS return a number (never-blocks) and what got the saturated
    cases right: a 6-container pool offered 330 orders/h reads 214/h against a
    measured 210/h — the open form said 0.

    O(N·c), and short-circuited to the saturation asymptote ``N·S/c − Z`` past the
    knee, so a 5 000-container pool costs the same handful of microseconds.
    """
    n = int(n_pool)
    c = int(c)
    if c <= 0 or s_pack <= 0.0 or n <= 0:
        return 0.0
    if n <= c:
        return 0.0                      # fewer containers than benches: never queues
    # Past the knee the recursion converges on the saturation line ``N·S/c − Z``,
    # so a huge pool is answered without iterating. The switch is taken WELL past
    # the knee (and the two branches combined with ``max``) because the asymptote
    # UNDER-shoots right at it — switching there made the cap non-monotone in N,
    # which would have broken the fixed point's uniqueness argument.
    knee = c * (1.0 + delay_s / s_pack)  # where the servers first run out of work
    n_mva = min(n, max(int(4.0 * knee) + c + 2, 64))
    if n_mva * c > 200_000:
        return max(n * s_pack / c - delay_s - s_pack, 0.0)
    p = [0.0] * c                       # P_j(n): j busy servers
    p[0] = 1.0
    q = 0.0
    rq = best = s_pack
    for i in range(1, n_mva + 1):
        rq = (s_pack / c) * (1.0 + q + sum((c - 1 - j) * p[j] for j in range(c - 1)))
        # ``i`` tokens can put at most ``i−1`` containers ahead of you, so the
        # response can never exceed ``S + (i−1)·S/c``. Clamping there (and clamping
        # the marginals to a probability below) is what keeps the recursion usable
        # for a wide bench bank: in plain floating point the Reiser–Lavenberg
        # marginals go NEGATIVE past the knee for c ≈ 20 and the answer explodes,
        # which would have destroyed the monotonicity the fixed point relies on.
        rq = min(rq, s_pack + (i - 1) * s_pack / c)
        best = max(best, rq)
        x = i / (delay_s + rq)
        q = x * rq
        prev = p[:]
        for j in range(c - 1, 0, -1):
            p[j] = min(max((x * s_pack / j) * prev[j - 1], 0.0), 1.0)
        p[0] = min(max(1.0 - (x * s_pack + sum((c - j) * p[j]
                                               for j in range(1, c))) / c, 0.0), 1.0)
        tail = sum(p)
        if tail > 1.0 + 1e-9:                  # renormalise: they are marginals of ONE state
            p = [v / tail for v in p]
    if n > n_mva:
        return max(n * s_pack / c - delay_s - s_pack, best - s_pack, 0.0)
    return max(best - s_pack, 0.0)


# ------------------------------------------------------------------ the answer

def pool_spec(model) -> dict | None:
    """``Process.container_pool`` as the engine reads it — ``None`` ⇒ 容器は無限.

    Mirrors ``engine.build`` including its never-blocks fallbacks: a non-dict, an
    empty dict, or a missing / zero / negative / mis-typed ``count`` are all "no
    pool at all", never "a pool nobody can draw from" (a warehouse with zero
    containers ships nothing).
    """
    spec = getattr(getattr(model, "process", None), "container_pool", None)
    if not isinstance(spec, dict) or not spec:
        return None
    try:
        n = int(spec.get("count", 0) or 0)
    except (TypeError, ValueError):
        return None
    return spec if n > 0 else None


def _return_seconds(model, spec: dict, pack_pts, weights) -> float:
    """Mean seconds an EMPTIED container takes to get back into the pool.

    ``processes._container_return``: ride the 還流ベルト from where the pack point
    projects onto it to its discharge end, then ``return_time_s``. The deck is
    geometry ONLY — no slots, no contention — so this is a pure delay and it never
    appears in the conveyor KPIs.
    """
    try:
        ret_s = max(0.0, float(spec.get("return_time_s", 0.0) or 0.0))
    except (TypeError, ValueError):
        ret_s = 0.0
    ref = str(spec.get("return_belt", "") or "")
    # Resolved off the DRAWN belts, not the designed ones: 上段の還流ベルト carries no
    # order, so it is in no flow leg and never appears in the chain (engine.build).
    rcv = next((c for c in (model.resources.conveyors or []) if str(c.id) == ref), None)
    if rcv is None:
        return ret_s
    pts = _pts(rcv)
    if len(pts) < 2:
        return ret_s
    length = _length(pts)
    if length <= 1e-9:
        return ret_s
    speed = belt_speed(rcv)
    live = [(p, w) for p, w in zip(pack_pts, weights) if p is not None]
    if not live:
        return ret_s + length / speed
    tot = sum(w for _p, w in live) or 1.0
    return ret_s + sum(((length - beltgeom.project(p, pts)[1]) / speed) * w
                       for p, w in live) / tot


def container_estimate(
    model,
    *,
    lam: float,
    n_benches: int,
    pack_time_s: float,
    horizon_s: float,
    line: dict | None,
    batch: float = 1.0,
    pack_cv2: float = 0.0,
    sizing_risk: float = _SIZING_RISK,
) -> dict | None:
    """容器の有限循環 in closed form. ``None`` when the mechanism cannot fire.

    ``None`` — and therefore an untouched estimate — whenever the engine would
    never call ``_take_container``: no pool stated, or no belt in use. The claim
    lives on the conveyor hand-over path and nowhere else, so those two tests are
    exhaustive.

    Every parameter is something ``analytic.estimate`` already has in hand at the
    call site, so nothing is recomputed:

    * ``lam``        — orders/s actually inducted onto the line, i.e. ``estimate``'s
                       ``pack_lam = min(lam, c·mu)`` after the AGV and conveyor caps
                       (one order = one tote = one container). A jammed belt reaches
                       this module THROUGH λ — that is how ``estimate`` composes its
                       stages, and it is why there is no separate jam argument.
    * ``n_benches``  — ``n_stations``; used when the drawing puts nobody at a spur
                       (the half-drawn-line fallback the engine takes).
    * ``pack_time_s``— ``process.pack_time_s``.
    * ``horizon_s``  — ``simulation.duration_s``. The peak is a max over a WINDOW,
                       so it genuinely depends on how long you watch.
    * ``line``       — ``analytic._belt_stages(model)``; ``None`` ⇒ no belt in use.
    * ``batch``      — ``estimate``'s own ``batch`` (``_batch_per_trip``): 投入 claims
                       one container per order the trip sweeps, all at one instant.
    * ``pack_cv2``   — see :func:`_wait_mmc`.
    * ``sizing_risk``— how often ``required_pool`` may be exceeded (default 5%).
    """
    spec = pool_spec(model)
    if spec is None or line is None:
        return None
    n_pool = int(spec["count"])
    s_pack = max(float(pack_time_s), 0.0)
    mu = (1.0 / s_pack) if s_pack > 0.0 else float("inf")

    # ONE BRANCH PER 荷の種別. Without a 停止線 there is exactly one and everything
    # below collapses to the single-path arithmetic; with one, the 検品済容器 and the
    # 梱包済完成品 ride the same belts to different pairs of hands, so they have
    # different residences and different capacities.
    ledger = bench_ledger(model, line)
    # What a belt end with nobody of its own gets — ``processes._bench_pool``: the
    # spare benches, the whole floor when no bench is claimed at all, or NOBODY
    # once every bench stands at a 引き込み or a 停止線. ``n_benches`` (the floor) is
    # only the answer in that middle case, which is what the ledger already says.
    fallback_c = ledger["fallback"] if ledger["claimed"] else max(int(n_benches), 1)
    branches = []
    for kind, share in entry_shares(model, line["stages"][0]).items():
        geo = resolve_line(model, line, kind, ledger)
        spurs = [s for s in geo["spurs"] if s.get("trunk_s") is not None]
        # 誰も描かれていない引き込み: it borrows the SPARE benches (shared between all
        # of them). With every bench claimed it has nobody at all and the ledger has
        # already closed it, exactly as ``build`` does — so nothing is left here.
        unstaffed = [s for s in spurs if not isinstance(s["benches"], int)
                     or s["benches"] <= 0]
        for s in unstaffed:
            s["benches"] = max(1, ledger["fallback"] // max(len(unstaffed), 1))
        if geo["gate"] is not None:
            # 停止線 で降ろす: its OWN hands, and it stands at the END of the bank —
            # a load reaches it only when no 引き込み before it had room, so it is
            # the cascade's terminus, not a replacement for it. (Replacing the bank
            # priced a 10-bench line as one 1-slot lane: capacity 46/h against a
            # measured 434, residence 2 770 s against 527.) It holds its slot until
            # its bench frees, so the trunk behind it IS its waiting room.
            n_gate = ledger["gates"].get(geo["gate_belt"], 0) or fallback_c
            spurs = spurs + [{"id": "gate", "benches": n_gate,
                              "slots": max(geo["trunk_slots"], 1),
                              "end": geo["gate"]["end"], "ride_s": 0.0,
                              "trunk_s": geo["gate"].get("trunk_s", 0.0)}]
        if not spurs:                         # legacy single belt: the shared pool
            spurs = [{"id": "pack", "benches": fallback_c, "slots": 1,
                      "end": geo["tail_end"], "ride_s": 0.0, "trunk_s": 0.0}]
        # 誰も居ない末端に着く荷: nobody takes it off the line, so its container never
        # comes back (``processes`` logs ``pack_unmanned`` and the load stands there
        # for good). The residence is then the whole window, which is the honest
        # reading of 「返ってこない」 — and it is what makes such a pool bind at once
        # instead of reading as a line that flows.
        dead = not any(int(s["benches"]) > 0 for s in spurs)
        cap = sum(max(int(s["benches"]), 0) for s in spurs) * mu
        branches.append({"share": share, "geo": geo, "spurs": spurs,
                         "cap": cap, "dead": dead})

    for b in branches:
        if b["dead"]:                         # nobody at the end: nothing comes back
            b["wait_cap"] = max(float(horizon_s), 0.0)
            continue
        # The delay a container spends NOT queueing (riding loaded + riding home +
        # return_time_s), evaluated once: it is what the closed-network cap needs,
        # and it moves only through WHICH spur is used, not through the load.
        _w, ride0, pts0, wts0 = _cascade(b["spurs"], min(lam * b["share"], b["cap"]),
                                         s_pack, float("inf"), pack_cv2)
        z = b["geo"]["trunk_s"] + ride0 + _return_seconds(model, spec, pts0, wts0)
        # The cap belongs to the OPEN last stage only — that is where the Erlang
        # pole is — and to THAT stage's own benches, not the whole bank: 貪欲
        # ディバート never pools them (pooling here read a binding 4-spur pool 27%
        # short on residence).
        c_last = max(int(b["spurs"][-1]["benches"]), 1)
        # ...and by the BELT ITSELF. A container waiting for a bench is standing on
        # a slot, and there are only so many: a full chain drains at ``c/S``, so the
        # wait can never exceed ``(slots − c)·S/c``. This is what stops a saturated
        # 停止線 branch from claiming the whole pool — the engine's containers pile
        # up ON the belt (measured 14.1 out on a 12-slot chain, against an
        # unbounded 60 without it).
        b["wait_cap"] = min(
            closed_wait_cap(n_pool, z, s_pack, c_last),
            max(b["geo"]["trunk_slots"] + sum(int(s["slots"]) for s in b["spurs"])
                - c_last, 0) * s_pack / c_last)

    def parts(x: float):
        """(mean containers out, throughput, residence, ride, return, wait) at ``x``."""
        tot, acc_r, acc_ride, acc_ret, acc_w = 0.0, 0.0, 0.0, 0.0, 0.0
        for b in branches:
            if b["dead"]:
                # The load is inducted (it takes a container) and then stands on the
                # belt for ever, so the whole window IS the residence — no cascade,
                # no cap: there is nobody to be waiting FOR.
                xk = x * b["share"]
                tot += xk
                acc_r += xk * b["wait_cap"]
                acc_ride += xk * b["geo"]["trunk_s"]
                continue
            xk = min(x * b["share"], b["cap"])
            wait, ride, pts, wts = _cascade(b["spurs"], xk, s_pack,
                                            b["wait_cap"], pack_cv2)
            t_ride = b["geo"]["trunk_s"] + ride
            t_ret = _return_seconds(model, spec, pts, wts)
            r_k = t_ride + wait + s_pack + t_ret
            tot += xk
            acc_r += xk * r_k
            acc_ride += xk * t_ride
            acc_ret += xk * t_ret
            acc_w += xk * wait
        if tot <= 0.0:
            return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0
        return (acc_r, tot, acc_r / tot, acc_ride / tot, acc_ret / tot, acc_w / tot)

    # THE FIXED POINT. ``L(x) = X(x)·R(x)`` is the mean number of containers out;
    # it is non-decreasing in the offered rate (both factors are), so ``L(x) = N``
    # has a unique root and bisection finds it in a fixed 60 steps. Above the root
    # the pool is exhausted and Little pins the answer: X = N/R.
    l_free, x_free, r_free, *_ = parts(lam)
    if l_free <= n_pool:
        throttles = False
        l_out, thr, r, t_ride, t_ret, wait = parts(lam)
    else:
        throttles = True
        lo, hi = 0.0, lam
        for _ in range(_FIXED_POINT_STEPS):
            mid = (lo + hi) / 2.0
            if parts(mid)[0] > n_pool:
                hi = mid
            else:
                lo = mid
        l_out, thr, r, t_ride, t_ret, wait = parts((lo + hi) / 2.0)
    in_use_avg = min(l_out, float(n_pool))
    # The peak the KPI reports is TRUNCATED at the pool size — that is the ceiling
    # being hit, not the answer (invariant 17). So report BOTH: what this pool will
    # be seen to use, and what a pool that never binds would have needed.
    want = peak_estimate(x_free, r_free, horizon_s, batch)
    required = peak_estimate(x_free, r_free, horizon_s, batch, risk=sizing_risk)
    binds = want > n_pool                     # ⇔ the engine logs a 投入待ち at all
    wait_mean = ((1.0 / thr - 1.0 / lam) if (throttles and thr > 0.0 and lam > thr)
                 else 0.0)
    return {
        "pool_size": n_pool,
        "residence_s": r,                     # ≙ kpis container_use_mean_s
        "ride_s": t_ride,
        "return_s": t_ret,
        "bench_wait_s": wait,
        "in_use_avg": in_use_avg,             # ≙ kpis containers_in_use_avg
        "in_use_peak": min(want, n_pool),     # ≙ kpis containers_in_use_peak
        "required_pool": required,            # ← 「レンタルは何個要るのか」
        "sizing_risk": float(sizing_risk),    # ...and how sure that number is
        "capacity_per_hr": n_pool / r * 3600.0 if r > 0 else None,   # X_max = N/R
        "binds": bool(binds),                 # some 投入 waits
        "throttles": bool(throttles),         # ...enough to cost throughput
        "utilization": min(in_use_avg / n_pool, 1.0) if n_pool else 0.0,
        "take_wait_mean_s": wait_mean,
        "offered_per_hr": lam * 3600.0,
        "throughput_per_hr": thr * 3600.0,
        "batch": max(1.0, float(batch)),
    }
