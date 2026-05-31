"""Slotting: assign the loaded inventory (SKUs) to the created storage locations.

This is the last mile of the layout-creation flow: a salesperson draws racks
(which `design.materialize_racks` turns into concrete locations), then "assigns
the loaded inventory" -- here. The default strategy is velocity/ABC slotting:
the fastest-moving SKUs go to the locations closest to the pack station, which
is the single biggest lever on picker walking distance.
"""

from __future__ import annotations

from whsim.engine.routing import manhattan
from whsim.schema.model import WarehouseModel


def assign_inventory(model: WarehouseModel, strategy: str = "abc") -> dict:
    """Peg every SKU to a storage location and return a summary.

    strategy:
      "abc"      -- fastest movers (highest pick_freq) nearest the pack station
      "compact"  -- fill locations in id order (simple, keeps SKUs together)
    Locations beyond the SKU count stay empty; SKUs beyond the location count are
    left unassigned (reported), so the result is honest about capacity.
    """
    storage = [loc for loc in model.locations if loc.zone == "storage"] or model.locations
    if not storage or not model.items:
        return {"assigned": 0, "locations": len(storage), "skus": len(model.items),
                "unassigned": len(model.items), "fill_rate": 0.0, "strategy": strategy,
                "message": "ロケーションまたは商品データがありません。"}

    station = model.resources.stations[0] if model.resources.stations else None
    ref = (station.x, station.y) if station else (0.0, 0.0)

    # clear current pegging
    for loc in storage:
        loc.sku = None
        loc.qty = 0

    if strategy == "abc":
        items = sorted(model.items, key=lambda it: it.pick_freq, reverse=True)
        locs = sorted(storage, key=lambda loc: manhattan(ref, (loc.x, loc.y)))
    else:  # compact
        items = list(model.items)
        locs = sorted(storage, key=lambda loc: loc.id)

    n = min(len(items), len(locs))
    diag = (model.layout.bounds.width + model.layout.bounds.depth) or 1.0
    for i in range(n):
        it, loc = items[i], locs[i]
        loc.sku = it.sku
        loc.qty = it.stock if it.stock else it.case_qty
        it.default_location = loc.id
        # re-label ABC class by where it actually landed (near pack = A)
        rank = manhattan(ref, (loc.x, loc.y)) / diag
        it.abc_class = "A" if rank < 0.33 else ("B" if rank < 0.66 else "C")
    for it in items[n:]:
        it.default_location = None  # no slot available

    unassigned = max(0, len(items) - len(locs))
    return {
        "assigned": n,
        "locations": len(storage),
        "skus": len(model.items),
        "unassigned": unassigned,
        "fill_rate": round(n / len(storage), 3) if storage else 0.0,
        "strategy": strategy,
        "message": (f"{n}SKUを割付（{strategy}）。"
                    + (f" 容量不足で{unassigned}SKU未割付。" if unassigned else "")),
    }
