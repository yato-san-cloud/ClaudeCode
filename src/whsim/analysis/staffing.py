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
                     inbound: pd.DataFrame | None) -> dict:
    """Per-process daily volume, hourly required headcount, man-hours and peak.

    Volumes are **average per operating day** (so the staffing reflects a typical
    day, not the whole import window). JSON-safe.
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
    for p in GENERIC_PROCESSES:
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


# Process-flow dependencies (input completes before its dependent starts).
_DEPS = {"格納": ["入荷検品"], "検品": ["ピッキング"], "梱包": ["検品"], "出荷": ["梱包"]}
_BAND = {"入荷": ["08:00", "16:00"], "出荷": ["09:00", "21:00"]}


def flow_seed() -> list[dict]:
    """The material-flow skeleton for the authoring screen: each process with its
    section, unit, productivity, measured driver and upstream dependency."""
    return [
        {"id": p["id"], "section": p["section"], "unit": p["unit"],
         "productivity": p["prod"], "driver": p["driver"],
         "depends": _DEPS.get(p["id"], [])}
        for p in GENERIC_PROCESSES
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
    for p in GENERIC_PROCESSES:
        vk = f"{p['id']}_物量"
        prod = resolve_productivity(model, p["id"], p["prod"])
        processes.append({
            "id": p["id"], "section": p["section"], "worker_type": "PT",
            "default_時間帯": _BAND.get(p["section"], ["09:00", "21:00"]),
            "productivity_key": p["id"], "volume_key": vk,
            "volume_unit": p["unit"].split("/")[0], "配置方式": "dynamic",
            "固定人数": 0, "依存": _DEPS.get(p["id"], []),
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
                       inbound: pd.DataFrame | None) -> dict:
    """Generic timetable payload from *measured* volumes (analysis → staffing)."""
    prof = staffing_profile(shipments, inbound)
    vols = {p["id"]: p["daily_volume"] for p in prof["processes"]}
    return scenario_from_volumes(vols)


_PIECES_PER_LINE = 3.0
_LINES_PER_ORDER = 1.4


def generate_flow_volumes(base: dict | None) -> dict:
    """Estimate every process's 荷役物量 from a partial base (不足データ作成).

    `base` may carry any of out_lines / out_qty / out_orders / in_lines / in_qty
    (daily). Missing drivers are inferred from typical 3PL ratios (pieces/line,
    lines/order, inbound≈outbound) so the material-flow screen can be filled even
    when only one number is known."""
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
    return {p["id"]: round(float(b.get(p["driver"], 0.0)), 1) for p in GENERIC_PROCESSES}
