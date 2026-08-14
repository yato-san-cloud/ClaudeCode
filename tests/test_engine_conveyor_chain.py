"""ベルト連鎖と引き込み(スパー)詰まり: the belts are ONE machine, not N worlds.

A real 出荷ライン is a chain — 検品ライン → 本線 → 引き込み → 梱包台 — and the
behaviour worth simulating is the jam travelling BACKWARDS along it: a full 引き込み
holds totes on the 本線, which holds them on the 検品ライン, which is what finally
stops the picker letting go. The engine used to give every belt its own slot pool
and pack every tote at the end of whichever belt it boarded, so a fourteen-belt
line was fourteen independent worlds and none of those couplings existed.

What is pinned here:

* the two joints are read off the DRAWN geometry — a belt end sitting on another
  belt's path is a hand-over, a spur's infeed sitting on a trunk is a junction;
* a tote pays each belt in turn (``leg``), and only the belt it packs at is
  ``last``;
* the jam propagates UPSTREAM in time (the belt in front blocks before the belt
  behind it does);
* every wait is for something strictly downstream, so a full line resumes instead
  of deadlocking;
* and a model with no chain runs the code path it always ran — same events, same
  numbers, plus three constant fields.
"""

from __future__ import annotations

import math
from collections import Counter

from whsim import flowgraph, kpis, templates
from whsim.engine.build import build
from whsim.engine.processes import _board_conveyor
from whsim.engine.run import run_once
from whsim.schema.model import (
    Bounds,
    Conveyor,
    FlowEdge,
    Item,
    Location,
    OrderProfile,
    Station,
    WarehouseModel,
    WorkerGroup,
)

# The default work-process master's ids (staffing.GENERIC_PROCESSES). Wiring a leg
# from ピッキング makes a belt an ENTRANCE; wiring one into 梱包 makes it a 引き込み.
PICK, INSPECT, PACK, SHIP = "ピッキング", "検品", "梱包", "出荷"


def _model(conveyors, edges, *, pick_xy, pickers=2, rate=90.0, pack_time=20.0,
           stations=None, duration=1800.0, seed=7, lines=1.0):
    """A bare floor (no walls ⇒ Manhattan routing) with pick faces on one row."""
    m = WarehouseModel()
    m.layout.bounds = Bounds(width=60.0, depth=24.0)
    m.locations = [Location(id=f"L{i}", x=float(x), y=float(y), sku=f"S{i}")
                   for i, (x, y) in enumerate(pick_xy)]
    m.items = [Item(sku=f"S{i}", pick_freq=1.0, ts_per_unit=1.0, default_location=f"L{i}")
               for i in range(len(pick_xy))]
    m.resources.workers = [WorkerGroup(id="pickers", role="picker", count=pickers)]
    m.resources.stations = stations or [Station(id="pack", x=55.0, y=10.0, count=2)]
    m.resources.conveyors = conveyors
    m.process.flow_edges = edges
    m.process.pack_time_s = pack_time
    m.orders.profile = OrderProfile(rate_per_hr=rate, lines_per_order_mean=lines)
    m.simulation.duration_s = duration
    m.simulation.random_seed = seed
    return m


def _edge(src, dst, ref):
    return FlowEdge(id=f"{src}->{dst}:{ref}", src=src, dst=dst,
                    transport="conveyor", equipment_ref=ref, share=1.0)


def _events(res, name):
    return [e for e in res.events if e["event"] == name]


def _by_order(res, name):
    out: dict[str, list] = {}
    for e in _events(res, name):
        out.setdefault(e["order_id"], []).append(e)
    return out


# --------------------------------------------------------------- the topology


def _serial_model(**kw):
    """検品ライン → 本線: A's discharge end sits ON B's path, so A hands over to B.

    Nothing is a 引き込み here (no conveyor leg ends at 梱包), so the tote packs at
    B's discharge end using the shared pack pool."""
    a = Conveyor(id="A", points=[[0.0, 12.0], [20.0, 12.0]], speed_mps=1.0)
    b = Conveyor(id="B", points=[[20.0, 12.0], [45.0, 12.0]], speed_mps=1.0)
    return _model([a, b], [_edge(PICK, INSPECT, "A"), _edge(PACK, SHIP, "B")],
                  pick_xy=[(4.0, 5.0), (9.0, 5.0), (14.0, 5.0)], **kw)


