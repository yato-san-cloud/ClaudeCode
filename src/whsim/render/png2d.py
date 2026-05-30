"""Render a one-glance, proposal-grade 2D PNG: layout + congestion + verdict.

Designed to be pasted straight into a sales slide. One dominant headline (can the
warehouse handle the demand?), the named bottleneck, a few money/labour figures,
the schematic layout with a congestion overlay, and an honest provenance footer.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402

from whsim.render.heatmap import blur
from whsim.schema.model import WarehouseModel  # noqa: E402

ABC_COLOR = {"A": "#d7301f", "B": "#fc8d59", "C": "#fdcc8a"}


def render(
    model: WarehouseModel,
    heat: np.ndarray,
    kpis: dict,
    provenance_summary: str,
    out_path: str | Path,
) -> Path:
    out_path = Path(out_path)
    bounds = model.layout.bounds
    fig = plt.figure(figsize=(13, 6.5))
    gs = fig.add_gridspec(1, 2, width_ratios=[2.4, 1.0], wspace=0.18)
    ax = fig.add_subplot(gs[0, 0])
    panel = fig.add_subplot(gs[0, 1])
    panel.axis("off")

    # floor
    ax.add_patch(Rectangle((0, 0), bounds.width, bounds.depth,
                           fill=False, edgecolor="#333", lw=1.5))
    # zones
    for z in model.layout.zones:
        ax.add_patch(Rectangle((z.x, z.y), z.w, z.h, facecolor=z.color or "#eee",
                               alpha=0.35, edgecolor="#bbb", lw=0.8))
        ax.text(z.x + z.w / 2, z.y + z.h / 2, z.type, ha="center", va="center",
                fontsize=8, color="#555")
    # locations by ABC class
    by_sku = model.item_by_sku()
    for loc in model.locations:
        cls = by_sku[loc.sku].abc_class if loc.sku in by_sku else "C"
        ax.plot(loc.x, loc.y, "s", ms=3.0, color=ABC_COLOR.get(cls, "#ccc"))
    # pack station
    if model.resources.stations:
        st = model.resources.stations[0]
        ax.plot(st.x, st.y, "*", ms=16, color="#08519c", zorder=5)
        ax.text(st.x, st.y - 1.5, "pack", ha="center", fontsize=8, color="#08519c")

    # congestion overlay
    hb = blur(heat, sigma=1.2)
    if hb.max() > 0:
        im = ax.imshow(hb, extent=(0, bounds.width, 0, bounds.depth),
                       origin="lower", cmap="hot", alpha=0.45, zorder=4,
                       aspect="auto")
        cbar = fig.colorbar(im, ax=ax, fraction=0.035, pad=0.01)
        cbar.set_label("congestion (visits)", fontsize=8)

    ax.set_xlim(-1, bounds.width + 1)
    ax.set_ylim(-1, bounds.depth + 1)
    ax.set_aspect("equal")
    ax.set_title(model.meta.name, fontsize=11, loc="left")
    ax.set_xlabel("m")
    ax.set_ylabel("m")

    # --- verdict + KPI panel --------------------------------------------------
    can = kpis.get("can_handle_demand", False)
    headline_color = "#1a7a3c" if can else "#b30000"
    panel.text(0.0, 1.0, "Can this warehouse handle the demand?",
               fontsize=11, weight="bold", va="top")
    panel.text(0.0, 0.93, kpis.get("verdict", ""), fontsize=11,
               color=headline_color, weight="bold", va="top", wrap=True)

    rows = [
        ("Throughput", f"{kpis['throughput_per_hr']:.0f} orders/hr"),
        ("Orders completed", f"{kpis['orders_completed']:.0f} / {kpis['orders_arrived']:.0f}"),
        ("Bottleneck", f"{kpis['bottleneck']} ({kpis['bottleneck_utilization']*100:.0f}% busy)"),
        ("Pickers", f"{kpis['n_pickers']:.0f}  ({kpis['picker_utilization']*100:.0f}% util)"),
        ("Pack stations", f"{kpis['n_packers']:.0f}  ({kpis['packer_utilization']*100:.0f}% util)"),
        ("Order cycle p50/p95", f"{kpis['cycle_p50_s']/60:.0f} / {kpis['cycle_p95_s']/60:.0f} min"),
        ("Avg pick wait", f"{kpis['pick_wait_mean_s']/60:.1f} min"),
        ("Walking / order", f"{kpis['walk_per_order_m']:.0f} m"),
    ]
    y = 0.82
    for label, val in rows:
        panel.text(0.0, y, label, fontsize=9, color="#555", va="top")
        panel.text(1.0, y, val, fontsize=9, weight="bold", ha="right", va="top")
        y -= 0.075

    # honesty footer: turns "we assumed values" into a sales follow-up hook
    panel.text(0.0, 0.04, "Directional estimate — " + provenance_summary,
               fontsize=7.5, color="#777", va="bottom", wrap=True)

    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    return out_path
