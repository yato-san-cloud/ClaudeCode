"""Analytic staffing SOLVER (人員タイムチャート — 解析的ソルバー).

Split out of the :mod:`whsim.analysis.staffing` package (its ``__init__`` re-
exports every symbol, so ``from whsim.analysis import staffing`` and
``staffing.solve_staffing`` keep working unchanged). You set an operating
window (start–end hour) and a headcount cap (global and/or per-process); the
solver pulls library productivity (3-tier), splits the day's volume into HOURLY
buckets per process, and analytically iterates a few passes to find the per-
bucket headcount that clears the day under the cap, honouring process precedence
(入荷→格納, ピッキング→梱包→出荷) and a placement choice (前詰め=front-load vs
均等=level-load), plus batch-arrival and shift/break overlays. Deterministic,
fast, no DES.
"""

from __future__ import annotations

import math

from .profile import (
    _FLOW_DEPS,
    process_deps,
    process_master,
    resolve_productivity,
)


_SOLVE_PASSES = 4  # analytic balancing passes (precedence settles in a few sweeps)


def default_dependencies() -> dict[str, list[str]]:
    """The default precedence DAG (process_id -> upstream ids) the UI seeds."""
    return {pid: list(ups) for pid, ups in _FLOW_DEPS.items()}


def batch_arrival_curve(batch_list: list[dict], hours: list[int]) -> list[float] | None:
    """Cumulative AVAILABLE fraction (0..1) per hour from a バッチ投入スケジュール.

    A batch schedule is how a batch-based operation actually releases work: a few
    `{"hour": H, "pct": P}` entries, e.g. 入荷 08:00→70% / 12:00→20% / 15:00→10%,
    or a single noon batch (12:00→100%). The work for each chunk can only start
    once that batch has landed, so this returns the cumulative fraction that has
    arrived by the END of each hour in `hours` (a batch landing AT hour H is usable
    during hour H). Percentages are normalised by their own total so the day always
    clears (never-blocks). A batch whose hour falls OUTSIDE the window is clamped
    into it (before-start → arrives at open; at/after-close → the last hour), so the
    cumulative ALWAYS reaches 1.0 and a misplaced batch never strands volume / fakes
    infeasibility. Returns None when there is no usable schedule (→ caller imposes no
    arrival gate, i.e. all volume is available from the start, as before)."""
    if not hours:
        return None
    lo, hi = hours[0], hours[-1]
    pts: list[tuple[int, float]] = []
    for b in batch_list or []:
        try:
            h = int(b.get("hour", b.get("time", b.get("h"))))
            p = float(b.get("pct", b.get("percent", b.get("share", 0))) or 0)
        except (TypeError, ValueError):
            continue
        if p > 0:
            pts.append((min(max(h, lo), hi), p))   # clamp into [open, close]
    if not pts:
        return None
    total = sum(p for _, p in pts) or 1.0
    return [min(1.0, sum(p for bh, p in pts if bh <= h) / total) for h in hours]


