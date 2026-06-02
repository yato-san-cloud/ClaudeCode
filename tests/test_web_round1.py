"""Round-1 commercial-hardening tests for the whsim FastAPI backend.

Covers the new project-management endpoints (delete/rename/duplicate), the
structured /apply edit endpoint, actionable analysis insights (the `edit`
remedy object), and proof that the heavyweight run is offloaded off the event
loop via a worker thread.

All tests use TestClient with PROJECTS_DIR monkeypatched into a tmp dir, so the
real workspace is never touched.
"""

import sys
import threading

import pytest
from fastapi.testclient import TestClient

from whsim.web.app import app

# `whsim.web` re-exports the FastAPI instance as `whsim.web.app`, so the dotted
# name resolves to the app object, not the module. Grab the real module from
# sys.modules to monkeypatch its globals (e.g. run_replications).
webapp = sys.modules["whsim.web.app"]


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # Project.create/open resolve the workspace via the *relative* default
    # `Path("projects")` (a default-arg captured at import time), so isolating
    # tests requires both: chdir into a tmp dir AND keep PROJECTS_DIR relative so
    # the app's call-time reads (api_projects, _project_dir) agree with what
    # Project.create wrote. This keeps create + delete/rename/duplicate aligned.
    from pathlib import Path

    import whsim.project as project_mod
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", Path("projects"))
    return TestClient(app, raise_server_exceptions=False)


def _make(client, name="proj1"):
    r = client.post("/api/projects", json={"name": name, "template": "ecommerce_small"})
    assert r.status_code == 200, r.text
    return name


# ---- DELETE ----------------------------------------------------------------

def test_delete_happy(client):
    _make(client, "todelete")
    r = client.delete("/api/projects/todelete")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    # gone from the listing
    assert "todelete" not in client.get("/api/projects").json()


def test_delete_missing_is_404(client):
    r = client.delete("/api/projects/nope")
    assert r.status_code == 404


def test_delete_traversal_is_safe(client):
    # A traversal name must never delete anything outside the workspace: a
    # validated 400, a 404, or a routing 405 are all acceptable (never 200/500).
    r = client.delete("/api/projects/..%2F..%2Fsecret")
    assert r.status_code in (400, 404, 405)


# ---- RENAME ----------------------------------------------------------------

