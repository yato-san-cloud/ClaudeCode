"""Project workspace = the simulator's source of truth.

The salesperson imports once, then iterates. So we persist the normalized model
(plus the raw bytes that were dropped, the provenance map, and every run's
artifacts) under projects/<id>/. The analysis tool is merely a supplier; this
workspace is what we keep, re-run and compare.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from whsim import templates
from whsim.importer import import_zip
from whsim.provenance import Provenance, Source
from whsim.schema.model import WarehouseModel

PROJECTS_DIR = Path("projects")

# Project names become directory names, so they must be a single safe path
# segment: no separators, no parent refs, no leading dots / reserved chars.
_UNSAFE = re.compile(r"[^0-9A-Za-z_.\-぀-ヿ一-鿿]+")


def safe_name(name: str) -> str:
    """Reduce an arbitrary user-supplied name to one safe path segment.

    Collapses path separators and other unsafe characters to '_', strips
    parent-directory traversal and leading dots so a name can never escape the
    projects/ root. Raises ValueError only if nothing usable remains."""
    base = Path(str(name)).name  # drop any directory components first
    cleaned = _UNSAFE.sub("_", base).strip("._-")
    if not cleaned or cleaned in {".", ".."}:
        raise ValueError(f"invalid project name: {name!r}")
    return cleaned


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _atomic_write(path: Path, text: str) -> None:
    """Write text durably: temp file in the same dir, then atomic rename, so a
    crash mid-write never leaves a half-written (corrupt) file behind."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


def _write_json(path: Path, obj) -> None:
    _atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=2))


class Project:
    def __init__(self, root: Path):
        self.root = Path(root)

    # --- locations on disk ----------------------------------------------------
    @property
    def project_file(self) -> Path:
        return self.root / "project.json"

    @property
    def model_file(self) -> Path:
        return self.root / "model.json"

    @property
    def provenance_file(self) -> Path:
        return self.root / "provenance.json"

    @property
    def runs_dir(self) -> Path:
        return self.root / "runs"

    @property
    def raw_dir(self) -> Path:
        return self.root / "raw"

    # --- lifecycle ------------------------------------------------------------
    @classmethod
    def create(cls, name: str, template_id: str, base: Path = PROJECTS_DIR) -> "Project":
        slug = safe_name(name)
        model = templates.load_template_model(template_id)
        model.meta.name = name
        model.meta.project_id = slug

        root = base / slug
        root.mkdir(parents=True, exist_ok=True)
        (root / "imported").mkdir(exist_ok=True)
        (root / "raw").mkdir(exist_ok=True)
        (root / "runs").mkdir(exist_ok=True)

        proj = cls(root)
        _write_json(proj.project_file, {
            "name": name, "template_id": template_id,
            "created": _now(), "status": "new",
        })
        proj.save_model(model)
        # Fresh from a template: every subtree is a provisional default, except
        # the ones the manifest says are normally interview-confirmed are still
        # provisional until someone actually touches them.
        prov = Provenance(template_id)
        proj.save_provenance(prov)
        return proj

    @classmethod
    def open(cls, name: str, base: Path = PROJECTS_DIR) -> "Project":
        root = base / safe_name(name)
        if not (root / "project.json").is_file():
            raise FileNotFoundError(f"no project named {name!r} under {base}")
        return cls(root)

    # --- model / provenance ---------------------------------------------------
    def load_model(self) -> WarehouseModel:
        """Load the persisted model, recovering to defaults if the file is
        missing, empty or corrupt. The 'always runnable' guarantee means a
        truncated write (e.g. a crash on an older build) must never wedge a
        project -- we fall back to an empty (valid) model rather than raise."""
        try:
            text = self.model_file.read_text("utf-8")
        except (FileNotFoundError, OSError):
            return WarehouseModel()
        if not text.strip():
            return WarehouseModel()
        try:
            return WarehouseModel.model_validate_json(text)
        except Exception:  # noqa: BLE001 - corrupt JSON recovers to a valid model
            return WarehouseModel()

    def save_model(self, model: WarehouseModel) -> None:
        _atomic_write(self.model_file, model.model_dump_json(indent=2))

    def load_provenance(self) -> Provenance:
        try:
            text = self.provenance_file.read_text("utf-8")
            d = json.loads(text) if text.strip() else {}
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            d = {}
        if not isinstance(d, dict):
            d = {}
        return Provenance.from_dict(d)

    def save_provenance(self, prov: Provenance) -> None:
        _write_json(self.provenance_file, prov.to_dict())

    def meta(self) -> dict:
        try:
            text = self.project_file.read_text("utf-8")
            d = json.loads(text) if text.strip() else {}
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            d = {}
        if not isinstance(d, dict):
            d = {}
        # Defensive defaults so callers that index meta()["template_id"] etc.
        # never KeyError on a partially-written project.json.
        d.setdefault("name", self.root.name)
        d.setdefault("template_id", "ecommerce_small")
        return d

    # --- import ---------------------------------------------------------------
    def import_zip(self, zip_path: str | Path):
        """Drop a customer ZIP in; overwrite the subtrees it provides."""
        zip_path = Path(zip_path)
        template_dict = templates.load_template_dict(self.meta()["template_id"])
        # Preserve any interview edits already applied: merge over current model,
        # not the bare template, so a re-import does not wipe confirmed values.
        current = json.loads(self.model_file.read_text("utf-8"))
        merged_base = {**template_dict, **current}
        result = import_zip(merged_base, zip_path)

        # keep the raw bytes for audit / re-import
        shutil.copy2(zip_path, self.raw_dir / zip_path.name)

        model = result.model
        model.meta.name = self.meta()["name"]
        self.save_model(model)

        prov = self.load_provenance()
        for sub in result.touched_subtrees:
            prov.mark(sub, Source.IMPORTED)
        self.save_provenance(prov)
        return result

    # --- runs -----------------------------------------------------------------
    @staticmethod
    def _run_index(p: Path) -> int | None:
        m = re.fullmatch(r"run_(\d+)", p.name)
        return int(m.group(1)) if m else None

    def _run_dirs(self) -> list[tuple[int, Path]]:
        out = []
        for p in self.runs_dir.glob("run_*"):
            if p.is_dir():
                idx = self._run_index(p)
                if idx is not None:
                    out.append((idx, p))
        out.sort()
        return out

    def new_run_dir(self) -> Path:
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        existing = self._run_dirs()
        # Derive the next index from the highest existing one, so deleting an
        # intermediate run can never reuse / collide with a live directory.
        n = (existing[-1][0] + 1) if existing else 1
        d = self.runs_dir / f"run_{n:04d}"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def latest_run_dir(self) -> Path | None:
        runs = self._run_dirs()
        return runs[-1][1] if runs else None
