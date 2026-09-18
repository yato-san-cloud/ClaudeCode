"""DXF floor-plan importer (CAD → whsim canonical layout).

A non-technical salesperson should be able to drop in whatever DXF drawing they
received from a customer and get a usable layout out the other end, never
blocking on bad data. To that end this module is deliberately *tolerant*:

- per-entity parsing is wrapped in try/except — a malformed entity is skipped
  with a human-readable (Japanese) warning, never fatal;
- units are auto-detected from the DXF $INSUNITS header, and guessed from the
  drawing extent when the header is missing/unitless;
- only the file-not-found / file-unopenable case is allowed to raise.

Layers carry meaning when the drawing came out of MapMaker's CAD(DXF) export
(棚=SHELF / 壁=WALL / コンベア=CONVEYOR, the last added by the custom build v4.9):
SHELF becomes authored shelves, CONVEYOR becomes conveyors, everything else stays
a wall so an arbitrary customer drawing still works. See `_CONVEYOR_LAYERS` for
why a belt must not also be emitted as a wall, and docs/mapmaker-v5-import.md §3.

The output is a plain dict shaped to feed directly into whsim's `Layout`:
`{bounds, walls, zones, conveyors, warnings, stats}` (see `whsim.schema.model`).
All distances are emitted in METERS, with the drawing's min corner translated
to the origin (0, 0).
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

import ezdxf

# Cap on the number of wall segments we emit, to keep a pathological/huge DXF
# from producing a runaway model. Truncation is noted in `warnings`.
MAX_WALLS = 5000

# DXF $INSUNITS code -> (unit label, metres-per-unit scale factor).
# Reference: ezdxf / AutoCAD INSUNITS enumeration.
_INSUNITS: dict[int, tuple[str, float]] = {
    0: ("unitless", 1.0),   # handled specially (guess by extent)
    1: ("inch", 0.0254),
    2: ("ft", 0.3048),
    4: ("mm", 0.001),
    5: ("cm", 0.01),
    6: ("m", 1.0),
}

# Layer-name keyword -> whsim ZoneType. Matched case-insensitively as a
# substring, so "RECEIVING-AREA" or "保管エリア" both hit. Best-effort only.
# --- Layer roles (MapMaker CAD(DXF)エクスポート の仕分けに合わせる) ------------
# MapMaker writes 棚 → "SHELF", 壁 → "WALL", and (custom build v4.9+) コンベア →
# "CONVEYOR". Anything else keeps the historical behaviour of becoming a wall
# polyline, which is what makes an arbitrary customer drawing still usable.
#
# CONVEYOR is deliberately NOT also a wall. The custom build auto-generates a
# real 壁 object under every belt so MapMaker's own routing walks around it
# (v4.10), and it says so explicitly: 「自社の集計・DXFでは『コンベア(壁)』
# 『CONVEYORレイヤ』として扱い二重計上しません」. Emitting the belt as both a
# conveyor and a wall here would put two obstacles on one footprint.
_CONVEYOR_LAYERS = ("conveyor", "コンベア", "コンベヤ")
_SHELF_LAYERS = ("shelf", "棚")

_ZONE_KEYWORDS: list[tuple[str, str]] = [
    ("receiving", "receiving"),
    ("入荷", "receiving"),
    ("shipping", "shipping"),
    ("出荷", "shipping"),
    ("packing", "packing"),
    ("梱包", "packing"),
    ("picking", "picking"),
    ("storage", "storage"),
    ("rack", "storage"),
    ("保管", "storage"),
]


def _detect_scale(doc: ezdxf.document.Drawing, warnings: list[str]) -> tuple[float, str]:
    """Return (metres-per-unit, unit-label) using $INSUNITS, falling back to a
    guess. The extent-based mm guess is applied later by the caller, since it
    needs the parsed geometry; here we only resolve the header."""
    try:
        insunits = int(doc.header.get("$INSUNITS", 0))
    except Exception:
        insunits = 0
    label, scale = _INSUNITS.get(insunits, ("unitless", 1.0))
    return scale, label


def _points_from_entity(entity: Any) -> list[list[float]]:
    """Extract a polyline (list of [x, y]) from a supported entity, in raw
    drawing units. Raises if the entity type is not one we handle so the caller
    can record an "unsupported entity" warning."""
    dxftype = entity.dxftype()

    if dxftype == "LINE":
        s = entity.dxf.start
        e = entity.dxf.end
        return [[float(s.x), float(s.y)], [float(e.x), float(e.y)]]

    if dxftype == "LWPOLYLINE":
        # LWPOLYLINE stores 2D points directly; get_points returns
        # (x, y, start_width, end_width, bulge) tuples.
        pts = [[float(p[0]), float(p[1])] for p in entity.get_points()]
        if getattr(entity, "closed", False) and entity.closed and len(pts) >= 2:
            pts = pts + [pts[0]]  # close the ring for a clean wall outline
        return pts

    if dxftype == "POLYLINE":
        # Old-style POLYLINE: iterate vertices (3D points; take x, y).
        pts = [
            [float(v.dxf.location.x), float(v.dxf.location.y)]
            for v in entity.vertices
        ]
        if entity.is_closed and len(pts) >= 2:
            pts = pts + [pts[0]]
        return pts

    raise TypeError(dxftype)


def _layer_role(layer: str) -> str:
    """"conveyor" / "shelf" / "wall" for a DXF layer name (substring, folded)."""
    low = str(layer or "").lower()
    if any(k in low if k.isascii() else k in layer for k in _CONVEYOR_LAYERS):
        return "conveyor"
    if any(k in low if k.isascii() else k in layer for k in _SHELF_LAYERS):
        return "shelf"
    return "wall"


def _zone_type_for_layer(layer: str) -> str | None:
    """Map a layer name to a whsim ZoneType by keyword, or None if no hint."""
    low = layer.lower()
    for keyword, ztype in _ZONE_KEYWORDS:
        # ASCII keywords matched lowercased; Japanese ones matched as-is.
        if keyword.isascii():
            if keyword in low:
                return ztype
        elif keyword in layer:
            return ztype
    return None


def _bbox(points: list[list[float]]) -> tuple[float, float, float, float]:
    """Axis-aligned bounding box (minx, miny, maxx, maxy) of a point list."""
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def import_dxf(path: str | Path, target_units: str = "m") -> dict:
    """Parse a DXF into a layout dict: {bounds, walls, zones, warnings, stats}.

    All coordinates in the result are in metres, with the drawing's minimum
    corner translated to the origin. `target_units` is accepted for forward
    compatibility; only metres are currently emitted.
    """
    path = Path(path)
    warnings: list[str] = []

    # The only hard failure we allow: the file cannot be opened at all. A
    # genuinely missing path raises FileNotFoundError (acceptable per spec);
    # any other read/parse error is reported as a warning in an empty layout.
    if not path.exists():
        raise FileNotFoundError(str(path))

    def _empty_result(msg: str) -> dict:
        return {
            "bounds": {"width": 0.0, "depth": 0.0},
            "walls": [],
            "zones": [],
            "conveyors": [],
            "warnings": [msg],
            "stats": {"entities": 0, "walls": 0, "conveyors": 0, "shelves": 0,
                      "scale": 1.0, "units": "unknown"},
        }

    # A ".dxf" that is actually a DWG (binary AutoCAD save) is a common
    # real-world mix-up — detect the AC10xx magic and say exactly what to do.
    try:
        with path.open("rb") as fh:
            head = fh.read(6)
    except OSError:
        head = b""
    if head[:4] == b"AC10":      # DWG version magic: AC1009..AC1032
        return _empty_result(
            "このファイルは DWG（AutoCADバイナリ形式）のようです。CADで"
            "「DXF形式（R2010以降推奨）」に書き出してから取り込んでください。")

    try:
        doc = ezdxf.readfile(str(path))
    except Exception:  # noqa: BLE001 — try the salvage path before giving up
        # ezdxf.recover tolerates malformed/legacy files the strict reader
        # rejects (real customer DXFs are rarely pristine).
        try:
            from ezdxf import recover
            doc, auditor = recover.readfile(str(path))
            if auditor.has_errors:
                warnings.append(
                    f"DXF に {len(auditor.errors)} 件の構造エラーがあり、修復して"
                    "読み込みました。寸法を設計タブでご確認ください。")
        except Exception as exc2:  # noqa: BLE001 - tolerant: never crash the caller
            return _empty_result(f"DXF を読み込めませんでした: {exc2}")

    scale, units = _detect_scale(doc, warnings)
    msp = doc.modelspace()

    # First pass (raw drawing units): collect candidate wall polylines and any
    # closed polylines tagged with a recognised zone layer.
    raw_walls: list[list[list[float]]] = []
    raw_zones: list[tuple[str, list[list[float]]]] = []  # (zone_type, points)
    raw_conveyors: list[list[list[float]]] = []          # CONVEYOR layer polylines
    raw_shelves: list[list[list[float]]] = []            # SHELF layer rectangles
    entity_count = 0
    truncated = False

    for entity in msp:
        entity_count += 1
        try:
            dxftype = entity.dxftype()
            try:
                points = _points_from_entity(entity)
            except TypeError:
                warnings.append(f"対応外のエンティティ {dxftype} をスキップしました")
                continue

            if len(points) < 2:
                continue

            layer = str(getattr(entity.dxf, "layer", "") or "")
            role = _layer_role(layer)
            if role == "conveyor":
                # The belt centre-line, verbatim. It is NOT also a wall (see
                # _CONVEYOR_LAYERS): the auto-generated 壁 under the belt and the
                # CONVEYOR polyline are the same physical object.
                raw_conveyors.append(points)
                continue
            if role == "shelf":
                raw_shelves.append(points)
                continue

            if len(raw_walls) >= MAX_WALLS:
                truncated = True
                continue
            raw_walls.append(points)

            # Best-effort zone detection: a closed polyline on a known layer.
            ztype = _zone_type_for_layer(layer)
            is_closed = (
                dxftype in ("LWPOLYLINE", "POLYLINE")
                and len(points) >= 4
                and points[0] == points[-1]
            )
            if ztype and is_closed:
                raw_zones.append((ztype, points))
        except Exception as exc:  # noqa: BLE001 - never raise on a bad entity
            warnings.append(f"エンティティの解析に失敗したためスキップしました: {exc}")
            continue

    if truncated:
        warnings.append(
            f"ウォール数が上限 {MAX_WALLS} を超えたため、以降のセグメントを切り捨てました"
        )

    # Resolve a unitless drawing by guessing from the overall extent: a plan
    # whose largest dimension exceeds 2000 is almost certainly in millimetres.
    all_points = [p for poly in raw_walls + raw_conveyors + raw_shelves for p in poly]
    if units == "unitless":
        if all_points:
            minx, miny, maxx, maxy = _bbox(all_points)
            extent = max(maxx - minx, maxy - miny)
            if extent > 2000:
                scale, units = 0.001, "mm"
                warnings.append("単位不明のため mm と仮定しました")
            else:
                scale, units = 1.0, "m"
                warnings.append("単位不明のため m と仮定しました")
        else:
            scale, units = 1.0, "m"

    # Compute extents in raw units, then translate min corner to origin and
    # apply the metres-per-unit scale.
    if all_points:
        minx, miny, _, _ = _bbox(all_points)
    else:
        minx = miny = 0.0
        warnings.append("有効なジオメトリが見つかりませんでした")

    def to_m(pt: list[float]) -> list[float]:
        return [round((pt[0] - minx) * scale, 4), round((pt[1] - miny) * scale, 4)]

    walls: list[dict] = []
    for i, poly in enumerate(raw_walls):
        walls.append(
            {
                "id": f"w{i}",
                "points": [to_m(p) for p in poly],
                "thickness": 0.2,
            }
        )

    # CONVEYOR レイヤ → model.resources.conveyors。mm→m は壁と同じ換算・同じ原点。
    # 速度は DXF に載らないので whsim の既定 (0.5 m/s) を置き、設計タブで直せる。
    conveyors: list[dict] = []
    for i, poly in enumerate(raw_conveyors):
        pts = [to_m(p) for p in poly]
        # drop consecutive duplicates (a closed belt outline can repeat its first
        # point); a degenerate 1-point belt is not a belt.
        dedup = [p for j, p in enumerate(pts) if j == 0 or p != pts[j - 1]]
        if len(dedup) < 2:
            continue
        conveyors.append({"id": f"cv{i}", "points": dedup, "speed_mps": 0.5})

    zones: list[dict] = []
    for i, (ztype, poly) in enumerate(raw_zones):
        bx0, by0, bx1, by1 = _bbox(poly)
        x0, y0 = to_m([bx0, by0])
        x1, y1 = to_m([bx1, by1])
        zones.append(
            {
                "id": f"{ztype}{i}",
                "type": ztype,
                "x": round(min(x0, x1), 4),
                "y": round(min(y0, y1), 4),
                "w": round(abs(x1 - x0), 4),
                "h": round(abs(y1 - y0), 4),
                "color": None,
                "rack": None,
            }
        )

    # Bounds from the full extent of all geometry, in metres.
    if all_points:
        bminx, bminy, bmaxx, bmaxy = _bbox(all_points)
        width = round((bmaxx - bminx) * scale, 4)
        depth = round((bmaxy - bminy) * scale, 4)
    else:
        width = depth = 0.0

    # SHELF レイヤ → 保管ゾーンの authored shelves（壁ではなく棚として扱う）。
    # 棚は経路の障害物として zone.shelves から直読されるので、壁に混ぜると
    # 同じ矩形が二重に障害物化する。DXF には棚名が TEXT で別に入るだけなので、
    # 名前は付かない（棚名が要るときは rmpm / ロケマスタ経路が正）。
    if raw_shelves:
        shelves = []
        for i, poly in enumerate(raw_shelves):
            bx0, by0, bx1, by1 = _bbox(poly)
            x0, y0 = to_m([bx0, by0])
            x1, y1 = to_m([bx1, by1])
            w = round(abs(x1 - x0), 4)
            h = round(abs(y1 - y0), 4)
            if w <= 0 or h <= 0:
                continue
            shelves.append({"id": f"s{i}", "name": "",
                            "x": round(min(x0, x1), 4), "y": round(min(y0, y1), 4),
                            "w": w, "h": h, "rack_type": "medium",
                            "facing": "down" if w >= h else "left"})
        if shelves:
            zones.append({"id": "storage", "type": "storage", "x": 0.0, "y": 0.0,
                          "w": max(width, 1.0), "h": max(depth, 1.0),
                          "color": None, "rack": None, "shelves": shelves})

    if conveyors:
        warnings.append(f"CONVEYOR レイヤから {len(conveyors)} 本のコンベアを"
                        "取り込みました（壁には計上していません＝二重計上なし）。"
                        "速度は既定 0.5 m/s です。")
    if raw_shelves:
        warnings.append(f"SHELF レイヤの {len(raw_shelves)} 図形を棚として"
                        "取り込みました（壁ではありません）。棚名は DXF に"
                        "座標付きで載らないため空です。")

    return {
        "bounds": {"width": width, "depth": depth},
        "walls": walls,
        "zones": zones,
        "conveyors": conveyors,
        "warnings": warnings,
        "stats": {
            "entities": entity_count,
            "walls": len(walls),
            "conveyors": len(conveyors),
            "shelves": sum(len(z.get("shelves", [])) for z in zones),
            "scale": scale,
            "units": units,
        },
    }


def import_dxf_bytes(data: bytes) -> dict:
    """Import a DXF supplied as raw bytes (e.g. an uploaded file) by writing it
    to a temporary file and delegating to `import_dxf`."""
    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name
        return import_dxf(tmp_path)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    # Self-test: build a tiny DXF (units = mm) with a 50000mm x 30000mm outer
    # rectangle plus a couple of interior lines, import it, and print results.
    import json

    with tempfile.TemporaryDirectory() as d:
        dxf_path = Path(d) / "sample.dxf"

        doc = ezdxf.new("R2010")
        doc.header["$INSUNITS"] = 4  # millimetres
        msp = doc.modelspace()

        # Outer wall: 50000mm x 30000mm closed rectangle -> 50m x 30m.
        msp.add_lwpolyline(
            [(0, 0), (50000, 0), (50000, 30000), (0, 30000)],
            close=True,
            dxfattribs={"layer": "WALLS"},
        )
        # A closed picking-zone polyline on a recognised layer.
        msp.add_lwpolyline(
            [(5000, 5000), (15000, 5000), (15000, 12000), (5000, 12000)],
            close=True,
            dxfattribs={"layer": "PICKING"},
        )
        # A couple of interior partition lines.
        msp.add_line((0, 15000), (50000, 15000), dxfattribs={"layer": "WALLS"})
        msp.add_line((25000, 0), (25000, 30000), dxfattribs={"layer": "WALLS"})

        doc.saveas(dxf_path)

        result = import_dxf(dxf_path)

        print("bounds:", result["bounds"])
        print("wall count:", len(result["walls"]))
        print("zones:", result["zones"])
        print("stats:", result["stats"])
        print("warnings:", result["warnings"])
        print("\nfirst wall points (m):", json.dumps(result["walls"][0]["points"]))
