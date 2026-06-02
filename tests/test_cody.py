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
