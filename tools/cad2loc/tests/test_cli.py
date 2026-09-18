"""CLI behaviour: happy path writes both artifacts, bad input fails safely."""

from __future__ import annotations

import json

import ezdxf
import pytest
import synthetic
import yaml
from cad2loc.cli import main
from cad2loc.config import load_config
from cad2loc.errors import Cad2locError
from cad2loc.pipeline import convert
from cad2loc.validate import load_schema, validate
from helpers import TEST_CONFIG


def _mapping(tmp_path):
    path = tmp_path / "mapping.yaml"
    path.write_text(yaml.safe_dump(TEST_CONFIG, allow_unicode=True), encoding="utf-8")
    return path


def test_cli_end_to_end(tmp_path, capsys):
    truth = synthetic.simple_three_aisle(tmp_path / "in.dxf")
    out = tmp_path / "out" / "layout.geojson"
    code = main(
        [str(truth.path), "--config", str(_mapping(tmp_path)), "-o", str(out)]
    )
    assert code == 0
    layout = json.loads(out.read_text(encoding="utf-8"))
    assert validate(layout, load_schema()) == []
    report = json.loads((out.parent / "report.json").read_text(encoding="utf-8"))
    assert report["assertions"]["ok"] is True
    assert report["counts"]["rack"] == 4
    assert "rack=4" in capsys.readouterr().out


def test_cli_custom_report_path(tmp_path):
    truth = synthetic.simple_three_aisle(tmp_path / "in.dxf")
    out = tmp_path / "layout.geojson"
    report = tmp_path / "custom-report.json"
    code = main(
        [
            str(truth.path),
            "--config",
            str(_mapping(tmp_path)),
            "-o",
            str(out),
            "--report",
            str(report),
            "-q",
        ]
    )
    assert code == 0
    assert report.exists()


def test_cli_strict_writes_when_the_contract_holds(tmp_path):
    truth = synthetic.simple_three_aisle(tmp_path / "in.dxf")
    out = tmp_path / "layout.geojson"
    argv = [str(truth.path), "-c", str(_mapping(tmp_path)), "-o", str(out), "-q", "--strict"]
    assert main(argv) == 0
    assert out.exists()


def test_cli_runs_without_a_config(tmp_path):
    """Defaults must carry an unknown drawing (never blocks)."""
    truth = synthetic.simple_three_aisle(tmp_path / "in.dxf")
    out = tmp_path / "layout.geojson"
    assert main([str(truth.path), "-o", str(out), "-q"]) == 0
    layout = json.loads(out.read_text(encoding="utf-8"))
    racks = [f for f in layout["features"] if f["properties"]["kind"] == "rack"]
    assert len(racks) == 4  # units auto-detected as mm


def test_dwg_masquerading_as_dxf_is_rejected(tmp_path, capsys):
    path = synthetic.dwg_masquerading_as_dxf(tmp_path / "fake.dxf")
    assert main([str(path), "-o", str(tmp_path / "o.geojson")]) == 2
    err = capsys.readouterr().err
    assert "DWG" in err and "変換" in err
    with pytest.raises(Cad2locError):
        convert(path, load_config(None))


def test_empty_drawing_is_rejected(tmp_path, capsys):
    path = synthetic.empty_drawing(tmp_path / "empty.dxf")
    assert main([str(path), "-o", str(tmp_path / "o.geojson")]) == 2
    assert "空の図面" in capsys.readouterr().err


def test_garbage_file_is_rejected(tmp_path, capsys):
    path = synthetic.garbage_dxf(tmp_path / "garbage.dxf")
    assert main([str(path), "-o", str(tmp_path / "o.geojson")]) == 2
    assert "エラー" in capsys.readouterr().err


def test_missing_input_and_missing_config(tmp_path, capsys):
    assert main([str(tmp_path / "nope.dxf"), "-o", str(tmp_path / "o.geojson")]) == 2
    truth = synthetic.simple_three_aisle(tmp_path / "in.dxf")
    assert (
        main([str(truth.path), "--config", str(tmp_path / "nope.yaml"), "-o", str(tmp_path / "o")])
        == 2
    )


def test_recovers_a_damaged_dxf(tmp_path):
    """A truncated file still converts, via ezdxf.recover, and says so."""
    truth = synthetic.simple_three_aisle(tmp_path / "ok.dxf")
    text = truth.path.read_text(encoding="utf-8", errors="ignore")
    damaged = tmp_path / "damaged.dxf"
    damaged.write_text(text[: int(len(text) * 0.97)], encoding="utf-8")
    with pytest.raises(ezdxf.DXFStructureError):
        ezdxf.readfile(str(damaged))  # the plain reader gives up

    result = convert(damaged, load_config(None))
    assert result.report["dxf"]["recovered"] is True
    assert result.report["counts"]["rack"] == 4
    assert result.assertions.ok


def test_layer_mapping_is_configuration_not_code(tmp_path):
    """Rename the layers in the drawing; only mapping.yaml changes."""
    import ezdxf
    from cad2loc.config import DEFAULTS, Config, _deep_merge

    doc = ezdxf.new("R2010")
    for layer in ("A$SHELVING", "A$SHELL"):
        doc.layers.add(layer)
    msp = doc.modelspace()
    msp.add_lwpolyline(
        [(0, 0), (30000, 0), (30000, 20000), (0, 20000)],
        close=True,
        dxfattribs={"layer": "A$SHELL"},
    )
    for y in (4000, 10000, 16000):
        msp.add_lwpolyline(
            [(4000, y), (26000, y), (26000, y + 1200), (4000, y + 1200)],
            close=True,
            dxfattribs={"layer": "A$SHELVING"},
        )
    path = tmp_path / "custom.dxf"
    doc.saveas(path)

    cfg = Config(
        data=_deep_merge(
            DEFAULTS,
            {
                "units": {"scale_to_m": 0.001},
                "layers": {"rack": ["a$shelving"], "wall": ["a$shell"], "zone": [], "ignore": []},
            },
        )
    )
    result = convert(path, cfg)
    assert result.report["counts"]["rack"] == 3
    assert result.assertions.ok
