"""パラメータ自動掃引 — a mini OptQuest over the analytic evaluators.

Commercial simulators sell the 「機械が最適を探した」 story via OptQuest: search a
parameter space, score each point, rank, present the winner. whsim's evaluators
are analytic (near-instant), so a *grid sweep + rank* buys the same story for
almost no compute — no DES required.

We sweep three knobs and score each combination WITHOUT a SimPy run, reusing the
existing pure functions verbatim (never re-deriving physics here):

  * 作業方式  — the 4 ``workmethod.METHOD_PRESETS`` (シングル/マルチ/ゾーン/トータル),
  * 人員数    — pickers around the model's current count (feasibility / makespan),
  * まとめ数  — orders_per_trip variants for the マルチ method (batch amortisation).

For each combination:

  1. picking productivity (lines/person/hour) for the method+batch comes from the
     SAME analytic motion-time model the 生産性試算 uses — we call
     ``pickrate.estimate_pickrate`` for the layout geometry and evaluate its
     closed form at the combo's ``orders_per_trip`` (so a batch variant that has
     no matching preset row is still scored faithfully),
  2. ``staffing.solve_staffing`` runs with the picker count as the ピッキング cap →
     feasibility + makespan + peak headcount + man-hours (analytic, deterministic),
  3. ``cost.estimate_cost`` on a model copy with the method + picker count applied →
     monthly cost + ¥/order (the injected picking productivity keeps ①②③ in sync).

Objective (lexicographic): **feasible first**, then **lowest monthly cost**, then
**lowest peak headcount** (makespan / pickers break any remaining tie for a stable
order). The result is a ranked table the user can 採用 into the model — with the
honest caveat that this is an analytic screen and the top picks should be
back-tested with the heavyweight DES (▶実行).

never-blocks: no volumes (a project with no demand yet) → ``{available: False}``;
the combo count is capped (≤ ``MAX_COMBOS``) and the wall time is budgeted
(``TIME_BUDGET_S``), returning a partial-but-valid ranking flagged ``truncated``.

Pure over the schema + a volumes dict; JSON-able; raises nothing the caller must
handle. Public entry point: :func:`run_sweep`.
"""

from __future__ import annotations

import math
import time

from whsim import cost as cost_mod, pickrate, workmethod
from whsim.analysis import staffing
from whsim.schema.model import WarehouseModel, WorkMethod

# The picking work-process id whose engine-default productivity is method-aware
# (mirrors staffing's canonical PICKING process; kept local so we never import a
# private helper). Injecting an override here keeps solve_staffing and
# estimate_cost on the SAME picking productivity we report for the row.
_PICK_PROCESS_ID = "ピッキング"

# Grid / budget guards. The default grid stays well under MAX_COMBOS; a
# caller-supplied grid is trimmed to it (and flagged truncated) so a pathological
# request can never explode the sweep.
MAX_COMBOS = 120
TIME_BUDGET_S = 10.0

# orders_per_trip variants swept for the マルチ method only (batch amortises the
# tour over more lines — the whole point of the knob). Other methods keep their
# preset's own orders_per_trip (a single point).
_MULTI_ID = "multi"
_MULTI_OPTS = (4, 8, 12)

# Picker range around the current count: cur-4 .. cur+6 (never below 1).
_PICKER_LO_DELTA = 4
_PICKER_HI_DELTA = 6

_OBJECTIVE_JP = (
    "実行可能（当日にさばける）を最優先し、次に月次コスト最小、"
    "同点は最少ピーク人員（さらに最短メイクスパン・最少人員）で順位付け。"
)


def _current_pickers(model: WarehouseModel) -> int:
    """The model's current picker headcount (Σ role==picker), ≥1 (never-blocks)."""
    try:
        n = sum(int(w.count) for w in model.resources.workers if w.role == "picker")
    except Exception:  # noqa: BLE001 — a malformed resources block → sane default
        n = 0
    return max(1, n)


def _picker_worker_index(model: WarehouseModel) -> int | None:
    """Index of the first picker WorkerGroup (for the 採用 count edit path), or None."""
    try:
        for i, w in enumerate(model.resources.workers):
            if w.role == "picker":
                return i
    except Exception:  # noqa: BLE001
        return None
    return None


