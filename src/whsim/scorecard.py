"""採点表レール — the design "scorecard" composed analytically (no DES, 爆速).

The scorecard rail is the always-on right-dock that shows the design's dependent
variables (判定/人員/原価/生産性/坪数/連鎖) and recomputes on every edit. This
module is the backend contract for it: ``build_scorecard`` COMPOSES the existing
pure estimators (``analytic.estimate`` / ``cost.estimate_cost`` /
``pickrate.estimate_pickrate`` / ``storage.estimate_storage``) into the fixed
6-row payload the rail renders. The only NEW logic here is (a) the 工程↔エリア種別
chain check and (b) the 人時→人数 headcount conversion.

Honours whsim's "never blocks" invariant: a bare model (no 物量/レイアウト) never
raises — each estimator call is wrapped so a failing row degrades to value="—",
tone="neutral", and the rail always gets all 6 rows. See
``docs/SCORECARD_CONTRACT.md`` for the JSON contract.
"""

from __future__ import annotations

import math

from whsim import analytic, cost, pickrate, storage
from whsim.schema.model import WarehouseModel

# Stage ↔ allowed zone types: MUST stay in lock-step with the designer's
# STAGE_ZONE_TYPES (static/js/designer/constants.js). The flow tab validates the
# same contract on the frontend; the scorecard re-derives it server-side so the
# 連鎖 row matches what the editor highlights.
STAGE_ZONE_TYPES: dict[str, list[str]] = {
    "receive": ["receiving"],
    "putaway": ["storage", "staging"],
    "pick": ["storage", "picking"],
    "pack": ["packing"],
    "ship": ["shipping", "staging"],
}

# A neutral, never-blocks placeholder row (used when an estimator can't produce a
# value — no data, or it raised). Each row keeps a stable id/label/view so the
# rail's layout is invariant across models.
_DASH = {"value": "—", "unit": "", "sub": "", "tone": "neutral"}


def _fmt_yen(yen: float) -> str:
    """Format a monthly ¥ figure compactly: ¥712k / ¥1.2M / ¥980."""
    y = float(yen or 0.0)
    if y >= 1_000_000:
        return f"¥{y / 1_000_000:.1f}M"
    if y >= 1_000:
        return f"¥{round(y / 1_000)}k"
    return f"¥{round(y)}"


def _working_hours(model: WarehouseModel) -> float:
    """稼働時間/日 for the 人時→人数 conversion: model.simulation, else 8.0."""
    try:
        h = float(getattr(model.simulation, "shift_hours_per_day", 8.0) or 8.0)
        return h if h > 0 else 8.0
    except Exception:  # noqa: BLE001 — never blocks
        return 8.0


def _chain_row(model: WarehouseModel) -> dict:
    """工程↔エリア種別 chain check (the only new validation logic).

    For each process stage, resolve its bound zone's type and check membership in
    the stage's allowed set (STAGE_ZONE_TYPES). Unbound (zone is None / missing)
    or type-mismatched stages are counted as problems. 0 problems => ok ("✓ 連鎖
    OK"); >0 => warn ("⚠ N件") with the first offending stage's label in `sub`.
    Stages whose id is not in the contract are skipped (no opinion)."""
    row = {"id": "chain", "label": "連鎖", "view": "design", "unit": ""}
    try:
        zone_type = {z.id: z.type for z in model.layout.zones}
        problems: list[str] = []
        for st in model.process.stages:
            allowed = STAGE_ZONE_TYPES.get(st.id)
            if allowed is None:
                continue
            zt = zone_type.get(st.zone) if st.zone else None
            if zt not in allowed:
                problems.append(st.label or st.id)
        if problems:
            row.update(value=f"⚠ {len(problems)}件", tone="warn", sub=problems[0])
        else:
            row.update(value="✓ 連鎖OK", tone="ok", sub="")
    except Exception:  # noqa: BLE001 — never blocks
        row.update(**_DASH)
    return row


def _verdict_row(model: WarehouseModel) -> dict:
    """判定/稼働率 ← analytic.estimate (overloaded / picker_utilization /
    capacity_orders_per_hr / offered_orders_per_hr)."""
    row = {"id": "verdict", "label": "判定", "view": "analysis", "unit": ""}
    try:
        est = analytic.estimate(model)
        cap = float(est.get("capacity_orders_per_hr", 0.0) or 0.0)
        off = float(est.get("offered_orders_per_hr", 0.0) or 0.0)
        if off <= 0:  # no demand → nothing to judge yet
            row.update(**_DASH)
            return row
        overloaded = bool(est.get("overloaded"))
        sub = f"容量{cap:.0f} {'<' if overloaded else '>'} 需要{off:.0f} 件/h"
        if overloaded:
            row.update(value="⚠ 捌けない", tone="bad", sub=sub)
        else:
            row.update(value="✓ 捌ける", tone="ok", sub=sub)
        row["num"] = round(float(est.get("picker_utilization", 0.0) or 0.0), 3)
    except Exception:  # noqa: BLE001 — never blocks
        row.update(**_DASH)
    return row


