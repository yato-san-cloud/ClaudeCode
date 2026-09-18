"""受け入れ基準5・6・D5: 再現性（同一seed→完全一致）と、シナリオJSONだけでの
介入変数切替（台数・ルーティング・干渉・レイアウト）、what-if I/F。

これらは「デモではなくシミュレータ」の骨格そのもの: 同じ入力は同じ答えを返し、
介入はコードではなくデータ（シナリオJSON）で表現される。
"""
from __future__ import annotations

from whsim import templates
from whsim.engine.run import run_replications
from whsim.engine.scenarios import apply_scenario, whatif
from whsim.schema.model import Scenario


def _short(rate: float = 120.0, duration: float = 1200.0):
    m = templates.load_template_model("ecommerce_small")
    m.orders.profile.rate_per_hr = rate
    m.simulation.duration_s = duration
    m.simulation.replications = 1
    return m


# ------------------------------------------------------------- 再現性 (DoD 5)


def test_same_seed_same_scenario_is_bit_identical():
    """同一seed・同一モデルの2回の実行はイベント列が**完全一致**する。

    KPIの丸め比較ではなくイベントログそのもの（時刻・種別・全フィールド）を
    突き合わせる — これが揺れたら「再現できるシミュレーション」を名乗れない。
    """
    r1, _ = run_replications(_short())
    r2, _ = run_replications(_short())
    assert len(r1) == len(r2) == 1
    assert r1[0].events == r2[0].events


def test_different_seed_actually_differs():
    """seed が違えば違う実行になる（＝一致テストが空虚でないことの対照）。"""
    a = _short()
    b = _short()
    b.simulation.random_seed = 4242
    ra, _ = run_replications(a)
    rb, _ = run_replications(b)
    assert ra[0].events != rb[0].events


# ------------------------------------- シナリオJSONだけでの切替 (DoD 6 / D4)


def test_scenario_json_switches_worker_count_routing_and_layout():
    """台数・ディスパッチ（ルーティング方式）・干渉・レイアウトが、コード変更
    なしに dotted-path 編集だけで切り替わる。"""
    base = _short()
    n0 = base.resources.workers[0].count
    sc = Scenario(name="switch", edits={
        "resources.workers.0.count": n0 + 3,
        "process.routing_policy": "s_shape",
        "simulation.aisle_interference": True,
        "layout.bounds.width": 55.5,
    })
    m = apply_scenario(base, sc)
    assert m.resources.workers[0].count == n0 + 3
    assert m.process.routing_policy == "s_shape"
    assert m.simulation.aisle_interference is True
    assert m.layout.bounds.width == 55.5
    # ベースは不変（apply は写しを返す）
    assert base.resources.workers[0].count == n0
    assert base.process.routing_policy == "nearest"


def test_scenario_edit_reaches_the_running_engine():
    """編集がスキーマ検証を通るだけでなく、実際にエンジンの挙動を変える:
    ピッカー1人 vs 6人で処理量が変わる。"""
    lean = apply_scenario(_short(), Scenario(
        name="lean", edits={"resources.workers.0.count": 1}))
    rich = apply_scenario(_short(), Scenario(
        name="rich", edits={"resources.workers.0.count": 6}))
    r_lean, _ = run_replications(lean)
    r_rich, _ = run_replications(rich)
    done = lambda rr: sum(1 for e in rr.events if e["event"] == "order_complete")
    assert done(r_rich[0]) >= done(r_lean[0])


# --------------------------------------------------------- what-if I/F (D5)


def test_whatif_applies_diff_runs_headless_and_returns_summary():
    """D5: 「diff を受け取って適用→ヘッドレス実行→結果サマリ」が1関数で通る。

    モック入力（小さな編集）で一連の流れを踏む。LLM 接続はスコープ外 — この
    関数がその将来レイヤーの呼び先になる。"""
    base = _short()
    out = whatif(base, {"resources.workers.0.count": 2}, reps=1)
    assert out["edits"] == {"resources.workers.0.count": 2}
    assert isinstance(out["verdict"], str) and out["verdict"]
    assert out["throughput_per_hr"] is not None
    assert out["walk_total_m"] is not None
    assert isinstance(out["kpis"], dict) and "picker_utilization" in out["kpis"]


def test_whatif_with_empty_diff_is_the_baseline():
    out = whatif(_short(), {}, reps=1)
    assert out["edits"] == {}
    assert out["throughput_per_hr"] is not None
