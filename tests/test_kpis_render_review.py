"""Regression tests for the KPIs / rendering / export review.

Each test targets a concrete defect found during review (and the never-blocks
invariant: a degenerate / empty run must still produce sane KPIs and artifacts
rather than crashing).
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from whsim import export_doc, kpis
from whsim.engine.run import RunResult, run_once
from whsim.render import anim2d, png2d
from whsim.render.replay import build_replay
from whsim.schema.model import WarehouseModel


def _finite_floats(d: dict) -> None:
    for k, v in d.items():
        if isinstance(v, float):
            assert math.isfinite(v), f"{k} is not finite: {v!r}"


# --- kpis.py -----------------------------------------------------------------

def test_zero_duration_run_does_not_divide_by_zero():
    """BUG: `hours` was recomputed unguarded in the cost block, re-introducing a
    divide-by-zero in throughput_per_hr for a zero-duration run."""
    r = RunResult(events=[], heat=np.zeros((2, 2)),
                  n_pickers=0, n_packers=0, duration_s=0.0)
    out = kpis.compute([r])  # must not raise
    assert out["throughput_per_hr"] == 0.0
    assert out["orders_completed"] == 0
    _finite_floats(out)


def test_no_orders_run_is_sane_and_finite():
    """An empty event log (no orders) must yield finite, bounded KPIs."""
    r = RunResult(events=[], heat=np.zeros((4, 4)),
                  n_pickers=3, n_packers=2, duration_s=3600.0)
    out = kpis.compute([r])
    _finite_floats(out)
    assert out["completion_rate"] == 1.0          # nothing to fail
    assert out["on_time_rate"] == 1.0
    assert 0.0 <= out["picker_utilization"] <= 1.0
    assert 0.0 <= out["robustness"] <= 1.0
    assert isinstance(out["verdict"], str) and out["verdict"]


def test_utilizations_and_rates_stay_in_range_on_real_run():
    m = WarehouseModel()
    m.simulation.duration_s = 1800.0
    res = run_once(m)
    out = kpis.compute([res])
    _finite_floats(out)
    for k in ("picker_utilization", "packer_utilization", "completion_rate",
              "on_time_rate", "robustness", "bottleneck_utilization"):
        assert 0.0 <= out[k] <= 1.0 + 1e-9, f"{k} out of range: {out[k]}"


def test_verdict_matches_can_handle_flag():
    m = WarehouseModel()
    m.simulation.duration_s = 1800.0
    out = kpis.compute([run_once(m)])
    if out["can_handle_demand"]:
        assert out["verdict"].startswith("対応可能")
    else:
        assert out["verdict"].startswith("要注意")


# --- render/replay.py --------------------------------------------------------

def test_replay_contract_has_required_meta_fields():
    m = WarehouseModel()
    m.simulation.duration_s = 60.0
    res = run_once(m)
    rep = build_replay(m, res, kpis.compute([res]))
    meta = rep["meta"]
    for field in ("duration_s", "replay_window_s", "bounds", "grid_m", "name"):
        assert field in meta, f"replay meta missing {field}"
    assert {"width", "depth"} <= set(meta["bounds"])
    for agent in ("workers", "agvs", "forklifts"):
        assert agent in rep


# --- render/png2d.py ---------------------------------------------------------

def _min_kpis() -> dict:
    return {
        "can_handle_demand": True, "verdict": "テスト判定",
        "throughput_per_hr": 0, "orders_completed": 0, "orders_arrived": 0,
        "bottleneck_jp": "", "bottleneck_utilization": 0.0,
        "n_pickers": 0, "picker_utilization": 0.0,
        "n_packers": 0, "packer_utilization": 0.0,
        "cycle_p50_s": 0.0, "cycle_p95_s": 0.0, "walk_per_order_m": 0.0,
    }


def test_png_render_degenerate_geometry(tmp_path):
    """Zero-size bounds and no locations must still emit a real PNG."""
    m = WarehouseModel()
    m.layout.bounds.width = 0.0
    m.layout.bounds.depth = 0.0
    out = png2d.render(m, np.zeros((4, 4)), _min_kpis(), "出所テスト",
                       tmp_path / "degenerate.png")
    assert out.is_file()
    assert out.stat().st_size > 5_000


def test_png_render_real_run(tmp_path):
    m = WarehouseModel()
    m.simulation.duration_s = 900.0
    res = run_once(m)
    out = png2d.render(m, res.heat, kpis.compute([res]), "出所", tmp_path / "r.png")
    assert out.is_file() and out.stat().st_size > 5_000


# --- render/anim2d.py --------------------------------------------------------

def test_gif_render_empty_replay(tmp_path):
    """BUG: set_offsets([]) raised IndexError when a run has zero workers."""
    replay = {
        "meta": {"name": "空", "bounds": {"width": 10, "depth": 10},
                 "duration_s": 0.0, "replay_window_s": 0.0},
        "zones": [], "racks": [], "stations": [], "workers": [], "kpis": {},
    }
    out = anim2d.render_gif(replay, tmp_path / "empty.gif", seconds=1, fps=4)
    assert out.is_file() and out.stat().st_size > 0


def test_gif_render_real_replay(tmp_path):
    m = WarehouseModel()
    m.simulation.duration_s = 120.0
    res = run_once(m)
    replay = build_replay(m, res, kpis.compute([res]))
    out = anim2d.render_gif(replay, tmp_path / "r.gif", seconds=1, fps=4)
    assert out.is_file() and out.stat().st_size > 0


# --- export_doc.py -----------------------------------------------------------

def test_export_handles_empty_kpis(tmp_path):
    p1 = export_doc.build_pptx({}, "X社", "", None, tmp_path / "e.pptx")
    p2 = export_doc.build_pdf({}, "X社", "", None, tmp_path / "e.pdf")
    assert p1.is_file() and p1.stat().st_size > 1_000
    assert p2.is_file() and p2.stat().st_size > 1_000


def test_export_cjk_font_resolves():
    """A CJK-capable font name must always come back (TTC or CID fallback)."""
    name = export_doc._register_cjk_font()
    assert name and isinstance(name, str)


def test_export_full_kpis_and_png(tmp_path):
    m = WarehouseModel()
    m.simulation.duration_s = 600.0
    res = run_once(m)
    metrics = kpis.compute([res])
    png = png2d.render(m, res.heat, metrics, "出所", tmp_path / "layout.png")
    pptx = export_doc.build_pptx(metrics, "物流C", "62%自社データ", png,
                                 tmp_path / "p.pptx")
    pdf = export_doc.build_pdf(metrics, "物流C", "62%自社データ", png,
                               tmp_path / "p.pdf")
    assert pptx.stat().st_size > 1_000
    assert pdf.stat().st_size > 1_000


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