def _cost_rows(model: WarehouseModel) -> tuple[dict, dict]:
    """原価 ← cost.estimate_cost (total_yen_month / cost_per_order / mh_per_day)
    AND 人員 = ceil(mh_per_day / 稼働時間/日). Both rows come off one estimate so
    they never disagree."""
    cost_row = {"id": "cost", "label": "原価", "view": "cost", "unit": "/月"}
    head_row = {"id": "headcount", "label": "人員", "view": "timetable", "unit": "人"}
    try:
        c = cost.estimate_cost(model, {})
        mh = float(c.get("mh_per_day", 0.0) or 0.0)
        per_order = float(c.get("cost_per_order", 0.0) or 0.0)
        total = float(c.get("total_yen_month", 0.0) or 0.0)
        if total <= 0 and mh <= 0:  # no 物量 → nothing costed
            cost_row.update(**_DASH)
            head_row.update(**_DASH)
            return cost_row, head_row
        cost_row.update(value=_fmt_yen(total), tone="neutral",
                        sub=f"¥{per_order:,.0f} /件" if per_order else "",
                        num=round(total), per_order=round(per_order, 1))
        # 人時 → 人数 (the only other new calc). ceil so a fractional shift still
        # books a whole head, matching how the timetable staffs a process.
        hours = _working_hours(model)
        people = math.ceil(mh / hours) if mh > 0 else 0
        head_row.update(value=str(people), tone="neutral",
                        sub=f"{mh:.0f} 人時/日", num=people)
    except Exception:  # noqa: BLE001 — never blocks
        cost_row.update(**_DASH)
        head_row.update(**_DASH)
    return cost_row, head_row


def _productivity_row(model: WarehouseModel) -> dict:
    """生産性 ← pickrate.estimate_pickrate (recommend_id, methods[].lines_per_hour
    / .label). Show the recommended method's 行/h and its label."""
    row = {"id": "productivity", "label": "生産性", "view": "pickrate", "unit": "行/h"}
    try:
        pr = pickrate.estimate_pickrate(model, {})
        methods = pr.get("methods") or []
        if not methods:
            row.update(**_DASH)
            return row
        rid = pr.get("recommend_id")
        best = next((m for m in methods if m.get("id") == rid), methods[0])
        lph = float(best.get("lines_per_hour", 0.0) or 0.0)
        row.update(value=f"{lph:.0f}", tone="neutral",
                   sub=f"推奨: {best.get('label', '')}", num=round(lph, 1))
    except Exception:  # noqa: BLE001 — never blocks
        row.update(**_DASH)
    return row


def _tsubo_row(model: WarehouseModel) -> dict:
    """坪数 ← storage.estimate_storage (has_data / totals.tsubo_total /
    cost.total_yen)."""
    row = {"id": "tsubo", "label": "坪数", "view": "storage", "unit": "坪"}
    try:
        st = storage.estimate_storage(model, {})
        if not st.get("has_data"):
            row.update(**_DASH)
            return row
        tsubo = float(st.get("totals", {}).get("tsubo_total", 0.0) or 0.0)
        store_yen = float(st.get("cost", {}).get("total_yen", 0.0) or 0.0)
        row.update(value=f"{tsubo:.1f}", tone="neutral",
                   sub=f"保管 {_fmt_yen(store_yen)}/月", num=round(tsubo, 1))
    except Exception:  # noqa: BLE001 — never blocks
        row.update(**_DASH)
    return row


def _run_block(run_metrics: dict | None) -> dict:
    """The `run` block: the last completed DES run's headline numbers, for the
    rail's 解析値 vs 実測 delta. ``run_metrics`` is the aggregated kpis.json
    (or None). Returns {"exists": False} when there is no run."""
    if not run_metrics:
        return {"exists": False}
    m = run_metrics

    def _num(*keys):
        for k in keys:
            v = m.get(k)
            if isinstance(v, (int, float)):
                return float(v)
        return None

    out: dict = {"exists": True}
    if m.get("verdict") is not None:
        out["verdict"] = m.get("verdict")
    cpo = _num("total_cost_per_order", "cost_per_order")
    if cpo is not None:
        out["cost_per_order"] = round(cpo, 1)
    hc = _num("headcount")
    if hc is not None:
        out["headcount"] = hc
    tput = _num("throughput_per_hr")
    if tput is not None:
        out["throughput_per_hr"] = round(tput, 1)
    mp = m.get("measured_productivity")
    if isinstance(mp, dict) and mp:
        out["measured_productivity"] = mp
    return out


def build_scorecard(model: WarehouseModel, run_metrics: dict | None = None) -> dict:
    """Compose the 6-row design scorecard analytically (no DES). Pure, JSON-able,
    never raises: a bare model yields all 6 rows with value="—" where there is no
    data. ``run_metrics`` is the last DES run's aggregated kpis.json (or None) —
    when present it populates the `run` block for the rail's delta view.

    The row order is fixed (the rail renders them in this order):
    判定 / 人員 / 原価 / 生産性 / 坪数 / 連鎖."""
    cost_row, head_row = _cost_rows(model)
    rows = [
        _verdict_row(model),
        head_row,
        cost_row,
        _productivity_row(model),
        _tsubo_row(model),
        _chain_row(model),
    ]
    try:
        has_layout = bool([z for z in model.layout.zones if z.type == "storage"])
    except Exception:  # noqa: BLE001
        has_layout = False
    return {
        "source": "analytic",
        "has_layout": has_layout,
        "rows": rows,
        "run": _run_block(run_metrics),
    }
