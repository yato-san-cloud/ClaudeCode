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
