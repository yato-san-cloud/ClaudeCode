"""Render the proposal-grade 2D sheet: an architectural plan drawing + KPI panel.

This PNG is the deliverable that gets pasted into the customer proposal (and
embedded by `export/` into PPTX/PDF), so it is composed like a printed drawing
sheet rather than a plot:

    ┌ header ─────────────────────────────────────────────────────────────┐
    │ WHSiM  │            案件名             │            日付            │
    ├ plan drawing ───────────────────────────────┬ 判定 / 主要指標 ──────┤
    │ building shell (poché walls, notched docks) │ verdict banner        │
    │ zones (low-sat tints + tags)                │ KPI cards             │
    │ racking (bays, pick faces) over a smooth    │ 保管設計              │
    │ congestion field, numbered flow arrows,     │ 前提                  │
    │ dimension lines, north marker               │                       │
    ├ legend strip: 凡例 │ 縮尺 (scale bar) │ 混雑度 colourbar ───────────┤
    ├ title block: 案件名 │ 日付 │ 縮尺 │ 床面積 │ 実データ N% ───────────┤
    └─────────────────────────────────────────────────────────────────────┘

Everything is guarded: a bare `WarehouseModel()` with no run, no zones and no
shelves still produces a presentable sheet (the whsim "never blocks" rule). The
sheet stays a white paper regardless of the app theme, and the palette mirrors
the app's design tokens (docs/CLAUDE_DESIGN_BRIEF.md).
"""

from __future__ import annotations

import colorsys
import math
import re
from datetime import date
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless
import matplotlib.patheffects as pe  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.collections import LineCollection  # noqa: E402
from matplotlib.patches import (  # noqa: E402
    Circle,
    FancyArrowPatch,
    FancyBboxPatch,
    Polygon,
    Rectangle,
)

from whsim import racktypes  # noqa: E402
from whsim import storage  # noqa: E402
from whsim.labels import ABC_COLOR, ZONE_JP  # noqa: E402
from whsim.render.fonts import bold_available, setup_jp_font  # noqa: E402
from whsim.render.heatmap import congestion_cmap  # noqa: E402
from whsim.render.heatmap import field as heat_field  # noqa: E402
from whsim.render.shelves import shelf_runs  # noqa: E402
from whsim.schema.model import WarehouseModel  # noqa: E402

setup_jp_font()

# --- palette (mirrors the app design tokens: warm near-black ink on paper) ----
INK = "#37352F"
INK_DIM = "#5F5B53"
INK_FAINT = "#8A8780"
RULE = "#DEDBD4"
RULE_SOFT = "#EDEBE6"
PAPER = "#FFFFFF"
SURFACE = "#FAF9F7"
ACCENT = "#2383E2"
OK_INK, OK_BG = "#0F7B6C", "#DDF4EF"
BAD_INK, BAD_BG = "#C0392F", "#FBE4E4"
WARN_INK, WARN_BG = "#A9741A", "#FBF3E4"
FLOOR = "#FDFCFA"
POCHE = "#514D46"      # wall fill (architectural poché)
DIM_INK = "#9C988F"    # dimension lines / ticks

# --- conveyor (搬送コンベア) plan symbol --------------------------------------
# A takeaway belt is ~0.6 m across, so the symbol is drawn at that REAL width
# (floored at draw time so it never collapses to a hairline on a huge floor).
# The steel/teal family is deliberately outside the accent-blue used by doors,
# 工程フロー and 動線: on the sheet a belt is a physical object, not an overlay.
BELT_W_M = 0.6
BELT_BED = "#E4E9ED"     # belt surface (the band's fill)
BELT_EDGE = "#6F7B85"    # side frames (the band's outline)
BELT_ROLLER = "#AEB9C2"  # roller / tread ticks across the bed
BELT_FLOW = "#2C6E7F"    # direction-of-travel arrowheads + discharge glyph

# Door type → (colour, 日本語 label)
DOOR_STYLE = {
    "dock": (ACCENT, "ドック"),
    "shutter": ("#B7791F", "シャッター"),
    "personnel": ("#0F7B6C", "通用口"),
}

# Zone type → base hue for the plan tint (muted before use, never garish).
ZONE_BASE = {
    "receiving": "#4A7FB5", "storage": "#9A8A63", "picking": "#4F8F63",
    "packing": "#C08A3E", "shipping": "#7A6BB0", "staging": "#5F8F95",
}

# Equipment type → 日本語 (mirrors EQUIP_JP in web/static/js/constants.js).
EQUIP_JP = {"agv": "AGV", "forklift": "フォークリフト", "asrs": "自動倉庫",
            "robot_arm": "ロボットアーム", "crane": "クレーン", "sorter": "ソーター"}

# 動線 mover → colour (mirrors the app's MOVER_COLOR in the JS constants).
MOVER_COLOR = {"worker": ACCENT, "forklift": "#B7791F", "agv": "#7A6BB0",
               "cart": "#0F7B6C"}

# Canonical process order for the flow overlay (only zones present are chained).
FLOW_ORDER = ("receiving", "storage", "picking", "packing", "staging", "shipping")

# Sheet geometry (inches). ~1.79 aspect fills a 16:9 slide's content area.
FIG_W, FIG_H = 15.2, 8.5
ML, MR = 0.028, 0.972          # page margins (figure fraction)
COL_SPLIT = 0.663              # left (plan) / right (panel) split
PANEL_X = 0.688
CONTENT_TOP = 0.858
CONTENT_BOT = 0.108
STRIP_H = 0.098                # legend / scale / colourbar strip

# Draw order inside the plan axes. The belt sits ABOVE the heat field (it is
# equipment, not floor) but BELOW the racking, so a conveyor drawn across a rack
# run never buries the storage it serves.
Z_FLOOR, Z_GRID, Z_ZONE, Z_HEAT = 0, 1, 2, 3
Z_BELT = 3.4
Z_RACK, Z_SHELL, Z_DOOR, Z_ROUTE, Z_FLOW, Z_MARK, Z_DIM = 4, 6, 6.6, 7, 8, 9, 10


# --- tiny helpers ------------------------------------------------------------

def _safe(val, default=0.0) -> float:
    """Read a numeric KPI defensively; never raise on None / non-numeric."""
    try:
        if val is None:
            return default
        return float(val)
    except (TypeError, ValueError):
        return default


def _mute(color, sat: float = 0.5, light: float = 0.6):
    """Desaturate + lighten a colour so app-bright hues read as drawing tints."""
    try:
        r, g, b = matplotlib.colors.to_rgb(color)
    except (ValueError, TypeError):
        r, g, b = matplotlib.colors.to_rgb("#9A968D")
    h, ll, s = colorsys.rgb_to_hls(r, g, b)
    return colorsys.hls_to_rgb(h, ll + (1.0 - ll) * light, max(0.0, min(1.0, s * sat)))


def _shade(color, keep: float = 0.45):
    """Darken a colour toward ink (keeps hue) — for outlines and pick faces."""
    try:
        r, g, b = matplotlib.colors.to_rgb(color)
    except (ValueError, TypeError):
        r, g, b = matplotlib.colors.to_rgb("#8A8780")
    h, ll, s = colorsys.rgb_to_hls(r, g, b)
    return colorsys.hls_to_rgb(h, max(0.0, min(1.0, ll * keep)),
                               max(0.0, min(1.0, s * 0.85)))


def _emph(color, size: float = 10.0) -> dict:
    """Emphasis kwargs — real bold, or a hairline stroke when the JP face has none."""
    if bold_available():
        return {"weight": "bold"}
    lw = 0.45 if size <= 9 else (0.7 if size <= 14 else 1.0)
    return {"weight": "bold",
            "path_effects": [pe.Stroke(linewidth=lw, foreground=color), pe.Normal()]}


def _dw(s: str) -> int:
    """Display width in half-width columns (CJK counts as 2)."""
    return sum(2 if ord(c) > 0x2E7F else 1 for c in str(s))


# 行頭禁則: characters that may not start a line (basic kinsoku shori).
_NO_LINE_START = "ー、。，．・）」』】〕〉》}）%％!！?？:：;；,."


def _wrap(s: str, cols: int) -> list[str]:
    """Character wrap by display width — correct for Japanese (no word breaks).

    Applies basic 行頭禁則 so a line never opens with a small kana / closing
    bracket / punctuation, which is what makes machine-wrapped Japanese look
    amateurish in a customer-facing document.
    """
    lines: list[str] = []
    cur, w = "", 0
    for ch in str(s or ""):
        if ch == "\n":
            lines.append(cur)
            cur, w = "", 0
            continue
        cw = 2 if ord(ch) > 0x2E7F else 1
        if w + cw > cols and cur:
            if ch in _NO_LINE_START and len(cur) > 1:
                # `ch` would open the next line: pull its base character along.
                keep = cur[-1]
                lines.append(cur[:-1])
                cur, w = keep, (2 if ord(keep) > 0x2E7F else 1)
            else:
                lines.append(cur)
                cur, w = "", 0
        cur += ch
        w += cw
    if cur:
        lines.append(cur)
    return lines or [""]


def _measure(fig, ax, s: str, size: float) -> float:
    """Width of `s` in the axes' x fraction (renderer-accurate, estimate on fail)."""
    try:
        r = fig.canvas.get_renderer()
        t = ax.text(0, 0, s, fontsize=size, transform=ax.transAxes)
        bb = t.get_window_extent(renderer=r)
        t.remove()
        inv = ax.transAxes.inverted()
        (x0, _), (x1, _) = inv.transform([(0.0, 0.0), (bb.width, 0.0)])
        return abs(x1 - x0)
    except Exception:  # noqa: BLE001 — measurement is a layout nicety
        # Crude fallback: half-width columns × point size over the axes' width.
        return _dw(s) * size * 0.5 / 72.0 / max(FIG_W * 0.3, 1e-6)


