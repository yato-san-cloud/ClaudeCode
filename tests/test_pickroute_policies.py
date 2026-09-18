"""ピッカー経路4方式 — the classic SPRP disciplines, pinned to HAND-COMPUTED metres.

`engine/pickroute.py` returns visiting ORDERS, and the metric turns them into
metres. That indirection is exactly where a routing bug hides: a policy that
returns a plausible-looking permutation still walks the wrong warehouse, and no
smoke test notices. So every discipline here is checked against a distance
computed by hand on a layout written out in full — the arithmetic is in the
comments, leg by leg, so a future reader can re-derive it without running
anything.

The reference layout (3 aisles × 4 pick faces, metres, depot at the origin):

        y=18  •(0,18)      •(10,18)      •(20,18)      <- back cross-aisle
        y=16  •(0,16)      •(10,16)      •(20,16)
                     ...the largest gap in each aisle...
        y= 4  •(0, 4)      •(10, 4)      •(20, 4)
        y= 2  •(0, 2)      •(10, 2)      •(20, 2)      <- front cross-aisle
        y= 0  D                                        <- depot / pack (start)
              x=0          x=10          x=20

Aisle span (from the pick points) = y 2..18, so span = 16 m. The front end is
y=2 (the depot side). Every aisle has picks at depths 0, 2, 14, 16 from the
front, i.e. gaps 0 / 2 / 12 / 2 / 0 — the widest is the 12 m stretch between
y=4 and y=16, which is what largest-gap refuses to walk.
"""

from __future__ import annotations

import random

import simpy

from whsim import picktour, routecompare
from whsim.engine import pickroute
from whsim.engine.build import build
from whsim.engine.processes import _route_order
from whsim.engine.routing import manhattan, nearest_neighbor_route
from whsim.engine.run import run_once
from whsim.schema.model import (
    Bounds,
    Item,
    Location,
    Order,
    OrderLine,
    OrderProfile,
    Station,
    WarehouseModel,
    WorkerGroup,
)

START = (0.0, 0.0)
PTS = [
    (0.0, 2.0), (0.0, 4.0), (0.0, 16.0), (0.0, 18.0),        # 0..3   aisle x=0
    (10.0, 2.0), (10.0, 4.0), (10.0, 16.0), (10.0, 18.0),    # 4..7   aisle x=10
    (20.0, 2.0), (20.0, 4.0), (20.0, 16.0), (20.0, 18.0),    # 8..11  aisle x=20
]


def _len(route, pts=PTS, start=START):
    return picktour.route_length(start, pts, route, manhattan)


# --- 1. hand-computed distances, one policy at a time ---------------------

def test_s_shape_serpentine_order_and_distance():
    """蛇行: aisle x=0 front→back, x=10 back→front, x=20 front→back.

    Legs (Manhattan), depot (0,0) → ... :
        (0,0)→(0,2)    2      (0,18)→(10,18)  10     (10,2)→(20,2)   10
        (0,2)→(0,4)    2      (10,18)→(10,16)  2     (20,2)→(20,4)    2
        (0,4)→(0,16)  12      (10,16)→(10,4)  12     (20,4)→(20,16)  12
        (0,16)→(0,18)  2      (10,4)→(10,2)    2     (20,16)→(20,18)  2
    per aisle: 18 + 26 + 26 = 70 m
    """
    route = pickroute.route_order("s_shape", START, PTS)
    assert route == [0, 1, 2, 3, 7, 6, 5, 4, 8, 9, 10, 11]
    assert _len(route) == 70.0


def test_return_policy_order_and_distance():
    """折り返し: every aisle entered AND left at the front (y=2) end.

    The walk back out is not a visit — the metric charges it as part of the hop
    to the next aisle, e.g. (0,18)→(10,2) = 10 + 16 = 26 m, which is exactly
    "16 m back out of aisle 0, 10 m across, 0 m in" .

        aisle x=0 :  2 + 2 + 12 + 2                      = 18
        (0,18) → (10,2)                                  = 26   (out + across)
        aisle x=10:  2 + 12 + 2                          = 16
        (10,18) → (20,2)                                 = 26   (out + across)
        aisle x=20:  2 + 12 + 2                          = 16
                                                    total = 102 m
    """
    route = pickroute.route_order("return", START, PTS)
    assert route == list(range(12))
    assert _len(route) == 102.0


