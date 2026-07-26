"""Unit tests for the Cody dialogue brain + the /api/cody/chat endpoint.

``cody.respond`` is pure and IO-free, so most tests just assert the contract
(intent / mood / needs / params) for each intent. One TestClient test exercises
the FastAPI seam that assembles context and delegates to ``respond``.
"""

import pytest
from fastapi.testclient import TestClient

from whsim import cody
from whsim.web.app import app

# A minimal context with one real template id (matches templates/ecommerce_small).
CTX = {"templates": [{"template_id": "ecommerce_small", "name": "EC物流 (small)"}]}
CTX_PROJECT = {**CTX, "project": "demo"}

# The exact contract keys every respond() result must carry.
CONTRACT_KEYS = {"reply", "mood", "intent", "params", "suggestions", "needs"}

VALID_MOODS = {"idle", "thinking", "typing", "success", "error",
               "curious", "excited", "sleeping"}


def _assert_shape(d: dict):
    assert set(d.keys()) >= CONTRACT_KEYS
    assert isinstance(d["reply"], str) and d["reply"]
    assert d["mood"] in VALID_MOODS
    assert isinstance(d["params"], dict)
    assert isinstance(d["suggestions"], list)
    assert 2 <= len(d["suggestions"]) <= 4
    assert d["needs"] is None or isinstance(d["needs"], list)


# ---- create_project --------------------------------------------------------

def test_create_with_name():
    d = cody.respond("「テスト倉庫」を作って", CTX)
    _assert_shape(d)
    assert d["intent"] == "create_project"
    assert d["mood"] == "excited"
    assert d["params"]["name"] == "テスト倉庫"
    assert d["params"]["template"] == "ecommerce_small"
    assert d["needs"] is None


def test_create_without_name_asks_for_name():
    d = cody.respond("新しいプロジェクトを作りたい", CTX)
    _assert_shape(d)
    assert d["intent"] == "create_project"
    assert d["mood"] == "excited"
    assert d["params"]["name"] is None
    assert d["params"]["template"]  # template still chosen
    assert d["needs"] == ["name"]


def test_create_ec_hint_picks_ecommerce_template():
    d = cody.respond("EC通販の倉庫を立ち上げたい", CTX)
    assert d["intent"] == "create_project"
    assert d["params"]["template"] == "ecommerce_small"


# ---- run -------------------------------------------------------------------

def test_run():
    d = cody.respond("シミュレーションを実行して", CTX_PROJECT)
    _assert_shape(d)
    assert d["intent"] == "run"
    assert d["mood"] == "thinking"
    assert d["params"] == {}


def test_run_without_project_needs_project():
    d = cody.respond("回してみて", CTX)
    assert d["intent"] == "run"
    assert d["needs"] == ["project"]
    assert d["mood"] == "idle"


# ---- open_view -------------------------------------------------------------

def test_open_view_analysis():
    d = cody.respond("結果を見せて", CTX_PROJECT)
    _assert_shape(d)
    assert d["intent"] == "open_view"
    assert d["mood"] == "curious"
    assert d["params"]["view"] == "analysis"


def test_open_view_animation():
    d = cody.respond("アニメで動きを見せて", CTX_PROJECT)
    assert d["intent"] == "open_view"
    assert d["params"]["view"] == "view2d"


def test_open_view_kpi_summary_in_reply():
    ctx = {**CTX_PROJECT, "has_run": True,
           "kpis": {"throughput_per_hr": 120, "bottleneck_jp": "梱包",
                    "bottleneck_utilization": 0.92}}
    d = cody.respond("KPIどうなった？", ctx)
    assert d["intent"] == "open_view"
    assert "梱包" in d["reply"]


# ---- compare ---------------------------------------------------------------

def test_compare():
    d = cody.respond("AGV導入したら比較して", CTX_PROJECT)
    _assert_shape(d)
    assert d["intent"] == "compare"
    assert d["mood"] == "thinking"


# ---- estimate --------------------------------------------------------------

def test_estimate():
    d = cody.respond("ざっくり概算が見たい", CTX_PROJECT)
    _assert_shape(d)
    assert d["intent"] == "estimate"
    assert d["mood"] == "thinking"


# ---- help ------------------------------------------------------------------

