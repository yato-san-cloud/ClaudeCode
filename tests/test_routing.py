"""Wall-aware graph routing and measured-distance import."""

from whsim import distances, kpis, templates
from whsim.engine.graph import AisleGraph
from whsim.engine.run import run_once
from whsim.schema.model import Wall


def test_graph_routes_around_walls():
    g = AisleGraph.from_layout(
        {"width": 30.0, "depth": 20.0},
        [{"points": [[15, 0], [15, 17]], "thickness": 0.3}],  # wall with a gap at top
        resolution=1.0,
    )
    assert g.enabled
    straight = 20.0  # Manhattan between (5,10) and (25,10)
    assert g.distance((5, 10), (25, 10)) > straight + 5  # must detour around the wall


def test_walls_increase_picker_travel():
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 3600
    base = kpis.compute([run_once(m)])["walk_per_order_m"]
    m.layout.walls = [Wall(id="w", points=[[34, 2], [34, 28]], thickness=0.3)]
    walled = kpis.compute([run_once(m)])["walk_per_order_m"]
    assert walled > base  # detouring around the internal wall lengthens routes


def test_distance_import_and_override_applied():
    csv = b"from,to,distance\nL0000,L0001,99.0\n"
    res = distances.import_distance_matrix_bytes(csv, "d.csv")
    assert res["count"] >= 1
    assert distances.lookup(res["pairs"], "L0000", "L0001") == 99.0
    # reverse direction inferred
    assert distances.lookup(res["pairs"], "L0001", "L0000") == 99.0
