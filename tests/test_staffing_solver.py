"""Analytic staffing-solver tests (analysis.staffing.solve_staffing).

The 人員タイムチャート solver staffs a day analytically over an operating window
under a headcount cap, honouring process precedence (入荷→格納→ピッキング→検品→
梱包→出荷) and a placement choice (前詰め=front-load vs 均等=level-load). These
tests pin its load-bearing invariants:

  * precedence staggers the start (downstream ramps only after upstream feeds),
  * the global / per-process headcount caps are never exceeded in any bucket,
  * front-load finishes earlier (smaller makespan) than level-load,
  * an infeasible cap is reported honestly as a shortfall (not silently dropped),
  * the solver is deterministic and never-blocks on empty input.
"""

from whsim.analysis import staffing

# A consistent demand set spanning the whole flow (ids = GENERIC_PROCESSES).
VOLS = {
    "入荷検品": 1200, "格納": 3000, "ピッキング": 2400,
    "検品": 2400, "梱包": 1700, "出荷": 1700,
}


def _first_active_hour(proc):
    return next((i for i, n in enumerate(proc["headcount_by_hour"]) if n > 0), None)


def _proc(result, pid):
    return next(p for p in result["processes"] if p["id"] == pid)


def test_precedence_staggers_start():
    # Front-load makes the cascade crisp: each process can only begin after its
    # upstream has fed it, so the first active hour is non-decreasing down the DAG.
    res = staffing.solve_staffing(VOLS, start_hour=8, end_hour=24, placement="front")
    chain = ["入荷検品", "格納", "ピッキング", "検品", "梱包", "出荷"]
    starts = [_first_active_hour(_proc(res, pid)) for pid in chain]
    assert all(s is not None for s in starts)
    # 入荷検品 (no upstream) starts first; every downstream starts strictly later.
    assert starts[0] == 0
    assert all(starts[i] < starts[i + 1] for i in range(len(starts) - 1)), starts


def test_global_cap_never_exceeded_in_any_bucket():
    res = staffing.solve_staffing(VOLS, start_hour=8, end_hour=24, cap=25, placement="front")
    assert max(res["total_headcount_by_hour"]) <= 25
    assert res["cap_exceeded"] is False


def test_per_process_cap_respected():
    res = staffing.solve_staffing(
        VOLS, start_hour=8, end_hour=24, per_process_cap={"梱包": 3}, placement="front",
    )
    pack = _proc(res, "梱包")
    assert max(pack["headcount_by_hour"]) <= 3


def test_front_load_finishes_earlier_than_level_load():
    # Same demand / window: front-load (staff up early) must finish no later than
    # level-load (spread evenly), and at a higher peak headcount (the trade-off).
    front = staffing.solve_staffing(VOLS, start_hour=8, end_hour=24, placement="front")
    level = staffing.solve_staffing(VOLS, start_hour=8, end_hour=24, placement="level")
    assert front["makespan_hour"] < level["makespan_hour"]
    assert front["peak_headcount"] >= level["peak_headcount"]
    # Both burn the same total man-hours (volume ÷ productivity is placement-free,
    # modulo a small integer-rounding tail).
    assert abs(front["total_man_hours"] - level["total_man_hours"]) <= front["total_man_hours"] * 0.2


def test_infeasible_cap_reports_shortfall():
    # A 2-hour window with a tiny cap cannot clear the day → honest shortfall, not
    # a silent drop or a crash.
    res = staffing.solve_staffing(VOLS, start_hour=9, end_hour=11, cap=4, placement="level")
    assert res["feasible"] is False
    assert res["shortfall_man_hours"] > 0
    # At least one process is flagged short with a positive residual volume.
    assert any((not p["feasible"]) and p["shortfall_volume"] > 0 for p in res["processes"])


def test_man_hours_match_volume_over_productivity():
    # Each process's required man-hours = volume / resolved productivity.
    res = staffing.solve_staffing(VOLS, start_hour=6, end_hour=26, placement="front")
    for p in res["processes"]:
        expected = p["daily_volume"] / p["productivity"]
        assert abs(p["required_man_hours"] - expected) < 0.05


def test_deterministic_and_jsonsafe():
    import json
    a = staffing.solve_staffing(VOLS, start_hour=8, end_hour=22, cap=20, placement="front")
    b = staffing.solve_staffing(VOLS, start_hour=8, end_hour=22, cap=20, placement="front")
    assert a == b
    json.dumps(a)  # must be JSON-serialisable for the API payload


def test_empty_volumes_never_blocks():
    res = staffing.solve_staffing({}, start_hour=9, end_hour=18)
    assert res["processes"] == []
    assert res["peak_headcount"] == 0
    assert res["feasible"] is True
    assert res["total_man_hours"] == 0


