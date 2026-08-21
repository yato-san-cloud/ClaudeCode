"""Round 4: the heavy-run concurrency guard returns 429 instead of saturating
the worker thread pool when too many runs are already in flight."""
import importlib

from fastapi.testclient import TestClient

# `whsim.web` re-exports the FastAPI instance as `app`, which shadows the
# submodule on attribute access — import the module object explicitly so we can
# reach its module-level globals (_inflight_runs).
appmod = importlib.import_module("whsim.web.app")


def test_run_concurrency_guard_returns_429(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    client = TestClient(appmod.app)
    assert client.post("/api/projects", json={"name": "cg", "template": "ecommerce_small"}).status_code == 200
    # Simulate the pool already being full; the guard must reject fast (429),
    # never enter run_in_threadpool.
    monkeypatch.setattr(appmod, "_inflight_runs", appmod.MAX_INFLIGHT_RUNS)
    r = client.post("/api/projects/cg/run")
    assert r.status_code == 429
    rs = client.post("/api/projects/cg/run-scenarios")
    assert rs.status_code == 429


def test_run_guard_releases_after_completion(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    client = TestClient(appmod.app)
    client.post("/api/projects", json={"name": "cg2", "template": "ecommerce_small"})
    # A normal run completes and leaves the in-flight counter back at zero.
    assert client.post("/api/projects/cg2/run").status_code == 200
    assert appmod._inflight_runs == 0
