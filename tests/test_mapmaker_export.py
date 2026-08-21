"""MapMaker カスタム版 v5.1β への書出し・協調 — `whsim.mapmaker_export`。

取込（MapMaker → whsim）は既にある。ここで確かめるのは逆向き＝ whsim で設計・
試算したものを MapMaker の机の上に返す4本:

  1. 棚一覧CSV（「CSVから棚を一括生成」で開き直せる形か / m→mm / ロケ名 verbatim）
  2. シナリオ台帳 ledger.csv への追記（ヘッダ・列順・追記・never blocks）
  3. 動的系診断 MD/CSV（**計算前提が必ず併記される** / 一括診断の語彙と衝突しない）
  4. 棚別走行距離CSV との突き合わせ（幾何ゲート）

合成モデル＋合成CSVのみ。実顧客データは持ち込まない。
"""

from __future__ import annotations

import csv
import io

from whsim import mapmaker_export as mx
from whsim.schema.model import (
    Location,
    ShelfArea,
    Station,
    WarehouseModel,
    Zone,
)


def _model() -> WarehouseModel:
    """合成レイアウト: 40×30m、通路を挟んだ棚2本＋ネステナー1本、検品場は原点寄り。"""
    m = WarehouseModel()
    m.meta.name = "テスト倉庫"
    m.layout.bounds.width = 40.0
    m.layout.bounds.depth = 30.0
    m.layout.zones = [
        Zone(id="storage", type="storage", x=0, y=0, w=40, h=30, rack=None, shelves=[
            ShelfArea(id="s0", name="AAA-01-01", x=5.0, y=4.0, w=1.2, h=10.0,
                      rack_type="medium", facing="left"),
            ShelfArea(id="s1", name="AAA-02-01", x=12.0, y=4.0, w=1.2, h=10.0,
                      rack_type="medium", facing="right"),
            ShelfArea(id="s2", name="NES-01-01", x=20.0, y=4.0, w=1.1, h=4.4,
                      rack_type="nestainer", facing="left"),
        ]),
        Zone(id="packing", type="packing", x=0, y=25, w=10, h=5),
    ]
    m.resources.stations = [Station(id="pack", zone="packing", x=2.0, y=27.0, count=2)]
    m.locations = [
        Location(id="l0", name="AAA-01-01", address="AAA-01-01-01", zone="storage",
                 x=5.6, y=6.0, rack_type="medium"),
        Location(id="l1", name="AAA-02-01", address="AAA-02-01-01", zone="storage",
                 x=12.6, y=6.0, rack_type="medium"),
    ]
    return m


# --- 1. 棚一覧CSV ----------------------------------------------------------

def test_shelves_csv_is_mm_and_keeps_location_names():
    """MapMaker はネイティブ mm。whsim の m を ×1000 して渡し、棚名は一字も触らない。

    棚名は在庫・出荷履歴との join キー（docs/mapmaker-witness-integration.md §7）。
    丸めたり詰め直したりした瞬間に、図面と履歴が二度と繋がらなくなる。
    """
    rows = list(csv.DictReader(io.StringIO(mx.shelves_csv(_model()))))
    assert [r["棚名"] for r in rows] == ["AAA-01-01", "AAA-02-01", "NES-01-01"]
    r0 = rows[0]
    assert r0["X_mm"] == "5000" and r0["Y_mm"] == "4000"      # 5.0m → 5000mm
    assert r0["幅_mm"] == "1200" and r0["奥行_mm"] == "10000"
    # 座標は「左上＋幅奥行」と「左上右下」の両方で出す（取込側がどちらを読んでも
    # 通るように）。右下 = 左上 + サイズ で必ず整合する。
    assert int(r0["右_mm"]) == int(r0["左_mm"]) + int(r0["幅_mm"])
    assert int(r0["下_mm"]) == int(r0["上_mm"]) + int(r0["奥行_mm"])


def test_shelves_csv_maps_fixture_type_and_counts():
    """什器種別は MapMaker の語（中量棚/ネステナー）。段数・間口数も一緒に出す。"""
    rows = list(csv.DictReader(io.StringIO(mx.shelves_csv(_model()))))
    by = {r["棚名"]: r for r in rows}
    assert by["AAA-01-01"]["什器種別"] == "中量棚"
    assert by["NES-01-01"]["什器種別"] == "ネステナー"
    assert by["AAA-01-01"]["段数"] == "4"          # 中量棚プリセット levels
    # 長辺 10.0m ÷ 間口 1.2m ≒ 8 間口
    assert by["AAA-01-01"]["間口数"] == "8"


