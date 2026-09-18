"""レイアウト診断 — design-time validation of a DRAWN (possibly unsaved) layout.

The 動線 editor asks one question while a salesperson is still moving shelves
around: *would anyone actually be able to walk this floor?* This module answers
it as a pure function over the same geometry the simulation routes on:

* ``unreachable`` — racks with **no reachable open pick face**. "Open face" is
  MapMaker's own probe (``engine.navnet.NavNetwork._open_faces``); "reachable"
  means that face lands on the MAIN connected component of
  ``engine.graph.AisleGraph``'s walkable grid. So a rack the audit calls
  unreachable is exactly a rack the engine could not route a picker to.
* ``components`` — connected components of the walkable floor. More than one and
  the layout has an isolated pocket (a room with no door, an aisle sealed by a
  shelf someone just dragged).
* ``narrow`` — aisle pinch points below a width threshold, measured analytically
  from the rack rectangles (NOT off the grid), so the reported width is exact and
  independent of the grid pitch. Two levels: 人 (default 1.2 m) and フォークリフト
  (default 2.5 m).
* ``deadends`` — cul-de-sac aisle stubs (grid nodes with a single passable
  neighbour).

Never blocks: junk input degrades to an empty-but-sane result, never an
exception. Every list is capped so the payload stays small enough to poll on
every keystroke of a layout edit.
"""

from __future__ import annotations

from math import hypot

# --- thresholds (all overridable per call; these are the defaults the UI ships)
# 人が普通に歩ける最低通路幅 (一般的な倉庫設計の目安).
DEFAULT_PERSON_AISLE_M = 1.2
# カウンターフォークリフトが旋回・すれ違いできる最低通路幅.
DEFAULT_FORKLIFT_AISLE_M = 2.5
# これ未満の隙間は「通路」ではなく背中合わせラックの施工クリアランス扱い.
DEFAULT_SEAM_M = 0.25
# これ未満の自由床の塊はラスタライズの副産物 (棚の縁に乗った点) とみなす.
MIN_POCKET_M2 = 1.0
# 返却リストの上限 (ライブ編集で毎回投げるので payload を小さく保つ).
MAX_ITEMS = 60
# 人流アニメーション用に返す「到達できるピック面」の上限.
MAX_PICK_POINTS = 48
# 狭通路スキャンで組合せを見る矩形数の上限 (これを超えたら省略, never blocks).
MAX_SCAN_RECTS = 2000


# ---------------------------------------------------------------- narrow aisles


