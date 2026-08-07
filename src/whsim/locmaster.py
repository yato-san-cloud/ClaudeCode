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

from whsim import racktypes

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
#
# MapMaker カスタム版 の「ロケーションマスタ Excel出力」はこの並びで出る
# （v4.10 で末尾に「ゾーン」列が追加された。既存列の位置は不変）:
#     エリア,列,棚,段,間口,フルロケ,X,Y,什器種別,什器名,面積[,ゾーン]
# 全列がこの表で拾える。想定した列名は docs/mapmaker-v5-import.md に一覧。
_COLS = {
    "full": ("フルロケ", "ロケーション", "ロケ", "location", "locationcode", "loc"),
    "area": ("エリア", "area"),
    "col": ("列", "通路", "aisle", "col"),
    "bay": ("棚", "連", "bay"),
    "level": ("段", "level", "tier"),
    "face": ("間口", "face", "slot"),
    "x": ("x_mm", "x", "xmm"),
    "y": ("y_mm", "y", "ymm"),
    "gear": ("什器種別", "什器", "設備種別", "racktype", "gear"),
    "gear_name": ("什器名", "設備名", "gearname"),
    # v4.10 追加。棚グループの値 = WMS のゾーン別ピッキング/搬送区分。
    "zone": ("ゾーン", "zone", "棚グループ", "グループ", "zonecode", "group"),
    # footprint 面積 (m²)。「面積」は「エリア」より先に解決する（"area_m2" が
    # エリア列として拾われるのを防ぐ）。
    "m2": ("面積", "footprint_m2", "面積m2", "footprintm2", "area_m2", "m2"),
}

# The exact MapMaker header set (folded). Seeing all of these means the file came
# straight out of「ロケーションマスタ Excel出力」and its X/Y are real mm coordinates
# we can place from directly — no drawing needed.
_MAPMAKER_HEADER = ("エリア", "列", "棚", "段", "間口", "フルロケ", "x", "y",
                    "什器種別", "什器名", "面積")


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


