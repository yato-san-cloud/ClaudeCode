from whsim import analytic, kpis, templates
from whsim.engine.run import representative_day, run_once, run_replications
from whsim.schema.model import Order, OrderLine


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
    #
    # The oracle measures travel as MANHATTAN (`analytic.estimate` ->
    # `engine.routing.manhattan`), i.e. straight through the racking, while the
    # DES now routes around it (`engine.graph` registers every drawn rack run as
    # an obstacle). So the oracle is a deliberate LOWER bound on picker
    # utilisation, not a two-sided match: on ecommerce_small the aisle detour adds
    # ~50% to walk distance, worth ~0.2 of utilisation. Both facts are asserted —
    # the sign (oracle never above the sim) and a loosened magnitude — so this
    # still catches an engine that has gone wrong in either direction.
    m = _fast_model()
    est = analytic.estimate(m)
    results, _ = run_replications(m)
    sim = kpis.compute(results)
    assert est["picker_utilization"] <= sim["picker_utilization"] + 0.05
    assert abs(est["picker_utilization"] - sim["picker_utilization"]) < 0.3


def test_multiday_imported_demand_is_simulated():
    # Regression: the real-calendar ETL anchors arrival_s to a Monday-00:00 offset,
    # so a multi-day import pushes every order past the default 8h window. The
    # engine must isolate a representative day (re-based to t=0) and actually
    # process those orders — not replay an empty pre-dawn window (orders_arrived 0).
    m = _fast_model()
    m.orders.profile.rate_per_hr = 0.0  # demand comes only from the explicit orders
    sku = m.items[0].sku
    orders = []
    for day in range(3):  # 3 calendar days, activity at 09:00 and 14:00 each
        for h in (9, 14):
            t = float(day * 86400 + h * 3600)
            orders.append(Order(order_id=f"D{day}H{h}", arrival_s=t,
                                lines=[OrderLine(sku=sku, qty=1)]))
    m.orders.outbound = orders

    eff = representative_day(m)
    assert len(eff.orders.outbound) == 2                  # one day's worth
    assert min(o.arrival_s for o in eff.orders.outbound) == 0.0  # re-based to t=0
    assert eff.simulation.duration_s >= 5 * 3600.0        # active span + drain tail

    k = kpis.compute(run_replications(m)[0])
    assert k["orders_arrived"] > 0 and k["orders_completed"] > 0
