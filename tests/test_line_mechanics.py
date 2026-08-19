"""引き込み梱包ラインの3機構: 停止線・容器の有限循環・作業者が引く引き込み。

The belts already form ONE machine (``test_engine_conveyor_chain.py``). What that
machine still could not say is what the people on a real 出荷ライン spend their day
doing, and each gap made the model quietly optimistic:

* **停止線 (選択停止ゲート)** — one belt carries 検品済み(梱包前)の容器 AND 梱包済みの
  完成品 at the same time. The stop line near the far end holds the first kind (it
  is what the pull-in workers take) and lets the second kind through to カーブ→
  積み付け. Without it a belt can only carry one homogeneous load, so the goods that
  are supposed to WAIT on the line instead flowed off the end — the jam that
  defines the line disappeared from the model.
* **容器の有限循環** — 折りたたみ容器は無限に湧かない. Without a pool the engine
  invented a container for every load, so 「レンタルは何個要るのか」 had no answer and
  a container shortage could never show up as a stopped line.
* **引き込みは作業者が引く** — the engine diverted greedily (any spur with room takes
  the load). Real pull-ins are pulled: the operator whose bench just went free takes
  the container in front of them, and what passed while they were busy is gone. With
  the greedy rule an unmanned 引き込み still swallowed work, which is exactly the
  staffing question the customer is asking.

All three are OFF by default and the last test in this file pins that a shipped
model's event log, trajectories and replay document are byte-for-byte what they
were before any of this existed (verified against the pre-change tree, not merely
frozen from this one).
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter

from whsim import kpis, templates
from whsim.engine.build import build
from whsim.engine.run import run_once
from whsim.render.replay import build_replay
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


def _edge(src, dst, ref):
    return FlowEdge(id=f"{src}->{dst}:{ref}", src=src, dst=dst,
                    transport="conveyor", equipment_ref=ref, share=1.0)


def _model(conveyors, edges, *, pick_xy, pickers=3, rate=120.0, pack_time=40.0,
           stations=None, duration=1800.0, seed=7, lines=1.0):
    """A bare floor (no walls ⇒ Manhattan routing) with pick faces on one row."""
    m = WarehouseModel()
    m.layout.bounds = Bounds(width=60.0, depth=40.0)
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


def _events(res, name):
    return [e for e in res.events if e["event"] == name]


def _by_order(res, name):
    out: dict[str, list] = {}
    for e in _events(res, name):
        out.setdefault(e["order_id"], []).append(e)
    return out


# ============================================================ 機構1: 停止線
# 検品ライン E1 (検品済みの容器) と 梱包ライン E2 (梱包済みの完成品) が同じ本線 T に
# 合流する。停止線は T の arc 30 (末端は 40)。容器はそこで止まり、完成品は通過する。


def _gate_model(gate=True, pack_time=60.0, rate=180.0, duration=1800.0):
    e1 = Conveyor(id="E1", points=[[5.0, 4.0], [5.0, 12.0]], speed_mps=1.0,
                  load_kind="inspected", tote_pitch_m=4.0)
    e2 = Conveyor(id="E2", points=[[25.0, 4.0], [25.0, 12.0]], speed_mps=1.0,
                  load_kind="packed", tote_pitch_m=4.0)
    trunk = Conveyor(id="T", points=[[0.0, 12.0], [40.0, 12.0]], speed_mps=1.0,
                     tote_pitch_m=4.0,
                     stop_gate=({"at_m": 30.0, "stop_states": ["inspected"],
                                 "pass_states": ["packed"]} if gate else None))
    edges = [_edge(PICK, INSPECT, "E1"), _edge(PICK, INSPECT, "E2"),
             _edge(PACK, SHIP, "T")]
    # One pair of hands at the stop line; the far end of the trunk is served by the
    # (larger) shared pack pool, so a jam here can only come from the stop line.
    stations = [Station(id="stopline", x=30.0, y=14.0, count=1),
                Station(id="ship", x=44.0, y=14.0, count=4)]
    return _model([e1, e2, trunk], edges,
                  pick_xy=[(5.0, 2.0), (7.0, 2.0), (25.0, 2.0), (27.0, 2.0)],
                  pickers=4, rate=rate, pack_time=pack_time, stations=stations,
                  duration=duration)


def test_the_gate_is_read_off_the_authored_belt_with_the_workers_standing_at_it():
    world = build(_gate_model())
    by_id = {c.id: c for c in world.conveyors}
    assert {c.id: c.load_kind for c in world.conveyors} == \
        {"E1": "inspected", "E2": "packed", "T": ""}
    gate = by_id["T"].gate
    assert gate is not None and gate.arc == 30.0
    assert gate.stops("inspected") and not gate.stops("packed")
    # An unnamed kind (the historical single load) passes: a gate can only ever
    # ADD a stop, never invent one for goods nobody classified.
    assert not gate.stops("")
    # 停止線に立つ人 is a different pair of hands from the 引き込みの梱包台 — resolved
    # by the same reach rule, and never counted twice.
    assert gate.n_bench == 1 and gate.bench is not None
    assert by_id["E1"].gate is None and by_id["E2"].gate is None


def test_two_kinds_ride_the_same_belt_and_only_one_of_them_stops():
    """The point of the gate: the container stops at the stop line, the finished
    carton runs straight past it to the end of the trunk."""
    res = run_once(_gate_model(), seed=5)
    done = _by_order(res, "conveyor_off")
    outcomes = Counter()
    for legs in done.values():
        if legs[-1].get("last"):
            outcomes[(legs[0]["conveyor"], round(legs[-1]["ride_m"], 1))] += 1
    # 検品済み: boards E1, joins the trunk at arc 5, taken off at the gate (arc 30).
    # 梱包済み: boards E2, joins at arc 25, rides the whole way to the end (arc 40).
    assert set(outcomes) == {("E1", 25.0), ("E2", 15.0)}, dict(outcomes)
    assert outcomes[("E1", 25.0)] > 10 and outcomes[("E2", 15.0)] > 10

    gate_stops = _events(res, "conveyor_gate")
    assert gate_stops, "the stop line has to actually stop something"
    assert {e["conveyor"] for e in gate_stops} == {"T"}
    assert {e["kind"] for e in gate_stops} == {"inspected"}
    assert {e["arc"] for e in gate_stops} == {30.0}
    assert kpis.compute([res], _gate_model())["conveyor_gate_stops"] == len(gate_stops)

    # The held load is drawn WHERE it is held (the replay must not float it past
    # the stop line to the end of the belt).
    held = [t for t in res.totes if t.keyframes and t.keyframes[-1][3] == "pack"
            and t.keyframes[-1][1] == 30.0]
    assert held, "a load taken off at the stop line is packed at the stop line"


def test_a_load_held_at_the_stop_line_backs_the_belt_up():
    """滞留が上流のブロックを起こす — and the control says it is the GATE doing it.

    The only difference between the two runs is the ``stop_gate``: the same belts,
    the same demand, the same 梱包 service. With the gate the containers stand on
    the trunk waiting for the one pair of hands at the stop line, the trunk fills
    from there backwards, and the picker ends up unable to let go. Without it they
    ride off the end into the (larger) shared pack pool and nothing ever waits."""
    with_gate = run_once(_gate_model(gate=True), seed=5)
    without = run_once(_gate_model(gate=False), seed=5)

    def blocks(res):
        return Counter(e["conveyor"] for e in _events(res, "conveyor_on")
                       if e.get("blocked"))

    def entry_blocks(res):
        return sum(1 for e in _events(res, "conveyor_on")
                   if e.get("blocked") and e["entry"] == 1)

    def max_hold(res):
        legs = [e for e in _events(res, "conveyor_off") if e["conveyor"] == "T"]
        return max(e["occupancy"] - e["transit"] for e in legs)

    assert blocks(with_gate)["T"] > 10, "the trunk must fill up behind the stop line"
    assert blocks(without)["T"] == 0, "...and without the gate nothing waits for it"
    # The back-pressure reaches the picker: it is standing at the 検品ライン unable
    # to hand its tote over (leg 0 = the entrance, logged by the picker agent).
    assert entry_blocks(with_gate) > 5 > entry_blocks(without)
    # A held load occupies its trunk slot for far longer than it takes to ride it.
    assert max_hold(with_gate) > 300.0 > max_hold(without)
    assert len(_events(with_gate, "order_complete")) < \
        len(_events(without, "order_complete"))
    assert not _events(without, "conveyor_gate")


def test_a_gate_that_names_nothing_is_not_a_gate():
    """never-blocks: a half-authored gate degrades to "no gate", never to a stall."""
    for spec in ({}, {"at_m": 10.0}, {"at_m": "ten", "stop_states": ["inspected"]},
                 {"at_m": 10.0, "stop_states": []}, None):
        m = _gate_model()
        m.resources.conveyors[2].stop_gate = spec
        world = build(m)
        assert {c.id: c.gate for c in world.conveyors}["T"] is None, spec
        assert len(_events(run_once(m, seed=5), "order_complete")) > 0

    # A gate past the end of the belt is clamped to the end (the load is simply
    # taken off there), and a string kind is read as one name.
    m = _gate_model()
    m.resources.conveyors[2].stop_gate = {"at_m": 999.0, "stop_states": "inspected"}
    gate = {c.id: c.gate for c in build(m).conveyors}["T"]
    assert gate is not None and gate.arc == 40.0
    assert gate.stop_kinds == frozenset({"inspected"})


def test_a_gate_with_no_one_standing_at_it_still_runs():
    """The half-drawn-line fallback: nobody at the stop line ⇒ the shared pack pool
    takes the held load, rather than the line refusing to deliver."""
    m = _gate_model()
    m.resources.stations = [Station(id="ship", x=44.0, y=14.0, count=4)]
    world = build(m)
    gate = {c.id: c.gate for c in world.conveyors}["T"]
    assert gate is not None and gate.bench is None and gate.n_bench == 0
    res = run_once(m, seed=5)
    assert _events(res, "conveyor_gate")
    assert len(_events(res, "order_complete")) > 10


# ================================================ 機構2: 容器の有限循環
# 投入時に容器を1個確保し、梱包完了で空になって上段の還流ベルトで戻る。


def _container_model(count=10, return_time=30.0, rate=120.0, duration=3600.0,
                     pack_time=40.0, return_belt="UP"):
    e = Conveyor(id="E", points=[[2.0, 3.0], [2.0, 12.0]], speed_mps=1.0)
    trunk = Conveyor(id="T", points=[[0.0, 12.0], [40.0, 12.0]], speed_mps=1.0)
    s1 = Conveyor(id="S1", points=[[10.0, 12.0], [10.0, 16.0]], speed_mps=1.0)
    # 2段駆動コンベア: the upper deck runs the other way and carries only empties, so
    # it is not part of any flow leg — the engine must still find it by id.
    up = Conveyor(id="UP", points=[[40.0, 12.5], [0.0, 12.5]], speed_mps=1.0,
                  elevation_m=1.1)
    edges = [_edge(PICK, INSPECT, "E"), _edge(INSPECT, PACK, "S1"),
             _edge(PACK, SHIP, "T")]
    m = _model([e, trunk, s1, up], edges,
               pick_xy=[(2.0, 2.0), (5.0, 2.0), (8.0, 2.0)],
               stations=[Station(id="b1", x=10.0, y=16.0, count=3)],
               rate=rate, pack_time=pack_time, duration=duration)
    m.process.container_pool = {"count": count, "return_time_s": return_time,
                                "return_belt": return_belt}
    return m


def test_the_pool_is_finite_never_exceeded_and_obeys_littles_law():
    m = _container_model(count=10)
    world = build(m)
    assert world.container_pool is not None and world.n_containers == 10
    assert world.container_pool.level == 10
    assert world.container_return_line is not None
    assert world.container_return_line.id == "UP"
    # The return deck is NOT one of the working belts: empty containers do not
    # contend for slots, and its capacity must not dilute the conveyor KPIs.
    assert "UP" not in {c.id for c in world.conveyors}

    k = kpis.compute([run_once(m, seed=5)], m)
    assert k["container_pool_size"] == 10
    assert 0 < k["containers_in_use_peak"] <= 10, "a pool of 10 cannot lend an 11th"
    assert 0.0 < k["containers_in_use_peak_t"] <= m.simulation.duration_s
    assert k["container_takes"] >= k["container_returns"] > 0

    # Little's law on the containers themselves: the average number OUT equals the
    # rate they go out at times how long each one stays out. The two are computed
    # from different things (a time integral vs per-container dwell), so agreement
    # is a real check that the pool is being accounted honestly.
    lam = k["container_returns"] / m.simulation.duration_s
    little = lam * k["container_use_mean_s"]
    assert k["containers_in_use_avg"] > 1.0
    assert abs(k["containers_in_use_avg"] - little) < 0.15 * k["containers_in_use_avg"], (
        k["containers_in_use_avg"], little)


def test_a_pool_that_never_binds_changes_nothing():
    """A pool bigger than the peak is not a constraint: the run is the same run,
    and the KPI only reports what was used (that peak IS the sizing answer)."""
    small = kpis.compute([run_once(_container_model(count=10), seed=5)],
                         _container_model(count=10))
    big = kpis.compute([run_once(_container_model(count=60), seed=5)],
                       _container_model(count=60))
    assert small["containers_in_use_peak"] == big["containers_in_use_peak"] == 10
    assert small["throughput_per_hr"] == big["throughput_per_hr"]
    assert small["container_wait_total_s"] == big["container_wait_total_s"] == 0.0


def test_a_pool_of_nothing_is_not_a_pool():
    """never-blocks: a mis-typed or empty pool falls back to 容器は無限, never to a
    pool with nothing in it — a warehouse with zero containers ships nothing."""
    for count in (0, -3, "x", None):
        m = _container_model(count=10)
        m.process.container_pool = {"count": count, "return_time_s": 30.0,
                                    "return_belt": "UP"}
        world = build(m)
        assert world.container_pool is None and world.n_containers == 0, count
        assert world.container_return_line is None and world.container_return_s == 0.0
        assert len(_events(run_once(m, seed=5), "order_complete")) > 10
    m = _container_model(count=10)
    m.process.container_pool = {}
    assert build(m).container_pool is None


def test_too_few_containers_stop_投入_and_cost_throughput():
    """The shortage has to be VISIBLE, because it is the one bottleneck a customer
    can buy their way out of. 投入 waits, and the line delivers less."""
    plenty = kpis.compute([run_once(_container_model(count=60), seed=5)],
                          _container_model(count=60))
    starved = kpis.compute([run_once(_container_model(count=2), seed=5)],
                           _container_model(count=2))
    assert starved["container_wait_total_s"] > 600.0
    assert starved["container_waits"] > 10
    assert starved["containers_in_use_peak"] == 2
    assert starved["throughput_per_hr"] < 0.8 * plenty["throughput_per_hr"]
    # ...and it is said out loud, with the two numbers a buyer needs.
    assert "容器は同時最大 2 個使用" in starved["verdict"]
    assert "容器待ちで投入が止まった時間" in starved["verdict"]
    assert "容器" not in plenty["verdict"].split("。容器は同時最大")[0]


def test_an_emptied_container_rides_the_return_deck_home():
    """梱包完了 = 中身が出た: the container is empty, goes back up the 還流ベルト and
    only THEN is available again. The replay carries it as its own track on that
    deck (additive: goods tracks are unchanged and state no kind)."""
    m = _container_model(count=10)
    res = run_once(m, seed=5)
    empties = [t for t in res.totes if t.kind == "empty"]
    assert empties, "the empties are physical traffic — they must be drawn"
    for t in empties:
        assert t.belt_id == "UP", "an empty rides the upper deck, not the trunk"
        assert [f[3] for f in t.keyframes] == ["belt"] * len(t.keyframes)
        assert all(f[2] == 12.5 for f in t.keyframes), "the deck runs at y=12.5"
        xs = [f[1] for f in t.keyframes]
        assert xs == sorted(xs, reverse=True), "and it runs the other way (東→西)"

    doc = build_replay(m, res, kpis.compute([res], m))
    empty_docs = [d for d in doc["totes"] if d.get("kind") == "empty"]
    assert empty_docs and all(d["belt_id"] == "UP" for d in empty_docs)
    goods = [d for d in doc["totes"] if d.get("kind") != "empty"]
    assert goods and all("kind" not in d and "belt_id" not in d for d in goods), (
        "an unclassified tote must not emit the keys at all (null reads as a belt)")

    # A pool with no return belt named is still a pool — the container just costs
    # return_time_s and is drawn nowhere (never-blocks).
    plain = _container_model(count=10, return_belt="")
    world = build(plain)
    assert world.container_pool is not None and world.container_return_line is None
    k = kpis.compute([run_once(plain, seed=5)], plain)
    assert k["container_returns"] > 0


# ======================================= 機構3: 引き込みは作業者が引く (pull)


def _pull_model(policy="auto", bench=3, rate=150.0, duration=1800.0, pack_time=60.0):
    """検品ライン E → 本線 T → 引き込み S1/S2 → 梱包台.

    The spurs are long (20 slots each) on purpose: with 貪欲ディバート they can hold
    everything the run produces, so the number of loads that go IN is decided by the
    belt and not by the benches. That is exactly the assumption "pull" removes."""
    e = Conveyor(id="E", points=[[2.0, 3.0], [2.0, 12.0]], speed_mps=1.0)
    trunk = Conveyor(id="T", points=[[0.0, 12.0], [40.0, 12.0]], speed_mps=1.0)
    s1 = Conveyor(id="S1", points=[[10.0, 12.0], [10.0, 32.0]], speed_mps=1.0)
    s2 = Conveyor(id="S2", points=[[20.0, 12.0], [20.0, 32.0]], speed_mps=1.0)
    edges = [_edge(PICK, INSPECT, "E"), _edge(INSPECT, PACK, "S1"),
             _edge(INSPECT, PACK, "S2"), _edge(PACK, SHIP, "T")]
    stations = [Station(id="b1", x=10.0, y=32.0, count=bench),
                Station(id="b2", x=20.0, y=32.0, count=bench)]
    m = _model([e, trunk, s1, s2], edges,
               pick_xy=[(2.0, 2.0), (5.0, 2.0), (8.0, 2.0)],
               rate=rate, pack_time=pack_time, stations=stations, duration=duration)
    m.process.divert_policy = policy
    return m


def _diverted(res):
    """引き込み量: loads that actually went INTO a 引き込み."""
    return sum(1 for e in _events(res, "conveyor_on")
               if e["conveyor"].startswith("S"))


def test_pull_only_takes_what_a_free_bench_can_take():
    """作業者数を減らすと引き込み量が落ちる — and under 貪欲ディバート it does not.

    That difference is the whole point. With the greedy rule the load enters the
    spur whether or not anybody is there and queues on the belt, so cutting the
    benches in half leaves 引き込み量 untouched and the understaffing hides inside
    the queue. Pulled in, an empty-handed 引き込み takes nothing."""
    assert build(_pull_model(policy="pull")).divert_policy == "pull"
    assert build(_pull_model()).divert_policy == "auto"

    auto_full = _diverted(run_once(_pull_model("auto", bench=3), seed=5))
    auto_thin = _diverted(run_once(_pull_model("auto", bench=1), seed=5))
    pull_full = _diverted(run_once(_pull_model("pull", bench=3), seed=5))
    pull_thin = _diverted(run_once(_pull_model("pull", bench=1), seed=5))

    assert auto_thin == auto_full, (
        "貪欲ディバート is blind to staffing — that is what makes it optimistic")
    assert pull_full > 0.9 * auto_full, "a manned line still takes nearly everything"
    assert pull_thin < 0.7 * pull_full, (
        f"a thin line must take visibly less: {pull_thin} vs {pull_full}")


def test_what_no_one_pulled_in_stays_on_the_trunk():
    """A load nobody had hands for does not wait at the pull-in — it rides past.

    Which is the honest picture: on the floor it keeps going and someone deals with
    it at the far end (or, with a 停止線 authored, it stands there). Under 貪欲
    ディバート nothing ever reaches the end of the trunk."""
    thin = run_once(_pull_model("pull", bench=1), seed=5)
    auto = run_once(_pull_model("auto", bench=1), seed=5)

    def packed_at(res):
        return Counter(e["conveyor"] for e in _events(res, "conveyor_off")
                       if e["last"])

    assert packed_at(thin)["T"] > 10, "the un-pulled loads run out at the trunk end"
    assert packed_at(auto)["T"] == 0, "greedy diverts everything before it gets there"
    # Both 引き込み are used under pull: whichever bench is free takes the load, so
    # the far one is not merely the near one's overflow.
    assert {"S1", "S2"} <= set(packed_at(thin))


def test_pull_never_stalls_the_trunk_waiting_for_a_bench():
    """The structural property that replaces the auto rule's deadlock-freedom
    argument: under "pull" a load only ever moves forward, so it cannot hold a
    trunk slot waiting for something upstream of it to free up."""
    res = run_once(_pull_model("pull", bench=1, rate=300.0), seed=5)
    trunk = [e for e in _events(res, "conveyor_off") if e["conveyor"] == "T"]
    assert trunk
    # occupancy on the trunk is the ride plus (at most) the wait for the pack pool
    # at its end — never an open-ended stall at a junction.
    assert all(e["occupancy"] >= e["transit"] - 1e-9 for e in trunk)
    done = _events(res, "order_complete")
    assert len(done) > 20 and done[-1]["t"] > 0.8 * res.duration_s


# ======================================= 引き込みの梱包台: 端と持ち主の決め方
# 引き込みは物理的には**本線を跨ぐ1本**で、両側に梱包台が並ぶ。半分ずつ描かれた図面
# （＝同梱テンプレート）では末端が自分の台なので従来どおり。1本で描かれると本線は
# 真ん中で交わり、末端だけ見ると片側の列が丸ごと無人になる。


def _through_spur_model(spur_points, stations, edges_ref="S"):
    trunk = Conveyor(id="T", points=[[0.0, 10.0], [40.0, 10.0]], speed_mps=1.0,
                     tote_pitch_m=1.0)
    entry = Conveyor(id="E", points=[[2.0, 2.0], [2.0, 10.0]], speed_mps=1.0,
                     tote_pitch_m=1.0)
    spur = Conveyor(id=edges_ref, points=spur_points, speed_mps=0.5, tote_pitch_m=1.0)
    return _model([entry, trunk, spur],
                  [_edge(PICK, INSPECT, "E"), _edge(INSPECT, PACK, edges_ref),
                   _edge(PACK, SHIP, "T")],      # 本線を配線しないとベルト集合に居ない
                  pick_xy=[(3.0, 2.0)], stations=stations, duration=600.0)


def _bench_counts(model):
    w = build(model)
    return {c.id: c.n_bench for c in w.conveyors if c.n_bench}


def test_a_spur_crossing_the_trunk_gets_the_benches_on_both_sides():
    """本線が真ん中で交わる1本の引き込み ⇒ 両端が払い出し口。"""
    counts = _bench_counts(_through_spur_model(
        [[20.0, 6.0], [20.0, 14.0]],          # y=10 の本線を跨ぐ
        [Station(id="north", x=21.5, y=6.5, count=2),
         Station(id="south", x=21.5, y=13.5, count=2)]))
    assert counts == {"S": 4}, "末端だけ見ると南（または北）の2台が無人になる"


def test_a_spur_that_ends_on_the_trunk_keeps_reading_its_far_end_only():
    """半分ずつ描かれた図面（＝同梱テンプレート）の従来挙動。"""
    counts = _bench_counts(_through_spur_model(
        [[20.0, 10.0], [20.0, 16.0]],          # 始端が本線の上＝そこは払い出さない
        [Station(id="far", x=21.0, y=15.5, count=2),
         Station(id="on_trunk", x=21.0, y=10.5, count=5)]))
    assert counts == {"S": 2}, "本線に接する端は乗り口であって払い出し口ではない"


def test_a_bench_between_two_spurs_belongs_to_the_nearer_one():
    trunk = Conveyor(id="T", points=[[0.0, 10.0], [40.0, 10.0]], speed_mps=1.0,
                     tote_pitch_m=1.0)
    entry = Conveyor(id="E", points=[[2.0, 2.0], [2.0, 10.0]], speed_mps=1.0,
                     tote_pitch_m=1.0)
    a = Conveyor(id="A", points=[[20.0, 10.0], [20.0, 15.0]], speed_mps=0.5,
                 tote_pitch_m=1.0)
    b = Conveyor(id="B", points=[[24.0, 10.0], [24.0, 15.0]], speed_mps=0.5,
                 tote_pitch_m=1.0)
    m = _model([entry, trunk, a, b],
               [_edge(PICK, INSPECT, "E"), _edge(INSPECT, PACK, "A"),
                _edge(INSPECT, PACK, "B"), _edge(PACK, SHIP, "T")],
               pick_xy=[(3.0, 2.0)], duration=600.0,
               stations=[Station(id="near_a", x=20.5, y=15.0, count=1),
                         # A から 2.6m / B から 1.6m — 手の届く方が引く
                         Station(id="mid", x=22.6, y=15.0, count=1),
                         Station(id="near_b", x=24.5, y=15.0, count=1)])
    assert _bench_counts(m) == {"A": 1, "B": 2}


# ==================================================== 既定OFF: バイト同一
# Captured from the PRE-CHANGE tree (a `git worktree` of HEAD, same seeds, same
# model) — not merely frozen from the current one. The three mechanisms are all
# opt-in, so a shipped model must produce the same event log, the same
# trajectories and the same replay document as before they existed. The ONLY
# admissible difference is additive KPI keys, all of them zero.
_LINE_INSPECTION_EVENTS_SHA = \
    "c5b7bb15bdcdc4c71b3f909f883627ab52984822393c59b3e092daf455ffa3f8"
_LINE_INSPECTION_TOTES_SHA = \
    "5dff9aa51c3de122698c4e595a325b995fcc8045297249c0e6b850da18731501"


def _sha(obj) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, default=str, ensure_ascii=False).encode()
    ).hexdigest()


def test_the_three_mechanisms_are_off_in_every_shipped_model():
    for manifest in templates.list_templates():
        m = templates.load_template_model(manifest["template_id"])
        assert m.process.container_pool is None
        assert m.process.divert_policy == "auto"
        assert all(c.stop_gate is None for c in m.resources.conveyors)
        assert all(not c.load_kind for c in m.resources.conveyors)


def test_the_default_engine_is_byte_identical_on_the_shipped_line():
    """``line_inspection`` is the model with every belt feature in it, so it is the
    one that would notice. Same events, same keyframes, same replay."""
    m = templates.load_template_model("line_inspection")
    m.simulation.duration_s = 3600.0
    world = build(m)
    assert world.container_pool is None and world.container_return_line is None
    assert world.divert_policy == "auto"
    assert all(c.gate is None and c.load_kind == "" for c in world.conveyors)

    res = run_once(m, seed=11)
    assert _sha(res.events) == _LINE_INSPECTION_EVENTS_SHA
    assert len(res.events) == 4662
    assert dict(Counter(e["event"] for e in res.events)) == {
        "order_arrive": 391, "pick_start": 378, "pick_done": 376,
        "conveyor_on": 1152, "forklift_done": 146, "conveyor_off": 1125,
        "pack_start": 370, "pack_done": 362, "order_complete": 362}
    assert [len(w.keyframes) for w in res.workers] == \
        [148, 166, 160, 156, 178, 153, 150, 131, 140, 138]
    assert _sha([[t.id, t.keyframes] for t in res.totes]) == _LINE_INSPECTION_TOTES_SHA
    assert len(res.totes) == 89
    assert math.isclose(sum(e["t"] for e in res.events), 8617935.006491639,
                        rel_tol=1e-12)

    k = kpis.compute([res], m)
    for key, want in {
        "orders_arrived": 391.0,
        "orders_completed": 362.0,
        "throughput_per_hr": 362.0,
        "cycle_mean_s": 303.5543841860749,
        "picker_utilization": 0.5254843094765743,
        "packer_utilization": 0.39216666666666666,
        "conveyor_utilization": 0.10514923047287379,
        "walk_total_m": 18696.77503818924,
    }.items():
        assert math.isclose(k[key], want, rel_tol=1e-12), (key, k[key], want)
    assert k["verdict"] == (
        "要注意 — ピッキングがボトルネック（稼働率 53%）。オーダーの 93% しか出荷完了しません")

    # The new KPI keys exist, are all zero, and nothing draws a tote differently.
    for key in ("conveyor_gate_stops", "container_pool_size", "container_takes",
                "container_returns", "container_waits", "container_wait_total_s",
                "container_use_mean_s", "containers_in_use_avg",
                "containers_in_use_peak", "containers_in_use_peak_t"):
        assert k[key] == 0, key
    doc = build_replay(m, res, k)
    assert doc["totes"] and all(set(d) == {"id", "keyframes"} for d in doc["totes"])
