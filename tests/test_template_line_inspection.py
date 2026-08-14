"""``line_inspection`` — 検品がコンベアの上で完結する出荷ラインを、データで固定する。

The shape: 仕分けシュート下の無動力コンベア2列（ライン検品）→ 2段駆動コンベアの下段本線
→ 引き込み5ヶ所×両側 → 縦長の梱包台20台 → 停止線／カーブ→積み付け。

Three things make this template different from every other bundled one, and each
of them has a way of silently degrading, so each is pinned here:

* **梱包台が20台ある** — one ``Station`` per bench, which is what the layout editor
  writes (``count: 1`` each). Reading ``stations[0]`` alone modelled a twenty-bench
  packing line as ONE bench, and the closed-form oracle counted it the same wrong
  way, so the two agreed on a fiction.
* **ベルトが13本ある** — the engine only runs the belts the flow graph names
  (``conveyor_ids_in_use``) while ``analytic._belt_access`` reads every drawn one.
  If those two sets ever disagree about the belt NEAREST a slot, 解析 and DES are
  costing different warehouses.
* **台と段は実寸** — a bench's ``w``/``d`` decide which way it faces (and therefore
  where its operator stands), and ``elevation_m`` is the only thing separating the
  two decks of the trunk, which share one footprint. Both are optional fields, so
  the replay must carry them WITHOUT breaking a model that states neither.
"""

from __future__ import annotations

from collections import Counter

import pytest
from fastapi.testclient import TestClient

from whsim import analytic, flowgraph, layoutaudit, templates
from whsim import kpis as kpis_mod
from whsim.engine.graph import AisleGraph
from whsim.engine.run import run_once
from whsim.rackgeom import rack_rects
from whsim.web.app import app

TID = "line_inspection"
SHORT_S = 3600.0        # one hour: long enough to fill and drain the line


@pytest.fixture(scope="module")
def model():
    return templates.load_template_model(TID)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def _short():
    m = templates.load_template_model(TID)
    m.simulation.duration_s = SHORT_S
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


# ------------------------------------------------------------ the packing line


def test_twenty_benches_each_with_its_own_footprint(model):
    """20台の梱包台: four per 引き込み (両側 × 左右), each an individual Station."""
    st = model.resources.stations
    assert len(st) == 20
    assert all(s.zone == "packing" and s.count == 1 for s in st)
    # 縦長 — the long side runs along y, i.e. parallel to its spur, which is what
    # puts the operator in the gap between bench and belt instead of at its end.
    for s in st:
        assert (s.w, s.d) == (0.9, 1.4)
        assert s.d > s.w

    spurs = {round(c.points[0][0], 3) for c in model.resources.conveyors
             if c.id.startswith("spur")}
    assert len(spurs) == 5
    for s in st:
        near = min(spurs, key=lambda x: abs(x - s.x))
        gap = abs(s.x - near) - s.w / 2.0 - 0.3   # 0.3 m = half a belt's width
        assert 0.4 <= gap <= 0.9, f"{s.id}: 立ち位置 {gap:.2f} m is not a place to stand"


def test_the_bench_line_is_the_pack_stage_the_engine_sizes(model):
    """梱包台20台 ⇒ 20 packers — in the ENGINE and in the ORACLE.

    The editor writes one Station per bench, so ``stations[0].count`` is 1 here.
    Reading only that entry sized this line at a single bench (and the closed form
    made the identical mistake, so the disagreement was invisible).
    """
    import simpy

    from whsim.engine.build import build
    assert model.resources.stations[0].count == 1
    world = build(model, simpy.Environment())
    assert world.n_packers == 20
    assert world.packers.capacity == 20

    # The oracle counts the same benches: at ~475 orders/h × 78 s the line runs at
    # about half capacity — a number that is only right for TWENTY benches.
    est = analytic.estimate(model)
    assert est["packer_utilization"] == pytest.approx(0.51, abs=0.05)


# ------------------------------------------------------------------- the belts


