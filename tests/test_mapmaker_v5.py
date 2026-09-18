"""MapMaker カスタム版 v5.1β の新出力に対する取込 — 3D/KPI JSON・ロケマスタ・DXF・rmpm。

実サンプルが無い出力（3D/KPI JSON）は「意味ベースの別名表」で受ける設計なので、
テストは**同じ意味を別のキー名で書いた合成フィクスチャ**を2通り用意して、どちらも
同じレイアウトに落ちること（＝別名表が効いていること）と、当てられなかったキーが
probe に必ず出ることを固定する。数え方は v4.9 統一規約（段数=パレット段数、
逆ネスは 基数=段数−1、有効ロケ数=間口×段数）。
"""

from __future__ import annotations

import io
import json

import ezdxf
import pytest

from whsim import cad, locmaster, mapmaker_kpi
from whsim.schema.model import ShelfArea, WarehouseModel, Zone

# --------------------------------------------------------------------------- #
# フィクスチャ: 3D/KPI JSON（英語キー版 / 日本語キー版で同じ倉庫を書く）
# --------------------------------------------------------------------------- #
KPI_EN = {
    "meta": {"unit": "mm", "ceilingHeight": 5500, "palletW": 1100, "palletD": 1100},
    "shelves": [
        {"loc": "A-01-01", "x": 10000, "y": 5000, "w": 2200, "d": 1100,
         "height": 4200, "levels": 3, "faces": 2, "type": "ネステナー",
         "gearName": "ネス1100x1100 H1700", "pallets": 6, "zone": "常温"},
        {"loc": "A-01-02", "x": 13000, "y": 5000, "w": 1800, "d": 600,
         "height": 2400, "levels": 4, "faces": 1, "type": "中量棚",
         "gearName": "中量棚1800x600", "boardArea": 1.08, "zone": "常温"},
    ],
    "walls": [{"x": 0, "y": 0, "w": 40000, "d": 200, "height": 6000}],
    "stations": [{"name": "PACK1", "x": 2000, "y": 30000, "w": 2000, "d": 900}],
    "stairs": [{"x": 0, "y": 30000, "w": 2000, "d": 2000}],
    "conveyors": [{"name": "CV1", "points": [[5000, 20000], [25000, 20000]],
                   "speed": 0.8}],
}

KPI_JA = {
    "計算前提": {"単位": "mm", "天井有効高": 5500},
    "棚": [
        {"ロケ番号": "A-01-01", "座標X": 10000, "座標Y": 5000,
         "幅": 2200, "奥行": 1100, "概算全高": 4200, "段数": 3, "間口数": 2,
         "什器種別": "ネステナー", "什器名": "ネス1100x1100 H1700",
         "パレット収納力": 6, "ゾーン": "常温"},
        {"ロケ番号": "A-01-02", "座標X": 13000, "座標Y": 5000,
         "幅": 1800, "奥行": 600, "概算全高": 2400, "段数": 4, "間口数": 1,
         "什器種別": "中量棚", "什器名": "中量棚1800x600",
         "棚板面積": 1.08, "ゾーン": "常温"},
    ],
    "壁": [{"座標X": 0, "座標Y": 0, "幅": 40000, "奥行": 200, "高さ": 6000}],
    "検品場": [{"ロケ番号": "PACK1", "座標X": 2000, "座標Y": 30000,
                "幅": 2000, "奥行": 900}],
    "階段": [{"座標X": 0, "座標Y": 30000, "幅": 2000, "奥行": 2000}],
    "コンベア": [{"ロケ番号": "CV1", "ポイント": [[5000, 20000], [25000, 20000]],
                  "速度": 0.8}],
}


def _kpi(doc: dict) -> bytes:
    return json.dumps(doc, ensure_ascii=False).encode("utf-8")


