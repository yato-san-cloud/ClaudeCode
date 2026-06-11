"""保管設備の試算 — demand → required storage equipment → 間口/坪数 → 保管費.

A pure, parametric implementation of the LOGISTEED 設備費用算出ステップ
(データ整理 → 荷動き → 出荷形態/サイズ → 保管方法 → 必要保管機器算出 →
レイアウト坪数 → コスト) over whsim's canonical model + the racktypes catalog.

Per SKU it derives a storage quantity (在庫数, else 平均出荷数×在庫日数), picks a
保管方法 (rack_type) from ABC + bulk, then aggregates per method to 間口(cells) /
台数(units) / 坪数(footprint×aisle) and finally 保管費 = 倉庫料(坪×坪単価) +
設備月額(Σ 台数×単価/償却). Every input has a default → never blocks, always
runnable; the output is JSON-able for the API / a BI-style view / the 3D scene.
"""

from __future__ import annotations

import math

from whsim import racktypes
from whsim.schema.model import WarehouseModel

TSUBO_M2 = 3.305785  # 1坪 = 3.305785 ㎡ (deck: 1坪≒3.3㎡)

# Default storage 試算 parameters (all overridable via the params dict).
DEFAULTS = {
    "stock_days": 14.0,     # 在庫日数 (used when an item carries no stock figure)
    "tsubo_rate": 4300,     # 坪単価 円/坪/月 (deck p51: 保管 4,300円/坪)
    "aisle_factor": 1.9,    # 通路・荷役の余裕 (設備占有坪 × これ = 必要坪)
    "office_tsubo": 0.0,    # 事務所など固定坪 (任意)
    "bulk_cases": 24,       # この保管ケース数を超えると bulk 扱い → パレット保管
}

def _pick_rack(abc: str, cases: int, bulk_cases: float) -> str:
    """保管方法の選定 (出荷形態/頻度ベース、説明可能なルール):
    A品=高頻度→流動棚(FIFO ピック面)、B品=中量棚、C品=低頻度で大ロットなら
    パレット(bulk)・小ロットなら中量棚。頻度(ABC)を主、ロット(cases)を従にする。"""
    if abc == "A":
        return "flow"
    if abc == "B":
        return "medium"
    return "pallet" if cases >= bulk_cases else "medium"  # C品


def _working_days(model: WarehouseModel) -> int:
    """Distinct synthetic days spanned by the outbound orders (>=1)."""
    days = {int((o.arrival_s or 0.0) // 86400) for o in model.orders.outbound}
    return max(1, len(days))


def _shipped_by_sku(model: WarehouseModel) -> dict[str, float]:
    """Total outbound pieces per SKU across all orders."""
    out: dict[str, float] = {}
    for o in model.orders.outbound:
        for ln in o.lines:
            out[ln.sku] = out.get(ln.sku, 0.0) + float(ln.qty or 0)
    return out


def estimate_storage(model: WarehouseModel, params: dict | None = None) -> dict:
    """Size storage equipment + cost from demand. Pure; returns JSON-able dict."""
    p = {**DEFAULTS, **{k: v for k, v in (params or {}).items() if v is not None}}
    stock_days = max(0.0, float(p["stock_days"]))
    tsubo_rate = max(0.0, float(p["tsubo_rate"]))
    aisle = max(1.0, float(p["aisle_factor"]))
    bulk_cases = max(1.0, float(p["bulk_cases"]))

    wdays = _working_days(model)
    shipped = _shipped_by_sku(model)

    # Aggregate per rack_type. Each bucket tallies items / pieces / cases / cells.
    buckets: dict[str, dict] = {}
    sized_skus = 0

    for it in model.items:
        case_qty = max(1, int(it.case_qty or 1))
        # 保管ピース数: prefer real stock, else 平均出荷/日 × 在庫日数.
        if (it.stock or 0) > 0:
            pieces = float(it.stock)
        else:
            avg_daily = shipped.get(it.sku, 0.0) / wdays
            pieces = avg_daily * stock_days
        if pieces <= 0:
            continue
        sized_skus += 1
        cases = math.ceil(pieces / case_qty)

        # 保管方法: ABC(頻度)を主、ロット(cases)を従に選ぶ。
        abc = it.abc_class if it.abc_class in ("A", "B", "C") else "C"
        rack_id = _pick_rack(abc, cases, bulk_cases)

        rt = racktypes.get(rack_id)
        cap = max(1, int(rt.get("capacity", 1)))
        cells = max(1, math.ceil(pieces / cap))   # 間口 needed for this SKU

        b = buckets.setdefault(rack_id, {"items": 0, "pieces": 0.0, "cases": 0, "cells": 0})
        b["items"] += 1
        b["pieces"] += pieces
        b["cases"] += cases
        b["cells"] += cells

    # Finalise each bucket: 台数 / 坪数 / pallets, in racktypes ORDER.
    by_method = []
    tsubo_storage = 0.0
    equip_yen = 0.0
    for rack_id in racktypes.ORDER:
        b = buckets.get(rack_id)
        if not b:
            continue
        rt = racktypes.get(rack_id)
        bays_per_unit = max(1, int(rt.get("bays_per_unit", 1)))
        levels = max(1, int(rt.get("levels", 1)))
        cells_per_unit = bays_per_unit * levels
        units = max(1, math.ceil(b["cells"] / cells_per_unit))   # 台数(基)
        unit_m2 = float(rt["bay"]) * bays_per_unit * float(rt["depth"])
        unit_tsubo = unit_m2 / TSUBO_M2
        footprint_tsubo = units * unit_tsubo * aisle
        tsubo_storage += footprint_tsubo
        unit_price = float(rt.get("unit_price", 0))
        life = max(1, int(rt.get("life_months", 60)))
        method_yen = units * unit_price / life
        equip_yen += method_yen
        by_method.append({
            "rack_type": rack_id,
            "label": rt.get("label", rack_id),
            "color": rt.get("color", "#888"),
            "items": b["items"],
            "pieces": round(b["pieces"]),
            "cases": b["cases"],
            "cells": b["cells"],          # 間口(フェイス)数
            "units": units,               # 台数(基)
            "footprint_tsubo": round(footprint_tsubo, 1),
            "unit_price": int(unit_price),
            "monthly_yen": round(method_yen),
        })

    tsubo_total = tsubo_storage + max(0.0, float(p["office_tsubo"]))
    warehouse_yen = tsubo_total * tsubo_rate
    total_yen = warehouse_yen + equip_yen

    return {
        "has_data": sized_skus > 0,
        "params": {"stock_days": stock_days, "tsubo_rate": int(tsubo_rate),
                   "aisle_factor": aisle, "office_tsubo": float(p["office_tsubo"]),
                   "bulk_cases": int(bulk_cases)},
        "working_days": wdays,
        "by_method": by_method,
        "totals": {
            "skus": sized_skus,
            "cells": sum(m["cells"] for m in by_method),
            "units": sum(m["units"] for m in by_method),
            "tsubo_storage": round(tsubo_storage, 1),
            "tsubo_total": round(tsubo_total, 1),
        },
        "cost": {
            "tsubo_rate": int(tsubo_rate),
            "warehouse_yen": round(warehouse_yen),   # 倉庫料/月
            "equipment_yen": round(equip_yen),       # 設備月額/月
            "total_yen": round(total_yen),           # 保管費/月
        },
    }
