"""信頼区間と推奨レプリケーション数 (confidence intervals) over the Monte-Carlo run.

The DES already keeps the per-replication spread; these tests pin the NEW,
purely-additive 95% t-CI layer: the hand-checkable CI math, the never-blocks
single-run behaviour (no interval), the additive payload shape, and the CI
flowing into the analysis dashboard payload and the scorecard run block.
"""

from __future__ import annotations

import math

from whsim import analytic, kpis, templates
from whsim.engine.run import run_once, run_replications
from whsim.web.routes._common import _analysis_payload


def _fast_model():
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 600.0  # keep the DES quick
    return m


def test_kpis_confidence_interval_math_matches_hand_calc():
    """mean ± t·(s/√n) and n_rec=ceil((t·s/(rel_err·mean))²) — checked by hand,
    scipy-free, against a symmetric 5-sample set with a known mean/stdev."""
    per = [{"throughput_per_hr": v, "completion_rate": 1.0}
           for v in (80.0, 90.0, 100.0, 110.0, 120.0)]
    ci = kpis._confidence_intervals(per)  # default rel_err = 0.05

    assert ci["n"] == 5
    assert ci["confidence"] == 0.95
    assert ci["rel_err_target"] == 0.05

    tp = ci["metrics"]["throughput_per_hr"]
    # mean=100, sample stdev=√250=15.8114, t(df=4)=2.776 → half=t·s/√5≈19.6293.
    assert tp["mean"] == 100.0
    assert math.isclose(tp["std"], 15.8113883, rel_tol=0, abs_tol=1e-4)
    assert math.isclose(tp["half_width"], 19.6292843, rel_tol=0, abs_tol=1e-3)
    assert tp["n"] == 5
    # n_rec = ceil((2.776·15.8114 / (0.05·100))²) = ceil(77.06) = 78.
    assert tp["n_recommended"] == 78

    # Zero-spread metric: half-width 0, recommendation collapses to n (already tight).
    cr = ci["metrics"]["completion_rate"]
    assert cr["half_width"] == 0.0
    assert cr["n_recommended"] == 5


def test_kpis_ci_absent_for_single_run():
    """n=1 → no interval (honest, never-blocks): `metrics` is empty, but the block
    still reports n so the UI can show the single-run disclosure."""
    ci = kpis._confidence_intervals([{"throughput_per_hr": 100.0}])
    assert ci["n"] == 1
    assert ci["metrics"] == {}

    # And through the public aggregate: a single RunResult carries an empty CI.
    m = _fast_model()
    agg = kpis.compute([run_once(m, seed=1)])
    assert "ci" in agg                      # additive key present even for n=1
    assert agg["ci"]["n"] == 1
    assert agg["ci"]["metrics"] == {}


def test_run_replications_ci_payload_is_additive():
    """Multi-rep aggregate keeps every existing KPI key and adds `ci` with a
    populated per-metric interval (mean/half_width/n/n_recommended)."""
    m = _fast_model()
    results, _heat = run_replications(m, reps=4)
    agg = kpis.compute(results, m)

    # Existing shape is untouched (additive only).
    for k in ("throughput_per_hr", "picker_utilization", "verdict",
              "replications", "throughput_p5", "throughput_p95"):
        assert k in agg
    assert agg["replications"] == 4

    ci = agg["ci"]
    assert ci["n"] == 4
    tp = ci["metrics"]["throughput_per_hr"]
    assert {"mean", "half_width", "n", "n_recommended"} <= set(tp)
    assert tp["n"] == 4
    assert tp["half_width"] >= 0.0
    assert tp["n_recommended"] >= 1


def test_analysis_payload_carries_ci_and_hero_half_width():
    """The analysis dashboard payload exposes the CI block and annotates the
    headline hero KPIs with a display-unit ± half-width; the analytic estimate
    (no replications) reports ci=None."""
    m = _fast_model()
    results, _heat = run_replications(m, reps=4)
    agg = kpis.compute(results, m)

    payload = _analysis_payload(m, agg, "run")
    assert isinstance(payload["ci"], dict)
    assert payload["ci"]["n"] == 4

    hero = payload["kpis"]["hero"]
    tput_cell = next((h for h in hero if h.get("label") == "処理能力"), None)
    assert tput_cell is not None, "throughput hero should be present with demand"
    assert isinstance(tput_cell["ci"], dict)
    assert tput_cell["ci"]["n"] == 4
    assert "half_width" in tput_cell["ci"]

    # Estimate path has no per-rep spread → ci is None (view shows no interval).
    est = analytic.estimate(m)
    est_payload = _analysis_payload(m, est, "estimate")
    assert est_payload["ci"] is None


def test_scorecard_run_block_carries_ci():
    """scorecard._run_block adds `ci` additively for a multi-rep run and omits it
    (never-blocks) for a single run."""
    import whsim.scorecard as sc

    m = _fast_model()
    results, _heat = run_replications(m, reps=4)
    agg = kpis.compute(results, m)

    block = sc._run_block(agg)
    assert block["exists"] is True
    assert "ci" in block and block["ci"]["metrics"]

    card = sc.build_scorecard(m, agg)
    assert card["run"]["exists"] is True
    assert "ci" in card["run"]

    # Single run → no CI in the run block.
    single = kpis.compute([run_once(m, seed=2)])
    assert "ci" not in sc._run_block(single)
