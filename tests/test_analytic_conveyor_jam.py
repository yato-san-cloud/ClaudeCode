"""コンベア詰まり — the belt chain, in closed form and in the KPIs.

The engine chains the drawn belts into ONE line (検品ライン → 本線 → 引き込み → 梱包台):
a tote holds a slot on every belt it rides, releases the 引き込み's slot only when
packing finishes, and a full 引き込み therefore backs pressure up the chain until
the picker cannot let go. That is a MECHANISM the engine has — so by invariant 5
the analytic oracle must have it too, or the instant estimate goes on promising a
throughput the line physically cannot pass and the DES that follows it says the
opposite.

These tests pin:

* the closed form against its hand derivation (capacity, time-to-jam, which
  stage binds), including the throttle it puts on the picker,
* that the whole catalogue is byte-identical — every bundled template runs BELOW
  its line's capacity, so nothing existing may move,
* the mirrors of ``engine.build`` this module keeps (slot rule / join tolerance /
  bench reach), and
* 解析↔DES agreement on a deliberately over-fed line.
"""

from __future__ import annotations

import math

import pytest

from whsim import analytic, kpis, templates
from whsim.engine.run import run_replications
from whsim.schema.model import (
    Bounds,
    Conveyor,
    FlowEdge,
    Layout,
    Location,
    Station,
    WarehouseModel,
    WorkerGroup,
    Zone,
)

# The two conveyor legs a chained line needs, in the vocabulary the default
# work-process master uses (``analysis.staffing.process_master``): 出庫 hands to
# the line (entry belt), and the line delivers to 梱包 (the 引き込み).
_PICK_TO_LINE = {"src": "ピッキング", "dst": "検品", "transport": "conveyor"}
_LINE_TO_PACK = {"src": "検品", "dst": "梱包", "transport": "conveyor"}
_PACK_ONWARD = {"src": "梱包", "dst": "出荷", "transport": "conveyor"}


def _line_model(*, belts, edges, stations, pack_time_s, rate_per_hr,
                pickers=4, duration_s=28800.0) -> WarehouseModel:
    """A bare warehouse whose only interesting feature is its conveyor line."""
    m = WarehouseModel()
    m.layout = Layout(bounds=Bounds(width=60.0, depth=30.0),
                      zones=[Zone(id="storage", type="storage",
                                  x=0.0, y=8.0, w=40.0, h=18.0)])
    m.locations = [Location(id=f"L{i}", x=2.0 + i, y=12.0) for i in range(10)]
    m.resources.conveyors = belts
    m.resources.stations = stations
    m.resources.workers = [WorkerGroup(role="picker", count=pickers)]
    m.process.pack_time_s = pack_time_s
    m.process.flow_edges = edges
    m.orders.profile.rate_per_hr = rate_per_hr
    m.orders.profile.peak_factor = 1.0
    m.simulation.duration_s = duration_s
    return m


def _entry_and_spur(rate_per_hr: float, *, benches: int, pack_time_s: float,
                    **kw) -> WarehouseModel:
    """20 m entry belt → a 4 m 引き込み with ``benches`` 梱包台 at its end.

    Both belts carry totes every 0.5 m at 1 m/s, i.e. 2 totes/s — comfortably
    above anything the packing bench can absorb, so PACKING is the constraint and
    the belts are pure buffer (40 + 8 = 48 slots).
    """
    return _line_model(
        belts=[Conveyor(id="E", points=[[0.0, 0.0], [20.0, 0.0]],
                        speed_mps=1.0, tote_pitch_m=0.5),
               Conveyor(id="S", points=[[20.0, 0.0], [20.0, 4.0]],
                        speed_mps=1.0, tote_pitch_m=0.5)],
        edges=[FlowEdge(id="e1", equipment_ref="E", **_PICK_TO_LINE),
               FlowEdge(id="e2", equipment_ref="S", **_LINE_TO_PACK)],
        stations=[Station(id="bench", x=20.0, y=5.0, count=benches)],
        pack_time_s=pack_time_s, rate_per_hr=rate_per_hr, **kw)


# ----------------------------------------------------------------- closed form

