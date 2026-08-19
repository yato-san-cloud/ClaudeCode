"""引き込みバンク＝逐次オーバーフローの待ち行列縦続 (the DEFAULT ``auto`` path).

``analytic._steady_block`` used to price the 引き込み bank by offering each pull-in
``λ/n`` and averaging its ``_mmck_full``. 貪欲ディバート does not split anything:
``processes._convey_chain`` turns into the FIRST junction with room, so the bank is
an ORDERED hunt group, and what overflows it is not lost — a load that finds every
pull-in full stalls on the 本線 holding its slot. The split therefore reads ROSIER
than the run from ρ_bank ≈ 0.85 upwards (202 of 270 synthetic configurations at
8 h, worst −0.815; the shipped ``line_inspection`` at 2× demand blocks 0.52 in the
run and read 0.00), and rosy is the one direction invariant 5 forbids. This is the
DEFAULT divert policy, so the hole is wider than the three opt-in mechanisms of
invariant 17.

These tests pin:

* each helper of the cascade on its own — the water-filling rate profile, the
  ride-in dead time, the finite-horizon walk, and the cascade's own shape;
* the CONTRACT with ``engine.build``: the bank is its junction list, in its order,
  with its bench counts, and a pull-in is closed exactly when ``build`` closes it;
* the catalogue's ``block_ratio_est`` byte for byte — every bundled template runs
  far enough under capacity that the historical split floor still wins, so not one
  shipped number may move;
* and the direction itself: over a real DES the estimate must not read rosier.

The cascade is VALIDATED, not proved. Nothing in it is an upper bound — see
``_overflow_cascade``'s docstring for which of its three readings covers which end
of the range — so what these tests defend is the measured direction, not an
inequality that holds by construction.
"""

from __future__ import annotations

import math
import random
import time

import pytest

from whsim import analytic, beltgeom, kpis, templates
from whsim.engine.run import run_replications
from whsim.schema.model import (
    Bounds,
    Conveyor,
    FlowEdge,
    Item,
    Layout,
    Location,
    Station,
    WarehouseModel,
    WorkerGroup,
    Zone,
)

_PICK_TO_LINE = {"src": "ピッキング", "dst": "検品", "transport": "conveyor"}
_LINE_TO_PACK = {"src": "検品", "dst": "梱包", "transport": "conveyor"}
_PACK_ONWARD = {"src": "梱包", "dst": "出荷", "transport": "conveyor"}


