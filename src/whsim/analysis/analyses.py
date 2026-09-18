"""Pure analytical functions for 3PL warehouse data.

All inputs use the standardized logical column names produced by data_io.apply_mapping
(`date`, `timestamp`, `sku`, `qty`, `partner`, `location`).
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def volume_trends(
    shipments: pd.DataFrame | None,
    inbound: pd.DataFrame | None,
    freq: str = "D",
) -> pd.DataFrame:
    """Combine inbound/outbound into a long-format time series at the requested freq.

    freq: 'D' for daily, 'W' for weekly, 'M' for monthly.
    Returns columns: period, kind, qty, lines.
    """
    parts = []
    for kind, df in (("出荷", shipments), ("入荷", inbound)):
        if df is None or df.empty or "date" not in df.columns:
            continue
        g = (
            df.assign(period=df["date"].dt.to_period(freq).dt.to_timestamp())
            .groupby("period", as_index=False)
            .agg(qty=("qty", "sum"), lines=("qty", "size"))
        )
        g["kind"] = kind
        parts.append(g)
    if not parts:
        return pd.DataFrame(columns=["period", "kind", "qty", "lines"])
    return pd.concat(parts, ignore_index=True).sort_values(["period", "kind"]).reset_index(drop=True)


def abc_analysis(
    df: pd.DataFrame,
    key: str = "sku",
    value: str = "qty",
    a_cutoff: float = 0.7,
    b_cutoff: float = 0.9,
) -> pd.DataFrame:
    """Pareto / ABC ranking by `key`. Returns key, qty, share, cum_share, rank."""
    if df.empty or key not in df.columns:
        return pd.DataFrame(columns=[key, value, "share", "cum_share", "rank"])
    g = df.groupby(key, as_index=False)[value].sum().sort_values(value, ascending=False)
    total = g[value].sum()
    if total <= 0:
        g["share"] = 0.0
        g["cum_share"] = 0.0
        g["rank"] = "C"
        return g.reset_index(drop=True)
    g["share"] = g[value] / total
    g["cum_share"] = g["share"].cumsum()
    # Rank by cum_share *before* this row so the item that crosses a threshold
    # is still counted in the lower rank (standard Pareto convention).
    prev = g["cum_share"].shift(fill_value=0.0)
    g["rank"] = pd.cut(
        prev,
        bins=[-0.001, a_cutoff, b_cutoff, 1.001],
        labels=["A", "B", "C"],
    ).astype(str)
    return g.reset_index(drop=True)


def peak_analysis(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Return (by_weekday, by_hour, heatmap) summaries.

    Uses `timestamp` if present (for hourly), falls back to `date` (date-level only).
    """
    weekday_labels = ["月", "火", "水", "木", "金", "土", "日"]
    empty_w = pd.DataFrame(columns=["weekday", "lines", "qty"])
    empty_h = pd.DataFrame(columns=["hour", "lines", "qty"])
    empty_hm = pd.DataFrame()
    if df.empty:
        return empty_w, empty_h, empty_hm

    ts = df["timestamp"] if "timestamp" in df.columns else df.get("date")
    if ts is None:
        return empty_w, empty_h, empty_hm
    ts = pd.to_datetime(ts, errors="coerce")
    work = df.assign(_ts=ts).dropna(subset=["_ts"])
    work["weekday"] = work["_ts"].dt.weekday.map(lambda i: weekday_labels[i])
    work["hour"] = work["_ts"].dt.hour

    by_weekday = (
        work.groupby("weekday", as_index=False)
        .agg(lines=("qty", "size"), qty=("qty", "sum"))
        .set_index("weekday")
        .reindex(weekday_labels)
        .fillna(0)
        .reset_index()
    )

    if "timestamp" in df.columns:
        by_hour = work.groupby("hour", as_index=False).agg(lines=("qty", "size"), qty=("qty", "sum"))
        heatmap = (
            work.pivot_table(index="weekday", columns="hour", values="qty", aggfunc="sum", fill_value=0)
            .reindex(weekday_labels)
            .fillna(0)
        )
    else:
        by_hour = empty_h
        heatmap = empty_hm
    return by_weekday, by_hour, heatmap


