"""提案書の用語ガード (whsim.wording) と 時間帯波形からの需要生成 (analysis.demandshape)。

2つとも「出す前の事故」を潰す層なので、逐条で固定する:

  * 用語ガード — 禁止語を機械的に見つけ、**固有名詞は通す**（「停止」が禁止でも
    設備名「停止線」は書き換えない）。ルール未設定なら検査そのものが無効＝既存の
    出力は1バイトも変わらない。
  * 波形 — 時間帯別の件数表しか無い現場でも、その**形のまま**到着系列を組んで
    DES に渡せる（一様投入の臨界点ではなく、実際の波形の臨界点が出る）。

テスト語彙はすべて合成（実在の案件・顧客・禁止語リストは持ち込まない）。
"""

import json

import pytest
from fastapi.testclient import TestClient

from whsim import wording
from whsim.analysis import demandshape as ds
from whsim.project import Project
from whsim.schema.model import WarehouseModel
from whsim.web.app import app

# 合成のトーンガイド: 「停止」を禁止しつつ、設備名「停止線」だけは通す。
RULES = {
    "forbidden": ["停止", "検品レス", "検品"],
    "replacements": {"検品レス": "検品の集約"},
    "allow": ["停止線"],
}


# ── 用語ガード ────────────────────────────────────────────────────────────
def test_no_rules_means_no_check_at_all():
    """ルール未設定＝検査は完全に無効（既存挙動不変）。"""
    text = "停止と検品レスを削減して目標のROIを達成します。"
    assert wording.enabled({}) is False
    assert wording.check(text, {}) == []
    assert wording.check(text, None) == []
    assert wording.apply(text, {}) == (text, [])
    assert wording.lint_export({"title": text}, {}) == []
    # allow だけのルールは何も検出しない（＝規制ではない）。
    assert wording.enabled({"allow": ["停止線"]}) is False


def test_settings_wording_defaults_to_empty():
    """スキーマ追加は additive: 既定モデルは用語ガードを持たない。"""
    m = WarehouseModel()
    assert m.settings.wording == {}
    assert wording.rules_for(m) == {}
    assert wording.check("停止", wording.rules_for(m)) == []


def test_forbidden_terms_report_span_and_line():
    text = "1行目は無害。\nここで検品を行う。"
    hits = wording.check(text, {"forbidden": ["検品"]})
    assert len(hits) == 1
    h = hits[0]
    assert h["term"] == "検品"
    assert h["line"] == 2
    a, b = h["span"]
    assert text[a:b] == "検品"          # span は元テキストのオフセット
    assert h["suggestion"] == ""        # 言い換え候補が無ければ空


def test_allow_phrase_wins_over_forbidden_substring():
    """物理オブジェクトの正式名称は禁止語を部分文字列で含んでも通す。"""
    text = "停止線の手前で台車が停止する。"
    hits = wording.check(text, RULES)
    terms = [h["term"] for h in hits]
    assert terms == ["停止"]                       # 「停止線」の中の停止は数えない
    a, _ = hits[0]["span"]
    assert a > text.index("停止線")                # 後ろの単独「停止」だけ
    # allow が無ければ2件見つかる（allow が効いていることの対比）。
    assert len(wording.check(text, {"forbidden": ["停止"]})) == 2


def test_longest_match_wins_and_hits_do_not_overlap():
    hits = wording.check("検品レスにします。", RULES)
    assert [h["term"] for h in hits] == ["検品レス"]     # 「検品」は飲み込まれる
    assert hits[0]["suggestion"] == "検品の集約"


def test_apply_replaces_only_known_terms_and_never_touches_allow():
    text = "停止線の運用を維持しつつ、検品レスを検討する。"
    fixed, changes = wording.apply(text, RULES)
    assert fixed == "停止線の運用を維持しつつ、検品の集約を検討する。"
    assert [c["term"] for c in changes] == ["検品レス"]
    assert changes[0]["to"] == "検品の集約"
    assert "停止線" in fixed                        # 固有名詞は無傷
    # 言い換え候補の無い禁止語は人が直すために残る（勝手に消さない）。
    left, _ = wording.apply("ここで停止する。", RULES)
    assert left == "ここで停止する。"


