"""コンベア搬送: per-line belts, boarding on the PATH, and the tote replay tracks.

The headline behaviour these pin down: a tote pays only the distance from where
it BOARDS to its own line's discharge end (the old engine merged every conveyor
into one virtual belt and charged every tote the summed length), each line jams
independently, and the goods themselves are emitted as replay tracks.
"""

import math

import simpy

from whsim import kpis, templates
from whsim.engine.build import MAX_TOTE_TRACKS, build
from whsim.engine.processes import _board_conveyor
from whsim.engine.run import run_once, run_replications
from whsim.render import replay
from whsim.schema.model import (
    Bounds, Conveyor, Item, Location, OrderProfile, Station, WarehouseModel, WorkerGroup,
)

STRAIGHT = [[0.0, 10.0], [50.0, 10.0]]          # infeed x=0 -> discharge x=50
BENT = [[5.0, 10.0], [45.0, 10.0], [45.0, 2.0]]  # L: run east, then turn south


def _model(sku_xs, conveyors, *, rate=60.0, duration=1800.0, pickers=1,
           pack_time=10.0, stations=2, sku_y=5.0):
    """A bare floor (no walls => Manhattan routing) with pick faces on a row."""
    m = WarehouseModel()
    m.layout.bounds = Bounds(width=60.0, depth=20.0)
    m.locations = [Location(id=f"L{i}", x=float(x), y=sku_y, sku=f"S{i}")
                   for i, x in enumerate(sku_xs)]
    m.items = [Item(sku=f"S{i}", pick_freq=1.0, ts_per_unit=1.0, default_location=f"L{i}")
               for i in range(len(sku_xs))]
    m.resources.workers = [WorkerGroup(id="pickers", role="picker", count=pickers)]
    m.resources.stations = [Station(id="pack", x=55.0, y=10.0, count=stations)]
    m.resources.conveyors = conveyors
    # A drawn belt is a physical fact; whether goods TRAVEL on it is a design
    # decision (see whsim/flowgraph.py). These tests are about conveyor
    # mechanics, so the design declares that packing is fed by the belt —
    # otherwise the engine correctly runs no conveyor at all.
    if conveyors:
        for st in m.process.stages:
            if st.id == "pack":
                st.method = "conveyor"
    m.orders.profile = OrderProfile(rate_per_hr=rate, lines_per_order_mean=1.0)
    m.process.pack_time_s = pack_time
    m.simulation.duration_s = duration
    m.simulation.random_seed = 7
    return m


def _transits(res):
    return [e["transit"] for e in res.events if e["event"] == "conveyor_off"]


# --- 1. boarding is the nearest point ON the path ---------------------------

def test_boarding_projects_onto_the_path_not_onto_a_vertex():
    """A picker beside the MIDDLE of a belt boards the middle of it. The old
    engine snapped to the nearest vertex, i.e. a belt end tens of metres away."""
    world = build(_model([25.0], [Conveyor(id="c1", points=STRAIGHT, speed_mps=1.0)]))
    line = world.conveyors[0]

    xy, arc = line.project((25.0, 3.0))
    assert xy == (25.0, 10.0)          # perpendicular foot, not (0,10) or (50,10)
    assert arc == 25.0                 # 25 m of belt already behind it
    # Off the end clamps to the segment's end (never extrapolates).
    assert line.project((-8.0, 10.0)) == ((0.0, 10.0), 0.0)
    assert line.project((80.0, 10.0)) == ((50.0, 10.0), 50.0)

    # _board_conveyor picks the LINE whose path runs nearest, then that point.
    picked, board_xy, board_arc = _board_conveyor(world, (25.0, 3.0))
    assert picked is line and board_xy == (25.0, 10.0) and board_arc == 25.0


def test_boarding_on_a_bent_belt_lands_on_the_right_leg():
    world = build(_model([40.0], [Conveyor(id="c1", points=BENT, speed_mps=1.0)]))
    line = world.conveyors[0]
    # Beside the first (horizontal) leg.
    xy, arc = line.project((20.0, 14.0))
    assert xy == (20.0, 10.0) and math.isclose(arc, 15.0)
    # Beside the second (vertical) leg -> arc counts the whole first leg + the drop.
    xy2, arc2 = line.project((43.0, 5.0))
    assert xy2 == (45.0, 5.0) and math.isclose(arc2, 40.0 + 5.0)
    assert math.isclose(line.length, 48.0)


