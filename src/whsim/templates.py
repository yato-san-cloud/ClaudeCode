"""Template loading.

A template is just a fully filled-in canonical model where every value is a
provisional default. Importing real data overwrites subtrees; everything else
stays provisional. (Corollary, not yet wired: a finished project can be saved
back out as a new template -- same data shape, zero extra code paths.)
"""

from __future__ import annotations

import json
from pathlib import Path

from whsim.schema.model import WarehouseModel

# templates/ lives at the repo root, next to src/.
TEMPLATES_DIR = Path(__file__).resolve().parents[2] / "templates"


def list_templates() -> list[dict]:
    out = []
    if not TEMPLATES_DIR.is_dir():
        return out
    for d in sorted(TEMPLATES_DIR.iterdir()):
        manifest = d / "manifest.json"
        if manifest.is_file():
            out.append(json.loads(manifest.read_text(encoding="utf-8")))
    return out


def template_dir(template_id: str) -> Path:
    d = TEMPLATES_DIR / template_id
    if not (d / "template.json").is_file():
        raise FileNotFoundError(f"unknown template: {template_id}")
    return d


def load_manifest(template_id: str) -> dict:
    return json.loads((template_dir(template_id) / "manifest.json").read_text("utf-8"))


def load_template_dict(template_id: str) -> dict:
    """Raw template JSON (a plain dict, ready to be merged over)."""
    return json.loads((template_dir(template_id) / "template.json").read_text("utf-8"))


def load_template_model(template_id: str) -> WarehouseModel:
    return WarehouseModel.model_validate(load_template_dict(template_id))