def test_an_over_fed_line_jams_at_the_hand_derived_moment():
    """λ 0.1/s into a line that passes 0.05/s: the 48 slots fill in 960 s."""
    m = _entry_and_spur(360.0, benches=1, pack_time_s=20.0)
    cv = analytic.estimate(m)["conveyor"]

    assert cv["jams"] is True
    # capacity = benches / pack_time = 1/20 s = 0.05/s; the belts pass 2.0/s each.
    assert cv["binding"] == "pack"
    assert cv["capacity_per_hr"] == pytest.approx(180.0)
    assert cv["offered_per_hr"] == pytest.approx(360.0)
    # buffer = 20 m / 0.5 m + 4 m / 0.5 m = 40 + 8 slots, filling at λ − capacity.
    assert cv["buffer_slots"] == 48
    assert cv["time_to_jam_s"] == pytest.approx(48.0 / (0.1 - 0.05))
    assert 0.0 <= cv["block_ratio_est"] <= 1.0


def test_the_line_not_the_demand_sets_the_pace_once_it_jams():
    """The jam throttles the picker, exactly as a saturated AGV fleet does.

    Two identical lines offered 360 and 720 orders/hr pass the SAME work: above
    ``capacity_line`` the 引き込み is full, the jam has walked back up the chain and
    the picker is standing with totes it cannot hand over. Reporting the picker at
    the offered rate would promise a throughput the line cannot pass.
    """
    slow = analytic.estimate(_entry_and_spur(360.0, benches=1, pack_time_s=20.0))
    fast = analytic.estimate(_entry_and_spur(720.0, benches=1, pack_time_s=20.0))

    assert slow["conveyor"]["jams"] and fast["conveyor"]["jams"]
    assert fast["picker_utilization"] == pytest.approx(slow["picker_utilization"])
    assert fast["service_time_s"] == pytest.approx(slow["service_time_s"])
    # ...and the extra demand only makes it jam SOONER, never faster.
    assert fast["conveyor"]["time_to_jam_s"] < slow["conveyor"]["time_to_jam_s"]
    assert fast["conveyor"]["capacity_per_hr"] == slow["conveyor"]["capacity_per_hr"]


def test_a_line_under_its_capacity_does_not_jam_and_does_not_throttle():
    """6 benches pass 1080/hr against 360/hr offered: steady, no throttle at all."""
    m = _entry_and_spur(360.0, benches=6, pack_time_s=20.0)
    est = analytic.estimate(m)
    cv = est["conveyor"]

    assert cv["jams"] is False
    assert cv["time_to_jam_s"] is None
    assert cv["capacity_per_hr"] == pytest.approx(1080.0)
    assert 0.0 <= cv["block_ratio_est"] < 0.05      # a reference value, not a jam
    assert est == _without_conveyor_mechanism(m) | {"conveyor": cv}


def test_a_slow_belt_binds_and_is_named_by_its_own_id():
    """A 0.05 m/s 本線 between a fast entry and a fast 引き込み is the constraint.

    The buffer that has to fill is everything from the picker's hand-off UP TO the
    slow belt — the 引き込み behind it drains fine, so counting its slots would
    promise a later jam than the line has.
    """
    m = _line_model(
        belts=[Conveyor(id="E", points=[[0.0, 0.0], [20.0, 0.0]], speed_mps=1.0),
               Conveyor(id="T", points=[[20.0, 0.0], [40.0, 0.0]], speed_mps=0.05),
               Conveyor(id="S", points=[[30.0, 0.0], [30.0, 3.0]], speed_mps=1.0)],
        edges=[FlowEdge(id="e1", equipment_ref="E", **_PICK_TO_LINE),
               FlowEdge(id="e2", equipment_ref="S", **_LINE_TO_PACK),
               FlowEdge(id="e3", equipment_ref="T", **_PACK_ONWARD)],
        stations=[Station(id="bench", x=30.0, y=4.0, count=5)],
        pack_time_s=20.0, rate_per_hr=360.0)

    stages = analytic._belt_stages(m)
    assert [[c.id for c in st] for st in stages["stages"]] == [["E"], ["T"], ["S"]]

    cv = analytic.estimate(m)["conveyor"]
    assert cv["binding"] == "T"                     # not "pack" (5 benches = 900/hr)
    assert cv["capacity_per_hr"] == pytest.approx(0.05 * 3600.0)
    assert cv["buffer_slots"] == 40                 # 20 (E) + 20 (T); the 引き込み is past it
    assert cv["time_to_jam_s"] == pytest.approx(40.0 / (0.1 - 0.05))


