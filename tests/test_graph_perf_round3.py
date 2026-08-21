"""Round-3 scalability guard for the wall-aware routing graph.

BACKGROUND (the cliff this guards)
==================================
On a *large* walled floor (~240x160 m, ~7.7k locations) the engine queries
``AisleGraph.distance`` from thousands of *distinct* shelf positions. The old
code ran a full single-source Dijkstra over the ~17k-node grid for every distinct
source, so the per-source cache never amortised and the run exploded from ~3 s
(no wall, Manhattan fallback) to ~170-200 s with a single interior wall.

FIX (collapse sources to access nodes)
=======================================
Dijkstra *sources* are now snapped onto a small coarse "access" sub-lattice
(capped at ``graph.MAX_ACCESS``), so each access node is solved at most once for
the whole run; the short ``point -> access-node`` leg is added analytically, and
the access node is chosen so that leg never crosses a wall (otherwise a source
could land on the wrong side of a wall and detour spuriously). The target keeps
its exact fine-grid snap, so the wall-aware grid distance stays a true
shortest-path on the grid.

These tests assert three things:
1. CORRECTNESS -- on a small walled grid (collapse disabled) the optimized path
   matches a reference full-Dijkstra exactly, and on a large walled grid the
   collapse stays within a small bounded epsilon; the wall is respected.
2. PERF -- the large walled model runs ``run_replications`` well under budget
   (catches the old ~200 s cliff with headroom).
3. CACHE EFFECTIVENESS -- the number of full single-source solves is bounded by
   the access-node count and far below the thousands of distinct shelves.
"""

from __future__ import annotations

import math
import time

from whsim import templates
from whsim.design import materialize_racks
from whsim.engine import graph as graph_mod
from whsim.engine.graph import MAX_ACCESS, AisleGraph, _manhattan
from whsim.engine.run import run_replications
from whsim.schema.model import Item, Wall, WorkerGroup

# Generous budget: reference timing on the authoring machine is ~7-11 s for the
# optimized path; the OLD code took ~170-200 s. 30 s passes with headroom while
# still tripping on a return of the cliff.
LARGE_WALLED_BUDGET_S = 30.0


def _reference_distance(g: AisleGraph, a, b) -> float:
    """Exact wall-aware distance via a full per-source Dijkstra (no collapse).

    Mirrors the *original* ``AisleGraph.distance`` semantics: snap both endpoints
    to their nearest fine grid node and read the shortest grid path between them.
    """
    sa, off_a = g._snap(a)
    sb, off_b = g._snap(b)
    dist, _ = g._dijkstra(sa)
    d = dist.get(sb)
    if d is None or d == float("inf"):
        return _manhattan(a, b)
    return d + off_a + off_b


def _large_walled_model():
    """The large open-floor model from test_perf_scale + ONE interior wall."""
    m = templates.load_template_model("ecommerce_small")
    storage = next(z for z in m.layout.zones if z.id == "storage")
    storage.w = 200.0
    storage.h = 120.0
    storage.rack.col_spacing = 2.0
    storage.rack.row_spacing = 1.5
    m.layout.bounds.width = 240.0
    m.layout.bounds.depth = 160.0

    m.items = [
        Item(sku=f"SKU{i:05d}", name=f"item{i}", pick_freq=1.0, ts_per_unit=1.5, case_qty=1)
        for i in range(3000)
    ]
    materialize_racks(m)

    # A single vertical interior wall with a gap at the top -> wall-aware routing
    # (this is exactly the configuration that produced the ~70x cliff).
    m.layout.walls = [Wall(id="w1", points=[[120.0, 0.0], [120.0, 130.0]], thickness=0.3)]

    m.resources.workers = [
        WorkerGroup(id="pickers", role="picker", count=40, speed_mps=1.2),
        WorkerGroup(id="packers", role="packer", count=20, speed_mps=1.2),
    ]
    m.resources.stations[0].count = 20
    m.orders.profile.rate_per_hr = 1200.0
    m.simulation.duration_s = 28800.0  # full 8h shift
    m.simulation.replications = 1
    return m


# --------------------------------------------------------------- 1. CORRECTNESS


def test_small_walled_grid_matches_reference_exactly():
    """On a small grid (collapse disabled) the optimized distance is EXACT."""
    g = AisleGraph.from_layout(
        {"width": 30.0, "depth": 20.0},
        [{"points": [[15.0, 0.0], [15.0, 17.0]]}],  # vertical wall, gap at top
        resolution=1.0,
    )
    assert g.enabled
    # Small grid -> source collapse must be OFF so behaviour is unchanged/exact.
    assert not g._collapse_sources

    import random

    rng = random.Random(7)
    for _ in range(60):
        a = (rng.uniform(0, 30), rng.uniform(0, 20))
        b = (rng.uniform(0, 30), rng.uniform(0, 20))
        assert math.isclose(g.distance(a, b), _reference_distance(g, a, b), abs_tol=1e-9)

    # The wall is genuinely respected: crossing it costs more than Manhattan.
    a, b = (5.0, 5.0), (25.0, 5.0)
    assert g.distance(a, b) > _manhattan(a, b) + 5.0


