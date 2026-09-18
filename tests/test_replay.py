"""Replay-document congestion grid (2D canvas heatmap overlay).

`build_replay` additively emits a `congestion` key — a sparse, normalised
per-cell density grid mirroring the engine/png2d heat aggregation — so the
client can draw a heatmap that matches the proposal PNG. These tests pin its
shape, the [0,1] normalisation, index bounds, and empty/degenerate safety.
"""

from __future__ import annotations

from whsim import kpis, templates
from whsim.engine.run import run_once
from whsim.render.replay import build_replay
from whsim.schema.model import WarehouseModel


def _model(duration_s: float = 600.0) -> WarehouseModel:
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = duration_s
    return m


def test_congestion_present_and_well_formed():
    """A normal run emits a congestion grid: positive resolution, populated cells,
    every density in [0,1] with at least one full-intensity cell, and all indices
    inside [0,nx)×[0,ny)."""
    m = _model()
    res = run_once(m, seed=3)
    rep = build_replay(m, res, kpis.compute([res]))

    assert "congestion" in rep
    cg = rep["congestion"]
    assert cg["grid_m"] > 0
    assert cg["nx"] > 0 and cg["ny"] > 0

    cells = cg["cells"]
    assert cells, "agents moved, so at least one congestion cell is expected"
    assert len(cells) <= 400, "cell list must stay bounded/sparse"

    seen_peak = False
    for i, j, d in cells:
        assert isinstance(i, int) and isinstance(j, int)
        assert 0 <= i < cg["nx"]
        assert 0 <= j < cg["ny"]
        assert 0.0 <= d <= 1.0
        if d == 1.0:
            seen_peak = True
    assert seen_peak, "normalisation must make the busiest cell == 1.0"


def test_congestion_indices_unique():
    """Each (i, j) cell appears at most once (accumulated, not duplicated)."""
    m = _model()
    res = run_once(m, seed=5)
    rep = build_replay(m, res, kpis.compute([res]))
    keys = [(i, j) for i, j, _d in rep["congestion"]["cells"]]
    assert len(keys) == len(set(keys))


def test_congestion_empty_when_no_agents():
    """No workers/trajectories → congestion is still present with cells == [] and
    no crash (the client can always rely on the key). Bounds stay valid (so
    nx/ny are positive) but every agent track is stripped, isolating the
    "nothing moved" path from the degenerate-bounds path below."""
    m = WarehouseModel()
    res = run_once(m, seed=1)
    # Strip all recorded trajectories so no presence is ever accumulated.
    res.workers = []
    for attr in ("helpers", "packers", "inspectors", "agvs", "forklifts"):
        if hasattr(res, attr):
            setattr(res, attr, [])
    rep = build_replay(m, res, kpis.compute([res]))
    cg = rep["congestion"]
    assert cg["cells"] == []
    assert cg["grid_m"] > 0
    assert cg["nx"] > 0 and cg["ny"] > 0


def test_congestion_degenerate_bounds_safe():
    """Zero-sized floor must not divide by zero; cells empty, grid_m positive."""
    m = WarehouseModel()
    m.layout.bounds.width = 0.0
    m.layout.bounds.depth = 0.0
    res = run_once(m, seed=1)
    rep = build_replay(m, res, kpis.compute([res]))
    cg = rep["congestion"]
    assert cg["cells"] == []
    assert cg["grid_m"] > 0


def test_congestion_is_additive_keys_unchanged():
    """Adding congestion must not drop or rename any existing replay key."""
    m = _model(300.0)
    res = run_once(m, seed=2)
    rep = build_replay(m, res, kpis.compute([res]))
    for key in ("meta", "zones", "racks", "workers", "agvs", "series", "kpis"):
        assert key in rep