def inventory_turnover(
    inventory: pd.DataFrame,
    shipments: pd.DataFrame,
    period_days: int | None = None,
    dead_stock_days: int = 60,
) -> pd.DataFrame:
    """Per-SKU turnover and stagnation metrics.

    Returns columns: sku, stock_qty, shipped_qty, turnover, days_supply,
    last_ship_date, days_since_last_ship, dead_stock.
    """
    if inventory.empty or "sku" not in inventory.columns:
        return pd.DataFrame()

    stock = inventory.groupby("sku", as_index=False)["qty"].sum().rename(columns={"qty": "stock_qty"})

    if shipments is None or shipments.empty or "sku" not in shipments.columns:
        result = stock.assign(
            shipped_qty=0,
            turnover=0.0,
            days_supply=float("inf"),
            last_ship_date=pd.NaT,
            days_since_last_ship=float("inf"),
        )
        result["dead_stock"] = result["stock_qty"] > 0
        return result.sort_values("stock_qty", ascending=False).reset_index(drop=True)

    if period_days is None:
        date_range = shipments["date"].max() - shipments["date"].min()
        period_days = max(1, date_range.days + 1)

    shipped = shipments.groupby("sku").agg(shipped_qty=("qty", "sum"), last_ship_date=("date", "max")).reset_index()

    merged = stock.merge(shipped, on="sku", how="left")
    merged["shipped_qty"] = merged["shipped_qty"].fillna(0)
    merged["turnover"] = merged["shipped_qty"] / merged["stock_qty"].where(merged["stock_qty"] > 0)
    merged["turnover"] = merged["turnover"].fillna(0)
    merged["days_supply"] = (merged["stock_qty"] / (merged["shipped_qty"] / period_days)).where(merged["shipped_qty"] > 0)

    reference_date = shipments["date"].max()
    merged["days_since_last_ship"] = (reference_date - merged["last_ship_date"]).dt.days.astype(float)
    never_shipped = merged["last_ship_date"].isna()
    merged.loc[never_shipped, "days_since_last_ship"] = float("inf")
    merged["dead_stock"] = (merged["stock_qty"] > 0) & (
        never_shipped | (merged["days_since_last_ship"] >= dead_stock_days)
    )

    return merged.sort_values("stock_qty", ascending=False).reset_index(drop=True)


WEEKDAY_LABELS = ["月", "火", "水", "木", "金", "土", "日"]


