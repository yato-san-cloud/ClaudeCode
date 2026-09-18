"""The mapping is the only place a format lives: it must absorb differences and
refuse to be wrong quietly."""

from __future__ import annotations

import pytest
import yaml
from conftest import EXAMPLE_MAPPING

from lfcore.convert import convert
from lfcore.mapping import MappingError, load_mapping
from lfcore.tables import InputError, read_table


def _mapping(tmp_path, data: dict, name: str = "m.yaml"):
    path = tmp_path / name
    path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return path


def _base(master=None) -> dict:
    data = yaml.safe_load(EXAMPLE_MAPPING.read_text(encoding="utf-8"))
    if master is None:
        data.pop("masters", None)
    else:
        data["masters"]["loc_id"]["file"] = str(master)
    return data


def test_example_mapping_loads(sample_set):
    m = load_mapping(EXAMPLE_MAPPING)
    assert m.source == "synthetic_sample_v1"
    assert [spec.type for spec in m.emit] == ["task_assign", "pick_start", "pick_end"]
    assert [s.name for s in m.series] == ["pick_time_s"]
    assert m.time_fields() == ["assigned_at", "pick_start_at", "pick_end_at"]


def test_typo_in_a_mapping_key_is_fatal(tmp_path):
    data = _base()
    data["normalise"] = {"loc_id": {"zero_pad": 6}}  # British spelling: not a key
    with pytest.raises(MappingError, match="unknown key"):
        load_mapping(_mapping(tmp_path, data))

    data = _base()
    data["normalize"]["loc_id"]["zeropad"] = 6
    with pytest.raises(MappingError, match="unknown key"):
        load_mapping(_mapping(tmp_path, data, "m2.yaml"))


def test_reference_to_an_undeclared_column_is_fatal(tmp_path):
    data = _base()
    data["orders"]["ready_t"] = "not_declared"
    with pytest.raises(MappingError, match="not declared under columns"):
        load_mapping(_mapping(tmp_path, data))


def test_event_type_outside_the_core_set_must_be_prefixed(tmp_path):
    data = _base()
    data["events"]["emit"].append({"type": "scanned", "time": "assigned_at"})
    with pytest.raises(MappingError, match="core type"):
        load_mapping(_mapping(tmp_path, data))

    data["events"]["emit"][-1] = {"type": "x_scanned", "time": "assigned_at"}
    assert load_mapping(_mapping(tmp_path, data, "ok.yaml")).emit[-1].type == "x_scanned"


def test_series_name_must_carry_its_unit(tmp_path):
    data = _base()
    data["calibration"]["series"]["pick_time"] = data["calibration"]["series"].pop("pick_time_s")
    with pytest.raises(MappingError, match="must end with"):
        load_mapping(_mapping(tmp_path, data))


def test_unknown_master_policy_is_rejected(tmp_path, sample_set):
    data = _base(sample_set["master"])
    data["masters"]["loc_id"]["on_unknown"] = "ignore"
    with pytest.raises(MappingError, match="error_table"):
        load_mapping(_mapping(tmp_path, data))


def test_csv_and_xlsx_of_the_same_data_convert_the_same(sample_set, default_mapping):
    from_xlsx = convert(sample_set["xlsx"], default_mapping)
    from_csv = convert(sample_set["csv"], default_mapping)

    assert [o["order_id"] for o in from_xlsx.orders] == [o["order_id"] for o in from_csv.orders]
    assert [o["loc_id"] for o in from_xlsx.orders] == [o["loc_id"] for o in from_csv.orders]
    assert [o["qty"] for o in from_xlsx.orders] == [o["qty"] for o in from_csv.orders]
    assert from_xlsx.meta["counts"]["events"] == from_csv.meta["counts"]["events"]
    assert from_csv.calibration["pick_time_s"]["dist"] == "lognorm"


def test_column_aliases_and_halfwidth_kana_headers_are_matched(sample_set):
    """The sample header says 商品ｺｰﾄﾞ / 出荷ﾊﾞﾗ数; the mapping says 商品コード / 出荷バラ数."""
    m = load_mapping(EXAMPLE_MAPPING)
    table = read_table(sample_set["xlsx"], m)

    assert table.column_of["sku"] == "商品ｺｰﾄﾞ"
    assert table.column_of["qty"] == "出荷ﾊﾞﾗ数"
    assert table.missing_fields == []