def test_degenerate_window_does_not_crash():
    # end <= start is normalised to a single hour rather than dividing by zero.
    res = staffing.solve_staffing(VOLS, start_hour=12, end_hour=12, placement="level")
    assert len(res["hours"]) >= 1
    assert isinstance(res["peak_headcount"], int)


def test_default_dependencies_shape():
    deps = staffing.default_dependencies()
    assert deps["格納"] == ["入荷検品"]
    assert deps["出荷"] == ["梱包"]
    # Editable: a user-supplied DAG overrides the default (remove an edge here).
    res = staffing.solve_staffing(
        VOLS, start_hour=8, end_hour=24, dependencies={"格納": []}, placement="front",
    )
    # With 格納's upstream edge removed it can start in hour 0 alongside 入荷検品.
    assert _first_active_hour(_proc(res, "格納")) == 0


# ---- バッチ投入スケジュール (batch arrival gate) -------------------------------

def test_batch_arrival_curve_cumulative():
    # 朝70% / 昼20% / 15時10% over an 8–18 window → cumulative .7/.9/1.0 fraction.
    hours = list(range(8, 18))
    curve = staffing.batch_arrival_curve(
        [{"hour": 8, "pct": 70}, {"hour": 12, "pct": 20}, {"hour": 15, "pct": 10}], hours)
    assert curve is not None
    assert abs(curve[hours.index(8)] - 0.70) < 1e-9    # 08:00 → 70% landed
    assert abs(curve[hours.index(11)] - 0.70) < 1e-9   # still 70% just before noon
    assert abs(curve[hours.index(12)] - 0.90) < 1e-9   # noon batch → 90%
    assert abs(curve[hours.index(15)] - 1.0) < 1e-9    # final batch → 100%
    assert abs(curve[-1] - 1.0) < 1e-9


def test_batch_arrival_curve_normalises_and_empties():
    hours = list(range(9, 12))
    # Percentages that don't sum to 100 are normalised so the day still clears.
    curve = staffing.batch_arrival_curve([{"hour": 9, "pct": 1}, {"hour": 10, "pct": 1}], hours)
    assert abs(curve[-1] - 1.0) < 1e-9
    # No usable entries → None (caller imposes no arrival gate).
    assert staffing.batch_arrival_curve([], hours) is None
    assert staffing.batch_arrival_curve([{"hour": 9, "pct": 0}], hours) is None


def test_batch_noon_release_delays_inbound_root():
    # A single noon batch for 入荷 means 入荷検品 cannot start before 12:00.
    batches = {"入荷": [{"hour": 12, "pct": 100}]}
    res = staffing.solve_staffing(
        VOLS, start_hour=8, end_hour=24, placement="front", batches=batches)
    recv = _proc(res, "入荷検品")
    first = _first_active_hour(recv)
    assert res["hours"][first] >= 12, res["hours"]


def test_batch_release_gates_outbound_independently():
    # An 出荷 (order-release) batch gates ピッキング regardless of inbound timing.
    batches = {"出荷": [{"hour": 14, "pct": 100}]}
    res = staffing.solve_staffing(
        VOLS, start_hour=8, end_hour=24, placement="front",
        dependencies={"ピッキング": []}, batches=batches)  # isolate the arrival gate
    pick = _proc(res, "ピッキング")
    first = _first_active_hour(pick)
    assert res["hours"][first] >= 14, res["hours"]


def test_batch_ramp_caps_cumulative_output():
    # With 70% at 08:00 the inbound root cannot clear more than ~70% before noon.
    batches = {"入荷": [{"hour": 8, "pct": 70}, {"hour": 12, "pct": 30}]}
    res = staffing.solve_staffing(
        VOLS, start_hour=8, end_hour=24, placement="front", batches=batches)
    recv = _proc(res, "入荷検品")
    rate = recv["productivity"]
    hours = res["hours"]
    # Cumulative units produced through 11:00 (last hour before the noon batch).
    idx_11 = hours.index(11)
    cum_units = sum(recv["headcount_by_hour"][: idx_11 + 1]) * rate
    assert cum_units <= recv["daily_volume"] * 0.70 + rate, (cum_units, recv["daily_volume"])


def test_no_batches_is_unchanged():
    # Regression: omitting batches solves identically to before (no arrival gate).
    base = staffing.solve_staffing(VOLS, start_hour=8, end_hour=24, placement="front")
    withn = staffing.solve_staffing(
        VOLS, start_hour=8, end_hour=24, placement="front", batches=None)
    assert base["total_man_hours"] == withn["total_man_hours"]
    assert base["makespan_hour"] == withn["makespan_hour"]
    assert withn["batches"] == {}


