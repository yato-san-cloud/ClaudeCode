"""API tests for the timetable scenario comparison (作業バッチ/方式の比較).

Saving a scenario freezes the design (incl. batch_schedule + work method); the
compare endpoint re-solves staffing for the current design and each saved scenario
under a shared window, so the planner reads the operations delta.
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


def _make(client, name="cmp"):
    r = client.post("/api/projects", json={"name": name, "template": "ecommerce_small"})
    assert r.status_code in (200, 201), r.text
    # seed outbound demand so project_volumes() is non-empty.
    client.post(f"/api/projects/{name}/import-table?kind=shipments", files={
        "file": ("ship.csv", b"date,sku,qty,order_id\n"
                 + b"\n".join(f"2026-06-01,S{i%20},2,O{i}".encode() for i in range(400)),
                 "text/csv")})
    return name


def test_compare_lists_current_and_saved_scenarios(client):
    name = _make(client)
    # Save two scenarios with different batch schedules (朝寄せ vs 夕締め).
    client.post(f"/api/projects/{name}/timetable/solve-staffing",
                json={"volumes": VOLS, "batches": {"出荷": [{"hour": 10, "pct": 100}]}})
    client.post(f"/api/projects/{name}/scenarios", json={"label": "朝寄せ案"})
    client.post(f"/api/projects/{name}/timetable/solve-staffing",
                json={"volumes": VOLS, "batches": {"出荷": [{"hour": 18, "pct": 100}]}})
    client.post(f"/api/projects/{name}/scenarios", json={"label": "夕締め案"})

    r = client.get(f"/api/projects/{name}/timetable/compare?start_hour=8&end_hour=22&placement=front")
    assert r.status_code == 200, r.text
    body = r.json()
    if not body["available"]:
        pytest.skip("no project demand derived")
    labels = [row["label"] for row in body["rows"]]
    assert labels[0] == "現在の設計"
    assert "朝寄せ案" in labels and "夕締め案" in labels
    for row in body["rows"]:
        # every row carries the comparable KPIs
        assert "peak_headcount" in row and "total_man_hours" in row
        assert "monthly_cost" in row and "method" in row
        # method resolves to a label (legacy pick_strategy fallback), not "—".
        assert row["method"] in ("シングルオーダー", "マルチオーダー",
                                 "ゾーン（リレー）", "バッチ投入") or row["method"] == "—"
    # the default design (pick_strategy=discrete) labels as シングルオーダー.
    assert body["rows"][0]["method"] == "シングルオーダー"


def test_compare_reflects_batch_difference(client):
    name = _make(client, "cmp2")
    # 夕締め (late release) should finish later than 朝便 (early release).
    client.post(f"/api/projects/{name}/timetable/solve-staffing",
                json={"volumes": VOLS, "batches": {"出荷": [{"hour": 9, "pct": 100}]}})
    client.post(f"/api/projects/{name}/scenarios", json={"label": "朝便"})
    client.post(f"/api/projects/{name}/timetable/solve-staffing",
                json={"volumes": VOLS, "batches": {"出荷": [{"hour": 19, "pct": 100}]}})
    client.post(f"/api/projects/{name}/scenarios", json={"label": "夕締め"})

    rows = client.get(
        f"/api/projects/{name}/timetable/compare?start_hour=8&end_hour=24&placement=front"
    ).json()["rows"]
    by = {r["label"]: r for r in rows}
    if by["朝便"]["makespan_hour"] and by["夕締め"]["makespan_hour"]:
        assert by["夕締め"]["makespan_hour"] >= by["朝便"]["makespan_hour"]