def test_help():
    d = cody.respond("使い方を教えて", CTX)
    _assert_shape(d)
    assert d["intent"] == "help"
    assert d["mood"] == "curious"


# ---- smalltalk -------------------------------------------------------------

def test_smalltalk_greeting():
    d = cody.respond("こんにちは", CTX)
    _assert_shape(d)
    assert d["intent"] == "smalltalk"
    assert d["mood"] == "excited"


def test_smalltalk_thanks_is_idle():
    d = cody.respond("ありがとう！", CTX)
    assert d["intent"] == "smalltalk"
    assert d["mood"] == "idle"


# ---- unknown ---------------------------------------------------------------

def test_unknown():
    d = cody.respond("xyzzy", CTX)
    _assert_shape(d)
    assert d["intent"] == "unknown"
    assert d["mood"] == "curious"


def test_empty_message_is_unknown():
    d = cody.respond("", CTX)
    assert d["intent"] == "unknown"


# ---- endpoint --------------------------------------------------------------

@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def test_cody_chat_endpoint(client):
    r = client.post("/api/cody/chat", json={"message": "EC倉庫を作って"})
    assert r.status_code == 200
    body = r.json()
    assert CONTRACT_KEYS <= set(body.keys())
    assert body["intent"] == "create_project"
    assert body["params"]["template"] == "ecommerce_small"
    # endpoint echoes the project (None here, since none was supplied)
    assert "project" in body
    assert body["mood"] in VALID_MOODS


def test_cody_chat_endpoint_unknown_project_never_blocks(client):
    # A non-existent project must not 500: has_run/kpis fall back to defaults.
    r = client.post("/api/cody/chat",
                    json={"message": "結果を見せて", "project": "does_not_exist"})
    assert r.status_code == 200
    body = r.json()
    assert body["intent"] == "open_view"
    assert body["project"] == "does_not_exist"


# ---- template matching -----------------------------------------------------
# The matcher mines each template's OWN manifest, so these tests run against the
# real catalogue: a template that ships must be reachable by describing it.

@pytest.fixture(scope="module")
def catalogue():
    from whsim.templates import list_templates
    return {"templates": list_templates()}


@pytest.mark.parametrize("message,expected", [
    ("食品の定温倉庫を作りたい", "food_chilled"),
    ("賞味期限のFEFO管理をしたい", "food_chilled"),
    ("3PLの倉庫を作って", "thirdparty_3pl"),
    ("多荷主の波動が大きい倉庫", "thirdparty_3pl"),
    ("アパレルの倉庫を作って", "apparel"),
    ("返品が多くてゾーンピッキングしたい", "apparel"),
    ("小売DCを作りたい", "retail_dc"),
    ("コンビニ向けの常温センター", "retail_dc"),
    ("AGVを入れた大規模ECを作って", "ecommerce_xl"),
    ("かんばんの部品供給倉庫を作って", "manufacturing_parts"),
    ("空の倉庫から自分で棚を引きたい", "blank"),
    ("コンベアの倉庫を作って", "pick_to_belt"),
    # Phrasings a salesperson actually types -- vocabulary from the manifest
    # prose, not just its headline name.
    ("チルドの食品倉庫", "food_chilled"),
    ("かんばん方式のライン供給", "manufacturing_parts"),
    ("小ロット高頻度の部品供給", "manufacturing_parts"),
    ("波動が大きいのでピーク検証したい", "thirdparty_3pl"),
    ("GTPのAGV倉庫", "ecommerce_xl"),
    ("ゾーンピッキングの多SKU倉庫", "apparel"),
    ("方面別のウェーブピッキング", "retail_dc"),
    ("フォークで補充する大型センター", "retail_dc"),
    ("集合コンベアを敷きたい", "pick_to_belt"),
    ("トートを投入口に載せる運用", "pick_to_belt"),
    ("MapMakerの地図を取り込みたい", "blank"),
])
def test_detect_template_matches_what_the_message_describes(message, expected, catalogue):
    assert cody._detect_template(message, catalogue) == expected


