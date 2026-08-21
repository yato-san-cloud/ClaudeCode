"""Server-side animated 2D replay (GIF) -- no browser required.

Renders the worker trajectories from a replay document as a looping GIF: workers
move along their routes, coloured by state, over the warehouse layout. Used both
as a shareable artifact and as a headless way to prove the motion is real.

Conveyors are drawn as the static belt symbol (the same band/roller/arrow
language as the proposal PNG), and — when the run recorded them — the goods
riding the line are animated along their own tote keyframes, so the GIF shows
the transport actually flowing rather than an empty belt. Both are guarded: a
replay with no `conveyors` / no `totes` (every run made before the engine
emitted them) draws exactly what it drew before.
"""

from __future__ import annotations

import bisect
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.animation import FuncAnimation, PillowWriter  # noqa: E402
from matplotlib.collections import LineCollection  # noqa: E402
from matplotlib.patches import Polygon, Rectangle  # noqa: E402

from whsim.labels import ABC_COLOR, ZONE_JP  # noqa: E402
from whsim.render.fonts import setup_jp_font  # noqa: E402
from whsim.render.png2d import (  # noqa: E402
    BELT_BED,
    BELT_EDGE,
    BELT_FLOW,
    BELT_ROLLER,
    BELT_W_M,
    belt_at,
    belt_band,
    belt_length,
    belt_points,
)

setup_jp_font()

STATE_COLOR = {"idle": "#9e9e9e", "travel": "#1f78b4", "carry": "#6a3d9a",
               "pick": "#33a02c", "pack": "#e31a1c", "inspect": "#ffb300",
               "belt": "#00838f"}


def _interp(keyframes: list, t: float) -> tuple[float, float, str]:
    if not keyframes:
        return (0.0, 0.0, "idle")
    ts = [k[0] for k in keyframes]
    i = bisect.bisect_right(ts, t) - 1
    if i < 0:
        k = keyframes[0]
        return (k[1], k[2], "idle")
    if i >= len(keyframes) - 1:
        k = keyframes[-1]
        return (k[1], k[2], k[3])
    k0, k1 = keyframes[i], keyframes[i + 1]
    span = max(k1[0] - k0[0], 1e-9)
    f = min(max((t - k0[0]) / span, 0.0), 1.0)
    return (k0[1] + (k1[1] - k0[1]) * f, k0[2] + (k1[2] - k0[2]) * f, k0[3])


def _draw_conveyors(ax, replay: dict, floor: float) -> None:
    """Static belt symbol: the band at its real width, roller ticks and travel
    arrowheads pointing points[0] → points[-1] (the direction goods move).

    No conveyors in the replay ⇒ nothing is drawn and nothing changes; a
    degenerate line (one point / zero length / NaN) is skipped by belt_points.
    """
    lines = []
    for cv in (replay.get("conveyors") or []):
        pts = belt_points((cv or {}).get("points"))
        length = belt_length(pts)
        if len(pts) >= 2 and length > 1e-6:
            lines.append((pts, length))
    if not lines:
        return
    # Real 0.6 m belt, floored relative to the floor so it survives a big DC.
    bw = max(BELT_W_M, floor * 0.006)
    for pts, _length in lines:
        band = belt_band(pts, bw)
        if len(band) >= 3:
            ax.add_patch(Polygon(band, closed=True, facecolor=BELT_BED,
                                 edgecolor=BELT_EDGE, lw=0.6, joinstyle="miter",
                                 zorder=1.5))
    segs = []
    for pts, length in lines:
        step = max(bw * 1.6, length / 160.0)
        for i in range(1, int(length / step) + 1):
            bx, by, ux, uy = belt_at(pts, step * i)
            nx, ny = -uy * bw * 0.40, ux * bw * 0.40
            segs.append([(bx - nx, by - ny), (bx + nx, by + ny)])
    if segs:
        ax.add_collection(LineCollection(segs, colors=[BELT_ROLLER],
                                         linewidths=0.35, zorder=1.6))
    for pts, length in lines:
        n_arrow = max(1, min(10, int(round(length / max(bw * 12.0, 6.0)))))
        # Travel arrowheads along the run, plus a heavier one whose TIP lands on
        # the discharge end: the goods leave the line there (it feeds packing),
        # which is the one point a viewer of a moving picture must be able to find.
        places = [(length * (k + 0.5) / n_arrow, 1.0) for k in range(n_arrow)]
        places.append((length, 1.5))
        for s, big in places:
            bx, by, ux, uy = belt_at(pts, s)
            ln, half = bw * 1.4 * big, bw * 0.45 * big
            back = ln * 0.5 if big > 1.0 else 0.0     # tip on the end, not past it
            cx, cy = bx - ux * back, by - uy * back
            nx, ny = -uy * half, ux * half
            tail = (cx - ux * ln * 0.5, cy - uy * ln * 0.5)
            ax.add_patch(Polygon([(cx + ux * ln * 0.5, cy + uy * ln * 0.5),
                                  (tail[0] + nx, tail[1] + ny),
                                  (tail[0] - nx, tail[1] - ny)], closed=True,
                                 facecolor=BELT_FLOW, edgecolor="white", lw=0.3,
                                 zorder=1.7))