def test_geometry_alone_resolves_the_hand_over():
    world = build(_serial_model())
    a, b = world.conveyors
    assert (a.id, b.id) == ("A", "B")
    assert a.next_line is b, "a belt discharging onto another belt hands over to it"
    assert b.next_line is None, "and the last belt of the chain hands over to nobody"
    assert a.junctions == [] and b.junctions == []
    # Only the ENTRANCE is boardable: the 本線 runs through the pick area too, and
    # boarding it would drop the tote in past the stretch whose jam must reach back.
    assert [c.id for c in world.entry_conveyors] == ["A"]
    assert _board_conveyor(world, (14.0, 5.0))[0] is a
    assert flowgraph.entry_conveyor_ids(world.model) == {"A"}
    assert flowgraph.pack_conveyor_ids(world.model) is None   # no 引き込み authored


def test_a_tote_pays_every_belt_in_turn_and_packs_only_at_the_last():
    res = run_once(_serial_model(), seed=11)
    ons, offs = _by_order(res, "conveyor_on"), _by_order(res, "conveyor_off")
    assert ons and offs

    for oid, legs in ons.items():
        assert [e["conveyor"] for e in legs] == ["A", "B"], oid
        assert [e["leg"] for e in legs] == [0, 1]
        assert [e["entry"] for e in legs] == [1, 0]   # only the entrance is entered
    for oid, legs in offs.items():
        assert [e["conveyor"] for e in legs] == ["A", "B"], oid
        assert [e["leg"] for e in legs] == [0, 1]
        assert [e["last"] for e in legs] == [0, 1]    # packing happens once, at the end
        # What it rode on each belt: A from wherever it boarded to A's end (never
        # the whole belt), then the WHOLE of B (it joins B at B's infeed).
        assert 0.0 < legs[0]["ride_m"] < 20.0
        assert math.isclose(legs[1]["ride_m"], 25.0)
        for e in legs:
            assert math.isclose(e["transit"], e["ride_m"] / 1.0, rel_tol=1e-9)

    # An unbroken line: exactly one pack per tote, and every tote that boarded and
    # finished got off both belts.
    assert len(_events(res, "pack_done")) == len(_events(res, "order_complete"))
    assert sum(e["last"] for e in _events(res, "conveyor_off")) == \
        len(_events(res, "order_complete"))


def test_the_ride_is_continuous_across_the_hand_over():
    """The tote does not teleport at the joint: it leaves A exactly where it joins
    B, and its replay track stays on the two polylines throughout."""
    res = run_once(_serial_model(duration=900.0), seed=11)
    for oid, offs in _by_order(res, "conveyor_off").items():
        ons = _by_order(res, "conveyor_on")[oid]
        # hand-over-hand: the slot on B is held BEFORE the slot on A is let go.
        assert ons[1]["t"] <= offs[0]["t"] + 1e-9, oid
        assert math.isclose(ons[1]["t"], offs[0]["t"], abs_tol=1e-9)
    tracked = [t for t in res.totes if t.keyframes and t.keyframes[-1][3] == "pack"]
    assert tracked
    for t in tracked:
        belt = [f for f in t.keyframes if f[3] == "belt"]
        assert belt and all(f[2] == 12.0 for f in belt)       # both belts run at y=12
        xs = [f[1] for f in belt]
        assert xs == sorted(xs)                               # forward only
        assert math.isclose(xs[-1], 45.0)                     # ends at B's discharge


# ------------------------------------------------------ the jam runs backwards


