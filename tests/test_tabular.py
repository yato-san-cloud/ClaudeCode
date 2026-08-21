"""tabular.py — standardised CSV/Excel table → orders / items (thin importer)."""
import pandas as pd

from whsim import tabular


def test_build_orders_groups_by_order_id():
    df = pd.DataFrame({
        "order_id": ["A", "A", "B"],
        "sku": ["x", "y", "z"],
        "qty": [2, 3, 1],
    })
    orders = tabular.build_orders(df, duration_s=3600.0)
    assert len(orders) == 2
    a = next(o for o in orders if o.order_id == "A")
    assert {ln.sku for ln in a.lines} == {"x", "y"}
    # arrivals spread across the window, ascending
    arr = [o.arrival_s for o in orders]
    assert arr == sorted(arr) and arr[0] == 0.0


def test_build_orders_without_order_id_one_per_row():
    df = pd.DataFrame({"sku": ["a", "b", "c"], "qty": [1, 1, 1]})
    orders = tabular.build_orders(df)
    assert len(orders) == 3
    assert all(len(o.lines) == 1 for o in orders)


def test_build_orders_tolerates_blank_sku_and_bad_qty():
    df = pd.DataFrame({"sku": ["a", None, "", "b"], "qty": [2, 5, 9, "x"]})
    orders = tabular.build_orders(df)
    skus = [ln.sku for o in orders for ln in o.lines]
    assert skus == ["a", "b"]            # blank/null skus dropped
    bq = next(ln for o in orders for ln in o.lines if ln.sku == "b")
    assert bq.qty == 1                   # un-parseable qty → default 1


def test_build_orders_empty_or_missing_columns_returns_empty():
    assert tabular.build_orders(None) == []
    assert tabular.build_orders(pd.DataFrame()) == []
    assert tabular.build_orders(pd.DataFrame({"foo": [1]})) == []


def test_build_items_dedups_and_reads_stock():
    df = pd.DataFrame({"sku": ["a", "a", "b"], "qty": [10, 99, 5]})
    items = tabular.build_items(df)
    assert [it.sku for it in items] == ["a", "b"]   # first wins, deduped
    assert {it.sku: it.stock for it in items} == {"a": 10, "b": 5}


def test_build_items_no_qty_column_defaults_zero_stock():
    items = tabular.build_items(pd.DataFrame({"sku": ["a", "b"]}))
    assert all(it.stock == 0 and it.case_qty == 1 for it in items)
