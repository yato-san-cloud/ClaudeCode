"""From measured volume to required headcount — the field-user bridge.

The timetable solver staffs a day from *per-process volumes* (物量) + productivities.
This module derives those from the analysed WMS data: it splits outbound/inbound
volume across a generic process flow (入荷検品→格納 / ピッキング→検品→梱包→出荷),
distributes each process's daily volume across the hours using the measured
hour-of-day shape, and divides by a productivity standard to get the **required
headcount per process per hour** (and the day's man-hours / peak). That hourly
profile is what the タイムチャート turns into an actual placement.
"""

from __future__ import annotations

import math

import pandas as pd

from whsim.analysis import analyses

# Generic process flow with a driver + a default productivity (units/person/hour).
# Drivers are measured quantities; productivities are editable JP-warehouse
# defaults (lines/hour unless noted). Kept deliberately simple & transparent.
GENERIC_PROCESSES: list[dict] = [
    {"id": "入荷検品", "section": "入荷", "driver": "in_lines",  "prod": 40,  "unit": "行/h"},
    {"id": "格納",     "section": "入荷", "driver": "in_qty",    "prod": 120, "unit": "点/h"},
    {"id": "ピッキング", "section": "出荷", "driver": "out_lines", "prod": 60,  "unit": "行/h"},
    {"id": "検品",     "section": "出荷", "driver": "out_lines", "prod": 120, "unit": "行/h"},
    {"id": "梱包",     "section": "出荷", "driver": "out_orders", "prod": 30, "unit": "件/h"},
    {"id": "出荷",     "section": "出荷", "driver": "out_orders", "prod": 120, "unit": "件/h"},
]
# Inbound rarely carries hour stamps; spread it across a morning receiving window.
_INBOUND_WINDOW = list(range(8, 16))


def process_master(model=None) -> list[dict]:
    """The work-process master: the project's editable list when present, else the
    engine default (GENERIC_PROCESSES). This is the SINGLE source of truth — every
    consumer (solver, cost, productivity, flow seed) resolves processes through here
    so a renamed/added/removed process flows everywhere. Each dict has the same
    shape as GENERIC_PROCESSES (id/section/driver/prod/unit) plus 'depends'."""
    wp = getattr(getattr(model, "process", None), "work_processes", None)
    if not wp:
        return [{**p, "depends": list(_FLOW_DEPS.get(p["id"], []))} for p in GENERIC_PROCESSES]
    out: list[dict] = []
    for p in wp:
        d = p.model_dump() if hasattr(p, "model_dump") else dict(p)
        out.append({
            "id": str(d.get("id", "工程")),
            "section": str(d.get("section", "出荷")),
            "driver": str(d.get("driver", "out_lines")),
            "prod": float(d.get("prod", 60.0) or 60.0),
            "unit": str(d.get("unit", "行/h")),
            "depends": [str(u) for u in (d.get("depends") or [])],
        })
    return out


def process_deps(model=None) -> dict[str, list[str]]:
    """Precedence DAG {process_id: [upstream ids]} from the master (model's edited
    `depends`, else the engine default _FLOW_DEPS)."""
    master = process_master(model)
    ids = {p["id"] for p in master}
    return {p["id"]: [u for u in p["depends"] if u in ids] for p in master if p["depends"]}


def _n_days(df: pd.DataFrame | None) -> int:
    if df is None or df.empty or "date" not in df.columns:
        return 1
    return max(1, int(pd.to_datetime(df["date"]).dt.normalize().nunique()))


def _hour_shape(shipments: pd.DataFrame | None) -> list[float]:
    """Normalised 24-hour outbound shape (fractions summing to 1)."""
    frac = [0.0] * 24
    if shipments is not None and not shipments.empty:
        _, by_hour, _ = analyses.peak_analysis(shipments)
        if by_hour is not None and not by_hour.empty and "lines" in by_hour:
            for _, row in by_hour.iterrows():
                h = int(row["hour"])
                if 0 <= h < 24:
                    frac[h] = float(row["lines"])
    tot = sum(frac)
    if tot <= 0:  # no timestamps → default 9-18 working window
        win = list(range(9, 18))
        return [1.0 / len(win) if h in win else 0.0 for h in range(24)]
    return [f / tot for f in frac]


def _inbound_shape() -> list[float]:
    return [1.0 / len(_INBOUND_WINDOW) if h in _INBOUND_WINDOW else 0.0 for h in range(24)]