def test_the_nearest_of_two_lines_wins():
    world = build(_model([10.0], [
        Conveyor(id="north", points=[[0.0, 18.0], [50.0, 18.0]], speed_mps=1.0),
        Conveyor(id="south", points=[[0.0, 2.0], [50.0, 2.0]], speed_mps=1.0),
    ]))
    assert _board_conveyor(world, (10.0, 4.0))[0].id == "south"
    assert _board_conveyor(world, (10.0, 16.0))[0].id == "north"


# --- 2. THE headline fix: transit is measured from the boarding point --------

def test_boarding_near_the_discharge_rides_less_than_boarding_at_the_far_end():
    """Numerical proof of the fix. One 50 m belt at 1 m/s: pick faces at the
    infeed end ride ~50 s, pick faces at the discharge end ride ~5 s. The old
    engine charged BOTH the full summed belt length."""
    cv = [Conveyor(id="c1", points=STRAIGHT, speed_mps=1.0)]
    far = run_once(_model([2.0, 3.0, 4.0], cv), seed=11)       # board at x~2-4
    near = run_once(_model([45.0, 46.0, 47.0], cv), seed=11)   # board at x~45-47

    t_far, t_near = _transits(far), _transits(near)
    assert t_far and t_near
    mean_far = sum(t_far) / len(t_far)
    mean_near = sum(t_near) / len(t_near)
    # length 50 m / 1 m/s: 50-arc seconds, so ~47 s vs ~4 s.
    assert 46.0 <= mean_far <= 48.0, mean_far
    assert 3.0 <= mean_near <= 5.0, mean_near
    assert mean_near < mean_far / 8.0
    # Nobody pays the full belt length any more (the legacy aggregate did).
    assert max(t_far) < 50.0
    # Exact per-tote identity: transit == remaining path / this line's speed.
    for e in far.events:
        if e["event"] == "conveyor_off":
            assert math.isclose(e["transit"], e["ride_m"] / 1.0, rel_tol=1e-9)


def test_each_line_keeps_its_own_speed_and_capacity():
    """Two separate belts of different length/speed: capacity is per line
    (~1 tote per metre of ITS length), never the sum, and so is transit."""
    world = build(_model([10.0, 40.0], [
        Conveyor(id="slow", points=[[0.0, 18.0], [30.0, 18.0]], speed_mps=0.5),
        Conveyor(id="fast", points=[[0.0, 2.0], [12.0, 2.0]], speed_mps=2.0),
    ]))
    slow, fast = world.conveyors
    assert (slow.capacity, fast.capacity) == (30, 12)      # not one belt of 42
    assert slow.belt.capacity == 30 and fast.belt.capacity == 12
    assert slow.belt is not fast.belt                       # independent jamming
    assert (slow.speed, fast.speed) == (0.5, 2.0)
    # Same boarding arc, different line => different ride time.
    assert slow.remaining(10.0) / slow.speed == 40.0
    assert fast.remaining(10.0) / fast.speed == 1.0


def test_two_lines_carry_their_own_totes():
    """Pickers hand over to the belt nearest THEM, and each tote's transit is
    resolved against that line's own geometry/speed."""
    m = _model([8.0, 9.0], [
        Conveyor(id="north", points=[[0.0, 18.0], [40.0, 18.0]], speed_mps=1.0),
        Conveyor(id="south", points=[[0.0, 2.0], [20.0, 2.0]], speed_mps=1.0),
    ], sku_y=3.0, duration=1200.0)
    res = run_once(m, seed=5)
    used = {e["conveyor"] for e in res.events if e["event"] == "conveyor_off"}
    assert used == {"south"}                       # faces at y=3 are next to south
    # south: 20 m long, board at x~8-9 => ~11-12 s. north would have been ~31 s.
    for e in res.events:
        if e["event"] == "conveyor_off":
            assert 10.5 <= e["transit"] <= 12.5


# --- 3. tote tracks: the goods are emitted, and they follow the belt ---------

def _complete_totes(res):
    """Tracks whose whole journey fits inside the replay window (a tote still
    riding when the window closes is legitimately cut off, like a worker)."""
    return [t for t in res.totes if t.keyframes and t.keyframes[-1][3] == "pack"]


def _tote_frames(res, state=None):
    out = []
    for t in _complete_totes(res):
        fs = [f for f in t.keyframes if state is None or f[3] == state]
        if fs:
            out.append((t.id, fs))
    return out


