"""レプリケーション集約: 「平均してよい数字」と「平均してはいけない数字」の切り分け。

``kpis.compute`` は全ての数値キーを replication 間で fmean していた。レート・合計・
稼働率・件数はそれで正しいが、**最大値**は違う:

* ``containers_in_use_peak`` は「同時に使った最大数」＝**必要保有数の下限**で、顧客は
  この数字でレンタル数量を決める。5回のピーク [44, 29, 45, 28, 29] を平均した 35 は
  **観測されたどの最大値よりも低い**（-22%）— 甘い方向に外す。
* ``containers_in_use_peak_t`` は「それが起きた時刻」。時刻の平均（36分時点）は
  **どの run でも何も起きていない瞬間**を指す。ピークとその時刻は同じ replication から
  出さなければ対にならない。
* ``wip_max``（仮置きのピーク）・ベルト別 ``peak_occupancy``（満杯になったか）も同型。
  本線が1回でも満杯になった事実は、平均すると 14/20 スロットに化ける。
* ``path_violations`` / ``unroutable_legs`` は欠陥カウンタで、平均は「5回中1回発生」を
  **0件** に丸め、自分の数字と矛盾した警告文を出す。
* ``measured_productivity`` は入れ子 dict なので汎用ループが **replication #1 だけ**を
  残していた（``_merge_per_belt`` が在る理由と同じ罠）。これは 「実測を採用」 →
  productivity_overrides → 原価/人員 へ流れる数字＝1日分の乱数で見積を書いていた。

ここでのテストは全て **合成した RunResult**（イベントを手で書いた run）で、エンジンを
通さない＝手計算で検算でき、他所の変更で揺れない。最後の2本だけ実 DES を通し、
「集約後のピークは各回のピークの最大に一致する」という性質だけを見る。
"""

from __future__ import annotations

import statistics

import numpy as np
import pytest

from whsim import kpis, templates
from whsim.engine.run import RunResult, run_replications


def _rep(events: list[dict], **kw) -> RunResult:
    """A replication that is nothing but its event log (no engine involved)."""
    kw.setdefault("duration_s", 3600.0)
    return RunResult(events=events, heat=np.zeros((2, 2)), n_pickers=1,
                     n_packers=1, **kw)


def _container_rep(peak: int, peak_t: float, *, pool: int = 50) -> RunResult:
    """One run whose container level climbs to exactly ``peak`` at ``peak_t``.

    Takes land one second apart so the last one IS the peak; every container comes
    back afterwards. Hand-checkable: peak == ``peak``, peak time == ``peak_t``.
    """
    ev = [{"event": "container_take", "t": peak_t - (peak - 1 - i), "pool": pool,
           "wait": 0.0} for i in range(peak)]
    ev += [{"event": "container_return", "t": peak_t + 1.0 + i, "held": 10.0}
           for i in range(peak)]
    return _rep(ev)


def _staging_rep(points: list[tuple[float, int]]) -> RunResult:
    return _rep([{"event": "staging_put", "t": t, "wip": w} for t, w in points],
                staging_capacity=20)


def _productivity_rep(lines: int, orders: int) -> RunResult:
    """One run that picked ``lines`` lines and packed ``orders`` orders, each in
    exactly one busy hour ⇒ 実測生産性 = lines 行/h and orders 件/h."""
    ev = [{"event": "pick_done", "t": 10.0, "busy": 3600.0, "lines": lines,
           "dist": 0.0},
          {"event": "pack_done", "t": 20.0, "busy": 3600.0}]
    ev += [{"event": "order_arrive", "t": 1.0}] * orders
    ev += [{"event": "order_complete", "t": 30.0, "cycle": 29.0}] * orders
    return _rep(ev)


def _belt_rep(blocked_at: float | None, *, boardings: int = 10) -> RunResult:
    """A single-belt run; ``blocked_at`` is when the first hand-over had to wait."""
    ev: list[dict] = []
    for i in range(boardings):
        e = {"event": "conveyor_on", "t": 100.0 + i, "conveyor": "T", "wait": 0.0}
        if blocked_at is not None and i == 0:
            e = {"event": "conveyor_on", "t": blocked_at, "conveyor": "T",
                 "wait": 5.0, "blocked": 1}
        ev.append(e)
    ev += [{"event": "conveyor_off", "t": 200.0 + i, "conveyor": "T",
            "transit": 10.0, "last": 1} for i in range(boardings)]
    return _rep(ev, conveyor_capacity=8, n_conveyors=1)


# ------------------------------------------------- ピークは平均ではなく最大