def _ellipsis(fig, ax, s: str, size: float, max_w: float) -> str:
    """Truncate `s` with … so it fits `max_w` (axes fraction)."""
    s = str(s or "")
    if not s or _measure(fig, ax, s, size) <= max_w:
        return s
    lo, hi = 0, len(s)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if _measure(fig, ax, s[:mid] + "…", size) <= max_w:
            lo = mid
        else:
            hi = mid - 1
    return (s[:lo] + "…") if lo else ""


def _nice_step(span: float) -> float:
    """A round 1/2/5×10ⁿ step giving roughly 8 divisions across `span`."""
    if span <= 0:
        return 1.0
    raw = span / 8.0
    mag = 10.0 ** math.floor(math.log10(max(raw, 1e-9)))
    for m in (1.0, 2.0, 5.0):
        if raw <= m * mag:
            return m * mag
    return 10.0 * mag


def _fmt_m(v: float) -> str:
    return f"{v:,.0f}" if abs(v - round(v)) < 0.05 else f"{v:,.1f}"


# --- belt geometry (pure; shared with render/anim2d.py) ----------------------

def belt_points(points) -> list[tuple[float, float]]:
    """Tolerant conveyor polyline → clean metre coordinates.

    Drops anything unparseable / non-finite, collapses repeated vertices and
    merges straight-through vertices (the MapMaker-style belts carry a vertex
    every few metres, and a 21-vertex straight run must still read as ONE leg
    when the sheet labels it). Returns [] when nothing usable is left, which is
    how a degenerate conveyor becomes "simply not drawn" instead of a crash.
    """
    raw: list[tuple[float, float]] = []
    for p in points or []:
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError, KeyError):
            continue
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        if raw and math.dist(raw[-1], (x, y)) <= 1e-9:
            continue
        raw.append((x, y))
    if len(raw) < 3:
        return raw
    out = [raw[0]]
    for cur, nxt in zip(raw[1:-1], raw[2:]):
        ax_, ay_ = cur[0] - out[-1][0], cur[1] - out[-1][1]
        bx, by = nxt[0] - cur[0], nxt[1] - cur[1]
        # Collinear AND forward-going (a 180° switchback keeps its vertex).
        if abs(ax_ * by - ay_ * bx) <= 1e-9 * max(1.0, abs(ax_) + abs(ay_)) \
                and ax_ * bx + ay_ * by > 0:
            continue
        out.append(cur)
    out.append(raw[-1])
    return out


def belt_length(pts) -> float:
    """Total run length (m) of a cleaned polyline."""
    return sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))


def belt_at(pts, s: float) -> tuple[float, float, float, float]:
    """(x, y, ux, uy) at arc length `s` along the polyline (clamped at both ends).

    `(ux, uy)` is the unit direction of travel there — points[0] → points[-1] is
    the direction goods move, so this is what the flow arrowheads point along.
    """
    if not pts:
        return (0.0, 0.0, 1.0, 0.0)
    if len(pts) < 2:
        return (pts[0][0], pts[0][1], 1.0, 0.0)
    s = max(0.0, s)
    acc = 0.0
    u = (1.0, 0.0)
    for a, b in zip(pts, pts[1:]):
        d = math.dist(a, b)
        if d <= 1e-12:
            continue
        u = ((b[0] - a[0]) / d, (b[1] - a[1]) / d)
        if s <= acc + d:
            f = s - acc
            return (a[0] + u[0] * f, a[1] + u[1] * f, u[0], u[1])
        acc += d
    return (pts[-1][0], pts[-1][1], u[0], u[1])


def belt_band(points, width: float) -> list[tuple[float, float]]:
    """Closed polygon outlining a `width`-metre band centred on the polyline.

    Offsets both sides with mitred corners (limited, so a hairpin never grows a
    spike), which is what lets the belt be drawn at its true width in METRES —
    identical at any sheet scale, in the PNG and in the GIF alike.
    """
    pts = belt_points(points)
    if len(pts) < 2 or not math.isfinite(width) or width <= 0:
        return []
    h = width / 2.0
    dirs = []
    for a, b in zip(pts, pts[1:]):
        d = math.dist(a, b)
        if d <= 1e-12:
            continue
        dirs.append(((b[0] - a[0]) / d, (b[1] - a[1]) / d))
    if not dirs:
        return []

    def _side(sign: float) -> list[tuple[float, float]]:
        n0 = (-dirs[0][1] * sign, dirs[0][0] * sign)
        edge = [(pts[0][0] + n0[0] * h, pts[0][1] + n0[1] * h)]
        for i in range(1, len(dirs)):
            u1, u2 = dirs[i - 1], dirs[i]
            n1 = (-u1[1] * sign, u1[0] * sign)
            n2 = (-u2[1] * sign, u2[0] * sign)
            mx, my = n1[0] + n2[0], n1[1] + n2[1]
            ml = math.hypot(mx, my)
            p = pts[i]
            if ml <= 1e-9:              # switchback: square the corner off
                edge.append((p[0] + n1[0] * h, p[1] + n1[1] * h))
                edge.append((p[0] + n2[0] * h, p[1] + n2[1] * h))
                continue
            mnx, mny = mx / ml, my / ml
            ext = h / max(mnx * n1[0] + mny * n1[1], 0.34)   # miter limit ≈ 2.9×
            edge.append((p[0] + mnx * ext, p[1] + mny * ext))
        nz = (-dirs[-1][1] * sign, dirs[-1][0] * sign)
        edge.append((pts[-1][0] + nz[0] * h, pts[-1][1] + nz[1] * h))
        return edge

    return _side(1.0) + _side(-1.0)[::-1]


def belt_specs(model) -> list[dict]:
    """Every conveyor worth drawing → {id, points, length_m, speed_mps}.

    Degenerate lines (no points, one point, zero length, NaN) are dropped here,
    so both renderers and the equipment list agree on what "a belt" is.
    """
    out: list[dict] = []
    res = getattr(model, "resources", None)
    for cv in (getattr(res, "conveyors", None) or []):
        pts = belt_points(getattr(cv, "points", None))
        length = belt_length(pts)
        if len(pts) < 2 or length <= 1e-6:
            continue
        try:
            speed = float(getattr(cv, "speed_mps", 0.0) or 0.0)
        except (TypeError, ValueError):
            speed = 0.0
        if not math.isfinite(speed) or speed < 0:
            speed = 0.0
        out.append({"id": str(getattr(cv, "id", "") or ""), "points": pts,
                    "length_m": length, "speed_mps": speed})
    return out


def _content_extent(model, fw: float, fd: float) -> tuple[float, float, float, float]:
    """Union of the building envelope and everything authored on the floor.

    Imported / hand-edited models sometimes carry zones or equipment outside the
    declared bounds. Cropping them would silently hide a modelling error, so the
    view is widened instead — the shell still shows the declared envelope.
    """
    x0, y0, x1, y1 = 0.0, 0.0, fw, fd
    def _grow(ax0, ay0, ax1, ay1):
        nonlocal x0, y0, x1, y1
        x0, y0 = min(x0, ax0), min(y0, ay0)
        x1, y1 = max(x1, ax1), max(y1, ay1)

    for z in getattr(model.layout, "zones", []) or []:
        try:
            _grow(float(z.x), float(z.y), float(z.x) + float(z.w),
                  float(z.y) + float(z.h))
        except (TypeError, ValueError):
            continue
    for st in getattr(model.resources, "stations", []) or []:
        try:
            _grow(float(st.x), float(st.y), float(st.x), float(st.y))
        except (TypeError, ValueError):
            continue
    for wl in getattr(model.layout, "walls", []) or []:
        for p in (getattr(wl, "points", []) or []):
            try:
                _grow(float(p[0]), float(p[1]), float(p[0]), float(p[1]))
            except (TypeError, ValueError, IndexError):
                continue
    for spec in belt_specs(model):
        for px, py in spec["points"]:
            _grow(px, py, px, py)
    return x0, y0, x1, y1


def _blank_axes(fig, rect):
    ax = fig.add_axes(rect)
    ax.set_axis_off()
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    return ax


# --- plan drawing ------------------------------------------------------------

def _draw_grid(ax, fw: float, fd: float, step: float) -> None:
    """Faint metric grid inside the floor (the drawing's dimensional texture)."""
    minor = step / 5.0 if step / 5.0 >= 0.9 else step
    if minor < step:
        n = 1
        while minor * n < fw:
            ax.plot([minor * n, minor * n], [0, fd], color="#F4F2EE", lw=0.3,
                    zorder=Z_GRID, solid_capstyle="butt")
            n += 1
        n = 1
        while minor * n < fd:
            ax.plot([0, fw], [minor * n, minor * n], color="#F4F2EE", lw=0.3,
                    zorder=Z_GRID, solid_capstyle="butt")
            n += 1
    n = 1
    while step * n < fw:
        ax.plot([step * n, step * n], [0, fd], color="#EAE7E1", lw=0.45,
                zorder=Z_GRID, solid_capstyle="butt")
        n += 1
    n = 1
    while step * n < fd:
        ax.plot([0, fw], [step * n, step * n], color="#EAE7E1", lw=0.45,
                zorder=Z_GRID, solid_capstyle="butt")
        n += 1


