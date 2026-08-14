"""Generate the 'line_inspection' template — ライン検品・コンベア搬送.

A mid-size mail-order (EC) shipping line whose defining move is that **inspection
happens ON the conveyor**: goods are sorted to chutes, land on two free-roller
inspection rows, and are checked where they lie (a partition splits 検品前 from
検品後). Inspected containers join the LOWER deck of a two-tier driven trunk; five
引き込み (pull-off spurs) on both sides of it feed twenty 縦長 packing benches, and
a 停止線 near the trunk's end holds anything not yet packed while finished cartons
carry on round the curve to 積み付け. The upper deck returns empty containers.

Fully synthetic and customer-neutral: generic zone ids, generic SKUs, dimensions
designed from scratch for a 48 × 30 m building. Authored as a script (not
hand-written JSON) so the rack grid, the belt polylines and the bench line stay
consistent with each other — rerun it and the template is reproduced byte for byte.

Run: ``python scripts/gen_template_line_inspection.py`` → templates/line_inspection/.

How the shape maps onto whsim's engine (and what it does NOT claim)
-------------------------------------------------------------------
* The DES models the two capacitated stages this pattern lives or dies by: the
  **belt** (a tote holds a slot from hand-off until packing finishes, so a slow
  bench line backs the line up) and the **20 benches**. Each bench is its own
  ``Station`` — the form the layout editor writes — with its real 0.9 × 1.4 m
  footprint so the 3D draws the line the way it is built, benches long-side-on to
  their spur with the operator in the 0.6 m gap between bench and belt.
* The line inspection itself is the belt DWELL: the inspection rows are authored
  slow (0.35 m/s) because that transit IS the check. No inspector agent is
  simulated — the 人員タイムチャート staffs 「ライン検品」 from the work-process
  master instead, which is where a non-simulated stage belongs.
* ``_board_conveyor`` hands a picker's totes to the belt whose path runs nearest,
  so the row adjacent to the picking floor takes the hand-off and the rest of the
  system (trunk, spurs, return deck) is drawn geometry that the flow graph routes
  through. Every drawn belt IS named by a ``flow_edge``, so the engine and the
  closed-form oracle see the SAME set of belts (``flowgraph.conveyor_ids_in_use``
  gates the engine; ``analytic._belt_access`` reads them all).
"""

import json
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "templates" / "line_inspection"

# Building envelope (m). 48 x 30 = 1,440 m² — a mid-size EC shipping centre.
WIDTH, DEPTH = 48.0, 30.0

# --- storage: vertical rack runs, aisles along y, pick faces onto the line ----
# The zone's rack fill is authored to MATCH this grid exactly (col 3.5 / row 1.0 /
# margin 0.75 over x9..45.5 × y12..28), so re-materialising never moves a slot.
# 3.5 m of pitch leaves ~2.0 m aisles — walkable AND driveable, since the same
# aisles take pallet putaway from the docks.
COL_X = [9.75 + 3.5 * i for i in range(11)]      # 9.75 … 44.75 → 11 aisles
ROW_Y = [12.75 + 1.0 * j for j in range(15)]     # 12.75 … 26.75 → 15 bays each

# --- the packing line ---------------------------------------------------------
TRUNK_Y = 4.0                      # 本線 (2段駆動コンベアの下段) centre-line
TRUNK_X0, TRUNK_X1 = 10.5, 44.5    # discharge (停止線側) … infeed (検品ライン合流)
SPUR_X = [12.5, 19.5, 26.5, 33.5, 40.5]   # 引き込み 5ヶ所, 7.0 m apart
SPUR_REACH = 2.6                   # how far a spur pulls off the trunk (両側)
BENCH_W, BENCH_D = 0.9, 1.4        # 梱包台: 縦長 — long side parallel to the spur
BENCH_OFFSET = 1.35                # bench centre from the spur (⇒ 0.6 m 立ち位置)
INSPECT_Y = (10.4, 8.8)            # ライン検品 2列 (フリーコンベア)
INSPECT_X0 = 10.0
INSPECT_SPEED = 0.35               # 遅いのが仕様: この滞留時間が検品そのもの
TRUNK_SPEED = 0.5
# 折りたたみコンテナ ~0.53 × 0.37 m。ベルト上の1個分ピッチ＝スロット密度（≒滞留
# 容量）で、未指定の歴史既定 1個/m は 2.6 m の引き込みを「2枠」と数えてバッファを
# ほぼゼロに見せる（詰まりを早く言い過ぎる）。容器は本線→引き込みで向きを変えずに
# 滑るだけで、進行軸のほうが 90° 回る — だから本線・検品ライン（長辺リード）と
# 引き込み（短辺リード）でピッチが違うのは仕様であって不揃いではない。
TOTE_PITCH_LONG = 0.6              # 本線・検品ライン: 長辺 0.53 ＋ 隙間
TOTE_PITCH_SHORT = 0.45            # 引き込み: 短辺 0.37 ＋ 隙間
DECK_LOW, DECK_HIGH = 0.35, 0.95   # 2段駆動コンベアのトレッド高さ (下段 / 上段)


