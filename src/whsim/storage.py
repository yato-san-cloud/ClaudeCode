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

from whsim import asrs, racktypes
from whsim.schema.model import WarehouseModel

TSUBO_M2 = 3.305785  # 1坪 = 3.305785 ㎡ (deck: 1坪≒3.3㎡)

# Default storage 試算 parameters (all overridable via the params dict).
DEFAULTS = {
    "stock_days": 14.0,     # 在庫日数 (used when an item carries no stock figure)
    "tsubo_rate": 4300,     # 坪単価 円/坪/月 (deck p51: 保管 4,300円/坪)
    "aisle_factor": 1.9,    # 通路・荷役の余裕 (設備占有坪 × これ = 必要坪)
    "office_tsubo": 0.0,    # 事務所など固定坪 (任意)
    "bulk_cases": 24,       # この保管ケース数を超えると bulk 扱い → パレット保管
    # bulk C品の受け皿ラック: 既定はパレット。"asrs" を選ぶと大ロット低頻度品を
    # 自動倉庫に寄せ、クレーン台数を FEM 9.851 サイクルタイムで算出する。
    "bulk_rack_type": "pallet",
    "working_hours_per_day": 8.0,   # 稼働時間/日 (AS/RS スループット換算に使用)
    # AS/RS クレーン諸元。None → racktypes の asrs プリセット既定にフォールバック。
    "crane_vx": None, "crane_vy": None, "crane_tfix": None,
    "crane_rack_len_m": None, "crane_rack_height_m": None,
    "asrs_command": "dual",         # クレーン台数の算定基準: "dual" | "single"
}

_BULK_ALLOWED = {"pallet", "nestainer", "asrs"}  # bulk C品を寄せてよい保管方法


def _pick_rack(abc: str, cases: int, bulk_cases: float,
               bulk_rack: str = "pallet") -> str:
    """保管方法の選定 (出荷形態/頻度ベース、説明可能なルール):
    A品=高頻度→流動棚(FIFO ピック面)、B品=中量棚、C品=低頻度で大ロットなら
    bulk保管(既定パレット、任意で自動倉庫)・小ロットなら中量棚。頻度(ABC)を主、
    ロット(cases)を従にする。"""
    if abc == "A":
        return "flow"
    if abc == "B":
        return "medium"
    bulk = bulk_rack if bulk_rack in _BULK_ALLOWED else "pallet"
    return bulk if cases >= bulk_cases else "medium"  # C品


