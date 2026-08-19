"""Derive KPIs from the raw event log (the engine never hard-codes metrics)."""

from __future__ import annotations

import math
import statistics

from whsim.engine.run import RunResult
from whsim.schema.model import Settings, WarehouseModel

# Two-sided 95% Student-t critical values by degrees of freedom (df = n-1),
# used to turn the per-replication spread into a confidence interval WITHOUT a
# scipy dependency. Small n is exactly where the t-correction matters and the
# DES rarely runs >30 replications; df>30 falls back to the normal approx.
_T95: dict[int, float] = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447,
    7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179,
    13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101,
    19: 2.093, 20: 2.086, 21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064,
    25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
}
_Z95 = 1.96  # normal approximation for df>30

# The headline KPIs a 荷主 asks about — "この数字はどれくらい堅いのか". Each is a
# per-replication numeric already produced by ``_one``, so a 95% CI is a pure,
# additive read over the Monte-Carlo samples.
CI_METRICS: tuple[str, ...] = (
    "throughput_per_hr",       # 処理能力 (件/時)
    "orders_per_picker_hr",    # 生産性 (件/人時)
    "picker_utilization",      # ピッキング稼働率
    "packer_utilization",      # 梱包稼働率
    "agv_utilization",         # AGV稼働率
    "sort_utilization",        # 種まき仕分け稼働率
    "walk_per_order_m",        # 1件あたり歩行距離
    "cycle_mean_s",            # 平均サイクル(完了)時間
    "completion_rate",         # 出荷完了率
    "total_cost_per_order",    # 1件あたりコスト
)


def _t95(df: int) -> float:
    """Two-sided 95% t critical value at ``df`` degrees of freedom."""
    if df <= 0:
        return 0.0
    return _T95.get(df, _Z95)


def _confidence_intervals(per: list[dict], rel_err: float = 0.05) -> dict:
    """95% Student-t CIs + a recommended replication count for the headline KPIs.

    For each metric the per-replication samples give ``mean ± t·(s/√n)`` with the
    t critical value at ``df = n-1`` and ``s`` the *sample* stdev, plus
    ``n_recommended = ceil((t·s/(rel_err·|mean|))²)`` — the reps needed to reach a
    ±``rel_err`` (default ±5%) relative-error target. Never blocks: a single
    replication has no spread, so ``metrics`` is left empty (no CI); a metric with
    ~zero mean or zero spread skips the (undefined) recommended-count division.
    Purely additive/descriptive — it reads the samples, it does not change them."""
    n = len(per)
    out: dict = {"n": n, "confidence": 0.95, "rel_err_target": rel_err, "metrics": {}}
    if n < 2:
        return out  # single run → no interval to report (honest, never-blocks)
    t = _t95(n - 1)
    for key in CI_METRICS:
        xs = [float(p[key]) for p in per if isinstance(p.get(key), (int, float))]
        if len(xs) < 2:
            continue
        mean = statistics.fmean(xs)
        s = statistics.stdev(xs)                 # sample stdev (n-1 denominator)
        half = t * s / math.sqrt(len(xs))
        entry = {"mean": mean, "half_width": half, "std": s, "n": len(xs)}
        # Recommended reps for the ±rel_err target. Guard a ~zero mean (relative
        # error undefined) and a degenerate zero-spread sample (already tight).
        if s > 0 and abs(mean) > 1e-9:
            entry["n_recommended"] = max(1, math.ceil((t * s / (rel_err * abs(mean))) ** 2))
        else:
            entry["n_recommended"] = len(xs)
        out["metrics"][key] = entry
    return out


def _cost_params(res: RunResult, model: WarehouseModel | None) -> dict:
    """Resolve the cost inputs the KPI layer needs.

    First-class source is ``model.settings`` (a :class:`Settings`): the wage,
    the work-day shape, the per-AGV monthly cost and the currency all flow from
    there. When no model is supplied we fall back to whatever the engine packed
    into ``res.cost`` (legacy path), so existing callers keep identical numbers
    -- ``Settings`` is the *default* source, not the only one.

    Every divisor is clamped to a small positive so zero working
    hours/days never divides-by-zero.
    """
    c = res.cost or {}
    if model is not None:
        s: Settings = model.settings
        shift = max(float(s.working_hours_per_day), 1e-9)
        days = max(float(s.working_days_per_month), 1e-9)
        return {
            "labour_rate_per_hr": float(s.labor_cost_per_hour),
            "shift_hours_per_day": shift,
            "work_days_per_month": days,
            "currency": s.currency,
            # Flat per-AGV monthly cost (settings model): amortised capex is not
            # used in this mode; AGV opex is the per-month figure x fleet size.
            "agv_cost_per_month_each": float(s.agv_cost_per_month),
            "n_agvs": res.n_agvs,
            # Legacy fields retained for output parity (capex unknown here -> 0).
            "capex_total": 0.0,
            "opex_per_hr_total": 0.0,
            "amortize_months": 1,
            "settings_mode": True,
        }
    # Legacy: read whatever the engine packed (preserves current behaviour).
    return {
        "labour_rate_per_hr": c.get("labour_rate_per_hr", 0.0),
        "shift_hours_per_day": max(c.get("shift_hours_per_day", 8.0) or 8.0, 1e-9),
        "work_days_per_month": max(c.get("work_days_per_month", 25), 1),
        "currency": c.get("currency", "¥"),
        "agv_cost_per_month_each": 0.0,
        "n_agvs": res.n_agvs,
        "capex_total": c.get("capex_total", 0.0),
        "opex_per_hr_total": c.get("opex_per_hr_total", 0.0),
        "amortize_months": max(c.get("amortize_months", 36), 1),
        "settings_mode": False,
    }


# --- 通路干渉 (aisle congestion) ---------------------------------------------
# The waiting an agent does because someone else is already in the aisle cell it
# needs. Kept as ONE pure function over a raw event log rather than inline in
# ``_one``, because it is also the aggregation pipeline the queueing-theory
# cross-check exercises: feed it a single-server M/M/1 log and its mean wait must
# reproduce Wq = ρ/(μ-λ) (hence Lq = λ·Wq = ρ²/(1-ρ)). A statistic nobody can
# validate against a closed form is a statistic nobody should sell.

