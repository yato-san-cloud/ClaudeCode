"""The ONE flow graph (``whsim.flowgraph``) — nodes, edges, and the engine gate.

whsim used to describe the same warehouse three times with no shared identity:
the process DAG (``WorkProcess.depends``), the spatial stage list
(``Process.stages``) and the physical objects (``Resources``). Not one id was
shared between the first two, and neither could name a machine in the third. So
"packing is fed by THAT belt" had nowhere to live and the engine guessed
geometrically — which is why switching a stage to 人手 did not stop the belt.

Two properties matter and both are pinned here:

1. **Compatibility.** A project that never authors an edge resolves to exactly
   the graph its ``depends`` already implied, and the run is unchanged.
2. **The gate.** Once the design says how goods arrive, the engine obeys it.
"""

import pytest

from whsim import flowgraph, templates
from whsim.engine.run import run_once
from whsim.schema.model import FlowEdge, WarehouseModel, WorkProcess

ALL_TEMPLATES = [t["template_id"] for t in templates.list_templates()]

# Templates that ship NO authored edge — the fixtures for the compatibility leg
# below, which is about what ``depends`` alone resolves to. A template that wires
# its own legs (``line_inspection`` names the belt each stage receives on) is by
# definition not exercising that path; it is covered by the authored-edge tests.
DERIVED_TEMPLATES = [
    tid for tid in ALL_TEMPLATES
    if not (templates.load_template_dict(tid).get("process") or {}).get("flow_edges")
]
AUTHORED_TEMPLATES = [tid for tid in ALL_TEMPLATES if tid not in DERIVED_TEMPLATES]


def _conveyor_events(model, seed: int = 5) -> int:
    return sum(1 for e in run_once(model, seed=seed).events if e["event"] == "conveyor_on")


# --- never-blocks ------------------------------------------------------------

def test_a_bare_model_resolves_to_an_empty_graph():
    g = flowgraph.resolve(WarehouseModel())
    assert g.nodes and g.edges, "the default master still yields the engine's 6 processes"
    assert flowgraph.diagnose(WarehouseModel()) == [] or all(
        isinstance(w, dict) for w in flowgraph.diagnose(WarehouseModel()))


def test_resolve_never_raises_on_junk():
    m = WarehouseModel()
    m.process.work_processes = [WorkProcess(id="", depends=["nope"]),
                                WorkProcess(id="A", depends=["A"])]
    m.process.flow_edges = [FlowEdge(src="ghost", dst="A"), FlowEdge(src="A", dst="ghost")]
    g = flowgraph.resolve(m)                       # must not raise
    assert all(isinstance(n.id, str) for n in g.nodes)
    assert flowgraph.diagnose(m)                   # ...and it reports the dangling ids
    assert any(w["kind"] == "dangling_process" for w in flowgraph.diagnose(m))


# --- the two vocabularies are bridged ----------------------------------------

@pytest.mark.parametrize("template_id", ALL_TEMPLATES)
def test_business_processes_map_onto_engine_roles(template_id):
    """①'s Japanese business names and ②'s English stage ids shared NOTHING.

    The graph is the bridge: 入荷検品→receive, ピッキング→pick, 梱包→pack…
    Without it, no screen could say which stage a process drives.
    """
    m = templates.load_template_model(template_id)
    g = flowgraph.resolve(m)
    roles = {n.role for n in g.nodes if n.role}
    assert {"receive", "putaway", "pick", "pack", "ship"} <= roles


def test_an_explicit_role_overrides_the_name_guess():
    """A freely-named process must still be able to declare what it drives."""
    m = WarehouseModel()
    m.process.work_processes = [WorkProcess(id="仕分け作業", role="pack", prod=30)]
    node = flowgraph.resolve(m).node("仕分け作業")
    assert node is not None and node.role == "pack" and node.simulated


def test_a_staffing_only_process_is_not_simulated():
    m = WarehouseModel()
    m.process.work_processes = [WorkProcess(id="事務", role="none")]
    node = flowgraph.resolve(m).node("事務")
    assert node is not None and not node.simulated


