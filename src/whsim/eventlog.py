"""イベントログの書き出し (the raw event log as a shippable artifact).

The DES already derives every KPI from one place — ``World.events``, a flat list
of dicts (``kpis.py`` hard-codes no metric, it reads this log). What was missing
was the log itself: it lived only in memory, so a run's KPIs could never be
re-derived, audited or cross-checked outside the process that produced them. An
analyst who asks 「その稼働率の元データを見せて」 had nothing to open.

Two formats, one source:

* ``events.jsonl`` — one JSON object per line, VERBATIM (no projection, no
  renaming, no rounding). It is the log, not a view of it, so anything the KPI
  layer can compute from ``res.events`` can be recomputed from the file.
* ``events.csv``   — the same rows flattened for 日本語Excel: a UTF-8 **BOM**
  (without it Excel reads UTF-8 as CP932 and every Japanese field is mojibake),
  the five columns every event shares, and everything else preserved as one
  ``meta`` JSON column rather than an exploded 40-column sheet.

Both are pure functions of the event list; :func:`dump` is the only one that
touches disk, and it never raises — an artifact that fails to write must not
fail the simulation that produced it (never-blocks).
"""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path

# The columns every event carries (or plausibly carries). They lead the CSV in
# this order so the sheet opens on 「いつ・何が・どのオーダー・どの資源・誰が」;
# everything else (busy/wait/dist/cell/conveyor/...) survives in ``meta``.
CSV_COLUMNS: tuple[str, ...] = ("t", "event", "order_id", "resource", "worker")

# Excel on a Japanese Windows opens a BOM-less UTF-8 CSV as CP932.
BOM = "﻿"

EVENTS_JSONL = "events.jsonl"
EVENTS_CSV = "events.csv"


def to_jsonl(events) -> str:
    """The event log as JSON Lines — one event per line, in emission order.

    ``default=str`` is a belt-and-braces guard: every value the engine logs today
    is a JSON scalar, but a future event carrying (say) a tuple key must degrade
    to its repr rather than blow up the artifact write.
    """
    buf = io.StringIO()
    for e in events or ():
        buf.write(json.dumps(e, ensure_ascii=False, default=str))
        buf.write("\n")
    return buf.getvalue()


def to_csv(events) -> str:
    """The event log as a BOM'd CSV: the five shared columns plus a ``meta`` JSON.

    Flattening every distinct field into its own column would give a sheet with
    dozens of mostly-empty columns whose shape changes with the model (a run with
    conveyors has columns a run without them does not). One ``meta`` column keeps
    the sheet's shape stable and loses nothing — the JSONL is the machine-readable
    form, this is the one a person opens.
    """
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow([*CSV_COLUMNS, "meta"])
    for e in events or ():
        rest = {k: v for k, v in e.items() if k not in CSV_COLUMNS}
        row = [e.get(c, "") for c in CSV_COLUMNS]
        row.append(json.dumps(rest, ensure_ascii=False, default=str) if rest else "")
        w.writerow(["" if v is None else v for v in row])
    return BOM + buf.getvalue()


def dump(events, run_dir) -> Path | None:
    """Write ``events.jsonl`` into a run directory; return its path (or ``None``).

    Called from every save site that owns a run directory (the CLI's ``run`` and
    the web layer's run body), so a run artifact folder always carries the log its
    ``kpis.json`` was derived from. Swallows write failures on purpose: a run that
    simulated fine must not be reported as failed because a disk was full.
    """
    try:
        path = Path(run_dir) / EVENTS_JSONL
        path.write_text(to_jsonl(events), "utf-8")
        return path
    except Exception:      # noqa: BLE001 — an artifact write must never fail a run
        return None


def load(run_dir) -> list[dict]:
    """Read back an ``events.jsonl`` (``[]`` when absent or unreadable).

    The other half of the contract: an artifact nobody can read back is not an
    artifact. Malformed lines are skipped rather than fatal — a truncated tail
    (an interrupted write) still yields every event before it.
    """
    try:
        path = Path(run_dir) / EVENTS_JSONL
        text = path.read_text("utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    out: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out
