"""Smooth the raw congestion grid so it reads as heat, not pixels (NumPy only)."""

from __future__ import annotations

import numpy as np


def _gaussian_kernel1d(sigma: float) -> np.ndarray:
    radius = max(1, int(round(3 * sigma)))
    xs = np.arange(-radius, radius + 1)
    k = np.exp(-(xs**2) / (2 * sigma**2))
    return k / k.sum()


def _convolve1d(a: np.ndarray, k: np.ndarray, axis: int) -> np.ndarray:
    return np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), axis, a)


def blur(grid: np.ndarray, sigma: float = 1.2) -> np.ndarray:
    if grid.size == 0 or grid.max() == 0:
        return grid
    k = _gaussian_kernel1d(sigma)
    out = _convolve1d(grid, k, axis=0)
    out = _convolve1d(out, k, axis=1)
    return out
