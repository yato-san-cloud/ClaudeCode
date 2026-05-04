"""Unit tests for the analytical functions."""
from __future__ import annotations

import pandas as pd
import pytest

from src import analyses, data_io


@pytest.fixture
def shipments() -> pd.DataFrame:
    rows = []
    base = pd.Timestamp("2026-01-05")  # Monday
    for d in range(7):
        day = base + pd.Timedelta(days=d)
        for sku, qty in [("A", 100), ("B", 30), ("C", 5)]:
            rows.append({"date": day, "timestamp": day + pd.Timedelta(hours=10), "sku": sku, "qty": qty, "partner": "P1"})
    return pd.DataFrame(rows)


@pytest.fixture
def inbound() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {"date": pd.Timestamp("2026-01-05"), "sku": "A", "qty": 500},
            {"date": pd.Timestamp("2026-01-06"), "sku": "B", "qty": 200},
        ]
    )


@pytest.fixture
def inventory() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {"sku": "A", "qty": 1000},
            {"sku": "B", "qty": 500},
            {"sku": "C", "qty": 200},
            {"sku": "D", "qty": 50},
        ]
    )


def test_volume_trends_combines_kinds(shipments, inbound):
    out = analyses.volume_trends(shipments, inbound, freq="D")
    assert set(out["kind"].unique()) == {"出荷", "入荷"}
    assert (out.groupby("kind")["qty"].sum()["出荷"]) == shipments["qty"].sum()
    assert (out.groupby("kind")["qty"].sum()["入荷"]) == inbound["qty"].sum()


def test_volume_trends_handles_empty_inputs():
    out = analyses.volume_trends(None, None)
    assert out.empty
    assert list(out.columns) == ["period", "kind", "qty", "lines"]


def test_abc_analysis_assigns_ranks(shipments):
    out = analyses.abc_analysis(shipments, key="sku")
    assert list(out["sku"]) == ["A", "B", "C"]
    assert out["share"].sum() == pytest.approx(1.0)
    assert out.iloc[0]["rank"] == "A"
    assert out["cum_share"].is_monotonic_increasing


def test_abc_analysis_zero_total():
    df = pd.DataFrame({"sku": ["A"], "qty": [0]})
    out = analyses.abc_analysis(df)
    assert (out["rank"] == "C").all()


def test_peak_analysis_shapes(shipments):
    by_w, by_h, hm = analyses.peak_analysis(shipments)
    assert list(by_w["weekday"]) == ["月", "火", "水", "木", "金", "土", "日"]
    assert not by_h.empty
    assert hm.shape[0] == 7


def test_peak_analysis_without_timestamp(shipments):
    no_ts = shipments.drop(columns=["timestamp"])
    by_w, by_h, hm = analyses.peak_analysis(no_ts)
    assert not by_w.empty
    assert by_h.empty
    assert hm.empty


def test_inventory_turnover(shipments, inventory):
    out = analyses.inventory_turnover(inventory, shipments, dead_stock_days=30)
    out = out.set_index("sku")
    assert out.loc["A", "shipped_qty"] == 700
    assert out.loc["A", "turnover"] == pytest.approx(0.7)
    assert out.loc["D", "shipped_qty"] == 0
    assert bool(out.loc["D", "dead_stock"]) is True
    assert bool(out.loc["A", "dead_stock"]) is False


def test_inventory_turnover_without_shipments(inventory):
    out = analyses.inventory_turnover(inventory, pd.DataFrame())
    assert (out["shipped_qty"] == 0).all()
    assert out["dead_stock"].all()


def test_data_io_guess_column():
    df = pd.DataFrame(columns=["出荷日", "商品コード", "出荷数量", "取引先"])
    mapping = data_io.initial_mapping(df, data_io.SHIPMENT_FIELDS)
    assert mapping["date"] == "出荷日"
    assert mapping["sku"] == "商品コード"
    assert mapping["qty"] == "出荷数量"
    assert mapping["partner"] == "取引先"


def test_data_io_apply_mapping_coerces_types():
    df = pd.DataFrame(
        {"出荷日": ["2026-01-01", "2026-01-02"], "コード": ["A", "B"], "数量": ["10", "20"]}
    )
    m = {"date": "出荷日", "sku": "コード", "qty": "数量", "timestamp": None, "partner": None}
    out = data_io.apply_mapping(df, m, data_io.SHIPMENT_FIELDS)
    assert out["date"].dtype.kind == "M"
    assert out["qty"].dtype.kind in ("i", "f")
    assert list(out.columns) == ["date", "sku", "qty"]
