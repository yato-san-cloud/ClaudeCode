"""DoD 4/6: the fit must recover the parameters the generator actually used."""

from __future__ import annotations

import numpy as np
import pytest

from lfcore import fitting
from lfcore.convert import convert


def test_fit_recovers_known_lognorm_parameters():
    rng = np.random.default_rng(7)
    truth_s, truth_scale = 0.4, 12.0
    data = rng.lognormal(mean=np.log(truth_scale), sigma=truth_s, size=5000)

    result = fitting.fit_series(data, ("lognorm", "gamma", "expon"))

    assert result["dist"] == "lognorm"
    assert result["n"] == 5000
    assert result["params"]["s"] == pytest.approx(truth_s, rel=0.05)
    assert result["params"]["scale"] == pytest.approx(truth_scale, rel=0.05)
    assert result["params"]["loc"] == 0.0
    assert result["ks_p"] > 0.01
    assert next(c["dist"] for c in result["candidates"]) == "lognorm"


def test_fit_recovers_known_gamma_parameters():
    rng = np.random.default_rng(11)
    data = rng.gamma(shape=2.0, scale=4.0, size=5000)

    result = fitting.fit_series(data, ("lognorm", "gamma", "expon"))

    assert result["dist"] == "gamma"
    assert result["params"]["a"] == pytest.approx(2.0, rel=0.1)
    assert result["params"]["scale"] == pytest.approx(4.0, rel=0.1)


def test_candidates_are_ranked_and_all_reported():
    rng = np.random.default_rng(3)
    data = rng.lognormal(mean=np.log(12.0), sigma=0.4, size=2000)

    result = fitting.fit_series(data, ("lognorm", "gamma", "expon"))
    p_values = [c["ks_p"] for c in result["candidates"]]

    assert len(result["candidates"]) == 3, "losing candidates are evidence, keep them"
    assert p_values == sorted(p_values, reverse=True)
    assert result["ks_p"] == p_values[0]


def test_fit_is_deterministic():
    rng = np.random.default_rng(5)
    data = rng.lognormal(mean=np.log(9.0), sigma=0.6, size=800)
    assert fitting.fit_series(data) == fitting.fit_series(data)


def test_too_few_observations_is_an_error_not_a_guess():
    with pytest.raises(fitting.FitError):
        fitting.fit_series([1.0])


def test_pipeline_recovers_truth_end_to_end(sample_set, default_mapping, truth):
    """The whole xlsx -> calibration.json path, graded against the generator."""
    result = convert(sample_set["xlsx"], default_mapping)
    series = result.calibration["pick_time_s"]

    # The lognorm candidate must land on the truth whether or not it wins the
    # KS beauty contest (below ~1000 samples lognorm and gamma are not
    # distinguishable, which is a fact about the data, not a bug in the fit).
    lognorm = next(c for c in series["candidates"] if c["dist"] == "lognorm")
    assert lognorm["params"]["s"] == pytest.approx(truth["pick_time_s"]["s"], rel=0.1)
    assert lognorm["params"]["scale"] == pytest.approx(truth["pick_time_s"]["scale"], rel=0.1)

    assert series["dist"] == truth["pick_time_s"]["dist"]
    assert series["params"]["s"] == pytest.approx(truth["pick_time_s"]["s"], rel=0.1)
    assert series["params"]["scale"] == pytest.approx(truth["pick_time_s"]["scale"], rel=0.1)
    assert series["n"] == truth["rows"]
    assert 0.0 <= series["ks_p"] <= 1.0
    assert series["sample"]["excluded"] == 0
    assert result.calibration["source"] == "synthetic_sample_v1"


def test_calibration_omits_series_it_cannot_justify(sample_set, mapping_factory):
    """Fewer samples than min_samples -> no distribution at all (not a guess)."""
    mapping = mapping_factory(
        sample_set["master"], **{"calibration.min_samples": 100000}
    )
    result = convert(sample_set["xlsx"], mapping)

    assert "pick_time_s" not in result.calibration
    assert any("min_samples" in note for note in result.notes)
    assert any(e.reason == "insufficient_samples" for e in result.errors)
