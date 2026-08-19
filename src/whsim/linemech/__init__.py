"""ライン運用の3機構を解析側に鏡写しする層 (不変条件17).

`Conveyor.stop_gate` (選択停止), `Process.container_pool` (有限容器循環) and
`Process.divert_policy == "pull"` (人が引く引き込み) are the three things a drawing
cannot say. The engine has had them since they were authored; ``analytic.py`` did
not, so a model that switched one ON got a **rosier** number from the instant
estimate than from the DES run meant to confirm it — the one direction invariant 5
forbids. One module per mechanism:

* :mod:`whsim.linemech.gate`      — 選択停止ゲート
* :mod:`whsim.linemech.container` — 容器の有限循環
* :mod:`whsim.linemech.pull`      — pull型引き込み

**All three are imported lazily, from inside the branch that needs them**
(``analytic.estimate``), never at module import time: a model with none of the
three must not pay a millisecond, and ``analytic.estimate`` is pinned under 50 ms
because the editor re-estimates while the mouse is still down.

WHAT LIVES HERE
---------------
The facts all three need and the engine resolves once: whose 梱包台 is whose, and
where each 引き込み hangs off its 本線. Each mechanism used to carry its own copy —
three copies of a rule that had already drifted once between the engine and the
oracle (a real drawing: 4 benches in the run, 2 in the estimate). The chain itself
comes from ``analytic._belt_stages``, which is ``engine.build._wire_conveyor_chain``'s
own resolution; nothing here re-derives it.
"""

from __future__ import annotations

import math

from whsim import beltgeom

__all__ = ["bench_ledger", "gate_stops", "junctions", "resolve_gate"]


def resolve_gate(cv):
    """``Conveyor.stop_gate`` → ``(arc, stop_kinds, pass_kinds)`` or ``None``.

    Mirror of ``engine.build._resolve_gate``: an unstated, malformed, or
    names-nothing gate is not a gate (never-blocks — an existing model cannot
    acquire one by accident), and ``at_m`` is clamped to the belt's own length.
    """
    from whsim.analytic import belt_length

    spec = getattr(cv, "stop_gate", None)
    if not isinstance(spec, dict) or not spec:
        return None
    length = belt_length(cv)
    try:
        arc = float(spec.get("at_m", length))
    except (TypeError, ValueError):
        return None

    def kinds(key) -> frozenset[str]:
        v = spec.get(key)
        if isinstance(v, str):
            return frozenset({v}) if v else frozenset()
        if isinstance(v, (list, tuple, set, frozenset)):
            return frozenset(str(x) for x in v if str(x))
        return frozenset()

    stop, pas = kinds("stop_states"), kinds("pass_states")
    if not (stop or pas):
        return None
    return (min(max(arc, 0.0), length), stop, pas)


def gate_stops(gate, kind: str) -> bool:
    """The engine's three-valued selection (``build.StopGate.stops``).

    ``stop_states`` wins; else everything outside ``pass_states`` stops; else it is
    not a gate at all. Three-valued so a half-authored gate never blocks.
    """
    _arc, stop, pas = gate
    if stop:
        return kind in stop
    if pas:
        return kind not in pas
    return False


def _point_at(pts, arc: float):
    """``ConveyorLine.point_at``: the xy at arc length ``arc`` along a polyline."""
    left = max(arc, 0.0)
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        seg = math.dist(a, b)
        if left <= seg or seg <= 1e-12:
            t = 0.0 if seg <= 1e-12 else left / seg
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        left -= seg
    return pts[-1]


def _pts(cv):
    return [(float(p[0]), float(p[1])) for p in (getattr(cv, "points", None) or [])
            if len(p) >= 2]


