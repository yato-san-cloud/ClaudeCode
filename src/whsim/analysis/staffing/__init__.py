"""From measured volume to required headcount — the field-user bridge.

The timetable solver staffs a day from *per-process volumes* (物量) + productivities.
This package derives those from the analysed WMS data: it splits outbound/inbound
volume across a generic process flow (入荷検品→格納 / ピッキング→検品→梱包→出荷),
distributes each process's daily volume across the hours using the measured
hour-of-day shape, and divides by a productivity standard to get the **required
headcount per process per hour** (and the day's man-hours / peak).

The implementation is split into two cohesive modules — ``profile`` (process
master, hour-shapes, volume derivation, productivity 3-tier) and ``solver`` (the
analytic per-hour staffing solver + batch/shift overlays). This ``__init__`` re-
exports **every** symbol (public and the private ones consumers reach for, e.g.
``_inbound_shape``) so ``from whsim.analysis import staffing`` and every existing
``staffing.<name>`` / ``from whsim.analysis.staffing import <name>`` keeps working
byte-for-byte.
"""

from __future__ import annotations

from .profile import (  # noqa: F401 — re-exported so every staffing.<name> keeps working
    DRIVER_CATALOG,
    GENERIC_PROCESSES,
    KNOWN_DRIVERS,
    _BAND,
    _FLOW_DEPS,
    _GOODS_TO_PERSON,
    _INBOUND_WINDOW,
    _LEGACY_STRATEGY_LABEL,
    _LINES_PER_ORDER,
    _PICK_PROCESS_ID,
    _PIECES_PER_LINE,
    _hour_shape,
    _inbound_shape,
    _measured_inbound_shape,
    _method_picking_default,
    _n_days,
    flow_seed,
    generate_flow_volumes,
    process_deps,
    process_master,
    project_volumes,
    resolve_productivity,
    scenario_from_volumes,
    staffing_profile,
    timetable_scenario,
    volumes_from_bi,
)
from .solver import (  # noqa: F401 — re-exported so every staffing.<name> keeps working
    _SOLVE_PASSES,
    _shift_plan_caps,
    _toposort,
    batch_arrival_curve,
    default_dependencies,
    solve_staffing,
)

__all__ = [
    "DRIVER_CATALOG",
    "GENERIC_PROCESSES",
    "KNOWN_DRIVERS",
    "batch_arrival_curve",
    "default_dependencies",
    "flow_seed",
    "generate_flow_volumes",
    "process_deps",
    "process_master",
    "project_volumes",
    "resolve_productivity",
    "scenario_from_volumes",
    "solve_staffing",
    "staffing_profile",
    "timetable_scenario",
    "volumes_from_bi",
]