def test_a_jam_propagates_upstream_in_time():
    """The point of the chain. A slow single pack station fills B; totes on A then
    block waiting for a slot on B; A fills; and only THEN does the picker block at
    the hand-off. So the first block on the upstream belt is LATER than the first
    block on the belt in front of it."""
    a = Conveyor(id="A", points=[[0.0, 12.0], [6.0, 12.0]], speed_mps=1.0)
    b = Conveyor(id="B", points=[[6.0, 12.0], [9.0, 12.0]], speed_mps=1.0)
    m = _model([a, b], [_edge(PICK, INSPECT, "A"), _edge(PACK, SHIP, "B")],
               pick_xy=[(2.0, 5.0), (4.0, 5.0)], pickers=4, rate=240.0,
               pack_time=90.0, stations=[Station(id="pack", x=9.0, y=12.0, count=1)],
               duration=3600.0)
    res = run_once(m, seed=9)

    ons = _events(res, "conveyor_on")
    first = {}
    for e in ons:
        if e["blocked"] and e["conveyor"] not in first:
            first[e["conveyor"]] = e["t"]
    assert set(first) == {"A", "B"}, "both belts must feel the jam"
    assert first["A"] > first["B"], (
        "the belt in front jams first; the one behind it only when IT is full")

    # ...and the back-pressure reaches the picker: entry-belt blocks are logged by
    # the picker agent (leg 0), i.e. it is standing there unable to let go.
    picker_blocks = [e for e in ons if e["entry"] == 1 and e["blocked"]]
    assert picker_blocks and max(e["wait"] for e in picker_blocks) > 30.0
    arrived = len(_events(res, "order_arrive"))
    assert len(_events(res, "order_complete")) < arrived * 0.6


# ---------------------------------------------------------- 引き込み (spurs)


def _spur_model(*, pitch=None, pack_time=60.0, rate=90.0, duration=1800.0,
                bench=1, seed=5):
    """検品ライン E → 本線 T → 引き込み S1/S2 → 梱包台.

    E's end sits on T (a hand-over); S1/S2's INFEEDS sit on T (junctions at arc 10
    and 20). The benches stand at each spur's discharge end, so each spur gets its
    own pack pool instead of everyone sharing one."""
    e = Conveyor(id="E", points=[[2.0, 3.0], [2.0, 12.0]], speed_mps=1.0)
    t = Conveyor(id="T", points=[[0.0, 12.0], [40.0, 12.0]], speed_mps=1.0)
    s1 = Conveyor(id="S1", points=[[10.0, 12.0], [10.0, 16.0]], speed_mps=1.0,
                  tote_pitch_m=pitch)
    s2 = Conveyor(id="S2", points=[[20.0, 12.0], [20.0, 16.0]], speed_mps=1.0,
                  tote_pitch_m=pitch)
    edges = [_edge(PICK, INSPECT, "E"), _edge(INSPECT, PACK, "S1"),
             _edge(INSPECT, PACK, "S2"), _edge(PACK, SHIP, "T")]
    stations = [Station(id="b1", x=10.0, y=16.0, count=bench),
                Station(id="b2", x=20.0, y=16.0, count=bench)]
    return _model([e, t, s1, s2], edges,
                  pick_xy=[(2.0, 2.0), (5.0, 2.0), (8.0, 2.0)], pickers=3,
                  rate=rate, pack_time=pack_time, stations=stations,
                  duration=duration, seed=seed)


def test_a_spur_hangs_off_the_trunk_at_its_infeed_with_its_own_benches():
    world = build(_spur_model())
    by_id = {c.id: c for c in world.conveyors}
    trunk = by_id["T"]
    assert [(arc, s.id) for arc, s in trunk.junctions] == [(10.0, "S1"), (20.0, "S2")]
    assert by_id["E"].next_line is trunk and trunk.next_line is None
    assert by_id["S1"].next_line is None, "a 引き込み ends at its benches"
    for sid in ("S1", "S2"):
        assert by_id[sid].n_bench == 1 and by_id[sid].bench is not None
    assert trunk.bench is None and by_id["E"].bench is None
    assert flowgraph.pack_conveyor_ids(world.model) == {"S1", "S2"}
    assert [c.id for c in world.entry_conveyors] == ["E"]