def _shift_plan_caps(
    shift_plan: dict | None, hours: list[int]
) -> tuple[list[float], list[float], bool]:
    """From a シフト・休憩 plan derive per-hour total-headcount ceilings and wages.

    Returns ``(hour_caps, hour_wages, active)`` aligned to ``hours``:

      * ``hour_caps[i]``  — the additional per-hour TOTAL headcount ceiling for
        ``hours[i]`` (``math.inf`` = no shift-plan constraint that hour):
          - a BREAK hour (any break's [start,end) covers it) → ``0`` (no work);
          - SHIFTS defined → Σ ``max_workers`` of the shifts covering that hour
            (``0`` when shifts exist but none cover it ⇒ the hour is closed);
          - no shifts defined → ``math.inf`` (unlimited, legacy).
      * ``hour_wages[i]`` — ¥/人時 for ``hours[i]``: the FIRST (list order) shift
        covering it, else ``default_wage_per_hr``.
      * ``active`` — True iff the plan carries any break or shift (so an empty/None
        plan leaves the solver byte-identical: the caller skips every override).

    Hours are compared as raw clock integers, so a window spilling past midnight
    (``end_hour`` > 24) simply won't match a 0–23 shift band unless the band is
    authored with the matching >24 hours — never blocks, just no coverage.
    """
    plan = shift_plan if isinstance(shift_plan, dict) else {}
    breaks = plan.get("breaks") or []
    shifts = plan.get("shifts") or []
    active = bool(breaks or shifts)
    default_wage = 0.0
    try:
        default_wage = float(plan.get("default_wage_per_hr") or 0) or 0.0
    except (TypeError, ValueError):
        default_wage = 0.0

    def _rng(d: dict) -> tuple[float, float]:
        try:
            return float(d.get("start", 0) or 0), float(d.get("end", 0) or 0)
        except (TypeError, ValueError):
            return 0.0, 0.0

    hour_caps: list[float] = []
    hour_wages: list[float] = []
    for h in hours:
        # Break hours take no work regardless of shifts (capacity 0).
        is_break = any(lo <= h < hi for lo, hi in (_rng(b) for b in breaks))
        if not active:
            cap_h: float = math.inf
        elif is_break:
            cap_h = 0.0
        elif shifts:
            cap_h = 0.0
            for s in shifts:
                lo, hi = _rng(s)
                if lo <= h < hi:
                    try:
                        cap_h += float(s.get("max_workers", 0) or 0)
                    except (TypeError, ValueError):
                        pass
        else:  # breaks-only plan: non-break hours stay unlimited (legacy)
            cap_h = math.inf
        hour_caps.append(cap_h)
        # Wage: first covering shift's rate, else the default band.
        wage = default_wage
        for s in shifts:
            lo, hi = _rng(s)
            if lo <= h < hi:
                try:
                    w = float(s.get("wage_per_hr") or 0)
                except (TypeError, ValueError):
                    w = 0.0
                wage = w if w > 0 else default_wage
                break
        hour_wages.append(wage)
    return hour_caps, hour_wages, active


def _toposort(ids: list[str], deps: dict[str, list[str]]) -> list[str]:
    """Order ids so every dependency precedes its dependents. A visited set both
    dedupes and breaks accidental cycles (a cyclic edge is simply dropped)."""
    order: list[str] = []
    seen: set[str] = set()
    idset = set(ids)

    def visit(pid: str) -> None:
        if pid in seen:
            return
        seen.add(pid)
        for up in deps.get(pid, []) or []:
            if up in idset:
                visit(up)
        order.append(pid)

    for pid in ids:
        visit(pid)
    return order


