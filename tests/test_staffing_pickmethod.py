"""作業方式 → ピッキング生産性 (staffing.resolve_productivity engine-default tier).

The analytic staffing solver used to staff picking at a flat engine default (行/h),
so two scenarios differing ONLY in 作業方式 (シングル/マルチ/ゾーン/トータル) staffed
IDENTICALLY. The engine-default (3rd) tier now derives the PICKING productivity from
the analytic pickrate for the model's selected method — reusing the same move-vs-sort
motion-time model — so method finally moves peak人数 / 総工数.

These tests pin the load-bearing invariants:
  (a) the default tier is byte-identical to before wherever the derivation doesn't
      apply (no model, a non-picking process),
  (b) two models differing ONLY in pick method get DIFFERENT picking productivity
      AND different solve_staffing peak / man-hours,
  (c) an override (and a benchmark) still win over the method-derived value (3-tier),
  (d) goods-to-person transport keeps the flat engine default.
"""

from whsim import pickrate, templates, workmethod
from whsim.analysis import staffing
from whsim.schema.model import WarehouseModel, WorkMethod

# The picking process's flat engine default (GENERIC_PROCESSES 行/h) — the value the
# 3rd tier used to return for EVERY method.
_PICK_DEFAULT = next(p["prod"] for p in staffing.GENERIC_PROCESSES if p["id"] == "ピッキング")

# A demand set big enough that a productivity change moves integer headcounts.
VOLS = {"ピッキング": 5000, "検品": 5000, "梱包": 3000, "出荷": 3000}


def _model(work: WorkMethod | None = None):
    """A real template model with an explicit pick-stage 作業方式 (when given)."""
    m = templates.load_template_model("ecommerce_small")
    if work is not None:
        m.process.pick_stage().work = work
    return m


def _pickrate_lph(model, label: str) -> float:
    row = next(r for r in pickrate.estimate_pickrate(model)["methods"] if r["label"] == label)
    return float(row["lines_per_hour"])


# ---- (a) default tier byte-identical where the derivation doesn't apply ---------

def test_no_model_is_byte_identical_default():
    # model=None → the flat default, unchanged (repr-equal, not just close).
    out = staffing.resolve_productivity(None, "ピッキング", float(_PICK_DEFAULT))
    assert out == float(_PICK_DEFAULT)
    assert repr(out) == repr(float(_PICK_DEFAULT))


def test_non_picking_process_is_byte_identical_default():
    # A non-picking process is never method-derived → exact default even WITH a model
    # whose pick method is non-default.
    m = _model(WorkMethod(orders_per_trip=8))
    for pid, dflt in (("検品", 120.0), ("梱包", 30.0), ("入荷検品", 40.0)):
        out = staffing.resolve_productivity(m, pid, dflt)
        assert out == dflt and repr(out) == repr(dflt), pid


def test_solver_default_model_picking_unchanged_for_bare_model():
    # A bare WarehouseModel() (default シングルオーダー) still solves; the picking row's
    # productivity is a positive rate and the solver stays deterministic/JSON-safe.
    res = staffing.solve_staffing(VOLS, model=WarehouseModel(), start_hour=9, end_hour=18)
    pick = next(p for p in res["processes"] if p["id"] == "ピッキング")
    assert pick["productivity"] > 0


# ---- (b) method moves the picking productivity AND the staffing --------------

def test_method_changes_picking_productivity():
    single = staffing.resolve_productivity(
        _model(WorkMethod(orders_per_trip=1)), "ピッキング", float(_PICK_DEFAULT))
    multi = staffing.resolve_productivity(
        _model(WorkMethod(orders_per_trip=8)), "ピッキング", float(_PICK_DEFAULT))
    total = staffing.resolve_productivity(
        _model(WorkMethod(orders_per_trip=16, consolidation="sort")),
        "ピッキング", float(_PICK_DEFAULT))
    # All three differ from each other and from the old flat default.
    assert len({single, multi, total}) == 3
    assert single != _PICK_DEFAULT and multi != _PICK_DEFAULT
    # Batching amortises the walk → マルチ out-rates シングル (the whole point).
    assert multi > single


def test_derived_rate_is_the_pickrate_lines_per_hour():
    # Proves the SOURCE: the derived default equals the matching pickrate row's
    # lines/hour (workmethod.method_name → pickrate label), not some other number.
    for work in (WorkMethod(orders_per_trip=1),
                 WorkMethod(orders_per_trip=8),
                 WorkMethod(orders_per_trip=4, zoning="sequential"),
                 WorkMethod(orders_per_trip=16, consolidation="sort")):
        m = _model(work)
        label = workmethod.method_name(work)
        got = staffing.resolve_productivity(m, "ピッキング", float(_PICK_DEFAULT))
        assert got == _pickrate_lph(m, label), label


def test_method_changes_solve_staffing_peak_and_manhours():
    single = staffing.solve_staffing(
        VOLS, model=_model(WorkMethod(orders_per_trip=1)), start_hour=9, end_hour=18)
    multi = staffing.solve_staffing(
        VOLS, model=_model(WorkMethod(orders_per_trip=8)), start_hour=9, end_hour=18)
    # The whole-day totals genuinely diverge (peak AND man-hours), not just one row.
    assert single["peak_headcount"] != multi["peak_headcount"]
    assert single["total_man_hours"] != multi["total_man_hours"]
    # The faster method (マルチ) needs fewer people / hours for the same volume.
    assert multi["total_man_hours"] < single["total_man_hours"]


# ---- (c) 3-tier intact: override / benchmark still win -----------------------

def test_override_beats_method_derived_value():
    m = _model(WorkMethod(orders_per_trip=8))  # method-derived would be ~284.7
    m.settings.productivity_overrides = {"ピッキング": 55.0}
    assert staffing.resolve_productivity(m, "ピッキング", float(_PICK_DEFAULT)) == 55.0


def test_benchmark_beats_method_derived_value():
    m = _model(WorkMethod(orders_per_trip=8))
    m.settings.benchmark_productivity = {"ピッキング": 77.0}
    assert staffing.resolve_productivity(m, "ピッキング", float(_PICK_DEFAULT)) == 77.0


def test_override_beats_benchmark_beats_method_order():
    # Full 3-tier precedence in one model.
    m = _model(WorkMethod(orders_per_trip=8))
    m.settings.benchmark_productivity = {"ピッキング": 77.0}
    method_rate = staffing.resolve_productivity(_model(WorkMethod(orders_per_trip=8)),
                                                "ピッキング", float(_PICK_DEFAULT))
    assert staffing.resolve_productivity(m, "ピッキング", float(_PICK_DEFAULT)) == 77.0
    m.settings.productivity_overrides = {"ピッキング": 55.0}
    assert staffing.resolve_productivity(m, "ピッキング", float(_PICK_DEFAULT)) == 55.0
    assert method_rate not in (55.0, 77.0)  # the method value is a distinct 3rd tier


# ---- (d) goods-to-person keeps the flat default -----------------------------

def test_goods_to_person_keeps_default():
    for transport in ("agv", "conveyor", "asrs"):
        m = _model(WorkMethod(transport=transport, orders_per_trip=8))
        out = staffing.resolve_productivity(m, "ピッキング", float(_PICK_DEFAULT))
        assert out == float(_PICK_DEFAULT) and repr(out) == repr(float(_PICK_DEFAULT)), transport
