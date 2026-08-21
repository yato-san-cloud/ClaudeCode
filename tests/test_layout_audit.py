"""レイアウト診断 (whsim.layoutaudit) — design-time reachability/連結/通路幅 checks.

The contract these tests pin down is the one the 動線 editor relies on while a
salesperson is still dragging shelves: a rack sealed away is REPORTED, a floor
cut in two is REPORTED, a pinched aisle is REPORTED with its true width, a normal
template is quiet — and nothing, however malformed, ever raises.
"""

from __future__ import annotations

import time

import pytest

from whsim import layoutaudit as la
from whsim import templates
from whsim.engine.graph import AisleGraph
from whsim.rackgeom import rack_rects

W, D = 40.0, 20.0


def _segs(walls):
    return AisleGraph._segments_from_walls(walls)


def _template_layout(tid: str):
    m = templates.load_template_model(tid)
    L = m.layout
    walls = [{"points": [list(p) for p in w.points]} for w in L.walls]
    return L.bounds.width, L.bounds.depth, _segs(walls), rack_rects(m)


# --------------------------------------------------------------- 到達できない棚


def test_rack_sealed_in_a_walled_pocket_is_unreachable():
    """A rack inside a closed room (no door) has open faces but none of them is
    on the floor everyone else walks — exactly what the salesperson must see."""
    walls = [{"points": [[10, 5], [20, 5], [20, 15], [10, 15], [10, 5]]}]
    rects = [(13.0, 8.0, 4.0, 2.0)]
    a = la.audit(W, D, _segs(walls), rects)

    assert a["summary"]["unreachable_n"] == 1
    assert a["summary"]["ok"] is False
    item = a["unreachable"][0]
    assert item["index"] == 0
    assert item["reason"] == "isolated"
    assert item["rect"] == [13.0, 8.0, 4.0, 2.0]
    # a representative point to highlight, inside/next to the sealed rack
    px, py = item["point"]
    assert 10.0 <= px <= 20.0 and 5.0 <= py <= 15.0
    # the pocket itself also shows up as a second connected component
    assert a["summary"]["components"] == 2


def test_rack_boxed_in_by_other_racks_has_no_open_face():
    """Racks packed flush on all four sides: MapMaker's 「全面が塞がれている」."""
    rects = [
        (10.0, 10.0, 2.0, 2.0),                       # the victim
        (8.0, 10.0, 2.0, 2.0), (12.0, 10.0, 2.0, 2.0),
        (10.0, 8.0, 2.0, 2.0), (10.0, 12.0, 2.0, 2.0),
    ]
    a = la.audit(W, D, [], rects)
    blocked = [u for u in a["unreachable"] if u["reason"] == "blocked"]
    assert 0 in [u["index"] for u in blocked]


def test_a_reachable_rack_is_not_reported():
    rects = [(10.0, 8.0, 4.0, 2.0)]
    a = la.audit(W, D, [], rects)
    assert a["summary"]["unreachable_n"] == 0
    assert a["summary"]["components"] == 1
    assert a["summary"]["ok"] is True


# ------------------------------------------------------------------ 床の分断


def test_full_height_wall_splits_the_floor_into_two_components():
    walls = [{"points": [[20, 0], [20, 20]]}]
    a = la.audit(W, D, _segs(walls), [])
    assert a["summary"]["components"] == 2
    assert a["summary"]["ok"] is False
    areas = sorted(c["area_m2"] for c in a["components"])
    assert len(areas) == 2 and min(areas) > 100.0     # two REAL halves, not specks
    assert sum(1 for c in a["components"] if c["main"]) == 1
    for c in a["components"]:
        x, y = c["point"]
        assert 0.0 <= x <= W and 0.0 <= y <= D


def test_open_floor_is_one_component():
    a = la.audit(W, D, [], [])
    assert a["summary"]["components"] == 1
    assert a["summary"]["ok"] is True


# -------------------------------------------------------------------- 狭い通路