def test_the_conveyor_chain_is_drawn_as_it_is_built(model):
    """2列の検品ライン + 2段の本線 + 引き込み5ヶ所×両側."""
    by_id = {c.id: c for c in model.resources.conveyors}
    assert len(by_id) == 14
    assert {"insp1", "insp2", "trunk_low", "trunk_up"} <= set(by_id)
    assert len([k for k in by_id if k.startswith("spur")]) == 10

    # ライン検品 is a slow line ON PURPOSE: the dwell IS the inspection.
    for k in ("insp1", "insp2"):
        assert by_id[k].speed_mps == pytest.approx(0.35)
        assert by_id[k].points[-1][1] == pytest.approx(by_id["trunk_low"].points[0][1]), (
            "the inspection row must hand over ON the trunk")

    # 2段駆動コンベア: one footprint, two decks — only elevation separates them.
    low, up = by_id["trunk_low"], by_id["trunk_up"]
    assert low.elevation_m is not None and up.elevation_m is not None
    assert up.elevation_m > low.elevation_m + 0.3
    assert {p[1] for p in up.points} == {low.points[0][1]}
    # ...and the return deck runs the other way (empties go BACK to the chutes).
    assert up.points[0][0] < up.points[-1][0] < low.points[0][0] + 1e-9


def test_every_drawn_belt_is_wired_into_the_flow(model):
    """The engine runs only the belts the flow names; the oracle reads them all.

    So every belt on the drawing has to be named by a leg, or 解析 and DES are
    looking at different machines (invariant 5).
    """
    designed = flowgraph.conveyor_ids_in_use(model)
    assert designed is not None, "no leg says コンベア — the belts would not run"
    drawn = {c.id for c in model.resources.conveyors}
    assert drawn - designed == {"trunk_up"}, (
        "only the empty-container return deck may be unrouted (it carries no order)")
    assert flowgraph.diagnose(model) == [], "the shipped flow must be warning-free"


def test_the_inspection_row_is_the_nearest_belt_to_every_slot(model):
    """What makes the two belt sets equivalent: from ANY slot the nearest belt is
    an inspection row, which both the engine and the oracle build."""
    designed = flowgraph.conveyor_ids_in_use(model)
    nearest = Counter()
    for loc in model.locations:
        best = min(model.resources.conveyors,
                   key=lambda c: analytic._nearest_on_polyline((loc.x, loc.y), c.points)[1])
        nearest[best.id] += 1
    assert set(nearest) <= {"insp1", "insp2"}
    assert set(nearest) <= designed


def test_no_belt_crosses_a_rack(model):
    """Geometry, not vibes: no segment of any belt enters a rack rectangle."""
    rects = rack_rects(model)
    assert rects
    for cv in model.resources.conveyors:
        for a, b in zip(cv.points, cv.points[1:]):
            for rect in rects:
                assert not _seg_hits_rect(a, b, rect), (
                    f"{cv.id}: segment {a}→{b} crosses rack {rect}")


# -------------------------------------------------------------- the shipped data


def test_layout_audit_is_clean(model):
    walls = [{"points": [list(p) for p in w.points]} for w in model.layout.walls]
    a = layoutaudit.audit(model.layout.bounds.width, model.layout.bounds.depth,
                          AisleGraph._segments_from_walls(walls), rack_rects(model))
    assert a["summary"]["unreachable_n"] == 0
    assert a["summary"]["components"] == 1
    assert a["summary"]["narrow_person_n"] == 0


def test_shipped_locations_survive_a_re_materialize():
    """"never jumps": the shipped grid IS what the zone's rack params regenerate."""
    from whsim.design import materialize_racks

    raw = templates.load_template_dict(TID)
    m = templates.load_template_model(TID)
    materialize_racks(m)
    assert [loc.model_dump() for loc in m.locations] == raw["locations"]


# ------------------------------------------------------------------- the engine


