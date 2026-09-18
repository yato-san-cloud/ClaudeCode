"""Personal ("my") samples: save the current project as a LOCAL-ONLY snapshot,
list it, instantiate a fresh project from it, delete it.

The store lives in a gitignored ``samples/`` dir (sibling of ``projects/``) so
real customer data never reaches the repo. Endpoints must be tolerant and never
leak across the monkeypatched workspace.
"""

import io

import pytest
from fastapi.testclient import TestClient

from whsim.web.app import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


SHIP_CSV = (
    "出荷日,商品コード,出荷数,受注番号\n"
    "2025/09/01,SKU-1,5,PS001\n"
    "2025/09/02,SKU-2,3,PS002\n"
).encode("utf-8")


def _mk(client, name):
    assert client.post("/api/projects", json={"name": name, "template": "ecommerce_small"}).status_code == 200


def test_save_list_instantiate_delete(client, tmp_path):
    _mk(client, "src")
    # give it some imported demand so the snapshot carries real data + tables
    client.post("/api/projects/src/import/shipments",
                files={"shipments": ("ship.csv", io.BytesIO(SHIP_CSV), "text/csv")})

    # save as a personal sample
    r = client.post("/api/samples", json={"project": "src", "label": "ローソンDC"})
    assert r.status_code == 200
    sid = r.json()["id"]
    assert r.json()["label"] == "ローソンDC"

    # it lands in the gitignored samples/ dir, NOT in projects/
    assert (tmp_path / "samples" / sid / "snapshot" / "model.json").is_file()

    # listing shows it with stats
    lst = client.get("/api/samples").json()
    assert any(m["id"] == sid and m["label"] == "ローソンDC" for m in lst)
    stats = next(m["stats"] for m in lst if m["id"] == sid)
    assert stats.get("orders") == 2

    # instantiate → a fresh project carrying the same imported orders
    inst = client.post(f"/api/samples/{sid}/instantiate").json()
    new = inst["name"]
    assert new and new != "src"
    b = client.get(f"/api/projects/{new}/analysis/bundle").json()
    assert b["available"] is True and b["kpis"]["total_orders"] == 2

    # the persisted analysis table came along in the snapshot
    assert (tmp_path / "projects" / new / "analysis" / "shipments.csv").is_file()

    # delete
    assert client.delete(f"/api/samples/{sid}").status_code == 200
    assert all(m["id"] != sid for m in client.get("/api/samples").json())


def test_samples_empty_and_missing(client):
    assert client.get("/api/samples").json() == []
    # instantiate / delete of an unknown id → clean 404, never a 500
    assert client.post("/api/samples/nope/instantiate").status_code == 404
    assert client.delete("/api/samples/nope").status_code == 404


def test_instantiate_autopicks_free_name(client):
    _mk(client, "base")
    sid = client.post("/api/samples", json={"project": "base", "label": "mysample"}).json()["id"]
    n1 = client.post(f"/api/samples/{sid}/instantiate").json()["name"]
    n2 = client.post(f"/api/samples/{sid}/instantiate").json()["name"]
    assert n1 != n2   # second instantiate doesn't collide with the first
