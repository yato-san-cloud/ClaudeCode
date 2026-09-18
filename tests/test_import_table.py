"""Unified 入荷/出荷/商品マスタ import (tabular + /import-table) with mapping."""

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from whsim import tabular
from whsim.web.app import app

SHIP = ("出荷日,品番,数量,受注\n2026-01-01,SKU1,2,O1\n"
        "2026-01-01,SKU2,1,O1\n2026-01-02,SKU1,3,O2\n").encode("utf-8")
MASTER = "品番,在庫\nSKU1,100\nSKU2,50\nSKU3,0\n".encode("utf-8")


def test_build_orders_groups_by_order_id():
    std = pd.DataFrame({"sku": ["A", "B", "A"], "qty": [2, 1, 3],
                        "order_id": ["O1", "O1", "O2"]})
    orders = tabular.build_orders(std, duration_s=3600)
    assert len(orders) == 2
    o1 = next(o for o in orders if o.order_id == "O1")
    assert len(o1.lines) == 2
    assert max(o.arrival_s for o in orders) <= 3600


def test_build_items_dedupes():
    std = pd.DataFrame({"sku": ["A", "A", "B"], "qty": [5, 5, 0]})
    items = tabular.build_items(std)
    assert {it.sku for it in items} == {"A", "B"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as pm
    monkeypatch.setattr(pm, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def test_import_shipments_builds_orders(client):
    client.post("/api/projects", json={"name": "i", "template": "ecommerce_small"})
    r = client.post("/api/projects/i/import-table?kind=shipments",
                    files={"file": ("s.csv", SHIP, "text/csv")})
    assert r.status_code == 200
    j = r.json()
    assert j["counts"]["orders"] == 2 and j["counts"]["lines"] == 3
    assert j["mapping"]["order_id"]["column"] == "受注"      # auto-mapped
    assert "出荷" in j["provenance_summary"]


def test_import_master_and_mapping_override(client):
    client.post("/api/projects", json={"name": "m", "template": "ecommerce_small"})
    r = client.post("/api/projects/m/import-table?kind=master",
                    files={"file": ("m.csv", MASTER, "text/csv")})
    assert r.json()["counts"]["items"] == 3
    # explicit mapping override is honoured
    import json
    mp = json.dumps({"sku": "品番", "qty": None})
    r2 = client.post(f"/api/projects/m/import-table?kind=master&mapping={mp}",
                     files={"file": ("m.csv", MASTER, "text/csv")})
    assert r2.status_code == 200 and r2.json()["counts"]["items"] == 3


def test_bad_file_is_tolerant(client):
    client.post("/api/projects", json={"name": "b", "template": "ecommerce_small"})
    r = client.post("/api/projects/b/import-table?kind=shipments",
                    files={"file": ("x.csv", b"\x00\x01\x02", "text/csv")})
    assert r.status_code in (200, 400)   # never 500
