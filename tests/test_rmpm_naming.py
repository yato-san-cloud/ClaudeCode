"""MapMaker 名前規約の解釈 (`whsim.rmpm`).

The format has no z axis and only three placeable kinds, so drawings write the
meaning into the object NAME (段=下段 / 停止線 / 立ち位置 / 引き込みコンベア …).
These tests pin that reading — and, crucially, pin that a drawing which uses NONE
of that vocabulary still imports exactly as it did before (never blocks).

All fixtures here are synthetic: a minimal hand-built rmpm.json, general vocabulary
only.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from whsim import rmpm
from whsim.web.app import app

client = TestClient(app)


def _doc(objects: list[dict], right: int = 60000, bottom: int = 40000) -> bytes:
    """A one-floor rmpm export (mm, top-left origin) holding `objects`."""
    return json.dumps({
        "unit": "mm",
        "axes": "x-right, y-down, origin top-left",
        "floors": [{"name": "Floor",
                    "bounds": {"left": 0, "top": 0, "right": right, "bottom": bottom},
                    "objects": objects}],
    }).encode()


def _imp(objects: list[dict]) -> dict:
    return rmpm.import_rmpm_bytes(_doc(objects))


# --- 1. 段 (2段駆動コンベア): same XY, two belts, separated by height ----------

def test_two_decks_at_the_same_xy_stay_two_belts():
    res = _imp([
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 30000, "h": 600,
         "name": "本線コンベア 段=下段(床上900mm)"},
        {"type": "StationObject", "id": 2, "x": 10000, "y": 20000, "w": 30000, "h": 600,
         "name": "本線コンベア 段=上段(床上1400mm)"},
    ])
    cv = res["conveyors"]
    assert len(cv) == 2, "同じ平面座標の上下段は別々のベルト（片方を捨てない）"
    assert [c["elevation_m"] for c in cv] == [0.9, 1.4]
    assert cv[0]["points"] == cv[1]["points"]     # same footprint, different deck
    assert res["stations"] == [] and res["walls"] == []
    assert {c["id"] for c in cv} == {"本線コンベア 段=下段(床上900mm)",
                                     "本線コンベア 段=上段(床上1400mm)"}


def test_tier_word_alone_falls_back_to_default_deck_heights():
    res = _imp([
        {"type": "StationObject", "id": 1, "x": 0, "y": 10000, "w": 30000, "h": 600,
         "name": "検品コンベア 段=下段"},
        {"type": "StationObject", "id": 2, "x": 0, "y": 10000, "w": 30000, "h": 600,
         "name": "還流コンベア 段=上段"},
    ])
    assert [c["elevation_m"] for c in res["conveyors"]] == [0.35, 0.95]


def test_belt_without_height_words_states_no_elevation():
    res = _imp([{"type": "StationObject", "id": 1, "x": 0, "y": 0, "w": 20000, "h": 600,
                 "name": "フリーコンベア"}])
    # None を書かず「キーごと出さない」= viewer は従来既定の高さで描く。
    assert "elevation_m" not in res["conveyors"][0]
    assert res["conveyors"][0]["role"] == "gravity"


# --- 2. 非障壁: 表示・区画は壁にしない ---------------------------------------

def test_display_lines_are_not_walls():
    res = _imp([
        {"type": "WallObject", "id": 1, "x": 0, "y": 0, "w": 40000, "h": 200},
        {"type": "WallObject", "id": 2, "x": 5000, "y": 10000, "w": 20000, "h": 100,
         "name": "停止線(新設)"},
        {"type": "WallObject", "id": 3, "x": 5000, "y": 15000, "w": 100, "h": 8000,
         "name": "仕切り"},
    ])
    assert len(res["walls"]) == 1, "本物の躯体だけが壁"
    assert res["walls"][0]["id"] == "w0"
    nb = res["non_barriers"]
    assert [n["name"] for n in nb] == ["停止線(新設)", "仕切り"]
    assert [n["kind"] for n in nb] == ["stop_line", "partition"]
    # 別枠でも図形は保つ（描けるし、経路は塞がない）
    assert nb[0]["points"] == [[5.0, 10.05], [25.0, 10.05]]
    assert nb[1]["thickness"] == 0.1
    assert any("障壁ではない" in w for w in res["warnings"])
    assert res["stats"]["non_barriers"] == 2


# --- 3. マーカー: 人の立ち位置は什器ではない ---------------------------------

def test_stand_position_marker_is_not_a_station():
    res = _imp([
        {"type": "StationObject", "id": 1, "x": 8000, "y": 8000, "w": 500, "h": 500,
         "name": "梱包作業者01 立ち位置(梱包台01)"},
        {"type": "StationObject", "id": 2, "x": 9000, "y": 8000, "w": 500, "h": 500,
         "name": "検品者 立ち位置"},
        {"type": "StationObject", "id": 3, "x": 10000, "y": 8000, "w": 500, "h": 500,
         "name": "立ち位置"},
    ])
    assert res["stations"] == []
    mk = res["markers"]
    assert [m["role"] for m in mk] == ["packer", "inspector", "worker"]
    assert mk[0]["x"] == 8.25 and mk[0]["y"] == 8.25     # 500mm 角の中心
    assert mk[0]["name"] == "梱包作業者01 立ち位置(梱包台01)"
    assert any("立ち位置" in w for w in res["warnings"])


# --- 4. コンベア: 矩形 → 進行方向つきポリライン -------------------------------

def test_main_belt_becomes_a_conveyor_running_east():
    res = _imp([{"type": "StationObject", "id": 1, "x": 10000, "y": 20000,
                 "w": 30000, "h": 600, "name": "本線コンベア 下段H900(既設・東向き)"}])
    assert res["stations"] == []
    (cv,) = res["conveyors"]
    assert cv["role"] == "main" and cv["elevation_m"] == 0.9
    p0, p1 = cv["points"]
    assert p1[0] > p0[0] and p0[1] == p1[1] == 20.3   # +x, 長辺の中心線
    assert cv["speed_mps"] == 0.5


def test_direction_word_flips_the_polyline():
    east = _imp([{"type": "StationObject", "id": 1, "x": 10000, "y": 20000,
                  "w": 30000, "h": 600, "name": "検品コンベア(東向き)"}])["conveyors"][0]
    west = _imp([{"type": "StationObject", "id": 1, "x": 10000, "y": 20000,
                  "w": 30000, "h": 600, "name": "検品コンベア(西向き)"}])["conveyors"][0]
    assert west["points"] == list(reversed(east["points"]))
    north = _imp([{"type": "StationObject", "id": 1, "x": 10000, "y": 5000,
                   "w": 600, "h": 20000, "name": "還流コンベア 南→北"}])["conveyors"][0]
    assert north["points"][0][1] > north["points"][1][1]   # 北 = -y（Y反転しない）


def test_direction_across_the_short_side_is_reported_not_obeyed():
    res = _imp([{"type": "StationObject", "id": 1, "x": 10000, "y": 5000,
                 "w": 600, "h": 20000, "name": "引き込みコンベア(東向き)"}])
    p0, p1 = res["conveyors"][0]["points"]
    assert p0[0] == p1[0] and p1[1] > p0[1]      # 幾何が勝つ（長辺のまま）
    assert any("長辺と直交" in w for w in res["warnings"])


# --- 5. 北半/南半: 本線を跨ぐ1本のベルト --------------------------------------

def test_north_and_south_halves_merge_into_one_belt():
    res = _imp([
        {"type": "StationObject", "id": 1, "x": 20000, "y": 5000, "w": 600, "h": 8000,
         "name": "引き込みコンベア3 北半"},
        {"type": "StationObject", "id": 2, "x": 20000, "y": 15000, "w": 600, "h": 8000,
         "name": "引き込みコンベア3 南半"},
    ])
    assert len(res["conveyors"]) == 1, "2矩形 → 1本"
    (cv,) = res["conveyors"]
    assert cv["id"] == "引き込みコンベア3" and cv["role"] == "spur"
    assert cv["points"] == [[20.3, 5.0], [20.3, 23.0]]   # 本線を跨いで連続
    assert res["stats"]["merged_conveyors"] == 1
    assert any("結合" in w for w in res["warnings"])


def test_different_numbers_do_not_merge():
    res = _imp([
        {"type": "StationObject", "id": 1, "x": 20000, "y": 5000, "w": 600, "h": 8000,
         "name": "引き込みコンベア3 北半"},
        {"type": "StationObject", "id": 2, "x": 30000, "y": 5000, "w": 600, "h": 8000,
         "name": "引き込みコンベア4 北半"},
    ])
    assert len(res["conveyors"]) == 2
    assert res["stats"]["merged_conveyors"] == 0


def test_halves_of_two_decks_merge_per_deck():
    res = _imp([
        {"type": "StationObject", "id": 1, "x": 20000, "y": 5000, "w": 600, "h": 8000,
         "name": "引き込みコンベア3 北半 段=下段"},
        {"type": "StationObject", "id": 2, "x": 20000, "y": 15000, "w": 600, "h": 8000,
         "name": "引き込みコンベア3 南半 段=下段"},
        {"type": "StationObject", "id": 3, "x": 20000, "y": 5000, "w": 600, "h": 8000,
         "name": "引き込みコンベア3 北半 段=上段"},
        {"type": "StationObject", "id": 4, "x": 20000, "y": 15000, "w": 600, "h": 8000,
         "name": "引き込みコンベア3 南半 段=上段"},
    ])
    assert len(res["conveyors"]) == 2, "段をまたいで結合してはいけない"
    assert [c["elevation_m"] for c in res["conveyors"]] == [0.35, 0.95]
    assert res["stats"]["merged_conveyors"] == 2


# --- 6. 作業台: 実寸 (w/d) を保つ ---------------------------------------------

def test_packing_bench_keeps_its_real_footprint():
    res = _imp([{"type": "StationObject", "id": 1, "x": 30000, "y": 30000,
                 "w": 900, "h": 1400, "name": "梱包台01"}])
    (st,) = res["stations"]
    assert st["id"] == "梱包台01" and st["role"] == "pack"
    assert st["w"] == 0.9 and st["d"] == 1.4       # 長辺の向き = 作業者の立ち位置
    assert st["x"] == 30.45 and st["y"] == 30.7    # 中心は従来どおり
    assert res["conveyors"] == []


def test_infeed_is_a_station_with_a_role():
    res = _imp([{"type": "StationObject", "id": 1, "x": 1000, "y": 1000,
                 "w": 1000, "h": 1000, "name": "投入口A"},
                {"type": "FreeShelfObject", "id": 2, "x": 40000, "y": 30000,
                 "w": 1150, "h": 2500, "name": "100-01-09"}])
    (st,) = res["stations"]
    assert st["role"] == "infeed" and st["id"] == "投入口A"


# --- 意味領域 → zone -----------------------------------------------------------

def test_named_areas_become_zones():
    res = _imp([{"type": "StationObject", "id": 1, "x": 0, "y": 0,
                 "w": 20000, "h": 10000, "name": "積み付けエリア"},
                {"type": "StationObject", "id": 2, "x": 30000, "y": 0,
                 "w": 10000, "h": 10000, "name": "出荷エリア"}])
    assert res["stations"] == []
    types = {z["id"]: z["type"] for z in res["zones"]}
    assert types == {"積み付けエリア": "staging", "出荷エリア": "shipping"}
    z = next(z for z in res["zones"] if z["id"] == "積み付けエリア")
    assert (z["x"], z["y"], z["w"], z["h"]) == (0.0, 0.0, 20.0, 10.0)


# --- 表そのもの ---------------------------------------------------------------

def test_classification_is_nfkc_folded_and_substring_based():
    assert rmpm.classify_name("ﾌﾘｰｺﾝﾍﾞｱ 3") == ("conveyor", "gravity")   # 半角カナ
    assert rmpm.classify_name("Ａ棚 停止線") == ("non_barrier", "stop_line")
    assert rmpm.classify_name("100-01-09") is None                       # 従来どおり
    assert rmpm.classify_name("") is None
    assert rmpm.classify_name(None) is None
    # 具体的な行が先に勝つ（立ち位置は「梱包台」を含んでいても作業台ではない）
    assert rmpm.classify_name("梱包作業者01 立ち位置(梱包台01)") == ("marker", "packer")
    assert rmpm.classify_name("梱包台01") == ("station", "pack")


# --- 7. 後方互換: 規約語ゼロの図面は従来と完全一致 -----------------------------

# The exact result the importer produced BEFORE the naming table existed
# (captured from the pre-change code on the fixture below).
_LEGACY_OBJECTS = [
    {"type": "FreeShelfObject", "id": 1, "x": 10000, "y": 10000,
     "w": 1150, "h": 2500, "name": "100-01-09"},
    {"type": "FreeShelfObject", "id": 2, "x": 12000, "y": 10000,
     "w": 1150, "h": 2500, "name": "100-01-10"},
    {"type": "WallObject", "id": 3, "x": 0, "y": 0, "w": 100000, "h": 300},
    {"type": "StationObject", "id": 4, "x": 5000, "y": 40000,
     "w": 2000, "h": 2000, "name": "PACK1"},
    {"type": "StairsObject", "id": 5, "x": 0, "y": 0, "w": 1000, "h": 1000},
    {"type": "FreeShelfObject", "id": 6, "x": 1000, "y": 1000,
     "w": 1000, "h": 1000, "name": "START"},
]
_LEGACY_RESULT = {
    "bounds": {"width": 100.0, "depth": 50.0},
    "zones": [{"id": "storage", "type": "storage", "x": 0.0, "y": 0.0,
               "w": 100.0, "h": 50.0, "rack": None,
               "shelves": [
                   {"id": "s0", "name": "100-01-09", "x": 10.0, "y": 10.0,
                    "w": 1.15, "h": 2.5, "rack_type": "medium", "facing": "left"},
                   {"id": "s1", "name": "100-01-10", "x": 12.0, "y": 10.0,
                    "w": 1.15, "h": 2.5, "rack_type": "medium", "facing": "left"}]}],
    "walls": [{"id": "w0", "points": [[0.0, 0.15], [100.0, 0.15]], "thickness": 0.3}],
    "stations": [{"id": "PACK1", "x": 6.0, "y": 41.0}],
    "warnings": ["START/END のピッキング基点マーカー 1 件は保管棚ではないため除外しました。",
                 "StairsObject を 1 件は現状の単一フロアモデルでは見送りました。",
                 "rmpm は最善努力で解釈しています。寸法/位置は設計タブでご確認ください。"],
    "stats": {"shelves": 2, "walls": 1, "stations": 1, "scale": 0.001, "units": "mm",
              "custom_trailer_bytes": 0, "low_walls": 0},
}


def test_drawing_without_the_vocabulary_is_unchanged():
    res = rmpm.import_rmpm_bytes(_doc(_LEGACY_OBJECTS, right=100000, bottom=50000))
    for key, want in _LEGACY_RESULT.items():
        if key == "stats":
            continue
        assert res[key] == want, key
    # stats keeps every legacy key at its legacy value (counts are additive).
    for key, want in _LEGACY_RESULT["stats"].items():
        assert res["stats"][key] == want, key
    # the additive buckets exist and are empty — a caller can rely on the shape
    assert res["conveyors"] == [] and res["markers"] == [] and res["non_barriers"] == []
    assert res["stats"]["merged_conveyors"] == 0


# --- 注記は「文脈」であって「正体」ではない -----------------------------------
# 実データで見つかった取り違え3件。名前は 「何であるか(どこに・どうする)」 と書かれ、
# 括弧の中は他の設備を平気で名指しする。全文一致だと人が区画線になり、シュートが
# 本線ベルトになる。だから頭（注記の手前）を先に見る。

def test_annotation_naming_another_object_does_not_hijack_the_kind():
    res = _imp([
        # 「仕切り付近」に立つ人。全文一致だと non_barrier に落ちて人が消える。
        {"type": "StationObject", "id": 1, "x": 8000, "y": 8000, "w": 500, "h": 500,
         "name": "検品者立ち位置マーカー(西・仕切り付近)"},
        # 「→下段本線」は行き先。全文一致だとシュートが本線コンベアになる。
        {"type": "StationObject", "id": 2, "x": 10000, "y": 20000, "w": 1500, "h": 600,
         "name": "投入口(検品済オリコン→下段本線)"},
    ])
    assert [m["role"] for m in res["markers"]] == ["inspector"]
    assert res["non_barriers"] == []
    assert [s["role"] for s in res["stations"]] == ["infeed"]
    assert res["conveyors"] == []


def test_head_loses_to_the_whole_name_only_when_the_head_says_nothing():
    """注記だけが語彙を持つ名前は、従来どおり全文で拾う（取りこぼさない）。"""
    res = _imp([{"type": "StationObject", "id": 1, "x": 1000, "y": 1000,
                 "w": 20000, "h": 600, "name": "L-3(本線コンベア)"}])
    assert [c["role"] for c in res["conveyors"]] == ["main"]


def test_halves_that_name_each_other_still_merge():
    """作図の申し送りは両半に「相方と一体」と書く。先に見つけた半語だけ消すと
    キーが揃わず、本線で切れた2本のまま出てしまう（実データで発生した）。"""
    res = _imp([
        {"type": "StationObject", "id": 1, "x": 20000, "y": 5000, "w": 600, "h": 8000,
         "name": "引き込みコンベア3 北半(既設)｜南半と一体・本線を跨ぐ1本"},
        {"type": "StationObject", "id": 2, "x": 20000, "y": 15000, "w": 600, "h": 8000,
         "name": "引き込みコンベア3 南半(既設)｜北半と一体・本線を跨ぐ1本"},
    ])
    assert len(res["conveyors"]) == 1
    (cv,) = res["conveyors"]
    assert cv["points"] == [[20.3, 5.0], [20.3, 23.0]]
    # 結合後の名前に「南半と一体」を残すと、object と名前が矛盾する
    assert cv["id"] == "引き込みコンベア3"


def test_curve_discharge_is_a_belt_not_a_bench():
    res = _imp([{"type": "StationObject", "id": 1, "x": 30000, "y": 20000,
                 "w": 2500, "h": 600, "name": "カーブ排出部(既設・曲がり部)"}])
    assert [c["role"] for c in res["conveyors"]] == ["discharge"]
    assert res["stations"] == []


# --- 停止線 → 選択停止ゲート ---------------------------------------------------

def test_stop_rule_is_read_out_of_the_drawn_name():
    r = rmpm.stop_rule_from_name("停止線(新設)｜検品済オリコンは停止・完成品はカーブへ通過")
    assert r == {"stop_states": ["検品済オリコン"], "pass_states": ["完成品"]}


def test_stop_line_without_a_rule_stops_nothing():
    assert rmpm.stop_rule_from_name("停止線(新設)") == {}


def _gate_of(objects):
    res = rmpm.import_rmpm_bytes(_doc(objects))
    n = rmpm.resolve_stop_gates(res["conveyors"], res["non_barriers"])
    return n, res["conveyors"]


def test_stop_line_lands_on_the_belt_it_crosses():
    n, cvs = _gate_of([
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 30000, "h": 600,
         "name": "本線コンベア(東向き)"},
        {"type": "WallObject", "id": 2, "x": 25000, "y": 18000, "w": 100, "h": 5000,
         "name": "停止線｜検品済オリコンは停止"},
    ])
    assert n == 1
    g = cvs[0]["stop_gate"]
    assert g["at_m"] == 15.05 and g["stop_states"] == ["検品済オリコン"]
    assert "snapped_m" not in g          # 実際に跨いでいる = スナップではない


def test_stop_line_just_past_the_belt_end_still_lands_on_it():
    """図面では線はベルト端の少し先に引かれる（実データは 0.3 m 先）。"""
    n, cvs = _gate_of([
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 24400, "h": 600,
         "name": "本線コンベア(東向き)"},
        {"type": "WallObject", "id": 2, "x": 34700, "y": 18000, "w": 100, "h": 5000,
         "name": "停止線"},
    ])
    assert n == 1
    g = cvs[0]["stop_gate"]
    assert g["at_m"] == 24.4 and 0 < g["snapped_m"] < 1.5


def test_the_gate_goes_on_the_belt_whose_goods_arrive_at_the_line():
    """受け渡し点では3本が数cm内に居る。幾何的な最近傍ではなく、線に向かって
    流れている本線に付かないと「まだ来ていない荷」を止めることになる。"""
    n, cvs = _gate_of([
        # 下段本線: 西→東、x=34.4 で終わる（線はこの先）
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 24400, "h": 600,
         "name": "本線コンベア(東向き) 段=下段"},
        # 上段還流: 東→西、同じ XY から戻っていく（線は背後）
        {"type": "StationObject", "id": 2, "x": 10000, "y": 20000, "w": 24400, "h": 600,
         "name": "還流コンベア(西向き) 段=上段"},
        # カーブ: 線のさらに先から始まる（線は背後）— 幾何的にはこれが最近傍
        {"type": "StationObject", "id": 3, "x": 34900, "y": 20000, "w": 3000, "h": 600,
         "name": "カーブ排出部"},
        {"type": "WallObject", "id": 4, "x": 34700, "y": 18000, "w": 100, "h": 5000,
         "name": "停止線"},
    ])
    assert n == 1
    gated = [c for c in cvs if c.get("stop_gate")]
    assert len(gated) == 1 and gated[0]["role"] == "main"


def test_a_stop_line_far_from_every_belt_is_left_alone():
    n, cvs = _gate_of([
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 30000, "h": 600,
         "name": "本線コンベア(東向き)"},
        {"type": "WallObject", "id": 2, "x": 5000, "y": 35000, "w": 4000, "h": 100,
         "name": "停止線"},
    ])
    assert n == 0 and not any(c.get("stop_gate") for c in cvs)


def test_empty_import_carries_the_same_additive_shape():
    res = rmpm.import_rmpm_bytes(json.dumps({"floors": [{"objects": []}]}).encode())
    assert res["conveyors"] == [] and res["markers"] == [] and res["non_barriers"] == []
    assert res["bounds"] is None and res["warnings"]


# --- never-blocks: the whole thing still goes through the import endpoint -----

def test_named_layout_imports_through_the_endpoint():
    client.post("/api/projects", json={"name": "rmpmname", "template": "ecommerce_small"})
    try:
        data = _doc([
            {"type": "FreeShelfObject", "id": 1, "x": 2000, "y": 2000,
             "w": 1150, "h": 2500, "name": "100-01-09"},
            {"type": "WallObject", "id": 2, "x": 0, "y": 0, "w": 60000, "h": 200},
            {"type": "WallObject", "id": 3, "x": 1000, "y": 9000, "w": 20000, "h": 100,
             "name": "停止線"},
            {"type": "StationObject", "id": 4, "x": 10000, "y": 20000, "w": 30000,
             "h": 600, "name": "本線コンベア 段=下段(床上900mm)"},
            {"type": "StationObject", "id": 5, "x": 30000, "y": 30000, "w": 900,
             "h": 1400, "name": "梱包台01"},
            {"type": "StationObject", "id": 6, "x": 8000, "y": 8000, "w": 500, "h": 500,
             "name": "検品者 立ち位置"},
            {"type": "StationObject", "id": 7, "x": 0, "y": 30000, "w": 10000,
             "h": 8000, "name": "積み付けエリア"},
        ])
        r = client.post("/api/projects/rmpmname/import-rmpm",
                        files={"file": ("x.rmpm.json", data, "application/json")})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["stats"]["conveyors"] == 1 and d["stats"]["markers"] == 1
        assert d["stats"]["non_barriers"] == 1
        assert d["walls"] == 1        # 停止線 is not one of them
        m = client.get("/api/projects/rmpmname/full").json()
        # the bench survives the round trip with its real footprint
        st = [s for s in m["resources"]["stations"] if s["id"] == "梱包台01"]
        assert st and st[0]["w"] == 0.9 and st[0]["d"] == 1.4
        assert any(z["id"] == "積み付けエリア" for z in m["layout"]["zones"])
    finally:
        client.delete("/api/projects/rmpmname")
