"""Scenario comparison: run several what-ifs over one base model and compare.

A scenario is a set of dotted-path edits applied to the base model
(e.g. {"orders.profile.peak_factor": 3.0}). This is the deal-closing artifact:
"現行 vs 提案", side by side, ending in ¥/order, headcount and payback.
"""

from __future__ import annotations

from whsim import kpis as kpi_mod
from whsim.engine.run import RunResult, run_once
from whsim.schema.model import Scenario, WarehouseModel


def _set_by_path(md: dict, path: str, value) -> None:
    cur = md
    parts = path.split(".")
    for p in parts[:-1]:
        cur = cur[int(p)] if p.isdigit() else cur[p]
    last = parts[-1]
    cur[int(last) if last.isdigit() else last] = value


def apply_scenario(base: WarehouseModel, scenario: Scenario) -> WarehouseModel:
    md = base.model_dump()
    for path, value in scenario.edits.items():
        try:
            _set_by_path(md, path, value)
        except (KeyError, IndexError, ValueError):
            continue  # tolerant: skip edits that don't apply
    return WarehouseModel.model_validate(md)


def default_scenarios(base: WarehouseModel) -> list[Scenario]:
    """Sensible presets for a 3PL pitch: today, peak day, and an AGV proposal."""
    sx = base.resources.stations[0].x if base.resources.stations else 6.0
    sy = base.resources.stations[0].y if base.resources.stations else 15.0
    # target the pick stage by id, not a fixed index (robust to reordered flows)
    pick_idx = next((i for i, s in enumerate(base.process.stages)
                     if s.id == "pick"), 2)
    n_pick = base.resources.workers[0].count if base.resources.workers else 6
    return [
        Scenario(name="現行", description="現行オペレーション"),
        Scenario(name="ピーク日", description="セール期（需要2.5倍）",
                 edits={"orders.profile.peak_factor": 2.5}),
        Scenario(name="AGV導入",
                 description="ピッキングをAGV化（10台）。歩行を排除し省人化",
                 edits={f"process.stages.{pick_idx}.method": "agv",
                        "resources.equipment": [{
                            "id": "agv1", "type": "agv", "count": 10,
                            "speed_mps": 1.6, "x": sx, "y": sy}],
                        # AGVs do the walking, so fewer pickers are needed
                        "resources.workers.0.count": max(2, round(n_pick * 0.5))}),
    ]


def run_scenario(base: WarehouseModel, scenario: Scenario,
                 replay_window_s: float | None = None) -> tuple[RunResult, dict]:
    model = apply_scenario(base, scenario)
    res = run_once(model, replay_window_s=replay_window_s)
    metrics = kpi_mod.compute([res])
    return res, metrics


def payback_months(baseline_kpis: dict, alt_kpis: dict) -> float | None:
    """Months to recoup the alternative's capex from monthly OPERATING savings.

    Operating savings = baseline operating cost (labour+opex) minus the
    alternative's, excluding capex itself (capex is what we are paying back).
    """
    capex = alt_kpis.get("capex_total", 0.0)
    if not capex:
        return None
    base_op = baseline_kpis.get("monthly_opex", baseline_kpis.get("monthly_cost", 0.0))
    alt_op = alt_kpis.get("monthly_opex", alt_kpis.get("monthly_cost", 0.0))
    savings = base_op - alt_op
    if savings <= 0:
        return None
    return capex / savings