def staffing_profile(shipments: pd.DataFrame | None,
                     inbound: pd.DataFrame | None, model=None) -> dict:
    """Per-process daily volume, hourly required headcount, man-hours and peak.

    Volumes are **average per operating day** (so the staffing reflects a typical
    day, not the whole import window). Processes come from the editable master
    (model's list when present, else the engine default). JSON-safe.
    """
    ndays_out = _n_days(shipments)
    ndays_in = _n_days(inbound)

    out_lines = (len(shipments) / ndays_out) if shipments is not None and not shipments.empty else 0.0
    out_qty = (float(shipments["qty"].sum()) / ndays_out
               if shipments is not None and "qty" in getattr(shipments, "columns", []) else 0.0)
    if shipments is not None and "order_id" in getattr(shipments, "columns", []):
        out_orders = shipments["order_id"].nunique() / ndays_out
    else:
        out_orders = out_lines  # no order id → treat each line as an order
    in_lines = (len(inbound) / ndays_in) if inbound is not None and not inbound.empty else 0.0
    in_qty = (float(inbound["qty"].sum()) / ndays_in
              if inbound is not None and "qty" in getattr(inbound, "columns", []) else 0.0)

    daily = {"out_lines": out_lines, "out_qty": out_qty, "out_orders": out_orders,
             "in_lines": in_lines, "in_qty": in_qty}
    out_shape = _hour_shape(shipments)
    in_shape = _inbound_shape()

    procs = []
    total_hourly = [0.0] * 24
    total_manhours = 0.0
    for p in process_master(model):
        vol = daily.get(p["driver"], 0.0)
        shape = in_shape if p["driver"].startswith("in_") else out_shape
        hourly_vol = [vol * f for f in shape]
        prod = max(1.0, float(p["prod"]))
        head = [math.ceil(v / prod) if v > 0 else 0 for v in hourly_vol]
        manhours = sum(v / prod for v in hourly_vol)
        for h in range(24):
            total_hourly[h] += head[h]
        total_manhours += manhours
        procs.append({
            "id": p["id"], "section": p["section"], "unit": p["unit"],
            "productivity": p["prod"], "daily_volume": round(vol, 1),
            "headcount_by_hour": head, "peak_headcount": max(head) if head else 0,
            "man_hours": round(manhours, 1),
        })

    return {
        "processes": procs,
        "total_headcount_by_hour": [int(x) for x in total_hourly],
        "peak_headcount": int(max(total_hourly)) if total_hourly else 0,
        "total_man_hours": round(total_manhours, 1),
        "operating_days": ndays_out,
        "daily": {k: round(v, 1) for k, v in daily.items()},
    }


# Default work-band per section (the solver's deps live in _FLOW_DEPS / the master).
_BAND = {"入荷": ["08:00", "16:00"], "出荷": ["09:00", "21:00"]}


def flow_seed(model=None) -> list[dict]:
    """The material-flow skeleton for the authoring screen: each process with its
    section, unit, productivity, measured driver and upstream dependency. Uses the
    editable master (model's list when present, else the engine default)."""
    return [
        {"id": p["id"], "section": p["section"], "unit": p["unit"],
         "productivity": p["prod"], "driver": p["driver"],
         "depends": list(p["depends"])}
        for p in process_master(model)
    ]


def resolve_productivity(model, process_id: str, default: float) -> float:
    """生産性の3層 (cost と同じ): 実測採用値(override) > 物流形態ベンチマーク(想定) >
    エンジン既定. `model` may be None (→ default)."""
    if model is None:
        return float(default)
    try:
        ov = (getattr(model.settings, "productivity_overrides", {}) or {}).get(process_id)
        if ov:
            return float(ov)
        bp = (getattr(model.settings, "benchmark_productivity", {}) or {}).get(process_id)
        if bp:
            return float(bp)
    except Exception:  # noqa: BLE001 — settings may be absent; fall back
        pass
    return float(default)


