"""コンベア描画: the proposal PNG and the replay GIF must show the belt.

Both renderers used to omit conveyors entirely, so the customer-facing sheet of
a pick-to-belt DC showed a 99 m takeaway line as… nothing. These tests pin the
belt symbol down (band at its real width, roller ticks, direction-of-travel
arrowheads, marked discharge, 凡例 + spec) and the never-blocks rules around it:
no conveyor ⇒ byte-identical output, a degenerate line never crashes.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from whsim import kpis as kpi_mod
from whsim import templates
from whsim.engine.run import run_once
from whsim.render import anim2d, png2d
from whsim.render.replay import build_replay
from whsim.schema.model import Bounds, Conveyor, Station, WarehouseModel, Zone

STRAIGHT = [[0.0, 10.0], [50.0, 10.0]]
BENT = [[5.0, 10.0], [45.0, 10.0], [45.0, 2.0]]


# --- pure belt geometry ------------------------------------------------------

def test_belt_points_drops_junk_and_merges_straight_runs():
    assert png2d.belt_points(None) == []
    assert png2d.belt_points([[1.0, 2.0]]) == [(1.0, 2.0)]
    assert png2d.belt_points([["x", 1], [None, None], [3, 4]]) == [(3.0, 4.0)]
    assert png2d.belt_points([[float("nan"), 1.0], [float("inf"), 2.0]]) == []
    # repeated vertices collapse
    assert png2d.belt_points([[0, 0], [0, 0], [5, 0]]) == [(0.0, 0.0), (5.0, 0.0)]
    # a MapMaker-style run with a vertex every few metres is ONE straight leg
    dense = [[float(x), 6.0] for x in range(0, 41, 4)]
    assert png2d.belt_points(dense) == [(0.0, 6.0), (40.0, 6.0)]
    # …but a real corner is kept, and so is a 180° switchback
    assert png2d.belt_points(BENT) == [(5.0, 10.0), (45.0, 10.0), (45.0, 2.0)]
    assert len(png2d.belt_points([[0, 0], [10, 0], [0, 0]])) == 3


def test_belt_length_and_belt_at_walk_the_polyline():
    pts = png2d.belt_points(BENT)
    assert math.isclose(png2d.belt_length(pts), 48.0)
    assert png2d.belt_length([]) == 0.0
    x, y, ux, uy = png2d.belt_at(pts, 0.0)
    assert (x, y) == (5.0, 10.0) and (ux, uy) == (1.0, 0.0)
    x, y, ux, uy = png2d.belt_at(pts, 20.0)             # on the first leg
    assert (x, y) == (25.0, 10.0) and (ux, uy) == (1.0, 0.0)
    x, y, ux, uy = png2d.belt_at(pts, 44.0)             # after the corner
    assert (x, y) == (45.0, 6.0) and (ux, uy) == (0.0, -1.0)
    # clamped at both ends, and never divides by zero on a degenerate input
    assert png2d.belt_at(pts, 999.0)[:2] == (45.0, 2.0)
    assert png2d.belt_at([], 3.0) == (0.0, 0.0, 1.0, 0.0)
    assert png2d.belt_at([(2.0, 3.0)], 3.0)[:2] == (2.0, 3.0)


def test_belt_band_is_a_closed_band_of_the_real_width():
    band = png2d.belt_band(STRAIGHT, 0.6)
    assert len(band) == 4                                   # 2 ends × 2 sides
    ys = sorted({round(p[1], 6) for p in band})
    assert ys == [9.7, 10.3]                                # ±0.3 m about the line
    assert sorted({round(p[0], 6) for p in band}) == [0.0, 50.0]
    # the mitred corner of an L keeps the band width through the turn
    bent = png2d.belt_band(BENT, 0.6)
    assert len(bent) == 6
    for px, py in bent:
        assert min(abs(py - 10.0), abs(px - 45.0)) <= 0.45  # no miter spike
    # degenerate input yields no band rather than a crash
    assert png2d.belt_band([[1, 1]], 0.6) == []
    assert png2d.belt_band(STRAIGHT, 0.0) == []
    assert png2d.belt_band([[0, 0], [10, 0], [0, 0]], 0.6)  # switchback is drawable


def test_belt_specs_keeps_only_real_transport():
    m = WarehouseModel()
    m.resources.conveyors = [
        Conveyor(id="real", points=STRAIGHT, speed_mps=0.8),
        Conveyor(id="empty", points=[], speed_mps=1.0),
        Conveyor(id="dot", points=[[5.0, 5.0]], speed_mps=1.0),
        Conveyor(id="zero", points=[[5.0, 5.0], [5.0, 5.0]], speed_mps=1.0),
        Conveyor(id="nan", points=[[float("nan"), 1.0], [2.0, 2.0]], speed_mps=1.0),
        Conveyor(id="badspeed", points=BENT, speed_mps=float("nan")),
    ]
    specs = png2d.belt_specs(m)
    assert [s["id"] for s in specs] == ["real", "badspeed"]
    assert specs[0]["length_m"] == 50.0 and specs[0]["speed_mps"] == 0.8
    assert specs[1]["speed_mps"] == 0.0                     # unusable → not quoted
    assert png2d._belt_spec(specs[0], " ・ ") == "50 m ・ 0.8 m/s"
    assert png2d._belt_spec(specs[1], " ・ ") == "48 m"
    assert png2d.belt_specs(WarehouseModel()) == []


# --- the sheet ---------------------------------------------------------------

def _capture(monkeypatch) -> dict:
    """Grab the finished figure's texts / gids just before png2d closes it."""
    grabbed: dict = {"texts": [], "gids": [], "strip": []}
    real_close = png2d.plt.close

    def _close(fig):
        for art in fig.findobj():
            gid = art.get_gid()
            if gid:
                grabbed["gids"].append(gid)
        grabbed["texts"] = [t.get_text() for ax in fig.axes for t in ax.texts]
        # the legend/scale strip is the axes carrying the congestion colourbar
        for ax in fig.axes:
            labels = [t.get_text() for t in ax.texts]
            if "混雑度（通過回数）" in labels:
                grabbed["strip"] = labels
        real_close(fig)

    monkeypatch.setattr(png2d.plt, "close", _close)
    return grabbed


