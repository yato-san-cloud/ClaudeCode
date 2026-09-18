"""在庫最適化 — 安全在庫・発注点の解析的試算 (在庫理論 / ロジギーク流の一発版).

whsim は SKU 別の日次出荷実績を既に取り込んでいるので、需要のばらつき σ を
「実測から直接」求められる — ブログが Excel/Python で手計算する部分をワンクリック
にするのがこのモジュール。純関数 (shipments フレーム → dict); 教科書どおりの正規
近似 + 低頻度品のポアソン切替を実装する。

理論 (標準教科書):
  * SKU 別の日次需要系列 (観測期間内の需要ゼロ日も含める — σ に効く) から
    平均 μ_d・標準偏差 σ_d (母標準偏差 ddof=0; コード全体の慣習に合わせる)。
  * 安全在庫 (正規近似): SS = z · σ_d · sqrt(LT + R)
      LT=リードタイム(日), R=発注間隔(日; 発注点方式は 0), z=サービス率の分位点。
  * 発注点 (発注点方式): ROP = μ_d · LT + SS。
    定期発注: 目標在庫 = μ_d · (LT + R) + SS。
  * 低頻度品のポアソン切替: 期待需要 λ = μ_d·(LT+R) が小さい (< ~10) と正規近似が
    甘いので、Poisson CDF(S; λ) ≥ サービス率 を満たす最小整数 S を求め SS = S − λ。
    CDF は反復計算 (scipy 不使用)。各 SKU がどちらのモデルかを明示 (正規/ポアソン)。

honest caveat: これらは理論値 (需要の独立性・定常性を仮定) で、実績の欠品率とは
乖離し得る — 出力に必ず日本語の注記を載せる (ブログ自身の警告に倣う)。
"""

from __future__ import annotations

import math

from whsim.analysis import analyses

# サービス率 → 標準正規分位点 z (片側)。UI が出す 5 段はここで厳密一致させる。
Z_TABLE: dict[float, float] = {
    0.90: 1.282, 0.95: 1.645, 0.975: 1.960, 0.99: 2.326, 0.999: 3.090,
}

# 期待需要 λ = μ_d·(LT+R) がこの値未満なら正規近似をやめてポアソンで解く。
POISSON_THRESHOLD = 10.0

# BI ツール流: 返す行は物量上位このくらいまで (合計は全 SKU で計算)。
MAX_ROWS = 500

# 正直な注記 (ブログ theory≠practice の警告)。UI がそのまま出す。
CAVEAT_NOTE = (
    "安全在庫・発注点は理論値です（需要の独立性・定常性を仮定）。"
    "実績の欠品率とは乖離し得るため、実運用では実績で補正のうえ目安としてご利用ください。"
)