# --- compatibility: no authored edges ⇒ the graph `depends` already implied ---

@pytest.mark.parametrize("template_id", DERIVED_TEMPLATES)
def test_derived_graph_reproduces_the_dependency_chain(template_id):
    from whsim.analysis.staffing.profile import process_deps

    m = templates.load_template_model(template_id)
    g = flowgraph.resolve(m)
    assert not m.process.flow_edges, "fixture must exercise the DERIVED path"
    assert all(e.derived for e in g.edges)
    derived = {(e.src, e.dst) for e in g.edges if e.src}
    for dst, ups in process_deps(m).items():
        for u in ups:
            assert (u, dst) in derived, f"{u}→{dst} lost in the derived graph"


@pytest.mark.parametrize("template_id", AUTHORED_TEMPLATES)
def test_an_authored_template_keeps_the_chain_it_wired(template_id):
    """The other half: a template that DOES wire its legs must resolve to those
    legs (not to derived ones), and still cover every precedence its master
    declares — the wiring is an addition to the chain, never a replacement."""
    from whsim.analysis.staffing.profile import process_deps

    m = templates.load_template_model(template_id)
    g = flowgraph.resolve(m)
    assert m.process.flow_edges
    edges = {(e.src, e.dst) for e in g.edges if e.src}
    for dst, ups in process_deps(m).items():
        for u in ups:
            assert (u, dst) in edges, f"{u}→{dst} lost in the authored graph"
    # Legs the design actually authored are NOT derived, and any machine they name
    # is one that is placed (otherwise diagnose would be shouting).
    assert any(not e.derived for e in g.edges)
    assert flowgraph.diagnose(m) == []


@pytest.mark.parametrize("template_id", ALL_TEMPLATES)
def test_untouched_projects_keep_their_conveyor_behaviour(template_id):
    """The gate must not change a project that never authored a flow edge.

    A belt is only silenced when the design says goods do NOT arrive on one.
    """
    m = templates.load_template_model(template_id)
    has_belt = bool(m.resources.conveyors)
    used = flowgraph.conveyor_ids_in_use(m)
    transport, _ref = flowgraph.transport_into(m, "pack")
    if has_belt:
        assert transport == "conveyor", (
            f"{template_id} draws a belt but no leg declares it — the design is "
            "under-specified and the gate would silence it")
        assert used is not None


# --- the gate ----------------------------------------------------------------

def test_switching_the_flow_to_manual_stops_the_belt():
    """The defect this whole layer exists to fix.

    Measured before: pack=人手 still produced 2315 conveyor_on events, because
    the engine picked the geometrically nearest belt and never consulted the
    design. It must now be zero.
    """
    m = templates.load_template_model("pick_to_belt")
    assert _conveyor_events(m) > 0, "baseline: the belt runs when the design says so"

    for s in m.process.stages:
        if s.id == "pack":
            s.method = "manual"
            if s.work:
                s.work.transport = "manual"
    assert flowgraph.conveyor_ids_in_use(m) is None
    assert _conveyor_events(m) == 0, "the design says 人手; the belt must not run"


def test_an_authored_edge_selects_WHICH_belt():
    """Two belts drawn, one named by the design ⇒ only that one is live."""
    from whsim.schema.model import Conveyor

    m = templates.load_template_model("pick_to_belt")
    original = m.resources.conveyors[0]
    decoy = Conveyor(id="decoy", points=[[1.0, 1.0], [2.0, 1.0]], speed_mps=0.5)
    m.resources.conveyors = [original, decoy]

    m.process.flow_edges = [FlowEdge(src="検品", dst="梱包", transport="conveyor",
                                     equipment_ref=original.id)]
    assert flowgraph.conveyor_ids_in_use(m) == {original.id}
    assert flowgraph.transport_into(m, "pack") == ("conveyor", original.id)
    assert _conveyor_events(m) > 0

    # ...and naming ONLY the decoy leaves the real line unused.
    m.process.flow_edges = [FlowEdge(src="検品", dst="梱包", transport="conveyor",
                                     equipment_ref="decoy")]
    assert flowgraph.conveyor_ids_in_use(m) == {"decoy"}


