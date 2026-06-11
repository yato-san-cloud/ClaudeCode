"""原価積み上げ — fast, analytic 3PL cost build-up (LOGISTEED 試算フロー 6費目).

The company's logic is analytic-first ("辻褄が追える"): 物量 → 工数 → 原価, every ¥
traceable to a `物量 × 単価` formula. This builds that up WITHOUT a SimPy run
(爆速), reusing the SAME analytic productivities as the timetable
(``staffing.GENERIC_PROCESSES``) and the SAME storage sizing as the 保管設計 view —
so the cost ties exactly to the numbers the user already saw. The DES run then
stress-tests this estimate (where it jams / whether it holds at peak).

費目 (LOGISTEED 第二部):
  ① 作業費(人件費)  = Σ 工程(物量/日 ÷ 生産性 = 人時/日) × 稼働日 × 人件費単価 ＋ 固定人件費
  ② 保管費          = 倉庫料(必要坪 × 坪単価) ＋ 設備月額    [whsim.storage]
  ③ 輸配送費        = 出荷カゴ台車/日 × 稼働日 × 台車単価       (単価0なら計上しない)
  ④ システム費      = 固定 ¥/月                                (0なら計上しない)
  ⑤ 運営費          = 運営費率 × (①+②+③+④)                  (0なら計上しない)
Every line carries {label, yen, basis, formula} so the screen/proposal can show
the working, like the company's own tool.
"""

from __future__ import annotations

from whsim import bi, storage
from whsim.analysis.staffing import GENERIC_PROCESSES
from whsim.schema.model import WarehouseModel

# base_volumes key feeding each GENERIC_PROCESSES driver (analytic 工数の母数).
_DRIVER_VOL = {
    "in_lines": "in_cases",   # 受入行 ≈ 入荷ケース
    "in_qty": "in_pieces",    # 格納点数
    "out_lines": "out_lines",
    "out_orders": "out_orders",
}


def _labor_lines(model: WarehouseModel, vol: dict, days: float, rate: float):
    """Per-process daily 人時 and its monthly labour cost, from the SAME drivers/
    productivities the analytic timetable uses. A 実測採用値
    (settings.productivity_overrides[process]) supersedes the benchmark prod when
    present — the 想定→実測 swap. Returns (lines, total_mh_day, monthly_yen)."""
    overrides = getattr(model.settings, "productivity_overrides", {}) or {}
    lines = []
    total_mh = 0.0
    for p in GENERIC_PROCESSES:
        v = float(vol.get(_DRIVER_VOL.get(p["driver"], ""), 0.0) or 0.0)
        ov = overrides.get(p["id"])
        prod = max(1.0, float(ov)) if ov else max(1.0, float(p["prod"]))
        mh = v / prod                      # 人時/日
        if mh <= 0:
            continue
        total_mh += mh
        lines.append({
            "id": p["id"], "section": p["section"],
            "volume": round(v, 1), "unit": p["unit"], "prod": round(prod, 1),
            "adopted": bool(ov),   # True = 実測採用値 (else 想定/ベンチマーク)
            "mh_day": round(mh, 2),
            "yen_month": round(mh * days * rate),
            "formula": f"{v:,.0f}{p['unit'].split('/')[0]} ÷ {prod:g}"
                       f"{'(実測)' if ov else ''} = "
                       f"{mh:.1f}人時/日 × {days:g}日 × {rate:,.0f}",
        })
    return lines, total_mh, round(total_mh * days * rate)


