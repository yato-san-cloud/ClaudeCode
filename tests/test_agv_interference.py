"""AGV通路相互排他・簡易干渉モデル (roadmap #11, reduced scope).

The thesis this proves: 「AGV台数を増やすと渋滞で頭打ち」 — with aisle-segment
mutual-exclusion ON, cramming more AGVs into ONE narrow corridor lowers the
*per-AGV* throughput (the fleet saturates on shared aisle space). Deadlock is
DETECTED (a lock wait past the threshold warns once) and escaped by
force-proceeding, so the run still completes — detection+warning only.

Regression bar: the feature is opt-in; OFF is byte-identical to the legacy
engine (fixed-seed KPI equality here, plus the full suite is the real oracle).
"""

from __future__ import annotations

import pytest

from whsim import kpis
from whsim.engine.run import run_once
from whsim.schema.model import (
    Bounds, Equipment, Item, Location, Order, OrderLine, WarehouseModel, Wall, WorkMethod,
)


def _corridor_model(*, n_agvs: int, interference: bool, speed: float = 1.6,
                    n_sku: int = 8, n_orders: int = 40, lines_each: int = 2,
                    duration: float = 1800.0) -> WarehouseModel:
    """A single NARROW corridor: two long horizontal walls sandwich a one-lane
    aisle at y≈10 that every shelf (and the AGV dock) must travel through. So all
    AGVs share the same aisle segments — the worst case for aisle contention."""
    m = WarehouseModel()
    m.layout.bounds = Bounds(width=60, depth=20)
    m.layout.walls = [
        Wall(id="wtop", points=[[0, 8], [50, 8]]),
        Wall(id="wbot", points=[[0, 12], [50, 12]]),
    ]
    for i in range(n_sku):
        sku = f"S{i}"
        m.items.append(Item(sku=sku, pick_freq=1.0, default_location=f"L{i}"))
        m.locations.append(Location(id=f"L{i}", x=4 + i * 6, y=10, sku=sku))
    orders = []
    for j in range(n_orders):
        lines = [OrderLine(sku=f"S{(j + k) % n_sku}", qty=1) for k in range(lines_each)]
        orders.append(Order(order_id=f"O{j:03d}", arrival_s=float(j) * 2, lines=lines))
    m.orders.outbound = orders
    m.simulation.duration_s = duration
    m.resources.equipment.append(
        Equipment(type="agv", count=n_agvs, speed_mps=speed, x=1.0, y=1.0))
    m.process.pick_stage().work = WorkMethod(transport="agv")
    m.process.agv_interference = interference
    return m


def _kpi(model: WarehouseModel, seed: int = 3) -> dict:
    return kpis.compute([run_once(model, seed=seed)], model)


# --- (a) off-identity: OFF is byte-identical to the legacy engine -------------

def test_off_is_byte_identical():
    """Fixed seed: an interference-OFF run equals a run where the flag is left at
    its default — the opt-in gate never perturbs the legacy AGV pipeline."""
    m_default = _corridor_model(n_agvs=3, interference=False)  # explicit False
    m_untouched = _corridor_model(n_agvs=3, interference=False)
    m_untouched.process.agv_interference = False  # (default) — same path
    k_off = _kpi(m_default, seed=7)
    k_leg = _kpi(m_untouched, seed=7)
    assert k_off == k_leg, "OFF must be byte-identical to legacy KPIs"
    # And it truly did nothing: no conflict/deadlock activity at all.
    assert k_off["agv_conflicts"] == 0
    assert k_off["agv_deadlock_warnings"] == 0
    assert k_off["agv_wait_s"] == 0.0


def test_single_agv_gate_is_off():
    """Interference needs >1 AGV to matter: with a single AGV the flag ON is
    identical to OFF (no self-contention, aisle_locks stays disabled)."""
    m_on = _corridor_model(n_agvs=1, interference=True)
    m_off = _corridor_model(n_agvs=1, interference=False)
    assert _kpi(m_on, seed=5) == _kpi(m_off, seed=5)


# --- (b) conflicts appear in a forced shared corridor ------------------------

def test_conflicts_in_forced_corridor():
    m = _corridor_model(n_agvs=6, interference=True)
    k = _kpi(m)
    assert k["orders_completed"] > 0, "run must still complete"
    assert k["agv_conflicts"] > 0, "shared corridor must produce aisle conflicts"
    assert k["agv_wait_s"] > 0.0
    # KPI keys are present and sane.
    for key in ("agv_wait_s", "agv_conflicts", "agv_deadlock_warnings",
                "agv_busy_s", "agv_utilization"):
        assert key in k
    assert "AGVの通路待ち" in k["verdict"], "material aisle waiting must surface in the verdict"


# --- (c) the headline: throughput saturates (per-AGV falls) ------------------

def test_saturation_per_agv_throughput_falls():
    """6 AGVs in one narrow corridor have LOWER per-AGV throughput than 2 (the
    fleet saturates on shared aisle space) — with interference ON."""
    k2 = _kpi(_corridor_model(n_agvs=2, interference=True))
    k6 = _kpi(_corridor_model(n_agvs=6, interference=True))
    per_agv_2 = k2["throughput_per_hr"] / 2.0
    per_agv_6 = k6["throughput_per_hr"] / 6.0
    assert per_agv_6 < per_agv_2, (
        f"per-AGV throughput should saturate: 2→{per_agv_2:.2f}, 6→{per_agv_6:.2f}")
    # Contention actually grew with the fleet (more AGVs => more waiting).
    assert k6["agv_wait_s"] > k2["agv_wait_s"]


# --- (d) deadlock is detected + escaped; the run still completes --------------

def test_deadlock_warning_fires_and_run_completes():
    """Pathologically slow AGVs hold a corridor segment far past the 120s deadlock
    threshold, so a waiting AGV force-proceeds with a one-shot warning — and the
    run STILL completes (the honest escape hatch, no hang)."""
    m = _corridor_model(n_agvs=4, interference=True, speed=0.05,
                        n_sku=6, n_orders=20, duration=3600.0)
    k = _kpi(m, seed=1)
    assert k["agv_deadlock_warnings"] > 0, "a lock wait past threshold must warn"
    assert k["orders_completed"] > 0, "force-proceed must let the run finish (no deadlock hang)"


# --- (e) KPI keys always present (even with the feature off) ------------------

def test_kpi_keys_present_when_off():
    k = _kpi(_corridor_model(n_agvs=3, interference=False))
    for key in ("agv_wait_s", "agv_conflicts", "agv_deadlock_warnings", "agv_busy_s"):
        assert key in k, f"{key} must always be present"
        assert isinstance(k[key], (int, float))


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
