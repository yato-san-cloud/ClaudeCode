"""MapMaker-style waypoint navigation network (Delaunay over a free-space graph).

MapMaker generates a cart travel network (Delaunay triangulation + waypoints + a
shortest-path graph). This mirrors that: waypoints are placed in the aisles just
off each rack corner (plus the floor boundary); a Delaunay triangulation over
them (via ``matplotlib.tri`` — no scipy) gives candidate edges; edges that stay in
free space form the navigation graph. ``path``/``distance`` connect endpoints to
the nearest *visible* waypoint and run Dijkstra, yielding smooth aisle routes (and
a network the 2D view can draw).

**M4 — facing-aware open-face pick points.** On top of the Delaunay aisle net we
add MapMaker's *open-face* pick points (the correctness core of
``CartNetworkGenerator.setWaypointsForTargets``, decompiled lines ~217–279). For
every authored shelf (and rack run) we probe the 4 side-midpoints, offset each
outward along its normal by ``offset`` (~0.5 m, MapMaker's ``offset_mm = 500``),
and keep a face **only if that offset point reaches the shelf centre without
clipping another obstacle** — i.e. the face opens onto free aisle, not into a
back-to-back neighbour or a wall. When the shelf carries an authored ``facing``
we *prefer* that face; otherwise every geometrically-open face is kept. Kept pick
points are wired into the waypoint graph, so routes approach a slot from the
aisle and never cut through a rack, and back-to-back shelves are reachable only
from their outer faces. "The drawn map IS the routing truth."

This is the visualization/geometry layer; the engine's authoritative timing still
uses the obstacle-aware grid (``engine.graph``). Both route around the same racks.
"""

from __future__ import annotations

import heapq
from math import hypot

import numpy as np

from whsim.rackgeom import rack_facings, rack_rects

# Outward offset for an open-face pick point, in metres. Ported verbatim intent
# from MapMaker's CartNetworkGenerator.offset_mm = 500.0 (mm) → 0.5 m.
_OPEN_FACE_OFFSET = 0.5

# Map an authored ShelfArea.facing onto the side-midpoint it opens toward, in the
# y-down floor frame whsim uses (y grows "down"/into the depth). The probe points
# are: left = -x face, right = +x face, up = -y face, down = +y face.
_FACING_SIDE = {"left": 0, "right": 1, "up": 2, "down": 3}

