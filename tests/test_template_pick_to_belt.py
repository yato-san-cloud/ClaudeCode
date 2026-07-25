"""``pick_to_belt`` — the コンベア搬送 path, exercised end to end by a real template.

The engine has always implemented the belt (finite slots, end-to-end transit,
jam back-pressure into the picker), but the only bundled template that drew one
was ``food_chilled``'s 8 m stub between storage and packing — enough to switch
the code path on, not enough to be a design anyone would propose. This is the
first template built AROUND the belt, so it is also the one that has to prove
the feature end to end. These tests pin the whole chain:

* the shipped **data** is a believable pick-to-belt DC (geometry, not vibes) —
  the belt runs in CLEAR aisles, never across a rack rectangle, and discharges
  exactly at the packing station;
* the **engine** genuinely routes totes over it (``conveyor_on`` → ``pack_done``
  → ``order_complete``), and removing the belt measurably changes the operation;
* the **designer → model → engine** round trip works for a hand-drawn belt in the
  exact payload shape ``designer/place.js`` emits;
* the template is reachable through the **web API** (picker list → new project →
  run), which is how a salesperson actually meets it.
"""

from __future__ import annotations

from collections import Counter

import pytest
from fastapi.testclient import TestClient

from whsim import kpis as kpis_mod
from whsim import layoutaudit, templates
from whsim.engine.graph import AisleGraph
from whsim.engine.run import run_once
from whsim.rackgeom import rack_rects
from whsim.web.app import app

TID = "pick_to_belt"
SHORT_S = 3600.0        # one hour of sim: long enough to fill and drain the belt


# ---------------------------------------------------------------- helpers


@pytest.fixture(scope="module")
def model():
    return templates.load_template_model(TID)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def _short(tid: str = TID, **profile):
    m = templates.load_template_model(tid)
    m.simulation.duration_s = SHORT_S
    for k, v in profile.items():
        setattr(m.orders.profile, k, v)
    return m


def _run(m):
    res = run_once(m)
    return res, kpis_mod.compute([res], m), Counter(e.get("event") for e in res.events)


def _seg_hits_rect(p, q, rect) -> bool:
    """Liang-Barsky: does segment p→q enter the OPEN rectangle (x, y, w, h)?"""
    x0, y0, w, h = rect
    x1, y1 = x0 + w, y0 + h
    dx, dy = q[0] - p[0], q[1] - p[1]
    t0, t1 = 0.0, 1.0
    for num, den in ((-dx, p[0] - x0), (dx, x1 - p[0]),
                     (-dy, p[1] - y0), (dy, y1 - p[1])):
        if num == 0:
            if den < 0:
                return False
        else:
            t = den / num
            if num < 0:
                t0 = max(t0, t)
            else:
                t1 = min(t1, t)
    return t0 < t1 - 1e-9


def _belt_len(cv) -> float:
    """The engine's own belt length: Manhattan sum over the polyline."""
    return sum(abs(b[0] - a[0]) + abs(b[1] - a[1])
               for a, b in zip(cv.points, cv.points[1:]))


# ------------------------------------------------------------ the shipped data


def test_template_ships_a_real_conveyor(model):
    """A conveyor the engine will actually switch on: ≥2 points, positive speed."""
    assert model.resources.conveyors, f"{TID}: no conveyor in the template"
    cv = model.resources.conveyors[0]
    assert len(cv.points) >= 2
    assert cv.speed_mps > 0
    # 99 m of belt at 0.8 m/s — the numbers the KPI story is told with.
    assert _belt_len(cv) == pytest.approx(99.0)
    assert cv.speed_mps == pytest.approx(0.8)


def test_belt_derives_a_sane_engine_capacity(model):
    """build() turns the drawn polyline into belt slots + transit seconds."""
    import simpy

    from whsim.engine.build import build
    world = build(model, simpy.Environment())
    assert world.has_conveyor is True
    # ~1 tote per metre of belt, and a ~2 min end-to-end ride.
    assert world.belt.capacity == int(_belt_len(model.resources.conveyors[0]))
    assert 60.0 < world.conveyor_transit < 300.0


def test_conveyor_never_crosses_a_rack(model):
    """The belt must run in the aisles it is drawn in — not through the racking.

    This is the assertion that makes the template *believable* rather than merely
    valid: every segment is checked against every drawn rack rectangle.
    """
    rects = rack_rects(model)
    assert rects, "template has no racking to check against"
    for cv in model.resources.conveyors:
        for a, b in zip(cv.points, cv.points[1:]):
            for rect in rects:
                assert not _seg_hits_rect(a, b, rect), (
                    f"conveyor segment {a}→{b} crosses rack {rect}")


def test_conveyor_runs_along_the_pick_face_with_clearance(model):
    """Every vertex sits in a real aisle: clear of the racking, inside the shell."""
    rects = rack_rects(model)
    W, D = model.layout.bounds.width, model.layout.bounds.depth
    worst = min(
        max(rx - px, 0.0, px - (rx + rw)) + max(ry - py, 0.0, py - (ry + rh))
        for cv in model.resources.conveyors for (px, py) in cv.points
        for (rx, ry, rw, rh) in rects
    )
    # Close enough to the pick face to be a collection belt (a picker walks out of
    # its aisle onto it), far enough that the aisle is still walkable.
    assert 1.0 <= worst <= 6.0, f"belt clearance to racking is {worst:.2f} m"
    for cv in model.resources.conveyors:
        for (px, py) in cv.points:
            assert 0.0 <= px <= W and 0.0 <= py <= D