def test_narrow_aisle_is_reported_with_a_plausible_width():
    """Two rows 0.8 m apart: below the 人 threshold, so it is an error, and the
    reported width is the geometric truth (not a grid-pitch approximation)."""
    rects = [(10.0, 4.0, 1.0, 12.0), (11.8, 4.0, 1.0, 12.0)]
    a = la.audit(W, D, [], rects)

    assert a["summary"]["narrow_person_n"] == 1
    assert a["summary"]["min_aisle_m"] == pytest.approx(0.8, abs=0.01)
    entry = next(e for e in a["narrow"] if e["level"] == "person")
    assert entry["gap_m"] == pytest.approx(0.8, abs=0.01)
    assert entry["axis"] == "x"
    # the marked segment runs down the aisle centreline over the shared span
    (x1, y1), (x2, y2) = entry["segment"]
    assert x1 == pytest.approx(11.4, abs=0.05) and x2 == pytest.approx(11.4, abs=0.05)
    assert (y1, y2) == (4.0, 16.0)
    assert a["summary"]["ok"] is False


def test_forklift_threshold_is_separate_from_the_person_threshold():
    """A 2.0 m aisle: fine for a person, too tight for a counter forklift."""
    rects = [(10.0, 4.0, 1.0, 12.0), (13.0, 4.0, 1.0, 12.0)]
    a = la.audit(W, D, [], rects)
    levels = {e["gap_m"]: e["level"] for e in a["narrow"]}
    assert levels[2.0] == "forklift"
    assert a["summary"]["narrow_person_n"] == 0
    assert a["summary"]["ok"] is True                 # forklift-width is advisory


def test_thresholds_are_parameters():
    rects = [(10.0, 4.0, 1.0, 12.0), (13.0, 4.0, 1.0, 12.0)]   # 2.0 m aisle
    a = la.audit(W, D, [], rects, person_aisle_m=3.0, forklift_aisle_m=4.0)
    assert a["summary"]["narrow_person_n"] >= 1                # now "too narrow"
    assert a["thresholds"]["person_m"] == 3.0
    b = la.audit(W, D, [], rects, person_aisle_m=0.5, forklift_aisle_m=1.0)
    assert b["summary"]["narrow_n"] == 0                       # now perfectly fine


def test_back_to_back_seam_is_not_an_aisle():
    """Racks placed flush back-to-back must not be flagged as a 5 cm 'aisle'."""
    rects = [(10.0, 4.0, 1.0, 12.0), (11.05, 4.0, 1.0, 12.0)]
    a = la.audit(W, D, [], rects)
    assert all(e["gap_m"] >= la.DEFAULT_SEAM_M for e in a["narrow"])


def test_identical_perimeter_gaps_are_merged_into_one_lane():
    """A rack field's end-of-aisle clearance is ONE cross aisle, not N findings."""
    rects = [(10.0 + 4 * i, 2.0, 1.0, 16.0) for i in range(5)]
    a = la.audit(W, D, [], rects)
    # bottom + top perimeter lanes at 2.0 m, each merged across all five rows
    lanes = [e for e in a["narrow"] if e["axis"] == "y"]
    assert len(lanes) == 2
    assert all(e["length_m"] > 10.0 for e in lanes)


# ------------------------------------------------------------------ never-blocks


@pytest.mark.parametrize("args", [
    (0, 0, [], []),
    (None, None, None, None),
    (W, D, None, [["a", "b"], [1, 2], [1, 2, 3, 4], None]),
    ("x", "y", [{"points": "zz"}], "nope"),
    (W, D, [[[0, 0], [1, 1]], "junk", [[0]]], []),
    (float("nan"), float("nan"), [], [(1, 1, 1, 1)]),
])
def test_malformed_input_never_blocks(args):
    a = la.audit(*args)
    for key in ("ok", "unreachable", "components", "narrow", "deadends", "summary"):
        assert key in a
    s = a["summary"]
    assert isinstance(s["unreachable_n"], int) and s["unreachable_n"] >= 0
    assert isinstance(s["components"], int)


