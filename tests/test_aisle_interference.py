"""通路干渉 (aisle interference) + the event log the KPIs are derived from.

Until now every transport agent in the DES walked straight THROUGH every other
one: two pickers could occupy the same metre of the same aisle at the same second
and neither noticed. That is the one thing a warehouse operator will not accept
in a congestion answer — 「通路で待つ」 is the whole reason a layout gets redrawn —
and it made the engine structurally unable to say anything about aisle width.

What is pinned here:

* two agents entering the SAME aisle cell in the SAME direction queue, and the
  queueing shows up as ``aisle_wait`` seconds and congestion KPIs;
* opposite directions do NOT queue (an aisle is wide enough to pass someone
  coming the other way, not wide enough to overtake someone ahead of you);
* the feature is **off by default and byte-identical when off** — the literals
  below are the pre-feature run, event for event and keyframe for keyframe;
* the waiting-statistics pipeline the congestion KPIs are built on reproduces
  textbook M/M/1 (``Lq = ρ²/(1-ρ)``), so the numbers it sells are the numbers
  queueing theory would give;
* nothing can grid-lock: agents chasing each other around a ring finish, because
  a waiting agent holds no cell at all;
* the rack-penetration check runs at RUN time now, not only offline, and it
  actually fires on a broken trajectory;
* and the raw event log is written out (``events.jsonl`` / CSV) so a KPI can be
  re-derived by someone who was not in the room.
"""

from __future__ import annotations

import json
import math
import random
import time
from collections import Counter
from types import SimpleNamespace

import simpy

from whsim import eventlog, kpis, templates
from whsim.engine.build import Worker, build
from whsim.engine.processes import _cell_steps, _walk
from whsim.engine.run import RunResult, run_once, validate_no_penetration
from whsim.schema.model import (
    Bounds,
    Item,
    Location,
    Order,
    OrderLine,
    Station,
    WarehouseModel,
    WorkerGroup,
)


def _aisle_model(*, interference: bool, pickers: int = 2, orders: int = 20,
                 speed: float = 1.0, pack_s: float = 5.0) -> WarehouseModel:
    """One long aisle, one pick face at the far end, N pickers, all orders at t=0.

    A deliberately degenerate floor: every picker walks the SAME 34 m of the SAME
    aisle in the SAME direction at the SAME instant, so contention is a certainty
    rather than a lucky sample. Bare floor (no walls) ⇒ Manhattan routing, so the
    cells a walk occupies are exactly the lattice run between the two endpoints.
    """
    m = WarehouseModel()
    m.layout.bounds = Bounds(width=40.0, depth=10.0)
    m.locations = [Location(id="L0", x=35.0, y=5.0, sku="S0")]
    m.items = [Item(sku="S0", pick_freq=1.0, ts_per_unit=1.0, default_location="L0")]
    m.resources.workers = [WorkerGroup(id="p", role="picker", count=pickers)]
    m.resources.stations = [Station(id="pack", x=1.0, y=5.0, count=pickers)]
    m.process.walk_speed_mps = speed
    m.process.pack_time_s = pack_s
    m.orders.outbound = [Order(order_id=f"O{i}", arrival_s=0.0,
                               lines=[OrderLine(sku="S0", qty=1)])
                         for i in range(orders)]
    m.simulation.duration_s = 3600.0
    m.simulation.aisle_interference = interference
    return m


def _events(res, name: str) -> list[dict]:
    return [e for e in res.events if e["event"] == name]


# --------------------------------------------------------- the cell lattice