def scenario_from_volumes(volumes_by_process: dict, model=None) -> dict:
    """Build a generic timetable-solver payload from explicit per-process 荷役物量.

    `volumes_by_process` maps a process id (入荷検品/格納/…/出荷) to a daily volume.
    Productivities use the 3-tier (実測採用値 > 物流形態ベンチマーク > 既定) when a
    `model` is given, so the 想定→実測 swap and the 物流形態 benchmark flow into the
    人員タイムチャート too. Schema matches whsim.timetable.solve / timetable_solver.js."""
    processes, productivity, volumes = [], {}, {}
    # An upstream with no volume in THIS scenario imposes no precedence (mirrors the
    # solver's inactive-upstream rule), so a partial volume set still staffs.
    active = {p["id"] for p in process_master(model)
              if float(volumes_by_process.get(p["id"], 0) or 0) > 0}
    for p in process_master(model):
        vk = f"{p['id']}_物量"
        prod = resolve_productivity(model, p["id"], p["prod"])
        processes.append({
            "id": p["id"], "section": p["section"], "worker_type": "PT",
            "default_時間帯": _BAND.get(p["section"], ["09:00", "21:00"]),
            "productivity_key": p["id"], "volume_key": vk,
            "volume_unit": p["unit"].split("/")[0], "配置方式": "dynamic",
            "固定人数": 0, "依存": [u for u in p["depends"] if u in active],
        })
        productivity[p["id"]] = {"篁採用値": prod, "単位": p["unit"],
                                 "fixed_hours": False}
        volumes[vk] = int(round(float(volumes_by_process.get(p["id"], 0) or 0)))
    scenario = {"物量": volumes,
                "制約": {"ピーク人数上限": 999, "Fマン上限": 99, "PT上限": 999}}
    return {"processes": processes, "productivity": productivity,
            "scenarios": {"実データ（平均日）": scenario}}


def volumes_from_bi(bi_cfg: dict) -> dict | None:
    """Read the saved BI 仮値派生 (projects/<name>/bi.json) back into a per-process
    物量 dict keyed by GENERIC_PROCESSES ids — the bridge BI → タイムチャート/人員設計.

    `bi_cfg` is the dict persisted by ``bi.apply_derivation`` /
    read by ``bi.load_bi_config(proj)``: ``{inputs, derived, base}`` where

    - ``base``    carries measured outbound/inbound (out_lines/out_pieces/
      out_orders/out_cases/in_pieces/in_cases),
    - ``derived`` carries the pallet-driven figures (in_pallets / out_pallets /
      in_pallets_peak / inbound_handling_hours),
    - ``inputs``  carries the 仮値 (incl. ``peak_factor``).

    Mapping to processes (GENERIC_PROCESSES ids):

    - 入荷検品  ← base.in_lines if present, else base.in_cases (cases ≈ receiving lines)
    - 格納      ← derived.in_pallets (pallet-driven 物量; the BI thesis number)
    - ピッキング ← base.out_lines
    - 検品      ← base.out_lines
    - 梱包      ← base.out_orders
    - 出荷      ← base.out_orders

    A ``peak_factor`` (from ``inputs`` or ``derived``/``base``) scales every
    volume so the staffing reflects a peak day. Returns ``None`` (never raises) if
    the config is missing/empty or yields no positive volume, so callers can fall
    back to measured/estimated paths.
    """
    if not isinstance(bi_cfg, dict) or not bi_cfg:
        return None
    base = bi_cfg.get("base") if isinstance(bi_cfg.get("base"), dict) else {}
    derived = bi_cfg.get("derived") if isinstance(bi_cfg.get("derived"), dict) else {}
    inputs = bi_cfg.get("inputs") if isinstance(bi_cfg.get("inputs"), dict) else {}

    def num(d: dict, *keys) -> float:
        for k in keys:
            v = d.get(k)
            if v is None:
                continue
            try:
                f = float(v)
            except (TypeError, ValueError):
                continue
            if f > 0:
                return f
        return 0.0

    # Receiving lines: prefer an explicit in_lines, else cases (≈受入行) as a proxy.
    in_lines = num(base, "in_lines", "in_cases")
    # 格納 is pallet-driven — the headline 仮値派生 number; fall back to pieces.
    in_pallets = num(derived, "in_pallets") or num(base, "in_pieces")
    out_lines = num(base, "out_lines")
    out_orders = num(base, "out_orders", "out_lines")

    volumes = {
        "入荷検品": in_lines,
        "格納": in_pallets,
        "ピッキング": out_lines,
        "検品": out_lines,
        "梱包": out_orders,
        "出荷": out_orders,
    }
    if not any(v > 0 for v in volumes.values()):
        return None

    peak = num(inputs, "peak_factor") or num(derived, "peak_factor") \
        or num(base, "peak_factor") or 1.0
    if peak and peak != 1.0:
        volumes = {k: v * peak for k, v in volumes.items()}
    return {k: round(v, 1) for k, v in volumes.items()}


def timetable_scenario(shipments: pd.DataFrame | None,
                       inbound: pd.DataFrame | None, model=None) -> dict:
    """Generic timetable payload from *measured* volumes (analysis → staffing)."""
    prof = staffing_profile(shipments, inbound, model=model)
    vols = {p["id"]: p["daily_volume"] for p in prof["processes"]}
    return scenario_from_volumes(vols, model=model)


_PIECES_PER_LINE = 3.0
_LINES_PER_ORDER = 1.4