def test_the_container_peak_is_the_largest_peak_seen_not_the_average_of_them():
    """必要保有数の下限を平均すると、観測された最大値より下の数字を売ることになる。"""
    reps = [_container_rep(12, 100.0), _container_rep(20, 900.0),
            _container_rep(9, 300.0)]
    k = kpis.compute(reps)

    assert k["containers_in_use_peak"] == 20.0            # was fmean = 13.67
    assert k["containers_in_use_peak"] == max(
        kpis.compute([r])["containers_in_use_peak"] for r in reps)
    # ...and it is never BELOW a peak that actually happened (the unsafe direction
    # on a rental quantity).
    for r in reps:
        assert k["containers_in_use_peak"] >= kpis.compute([r])["containers_in_use_peak"]


def test_the_moment_comes_from_the_replication_the_peak_came_from():
    """「45個・3060秒時点」は同じ run の事実。時刻だけ平均すると、どの run でも何も
    起きていない瞬間を指す。"""
    reps = [_container_rep(12, 100.0), _container_rep(20, 900.0),
            _container_rep(9, 300.0)]
    k = kpis.compute(reps)

    assert k["containers_in_use_peak_t"] == 900.0         # was fmean = 433.33
    pairs = {(kpis.compute([r])["containers_in_use_peak"],
              kpis.compute([r])["containers_in_use_peak_t"]) for r in reps}
    assert (k["containers_in_use_peak"], k["containers_in_use_peak_t"]) in pairs
    assert k["spread"]["containers_in_use_peak"]["replication"] == 2


def test_a_tie_between_replications_is_resolved_deterministically():
    """同じピークが複数回出たら最初の run を採る（順序に依らない再現性）。"""
    reps = [_container_rep(7, 120.0), _container_rep(7, 800.0)]
    k = kpis.compute(reps)
    assert (k["containers_in_use_peak"], k["containers_in_use_peak_t"]) == (7.0, 120.0)
    assert k["spread"]["containers_in_use_peak"]["replication"] == 1


def test_the_staging_wip_peak_is_a_peak_too():
    """仮置きの山も「何台置けるか」を決める数字なので同じ扱い。"""
    reps = [_staging_rep([(10.0, 3), (20.0, 1)]),
            _staging_rep([(10.0, 9), (20.0, 2)]),
            _staging_rep([(10.0, 4), (20.0, 0)])]
    k = kpis.compute(reps)
    assert k["wip_max"] == 9.0                            # was fmean = 5.33
    assert k["spread"]["wip_max"]["how"] == "max"


def test_a_belt_that_filled_up_in_one_replication_still_reads_as_full():
    """ベルト別 peak_occupancy は「満杯になったか」の答え。平均は満杯を消す。"""
    merged = kpis._merge_per_belt([
        {"T": {"peak_occupancy": 20, "capacity": 20, "boardings": 100,
               "time_to_first_block_s": 60.0}},
        {"T": {"peak_occupancy": 8, "capacity": 20, "boardings": 200,
               "time_to_first_block_s": None}},
    ])
    assert merged["T"]["peak_occupancy"] == 20.0          # was fmean = 14.0
    assert merged["T"]["capacity"] == 20.0
    # everything else keeps averaging (a boarding count is a per-run count)
    assert merged["T"]["boardings"] == pytest.approx(150.0)
    assert merged["T"]["time_to_first_block_s"] == pytest.approx(60.0)


def test_the_per_belt_peak_reaches_the_public_kpis():
    reps = [_belt_rep(None), _belt_rep(None)]
    reps[0].events.append({"event": "conveyor_on", "t": 50.0, "conveyor": "T",
                           "wait": 0.0})   # one extra slot held in rep #1 only
    k = kpis.compute(reps)
    peaks = [kpis.compute([r])["conveyors"]["T"]["peak_occupancy"] for r in reps]
    assert peaks[0] != peaks[1], "the reps must differ or a mean would look right"
    assert k["conveyors"]["T"]["peak_occupancy"] == max(peaks)
    assert k["conveyors"]["T"]["boardings"] == pytest.approx(
        statistics.fmean([11.0, 10.0]))   # a count still averages


# ------------------------------------------- ライン終端の無人 (pack_unmanned)


def _unmanned_rep(stalls: int, *, belt: str = "T") -> RunResult:
    """A belt run where ``stalls`` loads reached the line end and found nobody.

    The engine logs ``pack_unmanned`` and leaves the load standing on the belt
    (it refuses to invent a worker); the KPI layer only has to count it.
    """
    r = _belt_rep(None)
    r.events += [{"event": "pack_unmanned", "t": 300.0 + i, "order_id": f"O{i}",
                  "resource": "packer", "conveyor": belt, "arc": 12.0}
                 for i in range(stalls)]
    return r


