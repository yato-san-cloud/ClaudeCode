"""Assemble the contract's layout.geojson (WHSIM_CONTRACTS v1.0 §1).

FeatureCollection, one Feature per rack / node / edge / zone, plus the foreign
member `meta` carrying `crs: "local-meters"`.
"""

from __future__ import annotations

from typing import Any

from shapely.geometry import MultiPolygon, Polygon, mapping

from .aisles import Edge, GraphResult, Node
from .racks import Rack


def _round_coords(value: Any, decimals: int) -> Any:
    if isinstance(value, (list, tuple)):
        return [_round_coords(v, decimals) for v in value]
    if isinstance(value, float):
        return round(value, decimals)
    return value


def _feature(geometry: dict[str, Any], properties: dict[str, Any], decimals: int) -> dict[str, Any]:
    geometry = dict(geometry)
    geometry["coordinates"] = _round_coords(geometry["coordinates"], decimals)
    return {"type": "Feature", "geometry": geometry, "properties": properties}


def _polygon_geometry(poly: Polygon | MultiPolygon) -> dict[str, Any]:
    if poly.geom_type == "MultiPolygon":
        poly = max(poly.geoms, key=lambda g: g.area)
    return mapping(poly)


def build_layout(
    racks: list[Rack],
    graph: GraphResult,
    zones: list[dict[str, Any]],
    meta: dict[str, Any],
    decimals: int = 4,
) -> dict[str, Any]:
    features: list[dict[str, Any]] = []

    for rack in racks:
        props: dict[str, Any] = {"kind": "rack", "id": rack.id}
        if rack.label:
            props["label"] = rack.label
        props["source"] = rack.source
        features.append(_feature(_polygon_geometry(rack.polygon), props, decimals))

    for zone in zones:
        features.append(
            _feature(
                _polygon_geometry(zone["polygon"]),
                {"kind": "zone", "id": zone["id"], "label": zone["label"]},
                decimals,
            )
        )

    for node in graph.nodes:
        features.append(
            _feature(
                {"type": "Point", "coordinates": [node.x, node.y]},
                {"kind": "node", "id": node.id},
                decimals,
            )
        )

    by_id: dict[str, Node] = {n.id: n for n in graph.nodes}
    for edge in graph.edges:
        a, b = by_id[edge.frm], by_id[edge.to]
        props = {"kind": "edge", "id": edge.id, "from": edge.frm, "to": edge.to}
        if edge.width_m is not None:
            props["width_m"] = edge.width_m
        features.append(
            _feature(
                {"type": "LineString", "coordinates": [[a.x, a.y], [b.x, b.y]]},
                props,
                decimals,
            )
        )

    collection: dict[str, Any] = {"type": "FeatureCollection", "features": features}
    collection["meta"] = {"crs": "local-meters", **meta}
    return collection


def edge_endpoints(edge: Edge, nodes: list[Node]) -> tuple[Node, Node]:  # pragma: no cover
    by_id = {n.id: n for n in nodes}
    return by_id[edge.frm], by_id[edge.to]
