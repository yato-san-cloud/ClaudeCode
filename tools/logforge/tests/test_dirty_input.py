"""DoD 2/3: broken rows are isolated in error_table.csv and the run continues."""

from __future__ import annotations

import csv
import json

from lfcore import validate as V
from lfcore.convert import convert, convert_to_dir


def _reasons(result) -> set[str]:
    return {error.reason for error in result.errors}


def test_every_defect_class_lands_in_the_error_table(dirty_sample_set, mapping_factory):
    mapping = mapping_factory(dirty_sample_set["master"])
    result = convert(dirty_sample_set["xlsx"], mapping)

    assert _reasons(result) == {
        "required_value_empty",      # 伝票番号 empty
        "qty_not_numeric",           # 数量 = "－"
        "unparseable_timestamp",     # "2025/13/32 99:99"
        "unknown_code",              # location missing from the master
        "negative_duration",         # end before start
    }
    quarantined = [e for e in result.errors if e.action == "row_quarantined"]
    assert len(quarantined) == 3, "empty id / bad qty / unknown code are isolated"
    assert result.orders, "the other 1997 rows still convert"
    assert len(result.orders) == result.meta["counts"]["rows_read"] - 3


def test_run_continues_and_output_still_validates(dirty_sample_set, mapping_factory, tmp_path):
    mapping = mapping_factory(dirty_sample_set["master"])
    result, _written = convert_to_dir(dirty_sample_set["xlsx"], mapping, tmp_path / "out")

    assert V.validate_dir(tmp_path / "out") == []
    assert "pick_time_s" in result.calibration, "one bad row must not kill the fit"
    assert result.calibration["pick_time_s"]["sample"]["excluded"] >= 1

    rows = list(csv.DictReader((tmp_path / "out" / "error_table.csv").open(encoding="utf-8-sig")))
    assert [r["reason"] for r in rows], "error table is written even though the run succeeded"
    assert all(r["detail"] for r in rows), "every reason carries a human explanation"
    assert all(int(r["row"]) >= 0 for r in rows)


def test_broken_timestamp_drops_only_that_field(dirty_sample_set, mapping_factory):
    mapping = mapping_factory(dirty_sample_set["master"])
    result = convert(dirty_sample_set["xlsx"], mapping)

    dropped = [e for e in result.errors if e.reason == "unparseable_timestamp"]
    assert dropped and all(e.action == "field_dropped" for e in dropped)
    # its order line survives; only the pick_end event of that row is missing
    counts = result.meta["events"]["emitted_types"]
    assert counts["pick_end"] == counts["pick_start"] - 1


def test_unknown_code_can_be_kept_instead_of_quarantined(dirty_sample_set, mapping_factory):
    mapping = mapping_factory(
        dirty_sample_set["master"], subdir="keep", **{"masters.loc_id.on_unknown": "keep"}
    )
    result = convert(dirty_sample_set["xlsx"], mapping)

    assert "unknown_code" not in _reasons(result)
    assert any(order["loc_id"] == "Z-09-09" for order in result.orders)


def test_zero_padding_is_what_makes_the_master_match(dirty_sample_set, mapping_factory):
    """Without segment padding the history codes match nothing: 0% is the classic trap."""
    padded = convert(dirty_sample_set["xlsx"], mapping_factory(dirty_sample_set["master"]))
    unpadded = convert(
        dirty_sample_set["xlsx"],
        mapping_factory(
            dirty_sample_set["master"], subdir="nopad", **{"normalize.loc_id.pad_segments": []}
        ),
    )

    assert len([e for e in padded.errors if e.reason == "unknown_code"]) == 1
    assert len([e for e in unpadded.errors if e.reason == "unknown_code"]) == (
        unpadded.meta["counts"]["rows_read"] - 2
    ), "every code except the two rows quarantined earlier now fails to match"
    assert unpadded.meta["counts"]["orders"] == 0


def test_missing_required_column_is_reported_not_crashed(sample_set, mapping_factory, tmp_path):
    mapping = mapping_factory(
        sample_set["master"], subdir="noqty", **{"columns.qty": ["存在しない列"]}
    )
    result, _ = convert_to_dir(sample_set["xlsx"], mapping, tmp_path / "out")

    assert result.orders == []
    assert any(e.reason == "required_column_missing" for e in result.errors)
    assert any("必須" in note for note in result.notes)
    assert V.validate_dir(tmp_path / "out") == [], "empty but valid beats a crash"
    assert json.loads((tmp_path / "out" / "orders.json").read_text(encoding="utf-8")) == []


def test_input_without_any_timestamp_still_produces_valid_orders(
    sample_set, mapping_factory, tmp_path
):
    """No clock in the file: orders survive, events and calibration are skipped."""
    mapping = mapping_factory(
        sample_set["master"], subdir="notime",
        **{
            "columns.assigned_at": ["無い1"],
            "columns.pick_start_at": ["無い2"],
            "columns.pick_end_at": ["無い3"],
        },
    )
    result, _ = convert_to_dir(sample_set["xlsx"], mapping, tmp_path / "out")

    assert result.orders and result.events == []
    assert result.meta["t0"] is None
    assert "pick_time_s" not in result.calibration
    assert result.calibration["fitted_at"] == "unknown"
    assert "no_timestamps" in _reasons(result)
    assert V.validate_dir(tmp_path / "out") == []


def test_missing_optional_column_only_drops_its_events(sample_set, mapping_factory):
    mapping = mapping_factory(
        sample_set["master"], subdir="noassign", **{"columns.assigned_at": ["無い列"]}
    )
    result = convert(sample_set["xlsx"], mapping)

    assert result.orders, "orders survive"
    assert all("ready_t" not in order for order in result.orders)
    assert "task_assign" not in result.meta["events"]["emitted_types"]
    assert "task_assign" in result.meta["events"]["omitted_types"]
