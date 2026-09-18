"""Perf guard for the採点表 (scorecard): it is recomputed on EVERY designer edit
(the live POST path), so a super-linear regression would make dragging a shelf
janky. Not a microbenchmark — a generous cliff guard (measured ~85ms at this
scale on the reference machine; budget 2s catches order-of-magnitude blow-ups)."""
import random
import time

from whsim import scorecard, templates
from whsim.schema.model import Item, Order, OrderLine, ShelfArea, Zone


def _big_model():
    m = templates.load_template_model("ecommerce_small")
    random.seed(7)
    skus = [f"S{i:04d}" for i in range(200)]
    m.items = [Item(sku=s, name=s, case_qty=12) for s in skus]
    m.orders.outbound = [
        Order(order_id=f"O{i}", arrival_s=float(i * 20),
              lines=[OrderLine(sku=random.choice(skus), qty=random.randint(1, 5))
                     for _ in range(random.randint(1, 4))])
        for i in range(5000)
    ]
    z = Zone(id="st", type="storage", x=2, y=2, w=80, h=40)
    z.shelves = [ShelfArea(id=f"s{i}", x=4 + (i % 40) * 1.5, y=4 + (i // 40) * 1.0,
                           w=1.2, h=0.6, rack_type="medium") for i in range(600)]
    m.layout.zones = [z, Zone(id="pk", type="packing", x=0, y=0, w=8, h=6)]
    return m


def test_scorecard_stays_interactive_at_scale():
    m = _big_model()
    card = scorecard.build_scorecard(m)        # warm + correctness
    assert len(card["rows"]) == 6
    t = time.perf_counter()
    for _ in range(5):
        scorecard.build_scorecard(m)
    per_call = (time.perf_counter() - t) / 5
    # live-on-edit must stay well under the 250ms debounce window; budget is a
    # generous 2s so only an order-of-magnitude cliff trips CI.
    assert per_call < 2.0, f"scorecard too slow: {per_call * 1000:.0f} ms/call"