# ---- editable work-process master (完全フリー工程) ----------------------------

def test_process_master_defaults_to_generic():
    from whsim.schema.model import WarehouseModel
    m = WarehouseModel()  # empty work_processes
    ids = [p["id"] for p in staffing.process_master(m)]
    assert ids == [p["id"] for p in staffing.GENERIC_PROCESSES]
    # process_deps mirrors the engine default precedence.
    assert staffing.process_deps(m)["格納"] == ["入荷検品"]
    assert staffing.process_master(None)  # None model → engine default, never blocks


def test_solver_honours_custom_process_list():
    from whsim.schema.model import WarehouseModel, WorkProcess
    m = WarehouseModel()
    m.process.work_processes = [
        WorkProcess(id="入荷", section="入荷", driver="in_lines", prod=50, unit="行/h"),
        WorkProcess(id="出荷ピック", section="出荷", driver="out_lines", prod=80,
                    unit="行/h", depends=["入荷"]),
    ]
    res = staffing.solve_staffing(
        {"入荷": 500, "出荷ピック": 800}, model=m,
        start_hour=8, end_hour=20, placement="front")
    assert {p["id"] for p in res["processes"]} == {"入荷", "出荷ピック"}
    # The custom precedence (出荷ピック after 入荷) still staggers the start.
    recv = _first_active_hour(_proc(res, "入荷"))
    pick = _first_active_hour(_proc(res, "出荷ピック"))
    assert recv is not None and pick is not None and pick > recv
    # The custom default productivity is used for 出荷ピック.
    assert _proc(res, "出荷ピック")["productivity"] == 80.0


def test_cost_honours_custom_process_list():
    # 原価試算 reads the same editable master, so a custom process appears in the
    # labour breakdown with its own driver + productivity.
    from whsim import cost
    from whsim.schema.model import Order, OrderLine, WarehouseModel, WorkProcess
    m = WarehouseModel()
    m.orders.outbound = [Order(order_id=f"o{i}", lines=[OrderLine(sku="A", qty=2)])
                         for i in range(50)]
    m.process.work_processes = [
        WorkProcess(id="検品梱包", section="出荷", driver="out_orders", prod=25, unit="件/h"),
    ]
    r = cost.estimate_cost(m)
    labour = next(c for c in r["categories"] if "人件費" in str(c.get("label", "")))
    detail = labour.get("detail") or []
    assert [d["id"] for d in detail] == ["検品梱包"]
    assert detail[0]["prod"] == 25.0
    # 50 orders/day ÷ 25 = 2.0 man-hours/day flows to the day total.
    assert abs(r["mh_per_day"] - 2.0) < 1e-6


# ---- シフト・休憩モデル (breaks / shifts / wage bands) --------------------------

def test_empty_shift_plan_is_byte_identical():
    # Regression bar: an empty/None plan must yield a byte-identical result dict,
    # AND must NOT introduce the additive keys.
    base = staffing.solve_staffing(VOLS, start_hour=8, end_hour=22, cap=20, placement="front")
    none_plan = staffing.solve_staffing(
        VOLS, start_hour=8, end_hour=22, cap=20, placement="front", shift_plan=None)
    empty_plan = staffing.solve_staffing(
        VOLS, start_hour=8, end_hour=22, cap=20, placement="front", shift_plan={})
    empty_full = staffing.solve_staffing(
        VOLS, start_hour=8, end_hour=22, cap=20, placement="front",
        shift_plan={"breaks": [], "shifts": [], "default_wage_per_hr": 1200})
    assert base == none_plan == empty_plan == empty_full
    assert "labour_cost_day" not in base
    assert "shift_plan" not in base


def test_break_hour_gets_zero_allocation_and_volume_shifts():
    # A 12–13 break must leave hour 12 with ZERO headcount across every process,
    # and the day's volume must still clear (it shifts to other hours).
    plan = {"breaks": [{"start": 12, "end": 13}], "default_wage_per_hr": 1200}
    no_break = staffing.solve_staffing(VOLS, start_hour=8, end_hour=24, placement="front")
    with_break = staffing.solve_staffing(
        VOLS, start_hour=8, end_hour=24, placement="front", shift_plan=plan)
    idx12 = with_break["hours"].index(12)
    assert with_break["total_headcount_by_hour"][idx12] == 0
    for p in with_break["processes"]:
        assert p["headcount_by_hour"][idx12] == 0
    # Same demand still fully staffed (feasible) — the break shifts work, not drops it.
    assert with_break["feasible"] is True
    # The plan is echoed and a labour cost line appears.
    assert with_break["shift_plan"] == plan
    assert with_break["labour_cost_day"] > 0
    # No-break day is unaffected at hour 12 (sanity that the fixture has work there).
    assert no_break["total_headcount_by_hour"][idx12] > 0


