"""容器の有限循環 の閉形式 — 解析↔DES の一致ピン.

The engine mechanism lives in ``engine.processes._take_container`` /
``_release_container``; ``whsim.linemech.container`` is its closed form.
Invariant 5 says the two must not diverge structurally, so every test here
compares the closed form against a REAL DES run rather than against a frozen
number.

The pool is also the one bottleneck a customer can buy their way out of, so the
sizing answer (``required_pool``) is pinned to be an UPPER bound on what the run
actually used: an oracle may tell the buyer to rent one too many, never one too
few (the same asymmetry ``analytic._steady_block`` documents for the jam).
"""

from __future__ import annotations

import math

import pytest
from test_line_mechanics import (  # the line fixtures live next door
    INSPECT,
    PACK,
    PICK,
    SHIP,
    _container_model,
    _edge,
    _gate_model,
    _model,
)

from whsim import analytic, beltgeom, kpis, templates
from whsim.engine import build as engine_build
from whsim.engine.run import run_once
from whsim.linemech import bench_ledger
from whsim.linemech.container import (
    closed_wait_cap,
    container_estimate,
    erlang_c,
    mmck,
    peak_estimate,
    pool_spec,
    resolve_line,
)
from whsim.schema.model import Conveyor, Station


def _predict(m, **kw):
    """Exactly what ``analytic.estimate`` has in hand where this is called."""
    line = analytic._belt_stages(m)
    n_st = sum(max(0, s.count) for s in m.resources.stations) or 1
    pack_time = max(m.process.pack_time_s, 0.0)
    est = analytic.estimate(m)
    lam = min(est["offered_orders_per_hr"], est["capacity_orders_per_hr"]) / 3600.0
    jam = est["conveyor"]
    if jam is not None and jam["jams"] and jam["capacity_per_hr"]:
        lam = min(lam, jam["capacity_per_hr"] / 3600.0)
    kw.setdefault("batch", float(est["orders_per_trip"]))
    return container_estimate(m, lam=lam, n_benches=n_st, pack_time_s=pack_time,
                              horizon_s=m.simulation.duration_s, line=line, **kw)


def _measure(m, seed=5):
    return kpis.compute([run_once(m, seed=seed)], m)


def _resolved(m):
    return resolve_line(m, analytic._belt_stages(m))


def _benches(m):
    return dict(bench_ledger(m, analytic._belt_stages(m))["benches"])


# --------------------------------------------------------------- the fixtures
# Grown from ``test_line_mechanics``' own line: one 検品ライン, one 本線, the
# 引き込み under test, and a 還流ベルト the emptied containers ride home on.

def _pooled(m, count, return_time=30.0):
    m.process.container_pool = {"count": count, "return_time_s": return_time,
                                "return_belt": "UP"}
    m.resources.conveyors.append(
        Conveyor(id="UP", points=[[40.0, 10.5], [0.0, 10.5]], speed_mps=1.0,
                 elevation_m=1.1))
    return m


def _crossing(count=40, both=False, rate=150.0, bench=2, pack_time=40.0,
              duration=3600.0):
    """1本で描かれ本線を真ん中で跨ぐ引き込み — ``beltgeom.feed_point``/``feed_arc``."""
    trunk = Conveyor(id="T", points=[[0.0, 10.0], [40.0, 10.0]], speed_mps=1.0)
    entry = Conveyor(id="E", points=[[2.0, 2.0], [2.0, 10.0]], speed_mps=1.0)
    spur = Conveyor(id="S", points=[[20.0, 6.0], [20.0, 14.0]], speed_mps=0.5,
                    discharge_both=both)
    m = _model([entry, trunk, spur],
               [_edge(PICK, INSPECT, "E"), _edge(INSPECT, PACK, "S"),
                _edge(PACK, SHIP, "T")],
               pick_xy=[(3.0, 2.0), (5.0, 2.0)], rate=rate, pack_time=pack_time,
               duration=duration,
               stations=[Station(id="north", x=21.5, y=6.5, count=bench),
                         Station(id="south", x=21.5, y=13.5, count=bench)])
    return _pooled(m, count)


