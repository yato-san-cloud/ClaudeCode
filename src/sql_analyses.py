"""SQL versions of the four analyses, running against a duck_io.Catalog.

Designed to be drop-in compatible with ``src.analyses`` (same column names
and ordering in the returned DataFrames) so the UI and tests can compare
results 1:1.
"""
from __future__ import annotations

import pandas as pd

from src.duck_io import Catalog

WEEKDAY_LABELS = ["月", "火", "水", "木", "金", "土", "日"]
_FREQ_SQL = {"D": "day", "W": "week", "M": "month"}


def _date_clause(lo: str | None, hi: str | None) -> str:
    parts: list[str] = []
    if lo:
        parts.append(f"date >= TIMESTAMP '{lo}'")
    if hi:
        parts.append(f"date < TIMESTAMP '{hi}' + INTERVAL 1 DAY")
    return " AND ".join(parts) if parts else "TRUE"


def volume_trends(cat: Catalog, freq: str = "D", lo: str | None = None, hi: str | None = None) -> pd.DataFrame:
    """Period x kind aggregation. Mirrors analyses.volume_trends()."""
    duck_freq = _FREQ_SQL.get(freq, "day")
    where = _date_clause(lo, hi)
    parts = []
    for label, name in (("出荷", "shipments"), ("入荷", "inbound")):
        v = cat.view(name)
        if v is None or not cat.has_column(name, "date"):
            continue
        parts.append(
            f"SELECT date_trunc('{duck_freq}', date) AS period, "
            f"'{label}' AS kind, "
            f"CAST(SUM(qty) AS BIGINT) AS qty, "
            f"COUNT(*) AS lines "
            f"FROM {v} WHERE {where} GROUP BY 1"
        )
    if not parts:
        return pd.DataFrame(columns=["period", "kind", "qty", "lines"])
    df = cat.query(" UNION ALL ".join(parts) + " ORDER BY period, kind")
    return df


def abc_analysis(
    cat: Catalog,
    key: str = "sku",
    a_cutoff: float = 0.7,
    b_cutoff: float = 0.9,
    lo: str | None = None,
    hi: str | None = None,
) -> pd.DataFrame:
    v = cat.view("shipments")
    if v is None or not cat.has_column("shipments", key):
        return pd.DataFrame(columns=[key, "qty", "share", "cum_share", "rank"])
    where = _date_clause(lo, hi) if cat.has_column("shipments", "date") else "TRUE"
    sql = f"""
    WITH agg AS (
        SELECT "{key}" AS k, CAST(SUM(qty) AS BIGINT) AS qty
        FROM {v} WHERE {where}
        GROUP BY 1
    ),
    tot AS (SELECT NULLIF(SUM(qty), 0)::DOUBLE AS t FROM agg),
    ranked AS (
        SELECT k, qty,
               qty / (SELECT t FROM tot) AS share,
               SUM(qty) OVER (ORDER BY qty DESC, k ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                   / (SELECT t FROM tot) AS cum_share
        FROM agg
    )
    SELECT k AS "{key}", qty,
           COALESCE(share, 0)::DOUBLE AS share,
           COALESCE(cum_share, 0)::DOUBLE AS cum_share,
           CASE
               WHEN COALESCE(cum_share - share, 0) < {a_cutoff} THEN 'A'
               WHEN COALESCE(cum_share - share, 0) < {b_cutoff} THEN 'B'
               ELSE 'C'
           END AS rank
    FROM ranked
    ORDER BY qty DESC, k ASC
    """
    return cat.query(sql)


