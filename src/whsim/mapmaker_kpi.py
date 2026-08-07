"""Tolerant importer for MapMaker カスタム版 の **3D/KPI用データ書き出し（JSON）**.

MapMaker (カスタム版 v4.x–v5.1β) can write, per shelf, "ロケ番号・座標・footprint・
什器種別（自動判定）・段数・概算全高・パレット収納力／棚板面積" as JSON, plus the
surrounding shell (壁・階段等). Units are **mm**, origin **top-left**, **x right+ /
y down+** — the same frame as ``.rmpm`` (see :mod:`whsim.rmpm`).

**We have no real sample of this file.** The manual states the *meanings* of the
fields, not their JSON key spelling, so this module matches keys by **meaning**
through an alias table (:data:`FIELD_ALIASES` / :data:`CONTAINER_ALIASES`) folded
to a canonical form (NFKC, lower-case, separators stripped). Anything we cannot
place is *counted and reported* — never fatal — and every unrecognised key is
listed in the result's ``probe`` block so the MapMaker author can answer
"you guessed X, we actually write Y" in one pass. The guesses are tabulated in
``docs/mapmaker-v5-import.md``.

段数の数え方（MapMaker v4.9 で統一された規約 — whsim もこれに合わせる）:

* **段数 = パレット段数（ロケ段数）**。什器マスタに段数が入っていればその値で、
  0 のときだけ天井有効高から自動算出された値が書き出されている。
* **逆ネステナーは 基数 = 段数 − 1**（段数 = 基数 + 1）。KPI JSON が「ネス基数」を
  持っていて段数を持っていない場合のみ、段数 = 基数 + 1 として復元する。
* **有効ロケ数 = 間口数 × 段数**（未使用指定を除く）。この積が whsim の
  ``model.locations`` の件数になる（``design.materialize_racks`` の段数と同義）。

Returns the ``{bounds, zones, walls, stations, warnings, stats}`` shape every
other whsim importer returns, plus ``conveyors`` (v4.9 コンベア), ``locations``
(段×間口 に展開済み) and ``probe``.
"""

from __future__ import annotations

import json
import math
import unicodedata
from typing import Any

from whsim import racktypes
from whsim.locmaster import GEAR_TO_RACK

# --------------------------------------------------------------------------- #
# Key folding + alias tables
# --------------------------------------------------------------------------- #
_STRIP = "_- \t　[](){}<>:/\\.,"


def fold(key: object) -> str:
    """Canonical form of a JSON key: NFKC, lower-case, separators removed.

    ``"X_mm"``/``"座標Ｘ"``/``"x [mm]"`` all collapse onto something we can match
    against the alias table, so a spelling difference never costs a field."""
    s = unicodedata.normalize("NFKC", str(key)).strip().lower()
    return "".join(c for c in s if c not in _STRIP)


def _aliases(*names: str) -> tuple[str, ...]:
    return tuple(fold(n) for n in names)


# Top-level (or per-floor) arrays. First match wins; a bare JSON array is read
# as the shelf list.
CONTAINER_ALIASES: dict[str, tuple[str, ...]] = {
    "shelves": _aliases("shelves", "shelf", "racks", "rack", "fixtures", "fixture",
                        "棚", "棚一覧", "什器", "什器一覧", "objects", "items",
                        "locations", "shelfList", "rackList", "data"),
    "walls": _aliases("walls", "wall", "壁", "壁一覧"),
    "stations": _aliases("stations", "station", "検品場", "検品台", "ステーション",
                         "inspection", "workstations"),
    "stairs": _aliases("stairs", "stair", "階段"),
    "conveyors": _aliases("conveyors", "conveyor", "コンベア", "コンベヤ", "belts"),
    "meta": _aliases("meta", "header", "params", "parameters", "settings",
                     "計算前提", "前提", "warehouse", "倉庫パラメータ"),
    "floors": _aliases("floors", "floor", "フロア", "フロア一覧"),
}

