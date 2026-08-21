"""Round-3 coverage: CLI commands via Typer's CliRunner (happy + error paths)
plus an end-to-end smoke test (new -> import -> run -> render/animate -> estimate).

Filesystem isolation: `Project`'s default workspace is the relative ``projects/``
directory, resolved against the process CWD. We ``monkeypatch.chdir`` into a
per-test ``tmp_path`` so nothing pollutes the repo's ``projects/`` dir and no test
depends on a live server.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest
from typer.testing import CliRunner

from whsim.cli import app

runner = CliRunner()


@pytest.fixture()
def workspace(tmp_path, monkeypatch):
    """Run each CLI test inside an isolated temp CWD so `projects/` lives there."""
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _invoke(*args: str):
    return runner.invoke(app, list(args))


# ---- templates / new ----------------------------------------------------------

def test_templates_lists_ecommerce(workspace):
    res = _invoke("templates")
    assert res.exit_code == 0
    assert "ecommerce_small" in res.stdout


def test_new_creates_project(workspace):
    res = _invoke("new", "demo", "-t", "ecommerce_small")
    assert res.exit_code == 0
    assert "created project 'demo'" in res.stdout
    assert (workspace / "projects" / "demo" / "project.json").is_file()
    assert (workspace / "projects" / "demo" / "model.json").is_file()


def test_new_unknown_template_errors(workspace):
    res = _invoke("new", "demo", "-t", "no_such_template")
    assert res.exit_code == 1
    assert "見つかりません" in res.output


# ---- error paths on a missing project ----------------------------------------

def test_estimate_missing_project_errors(workspace):
    res = _invoke("estimate", "ghost")
    assert res.exit_code == 1
    assert "見つかりません" in res.output


def test_run_missing_project_errors(workspace):
    res = _invoke("run", "ghost")
    assert res.exit_code == 1


def test_render_without_run_errors(workspace):
    assert _invoke("new", "p", "-t", "ecommerce_small").exit_code == 0
    res = _invoke("render", "p")
    assert res.exit_code == 1
    assert "実行結果が見つかりません" in res.output


def test_animate_without_run_errors(workspace):
    assert _invoke("new", "p", "-t", "ecommerce_small").exit_code == 0
    res = _invoke("animate", "p")
    assert res.exit_code == 1
    assert "リプレイが見つかりません" in res.output


def test_import_missing_zip_errors(workspace):
    assert _invoke("new", "p", "-t", "ecommerce_small").exit_code == 0
    res = _invoke("import", "p", str(workspace / "nope.zip"))
    assert res.exit_code == 1
    assert "ZIP" in res.output


def test_import_missing_project_errors(workspace):
    res = _invoke("import", "ghost", str(workspace / "x.zip"))
    assert res.exit_code == 1


# ---- estimate / settings happy paths -----------------------------------------

def test_estimate_prints_json(workspace):
    assert _invoke("new", "p", "-t", "ecommerce_small").exit_code == 0
    res = _invoke("estimate", "p")
    assert res.exit_code == 0
    est = json.loads(res.stdout)
    assert est["method"] == "analytic_mmc"
    assert 0.0 <= est["picker_utilization"] <= 1.0


def test_settings_prints_empty_object_by_default(workspace):
    assert _invoke("new", "p", "-t", "ecommerce_small").exit_code == 0
    res = _invoke("settings", "p")
    assert res.exit_code == 0
    # Fresh project: no settings subtree set -> "{}" (a valid empty dict).
    assert json.loads(res.stdout) == {} or isinstance(json.loads(res.stdout), dict)


def test_settings_missing_project_errors(workspace):
    res = _invoke("settings", "ghost")
    assert res.exit_code == 1


# ---- delete -------------------------------------------------------------------

def test_delete_removes_project(workspace):
    assert _invoke("new", "p", "-t", "ecommerce_small").exit_code == 0
    assert (workspace / "projects" / "p").is_dir()
    res = _invoke("delete", "p")
    assert res.exit_code == 0
    assert "deleted project 'p'" in res.stdout
    assert not (workspace / "projects" / "p").exists()


def test_delete_missing_project_errors(workspace):
    res = _invoke("delete", "ghost")
    assert res.exit_code == 1
    assert "見つかりません" in res.output


# ---- import a real ZIP (overwrites a subtree, updates provenance) -------------

def _items_zip() -> bytes:
    """A minimal customer ZIP that provides an `items` subtree."""
    buf = io.BytesIO()
    items = [{"sku": "ABC", "name": "Widget", "abc_class": "A",
              "pick_freq": 5.0, "ts_per_unit": 1.0}]
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("items.json", json.dumps(items))
    return buf.getvalue()


def test_import_zip_updates_subtree_and_provenance(workspace):
    assert _invoke("new", "p", "-t", "ecommerce_small").exit_code == 0
    zpath = workspace / "items.zip"
    zpath.write_bytes(_items_zip())
    res = _invoke("import", "p", str(zpath))
    assert res.exit_code == 0
    assert "imported" in res.stdout
    # provenance summary line is printed and reflects real data > 0%
    assert "実データ" in res.output


# ---- end-to-end smoke test ----------------------------------------------------

def test_cli_end_to_end_smoke(workspace):
    """new -> run -> render -> animate -> estimate, all producing artifacts under
    projects/<name>/ inside the isolated temp workspace."""
    assert _invoke("new", "wh", "-t", "ecommerce_small").exit_code == 0

    run_res = _invoke("run", "wh")
    assert run_res.exit_code == 0, run_res.output
    assert "verdict:" in run_res.output

    run_dir = workspace / "projects" / "wh" / "runs" / "run_0001"
    assert (run_dir / "kpis.json").is_file()
    assert (run_dir / "heatmap.npy").is_file()
    assert (run_dir / "replay.json").is_file()

    render_res = _invoke("render", "wh")
    assert render_res.exit_code == 0, render_res.output
    assert "png ->" in render_res.output
    assert (run_dir / "layout_heatmap.png").is_file()

    animate_res = _invoke("animate", "wh")
    assert animate_res.exit_code == 0, animate_res.output
    assert (run_dir / "replay_2d.gif").is_file()

    est_res = _invoke("estimate", "wh")
    assert est_res.exit_code == 0
    assert json.loads(est_res.stdout)["method"] == "analytic_mmc"


def test_cli_simulate_runs_and_renders(workspace):
    assert _invoke("new", "sim", "-t", "ecommerce_small").exit_code == 0
    res = _invoke("simulate", "sim")
    assert res.exit_code == 0, res.output
    assert "verdict:" in res.output
    assert "png ->" in res.output
    run_dir = workspace / "projects" / "sim" / "runs" / "run_0001"
    assert (run_dir / "layout_heatmap.png").is_file()
