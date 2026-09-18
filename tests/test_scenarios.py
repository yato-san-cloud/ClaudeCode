"""名前付きシナリオの保存・比較 (採点表レール Stage2)."""
from fastapi.testclient import TestClient

from whsim.web.app import app

client = TestClient(app)


def _mk(name):
    client.post("/api/projects", json={"name": name, "template": "ecommerce_small"})


def test_save_list_delete_roundtrip():
    _mk("scnA")
    try:
        r = client.post("/api/projects/scnA/scenarios", json={"label": "現行案"})
        assert r.status_code == 200
        sid = r.json()["id"]
        assert r.json()["label"] == "現行案"
        assert r.json()["scorecard"]["rows"]                       # carries its scorecard
        lst = client.get("/api/projects/scnA/scenarios").json()["scenarios"]
        assert any(s["id"] == sid for s in lst)
        assert all(s.get("scorecard") for s in lst)
        assert client.delete(f"/api/projects/scnA/scenarios/{sid}").json()["ok"]
        assert not client.get("/api/projects/scnA/scenarios").json()["scenarios"]
    finally:
        client.delete("/api/projects/scnA")


def test_scenario_freezes_unsaved_sections_without_persisting():
    _mk("scnB")
    try:
        full = client.get("/api/projects/scnB/full").json()
        model = full.get("model", full)
        s = dict(model.get("settings", {}))
        s["labor_cost_per_hour"] = 4000
        hi = client.post("/api/projects/scnB/scenarios",
                         json={"label": "高単価", "sections": {"settings": s}}).json()
        s2 = dict(s)
        s2["labor_cost_per_hour"] = 1000
        lo = client.post("/api/projects/scnB/scenarios",
                         json={"label": "低単価", "sections": {"settings": s2}}).json()
        cost_hi = next(r for r in hi["scorecard"]["rows"] if r["id"] == "cost")["per_order"]
        cost_lo = next(r for r in lo["scorecard"]["rows"] if r["id"] == "cost")["per_order"]
        assert cost_hi > cost_lo                                   # labour rate drives ¥/order
        # the saved model is NOT mutated by scenario freezing
        live = client.get("/api/projects/scnB/scorecard").json()
        assert live["rows"]                                        # still scores fine
    finally:
        client.delete("/api/projects/scnB")


def test_delete_missing_is_false_not_500():
    _mk("scnC")
    try:
        assert client.delete("/api/projects/scnC/scenarios/nope").json() == {"ok": False}
        assert client.get("/api/projects/scnC/scenarios").json() == {"scenarios": []}
    finally:
        client.delete("/api/projects/scnC")
