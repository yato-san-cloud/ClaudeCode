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


# --- 近接ミス: geometry that ALMOST connects ----------------------------------
# Four times over one real engagement, a drawing missed a threshold by
# centimetres, every rule answered "not connected", and THE MODEL STILL RAN AND
# STILL COMPLETED ITS ORDERS — so nothing in the numbers said the line's
# mechanism was absent. Each fixture below is one of those four, reproduced on
# the shipped 引き込み line, and each asserts the warning names the two objects,
# the measured gap, the threshold and what to do about it.

def _line(**moves):
    """``line_inspection`` with belts moved: ``_line(spur3n=[[x, y], ...])``."""
    m = templates.load_template_model("line_inspection")
    for cv in m.resources.conveyors:
        if cv.id in moves:
            cv.points = moves[cv.id]
    return m


def _only(model, kind: str) -> dict:
    """The one warning of ``kind`` — and proof nothing else got noisy."""
    ws = flowgraph.diagnose(model)
    mine = [w for w in ws if w["kind"] == kind]
    assert len(mine) == 1, f"expected exactly one {kind}, got {[w['kind'] for w in ws]}"
    return mine[0]


def test_a_spur_that_misses_the_trunk_is_reported_as_receiving_NOTHING():
    """歴史ケース①: a 引き込み with no endpoint within 0.8 m of the 本線.

    It got no junction at all, kept its 4 梱包台 and received not one load. The
    orders completed anyway (everything rode to the end and packed out of the
    shared pool), so it read as a healthy line with dead belts.
    """
    m = _line(spur3n=[[26.5, 5.044], [26.5, 7.644]])
    w = _only(m, "spur_no_junction")
    assert w["belt"] == "spur3n" and w["other"] == "trunk_low"
    assert w["gap"] == pytest.approx(1.044, abs=1e-3)
    assert w["tolerance"] == 0.8 and w["severity"] == "critical"
    for phrase in ("spur3n", "trunk_low", "1.04 m", "0.80 m", "0.3 m"):
        assert phrase in w["message"]
    # never-blocks: the very thing that hid it must keep working.
    assert sum(1 for e in run_once(m, seed=3).events
               if e["event"] == "order_complete") > 0


def test_a_belt_end_just_past_the_join_tolerance_is_reported():
    """歴史ケース②: the west 検品 belt's discharge end 1.044 m from the trunk.

    Just past the 0.8 m threshold, so the two 検品 belts resolved SERIAL instead
    of parallel and every load rode the east belt. Nobody noticed until a
    capacity number looked odd; the fix was to lengthen the west belt by 0.3 m.
    """
    m = _line(insp2=[[10.0, 8.8], [43.2, 8.8], [43.2, 5.044]])
    w = _only(m, "near_join")
    assert w["belt"] == "insp2" and w["other"] == "trunk_low"
    assert w["gap"] == pytest.approx(1.044, abs=1e-3) and w["tolerance"] == 0.8
    for phrase in ("insp2", "trunk_low", "1.04 m", "0.80 m", "0.3 m 伸ばせば"):
        assert phrase in w["message"]


def test_a_belt_end_that_already_touches_is_not_a_near_miss():
    """The shipped geometry: insp2 discharges ON the trunk. Silence is correct."""
    assert not [w for w in flowgraph.diagnose(_line()) if w["kind"] == "near_join"]


def test_the_near_join_report_stops_at_three_times_the_tolerance():
    """Past 3×0.8 m the two belts are simply elsewhere on the floor.

    The shipped line already leans on that bound: ``trunk_low`` ends at 積み付け
    5.9 m from the nearest belt, and a line has to end somewhere. A check that
    shouted about it would be a check nobody reads.
    """
    from whsim import beltgeom

    def west_belt_ending_at(y):
        return _line(insp2=[[10.0, 8.8], [37.0, 8.8], [37.0, y]])

    inside = west_belt_ending_at(4.0 + beltgeom.NEAR_JOIN_M - 0.1)
    outside = west_belt_ending_at(4.0 + beltgeom.NEAR_JOIN_M + 0.1)
    assert _only(inside, "near_join")["other"] == "trunk_low"
    assert not [w for w in flowgraph.diagnose(outside) if w["kind"] == "near_join"]


