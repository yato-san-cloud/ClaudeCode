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


def summary_kpis(
    cat: Catalog,
    dead_stock_days: int = 60,
    lo: str | None = None,
    hi: str | None = None,
) -> dict:
    """SQL twin of analyses.summary_kpis(). Returns the same dict keys."""
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
    v_ship = cat.view("shipments")
    where = _date_clause(lo, hi)

    if v_ship is not None:
        row = cat.query(
            f"SELECT CAST(SUM(qty) AS BIGINT) AS pcs, COUNT(*) AS lines FROM {v_ship} WHERE {where}"
        ).iloc[0]
        out["total_pcs_out"] = int(row["pcs"] or 0)
        out["total_lines_out"] = int(row["lines"] or 0)
        if out["total_lines_out"]:
            out["pcs_per_line"] = out["total_pcs_out"] / out["total_lines_out"]

        if cat.has_column("shipments", "order_id"):
            r = cat.query(
                f"""
                WITH per_order AS (
                    SELECT order_id, COUNT(*) AS line_cnt
                    FROM {v_ship} WHERE {where} AND order_id IS NOT NULL
                    GROUP BY 1
                )
                SELECT COUNT(*) AS n_orders,
                       AVG(line_cnt)::DOUBLE AS avg_lines,
                       AVG(CASE WHEN line_cnt > 1 THEN 1.0 ELSE 0.0 END)::DOUBLE AS multi_rate
                FROM per_order
                """
            ).iloc[0]
            n_orders = int(r["n_orders"] or 0)
            out["total_orders"] = n_orders
            if n_orders > 0:
                out["pcs_per_order"] = out["total_pcs_out"] / n_orders
                out["lines_per_order"] = float(r["avg_lines"])
                out["multi_line_rate"] = float(r["multi_rate"])
            if cat.has_column("shipments", "sku"):
                r = cat.query(
                    f"""
                    SELECT COUNT(*)::DOUBLE / NULLIF(COUNT(DISTINCT sku), 0) AS ops
                    FROM (SELECT DISTINCT order_id, sku FROM {v_ship} WHERE {where} AND order_id IS NOT NULL)
                    """
                ).iloc[0]
                if r["ops"] is not None and not pd.isna(r["ops"]):
                    out["orders_per_sku"] = float(r["ops"])

        if cat.has_column("shipments", "date"):
            peak = cat.query(
                f"SELECT date_trunc('day', date) AS d, CAST(SUM(qty) AS BIGINT) AS q "
                f"FROM {v_ship} WHERE {where} GROUP BY 1 ORDER BY q DESC LIMIT 1"
            )
            if not peak.empty:
                out["peak_day"] = pd.Timestamp(peak.iloc[0]["d"])
                out["peak_day_qty"] = int(peak.iloc[0]["q"])
            wd = cat.query(
                f"SELECT ((isodow(date) - 1) % 7) AS wd, CAST(SUM(qty) AS BIGINT) AS q "
                f"FROM {v_ship} WHERE {where} GROUP BY 1 ORDER BY q DESC LIMIT 1"
            )
            if not wd.empty:
                out["peak_weekday"] = WEEKDAY_LABELS[int(wd.iloc[0]["wd"])]

        if cat.has_column("shipments", "sku"):
            sku_qty = cat.query(
                f'SELECT "sku" AS sku, CAST(SUM(qty) AS BIGINT) AS q '
                f"FROM {v_ship} WHERE {where} GROUP BY 1 ORDER BY q DESC"
            )
            total = sku_qty["q"].sum()
            if total > 0:
                n_top = max(1, int(round(len(sku_qty) * 0.10)))
                out["top10_sku_share"] = float(sku_qty.head(n_top)["q"].sum() / total)

    v_in = cat.view("inbound")
    if v_in is not None:
        row = cat.query(
            f"SELECT CAST(SUM(qty) AS BIGINT) AS pcs, COUNT(*) AS lines FROM {v_in}"
        ).iloc[0]
        out["total_pcs_in"] = int(row["pcs"] or 0)
        out["total_lines_in"] = int(row["lines"] or 0)

    sku_views = [
        cat.view(n) for n in ("shipments", "inbound")
        if cat.view(n) and cat.has_column(n, "sku")
    ]
    if sku_views:
        union = " UNION ALL ".join(f"SELECT sku FROM {v}" for v in sku_views)
        out["sku_active"] = int(cat.query(f"SELECT COUNT(DISTINCT sku) FROM ({union}) WHERE sku IS NOT NULL").iloc[0, 0])

    v_inv = cat.view("inventory")
    if v_inv is not None and cat.has_column("inventory", "sku"):
        out["sku_master"] = int(
            cat.query(f'SELECT COUNT(DISTINCT "sku") FROM {v_inv}').iloc[0, 0]
        )
        if v_ship is not None:
            ti = inventory_turnover(cat, dead_stock_days=dead_stock_days, lo=lo, hi=hi)
            if not ti.empty:
                out["avg_turnover"] = float(ti["turnover"].replace([float("inf")], 0).mean())
                out["dead_sku_count"] = int(ti["dead_stock"].sum())
                out["dead_sku_rate"] = float(ti["dead_stock"].mean())
    return out


