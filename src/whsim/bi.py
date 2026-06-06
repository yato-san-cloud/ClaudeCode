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

import duckdb
import pandas as pd

from whsim.schema.model import WarehouseModel


def base_volumes(model: WarehouseModel) -> dict:
    """Aggregate the base volumes we genuinely have, via DuckDB. Pallet/case
    *derivations* are intentionally left to the client (provisional 仮値)."""
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

    return {
        "engine": f"DuckDB {duckdb.__version__}",
        "avg_case_qty": round(avg_cq, 2),
        "out_lines": round(float(out_lines or 0), 1),
        "out_pieces": round(float(out_pieces or 0), 1),
        "out_orders": round(float(out_orders or 0), 1),
        "out_cases": round(float(out_cases or 0), 1),
        "in_pieces": round(float(in_pieces), 1),
        "in_cases": round(float(in_cases), 1),
        "in_estimated": in_estimated,
        "out_estimated": out_estimated,
    }
