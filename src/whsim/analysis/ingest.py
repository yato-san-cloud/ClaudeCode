"""Shipments → model outbound orders (the ETL that feeds the simulator).

The analysis suite (`report.run_all`) only *describes* an uploaded file; nothing
wrote it back into the project model, so the BI views (対話分析 / 基礎物量) and
the SimPy run still ran on template demand. This bridges that gap: a tidy
shipments frame (already column-mapped via ``analysis.data_io``) becomes
``WarehouseModel.orders.outbound`` plus the SKUs it references.

Timeline: the model has no wall clock — weekday/hour in BI are derived from each
order's ``arrival_s`` (offset seconds) as ``floor(/86400)%7`` (0=月) and
``floor(/3600)%24``. We anchor ``arrival_s`` to the Monday on/before the first
date so REAL calendar weekday + hour survive the round-trip; without a timestamp
we spread a day's orders across 8–17時 so hourly shape is still meaningful.
"""

from __future__ import annotations

import pandas as pd

from whsim.schema.model import Item, Order, OrderLine

# Working window used to spread orders within a day when no clock time is given.
_DAY_START_H = 8
_DAY_SPAN_H = 9  # 8:00 → 17:00


def build_orders(df: pd.DataFrame) -> tuple[list[Order], list[Item], dict]:
    """Pure: tidy shipments frame → (orders, items, summary). Never raises on
    messy data — unusable rows (no SKU / qty<=0) are dropped, and a frame with no
    usable dates falls back to a synthetic sequential timeline so the demand
    *shape* is still produced."""
    summary = {"orders": 0, "lines": 0, "skus": 0, "units": 0,
               "date_min": None, "date_max": None, "dated": False}
    if df is None or df.empty or "sku" not in df.columns:
        return [], [], summary

    d = df.copy()
    n_in = len(d)
    # Clean: drop blank/null SKUs, coerce qty, keep positive quantities only.
    # (astype(str) on a str-dtype column turns None into float nan, which would
    # slip past the != "" guard — so drop nulls first, then block nan/none too.)
    # Track what gets dropped + why so the UI can show the SLC-style「確認」.
    cleansing = {"rows_in": n_in, "dropped_no_sku": 0, "dropped_zero_qty": 0,
                 "bad_date": 0, "qty_outliers": 0}
    before = len(d)
    d = d[d["sku"].notna()]
    d["sku"] = d["sku"].astype(str).str.strip()
    d = d[(d["sku"] != "") & (~d["sku"].str.lower().isin(["nan", "none"]))]
    cleansing["dropped_no_sku"] = before - len(d)
    d["qty"] = pd.to_numeric(d.get("qty"), errors="coerce").fillna(0)
    before = len(d)
    d = d[d["qty"] > 0]
    cleansing["dropped_zero_qty"] = before - len(d)
    if d.empty:
        summary["cleansing"] = cleansing
        return [], [], summary
    d["qty"] = d["qty"].round().astype(int)
    # 異常値の目印 (drop はしない; 人が確認できるよう件数だけ報告): qty が中央値の
    # ~50倍を超える極端な行を outlier として数える (SLC の「異常値タブ」相当の軽量版).
    try:
        med = float(d["qty"].median()) or 1.0
        cleansing["qty_outliers"] = int((d["qty"] > med * 50).sum())
        cleansing["qty_median"] = round(med, 1)
        cleansing["qty_max"] = int(d["qty"].max())
    except Exception:  # noqa: BLE001 — diagnostics only, never fatal
        pass

    # Effective datetime per row: prefer a real timestamp, else the date.
    dt = pd.Series(pd.NaT, index=d.index, dtype="datetime64[ns]")
    has_time = pd.Series(False, index=d.index)
    if "date" in d.columns:
        dd = pd.to_datetime(d["date"], errors="coerce")
        dt = dd
    if "timestamp" in d.columns:
        ts = pd.to_datetime(d["timestamp"], errors="coerce")
        # a timestamp carries clock time only if it isn't exactly midnight
        tflag = ts.notna() & ~((ts.dt.hour == 0) & (ts.dt.minute == 0) & (ts.dt.second == 0))
        dt = ts.where(ts.notna(), dt)
        has_time = tflag.fillna(False)
    d["__dt"] = dt
    d["__has_time"] = has_time

    valid = d["__dt"].dropna()
    dated = bool(len(valid))
    base = None
    if dated:
        first = valid.min().normalize()
        base = first - pd.Timedelta(days=int(first.dayofweek))  # the Monday ≤ first
        summary["date_min"] = valid.min().strftime("%Y-%m-%d")
        summary["date_max"] = valid.max().strftime("%Y-%m-%d")
    summary["dated"] = dated

    # Within-day sequence (for date-only rows) so the hour spread is stable.
    if dated:
        day_key = d["__dt"].dt.normalize()
        d["__seq"] = d.groupby(day_key).cumcount()
        d["__cnt"] = day_key.map(day_key.value_counts())
    else:
        d["__seq"] = range(len(d))
        d["__cnt"] = len(d)

    n = len(d)

    def arrival_for(row, i):
        if dated and pd.notna(row["__dt"]):
            day_off = int((row["__dt"].normalize() - base).days)
            if row["__has_time"]:
                sod = int(row["__dt"].hour * 3600 + row["__dt"].minute * 60 + row["__dt"].second)
            else:
                frac = (row["__seq"] + 0.5) / max(1, int(row["__cnt"]))
                sod = int((_DAY_START_H + frac * _DAY_SPAN_H) * 3600)
            return float(day_off * 86400 + sod)
        # No dates anywhere: spread sequentially across a synthetic 5-day week.
        span = 5 * 86400
        return float((i + 0.5) / max(1, n) * span)

    has_oid = "order_id" in d.columns and d["order_id"].astype(str).str.strip().replace(
        {"nan": ""}).ne("").any()

    orders: list[Order] = []
    units = 0
    if has_oid:
        d["__oid"] = d["order_id"].astype(str).str.strip()
        d.loc[d["__oid"].isin(["", "nan"]), "__oid"] = ""
        # rows lacking an order_id each become their own order
        blank = d["__oid"] == ""
        d.loc[blank, "__oid"] = ["__row%d" % i for i in range(int(blank.sum()))]
        d = d.reset_index(drop=True)
        d["__arr"] = [arrival_for(r, i) for i, r in d.iterrows()]
        for oid, g in d.groupby("__oid", sort=False):
            arr = float(g["__arr"].min())
            lines_map: dict[str, int] = {}
            for r in g.itertuples(index=False):
                lines_map[r.sku] = lines_map.get(r.sku, 0) + int(r.qty)
            lines = [OrderLine(sku=s, qty=q) for s, q in lines_map.items()]
            units += sum(q for q in lines_map.values())
            label = oid if not str(oid).startswith("__row") else f"S{len(orders) + 1:06d}"
            orders.append(Order(order_id=str(label), arrival_s=arr, lines=lines))
    else:
        d = d.reset_index(drop=True)
        for i, r in d.iterrows():
            orders.append(Order(order_id=f"S{i + 1:06d}", arrival_s=arrival_for(r, i),
                                lines=[OrderLine(sku=r["sku"], qty=int(r["qty"]))]))
            units += int(r["qty"])

    orders.sort(key=lambda o: o.arrival_s)

    # Items for every referenced SKU (name defaults to the code).
    skus = list(dict.fromkeys(d["sku"].tolist()))
    items = [Item(sku=s, name=s) for s in skus]

    # bad_date: rows that had a date column but failed to parse (kept anyway, on a
    # synthetic timeline) — surfaced so the user can fix the source if they want.
    if "date" in df.columns and dated:
        cleansing["bad_date"] = int(d["__dt"].isna().sum())
    summary["cleansing"] = cleansing
    summary.update({
        "orders": len(orders),
        "lines": int(sum(len(o.lines) for o in orders)),
        "skus": len(skus),
        "units": int(units),
    })
    return orders, items, summary


