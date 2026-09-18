"""Tolerant importer for a MapMaker (Hitachi WorldMap) **Map CSV**.

MapMaker authors a floor by placing objects — `SHELF` (rack area), `WALL`,
`STATION`, `CONSTRAINED_AREA`, `BEACON`, `STAIRS` — plus `META` rows (`BBOX`
extents, `SHELF_NAME_LIST`). We don't have the exact column spec (it ships as a
compiled jar), so this importer is deliberately **forgiving** in the whsim house
style: it recognises rows by their object-type keyword, reads the numeric
coordinates that follow, auto-detects mm-vs-m from the extent, and maps what it
can onto the whsim layout. A row it can't parse is skipped, never fatal — a
partial import is fine.

Returns ``{bounds, zones, walls, stations, warnings, stats}`` (same shape the CAD
importer feeds the layout). SHELF rectangles become one storage zone's authored
``shelves`` so locations materialise *inside the drawn shelves*, MapMaker-style.
"""

from __future__ import annotations

import re

# Object/meta keywords MapMaker writes (from Constants$MapCsv*Type in the jar).
_OBJ_TOKENS = {"SHELF", "WALL", "STATION", "CONSTRAINED_AREA", "BEACON", "STAIRS"}
_META_TOKENS = {"BBOX", "BG_IMG", "SHELF_NAME_LIST"}
_NUM_RE = re.compile(r"^-?\d+(?:\.\d+)?$")


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "cp932", "shift_jis", "utf-8", "latin-1"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("latin-1", "replace")


def _split(line: str) -> list[str]:
    sep = "\t" if ("\t" in line and "," not in line) else ","
    return [c.strip() for c in line.split(sep)]


def _classify(cells: list[str]) -> str | None:
    """First recognised object/meta keyword in the row (case-insensitive)."""
    for c in cells:
        u = c.strip().upper()
        if u in _OBJ_TOKENS or u in _META_TOKENS:
            return u
    return None


def _nums_after(cells: list[str], kind: str) -> list[float]:
    """Numeric values that follow the type keyword (coords sit after the type)."""
    out: list[float] = []
    seen = False
    for c in cells:
        u = c.strip().upper()
        if not seen:
            if u == kind:
                seen = True
            continue
        if _NUM_RE.match(c.strip()):
            out.append(float(c))
    return out


def _rect(nums: list[float]) -> tuple[float, float, float, float] | None:
    """4 numbers → (x, y, w, h) treating them as two opposite corners."""
    if len(nums) < 4:
        return None
    x1, y1, x2, y2 = nums[0], nums[1], nums[2], nums[3]
    x, y = min(x1, x2), min(y1, y2)
    w, h = abs(x2 - x1), abs(y2 - y1)
    if w <= 0 or h <= 0:
        return None
    return (x, y, w, h)


def import_mapcsv_bytes(data: bytes) -> dict:
    warnings: list[str] = []
    rows = [_split(ln) for ln in _decode(data).splitlines() if ln.strip()]
    rects: list[tuple[float, float, float, float]] = []     # SHELF rectangles
    walls_seg: list[tuple[float, float, float, float]] = []  # WALL segments
    pts: list[tuple[float, float]] = []                      # STATION points
    bbox: tuple[float, float, float, float] | None = None
    skipped = {"CONSTRAINED_AREA": 0, "STAIRS": 0, "BEACON": 0, "other": 0}

    for cells in rows:
        kind = _classify(cells)
        if kind is None:
            continue
        nums = _nums_after(cells, kind)
        if kind == "BBOX":
            r = _rect(nums)
            if r:
                bbox = r
        elif kind == "SHELF":
            r = _rect(nums)
            if r:
                rects.append(r)
        elif kind == "WALL":
            if len(nums) >= 4:
                walls_seg.append((nums[0], nums[1], nums[2], nums[3]))
        elif kind == "STATION":
            if len(nums) >= 2:
                pts.append((nums[0], nums[1]))
        elif kind in skipped:
            skipped[kind] += 1
        # BG_IMG / SHELF_NAME_LIST: nothing geometric to place.

    if not (rects or walls_seg or pts or bbox):
        return {"bounds": None, "zones": [], "walls": [], "stations": [],
                "warnings": ["MapMaker Map CSV として認識できる行がありませんでした。"],
                "stats": {"shelves": 0, "scale": 1.0, "units": "unknown"}}

    # --- unit auto-detect (mm vs m) from the overall extent --------------------
    coords: list[float] = []
    for (x, y, w, h) in rects + ([bbox] if bbox else []):
        coords += [x, y, x + w, y + h]
    for (x1, y1, x2, y2) in walls_seg:
        coords += [x1, y1, x2, y2]
    for (px, py) in pts:
        coords += [px, py]
    span = (max(coords) - min(coords)) if coords else 0.0
    scale, units = (0.001, "mm") if span > 2000 else (1.0, "m")

    # Translate so the min corner sits at the origin, then scale to metres.
    minx = min((c for c in (
        [r[0] for r in rects] + [w[0] for w in walls_seg] + [w[2] for w in walls_seg]
        + [p[0] for p in pts] + ([bbox[0]] if bbox else []))), default=0.0)
    miny = min((c for c in (
        [r[1] for r in rects] + [w[1] for w in walls_seg] + [w[3] for w in walls_seg]
        + [p[1] for p in pts] + ([bbox[1]] if bbox else []))), default=0.0)

    def sx(v: float) -> float:
        return round((v - minx) * scale, 3)

    def sy(v: float) -> float:
        return round((v - miny) * scale, 3)

    shelves = [{"id": f"s{i}", "x": sx(x), "y": sy(y),
                "w": round(w * scale, 3), "h": round(h * scale, 3)}
               for i, (x, y, w, h) in enumerate(rects)]
    walls = [{"id": f"w{i}", "points": [[sx(x1), sy(y1)], [sx(x2), sy(y2)]],
              "thickness": 0.2}
             for i, (x1, y1, x2, y2) in enumerate(walls_seg)]
    stations = [{"id": f"st{i}", "x": sx(px), "y": sy(py)}
                for i, (px, py) in enumerate(pts)]

    if bbox:
        bw, bh = round(bbox[2] * scale, 3), round(bbox[3] * scale, 3)
    else:
        bw = round(max(coords) * scale - minx * scale, 3) if coords else 0.0
        bh = bw
    bounds = {"width": max(bw, 1.0), "depth": max(bh, 1.0)}

    zones = []
    if shelves:
        zones.append({"id": "storage", "type": "storage",
                      "x": 0.0, "y": 0.0, "w": bounds["width"], "h": bounds["depth"],
                      "rack": None, "shelves": shelves})

    for k, n in skipped.items():
        if n:
            warnings.append(f"{k} を {n} 件読み込みましたが、現状の単一フロアモデルでは"
                            "ジオメトリ化を見送りました。")
    warnings.append("Map CSV は最善努力で解釈しています。寸法/位置は設計タブでご確認ください。")

    return {"bounds": bounds, "zones": zones, "walls": walls, "stations": stations,
            "warnings": warnings,
            "stats": {"shelves": len(shelves), "walls": len(walls),
                      "stations": len(stations), "scale": scale, "units": units}}
