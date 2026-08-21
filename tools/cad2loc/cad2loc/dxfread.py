"""DXF -> raw 2D geometry, in metres, origin at the drawing's lower-left corner.

Tolerant by design: a broken file goes through ezdxf.recover, unsupported entity
types are counted into the report instead of raising, and INSERTs are exploded so
racks drawn as blocks are still seen.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path
from typing import Any

import ezdxf
import ezdxf.recover
from ezdxf.document import Drawing

from .config import Config
from .errors import Cad2locError

Point = tuple[float, float]

# Entities we can turn into geometry. Anything else is counted and reported.
_POLYLINE_TYPES = {"LWPOLYLINE", "POLYLINE"}
_QUAD_TYPES = {"SOLID", "TRACE", "3DFACE"}
MAX_INSERT_DEPTH = 3


@dataclass
class RawGeometry:
    """Everything the reader understood, already scaled and translated."""

    rings: list[dict[str, Any]] = field(default_factory=list)  # closed loops
    segments: list[dict[str, Any]] = field(default_factory=list)  # loose lines
    scale: float = 1.0
    offset: Point = (0.0, 0.0)
    bounds_source: tuple[float, float, float, float] | None = None
    unclassified: list[dict[str, Any]] = field(default_factory=list)
    ambiguous: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    entity_count: int = 0
    recovered: bool = False
    recover_errors: list[str] = field(default_factory=list)

    def by_kind(self, kind: str, source: str) -> list[dict[str, Any]]:
        pool = self.rings if source == "ring" else self.segments
        return [item for item in pool if item["kind"] == kind]


def _looks_like_dwg(path: Path) -> bool:
    """DWG saved (or renamed) as .dxf — the single most common bad input."""
    try:
        head = path.open("rb").read(6)
    except OSError:
        return False
    return len(head) == 6 and head[:2] == b"AC" and head[2:].isdigit()


def load_document(path: str | Path) -> tuple[Drawing, bool, list[str]]:
    """Open a DXF, falling back to ezdxf.recover for malformed files."""
    p = Path(path)
    if not p.exists():
        raise Cad2locError(f"入力ファイルが見つかりません: {p}")
    if p.stat().st_size == 0:
        raise Cad2locError(f"入力ファイルが空です: {p}")
    if _looks_like_dwg(p):
        raise Cad2locError(
            f"DWG形式のファイルです（拡張子が .dxf でも中身は DWG）: {p.name}",
            "ODA File Converter 等で DXF に変換してから渡してください（DWGは直接扱いません）",
        )
    # Any parse failure is worth one recover attempt: truncated files, bad tags
    # and version-table damage all land here, and recover fixes most of them.
    try:
        return ezdxf.readfile(str(p)), False, []
    except Exception as first_error:  # noqa: BLE001 - tolerant by design
        first_reason = f"{type(first_error).__name__}: {first_error}"
    try:
        doc, auditor = ezdxf.recover.readfile(str(p))
    except Exception as exc:
        raise Cad2locError(
            f"DXFとして解釈できません: {p.name}（{first_reason}）",
            "DXF R12 以降のテキスト/バイナリDXFであることを確認してください",
        ) from exc
    errors = [f"{e.code}: {e.message}" for e in getattr(auditor, "errors", [])][:50]
    return doc, True, [first_reason, *errors]


def _iter_entities(container: Iterable[Any], depth: int = 0) -> Iterable[Any]:
    """Yield entities, exploding INSERTs (racks are often blocks)."""
    for entity in container:
        if entity.dxftype() == "INSERT" and depth < MAX_INSERT_DEPTH:
            try:
                yield from _iter_entities(entity.virtual_entities(), depth + 1)
            except Exception:  # noqa: BLE001 - a block we cannot explode is not fatal
                yield entity
            continue
        yield entity


def _polyline_points(entity: Any) -> tuple[list[Point], bool] | None:
    dxftype = entity.dxftype()
    try:
        if dxftype == "LWPOLYLINE":
            pts = [(float(p[0]), float(p[1])) for p in entity.get_points("xy")]
            return pts, bool(entity.closed)
        if dxftype == "POLYLINE":
            if not entity.is_2d_polyline and not entity.is_3d_polyline:
                return None
            pts = [(float(v.dxf.location.x), float(v.dxf.location.y)) for v in entity.vertices]
            return pts, bool(entity.is_closed)
    except Exception:  # noqa: BLE001 - a malformed polyline is reported, not fatal
        return None
    return None


def _quad_points(entity: Any) -> list[Point] | None:
    try:
        vtx = [entity.dxf.vtx0, entity.dxf.vtx1, entity.dxf.vtx2, entity.dxf.vtx3]
    except Exception:  # noqa: BLE001 - incomplete SOLID/3DFACE is reported, not fatal
        return None
    pts = [(float(v.x), float(v.y)) for v in vtx]
    if entity.dxftype() in {"SOLID", "TRACE"}:
        # SOLID/TRACE store the last two corners swapped (bow-tie order).
        pts = [pts[0], pts[1], pts[3], pts[2]]
    uniq: list[Point] = []
    for pt in pts:
        if not uniq or abs(pt[0] - uniq[-1][0]) > 1e-9 or abs(pt[1] - uniq[-1][1]) > 1e-9:
            uniq.append(pt)
    return uniq if len(uniq) >= 3 else None


def _bounds(items: Iterable[list[Point]]) -> tuple[float, float, float, float] | None:
    xs: list[float] = []
    ys: list[float] = []
    for pts in items:
        for x, y in pts:
            xs.append(x)
            ys.append(y)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def read_geometry(path: str | Path, cfg: Config) -> RawGeometry:
    """Read a DXF into metre-space rings and segments, classified by layer."""
    doc, recovered, recover_errors = load_document(path)
    msp = doc.modelspace()
    raw = RawGeometry(recovered=recovered, recover_errors=recover_errors)

    entities = list(_iter_entities(msp))
    raw.entity_count = len(entities)
    if not entities:
        raise Cad2locError(
            f"図面にエンティティがありません（空の図面）: {Path(path).name}",
            "モデル空間に図形があるDXFを渡してください",
        )

    unhandled: Counter[tuple[str, str]] = Counter()
    rings: list[dict[str, Any]] = []
    segments: list[dict[str, Any]] = []
    close_tol_drawing_units: list[dict[str, Any]] = []

    for entity in entities:
        layer = str(getattr(entity.dxf, "layer", "0"))
        kind = cfg.classify_layer(layer)
        dxftype = entity.dxftype()
        if kind == "ignore":
            continue

        poly = _polyline_points(entity)
        if poly is not None:
            pts, closed = poly
            if len(pts) >= 3:
                record = {
                    "kind": kind,
                    "layer": layer,
                    "type": dxftype,
                    "points": pts,
                    "closed": closed,
                }
                rings.append(record)
                if not closed:
                    close_tol_drawing_units.append(record)
                continue
            if len(pts) == 2:
                segments.append(
                    {"kind": kind, "layer": layer, "type": dxftype, "points": pts}
                )
                continue
            unhandled[(layer, dxftype)] += 1
            continue

        if dxftype == "LINE":
            try:
                start = entity.dxf.start
                end = entity.dxf.end
            except Exception:  # noqa: BLE001 - unreadable LINE goes to the report
                unhandled[(layer, dxftype)] += 1
                continue
            segments.append(
                {
                    "kind": kind,
                    "layer": layer,
                    "type": dxftype,
                    "points": [(float(start.x), float(start.y)), (float(end.x), float(end.y))],
                }
            )
            continue

        if dxftype in _QUAD_TYPES:
            pts = _quad_points(entity)
            if pts:
                rings.append(
                    {"kind": kind, "layer": layer, "type": dxftype, "points": pts, "closed": True}
                )
                continue

        unhandled[(layer, dxftype)] += 1

    # ---- units & origin -------------------------------------------------
    source_bounds = _bounds(
        [r["points"] for r in rings] + [s["points"] for s in segments]
    )
    scale = _resolve_scale(cfg, source_bounds, raw)
    offset = (0.0, 0.0)
    if source_bounds and cfg.get("origin", "mode", default="bbox_min") == "bbox_min":
        offset = (-source_bounds[0] * scale, -source_bounds[1] * scale)

    def transform(pts: list[Point]) -> list[Point]:
        return [(x * scale + offset[0], y * scale + offset[1]) for x, y in pts]

    for record in rings:
        record["points"] = transform(record["points"])
    for record in segments:
        record["points"] = transform(record["points"])

    # ---- unclosed polylines: close within tolerance, else demote to segments
    tol = float(cfg.get("rack_detect", "close_tolerance_m", default=0.05))
    demoted: list[dict[str, Any]] = []
    for record in close_tol_drawing_units:
        pts = record["points"]
        gap = ((pts[0][0] - pts[-1][0]) ** 2 + (pts[0][1] - pts[-1][1]) ** 2) ** 0.5
        if gap <= tol:
            record["closed"] = True
            reason = f"未クローズのポリラインを閉図形として採用 (端点間 {gap:.3f} m)"
        else:
            demoted.append(record)
            reason = f"未クローズのポリライン → 線分列として扱う (端点間 {gap:.3f} m)"
        raw.ambiguous.append(
            {"layer": record["layer"], "dxftype": record["type"], "reason": reason}
        )
    if demoted:
        demoted_ids = {id(r) for r in demoted}
        rings = [r for r in rings if id(r) not in demoted_ids]
        for record in demoted:
            pts = record["points"]
            for a, b in pairwise(pts):
                segments.append(
                    {
                        "kind": record["kind"],
                        "layer": record["layer"],
                        "type": record["type"],
                        "points": [a, b],
                    }
                )

    raw.rings = rings
    raw.segments = segments
    raw.scale = scale
    raw.offset = offset
    raw.bounds_source = source_bounds
    raw.unclassified = [
        {"layer": layer, "dxftype": dxftype, "count": count, "reason": "未対応/未分類の図形"}
        for (layer, dxftype), count in sorted(unhandled.items(), key=lambda kv: -kv[1])
    ]
    return raw


def _resolve_scale(
    cfg: Config, bounds: tuple[float, float, float, float] | None, raw: RawGeometry
) -> float:
    setting = cfg.get("units", "scale_to_m", default="auto")
    if isinstance(setting, (int, float)):
        if float(setting) <= 0:
            raise Cad2locError("units.scale_to_m は正の数である必要があります")
        return float(setting)
    if not isinstance(setting, str) or setting.lower() != "auto":
        raise Cad2locError(f"units.scale_to_m が不正です: {setting!r}", '数値または "auto"')
    if bounds is None:
        return 1.0
    span = max(bounds[2] - bounds[0], bounds[3] - bounds[1])
    threshold = float(cfg.get("units", "auto_mm_threshold", default=2000.0))
    scale = 0.001 if span > threshold else 1.0
    raw.warnings.append(
        f"単位自動判定: 図面の最大辺 {span:.1f} → 係数 {scale} を採用"
        "（mapping.yaml の units.scale_to_m で固定できます）"
    )
    return scale
