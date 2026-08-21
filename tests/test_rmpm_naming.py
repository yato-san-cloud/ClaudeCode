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


def test_a_direction_written_about_another_belt_is_not_obeyed():
    """注記は隣のベルトの流れを平気で書く。それを自分の向きとして読むと本線が
    逆走し、`points[0]`/`points[-1]` が入れ替わって連鎖の上下流ごと反転する。"""
    trunk = _imp([{"type": "StationObject", "id": 1, "x": 10000, "y": 20000,
                   "w": 30000, "h": 600,
                   "name": "本線コンベア(還流は西向き・本線は東向き)"}])["conveyors"][0]
    assert trunk["points"] == [[10.0, 20.3], [40.0, 20.3]], "東（＝作図順）のまま"
    ret = _imp([{"type": "StationObject", "id": 1, "x": 10000, "y": 20000,
                 "w": 30000, "h": 600,
                 "name": "還流コンベア(下段本線 西→東 の上を戻る)"}])["conveyors"][0]
    assert ret["points"] == [[10.0, 20.3], [40.0, 20.3]]
    # 「(本線は東向き)」だけを見て短辺方向の指定と誤認 → 嘘の警告も出さない
    spur = _imp([{"type": "StationObject", "id": 1, "x": 10000, "y": 5000,
                  "w": 600, "h": 20000, "name": "引き込みコンベア5(本線は東向き)"}])
    assert not any("長辺と直交" in w for w in spur["warnings"])
    # 一方、その節が向きそのものなら従来どおり効く
    west = _imp([{"type": "StationObject", "id": 1, "x": 10000, "y": 20000,
                  "w": 30000, "h": 600, "name": "検品コンベア(既設・西向き)"}])["conveyors"][0]
    assert west["points"] == [[40.0, 20.3], [10.0, 20.3]]


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


def test_a_note_about_the_trunks_deck_does_not_split_the_halves():
    """注記の高さは**隣のベルトの段**であることがある。それを自分の段として読むと
    結合キーの段部分がズレて、1本のベルトが本線で切れた2本のまま出てしまう。"""
    res = _imp([
        {"type": "StationObject", "id": 1, "x": 20000, "y": 5000, "w": 600, "h": 8000,
         "name": "引き込みコンベア3 北半(下段本線H900から分岐)"},
        {"type": "StationObject", "id": 2, "x": 20000, "y": 15000, "w": 600, "h": 8000,
         "name": "引き込みコンベア3 南半(既設)"},
    ])
    assert len(res["conveyors"]) == 1 and res["stats"]["merged_conveyors"] == 1
    assert res["conveyors"][0]["points"] == [[20.3, 5.0], [20.3, 23.0]]
    assert "elevation_m" not in res["conveyors"][0]     # 自分の段は書かれていない
    # 自分の段が注記に**単独で**書かれていれば、従来どおり読む
    solo = _imp([{"type": "StationObject", "id": 1, "x": 0, "y": 0, "w": 20000,
                  "h": 600, "name": "本線コンベア(床上900mm)"}])["conveyors"][0]
    assert solo["elevation_m"] == 0.9


def test_a_note_mentioning_the_other_half_does_not_make_a_belt_a_half():
    """「北半の引き込みと交差」は交差相手の名前。これで本線を「半分」に見なすと、
    45m 離れた無関係のベルトと1本の巨大な矩形に結合される。"""
    res = _imp([
        {"type": "StationObject", "id": 1, "x": 0, "y": 20000, "w": 40000, "h": 600,
         "name": "本線コンベア(北半の引き込みと交差)"},
        {"type": "StationObject", "id": 2, "x": 50000, "y": 5000, "w": 600, "h": 8000,
         "name": "本線コンベア 北半"},
    ])
    assert len(res["conveyors"]) == 2 and res["stats"]["merged_conveyors"] == 0
    assert res["conveyors"][0]["points"] == [[0.0, 20.3], [40.0, 20.3]]


# --- 6. 作業台: 実寸 (w/d) を保つ ---------------------------------------------

def test_packing_bench_keeps_its_real_footprint():
    res = _imp([{"type": "StationObject", "id": 1, "x": 30000, "y": 30000,
                 "w": 900, "h": 1400, "name": "梱包台01"}])
    (st,) = res["stations"]
    assert st["id"] == "梱包台01" and st["role"] == "pack"
    assert st["w"] == 0.9 and st["d"] == 1.4       # 長辺の向き = 作業者の立ち位置
    assert st["x"] == 30.45 and st["y"] == 30.7    # 中心は従来どおり
    assert res["conveyors"] == []


