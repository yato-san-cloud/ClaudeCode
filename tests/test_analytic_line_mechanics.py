"""ライン運用の3機構の解析ミラー — 選択停止ゲート / pull型引き込み / 容器の有限循環.

不変条件17 listed these three as authored MECHANISMS the engine has and the
closed-form oracle did not, which is invariant 5's forbidden direction: a model
that switched one ON got a **rosier** instant estimate than the DES run meant to
confirm it. On the bundled gate line the oracle read a 25% block ratio as 0.05%
and a 122/hr line as 300/hr.

``whsim.linemech`` closes that. These tests pin, for each mechanism:

* the ENGINE MIRRORS it keeps (the gate rule, whose 梱包台 is whose, where a
  引き込み hangs off its 本線) — read from one source, never re-derived;
* the mechanism's own hand derivation (what the stop line does to capacity, what
  "pull" does to 引き込み量);
* 解析↔DES agreement with the mechanism ON, in the band each closed form was
  validated to — and on the SAFE side: the oracle may read a line gloomier than
  the run, never rosier;
* that the whole catalogue never reaches any of the three (every shipped
  template is ``auto``, gate-less and pool-less), so nothing existing can move.

The 容器 mirror has its own file (``test_analytic_container_pool.py``); what it
shares with the other two — the ledger, the junction rule, inertness — is pinned
here.
"""

from __future__ import annotations

import math
import time

import pytest
from test_line_mechanics import (  # the line fixtures live next door
    INSPECT,
    PACK,
    PICK,
    SHIP,
    _container_model,
    _edge,
    _model,
    _pull_model,
)

from whsim import analytic, kpis, linemech, templates
from whsim.engine import build as engine_build
from whsim.engine.run import run_once
from whsim.linemech import container as container_mod
from whsim.linemech import gate as gate_mod
from whsim.linemech import pull as pull_mod
from whsim.schema.model import Conveyor, Station, WarehouseModel

SEED = 5


# --------------------------------------------------------------- the fixtures
# Grown from ``test_line_mechanics``' own gated line: two entry belts carrying
# two 荷の種別 onto one 本線, a stop line partway along it, and hands standing
# either at the stop line, at a 引き込み, or at the far end.

def _base(conveyors, edges, *, pick_xy, stations, pickers=12, rate=180.0,
          pack_time=60.0, duration=7200.0):
    return _model(conveyors, edges, pick_xy=pick_xy, pickers=pickers, rate=rate,
                  pack_time=pack_time, stations=stations, duration=duration)


def _gated(*, gate=True, gate_arc=30.0, n_stop_bench=1, n_ship_bench=4,
           n_inspect_faces=2, n_packed_faces=2, rate=180.0, pack_time=60.0,
           duration=7200.0, pitch=4.0, pickers=12):
    """検品ライン E1 (inspected) + 梱包ライン E2 (packed) → 本線 T with a stop line.

    The MIX is set by how many pick faces stand beside each entry belt: the
    engine's ``_board_conveyor`` hands each tote to the Manhattan-nearest ENTRY
    belt, so a face at x≈5 boards E1 (stopped) and one at x≈25 boards E2 (passes).
    """
    e1 = Conveyor(id="E1", points=[[5.0, 4.0], [5.0, 12.0]], speed_mps=1.0,
                  load_kind="inspected", tote_pitch_m=pitch)
    e2 = Conveyor(id="E2", points=[[25.0, 4.0], [25.0, 12.0]], speed_mps=1.0,
                  load_kind="packed", tote_pitch_m=pitch)
    trunk = Conveyor(id="T", points=[[0.0, 12.0], [40.0, 12.0]], speed_mps=1.0,
                     tote_pitch_m=pitch,
                     stop_gate=({"at_m": gate_arc, "stop_states": ["inspected"],
                                 "pass_states": ["packed"]} if gate else None))
    stations = []
    if n_stop_bench > 0:
        stations.append(Station(id="stopline", x=min(gate_arc, 40.0), y=14.0,
                                count=n_stop_bench))
    if n_ship_bench > 0:
        stations.append(Station(id="ship", x=44.0, y=14.0, count=n_ship_bench))
    return _base([e1, e2, trunk],
                 [_edge(PICK, INSPECT, "E1"), _edge(PICK, INSPECT, "E2"),
                  _edge(PACK, SHIP, "T")],
                 pick_xy=([(5.0 + 2.0 * i, 2.0) for i in range(n_inspect_faces)]
                          + [(25.0 + 2.0 * i, 2.0) for i in range(n_packed_faces)]),
                 stations=stations, pickers=pickers, rate=rate,
                 pack_time=pack_time, duration=duration)