# How many worst cells the congestion read-out names. Enough to point at an aisle,
# short enough to read — the fix is always "widen/re-route THAT stretch".
TOP_CELLS = 10

# Congestion advisory threshold: waiting more than this share of travel time is a
# layout problem the proposal must disclose, not a rounding error.
CONGESTION_VERDICT_SHARE = 0.15


def wait_stats(events, travel_time_s: float = 0.0,
               wait_events: tuple[str, ...] = ("aisle_wait", "aisle_pass_forced"),
               top_n: int = TOP_CELLS) -> dict:
    """Aggregate 通路干渉 waiting out of a raw event log.

    ``travel_time_s`` is the agents' unencumbered travel time (what the walk would
    have cost with the aisles empty), so ``share`` answers 「移動時間のうち何割が
    待ちか」 against ``travel + wait`` — the total time actually spent getting
    around. With no travel measured it degrades to 0.0 rather than dividing by
    zero (never-blocks).

    A forced pass (the never-blocks escape from a stuck cell) waited too, so its
    seconds count towards the total while its COUNT is reported separately — a run
    that only gets through by forcing is not a run that flowed.

    Pure over the log: no model, no engine state. Zeros and an empty ``top_cells``
    for a run with no congestion events at all, which is every run with the
    feature off.
    """
    waits: list[float] = []
    forced = 0
    cells: dict[tuple, dict] = {}
    for e in events or ():
        if e.get("event") not in wait_events:
            continue
        wv = float(e.get("wait", 0.0) or 0.0)
        waits.append(wv)
        if e.get("event") == "aisle_pass_forced":
            forced += 1
        cell = e.get("cell")
        key = tuple(cell) if isinstance(cell, (list, tuple)) else (cell,)
        row = cells.setdefault(key, {"cell": list(key), "wait_s": 0.0, "hits": 0})
        row["wait_s"] += wv
        row["hits"] += 1
    total = sum(waits)
    denom = max(float(travel_time_s), 0.0) + total
    # Ties break on the cell's repr, not the cell itself: a hand-written event with
    # no ``cell`` yields ``[None]``, and comparing that against ``[3, 4]`` would
    # raise. A read-out must never be the thing that breaks the KPI call.
    top = sorted(cells.values(), key=lambda r: (-r["wait_s"], repr(r["cell"])))[:top_n]
    return {
        "wait_total_s": total,
        "wait_share": (total / denom) if denom > 1e-9 else 0.0,
        "waits": len(waits),
        "wait_mean_s": statistics.fmean(waits) if waits else 0.0,
        "wait_p95_s": _pct(waits, 0.95),
        "forced_passes": forced,
        "top_cells": top,
    }


def _congestion_kpis(events, travel_time_s: float) -> dict:
    """:func:`wait_stats` under the KPI layer's public key names."""
    s = wait_stats(events, travel_time_s)
    return {
        "congestion_wait_total_s": s["wait_total_s"],
        "congestion_wait_share": s["wait_share"],
        "congestion_waits": s["waits"],
        "congestion_wait_mean_s": s["wait_mean_s"],
        "congestion_wait_p95_s": s["wait_p95_s"],
        "congestion_forced_passes": s["forced_passes"],
        "congestion": {"top_cells": s["top_cells"]},
    }


def _merge_congestion(per: list[dict]) -> dict:
    """Average the congestion read-out across replications.

    ``compute``'s generic loop only averages TOP-LEVEL numerics, so without this
    the worst-cells table would silently report replication #1 alone — the same
    trap ``_merge_per_belt`` exists for. A cell absent from a rep contributes zero
    to that rep, so the mean is per-replication (comparable to the averaged
    totals beside it), not a sum over reps.
    """
    n = max(len(per), 1)
    acc: dict[tuple, dict] = {}
    for rep in per:
        for row in (rep or {}).get("top_cells", []) or []:
            key = tuple(row.get("cell") or ())
            cur = acc.setdefault(key, {"cell": list(key), "wait_s": 0.0, "hits": 0.0})
            cur["wait_s"] += float(row.get("wait_s", 0.0) or 0.0)
            cur["hits"] += float(row.get("hits", 0) or 0)
    top = [{"cell": v["cell"], "wait_s": v["wait_s"] / n, "hits": v["hits"] / n}
           for v in acc.values()]
    top.sort(key=lambda r: (-r["wait_s"], repr(r["cell"])))
    return {"top_cells": top[:TOP_CELLS]}


def _pct(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round(q * (len(s) - 1)))))
    return s[k]


