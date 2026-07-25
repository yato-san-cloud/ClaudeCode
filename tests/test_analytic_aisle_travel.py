"""解析↔DES の一致 — the analytic oracle prices AISLE-ROUTED travel.

The DES routes agents around the racking (``engine.graph`` registers every drawn
rack run as an obstacle). The closed-form oracle used to price travel as plain
Manhattan — straight through the shelves — so the "instant estimate" told a
systematically rosier story than the run that was supposed to confirm it. These
tests pin the model that closed that gap:

* the closed-form aisle detour (``rackgeom.aisle_detour``) against its hand
  derivation AND against the routing graph it stands in for,
* the analytic↔DES agreement on both bundled templates, and
* the never-blocks degradation to the historical Manhattan behaviour.
"""

import time

import pytest

from whsim import analytic, kpis, rackgeom, templates, workmethod
from whsim.engine.build import build
from whsim.engine.graph import AisleGraph
from whsim.engine.routing import manhattan
from whsim.engine.run import run_replications
from whsim.schema.model import (
    Bounds, Layout, Location, WarehouseModel, Zone,
)


# --------------------------------------------------------------- closed form

def _block_model(runs: int, run_len: float, depth: float = 1.5,
                 pitch: float = 4.0, y0: float = 2.0) -> WarehouseModel:
    """A bare model whose storage zone carries ``runs`` authored vertical shelves."""
    shelves = [{"x": 10.0 + i * pitch, "y": y0, "w": depth, "h": run_len}
               for i in range(runs)]
    zone = Zone(id="z", type="storage", x=8.0, y=0.0, w=runs * pitch + 8.0,
                h=run_len + 2 * y0, shelves=shelves)
    return WarehouseModel(layout=Layout(bounds=Bounds(width=120.0, depth=80.0),
                                        zones=[zone]))


def test_aisle_detour_matches_its_hand_derivation():
    m = _block_model(runs=6, run_len=30.0, y0=2.0)   # runs span y = 2 .. 32
    ell = 30.0

    # Depot facing the MIDDLE of the run band: the detour peaks at l/2.
    mid = rackgeom.aisle_detour(m, (0.0, 2.0 + ell / 2))
    assert mid["run_len_m"] == pytest.approx(ell)
    assert mid["n_aisles"] == 6
    assert mid["depot_extra_m"] == pytest.approx(ell / 2)
    # A slot-to-slot hop that changes aisle costs l/3 whatever the depot does.
    assert mid["hop_extra_m"] == pytest.approx(ell / 3)

    # Depot facing a run END (or anywhere beyond it): nothing to detour around.
    for q in (2.0, 32.0, -50.0, 500.0):
        assert rackgeom.aisle_detour(m, (0.0, q))["depot_extra_m"] == pytest.approx(0.0)

    # ...and it grows smoothly in between (2·d·(l-d)/l at d = l/4).
    quarter = rackgeom.aisle_detour(m, (0.0, 2.0 + ell / 4))
    assert quarter["depot_extra_m"] == pytest.approx(3.0 * ell / 8)


def test_aisle_detour_reads_horizontal_runs_too():
    """Runs laid along x must be measured along x — orientation by majority."""
    shelves = [{"x": 5.0, "y": 10.0 + i * 4.0, "w": 40.0, "h": 1.2} for i in range(4)]
    zone = Zone(id="z", type="storage", x=0.0, y=0.0, w=60.0, h=40.0, shelves=shelves)
    m = WarehouseModel(layout=Layout(bounds=Bounds(width=60.0, depth=40.0), zones=[zone]))
    det = rackgeom.aisle_detour(m, (5.0 + 20.0, 0.0))
    assert det["axis"] == "x"
    assert det["run_len_m"] == pytest.approx(40.0)
    assert det["n_aisles"] == 4
    assert det["depot_extra_m"] == pytest.approx(20.0)     # depot faces mid-run


def test_aisle_detour_is_none_without_racking():
    """No drawn racking ⇒ nothing to route around ⇒ the caller keeps Manhattan."""
    assert rackgeom.aisle_detour(WarehouseModel(), (0.0, 0.0)) is None
    empty = WarehouseModel(layout=Layout(bounds=Bounds(width=40.0, depth=20.0),
                                         zones=[Zone(id="z", type="storage",
                                                     x=0.0, y=0.0, w=10.0, h=10.0)]))
    assert rackgeom.aisle_detour(empty, (0.0, 0.0)) is None


@pytest.mark.parametrize("template_id", ["ecommerce_small", "retail_dc"])
def test_closed_form_depot_detour_agrees_with_the_routing_graph(template_id):
    """The closed form must reproduce what the DES's own router measures.

    ``rackgeom.aisle_detour`` exists to avoid paying for a graph build + Dijkstra
    on the live path, so it only earns its place if it lands on the same answer:
    the mean depot→slot distance the ``AisleGraph`` actually walks.
    """
    m = templates.load_template_model(template_id)
    station = m.resources.stations[0]
    depot = (station.x, station.y)

    det = rackgeom.aisle_detour(m, depot)
    closed_form = (sum(manhattan(depot, (loc.x, loc.y)) for loc in m.locations)
                   / len(m.locations)) + det["depot_extra_m"]

    g = AisleGraph.from_model(m)
    assert g.enabled, "the racking must be routed around at all"
    routed = sum(g.distance(depot, (loc.x, loc.y)) for loc in m.locations) / len(m.locations)
    assert g.unroutable_count == 0
    assert closed_form == pytest.approx(routed, rel=0.10)