def peak_analysis(
    cat: Catalog,
    lo: str | None = None,
    hi: str | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    empty_w = pd.DataFrame({"weekday": WEEKDAY_LABELS, "lines": 0, "qty": 0})
    empty_h = pd.DataFrame(columns=["hour", "lines", "qty"])
    empty_hm = pd.DataFrame()
    v = cat.view("shipments")
    if v is None:
        return empty_w.iloc[0:0], empty_h, empty_hm

    has_ts = cat.has_column("shipments", "timestamp")
    ts_col = "timestamp" if has_ts else ("date" if cat.has_column("shipments", "date") else None)
    if ts_col is None:
        return empty_w.iloc[0:0], empty_h, empty_hm

    where = _date_clause(lo, hi) if cat.has_column("shipments", "date") else "TRUE"
    wd_expr = f"((isodow({ts_col}) - 1) % 7)"  # 0=月 .. 6=日

    by_wd_raw = cat.query(
        f"SELECT {wd_expr} AS wd, COUNT(*) AS lines, CAST(SUM(qty) AS BIGINT) AS qty "
        f"FROM {v} WHERE {ts_col} IS NOT NULL AND {where} GROUP BY 1"
    )
    full = pd.DataFrame({"wd": range(7), "weekday": WEEKDAY_LABELS})
    by_weekday = full.merge(by_wd_raw, on="wd", how="left").fillna({"lines": 0, "qty": 0})
    by_weekday = by_weekday[["weekday", "lines", "qty"]].astype({"lines": "int64", "qty": "int64"})

    if has_ts:
        by_hour = cat.query(
            f"SELECT hour({ts_col}) AS hour, COUNT(*) AS lines, CAST(SUM(qty) AS BIGINT) AS qty "
            f"FROM {v} WHERE {ts_col} IS NOT NULL AND {where} GROUP BY 1 ORDER BY 1"
        )
        hm_raw = cat.query(
            f"SELECT {wd_expr} AS wd, hour({ts_col}) AS hour, CAST(SUM(qty) AS BIGINT) AS qty "
            f"FROM {v} WHERE {ts_col} IS NOT NULL AND {where} GROUP BY 1, 2"
        )
        hm_raw["weekday"] = hm_raw["wd"].map(lambda i: WEEKDAY_LABELS[int(i)])
        hm = (
            hm_raw.pivot_table(index="weekday", columns="hour", values="qty", aggfunc="sum", fill_value=0)
            .reindex(WEEKDAY_LABELS)
            .fillna(0)
        )
    else:
        by_hour = empty_h
        hm = empty_hm
    return by_weekday, by_hour, hm


def inventory_turnover(
    cat: Catalog,
    period_days: int | None = None,
    dead_stock_days: int = 60,
    lo: str | None = None,
    hi: str | None = None,
) -> pd.DataFrame:
    v_inv = cat.view("inventory")
    if v_inv is None:
        return pd.DataFrame()
    v_ship = cat.view("shipments")
    where = _date_clause(lo, hi) if v_ship and cat.has_column("shipments", "date") else "TRUE"

    if v_ship is None:
        df = cat.query(f'SELECT "sku" AS sku, CAST(SUM(qty) AS BIGINT) AS stock_qty FROM {v_inv} GROUP BY 1')
        df["shipped_qty"] = 0
        df["turnover"] = 0.0
        df["days_supply"] = float("inf")
        df["last_ship_date"] = pd.NaT
        df["days_since_last_ship"] = float("inf")
        df["dead_stock"] = df["stock_qty"] > 0
        return df.sort_values("stock_qty", ascending=False).reset_index(drop=True)

    if period_days is None:
        row = cat.query(
            f"SELECT date_diff('day', MIN(date), MAX(date)) + 1 AS d "
            f"FROM {v_ship} WHERE {where}"
        ).iloc[0, 0]
        period_days = max(1, int(row) if row and not pd.isna(row) else 1)

    sql = f"""
    WITH stock AS (
        SELECT "sku" AS sku, CAST(SUM(qty) AS BIGINT) AS stock_qty FROM {v_inv} GROUP BY 1
    ),
    shipped AS (
        SELECT "sku" AS sku, CAST(SUM(qty) AS BIGINT) AS shipped_qty, MAX(date) AS last_ship_date
        FROM {v_ship} WHERE {where} GROUP BY 1
    ),
    ref AS (SELECT MAX(date) AS rd FROM {v_ship} WHERE {where})
    SELECT s.sku AS sku,
           s.stock_qty,
           COALESCE(sh.shipped_qty, 0) AS shipped_qty,
           CASE WHEN s.stock_qty > 0
                THEN COALESCE(sh.shipped_qty, 0)::DOUBLE / s.stock_qty
                ELSE 0 END AS turnover,
           CASE WHEN COALESCE(sh.shipped_qty, 0) > 0
                THEN s.stock_qty::DOUBLE / (sh.shipped_qty::DOUBLE / {period_days}.0)
                ELSE NULL END AS days_supply,
           sh.last_ship_date,
           CASE WHEN sh.last_ship_date IS NULL
                THEN CAST('inf' AS DOUBLE)
                ELSE date_diff('day', sh.last_ship_date, (SELECT rd FROM ref))::DOUBLE END AS days_since_last_ship,
           (s.stock_qty > 0 AND
            (sh.last_ship_date IS NULL
             OR date_diff('day', sh.last_ship_date, (SELECT rd FROM ref)) >= {dead_stock_days})) AS dead_stock
    FROM stock s LEFT JOIN shipped sh USING (sku)
    ORDER BY s.stock_qty DESC
    """
    return cat.query(sql)


__all__ = ["volume_trends", "abc_analysis", "peak_analysis", "inventory_turnover"]
