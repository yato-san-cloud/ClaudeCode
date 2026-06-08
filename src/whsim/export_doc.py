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
import re as _re
from pathlib import Path

# --- Shared formatting helpers -------------------------------------------------

DASH = "—"  # placeholder for missing values

# Brand palette: matches the web app (Notion-blue accent, warm-ink text).
NOTION_BLUE = (0x23, 0x83, 0xE2)  # #2383E2 primary accent
INK = (0x37, 0x35, 0x2F)          # #37352F warm ink for body text
# Kept for backwards compatibility with anything importing these names.
INDIGO = NOTION_BLUE
NEUTRAL = INK
GREEN = (0x1B, 0x7F, 0x4B)
RED = (0xB0, 0x2A, 0x2A)
AMBER = (0xB5, 0x6A, 0x00)
LIGHT = (0xEE, 0xF3, 0xFB)        # pale blue tile / zebra row
SUBTLE = (0x78, 0x72, 0x6B)       # muted footnote ink
WHITE = (0xFF, 0xFF, 0xFF)

# CJK-friendly font family for pptx runs (uses the viewer's installed fonts).
PPTX_FONT = "Noto Sans CJK JP"

PRODUCT_NAME = "whsim 倉庫シミュレーター"


def _strip_html(s) -> str:
    """Insight `fact` strings may carry HTML spans (web UI). Flatten to text."""
    if s is None:
        return ""
    return _re.sub(r"<[^>]+>", "", str(s)).strip()


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


def _headline_tiles(kpis: dict) -> list[tuple[str, str, str]]:
    """The four hero KPIs for the executive summary, as (label, value, unit)."""
    comp = kpis.get("completion_rate")
    arrived = kpis.get("orders_arrived")
    completed = kpis.get("orders_completed")
    if completed is not None and arrived:
        ship = f"{_fmt_num(completed)} / {_fmt_num(arrived)}"
    else:
        ship = _fmt_pct(comp)
    return [
        ("処理能力", _fmt_num(kpis.get("throughput_per_hr"), 1), "件/時"),
        ("出荷完了", ship, "件" if (completed is not None and arrived) else ""),
        ("ボトルネック", str(kpis.get("bottleneck_jp") or DASH), ""),
        ("1件あたりコスト", _fmt_money(kpis.get("total_cost_per_order"), kpis, 1), ""),
    ]


def _fmt_minutes(seconds) -> str:
    if seconds is None:
        return DASH
    try:
        return f"{float(seconds) / 60.0:,.1f}"
    except (TypeError, ValueError):
        return DASH


def _detail_rows(kpis: dict) -> list[tuple[str, str]]:
    """The full KPI detail table (Japanese labels, '—' for anything missing)."""
    p5, p95 = kpis.get("throughput_p5"), kpis.get("throughput_p95")
    if p5 is not None or p95 is not None:
        thr_range = f"{_fmt_num(p5, 1)} 〜 {_fmt_num(p95, 1)} 件/時"
    else:
        thr_range = DASH
    cycle = f"{_fmt_minutes(kpis.get('cycle_p50_s'))} / {_fmt_minutes(kpis.get('cycle_p95_s'))} 分"
    return [
        ("スループット (件/時)", _fmt_num(kpis.get("throughput_per_hr"), 1)),
        ("スループット p5〜p95", thr_range),
        ("出荷完了率", _fmt_pct(kpis.get("completion_rate"))),
        ("ピッカー稼働率", _fmt_pct(kpis.get("picker_utilization"))),
        ("梱包稼働率", _fmt_pct(kpis.get("packer_utilization"))),
        ("AGV稼働率", _fmt_pct(kpis.get("agv_utilization"))),
        ("サイクルタイム 中央値/p95", cycle),
        ("1件あたり歩行 (m)", _fmt_num(kpis.get("walk_per_order_m"), 0)),
        ("必要人員 (名)", _fmt_num(kpis.get("headcount"))),
        ("月間コスト", _fmt_money(kpis.get("monthly_cost"), kpis)),
        ("月間運用費 (OPEX)", _fmt_money(kpis.get("monthly_opex"), kpis)),
        ("1件あたりコスト", _fmt_money(kpis.get("total_cost_per_order"), kpis, 1)),
    ]


