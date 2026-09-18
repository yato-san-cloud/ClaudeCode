"""Work-timetable solver tests — faithful behaviour of the ported solver.

Mirrors the invariants the standalone timetable_solver guaranteed: 60 half-hour
slots, fixed_n is constant across its band, dynamic placement never runs ahead of
its dependency's cumulative progress (the volume-flow constraint), per-slot totals
are self-consistent, and the peak-cap warning fires.
"""
import copy

import whsim.timetable as tt

SEED = tt.load_seed()
AVG = list(SEED["scenarios"])[0]


def _solve(scenario_name: str | None = None):
    scen = SEED["scenarios"][scenario_name or AVG]
    return tt.solve(scen, SEED["processes"], SEED["productivity"])


def test_seed_loads_with_expected_shape():
    assert len(SEED["processes"]) == 13
    assert len(SEED["productivity"]) == 13
    assert len(SEED["scenarios"]) == 3
    # Every process references a productivity key that exists.
    for p in SEED["processes"]:
        assert p["productivity_key"] in SEED["productivity"]


def test_time_helpers_handle_past_midnight():
    assert tt.time_to_min("08:00") == 480
    assert tt.time_to_min("29:05") == 1745  # logistics day spills past 24:00
    assert tt.min_to_time(1745) == "29:05"
    assert len(tt.generate_slots()) == 60  # 0:00–30:00 at 30-min steps


def test_solve_average_scenario_is_sane():
    res = _solve()
    assert len(res["slots"]) == 60
    assert len(res["headcount_by_slot"]) == 60
    assert res["peak_headcount"] > 0
    assert res["peak_headcount"] == max(res["headcount_by_slot"])
    assert 0 <= res["peak_slot_index"] < 60
    assert res["total_required_hours"] > 0
    assert res["total_assigned_hours"] > 0
    # Per-slot totals equal the sum across processes (no double counting / drift).
    agg = [0] * 60
    for p in res["processes"]:
        for i, n in enumerate(p["headcounts"]):
            agg[i] += n
    assert agg == res["headcount_by_slot"]
    # Worker-type subtotals cover PT and Fマン and sum back to the grand total.
    assert {"PT", "Fマン"} <= set(res["by_worker_type"])
    for i in range(60):
        assert sum(d["by_slot"][i] for d in res["by_worker_type"].values()) == res["headcount_by_slot"][i]


def test_fixed_n_process_is_constant_within_band():
    res = _solve()
    cs = next(p for p in res["processes"] if p["id"] == "出荷_CS検品")
    assert cs["mode"] == "fixed_n"
    assert cs["peak"] == 1  # 固定人数: 1
    start, end = tt.time_to_min(cs["band"][0]), tt.time_to_min(cs["band"][1])
    for i, t in enumerate(res["slots"]):
        assert cs["headcounts"][i] == (1 if start <= t < end else 0)


def test_topological_order_places_dependency_before_dependent():
    order = tt.topological_sort(SEED["processes"])
    ids = [p["id"] for p in order]
    assert ids.index("入荷_格納") < ids.index("ケース_飲料")
    assert ids.index("ピック_バラ_集約") < ids.index("出荷_オリコン積み付け")


def test_dynamic_placement_respects_dependency_flow():
    # ケース_飲料 (dynamic) depends on 入荷_格納; its cumulative throughput must
    # never exceed the dependency's progress-scaled cap (within one slot's worth).
    res = _solve()
    parent = next(p for p in res["processes"] if p["id"] == "入荷_格納")
    child = next(p for p in res["processes"] if p["id"] == "ケース_飲料")
    p_target = parent["target_volume"]
    c_target = child["target_volume"]
    slack = child["productivity"] * 0.5 + 1e-6  # one slot of child throughput
    for k in range(1, 61):
        progress = parent["cumulative"][k] / p_target
        assert child["cumulative"][k] <= progress * c_target + slack


def test_solve_is_deterministic_pure_function():
    a = _solve()
    b = _solve()
    assert a["headcount_by_slot"] == b["headcount_by_slot"]
    assert a["peak_headcount"] == b["peak_headcount"]
    assert [p["headcounts"] for p in a["processes"]] == [p["headcounts"] for p in b["processes"]]


def test_all_seed_scenarios_solve_without_error():
    for name in SEED["scenarios"]:
        res = _solve(name)
        assert res["peak_headcount"] > 0
        assert all(isinstance(n, int) and n >= 0 for n in res["headcount_by_slot"])


def test_missing_productivity_warns_and_does_not_crash():
    procs = copy.deepcopy(SEED["processes"])
    procs[0]["productivity_key"] = "存在しないキー"
    res = tt.solve(SEED["scenarios"][AVG], procs, SEED["productivity"])
    assert any("存在しないキー" in w for w in res["warnings"])
    # The bad process is simply skipped; the rest still solve.
    assert res["peak_headcount"] > 0


def test_peak_cap_warning_fires_when_exceeded():
    scen = copy.deepcopy(SEED["scenarios"][AVG])
    scen["制約"]["ピーク人数上限"] = 5  # force an exceedance
    res = tt.solve(scen, SEED["processes"], SEED["productivity"])
    assert any("ピーク" in w and "上限" in w for w in res["warnings"])
