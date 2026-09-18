"""AGV同士の通路干渉 — **測った上で鏡写さないと決めた**。名乗るだけ。

`CLAUDE.md` は長らく「AGV同士の干渉は未鏡写し」とだけ書いていた。歩行側の同じ機構
(`simulation.aisle_interference`) は `analytic._aisle_congestion` が**上界**として
映せているので、同じ形が AGV にも効くのかを**実装して測った**。効かなかった。
このファイルはその測定を残す——「やってみたが駄目だった」を残さないと、いずれ誰かが
安く見える同じ式を足す（窓の割合の件と同じ）。

**棄却①: セル1つ＝M/M/1（歩行側と同型）**
    ρ = A/N_seg（Little）、待ち = 走行時間 × ρ/(1−ρ)。ピッチが約分で消えるところ
    まで歩行側と同じ。実測は**逆向きに外れる**: 上界/実測 = 0.055〜0.17（合成の
    一本廊下 12構成 ＋ racked GTP 15構成）。**実測の待ちの 1/6〜1/18 しか言えて
    いない上界は上界ではない。**

**なぜ同型にならないか**（歩行側の導出の前提が2つとも崩れる）
    1. 歩行側は「同速の追従は自己消滅する——一度待てば以後は1セル後ろを付いて行く
       だけ」で緩い側に倒れていた。AGV のロックは `_agv_seg_key` の通り**コーナー間の
       レグ丸ごと**を保持するので、後続は1セルではなく**レグ1本分**待たされ、待ちは
       消滅せず**直列化する**。
    2. 歩行側のセルは格子なので床全体に一様に散る。AGV の鍵はレグ中点の量子化なので
       通路1本の交通が数個の鍵に集中し、床の平均 ρ（実測 0.002〜0.03）はホットな鍵の
       ρ（ほぼ1）と2桁違う。**どれが熱いかは経路探索でしか分からず**、この
       モジュールは 50ms 予算で経路探索をしない。

**棄却②: 逆の極——全レグが共有廊下（完全直列化）**
    台数に依らず `1/trip_s` で頭打ちという上界。`ecommerce_xl` で 19.9件/h と読む
    一方、実測は 124〜379件/h＝**6〜19倍 辛い**。答えを破壊するので使えない。

一様分散は10倍甘く、完全直列化は6〜19倍辛い。間のどこかは**経路の形**で決まる。
だから `routing_policy` と同じ扱いにする: **名乗る**。
"""

from __future__ import annotations

import pytest

from whsim import analytic, kpis, templates
from whsim.engine.run import run_once

ALL_TEMPLATES = [t["template_id"] for t in templates.list_templates()]
TRIP_S = 181.3          # ecommerce_xl の自由走行 1 トリップ (解析の読み)


def _xl(n_agvs, rate, duration=1800.0, on=True):
    m = templates.load_template_model("ecommerce_xl")
    m.simulation.duration_s = duration
    m.simulation.replications = 1
    m.process.agv_interference = on
    for e in m.resources.equipment:
        if e.type == "agv":
            e.count = n_agvs
    m.orders.profile.rate_per_hr = rate
    return m


def _rejected_bound_s(est, trips):
    """棄却された「セル1つ＝M/M/1」の上界を、開示された ρ から組み直す。"""
    rho = est["agv_interference"]["segment_utilization_mean"]
    return rho / (1.0 - rho) * TRIP_S * trips


# ------------------------------------------------------ 既定OFF＝カタログ不変

@pytest.mark.parametrize("template_id", ALL_TEMPLATES)
def test_the_catalogue_leaves_it_off_and_the_key_never_appears(template_id):
    """同梱テンプレは全部OFF ⇒ キーごと出ない（＝答えはJSONまでバイト同一）。"""
    m = templates.load_template_model(template_id)
    assert m.process.agv_interference is False
    assert "agv_interference" not in analytic.estimate(m)


def test_turning_it_on_adds_one_key_and_moves_no_number():
    """名乗るだけ＝他のキーは1つも動かない（開示は主張ではない）。"""
    off, on = _xl(8, 200.0, on=False), _xl(8, 200.0, on=True)
    a, b = analytic.estimate(off), analytic.estimate(on)
    assert "agv_interference" not in a
    assert b.pop("agv_interference")["mirrored"] is False
    assert a == b


def test_the_disclosure_appears_exactly_where_the_engine_wires_the_locks():
    """``build`` は「フラグON かつ グラフ有効 かつ AGV>1」でしかロックを張らない。

    1台では自分と干渉しないので engine は ``aisle_locks`` を張らない — 解析が
    そこで何か名乗ると、走らせても何も起きない機構を名乗ることになる。
    """
    from whsim.engine.build import build

    for n in (1, 2, 8):
        m = _xl(n, 200.0)
        world = build(m)
        est = analytic.estimate(m)
        assert (world.aisle_locks is not None) is ("agv_interference" in est), n
    # GTP でない（＝AGVが働かない）図面には出ない
    manual = templates.load_template_model("ecommerce_small")
    manual.process.agv_interference = True
    assert "agv_interference" not in analytic.estimate(manual)


def test_the_segment_size_matches_the_engines_own_quantiser():
    """不変条件11: 3m という数はエンジンの ``_agv_seg_key`` から測り直して固定する。

    定数を写した以上、ずれたら落ちなければならない（写しの parity テスト）。
    """
    from whsim.engine.processes import _agv_seg_key

    base = _agv_seg_key((0.0, 0.0), (0.0, 0.0))
    step, m = 0.01, 0.0
    while m < 20.0:
        m += step
        if _agv_seg_key((m, 0.0), (m, 0.0)) != base:
            break
    assert analytic._AGV_SEG_M == pytest.approx(2.0 * m, abs=2 * step)