def test_shelves_csv_header_and_empty_model():
    """棚ゼロでもヘッダだけの CSV を返す（呼び出し側に空判定を強いない）。"""
    out = mx.shelves_csv(WarehouseModel())
    assert out.splitlines()[0] == ",".join(mx.SHELF_CSV_COLUMNS)
    assert len(out.splitlines()) == 1


def test_shelves_csv_skips_broken_shelf_never_raises():
    """座標が壊れた棚は数えて落とす。1枚の不正で書出し全体を止めない。"""
    m = _model()
    m.layout.zones[0].shelves[1].w = float("nan")
    rows = list(csv.DictReader(io.StringIO(mx.shelves_csv(m))))
    assert [r["棚名"] for r in rows] == ["AAA-01-01", "NES-01-01"]


def test_shelves_csv_origin_offset_restores_absolute_coords():
    """rmpm 取込は原点を最小角へ寄せる。元図面の絶対座標へ戻す口を持つ。"""
    rows = list(csv.DictReader(io.StringIO(
        mx.shelves_csv(_model(), origin_mm=(100000.0, 50000.0)))))
    assert rows[0]["X_mm"] == "105000" and rows[0]["Y_mm"] == "54000"


# --- 2. シナリオ台帳 -------------------------------------------------------

def test_ledger_row_has_the_manual_columns():
    """説明書の列: 日時・ファイル・フロア数・棚数・有効ロケ数・ネス基数・面積・操作種別。"""
    row = mx.ledger_row_from(_model(), mx.KIND_RUN, "run_2026.json")
    assert set(row) == set(mx.LEDGER_COLUMNS)
    assert row["操作種別"] == "whsim実行"
    assert row["フロア数"] == 1          # whsim は単一フロア
    assert row["棚数"] == 3
    assert row["有効ロケ数"] == 2
    assert row["面積"] == 1200.0         # 40 × 30
    # ネス基数 = ネステナー棚の 段数×間口数（4.4m ÷ 1.1m = 4間口 × 3段）
    assert row["ネス基数"] == 12


def test_ledger_append_creates_header_then_appends(tmp_path):
    """新規ならヘッダを書いてから追記。2回目はヘッダを重ねない。"""
    p = tmp_path / "台帳" / "ledger.csv"
    m = _model()
    assert mx.ledger_append(str(p), mx.ledger_row_from(m, mx.KIND_RUN, "a.json"))
    assert mx.ledger_append(str(p), mx.ledger_row_from(m, mx.KIND_EXPORT, "b.csv"))
    raw = p.read_bytes()
    # Excel でそのまま開ける＝BOM 付き UTF-8。BOM は先頭に1度だけ。
    assert raw.startswith(b"\xef\xbb\xbf")
    assert raw.count(b"\xef\xbb\xbf") == 1
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
    assert [r["操作種別"] for r in rows] == ["whsim実行", "whsim出力"]
    assert [r["ファイル"] for r in rows] == ["a.json", "b.csv"]


def test_ledger_append_follows_an_existing_foreign_header(tmp_path):
    """MapMaker 本体が作った台帳に混ぜても壊さない。既存の列順に合わせて書く。"""
    p = tmp_path / "ledger.csv"
    p.write_text("操作種別,日時,棚数,ファイル\n"
                 "棚一覧CSV,2026-08-01 10:00:00,3,layout.csv\n",
                 encoding="utf-8-sig", newline="")
    assert mx.ledger_append(str(p), mx.ledger_row_from(_model(), mx.KIND_EXPORT, "z.csv"))
    lines = p.read_text("utf-8-sig").splitlines()
    assert lines[0] == "操作種別,日時,棚数,ファイル"
    last = lines[-1].split(",")
    assert last[0] == "whsim出力" and last[2] == "3" and last[3] == "z.csv"


def test_ledger_append_never_blocks_on_unwritable_path(tmp_path):
    """書けなければ False を返すだけ。記録の失敗が本体の仕事を止めない。"""
    blocker = tmp_path / "not_a_dir"
    blocker.write_text("x", encoding="utf-8")
    assert mx.ledger_append(str(blocker / "sub" / "ledger.csv"),
                            mx.ledger_row_from(_model())) is False


