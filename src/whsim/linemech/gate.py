"""選択停止ゲート (停止線) を閉形式で — the analytic mirror of the engine's
``Conveyor.stop_gate`` / ``Conveyor.load_kind`` mechanism.

Pure, sim-free, no simpy/numpy: a few hundred arithmetic ops, so the estimate
stays 爆速 for drag-time re-estimation, exactly like the rest of ``analytic``.

WHY THIS MODULE EXISTS (invariant 5)
------------------------------------
The engine can put a 停止線 on a belt (``engine.build.StopGate``): loads carry a
種別 stamped by the belt they boarded, and the gate stops some kinds and passes
the rest. For a STOPPED kind the belt effectively **ends at the gate** — it cannot
ride past, junctions beyond the gate are invisible to it, it never hands over to
``next_line``, and it holds its slot until the 梱包台 standing AT the stop line
takes it off. ``analytic._conveyor_estimate`` knows none of that: it prices one
homogeneous load riding to the end of the chain into the pooled 梱包台. On the
bundled gate model it therefore reads a 25% block ratio as 0.05% and a 122/hr line
as 300/hr — the oracle telling a rosier story than the run, which is the exact
failure invariant 5 forbids.

THE DERIVATION
--------------
Write ``X`` for the line's total throughput (totes/s) and ``s_k`` for the share of
hand-overs carrying kind ``k``, so ``X_k = s_k·X``.

* **Where the mix comes from.** There is no "kind mix" field in the schema, and
  there does not need to be: ``processes._board_conveyor`` hands the totes to the
  Manhattan-nearest ENTRY belt, and ``Conveyor.load_kind`` of that belt is the
  kind. So the mix is a property of the DRAWING (which belt is nearest which pick
  face) weighted by ``Item.pick_freq`` — see :func:`kind_shares`. What the schema
  cannot express is a mix that varies over time, or a kind that changes identity
  mid-line; either would need a new field.

* **Service.** A stopped kind is taken off the line by the benches standing at the
  gate, a passing kind by whatever pool ends its route, and a kind that passes a
  引き込み may be taken by that spur instead. Each pool ``p`` has ``c_p`` benches at
  ``pack`` seconds, and a kind may be served by any pool on its route — a bipartite
  flow problem whose max-flow bound is Hall's condition over subsets ``S`` of
  pools::

      Σ_{k: pools(k) ⊆ S} s_k · X  ≤  (Σ_{p∈S} c_p) / pack

* **Accumulation.** A tote holds a slot on every belt it rides and holds the LAST
  one through packing (``processes._convey_chain`` releases the slot after
  ``pack_done``). Little's law on belt ``b``, whose slot pool is ``K_b``::

      Σ_k s_k · H_kb · X  ≤  K_b        H_kb = ride_kb + pack·(b is k's terminal)

  This is the term the gate turns on: a stopped tote's ``ride`` stops at the gate
  arc but it then holds that slot through the queue AND the packing, so the belt
  fills from the stop line backwards.

* **Transport.** Unchanged from ``analytic``: ``speed/tote_pitch`` per belt, over
  the kinds that actually ride it.

``capacity_line`` is the smallest of those bounds — the classic product-mix
bottleneck. Note what it does NOT reduce to: with one gated kind at share ``s_s``
the line's ceiling is ``c_gate/(pack·s_s)``, i.e. **the passing kind is throttled
too**, because a queue of stopped totes standing at the stop line occupies the
shared trunk slots the passing totes need. Charging the gate benches only against
the stopped flow would miss that entirely.

The DES reaches 86–108% of this fluid bound (median 98%); it cannot reach it
exactly because the benches idle whenever variability empties the buffer in front
of them. :data:`_FLUID_REALISATION` is that measured shortfall, and it is applied
ONLY where being optimistic would be unsafe (deciding whether the line jams and
how often a hand-over waits).

WHAT IS DELIBERATELY NOT MODELLED
---------------------------------
* ``Process.divert_policy == "pull"`` — a different mechanism, and its own module
  (:mod:`whsim.linemech.pull`), which ``analytic`` prefers when both are authored.
* The engine's slot pool is ``length/tote_pitch`` for the WHOLE belt even when a
  gate cuts it short, so a gate queue may occupy slots physically downstream of the
  stop line. This module mirrors the engine (``analytic.belt_slots``), not the
  floor; ``gate.pre_gate_slots`` reports what the physical bound would be if the
  engine ever makes its slot pool positional.

GATE-OFF IS INERT
-----------------
:func:`gate_line_estimate` returns ``None`` the moment no active belt resolves a
gate, and ``linemech.resolve_gate`` is a mirror of ``engine.build._resolve_gate``
(an unstated, malformed or names-nothing gate is not a gate). Since every bundled
template ships ``stop_gate=None`` on every belt, the caller keeps
``_conveyor_estimate``'s answer unchanged — no catalogue number can move.
"""

