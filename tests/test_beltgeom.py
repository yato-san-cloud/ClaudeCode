"""梱包台は誰のものか — エンジンと解析が同じ答えを読むこと。

``beltgeom`` exists because the rule got hard enough to drift. Both the SimPy
builder and the closed-form oracle need to know which 梱包台 stand at which
引き込み, and while they each kept their own copy the engine learned two things
the oracle did not:

* a 引き込み drawn as ONE belt CROSSING the 本線 discharges at BOTH extremities —
  measured on a real drawing as 4 benches in the run against 2 in the estimate;
* a bench within reach of two pull-ins belongs to the NEARER one and to only one
  — the oracle counted it twice, i.e. sold more servers than the floor has
  people. Rosier than the run is the one direction 不変条件5 forbids.

So these tests pin the rule itself, and then pin that the two readers agree on
it — on the shapes that made them disagree.
"""

from __future__ import annotations

import math

import pytest
from test_line_mechanics import (  # the line fixtures live next door
    INSPECT,
    PACK,
    PICK,
    SHIP,
    _edge,
    _model,
    _through_spur_model,
)

from whsim import analytic, beltgeom
from whsim.engine.build import build
from whsim.schema.model import Conveyor, Station

TRUNK = ("T", [(0.0, 10.0), (40.0, 10.0)])


# ------------------------------------------------------------------ 幾何の規則

def test_project_lands_on_the_path_not_on_the_nearest_corner():
    """A point beside the middle of a bent belt projects onto the SEGMENT."""
    pts = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]
    xy, arc = beltgeom.project((5.0, 3.0), pts)
    assert xy == pytest.approx((5.0, 0.0))
    assert arc == pytest.approx(5.0)
    # ...and past the far corner it clamps to the discharge end, arc = length.
    xy, arc = beltgeom.project((99.0, 99.0), pts)
    assert xy == pytest.approx((10.0, 10.0))
    assert arc == pytest.approx(20.0)


def test_project_survives_a_zero_length_segment():
    """A drawn polyline can repeat a point; that must not divide by zero."""
    xy, arc = beltgeom.project((1.0, 1.0), [(0.0, 0.0), (0.0, 0.0), (4.0, 0.0)])
    assert xy == pytest.approx((1.0, 0.0))
    assert arc == pytest.approx(1.0)


def test_attach_takes_the_nearest_path_and_breaks_ties_by_id():
    belts = [("b", [(0.0, 0.0), (10.0, 0.0)]), ("a", [(0.0, 0.0), (10.0, 0.0)])]
    hit = beltgeom.attach((5.0, 0.2), belts)
    assert hit is not None and hit[0] == "a", "equal distance ⇒ lowest id, every run"
    assert beltgeom.attach((5.0, 5.0), belts) is None, "beyond JOIN_TOL_M: nothing"
    assert beltgeom.attach((5.0, 0.2), belts, exclude={"a", "b"}) is None


def test_a_spur_crossing_a_trunk_discharges_at_both_ends():
    ends = beltgeom.discharge_ends([(20.0, 6.0), (20.0, 14.0)],
                                   [TRUNK, ("S", [(20.0, 6.0), (20.0, 14.0)])],
                                   {"S"})
    assert sorted(ends) == [(20.0, 6.0), (20.0, 14.0)]


def test_a_spur_that_starts_on_the_trunk_discharges_only_at_its_far_end():
    ends = beltgeom.discharge_ends([(20.0, 10.0), (20.0, 16.0)],
                                   [TRUNK, ("S", [(20.0, 10.0), (20.0, 16.0)])],
                                   {"S"})
    assert ends == [(20.0, 16.0)], "本線に接する端は乗り口であって払い出し口ではない"


def test_a_spur_whose_every_end_sits_on_a_trunk_keeps_the_historical_answer():
    """Both ends touching ⇒ ``points[-1]``, never "this spur discharges nowhere"."""
    ends = beltgeom.discharge_ends([(20.0, 10.0), (30.0, 10.0)],
                                   [TRUNK, ("S", [(20.0, 10.0), (30.0, 10.0)])],
                                   {"S"})
    assert ends == [(30.0, 10.0)]


# ------------------------------------------------------------- 梱包台の持ち主