# Per-record fields, by MEANING. Order matters only inside one entry.
FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    # ロケ番号 / 棚名 — the join key against a 出荷履歴 or ロケーションマスタ.
    "name": _aliases("loc", "locno", "locNo", "locationNo", "location", "locationCode",
                     "ロケ", "ロケ番号", "ロケーション", "フルロケ", "棚名", "棚番号",
                     "shelfName", "shelfId", "rackName", "name", "code"),
    "id": _aliases("id", "objectId", "oid", "uid"),
    # 座標 (mm, 原点左上, x右+/y下+)
    "x": _aliases("x", "xmm", "x_mm", "left", "posX", "座標X", "x1"),
    "y": _aliases("y", "ymm", "y_mm", "top", "posY", "座標Y", "y1"),
    "cx": _aliases("cx", "centerX", "centreX", "中心X", "midX"),
    "cy": _aliases("cy", "centerY", "centreY", "中心Y", "midY"),
    # footprint (mm)
    "w": _aliases("w", "width", "wmm", "w_mm", "幅", "間口幅", "sizeX", "dx",
                  "footprintW", "footprintWidth"),
    "d": _aliases("d", "depth", "dmm", "d_mm", "奥行", "奥行き", "sizeY", "dy",
                  "footprintD", "footprintDepth"),
    # ``h`` is context-sensitive: an rmpm-style rect uses w/h for the footprint,
    # but a 3D record uses h for 全高. Resolved in `_footprint` below.
    "h": _aliases("h", "hmm", "h_mm"),
    "footprint": _aliases("footprint", "フットプリント", "設置面積", "占有面積"),
    # 概算全高 (mm) — the extrusion height for 3D.
    "height": _aliases("height", "totalHeight", "overallHeight", "全高", "概算全高",
                       "heightMm", "outerHeight", "外寸高さ", "外寸高さH", "topZ"),
    # 段数 = パレット段数（v4.9 統一規約）
    "levels": _aliases("levels", "level", "tiers", "tier", "stages", "danSu",
                       "段数", "段", "パレット段数", "ロケ段数", "nLevels"),
    # 逆ネス 基数（段数 − 1）。段数が無いときだけ +1 して段数に戻す。
    "nes_base": _aliases("nesBase", "nestainerBase", "ネス基数", "基数", "baseCount"),
    # 間口数
    "faces": _aliases("faces", "face", "bays", "bay", "openings", "間口", "間口数",
                      "nFaces", "slots"),
    # 有効ロケ数（= 間口 × 段数 − 未使用）
    "usable": _aliases("usable", "usableLocations", "有効ロケ", "有効ロケ数",
                       "effectiveSlots", "validLocations"),
    # 什器種別（自動判定）/ 什器名
    "gear": _aliases("gear", "type", "fixtureType", "kind", "category", "rackType",
                     "什器種別", "種別", "設備種別", "equipmentType"),
    "gear_name": _aliases("gearName", "fixtureName", "equipmentName", "什器名",
                          "設備名", "fixture", "什器"),
    # パレット収納力 / 棚板面積 (m²)
    "pallets": _aliases("pallets", "palletCapacity", "palletCount", "capacity",
                        "パレット収納力", "収納力", "収納パレット数", "パレット数"),
    "board_area": _aliases("boardArea", "shelfArea", "棚板面積", "保管棚板面積",
                           "area", "面積", "footprintArea", "m2", "面積m2"),
    # ゾーン（棚グループ, v4.10 でロケマスタにも追加された列）
    "zone": _aliases("zone", "group", "groupName", "ゾーン", "棚グループ", "グループ"),
    "floor": _aliases("floor", "floorName", "フロア", "フロア名"),
    # 壁など
    "wall_height": _aliases("height", "wallHeight", "高さ", "壁高", "heightMm"),
    # コンベア
    "points": _aliases("points", "nodes", "vertices", "path", "ポイント", "節点"),
    "speed": _aliases("speed", "speedMps", "速度", "搬送速度", "mps"),
}

