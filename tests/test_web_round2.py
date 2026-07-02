"""Round-2 commercial-feature tests for the whsim FastAPI backend.

Covers the new settings endpoints (GET default / PUT round-trip / structural
400 / unknown-key tolerance), the one-click sample/demo project, and that the
proposal export still returns a real file after a run and never 500s without one.

All tests use TestClient with PROJECTS_DIR monkeypatched into a tmp dir, so the
real workspace is never touched (same pattern as test_web_round1).
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from whsim.web.app import app

webapp = sys.modules["whsim.web.app"]


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", Path("projects"))
    return TestClient(app, raise_server_exceptions=False)


def _make(client, name="proj1"):
    r = client.post("/api/projects", json={"name": name, "template": "ecommerce_small"})
    assert r.status_code == 200, r.text
    return name


# ---- settings: GET default --------------------------------------------------

def test_settings_get_default_is_empty(client):
    _make(client, "s1")
    r = client.get("/api/projects/s1/settings")
    assert r.status_code == 200
    # Whether or not the schema declares `settings`, a fresh project either has
    # no settings (-> {}) or the schema's defaults (-> a dict). Always a dict,
    # never a 500.
    assert isinstance(r.json(), dict)


def test_settings_get_missing_project_404(client):
    r = client.get("/api/projects/nope/settings")
    assert r.status_code == 404


# ---- settings: PUT round-trip ----------------------------------------------

def test_settings_put_roundtrip(client):
    _make(client, "s2")
    body = {"currency": "$", "labor_cost_per_hour": 2500,
            "agv_cost_per_month": 80000}
    r = client.put("/api/projects/s2/settings", json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ok"] is True
    assert out["settings"]["currency"] == "$"
    assert out["settings"]["labor_cost_per_hour"] == 2500
    assert out["settings"]["agv_cost_per_month"] == 80000

    # GET reflects the saved values (round-trips on disk).
    got = client.get("/api/projects/s2/settings").json()
    assert got["currency"] == "$"
    assert got["labor_cost_per_hour"] == 2500


def test_settings_put_merges_not_replaces(client):
    _make(client, "s3")
    client.put("/api/projects/s3/settings", json={"labor_cost_per_hour": 2000})
    client.put("/api/projects/s3/settings", json={"currency": "€"})
    got = client.get("/api/projects/s3/settings").json()
    # The first write survives the second (merge, not overwrite).
    assert got["labor_cost_per_hour"] == 2000
    assert got["currency"] == "€"


# ---- settings: structural 400 ----------------------------------------------

def test_settings_put_bad_structural_value_400(client):
    _make(client, "s4")
    r = client.put("/api/projects/s4/settings",
                   json={"labor_cost_per_hour": "not-a-number"})
    assert r.status_code == 400


def test_settings_put_numeric_string_coerced(client):
    _make(client, "s4b")
    r = client.put("/api/projects/s4b/settings",
                   json={"labor_cost_per_hour": "2500"})
    assert r.status_code == 200
    assert r.json()["settings"]["labor_cost_per_hour"] == 2500.0


# ---- settings: unknown key ignored -----------------------------------------

def test_settings_put_unknown_key_ignored(client):
    _make(client, "s5")
    r = client.put("/api/projects/s5/settings",
                   json={"currency": "¥", "totally_unknown_knob": 999})
    assert r.status_code == 200
    assert "totally_unknown_knob" not in r.json()["settings"]
    assert r.json()["settings"]["currency"] == "¥"


# ---- settings: 提案書ブランドテーマ (brand) ---------------------------------

def test_settings_put_brand_roundtrip(client):
    _make(client, "b1")
    r = client.put("/api/projects/b1/settings", json={
        "labor_cost_per_hour": 2100,
        "brand": {"client_name": "アクメ物流", "company_name": "提案元ロジ",
                  "accent_color": "#E2231A", "footer_note": "担当 山田"},
    })
    assert r.status_code == 200, r.text
    brand = r.json()["settings"]["brand"]
    assert brand["client_name"] == "アクメ物流"
    assert brand["accent_color"] == "#E2231A"
    # Coexists with the numeric knobs.
    assert r.json()["settings"]["labor_cost_per_hour"] == 2100
    # Survives a reload (round-trips on disk).
    got = client.get("/api/projects/b1/settings").json()
    assert got["brand"]["company_name"] == "提案元ロジ"


def _png_bytes(color=(0xE2, 0x23, 0x1A)):
    from PIL import Image
    import io
    buf = io.BytesIO()
    Image.new("RGBA", (200, 60), (*color, 255)).save(buf, format="PNG")
    return buf.getvalue()


def test_brand_logo_upload_and_persist(client):
    _make(client, "b2")
    r = client.post("/api/projects/b2/brand/logo",
                    files={"file": ("logo.png", _png_bytes(), "image/png")})
    assert r.status_code == 200, r.text
    assert r.json()["logo_path"] == "brand/logo.png"
    # The path is written into settings.brand.logo_path.
    got = client.get("/api/projects/b2/settings").json()
    assert got["brand"]["logo_path"] == "brand/logo.png"


def test_brand_logo_upload_rejects_non_image(client):
    _make(client, "b3")
    r = client.post("/api/projects/b3/brand/logo",
                    files={"file": ("notes.txt", b"just text, not an image", "text/plain")})
    assert r.status_code == 400


def test_brand_logo_survives_text_only_settings_save(client):
    _make(client, "b4")
    client.post("/api/projects/b4/brand/logo",
                files={"file": ("logo.png", _png_bytes(), "image/png")})
    # A later brand save that omits logo_path must not clear it (backend merges).
    client.put("/api/projects/b4/settings", json={"brand": {"client_name": "客先"}})
    got = client.get("/api/projects/b4/settings").json()
    assert got["brand"]["logo_path"] == "brand/logo.png"
    assert got["brand"]["client_name"] == "客先"


# ---- sample / demo project --------------------------------------------------

def test_sample_create_and_listed(client):
    r = client.post("/api/projects/sample", json={})
    assert r.status_code == 200, r.text
    out = r.json()
    assert "name" in out and isinstance(out["ready"], bool)
    name = out["name"]
    assert name in client.get("/api/projects").json()


def test_sample_autopicks_free_name(client):
    first = client.post("/api/projects/sample", json={}).json()["name"]
    second = client.post("/api/projects/sample", json={}).json()["name"]
    assert first != second
    listed = client.get("/api/projects").json()
    assert first in listed and second in listed


def test_sample_honours_requested_name(client):
    r = client.post("/api/projects/sample", json={"name": "myDemo"})
    assert r.status_code == 200
    assert r.json()["name"] == "myDemo"


# ---- export still works -----------------------------------------------------

def test_proposal_after_run_returns_file(client):
    _make(client, "ex1")
    run = client.post("/api/projects/ex1/run")
    assert run.status_code == 200, run.text
    r = client.get("/api/projects/ex1/proposal.pdf")
    assert r.status_code == 200, r.text
    # A real PDF: non-trivial bytes.
    assert len(r.content) > 1000
    assert r.content[:4] == b"%PDF"


def test_proposal_pptx_after_run(client):
    _make(client, "ex2")
    assert client.post("/api/projects/ex2/run").status_code == 200
    r = client.get("/api/projects/ex2/proposal.pptx")
    assert r.status_code == 200, r.text
    assert len(r.content) > 1000


def test_proposal_with_scenarios_no_500(client):
    _make(client, "ex3")
    assert client.post("/api/projects/ex3/run").status_code == 200
    # Run a scenario comparison so the export picks up the persisted compare.json.
    sc = client.post("/api/projects/ex3/run-scenarios", json={})
    assert sc.status_code == 200, sc.text
    r = client.get("/api/projects/ex3/proposal.pdf")
    assert r.status_code == 200
    assert len(r.content) > 1000


def test_proposal_no_run_is_404_not_500(client):
    _make(client, "ex4")
    r = client.get("/api/projects/ex4/proposal.pdf")
    # No run yet: a clean 404, never a 500.
    assert r.status_code == 404
