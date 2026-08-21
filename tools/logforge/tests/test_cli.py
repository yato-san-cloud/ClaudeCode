"""The CLI as documented in the README (DoD 1) plus its exit codes."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent / "logforge.py"


def _run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(TOOL), *args], capture_output=True, text=True, check=False
    )


def test_documented_convert_command(sample_set, default_mapping, tmp_path):
    outdir = tmp_path / "out"
    completed = _run(
        "convert", str(sample_set["xlsx"]), "--mapping", str(default_mapping), "-o", str(outdir)
    )

    assert completed.returncode == 0, completed.stderr
    assert "契約スキーマ検証: OK" in completed.stdout
    assert "復元不能なtype" in completed.stdout
    for name in ("orders.json", "events.jsonl", "calibration.json", "meta.json",
                 "error_table.csv"):
        assert (outdir / name).exists()


def test_validate_subcommand(sample_set, default_mapping, tmp_path):
    outdir = tmp_path / "out"
    _run("convert", str(sample_set["xlsx"]), "--mapping", str(default_mapping),
         "-o", str(outdir), "--quiet")

    assert _run("validate", str(outdir)).returncode == 0

    events = outdir / "events.jsonl"
    events.write_text(
        json.dumps({"t": 1.0, "type": "teleport"}) + "\n", encoding="utf-8"
    )
    broken = _run("validate", str(outdir))
    assert broken.returncode == 3
    assert "NG" in broken.stdout


def test_missing_input_file_exits_nonzero(default_mapping, tmp_path):
    completed = _run(
        "convert", str(tmp_path / "nope.xlsx"), "--mapping", str(default_mapping),
        "-o", str(tmp_path / "out"),
    )
    assert completed.returncode == 1
    assert "エラー" in completed.stderr


def test_broken_mapping_exits_nonzero(sample_set, tmp_path):
    mapping = tmp_path / "broken.yaml"
    mapping.write_text("version: 1\ncolumns: {}\n", encoding="utf-8")
    completed = _run(
        "convert", str(sample_set["xlsx"]), "--mapping", str(mapping), "-o", str(tmp_path / "o")
    )
    assert completed.returncode == 1


def test_synth_subcommand_writes_a_full_sample(tmp_path):
    completed = _run("synth", "-o", str(tmp_path / "s"), "--rows", "60", "--seed", "1", "--dirty")

    assert completed.returncode == 0
    for name in ("wms_picklog.xlsx", "wms_picklog.csv", "loc_master.csv", "truth.json",
                 "wms_picklog_dirty.xlsx"):
        assert (tmp_path / "s" / name).exists()
    truth = json.loads((tmp_path / "s" / "truth.json").read_text(encoding="utf-8"))
    assert truth["pick_time_s"] == {"dist": "lognorm", "s": 0.4, "scale": 12.0}
