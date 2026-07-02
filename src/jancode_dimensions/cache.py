"""JAN→三辺サイズの検索結果を蓄積する SQLite キャッシュ。

外部APIは不安定でレート制限もあるため、一度引けた結果は再利用する。
``verified`` 列は人手で確認済みかどうかを表し、True の行は
オンライン取得結果より優先される(マスタ的に扱える)。
"""

from __future__ import annotations

import sqlite3
import time
from typing import Optional

from .models import Dimensions, ProductInfo

_SCHEMA = """
CREATE TABLE IF NOT EXISTS dimensions (
    jan         TEXT PRIMARY KEY,
    width_cm    REAL,
    depth_cm    REAL,
    height_cm   REAL,
    total_cm    REAL,
    source      TEXT,
    title       TEXT,
    raw_text    TEXT,
    found       INTEGER NOT NULL DEFAULT 0,
    verified    INTEGER NOT NULL DEFAULT 0,
    updated_at  REAL
);
"""


class Cache:
    def __init__(self, path: str = ":memory:") -> None:
        self.path = path
        self._conn = sqlite3.connect(path)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def get(self, jan: str) -> Optional[ProductInfo]:
        row = self._conn.execute(
            "SELECT * FROM dimensions WHERE jan = ?", (jan,)
        ).fetchone()
        if row is None:
            return None
        dims = None
        if row["found"] and row["width_cm"] is not None:
            dims = Dimensions(row["width_cm"], row["depth_cm"], row["height_cm"])
        return ProductInfo(
            jan=row["jan"],
            source=row["source"] or "cache",
            title=row["title"],
            dimensions=dims,
            raw_text=row["raw_text"],
        )

    def is_verified(self, jan: str) -> bool:
        row = self._conn.execute(
            "SELECT verified FROM dimensions WHERE jan = ?", (jan,)
        ).fetchone()
        return bool(row and row["verified"])

    def put(self, info: ProductInfo, verified: bool = False) -> None:
        dims = info.dimensions
        self._conn.execute(
            """
            INSERT INTO dimensions
                (jan, width_cm, depth_cm, height_cm, total_cm,
                 source, title, raw_text, found, verified, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(jan) DO UPDATE SET
                width_cm=excluded.width_cm,
                depth_cm=excluded.depth_cm,
                height_cm=excluded.height_cm,
                total_cm=excluded.total_cm,
                source=excluded.source,
                title=excluded.title,
                raw_text=excluded.raw_text,
                found=excluded.found,
                verified=MAX(dimensions.verified, excluded.verified),
                updated_at=excluded.updated_at
            """,
            (
                info.jan,
                dims.width_cm if dims else None,
                dims.depth_cm if dims else None,
                dims.height_cm if dims else None,
                dims.total_cm if dims else None,
                info.source,
                info.title,
                info.raw_text,
                1 if dims else 0,
                1 if verified else 0,
                time.time(),
            ),
        )
        self._conn.commit()