def _belt_model() -> WarehouseModel:
    m = WarehouseModel()
    m.meta.name = "コンベア検証"
    m.layout.bounds = Bounds(width=60.0, depth=30.0)
    m.layout.zones = [Zone(id="pk", type="picking", x=18.0, y=4.0, w=38.0, h=22.0)]
    m.resources.stations = [Station(id="pack", x=6.0, y=16.0, count=2)]
    m.resources.conveyors = [
        Conveyor(id="takeaway", points=[[54, 8], [30, 8], [18, 8], [18, 16], [12, 16]],
                 speed_mps=0.8)]
    return m


def test_conveyor_is_drawn_as_a_belt_and_named_in_the_legend(tmp_path, monkeypatch):
    grabbed = _capture(monkeypatch)
    out = png2d.render(_belt_model(), np.zeros((4, 4)), {}, "出所", tmp_path / "b.png",
                       dpi=90)
    assert out.is_file() and out.stat().st_size > 5_000
    # the band, its roller hatching and the travel arrowheads are all on the sheet
    assert grabbed["gids"].count("whsim-conveyor-band") == 1
    assert "whsim-conveyor-rollers" in grabbed["gids"]
    # several travel arrows + the heavier discharge glyph
    assert grabbed["gids"].count("whsim-conveyor-arrow") >= 3
    assert "コンベア" in grabbed["strip"]                    # 凡例
    # the equipment tag on the plan quotes the spec a customer asks for…
    assert "コンベア 50 m ・ 0.8 m/s" in grabbed["texts"], grabbed["texts"]
    # …and so does the 搬送設備 list in the panel
    assert "搬送設備" in grabbed["texts"] and "50 m ／ 0.8 m/s" in grabbed["texts"]
    assert "排出" in grabbed["texts"]                        # the discharge is named