from __future__ import annotations

import math

from whsim import beltgeom
from whsim.analytic import (
    _belt_rate,
    _belt_stages,
    belt_length,
    belt_pitch,
    belt_slots,
    belt_speed,
)
from whsim.linemech import bench_ledger, gate_stops, junctions, resolve_gate

# How much of the fluid (deterministic) capacity the DES actually realises.
# Measured over the validation sweep: saturated throughput came in at 86–108% of
# the fluid bound, median 98%. A line offered within this margin of its fluid
# ceiling is a jammed line on the floor, so ``jams`` is decided against the
# derated figure while ``capacity_per_hr`` keeps reporting the honest bound.
_FLUID_REALISATION = 0.97

# Enumerating Hall subsets is 2^n; a line with more distinct 梱包台 pools than this
# falls back to the (weaker, still safe) singleton + all-pools bounds.
_MAX_POOLS_ENUMERATED = 8


# ================================================================ queueing kit

def mm1k_full(rho: float, k: float) -> float:
    """P(full) for one queue with ``k`` free positions in front of it.

    ``k`` is deliberately a FLOAT: the free room in front of a gate is a belt's
    slot count minus the totes standing in it in steady flow, which is not an
    integer. Defined for ``rho > 1`` too (it tends to ``1 − 1/rho``), so an
    over-fed line degrades smoothly instead of falling off a branch — and a line
    whose end nobody staffs (``rho`` infinite) reads 1: everything waits, which is
    what the run shows when the loads stop there for good.
    """
    k = max(float(k), 0.0)
    if rho <= 0.0:
        return 0.0
    if not math.isfinite(rho):
        return 1.0
    if abs(rho - 1.0) < 1e-9:
        return 1.0 / (k + 1.0)
    return (1.0 - rho) * rho ** k / (1.0 - rho ** (k + 1.0))


# ========================================================= the line, as a chain

def _pts(cv):
    return [(float(p[0]), float(p[1])) for p in (getattr(cv, "points", None) or [])
            if len(p) >= 2]


def resolve_line(model, line=None):
    """The chain ``engine.build`` builds, plus its gates. ``None`` = no belt in use.

    The belts, the hand-overs, the 引き込み and their 梱包台 are
    ``analytic._belt_stages``' answer — the SAME resolution ``engine.build`` runs,
    passed in when the caller already has it so the chain is resolved ONCE per
    estimate. What this adds is what only a gated line needs: which belt carries a
    停止線, whose hands stand at it, and where each 引き込み hangs off its host
    (``linemech.junctions``).
    """
    line = _belt_stages(model) if line is None else line
    if line is None:
        return None
    ledger = bench_ledger(model, line)
    gates = {}
    for cv in line["belts"]:
        g = resolve_gate(cv)
        if g is not None:
            gates[str(cv.id)] = g
    junc: dict[str, list] = {}
    for j in junctions(model, line, ledger):
        junc.setdefault(j["host"], []).append((j["arc"], j["spur"], j["feed_arc"]))
    return {"belts": line["belts"], "by_id": line["by_id"], "entries": line["entries"],
            "spurs": line["spurs"], "spur_ids": line["spur_ids"], "succ": line["succ"],
            "junc": junc, "gates": gates, "gate_bench": ledger["gates"],
            "bench": ledger["benches"], "n_stations": ledger["n_stations"],
            # ``processes._bench_pool``: what a belt end with no bench of its own
            # gets — the spare benches, the whole floor, or (every bench spoken
            # for) NOBODY, in which case the load stands there for good.
            "shared_n": ledger["fallback"]}


