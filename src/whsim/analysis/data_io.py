"""File loading and interactive column mapping for the 3PL analysis app."""
from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Iterable

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
    FieldSpec("qty", "出荷数量", ("出荷数", "バラ数", "数量", "qty", "quantity", "個数", "ピース")),
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

# 商品マスタ (item master): the source of 入数 (CS入数) + 商品名 + ABC, which the
# shipments file alone never carries — without it case_qty defaults to 1 and the
# whole 荷姿(ケース/パレット/オリコン)・保管設備 chain understates. All but sku are
# optional so a header-only master still loads ("never blocks").
ITEM_FIELDS: tuple[FieldSpec, ...] = (
    FieldSpec("sku", "SKU", ("sku", "品番", "商品コード", "コード", "jan")),
    FieldSpec("name", "商品名", ("商品名", "品名", "name", "名称"), required=False),
    FieldSpec("case_qty", "入数(CS入数)", ("入数", "cs入数", "ケース入数", "case", "ｹｰｽ入数", "balling"), required=False),
    FieldSpec("abc_class", "ABC区分", ("abc", "ランク", "区分"), required=False),
)


def _read_csv_resilient(buf: bytes, **kwargs) -> pd.DataFrame:
    for enc in ("utf-8-sig", "utf-8", "cp932"):
        try:
            return pd.read_csv(BytesIO(buf), encoding=enc, **kwargs)
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError("csv", b"", 0, 1, "Could not decode with utf-8/cp932")


def list_excel_sheets(buf: bytes) -> list[str]:
    # try the fast/modern engines first, then legacy .xls (BIFF) — callers only
    # have bytes, so we sniff by engine rather than by filename.
    for engine in ("calamine", "openpyxl", "xlrd"):
        try:
            return pd.ExcelFile(BytesIO(buf), engine=engine).sheet_names
        except Exception:  # noqa: BLE001 — try the next engine
            continue
    raise ValueError("Excelのシートを読み取れませんでした。")


# ---- real-world WMS export hardening ----------------------------------------
# Real exports (基幹システム/WMSの生帳票) routinely carry: title/meta rows above
# the header, newlines・全角スペース inside header cells, fully-empty padding
# rows/columns, and trailing 合計/小計 rows. All of that silently breaks the
# column auto-mapping (headers become "Unnamed: N") or inflates quantities, so
# load_table normalises tolerantly — same philosophy as the importers: best
# effort, never fatal.

_TOTAL_ROW_PAT = ("合計", "総計", "小計", "総合計", "total")


def _clean_header(v) -> str:
    """One header cell → a clean string ('' for NaN/None)."""
    if v is None or (isinstance(v, float) and v != v):
        return ""
    s = str(v).replace("　", " ").replace("\n", " ").replace("\r", " ")
    return " ".join(s.split()).strip()


def _header_suspicious(df: pd.DataFrame) -> bool:
    """True when the naive read clearly did NOT land on the header row."""
    if df.empty or len(df.columns) == 0:
        return True
    # a 1-column "table" is almost always a title line swallowing a ragged CSV
    # (タイトル行が1フィールドで、データ行は3フィールド…のような実帳票).
    if len(df.columns) == 1 and len(df) > 0:
        return True
    cols = [str(c) for c in df.columns]
    bad = sum(1 for c in cols
              if c.startswith("Unnamed") or c.strip() == "" or c == "nan")
    return bad >= max(1, int(len(cols) * 0.3))


def _read_csv_ragged(buf: bytes) -> pd.DataFrame | None:
    """Header-less raw scan of a possibly RAGGED csv (rows with differing field
    counts crash pandas' C parser). Uses the csv module directly, pads every
    row to the widest, decodes with the same encoding ladder. None on failure."""
    import csv as _csv
    from io import StringIO
    text = None
    for enc in ("utf-8-sig", "utf-8", "cp932"):
        try:
            text = buf.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        return None
    try:
        rows = [r for r in _csv.reader(StringIO(text))]
    except _csv.Error:
        return None
    rows = [r for r in rows if any(str(c).strip() for c in r)]
    if not rows:
        return None
    width = max(len(r) for r in rows)
    padded = [r + [None] * (width - len(r)) for r in rows]
    return pd.DataFrame(padded)


def _best_header_row(raw: pd.DataFrame, max_scan: int = 25) -> int | None:
    """Find the most header-looking row in a header-less frame.

    Scores each candidate by: cell fill ratio, text-ness (headers are labels,
    not numbers), uniqueness, and how data-filled the rows below are. Returns
    None when nothing scores like a header (caller keeps the naive read)."""
    best, best_score = None, 0.0
    n = min(max_scan, len(raw))
    for i in range(n):
        row = raw.iloc[i]
        labels = [_clean_header(v) for v in row]
        filled = [s for s in labels if s]
        if len(filled) < 2:
            continue
        fill = len(filled) / max(1, len(labels))
        texty = sum(1 for s in filled if not s.replace(".", "", 1).replace("-", "", 1).isdigit()) / len(filled)
        uniq = len(set(filled)) / len(filled)
        below = raw.iloc[i + 1: i + 6]
        below_fill = float(below.notna().mean().mean()) if len(below) else 0.0
        score = fill * 0.35 + texty * 0.3 + uniq * 0.2 + below_fill * 0.15
        if score > best_score:
            best, best_score = i, score
    return best if best_score >= 0.6 else None


