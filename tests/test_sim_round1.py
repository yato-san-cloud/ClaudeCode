"""Round-1 correctness fixes (commercial-quality pass).

Each test targets a specific defect and is written to fail on the pre-fix code
and pass after the fix:

* DEFECT 1 — parallel-zone replay keyframe corruption (worker teleports because
  concurrent zone legs shared one keyframe track).
* DEFECT 2 — picker_utilization understated load when pickers double as packers
  (pack time excluded from picker-busy), diverging from the analytic oracle.
* Plus a focused robustness pass (determinism, empty/degenerate runs, NaN/inf,
  AGV-pipeline starvation).
"""

from __future__ import annotations

import math

import pytest

from whsim import analytic, kpis, templates
from whsim.engine.run import run_once, run_replications
from whsim.schema.model import Equipment, WarehouseModel, WorkMethod


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _parallel_model(duration_s: float = 600.0) -> WarehouseModel:
    """ecommerce_small with parallel zoning (C axis) and batched trips, so the
    pick phase fans out into several concurrent zone legs."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = duration_s
    m.process.pick_stage().work = WorkMethod(
        transport="manual", orders_per_trip=6, zoning="parallel",
        consolidation="pick", release="continuous")
    return m


def _max_teleport(keyframes: list) -> float:
    """Largest distance covered between consecutive frames at an implausible
    speed. A coherent track moves at ~walk speed; a corrupted (interleaved) one
    jumps a long way in (near) zero simulated time."""
    worst = 0.0
    for (t0, x0, y0, _s0), (t1, x1, y1, _s1) in zip(keyframes, keyframes[1:]):
        dt = t1 - t0
        d = abs(x1 - x0) + abs(y1 - y0)
        if dt <= 1e-6:
            if d > 0.5:                 # moved with no time elapsing == teleport
                worst = max(worst, d)
        elif d / dt > 5.0:              # faster than any picker could walk
            worst = max(worst, d)
    return worst


# --------------------------------------------------------------------------- #
# DEFECT 1: parallel-zone replay keyframe coherence
# --------------------------------------------------------------------------- #
def test_parallel_zone_workers_do_not_teleport():
    """In parallel mode no primary worker track may teleport between zones; the
    concurrent legs are surfaced as their own coherent helper tracks instead."""
    res = run_once(_parallel_model(), seed=3)
    assert res.helpers, "parallel zoning should emit per-zone helper tracks"
    for w in res.workers:
        assert _max_teleport(w.keyframes) == 0.0, f"{w.id} keyframes teleport"
    for h in res.helpers:
        assert _max_teleport(h.keyframes) == 0.0, f"{h.id} keyframes teleport"


def test_parallel_zone_helpers_surface_in_replay_and_are_sorted():
    """Helper tracks must appear in the replay document and satisfy the viewer
    interp() contract: keyframes sorted by time, shape (t, x, y, state)."""
    from whsim.render.replay import build_replay

    m = _parallel_model()
    res = run_once(m, seed=3)
    rep = build_replay(m, res, kpis.compute([res]))
    ids = {w["id"] for w in rep["workers"]}
    assert any(".z" in i for i in ids), "helper tracks missing from replay workers"
    for w in rep["workers"]:
        kf = w["keyframes"]
        assert kf == sorted(kf, key=lambda k: k[0]), f"{w['id']} keyframes unsorted"
        for frame in kf:
            assert len(frame) == 4


def test_parallel_zone_gif_renders():
    """The animated 2D replay must render with the extra helper agents present."""
    from whsim.render.anim2d import render_gif
    from whsim.render.replay import build_replay

    m = _parallel_model(300.0)
    res = run_once(m, seed=1)
    rep = build_replay(m, res, kpis.compute([res]))
    out = render_gif(rep, "/tmp/whsim_parallel.gif", seconds=1, fps=4)
    assert out.is_file() and out.stat().st_size > 0


def test_sequential_and_single_zone_modes_unchanged():
    """Sequential/none zoning must NOT spawn helper tracks (unchanged path)."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 600.0
    m.process.pick_stage().work = WorkMethod(
        transport="manual", orders_per_trip=4, zoning="sequential")
    res = run_once(m, seed=2)
    assert res.helpers == []
    for w in res.workers:
        assert _max_teleport(w.keyframes) == 0.0


# --------------------------------------------------------------------------- #
# DEFECT 2: picker utilisation includes pack when picker doubles as packer
# --------------------------------------------------------------------------- #
def _overload_model() -> WarehouseModel:
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 3600.0
    m.orders.outbound = []                 # profile-driven so peak_factor bites
    m.orders.profile.peak_factor = 3.0
    return m