def test_a_shared_bench_belongs_to_the_nearer_pull_in_and_to_only_one():
    spurs = [("A", [(20.0, 10.0), (20.0, 15.0)]), ("B", [(24.0, 10.0), (24.0, 15.0)])]
    belts = [TRUNK, *spurs]
    stations = [(20.5, 15.0, 1), (22.6, 15.0, 1), (24.5, 15.0, 1)]
    pools, claimed = beltgeom.bench_pools(spurs, belts, stations)
    assert pools == {"A": 1, "B": 2}, "mid bench is 2.6 m from A, 1.6 m from B"
    assert claimed == {0, 1, 2}
    assert sum(pools.values()) == sum(s[2] for s in stations), "no bench counted twice"


def test_a_tie_goes_to_the_first_spur_the_caller_resolved():
    """Determinism, not fairness: the same drawing must resolve the same way.

    The loser owns NO bench, which is UNSTAFFED (half-drawn line ⇒ shared pool),
    not CLOSED (a bench is drawn there and deliberately unmanned). Reading the
    loser as closed would silently switch off a pull-in over a rounding tie."""
    spurs = [("A", [(20.0, 10.0), (20.0, 15.0)]), ("B", [(24.0, 10.0), (24.0, 15.0)])]
    belts = [TRUNK, *spurs]
    mid = [(22.0, 15.0, 1)]                       # exactly 2.0 m from both
    assert beltgeom.bench_pools(spurs, belts, mid)[0] == \
        {"A": 1, "B": beltgeom.UNSTAFFED}
    assert beltgeom.bench_pools(spurs[::-1], belts, mid)[0] == \
        {"B": 1, "A": beltgeom.UNSTAFFED}


def test_the_three_answers_are_three_different_things():
    """n / CLOSED / UNSTAFFED — conflating the last two double-books the floor."""
    spurs = [("A", [(20.0, 10.0), (20.0, 15.0)]),   # a bench with people
             ("B", [(24.0, 10.0), (24.0, 15.0)]),   # a bench with nobody on it
             ("C", [(30.0, 10.0), (30.0, 15.0)])]   # no bench drawn at all
    pools, claimed = beltgeom.bench_pools(spurs, [TRUNK, *spurs],
                                          [(20.2, 15.0, 2), (24.2, 15.0, 0)])
    assert pools == {"A": 2, "B": beltgeom.CLOSED, "C": beltgeom.UNSTAFFED}
    assert claimed == {0}, "a bench nobody staffs is not claimed by anyone"


def test_a_bench_out_of_reach_belongs_to_nobody():
    spurs = [("A", [(20.0, 10.0), (20.0, 15.0)])]
    pools, claimed = beltgeom.bench_pools(spurs, [TRUNK, *spurs],
                                          [(20.0, 15.0 + beltgeom.BENCH_REACH_M + 0.1, 4)])
    assert pools == {"A": beltgeom.UNSTAFFED} and claimed == set()


# ------------------------------------------ エンジンと解析が同じ答えを読むこと

def _agree(model) -> tuple[dict, dict]:
    """(engine, oracle) bench counts for the same model, keyed by belt id."""
    world = build(model)
    eng = {c.id: c.n_bench for c in world.conveyors if c.n_bench}
    line = analytic._belt_stages(model)
    ana = {str(cv.id): analytic._spur_benches(model, cv)
           for cv in (line["spurs"] if line else [])}
    return eng, {k: v for k, v in ana.items() if v}


def test_engine_and_oracle_agree_on_a_spur_that_crosses_the_trunk():
    """The shape that made them disagree: engine 4 benches, oracle 2."""
    eng, ana = _agree(_through_spur_model(
        [[20.0, 6.0], [20.0, 14.0]],
        [Station(id="north", x=21.5, y=6.5, count=2),
         Station(id="south", x=21.5, y=13.5, count=2)]))
    assert eng == ana == {"S": 4}


def test_engine_and_oracle_agree_on_a_half_drawn_spur():
    eng, ana = _agree(_through_spur_model(
        [[20.0, 10.0], [20.0, 16.0]],
        [Station(id="far", x=21.0, y=15.5, count=2),
         Station(id="on_trunk", x=21.0, y=10.5, count=5)]))
    assert eng == ana == {"S": 2}