def _bank_model(*, benches, spur_slots, trunk_slots: int = 30,
                entry_slots: int = 60, pack_time_s: float = 60.0,
                rho_bank: float = 1.0, duration_s: float = 28800.0,
                reps: int = 1, pickers: int = 40,
                pitch_m: float = 6.0) -> WarehouseModel:
    """検品ライン → 本線 → a bank of 引き込み, each with its own 梱包台.

    ``benches``/``spur_slots`` are per pull-in and may differ, so the bank's shape
    is authored rather than uniform. ``rho_bank`` is offered load over the bank's
    nominal service capacity (``λ·τ / Σ梱包台``) — the axis the rosy band lives on.
    """
    n = len(benches)
    entry_len, spur_len = 30.0, 3.0
    trunk_len = pitch_m * (n + 1)
    m = WarehouseModel()
    m.layout = Layout(bounds=Bounds(width=entry_len + trunk_len + 10.0, depth=40.0),
                      zones=[Zone(id="storage", type="storage",
                                  x=1.0, y=10.0, w=20.0, h=16.0)])
    m.locations = [Location(id=f"L{i}", x=2.0 + (i % 8) * 1.5, y=12.0 + (i // 8))
                   for i in range(24)]
    m.items = [Item(sku=f"L{i}", ts_per_unit=0.2) for i in range(24)]

    belts = [Conveyor(id="E", points=[[0.0, 0.0], [entry_len, 0.0]],
                      speed_mps=2.0, tote_pitch_m=entry_len / entry_slots),
             Conveyor(id="T", points=[[entry_len, 0.0], [entry_len + trunk_len, 0.0]],
                      speed_mps=2.0, tote_pitch_m=trunk_len / trunk_slots)]
    edges = [FlowEdge(id="e_E", equipment_ref="E", **_PICK_TO_LINE),
             FlowEdge(id="e_T", equipment_ref="T", **_PACK_ONWARD)]
    stations = []
    for j, (b, k) in enumerate(zip(benches, spur_slots)):
        sx = entry_len + pitch_m * (j + 1)
        sid = f"S{j}"
        belts.append(Conveyor(id=sid, points=[[sx, 0.0], [sx, spur_len]],
                              speed_mps=2.0, tote_pitch_m=spur_len / k))
        edges.append(FlowEdge(id=f"e_{sid}", equipment_ref=sid, **_LINE_TO_PACK))
        stations.append(Station(id=f"b{j}", x=sx, y=spur_len + 1.0, count=b,
                                w=1.2, d=0.8))

    m.resources.conveyors = belts
    m.resources.stations = stations
    m.resources.workers = [WorkerGroup(role="picker", count=pickers)]
    m.process.pack_time_s = pack_time_s
    m.process.flow_edges = edges
    m.process.walk_speed_mps = 1.2
    m.orders.profile.rate_per_hr = rho_bank * sum(benches) / pack_time_s * 3600.0
    m.orders.profile.peak_factor = 1.0
    m.orders.profile.lines_per_order_mean = 1.0
    m.simulation.duration_s = duration_s
    m.simulation.replications = reps
    m.simulation.random_seed = 7
    return m


def _build_world(model: WarehouseModel):
    """The world ``run_replications`` would run, without running it."""
    import simpy

    from whsim.engine.build import build
    return build(model, simpy.Environment())


def _live_line(model: WarehouseModel):
    """``_belt_stages`` narrowed to the OPEN spurs, i.e. what ``_steady_block`` sees."""
    line = analytic._belt_stages(model)
    open_ids = {str(cv.id) for cv in analytic._open_spurs(line)}
    closed = {str(cv.id) for cv in line["spurs"]} - open_ids
    stages = [st for st in ([cv for cv in st if str(cv.id) not in closed]
                            for st in line["stages"]) if st]
    return {**line, "stages": stages}


# ------------------------------------------------------------------ 各ヘルパ

def test_a_short_pull_in_pays_the_ride_in_as_dead_bench_time():
    """``_spur_serve_s``: the 梱包台 idles through the ride unless somebody queued.

    ``K − c`` waiting positions drain at ``c/τ`` and cover ``(K−c)·τ/c`` seconds of
    the ride. With ``K ≤ c`` nothing is covered and the bench pays the ride every
    cycle — a real capacity loss the bench count alone cannot show.
    """
    tau, ride = 60.0, 5.0
    # K > c: one waiting position covers 60 s of a 5 s ride, so the cycle is τ.
    assert analytic._spur_serve_s(tau, 2, 3, ride) == pytest.approx(tau)
    assert analytic._spur_serve_s(tau, 2, 20, ride) == pytest.approx(tau)
    # K == c and K < c: no accumulation at all, so every cycle carries the ride.
    assert analytic._spur_serve_s(tau, 2, 2, ride) == pytest.approx(tau + ride)
    assert analytic._spur_serve_s(tau, 4, 2, ride) == pytest.approx(tau + ride)
    # A ride longer than the room behind it is only PARTLY covered.
    assert analytic._spur_serve_s(tau, 2, 3, tau) == pytest.approx(tau + tau / 2.0)
    # Degenerate inputs still return a usable service time (never blocks).
    assert analytic._spur_serve_s(0.0, 0, 0, 0.0) > 0.0
    # ...and the bundled 出荷ライン (5 slots, 2 benches, τ = 78 s) is untouched.
    m = templates.load_template_model("line_inspection")
    line = _live_line(m)
    bank = analytic._bank_of(line, line["stages"],
                             analytic._open_spurs(line), 20, m.process.pack_time_s)
    assert [serve for _c, _k, serve in bank] == [pytest.approx(78.0)] * len(bank)


def test_the_rate_profile_fills_the_pull_ins_in_junction_order():
    """``_bank_rate_profile``: 梱包 completions/s available with N loads standing.

    貪欲ディバート piles into spur 1 until its slots are gone, so the Nth load lands
    where water-filling puts it. A spur holding ``n`` works ``min(n, c)`` benches:
    the 3rd load into a 2-bench pull-in works no extra bench at all.
    """
    #        spur A: 2 benches, 3 slots, 10 s   |   spur B: 1 bench, 2 slots, 20 s
    prof = analytic._bank_rate_profile([(2, 3, 10.0), (1, 2, 20.0)])
    assert prof == pytest.approx([0.0, 0.1, 0.2, 0.2, 0.25, 0.25])
    assert len(prof) == 3 + 2 + 1                    # ΣK + 1 states
    assert all(prof[i] >= prof[i - 1] - 1e-15 for i in range(1, len(prof)))
    # The full-bank rate is every bench of every pull-in working at once.
    assert prof[-1] == pytest.approx(2 / 10.0 + 1 / 20.0)
    assert analytic._bank_rate_profile([]) == [0.0]


def test_the_queue_prefactor_is_a_probability_and_certain_at_capacity():
    """``_queue_prefactor``: P(a queue formed behind the 梱包台 at ALL).

    Without it the horizon walk prices the geometric tail as if a queue always
    existed, which read a 6-bench pull-in at ρ_bank = 0.33 as blocking 0.111 where
    the chain and the run both say 0.002.
    """
    prof = analytic._bank_rate_profile([(2, 6, 60.0)])
    full = prof[-1]
    idle = analytic._queue_prefactor(prof, 2, 0.2 * full)
    busy = analytic._queue_prefactor(prof, 2, 0.9 * full)
    assert 0.0 <= idle < busy <= 1.0
    # At and over capacity there is no stationary law to take it from, and a queue
    # is certainly there.
    assert analytic._queue_prefactor(prof, 2, full) == 1.0
    assert analytic._queue_prefactor(prof, 2, 3.0 * full) == 1.0
    # A bank nobody works, and a line nobody feeds.
    assert analytic._queue_prefactor([0.0, 0.0], 0, 1.0) == 1.0
    assert analytic._queue_prefactor(prof, 2, 0.0) == 1.0


def test_the_finite_horizon_walk_is_a_share_of_the_shift():
    """``_fill_share``: how much of a run of length T a queue ``depth`` deep is full.

    At ρ = 1 the queue is null recurrent — no steady state at all — so the answer
    is a property of the SHIFT and must grow with it. It is a diffusion
    approximation and not a bound; what is pinned here is its shape.
    """
    depth, var, hour = 20.0, 2.0 * 0.2, 3600.0
    # A share, always.
    for d in (0.0, 1.0, 20.0, 400.0):
        for delta in (-0.05, 0.0, 0.05):
            assert 0.0 <= analytic._fill_share(d, delta, var, hour) <= 1.0
    # Nothing to fill, or no time to fill it in.
    assert analytic._fill_share(0.0, 0.1, var, hour) == 0.0
    assert analytic._fill_share(-3.0, 0.1, var, hour) == 0.0
    assert analytic._fill_share(depth, 0.1, var, 0.0) == 0.0
    assert analytic._fill_share(depth, 0.1, 0.0, hour) == 0.0
    # Deeper is harder to fill; a longer shift spends more of itself full.
    deeper = [analytic._fill_share(d, 0.0, var, hour) for d in (1.0, 5.0, 20.0, 80.0)]
    assert all(deeper[i] <= deeper[i - 1] + 1e-12 for i in range(1, len(deeper)))
    longer = [analytic._fill_share(depth, 0.0, var, t)
              for t in (hour, 8 * hour, 24 * hour)]
    assert all(longer[i] >= longer[i - 1] - 1e-12 for i in range(1, len(longer)))
    assert longer[-1] > longer[0], "null recurrence: it must keep growing with T"
    # An over-fed line fills and stays full; an idle one never does. The geometric
    # tail is what makes the second one read as EMPTY rather than merely rare.
    assert analytic._fill_share(depth, 0.5, var, 24 * hour) > 0.9
    assert analytic._fill_share(depth, -0.5, var, hour, tail=0.1) < 1e-9


def test_the_cascade_fills_downstream_first_and_never_eases_with_demand():
    """``_overflow_cascade`` over ~400 random banks: the two shapes it must have.

    The levels are cumulative — 引き込み at ΣK, 本線 at ΣK + K_trunk, 検品ライン
    behind that — so an upstream stage cannot be fuller than the one it feeds, and
    no stage can block LESS when more is offered.
    """
    rng = random.Random(20260819)
    for _ in range(400):
        n = rng.randint(1, 6)
        bank = [(rng.randint(1, 4), rng.randint(1, 20),
                 rng.uniform(5.0, 120.0)) for _ in range(n)]
        upstream = [rng.randint(0, 80) for _ in range(rng.randint(0, 3))]
        full = analytic._bank_rate_profile(bank)[-1]
        horizon = rng.choice((3600.0, 28800.0, 64800.0))
        lams = sorted(rng.uniform(0.05, 2.5) * full for _ in range(3))

        prev = None
        for lam in lams:
            out = analytic._overflow_cascade(bank, upstream, lam, full, horizon)
            assert len(out) == 1 + len(upstream)
            assert all(0.0 <= p <= 1.0 for p in out)
            # 下流ほど先に埋まる: index 0 is the 引き込み stage, the rest go upstream.
            assert all(out[i] <= out[i - 1] + 1e-12 for i in range(1, len(out))), out
            if prev is not None:
                assert all(a >= b - 1e-9 for a, b in zip(out, prev)), (out, prev)
            prev = out


def test_the_cascade_degenerates_without_ever_blocking_the_estimate():
    """No bank, no hands, no arrivals, and a 20,000-slot line — all inside budget."""
    # No 引き込み at all: the caller keeps its historical single-belt answer.
    assert analytic._overflow_cascade([], [40], 0.1, 0.2, 3600.0) == []
    # Drawn but nobody can pack: the bank fills once and never drains.
    assert analytic._overflow_cascade([(0, 4, 60.0)], [40], 0.1, 0.2, 3600.0) \
        == [1.0, 1.0]
    assert analytic._overflow_cascade([(2, 0, 60.0)], [], 0.1, 0.2, 3600.0) == [1.0]
    # No arrivals ⇒ an empty line, whatever the shape. The diffusion cannot say
    # this on its own (its tail is ``(λ/capacity)^d`` and ``log 0`` is not a
    # number), and read a warehouse with no orders as 5% blocked.
    assert analytic._overflow_cascade([(2, 5, 60.0)], [30, 60], 0.0, 0.2, 3600.0) \
        == [0.0, 0.0, 0.0]
    assert analytic._overflow_cascade([(2, 5, 60.0)], [30], -1.0, 0.2, 3600.0) \
        == [0.0, 0.0]
    # A 100 m belt drawn at a 5 mm pitch is 20,000 slots. The chain is capped, and
    # the whole answer still has to fit inside the 爆速 budget.
    t0 = time.perf_counter()
    out = analytic._overflow_cascade([(4, 20000, 60.0)], [20000, 20000],
                                     0.07, 0.0666, 28800.0)
    assert (time.perf_counter() - t0) < 0.05
    assert len(out) == 3 and all(0.0 <= p <= 1.0 for p in out)


def test_a_pipeline_stage_only_buffers_the_slots_no_load_is_riding():
    """``_stage_room``: at rate λ a share λ/rate of a belt is already under a load.

    Counting the whole belt as free buffer puts the jam later than the run has it.
    """
    belt = Conveyor(id="T", points=[[0.0, 0.0], [30.0, 0.0]],
                    speed_mps=2.0, tote_pitch_m=0.5)      # 60 slots, 4 loads/s
    assert analytic.belt_slots(belt) == 60
    assert analytic._stage_room([belt], 0.0) == 60
    assert analytic._stage_room([belt], 2.0) == 30        # half of it is moving
    assert analytic._stage_room([belt], 4.0) == 0
    assert analytic._stage_room([belt], 40.0) == 0        # never negative
    assert analytic._stage_room([], 1.0) == 0


# --------------------------------------------------- エンジンとの契約 (不変条件11)

def test_the_bank_is_the_junction_list_the_engine_wires_in_its_own_order():
    """``_bank_of`` == ``ConveyorLine.junctions``: same pull-ins, same order, same 台.

    Junction order is the order 貪欲ディバート scans in, so it is the order loads pile
    up in — and the water-filling profile is only the engine's story if the two
    agree. The bank here is deliberately UNEVEN (1/3/2/4 benches, 2/8/5/3 slots) so
    a wrong order cannot hide behind identical pull-ins.
    """
    benches, slots = [1, 3, 2, 4], [2, 8, 5, 3]
    m = _bank_model(benches=benches, spur_slots=slots)
    world = _build_world(m)
    line = _live_line(m)
    bank = analytic._bank_of(line, line["stages"], analytic._open_spurs(line),
                             sum(benches), m.process.pack_time_s)

    wired = [(s.id, s.n_bench, s.capacity)
             for ln in world.conveyors for _arc, s in ln.junctions]
    assert [sid for sid, _b, _k in wired] == ["S0", "S1", "S2", "S3"]
    assert [(c, k) for c, k, _s in bank] == [(b, k) for _sid, b, k in wired]


@pytest.mark.parametrize("spare_bench", [False, True])
def test_an_unstaffed_pull_in_is_closed_exactly_when_the_engine_closes_it(spare_bench):
    """``_open_spurs`` == ``build``: 誰も立っていない引き込みは余り台があるときだけ動く.

    ``build`` closes a pull-in TWICE over: once for ``beltgeom.NO_HANDS``, and again
    in its second pass — ``if claimed and spare == 0`` — for every pull-in with no
    private bench. Only the first was mirrored here, so a drawing whose benches are
    all spoken for kept an open lane in the estimate that the run does not wire:
    its rate and its slots went into the stage arithmetic, inflating both the
    line's ceiling and its buffer. Rosy, which is the one direction invariant 5
    forbids.

    With a bench nobody owns (``spare_bench``) the pull-in really does run — it
    borrows the 余り台, exactly what ``World.spare_bench`` lends it — so the fix
    must not close it either.
    """
    m = _bank_model(benches=[2, 2], spur_slots=[4, 4])
    # A third 引き込み with NOBODY drawn within reach of its discharge end.
    sx = 30.0 + 6.0 * 3
    m.resources.conveyors.append(
        Conveyor(id="S2", points=[[sx, 0.0], [sx, 3.0]], speed_mps=2.0,
                 tote_pitch_m=3.0 / 4))
    m.process.flow_edges.append(
        FlowEdge(id="e_S2", equipment_ref="S2", **_LINE_TO_PACK))
    if spare_bench:
        # 誰の持ち物でもない梱包台 — far from every discharge end, so unclaimed.
        m.resources.stations.append(Station(id="spare", x=5.0, y=25.0, count=3))

    line = analytic._belt_stages(m)
    assert line["benches"]["S2"] is beltgeom.UNSTAFFED, "nobody is drawn at S2"
    assert line["spare"] == (3 if spare_bench else 0)

    world = _build_world(m)
    closed = {ln.id for ln in world.conveyors if ln.closed}
    wired = {s.id for ln in world.conveyors for _arc, s in ln.junctions}
    priced = {str(cv.id) for cv in analytic._open_spurs(line)}
    assert priced == wired
    assert priced == {str(cv.id) for cv in line["spurs"]} - closed
    assert ("S2" in priced) is spare_bench

    # A borrowed pull-in is worked by the 余り台 and NOTHING else: the bank must
    # give it the 3 unclaimed benches, not a share of the whole packing floor
    # (which would book the two staffed pull-ins' people a second time).
    live = _live_line(m)
    bank = analytic._bank_of(live, live["stages"], analytic._open_spurs(live),
                             sum(s.count for s in m.resources.stations),
                             m.process.pack_time_s)
    assert [c for c, _k, _s in bank] == ([2, 2, 3] if spare_bench else [2, 2])
    assert 0.0 <= analytic.estimate(m)["conveyor"]["block_ratio_est"] <= 1.0


def test_the_estimate_and_the_engine_read_the_same_bank_on_the_shipped_line():
    """The bundled 出荷ライン: 10 引き込み, 2 台 each, in trunk-arc order."""
    m = templates.load_template_model("line_inspection")
    world = _build_world(m)
    line = _live_line(m)
    bank = analytic._bank_of(line, line["stages"], analytic._open_spurs(line),
                             20, m.process.pack_time_s)

    wired = [(s.id, s.n_bench, s.capacity)
             for ln in world.conveyors for _arc, s in ln.junctions]
    assert len(wired) == 10
    assert [(c, k) for c, k, _s in bank] == [(b, k) for _sid, b, k in wired]


# ------------------------------------------------------- カタログはバイト同一

# The 3 bundled templates that run a belt. Every one of them is far enough under
# its line's capacity that the cascade is ~1e-6 and the historical per-spur SPLIT
# floor wins the ``max()``, so these are the values the catalogue has always had.
# They are spelled out rather than compared against a re-run of the old code
# because that is the point: no shipped proposal may move by an ulp.
_CATALOGUE_BLOCK_RATIO = {
    "food_chilled": 0.000380693628316643,
    "line_inspection": 0.007902949750538416,
    "pick_to_belt": 9.45686701906052e-23,
}


@pytest.mark.parametrize("template_id", sorted(_CATALOGUE_BLOCK_RATIO))
def test_the_shipped_block_ratios_are_the_bytes_they_have_always_been(template_id):
    m = templates.load_template_model(template_id)
    cv = analytic.estimate(m)["conveyor"]
    assert cv is not None
    assert cv["block_ratio_est"] == _CATALOGUE_BLOCK_RATIO[template_id]


def test_the_split_floor_is_what_the_shipped_line_is_still_priced_by():
    """``line_inspection``: the cascade is ~1e-6 and loses to the split, by design.

    The split is a genuine upper bound while the bank is comfortably under
    capacity, which is the whole bundled catalogue — so it is kept as a FLOOR and
    the cascade only ever makes the answer gloomier.
    """
    m = templates.load_template_model("line_inspection")
    line = _live_line(m)
    stages = line["stages"]
    spurs = analytic._open_spurs(line)
    lam = m.orders.profile.rate_per_hr * m.orders.profile.peak_factor / 3600.0
    n_pack = sum(s.count for s in m.resources.stations)

    bank = analytic._bank_of(line, stages, spurs, n_pack, m.process.pack_time_s)
    upstream = [analytic._stage_room(st, lam) for st in reversed(stages[:-1])]
    cap = min(min(sum(analytic._belt_rate(cv) for cv in st) for st in stages),
              n_pack / m.process.pack_time_s)
    parts = analytic._overflow_cascade(bank, upstream, lam, cap,
                                       float(m.simulation.duration_s))

    cascade = sum(parts) / len(stages)
    assert cascade < 1e-4
    assert cascade < _CATALOGUE_BLOCK_RATIO["line_inspection"]
    assert analytic._steady_block(m, line, lam, n_pack, m.process.pack_time_s,
                                  cap, float(m.simulation.duration_s)) \
        == _CATALOGUE_BLOCK_RATIO["line_inspection"]


def test_the_cascade_keeps_the_estimate_inside_its_live_re_estimation_budget():
    """爆速 (50 ms): the scorecard re-estimates while the mouse is still down.

    The bank walk is O(slots) and ``line_inspection`` is the deepest chain shipped,
    so it is the one that would notice a regression into a per-state search.
    """
    for tid in ("line_inspection", "pick_to_belt"):
        m = templates.load_template_model(tid)
        analytic.estimate(m)                       # warm caches / lazy imports
        best = min(_timed(m) for _ in range(5))
        assert best < 0.05, f"{tid}: analytic.estimate took {best * 1000:.1f} ms"


def _timed(m) -> float:
    t0 = time.perf_counter()
    analytic.estimate(m)
    return time.perf_counter() - t0


# --------------------------------------------------------- 不変条件5: 甘い側は禁止

@pytest.mark.parametrize("rho_bank", [0.9, 1.0, 1.1])
def test_the_estimate_is_never_rosier_than_the_run_around_capacity(rho_bank):
    """解析 ≥ DES on the band the split got wrong: ρ_bank 0.9 / 1.0 / 1.1.

    This is the band the whole re-derivation exists for. The split read this bank
    at 0.074 where the run blocks 0.43 (ρ_bank = 1.0); an oracle may read a jam
    gloomier than the run, never rosier — a proposal that promises a clear line and
    meets a jam on site is the failure this module exists to prevent.

    The margin is the DES's own rep-to-rep spread, not slack in the closed form:
    ``conveyor_block_ratio`` at the critical point swings by tenths between
    replications, so the run is averaged over 4 of them and the assertion carries
    2 points of tolerance.
    """
    m = _bank_model(benches=[2, 2, 2], spur_slots=[4, 4, 4],
                    rho_bank=rho_bank, reps=4)
    est = analytic.estimate(m)["conveyor"]
    results, _ = run_replications(m)
    sim = kpis.compute(results, m)

    assert sim["conveyor_block_ratio"] > 0.02, "the run must actually block"
    assert est["block_ratio_est"] >= sim["conveyor_block_ratio"] - 0.02, (
        f"rosier than the run: {est['block_ratio_est']:.4f} "
        f"< {sim['conveyor_block_ratio']:.4f}")
    assert est["block_ratio_est"] <= 1.0


def test_the_shipped_line_at_double_demand_is_not_read_rosier_than_the_run():
    """``line_inspection`` × 2 — the case that was SEVEN TIMES rosy.

    Offered 950/hr against a 923/hr line: barely over capacity, so the old fluid
    reading charged ONE fill time for the whole buffer and came out at 0.00 where
    the run blocks about half of all hand-overs. The bank's three levels do not
    fill together — 引き込み after 1.9 h of the shift, 本線 after 3.5 h, 検品ライン
    after 6.2 h — which is exactly what the cascade prices.
    """
    m = templates.load_template_model("line_inspection")
    m.orders.profile.rate_per_hr *= 2.0
    m.simulation.replications = 4

    est = analytic.estimate(m)["conveyor"]
    results, _ = run_replications(m)
    sim = kpis.compute(results, m)

    assert est["jams"] is True
    assert sim["conveyor_block_ratio"] > 0.3, "the run must actually jam"
    assert est["block_ratio_est"] >= sim["conveyor_block_ratio"], (
        f"rosier than the run: {est['block_ratio_est']:.4f} "
        f"< {sim['conveyor_block_ratio']:.4f}")
    # ...and gloomy is not the same as useless: still the right order of magnitude.
    assert est["block_ratio_est"] <= sim["conveyor_block_ratio"] * 2.0


def test_a_bank_far_under_capacity_still_reads_as_a_clear_line():
    """Gloomy where it must be, quiet where it must be — the other failure mode.

    A cascade that answered "blocked" everywhere would satisfy invariant 5 and be
    worthless. At a third of capacity the run blocks essentially nothing and the
    estimate has to agree.
    """
    m = _bank_model(benches=[2, 2, 2], spur_slots=[4, 4, 4],
                    rho_bank=0.33, reps=2)
    est = analytic.estimate(m)["conveyor"]
    results, _ = run_replications(m)
    sim = kpis.compute(results, m)

    assert est["jams"] is False
    assert sim["conveyor_block_ratio"] < 0.02
    assert est["block_ratio_est"] < 0.05
    assert est["block_ratio_est"] >= sim["conveyor_block_ratio"] - 0.02


def test_the_cascade_only_prices_the_default_divert_policy():
    """``auto`` only: ``pull`` and 停止線 are routed to ``linemech`` before this.

    Under "pull" nothing piles into the first pull-in — a load rides past a bench
    that is not free instead of waiting — so water-filling is the wrong shape
    entirely. ``_line_estimate`` must never reach ``_conveyor_estimate`` there.
    """
    m = _bank_model(benches=[2, 2, 2], spur_slots=[4, 4, 4], rho_bank=1.0)
    lam = m.orders.profile.rate_per_hr / 3600.0
    auto = analytic._line_estimate(m, lam, 6, m.process.pack_time_s, 28800.0)

    m.process.divert_policy = "pull"
    called = []
    real = analytic._conveyor_estimate
    analytic._conveyor_estimate = lambda *a, **k: called.append(1) or real(*a, **k)
    try:
        pull = analytic._line_estimate(m, lam, 6, m.process.pack_time_s, 28800.0)
    finally:
        analytic._conveyor_estimate = real

    assert not called, "pull must not be priced by the greedy cascade"
    assert pull is not None and pull != auto
    assert math.isfinite(auto["block_ratio_est"])
