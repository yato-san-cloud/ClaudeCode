"""Golden-path integration: exercise the whole SLC journey end-to-end through the
HTTP API in one test, asserting each stage feeds the next. A single regression
here means the spine — 取込 → 分析 → 設計 → 検証 → 採点表/シナリオ — is intact.
Heavy on purpose (runs a real DES); guards cross-module wiring the unit tests
can't see individually."""
import pandas as pd
from fastapi.testclient import TestClient

from whsim.web.app import app

client = TestClient(app)


def _shipments_csv() -> bytes:
    rows = []
    for day in range(3):
        for i in range(12):
            rows.append({
                "受注番号": f"O{day}{i:03d}",
                "出荷日": f"2025-07-0{day + 1}",
                "商品コード": f"SKU{i % 6:02d}",
                "出荷数": (i % 4) + 1,
            })
    return pd.DataFrame(rows).to_csv(index=False).encode("utf-8-sig")


def test_golden_path_intake_to_scorecard_and_scenario():
    name = "golden"
    client.post("/api/projects", json={"name": name, "template": "ecommerce_small"})
    try:
        # ① 取込: real shipments → orders (ETL)
        r = client.post(f"/api/projects/{name}/import/shipments",
                        files={"shipments": ("ship.csv", _shipments_csv(), "text/csv")})
        assert r.status_code == 200 and r.json()["ok"]
        assert r.json()["summary"]["orders"] == 36

        # ② 分析: base volumes reflect the imported demand
        vol = client.get(f"/api/projects/{name}/bi/volumes").json()
        assert vol["out_orders"] > 0 and vol["out_lines"] > 0

        # ③ 設計(解析): scorecard scores the design analytically, all 6 rows
        card = client.get(f"/api/projects/{name}/scorecard").json()
        assert [row["id"] for row in card["rows"]] == \
            ["verdict", "headcount", "cost", "productivity", "tsubo", "chain"]
        assert card["run"]["exists"] is False
        # 生産性試算 (analytic step ②) recommends a method
        pr = client.get(f"/api/projects/{name}/pickrate").json()
        assert pr["recommend_id"] in {"discrete", "multi", "zone", "total"}

        # ④ 検証: a real DES run processes the imported orders
        run = client.post(f"/api/projects/{name}/run").json()
        assert run["kpis"]["orders_completed"] > 0

        # scorecard now carries the DES run block (for 解析 vs 実測 deltas)
        card2 = client.get(f"/api/projects/{name}/scorecard").json()
        assert card2["run"]["exists"] is True
        assert card2["run"]["cost_per_order"] is not None

        # Stage2: freeze two scenarios and confirm they're independently scored
        a = client.post(f"/api/projects/{name}/scenarios", json={"label": "現行"}).json()
        s = client.get(f"/api/projects/{name}/full").json()
        model = s.get("model", s)
        st = dict(model.get("settings", {}))
        st["labor_cost_per_hour"] = 999
        b = client.post(f"/api/projects/{name}/scenarios",
                        json={"label": "低単価", "sections": {"settings": st}}).json()
        cost_a = next(x for x in a["scorecard"]["rows"] if x["id"] == "cost")["per_order"]
        cost_b = next(x for x in b["scorecard"]["rows"] if x["id"] == "cost")["per_order"]
        assert cost_a != cost_b                    # the variant really differs
        assert len(client.get(f"/api/projects/{name}/scenarios").json()["scenarios"]) == 2
    finally:
        client.delete(f"/api/projects/{name}")
