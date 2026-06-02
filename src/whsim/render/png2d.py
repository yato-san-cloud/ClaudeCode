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

from whsim.render.fonts import setup_jp_font  # noqa: E402
from whsim.render.heatmap import blur  # noqa: E402
from whsim.schema.model import WarehouseModel  # noqa: E402

ABC_COLOR = {"A": "#d7301f", "B": "#fc8d59", "C": "#fdcc8a"}
ZONE_JP = {"receiving": "入荷", "storage": "保管", "picking": "ピッキング",
           "packing": "梱包", "shipping": "出荷", "staging": "一時保管"}

setup_jp_font()


def _safe(val, default=0.0) -> float:
    """Read a numeric KPI defensively; never raise on None / non-numeric."""
    try:
        if val is None:
            return default
        return float(val)
    except (TypeError, ValueError):
        return default


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
    fig = plt.figure(figsize=(13, 6.5))
    gs = fig.add_gridspec(1, 2, width_ratios=[2.4, 1.0], wspace=0.18)
    ax = fig.add_subplot(gs[0, 0])
    panel = fig.add_subplot(gs[0, 1])
    panel.axis("off")

    # floor
    ax.add_patch(Rectangle((0, 0), fw, fd,
                           fill=False, edgecolor="#333", lw=1.5))
    # zones
    for z in model.layout.zones:
        ax.add_patch(Rectangle((z.x, z.y), z.w, z.h, facecolor=z.color or "#eee",
                               alpha=0.35, edgecolor="#bbb", lw=0.8))
        ax.text(z.x + z.w / 2, z.y + z.h / 2, ZONE_JP.get(z.type, z.type),
                ha="center", va="center",
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
    try:
        hb = blur(heat, sigma=1.2)
    except Exception:
        hb = None
    if hb is not None and getattr(hb, "size", 0) and float(hb.max()) > 0:
        im = ax.imshow(hb, extent=(0, fw, 0, fd),
                       origin="lower", cmap="hot", alpha=0.45, zorder=4,
                       aspect="auto")
        cbar = fig.colorbar(im, ax=ax, fraction=0.035, pad=0.01)
        cbar.set_label("混雑度（通過回数）", fontsize=8)

    # ABC-class legend so the dot colours read as a slotting policy, not noise.
    from matplotlib.lines import Line2D
    abc_handles = [
        Line2D([0], [0], marker="s", color="none", markerfacecolor=ABC_COLOR["A"],
               markersize=7, label="Aランク（高頻度）"),
        Line2D([0], [0], marker="s", color="none", markerfacecolor=ABC_COLOR["B"],
               markersize=7, label="Bランク"),
        Line2D([0], [0], marker="s", color="none", markerfacecolor=ABC_COLOR["C"],
               markersize=7, label="Cランク（低頻度）"),
    ]
    ax.legend(handles=abc_handles, loc="upper right", fontsize=7,
              framealpha=0.85, borderpad=0.6, handletextpad=0.3,
              title="保管区分", title_fontsize=7)

    ax.set_xlim(-1, fw + 1)
    ax.set_ylim(-1, fd + 1)
    ax.set_aspect("equal")
    ax.set_title(model.meta.name or "倉庫レイアウト", fontsize=12, loc="left",
                 weight="bold")
    ax.set_xlabel("m")
    ax.set_ylabel("m")

    # --- verdict + KPI panel --------------------------------------------------
    can = kpis.get("can_handle_demand", False)
    headline_color = "#1a7a3c" if can else "#b30000"
    panel.text(0.0, 1.0, "この倉庫で需要をさばけるか？",
               fontsize=12, weight="bold", va="top")
    panel.text(0.0, 0.93, kpis.get("verdict", ""), fontsize=11,
               color=headline_color, weight="bold", va="top", wrap=True)

    rows = [
        ("スループット", f"{_safe(kpis.get('throughput_per_hr')):.0f} 件/時"),
        ("出荷完了", f"{_safe(kpis.get('orders_completed')):.0f} / "
                     f"{_safe(kpis.get('orders_arrived')):.0f} 件"),
        ("ボトルネック", f"{kpis.get('bottleneck_jp','—')}"
                         f"（稼働率 {_safe(kpis.get('bottleneck_utilization'))*100:.0f}%）"),
        ("ピッカー", f"{_safe(kpis.get('n_pickers')):.0f} 名"
                     f"（稼働率 {_safe(kpis.get('picker_utilization'))*100:.0f}%）"),
        ("梱包台", f"{_safe(kpis.get('n_packers')):.0f} 台"
                   f"（稼働率 {_safe(kpis.get('packer_utilization'))*100:.0f}%）"),
        ("処理時間 中央値/最悪",
         f"{_safe(kpis.get('cycle_p50_s'))/60:.0f} / "
         f"{_safe(kpis.get('cycle_p95_s'))/60:.0f} 分"),
        ("1件あたり歩行", f"{_safe(kpis.get('walk_per_order_m')):.0f} m"),
    ]
    cur = kpis.get("currency", "¥")
    if _safe(kpis.get("replications"), 1) > 1:
        rows.append(("安定度（{}回検証）".format(int(_safe(kpis.get("replications"), 1))),
                     f"{_safe(kpis.get('robustness'))*100:.0f}%"))
    if kpis.get("total_cost_per_order"):
        rows.append(("1件あたりコスト", f"{cur}{_safe(kpis.get('total_cost_per_order')):,.1f}"))
    if kpis.get("monthly_cost"):
        rows.append(("月間コスト", f"{cur}{_safe(kpis.get('monthly_cost')):,.0f}"))
    y = 0.82
    for label, val in rows:
        panel.text(0.0, y, label, fontsize=9, color="#555", va="top")
        panel.text(1.0, y, val, fontsize=9, weight="bold", ha="right", va="top")
        y -= 0.075

    # honesty footer: provenance + the cost assumptions behind the ¥ figures
    foot = "概算見積り ／ " + str(provenance_summary or "")
    if kpis.get("total_cost_per_order"):
        foot += (f"\n前提: 人件費 {cur}{_safe(kpis.get('labour_rate_per_hr')):,.0f}/人時"
                 f"・AGV投資 {cur}{_safe(kpis.get('capex_total')):,.0f}（36ヶ月償却）")
    panel.text(0.0, 0.04, foot, fontsize=7.0, color="#777", va="bottom", wrap=True)

    # Higher DPI than before so embedded slide/PDF copies stay crisp.
    fig.savefig(out_path, dpi=200, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return out_path