def _one(res: RunResult, model: WarehouseModel | None = None) -> dict:
    arrived = sum(1 for e in res.events if e["event"] == "order_arrive")
    completes = [e for e in res.events if e["event"] == "order_complete"]
    completed = len(completes)
    hours = max(res.duration_s / 3600.0, 1e-9)

    cycles = [e["cycle"] for e in completes]
    dists = [e.get("dist", 0.0) for e in completes]
    picker_busy = sum(e.get("busy", 0.0) for e in res.events if e["event"] == "pick_done")
    packer_busy = sum(e.get("busy", 0.0) for e in res.events if e["event"] == "pack_done")
    agv_busy = sum(e.get("busy", 0.0) for e in res.events if e["event"] == "agv_done")
    pick_waits = [e.get("wait", 0.0) for e in res.events if e["event"] == "pick_start"]
    agv_util = agv_busy / max(res.n_agvs * res.duration_s, 1e-9) if res.n_agvs else 0.0
    # 入荷検品(inbound inspection) stage utilisation (when inspector agents exist).
    inspect_busy = sum(e.get("busy", 0.0) for e in res.events if e["event"] == "inspect_done")
    n_insp = getattr(res, "n_inspectors", 0)
    inspect_util = inspect_busy / max(n_insp * res.duration_s, 1e-9) if n_insp else 0.0

    # 種まき(sort) put-wall stage: utilisation and queueing at the wall.
    sort_events = [e for e in res.events if e["event"] == "sort_done"]
    sort_busy = sum(e.get("busy", 0.0) for e in sort_events)
    sort_waits = [e.get("wait", 0.0) for e in sort_events]
    sort_util = (sort_busy / max(res.n_put_wall * res.duration_s, 1e-9)
                 if res.n_put_wall else 0.0)

    # 自動仕分機(sorter) stage: throughput + utilisation + chute back-pressure.
    # Utilisation is busy vs the induction channels' capacity·duration (like any
    # capacitated resource). Populated only when an automatic sorter was active;
    # the manual put-wall KPIs above stay untouched.
    sorter_events = [e for e in res.events if e["event"] == "sorter_done"]
    sorter_busy = sum(e.get("busy", 0.0) for e in sorter_events)
    sorter_waits = [e.get("wait", 0.0) for e in sorter_events]
    sorter_channels = getattr(res, "sorter_channels", 0)
    sorter_util = (sorter_busy / max(sorter_channels * res.duration_s, 1e-9)
                   if sorter_channels else 0.0)
    sorter_lines = len(sorter_events)
    sorter_blocks = sum(e.get("blocked", 0) for e in sorter_events)

    # --- コンベア搬送 (conveyor transport) ------------------------------------
    # Populated only when a conveyor actually carried totes; every field is 0
    # otherwise — additive, no legacy KPI shifts. Utilisation integrates the EXACT
    # slot-occupancy step function (+1 at conveyor_on, -1 at conveyor_off) against
    # the total belt capacity, so accumulation (a tote holding its slot through
    # packing) and totes still riding at the end are both counted honestly.
    cv_on = [e for e in res.events if e["event"] == "conveyor_on"]
    cv_off = [e for e in res.events if e["event"] == "conveyor_off"]
    cv_cap = getattr(res, "conveyor_capacity", 0)
    cv_transits = [e.get("transit", 0.0) for e in cv_off]
    cv_waits = [e.get("wait", 0.0) for e in cv_on]
    cv_steps = sorted([(e["t"], 1) for e in cv_on] + [(e["t"], -1) for e in cv_off],
                      key=lambda p: (p[0], -p[1]))
    cv_area, _t, _occ = 0.0, 0.0, 0
    for t, delta in cv_steps:
        cv_area += _occ * (t - _t)
        _t, _occ = t, _occ + delta
    cv_area += _occ * max(res.duration_s - _t, 0.0)   # totes still on the belt at the end
    # A CHAINED line emits one on/off pair per BELT a tote rides, and a tote really
    # does hold a slot on each belt it is on, so summing the per-belt occupancy
    # against the summed capacity is exactly right — no leg is double-counted,
    # because the second leg's slot is a second physical slot.
    cv_util = cv_area / max(cv_cap * res.duration_s, 1e-9) if cv_cap else 0.0
    # 搬送し終えたトート数. On a chain each tote passes several belts, so only the
    # LAST leg is a completed transport (``last=1``); the legacy single-belt path
    # writes no such field and every leg is a last one — hence the default.
    cv_totes = sum(1 for e in cv_off if e.get("last", 1))
    # 詰まり: a boarding that had to WAIT is a slot that was not free, i.e. the belt
    # ahead is full. The ratio says how bad, the first one says when it started —
    # a line that jams 20 minutes in looks fine in a 10-minute run.
    cv_blocked = sum(1 for e in cv_on if e.get("blocked"))
    cv_block_ratio = cv_blocked / len(cv_on) if cv_on else 0.0
    cv_first_block = min((float(e["t"]) for e in cv_on if e.get("blocked")), default=None)
    # 選択停止ゲート(停止線): how many loads the gate held back. Only a belt with a
    # gate emits these, so this is 0 for every model that has none.
    cv_gate_stops = sum(1 for e in res.events if e["event"] == "conveyor_gate")

    # --- 容器の有限循環 (finite container pool) --------------------------------
    # Every field is 0 unless the model states a pool — additive, no legacy KPI
    # shifts. ``containers_in_use_peak`` (+ the time it happened) is the read-out
    # the customer buys against: 同時に使われた最大数 is the LOWER BOUND on how many
    # containers the operation has to own or rent, and it is a measurement of this
    # run rather than a rule of thumb. The in-use level only changes at take/return,
    # so the (t, level) series is an EXACT step function — integrate it for the
    # time-average (Little: L = λ·W against ``container_use_mean_s``).
    ct_take = [e for e in res.events if e["event"] == "container_take"]
    ct_ret = [e for e in res.events if e["event"] == "container_return"]
    ct_pool = max((int(e.get("pool", 0)) for e in ct_take), default=0)
    # Ties are ordered RETURN-then-TAKE, which is the causal order: a container
    # taken at the same instant one came back was taken BECAUSE it came back (the
    # SimPy put releases the waiting get at that time). Ordering it the other way
    # would report a peak of pool_size+1 — a number that cannot physically happen
    # and that would be read as "we need one more container". The integral is
    # identical either way (a tie spans zero time).
    ct_steps = sorted([(float(e["t"]), 1) for e in ct_take]
                      + [(float(e["t"]), -1) for e in ct_ret])
    ct_area, ct_peak, ct_peak_t, _t, _lvl = 0.0, 0, 0.0, 0.0, 0
    for t, delta in ct_steps:
        ct_area += _lvl * (t - _t)
        _t, _lvl = t, _lvl + delta
        if _lvl > ct_peak:
            ct_peak, ct_peak_t = _lvl, t
    ct_area += _lvl * max(res.duration_s - _t, 0.0)   # containers still out at the end
    ct_held = [float(e.get("held", 0.0)) for e in ct_ret]
    ct_waits = [float(e.get("wait", 0.0)) for e in ct_take]

    # --- 在庫補充連鎖 (DES-internal inventory & replenishment) ----------------
    # Populated only when replenishment was enabled (replenish_done / stockout_wait
    # events exist); otherwise every field is 0 — additive, no legacy KPI shifts.
    replen_events = [e for e in res.events if e["event"] == "replenish_done"]
    replen_busy = sum(e.get("busy", 0.0) for e in replen_events)
    n_repl = getattr(res, "n_replenishers", 0)
    replen_util = (replen_busy / max(n_repl * res.duration_s, 1e-9)) if n_repl else 0.0
    stockout_events = [e for e in res.events if e["event"] == "stockout_wait"]
    stockout_wait_times = [e.get("wait", 0.0) for e in stockout_events]

    # --- AGV通路相互排他・簡易干渉モデル ---------------------------------------
    # Populated only when the feature was enabled (agv_conflict / agv_deadlock_warning
    # events exist); otherwise every field is 0 — additive, no legacy KPI shifts.
    agv_conflict_events = [e for e in res.events if e["event"] == "agv_conflict"]
    agv_deadlock_events = [e for e in res.events if e["event"] == "agv_deadlock_warning"]
    agv_wait_s = (sum(e.get("wait", 0.0) for e in agv_conflict_events)
                  + sum(e.get("wait", 0.0) for e in agv_deadlock_events))

    # --- 通路干渉 (aisle congestion) -----------------------------------------
    # Populated only when ``simulation.aisle_interference`` was on (aisle_wait /
    # aisle_pass_forced events exist); otherwise every field is 0 and top_cells is
    # empty — additive, no legacy KPI shifts. The denominator is the pickers' own
    # unencumbered travel time (the only agent class whose distance the log
    # carries), so the share reads as 「移動時間のうち待ちの割合」.
    breakdown = _picker_breakdown(res, model, picker_busy, completed)
    congestion = _congestion_kpis(res.events, breakdown["picker_walk_s"])

    on_time = sum(
        1 for e in completes if e.get("due") is None or e["t"] <= e["due"]
    )

    pick_util = picker_busy / max(res.n_pickers * res.duration_s, 1e-9)
    pack_util = packer_busy / max(res.n_packers * res.duration_s, 1e-9)

    # --- 仮置き(staging) WIP: time-average + peak, dwell, picker block (BAS) -----
    # WIP only changes at staging put/get, so the (t, wip) series is an EXACT step
    # function -> integrate it for the true time-average (Little's law: L = λ·W).
    wip_pts = sorted(((e["t"], e.get("wip", 0)) for e in res.events
                      if e["event"] in ("staging_put", "staging_get")),
                     key=lambda p: p[0])
    wip_max = max((w for _, w in wip_pts), default=0)
    area, prev_t, prev_w = 0.0, 0.0, 0
    for t, w in wip_pts:
        area += prev_w * (t - prev_t)
        prev_t, prev_w = t, w
    area += prev_w * max(res.duration_s - prev_t, 0.0)   # carry last level to end
    wip_avg = area / max(res.duration_s, 1e-9)
    staging_dwells = [e.get("wait", 0.0) for e in res.events if e["event"] == "staging_get"]
    staging_dwell_mean = statistics.fmean(staging_dwells) if staging_dwells else 0.0
    # Picker time spent BLOCKED on a full staging buffer (kept out of `busy` so
    # utilisation is not inflated by back-pressure waiting).
    staging_block_time = sum(e.get("blocked", 0.0) for e in res.events
                             if e["event"] == "staging_block")

    # --- cost (robust to run duration: scale by fraction of a work-day) ------
    # NOTE: reuse the guarded `hours` from above (max(..., 1e-9)); recomputing it
    # unguarded here re-introduces a divide-by-zero for zero-duration runs.
    # Cost inputs are resolved through `model.settings` when a model is supplied
    # (first-class settings), else from the engine-packed `res.cost` (legacy).
    c = _cost_params(res, model)
    shift = max(c["shift_hours_per_day"], 1e-9)
    day_frac = max(hours / shift, 1e-9)          # work-days this run represents
    headcount = res.n_pickers + res.n_packers
    rate = c["labour_rate_per_hr"]
    labour_cost = headcount * hours * rate       # this window
    opex_cost = c["opex_per_hr_total"] * hours
    months = max(c["amortize_months"], 1)
    days = max(c["work_days_per_month"], 1)
    monthly_capex = c["capex_total"] / months
    capex_run = monthly_capex * (day_frac / days)   # capex attributable to window
    # AGV monthly cost: flat per-AGV figure x fleet size (settings mode). In the
    # legacy path this is 0 and AGV cost is folded into opex/capex above.
    agv_monthly = c["agv_cost_per_month_each"] * c["n_agvs"]
    agv_run = agv_monthly * (day_frac / days)       # AGV cost attributable to window
    total_cost_run = labour_cost + opex_cost + capex_run + agv_run
    cost_per_order = total_cost_run / completed if completed else 0.0
    daily_opex = (labour_cost + opex_cost) / day_frac   # one full work-day
    monthly_opex = daily_opex * days                    # operating only (no capex)
    monthly_cost = monthly_opex + monthly_capex + agv_monthly

    return {
        "orders_arrived": arrived,
        "orders_completed": completed,
        "completion_rate": completed / arrived if arrived else 1.0,
        "throughput_per_hr": completed / hours,
        "cycle_mean_s": statistics.fmean(cycles) if cycles else 0.0,
        "cycle_p50_s": _pct(cycles, 0.50),
        "cycle_p95_s": _pct(cycles, 0.95),
        "picker_utilization": pick_util,
        "packer_utilization": pack_util,
        "agv_utilization": agv_util,
        "agv_busy_s": agv_busy,
        # AGV通路相互排他: aisle-contention waiting + deadlock detection counters.
        "agv_wait_s": agv_wait_s,
        "agv_conflicts": len(agv_conflict_events),
        "agv_deadlock_warnings": len(agv_deadlock_events),
        "inspector_utilization": inspect_util,
        "n_inspectors": n_insp,
        "n_agvs": res.n_agvs,
        "sort_utilization": sort_util,
        "sort_busy_s": sort_busy,   # 種まき仕分けの総busy秒 (作業方法比較の y軸)
        "sort_wait_mean_s": statistics.fmean(sort_waits) if sort_waits else 0.0,
        "n_put_wall": res.n_put_wall,
        "sorter_utilization": sorter_util,
        "sorter_busy_s": sorter_busy,
        "sorter_throughput_per_hr": sorter_lines / hours,  # 仕分け能力 (行/時)
        "sorter_wait_mean_s": statistics.fmean(sorter_waits) if sorter_waits else 0.0,
        "sorter_chute_blocks": sorter_blocks,              # シュート閉塞(back-pressure)発生回数
        "sorter_lines": sorter_lines,
        "sorter_channels": sorter_channels,
        # コンベア搬送: 搬送数 / 平均搬送時間 / ジャム(待ち) / 稼働率.
        "conveyor_utilization": cv_util,
        "conveyor_totes": cv_totes,
        "conveyor_transit_mean_s": statistics.fmean(cv_transits) if cv_transits else 0.0,
        "conveyor_wait_mean_s": statistics.fmean(cv_waits) if cv_waits else 0.0,
        "conveyor_jams": sum(e.get("blocked", 0) for e in cv_on),
        "conveyor_capacity": cv_cap,
        # コンベア詰まり: how OFTEN a hand-over waited, and WHEN it first did.
        "conveyor_block_ratio": cv_block_ratio,
        "conveyor_time_to_first_block_s": cv_first_block,
        # 停止線で止めた荷の数 (0 = ゲート無し).
        "conveyor_gate_stops": cv_gate_stops,
        # 容器の有限循環: 保有数 / 投入待ち / 同時使用ピーク(＋その時刻) / 平均滞留.
        # ピークが「必要保有数の下限」— レンタル数量の根拠になる数字。
        "container_pool_size": ct_pool,
        "container_takes": len(ct_take),
        "container_returns": len(ct_ret),
        "container_waits": sum(1 for w in ct_waits if w > 1e-6),
        "container_wait_total_s": sum(ct_waits),
        "container_use_mean_s": statistics.fmean(ct_held) if ct_held else 0.0,
        "containers_in_use_avg": ct_area / max(res.duration_s, 1e-9),
        "containers_in_use_peak": ct_peak,
        "containers_in_use_peak_t": ct_peak_t,
        # ...and WHERE (per belt), which is the only read-out that points at the
        # 引き込み/本線 to fix rather than at "the conveyor".
        "conveyors": _per_belt(res, model, cv_on, cv_off),
        "n_conveyors": getattr(res, "n_conveyors", 0),
        "consolidation": res.consolidation,
        "pick_method": res.pick_method,
        "pick_wait_mean_s": statistics.fmean(pick_waits) if pick_waits else 0.0,
        # 在庫補充連鎖: 補充タスク数 / 補充稼働 / 補充要員稼働率 / 欠品待ち.
        "replenish_tasks": len(replen_events),
        "replenish_busy_s": replen_busy,
        "replenisher_utilization": replen_util,
        "n_replenishers": n_repl,
        "stockout_waits": len(stockout_events),
        "stockout_wait_mean_s": (statistics.fmean(stockout_wait_times)
                                 if stockout_wait_times else 0.0),
        "stockout_wait_total_s": sum(stockout_wait_times),
        "wip_avg": wip_avg,
        "wip_max": wip_max,
        "staging_dwell_mean_s": staging_dwell_mean,
        "staging_block_time_s": staging_block_time,
        "staging_capacity": res.staging_capacity,
        "walk_total_m": sum(dists),
        "walk_per_order_m": statistics.fmean(dists) if dists else 0.0,
        # 生産性の内訳 (要素作業分解): picker time = 移動 + 手扱い + 手待ち。
        # 移動 = pick trip distance ÷ 歩行速度; 手扱い = busy − 移動 (ピック+仕分+荷渡し);
        # 手待ち = 在席時間 − busy。エンジン変更なしでイベントログから純粋に導出。
        **breakdown,
        # 通路干渉: 待ち合計/割合/回数/p95 + 最混雑セル (top_cells).
        **congestion,
        # 経路拘束の実行時検査: how many replay legs went through the racking (0 on
        # a healthy layout; a non-zero count is surfaced in the verdict).
        "path_violations": len(getattr(res, "path_violations", None) or ()),
        # 経路グラフで解けず直線に縮退した移動 (取込レイアウトの通路が塞がって
        # いる兆候)。0 が健全。>0 のとき判定文が警告する。
        "unroutable_legs": float(getattr(res, "unroutable_legs", 0) or 0),
        # 実測生産性 (this layout) per process, for the 想定→実測 feedback loop.
        "measured_productivity": _measured_productivity(
            res, model, picker_busy, packer_busy, completed),
        "on_time_rate": on_time / completed if completed else 1.0,
        "headcount": headcount,
        "labour_cost_per_order": labour_cost / completed if completed else 0.0,
        "equipment_cost_per_order": (opex_cost + capex_run + agv_run) / completed
        if completed else 0.0,
        "total_cost_per_order": cost_per_order,
        "monthly_cost": monthly_cost,
        "monthly_opex": monthly_opex,
        "agv_monthly_cost": agv_monthly,
        "capex_total": c["capex_total"],
        "labour_rate_per_hr": rate,
        "currency": c["currency"],
    }


