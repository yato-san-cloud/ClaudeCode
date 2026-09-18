"""Reading the input table (Excel or CSV) without hard-coding its shape.

Real WMS exports put a title line and an export-timestamp line above the header,
write half-width kana in the header, and emit ragged CSV rows. The header row is
therefore located by looking for the column names the mapping asks for (or taken
from mapping.input.header_row when it is pinned), and short/long CSV rows are
salvaged rather than fatal.
"""

from __future__ import annotations

import csv
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .mapping import Mapping
from .normalize import cell_to_text

EXCEL_SUFFIXES = (".xlsx", ".xlsm", ".xltx", ".xls")
_HEADER_SEARCH_ROWS = 30


class InputError(ValueError):
    """The input file cannot be read at all (not a per-row problem)."""


@dataclass
class Row:
    number: int  # 1-based row number in the source file, as a spreadsheet shows it
    cells: dict[str, Any]  # contract field key -> raw cell value


@dataclass
class Table:
    header_row_number: int
    header: list[str]
    rows: list[Row]
    column_of: dict[str, str]  # field key -> matched source column name
    missing_fields: list[str]


def _fold(text: Any) -> str:
    """Header comparison key: NFKC (half-width kana folds), no spaces, lower."""
    folded = unicodedata.normalize("NFKC", cell_to_text(text))
    return "".join(folded.split()).lower()


def _read_raw(path: Path, m: Mapping) -> list[list[Any]]:
    suffix = path.suffix.lower()
    if suffix in EXCEL_SUFFIXES:
        import pandas as pd

        try:
            frame = pd.read_excel(path, sheet_name=m.sheet, header=None, dtype=object)
        except ValueError as exc:  # unknown sheet name / index
            raise InputError(f"{path}: {exc}") from exc
        return [list(row) for row in frame.itertuples(index=False, name=None)]

    encodings = [m.csv_encoding, "utf-8-sig", "cp932"]
    last: Exception | None = None
    for encoding in dict.fromkeys(encodings):
        try:
            with path.open("r", encoding=encoding, newline="") as fh:
                return [row for row in csv.reader(fh, delimiter=m.csv_delimiter)]
        except UnicodeDecodeError as exc:
            last = exc
    raise InputError(f"{path}: could not decode with {encodings} ({last})")


def _locate_header(raw: list[list[Any]], m: Mapping) -> int:
    wanted = {_fold(alias) for aliases in m.columns.values() for alias in aliases}
    if m.header_row != "auto":
        index = int(m.header_row)
        if index >= len(raw):
            raise InputError(f"input.header_row={index} but the file has {len(raw)} rows")
        return index
    best_index, best_hits = -1, 0
    for index, row in enumerate(raw[:_HEADER_SEARCH_ROWS]):
        hits = sum(1 for cell in row if _fold(cell) in wanted)
        if hits > best_hits:
            best_index, best_hits = index, hits
    if best_index < 0:
        raise InputError(
            "could not find a header row: none of the column names in mapping.yaml "
            f"appear in the first {_HEADER_SEARCH_ROWS} rows"
        )
    return best_index


def read_table(path: str | Path, m: Mapping) -> Table:
    path = Path(path)
    if not path.exists():
        raise InputError(f"{path}: no such file")
    raw = _read_raw(path, m)
    if not raw:
        raise InputError(f"{path}: file is empty")

    header_index = _locate_header(raw, m)
    header = [cell_to_text(cell) for cell in raw[header_index]]
    folded = {_fold(name): position for position, name in enumerate(header) if _fold(name)}

    column_of: dict[str, str] = {}
    position_of: dict[str, int] = {}
    missing: list[str] = []
    for fieldkey, aliases in m.columns.items():
        for alias in aliases:
            position = folded.get(_fold(alias))
            if position is not None:
                column_of[fieldkey] = header[position]
                position_of[fieldkey] = position
                break
        else:
            missing.append(fieldkey)

    rows: list[Row] = []
    for offset, raw_row in enumerate(raw[header_index + 1 :], start=header_index + 2):
        if all(cell_to_text(cell) == "" for cell in raw_row):
            continue
        cells = {
            fieldkey: (raw_row[position] if position < len(raw_row) else None)
            for fieldkey, position in position_of.items()
        }
        rows.append(Row(number=offset, cells=cells))

    return Table(
        header_row_number=header_index + 1,
        header=header,
        rows=rows,
        column_of=column_of,
        missing_fields=missing,
    )
