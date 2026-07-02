"""AS/RS crane cycle-time model — FEM 9.851 / Bozer-White analytic S/R times.

whsim's DES treats an 自動倉庫 (AS/RS) crane like any other travelling agent, but
a defensible proposal needs the *industry-standard* crane cycle time, the way
FlexSim / RaLC quote it. This module is the closed-form counterpart: given the
rack envelope (length ``L`` m, height ``H`` m) and the crane kinematics
(horizontal speed ``vx``, hoist speed ``vy``, fixed pick/deposit time ``t_fix``)
it returns the expected single- and dual-command cycle times, the derived
throughput (cycles/h, pallets/h) and the number of cranes a demand needs.

Model (all analytic — no simulation, so it is cheap enough for the drag-and-drop
"instant estimate"):

    w = L / vx                     # time to traverse the rack length (s)
    h = H / vy                     # time to traverse the rack height (s)
    T = max(w, h)                  # scaling factor (the dominant axis)
    b = min(w, h) / T              # shape factor, 0 ≤ b ≤ 1 (b=1 ⇒ "square in time")

    E(SC) = T·(1 + b²/3)            + 2·t_fix     # single command (store OR retrieve)
    E(DC) = T·(4/3 + b²/2 − b³/30)  + 4·t_fix     # dual command (store AND retrieve)

The two travel expressions are the canonical **Bozer & White (1984)** travel-time
model for a unit-load AS/RS with random storage and simultaneous (Chebyshev)
horizontal/vertical crane motion — the same expressions adopted by the German
**FEM 9.851** guideline "Cycle times for automatic warehouses (RBG / S/R
machines)". The fixed terms add the crane's pick/deposit (P/D) handling: a single
command performs 2 P/D operations (pick + deposit), a dual command performs 4.

Sanity check (b = 1, the "square-in-time" rack): E(SC) = 4/3·T + 2·t_fix and
E(DC) = 1.8·T + 4·t_fix (since 4/3 + 1/2 − 1/30 = 9/5).

Throughput per crane:
    SC:  3600 / E(SC) cycles/h  → 1 pallet moved per cycle.
    DC:  3600 / E(DC) cycles/h  → 2 pallets moved per cycle (one in, one out).

Everything is clamped so missing/zero inputs never raise ("never blocks").
"""

from __future__ import annotations

import math


def cycle_times(L: float, H: float, vx: float, vy: float,
                t_fix: float) -> dict:
    """Expected single/dual-command cycle times (seconds) for one S/R crane.

    ``L``/``H`` = rack length/height (m); ``vx``/``vy`` = horizontal/hoist speed
    (m/s); ``t_fix`` = one pick-or-deposit fixed time (s). Returns the shape
    factors (``w``, ``h``, ``T``, ``b``) and ``e_sc`` / ``e_dc`` in seconds.
    Degenerate racks (T = 0) collapse to just the fixed P/D time."""
    L = max(0.0, float(L))
    H = max(0.0, float(H))
    vx = max(1e-6, float(vx))
    vy = max(1e-6, float(vy))
    t_fix = max(0.0, float(t_fix))

    w = L / vx                      # horizontal traverse time (s)
    h = H / vy                      # vertical traverse time (s)
    T = max(w, h)                   # scaling factor
    b = (min(w, h) / T) if T > 0 else 0.0   # shape factor in [0, 1]

    e_sc = T * (1.0 + b * b / 3.0) + 2.0 * t_fix
    e_dc = T * (4.0 / 3.0 + b * b / 2.0 - b * b * b / 30.0) + 4.0 * t_fix
    return {"w": w, "h": h, "T": T, "b": b, "e_sc": e_sc, "e_dc": e_dc}


def throughput(e_sc: float, e_dc: float) -> dict:
    """Cycles/h and pallets/h per crane from the cycle times.

    A single command moves 1 unit load; a dual command moves 2 (one store, one
    retrieve). Zero/negative cycle times yield zero throughput (never divides)."""
    sc = 3600.0 / e_sc if e_sc > 0 else 0.0
    dc = 3600.0 / e_dc if e_dc > 0 else 0.0
    return {
        "sc_cycles_per_h": sc,
        "dc_cycles_per_h": dc,
        "sc_pallets_per_h": sc,          # 1 pallet / single command
        "dc_pallets_per_h": 2.0 * dc,    # 2 pallets / dual command
    }


def cranes_required(demand_per_h: float, per_crane_per_h: float) -> int:
    """Cranes needed to serve ``demand_per_h`` cycles/h at ``per_crane_per_h``.

    Returns 0 when there is no demand; otherwise ``ceil`` (≥1). If a crane can do
    nothing (per_crane_per_h ≤ 0) but demand exists, returns 0 — the caller pairs
    this with a capacity floor so the answer never becomes infinite."""
    demand_per_h = max(0.0, float(demand_per_h))
    if demand_per_h <= 0.0:
        return 0
    if per_crane_per_h <= 0.0:
        return 0
    return max(1, math.ceil(demand_per_h / per_crane_per_h))


def size_asrs(L: float, H: float, vx: float, vy: float, t_fix: float,
              out_per_h: float, in_per_h: float | None = None,
              command: str = "dual") -> dict:
    """Full analytic AS/RS sizing: cycle times, throughput, crane count.

    ``out_per_h`` = retrieval (出庫) unit-loads/h demand; ``in_per_h`` = storage
    (入庫) unit-loads/h (defaults to ``out_per_h`` — a balanced, steady-state
    warehouse). ``command`` selects the sizing basis: ``"dual"`` pairs a store
    with a retrieve per trip (the usual, higher-throughput mode), ``"single"``
    sizes on independent single commands. Returns a JSON-able dict; pure."""
    in_per_h = out_per_h if in_per_h is None else max(0.0, float(in_per_h))
    out_per_h = max(0.0, float(out_per_h))

    cyc = cycle_times(L, H, vx, vy, t_fix)
    tp = throughput(cyc["e_sc"], cyc["e_dc"])

    # Single-command basis: every store and every retrieve is its own cycle.
    total_moves = out_per_h + in_per_h
    cranes_single = cranes_required(total_moves, tp["sc_cycles_per_h"])
    # Dual-command basis: one trip does a store AND a retrieve, so the binding
    # rate is the busier of the two flows (in a balanced house they are equal).
    binding = max(out_per_h, in_per_h)
    cranes_dual = cranes_required(binding, tp["dc_cycles_per_h"])

    command = "single" if command == "single" else "dual"
    cranes = cranes_single if command == "single" else cranes_dual

    return {
        "L_m": round(float(L), 2),
        "H_m": round(float(H), 2),
        "vx_mps": round(float(vx), 3),
        "vy_mps": round(float(vy), 3),
        "t_fix_s": round(float(t_fix), 2),
        "shape_T_s": round(cyc["T"], 2),
        "shape_b": round(cyc["b"], 4),
        "e_sc_s": round(cyc["e_sc"], 1),          # single-command cycle time (s)
        "e_dc_s": round(cyc["e_dc"], 1),          # dual-command cycle time (s)
        "sc_cycles_per_h": round(tp["sc_cycles_per_h"], 1),
        "dc_cycles_per_h": round(tp["dc_cycles_per_h"], 1),
        "sc_pallets_per_h": round(tp["sc_pallets_per_h"], 1),
        "dc_pallets_per_h": round(tp["dc_pallets_per_h"], 1),
        "demand_out_per_h": round(out_per_h, 2),
        "demand_in_per_h": round(in_per_h, 2),
        "command": command,
        "cranes_single": cranes_single,
        "cranes_dual": cranes_dual,
        "cranes": cranes,
    }