def daily_anomalies(cat: Catalog, z_thresh: float = 2.0, lo: str | None = None, hi: str | None = None) -> pd.DataFrame:
    v = cat.view("shipments")
    if v is None or not cat.has_column("shipments", "date"):
        return pd.DataFrame(columns=["date", "qty", "lines", "ma7", "z", "anomaly"])
    where = _date_clause(lo, hi)
    df = cat.query(
        f"""
        SELECT date_trunc('day', date) AS date,
               CAST(SUM(qty) AS BIGINT) AS qty,
               COUNT(*) AS lines,
               AVG(SUM(qty)) OVER (ORDER BY date_trunc('day', date) ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS ma7
        FROM {v}
        WHERE {where}
        GROUP BY 1
        ORDER BY 1
        """
    )
    if df.empty:
        return df.assign(z=0.0, anomaly=False)
    mu, sd = df["qty"].mean(), df["qty"].std(ddof=0)
    df["z"] = (df["qty"] - mu) / sd if sd > 0 else 0.0
    df["anomaly"] = df["z"].abs() >= z_thresh
    return df


def partner_weekday_matrix(cat: Catalog, value: str = "lines", top_n: int = 15,
                           lo: str | None = None, hi: str | None = None) -> pd.DataFrame:
    v = cat.view("shipments")
    if v is None or not cat.has_column("shipments", "partner") or not cat.has_column("shipments", "date"):
        return pd.DataFrame()
    where = _date_clause(lo, hi)
    agg = "CAST(SUM(qty) AS BIGINT)" if value == "qty" else "COUNT(*)"
    df = cat.query(
        f"""
        SELECT "partner" AS partner,
               ((isodow(date) - 1) % 7) AS wd,
               {agg} AS v
        FROM {v} WHERE {where} AND "partner" IS NOT NULL
        GROUP BY 1, 2
        """
    )
    if df.empty:
        return pd.DataFrame()
    df["weekday"] = df["wd"].map(lambda i: WEEKDAY_LABELS[int(i)])
    m = df.pivot_table(index="partner", columns="weekday", values="v", aggfunc="sum", fill_value=0)
    m = m.reindex(columns=WEEKDAY_LABELS, fill_value=0)
    m["total"] = m.sum(axis=1)
    return m.sort_values("total", ascending=False).head(top_n).drop(columns="total")


def period_compare(cat: Catalog, period_a: tuple, period_b: tuple, key: str = "sku", top_n: int = 20) -> pd.DataFrame:
    v = cat.view("shipments")
    if v is None or not cat.has_column("shipments", key) or not cat.has_column("shipments", "date"):
        return pd.DataFrame(columns=[key, "qty_a", "qty_b", "delta", "contribution"])
    a0, a1 = pd.Timestamp(period_a[0]), pd.Timestamp(period_a[1])
    b0, b1 = pd.Timestamp(period_b[0]), pd.Timestamp(period_b[1])
    sql = f"""
    WITH a AS (
        SELECT "{key}" AS k, CAST(SUM(qty) AS BIGINT) AS qty_a
        FROM {v} WHERE date BETWEEN TIMESTAMP '{a0}' AND TIMESTAMP '{a1}'
        GROUP BY 1
    ),
    b AS (
        SELECT "{key}" AS k, CAST(SUM(qty) AS BIGINT) AS qty_b
        FROM {v} WHERE date BETWEEN TIMESTAMP '{b0}' AND TIMESTAMP '{b1}'
        GROUP BY 1
    ),
    joined AS (
        SELECT COALESCE(a.k, b.k) AS k,
               COALESCE(a.qty_a, 0) AS qty_a,
               COALESCE(b.qty_b, 0) AS qty_b
        FROM a FULL OUTER JOIN b USING (k)
    ),
    tot AS (SELECT SUM(qty_b - qty_a) AS td FROM joined)
    SELECT k AS "{key}", qty_a, qty_b,
           (qty_b - qty_a) AS delta,
           CASE WHEN (SELECT td FROM tot) = 0 THEN 0
                ELSE (qty_b - qty_a)::DOUBLE / (SELECT td FROM tot) END AS contribution
    FROM joined
    ORDER BY ABS(qty_b - qty_a) DESC
    LIMIT {top_n}
    """
    return cat.query(sql)


__all__ = [
    "volume_trends", "abc_analysis", "peak_analysis", "inventory_turnover", "summary_kpis",
    "daily_anomalies", "partner_weekday_matrix", "period_compare",
]