# meta (計算前提) — informational; recorded in stats so numbers never travel alone.
META_ALIASES: dict[str, tuple[str, ...]] = {
    "unit": _aliases("unit", "units", "単位"),
    "ceiling_mm": _aliases("ceiling", "ceilingHeight", "天井有効高", "天井高",
                           "有効天井高"),
    "pallet_w": _aliases("palletW", "palletWidth", "パレット幅", "パレットW"),
    "pallet_d": _aliases("palletD", "palletDepth", "パレット奥行", "パレットD"),
    "pallet_h": _aliases("palletH", "palletHeight", "荷姿高", "パレット高"),
    "version": _aliases("version", "appVersion", "バージョン"),
    "profile": _aliases("profile", "出力プロファイル", "mode"),
}

# Keys we knowingly ignore (they carry no geometry/capacity meaning for whsim),
# so the probe's "unknown" list stays a genuine question list.
_IGNORED = set(_aliases(
    "color", "colorRGB", "rgb", "色", "editLock", "locked", "selected",
    "assetId", "管理番号", "所有区分", "支給元", "備考", "照合日", "資産ID",
    "note", "notes", "remark", "index", "seq", "no"))


def _num(v: Any) -> float | None:
    """Float or None (also rejects NaN/inf); never raises."""
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _int(v: Any) -> int | None:
    f = _num(v)
    return round(f) if f is not None else None


class _Reader:
    """Alias-driven record reader that also keeps a census of every key seen."""

    def __init__(self) -> None:
        self.seen: dict[str, int] = {}          # folded key -> count
        self.matched: dict[str, str] = {}       # canonical -> first raw key that hit
        self.unknown: dict[str, Any] = {}       # folded key -> a sample value

    def note(self, rec: dict) -> None:
        for k in rec:
            fk = fold(k)
            self.seen[fk] = self.seen.get(fk, 0) + 1

    def get(self, rec: dict, field: str) -> Any:
        """Value for a canonical field, or None. Records which raw key matched."""
        keys = FIELD_ALIASES.get(field, ())
        folded = {fold(k): k for k in rec}
        for a in keys:
            if a in folded:
                self.matched.setdefault(field, folded[a])
                return rec[folded[a]]
        return None

    def finish(self, records: list[dict]) -> None:
        """Everything no alias covers becomes a probe question.

        "Covered" means *any* canonical field lists it, not just the one that
        won in this file: a shelf spelling its name ``loc`` must not make the
        station's ``name`` look like an unknown key."""
        claimed = {a for keys in FIELD_ALIASES.values() for a in keys}
        claimed |= {a for keys in META_ALIASES.values() for a in keys}
        for rec in records:
            for k, v in rec.items():
                fk = fold(k)
                if fk in claimed or fk in _IGNORED or fk in self.unknown:
                    continue
                self.unknown[fk] = v if isinstance(v, (str, int, float, bool)) else "…"

    def probe(self) -> dict:
        return {
            "matched": dict(sorted(self.matched.items())),
            "unknown": [{"key": k, "count": self.seen.get(k, 0), "sample": v}
                        for k, v in sorted(self.unknown.items())],
            "keys_seen": dict(sorted(self.seen.items())),
        }


def _container(doc: dict, kind: str) -> list:
    """The list of records for `kind`, matched by alias; [] when absent."""
    folded = {fold(k): k for k in doc}
    for a in CONTAINER_ALIASES.get(kind, ()):
        if a in folded:
            v = doc[folded[a]]
            if isinstance(v, list):
                return [r for r in v if isinstance(r, dict)]
            if isinstance(v, dict):
                return [v]
    return []


