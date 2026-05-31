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
"""

from __future__ import annotations

import heapq
from math import hypot


# Hard cap on grid nodes; resolution is coarsened automatically to stay under it
# so a huge floor never blows up memory / Dijkstra time.
MAX_NODES = 20000


def _manhattan(a: tuple[float, float], b: tuple[float, float]) -> float:
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


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
    ) -> None:
        self.width = max(float(width), 1e-6)
        self.depth = max(float(depth), 1e-6)
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
        return cls(width, depth, segments, resolution=1.0)

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

    def _snap(self, p: tuple[float, float]) -> tuple[int, float]:
        """Snap a point to the nearest grid node; return (index, offset_metres)."""
        px, py = float(p[0]), float(p[1])
        c = int(round(px / self.resolution))
        r = int(round(py / self.resolution))
        c = min(max(c, 0), self.ncols - 1)
        r = min(max(r, 0), self.nrows - 1)
        nx, ny = self._node_xy(c, r)
        offset = hypot(px - nx, py - ny)
        return self._node_index(c, r), offset

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

    def distance(
        self, a: tuple[float, float], b: tuple[float, float]
    ) -> float:
        """Shortest wall-aware travel distance in metres (never inf)."""
        sa, off_a = self._snap(a)
        sb, off_b = self._snap(b)
        dist, _ = self._dijkstra(sa)
        d = dist.get(sb)
        if d is None or d == float("inf"):
            # Unreachable on the grid -> never block, fall back to Manhattan.
            return _manhattan(a, b)
        return d + off_a + off_b

    def path(
        self, a: tuple[float, float], b: tuple[float, float]
    ) -> list[tuple[float, float]]:
        """Node-centre xy waypoints along the shortest route (for draw / heat)."""
        sa, _ = self._snap(a)
        sb, _ = self._snap(b)
        dist, prev = self._dijkstra(sa)
        if sb not in dist:
            return [a, b]

        chain: list[int] = []
        cur = sb
        while cur != sa:
            chain.append(cur)
            nxt = prev.get(cur)
            if nxt is None:
                return [a, b]
            cur = nxt
        chain.append(sa)
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
