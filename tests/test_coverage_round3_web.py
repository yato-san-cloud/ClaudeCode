"""Round-3 coverage: web endpoints/branches not yet exercised elsewhere.

Covers workmethod naming, inventory slotting, measured-distance import (happy +
tolerant error), CAD error path, rename/duplicate success paths, and the
settings PUT validation branches. Uses FastAPI's TestClient; never a live server.
Workspaces are isolated under tmp_path via chdir (the default `projects/` dir is
relative to CWD).
"""

from __future__ import annotations

import io
import json

import pytest
from fastapi.testclient import TestClient

from whsim.web.app import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return TestClient(app)


def _new(client, name="p", template="ecommerce_small"):
    r = client.post("/api/projects", json={"name": name, "template": template})
    assert r.status_code == 200, r.text
    return name


# ---- workmethod/name ----------------------------------------------------------

def test_workmethod_name_default(client):
    r = client.post("/api/workmethod/name", json={})
    assert r.status_code == 200
    body = r.json()
    assert "シングルオーダー" in body["name"]
    assert body["explain"].endswith("。")


def test_workmethod_name_agv_and_sort(client):
    r = client.post("/api/workmethod/name", json={"transport": "agv"})
    assert "AGV" in r.json()["name"]
    r2 = client.post("/api/workmethod/name",
                     json={"consolidation": "sort", "release": "wave"})
    assert "種まき" in r2.json()["name"] and "ウェーブ" in r2.json()["name"]


def test_workmethod_recommend_for_project(client):
    _new(client, "rm")
    r = client.get("/api/projects/rm/workmethod/recommend")
    assert r.status_code == 200
    body = r.json()
    assert body["name"] and body["reason"]
    assert "transport" in body["work"]


# ---- assign-inventory ---------------------------------------------------------

def test_assign_inventory_abc(client):
    _new(client, "inv")
    r = client.post("/api/projects/inv/assign-inventory", json={"strategy": "abc"})
    assert r.status_code == 200
    body = r.json()
    assert body["strategy"] == "abc"
    assert body["assigned"] >= 1
    assert 0.0 <= body["fill_rate"] <= 1.0


def test_assign_inventory_compact_strategy(client):
    _new(client, "inv2")
    r = client.post("/api/projects/inv2/assign-inventory", json={"strategy": "compact"})
    assert r.status_code == 200
    assert r.json()["strategy"] == "compact"


# ---- import-distances ---------------------------------------------------------

def test_import_distances_json_happy(client):
    _new(client, "dist")
    # grab two real location ids from the model
    full = client.get("/api/projects/dist/full").json()
    locs = full.get("locations", [])
    ids = [loc["id"] for loc in locs[:2]] or ["A", "B"]
    matrix = {"ids": ids, "pairs": {f"{ids[0]}|{ids[1]}": 12.5}}
    data = io.BytesIO(json.dumps(matrix).encode())
    r = client.post("/api/projects/dist/import-distances",
                    files={"file": ("d.json", data, "application/json")})
    assert r.status_code == 200, r.text
    assert "count" in r.json()


def test_import_distances_garbage_is_tolerant_400(client):
    _new(client, "dist2")
    data = io.BytesIO(b"\x00\x01 not a matrix \xff")
    r = client.post("/api/projects/dist2/import-distances",
                    files={"file": ("d.bin", data, "application/octet-stream")})
    # tolerant: a clean 400 (never a 500) on unparseable data
    assert r.status_code in (200, 400)
    assert r.status_code != 500


# ---- import-cad error path ----------------------------------------------------

def test_import_cad_garbage_is_tolerant(client):
    """A bad drawing must never 500. The importer is tolerant: it either returns
    a clean 400 ('DXF を解析できませんでした') or a 200 with an empty result."""
    _new(client, "cad")
    data = io.BytesIO(b"definitely not a DXF")
    r = client.post("/api/projects/cad/import-cad",
                    files={"file": ("x.dxf", data, "application/dxf")})
    assert r.status_code in (200, 400)
    assert r.status_code != 500
    if r.status_code == 400:
        assert "DXF" in r.json()["detail"]
    else:
        body = r.json()
        # nothing meaningful was extracted from garbage
        assert body.get("walls", 0) == 0 and body.get("zones", 0) == 0


# ---- rename / duplicate success ----------------------------------------------

def test_rename_success(client):
    _new(client, "old")
    r = client.post("/api/projects/old/rename", json={"to": "renamed"})
    assert r.status_code == 200
    assert r.json()["name"] == "renamed"
    assert client.get("/api/projects/renamed/model").status_code == 200
    assert client.get("/api/projects/old/model").status_code == 404


def test_rename_collision_400(client):
    _new(client, "a")
    _new(client, "b")
    r = client.post("/api/projects/a/rename", json={"to": "b"})
    assert r.status_code == 400


def test_duplicate_success(client):
    _new(client, "src")
    r = client.post("/api/projects/src/duplicate", json={"to": "copy"})
    assert r.status_code == 200
    assert r.json()["name"] == "copy"
    # both exist independently
    assert client.get("/api/projects/src/model").status_code == 200
    assert client.get("/api/projects/copy/model").status_code == 200


def test_duplicate_collision_400(client):
    _new(client, "s1")
    _new(client, "s2")
    r = client.post("/api/projects/s1/duplicate", json={"to": "s2"})
    assert r.status_code == 400


# ---- settings PUT branches ----------------------------------------------------

def test_put_settings_numeric_and_currency(client):
    _new(client, "set")
    r = client.put("/api/projects/set/settings",
                   json={"labor_cost_per_hour": 2500, "currency": "JPY",
                         "unknown_knob": "ignored"})
    assert r.status_code == 200
    saved = r.json()["settings"]
    assert saved["labor_cost_per_hour"] == 2500
    assert saved["currency"] == "JPY"
    assert "unknown_knob" not in saved  # forward-compatible: ignored
    # round-trips on GET
    got = client.get("/api/projects/set/settings").json()
    assert got["labor_cost_per_hour"] == 2500


def test_put_settings_numeric_string_coerced(client):
    _new(client, "set2")
    r = client.put("/api/projects/set2/settings",
                   json={"working_hours_per_day": "8"})
    assert r.status_code == 200
    assert r.json()["settings"]["working_hours_per_day"] == 8.0


def test_put_settings_non_numeric_rejected_400(client):
    _new(client, "set3")
    r = client.put("/api/projects/set3/settings",
                   json={"labor_cost_per_hour": "not-a-number"})
    assert r.status_code == 400
