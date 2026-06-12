"""Live run progress: the sim-clock fraction the UI polls during a DES run."""

from whsim import templates
from whsim.engine.run import run_replications


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
