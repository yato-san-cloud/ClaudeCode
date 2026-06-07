"""Group the materialized location grid into *shelf runs* — the MapMaker way.

whsim stores storage as a flat list of `Location` points (one per slot, generated
from a zone's parametric RackFill). Rendering each point as a lone dot reads as
noise. MapMaker (Hitachi WorldMap) instead authors **SHELF areas** — rectangular
rack runs subdivided into addressed cells. This helper reconstructs that view:

There are two paths, picked automatically:

1. **Authored** (preferred): when storage zones carry hand-placed `ShelfArea`s
   (`zone.shelves`, drawn/imported via MapMaker), emit *one run per authored
   shelf* so a free-placed shelf renders as its real rectangle — never merged
   with a neighbour that happens to share an X. Each cell is matched back to the
   concrete `Location` it generated (by proximity) so it carries the real SKU /
   qty / name for the 3D pick-event labels.

2. **Reconstructed** (fallback): when there are NO authored shelves (legacy
   whole-zone RackFill or imported point clouds), columns of slots sharing an X
   become one shelf-run rectangle, as before.

Both paths emit the SAME run dict shape so every downstream consumer
(`render/replay.py`, `render/png2d.py`, the 2D canvas) keeps working:

    {x, y0, y1, depth, pitch, rack_type, cells:[{y, abc, rack_type, ...}]}

The authored path *additionally* carries `name`, `facing` (run-level) and
`sku`, `qty`, `name` (per cell) — purely additive, ignored by old consumers.
"""

from __future__ import annotations

from collections import defaultdict

from whsim import racktypes


def _min_gap(vals: list[float], default: float) -> float:
    """Smallest positive spacing in a sorted-unique sequence (rack pitch)."""
    u = sorted(set(round(v, 3) for v in vals))
    gaps = [b - a for a, b in zip(u, u[1:]) if b - a > 1e-6]
    return min(gaps) if gaps else default


def _abc_of(loc, by_sku) -> str:
    """ABC class for a slot, defaulting to C when its SKU is unknown/empty."""
    sku = getattr(loc, "sku", None)
    if sku and sku in by_sku:
        return by_sku[sku].abc_class
    return "C"


def _authored_runs(model, by_sku) -> list[dict]:
    """One run per hand-authored `ShelfArea` across all storage zones.

    A `ShelfArea` is an axis-aligned rectangle `(x, y, w, h)` in metres. We map it
    onto the existing column-run contract so 2D/PNG keep drawing thin rectangles:

      * vertical shelf (h >= w): the run spans Y (`y0..y1`), centred on its X, with
        `depth = w`. This is the natural orientation — bays stack along the run.
      * horizontal shelf (w > h): there is no horizontal run primitive, so we
        approximate — keep `depth = min(w, h)` (the thin axis) and span the LONG
        axis in Y anyway, centred on the rectangle's X. The 3D rebuild reads the
        authored rect + `facing` directly (see view3d), so this approximation only
        affects the 2D fallback drawing, never the 3D realism.

    Cells are the concrete `Location`s that fall inside the rectangle (the ones
    `design.materialize_racks` generated from this shelf). Each cell is projected
    onto the run's Y axis and carries its real ABC / SKU / qty / name so the 3D
    pick-event viz can label the exact slot. A shelf with no materialised
    locations yet still yields an (empty-celled) run so it renders as a rectangle.
    """
    # Index every storage Location by rounded position for fast point-in-rect
    # assignment (locations don't back-reference their authoring shelf).
    locs = [loc for loc in (getattr(model, "locations", []) or [])]
    runs: list[dict] = []

    for z in model.layout.zones:
        if z.type != "storage" or not getattr(z, "shelves", None):
            continue
        for sh in z.shelves:
            x0, y0r, w, h = sh.x, sh.y, max(sh.w, 1e-3), max(sh.h, 1e-3)
            rtid = getattr(sh, "rack_type", None) or racktypes.DEFAULT
            vertical = h >= w
            depth = w if vertical else min(w, h)
            cx = x0 + w / 2.0
            # The run spans the long axis in Y regardless of orientation, so a 2D
            # rectangle of the right footprint is always drawn.
            run_y0 = y0r if vertical else y0r + (h - max(w, h)) / 2.0
            span = h if vertical else max(w, h)
            run_y1 = run_y0 + span

            # Collect the Locations inside this shelf rectangle (small epsilon so
            # cells centred on the boundary still count).
            eps = 1e-6
            inside = [
                loc for loc in locs
                if x0 - eps <= loc.x <= x0 + w + eps
                and y0r - eps <= loc.y <= y0r + h + eps
            ]
            inside.sort(key=lambda loc: (loc.y, loc.x))

            cells: list[dict] = []
            for loc in inside:
                # Project the cell onto the run's Y axis: for a vertical shelf that
                # is just loc.y; for a horizontal one map its long-axis position so
                # cells distribute along the (rotated) run.
                cy = loc.y if vertical else (run_y0 + (loc.x - x0))
                cells.append({
                    "y": round(cy, 3),
                    "abc": _abc_of(loc, by_sku),
                    "rack_type": getattr(loc, "rack_type", rtid) or rtid,
                    "sku": getattr(loc, "sku", None),
                    "qty": int(getattr(loc, "qty", 0) or 0),
                    "name": getattr(loc, "name", "") or "",
                })

            # Pitch: the authored bay/cell size from the rack type (or override),
            # so per-cell highlight rectangles size correctly even before slots
            # are materialised. Falls back to the run's own cell spacing.
            rt = racktypes.get(rtid)
            pitch = sh.cell_w or rt["bay"]
            if len(cells) >= 2:
                pitch = _min_gap([c["y"] for c in cells], pitch)

            runs.append({
                "x": round(cx, 3),
                "y0": round(run_y0, 3),
                "y1": round(run_y1, 3),
                "depth": round(depth, 3),
                "pitch": round(pitch, 3),
                "rack_type": rtid,
                "name": getattr(sh, "name", "") or "",
                "facing": getattr(sh, "facing", "down") or "down",
                # Authored rectangle in floor metres + orientation, so the 3D
                # rebuild can place bays exactly (additive; 2D ignores these).
                "rect": {"x": round(x0, 3), "y": round(y0r, 3),
                         "w": round(w, 3), "h": round(h, 3)},
                "vertical": bool(vertical),
                "cells": cells,
            })
    return runs