def render_gif(replay: dict, out_path: str | Path, seconds: float = 14.0,
               fps: int = 12) -> Path:
    out_path = Path(out_path)
    bounds = replay["meta"]["bounds"]
    window = replay["meta"].get("replay_window_s") or replay["meta"]["duration_s"]
    kpis = replay.get("kpis", {})

    fig, ax = plt.subplots(figsize=(10, 5.2))
    ax.set_xlim(-1, bounds["width"] + 1)
    ax.set_ylim(-1, bounds["depth"] + 1)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])

    # static layer: floor, zones, racks
    ax.add_patch(Rectangle((0, 0), bounds["width"], bounds["depth"],
                           fill=False, edgecolor="#333", lw=1.5))
    for z in replay["zones"]:
        ax.add_patch(Rectangle((z["x"], z["y"]), z["w"], z["h"],
                               facecolor=z.get("color") or "#eee", alpha=0.3,
                               edgecolor="#ccc", lw=0.6))
        ax.text(z["x"] + z["w"] / 2, z["y"] + z["h"] / 2,
                ZONE_JP.get(z["type"], z["type"]),
                ha="center", va="center", fontsize=7, color="#888")
    if replay["racks"]:
        ax.scatter([r["x"] for r in replay["racks"]],
                   [r["y"] for r in replay["racks"]],
                   c=[ABC_COLOR.get(r["abc"], "#ccc") for r in replay["racks"]],
                   marker="s", s=10, zorder=2)
    _draw_conveyors(ax, replay,
                    max(float(bounds.get("width") or 0.0),
                        float(bounds.get("depth") or 0.0), 1.0))
    for s in replay["stations"]:
        ax.plot(s["x"], s["y"], "*", ms=16, color="#08519c", zorder=3)

    workers = replay["workers"]
    scat = ax.scatter([], [], s=90, zorder=6, edgecolors="black", linewidths=0.6)
    # コンベア搬送の荷物: only when the run recorded tote tracks. Without them the
    # figure has exactly the artists it always had, so older runs are unchanged.
    totes = [t for t in (replay.get("totes") or []) if t.get("keyframes")]
    tscat = None
    if totes:
        tscat = ax.scatter([], [], s=22, marker="s", zorder=5,
                           edgecolors="#37352F", linewidths=0.4)
    title = ax.set_title("", fontsize=10, loc="left")
    verdict = kpis.get("verdict", "")

    frames = max(1, int(seconds * fps))

    def update(frame):
        t = window * frame / frames
        xs, ys, cs = [], [], []
        for w in workers:
            x, y, st = _interp(w["keyframes"], t)
            xs.append(x)
            ys.append(y)
            cs.append(STATE_COLOR.get(st, "#999"))
        # When there are no workers, pass an explicit (0, 2) array: matplotlib
        # treats an empty list as 1-D and raises on set_offsets.
        offsets = np.column_stack([xs, ys]) if xs else np.empty((0, 2))
        scat.set_offsets(offsets)
        if cs:
            scat.set_color(cs)
        if tscat is not None:
            # A tote only exists between its first and last keyframe: outside
            # that window it must not sit parked on the belt (a worker is always
            # on the floor, a good is not).
            txs, tys, tcs = [], [], []
            for tt in totes:
                kf = tt["keyframes"]
                if kf[0][0] <= t <= kf[-1][0]:
                    x, y, st = _interp(kf, t)
                    txs.append(x)
                    tys.append(y)
                    tcs.append(STATE_COLOR.get(st, "#00838f"))
            tscat.set_offsets(np.column_stack([txs, tys]) if txs
                              else np.empty((0, 2)))
            if tcs:
                tscat.set_color(tcs)
        title.set_text(f"{replay['meta']['name']}   {t/60:4.1f}分   |  {verdict}")
        return (scat, title) if tscat is None else (scat, tscat, title)

    anim = FuncAnimation(fig, update, frames=frames, interval=1000 / fps, blit=False)
    anim.save(out_path, writer=PillowWriter(fps=fps))
    plt.close(fig)
    return out_path