def _gated_with_spurs(*, n_spur_bench=2, n_stop_bench=2, rate=480.0,
                      pack_time=60.0, duration=7200.0, pitch=2.0):
    """A gated 本線 that ALSO carries 引き込み — the shipped line's own shape."""
    e1 = Conveyor(id="E1", points=[[2.0, 4.0], [2.0, 12.0]], speed_mps=1.0,
                  load_kind="inspected", tote_pitch_m=pitch)
    e2 = Conveyor(id="E2", points=[[25.0, 4.0], [25.0, 12.0]], speed_mps=1.0,
                  load_kind="packed", tote_pitch_m=pitch)
    trunk = Conveyor(id="T", points=[[0.0, 12.0], [40.0, 12.0]], speed_mps=1.0,
                     tote_pitch_m=pitch,
                     stop_gate={"at_m": 30.0, "stop_states": ["inspected"],
                                "pass_states": ["packed"]})
    spurs, stations = [], []
    edges = [_edge(PICK, INSPECT, "E1"), _edge(PICK, INSPECT, "E2"),
             _edge(PACK, SHIP, "T")]
    for i, a in enumerate((12.0, 20.0)):
        sid = f"S{i + 1}"
        spurs.append(Conveyor(id=sid, points=[[a, 12.0], [a, 20.0]],
                              speed_mps=1.0, tote_pitch_m=pitch))
        edges.append(_edge(INSPECT, PACK, sid))
        stations.append(Station(id=f"b{i + 1}", x=a, y=20.0, count=n_spur_bench))
    if n_stop_bench > 0:
        stations.append(Station(id="stopline", x=30.0, y=14.0, count=n_stop_bench))
    stations.append(Station(id="ship", x=44.0, y=14.0, count=3))
    return _base([e1, e2, trunk] + spurs, edges,
                 pick_xy=[(2.0, 2.0), (4.0, 2.0), (25.0, 2.0), (27.0, 2.0)],
                 stations=stations, rate=rate, pack_time=pack_time,
                 duration=duration)


def _gate_downstream_entry(*, gate_arc=10.0, rate=960.0, duration=7200.0):
    """The stopped kind boards the trunk DOWNSTREAM of the stop line.

    ``processes._convey_chain`` applies a gate only when ``gate.arc >= arc``, so
    these loads are already past it and ride to the end of the chain instead.
    """
    e1 = Conveyor(id="E1", points=[[25.0, 4.0], [25.0, 12.0]], speed_mps=1.0,
                  load_kind="inspected", tote_pitch_m=4.0)
    e2 = Conveyor(id="E2", points=[[5.0, 4.0], [5.0, 12.0]], speed_mps=1.0,
                  load_kind="packed", tote_pitch_m=4.0)
    trunk = Conveyor(id="T", points=[[0.0, 12.0], [40.0, 12.0]], speed_mps=1.0,
                     tote_pitch_m=4.0,
                     stop_gate={"at_m": gate_arc, "stop_states": ["inspected"],
                                "pass_states": ["packed"]})
    return _base([e1, e2, trunk],
                 [_edge(PICK, INSPECT, "E1"), _edge(PICK, INSPECT, "E2"),
                  _edge(PACK, SHIP, "T")],
                 pick_xy=[(25.0, 2.0), (27.0, 2.0), (5.0, 2.0), (7.0, 2.0)],
                 stations=[Station(id="stopline", x=gate_arc, y=14.0, count=2),
                           Station(id="ship", x=44.0, y=14.0, count=4)],
                 rate=rate, duration=duration)


def _measure(m, seeds=(SEED,)):
    res = [run_once(m, seed=s) for s in seeds]
    k = kpis.compute(res, m)
    ons = [e for r in res for e in r.events if e["event"] == "conveyor_on"]
    k["_boarded"] = sum(1 for e in ons if e.get("entry")) / len(res)
    k["_diverted"] = sum(1 for e in ons
                         if e["conveyor"].startswith("S")) / len(res)
    k["_gated"] = sum(1 for r in res for e in r.events
                      if e["event"] == "conveyor_gate") / len(res)
    return k


