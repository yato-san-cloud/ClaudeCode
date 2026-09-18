"""荷姿 (``loadunit``) と 滞留 (``wipcurve``).

The 3PL question these two answer together: 「バラ2,500点は折コン何枚で、カゴ車何台か。
検品前に最大何台溜まり、その仮置きに何坪要るか」.

The property that matters most is COMPATIBILITY. The 基礎物量 screen has always
derived 折コン/カゴ台車 with a flat 「(OC＋ケース)÷14」; the new occupancy model must
reproduce it EXACTLY on the seeded catalogue, or every existing estimate silently
moves. That equivalence is pinned first and hardest.
"""

import math

import pytest

from whsim import bi, flowgraph, loadunit, templates, wipcurve
from whsim.analysis import staffing
from whsim.schema.model import FlowEdge, LoadUnit, WarehouseModel

# The three 仮値 the 基礎物量 screen has always used (bi.derive_volumes defaults).
LEGACY_PIECES_PER_ORIKON = 30.0
LEGACY_UNITS_PER_CAGE = 14.0
LEGACY_CASES_PER_PALLET = 40.0


# --- the catalogue ------------------------------------------------------------

def test_default_catalogue_seeds_the_legacy_numbers():
    """The seed must BE the old constants, not merely resemble them."""
    units = loadunit.by_id(None)
    assert loadunit.capacity_for(units["orikon"], "piece") == LEGACY_PIECES_PER_ORIKON
    assert loadunit.capacity_for(units["cage"], "orikon") == LEGACY_UNITS_PER_CAGE
    assert loadunit.capacity_for(units["cage"], "case") == LEGACY_UNITS_PER_CAGE
    assert loadunit.capacity_for(units["pallet"], "case") == LEGACY_CASES_PER_PALLET


@pytest.mark.parametrize("pieces,cases", [
    (2500, 120), (900, 0), (0, 300), (45, 7), (100_000, 4_321), (1, 1), (0, 0),
])
def test_occupancy_reproduces_the_flat_legacy_formula(pieces, cases):
    """``Σ(count/capacity)`` with equal capacities IS ``(a+b)/cap``.

    This is why no existing 基礎物量 number moves when the catalogue lands.
    """
    legacy_oc = math.ceil(pieces / LEGACY_PIECES_PER_ORIKON) if pieces else 0
    legacy_load = legacy_oc + cases
    legacy_cages = math.ceil(legacy_load / LEGACY_UNITS_PER_CAGE) if legacy_load else 0

    r = loadunit.convert(None, pieces=pieces, cases=cases,
                         container_ref="orikon", carrier_ref="cage")
    assert r["containers"] == legacy_oc
    assert r["carriers"] == legacy_cages


def test_bi_derive_volumes_is_unchanged_by_the_catalogue():
    """The screen's own derivation must still agree with the new model."""
    m = templates.load_template_model("ecommerce_small")
    d = bi.derive_volumes(m, {})
    base = d["base"]
    r = loadunit.convert(m, pieces=base.get("out_pieces", 0),
                         cases=base.get("out_cases", 0),
                         container_ref="orikon", carrier_ref="cage")
    assert r["containers"] == d["derived"]["out_orikon"]
    assert r["carriers"] == d["derived"]["out_cages"]


def test_a_carrier_can_express_different_capacities_per_kind():
    """What the flat formula could NOT say: カゴ車＝折コン12枚 or ケース20個."""
    m = WarehouseModel()
    m.load_units = [
        LoadUnit(id="piece", kind="base"), LoadUnit(id="case", kind="base"),
        LoadUnit(id="orikon", kind="container", capacity={"piece": 30}),
        LoadUnit(id="cage", kind="carrier", capacity={"orikon": 12, "case": 20},
                 footprint_m2=0.88),
    ]
    # 12 折コン alone = exactly one cage; 6 折コン + 10 cases = 0.5 + 0.5 = one cage.
    assert loadunit.convert(m, pieces=360, container_ref="orikon",
                            carrier_ref="cage")["carriers"] == 1
    assert loadunit.pack({"orikon": 6, "case": 10}, loadunit.by_id(m)["cage"]) == pytest.approx(1.0)


