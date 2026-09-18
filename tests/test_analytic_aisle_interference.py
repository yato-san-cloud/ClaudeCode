"""通路干渉とルーティング方式 — 鏡写すもの、鏡写さないと決めたもの。

不変条件5 は「エンジンが持つ機構は解析にも持て、さもなくばオラクルは黙って
甘い話をする」。エンジンには解析が映していない機構が2つ残っていた。片方は
**映す**、もう片方は**測った上で映さないと決めた** — この2つは同じ扱いを受ける
べきではない、というのがここのテストの主張である。

* **通路干渉** (`simulation.aisle_interference`) は映す。ただし予測ではなく
  **上界**として。同速の追従は自己消滅する（一度待てば以後は1セル後ろを付いて
  行くだけ）ので、M/M/1 が1セルごとに課す待ちをエンジンは遭遇ごとに1回しか
  払わない。実測で 9.1〜23.0倍 甘くない側に外れる。秒では緩いが、真の効果が
  歩行時間の 0.03〜0.17% なので**稼働率としては丁度**（DES自身の揺れと同じ桁）。
* **非既定ルーティング** (`process.routing_policy`) は映さない。DES自身の感度が
  9テンプレ中7で歩行の1.5%以下・稼働率で0.013以下（一致ピンの6分の1）で、
  エンジン自身の `route_order` から組んだ閉形式は**オラクルを悪化させ、しかも
  甘い側へ倒した**（平均誤差 6.8%→10.0%、最大 15.5%→31.0%）。代わりに
  「これは最近傍巡回の数字だ」と**名乗る**。名乗りが嘘になったら 10番目の
  テストが落ちる。
"""

from __future__ import annotations

import pytest

from whsim import analytic, kpis, templates
from whsim.engine.run import run_once
from whsim.schema.model import WarehouseModel

ALL_TEMPLATES = [t["template_id"] for t in templates.list_templates()]
RACKED = [t for t in ALL_TEMPLATES if t not in ("blank",)]


def _on(model):
    model.simulation.aisle_interference = True
    return model


# ------------------------------------------------------------ 既定OFF＝不活性

@pytest.mark.parametrize("template_id", ALL_TEMPLATES)
def test_the_catalogue_is_untouched_by_the_interference_bound(template_id):
    """同梱テンプレートは全部OFF ⇒ キー1つ増える以外は完全に同じ答え。"""
    m = templates.load_template_model(template_id)
    assert m.simulation.aisle_interference is False
    est = analytic.estimate(m)
    assert est["aisle_congestion"] is None
    assert analytic._aisle_congestion(m, None, 10.0, 1.0, 1.0) is None


def test_the_bound_is_inert_before_it_reads_anything():
    """OFF の判定が最初の文である＝幾何も需要も読まない（構造的に不活性）。"""
    m = WarehouseModel()
    assert analytic._aisle_congestion(m, None, 0.0, 0.0, 0.0) is None
    m.simulation.aisle_interference = True
    # ...and with the flag on but nothing to walk, still nothing (GTP walks 0 m).
    assert analytic._aisle_congestion(m, None, 0.0, 1.0, 1.0) is None
    assert analytic._aisle_congestion(m, None, 10.0, 0.0, 1.0) is None


# --------------------------------------------------- 甘くない側であること

@pytest.mark.parametrize("template_id", ["ecommerce_small", "apparel", "retail_dc"])
def test_the_bound_is_never_rosier_than_the_run(template_id):
    """不変条件5の向きの検査 — これは落ちうるテストでなければ意味がない。

    エンジンが実際に払った**ピッカーの**待ち（`aisle_wait`/`aisle_pass_forced`）
    の合計を、閉形式の上界が上回ること。フォークリフトの待ちは解析が課していない
    ので比較から外す（§弱点: 床全体の混雑はこの上界では読めない）。
    """
    m = _on(templates.load_template_model(template_id))
    m.simulation.replications = 1
    res = run_once(m, seed=5)
    measured = sum(
        float(e.get("wait", 0.0)) for e in res.events
        if e["event"] in ("aisle_wait", "aisle_pass_forced")
        and str(e.get("worker", "")).startswith("picker"))
    est = analytic.estimate(m)
    band = est["aisle_congestion"]
    assert band is not None and band["bound"] == "upper"
    k = kpis.compute([res], m)
    bound_total = band["wait_s_per_order_bound"] * max(k["orders_completed"], 1.0)
    assert bound_total >= measured, (bound_total, measured)


def test_interference_costs_time_not_metres():
    """歩く距離は1mも変わらない — エンジンも `walk_total_m` をそう固定している。"""
    off = templates.load_template_model("ecommerce_small")
    on = _on(templates.load_template_model("ecommerce_small"))
    a, b = analytic.estimate(off), analytic.estimate(on)
    assert a["walk_m_per_order"] == b["walk_m_per_order"]
    assert b["service_time_s"] > a["service_time_s"]
    assert b["picker_utilization"] >= a["picker_utilization"]


