"""名前付きシナリオの保存・比較 — 採点表レール Stage2 の永続層.

A *scenario* is a named frozen snapshot of the project's design (the model's
editable subtrees) plus its scorecard at save time. The rail's compare dropdown
lists them so a salesperson can park "現行" and "AGV導入案" side by side and read
the dependent-variable delta — the thinking-in-variants that turns whsim from a
wizard into a modelling environment.

Storage: ``projects/<name>/scenarios/<id>.json`` (gitignored runtime data, same
home as runs/). Pure-ish I/O over the existing Project store; every function is
tolerant (a corrupt/missing scenario is skipped, never fatal — "never blocks").
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

# Model subtrees a scenario freezes (the design the user edits). Mirrors the
# designer's save payload + the live-scorecard overlay keys.
_SECTIONS = ("layout", "resources", "process", "routes", "settings", "orders", "items")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _slug(label: str) -> str:
    base = re.sub(r"[^0-9A-Za-z぀-ヿ一-鿿]+", "-", (label or "").strip()).strip("-")
    return (base or "scenario")[:40]


def _dir(proj):
    d = proj.root / "scenarios"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read(path):
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:  # noqa: BLE001 — a corrupt scenario is skipped, never fatal
        return None


def list_scenarios(proj) -> list[dict]:
    """Saved scenarios as lightweight headers (id/label/saved_at/scorecard rows),
    newest first. Never raises — unreadable files are skipped."""
    out: list[dict] = []
    d = proj.root / "scenarios"
    if not d.is_dir():
        return out
    for f in d.glob("*.json"):
        doc = _read(f)
        if not doc or not doc.get("id"):
            continue
        out.append({
            "id": doc["id"], "label": doc.get("label", doc["id"]),
            "saved_at": doc.get("saved_at"),
            "scorecard": doc.get("scorecard"),
        })
    out.sort(key=lambda s: s.get("saved_at") or "", reverse=True)
    return out


def save_scenario(proj, label: str, sections: dict | None = None) -> dict:
    """Freeze the project's design as a named scenario + its scorecard.

    ``sections`` (optional) = the designer's UNSAVED edit sections; when given we
    snapshot THOSE (so "現在の編集案を保存" works without persisting to the live
    model), else we snapshot the saved model. Returns the scenario header.
    """
    from whsim import scorecard
    from whsim.schema.model import WarehouseModel

    md = proj.load_model().model_dump()
    for key in _SECTIONS:
        val = (sections or {}).get(key)
        if val is not None:
            md[key] = val
    try:
        model = WarehouseModel.model_validate(md)
    except Exception:  # noqa: BLE001 — bad overlay → freeze the saved model
        model = proj.load_model()
        md = model.model_dump()

    # run metrics (for the run block) come from the latest DES run if present.
    run_metrics = None
    rd = proj.latest_run_dir()
    if rd is not None and (rd / "kpis.json").is_file():
        run_metrics = _read(rd / "kpis.json")
    card = scorecard.build_scorecard(model, run_metrics)

    sid = _slug(label)
    d = _dir(proj)
    # de-dup id if a different label already took the slug
    if (d / f"{sid}.json").is_file():
        existing = _read(d / f"{sid}.json") or {}
        if existing.get("label") != label:
            n = 2
            while (d / f"{sid}-{n}.json").is_file():
                n += 1
            sid = f"{sid}-{n}"
    doc = {
        "id": sid, "label": label or sid, "saved_at": _now(),
        "sections": {k: md.get(k) for k in _SECTIONS if k in md},
        "scorecard": card,
    }
    from whsim.project import _write_json
    _write_json(d / f"{sid}.json", doc)
    return {"id": sid, "label": doc["label"], "saved_at": doc["saved_at"],
            "scorecard": card}


def get_scenario(proj, sid: str) -> dict | None:
    doc = _read(_dir(proj) / f"{_slug(sid) if sid != _slug(sid) else sid}.json")
    if doc is None:
        # fall back to an exact filename match (slug may already be the id)
        doc = _read(proj.root / "scenarios" / f"{sid}.json")
    return doc


def delete_scenario(proj, sid: str) -> bool:
    f = proj.root / "scenarios" / f"{sid}.json"
    if f.is_file():
        try:
            f.unlink()
            return True
        except OSError:
            return False
    return False
