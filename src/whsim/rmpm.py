"""Tolerant importer for a MapMaker (Hitachi WorldMap) native **.rmpm.json** export.

MapMaker's native save (``.rmpm``) exports to a simple JSON shape::

    floor { name, bounds{left,top,right,bottom}, view{centerX,centerY,zoom},
            objects[ { type, id, x, y, w, h, name? } ] }

Units are **mm**, axis-aligned rectangles, origin top-left, +x right / +y down.
Object types seen in the wild: ``WallObject``, ``FreeShelfObject`` (a *named*
shelf), ``ShelfObject``, ``StationObject`` (検品/作業場), ``ConstrainedAreaObject``,
``OneWayPassageObject``, ``StairsObject``, ``BeaconObject``.

We map what whsim's single-floor layout can hold (shelves / walls / stations /
bounds) in the house style: anything we can't place is skipped with a warning,
never fatal — a partial import is fine. Crucially, shelves keep their MapMaker
**name** so locations materialise with addressable names (loaded stock data can
later slot by shelf name). Returns the same ``{bounds, zones, walls, stations,
warnings, stats}`` shape as ``mapcsv``/``cad`` so the import endpoint applies it
uniformly.
"""

from __future__ import annotations

import json

_SHELF_TYPES = {"FreeShelfObject", "ShelfObject"}
_WALL_TYPES = {"WallObject"}
_STATION_TYPES = {"StationObject"}
# MapMaker stores the picking base/dispatch points as pseudo-shelves named
# "START"/"END" (FreeShelfArea.pickingStartEndShelf) — not real storage; skip them.
_MARKER_NAMES = {"START", "END"}


