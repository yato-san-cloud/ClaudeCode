"""Tolerant importer for a MapMaker (Hitachi WorldMap) native **.rmpm.json** export.

MapMaker's native save (``.rmpm``) exports to a simple JSON shape::

    floor { name, bounds{left,top,right,bottom}, view{centerX,centerY,zoom},
            objects[ { type, id, x, y, w, h, name? } ] }

Units are **mm**, axis-aligned rectangles, origin top-left, +x right / +y down.
Object types seen in the wild: ``WallObject``, ``FreeShelfObject`` (a *named*
shelf), ``ShelfObject``, ``StationObject`` (検品/作業場), ``ConstrainedAreaObject``,
``OneWayPassageObject``, ``StairsObject``, ``BeaconObject``.

We map what whsim's single-floor layout can hold (shelves / walls / stations /
bounds) in the house style: anything we can't place is skipped with a warning,
never fatal — a partial import is fine. Crucially, shelves keep their MapMaker
**name** so locations materialise with addressable names (loaded stock data can
later slot by shelf name). Returns the same ``{bounds, zones, walls, stations,
warnings, stats}`` shape as ``mapcsv``/``cad`` so the import endpoint applies it
uniformly, plus the additive ``conveyors`` / ``markers`` / ``non_barriers``
buckets that the **name convention** below yields (a caller that does not know
them simply ignores them).

**名前規約** (``_NAME_RULES``): the format has no z axis and only three placeable
kinds, so real sites write the meaning into the object NAME. We read it — see the
long comment on ``_NAME_RULES`` for why, and ``docs/mapmaker-v5-import.md`` §5-3
for the table itself. A drawing that uses none of that vocabulary imports exactly
as before.

**MapMaker カスタム版 (v4.4+)**: the custom build appends 什器マスタ・割当・資産情報
(and, from v4.9, コンベア) AFTER the serialized map so older MapMaker versions skip
it and still open the file. That is a normal file, not a damaged one — we measure
the trailer and say so rather than letting javaobj shout "Stream still has N bytes
left" (see ``_load_java``). The conveyor-footprint walls v4.10 auto-generates are
NOT identifiable here; see ``_CONVEYOR_FOOTPRINT_NOTE`` and
docs/mapmaker-v5-import.md §5.
"""

from __future__ import annotations

import json
import math
import re
import unicodedata

_SHELF_TYPES = {"FreeShelfObject", "ShelfObject"}
_WALL_TYPES = {"WallObject"}
_STATION_TYPES = {"StationObject"}
# MapMaker stores the picking base/dispatch points as pseudo-shelves named
# "START"/"END" (FreeShelfArea.pickingStartEndShelf) — not real storage; skip them.
_MARKER_NAMES = {"START", "END"}


