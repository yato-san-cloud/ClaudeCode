from whsim import templates
from whsim.schema import WarehouseModel


def test_empty_model_is_valid_and_runnable_defaults():
    # An empty model must validate -- this is the "always runs" guarantee.
    m = WarehouseModel()
    assert m.simulation.duration_s > 0
    assert m.resources.workers  # default picker group exists


def test_template_loads_and_validates():
    ids = [t["template_id"] for t in templates.list_templates()]
    assert "ecommerce_small" in ids
    m = templates.load_template_model("ecommerce_small")
    assert len(m.locations) == 99
    assert len(m.items) == 99
    assert m.item_by_sku()["SKU0000"].abc_class in {"A", "B", "C"}
