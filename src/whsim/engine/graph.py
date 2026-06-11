"""Real aisle-network routing over the warehouse floor.

The plain Manhattan distance (``engine.routing.manhattan``) assumes pickers can
walk in a straight L through anything. That over-states accuracy whenever the
building shell has internal walls (躯体) that force traffic to detour around
them. This module builds a 4-connected occupancy grid over the floor, blocks
edges that would cross a wall polyline, and answers shortest-path queries with
Dijkstra -- so the flow-line distances and times are trustworthy.

Contract (kept deliberately small so callers can fall back cheaply):

    g = AisleGraph.from_model(model)        # reads model.layout
    if g.enabled:                           # walls present -> routing matters
        d = g.distance((ax, ay), (bx, by))  # metres, around the walls
        pts = g.path((ax, ay), (bx, by))    # node centres for drawing/heat
    else:
        d = manhattan(a, b)                 # no walls -> Manhattan is exact

``distance`` never returns ``inf``: if the destination is genuinely unreachable
on the grid it falls back to Manhattan distance, and ``path`` falls back to the
straight segment ``[a, b]``.

Only stdlib + numpy. Dijkstra is pure-python with ``heapq``; single-source
distance maps are cached so repeated queries from the same pick locations (the
common case) are amortised to a dict lookup.

Scalability (the load-bearing optimisation)
-------------------------------------------
A single-source Dijkstra yields the distance to *every* node, so it is cached
per source. The cliff was that on a large floor the simulation queries from
thousands of *distinct* shelf positions, so the per-source cache never
amortises: ~O(distinct_sources x N log N) full grid solves in pure Python.

Fix: **collapse the Dijkstra sources to a small set of "access" nodes.** Access
nodes are a coarse sub-lattice of the fine grid (capped at ``MAX_ACCESS``). A
query ``distance(a, b)`` snaps ``a`` to its nearest access node ``acc_a`` and
``b`` to its nearest fine node ``sb``; the wall-aware grid distance is taken from
the (cached) single-source map of ``acc_a``, and the short ``a -> acc_a`` leg is
added analytically. Because there are only a few hundred access nodes for the
whole floor, each is solved **at most once** for the entire run, and the number
of full Dijkstra solves is bounded by the number of *distinct access nodes
actually queried* (dozens), not by the thousands of distinct shelves.

The introduced error is bounded by the access-lattice spacing (the ``a -> acc_a``
correction leg), which is kept small relative to the floor; on small grids the
collapse is disabled entirely and the exact per-source Dijkstra is used, so the
classic correctness tests are unaffected. Determinism is preserved (snapping and
Dijkstra are deterministic).
"""

from __future__ import annotations

import heapq
from math import hypot


# Hard cap on grid nodes; resolution is coarsened automatically to stay under it
# so a huge floor never blows up memory / Dijkstra time.
MAX_NODES = 20000

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


