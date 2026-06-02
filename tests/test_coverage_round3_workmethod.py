"""Round-3 coverage: workmethod naming/explain/recommend across the axis space.

`whsim.workmethod` is the pure bridge between the 5 orthogonal axes
(`schema.WorkMethod`) and the familiar named picking methods. These tests walk the
naming branches deliberately, exercise `explain` and `legacy_strategy`, and drive
`recommend` through each of its rule-of-thumb arms by shaping the order profile.
"""

from __future__ import annotations

from whsim import templates, workmethod
from whsim.schema.model import (
    Item,
    Order,
    OrderLine,
    WarehouseModel,
    WorkMethod,
)


# ---- method_name: every branch ------------------------------------------------

def test_method_name_transport_variants():
    assert "AGV" in workmethod.method_name(WorkMethod(transport="agv"))
    assert workmethod.method_name(WorkMethod(transport="conveyor")) == "コンベア搬送"
    assert "自動倉庫" in workmethod.method_name(WorkMethod(transport="asrs"))


def test_method_name_sort_family():
    base = workmethod.method_name(WorkMethod(consolidation="sort"))
    assert "種まき" in base
    waved = workmethod.method_name(WorkMethod(consolidation="sort", release="wave"))
    assert waved == base + "＋ウェーブ"


def test_method_name_zoning_and_release():
    assert "並列" in workmethod.method_name(WorkMethod(zoning="parallel"))
    assert "リレー" in workmethod.method_name(WorkMethod(zoning="sequential"))
    assert workmethod.method_name(WorkMethod(release="wave")) == "ウェーブピッキング"


def test_method_name_multi_and_single_order():
    assert "マルチオーダー" in workmethod.method_name(WorkMethod(orders_per_trip=4))
    assert workmethod.method_name(WorkMethod()) == "シングルオーダー（摘み取り都度）"


# ---- explain ------------------------------------------------------------------

def test_explain_manual_single_order():
    text = workmethod.explain(WorkMethod())
    assert "人が歩いて採る" in text
    assert "1オーダーずつ" in text
    assert text.endswith("。")


def test_explain_covers_all_clauses():
    work = WorkMethod(transport="agv", orders_per_trip=5, zoning="parallel",
                      consolidation="sort", release="wave", wave_interval_s=600)
    text = workmethod.explain(work)
    assert "物が作業者に来る" in text
    assert "5オーダー" in text
    assert "並列" in text
    assert "種まき" in text
    assert "10分の波" in text  # 600s / 60 == 10 min


def test_explain_sequential_zoning_clause():
    assert "順に受け渡し" in workmethod.explain(WorkMethod(zoning="sequential"))


# ---- legacy_strategy ----------------------------------------------------------

def test_legacy_strategy_mapping():
    assert workmethod.legacy_strategy(WorkMethod(release="wave")) == "wave"
    assert workmethod.legacy_strategy(WorkMethod(zoning="parallel")) == "zone"
    assert workmethod.legacy_strategy(WorkMethod(orders_per_trip=3)) == "batch"
    assert workmethod.legacy_strategy(WorkMethod(consolidation="sort")) == "batch"
    assert workmethod.legacy_strategy(WorkMethod()) == "discrete"


# ---- recommend: each rule-of-thumb arm ---------------------------------------

def _model_with_orders(orders: list[Order], items: list[Item] | None = None) -> WarehouseModel:
    m = WarehouseModel()
    m.orders.outbound = orders
    if items is not None:
        m.items = items
    return m


def _order(n_lines: int, sku_pool: int) -> Order:
    lines = [OrderLine(sku=f"S{i % sku_pool}", qty=1) for i in range(n_lines)]
    return Order(order_id="o", lines=lines)


def test_recommend_few_skus_many_lines_picks_sort():
    # few distinct SKUs, many lines per order, few destinations -> 種まき (sort)
    items = [Item(sku=f"S{i}") for i in range(10)]
    orders = [_order(6, sku_pool=10) for _ in range(20)]
    rec = _model_with_orders(orders, items)
    r = workmethod.recommend(rec)
    assert r.work.consolidation == "sort"
    assert "種まき" in r.name
    assert "少品種" in r.reason


def test_recommend_high_destination_volume_picks_wave_batch():
    items = [Item(sku=f"S{i}") for i in range(500)]
    orders = [_order(2, sku_pool=500) for _ in range(350)]  # dest=350 >= 300
    r = workmethod.recommend(_model_with_orders(orders, items))
    assert r.work.release == "wave"
    assert r.work.orders_per_trip >= 2
    assert "出荷先が多い" in r.reason


def test_recommend_many_skus_low_lines_picks_multiorder():
    items = [Item(sku=f"S{i}") for i in range(200)]
    # modest dest count, low lines/order, not few-sku -> multi-order cart
    orders = [_order(2, sku_pool=200) for _ in range(60)]
    r = workmethod.recommend(_model_with_orders(orders, items))
    assert r.work.orders_per_trip == 4
    assert "マルチオーダー" in r.name


def test_recommend_default_single_order():
    items = [Item(sku=f"S{i}") for i in range(200)]
    # many SKUs, mid dest, lines/order=3 (between thresholds) -> default single
    orders = [_order(3, sku_pool=200) for _ in range(60)]
    r = workmethod.recommend(_model_with_orders(orders, items))
    assert r.work == WorkMethod()
    assert "堅実" in r.reason


def test_recommend_falls_back_to_profile_without_orders():
    # No explicit outbound orders: must use the fallback profile, never crash.
    m = templates.load_template_model("ecommerce_small")
    m.orders.outbound = []
    r = workmethod.recommend(m)
    assert isinstance(r.name, str) and r.name
    assert r.work.model_dump()  # a valid WorkMethod


def test_recommendation_to_dict_roundtrips():
    r = workmethod.recommend(templates.load_template_model("ecommerce_small"))
    d = r.to_dict()
    assert set(d) == {"work", "name", "reason"}
    assert WorkMethod.model_validate(d["work"]) == r.work
