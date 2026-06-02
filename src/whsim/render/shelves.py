"""Group the materialized location grid into *shelf runs* — the MapMaker way.

whsim stores storage as a flat list of `Location` points (one per slot, generated
from a zone's parametric RackFill). Rendering each point as a lone dot reads as
noise. MapMaker (Hitachi WorldMap) instead authors **SHELF areas** — rectangular
rack runs subdivided into addressed cells. This helper reconstructs that view:
columns of slots sharing an X become one shelf-run rectangle whose cells carry
their ABC class, so 2D/PNG can draw racks as blocks, not scatter.
"""

from __future__ import annotations

from collections import defaultdict


def _min_gap(vals: list[float], default: float) -> float:
    """Smallest positive spacing in a sorted-unique sequence (rack pitch)."""
    u = sorted(set(round(v, 3) for v in vals))
    gaps = [b - a for a, b in zip(u, u[1:]) if b - a > 1e-6]
    return min(gaps) if gaps else default


def shelf_runs(model) -> list[dict]:
    """Return rack runs: [{x, y0, y1, depth, cells:[{y, abc}]}, …].

    Slots are grouped into vertical runs by shared X (aisles sit between columns,
    matching RackFill.col_spacing). Each run is a thin rectangle centred on its X,
    spanning its slots in Y; cells keep per-slot ABC so the run can be tinted by
    bay. Falls back gracefully on irregular/imported grids (a stray slot just
    becomes a one-cell run).
    """
    locs = list(getattr(model, "locations", []) or [])
    if not locs:
        return []
    by_sku = model.item_by_sku()
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
             "abc": (by_sku[loc.sku].abc_class if loc.sku in by_sku else "C")}
            for loc in items
        ]
        y0 = items[0].y - pad
        y1 = items[-1].y + pad
        runs.append({"x": round(x, 3), "y0": round(y0, 3), "y1": round(y1, 3),
                     "depth": round(depth, 3), "pitch": round(pitch_y, 3),
                     "cells": cells})
    return runs
