"""本格DES validation for the 入荷検品(inbound inspection) stage — dedicated
inspector agents between inbound receipts and forklift putaway."""

from whsim import kpis
from whsim.engine.run import run_once
from whsim.render.replay import build_replay
from whsim.schema.model import Equipment
from whsim.templates import load_template_model


def _model(inspectors=0, inspect_s=15.0, forklifts=2):
    m = load_template_model("ecommerce_small")
    if forklifts:
        m.resources.equipment.append(
            Equipment(id="fk", type="forklift", x=6, y=25, count=forklifts, speed_mps=2.0))
    m.process.inspector_count = inspectors
    m.process.inbound_inspection_time_s = inspect_s
    m.simulation.duration_s = 3600
    m.simulation.replications = 1
    return m


def test_disabled_is_legacy():
    """inspector_count=0: receipts go straight to putaway — no inspector agents,
    no inspect events (existing inbound behaviour is unchanged)."""
    res = run_once(_model(inspectors=0))
    assert res.inspectors == []
    assert not any(e["event"] == "inspect_done" for e in res.events)


def test_dedicated_inspectors_when_enabled():
    res = run_once(_model(inspectors=2))
    k = kpis.compute([res], None)
    assert len(res.inspectors) == 2
    assert any(e["event"] == "inspect_done" for e in res.events)
    assert k["inspector_utilization"] > 0
    assert k["n_inspectors"] == 2


def test_inspectors_render_in_replay():
    res = run_once(_model(inspectors=2))
    rep = build_replay(_model(inspectors=2), res, {})
    inspectors = [w for w in rep["workers"] if w["role"] == "inspector"]
    assert inspectors
    assert any(kf[3] == "inspect" for w in inspectors for kf in w["keyframes"])


def test_inbound_conservation():
    """Every inbound receipt that is inspected is handed to forklift putaway —
    nothing is lost in the inspection stage."""
    res = run_once(_model(inspectors=2))
    inspected = sum(1 for e in res.events if e["event"] == "inspect_done")
    put_away = sum(1 for e in res.events if e["event"] == "forklift_done")
    # forklifts drain what inspectors release; in-flight bounded by the pipeline.
    assert inspected >= put_away >= 0
    assert inspected - put_away <= res.n_inspectors + 2 + 5


def test_deterministic():
    a = kpis.compute([run_once(_model(inspectors=2))], None)
    b = kpis.compute([run_once(_model(inspectors=2))], None)
    assert a["inspector_utilization"] == b["inspector_utilization"]
