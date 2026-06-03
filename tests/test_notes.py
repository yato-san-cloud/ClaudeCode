"""知見ボード (notes): per-project anchored comments + API."""

import pytest
from fastapi.testclient import TestClient

from whsim import notes
from whsim.project import Project
from whsim.web.app import app


def test_add_list_delete(tmp_path):
    proj = Project.create("k", "ecommerce_small", base=tmp_path / "projects")
    assert notes.list_notes(proj) == []
    n = notes.add_note(proj, "生産性", "田中", "入荷検品は繁忙期実測で23行/h")
    assert n["anchor"] == "生産性" and n["author"] == "田中" and n["id"]
    notes.add_note(proj, "工程", "", "格納は2人超で干渉")
    lst = notes.list_notes(proj)
    assert len(lst) == 2
    assert notes.list_notes(proj, anchor="生産性")[0]["text"].startswith("入荷検品")
    assert notes.add_note(proj, "工程", "", "x")  # blank author defaults
    assert notes.delete_note(proj, n["id"]) is True
    assert notes.delete_note(proj, "nope") is False
    assert all(x["id"] != n["id"] for x in notes.list_notes(proj))


def test_empty_text_rejected(tmp_path):
    proj = Project.create("e", "ecommerce_small", base=tmp_path / "projects")
    with pytest.raises(ValueError):
        notes.add_note(proj, "general", "a", "   ")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as pm
    monkeypatch.setattr(pm, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def test_endpoints(client):
    client.post("/api/projects", json={"name": "p", "template": "ecommerce_small"})
    assert client.get("/api/projects/p/notes").json()["notes"] == []
    r = client.post("/api/projects/p/notes",
                    json={"anchor": "シナリオ", "author": "佐藤", "text": "ピーク日は+60%で見る"})
    nid = r.json()["id"]
    assert client.get("/api/projects/p/notes").json()["notes"][0]["author"] == "佐藤"
    assert client.get("/api/projects/p/notes?anchor=シナリオ").json()["notes"]
    assert client.post("/api/projects/p/notes", json={"text": ""}).status_code == 400
    assert client.delete(f"/api/projects/p/notes/{nid}").json()["ok"] is True
