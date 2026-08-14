"""レイアウトを**レンダラ非依存の中間形式**で外へ出す層 (GeoJSON / CSV)。

Why this module exists
----------------------
可視化の行き先は3つ候補がある (Power BI Deneb の2Dヒートマップ / 自作 three.js /
Collada 経由の3D BI)。どれも結局は「**ID＋座標＋属性**」に帰着するので、出力先を
決める前に共通の中間形式を1つ持っておけば、決定を後ろ倒しにできる。ここはその
**出口だけ**を担う純関数の集まりで、シミュレーション計算には一切触れない
(additive: この関数を呼んでもモデルは1バイトも変わらない)。

Geometry is NOT re-invented here
--------------------------------
間口 (`Location`) はスキーマ上**中心点**しか持たない。矩形は「その間口を生んだ棚」
から切り出す必要があるが、**同じ倉庫を2回別々に記述しない**ため、展開規則は既存の
2つの源をそのまま使う:

1. **authored shelf** (`zone.shelves` の `ShelfArea`) がある場合 —
   `design._shelf_slots` を**前向きに**回して間口セルの中心列を得る (これは
   `design.materialize_racks` がロケーションを生成したときに使ったのと同じ関数)。
   ピッチはその中心列から幾何的に逆算する (`_pitch_from_centers`) ので、
   rack_type の解決規則をここで書き写さない = 将来 design 側が変わっても追随する。
2. **authored shelf が無い**場合 (テンプレートの `RackFill` 全面展開や取込点群) —
   `render.shelves._reconstructed_runs` と**同じ規則**でピッチを測る
   (`_min_gap` を共有インポート)。結果の矩形は提案PNG (`render/png2d._draw_racks`:
   run は `x - depth/2` 起点、セルは `cy ± pitch/2`) が実際に描く矩形と一致する。

座標系 (**reflectY の要否の答え**)
----------------------------------
whsim のモデル座標は **メートル・原点は倉庫の左下・y は上向き**。根拠 (コードの事実):

* `render/png2d.py` — `ax.set_ylim(ey0-pad, ey1+pad)` の昇順 ylim ＋ ヒートマップの
  `imshow(..., origin="lower")`。matplotlib の既定は y 上向きなので、提案PNGは
  y が大きいほど上に描く。
* `web/static/js/render2d.js` — `const Y = (y) => h - oy - y * sc; // flip y`、
  `designer/core.js` `_Y()` も同一。**canvas の y は下向きなので明示的に反転している**
  = モデル側は y 上向き、という事実の裏返し。
* `view3d/geometry.js` — `z0 = r.y` (符号反転なし) でモデル y をそのまま three.js の z へ。
* 取込側も `ARCHITECTURE.md §3` の MapMaker 写像が「原点平行移動、**Y反転しない**」。

したがって GeoJSON 側で座標変換は**不要** (そのまま出す)。消費側では:

* Vega-Lite の **quantitative y スケール**は既定で range=[height,0] = 値が大きいほど上。
  → `reverse` も `reflectY` も**不要**（`templates/deneb/warehouse_heatmap.vl.json`）。
* `geoshape` ＋ `projection:{"type":"identity"}` は data y をそのまま画面 y (下向き) に
  写すので、この経路だけ **`"reflectY": true` が必要**。

Public API
----------
* :func:`to_geojson`      — FeatureCollection (RFC 7946)。1 Feature = 間口1つ (既定)。
* :func:`attach_metrics`  — 数値属性スロットを**非破壊**で埋める。
* :func:`to_layout_csv`   — 間口1行の CSV (BOM 付き UTF-8, Power BI / Excel 用)。
* :func:`metrics_from_orders` — 出荷実績 (`orders.outbound`) から lines/picks を実測。

never-blocks: ロケーション0件のモデルでも空の FeatureCollection / ヘッダのみの CSV を
返す (例外を投げない)。
"""

from __future__ import annotations

import copy
import csv
import datetime as _dt
import io
import json
import math

from whsim import design, locmaster

# Single source of the fallback pitch rule (see the module docstring): the same
# helper the renderer uses to reconstruct shelf runs from a flat location cloud.
from whsim.render.shelves import _min_gap

__all__ = [
    "CSV_COLUMNS",
    "LEVEL_MODES",
    "METRIC_SLOTS",
    "SCHEMA_VERSION",
    "attach_metrics",
    "metrics_from_orders",
    "to_geojson",
    "to_layout_csv",
]

SCHEMA_VERSION = 1