def estimate_cost(model: WarehouseModel, params: dict | None = None) -> dict:
    """解析的原価積み上げ. Pure, JSON-able, never raises. `params` overrides any
    Settings unit price (same keys); `nonworking` flows to the 稼働日 calendar."""
    p = params or {}
    s = model.settings

    def _num(key, default):
        v = p.get(key, getattr(s, key, default))
        try:
            return float(v)
        except (TypeError, ValueError):
            return float(default)

    cur = s.currency or "¥"
    days = max(1.0, _num("working_days_per_month", 22.0))
    labor_rate = max(0.0, _num("labor_cost_per_hour", 2000.0))
    fixed_labor = max(0.0, _num("fixed_labor_per_month", 0.0))
    tsubo_rate = max(0.0, _num("tsubo_rate_per_month", 4300.0))
    cage_rate = max(0.0, _num("delivery_cost_per_cage", 0.0))
    system_yen = max(0.0, _num("system_cost_per_month", 0.0))
    overhead = max(0.0, _num("overhead_rate", 0.0))

    nonworking = set()
    nw = p.get("nonworking")
    if isinstance(nw, (list, tuple, set)):
        nonworking = {int(x) for x in nw if isinstance(x, int) or str(x).isdigit()}
    elif isinstance(nw, str):
        nonworking = {int(x) for x in nw.split(",") if x.strip().isdigit()}

    vol = bi.base_volumes(model, nonworking)
    derived = bi.derive_volumes(model, {"nonworking": sorted(nonworking)})["derived"]

    # ① 作業費 (人件費)
    labor_lines, mh_day, labor_var = _labor_lines(model, vol, days, labor_rate)
    labor_yen = labor_var + round(fixed_labor)

    # ② 保管費
    st = storage.estimate_storage(model, {"tsubo_rate": tsubo_rate})
    store_yen = round(st.get("cost", {}).get("total_yen", 0)) if st.get("has_data") else 0

    # ③ 輸配送費 (出荷カゴ台車ベース; 単価未設定なら0)
    cages_day = float(derived.get("out_cages", 0) or 0)
    delivery_yen = round(cages_day * days * cage_rate)

    # ④ システム費 / ⑤ 運営費
    system_month = round(system_yen)
    subtotal = labor_yen + store_yen + delivery_yen + system_month
    overhead_month = round(subtotal * overhead)
    total = subtotal + overhead_month

    orders_month = float(vol.get("out_orders", 0) or 0) * days
    per_order = round(total / orders_month, 1) if orders_month > 0 else 0.0

    categories = [
        {"key": "labor", "label": "① 作業費（人件費）", "yen_month": labor_yen,
         "basis": f"{mh_day:.1f} 人時/日 × {days:g}日",
         "formula": f"工程別 物量÷生産性 の合計 {mh_day:.1f}人時/日 × {days:g}日 × "
                    f"{cur}{labor_rate:,.0f}/人時"
                    + (f" ＋ 固定 {cur}{fixed_labor:,.0f}" if fixed_labor else ""),
         "detail": labor_lines},
        {"key": "storage", "label": "② 保管費（倉庫料＋設備）", "yen_month": store_yen,
         "basis": (f"{st['totals']['tsubo_storage']}坪 × {cur}{tsubo_rate:,.0f}"
                   if st.get("has_data") else "保管物量なし"),
         "formula": (f"倉庫料 {cur}{st['cost']['warehouse_yen']:,.0f} ＋ 設備 "
                     f"{cur}{st['cost']['equipment_yen']:,.0f}" if st.get("has_data") else "—"),
         "detail": st.get("by_method", []) if st.get("has_data") else []},
        {"key": "delivery", "label": "③ 輸配送費", "yen_month": delivery_yen,
         "basis": (f"{cages_day:,.0f} 台車/日 × {days:g}日" if cage_rate else "単価未設定"),
         "formula": (f"{cages_day:,.0f}台車/日 × {days:g}日 × {cur}{cage_rate:,.0f}/台"
                     if cage_rate else "原価試算で台車単価を設定すると計上されます"),
         "detail": []},
        {"key": "system", "label": "④ システム費", "yen_month": system_month,
         "basis": "固定/月" if system_month else "未設定",
         "formula": (f"{cur}{system_month:,.0f}/月" if system_month
                     else "原価試算でシステム費を設定すると計上されます"), "detail": []},
        {"key": "overhead", "label": "⑤ 運営費", "yen_month": overhead_month,
         "basis": (f"小計 × {overhead * 100:.0f}%" if overhead else "未設定"),
         "formula": (f"({cur}{subtotal:,.0f}) × {overhead * 100:.0f}%" if overhead
                     else "原価試算で運営費率を設定すると計上されます"), "detail": []},
    ]

    return {
        "currency": cur,
        "working_days": days,
        "nonworking": sorted(nonworking),
        "rates": {"labor_cost_per_hour": labor_rate,
                  "forklift_cost_per_hour": _num("forklift_cost_per_hour", 1600.0),
                  "fixed_labor_per_month": fixed_labor, "tsubo_rate_per_month": tsubo_rate,
                  "delivery_cost_per_cage": cage_rate, "system_cost_per_month": system_yen,
                  "overhead_rate": overhead},
        "categories": categories,
        "total_yen_month": total,
        "cost_per_order": per_order,
        "orders_per_month": round(orders_month),
        "mh_per_day": round(mh_day, 1),
    }
