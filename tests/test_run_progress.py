"""Live run progress: the sim-clock fraction the UI polls during a DES run."""

import pytest

from whsim import templates
from whsim.engine.run import RunCancelled, run_replications


def test_progress_callback_advances_and_completes():
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 3600.0
    seen = []
    run_replications(m, reps=3, progress=lambda rep, reps, now, dur: seen.append(now / dur))
    assert len(seen) == 150                 # 50 chunks × 3 reps
    assert seen[0] <= 0.05 and abs(seen[-1] - 1.0) < 1e-6   # starts low, reaches 100%
    assert seen[:50] == sorted(seen[:50])   # monotone within a rep


def test_progress_path_matches_plain_run():
    """The chunked (progress) run must be event-for-event identical to the plain
    run — same KPI shape — so the reporting hook never changes the answer."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 3600.0
    a, _ = run_replications(m, reps=2)
    b, _ = run_replications(m, reps=2, progress=lambda *_: None)
    assert a[0].duration_s == b[0].duration_s
    assert len(a[0].events) == len(b[0].events)


def test_progress_endpoint_inactive_when_no_run():
    from fastapi.testclient import TestClient
    from whsim.web.app import app
    c = TestClient(app)
    c.post("/api/projects", json={"name": "prog1", "template": "ecommerce_small"})
    try:
        r = c.get("/api/projects/prog1/run/progress")
        assert r.status_code == 200 and r.json() == {"active": False}
    finally:
        c.delete("/api/projects/prog1")


def test_cancel_from_callback_aborts_run_early():
    """The 中止 escape hatch: a callback that raises RunCancelled aborts the run
    promptly (between sim-chunks), so the sim clock never reaches the full
    duration — and the cancellation propagates (it is NOT swallowed like a
    benign reporting hiccup)."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 3600.0
    seen = []

    def cb(rep, reps, now, dur, **_kw):
        seen.append(now / dur)
        if len(seen) >= 3:            # let a few chunks through, then cancel
            raise RunCancelled()

    with pytest.raises(RunCancelled):
        run_replications(m, reps=2, progress=cb)
    # Aborted between chunks: it stopped well before the final 100% chunk.
    assert seen[-1] < 1.0
    assert len(seen) <= 5


def test_reporting_hiccup_is_swallowed_not_fatal():
    """A non-RunCancelled exception from the callback is a reporting hiccup and
    must never fail the run (the distinction that makes cancel safe)."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 3600.0

    def cb(*_a, **_kw):
        raise ValueError("transient UI hiccup")

    res, _ = run_replications(m, reps=1, progress=cb)   # must complete normally
    assert res and res[0].duration_s == 3600.0


def test_cancel_endpoint_noop_when_idle():
    from fastapi.testclient import TestClient
    from whsim.web.app import app
    c = TestClient(app)
    c.post("/api/projects", json={"name": "prog2", "template": "ecommerce_small"})
    try:
        r = c.post("/api/projects/prog2/run/cancel")
        assert r.status_code == 200
        body = r.json()
        assert body.get("active") is False   # nothing running → harmless no-op
    finally:
        c.delete("/api/projects/prog2")


def test_progress_entry_carries_phase():
    """The progress entry the overlay polls includes a Japanese phase label so the
    bar is never silently stuck at 0% during build/aggregate."""
    from whsim.web.app import _RUN_PROGRESS, _clear_progress, _progress_reporter
    rep = _progress_reporter("phaseproj", kind="run", total_jobs=1)
    rep(0, 1, 0.0, 1.0, phase="build")
    st = _RUN_PROGRESS.get("phaseproj")
    assert st and st.get("phase") == "準備中"
    rep(0, 1, 0.5, 1.0)                  # default phase → 実行中
    assert _RUN_PROGRESS["phaseproj"]["phase"] == "実行中"
    _clear_progress("phaseproj")
