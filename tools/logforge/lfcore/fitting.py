"""Distribution fitting for calibration.json (WHSIM_CONTRACTS v1.0 §8).

Every candidate is fitted by maximum likelihood and scored with a one-sample
Kolmogorov-Smirnov test; the winner ships together with n, the KS statistic and
the KS p value, and the *losers* ship too. A calibration number whose sample
size and goodness of fit are invisible is a number without provenance.

Honest caveat, repeated in the README and in calibration.json's `method`: the
parameters are estimated from the same sample the KS test uses, so ks_p is
optimistic (Lilliefors, not Kolmogorov). It is a comparison score between
candidates, not a certificate of fit.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence

import numpy as np
from scipy import stats

# Location is pinned at 0 for these: a work time is a duration measured from
# zero, and a free loc lets the optimiser buy fit quality with a physically
# meaningless negative offset (and makes params incomparable between runs).
_FIX_LOC_AT_ZERO = frozenset({"lognorm", "gamma", "expon", "weibull_min"})

SUPPORTED = ("lognorm", "gamma", "expon", "norm", "weibull_min")


class FitError(ValueError):
    pass


def _round(value: float, digits: int = 9) -> float:
    """Round for stable, readable output (float(f'{x:.9g}') is deterministic)."""
    if not math.isfinite(value):
        raise FitError(f"non-finite fit result: {value}")
    return float(f"{value:.{digits}g}")


def _param_names(dist) -> list[str]:
    shapes = [s.strip() for s in (dist.shapes or "").split(",") if s.strip()]
    return shapes + ["loc", "scale"]


def fit_one(values: Sequence[float], dist_name: str) -> dict:
    if dist_name not in SUPPORTED:
        raise FitError(f"unsupported distribution {dist_name!r} (supported: {list(SUPPORTED)})")
    dist = getattr(stats, dist_name)
    data = np.asarray(values, dtype=float)
    kwargs = {"floc": 0.0} if dist_name in _FIX_LOC_AT_ZERO else {}
    params = dist.fit(data, **kwargs)
    ks = stats.kstest(data, dist_name, args=params)
    return {
        "dist": dist_name,
        "params": {
            name: _round(float(value)) for name, value in zip(_param_names(dist), params)
        },
        "ks_stat": _round(float(ks.statistic)),
        "ks_p": _round(float(ks.pvalue)),
    }


def fit_series(
    values: Iterable[float],
    candidates: Sequence[str] = ("lognorm", "gamma", "expon"),
    excluded: int = 0,
) -> dict:
    """Fit every candidate, pick the best by KS p value, keep the evidence."""
    data = np.asarray(list(values), dtype=float)
    n = int(data.size)
    if n < 2:
        raise FitError(f"need at least 2 observations to fit, got {n}")

    results: list[dict] = []
    for index, name in enumerate(candidates):
        try:
            result = fit_one(data, name)
        except (FitError, ValueError, RuntimeError, FloatingPointError):
            continue
        result["_order"] = index
        results.append(result)
    if not results:
        raise FitError(f"no candidate distribution could be fitted (tried {list(candidates)})")

    # Deterministic ranking: best p, then smallest KS statistic, then the order
    # the candidates were listed in mapping.yaml.
    best = min(results, key=lambda r: (-r["ks_p"], r["ks_stat"], r["_order"]))
    ranked = sorted(results, key=lambda r: (-r["ks_p"], r["ks_stat"], r["_order"]))
    for r in ranked:
        r.pop("_order", None)

    quantiles = np.percentile(data, [50, 95])
    return {
        "dist": best["dist"],
        "params": best["params"],
        "n": n,
        "ks_p": best["ks_p"],
        "ks_stat": best["ks_stat"],
        "unit": "s",
        "method": "mle(floc=0) + one-sample KS; ks_p is optimistic (params fitted on same sample)",
        "sample": {
            "mean": _round(float(data.mean())),
            "p50": _round(float(quantiles[0])),
            "p95": _round(float(quantiles[1])),
            "min": _round(float(data.min())),
            "max": _round(float(data.max())),
            "excluded": int(excluded),
        },
        "candidates": ranked,
    }