def summary_kpis(
    shipments: pd.DataFrame | None,
    inbound: pd.DataFrame | None,
    inventory: pd.DataFrame | None,
    dead_stock_days: int = 60,
) -> dict:
    """Compute 3PL operational KPIs (一覧表示用)。

    出荷側: 総ピース, 総ライン (=行), 総PS数, ピース/PS, 行/PS, ピース/行,
            マルチラインPS率, 上位10%SKU集中度, アクティブSKU.
    入荷側: 総ピース, 総ライン.
    在庫:   マスタSKU数, 平均回転率, デッドストックSKU率.
    その他: ピーク日, ピーク曜日, ピーク日数量.
    """
    nan = float("nan")
    out: dict = {
        "total_pcs_out": 0, "total_lines_out": 0, "total_orders": 0,
        "total_pcs_in": 0, "total_lines_in": 0,
        "sku_active": 0, "sku_master": 0,
        "pcs_per_order": nan, "lines_per_order": nan, "pcs_per_line": nan,
        "orders_per_sku": nan, "multi_line_rate": nan, "top10_sku_share": nan,
        "avg_turnover": nan, "dead_sku_rate": nan, "dead_sku_count": 0,
        "peak_weekday": None, "peak_day": None, "peak_day_qty": 0,
    }
    if shipments is not None and not shipments.empty:
        out["total_pcs_out"] = int(shipments["qty"].sum())
        out["total_lines_out"] = int(len(shipments))
        out["pcs_per_line"] = out["total_pcs_out"] / out["total_lines_out"]
        if "order_id" in shipments.columns:
            n_orders = int(shipments["order_id"].nunique())
            out["total_orders"] = n_orders
            if n_orders > 0:
                out["pcs_per_order"] = out["total_pcs_out"] / n_orders
                out["lines_per_order"] = out["total_lines_out"] / n_orders
                lines_per_ps = shipments.groupby("order_id").size()
                out["multi_line_rate"] = float((lines_per_ps > 1).mean())
            if "sku" in shipments.columns:
                ord_sku = shipments.drop_duplicates(["order_id", "sku"])
                n_sku_in_ship = int(ord_sku["sku"].nunique())
                if n_sku_in_ship > 0:
                    out["orders_per_sku"] = len(ord_sku) / n_sku_in_ship
        if "date" in shipments.columns:
            daily = shipments.groupby(shipments["date"].dt.normalize())["qty"].sum()
            if not daily.empty:
                out["peak_day"] = daily.idxmax()
                out["peak_day_qty"] = int(daily.max())
            wd = shipments.groupby(shipments["date"].dt.weekday)["qty"].sum()
            if not wd.empty:
                out["peak_weekday"] = WEEKDAY_LABELS[int(wd.idxmax())]
        if "sku" in shipments.columns:
            sku_qty = shipments.groupby("sku")["qty"].sum().sort_values(ascending=False)
            if sku_qty.sum() > 0:
                n_top = max(1, int(round(len(sku_qty) * 0.10)))
                out["top10_sku_share"] = float(sku_qty.head(n_top).sum() / sku_qty.sum())

    if inbound is not None and not inbound.empty:
        out["total_pcs_in"] = int(inbound["qty"].sum())
        out["total_lines_in"] = int(len(inbound))

    sku_set = set()
    for df in (shipments, inbound):
        if df is not None and "sku" in df.columns:
            sku_set |= set(df["sku"].dropna().unique())
    out["sku_active"] = len(sku_set)

    if inventory is not None and not inventory.empty and "sku" in inventory.columns:
        out["sku_master"] = int(inventory["sku"].nunique())
        if shipments is not None and not shipments.empty:
            ti = inventory_turnover(inventory, shipments, dead_stock_days=dead_stock_days)
            if not ti.empty:
                out["avg_turnover"] = float(ti["turnover"].replace([float("inf")], 0).mean())
                out["dead_sku_count"] = int(ti["dead_stock"].sum())
                out["dead_sku_rate"] = float(ti["dead_stock"].mean())
    return out


__all__ = ["volume_trends", "abc_analysis", "peak_analysis", "inventory_turnover", "summary_kpis"]


# ═══════════════════════════════════════════════════════════════════════════
# 拡張分析 (Keyence 流の「気付き」「対比」「予測」「ポートフォリオ」)
# ═══════════════════════════════════════════════════════════════════════════
def daily_anomalies(shipments: pd.DataFrame | None, z_thresh: float = 2.0) -> pd.DataFrame:
    """日次出荷量に z-score を付与し、しきい値超を flag。

    Returns columns: date, qty, lines, ma7, z, anomaly.
    """
    if shipments is None or shipments.empty or "date" not in shipments.columns:
        return pd.DataFrame(columns=["date", "qty", "lines", "ma7", "z", "anomaly"])
    g = (
        shipments.assign(date=shipments["date"].dt.normalize())
        .groupby("date", as_index=False)
        .agg(qty=("qty", "sum"), lines=("qty", "size"))
        .sort_values("date")
    )
    g["ma7"] = g["qty"].rolling(7, min_periods=1).mean()
    mu, sd = g["qty"].mean(), g["qty"].std(ddof=0)
    g["z"] = (g["qty"] - mu) / sd if sd > 0 else 0.0
    g["anomaly"] = g["z"].abs() >= z_thresh
    return g.reset_index(drop=True)