def orders_to_frame(orders) -> pd.DataFrame:
    """Inverse of ``build_orders`` (lossy but analysis-grade): model outbound
    orders → a standard shipments frame (date/timestamp/sku/qty/order_id).

    ``arrival_s`` is Monday-anchored (see module docstring), so re-anchoring on
    any fixed Monday reproduces the true weekday/hour shape; absolute dates are
    synthetic. Used as the fallback when no saved import table exists (projects
    ingested before tables were persisted)."""
    rows = []
    anchor = pd.Timestamp("2024-01-01")  # a Monday — weekday()==0
    for o in orders or []:
        dt = anchor + pd.to_timedelta(float(o.arrival_s or 0.0), unit="s")
        for ln in o.lines:
            rows.append({"date": dt.normalize(), "timestamp": dt,
                         "sku": ln.sku, "qty": ln.qty, "order_id": o.order_id})
    return pd.DataFrame(rows)


def item_master(df: pd.DataFrame | None) -> dict[str, dict]:
    """商品マスタ frame → {sku: {name?, case_qty?, abc_class?}} (cleaned). Empty on
    None/empty. case_qty is coerced to a positive int; ABC normalised to A/B/C.
    Tolerant: bad rows are skipped, never fatal."""
    out: dict[str, dict] = {}
    if df is None or df.empty or "sku" not in df.columns:
        return out
    for r in df.itertuples(index=False):
        sku = str(getattr(r, "sku", "") or "").strip()
        if not sku or sku.lower() in ("nan", "none"):
            continue
        rec: dict = {}
        nm = str(getattr(r, "name", "") or "").strip()
        if nm and nm.lower() not in ("nan", "none"):
            rec["name"] = nm
        cq = getattr(r, "case_qty", None)
        try:
            cqi = int(float(cq))
            if cqi > 0:
                rec["case_qty"] = cqi
        except (TypeError, ValueError):
            pass
        abc = str(getattr(r, "abc_class", "") or "").strip().upper()
        if abc in ("A", "B", "C"):
            rec["abc_class"] = abc
        out[sku] = rec
    return out