def test_replacement_keys_are_themselves_detected():
    """言い換え辞書のキーは禁止語（そうでないと apply が check に無い書換をする）。"""
    hits = wording.check("検品レスの導入", {"replacements": {"検品レス": "検品の集約"}})
    assert [h["term"] for h in hits] == ["検品レス"]


def test_matching_folds_width_and_case():
    rules = {"forbidden": ["Xtra"]}
    assert wording.check("ＸＴＲＡ を使う", rules)[0]["term"] == "ＸＴＲＡ"
    assert wording.check("xtra を使う", rules)[0]["span"] == [0, 4]


def test_regex_rule_and_a_broken_regex_never_blocks():
    rules = {"forbidden_regex": r"\d+%削減"}
    hits = wording.check("当社比で30%削減できます。", rules)
    assert len(hits) == 1 and hits[0]["term"] == "30%削減" and hits[0]["rule"] == "regex"
    # 壊れた正規表現でも 例外にせず、他のルールは動き続ける。
    broken = {"forbidden_regex": "([", "forbidden": ["停止"]}
    assert [h["term"] for h in wording.check("停止します", broken)] == ["停止"]
    # allow は正規表現ヒットにも効く。
    assert wording.check("30%削減", {"forbidden_regex": r"\d+%削減",
                                     "allow": ["30%削減"]}) == []


def test_load_rules_ignores_unknown_keys(tmp_path):
    guide = {"forbidden": ["停止"], "allow": ["停止線"],
             "replacements": {"停止": "一時停止"}, "forbidden_regex": "",
             "author": "誰か", "version": 3, "notes": ["未知キーは無視"]}
    p = tmp_path / "guide.json"
    p.write_text(json.dumps(guide, ensure_ascii=False), "utf-8")
    rules = wording.load_rules(p)
    assert set(rules) == {"forbidden", "allow", "replacements"}   # 未知キーは落ちる
    assert wording.load_rules(guide) == rules                     # dict でも同じ
    assert wording.load_rules(json.dumps(guide).encode()) == rules  # bytes でも同じ
    # 壊れた JSON / 無いファイルは友好的な ValueError（500 にしない側で使う）。
    bad = tmp_path / "bad.json"
    bad.write_text("{ not json", "utf-8")
    with pytest.raises(ValueError):
        wording.load_rules(bad)
    with pytest.raises(ValueError):
        wording.load_rules(tmp_path / "missing.json")
    # 形が違う値は寛容に捨てる（never blocks）。
    assert wording.load_rules({"forbidden": "停止", "replacements": 5}) == {"forbidden": ["停止"]}


def test_lint_export_walks_the_proposal_payload_recursively():
    payload = {
        "title": "検品レスのご提案",
        "kpis": {"verdict": "停止線の前で滞留します。", "throughput_per_hr": 120.0},
        "insights": [{"title": "無害な見出し", "action": "ここで停止させます。"}],
        "brand": {"logo_path": "/tmp/検品レス.png"},   # パス系キーは走査しない
        "flags": [True, None, 3],
    }
    hits = wording.lint_export(payload, RULES)
    paths = {h["path"]: h["term"] for h in hits}
    assert paths == {"title": "検品レス", "insights.0.action": "停止"}
    assert "brand.logo_path" not in paths          # 誤検知を作らない
    assert "kpis.verdict" not in paths             # 「停止線」は allow で通る
    assert all(h["context"] for h in hits)         # 該当行を添える