def period_compare(
    shipments: pd.DataFrame | None,
    period_a: tuple[pd.Timestamp, pd.Timestamp],
    period_b: tuple[pd.Timestamp, pd.Timestamp],
    key: str = "sku",
    top_n: int = 20,
) -> pd.DataFrame:
    """期間 A → 期間 B の変化を `key` 別に分解し寄与度を返す。

    Returns columns: key, qty_a, qty_b, delta, contribution.
    """
    if shipments is None or shipments.empty or key not in shipments.columns:
        return pd.DataFrame(columns=[key, "qty_a", "qty_b", "delta", "contribution"])

    def _slice(start, end):
        m = (shipments["date"] >= pd.Timestamp(start)) & (shipments["date"] <= pd.Timestamp(end))
        return shipments.loc[m].groupby(key)["qty"].sum()

    a = _slice(*period_a).rename("qty_a")
    b = _slice(*period_b).rename("qty_b")
    df = pd.concat([a, b], axis=1).fillna(0)
    df["delta"] = df["qty_b"] - df["qty_a"]
    total_delta = df["delta"].sum()
    df["contribution"] = df["delta"] / total_delta if total_delta != 0 else 0.0
    df = df.reset_index().sort_values("delta", key=lambda s: s.abs(), ascending=False).head(top_n)
    return df.reset_index(drop=True)


def sku_lifecycle(shipments: pd.DataFrame | None, recent_days: int = 14, slow_days: int = 30) -> pd.DataFrame:
    """SKU を新規/成長/安定/衰退/停止に分類する。

    Returns columns: sku, qty, first_seen, last_seen, recent_qty, prev_qty,
                     change_rate, status.
    """
    if shipments is None or shipments.empty or "sku" not in shipments.columns:
        return pd.DataFrame(columns=["sku", "qty", "first_seen", "last_seen", "recent_qty", "prev_qty", "change_rate", "status"])

    max_date = shipments["date"].max().normalize()
    rec_cut = max_date - pd.Timedelta(days=recent_days)
    slow_cut = max_date - pd.Timedelta(days=slow_days)
    new_cut = shipments["date"].min().normalize() + pd.Timedelta(days=recent_days)

    base = shipments.groupby("sku").agg(
        qty=("qty", "sum"),
        first_seen=("date", "min"),
        last_seen=("date", "max"),
    )
    recent = (
        shipments[shipments["date"] > rec_cut]
        .groupby("sku")["qty"].sum().rename("recent_qty")
    )
    prev_window_start = rec_cut - pd.Timedelta(days=recent_days)
    prev = (
        shipments[(shipments["date"] > prev_window_start) & (shipments["date"] <= rec_cut)]
        .groupby("sku")["qty"].sum().rename("prev_qty")
    )
    df = base.join(recent, how="left").join(prev, how="left").fillna({"recent_qty": 0, "prev_qty": 0})
    df["change_rate"] = (df["recent_qty"] - df["prev_qty"]) / df["prev_qty"].replace(0, np.nan)

    def classify(row) -> str:
        if row["last_seen"] < slow_cut:
            return "停止"
        if row["first_seen"] >= new_cut:
            return "新規"
        if row["prev_qty"] > 0 and row["change_rate"] >= 0.25:
            return "成長"
        if row["prev_qty"] > 0 and row["change_rate"] <= -0.25:
            return "衰退"
        return "安定"

    df["status"] = df.apply(classify, axis=1)
    return df.reset_index()[["sku", "qty", "first_seen", "last_seen", "recent_qty", "prev_qty", "change_rate", "status"]]


def partner_weekday_matrix(shipments: pd.DataFrame | None, value: str = "lines", top_n: int = 15) -> pd.DataFrame:
    """取引先 × 曜日 のヒートマップ。"""
    if shipments is None or shipments.empty or "partner" not in shipments.columns or "date" not in shipments.columns:
        return pd.DataFrame()
    labels = ["月", "火", "水", "木", "金", "土", "日"]
    work = shipments.copy()
    work["weekday"] = work["date"].dt.weekday.map(lambda i: labels[int(i)])
    if value == "qty":
        m = work.pivot_table(index="partner", columns="weekday", values="qty", aggfunc="sum", fill_value=0)
    else:
        m = work.pivot_table(index="partner", columns="weekday", values="qty", aggfunc="size", fill_value=0)
    m = m.reindex(columns=labels, fill_value=0)
    m["total"] = m.sum(axis=1)
    m = m.sort_values("total", ascending=False).head(top_n).drop(columns="total")
    return m