def test_ledger_append_cp932_falls_back_on_unmappable_chars(tmp_path):
    """CP932 指定でも表現できない字で落ちない（台帳は必ず1行残る）。"""
    p = tmp_path / "ledger.csv"
    row = mx.ledger_row_from(_model(), "whsim出力", "レイアウト①🚚.csv")
    assert mx.ledger_append(str(p), row, encoding="cp932")
    text = p.read_text("cp932")
    assert "whsim出力" in text


# --- 3. 動的系診断 ---------------------------------------------------------

def test_diagnosis_md_always_states_its_assumptions():
    """MapMaker の流儀＝計算前提を必ず本文に併記。数字だけの独り歩きを止める。"""
    md = mx.diagnosis_md(_model())
    assert "## 計算前提" in md
    for key in ("歩行速度", "作業方法", "人員", "需要", "距離の測り方", "指標の出所"):
        assert key in md
    # 指標は必ず「動的系:」を冠する（一括診断の 収納力/キューブ利用率 と非衝突）
    assert "動的系:判定" in md and "動的系:歩行距離" in md
    # 静的指標（収納力・キューブ利用率…）を *指標として* 載せてはいけない。
    # 「本表には含まない、MapMaker の一括診断が正」と前提節で断るだけ。
    names = [r[1] for r in csv.reader(io.StringIO(mx.diagnosis_csv(_model())))
             if r and r[0] == "動的系"]
    assert not any(n in ("収納力", "キューブ利用率", "面積", "通路幅") for n in names)
    assert "MapMaker の一括診断が正" in md


def test_diagnosis_csv_carries_the_assumptions_in_the_same_sheet():
    """CSV でも前提は同じ表の中（別ファイルに分けると前提が置き去りになる）。"""
    rows = list(csv.reader(io.StringIO(mx.diagnosis_csv(_model()))))
    assert rows[0] == ["区分", "指標", "値", "単位"]
    kinds = {r[0] for r in rows[1:]}
    assert kinds == {"動的系", "計算前提"}
    names = [r[1] for r in rows[1:] if r[0] == "動的系"]
    assert names and all(n.startswith("動的系:") for n in names)
    assert any(r[1] == "距離の測り方" for r in rows[1:] if r[0] == "計算前提")


def test_diagnosis_includes_des_kpis_when_given():
    """DES を回してあれば (DES) 系の行が増える。無ければ解析だけで1枚出る。"""
    kpis = {"throughput_per_hr": 118.0, "completion_rate": 0.99,
            "picker_utilization": 0.62, "walk_per_order_m": 77.5,
            "cycle_mean_s": 410.0, "replications": 5, "verdict": "捌けます"}
    md = mx.diagnosis_md(_model(), kpis)
    assert "動的系:スループット(DES)" in md and "118.0" in md
    assert "試行回数" in md and "DES（kpis.compute）" in md
    assert "DES 未実行" in mx.diagnosis_md(_model())


# --- 4. 棚別走行距離CSV の突き合わせ（幾何ゲート） -------------------------

def _travel_csv(tmp_path, rows: list[tuple[str, float]], name="travel.csv"):
    """MapMaker の棚別走行距離CSV（説明書の列並び）を合成する。"""
    p = tmp_path / name
    buf = io.StringIO(newline="")
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(list(mx.TRAVEL_CSV_COLUMNS))
    for i, (loc, m_val) in enumerate(rows, 1):
        w.writerow(["1F", loc, 0, 0, round(m_val * 1000), round(m_val, 2),
                    i, "A", "経路"])
    p.write_bytes(buf.getvalue().encode("utf-8-sig"))
    return p


def _whsim_dist(model, loc_name: str) -> float:
    """比較の答え合わせ用に、モジュールと同じ距離計算を独立に引き直す。"""
    from whsim.engine.graph import AisleGraph
    g = AisleGraph.from_model(model)
    pts = mx._model_points(model)
    xy = pts[mx._fold(loc_name)]
    origin = (model.resources.stations[0].x, model.resources.stations[0].y)
    return g.distance(origin, xy) if g.enabled else 0.0