# --------------------------------------------------------------------------- #
# 1. 3D/KPI JSON 取込
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("doc", [KPI_EN, KPI_JA], ids=["en", "ja"])
def test_kpi_import_same_layout_from_either_key_spelling(doc):
    """別名表が効いている＝キー名が違っても同じ倉庫になる。"""
    res = mapmaker_kpi.import_kpi_bytes(_kpi(doc))
    assert res["stats"]["units"] == "mm"
    assert res["stats"]["shelves"] == 2
    assert res["stats"]["walls"] == 1
    assert res["stats"]["stations"] == 1
    assert res["stats"]["conveyors"] == 1
    z = res["zones"][0]
    assert z["type"] == "storage"
    names = {s["name"] for s in z["shelves"]}
    assert names == {"A-01-01", "A-01-02"}
    nes = next(s for s in z["shelves"] if s["name"] == "A-01-01")
    assert nes["rack_type"] == "nestainer"          # 什器種別 → whsim rack_type
    assert abs(nes["w"] - 2.2) < 1e-6               # mm → m
    assert abs(nes["h"] - 1.1) < 1e-6
    # 原点は最小角へ平行移動（rmpm/mapcsv と同じ流儀）
    assert nes["x"] == 10.0 and nes["y"] == 5.0
    cv = res["conveyors"][0]
    assert cv["speed_mps"] == 0.8 and len(cv["points"]) == 2
    # 階段は現状の単一フロアモデルでは見送る（黙って消さず、警告で言う）
    assert any("階段" in w for w in res["warnings"])


def test_kpi_levels_and_faces_expand_like_the_location_master():
    """有効ロケ数 = 間口 × 段数（v4.9 統一規約）。"""
    res = mapmaker_kpi.import_kpi_bytes(_kpi(KPI_EN))
    locs = res["locations"]
    assert len(locs) == (2 * 3) + (1 * 4)           # A-01-01: 間口2×段3, A-01-02: 1×4
    a1 = [loc for loc in locs if loc["address"].startswith("A-01-01")]
    # 間口が複数なら棚名に 2 桁の間口番号が付く（ロケマスタ規約と同一）
    assert {loc["address"] for loc in a1} == {
        "A-01-01-01-01", "A-01-01-01-02", "A-01-01-01-03",
        "A-01-01-02-01", "A-01-01-02-02", "A-01-01-02-03"}
    assert sorted({loc["level"] for loc in a1}) == [1, 2, 3]
    # 間口が1つなら棚名そのまま
    a2 = [loc for loc in locs if loc["name"].startswith("A-01-02")]
    assert a2[0]["name"] == "A-01-02" and a2[0]["level"] == 1
    assert a2[1]["name"] == "A-01-02-2"
    # ゾーン列（棚グループ）がロケーションのゾーンへ
    assert {loc["zone"] for loc in locs} == {"常温"}
    # パレット収納力は有効ロケへ按分（合計が図面の数字と食い違わない）
    assert sum(loc["capacity"] for loc in a1) == 6


def test_kpi_reverse_nestainer_base_count_becomes_levels():
    """逆ネスは 基数=段数−1。基数しか無い出力からは 段数=基数+1 で復元する。"""
    doc = {"shelves": [{"loc": "N-01", "x": 0, "y": 0, "w": 1100, "d": 1100,
                        "ネス基数": 3, "type": "ネステナー"}]}
    res = mapmaker_kpi.import_kpi_bytes(_kpi(doc))
    assert len(res["locations"]) == 4               # 基数3 → 段数4


def test_kpi_probe_lists_every_unrecognised_key():
    """未認識キーは必ず probe に出る（MapMaker 作者が答え合わせできる形）。"""
    doc = json.loads(json.dumps(KPI_EN))
    doc["shelves"][0]["mystery_field"] = 42
    doc["shelves"][0]["another_one"] = "abc"
    res = mapmaker_kpi.import_kpi_bytes(_kpi(doc))
    keys = {u["key"] for u in res["probe"]["unknown"]}
    assert "mysteryfield" in keys and "anotherone" in keys
    assert any(u["sample"] == 42 for u in res["probe"]["unknown"])
    # 当たったキーも記録される（「loc を ロケ番号 と読んだ」が見える）
    assert res["probe"]["matched"]["name"] == "loc"
    assert res["probe"]["matched"]["levels"] == "levels"
    assert any("未認識" in w for w in res["warnings"])
    # probe 専用 API も同じものを返す
    p = mapmaker_kpi.probe_kpi_bytes(_kpi(doc))
    assert p["ok"] is True and "mysteryfield" in {u["key"] for u in p["unknown"]}