def _num(v) -> float | None:
    """Float or None (also rejects NaN); never raises."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def import_rmpm_bytes(data: bytes) -> dict:
    warnings: list[str] = []
    try:
        doc = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ValueError(f"JSON として読めません: {e}") from e

    floors = doc.get("floors") if isinstance(doc, dict) else None
    if not (isinstance(floors, list) and floors):
        # Also accept a bare floor object (no top-level "floors" wrapper).
        floors = [doc] if isinstance(doc, dict) and "objects" in doc else []
    if not floors:
        return _empty(["rmpm として認識できるフロアがありませんでした。"])
    if len(floors) > 1:
        warnings.append(f"{len(floors)} フロアのうち先頭フロアのみ取り込みました"
                        "（whsim は現状単一フロア）。")

    floor = floors[0] if isinstance(floors[0], dict) else {}
    objects = floor.get("objects")
    objects = objects if isinstance(objects, list) else []

    raw_shelves: list[tuple[float, float, float, float, str]] = []
    raw_walls: list[tuple[float, float, float, float]] = []
    raw_stations: list[tuple[float, float, float, float, str]] = []
    skipped: dict[str, int] = {}
    markers = 0
    for o in objects:
        if not isinstance(o, dict):
            continue
        t = str(o.get("type", ""))
        x, y, w, h = (_num(o.get("x")), _num(o.get("y")),
                      _num(o.get("w")), _num(o.get("h")))
        if None in (x, y, w, h):
            continue
        name = str(o.get("name") or "")
        if t in _SHELF_TYPES and w > 0 and h > 0:
            if name.strip().upper() in _MARKER_NAMES:
                markers += 1          # picking base marker, not a storage shelf
                continue
            raw_shelves.append((x, y, w, h, name))
        elif t in _WALL_TYPES and w > 0 and h > 0:
            raw_walls.append((x, y, w, h))
        elif t in _STATION_TYPES:
            raw_stations.append((x, y, w, h, name))
        else:
            skipped[t or "(unknown)"] = skipped.get(t or "(unknown)", 0) + 1

    if not (raw_shelves or raw_walls or raw_stations):
        return _empty(warnings + ["配置できるオブジェクトがありませんでした。"])

    # --- unit auto-detect (mm vs m) + origin translate (mirrors mapcsv) --------
    fb = floor.get("bounds") if isinstance(floor.get("bounds"), dict) else None
    xs = [r[0] for r in raw_shelves] + [r[0] for r in raw_stations] + [r[0] for r in raw_walls]
    ys = [r[1] for r in raw_shelves] + [r[1] for r in raw_stations] + [r[1] for r in raw_walls]
    rights = [r[0] + r[2] for r in raw_shelves] + [r[0] + r[2] for r in raw_stations] \
        + [r[0] + r[2] for r in raw_walls]
    bottoms = [r[1] + r[3] for r in raw_shelves] + [r[1] + r[3] for r in raw_stations] \
        + [r[1] + r[3] for r in raw_walls]
    if fb:
        for k, bucket in (("left", xs), ("top", ys), ("right", rights), ("bottom", bottoms)):
            v = _num(fb.get(k))
            if v is not None:
                bucket.append(v)
    minx, miny = (min(xs) if xs else 0.0), (min(ys) if ys else 0.0)
    maxx, maxy = (max(rights) if rights else minx), (max(bottoms) if bottoms else miny)
    span = max(maxx - minx, maxy - miny)
    scale, units = (0.001, "mm") if span > 2000 else (1.0, "m")

    def sx(v: float) -> float:
        return round((v - minx) * scale, 3)

    def sy(v: float) -> float:
        return round((v - miny) * scale, 3)

    def sl(v: float) -> float:  # scale a length (no translate)
        return round(v * scale, 3)

    shelves = []
    for i, (x, y, w, h, name) in enumerate(raw_shelves):
        ww, hh = sl(w), sl(h)
        # MapMaker stores no facing; default the 間口 toward the run's long side
        # (a tall shelf feeds a side aisle, a wide one feeds a front aisle). The
        # editor lets the user override per shelf.
        facing = "down" if ww >= hh else "left"
        shelves.append({"id": f"s{i}", "name": name, "x": sx(x), "y": sy(y),
                        "w": ww, "h": hh, "rack_type": "medium", "facing": facing})

    walls = []
    for i, (x, y, w, h) in enumerate(raw_walls):
        ww, hh = sl(w), sl(h)
        if ww >= hh:                       # horizontal wall rectangle → centre line
            cy = sy(y) + hh / 2
            pts = [[sx(x), round(cy, 3)], [round(sx(x) + ww, 3), round(cy, 3)]]
            thick = max(hh, 0.05)
        else:                              # vertical wall rectangle → centre line
            cx = sx(x) + ww / 2
            pts = [[round(cx, 3), sy(y)], [round(cx, 3), round(sy(y) + hh, 3)]]
            thick = max(ww, 0.05)
        walls.append({"id": f"w{i}", "points": pts, "thickness": round(thick, 3)})

    stations = []
    for i, (x, y, w, h, name) in enumerate(raw_stations):
        stations.append({"id": name or f"st{i}",
                         "x": round(sx(x) + sl(w) / 2, 3),
                         "y": round(sy(y) + sl(h) / 2, 3)})

    # Prefer the authored floor extent (matches MapMaker's view) when present,
    # else fall back to the bounding box of the placed objects.
    fbw = fbh = None
    if fb:
        ll, tt = _num(fb.get("left")), _num(fb.get("top"))
        rr, bb = _num(fb.get("right")), _num(fb.get("bottom"))
        if None not in (ll, tt, rr, bb) and rr > ll and bb > tt:
            fbw, fbh = (rr - ll) * scale, (bb - tt) * scale
    bounds = {"width": max(round(fbw if fbw else (maxx - minx) * scale, 3), 1.0),
              "depth": max(round(fbh if fbh else (maxy - miny) * scale, 3), 1.0)}

    zones = []
    if shelves:
        zones.append({"id": "storage", "type": "storage", "x": 0.0, "y": 0.0,
                      "w": bounds["width"], "h": bounds["depth"],
                      "rack": None, "shelves": shelves})

    if markers:
        warnings.append(f"START/END のピッキング基点マーカー {markers} 件は"
                        "保管棚ではないため除外しました。")
    for t, n in skipped.items():
        warnings.append(f"{t} を {n} 件は現状の単一フロアモデルでは見送りました。")
    warnings.append("rmpm は最善努力で解釈しています。寸法/位置は設計タブでご確認ください。")

    return {"bounds": bounds, "zones": zones, "walls": walls, "stations": stations,
            "warnings": warnings,
            "stats": {"shelves": len(shelves), "walls": len(walls),
                      "stations": len(stations), "scale": scale, "units": units}}


def _empty(warnings: list[str]) -> dict:
    return {"bounds": None, "zones": [], "walls": [], "stations": [],
            "warnings": warnings,
            "stats": {"shelves": 0, "walls": 0, "stations": 0,
                      "scale": 1.0, "units": "unknown"}}