def generate_flow_volumes(base: dict | None, model=None) -> dict:
    """Estimate every process's 荷役物量 from a partial base (不足データ作成).

    `base` may carry any of out_lines / out_qty / out_orders / in_lines / in_qty
    (daily). Missing drivers are inferred from typical 3PL ratios (pieces/line,
    lines/order, inbound≈outbound) so the material-flow screen can be filled even
    when only one number is known. Volumes are keyed by the editable master."""
    b = dict(base or {})

    def f(k):
        try:
            return float(b.get(k) or 0)
        except (TypeError, ValueError):
            return 0.0

    out_lines = f("out_lines")
    if out_lines <= 0:
        out_lines = (f("out_orders") * _LINES_PER_ORDER or f("out_qty") / _PIECES_PER_LINE
                     or f("in_lines"))
    b["out_lines"] = out_lines
    b["out_qty"] = f("out_qty") or out_lines * _PIECES_PER_LINE
    b["out_orders"] = f("out_orders") or (out_lines / _LINES_PER_ORDER if out_lines else 0.0)
    b["in_lines"] = f("in_lines") or out_lines
    b["in_qty"] = f("in_qty") or b["out_qty"]
    return {p["id"]: round(float(b.get(p["driver"], 0.0)), 1) for p in process_master(model)}


def project_volumes(proj) -> dict:
    """Best-available per-process 物量 for a project, never-blocks.

    Source preference mirrors the rest of the timetable chain:
      1) the saved BI 仮値 derivation (bi.json) if applied,
      2) the project's own outbound orders (measured staffing_profile),
      3) {} when the project carries no demand yet (caller shows an empty state).
    Returns a {process_id: daily volume} dict over GENERIC_PROCESSES ids."""
    try:
        from whsim import bi
        vols = volumes_from_bi(bi.load_bi_config(proj))
        if vols:
            return vols
    except Exception:  # noqa: BLE001 — BI is optional; fall through to measured
        pass
    try:
        from whsim.analysis import ingest
        model = proj.load_model()
        ship = ingest.orders_to_frame(model.orders.outbound)
        inb = ingest.orders_to_frame(model.orders.inbound)
        if ship is not None and not ship.empty:
            prof = staffing_profile(ship, inb if inb is not None and not inb.empty else None,
                                    model=model)
            vols = {p["id"]: p["daily_volume"] for p in prof["processes"]}
            if any(v > 0 for v in vols.values()):
                return vols
    except Exception:  # noqa: BLE001 — never blocks; empty volumes are valid
        pass
    return {}


# ---------------------------------------------------------------------------
# Analytic staffing SOLVER (人員タイムチャート — 解析的ソルバー)
# ---------------------------------------------------------------------------
# You set an operating window (start–end hour) and a headcount cap (global and/or
# per-process); the solver pulls library productivity (3-tier), splits the day's
# volume into HOURLY buckets per process, and analytically iterates a few passes
# to find the per-bucket headcount that clears the day under the cap, honouring
# process precedence (入荷→格納, ピッキング→梱包→出荷) and a placement choice
# (前詰め=front-load vs 均等=level-load). Deterministic, fast, no DES.

# Default precedence edges over GENERIC_PROCESSES (receive→putaway, pick→inspect
# →pack→ship). The receive→putaway→pick chain links inbound to outbound flow.
_FLOW_DEPS: dict[str, list[str]] = {
    "格納": ["入荷検品"],
    "ピッキング": ["格納"],
    "検品": ["ピッキング"],
    "梱包": ["検品"],
    "出荷": ["梱包"],
}

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
    clears (never-blocks); a batch landing after the window simply never arrives.
    Returns None when there is no usable schedule (→ caller imposes no arrival gate,
    i.e. all volume is available from the start, as before)."""
    pts: list[tuple[int, float]] = []
    for b in batch_list or []:
        try:
            h = int(b.get("hour", b.get("time", b.get("h"))))
            p = float(b.get("pct", b.get("percent", b.get("share", 0))) or 0)
        except (TypeError, ValueError):
            continue
        if p > 0:
            pts.append((h, p))
    if not pts:
        return None
    total = sum(p for _, p in pts) or 1.0
    return [min(1.0, sum(p for bh, p in pts if bh <= h) / total) for h in hours]


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
                if gcap is not None:
                    used_by_others = sum(head[q][hi] for q in order if q != pid)
                    budget = gcap - used_by_others
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
            # Headroom from the global cap (shared budget this hour).
            if gcap is not None:
                used = sum(head[q][hi] for q in order)
                room = min(room, max(0, gcap - used))
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
    }