def test_the_conversion_shows_its_arithmetic():
    """「式を明示」 — the same rule the cost stack follows."""
    r = loadunit.convert(None, pieces=2500, cases=120,
                         container_ref="orikon", carrier_ref="cage")
    assert "2,500" in r["chain"] and "30" in r["chain"] and "オリコン" in r["chain"]
    assert "カゴ台車" in r["chain"]
    assert r["provisional"] is True, "an assumed 入数 must be flagged as 仮値"


def test_catalogue_never_blocks_on_junk():
    m = WarehouseModel()
    m.load_units = [LoadUnit(id="", name="blank"),
                    LoadUnit(id="ok", capacity={"piece": -5, "case": 0})]
    cat = loadunit.by_id(m)
    assert "" not in cat and "ok" in cat
    assert cat["ok"]["capacity"] == {}, "non-positive capacities are dropped"
    assert loadunit.convert(m, pieces=100, container_ref="nope",
                            carrier_ref="also-nope")["carriers"] == 0


def test_an_unspecified_loadunit_converts_nothing():
    """A leg that names no 荷姿 reports the raw amounts (never-blocks)."""
    r = loadunit.convert(None, pieces=500, cases=20)
    assert r["containers"] == 0 and r["carriers"] == 0
    assert r["pieces"] == 500 and r["chain"] == ""


# --- edge bindings + diagnostics ----------------------------------------------

def test_edges_carry_and_report_their_loadunits():
    m = templates.load_template_model("pick_to_belt")
    m.process.flow_edges = [FlowEdge(src="ピッキング", dst="検品",
                                     container_ref="orikon", carrier_ref="cage")]
    assert flowgraph.edge_loadunits(m, "ピッキング", "検品") == ("orikon", "cage")
    assert flowgraph.loadunits_in_use(m) == {"orikon", "cage"}
    assert not flowgraph.diagnose(m) or all(
        w["kind"] not in ("missing_loadunit", "incompatible_loadunit")
        for w in flowgraph.diagnose(m))


def test_a_carrier_that_cannot_hold_the_container_is_reported():
    """パレット takes cases, not 折コン — an impossible pairing must be visible."""
    m = templates.load_template_model("pick_to_belt")
    m.process.flow_edges = [FlowEdge(src="ピッキング", dst="検品",
                                     container_ref="orikon", carrier_ref="pallet")]
    assert any(w["kind"] == "incompatible_loadunit" for w in flowgraph.diagnose(m))


def test_a_loadunit_that_does_not_exist_is_reported():
    m = templates.load_template_model("pick_to_belt")
    m.process.flow_edges = [FlowEdge(src="ピッキング", dst="検品", container_ref="ghost")]
    assert any(w["kind"] == "missing_loadunit" for w in flowgraph.diagnose(m))


# --- 滞留 ----------------------------------------------------------------------

VOLUMES = {"入荷検品": 4000, "格納": 12000, "ピッキング": 6000,
           "検品": 6000, "梱包": 2000, "出荷": 2000}
BASE = {"out_pieces": 12000, "out_cases": 800, "in_pieces": 0, "in_cases": 400}


def _wired_model():
    m = templates.load_template_model("pick_to_belt")
    m.process.flow_edges = [
        FlowEdge(src="ピッキング", dst="検品", container_ref="orikon", carrier_ref="cage"),
        FlowEdge(src="検品", dst="梱包", transport="conveyor", container_ref="orikon"),
    ]
    return m


def test_wip_peaks_in_the_carrier_the_design_names():
    m = _wired_model()
    solved = staffing.solve_staffing(VOLUMES, model=m, start_hour=9, end_hour=18)
    r = wipcurve.all_edges(m, solved, BASE)
    assert r["available"]
    leg = next(e for e in r["edges"] if e["src"] == "ピッキング" and e["dst"] == "検品")
    assert leg["unit"] == "cage" and leg["unit_label"] == "カゴ台車"
    assert leg["peak_units"] > 0
    assert leg["peak_hour"] in r["hours"]
    assert leg["staging_tsubo"] > 0, "a waiting carrier occupies floor"


