"""Unit tests for the two places where real exports usually go wrong:
code normalisation and timestamp parsing."""

from __future__ import annotations

from datetime import datetime

import pytest

from lfcore.normalize import NormalizeRule, cell_to_text, parse_number
from lfcore.timeconv import EXCEL_EPOCH, parse_wallclock, to_elapsed


@pytest.mark.parametrize(
    "value, expected",
    [
        (1234.0, "1234"),  # Excel stores an integer code as a float
        (1234, "1234"),
        (None, ""),
        (float("nan"), ""),
        (" A-1-2 ", " A-1-2 "),
        (12.5, "12.5"),
    ],
)
def test_cell_to_text_does_not_invent_digits(value, expected):
    assert cell_to_text(value) == expected


def test_segment_padding_matches_master_style_codes():
    rule = NormalizeRule.from_dict(
        {"segment_sep": "-", "pad_segments": [0, 2, 2], "upper": True}
    )
    assert rule.apply("a-1-2") == "A-01-02"
    assert rule.apply("A-01-02") == "A-01-02"  # idempotent
    assert rule.apply("Ａ－１－２".replace("－", "-")) == "A-01-02"  # full width digits


def test_whole_string_zero_pad_only_touches_numbers():
    rule = NormalizeRule.from_dict({"zero_pad": 6})
    assert rule.apply(7) == "000007"
    assert rule.apply("7") == "000007"
    assert rule.apply("A7") == "A7", "padding a non-numeric code would corrupt it"


def test_remove_chars_and_affixes():
    rule = NormalizeRule.from_dict(
        {"remove_chars": "- ", "zero_pad": 8, "prefix": "LOC", "suffix": "#"}
    )
    assert rule.apply("12-34") == "LOC00001234#"


def test_empty_stays_empty():
    assert NormalizeRule.from_dict({"zero_pad": 6}).apply("   ") == ""


@pytest.mark.parametrize(
    "value, expected",
    [
        ("1,234", 1234.0),
        ("１２３", 123.0),  # full width
        ("12 個", 12.0),
        ("-3", -3.0),
        (7, 7.0),
        ("", None),
        ("－", None),
        ("abc", None),
        (None, None),
    ],
)
def test_parse_number(value, expected):
    assert parse_number(value) == expected


@pytest.mark.parametrize(
    "value, expected",
    [
        ("2025-07-01 08:00:00", datetime(2025, 7, 1, 8, 0, 0)),
        ("2025/07/01 08:00", datetime(2025, 7, 1, 8, 0)),
        ("2025-07-01 08:00:00.250", datetime(2025, 7, 1, 8, 0, 0, 250000)),
        (datetime(2025, 7, 1, 8, 0), datetime(2025, 7, 1, 8, 0)),
        ("2025/13/32 99:99", None),
        ("", None),
        ("-", None),
        (None, None),
        ("not a date", None),
    ],
)
def test_parse_wallclock(value, expected):
    formats = ["%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M"]
    assert parse_wallclock(value, formats) == expected


def test_excel_serial_dates_are_understood():
    assert parse_wallclock(45839.5) == EXCEL_EPOCH.replace(year=2025, month=7, day=1, hour=12)


def test_elapsed_seconds_are_rounded_for_stable_bytes():
    t0 = datetime(2025, 7, 1, 8, 0, 0)
    assert to_elapsed(datetime(2025, 7, 1, 8, 0, 1, 234567), t0) == 1.235
    assert to_elapsed(t0, t0) == 0.0