def test_the_bound_grows_with_density_and_is_capped():
    m = _on(templates.load_template_model("ecommerce_small"))
    seen = []
    for f in (1, 2, 4, 8, 64):
        m.orders.profile.rate_per_hr = 120.0 * f
        band = analytic.estimate(m)["aisle_congestion"]
        seen.append(band["cell_utilization"])
    assert seen == sorted(seen), seen
    assert seen[-1] <= analytic._AISLE_RHO_CAP + 1e-12
    assert all(v < 1.0 for v in seen)


def test_a_one_aisle_floor_does_not_saturate_the_bound():
    """縮退した幾何でセル数が0に潰れると上界が発散する ⇒ 外周一周を下限に置く。"""
    m = _on(templates.load_template_model("ecommerce_small"))
    band = analytic._aisle_congestion(m, None, 50.0, 0.05, 1.2)   # det=None
    assert band is not None and band["cell_utilization"] < analytic._AISLE_RHO_CAP


def test_gtp_pays_no_aisle_wait():
    """AGVは `_walk` を通らない。AGV同士の干渉は `process.agv_interference` で、
    これは**まだ別の未鏡写しの穴**（ここでは扱わない）。"""
    m = _on(templates.load_template_model("ecommerce_xl"))
    est = analytic.estimate(m)
    assert est["walk_m_per_order"] == 0.0
    assert est["aisle_congestion"] is None


@pytest.mark.parametrize("template_id", RACKED)
def test_the_bound_never_blocks(template_id):
    m = _on(templates.load_template_model(template_id))
    est = analytic.estimate(m)
    band = est["aisle_congestion"]
    if band is not None:
        assert 0.0 <= band["cell_utilization"] < 1.0
        assert band["wait_s_per_order_bound"] >= 0.0
        assert 0.0 <= band["wait_share_bound"] < 1.0


def test_the_catalogue_still_agrees_with_the_des_with_interference_on():
    """一致ピン（|Δ稼働率| < 0.08）は機構ONでも保つ。"""
    for template_id in ("ecommerce_small", "apparel", "manufacturing_parts"):
        m = _on(templates.load_template_model(template_id))
        m.simulation.replications = 1
        sim = kpis.compute([run_once(m, seed=5)], m)
        est = analytic.estimate(m)
        assert abs(est["picker_utilization"] - sim["picker_utilization"]) < 0.08, \
            (template_id, est["picker_utilization"], sim["picker_utilization"])


# ------------------------------------- ルーティング: 映さないと決めた、と名乗る

def test_routing_policy_is_disclosed_not_mirrored():
    m = templates.load_template_model("ecommerce_small")
    est = analytic.estimate(m)
    assert est["routing_policy"] == "nearest"
    assert est["routing_policy_mirrored"] is True

    m.process.routing_policy = "s_shape"
    est = analytic.estimate(m)
    assert est["routing_policy"] == "s_shape"
    assert est["routing_policy_mirrored"] is False, \
        "最近傍の数字を方式込みの数字と誤読させない"


def test_two_shipped_templates_already_run_a_non_default_policy():
    """この穴はカタログの中で**既に生きている** — 「既定nearestだから無害」は誤り。"""
    got = {t: templates.load_template_model(t).process.routing_policy
           for t in ALL_TEMPLATES}
    assert got["apparel"] == "s_shape"
    assert got["food_chilled"] == "return"
    assert not analytic.estimate(
        templates.load_template_model("apparel"))["routing_policy_mirrored"]


@pytest.mark.parametrize("template_id", ["ecommerce_small", "apparel", "food_chilled"])
def test_the_des_walk_is_insensitive_to_routing_policy(template_id):
    """映さない判断の**根拠**そのもの。ここが破れたら判断を見直すこと。

    実測: 歩行の広がりは9テンプレ中7で1.5%以下（最悪 retail_dc の12%）、稼働率の
    広がりは全テンプレで0.013以下＝一致ピン0.08の6分の1。だから最近傍の数字を
    そのまま出しても、判定もボトルネックも動かない。
    """
    walks, utils = [], []
    for policy in ("nearest", "s_shape", "return", "largest_gap"):
        m = templates.load_template_model(template_id)
        m.process.routing_policy = policy
        m.simulation.replications = 1
        k = kpis.compute([run_once(m, seed=5)], m)
        walks.append(k["walk_per_order_m"])
        utils.append(k["picker_utilization"])
    lo, hi = min(walks), max(walks)
    assert (hi - lo) / max(hi, 1e-9) < 0.15, walks
    assert max(utils) - min(utils) < 0.03, utils


def test_routecompare_is_not_on_the_analytic_path():
    """爆速の予算は50ms、`routecompare` は最小標本でも 95ms〜3.8s。配線禁止。"""
    import sys

    sys.modules.pop("whsim.routecompare", None)
    analytic.estimate(templates.load_template_model("retail_dc"))
    assert "whsim.routecompare" not in sys.modules
