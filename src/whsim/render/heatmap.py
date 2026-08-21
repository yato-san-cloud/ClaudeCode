"""Turn the raw congestion grid into a smooth heat *field* (NumPy only).

The engine rasterises every travelled leg into a coarse per-metre grid. Drawn
raw that reads as pixel noise, and drawn with a flat alpha it muddies the plan
underneath. This module supplies the two things the proposal sheet needs:

* :func:`field` — edge-corrected gaussian blur + bilinear upsample, normalised
  to 0..1 (plus the raw peak for honest colourbar ticks).
* :func:`congestion_cmap` — a perceptually monotone (lightness always falling)
  ramp whose **alpha rises from 0**, so quiet floor stays clean paper and only
  real traffic tints the drawing.

Pure NumPy + matplotlib colours; no SciPy.
"""

from __future__ import annotations

import numpy as np
from matplotlib.colors import LinearSegmentedColormap, ListedColormap

# Ramp stops: paper → calm blue → indigo → magenta → warm red. Lightness falls
# monotonically, so the field reads as "more" without hue confusion, and the two
# ends match the app's accent (#2383E2) / danger (#E03E3E) language.
_STOPS = ["#eef4fd", "#b8d2f3", "#7ba7e8", "#5f7fd4", "#7a63bd",
          "#a84f96", "#c9455f", "#d9453d"]


def _gaussian_kernel1d(sigma: float) -> np.ndarray:
    radius = max(1, int(round(3 * sigma)))
    xs = np.arange(-radius, radius + 1)
    k = np.exp(-(xs**2) / (2 * sigma**2))
    return k / k.sum()


def _convolve1d(a: np.ndarray, k: np.ndarray, axis: int) -> np.ndarray:
    return np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), axis, a)


def blur(grid: np.ndarray, sigma: float = 1.2) -> np.ndarray:
    """Separable gaussian blur, zero-padded (kept for backwards compatibility)."""
    if grid.size == 0 or grid.max() == 0:
        return grid
    k = _gaussian_kernel1d(sigma)
    out = _convolve1d(grid, k, axis=0)
    out = _convolve1d(out, k, axis=1)
    return out


def blur_norm(grid: np.ndarray, sigma: float = 1.2) -> np.ndarray:
    """Gaussian blur with edge correction (no dark rim at the floor boundary).

    ``blur`` convolves with zero padding, so cells near the edge are averaged
    against non-existent zeros and lose intensity. Dividing by the blur of a
    ones-mask renormalises them — the difference is very visible on a plan where
    the busiest aisle often hugs a wall.
    """
    if grid.size == 0 or float(np.max(grid)) == 0:
        return grid
    k = _gaussian_kernel1d(sigma)
    num = _convolve1d(_convolve1d(grid, k, axis=0), k, axis=1)
    ones = np.ones_like(grid, dtype=float)
    den = _convolve1d(_convolve1d(ones, k, axis=0), k, axis=1)
    return num / np.maximum(den, 1e-9)


def _upsample(a: np.ndarray, factor: int) -> np.ndarray:
    """Bilinear upsample by an integer factor (cell-centre aligned)."""
    if factor <= 1:
        return a
    h, w = a.shape
    yi = np.clip((np.arange(h * factor) + 0.5) / factor - 0.5, 0, h - 1)
    xi = np.clip((np.arange(w * factor) + 0.5) / factor - 0.5, 0, w - 1)
    y0 = np.floor(yi).astype(int)
    x0 = np.floor(xi).astype(int)
    y1 = np.minimum(y0 + 1, h - 1)
    x1 = np.minimum(x0 + 1, w - 1)
    wy = (yi - y0)[:, None]
    wx = (xi - x0)[None, :]
    top = a[y0][:, x0] * (1 - wx) + a[y0][:, x1] * wx
    bot = a[y1][:, x0] * (1 - wx) + a[y1][:, x1] * wx
    return top * (1 - wy) + bot * wy


def field(grid, sigma: float = 1.15, max_px: int = 480) -> tuple[np.ndarray, float] | None:
    """Smooth, upsampled congestion field normalised to 0..1.

    Returns ``(field, peak)`` where ``peak`` is the raw (pre-normalisation) max
    of the blurred grid — the honest number for the colourbar's top tick — or
    ``None`` when there is nothing to draw (missing / empty / all-zero / NaN
    grid). Never raises: a malformed grid is treated as "no data".
    """
    try:
        a = np.asarray(grid, dtype=float)
    except (TypeError, ValueError):
        return None
    if a.ndim != 2 or a.size == 0:
        return None
    a = np.nan_to_num(a, nan=0.0, posinf=0.0, neginf=0.0)
    a = np.clip(a, 0.0, None)
    if float(a.max()) <= 0:
        return None

    sm = blur_norm(a, sigma=sigma)
    # Upsample so the drawn field is smooth even on a coarse 1 m grid, but keep
    # the array small enough to stay cheap to rasterise.
    long_side = max(sm.shape)
    factor = int(np.clip(max_px // max(long_side, 1), 1, 8))
    if factor > 1:
        sm = _upsample(sm, factor)
        sm = blur_norm(sm, sigma=max(0.8, sigma * factor * 0.35))
    peak = float(sm.max())
    if peak <= 0:
        return None
    return sm / peak, peak


def congestion_cmap(hue_power: float = 0.5, alpha_power: float = 1.25,
                    alpha_max: float = 0.86) -> ListedColormap:
    """Sequential congestion ramp: hue climbs fast, opacity climbs slowly.

    Travel congestion is heavy-tailed, so a linear ramp hides every aisle except
    the single worst one. Pushing the *hue* through ``t ** hue_power`` (<1) makes
    mid traffic legible, while holding the *alpha* at ``t ** alpha_power`` (>1)
    keeps quiet floor genuinely transparent — the plan underneath never turns to
    mud. Because the data itself is drawn linearly, colourbar ticks stay linear
    and honest.
    """
    base = LinearSegmentedColormap.from_list("congest_base", _STOPS, N=256)
    t = np.linspace(0.0, 1.0, 256)
    lut = base(np.clip(t ** hue_power, 0.0, 1.0))
    lut[:, 3] = np.clip(t ** alpha_power, 0.0, 1.0) * alpha_max
    cm = ListedColormap(lut, name="congestion")
    try:  # matplotlib ≥3.8 prefers with_extremes; set_bad is deprecated
        return cm.with_extremes(bad=(0.0, 0.0, 0.0, 0.0))
    except AttributeError:  # pragma: no cover — older matplotlib
        cm.set_bad(alpha=0.0)
        return cm
