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


# Java Object Serialization Stream magic (0xACED). A file starting with these
# bytes is MapMaker's NATIVE save (a serialized WorldMapMultiFloor), not the
# JSON export — real users drag the native file, so we parse it directly.
_JAVA_MAGIC = b"\xac\xed"


# javaobj ships two parsers with DIFFERENT object models, and real MapMaker saves
# need both (see _load_java). v2 hands back a JavaInstance carrying `field_data`
# keyed by class; v1 hands back a JavaObject with the fields as plain attributes.
_V1_SKIP = {"classdesc", "annotations", "get_class"}


def _jfields(inst) -> dict:
    """{field name: value} for a javaobj instance, merged across the class
    hierarchy, for EITHER parser's object model. Tolerant: anything we cannot
    read yields {}."""
    out: dict = {}
    for _cls, fmap in (getattr(inst, "field_data", None) or {}).items():
        for jf, val in fmap.items():
            out[getattr(jf, "name", str(jf))] = val
    if out:
        return out
    # v1: fields land straight on the instance dict.
    for k, v in (getattr(inst, "__dict__", None) or {}).items():
        if not k.startswith("_") and k not in _V1_SKIP:
            out[k] = v
    return out


def _load_java(data: bytes):
    """Deserialize a MapMaker save, trying BOTH javaobj parsers.

    v2 is the better-maintained parser and reads most saves, but it derails on
    some real customer files — it loses alignment inside a custom writeObject
    block and dies on a nonsense type code. v1 reads those. Neither is a superset
    of the other, so this tries v2 first and keeps v1 as the fallback rather than
    telling somebody their own layout file is corrupt when it is not."""
    first: Exception | None = None
    try:
        import javaobj.v2 as _v2
        return _v2.loads(data)
    except ImportError as e:  # pragma: no cover — ships in pyproject deps
        raise ValueError(
            "ネイティブ .rmpm の読込には javaobj-py3 が必要です。"
            "`pip install javaobj-py3`（start.bat の再実行でも更新されます）するか、"
            "MapMaker の JSON エクスポート（.rmpm.json）をご利用ください。") from e
    except Exception as e:  # noqa: BLE001 — fall through to the v1 parser
        first = e
    try:
        import javaobj as _v1
        return _v1.loads(data)
    except Exception as e:  # noqa: BLE001 — corrupt stream → friendly error
        raise ValueError(
            f".rmpm（Java直列化）として解釈できませんでした: {first}") from e


def _native_to_doc(data: bytes) -> dict:
    """Parse a NATIVE .rmpm (Java-serialized WorldMapMultiFloor) into the same
    floors-dict shape as the JSON export, so ONE mapping path serves both.

    Mirrors reference/mapmaker's RmpmExport.java: per object the bounds come
    from the ``tl``/``br`` Coord fields, the type from the class simple name,
    and a FreeShelfObject's rack address from ``shelf.name``. Unrecognised
    objects are kept typed so the downstream mapper counts/skips them
    ("never blocks")."""
    top = _load_java(data)

    exts = _jfields(top).get("WorldMapExtensionList")
    floors: list[dict] = []
    for ext in list(exts) if exts is not None else []:
        fe = _jfields(ext)
        wm = fe.get("worldMap")
        if wm is None:
            continue
        fw = _jfields(wm)
        tl, br = _jfields(fw.get("tl")), _jfields(fw.get("br"))
        objects: list[dict] = []
        for o in list(fw.get("objects") or []):
            cls = getattr(getattr(o, "classdesc", None), "name", "") or ""
            fo = _jfields(o)
            otl, obr = _jfields(fo.get("tl")), _jfields(fo.get("br"))
            if "x" not in otl or "x" not in obr:
                continue
            rec: dict = {
                "type": cls.rsplit(".", 1)[-1],
                "id": fo.get("id"),
                "x": otl.get("x"), "y": otl.get("y"),
                "w": (obr.get("x") or 0) - (otl.get("x") or 0),
                "h": (obr.get("y") or 0) - (otl.get("y") or 0),
            }
            # FreeShelfObject carries its rack address on shelf.name; other
            # named objects (e.g. StairsObject) keep a plain `name` field.
            shelf = fo.get("shelf")
            name = (_jfields(shelf).get("name") if shelf is not None
                    else fo.get("name"))
            if name is not None:
                rec["name"] = str(name)
            objects.append(rec)
        floors.append({
            "name": str(fe.get("name") or f"Floor{len(floors) + 1}"),
            "bounds": {"left": tl.get("x", 0.0), "top": tl.get("y", 0.0),
                       "right": br.get("x", 0.0), "bottom": br.get("y", 0.0)},
            "view": {"centerX": fe.get("centerX"), "centerY": fe.get("centerY"),
                     "zoom": fe.get("zoomLevel")},
            "objects": objects,
        })
    if not floors:
        raise ValueError(".rmpm にフロアが見つかりませんでした（WorldMapExtensionList が空）。")
    return {"source": "native-rmpm", "unit": "mm",
            "axes": "x-right, y-down, origin top-left", "floors": floors}


def import_rmpm_bytes(data: bytes) -> dict:
    warnings: list[str] = []
    if data[:2] == _JAVA_MAGIC:
        # NATIVE save — parse the Java stream directly; no JSON export needed.
        doc = _native_to_doc(data)
        warnings.append("ネイティブ .rmpm（Java保存形式）を直接読み込みました。")
    else:
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
