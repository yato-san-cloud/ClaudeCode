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
as before. Two rules keep the reading from inventing things: the **head** of the
name decides the kind (a note names the neighbours, so a rack address with a note
must stay a rack address), and a **shelf is never reclassified** at all — it is
the one object whose meaning the format itself records.

**荷の種別** (``load_kind_from_name``): a 停止線 sorts loads by kind, and only a
belt can say what it carries — 「本線コンベア｜荷=検品済オリコン」. With no kind on
any belt the gate never matches anything and the mechanism the drawing describes
never fires, so :func:`resolve_stop_gates` reads the kind three ways (explicit
「荷=…」 → the belt's own name → the kind the stop line stops, stamped on the belts
that feed it) and says which reading it used. What it never does is delete a drawn
gate: the model is still being built when this returns.

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
# 全角英数・大小文字を吸収）。当たらなければ従来どおり type で分類する ＝ **規約語を
# 1つも含まない図面の結果は 1バイトも変わらない**（never blocks）。tag は種別ごとの副情報:
#   marker → 役割 / zone → ゾーン種別 / station → 役割 / conveyor → 本線か引き込みか /
#   non_barrier → なぜ壁でないのか。
#
# **どの行が勝つか＝日本語の語順**（`_match_rules`）。名前は「修飾語＋その物」の形で
# 書かれるので、**最後の名詞がその物**である:「引き込み3-梱包台07」は梱包台、
# 「検品者用検品台01」は検品台、「本線コンベア用 停止位置マーカー」はマーカー。
# 表の並び順で勝たせると先頭の修飾語が正体を乗っ取り、実図面の梱包台20台が
# 1.4m のベルト20本になった。だから **種別(kind)は最も後ろで終わる語が決め**、
# tag だけを**表の並び順（具体的な語が上）**で選ぶ ——「仕切り側 引き込みコンベア2」は
# 最後の語がコンベア＝搬送設備、その中では「引き込み」が具体的なので spur。
_NAME_RULES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    # 規約語を含むが**対象外**の物（`classify_name` は None ＝ type で分類）。
    # 「カーブミラー」は通路の鏡であってカーブコンベアではない。
    ("ignore", "fixture", ("ミラー",)),
    # 表示・区画であって障壁ではない（壁として取り込むと経路が塞がる）
    ("non_barrier", "stop_line", ("停止線", "停止位置")),
    ("non_barrier", "partition", ("仕切り", "仕切", "区画線", "表示線")),
    # 人の立ち位置マーカー（什器ではない）。500mm 角で描かれるのが通例だが、
    # 寸法は条件にしない（600mm で描いても立ち位置は立ち位置）。
    ("marker", "inspector", ("検品者", "検査者", "検品作業者")),
    ("marker", "packer", ("梱包者", "梱包作業者")),
    ("marker", "picker", ("ピッカー", "ピッキング作業者")),
    # 「マーカー」は図面上の点であって障壁でも什器でもない（「停止位置マーカー」は
    # 停止線ではない ＝ ゲート解決の対象にしない）。
    ("marker", "worker", ("立ち位置", "立位置", "作業者", "作業員", "マーカー")),
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
    ("station", "bench", ("作業台", "テーブル")),
    ("station", "infeed", ("投入口", "投入部")),
    # 意味領域。**「エリア」単独は入れない** — 「検品エリア」「バッファエリア」まで
    # 積み付けになる。用途が名前に書かれている領域だけを拾い、書かれていなければ
    # 従来どおり type に任せる（StationObject の大きな矩形は「検品場」そのもの）。
    ("zone", "receiving", ("入荷エリア", "入荷置き場", "入荷置場")),
    ("zone", "shipping", ("出荷エリア", "出荷置き場", "出荷置場")),
    ("zone", "packing", ("梱包エリア",)),
    ("zone", "picking", ("ピッキングエリア",)),
    ("zone", "staging", ("積み付け", "積付け", "積付", "置き場", "置場",
                         "バッファ", "仮置き", "仮置")),
)
# `_NAME_RULES` の kind のうち「whsim の種別ではない」を表す擬似 kind。
_IGNORE_KIND = "ignore"