def test_totes_turn_off_the_trunk_into_the_spurs():
    res = run_once(_spur_model(), seed=5)
    done = {e["order_id"] for e in _events(res, "order_complete")}
    offs = {oid: legs for oid, legs in _by_order(res, "conveyor_off").items()
            if oid in done}          # a tote still riding when the window shuts is
    assert offs                      # legitimately cut off, like a worker's track
    used = Counter()
    for oid, legs in offs.items():
        assert [e["conveyor"] for e in legs][:2] == ["E", "T"], oid
        assert legs[-1]["conveyor"] in {"S1", "S2"}, oid
        assert [e["leg"] for e in legs] == list(range(len(legs)))
        assert [e["last"] for e in legs] == [0] * (len(legs) - 1) + [1]
        # The trunk leg stops at the junction it turned off at — not at the far end
        # of the trunk (the tail past the last junction is the 出荷 leg).
        # (the 検品ライン joins the trunk at arc 2, the junctions are at 10 and 20)
        assert legs[1]["ride_m"] in (8.0, 18.0), legs[1]["ride_m"]
        used[legs[-1]["conveyor"]] += 1
    assert set(used) == {"S1", "S2"}, (
        "the near 引き込み takes what it can hold and the far one takes the overflow")


def test_a_stalled_tote_waits_where_it_stands_and_resumes_when_a_bench_frees():
    """全 spur 満杯: one slot and one bench per spur plus a slow pack fills both.

    A tote that finds no room from where it stands ONWARDS stalls at THAT junction
    holding its trunk slot (the back-pressure) — not at the last one. It is woken
    the moment any 引き込み frees a slot and looks again from where it is. The
    wait-for graph only points downstream, so this can never deadlock."""
    m = _spur_model(pitch=4.0, pack_time=90.0, rate=150.0, duration=3600.0)
    world = build(m)
    assert all(c.belt.capacity == 1 for c in world.conveyors if c.id.startswith("S"))
    assert {c.id: (c.host.id if c.host else None) for c in world.conveyors} == \
        {"E": None, "T": None, "S1": "T", "S2": "T"}

    res = run_once(m, seed=5)
    spur_on = [e for e in _events(res, "conveyor_on") if e["conveyor"].startswith("S")]
    held = [e for e in spur_on if e["blocked"]]
    assert held, "a full 引き込み must make the tote wait on the 本線"
    # A tote stalls where it IS, so the wait shows up at whichever 引き込み finally
    # took it — including the FIRST junction, which the old target-committed rule
    # could never wait at (it sailed past and could not come back).
    assert {e["conveyor"] for e in held} == {"S1", "S2"}
    # The wait is charged to the pack stage (spur wait + bench wait, one field).
    waits = [e["wait"] for e in _events(res, "pack_start")]
    assert max(waits) > 10.0

    # No deadlock: work keeps completing long after the first stall, and the last
    # completion is near the end of the run rather than frozen at the first jam.
    done = _events(res, "order_complete")
    assert len(done) > 10
    assert done[-1]["t"] > held[0]["t"] + 600.0
    # The 本線 feels it too: totes stalled at the junction hold trunk slots.
    trunk_off = [e for e in _events(res, "conveyor_off") if e["conveyor"] == "T"]
    assert max(e["occupancy"] - e["transit"] for e in trunk_off) > 10.0


def _bench_utilization(res, m):
    benches = sum(s.count for s in m.resources.stations)
    busy = sum(e["busy"] for e in _events(res, "pack_done"))
    return busy / (benches * m.simulation.duration_s)


def test_the_line_is_work_conserving_as_demand_rises_past_capacity():
    """The invariant that a divert rule is easy to get wrong: **no bench may idle
    while a tote is stalled with a slot in front of it**.

    Its signature when broken is unmistakable and impossible — packing utilisation
    FALLING as demand rises past capacity. That is what a target committed at
    boarding produced: a tote sails past 引き込み it could have entered, and once
    past them it can never go back, so benches starve behind a stalled queue. So
    utilisation must be monotone in demand and must saturate near the ceiling
    (here one slot and one bench per 引き込み ⇒ a slot cycle of ride + pack)."""
    m = _spur_model(pitch=4.0, pack_time=90.0, duration=3600.0)
    ride_s = 4.0 / 1.0                        # a 4 m 引き込み at 1 m/s
    ceiling = 90.0 / (90.0 + ride_s)          # bench busy / slot cycle

    utils = []
    for rate in (30.0, 60.0, 120.0, 300.0):
        m.orders.profile.rate_per_hr = rate
        utils.append(_bench_utilization(run_once(m, seed=5), m))
    assert utils == sorted(utils), (
        f"utilisation fell as demand rose — work is being left on the table: {utils}")
    assert utils[-1] > 0.85, utils[-1]
    assert utils[-1] <= ceiling + 1e-9, "and never above what the benches can do"


