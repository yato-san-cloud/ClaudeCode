"""DoD 5: same input + same mapping => byte-identical output.

meta.json's ``created_at`` is the single exception the contract forces (§5); it
can be pinned with --created-at, and then every byte of every file matches.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from lfcore.convert import convert_to_dir

TOOL = Path(__file__).resolve().parent.parent / "logforge.py"
OUTPUT_FILES = ("orders.json", "events.jsonl", "calibration.json", "error_table.csv")


def _bytes(directory: Path) -> dict[str, bytes]:
    return {name: (directory / name).read_bytes() for name in OUTPUT_FILES}


def test_two_runs_are_byte_identical(dirty_sample_set, mapping_factory, tmp_path):
    mapping = mapping_factory(dirty_sample_set["master"])
    convert_to_dir(dirty_sample_set["xlsx"], mapping, tmp_path / "a")
    convert_to_dir(dirty_sample_set["xlsx"], mapping, tmp_path / "b")

    assert _bytes(tmp_path / "a") == _bytes(tmp_path / "b")


def test_meta_differs_only_in_created_at(sample_set, default_mapping, tmp_path):
    convert_to_dir(sample_set["xlsx"], default_mapping, tmp_path / "a")
    convert_to_dir(sample_set["xlsx"], default_mapping, tmp_path / "b")

    first = json.loads((tmp_path / "a" / "meta.json").read_text(encoding="utf-8"))
    second = json.loads((tmp_path / "b" / "meta.json").read_text(encoding="utf-8"))
    first.pop("created_at")
    second.pop("created_at")
    assert first == second


def test_pinned_created_at_makes_every_file_byte_identical(sample_set, default_mapping, tmp_path):
    stamp = "2025-07-02T00:00:00+00:00"
    convert_to_dir(sample_set["xlsx"], default_mapping, tmp_path / "a", created_at=stamp)
    convert_to_dir(sample_set["xlsx"], default_mapping, tmp_path / "b", created_at=stamp)

    for name in OUTPUT_FILES + ("meta.json",):
        assert (tmp_path / "a" / name).read_bytes() == (tmp_path / "b" / name).read_bytes()


def test_only_meta_carries_a_conversion_timestamp(sample_set, default_mapping, tmp_path):
    """A stray "now" anywhere else would silently break determinism."""
    convert_to_dir(sample_set["xlsx"], default_mapping, tmp_path / "out")
    created_at = json.loads(
        (tmp_path / "out" / "meta.json").read_text(encoding="utf-8")
    )["created_at"]

    for name in OUTPUT_FILES:
        text = (tmp_path / "out" / name).read_text(encoding="utf-8-sig")
        assert created_at not in text

    calibration = json.loads((tmp_path / "out" / "calibration.json").read_text(encoding="utf-8"))
    # contract §8 wants fitted_at; log-forge fills it with the end of the DATA
    # window (a property of the input) instead of the clock on the wall.
    assert calibration["fitted_at"].startswith("2025-07-01")


def test_cli_run_is_reproducible(sample_set, default_mapping, tmp_path):
    """The documented command line, twice, compared byte for byte."""
    stamp = "2025-07-02T00:00:00+00:00"
    for name in ("cli_a", "cli_b"):
        completed = subprocess.run(  # noqa: PLW1510 — rc は下で明示検証
            [
                sys.executable, str(TOOL), "convert", str(sample_set["xlsx"]),
                "--mapping", str(default_mapping), "-o", str(tmp_path / name),
                "--created-at", stamp, "--quiet",
            ],
            capture_output=True,
            text=True,
        )
        assert completed.returncode == 0, completed.stderr

    for name in OUTPUT_FILES + ("meta.json",):
        assert (tmp_path / "cli_a" / name).read_bytes() == (tmp_path / "cli_b" / name).read_bytes()


def test_synth_generator_is_reproducible(tmp_path):
    from lfcore.synth import generate

    first = generate(tmp_path / "one", rows=120, seed=99)
    second = generate(tmp_path / "two", rows=120, seed=99)
    assert first["csv"].read_bytes() == second["csv"].read_bytes()
    assert first["master"].read_bytes() == second["master"].read_bytes()
    assert first["truth"].read_bytes() == second["truth"].read_bytes()