#: 段 (level) の扱い。既定は per-level (間口ごと1 Feature)。docs/geojson-export.md 参照。
LEVEL_MODES = ("per-level", "grouped")

#: 数値属性の**スロット**: 既定は穴 (None) を掘っておき、後から `attach_metrics` で
#: 差し替える。BI 側で列が消えたり増えたりしないよう、常に同じキーを出す。
METRIC_SLOTS = ("lines", "picks", "stock")

#: CSV の列順。GeoJSON と**同じ幾何源**から出す (x,y は矩形の左下角、単位 m)。
CSV_COLUMNS = ("location_id", "x", "y", "w", "d", "level", "area", "rack_no", "aisle")

# Excel on a Japanese Windows opens a BOM-less UTF-8 CSV as CP932 (eventlog.py と同じ理由)。
BOM = "﻿"

_ND = 3  # coordinate rounding: millimetres, like the rest of the codebase


def _r(v: float) -> float:
    """Round to mm and normalise -0.0 → 0.0 (JSON should not carry a signed zero)."""
    out = round(float(v), _ND)
    return 0.0 if out == 0 else out


# --------------------------------------------------------------------------- #
# geometry: one 間口 -> one rectangle                                          #
# --------------------------------------------------------------------------- #

def _pitch_from_centers(centers: list[float], origin: float, span: float) -> float:
    """Cell pitch along one axis, derived from `design._shelf_slots`' own output.

    `_shelf_slots` places the first centre at ``origin + pitch/2`` and steps by
    ``pitch``; when not even one cell fits it falls back to the rectangle centre.
    Both cases are recovered exactly by reading the centres back:

    * ``>= 2`` centres → the pitch is the gap between the first two;
    * ``1`` centre → ``2 * (c - origin)`` (which degenerates to the full span in
      the fallback case, i.e. the honest "this bay is the whole rectangle").

    Deriving it this way means the rack_type / cell_w / cell_d resolution rules
    live in exactly one place (``design``), never copied here.
    """
    if not centers:
        return max(span, 0.0)
    if len(centers) >= 2:
        return max(round(centers[1] - centers[0], 6), 1e-6)
    return max(round(2.0 * (centers[0] - origin), 6), 1e-6)


def _authored_cells(model) -> dict[tuple[float, float], dict]:
    """Index every authored-shelf bay by its (rounded) centre → footprint + shelf.

    Walks zones → shelves → cells in the SAME order as
    ``design.materialize_racks``, so overlapping shelves resolve first-wins
    deterministically (a pathological case; documented rather than guessed at).
    """
    out: dict[tuple[float, float], dict] = {}
    for z in getattr(model.layout, "zones", []) or []:
        if z.type != "storage" or not getattr(z, "shelves", None):
            continue
        for sh in z.shelves:
            cells = design._shelf_slots(sh)
            if not cells:
                continue
            xs = sorted({c[0] for c in cells})
            ys = sorted({c[1] for c in cells})
            px = _pitch_from_centers(xs, sh.x, max(sh.w, 1e-3))
            py = _pitch_from_centers(ys, sh.y, max(sh.h, 1e-3))
            for (cx, cy) in cells:
                key = (round(cx, _ND), round(cy, _ND))
                out.setdefault(key, {"w": px, "d": py, "shelf": sh})
    return out


def _fallback_pitch(model) -> tuple[float, float]:
    """(w, d) for a location that no authored shelf claims.

    Mirrors ``render.shelves._reconstructed_runs`` exactly, which is what the
    proposal PNG and the 2D canvas actually draw for these models: the run's
    x-extent is ``max(0.3, min(pitch_x * 0.42, 1.5))`` and each cell owns one
    ``pitch_y`` along the run.
    """
    locs = list(getattr(model, "locations", []) or [])
    if not locs:
        return 1.5, 1.0
    pitch_x = _min_gap([loc.x for loc in locs], 4.0)
    pitch_y = _min_gap([loc.y for loc in locs], 1.0)
    return max(0.3, min(pitch_x * 0.42, 1.5)), pitch_y


# --------------------------------------------------------------------------- #
# vocabulary: area / rack_no / aisle                                           #
# --------------------------------------------------------------------------- #

def _locmaster_parts(name: str) -> list[str] | None:
    """Split a WMS location code ``AAA-01-02-3-01`` into its parts, or None.

    Uses ``locmaster.normalize_loc`` as the gate so "is this a real location
    code?" is answered by the importer's own rule (area + ≥2 numeric parts),
    not by a second regex living here.
    """
    name = (name or "").strip()
    if not name or locmaster.normalize_loc(name, 3) is None:
        return None
    parts = [p.strip() for p in name.split("-")]
    if not all(p.isdigit() for p in parts[1:3]):
        return None
    return parts