def test_one_drawn_bench_is_one_working_position():
    """スキーマ既定の count=3 のままだと、描かれた20台が60人分になる。"""
    res = _imp([
        {"type": "StationObject", "id": 1, "x": 30000, "y": 30000, "w": 900, "h": 1400,
         "name": "梱包台01"},
        {"type": "StationObject", "id": 2, "x": 32000, "y": 30000, "w": 900, "h": 1400,
         "name": "梱包台02"},
        # 名前で判定できなかった作業台は従来どおり（既定に任せる）
        {"type": "StationObject", "id": 3, "x": 1000, "y": 1000, "w": 20000, "h": 6500},
    ])
    named = [s for s in res["stations"] if s.get("role")]
    assert [s["count"] for s in named] == [1, 1]
    plain = [s for s in res["stations"] if not s.get("role")]
    assert plain and "count" not in plain[0]


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


# 名前は「修飾語＋その物」で書かれる ＝ **最後の名詞がその物**。表の並び順で勝たせると
# 先頭の修飾語が正体を乗っ取り、実図面の梱包台20台が 1.4m のベルト20本になった
# （しかも「搬送設備として取り込みました」と成功のように報告された）。
_LAST_NOUN_CASES = [
    ("引き込み3-梱包台07", ("station", "pack")),      # 梱包台であってベルトではない
    ("引込2 梱包台12", ("station", "pack")),
    ("検品者用検品台01", ("station", "inspect")),      # 台であって人ではない
    ("検品作業者テーブル", ("station", "bench")),
    ("梱包作業台01", ("station", "bench")),
    ("仕切り側 引き込みコンベア2", ("conveyor", "spur")),  # 仕切りではない・本線でもない
    ("排出部の仕切り", ("non_barrier", "partition")),
    ("本線コンベア用 停止位置マーカー", ("marker", "worker")),  # 停止線ではない
    ("梱包台01付近の立ち位置", ("marker", "worker")),
    ("投入口コンベア", ("conveyor", "belt")),
    ("ベルトコンベヤ 上段還流", ("conveyor", "return")),
    ("カーブ排出部", ("conveyor", "discharge")),
    ("バッファエリア", ("zone", "staging")),
    ("パレット置場", ("zone", "staging")),
    # 規約語を含むが対象外 → None ＝ 従来どおり type で分類（never blocks）
    ("カーブミラー", None),
    ("検品エリア", None),          # 「*エリア は積み付け」をやめた（検品場は作業場）
]


def test_the_last_noun_says_what_the_object_is():
    for name, want in _LAST_NOUN_CASES:
        assert rmpm.classify_name(name) == want, name


def test_a_bench_named_after_its_pull_in_is_a_bench():
    """実図面で 20 台の梱包台が 20 本の 1.4m ベルトになり、梱包能力が丸ごと消えた。"""
    res = _imp([{"type": "StationObject", "id": i, "x": 10000 + 1500 * i, "y": 20000,
                 "w": 900, "h": 1400, "name": f"引き込み{i // 4 + 1}-梱包台{i + 1:02d}"}
                for i in range(20)])
    assert res["conveyors"] == []
    assert len(res["stations"]) == 20
    assert {s["role"] for s in res["stations"]} == {"pack"}
    assert [s["count"] for s in res["stations"]] == [1] * 20


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


def test_a_head_that_says_nothing_is_a_code_not_its_neighbour():
    """**この期待値は反転させた**（以前は「頭が無言なら全文で拾う」を固定していた）。

    頭が無言の名前は、たいてい**そのものが番地**（`100-01-09` / `L-3` / `No.3`）で、
    括弧の中は隣にある別の設備の名前でしかない。全文にフォールバックすると
    「棚の名前が隣の設備の名前になる」＝実データで **描かれた棚5本が0本**になり、
    保管ゾーンごと消えた（警告はどれも成功のように読めた）。取りこぼす方が
    黙って壊すよりましなので、**種別は頭だけで決める**。"""
    res = _imp([{"type": "StationObject", "id": 1, "x": 1000, "y": 1000,
                 "w": 20000, "h": 600, "name": "L-3(本線コンベア)"},
                {"type": "WallObject", "id": 2, "x": 0, "y": 30000,
                 "w": 20000, "h": 200, "name": "W-12(停止線と平行)"}])
    assert res["conveyors"] == []
    assert [s["id"] for s in res["stations"]] == ["L-3(本線コンベア)"]
    # 躯体は躯体のまま（注記で壁が非障壁になると建屋に穴が開く）
    assert len(res["walls"]) == 1 and res["non_barriers"] == []