def test_the_shipped_line_saturates_its_benches_under_peak():
    """The same invariant on the real shape: 380/h × 3 ≈ 1140/h against a packing
    line that can do ≈ 830/h, so every one of the 20 梱包台 must be working."""
    m = templates.load_template_model("line_inspection")
    m.simulation.duration_s = 3600.0
    m.orders.profile.peak_factor = 3.0
    res = run_once(m)
    assert _bench_utilization(res, m) > 0.85
    packed_at = Counter(e["conveyor"] for e in _events(res, "conveyor_off") if e["last"])
    assert len(packed_at) == 10, "every 引き込み must be feeding its benches"


def test_tote_pitch_sets_how_many_totes_a_belt_holds():
    """``tote_pitch_m`` is what turns a 2.6 m 引き込み from "two totes, no buffer"
    into an accumulation lane. Unstated ⇒ the historical 1 個/m."""
    world = build(_spur_model())
    assert {c.id: c.capacity for c in world.conveyors} == \
        {"E": 9, "T": 40, "S1": 4, "S2": 4}
    fine = build(_spur_model(pitch=0.5))
    assert {c.id: c.capacity for c in fine.conveyors}["S1"] == 8
    coarse = build(_spur_model(pitch=4.0))
    assert {c.id: c.capacity for c in coarse.conveyors}["S1"] == 1
    # never-blocks: a nonsense pitch falls back to 1 個/m instead of dividing by 0.
    for bad in (0.0, -2.0):
        w = build(_spur_model(pitch=bad))
        assert {c.id: c.capacity for c in w.conveyors}["S1"] == 4


def test_a_spur_nobody_stands_at_falls_back_to_the_shared_pack_pool():
    """never-blocks: a half-drawn line still runs. A 引き込み with no bench within
    reach borrows the shared pack stations rather than refusing to deliver."""
    m = _spur_model()
    for st in m.resources.stations:
        st.y = 40.0                       # benches nowhere near the spur ends
    world = build(m)
    by_id = {c.id: c for c in world.conveyors}
    assert by_id["S1"].bench is None and by_id["S1"].n_bench == 0
    res = run_once(m, seed=5)
    assert len(_events(res, "order_complete")) > 0
    assert {e["conveyor"] for e in _events(res, "conveyor_off") if e["last"]} == \
        {"S1", "S2"}


def test_a_mis_drawn_loop_terminates():
    """Two belts each ending on the other is not a warehouse, but it must not hang:
    a belt already ridden is the end of the line."""
    a = Conveyor(id="A", points=[[0.0, 12.0], [20.0, 12.0]], speed_mps=1.0)
    b = Conveyor(id="B", points=[[20.0, 12.0], [0.0, 12.0]], speed_mps=1.0)
    m = _model([a, b], [_edge(PICK, INSPECT, "A"), _edge(PACK, SHIP, "B")],
               pick_xy=[(4.0, 5.0)], duration=600.0)
    world = build(m)
    assert world.conveyors[0].next_line is world.conveyors[1]
    assert world.conveyors[1].next_line is world.conveyors[0]
    res = run_once(m, seed=2)
    done = {e["order_id"] for e in _events(res, "order_complete")}
    assert done
    for oid, legs in _by_order(res, "conveyor_off").items():
        assert len(legs) <= 2, "a belt already ridden is the end of the line"
        if oid in done:
            assert [e["conveyor"] for e in legs] == ["A", "B"]
            assert legs[-1]["last"] == 1


# ---------------------------------------------- the unchained engine, unchanged


# Captured from the pre-change engine (same seeds, same model) — see the module
# docstring of tests/test_conveyor.py for the sibling regression bar. The chain
# resolver must not perturb a model that has no chain in it: same event count,
# same event mix, same field values, same KPIs. The ONLY difference allowed is the
# three constants ``leg=0`` / ``entry=1`` / ``last=1`` the contract now carries.
_LEGACY_ON_KEYS = {"t", "event", "order_id", "resource", "conveyor", "wait",
                   "blocked", "transit", "ride_m"}
