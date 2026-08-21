"""在庫最適化 (安全在庫・発注点) — 理論の逐条テスト。

需要 σ を出荷実績から直接求め、正規近似の安全在庫と、低頻度品のポアソン切替を
教科書どおりに計算する。ハンドチェック値をコメントに明記して検算する:

  * 正規: 系列 [5,5,5,5,15,15,15,15] (8日) → μ=10, σ=5(母標準偏差)。
      SS = z·σ·√(LT+R) = 1.645·5·√3 = 14.246…,  ROP = μ·LT + SS = 30 + 14.246 = 44.246。
  * ポアソン: λ=2, SL=0.95 → Poisson CDF は
      P(≤4)=0.9473 < 0.95 ≤ 0.9834=P(≤5)  ⇒ S=5,  SS = S−λ = 3。
  * ゼロ需要日: [10,0,0,10] (4日スパン) → μ=5, σ=5 (ゼロ日を含めるから σ>0)。
"""

import math

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from whsim.analysis import inventoryopt as io
from whsim.web.app import app


# ── ポアソン CDF の単体検算 (scipy 不使用の反復実装) ────────────────────────
def test_poisson_reorder_level_hand_check():
    # λ=2: 累積は P(≤4)=0.9473, P(≤5)=0.9834。
    assert io.poisson_reorder_level(2.0, 0.95) == 5     # P(≤4)=0.9473, P(≤5)=0.9834
    assert io.poisson_reorder_level(2.0, 0.90) == 4     # P(≤4)=0.9473 ≥ 0.90
    assert io.poisson_reorder_level(2.0, 0.99) == 6     # P(≤5)=0.9834, P(≤6)=0.9955
    assert io.poisson_reorder_level(2.0, 0.999) == 8    # P(≤7)=0.99890, P(≤8)=0.99976
    assert io.poisson_reorder_level(0.0, 0.95) == 0     # λ=0 は全質量が 0


def test_z_table_matches_spec():
    assert io.z_for(0.90) == 1.282
    assert io.z_for(0.95) == 1.645
    assert io.z_for(0.975) == 1.960
    assert io.z_for(0.99) == 2.326
    assert io.z_for(0.999) == 3.090


# ── 正規モデルのハンドチェック ────────────────────────────────────────────
def test_normal_case_exact_ss_and_rop():
    # 8 日連続、各日 [5,5,5,5,15,15,15,15]。ゼロ日なし。
    dates = pd.date_range("2025-01-01", periods=8, freq="D")
    df = pd.DataFrame({"date": list(dates), "sku": ["A"] * 8,
                       "qty": [5, 5, 5, 5, 15, 15, 15, 15]})
    res = io.analyze(df, lead_time_days=3.0, review_days=0.0, service_level=0.95)
    assert res["available"] is True
    row = res["rows"][0]
    assert row["sku"] == "A"
    assert row["model"] == "normal"           # λ = 10·3 = 30 ≥ 10 → 正規
    assert row["mu_d"] == 10.0
    assert row["sigma_d"] == 5.0              # 母標準偏差 √(400/8·... )=5
    assert row["days_observed"] == 8

    ss = 1.645 * 5.0 * math.sqrt(3.0)          # = 14.246…
    assert row["safety_stock"] == round(ss, 1)         # 14.2
    assert row["rop"] == round(10.0 * 3.0 + ss, 1)     # 44.2
    # R=0 なので 目標在庫 == ROP。
    assert row["target_level"] == row["rop"]
    assert res["totals"]["total_safety_stock"] == round(ss, 1)
    assert res["totals"]["skus"] == 1
    assert res["totals"]["service_level"] == 0.95
    assert res["totals"]["z"] == 1.645
    assert res["totals"]["params"] == {"lead_time_days": 3.0, "review_days": 0.0,
                                        "service_level": 0.95}
    assert "理論値" in res["note"] and "乖離" in res["note"]   # 正直な注記


def test_review_period_raises_safety_stock_and_target():
    # 発注間隔 R>0 は exposure=LT+R を増やすので SS も 目標在庫 も増える。
    dates = pd.date_range("2025-01-01", periods=8, freq="D")
    df = pd.DataFrame({"date": list(dates), "sku": ["A"] * 8,
                       "qty": [5, 5, 5, 5, 15, 15, 15, 15]})
    r0 = io.analyze(df, lead_time_days=3.0, review_days=0.0, service_level=0.95)["rows"][0]
    r7 = io.analyze(df, lead_time_days=3.0, review_days=7.0, service_level=0.95)["rows"][0]
    assert r7["safety_stock"] > r0["safety_stock"]
    # 目標在庫 = μ·(LT+R) + SS = 10·10 + 1.645·5·√10
    exp = 10.0 * 10.0 + 1.645 * 5.0 * math.sqrt(10.0)
    assert r7["target_level"] == round(exp, 1)


# ── ポアソン (低頻度品) のハンドチェック ──────────────────────────────────
def test_poisson_slow_mover_case():
    # μ=0.5/日 (5個 / 10日スパン)。LT=4 → λ=μ·LT=2 < 10 → ポアソン。
    df = pd.DataFrame({
        "date": pd.to_datetime(["2025-02-01", "2025-02-04", "2025-02-06",
                                "2025-02-08", "2025-02-10"]),
        "sku": ["B"] * 5, "qty": [1, 1, 1, 1, 1]})
    res = io.analyze(df, lead_time_days=4.0, review_days=0.0, service_level=0.95)
    row = res["rows"][0]
    assert row["model"] == "poisson"
    assert row["days_observed"] == 10
    assert row["mu_d"] == 0.5
    # S=5, SS = 5 − λ(=2) = 3, ROP = μ·LT + SS = 2 + 3 = 5 (= S)。
    assert row["safety_stock"] == 3.0
    assert row["rop"] == 5.0
    assert row["target_level"] == 5.0