def test_a_drawn_shelf_is_never_reclassified_by_its_name():
    """棚は**形式が種別を記録している唯一の型**。名前（WMSの棚番地＋作図メモ）で
    上書きすると、図面の棚が丸ごとマーカー/区画線/ベルトに化けて在庫の置き場が
    消える。実データ相当（5本の棚に普通の注記）で 0 本になっていた。"""
    res = _imp([
        {"type": "FreeShelfObject", "id": 1, "x": 10000, "y": 10000,
         "w": 1150, "h": 2500, "name": "100-01-09(検品者側)"},
        {"type": "FreeShelfObject", "id": 2, "x": 12000, "y": 10000,
         "w": 1150, "h": 2500, "name": "100-01-10(停止線の手前)"},
        {"type": "FreeShelfObject", "id": 3, "x": 14000, "y": 10000,
         "w": 1150, "h": 2500, "name": "AAA-00-02（仕切り沿い）"},
        {"type": "FreeShelfObject", "id": 4, "x": 16000, "y": 10000,
         "w": 1150, "h": 2500, "name": "B-12-03(梱包エリア向かい)"},
        {"type": "FreeShelfObject", "id": 5, "x": 18000, "y": 10000,
         "w": 1150, "h": 2500, "name": "C-01-01(本線コンベア沿い)"},
        # 頭に規約語が入ってしまった棚も棚のまま（型が種別を言っている）
        {"type": "FreeShelfObject", "id": 6, "x": 20000, "y": 10000,
         "w": 1150, "h": 2500, "name": "積み付けエリア棚1"},
    ])
    shelves = [s for z in res["zones"] for s in z.get("shelves", [])]
    assert len(shelves) == 6, "描かれた棚は1本残らず棚のまま"
    assert any(z["id"] == "storage" for z in res["zones"])
    assert res["markers"] == [] and res["conveyors"] == [] and res["stations"] == []
    assert res["non_barriers"] == []
    assert [z["id"] for z in res["zones"]] == ["storage"]
    # 食い違いは黙らない（棚のままにしたことを言う）
    assert any("棚のまま" in w for w in res["warnings"])


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
    g = rmpm.resolve_stop_gates(res["conveyors"], res["non_barriers"])
    return g, res["conveyors"]


def test_stop_line_lands_on_the_belt_it_crosses():
    """位置は図面が言える。**止める荷が言えているかは別**（下の 荷の種別 の節）。"""
    g, cvs = _gate_of([
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 30000, "h": 600,
         "name": "本線コンベア(東向き)｜荷=検品済オリコン"},
        {"type": "WallObject", "id": 2, "x": 25000, "y": 18000, "w": 100, "h": 5000,
         "name": "停止線｜検品済オリコンは停止"},
    ])
    assert (g["positioned"], g["armed"]) == (1, 1)
    gate = cvs[0]["stop_gate"]
    assert gate["at_m"] == 15.05 and gate["stop_states"] == ["検品済オリコン"]
    assert "snapped_m" not in gate       # 実際に跨いでいる = スナップではない


def test_stop_line_just_past_the_belt_end_still_lands_on_it():
    """図面では線はベルト端の少し先に引かれる（実データは 0.3 m 先）。"""
    g, cvs = _gate_of([
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 24400, "h": 600,
         "name": "本線コンベア(東向き)"},
        {"type": "WallObject", "id": 2, "x": 34700, "y": 18000, "w": 100, "h": 5000,
         "name": "停止線"},
    ])
    assert g["positioned"] == 1
    gate = cvs[0]["stop_gate"]
    assert gate["at_m"] == 24.4 and 0 < gate["snapped_m"] < 1.5


