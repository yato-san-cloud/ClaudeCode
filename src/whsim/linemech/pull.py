"""引き込み方式 (``Process.divert_policy``) の閉形式 — the analytic mirror of
``engine.processes._convey_chain``'s junction rule.

Why this module exists (不変条件5 / 不変条件17)
-----------------------------------------------
The DES has two rules at a 引き込み junction and ``analytic.py`` only ever knew
one of them:

* **auto (貪欲ディバート, the default)** — a load turns into any spur that has
  SLOT room, and if none has room it STALLS on the 本線 holding its slot until one
  frees up. Work-conserving, and *blind to staffing*: the load enters whether or
  not anybody is standing there, and queues on the belt. Cutting the 梱包台 per
  引き込み from 3 to 1 leaves 引き込み量 at 74 → 74.
* **pull (作業者が引く)** — a load is taken in only where a bench is FREE as it
  passes, and where none is it does **not wait**: it rides past to the 停止線/末端.
  Same cut: 73 → 38.

So under "pull" a 引き込み is a **LOSS system, not a queue** — it has no waiting
room at the decision moment. That single structural change is what this module
prices, together with what it implies:

1. one junction = one Erlang-B group on Σ benches (the engine offers a load to
   every spur at that arc at once — full accessibility, and with per-spur bench
   limits "some spur has a free bench" is false exactly when Σbusy = Σc, so the
   junction blocks as one group);
2. what junction *j* turns away is **offered to junction j+1** — a classic
   overflow cascade, and overflow traffic is *not Poisson*, it is peaked, so the
   downstream groups block more than an independent thinning would say (handled
   with Riordan's moments + Hayward's equivalent group; measured below);
3. what survives every junction is packed at the 停止線/末端 — a QUEUE, whose
   waiting room is the 本線 itself, which is why a short 本線 throttles the whole
   line and is the only way "pull" can jam at all;
4. the trunk's junction-stall blocking **collapses to zero** (a load never waits
   at a junction), so ``conveyor_block_ratio`` under pull comes only from the
   serial hand-overs.

Pure arithmetic — no simpy, no graph search, O(#junctions + #slots) — so the
estimate stays 爆速 for drag-time re-estimation, exactly like the rest of
``analytic.py``.

⚠️ The ``auto`` path is NOT routed through here: ``analytic._steady_block`` keeps
it byte-for-byte, and every shipped template is ``auto`` — so the catalogue is
unaffected (checked by digest over all 10). ``_steady_block`` is itself
optimistic for auto in the band ρ_bank 0.85–1.4 (measured worst −0.73 against
the run); that is a separate hole and it is NOT closed here.
"""

from __future__ import annotations

import math

from whsim.analytic import _belt_stages, belt_length, belt_slots, belt_speed
from whsim.linemech import bench_ledger, junctions as resolve_junctions, resolve_gate

# ---------------------------------------------------------------- 待ち行列の部品


def erlang_b(c: float, a: float) -> float:
    """Erlang-B loss probability: c servers, a erlangs offered, NO waiting room.

    Integer ``c`` uses the exact O(c) recursion ``B_n = a·B_{n-1}/(n + a·B_{n-1})``
    — overflow-free, which the literal ``a^c/c!`` form is not once a line carries
    a few dozen benches. Fractional ``c`` (Hayward's equivalent group is not an
    integer) interpolates between its neighbours; the exact continued-fraction
    extension needs an incomplete gamma and this module is on the live path.

    Insensitive to the service-time distribution (Erlang's own result), which
    matters here: ``pack_time_s`` is DETERMINISTIC in the engine.
    """
    if a <= 0.0:
        return 0.0
    if c <= 0.0:
        return 1.0
    lo = math.floor(c)
    frac = c - lo

    def _b(n: int) -> float:
        b = 1.0
        for i in range(1, n + 1):
            b = a * b / (i + a * b)
        return b

    b_lo = _b(lo)
    return b_lo if frac <= 1e-12 else b_lo + frac * (_b(lo + 1) - b_lo)


def erlang_c(c: float, a: float) -> float:
    """P(an arrival has to WAIT) — c servers, a erlangs, unbounded queue."""
    if a <= 0.0:
        return 0.0
    if c <= 0.0 or a >= c:
        return 1.0
    b = erlang_b(c, a)
    den = 1.0 - (a / c) * (1.0 - b)
    return 1.0 if den <= 1e-12 else min(1.0, b / den)