def _lost_bench(count=40, rate=150.0, pack_time=40.0, duration=3600.0):
    """隣に台を取られた引き込み (``beltgeom.LOST``) は何も引かない。"""
    trunk = Conveyor(id="T", points=[[0.0, 10.0], [40.0, 10.0]], speed_mps=1.0)
    entry = Conveyor(id="E", points=[[2.0, 2.0], [2.0, 10.0]], speed_mps=1.0)
    a = Conveyor(id="A", points=[[20.0, 10.0], [20.0, 15.0]], speed_mps=0.5)
    b = Conveyor(id="B", points=[[22.0, 10.0], [22.0, 15.0]], speed_mps=0.5)
    m = _model([entry, trunk, a, b],
               [_edge(PICK, INSPECT, "E"), _edge(INSPECT, PACK, "A"),
                _edge(INSPECT, PACK, "B"), _edge(PACK, SHIP, "T")],
               pick_xy=[(3.0, 2.0), (5.0, 2.0)], rate=rate, pack_time=pack_time,
               duration=duration,
               # 1台だけ: A(1.0m) の方が B(1.6m) より近い ⇒ B は LOST
               stations=[Station(id="only", x=20.6, y=15.4, count=3)])
    return _pooled(m, count)


def _unstaffed(count=40, rate=150.0, spare=2, pack_time=40.0, duration=3600.0):
    """誰も描かれていない引き込みが借りるのは「余り台」だけ (``World.spare_bench``)。"""
    trunk = Conveyor(id="T", points=[[0.0, 10.0], [40.0, 10.0]], speed_mps=1.0)
    entry = Conveyor(id="E", points=[[2.0, 2.0], [2.0, 10.0]], speed_mps=1.0)
    a = Conveyor(id="A", points=[[14.0, 10.0], [14.0, 15.0]], speed_mps=0.5)
    b = Conveyor(id="B", points=[[26.0, 10.0], [26.0, 15.0]], speed_mps=0.5)
    stations = [Station(id="at_a", x=14.0, y=15.0, count=2)]
    if spare:                       # 誰の引き込みでもない余り台 (遠くに置く)
        stations.append(Station(id="spare", x=38.0, y=13.0, count=spare))
    m = _model([entry, trunk, a, b],
               [_edge(PICK, INSPECT, "E"), _edge(INSPECT, PACK, "A"),
                _edge(INSPECT, PACK, "B"), _edge(PACK, SHIP, "T")],
               pick_xy=[(3.0, 2.0), (5.0, 2.0)], rate=rate, pack_time=pack_time,
               duration=duration, stations=stations)
    return _pooled(m, count)


def _gate_downstream(count=40, rate=150.0, pack_time=40.0, duration=3600.0):
    """停止線より DOWNSTREAM で乗った荷は止まらず走り抜ける。"""
    e_up = Conveyor(id="EU", points=[[5.0, 4.0], [5.0, 10.0]], speed_mps=1.0,
                    load_kind="inspected")
    e_dn = Conveyor(id="ED", points=[[30.0, 4.0], [30.0, 10.0]], speed_mps=1.0,
                    load_kind="inspected")
    trunk = Conveyor(id="T", points=[[0.0, 10.0], [40.0, 10.0]], speed_mps=1.0,
                     stop_gate={"at_m": 20.0, "stop_states": ["inspected"]})
    m = _model([e_up, e_dn, trunk],
               [_edge(PICK, INSPECT, "EU"), _edge(PICK, INSPECT, "ED"),
                _edge(PACK, SHIP, "T")],
               pick_xy=[(5.0, 2.0), (7.0, 2.0), (30.0, 2.0), (32.0, 2.0)],
               rate=rate, pack_time=pack_time, duration=duration,
               stations=[Station(id="atgate", x=20.0, y=12.0, count=2),
                         Station(id="end", x=41.0, y=11.0, count=3)])
    return _pooled(m, count)


