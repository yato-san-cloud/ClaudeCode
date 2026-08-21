"""Simulation rigor: conveyor DES (transport + jam) and Monte-Carlo robustness."""

from whsim import kpis, templates
from whsim.engine.run import run_once, run_replications
from whsim.schema.model import Conveyor


def test_conveyor_jam_backs_up_and_limits_throughput():
    """A slow downstream (1 pack station, long pack time) must make the conveyor
    accumulate and depress completion -- i.e. blocking propagates upstream."""
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 7200
    m.resources.conveyors = [Conveyor(id="c1", points=[[12, 15], [40, 15]], speed_mps=0.5)]
    m.resources.stations[0].count = 1
    m.process.pack_time_s = 120  # deliberately slow pack -> jam
    # Declare the design intent the belt implies: goods reach packing on the
    # conveyor. Drawing a belt alone no longer routes work onto it (flowgraph.py).
    for _st in m.process.stages:
        if _st.id == "pack":
            _st.method = "conveyor"

    res = run_once(m)
    arrived = sum(1 for e in res.events if e["event"] == "order_arrive")
    completed = sum(1 for e in res.events if e["event"] == "order_complete")
    on_belt = sum(1 for e in res.events if e["event"] == "conveyor_on")
    assert on_belt > 0                       # totes did go onto the conveyor
    assert completed < arrived * 0.8         # jam prevented most completions


def test_monte_carlo_surfaces_variability():
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 7200
    results, _heat = run_replications(m, reps=8)
    assert len(results) == 8
    k = kpis.compute(results)
    assert k["replications"] == 8
    assert 0.0 <= k["robustness"] <= 1.0
    # percentile band is present and ordered
    assert k["throughput_p5"] <= k["throughput_per_hr"] + 1e-6
    assert k["throughput_per_hr"] <= k["throughput_p95"] + 1e-6
    # only the first replication carries the (expensive) animated replay
    assert results[0].workers and len(results[0].workers[0].keyframes) > 10
    assert len(results[1].workers[0].keyframes) <= 1