def test_kpi_tolerant_on_junk_and_unknown_shape():
    """読めないものは 0 件で返す。例外で止めない（never blocks）。"""
    res = mapmaker_kpi.import_kpi_bytes(b'{"nothing": 1}')
    assert res["stats"]["shelves"] == 0 and res["warnings"]
    res = mapmaker_kpi.import_kpi_bytes(b"[]")
    assert res["zones"] == []
    with pytest.raises(ValueError):
        mapmaker_kpi.import_kpi_bytes(b"{ broken json")
    # 座標だけ壊れている行は落として数を報告する
    doc = {"shelves": [{"loc": "OK", "x": 0, "y": 0, "w": 1000, "d": 1000},
                       {"loc": "NG", "w": 1000, "d": 1000}]}
    res = mapmaker_kpi.import_kpi_bytes(_kpi(doc))
    assert res["stats"]["shelves"] == 1 and res["stats"]["dropped"] == 1


def test_kpi_applies_to_model_round_trip():
    """取込 → モデル → ロケーション。数え方が図面と一致する。"""
    res = mapmaker_kpi.import_kpi_bytes(_kpi(KPI_EN))
    md = {"layout": {"bounds": res["bounds"], "zones": res["zones"],
                     "walls": res["walls"]},
          "resources": {"stations": res["stations"], "conveyors": res["conveyors"]}}
    model = WarehouseModel.model_validate(md)
    out = mapmaker_kpi.apply_to_model(model, res)
    assert out["locations"] == 10 == len(model.locations)
    assert len(model.resources.conveyors) == 1
    assert model.resources.conveyors[0].speed_mps == 0.8
    # ロケーションは自分の棚の footprint の中に居る
    sh = {s.name: s for z in model.layout.zones for s in z.shelves}
    for loc in model.locations:
        s = sh["-".join(loc.name.split("-")[:3])]   # 棚名 = ロケ名の先頭3節
        assert s.x - 1e-6 <= loc.x <= s.x + s.w + 1e-6
        assert s.y - 1e-6 <= loc.y <= s.y + s.h + 1e-6


# --------------------------------------------------------------------------- #
# 2. ロケーションマスタ CSV（MapMaker 出力列 + ゾーン列 + X/Y 直接配置）
# --------------------------------------------------------------------------- #
MM_CSV = (
    "エリア,列,棚,段,間口,フルロケ,X,Y,什器種別,什器名,面積,ゾーン\n"
    "AAA,00,02,01,01,AAA-00-02-01-01,1874,21631,中量棚,中量棚1800x600,1.08,常温\n"
    "AAA,00,02,02,01,AAA-00-02-02-01,1874,21631,中量棚,中量棚1800x600,1.08,常温\n"
    "AAA,00,02,01,02,AAA-00-02-01-02,1874,21631,中量棚,中量棚1800x600,1.08,常温\n"
    "AAA,00,02,02,02,AAA-00-02-02-02,1874,21631,中量棚,中量棚1800x600,1.08,常温\n"
    "BBB,21,07,01,01,BBB-21-07-01-01,9000,12000,ネステナー,ネス,1.21,冷蔵\n"
    "BBB,21,07,02,01,BBB-21-07-02-01,9000,12000,ネステナー,ネス,1.21,冷蔵\n"
).encode("utf-8")


def test_locmaster_recognises_the_mapmaker_column_set():
    res = locmaster.import_locmaster_bytes(MM_CSV, "loc.csv")
    used = res["stats"]["columns_used"]
    assert res["stats"]["mapmaker"] is True
    assert used["full"] == "フルロケ" and used["area"] == "エリア"
    assert used["x"] == "X" and used["y"] == "Y"
    # 面積・ゾーンが「エリア」に食われていない（部分一致の罠）
    assert used["m2"] == "面積" and used["zone"] == "ゾーン"
    assert used["gear"] == "什器種別" and used["gear_name"] == "什器名"
    by = {r["name"]: r for r in res["locations"]}
    assert by["AAA-00-02"]["levels"] == 2 and by["AAA-00-02"]["faces"] == 2
    assert by["AAA-00-02"]["zone"] == "常温"
    assert by["AAA-00-02"]["area_m2"] == 1.08
    assert by["BBB-21-07"]["rack_type"] == "nestainer"


