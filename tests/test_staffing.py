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
