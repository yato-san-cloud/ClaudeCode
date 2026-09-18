"""Rack extraction — two paths, because drawings come in two flavours.

Path 1 (cheap, exact): a closed polyline / solid on a rack layer *is* the rack
footprint. Rotated racks come out rotated, since the ring is used verbatim.

Path 2 (clustering): plenty of drawings have no closed shapes at all — a rack row
is a heap of loose LINEs. Those are densified into points, clustered with DBSCAN
(a rack row is dense, the aisle between rows is empty), and each cluster is
reduced to its minimum rotated rectangle. Rotation-free, so diagonal rows survive.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from shapely.geometry import LineString, MultiPoint, Polygon
from shapely.ops import unary_union

from .config import Config
from .dxfread import RawGeometry


@dataclass
class Rack:
    id: str
    polygon: Polygon
    label: str
    source: str  # "polyline" | "cluster"


def clean_polygon(points: list[tuple[float, float]]) -> Polygon | None:
    if len(points) < 3:
        return None
    poly = Polygon(points)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty:
        return None
    if poly.geom_type == "MultiPolygon":
        poly = max(poly.geoms, key=lambda g: g.area)
    if poly.geom_type != "Polygon" or poly.area <= 0:
        return None
    return poly


def _short_side(poly: Polygon) -> float:
    mrr = poly.minimum_rotated_rectangle
    if mrr.geom_type != "Polygon":
        return 0.0
    coords = list(mrr.exterior.coords)[:4]
    if len(coords) < 3:
        return 0.0
    a = LineString([coords[0], coords[1]]).length
    b = LineString([coords[1], coords[2]]).length
    return min(a, b)


def extract_racks(raw: RawGeometry, cfg: Config) -> tuple[list[Rack], list[dict[str, Any]]]:
    """Return rack footprints plus report notes for everything rejected."""
    notes: list[dict[str, Any]] = []
    min_area = float(cfg.get("rack_detect", "min_area_m2", default=0.3))
    max_area = float(cfg.get("rack_detect", "max_area_m2", default=2000.0))

    polygons: list[tuple[Polygon, str, str]] = []  # (poly, label, source)
    for ring in raw.by_kind("rack", "ring"):
        poly = clean_polygon(ring["points"])
        if poly is None:
            notes.append(
                {"layer": ring["layer"], "dxftype": ring["type"], "reason": "不正な閉図形（面積0）"}
            )
            continue
        if not (min_area <= poly.area <= max_area):
            notes.append(
                {
                    "layer": ring["layer"],
                    "dxftype": ring["type"],
                    "reason": f"面積 {poly.area:.2f} m² が rack_detect の範囲外",
                }
            )
            continue
        polygons.append((poly, ring["layer"], "polyline"))

    cluster_cfg = cfg.get("rack_detect", "cluster", default={}) or {}
    if cluster_cfg.get("enabled", True):
        found = raw.by_kind("rack", "segment")
        if found:
            existing = unary_union([p for p, _, _ in polygons]) if polygons else None
            clustered, cluster_notes = _cluster_segments(found, cfg, existing)
            polygons.extend(clustered)
            notes.extend(cluster_notes)

    racks = [
        Rack(id=f"r{index + 1:04d}", polygon=poly, label=label, source=source)
        for index, (poly, label, source) in enumerate(polygons)
    ]
    return racks, notes


def _cluster_segments(
    segments: list[dict[str, Any]],
    cfg: Config,
    existing: Any,
) -> tuple[list[tuple[Polygon, str, str]], list[dict[str, Any]]]:
    from sklearn.cluster import DBSCAN  # imported lazily: sklearn is slow to load

    notes: list[dict[str, Any]] = []
    cluster_cfg = cfg.get("rack_detect", "cluster", default={}) or {}
    eps = float(cluster_cfg.get("eps_m", 0.7))
    min_samples = int(cluster_cfg.get("min_samples", 4))
    step = max(float(cluster_cfg.get("sample_step_m", 0.25)), 1e-3)
    min_width = float(cluster_cfg.get("min_width_m", 0.15))
    dedupe = float(cluster_cfg.get("dedupe_overlap", 0.5))
    min_area = float(cfg.get("rack_detect", "min_area_m2", default=0.3))
    max_area = float(cfg.get("rack_detect", "max_area_m2", default=2000.0))

    # Segments already covered by a polyline-derived rack are decoration
    # (bracing, hatch), not a separate rack.
    usable: list[dict[str, Any]] = []
    absorbed = 0
    for seg in segments:
        line = LineString(seg["points"])
        if line.length <= 0:
            continue
        if existing is not None and line.within(existing.buffer(1e-6)):
            absorbed += 1
            continue
        usable.append(seg)
    if absorbed:
        notes.append(
            {"reason": f"既存ラック内に含まれる線分 {absorbed} 本をクラスタリング対象から除外"}
        )
    if not usable:
        return [], notes

    points: list[tuple[float, float]] = []
    for seg in usable:
        line = LineString(seg["points"])
        count = max(int(line.length / step), 1)
        for i in range(count + 1):
            pt = line.interpolate(min(i * step, line.length))
            points.append((pt.x, pt.y))
    if len(points) < min_samples:
        return [], notes

    labels = DBSCAN(eps=eps, min_samples=min_samples).fit_predict(points)
    groups: dict[int, list[tuple[float, float]]] = {}
    noise = 0
    for label, point in zip(labels, points):
        if label < 0:
            noise += 1
            continue
        groups.setdefault(int(label), []).append(point)
    if noise:
        notes.append(
            {"reason": f"クラスタに属さないサンプル点 {noise} 個（ノイズとして無視）"}
        )

    out: list[tuple[Polygon, str, str]] = []
    accumulated = existing
    for label in sorted(groups):
        group = groups[label]
        if len(group) < 3:
            continue
        rect = MultiPoint(group).minimum_rotated_rectangle
        if rect.geom_type != "Polygon" or rect.area <= 0:
            notes.append({"reason": f"クラスタ {label}: 矩形化できない（直線状）"})
            continue
        if _short_side(rect) < min_width:
            notes.append(
                {"reason": f"クラスタ {label}: 短辺 {_short_side(rect):.3f} m が細すぎる"}
            )
            continue
        if not (min_area <= rect.area <= max_area):
            notes.append(
                {"reason": f"クラスタ {label}: 面積 {rect.area:.2f} m² が rack_detect の範囲外"}
            )
            continue
        if accumulated is not None:
            overlap = rect.intersection(accumulated).area
            if rect.area > 0 and overlap / rect.area > dedupe:
                notes.append({"reason": f"クラスタ {label}: 既存ラックと重複のため破棄"})
                continue
        out.append((rect, "cluster", "cluster"))
        accumulated = rect if accumulated is None else unary_union([accumulated, rect])
    return out, notes