def _multi_spur(count=20, rate=200.0, spurs=4, bench=2, pack_time=60.0,
                duration=3600.0, return_time=30.0):
    """本線 with several 引き込み — the shape the bundled ``line_inspection`` has."""
    e = Conveyor(id="E", points=[[2.0, 3.0], [2.0, 12.0]], speed_mps=1.0)
    trunk = Conveyor(id="T", points=[[0.0, 12.0], [40.0, 12.0]], speed_mps=1.0)
    up = Conveyor(id="UP", points=[[40.0, 12.5], [0.0, 12.5]], speed_mps=1.0,
                  elevation_m=1.1)
    cvs = [e, trunk]
    edges = [_edge(PICK, INSPECT, "E"), _edge(PACK, SHIP, "T")]
    stations = []
    for i in range(spurs):
        x = 8.0 + 6.0 * i
        cvs.append(Conveyor(id=f"S{i}", points=[[x, 12.0], [x, 17.0]], speed_mps=1.0))
        edges.append(_edge(INSPECT, PACK, f"S{i}"))
        stations.append(Station(id=f"b{i}", x=x, y=17.0, count=bench))
    cvs.append(up)
    m = _model(cvs, edges, pick_xy=[(2.0, 2.0), (5.0, 2.0), (8.0, 2.0)],
               stations=stations, rate=rate, pack_time=pack_time, duration=duration)
    m.process.container_pool = {"count": count, "return_time_s": return_time,
                                "return_belt": "UP"}
    return m


# ------------------------------------------------------------ 既定オフ = 完全に不活性

def test_no_pool_no_code_path():
    """``_take_container`` は engine の1箇所からしか呼ばれない: pool 無し ⇒ 何も起きない。

    So the closed form must return ``None`` — not a zeroed dict — before it reads
    anything else, and every shipped model must take that branch.
    """
    for man in templates.list_templates():
        m = templates.load_template_model(man["template_id"])
        assert m.process.container_pool is None
        assert _predict(m) is None, man["template_id"]


def test_a_pool_of_nothing_is_not_a_pool():
    """never-blocks, mirroring ``engine.build``: a mis-typed pool ⇒ 容器は無限."""
    for count in (0, -3, "x", None):
        m = _container_model(count=10)
        m.process.container_pool = {"count": count, "return_time_s": 30.0,
                                    "return_belt": "UP"}
        assert engine_build.build(m).container_pool is None, count
        assert pool_spec(m) is None, count
        assert _predict(m) is None, count
    m = _container_model(count=10)
    m.process.container_pool = {}
    assert _predict(m) is None


def test_no_belt_no_containers():
    """容器は投入(＝ベルトへの受け渡し)でしか取られない。ベルトが無ければ機構ごと不活性。"""
    m = _container_model(count=10)
    m.process.flow_edges = []                     # nothing wired ⇒ no belt in use
    assert analytic._belt_stages(m) is None
    assert _predict(m) is None
    res = run_once(m, seed=5)
    assert not [e for e in res.events if e["event"] == "container_take"]


# ------------------------------------------------------------ 一つの源 / 部品

def test_the_belt_scalars_come_from_one_source_and_match_the_engine():
    """不変条件11: the module keeps NO private copy of a belt's four scalars.

    Length / pitch / speed / slots live in ``analytic``; where a belt is fed, where
    it discharges and whose 梱包台 stands there live in ``beltgeom``. A private copy
    is what let a crossing 引き込み come out 4 benches in the run and 2 in the
    estimate.
    """
    from whsim.linemech import container as mod
    assert not [n for n in vars(mod) if n in ("_BELT_SPEED_FALLBACK",
                                              "_TOTE_PITCH_DEFAULT_M", "_slots",
                                              "_speed")]
    assert analytic._BELT_SPEED_FALLBACK == engine_build.DEFAULT_CONVEYOR_SPEED_MPS
    assert analytic._TOTE_PITCH_DEFAULT_M == 1.0
    assert mod.beltgeom is beltgeom
    # ...and the four agree with what ``build`` puts on the line, belt by belt.
    m = _container_model(count=10)
    world = engine_build.build(m)
    by_id = {c.id: c for c in m.resources.conveyors}
    for ln in world.conveyors:
        cv = by_id[ln.id]
        assert analytic.belt_slots(cv) == ln.belt.capacity
        assert analytic.belt_speed(cv) == ln.speed
        assert analytic.belt_length(cv) == pytest.approx(ln.length, abs=1e-12)