def test_pick_to_belt_template_shows_its_99m_line(tmp_path, monkeypatch):
    grabbed = _capture(monkeypatch)
    m = templates.load_template_model("pick_to_belt")
    png2d.render(m, np.zeros((4, 4)), {}, "出所", tmp_path / "t.png", dpi=90)
    assert "whsim-conveyor-band" in grabbed["gids"]
    assert "コンベア" in grabbed["strip"]
    # the 21-vertex polyline is ONE 99 m line, quoted with its speed
    assert any("99 m" in t and "0.8 m/s" in t for t in grabbed["texts"])


def test_no_conveyor_sheet_never_mentions_or_draws_one(tmp_path, monkeypatch):
    grabbed = _capture(monkeypatch)
    png2d.render(WarehouseModel(), np.zeros((4, 4)), {}, "出所", tmp_path / "n.png",
                 dpi=90)
    assert not [g for g in grabbed["gids"] if g.startswith("whsim-conveyor")]
    assert not [t for t in grabbed["texts"] if "コンベア" in t or "搬送設備" in t]


def test_absent_conveyor_output_is_unchanged(tmp_path):
    """Degenerate lines are treated as absent: the sheet is byte-identical to the
    one drawn for a model that carries no conveyor at all (never-blocks)."""
    plain = WarehouseModel()
    a = png2d.render(plain, np.zeros((4, 4)), {}, "出所", tmp_path / "a.png", dpi=90)
    junk = WarehouseModel()
    junk.resources.conveyors = [
        Conveyor(id="empty", points=[], speed_mps=1.0),
        Conveyor(id="dot", points=[[5.0, 5.0]], speed_mps=1.0),
        Conveyor(id="zero", points=[[5.0, 5.0], [5.0, 5.0]], speed_mps=1.0),
        Conveyor(id="nan", points=[[float("nan"), float("inf")], [1.0, 2.0]],
                 speed_mps=1.0),
    ]
    b = png2d.render(junk, np.zeros((4, 4)), {}, "出所", tmp_path / "b.png", dpi=90)
    assert a.read_bytes() == b.read_bytes()


def test_degenerate_and_extreme_belts_never_crash(tmp_path):
    m = WarehouseModel()
    m.layout.bounds.width = 0.0
    m.layout.bounds.depth = 0.0
    m.resources.conveyors = [
        Conveyor(id="dot", points=[[1.0, 1.0]], speed_mps=1.0),
        Conveyor(id="nan_speed", points=STRAIGHT, speed_mps=float("nan")),
        Conveyor(id="neg_speed", points=BENT, speed_mps=-4.0),
        Conveyor(id="hairpin", points=[[0, 0], [20, 0], [20, 0.2], [0, 0.2]],
                 speed_mps=0.5),
        Conveyor(id="outside", points=[[-40.0, -20.0], [-10.0, -20.0]], speed_mps=0.5),
    ]
    out = png2d.render(m, np.zeros((4, 4)), {}, "出所", tmp_path / "d.png", dpi=90)
    assert out.is_file() and out.stat().st_size > 5_000


def test_belt_survives_a_real_run_with_heat_and_kpis(tmp_path, monkeypatch):
    grabbed = _capture(monkeypatch)
    m = templates.load_template_model("pick_to_belt")
    m.simulation.duration_s = 300.0
    res = run_once(m)
    out = png2d.render(m, res.heat, kpi_mod.compute([res], m), "出所",
                       tmp_path / "r.png", dpi=90)
    assert out.is_file() and out.stat().st_size > 5_000
    assert "whsim-conveyor-band" in grabbed["gids"]


# --- the GIF -----------------------------------------------------------------

def _replay(conveyors, totes) -> dict:
    return {
        "meta": {"name": "帯", "bounds": {"width": 40, "depth": 20},
                 "duration_s": 60.0, "replay_window_s": 60.0},
        "zones": [], "racks": [], "stations": [{"x": 4.0, "y": 10.0}],
        "workers": [], "conveyors": conveyors, "totes": totes, "kpis": {},
    }


def _frames(path) -> list:
    """Every frame's PLAN area as pixels (the title carries a running clock, so
    it is cropped away — we are asking whether the DRAWING itself moves)."""
    from PIL import Image
    im = Image.open(path)
    out = []
    for i in range(im.n_frames):
        im.seek(i)
        rgb = im.convert("RGB")
        out.append(np.asarray(rgb.crop((0, 80, rgb.width, rgb.height)), dtype=int))
    return out


