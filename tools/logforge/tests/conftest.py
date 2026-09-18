"""Shared fixtures. Everything the tests need is synthesised on the fly:
no real data, no network, no WHSiM import.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
import yaml

TOOL_DIR = Path(__file__).resolve().parent.parent
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))

EXAMPLE_MAPPING = TOOL_DIR / "mapping.example.yaml"


@pytest.fixture(scope="session")
def sample_set(tmp_path_factory) -> dict[str, Path]:
    """The clean synthetic sample (xlsx + csv + master + truth)."""
    from lfcore.synth import generate

    outdir = tmp_path_factory.mktemp("samples")
    return generate(outdir, rows=2000, seed=4242, dirty=False)


@pytest.fixture(scope="session")
def dirty_sample_set(tmp_path_factory) -> dict[str, Path]:
    from lfcore.synth import generate

    outdir = tmp_path_factory.mktemp("samples_dirty")
    return generate(outdir, rows=2000, seed=4242, dirty=True)


@pytest.fixture(scope="session")
def truth(sample_set) -> dict:
    return json.loads(sample_set["truth"].read_text(encoding="utf-8"))


def write_mapping(target_dir: Path, master: Path | None, **edits) -> Path:
    """Copy the shipped example mapping, repoint the master, apply edits.

    ``edits`` uses dotted paths, e.g. ``write_mapping(d, m, **{"orders.qty": "qty"})``.
    """
    data = yaml.safe_load(EXAMPLE_MAPPING.read_text(encoding="utf-8"))
    if master is None:
        data.pop("masters", None)
    else:
        data["masters"]["loc_id"]["file"] = str(master)
    for dotted, value in edits.items():
        node = data
        parts = dotted.split(".")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        if value is _DELETE:
            node.pop(parts[-1], None)
        else:
            node[parts[-1]] = value
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / "mapping.yaml"
    path.write_text(
        yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8"
    )
    return path


class _Delete:
    pass


_DELETE = _Delete()


@pytest.fixture
def mapping_factory(tmp_path):
    def make(master: Path | None, subdir: str = "m", **edits) -> Path:
        return write_mapping(tmp_path / subdir, master, **edits)

    return make


@pytest.fixture
def default_mapping(mapping_factory, sample_set) -> Path:
    return mapping_factory(sample_set["master"])


@pytest.fixture
def delete_marker() -> _Delete:
    return _DELETE
