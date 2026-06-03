"""Storage-equipment presets (rack types): catalog, per-type materialize, API."""

from fastapi.testclient import TestClient

from whsim import design, racktypes
from whsim.render.shelves import shelf_runs
from whsim.schema.model import Item, ShelfArea, WarehouseModel, Zone
from whsim.web.app import app


def test_catalog_has_representative_types():
    ids = {c["id"] for c in racktypes.catalog()}
    assert {"light", "medium", "pallet", "nestainer"} <= ids
    for c in racktypes.catalog():
        assert c["bay"] > 0 and c["depth"] > 0 and c["color"].startswith("#")


def test_rack_type_changes_cell_geometry_and_capacity():
    def build(rt):
        m = WarehouseModel()
        m.layout.zones = [Zone(id="storage", type="storage", x=0, y=0, w=12, h=12,
                               shelves=[ShelfArea(id="a", x=1, y=1, w=2, h=10, rack_type=rt)])]
        m.items = [Item(sku=f"S{i}") for i in range(5)]
        design.materialize_racks(m)
        return m
    light, pallet = build("light"), build("pallet")
    # light shelving packs more (smaller cells); pallet rack fewer, higher capacity
    assert len(light.locations) > len(pallet.locations)
    assert pallet.locations[0].capacity > light.locations[0].capacity
    assert pallet.locations[0].rack_type == "pallet"
    assert shelf_runs(pallet)[0]["rack_type"] == "pallet"


def test_shelfarea_defaults_to_medium():
    assert ShelfArea().rack_type == "medium"


def test_racktypes_endpoint():
    r = TestClient(app).get("/api/racktypes")
    assert r.status_code == 200
    ids = {c["id"] for c in r.json()}
    assert "pallet" in ids and "nestainer" in ids
