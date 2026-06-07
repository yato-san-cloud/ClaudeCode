"""Design-side helpers: turn an edited layout into runnable detail.

The interactive editor manipulates high-level intent (zones, rack spacing,
equipment positions, per-stage methods). `materialize_racks` expands that intent
into the concrete `locations` grid the engine needs, and re-pegs item SKUs onto
the regenerated slots so a layout edit immediately changes routing and the heatmap.
"""

from __future__ import annotations

from whsim import racktypes
from whsim.schema.model import Item, Location, WarehouseModel


def _shelf_slots(shelf) -> list[tuple[float, float]]:
    """Cells filling one authored SHELF rectangle at its rack type's pitch.

    Bays run along the rectangle's long axis, racks are `depth` across the short
    axis (so a thin run = one column of bays). Explicit cell_w/cell_d override the
    preset; falls back to a single cell for a tiny area."""
    rt = racktypes.get(getattr(shelf, "rack_type", None))
    bay = max(shelf.cell_w or rt["bay"], 0.3)
    depth = max(shelf.cell_d or rt["depth"], 0.3)
    vertical = shelf.h >= shelf.w
    px = depth if vertical else bay   # pitch along x
    py = bay if vertical else depth   # pitch along y
    xs, ys = [], []
    x = shelf.x + px / 2
    while x <= shelf.x + shelf.w - px / 2 + 1e-9:
        xs.append(round(x, 3))
        x += px
    y = shelf.y + py / 2
    while y <= shelf.y + shelf.h - py / 2 + 1e-9:
        ys.append(round(y, 3))
        y += py
    if not xs:
        xs = [round(shelf.x + shelf.w / 2, 3)]
    if not ys:
        ys = [round(shelf.y + shelf.h / 2, 3)]
    return [(px_, py_) for px_ in xs for py_ in ys]


def _zone_slots(zone) -> list[tuple[float, float]]:
    """Legacy whole-zone rack fill (used when a storage zone has no shelves)."""
    rack = zone.rack
    if rack is None:
        return []
    cs = max(rack.col_spacing, 0.5)
    rs = max(rack.row_spacing, 0.5)
    m = max(rack.margin, 0.0)
    xs, ys = [], []
    x = zone.x + m
    while x <= zone.x + zone.w - m + 1e-9:
        xs.append(round(x, 3))
        x += cs
    y = zone.y + m
    while y <= zone.y + zone.h - m + 1e-9:
        ys.append(round(y, 3))
        y += rs
    return [(px, py) for px in xs for py in ys]


def materialize_racks(model: WarehouseModel) -> WarehouseModel:
    """Regenerate `locations` from storage zones' rack params, re-pegging SKUs.

    Storage zones without a `rack` config are left as-is (their existing
    locations are kept). If no storage zone is racked, the model is unchanged.
    """
    storage_zones = [z for z in model.layout.zones
                     if z.type == "storage" and (z.rack is not None or z.shelves)]
    if not storage_zones:
        return model

    # Reference point for ABC placement: the first pack station (fast movers near).
    station = model.resources.stations[0] if model.resources.stations else None
    ref = (station.x, station.y) if station else (0.0, 0.0)

    # Slots carry their storage-equipment type + per-cell capacity so the type
    # flows through to routing, capacity and the rendered shelf colour.
    slots: list[tuple[float, float, str, int, str]] = []
    for z in storage_zones:
        if z.shelves:
            for sh in z.shelves:
                rtid = getattr(sh, "rack_type", None) or racktypes.DEFAULT
                cap = racktypes.get(rtid)["capacity"]
                cells = _shelf_slots(sh)
                base_name = getattr(sh, "name", "") or ""
                multi = len(cells) > 1
                for j, (x, y) in enumerate(cells):
                    nm = ("" if not base_name
                          else f"{base_name}-{j + 1:02d}" if multi else base_name)
                    slots.append((x, y, rtid, cap, nm))
        elif z.rack is not None:
            for (x, y) in _zone_slots(z):
                slots.append((x, y, racktypes.DEFAULT, 100, ""))

    # Degenerate rack params (e.g. margin larger than the zone) can yield zero
    # slots. Regenerating would delete every existing location and orphan all
    # item SKUs, breaking routing. The tolerant choice is to leave the model
    # untouched so nothing is silently destroyed.
    if not slots:
        return model

    # Keep any locations that belong to non-racked storage (rare); drop racked ones.
    kept = [loc for loc in model.locations
            if loc.zone not in {z.id for z in storage_zones} and loc.zone != "storage"]

    new_locs: list[Location] = list(kept)
    diag = (model.layout.bounds.width + model.layout.bounds.depth) or 1.0
    base = len(kept)
    for i, (x, y, rtid, cap, nm) in enumerate(slots):
        new_locs.append(Location(id=f"L{i:04d}", name=nm, zone="storage", x=x, y=y,
                                 type="shelf", rack_type=rtid, capacity=cap))

    # Re-peg SKUs round-robin onto the regenerated slots so the engine can route.
    if model.items and slots:
        n = len(slots)
        for i, it in enumerate(model.items):
            loc = new_locs[base + (i % n)]
            it.default_location = loc.id
            loc.sku = it.sku
            # nearest slots host the A movers
            dist = abs(loc.x - ref[0]) + abs(loc.y - ref[1])
            rank = dist / diag
            it.abc_class = "A" if rank < 0.33 else ("B" if rank < 0.66 else "C")

    model.locations = new_locs
    return model


def synthesize_items(model: WarehouseModel, n: int = 0) -> WarehouseModel:
    """Ensure there is at least one SKU per racked slot so the sim has demand."""
    if model.items:
        return model
    skus = []
    for i, loc in enumerate(model.locations):
        sku = f"SKU{i:04d}"
        loc.sku = sku
        skus.append(Item(sku=sku, name=f"Item {i}", abc_class=loc.zone and "C" or "C",
                         pick_freq=1.0, ts_per_unit=1.5, default_location=loc.id))
    model.items = skus
    return model
