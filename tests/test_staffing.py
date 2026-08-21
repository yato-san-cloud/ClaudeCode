"""Volume → required-headcount bridge (analysis.staffing)."""

import pandas as pd

from whsim.analysis import staffing
from whsim.analysis.report import sample_bundle


def _ship(n_lines, days=2, qty=1):
    rows = []
    for d in range(days):
        for i in range(n_lines):
            rows.append({"date": pd.Timestamp("2026-01-01") + pd.Timedelta(days=d),
                         "sku": f"S{i%5}", "qty": qty, "order_id": f"O{d}-{i%10}"})
    return pd.DataFrame(rows)


def test_profile_shape_and_keys():
    s = staffing.staffing_profile(_ship(120), None)
    assert {"processes", "total_headcount_by_hour", "peak_headcount",
            "total_man_hours", "operating_days"} <= set(s)
    assert len(s["total_headcount_by_hour"]) == 24
    ids = {p["id"] for p in s["processes"]}
    assert {"ピッキング", "梱包", "出荷"} <= ids
    for p in s["processes"]:
        assert len(p["headcount_by_hour"]) == 24
        assert p["peak_headcount"] >= 0


def test_more_volume_needs_more_people():
    small = staffing.staffing_profile(_ship(60), None)["peak_headcount"]
    big = staffing.staffing_profile(_ship(6000), None)["peak_headcount"]
    assert big > small


def test_empty_is_safe():
    s = staffing.staffing_profile(None, None)
    assert s["peak_headcount"] == 0
    assert s["total_man_hours"] == 0


def test_bundle_includes_staffing():
    b = sample_bundle(days=30, seed=2)
    assert "staffing" in b and b["staffing"]["processes"]


# --- 入荷時刻データの取込対応: data-driven inbound hour shape -------------------

# The exact historical fixed 8-16 window (byte-identical regression oracle).
_FIXED_INBOUND = [1.0 / 8 if 8 <= h < 16 else 0.0 for h in range(24)]


def _inb(hours, per_hour=100, qty=5, days=1, time_col="timestamp", with_date=True):
    """Inbound frame with `per_hour` lines landing at each hour in `hours`.

    `time_col` chooses whether the clock lives in a 'timestamp' column (出荷日時-
    style) or directly in the 'date' column (imported 入荷実績 has only a date, but
    pandas keeps a time component if the source carried one)."""
    rows = []
    for d in range(days):
        day = pd.Timestamp("2026-01-05") + pd.Timedelta(days=d)
        for h in hours:
            for i in range(per_hour):
                ts = day + pd.Timedelta(hours=h, minutes=i % 60)
                row = {"sku": f"S{i % 5}", "qty": qty}
                if with_date:
                    row["date"] = day.normalize() if time_col == "timestamp" else ts
                if time_col == "timestamp":
                    row["timestamp"] = ts
                rows.append(row)
    return pd.DataFrame(rows)


def _inbound_sections(prof):
    return [p for p in prof["processes"] if p["section"] == "入荷"]


def test_inbound_without_timestamps_is_byte_identical():
    # (a) regression bar: no usable clock → EXACT historical fixed 8-16 window.
    assert staffing._inbound_shape(None) == _FIXED_INBOUND
    assert staffing._inbound_shape(pd.DataFrame()) == _FIXED_INBOUND
    date_only = pd.DataFrame({
        "date": pd.to_datetime(["2026-01-05", "2026-01-06"] * 5),
        "sku": ["S%d" % (i % 5) for i in range(10)], "qty": [4] * 10,
    })
    assert staffing._inbound_shape(date_only) == _FIXED_INBOUND
    # And the full profile only ever staffs inbound inside that fixed window.
    prof = staffing.staffing_profile(_ship(120), date_only)
    inb = _inbound_sections(prof)
    assert inb, "expected 入荷 processes in the profile"
    for p in inb:
        head = p["headcount_by_hour"]
        assert sum(head[h] for h in range(24) if not 8 <= h < 16) == 0
        assert sum(head[h] for h in range(8, 16)) > 0


def test_inbound_shape_follows_real_timestamps():
    # (b) usable timestamps concentrated at 6-8時 → inbound staffing concentrates
    # there, INCLUDING hours 6-7 that the fixed 8-16 window could never touch.
    inb = _inb([6, 7, 8])
    shape = staffing._inbound_shape(inb)
    assert shape != _FIXED_INBOUND
    assert shape[6] > 0 and shape[7] > 0            # outside the fixed window
    assert sum(shape[9:]) == 0 and sum(shape[:6]) == 0
    assert abs(sum(shape) - 1.0) < 1e-9

    prof = staffing.staffing_profile(_ship(120), inb)
    for p in _inbound_sections(prof):
        head = p["headcount_by_hour"]
        assert head[6] > 0 and head[7] > 0          # staffed pre-8時 from the data
        assert sum(head[9:]) == 0                    # no afternoon inbound in the data


def test_inbound_shape_reads_clock_from_date_column():
    # Imported 入荷実績 carries only a 'date' column; a real timestamp survives in it.
    inb = _inb([7, 8], time_col="date")
    shape = staffing._inbound_shape(inb)
    assert shape[7] > 0 and shape[8] > 0
    assert sum(shape[9:]) == 0 and sum(shape[:7]) == 0


def test_inbound_degenerate_timestamps_fall_back():
    # (c) all-midnight and all-NaT stamps are NOT real clock time → fixed window.
    midnight = pd.DataFrame({
        "date": [pd.Timestamp("2026-01-05")] * 8,
        "timestamp": [pd.Timestamp("2026-01-05")] * 8,
        "sku": ["S%d" % (i % 5) for i in range(8)], "qty": [3] * 8,
    })
    assert staffing._inbound_shape(midnight) == _FIXED_INBOUND
    nat = midnight.assign(timestamp=pd.NaT)
    assert staffing._inbound_shape(nat) == _FIXED_INBOUND
    # Mixed: a couple of real stamps among midnight noise → data-driven (uses only
    # the real ones, never piling the unknown-time rows onto hour 0).
    mixed = midnight.copy()
    mixed.loc[0, "timestamp"] = pd.Timestamp("2026-01-05 07:30")
    mixed.loc[1, "timestamp"] = pd.Timestamp("2026-01-05 07:45")
    shape = staffing._inbound_shape(mixed)
    assert shape[7] == 1.0 and shape[0] == 0.0
