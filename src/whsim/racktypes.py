"""Representative warehouse storage-equipment presets (MapMaker ShelfFactory idea).

MapMaker builds shelves through vendor-specific `ShelfFactory` types; whsim mirrors
that with a small catalog of the storage equipment a JP 3PL actually quotes —
軽量棚 / 中量棚 / パレットラック / ネステナー / フローラック / 自動倉庫. Each preset
fixes the cell footprint (bay × depth in metres), level count, a representative
per-cell capacity, and a render colour. A drawn (or imported) SHELF area picks a
type; `design.materialize_racks` lays cells at that type's pitch.
"""

from __future__ import annotations

# bay   = length of one storage position along the rack run (m)
# depth  = rack depth across the run (m)
# levels = vertical levels (informational / capacity scaling)
# capacity = representative per-cell (間口) capacity, in PIECES
# bays_per_unit = bays in one purchasable rack unit (台/基) — cells/台 = bays×levels
# unit_price = 1台あたり設備単価(円), life_months = 償却月数 (設備月額 = unit_price/life)
# (unit economics feed whsim.storage 保管設備の試算; JP-3PL ballpark defaults aligned
#  with the LOGISTEED 設備費用算出ステップ deck — all overridable via params.)
RACK_TYPES: dict[str, dict] = {
    "light":     {"label": "軽量棚",          "bay": 0.9, "depth": 0.45, "levels": 5,
                  "capacity": 30,   "color": "#7fb0f2", "bays_per_unit": 3,
                  "unit_price": 12000, "life_months": 60,
                  "desc": "小物・ピース。手前ピッキング向き。"},
    "medium":    {"label": "中量棚",          "bay": 1.2, "depth": 0.60, "levels": 4,
                  "capacity": 120,  "color": "#2ee6a0", "bays_per_unit": 3,
                  "unit_price": 20000, "life_months": 60,
                  "desc": "ケース・中量品の定番。"},
    "pallet":    {"label": "パレットラック",   "bay": 1.1, "depth": 1.10, "levels": 4,
                  "capacity": 800,  "color": "#f5b05a", "bays_per_unit": 2,
                  "unit_price": 35000, "life_months": 84,
                  "desc": "パレット保管。フォークリフト前提。"},
    "nestainer": {"label": "ネステナー",       "bay": 1.1, "depth": 1.40, "levels": 3,
                  "capacity": 600,  "color": "#9b6bff", "bays_per_unit": 1,
                  "unit_price": 20000, "life_months": 84,
                  "desc": "ネステナー段積み。可搬・レイアウト自由。"},
    "flow":      {"label": "フローラック",     "bay": 1.0, "depth": 1.50, "levels": 3,
                  "capacity": 200,  "color": "#34e3ff", "bays_per_unit": 3,
                  "unit_price": 45000, "life_months": 60,
                  "desc": "流動棚。先入先出のピッキング。"},
    "asrs":      {"label": "自動倉庫(AS/RS)",  "bay": 0.8, "depth": 1.20, "levels": 12,
                  "capacity": 2000, "color": "#5cebff", "bays_per_unit": 1,
                  "unit_price": 600000, "life_months": 120,
                  # Crane cycle-time knobs (FEM 9.851 / Bozer-White; see whsim.asrs).
                  # Storage sizing uses these to size 台数(=クレーン) from throughput
                  # demand instead of a flat capacity split. All overridable via the
                  # 保管試算 params; defaulted so an AS/RS estimate never blocks.
                  "crane_vx": 2.5,        # クレーン水平速度 (m/s)
                  "crane_vy": 0.5,        # 昇降(ホイスト)速度 (m/s)
                  "crane_tfix": 8.0,      # 1回のP/D(荷役)固定時間 (s)
                  "crane_rack_len_m": 45.0,     # 1アイル ラック長 L (m)
                  "crane_rack_height_m": 18.0,  # ラック高さ H (m)
                  "desc": "高層自動倉庫。クレーン入出庫。"},
    # ---- catalog round 2 (LOGISTEED 保管機器事例: メザニン/移動ラック/ハンガー) ----
    "mezzanine": {"label": "メザニン",          "bay": 2.0, "depth": 2.00, "levels": 2,
                  "capacity": 500,  "color": "#b0885f", "bays_per_unit": 1,
                  "unit_price": 250000, "life_months": 120,
                  "desc": "中二階で床面積を倍化。上段からの出荷は昇降設備前提。"},
    "mobile":    {"label": "移動ラック",        "bay": 1.2, "depth": 0.65, "levels": 5,
                  "capacity": 150,  "color": "#e07ad2", "bays_per_unit": 3,
                  "unit_price": 80000, "life_months": 84,
                  "desc": "通路を共有し保管効率最大。低頻度・長期滞留品向き。"},
    "hanger":    {"label": "ハンガーラック",    "bay": 1.8, "depth": 0.60, "levels": 1,
                  "capacity": 60,   "color": "#c8d44e", "bays_per_unit": 2,
                  "unit_price": 30000, "life_months": 60,
                  "desc": "アパレル吊るし保管。シワ・畳みじわ回避。"},
}
ORDER = ["light", "medium", "pallet", "nestainer", "flow", "asrs",
         "mezzanine", "mobile", "hanger"]