def kind_shares(model, line):
    """Share of hand-overs carrying each ``load_kind``, and where they board.

    The engine stamps the kind of the ENTRY belt the picker hands to
    (``processes._board_conveyor`` picks the Manhattan-nearest entry belt from the
    picker's last pick), so the mix is geometry × ``Item.pick_freq`` — there is no
    mix field in the schema and none is needed. A model with no locations splits
    evenly over the entry belts (never blocks).
    """
    entries = line["entries"]
    locs = list(getattr(model, "locations", None) or [])
    freq = {}
    for it in (getattr(model, "items", None) or []):
        if getattr(it, "default_location", None):
            freq[it.default_location] = max(
                float(getattr(it, "pick_freq", 1.0) or 0.0), 0.0)

    shares, arcs = {}, {}
    total = 0.0
    for loc in locs:
        w = freq.get(loc.id, 1.0)
        if w <= 0.0:
            continue
        p = (float(loc.x), float(loc.y))
        best = None
        for cv in entries:
            xy, arc = beltgeom.project(p, _pts(cv))
            d = abs(p[0] - xy[0]) + abs(p[1] - xy[1])      # the picker's own metric
            if best is None or d < best[0]:
                best = (d, cv, arc)
        k = str(getattr(best[1], "load_kind", "") or "")
        shares[k] = shares.get(k, 0.0) + w
        arcs.setdefault(str(best[1].id), []).append((best[2], w))
        total += w
    if total <= 0.0:
        n = float(len(entries)) or 1.0
        for cv in entries:
            k = str(getattr(cv, "load_kind", "") or "")
            shares[k] = shares.get(k, 0.0) + 1.0 / n
            arcs.setdefault(str(cv.id), []).append((0.0, 1.0 / n))
        return shares, arcs
    return {k: v / total for k, v in shares.items()}, arcs


