"""Real aisle-network routing over the warehouse floor.

The plain Manhattan distance (``engine.routing.manhattan``) assumes pickers can
walk in a straight L through anything. That over-states accuracy whenever
something is in the way — the building shell's internal walls (躯体), and above
all **the racking itself**. This module builds a 4-connected occupancy grid over
the floor, blocks edges that would cross a wall polyline or a rack footprint, and
answers shortest-path queries on it — so the flow-line distances and times are
trustworthy.

Obstacles = what is DRAWN (the fix this module was rebuilt around)
------------------------------------------------------------------
The obstacle set used to be the authored ``ShelfArea``s of each storage zone
only. **Parametric** racking — a zone's ``RackFill`` expanded by
``design.materialize_racks`` into ``model.locations`` — was invisible to it, and
that is every bundled template. The consequence was severe and measured: on
``retail_dc`` 82% of all travel legs cut through the racking (worst leg 53 m,
27% of all metres walked were inside rack footprints); on ``ecommerce_small``,
which has no walls at all, the graph was not even switched on, so 100% of legs
did. Travel was understated, therefore walking time was too low and
productivity/throughput too high — the proposal numbers were optimistic.

Obstacles are now taken from ``rackgeom.rack_rects``, the same run
reconstruction the 2D PNG, the canvas and the 3D view draw from. The drawn map
IS the routing truth, and the graph is enabled whenever anything obstructs
travel — racks alone are enough.

Contract (kept deliberately small so callers can fall back cheaply):

    g = AisleGraph.from_model(model)        # layout + drawn rack runs
    if g.enabled:                           # walls or racks -> routing matters
        d = g.distance((ax, ay), (bx, by))  # metres, around them
        pts = g.path((ax, ay), (bx, by))    # node centres for drawing/heat
    else:
        d = manhattan(a, b)                 # empty floor -> Manhattan is exact

``distance`` never returns ``inf``: if the destination is genuinely unreachable
on the grid it falls back to Manhattan, and ``path`` to the straight segment.
That fallback is a straight-through-the-racking answer, so it is **counted**
(``unroutable_count``) rather than silently swallowed — on a healthy layout it
must stay at zero, and endpoint snapping is built to guarantee that (see
``_nearest_reachable``).

Grid pitch: racks are solid at ANY pitch, because edge blocking is an exact
segment/rectangle test — a rack too thin to hold a node centre is still
un-steppable. The pitch therefore only has to keep genuine AISLES open, so it is
refined to about half the narrowest aisle (``min_aisle_gap``), floored at
``MIN_RESOLUTION_M`` and coarsened to respect ``MAX_NODES``.

Only stdlib + numpy. All grid edges cost one pitch, so the single-source solve is
a plain BFS; its distance map is cached so repeated queries from the same pick
locations (the common case) are amortised to a dict lookup.

Scalability (the load-bearing optimisation)
-------------------------------------------
A single-source solve yields the distance to *every* node, so it is cached per
source. The cliff was that on a large floor the simulation queries from thousands
of *distinct* shelf positions, so the per-source cache never amortises.

Fix: **collapse the solve sources to a small set of "access" nodes.** Access
nodes are a coarse sub-lattice of the fine grid (capped at ``MAX_ACCESS``). A
single multi-source BFS from the whole lattice (``_build_access``) labels every
node with its nearest access node and the EXACT walkable distance to it. A query
``distance(a, b)`` then snaps ``a`` to its aisle node, hops to that node's access
node, and reads the cached map of the access node; ``b`` keeps its exact fine
snap. So each access node is solved **at most once** for the entire run.

Because the ``a -> acc_a`` leg is measured on the graph rather than as a straight
line, it can never cut a corner through a rack or a wall — which is also what
makes the collapse survive a racked floor at all (a pick point sits inside its
rack, so no straight leg out of it is ever obstacle-free). The introduced error
is bounded by the access-lattice spacing and is always an over-estimate (triangle
inequality), never an under-estimate. On small grids the collapse is disabled
entirely and the exact per-source solve is used, so the classic correctness tests
are unaffected. Determinism is preserved throughout.
"""

from __future__ import annotations

from collections import deque
from math import hypot

from whsim.rackgeom import rack_rects


# Hard cap on grid nodes; resolution is coarsened automatically to stay under it
# so a huge floor never blows up memory / Dijkstra time.
MAX_NODES = 20000

# Default grid pitch (metres) for :meth:`AisleGraph.from_model`. Rack runs are
# ~0.8-1.5 m deep and aisles ~2.5-4 m, so a 1 m lattice puts at least two free
# node columns in every realistic aisle while a rack run is either occupied by a
# node centre or straddled by a blocked edge (see ``_build_occupancy``). Racks are
# solid at ANY resolution because edge blocking is an exact segment/rectangle
# test; the resolution only governs how well genuine aisles are resolved.
DEFAULT_RESOLUTION_M = 1.0

# Floor on the auto-refined grid pitch: below this the node count explodes long
# before the extra fidelity pays for itself.
MIN_RESOLUTION_M = 0.25

# Narrowest gap between two rack footprints that counts as a walkable aisle. A
# smaller gap is a construction tolerance / back-to-back seam, not a lane, so it
# must NOT drag the grid pitch down.
MIN_AISLE_M = 0.6

# Most rects the aisle-gap scan will consider (it is O(n^2) with a bbox reject).
# Above this the default pitch is kept — a floor with thousands of authored
# shelves is a MapMaker import, whose aisles were already routed at 1 m.
MAX_GAP_SCAN_RECTS = 400