def test_parallel_belts_at_one_stage_carry_the_sum_not_the_minimum():
    """Two 検品ライン feeding one 本線 pass twice one line's rate.

    Reading a stage's belts as if they were in series would price a ten-lane
    引き込み bank as a one-lane one and cry jam on a healthy design.
    """
    belts = [Conveyor(id="A", points=[[0.0, 0.0], [20.0, 0.0]], speed_mps=0.1),
             Conveyor(id="B", points=[[0.0, 2.0], [20.0, 2.0]], speed_mps=0.1),
             Conveyor(id="S", points=[[20.0, 0.0], [20.0, 4.0]], speed_mps=1.0)]
    edges = [FlowEdge(id="e1", equipment_ref="A", **_PICK_TO_LINE),
             FlowEdge(id="e2", equipment_ref="B", **_PICK_TO_LINE),
             FlowEdge(id="e3", equipment_ref="S", **_LINE_TO_PACK)]
    m = _line_model(belts=belts, edges=edges,
                    stations=[Station(id="bench", x=20.0, y=5.0, count=20)],
                    pack_time_s=20.0, rate_per_hr=360.0)

    stages = analytic._belt_stages(m)
    assert sorted(c.id for c in stages["stages"][0]) == ["A", "B"]
    # 2 belts x 0.1 m/s / 1 m pitch = 0.2 totes/s, below the 引き込み and the benches.
    assert analytic.estimate(m)["conveyor"]["capacity_per_hr"] == pytest.approx(720.0)


def test_mmck_full_is_a_probability_and_matches_erlang_b_by_hand():
    """The steady-state blocking recursion, checked against the textbook form."""
    assert analytic._mmck_full(2, 0.0, 5) == 0.0
    assert analytic._mmck_full(0, 1.0, 5) == 0.0
    a = 1.5                                          # M/M/2/2 = Erlang B, c=2
    assert analytic._mmck_full(2, a, 0) == pytest.approx(
        (a * a / 2) / (1 + a + a * a / 2))
    # More waiting room can only make blocking rarer, never more common.
    ks = [analytic._mmck_full(3, 2.0, k) for k in range(12)]
    assert all(0.0 <= p <= 1.0 for p in ks)
    assert all(ks[i] <= ks[i - 1] + 1e-12 for i in range(1, len(ks)))
    # A huge offered load with nowhere to wait blocks nearly every arrival.
    assert analytic._mmck_full(1, 500.0, 0) > 0.99


# --------------------------------------------------- additive / never blocks

def _without_conveyor_mechanism(model: WarehouseModel) -> dict:
    """``estimate`` with the conveyor mechanism switched off, ``conveyor`` dropped."""
    real = analytic._conveyor_estimate
    analytic._conveyor_estimate = lambda *a, **k: None
    try:
        return {k: v for k, v in analytic.estimate(model).items() if k != "conveyor"}
    finally:
        analytic._conveyor_estimate = real


@pytest.mark.parametrize("template_id",
                         [t["template_id"] for t in templates.list_templates()])
def test_the_catalogue_is_untouched_by_the_conveyor_mechanism(template_id):
    """ADDITIVE: every bundled template runs BELOW its line's capacity, so the new
    mechanism must not move a single existing number — the aisle-travel contract
    (tests/test_analytic_aisle_travel.py) is pinned on these very values."""
    m = templates.load_template_model(template_id)
    est = analytic.estimate(m)
    assert {k: v for k, v in est.items() if k != "conveyor"} == \
        _without_conveyor_mechanism(m)
    if est["conveyor"] is not None:
        assert est["conveyor"]["jams"] is False, "a bundled template must not jam"


def test_a_model_without_a_belt_reports_no_conveyor_block():
    """No belt, or a belt no flow leg routes onto ⇒ ``None`` (never blocks)."""
    for m in (WarehouseModel(), templates.load_template_model("blank"),
              templates.load_template_model("ecommerce_small")):
        assert analytic.estimate(m)["conveyor"] is None
    # A belt DRAWN but not wired into the flow is a physical fact, not a decision:
    # the engine runs no belt at all, so neither does the estimate.
    drawn = templates.load_template_model("ecommerce_small")
    drawn.resources.conveyors = [Conveyor(id="c", points=[[0.0, 0.0], [10.0, 0.0]])]
    assert analytic.estimate(drawn)["conveyor"] is None


def test_degenerate_belts_never_block_the_estimate():
    """A one-point / zero-length / hand-edited belt is not physical transport."""
    m = _entry_and_spur(360.0, benches=6, pack_time_s=20.0)
    m.resources.conveyors += [
        Conveyor(id="dot", points=[[5.0, 5.0]]),
        Conveyor(id="flat", points=[[5.0, 5.0], [5.0, 5.0]]),
        Conveyor(id="zero", points=[[1.0, 1.0], [3.0, 1.0]], speed_mps=0.0,
                 tote_pitch_m=0.0),
    ]
    est = analytic.estimate(m)
    assert est["conveyor"]["jams"] is False
    assert 0.0 <= est["picker_utilization"] <= 1.0