def test_a_walk_decomposes_into_directed_lattice_cells():
    """The contended unit is (cell, direction) on the heatmap's own lattice."""
    assert _cell_steps([(0, 0), (3, 0)], 1.0) == [
        ((0, 0), "+x", 1.0), ((1, 0), "+x", 1.0), ((2, 0), "+x", 1.0)]
    # Walking back down the same aisle occupies the same CELLS but the other
    # direction — which is why two agents passing each other never queue.
    assert _cell_steps([(3, 0), (0, 0)], 1.0) == [
        ((2, 0), "-x", 1.0), ((1, 0), "-x", 1.0), ((0, 0), "-x", 1.0)]
    # A partial last cell keeps its real length, so time is charged by metres.
    assert _cell_steps([(0, 0), (0, 2.5)], 1.0) == [
        ((0, 0), "+y", 1.0), ((0, 1), "+y", 1.0), ((0, 2), "+y", 0.5)]
    # A non-axis-aligned leg takes the same L (x then y) the heatmap rasterises.
    assert _cell_steps([(0.0, 0.0), (2.0, 2.0)], 1.0) == [
        ((0, 0), "+x", 1.0), ((1, 0), "+x", 1.0),
        ((2, 0), "+y", 1.0), ((2, 1), "+y", 1.0)]
    assert _cell_steps([(0, 0), (0, 0)], 1.0) == []


# ------------------------------------------------- two agents, one aisle cell

def test_two_agents_in_one_aisle_cell_wait_for_each_other():
    """The acceptance criterion: a second agent entering an occupied cell WAITS."""
    m = _aisle_model(interference=True)
    res = run_once(m, seed=1, replay_window_s=0.0)

    waits = _events(res, "aisle_wait")
    assert waits, "two pickers sharing one aisle must produce aisle_wait events"
    assert all(w["wait"] > 0.0 for w in waits), "a logged wait is a real wait"
    for w in waits:
        assert w["resource"] == "aisle"
        assert w["worker"].startswith("picker-")
        assert len(w["cell"]) == 2 and w["dirn"] in ("+x", "-x", "+y", "-y")

    k = kpis.compute([res], m)
    assert k["congestion_waits"] == len(waits)
    assert k["congestion_wait_total_s"] > 0.0
    assert k["congestion_wait_share"] > 0.0
    assert k["congestion_wait_p95_s"] > 0.0
    top = k["congestion"]["top_cells"]
    assert top and top[0]["wait_s"] > 0.0 and top[0]["hits"] >= 1

    # The waiting is TIME, never distance: an agent held at a cell boundary still
    # walks exactly as far as it would have on an empty floor.
    off = kpis.compute([run_once(_aisle_model(interference=False), seed=1,
                                 replay_window_s=0.0)], m)
    assert math.isclose(k["walk_total_m"], off["walk_total_m"], rel_tol=1e-12)
    assert k["cycle_mean_s"] > off["cycle_mean_s"]


def test_opposite_directions_pass_each_other_freely():
    """Two agents crossing the same cell the OTHER way must not queue.

    An aisle is wide enough to pass someone coming towards you. Modelling a cell
    as one undirected mutex would have said otherwise and invented congestion that
    does not exist — which is worse than missing congestion that does.
    """
    m = _aisle_model(interference=True, pickers=1, orders=1)
    env = simpy.Environment()
    world = build(m, env)
    a = Worker(id="a", role="picker")
    b = Worker(id="b", role="picker")
    # Both traverse the SAME cells at the SAME time, in opposite directions.
    env.process(_walk(world, a, (0.0, 5.0), (20.0, 5.0), 1.0, "travel"))
    env.process(_walk(world, b, (20.0, 5.0), (0.0, 5.0), 1.0, "travel"))
    env.run()
    assert [e for e in world.events if e["event"] == "aisle_wait"] == []

    # ...and the same two agents going the SAME way do queue.
    env2 = simpy.Environment()
    w2 = build(m, env2)
    env2.process(_walk(w2, Worker(id="a", role="picker"),
                       (0.0, 5.0), (20.0, 5.0), 1.0, "travel"))
    env2.process(_walk(w2, Worker(id="b", role="picker"),
                       (0.0, 5.0), (20.0, 5.0), 1.0, "travel"))
    env2.run()
    assert [e for e in w2.events if e["event"] == "aisle_wait"]