def test_detect_template_is_not_catalogue_order(catalogue):
    """A hintless message must land on the canonical default, not entry #0.

    The catalogue sorts alphabetically, so the pre-scoring heuristic handed a
    salesperson アパレル for "新しく作って". Guard the regression directly.
    """
    ids = [t["template_id"] for t in catalogue["templates"]]
    assert ids[0] != cody._FALLBACK_TEMPLATE, "fixture no longer exercises the bug"
    assert cody._detect_template("新しいプロジェクトを作って", catalogue) == cody._FALLBACK_TEMPLATE
    assert cody._detect_template("よろしくお願いします", catalogue) == cody._FALLBACK_TEMPLATE


def test_detect_template_explicit_id_wins(catalogue):
    assert cody._detect_template("pick_to_belt で作って", catalogue) == "pick_to_belt"
    # A longer id is not shadowed by a shorter one sharing its prefix.
    assert cody._detect_template("ecommerce_xl で", catalogue) == "ecommerce_xl"


def test_detect_template_folds_halfwidth_and_fullwidth(catalogue):
    """半角カナ・全角英数 must match the same as their canonical forms."""
    assert cody._detect_template("ﾈｯﾄ通販ＥＣでコンベア出荷", catalogue) == "pick_to_belt"
    assert cody._detect_template("ＡＧＶの大規模ＥＣ", catalogue) == "ecommerce_xl"


def test_ec_hint_still_prefers_the_generic_ec_template(catalogue):
    """A bare EC/通販EC hint ties across the EC templates -> the default wins.

    Regression: a hiragana 2-gram mined from pick_to_belt's description ("載せる
    だけで" -> けで) used to break that tie by scoring pure grammar as evidence.
    """
    assert cody._detect_template("EC向けで作って", catalogue) == "ecommerce_small"
    assert cody._detect_template("EC通販の倉庫を立ち上げたい", catalogue) == "ecommerce_small"


def _flat(text):
    out = set()
    for group in cody._terms(text):
        out |= group
    return out


def test_terms_keeps_content_and_drops_grammar():
    terms = _flat("載せるだけで梱包ラインまで搬送する")
    assert "梱包" in terms and "ライン" in terms and "搬送" in terms
    assert "けで" not in terms                    # hiragana fragment == verb tail
    assert "ベア" not in _flat("コンベア")          # 2-char katakana cut == noise
    assert "ピッキング" in _flat("ゾーンピッキング")  # 3+ katakana cut == real concept
    assert "部品供給" in _flat("製造部品供給")       # kanji cut == real compound
    assert "通" not in _flat("通路")               # lone kanji only as a whole run
    assert "棚" in _flat("棚を引く")               # ...and a whole run may be one char


def test_terms_group_a_run_with_its_own_fragments():
    """A run and its fragments are ONE piece of evidence, not several.

    Regression: 通販 scored three times (通販 + 通 + 販) and swamped a template
    that says the same thing once.
    """
    groups = cody._terms("通販")
    assert len(groups) == 1
    assert "通販" in groups[0]


def test_latin_term_needs_a_word_boundary():
    """A 2-letter id fragment must not fire from inside a longer word."""
    assert cody._mentions("ec向け", "ec")
    assert not cody._mentions("please check the select", "ec")


def test_boilerplate_terms_are_dropped_by_the_catalogue_cut(catalogue):
    """Terms carried by most of the catalogue distinguish nothing."""
    groups = dict(cody._term_weights(catalogue["templates"]))
    terms = set()
    for _w, g in groups["apparel"]:
        terms |= g
    assert "倉庫" not in terms
    assert "アパレル" in terms


def test_unknown_template_shape_never_blocks():
    """Junk / missing manifests must not raise -- Cody always answers."""
    ctx = {"templates": [{}, {"template_id": None}, {"template_id": "x"}, None]}
    # Only "x" is on offer, so "x" is the honest answer -- never a template the
    # catalogue does not carry.
    assert cody._detect_template("なんでもいい", ctx) == "x"
    assert cody._detect_template("", {"templates": []}) == cody._FALLBACK_TEMPLATE
    assert cody._detect_template("test", {}) == cody._FALLBACK_TEMPLATE


def test_create_reply_names_the_template_in_japanese(catalogue):
    """A salesperson cannot check a pick they cannot read."""
    d = cody.respond("「テスト倉庫」を食品の定温で作って", catalogue)
    assert d["params"]["template"] == "food_chilled"
    assert "食品・定温物流 (FEFO)" in d["reply"]
    assert "food_chilled" not in d["reply"]