def _meta(doc: dict) -> dict:
    """The 計算前提 block, flattened. Also accepts the values sitting top-level."""
    src: dict = {}
    for a in CONTAINER_ALIASES["meta"]:
        for k, v in doc.items():
            if fold(k) == a and isinstance(v, dict):
                src.update(v)
    merged = {**doc, **src}
    out: dict = {}
    folded = {fold(k): k for k in merged}
    for field, keys in META_ALIASES.items():
        for a in keys:
            if a in folded:
                v = merged[folded[a]]
                if isinstance(v, (str, int, float)):
                    out[field] = v
                break
    return out


def _footprint(rd: _Reader, rec: dict) -> tuple[float | None, float | None, float | None]:
    """(w, d, height) in raw units.

    ``h`` is ambiguous across plausible writers: an rmpm-style rectangle spells
    the footprint ``w``/``h``, while a 3D record spells it ``w``/``d`` and uses
    ``h`` for 全高. Rule: ``h`` is the footprint DEPTH only when the record has
    no explicit depth key; otherwise it is the height. Stated in
    docs/mapmaker-v5-import.md as an assumption to confirm.
    """
    w = _num(rd.get(rec, "w"))
    d = _num(rd.get(rec, "d"))
    h = _num(rd.get(rec, "h"))
    height = _num(rd.get(rec, "height"))
    fp = rd.get(rec, "footprint")
    if isinstance(fp, dict):
        fw = _num(fp.get("w") or fp.get("width"))
        fd = _num(fp.get("d") or fp.get("depth") or fp.get("h"))
        w, d = (w if w is not None else fw), (d if d is not None else fd)
    elif isinstance(fp, (list, tuple)) and len(fp) >= 2:
        w = w if w is not None else _num(fp[0])
        d = d if d is not None else _num(fp[1])
    if d is None and h is not None:
        d, h = h, None
    if height is None and h is not None:
        height = h
    return w, d, height


def _levels(rd: _Reader, rec: dict) -> int:
    """段数 (= パレット段数, v4.9 統一規約).

    Falls back to ネス基数 + 1 (逆ネスの規約) and finally to 1. Never 0 — a shelf
    with no 段 would materialise no location at all, silently deleting capacity.
    """
    lv = _int(rd.get(rec, "levels"))
    if lv is None:
        base = _int(rd.get(rec, "nes_base"))
        if base is not None:
            lv = base + 1          # 逆ネス: 段数 = 基数 + 1
    return max(1, min(int(lv or 1), 30))


def _faces(rd: _Reader, rec: dict, levels: int) -> int:
    """間口数. Derived from 有効ロケ数 ÷ 段数 when only the product is present."""
    f = _int(rd.get(rec, "faces"))
    if f is None:
        usable = _int(rd.get(rec, "usable"))
        if usable is not None and levels > 0:
            f = max(1, round(usable / levels))
    return max(1, min(int(f or 1), 200))


def _rack_type(gear: str, gear_name: str) -> str:
    """什器種別 → whsim.racktypes id (same table the ロケマスタ取込 uses)."""
    for cand in (gear, gear_name):
        c = str(cand or "").strip()
        if not c:
            continue
        if c in GEAR_TO_RACK:
            return GEAR_TO_RACK[c]
        if c in racktypes.RACK_TYPES:
            return c
        for label, rid in GEAR_TO_RACK.items():
            if label and label in c:
                return rid
    return racktypes.DEFAULT