def _dist_to_polyline(p, pts):
    best = float("inf")
    for a, b in zip(pts, pts[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 <= 1e-12 else ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / seg2
        t = max(0.0, min(1.0, t))
        q = (a[0] + dx * t, a[1] + dy * t)
        best = min(best, math.dist(p, q))
    return best


def test_tote_keyframes_obey_the_contract():
    res = run_once(_model([20.0], [Conveyor(id="c1", points=STRAIGHT, speed_mps=1.0)]),
                   seed=3)
    assert res.totes, "the conveyor run must emit tote tracks"
    ids = [t.id for t in res.totes]
    assert len(ids) == len(set(ids))
    for t in res.totes:
        assert t.keyframes
        for f in t.keyframes:
            assert len(f) == 4
            assert isinstance(f[0], float) and isinstance(f[1], float)
            assert isinstance(f[2], float) and isinstance(f[3], str)
            assert f[3] in {"carry", "belt", "pack"}
        ts = [f[0] for f in t.keyframes]
        assert ts == sorted(ts)                       # monotone in time
        assert all(t_ <= res.replay_window_s + 1e-9 for t_ in ts)  # replay window honoured
        states = [f[3] for f in t.keyframes]
        assert states[0] == "carry"                   # born in the picker's hands
        # states never go backwards (carry -> belt -> pack)
        rank = {"carry": 0, "belt": 1, "pack": 2}
        assert [rank[s] for s in states] == sorted(rank[s] for s in states)
    done = _complete_totes(res)
    assert len(done) > 5                              # most rides finish in-window
    for t in done:
        states = [f[3] for f in t.keyframes]
        assert "belt" in states                       # rides the belt
        assert states[-1] == "pack"                   # ends at the discharge/pack point


def test_tote_track_follows_a_bent_belt_and_keeps_its_corner():
    """A viewer lerps between keyframes, so the emitted belt track must trace the
    polyline: every consecutive pair (and its midpoint) lies on the path, and the
    L-shaped belt's track carries an INTERIOR keyframe at the bend."""
    res = run_once(_model([12.0], [Conveyor(id="c1", points=BENT, speed_mps=1.0)]),
                   seed=3)
    pts = [(p[0], p[1]) for p in BENT]
    tracks = _tote_frames(res, "belt")
    assert tracks
    corner_seen = 0
    for _tid, frames in tracks:
        assert len(frames) >= 2
        for f in frames:
            assert _dist_to_polyline((f[1], f[2]), pts) < 1e-3
        for a, b in zip(frames, frames[1:]):
            mid = ((a[1] + b[1]) / 2.0, (a[2] + b[2]) / 2.0)
            assert _dist_to_polyline(mid, pts) < 1e-3   # the straight lerp stays on the belt
        # the bend must be an actual interior keyframe (not cut across)
        interior = frames[1:-1]
        if any(math.dist((f[1], f[2]), (45.0, 10.0)) < 1e-3 for f in interior):
            corner_seen += 1
        assert math.dist((frames[-1][1], frames[-1][2]), (45.0, 2.0)) < 1e-3  # discharge end
    assert corner_seen == len(tracks)


def test_carry_track_precedes_the_belt_at_the_boarding_point():
    res = run_once(_model([20.0], [Conveyor(id="c1", points=STRAIGHT, speed_mps=1.0)]),
                   seed=3)
    for t in _complete_totes(res):
        carry = [f for f in t.keyframes if f[3] == "carry"]
        belt = [f for f in t.keyframes if f[3] == "belt"]
        # the hand-off is continuous: last carry position == first belt position
        assert (carry[-1][1], carry[-1][2]) == (belt[0][1], belt[0][2])
        assert belt[0][2] == 10.0                     # on the belt's centre-line


def test_replay_dict_exposes_the_totes():
    m = _model([20.0], [Conveyor(id="c1", points=STRAIGHT, speed_mps=1.0)])
    res = run_once(m, seed=3)
    rep = replay.build_replay(m, res, kpis.compute([res], m))
    assert "totes" in rep and rep["totes"]
    first = rep["totes"][0]
    assert set(first) == {"id", "keyframes"}
    assert first["keyframes"] and len(first["keyframes"][0]) == 4


def test_tote_tracks_are_capped():
    """Memory guard: at most MAX_TOTE_TRACKS (=400) tracks per run, and none at
    all outside the replay window."""
    assert MAX_TOTE_TRACKS == 400
    world = build(_model([20.0], [Conveyor(id="c1", points=STRAIGHT, speed_mps=1.0)]),
                  replay_window_s=100.0)
    world.tote_cap = 3
    made = [world.new_tote(f"O{i}") for i in range(6)]
    assert sum(1 for t in made if t is not None) == 3
    assert len(world.totes) == 3
    world.env.run(until=200.0)                    # past the replay window
    assert world.new_tote("late") is None

    # A run that never records (later replications) emits no tracks.
    res = run_once(_model([20.0], [Conveyor(id="c1", points=STRAIGHT, speed_mps=1.0)]),
                   seed=3, replay_window_s=0.0)
    assert all(len(t.keyframes) <= 2 for t in res.totes)


# --- 4. the good parts are preserved: jam back-pressure + accumulation -------

def test_jam_backpressure_blocks_the_picker():
    """A 2 m belt (2 slots) with a slow single pack station: totes hold their slot
    through packing (accumulation), so pickers BLOCK at the hand-off."""
    m = _model([20.0, 21.0], [Conveyor(id="c1", points=[[20.0, 10.0], [22.0, 10.0]],
                                       speed_mps=1.0)],
               rate=240.0, duration=1800.0, pickers=4, pack_time=120.0, stations=1)
    res = run_once(m, seed=9)
    ons = [e for e in res.events if e["event"] == "conveyor_on"]
    assert ons
    waits = [e["wait"] for e in ons]
    blocked = [w for w in waits if w > 1e-6]
    assert blocked, "a full belt must block the picker (back-pressure)"
    assert max(waits) > 60.0                    # the jam is measurable, not a blip
    k = kpis.compute([res], m)
    assert k["conveyor_jams"] == len(blocked)
    assert k["conveyor_wait_mean_s"] > 0.0
    assert k["conveyor_utilization"] > 0.9      # 2 slots, permanently occupied
    assert k["bottleneck"] == "conveyor"        # named as the constraint
    assert "コンベア搬送" in k["verdict"]
    arrived = sum(1 for e in res.events if e["event"] == "order_arrive")
    completed = sum(1 for e in res.events if e["event"] == "order_complete")
    assert completed < arrived * 0.5            # the jam propagates all the way up


def test_accumulation_holds_the_slot_through_packing():
    """occupancy (board -> release) must exceed transit by the pack time."""
    m = _model([20.0], [Conveyor(id="c1", points=STRAIGHT, speed_mps=1.0)],
               pack_time=30.0)
    res = run_once(m, seed=4)
    offs = [e for e in res.events if e["event"] == "conveyor_off"]
    assert offs
    for e in offs:
        assert e["occupancy"] >= e["transit"] + 30.0 - 1e-6


def test_conveyor_kpis_are_additive_and_sane():
    m = _model([20.0], [Conveyor(id="c1", points=STRAIGHT, speed_mps=1.0)])
    res = run_once(m, seed=4)
    k = kpis.compute([res], m)
    assert k["n_conveyors"] == 1
    assert k["conveyor_capacity"] == 50
    assert k["conveyor_totes"] > 0
    assert 29.0 <= k["conveyor_transit_mean_s"] <= 31.0     # board x~20 => 30 m left
    assert 0.0 < k["conveyor_utilization"] < 1.0
    assert k["conveyor_wait_mean_s"] >= 0.0


def test_legacy_conveyor_jam_scenario_still_backs_up():
    """The pre-existing rigor scenario (tests/test_rigor.py) keeps its meaning."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 7200
    m.resources.conveyors = [Conveyor(id="c1", points=[[12, 15], [40, 15]], speed_mps=0.5)]
    m.resources.stations[0].count = 1
    m.process.pack_time_s = 120
    # Declare the design intent the belt implies: goods reach packing on the
    # conveyor. Drawing a belt alone no longer routes work onto it (flowgraph.py).
    for _st in m.process.stages:
        if _st.id == "pack":
            _st.method = "conveyor"
    res = run_once(m)
    on_belt = sum(1 for e in res.events if e["event"] == "conveyor_on")
    arrived = sum(1 for e in res.events if e["event"] == "order_arrive")
    completed = sum(1 for e in res.events if e["event"] == "order_complete")
    assert on_belt > 0 and completed < arrived * 0.8


# --- 5. never-blocks: degenerate geometry, and the no-conveyor regression ----

def test_degenerate_conveyors_never_crash():
    """Empty / single-point / zero-length / zero-speed conveyors must not divide
    by zero or block: they are simply not transport."""
    m = _model([20.0], [
        Conveyor(id="empty", points=[], speed_mps=1.0),
        Conveyor(id="dot", points=[[5.0, 5.0]], speed_mps=1.0),
        Conveyor(id="zero_len", points=[[5.0, 5.0], [5.0, 5.0]], speed_mps=1.0),
    ])
    world = build(m)
    assert world.conveyors == [] and world.has_conveyor is False
    res = run_once(m, seed=2)                       # falls back to carry-to-pack
    assert not [e for e in res.events if e["event"] == "conveyor_on"]
    assert res.totes == []
    assert sum(1 for e in res.events if e["event"] == "order_complete") > 0

    # Zero / negative speed on REAL geometry falls back to the schema default.
    for bad in (0.0, -3.0):
        w2 = build(_model([20.0], [Conveyor(id="c1", points=STRAIGHT, speed_mps=bad)]))
        assert w2.conveyors[0].speed == 0.5
        assert math.isfinite(w2.conveyors[0].remaining(0.0) / w2.conveyors[0].speed)
    res2 = run_once(_model([20.0], [Conveyor(id="c1", points=STRAIGHT, speed_mps=0.0)]),
                    seed=2)
    assert [e for e in res2.events if e["event"] == "conveyor_on"]


def test_degenerate_lines_are_skipped_but_real_ones_still_run():
    m = _model([20.0], [
        Conveyor(id="dot", points=[[5.0, 5.0]], speed_mps=1.0),
        Conveyor(id="real", points=STRAIGHT, speed_mps=1.0),
    ])
    world = build(m)
    assert [c.id for c in world.conveyors] == ["real"]
    res = run_once(m, seed=2)
    assert {e["conveyor"] for e in res.events if e["event"] == "conveyor_off"} == {"real"}


def test_zero_length_tail_never_divides_by_zero():
    """Boarding AT the discharge end: zero remaining path, zero transit, no crash."""
    world = build(_model([50.0], [Conveyor(id="c1", points=STRAIGHT, speed_mps=1.0)]))
    line = world.conveyors[0]
    _xy, arc = line.project((50.0, 3.0))
    assert arc == 50.0 and line.remaining(arc) == 0.0
    assert line.tail(arc) == [(50.0, 10.0)]
    assert line.tail(999.0) == [(50.0, 10.0)]        # clamped past the end
    res = run_once(_model([50.0], [Conveyor(id="c1", points=STRAIGHT, speed_mps=1.0)]),
                   seed=6)
    assert all(t == 0.0 for t in _transits(res))


def test_build_is_reentrant_on_a_shared_env():
    """Each line's Resource belongs to the world's own env (no cross-run leakage)."""
    env = simpy.Environment()
    world = build(_model([20.0], [Conveyor(id="c1", points=STRAIGHT, speed_mps=1.0)]),
                  env=env)
    assert world.conveyors[0].belt._env is env


def test_no_conveyor_run_is_byte_identical():
    """Regression bar: a model with NO conveyors must produce exactly the KPIs the
    pre-change engine produced (captured from HEAD at 3 fixed-seed replications)."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 7200
    m.simulation.random_seed = 4242
    assert not m.resources.conveyors
    results, heat = run_replications(m, reps=3)
    k = kpis.compute(results, m)

    assert len(results[0].events) == 1475
    assert len(results[0].workers[0].keyframes) == 141
    assert math.isclose(float(heat.sum()), 21930.333333333332, rel_tol=1e-12)
    expected = {
        "orders_arrived": 238.33333333333334,
        "orders_completed": 233.0,
        "completion_rate": 0.9775296191860532,
        "throughput_per_hr": 116.5,
        "cycle_mean_s": 210.63565025826347,
        "cycle_p95_s": 346.2216219760376,
        "picker_utilization": 0.8620383767197456,
        "packer_utilization": 0.4314814814814815,
        "walk_total_m": 31257.0,
        "walk_per_order_m": 134.1712327056937,
        "picker_walk_s": 26047.5,
        "picker_handle_s": 11192.557874293008,
        "total_cost_per_order": 154.78038029341812,
        "monthly_cost": 3168000.0,
        "robustness": 0.3333333333333333,
        "bottleneck_utilization": 0.8620383767197456,
    }
    for key, want in expected.items():
        assert math.isclose(k[key], want, rel_tol=1e-12), (key, k[key], want)
    assert k["bottleneck"] == "picking"
    assert k["verdict"] == (
        "要注意 — ピッキングがボトルネック（稼働率 86%）。"
        "オーダーの 98% しか出荷完了しません（3回中1回が安定処理）"
    )
    # ...and the new conveyor KPIs are present-but-zero (additive, never blocks).
    assert k["n_conveyors"] == 0 and k["conveyor_capacity"] == 0
    assert k["conveyor_totes"] == 0 and k["conveyor_utilization"] == 0.0
    assert results[0].totes == []