# 2段駆動コンベアの既定デッキ高さ (m)。名前に「床上NNNNmm」/「HNNNN」があれば
# そちらが勝つ（図面が実測値を書いているのに既定で上書きしては嘘になる）。
_TIER_ELEVATION_M: tuple[tuple[str, float], ...] = (("下段", 0.35), ("上段", 0.95))
# 「床上900mm」「H900」「FL+900」= 床からのベルト高さ。**単位は常に mm**（図面の
# 平面座標が m でも、名前に書かれた高さは mm 表記）なので図面スケールを掛けない。
_FLOOR_HEIGHT_RE = re.compile(r"(?:床上|fl\s*\+|fl|h)\s*(\d{2,5})\s*(?:mm)?")
_MAX_ELEVATION_MM = 10000.0
# 注記側で高さ/段/向きを**そのまま1節として**書いた場合だけ拾うための全体一致
# （理由は `_annotation_clauses`）。NFKC 畳み込み後なので全角＝半角。高さは
# 「床上/H/FL+」の印を必須にする — 注記の裸の数字は長さ・列数・台数でもありうる。
_PURE_HEIGHT_RE = re.compile(r"^(?:段\s*[=:]?\s*)?(?:床上|fl\s*\+?|h)\s*(\d{2,5})\s*(?:mm)?$")
_PURE_TIER_RE = re.compile(r"^(?:段\s*[=:]?\s*)?(下段|上段)$")
# 進行方向。取込は MapMaker の軸（x 右+ / y 下+ ・Y反転しない）をそのまま使うので
# 北 = -y。
_DIRECTION_VEC: dict[str, tuple[float, float]] = {
    "東": (1.0, 0.0), "西": (-1.0, 0.0), "北": (0.0, -1.0), "南": (0.0, 1.0),
}
_ARROW_RE = re.compile(r"([東西南北])\s*(?:→|->|=>|⇒|から)\s*([東西南北])")
_HEADING_RE = re.compile(r"([東西南北])\s*(?:向き|向|行き|方向)")
_PURE_ARROW_RE = re.compile(
    r"^([東西南北])\s*(?:→|->|=>|⇒|から)\s*([東西南北])\s*(?:向き|向|行き|方向|へ)?$")
_PURE_HEADING_RE = re.compile(r"^([東西南北])\s*(?:向き|向|行き|方向)$")
# 注記を節に割る区切り。**空白では割らない** —「(下段本線 西→東 の上を戻る)」を
# 空白で割ると「西→東」が単独の向き指定に見えて、他のベルトの流れでこのベルトを
# 反転させてしまう。
_CLAUSE_SPLIT_RE = re.compile(r"[()（）｜|、,。・/／\[\]［］【】〔〕]+")
# 荷の種別 (`Conveyor.load_kind`) の明示宣言。「荷=検品済オリコン」「荷種:完成品」。
# 何を運ぶかは形にも type にも無いので、書いてあれば読む・無ければ何も言わない
# （推測しない ＝ 停止線のゲートが空振りしていることを黙って隠さない）。
# 「入荷:」「出荷:」の末尾を掴まないよう直前の1文字を見る（部分一致なので）。
_LOAD_KIND_RE = re.compile(r"(?<![入出手])(?:荷種|荷|積載)\s*[=:]\s*([^)）｜|、,。・/／\s]+)")
# 本線を跨ぐ1本のベルトを、作図の都合で半分ずつ描いたときの語。
_HALF_TOKENS = ("北半", "南半", "東半", "西半")
# 名前の「識別子」と「注記」の境目。全角/半角の括弧と縦棒（MapMaker の名前欄は
# 1行なので、注記はこれらの後ろに書かれる）。
_ANNOTATION_DELIMS = ("(", "（", "｜", "|", "[", "［", "【", "〔")
_DEFAULT_BELT_SPEED_MPS = 0.5   # mirrors cad.py / mapmaker_kpi (rmpm has no speed)


def _nfkc(s) -> str:
    """NFKC-normalised text, case preserved (半角カナ/全角英数 → 標準形)."""
    return unicodedata.normalize("NFKC", str(s or ""))


def _fold(s) -> str:
    """NFKC-fold + lowercase, for tolerant substring matching (半角カナ/全角英数)."""
    return _nfkc(s).lower()


