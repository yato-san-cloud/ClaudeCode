"""Round-3 coverage: design.materialize_racks edge cases, scenarios + payback,
analytic edge cases, provenance and template loading.

These exercise the never-blocks invariant on the design/analysis helpers: a
degenerate rack must not silently destroy locations, a bad scenario edit is
skipped, payback returns None when there are no savings, and the analytic oracle
copes with empty models.
"""

from __future__ import annotations

import pytest

from whsim import analytic, templates
from whsim.design import materialize_racks, synthesize_items
from whsim.engine.scenarios import (
    apply_scenario,
    default_scenarios,
    payback_months,
)
from whsim.provenance import Provenance, Source
from whsim.schema.model import Item, Scenario, WarehouseModel


# ---- design.materialize_racks edge cases -------------------------------------

def test_materialize_racks_no_storage_zone_is_noop():
    m = WarehouseModel()  # bare model: no racked storage zone
    before = [loc.id for loc in m.locations]
    out = materialize_racks(m)
    assert [loc.id for loc in out.locations] == before


def test_materialize_racks_degenerate_margin_preserves_locations():
    """A margin larger than the zone yields zero slots; the tolerant choice is to
    leave the model untouched rather than orphan every SKU."""
    m = templates.load_template_model("ecommerce_small")
    storage = next(z for z in m.layout.zones if z.id == "storage")
    storage.rack.margin = max(storage.w, storage.h) * 10  # absurd margin -> 0 slots
    n_before = len(m.locations)
    items_before = [it.default_location for it in m.items]
    materialize_racks(m)
    assert len(m.locations) == n_before  # nothing destroyed
    assert [it.default_location for it in m.items] == items_before


def test_materialize_racks_repegs_skus_and_assigns_abc():
    m = templates.load_template_model("ecommerce_small")
    materialize_racks(m)
    ids = {loc.id for loc in m.locations}
    assert m.items, "template should ship items"
    assert all(it.default_location in ids for it in m.items)
    assert {it.abc_class for it in m.items} <= {"A", "B", "C"}
    # SKUs are pegged onto the regenerated slots (slot.sku set for at least some)
    assert any(loc.sku for loc in m.locations)


def test_synthesize_items_only_fills_when_empty():
    m = templates.load_template_model("ecommerce_small")
    original = list(m.items)
    assert synthesize_items(m) is m
    assert m.items == original  # already had items: untouched

    m.items = []
    synthesize_items(m)
    assert len(m.items) == len(m.locations)
    assert all(it.sku for it in m.items)


# ---- scenarios.apply_scenario + payback --------------------------------------

def test_apply_scenario_sets_dotted_path():
    base = templates.load_template_model("ecommerce_small")
    sc = Scenario(name="peak", edits={"orders.profile.peak_factor": 2.5})
    out = apply_scenario(base, sc)
    assert out.orders.profile.peak_factor == 2.5
    assert base.orders.profile.peak_factor != 2.5  # base untouched


def test_apply_scenario_skips_bad_paths_tolerantly():
    base = templates.load_template_model("ecommerce_small")
    sc = Scenario(name="bad", edits={
        "orders.profile.peak_factor": 3.0,      # valid
        "no.such.path": 1,                       # KeyError -> skipped
        "process.stages.999.method": "agv",      # IndexError -> skipped
    })
    out = apply_scenario(base, sc)
    assert out.orders.profile.peak_factor == 3.0  # the good edit still applied


def test_apply_scenario_indexed_path():
    base = templates.load_template_model("ecommerce_small")
    pick_idx = next(i for i, s in enumerate(base.process.stages) if s.id == "pick")
    sc = Scenario(name="agv", edits={f"process.stages.{pick_idx}.method": "agv"})
    out = apply_scenario(base, sc)
    assert out.process.stages[pick_idx].method == "agv"


def test_default_scenarios_shape():
    base = templates.load_template_model("ecommerce_small")
    scs = default_scenarios(base)
    names = [s.name for s in scs]
    assert names == ["現行", "ピーク日", "AGV導入"]
    # the peak scenario scales demand; the AGV scenario edits the pick stage
    assert scs[1].edits["orders.profile.peak_factor"] == 2.5
    assert any("method" in k for k in scs[2].edits)


def test_payback_months_returns_none_without_capex():
    assert payback_months({"monthly_opex": 100}, {"monthly_opex": 50}) is None


def test_payback_months_returns_none_without_savings():
    alt = {"capex_total": 1000, "monthly_opex": 200}
    base = {"monthly_opex": 100}  # alt costs MORE to operate -> no payback
    assert payback_months(base, alt) is None