def mmck(c: int, a: float, k: int) -> tuple[float, float]:
    """``(P(full), mean queue wait ÷ service time)`` for M/M/c/(c+k).

    Same ratio recursion ``analytic._mmck_full`` uses (no factorials, no scipy),
    extended with ``Lq`` so the wait is finite even at ρ ≥ 1 — the 本線 is a
    finite buffer, so "the wait is infinite" is never the physical answer.
    """
    c = max(int(c), 1)
    k = max(int(k), 0)
    if a <= 0.0:
        return 0.0, 0.0
    r = tot = 1.0
    last = 1.0
    lq = 0.0
    for n in range(1, c + k + 1):
        r *= (a / n) if n <= c else (a / c)
        tot += r
        last = r
        if n > c:
            lq += (n - c) * r
        if tot > 1e290:
            r /= 1e100
            tot /= 1e100
            lq /= 1e100
            last /= 1e100
    p_full = last / tot
    lq /= tot
    served = a * (1.0 - p_full)
    return p_full, (lq / served if served > 1e-12 else 0.0)


def _overflow_moments(c: float, a: float, b: float) -> tuple[float, float]:
    """Riordan: mean & variance of the traffic OVERFLOWING an Erlang-B group.

    ``var > mean`` (peaked) is the whole point: the loads a 引き込み turns away
    arrive at the next one in bursts — precisely when the first one is full — so
    treating them as a fresh Poisson stream understates how often the next one is
    full too.
    """
    mean = a * b
    den = c + 1.0 - a + mean
    var = mean * (1.0 - mean + (a / den if den > 1e-9 else 50.0))
    return mean, max(var, mean * 1e-9)


# -------------------------------------------------------------- 引き込みカスケード


def divert_cascade(junctions, lam: float, pack_time_s: float,
                   *, peaked: bool = True) -> tuple[float, float, list[dict]]:
    """引き込み量 under **pull**: ``(taken/s, overflow/s, per-junction)``.

    ``junctions`` is a list of dicts in ARC ORDER along the 本線, each
    ``{"benches": int, "slots": int, "tau_s": float}`` — the benches and the belt
    slots of every 引き込み hanging at that arc (both sides of the same junction
    are ONE group), and the spur's own transit time.

    Two admission tests, both of which the engine applies (``_belt_room`` and
    ``_bench_free``), so the junction blocks on whichever binds:

    * **台** — c benches held for ``pack_time_s`` each ⇒ ``erlang_b(c, λ·T)``;
    * **スロット** — K slots each held from the turn-in until packing ENDS
      (``line.belt.release`` happens after ``pack_time``) ⇒
      ``erlang_b(K, λ·(T + τ))``.

    In every drawn line the benches bind (a 引き込み is metres long, benches are a
    handful); the slot term only wakes up on a degenerate 1–2-slot spur.
    """
    T = max(float(pack_time_s), 0.0)
    offered = max(float(lam), 0.0)
    var = offered                       # Poisson to the first junction ⇒ z = 1
    taken = 0.0
    per: list[dict] = []
    for j in junctions:
        c = float(j.get("benches", 0) or 0)
        K = float(j.get("slots", 0) or 0)
        tau = float(j.get("tau_s", 0.0) or 0.0)
        if c <= 0.0:
            # 無人の引き込み takes nothing — and ``engine.build`` does not even wire
            # its junction (``ConveyorLine.closed``). Pass everything on.
            per.append({"offered_per_s": offered, "block": 1.0,
                        "taken_per_s": 0.0, "utilization": 0.0})
            continue
        z = max(var / offered, 1.0) if (peaked and offered > 0.0) else 1.0
        b = max(erlang_b(c / z, offered * T / z),
                erlang_b(K, offered * (T + tau)) if K > 0 else 1.0)
        b = min(max(b, 0.0), 1.0)
        got = offered * (1.0 - b)
        taken += got
        per.append({"offered_per_s": offered, "block": b, "taken_per_s": got,
                    "utilization": got * T / c})
        _m, v = _overflow_moments(c / z, offered * T / z, b)
        offered, var = offered * b, (v * z / T if T > 0 else 0.0)
    return taken, offered, per


# --------------------------------------------------------------------- ライン全体


