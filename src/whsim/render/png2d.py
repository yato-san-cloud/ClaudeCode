"""Render a one-glance, proposal-grade 2D PNG: layout + congestion + verdict.

Designed to be pasted straight into a sales slide. Laid out like a printed report
sheet: a branded header, one dominant verdict, the schematic floor plan with a
calm single-hue congestion overlay, a grid of KPI cards, and an honest provenance
footer. Stays a white "paper" sheet regardless of the app theme.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.patches import FancyBboxPatch, Rectangle  # noqa: E402

from matplotlib.colors import to_rgba  # noqa: E402

from whsim import racktypes  # noqa: E402
from whsim.render.fonts import setup_jp_font  # noqa: E402
from whsim.render.heatmap import blur  # noqa: E402
from whsim.render.shelves import shelf_runs  # noqa: E402
from whsim.labels import ABC_COLOR, ZONE_JP  # noqa: E402
from whsim.schema.model import WarehouseModel  # noqa: E402

# Proposal-sheet palette (light "paper"; deeper blue accent for ink legibility).
INK = "#16202e"
INK_DIM = "#5a6b7e"
INK_FAINT = "#8a99a8"
LINE = "#e4eaf1"
ACCENT = "#2f7bff"
OK_BG, OK_INK = "#e7f8f0", "#0f8a57"
WARN_BG, WARN_INK = "#fdf2e3", "#b3741a"
PAPER = "#ffffff"
# Calm single-hue congestion ramp (white → brand blue → deep navy).
CONGEST = LinearSegmentedColormap.from_list(
    "congest", ["#ffffff", "#cfe0fb", "#7fb0f2", "#2f7bff", "#0a3d91"])

setup_jp_font()


def _safe(val, default=0.0) -> float:
    """Read a numeric KPI defensively; never raise on None / non-numeric."""
    try:
        if val is None:
            return default
        return float(val)
    except (TypeError, ValueError):
        return default


def _card(ax, x, y, w, h, label, value, tone=None):
    """Draw a KPI card (rounded rect, mono-ish label + bold value) in axes coords."""
    ec = {"warn": "#efce9c", "bad": "#f0c2c8", "ok": "#bfe6cf"}.get(tone, LINE)
    val_col = {"warn": WARN_INK, "bad": "#c4453f", "ok": OK_INK}.get(tone, INK)
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle="round,pad=0.004,rounding_size=0.018",
        linewidth=1.0, edgecolor=ec, facecolor="#fbfcfe",
        transform=ax.transAxes, clip_on=False, zorder=2))
    ax.text(x + 0.05 * w, y + h * 0.66, label, transform=ax.transAxes,
            fontsize=7.6, color=INK_FAINT, va="center", zorder=3)
    ax.text(x + 0.05 * w, y + h * 0.30, value, transform=ax.transAxes,
            fontsize=12.5, color=val_col, weight="bold", va="center", zorder=3)


def render(
    model: WarehouseModel,
    heat: np.ndarray,
    kpis: dict,
    provenance_summary: str,
    out_path: str | Path,
) -> Path:
    out_path = Path(out_path)
    kpis = kpis or {}
    bounds = model.layout.bounds
    # Degenerate geometry guard: a zero-sized floor would make matplotlib choke
    # on limits / aspect; clamp to a sane minimum so the image stays legible.
    fw = max(float(getattr(bounds, "width", 0.0) or 0.0), 1.0)
    fd = max(float(getattr(bounds, "depth", 0.0) or 0.0), 1.0)

    fig = plt.figure(figsize=(13, 7.4), facecolor=PAPER)
    gs = fig.add_gridspec(2, 2, height_ratios=[0.085, 1.0],
                          width_ratios=[2.35, 1.0], hspace=0.05, wspace=0.13,
                          left=0.045, right=0.965, top=0.95, bottom=0.055)
    header = fig.add_subplot(gs[0, :])
    header.axis("off")
    header.set_xlim(0, 1)
    header.set_ylim(0, 1)
    ax = fig.add_subplot(gs[1, 0])
    panel = fig.add_subplot(gs[1, 1])
    panel.axis("off")
    panel.set_xlim(0, 1)
    panel.set_ylim(0, 1)

    # --- header band ---------------------------------------------------------
    header.text(0.0, 0.5, "WHSiM", fontsize=21, weight="bold", color=INK,
                va="center", ha="left")
    header.text(0.118, 0.42, "WAREHOUSE SIMULATOR", fontsize=8.5, color=INK_FAINT,
                va="center", ha="left")
    title = model.meta.name or "倉庫レイアウト"
    header.text(0.50, 0.5, title, fontsize=12.5, weight="bold", color=INK,
                va="center", ha="center")
    header.text(1.0, 0.5, date.today().strftime("%Y-%m-%d") + " 提案",
                fontsize=9, color=INK_FAINT, va="center", ha="right")
    header.plot([0, 1], [-0.05, -0.05], color=LINE, lw=1.2, clip_on=False)

    # --- floor plan ----------------------------------------------------------
    ax.add_patch(Rectangle((0, 0), fw, fd, fill=True, facecolor="#f7fafc",
                           edgecolor="#cfd9e4", lw=1.4, zorder=0))
    for z in model.layout.zones:
        ax.add_patch(Rectangle((z.x, z.y), z.w, z.h, facecolor=z.color or "#eef2f6",
                               alpha=0.45, edgecolor="#c3cedb", lw=0.8, zorder=1))
        ax.text(z.x + z.w / 2, z.y + z.h / 2, ZONE_JP.get(z.type, z.type),
                ha="center", va="center", fontsize=8.5, color=INK_DIM, zorder=2)
    # Storage drawn as MapMaker-style shelf runs (rack blocks), not loose dots:
    # the run body is tinted by storage-equipment type, with ABC-coloured bays.
    present_types: list[str] = []
    for run in shelf_runs(model):
        x, y0, y1, d = run["x"], run["y0"], run["y1"], run["depth"]
        pitch = run.get("pitch", 1.0)
        rtid = run.get("rack_type", "medium")
        if rtid not in present_types:
            present_types.append(rtid)
        rc = racktypes.color(rtid)
        ax.add_patch(Rectangle((x - d / 2, y0), d, y1 - y0, facecolor=to_rgba(rc, 0.18),
                               edgecolor=to_rgba(rc, 0.6), lw=0.7, zorder=2))
        for c in run["cells"]:
            ax.add_patch(Rectangle((x - d / 2, c["y"] - pitch * 0.4), d, pitch * 0.8,
                                   facecolor=ABC_COLOR.get(c["abc"], "#ccc"),
                                   edgecolor="none", alpha=0.92, zorder=3))
    if model.resources.stations:
        st = model.resources.stations[0]
        ax.plot(st.x, st.y, "*", ms=15, color=ACCENT, zorder=6,
                markeredgecolor="white", markeredgewidth=0.6)
        ax.text(st.x, st.y - 1.6, "梱包", ha="center", fontsize=7.5, color=ACCENT, zorder=6)

    try:
        hb = blur(heat, sigma=1.2)
    except Exception:
        hb = None
    if hb is not None and getattr(hb, "size", 0) and float(hb.max()) > 0:
        im = ax.imshow(hb, extent=(0, fw, 0, fd), origin="lower", cmap=CONGEST,
                       alpha=0.5, zorder=4, aspect="auto")
        cbar = fig.colorbar(im, ax=ax, fraction=0.028, pad=0.012)
        cbar.set_label("混雑度（通過回数）", fontsize=8, color=INK_DIM)
        cbar.ax.tick_params(labelsize=7, color=LINE, labelcolor=INK_FAINT)
        cbar.outline.set_edgecolor(LINE)

    abc_handles = [
        Line2D([0], [0], marker="s", color="none", markerfacecolor=ABC_COLOR["A"],
               markersize=7, label="Aランク（高頻度）"),
        Line2D([0], [0], marker="s", color="none", markerfacecolor=ABC_COLOR["B"],
               markersize=7, label="Bランク"),
        Line2D([0], [0], marker="s", color="none", markerfacecolor=ABC_COLOR["C"],
               markersize=7, label="Cランク（低頻度）"),
    ]
    leg = ax.legend(handles=abc_handles, loc="upper right", fontsize=7,
                    framealpha=0.92, borderpad=0.6, handletextpad=0.3,
                    title="保管区分", title_fontsize=7, edgecolor=LINE)
    leg.get_frame().set_facecolor("#fbfcfe")
    ax.add_artist(leg)  # keep the ABC legend when adding the equipment legend

    # Storage-equipment legend (which rack types are present).
    if present_types:
        rt_handles = [
            Line2D([0], [0], marker="s", color="none",
                   markerfacecolor=to_rgba(racktypes.color(t), 0.6),
                   markeredgecolor=to_rgba(racktypes.color(t), 0.9),
                   markersize=8, label=racktypes.get(t)["label"])
            for t in present_types
        ]
        leg2 = ax.legend(handles=rt_handles, loc="lower right", fontsize=7,
                         framealpha=0.92, borderpad=0.6, handletextpad=0.3,
                         title="保管設備", title_fontsize=7, edgecolor=LINE)
        leg2.get_frame().set_facecolor("#fbfcfe")

    ax.set_xlim(-1, fw + 1)
    ax.set_ylim(-1, fd + 1)
    ax.set_aspect("equal")
    ax.set_title("レイアウト ＆ 混雑ヒートマップ", fontsize=11, loc="left",
                 weight="bold", color=INK, pad=8)
    # Clean "plan" frame: drop the science-plot axes/labels, keep a hairline box.
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_edgecolor(LINE)
    ax.text(0.0, -0.035, f"床面積 {fw:.0f} × {fd:.0f} m", transform=ax.transAxes,
            fontsize=7.5, color=INK_FAINT, va="top")

    # --- verdict + KPI cards -------------------------------------------------
    can = kpis.get("can_handle_demand", False)
    v_bg, v_ink = (OK_BG, OK_INK) if can else (WARN_BG, WARN_INK)
    panel.text(0.0, 0.985, "この倉庫で需要をさばけるか？", fontsize=10.5,
               weight="bold", color=INK, va="top")
    panel.add_patch(FancyBboxPatch(
        (0.0, 0.84), 1.0, 0.10, boxstyle="round,pad=0.006,rounding_size=0.03",
        linewidth=0, facecolor=v_bg, transform=panel.transAxes, clip_on=False, zorder=1))
    panel.add_patch(Rectangle((0.0, 0.84), 0.012, 0.10, facecolor=v_ink,
                              transform=panel.transAxes, clip_on=False, zorder=2))
    panel.text(0.045, 0.89, kpis.get("verdict", ""), fontsize=10.5, color=v_ink,
               weight="bold", va="center", zorder=3, wrap=True)

    rows = [
        ("スループット", f"{_safe(kpis.get('throughput_per_hr')):.0f} 件/時", None),
        ("出荷完了", f"{_safe(kpis.get('orders_completed')):.0f} / "
                     f"{_safe(kpis.get('orders_arrived')):.0f} 件", None),
        ("ボトルネック", f"{kpis.get('bottleneck_jp','—')} "
                         f"{_safe(kpis.get('bottleneck_utilization'))*100:.0f}%",
         "warn" if _safe(kpis.get("bottleneck_utilization")) >= 0.85 else None),
        ("ピッカー稼働率", f"{_safe(kpis.get('n_pickers')):.0f}名 "
                           f"{_safe(kpis.get('picker_utilization'))*100:.0f}%", None),
        ("梱包台稼働率", f"{_safe(kpis.get('n_packers')):.0f}台 "
                         f"{_safe(kpis.get('packer_utilization'))*100:.0f}%", None),
        ("1件あたり歩行", f"{_safe(kpis.get('walk_per_order_m')):.0f} m", None),
    ]
    cur = kpis.get("currency", "¥")
    if _safe(kpis.get("replications"), 1) > 1:
        rows.append(("安定度（{}回検証）".format(int(_safe(kpis.get("replications"), 1))),
                     f"{_safe(kpis.get('robustness'))*100:.0f}%", "ok"))
    if kpis.get("total_cost_per_order"):
        rows.append(("1件あたりコスト", f"{cur}{_safe(kpis.get('total_cost_per_order')):,.1f}", None))
    if kpis.get("monthly_cost"):
        rows.append(("月間コスト", f"{cur}{_safe(kpis.get('monthly_cost')):,.0f}", None))

    rows = rows[:8]  # keep the sheet uncluttered
    y_top, y_bot = 0.80, 0.13
    n = len(rows)
    gap = 0.012
    h = min(0.082, (y_top - y_bot - gap * (n - 1)) / max(n, 1))
    for i, (label, val, tone) in enumerate(rows):
        y = y_top - h - i * (h + gap)
        _card(panel, 0.0, y, 1.0, h, label, val, tone)

    foot = "概算見積り ／ " + str(provenance_summary or "")
    if kpis.get("total_cost_per_order"):
        foot += (f"\n前提: 人件費 {cur}{_safe(kpis.get('labour_rate_per_hr')):,.0f}/人時"
                 f"・AGV投資 {cur}{_safe(kpis.get('capex_total')):,.0f}（36ヶ月償却）")
    panel.text(0.0, 0.045, foot, fontsize=6.8, color=INK_FAINT, va="bottom", wrap=True)

    fig.savefig(out_path, dpi=200, facecolor=PAPER)
    plt.close(fig)
    return out_path
