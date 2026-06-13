"""Turn a standardised CSV/Excel table (data_io field keys) into model subtrees.

The unified 入荷/出荷/商品マスタ import maps a customer's columns to whsim's field
keys (data_io), then this builds the runnable model pieces: shipment rows → outbound
orders (grouped by 受注番号 when present), and a 商品マスタ table → item master.
Tolerant: bad rows are skipped, never fatal.
"""

from __future__ import annotations

from whsim.schema.model import Item, Order, OrderLine


def _ok(v) -> bool:
    return v is not None and str(v).strip() not in ("", "nan", "None")


def _int(v, default: int = 1) -> int:
    try:
        n = int(round(float(v)))
        return n if n > 0 else default
    except (TypeError, ValueError):
        return default


def build_orders(std, duration_s: float = 3600.0) -> list[Order]:
    """Outbound orders from a standardised shipment table (cols: sku, qty, order_id?)."""
    if std is None or getattr(std, "empty", True) or "sku" not in std.columns:
        return []
    # itertuples + model_construct (no per-row pydantic validation) keeps the exact
    # grouping/skip semantics but is ~10× faster than iterrows on big files.
    orders: list[Order] = []
    if "order_id" in std.columns:
        for oid, g in std.groupby("order_id"):
            lines = [OrderLine.model_construct(sku=str(r.sku), qty=_int(getattr(r, "qty", None)))
                     for r in g.itertuples(index=False) if _ok(getattr(r, "sku", None))]
            if lines:
                orders.append(Order.model_construct(order_id=str(oid), lines=lines))
    else:
        for i, r in enumerate(std.itertuples(index=False)):
            if _ok(getattr(r, "sku", None)):
                orders.append(Order.model_construct(
                    order_id=f"O{i:06d}",
                    lines=[OrderLine.model_construct(sku=str(r.sku), qty=_int(getattr(r, "qty", None)))]))
    # Spread arrivals evenly across the operating window so the sim has a flow.
    n = max(1, len(orders))
    for i, o in enumerate(orders):
        o.arrival_s = round(duration_s * i / n, 1)
    return orders


def build_items(std) -> list[Item]:
    """Item master from a standardised inventory/master table (cols: sku, qty?)."""
    if std is None or getattr(std, "empty", True) or "sku" not in std.columns:
        return []
    items: list[Item] = []
    seen: set[str] = set()
    has_qty = "qty" in std.columns
    for _, r in std.iterrows():
        s = r.get("sku")
        if not _ok(s) or str(s) in seen:
            continue
        seen.add(str(s))
        stock = _int(r.get("qty"), 0) if has_qty else 0
        items.append(Item(sku=str(s), name=str(s), stock=stock, case_qty=1))
    return items