def test_poisson_threshold_switch_is_marked():
    # 同じ SKU でも LT を上げて λ≥10 にすると正規に切り替わる (境界の明示)。
    df = pd.DataFrame({
        "date": pd.to_datetime(["2025-02-01", "2025-02-04", "2025-02-06",
                                "2025-02-08", "2025-02-10"]),
        "sku": ["B"] * 5, "qty": [1, 1, 1, 1, 1]})
    slow = io.analyze(df, lead_time_days=4.0)["rows"][0]     # λ=2  → poisson
    fast = io.analyze(df, lead_time_days=40.0)["rows"][0]    # λ=20 → normal
    assert slow["model"] == "poisson"
    assert fast["model"] == "normal"


# ── ゼロ需要日を含める効果 (σ に効く) ─────────────────────────────────────
def test_zero_demand_days_included_in_sigma():
    # SKU は 4 日スパンの端 2 日だけ出荷 (day1, day4)。系列 = [10,0,0,10]。
    df = pd.DataFrame({"date": pd.to_datetime(["2025-03-01", "2025-03-04"]),
                       "sku": ["C", "C"], "qty": [10, 10]})
    row = io.analyze(df, lead_time_days=3.0, service_level=0.95)["rows"][0]
    assert row["days_observed"] == 4          # 観測スパンは 4 日 (途中 2 日はゼロ)
    assert row["mu_d"] == 5.0                  # 20 / 4 (ゼロ日を含めた平均)
    assert row["sigma_d"] == 5.0               # ゼロ日を含めるから σ>0
    # ゼロ日を無視すると μ=10, σ=0 になってしまう — それとの差が本テストの主眼。


def test_totals_sum_over_all_skus_and_truncation(monkeypatch):
    dates = pd.date_range("2025-01-01", periods=6, freq="D")
    frames = []
    for i, vol in enumerate([300, 200, 100]):          # 3 SKU、物量の降順で並ぶ
        frames.append(pd.DataFrame({"date": list(dates), "sku": [f"S{i}"] * 6,
                                     "qty": [vol // 6] * 6}))
    df = pd.concat(frames, ignore_index=True)
    monkeypatch.setattr(io, "MAX_ROWS", 2)             # BI ツール流の打ち切りを検証
    res = io.analyze(df, lead_time_days=3.0)
    assert res["truncated"] is True
    assert len(res["rows"]) == 2                        # 返すのは上位 2 SKU
    assert res["totals"]["skus"] == 3                   # 合計は全 3 SKU で計算
    # 合計安全在庫は返した 2 行の和より大きい (3 番目も含むから)。
    assert res["totals"]["total_safety_stock"] >= sum(r["safety_stock"] for r in res["rows"])
    # 物量降順で返る。
    assert res["rows"][0]["total_qty"] >= res["rows"][1]["total_qty"]


# ── never-blocks (空・列欠落・日付なし) ──────────────────────────────────
def test_never_blocks_on_empty_or_missing_columns():
    for bad in (None, pd.DataFrame(), pd.DataFrame({"sku": ["x"], "qty": [3]})):
        res = io.analyze(bad)
        assert res["available"] is False
        assert "message" in res


# ── エンドポイントの形状 (additive query params, never-blocks) ────────────
@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


SHIP_CSV = (
    "出荷日,商品コード,出荷数,受注番号\n"
    "2025/09/01,SKU-1,5,PS001\n"
    "2025/09/01,SKU-2,3,PS001\n"
    "2025/09/02,SKU-1,7,PS002\n"
    "2025/09/03,SKU-1,4,PS003\n"
    "2025/09/03,SKU-3,2,PS003\n"
).encode("utf-8")


def test_endpoint_available_after_import(client):
    import io as _io
    client.post("/api/projects", json={"name": "invopt", "template": "ecommerce_small"})
    r = client.post("/api/projects/invopt/import/shipments",
                    files={"shipments": ("ship.csv", _io.BytesIO(SHIP_CSV), "text/csv")})
    assert r.status_code == 200 and r.json()["ok"]

    b = client.get("/api/projects/invopt/inventory-opt",
                   params={"lead_time": 3, "review": 0, "service_level": 0.95}).json()
    assert b["available"] is True
    assert b["totals"]["service_level"] == 0.95
    assert b["totals"]["params"]["lead_time_days"] == 3.0
    assert isinstance(b["rows"], list) and b["rows"]
    row = b["rows"][0]
    for k in ("sku", "abc", "model", "mu_d", "sigma_d", "safety_stock", "rop",
              "target_level", "days_observed"):
        assert k in row
    assert row["model"] in ("normal", "poisson")
    assert "理論値" in b["note"]


def test_endpoint_never_blocks_on_fresh_template(client):
    # テンプレは rate ベースの需要プロファイルで明示オーダーが無い → available:false。
    client.post("/api/projects", json={"name": "invopt2", "template": "ecommerce_small"})
    b = client.get("/api/projects/invopt2/inventory-opt").json()
    assert b["available"] is False
    assert "message" in b