def _pick(cols: Iterable[str], keys: tuple[str, ...],
          used: Iterable[str] | None = None) -> str | None:
    """First column matching one of `keys`, skipping any column already claimed.

    `used` matters because the alias sets overlap in real headers: a column named
    ``area_m2`` contains "area", so without an exclusion it would be taken as the
    エリア column and the whole address would fall apart.
    """
    taken = {c for c in (used or ()) if c}
    folded = {_fold(c): c for c in cols if c not in taken}
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
    # Resolve the two "greedy" aliases FIRST and hide them from the rest: 面積
    # and ゾーン both collide with エリア under substring matching.
    c_m2 = _pick(cols, _COLS["m2"])
    c_zone = _pick(cols, _COLS["zone"], used=[c_m2])
    used = [c_m2, c_zone]
    c_full = _pick(cols, _COLS["full"], used=used)
    c_area, c_col, c_bay = (_pick(cols, _COLS[k], used=used)
                            for k in ("area", "col", "bay"))
    c_lvl = _pick(cols, _COLS["level"], used=used)
    c_face = _pick(cols, _COLS["face"], used=used)
    c_x, c_y = _pick(cols, _COLS["x"], used=used), _pick(cols, _COLS["y"], used=used)
    c_gear = _pick(cols, _COLS["gear"], used=used)
    c_gear_name = _pick(cols, _COLS["gear_name"], used=[*used, c_gear])

    folded_cols = {_fold(c) for c in cols}
    is_mapmaker = all(h in folded_cols for h in _MAPMAKER_HEADER)

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
        e = agg.setdefault(key, {"name": key, "levels": set(), "faces": set(),
                                 "gear": [], "gear_name": [], "zone": [],
                                 "m2": [], "x_mm": [], "y_mm": [], "slots": 0})
        e["slots"] += 1
        for c, k in ((c_lvl, "levels"), (c_face, "faces")):
            if c is None:
                continue
            try:
                e[k].add(int(str(r[c]).strip()))
            except (TypeError, ValueError):
                pass
        for c, k in ((c_gear, "gear"), (c_gear_name, "gear_name"), (c_zone, "zone")):
            if c is not None:
                e[k].append(str(r[c]).strip())
        for c, k in ((c_x, "x_mm"), (c_y, "y_mm"), (c_m2, "m2")):
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
        # 段数 = パレット段数（MapMaker v4.9 統一規約）。マスタは 1 段 1 行なので
        # 「段」の異なり数がそのまま段数。逆ネスも段数で出ている（基数=段数−1）。
        lv = max(1, min(len(e["levels"]) or 1, 20))
        faces = max(1, min(len(e["faces"]) or max(1, e["slots"] // max(1, lv)), 200))
        zone = max(set(e["zone"]), key=e["zone"].count) if any(e["zone"]) else ""
        rec = {"name": key, "levels": lv, "faces": faces, "slots": e["slots"],
               "gear": gear, "rack_type": rack, "zone": zone,
               "gear_name": (max(set(e["gear_name"]), key=e["gear_name"].count)
                             if any(e["gear_name"]) else ""),
               "in_layout": (key in known) if known else None}
        if e["m2"]:
            s = sorted(e["m2"])
            rec["area_m2"] = s[len(s) // 2]
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
    elif is_mapmaker:
        warnings.append("MapMaker のロケーションマスタ出力を認識しました。"
                        "X/Y（mm）から直接配置できます（図面が無くても可）。")
    if c_zone is not None:
        warnings.append("ゾーン列（棚グループ）をロケーションのゾーンに割り当てました。")
    return {"locations": out,
            "warnings": warnings,
            "stats": {"rows": int(len(df)), "shelves": len(out), "placed": matched,
                      "slots": int(sum(e["slots"] for e in agg.values())),
                      "unit": "mm", "mapmaker": is_mapmaker,
                      "has_xy": bool(c_x and c_y), "columns_used": {
                          "full": c_full, "area": c_area, "col": c_col, "bay": c_bay,
                          "level": c_lvl, "face": c_face, "x": c_x, "y": c_y,
                          "gear": c_gear, "gear_name": c_gear_name,
                          "m2": c_m2, "zone": c_zone}}}


# --------------------------------------------------------------------------- #
# Direct placement from the master's own X/Y (MapMaker 出力の第二経路)
# --------------------------------------------------------------------------- #
# The master's X/Y is the SHELF centre. MapMaker's rmpm/DXF write rectangles by
# their top-left corner, but a location master row describes a *slot*, and the
# representative point of a slot is its middle — placing a run by its corner
# would shift every shelf by half a footprint. Overridable, and listed in
# docs/mapmaker-v5-import.md as the assumption for the MapMaker author to confirm.
COORD_CENTER = "center"
COORD_TOPLEFT = "topleft"


def build_layout(records: Iterable[dict], coord: str = COORD_CENTER,
                 zone_id: str = "storage") -> dict:
    """Build a layout **from the master alone**, using its X/Y (mm→m already).

    This is the second, independent path into whsim: the existing one matches a
    master against an imported DRAWING (`apply_to_model`) and can only place what
    the drawing already has. MapMaker's own ロケーションマスタ carries real
    coordinates, so a customer who sends only the CSV still gets a floor.

    Footprint, which the master does not state: depth comes from the equipment
    preset, width from 面積 ÷ depth when the 面積 column is present and from
    間口数 × bay pitch otherwise. Orientation is unknown, so runs are laid along
    +x (the 間口 face down) — the designer tab can rotate them.

    Returns the usual ``{bounds, zones, warnings, stats}`` importer shape.
    """
    recs = [r for r in records
            if r.get("x") is not None and r.get("y") is not None]
    warnings: list[str] = []
    if not recs:
        return {"bounds": None, "zones": [], "warnings": [
            "X/Y 座標を持つ行がないため、直接配置はできませんでした。"
            "先にレイアウト（MapMaker/CAD）を取り込んでください。"],
            "stats": {"shelves": 0}}

    boxes: list[tuple[dict, float, float, float, float]] = []
    for r in recs:
        rtid = str(r.get("rack_type") or racktypes.DEFAULT)
        rt = racktypes.get(rtid)
        depth = float(rt["depth"])
        area = r.get("area_m2")
        faces = max(1, int(r.get("faces") or 1))
        if area and float(area) > 0:
            width = float(area) / depth
        else:
            width = faces * float(rt["bay"])
        width = max(0.3, min(width, 200.0))
        cx, cy = float(r["x"]), float(r["y"])
        if coord == COORD_TOPLEFT:
            x0, y0 = cx, cy
        else:
            x0, y0 = cx - width / 2.0, cy - depth / 2.0
        boxes.append((r, x0, y0, width, depth))

    minx = min(b[1] for b in boxes)
    miny = min(b[2] for b in boxes)
    # Keep the drawing's own origin when it is already non-negative: a WMS master
    # and the drawing it came from must land on the same coordinates or the two
    # import paths would disagree about where the warehouse is.
    ox, oy = (min(minx, 0.0), min(miny, 0.0))
    shelves = []
    for i, (r, x0, y0, w, d) in enumerate(boxes):
        shelves.append({"id": f"m{i}", "name": str(r.get("name") or ""),
                        "x": round(x0 - ox, 3), "y": round(y0 - oy, 3),
                        "w": round(w, 3), "h": round(d, 3),
                        "rack_type": str(r.get("rack_type") or racktypes.DEFAULT),
                        "facing": "down"})
    width = max(round(max(s["x"] + s["w"] for s in shelves), 3), 1.0)
    depth = max(round(max(s["y"] + s["h"] for s in shelves), 3), 1.0)
    bounds = {"width": width, "depth": depth}
    zones = [{"id": zone_id, "type": "storage", "x": 0.0, "y": 0.0,
              "w": width, "h": depth, "rack": None, "shelves": shelves}]
    warnings.append(f"ロケーションマスタの X/Y から {len(shelves)} 棚を直接配置しました"
                    f"（基準={'中心' if coord == COORD_CENTER else '左上'}）。"
                    "奥行は什器プリセット、幅は面積÷奥行（無ければ間口×間口幅）です。")
    return {"bounds": bounds, "zones": zones, "warnings": warnings,
            "stats": {"shelves": len(shelves), "coord": coord}}


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
        # v4.10 の「ゾーン」列（棚グループ）があればそれを使う。WMS のゾーン別
        # ピッキング/搬送区分がそのまま whsim のロケーションのゾーンになる。
        zn = str(rec.get("zone") or "").strip() or "storage"
        for level in range(1, int(rec.get("levels") or 1) + 1):
            locs.append(Location(
                id=f"L{len(locs)}", name=sh.name, address=f"{sh.name}-{level:02d}",
                level=level, zone=zn,
                x=float(sh.x) + float(sh.w) / 2.0,
                y=float(sh.y) + float(sh.h) / 2.0,
                type="pallet" if rt in ("pallet", "nestainer") else "shelf",
                rack_type=rt, capacity=120))
    model.locations = locs
    return {"shelves_placed": placed, "locations": len(locs)}
