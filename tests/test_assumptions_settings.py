"""前提条件を**モデルに置く**（`Settings.assumptions` → 提案書）。

提案書の前提条件は決め打ちの文字列だった。案件ごとの**危険側の仮定**（「積み付けを
拘束条件から除外」のような、当たれば提案がひっくり返る仮定）は、それを置いた本人が
提案書の前提条件に書けなければ意味が無い——書けないなら、読む側はその仮定が在ること
すら知らない。

エクスポート側は ``build_pptx(..., assumptions=)`` と ``model.settings.assumptions``
の両方を読めるようになっていたが、**スキーマに置き場が無く**（`Settings` は素の
BaseModel なので未知のキーは黙って捨てられる）、web の書き出しは何も渡していなかった。
ここで固定するのはその最後の1本: 置いて、運んで、出ること。そして**空なら従来と
1バイトも変わらない**こと（既存の提案書は全部この状態）。

レンダリングそのものは `test_export_assumptions.py` が持っている。フィクスチャは合成。
"""

from __future__ import annotations

import hashlib
import json
import zipfile

import pytest

from whsim.schema.model import WarehouseModel
from whsim.web.routes._common import _call_export, _proposal_extras

KPIS = {"throughput_per_hr": 120.0, "orders_completed": 960,
        "picker_utilization": 0.71, "cycle_mean_s": 305.0, "verdict": "良好"}


def test_settings_carry_assumptions_and_default_to_empty():
    """置き場があること。既定は空＝既存モデルは1バイトも変わらない（不変条件2）。"""
    m = WarehouseModel()
    assert m.settings.assumptions == []
    m.settings.assumptions = [
        {"text": "積み付けを拘束条件から除外", "level": "危険側"},
        {"text": "1日の物量は平常日ベース", "level": "注意"},
    ]
    again = WarehouseModel.model_validate(json.loads(m.model_dump_json()))
    assert again.settings.assumptions == m.settings.assumptions
    # 未知のキーは**黙って捨てられる**ので、置き場が無いとユーザーの前提は保存の
    # 瞬間に消えていた。それが起きないことを明示的に確かめる。
    raw = json.loads(m.model_dump_json())
    assert raw["settings"]["assumptions"][0]["level"] == "危険側"


def test_the_export_route_hands_the_model_assumptions_to_the_builder(tmp_path):
    """`_proposal_extras` → `_call_export` → ビルダ。経路は1本。"""
    from whsim.project import Project
    proj = Project.create("p", "ecommerce_small", base=tmp_path)
    model = proj.load_model()
    model.settings.assumptions = [{"text": "案件固有の前提", "level": "危険側"}]
    proj.save_model(model)

    extras = _proposal_extras(proj, proj.load_model(), KPIS)
    assert extras["assumptions"] == [{"text": "案件固有の前提", "level": "危険側"}]
    assert extras["model"] is not None

    seen = {}

    def _builder(kpis, name, prov, png, out, **kw):
        seen.update(kw)
        return out

    _call_export(_builder, KPIS, "p", "実データ 50%", None, tmp_path / "x.pptx", extras)
    assert seen["assumptions"] == [{"text": "案件固有の前提", "level": "危険側"}]
    assert seen["model"] is not None

    # 前提を持たないモデルでは None を渡す＝ビルダの既定（従来の文言）のまま。
    model.settings.assumptions = []
    proj.save_model(model)
    assert _proposal_extras(proj, proj.load_model(), KPIS)["assumptions"] is None


def test_an_older_builder_without_the_new_kwargs_is_still_called(tmp_path):
    """ビルダが新しい引数を取らなくても書き出しは通る（never blocks）。"""
    calls = []

    def _old(kpis, name, prov, png, out, *, scenarios=None, insights=None,
             provenance=None):
        calls.append(sorted(k for k in ("scenarios", "insights", "provenance")))
        return out

    _call_export(_old, KPIS, "p", "", None, tmp_path / "x.pptx",
                 {"assumptions": [{"text": "無視される前提"}], "model": None})
    assert calls, "古い署名のビルダが1度も呼ばれていない"


def _part_hashes(path) -> dict:
    """.pptx の中身（パート）の SHA。生バイトは python-pptx が現在時刻を zip に
    刻むので比較にならない — 文書はパートの方。"""
    with zipfile.ZipFile(path) as z:
        return {n: hashlib.sha256(z.read(n)).hexdigest() for n in sorted(z.namelist())}


def test_a_model_assumption_reaches_the_deck_and_an_empty_one_changes_nothing(tmp_path):
    """端から端まで: モデルに書いた前提が提案書の前提条件スライドに出る。

    そして**空リストは何も変えない**——既存の全モデルがその状態なので、ここが
    バイト同一でないと「前提を置けるようにした」だけで全案件の提案書が変わる。
    """
    pptx = pytest.importorskip("pptx")          # [docs] extra
    from whsim import export_doc

    m = WarehouseModel()
    plain = export_doc.build_pptx(KPIS, "テスト倉庫", "実データ 62%", None,
                                  tmp_path / "plain.pptx")
    empty = export_doc.build_pptx(KPIS, "テスト倉庫", "実データ 62%", None,
                                  tmp_path / "empty.pptx", model=m,
                                  assumptions=list(m.settings.assumptions))
    assert _part_hashes(plain) == _part_hashes(empty), \
        "前提を置いていないモデルの提案書が変わっている"

    m.settings.assumptions = [{"text": "積み付けを拘束条件から除外", "level": "危険側"}]
    rich = export_doc.build_pptx(KPIS, "テスト倉庫", "実データ 62%", None,
                                 tmp_path / "rich.pptx", model=m)
    text = "".join(r.text for slide in pptx.Presentation(str(rich)).slides
                   for shp in slide.shapes if shp.has_text_frame
                   for p in shp.text_frame.paragraphs for r in p.runs)
    assert "積み付けを拘束条件から除外" in text
    assert "【危険側】" in text
    assert _part_hashes(rich) != _part_hashes(plain)