def test_proposal_payload_collects_the_run_artifacts(tmp_path):
    """提案書ペイロードは成果物から組む（web 依存なし＝CLI からも同じものを検査）。"""
    proj = Project.create("pp", "ecommerce_small", base=tmp_path / "projects")
    assert wording.proposal_payload(proj)["project"] == "pp"      # ラン前でも動く
    rd = proj.new_run_dir()
    (rd / "kpis.json").write_text(
        json.dumps({"verdict": "ここで停止が発生します。", "throughput_per_hr": 120.0},
                   ensure_ascii=False), "utf-8")
    payload = wording.proposal_payload(proj, {"insights": [{"title": "検品レスの提案"}]})
    hits = wording.lint_export(payload, RULES)
    assert {h["path"] for h in hits} == {"kpis.verdict", "insights.0.title"}


# ── 用語ガード: API / CLI ──────────────────────────────────────────────────
@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as pm
    monkeypatch.setattr(pm, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def test_wording_check_endpoint(client):
    client.post("/api/projects", json={"name": "w", "template": "ecommerce_small"})
    # 1. ルール未設定 ⇒ 検査は無効・検出ゼロ。
    r = client.post("/api/projects/w/wording/check", json={"text": "停止します"})
    assert r.status_code == 200
    assert r.json()["enabled"] is False and r.json()["count"] == 0

    # 2. ルールを body で渡すと検査される（保存せず試せる）。
    r = client.post("/api/projects/w/wording/check",
                    json={"text": "停止線の前で停止します", "rules": RULES})
    j = r.json()
    assert j["enabled"] is True and j["source"] == "text"
    assert [h["term"] for h in j["hits"]] == ["停止"]

    # 3. settings.wording に保存すると text 省略で提案書ペイロードを検査する。
    r = client.put("/api/projects/w/settings",
                   json={"wording": {"forbidden": ["ecommerce"], "unknown": 1}})
    assert r.status_code == 200
    assert r.json()["settings"]["wording"] == {"forbidden": ["ecommerce"]}  # 正規化される
    r = client.post("/api/projects/w/wording/check", json={})
    j = r.json()
    assert j["enabled"] is True and j["source"] == "proposal"
    assert isinstance(j["hits"], list)          # ラン前でも 500 にしない
    # ペイロードにはプロジェクト名が入るので、その語を禁止すれば必ず1件は出る。
    client.put("/api/projects/w/settings", json={"wording": {"forbidden": ["w"]}})
    assert client.post("/api/projects/w/wording/check", json={}).json()["count"] >= 1
    # {} に戻すと検査は無効（既存挙動に戻せる）。
    client.put("/api/projects/w/settings", json={"wording": {}})
    assert client.post("/api/projects/w/wording/check", json={}).json()["enabled"] is False


def test_cli_wording_reports_hits_and_exit_code(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    import whsim.project as pm
    from whsim.cli import app as cli_app
    monkeypatch.setattr(pm, "PROJECTS_DIR", tmp_path / "projects")
    proj = Project.create("c", "ecommerce_small", base=tmp_path / "projects")
    runner = CliRunner()

    doc = tmp_path / "proposal.md"
    doc.write_text("# 提案\n停止線は維持し、検品レスを行う。\n", "utf-8")

    # ルール未設定: 検査しない（終了コード 0）。
    res = runner.invoke(cli_app, ["wording", "c", "--file", str(doc)])
    assert res.exit_code == 0 and "未設定" in res.output

    model = proj.load_model()
    model.settings.wording = RULES
    proj.save_model(model)
    res = runner.invoke(cli_app, ["wording", "c", "--file", str(doc)])
    assert res.exit_code == 1                       # 検出したら非ゼロ（CI で使える）
    assert "検品レス" in res.output and "検品の集約" in res.output
    assert "停止線" not in res.output.split("検査対象")[-1].split("\n")[0]


# ── 時間帯波形 ────────────────────────────────────────────────────────────
SHAPE = {6: 97, 7: 865, 8: 400, 21: 9}


def test_normalise_hourly_is_tolerant():
    assert ds.normalise_hourly({"6時": "97", "７": " 865 "}) == {6: 97.0, 7: 865.0}
    assert ds.normalise_hourly([(6, 10), ("bad", 1), (25, 5), (7, -3)]) == {6: 10.0}
    assert ds.normalise_hourly([{"hour": "08:00", "count": "1,234件"}]) == {8: 1234.0}
    assert ds.normalise_hourly([1, 2]) == {0: 1.0, 1: 2.0}      # 素の並び
    assert ds.normalise_hourly([(6, 1), (6, 2)]) == {6: 3.0}    # 重複は足す
    assert ds.normalise_hourly(None) == {}


def test_describe_finds_the_peak_hour():
    d = ds.describe(SHAPE)
    assert d["total"] == 1371.0
    assert d["peak_hour"] == 7
    assert d["peak_count"] == 865.0
    assert d["peak_share"] == round(865 / 1371, 4)
    assert d["first_hour"] == 6 and d["last_hour"] == 21 and d["active_hours"] == 4
    empty = ds.describe({})
    assert empty["peak_hour"] is None and empty["total"] == 0.0


def test_arrivals_follow_the_hourly_shape():
    orders = ds.from_hourly(SHAPE, seed=7)
    assert len(orders) == 1371
    per_hour = {}
    for o in orders:
        per_hour[int(o.arrival_s // 3600)] = per_hour.get(int(o.arrival_s // 3600), 0) + 1
    assert per_hour == {6: 97, 7: 865, 8: 400, 21: 9}     # 件数どおり・時間帯内に収まる
    assert orders == sorted(orders, key=lambda o: o.arrival_s)   # 到着順
    assert orders[0].order_id == "H000001"


def test_total_orders_scales_the_shape_exactly():
    orders = ds.from_hourly(SHAPE, total_orders=100, seed=7)
    assert len(orders) == 100                              # 最大剰余法で総数ぴったり
    per_hour = {}
    for o in orders:
        h = int(o.arrival_s // 3600)
        per_hour[h] = per_hour.get(h, 0) + 1
    # 形が保たれている（7時台が過半、6時台は数件）。
    assert per_hour[7] == round(865 / 1371 * 100)
    assert sum(per_hour.values()) == 100
    assert ds.from_hourly(SHAPE, total_orders=0) == []


def test_same_seed_reproduces_the_identical_series():
    a = ds.from_hourly(SHAPE, seed=42)
    b = ds.from_hourly(SHAPE, seed=42)
    assert [(o.order_id, o.arrival_s) for o in a] == [(o.order_id, o.arrival_s) for o in b]
    c = ds.from_hourly(SHAPE, seed=43)
    assert [o.arrival_s for o in c] != [o.arrival_s for o in a]


def test_lines_are_built_only_from_supplied_skus():
    plain = ds.from_hourly({8: 5}, seed=1)
    assert all(o.lines == [] for o in plain)               # SKU を渡さなければ明細ゼロ
    with_skus = ds.from_hourly({8: 40}, seed=1, lines_per_order=2.5,
                               skus=["A", "B"], qty_per_line=2)
    counts = [len(o.lines) for o in with_skus]
    assert set(counts) == {2, 3}                           # 端数は seed 付きで割り振る
    assert 2.2 < sum(counts) / len(counts) < 2.8
    assert {ln.sku for o in with_skus for ln in o.lines} <= {"A", "B"}
    assert all(ln.qty == 2 for o in with_skus for ln in o.lines)


def test_read_hourly_csv_drops_broken_rows_and_continues():
    csv = ("倉庫別 出荷実績（自動出力）\n"          # タイトル行（見出しではない）
           "時間帯,オーダー件数\n"
           "6時,97\n"
           "7時,865\n"
           "こわれた行,-\n"                          # 落とす1行
           '8時,"1,234"\n'                           # 桁区切りは読む
           "合計,2196\n")                            # 合計行は data_io が落とす
    res = ds.read_hourly_csv(csv.encode("utf-8"), "hourly.csv")
    assert res["hourly"] == {6: 97.0, 7: 865.0, 8: 1234.0}
    assert res["dropped"] == 1 and res["used"] == 3
    assert res["hour_column"] == "時間帯" and res["count_column"] == "オーダー件数"
    assert res["shape"] == "long"


def test_read_hourly_csv_accepts_aliases_and_wide_tables(tmp_path):
    # 別名の見出し（BOM 付き・全角）でも当てる。
    p = tmp_path / "h.csv"
    p.write_text("﻿ＨＯＵＲ,件数\n9,10\n10,20\n", "utf-8")
    assert ds.read_hourly_csv(p)["hourly"] == {9: 10.0, 10: 20.0}
    # 横持ち（見出しが時、行が日別）は合算する。
    wide = "6時,7時,8時,9時\n1,2,3,4\n10,20,30,40\n".encode("utf-8")
    res = ds.read_hourly_csv(wide, "wide.csv")
    assert res["shape"] == "wide"
    assert res["hourly"] == {6: 11.0, 7: 22.0, 8: 33.0, 9: 44.0}
    # 読めない表は警告つきで空を返す（例外にしない）。
    bad = ds.read_hourly_csv(b"a,b\n1,2\n", "x.csv")
    assert bad["hourly"] == {} and bad["warnings"]


def test_apply_to_model_writes_orders_and_widens_the_window():
    from whsim import templates
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 28800.0                      # 既定の8時間窓 (0-8時)
    summary = ds.apply_to_model(m, {6: 10, 18: 20}, seed=5)
    assert summary["orders"] == 30 and summary["peak_hour"] == 18
    assert len(m.orders.outbound) == 30
    assert all(o.lines for o in m.orders.outbound)          # モデルの SKU で明細を作る
    # 18時台の山が窓の外に落ちて「0件処理」になるのを防ぐ（伸ばすだけ・縮めない）。
    assert summary["window_extended"] is True
    assert m.simulation.duration_s >= 19 * 3600.0
    before = m.simulation.duration_s
    ds.apply_to_model(m, {6: 10}, seed=5)
    assert m.simulation.duration_s == before                # 縮めない


@pytest.mark.parametrize("shape", [{8: 20, 9: 40, 10: 10}])
def test_generated_orders_run_through_the_engine(shape):
    """統合確認: 波形から作った到着系列でそのまま DES が回る。"""
    from whsim import kpis, templates
    from whsim.engine.run import run_replications
    m = templates.load_template_model("ecommerce_small")
    ds.apply_to_model(m, shape, seed=3)
    m.simulation.replications = 1
    results, _heat = run_replications(m, reps=1)
    metrics = kpis.compute(results, m)
    assert metrics["orders_arrived"] == 70
    assert metrics["orders_completed"] > 0
    assert metrics["verdict"]


def test_import_hourly_demand_endpoint(client):
    client.post("/api/projects", json={"name": "hd", "template": "ecommerce_small"})
    csv = "時,件数\n6,97\nこわれ,x\n7,865\n".encode("utf-8")
    r = client.post("/api/projects/hd/import/hourly-demand",
                    files={"file": ("h.csv", csv, "text/csv")})
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is True
    assert j["hourly"] == {"6": 97.0, "7": 865.0}
    assert j["summary"]["orders"] == 962 and j["summary"]["peak_hour"] == 7
    assert j["parsed"]["dropped"] == 1
    assert "962" in j["message"]
    # モデルに入っている（＝この後の実行は実波形で回る）。
    model = client.get("/api/projects/hd/full").json()
    assert len(model["orders"]["outbound"]) == 962

    # 総数スケール指定。
    r2 = client.post("/api/projects/hd/import/hourly-demand?total_orders=50&seed=9",
                     files={"file": ("h.csv", csv, "text/csv")})
    assert r2.json()["summary"]["orders"] == 50

    # 読めない表は ok:false（500 にしない・モデルは触らない）。
    r3 = client.post("/api/projects/hd/import/hourly-demand",
                     files={"file": ("h.csv", b"a,b\n1,2\n", "text/csv")})
    assert r3.status_code == 200 and r3.json()["ok"] is False
    assert len(client.get("/api/projects/hd/full").json()["orders"]["outbound"]) == 50