def solve_pull(
    junctions,
    *,
    lam: float,
    pack_time_s: float,
    end_servers: int,
    end_slots: int,
    trunk_transit_s: float,
    junction_arc_s=None,
    entry_slots: int = 0,
    entry_transit_s: float = 0.0,
    n_packers: int = 1,
    horizon_s: float = 0.0,
    peaked: bool = True,
) -> dict:
    """The whole 引き込みライン under ``divert_policy == "pull"``, in closed form.

    Parameters
    ----------
    junctions
        ``[{"benches": int, "slots": int, "tau_s": float}, …]`` in arc order.
    lam
        Totes/second offered to the line (1 order = 1 tote, the engine's rule).
    end_servers, end_slots
        Who takes the loads NOBODY pulled in, and the buffer in front of them:
        the 停止線's benches, else ``World.spare_bench`` (the benches nobody
        claimed), else — when every bench is spoken for, which is the NORMAL
        drawing — **nobody at all**: the load stops there for good
        (``processes.pack_unmanned``) and the 本線 fills up behind it. ``0`` says
        that, and it is not an edge case to smooth over: it is why a pull line
        needs somebody drawn at its 停止線. ``end_slots`` is the 本線's own slot
        count.
    junction_arc_s
        Seconds of 本線 ride to each junction (defaults to an even spread).
    horizon_s
        ``simulation.duration_s`` — a line over the end pool's capacity jams
        after ``time_to_jam_s``, and a jam that lands after the horizon is not a
        jam the run will show.
    """
    T = max(float(pack_time_s), 0.0)
    lam = max(float(lam), 0.0)
    K_T = max(int(end_slots), 1)
    K_E = max(int(entry_slots), 0)
    c_end = max(int(end_servers), 0)
    c_bank = sum(max(int(j.get("benches", 0) or 0), 0) for j in junctions)
    cap_end = (c_end / T) if T > 0 else float("inf")
    if junction_arc_s is None:
        n = max(len(junctions), 1)
        junction_arc_s = [trunk_transit_s * (i + 1) / (n + 1) for i in range(n)]

    def state(x: float):
        taken, ovf, per = divert_cascade(junctions, x, T, peaked=peaked)
        share = (lambda v: v / x) if x > 0 else (lambda v: 0.0)
        # 本線 dwell: a load holds one 本線 slot until it turns off at its junction,
        # or — if nobody pulled it in — all the way to the end AND through the
        # wait + pack there. That is why a short 本線 is a capacity, not a detail.
        ride = sum(share(p["taken_per_s"]) * a
                   for p, a in zip(per, junction_arc_s))
        ride += share(ovf) * trunk_transit_s
        room = max(0, K_T - int(x * ride))
        _pf, wq_n = mmck(c_end, ovf * T, room) if c_end else (1.0, 0.0)
        wq_end = wq_n * T
        return taken, ovf, per, ride + share(ovf) * (wq_end + T), wq_end, ride

    # 本線 slot throttle: K_T slots each held for w_t, and w_t GROWS with the load
    # (the un-pulled loads wait longer at the end), so the fixed point is bisected
    # — plain iteration flips between the free and the jammed regime forever.
    hi = lam
    _t, _o, _p, w_hi, _w, _r = state(hi) if hi > 0 else (0.0, 0.0, [], 1.0, 0.0, 0.0)
    if hi <= 0.0 or hi <= K_T / max(w_hi, 1e-9):
        lam_eff = hi
    else:
        lo = 0.0
        for _ in range(60):
            mid = 0.5 * (lo + hi)
            _t, _o, _p, w_m, _w, _r = state(mid)
            if mid <= K_T / max(w_m, 1e-9):
                lo = mid
            else:
                hi = mid
        lam_eff = lo
    taken, ovf, per, w_t, wq_end, ride = state(lam_eff)
    d_share = taken / lam_eff if lam_eff > 0 else 0.0

    # 詰まり. Over the end pool's capacity the 本線 fills for good and the jam walks
    # BACK to the picker: a transient, priced over the horizon exactly like
    # ``analytic._conveyor_estimate``'s ``time_to_jam``. Under capacity the belt
    # still blocks now and then — Erlang-C on the SLOTS, whose "service time" is
    # the dwell above (one load holds one slot for its whole stay).
    ovf0 = divert_cascade(junctions, lam, T, peaked=peaked)[1]
    jams = ovf0 > cap_end + 1e-12
    ttj = (max(K_T - lam * ride, 1.0) / (ovf0 - cap_end)) if jams else None
    if jams and horizon_s > 0.0 and ttj is not None and ttj < horizon_s:
        span = horizon_s - ttj
        board = lam * ttj + (cap_end + taken) * span
        p_trunk = p_entry = ((cap_end + taken) * span / board) if board > 0 else 1.0
    else:
        l_t = lam_eff * w_t
        p_trunk = erlang_c(K_T, l_t)
        if l_t >= K_T:
            # 本線 itself is the constraint: the back-pressure reaches the picker,
            # so it waits at the 検品ライン as often as the hand-over waits.
            p_entry = p_trunk if K_E else 0.0
        else:
            wq_t = p_trunk * w_t / (K_T - l_t)
            p_entry = erlang_c(K_E, lam_eff * (entry_transit_s + wq_t)) if K_E else 0.0

    # conveyor_block_ratio is per BOARDING (``kpis``' own definition): a load logs
    # one conveyor_on per belt it rides — the entrance, the hand-over to the 本線,
    # and the 引き込み only if it was pulled in. Under pull the junction leg NEVER
    # waits, which is exactly why this collapses next to 貪欲ディバート.
    legs = (2.0 if K_E else 1.0) + d_share
    block = min(max((p_entry + p_trunk) / legs, 0.0), 1.0) if legs > 0 else 0.0
    capacity = min((c_bank + c_end) / T if T > 0 else float("inf"),
                   K_T / max(w_t, 1e-9))
    end_served = min(ovf, cap_end)
    return {
        "policy": "pull",
        # 引き込み量 — the number the mechanism exists to say out loud.
        "divert_share": d_share,
        "diverted_per_s": taken,
        "overflow_per_s": ovf,
        "spurs": per,
        # 末端 (停止線/共有プール)
        "end_wait_s": wq_end,
        "end_utilization": min(ovf * T / c_end, 1.0) if c_end else 0.0,
        # 本線
        "trunk_dwell_s": w_t,
        "trunk_load_slots": lam_eff * w_t,
        "p_trunk_wait": p_trunk,
        "p_entry_wait": p_entry,
        # ...in the vocabulary analytic._conveyor_estimate already speaks
        "jams": bool(jams),
        "time_to_jam_s": ttj,
        "block_ratio_est": block,
        "capacity_per_hr": capacity * 3600.0 if math.isfinite(capacity) else None,
        "throughput_per_s": min(lam, capacity),
        "packer_utilization": (taken + end_served) * T / max(int(n_packers), 1),
        "legs_per_tote": legs,
    }