def kind_routes(model, line, pack_s: float):
    """Per ``load_kind``: the belts it rides, the pools that can take it off the
    line, and — since a tote holds a slot until it is packed — how many seconds of
    slot it costs each belt.

    A kind that passes 引き込み on its way to the gate may be taken in by any of
    them (貪欲ディバート is work-conserving), so its flow SPLITS across the pools it
    can reach, in proportion to their 梱包台 count — the equilibrium a least-loaded
    greedy rule settles at. Charging every spur the whole flow instead priced a
    two-spur line as a one-spur line and cried jam on a healthy design.
    """
    shares, board = kind_shares(model, line)
    by_id, succ, junc, gates = line["by_id"], line["succ"], line["junc"], line["gates"]
    shared_n = line["shared_n"]

    def servers(n) -> int:
        """``bench_pools``' three answers → how many hands that pool really has.

        A real count is itself; ``UNSTAFFED`` (nobody drawn) borrows what
        ``processes._bench_pool`` would hand it — the spare benches, the whole
        floor, or **nobody at all** when every bench on the floor is already
        standing at a 引き込み or a 停止線. ``CLOSED``/``LOST`` never reach here: the
        caller drops those pull-ins entirely.
        """
        return n if (isinstance(n, int) and n > 0) else shared_n

    routes = {}
    for cv in line["entries"]:
        kind = str(getattr(cv, "load_kind", "") or "")
        if kind not in shares or kind in routes:
            continue
        arcs = board.get(str(cv.id), [(0.0, 1.0)])
        wsum = sum(w for _a, w in arcs) or 1.0
        arc = sum(a * w for a, w in arcs) / wsum      # mean boarding arc
        legs, exits, bid, hops = [], [], str(cv.id), 0
        while bid is not None and hops <= len(by_id):
            hops += 1
            belt = by_id[bid]
            g = gates.get(bid)
            # 停止線 only stops what PASSES it: a load that boarded (or handed over)
            # DOWNSTREAM of the gate is already past it and rides on
            # (``processes._convey_chain``'s ``gate.arc >= arc`` test). A gate AHEAD
            # of the load still truncates its junction window, so 引き込み beyond the
            # stop line stay unreachable — that part is not a bug.
            stopped = g is not None and gate_stops(g, kind) and g[0] >= arc - 1e-9
            end_arc = min(g[0], belt_length(belt)) if stopped else belt_length(belt)
            legs.append({"id": bid, "arc_in": arc, "end_arc": end_arc,
                         "speed": belt_speed(belt)})
            for j_arc, sid, feed_arc in junc.get(bid, []):   # 引き込み before the end
                if arc - 1e-9 <= j_arc <= end_arc + 1e-9:
                    n = line["bench"].get(sid)
                    if n in beltgeom.NO_HANDS:
                        continue                      # no hands ⇒ takes nothing
                    ride = max(belt_length(by_id[sid]) - feed_arc, 0.0)
                    exits.append({
                        "pool": f"spur:{sid}" if (isinstance(n, int) and n > 0) else "pool",
                        "servers": servers(n),
                        "leg": bid, "arc": j_arc, "belt": sid,
                        "ride": ride / belt_speed(by_id[sid])})
            if stopped:                               # 停止線 = the end of this belt
                n = line["gate_bench"].get(bid, 0)
                exits.append({"pool": f"gate:{bid}" if n > 0 else "pool",
                              "servers": servers(n),
                              "leg": bid, "arc": end_arc, "belt": None, "ride": 0.0})
                break
            nxt = succ.get(bid)
            if nxt is None:                           # the end of the chain
                n = line["bench"].get(bid)
                exits.append({
                    "pool": f"spur:{bid}" if (isinstance(n, int) and n > 0) else "pool",
                    "servers": servers(n),
                    "leg": bid, "arc": end_arc, "belt": None, "ride": 0.0})
                break
            bid, arc = nxt

        # 貪欲ディバート (``divert_policy == "auto"``, the default) never lets a load
        # PAST the last 引き込み on its route: a tote that finds every spur full
        # stalls AT the junction holding its 本線 slot and waits for one to free
        # (``processes._convey_chain``'s ``_divert_wake``). So when an open pull-in
        # stands on the route, the 停止線 downstream of it is unreachable and must
        # not be counted as capacity — measured: 0 ``conveyor_gate`` events on every
        # spur+gate run, and pricing the gate's benches into the bank read
        # packer_utilization 0.86 against a measured 0.60.
        # Under "pull" the load DOES ride past an unmanned pull-in, so both stay.
        if getattr(model.process, "divert_policy", "auto") != "pull":
            spur_exits = [e for e in exits if e["belt"] is not None]
            if spur_exits:
                exits = spur_exits

        cap_sum = float(sum(e["servers"] for e in exits))
        for e in exits:
            # No hands anywhere on this route ⇒ nothing leaves the line, and the
            # share arithmetic below must not invent a split. Zero flow, zero hold:
            # the pool bound alone (capacity 0) then carries the answer.
            e["f"] = (e["servers"] / cap_sum) if cap_sum > 0.0 else 0.0

        order = [x["id"] for x in legs]
        hold, riders = {}, {}
        for i, leg in enumerate(legs):
            down = [e for e in exits if order.index(e["leg"]) >= i]
            secs = 0.0
            for e in down:
                out = e["arc"] if e["leg"] == leg["id"] else leg["end_arc"]
                secs += e["f"] * max(out - leg["arc_in"], 0.0) / leg["speed"]
                if e["leg"] == leg["id"] and e["belt"] is None:
                    secs += e["f"] * pack_s           # packs while holding this slot
            hold[leg["id"]] = hold.get(leg["id"], 0.0) + secs
            riders[leg["id"]] = riders.get(leg["id"], 0.0) + sum(e["f"] for e in down)
        for e in exits:
            if e["belt"] is not None:                 # 引き込み: ride + pack, on it
                hold[e["belt"]] = hold.get(e["belt"], 0.0) + e["f"] * (e["ride"] + pack_s)
                riders[e["belt"]] = riders.get(e["belt"], 0.0) + e["f"]

        routes[kind] = {"share": shares[kind], "legs": legs, "exits": exits,
                        "hold": hold, "riders": riders}
    return routes, line["n_stations"]