def _blind(model):
    """What ``estimate`` said BEFORE the mechanisms existed (the belt chain)."""
    orig = analytic._line_estimate
    analytic._line_estimate = analytic._conveyor_estimate
    try:
        return analytic.estimate(model)
    finally:
        analytic._line_estimate = orig


# ======================================================= 既定オフ＝カタログ不変

ALL_TEMPLATES = [t["template_id"] for t in templates.list_templates()]


@pytest.mark.parametrize("template_id", ALL_TEMPLATES)
def test_the_catalogue_answer_is_the_one_it_had_before(template_id):
    """ADDITIVE: every shipped template is ``auto``, gate-less and pool-less, so
    all three branches are unreachable and not one existing number may move — the
    aisle-travel contract (``test_analytic_aisle_travel``) is pinned on these very
    values."""
    m = templates.load_template_model(template_id)
    assert m.process.container_pool is None
    assert (m.process.divert_policy or "auto") == "auto"
    assert not analytic._has_gate(m)
    line = analytic._belt_stages(m)
    # The gate and the pool are inert on their own terms (no gate on any belt, no
    # pool authored); "pull" is a POLICY, so the module would happily price this
    # bank — what keeps it out is the predicate at the call site, which is why the
    # line block below has to come out identical.
    assert gate_mod.gate_line_estimate(m, 0.1, 4, 60.0, 3600.0, line=line) is None
    assert analytic._container_estimate(m, 0.1, 4, 60.0, 1.0, 3600.0) is None
    assert analytic._line_estimate(m, 0.1, 4, 60.0, 3600.0) == \
        analytic._conveyor_estimate(m, 0.1, 4, 60.0, 3600.0)
    assert analytic.estimate(m) == _blind(m)


@pytest.mark.parametrize("template_id", ALL_TEMPLATES)
def test_the_catalogue_never_reaches_the_three_entry_points(monkeypatch, template_id):
    """同梱テンプレは3機構の枝に**到達しない** — 出力が一致するより強い性質。

    A dict comparison (or a frozen digest) also passes when a branch DID run and
    happened to come back with the same numbers; this one fails the moment a
    predicate is loosened. The three mirrors are reached only through
    ``divert_policy`` / ``stop_gate`` / ``container_pool``, and the shipped
    catalogue authors none of them — which is also what keeps ``estimate`` inside
    its 50 ms budget on those models: they pay nothing, not even the import.
    """
    reached = []
    monkeypatch.setattr(gate_mod, "gate_line_estimate",
                        lambda *a, **k: reached.append("gate"))
    monkeypatch.setattr(pull_mod, "estimate", lambda *a, **k: reached.append("pull"))
    monkeypatch.setattr(container_mod, "container_estimate",
                        lambda *a, **k: reached.append("container"))
    analytic.estimate(templates.load_template_model(template_id))
    assert reached == []


def test_a_mechanism_on_still_estimates_inside_the_budget():
    """50 ms is the pin (``test_analytic_aisle_travel``); the worst bundled
    template is ~6 ms. Switching a mechanism on must not change the order of
    magnitude — the closed forms are arithmetic, not search."""
    base = templates.load_template_model("line_inspection")
    cases = {}
    m = base.model_copy(deep=True)
    m.process.divert_policy = "pull"
    cases["pull"] = m
    m = base.model_copy(deep=True)
    m.process.container_pool = {"count": 120, "return_time_s": 45.0}
    cases["container"] = m
    m = base.model_copy(deep=True)
    longest = max(m.resources.conveyors, key=lambda c: analytic.belt_length(c))
    longest.stop_gate = {"at_m": analytic.belt_length(longest) * 0.8,
                         "stop_states": ["inspected"]}
    cases["gate"] = m
    for name, model in cases.items():
        analytic.estimate(model)                      # warm the lazy import
        t0 = time.perf_counter()
        for _ in range(5):
            analytic.estimate(model)
        assert (time.perf_counter() - t0) / 5 < 0.05, name