_LEGACY_OFF_KEYS = {"t", "event", "order_id", "resource", "conveyor", "transit",
                    "ride_m", "occupancy"}


def _single_belt_model():
    m = WarehouseModel()
    m.layout.bounds = Bounds(width=60.0, depth=20.0)
    xs = [8.0, 15.0, 22.0, 31.0]
    m.locations = [Location(id=f"L{i}", x=float(x), y=5.0, sku=f"S{i}")
                   for i, x in enumerate(xs)]
    m.items = [Item(sku=f"S{i}", pick_freq=1.0, ts_per_unit=1.0, default_location=f"L{i}")
               for i in range(len(xs))]
    m.resources.workers = [WorkerGroup(id="pickers", role="picker", count=2)]
    m.resources.stations = [Station(id="pack", x=55.0, y=10.0, count=2)]
    m.resources.conveyors = [Conveyor(id="c1", points=[[0.0, 10.0], [50.0, 10.0]],
                                      speed_mps=1.0)]
    for st in m.process.stages:
        if st.id == "pack":
            st.method = "conveyor"
    m.orders.profile = OrderProfile(rate_per_hr=90.0, lines_per_order_mean=1.5)
    m.process.pack_time_s = 20.0
    m.simulation.duration_s = 3600.0
    m.simulation.random_seed = 7
    return m


def test_an_unchained_belt_runs_the_legacy_path_unchanged():
    m = _single_belt_model()
    world = build(m)
    line = world.conveyors[0]
    assert line.next_line is None and line.junctions == [] and line.bench is None
    # No leg says コンベア out of ピッキング, so every belt stays boardable (the
    # behaviour from before an entrance could be named).
    assert flowgraph.entry_conveyor_ids(m) is None
    assert world.entry_conveyors == world.conveyors

    res = run_once(m, seed=11)
    assert len(res.events) == 717
    assert dict(Counter(e["event"] for e in res.events)) == {
        "order_arrive": 90, "pick_start": 90, "pick_done": 90, "conveyor_on": 90,
        "pack_start": 90, "pack_done": 89, "conveyor_off": 89, "order_complete": 89}
    assert [len(w.keyframes) for w in res.workers] == [109, 145]
    assert len(res.totes) == 23 and sum(len(t.keyframes) for t in res.totes) == 178
    assert (res.conveyor_capacity, res.n_conveyors) == (50, 1)

    # The three new fields are constants on this path, and nothing else was added.
    ons, offs = _events(res, "conveyor_on"), _events(res, "conveyor_off")
    for e in ons:
        assert (e["leg"], e["entry"]) == (0, 1)
        assert set(e) - {"leg", "entry"} == _LEGACY_ON_KEYS
    for e in offs:
        assert (e["leg"], e["last"]) == (0, 1)
        assert set(e) - {"leg", "last"} == _LEGACY_OFF_KEYS

    # ...and every field VALUE is the pre-change one (aggregates over the whole log).
    def total(name, fld):
        return sum(e[fld] for e in _events(res, name))
    assert total("conveyor_on", "wait") == 0.0
    assert total("conveyor_on", "transit") == 2622.0
    assert total("conveyor_on", "ride_m") == 2622.0
    assert total("conveyor_off", "transit") == 2603.0
    assert total("conveyor_off", "ride_m") == 2603.0
    assert math.isclose(total("conveyor_off", "occupancy"), 4394.524542389583,
                        rel_tol=1e-12)
    assert math.isclose(total("pack_start", "wait"), 11.524542389583303, rel_tol=1e-12)
    assert total("pack_done", "busy") == 1780.0
    assert math.isclose(total("order_complete", "cycle"), 6961.135002364458,
                        rel_tol=1e-12)
    assert total("pick_done", "dist") == 2636.0
    assert math.isclose(sum(e["t"] for e in res.events), 1319614.5235879412,
                        rel_tol=1e-12)

    k = kpis.compute([res], m)
    for key, want in {
        "orders_arrived": 90.0,
        "orders_completed": 89.0,
        "completion_rate": 0.9888888888888889,
        "throughput_per_hr": 89.0,
        "cycle_mean_s": 78.21500002656693,
        "cycle_p95_s": 107.29170111651717,
        "picker_utilization": 0.34773148148148164,
        "packer_utilization": 0.24722222222222223,
        "walk_total_m": 2602.0,
        "walk_per_order_m": 29.235955056179776,
    }.items():
        assert math.isclose(k[key], want, rel_tol=1e-12), (key, k[key], want)