def _num(v) -> float | None:
    """Float or None (also rejects NaN); never raises."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


# --------------------------------------------------------------------------- #
# 名前規約の解釈 — なぜ「名前」で判定するのか
# --------------------------------------------------------------------------- #
# MapMaker の図面には **z 座標が無く**、置ける種別も WallObject / FreeShelfObject /
# StationObject の3つしか無い。2段駆動コンベアの上段と下段も、床に描いただけの
# 停止線も、人の立ち位置マーカーも、荷物の置き場も、形式の上では**同じ矩形**に
# なる。だから現場は **オブジェクト名に意味を書き込む** 運用をしている
# （「本線コンベア 下段H900(既設)」「梱包作業者01 立ち位置」「停止線(新設)」…）。
#
# 名前を無視すると実データはこう壊れる: コンベアも立ち位置マーカーも全部「作業台」
# になり、**表示のためだけに引いた線が経路を塞ぐ壁**になり、2段のベルトは同じ
# 平面座標なので片方が消える。形式に無い情報は名前にしか無い＝**名前が唯一の
# 手掛かり**なので、ここで読む。
#
# 規約は下の**1つの表**に集約する。判定は **NFKC 畳み込み + 部分一致**（半角カナ・
# 全角英数・大小文字を吸収）、**先に載っている行が勝つ**（具体的な語を上に置く:
# 「検品者」は「検品台」より上、「引き込みコンベア」は「梱包台」より上）。
# 当たらなければ従来どおり type で分類する ＝ **規約語を1つも含まない図面の結果は
# 1バイトも変わらない**（never blocks）。tag は種別ごとの副情報:
#   marker → 役割 / zone → ゾーン種別 / station → 役割 / conveyor → 本線か引き込みか /
#   non_barrier → なぜ壁でないのか。
_NAME_RULES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    # 表示・区画であって障壁ではない（壁として取り込むと経路が塞がる）
    ("non_barrier", "stop_line", ("停止線", "停止位置")),
    ("non_barrier", "partition", ("仕切り", "仕切", "区画線", "表示線")),
    # 人の立ち位置マーカー（什器ではない）。500mm 角で描かれるのが通例だが、
    # 寸法は条件にしない（600mm で描いても立ち位置は立ち位置）。
    ("marker", "inspector", ("検品者", "検査者", "検品作業者")),
    ("marker", "packer", ("梱包者", "梱包作業者")),
    ("marker", "picker", ("ピッカー", "ピッキング作業者")),
    ("marker", "worker", ("立ち位置", "立位置", "作業者", "作業員")),
    # 搬送設備
    ("conveyor", "spur", ("引き込み", "引込み", "引込")),
    ("conveyor", "main", ("本線",)),
    ("conveyor", "return", ("還流", "戻しコンベア")),
    ("conveyor", "gravity", ("フリーコンベア", "無動力")),
    ("conveyor", "discharge", ("カーブ排出", "排出部", "カーブ")),
    ("conveyor", "belt", ("コンベア", "コンベヤ", "ベルト")),
    # 作業台（実寸を持つ。長辺の向きが「誰がどこに立つか」を決める）
    ("station", "pack", ("梱包台",)),
    ("station", "inspect", ("検品台",)),
    ("station", "bench", ("作業台",)),
    ("station", "infeed", ("投入口", "投入部")),
    # 意味領域
    ("zone", "receiving", ("入荷エリア", "入荷置き場", "入荷置場")),
    ("zone", "shipping", ("出荷エリア", "出荷置き場", "出荷置場")),
    ("zone", "packing", ("梱包エリア",)),
    ("zone", "picking", ("ピッキングエリア",)),
    ("zone", "staging", ("積み付け", "積付け", "積付", "置き場", "置場", "エリア")),
)

# 2段駆動コンベアの既定デッキ高さ (m)。名前に「床上NNNNmm」/「HNNNN」があれば
# そちらが勝つ（図面が実測値を書いているのに既定で上書きしては嘘になる）。
_TIER_ELEVATION_M: tuple[tuple[str, float], ...] = (("下段", 0.35), ("上段", 0.95))
# 「床上900mm」「H900」「FL+900」= 床からのベルト高さ。**単位は常に mm**（図面の
# 平面座標が m でも、名前に書かれた高さは mm 表記）なので図面スケールを掛けない。
_FLOOR_HEIGHT_RE = re.compile(r"(?:床上|fl\s*\+|fl|h)\s*(\d{2,5})\s*(?:mm)?")
_MAX_ELEVATION_MM = 10000.0
# 進行方向。取込は MapMaker の軸（x 右+ / y 下+ ・Y反転しない）をそのまま使うので
# 北 = -y。
_DIRECTION_VEC: dict[str, tuple[float, float]] = {
    "東": (1.0, 0.0), "西": (-1.0, 0.0), "北": (0.0, -1.0), "南": (0.0, 1.0),
}
_ARROW_RE = re.compile(r"([東西南北])\s*(?:→|->|=>|⇒|から)\s*([東西南北])")
_HEADING_RE = re.compile(r"([東西南北])\s*(?:向き|向|行き|方向)")
# 本線を跨ぐ1本のベルトを、作図の都合で半分ずつ描いたときの語。
_HALF_TOKENS = ("北半", "南半", "東半", "西半")
# 名前の「識別子」と「注記」の境目。全角/半角の括弧と縦棒（MapMaker の名前欄は
# 1行なので、注記はこれらの後ろに書かれる）。
_ANNOTATION_DELIMS = ("(", "（", "｜", "|", "[", "［", "【", "〔")
_DEFAULT_BELT_SPEED_MPS = 0.5   # mirrors cad.py / mapmaker_kpi (rmpm has no speed)


def _fold(s) -> str:
    """NFKC-fold + lowercase, for tolerant substring matching (半角カナ/全角英数)."""
    return unicodedata.normalize("NFKC", str(s or "")).lower()


def _split_annotation(name) -> str:
    """The drawn name minus its annotation tail, original case preserved."""
    s = str(name or "")
    for d in _ANNOTATION_DELIMS:
        i = s.find(d)
        if i > 0:
            s = s[:i]
    return s.strip()


def _head(name) -> str:
    """The identity half of a drawn name: everything before the first annotation.

    Draughtsmen write 「何であるか(どこに・どうする)」 — the head names the object,
    the bracketed/｜ tail says where it is, what flows on it or where it goes. Those
    tails routinely mention OTHER kinds of object (「検品者立ち位置マーカー(西・仕切り
    付近)」 is a person standing near a partition, 「投入口(検品済オリコン→下段本線)」
    is a chute feeding the trunk), so matching the tail turns people into partitions
    and chutes into trunk belts. Match the head first, the whole name only after."""
    return _fold(_split_annotation(name))


def _match_rules(s: str) -> tuple[str, str] | None:
    for kind, tag, words in _NAME_RULES:
        if any(w in s for w in words):
            return kind, tag
    return None


def classify_name(name) -> tuple[str, str] | None:
    """``(kind, tag)`` for a MapMaker object NAME, or ``None`` when no rule hits.

    ``None`` means "fall back to the historical type-based classification", which
    is what keeps a drawing that follows no naming convention byte-identical."""
    s = _fold(name)
    if not s:
        return None
    return _match_rules(_head(name)) or _match_rules(s)


def _belt_elevation_m(name) -> float | None:
    """Deck height (m) written into a belt's name, or ``None`` when unstated."""
    s = _fold(name)
    m = _FLOOR_HEIGHT_RE.search(s)
    if m:
        mm = _num(m.group(1))
        if mm is not None and 0 < mm <= _MAX_ELEVATION_MM:
            return round(mm / 1000.0, 3)
    for word, ev in _TIER_ELEVATION_M:
        if word in s:
            return ev
    return None


def _belt_direction(name) -> tuple[float, float] | None:
    """Travel direction unit vector from 「東向き」/「北→南」, else ``None``."""
    s = _fold(name)
    m = _ARROW_RE.search(s)
    if m:
        return _DIRECTION_VEC.get(m.group(2))
    m = _HEADING_RE.search(s)
    if m:
        return _DIRECTION_VEC.get(m.group(1))
    return None


