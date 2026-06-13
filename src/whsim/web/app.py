"""FastAPI app: the salesperson-facing web product.

Wraps the whsim core (templates, importer, engine, KPIs, renderers) behind a
small REST API and serves the single-page frontend. The frontend lets a
salesperson pick a template, drop in a customer ZIP, confirm a few headline
numbers, run the simulation, and watch an animated 2D/3D replay -- all without
touching simulation vocabulary.

The endpoints themselves live in concern-grouped ``routes/*`` modules (assembled
below via ``include_router``); this module stays the thin app factory PLUS the
heavy-run machinery. The simulation run (the in-flight concurrency guard, the
``run_replications`` seam and the blocking run bodies) is kept *here* on purpose
so that ``whsim.web.app.run_replications`` / ``whsim.web.app._inflight_runs``
remain the exact names the existing tests monkeypatch and the ``/run`` endpoints
execute against in one shared namespace.
"""

from __future__ import annotations

import json
import os
import time as _time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.staticfiles import StaticFiles

from whsim import analytic, kpis as kpi_mod
from whsim.engine.run import RunCancelled, busiest_day_load, run_replications
from whsim.project import Project
from whsim.render.png2d import render as render_png
from whsim.render.replay import build_replay

# Shared helpers / constants. Re-exported here (``_safe_name``,
# ``MAX_UPLOAD_BYTES``, ``MONTE_CARLO_REPS``) because tests and other callers
# import them from ``whsim.web.app``; the canonical definitions live in
# ``routes._common`` so the routers and this module share one implementation.
from whsim.web.routes._common import (  # noqa: F401 — re-exported for callers/tests
    MAX_UPLOAD_BYTES,
    MONTE_CARLO_REPS,
    Source,
    _analysis_payload,
    _call_export,
    _free_project_name,
    _headline_values,
    _latest_compare,
    _open,
    _project_dir,
    _proposal_extras,
    _read_upload,
    _safe_name,
    _sample_zip_path,
    _set_by_path,
)
from whsim.web.routes import (
    analysis as analysis_routes,
    imports as imports_routes,
    misc as misc_routes,
    projects as projects_routes,
    run_render as run_render_routes,
)

STATIC = Path(__file__).resolve().parent / "static"

app = FastAPI(title="whsim", version="0.1.0")

