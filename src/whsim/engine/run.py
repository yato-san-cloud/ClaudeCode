"""Run the simulation: one replication, or several aggregated."""

from __future__ import annotations

import random
from dataclasses import dataclass, field

import numpy as np
import simpy

from whsim.engine.build import Tote, Worker, build
from whsim.engine.graph import AisleGraph
from whsim.engine.processes import (
    agv_agent, forklift_agent, inspector_agent, order_source, packer_agent,
    picker_agent, putaway_source, replenisher_agent,
)
from whsim.schema.model import WarehouseModel

# Keep the animated replay short enough to stay smooth in the browser, even when
# the KPI run covers a full shift.
DEFAULT_REPLAY_WINDOW_S = 900.0


class RunCancelled(Exception):
    """Raised *from a progress callback* to abort a run between sim chunks.

    The escape hatch for long runs: a caller's ``progress`` callback (e.g. the
    web layer's reporter, after the user pressed 中止) raises this and the run
    stops promptly — between sim chunks, between replications, and between
    scenario/workmethod jobs. It is the ONLY exception a progress callback can
    use to influence a run; any other exception it raises is swallowed (a
    reporting hiccup must never fail a simulation)."""


def _report(progress, *args, **kw) -> None:
    """Invoke a progress callback: cancellation propagates, hiccups don't."""
    if progress is None:
        return
    try:
        progress(*args, **kw)
    except RunCancelled:
        raise
    except Exception:  # noqa: BLE001 — a reporting hiccup never fails a run
        pass


@dataclass
class RunResult:
    events: list[dict]
    heat: np.ndarray
    n_pickers: int
    n_packers: int
    duration_s: float
    n_agvs: int = 0
    n_put_wall: int = 0                     # 種まき put-wall stations (consolidation=="sort")
    sorter_channels: int = 0               # 自動仕分機 induction channels (0 = no active sorter)
    consolidation: str = "pick"
    pick_method: str = "manual"
    workers: list[Worker] = field(default_factory=list)
    helpers: list[Worker] = field(default_factory=list)  # parallel-zone sub-tracks (replay)
    agvs: list[Worker] = field(default_factory=list)
    forklifts: list[Worker] = field(default_factory=list)
    packers: list[Worker] = field(default_factory=list)  # dedicated packer agents (staging mode)
    inspectors: list[Worker] = field(default_factory=list)  # 入荷検品 agents
    # コンベア搬送: the goods themselves as replay tracks (carry -> belt -> pack),
    # capped at build.MAX_TOTE_TRACKS per run and confined to the replay window.
    # Empty for every model without a conveyor.
    totes: list[Tote] = field(default_factory=list)
    conveyor_capacity: int = 0              # total belt slots across all lines (0 = none)
    n_conveyors: int = 0                    # active conveyor lines
    n_inspectors: int = 0
    n_replenishers: int = 0                 # 補充要員 servers (0 = replenishment off)
    staging_capacity: int = 0               # 仮置き buffer capacity (0 = disabled)
    replay_window_s: float = 0.0
    # 経路拘束の実行時検査: replay legs that go THROUGH the drawn racking. Always
    # measured (no flag), always empty on a healthy layout. Detection and honest
    # reporting is the whole job — a violation never aborts the run.
    path_violations: list[str] = field(default_factory=list)
    cost: dict = field(default_factory=dict)
    # Busiest-day disclosure metadata: None for single-day/profile demand (the
    # pass-through path stays byte-identical), a dict when a multi-day import was
    # collapsed to its representative day (see ``rep_day_meta``). Purely surfaced
    # for the UI so the single-day KPI counts reconcile with the ②分析 totals.
    rep_day: dict | None = None