# ================================================= 共有層: 図面の読み方は一つ

def test_the_chain_the_mirrors_read_is_the_chain_the_engine_wires():
    """不変条件11: ``analytic._belt_stages`` resolves the chain ONCE and all three
    mirrors read it. The additive keys are what they consume, so they are pinned
    against the topology ``engine.build`` actually wires."""
    m = _gated_with_spurs()
    line = analytic._belt_stages(m)
    world = engine_build.build(m)
    assert {str(cv.id) for cv in line["belts"]} == {ln.id for ln in world.conveyors}
    assert {str(cv.id) for cv in line["entries"]} == \
        {ln.id for ln in world.entry_conveyors}
    assert line["spur_ids"] == {s.id for ln in world.conveyors
                                for _a, s in ln.junctions}
    assert {a: b for a, (b, _arc) in line["succ"].items()} == \
        {ln.id: ln.next_line.id for ln in world.conveyors if ln.next_line}
    # ...and where each 引き込み hangs off its host, with the arc the engine used.
    js = {j["spur"]: j for j in linemech.junctions(m, line)}
    for ln in world.conveyors:
        for arc, spur in ln.junctions:
            assert js[spur.id]["host"] == ln.id
            assert js[spur.id]["arc"] == pytest.approx(arc, abs=1e-9)
            assert js[spur.id]["feed_arc"] == pytest.approx(spur.feed_arc, abs=1e-9)


def test_the_ledger_is_the_engines_own_answer_about_who_stands_where():
    """梱包台の持ち主 (``beltgeom.bench_pools``) + 停止線の作業者 + 余り台, and what a
    belt end with nobody of its own gets (``processes._bench_pool``). Three
    answers, and the last one is where the engine was WRONG until it was fixed:
    with every bench spoken for there is nobody, not "the whole floor again"."""
    for n_spur, n_stop, n_ship in ((2, 2, 3), (2, 0, 3), (0, 2, 3)):
        m = _gated_with_spurs(n_spur_bench=n_spur, n_stop_bench=n_stop)
        if n_ship == 0:
            m.resources.stations = [s for s in m.resources.stations
                                    if s.id != "ship"]
        world = engine_build.build(m)
        led = linemech.bench_ledger(m, analytic._belt_stages(m))
        assert led["gates"].get("T", 0) == \
            sum(g.n_bench for g in [ln.gate for ln in world.conveyors] if g)
        for ln in world.conveyors:
            if ln.id in ("S1", "S2"):
                assert (led["benches"][ln.id] if ln.n_bench else 0) == ln.n_bench
        assert led["fallback"] == (world.spare_bench.capacity
                                   if world.spare_bench is not None
                                   else (0 if world.benches_claimed
                                         else world.n_packers))


def test_every_bench_claimed_means_nobody_at_the_end_not_everybody_twice():
    """``_bench_pool`` returns ``None`` when every 梱包台 stands at a 引き込み or a
    停止線: the load stops at the belt end (``pack_unmanned``) instead of being
    packed by those same people a second time (measured packer_utilization 1.73).
    The mirror has to say the same, or it sells hands that are already busy."""
    m = _pull_model("pull", bench=1, rate=300.0)     # 末端に人を描かない
    world = engine_build.build(m)
    assert world.spare_bench is None and world.benches_claimed
    led = linemech.bench_ledger(m, analytic._belt_stages(m))
    assert led["starved"] and led["fallback"] == 0
    bank = pull_mod.resolve(m, analytic._belt_stages(m))
    assert bank["end_servers"] == 0 and bank["end_unmanned"] is True
    k = _measure(m)
    assert k["pack_unmanned_loads"] > 0 and k["packer_utilization"] <= 1.0
    # ...and with somebody drawn there it is their bench, not the floor's.
    staffed = _pull_model("pull", bench=1, rate=300.0, end_bench=4)
    bank2 = pull_mod.resolve(staffed, analytic._belt_stages(staffed))
    assert bank2["end_servers"] == 4 and bank2["end_unmanned"] is False
    assert engine_build.build(staffed).spare_bench.capacity == 4


# ============================================================ 機構1: 選択停止ゲート

