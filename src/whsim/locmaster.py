"""Tolerant importer for a WMS **ロケーションマスタ** (location master) export.

A location master is the table a WMS can always produce: one row per addressable
slot, with the address split into its parts and (usually) a physical coordinate
and the equipment it sits in::

    エリア,列,棚,段,間口,フルロケ,X_mm,Y_mm,什器種別,什器名,footprint_m2
    AAA,00,02,01,01,AAA-00-02-01-01,1874,21631,中量棚,中量棚1800x600,0.43

whsim could already take a *drawing* (MapMaker/CAD → named shelf rectangles) and
a *shipment history* (→ orders), but there was nothing to connect them: the
drawing knows where shelf `AAA-00-02` is, the history knows that a line was
picked from `AAA-00-02-3-01`, and nothing knew that those are the same place.
So every imported layout was furniture — real racks with invented contents.

Two things make the join work, and both are the whole reason this module exists:

1. **The address formats do not match by default.** The master zero-pads every
   part (`AAA-00-02-01-01`); the history usually does not (`AAA-00-02-3-01`).
   Compared verbatim, a real customer's two files agree on ZERO rows. Normalise
   each part to two digits and they agree.
2. **The drawing's granularity is the shelf, not the slot.** A MapMaker
   FreeShelfObject is named `エリア-列-棚`; the master addresses go down to
   段/間口. Joining at the shelf level (the first three parts) is what actually
   lands — on the case this was built from, 54% of history lines resolve to a
   drawn shelf, versus 0% at slot level.

House style: tolerant. Rows we cannot place are counted and skipped, never
fatal — a partial import is normal and useful. Returns the same
``{locations, warnings, stats}`` shape the other importers use.
"""

from __future__ import annotations

from collections.abc import Iterable

# 什器種別 → whsim.racktypes id. Anything unrecognised falls back to "medium",
# which is the shape most Japanese 3PL shelving actually is.
GEAR_TO_RACK: dict[str, str] = {
    "中量棚": "medium",
    "軽量棚": "light",
    "重量棚": "pallet",
    "パレットラック": "pallet",
    "ネステナー": "nestainer",
    "ネステナー（逆ネス）": "nestainer",
    "逆ネス": "nestainer",
    "移動ラック": "mobile",
    "流動棚": "flow",
    "フローラック": "flow",
    "メザニン": "mezzanine",
    "ハンガー": "hanger",
    "自動倉庫": "asrs",
}
# Column aliases, lower-cased and NFKC-folded before matching.
_COLS = {
    "full": ("フルロケ", "ロケーション", "ロケ", "location", "locationcode", "loc"),
    "area": ("エリア", "area", "zone"),
    "col": ("列", "通路", "aisle", "col"),
    "bay": ("棚", "連", "bay"),
    "level": ("段", "level", "tier"),
    "face": ("間口", "face", "slot"),
    "x": ("x_mm", "x", "xmm"),
    "y": ("y_mm", "y", "ymm"),
    "gear": ("什器種別", "什器", "設備種別", "racktype", "gear"),
    "gear_name": ("什器名", "設備名", "gearname"),
}


def _fold(s: object) -> str:
    import unicodedata

    return unicodedata.normalize("NFKC", str(s)).strip().lower().replace(" ", "")


def normalize_loc(code: object, parts: int = 3) -> str | None:
    """`AAA-07-03-1-08` and `AAA-07-03-01-01` both → `AAA-07-03`.

    `parts` is how much of the address to keep: 3 = shelf (what a drawing knows),
    4 = shelf+段, 5 = the full slot. Every part after the area is zero-padded to
    two digits, which is the difference between a join that works and one that
    returns nothing.
    """
    p = [x for x in str(code).strip().split("-")]
    if len(p) < parts or not p[0]:
        return None
    return p[0] + "-" + "-".join(x.strip().zfill(2) for x in p[1:parts])


def _pick(cols: Iterable[str], keys: tuple[str, ...]) -> str | None:
    folded = {_fold(c): c for c in cols}
    for k in keys:
        if k in folded:
            return folded[k]
    for fk, orig in folded.items():          # substring fallback (「ﾛｹｰｼｮﾝ」等)
        if any(k in fk for k in keys):
            return orig
    return None