def test_the_gate_goes_on_the_belt_whose_goods_arrive_at_the_line():
    """受け渡し点では3本が数cm内に居る。幾何的な最近傍ではなく、線に向かって
    流れている本線に付かないと「まだ来ていない荷」を止めることになる。"""
    g, cvs = _gate_of([
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
    assert g["positioned"] == 1
    gated = [c for c in cvs if c.get("stop_gate")]
    assert len(gated) == 1 and gated[0]["role"] == "main"


def test_a_stop_line_far_from_every_belt_is_left_alone():
    g, cvs = _gate_of([
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 30000, "h": 600,
         "name": "本線コンベア(東向き)"},
        {"type": "WallObject", "id": 2, "x": 5000, "y": 35000, "w": 4000, "h": 100,
         "name": "停止線"},
    ])
    assert g["positioned"] == 0 and not any(c.get("stop_gate") for c in cvs)


# --- 荷の種別 (load_kind): ゲートは「効いている」ときだけ効いていると言う ---------
# エンジンは荷が**最初に載ったベルト**の `load_kind` を荷に押し、下流のゲートがそれで
# 仕分ける。取込が `load_kind` を1件も書かなかった間、全ベルトは "" を押していたので
#   * 「Xは停止」と書かれたゲート → "" は X ではない ⇒ **何も止めない**
#   * 「Yは通過」だけ書かれたゲート → "" は Y ではない ⇒ **全部止める**
# のどちらかにしかならず、取込は両方とも「解決しました」と報告していた。

def test_a_belt_states_what_it_carries():
    res = _imp([{"type": "StationObject", "id": 1, "x": 0, "y": 20000,
                 "w": 30000, "h": 600, "name": "本線コンベア(東向き)｜荷=検品済オリコン"},
                {"type": "StationObject", "id": 2, "x": 0, "y": 25000,
                 "w": 30000, "h": 600, "name": "還流コンベア"}])
    assert res["conveyors"][0]["load_kind"] == "検品済オリコン"
    # 書いていないベルトはキーごと出さない = スキーマ既定 "" = 従来の1種類運用
    assert "load_kind" not in res["conveyors"][1]
    assert any("荷の種別" in w for w in res["warnings"])


def test_the_kind_a_gate_stops_is_inferred_onto_the_belts_that_feed_it():
    """止める荷が書かれていれば、そのゲートに着く荷は**その種別**である。

    どのベルトも種別を宣言していないとき、ゲートのベルトとその上流にその種別を
    押す（押さないと `""` は `stop_states` に当たらず、図面が描いている機構が
    一度も動かない）。推定であることは警告で言う。"""
    g, cvs = _gate_of([
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 30000, "h": 600,
         "name": "本線コンベア(東向き)"},
        {"type": "WallObject", "id": 2, "x": 25000, "y": 18000, "w": 100, "h": 5000,
         "name": "停止線｜検品済オリコンは停止・完成品はカーブへ通過"},
    ])
    assert (g["positioned"], g["armed"], g["pending"]) == (1, 1, 0)
    assert cvs[0]["load_kind"] == "検品済オリコン"
    gate = cvs[0]["stop_gate"]
    assert gate["at_m"] == 15.05 and gate["stop_states"] == ["検品済オリコン"]
    assert any("推定しました" in w for w in g["warnings"])


def test_the_inferred_kind_follows_the_belts_that_carry_loads_into_the_gate():
    """推定が及ぶのは**そのゲートへ荷を運ぶ**ベルトだけ: ゲートのベルトと、そこへ
    払い出す上流。還流（空容器を戻す脚）・引き込み（ゲートより下流で荷を抜く）・
    カーブ（先）は対象外 — 同じ平面座標を共有していても、運んでいる物が違う。"""
    g, cvs = _gate_of([
        {"type": "StationObject", "id": 1, "x": 2000, "y": 12000, "w": 8000, "h": 600,
         "name": "検品コンベア(東向き) 段=下段"},            # 本線へ払い出す上流
        {"type": "StationObject", "id": 2, "x": 10000, "y": 12000, "w": 30000, "h": 600,
         "name": "本線コンベア(東向き) 段=下段"},            # ゲートのベルト
        {"type": "StationObject", "id": 3, "x": 10000, "y": 12000, "w": 30000, "h": 600,
         "name": "還流コンベア(西向き) 段=上段"},            # 空容器の戻り
        {"type": "StationObject", "id": 4, "x": 20000, "y": 9000, "w": 600, "h": 7000,
         "name": "引き込みコンベア1"},                      # 本線から荷を抜く
        {"type": "WallObject", "id": 5, "x": 40200, "y": 10000, "w": 100, "h": 5000,
         "name": "停止線｜検品済オリコンは停止・完成品はカーブへ通過"},
    ])
    assert g["armed"] == 1
    kinds = {c["id"]: c.get("load_kind", "") for c in cvs}
    assert kinds["本線コンベア(東向き) 段=下段"] == "検品済オリコン"
    assert kinds["検品コンベア(東向き) 段=下段"] == "検品済オリコン"
    assert kinds["還流コンベア(西向き) 段=上段"] == ""
    assert kinds["引き込みコンベア1"] == ""
    # 逆に、ゲートが引き込みの側にあるなら、荷は本線を通ってそこへ来る ＝ 本線にも
    # 押さないと、乗り継いだ荷は種別を持たないままゲートを素通りする。
    g2, cvs2 = _gate_of([
        {"type": "StationObject", "id": 1, "x": 0, "y": 20000, "w": 40000, "h": 600,
         "name": "本線コンベア(東向き)"},
        {"type": "StationObject", "id": 2, "x": 20000, "y": 20000, "w": 600, "h": 10000,
         "name": "引き込みコンベア1"},
        {"type": "WallObject", "id": 3, "x": 19000, "y": 29500, "w": 3000, "h": 100,
         "name": "停止線｜検品済オリコンは停止"},
    ])
    assert g2["armed"] == 1
    assert {c["id"]: c.get("load_kind", "") for c in cvs2} == {
        "本線コンベア(東向き)": "検品済オリコン", "引き込みコンベア1": "検品済オリコン"}