# ============================================================== the closed form

def gate_line_estimate(model, lam: float, n_stations: int, pack_time_s: float,
                       horizon_s: float, line=None) -> dict | None:
    """選択停止ゲートのある搬送ラインの閉形式. ``None`` when no belt carries a gate.

    Parameters mirror ``analytic._conveyor_estimate`` so a caller can simply prefer
    this answer whenever it is not ``None``:

    * ``lam``          — totes offered per second (1 order = 1 tote, the engine's
      own rule: ``processes`` hands the belt one tote per order in the batch).
    * ``n_stations``   — 梱包台 total (``engine.build``'s ``n_packers``: EVERY
      station, including the ones standing at the gate — the engine's shared pool
      is sized from all of them, so the mirror must be too).
    * ``pack_time_s``  — ``Process.pack_time_s``.
    * ``horizon_s``    — ``Simulation.duration_s``; only ``block_ratio_est`` uses it.
    * ``line``         — ``analytic._belt_stages(model)`` when the caller has it.

    Returns the same keys ``_conveyor_estimate`` returns (so it is a drop-in for the
    ``conveyor`` block) plus an additive ``gate`` sub-dict.
    """
    line = resolve_line(model, line)
    if line is None or not line["gates"]:
        return None                     # no gate ⇒ this module is not in play
    pack = max(float(pack_time_s), 0.0) or 1e-9
    routes, n_st = kind_routes(model, line, pack)
    if not routes:
        return None
    n_stations = int(n_stations) or n_st
    by_id = line["by_id"]
    kinds = sorted(routes)
    share = {k: routes[k]["share"] for k in kinds}

    cons = []                           # (capacity totes/s, label, belt hosting it)

    # (1) 梱包台 — Hall's condition over subsets of pools. A kind that can only be
    #     taken off at ONE pull-in is bound by that pool alone; kinds that can use
    #     several are bound by their union.
    pools = {}
    for k in kinds:
        for e in routes[k]["exits"]:
            pools[e["pool"]] = (e["servers"], e["leg"])
    ids = sorted(pools)
    if len(ids) <= _MAX_POOLS_ENUMERATED:
        masks = range(1, 1 << len(ids))
    else:                               # too many to enumerate: singletons + all
        masks = [1 << i for i in range(len(ids))] + [(1 << len(ids)) - 1]
    for mask in masks:
        sub = {ids[i] for i in range(len(ids)) if mask >> i & 1}
        served = [k for k in kinds if {e["pool"] for e in routes[k]["exits"]} <= sub]
        s_sum = sum(share[k] for k in served)
        if s_sum <= 0.0:
            continue
        c_sum = sum(pools[p][0] for p in sub)
        # Name the pool(s), not just "pack": a proposal has to be told that it is
        # the STOP LINE that binds, not "packing somewhere". Only a line with
        # several distinct pools gets the generic label for their union.
        label = ("pack" if (len(sub) == len(ids) and len(ids) > 1)
                 else "+".join(sorted(sub)))
        cons.append(((c_sum / pack) / s_sum, label, pools[min(sub)][1]))

    # (2) 蓄積 — a tote holds a slot on every belt it rides and holds the LAST one
    #     through packing. This is the term the 停止線 turns on.
    used = sorted({b for k in kinds for b in routes[k]["hold"]})
    for b in used:
        denom = sum(share[k] * routes[k]["hold"].get(b, 0.0) for k in kinds)
        if denom > 0.0:
            cons.append((belt_slots(by_id[b]) / denom, f"accum:{b}", b))

    # (3) 搬送能力 — speed / tote pitch, over the kinds that ride that belt.
    for b in used:
        s_sum = sum(share[k] * routes[k]["riders"].get(b, 0.0) for k in kinds)
        if s_sum > 0.0:
            cons.append((_belt_rate(by_id[b]) / s_sum, f"belt:{b}", b))

    cap, binding, bind_belt = min(cons, key=lambda c: (c[0], c[1]))
    cap_eff = cap * _FLUID_REALISATION

    # ---- the buffer in front of the constraint --------------------------------
    # Everything from the picker's hand-off up to and including the constraint, as
    # ``_conveyor_estimate`` reports it...
    upstream = set()
    for k in kinds:
        seen = []
        for leg in routes[k]["legs"]:
            seen.append(leg["id"])
            if leg["id"] == bind_belt:
                break
        upstream |= set(seen)
    buffer_slots = sum(belt_slots(by_id[b]) for b in upstream) or 1
    # ...but with a gate the belt does NOT start empty: the steady flow already
    # stands in it, and only what is LEFT is room for the queue to grow into. That
    # free room is what decides both how fast the jam arrives and how often a
    # hand-over waits, and it is why two lines at the same ρ block 0.15 and 0.64.
    x_f = min(lam, cap)
    occ = x_f * sum(share[k] * routes[k]["hold"].get(bind_belt, 0.0) for k in kinds)
    free_slots = max(belt_slots(by_id[bind_belt]) - occ, 0.0)

    # ---- does it jam, and how often does a hand-over wait? ---------------------
    rho = (lam / cap_eff) if cap_eff > 0.0 else float("inf")
    steady = mm1k_full(rho, free_slots)
    jams = bool(lam > cap_eff)
    ttj = jam_ratio = None
    if jams:
        ttj = free_slots / (lam - cap_eff)
        span = max(float(horizon_s), 0.0) - ttj
        if span > 0.0:
            blocked = cap_eff * span
            total = lam * ttj + blocked
            jam_ratio = (blocked / total) if total > 0.0 else 1.0
    ratio = min(max(steady, jam_ratio or 0.0), 1.0)

    stopped = [k for k in kinds
               if any(gate_stops(g, k) for g in line["gates"].values())]
    gate_c = sum(line["gate_bench"].values())
    return {
        "jams": jams,
        "time_to_jam_s": ttj,
        "capacity_per_hr": cap * 3600.0 if math.isfinite(cap) else None,
        "binding": binding,
        "block_ratio_est": ratio,
        "buffer_slots": buffer_slots,
        "offered_per_hr": lam * 3600.0,
        # ---- additive 停止線 read-outs ---------------------------------------
        "gate": {
            "kind_share": share,
            "stop_share": sum(share[k] for k in stopped),
            "bench_at_gate": gate_c,
            "gate_capacity_per_hr": (gate_c / pack) * 3600.0 if gate_c else None,
            "throughput_per_hr": min(lam, cap) * 3600.0,
            "free_slots": free_slots,
            # 末端に人が居ない: every bench on the floor stands at a 引き込み or a
            # 停止線, so a load that reaches an ordinary belt end has nobody to take
            # it off and stops there for good (``processes`` logs ``pack_unmanned``).
            "end_unmanned": line["shared_n"] == 0,
            # what the buffer WOULD be if the engine's slot pool were positional
            # (it is not: build sizes it from the whole belt). Reported, not used.
            "pre_gate_slots": {b: int(g[0] / belt_pitch(by_id[b]))
                               for b, g in line["gates"].items()},
        },
    }
