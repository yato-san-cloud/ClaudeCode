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


# --- ①DuckDB analysis views -------------------------------------------------

def test_analysis_views_empty_is_safe():
    m = WarehouseModel()  # no outbound at all
    v = bi.analysis_views(m)
    assert v["has_data"] is False
    assert v["abc"] == [] and v["by_weekday"] == []
    assert v["daily"] == [] and v["hourly"] == []


def test_analysis_views_abc_and_weekday():
    m = WarehouseModel()
    m.items = [Item(sku="A", name="alpha", case_qty=10), Item(sku="B", case_qty=10)]
    day = 86400.0
    m.orders = Orders(outbound=[
        # A dominates the qty share -> rank A; spread across two weekdays.
        Order(order_id="O1", arrival_s=0.0,
              lines=[OrderLine(sku="A", qty=90), OrderLine(sku="B", qty=5)]),
        Order(order_id="O2", arrival_s=day,
              lines=[OrderLine(sku="A", qty=80), OrderLine(sku="B", qty=5)]),
    ])
    v = bi.analysis_views(m)
    assert v["has_data"] is True
    skus = {r["sku"]: r for r in v["abc"]}
    assert skus["A"]["rank"] == "A"          # top share => class A
    assert skus["A"]["name"] == "alpha"      # friendly name from item master
    assert len(v["by_weekday"]) == 2         # two distinct synthetic days
    assert v["daily"]                        # span >= 1 day -> daily series present


# --- ②仮値→モデル保存 (provenance=generated) ------------------------------

def test_derive_volumes_is_pure_and_clamps():
    m = WarehouseModel()
    m.items = [Item(sku="A", case_qty=10)]
    m.orders = Orders(outbound=[
        Order(order_id="O1", lines=[OrderLine(sku="A", qty=400)]),  # 40 cases
    ])
    r = bi.derive_volumes(m, {"cases_per_pallet": 40, "pallet_prod": 20,
                              "peak_factor": 2})
    assert r["derived"]["out_pallets"] == 1.0      # 40 cases / 40 per pallet
    assert r["inputs"]["peak_factor"] == 2.0
    # bad/zero inputs fall back to defaults, never divide-by-zero
    r2 = bi.derive_volumes(m, {"cases_per_pallet": 0, "pallet_prod": "x"})
    assert r2["inputs"]["cases_per_pallet"] > 0
    assert r2["inputs"]["pallet_prod"] > 0


def test_apply_endpoint_saves_and_marks_generated(tmp_path, monkeypatch):
    import whsim.project as pm
    monkeypatch.setattr(pm, "PROJECTS_DIR", tmp_path / "projects")
    c = TestClient(app)
    c.post("/api/projects", json={"name": "bi2", "template": "ecommerce_small"})
    r = c.post("/api/projects/bi2/bi/apply",
               json={"cases_per_pallet": 40, "pallet_prod": 20})
    assert r.status_code == 200
    j = r.json()
    assert j["saved_to"] == "bi.json"
    assert "derived" in j["saved"] and "base" in j["saved"]
    assert "生成・推計" in j["provenance_summary"]   # orders marked GENERATED

    # Persisted: a second analysis call still works, and bi.json is readable.
    proj = pm.Project.open("bi2")
    assert bi.load_bi_config(proj)["derived"]
    # GENERATED is excluded from the "real data" confidence figure.
    assert proj.load_provenance().subtrees["orders"].value == "generated"