# ------------------------------- 棄却①: 歩行側と同型の上界は上界ではなかった

@pytest.mark.parametrize("n_agvs,rate", [(8, 200.0), (16, 200.0)])
def test_the_walking_mirrors_shape_was_measured_on_agvs_and_is_not_a_bound(
        n_agvs, rate):
    """再導入を防ぐための計測——落ちうるテストでなければ意味がない。

    セル1つ＝M/M/1 の待ちは、実測のAGV通路待ちの **2割にも満たない**。上界と称して
    これを足すと、船団が渋滞しているのに「ほとんど待っていない」と言うことになる。
    """
    m = _xl(n_agvs, rate)
    est = analytic.estimate(m)
    res = run_once(m, seed=3)
    k = kpis.compute([res], m)
    trips = len([e for e in res.events if e["event"] == "agv_done"])
    measured = k["agv_wait_s"]
    assert measured > 0.0 and trips > 0
    bound = _rejected_bound_s(est, trips)
    assert bound < 0.2 * measured, (bound, measured)
    # 開示された ρ は床の平均であって、熱い鍵の ρ ではない
    assert est["agv_interference"]["segment_utilization_mean"] < 0.05


def test_the_rejected_bound_is_disclosed_but_never_multiplied_into_anything():
    """ρ は**開示**であって能力にも稼働率にも掛かっていない。"""
    m = _xl(16, 600.0)
    est = analytic.estimate(m)
    free = analytic.estimate(_xl(16, 600.0, on=False))
    for key in ("agv_utilization", "service_time_s", "picker_utilization",
                "capacity_orders_per_hr", "bottleneck_utilization"):
        assert est[key] == free[key], key


# ------------------------------- 棄却②: 逆の極（完全直列化）は答えを破壊する

@pytest.mark.parametrize("n_agvs,rate", [(8, 200.0), (16, 200.0)])
def test_full_serialisation_is_a_bound_and_destroys_the_answer(n_agvs, rate):
    """「全レグが共有廊下」なら台数に依らず 1/trip_s。上界ではあるが使えない。"""
    m = _xl(n_agvs, rate)
    k = kpis.compute([run_once(m, seed=3)], m)
    serial_per_hr = 3600.0 / TRIP_S
    assert serial_per_hr < k["throughput_per_hr"] / 3.0, (
        serial_per_hr, k["throughput_per_hr"])


# --------------------------------------- 名乗るなら、何を言っていないかも言う

def test_the_disclosure_says_it_is_not_mirrored_and_carries_the_measured_band():
    m = _xl(8, 200.0)
    band = analytic.estimate(m)["agv_interference"]
    assert band["mirrored"] is False
    assert band["fleet"] == 8
    lo, hi = band["measured_wait_share_of_busy"]
    assert 0.0 < lo < hi < 1.0
    dlo, dhi = band["measured_utilization_delta"]
    assert dlo < 0.0 < dhi
    # 実測した稼働率の動きは一致ピン (0.08) の内側 — だから「名乗る」で足りる
    assert max(abs(dlo), abs(dhi)) < 0.08
    tlo, thi = band["measured_throughput_delta"]
    assert tlo < thi < 0.0, "能力側は必ず落ちる (そこは映していない)"


@pytest.mark.parametrize("n_agvs", [8, 16, 32])
def test_the_free_flow_fleet_reading_was_not_rosier_than_the_run(n_agvs):
    """⚠️ **測っただけで証明ではない**、が向きは確かめておく。

    干渉を映さない以上、`agv_utilization` は自由走行の読みのままである。実測
    (15構成) ではそれが DES の `agv_utilization` を一度も下回らなかった——最小
    マージン +0.005。ここが破れたら「名乗るだけ」では足りないということなので、
    判断を見直すこと。
    """
    m = _xl(n_agvs, 200.0)
    est = analytic.estimate(m)
    k = kpis.compute([run_once(m, seed=3)], m)
    assert est["agv_utilization"] >= k["agv_utilization"] - 1e-9, (
        est["agv_utilization"], k["agv_utilization"])


def test_the_interference_really_does_cost_the_run_something():
    """映していない差が**実在する**ことの確認（無害だから映さない、ではない）。"""
    on, off = _xl(16, 600.0), _xl(16, 600.0, on=False)
    k_on = kpis.compute([run_once(on, seed=3)], on)
    k_off = kpis.compute([run_once(off, seed=3)], off)
    assert k_on["agv_wait_s"] > 0.0 and k_off["agv_wait_s"] == 0.0
    assert k_on["throughput_per_hr"] < k_off["throughput_per_hr"]
    # …そして稼働率の差は一致ピンの内側にとどまる (名乗りで足りる根拠)
    assert abs(k_on["agv_utilization"] - k_off["agv_utilization"]) < 0.08


def test_the_disclosure_never_blocks_on_a_degenerate_floor():
    m = _xl(4, 200.0)
    m.layout.bounds.width = m.layout.bounds.depth = 0.0
    band = analytic._agv_interference(m, None, 10.0, 0.1, 1.6, 4)
    assert band is not None and band["segments"] >= 1.0
    assert 0.0 <= band["segment_utilization_mean"]
    assert analytic._agv_interference(m, None, 0.0, 0.1, 1.6, 4) is None
    assert analytic._agv_interference(m, None, 10.0, 0.0, 1.6, 4) is None
    assert analytic._agv_interference(m, None, 10.0, 0.1, 1.6, 1) is None


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
