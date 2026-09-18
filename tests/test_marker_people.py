"""図面の人（立ち位置マーカー）と、壁ではない線（停止線・仕切り）。

MapMaker には「人」も「通れる線」も種別が無いので、作図者は 500 mm 角の作業台と
WallObject に名前を書いて表す（不変条件18）。`rmpm` はそれを読めていたのに、
:class:`WarehouseModel` に置き場が無かったので**保存の瞬間に消えていた**:

* 実案件の 22 人（検品者2＋梱包者20）の員数照合は、モデルが 0 人と言うので生図面を
  数え直す羽目になった。
* 動画は「人はここに立っている」をモデルの外側（見せるためだけの人）で注入していた。
* 仕切りは跡形も残らなかった（停止線だけがベルトの ``stop_gate`` として間接的に
  生き延びていた）。

ここで固定するのは4本: **置き場**（スキーマ）・**取込**（保存される）・**エンジン**
（描かれた立ち位置に人を立たせる）・**再生**（描かれた人を描く）。そして
**仕切りは壁ではない**（経路を1mmも変えない）。フィクスチャは全部合成。
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from whsim import kpis, rmpm
from whsim.engine.build import build, markers_of
from whsim.engine.run import run_once
from whsim.render import replay
from whsim.schema.model import (
    Bounds,
    Conveyor,
    Item,
    Location,
    Marker,
    NonBarrier,
    Station,
    Wall,
    WarehouseModel,
    WorkerGroup,
)
from whsim.web.app import app

client = TestClient(app)


def _doc(objects: list[dict], right: int = 60000, bottom: int = 40000) -> bytes:
    """A one-floor rmpm export (mm, top-left origin) holding `objects`."""
    return json.dumps({
        "unit": "mm",
        "floors": [{"name": "Floor",
                    "bounds": {"left": 0, "top": 0, "right": right, "bottom": bottom},
                    "objects": objects}],
    }).encode()


def _model(*, markers=(), non_barriers=(), walls=(), staging=0, conveyors=()):
    """A bare floor with two pick faces, one bench and (optionally) drawn people."""
    m = WarehouseModel()
    m.layout.bounds = Bounds(width=40.0, depth=20.0)
    m.layout.walls = list(walls)
    m.layout.non_barriers = list(non_barriers)
    m.locations = [Location(id="L0", x=4.0, y=2.0, sku="S0"),
                   Location(id="L1", x=8.0, y=2.0, sku="S1")]
    m.items = [Item(sku="S0", pick_freq=1.0, ts_per_unit=1.0, default_location="L0"),
               Item(sku="S1", pick_freq=1.0, ts_per_unit=1.0, default_location="L1")]
    m.resources.workers = [WorkerGroup(id="pickers", role="picker", count=2)]
    m.resources.stations = [Station(id="pack", x=20.0, y=10.0, count=2)]
    m.resources.conveyors = list(conveyors)
    m.resources.markers = list(markers)
    m.process.staging_capacity = staging
    m.orders.profile.rate_per_hr = 60.0
    m.simulation.duration_s = 600.0
    return m


# ==================================================== 1. 置き場（スキーマ）

def test_an_old_model_loads_unchanged_and_the_new_homes_default_to_empty():
    """追加は additive: 新しいキーを知らない model.json がそのまま読める。"""
    old = {"meta": {"name": "旧"}, "layout": {"bounds": {"width": 10.0, "depth": 5.0}},
           "resources": {"stations": [{"id": "pack", "x": 1.0, "y": 1.0}]}}
    m = WarehouseModel.model_validate(old)
    assert m.resources.markers == [] and m.layout.non_barriers == []
    # …そして既定のモデルに増えるのは空のリスト2本だけ（値は1つも変わらない）。
    base = WarehouseModel().model_dump()
    assert base["resources"]["markers"] == [] and base["layout"]["non_barriers"] == []


def test_the_marker_lives_with_the_people_and_the_non_barrier_beside_the_walls():
    """置き場そのものが意味: 人は resources、壁でない線は layout の walls の隣。

    ``Resources`` は「何が居るか/在るか」（人・設備・ベルト・作業台）で、立ち位置は
    その3本目＝**人の位置**。``Layout.non_barriers`` は ``walls`` の隣に在ることが
    「壁ではない」の宣言で、障害物を読む側（graph/navnet/rackgeom）は今までどおり
    ``walls`` だけを見る。
    """
    m = _model(markers=[Marker(id="mk1", name="検品者 立ち位置", role="inspector",
                               x=3.0, y=4.0)],
               non_barriers=[NonBarrier(id="nb1", name="仕切り", kind="partition",
                                        points=[[0.0, 6.0], [40.0, 6.0]])])
    assert [mk.role for mk in m.resources.markers] == ["inspector"]
    assert m.layout.walls == [], "仕切りは壁のリストに1本も足さない"
    assert m.layout.non_barriers[0].kind == "partition"
    # 丸ごと round-trip しても形は同じ（保存→読込で消えない）。
    again = WarehouseModel.model_validate(json.loads(m.model_dump_json()))
    assert again.resources.markers == m.resources.markers
    assert again.layout.non_barriers == m.layout.non_barriers


def test_a_partition_does_not_block_routing_but_the_same_line_as_a_wall_does():
    """仕切りは**通れる**。同じ矩形を壁として描いたときとの差でそれを測る。

    これが逆だと、図面に描いてある区画線の数だけ倉庫が分断され、ピッカーは遠回りを
    始める（しかも図面どおり取り込んだ結果として）。
    """
    span = [[0.0, 10.0], [30.0, 10.0]]
    a, b = (2.0, 2.0), (2.0, 18.0)          # 線を挟んだ2点
    plain = build(_model())
    parted = build(_model(non_barriers=[NonBarrier(id="nb1", kind="partition",
                                                   points=span)]))
    walled = build(_model(walls=[Wall(id="w1", points=span)]))
    assert parted.dist(a, b) == plain.dist(a, b), "仕切りは距離を1mmも変えない"
    assert walled.dist(a, b) > plain.dist(a, b), "壁なら迂回する（テストが効いている）"


# ==================================================== 2. 取込（保存される）

def test_the_import_saves_the_people_and_the_partition_into_the_model():
    """`/import-rmpm` は読んだ人と非障壁を**モデルに入れる**（数えて捨てない）。"""
    client.post("/api/projects", json={"name": "mkpeople", "template": "ecommerce_small"})
    try:
        data = _doc([
            {"type": "WallObject", "id": 1, "x": 0, "y": 0, "w": 60000, "h": 200},
            {"type": "WallObject", "id": 2, "x": 5000, "y": 15000, "w": 100, "h": 8000,
             "name": "仕切り"},
            {"type": "StationObject", "id": 3, "x": 8000, "y": 8000, "w": 500, "h": 500,
             "name": "検品者 立ち位置"},
            {"type": "StationObject", "id": 4, "x": 9000, "y": 8000, "w": 500, "h": 500,
             "name": "梱包者01 立ち位置"},
            {"type": "StationObject", "id": 5, "x": 10000, "y": 8000, "w": 500, "h": 500,
             "name": "梱包者02 立ち位置"},
        ])
        r = client.post("/api/projects/mkpeople/import-rmpm",
                        files={"file": ("x.rmpm.json", data, "application/json")})
        assert r.status_code == 200, r.text
        d = r.json()
        # 読めた件数と**モデルに入った件数**の両方を返す（後者は以前ずっと0だった）。
        assert d["markers"] == 3 and d["markers_in_model"] == 3
        assert d["non_barriers"] == 1 and d["non_barriers_in_model"] == 1
        assert d["walls"] == 1, "仕切りは壁に混ざらない"
        m = client.get("/api/projects/mkpeople/full").json()
        mk = m["resources"]["markers"]
        assert [x["role"] for x in mk] == ["inspector", "packer", "packer"]
        assert mk[0]["name"] == "検品者 立ち位置"
        assert mk[0]["x"] == 8.25 and mk[0]["y"] == 8.25     # 500mm 角の中心
        # 員数照合が図面を数え直さずに済む: モデルに人が居る。
        assert sum(1 for x in mk if x["role"] == "packer") == 2
        nb = m["layout"]["non_barriers"]
        assert [x["kind"] for x in nb] == ["partition"]
        assert len(m["layout"]["walls"]) == 1
    finally:
        client.delete("/api/projects/mkpeople")


def test_a_drawing_with_no_people_writes_no_keys_it_did_not_have():
    """規約語ゼロの図面は今までどおり（取込の結果に人も非障壁も現れない）。"""
    res = rmpm.import_rmpm_bytes(_doc([
        {"type": "FreeShelfObject", "id": 1, "x": 2000, "y": 2000,
         "w": 1150, "h": 2500, "name": "100-01-09"},
    ]))
    assert res["markers"] == [] and res["non_barriers"] == []


# ==================================================== 3. エンジン（人を立たせる）

def test_the_packer_stands_on_the_drawn_mark_instead_of_inside_the_bench():
    """描かれた立ち位置があれば、梱包者はそこに立つ（台の芯ではなく）。

    台は**物**で、人はその脇に立つ。500mm角のマーカーが描かれているのはまさにそれを
    言うためで、無視すると 3D の梱包ラインは人が台の中に埋まる。
    """
    mk = Marker(id="mk-p1", name="梱包者01 立ち位置", role="packer", x=21.0, y=11.5)
    m = _model(markers=[mk], staging=4)
    res = run_once(m, seed=5)
    assert res.packers, "仮置きモードでは専任の梱包者が立つ"
    pos = {(kf[1], kf[2]) for p in res.packers for kf in p.keyframes}
    assert pos == {(21.0, 11.5)}, "立ち位置マーカーの座標に立つ"
    assert res.staffed_markers == ["mk-p1"]

    # マーカーが無ければ従来どおり梱包台の位置（1バイトも変わらない）。
    plain = run_once(_model(staging=4), seed=5)
    assert {(kf[1], kf[2]) for p in plain.packers for kf in p.keyframes} == {(20.0, 10.0)}
    assert plain.staffed_markers == []
    assert [len(w.keyframes) for w in plain.workers] == \
        [len(w.keyframes) for w in res.workers], "人の位置だけ＝歩行は不変"
    assert [e["event"] for e in plain.events] == [e["event"] for e in res.events]


def test_the_inspector_stands_on_the_drawn_mark_instead_of_the_dock():
    mk = Marker(id="mk-i1", name="検品者 立ち位置", role="inspector", x=6.0, y=15.0)
    m = _model(markers=[mk])
    m.process.inspector_count = 1
    res = run_once(m, seed=5)
    assert res.inspectors
    assert {(kf[1], kf[2]) for i in res.inspectors for kf in i.keyframes} == {(6.0, 15.0)}
    assert res.staffed_markers == ["mk-i1"]


def test_the_picker_mark_is_a_documented_extension_point_not_a_silent_no_op():
    """``picker`` マーカーは**まだ**エンジンが使わない（歩く人の「立ち位置」は開始点の
    意味しかなく、``home`` に流し込むと距離が動く＝位置だけの変更ではなくなる）。

    使っていないことを固定しておく: 取り出し口 (:func:`markers_of`) は在って、
    エンジンの答えは変わらない。次に足す人はここに1行足すだけでよい。
    """
    mk = Marker(id="mk-k1", role="picker", x=1.0, y=1.0)
    m = _model(markers=[mk])
    assert [x.id for x in markers_of(m, "picker")] == ["mk-k1"]
    world = build(m)
    assert world.home == (20.0, 10.0), "ピッカーの原点は梱包台のまま"
    assert world.pack_marks == [] and world.inspect_xy == []


# ==================================================== 4. 再生（描かれた人を描く）

def test_the_replay_draws_a_person_on_every_mark_nobody_is_simulated_at():
    """描かれた人は ``workers[]`` に立ったまま出る（新しい配列を作らない）。

    人の描き方は replay 契約に既に1つある。2つ目を作ると同じ倉庫を2回描くことに
    なる（不変条件16）。
    """
    belt = Conveyor(id="T", points=[[10.0, 12.0], [30.0, 12.0]], speed_mps=0.5)
    marks = [Marker(id=f"mk{i}", name=f"梱包者{i:02d} 立ち位置", role="packer",
                    x=12.0 + i, y=13.0) for i in range(3)]
    m = _model(markers=marks, conveyors=[belt])
    res = run_once(m, seed=5)
    doc = replay.build_replay(m, res, kpis.compute([res], m))
    drawn = [w for w in doc["workers"] if w["id"].startswith("mk")]
    assert [w["id"] for w in drawn] == ["mk0", "mk1", "mk2"]
    for w, mk in zip(drawn, marks):
        assert w["role"] == "packer" and w["name"] == mk.name
        assert w["keyframes"] == [[0.0, mk.x, mk.y, "idle"]], "立っているだけの人"
        # 立ち止まる人は向きを変位から取れないので、脇のベルトの方を向かせる。
        assert w["face"] == [mk.x, 12.0]
    # 走らせる前の図面（レイアウト replay）にも同じ人が居る。
    assert [w["id"] for w in replay.build_layout_replay(m)["workers"]] == \
        ["mk0", "mk1", "mk2"]


def test_a_mark_an_agent_stands_at_is_not_drawn_twice():
    m = _model(markers=[Marker(id="mk-p1", role="packer", x=21.0, y=11.5)], staging=4)
    res = run_once(m, seed=5)
    doc = replay.build_replay(m, res, kpis.compute([res], m))
    assert res.staffed_markers == ["mk-p1"]
    assert not [w for w in doc["workers"] if w["id"] == "mk-p1"], \
        "本人が居るマーカーにもう1人描くと、同じ人を2回描くことになる"
    # 人数は今までどおり ``Station.count`` が決める（マーカーは位置であって員数では
    # ない）ので、立ち位置1つに梱包者2人なら 2人ともそこに立つ＝従来の
    # ``i % len(pack_xy)`` の規則のまま。
    assert [w["id"] for w in doc["workers"] if w["role"] == "packer"] == \
        ["packer-1", "packer-2"]


def test_a_model_with_no_marks_ships_the_replay_it_always_did():
    m = _model()
    res = run_once(m, seed=5)
    doc = replay.build_replay(m, res, kpis.compute([res], m))
    assert all(not w["id"].startswith("mk") for w in doc["workers"])
    assert replay.build_layout_replay(m)["workers"] == []
    assert all(set(w) == {"id", "role", "keyframes"} for w in doc["workers"])