def _half_key(name) -> str | None:
    """Grouping key for a 「…北半」/「…南半」 pair, or ``None`` if not a half.

    Only names that actually carry a half token group, so two decks that happen to
    share a name are never merged into one belt. The key is built from the HEAD
    with EVERY half token removed, because each half's note names the other one
    (「北半(既設)｜南半と一体」 vs 「南半(既設)｜北半と一体」) — cancelling just the
    first token found leaves the two names different and the pair never merges."""
    s = _fold(name)
    if not any(tok in s for tok in _HALF_TOKENS):
        return None
    head = _head(name)
    for tok in _HALF_TOKENS:
        head = head.replace(tok, "")
    return re.sub(r"\s+", "", head)


def _strip_half(name: str) -> str:
    """The merged belt's name: the head minus its 北半/南半 token.

    The annotation tail is dropped on purpose here — it exists to say 「南半と一体」,
    i.e. to describe the very split we have just resolved, so carrying it onto the
    merged belt would leave a name that contradicts the object."""
    out = _split_annotation(name) or name
    for tok in _HALF_TOKENS:
        out = out.replace(tok, "")
    return out.strip(" 　_-・") or name


def _uniq(used: set[str], base: str, fallback: str) -> str:
    """A stable id: the drawn name when free (so `equipment_ref` can point at it),
    else a suffixed variant — never a silent collision."""
    cand = (base or "").strip() or fallback
    if cand in used:
        n = 2
        while f"{cand}#{n}" in used:
            n += 1
        cand = f"{cand}#{n}"
    used.add(cand)
    return cand


# Java Object Serialization Stream magic (0xACED). A file starting with these
# bytes is MapMaker's NATIVE save (a serialized WorldMapMultiFloor), not the
# JSON export — real users drag the native file, so we parse it directly.
_JAVA_MAGIC = b"\xac\xed"


# javaobj ships two parsers with DIFFERENT object models, and real MapMaker saves
# need both (see _load_java). v2 hands back a JavaInstance carrying `field_data`
# keyed by class; v1 hands back a JavaObject with the fields as plain attributes.
_V1_SKIP = {"classdesc", "annotations", "get_class"}


def _jfields(inst) -> dict:
    """{field name: value} for a javaobj instance, merged across the class
    hierarchy, for EITHER parser's object model. Tolerant: anything we cannot
    read yields {}."""
    out: dict = {}
    for _cls, fmap in (getattr(inst, "field_data", None) or {}).items():
        for jf, val in fmap.items():
            out[getattr(jf, "name", str(jf))] = val
    if out:
        return out
    # v1: fields land straight on the instance dict.
    for k, v in (getattr(inst, "__dict__", None) or {}).items():
        if not k.startswith("_") and k not in _V1_SKIP:
            out[k] = v
    return out


def _load_java(data: bytes) -> tuple[object, int]:
    """Deserialize a MapMaker save. Returns ``(root, custom_trailer_bytes)``.

    v2 is the better-maintained parser and reads most saves, but it derails on
    some real customer files — it loses alignment inside a custom writeObject
    block and dies on a nonsense type code. v1 reads those. Neither is a superset
    of the other, so this tries v2 first and keeps v1 as the fallback rather than
    telling somebody their own layout file is corrupt when it is not.

    **The custom trailer (MapMaker カスタム版 v4.4+).** The custom build appends
    its own data — 什器マスタ・割当・グループ・資産情報、v4.9 以降はコンベアも —
    *after* the serialized ``WorldMapMultiFloor``, precisely so an older MapMaker
    "reads past it" and still opens the file. javaobj notices those leftover
    bytes and logs `Warning!!!!: Stream still has N bytes left`, which reads like
    corruption and is not: it is the file working as designed. So we suppress
    that log, MEASURE the trailer ourselves, and report it as what it is.
    """
    first: Exception | None = None
    try:
        import javaobj.v2 as _v2
    except ImportError as e:  # pragma: no cover — ships in pyproject deps
        raise ValueError(
            "ネイティブ .rmpm の読込には javaobj-py3 が必要です。"
            "`pip install javaobj-py3`（start.bat の再実行でも更新されます）するか、"
            "MapMaker の JSON エクスポート（.rmpm.json）をご利用ください。") from e
    try:
        # v2 reads the whole stream to EOF, so it either consumes the trailer as
        # further stream content or (usually) trips on it and we fall to v1.
        return _v2.loads(data), 0
    except Exception as e:  # noqa: BLE001 — fall through to the v1 parser
        first = e
    try:
        from io import BytesIO

        from javaobj.v1.transformers import DefaultObjectTransformer
        from javaobj.v1.unmarshaller import JavaObjectUnmarshaller
        fp = BytesIO(data)
        marshaller = JavaObjectUnmarshaller(fp)
        marshaller.add_transformer(DefaultObjectTransformer())
        # ignore_remaining_data=True is what silences javaobj's scary
        # "Stream still has N bytes left" error line; readObject leaves the
        # stream positioned right after the object, so the remainder is the
        # custom trailer and we can name it accurately.
        root = marshaller.readObject(ignore_remaining_data=True)
        return root, max(0, len(data) - fp.tell())
    except Exception:  # noqa: BLE001 — last resort: the plain v1 entry point
        try:
            import javaobj as _v1
            return _v1.loads(data, ignore_remaining_data=True), 0
        except Exception as e:  # noqa: BLE001 — corrupt stream → friendly error
            raise ValueError(
                f".rmpm（Java直列化）として解釈できませんでした: {first}") from e