def _vocab(loc, shelf) -> tuple[str, str, str]:
    """(area, rack_no, aisle) for one location, in the requester's vocabulary.

    Resolution order — **the drawing wins**, because that is the one thing both
    the 3D view and the proposal PNG are built from:

    1. the authoring `ShelfArea`'s own name (MapMaker keeps it verbatim, and it is
       the join key inventory arrives on) → ``rack_no``. `materialize_racks`
       suffixes bay/level onto the LOCATION name (``A-01`` → ``A-01-03-2``), so
       parsing the location name here would report a bay as if it were a rack.
    2. else a WMS-coded location name (``AAA-01-02-3-01``) → area=エリア, aisle=列,
       rack_no=エリア-列-棚 (the *shelf* identity: a bare 棚 number repeats in every
       列, so it is useless as a BI grouping key).
    3. else area = zone id, aisle = the 通路 token of the 棚番号
       (`Location.address`), rack_no = 通路-連 from the same 棚番号. A location with
       no address gets one computed by ``design._address`` itself — the same
       x-band / 連 rule ``materialize_racks`` uses, so the drawing and the export
       can never disagree.
    """
    shelf_name = (getattr(shelf, "name", "") or "").strip() if shelf is not None else ""
    shelf_parts = _locmaster_parts(shelf_name)
    if shelf_parts:                       # MapMaker 棚名 "100-01-09" = エリア-列-棚
        return shelf_parts[0], shelf_name, shelf_parts[1].zfill(2)

    if not shelf_name:
        parts = _locmaster_parts(getattr(loc, "name", "") or "")
        if parts:
            return parts[0], locmaster.normalize_loc(loc.name, 3) or "", parts[1].zfill(2)

    area = (getattr(loc, "zone", "") or "").strip()
    level = int(getattr(loc, "level", 1) or 1)
    # x0 = 0.0: the layout bounds are 0-anchored (design.materialize_racks).
    addr = ((getattr(loc, "address", "") or "").strip()
            or design._address(loc.x, loc.y, level, 0.0))
    addr_parts = addr.split("-")
    aisle = addr_parts[0]
    rack_no = shelf_name
    if not rack_no and len(addr_parts) >= 2:
        rack_no = f"{aisle}-{addr_parts[1]}"
    return area, rack_no, aisle


# --------------------------------------------------------------------------- #
# the shared row: GeoJSON and CSV are two renderings of THIS                    #
# --------------------------------------------------------------------------- #

def _rows(model) -> list[dict]:
    """One dict per 間口 (Location): id, level, vocabulary and footprint.

    The single geometry source behind both :func:`to_geojson` and
    :func:`to_layout_csv` — the two representations cannot disagree because
    there is only one computation.
    """
    locs = list(getattr(model, "locations", []) or [])
    if not locs:
        return []
    authored = _authored_cells(model)
    fw, fd = _fallback_pitch(model)
    rows: list[dict] = []
    for loc in locs:
        hit = authored.get((round(loc.x, _ND), round(loc.y, _ND)))
        w = hit["w"] if hit else fw
        d = hit["d"] if hit else fd
        shelf = hit["shelf"] if hit else None
        area, rack_no, aisle = _vocab(loc, shelf)
        rows.append({
            "location_id": loc.id,
            "level": int(getattr(loc, "level", 1) or 1),
            "area": area,
            "rack_no": rack_no,
            "aisle": aisle,
            "zone": getattr(loc, "zone", "") or "",
            "name": getattr(loc, "name", "") or "",
            "rack_type": getattr(loc, "rack_type", "") or "",
            "cx": _r(loc.x),
            "cy": _r(loc.y),
            "x": _r(loc.x - w / 2.0),
            "y": _r(loc.y - d / 2.0),
            "w": _r(w),
            "d": _r(d),
        })
    return rows


def _ring(row: dict) -> list[list[float]]:
    """The rectangle as a closed, counter-clockwise linear ring (RFC 7946 §3.1.6).

    y is up in whsim's model space (see the module docstring), so
    (x0,y0)→(x1,y0)→(x1,y1)→(x0,y1) IS counter-clockwise = the right-hand rule
    for an exterior ring. First position repeated to close the ring.
    """
    x0, y0 = row["x"], row["y"]
    x1, y1 = _r(x0 + row["w"]), _r(y0 + row["d"])
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]


