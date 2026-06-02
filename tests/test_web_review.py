"""Regression tests for the backend review: path-traversal hardening, clean
HTTP codes (400/404 instead of 500), the Cody chat seam's tolerance of bad
input, and the CLI's clean error handling for missing projects/templates/files.

All endpoint tests use TestClient; cody is exercised directly; the CLI via
Typer's CliRunner. PROJECTS_DIR is monkeypatched into a tmp dir so nothing
touches the real workspace.
"""

import os

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from whsim import cody
from whsim.cli import app as cli_app
from whsim.web.app import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app, raise_server_exceptions=False)


# ---- path traversal --------------------------------------------------------

@pytest.mark.parametrize("evil", ["../escaped", "..", ".", "a/b", "a\\b",
                                  "../../etc", ""])
def test_create_rejects_traversal_names(client, tmp_path, evil):
    """A project name that could escape projects/ must be a clean 400, and must
    NOT create any directory outside the workspace."""
    r = client.post("/api/projects", json={"name": evil, "template": "ecommerce_small"})
    assert r.status_code == 400
    # Nothing should have been created above the workspace.
    assert not (tmp_path / "escaped").exists()
    assert not os.path.exists(str(tmp_path / "projects" / ".." / "escaped"))


def test_open_endpoints_reject_traversal(client):
    """A traversal name on a GET endpoint is a 400 (validated), never a 200/500."""
    r = client.get("/api/projects/..%2F..%2Fsecret/model")
    assert r.status_code in (400, 404)  # never a 200 leak / 500 crash


def test_compare_png_rejects_traversal(client):
    client.post("/api/projects", json={"name": "v1", "template": "ecommerce_small"})
    # A crafted compare id that tries to climb out of runs/.
    r = client.get("/api/projects/v1/compare-png/..%2F..%2Fraw/0")
    assert r.status_code in (400, 404)


def test_create_valid_japanese_name_ok(client):
    """A legitimate Unicode (Japanese) project name must still work."""
    r = client.post("/api/projects", json={"name": "テスト倉庫", "template": "ecommerce_small"})
    assert r.status_code == 200
    assert r.json()["name"] == "テスト倉庫"


# ---- clean HTTP codes ------------------------------------------------------

def test_create_unknown_template_is_400(client):
    r = client.post("/api/projects", json={"name": "ok1", "template": "does_not_exist"})
    assert r.status_code == 400


def test_headline_bad_path_is_400(client):
    client.post("/api/projects", json={"name": "h1", "template": "ecommerce_small"})
    r = client.post("/api/projects/h1/headline", json={"no.such.path": 5})
    assert r.status_code == 400


def test_headline_bad_value_is_400(client):
    """A type-invalid headline value is a clean 400, not a 500 ValidationError."""
    client.post("/api/projects", json={"name": "h2", "template": "ecommerce_small"})
    r = client.post("/api/projects/h2/headline",
                    json={"simulation.duration_s": "not-a-number"})
    assert r.status_code == 400


def test_missing_project_is_404(client):
    assert client.get("/api/projects/nope/model").status_code == 404
    assert client.post("/api/projects/nope/run").status_code == 404


# ---- cody chat seam tolerance ----------------------------------------------

def test_cody_chat_non_str_message_never_500(client):
    """A stray non-string message must not crash the chat seam."""
    r = client.post("/api/cody/chat", json={"message": 123})
    assert r.status_code == 200
    assert r.json()["intent"] in {"unknown", "smalltalk", "help"}


def test_cody_chat_non_str_project_is_ignored(client):
    r = client.post("/api/cody/chat", json={"message": "結果を見せて", "project": 42})
    assert r.status_code == 200
    # A non-string project is treated as "no project": echoed back as given.
    assert r.json()["intent"] == "open_view"


def test_cody_respond_tolerates_non_str_directly():
    """respond() is the LLM seam: it must not raise on a bad message type."""
    d = cody.respond(123)
    assert d["intent"] == "unknown"
    assert set(d) >= {"reply", "mood", "intent", "params", "suggestions", "needs"}
    d2 = cody.respond(None)
    assert d2["intent"] == "unknown"


# ---- CLI clean errors ------------------------------------------------------

def _cli(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return CliRunner()


def test_cli_run_missing_project_clean_error(tmp_path, monkeypatch):
    runner = _cli(tmp_path, monkeypatch)
    r = runner.invoke(cli_app, ["run", "ghost"])
    assert r.exit_code == 1
    assert "見つかりません" in r.output  # Japanese, not a Python traceback
    assert r.exception is None or isinstance(r.exception, SystemExit)


def test_cli_new_unknown_template_clean_error(tmp_path, monkeypatch):
    runner = _cli(tmp_path, monkeypatch)
    r = runner.invoke(cli_app, ["new", "p1", "-t", "no_such_template"])
    assert r.exit_code == 1
    assert "テンプレート" in r.output


def test_cli_import_missing_zip_clean_error(tmp_path, monkeypatch):
    runner = _cli(tmp_path, monkeypatch)
    runner.invoke(cli_app, ["new", "p2", "-t", "ecommerce_small"])
    r = runner.invoke(cli_app, ["import", "p2", str(tmp_path / "nope.zip")])
    assert r.exit_code == 1
    assert "ZIP" in r.output


def test_cli_new_then_estimate_ok(tmp_path, monkeypatch):
    """Happy path still works after the error-handling wrapping."""
    runner = _cli(tmp_path, monkeypatch)
    assert runner.invoke(cli_app, ["new", "p3", "-t", "ecommerce_small"]).exit_code == 0
    r = runner.invoke(cli_app, ["estimate", "p3"])
    assert r.exit_code == 0