def test_erlang_c_and_mmck_are_the_same_functions_analytic_uses():
    """One source, not three copies of the arithmetic (invariant 11)."""
    assert erlang_c is analytic._erlang_c
    for c in range(1, 25):
        for a in (0.001, 0.5, 1.0, c * 0.5, c * 0.99, c * 1.5):
            for k in (0, 1, 5, 40):
                assert mmck(c, a, k)[0] == pytest.approx(
                    analytic._mmck_full(c, a, k), abs=1e-14)


def test_the_closed_network_cap_is_exact_mva_and_monotone():
    """The fixed point's uniqueness argument needs R non-decreasing in the load,
    which needs the cap non-decreasing in N. Floating-point Reiser–Lavenberg is
    NOT, past the knee for a wide bench bank — hence the guards."""
    for z in (0.0, 5.0, 60.0, 600.0):
        for s in (1.0, 40.0, 300.0):
            for c in (1, 3, 20, 50):
                vals = [closed_wait_cap(n, z, s, c) for n in range(1, 400)]
                assert all(b >= a - 1e-9 for a, b in zip(vals, vals[1:])), (z, s, c)
                assert vals[c - 1] == 0.0        # N ≤ benches ⇒ nobody ever queues

    def literal(n, z, s, c):
        p = [0.0] * c
        p[0] = 1.0
        q, rq = 0.0, s
        for i in range(1, n + 1):
            rq = (s / c) * (1.0 + q + sum((c - 1 - j) * p[j] for j in range(c - 1)))
            x = i / (z + rq)
            q = x * rq
            prev = p[:]
            for j in range(c - 1, 0, -1):
                p[j] = (x * s / j) * prev[j - 1]
            p[0] = 1.0 - (x * s + sum((c - j) * p[j] for j in range(1, c))) / c
        return max(rq - s, 0.0)

    for n in (2, 5, 10, 20, 40, 60):
        assert closed_wait_cap(n, 60.0, 40.0, 3) == pytest.approx(
            literal(n, 60.0, 40.0, 3), rel=1e-9)


def test_the_peak_is_a_poisson_upcrossing_and_grows_with_the_window():
    """M/G/∞ occupancy is Poisson; the MAX over a window grows with the window."""
    peaks = [peak_estimate(0.03, 100.0, t) for t in (900, 3600, 14400, 86400)]
    assert peaks == sorted(peaks) and peaks[0] < peaks[-1]
    # the sizing quantile is never below the expected max
    for t in (900, 3600, 14400):
        assert peak_estimate(0.03, 100.0, t, risk=0.10) >= peak_estimate(0.03, 100.0, t)
    assert peak_estimate(0.0, 100.0, 3600) == 0        # never-blocks
    assert peak_estimate(0.03, 0.0, 3600) == 0


# ----------------------------------------------------- 解析↔DES: R / X / L / peak

def test_the_residence_is_the_engines_own_decomposition():
    """R = ride + bench wait + 梱包 + (還流ベルト + return_time_s), each read off the
    SAME geometry the engine rides. Measured to 0.1% on the reference line."""
    m = _container_model(count=60)
    got = _predict(m)
    res = run_once(m, seed=5)
    held = [e["held"] for e in res.events if e["event"] == "container_return"]
    assert got["residence_s"] == pytest.approx(sum(held) / len(held), rel=0.05)
    # the ride and the return leg are DETERMINISTIC — they must be exact, not close
    assert got["ride_s"] == pytest.approx(21.0, abs=1e-9)     # E 9 + T 8 + S1 4
    assert got["return_s"] == pytest.approx(40.0, abs=1e-9)   # UP 10m + 30s