def _two_spur_model(counts, xs=(20.0, 24.0)):
    trunk = Conveyor(id="T", points=[[0.0, 10.0], [40.0, 10.0]], speed_mps=1.0,
                     tote_pitch_m=1.0)
    entry = Conveyor(id="E", points=[[2.0, 2.0], [2.0, 10.0]], speed_mps=1.0,
                     tote_pitch_m=1.0)
    a = Conveyor(id="A", points=[[xs[0], 10.0], [xs[0], 15.0]], speed_mps=0.5,
                 tote_pitch_m=1.0)
    b = Conveyor(id="B", points=[[xs[1], 10.0], [xs[1], 15.0]], speed_mps=0.5,
                 tote_pitch_m=1.0)
    return _model([entry, trunk, a, b],
                  [_edge(PICK, INSPECT, "E"), _edge(INSPECT, PACK, "A"),
                   _edge(INSPECT, PACK, "B"), _edge(PACK, SHIP, "T")],
                  pick_xy=[(3.0, 2.0)], duration=600.0,
                  stations=[Station(id=f"s{i}", x=x, y=15.0, count=n)
                            for i, (x, n) in enumerate(zip(
                                (xs[0] + 0.5, 22.6, xs[1] + 0.5), counts))])


def test_engine_and_oracle_agree_on_a_bench_shared_by_two_spurs():
    eng, ana = _agree(_two_spur_model((1, 1, 1)))
    assert eng == ana == {"A": 1, "B": 2}


def test_engine_and_oracle_agree_that_an_unmanned_pull_in_is_closed():
    """``count: 0`` at a drawn bench ⇒ the pull-in takes nothing, in BOTH readers.

    The oracle used to fall back to a share of the shared pack pool here, which
    hands the spur the whole bench line's capacity a second time — the reading
    that produced packer_utilization 1.28 in the engine before ``closed`` existed.
    """
    m = _two_spur_model((0, 0, 3), xs=(20.0, 30.0))
    world = build(m)
    closed = {c.id for c in world.conveyors if c.closed}
    assert closed == {"A"}, "A の梱包台は描かれているが人が居ない"
    line = analytic._belt_stages(m)
    assert analytic._spur_benches(m, next(c for c in line["spurs"] if c.id == "A")) \
        == beltgeom.CLOSED
    assert [cv.id for cv in analytic._open_spurs(line)] == ["B"]


@pytest.mark.parametrize("template_id", ["line_inspection"])
def test_the_shipped_line_still_resolves_bench_for_bench(template_id):
    """The template this whole machine was drawn for: every spur, both readers."""
    from whsim import templates

    m = templates.load_template_model(template_id)
    world = build(m)
    line = analytic._belt_stages(m)
    assert line is not None
    spur_ids = {str(s.id) for ln in world.conveyors for _a, s in ln.junctions}
    assert spur_ids, "the template must actually hang 引き込み off its 本線"
    for ln in world.conveyors:
        if str(ln.id) in spur_ids and ln.bench is not None:
            cv = next(c for c in line["spurs"] if str(c.id) == str(ln.id))
            assert analytic._spur_benches(m, cv) == ln.n_bench, ln.id


def test_the_engine_re_exports_the_shared_constants():
    """不変条件11: one source beats a mirrored constant plus a parity test."""
    from whsim.engine import build as build_mod

    assert build_mod.JOIN_TOL_M is beltgeom.JOIN_TOL_M
    assert build_mod.BENCH_REACH_M is beltgeom.BENCH_REACH_M
    assert analytic._JOIN_TOL_M is beltgeom.JOIN_TOL_M
    assert analytic._BENCH_REACH_M is beltgeom.BENCH_REACH_M


def test_project_matches_the_engines_own_conveyor_line():
    """``ConveyorLine.project`` delegates here; prove it on a bent belt."""
    m = _through_spur_model([[20.0, 6.0], [20.0, 14.0]],
                            [Station(id="n", x=21.5, y=6.5, count=2)])
    ln = next(c for c in build(m).conveyors if c.id == "T")
    for p in [(5.0, 3.0), (-4.0, 20.0), (39.0, 10.0), (100.0, -100.0)]:
        assert ln.project(p) == beltgeom.project(p, ln.points, ln.seglens)
        assert math.isfinite(ln.project(p)[1])