def test_two_benches_drawn_with_the_same_name_stay_two_benches():
    """同名で描かれた梱包台は2台。IDが衝突すると**片方しか指せない**。

    他のコレクション（ベルト・マーカー・非障壁・ゾーン）は最初から `_uniq` で
    重複を解いていたのに作業台だけ素通しだった。`Station` が点だった頃は実害が
    薄かったが、いまは役割・実寸・人数を持つので、IDで引く側（シナリオ編集・
    エディタ・KPIの読み出し）が黙って先に見つけた方を触る。"""
    res = _imp([
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 900,
         "h": 1400, "name": "梱包台"},
        {"type": "StationObject", "id": 2, "x": 12000, "y": 20000, "w": 900,
         "h": 1400, "name": "梱包台"},
        {"type": "StationObject", "id": 3, "x": 14000, "y": 20000, "w": 900,
         "h": 1400, "name": "梱包台"},
    ])
    ids = [s["id"] for s in res["stations"]]
    assert len(ids) == len(set(ids)) == 3, ids
    assert ids[0] == "梱包台", "1台目は描かれた名前のまま（equipment_ref が指せる）"
    # ...and every one of them is still a real bench with its own footprint.
    assert all(s.get("count") == 1 and s.get("w") for s in res["stations"])


def test_the_importer_never_decides_discharge_both():
    """`Conveyor.discharge_both` は既定 False（片側払い出し）。図面は引き込みが
    駆動か無動力かを言わないのに、これを立てると能力が倍になる。取込は決めない。"""
    res = _imp([
        {"type": "StationObject", "id": 1, "x": 10000, "y": 12000, "w": 30000,
         "h": 600, "name": "本線コンベア(東向き)"},
        {"type": "StationObject", "id": 2, "x": 20000, "y": 9000, "w": 600,
         "h": 7000, "name": "引き込みコンベア1(本線を跨ぐ)"},
        {"type": "StationObject", "id": 3, "x": 25000, "y": 9000, "w": 600,
         "h": 7000, "name": "フリーコンベア2(無動力・両側から引く)"},
    ])
    assert all("discharge_both" not in c for c in res["conveyors"])


def test_a_gate_is_never_deleted_because_the_model_is_not_finished_yet():
    """取込は**モデルの途中経過**しか見られない（実運用は取込→荷の種別を設定→実行）。
    その場で効かないからとゲートを外すと、図面が言っている滞留が丸ごと消えて能力が
    倍に出る（実測 434→846 件/h）。効かない理由を言って、ゲートは残す。"""
    g, cvs = _gate_of([
        # 種別は宣言済みだが、停止線が名指しした荷ではない（推定は上書きしない）
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 30000, "h": 600,
         "name": "本線コンベア(東向き)｜荷=完成品"},
        {"type": "WallObject", "id": 2, "x": 25000, "y": 18000, "w": 100, "h": 5000,
         "name": "停止線｜検品済オリコンは停止"},
    ])
    assert (g["positioned"], g["armed"], g["pending"]) == (1, 0, 1)
    gate = cvs[0]["stop_gate"]
    assert gate["stop_states"] == ["検品済オリコン"], "図面の規則はそのまま残す"
    assert "inactive" not in gate
    assert any("まだありません" in w and "検品済オリコン" in w for w in g["warnings"])