def _native_to_doc(data: bytes) -> dict:
    """Parse a NATIVE .rmpm (Java-serialized WorldMapMultiFloor) into the same
    floors-dict shape as the JSON export, so ONE mapping path serves both.

    Mirrors reference/mapmaker's RmpmExport.java: per object the bounds come
    from the ``tl``/``br`` Coord fields, the type from the class simple name,
    and a FreeShelfObject's rack address from ``shelf.name``. Unrecognised
    objects are kept typed so the downstream mapper counts/skips them
    ("never blocks")."""
    top, trailer = _load_java(data)

    exts = _jfields(top).get("WorldMapExtensionList")
    floors: list[dict] = []
    for ext in list(exts) if exts is not None else []:
        fe = _jfields(ext)
        wm = fe.get("worldMap")
        if wm is None:
            continue
        fw = _jfields(wm)
        tl, br = _jfields(fw.get("tl")), _jfields(fw.get("br"))
        objects: list[dict] = []
        for o in list(fw.get("objects") or []):
            cls = getattr(getattr(o, "classdesc", None), "name", "") or ""
            fo = _jfields(o)
            otl, obr = _jfields(fo.get("tl")), _jfields(fo.get("br"))
            if "x" not in otl or "x" not in obr:
                continue
            rec: dict = {
                "type": cls.rsplit(".", 1)[-1],
                "id": fo.get("id"),
                "x": otl.get("x"), "y": otl.get("y"),
                "w": (obr.get("x") or 0) - (otl.get("x") or 0),
                "h": (obr.get("y") or 0) - (otl.get("y") or 0),
            }
            # FreeShelfObject carries its rack address on shelf.name; other
            # named objects (e.g. StairsObject) keep a plain `name` field.
            shelf = fo.get("shelf")
            name = (_jfields(shelf).get("name") if shelf is not None
                    else fo.get("name"))
            if name is not None:
                rec["name"] = str(name)
            # WallObject.height_mm — the ONLY field a wall carries beyond its
            # rectangle (see _conveyor_footprint_note). Kept so a caller can at
            # least see the belt height the custom build wrote under a conveyor.
            hm = _num(fo.get("height_mm"))
            if hm is not None:
                rec["height_mm"] = hm
            objects.append(rec)
        floors.append({
            "name": str(fe.get("name") or f"Floor{len(floors) + 1}"),
            "bounds": {"left": tl.get("x", 0.0), "top": tl.get("y", 0.0),
                       "right": br.get("x", 0.0), "bottom": br.get("y", 0.0)},
            "view": {"centerX": fe.get("centerX"), "centerY": fe.get("centerY"),
                     "zoom": fe.get("zoomLevel")},
            "objects": objects,
        })
    if not floors:
        raise ValueError(".rmpm にフロアが見つかりませんでした（WorldMapExtensionList が空）。")
    return {"source": "native-rmpm", "unit": "mm", "custom_trailer_bytes": trailer,
            "axes": "x-right, y-down, origin top-left", "floors": floors}


# --------------------------------------------------------------------------- #
# 調査結果: v4.10 の「コンベア足元に自動生成される壁」は rmpm から識別できない
# --------------------------------------------------------------------------- #
# MapMaker カスタム版 v4.10 はコンベアを描くと、その足元に実体の「壁」を自動生成
# して rmpm に保存する（経路計算がコンベアを迂回し、rmpm を直読するシミュレータ
# からも見えるようにするため）。説明書は「生成物は元アプリの壁クラスそのもの」と
# 明言している。デコンパイル済み `WallObject`（reference/mapmaker/decompiled/
# .../model/map/objects/WallObject.java）を確認した結果:
#
#   WallObject extends AbstractRectangleObject extends AbstractObject
#     WallObject          : height_mm (double) のみ
#     AbstractRectangle…  : tl, br (Coord)
#     AbstractObject      : id (Integer), editLock (boolean)
#
# 名前フィールドが無い（`toString()` が定数 "壁" を返すだけで、StairsObject の
# ような `name` も FreeShelfObject のような `shelf.name` も持たない）。つまり
# **フィールドからコンベア由来の壁を見分ける手段は存在しない**。
# 「元アプリの壁クラスそのもの」＝旧 MapMaker でもそのまま開ける、という設計上の
# 要請そのものが、印を付けられない理由になっている（印を付ければ旧版が読めない）。
#
# 唯一の手掛かりは `height_mm`（プロパティPで指定するベルト高）だが、これは人が
# 手で描いた壁にも入る値で、判別には使えない。残る可能性は v4.4+ の末尾埋め込み
# （コンベアの実体データはそこにある）を解くことだが、その形式は非公開でサンプルも
# 無い。
#
# → したがって **DXF の CONVEYOR レイヤ経路を正とする**（`whsim.cad`）。DXF では
#    コンベアは専用レイヤに出て、壁として二重計上されない（説明書 v4.10 の
#    「自社の集計・DXFでは『コンベア(壁)』『CONVEYORレイヤ』として扱い二重計上
#    しません」）。rmpm からの壁は素直に壁として取り込み、`height_mm` だけ
#    stats に残して人が判断できるようにする。
_CONVEYOR_FOOTPRINT_NOTE = (
    "v4.10 以降、コンベアの足元には壁が自動生成されますが、rmpm 上は通常の壁と"
    "区別が付きません（壁クラスに名前が無いため）。コンベアとして扱うには"
    "DXF の CONVEYOR レイヤを取り込んでください。")


def _centre_line(x, y, w, h, sx, sy, sl) -> tuple[list[list[float]], float]:
    """A drawn rectangle → its centre line + thickness (walls and 停止線 alike)."""
    ww, hh = sl(w), sl(h)
    if ww >= hh:                       # horizontal rectangle → centre line
        cy = sy(y) + hh / 2
        pts = [[sx(x), round(cy, 3)], [round(sx(x) + ww, 3), round(cy, 3)]]
        thick = max(hh, 0.05)
    else:                              # vertical rectangle → centre line
        cx = sx(x) + ww / 2
        pts = [[round(cx, 3), sy(y)], [round(cx, 3), round(sy(y) + hh, 3)]]
        thick = max(ww, 0.05)
    return pts, round(thick, 3)