def _probit(p: float) -> float:
    """Inverse standard-normal CDF (Acklam's rational approximation, ~1e-9).

    Only used for a service level that is NOT one of the canonical 5 (the UI
    always sends a canonical one, so ``Z_TABLE`` gives an exact z there)."""
    p = min(max(float(p), 1e-9), 1 - 1e-9)
    a = (-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00)
    b = (-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01)
    c = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00)
    d = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00)
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p <= phigh:
        q = p - 0.5
        r = q * q
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
               (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    q = math.sqrt(-2 * math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)


def z_for(service_level: float) -> float:
    """Service level → one-sided normal quantile z. Exact for the canonical 5
    (Z_TABLE), otherwise a probit approximation. Clamped so z stays finite."""
    sl = float(service_level)
    for k, z in Z_TABLE.items():
        if abs(sl - k) < 1e-9:
            return z
    return round(_probit(min(max(sl, 0.5), 0.999999)), 3)


def poisson_reorder_level(lam: float, service_level: float) -> int:
    """Smallest integer S with Poisson CDF(S; λ) ≥ service_level.

    CDF built iteratively (term_{k} = term_{k-1}·λ/k, seeded at e^{-λ}); no scipy.
    λ≤0 ⇒ 0 (all mass at 0). Capped so a pathological input can never spin."""
    if lam <= 0:
        return 0
    sl = min(max(float(service_level), 0.0), 1 - 1e-12)
    term = math.exp(-lam)   # k = 0
    cdf = term
    k = 0
    # A Poisson(λ<10) needs only a handful of terms; cap defends against inf/nan.
    while cdf < sl and k < 100000:
        k += 1
        term *= lam / k
        cdf += term
    return k


def _demand_stats(shipments_df):
    """Per-SKU daily-demand moments over the GLOBAL observed span.

    Returns ``(stats, days_observed)`` where ``stats`` maps sku → (total_qty,
    mu_d, sigma_d). σ uses the population std (ddof=0) over ALL calendar days in
    the span — including zero-demand days — computed via the moment identity
    Var = E[x²] − μ² so the full date×SKU matrix never has to be materialised:

        μ   = Σq / N,   Var = Σ(daily_total²)/N − μ²,   N = days in span.

    Zero-demand days fall out for free (they add nothing to Σq or Σq², but N is
    the whole span), which is exactly the effect the theory needs on σ. Returns
    ``({}, 0)`` when there is no usable dated demand (never blocks)."""
    import pandas as pd

    if shipments_df is None or getattr(shipments_df, "empty", True):
        return {}, 0
    d = shipments_df
    if "sku" not in d.columns or "qty" not in d.columns or "date" not in d.columns:
        return {}, 0

    d = d[["sku", "date", "qty"]].copy()
    d["sku"] = d["sku"].astype(str).str.strip()
    d = d[(d["sku"] != "") & (~d["sku"].str.lower().isin(["nan", "none"]))]
    d["qty"] = pd.to_numeric(d["qty"], errors="coerce")
    d["date"] = pd.to_datetime(d["date"], errors="coerce")
    d = d[(d["qty"] > 0) & d["date"].notna()]
    if d.empty:
        return {}, 0

    day = d["date"].dt.normalize()
    span_days = int((day.max() - day.min()).days) + 1   # calendar days, inclusive
    span_days = max(1, span_days)

    # Daily total per (sku, day) first — multiple lines/orders on a day are one
    # demand observation, so square the DAILY total, not each row's qty.
    daily = d.assign(day=day).groupby(["sku", "day"], sort=False)["qty"].sum()
    by_sku = daily.groupby(level="sku")
    sum_q = by_sku.sum()
    sum_q2 = daily.pow(2).groupby(level="sku").sum()

    stats: dict[str, tuple[float, float, float]] = {}
    for sku in sum_q.index:
        total = float(sum_q[sku])
        mu = total / span_days
        var = float(sum_q2[sku]) / span_days - mu * mu
        sigma = math.sqrt(var) if var > 0 else 0.0
        stats[str(sku)] = (total, mu, sigma)
    return stats, span_days


def analyze(shipments_df, lead_time_days: float = 3.0, review_days: float = 0.0,
            service_level: float = 0.95) -> dict:
    """出荷実績フレーム → SKU 別 安全在庫・発注点。Pure; returns a JSON-able dict.

    Args:
        shipments_df: standardised shipments frame (date/sku/qty; the same shape
            ``analysis.data_io.apply_mapping`` / ``ingest.orders_to_frame`` yield).
        lead_time_days: 補充リードタイム LT (日).
        review_days: 発注間隔 R (日). 0 = 発注点方式, >0 = 定期発注.
        service_level: 目標サービス率 (欠品許容の裏返し; 0.90/0.95/0.975/0.99/0.999).

    Returns ``{available, rows, truncated, totals, note, ...}``; ``available`` is
    False (with a message) when there is no dated demand — never raises."""
    lt = max(0.0, float(lead_time_days))
    r = max(0.0, float(review_days))
    sl = min(max(float(service_level), 0.5), 0.999999)
    z = z_for(sl)
    exposure = lt + r            # 需要にさらされる日数 (安全在庫の対象期間)

    stats, days_observed = _demand_stats(shipments_df)
    if not stats:
        return {"available": False,
                "message": "在庫理論の計算には日付つき出荷実績が必要です。①取込で出荷データを取り込んでください。"}

    # ABC は既存の純関数を再利用 (自前で Pareto を書かない)。
    rank_by_sku: dict[str, str] = {}
    try:
        abc = analyses.abc_analysis(shipments_df, key="sku")
        if not abc.empty:
            rank_by_sku = {str(s): str(rk) for s, rk in zip(abc["sku"], abc["rank"])}
    except Exception:  # noqa: BLE001 — ABC は付加情報; 失敗しても本計算は続ける
        rank_by_sku = {}

    rows: list[dict] = []
    total_safety_stock = 0.0
    for sku, (total, mu, sigma) in stats.items():
        lam = mu * exposure                 # 期待需要 (対象期間)
        if lam < POISSON_THRESHOLD:
            model = "poisson"
            level = poisson_reorder_level(lam, sl)
            ss = max(0.0, level - lam)
        else:
            model = "normal"
            ss = z * sigma * math.sqrt(exposure)
        rop = mu * lt + ss                   # 発注点方式
        target = mu * exposure + ss          # 定期発注の目標在庫
        total_safety_stock += ss
        rows.append({
            "sku": sku,
            "abc": rank_by_sku.get(sku, ""),
            "model": model,                  # 'normal' | 'poisson'
            "mu_d": round(mu, 3),
            "sigma_d": round(sigma, 3),
            "safety_stock": round(ss, 1),
            "rop": round(rop, 1),
            "target_level": round(target, 1),
            "days_observed": days_observed,
            "total_qty": round(total, 1),
        })

    # 物量 (総出荷) 降順で並べ、上位 MAX_ROWS だけ返す (合計は全 SKU で計算済み)。
    rows.sort(key=lambda x: x["total_qty"], reverse=True)
    truncated = len(rows) > MAX_ROWS
    params = {"lead_time_days": lt, "review_days": r, "service_level": sl}
    return {
        "available": True,
        "rows": rows[:MAX_ROWS],
        "truncated": truncated,
        "totals": {
            "total_safety_stock": round(total_safety_stock, 1),  # 総安全在庫点数
            "skus": len(rows),                                   # SKU数
            "service_level": sl,
            "z": z,
            "days_observed": days_observed,
            "params": params,
        },
        "note": CAVEAT_NOTE,
    }


__all__ = ["analyze", "z_for", "poisson_reorder_level",
           "Z_TABLE", "POISSON_THRESHOLD", "MAX_ROWS", "CAVEAT_NOTE"]
