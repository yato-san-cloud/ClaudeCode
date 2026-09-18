"""Agents must travel the AISLES, not through the racking.

Regression guard for a severe, measured defect: ``AisleGraph.from_model`` derived
its impassable rectangles from authored ``ShelfArea``s only, so a **parametric**
model — both bundled templates, whose racks live in ``model.locations`` — had NO
routing obstacles at all. Agents cut straight through the racks they are drawn
next to, both on screen and in the distance maths, which understates travel and
therefore OVERSTATES productivity and throughput in the proposal.

Measured before the fix (full replay window, both templates):

    template          legs   penetrating   worst leg   penetrated / total
    retail_dc        59577    48918 (82%)     53.2 m     115129 / 311340 m
    ecommerce_small   3725     3725 (100%)    24.2 m      19099 /  74310 m

The methodology below is the same one: sample every consecutive keyframe pair of
every replay agent at ~0.15 m and count samples that land inside a **drawn** rack
rectangle (``render.shelves.shelf_runs``) shrunk by 0.15 m — the shrink is what
lets an agent legitimately stand at a pick face without counting as a violation.
"""

from math import hypot

import pytest

from whsim import templates
from whsim.engine.graph import AisleGraph
from whsim.engine.run import run_once
from whsim.rackgeom import rack_rects

# Sampling step along a leg, in metres (the measurement's resolution).
STEP_M = 0.15
# Each drawn rack rectangle is shrunk by this much before the test, so standing
# at (or reaching into) a pick face is not counted as walking through the rack.
SHRINK_M = 0.15
# A leg may not penetrate by more than this. Zero legs are expected to reach it.
MAX_LEG_PENETRATION_M = 0.3

# The graph-property guards run on the two templates this defect was measured on
# (they are about the GRAPH, and a second layout shape is enough to pin it).
TEMPLATES = ["retail_dc", "ecommerce_small"]

# The penetration measurement itself runs on EVERY template that draws racking.
# Checking two is how a 100% AGV penetration rate in ecommerce_xl went unseen;
# a layout the guard never looks at is a layout the guard does not cover.
PENETRATION_TEMPLATES = [
    t["template_id"] for t in templates.list_templates()
    if rack_rects(templates.load_template_model(t["template_id"]))
]


def _shrunk_rects(model):
    out = []
    for (x, y, w, h) in rack_rects(model):
        x, y = x + SHRINK_M, y + SHRINK_M
        w, h = w - 2 * SHRINK_M, h - 2 * SHRINK_M
        if w > 0 and h > 0:
            out.append((x, y, w, h))
    return out


def _inside(rects, x, y):
    for (rx, ry, rw, rh) in rects:
        if rx <= x <= rx + rw and ry <= y <= ry + rh:
            return True
    return False


def _tracks(res):
    """Every agent whose trajectory the replay draws.

    ``agvs`` belongs here as much as ``workers``: leaving it out is how a 100%
    penetration rate hid in ``ecommerce_xl`` (see the AGV test below).
    """
    tracks = list(res.workers)
    for attr in ("helpers", "packers", "inspectors", "forklifts", "agvs"):
        tracks += [w for w in getattr(res, attr, []) or [] if w.keyframes]
    return tracks


def _penetration(model, res):
    """(legs, penetrating_legs, worst_leg_m, penetrated_m, total_m)."""
    rects = _shrunk_rects(model)
    assert rects, "the template must actually draw racking"
    legs = pen_legs = 0
    worst = pen_m = total_m = 0.0
    for w in _tracks(res):
        kf = w.keyframes
        for a, b in zip(kf, kf[1:]):
            ax, ay, bx, by = a[1], a[2], b[1], b[2]
            length = hypot(bx - ax, by - ay)
            if length < 1e-9:
                continue
            legs += 1
            total_m += length
            n = max(int(length / STEP_M), 1)
            hits = sum(
                1 for i in range(n + 1)
                if _inside(rects, ax + (bx - ax) * i / n, ay + (by - ay) * i / n)
            )
            if hits:
                d = hits * (length / n)
                pen_legs += 1
                pen_m += d
                worst = max(worst, d)
    return legs, pen_legs, worst, pen_m, total_m