# A node centre this close to (or inside) a rack footprint is treated as occupied.
# Purely a degeneracy guard: a node sitting exactly ON a rack edge has every
# incident edge blocked (a touching segment counts as a crossing), so it would be
# an isolated island that snapping could land on. Marking it occupied keeps
# snapping on real aisle nodes.
NODE_CLEARANCE_M = 0.05

# Hard cap on the number of distinct Dijkstra *source* (access) nodes. Sources
# are collapsed onto a coarse sub-lattice of the fine grid so each is solved at
# most once for the whole run. Bounds both runtime (few full solves) and memory
# (we only ever cache this many full N-vectors).
MAX_ACCESS = 512

# Only collapse sources onto the access lattice once the fine grid is big enough
# that thousands of distinct full solves would actually hurt. Below this, the
# exact per-source Dijkstra is cheap and is kept verbatim (preserves the classic
# correctness behaviour on small walled grids).
ACCESS_COLLAPSE_MIN_NODES = 2000

# Spatial-hash cell size (metres) for the wall-segment / obstacle indexes below.
# Coarse enough that short probes hit only a handful of cells, fine enough that
# a cell holds few segments even on a dense MapMaker floor.
_INDEX_CELL_M = 4.0


class _SegmentIndex:
    """Uniform-grid spatial hash over 2D segments (a pure candidate filter).

    A MapMaker-scale floor carries thousands of wall/shelf-perimeter segments;
    scanning all of them for every probe segment made graph construction and
    snapping O(probes x segments) — the multi-minute "freeze" on large imports.
    Each segment is binned into every cell its bounding box overlaps; a query
    returns the superset of segments whose bbox can touch the probe's bbox.
    Callers still run the exact intersection test on the candidates, so results
    are identical to the full scan, just without the O(N) sweep per probe.
    """

    def __init__(self, segments: list, cell: float = _INDEX_CELL_M) -> None:
        self._cell = max(float(cell), 1e-6)
        self._segments = segments
        self._grid: dict[tuple[int, int], list[int]] = {}
        for i, (a, b) in enumerate(segments):
            for key in self._cells(a, b):
                self._grid.setdefault(key, []).append(i)

    def _cells(self, a, b) -> list[tuple[int, int]]:
        c = self._cell
        x0 = int(min(a[0], b[0]) // c)
        x1 = int(max(a[0], b[0]) // c)
        y0 = int(min(a[1], b[1]) // c)
        y1 = int(max(a[1], b[1]) // c)
        return [(cx, cy) for cx in range(x0, x1 + 1) for cy in range(y0, y1 + 1)]

    def candidates(self, a, b) -> list:
        """Segments whose bbox cells overlap the probe segment's bbox cells."""
        keys = self._cells(a, b)
        grid = self._grid
        segs = self._segments
        if len(keys) == 1:
            return [segs[i] for i in grid.get(keys[0], ())]
        seen: set[int] = set()
        out = []
        for k in keys:
            for i in grid.get(k, ()):
                if i not in seen:
                    seen.add(i)
                    out.append(segs[i])
        return out


def _manhattan(a: tuple[float, float], b: tuple[float, float]) -> float:
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def min_aisle_gap(
    rects: list[tuple[float, float, float, float]],
    width: float,
    depth: float,
) -> float | None:
    """Narrowest walkable gap between rack footprints (and the floor edges).

    This is what a grid pitch has to resolve: a lattice coarser than the aisle can
    seal it, and a sealed aisle is a route that detours (or, worse, an endpoint
    that cannot be routed to at all). Only gaps of at least :data:`MIN_AISLE_M`
    count — a back-to-back seam is not a lane and must not drag the pitch down.

    Returns ``None`` when there is nothing to measure.
    """
    n = len(rects)
    if not n or n > MAX_GAP_SCAN_RECTS:
        return None
    best: float | None = None

    def keep(g: float) -> None:
        nonlocal best
        if g >= MIN_AISLE_M and (best is None or g < best):
            best = g

    for i in range(n):
        xi, yi, wi, hi = rects[i]
        # Gap to the floor edges (the perimeter aisles).
        keep(xi)
        keep(width - (xi + wi))
        keep(yi)
        keep(depth - (yi + hi))
        for j in range(i + 1, n):
            xj, yj, wj, hj = rects[j]
            # Along x, only rects that share some y span face each other.
            if min(yi + hi, yj + hj) - max(yi, yj) > 1e-9:
                keep(max(xj - (xi + wi), xi - (xj + wj)))
            if min(xi + wi, xj + wj) - max(xi, xj) > 1e-9:
                keep(max(yj - (yi + hi), yi - (yj + hj)))
    return best


def simplify_collinear(pts: list[tuple[float, float]], eps: float = 1e-6) -> list:
    """Drop interior waypoints that lie on the segment of their neighbours.

    Grid paths are runs of 1-cell steps; collapsing collinear runs turns a
    200-point Dijkstra chain into the handful of corner vertices a human would
    draw — small to store (model.routes) and clean to render (2D/3D 動線).
    """
    if len(pts) <= 2:
        return list(pts)
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        (ax, ay), (bx, by), (cx, cy) = out[-1], pts[i], pts[i + 1]
        cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        if abs(cross) <= eps and min(ax, cx) - eps <= bx <= max(ax, cx) + eps \
                and min(ay, cy) - eps <= by <= max(ay, cy) + eps:
            continue                      # b sits on segment a→c: drop it
        out.append(pts[i])
    out.append(pts[-1])
    return out


def _ccw(ax, ay, bx, by, cx, cy) -> float:
    """Twice the signed area of triangle (a, b, c); sign = orientation."""
    return (by - ay) * (cx - ax) - (bx - ax) * (cy - ay)


def _on_segment(ax, ay, bx, by, px, py, eps: float = 1e-9) -> bool:
    """Is point p on segment a-b, given collinearity already established?"""
    return (
        min(ax, bx) - eps <= px <= max(ax, bx) + eps
        and min(ay, by) - eps <= py <= max(ay, by) + eps
    )


def _segments_intersect(p1, p2, p3, p4, eps: float = 1e-9) -> bool:
    """Robust 2D segment intersection test for p1-p2 vs p3-p4.

    Handles the general (proper crossing) case via orientation signs and the
    degenerate collinear/touching cases via on-segment checks. Returns True if
    the two closed segments share any point.
    """
    x1, y1 = p1
    x2, y2 = p2
    x3, y3 = p3
    x4, y4 = p4

    d1 = _ccw(x3, y3, x4, y4, x1, y1)
    d2 = _ccw(x3, y3, x4, y4, x2, y2)
    d3 = _ccw(x1, y1, x2, y2, x3, y3)
    d4 = _ccw(x1, y1, x2, y2, x4, y4)

    # Proper crossing: endpoints of each segment straddle the other line.
    if ((d1 > eps and d2 < -eps) or (d1 < -eps and d2 > eps)) and (
        (d3 > eps and d4 < -eps) or (d3 < -eps and d4 > eps)
    ):
        return True

    # Collinear / touching endpoint cases.
    if abs(d1) <= eps and _on_segment(x3, y3, x4, y4, x1, y1, eps):
        return True
    if abs(d2) <= eps and _on_segment(x3, y3, x4, y4, x2, y2, eps):
        return True
    if abs(d3) <= eps and _on_segment(x1, y1, x2, y2, x3, y3, eps):
        return True
    if abs(d4) <= eps and _on_segment(x1, y1, x2, y2, x4, y4, eps):
        return True
    return False


class AisleGraph:
    """4-connected occupancy grid over the floor with wall-aware routing."""

    def __init__(
        self,
        width: float,
        depth: float,
        wall_segments: list[tuple[tuple[float, float], tuple[float, float]]],
        resolution: float = 1.0,
        obstacle_rects: list[tuple[float, float, float, float]] | None = None,
        auto_resolution: bool = False,
    ) -> None:
        self.width = max(float(width), 1e-6)
        self.depth = max(float(depth), 1e-6)
        # Shelf/rack footprints are impassable: pickers detour down the aisles.
        # Treat each rectangle's perimeter as walls (so crossing into it is blocked)
        # and remember the rects so endpoints snap to the nearest *aisle* node.
        self._obstacles: list[tuple[float, float, float, float]] = list(obstacle_rects or [])
        obstacle_segments: list[tuple[tuple[float, float], tuple[float, float]]] = []
        for (rx, ry, rw, rh) in self._obstacles:
            cs = [(rx, ry), (rx + rw, ry), (rx + rw, ry + rh), (rx, ry + rh)]
            for i in range(4):
                obstacle_segments.append((cs[i], cs[(i + 1) % 4]))
        wall_segments = list(wall_segments) + obstacle_segments
        self._has_walls = len(wall_segments) > 0

        # Grid pitch. Racks are solid at ANY pitch (edge blocking is an exact
        # segment/rectangle test), so the pitch only has to be fine enough to keep
        # genuine AISLES open: refine it to about half the narrowest aisle, never
        # coarser than the caller asked for and never below MIN_RESOLUTION_M.
        # Opt-in (``from_model``): a caller that pins a pitch — e.g. the display
        # network endpoint, which sizes the grid for a drawable payload — keeps it.
        res = float(resolution) if resolution and resolution > 0 else 1.0
        self.aisle_gap = (min_aisle_gap(self._obstacles, self.width, self.depth)
                          if auto_resolution else None)
        if self.aisle_gap is not None and self.aisle_gap / 2.0 < res:
            res = max(self.aisle_gap / 2.0, MIN_RESOLUTION_M)
        # ...then coarsen if the node count would blow past the cap. Node count is
        # roughly (width/res + 1) * (depth/res + 1).
        while True:
            ncols = int(self.width / res) + 1
            nrows = int(self.depth / res) + 1
            if ncols * nrows <= MAX_NODES or res > max(self.width, self.depth):
                break
            res *= 1.5
        self.resolution = res
        self.ncols = max(int(self.width / res) + 1, 1)
        self.nrows = max(int(self.depth / res) + 1, 1)

        self._walls = wall_segments
        # Spatial hash over the wall segments: _segment_blocked queries only the
        # segments near the probe instead of scanning all of them (the full scan
        # froze graph construction on dense MapMaker floors).
        self._wall_index = _SegmentIndex(wall_segments) if wall_segments else None
        # Spatial hash over obstacle rects for O(1)-ish point-in-rack tests.
        self._obs_grid: dict[tuple[int, int], list[int]] | None = None
        if self._obstacles:
            self._obs_grid = {}
            c = _INDEX_CELL_M
            for i, (rx, ry, rw, rh) in enumerate(self._obstacles):
                for cx in range(int(rx // c), int((rx + rw) // c) + 1):
                    for cy in range(int(ry // c), int((ry + rh) // c) + 1):
                        self._obs_grid.setdefault((cx, cy), []).append(i)
        # Build edge blocking only when walls exist; otherwise the grid is open
        # and every orthogonal neighbour edge is free (weight = resolution).
        self._blocked: set[tuple[int, int]] = set()
        if self._has_walls:
            self._build_blocked_edges()

        # Node occupancy (inside a rack) + connected components of the free grid.
        # Snapping is restricted to the MAIN component so an endpoint can never
        # land on an isolated island (a rack interior, a node pinned on a rack
        # edge, a sealed pocket) and silently fall back to Manhattan — which is
        # exactly the straight-through-the-racking travel this graph exists to
        # prevent. See ``_nearest_reachable``.
        self._occupied: bytearray = bytearray(self.ncols * self.nrows)
        self._comp: list[int] = []
        self._main_comp: int = -1
        self._build_occupancy()

        # Unroutable-query counters: the honest alternative to a silent fallback.
        # ``distance``/``path`` still never blow up (they degrade to Manhattan /
        # the straight segment) but every such degradation is COUNTED, so tests
        # and the caller can assert the normal case never hits it.
        self.unroutable_distance = 0
        self.unroutable_path = 0

        # Access-lattice assignment (built lazily on the first routed query).
        self._acc_owner: list[int] | None = None
        self._acc_dist: list[float] = []
        self._acc_next: list[int] = []

        # Cache: source node index -> {node index -> distance}.
        self._dist_cache: dict[int, dict[int, float]] = {}
        # Cache: source node index -> {node index -> predecessor node index}.
        self._prev_cache: dict[int, dict[int, int]] = {}
        # Memoised endpoint snaps: the engine queries distance() from the same
        # few hundred shelf/station points tens of thousands of times per run,
        # so snapping (which probes walls/obstacles) is computed once per point.
        self._snap_cache: dict[tuple[float, float], tuple[int, float]] = {}
        self._snap_access_cache: dict[tuple[float, float], tuple[int, float]] = {}

        # Number of full single-source Dijkstra solves actually run (instrument
        # for tests / profiling; bounded by the distinct access nodes queried).
        self.solve_count = 0

        # --- Source collapse onto a coarse access sub-lattice -----------------
        # On large grids, snap Dijkstra *sources* to a small set of access nodes
        # so each is solved at most once for the whole run. ``_access_stride`` is
        # how many fine cells make up one access cell, chosen so the access node
        # count stays under ``MAX_ACCESS``.
        n_nodes = self.ncols * self.nrows
        self._collapse_sources = n_nodes >= ACCESS_COLLAPSE_MIN_NODES
        self._access_stride = 1
        if self._collapse_sources:
            stride = 1
            while True:
                acols = (self.ncols + stride - 1) // stride
                arows = (self.nrows + stride - 1) // stride
                if acols * arows <= MAX_ACCESS or stride >= max(self.ncols, self.nrows):
                    break
                stride += 1
            self._access_stride = max(1, stride)

    # ------------------------------------------------------------------ build

    @classmethod
    def from_layout(
        cls,
        bounds: dict,
        walls: list[dict],
        resolution: float = 1.0,
    ) -> "AisleGraph":
        """Build from plain dicts: bounds={'width','depth'}, walls=[{'points':...}]."""
        width = float((bounds or {}).get("width", 80.0))
        depth = float((bounds or {}).get("depth", 40.0))
        segments = cls._segments_from_walls(walls or [])
        return cls(width, depth, segments, resolution=resolution)

    @classmethod
    def from_model(cls, model, resolution: float = DEFAULT_RESOLUTION_M) -> "AisleGraph":
        """Build from a WarehouseModel (``model.layout`` + the DRAWN rack runs).

        The obstacle set is the union of

        * the authored ``ShelfArea`` rectangles of every storage zone, and
        * **every rack run the renderers draw** (``rackgeom.rack_rects``), which
          is what finally covers *parametric* racking — a zone's ``RackFill``
          materialized into ``model.locations``. Both bundled templates are
          parametric, so before this the graph had no obstacles at all and agents
          walked straight through the racking, both on screen and in the
          distance maths (travel understated ⇒ productivity overstated).
        """
        layout = getattr(model, "layout", None)
        if layout is None:
            return cls(80.0, 40.0, [], resolution=resolution)

        bounds = getattr(layout, "bounds", None)
        width = float(getattr(bounds, "width", 80.0)) if bounds else 80.0
        depth = float(getattr(bounds, "depth", 40.0)) if bounds else 40.0

        walls = getattr(layout, "walls", []) or []
        # Walls may be pydantic Wall objects (with .points) or dicts.
        wall_dicts = []
        for w in walls:
            pts = getattr(w, "points", None)
            if pts is None and isinstance(w, dict):
                pts = w.get("points")
            wall_dicts.append({"points": pts or []})
        segments = cls._segments_from_walls(wall_dicts)
        # Authored SHELF blocks are impassable obstacles (route around the aisles).
        obstacles: list[tuple[float, float, float, float]] = []
        for z in (getattr(layout, "zones", []) or []):
            ztype = getattr(z, "type", None) if not isinstance(z, dict) else z.get("type")
            if ztype != "storage":
                continue
            shelves = (getattr(z, "shelves", None) if not isinstance(z, dict)
                       else z.get("shelves")) or []
            for sh in shelves:
                d = sh if isinstance(sh, dict) else sh.__dict__
                try:
                    obstacles.append((float(d["x"]), float(d["y"]),
                                      float(d["w"]), float(d["h"])))
                except (TypeError, ValueError, KeyError, AttributeError):
                    continue
        # ...plus the rack runs as DRAWN (parametric racks live only in
        # ``model.locations``, so they are invisible to the loop above). Same
        # reconstruction the 2D PNG / canvas / 3D use, so routing obstacles and
        # the drawing can never disagree. Deduped: the authored path yields the
        # authored rectangles verbatim, so a MapMaker model is unchanged.
        seen = {tuple(round(v, 4) for v in r) for r in obstacles}
        for rect in rack_rects(model):
            key = tuple(round(v, 4) for v in rect)
            if key not in seen:
                seen.add(key)
                obstacles.append(rect)
        return cls(width, depth, segments, resolution=resolution,
                   obstacle_rects=obstacles, auto_resolution=True)

    @staticmethod
    def _segments_from_walls(
        walls: list[dict],
    ) -> list[tuple[tuple[float, float], tuple[float, float]]]:
        """Flatten each wall polyline into its chain of straight segments."""
        segments: list[tuple[tuple[float, float], tuple[float, float]]] = []
        for w in walls:
            pts = w.get("points") if isinstance(w, dict) else getattr(w, "points", None)
            if not pts:
                continue
            try:
                coords = [(float(p[0]), float(p[1])) for p in pts if len(p) >= 2]
            except (TypeError, ValueError, IndexError):
                continue
            for i in range(len(coords) - 1):
                a, b = coords[i], coords[i + 1]
                if a != b:
                    segments.append((a, b))
        return segments

    def _build_blocked_edges(self) -> None:
        """Mark grid edges whose centre-to-centre segment crosses any wall.

        Stores blocked edges as frozenset-like (min_idx, max_idx) tuples so the
        lookup is direction-independent.
        """
        for r in range(self.nrows):
            for c in range(self.ncols):
                idx = self._node_index(c, r)
                cx, cy = self._node_xy(c, r)
                # Only check the +x and +y neighbours; the reverse edges are the
                # same undirected edge, so we avoid double work.
                for dc, dr in ((1, 0), (0, 1)):
                    nc, nr = c + dc, r + dr
                    if nc >= self.ncols or nr >= self.nrows:
                        continue
                    nx, ny = self._node_xy(nc, nr)
                    if self._segment_blocked((cx, cy), (nx, ny)):
                        nidx = self._node_index(nc, nr)
                        self._blocked.add((min(idx, nidx), max(idx, nidx)))

    def _build_occupancy(self) -> None:
        """Mark rack-occupied nodes and label the connected components of the rest.

        Two complementary rules keep racks solid at any grid pitch:

        * a node whose centre falls inside a rack (inflated by
          ``NODE_CLEARANCE_M``) is **occupied** — it is not a place an agent can
          stand, and it is never a snap target;
        * an edge whose centre-to-centre segment crosses a rack perimeter is
          **blocked** (``_build_blocked_edges``) — so even a rack too thin to
          contain a node centre cannot be stepped over.

        The component labelling then answers "is this node actually part of the
        walkable floor?" in O(1), which is what makes the no-silent-fallback
        guarantee cheap.
        """
        n = self.ncols * self.nrows
        if self._obstacles:
            infl = NODE_CLEARANCE_M
            occ = self._occupied
            for r in range(self.nrows):
                for c in range(self.ncols):
                    x, y = self._node_xy(c, r)
                    if self._inside_obstacle(x, y, eps=-infl):
                        occ[self._node_index(c, r)] = 1
        # Label components of the free sub-grid (BFS, deterministic order).
        comp = [-1] * n
        sizes: list[int] = []
        occ = self._occupied
        for start in range(n):
            if occ[start] or comp[start] >= 0:
                continue
            cid = len(sizes)
            comp[start] = cid
            stack = [start]
            size = 0
            while stack:
                u = stack.pop()
                size += 1
                for v in self._neighbors(u):
                    if comp[v] < 0 and not occ[v]:
                        comp[v] = cid
                        stack.append(v)
            sizes.append(size)
        self._comp = comp
        self._comp_size = sizes
        self._main_comp = max(range(len(sizes)), key=lambda i: sizes[i]) if sizes else -1
        # Fraction of walkable nodes that are actually part of the main floor —
        # a direct read on "did this grid pitch seal any aisle?".
        free_total = sum(sizes)
        self.connectivity = (sizes[self._main_comp] / free_total) if free_total else 1.0

    def _is_island(self, idx: int) -> bool:
        """A free node with NO passable neighbour — a rasterisation artefact.

        The classic case is a node sitting exactly on the building shell polyline:
        every incident edge "crosses" the wall (a touching segment counts), so the
        node is a component of one. It is not a room, it is nowhere; snapping an
        endpoint onto it would make every query from there unroutable. Genuine
        walled-off areas are large components and stay snappable.
        """
        cid = self._comp[idx] if idx < len(self._comp) else -1
        return cid >= 0 and self._comp_size[cid] <= 1

    def _reachable(self, idx: int) -> bool:
        """Is this node walkable AND part of the main connected floor?"""
        if self._main_comp < 0:
            return True
        return not self._occupied[idx] and self._comp[idx] == self._main_comp

    def _segment_blocked(
        self, a: tuple[float, float], b: tuple[float, float]
    ) -> bool:
        walls = (self._wall_index.candidates(a, b)
                 if self._wall_index is not None else self._walls)
        for w1, w2 in walls:
            if _segments_intersect(a, b, w1, w2):
                return True
        return False

    # ------------------------------------------------------------ grid helpers

    def _node_index(self, c: int, r: int) -> int:
        return r * self.ncols + c

    def _node_cr(self, idx: int) -> tuple[int, int]:
        return idx % self.ncols, idx // self.ncols

    def _node_xy(self, c: int, r: int) -> tuple[float, float]:
        # Cell centres, clamped so the last row/col never exceeds the bounds.
        x = min(c * self.resolution, self.width)
        y = min(r * self.resolution, self.depth)
        return x, y

    def _inside_obstacle(self, x: float, y: float, eps: float = 1e-6) -> bool:
        """True if (x, y) lies strictly inside any shelf/rack footprint."""
        if self._obs_grid is not None:
            c = _INDEX_CELL_M
            idxs = self._obs_grid.get((int(x // c), int(y // c)), ())
            obstacles = self._obstacles
            for i in idxs:
                rx, ry, rw, rh = obstacles[i]
                if rx + eps < x < rx + rw - eps and ry + eps < y < ry + rh - eps:
                    return True
            return False
        for (rx, ry, rw, rh) in self._obstacles:
            if rx + eps < x < rx + rw - eps and ry + eps < y < ry + rh - eps:
                return True
        return False

    def _nearest_reachable(self, c: int, r: int) -> tuple[int, int]:
        """Nearest node (ring search) that is free AND on the main walkable floor.

        A pick point sits at/inside its rack footprint, so this is what turns it
        into the aisle node the picker actually stands on. Requiring main-component
        membership (not merely "outside a rack") is what removes the silent
        Manhattan fallback: an isolated node — a rack interior, a node pinned on a
        rack edge, a pocket sealed by the grid pitch — is never chosen, so a query
        between two snapped endpoints is always solvable on the grid.

        A point that is already on free floor keeps its own node verbatim (walls
        may legitimately fence it off from the main floor — that is the building's
        truth, not a rasterisation artefact), so wall-only routing is unchanged.
        """
        idx = self._node_index(c, r)
        if not self._occupied[idx] and not self._is_island(idx):
            return c, r
        # Inside a rack: walk outward to the closest node on the walkable floor,
        # falling back to merely-free if the grid has no main component at all.
        fallback: tuple[int, int] | None = None
        for rad in range(1, max(self.ncols, self.nrows) + 1):
            best = None
            best_free = None
            for dc in range(-rad, rad + 1):
                for dr in range(-rad, rad + 1):
                    if max(abs(dc), abs(dr)) != rad:
                        continue
                    nc, nr = c + dc, r + dr
                    if not (0 <= nc < self.ncols and 0 <= nr < self.nrows):
                        continue
                    nidx = self._node_index(nc, nr)
                    if self._occupied[nidx] or self._is_island(nidx):
                        continue
                    d = dc * dc + dr * dr
                    if best_free is None or d < best_free[0]:
                        best_free = (d, nc, nr)
                    if self._comp[nidx] == self._main_comp:
                        if best is None or d < best[0]:
                            best = (d, nc, nr)
            if best is not None:
                return best[1], best[2]
            if fallback is None and best_free is not None:
                fallback = (best_free[1], best_free[2])
        return fallback if fallback is not None else (c, r)

    def _snap(self, p: tuple[float, float]) -> tuple[int, float]:
        """Snap a point to the nearest grid node; return (index, offset_metres).

        A point inside a rack footprint snaps to the nearest aisle node instead,
        so distances are measured aisle-to-aisle (pickers stand in the aisle)."""
        px, py = float(p[0]), float(p[1])
        c = int(round(px / self.resolution))
        r = int(round(py / self.resolution))
        c = min(max(c, 0), self.ncols - 1)
        r = min(max(r, 0), self.nrows - 1)
        if self._obstacles or self._has_walls:
            c, r = self._nearest_reachable(c, r)
        nx, ny = self._node_xy(c, r)
        offset = hypot(px - nx, py - ny)
        return self._node_index(c, r), offset

    def _snap_access(self, p: tuple[float, float]) -> tuple[int, float]:
        """Snap a point to the nearest *access* node (a coarse sub-lattice node).

        Returns ``(node_index, leg_metres)`` where ``leg_metres`` is the straight
        correction distance from the real point to the access node centre. When
        source collapse is disabled this is identical to :meth:`_snap`.

        Critically, the chosen access node must be reachable from the point
        *without crossing a wall* -- otherwise collapsing the source can land it
        on the far side of an interior wall and force a spurious detour. We scan
        the nearest access-lattice cells in increasing distance and take the first
        whose straight ``point -> access-centre`` leg is wall-free. If none is
        wall-free (point boxed in), we fall back to the exact fine snap so the
        query stays correct (at the cost of one extra full solve, which is rare).

        The straight ``point -> access-centre`` probe this used to do collapses on
        a racked floor: a pick point sits inside its rack, so *every* straight leg
        out of it crosses a rack side and no access node ever qualifies. The
        collapse would silently disable itself and the run would degrade to one
        full solve per distinct shelf (the very cliff it exists to prevent).

        So the assignment is done **on the graph** instead (``_build_access``): a
        single multi-source BFS from the whole access lattice labels every node
        with its nearest access node and the EXACT walkable distance to it. That
        is strictly better than the old straight-line leg — it can never cut a
        corner through a rack or a wall, and it never needs a fallback.
        """
        if not self._collapse_sources or self._access_stride <= 1:
            return self._snap(p)
        sidx, off = self._snap(p)
        owner, lead = self._access_of(sidx)
        if owner < 0:
            # No access node reaches this node's component -> exact fine snap.
            return sidx, off
        return owner, lead + off

    def _build_access(self) -> None:
        """Assign every node to its nearest ACCESS node, on the graph.

        One multi-source BFS seeded with the whole access lattice (all edges have
        the same weight ``resolution``, so BFS *is* Dijkstra here) yields, for each
        node: the access node whose walkable region it falls in (``_acc_owner``),
        the exact distance to it (``_acc_dist``) and the next hop toward it
        (``_acc_next``, so the correction leg can also be DRAWN).

        Costs one O(N) sweep for the whole graph; in exchange every source query
        collapses onto an access node with no approximation beyond the leg itself,
        and the number of full single-source solves stays bounded by the number of
        distinct access nodes actually queried.
        """
        n = self.ncols * self.nrows
        owner = [-1] * n
        dist = [0.0] * n
        nxt = [-1] * n
        stride = self._access_stride
        w = self.resolution
        q: deque[int] = deque()
        for r in range(0, self.nrows, stride):
            for c in range(0, self.ncols, stride):
                idx = self._node_index(c, r)
                if self._occupied[idx] or self._is_island(idx):
                    continue
                owner[idx] = idx
                q.append(idx)
        while q:
            u = q.popleft()
            du = dist[u]
            ou = owner[u]
            for v in self._neighbors(u):
                if owner[v] < 0:
                    owner[v] = ou
                    dist[v] = du + w
                    nxt[v] = u
                    q.append(v)
        self._acc_owner = owner
        self._acc_dist = dist
        self._acc_next = nxt

    def _access_of(self, idx: int) -> tuple[int, float]:
        """``(access node, exact walk distance to it)`` for a fine node."""
        if self._acc_owner is None:
            self._build_access()
        return self._acc_owner[idx], self._acc_dist[idx]

    def _access_lead(self, idx: int) -> list[int]:
        """The node chain ``idx -> ... -> its access node`` (drawable waypoints)."""
        if self._acc_owner is None:
            self._build_access()
        owner = self._acc_owner[idx]
        if owner < 0:
            return [idx]
        chain = [idx]
        cur = idx
        while cur != owner:
            cur = self._acc_next[cur]
            if cur < 0:
                return [idx]
            chain.append(cur)
        return chain

    def _snap_cached(self, p: tuple[float, float]) -> tuple[int, float]:
        """Memoised :meth:`_snap` — same result, computed once per distinct point."""
        key = (p[0], p[1])
        hit = self._snap_cache.get(key)
        if hit is None:
            hit = self._snap(p)
            self._snap_cache[key] = hit
        return hit

    def _snap_access_cached(self, p: tuple[float, float]) -> tuple[int, float]:
        """Memoised :meth:`_snap_access` — same result, computed once per point."""
        key = (p[0], p[1])
        hit = self._snap_access_cache.get(key)
        if hit is None:
            hit = self._snap_access(p)
            self._snap_access_cache[key] = hit
        return hit

    def _neighbors(self, idx: int):
        c, r = self._node_cr(idx)
        occ = self._occupied
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = c + dc, r + dr
            if 0 <= nc < self.ncols and 0 <= nr < self.nrows:
                nidx = self._node_index(nc, nr)
                # Standing inside a rack is not a thing; the edge test alone would
                # already block most of these, but a node whose centre lands in a
                # rack must never be a waypoint even when its neighbour shares the
                # footprint (the rack-interior corridor).
                if occ[nidx]:
                    continue
                if (min(idx, nidx), max(idx, nidx)) not in self._blocked:
                    yield nidx

    # --------------------------------------------------------------- Dijkstra

    def _dijkstra(self, source: int) -> tuple[dict[int, float], dict[int, int]]:
        if source in self._dist_cache:
            return self._dist_cache[source], self._prev_cache[source]

        self.solve_count += 1
        # Every edge costs exactly one grid pitch, so the shortest-path tree is a
        # plain BFS tree — no priority queue needed (and none of its log factor).
        # Identical results to the heapq version, measurably cheaper per solve,
        # which matters because a big floor solves this hundreds of times.
        dist: dict[int, float] = {source: 0.0}
        prev: dict[int, int] = {}
        w = self.resolution
        queue: deque[int] = deque((source,))
        while queue:
            u = queue.popleft()
            nd = dist[u] + w
            for v in self._neighbors(u):
                if v not in dist:
                    dist[v] = nd
                    prev[v] = u
                    queue.append(v)

        self._dist_cache[source] = dist
        self._prev_cache[source] = prev
        return dist, prev

    # ----------------------------------------------------------------- public

    @property
    def enabled(self) -> bool:
        """True when anything can obstruct travel — walls **or** racking.

        (``_has_walls`` already folds in the rack perimeters, so a wall-less floor
        full of racks still routes; an empty floor keeps Manhattan.)
        """
        return self._has_walls

    @property
    def unroutable_count(self) -> int:
        """How many queries had to degrade (Manhattan / straight segment).

        Must stay 0 on a healthy layout: every degradation is a leg that cuts
        straight through whatever it could not route around, which is precisely
        the defect this graph exists to remove. Exposed rather than logged-away so
        tests and callers can assert on it.
        """
        return self.unroutable_distance + self.unroutable_path

    def access_point(self, p: tuple[float, float]) -> tuple[float, float]:
        """Where an agent physically STANDS to serve ``p`` (the aisle face).

        Identity for a point on free floor; for a point inside a rack (every pick
        location is, since slots are addressed at the rack centre-line) it is the
        aisle node the router measures from — so trajectories end where the picker
        really stands and reach into the rack rather than walking through it.
        """
        if not self._obstacles:
            return (float(p[0]), float(p[1]))
        if not self._inside_obstacle(float(p[0]), float(p[1]), eps=-NODE_CLEARANCE_M):
            return (float(p[0]), float(p[1]))
        idx, _ = self._snap_cached(p)
        return self._node_xy(*self._node_cr(idx))

    def edges_xy(self) -> list[tuple[float, float, float, float]]:
        """Passable lane edges as (x1, y1, x2, y2) — the display 通路ネットワーク.

        Enumerates every unblocked +x / +y grid edge between two nodes the router
        would actually use, so a canvas can draw the walkable network (aisles read
        as dense corridors, walls/shelves as holes) and it agrees with the routing
        by construction. Bounded by the node cap, so the payload stays drawable.
        """
        out: list[tuple[float, float, float, float]] = []
        for r in range(self.nrows):
            for c in range(self.ncols):
                x1, y1 = self._node_xy(c, r)
                idx = self._node_index(c, r)
                if self._occupied[idx]:
                    continue
                for dc, dr in ((1, 0), (0, 1)):
                    nc, nr = c + dc, r + dr
                    if nc >= self.ncols or nr >= self.nrows:
                        continue
                    x2, y2 = self._node_xy(nc, nr)
                    nidx = self._node_index(nc, nr)
                    if self._occupied[nidx]:
                        continue
                    if (min(idx, nidx), max(idx, nidx)) in self._blocked:
                        continue
                    out.append((x1, y1, x2, y2))
        return out

    def distance(
        self, a: tuple[float, float], b: tuple[float, float]
    ) -> float:
        """Shortest wall-aware travel distance in metres (never inf).

        The Dijkstra *source* is collapsed onto the coarse access lattice so each
        access node is solved at most once for the whole run; the ``a -> acc_a``
        leg is added analytically. The *target* keeps its exact fine-grid snap, so
        the wall-aware grid distance between the access node and the target is
        still the exact shortest path on the grid.
        """
        acc_a, leg_a = self._snap_access_cached(a)
        sb, off_b = self._snap_cached(b)
        dist, _ = self._dijkstra(acc_a)
        d = dist.get(sb)
        if d is None or d == float("inf"):
            # Unreachable on the grid -> never block, fall back to Manhattan.
            # COUNTED: a Manhattan answer here is a straight-through-the-racking
            # answer, so it must never happen on a healthy layout.
            self.unroutable_distance += 1
            return _manhattan(a, b)
        return d + leg_a + off_b

    def path(
        self, a: tuple[float, float], b: tuple[float, float]
    ) -> list[tuple[float, float]]:
        """Node-centre xy waypoints along the shortest route (for draw / heat).

        The stitched endpoints are the **access points** (see
        :meth:`access_point`), not the raw ``a``/``b``: a raw pick point sits on
        the rack centre-line, so stitching it on would draw the last ~half a rack
        depth of every approach straight through the rack it is picking from.
        Points on free floor are stitched verbatim, as before.
        """
        sa, _ = self._snap_cached(a)
        acc_a, _ = self._snap_access_cached(a)
        sb, _ = self._snap_cached(b)
        pa, pb = self.access_point(a), self.access_point(b)
        dist, prev = self._dijkstra(acc_a)
        if sb not in dist:
            self.unroutable_path += 1
            return [pa, pb]

        chain: list[int] = []
        cur = sb
        while cur != acc_a:
            chain.append(cur)
            nxt = prev.get(cur)
            if nxt is None:
                self.unroutable_path += 1
                return [pa, pb]
            cur = nxt
        chain.append(acc_a)
        chain.reverse()
        # The route the DISTANCE describes starts at ``a``'s own node and walks to
        # its access node, so draw that lead-in too — otherwise the trajectory
        # teleports from the pick face to an access node up to a lattice cell away,
        # straight through whatever is in between.
        lead = self._access_lead(sa)[:-1] if sa != acc_a else []
        chain = lead + chain

        pts = [self._node_xy(*self._node_cr(idx)) for idx in chain]
        # Stitch the real endpoints onto the snapped centres.
        return [pa] + pts + [pb]


# --------------------------------------------------------------------- self-test

if __name__ == "__main__":
    # 30 x 20 m floor, one long internal wall splitting it into a left and right
    # half. The wall runs vertically at x = 15 from y = 0 up to y = 17, leaving a
    # 3 m gap at the top, so a route between left and right must detour up and over.
    bounds = {"width": 30.0, "depth": 20.0}
    walls = [{"points": [[15.0, 0.0], [15.0, 17.0]]}]
    g = AisleGraph.from_layout(bounds, walls, resolution=1.0)

    a = (5.0, 5.0)   # left of the wall
    b = (25.0, 5.0)  # right of the wall, same height

    straight = _manhattan(a, b)
    routed = g.distance(a, b)
    print(f"enabled            = {g.enabled}")
    print(f"nodes              = {g.ncols * g.nrows} ({g.ncols}x{g.nrows})")
    print(f"blocked edges      = {len(g._blocked)}")
    print(f"manhattan distance = {straight:.1f} m")
    print(f"routed distance    = {routed:.1f} m")
    pth = g.path(a, b)
    print(f"path waypoints     = {len(pth)} (first 3: {pth[:3]})")
    assert g.enabled, "walls present -> should be enabled"
    assert routed > straight + 5.0, (
        f"routed ({routed}) should be meaningfully larger than manhattan ({straight})"
    )

    # No-wall floor: routing disabled and distance ~= Manhattan.
    g2 = AisleGraph.from_layout(bounds, [], resolution=1.0)
    d2 = g2.distance(a, b)
    print()
    print(f"no-wall enabled    = {g2.enabled}")
    print(f"no-wall manhattan  = {straight:.1f} m")
    print(f"no-wall routed     = {d2:.1f} m")
    assert not g2.enabled, "no walls -> should be disabled"
    assert abs(d2 - straight) < 1e-6, (
        f"open floor distance ({d2}) should equal manhattan ({straight})"
    )

    # Unreachable fallback: a fully sealed vertical wall (no gap) -> Manhattan.
    walls_sealed = [{"points": [[15.0, 0.0], [15.0, 20.0]]}]
    g3 = AisleGraph.from_layout(bounds, walls_sealed, resolution=1.0)
    d3 = g3.distance(a, b)
    print()
    print(f"sealed routed      = {d3:.1f} m (fallback to manhattan, never inf)")
    assert d3 != float("inf")

    # Huge floor: resolution must coarsen to stay under the node cap.
    g4 = AisleGraph.from_layout(
        {"width": 1000.0, "depth": 1000.0}, [{"points": [[500, 0], [500, 900]]}]
    )
    print()
    print(f"huge floor res     = {g4.resolution:.2f} m, nodes = {g4.ncols * g4.nrows}")
    assert g4.ncols * g4.nrows <= MAX_NODES

    print("\nall self-tests passed")