def test_belt_slots_never_falls_below_one():
    assert analytic.belt_slots(Conveyor(id="s", points=[[0.0, 0.0], [0.4, 0.0]])) == 1
    assert analytic.belt_slots(
        Conveyor(id="s", points=[[0.0, 0.0], [10.0, 0.0]], tote_pitch_m=0.45)) == 22
    assert analytic.belt_slots(Conveyor(id="s", points=[])) == 1


# ------------------------------------------------------- mirrors of the engine

def test_the_engine_constants_this_module_mirrors_are_still_the_same():
    """Invariant 11: a mirrored constant needs a parity test or a single source.

    ``analytic`` keeps its own copies so the 爆速 path never imports simpy/numpy;
    that is only safe while the copies agree with what ``engine.build`` builds.
    """
    from whsim.engine import build

    assert analytic._BELT_SPEED_FALLBACK == build.DEFAULT_CONVEYOR_SPEED_MPS
    assert analytic._JOIN_TOL_M == build.JOIN_TOL_M
    assert analytic._BENCH_REACH_M == build.BENCH_REACH_M


def test_belt_slots_agrees_with_the_slot_pool_the_engine_builds():
    """The oracle's slot count IS the engine's, on the template that has a chain."""
    m = templates.load_template_model("line_inspection")
    world = _build_world(m)
    built = {ln.id: ln.capacity for ln in world.conveyors}
    assert built, "the template must actually run belts"
    for cv in m.resources.conveyors:
        if cv.id in built:
            assert analytic.belt_slots(cv) == built[cv.id], cv.id


def test_the_stages_the_oracle_prices_are_the_belts_the_engine_chains():
    """解析 and DES must not be looking at different belts (invariant 5).

    The oracle's stage list is compared against the topology ``engine.build``
    resolved: same set of belts, the entry belts first, the 引き込み last.
    """
    m = templates.load_template_model("line_inspection")
    world = _build_world(m)
    stages = analytic._belt_stages(m)

    priced = {c.id for st in stages["stages"] for c in st}
    assert priced == {ln.id for ln in world.conveyors}
    assert {c.id for c in stages["stages"][0]} == {ln.id for ln in world.entry_conveyors}
    spurs = {c.id for c in stages["spurs"]}
    assert spurs == {s.id for ln in world.conveyors for _a, s in ln.junctions}
    assert {c.id for c in stages["stages"][-1]} == spurs
    # ...and each 引き込み's benches are the ones the engine gave it.
    for ln in world.conveyors:
        if ln.id in spurs and ln.bench is not None:
            cv = next(c for c in m.resources.conveyors if c.id == ln.id)
            assert analytic._spur_benches(m, cv) == ln.n_bench


def _build_world(model: WarehouseModel):
    """The world ``run_replications`` would run, without running it."""
    import simpy

    from whsim.engine.build import build
    return build(model, simpy.Environment())


# ------------------------------------------------------------- 解析 <-> DES

def _overfed_line() -> WarehouseModel:
    """``line_inspection`` with more demand than its packing line can pass.

    The template ships comfortably inside its capacity (475 vs 923 orders/hr), so
    the jam has to be provoked: triple the pickers — otherwise the pickers, not
    the line, are the constraint and the belt never fills — and offer 1500/hr.
    """
    m = templates.load_template_model("line_inspection")
    m.orders.profile.rate_per_hr = 1200.0            # x peak_factor 1.25 = 1500/hr
    for w in m.resources.workers:
        if w.role == "picker":
            w.count *= 3
    m.simulation.replications = 1
    return m