def test_a_pass_only_gate_is_honoured_and_says_what_it_will_stop():
    """「完成品は通過」だけの図面は「完成品以外は止まる」と言っている。種別を
    宣言していないベルトの荷は止まる — それが図面の読みなので効かせ、意図と違えば
    分かるように警告する。"""
    g, cvs = _gate_of([
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 30000, "h": 600,
         "name": "本線コンベア(東向き)"},
        {"type": "WallObject", "id": 2, "x": 25000, "y": 18000, "w": 100, "h": 5000,
         "name": "停止線｜完成品はカーブへ通過"},
    ])
    assert (g["positioned"], g["armed"]) == (1, 1)
    assert cvs[0]["stop_gate"]["pass_states"] == ["完成品"]
    assert any("すべて" in w and "停止します" in w for w in g["warnings"])


def test_a_gate_arms_when_a_belt_states_the_kind_the_line_names():
    g, cvs = _gate_of([
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 30000, "h": 600,
         "name": "本線コンベア(東向き)｜荷=検品済オリコン"},
        {"type": "WallObject", "id": 2, "x": 25000, "y": 18000, "w": 100, "h": 5000,
         "name": "停止線｜検品済オリコンは停止・完成品はカーブへ通過"},
    ])
    assert (g["positioned"], g["armed"], g["kinds"]) == (1, 1, ["検品済オリコン"])
    gate = cvs[0]["stop_gate"]
    assert gate["stop_states"] == ["検品済オリコン"] and "inactive" not in gate
    # 通す荷だけの図面でも、止まりうる荷が居れば効く（＝図面どおり）
    g2, cvs2 = _gate_of([
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 30000, "h": 600,
         "name": "本線コンベア(東向き)｜荷=検品済オリコン"},
        {"type": "WallObject", "id": 2, "x": 25000, "y": 18000, "w": 100, "h": 5000,
         "name": "停止線｜完成品はカーブへ通過"},
    ])
    assert g2["armed"] == 1 and cvs2[0]["stop_gate"]["pass_states"] == ["完成品"]


def test_the_kind_a_stop_line_names_is_read_off_the_belts_own_name():
    """停止線が名指しした種別に限り、ベルト名（頭）からも読む＝閉じた語彙なので
    勝手な荷を作らない。注記は隣の設備の荷を書くので頭だけを見る。"""
    g, cvs = _gate_of([
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 30000, "h": 600,
         "name": "検品済オリコン本線コンベア(東向き)"},
        {"type": "WallObject", "id": 2, "x": 25000, "y": 18000, "w": 100, "h": 5000,
         "name": "停止線｜検品済オリコンは停止"},
    ])
    assert g["armed"] == 1 and cvs[0]["load_kind"] == "検品済オリコン"
    assert any("ベルト名から読み取り" in w for w in g["warnings"])


def test_a_kind_on_a_belt_fed_by_another_belt_says_what_it_can_do():
    """荷の種別は**最初に載ったベルト**が決め、受け渡しでは押し直されない。
    下流のベルトに書かれた種別を黙って受け取ると、効かない設定が図面の意図として
    保存される。"""
    g, _cvs = _gate_of([
        {"type": "StationObject", "id": 1, "x": 0, "y": 20000, "w": 40000, "h": 600,
         "name": "本線コンベア(東向き)｜荷=検品済オリコン"},
        # 本線の上から始まる引き込み ＝ 荷は本線から受け渡される
        {"type": "StationObject", "id": 2, "x": 20000, "y": 20000, "w": 600, "h": 10000,
         "name": "引き込みコンベア1｜荷=完成品"},
        {"type": "WallObject", "id": 3, "x": 35000, "y": 18000, "w": 100, "h": 5000,
         "name": "停止線｜検品済オリコンは停止"},
    ])
    assert any("最初に載ったベルト" in w and "引き込みコンベア1" in w
               for w in g["warnings"])


def test_two_stop_lines_on_one_belt_keep_the_upstream_one_and_say_so():
    """`Conveyor.stop_gate` は1本＝1つ。2本目で黙って上書きすると、報告された
    本数と実際のゲート数が食い違う（検品済を止める線が消えても誰も言わない）。"""
    g, cvs = _gate_of([
        {"type": "StationObject", "id": 1, "x": 0, "y": 20000, "w": 40000, "h": 600,
         "name": "本線コンベア(東向き)｜荷=検品済オリコン"},
        {"type": "WallObject", "id": 2, "x": 30000, "y": 18000, "w": 100, "h": 5000,
         "name": "停止線B｜完成品は停止"},
        {"type": "WallObject", "id": 3, "x": 15000, "y": 18000, "w": 100, "h": 5000,
         "name": "停止線A｜検品済オリコンは停止"},
    ])
    assert (g["positioned"], g["dropped"]) == (1, 1)
    gate = cvs[0]["stop_gate"]
    # 上流側（先に荷が着く方）を残す — 作図順ではない
    assert gate["source"] == "停止線A｜検品済オリコンは停止" and gate["at_m"] == 15.05
    assert any("停止線A" in w and "見送りました" in w for w in g["warnings"])