def _asrs_crane_sizing(p: dict, out_cases_total: float, wdays: int) -> dict:
    """FEM 9.851 crane cycle model → sizing dict for the AS/RS bucket.

    Reads the crane諸元 from the params (falling back to the racktypes ``asrs``
    preset), turns the bucket's outbound case flow into a retrieval demand
    (unit-loads/h over the working day) and returns ``whsim.asrs.size_asrs``.
    Pure; every field defaulted so it never blocks."""
    preset = racktypes.get("asrs")

    def _num(key: str, fallback: float) -> float:
        v = p.get(key)
        if v is None:
            v = preset.get(key, fallback)
        try:
            return float(v)
        except (TypeError, ValueError):
            return float(fallback)

    vx = max(0.01, _num("crane_vx", 2.5))
    vy = max(0.01, _num("crane_vy", 0.5))
    t_fix = max(0.0, _num("crane_tfix", 8.0))
    L = max(0.0, _num("crane_rack_len_m", 45.0))
    H = max(0.0, _num("crane_rack_height_m", 18.0))
    hours = max(0.1, float(p.get("working_hours_per_day") or 8.0))
    command = "single" if p.get("asrs_command") == "single" else "dual"

    # Retrieval demand: outbound unit-loads (≈ cases) per operating hour. Steady
    # inventory ⇒ put-away balances retrieval, so in ≈ out (size_asrs default).
    out_per_h = (out_cases_total / max(1, wdays)) / hours
    return asrs.size_asrs(L, H, vx, vy, t_fix, out_per_h, command=command)


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
    bulk_rack = p.get("bulk_rack_type") or "pallet"

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
        rack_id = _pick_rack(abc, cases, bulk_cases, bulk_rack)

        rt = racktypes.get(rack_id)
        cap = max(1, int(rt.get("capacity", 1)))
        cells = max(1, math.ceil(pieces / cap))   # 間口 needed for this SKU
        # 出庫フロー: SKUの総出荷ピース→ケース換算 (AS/RS スループット算定に使う)。
        out_cases = shipped.get(it.sku, 0.0) / case_qty

        b = buckets.setdefault(rack_id, {"items": 0, "pieces": 0.0, "cases": 0,
                                         "cells": 0, "out_cases": 0.0})
        b["items"] += 1
        b["pieces"] += pieces
        b["cases"] += cases
        b["cells"] += cells
        b["out_cases"] += out_cases

    # Finalise each bucket: 台数 / 坪数 / pallets, in racktypes ORDER.
    by_method = []
    tsubo_storage = 0.0
    equip_yen = 0.0
    asrs_block = None
    for rack_id in racktypes.ORDER:
        b = buckets.get(rack_id)
        if not b:
            continue
        rt = racktypes.get(rack_id)
        bays_per_unit = max(1, int(rt.get("bays_per_unit", 1)))
        levels = max(1, int(rt.get("levels", 1)))
        cells_per_unit = bays_per_unit * levels
        units = max(1, math.ceil(b["cells"] / cells_per_unit))   # 台数(基)
        crane = None
        if rack_id == "asrs":
            # 自動倉庫の 台数 = クレーン(=アイル)数。保管容量で決まる台数と、
            # FEM 9.851 サイクルタイムのスループットで決まる台数の大きい方が律速。
            crane = _asrs_crane_sizing(p, b.get("out_cases", 0.0), wdays)
            crane["cranes_capacity"] = units          # 容量律速のアイル数
            crane["cranes_throughput"] = crane["cranes"]  # スループット律速
            units = max(units, crane["cranes"])
            crane["cranes"] = units                   # 最終採用台数
        unit_m2 = float(rt["bay"]) * bays_per_unit * float(rt["depth"])
        unit_tsubo = unit_m2 / TSUBO_M2
        footprint_tsubo = units * unit_tsubo * aisle
        tsubo_storage += footprint_tsubo
        unit_price = float(rt.get("unit_price", 0))
        life = max(1, int(rt.get("life_months", 60)))
        method_yen = units * unit_price / life
        equip_yen += method_yen
        row = {
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
        }
        if crane is not None:
            row["asrs"] = crane           # E(SC)/E(DC)・cycles/h・クレーン台数
            asrs_block = crane
        by_method.append(row)

    tsubo_total = tsubo_storage + max(0.0, float(p["office_tsubo"]))
    warehouse_yen = tsubo_total * tsubo_rate
    total_yen = warehouse_yen + equip_yen

    out = {
        "has_data": sized_skus > 0,
        "params": {"stock_days": stock_days, "tsubo_rate": int(tsubo_rate),
                   "aisle_factor": aisle, "office_tsubo": float(p["office_tsubo"]),
                   "bulk_cases": int(bulk_cases), "bulk_rack_type": bulk_rack},
        "working_days": wdays,
        "by_method": by_method,
        # AS/RS を使う構成のときだけ埋まる (FEM 9.851 クレーンサイクル)。それ以外は None。
        "asrs": asrs_block,
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
    return out


# --- 試算 → レイアウト反映 (place the sized equipment as authored shelves) ----

_AISLE_M = {"pallet": 3.0, "nestainer": 3.0, "asrs": 1.6}  # フォーク系は広め
_AISLE_DEFAULT = 2.5


def place_equipment(model: WarehouseModel, estimate: dict) -> dict:
    """Author the sized equipment into the model as ShelfArea runs.

    Lays each method's units (1台 = bays_per_unit×bay long, depth deep) in rows
    inside the largest storage zone (created spanning the floor if none exists),
    facing down, with per-type aisle gaps. REPLACES that zone's shelves (the
    button is explicit about this) and leaves other zones untouched. Tolerant:
    units that don't fit are reported as `unplaced`, never an error."""
    from whsim.schema.model import ShelfArea, Zone

    methods = [m for m in (estimate or {}).get("by_method", []) if m.get("units")]
    if not methods:
        return {"placed": 0, "unplaced": 0, "shelves": 0, "zone": None}

    # Target zone: the largest storage zone by area, else create one on the floor.
    zones = [z for z in model.layout.zones if z.type == "storage"]
    if zones:
        zone = max(zones, key=lambda z: (z.w or 0) * (z.h or 0))
    else:
        b = model.layout.bounds
        zone = Zone(id="storage-auto", type="storage",
                    x=2.0, y=2.0, w=max(6.0, b.width - 4.0), h=max(6.0, b.depth - 4.0))
        model.layout.zones.append(zone)

    margin = 1.0
    x0, y0 = zone.x + margin, zone.y + margin
    x1, y1 = zone.x + zone.w - margin, zone.y + zone.h - margin
    usable_w = max(0.0, x1 - x0)

    # 2層レイアウト (ピック面/バック在庫) + アイル向き: lay the PICK-face equipment
    # (high-frequency, small bins) near the OUTPUT (pack station), and the BULK
    # reserve (pallet/nestainer/asrs) at the far end — so fast movers sit short of
    # the dispatch. Rows face the output side, so the pick aisle opens toward it.
    station = model.resources.stations[0] if model.resources.stations else None
    out_y = station.y if station else (zone.y + zone.h)   # output reference (y)
    near_top = out_y < (zone.y + zone.h / 2)              # output is on the top side?
    # PICK-face rack types first (near output); bulk last. Within each, racktypes
    # ORDER is already pick→bulk-ish, so a stable key by tier suffices.
    _PICK_FACE = {"flow", "medium", "light", "hanger", "mobile"}
    methods = sorted(methods, key=lambda mm: 0 if mm["rack_type"] in _PICK_FACE else 1)
    facing = "up" if near_top else "down"   # pick face opens toward the output

    shelves: list[ShelfArea] = []
    placed = 0
    unplaced = 0
    # Row cursor marches AWAY from the output: from the output edge inward, so the
    # first (pick-face) rows land nearest the dispatch.
    cy = y0 if near_top else (y1)
    seq = 0
    for m in methods:
        rt = racktypes.get(m["rack_type"])
        bays = max(1, int(rt.get("bays_per_unit", 1)))
        run_w = float(rt["bay"]) * bays  # 1台 footprint along the row
        depth = float(rt["depth"])
        aisle = _AISLE_M.get(m["rack_type"], _AISLE_DEFAULT)
        per_row = max(1, int(usable_w // run_w)) if usable_w >= run_w else 0
        todo = int(m["units"])
        if per_row == 0:
            unplaced += todo
            continue
        row_no = 0
        while todo > 0:
            # Row top-edge y for this run (the cursor is the leading edge that
            # marches away from the output; for bottom-output we place upward).
            ry = cy if near_top else (cy - depth)
            if ry < y0 or ry + depth > y1:   # zone is full — report the shortfall
                unplaced += todo
                break
            n = min(per_row, todo)
            # One ShelfArea per row keeps the designer light (a run of n units).
            seq += 1
            row_no += 1
            shelves.append(ShelfArea(
                id=f"auto-{m['rack_type']}-{seq}",
                name=f"{rt.get('label', m['rack_type'])}{row_no:02d}",
                x=round(x0, 2), y=round(ry, 2),
                w=round(run_w * n, 2), h=round(depth, 2),
                rack_type=m["rack_type"], facing=facing,
            ))
            placed += n
            todo -= n
            step = depth + aisle
            cy += step if near_top else -step   # march inward from the output edge
        cy += 0.5 if near_top else -0.5         # small break between groups

    zone.shelves = shelves               # explicit REPLACE of this zone's shelves
    return {"placed": placed, "unplaced": unplaced,
            "shelves": len(shelves), "zone": zone.id}