def _bucket_rects(rects, cell: float):
    """Uniform spatial hash: cell -> rect indices whose bbox overlaps the cell."""
    grid: dict[tuple[int, int], list[int]] = {}
    for i, (x, y, w, h) in enumerate(rects):
        for cx in range(int(x // cell), int((x + w) // cell) + 1):
            for cy in range(int(y // cell), int((y + h) // cell) + 1):
                grid.setdefault((cx, cy), []).append(i)
    return grid


def _merge_spans(items: list[tuple[float, float]], join: float = 4.0):
    """Merge overlapping / near-touching 1-D spans (used to collapse the 22 identical
    perimeter gaps of a rack field into the two lanes a human would point at)."""
    if not items:
        return []
    items = sorted(items)
    out = [list(items[0])]
    for a, b in items[1:]:
        if a <= out[-1][1] + join:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def narrow_aisles(
    rects,
    width: float,
    depth: float,
    person_m: float = DEFAULT_PERSON_AISLE_M,
    forklift_m: float = DEFAULT_FORKLIFT_AISLE_M,
    seam_m: float = DEFAULT_SEAM_M,
) -> tuple[list[dict], float | None]:
    """Pinch points narrower than ``forklift_m``, plus the narrowest gap seen.

    A gap counts when the two rectangles (or a rectangle and a floor edge)
    actually face each other — i.e. they overlap along the perpendicular axis —
    and the clear distance between them is in ``[seam_m, forklift_m)``. Below
    ``seam_m`` it is a back-to-back seam, not a lane, and flagging it would bury
    the real findings.

    Returns ``(entries, min_gap_m)``; each entry is
    ``{gap_m, axis, level, segment:[[x1,y1],[x2,y2]], point}``.
    """
    rects = [r for r in rects if r[2] > 1e-6 and r[3] > 1e-6]
    n = len(rects)
    if not n or n > MAX_SCAN_RECTS:
        return [], None
    thr = max(float(forklift_m), float(person_m))
    seam = max(0.0, float(seam_m))
    cell = max(4.0, thr * 2.0)
    grid = _bucket_rects(rects, cell)

    # raw[(axis, centre_coord, gap)] -> list of perpendicular spans
    raw: dict[tuple[str, float, float], list[tuple[float, float]]] = {}
    min_gap: float | None = None

    def record(axis: str, centre: float, gap: float, s0: float, s1: float) -> None:
        nonlocal min_gap
        if gap < seam:
            return
        if min_gap is None or gap < min_gap:
            min_gap = gap
        if gap >= thr - 1e-6:
            return
        key = (axis, round(centre, 2), round(gap, 2))
        raw.setdefault(key, []).append((s0, s1))

    seen: set[tuple[int, int]] = set()
    for i in range(n):
        xi, yi, wi, hi = rects[i]
        # Perimeter aisles: the clear run between the rack and each floor edge.
        record("x", xi / 2.0, xi, yi, yi + hi)
        record("x", (xi + wi + width) / 2.0, width - (xi + wi), yi, yi + hi)
        record("y", yi / 2.0, yi, xi, xi + wi)
        record("y", (yi + hi + depth) / 2.0, depth - (yi + hi), xi, xi + wi)
        # Rack-to-rack: only the neighbours within a threshold of this bbox.
        cand: set[int] = set()
        for cx in range(int((xi - thr) // cell), int((xi + wi + thr) // cell) + 1):
            for cy in range(int((yi - thr) // cell), int((yi + hi + thr) // cell) + 1):
                cand.update(grid.get((cx, cy), ()))
        for j in cand:
            if j == i:
                continue
            key = (min(i, j), max(i, j))
            if key in seen:
                continue
            seen.add(key)
            xj, yj, wj, hj = rects[j]
            ov_y = min(yi + hi, yj + hj) - max(yi, yj)
            if ov_y > 1e-9:
                gap = max(xj - (xi + wi), xi - (xj + wj))
                if gap > -1e-9:
                    lo, hi_ = (xi + wi, xj) if xj > xi else (xj + wj, xi)
                    record("x", (lo + hi_) / 2.0, gap,
                           max(yi, yj), min(yi + hi, yj + hj))
            ov_x = min(xi + wi, xj + wj) - max(xi, xj)
            if ov_x > 1e-9:
                gap = max(yj - (yi + hi), yi - (yj + hj))
                if gap > -1e-9:
                    lo, hi_ = (yi + hi, yj) if yj > yi else (yj + hj, yi)
                    record("y", (lo + hi_) / 2.0, gap,
                           max(xi, xj), min(xi + wi, xj + wj))

    out: list[dict] = []
    for (axis, centre, gap), spans in raw.items():
        for s0, s1 in _merge_spans(spans):
            if s1 - s0 <= 1e-6:
                continue
            if axis == "x":
                seg = [[centre, s0], [centre, s1]]
                pt = [centre, (s0 + s1) / 2.0]
            else:
                seg = [[s0, centre], [s1, centre]]
                pt = [(s0 + s1) / 2.0, centre]
            out.append({
                "gap_m": round(gap, 2),
                "axis": axis,
                "level": "person" if gap < person_m - 1e-6 else "forklift",
                "segment": [[round(v, 2) for v in p] for p in seg],
                "point": [round(v, 2) for v in pt],
                "length_m": round(s1 - s0, 2),
            })
    # Worst (narrowest) first, then longest — the first few are what to fix.
    out.sort(key=lambda e: (e["gap_m"], -e["length_m"]))
    return out[:MAX_ITEMS], min_gap


# ------------------------------------------------------------------- the audit


def audit(
    width: float,
    depth: float,
    wall_segments,
    obstacles,
    graph=None,
    person_aisle_m: float = DEFAULT_PERSON_AISLE_M,
    forklift_aisle_m: float = DEFAULT_FORKLIFT_AISLE_M,
    seam_m: float = DEFAULT_SEAM_M,
) -> dict:
    """Audit one live layout. Pure, tolerant, and cheap enough for live editing.

    ``graph`` lets the caller hand in an already-built :class:`AisleGraph` (the
    network endpoint builds one anyway) so a live edit pays for the grid once.
    """
    from whsim.engine.graph import AisleGraph, min_aisle_gap

    def _f(v, default: float) -> float:
        try:
            f = float(v)
        except (TypeError, ValueError):
            return default
        return default if f != f else f          # NaN → default

    width = max(1.0, _f(width, 80.0))
    depth = max(1.0, _f(depth, 40.0))
    rects: list[tuple[float, float, float, float]] = []
    for r in (obstacles or []):
        try:
            x, y, w, h = (float(v) for v in r[:4])
        except (TypeError, ValueError, IndexError):
            continue                              # junk rect: skip, never fatal
        if w > 1e-6 and h > 1e-6:
            rects.append((x, y, w, h))
    segments: list[tuple[tuple[float, float], tuple[float, float]]] = []
    for s in (wall_segments or []):
        try:
            (ax, ay), (bx, by) = ((float(s[0][0]), float(s[0][1])),
                                  (float(s[1][0]), float(s[1][1])))
        except (TypeError, ValueError, IndexError, KeyError):
            continue                              # junk segment: skip, never fatal
        segments.append(((ax, ay), (bx, by)))

    g = graph
    if g is None:
        g = AisleGraph(width, depth, segments,
                       resolution=1.0, obstacle_rects=rects, auto_resolution=True)
    res = g.resolution
    cell_area = res * res
    occ = g._occupied
    main = getattr(g, "_main_comp", -1)

    # --- connected components of the walkable floor ---------------------------
    # Single-node blobs (and anything under MIN_POCKET_M2) are rasterisation
    # artefacts — a node pinned exactly on a rack edge has every incident edge
    # "crossing" it — not rooms. Only real pockets are reported.
    sizes = getattr(g, "_comp_size", []) or []
    comp = getattr(g, "_comp", []) or []
    sums: dict[int, list[float]] = {}
    for idx, cid in enumerate(comp):
        if cid < 0:
            continue
        if sizes[cid] < 2 or sizes[cid] * cell_area < MIN_POCKET_M2:
            continue
        c, r = idx % g.ncols, idx // g.ncols
        x, y = g._node_xy(c, r)
        acc = sums.setdefault(cid, [0.0, 0.0, 0.0])
        acc[0] += x
        acc[1] += y
        acc[2] += 1.0
    # Representative point = the member node nearest the pocket's centroid (always
    # ON the pocket, unlike the centroid of an L-shaped area). One extra pass.
    best: dict[int, tuple[float, float, float]] = {}
    for idx, cid in enumerate(comp):
        acc = sums.get(cid)
        if acc is None:
            continue
        cx, cy = acc[0] / acc[2], acc[1] / acc[2]
        c, r = idx % g.ncols, idx // g.ncols
        x, y = g._node_xy(c, r)
        d = hypot(x - cx, y - cy)
        cur = best.get(cid)
        if cur is None or d < cur[0]:
            best[cid] = (d, x, y)
    pockets: list[dict] = []
    for cid, (sx, sy, cnt) in sums.items():
        b = best.get(cid)
        pockets.append({
            "id": int(cid),
            "area_m2": round(cnt * cell_area, 1),
            "main": cid == main,
            "point": [round(b[1], 2), round(b[2], 2)] if b else [0.0, 0.0],
        })
    pockets.sort(key=lambda p: -p["area_m2"])
    pockets = pockets[:MAX_ITEMS]

    # --- unreachable racks ----------------------------------------------------
    # MapMaker's open-face probe decides which faces a picker could stand at; the
    # routing grid decides whether that face is on the floor everyone else walks.
    unreachable: list[dict] = []
    pick_points: list[list[float]] = []
    if rects:
        from whsim.engine.navnet import NavNetwork
        probe = NavNetwork(width, depth, rects, build=False)
        reach = max(res * 1.2, 0.6)
        for i, (rx, ry, rw, rh) in enumerate(rects):
            faces = probe._open_faces(i)
            if not faces:
                unreachable.append({
                    "index": i,
                    "rect": [round(rx, 2), round(ry, 2), round(rw, 2), round(rh, 2)],
                    "point": [round(rx + rw / 2, 2), round(ry + rh / 2, 2)],
                    "reason": "blocked",
                })
                continue
            ok = False
            hit: tuple[float, float] | None = None
            for (fx, fy) in faces:
                c0 = max(0, int((fx - reach) / res))
                c1 = min(g.ncols - 1, int((fx + reach) / res) + 1)
                r0 = max(0, int((fy - reach) / res))
                r1 = min(g.nrows - 1, int((fy + reach) / res) + 1)
                for r in range(r0, r1 + 1):
                    for c in range(c0, c1 + 1):
                        idx = r * g.ncols + c
                        if occ[idx] or (main >= 0 and comp[idx] != main):
                            continue
                        nx, ny = g._node_xy(c, r)
                        if hypot(nx - fx, ny - fy) <= reach:
                            ok = True
                            hit = (fx, fy)
                            break
                    if ok:
                        break
                if ok:
                    break
            if ok:
                # A face a picker can genuinely stand at — the 人流アニメーション
                # walks to these, so it can only ever show routes that exist.
                if hit is not None:
                    pick_points.append([round(hit[0], 2), round(hit[1], 2)])
            else:
                unreachable.append({
                    "index": i,
                    "rect": [round(rx, 2), round(ry, 2), round(rw, 2), round(rh, 2)],
                    "point": [round(faces[0][0], 2), round(faces[0][1], 2)],
                    "reason": "isolated",
                })
    unreachable_n = len(unreachable)
    # Even sample across the whole rack field (not the first N racks) so the
    # animation spreads over the floor instead of crowding one corner.
    if len(pick_points) > MAX_PICK_POINTS:
        step = len(pick_points) / float(MAX_PICK_POINTS)
        pick_points = [pick_points[int(i * step)] for i in range(MAX_PICK_POINTS)]

    # --- narrow aisles --------------------------------------------------------
    narrow, scanned_min = narrow_aisles(rects, width, depth,
                                        person_m=person_aisle_m,
                                        forklift_m=forklift_aisle_m,
                                        seam_m=seam_m)
    narrow_person_n = sum(1 for e in narrow if e["level"] == "person")
    min_aisle = scanned_min
    if min_aisle is None:
        min_aisle = min_aisle_gap(rects, width, depth)

    # --- dead-end stubs -------------------------------------------------------
    # A free node on the main floor with exactly one passable neighbour is the tip
    # of a cul-de-sac: you can walk in, you can only walk back out.
    deadends: list[dict] = []
    if main >= 0:
        for idx, cid in enumerate(comp):
            if cid != main or occ[idx]:
                continue
            deg = 0
            for _ in g._neighbors(idx):
                deg += 1
                if deg > 1:
                    break
            if deg == 1:
                c, r = idx % g.ncols, idx // g.ncols
                x, y = g._node_xy(c, r)
                deadends.append({"point": [round(x, 2), round(y, 2)]})
                if len(deadends) >= MAX_ITEMS:
                    break

    components_n = len(pockets)
    ok = unreachable_n == 0 and components_n <= 1 and narrow_person_n == 0
    return {
        "ok": ok,
        "resolution": round(res, 3),
        "unreachable": unreachable[:MAX_ITEMS],
        "components": pockets,
        "narrow": narrow,
        "deadends": deadends,
        "pick_points": pick_points,
        "thresholds": {
            "person_m": float(person_aisle_m),
            "forklift_m": float(forklift_aisle_m),
            "seam_m": float(seam_m),
        },
        "summary": {
            "ok": ok,
            "unreachable_n": unreachable_n,
            "components": components_n,
            "narrow_n": len(narrow),
            "narrow_person_n": narrow_person_n,
            "deadends_n": len(deadends),
            "racks_n": len(rects),
            "min_aisle_m": (round(min_aisle, 2) if min_aisle is not None else None),
        },
    }


def empty_audit() -> dict:
    """A valid, empty-but-sane result — what a caller gets when there is nothing
    to audit (or when something upstream went wrong). "Never blocks"."""
    return {
        "ok": True,
        "resolution": 1.0,
        "unreachable": [],
        "components": [],
        "narrow": [],
        "deadends": [],
        "pick_points": [],
        "thresholds": {
            "person_m": DEFAULT_PERSON_AISLE_M,
            "forklift_m": DEFAULT_FORKLIFT_AISLE_M,
            "seam_m": DEFAULT_SEAM_M,
        },
        "summary": {
            "ok": True, "unreachable_n": 0, "components": 0, "narrow_n": 0,
            "narrow_person_n": 0, "deadends_n": 0, "racks_n": 0,
            "min_aisle_m": None,
        },
    }