def _belt_points(b: dict, sx, sy, sl) -> tuple[list[list[float]], bool]:
    """Belt rectangle → a 2-point centre polyline pointing the way goods travel.

    Returns ``(points, direction_ignored)``. The long side is the run; the name's
    direction word only flips it (a 「東向き」 on a north-south belt is not a
    direction we can honour, so we keep the geometry and say so)."""
    pts, _ = _centre_line(b["x"], b["y"], b["w"], b["h"], sx, sy, sl)
    axis = 0 if sl(b["w"]) >= sl(b["h"]) else 1
    d = b.get("dir")
    if d is None:
        return pts, False
    if d[axis] < 0:
        pts.reverse()
        return pts, False
    return pts, d[axis] == 0


def _merge_halves(members: list[dict]) -> dict:
    """Two halves of ONE belt (北半/南半) → a single rectangle spanning both.

    The pair exists because the belt crosses the 本線 and was drawn in two pieces;
    downstream it has to be one continuous polyline or a tote "arrives" twice."""
    x0 = min(m["x"] for m in members)
    y0 = min(m["y"] for m in members)
    x1 = max(m["x"] + m["w"] for m in members)
    y1 = max(m["y"] + m["h"] for m in members)
    first = members[0]
    return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0,
            "name": _strip_half(first["name"]),
            "role": next((m["role"] for m in members if m.get("role")), None),
            "elev": next((m["elev"] for m in members if m.get("elev") is not None), None),
            "dir": next((m["dir"] for m in members if m.get("dir")), None)}


