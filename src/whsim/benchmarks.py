"""生産性ベンチマークライブラリ — 物流形態別の "想定生産性" プリセット.

The company's 集合知 (accumulated benchmark productivity by logistics format) is
the real long-term asset: a good 想定 prior the analytic cost/timetable start
from, before the DES measures the real productivity on the actual layout (the
想定→実測 loop in whsim.kpis / cost). This is the BOX that holds it.

Each preset carries:
  - productivity: {process_id: rate}  — 想定生産性 in each GENERIC_PROCESSES' unit
    (only the processes that differ from the engine default need listing).
  - planning: a few planning defaults typical of that format (在庫日数・荷姿…).
The seed values below are JP-3PL ballparks **to be replaced by the company's own
measured library** — every entry is marked `seed: True` so the UI can flag it.
Applying a preset writes its productivity into settings.benchmark_productivity
(the 想定 tier) and its planning defaults into settings; nothing is destructive.
"""

from __future__ import annotations

# process ids match whsim.analysis.staffing.GENERIC_PROCESSES
# (入荷検品 / 格納 / ピッキング / 検品 / 梱包 / 出荷). Units, for reference:
#   入荷検品 行/h ・ 格納 点/h ・ ピッキング 行/h ・ 検品 行/h ・ 梱包 件/h ・ 出荷 件/h
LIBRARY: list[dict] = [
    {
        "id": "ec_small", "label": "EC小口（多品種・1行少）",
        "desc": "通販EC。多SKU・1オーダー行数少・ピース主体。摘み取り/マルチ向き。",
        "productivity": {"ピッキング": 60, "検品": 120, "梱包": 30, "格納": 120},
        "planning": {"stock_days": 14, "cases_per_pallet": 40, "pieces_per_orikon": 30,
                     "units_per_cage": 14, "tsubo_rate_per_month": 4300},
        "seed": True,
    },
    {
        "id": "apparel", "label": "アパレル（吊るし・セット作業）",
        "desc": "衣料。ハンガー/畳み混在、検品・値札・セット加工が重い。",
        "productivity": {"ピッキング": 45, "検品": 90, "梱包": 22, "格納": 100},
        "planning": {"stock_days": 30, "cases_per_pallet": 30, "pieces_per_orikon": 20,
                     "units_per_cage": 12, "tsubo_rate_per_month": 4500},
        "seed": True,
    },
    {
        "id": "food_cold", "label": "食品・要冷（ケース・高回転）",
        "desc": "食品/飲料。ケース出荷主体・高回転・温度帯。パレット/ケース速い。",
        "productivity": {"入荷検品": 60, "ピッキング": 100, "検品": 160, "梱包": 45, "格納": 160},
        "planning": {"stock_days": 7, "cases_per_pallet": 50, "pieces_per_orikon": 24,
                     "units_per_cage": 16, "tsubo_rate_per_month": 5500},
        "seed": True,
    },
    {
        "id": "pharma", "label": "医薬・高精度（ロット/期限）",
        "desc": "医薬/化粧品。ロット・使用期限・高精度。検品丁寧で生産性控えめ。",
        "productivity": {"入荷検品": 30, "ピッキング": 45, "検品": 90, "梱包": 25, "格納": 90},
        "planning": {"stock_days": 21, "cases_per_pallet": 36, "pieces_per_orikon": 25,
                     "units_per_cage": 12, "tsubo_rate_per_month": 5000},
        "seed": True,
    },
    {
        "id": "threepl_multi", "label": "3PL多品種（混在荷主）",
        "desc": "複数荷主の混在。ケース/ピース/ボール混在。汎用バランス値。",
        "productivity": {"ピッキング": 65, "検品": 120, "梱包": 32, "格納": 120},
        "planning": {"stock_days": 18, "cases_per_pallet": 40, "pieces_per_orikon": 28,
                     "units_per_cage": 14, "tsubo_rate_per_month": 4300},
        "seed": True,
    },
]

_BY_ID = {b["id"]: b for b in LIBRARY}


def catalog() -> list[dict]:
    """List of presets for the API/UI (without mutating the library)."""
    return [dict(b) for b in LIBRARY]


def get(bid: str) -> dict | None:
    return _BY_ID.get(bid)


def apply(model, bid: str) -> dict:
    """Apply a preset to the model's settings: 想定生産性 → benchmark_productivity,
    planning defaults → settings unit prices / (bi-side) handled by caller. Pure
    over the model (mutates settings only); returns a summary. Unknown id no-ops."""
    b = _BY_ID.get(bid)
    if not b:
        return {"ok": False, "message": f"未知のベンチマーク: {bid}"}
    s = model.settings
    s.benchmark_productivity = {str(k): float(v) for k, v in (b.get("productivity") or {}).items()}
    s.benchmark_id = bid
    plan = b.get("planning") or {}
    # Only the settings-resident planning knobs are written here; the 荷姿 ones
    # (cases_per_pallet/pieces_per_orikon/units_per_cage) live in the client 仮値
    # and are returned for the caller to seed the 基礎物量 view.
    if "tsubo_rate_per_month" in plan:
        s.tsubo_rate_per_month = float(plan["tsubo_rate_per_month"])
    return {"ok": True, "id": bid, "label": b["label"],
            "productivity": s.benchmark_productivity, "planning": plan,
            "message": f"「{b['label']}」のベンチマーク生産性を適用しました（想定値）。"}
