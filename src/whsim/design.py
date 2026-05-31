"""Design-side helpers: turn an edited layout into runnable detail.

The interactive editor manipulates high-level intent (zones, rack spacing,
equipment positions, per-stage methods). `materialize_racks` expands that intent
into the concrete `locations` grid the engine needs, and re-pegs item SKUs onto
the regenerated slots so a layout edit immediately changes routing and the heatmap.
"""

from __future__ import annotations

from whsim.schema.model import Item, Location, WarehouseModel


def _zone_slots(zone) -> list[tuple[float, float]]:
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
                     if z.type == "storage" and z.rack is not None]
    if not storage_zones:
        return model

    # Reference point for ABC placement: the first pack station (fast movers near).
    station = model.resources.stations[0] if model.resources.stations else None
    ref = (station.x, station.y) if station else (0.0, 0.0)

    slots: list[tuple[float, float]] = []
    for z in storage_zones:
        slots.extend(_zone_slots(z))

    # Keep any locations that belong to non-racked storage (rare); drop racked ones.
    kept = [loc for loc in model.locations
            if loc.zone not in {z.id for z in storage_zones} and loc.zone != "storage"]

    new_locs: list[Location] = list(kept)
    diag = (model.layout.bounds.width + model.layout.bounds.depth) or 1.0
    base = len(kept)
    for i, (x, y) in enumerate(slots):
        new_locs.append(Location(id=f"L{i:04d}", zone="storage", x=x, y=y,
                                 type="shelf", capacity=100))

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