def _zones() -> list[dict]:
    return [
        # 入荷バース (west wall).
        {"id": "receiving", "type": "receiving", "x": 0, "y": 17, "w": 8, "h": 13,
         "color": "#fdd0a2"},
        # 出荷・積み付け (west wall, south): where the curve off the trunk lands.
        {"id": "shipping", "type": "shipping", "x": 0, "y": 0, "w": 8, "h": 8,
         "color": "#c7e9c0"},
        # 保管・ピッキング: vertical rack runs filling the north half.
        {"id": "storage", "type": "storage", "x": 9, "y": 12, "w": 36.5, "h": 16,
         "color": "#d9d9d9",
         "rack": {"col_spacing": 3.5, "row_spacing": 1.0, "margin": 0.75}},
        # 仕分けシュート: the chute bank discharging onto the inspection rows.
        {"id": "sortation", "type": "staging", "x": 9, "y": 11.0, "w": 36.5, "h": 1.0,
         "color": "#dadaeb"},
        # ライン検品: the two free-roller rows + the lane the inspectors work from.
        {"id": "inspection", "type": "staging", "x": 9, "y": 7.4, "w": 36.5, "h": 3.6,
         "color": "#bcbddc"},
        # 梱包: the trunk, the five 引き込み and the twenty benches.
        {"id": "packing", "type": "packing", "x": 8, "y": 0.6, "w": 38, "h": 6.8,
         "color": "#9ecae1"},
    ]


def _walls_doors() -> tuple[list[dict], list[dict]]:
    walls = [{
        "id": "shell",
        "points": [[0, 0], [WIDTH, 0], [WIDTH, DEPTH], [0, DEPTH], [0, 0]],
        "thickness": 0.3,
    }]
    doors = (
        [{"id": f"in{i}", "type": "dock", "x": 0.0, "y": 18.5 + i * 3.0, "w": 3.0}
         for i in range(4)]                                      # 入荷4バース
        + [{"id": f"out{i}", "type": "dock", "x": 0.0, "y": 1.5 + i * 3.0, "w": 3.0}
           for i in range(2)]                                    # 出荷2バース
    )
    return walls, doors


def _conveyors() -> list[dict]:
    """The whole transport chain as authored polylines (infeed → discharge).

    ``points[-1]`` is the discharge end, which is what a tote rides to, so each
    line is drawn in the direction goods actually travel: the inspection rows run
    east and drop onto the head of the trunk; the trunk runs west past the five
    引き込み to the 停止線 and curves away to 積み付け; the upper deck runs back east
    with the empty containers.
    """
    out: list[dict] = []
    # ライン検品 2列 — the row nearer the picking floor takes the hand-off; both
    # merge onto the trunk head (at slightly different points, as they must).
    for n, (y, x_end) in enumerate(zip(INSPECT_Y, (TRUNK_X1, 43.2)), start=1):
        out.append({
            "id": f"insp{n}",
            "points": [[INSPECT_X0, y], [x_end, y], [x_end, TRUNK_Y]],
            "speed_mps": INSPECT_SPEED,
            "tote_pitch_m": TOTE_PITCH_LONG,
            "elevation_m": DECK_LOW,
        })
    # 本線 (下段): the trunk, its 停止線 at the west end of the bench run, then the
    # curve out to 積み付け in the shipping zone.
    out.append({
        "id": "trunk_low",
        "points": [[TRUNK_X1, TRUNK_Y], [TRUNK_X0 + 0.9, TRUNK_Y], [9.6, 4.35],
                   [8.4, 5.0], [6.8, 5.6], [5.0, 5.6]],
        "speed_mps": TRUNK_SPEED,
        "tote_pitch_m": TOTE_PITCH_LONG,
        "elevation_m": DECK_LOW,
    })
    # 上段: the empty containers going back to the chute end over the same
    # footprint. Only `elevation_m` separates the two decks — in plan they ARE the
    # same line, which is the point of a two-tier conveyor.
    out.append({
        "id": "trunk_up",
        "points": [[TRUNK_X0 + 0.9, TRUNK_Y], [TRUNK_X1, TRUNK_Y]],
        "speed_mps": TRUNK_SPEED,
        "tote_pitch_m": TOTE_PITCH_LONG,
        "elevation_m": DECK_HIGH,
    })
    # 引き込みコンベア 5ヶ所 × 両側: pulled off the trunk to each bench pair.
    for i, x in enumerate(SPUR_X, start=1):
        out.append({"id": f"spur{i}n", "points": [[x, TRUNK_Y], [x, TRUNK_Y + SPUR_REACH]],
                    "speed_mps": 0.3, "tote_pitch_m": TOTE_PITCH_SHORT,
                    "elevation_m": DECK_LOW})
        out.append({"id": f"spur{i}s", "points": [[x, TRUNK_Y], [x, TRUNK_Y - SPUR_REACH]],
                    "speed_mps": 0.3, "tote_pitch_m": TOTE_PITCH_SHORT,
                    "elevation_m": DECK_LOW})
    return out


