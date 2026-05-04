"""Pure analytical functions for 3PL warehouse data.

All inputs use the standardized logical column names produced by data_io.apply_mapping
(`date`, `timestamp`, `sku`, `qty`, `partner`, `location`).
"""
from __future__ import annotations

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


__all__ = ["volume_trends", "abc_analysis", "peak_analysis", "inventory_turnover"]
