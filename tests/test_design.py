"""Design-side: parametric racks regenerate locations; work method changes KPIs."""

from whsim import kpis, templates
from whsim.design import materialize_racks
from whsim.engine.run import run_once
from whsim.schema.model import Equipment


def test_rack_spacing_changes_location_count():
    m = templates.load_template_model("ecommerce_small")
    storage = next(z for z in m.layout.zones if z.id == "storage")
    storage.rack.col_spacing = 3.0
    storage.rack.row_spacing = 2.0
    materialize_racks(m)
    dense = len(m.locations)

    m2 = templates.load_template_model("ecommerce_small")
    s2 = next(z for z in m2.layout.zones if z.id == "storage")
    s2.rack.col_spacing = 8.0
    s2.rack.row_spacing = 6.0
    materialize_racks(m2)
    sparse = len(m2.locations)

    assert dense > sparse  # tighter spacing => more slots
    # every item is pegged to a real, regenerated location
    ids = {loc.id for loc in m.locations}
    assert all(it.default_location in ids for it in m.items)


def test_agv_method_frees_pickers_and_shifts_bottleneck():
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 1800
    manual = kpis.compute([run_once(m)])

    for s in m.process.stages:
        if s.id == "pick":
            s.method = "agv"
    m.resources.equipment = [Equipment(id="agv1", type="agv", count=10,
                                        speed_mps=1.6, x=6, y=15)]
    agv = kpis.compute([run_once(m)])

    # AGVs do the travel, so picker labour drops sharply...
    assert agv["picker_utilization"] < manual["picker_utilization"]
    # ...and the AGV fleet is now a tracked resource.
    assert agv["n_agvs"] == 10
    assert agv["agv_utilization"] > 0.0
