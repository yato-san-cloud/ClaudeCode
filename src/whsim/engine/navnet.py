"""MapMaker-style waypoint navigation network (Delaunay over a free-space graph).

MapMaker generates a cart travel network (Delaunay triangulation + waypoints + a
shortest-path graph). This mirrors that: waypoints are placed in the aisles just
off each rack corner (plus the floor boundary); a Delaunay triangulation over
them (via ``matplotlib.tri`` — no scipy) gives candidate edges; edges that stay in
free space form the navigation graph. ``path``/``distance`` connect endpoints to
the nearest *visible* waypoint and run Dijkstra, yielding smooth aisle routes (and
a network the 2D view can draw).

This is the visualization/geometry layer; the engine's authoritative timing still
uses the obstacle-aware grid (``engine.graph``). Both route around the same racks.
"""

from __future__ import annotations

import heapq
from math import hypot

import numpy as np


def _seg_intersect(p1, p2, p3, p4, eps: float = 1e-9) -> bool:
    def ccw(ax, ay, bx, by, cx, cy):
        return (by - ay) * (cx - ax) - (bx - ax) * (cy - ay)
    d1 = ccw(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1])
    d2 = ccw(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1])
    d3 = ccw(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1])
    d4 = ccw(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1])
    return ((d1 > eps) != (d2 > eps)) and ((d3 > eps) != (d4 > eps))


