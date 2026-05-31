"""Client-ready proposal export: editable PowerPoint (.pptx) and PDF.

Turns a finished simulation (KPIs + the proposal PNG) into a Japanese 3PL sales
提案書 deliverable. Two independent builders, `build_pptx` and `build_pdf`,
take the same inputs and emit an editable deck / a one-page A4 PDF respectively.

Design goals: defensive against missing KPIs ("—" placeholder), graceful when the
PNG is absent, and correct Japanese rendering (CJK font registration for reportlab,
CJK-friendly font family on pptx runs). User-facing strings are Japanese; code and
comments are English.
"""

from __future__ import annotations

import datetime as _dt
from pathlib import Path

# --- Shared formatting helpers -------------------------------------------------

DASH = "—"  # placeholder for missing values

# Restrained palette: indigo accent + neutral text.
INDIGO = (0x3F, 0x3D, 0x9B)
GREEN = (0x1B, 0x7F, 0x4B)
RED = (0xB0, 0x2A, 0x2A)
NEUTRAL = (0x33, 0x33, 0x33)
LIGHT = (0xEE, 0xEE, 0xF4)

# CJK-friendly font family for pptx runs (uses the viewer's installed fonts).
PPTX_FONT = "Noto Sans CJK JP"


def _currency_symbol(kpis: dict) -> str:
    return str(kpis.get("currency") or "¥")


def _fmt_num(val, digits: int = 0) -> str:
    """Format a number with thousands separators; return DASH if missing."""
    if val is None:
        return DASH
    try:
        f = float(val)
    except (TypeError, ValueError):
        return DASH
    if digits <= 0:
        return f"{f:,.0f}"
    return f"{f:,.{digits}f}"


def _fmt_money(val, kpis: dict, digits: int = 0) -> str:
    if val is None:
        return DASH
    s = _fmt_num(val, digits)
    if s == DASH:
        return DASH
    return f"{_currency_symbol(kpis)}{s}"


def _fmt_pct(val) -> str:
    """Format a fraction-or-percent value as a percentage string."""
    if val is None:
        return DASH
    try:
        f = float(val)
    except (TypeError, ValueError):
        return DASH
    # Heuristic: values <= 1.5 are treated as fractions, else already percent.
    if f <= 1.5:
        f *= 100.0
    return f"{f:,.1f}%"


def _kpi_rows(kpis: dict) -> list[tuple[str, str]]:
    """Build the ordered (Japanese label, formatted value) KPI table rows."""
    return [
        ("スループット (件/時)", _fmt_num(kpis.get("throughput_per_hr"), 1)),
        ("出荷完了率 (%)", _fmt_pct(kpis.get("completion_rate"))),
        ("ボトルネック", str(kpis.get("bottleneck_jp") or DASH)),
        ("必要人員 (名)", _fmt_num(kpis.get("headcount"))),
        ("1件あたりコスト", _fmt_money(kpis.get("total_cost_per_order"), kpis, 1)),
        ("月間コスト", _fmt_money(kpis.get("monthly_cost"), kpis)),
        ("投資回収 (月)", _fmt_num(kpis.get("payback_months"), 1)),
    ]


def _verdict_text(kpis: dict) -> str:
    v = kpis.get("verdict")
    if v:
        return str(v)
    return "判定結果なし"


def _is_ok(kpis: dict) -> bool:
    return bool(kpis.get("can_handle_demand"))


def _assumptions_lines(kpis: dict, provenance_summary: str) -> list[str]:
    rate = _fmt_money(kpis.get("labour_rate_per_hr"), kpis)
    capex = _fmt_money(kpis.get("capex_total"), kpis)
    lines = []
    if provenance_summary:
        lines.append(str(provenance_summary))
    lines.append(
        f"前提条件: 人件費 {rate}/人時 ・ AGV投資 {capex} ・ 36ヶ月償却"
    )
    return lines


def _date_str() -> str:
    return _dt.date.today().strftime("%Y年%m月%d日")


def _png_exists(png_path) -> Path | None:
    if not png_path:
        return None
    p = Path(png_path)
    return p if p.is_file() else None


# --- PowerPoint builder --------------------------------------------------------