def simple_forecast(shipments: pd.DataFrame | None, horizon: int = 14, history: int = 28) -> pd.DataFrame:
    """単純な曜日別平均 + トレンドによる出荷予測。

    Returns columns: date, qty, kind ('actual' or 'forecast'), lower, upper.
    """
    if shipments is None or shipments.empty or "date" not in shipments.columns:
        return pd.DataFrame(columns=["date", "qty", "kind", "lower", "upper"])
    daily = (
        shipments.groupby(shipments["date"].dt.normalize())["qty"]
        .sum()
        .sort_index()
        .astype(float)
    )
    if len(daily) < 7:
        return pd.DataFrame(columns=["date", "qty", "kind", "lower", "upper"])
    actual = daily.reset_index()
    actual.columns = ["date", "qty"]
    actual["kind"] = "actual"
    actual["lower"] = actual["qty"]
    actual["upper"] = actual["qty"]

    hist_tail = daily.iloc[-history:] if len(daily) >= history else daily
    wd_avg = hist_tail.groupby(hist_tail.index.weekday).mean()
    if len(hist_tail) >= 14:
        first_half = hist_tail.iloc[: len(hist_tail) // 2].mean()
        second_half = hist_tail.iloc[len(hist_tail) // 2 :].mean()
        trend = (second_half - first_half) / (len(hist_tail) / 2)
    else:
        trend = 0.0
    resid = hist_tail.values - hist_tail.index.weekday.map(wd_avg.to_dict()).to_numpy()
    sigma = float(np.std(resid)) if len(resid) > 1 else hist_tail.std()

    rows = []
    last_date = daily.index[-1]
    for i in range(1, horizon + 1):
        d = last_date + pd.Timedelta(days=i)
        wd = int(d.weekday())
        base = float(wd_avg.get(wd, hist_tail.mean()))
        fc = max(0.0, base + trend * i)
        rows.append({"date": d, "qty": fc, "kind": "forecast", "lower": max(0.0, fc - 1.96 * sigma), "upper": fc + 1.96 * sigma})
    forecast = pd.DataFrame(rows)
    return pd.concat([actual, forecast], ignore_index=True)


def sku_portfolio(turnover_df: pd.DataFrame | None) -> pd.DataFrame:
    """SKU を 回転率 × 在庫数 で 4 象限に分類する。

    Returns columns: sku, turnover, stock_qty, shipped_qty, quadrant.
    優良(高回転×低在庫) / 過剰(低回転×高在庫) / 主力(高回転×高在庫) / 死蔵(低回転×低在庫)。
    """
    if turnover_df is None or turnover_df.empty:
        return pd.DataFrame(columns=["sku", "turnover", "stock_qty", "shipped_qty", "quadrant"])
    df = turnover_df.copy()
    t_med = df["turnover"].replace([float("inf")], np.nan).median()
    s_med = df["stock_qty"].median()

    def quad(row) -> str:
        hi_t = row["turnover"] >= t_med
        hi_s = row["stock_qty"] >= s_med
        if hi_t and not hi_s:
            return "🟢 優良(高回転・少在庫)"
        if not hi_t and hi_s:
            return "🟠 過剰(低回転・多在庫)"
        if hi_t and hi_s:
            return "🔵 主力(高回転・多在庫)"
        return "⚪ 死蔵候補(低回転・少在庫)"

    df["quadrant"] = df.apply(quad, axis=1)
    return df[["sku", "turnover", "stock_qty", "shipped_qty", "quadrant"]].reset_index(drop=True)


__all__ += ["daily_anomalies", "period_compare", "sku_lifecycle", "partner_weekday_matrix", "simple_forecast", "sku_portfolio"]