def test_header_row_is_found_below_the_title_lines(sample_set):
    m = load_mapping(EXAMPLE_MAPPING)
    table = read_table(sample_set["xlsx"], m)
    assert table.header_row_number == 3  # two title lines above it


def test_header_row_can_be_pinned_and_a_wrong_pin_is_visible(sample_set, tmp_path):
    data = _base(sample_set["master"])
    data["input"]["header_row"] = 2  # 0-based -> the real header
    m = load_mapping(_mapping(tmp_path, data))
    assert read_table(sample_set["xlsx"], m).missing_fields == []

    data["input"]["header_row"] = 0  # the title line
    m = load_mapping(_mapping(tmp_path, data, "wrong.yaml"))
    assert len(read_table(sample_set["xlsx"], m).missing_fields) == len(m.columns)


def test_unknown_sheet_name_is_a_clear_error(sample_set, tmp_path):
    data = _base(sample_set["master"])
    data["input"]["sheet"] = "存在しないシート"
    m = load_mapping(_mapping(tmp_path, data))
    with pytest.raises(InputError):
        read_table(sample_set["xlsx"], m)


def test_loc_as_node_is_opt_in(sample_set, mapping_factory):
    """from/to are node ids; log-forge only writes them when told the ids match."""
    default = convert(sample_set["xlsx"], mapping_factory(sample_set["master"]))
    assert all("to" not in event for event in default.events)
    assert default.events[0]["meta"]["loc_id"]

    as_node = convert(
        sample_set["xlsx"],
        mapping_factory(sample_set["master"], subdir="node", **{"events.loc_as_node": True}),
    )
    assert all("to" in event for event in as_node.events)


def test_fixed_t0_shifts_every_timestamp(sample_set, mapping_factory):
    auto = convert(sample_set["xlsx"], mapping_factory(sample_set["master"]))
    fixed = convert(
        sample_set["xlsx"],
        mapping_factory(
            sample_set["master"], subdir="t0",
            **{"time.t0": "fixed", "time.t0_fixed": "2025-07-01 00:00:00"},
        ),
    )

    assert auto.meta["t0"] != fixed.meta["t0"]
    assert fixed.meta["t0"] == "2025-07-01 00:00:00"
    shift = fixed.events[0]["t"] - auto.events[0]["t"]
    assert shift > 0
    assert all(
        round(f["t"] - a["t"], 3) == round(shift, 3)
        for a, f in zip(auto.events[:200], fixed.events[:200])
    )


def test_duration_column_instead_of_a_timestamp_pair(sample_set, tmp_path, mapping_factory):
    """Some WMS export a worked-minutes column; the mapping absorbs that too."""
    import csv

    source = sample_set["csv"]
    rows = list(csv.reader(source.open(encoding="utf-8-sig")))
    header_index = 2
    rows[header_index].append("作業分")
    minutes = []
    for index, row in enumerate(rows[header_index + 1:]):
        value = round(0.15 + (index % 11) * 0.01, 4)  # 9.0 .. 15.0 seconds
        minutes.append(value)
        row.append(str(value))
    target = tmp_path / "with_duration.csv"
    with target.open("w", encoding="utf-8-sig", newline="") as fh:
        csv.writer(fh, lineterminator="\n").writerows(rows)
    expected_mean_s = sum(minutes) / len(minutes) * 60.0

    mapping = mapping_factory(
        sample_set["master"], subdir="dur",
        **{
            "columns.work_min": ["作業分"],
            "calibration.series.pick_time_s": {
                "column": "work_min", "unit": "min", "candidates": ["lognorm", "gamma", "expon"],
                "min_s": 0.0, "max_s": 3600,
            },
        },
    )
    result = convert(target, mapping)
    series = result.calibration["pick_time_s"]
    assert series["n"] == len(minutes)
    assert series["sample"]["mean"] == pytest.approx(expected_mean_s, rel=1e-6)