def test_largest_gap_splits_the_middle_aisle_and_beats_return():
    """最大ギャップ: the 12 m stretch between y=4 and y=16 is never walked.

    Middle aisle (x=10) depths from the front: 0, 2, 14, 16 over a 16 m span, so
    the gaps are [0, 2, 12, 2, 0] and the widest is index 2 → picks at y=2,4 come
    from the FRONT and picks at y=16,18 from the BACK. The first and last pick
    aisles are traversed end to end (that is how the picker reaches the back
    cross-aisle and returns).

    Route: aisle 0 front→back, aisle 10's back half (from the back), aisle 20
    back→front, then home along the front picking aisle 10's front half.

        (0,0)→(0,2)→(0,4)→(0,16)→(0,18)      2+2+12+2   = 18
        (0,18)→(10,18)→(10,16)               10+2       = 12   (back cross-aisle)
        (10,16)→(20,18)→(20,16)              12+2       = 14
        (20,16)→(20,4)→(20,2)                12+2       = 14   (traverse down)
        (20,2)→(10,2)→(10,4)                 10+2       = 12   (front cross-aisle)
                                                  total = 70 m
    vs 折り返し's 102 m — the saving IS the gap it refused to walk (2 × 16 m of
    aisle 10 backtracking, minus the homeward leg it pays instead).
    """
    route = pickroute.route_order("largest_gap", START, PTS)
    assert route == [0, 1, 2, 3, 7, 6, 11, 10, 9, 8, 4, 5]
    assert _len(route) == 70.0
    assert _len(route) < _len(pickroute.route_order("return", START, PTS))


def test_optimized_is_never_worse_than_any_discipline():
    """2-opt (picktour) ≤ every rule-based discipline on the same points.

    Greedy-NN already finds 66 m here by sweeping the two horizontal bands
    (y=2/4 out, y=16/18 back) — Manhattan lets a picker cross between aisles at
    any y, so a band sweep is legal and shorter than any aisle discipline. That
    is the honest reading: the disciplines buy walkability, not metres, whenever
    the metric has no racking in the way."""
    disciplines = {p: _len(pickroute.route_order(p, START, PTS))
                   for p in ("s_shape", "return", "largest_gap")}
    opt = _len(picktour.optimize(START, PTS, manhattan))
    assert opt == 66.0
    assert opt <= min(disciplines.values()) + 1e-9


# --- 2. structure: permutation, determinism, orientation ------------------

def test_every_policy_returns_a_permutation_and_is_deterministic():
    rng = random.Random(4)
    for n_aisles, per_aisle in ((1, 5), (2, 3), (5, 4), (7, 1)):
        pts = [(float(a * 3), float(rng.randint(0, 40)))
               for a in range(n_aisles) for _ in range(per_aisle)]
        for policy in pickroute.POLICIES:
            r1 = pickroute.route_order(policy, START, pts)
            r2 = pickroute.route_order(policy, START, pts)
            assert sorted(r1) == list(range(len(pts))), policy
            assert r1 == r2, policy


def test_unknown_policy_and_degenerate_input_fall_back():
    """never blocks: a typo'd policy still routes (greedy NN), and empty/1-point
    inputs are answered rather than raised on."""
    assert pickroute.route_order("s_shape", START, []) == []
    assert pickroute.route_order("nonsense", START, PTS) == \
        nearest_neighbor_route(START, PTS)
    assert pickroute.route_order("largest_gap", START, [(3.0, 3.0)]) == [0]
    assert pickroute.route_order("", START, PTS) == nearest_neighbor_route(START, PTS)


def test_depot_on_the_far_side_flips_the_aisle_and_front_orientation():
    """The front cross-aisle is the end nearer the depot, and the first aisle
    worked is the one nearer the depot — so a depot at the top-right mirrors the
    reference S-shape exactly."""
    far = (20.0, 20.0)
    route = pickroute.route_order("s_shape", far, PTS)
    # aisles worked x=20, 10, 0 and each entered from the y=18 (front) end
    assert route == [11, 10, 9, 8, 4, 5, 6, 7, 3, 2, 1, 0]
    # mirrored geometry ⇒ the same 70 m walk as the reference case
    assert picktour.route_length(far, PTS, route, manhattan) == 70.0


