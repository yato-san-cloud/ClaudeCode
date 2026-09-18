"""Engine tests for the automatic sorter (ソーターDESプロセス).

トータルピッキング＆店舗別仕分け: when a sorter Equipment is placed and the pick
stage uses total picking (consolidation=="sort"), the sort phase becomes an
AUTOMATIC piece sorter (induction channels + destination chutes with back-pressure)
instead of the manual put wall — the core of a convenience-store DC proposal.

The regression bar: NO sorter => the manual put-wall path is used, byte-identical
to before (see also test_workmethod_engine.py).
"""

from __future__ import annotations

import pytest

from whsim import kpis
from whsim.engine.run import run_once
from whsim.schema.model import (
    Bounds, Equipment, Item, Location, Order, OrderLine, WarehouseModel, WorkMethod,
)
from whsim.workmethod import METHOD_PRESETS


def _sort_model(*, sorter: Equipment | None = None, n_orders: int = 20,
                lines_each: int = 3, rate: float = 3600.0, duration: float = 3600.0,
                orders_per_trip: int = 16) -> WarehouseModel:
    """Few SKUs, many destinations, explicit orders — the classic total-picking
    case. Optionally place a sorter Equipment. Explicit orders keep line counts
    and chute assignment (id hash) deterministic."""
    m = WarehouseModel()
    m.layout.bounds = Bounds(width=60, depth=30)
    n_sku = 6
    for i in range(n_sku):
        sku = f"S{i}"
        m.items.append(Item(sku=sku, pick_freq=1.0, default_location=f"L{i}"))
        m.locations.append(Location(id=f"L{i}", x=5 + i * 8, y=20, sku=sku))
    orders = []
    for j in range(n_orders):
        lines = [OrderLine(sku=f"S{(j + k) % n_sku}", qty=1) for k in range(lines_each)]
        orders.append(Order(order_id=f"O{j:03d}", arrival_s=float(j), lines=lines))
    m.orders.outbound = orders
    m.simulation.duration_s = duration
    m.process.pick_stage().work = WorkMethod(
        consolidation="sort", orders_per_trip=orders_per_trip)
    if sorter is not None:
        m.resources.equipment.append(sorter)
    return m


def _kpi(model):
    res = run_once(model, replay_window_s=0.0)
    return kpis.compute([res], model), res


# --- (a) no-sorter regression: the manual put wall is still used --------------

def test_no_sorter_uses_manual_put_wall():
    m = _sort_model(sorter=None)
    k, res = _kpi(m)
    sort_done = [e for e in res.events if e["event"] == "sort_done"]
    sorter_done = [e for e in res.events if e["event"] == "sorter_done"]
    assert sort_done, "manual put-wall sort_done events expected when no sorter"
    assert not sorter_done, "no automatic sorter => no sorter_done events"
    assert k["n_put_wall"] >= 1
    assert k["sort_utilization"] > 0.0
    assert k["sorter_channels"] == 0
    assert k["sorter_busy_s"] == 0.0
    assert k["orders_completed"] > 0


# --- (b) with a sorter: automatic sortation replaces the manual wall ----------

def test_sorter_replaces_manual_wall():
    srt = Equipment(id="srt", type="sorter", count=1, x=5.0, y=5.0,
                    sorter_rate_per_hr=3600.0, chutes=40, chute_capacity=50,
                    induction_workers=2)
    m = _sort_model(sorter=srt)
    k, res = _kpi(m)
    sort_done = [e for e in res.events if e["event"] == "sort_done"]
    sorter_done = [e for e in res.events if e["event"] == "sorter_done"]
    assert sorter_done, "sorter_done events expected when a sorter is placed"
    assert not sort_done, "the manual put wall must NOT be used when a sorter exists"
    # sorter KPIs present and sane
    assert k["sorter_channels"] == 2
    assert k["sorter_busy_s"] > 0.0
    assert k["sorter_throughput_per_hr"] > 0.0
    assert 0.0 <= k["sorter_utilization"] <= 1.0
    # the manual-wall KPIs report nothing (only one of the two is ever used)
    assert k["n_put_wall"] == 0
    assert k["sort_utilization"] == 0.0
    assert k["orders_completed"] > 0


