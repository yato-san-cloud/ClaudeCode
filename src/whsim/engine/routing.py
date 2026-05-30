"""Travel distance and the grid cells a leg passes through.

Pickers are assumed to move rectilinearly (along aisles), so distance is
Manhattan. The traversed cells are rasterised here so the congestion heatmap is
a near-free byproduct of distance computation rather than a separate pass.
"""

from __future__ import annotations


def manhattan(a: tuple[float, float], b: tuple[float, float]) -> float:
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def leg_cells(
    a: tuple[float, float], b: tuple[float, float], grid_m: float
) -> list[tuple[int, int]]:
    """Grid cells touched by an L-shaped (x-then-y) leg from a to b."""
    if grid_m <= 0:
        grid_m = 1.0
    ax, ay = a
    bx, by = b
    cells: list[tuple[int, int]] = []

    # horizontal segment at y = ay, x from ax -> bx
    step = grid_m if bx >= ax else -grid_m
    x = ax
    while (x <= bx) if step > 0 else (x >= bx):
        cells.append((int(x // grid_m), int(ay // grid_m)))
        x += step
    # vertical segment at x = bx, y from ay -> by
    step = grid_m if by >= ay else -grid_m
    y = ay
    while (y <= by) if step > 0 else (y >= by):
        cells.append((int(bx // grid_m), int(y // grid_m)))
        y += step
    return cells


def nearest_neighbor_route(
    start: tuple[float, float], points: list[tuple[float, float]]
) -> list[int]:
    """Greedy nearest-neighbour visiting order (indices into `points`)."""
    remaining = list(range(len(points)))
    order: list[int] = []
    cur = start
    while remaining:
        i = min(remaining, key=lambda j: manhattan(cur, points[j]))
        order.append(i)
        cur = points[i]
        remaining.remove(i)
    return order
