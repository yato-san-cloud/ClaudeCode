"""Work-method logic: reverse-naming and recommendation over the 5 axes.

The 5 orthogonal axes (`schema.WorkMethod`) generate the familiar named picking
methods. This module is the pure bridge between the two:

- `method_name(work)`  -> the Japanese name a practitioner would call it.
- `recommend(model)`   -> the axes that suit the order profile, with a reason.
- `legacy_strategy(work)` -> back-compat `PickStrategy` for code still reading it.

Pure functions over the schema; no I/O. Used by the engine, the web backend
(`POST /design`, `GET /workmethod/*`) and surfaced in the floor-plan editor so a
non-expert sees "this == マルチオーダーピッキング相当" as they turn the knobs.
"""

from __future__ import annotations

from dataclasses import dataclass

from .schema.model import WarehouseModel, WorkMethod


def legacy_strategy(work: WorkMethod) -> str:
    """Map the 5 axes back onto the legacy PickStrategy literal."""
    if work.release == "wave":
        return "wave"
    if work.zoning != "none":
        return "zone"
    if work.orders_per_trip > 1 or work.consolidation == "sort":
        return "batch"
    return "discrete"


def method_name(work: WorkMethod) -> str:
    """Reverse-derive the familiar Japanese method name from the axes.

    The point of the tool: the user turns intuitive knobs, and we name the
    result so experts recognise it and novices learn it."""
    if work.transport != "manual":
        gtp = {
            "agv": "goods-to-person（AGV/AMR）",
            "conveyor": "コンベア搬送",
            "asrs": "goods-to-person（自動倉庫）",
        }
        return gtp.get(work.transport, "goods-to-person")
    if work.consolidation == "sort":
        # 種まき: pick item totals, then sort to destinations at a put wall.
        base = "トータルピッキング（種まき）"
        return base + "＋ウェーブ" if work.release == "wave" else base
    # 摘み取り family
    if work.zoning == "parallel":
        return "ゾーンピッキング（並列・集約）"
    if work.zoning == "sequential":
        return "ゾーンピッキング（リレー / pick-and-pass）"
    if work.release == "wave":
        return "ウェーブピッキング"
    if work.orders_per_trip > 1:
        return "マルチオーダー（バッチ / カート）ピッキング"
    return "シングルオーダー（摘み取り都度）"


def explain(work: WorkMethod) -> str:
    """One-line plain-language description of what the axes mean operationally."""
    parts = []
    parts.append("人が歩いて採る" if work.transport == "manual" else "物が作業者に来る")
    if work.orders_per_trip > 1:
        parts.append(f"1巡で{work.orders_per_trip}オーダーまとめる")
    else:
        parts.append("1オーダーずつ")
    if work.zoning == "parallel":
        parts.append("ゾーンを分けて並列に採り後で集約")
    elif work.zoning == "sequential":
        parts.append("ゾーンを順に受け渡し")
    if work.consolidation == "sort":
        parts.append("総量を採ってから出荷先ごとに種まき仕分け")
    if work.release == "wave":
        parts.append(f"{int(work.wave_interval_s/60)}分の波で投入")
    return "、".join(parts) + "。"


@dataclass
class Recommendation:
    work: WorkMethod
    name: str
    reason: str

    def to_dict(self) -> dict:
        return {
            "work": self.work.model_dump(),
            "name": self.name,
            "reason": self.reason,
        }


def _profile_stats(model: WarehouseModel) -> dict:
    """Summarise the order profile that drives method selection: average lines
    per order, distinct SKUs, distinct destinations and peak factor. Works off
    explicit outbound orders if present, else the fallback profile."""
    orders = model.orders.outbound
    skus = {it.sku for it in model.items}
    if orders:
        lines = sum(len(o.lines) for o in orders) / max(1, len(orders))
        skus = {ln.sku for o in orders for ln in o.lines} or skus
        dests = len(orders)
    else:
        lines = model.orders.profile.lines_per_order_mean
        dests = max(1, int(model.orders.profile.rate_per_hr))
    return {
        "lines_per_order": lines,
        "sku_count": len(skus),
        "dest_count": dests,
        "peak": model.orders.profile.peak_factor,
    }