def _empty_metrics() -> dict:
    return {k: None for k in METRIC_SLOTS}


# --------------------------------------------------------------------------- #
# public API                                                                    #
# --------------------------------------------------------------------------- #

def to_geojson(model, level_mode: str = "per-level", metrics: dict | None = None) -> dict:
    """レイアウトを GeoJSON FeatureCollection (RFC 7946) にする。

    Args:
        model: `whsim.schema.WarehouseModel` (読み取り専用 — 一切変更しない)。
        level_mode:
            ``"per-level"`` (既定・案A) = **1 Feature = 間口1つ**。同じ矩形が段数分
            重複するが、2D の集計 (sum/filter) が素直で、3D は level×棚段高さで
            そのまま押し出せる。
            ``"grouped"`` (案B) = **1 Feature = 棚の1間口列**。段は ``levels`` 配列と
            ``level_count`` に畳む。Feature 数が段数分の1に減り、2Dでは同一矩形の
            重ね描きが消えるが、3D は自前で段へ展開する必要がある。
        metrics: `{location_id: {slot: value}}`。省略時は全スロット ``None`` の穴。

    Returns:
        `{"type": "FeatureCollection", "features": [...], "bbox": [...], "whsim": {...}}`。
        `"whsim"` は RFC 7946 §6.1 が認める foreign member で、単位・原点・y の向きを
        自己記述する (GeoJSON は既定で WGS84 経緯度なので、そうでないことを必ず書く)。

    never-blocks: ロケーション0件なら features が空の valid な FeatureCollection。
    """
    if level_mode not in LEVEL_MODES:
        raise ValueError(f"level_mode must be one of {LEVEL_MODES}, got {level_mode!r}")
    rows = _rows(model)
    features = (_features_per_level(rows) if level_mode == "per-level"
                else _features_grouped(rows))
    bounds = getattr(getattr(model, "layout", None), "bounds", None)
    fc: dict = {
        "type": "FeatureCollection",
        "features": features,
        "whsim": {
            "schema_version": SCHEMA_VERSION,
            "generated_by": "whsim.geoexport",
            "level_mode": level_mode,
            "metric_slots": list(METRIC_SLOTS),
            "units": "m",
            "origin": "bottom-left",
            "y_axis": "up",
            # NOT WGS84: これは倉庫ローカルのメートル座標。RFC 7946 は既定 CRS を
            # WGS84 とするので、消費側は projection:identity 等で受けること
            # (identity 投影は y を反転しないので reflectY:true が必要 / 素の
            # linear スケールなら不要 — docs/geojson-export.md)。
            "crs_note": "local warehouse metres (not WGS84)",
            "feature_count": len(features),
            "location_count": len(rows),
        },
    }
    if bounds is not None:
        fc["whsim"]["bounds"] = {"width": float(bounds.width), "depth": float(bounds.depth)}
    bbox = _bbox(features)
    if bbox is not None:
        fc["bbox"] = bbox
    return attach_metrics(fc, metrics) if metrics else fc


def _features_per_level(rows: list[dict]) -> list[dict]:
    """案A: 1 Feature = 間口1つ (同一ポリゴンが段数分だけ重複する)。"""
    out = []
    for r in rows:
        out.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [_ring(r)]},
            "properties": {
                "location_id": r["location_id"],
                "level": r["level"],
                "area": r["area"],
                "rack_no": r["rack_no"],
                "aisle": r["aisle"],
                "zone": r["zone"],
                "name": r["name"],
                "rack_type": r["rack_type"],
                "metrics": _empty_metrics(),
            },
        })
    return out


def _features_grouped(rows: list[dict]) -> list[dict]:
    """案B: 1 Feature = 棚の1間口列。段は `levels` 配列に畳む。

    グループ鍵は間口列の**中心座標**（＝段違いの間口が共有する唯一の物理的事実）。
    `location_id` はその列の最下段のロケーションIDで、一意性は保たれる。全段の ID は
    `location_ids` に残すので、`attach_metrics` は段別の実績を列へ集計できる。
    """
    groups: dict[tuple[float, float], list[dict]] = {}
    for r in rows:
        groups.setdefault((r["cx"], r["cy"]), []).append(r)
    out = []
    for members in groups.values():
        members = sorted(members, key=lambda m: (m["level"], m["location_id"]))
        head = members[0]
        out.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [_ring(head)]},
            "properties": {
                "location_id": head["location_id"],
                "location_ids": [m["location_id"] for m in members],
                "level": None,                       # 段は畳んだので単一の値を持たない
                "levels": [m["level"] for m in members],
                "level_count": len(members),
                "area": head["area"],
                "rack_no": head["rack_no"],
                "aisle": head["aisle"],
                "zone": head["zone"],
                "name": head["name"],
                "rack_type": head["rack_type"],
                "metrics": _empty_metrics(),
            },
        })
    return out


