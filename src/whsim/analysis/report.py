"""Bundle every analysis + auto-insight into one JSON-safe payload for the web UI.

`run_all` takes standardised shipment/inbound/inventory frames and returns a dict
the whsim "データ分析" tab renders (KPIs, insights, trend, ABC, peak, turnover,
forecast, portfolio, …). `sample_bundle` wires the bundled sample generator
through the same path so the tab works with zero upload.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from whsim.analysis import analyses, insights
from whsim.analysis.data_io import (
    INBOUND_FIELDS,
    INVENTORY_FIELDS,
    SHIPMENT_FIELDS,
    apply_mapping,
    initial_mapping,
)
from whsim.analysis.sample import build_frames
from whsim.analysis.staffing import staffing_profile


def _jsonable(v):
    """Recursively coerce pandas/numpy values to JSON-safe Python types."""
    if v is None:
        return None
    if isinstance(v, (pd.Timestamp,)):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, np.generic):
        v = v.item()
    if isinstance(v, float):
        return None if (math.isnan(v) or math.isinf(v)) else v
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, pd.DataFrame):
        return _records(v)
    return v


def _records(df: pd.DataFrame | None) -> list[dict]:
    if df is None or df.empty:
        return []
    out = df.copy()
    for c in out.columns:
        if pd.api.types.is_datetime64_any_dtype(out[c]):
            out[c] = out[c].dt.strftime("%Y-%m-%d")
    return [_jsonable(r) for r in out.to_dict(orient="records")]


def _matrix(df: pd.DataFrame | None) -> dict:
    if df is None or df.empty:
        return {"index": [], "columns": [], "values": []}
    return {
        "index": [str(i) for i in df.index],
        "columns": [str(c) for c in df.columns],
        "values": [[_jsonable(x) for x in row] for row in df.values.tolist()],
    }


def run_all(shipments: pd.DataFrame | None, inbound: pd.DataFrame | None,
            inventory: pd.DataFrame | None, dead_days: int = 60) -> dict:
    """Run the full analysis suite and return one JSON-safe bundle."""
    has_ship = shipments is not None and not shipments.empty
    has_inv = inventory is not None and not inventory.empty

    ti = (analyses.inventory_turnover(inventory, shipments, dead_stock_days=dead_days)
          if has_inv and has_ship else pd.DataFrame())
    kpis = analyses.summary_kpis(shipments, inbound, inventory, dead_stock_days=dead_days)
    ins = insights.generate_insights(shipments, inbound, inventory, kpis, ti)

    has_partner = has_ship and "partner" in shipments.columns
    bundle = {
        "kpis": _jsonable(kpis),
        "insights": [
            {"severity": i.severity, "category": i.category, "title": i.title,
             "detail": i.detail, "metric": i.metric, "suggestion": i.suggestion,
             "icon": i.icon}
            for i in ins
        ],
        "trend_daily": _records(analyses.volume_trends(shipments, inbound, "D")),
        "abc_sku": _records(analyses.abc_analysis(shipments, "sku").head(50)),
        "abc_partner": _records(analyses.abc_analysis(shipments, "partner").head(50))
        if has_partner else [],
        "anomalies": _records(analyses.daily_anomalies(shipments)),
        "forecast": _records(analyses.simple_forecast(shipments)),
        "turnover": _records(ti.head(200)),
        "portfolio": _records(analyses.sku_portfolio(ti)),
        "lifecycle": _records(analyses.sku_lifecycle(shipments)),
        "partner_matrix": _matrix(analyses.partner_weekday_matrix(shipments)),
        "staffing": staffing_profile(shipments, inbound),
    }
    by_weekday, by_hour, heatmap = analyses.peak_analysis(shipments) if has_ship else (
        pd.DataFrame(), pd.DataFrame(), pd.DataFrame())
    bundle["peak"] = {
        "by_weekday": _records(by_weekday),
        "by_hour": _records(by_hour),
        "heatmap": _matrix(heatmap),
    }
    return bundle


def _standardize(frames: dict) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    def m(name, fields):
        df = frames.get(name)
        if df is None:
            return pd.DataFrame()
        return apply_mapping(df, initial_mapping(df, fields), fields)
    return (m("shipments", SHIPMENT_FIELDS), m("inbound", INBOUND_FIELDS),
            m("inventory", INVENTORY_FIELDS))


def sample_bundle(days: int = 90, seed: int = 42) -> dict:
    """Generate the demo WMS dataset and run the full suite on it."""
    ship, inb, inv = _standardize(build_frames(days=days, seed=seed))
    bundle = run_all(ship, inb, inv)
    bundle["source"] = "sample"
    return bundle