def test_conveyor_discharges_at_the_packing_station(model):
    """The last vertex IS the pack station — the belt ends where packing starts."""
    st = model.resources.stations[0]
    assert st.zone == "packing"
    last = model.resources.conveyors[0].points[-1]
    assert (last[0], last[1]) == pytest.approx((st.x, st.y))


def test_every_pick_aisle_has_an_induction_point(model):
    """One vertex per aisle centreline, so ``_nearest_conveyor`` sends a picker
    out of its OWN aisle head rather than across the rack field."""
    import simpy

    from whsim.engine.build import build
    from whsim.engine.processes import _nearest_conveyor

    world = build(model, simpy.Environment())
    rects = sorted(rack_rects(model))
    centres = [r[0] + r[2] / 2.0 for r in rects]
    aisles = [(a + b) / 2.0 for a, b in zip(centres, centres[1:])]
    assert len(aisles) == 17

    # The collection run: every vertex sharing the belt's lowest y.
    belt_y = min(p[1] for p in world.conveyor_points)
    on_run = sorted(p[0] for p in world.conveyor_points if p[1] == belt_y)
    for cx in aisles:
        assert any(abs(cx - x) < 1e-6 for x in on_run), f"aisle {cx} has no 投入口"

    # Standing at any aisle head, the belt point a picker is sent to is the
    # induction port of that same aisle — a straight walk out, no cross-traffic.
    for cx in aisles:
        head = (cx, min(r[1] for r in rects) - 1.0)
        near = _nearest_conveyor(world, head)
        assert near is not None
        assert near[0] == pytest.approx(cx), f"{head} → {near} is not its own aisle"


def test_layout_audit_is_clean(model):
    """0 unreachable racks, one walkable floor, no sub-human aisle."""
    walls = [{"points": [list(p) for p in w.points]} for w in model.layout.walls]
    a = layoutaudit.audit(model.layout.bounds.width, model.layout.bounds.depth,
                          AisleGraph._segments_from_walls(walls), rack_rects(model))
    assert a["summary"]["unreachable_n"] == 0
    assert a["summary"]["components"] == 1
    assert a["summary"]["narrow_person_n"] == 0
    assert a["summary"]["ok"] is True


def test_shipped_locations_survive_a_re_materialize():
    """"never jumps": re-deriving the grid from the zone's rack params reproduces
    the shipped locations exactly, so opening the layout editor changes nothing."""
    from whsim.design import materialize_racks

    raw = templates.load_template_dict(TID)
    m = templates.load_template_model(TID)
    materialize_racks(m)
    assert [loc.model_dump() for loc in m.locations] == raw["locations"]


# ------------------------------------------------------------------ the engine


def test_engine_moves_totes_over_the_belt():
    """The whole point: totes are inducted, ride, then pack — and KPIs stay sane."""
    m = _short()
    res, kpis, ev = _run(m)

    assert ev["conveyor_on"] > 0, "the belt was never used"
    # Everything that packs came off the belt (no other path feeds pack here).
    assert ev["pack_done"] > 0
    assert ev["conveyor_on"] >= ev["pack_done"]
    assert ev["order_complete"] == ev["pack_done"]
    # staging is disabled: the belt IS the buffer.
    assert ev["staging_put"] == 0

    assert kpis["throughput_per_hr"] > 0
    assert 0.0 < kpis["picker_utilization"] <= 1.0
    assert 0.0 < kpis["packer_utilization"] <= 1.0
    assert kpis["completion_rate"] > 0.85
    assert kpis["cycle_p50_s"] > 0

    # Each tote is inducted before it is packed, and a ride costs real time.
    on = [e["t"] for e in res.events if e.get("event") == "conveyor_on"]
    done = [e["t"] for e in res.events if e.get("event") == "pack_done"]
    assert min(done) - min(on) > 60.0, "transit looks instantaneous"


def test_replay_carries_the_belt_to_the_viewers():
    """The 2D canvas / 3D view read conveyors off the replay contract."""
    from whsim.render.replay import build_replay

    m = _short()
    res, kpis, _ = _run(m)
    rep = build_replay(m, res, kpis)
    belts = rep.get("conveyors") or []
    assert belts and len(belts[0]["points"]) >= 2
    assert belts[0]["id"] == "takeaway"


