"""保管設備の試算 — demand → equipment sizing, incl. the AS/RS crane cycle model.

Covers the existing 台数/間口/坪 sizing invariants plus the additive FEM 9.851
AS/RS wiring: routing bulk C品 to 自動倉庫 sizes cranes from throughput demand,
surfaces the cycle numbers in the payload, and never changes the default flow.
"""

from fastapi.testclient import TestClient

from whsim import project as project_mod
from whsim import storage
from whsim.schema.model import Item, Order, OrderLine, WarehouseModel
from whsim.web.app import app


def _bulk_model(daily_pieces_per_sku: int = 200, stock: int = 5000,
                case_qty: int = 10, skus: int = 6, days: int = 5) -> WarehouseModel:
    """A model of low-frequency, large-lot C品 (routes to the bulk rack)."""
    m = WarehouseModel()
    m.items = [Item(sku=f"S{i}", abc_class="C", case_qty=case_qty, stock=stock)
               for i in range(skus)]
    m.orders.outbound = [
        Order(order_id=f"O{d}-{o}", arrival_s=float(o * 1800 + d * 86400),
              lines=[OrderLine(sku=f"S{o % skus}", qty=daily_pieces_per_sku)])
        for d in range(days) for o in range(skus)
    ]
    return m


# --- default sizing invariants (unchanged behaviour) ------------------------

def test_default_bulk_is_pallet_and_no_asrs_block():
    est = storage.estimate_storage(_bulk_model(), {})
    assert est["has_data"] is True
    assert est["asrs"] is None                      # additive key, absent by default
    assert "pallet" in {m["rack_type"] for m in est["by_method"]}
    assert "asrs" not in {m["rack_type"] for m in est["by_method"]}
    # existing row shape survives
    row = est["by_method"][0]
    for k in ("rack_type", "items", "cells", "units", "footprint_tsubo", "monthly_yen"):
        assert k in row


def test_totals_sum_over_methods():
    est = storage.estimate_storage(_bulk_model(), {})
    assert est["totals"]["units"] == sum(m["units"] for m in est["by_method"])
    assert est["totals"]["cells"] == sum(m["cells"] for m in est["by_method"])


# --- AS/RS crane wiring -----------------------------------------------------

def test_asrs_bucket_carries_crane_cycle_numbers():
    est = storage.estimate_storage(_bulk_model(), {"bulk_rack_type": "asrs"})
    assert "asrs" in {m["rack_type"] for m in est["by_method"]}
    a = est["asrs"]
    assert a is not None
    # FEM 9.851: E(SC) < E(DC); throughput + crane count are present and sane
    assert a["e_sc_s"] < a["e_dc_s"]
    assert a["dc_cycles_per_h"] > 0
    assert a["cranes"] >= 1
    # the method row mirrors the block, and 台数 == the crane count
    row = next(m for m in est["by_method"] if m["rack_type"] == "asrs")
    assert row["asrs"]["cranes"] == row["units"]
    assert row["units"] == max(a["cranes_capacity"], a["cranes_throughput"])


def test_throughput_binds_when_flow_is_high():
    # tiny inventory (1 cell/SKU) but a torrent of shipments ⇒ throughput-bound.
    hot = _bulk_model(daily_pieces_per_sku=40000, stock=2000, case_qty=1)
    est = storage.estimate_storage(hot, {"bulk_rack_type": "asrs"})
    a = est["asrs"]
    assert a["cranes_throughput"] > a["cranes_capacity"]
    assert a["cranes"] == a["cranes_throughput"]


def test_capacity_binds_when_flow_is_trivial():
    # lots of stock, almost no shipping ⇒ capacity (aisles) binds, not cranes.
    cold = _bulk_model(daily_pieces_per_sku=1, stock=60000, case_qty=1, skus=8)
    est = storage.estimate_storage(cold, {"bulk_rack_type": "asrs"})
    a = est["asrs"]
    assert a["cranes_capacity"] >= a["cranes_throughput"]


def test_faster_crane_needs_fewer_or_equal_cranes():
    hot = _bulk_model(daily_pieces_per_sku=40000, stock=2000, case_qty=1)
    slow = storage.estimate_storage(hot, {"bulk_rack_type": "asrs", "crane_vx": 1.0,
                                          "crane_vy": 0.25})
    fast = storage.estimate_storage(hot, {"bulk_rack_type": "asrs", "crane_vx": 4.0,
                                          "crane_vy": 1.5})
    assert fast["asrs"]["e_dc_s"] < slow["asrs"]["e_dc_s"]
    assert fast["asrs"]["cranes"] <= slow["asrs"]["cranes"]


def test_never_blocks_on_bare_model():
    est = storage.estimate_storage(WarehouseModel(), {"bulk_rack_type": "asrs"})
    assert est["has_data"] is False
    assert est["asrs"] is None
    assert est["by_method"] == []


def test_params_echo_bulk_rack_type():
    est = storage.estimate_storage(_bulk_model(), {"bulk_rack_type": "asrs"})
    assert est["params"]["bulk_rack_type"] == "asrs"


# --- endpoint (additive query params, never breaks the shape) ---------------

def _client(tmp_path, monkeypatch):
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def test_storage_endpoint_exposes_asrs_key(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    client.post("/api/projects", json={"name": "asrs-demo", "template": "ecommerce_small"})
    r = client.get("/api/projects/asrs-demo/storage")
    assert r.status_code == 200
    body = r.json()
    assert "asrs" in body                                   # additive key always present
    assert "bulk_rack_type" in body["params"]
    # the AS/RS knobs are accepted additively (no 4xx)
    r2 = client.get("/api/projects/asrs-demo/storage",
                    params={"bulk_rack_type": "asrs", "crane_vx": 3.0})
    assert r2.status_code == 200
    assert r2.json()["params"]["bulk_rack_type"] == "asrs"