def test_the_line_actually_carries_the_work():
    m = _short()
    res, kpis, ev = _run(m)

    assert ev["conveyor_on"] > 0, "nothing was handed to the line"
    assert ev["order_complete"] == ev["pack_done"]
    assert ev["staging_put"] == 0, "the belt IS the buffer here"
    assert kpis["throughput_per_hr"] > 0
    assert kpis["completion_rate"] > 0.85
    # A ride is real time (the inspection dwell), never instantaneous.
    assert kpis["conveyor_transit_mean_s"] > 30.0
    # ...and the drawn line has enough slots that it is not the constraint. With
    # the chained belts a hand-over may wait a moment at a busy 引き込み (that IS
    # accumulation working), so the pin is the RATIO staying marginal, not zero.
    assert kpis["conveyor_block_ratio"] < 0.05
    assert kpis["bottleneck"] == "picking"


def test_the_bench_line_is_what_absorbs_a_peak():
    """The what-if this template exists for: 検品ライン移設 is proposed when the
    packing line, not the belt, is what runs out first under peak."""
    m = _short()
    m.orders.profile.peak_factor = 3.0
    _, kpis, ev = _run(m)
    assert ev["conveyor_on"] > 0
    assert kpis["packer_utilization"] > 0.85


# ------------------------------------------------------------------- the replay


def test_replay_carries_the_footprints_and_the_decks():
    """The 3D reads ``stations[].w/.d`` and ``conveyors[].elevation_m``; both are
    ADDITIVE and guarded, so a model that states neither must not gain the keys
    (a ``null`` there reads as a real 0 in the viewer)."""
    from whsim.render.replay import build_layout_replay, build_replay

    m = _short()
    res, kpis, _ = _run(m)
    for rep in (build_replay(m, res, kpis), build_layout_replay(m)):
        st = rep["stations"]
        assert len(st) == 20 and all((s["w"], s["d"]) == (0.9, 1.4) for s in st)
        decks = {c["id"]: c["elevation_m"] for c in rep["conveyors"]}
        assert decks["trunk_up"] > decks["trunk_low"]

    legacy = build_layout_replay(templates.load_template_model("ecommerce_small"))
    assert all("w" not in s and "d" not in s for s in legacy["stations"])
    assert all("elevation_m" not in c for c in legacy["conveyors"])


# ---------------------------------------------------------------------- the API


def test_template_is_offered_and_a_project_runs_from_it(client):
    listed = client.get("/api/templates").json()
    entries = listed if isinstance(listed, list) else listed.get("templates", listed)
    by_id = {t["template_id"]: t for t in entries}
    assert TID in by_id
    assert by_id[TID]["name"] == "ライン検品・引き込み梱包ライン"

    assert client.post("/api/projects",
                       json={"name": "li", "template": TID}).status_code == 200
    saved = client.get("/api/projects/li/full").json()
    assert len(saved["resources"]["stations"]) == 20
    assert saved["resources"]["stations"][0]["w"] == 0.9

    client.post("/api/projects/li/headline", json={"simulation.duration_s": 1800})
    r = client.post("/api/projects/li/run")
    assert r.status_code == 200
    assert r.json()["kpis"]["throughput_per_hr"] > 0
    assert client.get("/api/projects/li/png").status_code == 200


def test_cody_reaches_it_by_its_own_words_without_stealing_the_generic_belt(client):
    """A specialised shape must be findable by ITS vocabulary and must not take
    the intent that belongs to the general-purpose conveyor template."""
    from whsim import cody
    cat = {"templates": templates.list_templates()}
    for msg in ("ライン検品したい", "検品ラインを移設したい",
                "仕分けシュートの下で検品する倉庫", "引き込みコンベアで梱包ブースへ"):
        assert cody._detect_template(msg, cat) == TID, msg
    # …while a bare コンベア still means the generic 通販EC・コンベア出荷ライン.
    assert cody._detect_template("コンベアの倉庫を作って", cat) == "pick_to_belt"