def _stations() -> list[dict]:
    """20 縦長 benches — four per 引き込み (両側 × 左右), each its own Station.

    One entry per bench is the form the layout editor writes, and it is the only
    way the 3D can draw the line: a bench's long side has to run parallel to its
    spur or the operators end up standing at the wrong edge of the desk.
    """
    out: list[dict] = []
    for i, x in enumerate(SPUR_X, start=1):
        for side, sign in (("n", 1), ("s", -1)):
            y = TRUNK_Y + sign * (SPUR_REACH - BENCH_D / 2.0)
            for hand, dx in (("L", -BENCH_OFFSET), ("R", BENCH_OFFSET)):
                out.append({"id": f"pack{i}{side}{hand}", "zone": "packing",
                            "x": round(x + dx, 3), "y": round(y, 3),
                            "count": 1, "w": BENCH_W, "d": BENCH_D})
    return out


def _work_processes() -> list[dict]:
    """The editable work-process master — the ONE flow graph's nodes.

    ``role`` maps each freely-named process onto the engine behaviour it drives
    (``ライン検品`` deliberately maps to a NON-engine role: it is staffed and costed,
    but the DES prices it as the belt dwell, not as an agent).
    """
    return [
        {"id": "入荷検品", "section": "入荷", "driver": "in_lines", "prod": 45,
         "unit": "行/h", "depends": [], "role": "receive", "zone": "receiving"},
        {"id": "格納", "section": "入荷", "driver": "in_qty", "prod": 130,
         "unit": "点/h", "depends": ["入荷検品"], "role": "putaway", "zone": "storage"},
        {"id": "ピッキング", "section": "出荷", "driver": "out_lines", "prod": 105,
         "unit": "行/h", "depends": ["格納"], "role": "pick", "zone": "storage"},
        {"id": "ライン検品", "section": "出荷", "driver": "out_lines", "prod": 190,
         "unit": "行/h", "depends": ["ピッキング"], "role": "inspect", "zone": "inspection"},
        {"id": "梱包", "section": "出荷", "driver": "out_orders", "prod": 48,
         "unit": "件/h", "depends": ["ライン検品"], "role": "pack", "zone": "packing"},
        {"id": "出荷", "section": "出荷", "driver": "out_orders", "prod": 150,
         "unit": "件/h", "depends": ["梱包"], "role": "ship", "zone": "shipping"},
    ]