def import_rmpm_bytes(data: bytes) -> dict:
    warnings: list[str] = []
    trailer = 0
    if data[:2] == _JAVA_MAGIC:
        # NATIVE save — parse the Java stream directly; no JSON export needed.
        doc = _native_to_doc(data)
        warnings.append("ネイティブ .rmpm（Java保存形式）を直接読み込みました。")
        trailer = int(doc.get("custom_trailer_bytes") or 0)
        if trailer:
            # NOT a corruption warning: v4.4+ appends 什器マスタ/割当/資産情報/
            # コンベア after the serialized map on purpose, so older MapMaker
            # versions skip it and still open the file.
            warnings.append(
                f"MapMaker カスタム版の拡張データ {trailer} bytes をスキップしました"
                "（v4.4+ が rmpm 末尾に埋め込む什器マスタ・割当・資産情報等。"
                "図面本体の読込には影響しません）。")
    else:
        try:
            doc = json.loads(data.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ValueError(f"JSON として読めません: {e}") from e

    floors = doc.get("floors") if isinstance(doc, dict) else None
    if not (isinstance(floors, list) and floors):
        # Also accept a bare floor object (no top-level "floors" wrapper).
        floors = [doc] if isinstance(doc, dict) and "objects" in doc else []
    if not floors:
        return _empty(["rmpm として認識できるフロアがありませんでした。"])
    if len(floors) > 1:
        warnings.append(f"{len(floors)} フロアのうち先頭フロアのみ取り込みました"
                        "（whsim は現状単一フロア）。")

    floor = floors[0] if isinstance(floors[0], dict) else {}
    objects = floor.get("objects")
    objects = objects if isinstance(objects, list) else []

    raw_shelves: list[tuple[float, float, float, float, str]] = []
    raw_walls: list[tuple[float, float, float, float, float | None]] = []
    # (x, y, w, h, name, role) — role is None for a plain StationObject, which is
    # what keeps its emitted dict byte-identical to the historical {id,x,y}.
    raw_stations: list[tuple[float, float, float, float, str, str | None]] = []
    raw_belts: list[dict] = []
    raw_marks: list[tuple[float, float, float, float, str, str]] = []
    raw_bars: list[tuple[float, float, float, float, str, str]] = []
    raw_zones: list[tuple[float, float, float, float, str, str]] = []
    skipped: dict[str, int] = {}
    pick_markers = 0
    for o in objects:
        if not isinstance(o, dict):
            continue
        t = str(o.get("type", ""))
        x, y, w, h = (_num(o.get("x")), _num(o.get("y")),
                      _num(o.get("w")), _num(o.get("h")))
        if None in (x, y, w, h):
            continue
        name = str(o.get("name") or "")
        # The NAME decides first (see _NAME_RULES: the format carries no z axis and
        # only three kinds, so meaning lives in the name); the object TYPE is the
        # fallback, i.e. the historical behaviour for un-annotated drawings.
        kind, tag = classify_name(name) or (None, "")
        if kind == "conveyor" and max(w, h) > 0:
            raw_belts.append({"x": x, "y": y, "w": w, "h": h, "name": name,
                              "role": tag, "elev": _belt_elevation_m(name),
                              "dir": _belt_direction(name)})
        elif kind == "marker":
            raw_marks.append((x, y, w, h, name, tag))
        elif kind == "non_barrier" and w > 0 and h > 0:
            raw_bars.append((x, y, w, h, name, tag))
        elif kind == "zone" and w > 0 and h > 0:
            raw_zones.append((x, y, w, h, name, tag))
        elif kind == "station":
            raw_stations.append((x, y, w, h, name, tag))
        elif t in _SHELF_TYPES and w > 0 and h > 0:
            if name.strip().upper() in _MARKER_NAMES:
                pick_markers += 1     # picking base marker, not a storage shelf
                continue
            raw_shelves.append((x, y, w, h, name))
        elif t in _WALL_TYPES and w > 0 and h > 0:
            raw_walls.append((x, y, w, h, _num(o.get("height_mm"))))
        elif t in _STATION_TYPES:
            raw_stations.append((x, y, w, h, name, None))
        else:
            skipped[t or "(unknown)"] = skipped.get(t or "(unknown)", 0) + 1

    if not (raw_shelves or raw_walls or raw_stations
            or raw_belts or raw_marks or raw_bars or raw_zones):
        return _empty(warnings + ["配置できるオブジェクトがありませんでした。"])

    # --- unit auto-detect (mm vs m) + origin translate (mirrors mapcsv) --------
    fb = floor.get("bounds") if isinstance(floor.get("bounds"), dict) else None
    # Every placed rectangle counts toward the extent — including the belts and
    # markers the naming table pulled out, or a conveyor-only drawing would have
    # no span to auto-detect mm from.
    placed = [r[:4] for r in raw_shelves] + [r[:4] for r in raw_stations] \
        + [r[:4] for r in raw_walls] + [(b["x"], b["y"], b["w"], b["h"]) for b in raw_belts] \
        + [r[:4] for r in raw_marks] + [r[:4] for r in raw_bars] + [r[:4] for r in raw_zones]
    xs = [r[0] for r in placed]
    ys = [r[1] for r in placed]
    rights = [r[0] + r[2] for r in placed]
    bottoms = [r[1] + r[3] for r in placed]
    if fb:
        for k, bucket in (("left", xs), ("top", ys), ("right", rights), ("bottom", bottoms)):
            v = _num(fb.get(k))
            if v is not None:
                bucket.append(v)
    minx, miny = (min(xs) if xs else 0.0), (min(ys) if ys else 0.0)
    maxx, maxy = (max(rights) if rights else minx), (max(bottoms) if bottoms else miny)
    span = max(maxx - minx, maxy - miny)
    scale, units = (0.001, "mm") if span > 2000 else (1.0, "m")

    def sx(v: float) -> float:
        return round((v - minx) * scale, 3)

    def sy(v: float) -> float:
        return round((v - miny) * scale, 3)

    def sl(v: float) -> float:  # scale a length (no translate)
        return round(v * scale, 3)

    shelves = []
    for i, (x, y, w, h, name) in enumerate(raw_shelves):
        ww, hh = sl(w), sl(h)
        # MapMaker stores no facing; default the 間口 toward the run's long side
        # (a tall shelf feeds a side aisle, a wide one feeds a front aisle). The
        # editor lets the user override per shelf.
        facing = "down" if ww >= hh else "left"
        shelves.append({"id": f"s{i}", "name": name, "x": sx(x), "y": sy(y),
                        "w": ww, "h": hh, "rack_type": "medium", "facing": facing})

    walls = []
    low_walls = 0
    for i, (x, y, w, h, hmm) in enumerate(raw_walls):
        pts, thick = _centre_line(x, y, w, h, sx, sy, sl)
        wall = {"id": f"w{i}", "points": pts, "thickness": thick}
        if hmm is not None:
            # WallObject.height_mm. Informational only — a knee-high wall is a
            # HINT that it might be a conveyor footprint (v4.10), never proof;
            # see _CONVEYOR_FOOTPRINT_NOTE for why no proof exists in rmpm.
            wall["height_m"] = round(hmm * scale, 3)
            if 0 < hmm <= 1200:
                low_walls += 1
        walls.append(wall)

    stations = []
    for i, (x, y, w, h, name, role) in enumerate(raw_stations):
        st = {"id": name or f"st{i}",
              "x": round(sx(x) + sl(w) / 2, 3),
              "y": round(sy(y) + sl(h) / 2, 3)}
        if role:
            # Only a bench the NAME identified gets its real footprint: a bench's
            # long side decides where the people stand (20 台の梱包台 is 20 rectangles
            # of 0.9×1.4 m, not 20 points). An un-annotated StationObject is often a
            # whole 検品場 area, so calling its 20 m rectangle "one bench" would lie —
            # it keeps the historical point-only dict.
            st["role"] = role
            st["w"], st["d"] = sl(w), sl(h)
            # …and ONE drawn bench is ONE working position. The schema defaults
            # `count` to 3 (a Station used to mean "a packing area with a few
            # people in it"), so 20 drawn 梱包台 would silently become 60 positions
            # — a 3× capacity error in the direction that flatters the design.
            # The drawing counted them for us; take the count it gives.
            st["count"] = 1
        stations.append(st)

    # 北半/南半 に分かれて描かれた1本のベルトを結合してから配線する（結合前に
    # ポリライン化すると「本線で切れた2本」として出てしまう）。
    # 段は結合の可否を分ける（上段還流の北半と下段本線の北半は別のベルト）ので、
    # 名前のキーに高さを添える。段が名前の注記側にしか書かれていなくても効く。
    half_keys = [(f"{k}@{b['elev']}" if k else None)
                 for k, b in ((_half_key(b["name"]), b) for b in raw_belts)]
    grouped: dict[str, list[dict]] = {}
    for key, b in zip(half_keys, raw_belts):
        if key:
            grouped.setdefault(key, []).append(b)
    belts: list[dict] = []
    merged = 0
    seen_keys: set[str] = set()
    for key, b in zip(half_keys, raw_belts):
        if not key or len(grouped[key]) < 2:   # a lone 「…北半」 is just that belt
            belts.append(b)
        elif key not in seen_keys:             # emit the merge where the pair starts
            seen_keys.add(key)
            belts.append(_merge_halves(grouped[key]))
            merged += 1

    conveyors = []
    belt_ids: set[str] = set()
    dir_ignored = 0
    for i, b in enumerate(belts):
        pts, ignored = _belt_points(b, sx, sy, sl)
        dir_ignored += int(ignored)
        cv = {"id": _uniq(belt_ids, b["name"], f"cv{i}"), "name": b["name"],
              "points": pts, "speed_mps": _DEFAULT_BELT_SPEED_MPS}
        if b.get("role"):
            cv["role"] = b["role"]
        if b.get("elev") is not None:
            # 2段駆動コンベアの上段/下段は同じ平面座標に2本ある。高さだけが両者を
            # 分けるので、片方を「重複」として捨ててはいけない (both are kept).
            cv["elevation_m"] = b["elev"]
        conveyors.append(cv)

    markers = []
    mark_ids: set[str] = set()
    for i, (x, y, w, h, name, role) in enumerate(raw_marks):
        markers.append({"id": _uniq(mark_ids, name, f"mk{i}"), "name": name,
                        "x": round(sx(x) + sl(w) / 2, 3),
                        "y": round(sy(y) + sl(h) / 2, 3),
                        "role": role or "worker"})

    non_barriers = []
    bar_ids: set[str] = set()
    for i, (x, y, w, h, name, tag) in enumerate(raw_bars):
        pts, thick = _centre_line(x, y, w, h, sx, sy, sl)
        non_barriers.append({"id": _uniq(bar_ids, name, f"nb{i}"), "name": name,
                             "kind": tag, "points": pts, "thickness": thick})

    # Prefer the authored floor extent (matches MapMaker's view) when present,
    # else fall back to the bounding box of the placed objects.
    fbw = fbh = None
    if fb:
        ll, tt = _num(fb.get("left")), _num(fb.get("top"))
        rr, bb = _num(fb.get("right")), _num(fb.get("bottom"))
        if None not in (ll, tt, rr, bb) and rr > ll and bb > tt:
            fbw, fbh = (rr - ll) * scale, (bb - tt) * scale
    bounds = {"width": max(round(fbw if fbw else (maxx - minx) * scale, 3), 1.0),
              "depth": max(round(fbh if fbh else (maxy - miny) * scale, 3), 1.0)}

    zones = []
    if shelves:
        zones.append({"id": "storage", "type": "storage", "x": 0.0, "y": 0.0,
                      "w": bounds["width"], "h": bounds["depth"],
                      "rack": None, "shelves": shelves})
    zone_ids = {z["id"] for z in zones}
    for i, (x, y, w, h, name, ztype) in enumerate(raw_zones):
        zones.append({"id": _uniq(zone_ids, name, f"z{i}"), "type": ztype,
                      "x": sx(x), "y": sy(y), "w": sl(w), "h": sl(h),
                      "shelves": []})

    if pick_markers:
        warnings.append(f"START/END のピッキング基点マーカー {pick_markers} 件は"
                        "保管棚ではないため除外しました。")
    for t, n in skipped.items():
        warnings.append(f"{t} を {n} 件は現状の単一フロアモデルでは見送りました。")
    if low_walls:
        warnings.append(f"高さ 1.2m 以下の低い壁が {low_walls} 件あります。"
                        + _CONVEYOR_FOOTPRINT_NOTE)
    if conveyors:
        warnings.append(f"名前から搬送設備と判定した {len(conveyors)} 件を"
                        "コンベアとして取り込みました（作業台にはしていません）。")
    if merged:
        warnings.append(f"北半/南半 に分けて描かれたコンベア {merged} 組を、"
                        "本線を跨ぐ1本のコンベアとして結合しました。")
    if dir_ignored:
        warnings.append(f"向きの指定 {dir_ignored} 件は矩形の長辺と直交していたため"
                        "無視しました（進行方向は長辺のままです）。")
    if non_barriers:
        warnings.append(f"停止線・仕切り等 {len(non_barriers)} 件は表示・区画であって"
                        "障壁ではないため、壁から除外しました（経路は塞ぎません）。")
    if markers:
        warnings.append(f"立ち位置マーカー {len(markers)} 件は什器ではなく"
                        "人の配置として取り込みました。")
    if raw_zones:
        warnings.append(f"名前から意味領域と判定した {len(raw_zones)} 件を"
                        "ゾーンとして取り込みました。")
    warnings.append("rmpm は最善努力で解釈しています。寸法/位置は設計タブでご確認ください。")

    return {"bounds": bounds, "zones": zones, "walls": walls, "stations": stations,
            # additive: callers that predate the naming table just ignore these.
            "conveyors": conveyors, "markers": markers, "non_barriers": non_barriers,
            "warnings": warnings,
            "stats": {"shelves": len(shelves), "walls": len(walls),
                      "stations": len(stations), "scale": scale, "units": units,
                      "custom_trailer_bytes": trailer, "low_walls": low_walls,
                      "conveyors": len(conveyors), "markers": len(markers),
                      "non_barriers": len(non_barriers), "merged_conveyors": merged}}


# --- 停止線 → 選択停止ゲート ---------------------------------------------------
# 図面が言えるのは「ゲートがどのベルトのどこにあるか」まで。何が止まって何が通るかは
# 意思なので、名前が書いていればそれを読み、書いていなければ**何も止めないゲート**
# として置く（never blocks: 置いただけでは挙動は1バイトも変わらない）。
_STOP_RULE_RE = re.compile(r"([^｜|、,。・/\s（(]+?)\s*(?:は|が)\s*[^、,。・｜|]{0,8}?(停止|通過)")


def stop_rule_from_name(name) -> dict[str, list[str]]:
    """「検品済オリコンは停止・完成品はカーブへ通過」 → 止まる荷と通る荷."""
    stop: list[str] = []
    pas: list[str] = []
    for subject, verb in _STOP_RULE_RE.findall(str(name or "")):
        s = subject.strip(" 　")
        if not s or s in ("停止線", "停止位置"):
            continue
        bucket = stop if verb == "停止" else pas
        if s not in bucket:
            bucket.append(s)
    out: dict[str, list[str]] = {}
    if stop:
        out["stop_states"] = stop
    if pas:
        out["pass_states"] = pas
    return out


def _seg_cross(a0, a1, b0, b1) -> bool:
    """Do segments a0-a1 and b0-b1 intersect? (orientation test, endpoints count)"""
    def cross(o, p, q):
        return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])

    def between(o, p, q):        # q on segment o-p, given collinear
        return (min(o[0], p[0]) - 1e-9 <= q[0] <= max(o[0], p[0]) + 1e-9
                and min(o[1], p[1]) - 1e-9 <= q[1] <= max(o[1], p[1]) + 1e-9)

    d1, d2 = cross(b0, b1, a0), cross(b0, b1, a1)
    d3, d4 = cross(a0, a1, b0), cross(a0, a1, b1)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)):
        return True
    return ((abs(d1) < 1e-9 and between(b0, b1, a0))
            or (abs(d2) < 1e-9 and between(b0, b1, a1))
            or (abs(d3) < 1e-9 and between(a0, a1, b0))
            or (abs(d4) < 1e-9 and between(a0, a1, b1)))