def _per_belt(res: RunResult, model: WarehouseModel | None,
              cv_on: list[dict], cv_off: list[dict]) -> dict:
    """Per-belt コンベア詰まり read-out — 1枚で「どのベルトで詰まっているか」.

    The line totals say the belt system is jammed; a chained line
    (検品ライン→本線→引き込み) needs to say WHERE, because the fix is different for
    each: a full 引き込み is a 梱包台 problem, a full 本線 is a line-speed problem.
    Every field is derived from the event log — the engine hard-codes no metric.

    Occupancy is integrated from the same +1/-1 step function as the line total,
    restricted to one belt; capacity comes from ``analytic.belt_slots``, the
    engine's own slot rule, so 「このベルトは8割埋まっている」 means the same thing in
    the estimate, in the run and here. Unknown capacity (a legacy caller with no
    model, or a belt that is no longer drawn) ⇒ ``capacity`` 0 and ``utilization``
    0.0, with every other field still reported — never blocks.
    """
    if not cv_on and not cv_off:
        return {}
    caps: dict[str, int] = {}
    if model is not None:
        try:
            from whsim.analytic import belt_slots
            caps = {str(cv.id): belt_slots(cv)
                    for cv in (model.resources.conveyors or [])}
        except Exception:      # noqa: BLE001 — a read-out must never break the KPIs
            caps = {}

    steps: dict[str, list[tuple[float, int]]] = {}
    stat: dict[str, dict] = {}
    for e in cv_on:
        b = str(e.get("conveyor", ""))
        d = stat.setdefault(b, {"boardings": 0, "blocked": 0, "waits": [], "first": None})
        d["boardings"] += 1
        d["waits"].append(float(e.get("wait", 0.0)))
        if e.get("blocked"):
            d["blocked"] += 1
            t = float(e["t"])
            if d["first"] is None or t < d["first"]:
                d["first"] = t
        steps.setdefault(b, []).append((float(e["t"]), 1))
    for e in cv_off:
        steps.setdefault(str(e.get("conveyor", "")), []).append((float(e["t"]), -1))

    out: dict[str, dict] = {}
    for belt, pts in steps.items():
        d = stat.get(belt) or {"boardings": 0, "blocked": 0, "waits": [], "first": None}
        area, peak, prev_t, occ = 0.0, 0, 0.0, 0
        # Ties are ordered RELEASE-then-BOARD, which is what physically happens
        # (the waiting request is granted the instant the slot is freed, at the
        # same sim time). The integral is identical either way — a tie spans zero
        # time — but the other order would report a peak ABOVE the belt's own slot
        # count, which reads as a broken KPI rather than a full belt.
        for t, delta in sorted(pts, key=lambda p: (p[0], p[1])):
            area += occ * (t - prev_t)
            prev_t, occ = t, occ + delta
            peak = max(peak, occ)
        area += occ * max(res.duration_s - prev_t, 0.0)   # still riding at the end
        cap = caps.get(belt, 0)
        out[belt] = {
            "utilization": (area / max(cap * res.duration_s, 1e-9)) if cap else 0.0,
            "peak_occupancy": peak,
            "capacity": cap,
            "boardings": d["boardings"],
            "blocked": d["blocked"],
            "block_ratio": d["blocked"] / d["boardings"] if d["boardings"] else 0.0,
            "time_to_first_block_s": d["first"],
            "wait_mean_s": statistics.fmean(d["waits"]) if d["waits"] else 0.0,
        }
    return out


