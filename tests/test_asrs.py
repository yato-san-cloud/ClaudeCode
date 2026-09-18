"""AS/RS crane cycle-time model — FEM 9.851 / Bozer-White analytic times.

Hand-checks the closed-form single/dual-command cycle times against the textbook
special cases (b=1 square-in-time rack, b=0 degenerate rack), the throughput
conversion, and the crane-count sizing. Pure math — no DES, no I/O.
"""

import math

import pytest

from whsim import asrs


def test_square_in_time_rack_matches_textbook():
    # b = 1 when the horizontal and vertical traverse times are equal
    # (L/vx == H/vy). Here w = h = 20 s ⇒ T = 20, b = 1.
    c = asrs.cycle_times(L=40, H=40, vx=2.0, vy=2.0, t_fix=5.0)
    assert c["T"] == pytest.approx(20.0)
    assert c["b"] == pytest.approx(1.0)
    # E(SC) = 4/3·T + 2·t_fix ; E(DC) = 9/5·T + 4·t_fix   (b=1)
    assert c["e_sc"] == pytest.approx(4 / 3 * 20 + 2 * 5)
    assert c["e_dc"] == pytest.approx(1.8 * 20 + 4 * 5)


def test_degenerate_rack_reduces_to_single_axis():
    # H = 0 ⇒ b = 0: E(SC) = T + 2·t_fix, E(DC) = 4/3·T + 4·t_fix.
    c = asrs.cycle_times(L=40, H=0, vx=2.0, vy=2.0, t_fix=5.0)
    assert c["b"] == pytest.approx(0.0)
    assert c["T"] == pytest.approx(20.0)
    assert c["e_sc"] == pytest.approx(20 + 2 * 5)
    assert c["e_dc"] == pytest.approx(4 / 3 * 20 + 4 * 5)


def test_general_shape_factor_formula():
    # A non-square rack: w = 40/2.5 = 16, h = 18/0.5 = 36 ⇒ T = 36, b = 16/36.
    c = asrs.cycle_times(L=40, H=18, vx=2.5, vy=0.5, t_fix=8.0)
    T, b = 36.0, 16.0 / 36.0
    assert c["T"] == pytest.approx(T)
    assert c["b"] == pytest.approx(b)
    assert c["e_sc"] == pytest.approx(T * (1 + b * b / 3) + 2 * 8)
    assert c["e_dc"] == pytest.approx(T * (4 / 3 + b * b / 2 - b**3 / 30) + 4 * 8)


def test_dual_command_is_more_efficient_per_pallet():
    # E(DC) > E(SC) (a dual trip is longer) but moves 2 pallets, so it is
    # cheaper PER pallet: E(DC)/2 < E(SC).
    c = asrs.cycle_times(L=45, H=18, vx=2.5, vy=0.5, t_fix=8.0)
    assert c["e_dc"] > c["e_sc"]
    assert c["e_dc"] / 2 < c["e_sc"]


def test_throughput_pallets_conversion():
    tp = asrs.throughput(e_sc=60.0, e_dc=90.0)
    assert tp["sc_cycles_per_h"] == pytest.approx(60.0)      # 3600/60
    assert tp["dc_cycles_per_h"] == pytest.approx(40.0)      # 3600/90
    assert tp["sc_pallets_per_h"] == pytest.approx(60.0)     # 1 pallet / SC
    assert tp["dc_pallets_per_h"] == pytest.approx(80.0)     # 2 pallets / DC


def test_cranes_required_ceils_and_floors():
    assert asrs.cranes_required(0.0, 40.0) == 0        # no demand ⇒ no crane
    assert asrs.cranes_required(40.0, 40.0) == 1       # exactly one
    assert asrs.cranes_required(41.0, 40.0) == 2       # ceil
    assert asrs.cranes_required(5.0, 0.0) == 0         # crane can do nothing


def test_size_asrs_full_payload_and_monotonicity():
    s = asrs.size_asrs(L=45, H=18, vx=2.5, vy=0.5, t_fix=8.0, out_per_h=60)
    # required keys the storage payload / UI relies on
    for k in ("e_sc_s", "e_dc_s", "dc_cycles_per_h", "cranes", "shape_b",
              "cranes_single", "cranes_dual", "demand_out_per_h"):
        assert k in s
    assert s["e_sc_s"] < s["e_dc_s"]
    assert s["cranes"] >= 1
    # more demand ⇒ never fewer cranes
    hi = asrs.size_asrs(45, 18, 2.5, 0.5, 8.0, out_per_h=600)
    assert hi["cranes"] >= s["cranes"]


def test_command_basis_selects_the_right_count():
    dual = asrs.size_asrs(45, 18, 2.5, 0.5, 8.0, out_per_h=120, command="dual")
    single = asrs.size_asrs(45, 18, 2.5, 0.5, 8.0, out_per_h=120, command="single")
    assert dual["command"] == "dual" and single["command"] == "single"
    assert dual["cranes"] == dual["cranes_dual"]
    assert single["cranes"] == single["cranes_single"]


def test_never_blocks_on_zero_or_negative_inputs():
    # zero speeds / sizes must not raise or divide-by-zero
    c = asrs.cycle_times(L=0, H=0, vx=0, vy=0, t_fix=0)
    assert math.isfinite(c["e_sc"]) and math.isfinite(c["e_dc"])
    assert c["e_sc"] == 0.0 and c["e_dc"] == 0.0
    s = asrs.size_asrs(0, 0, 0, 0, 0, out_per_h=-5)
    assert s["cranes"] == 0
    tp = asrs.throughput(0.0, 0.0)
    assert tp["dc_pallets_per_h"] == 0.0