def test_an_unmanned_line_end_is_counted_and_the_verdict_names_belt_and_fix():
    """スループット崩壊の理由が「図面の末端に人が居ない」だと読めること。"""
    k = kpis.compute([_unmanned_rep(7)])

    assert k["pack_unmanned_loads"] == 7.0
    assert k["conveyors"]["T"]["unmanned"] == 7.0     # ...and WHICH belt
    v = k["verdict"]
    assert "⚠ ライン終端に梱包台（人）が居ません（ベルトT の終端で 7 件が線上で停止）" in v
    assert "梱包台は全て引き込み/停止線に割り当てられており" in v   # the cause
    assert "停止線／ライン終端に梱包台を描いてください" in v          # the fix


def test_a_line_somebody_stands_at_gains_a_zero_and_not_a_sentence():
    """additive: 誰かが立っている（＝今までの全モデル）なら 0 で、判定文は不変。"""
    k = kpis.compute([_belt_rep(None)])
    assert k["pack_unmanned_loads"] == 0.0
    assert k["conveyors"]["T"]["unmanned"] == 0.0
    assert "ライン終端" not in k["verdict"]


def test_the_unmanned_count_is_a_mean_that_still_says_it_happened():
    """件数なので他のカウンタと同じく平均。ただし平均 0.2 件を「0 件」と書くと、
    それが起きた時だけ出る警告文が自分の数字と矛盾する。"""
    reps = [_belt_rep(None) for _ in range(5)]
    reps[3] = _unmanned_rep(1)
    k = kpis.compute(reps)

    assert k["pack_unmanned_loads"] == pytest.approx(0.2)   # a count → mean
    assert k["spread"]["pack_unmanned_loads"]["how"] == "mean"
    assert k["spread"]["pack_unmanned_loads"]["reps_nonzero"] == 1
    assert "0.2 件が線上で停止・5回中1回で発生" in k["verdict"]
    assert "0 件が線上で停止" not in k["verdict"]


# --------------------------------------------- 欠陥カウンタは 0件 に丸めない


def test_a_violation_that_happened_in_one_run_of_five_never_reads_as_zero():
    """平均 0.2件 は「（0件）」と表示される＝自分の数字と矛盾する警告文になる。"""
    reps = [_rep([]) for _ in range(5)]
    reps[2].path_violations = ["worker#1 leg 3 crosses rack R2"]
    reps[4].unroutable_legs = 3

    k = kpis.compute(reps)
    assert k["path_violations"] == 1.0                    # was fmean = 0.2
    assert k["unroutable_legs"] == 3.0                    # was fmean = 0.6
    assert "経路が棚を貫通しています（1件・5回中1回で発生）" in k["verdict"]
    assert "縮退した移動が 3 件あります（5回中1回で発生・" in k["verdict"]
    assert "（0件" not in k["verdict"]


# --------------------------------------- 入れ子 dict は replication #1 ではない


def test_measured_productivity_is_averaged_not_taken_from_replication_one():
    """「実測を採用」で原価に流れる数字が、5回のうちの1回目だけだった。"""
    reps = [_productivity_rep(lines=100, orders=50),
            _productivity_rep(lines=200, orders=50)]
    k = kpis.compute(reps)
    assert k["measured_productivity"]["ピッキング"] == 150.0   # was 100.0 (rep #1)
    assert k["measured_productivity"]["梱包"] == 50.0
    # A process only one replication could measure is averaged over the reps that
    # measured it, never dropped (never-blocks).
    reps[1].events = [e for e in reps[1].events if e["event"] != "pack_done"]
    assert kpis.compute(reps)["measured_productivity"]["梱包"] == 50.0


# ----------------------------------------------- ばらつきの読み出し (spread)


def test_the_spread_block_says_what_the_headline_number_is():
    reps = [_container_rep(12, 100.0), _container_rep(20, 900.0),
            _container_rep(9, 300.0)]
    k = kpis.compute(reps)
    sp = k["spread"]["containers_in_use_peak"]

    assert sp["how"] == "max"          # ...and not silently an average
    assert sp["value"] == 20.0 == k["containers_in_use_peak"]
    assert (sp["min"], sp["max"]) == (9.0, 20.0)
    assert sp["mean"] == pytest.approx(statistics.fmean([12.0, 20.0, 9.0]))
    assert (sp["n"], sp["n_total"]) == (3, 3)
    assert sp["at_s"] == 900.0 and sp["moment_key"] == "containers_in_use_peak_t"