def _picking_lines_per_hour(geo: dict, is_sort: bool, opt: int) -> float:
    """lines/person/hour for a trip of ``opt`` orders, via pickrate's closed form.

    Reuses the layout geometry ``estimate_pickrate`` already measured (pick area /
    depot distance / lines-per-order) and pickrate's public motion-time DEFAULTS —
    no new physics. At a method's own preset ``orders_per_trip`` this reproduces
    that method's row in ``estimate_pickrate`` (verified in tests); off-preset
    batch sizes (the マルチ variants) are evaluated on the same formula so every
    swept point is scored consistently."""
    d = pickrate.DEFAULTS
    walk = max(0.1, float(d["walk_speed_mps"]))
    handle = max(0.0, float(d["handle_s_per_line"]))
    sort_s = max(0.0, float(d["sort_s_per_line"]))
    kk = max(0.1, float(d["tour_constant"]))
    area = max(1.0, float(geo.get("pick_area_m2", 1.0) or 1.0))
    depot = max(0.0, float(geo.get("depot_dist_m", 0.0) or 0.0))
    lpo = max(1.0, float(geo.get("lines_per_order", 1.0) or 1.0))

    n_picks = max(1.0, opt * lpo)
    tour = kk * math.sqrt(n_picks * area) + 2.0 * depot
    t_trip = max(1e-6, tour / walk + n_picks * handle + (n_picks * sort_s if is_sort else 0.0))
    return n_picks / t_trip * 3600.0


def _operating_window(model: WarehouseModel) -> tuple[int, int]:
    """(start_hour, end_hour) for the staffing solve, sized to the shift length so
    feasibility reflects the real working day. Defaults to a 9-hour 09–18 day."""
    try:
        shift = float(getattr(model.simulation, "shift_hours_per_day", 9.0) or 9.0)
    except Exception:  # noqa: BLE001
        shift = 9.0
    start = 9
    end = start + max(1, int(round(shift)))
    return start, end


def _combos(model: WarehouseModel, grid: dict | None) -> tuple[list[dict], bool]:
    """Enumerate the (method, orders_per_trip, pickers) grid, capped at MAX_COMBOS.

    ``grid`` may override any axis: ``methods`` (preset ids), ``pickers`` (explicit
    list), ``orders_per_trip`` (list, applied to the マルチ method). Returns
    ``(combos, truncated)`` where truncated is True when the requested grid was
    trimmed to the combo cap."""
    g = grid if isinstance(grid, dict) else {}
    presets = {p["id"]: p for p in workmethod.METHOD_PRESETS}

    want_methods = g.get("methods")
    if isinstance(want_methods, (list, tuple)) and want_methods:
        method_ids = [str(m) for m in want_methods if str(m) in presets]
    else:
        method_ids = list(presets.keys())
    if not method_ids:
        method_ids = list(presets.keys())

    cur = _current_pickers(model)
    want_pickers = g.get("pickers")
    if isinstance(want_pickers, (list, tuple)) and want_pickers:
        pickers = sorted({max(1, int(p)) for p in want_pickers
                          if isinstance(p, (int, float)) or str(p).isdigit()})
    else:
        pickers = list(range(max(1, cur - _PICKER_LO_DELTA), cur + _PICKER_HI_DELTA + 1))
    if not pickers:
        pickers = [cur]

    want_opts = g.get("orders_per_trip")
    multi_opts = None
    if isinstance(want_opts, (list, tuple)) and want_opts:
        multi_opts = sorted({max(1, int(o)) for o in want_opts
                             if isinstance(o, (int, float)) or str(o).isdigit()})
    if not multi_opts:
        multi_opts = list(_MULTI_OPTS)

    combos: list[dict] = []
    truncated = False
    for mid in method_ids:
        preset = presets[mid]
        base_opt = int(preset["work"].get("orders_per_trip", 1))
        opts = multi_opts if mid == _MULTI_ID else [base_opt]
        for opt in opts:
            for n in pickers:
                if len(combos) >= MAX_COMBOS:
                    truncated = True
                    return combos, truncated
                combos.append({"method_id": mid, "orders_per_trip": int(opt),
                               "pickers": int(n)})
    return combos, truncated


def _score_key(row: dict) -> tuple:
    """Lexicographic objective: feasible first, then cost, then peak, then
    makespan, then pickers (deterministic total order)."""
    return (
        0 if row["feasible"] else 1,
        row["monthly_cost"],
        row["peak"],
        row["makespan_hour"],
        row["pickers"],
    )


