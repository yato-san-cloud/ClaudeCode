"""レイアウトの GeoJSON / CSV エクスポート層 (`whsim.geoexport`) の受入テスト。

受入基準 (依頼者の AC-1〜AC-4) をそのまま並べる:

* **AC-1** 既存レイアウト (テンプレート) から .geojson が出力される。
* **AC-2** RFC 7946 に妥当 — 依存を足さないため**自前のバリデータを本ファイル内に**
  実装し、全 Feature を通す (右手系は RFC 上 SHOULD なので警告扱いにできる形にした上で、
  whsim は CCW で出すので警告0を確認する)。
* **AC-3** per-level モードの Feature 数 == 間口総数 / grouped モードの Feature 数 ==
  棚の間口列数、かつ levels の合計 == 間口総数。
* **AC-4** エクスポートを呼んでも DES のイベント列が**完全一致** (additive の証明)。

加えて幾何 (手計算との一致・CSVとGeoJSONの一致)、`attach_metrics` の非破壊性、
Deneb 用 Vega-Lite spec の機械チェック。
"""

from __future__ import annotations

import json
import math
from itertools import pairwise
from pathlib import Path

import pytest

from whsim import design, geoexport, templates
from whsim.engine.run import run_once
from whsim.schema.model import (
    Bounds,
    Item,
    Layout,
    Location,
    Order,
    OrderLine,
    Orders,
    RackFill,
    ShelfArea,
    Simulation,
    WarehouseModel,
    Zone,
)

TEMPLATE_IDS = ("ecommerce_small", "line_inspection")

VL_SPEC = Path(__file__).resolve().parents[1] / "templates" / "deneb" / "warehouse_heatmap.vl.json"


# --------------------------------------------------------------------------- #
# AC-2: a self-contained RFC 7946 validator (no new dependency)                #
# --------------------------------------------------------------------------- #