def solve_staffing(
    volumes_by_process: dict,
    *,
    model=None,
    start_hour: int = 9,
    end_hour: int = 18,
    cap: int | None = None,
    per_process_cap: dict | None = None,
    dependencies: dict | None = None,
    placement: str = "level",
    batches: dict | None = None,
    shift_plan: dict | None = None,
) -> dict:
    """Analytic per-hour staffing solver over an operating window under a cap.

    Inputs
      volumes_by_process: {process_id: daily volume} (GENERIC_PROCESSES ids).
      model:    passed to resolve_productivity for the 3-tier 実測>想定>既定 rate.
      start_hour/end_hour: operating window (integer hours; end may pass 24 for
                a logistics day spilling past midnight).
      cap:      global headcount ceiling shared by ALL processes in any hour
                (None = unlimited).
      per_process_cap: {process_id: ceiling} per-process headcount ceilings.
      dependencies: {process_id: [upstream ids]} precedence DAG; None = default.
      placement: '前詰め'/'front'/'frontload' = staff up early (finish ASAP);
                 anything else = '均等'/level-load (spread evenly).
      batches:  {section: [{"hour": H, "pct": P}]} バッチ投入スケジュール — the
                day's volume for a section (入荷/出荷) arrives in batches at given
                hours, so the first process of that section cannot output more than
                has arrived by each hour (a staggered start that follows the batch
                profile). None = all volume available from the window start.
      shift_plan: シフト・休憩モデル {breaks:[{start,end}], shifts:[{label,start,end,
                max_workers,wage_per_hr}], default_wage_per_hr}. BREAK hours take no
                work (capacity 0 → volume shifts to other hours; an infeasible day
                stays honestly infeasible). SHIFTS additionally cap each hour's TOTAL
                headcount by Σ max_workers of the shifts covering it (shifts defined
                but none covering an hour ⇒ that hour is closed; NO shifts at all ⇒
                unlimited). When the plan carries any break/shift the result gains
                additive keys `labour_cost_day` (Σ headcount×hour×covering-shift wage,
                else default wage) and `shift_plan` (echo). None/empty ⇒ byte-identical.

    Output (JSON-safe): hours[], per-process headcount_by_hour + man_hours +
    finish_hour + feasible/shortfall, plus day totals (man_hours, peak, makespan,
    feasible, shortfall man-hours). never-blocks: empty volume → empty-but-valid.
    """
    master = process_master(model)  # editable list when present, else GENERIC_PROCESSES
    deps = dependencies if isinstance(dependencies, dict) else process_deps(model)
    ppc = {str(k): float(v) for k, v in (per_process_cap or {}).items() if v}
    front = str(placement).lower() in ("front", "frontload", "front-load") \
        or str(placement) in ("前詰め", "前倒し", "frontLoad")

    # Normalise the window. Guard against a degenerate/empty window (never-blocks):
    # fall back to a single hour so divisions stay finite and the day still solves.
    s = int(start_hour)
    e = int(end_hour)
    if e <= s:
        e = s + 1
    hours = list(range(s, e))
    n_hours = len(hours)

    proc_by_id = {p["id"]: p for p in master}
    # Keep only processes that exist in the master and carry positive volume.
    active_ids = [
        p["id"] for p in master
        if float(volumes_by_process.get(p["id"], 0) or 0) > 0
    ]
    order = _toposort(active_ids, deps)

    # Per-process scalars: volume, productivity (units/person/hour), required
    # person-hours and the global cap (min of global cap & per-process cap).
    vol: dict[str, float] = {}
    prod: dict[str, float] = {}
    req_hours: dict[str, float] = {}
    pcap: dict[str, float | None] = {}
    for pid in order:
        p = proc_by_id[pid]
        v = float(volumes_by_process.get(pid, 0) or 0)
        rate = max(1.0, resolve_productivity(model, pid, float(p["prod"])))
        vol[pid] = v
        prod[pid] = rate
        req_hours[pid] = v / rate
        caps = [c for c in (float(cap) if cap else None, ppc.get(pid)) if c]
        pcap[pid] = min(caps) if caps else None

    # The per-hour allocation we iteratively refine. headcount[pid][h_index].
    head: dict[str, list[int]] = {pid: [0] * n_hours for pid in order}

    def upstream_cum_volume(pid: str, up_to_hour_idx: int) -> float:
        """Min over upstream deps of the volume they have CUMULATIVELY produced by
        the END of hour `up_to_hour_idx`, scaled into this process's own units (by
        the volume ratio). math.inf when there is no (active) upstream constraint
        OR when every upstream is essentially complete (so the trailing increment
        is never starved by integer-rounding of the upstream's last bucket)."""
        ups = deps.get(pid, []) or []
        best = math.inf
        for up in ups:
            if up not in head:  # inactive/zero-volume upstream imposes no flow cap
                continue
            up_units = sum(head[up][:up_to_hour_idx + 1]) * prod[up]
            up_target = vol[up] or 1.0
            if up_units >= up_target * 0.999:  # upstream done → no flow cap remains
                continue
            scaled = (up_units / up_target) * vol[pid]
            best = min(best, scaled)
        return best

    # ---- batch arrival gate ---------------------------------------------------
    # A バッチ投入スケジュール releases a section's volume in batches over the day.
    # Assign each section's cumulative-arrival curve to that section's FIRST process
    # (master order) — downstream processes inherit the staggered start through the
    # precedence feed above, so gating the root is enough.
    order_set = set(order)
    arrival_curve_by_pid: dict[str, list[float]] = {}
    if isinstance(batches, dict) and batches:
        sec_curve: dict[str, list[float]] = {}
        for sec, blist in batches.items():
            curve = batch_arrival_curve(blist if isinstance(blist, list) else [], hours)
            if curve is not None:
                sec_curve[str(sec)] = curve
        if sec_curve:
            seen_sec: set[str] = set()
            for p in master:  # master order
                pid, sec = p["id"], p["section"]
                if pid in order_set and sec in sec_curve and sec not in seen_sec:
                    arrival_curve_by_pid[pid] = sec_curve[sec]
                    seen_sec.add(sec)

    def arrival_cum_units(pid: str, hour_idx: int) -> float:
        """Cumulative units of `pid` available by the END of hour `hour_idx` under
        its section's batch schedule (a batch landing AT that hour is usable that
        hour). math.inf when the process has no arrival gate."""
        curve = arrival_curve_by_pid.get(pid)
        if curve is None:
            return math.inf
        return curve[hour_idx] * vol[pid]

    # ---- analytic placement passes -------------------------------------------
    # Each pass re-derives every process's per-hour headcount given the CURRENT
    # upstream allocation; upstream is solved first (topological order) so a few
    # sweeps let the staggered start ripple downstream and settle. front-load and
    # level-load differ only in HOW the remaining volume is spread across the
    # still-open hours each hour; both clamp by precedence + cap every hour.
    gcap = int(cap) if cap else None  # global per-hour ceiling on TOTAL headcount
    # シフト・休憩: per-hour TOTAL-headcount ceilings (break→0, shift Σmax, closed→0)
    # and wages. When the plan is empty/None `plan_active` is False and every entry
    # is math.inf, so hour_total_cap collapses to the scalar gcap (byte-identical).
    plan_caps, plan_wages, plan_active = _shift_plan_caps(shift_plan, hours)

    def hour_total_cap(hi: int) -> int | None:
        """The effective per-hour TOTAL-headcount ceiling for hour-index `hi`:
        min(global cap, shift-plan cap). None = unlimited (block is skipped so the
        no-cap / no-plan path stays byte-identical)."""
        pc = plan_caps[hi]
        if gcap is None and pc == math.inf:
            return None
        c = math.inf if gcap is None else float(gcap)
        return int(min(c, pc))

    for _ in range(_SOLVE_PASSES):
        for pid in order:
            rate = prod[pid]
            target = vol[pid]
            cph = pcap[pid]  # max persons per hour for this process
            alloc = [0] * n_hours
            cum_units = 0.0
            for hi in range(n_hours):
                remaining = target - cum_units
                if remaining <= 1e-9:
                    break
                hours_left = n_hours - hi
                if front or hours_left <= 1:
                    # Front-load (or the final usable hour of level-load): take as
                    # many persons this hour as the remaining volume needs, so the
                    # day still clears rather than leaving a sub-bucket residual.
                    want = remaining / rate
                else:
                    # Level-load: spread the remaining volume over remaining hours.
                    want = (remaining / rate) / hours_left
                need = math.ceil(want - 1e-9)
                if need < 1:
                    need = 1
                if cph is not None:
                    need = min(need, int(math.floor(cph)))
                # Global cap: the SUM over all processes this hour cannot exceed
                # `cap`; subtract what every OTHER process already takes this hour
                # so the budget is shared (front-load especially leans on this).
                htc = hour_total_cap(hi)
                if htc is not None:
                    used_by_others = sum(head[q][hi] for q in order if q != pid)
                    budget = htc - used_by_others
                    need = min(need, max(0, budget))
                # Precedence: a downstream process in hour `hi` can only handle
                # what upstream had finished by the END of the PREVIOUS hour, so
                # 格納 ramps only after 入荷 has produced (a visible staggered
                # start). Cumulative output therefore can't exceed that feed.
                fed = upstream_cum_volume(pid, hi - 1)
                if fed < math.inf:
                    allowed_units = max(0.0, fed - cum_units)
                    max_persons = int(math.floor(allowed_units / rate / 1.0 + 1e-9))
                    need = min(need, max_persons)
                    if need < 0:
                        need = 0
                # Batch arrival: this process can't output more than has landed by
                # this hour (a batch AT hour hi is usable during hour hi).
                arr = arrival_cum_units(pid, hi)
                if arr < math.inf:
                    allowed_arr = max(0.0, arr - cum_units)
                    need = min(need, int(math.floor(allowed_arr / rate + 1e-9)))
                    if need < 0:
                        need = 0
                alloc[hi] = need
                cum_units += need * rate
            head[pid] = alloc

    # ---- top-up sweep ---------------------------------------------------------
    # Integer per-hour rounding + the precedence per-hour feed cap can leave a
    # sub-bucket tail (e.g. a fast process starved hour-by-hour by a slow upstream
    # whose CUMULATIVE feed is fine). Sweep once more in topological order and
    # fill any process still short into the EARLIEST hours that have precedence +
    # cap headroom. This makes the day clear whenever the window+cap physically
    # allow it; a genuinely infeasible window simply ends with an honest tail.
    for pid in order:
        rate = prod[pid]
        target = vol[pid]
        cph = pcap[pid]
        for hi in range(n_hours):
            cum = sum(head[pid][:hi + 1]) * rate
            if sum(head[pid]) * rate >= target - 1e-9:
                break
            # Headroom from the per-process cap.
            room = math.inf if cph is None else max(0, int(math.floor(cph)) - head[pid][hi])
            # Headroom from the global cap + shift-plan ceiling (shared this hour).
            htc = hour_total_cap(hi)
            if htc is not None:
                used = sum(head[q][hi] for q in order)
                room = min(room, max(0, htc - used))
            if room <= 0:
                continue
            # Precedence: cumulative output through this hour can't exceed what
            # upstream finished by the END of the previous hour.
            fed = upstream_cum_volume(pid, hi - 1)
            if fed < math.inf:
                allowed = max(0.0, fed - (cum - head[pid][hi] * rate))
                room = min(room, int(math.floor(allowed / rate + 1e-9)) - head[pid][hi])
                room = max(0, room)
            # Batch arrival cap (same shape as the precedence feed cap above).
            arr = arrival_cum_units(pid, hi)
            if arr < math.inf:
                allowed_arr = max(0.0, arr - (cum - head[pid][hi] * rate))
                room = min(room, int(math.floor(allowed_arr / rate + 1e-9)) - head[pid][hi])
                room = max(0, room)
            still_needed = math.ceil((target - sum(head[pid]) * rate) / rate - 1e-9)
            add = min(room, max(0, still_needed))
            head[pid][hi] += add

    # ---- assemble the result --------------------------------------------------
    procs_out: list[dict] = []
    total_by_hour = [0] * n_hours
    total_manhours = 0.0
    day_feasible = True
    day_shortfall_units = 0.0
    makespan_hour = s
    for pid in order:
        alloc = head[pid]
        achieved = sum(alloc) * prod[pid]
        target = vol[pid]
        feasible = achieved >= target * 0.999
        shortfall = max(0.0, target - achieved)
        finish_idx = max((i for i, n in enumerate(alloc) if n > 0), default=-1)
        finish_hour = hours[finish_idx] + 1 if finish_idx >= 0 else s
        manhours = float(sum(alloc))  # 1 person × 1 hour = 1 man-hour
        for i, n in enumerate(alloc):
            total_by_hour[i] += n
        total_manhours += manhours
        if not feasible:
            day_feasible = False
            day_shortfall_units += shortfall
        makespan_hour = max(makespan_hour, finish_hour)
        p = proc_by_id[pid]
        procs_out.append({
            "id": pid,
            "section": p["section"],
            "unit": p["unit"],
            "driver": p["driver"],
            "productivity": round(prod[pid], 1),
            "daily_volume": round(target, 1),
            "required_man_hours": round(req_hours[pid], 2),
            "man_hours": round(manhours, 1),
            "headcount_by_hour": alloc,
            "peak_headcount": max(alloc) if alloc else 0,
            "finish_hour": finish_hour,
            "feasible": feasible,
            "shortfall_volume": round(shortfall, 1),
            "depends": [u for u in (deps.get(pid, []) or []) if u in proc_by_id],
        })

    # Order the output rows in master order (toposort reorders for compute only).
    master_order = {p["id"]: i for i, p in enumerate(master)}
    procs_out.sort(key=lambda r: master_order.get(r["id"], 1_000_000))

    peak = max(total_by_hour) if total_by_hour else 0
    peak_idx = total_by_hour.index(peak) if total_by_hour else 0
    cap_exceeded = bool(cap and peak > cap)
    # Total shortfall expressed in man-hours (units ÷ that process's rate).
    shortfall_mh = round(
        sum(p["shortfall_volume"] / max(1.0, p["productivity"]) for p in procs_out), 1
    )

    # シフト・休憩 labour-cost line (additive; only when a plan is active so an
    # empty/None plan leaves the result dict byte-identical to legacy).
    extra: dict = {}
    if plan_active:
        labour_cost_day = sum(
            total_by_hour[hi] * plan_wages[hi] for hi in range(n_hours)
        )
        extra["labour_cost_day"] = round(labour_cost_day, 1)
        extra["shift_plan"] = shift_plan if isinstance(shift_plan, dict) else {}

    return {
        "hours": hours,
        "start_hour": s,
        "end_hour": e,
        "placement": "front" if front else "level",
        "cap": int(cap) if cap else None,
        "processes": procs_out,
        "total_headcount_by_hour": total_by_hour,
        "total_man_hours": round(total_manhours, 1),
        "peak_headcount": peak,
        "peak_hour": (hours[peak_idx] if hours else s),
        "makespan_hour": makespan_hour,
        "finish_hour": makespan_hour,
        "feasible": day_feasible and not cap_exceeded,
        "cap_exceeded": cap_exceeded,
        "shortfall_man_hours": shortfall_mh,
        "dependencies": {pid: ups for pid, ups in (deps or {}).items() if pid in proc_by_id},
        "batches": batches if isinstance(batches, dict) else {},
        **extra,
    }