def _normalize_scenarios(scenarios) -> list[dict]:
    """Coerce the various scenario shapes into a flat list of comparison rows.

    Accepts:
      * the /run-scenarios payload: {"baseline": {...}, "alternatives": [...]}
      * a plain list of {"name","description","kpis", ...} dicts
    Each item is {name, description, kpis(dict), is_baseline(bool)}. Returns []
    for anything unusable so callers can simply skip the section.
    """
    if not scenarios:
        return []
    items: list[dict] = []
    try:
        if isinstance(scenarios, dict):
            base = scenarios.get("baseline")
            alts = scenarios.get("alternatives") or []
            seq = ([base] if base else []) + list(alts)
        else:
            seq = list(scenarios)
        for i, sc in enumerate(seq):
            if not isinstance(sc, dict):
                continue
            items.append({
                "name": str(sc.get("name") or (f"案{i}" if i else "現行")),
                "description": str(sc.get("description") or ""),
                "kpis": sc.get("kpis") or {},
                "is_baseline": bool(sc.get("is_baseline", i == 0)),
            })
    except Exception:
        return []
    return items


def _normalize_insights(insights) -> list[dict]:
    """Coerce insights into [{severity, title, fact, action}] (text-only)."""
    if not insights:
        return []
    out: list[dict] = []
    try:
        for ins in insights:
            if not isinstance(ins, dict):
                # allow bare strings as a simple recommendation
                out.append({"severity": "info", "title": str(ins),
                            "fact": "", "action": ""})
                continue
            out.append({
                "severity": str(ins.get("severity") or "info"),
                "title": _strip_html(ins.get("title")),
                "fact": _strip_html(ins.get("fact")),
                "action": _strip_html(ins.get("action")),
            })
    except Exception:
        return []
    return [o for o in out if o.get("title") or o.get("action")]


_SEV_COLOR = {"danger": RED, "warn": AMBER, "ok": GREEN, "info": NEUTRAL}


def _delta_str(base, alt, *, money=False, kpis=None, lower_is_better=True) -> str:
    """Signed delta alt-vs-base, with an arrow; '—' when not comparable."""
    try:
        b, a = float(base), float(alt)
    except (TypeError, ValueError):
        return DASH
    d = a - b
    if abs(d) < 1e-9:
        return "±0"
    arrow = "▲" if d > 0 else "▼"
    mag = _fmt_money(abs(d), kpis or {}, 1) if money else _fmt_num(abs(d), 1)
    return f"{arrow} {mag}"


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
    lines = [
        "本提案は離散事象シミュレーション(SimPy)に基づく概算です。",
    ]
    if provenance_summary:
        lines.append(str(provenance_summary))
    lines.append(
        f"前提条件: 人件費 {rate}/人時 ・ AGV投資 {capex} ・ 36ヶ月償却"
    )
    return lines


def _methodology_footer(provenance_summary: str) -> str:
    """One-line methodology + data-provenance footer used on every document."""
    base = "本提案は離散事象シミュレーション(SimPy)に基づく"
    if provenance_summary:
        return f"{base} ／ {provenance_summary}"
    return base


def _date_str() -> str:
    return _dt.date.today().strftime("%Y年%m月%d日")


def _png_exists(png_path) -> Path | None:
    if not png_path:
        return None
    p = Path(png_path)
    return p if p.is_file() else None


# --- PowerPoint builder --------------------------------------------------------

