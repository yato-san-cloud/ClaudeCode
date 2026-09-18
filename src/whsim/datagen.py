"""不足データ作成 — fill the model's gaps so a partial import still runs *well*.

The product never blocks on missing data (provisional template values keep it
runnable). This goes a step further for the field user: when real demand exists
but the supporting masters don't, *derive* them — build the item master from the
SKUs actually ordered, calibrate pick frequency from real shipment lines, and
estimate stock — so the simulation reflects the customer's data instead of a
generic template. Everything generated here is marked ``GENERATED`` in provenance
so the % real-data figure never overstates it.
"""

from __future__ import annotations

from whsim.schema.model import Item, WarehouseModel

_DEFAULT_TS_PER_UNIT = 3.0   # seconds to handle one piece (generic pick+pack)
_DEFAULT_STOCK = 200


def _demand_skus(model: WarehouseModel) -> tuple[list[str], dict[str, int]]:
    """SKUs seen in real demand (outbound order lines, then storage), with the
    per-SKU line frequency that drives ABC / routing."""
    order: list[str] = []
    seen: set[str] = set()
    line_freq: dict[str, int] = {}
    for o in model.orders.outbound:
        for ln in o.lines:
            if not ln.sku:
                continue
            line_freq[ln.sku] = line_freq.get(ln.sku, 0) + 1
            if ln.sku not in seen:
                seen.add(ln.sku)
                order.append(ln.sku)
    for loc in model.locations:
        if loc.sku and loc.sku not in seen:
            seen.add(loc.sku)
            order.append(loc.sku)
    return order, line_freq


def generate_missing(model: WarehouseModel) -> dict:
    """Derive missing masters from whatever real data exists. Returns a summary
    of what was generated (also: which subtrees to mark GENERATED)."""
    generated: list[str] = []
    touched: set[str] = set()
    skus, line_freq = _demand_skus(model)

    # 1) Item master from demand when it's missing entirely.
    if not model.items and skus:
        model.items = [
            Item(sku=s, name=s, pick_freq=float(line_freq.get(s, 1) or 1),
                 ts_per_unit=_DEFAULT_TS_PER_UNIT, case_qty=1, stock=_DEFAULT_STOCK)
            for s in skus
        ]
        generated.append(f"商品マスタ {len(model.items)} 件を需要から生成")
        touched.add("items")
    # 2) Otherwise calibrate pick frequency from the real shipment lines.
    elif model.items and line_freq:
        n = 0
        for it in model.items:
            if it.sku in line_freq:
                it.pick_freq = float(line_freq[it.sku])
                n += 1
        if n:
            generated.append(f"ピック頻度を出荷実績から補正（{n} SKU）")

    # 3) Ensure every item is stockable so routing/KPIs are sane.
    fixed = 0
    for it in model.items:
        if not it.stock or it.stock <= 0:
            it.stock = _DEFAULT_STOCK
            fixed += 1
    if fixed:
        generated.append(f"在庫数の欠損を補完（{fixed} SKU）")
        touched.add("items")

    return {"generated": generated, "items": len(model.items),
            "subtrees": sorted(touched)}
