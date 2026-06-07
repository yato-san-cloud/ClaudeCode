"""MapMaker native .rmpm.json importer + shelf-name → location-name propagation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from whsim import design, rmpm
from whsim.schema.model import WarehouseModel


def _doc() -> dict:
    """A tiny but representative rmpm export (mm, top-left origin)."""
    return {
        "unit": "mm",
        "axes": "x-right, y-down, origin top-left",
        "floors": [{
            "name": "Floor",
            "bounds": {"left": 0, "top": 0, "right": 100000, "bottom": 50000},
            "objects": [
                {"type": "FreeShelfObject", "id": 1, "x": 10000, "y": 10000,
                 "w": 1150, "h": 2500, "name": "100-01-09"},
                {"type": "FreeShelfObject", "id": 2, "x": 12000, "y": 10000,
                 "w": 1150, "h": 2500, "name": "100-01-10"},
                {"type": "WallObject", "id": 3, "x": 0, "y": 0, "w": 100000, "h": 300},
                {"type": "StationObject", "id": 4, "x": 5000, "y": 40000,
                 "w": 2000, "h": 2000, "name": "PACK1"},
                {"type": "StairsObject", "id": 5, "x": 0, "y": 0, "w": 1000, "h": 1000},
                {"type": "FreeShelfObject", "id": 6, "x": 1000, "y": 1000,
                 "w": 1000, "h": 1000, "name": "START"},
            ],
        }],
    }


def test_rmpm_basic_mapping():
    res = rmpm.import_rmpm_bytes(json.dumps(_doc()).encode())
    assert res["stats"]["units"] == "mm"
    assert res["stats"]["shelves"] == 2
    assert res["walls"] and res["stations"]
    z = res["zones"][0]
    assert z["type"] == "storage"
    names = {s["name"] for s in z["shelves"]}
    assert "100-01-09" in names and "100-01-10" in names
    # START/END picking markers are excluded from storage (reported, never fatal).
    assert "START" not in names
    assert any("START" in w for w in res["warnings"])
    # mm -> m conversion (1150 mm -> 1.15 m).
    s0 = next(s for s in z["shelves"] if s["name"] == "100-01-09")
    assert abs(s0["w"] - 1.15) < 1e-6
    assert s0["facing"] in ("up", "down", "left", "right")
    # The skipped StairsObject is reported, never fatal.
    assert any("StairsObject" in w for w in res["warnings"])


def test_rmpm_location_names_propagate():
    res = rmpm.import_rmpm_bytes(json.dumps(_doc()).encode())
    md = {"layout": {"bounds": res["bounds"], "zones": res["zones"],
                     "walls": res["walls"]}}
    model = WarehouseModel.model_validate(md)
    design.materialize_racks(model)
    # Every materialised location inherits a name seeded from its shelf, so loaded
    # stock data can later slot by shelf name.
    named = [loc for loc in model.locations if loc.name]
    assert named, "locations should inherit shelf names"
    assert any(loc.name.startswith("100-01-09") for loc in model.locations)


def test_rmpm_bad_json_raises_valueerror():
    with pytest.raises(ValueError):
        rmpm.import_rmpm_bytes(b"{ this is not json")


def test_rmpm_empty_is_tolerant():
    res = rmpm.import_rmpm_bytes(json.dumps({"floors": [{"objects": []}]}).encode())
    assert res["bounds"] is None and res["zones"] == []
    assert res["warnings"]  # explains why nothing was placed


def test_rmpm_real_layout_if_present():
    """The bundled real export (193m x 92m, ~600 named shelves) imports cleanly."""
    p = (Path(__file__).resolve().parents[1]
         / "reference" / "mapmaker" / "exported" / "LW.rmpm.json")
    if not p.exists():
        pytest.skip("reference layout not bundled")
    res = rmpm.import_rmpm_bytes(p.read_bytes())
    assert res["stats"]["units"] == "mm"
    assert res["stats"]["shelves"] > 100
    assert res["bounds"]["width"] > 50  # tens of metres, not millimetres