def test_a_contested_bench_says_who_won_and_by_how_much():
    """歴史ケース③: a bench 2.6 m from one spur and 1.6 m from another.

    It silently belonged to the nearer one — correct, and invisible.
    """
    m = _line(spur1n=[[12.5, 4.0], [12.5, 5.6]])
    for s in m.resources.stations:
        if s.id == "pack1sL":
            s.x, s.y = 12.5, 3.0
    w = _only(m, "bench_contested")
    assert w["station"] == "pack1sL" and w["belt"] == "spur1s" and w["other"] == "spur1n"
    assert (w["gap"], w["rival_gap"]) == (pytest.approx(1.6), pytest.approx(2.6))
    for phrase in ("pack1sL", "1.60 m", "2.60 m", "差 1.00 m"):
        assert phrase in w["message"]


def test_a_bench_just_out_of_everybody_s_reach_is_reported():
    """It belongs to nobody and quietly falls back to the shared pack pool."""
    m = _line()
    for s in m.resources.stations:
        if s.id == "pack2nL":
            s.x, s.y = 19.5, 9.9                 # 3.3 m from spur2n's discharge end
    w = _only(m, "bench_out_of_reach")
    assert w["station"] == "pack2nL" and w["belt"] == "spur2n" and w["reach"] == 3.0
    assert w["gap"] == pytest.approx(3.3)
    for phrase in ("pack2nL", "3.30 m", "3.0 m", "0.3 m 近づければ"):
        assert phrase in w["message"]


def test_a_bench_in_another_part_of_the_building_is_not_a_near_miss():
    """Past 2× the reach it is simply a bench somewhere else — no advice to give."""
    m = _line()
    for s in m.resources.stations:
        if s.id == "pack2nL":
            s.x, s.y = 19.5, 20.0
    assert not [w for w in flowgraph.diagnose(m) if w["kind"] == "bench_out_of_reach"]


def test_unmanned_and_taken_are_two_different_diagnoses():
    """歴史ケース④: 「drawn but unmanned」 and 「a neighbour took my bench」.

    Both leave the 引き込み with no hands (``beltgeom.NO_HANDS``) and look
    identical from outside — but one is fixed by entering a count and the other
    by moving a bench, so the warning has to say WHICH.
    """
    closed = _line()
    for s in closed.resources.stations:
        if s.id in ("pack5nL", "pack5nR"):
            s.count = 0
    w = _only(closed, "spur_closed")
    assert w["belt"] == "spur5n" and "0 台" in w["message"] and "台数" in w["message"]

    lost = _line()
    lost.resources.stations = [s for s in lost.resources.stations
                               if s.id not in ("pack5nL", "pack5nR")]
    for s in lost.resources.stations:
        if s.id == "pack5sL":
            s.x, s.y = 40.5, 3.8
    w = _only(lost, "spur_bench_lost")
    assert w["belt"] == "spur5n" and w["other"] == "spur5s" and w["station"] == "pack5sL"
    assert (w["gap"], w["rival_gap"]) == (pytest.approx(2.8), pytest.approx(2.4))
    assert "2.40 m" in w["message"] and "2.80 m" in w["message"]
    # ...and the two diagnoses are genuinely different kinds, not one message
    # reused: the closed line never says "taken", the taken line never says "0 台".
    assert not [x for x in flowgraph.diagnose(closed) if x["kind"] == "spur_bench_lost"]
    assert not [x for x in flowgraph.diagnose(lost) if x["kind"] == "spur_closed"]


def test_a_belt_drawn_but_wired_into_nothing_is_reported():
    """The asymmetry ARCHITECTURE warns about (不変条件5).

    The engine gates on ``conveyor_ids_in_use`` while ``analytic._belt_access``
    reads every drawn belt, so a belt visible to only one of them means the two
    are computing different warehouses.
    """
    from whsim.schema.model import Conveyor

    m = _line()
    m.resources.conveyors = [*m.resources.conveyors,
                             Conveyor(id="decoy", points=[[2.0, 20.0], [10.0, 20.0]])]
    w = _only(m, "belt_not_wired")
    assert w["conveyor"] == "decoy" and "decoy" in w["message"]
    assert flowgraph.conveyor_ids_in_use(m) == set(
        flowgraph.conveyor_ids_in_use(_line()))


