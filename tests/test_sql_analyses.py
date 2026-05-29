"""SQL analyses should match the pandas reference implementation (parity tests)."""
from __future__ import annotations

import pandas as pd
import pytest

from src import analyses, sql_analyses
from src.data_io import (
    INBOUND_FIELDS,
    INVENTORY_FIELDS,
    SHIPMENT_FIELDS,
    apply_mapping,
    initial_mapping,
)
from src.duck_io import Catalog


@pytest.fixture
def frames():
    """Sample WMS frames + same data mapped for pandas analyses + a Catalog."""
    from scripts.generate_sample_data import build_frames

    raw = build_frames(days=21, seed=7)
    ship = apply_mapping(raw["shipments"], initial_mapping(raw["shipments"], SHIPMENT_FIELDS), SHIPMENT_FIELDS)
    inb = apply_mapping(raw["inbound"], initial_mapping(raw["inbound"], INBOUND_FIELDS), INBOUND_FIELDS)
    inv = apply_mapping(raw["inventory"], initial_mapping(raw["inventory"], INVENTORY_FIELDS), INVENTORY_FIELDS)

    cat = Catalog()
    cat.register_dataframe("shipments", raw["shipments"])
    cat.register_dataframe("inbound", raw["inbound"])
    cat.register_dataframe("inventory", raw["inventory"])
    cat.apply_mapping("shipments", initial_mapping(raw["shipments"], SHIPMENT_FIELDS))
    cat.apply_mapping("inbound", initial_mapping(raw["inbound"], INBOUND_FIELDS))
    cat.apply_mapping("inventory", initial_mapping(raw["inventory"], INVENTORY_FIELDS))
    return ship, inb, inv, cat


def test_catalog_register_path_csv(tmp_path, frames):
    ship, _, _, _ = frames
    csv = tmp_path / "ship.csv"
    ship.to_csv(csv, index=False)
    cat = Catalog()
    cat.register_path("shipments", csv)
    assert cat.row_count("shipments") == len(ship)
    assert set(["date", "sku", "qty"]).issubset(cat.columns("shipments"))


def test_volume_trends_parity(frames):
    ship, inb, _, cat = frames
    p_df = analyses.volume_trends(ship, inb, freq="D")
    s_df = sql_analyses.volume_trends(cat, freq="D")
    p = p_df.groupby("kind", as_index=False)[["qty", "lines"]].sum().sort_values("kind").reset_index(drop=True)
    s = s_df.groupby("kind", as_index=False)[["qty", "lines"]].sum().sort_values("kind").reset_index(drop=True)
    pd.testing.assert_frame_equal(p.astype({"qty": "int64", "lines": "int64"}),
                                  s.astype({"qty": "int64", "lines": "int64"}))


def test_abc_analysis_parity(frames):
    ship, _, _, cat = frames
    # Sort both by (qty desc, sku) so ties are deterministic for comparison.
    p = analyses.abc_analysis(ship, key="sku").sort_values(["qty", "sku"], ascending=[False, True]).reset_index(drop=True)
    s = sql_analyses.abc_analysis(cat, key="sku").sort_values(["qty", "sku"], ascending=[False, True]).reset_index(drop=True)
    assert list(p["sku"]) == list(s["sku"])
    pd.testing.assert_series_equal(p["qty"].astype("int64"), s["qty"].astype("int64"), check_names=False)
    # Total mass per rank should agree (since cum_share path depends on tie order, rank may differ at boundaries).
    p_by_rank = p.groupby("rank")["qty"].sum().sort_index()
    s_by_rank = s.groupby("rank")["qty"].sum().sort_index()
    pd.testing.assert_series_equal(p_by_rank, s_by_rank, check_names=False)
    assert (p["share"] - s["share"]).abs().max() < 1e-9


def test_peak_analysis_parity(frames):
    ship, _, _, cat = frames
    p_w, p_h, p_hm = analyses.peak_analysis(ship)
    s_w, s_h, s_hm = sql_analyses.peak_analysis(cat)
    assert list(p_w["weekday"]) == list(s_w["weekday"])
    pd.testing.assert_series_equal(p_w["lines"].astype("int64"), s_w["lines"].astype("int64"), check_names=False)
    pd.testing.assert_series_equal(p_w["qty"].astype("int64"), s_w["qty"].astype("int64"), check_names=False)
    pd.testing.assert_series_equal(p_h["hour"].astype("int64").reset_index(drop=True),
                                   s_h["hour"].astype("int64").reset_index(drop=True), check_names=False)
    assert p_hm.shape == s_hm.shape


def test_inventory_turnover_parity(frames):
    ship, _, inv, cat = frames
    p = analyses.inventory_turnover(inv, ship, dead_stock_days=30).set_index("sku").sort_index()
    s = sql_analyses.inventory_turnover(cat, dead_stock_days=30).set_index("sku").sort_index()
    pd.testing.assert_series_equal(p["stock_qty"].astype("int64"), s["stock_qty"].astype("int64"), check_names=False)
    pd.testing.assert_series_equal(p["shipped_qty"].astype("int64"), s["shipped_qty"].astype("int64"), check_names=False)
    pd.testing.assert_series_equal(p["dead_stock"].astype(bool), s["dead_stock"].astype(bool), check_names=False)
    assert (p["turnover"].fillna(0) - s["turnover"].fillna(0)).abs().max() < 1e-9


def test_volume_trends_date_filter(frames):
    _, _, _, cat = frames
    df_all = sql_analyses.volume_trends(cat, "D")
    cutoff = df_all["period"].max() - pd.Timedelta(days=2)
    df_small = sql_analyses.volume_trends(cat, "D", lo=str(cutoff.date()))
    assert df_small["period"].min() >= cutoff
    assert df_small["qty"].sum() < df_all["qty"].sum()


def test_catalog_date_bounds(frames):
    _, _, _, cat = frames
    bounds = cat.date_bounds()
    assert bounds is not None
    assert bounds[0] < bounds[1]


def test_summary_kpis_parity(frames):
    ship, inb, inv, cat = frames
    p = analyses.summary_kpis(ship, inb, inv)
    s = sql_analyses.summary_kpis(cat)
    for k in ("total_pcs_out", "total_lines_out", "total_orders",
              "total_pcs_in", "total_lines_in", "sku_active", "sku_master",
              "dead_sku_count", "peak_weekday"):
        assert p[k] == s[k], f"{k}: pandas={p[k]} sql={s[k]}"
    for k in ("pcs_per_order", "lines_per_order", "pcs_per_line",
              "orders_per_sku", "multi_line_rate", "top10_sku_share",
              "avg_turnover", "dead_sku_rate"):
        if pd.isna(p[k]):
            assert pd.isna(s[k])
        else:
            assert abs(p[k] - s[k]) < 1e-9, f"{k}: pandas={p[k]} sql={s[k]}"