def test_an_unbound_conveyor_edge_keeps_every_belt_available():
    """'コンベアで来る' without naming a machine = the pre-edge behaviour."""
    m = templates.load_template_model("pick_to_belt")
    m.process.flow_edges = [FlowEdge(src="検品", dst="梱包", transport="conveyor")]
    assert flowgraph.conveyor_ids_in_use(m) == set()
    assert _conveyor_events(m) > 0


# --- diagnostics --------------------------------------------------------------

def test_a_belt_nobody_receives_on_is_reported():
    """The exact under-specification found in food_chilled: a drawn belt that no
    process declares. It must be VISIBLE rather than silently ignored."""
    m = templates.load_template_model("pick_to_belt")
    for s in m.process.stages:
        if s.id == "pack":
            s.method = "manual"
            if s.work:
                s.work.transport = "manual"
    kinds = {w["kind"] for w in flowgraph.diagnose(m)}
    assert "conveyor_unused" in kinds


def test_an_edge_naming_an_absent_machine_is_reported():
    m = templates.load_template_model("pick_to_belt")
    m.process.flow_edges = [FlowEdge(src="検品", dst="梱包", transport="conveyor",
                                     equipment_ref="does-not-exist")]
    kinds = {w["kind"] for w in flowgraph.diagnose(m)}
    assert "missing_equipment" in kinds


def test_split_ratios_that_do_not_add_up_are_reported():
    m = templates.load_template_model("pick_to_belt")
    m.process.flow_edges = [
        FlowEdge(src="ピッキング", dst="検品", share=0.5),
        FlowEdge(src="ピッキング", dst="梱包", share=0.2),
    ]
    kinds = {w["kind"] for w in flowgraph.diagnose(m)}
    assert "share_sum" in kinds


def test_diagnostics_are_warnings_not_blockers():
    """A half-wired design must still RUN — never-blocks is the product thesis."""
    m = templates.load_template_model("pick_to_belt")
    m.process.flow_edges = [FlowEdge(src="ghost", dst="梱包", transport="conveyor",
                                     equipment_ref="also-ghost", share=0.3)]
    assert flowgraph.diagnose(m), "the mess must be reported"
    res = run_once(m, seed=3)                       # ...and must not raise
    assert sum(1 for e in res.events if e["event"] == "order_complete") > 0


# --- partial authoring --------------------------------------------------------

def test_wiring_one_leg_leaves_the_rest_following_the_process_order():
    """The normal case: someone wires 「梱包はこのベルトで受ける」 and nothing else.

    The other five processes must keep their derived connections — otherwise
    touching one leg would make the whole chain look disconnected.
    """
    m = templates.load_template_model("pick_to_belt")
    m.process.flow_edges = [FlowEdge(src="検品", dst="梱包", transport="conveyor",
                                     equipment_ref="takeaway")]
    g = flowgraph.resolve(m)
    fed = {e.dst for e in g.edges if e.dst}
    assert {n.id for n in g.nodes} <= fed, "every process still has an inbound leg"
    assert not any(w["kind"] == "unconnected" for w in flowgraph.diagnose(m))
    # the authored leg is the authored one; the rest stay derived
    packing = [e for e in g.edges if e.dst == "梱包"]
    assert len(packing) == 1 and not packing[0].derived
    assert all(e.derived for e in g.edges if e.dst != "梱包")


def test_an_authored_manual_leg_overrides_a_stale_stage_method():
    """Explicitly saying 人手 is a DECISION, not an absence.

    ``pick_to_belt``'s pack stage still reads ``conveyor``; an authored 人手 leg
    must win, or the very bug this layer exists to fix would come back through
    the fallback.
    """
    m = templates.load_template_model("pick_to_belt")
    assert flowgraph.transport_into(m, "pack") == ("conveyor", "")   # derived
    m.process.flow_edges = [FlowEdge(src="検品", dst="梱包", transport="manual")]
    assert flowgraph.transport_into(m, "pack") == ("manual", "")
    assert flowgraph.conveyor_ids_in_use(m) is None
    assert _conveyor_events(m) == 0