def _merge_per_belt(per: list[dict]) -> dict:
    """Average the per-belt read-outs across replications.

    ``compute``'s generic loop can only average TOP-LEVEL numerics, so without
    this the per-belt view would silently report replication #1 only. A belt that
    never blocked in a given rep contributes no ``time_to_first_block_s`` (it has
    none), so that field is the mean over the reps where it DID block — and stays
    ``None`` when it never did, rather than being read as 0 s (「開始直後に詰まる」).
    """
    belts: list[str] = []
    for rep in per:
        for b in rep:
            if b not in belts:
                belts.append(b)
    out: dict[str, dict] = {}
    for b in belts:
        rows = [rep[b] for rep in per if b in rep]
        merged: dict = {}
        for key in rows[0]:
            vals = [r[key] for r in rows if isinstance(r.get(key), (int, float))]
            merged[key] = statistics.fmean(vals) if vals else None
        out[b] = merged
    return out


def _measured_productivity(res: RunResult, model: WarehouseModel | None,
                           picker_busy: float, packer_busy: float, completed: int) -> dict:
    """実測生産性 for the processes the DES actually simulates, in the SAME units as
    the analytic benchmark: the picking resource (行/h) and the packing resource
    (件/h). Rate = work done ÷ that resource's busy person-hours. Only populated
    where the sim provides it (busy>0); inbound/格納/出荷 keep the benchmark. The
    想定→実測 swap (生産性フィードバック) consumes this.

    The DES only models two staffed roles — pickers and packers — so we attach the
    two measured rates to the matching process ids in the editable master: the
    out_lines-driven 行/h process (default id ピッキング) and the out_orders-driven
    件/h process (default id 梱包). With no custom process list this resolves to the
    canonical ids, so output is byte-identical to the hardcoded version."""
    from whsim.analysis import staffing

    pick_id, pack_id = "ピッキング", "梱包"
    try:
        master = staffing.process_master(model)
        # Picking role: first 出荷-section process measured in 行/h driven by lines.
        for p in master:
            if p.get("driver") == "out_lines" and p.get("unit") == "行/h":
                pick_id = p["id"]
                break
        # Packing role: 件/h process driven by completed orders.
        for p in master:
            if p.get("driver") == "out_orders" and p.get("unit") == "件/h":
                pack_id = p["id"]
                break
    except Exception:  # noqa: BLE001 — never block; fall back to canonical ids.
        pick_id, pack_id = "ピッキング", "梱包"

    out: dict[str, float] = {}
    # Lines actually picked, as counted by the engine (``pick_done.lines``). This
    # used to be re-derived from ``model.orders.outbound`` and fell back to ONE
    # line per order when there were none -- but every bundled template is
    # profile-driven, so the fallback fired every time and understated 実測
    # productivity by the whole lines-per-order factor (35x on retail_dc). That
    # number feeds 「実測を採用」 -> productivity_overrides -> cost/timetable, so a
    # salesperson adopting it poisoned the cost model.
    events = getattr(res, "events", None) or ()
    lines_picked = sum(e.get("lines", 0) for e in events if e["event"] == "pick_done")
    if not lines_picked and completed > 0:
        # Legacy run (no ``lines`` on the event): fall back to the demand shape
        # the engine samples from, NOT to 1.
        orders = (model.orders.outbound if model else []) or []
        if orders:
            avg_lines = sum(len(o.lines) for o in orders) / len(orders)
        else:
            avg_lines = max(model.orders.profile.lines_per_order_mean, 1.0) if model else 1.0
        lines_picked = completed * avg_lines
    if picker_busy > 0 and completed > 0:
        out[pick_id] = round(lines_picked / (picker_busy / 3600.0), 1)  # 行/h
    if packer_busy > 0 and completed > 0:
        out[pack_id] = round(completed / (packer_busy / 3600.0), 1)     # 件/h
    return out