def test_the_belt_decouples_picking_from_packing():
    """Delete the conveyor and the SAME model gets materially worse.

    Without a belt the picker DOUBLES AS THE PACKER (``processes.py``'s inline
    pack path), so packing lands on the picker's critical path and its
    utilisation jumps — the ~0.3 gap below is the belt earning its capex. That
    gap is the robust signal and holds at every seed; cycle time is deliberately
    NOT asserted, because the belt both removes queueing (shorter) and adds a
    ~2 min ride (longer), and which wins is seed-dependent.
    """
    with_belt = _short()
    _, k_with, ev_with = _run(with_belt)

    without = _short()
    without.resources.conveyors = []
    _, k_without, ev_without = _run(without)

    assert ev_with["conveyor_on"] > 0 and ev_without["conveyor_on"] == 0
    assert k_without["picker_utilization"] > k_with["picker_utilization"] + 0.15
    # Same demand either way: the belt buys utilisation headroom, not throughput.
    assert k_without["throughput_per_hr"] == pytest.approx(
        k_with["throughput_per_hr"], rel=0.10)


def test_peak_pushes_the_line_into_packing_back_pressure():
    """The what-if a salesperson runs: a sale-day peak saturates the packing line
    downstream of the belt, which is exactly what the DES should surface.

    Asserted on the mechanism (packing pinned, work stranded on the belt) rather
    than on the ``bottleneck`` label, which flips between 梱包 and ピッキング from
    seed to seed once both are near saturation.
    """
    m = _short(peak_factor=3.0)
    _, kpis, ev = _run(m)
    assert ev["conveyor_on"] > 0
    assert kpis["packer_utilization"] > 0.85
    # The belt is the queue that absorbs it: pickers keep inducting even though
    # packing cannot keep up, so more totes go on than come off within the hour.
    assert ev["conveyor_on"] > ev["pack_done"]
    assert kpis["completion_rate"] < 1.0


# ----------------------------------------------------- designer → model → engine


def test_designer_drawn_conveyor_round_trips(client):
    """A belt drawn in the 配置 tab (digit 7 / polyline) is emitted by
    ``designer/place.js`` as ``{id, points, speed_mps}``. Save it through
    ``POST /design`` and the engine must pick it up on the next run."""
    client.post("/api/projects", json={"name": "cv", "template": "ecommerce_small"})
    base = client.get("/api/projects/cv/full").json()
    assert not base["resources"]["conveyors"], "fixture template already has a belt"

    resources = dict(base["resources"])
    # Exactly the shape designer/place.js pushes (snapped 0.5 m vertices).
    resources["conveyors"] = [{
        "id": "cv1",
        "points": [[40.0, 15.0], [20.0, 15.0], [20.0, 15.0], [6.0, 15.0]],
        "speed_mps": 0.5,
    }]
    r = client.post("/api/projects/cv/design", json={"resources": resources})
    assert r.status_code == 200

    saved = client.get("/api/projects/cv/full").json()
    assert saved["resources"]["conveyors"][0]["id"] == "cv1"

    client.post("/api/projects/cv/headline", json={"simulation.duration_s": 1800})
    kpis = client.post("/api/projects/cv/run").json()["kpis"]
    assert kpis["throughput_per_hr"] > 0

    rep = client.get("/api/projects/cv/replay").json()
    assert rep["conveyors"] and rep["conveyors"][0]["id"] == "cv1"


# ------------------------------------------------------------------- the API


def test_template_is_offered_and_a_project_runs_from_it(client):
    """The salesperson's actual path: see it in the picker, create, run, render."""
    listed = client.get("/api/templates").json()
    entries = listed if isinstance(listed, list) else listed.get("templates", listed)
    by_id = {t["template_id"]: t for t in entries}
    assert TID in by_id, f"{TID} missing from /api/templates"
    assert by_id[TID]["name"] == "通販EC・コンベア出荷ライン"
    assert by_id[TID]["description"]

    assert client.post("/api/projects",
                       json={"name": "ecv", "template": TID}).status_code == 200
    saved = client.get("/api/projects/ecv/full").json()
    assert saved["resources"]["conveyors"][0]["id"] == "takeaway"

    client.post("/api/projects/ecv/headline", json={"simulation.duration_s": 1800})
    r = client.post("/api/projects/ecv/run")
    assert r.status_code == 200
    assert r.json()["kpis"]["throughput_per_hr"] > 0
    assert client.get("/api/projects/ecv/png").status_code == 200


def test_a_specialist_template_does_not_hijack_the_generic_ec_intent(client):
    """Cody resolves 「EC倉庫」 by scanning the template list IN ORDER for the first
    id/name that looks like ecommerce (``cody._detect_template``). This template's
    name says 通販EC, so it is a live candidate — but a *conveyor* DC is a specific
    design, not the generic EC starting point, and must not steal that intent.

    Pinned here rather than in test_cody.py because the hazard is created by
    template DATA (its id's sort position), so the guard belongs with the data.
    """
    r = client.post("/api/cody/chat", json={"message": "EC倉庫を作って"})
    assert r.status_code == 200
    body = r.json()
    assert body["intent"] == "create_project"
    assert body["params"]["template"] == "ecommerce_small", (
        "a specialist template outranked ecommerce_small for the generic EC "
        "intent — check its id's sort order in templates/")

    # …while asking for the belt by name still lands here.
    r2 = client.post("/api/cody/chat", json={"message": f"{TID} で倉庫を作って"})
    assert r2.json()["params"]["template"] == TID