def _normalise_table(df: pd.DataFrame) -> pd.DataFrame:
    """Clean headers, drop empty padding rows/cols and trailing 合計 rows."""
    # header cells: strip newlines / 全角スペース; de-duplicate blanks.
    seen: dict[str, int] = {}
    cols = []
    for c in df.columns:
        s = _clean_header(c) or "col"
        if s in seen:
            seen[s] += 1
            s = f"{s}.{seen[s]}"
        else:
            seen[s] = 0
        cols.append(s)
    df = df.copy()
    df.columns = cols
    df = df.dropna(axis=0, how="all").dropna(axis=1, how="all")
    # trailing summary rows: a leading-column cell that *is* 合計/小計 etc.
    if len(df) and len(df.columns):
        first = df.iloc[:, 0].astype(str).str.strip().str.lower()
        is_total = first.isin([t.lower() for t in _TOTAL_ROW_PAT])
        if is_total.any():
            df = df[~is_total]
    return df.reset_index(drop=True)


def _excel_engine(name: str) -> str:
    """Prefer the fast Rust 'calamine' engine when installed, else the per-format
    default (openpyxl for .xlsx / xlrd for legacy .xls)."""
    try:
        import python_calamine  # noqa: F401
        return "calamine"
    except Exception:  # noqa: BLE001 — not installed: fall back to the slow engines
        return "openpyxl" if name.endswith(".xlsx") else "xlrd"


def load_table(file_bytes: bytes, filename: str, sheet: str | None = None,
               nrows: int | None = None) -> pd.DataFrame:
    """Load a CSV or Excel file by filename extension, tolerant of real-world
    WMS exports (title rows above the header / 合計 rows / messy header cells).

    ``nrows`` caps how many DATA rows are read — pass it for a fast PREVIEW (e.g.
    the column-mapping dock only needs the header + a sample, not the whole month
    of data). For CSV this genuinely stops the read early; for Excel it bounds the
    parse/serialise work. None reads the whole file (the real import path)."""
    name = filename.lower()
    if name.endswith((".xlsx", ".xls")):
        # python-calamine (Rust) reads .xlsx/.xls ~10–40× faster than openpyxl on
        # month-scale WMS files; openpyxl/xlrd stay as the fallback if it is absent.
        engine = _excel_engine(name)
        # When previewing we read header + nrows; the header may sit a few rows
        # down (title/meta rows), so over-read a small buffer for detection.
        rd = ({} if nrows is None else {"nrows": nrows})
        rd_hdr = ({} if nrows is None else {"nrows": nrows + 20})
        try:
            df = pd.read_excel(BytesIO(file_bytes), sheet_name=sheet or 0, engine=engine, **rd)
        except ImportError as e:
            raise ValueError(
                "旧形式の .xls を読むには xlrd が必要です（pip install xlrd、"
                "または start.bat を再実行して依存を更新）。Excel で .xlsx として"
                "保存し直す方法でも取り込めます。") from e
        if _header_suspicious(df):
            raw = pd.read_excel(BytesIO(file_bytes), sheet_name=sheet or 0,
                                engine=engine, header=None, **rd_hdr)
            hdr = _best_header_row(raw)
            if hdr is not None:
                df = raw.iloc[hdr + 1:].reset_index(drop=True)
                df.columns = list(raw.iloc[hdr])
                if nrows is not None:
                    df = df.head(nrows)
        return _normalise_table(df)
    try:
        df = _read_csv_resilient(file_bytes, nrows=nrows)
    except Exception:  # noqa: BLE001 — ragged csv: fall through to the raw scan
        df = pd.DataFrame()
    if _header_suspicious(df):
        raw = _read_csv_ragged(file_bytes)
        if raw is not None:
            hdr = _best_header_row(raw)
            if hdr is not None:
                df = raw.iloc[hdr + 1:].reset_index(drop=True)
                df.columns = list(raw.iloc[hdr])
                if nrows is not None:
                    df = df.head(nrows)
    return _normalise_table(df)


def _fold(s) -> str:
    """Matching key for a header/hint: NFKC (半角カナ→全角, 全角英数→半角),
    lower-cased, whitespace stripped. Real WMS exports write 商品ｺｰﾄﾞ /
    出荷ﾊﾞﾗ数 in half-width katakana — without folding, the auto-mapping
    silently misses them."""
    import unicodedata
    return "".join(unicodedata.normalize("NFKC", str(s)).lower().split())


def guess_column(columns: Iterable[str], hints: Iterable[str], exclude: Iterable[str] = ()) -> str | None:
    cols = [c for c in columns if c not in set(exclude)]
    folded = {c: _fold(c) for c in cols}
    # Pass 1: exact match.
    for hint in hints:
        h = _fold(hint)
        for c in cols:
            if h == folded[c]:
                return c
    # Pass 2: substring match.
    for hint in hints:
        h = _fold(hint)
        for c in cols:
            if h in folded[c]:
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
    "ITEM_FIELDS",
    "list_excel_sheets",
    "load_table",
    "guess_column",
    "initial_mapping",
    "apply_mapping",
    "missing_required",
]