def test_picker_utilization_tracks_analytic_under_overload():
    """Under peak overload the picker (which also packs) must saturate, and the
    sim utilisation must track the analytic M/M/c oracle within tolerance.
    Pre-fix the sim understated picker load (pack time was excluded)."""
    m = _overload_model()
    est = analytic.estimate(m)
    results, _ = run_replications(m)
    sim = kpis.compute(results)
    assert sim["picker_utilization"] > 0.9, "picker should saturate under overload"
    assert abs(est["picker_utilization"] - sim["picker_utilization"]) < 0.1


def test_picker_utilization_tracks_analytic_at_moderate_load():
    m = templates.load_template_model("ecommerce_small")
    m.orders.outbound = []
    m.orders.profile.peak_factor = 1.0
    est = analytic.estimate(m)
    results, _ = run_replications(m)
    sim = kpis.compute(results)
    # A genuine two-sided match. The oracle includes pack time in the picker
    # service (no conveyor, no 仮置き here, so the picker doubles as the packer)
    # AND prices travel on the same aisle network the DES routes on — every drawn
    # rack run is an obstacle in `engine.graph`, and `rackgeom.aisle_detour`
    # charges the same aisle-escape detour in closed form. Measured across seeds
    # the gap stays under 0.05; 0.08 leaves room for sampling noise without
    # letting a real regression through. (A full shift, not 1h: an hour of this
    # floor is only ~120 orders and its noise alone swings the sim by ±0.15.)
    assert abs(est["picker_utilization"] - sim["picker_utilization"]) < 0.08


def test_packer_utilization_stays_meaningful_and_distinct():
    """packer_utilization must remain a real, bounded measure of pack-station
    service (not collapse to 0 or merge with picker_utilization)."""
    m = _overload_model()
    results, _ = run_replications(m)
    sim = kpis.compute(results)
    assert 0.0 < sim["packer_utilization"] <= 1.0
    assert sim["packer_utilization"] < sim["picker_utilization"]


def test_analytic_pack_time_raises_picker_service():
    """With no conveyor, increasing pack_time_s must raise the analytic picker
    utilisation (pack time is part of the picker's service)."""
    base = templates.load_template_model("ecommerce_small")
    base.orders.outbound = []
    base.process.pack_time_s = 5.0
    slow = templates.load_template_model("ecommerce_small")
    slow.orders.outbound = []
    slow.process.pack_time_s = 80.0
    assert (analytic.estimate(slow)["service_time_s"]
            > analytic.estimate(base)["service_time_s"])
    assert (analytic.estimate(slow)["picker_utilization"]
            >= analytic.estimate(base)["picker_utilization"])


# --------------------------------------------------------------------------- #
# Robustness pass
# --------------------------------------------------------------------------- #
def test_parallel_run_is_deterministic_including_helper_tracks():
    m = _parallel_model()
    a = run_once(m, seed=11)
    b = run_once(m, seed=11)
    assert len(a.events) == len(b.events)
    assert [h.id for h in a.helpers] == [h.id for h in b.helpers]
    assert [h.keyframes for h in a.helpers] == [h.keyframes for h in b.helpers]


def test_single_agent_run_is_sane():
    """A one-picker, one-packer warehouse must still run and yield finite KPIs."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 600.0
    m.resources.workers[0].count = 1
    m.resources.stations[0].count = 1
    sim = kpis.compute([run_once(m, seed=4)])
    for v in sim.values():
        if isinstance(v, float):
            assert math.isfinite(v)
    assert 0.0 <= sim["picker_utilization"] <= 1.0 + 1e-9


def test_empty_order_run_produces_finite_kpis():
    """No orders at all: every KPI finite, no division by zero."""
    m = WarehouseModel()
    m.simulation.duration_s = 600.0
    m.orders.outbound = []
    m.orders.profile.rate_per_hr = 0.0
    sim = kpis.compute([run_once(m, seed=1)])
    for k, v in sim.items():
        if isinstance(v, float):
            assert math.isfinite(v), f"{k}={v!r} not finite"
    assert sim["orders_completed"] == 0


def test_agv_pipeline_does_not_deadlock_or_starve():
    """AGV (goods-to-person) pipeline must complete orders (AGVs feed pickers),
    with bounded, finite utilisations -- no starvation deadlock."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 900.0
    m.resources.equipment.append(
        Equipment(type="agv", count=4, speed_mps=1.6, x=2.0, y=2.0))
    m.process.pick_stage().work = WorkMethod(transport="agv")
    res = run_once(m, seed=6)
    sim = kpis.compute([res])
    assert res.n_agvs == 4
    assert sim["orders_completed"] > 0, "AGV pipeline starved (no completions)"
    for k in ("picker_utilization", "packer_utilization", "agv_utilization"):
        assert 0.0 <= sim[k] <= 1.0 + 1e-9, f"{k} out of range: {sim[k]}"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