def test_the_gate_this_module_reads_is_the_gate_the_engine_builds():
    """不変条件11: ONE mirror of ``build._resolve_gate``, and it must agree on every
    malformed spec too — an unstated / mis-typed / names-nothing gate is not a
    gate, so a model cannot acquire one by accident (never-blocks)."""
    specs = [{"at_m": 10.0, "stop_states": ["a"], "pass_states": ["b"]},
             {}, None, {"at_m": 10.0}, {"at_m": "ten", "stop_states": ["a"]},
             {"at_m": 10.0, "stop_states": []}, {"stop_states": "a"},
             {"at_m": 999.0, "stop_states": "a"}, {"at_m": -5.0, "pass_states": ["b"]}]
    for spec in specs:
        cv = Conveyor(id="c", points=[[0.0, 0.0], [20.0, 0.0]], stop_gate=spec)
        line = engine_build.ConveyorLine(
            id="c", points=[(0.0, 0.0), (20.0, 0.0)], seglens=[20.0], length=20.0,
            speed=1.0, capacity=20, belt=None)
        theirs = engine_build._resolve_gate(cv, line)
        mine = linemech.resolve_gate(cv)
        if theirs is None:
            assert mine is None, spec
            continue
        assert mine[0] == pytest.approx(theirs.arc), spec
        assert mine[1] == theirs.stop_kinds and mine[2] == theirs.pass_kinds, spec
        for kind in ("a", "b", "", "z"):
            assert linemech.gate_stops(mine, kind) is theirs.stops(kind), (spec, kind)


def test_the_kind_mix_is_the_mix_the_engine_boards():
    """There is no "mix" field and none is needed: the kind is stamped by the
    ENTRY belt the picker hands to, so the mix is geometry × ``pick_freq``.

    Measured over 12 h the run sits ~0.016 toward the MINORITY kind (0.734 against
    0.750 at a 3:1 face split, 0.265 against 0.250 at 1:3, exact at 2:2 and 4:0):
    a multi-line order is stamped by its LAST pick, so a tour that crosses to the
    other belt's faces carries that kind. Real, small, and well inside the 0.05
    this is pinned to — but it is why the seeds are averaged rather than sampled.
    """
    # Under the line's capacity, so the mix is the DRAWING's and not the jam's:
    # a saturated stop line blocks its own kind and skews what gets boarded.
    for insp, packed in ((1, 3), (2, 2), (3, 1), (4, 0)):
        m = _gated(n_inspect_faces=insp, n_packed_faces=packed, rate=120.0,
                   n_stop_bench=4)
        line = gate_mod.resolve_line(m)
        share, _arcs = gate_mod.kind_shares(m, line)
        assert share.get("inspected", 0.0) == pytest.approx(
            insp / (insp + packed), abs=1e-9), (insp, packed)
        world = engine_build.build(m)
        kind_of = {c.id: c.load_kind for c in world.conveyors}
        boarded = [kind_of[e["conveyor"]]
                   for seed in (5, 11, 23)      # ~700 boardings: ±0.03 at 1 sd
                   for e in run_once(m, seed=seed).events
                   if e["event"] == "conveyor_on" and e.get("entry")]
        measured = boarded.count("inspected") / max(len(boarded), 1)
        assert measured == pytest.approx(share.get("inspected", 0.0), abs=0.05)
    # No locations at all ⇒ an even split over the entry belts (never blocks).
    m = _gated()
    m.locations, m.items = [], []
    share, _ = gate_mod.kind_shares(m, gate_mod.resolve_line(m))
    assert share == {"inspected": 0.5, "packed": 0.5}


def test_the_stop_line_sets_the_line_capacity():
    """The hand derivation: with one gated kind at share ``s`` the whole line is
    capped at ``c_gate/(pack·s)`` — the PASSING kind is throttled too, because the
    stopped totes standing at the stop line occupy the trunk slots it needs."""
    for benches in (1, 2, 3):
        cv = analytic.estimate(_gated(n_stop_bench=benches, rate=960.0))["conveyor"]
        assert cv["capacity_per_hr"] == pytest.approx(benches * 3600.0 / 60.0 / 0.5)
        assert cv["binding"] == "gate:T"
    for insp, packed, cap in ((3, 1, 160.0), (4, 0, 120.0)):
        cv = analytic.estimate(_gated(n_inspect_faces=insp, n_packed_faces=packed,
                                      n_stop_bench=2, rate=960.0))["conveyor"]
        assert cv["capacity_per_hr"] == pytest.approx(cap), (insp, packed)
    # ...and with the gate OFF the same drawing is bounded by the 梱包台 instead.
    off = analytic.estimate(_gated(gate=False, rate=960.0))["conveyor"]
    assert off["capacity_per_hr"] == pytest.approx(5 * 3600.0 / 60.0)
    assert off["binding"] == "pack"


