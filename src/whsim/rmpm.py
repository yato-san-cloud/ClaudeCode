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

**MapMaker カスタム版 (v4.4+)**: the custom build appends 什器マスタ・割当・資産情報
(and, from v4.9, コンベア) AFTER the serialized map so older MapMaker versions skip
it and still open the file. That is a normal file, not a damaged one — we measure
the trailer and say so rather than letting javaobj shout "Stream still has N bytes
left" (see ``_load_java``). The conveyor-footprint walls v4.10 auto-generates are
NOT identifiable here; see ``_CONVEYOR_FOOTPRINT_NOTE`` and
docs/mapmaker-v5-import.md §5.
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


def _load_java(data: bytes) -> tuple[object, int]:
    """Deserialize a MapMaker save. Returns ``(root, custom_trailer_bytes)``.

    v2 is the better-maintained parser and reads most saves, but it derails on
    some real customer files — it loses alignment inside a custom writeObject
    block and dies on a nonsense type code. v1 reads those. Neither is a superset
    of the other, so this tries v2 first and keeps v1 as the fallback rather than
    telling somebody their own layout file is corrupt when it is not.

    **The custom trailer (MapMaker カスタム版 v4.4+).** The custom build appends
    its own data — 什器マスタ・割当・グループ・資産情報、v4.9 以降はコンベアも —
    *after* the serialized ``WorldMapMultiFloor``, precisely so an older MapMaker
    "reads past it" and still opens the file. javaobj notices those leftover
    bytes and logs `Warning!!!!: Stream still has N bytes left`, which reads like
    corruption and is not: it is the file working as designed. So we suppress
    that log, MEASURE the trailer ourselves, and report it as what it is.
    """
    first: Exception | None = None
    try:
        import javaobj.v2 as _v2
    except ImportError as e:  # pragma: no cover — ships in pyproject deps
        raise ValueError(
            "ネイティブ .rmpm の読込には javaobj-py3 が必要です。"
            "`pip install javaobj-py3`（start.bat の再実行でも更新されます）するか、"
            "MapMaker の JSON エクスポート（.rmpm.json）をご利用ください。") from e
    try:
        # v2 reads the whole stream to EOF, so it either consumes the trailer as
        # further stream content or (usually) trips on it and we fall to v1.
        return _v2.loads(data), 0
    except Exception as e:  # noqa: BLE001 — fall through to the v1 parser
        first = e
    try:
        from io import BytesIO

        from javaobj.v1.transformers import DefaultObjectTransformer
        from javaobj.v1.unmarshaller import JavaObjectUnmarshaller
        fp = BytesIO(data)
        marshaller = JavaObjectUnmarshaller(fp)
        marshaller.add_transformer(DefaultObjectTransformer())
        # ignore_remaining_data=True is what silences javaobj's scary
        # "Stream still has N bytes left" error line; readObject leaves the
        # stream positioned right after the object, so the remainder is the
        # custom trailer and we can name it accurately.
        root = marshaller.readObject(ignore_remaining_data=True)
        return root, max(0, len(data) - fp.tell())
    except Exception:  # noqa: BLE001 — last resort: the plain v1 entry point
        try:
            import javaobj as _v1
            return _v1.loads(data, ignore_remaining_data=True), 0
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
    top, trailer = _load_java(data)

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
            # WallObject.height_mm — the ONLY field a wall carries beyond its
            # rectangle (see _conveyor_footprint_note). Kept so a caller can at
            # least see the belt height the custom build wrote under a conveyor.
            hm = _num(fo.get("height_mm"))
            if hm is not None:
                rec["height_mm"] = hm
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
    return {"source": "native-rmpm", "unit": "mm", "custom_trailer_bytes": trailer,
            "axes": "x-right, y-down, origin top-left", "floors": floors}