def test_a_forced_pass_keeps_a_jammed_cell_moving():
    """never-blocks: an agent waiting past the cap walks through and says so."""
    m = _aisle_model(interference=True, pickers=6, orders=120, pack_s=2.0)
    res = run_once(m, seed=1, replay_window_s=0.0)
    forced = _events(res, "aisle_pass_forced")
    assert forced, "six agents entering one cell at once must force at least one"
    for f in forced:
        # It waited the full cap before giving up (cap = 3 x the cell's own time).
        assert f["wait"] > 0.0 and f["resource"] == "aisle"
    k = kpis.compute([res], m)
    assert k["congestion_forced_passes"] == len(forced)
    # Everything still completes — a forced pass is an escape, not a failure.
    assert k["orders_completed"] == 120


# ------------------------------------------------------ the default is OFF

def test_the_flag_is_off_by_default_and_builds_no_cells():
    m = templates.load_template_model("ecommerce_small")
    assert m.simulation.aisle_interference is False
    assert build(m, simpy.Environment()).aisle_cells is None
    m.simulation.aisle_interference = True
    assert build(m, simpy.Environment()).aisle_cells == {}


def test_off_is_byte_identical_to_the_pre_feature_engine():
    """The literals below were measured on the engine BEFORE this feature existed.

    Interference is a new MODE, so it may spend randomness and emit events of its
    own; the default path may not move by one float. Two templates because they
    exercise different halves of ``_walk``: ``ecommerce_small`` is the plain
    pick→carry→pack loop, ``line_inspection`` adds conveyors, forklifts and tote
    tracks (goods mirrored onto the walker's own keyframes).
    """
    expected = {
        "ecommerce_small": {
            "duration": 3600.0, "seed": 5,
            "n_events": 752,
            "counter": {"order_arrive": 148, "pick_start": 125, "pack_start": 122,
                        "pack_done": 119, "order_complete": 119, "pick_done": 119},
            "kf": [108, 106, 150, 84, 100, 139],
            "kf_fork": [],
            "n_totes": 0, "tote_kf": 0,
            "sum_t": 1452287.68463122,
            "kpi": {"orders_arrived": 148.0, "orders_completed": 119.0,
                    "completion_rate": 0.8040540540540541,
                    "throughput_per_hr": 119.0,
                    "cycle_mean_s": 406.06887713903785,
                    "picker_utilization": 0.9061390939244102,
                    "packer_utilization": 0.44074074074074077,
                    "walk_total_m": 16491.0,
                    "walk_per_order_m": 138.57983193277312},
        },
        "line_inspection": {
            "duration": 1800.0, "seed": 5,
            "n_events": 2931,
            "counter": {"order_arrive": 257, "pick_start": 253, "pick_done": 247,
                        "conveyor_on": 734, "forklift_done": 64, "conveyor_off": 704,
                        "pack_start": 230, "pack_done": 221, "order_complete": 221},
            "kf": [192, 193, 195, 220, 174, 174, 226, 219, 195, 206],
            "kf_fork": [176, 177],
            "n_totes": 128, "tote_kf": 1687,
            "sum_t": 2804314.0127618946,
            "kpi": {"orders_arrived": 257.0, "orders_completed": 221.0,
                    "completion_rate": 0.8599221789883269,
                    "throughput_per_hr": 442.0,
                    "cycle_mean_s": 305.44446937231646,
                    "picker_utilization": 0.6198511300204201,
                    "packer_utilization": 0.47883333333333333,
                    "walk_total_m": 10274.431295585284,
                    "walk_per_order_m": 46.490639346539766},
        },
    }
    for tid, want in expected.items():
        m = templates.load_template_model(tid)
        m.simulation.duration_s = want["duration"]
        m.simulation.random_seed = 77
        res = run_once(m, seed=want["seed"])
        assert len(res.events) == want["n_events"], tid
        assert dict(Counter(e["event"] for e in res.events)) == want["counter"], tid
        assert [len(w.keyframes) for w in res.workers] == want["kf"], tid
        assert [len(w.keyframes) for w in res.forklifts] == want["kf_fork"], tid
        assert len(res.totes) == want["n_totes"], tid
        assert sum(len(t.keyframes) for t in res.totes) == want["tote_kf"], tid
        assert math.isclose(sum(e["t"] for e in res.events), want["sum_t"],
                            rel_tol=1e-12), tid
        # No congestion event exists at all on this path.
        assert not [e for e in res.events
                    if e["event"] in ("aisle_wait", "aisle_pass_forced")], tid
        k = kpis.compute([res], m)
        for key, val in want["kpi"].items():
            assert math.isclose(k[key], val, rel_tol=1e-12), (tid, key, k[key], val)
        # The new KPI keys exist but are all zero, and the verdict is untouched.
        assert k["congestion_wait_total_s"] == 0.0
        assert k["congestion_wait_share"] == 0.0
        assert k["congestion_waits"] == 0.0
        assert k["congestion_wait_p95_s"] == 0.0
        assert k["congestion"]["top_cells"] == []
        assert k["path_violations"] == 0.0
        assert "通路の混雑" not in k["verdict"] and "貫通" not in k["verdict"]