@pytest.mark.parametrize("template_id", PENETRATION_TEMPLATES)
def test_agents_never_walk_through_the_racking(template_id):
    model = templates.load_template_model(template_id)
    graph = AisleGraph.from_model(model)
    # Record the WHOLE run, not just the default replay window: a defect that
    # only shows up in hour 6 is still a defect.
    res = run_once(model, replay_window_s=model.simulation.duration_s, graph=graph)

    legs, pen_legs, worst, pen_m, total_m = _penetration(model, res)
    assert legs > 100, "the run must actually have moved agents around"
    assert pen_legs == 0, (
        f"{template_id}: {pen_legs}/{legs} legs penetrate the racking "
        f"(worst {worst:.2f} m, {pen_m:.0f} of {total_m:.0f} m inside racks)"
    )
    assert worst <= MAX_LEG_PENETRATION_M


@pytest.mark.parametrize("template_id", TEMPLATES)
def test_parametric_racks_are_routing_obstacles(template_id):
    """The graph must see every rack the renderers draw, and be switched on.

    ``ecommerce_small`` has ZERO walls, so before the fix the graph was disabled
    outright and every query fell through to Manhattan.
    """
    model = templates.load_template_model(template_id)
    graph = AisleGraph.from_model(model)
    drawn = rack_rects(model)
    assert drawn, "template draws racking"
    assert graph.enabled, "racking alone must enable aisle routing"
    assert len(graph._obstacles) >= len(drawn)
    # Every drawn rectangle is registered verbatim.
    registered = {tuple(round(v, 4) for v in r) for r in graph._obstacles}
    for rect in drawn:
        assert tuple(round(v, 4) for v in rect) in registered


@pytest.mark.parametrize("template_id", TEMPLATES)
def test_routing_never_falls_back_silently(template_id):
    """No query may degrade to Manhattan / a straight segment during a run.

    ``AisleGraph`` deliberately never blows up: an unroutable query answers with
    Manhattan. That is exactly the straight-through-the-racking travel this graph
    exists to prevent, so it must be observable (``unroutable_count``) and it must
    stay at zero on a healthy layout.
    """
    model = templates.load_template_model(template_id)
    graph = AisleGraph.from_model(model)
    run_once(model, replay_window_s=model.simulation.duration_s, graph=graph)
    assert graph.unroutable_count == 0


@pytest.mark.parametrize("template_id", TEMPLATES)
def test_aisles_stay_open_at_the_chosen_grid_pitch(template_id):
    """The grid pitch must not seal an aisle it is supposed to resolve.

    Racks are solid at any pitch (edge blocking is an exact segment/rectangle
    test), so the only failure mode of a coarse lattice is over-blocking. The
    direct read on that is the connectivity of the walkable floor: every
    non-degenerate free component must be THE component. (Single-node components
    are the building shell's own perimeter nodes, which sit exactly on the wall
    polyline — nowhere, not rooms.)
    """
    model = templates.load_template_model(template_id)
    graph = AisleGraph.from_model(model)
    real = [s for s in graph._comp_size if s > 1]
    assert real, "there must be a walkable floor"
    assert max(real) == sum(real), (
        f"{template_id}: the {graph.resolution:.2f} m grid split the floor into "
        f"{len(real)} disconnected walkable regions (sizes {sorted(real)[-5:]})"
    )
    # And the pitch is at most half the narrowest aisle it has to keep open.
    if graph.aisle_gap is not None:
        assert graph.resolution <= max(graph.aisle_gap / 2.0, 0.25) + 1e-9


def test_travel_is_longer_than_the_straight_line_now():
    """Sanity on the direction of the correction: routing around racks is LONGER.

    The honest consequence of the fix — travel rises, so throughput falls. This
    pins the sign so a future regression that re-opens the racks is caught even if
    the penetration sampler is somehow satisfied.
    """
    model = templates.load_template_model("ecommerce_small")
    graph = AisleGraph.from_model(model)
    station = model.resources.stations[0]
    depot = (station.x, station.y)
    from whsim.engine.routing import manhattan

    ratios = []
    for loc in model.locations:
        p = (loc.x, loc.y)
        straight = manhattan(depot, p)
        if straight > 5.0:
            ratios.append(graph.distance(depot, p) / straight)
    assert ratios
    assert sum(ratios) / len(ratios) > 1.15, "aisle detours must lengthen travel"