def test_travel_diff_matches_per_location_and_passes_the_gate(tmp_path):
    """幾何が合っていれば乖離は小さく、ゲートは通る（DES を回してよい）。"""
    m = _model()
    rows = [(n, _whsim_dist(m, n) + d)
            for n, d in (("AAA-01-01", 0.4), ("AAA-02-01", -0.3), ("NES-01-01", 0.9))]
    res = mx.travel_diff(m, str(_travel_csv(tmp_path, rows)))
    assert res["matched"] == 3 and res["unmatched"] == 0
    assert res["distance_source"] == "graph"
    assert res["max_abs_diff_m"] <= 1.0
    assert res["ok"] is True
    assert res["top"][0]["loc"] == "NES-01-01"        # 乖離上位は降順
    assert {"loc", "mapmaker_m", "whsim_m", "diff_m", "rel_pct"} == set(res["top"][0])


def test_travel_diff_fails_the_gate_when_geometry_disagrees(tmp_path):
    """幾何が食い違うなら ok=False。ここで止めないと DES の数字が全部嘘になる。"""
    m = _model()
    rows = [(n, _whsim_dist(m, n) + off)
            for n, off in (("AAA-01-01", 40.0), ("AAA-02-01", 35.0), ("NES-01-01", 0.2))]
    res = mx.travel_diff(m, str(_travel_csv(tmp_path, rows)), tol_m=5.0)
    assert res["ok"] is False
    assert res["within_tol"] == 1 and res["matched"] == 3
    assert res["max_abs_diff_m"] >= 35.0
    assert any("幾何が一致していません" in w for w in res["warnings"])


def test_travel_diff_counts_unmatched_and_broken_rows(tmp_path):
    """読めない行・図面に無いロケは *数えて落とす*。例外にはしない。"""
    m = _model()
    p = tmp_path / "travel.csv"
    p.write_text(
        "フロア,ロケ,X_mm,Y_mm,走行距離_mm,走行距離_m,近い順位,ゾーン,距離種別\r\n"
        f"1F,AAA-01-01,0,0,0,{_whsim_dist(m, 'AAA-01-01'):.2f},1,A,経路\r\n"
        "1F,ZZZ-99-99,0,0,0,12.3,2,C,経路\r\n"          # 図面に無い
        "1F,AAA-02-01,0,0,,,3,B,経路\r\n"                # 距離が空
        "1F,,0,0,0,5.0,4,C,経路\r\n",                    # ロケが空
        encoding="utf-8-sig", newline="")
    res = mx.travel_diff(m, str(p))
    assert res["matched"] == 1
    assert res["unmatched"] == 1
    assert res["skipped_rows"] == 2
    assert res["csv_rows"] == 4


def test_travel_diff_joins_at_shelf_granularity(tmp_path):
    """MapMaker が段・間口まで書いても、棚粒度（locmaster.normalize_loc）で落ちる。"""
    m = _model()
    d = _whsim_dist(m, "AAA-01-01")
    res = mx.travel_diff(m, str(_travel_csv(tmp_path, [("AAA-01-01-3-08", d + 0.2)])))
    assert res["matched"] == 1
    assert res["top"][0]["loc"] == "AAA-01-01-3-08"


def test_travel_diff_never_raises_on_bad_input(tmp_path):
    """存在しないファイル・空ファイル・列違いの CSV — どれも警告を返して終わる。"""
    m = _model()
    missing = mx.travel_diff(m, str(tmp_path / "nope.csv"))
    assert missing["matched"] == 0 and missing["warnings"]

    empty = tmp_path / "empty.csv"
    empty.write_text("", encoding="utf-8")
    assert mx.travel_diff(m, str(empty))["warnings"]

    wrong = tmp_path / "wrong.csv"
    wrong.write_text("a,b,c\n1,2,3\n", encoding="utf-8")
    res = mx.travel_diff(m, str(wrong))
    assert res["matched"] == 0
    assert any("走行距離" in w for w in res["warnings"])


def test_travel_diff_reads_cp932_and_mm_only_csv(tmp_path):
    """CP932 で書かれていても、走行距離_m 列が無く mm 列だけでも読む。"""
    m = _model()
    d = _whsim_dist(m, "AAA-01-01")
    p = tmp_path / "sjis.csv"
    p.write_bytes(("フロア,ロケ,X_mm,Y_mm,走行距離_mm,近い順位,ゾーン,距離種別\r\n"
                   f"1F,AAA-01-01,0,0,{round(d * 1000)},1,A,経路\r\n"
                   ).encode("cp932"))
    res = mx.travel_diff(m, str(p))
    assert res["matched"] == 1
    assert res["max_abs_diff_m"] < 0.01