def _flow_edges() -> list[dict]:
    """物の流れ, wired to the actual machines (``equipment_ref``).

    Every drawn belt is named by exactly one leg, so ``conveyor_ids_in_use`` (which
    gates the engine) resolves to the same set the closed-form oracle reads — the
    two must never disagree about which belts exist. Split ratios sum to 1.0 per
    source, so ``flowgraph.diagnose`` stays quiet.
    """
    edges: list[dict] = [
        {"id": "e_recv", "src": "", "dst": "入荷検品", "transport": "manual",
         "share": 1.0, "container_ref": "case", "carrier_ref": "pallet"},
        {"id": "e_put", "src": "入荷検品", "dst": "格納", "transport": "forklift",
         "equipment_ref": "forklifts", "share": 1.0,
         "container_ref": "case", "carrier_ref": "pallet"},
        {"id": "e_pick", "src": "格納", "dst": "ピッキング", "transport": "manual",
         "share": 1.0, "container_ref": "orikon", "carrier_ref": "cart6"},
    ]
    # ピッキング → ライン検品: the two free-roller rows, half the volume each.
    for n in (1, 2):
        edges.append({"id": f"e_insp{n}", "src": "ピッキング", "dst": "ライン検品",
                      "transport": "conveyor", "equipment_ref": f"insp{n}",
                      "share": 0.5, "container_ref": "orikon"})
    # ライン検品 → 梱包: the ten 引き込み, an equal share each.
    for i in range(1, len(SPUR_X) + 1):
        for side in ("n", "s"):
            edges.append({"id": f"e_spur{i}{side}", "src": "ライン検品", "dst": "梱包",
                          "transport": "conveyor", "equipment_ref": f"spur{i}{side}",
                          "share": 0.1, "container_ref": "orikon"})
    # 梱包 → 出荷: finished cartons rejoin the trunk, pass the 停止線 and curve
    # away to 積み付け — the same belt, which is why it is named here.
    edges.append({"id": "e_ship", "src": "梱包", "dst": "出荷", "transport": "conveyor",
                  "equipment_ref": "trunk_low", "share": 1.0, "container_ref": "case"})
    return edges