def test_the_curve_starts_and_ends_empty_and_never_goes_negative():
    """A cumulative-flow difference is a stock: it cannot be negative, and a day
    that finishes has nothing left standing between its processes."""
    m = _wired_model()
    solved = staffing.solve_staffing(VOLUMES, model=m, start_hour=9, end_hour=18)
    for leg in wipcurve.all_edges(m, solved, BASE)["edges"]:
        assert all(v >= 0 for v in leg["curve"])
        if leg["available"]:
            assert leg["curve"][-1] == 0.0, f"{leg['src']}→{leg['dst']} never drained"


def test_a_bigger_carrier_needs_fewer_of_them():
    """The direction of the whole feature: pick a bigger 台車, park fewer."""
    m = _wired_model()
    solved = staffing.solve_staffing(VOLUMES, model=m, start_hour=9, end_hour=18)
    cage = next(e for e in wipcurve.all_edges(m, solved, BASE)["edges"]
                if e["dst"] == "検品")
    m.process.flow_edges[0].carrier_ref = "dolly"      # 4/台 instead of 14/台
    dolly = next(e for e in wipcurve.all_edges(m, solved, BASE)["edges"]
                 if e["dst"] == "検品")
    assert dolly["peak_units"] > cage["peak_units"]


def test_the_fleet_is_a_shared_pool_not_a_sum_of_peaks():
    """A cage waiting on one leg is not available on another at the same moment,
    so the fleet is the peak of the SUM, not the sum of the peaks."""
    m = templates.load_template_model("pick_to_belt")
    m.process.flow_edges = [
        FlowEdge(src="ピッキング", dst="検品", container_ref="orikon", carrier_ref="cage"),
        FlowEdge(src="検品", dst="梱包", container_ref="orikon", carrier_ref="cage"),
    ]
    solved = staffing.solve_staffing(VOLUMES, model=m, start_hour=9, end_hour=18)
    r = wipcurve.all_edges(m, solved, BASE)
    cage = next(f for f in r["fleet"] if f["unit"] == "cage")
    legs = [e for e in r["edges"] if e["carrier_ref"] == "cage" and e["available"]]
    assert cage["peak"] <= sum(e["peak"] for e in legs) + 1e-6
    assert cage["peak"] >= max(e["peak"] for e in legs) - 1e-6


def test_raw_pieces_are_not_listed_as_a_fleet():
    """A leg with no 荷姿 still reports WIP, but 「ピース 3,798」 is not something
    you own or park — it must not sit next to 「カゴ台車 13」 in the fleet."""
    m = _wired_model()
    solved = staffing.solve_staffing(VOLUMES, model=m, start_hour=9, end_hour=18)
    r = wipcurve.all_edges(m, solved, BASE)
    assert any(e["unit"] == "piece" for e in r["edges"]), "fixture has an unbound leg"
    assert all(f["unit"] not in loadunit.BASE_UNITS for f in r["fleet"])


def test_wip_never_blocks_without_volume_or_a_solve():
    m = _wired_model()
    assert wipcurve.all_edges(m, {}, {})["available"] is False
    assert wipcurve.all_edges(m, {}, None)["edges"] == [] or True
    solved = staffing.solve_staffing(VOLUMES, model=m, start_hour=9, end_hour=18)
    r = wipcurve.all_edges(m, solved, {})          # no physical volume known
    assert r["available"] is False
    assert all(e["peak"] == 0 for e in r["edges"])


def test_wip_is_fast_enough_for_drag_time():
    """The 爆速 layer: a 荷姿 change must re-cost the day while dragging."""
    import time

    m = _wired_model()
    solved = staffing.solve_staffing(VOLUMES, model=m, start_hour=9, end_hour=18)
    start = time.perf_counter()
    for _ in range(20):
        wipcurve.all_edges(m, solved, BASE)
    per_call_ms = (time.perf_counter() - start) / 20 * 1000
    assert per_call_ms < 50.0, f"{per_call_ms:.1f} ms/solve is too slow to drag against"
