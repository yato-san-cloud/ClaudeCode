"""API tests for the バッチ投入スケジュール round-trip on the staffing solver endpoint.

The 人員タイムチャート solver endpoint accepts a batch schedule (when/what % of a
section's volume lands), gates staffing accordingly, persists it to the model, and
re-applies it on a later solve without the payload — so the plan survives a reload.
"""

import pytest
from fastapi.testclient import TestClient

from whsim.web.app import app

VOLS = {"入荷検品": 1200, "格納": 3000, "ピッキング": 2400,
        "検品": 2400, "梱包": 1700, "出荷": 1700}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def _make_project(client, name="bt"):
    r = client.post("/api/projects", json={"name": name, "template": "ecommerce_small"})
    assert r.status_code in (200, 201), r.text
    return name


def _solve(client, name, **body):
    body.setdefault("volumes", VOLS)
    body.setdefault("start_hour", 8)
    body.setdefault("end_hour", 22)
    body.setdefault("placement", "front")
    r = client.post(f"/api/projects/{name}/timetable/solve-staffing", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_solve_echoes_and_persists_batch_schedule(client):
    name = _make_project(client)
    batches = {"入荷": [{"hour": 12, "pct": 100}]}
    body = _solve(client, name, batches=batches)
    assert body["available"] is True
    # The applied schedule is echoed back.
    assert body["batches"] == batches
    # 入荷検品 cannot start before the noon batch lands.
    recv = next(p for p in body["processes"] if p["id"] == "入荷検品")
    first = next(i for i, n in enumerate(recv["headcount_by_hour"]) if n > 0)
    assert body["hours"][first] >= 12

    # Persisted: a later solve WITHOUT batches re-applies the saved schedule.
    body2 = _solve(client, name)  # no batches key
    assert body2["batches"] == batches


def test_empty_batches_payload_clears_schedule(client):
    name = _make_project(client, "bt2")
    _solve(client, name, batches={"入荷": [{"hour": 15, "pct": 100}]})
    # An explicit empty dict clears the saved schedule.
    cleared = _solve(client, name, batches={})
    assert cleared["batches"] == {}
    # And it stays cleared on a subsequent no-payload solve.
    again = _solve(client, name)
    assert again["batches"] == {}
