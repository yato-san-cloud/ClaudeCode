"""Personal ("my") samples — a LOCAL-ONLY library of reusable project snapshots.

The motivation: a user re-imports the same real customer set (layout + WMS
data) every time they want to demo or sanity-check. They asked to register it as
a one-click sample. Real customer data must NOT be committed to the repo, so this
store lives in a gitignored ``samples/`` dir, sibling to ``projects/`` — it never
leaves the user's machine.

A sample is a frozen copy of a project workspace (model + provenance + the
persisted analysis tables + any imported raw), minus the heavy per-run artifacts.
Instantiating one copies it back out into a fresh project. Tolerant throughout:
a corrupt sample is skipped from the listing, never fatal.
"""

from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path

from whsim.project import Project, safe_name

_META = "sample.json"
# Subtrees not worth freezing into a sample (regenerated on run; can be large).
_SKIP = {"runs"}


def _projects_dir() -> Path:
    # Read PROJECTS_DIR at CALL time (not bound at import) so a monkeypatched test
    # workspace — and any future runtime override — is always honoured.
    from whsim.project import PROJECTS_DIR
    return PROJECTS_DIR


def samples_dir() -> Path:
    # Sibling of projects/ (also gitignored): the local-only sample library.
    return _projects_dir().parent / "samples"


def _meta_path(sid: str) -> Path:
    return samples_dir() / safe_name(sid) / _META


def _headline(snapshot: Path) -> dict:
    """Cheap stats for the listing card (shelves / orders / template). Best-effort."""
    out: dict = {}
    try:
        md = json.loads((snapshot / "model.json").read_text("utf-8"))
        layout = md.get("layout") or {}
        zones = layout.get("zones") or []
        shelves = sum(len(z.get("shelves") or []) for z in zones)
        out["shelves"] = shelves or len(layout.get("locations") or [])
        out["zones"] = len(zones)
        out["orders"] = len((md.get("orders") or {}).get("outbound") or [])
        out["template"] = (md.get("meta") or {}).get("template_id")
    except Exception:  # noqa: BLE001 — stats are decoration, never block
        pass
    return out


def save_sample(proj: Project, label: str) -> dict:
    """Freeze a project into a new personal sample. Returns its meta entry."""
    sid = uuid.uuid4().hex[:12]
    root = samples_dir() / sid
    snap = root / "snapshot"
    root.mkdir(parents=True, exist_ok=True)
    shutil.copytree(proj.root, snap,
                    ignore=shutil.ignore_patterns(*_SKIP))
    meta = {
        "id": sid,
        "label": (label or "").strip() or proj.root.name,
        "created": time.time(),
        "source_project": proj.root.name,
        "stats": _headline(snap),
    }
    (root / _META).write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
    return meta


def list_samples() -> list[dict]:
    """All personal samples, newest first. Corrupt entries are skipped."""
    d = samples_dir()
    if not d.is_dir():
        return []
    out = []
    for sub in d.iterdir():
        mp = sub / _META
        if not mp.is_file():
            continue
        try:
            out.append(json.loads(mp.read_text("utf-8")))
        except Exception:  # noqa: BLE001 — a corrupt sample must not break the list
            continue
    out.sort(key=lambda m: m.get("created", 0), reverse=True)
    return out


def instantiate(sid: str, name: str) -> Project:
    """Create a fresh project from a sample snapshot (copytree into projects/)."""
    snap = samples_dir() / safe_name(sid) / "snapshot"
    if not (snap / "project.json").is_file():
        raise FileNotFoundError(f"no sample {sid!r}")
    dst = _projects_dir() / safe_name(name)
    if dst.exists():
        raise FileExistsError(f"project {name!r} already exists")
    shutil.copytree(snap, dst)
    # Re-stamp the display name so listings/proposals match the new project.
    try:
        meta = json.loads((dst / "project.json").read_text("utf-8"))
        meta["name"] = name
        (dst / "project.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
    except Exception:  # noqa: BLE001 — metadata bookkeeping, never fatal
        pass
    return Project(dst)


def delete_sample(sid: str) -> bool:
    root = samples_dir() / safe_name(sid)
    if not (root / _META).is_file():
        return False
    shutil.rmtree(root, ignore_errors=True)
    return True