# --------------------------------------------------------------------------- #
# Import
# --------------------------------------------------------------------------- #
def import_kpi_bytes(data: bytes) -> dict:
    """Parse a 3D/KPI JSON into whsim's canonical layout dict.

    Tolerant throughout: an unreadable record is counted and skipped, an empty
    result is an empty layout with warnings — never an exception.
    """
    warnings: list[str] = []
    try:
        doc = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ValueError(f"JSON として読めません: {e}") from e

    if isinstance(doc, list):                 # a bare array of shelf records
        doc = {"shelves": doc}
    if not isinstance(doc, dict):
        return _empty(["3D/KPI JSON として認識できる構造ではありませんでした。"])

    floors = _container(doc, "floors")
    if floors:
        if len(floors) > 1:
            warnings.append(f"{len(floors)} フロアのうち先頭フロアのみ取り込みました"
                            "（whsim は現状単一フロア）。")
        # keep the top-level meta visible to the floor
        doc = {**doc, **floors[0]}

    meta = _meta(doc)
    rd = _Reader()
    raw_shelves = _container(doc, "shelves")
    raw_walls = _container(doc, "walls")
    raw_stations = _container(doc, "stations")
    raw_stairs = _container(doc, "stairs")
    raw_conveyors = _container(doc, "conveyors")
    for bucket in (raw_shelves, raw_walls, raw_stations, raw_stairs, raw_conveyors):
        for r in bucket:
            rd.note(r)

    if not (raw_shelves or raw_walls or raw_stations):
        return _empty(warnings + [
            ("3D/KPI JSON に棚・壁・検品場のいずれも見つかりませんでした。"
             "キー名が想定と違う可能性があります（probe を確認してください）。")],
            probe=rd.probe())

    # --- shelves ---------------------------------------------------------- #
    shelves_raw: list[dict] = []
    dropped = 0
    for rec in raw_shelves:
        w, d, height = _footprint(rd, rec)
        x, y = _num(rd.get(rec, "x")), _num(rd.get(rec, "y"))
        cx, cy = _num(rd.get(rec, "cx")), _num(rd.get(rec, "cy"))
        levels = _levels(rd, rec)
        faces = _faces(rd, rec, levels)
        gear = str(rd.get(rec, "gear") or "")
        gear_name = str(rd.get(rec, "gear_name") or "")
        rtid = _rack_type(gear, gear_name)
        rt = racktypes.get(rtid)
        # Missing footprint: fall back to the equipment preset (mm), so a record
        # that only carries ロケ番号+座標+段数 still lands somewhere sensible.
        if w is None or w <= 0:
            w = float(rt["bay"]) * faces * 1000.0
        if d is None or d <= 0:
            d = float(rt["depth"]) * 1000.0
        if x is None and cx is not None:
            x = cx - w / 2.0
        if y is None and cy is not None:
            y = cy - d / 2.0
        if x is None or y is None:
            dropped += 1
            continue
        shelves_raw.append({
            "name": str(rd.get(rec, "name") or "").strip(),
            "x": x, "y": y, "w": w, "d": d,
            "height": height, "levels": levels, "faces": faces,
            "gear": gear, "gear_name": gear_name, "rack_type": rtid,
            "pallets": _num(rd.get(rec, "pallets")),
            "board_area": _num(rd.get(rec, "board_area")),
            "zone": str(rd.get(rec, "zone") or "").strip(),
        })

    # --- walls / stations / stairs / conveyors ----------------------------- #
    walls_raw: list[dict] = []
    for rec in raw_walls:
        w, d, height = _footprint(rd, rec)
        x, y = _num(rd.get(rec, "x")), _num(rd.get(rec, "y"))
        if None in (x, y) or not w or not d:
            dropped += 1
            continue
        walls_raw.append({"x": x, "y": y, "w": w, "d": d,
                          "height": height if height is not None
                          else _num(rd.get(rec, "wall_height"))})

    stations_raw: list[dict] = []
    for rec in raw_stations:
        w, d, _h = _footprint(rd, rec)
        x, y = _num(rd.get(rec, "x")), _num(rd.get(rec, "y"))
        cx, cy = _num(rd.get(rec, "cx")), _num(rd.get(rec, "cy"))
        # A station is a POINT for whsim, so a missing footprint is fine — the
        # corner alone still tells us where the bench is.
        if x is not None:
            cx = x + (w or 0.0) / 2.0
        if y is not None:
            cy = y + (d or 0.0) / 2.0
        if cx is None or cy is None:
            dropped += 1
            continue
        stations_raw.append({"id": str(rd.get(rec, "name") or "").strip(),
                             "x": cx, "y": cy, "w": w, "d": d})

    conveyors_raw: list[dict] = []
    for rec in raw_conveyors:
        pts = rd.get(rec, "points")
        pl = _points(pts)
        if len(pl) < 2:
            dropped += 1
            continue
        conveyors_raw.append({"points": pl, "speed": _num(rd.get(rec, "speed")),
                              "name": str(rd.get(rec, "name") or "").strip()})

    rd.finish(raw_shelves + raw_walls + raw_stations + raw_stairs + raw_conveyors)

    # --- unit auto-detect (mm vs m) + origin translate (mirrors rmpm.py) ---- #
    xs = ([s["x"] for s in shelves_raw] + [w["x"] for w in walls_raw]
          + [s["x"] for s in stations_raw] + [p[0] for c in conveyors_raw for p in c["points"]])
    ys = ([s["y"] for s in shelves_raw] + [w["y"] for w in walls_raw]
          + [s["y"] for s in stations_raw] + [p[1] for c in conveyors_raw for p in c["points"]])
    rights = ([s["x"] + s["w"] for s in shelves_raw] + [w["x"] + w["w"] for w in walls_raw]
              + [s["x"] for s in stations_raw]
              + [p[0] for c in conveyors_raw for p in c["points"]])
    bottoms = ([s["y"] + s["d"] for s in shelves_raw] + [w["y"] + w["d"] for w in walls_raw]
               + [s["y"] for s in stations_raw]
               + [p[1] for c in conveyors_raw for p in c["points"]])
    if not xs:
        return _empty(warnings + ["座標を読めるオブジェクトがありませんでした。"],
                      probe=rd.probe())
    minx, miny = min(xs), min(ys)
    maxx, maxy = max(rights), max(bottoms)
    unit = str(meta.get("unit") or "").strip().lower()
    if unit in ("mm", "ミリ", "millimeter", "millimetre"):
        scale, units = 0.001, "mm"
    elif unit in ("m", "メートル", "meter", "metre"):
        scale, units = 1.0, "m"
    else:
        span = max(maxx - minx, maxy - miny)
        scale, units = (0.001, "mm") if span > 2000 else (1.0, "m")

    def sx(v: float) -> float:
        return round((v - minx) * scale, 3)

    def sy(v: float) -> float:
        return round((v - miny) * scale, 3)

    def sl(v: float) -> float:
        return round(v * scale, 3)

    shelves: list[dict] = []
    for i, s in enumerate(shelves_raw):
        ww, hh = sl(s["w"]), sl(s["d"])
        # MapMaker stores no facing; default the 間口 toward the run's long side
        # (identical rule to rmpm.py so both importers draw the same shelf).
        facing = "down" if ww >= hh else "left"
        shelves.append({"id": f"s{i}", "name": s["name"], "x": sx(s["x"]), "y": sy(s["y"]),
                        "w": ww, "h": hh, "rack_type": s["rack_type"], "facing": facing})
        s["_shelf"] = shelves[-1]

    walls: list[dict] = []
    for i, wl in enumerate(walls_raw):
        ww, hh = sl(wl["w"]), sl(wl["d"])
        if ww >= hh:                            # horizontal rectangle → centre line
            cy = sy(wl["y"]) + hh / 2
            pts = [[sx(wl["x"]), round(cy, 3)], [round(sx(wl["x"]) + ww, 3), round(cy, 3)]]
            thick = max(hh, 0.05)
        else:                                   # vertical rectangle → centre line
            cx = sx(wl["x"]) + ww / 2
            pts = [[round(cx, 3), sy(wl["y"])], [round(cx, 3), round(sy(wl["y"]) + hh, 3)]]
            thick = max(ww, 0.05)
        walls.append({"id": f"w{i}", "points": pts, "thickness": round(thick, 3)})

    stations = [{"id": s["id"] or f"st{i}", "x": sx(s["x"]), "y": sy(s["y"]),
                 **({"w": sl(s["w"])} if s.get("w") else {}),
                 **({"d": sl(s["d"])} if s.get("d") else {})}
                for i, s in enumerate(stations_raw)]

    conveyors = [{"id": c["name"] or f"cv{i}",
                  "points": [[sx(p[0]), sy(p[1])] for p in c["points"]],
                  "speed_mps": c["speed"] if c["speed"] else 0.5}
                 for i, c in enumerate(conveyors_raw)]

    bounds = {"width": max(round((maxx - minx) * scale, 3), 1.0),
              "depth": max(round((maxy - miny) * scale, 3), 1.0)}

    zones = []
    if shelves:
        zones.append({"id": "storage", "type": "storage", "x": 0.0, "y": 0.0,
                      "w": bounds["width"], "h": bounds["depth"],
                      "rack": None, "shelves": shelves})

    locations = expand_locations(shelves_raw)

    if raw_stairs:
        warnings.append(f"階段 {len(raw_stairs)} 件は現状の単一フロアモデルでは"
                        "見送りました。")
    if dropped:
        warnings.append(f"座標・寸法を読めない要素 {dropped} 件を読み飛ばしました。")
    if not rd.matched.get("name"):
        warnings.append("ロケ番号にあたるキーが見つかりませんでした。"
                        "在庫データとの突合には棚名が要ります（probe を確認してください）。")
    if not rd.matched.get("levels") and not rd.matched.get("nes_base"):
        warnings.append("段数にあたるキーが見つからず、全棚 1 段として展開しました"
                        "（v4.9 規約: 段数=パレット段数, 逆ネスは 基数=段数−1）。")
    if rd.unknown:
        warnings.append("未認識のキー "
                        + "、".join(u["key"] for u in rd.probe()["unknown"][:8])
                        + " がありました（probe に全件）。")
    warnings.append("3D/KPI JSON は意味ベースの別名表で解釈しています。"
                    "想定キー名は docs/mapmaker-v5-import.md をご確認ください。")

    return {"bounds": bounds, "zones": zones, "walls": walls, "stations": stations,
            "conveyors": conveyors, "locations": locations,
            "warnings": warnings, "probe": rd.probe(),
            "stats": {"shelves": len(shelves), "walls": len(walls),
                      "stations": len(stations), "conveyors": len(conveyors),
                      "stairs": len(raw_stairs), "locations": len(locations),
                      "dropped": dropped, "scale": scale, "units": units,
                      "meta": meta}}


