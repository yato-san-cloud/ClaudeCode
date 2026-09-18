"""The read-only 取込プレビュー endpoint (powers the column-mapping modal).

It must parse + map + summarise a file WITHOUT writing anything to the project,
return a data preview of the original columns, and let the caller's confirmed
mapping flow through to the actual commit (/import/shipments ?mapping=)."""
import io

import pytest
from fastapi.testclient import TestClient

from whsim.web.app import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


CSV = ("出荷日,商品ｺｰﾄﾞ,出荷ﾊﾞﾗ数,受注番号\n"
       "2025/09/01,A,5,O1\n2025/09/01,B,3,O1\n2025/09/02,A,7,O2\n").encode("cp932")


def _mk(client, name="pv"):
    assert client.post("/api/projects", json={"name": name, "template": "ecommerce_small"}).status_code == 200


def test_preview_is_read_only_with_counts_and_rows(client):
    _mk(client)
    r = client.post("/api/projects/pv/import-preview?kind=shipments",
                    files={"file": ("s.csv", io.BytesIO(CSV), "text/csv")})
    assert r.status_code == 200
    j = r.json()
    # auto-maps the half-width-kana columns
    assert j["mapping"]["sku"]["column"] == "商品ｺｰﾄﾞ"
    assert j["mapping"]["qty"]["column"] == "出荷ﾊﾞﾗ数"
    # counts that WOULD result, computed without building orders
    assert j["counts"] == {"skus": 2, "units": 15, "lines": 3, "orders": 2}
    # a real data preview of the original columns
    assert j["preview"]["preview_rows"] == 3
    assert j["preview"]["rows"][0] == ["2025/09/01", "A", "5", "O1"]
    # nothing was committed
    assert client.get("/api/projects/pv/analysis/bundle").json().get("available") is False


def test_preview_honours_caller_mapping(client):
    _mk(client, "pv2")
    # force SKU to map to a different column → counts follow
    import json
    mp = json.dumps({"sku": "受注番号", "qty": "出荷ﾊﾞﾗ数", "date": "出荷日"})
    r = client.post(f"/api/projects/pv2/import-preview?kind=shipments&mapping={mp}",
                    files={"file": ("s.csv", io.BytesIO(CSV), "text/csv")})
    j = r.json()
    assert j["mapping"]["sku"]["column"] == "受注番号"
    assert j["counts"]["skus"] == 2  # O1, O2 distinct


def test_shipments_commit_honours_mapping(client):
    _mk(client, "pv3")
    import json
    mp = json.dumps({"sku": "商品ｺｰﾄﾞ", "qty": "出荷ﾊﾞﾗ数", "date": "出荷日", "order_id": "受注番号"})
    r = client.post(f"/api/projects/pv3/import/shipments?mapping={mp}",
                    files={"shipments": ("s.csv", io.BytesIO(CSV), "text/csv")})
    assert r.status_code == 200 and r.json()["ok"]
    assert r.json()["summary"]["orders"] == 2


def test_preview_unknown_project_404(client):
    r = client.post("/api/projects/nope/import-preview?kind=shipments",
                    files={"file": ("s.csv", io.BytesIO(CSV), "text/csv")})
    assert r.status_code == 404