def test_a_tie_between_two_belts_breaks_by_id_not_by_drawing_order():
    """等距離のベルト2本は**ベルトID**で決める（`beltgeom.attach` と同じ規約）。
    作図順で決めると、同じ図面を並べ替えて保存し直すだけで答えが変わる。"""
    belts = [
        {"type": "StationObject", "id": 1, "x": 10000, "y": 20000, "w": 24400,
         "h": 600, "name": "AAAコンベア(東向き)"},
        {"type": "StationObject", "id": 2, "x": 10000, "y": 21400, "w": 24400,
         "h": 600, "name": "BBBコンベア(東向き)"},
    ]
    line = {"type": "WallObject", "id": 3, "x": 34700, "y": 20950, "w": 100,
            "h": 100, "name": "停止線"}
    got = []
    for objs in ([belts[0], belts[1], line], [belts[1], belts[0], line]):
        _g, cvs = _gate_of(objs)
        got.append({c["id"] for c in cvs if c.get("stop_gate")})
    assert got[0] == got[1] == {"AAAコンベア(東向き)"}


def _runnable(res, load_kind: str):
    """The imported drawing → a model the engine can actually run.

    Mirrors the real model-build script: it imports the drawing FIRST and assigns
    荷の種別 to the entry belt AFTERWARDS, which is exactly why the importer may
    not judge a gate by what the model looks like while it is still being built."""
    from whsim.schema.model import (
        Bounds, FlowEdge, Item, Location, OrderProfile, WarehouseModel, WorkerGroup,
    )
    md = WarehouseModel().model_dump()
    md["resources"]["conveyors"] = res["conveyors"]
    md["resources"]["stations"] = res["stations"]
    m = WarehouseModel.model_validate(md)
    m.resources.conveyors[0].load_kind = load_kind        # ← the LATER step
    m.layout.bounds = Bounds(width=60.0, depth=40.0)
    m.locations = [Location(id="L0", x=2.0, y=6.0, sku="S0")]
    m.items = [Item(sku="S0", pick_freq=1.0, ts_per_unit=1.0, default_location="L0")]
    m.resources.workers = [WorkerGroup(id="p", role="picker", count=2)]
    m.process.flow_edges = [FlowEdge(id="e", src="ピッキング", dst="検品",
                                     transport="conveyor", share=1.0,
                                     equipment_ref=m.resources.conveyors[0].id)]
    m.process.pack_time_s = 20.0
    m.orders.profile = OrderProfile(rate_per_hr=60.0, lines_per_order_mean=1.0)
    m.simulation.duration_s = 1200.0
    return m


def test_the_drawn_stop_line_actually_stops_loads_in_a_run():
    """図面→取込→（後から）荷の種別を設定→実行 で、**荷が止まる**ことまで見る。

    ゲートが payload に載っているだけでは足りない: 荷の種別が押されていなければ
    `stop_states` は一度も当たらず、機構は動かないのに取込は成功と報告できてしまう。
    種別が図面に書かれていない場合（推定が効く）と、別の種別が宣言されている場合
    （ゲートは残り、後の設定で効き始める）の両方を通す。"""
    from whsim.engine.run import run_once
    for belt_name in ("本線コンベア(東向き)",                    # 種別の記載なし
                      "本線コンベア(東向き)｜荷=完成品"):          # 別の種別が宣言済み
        res = rmpm.import_rmpm_bytes(_doc([
            {"type": "StationObject", "id": 1, "x": 0, "y": 12000, "w": 40000,
             "h": 600, "name": belt_name},
            {"type": "WallObject", "id": 2, "x": 30000, "y": 10000, "w": 100,
             "h": 5000, "name": "停止線(新設)｜検品済オリコンは停止・完成品は通過"},
            {"type": "StationObject", "id": 3, "x": 30000, "y": 14000, "w": 900,
             "h": 1400, "name": "梱包台01"},
        ]))
        rmpm.resolve_stop_gates(res["conveyors"], res["non_barriers"])
        gate = res["conveyors"][0]["stop_gate"]
        assert gate["stop_states"] == ["検品済オリコン"], belt_name
        r = run_once(_runnable(res, "検品済オリコン"), seed=5)
        stopped = [e for e in r.events if e["event"] == "conveyor_gate"]
        done = [e for e in r.events if e["event"] == "order_complete"]
        assert stopped, f"{belt_name}: 停止線が一度も荷を止めていない"
        assert done, f"{belt_name}: 止めたきり流れていない"


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
        # the bench survives the round trip with its real footprint AND its role
        st = [s for s in m["resources"]["stations"] if s["id"] == "梱包台01"]
        assert st and st[0]["w"] == 0.9 and st[0]["d"] == 1.4
        assert st[0]["role"] == "pack" and st[0]["count"] == 1
        assert any(z["id"] == "積み付けエリア" for z in m["layout"]["zones"])
    finally:
        client.delete("/api/projects/rmpmname")