# --- (c) rate math: total sorter busy == n_lines * (3600/rate) ----------------

def test_sorter_busy_matches_rate_math():
    rate = 1800.0  # 2.0 s per line
    srt = Equipment(id="srt", type="sorter", count=1, x=5.0, y=5.0,
                    sorter_rate_per_hr=rate, chutes=64, chute_capacity=200,
                    induction_workers=3, chute_release_s=1.0)
    m = _sort_model(sorter=srt, n_orders=20, lines_each=3, rate=rate,
                    duration=7200.0)
    _, res = _kpi(m)
    sorter_done = [e for e in res.events if e["event"] == "sorter_done"]
    n_lines = 20 * 3
    assert len(sorter_done) == n_lines, "every order line is inducted exactly once"
    expected_busy = n_lines * (3600.0 / rate)
    got_busy = sum(e["busy"] for e in sorter_done)
    assert got_busy == pytest.approx(expected_busy)


# --- (d) chute blocking: a tiny chute back-pressures induction ----------------

def test_tiny_chute_capacity_blocks():
    # One chute, capacity 1, a slow carton pull: lines pile up and induction waits.
    srt = Equipment(id="srt", type="sorter", count=1, x=5.0, y=5.0,
                    sorter_rate_per_hr=7200.0, chutes=1, chute_capacity=1,
                    induction_workers=2, chute_release_s=60.0)
    m = _sort_model(sorter=srt, n_orders=20, lines_each=3, rate=7200.0)
    k, res = _kpi(m)
    blocked = sum(e.get("blocked", 0) for e in res.events
                  if e["event"] == "sorter_done")
    chute_wait = sum(e.get("chute_wait", 0.0) for e in res.events
                     if e["event"] == "sorter_done")
    assert blocked > 0, "a full chute must back-pressure induction (blocks)"
    assert chute_wait > 0.0
    assert k["sorter_chute_blocks"] > 0


# --- (e) throughput bound: doubling the rate halves sorter busy ---------------

def test_doubling_rate_reduces_busy():
    def busy(rate):
        srt = Equipment(id="srt", type="sorter", count=1, x=5.0, y=5.0,
                        sorter_rate_per_hr=rate, chutes=64, chute_capacity=200,
                        induction_workers=3, chute_release_s=1.0)
        m = _sort_model(sorter=srt, n_orders=24, lines_each=4, rate=rate,
                        duration=7200.0)
        _, res = _kpi(m)
        return sum(e["busy"] for e in res.events if e["event"] == "sorter_done")

    slow = busy(900.0)
    fast = busy(1800.0)
    assert fast < slow
    assert fast == pytest.approx(slow / 2.0, rel=1e-6)


# --- (f) workcompare integration: the トータル preset picks up the sorter -------

def test_total_preset_uses_sorter_when_present():
    """POST /workmethod/compare runs the same engine per preset; the トータル row
    (consolidation=="sort") must automatically route through the sorter when one
    is placed, shifting work off the manual put wall."""
    total = next(p for p in METHOD_PRESETS if p["id"] == "total")

    def run(with_sorter: bool):
        m = _sort_model(sorter=None, n_orders=24, lines_each=3,
                        orders_per_trip=total["work"]["orders_per_trip"])
        m.process.pick_stage().work = WorkMethod(**total["work"])
        if with_sorter:
            m.resources.equipment.append(
                Equipment(id="srt", type="sorter", count=1, x=5.0, y=5.0,
                          sorter_rate_per_hr=3600.0, chutes=40, chute_capacity=50,
                          induction_workers=2))
        k, res = _kpi(m)
        return k, res

    manual_k, manual_res = run(with_sorter=False)
    sorter_k, sorter_res = run(with_sorter=True)

    # manual total picking: put-wall busy > 0, no sorter activity
    assert manual_k["sort_busy_s"] > 0.0
    assert manual_k["sorter_channels"] == 0
    # with a sorter: the put-wall work SHIFTS onto the sorter
    assert sorter_k["sorter_busy_s"] > 0.0
    assert sorter_k["sort_busy_s"] == 0.0
    assert any(e["event"] == "sorter_done" for e in sorter_res.events)
    assert not any(e["event"] == "sort_done" for e in sorter_res.events)