# --------------------------------------------------------- analytic <-> DES

@pytest.mark.parametrize("template_id", ["ecommerce_small", "retail_dc"])
def test_analytic_converges_with_the_des_on_both_templates(template_id):
    """The 「解析で当てる → DESで裏取り」 contract, pinned.

    A full shift is simulated (the template default) rather than a short window:
    utilisation over one hour of a handful of pickers is dominated by arrival
    noise and truncated mid-trips, which would make any tight bound flaky.
    """
    m = templates.load_template_model(template_id)
    est = analytic.estimate(m)
    results, _ = run_replications(m)
    sim = kpis.compute(results)

    assert abs(est["picker_utilization"] - sim["picker_utilization"]) < 0.08
    # The metres are the mechanism, so pin them directly too.
    assert est["walk_m_per_order"] == pytest.approx(sim["walk_per_order_m"], rel=0.20)
    # ...and the two must tell the same story about coping with demand.
    assert est["overloaded"] == (sim["picker_utilization"] > 0.99)


def test_analytic_travel_is_far_above_the_straight_line_distance():
    """Sanity on the direction: routing around racks can only ADD metres."""
    m = templates.load_template_model("ecommerce_small")
    station = m.resources.stations[0]
    depot = (station.x, station.y)
    straight = sum(manhattan(depot, (loc.x, loc.y)) for loc in m.locations) / len(m.locations)
    est = analytic.estimate(m)
    lines = m.orders.profile.lines_per_order_mean
    # Out-and-back alone would be 2·straight under Manhattan; the aisle network
    # makes even the per-order total materially larger than that.
    assert est["walk_m_per_order"] > 2.0 * straight
    assert est["walk_m_per_order"] < 2.0 * straight * (1.0 + lines)   # still sane


def test_batching_amortises_the_trip_over_its_orders():
    """A trip that sweeps several orders walks fewer metres per order."""
    single = templates.load_template_model("retail_dc")
    single.process.batch_size = 1
    single.process.pick_strategy = "discrete"
    batched = templates.load_template_model("retail_dc")
    assert (analytic.estimate(batched)["walk_m_per_order"]
            < analytic.estimate(single)["walk_m_per_order"])
    assert analytic.estimate(single)["orders_per_trip"] == 1.0


def test_orders_per_trip_is_the_engine_s_own_resolution():
    """The oracle must amortise over exactly the batch the DES sweeps."""
    for tid in ("ecommerce_small", "retail_dc"):
        m = templates.load_template_model(tid)
        assert workmethod.orders_per_trip(m) == build(m).batch_size


# ------------------------------------------------------------- never blocks

def test_analytic_falls_back_to_manhattan_without_a_layout():
    """No racking ⇒ the historical straight-line model, verbatim. Never blocks."""
    m = WarehouseModel()
    assert rackgeom.aisle_detour(m, (0.0, 0.0)) is None, "nothing drawn to route around"
    est = analytic.estimate(m)

    speed = max(m.process.walk_speed_mps, 0.1)
    lines = max(m.orders.profile.lines_per_order_mean, 1.0)
    avg = (m.layout.bounds.width + m.layout.bounds.depth) / 4
    travel = 2 * avg + max(lines - 1, 0) * avg * 0.3
    expected = travel / speed + lines * 1.5 * 2.0 + m.process.pack_time_s

    assert est["orders_per_trip"] == 1.0
    assert est["walk_m_per_order"] == pytest.approx(travel)
    assert est["service_time_s"] == pytest.approx(expected)
    assert 0.0 <= est["picker_utilization"] <= 1.0


def test_materialized_racks_lengthen_travel_versus_an_empty_floor():
    """The same demand on a floor WITH drawn racking must walk further."""
    bare = WarehouseModel()
    bare.locations = [Location(id=f"L{i}", x=10.0 + i, y=4.0) for i in range(6)]
    racked = _block_model(runs=6, run_len=30.0)
    racked.locations = list(bare.locations)
    assert (analytic.estimate(racked)["walk_m_per_order"]
            > analytic.estimate(bare)["walk_m_per_order"])


def test_analytic_never_blocks_on_a_bare_model():
    est = analytic.estimate(WarehouseModel())
    assert est["method"] == "analytic_mmc"
    assert est["service_time_s"] > 0
    assert est["walk_m_per_order"] >= 0


def test_analytic_stays_fast_enough_for_live_re_estimation():
    """The oracle is the 爆速 path (drag-time scorecard); it must not route.

    Building the routing graph for retail_dc alone costs ~70 ms before a single
    Dijkstra, which is why the aisle detour is closed form. A regression that
    reintroduced a graph search would blow straight past this bound.
    """
    m = templates.load_template_model("retail_dc")
    analytic.estimate(m)                       # warm caches / lazy imports
    best = min(_timed(m) for _ in range(5))
    assert best < 0.05, f"analytic.estimate took {best * 1000:.1f} ms"


def _timed(m) -> float:
    t0 = time.perf_counter()
    analytic.estimate(m)
    return time.perf_counter() - t0