@pytest.mark.parametrize("count", [60, 20, 10, 8, 6, 5, 4, 3, 2])
def test_it_tracks_the_run_from_generous_through_the_knee_to_starving(count):
    m = _container_model(count=count)
    got, k = _predict(m), _measure(m)
    assert got["residence_s"] == pytest.approx(k["container_use_mean_s"], rel=0.10)
    assert got["throughput_per_hr"] == pytest.approx(k["throughput_per_hr"], rel=0.12)
    assert got["in_use_avg"] == pytest.approx(k["containers_in_use_avg"], rel=0.15)
    assert got["in_use_peak"] == pytest.approx(k["containers_in_use_peak"], abs=1)


@pytest.mark.parametrize("return_time", [0.0, 30.0, 120.0, 300.0, 600.0])
def test_the_return_leg_is_priced_and_it_is_what_makes_a_pool_bind(return_time):
    """A slow 還流 is a container shortage in disguise: R grows, N/R falls."""
    m = _container_model(count=10, return_time=return_time)
    got, k = _predict(m), _measure(m)
    assert got["residence_s"] == pytest.approx(k["container_use_mean_s"], rel=0.05)
    assert got["throughput_per_hr"] == pytest.approx(k["throughput_per_hr"], rel=0.10)


def test_the_greedy_diverts_make_the_spurs_an_overflow_cascade_not_a_pooled_bank():
    """4 引き込み × 2 台 is NOT one M/M/8: the near spur saturates first. Pooling
    them read the residence 20% short — and under-reading it under-buys."""
    for count, rate in ((40, 100.0), (40, 200.0), (40, 400.0), (12, 200.0),
                        (8, 200.0), (5, 200.0)):
        m = _multi_spur(count=count, rate=rate)
        got, k = _predict(m), _measure(m)
        assert got["residence_s"] == pytest.approx(
            k["container_use_mean_s"], rel=0.10), (count, rate)
        assert got["in_use_avg"] == pytest.approx(
            k["containers_in_use_avg"], rel=0.15), (count, rate)
        assert got["in_use_peak"] == pytest.approx(
            k["containers_in_use_peak"], rel=0.25, abs=1), (count, rate)


def test_a_stop_line_sends_the_two_kinds_to_different_hands():
    """One belt, two 荷の種別: 検品済 stops at the 停止線 (its own pair of hands), the
    完成品 rides on. Reading them as one load read the throughput 51% low."""
    m = _gate_model(gate=True, duration=3600.0)
    m.process.container_pool = {"count": 10, "return_time_s": 25.0, "return_belt": ""}
    got, k = _predict(m), _measure(m)
    assert got["throughput_per_hr"] == pytest.approx(k["throughput_per_hr"], rel=0.25)
    assert got["in_use_peak"] == pytest.approx(k["containers_in_use_peak"], abs=1)


# ------------------------------------- 図面から能力が正しく出るか (beltgeom の4規則)

def test_a_spur_crossing_the_trunk_is_fed_in_its_MIDDLE():
    """``beltgeom.feed_point``: a 引き込み drawn as ONE belt across the 本線 has no
    endpoint on it, so it boards at ``feed_arc`` and rides only the REST of its
    length. Reading ``points[0]`` priced a belt the engine wires to nothing, and
    charged twice the ride."""
    m = _crossing(count=60)
    world = engine_build.build(m)
    spur = next(c for c in world.conveyors if c.id == "S")
    priced = next(s for s in _resolved(m)["spurs"] if s["id"] == "S")
    assert spur.feed_arc == 4.0
    assert priced["ride_s"] == pytest.approx(
        (spur.length - spur.feed_arc) / spur.speed, abs=1e-9)
    for n in (60, 20, 10, 6):
        mm = _crossing(count=n)
        got, k = _predict(mm), _measure(mm)
        assert got["residence_s"] == pytest.approx(k["container_use_mean_s"], rel=0.20)
        assert got["throughput_per_hr"] == pytest.approx(k["throughput_per_hr"], rel=0.10)


