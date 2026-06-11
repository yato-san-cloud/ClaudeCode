"""生産性試算 — 解析的(動作時間)ピッキング生産性."""
from whsim import pickrate, templates
from whsim.schema.model import Order, OrderLine, ShelfArea, Zone


def _model_with_storage():
    m = templates.load_template_model("ecommerce_small")
    # a concrete storage zone with shelves so the pick area is real
    z = Zone(id="st", type="storage", x=10, y=2, w=30, h=20)
    z.shelves = [ShelfArea(id=f"s{i}", x=12 + i * 2, y=4, w=1.2, h=0.6, rack_type="medium")
                 for i in range(8)]
    m.layout.zones = [z, Zone(id="pk", type="packing", x=0, y=0, w=8, h=6)]
    m.orders.outbound = [
        Order(order_id=f"O{i}", arrival_s=float(i * 50 + 30000),
              lines=[OrderLine(sku="A", qty=1), OrderLine(sku="B", qty=2)])
        for i in range(40)
    ]
    return m


def test_all_methods_estimated_and_monotone_batching():
    m = _model_with_storage()
    r = pickrate.estimate_pickrate(m)
    ids = {x["id"] for x in r["methods"]}
    assert ids == {"discrete", "multi", "zone", "total"}
    by = {x["id"]: x for x in r["methods"]}
    # batching amortises the tour → multi walks less PER ORDER than discrete.
    assert by["multi"]["travel_per_order_m"] < by["discrete"]["travel_per_order_m"]
    # 種まき(total) is the travel-minimiser but the ONLY one with sort effort.
    assert by["total"]["travel_per_order_m"] <= by["multi"]["travel_per_order_m"]
    assert by["total"]["sort_per_order_s"] > 0
    assert by["discrete"]["sort_per_order_s"] == 0
    # productivity is positive and the recommendation is the fastest line rate.
    assert all(x["lines_per_hour"] > 0 for x in r["methods"])
    best = max(r["methods"], key=lambda x: x["lines_per_hour"])
    assert r["recommend_id"] == best["id"]


def test_geometry_drives_travel():
    # a BIGGER pick area ⇒ longer tours ⇒ lower lines/hour (layout matters).
    small = _model_with_storage()
    big = _model_with_storage()
    big.layout.zones[0].w = 90
    big.layout.zones[0].h = 60
    rs = pickrate.estimate_pickrate(small)
    rb = pickrate.estimate_pickrate(big)
    sd = {x["id"]: x for x in rs["methods"]}["discrete"]
    bd = {x["id"]: x for x in rb["methods"]}["discrete"]
    assert bd["travel_per_order_m"] > sd["travel_per_order_m"]
    assert bd["lines_per_hour"] < sd["lines_per_hour"]


def test_never_blocks_on_bare_model():
    m = templates.load_template_model("ecommerce_small")
    m.layout.zones = []
    m.orders.outbound = []
    r = pickrate.estimate_pickrate(m)
    assert r["has_layout"] is False
    assert len(r["methods"]) == 4
    assert all(x["lines_per_hour"] > 0 for x in r["methods"])