def run_sweep(model: WarehouseModel, volumes: dict | None, grid: dict | None = None) -> dict:
    """Sweep 作業方式 × 人員数 × まとめ数, score each analytically, return a ranking.

    Args:
      model:   the warehouse model to evaluate variants of (never mutated).
      volumes: per-process daily 物量 ``{process_id: qty}`` (staffing.project_volumes
               output). Empty / falsy → ``{"available": False}`` (never-blocks).
      grid:    optional axis overrides (``methods`` / ``pickers`` / ``orders_per_trip``).

    Returns a JSON-able dict: ``available``, ranked ``rows``, ``best``, the
    ``objective`` explanation, ``evaluated`` count, ``truncated`` flag, ``elapsed_s``
    and the adopt-seam hints (``pick_stage_index`` / ``picker_worker_index``)."""
    if not volumes or not any(float(v or 0) > 0 for v in volumes.values()):
        return {"available": False,
                "reason": "物量データがありません。①取込/②分析で出荷実績を取り込んでください。"}

    t0 = time.time()
    pidx = workmethod.pick_stage_index(model)
    worker_idx = _picker_worker_index(model)
    start_hour, end_hour = _operating_window(model)
    # Geometry is layout-only (method/batch/picker-independent): measure it once.
    geo = (pickrate.estimate_pickrate(model) or {}).get("geometry", {}) or {}
    presets = {p["id"]: p for p in workmethod.METHOD_PRESETS}

    combos, truncated = _combos(model, grid)

    # cost + picking productivity depend on (method, orders_per_trip) only — cache
    # them so the picker sweep (which shares them) doesn't recompute needlessly.
    md_cache: dict[tuple[str, int], dict] = {}

    def _method_eval(mid: str, opt: int) -> dict:
        key = (mid, opt)
        if key in md_cache:
            return md_cache[key]
        preset = presets[mid]
        is_sort = preset["work"].get("consolidation") == "sort"
        lph = _picking_lines_per_hour(geo, is_sort, opt)
        # Model copy with the method + injected picking productivity so cost (and,
        # below, staffing) both evaluate THIS method+batch consistently.
        mc = model.model_copy(deep=True)
        try:
            work = WorkMethod(**{**preset["work"], "orders_per_trip": int(opt)})
            if 0 <= pidx < len(mc.process.stages):
                mc.process.stages[pidx].work = work
        except Exception:  # noqa: BLE001 — a bad stage index must not block the sweep
            pass
        ov = dict(getattr(mc.settings, "productivity_overrides", {}) or {})
        ov[_PICK_PROCESS_ID] = lph
        mc.settings.productivity_overrides = ov
        try:
            cost = cost_mod.estimate_cost(mc)
            monthly = float(cost.get("total_yen_month", 0) or 0)
            per_order = float(cost.get("cost_per_order", 0) or 0)
        except Exception:  # noqa: BLE001 — cost is best effort; a failure scores worst
            monthly, per_order = math.inf, 0.0
        out = {"mc": mc, "lines_per_hour": round(lph, 1), "monthly": monthly,
               "per_order": per_order, "label": preset["label"], "is_sort": is_sort}
        md_cache[key] = out
        return out

    rows: list[dict] = []
    evaluated = 0
    for combo in combos:
        if time.time() - t0 > TIME_BUDGET_S:
            truncated = True
            break
        mid, opt, pickers = combo["method_id"], combo["orders_per_trip"], combo["pickers"]
        me = _method_eval(mid, opt)
        # The (method, orders_per_trip) model copy is shared across the picker sweep:
        # the picker count is applied to it for coherence, but it drives feasibility
        # only through solve_staffing's per-process cap below (worker count is inert
        # to both solve_staffing and the cached cost), so no per-combo deep copy is
        # needed — the sweep stays fast even on a large model.
        mc = me["mc"]
        if worker_idx is not None and 0 <= worker_idx < len(mc.resources.workers):
            mc.resources.workers[worker_idx].count = pickers
        try:
            # Front-load: staff up early to finish ASAP — the honest feasibility /
            # makespan question ("can this picker count clear the day at all?").
            sol = staffing.solve_staffing(
                volumes, model=mc, start_hour=start_hour, end_hour=end_hour,
                per_process_cap={_PICK_PROCESS_ID: pickers}, placement="front")
            feasible = bool(sol.get("feasible"))
            makespan = float(sol.get("makespan_hour", end_hour) or end_hour)
            peak = int(sol.get("peak_headcount", 0) or 0)
            tmh = float(sol.get("total_man_hours", 0.0) or 0.0)
        except Exception:  # noqa: BLE001 — an unstaffable combo scores worst, never fatal
            feasible, makespan, peak, tmh = False, float(end_hour), 0, 0.0
        rows.append({
            "method_id": mid,
            "method_label": me["label"],
            "pickers": pickers,
            "orders_per_trip": opt,
            "feasible": feasible,
            "makespan_hour": round(makespan, 1),
            "peak": peak,
            "total_man_hours": round(tmh, 1),
            "monthly_cost": None if me["monthly"] == math.inf else round(me["monthly"]),
            "cost_per_order": round(me["per_order"], 1),
            "picking_lines_per_hour": me["lines_per_hour"],
        })
        evaluated += 1

    # Rank: sort by the lexicographic objective, then stamp rank (1-based).
    rows.sort(key=lambda r: _score_key(
        {**r, "monthly_cost": math.inf if r["monthly_cost"] is None else r["monthly_cost"]}))
    for i, r in enumerate(rows, start=1):
        r["rank"] = i

    return {
        "available": True,
        "objective": _OBJECTIVE_JP,
        "evaluated": evaluated,
        "truncated": bool(truncated),
        "elapsed_s": round(time.time() - t0, 3),
        "current_pickers": _current_pickers(model),
        "pick_stage_index": pidx,
        "picker_worker_index": worker_idx,
        "window": {"start_hour": start_hour, "end_hour": end_hour},
        "rows": rows,
        "best": rows[0] if rows else None,
        "note": "解析モデルによる即時評価です。上位案は▶実行（DES）で裏取りしてください。",
    }
