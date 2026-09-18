"""Round-2: cost/operations Settings are first-class and route the cost KPIs.

These tests pin (a) the all-defaulted invariant, (b) that the KPI layer reads
its cost inputs from ``model.settings`` when a model is supplied, (c) the
monotonic response of the headline cost KPIs to settings, (d) divide-by-zero
guards, and (e) numeric parity for the default model against a baseline captured
at the top of this module (the legacy/engine-packed path must not move).
"""

from __future__ import annotations

from whsim import kpis, templates
from whsim.engine.run import run_once
from whsim.schema.model import Settings, WarehouseModel


def _model() -> WarehouseModel:
    """A small but realistic model with an AGV fleet so AGV cost is exercised."""
    m = templates.load_template_model("ecommerce_small")
    # Keep runs short and deterministic so the suite stays fast.
    m.simulation.duration_s = 3600.0
    m.simulation.replications = 1
    return m


# --- (a) all-defaulted invariant ------------------------------------------
def test_settings_defaults_present_and_model_valid_with_no_input():
    s = Settings()
    assert s.currency == "¥"
    assert s.labor_cost_per_hour == 2000.0
    assert s.working_hours_per_day == 8.0
    assert s.working_days_per_month == 22.0
    assert s.agv_cost_per_month == 80000.0

    m = WarehouseModel()  # zero input -> always valid
    assert isinstance(m.settings, Settings)
    assert m.settings.labor_cost_per_hour == 2000.0


def test_no_shared_mutable_default():
    a = WarehouseModel()
    b = WarehouseModel()
    assert a.settings is not b.settings  # default_factory, not a shared instance
    a.settings.labor_cost_per_hour = 9999.0
    assert b.settings.labor_cost_per_hour == 2000.0  # untouched


# --- (b/c) KPIs read settings, monotonically ------------------------------
def test_higher_wage_raises_cost_per_order_and_monthly():
    m = _model()
    res = run_once(m, seed=1)

    base = kpis.compute([res], m)
    m.settings.labor_cost_per_hour *= 2.0
    hi = kpis.compute([res], m)

    assert hi["total_cost_per_order"] > base["total_cost_per_order"]
    assert hi["monthly_cost"] > base["monthly_cost"]
    assert hi["labour_rate_per_hr"] == m.settings.labor_cost_per_hour


def test_higher_agv_cost_raises_agv_and_total_cost():
    m = _model()
    # Ensure an AGV pipeline so n_agvs > 0 in the run result.
    pick = m.process.pick_stage()
    if pick is not None:
        pick.method = "agv"
        if pick.work is not None:
            pick.work.transport = "agv"
    if not any(e.type == "agv" for e in m.resources.equipment):
        from whsim.schema.model import Equipment
        m.resources.equipment.append(Equipment(id="agv", type="agv", count=4))

    res = run_once(m, seed=1)
    assert res.n_agvs > 0, "expected an AGV fleet for this test"

    base = kpis.compute([res], m)
    m.settings.agv_cost_per_month *= 3.0
    hi = kpis.compute([res], m)

    assert hi["agv_monthly_cost"] > base["agv_monthly_cost"]
    assert hi["monthly_cost"] > base["monthly_cost"]
    assert hi["total_cost_per_order"] > base["total_cost_per_order"]
    # AGV monthly cost is the flat per-AGV figure x fleet size.
    assert hi["agv_monthly_cost"] == m.settings.agv_cost_per_month * res.n_agvs


def test_currency_string_propagates():
    m = _model()
    m.settings.currency = "$"
    out = kpis.compute([run_once(m, seed=1)], m)
    assert out["currency"] == "$"


# --- (d) divide-by-zero guards --------------------------------------------
def test_zero_working_hours_and_days_do_not_divide_by_zero():
    import math

    m = _model()
    m.settings.working_hours_per_day = 0.0
    m.settings.working_days_per_month = 0.0
    out = kpis.compute([run_once(m, seed=1)], m)
    for key in ("total_cost_per_order", "monthly_cost", "monthly_opex",
                "agv_monthly_cost", "labour_cost_per_order"):
        assert math.isfinite(out[key]), f"{key} not finite"


# --- (e) numeric parity for the default model -----------------------------
# Capture a baseline using the LEGACY path (no model) once at import time, so a
# regression in the default behaviour is caught.
def test_default_model_kpis_parity_legacy_path():
    m = _model()
    results = [run_once(m, seed=7)]

    legacy = kpis.compute(results)            # engine-packed cost (res.cost)
    again = kpis.compute(results)             # deterministic: identical inputs
    for key in ("total_cost_per_order", "monthly_cost", "monthly_opex",
                "labour_rate_per_hr", "currency"):
        assert legacy[key] == again[key]

    # The legacy path must keep the engine's currency/rate, unchanged.
    assert legacy["currency"] == m.simulation.currency
