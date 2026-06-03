"""本格DES validation for the 仮置き(staging) buffer + dedicated packer agents.

These are invariants a serious simulator must hold, per the benchmarking spec:
Little's law, conservation (no lost/duplicated orders), back-pressure capping WIP
at the buffer capacity, determinism, and zero behaviour change when disabled."""


from whsim import kpis
from whsim.engine.run import run_replications
from whsim.templates import load_template_model


def _run(staging=0, pack_time=None, rate=None, dur=3600, reps=1):
    m = load_template_model("ecommerce_small")
    m.process.staging_capacity = staging
    if pack_time is not None:
        m.process.pack_time_s = pack_time
    if rate is not None:
        m.orders.outbound = []          # drive from the profile
        m.orders.profile.rate_per_hr = rate
    m.simulation.replications = reps
    m.simulation.duration_s = dur
    res, _ = run_replications(m)
    return res, kpis.compute(res, m)


def test_disabled_is_legacy_no_staging():
    """staging_capacity=0 keeps the legacy inline-pack path: no packer agents,
    no staging events — existing behaviour is unchanged."""
    res, k = _run(staging=0)
    assert res[0].packers == []
    assert not any(e["event"].startswith("staging_") for e in res[0].events)
    assert k["orders_completed"] > 0


def test_dedicated_packers_when_enabled():
    res, k = _run(staging=20)
    assert len(res[0].packers) == res[0].n_packers >= 1
    assert any(e["event"] == "staging_put" for e in res[0].events)
    assert k["staging_capacity"] == 20


def test_littles_law_staging():
    """L = λ·W on the staging buffer (time-avg WIP == throughput × dwell)."""
    res, k = _run(staging=20)
    gets = [e for e in res[0].events if e["event"] == "staging_get"]
    lam = len(gets) / res[0].duration_s        # totes leaving staging per second
    little = lam * k["staging_dwell_mean_s"]
    assert abs(k["wip_avg"] - little) <= 0.05 * max(k["wip_avg"], little, 1e-6) + 0.02


def test_conservation_no_loss_or_dup():
    """No order is lost or completed twice; in-flight is bounded by the pipeline."""
    res, k = _run(staging=20)
    ids = [e["order_id"] for e in res[0].events if e["event"] == "order_complete"]
    assert len(ids) == len(set(ids))                       # no duplicates
    assert k["orders_completed"] <= k["orders_arrived"]    # nothing invented
    in_flight = k["orders_arrived"] - k["orders_completed"]
    assert 0 <= in_flight <= res[0].n_pickers + res[0].n_packers + k["staging_capacity"] + 5


def test_overload_caps_wip_and_blocks():
    """Under overload, WIP is capped at the buffer capacity and the picker is
    blocked (back-pressure) — the M/M/c/K behaviour, not unbounded growth."""
    cap = 5
    res, k = _run(staging=cap, pack_time=120.0, rate=600)
    assert k["wip_max"] <= cap
    assert k["staging_block_time_s"] > 0
    assert k["packer_utilization"] > 0.85          # packers are the constraint


def test_deterministic_with_staging():
    res1, k1 = _run(staging=20)
    res2, k2 = _run(staging=20)
    assert k1["orders_completed"] == k2["orders_completed"]
    assert abs(k1["wip_avg"] - k2["wip_avg"]) < 1e-9