def test_discharge_both_doubles_the_bench_bank_and_the_closed_form_follows():
    """``Conveyor.discharge_both`` is the one knob that doubles a line's packing
    capacity, so the oracle must not read the safe default when the drawing says
    otherwise (nor the generous one when it does not)."""
    one, both = _crossing(count=60), _crossing(count=60, both=True)
    assert _benches(one) == {"S": 2}
    assert _benches(both) == {"S": 4}
    for m in (one, both):
        got, k = _predict(m), _measure(m)
        assert got["residence_s"] == pytest.approx(k["container_use_mean_s"], rel=0.20)
    assert _predict(both)["residence_s"] < _predict(one)["residence_s"]


def test_a_pull_in_whose_bench_a_neighbour_owns_is_not_priced_as_a_lane():
    """``beltgeom.LOST``: the engine wires it no junction, so it takes nothing.
    Counting the shared bench for BOTH spurs (what a private mirror does — it is
    within reach of each) would price a 2-lane bank the floor has one pair of
    hands for: rosier than the run, the one direction invariant 5 forbids."""
    m = _lost_bench(count=60)
    world = engine_build.build(m)
    assert {c.id: (c.n_bench, c.closed) for c in world.conveyors
            if c.id in ("A", "B")} == {"A": (3, False), "B": (0, True)}
    assert _benches(m)["B"] == beltgeom.LOST
    assert [s["id"] for s in _resolved(m)["spurs"]] == ["A"]
    got, k = _predict(m), _measure(m)
    assert got["residence_s"] == pytest.approx(k["container_use_mean_s"], rel=0.05)


def test_an_unstaffed_pull_in_borrows_only_the_spare_benches():
    """``World.spare_bench``: what nobody claimed, not the whole floor — and with
    every bench spoken for it has nobody at all and the engine closes it."""
    for spare in (4, 2, 0):
        m = _unstaffed(count=60, spare=spare)
        world = engine_build.build(m)
        led = bench_ledger(m, analytic._belt_stages(m))
        assert led["spare"] == spare
        assert led["starved"] is (spare == 0)
        assert (world.spare_bench.capacity if world.spare_bench else 0) == \
            (spare if 0 < spare < led["total"] else 0)
        # ``_bench_pool``'s three answers, in the ledger's own vocabulary.
        assert led["fallback"] == (spare if spare else 0)
        assert bool(next(c for c in world.conveyors if c.id == "B").closed) is \
            (spare == 0)
        got, k = _predict(m), _measure(m)
        assert got["residence_s"] == pytest.approx(
            k["container_use_mean_s"], rel=0.20), spare


def test_a_load_that_boarded_past_the_stop_line_is_not_dragged_back_to_it():
    """A 停止線 only stops what PASSES it. Charging the gate to a load that boarded
    downstream would price the wrong pair of hands (and, before the engine fix,
    moved it backwards in zero time)."""
    for n in (60, 20, 8):
        mm = _gate_downstream(count=n)
        got, k = _predict(mm), _measure(mm)
        assert got["throughput_per_hr"] == pytest.approx(
            k["throughput_per_hr"], rel=0.10), n
        assert got["in_use_peak"] == pytest.approx(
            k["containers_in_use_peak"], rel=0.30, abs=1), n
    assert _predict(_gate_downstream(count=60))["residence_s"] > 0.0


# --------------------------------------------------- Little / the sizing answer

def test_little_holds_by_construction_and_agrees_with_the_run():
    """The identity ``test_line_mechanics`` pins on the run (±15%) is what this
    closed form IS: in_use_avg == throughput · residence, exactly."""
    for count in (60, 10, 6, 3):
        m = _container_model(count=count)
        got = _predict(m)
        assert got["in_use_avg"] == pytest.approx(
            got["throughput_per_hr"] / 3600.0 * got["residence_s"], rel=1e-12)
        k = _measure(m)
        lam = k["container_returns"] / m.simulation.duration_s
        assert abs(k["containers_in_use_avg"] - lam * k["container_use_mean_s"]) < \
            0.15 * k["containers_in_use_avg"]