def build_pptx(kpis: dict, model_name: str, provenance_summary: str,
               png_path, out_path, *, scenarios=None, insights=None,
               provenance=None) -> Path:
    """Build an editable, multi-section proposal deck and write it to `out_path`.

    Sections (slides): cover -> executive summary -> layout & congestion -> KPI
    detail -> scenario comparison (if any) -> recommendations (if any) ->
    methodology / provenance.

    Optional params extend behaviour without breaking the original call:
      * ``scenarios``  -- the /run-scenarios payload dict ``{baseline, alternatives}``
                          or a list of ``{name, description, kpis}`` rows.
      * ``insights``    -- list of ``{severity, title, fact, action}`` items
                          (the analysis tab's "指摘->提案").
      * ``provenance``  -- alias for ``provenance_summary``; ``provenance_summary``
                          wins when both are supplied.
    Robust: missing/None inputs degrade to graceful placeholders, never raise.
    """
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.oxml.ns import qn
    from pptx.util import Inches, Pt

    out_path = Path(out_path)
    kpis = kpis or {}
    model_name = str(model_name or "倉庫")
    prov = provenance_summary or provenance or ""
    png = _png_exists(png_path)
    scen = _normalize_scenarios(scenarios)
    recs = _normalize_insights(insights)

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    SW = prs.slide_width
    SH = prs.slide_height
    blank = prs.slide_layouts[6]

    def _set_run(run, *, size, bold=False, color=INK):
        run.font.name = PPTX_FONT
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = RGBColor(*color)
        # Ensure east-asian font is also set so CJK glyphs use the family.
        rPr = run._r.get_or_add_rPr()
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

    def _para(tf, text, *, size, bold=False, color=INK, bullet=False, first=False):
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        run = p.add_run()
        run.text = (f"・ {text}" if bullet else text)
        _set_run(run, size=size, bold=bold, color=color)
        return p

    def _rect(slide, left, top, width, height, color):
        sp = slide.shapes.add_shape(1, left, top, width, height)
        sp.fill.solid()
        sp.fill.fore_color.rgb = RGBColor(*color)
        sp.line.fill.background()
        sp.shadow.inherit = False
        return sp

    def _header_band(slide, title):
        """Branded blue band + section title, reused on every content slide."""
        _rect(slide, 0, 0, SW, Inches(0.85), NOTION_BLUE)
        tf = _textbox(slide, Inches(0.5), Inches(0.12), Inches(12.3), Inches(0.6))
        _para(tf, title, size=24, bold=True, color=WHITE, first=True)

    def _footer(slide):
        tf = _textbox(slide, Inches(0.5), SH - Inches(0.45),
                      Inches(12.3), Inches(0.4))
        _para(tf, _methodology_footer(prov), size=9, color=SUBTLE, first=True)

    # --- Slide 1: Cover -------------------------------------------------------
    s1 = prs.slides.add_slide(blank)
    _rect(s1, 0, 0, SW, Inches(2.1), NOTION_BLUE)            # top brand band
    _rect(s1, 0, SH - Inches(0.25), SW, Inches(0.25), INK)   # bottom ink rule
    ptf = _textbox(s1, Inches(1.0), Inches(0.55), Inches(11.3), Inches(0.6))
    _para(ptf, PRODUCT_NAME, size=20, bold=True, color=WHITE, first=True)
    badge = _textbox(s1, Inches(1.0), Inches(1.25), Inches(6.0), Inches(0.6))
    _para(badge, "提案書 / PROPOSAL", size=16, color=(0xDD, 0xEC, 0xFB), first=True)
    tf = _textbox(s1, Inches(1.0), Inches(3.0), Inches(11.3), Inches(2.0))
    _para(tf, f"{model_name}", size=46, bold=True, color=INK, first=True)
    _para(tf, "倉庫運用シミュレーション提案", size=24, color=NOTION_BLUE)
    sub = _textbox(s1, Inches(1.0), Inches(5.4), Inches(11.3), Inches(1.0))
    _para(sub, f"{_date_str()} ・ 概算見積り", size=18, color=SUBTLE, first=True)
    _para(sub, _methodology_footer(prov), size=11, color=SUBTLE)

    # --- Slide 2: Executive summary (verdict + 4 hero tiles) -----------------
    s2 = prs.slides.add_slide(blank)
    _header_band(s2, "エグゼクティブサマリー")
    ok = _is_ok(kpis)
    vcolor = GREEN if ok else RED
    vtf = _textbox(s2, Inches(0.5), Inches(1.1), Inches(12.3), Inches(1.0))
    _para(vtf, _verdict_text(kpis), size=26, bold=True, color=vcolor, first=True)

    tiles = _headline_tiles(kpis)
    tile_w = Inches(2.95)
    top = Inches(2.5)
    th = Inches(2.4)
    for i, (label, value, unit) in enumerate(tiles):
        left = Inches(0.5 + i * (2.95 + 0.18))
        _rect(s2, left, top, tile_w, th, LIGHT)
        _rect(s2, left, top, tile_w, Inches(0.12), NOTION_BLUE)  # accent strip
        ltf = _textbox(s2, left, top + Inches(0.3), tile_w, Inches(0.6))
        _para(ltf, label, size=14, bold=True, color=SUBTLE, first=True)
        vtf2 = _textbox(s2, left, top + Inches(0.95), tile_w, Inches(1.2))
        _para(vtf2, value, size=28, bold=True, color=INK, first=True)
        if unit:
            _para(vtf2, unit, size=13, color=SUBTLE)
    _footer(s2)

    # --- Slide 3: Layout & congestion (embed PNG) ----------------------------
    s3 = prs.slides.add_slide(blank)
    _header_band(s3, "レイアウトと混雑度")
    if png is not None:
        try:
            from PIL import Image
            with Image.open(png) as im:
                iw, ih = im.size
            ar = ih / iw if iw else 0.5
        except Exception:
            ar = 0.5
        max_w, max_h = 12.0, 5.7
        pic_w = max_w
        pic_h = pic_w * ar
        if pic_h > max_h:
            pic_h = max_h
            pic_w = pic_h / ar if ar else max_w
        left = Inches((13.333 - pic_w) / 2)
        s3.shapes.add_picture(str(png), left, Inches(1.15),
                              width=Inches(pic_w), height=Inches(pic_h))
    else:
        ntf = _textbox(s3, Inches(0.5), Inches(3.0), Inches(12.3), Inches(1.0))
        _para(ntf, "（レイアウト図は省略されました）", size=16, color=SUBTLE,
              first=True)
    _footer(s3)

    # --- Slide 4: KPI detail table -------------------------------------------
    s4 = prs.slides.add_slide(blank)
    _header_band(s4, "KPI詳細")
    rows = _detail_rows(kpis)
    n = len(rows) + 1
    tbl_shape = s4.shapes.add_table(n, 2, Inches(2.0), Inches(1.1),
                                    Inches(9.3), Inches(5.6))
    table = tbl_shape.table
    table.columns[0].width = Inches(5.6)
    table.columns[1].width = Inches(3.7)

    def _cell(r_i, c_i, text, *, size=13, bold=False, color=INK, fill=None):
        cell = table.cell(r_i, c_i)
        if fill is not None:
            cell.fill.solid()
            cell.fill.fore_color.rgb = RGBColor(*fill)
        cell.text = ""
        run = cell.text_frame.paragraphs[0].add_run()
        run.text = text
        _set_run(run, size=size, bold=bold, color=color)

    _cell(0, 0, "指標", size=14, bold=True, color=WHITE, fill=NOTION_BLUE)
    _cell(0, 1, "値", size=14, bold=True, color=WHITE, fill=NOTION_BLUE)
    for i, (label, value) in enumerate(rows, start=1):
        zebra = LIGHT if i % 2 == 0 else WHITE
        _cell(i, 0, label, size=12, bold=True, fill=zebra)
        _cell(i, 1, value, size=12, fill=zebra)
    _footer(s4)

    # --- Slide 5: Scenario comparison (only if provided) ---------------------
    if scen:
        s5 = prs.slides.add_slide(blank)
        _header_band(s5, "シナリオ比較（現行 vs 代替案）")
        b_k = scen[0]["kpis"]
        metrics = [
            ("処理能力 (件/時)", "throughput_per_hr", 1, False),
            ("出荷完了率", "completion_rate", None, False),
            ("必要人員 (名)", "headcount", 0, False),
            ("1件あたりコスト", "total_cost_per_order", 1, True),
            ("月間コスト", "monthly_cost", 0, True),
            ("投資回収 (月)", "payback_months", 1, False),
        ]
        ncols = 1 + len(scen)
        nrows = 1 + len(metrics)
        tshape = s5.shapes.add_table(nrows, ncols, Inches(0.5), Inches(1.1),
                                     Inches(12.3), Inches(5.4))
        tb = tshape.table

        def _scell(r_i, c_i, text, *, size=12, bold=False, color=INK, fill=None):
            cell = tb.cell(r_i, c_i)
            if fill is not None:
                cell.fill.solid()
                cell.fill.fore_color.rgb = RGBColor(*fill)
            cell.text = ""
            run = cell.text_frame.paragraphs[0].add_run()
            run.text = text
            _set_run(run, size=size, bold=bold, color=color)

        _scell(0, 0, "指標", size=13, bold=True, color=WHITE, fill=NOTION_BLUE)
        for ci, sc in enumerate(scen, start=1):
            tag = "（現行）" if sc["is_baseline"] else ""
            _scell(0, ci, f"{sc['name']}{tag}", size=13, bold=True,
                   color=WHITE, fill=NOTION_BLUE)
        for ri, (label, key, digits, money) in enumerate(metrics, start=1):
            zebra = LIGHT if ri % 2 == 0 else WHITE
            _scell(ri, 0, label, size=12, bold=True, fill=zebra)
            for ci, sc in enumerate(scen, start=1):
                k = sc["kpis"]
                val = k.get(key)
                if key == "completion_rate":
                    txt = _fmt_pct(val)
                elif money:
                    txt = _fmt_money(val, k, digits or 0)
                else:
                    txt = _fmt_num(val, digits or 0)
                if not sc["is_baseline"] and key != "payback_months":
                    d = _delta_str(b_k.get(key), val, money=money, kpis=k)
                    if d not in (DASH, "±0"):
                        txt = f"{txt}  ({d})"
                _scell(ri, ci, txt, size=12, fill=zebra)
        _footer(s5)

    # --- Slide 6: Recommendations (only if insights provided) ----------------
    if recs:
        s6 = prs.slides.add_slide(blank)
        _header_band(s6, "ご提案・次のステップ")
        rtf = _textbox(s6, Inches(0.6), Inches(1.2), Inches(12.1), Inches(5.6))
        first = True
        for ins in recs:
            color = _SEV_COLOR.get(ins["severity"], INK)
            title = ins["title"] or ins["action"]
            p = rtf.paragraphs[0] if first else rtf.add_paragraph()
            first = False
            r0 = p.add_run()
            r0.text = f"■ {title}"
            _set_run(r0, size=17, bold=True, color=color)
            detail = " ".join(x for x in (ins["fact"], ins["action"]) if x)
            if detail:
                rd = rtf.add_paragraph().add_run()
                rd.text = f"　→ {detail}"
                _set_run(rd, size=13, color=INK)
        _footer(s6)

    # --- Final slide: Methodology / provenance -------------------------------
    sN = prs.slides.add_slide(blank)
    _header_band(sN, "前提条件とデータ出所")
    atf = _textbox(sN, Inches(0.6), Inches(1.3), Inches(12.1), Inches(5.0))
    first = True
    for line in _assumptions_lines(kpis, prov):
        _para(atf, line, size=16, color=INK, bullet=True, first=first)
        first = False

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
              png_path, out_path, *, scenarios=None, insights=None,
              provenance=None) -> Path:
    """Build a multi-section A4 proposal PDF and write it to `out_path`.

    Mirrors the PPTX sections: cover header -> executive summary (verdict + hero
    tiles) -> layout & congestion -> KPI detail -> scenario comparison (if any)
    -> recommendations (if any) -> methodology / provenance. Optional params are
    the same as :func:`build_pptx`; missing inputs degrade gracefully.
    """
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        Image as RLImage,
        KeepTogether,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )
    from reportlab.lib.styles import ParagraphStyle

    out_path = Path(out_path)
    kpis = kpis or {}
    model_name = str(model_name or "倉庫")
    prov = provenance_summary or provenance or ""
    png = _png_exists(png_path)
    scen = _normalize_scenarios(scenarios)
    recs = _normalize_insights(insights)
    font = _register_cjk_font()

    def _rgb(t):
        return colors.Color(t[0] / 255, t[1] / 255, t[2] / 255)

    product_style = ParagraphStyle(
        "product", fontName=font, fontSize=11, leading=15,
        textColor=_rgb(NOTION_BLUE),
    )
    title_style = ParagraphStyle(
        "title", fontName=font, fontSize=24, leading=30, textColor=_rgb(INK),
    )
    sub_style = ParagraphStyle(
        "sub", fontName=font, fontSize=11, leading=16, textColor=_rgb(SUBTLE),
    )
    section_style = ParagraphStyle(
        "section", fontName=font, fontSize=14, leading=20,
        textColor=_rgb(NOTION_BLUE), spaceBefore=4, spaceAfter=4,
    )
    verdict_ok = _is_ok(kpis)
    verdict_style = ParagraphStyle(
        "verdict", fontName=font, fontSize=16, leading=22,
        textColor=_rgb(GREEN if verdict_ok else RED),
    )
    body_style = ParagraphStyle(
        "body", fontName=font, fontSize=9, leading=13, textColor=_rgb(INK),
    )
    foot_style = ParagraphStyle(
        "foot", fontName=font, fontSize=8, leading=11, textColor=_rgb(SUBTLE),
    )
    tile_label = ParagraphStyle(
        "tlab", fontName=font, fontSize=9, leading=12, textColor=_rgb(SUBTLE),
        alignment=1,
    )
    tile_value = ParagraphStyle(
        "tval", fontName=font, fontSize=15, leading=18, textColor=_rgb(INK),
        alignment=1,
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(out_path), pagesize=A4,
        leftMargin=16 * mm, rightMargin=16 * mm,
        topMargin=14 * mm, bottomMargin=12 * mm,
        title=f"{model_name} 倉庫運用 提案書",
    )
    avail_w = A4[0] - 32 * mm
    story = []

    def _section(label):
        story.append(Spacer(1, 4 * mm))
        story.append(Paragraph(label, section_style))
        # thin brand rule under the heading
        rule = Table([[""]], colWidths=[avail_w], rowHeights=[1.2])
        rule.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 1.2,
                                   _rgb(NOTION_BLUE))]))
        story.append(rule)
        story.append(Spacer(1, 2 * mm))

    # --- Cover header ---------------------------------------------------------
    story.append(Paragraph(f"{PRODUCT_NAME} ・ 提案書 / PROPOSAL", product_style))
    story.append(Spacer(1, 1.5 * mm))
    story.append(Paragraph(f"{model_name} 倉庫運用シミュレーション提案", title_style))
    story.append(Paragraph(f"{_date_str()} ・ 概算見積り", sub_style))
    story.append(Spacer(1, 4 * mm))

    # --- Executive summary ----------------------------------------------------
    _section("エグゼクティブサマリー")
    story.append(Paragraph(_verdict_text(kpis), verdict_style))
    story.append(Spacer(1, 3 * mm))
    tiles = _headline_tiles(kpis)
    tile_cells = []
    for label, value, unit in tiles:
        vtxt = f"{value} {unit}".strip()
        tile_cells.append([Paragraph(label, tile_label),
                           Paragraph(vtxt, tile_value)])
    # one row of 4 stacked tiles -> build as a 4-col table of mini-tables
    minis = []
    for cell in tile_cells:
        mt = Table([[cell[0]], [cell[1]]], colWidths=[avail_w / 4 - 3])
        mt.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), _rgb(LIGHT)),
            ("LINEABOVE", (0, 0), (-1, 0), 2.5, _rgb(NOTION_BLUE)),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]))
        minis.append(mt)
    tiles_tbl = Table([minis], colWidths=[avail_w / 4] * 4)
    tiles_tbl.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(tiles_tbl)

    # --- Layout & congestion --------------------------------------------------
    _section("レイアウトと混雑度")
    if png is not None:
        try:
            from PIL import Image as PILImage
            with PILImage.open(png) as im:
                iw, ih = im.size
            scale = min(avail_w / iw, (105 * mm) / ih)
            story.append(RLImage(str(png), width=iw * scale, height=ih * scale))
        except Exception:
            story.append(Paragraph("（レイアウト図は省略されました）", body_style))
    else:
        story.append(Paragraph("（レイアウト図は省略されました）", body_style))

    # --- KPI detail table -----------------------------------------------------
    _section("KPI詳細")
    data = [["指標", "値"]] + [list(r) for r in _detail_rows(kpis)]
    table = Table(data, colWidths=[avail_w * 0.6, avail_w * 0.4])
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), font),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BACKGROUND", (0, 0), (-1, 0), _rgb(NOTION_BLUE)),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("TEXTCOLOR", (0, 1), (-1, -1), _rgb(INK)),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _rgb(LIGHT)]),
        ("GRID", (0, 0), (-1, -1), 0.4, _rgb((0xD0, 0xDC, 0xEC))),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(table)

    # --- Scenario comparison (only if provided) ------------------------------
    if scen:
        _section("シナリオ比較（現行 vs 代替案）")
        b_k = scen[0]["kpis"]
        metrics = [
            ("処理能力 (件/時)", "throughput_per_hr", 1, False),
            ("出荷完了率", "completion_rate", None, False),
            ("必要人員 (名)", "headcount", 0, False),
            ("1件あたりコスト", "total_cost_per_order", 1, True),
            ("月間コスト", "monthly_cost", 0, True),
            ("投資回収 (月)", "payback_months", 1, False),
        ]
        header = ["指標"] + [
            f"{sc['name']}（現行）" if sc["is_baseline"] else sc["name"]
            for sc in scen
        ]
        rows_d = [header]
        for label, key, digits, money in metrics:
            row = [label]
            for sc in scen:
                k = sc["kpis"]
                val = k.get(key)
                if key == "completion_rate":
                    txt = _fmt_pct(val)
                elif money:
                    txt = _fmt_money(val, k, digits or 0)
                else:
                    txt = _fmt_num(val, digits or 0)
                if not sc["is_baseline"] and key != "payback_months":
                    d = _delta_str(b_k.get(key), val, money=money, kpis=k)
                    if d not in (DASH, "±0"):
                        txt = f"{txt} ({d})"
                row.append(txt)
            rows_d.append(row)
        ncol = len(header)
        cw = [avail_w * 0.28] + [avail_w * 0.72 / (ncol - 1)] * (ncol - 1)
        stbl = Table(rows_d, colWidths=cw)
        stbl.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), font),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("BACKGROUND", (0, 0), (-1, 0), _rgb(NOTION_BLUE)),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _rgb(LIGHT)]),
            ("GRID", (0, 0), (-1, -1), 0.4, _rgb((0xD0, 0xDC, 0xEC))),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(stbl)

    # --- Recommendations (only if insights provided) -------------------------
    if recs:
        _section("ご提案・次のステップ")
        for ins in recs:
            color = _SEV_COLOR.get(ins["severity"], INK)
            title = ins["title"] or ins["action"]
            t_style = ParagraphStyle(
                "rec", fontName=font, fontSize=10, leading=14,
                textColor=_rgb(color),
            )
            block = [Paragraph(f"■ {title}", t_style)]
            detail = " ".join(x for x in (ins["fact"], ins["action"]) if x)
            if detail:
                block.append(Paragraph(f"→ {detail}", body_style))
            block.append(Spacer(1, 1.5 * mm))
            story.append(KeepTogether(block))

    # --- Methodology / provenance footer -------------------------------------
    _section("前提条件とデータ出所")
    for line in _assumptions_lines(kpis, prov):
        story.append(Paragraph(f"・ {line}", foot_style))

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
