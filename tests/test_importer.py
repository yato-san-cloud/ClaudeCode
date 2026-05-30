import io
import json
import zipfile

from whsim import templates
from whsim.importer import import_bytes


def _zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, content in files.items():
            z.writestr(name, content)
    return buf.getvalue()


def test_partial_and_broken_import_still_yields_runnable_model():
    tmpl = templates.load_template_dict("ecommerce_small")
    orders = [{"order_id": "O1", "arrival_s": 0, "lines": [{"sku": "SKU0000", "qty": 1}]}]
    zb = _zip({
        "outbound.json": json.dumps(orders),
        "broken.json": "{not valid",        # must be skipped, not fatal
        "notes.txt": "ignored, not json",    # non-json ignored
    })
    res = import_bytes(tmpl, zb)
    # broken file recorded as a warning, bundle not rejected
    assert any("broken.json" in w for w in res.warnings)
    assert "orders" in res.touched_subtrees
    # the merged model still validates and kept template locations/items
    assert len(res.model.locations) == 99
    assert res.model.orders.outbound[0].order_id == "O1"


def test_product_master_overwrites_items_subtree():
    tmpl = templates.load_template_dict("ecommerce_small")
    items = [{"sku": "SKU0000", "name": "Real", "ts_per_unit": 9.9,
              "abc_class": "A", "default_location": "L0000"}]
    res = import_bytes(tmpl, _zip({"product_master.json": json.dumps(items)}))
    assert "items" in res.touched_subtrees
    assert len(res.model.items) == 1
    assert res.model.items[0].ts_per_unit == 9.9