def test_rename_happy(client):
    _make(client, "old")
    r = client.post("/api/projects/old/rename", json={"to": "new"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "name": "new"}
    names = client.get("/api/projects").json()
    assert "new" in names and "old" not in names
    # display name kept in sync
    assert client.get("/api/projects/new/model").json()["name"] == "new"


def test_rename_missing_src_is_404(client):
    r = client.post("/api/projects/ghost/rename", json={"to": "x"})
    assert r.status_code == 404


def test_rename_dest_exists_is_400(client):
    _make(client, "a")
    _make(client, "b")
    r = client.post("/api/projects/a/rename", json={"to": "b"})
    assert r.status_code == 400


def test_rename_invalid_target_is_400(client):
    _make(client, "a")
    r = client.post("/api/projects/a/rename", json={"to": "../escape"})
    assert r.status_code == 400


# ---- DUPLICATE -------------------------------------------------------------

def test_duplicate_happy(client):
    _make(client, "src")
    r = client.post("/api/projects/src/duplicate", json={"to": "copy"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "name": "copy"}
    names = client.get("/api/projects").json()
    assert "src" in names and "copy" in names
    assert client.get("/api/projects/copy/model").json()["name"] == "copy"


def test_duplicate_dest_exists_is_400(client):
    _make(client, "src")
    _make(client, "dst")
    r = client.post("/api/projects/src/duplicate", json={"to": "dst"})
    assert r.status_code == 400


def test_duplicate_missing_src_is_404(client):
    r = client.post("/api/projects/ghost/duplicate", json={"to": "x"})
    assert r.status_code == 404


# ---- APPLY -----------------------------------------------------------------

def test_apply_good_edit_marks_interview(client):
    _make(client, "p")
    r = client.post("/api/projects/p/apply",
                    json={"edits": {"resources.workers.0.count": 9}})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "resources.workers.0.count" in body["applied"]
    assert body["skipped"] == []
    assert "provenance_summary" in body
    # persisted
    full = client.get("/api/projects/p/full").json()
    assert full["resources"]["workers"][0]["count"] == 9
    # provenance flips resources -> interview (no longer provisional)
    prov = client.get("/api/projects/p/model").json()["provenance"]["subtrees"]
    assert prov["resources"] == "interview"


def test_apply_mixed_good_and_bad_paths(client):
    _make(client, "p")
    r = client.post("/api/projects/p/apply", json={"edits": {
        "resources.workers.0.count": 7,
        "nonexistent.path.here": 5,
        "resources.workers.99.count": 1,  # index out of range -> skipped
    }})
    assert r.status_code == 200
    body = r.json()
    assert "resources.workers.0.count" in body["applied"]
    assert set(body["skipped"]) == {"nonexistent.path.here",
                                    "resources.workers.99.count"}


def test_apply_invalid_value_is_400_and_no_partial_save(client):
    _make(client, "p")
    before = client.get("/api/projects/p/full").json()
    # `resources` must be an object; a bare string violates the schema -> 400,
    # and the on-disk model must be left untouched (no partial save).
    r = client.post("/api/projects/p/apply",
                    json={"edits": {"resources": "not-a-dict"}})
    assert r.status_code == 400
    after = client.get("/api/projects/p/full").json()
    assert after == before


def test_apply_non_dict_edits_is_400(client):
    _make(client, "p")
    r = client.post("/api/projects/p/apply", json={"edits": [1, 2, 3]})
    assert r.status_code == 400


# ---- ANALYSIS insight `edit` remedies --------------------------------------

def test_analysis_insight_has_edit_after_run(client):
    """After a real run on a deliberately under-staffed model (1 picker), the
    bottleneck insight must carry an actionable `edit` pointing at the picker
    worker group's count."""
    _make(client, "p")
    # Squeeze pickers down to 1 so picking is a hot/overloaded bottleneck.
    client.post("/api/projects/p/apply",
                json={"edits": {"resources.workers.0.count": 1}})
    r = client.post("/api/projects/p/run")
    assert r.status_code == 200, r.text
    payload = client.get("/api/projects/p/analysis").json()
    assert payload["source"] == "run"
    insights = payload["insights"]
    # find any insight that carries an edit remedy
    edits = [ins["edit"] for ins in insights if "edit" in ins]
    assert edits, "expected at least one actionable edit remedy"
    e = edits[0]
    assert e["path"].startswith("resources.workers.")
    assert e["path"].endswith(".count")
    assert isinstance(e["value"], int) and e["value"] >= 1
    assert isinstance(e["label"], str) and e["label"]
    # the remedy is a real, applyable path
    applied = client.post("/api/projects/p/apply",
                          json={"edits": {e["path"]: e["value"]}}).json()
    assert e["path"] in applied["applied"]


def test_analysis_insight_edit_omitted_when_no_remedy(client):
    """The cost-per-order info insight is not a capacity remedy and must NOT
    carry an `edit` (we only attach where a concrete fix exists)."""
    _make(client, "p")
    client.post("/api/projects/p/run")
    payload = client.get("/api/projects/p/analysis").json()
    cost_ins = [i for i in payload["insights"] if i.get("title") == "1件あたり処理コスト"]
    if cost_ins:
        assert "edit" not in cost_ins[0]


# ---- threadpool offload ----------------------------------------------------

def test_run_executes_off_event_loop(client, monkeypatch):
    """Prove the heavy SimPy run is offloaded: when invoked through the async
    endpoint, run_replications must execute on a worker thread, NOT the main
    thread that owns the event loop."""
    main_thread = threading.main_thread()
    seen = {}
    real = webapp.run_replications

    def spy(model, *a, **k):
        seen["thread_is_main"] = threading.current_thread() is main_thread
        return real(model, *a, **k)

    monkeypatch.setattr(webapp, "run_replications", spy)
    _make(client, "p")
    r = client.post("/api/projects/p/run")
    assert r.status_code == 200, r.text
    assert seen.get("thread_is_main") is False, "run must not block the event loop"


def test_templates_served_while_run_in_flight(client, monkeypatch):
    """While a run is parked inside the worker thread, the event loop is free to
    serve a lightweight endpoint (/api/templates) concurrently."""
    started = threading.Event()
    release = threading.Event()
    real = webapp.run_replications

    def slow(model, *a, **k):
        started.set()
        # block the worker thread until the concurrent request has been served
        assert release.wait(timeout=10)
        return real(model, *a, **k)

    monkeypatch.setattr(webapp, "run_replications", slow)
    _make(client, "p")

    out = {}

    def fire_run():
        out["run"] = client.post("/api/projects/p/run")

    t = threading.Thread(target=fire_run)
    t.start()
    try:
        assert started.wait(timeout=10), "run never started"
        # The run is parked in a worker thread; templates must still answer fast.
        r = client.get("/api/templates")
        assert r.status_code == 200
        assert isinstance(r.json(), list)
    finally:
        release.set()
        t.join(timeout=30)
    assert out["run"].status_code == 200


def test_run_response_shape_unchanged(client):
    """The async offload must not change the response contract the frontend
    depends on: {kpis, estimate, run}."""
    _make(client, "p")
    body = client.post("/api/projects/p/run").json()
    assert set(body) >= {"kpis", "estimate", "run"}
    assert isinstance(body["kpis"], dict)
    assert body["run"].startswith("run_")