def test_payback_months_computes_from_savings():
    base = {"monthly_opex": 300}
    alt = {"capex_total": 1200, "monthly_opex": 100}  # saves 200/mo
    assert payback_months(base, alt) == pytest.approx(6.0)


def test_payback_months_falls_back_to_monthly_cost_key():
    base = {"monthly_cost": 300}
    alt = {"capex_total": 600, "monthly_cost": 100}
    assert payback_months(base, alt) == pytest.approx(3.0)


# ---- analytic edge cases ------------------------------------------------------

def test_estimate_empty_model_is_finite_and_shaped():
    est = analytic.estimate(WarehouseModel())
    assert est["method"] == "analytic_mmc"
    assert 0.0 <= est["picker_utilization"] <= 1.0
    assert est["service_time_s"] > 0
    assert est["capacity_orders_per_hr"] >= 0


def test_estimate_overloaded_flag_on_extreme_demand():
    m = templates.load_template_model("ecommerce_small")
    m.orders.profile.rate_per_hr = 100000.0  # absurd arrival rate
    m.orders.profile.peak_factor = 1.0
    est = analytic.estimate(m)
    assert est["overloaded"] is True
    assert est["picker_utilization"] == pytest.approx(1.0)
    # When overloaded the wait may be infinite -> reported as None
    assert est["pick_wait_mean_s"] is None


def test_estimate_peak_factor_increases_offered_load():
    m = templates.load_template_model("ecommerce_small")
    m.orders.outbound = []  # force the profile path
    base = analytic.estimate(m)["offered_orders_per_hr"]
    m.orders.profile.peak_factor = 3.0
    peak = analytic.estimate(m)["offered_orders_per_hr"]
    assert peak == pytest.approx(base * 3.0)


def test_estimate_uses_explicit_orders_when_present():
    m = WarehouseModel()
    from whsim.schema.model import Order, OrderLine
    m.orders.outbound = [Order(order_id=f"o{i}", lines=[OrderLine(sku="X")])
                         for i in range(10)]
    m.items = [Item(sku="X", ts_per_unit=2.0)]
    est = analytic.estimate(m)
    assert est["offered_orders_per_hr"] > 0


# ---- provenance ---------------------------------------------------------------

def test_provenance_starts_provisional_and_confidence_zero():
    p = Provenance("ecommerce_small")
    assert p.confidence() == 0.0
    assert all(v is Source.PROVISIONAL for v in p.subtrees.values())


def test_provenance_mark_increases_confidence_and_summary():
    p = Provenance("ecommerce_small")
    p.mark("items", Source.IMPORTED)
    p.mark("layout", Source.INTERVIEW)
    assert p.confidence() == pytest.approx(2 / len(p.subtrees))
    summary = p.summary()
    assert "実データ" in summary
    assert "商品マスタ" in summary  # imported items labelled in Japanese


def test_provenance_mark_unknown_subtree_ignored():
    p = Provenance("t")
    p.mark("nonexistent", Source.IMPORTED)
    assert "nonexistent" not in p.subtrees
    assert p.confidence() == 0.0


def test_provenance_from_dict_tolerates_corrupt_source():
    p = Provenance.from_dict({
        "template_id": "x",
        "subtrees": {"items": "imported", "layout": "garbage", "bogus": "imported"},
    })
    assert p.subtrees["items"] is Source.IMPORTED
    assert p.subtrees["layout"] is Source.PROVISIONAL  # corrupt -> provisional
    assert "bogus" not in p.subtrees  # unknown key dropped


def test_provenance_to_dict_roundtrip():
    p = Provenance("tid")
    p.mark("orders", Source.IMPORTED)
    d = p.to_dict()
    q = Provenance.from_dict(d)
    assert q.template_id == "tid"
    assert q.subtrees["orders"] is Source.IMPORTED
    assert q.confidence() == p.confidence()


# ---- templates ----------------------------------------------------------------

def test_list_templates_includes_ecommerce_small():
    ids = {t["template_id"] for t in templates.list_templates()}
    assert "ecommerce_small" in ids


def test_load_template_model_is_valid_and_runnable():
    m = templates.load_template_model("ecommerce_small")
    assert isinstance(m, WarehouseModel)
    assert m.items and m.locations


def test_unknown_template_raises():
    with pytest.raises(FileNotFoundError):
        templates.template_dir("no_such_template_xyz")
    with pytest.raises(FileNotFoundError):
        templates.load_template_model("no_such_template_xyz")
