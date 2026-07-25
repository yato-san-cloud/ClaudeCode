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
