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


def timetable_scenario(shipments: pd.DataFrame | None,
                       inbound: pd.DataFrame | None) -> dict:
    """Build a generic timetable-solver payload (processes/productivity/scenario)
    from the measured volumes, so the タイムチャート can place the day from real
    data. Schema matches whsim.timetable.solve / timetable_solver.js."""
    prof = staffing_profile(shipments, inbound)
    processes, productivity, volumes = [], {}, {}
    for p in prof["processes"]:
        vk = f"{p['id']}_物量"
        processes.append({
            "id": p["id"], "section": p["section"], "worker_type": "PT",
            "default_時間帯": _BAND.get(p["section"], ["09:00", "21:00"]),
            "productivity_key": p["id"], "volume_key": vk,
            "volume_unit": p["unit"].split("/")[0], "配置方式": "dynamic",
            "固定人数": 0, "依存": _DEPS.get(p["id"], []),
        })
        productivity[p["id"]] = {"篁採用値": p["productivity"], "単位": p["unit"],
                                 "fixed_hours": False}
        volumes[vk] = int(round(p["daily_volume"]))
    scenario = {"物量": volumes,
                "制約": {"ピーク人数上限": 999, "Fマン上限": 99, "PT上限": 999}}
    return {"processes": processes, "productivity": productivity,
            "scenarios": {"実データ（平均日）": scenario}}