def test_empty_audit_is_a_valid_sane_result():
    a = la.empty_audit()
    assert a["ok"] is True and a["summary"]["unreachable_n"] == 0
    assert a["summary"]["min_aisle_m"] is None


# ------------------------------------------------------------ real templates


def test_retail_dc_is_clean_and_fast():
    width, depth, segs, rects = _template_layout("retail_dc")
    assert len(rects) > 0                              # parametric racks ARE seen
    t0 = time.perf_counter()
    a = la.audit(width, depth, segs, rects)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    assert a["summary"]["unreachable_n"] == 0
    assert a["summary"]["components"] == 1
    assert a["summary"]["narrow_person_n"] == 0
    assert a["summary"]["ok"] is True
    assert a["summary"]["min_aisle_m"] == pytest.approx(2.0, abs=0.01)
    # live-editing budget: the 動線 editor re-audits on every debounced edit.
    assert elapsed_ms < 1000.0, f"retail_dc audit took {elapsed_ms:.0f} ms"


def test_ecommerce_small_is_clean():
    width, depth, segs, rects = _template_layout("ecommerce_small")
    a = la.audit(width, depth, segs, rects)
    assert a["summary"]["unreachable_n"] == 0
    assert a["summary"]["components"] == 1
    assert a["summary"]["ok"] is True


def test_sealing_the_aisle_flips_a_clean_template_red():
    """The feature in one assertion: drop a shelf across the only way in, and the
    same layout that audited clean now reports an unreachable rack."""
    width, depth, segs, _ = _template_layout("ecommerce_small")
    # a lone rack in a three-walled alcove (left / top / right), open at y=5...
    alcove = [{"points": [[30, 5], [30, 15], [40, 15], [40, 5]]}]
    rects = [(33.0, 9.0, 4.0, 2.0)]
    before = la.audit(width, depth, _segs(alcove) + list(segs), rects)
    assert before["summary"]["unreachable_n"] == 0
    assert before["summary"]["components"] == 1
    # ...now drop a shelf run right across the mouth of the alcove.
    rects_after = rects + [(30.0, 4.5, 10.0, 1.0)]
    after = la.audit(width, depth, _segs(alcove) + list(segs), rects_after)
    assert after["summary"]["unreachable_n"] >= 1
    assert after["summary"]["components"] == 2
    assert after["summary"]["ok"] is False


# ------------------------------------------------------------------- the API


def test_network_endpoint_audit_is_additive():
    from fastapi.testclient import TestClient

    from whsim.web.app import app
    client = TestClient(app)
    width, depth, _, rects = _template_layout("retail_dc")
    m = templates.load_template_model("retail_dc")
    body = {
        "bounds": {"width": width, "depth": depth},
        "walls": [{"points": [list(p) for p in w.points]} for w in m.layout.walls],
        "shelves": [list(r) for r in rects],
    }
    # existing callers are untouched: no audit key unless asked for
    plain = client.post("/api/routes/network", json={**body, "include_edges": True})
    assert plain.status_code == 200
    assert "audit" not in plain.json()
    assert plain.json()["edges"]

    audited = client.post("/api/routes/network", json={**body, "audit": True})
    assert audited.status_code == 200
    s = audited.json()["audit"]["summary"]
    assert s["ok"] is True and s["unreachable_n"] == 0 and s["components"] == 1


def test_network_endpoint_audit_never_500s():
    from fastapi.testclient import TestClient

    from whsim.web.app import app
    client = TestClient(app)
    for body in ({"audit": True},
                 {"audit": True, "bounds": {"width": "x"}, "shelves": [["a"]]},
                 {"audit": True, "walls": [{"points": [[0, 0]]}], "shelves": None}):
        r = client.post("/api/routes/network", json=body)
        assert r.status_code == 200
        assert "summary" in r.json()["audit"]