def validate_geojson(doc) -> tuple[list[str], list[str]]:
    """Return (errors, warnings) for a GeoJSON document per RFC 7946.

    Deliberately hand-written and local to the test: adding a validation library
    to the runtime deps would buy nothing and violate the "no new pip deps" rule.
    Checks the parts that actually bite a consumer:

    * §1.4/§3     — "type" is FeatureCollection / Feature / Polygon as expected;
    * §3.2        — every Feature has BOTH "geometry" and "properties" members;
    * §3.1.1      — positions are arrays of 2 (or 3) FINITE numbers;
    * §3.1.6      — a Polygon ring is closed (first == last) and has >= 4 positions;
    * §3.1.6      — exterior ring counter-clockwise (right-hand rule): SHOULD, so
                    it is reported as a WARNING, never an error;
    * §5          — a bbox, if present, is [minx, miny, maxx, maxy] and bounds the data;
    * §4          — a top-level "crs" member must NOT be present (removed in RFC 7946).
    """
    errors: list[str] = []
    warnings: list[str] = []

    def num_ok(v) -> bool:
        return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)

    def check_position(pos, where: str):
        if not isinstance(pos, list) or not (2 <= len(pos) <= 3):
            errors.append(f"{where}: position must be an array of 2-3 numbers, got {pos!r}")
            return
        for v in pos:
            if not num_ok(v):
                errors.append(f"{where}: non-finite coordinate {v!r}")

    def check_polygon(geom, where: str):
        rings = geom.get("coordinates")
        if not isinstance(rings, list) or not rings:
            errors.append(f"{where}: Polygon coordinates must be a non-empty array of rings")
            return
        for ri, ring in enumerate(rings):
            w = f"{where}.ring[{ri}]"
            if not isinstance(ring, list) or len(ring) < 4:
                errors.append(f"{w}: a linear ring needs >= 4 positions, got "
                              f"{len(ring) if isinstance(ring, list) else ring!r}")
                continue
            for pi, pos in enumerate(ring):
                check_position(pos, f"{w}[{pi}]")
            if ring[0] != ring[-1]:
                errors.append(f"{w}: ring is not closed ({ring[0]!r} != {ring[-1]!r})")
            # signed area (shoelace); > 0 == counter-clockwise == exterior per §3.1.6
            area2 = sum(a[0] * b[1] - b[0] * a[1] for a, b in pairwise(ring))
            ccw = area2 > 0
            if ri == 0 and not ccw:
                warnings.append(f"{w}: exterior ring is clockwise (RFC 7946 §3.1.6 SHOULD be CCW)")
            if ri > 0 and ccw:
                warnings.append(f"{w}: interior ring is counter-clockwise (SHOULD be CW)")

    if not isinstance(doc, dict):
        return [f"top level must be an object, got {type(doc).__name__}"], warnings
    if doc.get("type") != "FeatureCollection":
        errors.append(f"top-level type must be 'FeatureCollection', got {doc.get('type')!r}")
    if "crs" in doc:
        errors.append("RFC 7946 removed the 'crs' member; it must not be present")
    feats = doc.get("features")
    if not isinstance(feats, list):
        errors.append("'features' must be an array")
        feats = []
    for i, f in enumerate(feats):
        where = f"features[{i}]"
        if not isinstance(f, dict):
            errors.append(f"{where}: feature must be an object")
            continue
        if f.get("type") != "Feature":
            errors.append(f"{where}: type must be 'Feature', got {f.get('type')!r}")
        if "geometry" not in f:
            errors.append(f"{where}: missing 'geometry' member")
        if "properties" not in f:
            errors.append(f"{where}: missing 'properties' member")
        geom = f.get("geometry")
        if geom is None:
            continue  # an unlocated Feature is legal (§3.2) — just nothing to check
        if not isinstance(geom, dict):
            errors.append(f"{where}.geometry: must be an object or null")
            continue
        if geom.get("type") != "Polygon":
            errors.append(f"{where}.geometry: expected Polygon, got {geom.get('type')!r}")
            continue
        check_polygon(geom, f"{where}.geometry")
    bbox = doc.get("bbox")
    if bbox is not None:
        if not isinstance(bbox, list) or len(bbox) != 4 or not all(num_ok(v) for v in bbox):
            errors.append(f"bbox must be 4 finite numbers, got {bbox!r}")
        else:
            x0, y0, x1, y1 = bbox
            if x0 > x1 or y0 > y1:
                errors.append(f"bbox is inverted: {bbox!r}")
            for i, f in enumerate(feats):
                geom = (f or {}).get("geometry") or {}
                for ring in geom.get("coordinates", []):
                    for x, y in ring:
                        if not (x0 - 1e-9 <= x <= x1 + 1e-9 and y0 - 1e-9 <= y <= y1 + 1e-9):
                            errors.append(f"features[{i}]: ({x},{y}) falls outside bbox {bbox!r}")
    return errors, warnings


