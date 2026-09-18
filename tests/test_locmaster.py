"""ロケーションマスタ取込 — 図面の棚に実ロケを載せる。

この取込が無かった間、レイアウトを取り込んでも中身は空の家具だった。図面は
`AAA-00-02` がどこにあるかを知っていて、出荷履歴は `AAA-00-02-3-01` から
ピックしたことを知っていて、その2つが同じ場所だと知る者が居なかった。
"""
from __future__ import annotations

from whsim import locmaster
from whsim.schema.model import ShelfArea, WarehouseModel, Zone

CSV = (
    "エリア,列,棚,段,間口,フルロケ,X_mm,Y_mm,什器種別,什器名,footprint_m2\n"
    "AAA,00,02,01,01,AAA-00-02-01-01,1874,21631,中量棚,中量棚1800x600,0.43\n"
    "AAA,00,02,02,01,AAA-00-02-02-01,1874,21631,中量棚,中量棚1800x600,0.43\n"
    "AAA,00,02,03,01,AAA-00-02-03-01,1874,21631,中量棚,中量棚1800x600,0.43\n"
    "BBB,21,07,01,01,BBB-21-07-01-01,9000,12000,パレットラック,PR,1.2\n"
    "BBB,21,07,02,01,BBB-21-07-02-01,9000,12000,パレットラック,PR,1.2\n"
    "ZZZ,99,99,01,01,ZZZ-99-99-01-01,100,100,平置き,-,0\n"
).encode("utf-8")


def _model() -> WarehouseModel:
    m = WarehouseModel()
    m.layout.zones = [Zone(id="storage", type="storage", x=0, y=0, w=40, h=30, shelves=[
        ShelfArea(id="s0", name="AAA-00-02", x=1.0, y=21.0, w=1.6, h=0.3),
        ShelfArea(id="s1", name="BBB-21-07", x=8.0, y=11.5, w=1.1, h=1.1),
    ])]
    return m


def test_shelf_granularity_and_zero_padding():
    """段が1桁でもゼロ詰めでも同じ棚に落ちる。ここが合わないと1件も繋がらない。"""
    assert locmaster.normalize_loc("AAA-07-03-1-08") == "AAA-07-03"
    assert locmaster.normalize_loc("AAA-07-03-01-01") == "AAA-07-03"
    assert locmaster.normalize_loc("AAA-7-3") == "AAA-07-03"
    # 粒度を変えれば段まで残せる（間口までは残さないのが既定）
    assert locmaster.normalize_loc("AAA-07-03-1-08", parts=4) == "AAA-07-03-01"
    assert locmaster.normalize_loc("こわれた") is None


def test_import_groups_levels_and_maps_equipment():
    names = {"AAA-00-02", "BBB-21-07"}
    res = locmaster.import_locmaster_bytes(CSV, "loc.csv", shelf_names=names)
    by = {r["name"]: r for r in res["locations"]}
    assert by["AAA-00-02"]["levels"] == 3           # 段の異なり数が段数
    assert by["AAA-00-02"]["rack_type"] == "medium"  # 中量棚 → medium
    assert by["BBB-21-07"]["rack_type"] == "pallet"
    assert by["AAA-00-02"]["x"] == 1.874            # mm → m
    # 図面に無い棚は「置けない」と分かる形で残る（黙って消さない）
    assert by["ZZZ-99-99"]["in_layout"] is False
    assert res["stats"]["placed"] == 2


def test_apply_places_only_drawn_shelves_at_drawing_coordinates():
    m = _model()
    res = locmaster.import_locmaster_bytes(CSV, "loc.csv")
    out = locmaster.apply_to_model(m, res["locations"])
    # ZZZ は図面に無いので置かれない（存在しない場所に在庫を作らない）
    assert out["shelves_placed"] == 2
    assert out["locations"] == 3 + 2                # AAA 3段 + BBB 2段
    assert {loc.name for loc in m.locations} == {"AAA-00-02", "BBB-21-07"}
    aaa = [loc for loc in m.locations if loc.name == "AAA-00-02"]
    # 座標はマスタの X/Y ではなく**図面の棚の中心**。3D の棚は図面から生えるので、
    # マスタ座標を使うと在庫が自分の棚の脇に浮く。
    assert aaa[0].x == 1.0 + 1.6 / 2
    assert sorted(loc.level for loc in aaa) == [1, 2, 3]
    assert all(loc.address.startswith("AAA-00-02-") for loc in aaa)


def test_tolerant_on_junk_and_missing_columns():
    """壊れた表でも例外にしない（部分取込は正常系）。"""
    r = locmaster.import_locmaster_bytes(b"a,b,c\n1,2,3\n", "x.csv")
    assert r["locations"] == []
    assert r["warnings"] and "ロケーション" in r["warnings"][0]
    assert locmaster.import_locmaster_bytes(b"", "x.csv")["stats"]["rows"] == 0


def test_other_site_master_reports_zero_instead_of_guessing():
    """別サイトのマスタは0件一致と言う。無理に寄せない。"""
    res = locmaster.import_locmaster_bytes(CSV, "loc.csv", shelf_names={"DPA-01-18"})
    assert res["stats"]["placed"] == 0
    assert any("0/" in w or "0（" in w or "0%" in w for w in res["warnings"])