def import_locmaster_bytes(data: bytes, filename: str = "loc.csv",
                           shelf_names: Iterable[str] | None = None) -> dict:
    """Parse a location master into placeable location records.

    ``shelf_names`` is the set of shelf names the layout actually has (from a
    MapMaker/CAD import). When given, every row is checked against it and the
    stats report how much of the master the drawing can actually hold — the
    number that tells you whether the two files are describing the same site.
    """
    from whsim.analysis import data_io

    warnings: list[str] = []
    df = data_io.load_table(data, filename)
    if df is None or df.empty:
        return {"locations": [], "warnings": ["ロケーションマスタが空でした。"],
                "stats": {"rows": 0, "placed": 0}}
    cols = list(df.columns)
    c_full = _pick(cols, _COLS["full"])
    c_area, c_col, c_bay = (_pick(cols, _COLS[k]) for k in ("area", "col", "bay"))
    c_lvl = _pick(cols, _COLS["level"])
    c_x, c_y = _pick(cols, _COLS["x"]), _pick(cols, _COLS["y"])
    c_gear = _pick(cols, _COLS["gear"])

    if c_full is None and not (c_area and c_col and c_bay):
        return {"locations": [],
                "warnings": ["ロケーション列（フルロケ、または エリア/列/棚）が"
                             "見つかりませんでした。列名をご確認ください。"],
                "stats": {"rows": int(len(df)), "placed": 0, "columns": cols[:20]}}

    def row_key(r) -> str | None:
        if c_full is not None:
            return normalize_loc(r[c_full])
        return normalize_loc(f"{r[c_area]}-{r[c_col]}-{r[c_bay]}")

    known = {str(s).strip() for s in (shelf_names or ())}
    agg: dict[str, dict] = {}
    bad = 0
    for r in df.to_dict("records"):
        key = row_key(r)
        if not key:
            bad += 1
            continue
        e = agg.setdefault(key, {"name": key, "levels": set(), "gear": [],
                                 "x_mm": [], "y_mm": [], "slots": 0})
        e["slots"] += 1
        if c_lvl is not None:
            try:
                e["levels"].add(int(str(r[c_lvl]).strip()))
            except (TypeError, ValueError):
                pass
        if c_gear is not None:
            e["gear"].append(str(r[c_gear]).strip())
        for c, k in ((c_x, "x_mm"), (c_y, "y_mm")):
            if c is None:
                continue
            try:
                e[k].append(float(r[c]))
            except (TypeError, ValueError):
                pass

    out: list[dict] = []
    matched = 0
    for key, e in sorted(agg.items()):
        gear = max(set(e["gear"]), key=e["gear"].count) if e["gear"] else ""
        rack = GEAR_TO_RACK.get(gear, "medium")
        lv = max(1, min(len(e["levels"]) or 1, 20))
        rec = {"name": key, "levels": lv, "slots": e["slots"],
               "gear": gear, "rack_type": rack,
               "in_layout": (key in known) if known else None}
        # mm → m, median (a shelf's rows all share one coordinate in practice, but
        # a median survives a stray typo without dragging the shelf across the floor).
        for c, k in ((c_x, "x_mm"), (c_y, "y_mm")):
            if c is not None and e[k]:
                s = sorted(e[k])
                rec[k[0]] = s[len(s) // 2] / 1000.0
        if rec["in_layout"]:
            matched += 1
        out.append(rec)

    if bad:
        warnings.append(f"ロケーション書式を解釈できない行 {bad} 件を読み飛ばしました。")
    if known:
        warnings.append(
            f"図面の棚に一致したロケーション: {matched}/{len(out)}"
            f"（{matched / max(1, len(out)) * 100:.0f}%）。"
            "一致しないものは平置き・仮想エリア等で、図面に棚がありません。")
    if c_x is None or c_y is None:
        warnings.append("X/Y 座標列が無いため、位置は図面の棚に従います。")
    return {"locations": out,
            "warnings": warnings,
            "stats": {"rows": int(len(df)), "shelves": len(out), "placed": matched,
                      "slots": int(sum(e["slots"] for e in agg.values())),
                      "unit": "mm", "columns_used": {
                          "full": c_full, "area": c_area, "col": c_col, "bay": c_bay,
                          "level": c_lvl, "x": c_x, "y": c_y, "gear": c_gear}}}


def apply_to_model(model, records: Iterable[dict]) -> dict:
    """Materialise `model.locations` from imported master records.

    Only shelves the layout actually has get locations: a location whose shelf is
    not on the drawing has no place to be, and inventing one would put stock in a
    part of the building that does not exist. The coordinate comes from the
    DRAWING, not from the master's X/Y — the 3D racking geometry is built from
    the drawing, so a master coordinate that disagrees by even a few centimetres
    leaves the stock floating beside its own shelf.
    """
    from whsim.schema.model import Location

    shelves = {str(s.name).strip(): s
               for z in model.layout.zones for s in z.shelves if str(s.name).strip()}
    locs: list[Location] = []
    placed = 0
    for rec in records:
        sh = shelves.get(str(rec.get("name", "")).strip())
        if sh is None:
            continue
        placed += 1
        rt = str(rec.get("rack_type") or "medium")
        for level in range(1, int(rec.get("levels") or 1) + 1):
            locs.append(Location(
                id=f"L{len(locs)}", name=sh.name, address=f"{sh.name}-{level:02d}",
                level=level, zone="storage",
                x=float(sh.x) + float(sh.w) / 2.0,
                y=float(sh.y) + float(sh.h) / 2.0,
                type="pallet" if rt in ("pallet", "nestainer") else "shelf",
                rack_type=rt, capacity=120))
    model.locations = locs
    return {"shelves_placed": placed, "locations": len(locs)}