def test_shift_max_caps_an_hour():
    # A single shift 8–18 with max_workers=5 caps EVERY hour's total headcount at 5,
    # and an hour with no covering shift (18–20) is closed.
    plan = {"shifts": [
        {"label": "日勤", "start": 8, "end": 18, "max_workers": 5, "wage_per_hr": 1000},
    ]}
    res = staffing.solve_staffing(
        VOLS, start_hour=8, end_hour=20, placement="front", shift_plan=plan)
    for hi, h in enumerate(res["hours"]):
        if 8 <= h < 18:
            assert res["total_headcount_by_hour"][hi] <= 5, (h, res["total_headcount_by_hour"][hi])
        else:  # 18,19 — shifts defined but none cover ⇒ closed
            assert res["total_headcount_by_hour"][hi] == 0, h


def test_labour_cost_hand_check():
    # A hand-verifiable case: one process, one shift covering the whole window at a
    # known wage, so labour_cost_day = Σ headcount × wage exactly.
    from whsim.schema.model import WarehouseModel, WorkProcess
    m = WarehouseModel()
    m.process.work_processes = [
        WorkProcess(id="梱包", section="出荷", driver="out_orders", prod=10, unit="件/h"),
    ]
    # 100 件 ÷ 10/h = 10 man-hours; front-load with a max of 5/hr over 8–18.
    plan = {"shifts": [
        {"label": "A", "start": 8, "end": 18, "max_workers": 5, "wage_per_hr": 1000},
    ]}
    res = staffing.solve_staffing(
        {"梱包": 100}, model=m, start_hour=8, end_hour=18, placement="level", shift_plan=plan)
    total_head = sum(res["total_headcount_by_hour"])
    # Every staffed hour is inside the 1000¥ shift → cost = total man-hours × 1000.
    assert res["labour_cost_day"] == round(total_head * 1000.0, 1)
    assert total_head == 10  # 100/10, integer buckets of ≤5


def test_wage_bands_default_and_covering():
    # Two hours: hour 9 covered by a 1500¥ shift, hour 17 uncovered → default 1200¥.
    # One process, front-load so it staffs from the open.
    from whsim.schema.model import WarehouseModel, WorkProcess
    m = WarehouseModel()
    m.process.work_processes = [
        WorkProcess(id="出荷", section="出荷", driver="out_orders", prod=1, unit="件/h"),
    ]
    plan = {
        "shifts": [{"label": "朝", "start": 9, "end": 10, "max_workers": 1, "wage_per_hr": 1500}],
        "default_wage_per_hr": 1200,
    }
    # 2 units at prod=1/h, max 1/hr in the covered hour → 1 unit hour 9 (1500¥),
    # but hour 10+ has shifts defined & uncovered ⇒ closed, so it can't finish.
    res = staffing.solve_staffing(
        {"出荷": 2}, model=m, start_hour=9, end_hour=18, placement="front", shift_plan=plan)
    # Exactly 1 person-hour placed at hour 9 under the 1500¥ band.
    assert res["labour_cost_day"] == 1500.0
    assert res["feasible"] is False  # only 1 of 2 units clearable (rest is closed)


def test_batch_outside_window_is_clamped_not_stranded():
    # A batch hour at/after end_hour (or before start) must be clamped into the
    # window so the cumulative curve still reaches 1.0 — never strands volume.
    hours = list(range(9, 18))
    after = staffing.batch_arrival_curve([{"hour": 20, "pct": 100}], hours)
    assert after is not None and abs(after[-1] - 1.0) < 1e-9   # not all-zero
    split = staffing.batch_arrival_curve([{"hour": 9, "pct": 50}, {"hour": 22, "pct": 50}], hours)
    assert abs(split[-1] - 1.0) < 1e-9                          # both halves land
    before = staffing.batch_arrival_curve([{"hour": 3, "pct": 100}], hours)
    assert abs(before[0] - 1.0) < 1e-9                          # pre-open → at open
    # End to end: an out-of-window 出荷 batch must NOT strand outbound volume —
    # outbound is still scheduled (clamped into the window), not zeroed out.
    res = staffing.solve_staffing(
        VOLS, start_hour=9, end_hour=20, placement="front",
        batches={"出荷": [{"hour": 23, "pct": 100}]})
    pick = _proc(res, "ピッキング")
    assert pick["man_hours"] > 0 and any(pick["headcount_by_hour"])