def test_locmaster_direct_xy_placement_without_a_drawing():
    """図面が無くても、マスタの X/Y（mm）だけで床が引ける。"""
    res = locmaster.import_locmaster_bytes(MM_CSV, "loc.csv")
    lay = locmaster.build_layout(res["locations"])
    shelves = {s["name"]: s for s in lay["zones"][0]["shelves"]}
    assert set(shelves) == {"AAA-00-02", "BBB-21-07"}
    a = shelves["AAA-00-02"]
    # 面積 1.08 m² ÷ 中量棚の奥行 0.6 m = 1.8 m 幅、X/Y は棚の中心
    assert abs(a["w"] - 1.8) < 1e-3 and abs(a["h"] - 0.6) < 1e-6
    assert abs(a["x"] - (1.874 - 0.9)) < 1e-3
    assert abs(a["y"] - (21.631 - 0.3)) < 1e-3
    assert a["rack_type"] == "medium"
    # 左上基準に切り替えれば座標がそのまま出る
    tl = locmaster.build_layout(res["locations"], coord=locmaster.COORD_TOPLEFT)
    assert abs(tl["zones"][0]["shelves"][0]["x"] - 1.874) < 1e-3
    # 座標が無ければ「置けない」と言う（黙って原点に積まない）
    empty = locmaster.build_layout([{"name": "X", "levels": 1}])
    assert empty["zones"] == [] and empty["warnings"]


def test_locmaster_zone_column_reaches_the_locations():
    m = WarehouseModel()
    m.layout.zones = [Zone(id="storage", type="storage", w=40, h=30, shelves=[
        ShelfArea(id="s0", name="AAA-00-02", x=1.0, y=21.0, w=1.8, h=0.6),
        ShelfArea(id="s1", name="BBB-21-07", x=8.0, y=11.5, w=1.1, h=1.1)])]
    res = locmaster.import_locmaster_bytes(MM_CSV, "loc.csv")
    locmaster.apply_to_model(m, res["locations"])
    zones = {loc.name: loc.zone for loc in m.locations}
    assert zones["AAA-00-02"] == "常温" and zones["BBB-21-07"] == "冷蔵"


def test_locmaster_legacy_csv_without_zone_still_works():
    """ゾーン列の無い旧出力は従来どおり（既存列の位置は不変という約束）。"""
    legacy = b"\n".join(
        ln.rsplit(b",", 1)[0] for ln in MM_CSV.strip().split(b"\n")) + b"\n"
    res = locmaster.import_locmaster_bytes(legacy, "loc.csv")
    assert res["stats"]["columns_used"]["zone"] is None
    assert {r["zone"] for r in res["locations"]} == {""}
    assert res["stats"]["mapmaker"] is True


# --------------------------------------------------------------------------- #
# 3. DXF の CONVEYOR / SHELF / WALL レイヤ
# --------------------------------------------------------------------------- #
def _dxf_with_layers() -> bytes:
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4          # mm
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (40000, 0), (40000, 25000), (0, 25000)],
                       close=True, dxfattribs={"layer": "WALL"})
    msp.add_lwpolyline([(5000, 5000), (7200, 5000), (7200, 6100), (5000, 6100)],
                       close=True, dxfattribs={"layer": "SHELF"})
    msp.add_lwpolyline([(2000, 12000), (20000, 12000), (20000, 18000)],
                       dxfattribs={"layer": "CONVEYOR"})
    buf = io.StringIO()
    doc.write(buf)
    return buf.getvalue().encode("utf-8")


def test_dxf_conveyor_layer_becomes_conveyors_not_walls():
    res = cad.import_dxf_bytes(_dxf_with_layers())
    assert len(res["conveyors"]) == 1
    cv = res["conveyors"][0]
    assert cv["points"] == [[2.0, 12.0], [20.0, 12.0], [20.0, 18.0]]  # mm → m
    assert cv["speed_mps"] == 0.5                # DXF に速度は無い → 既定値
    # 二重計上しない: ベルトは壁にも棚にもならない（v4.10 の「コンベア(壁)」規約）
    assert res["stats"]["walls"] == 1
    for w in res["walls"]:
        assert [2.0, 12.0] not in w["points"]
    assert any("CONVEYOR" in w for w in res["warnings"])


