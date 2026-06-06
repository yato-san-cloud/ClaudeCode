"""物量BI: DuckDB base-volume aggregation + endpoint.

Pallet/case derivation is client-side (provisional 仮値), so the backend only
owns the honest base aggregation tested here."""

from fastapi.testclient import TestClient

from whsim import bi
from whsim.schema.model import Item, Order, OrderLine, Orders, WarehouseModel
from whsim.templates import load_template_model
from whsim.web.app import app


def test_base_volumes_from_explicit_orders():
    m = WarehouseModel()
    m.items = [Item(sku="A", case_qty=10), Item(sku="B", case_qty=20)]
    m.orders = Orders(outbound=[
        Order(order_id="O1", lines=[OrderLine(sku="A", qty=20), OrderLine(sku="B", qty=20)]),
        Order(order_id="O2", lines=[OrderLine(sku="A", qty=10)]),
    ])
    v = bi.base_volumes(m)
    assert v["out_orders"] == 2
    assert v["out_lines"] == 3
    assert v["out_pieces"] == 50
    assert "DuckDB" in v["engine"]
    assert v["out_estimated"] is False
    # cases = 20/10 + 20/20 + 10/10 = 2 + 1 + 1 = 4
    assert abs(v["out_cases"] - 4.0) < 0.01


def test_profile_fallback_when_no_outbound():
    m = load_template_model("ecommerce_small")  # profile-driven, outbound empty
    v = bi.base_volumes(m)
    assert v["out_estimated"] is True
    assert v["out_lines"] > 0 and v["out_orders"] > 0
    assert v["in_cases"] > 0          # inbound estimated from outbound
    assert v["in_estimated"] is True
    assert v["avg_case_qty"] > 1      # from the item master (case_qty=12)


def test_endpoint(tmp_path, monkeypatch):
    import whsim.project as pm
    monkeypatch.setattr(pm, "PROJECTS_DIR", tmp_path / "projects")
    c = TestClient(app)
    c.post("/api/projects", json={"name": "bi", "template": "ecommerce_small"})
    r = c.get("/api/projects/bi/bi/volumes")
    assert r.status_code == 200
    j = r.json()
    assert "out_lines" in j and "in_cases" in j and "DuckDB" in j["engine"]
