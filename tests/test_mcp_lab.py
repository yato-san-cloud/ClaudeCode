"""MCP実験装置（``whsim.mcp_server`` ＋ ``whsim.lab_report``）の契約テスト。

守りたいのは3つ:

1. **薄いラッパであること** — ツールの返す数値が、そのrunの成果物
   （``summary.json`` / ``events.jsonl``）に書いてある値と1つ残らず一致する。
2. **再現性** — 同一シナリオ・同一seedの2本はKPIが完全一致する。
3. **捏造遮断** — 比較表もレポートも成果物からの転記でしかあり得ず、
   数字を1つ書き換えれば照合関数が必ず落ちる（照合関数自体が本物か確かめる
   ため、故意に改竄した対照を入れてある）。

MCPプロトコル越しの疎通は最後のE2E（stdioでサーバーを起動し、実クライアントで
「台数を1台減らすと待機時間はどうなる？」を実行）で見る。それ以外はツール関数を
直接呼ぶ（同じ関数がそのまま ``add_tool`` で公開されている）。
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

import pytest

from whsim import lab_report as lab
from whsim import mcp_server as M
from whsim.lab_report import LabError

REPO = Path(__file__).resolve().parents[1]
E2E_DOC = REPO / "docs" / "mcp-lab-e2e.md"
# E2Eの記録をリポジトリの docs/ に書き出すのは、このフラグを立てた時だけ
# （通常の pytest はリポジトリを汚さない）。
E2E_DOC_ENV = "WHSIM_MCP_E2E_DOC"

# 干渉待ちが観測できる基準シナリオ（通路干渉ON＋ピッカー多め＋短時間）。
BASE = {
    "name": "基準（通路干渉あり・ピッカー12名）",
    "template": "ecommerce_small",
    "seed": 7,
    "reps": 1,
    "duration_s": 3600.0,
    "edits": {"simulation.aisle_interference": True,
              "resources.workers.0.count": 12,
              "orders.profile.peak_factor": 3.0},
}
DIFF = {"resources.workers.0.count": 11}      # 台数を1台減らす

# 補助テスト用の軽いシナリオ（速さのため）。
SHORT = {"template": "ecommerce_small", "seed": 3, "reps": 1, "duration_s": 300.0}

mcp_only = pytest.mark.skipif(
    __import__("importlib").util.find_spec("mcp") is None,
    reason="mcp SDK 未導入（pip install -e '.[lab]'）")


@pytest.fixture(scope="module")
def runs(tmp_path_factory):
    """runs/ を一時ディレクトリへ向ける（リポジトリの runs/ を汚さない）。"""
    d = tmp_path_factory.mktemp("mcp-runs")
    old = os.environ.get(lab.RUNS_DIR_ENV)
    os.environ[lab.RUNS_DIR_ENV] = str(d)
    try:
        yield d
    finally:
        if old is None:
            os.environ.pop(lab.RUNS_DIR_ENV, None)
        else:
            os.environ[lab.RUNS_DIR_ENV] = old


@pytest.fixture(scope="module")
def pair(runs):
    """基準run＋「台数を1台減らす」run（モジュール内で使い回す）。"""
    return M.run_scenario(scenario_json=BASE), M.apply_diff_and_run(BASE, DIFF)


# --------------------------------------------------------------------------
# run_scenario
# --------------------------------------------------------------------------

def test_run_scenario_returns_only_what_the_artifacts_say(pair, runs):
    a, _b = pair
    rd = Path(a["artifacts_path"])
    assert rd == runs / a["run_id"]
    for f in ("scenario.json", "model.json", "events.jsonl", "summary.json"):
        assert (rd / f).is_file(), f
    disk = json.loads((rd / "summary.json").read_text("utf-8"))
    assert a["summary"] == disk                 # 応答＝成果物そのもの（転記）
    assert a["seed"] == disk["seed"] == BASE["seed"]
    assert len(a["scenario_hash"]) == 64
    # 編集は焼かれたモデルに残っている（追試は model.json だけで足りる）
    md = json.loads((rd / "model.json").read_text("utf-8"))
    assert md["resources"]["workers"][0]["count"] == 12
    assert md["simulation"]["aisle_interference"] is True


def test_run_scenario_accepts_a_scenario_file(runs, tmp_path):
    p = tmp_path / "scenario.json"
    p.write_text(json.dumps(SHORT), "utf-8")
    out = M.run_scenario(scenario_path=str(p))
    assert (Path(out["artifacts_path"]) / "summary.json").is_file()
    assert out["summary"]["kpis"]["orders_arrived"] >= 0


@pytest.mark.parametrize(("kwargs", "needle"), [
    ({}, "どちらかを指定"),
    ({"scenario_path": "/nope/missing.json"}, "見つかりません"),
    ({"scenario_path": "x.json", "scenario_json": {"template": "ecommerce_small"}},
     "同時に指定できません"),
    ({"scenario_json": "[1,2,3]"}, "JSONオブジェクト"),
    ({"scenario_json": "{ broken"}, "JSONとして読めません"),
    ({"scenario_json": {"template": "ecommerce_small"}, "seed": "seven"}, "seed は整数"),
    ({"scenario_json": {"template": "ecommerce_small", "reps": 0}}, "reps は1以上"),
    ({"scenario_json": {"template": "ecommerce_small", "duration_s": -5}}, "duration_s は正"),
    ({"scenario_json": {"template": "ecommerce_small", "edits": [1]}}, "edits は dotted-path"),
    ({"scenario_json": {"model": "/nope/model.json"}}, "model に指定された"),
])
def test_run_scenario_rejects_bad_input_clearly(runs, kwargs, needle):
    with pytest.raises(LabError) as e:
        M.run_scenario(**kwargs)
    assert needle in str(e.value)


def test_a_scenario_the_engine_cannot_build_is_a_clear_error(runs):
    with pytest.raises(LabError) as e:
        M.run_scenario(scenario_json={**SHORT, "edits": {"process.routing_policy": "nope"}})
    assert "実行できませんでした" in str(e.value)


# --------------------------------------------------------------------------
# apply_diff_and_run
# --------------------------------------------------------------------------

def test_apply_diff_merges_edits_and_proves_they_landed(pair, runs):
    _a, b = pair
    assert b["scenario"]["edits"]["resources.workers.0.count"] == 11
    # 基準の編集は残り、差分だけが勝つ
    assert b["scenario"]["edits"]["simulation.aisle_interference"] is True
    assert b["applied_edits"] == ["resources.workers.0.count"]
    assert b["unapplied_edits"] == []
    md = json.loads((Path(b["artifacts_path"]) / "model.json").read_text("utf-8"))
    assert md["resources"]["workers"][0]["count"] == 11


def test_apply_diff_reports_an_edit_that_never_landed(runs):
    # apply_scenario は解決できない dotted-path を黙って捨てる。捨てられたことを
    # 実験者に見せられないと「減らしたのに何も変わらない」を誤読する。
    out = M.apply_diff_and_run(SHORT, {"resources.nonexistent.0.count": 3})
    assert out["applied_edits"] == []
    assert out["unapplied_edits"][0]["path"] == "resources.nonexistent.0.count"


@pytest.mark.parametrize(("diff", "needle"), [
    ({}, "diff_json が空"),
    ("[1,2,3]", "JSONオブジェクト"),
    ("{oops", "JSONとして読めません"),
    ({"": 1}, "dotted-path 文字列"),
    (5, "JSONオブジェクトかその文字列"),
])
def test_apply_diff_rejects_broken_diffs(runs, diff, needle):
    with pytest.raises(LabError) as e:
        M.apply_diff_and_run(SHORT, diff)
    assert needle in str(e.value)


def test_apply_diff_accepts_a_base_scenario_path_or_json_text(runs, tmp_path):
    p = tmp_path / "base.json"
    p.write_text(json.dumps(SHORT), "utf-8")
    from_path = M.apply_diff_and_run(str(p), {"resources.workers.0.count": 4})
    from_text = M.apply_diff_and_run(json.dumps(SHORT), {"resources.workers.0.count": 4})
    assert from_path["scenario_hash"] == from_text["scenario_hash"]
    assert from_path["summary"]["kpis"] == from_text["summary"]["kpis"]


# --------------------------------------------------------------------------
# 再現性
# --------------------------------------------------------------------------

def test_same_seed_reproduces_the_kpis_exactly(runs):
    a = M.run_scenario(scenario_json=SHORT, seed=11)
    b = M.run_scenario(scenario_json=SHORT, seed=11)
    assert a["run_id"] != b["run_id"]                 # 別のrunとして台帳に残る
    assert a["scenario_hash"] == b["scenario_hash"]
    assert a["summary"]["kpis"] == b["summary"]["kpis"]
    ea = (Path(a["artifacts_path"]) / "events.jsonl").read_text("utf-8")
    eb = (Path(b["artifacts_path"]) / "events.jsonl").read_text("utf-8")
    assert ea == eb                                   # イベント列そのものが一致


# --------------------------------------------------------------------------
# compare_runs — 全数値が summary.json からの転記であること
# --------------------------------------------------------------------------

def test_compare_runs_transcribes_every_number_from_summary_json(pair, runs):
    a, b = pair
    ids = [a["run_id"], b["run_id"]]
    table = M.compare_runs(ids)
    disk = {rid: json.loads((runs / rid / "summary.json").read_text("utf-8"))["kpis"]
            for rid in ids}
    assert table["baseline"] == ids[0]
    assert table["metrics"], "比較する指標が1つも無い"
    for row in table["metrics"]:
        m = row["metric"]
        base = disk[ids[0]][m]
        for rid in ids:
            assert row["values"][rid] == disk[rid][m]          # 転記そのもの
            assert row["delta"][rid] == pytest.approx(disk[rid][m] - base)
            want = None if base == 0 else (disk[rid][m] - base) / base * 100.0
            if want is None:
                assert row["pct_change"][rid] is None
            else:
                assert row["pct_change"][rid] == pytest.approx(want)
    for rid in ids:
        assert table["sources"][rid] == str(runs / rid / "summary.json")


def test_compare_runs_can_select_metrics(pair):
    a, b = pair
    table = M.compare_runs([a["run_id"], b["run_id"]], ["congestion_wait_total_s"])
    assert [r["metric"] for r in table["metrics"]] == ["congestion_wait_total_s"]


@pytest.mark.parametrize(("ids", "needle"), [
    ([], "1つ以上"),
    (["../etc"], "run_id の形式"),
    (["r-does-not-exist"], "run が見つかりません"),
])
def test_compare_runs_rejects_bad_run_ids(runs, ids, needle):
    with pytest.raises(LabError) as e:
        M.compare_runs(ids)
    assert needle in str(e.value)


def test_compare_runs_rejects_duplicate_run_ids(pair):
    a, _b = pair
    with pytest.raises(LabError) as e:
        M.compare_runs([a["run_id"], a["run_id"]])
    assert "重複" in str(e.value)


# --------------------------------------------------------------------------
# sweep
# --------------------------------------------------------------------------

def test_sweep_runs_every_case_and_persists_the_table(runs):
    out = M.sweep(SHORT, {"resources.workers.0.count": [4, 5]}, [1])
    assert out["cases"] == 2 and out["ok"] == 2 and out["failed"] == 0
    d = Path(out["dir"])
    for f in ("table.csv", "table.json", "index.jsonl", "sweep.json"):
        assert (d / f).is_file(), f
    rows = json.loads((d / "table.json").read_text("utf-8"))["rows"]
    # テーブルのKPIセルは各runの summary.json からの転記
    for row in rows:
        disk = json.loads((runs / row["run_id"] / "summary.json").read_text("utf-8"))["kpis"]
        for k, v in row["kpis"].items():
            assert v == disk[k]
    # 集計（min/max/mean）も転記の算術でしかない
    tp = out["summary"]["throughput_per_hr"]
    vals = [r["kpis"]["throughput_per_hr"] for r in rows]
    assert tp["min"] == min(vals) and tp["max"] == max(vals)
    assert tp["mean"] == pytest.approx(sum(vals) / len(vals))
    assert (d / "table.csv").read_text("utf-8").startswith("﻿")   # Excel用BOM


def test_sweep_records_a_failure_and_keeps_going(runs):
    out = M.sweep(SHORT, {"process.routing_policy": ["nearest", "not_a_policy"]}, [1])
    assert out["cases"] == 2 and out["ok"] == 1 and out["failed"] == 1
    assert "not_a_policy" in out["errors"][0]["params"]["process.routing_policy"]
    ledger = [json.loads(x) for x in
              (Path(out["dir"]) / "index.jsonl").read_text("utf-8").splitlines()]
    assert [r["status"] for r in ledger] == ["ok", "error"]
    assert ledger[1]["error"] and ledger[1]["run_id"] is None


@pytest.mark.parametrize(("grid", "seeds", "needle"), [
    ({}, [1], "param_grid が空"),
    ({"a.b": 3}, [1], "空でないリスト"),
    ({"a.b": []}, [1], "空でないリスト"),
    ({"a.b": [1]}, [], "seed を1つ以上"),
    ({"a.b": [1]}, ["x"], "seed は整数"),
    ({"a.b": [1]}, [-1], "seed が範囲外"),
    ({"a.b": list(range(65))}, [1], "上限を超えています"),
    ({"a.b": list(range(10))}, list(range(10)), "上限を超えています"),
])
def test_sweep_rejects_out_of_range_parameters(runs, grid, seeds, needle):
    with pytest.raises(LabError) as e:
        M.sweep(SHORT, grid, seeds)
    assert needle in str(e.value)


# --- sweep: 名指しした KPI と、ケースごとの行 ------------------------------
# 掃引の目的は**曲線**（つまみ→KPIの並び）なので、(1) 見たい KPI が既定の主要KPIに
# 入っていない機構（容器・停止線・詰まり）だと表に1つも出ない、(2) 行がファイルに
# しか無いと臨界点を読むのに run 1本ずつ問い合わせる、の2つがそのまま実験の障壁に
# なる。どちらも「装置が数値を作る」話ではない — 転記する先の話。

LINE_KPIS = ["containers_in_use_peak", "container_pool_size", "container_wait_total_s",
             "conveyor_gate_stops", "conveyor_block_ratio", "completion_rate"]


def test_sweep_carries_the_kpis_you_name_and_they_are_still_transcription(runs):
    out = M.sweep(SHORT, {"resources.workers.0.count": [4, 5]}, [1],
                  metrics=LINE_KPIS)
    assert out["metrics"] == LINE_KPIS
    assert out["warnings"] == [] and out["unapplied_edits"] == []
    for row in out["rows"]:
        assert list(row["kpis"]) == LINE_KPIS
        disk = json.loads(
            (runs / row["run_id"] / "summary.json").read_text("utf-8"))["kpis"]
        for k, v in row["kpis"].items():
            assert v == disk[k]                      # 転記そのもの（作った数字ではない）
    # 永続化した表にも同じ列が立つ（応答とファイルが食い違わない）
    header = (Path(out["table_path"]).read_text("utf-8")
              .lstrip("﻿").splitlines()[0].split(","))
    assert {"containers_in_use_peak", "conveyor_gate_stops"} <= set(header)
    assert "walk_total_m" not in header              # 名指ししたものだけ
    assert set(out["summary"]) <= set(LINE_KPIS)


def test_sweep_returns_the_case_rows_so_the_curve_takes_one_round_trip(runs):
    grid = {"resources.workers.0.count": [4, 5], "orders.profile.peak_factor": [1.0, 2.0]}
    out = M.sweep(SHORT, grid, [1])
    assert len(out["rows"]) == out["cases"] == 4
    assert [r["case"] for r in out["rows"]] == [1, 2, 3, 4]
    # 行は params ↔ run_id ↔ KPI を1つの表として持つ（応答＝ファイルの table.json）
    disk = {r["case"]: r for r in
            json.loads((Path(out["dir"]) / "table.json").read_text("utf-8"))["rows"]}
    for r in out["rows"]:
        assert r["params"] == disk[r["case"]]["params"]
        assert r["run_id"] == disk[r["case"]]["run_id"]
        assert r["kpis"] == disk[r["case"]]["kpis"]
    assert {r["params"]["resources.workers.0.count"] for r in out["rows"]} == {4, 5}


def test_sweep_summarises_a_composite_param_instead_of_echoing_it(runs):
    """複合値（配列丸ごと）は64ケース分そのまま返すと応答が実験より大きくなる。
    形だけ返し、全量は table.json に残す（出所は失わない）。"""
    workers = [{"id": "pickers", "role": "picker", "count": 5},
               {"id": "packers", "role": "packer", "count": 2}]
    out = M.sweep(SHORT, {"resources.workers": [workers]}, [1])
    assert out["rows"][0]["params"]["resources.workers"] == "<list len=2>"
    disk = json.loads((Path(out["dir"]) / "table.json").read_text("utf-8"))["rows"]
    assert disk[0]["params"]["resources.workers"] == workers


def test_sweep_says_out_loud_when_the_swept_knob_never_landed(runs):
    """``apply_scenario`` は解決できない dotted-path を黙って捨てる。掃引だと
    「同じ数字が4本並んだ」だけが返り、実験者は「このつまみは効かない」と読む —
    実際は**回していない**。1本ずつなら apply_diff_and_run が言うことを、掃引でも
    言わないと差分実験が静かに嘘をつく。"""
    out = M.sweep(SHORT, {"resources.nonexistent.0.count": [1, 2, 3]}, [1])
    assert out["ok"] == 3 and out["failed"] == 0     # 走るには走る（never-blocks）
    assert [u["path"] for u in out["unapplied_edits"]] == ["resources.nonexistent.0.count"]
    assert out["unapplied_edits"][0]["cases"] == [1, 2, 3]
    assert all(r["unapplied_edits"] for r in out["rows"])
    assert any("効かなかった編集" in w for w in out["warnings"])
    assert any("KPIが完全に一致" in w for w in out["warnings"])


def test_sweep_flags_a_gate_position_sweep_on_a_belt_that_has_no_gate(runs):
    """顧客の実物: `停止線位置±` を stop_gate=None のベルトに当てると、パスが
    解決できず全ケースが基準と同じ run になる（自由 dict なので警告も出ない）。"""
    base = {"template": "pick_to_belt", "seed": 3, "reps": 1, "duration_s": 300.0}
    out = M.sweep(base, {"resources.conveyors.0.stop_gate.at_m": [2.0, 6.0]}, [3],
                  metrics=["conveyor_gate_stops", "throughput_per_hr"])
    assert out["ok"] == 2
    assert [u["path"] for u in out["unapplied_edits"]] == \
        ["resources.conveyors.0.stop_gate.at_m"]
    assert out["warnings"] and all(r["kpis"]["conveyor_gate_stops"] == 0
                                   for r in out["rows"])


def test_sweep_without_metrics_is_the_old_sweep(runs):
    out = M.sweep(SHORT, {"resources.workers.0.count": [4, 5]}, [1])
    assert out["metrics"] == list(lab.HEADLINE_KPIS)
    assert out["warnings"] == [] and out["unapplied_edits"] == []
    for row in out["rows"]:
        assert list(row["kpis"]) == list(lab.HEADLINE_KPIS)


@pytest.mark.parametrize(("metrics", "needle"), [
    ([], "KPI キーの配列"),
    ("throughput_per_hr", "KPI キーの配列"),
    ([""], "KPI 名の文字列"),
    ([1], "KPI 名の文字列"),
    ([f"k{i}" for i in range(61)], "metrics が多すぎます"),
])
def test_sweep_rejects_bad_metrics(runs, metrics, needle):
    with pytest.raises(LabError) as e:
        M.sweep(SHORT, {"resources.workers.0.count": [4]}, [1], metrics=metrics)
    assert needle in str(e.value)


def test_the_line_mechanics_kpis_have_labels_a_proposal_can_print(runs):
    """比較表の行ラベル。数字を含めてはいけない — 見出しは値ではないので、本文の
    数値照合（`verify_report`）に拾われた瞬間に「台帳に無い数字」になる。"""
    for k in ("containers_in_use_peak", "conveyor_gate_stops", "conveyor_block_ratio",
              "container_wait_total_s", "container_pool_size"):
        label = lab.KPI_JP.get(k)
        assert label and label != k, k
        assert not lab._NUM_RE.findall(label), (k, label)


# --------------------------------------------------------------------------
# query_events
# --------------------------------------------------------------------------

def test_query_events_summarises_instead_of_dumping_the_log(pair, runs):
    _a, b = pair
    out = M.query_events(b["run_id"], limit=5)
    raw = [json.loads(x) for x in
           (runs / b["run_id"] / "events.jsonl").read_text("utf-8").splitlines() if x.strip()]
    assert out["total_events"] == len(raw) == out["matched"]
    assert len(out["sample"]) == 5 and out["truncated"] is True
    assert out["sample"] == raw[:5]                     # 先頭N行はログそのまま
    assert sum(out["by_type"].values()) == len(raw)
    assert out["t_min"] == min(e["t"] for e in raw)
    assert out["t_max"] == max(e["t"] for e in raw)


def test_query_events_filters_by_type_actor_and_time(pair, runs):
    _a, b = pair
    raw = [json.loads(x) for x in
           (runs / b["run_id"] / "events.jsonl").read_text("utf-8").splitlines() if x.strip()]
    waits = [e for e in raw if e["event"] == "aisle_wait"]
    assert waits, "干渉ONの基準シナリオなのに通路待ちが1件も無い"
    out = M.query_events(b["run_id"], {"type": "aisle_wait"}, limit=3)
    assert out["matched"] == len(waits)
    # 数値フィールドの集計もログの値そのものの合計（作った数字ではない）
    assert out["numeric_fields"]["wait"]["sum"] == pytest.approx(
        sum(e["wait"] for e in waits))
    actor = waits[0]["worker"]
    by_actor = M.query_events(b["run_id"], {"type": "aisle_wait", "actor": actor})
    assert by_actor["matched"] == len([e for e in waits if e["worker"] == actor])
    window = M.query_events(b["run_id"], {"t_range": [0, 60]})
    assert window["matched"] == len([e for e in raw if e["t"] <= 60])
    assert M.query_events(b["run_id"], {"type": ["pack_done", "order_complete"]})["matched"] \
        == len([e for e in raw if e["event"] in ("pack_done", "order_complete")])


@pytest.mark.parametrize(("kwargs", "needle"), [
    ({"run_id": "../secrets"}, "run_id の形式"),
    ({"run_id": "r-nope"}, "run が見つかりません"),
    ({"limit": 0}, "limit は1以上"),
    ({"limit": 10_000}, "上限を超えています"),
    ({"rep": -1}, "rep は0以上"),
    ({"rep": 9}, "イベントログがありません"),
    ({"filter": {"t_range": [10, 1]}}, "逆順"),
    ({"filter": {"t_range": [10]}}, "t_range は"),
    ({"filter": {"actor": 5}}, "actor は文字列"),
    ({"filter": "[]"}, "JSONオブジェクト"),
])
def test_query_events_rejects_bad_input_clearly(pair, kwargs, needle):
    _a, b = pair
    args = {"run_id": b["run_id"], **kwargs}
    with pytest.raises(LabError) as e:
        M.query_events(**args)
    assert needle in str(e.value)


# --------------------------------------------------------------------------
# get_run_artifacts / list_runs / init_state_from_snapshot
# --------------------------------------------------------------------------

def test_get_run_artifacts_lists_paths_not_contents(pair, runs):
    a, _b = pair
    out = M.get_run_artifacts(a["run_id"])
    names = {f["name"] for f in out["files"]}
    assert {"scenario.json", "model.json", "events.jsonl", "summary.json"} <= names
    assert all(f["bytes"] > 0 and f["path"].startswith(str(runs)) for f in out["files"])
    with pytest.raises(LabError):
        M.get_run_artifacts("r-nope")


def test_list_runs_returns_the_ledger_newest_first(pair, runs):
    a, b = pair
    out = M.list_runs(limit=200)
    ids = [r["run_id"] for r in out["runs"]]
    assert a["run_id"] in ids and b["run_id"] in ids
    assert ids.index(b["run_id"]) < ids.index(a["run_id"])       # 新しい順
    ledger = (runs / "index.jsonl").read_text("utf-8").splitlines()
    assert out["total"] == len([x for x in ledger if x.strip()])
    assert len(M.list_runs(limit=1)["runs"]) == 1
    with pytest.raises(LabError):
        M.list_runs(limit=0)


def test_init_state_from_snapshot_validates_shape_only():
    ok = M.init_state_from_snapshot({"t": 0, "orders": [{"order_id": "A"}],
                                     "inventory": {"SKU-1": 5}})
    assert ok["usable"] is True
    assert ok["recognized"] == {"t": 0.0, "orders": 1, "inventory": 1}
    assert ok["engine_supported"] is False       # ウォームスタートはまだ無い（正直に）
    bad = M.init_state_from_snapshot({"t": -1, "orders": {}})
    assert bad["usable"] is False and len(bad["reasons"]) == 2
    empty = M.init_state_from_snapshot({"whatever": 1})
    assert empty["usable"] is False and empty["unknown_keys"] == ["whatever"]
    with pytest.raises(LabError):
        M.init_state_from_snapshot("[1,2]")


# --------------------------------------------------------------------------
# 捏造遮断 — レポートの全数値が成果物由来であることの機械照合
# --------------------------------------------------------------------------

def test_report_is_written_and_self_verifies(pair, runs, tmp_path):
    a, b = pair
    out = M.generate_report([a["run_id"], b["run_id"]], out_dir=str(tmp_path / "rep"))
    d = Path(out["report_dir"])
    assert (d / "report.md").is_file() and (d / "numbers.json").is_file()
    assert out["images"] and all(Path(p).stat().st_size > 0 for p in out["images"])
    assert out["verification"]["ok"] is True
    assert out["verification"]["checked"] > 0


def test_every_number_in_the_report_traces_to_a_run_artifact(pair, runs, tmp_path):
    a, b = pair
    out = M.generate_report([a["run_id"], b["run_id"]], out_dir=str(tmp_path / "rep2"))
    ledger = json.loads(Path(out["numbers_path"]).read_text("utf-8"))
    disk = {rid: json.loads((runs / rid / "summary.json").read_text("utf-8"))
            for rid in (a["run_id"], b["run_id"])}
    checked = 0
    for rec in ledger["numbers"]:
        src = rec["source"]
        if src["kind"] != "artifact" or src["file"] != "summary.json":
            continue
        assert rec["value"] == lab.get_by_path(disk[src["run_id"]], src["path"])
        checked += 1
    assert checked > 0
    # 本文の数値はすべて台帳にある（＝台帳に無い数字は1つも書かれていない）
    body = lab.strip_code(Path(out["report_path"]).read_text("utf-8"))
    texts = {rec["text"] for rec in ledger["numbers"]}
    assert set(lab._NUM_RE.findall(body)) <= texts


def test_verify_report_catches_a_tampered_ledger_value(pair, tmp_path):
    a, b = pair
    out = M.generate_report([a["run_id"], b["run_id"]], out_dir=str(tmp_path / "rep3"))
    d = Path(out["report_dir"])
    assert M.verify_report(str(d))["ok"] is True          # 対照: 素のままは通る
    led = json.loads((d / "numbers.json").read_text("utf-8"))
    victim = next(r for r in led["numbers"] if isinstance(r["value"], (int, float)))
    victim["value"] = float(victim["value"]) + 1.0        # 故意の改竄
    (d / "numbers.json").write_text(json.dumps(led, ensure_ascii=False), "utf-8")
    res = M.verify_report(str(d))
    assert res["ok"] is False
    assert any(m["id"] == victim["id"] and "一致しません" in m["reason"]
               for m in res["mismatches"])


def test_verify_report_catches_a_number_that_is_in_no_ledger(pair, tmp_path):
    a, b = pair
    out = M.generate_report([a["run_id"], b["run_id"]], out_dir=str(tmp_path / "rep4"))
    d = Path(out["report_dir"])
    md = d / "report.md"
    md.write_text(md.read_text("utf-8") + "\n通路待ちは 9999 秒でした。\n", "utf-8")
    res = M.verify_report(str(d))
    assert res["ok"] is False and "9999" in res["unbacked_numbers"]


def test_verify_report_catches_a_cell_swapped_for_another_legitimate_number(pair, tmp_path):
    """監査で見つかった穴の回帰: 本文のある数値を、**レポート内の別の正当な数値**
    に入れ替える改竄（到着オーダー数のセルに seed の値を置く）。

    数値トークンの集合所属だけを見る照合はこれを素通りする（置いた数字も台帳に
    「居る」から）。行ラベル×列のセル位置まで見て初めて落ちる。
    """
    a, b = pair
    out = M.generate_report([a["run_id"], b["run_id"]], out_dir=str(tmp_path / "rep6"))
    d = Path(out["report_dir"])
    assert M.verify_report(str(d))["ok"] is True          # 対照: 素のままは通る
    led = json.loads((d / "numbers.json").read_text("utf-8"))
    seed_text = next(r["text"] for r in led["numbers"]
                     if r["source"].get("path") == ["seed"])

    md = d / "report.md"
    lines = md.read_text("utf-8").splitlines()
    i = next(n for n, x in enumerate(lines) if x.startswith("| 到着オーダー数 |"))
    cells = lines[i].split("|")
    assert cells[2].strip() != seed_text                   # そもそも別の数値である
    cells[2] = f" {seed_text} "                            # 故意のすり替え
    lines[i] = "|".join(cells)
    md.write_text("\n".join(lines) + "\n", "utf-8")

    res = M.verify_report(str(d))
    assert res["ok"] is False
    assert res["unbacked_numbers"] == []      # 集合判定は素通りする（＝この穴）
    assert res["mismatches"] == []            # 台帳→成果物も素通りする
    bad = res["misplaced_numbers"]
    assert bad and all(x["anchor"]["row"] == "到着オーダー数" for x in bad)
    assert bad[0]["in_report"] == seed_text and bad[0]["expected"] != seed_text


def test_verify_report_catches_two_cells_swapped_with_each_other(pair, tmp_path):
    a, b = pair
    out = M.generate_report([a["run_id"], b["run_id"]], out_dir=str(tmp_path / "rep7"))
    d = Path(out["report_dir"])
    md = d / "report.md"
    lines = md.read_text("utf-8").splitlines()
    i = next(n for n, x in enumerate(lines) if x.startswith("| 完了オーダー数 |"))
    cells = lines[i].split("|")
    cells[2], cells[3] = cells[3], cells[2]                # 基準列と比較列を入れ替え
    lines[i] = "|".join(cells)
    md.write_text("\n".join(lines) + "\n", "utf-8")
    res = M.verify_report(str(d))
    assert res["ok"] is False and res["unbacked_numbers"] == []
    assert {x["anchor"]["row"] for x in res["misplaced_numbers"]} == {"完了オーダー数"}


def test_verify_report_catches_a_deleted_table_row(pair, tmp_path):
    a, b = pair
    out = M.generate_report([a["run_id"], b["run_id"]], out_dir=str(tmp_path / "rep8"))
    d = Path(out["report_dir"])
    md = d / "report.md"
    lines = [x for x in md.read_text("utf-8").splitlines()
             if not x.startswith("| 通路待ち回数 |")]
    md.write_text("\n".join(lines) + "\n", "utf-8")
    res = M.verify_report(str(d))
    assert res["ok"] is False
    assert any(x["reason"] == "本文に該当セルがありません"
               for x in res["misplaced_numbers"])


def test_every_table_cell_is_anchored_to_its_source(pair, tmp_path):
    """位置照合の網羅性: 比較表の数値セルは1つ残らず台帳のアンカーを持つ。"""
    a, b = pair
    out = M.generate_report([a["run_id"], b["run_id"]], out_dir=str(tmp_path / "rep9"))
    d = Path(out["report_dir"])
    led = json.loads((d / "numbers.json").read_text("utf-8"))
    anchors = {(r["anchor"]["table"], r["anchor"]["row"], r["anchor"]["col"],
                r["anchor"].get("part", 0)) for r in led["numbers"] if r.get("anchor")}
    tables = {t["name"]: t for t in lab.parse_tables((d / "report.md").read_text("utf-8"))}
    assert set(tables) >= {lab.T_SETUP, lab.T_KPI}
    for name in (lab.T_SETUP, lab.T_KPI):
        for row_key, row in tables[name]["rows"].items():
            for col, cell in row.items():
                for part, txt in enumerate(cell.split(lab.CELL_SEP)):
                    if not lab._NUM_RE.fullmatch(txt.strip()):
                        continue          # 識別子・名前・「—」は数値セルではない
                    assert (name, row_key, col, part) in anchors, (name, row_key, col)
    assert out["verification"]["anchored"] == len(anchors)


def test_verify_report_catches_a_tampered_run_artifact(pair, runs, tmp_path, monkeypatch):
    a, b = pair
    ids = [a["run_id"], b["run_id"]]
    fake = tmp_path / "runs"
    fake.mkdir()
    for rid in ids:
        shutil.copytree(runs / rid, fake / rid)
    monkeypatch.setenv(lab.RUNS_DIR_ENV, str(fake))
    out = M.generate_report(ids, out_dir=str(tmp_path / "rep5"))
    assert out["verification"]["ok"] is True
    s = json.loads((fake / ids[0] / "summary.json").read_text("utf-8"))
    s["kpis"]["throughput_per_hr"] = float(s["kpis"]["throughput_per_hr"]) + 1.0
    (fake / ids[0] / "summary.json").write_text(json.dumps(s, ensure_ascii=False), "utf-8")
    res = M.verify_report(out["report_dir"])
    assert res["ok"] is False and res["mismatches"]
    # 転記だけでなく「転記の算術」（差・変化率）も出所ごと再計算されて落ちる
    assert any(m.get("reason", "").startswith("値が") for m in res["mismatches"])


def test_verify_report_needs_a_real_report_dir(tmp_path):
    with pytest.raises(LabError):
        M.verify_report(str(tmp_path / "nothing"))
    with pytest.raises(LabError):
        M.verify_report("")


def test_pct_change_against_a_zero_baseline_is_not_invented():
    # 0 を基準にした変化率は「∞」でも「0」でもない — 定義しないのが正直。
    assert lab._pct_change(3.0, 0.0) is None
    assert lab._pct_change(3.0, 2.0) == pytest.approx(50.0)
    assert lab._delta(3.0, 2.0) == pytest.approx(1.0)


# --------------------------------------------------------------------------
# MCPプロトコル（stdio）— サーバーの組み立てとE2E
# --------------------------------------------------------------------------

@mcp_only
def test_server_exposes_the_tool_contract():
    srv = M.build_server()
    import anyio
    tools = anyio.run(srv.list_tools)
    names = {t.name for t in tools}
    assert names == {"run_scenario", "apply_diff_and_run", "compare_runs", "sweep",
                     "query_events", "get_run_artifacts", "list_runs",
                     "init_state_from_snapshot", "generate_report", "verify_report"}
    assert all(t.description for t in tools)


def _tool_result(res):
    """CallToolResult → dict（mcp 1.x/2.x のフィールド名差を吸収）。"""
    data = getattr(res, "structured_content", None) or getattr(res, "structuredContent", None)
    if data is None:
        data = json.loads(res.content[0].text)
    return data


def _is_error(res) -> bool:
    return bool(getattr(res, "is_error", None) or getattr(res, "isError", None))


def _run_e2e(runs_dir: Path) -> list[dict]:
    """stdioでサーバーを起動し、実クライアントで実験を1本通す。記録を返す。"""
    import anyio
    from mcp import ClientSession, StdioServerParameters, stdio_client

    steps: list[dict] = []

    async def go() -> None:
        params = StdioServerParameters(
            command=sys.executable, args=["-m", "whsim.mcp_server"],
            env={**os.environ, lab.RUNS_DIR_ENV: str(runs_dir)}, cwd=str(REPO))
        async with stdio_client(params) as (read, write), ClientSession(read, write) as s:
            info = await s.initialize()
            tools = await s.list_tools()
            steps.append({"call": "initialize", "args": {},
                          "out": {"server": getattr(info.server_info, "name", ""),
                                  "tools": sorted(t.name for t in tools.tools)}})

            async def call(name: str, args: dict) -> dict:
                res = await s.call_tool(name, args)
                if _is_error(res):
                    raise AssertionError(f"{name} が失敗: {res.content}")
                out = _tool_result(res)
                steps.append({"call": name, "args": args, "out": out})
                return out

            base = await call("run_scenario", {"scenario_json": BASE})
            diff = await call("apply_diff_and_run",
                              {"base_scenario": BASE, "diff_json": DIFF})
            await call("compare_runs", {"run_ids": [base["run_id"], diff["run_id"]],
                                        "metrics": ["pick_wait_mean_s", "cycle_mean_s",
                                                    "congestion_waits",
                                                    "congestion_wait_total_s",
                                                    "completion_rate", "throughput_per_hr"]})
            # 待ちのKPI（congestion_waits / congestion_wait_total_s）は
            # aisle_wait と aisle_pass_forced の2種から作られている。同じ2種で
            # 引けば「そのKPIはこのログの何行から来たか」が件数まで一致する。
            for rid in (base["run_id"], diff["run_id"]):
                await call("query_events",
                           {"run_id": rid,
                            "filter": {"type": ["aisle_wait", "aisle_pass_forced"]},
                            "limit": 2})

    anyio.run(go)
    return steps


@mcp_only
def test_e2e_over_stdio_answers_how_one_fewer_picker_changes_waiting(tmp_path):
    """「台数を1台減らすと待機時間はどうなる？」をMCP越しに自動実行する。

    ``WHSIM_MCP_E2E_DOC=1`` を立てると ``docs/mcp-lab-e2e.md`` に記録を書き出す
    （数値はrun成果物由来のものをそのまま転記）。
    """
    runs_dir = tmp_path / "runs"
    steps = _run_e2e(runs_dir)
    calls = {s["call"]: s for s in steps}
    assert calls["initialize"]["out"]["tools"], "tools/list が空"
    base_id = calls["run_scenario"]["out"]["run_id"]
    diff_id = calls["apply_diff_and_run"]["out"]["run_id"]
    assert calls["apply_diff_and_run"]["out"]["applied_edits"] == \
        ["resources.workers.0.count"]

    table = calls["compare_runs"]["out"]
    disk = {rid: json.loads((runs_dir / rid / "summary.json").read_text("utf-8"))["kpis"]
            for rid in (base_id, diff_id)}
    for row in table["metrics"]:                     # 表の数値＝成果物の数値
        for rid in (base_id, diff_id):
            assert row["values"][rid] == disk[rid][row["metric"]]
    wait = next(r for r in table["metrics"] if r["metric"] == "pick_wait_mean_s")
    assert wait["delta"][diff_id] == pytest.approx(
        disk[diff_id]["pick_wait_mean_s"] - disk[base_id]["pick_wait_mean_s"])

    ev = [s for s in steps if s["call"] == "query_events"]
    assert len(ev) == 2
    assert all(len(x["out"]["sample"]) <= 2 for x in ev)     # 全量を流していない
    # 待ちのKPIが「このログのこの行たち」から来ていることを件数と合計で照合
    for x in ev:
        rid = x["args"]["run_id"]
        assert x["out"]["matched"] == disk[rid]["congestion_waits"]
        assert x["out"]["numeric_fields"]["wait"]["sum"] == pytest.approx(
            disk[rid]["congestion_wait_total_s"])

    if os.environ.get(E2E_DOC_ENV):
        E2E_DOC.write_text(_render_e2e_doc(steps, runs_dir, table, disk), "utf-8")


def _render_e2e_doc(steps, runs_dir, table, disk) -> str:
    """E2Eの記録（コマンドと出力）を Markdown に落とす。"""
    def block(obj, cap=2600):
        s = json.dumps(obj, ensure_ascii=False, indent=2)
        return s if len(s) <= cap else s[:cap] + "\n…（省略。全量は成果物ファイル）"

    base_id, diff_id = table["run_ids"]
    out = [
        "# MCP実験E2E — 「台数を1台減らすと待機時間はどうなる？」",
        "",
        "`tests/test_mcp_lab.py::test_e2e_over_stdio_answers_how_one_fewer_picker_changes_waiting`",
        "を `WHSIM_MCP_E2E_DOC=1` で実行した記録。MCPクライアント（`mcp` SDK）が",
        "`python -m whsim.mcp_server` を stdio で起動し、initialize → tools/list →",
        "`run_scenario` → `apply_diff_and_run` → `compare_runs` → `query_events` を",
        "自動実行している。**以下の数値は全て run成果物からの転記**",
        f"（`{runs_dir}/<run_id>/summary.json`・`events.jsonl`）。",
        "",
        "最後の `query_events` は、比較表に出た待ちのKPIが",
        "**イベントログのどの行から来たか**を件数と合計で示すためのもの",
        "（`congestion_waits` = `aisle_wait` + `aisle_pass_forced` の行数、",
        "`congestion_wait_total_s` = その `wait` の合計）。",
        "",
        "再現:",
        "",
        "```bash",
        ("WHSIM_MCP_E2E_DOC=1 .venv/bin/python -m pytest "
         "tests/test_mcp_lab.py -k e2e -q"),
        "```",
        "",
    ]
    titles = {
        "initialize": "1. 接続（initialize / tools_list）",
        "run_scenario": "2. 基準シナリオを実行（通路干渉ON・ピッカー12名）",
        "apply_diff_and_run": "3. 台数を1台減らして実行（差分実験）",
        "compare_runs": "4. 2runのKPIを比較",
        "query_events": "5. 根拠のイベントログを問い合わせ",
    }
    seen = set()
    for st in steps:
        name = st["call"]
        if name not in seen:
            out += ["## " + titles.get(name, name), ""]
            seen.add(name)
        out += ["リクエスト:", "", "```json",
                json.dumps({"tool": name, "arguments": st["args"]},
                           ensure_ascii=False, indent=2), "```", "",
                "レスポンス:", "", "```json", block(_trim(st["out"])), "```", ""]

    def cell(metric):
        return (metric, disk[base_id][metric], disk[diff_id][metric])

    out += ["## 答え（run成果物からの転記）", "",
            "| 指標 | 基準（12名） | 1台減（11名） | 差 |", "|---|---|---|---|"]
    for m in ("pick_wait_mean_s", "cycle_mean_s", "congestion_waits",
              "congestion_wait_total_s", "completion_rate", "throughput_per_hr"):
        k, a, b = cell(m)
        out.append(f"| {lab.KPI_JP.get(k, k)} | {lab.fmt_num(a)} | {lab.fmt_num(b)} "
                   f"| {lab.fmt_num(b - a)} |")
    pw_a, pw_b = disk[base_id]["pick_wait_mean_s"], disk[diff_id]["pick_wait_mean_s"]
    cw_a, cw_b = disk[base_id]["congestion_waits"], disk[diff_id]["congestion_waits"]
    th_a, th_b = disk[base_id]["throughput_per_hr"], disk[diff_id]["throughput_per_hr"]
    out += ["",
            (f"**待機時間は増える。** ピッキング待ちの平均は {lab.fmt_num(pw_a)} 秒 → "
             f"{lab.fmt_num(pw_b)} 秒（{lab.fmt_num(pw_b - pw_a)} 秒）、通路待ちは "
             f"{lab.fmt_num(cw_a)} 回 → {lab.fmt_num(cw_b)} 回。処理能力は "
             f"{lab.fmt_num(th_a)} → {lab.fmt_num(th_b)} 件/h に落ちる"
             "（同一seed・同一シナリオで台数だけを変えた1本ずつの結果。"
             "ばらつきを見るなら `sweep` で seed を複数振る）。"),
            "",
            (f"出所: `{runs_dir}/{base_id}/summary.json` と "
             f"`{runs_dir}/{diff_id}/summary.json`（どちらも同ディレクトリの "
             "`events.jsonl` を `whsim.kpis` が集計したもの）。"), ""]
    return "\n".join(out) + "\n"


def _trim(out):
    """記録に載せる応答を小さくする（生ログや全KPIは成果物側にある）。"""
    if not isinstance(out, dict):
        return out
    o = dict(out)
    if isinstance(o.get("summary"), dict):
        s = dict(o["summary"])
        kp = s.get("kpis") or {}
        s["kpis"] = {k: kp[k] for k in
                     ("orders_arrived", "orders_completed", "completion_rate",
                      "throughput_per_hr", "cycle_mean_s", "pick_wait_mean_s",
                      "picker_utilization", "congestion_waits",
                      "congestion_wait_total_s", "verdict") if k in kp}
        s["kpis"]["…"] = "（全KPIは summary.json）"
        o["summary"] = s
    return o