def _draw_shell(ax, model, fw: float, fd: float) -> tuple[float, list[str]]:
    """Building envelope as poché walls with notched door openings.

    Returns the wall thickness (m) and the door types actually drawn (legend).
    """
    t = max(0.35, min(fw, fd) * 0.010)
    # Envelope as four bands so the wall reads with real weight (not a stroke).
    for x, y, w, h in ((-t, -t, fw + 2 * t, t), (-t, fd, fw + 2 * t, t),
                       (-t, 0, t, fd), (fw, 0, t, fd)):
        ax.add_patch(Rectangle((x, y), w, h, facecolor=POCHE, edgecolor="none",
                               zorder=Z_SHELL))
    # Authored interior walls (躯体) drawn in the same weight/tone.
    for wl in getattr(model.layout, "walls", []) or []:
        pts = [p for p in (getattr(wl, "points", []) or []) if len(p) >= 2]
        if len(pts) < 2:
            continue
        th = max(float(getattr(wl, "thickness", 0.2) or 0.2), 0.12)
        ax.plot([p[0] for p in pts], [p[1] for p in pts], color=POCHE,
                lw=max(1.2, th * 3.2), solid_capstyle="butt",
                solid_joinstyle="miter", zorder=Z_SHELL)

    kinds: list[str] = []
    for d in getattr(model.layout, "doors", []) or []:
        try:
            dx, dy, dw = float(d.x), float(d.y), max(float(d.w), 0.6)
        except (TypeError, ValueError):
            continue
        kind = getattr(d, "type", "dock") or "dock"
        col = DOOR_STYLE.get(kind, DOOR_STYLE["dock"])[0]
        if kind not in kinds:
            kinds.append(kind)
        # Snap the opening onto the nearest envelope edge and cut a real notch.
        dists = {"left": abs(dx), "right": abs(fw - dx),
                 "bottom": abs(dy), "top": abs(fd - dy)}
        edge = min(dists, key=dists.get)
        # Plan symbol: a real gap cut out of the poché, jamb ticks at both ends
        # and a thin leaf line across the opening (dock bays get an outward
        # approach tick so 入出荷 sides read at a glance).
        if edge in ("left", "right"):
            x0 = -t if edge == "left" else fw
            y0 = max(min(dy - dw / 2.0, fd - dw), 0.0)
            ax.add_patch(Rectangle((x0, y0), t, dw, facecolor=PAPER,
                                   edgecolor="none", zorder=Z_DOOR))
            for yj in (y0, y0 + dw):
                ax.plot([x0, x0 + t], [yj, yj], color=POCHE, lw=0.6,
                        solid_capstyle="butt", zorder=Z_DOOR + 0.1)
            xl = x0 + t / 2.0
            ax.plot([xl, xl], [y0 + dw * 0.06, y0 + dw * 0.94], color=col, lw=1.3,
                    solid_capstyle="butt", zorder=Z_DOOR + 0.2)
            xo = -t * 2.6 if edge == "left" else fw + t * 2.6
            ax.plot([xl, xo], [y0 + dw / 2, y0 + dw / 2], color=col, lw=0.6,
                    alpha=0.75, ls=(0, (2.0, 1.6)), zorder=Z_DOOR + 0.2)
        else:
            y0 = -t if edge == "bottom" else fd
            x0 = max(min(dx - dw / 2.0, fw - dw), 0.0)
            ax.add_patch(Rectangle((x0, y0), dw, t, facecolor=PAPER,
                                   edgecolor="none", zorder=Z_DOOR))
            for xj in (x0, x0 + dw):
                ax.plot([xj, xj], [y0, y0 + t], color=POCHE, lw=0.6,
                        solid_capstyle="butt", zorder=Z_DOOR + 0.1)
            yl = y0 + t / 2.0
            ax.plot([x0 + dw * 0.06, x0 + dw * 0.94], [yl, yl], color=col, lw=1.3,
                    solid_capstyle="butt", zorder=Z_DOOR + 0.2)
            yo = -t * 2.6 if edge == "bottom" else fd + t * 2.6
            ax.plot([x0 + dw / 2, x0 + dw / 2], [yl, yo], color=col, lw=0.6,
                    alpha=0.75, ls=(0, (2.0, 1.6)), zorder=Z_DOOR + 0.2)
    return t, kinds


def _zone_base(z):
    """A consistent mid-tone base for a zone: the model's hue, our saturation.

    Model colours arrive at wildly different lightness (some are already pale
    tints). Re-deriving from the hue keeps every zone tint in the same calm
    family, so the plan never turns into a colour salad.
    """
    c = getattr(z, "color", None) or ZONE_BASE.get(getattr(z, "type", ""), "#8A8780")
    try:
        r, g, b = matplotlib.colors.to_rgb(c)
    except (ValueError, TypeError):
        return "#8A8780"
    h, _, s = colorsys.rgb_to_hls(r, g, b)
    return colorsys.hls_to_rgb(h, 0.44, 0.0 if s < 0.08 else 0.45)


def _is_neutral(color) -> bool:
    """True for hue-less (grey) colours — they get a lighter plan treatment."""
    try:
        r, g, b = matplotlib.colors.to_rgb(color)
    except (ValueError, TypeError):
        return True
    return colorsys.rgb_to_hls(r, g, b)[2] < 0.08


def _draw_zones(ax, model, span: float) -> list[tuple]:
    """Low-saturation tinted zone areas with a small corner name tag."""
    seen: list[tuple] = []
    for z in model.layout.zones:
        try:
            zx, zy, zw, zh = float(z.x), float(z.y), float(z.w), float(z.h)
        except (TypeError, ValueError):
            continue
        if zw <= 0 or zh <= 0:
            continue
        base = _zone_base(z)
        # Neutral (hue-less) zones get a near-paper fill: a big grey area would
        # dull the whole drawing without carrying any information.
        neutral = _is_neutral(base)
        ax.add_patch(Rectangle((zx, zy), zw, zh,
                               facecolor=_mute(base, 0.42, 0.92 if neutral else 0.84),
                               edgecolor=_mute(base, 0.70, 0.42 if neutral else 0.30),
                               lw=0.7, ls=(0, (4, 2.4)), zorder=Z_ZONE))
        if z.type not in [t for t, _ in seen]:
            seen.append((z.type, base))
        label = ZONE_JP.get(z.type, z.type)
        # Tag inside the top-left corner: name + area. Skipped on slivers.
        if zw * zh >= (span * 0.035) ** 2:
            ax.text(zx + span * 0.006, zy + zh - span * 0.006,
                    f"{label}  {zw * zh:,.0f} m²", fontsize=7.0, color=INK_DIM,
                    ha="left", va="top", zorder=Z_MARK,
                    bbox=dict(boxstyle="round,pad=0.30", facecolor="white",
                              edgecolor=_mute(base, 0.70, 0.42), linewidth=0.6,
                              alpha=0.90))
    return seen


def _faces(run: dict) -> list[str]:
    """Which long edge(s) of a drawn run carry the pick face (間口)."""
    facing = str(run.get("facing") or "")
    if run.get("vertical") and facing in ("left", "right"):
        return [facing]
    return ["left", "right"]  # aisle on both sides (or orientation unknown)


def _draw_racks(ax, model, m_per_px: float) -> list[str]:
    """Racking drawn as real racking: run body, bay subdivisions, pick faces."""
    try:
        runs = shelf_runs(model)
    except Exception:  # noqa: BLE001 — a broken shelf model must not kill the sheet
        runs = []
    present: list[str] = []
    if not runs:
        return present
    heavy = len(runs) > 320
    for run in runs:
        try:
            x = float(run["x"])
            y0, y1 = float(run["y0"]), float(run["y1"])
            d = max(float(run.get("depth") or 0.6), 0.05)
        except (KeyError, TypeError, ValueError):
            continue
        h = max(y1 - y0, 0.05)
        rtid = run.get("rack_type") or racktypes.DEFAULT
        if rtid not in present:
            present.append(rtid)
        base = racktypes.color(rtid)
        body, edge = _mute(base, 0.16, 0.90), _shade(base, 0.38)
        x0 = x - d / 2.0
        ax.add_patch(Rectangle((x0, y0), d, h, facecolor=body, edgecolor=edge,
                               lw=0.65, zorder=Z_RACK))
        cells = run.get("cells") or []
        pitch = float(run.get("pitch") or 0.0) or (h / max(len(cells), 1))
        bay_px = pitch / m_per_px if m_per_px > 0 else 0.0
        # Bays are contiguous (like real racking) and inset in depth so the run
        # body still reads as the frame; hairlines mark the bay boundaries.
        inset, wide = d * 0.16, d * 0.68
        if cells and not heavy and bay_px >= 3.0 and d / m_per_px >= 2.5:
            for c in cells:
                cy = float(c.get("y", y0))
                by0 = max(cy - pitch / 2.0, y0)
                by1 = min(cy + pitch / 2.0, y1)
                if by1 <= by0:
                    continue
                ax.add_patch(Rectangle(
                    (x0 + inset, by0), wide, by1 - by0,
                    facecolor=_mute(ABC_COLOR.get(c.get("abc", "C"), "#B9B5AC"),
                                    0.80, 0.34),
                    edgecolor="none", zorder=Z_RACK + 0.1))
            ys = sorted(float(c.get("y", y0)) for c in cells)
            for a, b in zip(ys, ys[1:]):
                ax.plot([x0, x0 + d], [(a + b) / 2.0] * 2, color=edge, lw=0.28,
                        alpha=0.45, zorder=Z_RACK + 0.2, solid_capstyle="butt")
        elif cells:
            # Too small to subdivide honestly: tint the whole run by its
            # dominant ABC class so the storage read stays truthful.
            counts: dict[str, int] = {}
            for c in cells:
                k = c.get("abc", "C")
                counts[k] = counts.get(k, 0) + 1
            dom = max(counts, key=counts.get)
            ax.add_patch(Rectangle(
                (x0 + inset, y0), wide, h,
                facecolor=_mute(ABC_COLOR.get(dom, "#B9B5AC"), 0.76, 0.42),
                edgecolor="none", zorder=Z_RACK + 0.1))
        for f in _faces(run):
            fx = x0 if f == "left" else x0 + d
            ax.plot([fx, fx], [y0, y1], color=edge, lw=1.15,
                    solid_capstyle="butt", zorder=Z_RACK + 0.3)
    return present