def test_single_aisle_is_just_a_front_to_back_walk():
    pts = [(5.0, 9.0), (5.0, 1.0), (5.0, 5.0)]
    for policy in pickroute.POLICIES:
        assert pickroute.route_order(policy, (5.0, 0.0), pts) == [1, 2, 0]


# --- 3. the engine really uses it (and the default path does not) ---------

def _engine_model(policy: str | None = None, duration: float = 900.0) -> WarehouseModel:
    """A bare floor (no walls) with the reference pick faces and a depot at (0,0)."""
    m = WarehouseModel()
    m.layout.bounds = Bounds(width=30.0, depth=24.0)
    m.locations = [Location(id=f"L{i}", x=x, y=y, sku=f"S{i}")
                   for i, (x, y) in enumerate(PTS)]
    m.items = [Item(sku=f"S{i}", pick_freq=1.0, ts_per_unit=1.0, default_location=f"L{i}")
               for i in range(len(PTS))]
    m.resources.workers = [WorkerGroup(id="pickers", role="picker", count=2)]
    m.resources.stations = [Station(id="pack", x=0.0, y=0.0, count=2)]
    m.orders.profile = OrderProfile(rate_per_hr=60.0, lines_per_order_mean=4.0)
    m.simulation.duration_s = duration
    m.simulation.random_seed = 11
    if policy is not None:
        m.process.routing_policy = policy
    return m


def _spy_route_order(monkeypatch):
    """Wrap ``pickroute.route_order`` so the test can see whether — and with what
    — the engine reached it. Returns ``(calls, real)``; re-check answers with
    ``real``, never with the patched name (that would record its own probes)."""
    calls: list[tuple] = []
    real = pickroute.route_order

    def spy(policy, start, pts):
        out = real(policy, start, pts)
        calls.append((policy, tuple(start), tuple(pts), tuple(out)))
        return out

    monkeypatch.setattr(pickroute, "route_order", spy)
    return calls, real


def test_engine_routes_with_pickroute_when_the_model_selects_a_discipline(monkeypatch):
    calls, real = _spy_route_order(monkeypatch)
    res = run_once(_engine_model("s_shape"), seed=3)
    assert calls, "the engine never reached pickroute.route_order"
    assert {c[0] for c in calls} == {"s_shape"}
    # what pickroute answered is what the engine asked for (same start & points)
    for policy, start, pts, out in calls:
        assert list(out) == real(policy, start, list(pts))
    assert any(e.get("event") == "pick_done" for e in res.events)


def test_route_order_dispatch_matches_pickroute_exactly():
    """The engine's ``_route_order`` is the dispatcher; for the three disciplines
    it must return pickroute's answer verbatim (no re-sorting on the way out)."""
    for policy in pickroute.POLICIES:
        world = build(_engine_model(policy), simpy.Environment())
        assert world.routing_policy == policy
        assert _route_order(world, START, list(PTS)) == \
            pickroute.route_order(policy, START, list(PTS))


def _signature(res):
    ev = [(e.get("event"), e.get("order_id"), round(e.get("t", 0.0), 3),
           round(e.get("dist", 0.0), 4)) for e in res.events]
    return ev, [tuple(w.keyframes) for w in res.workers]


def test_default_model_is_untouched_by_the_new_policies(monkeypatch):
    """既定不変: a model that never sets ``routing_policy`` stays on "nearest" —
    pickroute is not even called, and repeated runs stay identical."""
    calls, _real = _spy_route_order(monkeypatch)
    m = _engine_model()
    assert m.process.routing_policy == "nearest"
    world = build(m, simpy.Environment())
    assert world.routing_policy == "nearest"
    assert _route_order(world, START, list(PTS)) == nearest_neighbor_route(START, list(PTS))
    a = run_once(_engine_model(), seed=5)
    b = run_once(_engine_model(), seed=5)
    assert _signature(a) == _signature(b)
    assert calls == []


# --- 4. the comparison table ----------------------------------------------

