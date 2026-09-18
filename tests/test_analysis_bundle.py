"""②分析「物量サマリ」の project-data bundle rail.

The ETL home is ①取込: ``/import/shipments`` (and ``/import-table``) persist the
column-mapped table under ``projects/<name>/analysis/`` so the 物量サマリ can
re-analyse the project's OWN data — no re-upload in the analysis tab. The bundle
endpoint must:
  * be available after an ①取込 import (preferring the persisted CSV),
  * fall back to reconstructing from model orders (pre-persistence projects),
  * label provisional template demand honestly (orders_imported=False),
  * never error — an empty project answers {"available": false}.
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
    "2025/09/01,SKU-2,3,PS001\n"
    "2025/09/02,SKU-1,7,PS002\n"
    "2025/09/03,SKU-3,2,PS003\n"
).encode("utf-8")


def _mk(client, name="bdl"):
    r = client.post("/api/projects", json={"name": name, "template": "ecommerce_small"})
    assert r.status_code == 200
    return name


def test_bundle_after_intake_import(client):
    name = _mk(client)
    r = client.post(f"/api/projects/{name}/import/shipments",
                    files={"shipments": ("ship.csv", io.BytesIO(SHIP_CSV), "text/csv")})
    assert r.status_code == 200 and r.json()["ok"]

    b = client.get(f"/api/projects/{name}/analysis/bundle").json()
    assert b["available"] is True
    assert b["source"] == "project"            # served from the persisted table
    assert b["orders_imported"] is True
    assert b["kpis"]["total_orders"] == 3
    assert len(b["trend_daily"]) == 3
    # 紐付け確認 meta survives the round-trip (filename + resolved mapping).
    meta = b["meta"]["shipments"]
    assert meta["filename"] == "ship.csv"
    assert any(m["column"] == "商品コード" for m in meta["mapping"])


def test_bundle_falls_back_to_model_orders(client):
    name = _mk(client, "bdl2")
    r = client.post(f"/api/projects/{name}/import/shipments",
                    files={"shipments": ("ship.csv", io.BytesIO(SHIP_CSV), "text/csv")})
    assert r.status_code == 200 and r.json()["ok"]
    # Simulate a pre-persistence project: drop the saved table, keep the orders.
    import whsim.project as project_mod
    (project_mod.PROJECTS_DIR / name / "analysis" / "shipments.csv").unlink()

    b = client.get(f"/api/projects/{name}/analysis/bundle").json()
    assert b["available"] is True
    assert b["source"] == "project(model)"     # reconstructed from model orders
    assert b["kpis"]["total_orders"] == 3


def test_bundle_fresh_template_is_unavailable(client):
    # Templates carry a demand PROFILE (rate-based), not explicit orders, so a
    # fresh project has nothing to chart: unavailable → the UI shows the ①取込
    # CTA. (If a template ever ships explicit orders, orders_imported=False
    # keeps the dashboard honestly labelled 仮データ.)
    name = _mk(client, "bdl3")
    b = client.get(f"/api/projects/{name}/analysis/bundle").json()
    assert b == {"available": False}


def test_bundle_empty_project_is_unavailable(client):
    name = _mk(client, "bdl4")
    # Empty the demand entirely — the bundle must answer unavailable, not 500.
    import json
    import whsim.project as project_mod
    mf = project_mod.PROJECTS_DIR / name / "model.json"
    md = json.loads(mf.read_text("utf-8"))
    md["orders"]["outbound"] = []
    mf.write_text(json.dumps(md), "utf-8")

    b = client.get(f"/api/projects/{name}/analysis/bundle").json()
    assert b == {"available": False}


def test_import_table_persists_inbound_and_inventory(client):
    name = _mk(client, "bdl5")
    inb = "入荷日,商品コード,入荷数\n2025/09/01,SKU-1,10\n".encode("utf-8")
    inv = "商品コード,在庫数\nSKU-1,40\nSKU-2,12\n".encode("utf-8")
    r1 = client.post(f"/api/projects/{name}/import-table", params={"kind": "inbound"},
                     files={"file": ("inb.csv", io.BytesIO(inb), "text/csv")})
    r2 = client.post(f"/api/projects/{name}/import-table", params={"kind": "master"},
                     files={"file": ("inv.csv", io.BytesIO(inv), "text/csv")})
    assert r1.status_code == 200 and r2.status_code == 200
    import whsim.project as project_mod
    adir = project_mod.PROJECTS_DIR / name / "analysis"
    assert (adir / "inbound.csv").exists()
    assert (adir / "inventory.csv").exists()   # kind=master is the 在庫 table