def test_the_spread_reuses_the_existing_confidence_interval_machinery():
    """CIは既存の ``_confidence_intervals``（同じ t 値・同じ n_recommended）を再利用する
    — ピークの脇に別立ての統計を生やさない。"""
    reps = [_container_rep(12, 100.0), _container_rep(20, 900.0),
            _container_rep(9, 300.0)]
    per = [kpis._one(r) for r in reps]
    k = kpis.compute(reps)

    want = kpis._confidence_intervals(per, keys=("containers_in_use_peak",))
    assert k["spread"]["containers_in_use_peak"]["ci"] == \
        want["metrics"]["containers_in_use_peak"]
    assert want["metrics"]["containers_in_use_peak"]["mean"] == pytest.approx(
        statistics.fmean([12.0, 20.0, 9.0]))
    # the headline CI list is untouched by the extra keys
    assert "containers_in_use_peak" not in kpis.CI_METRICS


def test_the_verdict_states_which_number_the_peak_is():
    """1つの数字が黙って「5回の乱数日の最大」なのは、平均と同じくらい不親切。"""
    reps = [_container_rep(12, 100.0), _container_rep(20, 900.0),
            _container_rep(9, 300.0)]
    v = kpis.compute(reps)["verdict"]
    assert ("容器は同時最大 20 個使用（3回中の最大・15分時点／各回 9〜20 個"
            "・平均 14 個・保有 50 個）") in v


def test_the_first_jam_says_it_is_a_mean_over_the_runs_that_jammed():
    """「最初の詰まり: 30分」は、3回は詰まらず1回が10分で詰まった run でも出ていた。"""
    reps = [_belt_rep(600.0), _belt_rep(1800.0), _belt_rep(None)]
    k = kpis.compute(reps)
    assert k["conveyor_time_to_first_block_s"] == pytest.approx(1200.0)
    assert "最初の詰まり: 平均20分・最早10分・3回中2回" in k["verdict"]
    sp = k["spread"]["conveyor_time_to_first_block_s"]
    assert sp["how"] == "mean" and sp["n"] == 2 and sp["n_total"] == 3


# ------------------------------------------------- n=1 は 1バイトも動かない


def test_a_single_replication_reports_exactly_what_that_run_measured():
    """既定は 1 replication（``simulation.replications``）＝ほぼ全ての実行がこの経路。
    ピークもその時刻も、平均も最大も同じ1標本なので、出力は従来と完全に一致する。"""
    rep = _container_rep(12, 100.0)
    one = kpis.compute([rep])

    assert one["containers_in_use_peak"] == 12.0
    assert isinstance(one["containers_in_use_peak"], float)   # fmean returned float
    assert one["containers_in_use_peak_t"] == 100.0
    assert "容器は同時最大 12 個使用（2分時点・保有 50 個）" in one["verdict"]
    # ...and the spread block does not exist: there is no spread in one sample, and
    # a new key would change the single-run payload that is pinned elsewhere.
    assert "spread" not in one
    assert set(one) - set(kpis._one(rep)) == {
        "replications", "n_pickers", "n_packers", "bottleneck",
        "bottleneck_utilization", "bottleneck_jp", "robustness", "throughput_p5",
        "throughput_p95", "throughput_std", "completion_p5", "ci",
        "can_handle_demand", "verdict"}


def test_single_replication_defect_and_belt_read_outs_are_unchanged():
    rep = _rep([])
    rep.path_violations = ["worker#1 leg 3 crosses rack R2", "worker#2 leg 9"]
    rep.unroutable_legs = 7
    v = kpis.compute([rep])["verdict"]
    assert "。⚠ 経路が棚を貫通しています（2件）— レイアウトの棚定義を確認してください" in v
    assert ("縮退した移動が 7 件あります"
            "（取込レイアウトの通路が塞がっていないか確認してください）") in v

    single = kpis.compute([_belt_rep(600.0)])
    assert "最初の詰まり: 10分" in single["verdict"]      # no 平均/最早 wording at n=1
    assert single["conveyors"]["T"]["peak_occupancy"] == \
        kpis._one(_belt_rep(600.0))["conveyors"]["T"]["peak_occupancy"]


# ------------------------------------------------------------- 実 DES で確認


def test_the_engine_path_agrees_with_the_per_replication_peaks():
    """合成ログではなく本物の run で: 集約ピークは各回のピークの最大そのもの。"""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 900.0
    results, _heat = run_replications(m, reps=3)
    agg = kpis.compute(results, m)

    for key in ("containers_in_use_peak", "wip_max", "path_violations",
                "unroutable_legs"):
        per_rep = [kpis.compute([r], m)[key] for r in results]
        assert agg[key] == max(per_rep), key
        assert agg["spread"][key]["n_total"] == 3