def test_large_walled_grid_within_bounded_epsilon():
    """On a large grid the source collapse stays within a small bounded epsilon.

    The only approximation is the short ``point -> access-node`` source leg, which
    is bounded by roughly twice the access-lattice spacing. We assert both an
    absolute and a mean-relative bound against the exact reference Dijkstra, and
    that the wall is still respected.
    """
    g = AisleGraph.from_layout(
        {"width": 240.0, "depth": 160.0},
        [{"points": [[120.0, 0.0], [120.0, 130.0]]}],
        resolution=1.0,
    )
    assert g.enabled
    assert g._collapse_sources  # large grid -> collapse is ON

    access_spacing = g._access_stride * g.resolution
    # Absolute error is bounded by the source-leg detour (~2x access spacing) plus
    # a snap cell; give it generous slack so the test is stable, not flaky.
    abs_budget = 4.0 * access_spacing + 2.0

    import random

    rng = random.Random(11)
    errs: list[float] = []
    rels: list[float] = []
    for _ in range(400):
        a = (rng.uniform(0, 240), rng.uniform(0, 160))
        b = (rng.uniform(0, 240), rng.uniform(0, 160))
        opt = g.distance(a, b)
        ref = _reference_distance(g, a, b)
        e = abs(opt - ref)
        errs.append(e)
        if ref > 1.0:
            rels.append(e / ref)

    assert max(errs) <= abs_budget, (
        f"max abs error {max(errs):.1f} m exceeds budget {abs_budget:.1f} m "
        f"(access spacing {access_spacing:.1f} m) -- collapse path may be wrong"
    )
    mean_rel = sum(rels) / len(rels)
    assert mean_rel < 0.10, f"mean relative error {mean_rel*100:.1f}% too high"

    # Same-side, wall-crossing geometry must still detour (no shortcut through it).
    a, b = (20.0, 10.0), (220.0, 10.0)
    assert g.distance(a, b) > _manhattan(a, b) + 5.0


def test_access_node_never_crosses_wall():
    """A source just left of the wall must NOT snap to an access node on the right.

    This is the regression that, before the wall-free access check, produced a
    ~160 m spurious detour (source collapsed across the wall).
    """
    g = AisleGraph.from_layout(
        {"width": 240.0, "depth": 160.0},
        [{"points": [[120.0, 0.0], [120.0, 130.0]]}],
        resolution=1.0,
    )
    a = (115.5, 53.8)  # just LEFT of the wall, low enough to be below the gap
    b = (109.5, 18.6)  # also LEFT of the wall, short straight hop
    opt = g.distance(a, b)
    ref = _reference_distance(g, a, b)
    # Without the fix this was ~207 m vs a true ~43 m; assert it stays close.
    assert abs(opt - ref) < 30.0, f"opt {opt:.1f} vs ref {ref:.1f} -- crossed the wall"


# ----------------------------------------------------------------------- 2. PERF


def test_large_walled_model_runs_within_budget():
    """The large walled model runs run_replications fast (old code: ~200 s)."""
    m = _large_walled_model()
    assert len(m.locations) > 3000  # the model really is large
    assert m.layout.walls  # walls present -> grid routing, not Manhattan

    t0 = time.perf_counter()
    results, heat = run_replications(m, reps=1)
    elapsed = time.perf_counter() - t0

    assert elapsed < LARGE_WALLED_BUDGET_S, (
        f"large WALLED run took {elapsed:.1f}s (budget {LARGE_WALLED_BUDGET_S}s) "
        f"-- the routing scalability cliff may have returned"
    )

    # KPIs must still be finite and the run must actually do work.
    res = results[0]
    assert heat.size > 0 and math.isfinite(float(heat.sum()))
    assert res is not None


# ------------------------------------------------------------ 3. CACHE EFFECTIVE


def test_full_solves_bounded_by_access_nodes(monkeypatch):
    """Full single-source solves <= access-node count and << distinct shelves."""
    m = _large_walled_model()
    n_shelves = len(m.locations)

    # Capture the graph instance the engine actually builds and uses.
    captured: dict[str, AisleGraph] = {}
    orig_from_model = AisleGraph.from_model

    def _spy(model):
        g = orig_from_model(model)
        captured["g"] = g
        return g

    monkeypatch.setattr(graph_mod.AisleGraph, "from_model", staticmethod(_spy))
    # run_once imports the symbol via build; patching the class method is enough.
    from whsim.engine.run import run_once

    run_once(m, seed=1, replay_window_s=0.0)
    g = captured["g"]

    n_nodes = g.ncols * g.nrows
    stride = g._access_stride
    n_access = ((g.ncols + stride - 1) // stride) * ((g.nrows + stride - 1) // stride)

    assert g._collapse_sources, "large grid should collapse sources"
    assert n_access <= MAX_ACCESS
    # Each access node solved at most once; a few wall-boxed points fall back to
    # an exact fine snap, so allow modest slack above n_access but still far below
    # the thousands of distinct shelves.
    assert g.solve_count <= n_access + MAX_ACCESS, (
        f"{g.solve_count} solves vs ~{n_access} access nodes -- cache not amortising"
    )
    assert g.solve_count < n_shelves / 5, (
        f"{g.solve_count} solves should be FAR below {n_shelves} distinct shelves"
    )
    # Sanity: the grid really is large enough to have tripped the old cliff.
    assert n_nodes > 10000
