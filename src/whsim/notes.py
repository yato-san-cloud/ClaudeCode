"""知見ボード — anchored comments that capture tacit field knowledge.

A lightweight, non-algorithmic moat: let users pin notes to the numbers/processes
they care about (生産性マスタ / 工程 / シナリオ / 設計 …) so the "why this number"
knowledge lives in the system and compounds. Persisted per project as notes.json.
Identity is a display name for now (no auth) — kept deliberately thin.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

_MAX_TEXT = 2000
_MAX_AUTHOR = 40


def _file(proj) -> Path:
    return proj.root / "notes.json"


def load_notes(proj) -> list[dict]:
    f = _file(proj)
    if not f.exists():
        return []
    try:
        data = json.loads(f.read_text("utf-8"))
        return data if isinstance(data, list) else []
    except (ValueError, OSError):
        return []


def _save(proj, notes: list[dict]) -> None:
    _file(proj).write_text(json.dumps(notes, ensure_ascii=False, indent=2), "utf-8")


def list_notes(proj, anchor: str | None = None) -> list[dict]:
    """Newest first; optionally filtered to one anchor."""
    notes = load_notes(proj)
    if anchor:
        notes = [n for n in notes if n.get("anchor") == anchor]
    return sorted(notes, key=lambda n: n.get("ts", ""), reverse=True)


def add_note(proj, anchor: str, author: str, text: str) -> dict:
    text = (text or "").strip()[:_MAX_TEXT]
    if not text:
        raise ValueError("本文が空です。")
    note = {
        "id": uuid.uuid4().hex[:12],
        "anchor": (anchor or "general").strip() or "general",
        "author": ((author or "").strip()[:_MAX_AUTHOR]) or "匿名",
        "text": text,
        "ts": time.strftime("%Y-%m-%d %H:%M"),
    }
    notes = load_notes(proj)
    notes.append(note)
    _save(proj, notes)
    return note


def delete_note(proj, note_id: str) -> bool:
    notes = load_notes(proj)
    kept = [n for n in notes if n.get("id") != note_id]
    if len(kept) == len(notes):
        return False
    _save(proj, kept)
    return True
