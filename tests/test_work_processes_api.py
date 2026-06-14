"""API tests for the editable work-process master (完全フリー工程).

The 完全フリー工程 editor reads/writes the project's work-process list. These pin the
round-trip, the engine-default fallback, the reset (empty ⇒ default), and the DAG
hygiene (blank/duplicate ids dropped, dangling/self dependencies pruned).
"""

import pytest
from fastapi.testclient import TestClient

from whsim.web.app import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def _make(client, name="wp"):
    r = client.post("/api/projects", json={"name": name, "template": "ecommerce_small"})
    assert r.status_code in (200, 201), r.text
    return name


def test_get_defaults_to_engine_flow(client):
    name = _make(client)
    r = client.get(f"/api/projects/{name}/work-processes")
    assert r.status_code == 200, r.text
    body = r.json()
    ids = [p["id"] for p in body["processes"]]
    assert ids == ["入荷検品", "格納", "ピッキング", "検品", "梱包", "出荷"]
    assert [p["id"] for p in body["default"]] == ids
    assert {d["id"] for d in body["drivers"]} == {
        "in_lines", "in_qty", "out_lines", "out_orders"}


def test_save_and_roundtrip_custom_processes(client):
    name = _make(client)
    custom = [
        {"id": "入荷", "section": "入荷", "driver": "in_lines", "prod": 50, "unit": "行/h"},
        {"id": "ピック梱包", "section": "出荷", "driver": "out_orders", "prod": 30,
         "unit": "件/h", "depends": ["入荷"]},
    ]
    r = client.post(f"/api/projects/{name}/work-processes", json={"processes": custom})
    assert r.status_code == 200, r.text
    assert r.json()["saved"] == 2
    # Round-trips on a fresh GET (persisted to the model).
    got = client.get(f"/api/projects/{name}/work-processes").json()["processes"]
    assert [p["id"] for p in got] == ["入荷", "ピック梱包"]
    assert got[1]["depends"] == ["入荷"]
    assert got[0]["productivity"] == 50


def test_empty_payload_resets_to_default(client):
    name = _make(client)
    client.post(f"/api/projects/{name}/work-processes",
                json={"processes": [{"id": "唯一", "driver": "out_lines", "prod": 99}]})
    # Empty list resets to the engine default.
    r = client.post(f"/api/projects/{name}/work-processes", json={"processes": []})
    assert r.json()["saved"] == 0
    ids = [p["id"] for p in client.get(f"/api/projects/{name}/work-processes").json()["processes"]]
    assert ids == ["入荷検品", "格納", "ピッキング", "検品", "梱包", "出荷"]


def test_save_prunes_bad_ids_and_dangling_deps(client):
    name = _make(client)
    rows = [
        {"id": "  ", "driver": "out_lines"},                       # blank id → dropped
        {"id": "A", "driver": "out_lines", "depends": ["A", "ZZ"]},  # self + dangling pruned
        {"id": "A", "driver": "out_lines"},                        # duplicate → dropped
        {"id": "B", "driver": "out_orders", "depends": ["A"]},     # valid edge kept
    ]
    r = client.post(f"/api/projects/{name}/work-processes", json={"processes": rows})
    procs = r.json()["processes"]
    assert [p["id"] for p in procs] == ["A", "B"]
    assert next(p for p in procs if p["id"] == "A")["depends"] == []
    assert next(p for p in procs if p["id"] == "B")["depends"] == ["A"]
