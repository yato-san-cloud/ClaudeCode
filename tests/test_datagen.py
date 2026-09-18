"""不足データ作成 (datagen) + GENERATED provenance band."""

from fastapi.testclient import TestClient

from whsim import datagen
from whsim.provenance import Provenance, Source
from whsim.schema.model import Item, Order, OrderLine, Orders, WarehouseModel
from whsim.web.app import app


def _model_with_demand_no_master():
    m = WarehouseModel()
    m.items = []
    m.orders = Orders(outbound=[
        Order(order_id="O1", lines=[OrderLine(sku="A", qty=2), OrderLine(sku="B", qty=1)]),
        Order(order_id="O2", lines=[OrderLine(sku="A", qty=1)]),
    ])
    return m


def test_item_master_generated_from_demand():
    m = _model_with_demand_no_master()
    r = datagen.generate_missing(m)
    skus = {it.sku for it in m.items}
    assert skus == {"A", "B"}
    assert "items" in r["subtrees"]
    # A appears in two lines, B in one → A has the higher pick frequency
    by = {it.sku: it.pick_freq for it in m.items}
    assert by["A"] > by["B"]
    assert all(it.stock > 0 for it in m.items)


def test_pick_freq_calibrated_when_master_exists():
    m = _model_with_demand_no_master()
    m.items = [Item(sku="A", pick_freq=0.0, stock=10), Item(sku="B", pick_freq=0.0, stock=10)]
    datagen.generate_missing(m)
    assert {it.sku: it.pick_freq for it in m.items}["A"] == 2.0


def test_generated_not_counted_as_real_data():
    p = Provenance("t")
    p.mark("items", Source.GENERATED)
    # generated is excluded from the % real figure, but surfaced as its own band
    assert p.confidence() == 0.0
    assert "生成・推計" in p.summary()
    p.mark("orders", Source.IMPORTED)
    assert p.confidence() > 0


def test_endpoint(tmp_path, monkeypatch):
    import whsim.project as pm
    monkeypatch.setattr(pm, "PROJECTS_DIR", tmp_path / "projects")
    c = TestClient(app)
    assert c.post("/api/projects", json={"name": "g", "template": "ecommerce_small"}).status_code == 200
    r = c.post("/api/projects/g/generate-missing")
    assert r.status_code == 200
    assert "provenance_summary" in r.json()