def test_the_closed_form_and_the_des_agree_that_an_over_fed_line_jams():
    """解析で当てる → DESで裏取り, on the mechanism this module was extended for.

    The two numbers are pinned loosely on purpose. ``time_to_jam_s`` is the fluid
    moment the buffer UP TO the constraint is full (the picker can no longer let
    go), while the DES's ``conveyor_time_to_first_block_s`` is the first hand-over
    that waited at all — an earlier, different event — and the engine's junction
    rule (a tote that finds its target 引き込み full is passed on, and waits at the
    LAST junction holding its 本線 slot) costs the line head-of-line blocking that
    no closed form over belt speeds can see. So the contract pinned here is the
    one a proposal turns on: BOTH say this line jams, both say it jams early in
    the shift, and they agree on how often a hand-over waits.
    """
    m = _overfed_line()
    est = analytic.estimate(m)["conveyor"]
    results, _ = run_replications(m)
    sim = kpis.compute(results, m)

    assert est["jams"] is True
    assert sim["conveyor_block_ratio"] > 0.2, "the DES must actually jam"
    assert sim["conveyor_time_to_first_block_s"] is not None

    # how often a hand-over waits, within a factor of two
    assert 0.5 <= est["block_ratio_est"] / sim["conveyor_block_ratio"] <= 2.0
    # ...and both call it an early-in-the-shift jam, not an end-of-day one.
    horizon = m.simulation.duration_s
    assert 0.0 < est["time_to_jam_s"] < horizon / 4.0
    assert 0.0 < sim["conveyor_time_to_first_block_s"] < horizon / 4.0
    # the DES cannot pass more than the closed form says the line can
    assert sim["throughput_per_hr"] <= est["capacity_per_hr"] * 1.05


def test_the_des_names_the_belt_the_jam_starts_on():
    """The per-belt read-out is the only one that says WHICH 引き込み/本線 to fix."""
    m = _overfed_line()
    results, _ = run_replications(m)
    sim = kpis.compute(results, m)

    belts = sim["conveyors"]
    assert belts, "a chained run must report per-belt numbers"
    blocked = {b: v for b, v in belts.items() if (v["blocked"] or 0) > 0}
    assert blocked, "an over-fed line must block somewhere"
    for b, v in belts.items():
        assert 0.0 <= v["block_ratio"] <= 1.0, b
        assert v["capacity"] >= 1, b
        assert v["peak_occupancy"] <= v["capacity"] + 1e-9, b
        assert 0.0 <= v["utilization"] <= 1.0 + 1e-9, b
    # the line-wide ratio is the per-belt blocks over the per-belt boardings
    tot_b = sum(v["boardings"] for v in belts.values())
    tot_x = sum(v["blocked"] for v in belts.values())
    assert sim["conveyor_block_ratio"] == pytest.approx(tot_x / tot_b, rel=1e-9)
    assert sim["verdict"].count("コンベアに滞留") == 1


# --------------------------------------------------------------- kpis: additive

def test_conveyor_kpis_stay_zero_and_the_verdict_unchanged_without_a_belt():
    """A conveyor-less run must not gain a single conveyor sentence or number."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 1800.0
    m.simulation.replications = 1
    results, _ = run_replications(m)
    k = kpis.compute(results, m)

    assert k["conveyor_block_ratio"] == 0.0
    assert k["conveyor_time_to_first_block_s"] is None
    assert k["conveyors"] == {}
    assert "コンベア" not in k["verdict"]


def test_conveyor_totes_counts_transports_not_belt_legs():
    """On a chain each tote passes several belts; only the LAST leg completed it.

    A legacy single-belt log writes no ``last`` field and every leg is a last one,
    so the historical count is unchanged.
    """
    m = templates.load_template_model("line_inspection")
    m.simulation.duration_s = 3600.0
    m.simulation.replications = 1
    results, _ = run_replications(m)
    k = kpis.compute(results, m)

    offs = [e for e in results[0].events if e["event"] == "conveyor_off"]
    lasts = [e for e in offs if e.get("last", 1)]
    assert 0 < len(lasts) < len(offs), "the template's line really is chained"
    assert k["conveyor_totes"] == len(lasts)
    # ...and a completed transport is one packed order, not three belt rides.
    assert k["conveyor_totes"] == pytest.approx(k["orders_completed"], rel=0.05)


def test_per_belt_read_out_is_averaged_over_replications_not_taken_from_the_first():
    """``compute`` can only average top-level numerics; the nested dict needs its
    own merge or it silently reports replication #1."""
    reps = [{"a": {"boardings": 10.0, "time_to_first_block_s": None}},
            {"a": {"boardings": 20.0, "time_to_first_block_s": 60.0}},
            {"b": {"boardings": 4.0, "time_to_first_block_s": None}}]
    merged = kpis._merge_per_belt(reps)
    assert merged["a"]["boardings"] == pytest.approx(15.0)
    # a rep where the belt never blocked has no "when" to average in — and a belt
    # that never blocked at all stays None rather than being read as 0 s.
    assert merged["a"]["time_to_first_block_s"] == pytest.approx(60.0)
    assert merged["b"]["time_to_first_block_s"] is None
    assert math.isclose(merged["b"]["boardings"], 4.0)