def test_dxf_shelf_layer_becomes_shelves_not_walls():
    res = cad.import_dxf_bytes(_dxf_with_layers())
    storage = [z for z in res["zones"] if z["id"] == "storage"]
    assert len(storage) == 1
    sh = storage[0]["shelves"][0]
    assert abs(sh["w"] - 2.2) < 1e-3 and abs(sh["h"] - 1.1) < 1e-3
    assert res["stats"]["shelves"] == 1
    assert res["stats"]["walls"] == 1            # 外周のみ（棚もベルトも含まない）
    # モデルへ通る（棚 → ロケーション、ベルト → 搬送設備）
    model = WarehouseModel.model_validate({
        "layout": {"bounds": res["bounds"], "walls": res["walls"],
                   "zones": res["zones"]},
        "resources": {"conveyors": res["conveyors"]}})
    from whsim import design
    design.materialize_racks(model)
    assert model.locations and len(model.resources.conveyors) == 1


# --------------------------------------------------------------------------- #
# 4. rmpm — v4.4+ の末尾埋め込み（カスタムトレーラ）
# --------------------------------------------------------------------------- #
def _java_stream(payload: bytes = b"hi") -> bytes:
    """最小の正しい Java 直列化ストリーム（TC_STRING 1個）。"""
    import struct
    return b"\xac\xed\x00\x05" + b"\x74" + struct.pack(">H", len(payload)) + payload


def test_rmpm_custom_trailer_is_measured_not_shouted_about(caplog):
    """v4.4+ の末尾埋め込みは正常系。javaobj の警告を出さず、bytes 数だけ返す。"""
    from whsim import rmpm

    trailer = b"WHSIM-CUSTOM-TRAILER"
    with caplog.at_level("WARNING"):
        obj, n = rmpm._load_java(_java_stream() + trailer)
    assert obj == "hi"
    assert n == len(trailer)
    # 「Stream still has N bytes left」は破損に見えるが破損ではない → 出さない
    assert not [r for r in caplog.records if "bytes left" in r.getMessage()]
    # トレーラが無ければ 0
    assert rmpm._load_java(_java_stream())[1] == 0


def test_rmpm_trailer_is_reported_as_a_custom_extension(monkeypatch):
    """取込結果の警告文言が「拡張データ N bytes をスキップ」であること。"""
    from whsim import rmpm

    doc = {"source": "native-rmpm", "unit": "mm", "custom_trailer_bytes": 4096,
           "floors": [{"name": "1F", "bounds": {"left": 0, "top": 0,
                                                "right": 40000, "bottom": 25000},
                       "objects": [{"type": "FreeShelfObject", "id": 1,
                                    "x": 1000, "y": 1000, "w": 1800, "h": 600,
                                    "name": "A-01-01"}]}]}
    monkeypatch.setattr(rmpm, "_native_to_doc", lambda data: doc)
    res = rmpm.import_rmpm_bytes(b"\xac\xed\x00\x05rest")
    assert res["stats"]["custom_trailer_bytes"] == 4096
    hit = [w for w in res["warnings"] if "4096 bytes" in w]
    assert hit and "スキップ" in hit[0] and "v4.4+" in hit[0]
    assert not any("bytes left" in w for w in res["warnings"])


def test_rmpm_wall_height_is_carried_and_low_walls_are_flagged():
    """壁の height_mm は唯一の追加フィールド。低い壁は「コンベアかも」と言うだけ。"""
    from whsim import rmpm

    doc = {"floors": [{"name": "1F",
                       "bounds": {"left": 0, "top": 0, "right": 40000, "bottom": 25000},
                       "objects": [
                           {"type": "WallObject", "id": 1, "x": 0, "y": 0,
                            "w": 40000, "h": 200, "height_mm": 6000},
                           {"type": "WallObject", "id": 2, "x": 5000, "y": 10000,
                            "w": 20000, "h": 600, "height_mm": 750}]}]}
    res = rmpm.import_rmpm_bytes(json.dumps(doc).encode())
    assert [w.get("height_m") for w in res["walls"]] == [6.0, 0.75]
    assert res["stats"]["low_walls"] == 1
    # 断定しない: rmpm ではコンベア由来の壁を確定できない（壁クラスに名前が無い）
    note = [w for w in res["warnings"] if "1.2m 以下" in w]
    assert note and "CONVEYOR" in note[0]