# Dev convenience (enabled by `whsim serve --reload`): tell the browser never to
# serve a cached copy, so a plain refresh always shows the freshly-pulled
# frontend -- no hard-reload needed. Off by default; production caching unchanged.
if os.environ.get("WHSIM_DEV") == "1":
    @app.middleware("http")
    async def _dev_no_cache(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response

# Bound concurrent heavy runs so a burst of /run(-scenarios) can't saturate the
# worker thread pool and starve the rest of the API. The event loop is single-
# threaded, so a plain counter is race-free (no lock needed).
MAX_INFLIGHT_RUNS = 6
_inflight_runs = 0


def _enter_run() -> None:
    global _inflight_runs
    if _inflight_runs >= MAX_INFLIGHT_RUNS:
        raise HTTPException(429, "現在シミュレーションが混み合っています。少し待ってから再実行してください。")
    _inflight_runs += 1


def _exit_run() -> None:
    global _inflight_runs
    _inflight_runs = max(0, _inflight_runs - 1)


# ---- live run progress (honest sim-clock + ETA) ----------------------------
# The run executes in a worker thread; it writes its progress here and the
# frontend polls GET /run/progress/{name}. Keyed by project so concurrent runs
# don't clobber each other. The sim clock (倉庫の1日が何時まで進んだか) is the
# real signal — not a fake bar — so the ETA is trustworthy.
_RUN_PROGRESS: dict[str, dict] = {}

# Run phases surfaced to the overlay so the bar never sits silently at 0%:
# 準備中 = building the world (graph/locations), 実行中 = the sim clock advancing,
# 集計中 = KPI aggregation / replay assembly / PNG render after the last rep.
_PHASE_JP = {"build": "準備中", "run": "実行中", "aggregate": "集計中"}


def _progress_reporter(name: str, kind: str = "run", total_jobs: int = 1):
    """Build a callback that records run progress under ``name``. ``kind`` lets
    multi-job runs (作業方法比較=4, シナリオ比較=3) report which job they're on.

    The callback is also the cancellation seam: POST /run/cancel flips the
    entry's ``cancel`` flag and the next report raises :class:`RunCancelled`,
    aborting the run between sim chunks / replications / jobs."""
    _RUN_PROGRESS[name] = {"active": True, "kind": kind, "started": _time.time(),
                           "rep": 0, "reps": 1, "frac": 0.0, "job": 0,
                           "total_jobs": total_jobs, "phase": _PHASE_JP["build"],
                           "cancel": False}

    def report(rep, reps, sim_now, sim_duration, job: int = 0, phase: str | None = None):
        st = _RUN_PROGRESS.get(name)
        if not st:
            return
        if st.get("cancel"):
            raise RunCancelled()
        # Plain chunk reports mean the sim clock is advancing (実行中); explicit
        # phase= calls mark the build/aggregate boundaries around it.
        st["phase"] = _PHASE_JP.get(phase or "run", phase)
        rep_frac = (sim_now / sim_duration) if sim_duration else 1.0
        # overall fraction across reps (and jobs, if any)
        within = (rep + rep_frac) / max(1, reps)
        st.update(rep=rep + 1, reps=reps, sim_now=sim_now, sim_duration=sim_duration,
                  frac=(job + within) / max(1, total_jobs), job=job)
    return report


def _clear_progress(name: str) -> None:
    _RUN_PROGRESS.pop(name, None)


@app.get("/api/projects/{name}/run/progress")
def api_run_progress(name: str):
    """Live progress of an in-flight run (honest sim-clock fraction + elapsed →
    the frontend computes ETA). ``{active: false}`` when nothing is running."""
    st = _RUN_PROGRESS.get(name)
    if not st:
        return {"active": False}
    return {**st, "elapsed_s": round(_time.time() - st["started"], 2)}


@app.post("/api/projects/{name}/run/cancel")
def api_run_cancel(name: str):
    """中止: flag the project's in-flight run for cancellation. The run aborts at
    its next progress report (between sim chunks / replications / jobs) and the
    original /run request returns ``{cancelled: true}``. Calling this when
    nothing is running is a harmless no-op."""
    st = _RUN_PROGRESS.get(name)
    if not st:
        return {"ok": True, "active": False,
                "message": "実行中のシミュレーションはありません。"}
    st["cancel"] = True
    return {"ok": True, "active": True, "message": "中止しています…"}


# 大規模データへの正直な自動適応: above these busiest-day line counts the
# Monte-Carlo replication count is clamped (and the result says so in Japanese)
# so a month of real WMS data stays interactive instead of freezing the UI.
# Tiers: (lines/day threshold, replications). Checked top-down.
SCALE_REP_TIERS: list[tuple[int, int]] = [(48000, 1), (24000, 2), (8000, 5)]


def _adaptive_reps(model, base_reps: int) -> tuple[int, str | None]:
    """Clamp the replication count for very large demand days.

    Returns ``(reps, note)`` where ``note`` is a user-facing Japanese sentence
    when an adjustment was made (surfaced in the KPI payload), else ``None``.
    Honest adaptation over silent degradation: the run still simulates every
    order of the busiest day — only the Monte-Carlo repeat count shrinks."""
    n_orders, n_lines = busiest_day_load(model)
    for limit, reps in SCALE_REP_TIERS:
        if n_lines > limit and reps < base_reps:
            note = (f"大規模データ（ピーク日 {n_orders:,}オーダー / {n_lines:,}行）の"
                    f"ため、モンテカルロ検証を{reps}回に自動調整しました。")
            return reps, note
    return base_reps, None


def _run_blocking(proj: Project, name: str | None = None) -> dict:
    """The CPU-bound heart of a run (SimPy + KPIs + render + disk writes).

    Pulled out so the endpoint can hand it to a worker thread via
    ``run_in_threadpool``: the heavyweight discrete-event simulation must never
    execute on the event loop, or the whole server stalls for its duration."""
    model = proj.load_model()
    # Monte-Carlo: many stochastic order sequences; rep 0 carries the replay.
    reporter = _progress_reporter(name) if name else None
    reps, scale_note = _adaptive_reps(model, MONTE_CARLO_REPS)
    results, heat = run_replications(model, reps=reps, progress=reporter)
    if reporter:
        # Post-processing phase (KPI/replay/PNG): keep the overlay honest while
        # the bar sits at 100% — it reads 集計中, not a silent stall.
        reporter(reps - 1, reps, 1.0, 1.0, phase="aggregate")
    res = results[0]
    metrics = kpi_mod.compute(results, model)
    if scale_note:
        metrics["scale_note"] = scale_note
    est = analytic.estimate(model)

    run_dir = proj.new_run_dir()
    (run_dir / "kpis.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2), "utf-8")
    import numpy as np
    np.save(run_dir / "heatmap.npy", heat)
    replay = build_replay(model, res, metrics)
    # Carry provenance so the proposal sheet's "実データ N%" bar lights up
    # (real_pct = imported + confirmed share; never fabricated).
    _prov = proj.load_provenance()
    replay["provenance"] = {"real_pct": round(_prov.confidence() * 100, 1),
                            "summary": _prov.summary()}
    (run_dir / "replay.json").write_text(
        json.dumps(replay, ensure_ascii=False), "utf-8")
    render_png(model, heat, metrics, proj.load_provenance().summary(),
               run_dir / "layout_heatmap.png")
    return {"kpis": metrics, "estimate": est, "run": run_dir.name}


@app.post("/api/projects/{name}/run")
async def api_run(name: str):
    proj = _open(name)
    # Offload the blocking SimPy run to a worker thread so concurrent requests
    # (e.g. /api/templates) stay responsive while a run is in flight; cap how
    # many heavy runs are in flight so a burst can't exhaust the thread pool.
    _enter_run()
    try:
        return await run_in_threadpool(_run_blocking, proj, name)
    except RunCancelled:
        # User pressed 中止: nothing was written (the run aborted before its
        # artifacts), so the project is exactly as before — a clean no-op.
        return {"cancelled": True, "message": "実行を中止しました。"}
    finally:
        _exit_run()
        _clear_progress(name)


def _run_scenarios_blocking(name: str, proj: Project, payload: dict) -> dict:
    """CPU-bound what-if comparison: runs every scenario through SimPy + render.

    Run in a worker thread (see ``api_run_scenarios``) so a multi-scenario
    comparison never blocks the event loop."""
    from whsim.engine.scenarios import (
        apply_scenario, default_scenarios, payback_months, run_scenario,
    )
    from whsim.schema.model import Scenario
    base = proj.load_model()

    raw = payload.get("scenarios")
    scenarios = ([Scenario.model_validate(s) for s in raw] if raw
                 else default_scenarios(base))

    # Derive a fresh compare id WITHOUT calling new_run_dir(): that helper
    # creates (and leaves) an empty run_NNNN directory, which would become the
    # project's latest_run_dir() and break /proposal, /png and /replay (they
    # require a kpis.json that an empty scenario dir never has). Index off both
    # existing run_* and compare_* dirs so ids stay monotonic and never collide.
    proj.runs_dir.mkdir(parents=True, exist_ok=True)
    import re as _re
    existing = [int(m.group(1)) for p in proj.runs_dir.glob("*")
                if (m := _re.fullmatch(r"(?:run|compare)_(\d+)", p.name))]
    nxt = (max(existing) + 1) if existing else 1
    cmp_id = f"compare_{nxt:04d}"
    cmp_dir = proj.runs_dir / cmp_id
    cmp_dir.mkdir(parents=True, exist_ok=True)
    prov = proj.load_provenance().summary()

    reporter = _progress_reporter(name, kind="scenarios", total_jobs=max(1, len(scenarios)))
    reps, scale_note = _adaptive_reps(base, 6)
    results = []
    try:
        for i, sc in enumerate(scenarios):
            # Forward live within-scenario progress (and the cancellation seam)
            # into the scenario's own replications, tagged with the job index.
            def _cb(rep, n, now, dur, _i=i, **kw):
                reporter(rep, n, now, dur, job=_i, **kw)
            res, metrics = run_scenario(base, sc, reps=reps, progress=_cb)
            model_i = apply_scenario(base, sc)
            render_png(model_i, res.heat, metrics, prov, cmp_dir / f"s{i}.png")
            results.append({"name": sc.name, "description": sc.description,
                            "kpis": metrics,
                            "png_url": f"/api/projects/{name}/compare-png/{cmp_id}/{i}"})
    except RunCancelled:
        # 中止: drop the partially-written compare dir so no half comparison
        # ever becomes the project's "latest" — then surface the cancel.
        import shutil
        shutil.rmtree(cmp_dir, ignore_errors=True)
        raise

    baseline = results[0]
    alternatives = results[1:]
    for alt in alternatives:
        pb = payback_months(baseline["kpis"], alt["kpis"])
        alt["kpis"]["payback_months"] = pb
    out = {"compare_id": cmp_id, "baseline": baseline, "alternatives": alternatives}
    if scale_note:
        out["scale_note"] = scale_note
    # Persist the comparison so the proposal export can include scenario tables
    # without re-running the (expensive) sweep. PNG urls are dropped to keep the
    # on-disk record self-contained.
    try:
        (cmp_dir / "compare.json").write_text(
            json.dumps(out, ensure_ascii=False, indent=2), "utf-8")
    except Exception:  # noqa: BLE001 — persistence is best effort, never fatal
        pass
    return out


@app.post("/api/projects/{name}/run-scenarios")
async def api_run_scenarios(name: str, payload: dict | None = None):
    """Run several what-ifs over the current model and return a comparison."""
    proj = _open(name)
    # Offload the (heavier still) multi-scenario sweep to a worker thread.
    _enter_run()
    try:
        return await run_in_threadpool(_run_scenarios_blocking, name, proj, payload or {})
    except RunCancelled:
        return {"cancelled": True, "message": "シナリオ比較を中止しました。"}
    finally:
        _exit_run()
        _clear_progress(name)


def _run_workmethods_blocking(name: str, proj: Project, payload: dict) -> dict:
    """作業方法比較: run the 4 picking-method presets (都度/マルチ/ゾーン/種まき) as
    edits to the ピッキング stage's 5-axis work design, and return a side-by-side
    comparison + travel-vs-sort metrics + a profile-based recommendation. The
    analytic-first → DES-validate spine: recommend a method, then prove it."""
    from whsim import workmethod
    from whsim.engine.scenarios import run_scenario
    from whsim.schema.model import Scenario
    base = proj.load_model()
    pidx = workmethod.pick_stage_index(base)
    reps = max(1, int(payload.get("reps", 3)))  # 4 methods × reps; keep responsive
    reps, scale_note = _adaptive_reps(base, reps)

    reporter = _progress_reporter(name, kind="workmethods",
                                  total_jobs=max(1, len(workmethod.METHOD_PRESETS)))
    methods = []
    for i, preset in enumerate(workmethod.METHOD_PRESETS):
        sc = Scenario(name=preset["label"], description=preset.get("desc", ""),
                      edits={f"process.stages.{pidx}.work": dict(preset["work"])})

        # Live within-method progress + the prompt-cancel seam, tagged per job.
        def _cb(rep, n, now, dur, _i=i, **kw):
            reporter(rep, n, now, dur, job=_i, **kw)
        _res, m = run_scenario(base, sc, reps=reps, progress=_cb)
        completed = max(1.0, float(m.get("orders_completed", 0)) or 1.0)
        methods.append({
            "id": preset["id"], "label": preset["label"], "desc": preset.get("desc", ""),
            "kpis": {
                "throughput_per_hr": m.get("throughput_per_hr", 0),
                "cost_per_order": m.get("total_cost_per_order", 0),
                "headcount": m.get("headcount", 0),
                "picker_utilization": m.get("picker_utilization", 0),
                "walk_per_order_m": m.get("walk_per_order_m", 0),
                "completion_rate": m.get("completion_rate", 0),
                "on_time_rate": m.get("on_time_rate", 0),
                "monthly_cost": m.get("monthly_cost", 0),
            },
            "travel_per_order_m": round(float(m.get("walk_per_order_m", 0) or 0), 1),
            "sort_per_order_s": round(float(m.get("sort_busy_s", 0) or 0) / completed, 1),
            "currency": m.get("currency", "¥"),
        })

    # Deltas vs the 都度 (discrete) baseline = methods[0].
    base_k = methods[0]["kpis"]

    def _pct(cur, ref):
        return round((cur - ref) / ref, 3) if ref else 0.0
    for mth in methods:
        k = mth["kpis"]
        mth["delta"] = {
            "cost_per_order": _pct(k["cost_per_order"], base_k["cost_per_order"]),
            "throughput_per_hr": _pct(k["throughput_per_hr"], base_k["throughput_per_hr"]),
            "travel": _pct(mth["travel_per_order_m"], methods[0]["travel_per_order_m"]),
        }

    # Profile-based recommendation, mapped to the nearest preset.
    rec = workmethod.recommend(base)
    w = rec.work
    rec_id = ("total" if w.consolidation == "sort"
              else "zone" if w.zoning == "parallel"
              else "multi" if w.orders_per_trip > 1 else "discrete")
    out = {
        "methods": methods, "baseline_id": "discrete",
        "recommend": {"id": rec_id, "name": rec.name, "reason": rec.reason},
        "reps": reps,
    }
    if scale_note:
        out["scale_note"] = scale_note
    return out


@app.post("/api/projects/{name}/workmethod/compare")
async def api_workmethod_compare(name: str, payload: dict | None = None):
    """作業方法（オーダー/マルチ/ゾーン/種まき）の比較を実行して返す。"""
    proj = _open(name)
    _enter_run()
    try:
        return await run_in_threadpool(_run_workmethods_blocking, name, proj, payload or {})
    except RunCancelled:
        return {"cancelled": True, "message": "作業方法比較を中止しました。"}
    finally:
        _exit_run()
        _clear_progress(name)


# ---- routers ----------------------------------------------------------------
# Concern-grouped APIRouter modules, mounted with byte-identical paths.
app.include_router(misc_routes.router)
app.include_router(projects_routes.router)
app.include_router(imports_routes.router)
app.include_router(analysis_routes.router)
app.include_router(run_render_routes.router)

# ---- static frontend (mounted last so /api/* wins) --------------------------
app.mount("/", StaticFiles(directory=str(STATIC), html=True), name="static")