def _belt_spec(spec: dict, sep: str) -> str:
    """「99 m ・ 0.8 m/s」 — the speed is dropped when the model does not carry
    a usable one, rather than quoting a 0 m/s belt at the customer."""
    txt = f"{spec['length_m']:,.0f} m"
    if spec["speed_mps"] > 0:
        txt += f"{sep}{spec['speed_mps']:g} m/s"
    return txt


def _belt_arrow(ax, x: float, y: float, ux: float, uy: float, bw: float,
                zorder: float, scale: float = 1.0) -> None:
    """One direction-of-travel arrowhead sitting ON the bed, centred at (x, y)."""
    ln, half = bw * 1.30 * scale, bw * 0.42 * scale
    nx, ny = -uy * half, ux * half
    tip = (x + ux * ln * 0.5, y + uy * ln * 0.5)
    tail = (x - ux * ln * 0.5, y - uy * ln * 0.5)
    ax.add_patch(Polygon([tip, (tail[0] + nx, tail[1] + ny),
                          (tail[0] - nx, tail[1] - ny)],
                         closed=True, facecolor=BELT_FLOW, edgecolor="white",
                         lw=0.3, zorder=zorder, gid="whsim-conveyor-arrow"))


def _draw_conveyors(ax, model, span: float, m_per_px: float) -> list[dict]:
    """Conveyors drawn as conveyors: a real-width belt, not a bare polyline.

    Each line becomes a band of BELT_W_M metres with the roller/tread ticks
    hatched across it, repeated arrowheads pointing the way goods actually
    travel (points[0] → points[-1]) and a marked discharge end — the customer
    asks "which way does it run and where does it drop?", and the sheet has to
    answer without a caption. The equipment tag quotes the spec (length・speed)
    on the longest straight leg, exactly like a drawn equipment callout.

    Returns the spec list (draw order) for the legend / 搬送設備 list.
    """
    lines = belt_specs(model)
    if not lines:
        return []
    # Real 0.6 m width, floored so the band survives a 200 m floor on one sheet.
    bw = max(BELT_W_M, m_per_px * 3.2)
    stations: list[tuple[float, float]] = []
    for st in getattr(model.resources, "stations", []) or []:
        try:
            stations.append((float(st.x), float(st.y)))
        except (TypeError, ValueError):
            continue

    # Pass 1 — every bed first, so a line that merges into / crosses another is
    # never half-buried by its neighbour's band (branching geometry stays read-
    # able because all the ticks and arrows land on top of every bed).
    for spec in lines:
        band = belt_band(spec["points"], bw)
        if len(band) >= 3:
            ax.add_patch(Polygon(band, closed=True, facecolor=BELT_BED,
                                 edgecolor=BELT_EDGE, lw=0.7, joinstyle="miter",
                                 zorder=Z_BELT, gid="whsim-conveyor-band"))

    # Pass 2 — roller ticks across the bed (the texture that says "belt").
    segs: list[list[tuple[float, float]]] = []
    for spec in lines:
        pts, length = spec["points"], spec["length_m"]
        step = max(0.9, m_per_px * 7.0, length / 260.0)
        for i in range(1, int(length / step) + 1):
            bx, by, ux, uy = belt_at(pts, step * i)
            nx, ny = -uy * bw * 0.40, ux * bw * 0.40
            segs.append([(bx - nx, by - ny), (bx + nx, by + ny)])
    if segs:
        ax.add_collection(LineCollection(
            segs, colors=[BELT_ROLLER], linewidths=0.35, zorder=Z_BELT + 0.1,
            capstyle="butt", gid="whsim-conveyor-rollers"))

    # Pass 3 — flow arrowheads, the discharge glyph and the equipment tag.
    tagged = capped = 0
    for spec in lines:
        pts, length = spec["points"], spec["length_m"]
        n_arrow = max(1, min(14, int(round(length / max(bw * 10.0, 6.0)))))
        for k in range(n_arrow):
            bx, by, ux, uy = belt_at(pts, length * (k + 0.5) / n_arrow)
            _belt_arrow(ax, bx, by, ux, uy, bw, Z_BELT + 0.2)
        # Discharge (排出端): a heavier arrowhead running into an end bar — the
        # plan convention for "goods leave the line here". Drawn ABOVE the
        # station glyphs (the belt almost always discharges onto one), so the
        # sheet shows the hand-off instead of hiding it under the 梱包台 box.
        ex, ey, ux, uy = belt_at(pts, length)
        nx, ny = -uy * bw * 0.70, ux * bw * 0.70
        _belt_arrow(ax, ex - ux * bw * 0.80, ey - uy * bw * 0.80, ux, uy, bw,
                    Z_MARK + 0.15, scale=1.30)
        ax.plot([ex + nx, ex - nx], [ey + ny, ey - ny], color=BELT_FLOW, lw=1.2,
                solid_capstyle="butt", zorder=Z_MARK + 0.15)
        # 排出 caption, on the upper side (station captions hang BELOW their
        # glyph, so the top side is the one that stays free). Suppressed when a
        # station sits right on the discharge — its own 梱包台 tag already names
        # the destination and two labels would collide.
        near_station = any(math.dist((ex, ey), s) <= max(bw * 3.0, span * 0.015)
                           for s in stations)
        if not near_station and capped < 6:
            capped += 1
            lx, ly = -uy, ux
            if ly < 0:                    # keep the caption on the upper side
                lx, ly = uy, -ux
            ax.text(ex + lx * bw * 2.2, ey + ly * bw * 2.2, "排出", fontsize=6.0,
                    color=BELT_FLOW, ha="center", va="center", zorder=Z_MARK + 0.3,
                    path_effects=[pe.withStroke(linewidth=2.2, foreground="white")])
        # Equipment tag on the longest straight leg. Only lines long enough to
        # carry a callout get one (a stub belt sits among the station glyphs and
        # their captions, where a box this size would cover them) and the count
        # is capped, so a sorter loop of 30 lines cannot paper over the plan —
        # 搬送設備 in the panel always quotes every line's spec regardless.
        legs = list(zip(pts, pts[1:]))
        a, b = max(legs, key=lambda ab: math.dist(*ab))
        leg = math.dist(a, b)
        if length >= max(span * 0.18, 12.0) and leg >= span * 0.07 and tagged < 4:
            tagged += 1
            ux2, uy2 = (b[0] - a[0]) / leg, (b[1] - a[1]) / leg
            ang = math.degrees(math.atan2(uy2, ux2))
            ang = ang - 180.0 if ang > 90.0 else (ang + 180.0 if ang < -90.0 else ang)
            off = bw * 2.6
            ax.text((a[0] + b[0]) / 2 - uy2 * off, (a[1] + b[1]) / 2 + ux2 * off,
                    "コンベア " + _belt_spec(spec, " ・ "), fontsize=6.2,
                    color=BELT_FLOW, ha="center", va="center", rotation=ang,
                    rotation_mode="anchor", zorder=Z_MARK + 0.3,
                    bbox=dict(boxstyle="round,pad=0.28", facecolor="white",
                              edgecolor=BELT_EDGE, linewidth=0.5, alpha=0.92))
    return lines


def _draw_stations(ax, model, span: float) -> bool:
    """Packing stations / placed equipment as labelled top-view glyphs."""
    drawn = False
    w = max(span * 0.022, 1.2)
    for st in getattr(model.resources, "stations", []) or []:
        try:
            sx, sy = float(st.x), float(st.y)
        except (TypeError, ValueError):
            continue
        drawn = True
        n = int(_safe(getattr(st, "count", 0), 0))
        ax.add_patch(FancyBboxPatch(
            (sx - w / 2, sy - w * 0.36), w, w * 0.72,
            boxstyle="round,pad=0,rounding_size=" + str(w * 0.12),
            facecolor="white", edgecolor=ACCENT, lw=1.1, zorder=Z_MARK))
        ax.plot([sx - w * 0.32, sx + w * 0.32], [sy, sy], color=ACCENT, lw=0.8,
                zorder=Z_MARK + 0.1)
        ax.text(sx, sy - w * 0.52, f"梱包台{('×' + str(n)) if n else ''}",
                fontsize=6.6, color=ACCENT, ha="center", va="top", zorder=Z_MARK + 0.2,
                path_effects=[pe.withStroke(linewidth=2.0, foreground="white")])
    for eq in getattr(model.resources, "equipment", []) or []:
        try:
            ex, ey = float(eq.x), float(eq.y)
        except (TypeError, ValueError):
            continue
        if ex == 0 and ey == 0:
            continue  # unplaced equipment: no honest position to draw
        drawn = True
        s = w * 0.55
        ax.add_patch(Rectangle((ex - s / 2, ey - s / 2), s, s, facecolor="white",
                               edgecolor=INK_DIM, lw=0.9, zorder=Z_MARK))
        etype = str(getattr(eq, "type", "") or "")
        ax.text(ex, ey + s * 0.75, EQUIP_JP.get(etype, etype), fontsize=6.0,
                color=INK_DIM, ha="center", va="bottom", zorder=Z_MARK + 0.1,
                path_effects=[pe.withStroke(linewidth=2.0, foreground="white")])
    return drawn


