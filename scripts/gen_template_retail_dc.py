"""Generate the 'retail_dc' template — an abstracted retail / convenience-store
ambient distribution centre at proposal scale (~550 case-pick locations, the same
order of magnitude as a real chain DC layout).

Authored as a script (not hand-written JSON) so the storage grid, building shell
and SKU profile stay consistent. The model is fully synthetic: generic zone names,
generic SKUs, no customer identifiers — safe to ship as a public sample.

Run: ``python scripts/gen_template_retail_dc.py`` → templates/retail_dc/.

Domain shape (小売・コンビニ向け常温DC):
  入荷バース → 保管(ケースピッキング) → 流通加工 → 方面別仕分け(出荷待機) → 出荷バース
A retail DC is driven by 多頻度小口 (high-frequency, small-lot) store replenishment:
many store orders per wave, each a large number of case lines, picked 方面別
(by delivery route) in waves. That shape lives in the demand profile + process.
"""

import json
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "templates" / "retail_dc"

# Building envelope (m). ~108 x 60 ≈ 6,500 m² — a mid-size ambient chain DC.
WIDTH, DEPTH = 108.0, 60.0

# Case-pick storage grid: rack columns along x, shelf slots along y. The grid is
# authored to MATCH the storage zone's rack fill (col 4m / row 2m / margin 2m over
# the x16..106 × y1..59 zone) so re-materialising never jumps the count. Lands at
# 22 × 28 = 616 case-pick locations — chain-DC proposal scale.
COL_X = list(range(18, 105, 4))   # 18,22,…,104  → 22 columns (aisles)
ROW_Y = list(range(3, 58, 2))     # 3,5,…,57     → 28 slots per column

# Reference point (流通加工/仕分け side) for ABC: closer slots hold faster movers.
REF_X, REF_Y = 8.0, 30.0


