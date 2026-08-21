"""Generate the 'ecommerce_small' template (a fully filled-in canonical model).

Run once to (re)produce templates/ecommerce_small/template.json. Kept as a script
rather than hand-written JSON so the storage grid stays consistent and editable.
"""

import json
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "templates" / "ecommerce_small"

WIDTH, DEPTH = 60.0, 30.0

# Storage grid: rack columns along x, shelf slots along y.
COL_X = [x for x in range(16, 57, 4)]   # 11 columns
ROW_Y = [y for y in range(3, 28, 3)]    # 9 rows

PACK_X, PACK_Y = 6.0, 15.0


def build():
    zones = [
        {"id": "packing", "type": "packing", "x": 0, "y": 8, "w": 12, "h": 14,
         "color": "#9ecae1"},
        {"id": "shipping", "type": "shipping", "x": 0, "y": 0, "w": 12, "h": 8,
         "color": "#c7e9c0"},
        {"id": "receiving", "type": "receiving", "x": 0, "y": 22, "w": 12, "h": 8,
         "color": "#fdd0a2"},
        {"id": "storage", "type": "storage", "x": 14, "y": 1, "w": 45, "h": 28,
         "color": "#d9d9d9",
         "rack": {"col_spacing": 4.0, "row_spacing": 3.0, "margin": 2.0}},
    ]

    locations, items = [], []
    n = 0
    total = len(COL_X) * len(ROW_Y)
    for ci, x in enumerate(COL_X):
        for ri, y in enumerate(ROW_Y):
            sku = f"SKU{n:04d}"
            loc_id = f"L{n:04d}"
            # ABC by distance from packing: closer slots hold faster movers.
            dist = abs(x - PACK_X) + abs(y - PACK_Y)
            rank = dist / (WIDTH + DEPTH)
            if rank < 0.33:
                abc, freq, ts = "A", 6.0, 1.2
            elif rank < 0.66:
                abc, freq, ts = "B", 2.5, 1.5
            else:
                abc, freq, ts = "C", 1.0, 1.8
            locations.append({
                "id": loc_id, "zone": "storage", "x": float(x), "y": float(y),
                "type": "shelf", "capacity": 100, "sku": sku, "qty": 80,
            })
            items.append({
                "sku": sku, "name": f"Item {n}", "abc_class": abc,
                "pick_freq": freq, "ts_per_unit": ts, "case_qty": 12,
                "default_location": loc_id,
            })
            n += 1
    assert n == total

    model = {
        "meta": {
            "schema_version": "0.1",
            "name": "EC logistics / manual picking (small)",
            "units": {"length": "m", "time": "s", "weight": "kg"},
        },
        "layout": {"bounds": {"width": WIDTH, "depth": DEPTH}, "zones": zones},
        "locations": locations,
        "items": items,
        "process": {
            "flow": ["receive", "putaway", "pick", "pack", "ship"],
            "pick_strategy": "discrete",
            "routing_policy": "nearest",
            "batch_size": 1,
            "walk_speed_mps": 1.2,
            "pack_time_s": 40.0,
            "staging_capacity": 0,  # 仮置きバッファ容量(0=梱包兼任/既定, >0で専任packer本格モード)
        },
        "resources": {
            "workers": [{"id": "pickers", "role": "picker", "count": 6, "speed_mps": 1.2}],
            "equipment": [],
            "stations": [{"id": "pack", "zone": "packing", "x": PACK_X, "y": PACK_Y, "count": 3}],
        },
        "orders": {
            "outbound": [],
            "inbound": [],
            "profile": {"arrival": "poisson", "rate_per_hr": 120.0, "lines_per_order_mean": 3.0},
        },
        "simulation": {
            "duration_s": 28800.0, "warmup_s": 0.0, "random_seed": 42,
            "replications": 1, "heatmap_grid_m": 1.0,
        },
    }

    manifest = {
        "template_id": "ecommerce_small",
        "name": "EC物流・人手ピッキング (small)",
        "description": "小規模 EC 倉庫。人手シングルピッキング。提案ヒアリングの出発点。",
        # Which subtrees are normally filled from imported data vs salesperson interview.
        "subtree_source": {
            "meta": "interview", "layout": "data", "locations": "data",
            "items": "data", "process": "interview", "resources": "interview",
            "orders": "data", "simulation": "interview",
        },
        # The <=5 headline fields the salesperson confirms on the first screen.
        # `scale` lets the UI show a friendly unit (hours) while the schema keeps
        # SI (seconds); `choices` may carry {value,label} so no raw enums leak.
        "headline_fields": [
            {"path": "resources.workers.0.count", "label": "ピッカー人数", "type": "int",
             "unit": "名"},
            {"path": "orders.profile.rate_per_hr", "label": "出荷オーダー", "type": "float",
             "unit": "件/時"},
            {"path": "process.pick_strategy", "label": "ピッキング方式", "type": "choice",
             "choices": [
                 {"value": "discrete", "label": "シングルオーダー"},
                 {"value": "batch", "label": "マルチオーダー"},
                 {"value": "zone", "label": "ゾーン（リレー）"},
                 {"value": "wave", "label": "バッチ投入"},
             ]},
            {"path": "simulation.duration_s", "label": "稼働時間", "type": "float",
             "unit": "時間", "scale": 3600},
            {"path": "process.walk_speed_mps", "label": "歩行速度", "type": "float",
             "unit": "m/s"},
            {"path": "process.staging_capacity", "label": "仮置き容量(0=兼任)",
             "type": "int", "unit": "個"},
        ],
    }
    return model, manifest


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    model, manifest = build()
    (OUT / "template.json").write_text(
        json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"wrote {len(model['locations'])} locations to {OUT}")


if __name__ == "__main__":
    main()