def representative_day(model: WarehouseModel) -> WarehouseModel:
    """Pick one representative day to simulate when imported demand spans many days.

    The real-calendar ETL (``analysis.ingest``) anchors each order's ``arrival_s``
    to a Monday-00:00 offset so the BI views keep the true weekday/hour. That pushes
    every order past the default 8h window (first activity lands at ~08:00 = 28800s),
    so the engine would otherwise replay an empty pre-dawn window and process ZERO
    orders. Here we isolate the busiest single day (the sizing-relevant peak),
    re-base it so its first order starts at t=0, and size the window to that day's
    active span plus a drain tail — so utilisation/KPIs reflect a real working day
    instead of being diluted across nights and weekends. The saved multi-day orders
    are untouched (this returns a copy); profile / single-day demand passes through.
    """
    orders = model.orders.outbound
    if len(orders) < 2:
        return model
    days: dict[int, list] = {}
    for o in orders:
        days.setdefault(int((o.arrival_s or 0.0) // 86400), []).append(o)
    if len(days) < 2:
        return model  # already a single day — honour the authored window
    best = max(days, key=lambda d: (len(days[d]), -d))  # busiest; ties → earliest
    day_orders = days[best]
    first = min(o.arrival_s or 0.0 for o in day_orders)
    last = max(o.arrival_s or 0.0 for o in day_orders)
    m = model.model_copy(deep=True)
    rebased = []
    for o in day_orders:
        oo = o.model_copy(deep=True)
        oo.arrival_s = max(0.0, (o.arrival_s or 0.0) - first)
        rebased.append(oo)
    rebased.sort(key=lambda x: x.arrival_s)
    m.orders.outbound = rebased
    # Active span + a 2h drain tail so the last orders can complete; floored so a
    # degenerate (near-instant) day still produces a sane window.
    m.simulation.duration_s = max(3600.0, (last - first) + 2 * 3600.0)
    return m


# Monday-anchored weekday labels (0=月): the real-calendar ETL bases arrival_s on
# the Monday on/before the first date, so a day-bucket index mod 7 recovers the
# true weekday. Best-effort ("相当") for non-ETL offsets — see ``rep_day_meta``.
_WEEKDAYS_JP = ["月", "火", "水", "木", "金", "土", "日"]


def rep_day_meta(model: WarehouseModel) -> dict | None:
    """Disclosure metadata for the busiest-day collapse — ``None`` when it doesn't apply.

    Mirrors ``representative_day``'s bucketing/tie-break WITHOUT collapsing the model,
    so the UI can reconcile the simulated single-day KPI counts with the ②分析
    multi-day totals (a salesperson who imports 1,494 orders across 27 days and sees
    the sim process 83 needs to be told those 83 are the busiest day, not a data loss).
    Returns ``None`` for single-day / profile demand (the pass-through path) so callers
    surface nothing there — keeping that path byte-identical.
    """
    orders = model.orders.outbound
    if len(orders) < 2:
        return None
    days: dict[int, list] = {}
    for o in orders:
        days.setdefault(int((o.arrival_s or 0.0) // 86400), []).append(o)
    if len(days) < 2:
        return None  # already a single day — nothing to disclose
    best = max(days, key=lambda d: (len(days[d]), -d))  # busiest; ties → earliest
    day_orders = days[best]
    return {
        "total_days": len(days),
        "total_orders": len(orders),
        "day_orders": len(day_orders),
        "day_lines": sum(len(o.lines) for o in day_orders),
        # Weekday of the simulated day (Monday-anchored ETL → 相当 label). Always
        # derivable from the offset, so always present for a multi-day import.
        "weekday": _WEEKDAYS_JP[best % 7],
    }


def validate_no_penetration(world, model: WarehouseModel, tracks=None) -> list[str]:
    """Did any agent this run walk THROUGH the racking? (empty = no.)

    The invariant "agents travel the aisles, not the shelves" is pinned offline
    for every bundled template (``tests/test_no_rack_penetration.py``), but the
    layouts that matter commercially are the ones that DON'T ship: an imported
    MapMaker floor, a hand-dragged rack, a rack placed after the graph was built.
    On those, a re-opened rack understates travel — which overstates productivity
    and throughput, i.e. it makes the proposal optimistic in the customer's favour
    and wrong. So the same measurement runs on every replication that recorded a
    trajectory, and its findings ride out on ``RunResult.path_violations``.

    ``tracks`` defaults to the world's own picker/helper tracks; ``run_once``
    passes the full cast (forklifts, AGVs, packers, inspectors) so the check
    covers every agent the replay draws. Never raises and never aborts: detection
    and reporting is the job (never-blocks).
    """
    from whsim.rackgeom import track_penetrations
    try:
        if tracks is None:
            tracks = list(getattr(world, "workers", None) or ()) + \
                     list(getattr(world, "helpers", None) or ())
        return track_penetrations(model, [t for t in tracks if getattr(t, "keyframes", None)])
    except Exception:      # noqa: BLE001 — a diagnostic must never break a run
        return []


def run_once(
    model: WarehouseModel,
    seed: int | None = None,
    replay_window_s: float | None = None,
    progress=None,
    graph: AisleGraph | None = None,
) -> RunResult:
    # Phase report (and cancellation point) before the potentially heavy world
    # build. Extra ``phase`` keyword calls are best-effort: a callback that only
    # accepts the 4 positional chunk args simply misses them (TypeError is a
    # swallowed reporting hiccup), so existing callers are unaffected.
    _report(progress, 0.0, model.simulation.duration_s, phase="build")
    # Capture the busiest-day disclosure BEFORE the collapse (afterwards the model
    # is single-day and the metadata is None). ``run_replications`` pre-collapses,
    # so it re-attaches the pre-collapse meta to each result; a direct multi-day
    # ``run_once`` (CLI) captures it correctly here.
    rep_meta = rep_day_meta(model)
    model = representative_day(model)
    rng = random.Random(model.simulation.random_seed if seed is None else seed)
    env = simpy.Environment()
    window = DEFAULT_REPLAY_WINDOW_S if replay_window_s is None else replay_window_s
    window = min(window, model.simulation.duration_s)
    world = build(model, env, replay_window_s=window, graph=graph)

    for i in range(world.n_pickers):
        w = Worker(id=f"picker-{i+1}", role="picker")
        world.workers.append(w)
        env.process(picker_agent(world, w, rng))
    agvs: list[Worker] = []
    if world.pick_method == "agv":
        for i in range(world.n_agvs):
            a = Worker(id=f"agv-{i+1}", role="agv")
            agvs.append(a)
            env.process(agv_agent(world, a))
    forklifts: list[Worker] = []
    if world.n_forklifts > 0:
        for i in range(world.n_forklifts):
            fk = Worker(id=f"forklift-{i+1}", role="forklift")
            forklifts.append(fk)
            env.process(forklift_agent(world, fk, rng))
        env.process(putaway_source(world, rng))
    # Dedicated 入荷検品 agents inspect each inbound receipt before putaway.
    inspectors: list[Worker] = []
    if world.inbound_store is not None:
        for i in range(world.n_inspectors):
            ins = Worker(id=f"inspector-{i+1}", role="inspector")
            inspectors.append(ins)
            env.process(inspector_agent(world, ins, world.fork_home))
    # Dedicated 補充要員(replenishers): drain the replenishment queue (top up pick
    # faces). When replenishment shares the forklift fleet, no dedicated agents are
    # spawned. They render as forklift tracks (putaway state) in the replay.
    if world.replen_faces is not None and world.replen_dedicated > 0:
        for i in range(world.replen_dedicated):
            rp = Worker(id=f"replenisher-{i+1}", role="forklift")
            forklifts.append(rp)
            env.process(replenisher_agent(world, rp))
    # Dedicated packer agents drain the 仮置き(staging) buffer (manual staged mode).
    packers: list[Worker] = []
    if world.staging is not None and world.pick_method != "agv":
        for i in range(max(1, world.n_packers)):
            pk = Worker(id=f"packer-{i+1}", role="packer")
            packers.append(pk)
            env.process(packer_agent(world, pk, world.pack_xy[i % len(world.pack_xy)]))
    env.process(order_source(world, rng))

    duration = model.simulation.duration_s
    if progress is not None:
        # Step the sim clock in fixed chunks so a caller can report the *honest*
        # progress (倉庫の1日が何時まで進んだか). ``env.run(until=t)`` processes
        # every event with time ≤ t then stops, so running it for an increasing
        # series of t is event-for-event identical to one full run — purely a
        # reporting hook, zero behaviour change when ``progress`` is None.
        # A callback may raise RunCancelled to abort between chunks (the 中止
        # escape hatch); any other exception it raises is swallowed.
        steps = 50
        for k in range(1, steps + 1):
            env.run(until=duration * k / steps)
            _report(progress, env.now, duration)
    else:
        env.run(until=duration)
    # 経路拘束の実行時検査 (always on). Only a rep that RECORDED a trajectory has
    # anything to check — replications 1..n run with an empty replay window, so
    # they carry no keyframes and the call is a no-op there.
    violations = validate_no_penetration(
        world, model,
        tracks=[*world.workers, *world.helpers, *agvs, *forklifts,
                *packers, *inspectors])
    return RunResult(
        events=world.events, heat=world.heat,
        n_pickers=world.n_pickers, n_packers=world.n_packers,
        duration_s=model.simulation.duration_s,
        n_agvs=world.n_agvs,
        # An active automatic sorter replaces the manual put wall for this run, so
        # the manual-wall stage reports 0 (only one of the two is ever used).
        n_put_wall=(world.put_wall.capacity
                    if (world.consolidation == "sort" and world.sorter is None) else 0),
        sorter_channels=(world.sorter["channels"]
                         if (world.consolidation == "sort" and world.sorter is not None) else 0),
        consolidation=world.consolidation, pick_method=world.pick_method,
        workers=world.workers, helpers=world.helpers, agvs=agvs, forklifts=forklifts,
        packers=packers, inspectors=inspectors, n_inspectors=world.n_inspectors,
        totes=world.totes,
        conveyor_capacity=sum(c.capacity for c in world.conveyors),
        n_conveyors=len(world.conveyors),
        n_replenishers=world.n_replenishers,
        staging_capacity=world.staging_capacity,
        replay_window_s=window, cost=_cost_inputs(model),
        path_violations=violations,
        rep_day=rep_meta,
    )


def _cost_inputs(model: WarehouseModel) -> dict:
    """Pack the cost parameters the KPI layer needs (kept out of the engine loop)."""
    rate = (model.resources.workers[0].labour_rate_per_hr
            if model.resources.workers else 0.0)
    agvs = [e for e in model.resources.equipment if e.type in ("agv", "asrs")]
    return {
        "labour_rate_per_hr": rate,
        "capex_total": sum(e.capex_each * e.count for e in agvs),
        "opex_per_hr_total": sum(e.opex_per_hr * e.count for e in agvs),
        "amortize_months": model.simulation.amortize_capex_months,
        "work_days_per_month": model.simulation.work_days_per_month,
        "shift_hours_per_day": model.simulation.shift_hours_per_day,
        "currency": model.simulation.currency,
    }


def busiest_day_load(model: WarehouseModel) -> tuple[int, int]:
    """(orders, lines) of the busiest single day — the day a run will simulate.

    Mirrors ``representative_day``'s bucketing/tie-break WITHOUT the deep copy,
    so callers (e.g. the web layer's adaptive replication clamp) can size a run
    cheaply before starting it."""
    orders = model.orders.outbound
    if not orders:
        return 0, 0
    days: dict[int, list] = {}
    for o in orders:
        days.setdefault(int((o.arrival_s or 0.0) // 86400), []).append(o)
    best = max(days, key=lambda d: (len(days[d]), -d))
    day_orders = days[best]
    return len(day_orders), sum(len(o.lines) for o in day_orders)


def run_replications(
    model: WarehouseModel, reps: int | None = None, progress=None
) -> tuple[list[RunResult], np.ndarray]:
    """Monte-Carlo: run N replications with distinct seeds (different stochastic
    order sequences), average the heat grid. Only the first rep records the replay
    trajectory (the others exist purely to quantify variability).

    ``progress(rep, reps, sim_now, sim_duration)`` (optional) is called as the
    sim clock advances within each replication, so a UI can show the *honest*
    progress + ETA. Default None ⇒ no chunking, identical to before. The
    callback may raise :class:`RunCancelled` to abort the whole sweep promptly
    (between sim chunks and between replications); it may also receive extra
    best-effort ``phase=`` keyword calls at stage boundaries."""
    reps = max(1, reps if reps is not None else model.simulation.replications)
    # Collapse a multi-day import to its busiest day ONCE (idempotent: run_once's
    # own call then passes straight through), and build ONE wall-aware routing
    # graph shared by every replication. The layout is identical across reps, so
    # rebuilding the graph (and re-solving its Dijkstra sources) per rep was pure
    # waste on large floors. Behaviour-preserving: the graph is deterministic and
    # read-only apart from its memoised distance/snap caches.
    # Disclosure metadata must be read from the ORIGINAL multi-day model, before
    # the collapse below turns it single-day; run_once (fed the collapsed model)
    # would otherwise see one day and report None. Re-attached to each result.
    rep_meta = rep_day_meta(model)
    model = representative_day(model)
    graph = AisleGraph.from_model(model)
    results: list[RunResult] = []
    heat_sum: np.ndarray | None = None
    for r in range(reps):
        cb = ((lambda *args, _r=r, **kw: progress(_r, reps, *args, **kw))
              if progress else None)
        res = run_once(model, seed=model.simulation.random_seed + r,
                       replay_window_s=None if r == 0 else 0.0, progress=cb,
                       graph=graph)
        res.rep_day = rep_meta
        results.append(res)
        heat_sum = res.heat.copy() if heat_sum is None else heat_sum + res.heat
    assert heat_sum is not None
    return results, heat_sum / reps
