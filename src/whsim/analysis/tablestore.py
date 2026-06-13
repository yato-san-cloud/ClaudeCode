"""Persist the column-mapped import tables inside the project workspace.

The ETL endpoints (``/import/shipments``, ``/import-table``) map a messy
WMS file onto the standard field keys and then build model subtrees — but the
tidy *table* itself used to be thrown away, so ②分析「物量サマリ」 could not
re-analyse the project's own data without a re-upload (the user-facing symptom:
an import lives in ①取込 yet the analysis tab asked for the file again).

This module is that missing storage: each successful import drops its mapped
frame under ``projects/<name>/analysis/<key>.csv`` plus a ``tables_meta.json``
sidecar (filename / row count / resolved column mapping / cleansing summary) so
the analysis bundle can be rebuilt — and its 紐付け確認 panel re-shown — at any
time. Tolerant by design: a failed save never fails the import, a missing or
corrupt file simply reads back as ``None``.
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover — typing only, avoids a hard pandas import
    import pandas as pd

    from whsim.project import Project

# Stored table keys (one CSV each). "inventory" is what the import UI calls
# 在庫 (kind=master maps to INVENTORY_FIELDS).
TABLE_KEYS = ("shipments", "inbound", "inventory")

_META_NAME = "tables_meta.json"


def _dir(proj: "Project"):
    d = proj.root / "analysis"
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_table(proj: "Project", key: str, df: "pd.DataFrame",
               meta: dict | None = None) -> bool:
    """Persist a mapped table (and merge its meta). Never raises."""
    if key not in TABLE_KEYS or df is None:
        return False
    try:
        df.to_csv(_dir(proj) / f"{key}.csv", index=False, encoding="utf-8-sig")
        merge_meta(proj, key, {"rows": int(len(df)), "saved_at": time.time(),
                               **(meta or {})})
        return True
    except Exception:  # noqa: BLE001 — persistence is best-effort, import must not fail
        return False


def load_saved_table(proj: "Project", key: str):
    """Read a previously saved table back, or None (missing/corrupt/empty).

    CSV round-trips lose dtypes, and the analysis suite (``report.run_all``)
    expects datetime date/timestamp and numeric qty — re-coerce here so a
    reloaded table is indistinguishable from a freshly mapped upload."""
    import pandas as pd
    p = proj.root / "analysis" / f"{key}.csv"
    if not p.exists():
        return None
    try:
        df = pd.read_csv(p, encoding="utf-8-sig")
        if df.empty:
            return None
        for col in ("date", "timestamp"):
            if col in df.columns:
                df[col] = pd.to_datetime(df[col], errors="coerce")
        if "qty" in df.columns:
            df["qty"] = pd.to_numeric(df["qty"], errors="coerce")
        return df
    except Exception:  # noqa: BLE001 — a corrupt cache must never block analysis
        return None


def merge_meta(proj: "Project", key: str, meta: dict) -> None:
    """Merge one table's meta entry into the sidecar. Never raises."""
    try:
        p = _dir(proj) / _META_NAME
        cur = {}
        if p.exists():
            try:
                cur = json.loads(p.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001 — corrupt sidecar: start over
                cur = {}
        cur[key] = {**cur.get(key, {}), **meta}
        p.write_text(json.dumps(cur, ensure_ascii=False, indent=1), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def load_meta(proj: "Project") -> dict:
    """The whole meta sidecar ({} when absent/corrupt)."""
    p = proj.root / "analysis" / _META_NAME
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
