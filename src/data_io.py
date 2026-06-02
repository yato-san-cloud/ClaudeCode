"""File loading and interactive column mapping for the 3PL analysis app."""
from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import IO, Iterable

import pandas as pd


@dataclass(frozen=True)
class FieldSpec:
    """A logical field that an analysis needs and the substrings used to auto-detect it."""

    key: str
    label: str
    hints: tuple[str, ...]
    required: bool = True


SHIPMENT_FIELDS: tuple[FieldSpec, ...] = (
    FieldSpec("date", "出荷日", ("出荷日", "date", "ship", "日付")),
    FieldSpec("sku", "SKU", ("sku", "品番", "商品コード", "コード")),
    FieldSpec("qty", "出荷数量", ("出荷数", "数量", "qty", "quantity", "個数", "ピース")),
    FieldSpec("timestamp", "出荷日時", ("日時", "datetime", "timestamp", "時刻"), required=False),
    FieldSpec("partner", "取引先", ("取引先", "顧客", "得意先", "customer", "partner"), required=False),
    FieldSpec("order_id", "受注番号 (PS)", ("受注", "オーダー", "伝票", "order", "ピッキング", "ps"), required=False),
)

INBOUND_FIELDS: tuple[FieldSpec, ...] = (
    FieldSpec("date", "入荷日", ("入荷日", "date", "受入", "日付")),
    FieldSpec("sku", "SKU", ("sku", "品番", "商品コード", "コード")),
    FieldSpec("qty", "入荷数量", ("入荷数", "数量", "qty", "quantity")),
    FieldSpec("partner", "仕入先", ("仕入", "supplier", "ベンダ"), required=False),
)

INVENTORY_FIELDS: tuple[FieldSpec, ...] = (
    FieldSpec("sku", "SKU", ("sku", "品番", "商品コード", "コード")),
    FieldSpec("qty", "在庫数量", ("在庫数", "在庫", "stock", "qty", "数量")),
    FieldSpec("date", "基準日", ("基準日", "snapshot", "date", "日付"), required=False),
    FieldSpec("location", "ロケーション", ("ロケ", "location", "棚"), required=False),
)


def _read_csv_resilient(buf: bytes, **kwargs) -> pd.DataFrame:
    for enc in ("utf-8-sig", "utf-8", "cp932"):
        try:
            return pd.read_csv(BytesIO(buf), encoding=enc, **kwargs)
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError("csv", b"", 0, 1, "Could not decode with utf-8/cp932")


def list_excel_sheets(buf: bytes) -> list[str]:
    return pd.ExcelFile(BytesIO(buf), engine="openpyxl").sheet_names


def load_table(file_bytes: bytes, filename: str, sheet: str | None = None) -> pd.DataFrame:
    """Load a CSV or Excel file by filename extension."""
    name = filename.lower()
    if name.endswith((".xlsx", ".xls")):
        engine = "openpyxl" if name.endswith(".xlsx") else "xlrd"
        return pd.read_excel(BytesIO(file_bytes), sheet_name=sheet or 0, engine=engine)
    return _read_csv_resilient(file_bytes)


def guess_column(columns: Iterable[str], hints: Iterable[str], exclude: Iterable[str] = ()) -> str | None:
    cols = [c for c in columns if c not in set(exclude)]
    lower = {c: str(c).lower() for c in cols}
    # Pass 1: exact match.
    for hint in hints:
        h = hint.lower()
        for c in cols:
            if h == lower[c]:
                return c
    # Pass 2: substring match.
    for hint in hints:
        h = hint.lower()
        for c in cols:
            if h in lower[c]:
                return c
    return None


def initial_mapping(df: pd.DataFrame, fields: Iterable[FieldSpec]) -> dict[str, str | None]:
    """Auto-guess column mapping. A column is never assigned to more than one field."""
    used: set[str] = set()
    out: dict[str, str | None] = {}
    for f in fields:
        guess = guess_column(df.columns, f.hints, exclude=used)
        out[f.key] = guess
        if guess is not None:
            used.add(guess)
    return out


def apply_mapping(df: pd.DataFrame, mapping: dict[str, str | None], fields: Iterable[FieldSpec]) -> pd.DataFrame:
    """Rename mapped columns to the logical key and coerce types."""
    fields_by_key = {f.key: f for f in fields}
    rename: dict[str, str] = {}
    for key, src in mapping.items():
        if src is None:
            continue
        if fields_by_key[key].required or src in df.columns:
            rename[src] = key
    out = df.rename(columns=rename).copy()

    for col in ("date", "timestamp"):
        if col in out.columns:
            out[col] = pd.to_datetime(out[col], errors="coerce")
    if "qty" in out.columns:
        out["qty"] = pd.to_numeric(out["qty"], errors="coerce")

    keep = [k for k in mapping if k in out.columns]
    out = out.dropna(subset=[k for k in ("date", "qty") if k in keep])
    return out[keep]


def missing_required(mapping: dict[str, str | None], fields: Iterable[FieldSpec]) -> list[str]:
    return [f.label for f in fields if f.required and not mapping.get(f.key)]


__all__ = [
    "FieldSpec",
    "SHIPMENT_FIELDS",
    "INBOUND_FIELDS",
    "INVENTORY_FIELDS",
    "list_excel_sheets",
    "load_table",
    "guess_column",
    "initial_mapping",
    "apply_mapping",
    "missing_required",
]