def build():
    stations = _stations()
    ref_x, ref_y = stations[0]["x"], stations[0]["y"]   # 梱包ライン西端 = ABC の基準

    locations, items = [], []
    n = 0
    for x in COL_X:
        for y in ROW_Y:
            sku = f"SKU{n:05d}"
            loc_id = f"L{n:04d}"
            rank = (abs(x - ref_x) + abs(y - ref_y)) / (WIDTH + DEPTH)
            if rank < 0.33:
                abc, freq, ts, case = "A", 8.0, 1.2, 24
            elif rank < 0.66:
                abc, freq, ts, case = "B", 3.0, 1.5, 12
            else:
                abc, freq, ts, case = "C", 1.0, 1.8, 6
            locations.append({
                "id": loc_id, "name": "", "zone": "storage",
                "x": float(x), "y": float(y), "type": "shelf", "rack_type": "medium",
                "capacity": 100, "sku": sku, "qty": 0,
            })
            items.append({
                "sku": sku, "name": f"商品 {n}", "abc_class": abc,
                "pick_freq": freq, "ts_per_unit": ts, "case_qty": case,
                "default_location": loc_id,
            })
            n += 1

    walls, doors = _walls_doors()
    model = {
        "meta": {
            "schema_version": "0.1",
            "name": "ライン検品・引き込み梱包ライン",
            "units": {"length": "m", "time": "s", "weight": "kg"},
        },
        "layout": {"bounds": {"width": WIDTH, "depth": DEPTH},
                   "zones": _zones(), "walls": walls, "doors": doors},
        "locations": locations,
        "items": items,
        "process": {
            "flow": ["receive", "putaway", "pick", "inspect", "pack", "ship"],
            # Stages bound to THIS layout's zone ids so the 連鎖 check is clean.
            "stages": [
                {"id": "receive", "label": "入荷", "method": "manual", "zone": "receiving"},
                {"id": "putaway", "label": "格納", "method": "manual", "zone": "storage"},
                {"id": "pick", "label": "ピッキング", "method": "manual", "zone": "storage"},
                {"id": "inspect", "label": "ライン検品", "method": "conveyor",
                 "zone": "inspection"},
                {"id": "pack", "label": "梱包", "method": "conveyor", "zone": "packing"},
                {"id": "ship", "label": "出荷", "method": "manual", "zone": "shipping"},
            ],
            "work_processes": _work_processes(),
            "flow_edges": _flow_edges(),
            # マルチオーダー: a picker sweeps several orders into one container run,
            # which is what feeds a sorter/chute line in this shape.
            "pick_strategy": "batch",
            "routing_policy": "nearest",
            "batch_size": 4,
            "walk_speed_mps": 1.2,
            # 梱包台での作業 (開梱→箱詰め→封函). The line inspection is NOT in here:
            # it is the belt dwell (see the module docstring).
            "pack_time_s": 78.0,
            "staging_capacity": 0,      # the belt itself is the buffer
        },
        "resources": {
            "workers": [{"id": "pickers", "role": "picker", "count": 10, "speed_mps": 1.2}],
            "equipment": [
                {"id": "forklifts", "type": "forklift", "count": 2, "speed_mps": 1.8,
                 "x": 4.0, "y": 23.0},
                # 仕分けソーター: drawn where it discharges onto the inspection rows.
                # The DES prices this shape through the belt + benches, so the sorter
                # is a physical fact on the drawing, not a simulated stage.
                {"id": "sorter", "type": "sorter", "count": 1, "speed_mps": 1.0,
                 "x": 44.0, "y": 11.5, "chutes": 32, "induction_workers": 2},
            ],
            "conveyors": _conveyors(),
            "stations": stations,
        },
        "orders": {
            "outbound": [],
            "inbound": [],
            # 通販EC の1シフト: 小口・少行数が高頻度で流れる。
            "profile": {"arrival": "poisson", "rate_per_hr": 380.0,
                        "lines_per_order_mean": 2.2, "peak_factor": 1.25},
        },
        "simulation": {
            "duration_s": 28800.0, "warmup_s": 0.0, "random_seed": 42,
            "replications": 1, "heatmap_grid_m": 1.0,
        },
    }

    manifest = {
        "template_id": "line_inspection",
        # NOTE (Cody, invariant 10): the matcher mines this manifest's own words,
        # and a bare 「コンベアの倉庫」 must still land on the general-purpose
        # コンベア出荷ライン template — this one is the SPECIALISED shape. So the
        # distinctive vocabulary (ライン検品 / 引き込み / 検品ライン移設) carries the
        # name, while コンベア appears in the prose only, and always as its own run:
        # a compound like 「フリーコンベア」 would score a second, independent hit on
        # the same word (hence 無動力コンベア).
        "name": "ライン検品・引き込み梱包ライン",
        "description": (
            "仕分けシュートの下で無動力コンベア2列に載せ、コンベア上で検品を完結させる"
            "出荷ライン(ライン検品)。仕切りで検品前/検品後を区画し、検品済みは2段の"
            "駆動コンベア下段の本線へコンベア搬送。引き込みコンベア5ヶ所×両側で縦長の"
            "梱包ブース20台に分配し、停止線で検品済みを止めて完成品だけカーブから"
            "積み付けへ抜く。検品ライン移設や工程分離の検討に。"
        ),
        "subtree_source": {
            "meta": "interview", "layout": "data", "locations": "data",
            "items": "data", "process": "interview", "resources": "interview",
            "orders": "data", "simulation": "interview",
        },
        "headline_fields": [
            {"path": "resources.workers.0.count", "label": "ピッカー人数", "type": "int",
             "unit": "名"},
            {"path": "resources.conveyors.0.speed_mps", "label": "検品ライン速度",
             "type": "float", "unit": "m/s"},
            {"path": "process.pack_time_s", "label": "梱包時間", "type": "float",
             "unit": "秒/件"},
            {"path": "orders.profile.rate_per_hr", "label": "出荷オーダー", "type": "float",
             "unit": "件/時"},
            {"path": "orders.profile.peak_factor", "label": "ピーク係数", "type": "float",
             "unit": "倍"},
            {"path": "process.batch_size", "label": "バッチ数", "type": "int",
             "unit": "件/トリップ"},
            {"path": "simulation.duration_s", "label": "稼働時間", "type": "float",
             "unit": "時間", "scale": 3600},
        ],
    }
    return model, manifest


def _stamp_addresses(model: dict) -> None:
    """Run materialize_racks so the shipped locations already carry their
    structured 棚番号 (address) + 段 (level) — keeping the on-disk template
    byte-identical to what the runtime regenerates (never-jumps)."""
    from whsim import design
    from whsim.schema.model import WarehouseModel
    wm = WarehouseModel.model_validate(model)
    design.materialize_racks(wm)
    model["locations"] = [loc.model_dump() for loc in wm.locations]
    model["items"] = [it.model_dump() for it in wm.items]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    model, manifest = build()
    _stamp_addresses(model)
    (OUT / "template.json").write_text(
        json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {len(model['locations'])} locations, "
          f"{len(model['resources']['conveyors'])} conveyors, "
          f"{len(model['resources']['stations'])} stations to {OUT}")


if __name__ == "__main__":
    main()
