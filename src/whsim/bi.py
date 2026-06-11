"""BI / ETL bridge — base 物量 aggregation in DuckDB for the 物量BI view.

The thesis (decouple input difficulty from accuracy) applied to volumes: load the
customer's order data into DuckDB, aggregate the *base* quantities we actually
have (lines / pieces / orders / cases), and let the UI derive the rest from
provisional assumptions — e.g. 入荷パレット数 from ケース数 ÷ パレット積載数(仮値).
Heavy aggregation runs in DuckDB (sakusaku, scales); the provisional 仮値 layer is
derived live client-side so sliders feel instant. Anything derived is flagged so
provenance never overstates it.
"""

from __future__ import annotations

import json
import math

import duckdb
import pandas as pd

from whsim.schema.model import WarehouseModel


def base_volumes(model: WarehouseModel, nonworking: set[int] | None = None) -> dict:
    """Aggregate the base volumes we genuinely have, via DuckDB. Pallet/case
    *derivations* are intentionally left to the client (provisional 仮値).

    ``nonworking`` is a set of weekday indices (0=月 … 6=日) the user has marked
    as 非稼働日 (物量分析ツールの稼動日設定). Those days are dropped from the working
    calendar, so the /日 averages divide by FEWER days — i.e. the excluded days'
    volume is redistributed onto the working days (the total is unchanged)."""
    nonworking = set(nonworking or ())
    items = {it.sku: it for it in model.items}
    rows = []
    for o in model.orders.outbound:
        for ln in o.lines:
            cq = getattr(items.get(ln.sku), "case_qty", 1) or 1
            rows.append({"order_id": o.order_id, "sku": ln.sku,
                         "qty": int(ln.qty or 0), "case_qty": int(cq)})

    con = duckdb.connect()  # in-memory; scales to file-backed for large imports
    try:
        if rows:
            con.register("lines", pd.DataFrame(rows))
            r = con.execute(
                """
                SELECT count(*)                            AS out_lines,
                       coalesce(sum(qty), 0)               AS out_pieces,
                       count(distinct order_id)            AS out_orders,
                       coalesce(sum(qty / nullif(case_qty, 0)), 0) AS out_cases,
                       coalesce(avg(case_qty), 1)          AS avg_case_qty
                FROM lines
                """).fetchone()
            out_lines, out_pieces, out_orders, out_cases, avg_cq = r
        else:
            out_lines = out_pieces = out_orders = out_cases = 0.0
            avg_cq = 1.0
    finally:
        con.close()

    # Average case quantity: prefer the item master (more representative than the
    # lines sampled above), fall back to the line aggregate, then 1.
    item_cqs = [int(it.case_qty) for it in model.items if getattr(it, "case_qty", 0)]
    if item_cqs:
        avg_cq = sum(item_cqs) / len(item_cqs)

    # No explicit outbound (profile-driven model): estimate a typical day's volume
    # from the order profile so the BI view still has something real-shaped to
    # work with. Flagged as estimated.
    out_estimated = False
    if not rows and model.orders.profile.rate_per_hr > 0:
        prof = model.orders.profile
        hours = max(model.simulation.shift_hours_per_day, 1.0)
        out_orders = prof.rate_per_hr * hours
        out_lines = out_orders * max(prof.lines_per_order_mean, 1.0)
        out_pieces = out_lines * 2.0          # ~2 pieces/line (generic)
        out_cases = out_pieces / max(avg_cq, 1.0)
        out_estimated = True

    # Inbound: use explicit receipts if present, else estimate from outbound
    # (replenishment tracks demand) and mark it estimated.
    in_pieces = 0
    for o in (model.orders.inbound or []):
        for ln in getattr(o, "lines", []) or []:
            in_pieces += int(ln.qty or 0)
    in_estimated = False
    if in_pieces <= 0 and out_pieces:
        in_pieces = int(out_pieces)
        in_estimated = True

    avg_cq = float(avg_cq or 1.0)
    in_cases = (in_pieces / avg_cq) if avg_cq else 0.0

    # 稼動日カレンダ (物量分析ツール Default): a day with even 1pcs of movement is
    # a working day. The /日 figures are TRUE daily averages over those days —
    # without this a multi-day import showed the period TOTAL labelled "/日".
    # 非稼働日 (nonworking weekdays, 0=月) drop their days from the divisor so the
    # remaining working days absorb the volume (period total stays the same).
    def _work_days(orders) -> int:
        days = {int((o.arrival_s or 0.0) // 86400) for o in orders}
        if nonworking:
            days = {d for d in days if (d % 7) not in nonworking}
        return max(1, len(days))

    out_days = _work_days(model.orders.outbound) if rows else 1
    in_days = _work_days(model.orders.inbound) \
        if (model.orders.inbound and not in_estimated) else out_days
    if in_estimated:
        in_days = out_days  # estimated inbound tracks the outbound calendar

    return {
        "engine": f"DuckDB {duckdb.__version__}",
        "avg_case_qty": round(avg_cq, 2),
        "out_lines": round(float(out_lines or 0) / out_days, 1),
        "out_pieces": round(float(out_pieces or 0) / out_days, 1),
        "out_orders": round(float(out_orders or 0) / out_days, 1),
        "out_cases": round(float(out_cases or 0) / out_days, 1),
        "in_pieces": round(float(in_pieces) / in_days, 1),
        "in_cases": round(float(in_cases) / in_days, 1),
        "in_estimated": in_estimated,
        "out_estimated": out_estimated,
        "working_days": out_days,
        "in_working_days": in_days,
        "nonworking": sorted(nonworking),
    }


# --- ①DuckDB analysis views (ABC / weekday / time-series) ------------------

_WEEKDAY_JP = ["月", "火", "水", "木", "金", "土", "日"]


def _line_frame(model: WarehouseModel) -> pd.DataFrame:
    """Flatten outbound orders into a tidy per-line DataFrame.

    Columns: order_id, sku, qty, arrival_s. ``arrival_s`` is the order's offset
    from the simulation start; weekday/hour are derived from it as a synthetic
    timeline (the model carries no wall-clock dates), so the views still surface
    the *shape* of demand even for profile/template-only models."""
    rows = []
    for o in model.orders.outbound:
        a = float(getattr(o, "arrival_s", 0.0) or 0.0)
        for ln in o.lines:
            rows.append({
                "order_id": o.order_id,
                "sku": ln.sku,
                "qty": int(ln.qty or 0),
                "arrival_s": a,
            })
    cols = ["order_id", "sku", "qty", "arrival_s"]
    return pd.DataFrame(rows, columns=cols)


def analysis_views(model: WarehouseModel, *, top_n: int = 20) -> dict:
    """ABC / weekday / time-series aggregations over outbound data, via DuckDB.

    Pure over the model; returns plain JSON-able dicts. With no order data every
    section is empty (never raises), so the BI view degrades gracefully."""
    df = _line_frame(model)
    out: dict = {
        "engine": f"DuckDB {duckdb.__version__}",
        "has_data": bool(len(df)),
        "abc": [],
        "by_weekday": [],
        "daily": [],
        "hourly": [],
        # Cross-tabulation for true client-side cross-filtering. Flat list of
        # cells at rank × weekday × hour granularity; empty when no data.
        "xtab": [],
        # Facet domains so the client can render consistent axes.
        "xtab_weekdays": list(_WEEKDAY_JP),  # index = weekday 0..6 (0 = 月)
        "xtab_ranks": ["A", "B", "C"],
        # Per-SKU × weekday breakdown (restricted to the ABC top_n set), so the
        # client can RE-RANK the ABC Pareto under a weekday selection. Flat list
        # of {sku, weekday 0-6, qty, lines}; empty when no data.
        "xtab_sku": [],
    }
    if df.empty:
        return out

    # Item master for friendly SKU names (optional).
    names = {it.sku: (it.name or it.sku) for it in model.items}

    con = duckdb.connect()
    try:
        con.register("lines", df)

        # ABC: per-SKU outbound share, ranked, with cumulative share + A/B/C.
        abc = con.execute(
            """
            WITH agg AS (
                SELECT sku, sum(qty) AS qty, count(*) AS lines
                FROM lines GROUP BY sku
            ), tot AS (SELECT sum(qty) AS t FROM agg)
            SELECT a.sku, a.qty, a.lines,
                   a.qty / nullif(t.t, 0) AS share,
                   sum(a.qty) OVER (ORDER BY a.qty DESC
                       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                       / nullif(t.t, 0) AS cum_share
            FROM agg a, tot t
            ORDER BY a.qty DESC
            """).fetchdf()
        if not abc.empty:
            prev = abc["cum_share"].shift(fill_value=0.0)
            abc["rank"] = pd.cut(prev, bins=[-0.001, 0.7, 0.9, 1.001],
                                 labels=["A", "B", "C"]).astype(str)
            head = abc.head(top_n)
            out["abc"] = [
                {"sku": r.sku, "name": names.get(r.sku, r.sku),
                 "qty": float(r.qty), "lines": int(r.lines),
                 "share": round(float(r.share or 0), 4),
                 "cum_share": round(float(r.cum_share or 0), 4),
                 "rank": r.rank}
                for r in head.itertuples(index=False)
            ]
            # Class rollup (count of SKUs + qty share per A/B/C).
            roll = abc.groupby("rank", as_index=False).agg(
                skus=("sku", "size"), qty=("qty", "sum"))
            out["abc_summary"] = [
                {"rank": r.rank, "skus": int(r.skus), "qty": float(r.qty)}
                for r in roll.itertuples(index=False)
            ]

        # Weekday: derive day index from arrival_s (synthetic timeline).
        wk = con.execute(
            """
            SELECT (floor(arrival_s / 86400.0))::BIGINT % 7 AS wd,
                   sum(qty) AS qty, count(*) AS lines,
                   count(distinct order_id) AS orders
            FROM lines GROUP BY wd ORDER BY wd
            """).fetchdf()
        if not wk.empty:
            out["by_weekday"] = [
                {"weekday": _WEEKDAY_JP[int(r.wd) % 7],
                 "qty": float(r.qty), "lines": int(r.lines),
                 "orders": int(r.orders)}
                for r in wk.itertuples(index=False)
            ]

        # Daily time-series (only meaningful if arrivals span >1 day).
        span_days = float(df["arrival_s"].max()) / 86400.0
        if span_days >= 1.0:
            daily = con.execute(
                """
                SELECT (floor(arrival_s / 86400.0))::BIGINT AS day,
                       sum(qty) AS qty, count(*) AS lines,
                       count(distinct order_id) AS orders
                FROM lines GROUP BY day ORDER BY day
                """).fetchdf()
            out["daily"] = [
                {"day": int(r.day), "qty": float(r.qty),
                 "lines": int(r.lines), "orders": int(r.orders)}
                for r in daily.itertuples(index=False)
            ]

        # Hourly time-series (hour-of-day).
        hourly = con.execute(
            """
            SELECT (floor(arrival_s / 3600.0))::BIGINT % 24 AS hour,
                   sum(qty) AS qty, count(*) AS lines,
                   count(distinct order_id) AS orders
            FROM lines GROUP BY hour ORDER BY hour
            """).fetchdf()
        if not hourly.empty:
            out["hourly"] = [
                {"hour": int(r.hour), "qty": float(r.qty),
                 "lines": int(r.lines), "orders": int(r.orders)}
                for r in hourly.itertuples(index=False)
            ]

        # Cross-tab: aggregate LINES at rank × weekday × hour so the client can
        # re-aggregate any chart under any facet selection without a refetch.
        # Reuse the SAME per-SKU ranking computed for ABC above (consistent
        # ranks); join lines -> rank, then GROUP BY in DuckDB. Weekday is
        # floor(arrival_s/86400) % 7 (0 = 月, matching by_weekday); hour is
        # floor(arrival_s/3600) % 24. arrival_s defaults to 0.0 in _line_frame,
        # so a missing arrival buckets into weekday 0 / hour 0 (never skipped).
        if not abc.empty:
            ranks = abc[["sku", "rank"]]
            con.register("ranks", ranks)
            xt = con.execute(
                """
                SELECT r.rank                                   AS rank,
                       (floor(l.arrival_s / 86400.0))::BIGINT % 7  AS weekday,
                       (floor(l.arrival_s / 3600.0))::BIGINT % 24  AS hour,
                       count(*)                                 AS lines,
                       coalesce(sum(l.qty), 0)                  AS qty,
                       count(distinct l.order_id)               AS orders
                FROM lines l JOIN ranks r ON l.sku = r.sku
                GROUP BY rank, weekday, hour
                ORDER BY rank, weekday, hour
                """).fetchdf()
            out["xtab"] = [
                {"rank": str(c.rank), "weekday": int(c.weekday),
                 "hour": int(c.hour), "lines": int(c.lines),
                 "qty": float(c.qty), "orders": int(c.orders)}
                for c in xt.itertuples(index=False)
            ]

            # Per-SKU × weekday breakdown, restricted to the ABC top_n set (the
            # same SKUs surfaced in out["abc"]). Aggregated over hours so the
            # client can re-rank the ABC Pareto under a weekday selection. Sum
            # over weekday per sku reconciles to that SKU's abc qty. Weekday is
            # floor(arrival_s/86400) % 7 (0 = 月), matching by_weekday/xtab.
            top_skus = head[["sku"]]
            con.register("top_skus", top_skus)
            xs = con.execute(
                """
                SELECT l.sku                                       AS sku,
                       (floor(l.arrival_s / 86400.0))::BIGINT % 7  AS weekday,
                       coalesce(sum(l.qty), 0)                     AS qty,
                       count(*)                                    AS lines
                FROM lines l JOIN top_skus t ON l.sku = t.sku
                GROUP BY l.sku, weekday
                ORDER BY l.sku, weekday
                """).fetchdf()
            out["xtab_sku"] = [
                {"sku": str(c.sku), "weekday": int(c.weekday),
                 "qty": float(c.qty), "lines": int(c.lines)}
                for c in xs.itertuples(index=False)
            ]
    finally:
        con.close()
    return out


# --- ②仮値派生をモデルへ保存 (provenance=generated) -------------------------

# Stored under projects/<name>/bi.json so the canonical schema stays untouched
# (and the 400/schema tests are unaffected). Every field is defaulted.
def derive_volumes(model: WarehouseModel, params: dict) -> dict:
    """Pure 仮値→派生物量 calculation.

    Given the base volumes (DuckDB) plus provisional assumptions
    (cases_per_pallet, pallet_prod[allets/hr], lines_per_order?, peak_factor?),
    derive inbound/outbound pallet counts and handling-hour estimates. Inputs
    are clamped to sane ranges so a bad slider value never blows up."""
    # 非稼働日 (weekday indices) flow through to the daily-average divisor.
    nw = params.get("nonworking")
    nonworking = set()
    if isinstance(nw, (list, tuple, set)):
        nonworking = {int(x) for x in nw if str(x).strip().isdigit() or isinstance(x, int)}
    elif isinstance(nw, str) and nw.strip():
        nonworking = {int(x) for x in nw.split(",") if x.strip().isdigit()}
    base = base_volumes(model, nonworking)

    def _pos(v, default):
        try:
            f = float(v)
        except (TypeError, ValueError):
            return float(default)
        return f if f > 0 else float(default)

    cases_per_pallet = _pos(params.get("cases_per_pallet"), 40.0)
    pallet_prod = _pos(params.get("pallet_prod"), 20.0)  # pallets handled / hr
    lines_per_order = _pos(
        params.get("lines_per_order"),
        base["out_lines"] / base["out_orders"] if base["out_orders"] else 1.0)
    peak_factor = _pos(params.get("peak_factor"), 1.0)
    # 出荷側荷姿 (搬送・梱包形態): バラピースはオリコンに詰め、オリコン/正梱ケースを
    # カゴ台車に積んで出荷する — データに無い前提条件を仮値で派生 (物量分析ツールの
    # 「梱包形態と入数設定」「搬送形態」の whsim 版).
    pieces_per_orikon = _pos(params.get("pieces_per_orikon"), 30.0)  # 点/オリコン
    units_per_cage = _pos(params.get("units_per_cage"), 14.0)        # (OC+cs)/台車

    in_pallets = base["in_cases"] / cases_per_pallet if cases_per_pallet else 0.0
    out_pallets = base["out_cases"] / cases_per_pallet if cases_per_pallet else 0.0
    in_pallets_peak = in_pallets * peak_factor
    in_hours = in_pallets_peak / pallet_prod if pallet_prod else 0.0
    # バラ出荷ピース (実績、無ければ 行×入数 で補完済みの out_pieces) → オリコン数。
    out_orikon = math.ceil(base["out_pieces"] / pieces_per_orikon) \
        if pieces_per_orikon and base.get("out_pieces") else 0
    # オリコン + 正梱ケースを同等荷姿としてカゴ台車に積載 (近似; chainで式は明示).
    cage_load = out_orikon + (base.get("out_cases") or 0)
    out_cages = math.ceil(cage_load / units_per_cage) if units_per_cage and cage_load else 0

    return {
        "inputs": {
            "cases_per_pallet": round(cases_per_pallet, 2),
            "pallet_prod": round(pallet_prod, 2),
            "lines_per_order": round(lines_per_order, 2),
            "peak_factor": round(peak_factor, 2),
            "pieces_per_orikon": round(pieces_per_orikon, 1),
            "units_per_cage": round(units_per_cage, 1),
        },
        "derived": {
            "in_pallets": round(in_pallets, 1),
            "out_pallets": round(out_pallets, 1),
            "in_pallets_peak": round(in_pallets_peak, 1),
            "inbound_handling_hours": round(in_hours, 2),
            "out_orikon": int(out_orikon),
            "out_cages": int(out_cages),
        },
        "base": base,
    }


def _bi_file(proj):
    return proj.root / "bi.json"


def load_bi_config(proj) -> dict:
    """Read the persisted BI 仮値/派生 config; empty (valid) dict on any error so
    nothing wedges the project (mirrors Project.load_* recovery)."""
    try:
        text = _bi_file(proj).read_text("utf-8")
        d = json.loads(text) if text.strip() else {}
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        d = {}
    return d if isinstance(d, dict) else {}


def apply_derivation(proj, params: dict) -> dict:
    """Persist 仮値→派生物量 to projects/<name>/bi.json and mark the related
    provenance subtree GENERATED (inferred data, not real input).

    Thin I/O around the pure ``derive_volumes``: load model, compute, write,
    update provenance. Returns ``{saved, provenance_summary}``."""
    from whsim.provenance import Source

    model = proj.load_model()
    result = derive_volumes(model, params or {})

    # Persist (atomic, same convention as project.py writes).
    from whsim.project import _write_json
    _write_json(_bi_file(proj), result)

    # The derivation fills the orders/物量 picture from provisional assumptions:
    # mark 'orders' GENERATED so "実データ N%" never overstates inferred volume.
    prov = proj.load_provenance()
    prov.mark("orders", Source.GENERATED)
    proj.save_provenance(prov)

    return {
        "saved": result,
        "saved_to": "bi.json",
        "provenance_summary": prov.summary(),
    }