# --------------------------------------------------------------------------- #
# 調査結果: v4.10 の「コンベア足元に自動生成される壁」は rmpm から識別できない
# --------------------------------------------------------------------------- #
# MapMaker カスタム版 v4.10 はコンベアを描くと、その足元に実体の「壁」を自動生成
# して rmpm に保存する（経路計算がコンベアを迂回し、rmpm を直読するシミュレータ
# からも見えるようにするため）。説明書は「生成物は元アプリの壁クラスそのもの」と
# 明言している。デコンパイル済み `WallObject`（reference/mapmaker/decompiled/
# .../model/map/objects/WallObject.java）を確認した結果:
#
#   WallObject extends AbstractRectangleObject extends AbstractObject
#     WallObject          : height_mm (double) のみ
#     AbstractRectangle…  : tl, br (Coord)
#     AbstractObject      : id (Integer), editLock (boolean)
#
# 名前フィールドが無い（`toString()` が定数 "壁" を返すだけで、StairsObject の
# ような `name` も FreeShelfObject のような `shelf.name` も持たない）。つまり
# **フィールドからコンベア由来の壁を見分ける手段は存在しない**。
# 「元アプリの壁クラスそのもの」＝旧 MapMaker でもそのまま開ける、という設計上の
# 要請そのものが、印を付けられない理由になっている（印を付ければ旧版が読めない）。
#
# 唯一の手掛かりは `height_mm`（プロパティPで指定するベルト高）だが、これは人が
# 手で描いた壁にも入る値で、判別には使えない。残る可能性は v4.4+ の末尾埋め込み
# （コンベアの実体データはそこにある）を解くことだが、その形式は非公開でサンプルも
# 無い。
#
# → したがって **DXF の CONVEYOR レイヤ経路を正とする**（`whsim.cad`）。DXF では
#    コンベアは専用レイヤに出て、壁として二重計上されない（説明書 v4.10 の
#    「自社の集計・DXFでは『コンベア(壁)』『CONVEYORレイヤ』として扱い二重計上
#    しません」）。rmpm からの壁は素直に壁として取り込み、`height_mm` だけ
#    stats に残して人が判断できるようにする。
_CONVEYOR_FOOTPRINT_NOTE = (
    "v4.10 以降、コンベアの足元には壁が自動生成されますが、rmpm 上は通常の壁と"
    "区別が付きません（壁クラスに名前が無いため）。コンベアとして扱うには"
    "DXF の CONVEYOR レイヤを取り込んでください。")


def import_rmpm_bytes(data: bytes) -> dict:
    warnings: list[str] = []
    trailer = 0
    if data[:2] == _JAVA_MAGIC:
        # NATIVE save — parse the Java stream directly; no JSON export needed.
        doc = _native_to_doc(data)
        warnings.append("ネイティブ .rmpm（Java保存形式）を直接読み込みました。")
        trailer = int(doc.get("custom_trailer_bytes") or 0)
        if trailer:
            # NOT a corruption warning: v4.4+ appends 什器マスタ/割当/資産情報/
            # コンベア after the serialized map on purpose, so older MapMaker
            # versions skip it and still open the file.
            warnings.append(
                f"MapMaker カスタム版の拡張データ {trailer} bytes をスキップしました"
                "（v4.4+ が rmpm 末尾に埋め込む什器マスタ・割当・資産情報等。"
                "図面本体の読込には影響しません）。")
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
    raw_walls: list[tuple[float, float, float, float, float | None]] = []
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
            raw_walls.append((x, y, w, h, _num(o.get("height_mm"))))
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
    low_walls = 0
    for i, (x, y, w, h, hmm) in enumerate(raw_walls):
        ww, hh = sl(w), sl(h)
        if ww >= hh:                       # horizontal wall rectangle → centre line
            cy = sy(y) + hh / 2
            pts = [[sx(x), round(cy, 3)], [round(sx(x) + ww, 3), round(cy, 3)]]
            thick = max(hh, 0.05)
        else:                              # vertical wall rectangle → centre line
            cx = sx(x) + ww / 2
            pts = [[round(cx, 3), sy(y)], [round(cx, 3), round(sy(y) + hh, 3)]]
            thick = max(ww, 0.05)
        wall = {"id": f"w{i}", "points": pts, "thickness": round(thick, 3)}
        if hmm is not None:
            # WallObject.height_mm. Informational only — a knee-high wall is a
            # HINT that it might be a conveyor footprint (v4.10), never proof;
            # see _CONVEYOR_FOOTPRINT_NOTE for why no proof exists in rmpm.
            wall["height_m"] = round(hmm * scale, 3)
            if 0 < hmm <= 1200:
                low_walls += 1
        walls.append(wall)

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
    if low_walls:
        warnings.append(f"高さ 1.2m 以下の低い壁が {low_walls} 件あります。"
                        + _CONVEYOR_FOOTPRINT_NOTE)
    warnings.append("rmpm は最善努力で解釈しています。寸法/位置は設計タブでご確認ください。")

    return {"bounds": bounds, "zones": zones, "walls": walls, "stations": stations,
            "warnings": warnings,
            "stats": {"shelves": len(shelves), "walls": len(walls),
                      "stations": len(stations), "scale": scale, "units": units,
                      "custom_trailer_bytes": trailer, "low_walls": low_walls}}


def _empty(warnings: list[str]) -> dict:
    return {"bounds": None, "zones": [], "walls": [], "stations": [],
            "warnings": warnings,
            "stats": {"shelves": 0, "walls": 0, "stations": 0,
                      "scale": 1.0, "units": "unknown"}}