def _reconstructed_runs(model, by_sku) -> list[dict]:
    """Legacy column-reconstruction: group flat slots into runs by shared X.

    Used when no storage zone carries authored shelves (whole-zone RackFill or
    imported point clouds). Identical behaviour to the original `shelf_runs`.
    """
    locs = list(getattr(model, "locations", []) or [])
    if not locs:
        return []
    xs = [loc.x for loc in locs]
    ys = [loc.y for loc in locs]
    pitch_x = _min_gap(xs, 4.0)
    pitch_y = _min_gap(ys, 1.0)
    depth = max(0.3, min(pitch_x * 0.42, 1.5))
    pad = pitch_y * 0.5

    cols: dict[float, list] = defaultdict(list)
    for loc in locs:
        cols[round(loc.x, 1)].append(loc)

    runs: list[dict] = []
    for x, items in sorted(cols.items()):
        items.sort(key=lambda loc: loc.y)
        cells = [
            {"y": round(loc.y, 3),
             "abc": _abc_of(loc, by_sku),
             "rack_type": getattr(loc, "rack_type", "medium"),
             # Additive per-cell detail (mirrors the authored path) so the 3D
             # pick-event labels work in the reconstructed case too.
             "sku": getattr(loc, "sku", None),
             "qty": int(getattr(loc, "qty", 0) or 0),
             "name": getattr(loc, "name", "") or ""}
            for loc in items
        ]
        y0 = items[0].y - pad
        y1 = items[-1].y + pad
        rtid = getattr(items[0], "rack_type", "medium")  # a column is one shelf type
        runs.append({"x": round(x, 3), "y0": round(y0, 3), "y1": round(y1, 3),
                     "depth": round(depth, 3), "pitch": round(pitch_y, 3),
                     "rack_type": rtid, "cells": cells})
    return runs


def shelf_runs(model) -> list[dict]:
    """Return rack runs: [{x, y0, y1, depth, pitch, rack_type, cells:[…]}, …].

    Prefers the **authored** path (one run per hand-placed `ShelfArea`) so
    free-placed MapMaker shelves render as their real rectangles. Falls back to
    the legacy column reconstruction when no storage zone carries shelves. Both
    paths share the run-dict shape, so every existing consumer keeps working; the
    authored path layers on `name`/`facing` (run) and `sku`/`qty`/`name` (cell).
    """
    by_sku = model.item_by_sku()
    authored = bool(any(
        z.type == "storage" and getattr(z, "shelves", None)
        for z in model.layout.zones
    ))
    if authored:
        return _authored_runs(model, by_sku)
    return _reconstructed_runs(model, by_sku)