# ------------------------------------ the waiting statistics vs queueing theory

def _mm1_wait_events(lam: float, mu: float, n: int, seed: int) -> list[dict]:
    """Run a textbook M/M/1 in SimPy and log each customer's queueing delay.

    Deliberately NOT built on ``World``: the point is to feed the KPI layer's
    waiting-statistics pipeline a queue whose answer is known in closed form, so
    the check is of the aggregation, not of the warehouse.
    """
    rng = random.Random(seed)
    env = simpy.Environment()
    server = simpy.Resource(env, capacity=1)
    events: list[dict] = []

    def customer():
        req = server.request()
        t0 = env.now
        yield req
        # Logged in the engine's own shape, so ``wait_stats`` reads it verbatim.
        events.append({"t": env.now, "event": "aisle_wait", "resource": "aisle",
                       "worker": "c", "cell": [0, 0], "dirn": "+x",
                       "wait": env.now - t0})
        yield env.timeout(rng.expovariate(mu))
        server.release(req)

    def source():
        for _ in range(n):
            yield env.timeout(rng.expovariate(lam))
            env.process(customer())

    env.process(source())
    env.run()
    return events


def test_wait_statistics_reproduce_mm1_queueing_theory():
    """``Lq = λ·Wq`` off the KPI helper must match ``ρ²/(1-ρ)`` within 5%.

    The congestion numbers this feature sells are averages over waiting events.
    An averaging pipeline that is subtly wrong (counting a zero wait, dropping the
    forced passes, dividing by the wrong denominator) produces a plausible-looking
    congestion figure nobody can falsify. Pinning it against the one queue whose
    answer is known exactly is how it stays falsifiable — and the check goes
    THROUGH ``kpis.wait_stats``, the same function ``_one`` calls, not around it.
    """
    lam, mu, n = 0.5, 1.0, 50_000
    events = _mm1_wait_events(lam, mu, n, seed=20260814)

    stats = kpis.wait_stats(events)            # the production aggregation
    assert stats["waits"] == n
    wq = stats["wait_mean_s"]
    lq = lam * wq                              # Little's law
    rho = lam / mu
    lq_theory = rho ** 2 / (1.0 - rho)
    assert abs(lq - lq_theory) / lq_theory < 0.05, (lq, lq_theory)
    # The percentile and the total must be consistent with the same sample.
    assert stats["wait_p95_s"] > wq > 0.0
    assert math.isclose(stats["wait_total_s"], wq * n, rel_tol=1e-9)
    # Share is against travel + wait, so it is a proper fraction.
    share = kpis.wait_stats(events, travel_time_s=stats["wait_total_s"])["wait_share"]
    assert math.isclose(share, 0.5, rel_tol=1e-9)