# ------------------------------------------------------------------ 図面 → 引き込みバンク


def _pts(cv):
    return [(float(p[0]), float(p[1])) for p in cv.points if len(p) >= 2]


def _len(pts):
    return sum(math.dist(pts[i - 1], pts[i]) for i in range(1, len(pts)))


def _speed(cv):
    s = float(getattr(cv, "speed_mps", 0.0) or 0.0)
    return s if s > 0 else 0.5


def resolve(model, line=None):
    """図面 → the 引き込みバンク this closed form prices. ``None`` = no bank.

    ``line`` is ``analytic._belt_stages(model)`` when the caller already has it
    (it always does — that is where the 引き込み come from), so the belt chain is
    resolved ONCE per estimate rather than twice.

    Everything except the junction ARC is re-used, never re-derived (不変条件11):
    ``analytic._belt_stages`` already says which belts are in use, which are
    引き込み and how many 梱包台 each owns (it calls ``beltgeom.bench_pools``
    with ``both=`` for 無動力の両端引き), and ``beltgeom.feed_point`` says where
    each spur is fed from. The arc is the one thing nothing computes today, and
    it is what turns a bag of spurs into an ORDERED overflow cascade.

    Three rules of the engine are mirrored here and each one changes the answer:

    * **Under pull only a spur with its OWN 梱包台 is a lane.** ``_bench_free``
      returns False outright when ``line.bench is None``, so a 引き込み nobody is
      drawn at takes nothing — and ``beltgeom.NO_HANDS`` (CLOSED / LOST) is not
      even wired to the trunk. Counting any of them as a lane sells capacity the
      floor has no people for.
    * **A load boards its 引き込み at ``feed_arc``**, not at the far end: a spur
      drawn as ONE belt crossing the 本線 is met in the middle. The transit that
      the slot-holding test needs is therefore the arc that is LEFT.
    * **末端 (the loads nobody pulled in) borrow ``World.spare_bench``** — the
      benches no 引き込み and no 停止線 claimed — and only when there is nothing
      spare do they fall back to the whole ``packers`` floor. That last branch
      double-books the private benches of the pull-ins already working them, and
      it is still live for every drawing whose stations all stand at 引き込み.
    """
    line = _belt_stages(model) if line is None else line
    if line is None or not line.get("spurs"):
        return None
    spurs = line["spurs"]
    benches = line.get("benches") or {}
    belts = [(str(cv.id), _pts(cv)) for st in line["stages"] for cv in st]
    spur_ids = {str(cv.id) for cv in spurs}
    stations = list(getattr(model.resources, "stations", None) or [])

    junc: dict[tuple[str, float], dict] = {}
    for cv in spurs:
        n = benches.get(str(cv.id), UNSTAFFED)
        if not (isinstance(n, int) and n > 0):
            continue                       # CLOSED / LOST / UNSTAFFED: not a lane
        hit = feed_point(_pts(cv), belts, exclude=spur_ids)
        if hit is None:
            continue                       # fed by nothing: a dead belt
        host, host_arc, feed_arc = hit
        j = junc.setdefault((host, round(host_arc, 3)),
                            {"benches": 0, "slots": 0, "arc": host_arc,
                             "spur_ids": [], "tau": []})
        j["benches"] += int(n)
        j["slots"] += belt_slots(cv)
        j["tau"].append(max(_len(_pts(cv)) - feed_arc, 0.0) / _speed(cv))
        j["spur_ids"].append(str(cv.id))
    if not junc:
        return None

    by_host: dict[str, list] = {}
    for (host, _a), j in junc.items():
        by_host.setdefault(host, []).append(j)
    tid = max(by_host, key=lambda h: (len(by_host[h]),
                                      sum(x["benches"] for x in by_host[h])))
    js = sorted(by_host[tid], key=lambda x: x["arc"])
    trunk = next(cv for st in line["stages"] for cv in st if str(cv.id) == tid)
    v = _speed(trunk)
    tpts = _pts(trunk)

    # 末端の手 — ``processes._bench_pool`` on the 本線, exactly.
    n_packers = sum(max(0, int(s.count)) for s in stations) or 1
    _pools, claimed_i = bench_pools(
        [(str(cv.id), _pts(cv)) for cv in spurs], belts,
        [(s.x, s.y, s.count) for s in stations],
        both={str(cv.id) for cv in spurs
              if getattr(cv, "discharge_both", False)})
    claimed = set(claimed_i)
    spare = sum(max(0, int(s.count)) for i, s in enumerate(stations)
                if i not in claimed)
    end_srv = spare if 0 < spare < n_packers else n_packers
    end_double_books = not (0 < spare < n_packers)

    entry = list(line["stages"][0]) if line["stages"] else []
    return {
        "junctions": [{"benches": j["benches"], "slots": j["slots"],
                       "tau_s": (sum(j["tau"]) / len(j["tau"])) if j["tau"] else 0.0,
                       "spur_ids": j["spur_ids"]} for j in js],
        "junction_arc_s": [j["arc"] / v for j in js],
        "end_servers": end_srv,
        "end_double_books": end_double_books,
        "spare_benches": spare,
        "end_slots": belt_slots(trunk),
        "trunk_transit_s": _len(tpts) / v,
        "entry_slots": sum(belt_slots(cv) for cv in entry),
        "entry_transit_s": (max(_len(_pts(cv)) / _speed(cv) for cv in entry)
                            if entry else 0.0),
        "n_packers": n_packers,
        "trunk_id": tid,
    }


# ------------------------------------------------------------------ 解析への接続

def estimate(model, line, lam: float, n_packers: int, pack_time_s: float,
             horizon_s: float) -> dict | None:
    """Drop-in for the 引き込み branch of ``analytic._conveyor_estimate``.

    ``None`` = this model has no 引き込みバンク to price, which leaves the caller
    on exactly the path it is on today.
    """
    bank = resolve(model, line)
    if bank is None:
        return None
    out = solve_pull(
        bank["junctions"], lam=lam, pack_time_s=pack_time_s,
        end_servers=bank["end_servers"], end_slots=bank["end_slots"],
        trunk_transit_s=bank["trunk_transit_s"],
        junction_arc_s=bank["junction_arc_s"],
        entry_slots=bank["entry_slots"], entry_transit_s=bank["entry_transit_s"],
        n_packers=n_packers or bank["n_packers"], horizon_s=horizon_s)
    # 末端が床全体を借りている ⇒ the capacity and the 梱包稼働率 below are the
    # ENGINE's, and the engine is double-booking. Say so rather than hiding it.
    out["end_double_books"] = bank["end_double_books"]
    out["spare_benches"] = bank["spare_benches"]
    return out
