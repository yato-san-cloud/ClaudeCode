"""Regression tests from the engine design+correctness review.

Each test targets a specific defect found during review; it should fail on the
pre-fix code and pass after the minimal fix.
"""

from __future__ import annotations

from whsim import analytic, templates
from whsim.engine.scenarios import apply_scenario
from whsim.schema.model import Scenario


def _profile_model():
    """A profile-driven model (no explicit outbound) so peak_factor matters."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 3600.0
    m.orders.outbound = []
    return m


# --------------------------------------------------------------------------- #
# Bug 1: analytic oracle ignored orders.profile.peak_factor, while the engine
# scales the profile arrival rate by it (engine.processes.order_source). The
# closed-form estimate must scale arrivals the same way, or it under-states
# load on peak scenarios and stops being a faithful sanity oracle.
# --------------------------------------------------------------------------- #
def test_analytic_estimate_honors_peak_factor():
    base = _profile_model()
    base.orders.profile.peak_factor = 1.0
    peak = _profile_model()
    peak.orders.profile.peak_factor = 2.5

    est_base = analytic.estimate(base)
    est_peak = analytic.estimate(peak)

    # Offered demand must scale exactly with peak_factor.
    assert est_peak["offered_orders_per_hr"] == (
        est_base["offered_orders_per_hr"] * 2.5
    )
    # And the resulting utilisation must rise (it would be identical if the
    # oracle ignored peak_factor, as it did before the fix).
    assert est_peak["picker_utilization"] > est_base["picker_utilization"]


# --------------------------------------------------------------------------- #
# Bug 2: apply_scenario advertises tolerance ("skip edits that don't apply")
# but a dotted path descending into a scalar raised TypeError, which was NOT
# caught -- crashing the whole what-if comparison and violating the project's
# "never blocks on messy data / always runnable" invariant.
# --------------------------------------------------------------------------- #
def test_apply_scenario_is_tolerant_of_bad_paths():
    m = templates.load_template_model("ecommerce_small")
    # Descends through a float (peak_factor) into a child key -> TypeError.
    bad = Scenario(name="bad", edits={"orders.profile.peak_factor.nope": 1})
    out = apply_scenario(m, bad)  # must not raise
    # The bad edit is skipped; the model is unchanged and still valid.
    assert out.orders.profile.peak_factor == m.orders.profile.peak_factor


def test_apply_scenario_skips_only_bad_edit_applies_good_one():
    m = templates.load_template_model("ecommerce_small")
    s = Scenario(
        name="mix",
        edits={
            "orders.profile.peak_factor.nope": 1,   # bad -> skipped
            "orders.profile.peak_factor": 3.0,      # good -> applied
        },
    )
    out = apply_scenario(m, s)
    assert out.orders.profile.peak_factor == 3.0