def test_a_model_with_no_belt_at_all_is_untouched():
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 3600.0
    m.simulation.random_seed = 99
    assert not m.resources.conveyors
    world = build(m)
    assert world.conveyors == [] and world.entry_conveyors == []

    res = run_once(m, seed=3)
    assert len(res.events) == 751
    assert dict(Counter(e["event"] for e in res.events)) == {
        "order_arrive": 133, "pick_start": 128, "pack_start": 124, "pack_done": 122,
        "order_complete": 122, "pick_done": 122}
    assert [len(w.keyframes) for w in res.workers] == [134, 113, 92, 161, 115, 129]
    assert res.totes == []
    k = kpis.compute([res], m)
    for key, want in {
        "orders_arrived": 133.0,
        "orders_completed": 122.0,
        "completion_rate": 0.9172932330827067,
        "throughput_per_hr": 122.0,
        "cycle_mean_s": 216.06024622700298,
        "cycle_p95_s": 354.3443558384753,
        "picker_utilization": 0.8828698484351809,
        "packer_utilization": 0.45185185185185184,
        "walk_total_m": 16021.5,
        "walk_per_order_m": 131.3237704918033,
    }.items():
        assert math.isclose(k[key], want, rel_tol=1e-12), (key, k[key], want)


# ------------------------------------------------------------ the shipped line


def test_the_shipped_line_resolves_into_one_machine():
    """``line_inspection`` is the template this exists for: 2 検品ライン → 本線 →
    5 引き込み ×両側 → 20 梱包台. Nothing about it is special-cased in the engine —
    the chain falls out of the drawn geometry plus the authored flow."""
    world = build(templates.load_template_model("line_inspection"))
    by_id = {c.id: c for c in world.conveyors}
    assert [c.id for c in world.entry_conveyors] == ["insp1", "insp2"]
    for insp in ("insp1", "insp2"):
        assert by_id[insp].next_line is by_id["trunk_low"], (
            "the inspection row must hand over ON the trunk")
    junctions = by_id["trunk_low"].junctions
    assert len(junctions) == 10
    assert [s.id for _arc, s in junctions[:2]] == ["spur5n", "spur5s"], (
        "junctions run in TRUNK order, which is the reverse of the belt ids here")
    arcs = [arc for arc, _s in junctions]
    assert arcs == sorted(arcs)
    # 20 梱包台 spread two to a 引き込み — the whole bench line, not one pool.
    assert sum(s.n_bench for _arc, s in junctions) == 20
    assert all(s.n_bench == 2 and s.bench is not None for _arc, s in junctions)
    # The empty-container return deck is not wired into the flow, so it never runs.
    assert "trunk_up" not in by_id


def test_the_shipped_line_carries_work_end_to_end():
    m = templates.load_template_model("line_inspection")
    m.simulation.duration_s = 3600.0
    res = run_once(m)
    assert len(_events(res, "order_complete")) > 0
    packed_at = Counter(e["conveyor"] for e in _events(res, "conveyor_off") if e["last"])
    # Greedy: at the design volume the near 引き込み hold the work and the far ones
    # only see the overflow, so not all ten are needed. (Under peak they all are —
    # test_the_shipped_line_saturates_its_benches_under_peak.)
    assert len(packed_at) >= 6
    assert not [e for e in _events(res, "conveyor_on") if e["blocked"]], (
        "at the design volume the drawn line has room: nothing should be blocking")
    for legs in _by_order(res, "conveyor_off").values():
        if legs[-1]["last"]:
            assert [e["conveyor"] for e in legs][:2] == ["insp1", "trunk_low"] or \
                   [e["conveyor"] for e in legs][:2] == ["insp2", "trunk_low"]
            assert legs[-1]["conveyor"].startswith("spur")
