"""採点表レール backend — build_scorecard composition + the /scorecard endpoint.

Asserts the SCORECARD_CONTRACT.md guarantees: always 6 rows (素モデル /
レイアウト無し / 実データ入り), the 連鎖 ✓/⚠ check, the run block presence, and
'never blocks' (a bare model never raises and the endpoint is always 200)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from whsim import scorecard
from whsim.schema.model import (
    Item,
    Order,
    OrderLine,
    ShelfArea,
    WarehouseModel,
    Zone,
)
from whsim.web.app import app

client = TestClient(app)

ROW_IDS = {"verdict", "headcount", "cost", "productivity", "tsubo", "chain"}


# ---- model builders --------------------------------------------------------

def _bare_model() -> WarehouseModel:
    """Template-grade bare model: default stages/profile, no layout, no orders."""
    return WarehouseModel()


def _no_layout_model() -> WarehouseModel:
    """Has real outbound demand + items but NO storage zones/shelves (so the
    layout-driven rows like 坪数 stay '—' while demand-driven ones light up)."""
    m = WarehouseModel()
    m.layout.zones = []
    m.items = [Item(sku="A1", abc_class="A", case_qty=10, stock=0),
               Item(sku="B2", abc_class="B", case_qty=5, stock=0)]
    m.orders.outbound = [
        Order(order_id=f"o{i}", arrival_s=float(i * 60),
              lines=[OrderLine(sku="A1", qty=2), OrderLine(sku="B2", qty=1)])
        for i in range(20)
    ]
    return m


def _real_model() -> WarehouseModel:
    """Full real-data model: orders + a storage zone with shelves + items, so all
    six rows carry numbers (verdict/headcount/cost/productivity/tsubo) and the
    chain is satisfiable."""
    m = WarehouseModel()
    m.items = [Item(sku="A1", abc_class="A", case_qty=10, stock=500),
               Item(sku="B2", abc_class="B", case_qty=5, stock=300),
               Item(sku="C3", abc_class="C", case_qty=1, stock=80)]
    m.orders.outbound = [
        Order(order_id=f"o{i}", arrival_s=float(i * 120),
              lines=[OrderLine(sku="A1", qty=3), OrderLine(sku="B2", qty=2),
                     OrderLine(sku="C3", qty=1)])
        for i in range(40)
    ]
    # A storage zone (matches the default putaway/pick stage zone="storage"... but
    # default stages bind to receiving/storage/picking/packing/shipping ids that
    # don't exist as zones in a bare model). Build zones to satisfy the chain.
    m.layout.zones = [
        Zone(id="receiving", type="receiving", x=0, y=0, w=10, h=8),
        Zone(id="storage", type="storage", x=12, y=0, w=30, h=20,
             shelves=[ShelfArea(id="s1", name="A-01", x=14, y=2, w=10, h=2,
                                rack_type="medium")]),
        Zone(id="picking", type="picking", x=44, y=0, w=10, h=8),
        Zone(id="packing", type="packing", x=56, y=0, w=8, h=6),
        Zone(id="shipping", type="shipping", x=66, y=0, w=8, h=6),
    ]
    return m


# ---- always 6 rows ---------------------------------------------------------

def test_bare_model_has_six_rows():
    sc = scorecard.build_scorecard(_bare_model())
    rows = sc["rows"]
    assert len(rows) == 6
    assert {r["id"] for r in rows} == ROW_IDS
    # every row has the contract keys
    for r in rows:
        assert {"id", "label", "value", "tone", "view"} <= set(r)
        assert r["tone"] in {"ok", "warn", "bad", "neutral"}


def test_no_layout_model_has_six_rows():
    sc = scorecard.build_scorecard(_no_layout_model())
    rows = {r["id"]: r for r in sc["rows"]}
    assert set(rows) == ROW_IDS
    # No storage ZONE → has_layout is False, but storage sizing is DEMAND-driven
    # (avg出荷 × 在庫日数), so 坪数/verdict still light up from the orders. The
    # pickrate falls back to the whole-floor geometry. All 6 rows present either
    # way (the never-blocks guarantee).
    assert sc["has_layout"] is False
    assert rows["verdict"]["value"] != "—"  # demand present → judged


def test_dash_rows_when_no_data():
    # A truly empty model (default profile cleared, no items): every data-driven
    # row falls back to the dash placeholder rather than raising. This pins the
    # never-blocks degrade path for ALL data rows at once.
    m = WarehouseModel()
    m.orders.profile.rate_per_hr = 0.0  # kill the fallback demand
    sc = scorecard.build_scorecard(m)
    rows = {r["id"]: r for r in sc["rows"]}
    for rid in ("verdict", "cost", "headcount", "tsubo"):
        assert rows[rid]["value"] == "—", rid
        assert rows[rid]["tone"] == "neutral"


def test_bare_template_costs_from_default_profile():
    # The bare template model carries a default demand PROFILE (rate_per_hr>0), so
    # 判定/人員/原価/生産性 light up even with no uploaded orders; only the
    # item-driven 坪数 stays a dash.
    sc = scorecard.build_scorecard(_bare_model())
    rows = {r["id"]: r for r in sc["rows"]}
    assert rows["verdict"]["value"] != "—"
    assert rows["cost"]["value"].startswith("¥")
    assert rows["tsubo"]["value"] == "—"  # no items → no storage demand


def test_real_model_has_six_rows_with_values():
    sc = scorecard.build_scorecard(_real_model())
    rows = {r["id"]: r for r in sc["rows"]}
    assert set(rows) == ROW_IDS
    assert sc["has_layout"] is True
    # Demand + layout present → these rows carry real (non-dash) values.
    assert rows["verdict"]["value"] != "—"
    assert rows["cost"]["value"].startswith("¥")
    assert rows["tsubo"]["value"] != "—"
    assert "num" in rows["headcount"]
    assert isinstance(rows["headcount"]["num"], int)
    assert "per_order" in rows["cost"]
    assert rows["productivity"]["unit"] == "行/h"


# ---- chain ✓ / ⚠ -----------------------------------------------------------

def test_chain_ok_when_all_stages_bound():
    sc = scorecard.build_scorecard(_real_model())
    chain = next(r for r in sc["rows"] if r["id"] == "chain")
    assert chain["tone"] == "ok"
    assert chain["value"] == "✓ 連鎖OK"


def test_chain_warn_when_pick_zone_missing():
    m = _real_model()
    # Unbind the pick stage → one chain problem.
    pick = next(s for s in m.process.stages if s.id == "pick")
    pick.zone = None
    sc = scorecard.build_scorecard(m)
    chain = next(r for r in sc["rows"] if r["id"] == "chain")
    assert chain["tone"] == "warn"
    assert chain["value"] == "⚠ 1件"
    assert chain["sub"]  # first offending stage label present


def test_chain_warn_counts_and_first_label_on_bare_model():
    # Bare model: default stages bind to zone ids that don't exist (no zones), so
    # every stage is a problem; sub names the FIRST stage (受入/入荷).
    sc = scorecard.build_scorecard(_bare_model())
    chain = next(r for r in sc["rows"] if r["id"] == "chain")
    assert chain["tone"] == "warn"
    assert chain["value"].startswith("⚠")


def test_chain_mismatch_counts_as_problem():
    m = _real_model()
    pick = next(s for s in m.process.stages if s.id == "pick")
    pick.zone = "packing"  # pick allows [storage, picking], not packing
    sc = scorecard.build_scorecard(m)
    chain = next(r for r in sc["rows"] if r["id"] == "chain")
    assert chain["tone"] == "warn"


def test_chain_contract_matches_designer_constants():
    # The Python contract must match the designer's STAGE_ZONE_TYPES verbatim.
    assert scorecard.STAGE_ZONE_TYPES == {
        "receive": ["receiving"],
        "putaway": ["storage", "staging"],
        "pick": ["storage", "picking"],
        "pack": ["packing"],
        "ship": ["shipping", "staging"],
    }


# ---- run block -------------------------------------------------------------

def test_run_absent():
    sc = scorecard.build_scorecard(_real_model(), run_metrics=None)
    assert sc["run"] == {"exists": False}


def test_run_present_populates_headline():
    metrics = {
        "verdict": "対応可能 — ピッキング工程の稼働率 4% で余力あり。",
        "total_cost_per_order": 516.4,
        "headcount": 9.0,
        "throughput_per_hr": 7.3,
        "measured_productivity": {"ピッキング": 69.8, "梱包": 90.0},
    }
    sc = scorecard.build_scorecard(_real_model(), run_metrics=metrics)
    run = sc["run"]
    assert run["exists"] is True
    assert run["verdict"].startswith("対応可能")
    assert run["cost_per_order"] == 516.4
    assert run["headcount"] == 9.0
    assert run["throughput_per_hr"] == 7.3
    assert run["measured_productivity"] == {"ピッキング": 69.8, "梱包": 90.0}


# ---- never blocks ----------------------------------------------------------

def test_build_scorecard_never_raises_on_empty_model():
    # The whole point: a bare/empty model must produce a valid payload, no raise.
    sc = scorecard.build_scorecard(WarehouseModel())
    assert sc["source"] == "analytic"
    assert len(sc["rows"]) == 6


# ---- endpoint --------------------------------------------------------------

def test_scorecard_endpoint_bare_project():
    client.post("/api/projects", json={"name": "sc_bare", "template": "ecommerce_small"})
    try:
        r = client.get("/api/projects/sc_bare/scorecard")
        assert r.status_code == 200, r.text
        body = r.json()
        assert {row["id"] for row in body["rows"]} == ROW_IDS
        assert body["run"] == {"exists": False}
    finally:
        client.delete("/api/projects/sc_bare")


def test_scorecard_endpoint_with_run(monkeypatch):
    import whsim.scorecard as sc_mod
    client.post("/api/projects", json={"name": "sc_run", "template": "ecommerce_small"})
    try:
        captured = {}
        real = sc_mod.build_scorecard

        def spy(model, run_metrics=None):
            captured["run_metrics"] = run_metrics
            return real(model, run_metrics)

        monkeypatch.setattr(sc_mod, "build_scorecard", spy)
        # Place a kpis.json under the latest run dir so the endpoint reads it.
        from whsim.project import Project
        proj = Project.open("sc_run")
        rd = proj.new_run_dir()
        (rd / "kpis.json").write_text(
            '{"verdict": "ok-verdict", "headcount": 5.0, "throughput_per_hr": 3.1}',
            encoding="utf-8")
        r = client.get("/api/projects/sc_run/scorecard")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["run"]["exists"] is True
        assert body["run"]["verdict"] == "ok-verdict"
        assert captured["run_metrics"]["headcount"] == 5.0
    finally:
        client.delete("/api/projects/sc_run")