def _bbox(features: list[dict]) -> list[float] | None:
    """[minx, miny, maxx, maxy] over the emitted geometries (RFC 7946 §5)."""
    xs: list[float] = []
    ys: list[float] = []
    for f in features:
        for ring in f["geometry"]["coordinates"]:
            for x, y in ring:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return [_r(min(xs)), _r(min(ys)), _r(max(xs)), _r(max(ys))]


def attach_metrics(fc: dict, metrics_by_location_id: dict | None) -> dict:
    """数値属性スロットを埋めた**新しい** FeatureCollection を返す (非破壊)。

    入力の `fc` は変更しない (deep copy)。`metrics_by_location_id` は
    `{location_id: {"lines": 12, "stock": 340, …}}`。与えられたスロットだけを
    上書きし、他のスロットは穴 (None) のまま残す — 「まだ取り込んでいない」と
    「ゼロだった」を混同しないため。

    grouped モードの Feature は `location_ids` を持つので、**段別の実績を列へ合算**
    する (数値のみ加算。全段が None のスロットは None のまま)。未知の location_id は
    黙って無視する (never-blocks)。
    """
    out = copy.deepcopy(fc)
    table = metrics_by_location_id or {}
    if not table:
        return out
    for f in out.get("features", []):
        props = f.setdefault("properties", {})
        slots = props.setdefault("metrics", _empty_metrics())
        ids = props.get("location_ids") or [props.get("location_id")]
        contributions = [table.get(lid) or {} for lid in ids]
        keys = list(slots.keys())
        for c in contributions:                      # 未知のスロット名も受け入れる
            for k in c:
                if k not in keys:
                    keys.append(k)
        for key in keys:
            total = None
            for c in contributions:
                v = c.get(key)
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    total = v if total is None else total + v
            if total is not None:
                slots[key] = total
    return out


def metrics_from_orders(model) -> dict[str, dict]:
    """出荷実績と在庫から間口別の数値属性を実測する (`{location_id: {...}}`)。

    * ``lines`` — その間口を引く**出荷行数** (`orders.outbound[].lines`)。
    * ``picks`` — 同じく**ピース数** (行の qty 合計)。
    * ``stock`` — 現在庫 (`Location.qty`)。

    SKU→間口の写像は `Location.sku`（棚割りの実体）を優先し、無ければ
    `Item.default_location` で補う。実績が無ければそのスロットは**出さない**
    (= 穴のまま。0 と「未取込」を混同しない)。
    """
    locs = list(getattr(model, "locations", []) or [])
    if not locs:
        return {}
    loc_of_sku: dict[str, str] = {}
    for loc in locs:
        sku = getattr(loc, "sku", None)
        if sku:
            loc_of_sku.setdefault(sku, loc.id)
    known = {loc.id for loc in locs}
    for it in getattr(model, "items", []) or []:
        if it.sku and it.default_location in known:
            loc_of_sku.setdefault(it.sku, it.default_location)

    orders = list(getattr(getattr(model, "orders", None), "outbound", []) or [])
    has_stock = any(int(getattr(loc, "qty", 0) or 0) for loc in locs)
    out: dict[str, dict] = {}
    for loc in locs:
        row: dict = {}
        if orders:
            row["lines"] = 0
            row["picks"] = 0
        if has_stock:
            row["stock"] = int(getattr(loc, "qty", 0) or 0)
        if row:
            out[loc.id] = row
    if orders:
        for o in orders:
            for ln in o.lines:
                lid = loc_of_sku.get(ln.sku)
                if lid in out:
                    out[lid]["lines"] += 1
                    out[lid]["picks"] += int(ln.qty or 0)
    return out