def _cut(name) -> tuple[str, str]:
    """A drawn name split at its FIRST annotation delimiter → ``(head, tail)``."""
    s = str(name or "")
    cut = len(s)
    for d in _ANNOTATION_DELIMS:
        i = s.find(d)
        if 0 < i < cut:
            cut = i
    return s[:cut].strip(), s[cut:]


def _split_annotation(name) -> str:
    """The drawn name minus its annotation tail, original case preserved."""
    return _cut(name)[0]


def _head(name) -> str:
    """The identity half of a drawn name: everything before the first annotation.

    Draughtsmen write 「何であるか(どこに・どうする)」 — the head names the object,
    the bracketed/｜ tail says where it is, what flows on it or where it goes. Those
    tails routinely mention OTHER kinds of object (「検品者立ち位置マーカー(西・仕切り
    付近)」 is a person standing near a partition, 「投入口(検品済オリコン→下段本線)」
    is a chute feeding the trunk), so matching the tail turns people into partitions
    and chutes into trunk belts. **The head alone decides the kind** — a head that
    says nothing is a bare code (`100-01-09`, `L-3`, `No.3`), i.e. an object whose
    identity the drawing states by its TYPE, and reading its note instead turns a
    rack address into whatever the draughtsman mentioned next to it."""
    return _fold(_split_annotation(name))


def _annotation_clauses(name) -> list[str]:
    """The annotation tail, folded and split into clauses.

    Only used for the few facts that legitimately live in a note — the deck height
    and the travel direction of THIS belt (「(床上900mm)」「(東向き)」). A clause
    counts only when it is NOTHING BUT that fact: a note freely describes other
    equipment (「(下段本線H900から分岐)」 is the TRUNK's deck, 「(還流は西向き・本線は
    東向き)」 names two belts), and reading those as this belt's own reverses the
    trunk — which inverts `points[0]`/`points[-1]` and with it the whole chain."""
    tail = _cut(name)[1]
    return [c.strip() for c in _CLAUSE_SPLIT_RE.split(_fold(tail)) if c.strip()]


def _match_rules(s: str) -> tuple[str, str] | None:
    """``(kind, tag)`` for folded text ``s``: the LAST noun decides (see `_NAME_RULES`).

    Kind = the rule word that ENDS furthest right (ties: the longer word, then the
    table's order). Tag = the first row of THAT kind whose word appears at all, so
    the table's specificity ordering still picks 引き込み over コンベア."""
    best: tuple[int, int] | None = None
    kind: str | None = None
    for kd, _tag, words in _NAME_RULES:
        for w in words:
            i = s.rfind(w)
            if i < 0:
                continue
            key = (i + len(w), len(w))
            if best is None or key > best:
                best, kind = key, kd
    if kind is None:
        return None
    for kd, tag, words in _NAME_RULES:
        if kd == kind and any(w in s for w in words):
            return kind, tag
    return None      # pragma: no cover — the winning kind always has a row


def classify_name(name) -> tuple[str, str] | None:
    """``(kind, tag)`` for a MapMaker object NAME, or ``None`` when no rule hits.

    ``None`` means "fall back to the historical type-based classification", which
    is what keeps a drawing that follows no naming convention byte-identical."""
    hit = _match_rules(_head(name))
    return None if (hit is None or hit[0] == _IGNORE_KIND) else hit


def _mm_to_m(mm) -> float | None:
    """A height written in mm → metres, or ``None`` when it is not a plausible one."""
    v = _num(mm)
    return round(v / 1000.0, 3) if (v is not None and 0 < v <= _MAX_ELEVATION_MM) else None


def _belt_elevation_m(name) -> float | None:
    """Deck height (m) written into a belt's name, or ``None`` when unstated.

    A measured height always beats a tier default (the drawing wrote the real
    number), and the HEAD always beats the note — 「引き込み3 北半(下段本線H900から
    分岐)」 states the TRUNK's deck, and taking it as the spur's own gave the two
    halves different keys so the pair never merged back into one belt."""
    head = _head(name)
    m = _FLOOR_HEIGHT_RE.search(head)
    if m:
        ev = _mm_to_m(m.group(1))
        if ev is not None:
            return ev
    clauses = _annotation_clauses(name)
    for c in clauses:
        m = _PURE_HEIGHT_RE.match(c)
        if m:
            ev = _mm_to_m(m.group(1))
            if ev is not None:
                return ev
    for word, ev in _TIER_ELEVATION_M:
        if word in head:
            return ev
    for c in clauses:
        m = _PURE_TIER_RE.match(c)
        if m:
            return dict(_TIER_ELEVATION_M)[m.group(1)]
    return None


