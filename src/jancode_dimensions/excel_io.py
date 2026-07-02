"""Excel(.xlsx) の読み込みと三辺サイズの転記。"""

from __future__ import annotations

import unicodedata
from typing import Dict, List, Optional

# JAN列の自動判定に使うヘッダ候補(正規化後)。
JAN_HEADER_CANDIDATES = [
    "jancode", "jan", "janコード", "jan_code", "jan code",
    "バーコード", "商品コード", "gtin", "ean",
]

# 転記する出力列。存在しなければヘッダ行に追記する。
# 「照合商品名」は取得元で見つかった商品名(JANが正しく一致したかの確認用)。
# 入力に既にある「商品名」列を上書きしないよう、あえて別名にしている。
OUTPUT_COLUMNS = [
    "幅(cm)", "奥行(cm)", "高さ(cm)", "三辺合計(cm)",
    "取得元", "照合商品名", "取得日時", "備考",
]


def _norm(s: object) -> str:
    return unicodedata.normalize("NFKC", str(s)).strip().lower()


class ExcelSheet:
    """1シートに対する読み書きを担うラッパ。ヘッダは ``header_row`` 行目。"""

    def __init__(self, path: str, sheet: Optional[str] = None, header_row: int = 1) -> None:
        import openpyxl  # 遅延import

        self.path = path
        self.header_row = header_row
        self._wb = openpyxl.load_workbook(path)
        self._ws = self._wb[sheet] if sheet else self._wb.active
        self._headers: Dict[str, int] = self._read_headers()

    def _read_headers(self) -> Dict[str, int]:
        headers: Dict[str, int] = {}
        for col in range(1, self._ws.max_column + 1):
            value = self._ws.cell(row=self.header_row, column=col).value
            if value is not None and _norm(value):
                headers[_norm(value)] = col
        return headers

    def find_jan_column(self, explicit: Optional[str] = None) -> int:
        if explicit:
            col = self._headers.get(_norm(explicit))
            if col is None:
                raise ValueError(
                    f"指定のJAN列 '{explicit}' が見つかりません。"
                    f" 既存ヘッダ: {self.header_names()}"
                )
            return col
        for cand in JAN_HEADER_CANDIDATES:
            if cand in self._headers:
                return self._headers[cand]
        raise ValueError(
            "JAN列を自動判定できませんでした。--jan-column で列名を指定してください。"
            f" 既存ヘッダ: {self.header_names()}"
        )

    def find_column(self, *names: str) -> Optional[int]:
        """候補名のいずれかに一致するヘッダの列番号を返す。無ければ None。"""
        for name in names:
            col = self._headers.get(_norm(name))
            if col is not None:
                return col
        return None

    def header_names(self) -> List[str]:
        labels = []
        for col in range(1, self._ws.max_column + 1):
            v = self._ws.cell(row=self.header_row, column=col).value
            if v is not None:
                labels.append(str(v))
        return labels

    def ensure_output_columns(self) -> Dict[str, int]:
        """出力列を用意し、{列名: 列番号} を返す。無い列はヘッダ末尾に追記。"""
        mapping: Dict[str, int] = {}
        next_col = self._ws.max_column + 1
        for name in OUTPUT_COLUMNS:
            col = self._headers.get(_norm(name))
            if col is None:
                col = next_col
                self._ws.cell(row=self.header_row, column=col, value=name)
                self._headers[_norm(name)] = col
                next_col += 1
            mapping[name] = col
        return mapping

    def iter_data_rows(self):
        """(行番号, 行dict) を返す。"""
        for row in range(self.header_row + 1, self._ws.max_row + 1):
            yield row

    def get(self, row: int, col: int):
        return self._ws.cell(row=row, column=col).value

    def set(self, row: int, col: int, value) -> None:
        self._ws.cell(row=row, column=col, value=value)

    def save(self, path: Optional[str] = None) -> str:
        out = path or self.path
        self._wb.save(out)
        return out
