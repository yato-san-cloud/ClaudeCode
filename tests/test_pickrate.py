"""生産性試算 — 解析的(動作時間)ピッキング生産性."""
import pytest

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


# --- aisle-routed travel ----------------------------------------------------

def test_travel_is_routed_through_the_aisles_not_across_the_racking():
    """The BHH term alone prices free movement in a rectangle — a picker gliding
    diagonally through the shelving. It cannot.

    Measured before this: retail_dc's 生産性試算 claimed 127 m/order of travel
    against a DES that walks 945. 生産性試算 is adopted straight into the
    productivity stack, so it was selling a rate the DES could never confirm.
    """
    from whsim import rackgeom, templates

    m = templates.load_template_model("retail_dc")
    det = rackgeom.aisle_detour(m, (m.resources.stations[0].x, m.resources.stations[0].y))
    assert det, "the fixture must draw racking"

    rows = {r["id"]: r for r in pickrate.estimate_pickrate(m)["methods"]}
    # A single-order trip is depot -> picks -> depot, so it must carry at least
    # the two depot detours the aisle network imposes.
    assert rows["discrete"]["travel_per_order_m"] > 2.0 * det["depot_extra_m"]


def test_aisle_correction_only_lengthens_travel():
    """Routing around racking can only ADD metres — pin the sign, per method."""
    from whsim import templates
    from whsim.schema.model import Layout, Zone

    m = templates.load_template_model("ecommerce_small")
    with_racks = {r["id"]: r["travel_per_order_m"]
                  for r in pickrate.estimate_pickrate(m)["methods"]}

    # Same footprint, racking removed: the historical open-area behaviour.
    bare = m.model_copy(deep=True)
    bare.locations = []
    bare.layout = Layout(bounds=m.layout.bounds,
                         zones=[Zone(id=z.id, type=z.type, x=z.x, y=z.y, w=z.w, h=z.h)
                                for z in m.layout.zones])
    without = {r["id"]: r["travel_per_order_m"]
               for r in pickrate.estimate_pickrate(bare)["methods"]}

    assert set(with_racks) == set(without)
    for mid in with_racks:
        assert with_racks[mid] >= without[mid], f"{mid}: aisles made travel shorter"
    assert any(with_racks[mid] > without[mid] for mid in with_racks)


def test_zone_relay_pays_the_full_run_length():
    """ゾーン is a serpentine: an aisle it enters is run end to end (ℓ), where a
    nearest-neighbour tour only dips in (ℓ/3). Checked exactly, not by vibes."""
    import math

    from whsim import rackgeom, templates

    m = templates.load_template_model("ecommerce_small")
    st = m.resources.stations[0]
    det = rackgeom.aisle_detour(m, (st.x, st.y))
    out = pickrate.estimate_pickrate(m)
    rows = {r["id"]: r for r in out["methods"]}
    lpo = out["geometry"]["lines_per_order"]
    area = out["geometry"]["pick_area_m2"]
    depot = out["geometry"]["depot_dist_m"]
    kk = pickrate.DEFAULTS["tour_constant"]

    z = rows["zone"]
    n_picks = z["orders_per_trip"] * lpo
    changes = min(n_picks - 1.0, det["n_aisles"] - 1.0)
    base = (kk * math.sqrt(n_picks * area)
            + 2.0 * (depot + det["depot_extra_m"]))
    serpentine = base + changes * det["run_len_m"]
    nearest = base + changes * det["hop_extra_m"]

    trip = z["travel_per_order_m"] * z["orders_per_trip"]
    assert trip == pytest.approx(serpentine, rel=0.02)
    # ...and that is materially more than the same trip priced as a NN tour.
    assert serpentine > nearest * 1.2