def test_the_sizing_answer_covers_what_the_run_used():
    """``required_pool`` は「レンタルは何個」の答え — and the number it quotes is a
    QUANTILE, so it is pinned the way a quantile has to be: over a panel of runs
    it covers at least (1 − sizing_risk) of them, and the peak the KPI reports is
    around the middle of that panel rather than at its top.

    Sizing at the median would be wrong in the expensive direction: running out of
    containers stops the line, so ``required_pool`` sits ABOVE the expected max.
    """
    seeds = tuple(range(1, 21))
    for rate in (60.0, 120.0, 180.0):
        m = _container_model(count=500, rate=rate)          # never binds: measure freely
        got = _predict(m)
        peaks = [_measure(m, seed=s)["containers_in_use_peak"] for s in seeds]
        covered = sum(1 for p in peaks if p <= got["required_pool"])
        assert covered >= len(seeds) * (1.0 - got["sizing_risk"]) - 1, (
            rate, got["required_pool"], sorted(peaks))
        assert got["required_pool"] > got["in_use_peak"], rate
        assert min(peaks) <= got["in_use_peak"] <= max(peaks), (rate, sorted(peaks))


def test_binding_is_reported_exactly_where_the_engine_starts_waiting():
    """``binds`` ⇔ the engine logs a 投入待ち at all. The unconstrained peak is 10
    on this line, so a pool of 10 never waits and a pool of 9 does."""
    for count in (60, 12, 10):
        m = _container_model(count=count)
        assert not _predict(m)["binds"], count
        assert _measure(m)["container_wait_total_s"] == 0.0, count
    for count in (8, 6, 4, 2):
        m = _container_model(count=count)
        assert _predict(m)["binds"], count
        assert _measure(m)["container_wait_total_s"] > 0.0, count


def test_the_peak_is_truncated_at_the_pool_and_says_so():
    """不変条件17: ``peak == pool_size`` は天井に当たっただけ＝答えではない。The closed
    form reports the truncated peak AND the untruncated sizing answer."""
    small, big = _predict(_container_model(count=4)), _predict(_container_model(count=99))
    assert small["in_use_peak"] == small["pool_size"] == 4
    assert small["binds"] and not big["binds"]
    assert small["required_pool"] == big["required_pool"] > small["pool_size"]


# ------------------------------------------------------------------ 爆速 / 安全

def test_it_stays_fast_enough_for_drag_time_reestimation():
    import time
    m = templates.load_template_model("line_inspection")
    m.process.container_pool = {"count": 120, "return_time_s": 45.0, "return_belt": ""}
    line = analytic._belt_stages(m)
    n_st = sum(max(0, s.count) for s in m.resources.stations)
    t0 = time.perf_counter()
    for _ in range(50):
        container_estimate(m, lam=0.13, n_benches=n_st,
                           pack_time_s=m.process.pack_time_s,
                           horizon_s=m.simulation.duration_s, line=line)
    assert (time.perf_counter() - t0) / 50 < 0.005            # < 5 ms per call
    # ...and a pool nobody would ever type does not turn it into a loop over N.
    m.process.container_pool = {"count": 5_000_000, "return_time_s": 45.0}
    t0 = time.perf_counter()
    got = container_estimate(m, lam=0.13, n_benches=n_st,
                             pack_time_s=m.process.pack_time_s,
                             horizon_s=m.simulation.duration_s, line=line)
    assert (time.perf_counter() - t0) < 0.05 and not got["binds"]


def test_it_always_returns_a_number():
    """never-blocks: no NaN, no inf, no exception — at any load, any pool."""
    for count in (1, 2, 60, 100_000):
        for rate in (0.0, 1.0, 120.0, 100_000.0):
            for pack in (0.0, 40.0, 5_000.0):
                m = _container_model(count=count, rate=rate, pack_time=pack)
                got = _predict(m)
                if got is None:
                    continue
                for key, v in got.items():
                    if isinstance(v, float):
                        assert math.isfinite(v), (count, rate, pack, key, v)
                assert got["in_use_peak"] <= got["pool_size"]
                assert got["throughput_per_hr"] <= got["offered_per_hr"] + 1e-6