def _zone_points(model) -> dict:
    """Area-weighted centroid per zone type (for the process flow overlay)."""
    agg: dict[str, list[float]] = {}
    for z in model.layout.zones:
        try:
            zx, zy, zw, zh = float(z.x), float(z.y), float(z.w), float(z.h)
        except (TypeError, ValueError):
            continue
        a = zw * zh
        if a <= 0:
            continue
        s = agg.setdefault(z.type, [0.0, 0.0, 0.0])
        s[0] += (zx + zw / 2) * a
        s[1] += (zy + zh / 2) * a
        s[2] += a
    return {t: (v[0] / v[2], v[1] / v[2]) for t, v in agg.items() if v[2] > 0}


def _draw_flow(ax, model, span: float) -> list[str]:
    """Numbered curved arrows chaining the process zones (入荷→…→出荷).

    Returns the zone types in flow order (the panel lists them as ①②③…, so the
    numbered badges on the drawing and the text read as one diagram).
    """
    pts = _zone_points(model)
    chain = [(t, pts[t]) for t in FLOW_ORDER if t in pts]
    if len(chain) < 2:
        return []
    for i, ((_, p0), (_, p1)) in enumerate(zip(chain, chain[1:]), start=1):
        if math.dist(p0, p1) < span * 0.02:
            continue
        # Alternate the bow so a there-and-back pair (storage ⇄ packing) never
        # collapses onto one line.
        rad = 0.20 if i % 2 else -0.20
        arr = FancyArrowPatch(
            p0, p1, connectionstyle=f"arc3,rad={rad}", arrowstyle="-|>",
            mutation_scale=12, lw=1.6, color=ACCENT, alpha=0.88,
            shrinkA=9, shrinkB=9, zorder=Z_FLOW, capstyle="round",
            joinstyle="round")
        arr.set_path_effects([pe.withStroke(linewidth=3.2, foreground="white",
                                            alpha=0.95)])
        ax.add_patch(arr)
    # Step badges sit ON each zone, so the plan's ①②③ and the panel's 工程フロー
    # list are the same numbering.
    for i, (_, (bx, by)) in enumerate(chain, start=1):
        # Nudged off the centroid so a badge never lands on a station glyph or
        # on the zone's own name tag (which hugs the top-left corner).
        ax.text(bx + span * 0.018, by + span * 0.010, str(i), fontsize=6.2,
                color="white", ha="center", va="center", zorder=Z_DIM + 1,
                bbox=dict(boxstyle="circle,pad=0.22", facecolor=ACCENT,
                          edgecolor="white", linewidth=0.9))
    return [t for t, _ in chain]


def _norm_routes(routes) -> list[tuple]:
    """Tolerant route parsing → [(points, label, mover), …].

    Accepts bare polylines (`[[(x, y), …], …]`) and the app's route dicts
    (`{"points": …, "label": …, "mover": …}`). Anything unparseable is skipped.
    """
    out: list[tuple] = []
    for r in (routes or [])[:400]:
        if isinstance(r, dict):
            pts = r.get("points")
            label = str(r.get("label") or r.get("name") or "")
            mover = str(r.get("mover") or "")
        else:
            pts, label, mover = r, "", ""
        try:
            p = [(float(a), float(b)) for a, b in (pts or [])]
        except (TypeError, ValueError):
            continue
        if len(p) >= 2:
            out.append((p, label, mover))
    return out