def build_pptx(kpis: dict, model_name: str, provenance_summary: str,
               png_path, out_path) -> Path:
    """Build an editable 3-slide proposal deck and write it to `out_path`."""
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.enum.text import PP_ALIGN
    from pptx.util import Inches, Pt

    out_path = Path(out_path)
    kpis = kpis or {}
    png = _png_exists(png_path)

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    SW = prs.slide_width
    blank = prs.slide_layouts[6]

    def _set_run(run, *, size, bold=False, color=NEUTRAL):
        run.font.name = PPTX_FONT
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = RGBColor(*color)
        # Ensure east-asian font is also set so CJK glyphs use the family.
        rPr = run._r.get_or_add_rPr()
        from pptx.oxml.ns import qn
        ea = rPr.find(qn("a:ea"))
        if ea is None:
            ea = rPr.makeelement(qn("a:ea"), {})
            rPr.append(ea)
        ea.set("typeface", PPTX_FONT)

    def _textbox(slide, left, top, width, height):
        tb = slide.shapes.add_textbox(left, top, width, height)
        tf = tb.text_frame
        tf.word_wrap = True
        return tf

    # --- Slide 1: Title -------------------------------------------------------
    s1 = prs.slides.add_slide(blank)
    # Indigo accent bar at top.
    bar = s1.shapes.add_shape(1, 0, 0, SW, Inches(0.4))
    bar.fill.solid()
    bar.fill.fore_color.rgb = RGBColor(*INDIGO)
    bar.line.fill.background()

    tf = _textbox(s1, Inches(1.0), Inches(2.4), Inches(11.3), Inches(2.0))
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.LEFT
    tr = p.add_run()
    tr.text = f"{model_name} 倉庫運用 提案書"
    _set_run(tr, size=44, bold=True, color=INDIGO)

    sub = _textbox(s1, Inches(1.0), Inches(4.3), Inches(11.3), Inches(1.2))
    sp = sub.paragraphs[0]
    r = sp.add_run()
    r.text = f"{_date_str()} ・ 概算見積り"
    _set_run(r, size=20, color=NEUTRAL)

    # --- Slide 2: Verdict + KPI table + PNG ----------------------------------
    s2 = prs.slides.add_slide(blank)
    ok = _is_ok(kpis)
    vcolor = GREEN if ok else RED

    vtf = _textbox(s2, Inches(0.5), Inches(0.3), Inches(12.3), Inches(1.1))
    vp = vtf.paragraphs[0]
    vr = vp.add_run()
    vr.text = _verdict_text(kpis)
    _set_run(vr, size=32, bold=True, color=vcolor)

    # KPI table on the left.
    rows = _kpi_rows(kpis)
    n = len(rows) + 1
    table_w = Inches(6.4)
    tbl_shape = s2.shapes.add_table(
        n, 2, Inches(0.5), Inches(1.6), table_w, Inches(5.2)
    )
    table = tbl_shape.table
    table.columns[0].width = Inches(3.6)
    table.columns[1].width = Inches(2.8)

    def _cell(r_i, c_i, text, *, size=14, bold=False, color=NEUTRAL):
        cell = table.cell(r_i, c_i)
        cell.text = ""
        para = cell.text_frame.paragraphs[0]
        run = para.add_run()
        run.text = text
        _set_run(run, size=size, bold=bold, color=color)

    _cell(0, 0, "項目", size=14, bold=True, color=(0xFF, 0xFF, 0xFF))
    _cell(0, 1, "値", size=14, bold=True, color=(0xFF, 0xFF, 0xFF))
    for i, (label, value) in enumerate(rows, start=1):
        _cell(i, 0, label, size=13, bold=True)
        _cell(i, 1, value, size=13)

    # Embed the PNG on the right (scaled to fit), if available.
    if png is not None:
        try:
            from PIL import Image
            with Image.open(png) as im:
                iw, ih = im.size
            ar = ih / iw if iw else 0.7
        except Exception:
            ar = 0.7
        pic_left = Inches(7.2)
        pic_w = Inches(5.6)
        pic_h = Inches(min(5.2, 5.6 * ar))
        s2.shapes.add_picture(str(png), pic_left, Inches(1.6),
                              width=pic_w, height=pic_h)
    else:
        ntf = _textbox(s2, Inches(7.2), Inches(2.8), Inches(5.6), Inches(1.0))
        nr = ntf.paragraphs[0].add_run()
        nr.text = "（レイアウト図は省略されました）"
        _set_run(nr, size=14, color=NEUTRAL)

    # --- Slide 3: Assumptions / provenance -----------------------------------
    s3 = prs.slides.add_slide(blank)
    htf = _textbox(s3, Inches(0.6), Inches(0.4), Inches(12.0), Inches(0.9))
    hr = htf.paragraphs[0].add_run()
    hr.text = "前提条件とデータ出所"
    _set_run(hr, size=28, bold=True, color=INDIGO)

    atf = _textbox(s3, Inches(0.6), Inches(1.6), Inches(12.0), Inches(5.0))
    first = True
    for line in _assumptions_lines(kpis, provenance_summary):
        para = atf.paragraphs[0] if first else atf.add_paragraph()
        first = False
        run = para.add_run()
        run.text = f"・ {line}"
        _set_run(run, size=16, color=NEUTRAL)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(out_path))
    return out_path


