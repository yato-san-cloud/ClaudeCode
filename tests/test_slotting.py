"""Inventory slotting onto created locations (velocity/ABC)."""
import statistics

from whsim import slotting, templates
from whsim.engine.routing import manhattan


def test_abc_slotting_puts_fast_movers_near_pack():
    m = templates.load_template_model("ecommerce_small")
    s = slotting.assign_inventory(m, strategy="abc")
    assert s["assigned"] == min(len(m.items), len(m.locations))
    assert 0.0 <= s["fill_rate"] <= 1.0
    # every assigned location points back to a real SKU
    assert all(loc.sku for loc in m.locations[: s["assigned"]])

    st = m.resources.stations[0]
    ref = (st.x, st.y)
    by = m.item_by_sku()

    def avg(cls):
        ds = [manhattan(ref, (loc.x, loc.y)) for loc in m.locations
              if loc.sku and by[loc.sku].abc_class == cls]
        return statistics.fmean(ds) if ds else 0.0

    assert avg("A") < avg("B") < avg("C")  # velocity slotting gradient


def test_slotting_handles_more_skus_than_slots():
    m = templates.load_template_model("ecommerce_small")
    m.locations = m.locations[:10]   # far fewer slots than SKUs
    s = slotting.assign_inventory(m, strategy="abc")
    assert s["assigned"] == 10
    assert s["unassigned"] == len(m.items) - 10