def _draw_routes(ax, routes) -> bool:
    """動線 overlay: a faint travel density plus any *authored* named routes.

    Sampled agent trajectories are drawn as a low-contrast weave (they show
    where travel concentrates without turning the plan into a debug plot), while
    routes that carry a label / mover are drawn as the diagram's own dashed
    lines with a legible caption.
    """
    polys = _norm_routes(routes)
    if not polys:
        return False
    authored = [q for q in polys if q[1] or q[2]]
    sampled = [q for q in polys if not (q[1] or q[2])]
    for p, _, _ in sampled[:80]:
        step = max(1, len(p) // 160)
        ax.plot([q[0] for q in p[::step]], [q[1] for q in p[::step]], color=ACCENT,
                lw=0.7, alpha=0.18, solid_capstyle="round", solid_joinstyle="round",
                zorder=Z_ROUTE)
    for p, label, mover in authored[:12]:
        col = MOVER_COLOR.get(mover, ACCENT)
        line, = ax.plot([q[0] for q in p], [q[1] for q in p], color=col, lw=1.5,
                        alpha=0.92, ls=(0, (5, 2.5)), solid_capstyle="round",
                        zorder=Z_ROUTE + 0.2)
        line.set_path_effects([pe.withStroke(linewidth=2.9, foreground="white",
                                             alpha=0.9)])
        if label:
            mid = p[len(p) // 2]
            ax.text(mid[0], mid[1], label, fontsize=6.4, color=col, ha="center",
                    va="center", zorder=Z_ROUTE + 0.3,
                    bbox=dict(boxstyle="round,pad=0.25", facecolor="white",
                              edgecolor=col, linewidth=0.5, alpha=0.92))
    return True


def _draw_dims(ax, fw: float, fd: float, step: float, off: float) -> None:
    """Architectural dimension lines with slash ticks along the two near edges."""
    def _ticks(v_end: float) -> list[float]:
        vals, n = [0.0], 1
        while step * n < v_end - step * 0.25:
            vals.append(step * n)
            n += 1
        vals.append(v_end)
        return vals

    ts = off * 0.22
    y = -off
    ax.plot([0, fw], [y, y], color=DIM_INK, lw=0.6, zorder=Z_DIM)
    for v in _ticks(fw):
        ax.plot([v, v], [y - ts * 0.5, y + ts * 0.5], color=DIM_INK, lw=0.6,
                zorder=Z_DIM)
        ax.plot([v, v], [y + ts * 0.6, 0], color=DIM_INK, lw=0.35, alpha=0.5,
                zorder=Z_DIM)
        ax.text(v, y - ts * 1.1, _fmt_m(v), fontsize=6.0, color=DIM_INK,
                ha="center", va="top", zorder=Z_DIM)
    x = -off
    ax.plot([x, x], [0, fd], color=DIM_INK, lw=0.6, zorder=Z_DIM)
    for v in _ticks(fd):
        ax.plot([x - ts * 0.5, x + ts * 0.5], [v, v], color=DIM_INK, lw=0.6,
                zorder=Z_DIM)
        ax.plot([x + ts * 0.6, 0], [v, v], color=DIM_INK, lw=0.35, alpha=0.5,
                zorder=Z_DIM)
        ax.text(x - ts * 1.1, v, _fmt_m(v), fontsize=6.0, color=DIM_INK,
                ha="right", va="center", zorder=Z_DIM)
    ax.text(fw / 2, y - ts * 3.5, f"W {_fmt_m(fw)} m", fontsize=6.6, color=INK_FAINT,
            ha="center", va="top", zorder=Z_DIM)
    ax.text(x - ts * 4.5, fd / 2, f"D {_fmt_m(fd)} m", fontsize=6.6, color=INK_FAINT,
            ha="center", va="center", rotation=90, zorder=Z_DIM)


def _draw_north(ax, x1: float, y1: float, span: float, pad_t: float) -> None:
    """Orientation marker (plan north) in the top-right of the sheet's plan band."""
    r = max(pad_t * 0.30, span * 0.014)
    cx, cy = x1 - r * 1.2, y1 + pad_t * 0.52
    ax.add_patch(Circle((cx, cy), r, facecolor="white", edgecolor=RULE, lw=0.7,
                        zorder=Z_MARK))
    ax.add_patch(Polygon([(cx, cy + r * 0.78), (cx - r * 0.36, cy - r * 0.52),
                          (cx, cy - r * 0.18)], closed=True, facecolor=INK,
                         edgecolor="none", zorder=Z_MARK + 0.1))
    ax.add_patch(Polygon([(cx, cy + r * 0.78), (cx + r * 0.36, cy - r * 0.52),
                          (cx, cy - r * 0.18)], closed=True, facecolor=INK_FAINT,
                         edgecolor="none", zorder=Z_MARK + 0.1))
    ax.text(cx + r * 1.5, cy, "N", fontsize=7.2, color=INK_DIM, ha="left",
            va="center", zorder=Z_MARK + 0.1)


# --- legend / scale strip ----------------------------------------------------

def _chip(fig, ax, x: float, y: float, kind: str, color, label: str,
          size: float = 6.6) -> float:
    """Draw one legend entry (swatch + label) at (x, y) in axes fraction."""
    sw = 0.015
    if kind == "line":
        ax.plot([x, x + sw], [y, y], color=color, lw=1.8, solid_capstyle="butt",
                clip_on=False)
    elif kind == "arrow":
        ax.annotate("", xy=(x + sw, y), xytext=(x, y),
                    arrowprops=dict(arrowstyle="-|>", color=color, lw=1.2,
                                    shrinkA=0, shrinkB=0, mutation_scale=7))
    elif kind == "box":
        fc, ec = color
        ax.add_patch(Rectangle((x, y - 0.055), sw, 0.11, facecolor=fc, edgecolor=ec,
                               lw=0.7, clip_on=False))
    elif kind == "belt":
        # The swatch IS the symbol: a bed with its frame and a travel arrow, so
        # the reader maps 凡例→図面 without guessing.
        ax.add_patch(Rectangle((x, y - 0.055), sw, 0.11, facecolor=BELT_BED,
                               edgecolor=BELT_EDGE, lw=0.7, clip_on=False))
        ax.annotate("", xy=(x + sw * 0.86, y), xytext=(x + sw * 0.16, y),
                    arrowprops=dict(arrowstyle="-|>", color=BELT_FLOW, lw=0.9,
                                    shrinkA=0, shrinkB=0, mutation_scale=6))
    else:  # solid swatch
        ax.add_patch(Rectangle((x, y - 0.048), sw, 0.096, facecolor=color,
                               edgecolor="none", clip_on=False))
    ax.text(x + sw + 0.006, y, label, fontsize=size, color=INK_DIM, va="center",
            ha="left")


def _draw_legend(fig, ax, items: list[tuple], x0: float, x1: float,
                 y_top: float, rows: int = 3, size: float = 6.6) -> None:
    """Flow-layout the legend chips into rows, measured (never overlapping)."""
    x, y, row = x0, y_top, 1
    for kind, color, label in items:
        w = 0.015 + 0.006 + _measure(fig, ax, label, size) + 0.018
        if x + w > x1 and x > x0:
            if row >= rows:
                break
            row += 1
            x, y = x0, y - 0.28
        _chip(fig, ax, x, y, kind, color, label, size)
        x += w


def _draw_scalebar(fig, ax, x0: float, y: float, m_per_axfrac: float,
                   ratio: float) -> None:
    """A true-to-scale segmented bar (alternating fill) + 縮尺 caption."""
    # Pick a round bar length (1/2/5 × 10ⁿ m) whose drawn width lands near the
    # target — halving a "nice" number would give 12.5 m, which reads as a bug.
    target = 0.12
    cands = [m * 10.0 ** e for e in range(-1, 5) for m in (1.0, 2.0, 5.0)]
    fits = [c for c in cands if 0.06 <= c / m_per_axfrac <= 0.145]
    length = min(fits or cands,
                 key=lambda c: abs(c / m_per_axfrac - target))
    w = length / m_per_axfrac
    seg = w / 4.0
    ax.text(x0, y + 0.30, "縮尺", fontsize=6.8, color=INK_FAINT, va="center",
            ha="left", transform=ax.transAxes)
    for i in range(4):
        ax.add_patch(Rectangle((x0 + seg * i, y - 0.10), seg, 0.15,
                               facecolor=(INK if i % 2 == 0 else "white"),
                               edgecolor=INK, lw=0.5, transform=ax.transAxes,
                               clip_on=False))
    for i, v in ((0, 0.0), (2, length / 2), (4, length)):
        ax.text(x0 + seg * i, y - 0.19, _fmt_m(v), fontsize=6.0, color=INK_FAINT,
                ha="center", va="top", transform=ax.transAxes)
    ax.text(x0 + w + 0.010, y - 0.02, "m", fontsize=6.0, color=INK_FAINT,
            ha="left", va="center", transform=ax.transAxes)
    if ratio > 0:
        ax.text(x0 + 0.036, y + 0.30, f"1:{ratio:,.0f}", fontsize=6.6, color=INK_DIM,
                va="center", ha="left", transform=ax.transAxes)


def _draw_colorbar(fig, ax, x0: float, x1: float, y: float, peak: float | None,
                   cmap, power: float = 1.0) -> None:
    """Horizontal congestion colourbar with an honest 'no data' state."""
    ax.text(x0, y + 0.30, "混雑度（通過回数）", fontsize=6.8, color=INK_FAINT,
            va="center", ha="left", transform=ax.transAxes)
    if peak is None:
        ax.text(x0, y - 0.05, "シミュレーション未実行のため表示なし", fontsize=6.4,
                color=INK_FAINT, va="center", ha="left", transform=ax.transAxes)
        return
    w = x1 - x0
    ax.add_patch(Rectangle((x0, y - 0.10), w, 0.15, facecolor="white",
                           edgecolor="none", transform=ax.transAxes, clip_on=False,
                           zorder=1))
    # Gradient as thin strips (the ramp carries alpha, so the pale end simply
    # shows the white bar underneath — exactly what quiet floor looks like).
    n = 96
    for i in range(n):
        ax.add_patch(Rectangle((x0 + w * i / n, y - 0.10), w / n * 1.02, 0.15,
                               facecolor=cmap((i + 0.5) / n), edgecolor="none",
                               transform=ax.transAxes, clip_on=False, zorder=2))
    ax.add_patch(Rectangle((x0, y - 0.10), w, 0.15, facecolor="none",
                           edgecolor=RULE, lw=0.6, transform=ax.transAxes,
                           clip_on=False, zorder=3))
    # Ticks sit at their true (power-scaled) position, so the numbers stay honest
    # even though the ramp lifts mid traffic for readability.
    for v in (0.0, peak / 2.0, peak):
        f = (v / peak) ** power if peak > 0 else 0.0
        ax.text(x0 + w * f, y - 0.19, f"{v:,.0f}", fontsize=6.0, color=INK_FAINT,
                ha="center", va="top", transform=ax.transAxes)
    ax.text(x1 + 0.008, y - 0.02, "回", fontsize=6.0, color=INK_FAINT, ha="left",
            va="center", transform=ax.transAxes)


# --- KPI panel ---------------------------------------------------------------

def _kpi_rows(kpis: dict) -> list[tuple]:
    """(label, value, unit, tone) — the proposal's headline numbers."""
    cur = kpis.get("currency", "¥")
    bn_u = _safe(kpis.get("bottleneck_utilization"))
    rows: list[tuple] = [
        ("処理能力", f"{_safe(kpis.get('throughput_per_hr')):,.0f}", "件/時", None),
        ("出荷完了", f"{_safe(kpis.get('orders_completed')):,.0f}",
         f"/ {_safe(kpis.get('orders_arrived')):,.0f} 件", None),
        ("ボトルネック", str(kpis.get("bottleneck_jp") or "—"),
         f"稼働 {bn_u * 100:.0f}%", "warn" if bn_u >= 0.85 else None),
        ("ピッカー", f"{_safe(kpis.get('n_pickers')):,.0f}", "名 ／ 稼働 "
         f"{_safe(kpis.get('picker_utilization')) * 100:.0f}%", None),
        ("梱包台", f"{_safe(kpis.get('n_packers')):,.0f}", "台 ／ 稼働 "
         f"{_safe(kpis.get('packer_utilization')) * 100:.0f}%", None),
        ("1件あたり歩行", f"{_safe(kpis.get('walk_per_order_m')):,.0f}", "m", None),
    ]
    if kpis.get("total_cost_per_order"):
        cpo = _safe(kpis.get("total_cost_per_order"))
        rows.append(("1件あたり原価",
                     f"{cur}{cpo:,.0f}" if abs(cpo) >= 100 else f"{cur}{cpo:,.1f}",
                     "/件", None))
    if kpis.get("monthly_cost"):
        rows.append(("月間コスト", f"{cur}{_safe(kpis.get('monthly_cost')):,.0f}",
                     "/月", None))
    reps = _safe(kpis.get("replications"), 1)
    if reps > 1:
        rows.append((f"安定度（{int(reps)}回検証）",
                     f"{_safe(kpis.get('robustness')) * 100:.0f}", "%", "ok"))
    if not kpis:
        # No run yet: show the shape of the report honestly, not fake zeros.
        rows = [(lb, "—", "", None) for lb, _, _, _ in rows]
    return rows


def _card(fig, ax, x: float, y: float, w: float, h: float, label: str, value: str,
          unit: str, tone: str | None) -> None:
    """One KPI card: label, big value, dim unit — with a tone accent rule."""
    ec = {"warn": "#E9D6AE", "bad": "#EFC7C4", "ok": "#BFE3DA"}.get(tone, RULE)
    ink = {"warn": WARN_INK, "bad": BAD_INK, "ok": OK_INK}.get(tone, INK)
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle="round,pad=0,rounding_size=0.012", linewidth=0.8,
        edgecolor=ec, facecolor=SURFACE, transform=ax.transAxes, clip_on=False,
        zorder=2))
    if tone:
        ax.add_patch(Rectangle((x, y), 0.006, h, facecolor=ink, edgecolor="none",
                               transform=ax.transAxes, clip_on=False, zorder=3))
    px = x + 0.030
    ax.text(px, y + h * 0.70, label, fontsize=6.8, color=INK_FAINT, va="center",
            zorder=4, transform=ax.transAxes)
    size = 13.0
    avail = w - 0.055 - (_measure(fig, ax, " " + unit, 7.0) if unit else 0.0)
    while size > 8.0 and _measure(fig, ax, value, size) > avail:
        size -= 0.75
    ax.text(px, y + h * 0.30, value, fontsize=size, color=ink, va="center",
            zorder=4, transform=ax.transAxes, **_emph(ink, size))
    if unit:
        ax.text(px + _measure(fig, ax, value, size) + 0.008, y + h * 0.27, unit,
                fontsize=7.0, color=INK_FAINT, va="center", zorder=4,
                transform=ax.transAxes)


