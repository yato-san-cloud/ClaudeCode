"""Code normalisation and master lookup.

Two failure modes seen in real WMS exports drive the design:

* the master zero-pads a code and the history does not (or Excel ate the leading
  zeros by storing the code as a number) -- match rates collapse to 0% unless
  both sides are normalised through the *same* rule;
* a code segment is alphabetic (area) while the next is numeric (aisle), so a
  single whole-string zero-pad corrupts it -- padding is therefore per segment.

Both rules live in mapping.yaml, never in the code.
"""

from __future__ import annotations

import csv
import math
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_TRIM_CHARS = " \t\r\n　"


def cell_to_text(value: Any) -> str:
    """Excel/CSV cell -> text, without inventing digits.

    ``1234.0`` (openpyxl's rendering of an integer cell) becomes ``"1234"``,
    not ``"1234.0"``; empty-ish values become ``""``.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return ""
        if value.is_integer():
            return str(int(value))
        return repr(value)
    if isinstance(value, int):
        return str(value)
    text = str(value)
    return "" if text.strip().lower() in ("nan", "none", "nat") else text


@dataclass(frozen=True)
class NormalizeRule:
    trim: bool = True
    nfkc: bool = True
    upper: bool = False
    lower: bool = False
    remove_chars: str = ""
    zero_pad: int = 0
    segment_sep: str = ""
    pad_segments: tuple[int, ...] = ()
    prefix: str = ""
    suffix: str = ""

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> NormalizeRule:
        raw = raw or {}
        pad = raw.get("pad_segments") or ()
        if isinstance(pad, int):
            pad = (pad,)
        else:
            pad = tuple(int(x or 0) for x in pad)
        remove = raw.get("remove_chars") or ""
        if isinstance(remove, (list, tuple)):
            remove = "".join(str(c) for c in remove)
        return cls(
            trim=bool(raw.get("trim", True)),
            nfkc=bool(raw.get("nfkc", True)),
            upper=bool(raw.get("upper", False)),
            lower=bool(raw.get("lower", False)),
            remove_chars=str(remove),
            zero_pad=int(raw.get("zero_pad", 0) or 0),
            segment_sep=str(raw.get("segment_sep", "") or ""),
            pad_segments=pad,
            prefix=str(raw.get("prefix", "") or ""),
            suffix=str(raw.get("suffix", "") or ""),
        )

    def apply(self, value: Any) -> str:
        text = cell_to_text(value)
        if self.trim:
            text = text.strip(_TRIM_CHARS)
        if self.nfkc:
            text = unicodedata.normalize("NFKC", text)
        if self.remove_chars:
            text = text.translate({ord(c): None for c in self.remove_chars})
        if self.upper:
            text = text.upper()
        if self.lower:
            text = text.lower()
        if not text:
            return ""
        if self.segment_sep and self.pad_segments:
            parts = text.split(self.segment_sep)
            widths = list(self.pad_segments)
            if len(widths) == 1:
                widths = widths * len(parts)
            padded = []
            for i, part in enumerate(parts):
                width = widths[i] if i < len(widths) else 0
                padded.append(part.zfill(width) if width and part.isdigit() else part)
            text = self.segment_sep.join(padded)
        elif self.zero_pad and text.isdigit():
            text = text.zfill(self.zero_pad)
        return f"{self.prefix}{text}{self.suffix}"


def parse_number(value: Any) -> float | None:
    """Tolerant numeric parse: '1,234' / full-width digits / '12 個' -> number."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return None if math.isnan(value) else float(value)
    text = unicodedata.normalize("NFKC", cell_to_text(value)).strip(_TRIM_CHARS)
    if not text:
        return None
    text = text.replace(",", "").replace("_", "")
    kept = []
    for ch in text:
        if ch.isdigit() or ch in "+-.":
            kept.append(ch)
        elif kept:
            break
    try:
        return float("".join(kept))
    except ValueError:
        return None


class MasterIndex:
    """Normalised key set loaded from a master table (CSV or Excel)."""

    def __init__(self, keys: Iterable[str], path: Path, on_unknown: str) -> None:
        self.keys = frozenset(k for k in keys if k)
        self.path = path
        self.on_unknown = on_unknown

    def __contains__(self, key: str) -> bool:
        return key in self.keys

    def __len__(self) -> int:
        return len(self.keys)


def load_master(
    path: Path, key_column: str, rule: NormalizeRule | None, on_unknown: str
) -> MasterIndex:
    rows: list[dict[str, Any]] = []
    suffix = path.suffix.lower()
    if suffix in (".xlsx", ".xlsm", ".xls"):
        import pandas as pd

        frame = pd.read_excel(path, dtype=object)
        rows = frame.to_dict(orient="records")
    else:
        for encoding in ("utf-8-sig", "cp932"):
            try:
                with path.open("r", encoding=encoding, newline="") as fh:
                    rows = list(csv.DictReader(fh))
                break
            except UnicodeDecodeError:
                continue
    if rows and key_column not in rows[0]:
        raise KeyError(
            f"{path}: master key column {key_column!r} not found "
            f"(columns: {sorted(rows[0])})"
        )
    keys = []
    for row in rows:
        raw = row.get(key_column)
        keys.append(rule.apply(raw) if rule else cell_to_text(raw))
    return MasterIndex(keys, path, on_unknown)