def test_a_load_that_boards_past_the_stop_line_is_not_stopped_by_it():
    """``gate.arc >= arc``: a load that boarded DOWNSTREAM of the stop line is
    already past it and rides on to the end of the chain."""
    m = _gate_downstream_entry(gate_arc=10.0)
    cv = analytic.estimate(m)["conveyor"]
    assert cv["binding"] != "gate:T"
    assert _measure(m)["_gated"] == 0, "the engine stops nothing at a gate behind"
    # ...and with the gate AHEAD of that entry (arc 35 > 25) it stops again.
    ahead = _gate_downstream_entry(gate_arc=35.0)
    assert analytic.estimate(ahead)["conveyor"]["binding"] == "gate:T"
    assert _measure(ahead)["_gated"] > 0


def test_a_stop_line_behind_an_open_pull_in_is_unreachable():
    """貪欲ディバート never lets a load PAST the last open 引き込み — it stalls at the
    junction holding its 本線 slot. So the 停止線 downstream of one is unreachable
    and its benches are not capacity. Pricing them in read packer_utilization 0.86
    against a measured 0.60."""
    m = _gated_with_spurs(n_spur_bench=2)
    assert _measure(m)["_gated"] == 0
    assert analytic.estimate(m)["conveyor"]["binding"] != "gate:T"
    # ...and with the 引き込み unmanned (`count: 0` ⇒ CLOSED) the gate binds again.
    closed = _gated_with_spurs(n_spur_bench=0)
    assert analytic.estimate(closed)["conveyor"]["binding"] == "gate:T"
    assert _measure(closed)["_gated"] > 0


@pytest.mark.parametrize("benches,rate,insp,packed", [
    (1, 240.0, 2, 2), (2, 960.0, 2, 2), (3, 960.0, 2, 2), (4, 960.0, 2, 2),
    (2, 960.0, 3, 1), (2, 960.0, 4, 0), (2, 480.0, 1, 3)])
def test_the_closed_form_and_the_des_agree_on_a_gated_line(benches, rate, insp, packed):
    """解析↔DES with the gate ON, in the pin invariant 5 is measured against
    (|Δutil| < 0.08). The gate governs PACKING, and gate-blind the same models read
    it wrong by up to 0.669 — so the packing stage is what this pins, both ways."""
    m = _gated(n_stop_bench=benches, rate=rate, n_inspect_faces=insp,
               n_packed_faces=packed)
    est, k = analytic.estimate(m), _measure(m)
    assert abs(est["packer_utilization"] - k["packer_utilization"]) < 0.08
    blind = _blind(m)
    assert abs(est["packer_utilization"] - k["packer_utilization"]) <= \
        abs(blind["packer_utilization"] - k["packer_utilization"]) + 1e-9


@pytest.mark.parametrize("benches,rate", [(1, 240.0), (2, 960.0), (4, 960.0),
                                          (2, 480.0), (8, 960.0)])
def test_the_gate_never_reads_a_gated_line_rosier_than_the_run(benches, rate):
    """不変条件5の向き — the test that must never be relaxed. An oracle may read a
    jam gloomier than the run; it must never promise throughput the line cannot
    pass, nor a clear belt where the run blocks."""
    m = _gated(n_stop_bench=benches, rate=rate)
    est, k = analytic.estimate(m), _measure(m)
    cv = est["conveyor"]
    assert k["throughput_per_hr"] <= cv["capacity_per_hr"] * 1.05
    if k["conveyor_block_ratio"] > 0.02:
        assert cv["block_ratio_est"] >= 0.5 * k["conveyor_block_ratio"]