def test_the_validator_itself_catches_a_broken_document():
    """A validator that passes everything proves nothing — give it real breakage."""
    broken = {
        "type": "FeatureCollection",
        "crs": {"type": "name"},                       # removed by RFC 7946
        "features": [
            {"type": "Feature", "geometry": {           # unclosed, 3-position ring
                "type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1]]]},
             "properties": {}},
            {"type": "Feature", "geometry": {           # non-finite coordinate
                "type": "Polygon",
                "coordinates": [[[0, 0], [float("nan"), 0], [1, 1], [0, 1], [0, 0]]]},
             "properties": {}},
            {"type": "Feature", "geometry": {           # clockwise exterior ring
                "type": "Polygon",
                "coordinates": [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]},
             "properties": {}},
        ],
    }
    errors, warnings = validate_geojson(broken)
    assert any("crs" in e for e in errors)
    assert any(">= 4 positions" in e for e in errors)
    assert any("non-finite" in e for e in errors)
    assert any("clockwise" in w for w in warnings)     # right-hand rule stays a warning


# --------------------------------------------------------------------------- #
# AC-1 / AC-2 / AC-3                                                           #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("template_id", TEMPLATE_IDS)
def test_ac1_ac2_existing_layouts_export_valid_geojson(template_id):
    model = templates.load_template_model(template_id)
    fc = geoexport.to_geojson(model)

    assert fc["features"], f"{template_id} should export at least one 間口"
    errors, warnings = validate_geojson(fc)
    assert errors == [], f"{template_id}: RFC 7946 violations: {errors[:5]}"
    # whsim emits CCW exterior rings, so even the SHOULD-level rule is clean.
    assert warnings == [], f"{template_id}: ring-orientation warnings: {warnings[:5]}"

    # It must round-trip through JSON (no NaN / no non-serialisable objects).
    reparsed = json.loads(json.dumps(fc, allow_nan=False))
    assert reparsed["type"] == "FeatureCollection"

    # Self-describing coordinate system: this is NOT WGS84 and must say so.
    meta = fc["whsim"]
    assert (meta["units"], meta["origin"], meta["y_axis"]) == ("m", "bottom-left", "up")
    assert "WGS84" in meta["crs_note"]


@pytest.mark.parametrize("template_id", TEMPLATE_IDS)
def test_ac3_feature_count_equals_the_number_of_間口(template_id):
    model = templates.load_template_model(template_id)
    fc = geoexport.to_geojson(model, level_mode="per-level")
    assert len(fc["features"]) == len(model.locations)
    ids = [f["properties"]["location_id"] for f in fc["features"]]
    assert len(set(ids)) == len(ids), "location_id must be unique (1 Feature = 1 間口)"


def test_ac3_grouped_mode_folds_levels_into_one_feature_per_bay():
    """grouped: Feature 数 == 棚×間口列, levels の合計 == 間口総数."""
    model = _authored_model()          # 3 bays x 4 levels (medium rack)
    per_level = geoexport.to_geojson(model, level_mode="per-level")
    grouped = geoexport.to_geojson(model, level_mode="grouped")

    n_bays = len({(round(loc.x, 3), round(loc.y, 3)) for loc in model.locations})
    assert n_bays == 3
    assert len(per_level["features"]) == len(model.locations) == 12
    assert len(grouped["features"]) == n_bays
    assert sum(f["properties"]["level_count"] for f in grouped["features"]) == len(model.locations)
    assert sum(len(f["properties"]["levels"]) for f in grouped["features"]) == len(model.locations)

    errors, warnings = validate_geojson(grouped)
    assert errors == [] and warnings == []
    for f in grouped["features"]:
        props = f["properties"]
        assert props["levels"] == [1, 2, 3, 4]
        assert props["level"] is None            # 段は畳んだので単一の値を持たない
        assert props["location_id"] == props["location_ids"][0]
    # ids stay unique across features even after folding
    ids = [f["properties"]["location_id"] for f in grouped["features"]]
    assert len(set(ids)) == len(ids)


def _multilevel_model() -> WarehouseModel:
    """TWO authored shelves on 軽量棚 (light: bay=0.9m, depth=0.45m, **levels=5**).

    A deliberately multi-level fixture: every bundled template materialises a
    single 段, so grouped and per-level agree there and a regression that
    collapsed the two modes into one would still show green. Here they must
    differ by exactly the level count.

      shelf A  x=1.0 y=1.0 w=0.45 h=3.6  → vertical, y centres 1.45/2.35/3.25/4.15 → 4 bays
      shelf B  x=3.0 y=1.0 w=0.45 h=1.8  → vertical, y centres 1.45/2.35           → 2 bays
      => 6 間口列 x 5 段 = 30 locations
    """
    model = WarehouseModel(
        layout=Layout(
            bounds=Bounds(width=20.0, depth=10.0),
            zones=[Zone(id="storage", type="storage", x=0.0, y=0.0, w=20.0, h=10.0,
                        shelves=[ShelfArea(id="a", name="A-01", x=1.0, y=1.0,
                                           w=0.45, h=3.6, rack_type="light"),
                                 ShelfArea(id="b", name="A-02", x=3.0, y=1.0,
                                           w=0.45, h=1.8, rack_type="light")])],
        ),
        simulation=Simulation(duration_s=600.0),
    )
    return design.materialize_racks(model)


def test_grouped_really_folds_a_five_level_rack():
    """多段 (5段) で per-level と grouped が段数分だけ食い違うことを固定する。"""
    model = _multilevel_model()
    bays = {(round(loc.x, 3), round(loc.y, 3)) for loc in model.locations}
    assert len(bays) == 6                                  # 4 + 2 間口列
    assert len(model.locations) == 30 == len(bays) * 5     # x 5 段
    assert {loc.level for loc in model.locations} == {1, 2, 3, 4, 5}

    per_level = geoexport.to_geojson(model, level_mode="per-level")
    grouped = geoexport.to_geojson(model, level_mode="grouped")

    # (1) per-level: 1 Feature = 1 間口
    assert len(per_level["features"]) == len(model.locations) == 30
    # (2) grouped: 段数分の1 に減り、levels の合計が間口総数に戻る
    assert len(grouped["features"]) == len(bays) == 6
    assert len(grouped["features"]) * 5 == len(per_level["features"])
    assert sum(len(f["properties"]["levels"]) for f in grouped["features"]) == 30
    assert sum(f["properties"]["level_count"] for f in grouped["features"]) == 30
    assert all(f["properties"]["levels"] == [1, 2, 3, 4, 5] for f in grouped["features"])
    # (3) 畳んでも間口を1つも落とさない: id の全集合が一致する
    per_ids = {f["properties"]["location_id"] for f in per_level["features"]}
    folded_ids = {lid for f in grouped["features"] for lid in f["properties"]["location_ids"]}
    assert folded_ids == per_ids
    assert len(per_ids) == 30

    # 段を畳んでも矩形は同じ 1 間口分（重ね描きが消えるだけ）
    for f in grouped["features"]:
        ring = f["geometry"]["coordinates"][0]
        assert ring[1][0] - ring[0][0] == pytest.approx(0.45, abs=1e-6)   # depth
        assert ring[2][1] - ring[1][1] == pytest.approx(0.9, abs=1e-6)    # bay
    errors, warnings = validate_geojson(grouped)
    assert errors == [] and warnings == []

    # CSV は per-level と同じ粒度（間口1行）のままであること
    csv_rows = geoexport.to_layout_csv(model).strip("\r\n").split("\r\n")
    assert len(csv_rows) - 1 == 30


def test_unknown_level_mode_is_rejected_loudly():
    with pytest.raises(ValueError):
        geoexport.to_geojson(templates.load_template_model("ecommerce_small"), level_mode="nope")


# --------------------------------------------------------------------------- #
# AC-4: additive — the simulation is byte-identical with and without an export  #
# --------------------------------------------------------------------------- #

def test_ac4_exporting_does_not_change_the_simulation_or_the_model():
    baseline_model = templates.load_template_model("ecommerce_small")
    baseline = run_once(baseline_model, seed=7)

    model = templates.load_template_model("ecommerce_small")
    before = model.model_dump()
    fc = geoexport.to_geojson(model)
    grouped = geoexport.to_geojson(model, level_mode="grouped")
    metrics = geoexport.metrics_from_orders(model)
    geoexport.attach_metrics(fc, metrics)
    geoexport.to_layout_csv(model, metrics)
    assert model.model_dump() == before, "export must not mutate the model"
    assert fc["features"] and grouped["features"]

    after = run_once(model, seed=7)
    assert after.events == baseline.events, "the event log must be identical (additive)"
    assert len(after.workers) == len(baseline.workers)


# --------------------------------------------------------------------------- #
# geometry: hand-computed corners, and CSV == GeoJSON                          #
# --------------------------------------------------------------------------- #

def _authored_model() -> WarehouseModel:
    """A tiny model with ONE authored shelf, materialised the production way.

    medium rack: bay=1.2m, depth=0.60m, levels=4 (whsim.racktypes).
    Shelf rect x=2.0 y=1.0 w=0.6 h=3.6 → vertical (h >= w), so the pitch is
    0.6 across x and 1.2 along y:
      x centres: 2.0 + 0.6/2                     = 2.3            (one column)
      y centres: 1.0 + 1.2/2, +1.2, +1.2         = 1.6, 2.8, 4.0  (three bays)
    => 3 bays x 4 levels = 12 locations, each 0.6 x 1.2 m.
    """
    model = WarehouseModel(
        layout=Layout(
            bounds=Bounds(width=20.0, depth=10.0),
            zones=[Zone(id="storage", type="storage", x=0.0, y=0.0, w=20.0, h=10.0,
                        shelves=[ShelfArea(id="s1", name="A-01", x=2.0, y=1.0,
                                           w=0.6, h=3.6, rack_type="medium")])],
        ),
        simulation=Simulation(duration_s=600.0),
    )
    return design.materialize_racks(model)


def test_geometry_matches_the_hand_computed_rectangle():
    model = _authored_model()
    fc = geoexport.to_geojson(model)
    assert len(fc["features"]) == 12

    by_key = {}
    for f in fc["features"]:
        p = f["properties"]
        by_key[(round(f["geometry"]["coordinates"][0][0][1], 3), p["level"])] = f

    # bottom bay (y centre 1.6, pitch 1.2 → 1.0 .. 2.2), level 1
    ring = by_key[(1.0, 1)]["geometry"]["coordinates"][0]
    assert ring == [[2.0, 1.0], [2.6, 1.0], [2.6, 2.2], [2.0, 2.2], [2.0, 1.0]]
    # the 4 stacked levels of one bay share the exact same footprint (案A の性質)
    for lvl in (2, 3, 4):
        assert by_key[(1.0, lvl)]["geometry"]["coordinates"][0] == ring
    # middle and top bays step by the 1.2 m bay pitch
    assert by_key[(2.2, 1)]["geometry"]["coordinates"][0][0] == [2.0, 2.2]
    assert by_key[(3.4, 1)]["geometry"]["coordinates"][0][2] == [2.6, 4.6]
    assert fc["bbox"] == [2.0, 1.0, 2.6, 4.6]

    # The authored shelf name reaches the BI vocabulary.
    assert {f["properties"]["rack_no"] for f in fc["features"]} == {"A-01"}
    assert {f["properties"]["area"] for f in fc["features"]} == {"storage"}


def test_the_footprint_is_the_shelf_rectangle_not_a_guess():
    """The 12 bay rectangles tile the authored shelf exactly (no overlap, no gap)."""
    model = _authored_model()
    fc = geoexport.to_geojson(model, level_mode="grouped")
    area = 0.0
    for f in fc["features"]:
        ring = f["geometry"]["coordinates"][0]
        area += (ring[1][0] - ring[0][0]) * (ring[2][1] - ring[1][1])
    assert area == pytest.approx(0.6 * 3.6)      # == the ShelfArea's own w * h


@pytest.mark.parametrize("template_id", TEMPLATE_IDS)
def test_csv_and_geojson_describe_the_same_rectangles(template_id):
    model = templates.load_template_model(template_id)
    fc = geoexport.to_geojson(model)
    csv_text = geoexport.to_layout_csv(model)

    assert csv_text.startswith(geoexport.BOM), "BOM 付き UTF-8 (日本語Excel/PBI 対策)"
    lines = csv_text[len(geoexport.BOM):].strip("\r\n").split("\r\n")
    header = lines[0].split(",")
    assert header[:len(geoexport.CSV_COLUMNS)] == list(geoexport.CSV_COLUMNS)
    assert header[len(geoexport.CSV_COLUMNS):] == list(geoexport.METRIC_SLOTS)
    assert len(lines) - 1 == len(model.locations)     # 間口1行

    rows = {}
    for line in lines[1:]:
        cells = line.split(",")
        rows[cells[0]] = dict(zip(header, cells))

    for f in fc["features"]:
        p = f["properties"]
        r = rows[p["location_id"]]
        ring = f["geometry"]["coordinates"][0]
        x0, y0 = float(r["x"]), float(r["y"])
        assert ring[0] == [x0, y0]
        assert ring[2] == [round(x0 + float(r["w"]), 3), round(y0 + float(r["d"]), 3)]
        assert int(r["level"]) == p["level"]
        assert (r["area"], r["rack_no"], r["aisle"]) == (p["area"], p["rack_no"], p["aisle"])


def test_the_exported_rectangles_agree_with_what_the_renderer_draws():
    """The fallback (RackFill) footprint must equal the shelf-run the PNG draws."""
    from whsim.render.shelves import shelf_runs
    model = templates.load_template_model("ecommerce_small")
    runs = {round(r["x"], 3): r for r in shelf_runs(model)}
    fc = geoexport.to_geojson(model)
    checked = 0
    for f in fc["features"]:
        ring = f["geometry"]["coordinates"][0]
        cx = round((ring[0][0] + ring[1][0]) / 2.0, 3)
        run = runs.get(cx)
        if run is None:
            continue
        assert ring[1][0] - ring[0][0] == pytest.approx(run["depth"], abs=1e-3)
        assert ring[2][1] - ring[1][1] == pytest.approx(run["pitch"], abs=1e-3)
        checked += 1
    assert checked > 0


# --------------------------------------------------------------------------- #
# metrics: the numeric slots                                                    #
# --------------------------------------------------------------------------- #

def _model_with_orders() -> WarehouseModel:
    model = WarehouseModel(
        layout=Layout(bounds=Bounds(width=20.0, depth=10.0),
                      zones=[Zone(id="storage", type="storage", x=0.0, y=0.0, w=20.0, h=10.0,
                                  rack=RackFill(col_spacing=4.0, row_spacing=2.0, margin=2.0))]),
        locations=[Location(id="L1", zone="storage", x=4.0, y=2.0, sku="S1", qty=10),
                   Location(id="L2", zone="storage", x=8.0, y=2.0, sku="S2", qty=5)],
        items=[Item(sku="S1", default_location="L1"), Item(sku="S2", default_location="L2")],
        orders=Orders(outbound=[
            Order(order_id="o1", lines=[OrderLine(sku="S1", qty=3), OrderLine(sku="S2", qty=1)]),
            Order(order_id="o2", lines=[OrderLine(sku="S1", qty=2)]),
        ]),
    )
    return model


def test_metric_slots_are_holes_until_something_fills_them():
    fc = geoexport.to_geojson(_model_with_orders())
    for f in fc["features"]:
        assert f["properties"]["metrics"] == {"lines": None, "picks": None, "stock": None}


def test_metrics_from_orders_measures_lines_and_picks_and_stock():
    model = _model_with_orders()
    table = geoexport.metrics_from_orders(model)
    assert table["L1"] == {"lines": 2, "picks": 5, "stock": 10}
    assert table["L2"] == {"lines": 1, "picks": 1, "stock": 5}


def test_attach_metrics_fills_the_slots_without_touching_the_input():
    model = _model_with_orders()
    fc = geoexport.to_geojson(model)
    snapshot = json.dumps(fc, sort_keys=True)

    out = geoexport.attach_metrics(fc, geoexport.metrics_from_orders(model))
    assert json.dumps(fc, sort_keys=True) == snapshot, "attach_metrics must be non-destructive"

    got = {f["properties"]["location_id"]: f["properties"]["metrics"] for f in out["features"]}
    assert got["L1"] == {"lines": 2, "picks": 5, "stock": 10}
    assert got["L2"] == {"lines": 1, "picks": 1, "stock": 5}

    # unknown ids are ignored, and a brand-new slot name is simply added
    out2 = geoexport.attach_metrics(fc, {"L1": {"abc_rank": 1.5}, "NOPE": {"lines": 99}})
    p1 = next(f["properties"] for f in out2["features"] if f["properties"]["location_id"] == "L1")
    assert p1["metrics"]["abc_rank"] == 1.5
    assert p1["metrics"]["lines"] is None
    assert len(out2["features"]) == len(fc["features"])


def test_grouped_features_sum_their_levels_metrics():
    model = _authored_model()
    fc = geoexport.to_geojson(model, level_mode="grouped")
    table = {loc.id: {"lines": 2} for loc in model.locations}
    out = geoexport.attach_metrics(fc, table)
    for f in out["features"]:
        assert f["properties"]["metrics"]["lines"] == 2 * f["properties"]["level_count"]


def test_metrics_flow_into_the_csv_columns():
    model = _model_with_orders()
    text = geoexport.to_layout_csv(model, geoexport.metrics_from_orders(model))
    body = text[len(geoexport.BOM):].strip("\r\n").split("\r\n")
    header = body[0].split(",")
    row = dict(zip(header, body[1].split(",")))
    assert (row["location_id"], row["lines"], row["picks"], row["stock"]) == ("L1", "2", "5", "10")


# --------------------------------------------------------------------------- #
# never-blocks                                                                  #
# --------------------------------------------------------------------------- #

def test_an_empty_model_still_exports_a_valid_document():
    model = WarehouseModel()
    fc = geoexport.to_geojson(model)
    assert fc["features"] == []
    assert "bbox" not in fc                      # nothing to bound
    errors, warnings = validate_geojson(fc)
    assert errors == [] and warnings == []

    text = geoexport.to_layout_csv(model)
    body = text[len(geoexport.BOM):].strip("\r\n").split("\r\n")
    assert len(body) == 1 and body[0].startswith("location_id,")
    assert geoexport.metrics_from_orders(model) == {}


def test_a_single_location_with_no_shelf_still_gets_a_footprint():
    model = WarehouseModel(locations=[Location(id="only", x=3.0, y=4.0)])
    fc = geoexport.to_geojson(model)
    assert len(fc["features"]) == 1
    errors, _ = validate_geojson(fc)
    assert errors == []
    ring = fc["features"][0]["geometry"]["coordinates"][0]
    assert ring[1][0] > ring[0][0] and ring[2][1] > ring[1][1]      # a real rectangle


# --------------------------------------------------------------------------- #
# Deneb / Vega-Lite spec                                                        #
# --------------------------------------------------------------------------- #

def test_vega_lite_spec_is_valid_json_and_targets_vega_lite():
    spec = json.loads(VL_SPEC.read_text("utf-8"))
    assert "vega-lite" in spec["$schema"]
    assert spec["data"] == {"name": "dataset"}      # Deneb's default dataset name
    assert spec["mark"]["type"] == "rect"
    # The Y-axis decision must be recorded where the next person will look.
    assert "reflectY" in spec["description"]
    assert spec["usermeta"]["whsim"]["verified_in_power_bi"] is False
    assert spec["usermeta"]["whsim"]["row_limit"] == 30000


def test_vega_lite_encoding_only_references_columns_layout_csv_actually_has():
    """Machine check: every field in the spec resolves to a CSV column or a transform."""
    spec = json.loads(VL_SPEC.read_text("utf-8"))
    columns = set(geoexport.CSV_COLUMNS) | set(geoexport.METRIC_SLOTS)
    # ...and the CSV really does have exactly those columns.
    model = templates.load_template_model("ecommerce_small")
    header = geoexport.to_layout_csv(model).splitlines()[0].lstrip(geoexport.BOM).split(",")
    assert set(header) == columns

    derived = {t["as"] for t in spec.get("transform", []) if "as" in t}
    known = columns | derived

    fields: list[str] = []
    for channel in spec["encoding"].values():
        for entry in (channel if isinstance(channel, list) else [channel]):
            if isinstance(entry, dict) and "field" in entry:
                fields.append(entry["field"])
    assert fields, "the spec must encode something"
    unknown = [f for f in fields if f not in known]
    assert unknown == [], f"encoding references unknown fields: {unknown}"

    # The transforms themselves may only read real CSV columns.
    for t in spec.get("transform", []):
        for token in str(t.get("calculate", "")).split("datum.")[1:]:
            name = ""
            for ch in token:                       # read one identifier, then stop
                if not (ch.isalnum() or ch == "_"):
                    break
                name += ch
            assert name in known, f"transform reads unknown column: {name}"

    # The rect needs both corners: x/x2 and y/y2 must all be bound.
    assert {"x", "x2", "y", "y2"} <= set(spec["encoding"])
    # 間口 identity and 段 must be visible on hover.
    tooltip_fields = {t["field"] for t in spec["encoding"]["tooltip"]}
    assert {"location_id", "level"} <= tooltip_fields


# --------------------------------------------------------------------------- #
# web endpoints (registration + payload shape)                                  #
# --------------------------------------------------------------------------- #

@pytest.fixture()
def client(tmp_path, monkeypatch):
    """TestClient on an isolated workspace (`projects/` is relative to CWD)."""
    fastapi_testclient = pytest.importorskip("fastapi.testclient")
    from whsim.web.app import app
    monkeypatch.chdir(tmp_path)
    return fastapi_testclient.TestClient(app)


def test_layout_geojson_endpoint_serves_the_same_document(client):
    assert client.post("/api/projects",
                       json={"name": "p", "template": "ecommerce_small"}).status_code == 200

    r = client.get("/api/projects/p/layout.geojson")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/geo+json")
    assert "layout.geojson" in r.headers["content-disposition"]
    fc = r.json()
    errors, warnings = validate_geojson(fc)
    assert errors == [] and warnings == []
    assert len(fc["features"]) == len(templates.load_template_model("ecommerce_small").locations)

    grouped = client.get("/api/projects/p/layout.geojson?grouped=1").json()
    assert grouped["whsim"]["level_mode"] == "grouped"
    assert len(grouped["features"]) <= len(fc["features"])

    # metrics=0 leaves the slots as holes
    bare = client.get("/api/projects/p/layout.geojson?metrics=0").json()
    assert all(v is None for v in bare["features"][0]["properties"]["metrics"].values())

    assert client.get("/api/projects/nosuch/layout.geojson").status_code == 404


def test_layout_csv_endpoint_is_bom_utf8_and_matches_the_geojson(client):
    assert client.post("/api/projects",
                       json={"name": "p", "template": "line_inspection"}).status_code == 200

    r = client.get("/api/projects/p/layout.csv")
    assert r.status_code == 200
    assert r.content.startswith(b"\xef\xbb\xbf"), "UTF-8 BOM for 日本語Excel / Power BI"
    assert r.headers["content-type"].startswith("text/csv")
    body = r.content.decode("utf-8-sig").strip("\r\n").split("\r\n")
    assert body[0].split(",")[:4] == ["location_id", "x", "y", "w"]

    fc = client.get("/api/projects/p/layout.geojson").json()
    assert len(body) - 1 == len(fc["features"])


# ---------------------------------------------- Power BI star schema (runs × KPI)


def test_kpi_facts_are_verbatim_long_format(tmp_path):
    """kpi_facts.csv は run_id × kpi × value の long format で、値は kpis.json
    からの転記のみ（この層は集計しない — 数値は全てイベントログ集計由来）。"""
    import csv as _csv
    import io as _io

    from whsim import geoexport

    summ = {"run_id": "r1", "name": "t", "started": "2026-08-14", "seed": 7,
            "scenario_hash": "ab",
            "kpis": {"throughput_per_hr": 100.5, "verdict": "ok",
                     "jams": True,   # bool は measure ではない → 出さない
                     "conveyors": {"spur1n": {"block_ratio": 0.125}}}}
    txt = geoexport.to_kpi_facts_csv([summ]).lstrip("﻿")
    rows = list(_csv.DictReader(_io.StringIO(txt)))
    got = {r["kpi"]: float(r["value"]) for r in rows}
    assert got["throughput_per_hr"] == 100.5
    assert got["conveyors.spur1n.block_ratio"] == 0.125   # 入れ子は dotted key
    assert "verdict" not in got and "jams" not in got
    dim = geoexport.to_runs_csv([summ]).lstrip("﻿")
    drow = next(iter(_csv.DictReader(_io.StringIO(dim))))
    assert drow["run_id"] == "r1" and drow["verdict"] == "ok"


def test_project_runs_feed_the_star_schema(tmp_path, monkeypatch):
    """実プロジェクトの run 成果物から次元表とファクト表が出て、run_id で結合できる。"""
    import csv as _csv
    import io as _io

    import whsim.project as project_mod
    from whsim import geoexport
    from whsim import kpis as kpi_mod
    from whsim.engine.run import run_replications

    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    proj = project_mod.Project.create("star", "ecommerce_small")
    m = proj.load_model()
    m.simulation.duration_s = 600.0
    results, _ = run_replications(m)
    k = kpi_mod.compute(results, m)
    rd = proj.new_run_dir()
    (rd / "kpis.json").write_text(json.dumps(k, ensure_ascii=False), "utf-8")

    summaries = geoexport.project_run_summaries(proj)
    assert len(summaries) == 1
    facts = list(_csv.DictReader(_io.StringIO(
        geoexport.to_kpi_facts_csv(summaries).lstrip("﻿"))))
    dims = list(_csv.DictReader(_io.StringIO(
        geoexport.to_runs_csv(summaries).lstrip("﻿"))))
    assert dims[0]["run_id"] == rd.name
    assert all(f["run_id"] == rd.name for f in facts)
    # 転記の証明: ファクト値が kpis.json の値そのもの
    got = {f["kpi"]: float(f["value"]) for f in facts}
    assert got["throughput_per_hr"] == k["throughput_per_hr"]
    assert got["picker_utilization"] == k["picker_utilization"]