def recommend(model: WarehouseModel) -> Recommendation:
    """Suggest a work method from the order profile, with a one-line rationale.

    Rules of thumb from the literature/practice (see docs/WORK_METHOD_DESIGN.md):
    - few SKUs, large volume, few destinations  -> 種まき (total/sort)
    - many SKUs, many destinations, low lines/order -> 摘み取り (single/multi)
    - high order volume -> batch / wave to share travel
    """
    s = _profile_stats(model)
    sku, dest, lpo = s["sku_count"], s["dest_count"], s["lines_per_order"]

    # Few SKUs + many lines per destination -> total picking (種まき) wins.
    if sku and sku <= 50 and lpo >= 4 and dest <= 200:
        work = WorkMethod(consolidation="sort", orders_per_trip=max(4, dest // 10 or 4))
        reason = (
            f"少品種(SKU約{sku})・1出荷先あたり行数が多い({lpo:.1f}行)ため、"
            "総量を採って後で種まき仕分けする方式が移動を最小化します。"
        )
        return Recommendation(work, method_name(work), reason)

    # High destination volume -> batch/wave to amortise travel.
    if dest >= 300:
        work = WorkMethod(orders_per_trip=min(8, max(2, int(dest / 100))),
                          release="wave")
        reason = (
            f"出荷先が多い(約{dest})ため、複数オーダーをまとめ、締め単位の"
            "ウェーブで投入して移動コストを分散させると効率的です。"
        )
        return Recommendation(work, method_name(work), reason)

    # Many SKUs, modest lines -> multi-order cart picking.
    if lpo <= 2.5:
        work = WorkMethod(orders_per_trip=4)
        reason = (
            f"1オーダーの行数が少ない({lpo:.1f}行)ため、カートで複数オーダーを"
            "同時に回るマルチオーダーピッキングが効きます。"
        )
        return Recommendation(work, method_name(work), reason)

    # Default: simple single-order picking, safe and responsive.
    work = WorkMethod()
    reason = (
        "多品種で出荷先が中規模のため、まずは1オーダーずつの摘み取りが堅実です"
        "（急なオーダーにも即応）。軸を動かして比較してみてください。"
    )
    return Recommendation(work, method_name(work), reason)


# --- 作業方法の比較プリセット (deep-research: 4 points in the 5-axis space) -----
# Each preset is one named picking method = a point in the WorkMethod axis space.
# wave is a separate toggle layered on a preset (release="wave"), not a 5th preset.
METHOD_PRESETS: list[dict] = [
    {"id": "discrete", "label": "都度（摘み取り）",
     "desc": "1オーダーずつ。仕分けゼロ・注文完全性◎・移動最大。",
     "work": {"orders_per_trip": 1, "zoning": "none",
              "consolidation": "pick", "release": "continuous"}},
    {"id": "multi", "label": "マルチオーダー（バッチ/カート）",
     "desc": "複数オーダーを1巡でまとめ採り。移動を大幅削減、仕分けはカート上。",
     "work": {"orders_per_trip": 8, "zoning": "none",
              "consolidation": "pick", "release": "continuous"}},
    {"id": "zone", "label": "ゾーン（並列）",
     "desc": "エリア分担で並列ピック。移動・混雑減、後段で統合。",
     "work": {"orders_per_trip": 4, "zoning": "parallel",
              "consolidation": "pick", "release": "continuous"}},
    {"id": "total", "label": "種まき（トータル）",
     "desc": "総量を一掃き採取→出荷先へ後仕分け。移動最小・仕分け最大。",
     "work": {"orders_per_trip": 16, "zoning": "none",
              "consolidation": "sort", "release": "continuous"}},
]


def pick_stage_index(model: WarehouseModel) -> int:
    """Index of the ピッキング stage (by id), robust to reordered flows."""
    return next((i for i, s in enumerate(model.process.stages)
                 if s.id == "pick"), min(2, len(model.process.stages) - 1))