def test_a_line_with_no_gate_takes_the_historical_path_unchanged():
    """The module returns ``None`` the moment no active belt resolves a gate, so
    the answer is ``_conveyor_estimate``'s, byte for byte."""
    for m in (_gated(gate=False, rate=240.0), _pull_model("auto"),
              _container_model(count=10), WarehouseModel()):
        assert analytic.estimate(m) == _blind(m)


# ========================================================== 機構2: pull型引き込み

def test_pull_prices_the_junction_as_a_loss_system_not_a_queue():
    """引き込み量 is the number the mechanism exists to say out loud: under pull a
    load enters only where a bench is FREE as it passes, so cutting the 梱包台
    drops it. Under 貪欲ディバート it does not move at all (74 → 74)."""
    full = _pull_model("pull", bench=3, rate=300.0, end_bench=4)
    thin = _pull_model("pull", bench=1, rate=300.0, end_bench=4)
    for m in (full, thin):
        line = analytic._belt_stages(m)
        n_st = sum(max(0, s.count) for s in m.resources.stations)
        k = _measure(m)
        got = pull_mod.estimate(m, line, k["_boarded"] / m.simulation.duration_s,
                                n_st, m.process.pack_time_s, m.simulation.duration_s)
        assert got["policy"] == "pull"
        measured = k["_diverted"] / max(k["_boarded"], 1)
        assert got["divert_share"] == pytest.approx(measured, abs=0.03)
    assert analytic.estimate(thin)["conveyor"]["divert_share"] < \
        analytic.estimate(full)["conveyor"]["divert_share"]


@pytest.mark.parametrize("bench,rate,end_bench", [
    (1, 150.0, 2), (1, 300.0, 2), (2, 300.0, 2), (3, 300.0, 6),
    (1, 300.0, 6), (3, 150.0, 2)])
def test_pull_agrees_with_the_run_and_never_reads_the_bank_rosier(bench, rate, end_bench):
    """解析↔DES with pull ON: 引き込み量 within the validated rms (0.011 over 36
    configs, band 0.03 here) and 梱包稼働率 within 0.08 — and on the SAFE side, i.e.
    never below what the run measures."""
    m = _pull_model("pull", bench=bench, rate=rate, end_bench=end_bench,
                    duration=7200.0)
    est, k = analytic.estimate(m), _measure(m)
    cv = est["conveyor"]
    measured = k["_diverted"] / max(k["_boarded"], 1)
    assert cv["divert_share"] == pytest.approx(measured, abs=0.03)
    assert abs(est["packer_utilization"] - k["packer_utilization"]) < 0.08
    assert est["packer_utilization"] >= k["packer_utilization"] - 1e-9, "rosier"
    assert cv["block_ratio_est"] >= k["conveyor_block_ratio"] - 0.03


def test_pull_reads_a_line_whose_end_nobody_staffs_as_the_jam_it_is():
    """末端に人が居ない pull ライン: what nobody pulled in stands at the end for good,
    the 本線 fills behind it and the whole line stops. The closed form says so
    (``jams`` + ``time_to_jam_s`` + ``end_unmanned``) and prices ONLY the hands the
    bank has — deliberately gloomier than the run's horizon average, which counts
    the loads that got through before the trunk filled."""
    m = _pull_model("pull", bench=1, rate=300.0, duration=7200.0)
    est, k = analytic.estimate(m), _measure(m)
    cv = est["conveyor"]
    assert cv["end_unmanned"] is True and cv["jams"] is True
    assert 0.0 < cv["time_to_jam_s"] < m.simulation.duration_s
    assert k["pack_unmanned_loads"] > 0
    # SAFE side on both stages, and the mechanism's own number still lands.
    assert est["packer_utilization"] >= k["packer_utilization"]
    assert est["picker_utilization"] >= k["picker_utilization"] - 1e-9
    assert cv["divert_share"] == pytest.approx(
        k["_diverted"] / max(k["_boarded"], 1), abs=0.03)
    # ...and staffing the end removes the jam, in the run and in the estimate.
    staffed = analytic.estimate(_pull_model("pull", bench=1, rate=300.0,
                                            end_bench=4, duration=7200.0))
    assert staffed["conveyor"]["jams"] is False
    assert staffed["conveyor"]["end_unmanned"] is False


