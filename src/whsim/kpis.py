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
    pick_waits = [e.get("wait", 0.0) for e in res.events if e["event"] == "pick_start"]

    on_time = sum(
        1 for e in completes if e.get("due") is None or e["t"] <= e["due"]
    )

    pick_util = picker_busy / max(res.n_pickers * res.duration_s, 1e-9)
    pack_util = packer_busy / max(res.n_packers * res.duration_s, 1e-9)

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
        "pick_wait_mean_s": statistics.fmean(pick_waits) if pick_waits else 0.0,
        "walk_total_m": sum(dists),
        "walk_per_order_m": statistics.fmean(dists) if dists else 0.0,
        "on_time_rate": on_time / completed if completed else 1.0,
    }


def compute(results: list[RunResult]) -> dict:
    """Average per-replication KPIs and add a plain-language verdict."""
    per = [_one(r) for r in results]
    keys = per[0].keys()
    agg = {k: statistics.fmean(p[k] for p in per) for k in keys}
    agg["replications"] = len(results)
    agg["n_pickers"] = results[0].n_pickers
    agg["n_packers"] = results[0].n_packers

    # Bottleneck = the busiest stage.
    if agg["packer_utilization"] >= agg["picker_utilization"]:
        agg["bottleneck"] = "packing"
        agg["bottleneck_utilization"] = agg["packer_utilization"]
    else:
        agg["bottleneck"] = "picking"
        agg["bottleneck_utilization"] = agg["picker_utilization"]
    agg["bottleneck_jp"] = {"picking": "ピッキング", "packing": "梱包"}[agg["bottleneck"]]

    can_handle = agg["completion_rate"] >= 0.98 and agg["bottleneck_utilization"] < 0.95
    agg["can_handle_demand"] = can_handle
    util_pct = round(agg["bottleneck_utilization"] * 100)
    done_pct = round(agg["completion_rate"] * 100)
    agg["verdict"] = (
        f"対応可能 — {agg['bottleneck_jp']}工程の稼働率 {util_pct}% で需要をさばけます"
        if can_handle else
        f"要注意 — {agg['bottleneck_jp']}がボトルネック（稼働率 {util_pct}%）。"
        f"オーダーの {done_pct}% しか出荷完了しません"
    )
    return agg