def test_wait_statistics_are_empty_without_congestion_events():
    s = kpis.wait_stats([{"t": 0.0, "event": "pick_done", "busy": 3.0}])
    assert s == {"wait_total_s": 0.0, "wait_share": 0.0, "waits": 0,
                 "wait_mean_s": 0.0, "wait_p95_s": 0.0, "forced_passes": 0,
                 "top_cells": []}


def test_the_verdict_discloses_a_congested_aisle():
    """Above the disclosure threshold the verdict says how bad AND where."""
    res = RunResult(events=[{"t": float(i), "event": "aisle_wait", "resource": "aisle",
                             "worker": "picker-1", "cell": [7, 3], "dirn": "+x",
                             "wait": 30.0} for i in range(50)]
                    + [{"t": 1.0, "event": "pick_done", "busy": 100.0, "dist": 100.0,
                        "lines": 1, "resource": "picker", "worker": "picker-1"}],
                    heat=None, n_pickers=1, n_packers=1, duration_s=3600.0)
    model = _aisle_model(interference=True)
    model.simulation.heatmap_grid_m = 2.0
    k = kpis.compute([res], model)
    assert k["congestion_wait_share"] > 0.15
    assert "通路の混雑で移動時間の" in k["verdict"]
    # Cell centre in floor metres at the model's own lattice pitch: (7.5, 3.5)x2.
    assert "(15, 7) m 付近" in k["verdict"]


# ----------------------------------------------------- deadlock impossibility

def test_agents_chasing_each_other_around_a_ring_cannot_deadlock():
    """The classic grid-lock shape: four agents circling, each behind the next.

    It cannot lock, and not by luck: the wait happens at the cell BOUNDARY and a
    waiting agent holds nothing (the cell behind it is released before the next is
    requested), so hold-and-wait — a necessary condition for circular wait — never
    occurs. Different speeds make them genuinely bunch up rather than orbit in
    lockstep, so the contention is real.
    """
    m = _aisle_model(interference=True, pickers=1, orders=1)
    m.layout.bounds = Bounds(width=40.0, depth=40.0)
    env = simpy.Environment()
    world = build(m, env)
    ring = [(5.0, 5.0), (25.0, 5.0), (25.0, 25.0), (5.0, 25.0)]
    agents = [Worker(id=f"r{i}", role="picker") for i in range(4)]
    laps: dict[str, int] = {}
    LAPS = 8

    def loop(w: Worker, start: int, speed: float):
        for k in range(LAPS):
            a = ring[(start + k) % 4]
            b = ring[(start + k + 1) % 4]
            yield from _walk(world, w, a, b, speed, "travel")
            laps[w.id] = laps.get(w.id, 0) + 1

    for i, (w, speed) in enumerate(zip(agents, (1.0, 1.2, 1.5, 2.0))):
        env.process(loop(w, i, speed))

    t0 = time.monotonic()
    env.run()                       # must terminate, not hang
    assert time.monotonic() - t0 < 30.0
    # Contention really happened (otherwise the test proves nothing)...
    contention = [e for e in world.events
                  if e["event"] in ("aisle_wait", "aisle_pass_forced")]
    assert contention
    # ...and every agent got all the way round: nobody is stuck mid-ring.
    assert laps == {a.id: LAPS for a in agents}


# ------------------------------------------- runtime rack-penetration checking