def _belt_direction(name) -> tuple[float, float] | None:
    """Travel direction unit vector from 「東向き」/「北→南」, else ``None``.

    The head may say it any way it likes; a note only counts when the clause is
    nothing but the direction, because notes describe the neighbours' flow
    (「(還流は西向き・本線は東向き)」) and obeying that runs the trunk backwards."""
    head = _head(name)
    m = _ARROW_RE.search(head)
    if m:
        return _DIRECTION_VEC.get(m.group(2))
    m = _HEADING_RE.search(head)
    if m:
        return _DIRECTION_VEC.get(m.group(1))
    for c in _annotation_clauses(name):
        m = _PURE_ARROW_RE.match(c)
        if m:
            return _DIRECTION_VEC.get(m.group(2))
        m = _PURE_HEADING_RE.match(c)
        if m:
            return _DIRECTION_VEC.get(m.group(1))
    return None


def _half_key(name) -> str | None:
    """Grouping key for a 「…北半」/「…南半」 pair, or ``None`` if not a half.

    Both the test and the key read the HEAD: a note routinely names the belt that
    crosses this one (「本線コンベア(北半の引き込みと交差)」 is the trunk, not a half
    of anything), and treating that as a half merged the trunk with an unrelated
    spur 45 m away into one 50 m rectangle. EVERY half token is then removed,
    because a head can name both (「北半・南半と一体」) — cancelling just the first
    one found leaves the two names different and the pair never merges."""
    head = _head(name)
    if not any(tok in head for tok in _HALF_TOKENS):
        return None
    for tok in _HALF_TOKENS:
        head = head.replace(tok, "")
    return re.sub(r"\s+", "", head)


