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
        "inspector_utilization": inspect_util,
        "n_inspectors": n_insp,
        "n_agvs": res.n_agvs,
        "sort_utilization": sort_util,
        "sort_busy_s": sort_busy,   # 種まき仕分けの総busy秒 (作業方法比較の y軸)
        "sort_wait_mean_s": statistics.fmean(sort_waits) if sort_waits else 0.0,
        "n_put_wall": res.n_put_wall,
        "consolidation": res.consolidation,
        "pick_method": res.pick_method,
        "pick_wait_mean_s": statistics.fmean(pick_waits) if pick_waits else 0.0,
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
        **_picker_breakdown(res, model, picker_busy, completed),
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
    orders = (model.orders.outbound if model else []) or []
    avg_lines = (sum(len(o.lines) for o in orders) / len(orders)) if orders else 1.0
    if picker_busy > 0 and completed > 0:
        lines_picked = completed * avg_lines
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
        if isinstance(per[0][k], (int, float)):
            agg[k] = statistics.fmean(p[k] for p in per)
        else:
            agg[k] = per[0][k]  # non-numeric (e.g. pick_method): take first
    agg["replications"] = len(results)
    agg["n_pickers"] = results[0].n_pickers
    agg["n_packers"] = results[0].n_packers

    # Bottleneck = the busiest stage (pickers, pack stations, AGV fleet, or the
    # 種まき put wall when total picking is in use).
    stages = {"picking": agg["picker_utilization"], "packing": agg["packer_utilization"]}
    if agg.get("n_agvs"):
        stages["agv"] = agg["agv_utilization"]
    if agg.get("n_put_wall"):
        stages["sort"] = agg["sort_utilization"]
    agg["bottleneck"] = max(stages, key=stages.get)
    agg["bottleneck_utilization"] = stages[agg["bottleneck"]]
    agg["bottleneck_jp"] = {"picking": "ピッキング", "packing": "梱包",
                            "agv": "AGV搬送", "sort": "種まき仕分け"}[agg["bottleneck"]]

    # --- Monte-Carlo robustness across replications -------------------------
    def _rep_bottleneck(p):
        s = {"picking": p["picker_utilization"], "packing": p["packer_utilization"]}
        if p.get("n_agvs"):
            s["agv"] = p["agv_utilization"]
        if p.get("n_put_wall"):
            s["sort"] = p["sort_utilization"]
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
    return agg