DEFAULT = "medium"

# ---- vertical pick model (段からのピックは時間がかかる) -----------------------
# Per-level shelf pitch (m) and who reaches it: manual (human reach/ladder),
# forklift (reach-truck/order-picker hoist), or crane (AS/RS, fast automated). The
# engine turns this into a per-visit vertical access time on top of the handle, so
# picking the top 段 takes longer — and the 2D/3D replay dwell reflects it.
_LEVEL_H = {"light": 0.40, "medium": 0.45, "pallet": 1.50, "nestainer": 1.40,
            "flow": 0.50, "asrs": 0.80, "mezzanine": 2.50, "mobile": 0.40,
            "hanger": 0.0}
_MOVER = {"pallet": "forklift", "nestainer": "forklift", "mezzanine": "forklift",
          "asrs": "crane"}  # everything else is manual reach


def level_height_m(rid: str | None, level: int) -> float:
    """Pick-face height (m) above the ground 段 for `level` (1 = ground/golden)."""
    return max(0.0, int(level) - 1) * _LEVEL_H.get(rid or DEFAULT, 0.40)


def mover(rid: str | None) -> str:
    """Who picks this rack: 'manual' | 'forklift' | 'crane'."""
    return _MOVER.get(rid or DEFAULT, "manual")


def vertical_pick_s(rid: str | None, level: int,
                    lift_mps: float = 0.4, manual_s_per_m: float = 2.0) -> float:
    """Extra seconds to access a pick at `level` (vs the ground 段).

    manual = ergonomic reach/ladder penalty growing with height; forklift =
    hoist up+down at ``lift_mps`` plus a small mast setup; crane = fast automated
    vertical. Level 1 (ground/golden zone) is always 0. Tunable via the two knobs
    (process.lift_speed_mps / process.manual_reach_s_per_m)."""
    h = level_height_m(rid, level)
    if h <= 0.0:
        return 0.0
    m = mover(rid)
    if m == "forklift":
        return 2.0 * h / max(0.1, lift_mps) + 3.0
    if m == "crane":
        return h / max(0.1, lift_mps * 3.0)
    return h * max(0.0, manual_s_per_m)


def get(rid: str | None) -> dict:
    """Preset for an id, falling back to the default (never raises)."""
    return RACK_TYPES.get(rid or DEFAULT, RACK_TYPES[DEFAULT])


def color(rid: str | None) -> str:
    return get(rid)["color"]


def catalog() -> list[dict]:
    """Ordered list of presets (with their id) for the UI / API."""
    return [{"id": k, **RACK_TYPES[k]} for k in ORDER]
