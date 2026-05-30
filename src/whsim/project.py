"""Project workspace = the simulator's source of truth.

The salesperson imports once, then iterates. So we persist the normalized model
(plus the raw bytes that were dropped, the provenance map, and every run's
artifacts) under projects/<id>/. The analysis tool is merely a supplier; this
workspace is what we keep, re-run and compare.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from whsim import templates
from whsim.importer import import_zip
from whsim.provenance import Provenance, Source
from whsim.schema.model import WarehouseModel

PROJECTS_DIR = Path("projects")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


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
        model = templates.load_template_model(template_id)
        model.meta.name = name
        model.meta.project_id = name

        root = base / name
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
        root = base / name
        if not (root / "project.json").is_file():
            raise FileNotFoundError(f"no project named {name!r} under {base}")
        return cls(root)

    # --- model / provenance ---------------------------------------------------
    def load_model(self) -> WarehouseModel:
        return WarehouseModel.model_validate_json(self.model_file.read_text("utf-8"))

    def save_model(self, model: WarehouseModel) -> None:
        self.model_file.write_text(
            model.model_dump_json(indent=2), encoding="utf-8"
        )

    def load_provenance(self) -> Provenance:
        return Provenance.from_dict(json.loads(self.provenance_file.read_text("utf-8")))

    def save_provenance(self, prov: Provenance) -> None:
        _write_json(self.provenance_file, prov.to_dict())

    def meta(self) -> dict:
        return json.loads(self.project_file.read_text("utf-8"))

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
    def new_run_dir(self) -> Path:
        self.runs_dir.mkdir(exist_ok=True)
        n = 1 + sum(1 for p in self.runs_dir.glob("run_*") if p.is_dir())
        d = self.runs_dir / f"run_{n:04d}"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def latest_run_dir(self) -> Path | None:
        runs = sorted(p for p in self.runs_dir.glob("run_*") if p.is_dir())
        return runs[-1] if runs else None