def bench_ledger(model, line: dict) -> dict:
    """Who owns which 梱包台 — ``engine.build``'s ledger, and ``_bench_pool``'s answer.

    Every bench on the floor belongs to exactly one of three claims, and the
    difference is not bookkeeping — it decides how many servers each stage has:

    1. a 引き込み's own benches (``analytic._belt_stages`` → ``beltgeom.bench_pools``,
       nearest pull-in wins);
    2. a 停止線's own hands — whoever is left standing AT the gate. Benches a
       引き込み already owns are never counted twice (that double-count read
       packer_utilization 1.28);
    3. ``spare`` — the ones NOBODY claimed.

    ``fallback`` is what a belt end with no bench of its own gets, and it mirrors
    ``processes._bench_pool`` exactly, including the branch that was WRONG until
    the engine was fixed:

    * benches spare  ⇒ those benches (``World.spare_bench``);
    * nothing claimed ⇒ the whole floor (a line simply drawn without per-spur
      benches: everybody shares the pack pool — the historical never-blocks
      fallback);
    * every bench claimed and none spare ⇒ **0, i.e. nobody**. The load stops
      there (``pack_unmanned``) rather than being packed by the very people who
      are standing at a 引き込み — booking them twice measured
      packer_utilization 1.73 and let a pull line out-throughput the greedy one it
      is physically a subset of.

    ``benches`` comes back with the same closure ``build`` applies: with every
    bench spoken for, a pull-in nobody stands at has nobody at all (``CLOSED``).
    """
    stations = list(getattr(model.resources, "stations", None) or [])
    benches = dict(line.get("benches") or {})
    claimed = set(line.get("claimed") or ())

    gates: dict[str, int] = {}
    for cv in line["belts"]:
        g = resolve_gate(cv)
        if g is None:
            continue
        at = _point_at(_pts(cv), g[0])
        near = [i for i, st in enumerate(stations)
                if i not in claimed
                and math.dist((float(st.x), float(st.y)), at) <= beltgeom.BENCH_REACH_M]
        n = sum(max(0, int(stations[i].count)) for i in near)
        gates[str(cv.id)] = n
        if n > 0:
            claimed.update(near)

    total = sum(max(0, int(st.count)) for st in stations)
    spare = sum(max(0, int(stations[i].count))
                for i in range(len(stations)) if i not in claimed)
    starved = bool(claimed) and spare == 0
    if starved:
        for sid, n in list(benches.items()):
            if not (isinstance(n, int) and n > 0):
                benches[sid] = beltgeom.CLOSED
    return {"benches": benches, "gates": gates, "spare": spare, "total": total,
            "fallback": 0 if starved else (spare if 0 < spare < total else total),
            "starved": starved, "claimed": claimed, "n_stations": total or 1}


def junctions(model, line: dict, ledger: dict | None = None) -> list[dict]:
    """枝分かれ: where each 引き込み hangs off its host belt, in arc order.

    ``engine.build`` hangs a spur off the belt that FEEDS it — normally the trunk
    its infeed sits on, but a 引き込み drawn as ONE belt CROSSING the 本線 has no
    endpoint on the trunk at all and is met in its MIDDLE (``beltgeom.feed_point``).
    A load then boards it THERE, so what is left to ride is ``length − feed_arc``,
    not the whole belt.

    A spur with no hands is not wired at all (``ConveyorLine.closed``): it receives
    nothing, and pricing it as a lane would sell capacity the floor has no people
    for — rosier than the run.

    Each entry is ``{host, arc, spur, feed_arc, benches, cv}``; ``benches`` is the
    three-valued answer, so a caller that wants only the manned lanes (pull) and one
    that wants the half-drawn-line fallback too (auto) can each say so.
    """
    ledger = ledger or bench_ledger(model, line)
    benches = ledger["benches"]
    geom = [(str(cv.id), _pts(cv)) for cv in line["belts"]]
    spur_ids = set(line["spur_ids"])
    out = []
    for cv in line["spurs"]:
        n = benches.get(str(cv.id), beltgeom.UNSTAFFED)
        if n in beltgeom.NO_HANDS:
            continue                      # 手が無い引き込みは分岐そのものが張られない
        hit = beltgeom.feed_point(_pts(cv), geom, exclude=spur_ids)
        if hit is None or hit[0] in spur_ids:
            continue                      # fed by nothing (or by another spur): dead
        out.append({"host": hit[0], "arc": hit[1], "spur": str(cv.id),
                    "feed_arc": hit[2], "benches": n, "cv": cv})
    out.sort(key=lambda j: (j["arc"], j["spur"]))
    return out