def test_a_trajectory_through_a_rack_is_detected():
    """A deliberately broken track must be reported — the check must be able to fail."""
    model = templates.load_template_model("retail_dc")
    from whsim.rackgeom import rack_rects
    rects = rack_rects(model)
    assert rects, "the template must draw racking"
    x, y, w, h = max(rects, key=lambda r: r[2] * r[3])
    # Two keyframes straight across the widest rack's middle.
    bad = Worker(id="ghost", role="picker")
    bad.keyframes = [(0.0, x - 2.0, y + h / 2, "travel"),
                     (10.0, x + w + 2.0, y + h / 2, "travel")]
    world = SimpleNamespace(workers=[bad], helpers=[])
    found = validate_no_penetration(world, model)
    assert found, "a leg straight through a rack must be reported"
    assert "ghost" in found[0] and "貫通" in found[0]

    # ...and a leg that stays outside the racking is not reported.
    ok = Worker(id="good", role="picker")
    ok.keyframes = [(0.0, x - 3.0, y - 3.0, "travel"), (10.0, x - 3.0, y + h + 3.0, "travel")]
    assert validate_no_penetration(SimpleNamespace(workers=[ok], helpers=[]), model) == []


def test_every_run_carries_its_penetration_verdict():
    """The check is ALWAYS on (no flag) and reports zero on a healthy layout."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 1800.0
    res = run_once(m, seed=4, replay_window_s=900.0)
    assert res.path_violations == []
    assert kpis.compute([res], m)["path_violations"] == 0.0


def test_a_penetration_never_kills_the_run():
    """never-blocks: a model whose geometry cannot be read still returns a result."""
    assert validate_no_penetration(SimpleNamespace(), object()) == []


def test_congested_walking_still_never_crosses_a_rack():
    """Interference must not re-open the racking (ARCHITECTURE invariant 6).

    The contended walk emits its own extra keyframes — the corner frames and a
    stand-still frame wherever an agent queued. Every one of them has to sit on
    the route the router measured, or the new mode would draw pickers through
    shelves exactly like the four earlier regressions this invariant exists for.
    """
    for template_id in ("ecommerce_small", "retail_dc"):
        m = templates.load_template_model(template_id)
        m.simulation.duration_s = 1800.0
        m.simulation.aisle_interference = True
        res = run_once(m, seed=6, replay_window_s=900.0)
        assert res.path_violations == [], (template_id, res.path_violations[:3])
        assert _events(res, "aisle_wait"), template_id


# -------------------------------------------------------- the event log export

def test_the_event_log_is_written_beside_the_kpis(tmp_path):
    m = _aisle_model(interference=True, orders=5)
    res = run_once(m, seed=2, replay_window_s=0.0)
    assert res.events

    path = eventlog.dump(res.events, tmp_path)
    assert path is not None and path.name == "events.jsonl"
    lines = path.read_text("utf-8").splitlines()
    assert len(lines) == len(res.events)
    # Verbatim: the file IS the log, not a projection of it.
    assert [json.loads(ln) for ln in lines] == res.events
    assert eventlog.load(tmp_path) == res.events


def test_the_event_csv_opens_in_japanese_excel():
    events = [
        {"t": 1.5, "event": "aisle_wait", "resource": "aisle", "worker": "picker-1",
         "cell": [3, 4], "dirn": "+x", "wait": 2.25},
        {"t": 9.0, "event": "order_complete", "order_id": "O1", "cycle": 12.0,
         "dist": 30.0, "due": None},
    ]
    csv_text = eventlog.to_csv(events)
    assert csv_text.startswith("﻿"), "Excel needs the BOM or CJK is mojibake"
    rows = [r for r in csv_text.lstrip("﻿").splitlines()]
    assert rows[0] == "t,event,order_id,resource,worker,meta"
    assert rows[1].startswith("1.5,aisle_wait,,aisle,picker-1,")
    # Everything not in the five shared columns survives in the meta JSON.
    meta = json.loads(rows[1].split(",", 5)[5].strip('"').replace('""', '"'))
    assert meta == {"cell": [3, 4], "dirn": "+x", "wait": 2.25}
    assert rows[2].startswith("9.0,order_complete,O1,,,")


def test_an_empty_log_still_produces_valid_artifacts(tmp_path):
    assert eventlog.to_jsonl([]) == ""
    assert eventlog.to_csv([]) == "﻿t,event,order_id,resource,worker,meta\n"
    assert eventlog.load(tmp_path) == []      # nothing written yet