# --- PDF builder ---------------------------------------------------------------

_CJK_FONT_NAME = "WhsimCJK"
_CJK_REGISTERED = False


def _register_cjk_font() -> str:
    """Register a CJK font for reportlab; return the usable font name.

    Tries the Noto Sans CJK TTC first (subfontIndex 0), then falls back to a
    built-in CID font so Japanese never renders as tofu.
    """
    global _CJK_REGISTERED
    from reportlab.pdfbase import pdfmetrics

    if _CJK_REGISTERED:
        return _CJK_FONT_NAME

    ttc = Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")
    if ttc.is_file():
        try:
            from reportlab.pdfbase.ttfonts import TTFont
            pdfmetrics.registerFont(
                TTFont(_CJK_FONT_NAME, str(ttc), subfontIndex=0)
            )
            _CJK_REGISTERED = True
            return _CJK_FONT_NAME
        except Exception:
            pass

    # Fallback: built-in CID font (always available with reportlab).
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
    return "HeiseiKakuGo-W5"


def build_pdf(kpis: dict, model_name: str, provenance_summary: str,
              png_path, out_path) -> Path:
    """Build a one-page A4 proposal PDF and write it to `out_path`."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        Image as RLImage,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )
    from reportlab.lib.styles import ParagraphStyle

    out_path = Path(out_path)
    kpis = kpis or {}
    png = _png_exists(png_path)
    font = _register_cjk_font()

    def _rgb(t):
        return colors.Color(t[0] / 255, t[1] / 255, t[2] / 255)

    title_style = ParagraphStyle(
        "title", fontName=font, fontSize=22, leading=28,
        textColor=_rgb(INDIGO),
    )
    sub_style = ParagraphStyle(
        "sub", fontName=font, fontSize=11, leading=16, textColor=_rgb(NEUTRAL),
    )
    verdict_ok = _is_ok(kpis)
    verdict_style = ParagraphStyle(
        "verdict", fontName=font, fontSize=16, leading=22,
        textColor=_rgb(GREEN if verdict_ok else RED),
    )
    body_style = ParagraphStyle(
        "body", fontName=font, fontSize=9, leading=13, textColor=_rgb(NEUTRAL),
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(out_path), pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=16 * mm, bottomMargin=14 * mm,
        title=f"{model_name} 倉庫運用 提案書",
    )
    avail_w = A4[0] - 36 * mm
    story = []

    story.append(Paragraph(f"{model_name} 倉庫運用 提案書", title_style))
    story.append(Paragraph(f"{_date_str()} ・ 概算見積り", sub_style))
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph(_verdict_text(kpis), verdict_style))
    story.append(Spacer(1, 5 * mm))

    # KPI table.
    data = [["項目", "値"]] + [list(r) for r in _kpi_rows(kpis)]
    col_w = [avail_w * 0.55, avail_w * 0.45]
    table = Table(data, colWidths=col_w)
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), font),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("BACKGROUND", (0, 0), (-1, 0), _rgb(INDIGO)),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("TEXTCOLOR", (0, 1), (-1, -1), _rgb(NEUTRAL)),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _rgb(LIGHT)]),
        ("GRID", (0, 0), (-1, -1), 0.5, _rgb((0xCC, 0xCC, 0xD6))),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(table)
    story.append(Spacer(1, 6 * mm))

    # Embedded PNG scaled to fit width, if present.
    if png is not None:
        try:
            from PIL import Image as PILImage
            with PILImage.open(png) as im:
                iw, ih = im.size
            max_w = avail_w
            max_h = 95 * mm
            scale = min(max_w / iw, max_h / ih)
            story.append(RLImage(str(png), width=iw * scale, height=ih * scale))
            story.append(Spacer(1, 5 * mm))
        except Exception:
            pass

    # Assumptions footer.
    for line in _assumptions_lines(kpis, provenance_summary):
        story.append(Paragraph(f"・ {line}", body_style))

    doc.build(story)
    return out_path


# --- Self-test -----------------------------------------------------------------

if __name__ == "__main__":
    import tempfile

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

    pptx_out = build_pptx(sample_kpis, model_name, provenance, png_p, tmp / "proposal.pptx")
    pdf_out = build_pdf(sample_kpis, model_name, provenance, png_p, tmp / "proposal.pdf")

    for p in (pptx_out, pdf_out):
        print(f"{p}  ({p.stat().st_size:,} bytes)")