def to_layout_csv(model, metrics: dict | None = None) -> str:
    """間口1行の CSV (BOM 付き UTF-8) — Power BI / Deneb の実務の入口。

    列は `CSV_COLUMNS` ＋ 数値属性スロット。`x`/`y` は**矩形の左下角**（原点側）で、
    `w`/`d` を足すと右上角になる。GeoJSON のポリゴンと**同じ `_rows` から**出るので、
    2つの表現が食い違うことはない。

    never-blocks: ロケーション0件ならヘッダ行だけを返す。
    """
    rows = _rows(model)
    table = metrics or {}
    extra = [k for k in METRIC_SLOTS]
    for row in table.values():
        for k in row:
            if k not in extra:
                extra.append(k)
    buf = io.StringIO()
    # Excel/Power BI の取込は CRLF を素直に読む (Windows が実務の現場)。
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(list(CSV_COLUMNS) + extra)
    for r in rows:
        vals = [r[c] for c in CSV_COLUMNS]
        m = table.get(r["location_id"]) or {}
        w.writerow(vals + ["" if m.get(k) is None else m[k] for k in extra])
    return BOM + buf.getvalue()


# --------------------------------------------------------------------------- #
# Power BI star schema: runs dimension + KPI facts (long format)
# --------------------------------------------------------------------------- #
# The floor visual reads layout.csv (one row per 間口). The KPI side of a Power
# BI model wants the OTHER star: a runs dimension (who/when/which scenario) and
# a long fact table (run_id × kpi × value) so a measure is one filter away and
# a new KPI never adds a column. Values are copied verbatim out of each run's
# own kpis.json / summary.json — this module aggregates nothing (invariant:
# every displayed number is an event-log aggregate computed by kpis.compute).

# Dimension columns for runs.csv. "source" tells the analyst which artifact the
# row came from (project run vs headless lab run) — the two ledgers coexist.
RUNS_DIM_COLUMNS = ("run_id", "source", "name", "started", "seed",
                    "scenario_hash", "verdict")
KPI_FACTS_COLUMNS = ("run_id", "kpi", "value")


def _flatten_numeric(kpis: dict, prefix: str = "") -> list[tuple[str, float]]:
    """Numeric leaves of a KPI dict as ``(dotted_key, value)`` rows.

    Nested read-outs (``kpis["conveyors"]["spur1n"]["block_ratio"]``…) flatten to
    dotted keys so belt-level facts survive the long format. Booleans are skipped
    (they are verdict inputs, not measures); strings are skipped (the verdict
    sentence lives in the runs dimension, not the fact table).
    """
    out: list[tuple[str, float]] = []
    for k, v in (kpis or {}).items():
        key = f"{prefix}{k}"
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)):
            if math.isfinite(float(v)):
                out.append((key, float(v)))
        elif isinstance(v, dict):
            out.extend(_flatten_numeric(v, prefix=f"{key}."))
    return out


def project_run_summaries(project) -> list[dict]:
    """One summary dict per stored run of a Project (oldest first).

    Shaped like ``whsim.sim`` summaries (run_id/name/started/seed/kpis) so the
    same CSV writers serve both ledgers. Runs whose ``kpis.json`` is missing or
    unreadable are skipped — an old artifact must not block today's export.
    """
    out: list[dict] = []
    for _idx, rd in project._run_dirs():
        try:
            kpis = json.loads((rd / "kpis.json").read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        cfg = {}
        try:
            cfg = json.loads((rd / "config.json").read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
        out.append({
            "run_id": rd.name, "source": "project",
            "name": project.meta().get("name", "") if hasattr(project, "meta") else "",
            "started": _dt.datetime.fromtimestamp(  # noqa: DTZ006 — local artifact clock
                rd.stat().st_mtime).isoformat(timespec="seconds"),
            "seed": cfg.get("random_seed"),
            "scenario_hash": "",
            "kpis": kpis,
        })
    return out


def to_runs_csv(summaries) -> str:
    """runs.csv — the dimension table (BOM付きUTF-8, one row per run)."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(RUNS_DIM_COLUMNS)
    for s in summaries or ():
        kpis = s.get("kpis") or {}
        w.writerow([s.get("run_id", ""), s.get("source", "lab"),
                    s.get("name", ""), s.get("started", ""),
                    s.get("seed", ""), s.get("scenario_hash", ""),
                    kpis.get("verdict", "")])
    return "﻿" + buf.getvalue()


def to_kpi_facts_csv(summaries) -> str:
    """kpi_facts.csv — long format (run_id × kpi × value), values verbatim."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(KPI_FACTS_COLUMNS)
    for s in summaries or ():
        rid = s.get("run_id", "")
        for key, val in _flatten_numeric(s.get("kpis") or {}):
            w.writerow([rid, key, val])
    return "﻿" + buf.getvalue()
