"""Aisle graph — nodes and edges strictly outside the rack footprints.

Method: sample the *free* space (building envelope minus racks grown by a
clearance) on a uniform grid, connect 4-neighbours, then drop every edge that is
not fully inside the free space or that touches a rack. A grid is used rather
than aisle centrelines because it needs no assumption about rack alignment — the
diagonal and L-shaped drawings fall out of the same code — and the contract's
hard requirement (edge x rack = 0) is a property of the filter, not of the
heuristic that proposed the edge.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import networkx as nx
import numpy as np
import shapely
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.ops import polygonize, unary_union

from .config import Config
from .dxfread import RawGeometry
from .racks import Rack


@dataclass
class Node:
    id: str
    x: float
    y: float


@dataclass
class Edge:
    id: str
    frm: str
    to: str
    width_m: float | None = None


@dataclass
class GraphResult:
    nodes: list[Node] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)
    dropped_nodes: list[dict[str, Any]] = field(default_factory=list)
    notes: list[dict[str, Any]] = field(default_factory=list)
    grid_spacing_m: float = 1.0
    envelope: Polygon | MultiPolygon | None = None
    free_space: Polygon | MultiPolygon | None = None


def build_envelope(
    raw: RawGeometry, racks: list[Rack], cfg: Config
) -> tuple[Polygon | MultiPolygon, list[dict[str, Any]], str]:
    """Walls define the walkable outline; without walls, the rack bbox + margin."""
    notes: list[dict[str, Any]] = []
    lines: list[LineString] = []
    for ring in raw.by_kind("wall", "ring"):
        pts = list(ring["points"])
        if ring.get("closed") and pts[0] != pts[-1]:
            pts = pts + [pts[0]]
        if len(pts) >= 2:
            lines.append(LineString(pts))
    for seg in raw.by_kind("wall", "segment"):
        lines.append(LineString(seg["points"]))

    all_geom = [r.polygon for r in racks] + lines
    if not all_geom:
        return Polygon(), notes, "none"
    bounds = unary_union(all_geom).bounds
    margin = float(cfg.get("aisle_graph", "envelope_margin_m", default=2.0))

    if lines:
        faces = [f for f in polygonize(unary_union(lines)) if f.area > 0]
        if faces:
            outline = max(faces, key=lambda f: f.area)
            bbox_area = max((bounds[2] - bounds[0]) * (bounds[3] - bounds[1]), 1e-9)
            if outline.area >= 0.05 * bbox_area:
                if len(faces) > 1:
                    notes.append(
                        {
                            "reason": f"壁から {len(faces)} 個の閉領域を検出、"
                            f"最大面積 {outline.area:.1f} m² を建屋外形として採用"
                        }
                    )
                return outline, notes, "walls"
        notes.append({"reason": "壁レイヤはあるが閉じた外形にならないため、外接矩形を採用"})

    envelope = box(*bounds).buffer(margin, join_style=2)
    return envelope, notes, "bbox+margin"


def build_graph(raw: RawGeometry, racks: list[Rack], cfg: Config) -> GraphResult:
    spacing = float(cfg.get("aisle_graph", "grid_spacing_m", default=1.0))
    clearance = float(cfg.get("aisle_graph", "clearance_m", default=0.35))
    max_nodes = int(cfg.get("aisle_graph", "max_nodes", default=20000))
    emit_width = bool(cfg.get("aisle_graph", "emit_width", default=True))
    keep_main = bool(cfg.get("aisle_graph", "keep_main_component_only", default=True))

    result = GraphResult(grid_spacing_m=spacing)
    envelope, notes, envelope_source = build_envelope(raw, racks, cfg)
    result.notes.extend(notes)
    result.envelope = envelope
    result.notes.append({"reason": f"建屋外形の由来: {envelope_source}"})
    if envelope.is_empty:
        result.notes.append({"reason": "ジオメトリが無いため通路グラフを生成しませんでした"})
        return result

    rack_union = unary_union([r.polygon for r in racks]) if racks else None
    inner = envelope.buffer(-clearance)
    if inner.is_empty:
        inner = envelope
        result.notes.append({"reason": "建屋外形が狭くクリアランスを内側に取れませんでした"})
    free = inner.difference(rack_union.buffer(clearance)) if rack_union is not None else inner
    if free.is_empty:
        result.notes.append({"reason": "ラック以外の自由空間がありません（通路グラフは空）"})
        return result
    result.free_space = free

    # Coarsen rather than explode on a huge drawing; the choice is reported.
    minx, miny, maxx, maxy = free.bounds
    for _ in range(6):
        cols = max(int((maxx - minx) / spacing), 1)
        rows = max(int((maxy - miny) / spacing), 1)
        if cols * rows <= max_nodes:
            break
        spacing *= 1.5
        result.notes.append(
            {"reason": f"ノード数上限 {max_nodes} 超過のためグリッド間隔を {spacing:.2f} m に粗くしました"}
        )
    result.grid_spacing_m = spacing

    xs = np.arange(minx + spacing / 2.0, maxx, spacing)
    ys = np.arange(miny + spacing / 2.0, maxy, spacing)
    if xs.size == 0 or ys.size == 0:
        result.notes.append({"reason": "自由空間がグリッド間隔より小さく、ノードを置けません"})
        return result

    grid_x, grid_y = np.meshgrid(xs, ys)
    flat_x = grid_x.ravel()
    flat_y = grid_y.ravel()
    candidates = shapely.points(np.column_stack([flat_x, flat_y]))
    shapely.prepare(free)
    inside = shapely.contains(free, candidates)

    index_of: dict[tuple[int, int], str] = {}
    nodes: list[Node] = []
    width = xs.size
    for flat_index, ok in enumerate(inside):
        if not ok:
            continue
        row, col = divmod(flat_index, width)
        node_id = f"n{len(nodes) + 1:05d}"
        index_of[(row, col)] = node_id
        nodes.append(Node(id=node_id, x=float(flat_x[flat_index]), y=float(flat_y[flat_index])))
    if not nodes:
        result.notes.append({"reason": "自由空間内にノードを配置できませんでした"})
        return result

    by_id = {n.id: n for n in nodes}
    pairs: list[tuple[str, str]] = []
    for (row, col), node_id in index_of.items():
        for neighbour in ((row, col + 1), (row + 1, col)):
            other = index_of.get(neighbour)
            if other is not None:
                pairs.append((node_id, other))
    if not pairs:
        result.notes.append({"reason": "隣接ノードが無く辺を作れませんでした"})
        result.nodes = nodes
        return result

    segments = shapely.linestrings(
        np.array(
            [
                [[by_id[a].x, by_id[a].y], [by_id[b].x, by_id[b].y]]
                for a, b in pairs
            ]
        )
    )
    keep = shapely.covers(free, segments)
    if rack_union is not None:
        keep &= ~shapely.intersects(segments, rack_union)

    edges: list[Edge] = []
    kept_pairs = [pair for pair, ok in zip(pairs, keep) if ok]

    widths: list[float | None] = [None] * len(kept_pairs)
    if emit_width and kept_pairs:
        mids = shapely.points(
            np.array(
                [
                    [(by_id[a].x + by_id[b].x) / 2.0, (by_id[a].y + by_id[b].y) / 2.0]
                    for a, b in kept_pairs
                ]
            )
        )
        limits = shapely.distance(mids, envelope.boundary)
        if rack_union is not None:
            limits = np.minimum(limits, shapely.distance(mids, rack_union))
        widths = [float(round(2.0 * value, 3)) for value in limits]

    for index, (a, b) in enumerate(kept_pairs):
        edges.append(Edge(id=f"e{index + 1:05d}", frm=a, to=b, width_m=widths[index]))

    graph = nx.Graph()
    graph.add_nodes_from(n.id for n in nodes)
    graph.add_edges_from((e.frm, e.to) for e in edges)
    components = sorted(nx.connected_components(graph), key=len, reverse=True)
    main = components[0] if components else set()

    if keep_main and len(components) > 1:
        for component in components[1:]:
            for node_id in component:
                node = by_id[node_id]
                result.dropped_nodes.append(
                    {
                        "id": node_id,
                        "x": round(node.x, 4),
                        "y": round(node.y, 4),
                        "component_size": len(component),
                        "reason": "主連結成分に属さないため出力から除外",
                    }
                )
        nodes = [n for n in nodes if n.id in main]
        keep_ids = {n.id for n in nodes}
        edges = [e for e in edges if e.frm in keep_ids and e.to in keep_ids]
        result.notes.append(
            {
                "reason": f"連結成分 {len(components)} 個のうち最大成分のみ出力"
                f"（除外ノード {len(result.dropped_nodes)} 個）"
            }
        )

    result.nodes = nodes
    result.edges = edges
    return result


def shortest_path_geometry(
    nodes: list[Node], edges: list[Edge], source: str, target: str
) -> LineString | None:
    """Helper used by the tests/CLI self-check: a real path through the graph."""
    by_id = {n.id: n for n in nodes}
    graph = nx.Graph()
    for node in nodes:
        graph.add_node(node.id)
    for edge in edges:
        a, b = by_id[edge.frm], by_id[edge.to]
        graph.add_edge(edge.frm, edge.to, weight=Point(a.x, a.y).distance(Point(b.x, b.y)))
    try:
        path = nx.shortest_path(graph, source, target, weight="weight")
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return None
    if len(path) < 2:
        return None
    return LineString([(by_id[p].x, by_id[p].y) for p in path])