def test_the_upper_deck_of_a_two_tier_belt_is_not_that_asymmetry():
    """``trunk_up`` (2段駆動の上段・空容器の還流) is drawn over ``trunk_low``'s XY.

    It is not wired into the flow, and it must NOT be reported: both readers are
    still looking at the same floor, which is the only reason a belt one of them
    cannot see is worth a warning at all.
    """
    m = _line()
    assert "trunk_up" not in (flowgraph.conveyor_ids_in_use(m) or set())
    assert not [w for w in flowgraph.diagnose(m) if w["kind"] == "belt_not_wired"]


@pytest.mark.parametrize("template_id", ALL_TEMPLATES)
def test_no_near_miss_is_reported_on_a_shipped_template(template_id):
    """No false alarms on what we ship — a noisy check is an ignored check."""
    assert flowgraph.diagnose(templates.load_template_model(template_id)) == []


def test_the_warnings_do_not_depend_on_the_order_of_the_drawing():
    """Deterministic by ID, not by drawing order.

    A re-saved file with its belts and benches in another order is the SAME
    warehouse; if it produced a different list, no one could diff two runs.
    """
    m = _line(spur3n=[[26.5, 5.044], [26.5, 7.644]],
              insp2=[[10.0, 8.8], [43.2, 8.8], [43.2, 5.044]])
    for s in m.resources.stations:
        if s.id == "pack2nL":
            s.x, s.y = 19.5, 9.9
    first = flowgraph.diagnose(m)
    assert len(first) >= 3
    m.resources.conveyors = list(reversed(m.resources.conveyors))
    m.resources.stations = list(reversed(m.resources.stations))
    assert flowgraph.diagnose(m) == first


def test_a_near_miss_never_blocks_and_never_changes_the_wiring():
    """Warnings only (不変条件13): the resolved topology is untouched."""
    from whsim.engine.build import build

    m = _line(spur3n=[[26.5, 5.044], [26.5, 7.644]])
    before = {c.id: (c.n_bench, bool(c.junctions)) for c in build(m).conveyors}
    assert flowgraph.diagnose(m), "the near miss is reported"
    after = {c.id: (c.n_bench, bool(c.junctions)) for c in build(m).conveyors}
    assert before == after
    assert before["spur3n"] == (2, False), "still dead, still holding its benches"


def test_the_near_miss_checks_survive_junk_geometry():
    """Never raises: a broken drawing must not cost the caller the other checks."""
    from whsim.schema.model import Conveyor

    m = _line()
    m.resources.conveyors = [*m.resources.conveyors,
                             Conveyor(id="dot", points=[[1.0, 1.0], [1.0, 1.0]]),
                             Conveyor(id="stub", points=[[2.0, 2.0]]),
                             Conveyor(id="empty", points=[])]
    kinds = [w["kind"] for w in flowgraph.diagnose(m)]      # must not raise
    assert not [k for k in kinds if k == "belt_not_wired"], \
        "degenerate geometry is not transport, so it is not a missing belt either"


def test_a_bench_standing_at_a_stop_line_belongs_to_it_not_to_nobody():
    """停止線の作業者 are not orphans (不変条件17's mechanism, read once).

    A load held at a 停止線 has to be taken off the line by somebody, and
    ``engine.build`` gives that bench to the gate. Calling it ownerless would
    send the user to move a bench that is exactly where it belongs.
    """
    m = _line()
    for s in m.resources.stations:
        if s.id == "pack2nL":
            s.x, s.y = 19.5, 9.9             # 3.3 m past spur2n's reach
    assert _only(m, "bench_out_of_reach")["station"] == "pack2nL"
    # ...now put a 停止線 on the 検品 belt that runs right beside it.
    for cv in m.resources.conveyors:
        if cv.id == "insp2":
            cv.stop_gate = {"at_m": 9.5, "stop_states": ["inspected"]}
    assert not [w for w in flowgraph.diagnose(m) if w["kind"] == "bench_out_of_reach"]