def _shift(a, b) -> int:
    """Strongest per-channel pixel change between two frames. GIF re-quantises
    its palette per frame, so a few units of drift is noise; a drawn marker
    moving is worth ~100."""
    return int(np.abs(a - b).max())


def test_gif_draws_the_belt_and_moves_the_goods_along_it(tmp_path):
    """A tote riding the belt has to actually MOVE: a belt with no goods is a
    still picture, so a real change between frames proves the transport flows."""
    belt = [{"id": "c1", "points": [[36.0, 10.0], [4.0, 10.0]], "speed_mps": 1.0}]
    tote = [{"id": "T1", "keyframes": [[0.0, 36.0, 6.0, "carry"],
                                       [5.0, 36.0, 10.0, "belt"],
                                       [45.0, 4.0, 10.0, "belt"],
                                       [50.0, 4.0, 10.0, "pack"]]}]
    still = anim2d.render_gif(_replay(belt, []), tmp_path / "still.gif",
                              seconds=1.0, fps=8)
    moving = anim2d.render_gif(_replay(belt, tote), tmp_path / "moving.gif",
                               seconds=1.0, fps=8)
    assert still.stat().st_size > 0 and moving.stat().st_size > 0
    sf, mf = _frames(still), _frames(moving)
    assert max(_shift(sf[0], f) for f in sf[1:]) < 40      # belt alone: static
    assert max(_shift(mf[0], f) for f in mf[1:]) > 80      # the goods ride it
    assert _shift(sf[0], mf[0]) > 80                       # …and they are visible


def test_gif_ignores_a_tote_outside_its_own_window(tmp_path):
    """A good exists only between its first and last keyframe — it must not sit
    parked on the belt before it is picked or after it is packed."""
    belt = [{"id": "c1", "points": [[36.0, 10.0], [4.0, 10.0]], "speed_mps": 1.0}]
    late = [{"id": "T1", "keyframes": [[48.0, 36.0, 10.0, "belt"],
                                       [60.0, 10.0, 10.0, "belt"]]}]
    frames = _frames(anim2d.render_gif(_replay(belt, late), tmp_path / "late.gif",
                                       seconds=1.0, fps=8))
    empty = _frames(anim2d.render_gif(_replay(belt, []), tmp_path / "none.gif",
                                      seconds=1.0, fps=8))
    assert _shift(frames[0], empty[0]) < 40        # not yet born: nothing drawn
    assert _shift(frames[0], frames[-1]) > 80      # it shows up later


def test_gif_without_conveyors_or_totes_is_unchanged(tmp_path):
    """Legacy replays (no `conveyors` / `totes` keys at all) render exactly as
    they always did — the same bytes as an explicitly empty replay."""
    bare = {"meta": {"name": "空", "bounds": {"width": 10, "depth": 10},
                     "duration_s": 0.0, "replay_window_s": 0.0},
            "zones": [], "racks": [], "stations": [], "workers": [], "kpis": {}}
    a = anim2d.render_gif(dict(bare), tmp_path / "legacy.gif", seconds=1.0, fps=4)
    b = anim2d.render_gif({**bare, "conveyors": [], "totes": []},
                          tmp_path / "empty.gif", seconds=1.0, fps=4)
    assert a.read_bytes() == b.read_bytes()
    # a degenerate line is not transport either: still the same picture
    c = anim2d.render_gif({**bare, "conveyors": [{"id": "x", "points": [[1, 1]]},
                                                 {"id": "y", "points": []}]},
                          tmp_path / "degenerate.gif", seconds=1.0, fps=4)
    assert a.read_bytes() == c.read_bytes()


def test_gif_of_a_real_conveyor_run_carries_the_totes(tmp_path):
    m = templates.load_template_model("food_chilled")
    m.simulation.duration_s = 300.0
    res = run_once(m)
    rep = build_replay(m, res, kpi_mod.compute([res], m))
    assert rep["conveyors"] and rep["totes"]
    out = anim2d.render_gif(rep, tmp_path / "run.gif", seconds=1.0, fps=6)
    assert out.is_file() and out.stat().st_size > 0


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