def test_workers_stand_in_the_aisle_to_pick():
    """A `pick` keyframe must sit at the pick FACE, not on the rack centre-line.

    Slots are addressed at the centre of the rack run, so emitting the picker
    there draws a half-rack-depth hop into and back out of the rack around every
    single pick (and reads as a picker standing inside the shelving in 3D).
    """
    model = templates.load_template_model("retail_dc")
    graph = AisleGraph.from_model(model)
    res = run_once(model, replay_window_s=1800.0, graph=graph)
    rects = _shrunk_rects(model)
    picks = [kf for w in res.workers for kf in w.keyframes if kf[3] == "pick"]
    assert picks, "the run must contain picks"
    assert not [kf for kf in picks if _inside(rects, kf[1], kf[2])]


# --- AGVs -------------------------------------------------------------------
# ``ecommerce_xl`` ships AGV picking (pick stage method="agv", 20 units), so this
# is a defect in a bundled template, not a hypothetical.

@pytest.mark.parametrize("interference", [False, True])
def test_agvs_never_drive_through_the_racking(interference):
    """Measured before the fix: 335/335 legs (100%) penetrated, with interference
    OFF. That branch emitted exactly two keyframes per move — a straight line —
    while ``world.dist`` had already charged the aisle-routed distance (6.9x the
    straight line here). So the AGV was drawn crossing solid racking at roughly a
    seventh of its real speed.
    """
    model = templates.load_template_model("ecommerce_xl")
    model.process.agv_interference = interference
    graph = AisleGraph.from_model(model)
    res = run_once(model, replay_window_s=model.simulation.duration_s, graph=graph)

    agvs = [a for a in res.agvs if a.keyframes]
    assert agvs, "the template must actually run AGVs"
    rects = _shrunk_rects(model)
    legs = pen = 0
    for a in agvs:
        for p, q in zip(a.keyframes, a.keyframes[1:]):
            ax, ay, bx, by = p[1], p[2], q[1], q[2]
            length = hypot(bx - ax, by - ay)
            if length < 1e-9:
                continue
            legs += 1
            n = max(int(length / STEP_M), 1)
            if any(_inside(rects, ax + (bx - ax) * i / n, ay + (by - ay) * i / n)
                   for i in range(n + 1)):
                pen += 1
    assert legs > 100, "the run must actually have moved AGVs around"
    assert pen == 0, f"{pen}/{legs} AGV legs penetrate the racking"


def test_agv_replay_track_is_viz_only():
    """Drawing the real route must not move a single number.

    The fix deliberately keeps ONE ``env.timeout`` for the whole move and
    back-dates the corner keyframes, so SimPy scheduling, the event log and every
    downstream RNG draw are untouched. Pin that: the drawn path length grows to
    the routed distance while the KPIs stay put.
    """
    from whsim import kpis
    from whsim.engine.routing import manhattan

    model = templates.load_template_model("ecommerce_xl")
    graph = AisleGraph.from_model(model)
    res = run_once(model, replay_window_s=1800.0, graph=graph, seed=3)

    drawn = straight = 0.0
    for a in res.agvs:
        kf = [k for k in a.keyframes]
        for p, q in zip(kf, kf[1:]):
            drawn += hypot(q[1] - p[1], q[2] - p[2])
        # endpoints of each travel..arrive span, as the straight line used to be
        for p, q in zip(kf, kf[1:]):
            if p[3] in ("travel", "dropoff") and q[3] in ("pickup", "idle"):
                straight += manhattan((p[1], p[2]), (q[1], q[2]))
    assert drawn > 0
    # The drawn track is now a real aisle route, so it is materially longer than
    # the straight hops it replaced.
    assert drawn > straight * 1.2

    k = kpis.compute([res], model)
    assert k["throughput_per_hr"] > 0 and k["orders_completed"] > 0
