"""The DRAWN rack footprints — one geometry truth for rendering *and* routing.

The 2D PNG, the 3D view and the 2D canvas all draw storage from
``render.shelves.shelf_runs`` (authored ``ShelfArea``s when present, otherwise a
reconstruction of the materialized ``model.locations`` grid). The routing graph
(``engine.graph.AisleGraph``) used to derive its impassable rectangles from the
authored shelves ONLY, so a parametric model — every bundled template — routed
agents *straight through* the racking it draws.

This module is the neutral place both sides meet: it converts the very same runs
into plain ``(x, y, w, h)`` floor rectangles, so "the drawn map IS the routing
truth" holds for parametric racks too. It deliberately owns no geometry of its
own beyond the run→rect projection; the run reconstruction itself stays in
``render.shelves`` (imported lazily, so importing the engine never drags in
matplotlib via ``whsim.render.__init__``).
"""

from __future__ import annotations

import statistics


def _run_rect(run: dict) -> tuple[float, float, float, float] | None:
    """Project one shelf run onto its axis-aligned floor rectangle.

    Authored runs carry the authored rectangle verbatim (``rect``); reconstructed
    runs describe a column centred on ``x`` with ``depth`` across and ``y0..y1``
    along — exactly the rectangle ``render/png2d`` and the canvas draw.
    """
    r = run.get("rect")
    if r:
        x, y, w, h = float(r["x"]), float(r["y"]), float(r["w"]), float(r["h"])
    else:
        depth = float(run.get("depth", 0.0) or 0.0)
        y0 = float(run.get("y0", 0.0))
        y1 = float(run.get("y1", 0.0))
        x = float(run.get("x", 0.0)) - depth / 2.0
        y, w, h = y0, depth, y1 - y0
    if w <= 1e-6 or h <= 1e-6:
        return None
    return (x, y, w, h)


def rack_rects(model) -> list[tuple[float, float, float, float]]:
    """Every drawn rack run as an ``(x, y, w, h)`` rectangle in floor metres.

    Never raises: a model with no storage (or a render helper that cannot make
    sense of it) simply yields no obstacles, so callers keep working.
    """
    try:
        from whsim.render.shelves import shelf_runs   # lazy: avoids an import cycle
        runs = shelf_runs(model) or []
    except Exception:      # noqa: BLE001 — geometry is advisory, never fatal
        return []
    out: list[tuple[float, float, float, float]] = []
    for run in runs:
        try:
            rect = _run_rect(run)
        except (TypeError, ValueError, KeyError, AttributeError):
            continue
        if rect is not None:
            out.append(rect)
    return out


def aisle_block(model) -> dict | None:
    """Coarse parallel-aisle description of the DRAWN racking (``None`` if bare).

    A rack run is a long thin rectangle; the aisles run parallel to its long
    side and the cross-aisles sit at the run's two ends (a run BROKEN by a
    middle cross-aisle already arrives here as two shorter rects, so the
    reconstruction handles cross-aisles for free). What the travel maths needs
    from that picture is small:

    * ``run_len_m`` (ℓ) — how far along an aisle an agent may have to walk to
      reach a cross-aisle,
    * ``span0/span1`` — where that run band sits on the along-aisle axis, and
    * ``n_aisles``    — how many distinct aisle columns the racking forms.

    Mixed orientations are resolved by majority: the minority runs are dropped
    rather than averaged into a meaningless length. Never raises.
    """
    rects = rack_rects(model)
    if not rects:
        return None
    along_y = [r for r in rects if r[3] >= r[2]]
    along_x = [r for r in rects if r[3] < r[2]]
    group, axis = ((along_y, "y") if len(along_y) >= len(along_x) else (along_x, "x"))
    if not group:
        return None
    # (i_origin, i_length) index the along-aisle origin/extent of a (x, y, w, h).
    i_o, i_l = (1, 3) if axis == "y" else (0, 2)
    lengths = [r[i_l] for r in group]
    run_len = statistics.fmean(lengths)
    if run_len <= 1e-6:
        return None
    span0 = min(r[i_o] for r in group)
    span1 = max(r[i_o] + r[i_l] for r in group)
    # Distinct aisle columns: runs sharing a cross-axis centre are one column.
    j_o, j_l = (0, 2) if axis == "y" else (1, 3)
    centres = {round(r[j_o] + r[j_l] / 2.0, 2) for r in group}
    return {
        "axis": axis,
        "run_len_m": run_len,
        "span0": span0,
        "span1": span1,
        "n_runs": len(group),
        "n_aisles": max(1, len(centres)),
    }


def aisle_detour(model, depot: tuple[float, float]) -> dict | None:
    """Metres of along-aisle travel the aisle network adds over Manhattan.

    Manhattan says an agent walks straight through the racking. It cannot: to
    change aisle it must first walk OUT of its own aisle to a cross-aisle, then
    back IN along the destination aisle. With cross-aisles at the two ends of a
    run of length ℓ and slot positions uniform along it, that costs, in
    expectation:

    * ``hop_extra_m`` = **ℓ/3** for a leg between two slots in different aisles.
      Manhattan charges E|u₁-u₂| = ℓ/3 of along-aisle travel; the real route
      costs E[min(u₁+u₂, 2ℓ-u₁-u₂)] = 2ℓ/3, so the aisle network adds ℓ/3.
    * ``depot_extra_m`` = **2·d·(ℓ-d)/ℓ** for a leg to/from a depot outside the
      rack band, where ``d`` is how far the depot sits INTO the run's span along
      the aisle axis. Same derivation with one endpoint pinned: the route costs
      ℓ - E|u - (ℓ-d)| against Manhattan's E|u - d|. It is 0 when the depot
      faces a run end (nothing to detour around, d = 0 or ℓ) and peaks at ℓ/2
      when the depot faces the middle of the band — exactly the intuition that a
      cross-docked depot beside the aisle ends is cheap to reach.

    Both are ADDITIVE constants per leg, independent of the leg's length, which
    is what makes the closed form cheap (no graph search: it reads the drawn
    rack rectangles only) and stable under drag-time re-estimation.

    Returns ``None`` when there is no racking to route around — callers then
    keep the plain Manhattan behaviour ("never blocks").
    """
    blk = aisle_block(model)
    if blk is None:
        return None
    ell = blk["run_len_m"]
    span = max(blk["span1"] - blk["span0"], 1e-6)
    q = float(depot[1] if blk["axis"] == "y" else depot[0])
    # How far into the run band the depot sits, rescaled onto one run's length
    # (identical for the usual single-band layout, sane for staggered bands).
    d = min(max(q - blk["span0"], 0.0), span) * (ell / span)
    return {
        **blk,
        "depot_extra_m": 2.0 * d * (ell - d) / ell,
        "hop_extra_m": ell / 3.0,
    }


def rack_facings(model) -> list[str | None]:
    """Authored ``facing`` per rect from :func:`rack_rects` (``None`` when unset)."""
    try:
        from whsim.render.shelves import shelf_runs
        runs = shelf_runs(model) or []
    except Exception:      # noqa: BLE001
        return []
    out: list[str | None] = []
    for run in runs:
        if _run_rect(run) is not None:
            out.append(run.get("facing") or None)
    return out
