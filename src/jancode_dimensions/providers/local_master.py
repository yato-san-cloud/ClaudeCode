"""自社マスタ(CSV)を参照するプロバイダ。

外部APIに頼らず確実に引ける一次情報源。CSV のヘッダは日本語/英語の
どちらでも可。次のいずれかの形で寸法を記述する:

1. 幅・奥行・高さ を個別の列で持つ(列名例: 幅, 奥行, 高さ / width, depth, height)
   - 値の単位は既定 cm。列名に mm が含まれる場合は mm として扱う。
2. サイズを1列の自由テキストで持つ(列名例: サイズ, size, size_text)
   - parser でテキスト抽出する。

JAN列の列名候補: jan, jancode, jan_code, JANコード, 商品コード, バーコード
"""

from __future__ import annotations

import csv
import unicodedata
from typing import Dict, Optional

from ..models import Dimensions, ProductInfo
from ..parser import parse_dimensions
from .base import DimensionProvider

_JAN_KEYS = {"jan", "jancode", "jan_code", "janコード", "商品コード", "バーコード", "gtin", "ean"}
_WIDTH_KEYS = {"幅", "width", "w", "width_cm", "幅cm", "横"}
_DEPTH_KEYS = {"奥行", "奥行き", "depth", "d", "depth_cm", "奥行cm", "長さ"}
_HEIGHT_KEYS = {"高さ", "height", "h", "height_cm", "高さcm", "高"}
_TEXT_KEYS = {"サイズ", "size", "size_text", "寸法", "三辺"}
_TITLE_KEYS = {"商品名", "title", "name", "品名"}


def _norm_key(s: str) -> str:
    return unicodedata.normalize("NFKC", str(s)).strip().lower()


def _normalize_jan(value: object) -> str:
    s = unicodedata.normalize("NFKC", str(value)).strip()
    # Excel/CSV で 4901234567894.0 のように小数化していたら整数文字列へ。
    if s.endswith(".0") and s[:-2].isdigit():
        s = s[:-2]
    return s.replace(" ", "").replace("-", "")


class LocalMasterProvider(DimensionProvider):
    name = "local"

    def __init__(self, csv_path: str) -> None:
        self._table: Dict[str, ProductInfo] = {}
        self._load(csv_path)

    def _load(self, csv_path: str) -> None:
        with open(csv_path, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            field_map = {_norm_key(h): h for h in (reader.fieldnames or [])}
            jan_col = self._pick(field_map, _JAN_KEYS)
            if jan_col is None:
                raise ValueError(
                    f"マスタにJAN列が見つかりません: {csv_path} (候補: {sorted(_JAN_KEYS)})"
                )
            w_col = self._pick(field_map, _WIDTH_KEYS)
            d_col = self._pick(field_map, _DEPTH_KEYS)
            h_col = self._pick(field_map, _HEIGHT_KEYS)
            text_col = self._pick(field_map, _TEXT_KEYS)
            title_col = self._pick(field_map, _TITLE_KEYS)
            # 列名に mm が含まれていれば mm 入力とみなす。
            unit_scale = 0.1 if any("mm" in _norm_key(c) for c in (w_col or "", d_col or "", h_col or "")) else 1.0

            for row in reader:
                jan = _normalize_jan(row.get(jan_col, ""))
                if not jan:
                    continue
                title = row.get(title_col) if title_col else None
                dims = self._row_dimensions(row, w_col, d_col, h_col, text_col, unit_scale)
                self._table[jan] = ProductInfo(
                    jan=jan,
                    source=self.name,
                    title=title,
                    dimensions=dims,
                    raw_text=row.get(text_col) if text_col else None,
                )

    @staticmethod
    def _pick(field_map: Dict[str, str], keys: set) -> Optional[str]:
        for k in keys:
            if k in field_map:
                return field_map[k]
        return None

    @staticmethod
    def _row_dimensions(row, w_col, d_col, h_col, text_col, unit_scale) -> Optional[Dimensions]:
        if w_col and d_col and h_col:
            try:
                w = float(row[w_col]); d = float(row[d_col]); h = float(row[h_col])
                if w > 0 and d > 0 and h > 0:
                    return Dimensions(w * unit_scale, d * unit_scale, h * unit_scale).rounded()
            except (TypeError, ValueError):
                pass
        if text_col:
            return parse_dimensions(row.get(text_col))
        return None

    def lookup(self, jan: str) -> Optional[ProductInfo]:
        return self._table.get(_normalize_jan(jan))