class NavNetwork:
    def __init__(self, width: float, depth: float,
                 obstacles: list[tuple[float, float, float, float]] | None = None,
                 clearance: float = 0.7) -> None:
        self.width = max(float(width), 1e-6)
        self.depth = max(float(depth), 1e-6)
        self.obstacles = list(obstacles or [])
        self.clearance = clearance
        self.waypoints: list[tuple[float, float]] = []
        self.edges: list[tuple[int, int]] = []
        self._adj: dict[int, list[tuple[int, float]]] = {}
        self._build()

    # --------------------------------------------------------------- geometry
    def _inside(self, x: float, y: float, eps: float = 1e-6) -> bool:
        for (rx, ry, rw, rh) in self.obstacles:
            if rx + eps < x < rx + rw - eps and ry + eps < y < ry + rh - eps:
                return True
        return False

    def _seg_free(self, a, b) -> bool:
        """True if segment a-b does not cut through any obstacle rectangle."""
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        if self._inside(mx, my):
            return False
        for (rx, ry, rw, rh) in self.obstacles:
            cs = [(rx, ry), (rx + rw, ry), (rx + rw, ry + rh), (rx, ry + rh)]
            for i in range(4):
                if _seg_intersect(a, b, cs[i], cs[(i + 1) % 4]):
                    return False
        return True

    def _candidate_points(self) -> list[tuple[float, float]]:
        cl = self.clearance
        pts: list[tuple[float, float]] = []
        # Floor boundary corners + edge midpoints.
        W, D = self.width, self.depth
        pts += [(0, 0), (W, 0), (W, D), (0, D), (W / 2, 0), (W / 2, D), (0, D / 2), (W, D / 2)]
        # Rack corners pushed out into the aisle by the clearance.
        for (rx, ry, rw, rh) in self.obstacles:
            pts += [(rx - cl, ry - cl), (rx + rw + cl, ry - cl),
                    (rx + rw + cl, ry + rh + cl), (rx - cl, ry + rh + cl),
                    (rx + rw / 2, ry - cl), (rx + rw / 2, ry + rh + cl),
                    (rx - cl, ry + rh / 2), (rx + rw + cl, ry + rh / 2)]
        # Clamp to bounds, drop points inside racks, de-dupe.
        seen: set[tuple[float, float]] = set()
        out: list[tuple[float, float]] = []
        for (x, y) in pts:
            x = round(min(max(x, 0.0), W), 2)
            y = round(min(max(y, 0.0), D), 2)
            if (x, y) in seen or self._inside(x, y):
                continue
            seen.add((x, y))
            out.append((x, y))
        return out

    def _build(self) -> None:
        pts = self._candidate_points()
        if len(pts) < 3:
            self.waypoints = pts
            return
        self.waypoints = pts
        xs = np.array([p[0] for p in pts])
        ys = np.array([p[1] for p in pts])
        try:
            from matplotlib.tri import Triangulation
            tri = Triangulation(xs, ys)
            raw_edges = tri.edges  # (E, 2) unique undirected edges
        except Exception:
            # Degenerate (collinear) — fall back to a sparse k-nearest graph.
            raw_edges = []
            for i in range(len(pts)):
                d = sorted(range(len(pts)), key=lambda j, i=i: hypot(
                    pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]))
                for j in d[1:5]:
                    raw_edges.append((i, j))
        adj: dict[int, list[tuple[int, float]]] = {i: [] for i in range(len(pts))}
        edges: list[tuple[int, int]] = []
        for (i, j) in raw_edges:
            i, j = int(i), int(j)
            if not self._seg_free(pts[i], pts[j]):
                continue
            w = hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])
            adj[i].append((j, w))
            adj[j].append((i, w))
            edges.append((min(i, j), max(i, j)))
        self.edges = sorted(set(edges))
        self._adj = adj

    # ----------------------------------------------------------------- routing
    def _nearest_visible(self, p) -> int:
        best, bestd = -1, float("inf")
        backup, backupd = -1, float("inf")
        for i, wp in enumerate(self.waypoints):
            d = hypot(p[0] - wp[0], p[1] - wp[1])
            if d < backupd:
                backup, backupd = i, d
            if d < bestd and self._seg_free(p, wp):
                best, bestd = i, d
        return best if best >= 0 else backup

    def path(self, a, b) -> list[tuple[float, float]]:
        if len(self.waypoints) < 2:
            return [tuple(a), tuple(b)]
        if self._seg_free(a, b):
            return [tuple(a), tuple(b)]
        sa, sb = self._nearest_visible(a), self._nearest_visible(b)
        if sa < 0 or sb < 0:
            return [tuple(a), tuple(b)]
        prev = self._dijkstra(sa, sb)
        if sb not in prev and sa != sb:
            return [tuple(a), tuple(b)]
        chain, cur = [], sb
        while cur != sa:
            chain.append(cur)
            cur = prev.get(cur)
            if cur is None:
                return [tuple(a), tuple(b)]
        chain.append(sa)
        chain.reverse()
        return [tuple(a)] + [self.waypoints[i] for i in chain] + [tuple(b)]

    def distance(self, a, b) -> float:
        pts = self.path(a, b)
        return sum(hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
                   for i in range(len(pts) - 1))

    def _dijkstra(self, source: int, target: int) -> dict[int, int]:
        dist = {source: 0.0}
        prev: dict[int, int] = {}
        pq = [(0.0, source)]
        while pq:
            d, u = heapq.heappop(pq)
            if u == target:
                break
            if d > dist.get(u, float("inf")):
                continue
            for v, w in self._adj.get(u, ()):
                nd = d + w
                if nd < dist.get(v, float("inf")):
                    dist[v] = nd
                    prev[v] = u
                    heapq.heappush(pq, (nd, v))
        return prev

    def to_dict(self) -> dict:
        """Serialisable network for the 2D view (waypoints + edge index pairs)."""
        return {"waypoints": [[round(x, 2), round(y, 2)] for (x, y) in self.waypoints],
                "edges": [[i, j] for (i, j) in self.edges]}

    @classmethod
    def from_model(cls, model) -> "NavNetwork":
        layout = getattr(model, "layout", None)
        bounds = getattr(layout, "bounds", None) if layout else None
        width = float(getattr(bounds, "width", 80.0)) if bounds else 80.0
        depth = float(getattr(bounds, "depth", 40.0)) if bounds else 40.0
        obstacles: list[tuple[float, float, float, float]] = []
        for z in (getattr(layout, "zones", []) or []):
            if getattr(z, "type", None) != "storage":
                continue
            for sh in (getattr(z, "shelves", None) or []):
                try:
                    obstacles.append((float(sh.x), float(sh.y), float(sh.w), float(sh.h)))
                except (TypeError, ValueError, AttributeError):
                    continue
        return cls(width, depth, obstacles)
