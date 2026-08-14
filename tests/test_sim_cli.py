"""ヘッドレス実行CLI（python -m whsim.sim）: 成果物・台帳・再現性・寛容さ。

「LLMは実験者、DESは装置」の装置側の口。全ての数値出力は run 成果物
（イベントログ／summary）由来で、この層は物理を1行も持たない。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from whsim.sim import canonical_hash, list_runs, run_scenario_dict

SCEN = {"template": "ecommerce_small", "seed": 7, "reps": 1,
        "duration_s": 900.0, "edits": {"resources.workers.0.count": 3}}


def test_run_persists_the_full_artifact_set(tmp_path):
    s = run_scenario_dict(SCEN, runs_dir=tmp_path)
    rd = Path(s["artifacts_path"])
    for f in ("scenario.json", "model.json", "events.jsonl", "summary.json"):
        assert (rd / f).is_file(), f
    # summary は run_id / seed / scenario_hash を必ず持つ（追試可能性の契約）
    assert s["run_id"] == rd.name and s["seed"] == 7
    assert len(s["scenario_hash"]) == 64
    # KPI はイベントログ集計の出力そのもの
    disk = json.loads((rd / "summary.json").read_text("utf-8"))
    assert disk["kpis"]["throughput_per_hr"] == s["kpis"]["throughput_per_hr"]
    # model.json だけで追試できる（編集が適用済みで焼かれている）
    md = json.loads((rd / "model.json").read_text("utf-8"))
    assert md["resources"]["workers"][0]["count"] == 3
    assert md["simulation"]["random_seed"] == 7


def test_ledger_appends_one_row_per_run(tmp_path):
    run_scenario_dict(SCEN, runs_dir=tmp_path)
    run_scenario_dict(SCEN, seed=8, runs_dir=tmp_path)
    rows = list_runs(tmp_path)
    assert len(rows) == 2
    assert rows[0]["seed"] == 7 and rows[1]["seed"] == 8
    assert all("throughput_per_hr" in r and "run_id" in r for r in rows)


def test_same_seed_same_scenario_reproduces_exactly(tmp_path):
    a = run_scenario_dict(SCEN, runs_dir=tmp_path)
    b = run_scenario_dict(SCEN, runs_dir=tmp_path)
    assert a["scenario_hash"] == b["scenario_hash"]
    ea = (Path(a["artifacts_path"]) / "events.jsonl").read_text("utf-8")
    eb = (Path(b["artifacts_path"]) / "events.jsonl").read_text("utf-8")
    assert ea == eb                      # イベント列そのものが完全一致
    assert a["kpis"] == b["kpis"]
    assert a["run_id"] != b["run_id"]    # run は別（台帳で区別できる）


def test_seed_kwarg_overrides_the_scenario(tmp_path):
    s = run_scenario_dict(SCEN, seed=99, runs_dir=tmp_path)
    assert s["seed"] == 99
    assert json.loads((Path(s["artifacts_path"]) / "scenario.json")
                      .read_text("utf-8"))["seed"] == 99


def test_canonical_hash_is_key_order_independent():
    assert canonical_hash({"a": 1, "b": [2, 3]}) == canonical_hash({"b": [2, 3], "a": 1})


def test_module_entrypoint_runs_a_scenario_file(tmp_path):
    scen = tmp_path / "scenario.json"
    scen.write_text(json.dumps(SCEN), "utf-8")
    env_runs = tmp_path / "runs"
    # -m 実行は DEFAULT_RUNS_DIR に書くので、ここでは import 経由で runs_dir を
    # 渡した上で、CLI は引数検証だけ subprocess で確かめる（リポジトリの runs/
    # をテストが汚さない）。
    out = subprocess.run([sys.executable, "-m", "whsim.sim"],
                         capture_output=True, text=True,
                         cwd=str(Path(__file__).resolve().parents[1]))
    assert out.returncode == 2 and "usage" in out.stderr
    s = run_scenario_dict(json.loads(scen.read_text("utf-8")), runs_dir=env_runs)
    assert (env_runs / s["run_id"] / "summary.json").is_file()


def test_broken_scenario_is_a_clean_error_not_a_traceback(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("[1,2,3]", "utf-8")
    out = subprocess.run([sys.executable, "-m", "whsim.sim", str(bad)],
                         capture_output=True, text=True,
                         cwd=str(Path(__file__).resolve().parents[1]))
    assert out.returncode == 1
    assert "シナリオJSON" in out.stderr
