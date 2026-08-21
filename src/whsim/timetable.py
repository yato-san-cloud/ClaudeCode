"""Work-timetable solver: volume-flow-constrained staffing over a time axis.

Ported faithfully from the standalone ``timetable_solver.html`` tool (v1.1). Given
per-process volumes (物量), productivities (生産性) and a process master with work
bands + dependencies, it solves the **30-minute slot × process × headcount**
allocation that meets the day's volume under dependency-flow constraints, and
totals it into required/assigned man-hours, peak headcount and warnings.

This is a pure function over plain dicts (the documented JSON contract from the
handover doc), so it is independently testable and mirrors the browser-side
``static/js/timetable_solver.js`` (a parity test keeps the two in lock-step).

Data-model contract (Japanese keys are the contract — do not anglicise):
  process:      id, section, worker_type, default_時間帯[start,end],
                productivity_key, volume_key|None, volume_unit, 配置方式, 固定人数, 依存[]
  productivity: {key: {篁採用値, 単位, fixed_hours}}
  scenario:     {物量: {volume_key: n}, 制約: {ピーク人数上限, Fマン上限, PT上限}}

The solve RESULT uses English keys (clean Python / API payload); see ``solve``.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

# 30-minute slots over a 0:00–30:00 axis (logistics days run past midnight).
SLOT_MINUTES = 30
DAY_END_MINUTES = 1800  # 30:00 — last shift can spill into the next morning.

_DATA_DIR = Path(__file__).resolve().parent / "data" / "timetable"

# Section → display colour (mirrors the original tool's SECTION_COLOR) and the
# whsim layout zone type a section maps onto, so the 2D/3D views can place the
# timetable's per-slot headcount into the right zone (the 時刻連動 feature).
SECTION_COLOR = {
    "入荷": "#fbbf24",
    "出荷ケース": "#3b82f6",
    "出荷バラ": "#10b981",
    "ステージング": "#f97316",
    "間接": "#6b7280",
}
# Map a timetable section onto a whsim layout zone type (ZONE_JP keys), so the
# staffing map can place each section's per-slot headcount into the right zone.
# 間接 (indirect) has no warehouse zone → the UI draws it in a fallback strip.
SECTION_ZONE_TYPE = {
    "入荷": "receiving",
    "出荷ケース": "storage",
    "出荷バラ": "picking",
    "ステージング": "staging",
    "間接": "office",
}


# --- time helpers -----------------------------------------------------------
def time_to_min(s: str) -> int:
    h, m = (int(x) for x in s.split(":"))
    return h * 60 + m


def min_to_time(m: int) -> str:
    h = int(m // 60)
    mm = int(m % 60)
    return f"{h:02d}:{mm:02d}"


def generate_slots() -> list[int]:
    return list(range(0, DAY_END_MINUTES, SLOT_MINUTES))


# --- data loading -----------------------------------------------------------
def load_seed() -> dict:
    """Load the bundled seed dataset (the ローソン PG1 master + 3 scenarios)."""
    processes = json.loads((_DATA_DIR / "process.json").read_text("utf-8"))
    productivity = json.loads((_DATA_DIR / "productivity.json").read_text("utf-8"))
    scenarios = json.loads((_DATA_DIR / "scenarios.json").read_text("utf-8"))
    return {"processes": processes, "productivity": productivity, "scenarios": scenarios}


# --- solver -----------------------------------------------------------------
def topological_sort(processes: list[dict]) -> list[dict]:
    """Order processes so every dependency precedes its dependents.

    A ``visited`` set both deduplicates and breaks any accidental cycle (a cyclic
    edge is simply dropped rather than recursing forever)."""
    sorted_out: list[dict] = []
    visited: set[str] = set()
    proc_map = {p["id"]: p for p in processes}

    def visit(p: dict) -> None:
        if p["id"] in visited:
            return
        visited.add(p["id"])
        for dep in p.get("依存", []) or []:
            dep_proc = proc_map.get(dep)
            if dep_proc is not None:
                visit(dep_proc)
        sorted_out.append(p)

    for p in processes:
        visit(p)
    return sorted_out


def solve(scenario: dict, processes: list[dict], productivity: dict) -> dict:
    """Volume-flow-constrained staffing allocation (v2 logic, ported 1:1).

    Two placement modes per process:
      * ``dynamic``  — headcount = ceil(remaining_volume / productivity / remaining_h),
        capped each slot so a process can never run ahead of its dependency's
        cumulative progress (the volume-flow constraint).
      * ``fixed_n``  — a constant headcount across the whole work band (indirect
        work, inspection, etc.); no dependency constraint.

    Returns a result dict with English keys; per-slot arrays are length len(slots).
    """
    slots = generate_slots()
    n_slots = len(slots)
    result: dict = {
        "slots": slots,
        "processes": [],
        "headcount_by_slot": [0] * n_slots,
        "total_required_hours": 0.0,
        "total_assigned_hours": 0.0,
        "warnings": [],
    }

    sorted_processes = topological_sort(processes)
    cumulative_map: dict[str, list[float]] = {}  # proc.id -> cumulative at each slot end
    volumes = scenario.get("物量", {}) or {}

    for proc in sorted_processes:
        prod = productivity.get(proc["productivity_key"])
        if not prod:
            result["warnings"].append(
                f"生産性マスタに {proc['productivity_key']} がない (工程: {proc['id']})"
            )
            continue

        has_volume = proc.get("volume_key") is not None and not prod.get("fixed_hours")
        mode = proc.get("配置方式") or ("dynamic" if has_volume else "fixed_n")
        # A process with no volume cannot be 'dynamic' → force fixed_n.
        if mode == "dynamic" and not has_volume:
            result["warnings"].append(f"{proc['id']}: 物量定義がないため「固定人数」モードに自動切替")
            mode = "fixed_n"

        target_volume = (volumes.get(proc["volume_key"], 0) if has_volume else None)
        rate = (prod["篁採用値"] if has_volume else None)

        start = time_to_min(proc["default_時間帯"][0])
        end = time_to_min(proc["default_時間帯"][1])
        band_hours = (end - start) / 60

        fixed_count = proc.get("固定人数", 1) or 1
        if mode == "fixed_n":
            required_hours = fixed_count * band_hours
        else:
            required_hours = target_volume / rate

        headcounts = [0] * n_slots
        cumulative = [0.0] * (n_slots + 1)

        if mode == "fixed_n":
            n = fixed_count
            cum = 0.0
            for i, t in enumerate(slots):
                if start <= t < end:
                    headcounts[i] = n
                    if has_volume:
                        cum += n * rate * 0.5
                cumulative[i + 1] = cum
            if has_volume and target_volume > 0 and cum < target_volume * 0.99:
                result["warnings"].append(
                    f"{proc['id']} [固定人数]: 物量未達 (目標{target_volume:.0f} → 配置{cum:.0f}、"
                    f"達成率{cum / target_volume * 100:.0f}%)"
                )
            elif has_volume and target_volume > 0 and cum > target_volume * 1.1:
                result["warnings"].append(
                    f"{proc['id']} [固定人数]: 物量過剰 (目標{target_volume:.0f} → 配置{cum:.0f}、"
                    f"達成率{cum / target_volume * 100:.0f}%) ← 人数を減らせます"
                )
        else:
            cum = 0.0
            deps = proc.get("依存") or []   # defined up-front: a 0-volume dynamic
            # process skips the slot loop entirely, so `deps` must already exist.
            for i, t in enumerate(slots):
                if t < start or t >= end:
                    cumulative[i + 1] = cum
                    continue
                remaining = target_volume - cum
                if remaining <= 0:
                    cumulative[i + 1] = cum
                    continue
                remaining_h = ((end - t) / 30) * 0.5
                need = max(1, math.ceil(remaining / rate / remaining_h))

                if deps:
                    max_dep_throughput = math.inf
                    for dep_id in deps:
                        dep_cum_arr = cumulative_map.get(dep_id)
                        if not dep_cum_arr:
                            continue
                        dep_cum = dep_cum_arr[i + 1]
                        dep = next((p for p in sorted_processes if p["id"] == dep_id), None)
                        if dep is None:
                            continue
                        dep_prod = productivity.get(dep["productivity_key"], {})
                        dep_has_volume = (
                            dep.get("volume_key") is not None and not dep_prod.get("fixed_hours")
                        )
                        if not dep_has_volume:
                            continue  # volume-less dependency (indirect) imposes no flow cap
                        dep_target = volumes.get(dep["volume_key"], 1) or 1
                        progress = dep_cum / dep_target
                        own_possible_cum = progress * target_volume
                        own_possible_input = max(0.0, own_possible_cum - cum)
                        if own_possible_input < max_dep_throughput:
                            max_dep_throughput = own_possible_input
                    if max_dep_throughput < math.inf:
                        max_possible = math.floor(max_dep_throughput / rate / 0.5)
                        need = min(need, max_possible)
                        if need < 0:
                            need = 0
                headcounts[i] = need
                cum += need * rate * 0.5
                cumulative[i + 1] = cum
            if cum < target_volume * 0.99:
                result["warnings"].append(
                    f"{proc['id']} [動的]: 物量未達 (目標{target_volume:.0f} → 配置{cum:.0f}、"
                    f"達成率{cum / target_volume * 100:.0f}%)。作業帯/依存制約を確認"
                )

        assigned_hours = sum(headcounts) * 0.5
        achieved_volume = cumulative[-1] if has_volume else None

        result["processes"].append({
            "id": proc["id"],
            "section": proc["section"],
            "worker_type": proc["worker_type"],
            "mode": mode,
            "fixed_count": fixed_count,
            "deps": deps if mode == "dynamic" else (proc.get("依存") or []),
            "target_volume": target_volume,
            "productivity": rate,
            "unit": prod.get("単位"),
            "required_hours": required_hours,
            "peak": max(headcounts),
            "assigned_hours": assigned_hours,
            "achieved_volume": achieved_volume,
            "diff": assigned_hours - required_hours,
            "headcounts": headcounts,
            "cumulative": cumulative,
            "band": [proc["default_時間帯"][0], proc["default_時間帯"][1]],
        })
        for i, n in enumerate(headcounts):
            result["headcount_by_slot"][i] += n
        result["total_required_hours"] += required_hours
        result["total_assigned_hours"] += assigned_hours
        cumulative_map[proc["id"]] = cumulative

    constraints = scenario.get("制約", {}) or {}
    cap = constraints.get("ピーク人数上限")
    if cap:
        mx = max(result["headcount_by_slot"])
        if mx > cap:
            idx = result["headcount_by_slot"].index(mx)
            result["warnings"].append(
                f"総人数ピーク {mx}名 が上限 {cap}名 を超過 ({min_to_time(slots[idx])}〜)"
            )

    result["peak_headcount"] = max(result["headcount_by_slot"])
    result["peak_slot_index"] = result["headcount_by_slot"].index(result["peak_headcount"])

    # Per worker_type subtotals (PT / Fマン / …).
    worker_types = list(dict.fromkeys(p["worker_type"] for p in processes))
    by_worker: dict[str, dict] = {
        w: {"by_slot": [0] * n_slots, "total_hours": 0.0, "peak": 0} for w in worker_types
    }
    for r in result["processes"]:
        wt = r["worker_type"]
        if wt not in by_worker:
            continue
        for i, n in enumerate(r["headcounts"]):
            by_worker[wt]["by_slot"][i] += n
        by_worker[wt]["total_hours"] += r["assigned_hours"]
    for w in worker_types:
        by_worker[w]["peak"] = max(by_worker[w]["by_slot"]) if by_worker[w]["by_slot"] else 0
    result["by_worker_type"] = by_worker

    # Present in master order (topological_sort reorders for computation only).
    order = {p["id"]: i for i, p in enumerate(processes)}
    result["processes"].sort(key=lambda r: order.get(r["id"], 1_000_000))
    return result
