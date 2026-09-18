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


# --- ①b クロスタブ (true cross-filtering) -----------------------------------

def test_xtab_empty_is_safe():
    m = WarehouseModel()  # no outbound at all
    v = bi.analysis_views(m)
    assert v["has_data"] is False
    assert v["xtab"] == []
    # facet domains are still present so the client can render empty axes
    assert v["xtab_ranks"] == ["A", "B", "C"]
    assert len(v["xtab_weekdays"]) == 7


def test_xtab_cells_ranks_and_reconciliation():
    m = WarehouseModel()
    m.items = [Item(sku="A", name="alpha", case_qty=10), Item(sku="B", case_qty=10)]
    day = 86400.0
    hour = 3600.0
    m.orders = Orders(outbound=[
        # A dominates qty -> rank A; B small -> rank B/C. Two weekdays, two hours.
        Order(order_id="O1", arrival_s=2 * hour,            # weekday 0, hour 2
              lines=[OrderLine(sku="A", qty=90), OrderLine(sku="B", qty=5)]),
        Order(order_id="O2", arrival_s=day + 5 * hour,      # weekday 1, hour 5
              lines=[OrderLine(sku="A", qty=80), OrderLine(sku="B", qty=5)]),
    ])
    v = bi.analysis_views(m)
    xt = v["xtab"]
    assert xt, "xtab should be populated"

    # Every cell has the documented shape.
    for cell in xt:
        assert set(cell) == {"rank", "weekday", "hour", "lines", "qty", "orders"}
        assert 0 <= cell["weekday"] <= 6
        assert 0 <= cell["hour"] <= 23

    # Ranks in xtab match the ABC ranks exactly (consistent ranking logic).
    abc_rank = {r["sku"]: r["rank"] for r in v["abc"]}
    assert abc_rank["A"] == "A"
    xtab_ranks = {c["rank"] for c in xt}
    assert xtab_ranks <= set(abc_rank.values())

    # Expected cells: A appears in (wd0,h2) and (wd1,h5); B alongside it.
    cells = {(c["rank"], c["weekday"], c["hour"]): c for c in xt}
    a_wd0 = cells[("A", 0, 2)]
    assert a_wd0["qty"] == 90.0 and a_wd0["lines"] == 1 and a_wd0["orders"] == 1

    # Reconciliation (4a): summing xtab over weekday+hour per rank == ABC totals.
    abc_qty_by_rank = {}
    for r in v["abc"]:
        abc_qty_by_rank[r["rank"]] = abc_qty_by_rank.get(r["rank"], 0.0) + r["qty"]
    xtab_qty_by_rank = {}
    for c in xt:
        xtab_qty_by_rank[c["rank"]] = xtab_qty_by_rank.get(c["rank"], 0.0) + c["qty"]
    assert xtab_qty_by_rank == {k: v for k, v in abc_qty_by_rank.items()}

    # Reconciliation (4b): summing xtab over rank+hour per weekday == by_weekday.
    wd_jp = v["xtab_weekdays"]
    by_wd_qty = {r["weekday"]: r["qty"] for r in v["by_weekday"]}
    xtab_qty_by_wd = {}
    for c in xt:
        label = wd_jp[c["weekday"]]
        xtab_qty_by_wd[label] = xtab_qty_by_wd.get(label, 0.0) + c["qty"]
    for label, q in xtab_qty_by_wd.items():
        assert abs(q - by_wd_qty[label]) < 1e-6

    # Lines also reconcile against the overall line total.
    total_lines = sum(c["lines"] for c in xt)
    assert total_lines == sum(r["lines"] for r in v["by_weekday"])


# --- ①c per-SKU × weekday breakdown (re-rankable ABC Pareto) ----------------

def test_xtab_sku_empty_is_safe():
    m = WarehouseModel()  # no outbound at all
    v = bi.analysis_views(m)
    assert v["has_data"] is False
    assert v["xtab_sku"] == []


def test_xtab_sku_cells_and_reconciliation():
    m = WarehouseModel()
    m.items = [Item(sku="A", name="alpha", case_qty=10), Item(sku="B", case_qty=10)]
    day = 86400.0
    hour = 3600.0
    m.orders = Orders(outbound=[
        Order(order_id="O1", arrival_s=2 * hour,            # weekday 0, hour 2
              lines=[OrderLine(sku="A", qty=90), OrderLine(sku="B", qty=5)]),
        Order(order_id="O2", arrival_s=day + 5 * hour,      # weekday 1, hour 5
              lines=[OrderLine(sku="A", qty=80), OrderLine(sku="B", qty=5)]),
    ])
    v = bi.analysis_views(m)
    xs = v["xtab_sku"]
    assert xs, "xtab_sku should be populated"

    # Every cell has the documented shape.
    for cell in xs:
        assert set(cell) == {"sku", "weekday", "qty", "lines"}
        assert 0 <= cell["weekday"] <= 6

    # Cells exist ONLY for SKUs that appear in abc[] (the top_n set).
    abc_skus = {r["sku"] for r in v["abc"]}
    assert {c["sku"] for c in xs} <= abc_skus

    # Expected cells: A appears in weekday 0 (qty 90) and weekday 1 (qty 80).
    cells = {(c["sku"], c["weekday"]): c for c in xs}
    assert cells[("A", 0)]["qty"] == 90.0 and cells[("A", 0)]["lines"] == 1
    assert cells[("A", 1)]["qty"] == 80.0 and cells[("A", 1)]["lines"] == 1

    # Reconciliation: summing xtab_sku over weekday per sku == abc qty per sku.
    abc_qty = {r["sku"]: r["qty"] for r in v["abc"]}
    sku_qty = {}
    for c in xs:
        sku_qty[c["sku"]] = sku_qty.get(c["sku"], 0.0) + c["qty"]
    for sku, q in sku_qty.items():
        assert abs(q - abc_qty[sku]) < 1e-6


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


# --- ③仮値→タイムチャート読み戻し (staffing.volumes_from_bi) -----------------

def test_volumes_from_bi_maps_and_scales():
    from whsim.analysis import staffing
    cfg = {"inputs": {"peak_factor": 2.0},
           "base": {"out_lines": 100, "out_orders": 40, "in_cases": 50, "in_lines": 50},
           "derived": {"in_pallets": 12}}
    v = staffing.volumes_from_bi(cfg)
    assert v["格納"] == 24.0            # in_pallets 12 × peak 2
    assert v["ピッキング"] == 200.0     # out_lines 100 × peak 2
    # round-trips into a timetable scenario payload
    sc = staffing.scenario_from_volumes(v)
    assert "processes" in sc and "productivity" in sc


def test_volumes_from_bi_empty_is_none():
    from whsim.analysis import staffing
    assert staffing.volumes_from_bi({}) is None
    assert staffing.volumes_from_bi({"base": {}, "derived": {}}) is None


def test_timetable_from_bi_endpoint(tmp_path, monkeypatch):
    import whsim.project as pm
    monkeypatch.setattr(pm, "PROJECTS_DIR", tmp_path / "projects")
    c = TestClient(app)
    c.post("/api/projects", json={"name": "tb_rb", "template": "ecommerce_small"})
    # After applying a BI derivation, the saved 仮値 read back into a scenario.
    # (the not-yet-applied → available:False path is covered by
    #  test_volumes_from_bi_empty_is_none, avoiding project-dir persistence flake.)
    c.post("/api/projects/tb_rb/bi/apply", json={"cases_per_pallet": 40, "pallet_prod": 20})
    r = c.get("/api/projects/tb_rb/timetable/from-bi").json()
    assert r["available"] is True and "scenario" in r and "volumes" in r