_GATE_SNAP_M = 1.5      # 図面上、線はベルト端の少し先に引かれる（下の docstring 参照）


def _project(pts: list, m: tuple[float, float]) -> tuple[float, float, float] | None:
    """Closest point on a polyline to ``m`` → ``(arc, perp_dist, forward_offset)``.

    ``forward_offset`` is how far ``m`` lies AHEAD of that closest point along the
    direction of travel — negative means the line is upstream of the belt."""
    best = None
    arc = 0.0
    for i in range(len(pts) - 1):
        p, q = pts[i], pts[i + 1]
        seg = math.dist(p, q)
        if seg <= 0:
            continue
        ux, uy = (q[0] - p[0]) / seg, (q[1] - p[1]) / seg
        t = max(0.0, min(seg, (m[0] - p[0]) * ux + (m[1] - p[1]) * uy))
        cx, cy = p[0] + ux * t, p[1] + uy * t
        d = math.dist((cx, cy), m)
        fwd = (m[0] - cx) * ux + (m[1] - cy) * uy
        if best is None or d < best[1]:
            best = (arc + t, d, fwd)
        arc += seg
    return best


def resolve_stop_gates(conveyors: list[dict], non_barriers: list[dict]) -> int:
    """Attach each drawn 停止線 to the belt it governs, in place. Returns how many.

    A 停止線 is drawn ACROSS the flow, so the drawing already says both which belt
    and where on it — asking the user to retype that would be asking for what we can
    already see. Two things keep the reading honest:

    * **Drawn lines miss by centimetres.** The line is put at the belt's END, which
      in practice lands just past the last drawn segment (P3: belt ends x=36.5, line
      at x=36.8). A crossing test alone finds nothing, so a near miss within
      :data:`_GATE_SNAP_M` counts too — and the gap is recorded in the gate.
    * **A stop line stops goods COMING TOWARD it.** At a hand-over point several
      belts sit within centimetres of the same line (the 下段本線 ending, the 上段
      還流 starting back, the カーブ starting on): picking the geometrically nearest
      would put the gate on whichever was drawn closest. Requiring the line to be
      DOWNSTREAM (ahead along travel) leaves exactly the belt whose goods arrive at
      it. A line that no belt runs into is left alone — it is a floor marking."""
    hits = 0
    for bar in non_barriers:
        if bar.get("kind") != "stop_line":
            continue
        bp = bar.get("points") or []
        if len(bp) < 2:
            continue
        mid = ((bp[0][0] + bp[-1][0]) / 2, (bp[0][1] + bp[-1][1]) / 2)
        best = None                       # (crossed, perp, arc, conveyor)
        for cv in conveyors:
            pts = cv.get("points") or []
            if len(pts) < 2:
                continue
            pr = _project(pts, mid)
            if pr is None:
                continue
            arc, perp, fwd = pr
            crossed = any(_seg_cross(pts[i], pts[i + 1], bp[0], bp[-1])
                          for i in range(len(pts) - 1))
            if not crossed and (perp > _GATE_SNAP_M or fwd < -1e-9):
                continue                  # too far, or the line is upstream of it
            key = (0 if crossed else 1, perp)
            if best is None or key < best[0]:
                best = (key, arc, perp, crossed, cv)
        if best is None:
            continue
        _, arc, perp, crossed, cv = best
        length = sum(math.dist(cv["points"][i], cv["points"][i + 1])
                     for i in range(len(cv["points"]) - 1))
        gate = {"at_m": round(min(arc, length), 3),
                "source": bar.get("name") or bar.get("id")}
        if not crossed:
            # Not proof, just the best reading — say how far off so it is auditable.
            gate["snapped_m"] = round(perp, 3)
        gate.update(stop_rule_from_name(bar.get("name")))
        cv["stop_gate"] = gate
        hits += 1
    return hits


def _empty(warnings: list[str]) -> dict:
    return {"bounds": None, "zones": [], "walls": [], "stations": [],
            "conveyors": [], "markers": [], "non_barriers": [],
            "warnings": warnings,
            "stats": {"shelves": 0, "walls": 0, "stations": 0,
                      "scale": 1.0, "units": "unknown",
                      "conveyors": 0, "markers": 0, "non_barriers": 0,
                      "merged_conveyors": 0}}
