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
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.staticfiles import StaticFiles

from whsim import analytic, kpis as kpi_mod
from whsim.engine.run import run_replications
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


def _run_blocking(proj: Project) -> dict:
    """The CPU-bound heart of a run (SimPy + KPIs + render + disk writes).

    Pulled out so the endpoint can hand it to a worker thread via
    ``run_in_threadpool``: the heavyweight discrete-event simulation must never
    execute on the event loop, or the whole server stalls for its duration."""
    model = proj.load_model()
    # Monte-Carlo: many stochastic order sequences; rep 0 carries the replay.
    results, heat = run_replications(model, reps=MONTE_CARLO_REPS)
    res = results[0]
    metrics = kpi_mod.compute(results, model)
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
        return await run_in_threadpool(_run_blocking, proj)
    finally:
        _exit_run()


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

    results = []
    for i, sc in enumerate(scenarios):
        res, metrics = run_scenario(base, sc, reps=6)
        model_i = apply_scenario(base, sc)
        render_png(model_i, res.heat, metrics, prov, cmp_dir / f"s{i}.png")
        results.append({"name": sc.name, "description": sc.description,
                        "kpis": metrics,
                        "png_url": f"/api/projects/{name}/compare-png/{cmp_id}/{i}"})

    baseline = results[0]
    alternatives = results[1:]
    for alt in alternatives:
        pb = payback_months(baseline["kpis"], alt["kpis"])
        alt["kpis"]["payback_months"] = pb
    out = {"compare_id": cmp_id, "baseline": baseline, "alternatives": alternatives}
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
    finally:
        _exit_run()


# ---- routers ----------------------------------------------------------------
# Concern-grouped APIRouter modules, mounted with byte-identical paths.
app.include_router(misc_routes.router)
app.include_router(projects_routes.router)
app.include_router(imports_routes.router)
app.include_router(analysis_routes.router)
app.include_router(run_render_routes.router)

# ---- static frontend (mounted last so /api/* wins) --------------------------
app.mount("/", StaticFiles(directory=str(STATIC), html=True), name="static")