def _compare_model() -> WarehouseModel:
    m = _engine_model()
    m.orders.outbound = [
        Order(order_id=f"O{k}", arrival_s=float(k * 60),
              lines=[OrderLine(sku=f"S{i}", qty=1) for i in range(len(PTS))])
        for k in range(3)
    ]
    return m


def test_compare_reports_every_policy_and_optimized_ties_for_shortest():
    body = routecompare.compare(_compare_model())
    assert set(body["policies"]) == set(routecompare.DEFAULT_POLICIES)
    assert body["n_orders"] == 3
    assert body["has_data"] is True
    totals = {k: v["total_m"] for k, v in body["policies"].items()}
    # 2-opt is seeded from greedy-NN and only accepts improving moves, so it can
    # never be beaten by a rule-based discipline on the same points.
    assert totals["optimized"] <= min(totals.values()) + 1e-6
    assert totals["return"] > totals["s_shape"]        # backtracking costs metres
    best = body["best"]
    assert body["policies"][best]["vs_best_pct"] == 0.0
    assert all(v["vs_best_pct"] >= -1e-9 for v in body["policies"].values())
    # per-order is the total divided by the trips actually routed
    for v in body["policies"].values():
        assert abs(v["per_order_m"] * 3 - v["total_m"]) < 0.05
    assert body["assumptions"] and all(isinstance(a, str) for a in body["assumptions"])


def test_compare_includes_the_current_default_as_a_column():
    body = routecompare.compare(_compare_model(),
                                policies=("nearest", "s_shape", "return", "largest_gap"))
    assert set(body["policies"]) == {"nearest", "s_shape", "return", "largest_gap"}
    assert body["policies"]["nearest"]["label"]


def test_compare_is_deterministic_and_samples_when_no_orders_exist():
    m = _engine_model()          # profile only, no explicit outbound orders
    a = routecompare.compare(m, n_orders=12, seed=7)
    b = routecompare.compare(m, n_orders=12, seed=7)
    assert a == b
    assert a["orders_source"] == "profile"
    assert a["n_orders"] == 12
    c = routecompare.compare(m, n_orders=12, seed=8)
    assert c["policies"] != a["policies"]     # a different seed is a different day


def test_compare_never_blocks_on_an_empty_model():
    body = routecompare.compare(WarehouseModel())
    assert body["has_data"] is False
    assert body["n_orders"] == 0
    assert set(body["policies"]) == set(routecompare.DEFAULT_POLICIES)
    assert all(v["total_m"] == 0.0 and v["vs_best_pct"] == 0.0
               for v in body["policies"].values())
    assert body["assumptions"]


def test_compare_with_an_injected_manhattan_metric_reproduces_the_hand_numbers():
    """Injecting the metric makes the table exactly the by-hand arithmetic above:
    one order over all 12 pick faces from the depot at (0,0) is 70 / 102 / 70 / 66
    metres. (It is also the escape hatch for a caller that already built an aisle
    graph — building one is the slow part.)"""
    m = _engine_model()
    m.orders.outbound = [Order(order_id="O", arrival_s=0.0,
                               lines=[OrderLine(sku=f"S{i}", qty=1)
                                      for i in range(len(PTS))])]
    body = routecompare.compare(m, dist=manhattan,
                                policies=("s_shape", "return", "largest_gap", "optimized"))
    assert body["metric"] == "injected"
    got = {k: v["total_m"] for k, v in body["policies"].items()}
    assert got == {"s_shape": 70.0, "return": 102.0, "largest_gap": 70.0, "optimized": 66.0}
    assert body["best"] == "optimized"
    # 折り返し walks 54.55% further than the 2-opt tour: (102-66)/66
    assert body["policies"]["return"]["vs_best_pct"] == 54.55


def test_compare_accepts_explicit_orders_and_skips_unplaced_skus():
    m = _engine_model()
    orders = [Order(order_id="X", arrival_s=0.0,
                    lines=[OrderLine(sku="S0", qty=1), OrderLine(sku="NOPE", qty=1),
                           OrderLine(sku="S11", qty=1)])]
    body = routecompare.compare(m, orders=orders)
    assert body["orders_source"] == "given"
    assert body["n_orders"] == 1
    assert body["policies"]["s_shape"]["total_m"] > 0.0
