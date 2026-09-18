"""Generate a sample customer ZIP (examples/acme_upload.zip) for demos/manual testing.

Mimics what the separate data-analysis tool would hand over: a ZIP of JSON files,
each a subset of the canonical schema. Includes a deliberately broken file and a
non-JSON file to demonstrate the importer's tolerance.
"""

import json
import random
import zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "examples"


def main(seed: int = 1, n_orders: int = 2000):
    rng = random.Random(seed)
    OUT.mkdir(exist_ok=True)

    orders = []
    for i in range(n_orders):
        lines = [
            {"sku": f"SKU{rng.randint(0, 98):04d}", "qty": rng.randint(1, 3)}
            for _ in range(rng.randint(1, 5))
        ]
        orders.append({"order_id": f"O{i:05d}", "arrival_s": rng.uniform(0, 28800),
                       "due_s": 28800, "lines": lines})

    items = [
        {"sku": f"SKU{i:04d}", "name": f"Real Item {i}",
         "abc_class": "A" if i < 20 else ("B" if i < 55 else "C"),
         "pick_freq": 6.0 if i < 20 else (2.0 if i < 55 else 1.0),
         "ts_per_unit": 2.0, "case_qty": 12,
         "stock": (480 if i < 20 else (200 if i < 55 else 60)),  # on-hand inventory
         "default_location": f"L{i:04d}"}
        for i in range(99)
    ]

    zpath = OUT / "acme_upload.zip"
    with zipfile.ZipFile(zpath, "w") as z:
        z.writestr("outbound.json", json.dumps(orders))
        z.writestr("product_master.json", json.dumps(items))
        z.writestr("garbage.txt", "not json, should be ignored")
        z.writestr("broken.json", "{not valid json")
    print(f"wrote {zpath} ({zpath.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