# Spatial-hash cell size (metres) for the obstacle grid: probes only test the
# rectangles near their bounding box instead of every shelf on the floor (the
# all-rects scan made the network build take minutes on MapMaker-scale imports).
_OBS_CELL_M = 6.0


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
                 clearance: float = 0.7,
                 facings: list[str | None] | None = None,
                 offset: float = _OPEN_FACE_OFFSET) -> None:
        self.width = max(float(width), 1e-6)
        self.depth = max(float(depth), 1e-6)
        self.obstacles = list(obstacles or [])
        self.clearance = clearance
        self.offset = max(float(offset), 1e-6)
        # Per-obstacle authored facing hint (advisory), aligned with `obstacles`.
        # Absent / shorter list => treat the missing entries as None (all faces).
        facings = list(facings or [])
        self.facings: list[str | None] = [
            (facings[i] if i < len(facings) else None)
            for i in range(len(self.obstacles))
        ]
        self.waypoints: list[tuple[float, float]] = []
        self.edges: list[tuple[int, int]] = []
        # Indices (into self.waypoints) of the open-face pick points we appended.
        self.pick_points: list[int] = []
        self._adj: dict[int, list[tuple[int, float]]] = {}
        # Spatial hash: cell -> obstacle indices whose bbox overlaps the cell.
        # A pure candidate filter (callers still run the exact tests), so the
        # geometry answers are identical to the full scan — just not O(N) each.
        self._obs_grid: dict[tuple[int, int], list[int]] = {}
        c = _OBS_CELL_M
        for i, (rx, ry, rw, rh) in enumerate(self.obstacles):
            for cx in range(int(rx // c), int((rx + rw) // c) + 1):
                for cy in range(int(ry // c), int((ry + rh) // c) + 1):
                    self._obs_grid.setdefault((cx, cy), []).append(i)
        self._build()

    # --------------------------------------------------------------- geometry
    def _near_obstacles(self, a, b):
        """Indices of obstacles whose bbox cells overlap segment a-b's bbox cells
        (a superset of every rect the segment could touch or hold its midpoint in)."""
        c = _OBS_CELL_M
        x0 = int(min(a[0], b[0]) // c)
        x1 = int(max(a[0], b[0]) // c)
        y0 = int(min(a[1], b[1]) // c)
        y1 = int(max(a[1], b[1]) // c)
        if (x1 - x0 + 1) * (y1 - y0 + 1) >= len(self._obs_grid):
            return range(len(self.obstacles))   # probe spans the floor: test all
        grid = self._obs_grid
        seen: set[int] = set()
        out: list[int] = []
        for cx in range(x0, x1 + 1):
            for cy in range(y0, y1 + 1):
                for i in grid.get((cx, cy), ()):
                    if i not in seen:
                        seen.add(i)
                        out.append(i)
        return out

    def _inside(self, x: float, y: float, eps: float = 1e-6) -> bool:
        c = _OBS_CELL_M
        obstacles = self.obstacles
        for i in self._obs_grid.get((int(x // c), int(y // c)), ()):
            rx, ry, rw, rh = obstacles[i]
            if rx + eps < x < rx + rw - eps and ry + eps < y < ry + rh - eps:
                return True
        return False

    def _seg_free(self, a, b, ignore: int = -1) -> bool:
        """True if segment a-b does not cut through any obstacle rectangle.

        ``ignore`` (an index into ``self.obstacles``) skips one rectangle — used
        for the open-face probe, which casts from a shelf's outward-offset point
        toward its own centre and must ignore the shelf being probed (MapMaker's
        ``obstacleScanner.isClipping_ignore(coord, center, shelf)``).
        """
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        obstacles = self.obstacles
        for idx in self._near_obstacles(a, b):
            if idx == ignore:
                continue
            rx, ry, rw, rh = obstacles[idx]
            if rx + 1e-6 < mx < rx + rw - 1e-6 and ry + 1e-6 < my < ry + rh - 1e-6:
                return False
            cs = [(rx, ry), (rx + rw, ry), (rx + rw, ry + rh), (rx, ry + rh)]
            for i in range(4):
                if _seg_intersect(a, b, cs[i], cs[(i + 1) % 4]):
                    return False
        return True

    def _open_faces(self, idx: int) -> list[tuple[float, float]]:
        """MapMaker open-face probe for obstacle ``idx``.

        Port of ``CartNetworkGenerator.setWaypointsForTargets`` (decompiled lines
        ~217–279): take the 4 side-midpoints, push each out along its outward
        normal by ``self.offset``, and keep a face ONLY if the offset point can
        reach the shelf centre without clipping *another* obstacle
        (``isClipping_ignore(coord, center, shelf)``) and lands in free space
        inside the floor. When this shelf has an authored ``facing`` we keep just
        that face if it is open; if the preferred face is blocked we fall back to
        every open face so a shelf is never stranded (MapMaker warns
        "全面が塞がれている" only when *no* face opens).
        """
        rx, ry, rw, rh = self.obstacles[idx]
        cx, cy = rx + rw / 2, ry + rh / 2
        off = self.offset
        # Side-midpoints in MapMaker's order [left(-x), right(+x), up(-y), down(+y)],
        # each already pushed outward by `off` along the side's outward normal.
        sides = [
            (rx - off, cy),        # left   (-x)
            (rx + rw + off, cy),   # right  (+x)
            (cx, ry - off),        # up     (-y)
            (cx, ry + rh + off),   # down   (+y)
        ]
        open_pts: list[tuple[float, float]] = []
        open_sides: list[int] = []
        for s, (px, py) in enumerate(sides):
            # Clamp to the floor; a point shoved outside the building is not usable.
            if not (0.0 <= px <= self.width and 0.0 <= py <= self.depth):
                continue
            # Open iff the offset point isn't buried in another obstacle AND it
            # reaches the centre without clipping a *different* rectangle.
            if self._inside(px, py):
                continue
            if not self._seg_free((px, py), (cx, cy), ignore=idx):
                continue
            open_pts.append((round(px, 2), round(py, 2)))
            open_sides.append(s)
        if not open_pts:
            return []
        # Advisory facing: prefer the authored face when it is geometrically open.
        face = self.facings[idx]
        pref = _FACING_SIDE.get(face) if face else None
        if pref is not None and pref in open_sides:
            return [open_pts[open_sides.index(pref)]]
        return open_pts

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
        self._adj = adj
        self.edges = sorted(set(edges))
        # M4: append facing-aware open-face pick points and wire them in. Done
        # after the aisle net exists so each pick point connects to the visible
        # aisle waypoints (MapMaker's waypointsNeedingConnectingToFreeWaypoints).
        self._add_pick_points()
        self.edges = sorted(set(self.edges))

    def _add_pick_points(self) -> None:
        """Generate open-face pick points per obstacle and connect them in.

        Each kept pick point becomes a waypoint connected to the nearby aisle
        waypoints whose straight segment is unobstructed — the analogue of
        MapMaker connecting each ``_free`` pick waypoint to its nearest free
        waypoints (lines ~419–426). De-duplicated so coincident faces of adjacent
        shelves collapse to one node, keeping the graph small.
        """
        base_n = len(self.waypoints)
        if base_n == 0:
            return
        index_for: dict[tuple[float, float], int] = {
            wp: i for i, wp in enumerate(self.waypoints)
        }
        for idx in range(len(self.obstacles)):
            for pp in self._open_faces(idx):
                if self._inside(*pp):
                    continue
                pi = index_for.get(pp)
                if pi is None:
                    pi = len(self.waypoints)
                    self.waypoints.append(pp)
                    self._adj[pi] = []
                    index_for[pp] = pi
                    self.pick_points.append(pi)
                # Connect this pick point to nearby aisle waypoints it can see.
                # Bounded fan-out (nearest ~12) keeps the graph sparse like the
                # KD-tree n_nearestNeighbour cap MapMaker uses.
                order = sorted(
                    range(base_n),
                    key=lambda k: hypot(self.waypoints[pi][0] - self.waypoints[k][0],
                                        self.waypoints[pi][1] - self.waypoints[k][1]))
                connected = 0
                for k in order:
                    if k == pi:
                        continue
                    if not self._seg_free(self.waypoints[pi], self.waypoints[k]):
                        continue
                    w = hypot(self.waypoints[pi][0] - self.waypoints[k][0],
                              self.waypoints[pi][1] - self.waypoints[k][1])
                    if not any(nb == k for nb, _ in self._adj[pi]):
                        self._adj[pi].append((k, w))
                        self._adj[k].append((pi, w))
                        self.edges.append((min(pi, k), max(pi, k)))
                    connected += 1
                    if connected >= 12:
                        break

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

    def _simplify(self, pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
        """Line-of-sight smoothing: drop a waypoint when the straight segment from
        the previous kept point to the next one is unobstructed. Keeps the first
        and last points; only short-circuits genuine free shots, so routes stay
        obstacle-free but flow as straight as the geometry allows."""
        if len(pts) <= 2:
            return pts
        out = [pts[0]]
        i = 0
        n = len(pts)
        while i < n - 1:
            j = n - 1
            while j > i + 1:
                if self._seg_free(out[-1], pts[j]):
                    break
                j -= 1
            out.append(pts[j])
            i = j
        return out

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
        route = [tuple(a)] + [self.waypoints[i] for i in chain] + [tuple(b)]
        return self._simplify(route)

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
        facings: list[str | None] = []
        for z in (getattr(layout, "zones", []) or []):
            if getattr(z, "type", None) != "storage":
                continue
            for sh in (getattr(z, "shelves", None) or []):
                try:
                    obstacles.append((float(sh.x), float(sh.y), float(sh.w), float(sh.h)))
                except (TypeError, ValueError, AttributeError):
                    continue
                # Advisory facing hint (None when unset / unknown).
                facings.append(getattr(sh, "facing", None))
        # ...plus the rack runs as DRAWN. Parametric racks live only in
        # ``model.locations``, so the authored loop above never sees them and the
        # waypoint net came out EMPTY for template layouts (no 通路網, no open-face
        # pick points). Same reconstruction ``engine.graph`` routes on and the
        # 2D/3D draw, so the aisle network can never disagree with the racking.
        # Deduped, so an authored MapMaker model is unchanged.
        seen = {tuple(round(v, 4) for v in r) for r in obstacles}
        extra_facings = rack_facings(model)
        for i, rect in enumerate(rack_rects(model)):
            key = tuple(round(v, 4) for v in rect)
            if key in seen:
                continue
            seen.add(key)
            obstacles.append(rect)
            facings.append(extra_facings[i] if i < len(extra_facings) else None)
        return cls(width, depth, obstacles, facings=facings)