def _manhattan(a: tuple[float, float], b: tuple[float, float]) -> float:
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


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

        # Choose a resolution that keeps the node count under the cap. Node count
        # is roughly (width/res + 1) * (depth/res + 1); coarsen if needed.
        res = float(resolution) if resolution and resolution > 0 else 1.0
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
        # Build edge blocking only when walls exist; otherwise the grid is open
        # and every orthogonal neighbour edge is free (weight = resolution).
        self._blocked: set[tuple[int, int]] = set()
        if self._has_walls:
            self._build_blocked_edges()

        # Cache: source node index -> {node index -> distance}.
        self._dist_cache: dict[int, dict[int, float]] = {}
        # Cache: source node index -> {node index -> predecessor node index}.
        self._prev_cache: dict[int, dict[int, int]] = {}

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
    def from_model(cls, model) -> "AisleGraph":
        """Build from a WarehouseModel (reads ``model.layout``)."""
        layout = getattr(model, "layout", None)
        if layout is None:
            return cls(80.0, 40.0, [], resolution=1.0)

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
        return cls(width, depth, segments, resolution=1.0, obstacle_rects=obstacles)

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

    def _segment_blocked(
        self, a: tuple[float, float], b: tuple[float, float]
    ) -> bool:
        for w1, w2 in self._walls:
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
        for (rx, ry, rw, rh) in self._obstacles:
            if rx + eps < x < rx + rw - eps and ry + eps < y < ry + rh - eps:
                return True
        return False

    def _nearest_free(self, c: int, r: int) -> tuple[int, int]:
        """Nearest grid node (ring search) whose centre is not inside an obstacle."""
        if not self._inside_obstacle(*self._node_xy(c, r)):
            return c, r
        for rad in range(1, max(self.ncols, self.nrows) + 1):
            best = None
            for dc in range(-rad, rad + 1):
                for dr in range(-rad, rad + 1):
                    if max(abs(dc), abs(dr)) != rad:
                        continue
                    nc, nr = c + dc, r + dr
                    if not (0 <= nc < self.ncols and 0 <= nr < self.nrows):
                        continue
                    if not self._inside_obstacle(*self._node_xy(nc, nr)):
                        d = dc * dc + dr * dr
                        if best is None or d < best[0]:
                            best = (d, nc, nr)
            if best is not None:
                return best[1], best[2]
        return c, r

    def _snap(self, p: tuple[float, float]) -> tuple[int, float]:
        """Snap a point to the nearest grid node; return (index, offset_metres).

        A point inside a rack footprint snaps to the nearest aisle node instead,
        so distances are measured aisle-to-aisle (pickers stand in the aisle)."""
        px, py = float(p[0]), float(p[1])
        c = int(round(px / self.resolution))
        r = int(round(py / self.resolution))
        c = min(max(c, 0), self.ncols - 1)
        r = min(max(r, 0), self.nrows - 1)
        if self._obstacles:
            c, r = self._nearest_free(c, r)
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
        """
        if not self._collapse_sources or self._access_stride <= 1:
            return self._snap(p)
        px, py = float(p[0]), float(p[1])
        stride = self._access_stride
        base_c = int(round(px / self.resolution))
        base_r = int(round(py / self.resolution))

        candidates: list[tuple[float, int, int]] = []
        # Consider the access cells in a small window around the point; rounding
        # to the lattice can fall either way, and a wall may force the next one.
        for ac in range(base_c // stride - 1, base_c // stride + 2):
            for ar in range(base_r // stride - 1, base_r // stride + 2):
                c = min(max(ac * stride, 0), self.ncols - 1)
                r = min(max(ar * stride, 0), self.nrows - 1)
                nx, ny = self._node_xy(c, r)
                leg = hypot(px - nx, py - ny)
                candidates.append((leg, c, r))
        candidates.sort(key=lambda t: t[0])

        for leg, c, r in candidates:
            nx, ny = self._node_xy(c, r)
            if self._inside_obstacle(nx, ny):
                continue
            if not (self._has_walls and self._segment_blocked((px, py), (nx, ny))):
                return self._node_index(c, r), leg
        # Boxed in on every access leg -> exact fine snap (rare).
        return self._snap(p)

    def _neighbors(self, idx: int):
        c, r = self._node_cr(idx)
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = c + dc, r + dr
            if 0 <= nc < self.ncols and 0 <= nr < self.nrows:
                nidx = self._node_index(nc, nr)
                if (min(idx, nidx), max(idx, nidx)) not in self._blocked:
                    yield nidx

    # --------------------------------------------------------------- Dijkstra

    def _dijkstra(self, source: int) -> tuple[dict[int, float], dict[int, int]]:
        if source in self._dist_cache:
            return self._dist_cache[source], self._prev_cache[source]

        self.solve_count += 1
        dist: dict[int, float] = {source: 0.0}
        prev: dict[int, int] = {}
        w = self.resolution
        pq: list[tuple[float, int]] = [(0.0, source)]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist.get(u, float("inf")):
                continue
            for v in self._neighbors(u):
                nd = d + w
                if nd < dist.get(v, float("inf")):
                    dist[v] = nd
                    prev[v] = u
                    heapq.heappush(pq, (nd, v))

        self._dist_cache[source] = dist
        self._prev_cache[source] = prev
        return dist, prev

    # ----------------------------------------------------------------- public

    @property
    def enabled(self) -> bool:
        """True only when walls are present (otherwise callers prefer Manhattan)."""
        return self._has_walls

    def edges_xy(self) -> list[tuple[float, float, float, float]]:
        """Passable lane edges as (x1, y1, x2, y2) — the display 通路ネットワーク.

        Enumerates every unblocked +x / +y grid edge whose endpoints both lie
        outside the shelf footprints, so a canvas can draw the walkable network
        (aisles read as dense corridors, walls/shelves as holes). Bounded by the
        node cap, so the payload stays drawable.
        """
        out: list[tuple[float, float, float, float]] = []
        for r in range(self.nrows):
            for c in range(self.ncols):
                x1, y1 = self._node_xy(c, r)
                if self._inside_obstacle(x1, y1):
                    continue
                idx = self._node_index(c, r)
                for dc, dr in ((1, 0), (0, 1)):
                    nc, nr = c + dc, r + dr
                    if nc >= self.ncols or nr >= self.nrows:
                        continue
                    x2, y2 = self._node_xy(nc, nr)
                    if self._inside_obstacle(x2, y2):
                        continue
                    nidx = self._node_index(nc, nr)
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
        acc_a, leg_a = self._snap_access(a)
        sb, off_b = self._snap(b)
        dist, _ = self._dijkstra(acc_a)
        d = dist.get(sb)
        if d is None or d == float("inf"):
            # Unreachable on the grid -> never block, fall back to Manhattan.
            return _manhattan(a, b)
        return d + leg_a + off_b

    def path(
        self, a: tuple[float, float], b: tuple[float, float]
    ) -> list[tuple[float, float]]:
        """Node-centre xy waypoints along the shortest route (for draw / heat)."""
        acc_a, _ = self._snap_access(a)
        sb, _ = self._snap(b)
        dist, prev = self._dijkstra(acc_a)
        if sb not in dist:
            return [a, b]

        chain: list[int] = []
        cur = sb
        while cur != acc_a:
            chain.append(cur)
            nxt = prev.get(cur)
            if nxt is None:
                return [a, b]
            cur = nxt
        chain.append(acc_a)
        chain.reverse()

        pts = [self._node_xy(*self._node_cr(idx)) for idx in chain]
        # Stitch the real endpoints onto the snapped centres.
        return [tuple(a)] + pts + [tuple(b)]


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