def load_kind_from_name(name) -> str:
    """荷の種別 (`Conveyor.load_kind`) declared in a belt's name, else ``""``.

    What a belt CARRIES is neither in the geometry nor in the object type, and a
    停止線 can only sort loads that carry a kind — so an explicit 「荷=検品済オリコン」
    is read wherever it stands (head or note: it states this belt's own cargo, not
    a neighbour's). Nothing is guessed: an unstated belt keeps the schema's ``""``
    and the gate resolver says so out loud rather than reporting a gate that
    sorts nothing."""
    m = _LOAD_KIND_RE.search(_nfkc(name))
    return m.group(1).strip() if m else ""


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
            "dir": next((m["dir"] for m in members if m.get("dir")), None),
            "load_kind": next((m["load_kind"] for m in members if m.get("load_kind")), "")}


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
    shelf_name_conflicts: list[str] = []
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
        named = classify_name(name)
        if t in _SHELF_TYPES and named:
            # …with ONE exception: a shelf is the one object whose meaning the
            # FORMAT records (FreeShelfObject IS 「名前を持つ棚」, and that name is a
            # WMS rack address = the join key for stock). A rule matching inside a
            # rack address must not delete the shelf — the drawn 棚 5 本 came back
            # as 0 shelves, no storage zone, and every warning read like success.
            shelf_name_conflicts.append(name)
            named = None
        kind, tag = named or (None, "")
        if kind == "conveyor" and max(w, h) > 0:
            raw_belts.append({"x": x, "y": y, "w": w, "h": h, "name": name,
                              "role": tag, "elev": _belt_elevation_m(name),
                              "dir": _belt_direction(name),
                              "load_kind": load_kind_from_name(name)})
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
    # Two benches drawn with the SAME name are two benches. Every other collection
    # here already deduped (`belt_ids` / `mark_ids` / …) and stations did not, so a
    # line drawn as 20 identically-named 梱包台 arrived as 20 objects sharing one id
    # — harmless while a Station was a point, but they now carry role/w/d/count and
    # anything that looks one up by id (scenario edits, the editor, KPI read-outs)
    # would silently address whichever one it found first.
    station_ids: set[str] = set()
    for i, (x, y, w, h, name, role) in enumerate(raw_stations):
        st = {"id": _uniq(station_ids, name, f"st{i}"),
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
        if b.get("load_kind"):
            # 荷の種別。書かれていなければキーごと出さない ＝ スキーマ既定の "" ＝
            # 従来どおり「1種類の荷が流れるベルト」。
            cv["load_kind"] = b["load_kind"]
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
    if shelf_name_conflicts:
        # 黙って棚のままにするのではなく、食い違いを見せる（never blocks）。
        sample = "・".join(shelf_name_conflicts[:3])
        warnings.append(
            f"棚として描かれた {len(shelf_name_conflicts)} 件は名前が別の設備を"
            f"指していますが（例: {sample}）、形式上は棚なので棚のまま取り込みました。"
            "設備として扱うなら作業台/壁として描き直すか、設計タブで置き換えてください。")
    if conveyors:
        warnings.append(f"名前から搬送設備と判定した {len(conveyors)} 件を"
                        "コンベアとして取り込みました（作業台にはしていません）。")
    kinds = sorted({c["load_kind"] for c in conveyors if c.get("load_kind")})
    if kinds:
        warnings.append(f"ベルト名から荷の種別 {'・'.join(kinds)} を読み取りました"
                        "（停止線の選択停止はこの種別で判定します）。")
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
# 仕分けが成立するには**3つ**が要る: 位置（図面）・止める種別（停止線の名前）・
# 荷の種別（ベルトの名前）。3つ目が無いゲートは動かないので、動くふりをしない。
_STOP_RULE_RE = re.compile(r"([^｜|、,。・/\s（(]+?)\s*(?:は|が)\s*[^、,。・｜|]{0,8}?(停止|通過)")


def stop_rule_from_name(name) -> dict[str, list[str]]:
    """「検品済オリコンは停止・完成品はカーブへ通過」 → 止まる荷と通る荷.

    Subjects come back NFKC-normalised, because they are matched against the
    kinds belts stamp (`load_kind_from_name`) and 半角カナ on one drawing and
    全角 on the other must not read as two different loads.

    A subject that is a UNIVERSAL quantifier (「全ての荷が停止」「物理ストッパー」)
    is not a load kind — it is the drawing saying the line has no selectivity at
    all. Reading it as a kind mints a phantom `load_kind="全ての荷"` that gets
    stamped onto the feeder belts, and the gate then stops everything only by
    that accident: authored models with real kinds would silently mismatch. Such
    a name resolves to ``{"mode": "all"}`` (the engine's 物理ストッパー), and no
    kind inference runs for it."""
    s_all = _nfkc(name)
    if "物理ストッパ" in s_all:
        return {"mode": "all"}
    stop: list[str] = []
    pas: list[str] = []
    for subject, verb in _STOP_RULE_RE.findall(s_all):
        s = subject.strip(" 　")
        if not s or s in ("停止線", "停止位置"):
            continue
        if verb == "停止" and s in _ALL_LOADS_SUBJECTS:
            return {"mode": "all"}
        bucket = stop if verb == "停止" else pas
        if s not in bucket:
            bucket.append(s)
    out: dict[str, list[str]] = {}
    if stop:
        out["stop_states"] = stop
    if pas:
        out["pass_states"] = pas
    return out


# Subjects that mean "everything", not a kind. 「全ての荷が停止」 is a statement
# about the STOPPER (no selectivity), not about a load called 全ての荷.
_ALL_LOADS_SUBJECTS = frozenset({
    "全ての荷", "すべての荷", "全部の荷", "全荷", "全て", "すべて", "全ての荷物",
})


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


def _fed_by_another_belt(cv: dict, conveyors: list[dict]) -> bool:
    """True when goods reach ``cv`` FROM another drawn belt (hand-over or branch).

    Uses the one join rule (:mod:`whsim.beltgeom`) both the engine and the oracle
    use, rather than a third copy of "these two touch"."""
    from whsim import beltgeom
    pts = cv.get("points") or []
    if len(pts) < 2:
        return False
    others = [(str(c.get("id") or ""), c.get("points") or [])
              for c in conveyors if c is not cv and len(c.get("points") or []) >= 2]
    if beltgeom.attach(pts[0], others) is not None:
        return True                        # its infeed sits on another belt's path
    mine = [(str(cv.get("id") or ""), pts)]
    return any(beltgeom.attach(o[-1], mine) is not None for _bid, o in others)


def _kind_carried(cv: dict, named: list[str]) -> str:
    """The gate-named 荷の種別 written into this belt's own name, else ``""``.

    Closed-world on purpose: only a kind some 停止線 already names can be read off
    a belt, so this can never invent a load. The HEAD only — a note names the
    neighbours' cargo (「本線コンベア(検品済オリコン→梱包)」 is a trunk that carries
    BOTH kinds, and stamping it with one would sort the other one wrongly)."""
    head = _head(cv.get("name") or cv.get("id"))
    hits = [k for k in named if k and _fold(k) in head]
    return max(hits, key=lambda k: (len(k), k)) if hits else ""


def _upstream_belts(cv: dict, conveyors: list[dict]) -> list[dict]:
    """``cv`` plus every belt a load reaching it can have ridden, transitively.

    Two joints, the same two the engine's chain is built from: a belt that
    DISCHARGES onto this one hands its loads over, and the belt this one BRANCHES
    off (our infeed sits on its path) is where a 引き込み's loads come from. These
    are the belts a load riding into ``cv``'s gate can have boarded, which is where
    荷の種別 has to be stamped for that gate to sort anything (the engine stamps at
    boarding and the kind then travels with the load). Same join rule as everywhere
    else (:mod:`whsim.beltgeom`); the walk is bounded by the belt count so a
    mis-drawn loop terminates."""
    from whsim import beltgeom
    chain = [cv]
    seen = {id(cv)}
    i = 0
    while i < len(chain) and len(chain) <= len(conveyors):
        cur, i = chain[i], i + 1
        pts = cur.get("points") or []
        if len(pts) < 2:
            continue
        target = [(str(cur.get("id") or ""), pts)]
        host = beltgeom.attach(pts[0], [(str(c.get("id") or ""), c.get("points") or [])
                                        for c in conveyors if c is not cur])
        for other in conveyors:
            op = other.get("points") or []
            if id(other) in seen or len(op) < 2:
                continue
            if (beltgeom.attach(op[-1], target) is not None
                    or (host is not None and str(other.get("id") or "") == host[0])):
                seen.add(id(other))
                chain.append(other)
    return chain


def resolve_stop_gates(conveyors: list[dict], non_barriers: list[dict]) -> dict:
    """Attach each drawn 停止線 to the belt it governs, in place.

    Returns ``{"positioned", "armed", "pending", "dropped", "kinds", "warnings"}``
    — gates PLACED, gates that sort right now, gates still waiting for a belt to
    declare their 荷の種別, stop lines refused, the kinds belts carry, and what to
    tell the user. **positioned ≠ armed**, but a pending gate is KEPT: the model is
    edited after this returns (entry belts are given their kind in a later step),
    so an importer that deletes a drawn gate because the model is not finished yet
    would silently double the line's capacity (measured: 434 → 846 件/h).

    A 停止線 is drawn ACROSS the flow, so the drawing already says both which belt
    and where on it — asking the user to retype that would be asking for what we can
    already see. Four things keep the reading honest:

    * **Drawn lines miss by centimetres.** The line is put at the belt's END, which
      in practice lands just past the last drawn segment (P3: belt ends x=36.5, line
      at x=36.8). A crossing test alone finds nothing, so a near miss within
      :data:`_GATE_SNAP_M` counts too — and the gap is recorded in the gate.
    * **A stop line stops goods COMING TOWARD it.** At a hand-over point several
      belts sit within centimetres of the same line (the 下段本線 ending, the 上段
      還流 starting back, the カーブ starting on): picking the geometrically nearest
      would put the gate on whichever was drawn closest. Requiring the line to be
      DOWNSTREAM (ahead along travel) leaves exactly the belt whose goods arrive at
      it. A line that no belt runs into is left alone — it is a floor marking.
      Equidistant belts tie by **belt id**, the same tie-break the join rule uses,
      so swapping two objects in the file cannot swap the answer.
    * **A gate sorts 荷の種別, and only a belt can state one.** The engine stamps
      the kind of the belt a load BOARDS and it then travels with the load, so a
      belt that states nothing stamps ``""`` and no ``stop_states`` ever matches —
      the mechanism the drawing describes never fires. Three readings, in order:
      an explicit 「荷=検品済オリコン」 on a belt; the kind written into a belt's own
      name (closed-world: only kinds a 停止線 already names); and finally, for a
      gate whose 止める荷 nothing declares, the belts that FEED that gate are
      stamped with it — the loads arriving at a stop line are, by construction, the
      loads it stops. Every inference is said out loud in a warning, and an
      explicit statement always wins.
    * **One belt, one gate.** ``Conveyor.stop_gate`` is a single gate, so a second
      stop line on the same belt cannot be honoured. The one FURTHEST UPSTREAM is
      kept (a load stopped there never reaches the other) and the other is refused
      out loud — never silently overwritten."""
    warnings: list[str] = []
    placed: list[tuple[dict, dict]] = []      # (conveyor, gate) in drawing order
    for bar in non_barriers:
        if bar.get("kind") != "stop_line":
            continue
        bp = bar.get("points") or []
        if len(bp) < 2:
            continue
        mid = ((bp[0][0] + bp[-1][0]) / 2, (bp[0][1] + bp[-1][1]) / 2)
        best = None                       # (key, arc, perp, crossed, conveyor)
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
            # Ties by belt id (mirrors beltgeom.attach): two belts the same
            # distance away must resolve the same way whatever order they were
            # drawn in, or the model changes when somebody re-saves the drawing.
            key = (0 if crossed else 1, perp, str(cv.get("id") or ""))
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
        placed.append((cv, gate))

    # --- 荷の種別: what the belts carry, so the rules can be checked -----------
    named: list[str] = []
    for _cv, gate in placed:
        for k in list(gate.get("stop_states") or []) + list(gate.get("pass_states") or []):
            if k not in named:
                named.append(k)
    read_off_name: list[str] = []
    for cv in conveyors:
        if not cv.get("load_kind"):
            k = _kind_carried(cv, named)
            if k:
                cv["load_kind"] = k
                read_off_name.append(f"{cv.get('id')}={k}")
    if read_off_name:
        warnings.append("停止線が名指しした荷の種別をベルト名から読み取りました: "
                        + "・".join(read_off_name) + "。")
    carried = {str(cv["load_kind"]) for cv in conveyors if cv.get("load_kind")}
    handed_over = sorted(str(cv.get("id")) for cv in conveyors if cv.get("load_kind")
                         and _fed_by_another_belt(cv, conveyors))
    if handed_over:
        # Honoured, but say what it can and cannot do: the kind is stamped where a
        # load first boards, so on a belt fed by another one it only applies to
        # loads that start there — goods handed over keep the kind they boarded with.
        warnings.append(
            f"{'・'.join(handed_over)} は他のベルトから荷を受けています。荷の種別は"
            "最初に載ったベルトが決めるので、受け継いだ荷の種別は変わりません"
            "（このベルトに直接載る荷にだけ効きます）。")

    # --- one gate per belt (`Conveyor.stop_gate` is a single gate) --------------
    keep: dict[int, tuple[dict, dict]] = {}
    dropped = 0
    for cv, gate in placed:
        prev = keep.get(id(cv))
        if prev is None:
            keep[id(cv)] = (cv, gate)
            continue
        dropped += 1
        # 上流側を残す: a load stopped at the first gate never reaches the second,
        # so the upstream one is the one the line actually obeys.
        old = prev[1]
        win, lose = ((gate, old) if (gate["at_m"], str(gate["source"]))
                     < (old["at_m"], str(old["source"])) else (old, gate))
        keep[id(cv)] = (cv, win)
        warnings.append(
            f"コンベア「{cv.get('id')}」には停止線が2本以上かかっています。"
            f"上流側の「{win['source']}」だけをゲートにし、「{lose['source']}」は"
            "見送りました（1本のベルトに設定できるゲートは1つです）。")
    # --- 止まる荷は、そのゲートへ荷を運ぶベルトが押している -----------------------
    # 停止線が「検品済オリコンは停止」と書いているなら、そのゲートに着く荷は
    # 検品済オリコンである（それが止まる荷なのだから）。どのベルトも種別を宣言して
    # いないときに限り、ゲートのベルトとその上流にその種別を押す。宣言があれば
    # 触らない。**推定であることは警告で言う**。
    # ゲートを見る順はベルトIDで固定する（作図順ではない）: 2つのゲートの上流が
    # 重なっている図面で、停止線の並び順によって押される種別が変わってはいけない。
    for cv, gate in sorted(keep.values(),
                           key=lambda p: (str(p[0].get("id") or ""), p[1]["at_m"])):
        stop_states = list(gate.get("stop_states") or [])
        if not stop_states:
            continue                      # 通す荷だけ ＝ 押すべき種別が書かれていない
        # 還流ベルトは空容器を戻す脚（名前がそう言っている）。同じ平面座標を共有する
        # ので幾何上は上流に見えるが、そこに荷の種別を押すのは図面より踏み込みすぎ。
        chain = [c for c in _upstream_belts(cv, conveyors) if c.get("role") != "return"]
        if not chain or any(c.get("load_kind") for c in chain):
            continue                      # 図面が言っている方が強い
        k = stop_states[0]
        for c in chain:
            c["load_kind"] = k
        carried.add(k)
        warnings.append(
            f"「{gate['source']}」が止める荷「{k}」を、ゲートへ荷を運ぶベルト "
            + "・".join(str(c.get("id")) for c in chain)
            + " の荷の種別として推定しました（図面が種別を書いていないため。"
              "違う場合はベルト名に「荷=…」を書いてください）。")

    armed = 0
    pending: list[str] = []
    for cv, gate in keep.values():
        stop_states = list(gate.get("stop_states") or [])
        pass_states = list(gate.get("pass_states") or [])
        # 物理ストッパー: no selectivity, so it needs no declared kinds to work —
        # it is armed by construction and never pending.
        if gate.get("mode") == "all":
            armed += 1
            cv["stop_gate"] = gate
            continue
        # Mirrors the engine's three-valued selection (`build.StopGate.stops`):
        # 止める荷 wins when written, otherwise everything NOT passing stops.
        if stop_states:
            if set(stop_states) & carried:
                armed += 1
            else:
                # The rule STAYS as drawn — the model is edited after this import
                # (the entry belts get their 荷の種別 in a later step), and an
                # importer that deletes the gate because the model is not finished
                # yet silently doubles the line's capacity. Say what it waits for.
                pending.append(f"{gate['source']}（{'・'.join(stop_states)}）")
        elif pass_states:
            # 通す荷しか書かれていない ＝ 種別を宣言していない荷は全部止まる。それが
            # 図面の言っていることなので効かせるが、意図と違うなら分かるように言う。
            armed += 1
            if any(not c.get("load_kind") for c in conveyors):
                warnings.append(
                    f"「{gate['source']}」は通す荷「{'・'.join(pass_states)}」だけを"
                    "書いています。荷の種別が書かれていないベルトの荷は、すべて"
                    "このゲートで停止します（止める荷も書くか、通る荷を運ぶベルトに"
                    "「荷=…」を書いてください）。")
        cv["stop_gate"] = gate
    if pending:
        warnings.append(
            f"停止線 {len(pending)} 本はゲートとして残しましたが、止める荷の種別を"
            "宣言しているベルトがまだありません: " + "・".join(pending)
            + "。どれかのベルトが `load_kind` にこの値を持つまで、このゲートは"
              "何も止めません（ベルト名に「荷=…」を書くか、設計側で設定してください）。")
    return {"positioned": len(keep), "armed": armed, "pending": len(pending),
            "dropped": dropped, "kinds": sorted(carried), "warnings": warnings}


def _empty(warnings: list[str]) -> dict:
    return {"bounds": None, "zones": [], "walls": [], "stations": [],
            "conveyors": [], "markers": [], "non_barriers": [],
            "warnings": warnings,
            "stats": {"shelves": 0, "walls": 0, "stations": 0,
                      "scale": 1.0, "units": "unknown",
                      "conveyors": 0, "markers": 0, "non_barriers": 0,
                      "merged_conveyors": 0}}
