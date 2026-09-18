"""Shared test helpers: run the pipeline and poke at the emitted GeoJSON."""

from __future__ import annotations

import math
from typing import Any

import networkx as nx
from cad2loc.config import DEFAULTS, Config, _deep_merge
from cad2loc.pipeline import convert
from shapely.geometry import LineString, shape

# The synthetic drawings are authored in mm on layers RACK / WALL / ZONE_*.
TEST_CONFIG: dict[str, Any] = {
    "units": {"scale_to_m": 0.001},
    "layers": {
        "rack": ["RACK"],
        "wall": ["WALL"],
        "zone": ["ZONE*"],
        "ignore": ["defpoints"],
    },
    "zone_labels": {"ZONE_SHIP": "出荷バース"},
}


def config(**overrides: Any) -> Config:
    data = _deep_merge(DEFAULTS, TEST_CONFIG)
    return Config(data=_deep_merge(data, overrides))


def run(path, **overrides: Any):
    return convert(path, config(**overrides))


def features(layout: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    return [f for f in layout["features"] if f["properties"]["kind"] == kind]


def nodes_xy(layout: dict[str, Any]) -> dict[str, tuple[float, float]]:
    return {
        f["properties"]["id"]: tuple(f["geometry"]["coordinates"])
        for f in features(layout, "node")
    }


def nearest_node(layout: dict[str, Any], x: float, y: float) -> str:
    points = nodes_xy(layout)
    return min(points, key=lambda nid: math.dist(points[nid], (x, y)))


def graph_of(layout: dict[str, Any]) -> nx.Graph:
    points = nodes_xy(layout)
    graph = nx.Graph()
    graph.add_nodes_from(points)
    for feature in features(layout, "edge"):
        props = feature["properties"]
        a, b = props["from"], props["to"]
        graph.add_edge(a, b, weight=math.dist(points[a], points[b]))
    return graph


def shortest_path_line(layout: dict[str, Any], src: str, dst: str) -> LineString:
    points = nodes_xy(layout)
    path = nx.shortest_path(graph_of(layout), src, dst, weight="weight")
    return LineString([points[p] for p in path])


def rack_polygons(layout: dict[str, Any]):
    return [shape(f["geometry"]) for f in features(layout, "rack")]


def match_centroids(
    layout: dict[str, Any], expected: list[tuple[float, float]], tol: float
) -> list[float]:
    """Greedy 1:1 match of extracted rack centroids to expected ones."""
    got = [poly.centroid for poly in rack_polygons(layout)]
    remaining = list(got)
    errors: list[float] = []
    for target in expected:
        best = min(remaining, key=lambda c: math.dist((c.x, c.y), target))
        errors.append(math.dist((best.x, best.y), target))
        remaining.remove(best)
        assert errors[-1] <= tol, f"rack centroid {target} not matched (err={errors[-1]:.3f} m)"
    return errors