def test_the_endpoint_reports_gates_that_work_separately_from_gates_it_placed():
    """取込の返す `stop_gates` は「いま効いているゲート」の数。効いていないものは
    別枠で数えて何が足りないかを言う — が、**ゲートは消さない**（荷の種別は取込の
    後で設定される）。"""
    client.post("/api/projects", json={"name": "rmpmgate", "template": "ecommerce_small"})
    try:
        def imp(belt_name):
            data = _doc([
                {"type": "StationObject", "id": 1, "x": 0, "y": 20000, "w": 40000,
                 "h": 600, "name": belt_name},
                {"type": "WallObject", "id": 2, "x": 30000, "y": 18000, "w": 100,
                 "h": 5000, "name": "停止線｜検品済オリコンは停止・完成品は通過"},
            ])
            r = client.post("/api/projects/rmpmgate/import-rmpm",
                            files={"file": ("x.rmpm.json", data, "application/json")})
            assert r.status_code == 200, r.text
            return r.json()

        # 種別の記載が無い図面 → 止める荷から推定して、その場で効くゲートになる
        d = imp("本線コンベア(東向き)")
        assert d["stop_gates"] == 1 and d["stop_gates_positioned"] == 1
        assert d["load_kinds"] == ["検品済オリコン"]
        # 別の種別が宣言済み → 推定せず、待ちとして報告し、規則はモデルに残す
        d = imp("本線コンベア(東向き)｜荷=完成品")
        assert d["stop_gates"] == 0 and d["stop_gates_pending"] == 1
        assert any("まだありません" in w for w in d["warnings"])
        m = client.get("/api/projects/rmpmgate/full").json()
        cv = m["resources"]["conveyors"][0]
        assert cv["load_kind"] == "完成品"
        assert cv["stop_gate"]["stop_states"] == ["検品済オリコン"]
    finally:
        client.delete("/api/projects/rmpmgate")


def test_a_stopper_that_stops_everything_is_a_mode_not_a_kind():
    """「全ての荷が停止」は荷種ではなくストッパーの無選択性の宣言。

    荷種として読むと幻の `load_kind="全ての荷"` が上流ベルトに押され、ゲートは
    **その偶然によってだけ**全停止になる（実荷種を書いたモデルでは黙って外れる）。
    普遍量化の主語と「物理ストッパー」は `{"mode": "all"}` に解決し、種別推定は
    走らない・armed 扱い（種別宣言を待たない）。"""
    g, cvs = _gate_of([
        {"type": "StationObject", "id": 1, "x": 0, "y": 20000, "w": 40000, "h": 600,
         "name": "本線コンベア(東向き)"},
        {"type": "StationObject", "id": 2, "x": 2000, "y": 12000, "w": 600, "h": 8000,
         "name": "検品コンベア西列"},
        {"type": "WallObject", "id": 3, "x": 35000, "y": 19000, "w": 100, "h": 2600,
         "name": "停止線(新設)｜物理ストッパー・全ての荷が停止"},
    ])
    trunk = next(c for c in cvs if "本線" in c["id"])
    assert trunk["stop_gate"].get("mode") == "all"
    assert "stop_states" not in trunk["stop_gate"]
    assert g["positioned"] == 1 and g["armed"] == 1 and g["pending"] == 0
    # no phantom kind stamped anywhere
    assert all(c.get("load_kind", "") != "全ての荷" for c in cvs)
    assert not any("全ての荷」を" in w and "推定" in w for w in g["warnings"])
    # a plain 「すべての荷は停止」 subject resolves the same way
    assert rmpm.stop_rule_from_name("停止線｜すべての荷は停止") == {"mode": "all"}
    assert rmpm.stop_rule_from_name("停止線｜検品済オリコンは停止") == \
        {"stop_states": ["検品済オリコン"]}
