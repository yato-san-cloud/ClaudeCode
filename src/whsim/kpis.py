"""Derive KPIs from the raw event log (the engine never hard-codes metrics)."""

from __future__ import annotations

import statistics

from whsim.engine.run import RunResult


def _pct(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round(q * (len(s) - 1)))))
    return s[k]


def _one(res: RunResult) -> dict:
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

    # --- cost (robust to run duration: scale by fraction of a work-day) ------
    c = res.cost or {}
    hours = res.duration_s / 3600.0
    shift = c.get("shift_hours_per_day", 8.0) or 8.0
    day_frac = max(hours / shift, 1e-9)          # work-days this run represents
    headcount = res.n_pickers + res.n_packers
    labour_cost = headcount * hours * c.get("labour_rate_per_hr", 0.0)  # this window
    opex_cost = c.get("opex_per_hr_total", 0.0) * hours
    months = max(c.get("amortize_months", 36), 1)
    days = max(c.get("work_days_per_month", 25), 1)
    monthly_capex = c.get("capex_total", 0.0) / months
    capex_run = monthly_capex * (day_frac / days)   # capex attributable to window
    total_cost_run = labour_cost + opex_cost + capex_run
    cost_per_order = total_cost_run / completed if completed else 0.0
    daily_opex = (labour_cost + opex_cost) / day_frac   # one full work-day
    monthly_opex = daily_opex * days                    # operating only (no capex)
    monthly_cost = monthly_opex + monthly_capex

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
        "n_agvs": res.n_agvs,
        "sort_utilization": sort_util,
        "sort_wait_mean_s": statistics.fmean(sort_waits) if sort_waits else 0.0,
        "n_put_wall": res.n_put_wall,
        "consolidation": res.consolidation,
        "pick_method": res.pick_method,
        "pick_wait_mean_s": statistics.fmean(pick_waits) if pick_waits else 0.0,
        "walk_total_m": sum(dists),
        "walk_per_order_m": statistics.fmean(dists) if dists else 0.0,
        "on_time_rate": on_time / completed if completed else 1.0,
        "headcount": headcount,
        "labour_cost_per_order": labour_cost / completed if completed else 0.0,
        "equipment_cost_per_order": (opex_cost + capex_run) / completed if completed else 0.0,
        "total_cost_per_order": cost_per_order,
        "monthly_cost": monthly_cost,
        "monthly_opex": monthly_opex,
        "capex_total": c.get("capex_total", 0.0),
        "labour_rate_per_hr": c.get("labour_rate_per_hr", 0.0),
        "currency": c.get("currency", "¥"),
    }


def compute(results: list[RunResult]) -> dict:
    """Average per-replication KPIs and add a plain-language verdict."""
    per = [_one(r) for r in results]
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
