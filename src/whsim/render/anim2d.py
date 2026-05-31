"""Server-side animated 2D replay (GIF) -- no browser required.

Renders the worker trajectories from a replay document as a looping GIF: workers
move along their routes, coloured by state, over the warehouse layout. Used both
as a shareable artifact and as a headless way to prove the motion is real.
"""

from __future__ import annotations

import bisect
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.animation import FuncAnimation, PillowWriter  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402

from whsim.render.fonts import setup_jp_font  # noqa: E402

setup_jp_font()

ABC_COLOR = {"A": "#d7301f", "B": "#fc8d59", "C": "#fdcc8a"}
ZONE_JP = {"receiving": "入荷", "storage": "保管", "picking": "ピッキング",
           "packing": "梱包", "shipping": "出荷", "staging": "一時保管"}
STATE_COLOR = {"idle": "#9e9e9e", "travel": "#1f78b4", "carry": "#6a3d9a",
               "pick": "#33a02c", "pack": "#e31a1c"}


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
    for s in replay["stations"]:
        ax.plot(s["x"], s["y"], "*", ms=16, color="#08519c", zorder=3)

    workers = replay["workers"]
    scat = ax.scatter([], [], s=90, zorder=6, edgecolors="black", linewidths=0.6)
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
        scat.set_offsets(list(zip(xs, ys)))
        scat.set_color(cs)
        title.set_text(f"{replay['meta']['name']}   {t/60:4.1f}分   |  {verdict}")
        return scat, title

    anim = FuncAnimation(fig, update, frames=frames, interval=1000 / fps, blit=False)
    anim.save(out_path, writer=PillowWriter(fps=fps))
    plt.close(fig)
    return out_path