def _points(v: Any) -> list[list[float]]:
    """A polyline from ``[[x,y],…]`` / ``[{x,y},…]`` / ``[x1,y1,x2,y2,…]``."""
    if not isinstance(v, (list, tuple)):
        return []
    out: list[list[float]] = []
    flat: list[float] = []
    for p in v:
        if isinstance(p, dict):
            px = _num(p.get("x") if "x" in p else p.get("X"))
            py = _num(p.get("y") if "y" in p else p.get("Y"))
            if px is not None and py is not None:
                out.append([px, py])
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            px, py = _num(p[0]), _num(p[1])
            if px is not None and py is not None:
                out.append([px, py])
        else:
            n = _num(p)
            if n is not None:
                flat.append(n)
    if not out and len(flat) >= 4:
        out = [[flat[i], flat[i + 1]] for i in range(0, len(flat) - 1, 2)]
    return out


def expand_locations(shelves_raw: list[dict]) -> list[dict]:
    """段 × 間口 → ``Location``-shaped dicts.

    **The expansion rule is the ロケーションマスタ規約, byte for byte** (see
    ``locmaster.apply_to_model`` / ``design.materialize_racks``): one bay per
    間口 named ``<棚名>-<間口2桁>`` (the bare 棚名 when there is only one 間口),
    one location per 段 with the 段 suffixed from level 2 up, address
    ``<bay>-<段2桁>``. 段数 is MapMaker v4.9's 段数 = パレット段数; 逆ネス was
    already converted from 基数 (+1) upstream. Keeping the two importers on one
    rule is what lets a KPI JSON and a ロケマスタ CSV describe the same slots.
    """
    locs: list[dict] = []
    for s in shelves_raw:
        sh = s.get("_shelf")
        if sh is None:
            continue
        levels, faces = int(s["levels"]), int(s["faces"])
        rtid = str(s["rack_type"])
        rt = racktypes.get(rtid)
        # パレット収納力 is per SHELF (台) in the KPI export; split it across the
        # 有効ロケ so the sum is preserved. Missing → the preset's per-cell value.
        total = s.get("pallets")
        if total and total > 0:
            cap = max(1, round(float(total) / max(1, levels * faces)))
        else:
            cap = max(1, int(rt["capacity"] // max(1, int(rt.get("levels", 1)))))
        base = str(s.get("name") or "")
        zone = str(s.get("zone") or "") or "storage"
        # bays laid along the run's long side, centred in the footprint
        along_x = sh["w"] >= sh["h"]
        span = sh["w"] if along_x else sh["h"]
        pitch = span / faces if faces else span
        for j in range(faces):
            off = pitch * (j + 0.5)
            x = sh["x"] + (off if along_x else sh["w"] / 2.0)
            y = sh["y"] + (sh["h"] / 2.0 if along_x else off)
            bay = "" if not base else (f"{base}-{j + 1:02d}" if faces > 1 else base)
            for lvl in range(1, levels + 1):
                nm = "" if not bay else (bay if lvl == 1 else f"{bay}-{lvl}")
                locs.append({
                    "id": f"K{len(locs)}", "name": nm,
                    "address": f"{bay}-{lvl:02d}" if bay else "",
                    "level": lvl, "zone": zone,
                    "x": round(x, 3), "y": round(y, 3),
                    "type": "pallet" if rtid in ("pallet", "nestainer") else "shelf",
                    "rack_type": rtid, "capacity": cap})
    return locs


def apply_to_model(model, res: dict) -> dict:
    """Write the imported locations onto ``model.locations``.

    Used INSTEAD of ``design.materialize_racks`` when the KPI JSON carried 段数/
    間口数: MapMaker's own count is authoritative (it is what the 収納力計算 and the
    什器マスタ agree on), so re-deriving levels from the whsim rack preset would
    make whsim's capacity disagree with the drawing it came from.
    """
    from whsim.schema.model import Location

    recs = res.get("locations") or []
    if not recs:
        return {"locations": 0}
    locs: list[Location] = []
    for r in recs:
        try:
            locs.append(Location(**r))
        except Exception:  # noqa: BLE001,S112 — tolerant: one bad row never blocks
            continue
    if locs:
        model.locations = locs
    return {"locations": len(locs)}


def probe_kpi_bytes(data: bytes) -> dict:
    """Key census only — what we matched, what we did not, and how often.

    This is the answer-sheet for the MapMaker author: run it on a real export and
    every key we failed to place shows up under ``unknown`` with a sample value.
    """
    try:
        res = import_kpi_bytes(data)
    except ValueError as e:
        return {"ok": False, "error": str(e), "matched": {}, "unknown": [],
                "keys_seen": {}}
    probe = dict(res.get("probe") or {})
    probe["ok"] = True
    probe["stats"] = res.get("stats", {})
    probe["warnings"] = res.get("warnings", [])
    return probe


def _empty(warnings: list[str], probe: dict | None = None) -> dict:
    return {"bounds": None, "zones": [], "walls": [], "stations": [],
            "conveyors": [], "locations": [], "warnings": warnings,
            "probe": probe or {"matched": {}, "unknown": [], "keys_seen": {}},
            "stats": {"shelves": 0, "walls": 0, "stations": 0, "conveyors": 0,
                      "stairs": 0, "locations": 0, "dropped": 0,
                      "scale": 1.0, "units": "unknown", "meta": {}}}
