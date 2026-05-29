"""DuckDB-backed catalog for very large CSV / Parquet ingestion.

Large source files are scanned in-place by DuckDB (never fully loaded into
Python memory). Column mapping + type casting is expressed as a SQL view.
The analytical layer (``src.sql_analyses``) only ever materialises the small
aggregated result back into pandas for plotting.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import duckdb
import pandas as pd


_SUPPORTED = (".csv", ".csv.gz", ".tsv", ".parquet")


@dataclass
class Source:
    name: str               # logical key: 'shipments' | 'inbound' | 'inventory'
    raw_view: str           # raw SELECT * VIEW name
    mapped_view: str | None = None  # typed/renamed VIEW name (None until apply_mapping)
    description: str = ""   # human-readable origin (file path / "DataFrame N rows")


@dataclass
class Catalog:
    """Holds a DuckDB connection plus the views registered against it."""

    con: duckdb.DuckDBPyConnection = field(default_factory=lambda: duckdb.connect(":memory:"))
    sources: dict[str, Source] = field(default_factory=dict)

    # ── registration ────────────────────────────────────────────────────────
    def register_path(self, name: str, path: str | Path) -> Source:
        """Register a CSV / TSV / Parquet (path or glob) as ``raw_<name>``."""
        path_str = str(path)
        lower = path_str.lower()
        if lower.endswith(".parquet") or ("*" in path_str and ".parquet" in lower):
            scan = f"read_parquet({_quote(path_str)})"
        elif lower.endswith(".tsv") or lower.endswith(".tsv.gz"):
            scan = f"read_csv_auto({_quote(path_str)}, delim='\\t', ignore_errors=true, sample_size=10000)"
        elif lower.endswith(".csv") or lower.endswith(".csv.gz") or "*" in path_str:
            scan = f"read_csv_auto({_quote(path_str)}, ignore_errors=true, sample_size=10000)"
        else:
            raise ValueError(f"未対応のファイル形式です: {path_str}")
        raw = f"raw_{name}"
        self.con.execute(f"CREATE OR REPLACE VIEW {raw} AS SELECT * FROM {scan}")
        src = Source(name=name, raw_view=raw, description=path_str)
        self.sources[name] = src
        return src

    def register_dataframe(self, name: str, df: pd.DataFrame) -> Source:
        """Register an in-memory pandas DataFrame (used for Excel & sample data)."""
        raw = f"raw_{name}"
        self.con.register(f"{raw}_df", df)
        # Materialise into a stable view (so the DataFrame can be GC'd after).
        self.con.execute(f"CREATE OR REPLACE VIEW {raw} AS SELECT * FROM {raw}_df")
        src = Source(name=name, raw_view=raw, description=f"DataFrame ({len(df):,} 行)")
        self.sources[name] = src
        return src

    # ── inspection ──────────────────────────────────────────────────────────
    def columns(self, name: str) -> list[str]:
        rows = self.con.execute(f"DESCRIBE {self.sources[name].raw_view}").fetchall()
        return [r[0] for r in rows]

    def row_count(self, name: str) -> int:
        return int(self.con.execute(f"SELECT COUNT(*) FROM {self.sources[name].raw_view}").fetchone()[0])

    def head(self, name: str, n: int = 100) -> pd.DataFrame:
        return self.con.execute(f"SELECT * FROM {self.sources[name].raw_view} LIMIT {n}").df()

    # ── mapping / typed view ────────────────────────────────────────────────
    def apply_mapping(
        self,
        name: str,
        mapping: dict[str, str | None],
        date_cols: Iterable[str] = ("date", "timestamp"),
        numeric_cols: Iterable[str] = ("qty",),
    ) -> str:
        """Create ``v_<name>`` selecting only mapped columns, with type casts.

        Rows whose required logical fields (date / qty) are NULL are filtered out.
        """
        if name not in self.sources:
            raise KeyError(name)
        date_cols, numeric_cols = set(date_cols), set(numeric_cols)
        select_parts: list[str] = []
        for logical, src in mapping.items():
            if not src:
                continue
            quoted = _quote_ident(src)
            if logical in date_cols:
                select_parts.append(f"TRY_CAST({quoted} AS TIMESTAMP) AS {_quote_ident(logical)}")
            elif logical in numeric_cols:
                select_parts.append(f"TRY_CAST({quoted} AS DOUBLE) AS {_quote_ident(logical)}")
            else:
                select_parts.append(f"{quoted} AS {_quote_ident(logical)}")
        if not select_parts:
            raise ValueError("少なくとも 1 列のマッピングが必要です。")

        where_parts = [
            f"{_quote_ident(logical)} IS NOT NULL"
            for logical in ("date", "qty")
            if logical in mapping and mapping[logical]
        ]
        where_sql = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

        view = f"v_{name}"
        self.con.execute(
            f"CREATE OR REPLACE VIEW {view} AS "
            f"SELECT {', '.join(select_parts)} FROM {self.sources[name].raw_view}{where_sql}"
        )
        self.sources[name].mapped_view = view
        return view

    # ── querying ────────────────────────────────────────────────────────────
    def view(self, name: str) -> str | None:
        return self.sources[name].mapped_view if name in self.sources else None

    def has_column(self, name: str, column: str) -> bool:
        v = self.view(name)
        if v is None:
            return False
        return column in {r[0] for r in self.con.execute(f"DESCRIBE {v}").fetchall()}

    def view_row_count(self, name: str) -> int:
        v = self.view(name)
        if v is None:
            return 0
        return int(self.con.execute(f"SELECT COUNT(*) FROM {v}").fetchone()[0])

    def query(self, sql: str) -> pd.DataFrame:
        return self.con.execute(sql).df()

    def date_bounds(self, names: Iterable[str] = ("shipments", "inbound")) -> tuple[pd.Timestamp, pd.Timestamp] | None:
        """Return (min, max) of the ``date`` column across the given views."""
        views = [self.view(n) for n in names if self.view(n) and self.has_column(n, "date")]
        if not views:
            return None
        union = " UNION ALL ".join(f"SELECT date FROM {v}" for v in views)
        row = self.con.execute(f"SELECT MIN(date), MAX(date) FROM ({union}) WHERE date IS NOT NULL").fetchone()
        if row is None or row[0] is None:
            return None
        return pd.Timestamp(row[0]), pd.Timestamp(row[1])


def _quote(literal: str) -> str:
    return "'" + literal.replace("'", "''") + "'"


def _quote_ident(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


__all__ = ["Catalog", "Source"]
