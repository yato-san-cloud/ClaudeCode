"""Design-side helpers: turn an edited layout into runnable detail.

The interactive editor manipulates high-level intent (zones, rack spacing,
equipment positions, per-stage methods). `materialize_racks` expands that intent
into the concrete `locations` grid the engine needs, and re-pegs item SKUs onto
the regenerated slots so a layout edit immediately changes routing and the heatmap.
"""

from __future__ import annotations

from whsim import racktypes
from whsim.schema.model import Item, Location, WarehouseModel

# --- structured 棚番号 (location address) ------------------------------------
# Addresses are 通路-連-段 (aisle-bay-level), e.g. "A03-12-2": an aisle LETTER
# from an x-band, a 連 (bay) NUMBER from position along the run, and a 段 (level)
# suffix. They are derived purely from a cell's geometry (x,y) and its level, so
# they are deterministic and STABLE across a re-materialize — the slotting and
# pick-sequence features sort by them.

AISLE_BAND_M = 4.0  # metres of x per aisle letter (one letter ~ one rack run + aisle)


def _aisle_letter(idx: int) -> str:
    """Spreadsheet-style aisle label: 0->A .. 25->Z, 26->AA, 27->AB ..."""
    idx = max(0, int(idx))
    s = ""
    while True:
        s = chr(ord("A") + idx % 26) + s
        idx = idx // 26 - 1
        if idx < 0:
            break
    return s


def _address(x: float, y: float, level: int, x0: float) -> str:
    """Deterministic 通路-連-段 address for a cell at (x,y), 段 `level`.

    通路 = aisle letter from the x-band (relative to the floor origin x0); 連 =
    bay number from the y-position along the run (1-based, 2-digit). Both come
    from rounded geometry only, so re-materialising the same layout reproduces
    the exact same address."""
    aisle_idx = int((x - x0) // AISLE_BAND_M)
    bay = int(round(y / 0.5)) + 1  # 0.5 m bay granularity along the run
    return f"{_aisle_letter(aisle_idx)}{aisle_idx + 1:02d}-{bay:02d}-{level}"


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

    # Each (x,y) bay expands into one slot PER LEVEL (段). A slot carries its
    # storage-equipment type, its per-LEVEL capacity (the bay capacity divided
    # across the rack_type's levels), the level number, the propagated shelf
    # name and a structured 棚番号 address. The type/capacity flow through to
    # routing, capacity and the rendered shelf colour.
    x0 = 0.0  # floor origin x (the layout bounds are 0-anchored)
    slots: list[tuple[float, float, str, int, int, str, str]] = []
    for z in storage_zones:
        if z.shelves:
            for sh in z.shelves:
                rtid = getattr(sh, "rack_type", None) or racktypes.DEFAULT
                rt = racktypes.get(rtid)
                levels = max(1, int(rt.get("levels", 1)))
                # divide the bay capacity across stacked levels (>=1 each)
                cap_per_level = max(1, int(rt["capacity"] // levels))
                cells = _shelf_slots(sh)
                base_name = getattr(sh, "name", "") or ""
                multi = len(cells) > 1
                for j, (x, y) in enumerate(cells):
                    bay_name = ("" if not base_name
                                else f"{base_name}-{j + 1:02d}" if multi else base_name)
                    for lvl in range(1, levels + 1):
                        addr = _address(x, y, lvl, x0)
                        # propagate the authored shelf name onto level 1; deeper
                        # levels get the 段-suffixed name so each location is unique.
                        nm = ("" if not bay_name
                              else bay_name if lvl == 1 else f"{bay_name}-{lvl}")
                        slots.append((x, y, rtid, cap_per_level, lvl, nm, addr))
        elif z.rack is not None:
            # Legacy whole-zone rack fill: a flat case-pick grid with no per-slot
            # equipment, so it stays SINGLE-level (段=1). Only authored SHELF
            # blocks (which carry a rack_type, i.e. 保管設備) stack by level. Each
            # cell still gets a structured 棚番号.
            for (x, y) in _zone_slots(z):
                addr = _address(x, y, 1, x0)
                slots.append((x, y, racktypes.DEFAULT, 100, 1, "", addr))

    # Degenerate rack params (e.g. margin larger than the zone) can yield zero
    # slots. Regenerating would delete every existing location and orphan all
    # item SKUs, breaking routing. The tolerant choice is to leave the model
    # untouched so nothing is silently destroyed.
    if not slots:
        return model

    # Disambiguate any address collisions (two bays can fall in the same x-band
    # and y-position) with a deterministic suffix. Slot order is stable (zones ->
    # shelves -> cells -> levels), so the suffix is reproducible across a
    # re-materialize, keeping every address unique AND stable.
    seen: dict[str, int] = {}
    deduped: list[tuple[float, float, str, int, int, str, str]] = []
    for (x, y, rtid, cap, lvl, nm, addr) in slots:
        n = seen.get(addr, 0)
        seen[addr] = n + 1
        if n:
            addr = f"{addr}#{n + 1}"
        deduped.append((x, y, rtid, cap, lvl, nm, addr))
    slots = deduped

    # Keep any locations that belong to non-racked storage (rare); drop racked ones.
    kept = [loc for loc in model.locations
            if loc.zone not in {z.id for z in storage_zones} and loc.zone != "storage"]

    new_locs: list[Location] = list(kept)
    diag = (model.layout.bounds.width + model.layout.bounds.depth) or 1.0
    base = len(kept)
    for i, (x, y, rtid, cap, lvl, nm, addr) in enumerate(slots):
        new_locs.append(Location(id=f"L{i:04d}", name=nm, address=addr, level=lvl,
                                 zone="storage", x=x, y=y, type="shelf",
                                 rack_type=rtid, capacity=cap))

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
