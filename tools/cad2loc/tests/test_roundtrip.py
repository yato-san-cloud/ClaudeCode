"""DoD 4: synthetic DXF -> extraction -> compare against the known layout.

Three patterns (simple 3-aisle / L-shaped / diagonal) plus the loose-line drawing
that exercises the clustering path, and a block/solid drawing.
"""

from __future__ import annotations

import math

import pytest
import synthetic
from cad2loc.validate import check_assertions, path_hits_racks
from helpers import (
    features,
    match_centroids,
    nearest_node,
    nodes_xy,
    rack_polygons,
    run,
    shortest_path_line,
)
from shapely.geometry import Point, Polygon


def _assert_walkable(result, layout):
    assertions = check_assertions(layout)
    assert assertions.edge_rack_intersections == 0, assertions.intersecting_edges[:5]
    assert assertions.connected, f"components={assertions.component_count}"
    assert not assertions.dangling_edges
    assert result.schema_errors == []


def test_simple_three_aisle(tmp_path):
    truth = synthetic.simple_three_aisle(tmp_path / "simple.dxf")
    result = run(truth.path)
    layout = result.layout

    assert len(features(layout, "rack")) == 4
    match_centroids(layout, truth.rack_centroids, tol=0.01)
    for poly, ring in zip(rack_polygons(layout), truth.racks):
        assert poly.area == pytest.approx(Polygon(ring).area, abs=0.01)

    # mm -> m and origin at the lower-left corner of the drawing.
    xs = [p[0] for p in nodes_xy(layout).values()]
    ys = [p[1] for p in nodes_xy(layout).values()]
    assert min(xs) >= 0 and min(ys) >= 0
    assert max(xs) <= truth.width_m and max(ys) <= truth.height_m
    assert result.report["transform"]["scale_to_m"] == 0.001

    _assert_walkable(result, layout)

    # every one of the 3 aisles carries nodes, and they are one component
    for aisle_y in (7.6, 12.6, 17.6):
        near = nearest_node(layout, 20.0, aisle_y)
        assert math.isclose(nodes_xy(layout)[near][1], aisle_y, abs_tol=1.0)

    src = nearest_node(layout, 6.0, 7.6)
    dst = nearest_node(layout, 34.0, 17.6)
    line = shortest_path_line(layout, src, dst)
    assert path_hits_racks(layout, line) == 0
    assert line.length > 20.0

    # the ZONE_SHIP polyline became a zone feature with its configured label
    zones = features(layout, "zone")
    assert len(zones) == 1
    assert zones[0]["properties"]["label"] == "出荷バース"


def test_l_shaped(tmp_path):
    truth = synthetic.l_shaped(tmp_path / "lshape.dxf")
    result = run(truth.path)
    layout = result.layout

    assert len(features(layout, "rack")) == 5
    match_centroids(layout, truth.rack_centroids, tol=0.01)
    _assert_walkable(result, layout)

    envelope = Polygon(truth.envelope)
    for x, y in nodes_xy(layout).values():
        assert envelope.contains(Point(x, y)), f"node ({x},{y}) is outside the L-shaped building"

    # both arms are reachable from each other
    src = nearest_node(layout, 36.0, 2.0)  # bottom-right arm
    dst = nearest_node(layout, 2.0, 31.0)  # upper-left arm
    line = shortest_path_line(layout, src, dst)
    assert path_hits_racks(layout, line) == 0
    assert envelope.buffer(1e-6).covers(line)


def test_diagonal(tmp_path):
    truth = synthetic.diagonal(tmp_path / "diagonal.dxf")
    result = run(truth.path)
    layout = result.layout

    assert len(features(layout, "rack")) == 4
    match_centroids(layout, truth.rack_centroids, tol=0.01)
    _assert_walkable(result, layout)

    # rotation survived: the extracted rectangles are not axis-aligned
    for poly, ring in zip(rack_polygons(layout), truth.racks):
        assert poly.area == pytest.approx(Polygon(ring).area, abs=0.05)
        bounds = poly.bounds
        assert (bounds[2] - bounds[0]) > 20.0 and (bounds[3] - bounds[1]) > 10.0

    ids = list(nodes_xy(layout))
    line = shortest_path_line(layout, ids[0], ids[-1])
    assert path_hits_racks(layout, line) == 0


def test_loose_lines_are_clustered_into_racks(tmp_path):
    truth = synthetic.loose_lines(tmp_path / "loose.dxf")
    result = run(truth.path)
    layout = result.layout

    assert result.report["rack_sources"]["cluster"] == 4
    assert result.report["rack_sources"]["polyline"] == 0
    match_centroids(layout, truth.rack_centroids, tol=0.05)
    for poly, ring in zip(rack_polygons(layout), truth.racks):
        assert poly.area == pytest.approx(Polygon(ring).area, abs=0.2)
    _assert_walkable(result, layout)


def test_clustering_can_be_disabled(tmp_path):
    truth = synthetic.loose_lines(tmp_path / "loose2.dxf")
    result = run(truth.path, rack_detect={"cluster": {"enabled": False}})
    assert len(features(result.layout, "rack")) == 0
    assert any("ラックが1つも" in w for w in result.report["warnings"])
    # never blocks: a rack-less drawing still yields a valid, walkable layout
    assert result.schema_errors == []
    assert len(features(result.layout, "node")) > 0


def test_blocks_and_solids(tmp_path):
    truth = synthetic.blocks_and_solids(tmp_path / "blocks.dxf")
    result = run(truth.path)
    assert len(features(result.layout, "rack")) == 2
    match_centroids(result.layout, truth.rack_centroids, tol=0.01)
    _assert_walkable(result, result.layout)


def test_edge_width_reported(tmp_path):
    truth = synthetic.simple_three_aisle(tmp_path / "w.dxf")
    layout = run(truth.path).layout
    widths = [f["properties"].get("width_m") for f in features(layout, "edge")]
    assert widths and all(w is not None and w >= 0 for w in widths)
    # a node in the middle of a 3.8 m aisle is ~1.9 m from each rack
    assert max(widths) >= 3.0
