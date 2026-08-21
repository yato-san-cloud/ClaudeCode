"""Synthetic DXF fixtures — the only inputs the test suite needs (DoD 6).

Every generator returns the ground truth alongside the file, so extraction can be
compared against known rack rectangles and a known walkable envelope. Drawings are
authored in millimetres to also exercise the mm -> m factor.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import ezdxf

MM = 1000.0  # drawing units per metre


@dataclass
class Truth:
    """Ground truth for a generated drawing, in metres, origin at lower-left."""

    path: Path
    racks: list[list[tuple[float, float]]] = field(default_factory=list)
    envelope: list[tuple[float, float]] = field(default_factory=list)
    width_m: float = 0.0
    height_m: float = 0.0

    @property
    def rack_centroids(self) -> list[tuple[float, float]]:
        out = []
        for ring in self.racks:
            xs = [p[0] for p in ring]
            ys = [p[1] for p in ring]
            out.append((sum(xs) / len(xs), sum(ys) / len(ys)))
        return out


def _rect(x: float, y: float, w: float, d: float) -> list[tuple[float, float]]:
    return [(x, y), (x + w, y), (x + w, y + d), (x, y + d)]


def _rotate(
    ring: list[tuple[float, float]], deg: float, about: tuple[float, float]
) -> list[tuple[float, float]]:
    rad = math.radians(deg)
    cos, sin = math.cos(rad), math.sin(rad)
    cx, cy = about
    return [
        ((x - cx) * cos - (y - cy) * sin + cx, (x - cx) * sin + (y - cy) * cos + cy)
        for x, y in ring
    ]


def _to_mm(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    return [(x * MM, y * MM) for x, y in ring]


def _new_doc():
    doc = ezdxf.new("R2010")
    for layer in ("RACK", "WALL", "ZONE_SHIP", "NOTES"):
        doc.layers.add(layer)
    return doc, doc.modelspace()


def _add_noise(msp) -> None:
    """Entities on unmapped layers: they must show up in report.unclassified."""
    msp.add_text("A-01", dxfattribs={"layer": "NOTES"}).set_placement((1000, 1000))
    msp.add_circle((2000, 2000), radius=300, dxfattribs={"layer": "NOTES"})


def simple_three_aisle(path: Path) -> Truth:
    """4 rack rows -> 3 aisles, inside a 40 x 24 m rectangular building."""
    doc, msp = _new_doc()
    envelope = _rect(0, 0, 40, 24)
    msp.add_lwpolyline(_to_mm(envelope), close=True, dxfattribs={"layer": "WALL"})
    racks = [_rect(5, y, 30, 1.2) for y in (4.0, 9.0, 14.0, 19.0)]
    for ring in racks:
        msp.add_lwpolyline(_to_mm(ring), close=True, dxfattribs={"layer": "RACK"})
    msp.add_lwpolyline(
        _to_mm(_rect(0.5, 21.0, 8, 2.5)), close=True, dxfattribs={"layer": "ZONE_SHIP"}
    )
    _add_noise(msp)
    doc.saveas(path)
    return Truth(path=path, racks=racks, envelope=envelope, width_m=40, height_m=24)


def l_shaped(path: Path) -> Truth:
    """L-shaped building: the missing quadrant must contain no aisle nodes."""
    doc, msp = _new_doc()
    envelope = [(0, 0), (40, 0), (40, 20), (20, 20), (20, 32), (0, 32)]
    msp.add_lwpolyline(_to_mm(envelope), close=True, dxfattribs={"layer": "WALL"})
    racks = [_rect(4, y, 32, 1.2) for y in (4.0, 9.0, 14.0)]
    racks += [_rect(3, y, 14, 1.2) for y in (23.0, 28.0)]
    for ring in racks:
        msp.add_lwpolyline(_to_mm(ring), close=True, dxfattribs={"layer": "RACK"})
    _add_noise(msp)
    doc.saveas(path)
    return Truth(path=path, racks=racks, envelope=envelope, width_m=40, height_m=32)


def diagonal(path: Path, angle_deg: float = 30.0) -> Truth:
    """Rack rows rotated 30° — nothing in the pipeline may assume axis alignment."""
    doc, msp = _new_doc()
    envelope = _rect(0, 0, 44, 34)
    msp.add_lwpolyline(_to_mm(envelope), close=True, dxfattribs={"layer": "WALL"})
    centre = (22.0, 17.0)
    racks = [
        _rotate(_rect(9, y, 26, 1.5), angle_deg, centre) for y in (8.0, 13.0, 18.0, 23.0)
    ]
    for ring in racks:
        msp.add_lwpolyline(_to_mm(ring), close=True, dxfattribs={"layer": "RACK"})
    _add_noise(msp)
    doc.saveas(path)
    return Truth(path=path, racks=racks, envelope=envelope, width_m=44, height_m=34)


def loose_lines(path: Path) -> Truth:
    """Same layout as simple_three_aisle, but each rack is 4 unconnected LINEs."""
    doc, msp = _new_doc()
    envelope = _rect(0, 0, 40, 24)
    msp.add_lwpolyline(_to_mm(envelope), close=True, dxfattribs={"layer": "WALL"})
    racks = [_rect(5, y, 30, 1.2) for y in (4.0, 9.0, 14.0, 19.0)]
    for ring in racks:
        mm_ring = _to_mm(ring)
        for a, b in zip(mm_ring, mm_ring[1:] + mm_ring[:1]):
            msp.add_line(a, b, dxfattribs={"layer": "RACK"})
    _add_noise(msp)
    doc.saveas(path)
    return Truth(path=path, racks=racks, envelope=envelope, width_m=40, height_m=24)


def blocks_and_solids(path: Path) -> Truth:
    """Racks as a BLOCK reference + a SOLID: both must be seen."""
    doc, msp = _new_doc()
    envelope = _rect(0, 0, 30, 20)
    msp.add_lwpolyline(_to_mm(envelope), close=True, dxfattribs={"layer": "WALL"})
    block = doc.blocks.new(name="RACKUNIT")
    block.add_lwpolyline(
        _to_mm(_rect(0, 0, 20, 1.2)), close=True, dxfattribs={"layer": "RACK"}
    )
    msp.add_blockref("RACKUNIT", (5 * MM, 5 * MM), dxfattribs={"layer": "RACK"})
    msp.add_solid(
        _to_mm([(5, 12), (25, 12), (5, 13.2), (25, 13.2)]), dxfattribs={"layer": "RACK"}
    )
    racks = [_rect(5, 5, 20, 1.2), _rect(5, 12, 20, 1.2)]
    doc.saveas(path)
    return Truth(path=path, racks=racks, envelope=envelope, width_m=30, height_m=20)


def empty_drawing(path: Path) -> Path:
    doc = ezdxf.new("R2010")
    doc.saveas(path)
    return path


def dwg_masquerading_as_dxf(path: Path) -> Path:
    path.write_bytes(b"AC1027" + b"\x00" * 64 + b"binary dwg payload")
    return path


def garbage_dxf(path: Path) -> Path:
    path.write_text("これはDXFではありません\n" * 20, encoding="utf-8")
    return path