def test_an_unmanned_pull_in_is_not_a_lane_the_floor_cannot_work():
    """``_bench_free`` returns False outright when nobody is drawn at a 引き込み, so
    under pull it takes nothing. Counting it as a lane sold capacity the floor has
    no people for — and made the EMPTY pull-in the strongest one on the line."""
    m = _pull_model("pull", bench=1, rate=300.0, end_bench=4)
    m.resources.stations = [s for s in m.resources.stations if s.id != "b2"]
    line = analytic._belt_stages(m)
    bank = pull_mod.resolve(m, line)
    assert [j["spur_ids"] for j in bank["junctions"]] == [["S1"]]
    world = engine_build.build(m)
    assert next(c for c in world.conveyors if c.id == "S2").bench is None
    res = run_once(m, seed=SEED)
    assert not [e for e in res.events
                if e["event"] == "conveyor_on" and e["conveyor"] == "S2"]


# ================================================== 機構3: 容器 (共有部分のみ)

def test_the_container_pool_rides_inside_the_conveyor_block():
    """A container is claimed on the belt hand-over path and nowhere else, so the
    pool answer hangs off the line's own block — and every other model keeps the
    exact answer shape it had (no new top-level key)."""
    m = _container_model(count=6)
    est = analytic.estimate(m)
    assert set(est) == set(_blind(m))
    got = est["conveyor"]["containers"]
    assert got["pool_size"] == 6 and got["required_pool"] >= got["in_use_peak"]
    k = _measure(m)
    assert got["residence_s"] == pytest.approx(k["container_use_mean_s"], rel=0.10)
    # no pool ⇒ the key is not there at all (never a zeroed dict)
    assert "containers" not in (analytic.estimate(_pull_model("auto"))["conveyor"] or {})


def test_the_pool_does_not_move_the_headline_numbers():
    """Measured: the engine does NOT charge 投入待ち to the picker (a starved line
    reads picker 0.110 against 0.155 unstarved), so throttling λ by the pool would
    push this oracle BELOW the run — invariant 5's forbidden direction. The pool
    answers its own question and leaves the rest alone."""
    thin, fat = _container_model(count=2), _container_model(count=1000)
    a, b = analytic.estimate(thin), analytic.estimate(fat)
    assert a["picker_utilization"] == b["picker_utilization"]
    assert a["packer_utilization"] == b["packer_utilization"]
    assert a["conveyor"]["containers"]["throttles"] is True
    assert b["conveyor"]["containers"]["throttles"] is False
    k = _measure(thin)
    assert a["picker_utilization"] >= k["picker_utilization"] - 0.08


# ============================================================== never-blocks

def test_every_mechanism_always_returns_a_number():
    """A degenerate drawing must not break the estimate (不変条件2): zero pack time,
    a one-point belt, a gate nobody stands at, no demand at all."""
    m = _gated(n_stop_bench=0, n_ship_bench=0, pack_time=0.0, rate=0.0)
    m.resources.conveyors.append(Conveyor(id="dot", points=[[5.0, 5.0]]))
    m.resources.conveyors.append(
        Conveyor(id="zero", points=[[1.0, 1.0], [3.0, 1.0]], speed_mps=0.0))
    for policy in ("auto", "pull"):
        m.process.divert_policy = policy
        m.process.container_pool = {"count": 3, "return_time_s": 10.0}
        est = analytic.estimate(m)
        for key, v in est.items():
            if isinstance(v, float):
                assert math.isfinite(v), (policy, key)
        cv = est["conveyor"]
        if cv is not None:
            assert 0.0 <= cv["block_ratio_est"] <= 1.0, policy
            assert cv["capacity_per_hr"] is None or cv["capacity_per_hr"] >= 0.0


def test_a_gate_and_pull_together_take_the_pull_reading():
    """Both authored is the one combination neither closed form was validated on.
    ``estimate`` prefers pull — it changes what happens at EVERY junction, which is
    upstream of what the gate then sees — and that is the gloomier of the two."""
    m = _gated_with_spurs(n_spur_bench=2)
    m.process.divert_policy = "pull"
    cv = analytic.estimate(m)["conveyor"]
    assert cv["policy"] == "pull"
    assert "gate" not in cv
    k = _measure(m)
    assert analytic.estimate(m)["packer_utilization"] >= k["packer_utilization"] - 1e-9
