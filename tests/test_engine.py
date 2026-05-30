from whsim import analytic, kpis, templates
from whsim.engine.run import run_once, run_replications


def _fast_model():
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 3600.0  # 1h keeps the test quick
    return m


def test_run_is_deterministic_for_a_seed():
    m = _fast_model()
    a = run_once(m, seed=7)
    b = run_once(m, seed=7)
    assert len(a.events) == len(b.events)
    ka = kpis.compute([a])
    kb = kpis.compute([b])
    assert ka["orders_completed"] == kb["orders_completed"]


def test_kpis_are_sane():
    m = _fast_model()
    results, heat = run_replications(m)
    k = kpis.compute(results)
    assert k["orders_completed"] >= 0
    assert 0.0 <= k["picker_utilization"] <= 1.0
    assert 0.0 <= k["packer_utilization"] <= 1.0
    assert k["walk_per_order_m"] >= 0.0
    assert heat.sum() > 0  # congestion was recorded
    assert k["bottleneck"] in {"picking", "packing"}


def test_analytic_estimate_is_in_the_same_ballpark_as_sim():
    # The closed-form M/M/c estimate doubles as a sanity oracle for the engine.
    m = _fast_model()
    est = analytic.estimate(m)
    results, _ = run_replications(m)
    sim = kpis.compute(results)
    assert abs(est["picker_utilization"] - sim["picker_utilization"]) < 0.2
