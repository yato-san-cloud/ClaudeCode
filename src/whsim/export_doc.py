"""Client-ready proposal export: editable PowerPoint (.pptx) and PDF.

Thin facade preserved for backwards compatibility. The implementation moved into
the :mod:`whsim.export` package:

  * :mod:`whsim.export._data`  -- shared, render-agnostic data/row/tile builders
  * :mod:`whsim.export.fonts`  -- CJK font registration (reportlab)
  * :mod:`whsim.export.pptx`   -- editable deck builder (python-pptx)
  * :mod:`whsim.export.pdf`    -- one-page A4 PDF builder (reportlab)

Every previously public name (``build_pptx``, ``build_pdf`` and the module-level
helpers/constants) is re-exported here, so ``from whsim import export_doc`` and
``export_doc.<name>`` keep working unchanged. User-facing strings are Japanese;
code and comments are English.
"""

from __future__ import annotations

from whsim.export._data import (  # noqa: F401
    AMBER,
    DASH,
    GREEN,
    INDIGO,
    INK,
    LIGHT,
    NEUTRAL,
    NOTION_BLUE,
    PPTX_FONT,
    PRODUCT_NAME,
    RED,
    SUBTLE,
    WHITE,
    _SEV_COLOR,
    _assumptions_lines,
    _currency_symbol,
    _date_str,
    _delta_str,
    _detail_rows,
    _fmt_minutes,
    _fmt_money,
    _fmt_num,
    _fmt_pct,
    _headline_tiles,
    _is_ok,
    _methodology_footer,
    _normalize_insights,
    _normalize_scenarios,
    _png_exists,
    _strip_html,
    _verdict_text,
)
from whsim.export.fonts import (  # noqa: F401
    _CJK_FONT_NAME,
    _register_cjk_font,
)
from whsim.export.pdf import build_pdf  # noqa: F401
from whsim.export.pptx import build_pptx  # noqa: F401

__all__ = ["build_pptx", "build_pdf", "_register_cjk_font"]


# --- Self-test -----------------------------------------------------------------

if __name__ == "__main__":
    import tempfile
    from pathlib import Path

    sample_kpis = {
        "verdict": "現行体制で需要を充足できます（余力あり）。",
        "can_handle_demand": True,
        "throughput_per_hr": 182.5,
        "orders_completed": 1460,
        "orders_arrived": 1500,
        "completion_rate": 0.973,
        "bottleneck_jp": "梱包工程",
        "bottleneck_utilization": 0.82,
        "picker_utilization": 0.74,
        "packer_utilization": 0.82,
        "agv_utilization": 0.55,
        "n_pickers": 6,
        "n_packers": 4,
        "n_agvs": 3,
        "cycle_p50_s": 540.0,
        "cycle_p95_s": 1120.0,
        "walk_per_order_m": 88.0,
        "headcount": 10,
        "total_cost_per_order": 312.4,
        "monthly_cost": 4_680_000,
        "payback_months": 14.2,
        "labour_rate_per_hr": 1_800,
        "capex_total": 24_000_000,
        "currency": "¥",
    }
    model_name = "サンプル物流センター"
    provenance = "本提案の 62% はお客様提供データに基づいています（残りは業界標準値）。"

    tmp = Path(tempfile.mkdtemp(prefix="whsim_export_"))

    # Make a small placeholder PNG with matplotlib (Agg, headless).
    png_p = tmp / "layout.png"
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(figsize=(4, 3), dpi=100)
        ax.add_patch(plt.Rectangle((0.1, 0.1), 0.8, 0.6, color="#3F3D9B", alpha=0.3))
        ax.set_title("layout sample")
        ax.axis("off")
        fig.savefig(png_p)
        plt.close(fig)
    except Exception:
        # PIL fallback.
        from PIL import Image
        Image.new("RGB", (400, 300), (220, 220, 240)).save(png_p)

    sample_scenarios = {
        "baseline": {"name": "現行", "description": "現行オペレーション",
                     "kpis": sample_kpis},
        "alternatives": [{
            "name": "AGV導入", "description": "ピッキングをAGV化",
            "kpis": {**sample_kpis, "throughput_per_hr": 240.0,
                     "headcount": 6, "total_cost_per_order": 268.0,
                     "monthly_cost": 3_900_000, "payback_months": 11.5},
        }],
    }
    sample_insights = [
        {"severity": "danger", "title": "梱包工程がボトルネック",
         "fact": "稼働率 <span class=\"num\">82</span>%。",
         "action": "梱包台を1台増設で改善を検討。"},
        {"severity": "warn", "title": "AGV稼働率に余地",
         "fact": "55%。", "action": "搬送ルートの見直しを検討。"},
    ]

    pptx_out = build_pptx(sample_kpis, model_name, provenance, png_p,
                          tmp / "proposal.pptx", scenarios=sample_scenarios,
                          insights=sample_insights)
    pdf_out = build_pdf(sample_kpis, model_name, provenance, png_p,
                        tmp / "proposal.pdf", scenarios=sample_scenarios,
                        insights=sample_insights)

    for p in (pptx_out, pdf_out):
        print(f"{p}  ({p.stat().st_size:,} bytes)")
