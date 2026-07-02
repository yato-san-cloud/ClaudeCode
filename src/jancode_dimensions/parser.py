"""自由テキスト(商品説明文など)から三辺サイズを抽出するパーサ。

商品APIは三辺サイズを構造化フィールドで返さないことが多く、
「幅30×奥行20×高さ10cm」のような自由記述から取り出す必要がある。
本モジュールは代表的な日本語表記を best-effort で解釈する。
"""

from __future__ import annotations

import re
import unicodedata
from typing import List, Optional, Tuple

from .models import Dimensions

_NUM = r"\d+(?:\.\d+)?"
# 数値どうしの区切り。NFKC 正規化と ✕→x 置換の後に評価する。
_SEP = r"\s*[x×*]\s*"
# 単位。長いものを先に並べて最長一致させる。bare "m" は最後。
_UNIT = r"(?:cm|mm|センチメートル|センチ|ミリメートル|ミリ|メートル|m)"

_UNIT_TO_CM = {
    "cm": 1.0,
    "センチ": 1.0,
    "センチメートル": 1.0,
    "mm": 0.1,
    "ミリ": 0.1,
    "ミリメートル": 0.1,
    "m": 100.0,
    "メートル": 100.0,
}

# 軸ラベル。長い表記を先に並べて最長一致させる。latin は小文字化後に評価。
_AXIS_LABELS = {
    "width": ["幅", "横", "よこ", "w"],
    "depth": ["奥行き", "奥行", "奥ゆき", "おくゆき", "奥", "長さ", "ながさ", "d"],
    "height": ["高さ", "たかさ", "高", "h"],
}

_TRIPLE_RE = re.compile(
    rf"({_NUM})\s*({_UNIT})?{_SEP}({_NUM})\s*({_UNIT})?{_SEP}({_NUM})\s*({_UNIT})?"
)

_AXIS_RE = {
    axis: re.compile(
        rf"(?:{'|'.join(labels)})\s*[:：]?\s*(?:約|およそ)?\s*({_NUM})\s*({_UNIT})?"
    )
    for axis, labels in _AXIS_LABELS.items()
}


def _to_cm(value: float, unit: Optional[str]) -> float:
    if not unit:
        return value
    return value * _UNIT_TO_CM.get(unit, 1.0)


def _finalize(triples: List[Tuple[float, Optional[str]]]) -> Optional[Dimensions]:
    """(値, 単位) の3要素から Dimensions を作る。

    一部の軸にしか単位が付かない表記("幅30×奥行20×高さ10cm" など)では、
    最初に見つかった単位を単位未指定の軸へ補完する。
    """
    units = [u for _, u in triples if u]
    fallback = units[0] if units else None
    cms = [_to_cm(v, u or fallback) for v, u in triples]
    if any(c <= 0 for c in cms):
        return None
    return Dimensions(*cms).rounded()


def _parse_labeled(text: str) -> Optional[Dimensions]:
    triples: List[Tuple[float, Optional[str]]] = []
    for axis in ("width", "depth", "height"):
        m = _AXIS_RE[axis].search(text)
        if not m:
            return None
        triples.append((float(m.group(1)), m.group(2)))
    return _finalize(triples)


def _parse_triple(text: str) -> Optional[Dimensions]:
    m = _TRIPLE_RE.search(text)
    if not m:
        return None
    triples = [
        (float(m.group(1)), m.group(2)),
        (float(m.group(3)), m.group(4)),
        (float(m.group(5)), m.group(6)),
    ]
    return _finalize(triples)


def parse_dimensions(text: Optional[str]) -> Optional[Dimensions]:
    """テキストから三辺サイズを抽出する。見つからなければ None。

    1. ラベル付き表記(幅/奥行/高さ, W/D/H)を優先して解釈する。
    2. 見つからなければ「数値×数値×数値[単位]」の3連表記を解釈する。
    """
    if not text:
        return None
    norm = unicodedata.normalize("NFKC", str(text))
    for ch in ("✕", "╳", "☓", "⨯", "Ｘ"):
        norm = norm.replace(ch, "x")
    low = norm.lower()

    return _parse_labeled(low) or _parse_triple(low)