def ingest_shipments(proj, df: pd.DataFrame, items_df: pd.DataFrame | None = None) -> dict:
    """Thin I/O: build orders from a shipments frame (and OPTIONALLY enrich SKUs
    from a 商品マスタ frame), write them into the project model, and mark the
    relevant provenance subtrees IMPORTED. Returns a summary dict for the UI."""
    from whsim.provenance import Source

    orders, items, summary = build_orders(df)
    if not orders:
        return {"ok": False, "summary": summary,
                "message": "取り込める出荷明細がありませんでした（SKU・数量・日付の列をご確認ください）。"}

    master = item_master(items_df)            # {} when no master supplied

    model = proj.load_model()
    model.orders.outbound = orders
    # Merge SKUs we don't already know about, applying any 商品マスタ attributes.
    known = {it.sku: it for it in model.items}
    enriched = 0
    new_skus = 0
    for it in items:
        m = master.get(it.sku)
        if m:                                  # apply 入数/名前/ABC from the master
            for attr, val in m.items():
                setattr(it, attr, val)
            enriched += 1
        if it.sku in known:
            if m:                              # update an existing item's attributes
                for attr, val in m.items():
                    setattr(known[it.sku], attr, val)
        else:
            model.items.append(it)
            new_skus += 1
    proj.save_model(model)
    summary["enriched"] = enriched
    summary["master_skus"] = len(master)

    prov = proj.load_provenance()
    prov.mark("orders", Source.IMPORTED)
    if new_skus or enriched:
        prov.mark("items", Source.IMPORTED)
    proj.save_provenance(prov)

    msg = (f"{summary['orders']:,}件のオーダー（{summary['lines']:,}明細・"
           f"{summary['skus']:,}SKU）を取り込みました。")
    if enriched:
        msg += f" 商品マスタで{enriched:,}SKUに入数等を反映。"
    return {"ok": True, "summary": summary,
            "provenance_summary": prov.summary(), "message": msg}