def test_rmpm_corrupt_stream_still_fails_loudly():
    """トレーラを黙認しても、本当に壊れたストリームは友好的な例外で落とす。"""
    from whsim import rmpm

    with pytest.raises(ValueError):
        rmpm.import_rmpm_bytes(b"\xac\xed\x00\x05\xff\xff\xff\xff")


def test_dxf_without_special_layers_is_unchanged():
    """既存の図面は今までどおり全部が壁（後方互換）。"""
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4
    doc.modelspace().add_lwpolyline([(0, 0), (40000, 0), (40000, 25000), (0, 25000)],
                                    close=True)
    buf = io.StringIO()
    doc.write(buf)
    res = cad.import_dxf_bytes(buf.getvalue().encode("utf-8"))
    assert res["stats"]["walls"] == 1 and res["conveyors"] == []
    assert res["bounds"]["width"] == 40.0


# --------------------------------------------------------------------------- #
# 5. 配線 — API と CLI
# --------------------------------------------------------------------------- #
@pytest.fixture()
def client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    import whsim.project as project_mod
    from whsim.web.app import app
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    c = TestClient(app, raise_server_exceptions=False)
    c.post("/api/projects", json={"name": "kpi", "template": "ecommerce_small"})
    return c


def test_kpi_endpoint_writes_layout_and_locations(client):
    r = client.post("/api/projects/kpi/import-mapmaker-kpi",
                    files={"file": ("kpi.json", _kpi(KPI_EN), "application/json")})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["written"] is True and d["shelves"] == 2 and d["conveyors"] == 1
    assert d["locations"] == 10          # 間口×段数（MapMaker の数え方が正）
    assert d["probe"]["matched"]["levels"] == "levels"


def test_kpi_endpoint_probe_mode_writes_nothing(client):
    before = client.get("/api/projects/kpi/model").json()
    r = client.post("/api/projects/kpi/import-mapmaker-kpi?probe=true",
                    files={"file": ("kpi.json", _kpi(KPI_EN), "application/json")})
    assert r.status_code == 200 and r.json()["written"] is False
    assert r.json()["probe"]["matched"]["name"] == "loc"
    assert client.get("/api/projects/kpi/model").json() == before


def test_kpi_endpoint_is_tolerant_of_garbage(client):
    r = client.post("/api/projects/kpi/import-mapmaker-kpi",
                    files={"file": ("kpi.json", b"{ broken", "application/json")})
    assert r.status_code == 400          # 友好的な 400、500 にしない


def test_locmaster_endpoint_direct_place_without_a_layout(client):
    r = client.post("/api/projects/kpi/import-locmaster?place=direct",
                    files={"file": ("loc.csv", MM_CSV, "text/csv")})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["place"] == "direct" and d["shelves_placed"] == 2
    assert d["locations"] == 2 + 2       # AAA 2段 + BBB 2段


def test_cli_import_kpi_and_probe(tmp_path, monkeypatch, capsys):
    from typer.testing import CliRunner

    import whsim.project as project_mod
    from whsim.cli import app as cli_app
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    runner = CliRunner()
    assert runner.invoke(cli_app, ["new", "cli1"]).exit_code == 0
    p = tmp_path / "kpi.json"
    p.write_bytes(_kpi(KPI_EN))
    r = runner.invoke(cli_app, ["import-kpi", "cli1", str(p)])
    assert r.exit_code == 0, r.output
    assert "locations=10" in r.output
    r = runner.invoke(cli_app, ["probe-kpi", str(p)])
    assert r.exit_code == 0 and '"matched"' in r.output
    r = runner.invoke(cli_app, ["import-kpi", "cli1", str(tmp_path / "nope.json")])
    assert r.exit_code == 1                       # 生の traceback を出さない