def build():
    zones = [
        # 入荷バース (receiving docks, left-top).
        {"id": "receiving", "type": "receiving", "x": 0, "y": 34, "w": 14, "h": 24,
         "color": "#fdd0a2"},
        # 流通加工 (value-added processing / labelling) — packing stage.
        {"id": "processing", "type": "packing", "x": 0, "y": 18, "w": 14, "h": 16,
         "color": "#9ecae1"},
        # 出荷バース (shipping docks, left-bottom).
        {"id": "shipping", "type": "shipping", "x": 0, "y": 0, "w": 14, "h": 10,
         "color": "#c7e9c0"},
        # 方面別仕分け・出荷待機 (route sortation / ship staging).
        {"id": "sortation", "type": "staging", "x": 0, "y": 10, "w": 14, "h": 8,
         "color": "#dadaeb"},
        # 保管・ケースピッキング (the bulk: case-pick shelving across the floor).
        {"id": "storage", "type": "storage", "x": 16, "y": 1, "w": 90, "h": 58,
         "color": "#d9d9d9",
         "rack": {"col_spacing": 4.0, "row_spacing": 2.0, "margin": 2.0}},
    ]

    # Rectangular building shell (躯体) + dock doors, so the editor shows a real DC.
    walls = [{
        "id": "shell",
        "points": [[0, 0], [WIDTH, 0], [WIDTH, DEPTH], [0, DEPTH], [0, 0]],
        "thickness": 0.3,
    }]
    doors = (
        [{"id": f"in{i}", "type": "dock", "x": 0.0, "y": 36.0 + i * 4.0, "w": 3.0}
         for i in range(5)]                                     # 入荷5バース
        + [{"id": f"out{i}", "type": "dock", "x": 0.0, "y": 1.5 + i * 3.0, "w": 3.0}
           for i in range(3)]                                   # 出荷3バース
    )

    locations, items = [], []
    n = 0
    for x in COL_X:
        for y in ROW_Y:
            sku = f"SKU{n:05d}"
            loc_id = f"L{n:05d}"
            dist = abs(x - REF_X) + abs(y - REF_Y)
            rank = dist / (WIDTH + DEPTH)
            if rank < 0.33:
                abc, freq, ts, case = "A", 9.0, 1.1, 24
            elif rank < 0.66:
                abc, freq, ts, case = "B", 3.5, 1.4, 16
            else:
                abc, freq, ts, case = "C", 1.2, 1.7, 12
            locations.append({
                "id": loc_id, "name": f"{chr(65 + (n // 100) % 26)}-{n % 100:02d}",
                "zone": "storage", "x": float(x), "y": float(y),
                "type": "shelf", "rack_type": "flow" if abc == "A" else "medium",
                "capacity": 120, "sku": sku, "qty": 90,
            })
            items.append({
                "sku": sku, "name": f"商品 {n}", "abc_class": abc,
                "pick_freq": freq, "ts_per_unit": ts, "case_qty": case,
                "default_location": loc_id,
            })
            n += 1

    model = {
        "meta": {
            "schema_version": "0.1",
            "name": "小売DC・常温 (チェーン店向け・大規模)",
            "units": {"length": "m", "time": "s", "weight": "kg"},
        },
        "layout": {"bounds": {"width": WIDTH, "depth": DEPTH},
                   "zones": zones, "walls": walls, "doors": doors},
        "locations": locations,
        "items": items,
        "process": {
            # 多頻度小口・方面別ウェーブ: store orders picked in route waves.
            "flow": ["receive", "putaway", "pick", "pack", "ship"],
            # Stages bound to THIS layout's zone ids so the 連鎖 check is clean:
            # pick on the case-pick 保管 floor, pack at 流通加工.
            "stages": [
                {"id": "receive", "label": "入荷", "method": "manual", "zone": "receiving"},
                {"id": "putaway", "label": "格納", "method": "manual", "zone": "storage"},
                {"id": "pick", "label": "ピッキング", "method": "manual", "zone": "storage"},
                {"id": "pack", "label": "流通加工", "method": "manual", "zone": "processing"},
                {"id": "ship", "label": "出荷", "method": "manual", "zone": "shipping"},
            ],
            "pick_strategy": "wave",
            "routing_policy": "nearest",
            "batch_size": 8,            # 1ウェーブ=方面の店舗をまとめ摘み
            "walk_speed_mps": 1.2,
            "pack_time_s": 25.0,
            "staging_capacity": 240,    # 方面別の出荷待機バッファ
        },
        "resources": {
            "workers": [{"id": "pickers", "role": "picker", "count": 18, "speed_mps": 1.2}],
            # リーチフォーク for 入荷格納・補充 (reserve replenishment).
            "equipment": [{"id": "forklifts", "type": "forklift", "count": 3, "speed_mps": 1.8}],
            "stations": [{"id": "processing", "zone": "processing", "x": 7.0, "y": 26.0, "count": 4}],
        },
        "orders": {
            "outbound": [],
            "inbound": [],
            # Realistic chain DC: ~150 stores × a few route deliveries/day → ~45
            # store-orders/hr over the shift, each a large case order, with an
            # AM/PM wave peak. Tight-but-workable at the default headcount.
            "profile": {"arrival": "poisson", "rate_per_hr": 45.0,
                        "lines_per_order_mean": 35.0, "peak_factor": 1.5},
        },
        "simulation": {
            "duration_s": 28800.0, "warmup_s": 0.0, "random_seed": 42,
            "replications": 1, "heatmap_grid_m": 1.0,
        },
    }

    manifest = {
        "template_id": "retail_dc",
        "name": "小売DC・常温 (チェーン店向け・大規模)",
        "description": ("コンビニ・小売チェーン向けの常温DC。多頻度小口・方面別ウェーブ"
                        "ピッキング、フォークによる補充。提案規模(~600間口)の大型レイアウト。"),
        "subtree_source": {
            "meta": "interview", "layout": "data", "locations": "data",
            "items": "data", "process": "interview", "resources": "interview",
            "orders": "data", "simulation": "interview",
        },
        "headline_fields": [
            {"path": "resources.workers.0.count", "label": "ピッカー人数", "type": "int",
             "unit": "名"},
            {"path": "resources.equipment.0.count", "label": "フォーク台数", "type": "int",
             "unit": "台"},
            {"path": "orders.profile.rate_per_hr", "label": "出荷オーダー", "type": "float",
             "unit": "件/時"},
            {"path": "orders.profile.peak_factor", "label": "ピーク係数", "type": "float",
             "unit": "倍"},
            {"path": "process.pick_strategy", "label": "ピッキング方式", "type": "choice",
             "choices": [
                 {"value": "discrete", "label": "都度ピック"},
                 {"value": "batch", "label": "バッチ"},
                 {"value": "zone", "label": "ゾーン"},
                 {"value": "wave", "label": "ウェーブ"},
             ]},
            {"path": "simulation.duration_s", "label": "稼働時間", "type": "float",
             "unit": "時間", "scale": 3600},
        ],
    }
    return model, manifest


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    model, manifest = build()
    (OUT / "template.json").write_text(
        json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {len(model['locations'])} locations to {OUT}")


if __name__ == "__main__":
    main()