def _picker_breakdown(res: RunResult, model: WarehouseModel | None,
                      picker_busy: float, completed: int) -> dict:
    """要素作業分解 (the 生産性Sim essence): split picker presence time into
    移動 / 手扱い / 手待ち from the event log, plus orders per picker-hour.
    Pure over existing events — pick_done carries busy + trip dist."""
    speed = max((model.process.walk_speed_mps if model else 1.2) or 1.2, 0.1)
    trip_m = sum(e.get("dist", 0.0) for e in res.events if e["event"] == "pick_done")
    walk_s = trip_m / speed
    handle_s = max(0.0, picker_busy - walk_s)
    presence_s = res.n_pickers * res.duration_s
    idle_s = max(0.0, presence_s - picker_busy)
    picker_hours = max(presence_s / 3600.0, 1e-9)
    return {
        "picker_walk_s": walk_s,
        "picker_handle_s": handle_s,
        "picker_idle_s": idle_s,
        "picker_presence_s": presence_s,
        "orders_per_picker_hr": completed / picker_hours,
    }


def compute(results: list[RunResult], model: WarehouseModel | None = None) -> dict:
    """Average per-replication KPIs and add a plain-language verdict.

    When ``model`` is supplied, cost KPIs are sourced from ``model.settings``
    (first-class cost/ops settings); otherwise they fall back to the cost inputs
    the engine packed into each ``RunResult.cost`` (legacy, unchanged numbers).
    """
    per = [_one(r, model) for r in results]
    agg = {}
    for k in per[0]:
        # ``conveyor_time_to_first_block_s`` is numeric in a rep that blocked and
        # ``None`` in one that did not — the same run can hold BOTH (that is what
        # "at this demand it sometimes jams" looks like), so testing rep #1 alone
        # and fmean-ing would crash on the mixed case. It is merged below.
        if k == "conveyor_time_to_first_block_s":
            continue
        if isinstance(per[0][k], (int, float)):
            agg[k] = statistics.fmean(p[k] for p in per)
        else:
            agg[k] = per[0][k]  # non-numeric (e.g. pick_method): take first
    agg["replications"] = len(results)
    agg["n_pickers"] = results[0].n_pickers
    agg["n_packers"] = results[0].n_packers
    # コンベア詰まり: the two fields the generic loop above cannot average — a nested
    # dict (it would keep replication #1 only) and a "when" that is ``None`` when
    # the run never jammed (it would keep whatever rep #1 happened to say).
    agg["conveyors"] = _merge_per_belt([p["conveyors"] for p in per])
    # 通路干渉: same trap, same fix — the worst-cells table is a nested dict.
    agg["congestion"] = _merge_congestion([p["congestion"] for p in per])
    _firsts = [p["conveyor_time_to_first_block_s"] for p in per
               if isinstance(p["conveyor_time_to_first_block_s"], (int, float))]
    agg["conveyor_time_to_first_block_s"] = (statistics.fmean(_firsts)
                                             if _firsts else None)

    # Bottleneck = the busiest stage (pickers, pack stations, AGV fleet, or the
    # 種まき put wall when total picking is in use).
    stages = {"picking": agg["picker_utilization"], "packing": agg["packer_utilization"]}
    if agg.get("n_agvs"):
        stages["agv"] = agg["agv_utilization"]
    if agg.get("n_put_wall"):
        stages["sort"] = agg["sort_utilization"]
    if agg.get("sorter_channels"):
        stages["sorter"] = agg["sorter_utilization"]
    if agg.get("n_replenishers"):
        stages["replenish"] = agg["replenisher_utilization"]
    # コンベア搬送 is a real capacitated stage (its slots jam and back-pressure the
    # picker), so it competes for 'bottleneck' whenever a belt is in use.
    if agg.get("conveyor_capacity"):
        stages["conveyor"] = agg["conveyor_utilization"]
    agg["bottleneck"] = max(stages, key=stages.get)
    agg["bottleneck_utilization"] = stages[agg["bottleneck"]]
    agg["bottleneck_jp"] = {"picking": "ピッキング", "packing": "梱包",
                            "agv": "AGV搬送", "sort": "種まき仕分け",
                            "sorter": "ソーター仕分け", "replenish": "補充",
                            "conveyor": "コンベア搬送"}[agg["bottleneck"]]

    # --- Monte-Carlo robustness across replications -------------------------
    def _rep_bottleneck(p):
        s = {"picking": p["picker_utilization"], "packing": p["packer_utilization"]}
        if p.get("n_agvs"):
            s["agv"] = p["agv_utilization"]
        if p.get("n_put_wall"):
            s["sort"] = p["sort_utilization"]
        if p.get("sorter_channels"):
            s["sorter"] = p["sorter_utilization"]
        if p.get("n_replenishers"):
            s["replenish"] = p["replenisher_utilization"]
        if p.get("conveyor_capacity"):
            s["conveyor"] = p["conveyor_utilization"]
        return max(s.values())

    rep_ok = [1.0 if (p["completion_rate"] >= 0.98 and _rep_bottleneck(p) < 0.95)
              else 0.0 for p in per]
    robustness = statistics.fmean(rep_ok)        # fraction of runs that cope
    agg["robustness"] = robustness
    tputs = sorted(p["throughput_per_hr"] for p in per)
    agg["throughput_p5"] = _pct(tputs, 0.05)
    agg["throughput_p95"] = _pct(tputs, 0.95)
    agg["throughput_std"] = statistics.pstdev(tputs) if len(tputs) > 1 else 0.0
    comp = sorted(p["completion_rate"] for p in per)
    agg["completion_p5"] = _pct(comp, 0.05)

    # 信頼区間 + 推奨レプリケーション数: turn the per-rep spread into a 95% CI for
    # the headline KPIs so a 荷主 can see "how solid is this number" — the trust
    # signal commercial tools (FlexSim/AutoStat) show. Additive & never-blocks
    # (n=1 → empty ``metrics``, no CI). See ``_confidence_intervals``.
    agg["ci"] = _confidence_intervals(per)

    can_handle = robustness >= 0.9  # robust across the stochastic order sequences
    agg["can_handle_demand"] = can_handle
    util_pct = round(agg["bottleneck_utilization"] * 100)
    done_pct = round(agg["completion_rate"] * 100)
    n = len(results)
    conf = f"（{n}回中{round(robustness * n)}回が安定処理）" if n > 1 else ""
    agg["verdict"] = (
        f"対応可能 — {agg['bottleneck_jp']}工程の稼働率 {util_pct}% で需要をさばけます{conf}"
        if can_handle else
        f"要注意 — {agg['bottleneck_jp']}がボトルネック（稼働率 {util_pct}%）。"
        f"オーダーの {done_pct}% しか出荷完了しません{conf}"
    )
    # 在庫補充連鎖: when pickers spent meaningful time BLOCKED on empty pick faces
    # (欠品待ち that the picking cycle can feel), append an honest advisory — the
    # under-estimated replenishment-labour risk this feature exists to surface.
    if agg.get("n_replenishers") and agg.get("stockout_waits"):
        picker_secs = max(agg.get("picker_presence_s", 0.0), 1e-9)
        stockout_share = agg.get("stockout_wait_total_s", 0.0) / picker_secs
        if stockout_share >= 0.02:  # ≥2% of picker presence lost to 欠品待ち
            agg["verdict"] += (
                "。補充が追いつかずピッキングが待たされています"
                "（補充要員/間口在庫の見直し）"
            )
    # AGV通路相互排他: when AGV aisle-contention waiting is material (>5% of the AGV
    # fleet's busy time), surface the honest "頭打ち" advisory. Off ⇒ agv_wait_s==0
    # ⇒ no fragment ⇒ byte-identical verdict.
    agv_busy_s = agg.get("agv_busy_s", 0.0)
    if agv_busy_s > 0 and agg.get("agv_wait_s", 0.0) > 0.05 * agv_busy_s:
        agg["verdict"] += "。AGVの通路待ちが発生しています（台数/レイアウトの見直し余地）"
    # コンベア詰まり: a line that fills up is the last thing a proposal should let
    # the customer discover on site. Fires on a material block rate OR on any block
    # inside the horizon at all — a line that starts jamming at minute 40 of a
    # 60-minute run is a jammed line, not a rounding error — and names the belt it
    # started on, because 引き込みが満杯 and 本線が遅い need different fixes. No belt
    # in use ⇒ no blocks ⇒ nothing appended (additive, verdict byte-identical).
    first_block = agg.get("conveyor_time_to_first_block_s")
    if agg.get("conveyor_capacity") and (
            agg.get("conveyor_block_ratio", 0.0) > 0.05 or first_block is not None):
        belts = [(v.get("time_to_first_block_s"), b)
                 for b, v in (agg.get("conveyors") or {}).items()
                 if isinstance(v.get("time_to_first_block_s"), (int, float))]
        when = (f"最初の詰まり: {first_block / 60:.0f}分" if first_block is not None
                else f"手待ち率 {agg['conveyor_block_ratio'] * 100:.0f}%")
        where = f", ベルト{min(belts)[1]}" if belts else ""
        agg["verdict"] += f"。コンベアに滞留が出ています（{when}{where}）"
    # 容器の有限循環: the pool is a constraint you can BUY your way out of, so it must
    # never hide inside "throughput was low". The peak is the number the customer
    # orders against (必要保有数の下限), and 投入待ち says the pool is already short.
    # No pool stated ⇒ size 0 ⇒ nothing appended (verdict byte-identical).
    if agg.get("container_pool_size"):
        peak = agg.get("containers_in_use_peak", 0.0)
        at_min = agg.get("containers_in_use_peak_t", 0.0) / 60.0
        agg["verdict"] += (f"。容器は同時最大 {peak:.0f} 個使用"
                           f"（{at_min:.0f}分時点・保有 {agg['container_pool_size']:.0f} 個）")
        if agg.get("container_wait_total_s", 0.0) > 0.0:
            agg["verdict"] += (
                f"。容器待ちで投入が止まった時間 {agg['container_wait_total_s'] / 60.0:.0f}分"
                "（容器を増やせば解消します）")
    # 通路干渉: when agents spend a material share of their travel time queueing
    # behind each other, say so AND say where — 「通路が狭い」 is not actionable,
    # 「この座標の通路」 is. Off (or an uncongested floor) ⇒ share 0 ⇒ nothing
    # appended, so the verdict stays byte-identical. The cell is reported at its
    # centre in floor metres, using the same lattice pitch the engine contended on.
    if agg.get("congestion_wait_share", 0.0) > CONGESTION_VERDICT_SHARE:
        pct = round(agg["congestion_wait_share"] * 100)
        grid = float(getattr(model.simulation, "heatmap_grid_m", 1.0) or 1.0) if model else 1.0
        top = (agg.get("congestion") or {}).get("top_cells") or []
        where = ""
        if top and len(top[0].get("cell") or ()) == 2:
            cx, cy = top[0]["cell"]
            where = f"（最混雑: 約 ({(cx + 0.5) * grid:.0f}, {(cy + 0.5) * grid:.0f}) m 付近）"
        agg["verdict"] += f"。通路の混雑で移動時間の {pct}% が待ちです{where}"
    # 経路拘束: an agent drawn walking THROUGH a rack means the routing graph did
    # not see that rack, so the travel behind every number in this run is
    # understated. That is a correctness warning, not a tuning hint.
    if agg.get("unroutable_legs"):
        agg["verdict"] += (
            f"。⚠ 通路グラフで解決できず直線距離に縮退した移動が "
            f"{agg['unroutable_legs']:.0f} 件あります"
            "（取込レイアウトの通路が塞がっていないか確認してください）")
    if agg.get("path_violations"):
        agg["verdict"] += (
            f"。⚠ 経路が棚を貫通しています（{agg['path_violations']:.0f}件）"
            "— レイアウトの棚定義を確認してください"
        )
    return agg