def _section(fig, ax, y: float, title: str) -> float:
    ax.text(0.0, y, title, fontsize=8.2, color=INK, va="top", zorder=4,
            transform=ax.transAxes, **_emph(INK, 8.2))
    ax.plot([0.0, 1.0], [y - 0.020, y - 0.020], color=RULE_SOFT, lw=0.8,
            transform=ax.transAxes, clip_on=False, zorder=1)
    return y - 0.036


# --- the sheet ---------------------------------------------------------------

def render(
    model: WarehouseModel,
    heat: np.ndarray,
    kpis: dict,
    provenance_summary: str,
    out_path: str | Path,
    *,
    routes=None,
    dpi: int = 200,
    sheet_title: str | None = None,
) -> Path:
    """Write the proposal sheet PNG and return its path.

    `routes` (optional) is any iterable of polylines — ``[[(x, y), …], …]`` or
    ``[{"points": [[x, y], …]}, …]`` — drawn as the 動線 overlay. All extra
    arguments are keyword-only and defaulted, so existing callers are unchanged.
    """
    out_path = Path(out_path)
    kpis = kpis or {}
    bounds = model.layout.bounds
    # Degenerate geometry guard: a zero-sized floor would make matplotlib choke
    # on limits / aspect; clamp to a sane minimum so the image stays legible.
    fw = max(_safe(getattr(bounds, "width", 0.0)), 1.0)
    fd = max(_safe(getattr(bounds, "depth", 0.0)), 1.0)
    # Widen the view to whatever is actually drawn (imported models occasionally
    # place a zone outside the declared envelope; cropping would hide that).
    ex0, ey0, ex1, ey1 = _content_extent(model, fw, fd)
    span = max(ex1 - ex0, ey1 - ey0, 1.0)

    fig = plt.figure(figsize=(FIG_W, FIG_H), facecolor=PAPER)

    # --- header band ---------------------------------------------------------
    head = _blank_axes(fig, (ML, 0.902, MR - ML, 0.072))
    head.text(0.0, 0.42, "WHSiM", fontsize=19, color=INK, va="center", ha="left",
              **_emph(INK, 19))
    head.text(0.088, 0.34, "WAREHOUSE  SIMULATOR", fontsize=7.2, color=INK_FAINT,
              va="center", ha="left")
    title = sheet_title or model.meta.name or "倉庫レイアウト"
    head.text(0.5, 0.62, "レイアウト検証レポート", fontsize=7.4, color=INK_FAINT,
              va="center", ha="center")
    head.text(0.5, 0.26, title, fontsize=13.5, color=INK, va="center", ha="center",
              **_emph(INK, 13.5))
    today = date.today().strftime("%Y-%m-%d")
    head.text(1.0, 0.62, today, fontsize=8.6, color=INK_DIM, va="center", ha="right")
    head.text(1.0, 0.24, "概算検討資料", fontsize=7.2, color=INK_FAINT, va="center",
              ha="right")
    head.plot([0, 1], [-0.06, -0.06], color=RULE, lw=1.0, clip_on=False)

    # --- plan geometry: fit the drawing box to the floor's aspect -------------
    pad_l = span * 0.095
    pad_b = span * 0.095
    pad_r = span * 0.022
    pad_t = span * 0.058
    xspan = (ex1 - ex0) + pad_l + pad_r
    yspan = (ey1 - ey0) + pad_b + pad_t
    col_w = COL_SPLIT - ML
    box_h = (CONTENT_TOP - CONTENT_BOT) - STRIP_H - 0.018
    avail_w_in, avail_h_in = col_w * FIG_W, box_h * FIG_H
    if avail_w_in / avail_h_in > xspan / yspan:
        h_in = avail_h_in
        w_in = h_in * xspan / yspan
    else:
        w_in = avail_w_in
        h_in = w_in * yspan / xspan
    plan_w, plan_h = w_in / FIG_W, h_in / FIG_H
    plan_x = ML + (col_w - plan_w) / 2.0
    plan_y = CONTENT_TOP - plan_h
    ax = fig.add_axes((plan_x, plan_y, plan_w, plan_h))

    fig.text(ML, CONTENT_TOP + 0.016, "レイアウト平面図", fontsize=10.5, color=INK,
             va="bottom", ha="left", **_emph(INK, 10.5))

    # --- plan drawing --------------------------------------------------------
    ax.set_xlim(ex0 - pad_l, ex1 + pad_r)
    ax.set_ylim(ey0 - pad_b, ey1 + pad_t)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    m_per_px = xspan / max(w_in * dpi, 1.0)
    step = _nice_step(span)

    ax.add_patch(Rectangle((0, 0), fw, fd, facecolor=FLOOR, edgecolor="none",
                           zorder=Z_FLOOR))
    _draw_grid(ax, fw, fd, step)
    zone_types = _draw_zones(ax, model, span)

    peak = None
    cmap = congestion_cmap()
    fld = heat_field(heat)
    if fld is not None:
        hf, peak = fld
        # Drawn linearly: the colourmap itself does the heavy-tail lifting
        # (hue fast, alpha slow), so the plan underneath stays readable.
        ax.imshow(hf, extent=(0, fw, 0, fd), origin="lower", cmap=cmap, vmin=0,
                  vmax=1, zorder=Z_HEAT, aspect="auto", interpolation="bilinear")

    rack_types = _draw_racks(ax, model, m_per_px)
    belts = _draw_conveyors(ax, model, span, m_per_px)
    wall_t, door_kinds = _draw_shell(ax, model, fw, fd)
    has_routes = _draw_routes(ax, routes)
    flow_steps = _draw_flow(ax, model, span)
    has_station = _draw_stations(ax, model, span)
    _draw_dims(ax, fw, fd, step, pad_b * 0.45)
    _draw_north(ax, ex1, ey1, span, pad_t)
    if not model.layout.zones and not rack_types:
        ax.text(fw / 2, fd / 2, "レイアウト未設定\n（テンプレートまたは図面を取り込むと"
                "ここに平面図が描画されます）", fontsize=8.5, color=INK_FAINT,
                ha="center", va="center", linespacing=1.6, zorder=Z_MARK)

    # Subtitle names only the overlays that were actually drawn (never promises
    # a heatmap on a model that has not been run).
    overlays = [t for t, on in (("混雑度", peak is not None),
                                ("工程フロー", bool(flow_steps)),
                                ("動線", has_routes)) if on]
    if overlays:
        fig.text(ML + 0.078, CONTENT_TOP + 0.018, "／ " + "・".join(overlays) + "重ね",
                 fontsize=7.6, color=INK_FAINT, va="bottom", ha="left")

    # --- legend / scale / colourbar strip ------------------------------------
    strip = _blank_axes(fig, (ML, plan_y - 0.018 - STRIP_H, col_w, STRIP_H))
    strip.add_patch(FancyBboxPatch(
        (0, 0), 1, 1, boxstyle="round,pad=0,rounding_size=0.02", facecolor=SURFACE,
        edgecolor=RULE_SOFT, lw=0.8, transform=strip.transAxes, clip_on=False,
        zorder=0))
    # Zones are named in place by their corner tags, so the legend only carries
    # what the drawing cannot say for itself.
    items: list[tuple] = []
    if rack_types:
        for k, lbl in (("A", "A 高頻度"), ("B", "B 中頻度"), ("C", "C 低頻度")):
            items.append(("solid", _mute(ABC_COLOR[k], 0.72, 0.34), lbl))
        # Swatches must be the exact colours _draw_racks used, or the legend lies.
        for t in rack_types[:3]:
            items.append(("box", (_mute(racktypes.color(t), 0.16, 0.90),
                                  _shade(racktypes.color(t), 0.38)),
                          racktypes.get(t)["label"]))
        items.append(("line", _shade(racktypes.color(rack_types[0]), 0.38),
                      "ピック面"))
    items.append(("solid", POCHE, "外壁"))
    if belts:
        items.append(("belt", None, "コンベア"))
    for k in door_kinds[:3]:
        items.append(("line", DOOR_STYLE.get(k, DOOR_STYLE["dock"])[0],
                      DOOR_STYLE.get(k, DOOR_STYLE["dock"])[1]))
    if flow_steps:
        items.append(("arrow", ACCENT, "工程フロー"))
    if has_routes:
        items.append(("line", _mute(ACCENT, 0.6, 0.30), "動線"))
    if has_station:
        items.append(("box", ("white", ACCENT), "梱包台"))
    if zone_types and not rack_types:  # bare/no-rack model: name the zone tints
        for zt, base in zone_types[:5]:
            items.append(("box", (_mute(base, 0.42, 0.82), _mute(base, 0.70, 0.30)),
                          ZONE_JP.get(zt, zt)))
    _draw_legend(fig, strip, items, 0.024, 0.500, 0.78)

    m_per_axfrac = xspan / (plan_w / col_w)  # metres per strip-axes x fraction
    ratio = 1.0 / max((plan_w * FIG_W / xspan) * 0.0254, 1e-9)
    _draw_scalebar(fig, strip, 0.545, 0.45, m_per_axfrac, ratio)
    _draw_colorbar(fig, strip, 0.755, 0.950, 0.45, peak, cmap)

    # --- right panel: verdict + KPI cards + 保管設計 --------------------------
    panel = _blank_axes(fig, (PANEL_X, CONTENT_BOT, MR - PANEL_X,
                              CONTENT_TOP - CONTENT_BOT))
    y = _section(fig, panel, 1.0, "判定")
    can = bool(kpis.get("can_handle_demand", False))
    verdict = str(kpis.get("verdict") or "シミュレーション未実行です。"
                  "▶実行すると判定が入ります。")
    # Tone escalates with the miss: 対応可能 → 要注意 → 危険 (most orders unshipped).
    arrived = _safe(kpis.get("orders_arrived"))
    severe = arrived > 0 and _safe(kpis.get("orders_completed")) / arrived < 0.6
    if not kpis:
        v_bg, v_ink = SURFACE, INK_DIM
    elif can:
        v_bg, v_ink = OK_BG, OK_INK
    else:
        v_bg, v_ink = (BAD_BG, BAD_INK) if severe else (WARN_BG, WARN_INK)
    lines = _wrap(verdict, 56)[:4]
    bh = 0.026 + 0.025 * len(lines)
    panel.add_patch(FancyBboxPatch(
        (0.0, y - bh), 1.0, bh, boxstyle="round,pad=0,rounding_size=0.012",
        linewidth=0, facecolor=v_bg, transform=panel.transAxes, clip_on=False,
        zorder=1))
    panel.add_patch(Rectangle((0.0, y - bh), 0.008, bh, facecolor=v_ink,
                              transform=panel.transAxes, clip_on=False, zorder=2))
    panel.text(0.028, y - bh / 2, "\n".join(lines), fontsize=8.8, color=v_ink,
               va="center", ha="left", linespacing=1.45, zorder=3,
               transform=panel.transAxes, **_emph(v_ink, 8.8))
    y -= bh + 0.034

    # 保管設計 band (only when demand actually sizes some storage).
    try:
        est = storage.estimate_storage(model, {})
    except Exception:  # noqa: BLE001 — a sizing failure must never break the PNG
        est = {"has_data": False}
    has_storage = bool(est.get("has_data"))
    # 保管設計 band + 搬送設備 band + 前提 note (reserved so the KPI cards never
    # eat the space the equipment list needs).
    belt_rows = min(len(belts), 3) + (1 if len(belts) > 3 else 0)
    reserve = ((0.121 if has_storage else 0.0)
               + ((0.050 + 0.024 * belt_rows) if belts else 0.0) + 0.085)

    y = _section(fig, panel, y, "主要指標")
    rows = _kpi_rows(kpis)
    card_h, gap = 0.078, 0.014
    n_rows = max(1, min(5, int((y - reserve) / (card_h + gap))))
    rows = rows[: n_rows * 2]
    cw = (1.0 - 0.018) / 2.0
    for i, (label, value, unit, tone) in enumerate(rows):
        cx = 0.0 if i % 2 == 0 else cw + 0.018
        cy = y - card_h - (i // 2) * (card_h + gap)
        _card(fig, panel, cx, cy, cw, card_h, label, value, unit, tone)
    y = y - math.ceil(len(rows) / 2) * (card_h + gap) - 0.016

    if has_storage:
        tot = est.get("totals", {})
        y = _section(fig, panel, y, "保管設計")
        panel.text(0.0, y, f"必要坪数 {tot.get('tsubo_storage', 0):g} 坪 ／ "
                   f"什器 {tot.get('units', 0)}台（{tot.get('cells', 0)}間口）",
                   fontsize=7.8, color=INK, va="top", transform=panel.transAxes)
        y -= 0.026
        methods = sorted(est.get("by_method", []), key=lambda m: m.get("units", 0),
                         reverse=True)[:3]
        cx = 0.0
        for m in methods:
            chip = f"{m.get('label', m.get('rack_type', ''))} {m.get('units', 0)}台"
            panel.add_patch(Rectangle((cx, y - 0.012), 0.014, 0.012,
                                      facecolor=_mute(m.get("color", "#888"), 0.5, 0.35),
                                      edgecolor="none", transform=panel.transAxes,
                                      clip_on=False))
            panel.text(cx + 0.020, y - 0.006, chip, fontsize=6.8, color=INK_DIM,
                       va="center", ha="left", transform=panel.transAxes)
            cx += 0.020 + _measure(fig, panel, chip, 6.8) + 0.024
        y -= 0.030

    # 搬送設備: the belt's own spec sheet — length and speed are the first two
    # questions a customer asks about a transport line, so they are quoted here
    # (and on the plan tag) rather than left to be measured off the drawing.
    if belts and y - 0.085 >= 0.046 + 0.024 * belt_rows:
        y = _section(fig, panel, y, "搬送設備")
        for i, spec in enumerate(belts[:3], start=1):
            name = "コンベア" if len(belts) == 1 else f"コンベア{i}"
            panel.add_patch(Rectangle((0.0, y - 0.013), 0.014, 0.010,
                                      facecolor=BELT_BED, edgecolor=BELT_EDGE,
                                      lw=0.5, transform=panel.transAxes,
                                      clip_on=False))
            panel.text(0.020, y - 0.008, name, fontsize=7.6, color=INK, ha="left",
                       va="center", transform=panel.transAxes)
            panel.text(1.0, y - 0.008, _belt_spec(spec, " ／ "), fontsize=7.2,
                       color=INK_FAINT, ha="right", va="center",
                       transform=panel.transAxes)
            y -= 0.024
        if len(belts) > 3:
            total = sum(s["length_m"] for s in belts)
            panel.text(0.020, y - 0.008,
                       f"ほか {len(belts) - 3} 本（全 {len(belts)} 本・合計 "
                       f"{total:,.0f} m）", fontsize=7.0, color=INK_FAINT,
                       ha="left", va="center", transform=panel.transAxes)
            y -= 0.024
        y -= 0.014

    # 工程フロー: the same numbering as the badges on the plan, as readable text.
    if flow_steps and y - 0.085 >= 0.040 + 0.025 * len(flow_steps):
        areas: dict[str, float] = {}
        for z in model.layout.zones:
            try:
                areas[z.type] = areas.get(z.type, 0.0) + float(z.w) * float(z.h)
            except (TypeError, ValueError):
                continue
        y = _section(fig, panel, y, "工程フロー")
        for i, zt in enumerate(flow_steps, start=1):
            panel.text(0.012, y - 0.011, str(i), fontsize=5.8, color="white",
                       ha="center", va="center", zorder=4, transform=panel.transAxes,
                       bbox=dict(boxstyle="circle,pad=0.20", facecolor=ACCENT,
                                 edgecolor="none"))
            panel.text(0.042, y - 0.011, ZONE_JP.get(zt, zt), fontsize=7.6,
                       color=INK, ha="left", va="center", transform=panel.transAxes)
            panel.text(1.0, y - 0.011, f"{areas.get(zt, 0.0):,.0f} m²", fontsize=7.2,
                       color=INK_FAINT, ha="right", va="center",
                       transform=panel.transAxes)
            if i < len(flow_steps):
                panel.plot([0.0, 1.0], [y - 0.025, y - 0.025], color=RULE_SOFT,
                           lw=0.6, transform=panel.transAxes, clip_on=False,
                           zorder=1)
            y -= 0.025

    cur = kpis.get("currency", "¥")
    note = "本図は概算検討用のシミュレーション結果です。"
    if kpis.get("total_cost_per_order"):
        note += (f"\n前提: 人件費 {cur}{_safe(kpis.get('labour_rate_per_hr')):,.0f}/人時"
                 f" ／ 設備投資 {cur}{_safe(kpis.get('capex_total')):,.0f}（36ヶ月償却）")
    panel.text(0.0, 0.012, note, fontsize=6.6, color=INK_FAINT, va="bottom",
               ha="left", linespacing=1.5, transform=panel.transAxes)

    # --- title block (drawing-sheet footer) ----------------------------------
    tb = _blank_axes(fig, (ML, 0.024, MR - ML, 0.060))
    tb.add_patch(FancyBboxPatch(
        (0, 0), 1, 1, boxstyle="round,pad=0,rounding_size=0.10", facecolor=SURFACE,
        edgecolor=RULE, lw=0.8, transform=tb.transAxes, clip_on=False, zorder=0))
    prov = str(provenance_summary or "")
    m_real = re.search(r"実データ\s*([\d.]+)\s*%", prov)
    mpc = m_real or re.search(r"([\d.]+)\s*%", prov)
    real_pct = f"{mpc.group(1)}%" if mpc else "—"
    if "／" in prov:
        rest = prov.split("／", 1)[1].strip()
    elif m_real:  # never print 実データ N% twice across two adjacent cells
        rest = prov.replace(m_real.group(0), "").strip(" 　／・")
    else:
        rest = prov
    cells = [
        ("案件名", title, 0.235),
        ("作成日", today, 0.105),
        ("縮尺", f"1:{ratio:,.0f}", 0.085),
        ("床面積", f"{_fmt_m(fw)} × {_fmt_m(fd)} m　({fw * fd:,.0f} m²)", 0.185),
        ("実データ", real_pct, 0.075),
        ("データ出所", rest or "—", 0.315),
    ]
    cx = 0.0
    for i, (label, value, w) in enumerate(cells):
        if i:
            tb.plot([cx, cx], [0.16, 0.84], color=RULE, lw=0.7,
                    transform=tb.transAxes, clip_on=False, zorder=1)
        tb.text(cx + 0.010, 0.70, label, fontsize=6.2, color=INK_FAINT, va="center",
                ha="left", transform=tb.transAxes, zorder=2)
        val = _ellipsis(fig, tb, str(value), 8.0, w - 0.022)
        tb.text(cx + 0.010, 0.30, val, fontsize=8.0,
                color=(ACCENT if label == "実データ" else INK), va="center",
                ha="left", transform=tb.transAxes, zorder=2)
        cx += w

    fig.savefig(out_path, dpi=dpi, facecolor=PAPER)
    plt.close(fig)
    return out_path
