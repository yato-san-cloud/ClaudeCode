"""DoD 2/3/5: schema validity, the common assertions, and the report."""

from __future__ import annotations

import copy

import pytest
import synthetic
from cad2loc.validate import check_assertions, load_schema, validate
from helpers import features, run


def test_output_validates_against_the_contract_schema(tmp_path):
    truth = synthetic.simple_three_aisle(tmp_path / "s.dxf")
    layout = run(truth.path).layout
    assert validate(layout, load_schema()) == []
    assert layout["type"] == "FeatureCollection"
    assert layout["meta"]["crs"] == "local-meters"
    for feature in layout["features"]:
        assert feature["properties"]["kind"] in {"rack", "node", "edge", "zone"}
        assert feature["properties"]["id"]


def test_edge_endpoints_reference_real_nodes(tmp_path):
    truth = synthetic.simple_three_aisle(tmp_path / "s.dxf")
    layout = run(truth.path).layout
    node_ids = {f["properties"]["id"] for f in features(layout, "node")}
    for edge in features(layout, "edge"):
        assert edge["properties"]["from"] in node_ids
        assert edge["properties"]["to"] in node_ids


@pytest.mark.parametrize(
    "mutate, expect",
    [
        (lambda d: d.pop("meta"), "meta"),
        (lambda d: d["meta"].__setitem__("crs", "EPSG:4326"), "local-meters"),
        (lambda d: d["features"][0]["properties"].pop("id"), "id"),
        (lambda d: d["features"][0]["properties"].__setitem__("kind", "shelf"), "kind"),
    ],
)
def test_schema_rejects_broken_documents(tmp_path, mutate, expect):
    """A validator that accepts everything proves nothing."""
    truth = synthetic.simple_three_aisle(tmp_path / "s.dxf")
    layout = copy.deepcopy(run(truth.path).layout)
    mutate(layout)
    errors = validate(layout, load_schema())
    assert errors, "broken document was accepted"
    assert any(expect in error for error in errors), errors[:3]


def test_hand_rolled_validator_agrees_with_a_reference_implementation(tmp_path):
    """Cross-check, skipped when jsonschema is absent (it is not a dependency)."""
    jsonschema = pytest.importorskip("jsonschema")
    truth = synthetic.simple_three_aisle(tmp_path / "s.dxf")
    layout = run(truth.path).layout
    schema = load_schema()
    validator = jsonschema.Draft202012Validator(schema)
    assert list(validator.iter_errors(layout)) == []
    assert validate(layout, schema) == []

    broken = copy.deepcopy(layout)
    broken["features"][0]["properties"].pop("id")
    assert list(validator.iter_errors(broken))
    assert validate(broken, schema)


def test_schema_rejects_wrong_geometry_type(tmp_path):
    truth = synthetic.simple_three_aisle(tmp_path / "s.dxf")
    layout = copy.deepcopy(run(truth.path).layout)
    rack = next(f for f in layout["features"] if f["properties"]["kind"] == "rack")
    rack["geometry"] = {"type": "Point", "coordinates": [1.0, 2.0]}
    assert validate(layout, load_schema())


def test_assertions_catch_an_edge_through_a_rack(tmp_path):
    truth = synthetic.simple_three_aisle(tmp_path / "s.dxf")
    layout = copy.deepcopy(run(truth.path).layout)
    assert check_assertions(layout).ok

    rack = next(f for f in layout["features"] if f["properties"]["kind"] == "rack")
    ring = rack["geometry"]["coordinates"][0]
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    node_ids = [f["properties"]["id"] for f in features(layout, "node")][:2]
    layout["features"].append(
        {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [
                    [min(xs) - 1.0, (min(ys) + max(ys)) / 2],
                    [max(xs) + 1.0, (min(ys) + max(ys)) / 2],
                ],
            },
            "properties": {
                "kind": "edge",
                "id": "e_bad",
                "from": node_ids[0],
                "to": node_ids[1],
            },
        }
    )
    result = check_assertions(layout)
    assert result.edge_rack_intersections == 1
    assert "e_bad" in result.intersecting_edges
    assert not result.ok


def test_assertions_catch_a_disconnected_node(tmp_path):
    truth = synthetic.simple_three_aisle(tmp_path / "s.dxf")
    layout = copy.deepcopy(run(truth.path).layout)
    layout["features"].append(
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [999.0, 999.0]},
            "properties": {"kind": "node", "id": "n_lonely"},
        }
    )
    result = check_assertions(layout)
    assert not result.connected
    assert "n_lonely" in result.isolated_nodes


def test_report_lists_unclassified_and_keeps_going(tmp_path):
    """DoD 5: TEXT/CIRCLE on an unmapped layer are reported, not fatal."""
    truth = synthetic.simple_three_aisle(tmp_path / "s.dxf")
    result = run(truth.path)
    unclassified = result.report["unclassified"]
    assert unclassified, "unmapped entities should be reported"
    kinds = {entry["dxftype"] for entry in unclassified}
    assert {"TEXT", "CIRCLE"} <= kinds
    assert all(entry["layer"] == "NOTES" for entry in unclassified)
    assert result.report["counts"]["rack"] == 4  # processing continued
    assert result.report["assertions"]["ok"] is True


def test_report_records_isolated_nodes_when_a_pocket_is_walled_off(tmp_path):
    """A sealed room becomes its own component: dropped from output, kept in report."""
    import ezdxf
    from cad2loc.pipeline import convert
    from helpers import config

    doc = ezdxf.new("R2010")
    for layer in ("RACK", "WALL"):
        doc.layers.add(layer)
    msp = doc.modelspace()
    msp.add_lwpolyline(
        [(0, 0), (40000, 0), (40000, 24000), (0, 24000)], close=True, dxfattribs={"layer": "WALL"}
    )
    # a rack ring that seals a pocket off from the rest of the floor
    msp.add_lwpolyline(
        [(30000, 14000), (39000, 14000), (39000, 15000), (30000, 15000)],
        close=True,
        dxfattribs={"layer": "RACK"},
    )
    msp.add_lwpolyline(
        [(30000, 14000), (31000, 14000), (31000, 23000), (30000, 23000)],
        close=True,
        dxfattribs={"layer": "RACK"},
    )
    path = tmp_path / "pocket.dxf"
    doc.saveas(path)

    result = convert(path, config())
    assert result.report["isolated_nodes"], "the sealed pocket should be reported"
    assert result.assertions.connected  # what we emit is a single component
    assert result.assertions.ok
