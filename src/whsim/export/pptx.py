"""Editable PowerPoint (.pptx) proposal builder (python-pptx)."""

from __future__ import annotations

from pathlib import Path

from . import textfit
from ._data import (
    DASH,
    GREEN,
    INK,
    LIGHT,
    PPTX_FONT,
    PRODUCT_NAME,
    RED,
    SUBTLE,
    WHITE,
    _SCENARIO_METRICS,
    _SEV_COLOR,
    _assumption_blocks,
    _brand_section,
    _date_str,
    _delta_str,
    _detail_rows,
    _fmt_money,
    _fmt_num,
    _fmt_pct,
    _headline_tiles,
    _is_ok,
    _methodology_footer,
    _normalize_insights,
    _normalize_scenarios,
    _png_exists,
    _staffing_section,
    _storage_table,
    _verdict_text,
)


def build_pptx(kpis: dict, model_name: str, provenance_summary: str,
               png_path, out_path, *, scenarios=None, insights=None,
               provenance=None, storage=None, model=None, brand=None,
               assumptions=None) -> Path:
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
      * ``model``       -- optional ``WarehouseModel``; when it carries demand a
                          「人員配置と工程フロー」slide is added (総工数/ピーク人数/
                          終了時刻タイル・充足判定・バッチ投入要約・工程フロー表).
                          Fully guarded: no demand / any failure → slide omitted.
      * ``brand``       -- optional 提案書ブランドテーマ (Brand model / dict): the
                          cover shows 宛先「〇〇御中」+ 提案元 + optional logo, and the
                          accent colour drives the title bars/strips. Defaults to
                          the built-in accent, so a default/absent brand is a
                          no-op. When None, ``model.settings.brand`` is used.
      * ``assumptions`` -- 前提条件 for the ⑤ slide, as data instead of a constant:
                          a string, a list of strings / ``{"text","level"}`` items
                          (``level`` accepts ``危険側``/``danger`` and ``注意``/``warn``
                          so an unsafe-side 前提 renders in red ON the assumptions
                          slide), or ``{"lines": [...], "replace": True}`` to also
                          drop the built-in 人件費/AGV投資 line. None → the model's
                          ``settings.assumptions``, else the historical default,
                          so an unchanged export stays byte-identical.
    Robust: missing/None inputs degrade to graceful placeholders, never raise.

    Overflow: text-heavy slides (④推奨 / ⑤前提条件) are measured before they are
    written — shrink-to-fit first, then continue onto a 「（続き）」 slide. Content is
    never silently clipped, and never has to be rewritten shorter to fit.
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
    staff = _staffing_section(model)  # None when no demand / any failure
    # 提案書ブランドテーマ: `accent` is the brand accent (defaulting to the
    # built-in Notion-blue) used for every title bar / strip / table header, and
    # the cover adds 宛先/提案元/ロゴ. A default/absent brand keeps the built-in
    # colour, so an unbranded deck is colour-identical to before.
    bstyle = _brand_section(brand, model)
    accent = bstyle["accent"]

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

    def _cell_in(tbl, r_i, c_i, text, *, size=12, bold=False, color=INK, fill=None):
        """Table-agnostic cell setter (the s4 _cell closure is bound to one table)."""
        cell = tbl.cell(r_i, c_i)
        if fill is not None:
            cell.fill.solid()
            cell.fill.fore_color.rgb = RGBColor(*fill)
        cell.text = ""
        run = cell.text_frame.paragraphs[0].add_run()
        run.text = text
        _set_run(run, size=size, bold=bold, color=color)

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
        _rect(slide, 0, 0, SW, Inches(0.85), accent)
        tf = _textbox(slide, Inches(0.5), Inches(0.12), Inches(12.3), Inches(0.6))
        _para(tf, title, size=24, bold=True, color=WHITE, first=True)

    FOOTER_W = 12.3   # inches — the footer strip's usable width
    FOOTER_PT = 9.0

    def _footer(slide):
        # The footer carries the SHORT methodology form, forced onto one line:
        # this strip is 0.4in tall at the slide's bottom edge, so a second line
        # would print off the page. The full 前提条件 live on the ⑤ slide.
        text, pt = textfit.fit_line(_methodology_footer(prov), FOOTER_W, FOOTER_PT)
        tf = _textbox(slide, Inches(0.5), SH - Inches(0.45),
                      Inches(FOOTER_W), Inches(0.4))
        _para(tf, text, size=pt, color=SUBTLE, first=True)

    def _fill(slide, paras, left, top, width, height, room=None, scale=None):
        """Write `paras` into a NEW box of the given geometry, shrunk to fit.

        Every free-text box on the deck goes through here: python-pptx writes
        runs past the bottom edge without a word of complaint, so the only
        feedback the author ever got was the deck looking broken in front of the
        customer. Fixed boxes (cover, tiles, verdict) can only shrink — they have
        nowhere to continue to. `paras` are ``{"text", "pt", "bold", "color"}``.
        Text that already fits is written at its authored size, untouched.

        `room` is the vertical space the text may actually occupy before it hits
        whatever sits below it, which is what "overflow" really means; it
        defaults to the box's own height, and is passed explicitly where a box
        deliberately sits in a larger gap (the cover). `scale` is measured here
        unless the caller already measured it across several boxes."""
        if scale is None:
            scale = textfit.fit_scale(
                paras, width / 914400,
                (room if room is not None else height) / 914400)
        tf = _textbox(slide, left, top, width, height)
        for i, para in enumerate(paras):
            _para(tf, para["text"], size=para["pt"] * scale,
                  bold=para.get("bold", False),
                  color=para.get("color", INK), first=(i == 0))
        return tf

    def _text_slides(title, paras, *, left, top, width, height, footer=True):
        """Lay `paras` into as many slides as the text actually needs.

        The flowing counterpart of :func:`_fill`, for the text-heavy sections:
        shrink while the text stays legible, then continue onto a 「（続き）」 slide
        rather than clipping. Nothing is ever dropped — a slide that silently
        swallows content lets the LAYOUT dictate what the proposal is allowed to
        say, which is how two required 危険側 前提 got rewritten out of an audit."""
        w_in, h_in = width / 914400, height / 914400  # EMU -> inches
        scale = textfit.fit_scale(paras, w_in, h_in)
        for pi, page in enumerate(textfit.paginate(paras, w_in, h_in, scale)):
            slide = prs.slides.add_slide(blank)
            _header_band(slide, title if pi == 0 else f"{title}（続き）")
            _fill(slide, page, left, top, width, height, scale=scale)
            if footer:
                _footer(slide)

    # --- Slide 1: Cover -------------------------------------------------------
    s1 = prs.slides.add_slide(blank)
    _rect(s1, 0, 0, SW, Inches(2.1), accent)            # top brand band
    _rect(s1, 0, SH - Inches(0.25), SW, Inches(0.25), INK)   # bottom ink rule
    ptf = _textbox(s1, Inches(1.0), Inches(0.55), Inches(11.3), Inches(0.6))
    _para(ptf, PRODUCT_NAME, size=20, bold=True, color=WHITE, first=True)
    badge = _textbox(s1, Inches(1.0), Inches(1.25), Inches(6.0), Inches(0.6))
    _para(badge, "提案書 / PROPOSAL", size=16, color=(0xDD, 0xEC, 0xFB), first=True)
    # Brand logo, top-right of the band. Guarded: a missing/corrupt image is
    # skipped silently (the cover still renders).
    if bstyle["logo_path"]:
        try:
            from PIL import Image
            with Image.open(bstyle["logo_path"]) as im:
                iw, ih = im.size
            lh = 1.1
            lw = lh * (iw / ih) if ih else lh
            lw = min(lw, 3.2)
            lh = lw * (ih / iw) if iw else lh
            s1.shapes.add_picture(
                str(bstyle["logo_path"]),
                SW - Inches(lw + 0.7), Inches(0.5),
                width=Inches(lw), height=Inches(lh))
        except Exception:  # noqa: BLE001 — brand logo is optional, never fatal
            pass
    # 宛先「〇〇御中」 above the deck title (only when a client is named). Every
    # cover box is shrink-to-fit: a long 倉庫名 or 会社名 must not run into the band
    # below it, and the cover has no continuation slide to spill onto.
    if bstyle["client_name"]:
        _fill(s1, [{"text": f"{bstyle['client_name']} 御中", "pt": 24,
                    "bold": True, "color": INK}],
              Inches(1.0), Inches(2.35), Inches(11.3), Inches(0.6))
    # room = 2.4in: the title may run down to the 提案日 block at 5.4in, and only
    # a name long enough to reach IT is shrunk.
    _fill(s1, [{"text": f"{model_name}", "pt": 46, "bold": True, "color": INK},
               {"text": "倉庫運用シミュレーション提案", "pt": 24, "color": accent}],
          Inches(1.0), Inches(3.0), Inches(11.3), Inches(2.0), room=Inches(2.4))
    subs = [{"text": f"{_date_str()} ・ 概算見積り", "pt": 18, "color": SUBTLE}]
    if bstyle["company_name"]:
        subs.append({"text": f"提案元：{bstyle['company_name']}", "pt": 16,
                     "bold": True, "color": INK})
    subs.append({"text": _methodology_footer(prov), "pt": 11, "color": SUBTLE})
    if bstyle["footer_note"]:
        subs.append({"text": bstyle["footer_note"], "pt": 11, "color": SUBTLE})
    # room = 1.85in: down to the ink rule at the foot of the cover.
    _fill(s1, subs, Inches(1.0), Inches(5.4), Inches(11.3), Inches(1.4),
          room=Inches(1.85))

    # --- Slide 2: Executive summary (verdict + 4 hero tiles) -----------------
    s2 = prs.slides.add_slide(blank)
    _header_band(s2, "① 課題：エグゼクティブサマリー")
    ok = _is_ok(kpis)
    vcolor = GREEN if ok else RED
    _fill(s2, [{"text": _verdict_text(kpis), "pt": 26, "bold": True,
                "color": vcolor}],
          Inches(0.5), Inches(1.1), Inches(12.3), Inches(1.0))

    tiles = _headline_tiles(kpis)
    tile_w = Inches(2.95)
    top = Inches(2.5)
    th = Inches(2.4)
    for i, (label, value, unit) in enumerate(tiles):
        left = Inches(0.5 + i * (2.95 + 0.18))
        _rect(s2, left, top, tile_w, th, LIGHT)
        _rect(s2, left, top, tile_w, Inches(0.12), accent)  # accent strip
        _fill(s2, [{"text": label, "pt": 14, "bold": True, "color": SUBTLE}],
              left, top + Inches(0.3), tile_w, Inches(0.6))
        # A long ボトルネック name is the realistic overflow here: it shrinks to
        # stay inside its tile rather than printing over the one below.
        vparas = [{"text": value, "pt": 28, "bold": True, "color": INK}]
        if unit:
            vparas.append({"text": unit, "pt": 13, "color": SUBTLE})
        _fill(s2, vparas, left, top + Inches(0.95), tile_w, Inches(1.2))
    _footer(s2)

    # --- Slide 3: Layout & congestion (embed PNG) ----------------------------
    s3 = prs.slides.add_slide(blank)
    _header_band(s3, "② 設計：レイアウトと混雑度")
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
    _header_band(s4, "③ 検証：KPI詳細")
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

    _cell(0, 0, "指標", size=14, bold=True, color=WHITE, fill=accent)
    _cell(0, 1, "値", size=14, bold=True, color=WHITE, fill=accent)
    for i, (label, value) in enumerate(rows, start=1):
        zebra = LIGHT if i % 2 == 0 else WHITE
        _cell(i, 0, label, size=12, bold=True, fill=zebra)
        _cell(i, 1, value, size=12, fill=zebra)
    _footer(s4)

    # --- Slide 4b: Storage design (保管設計) — only if an estimate is provided -
    st = _storage_table(storage)
    if st is not None:
        header, srows, summary = st
        s4b = prs.slides.add_slide(blank)
        _header_band(s4b, "③ 設計：保管設備の試算（間口・台数・坪数）")
        ncol = len(header)
        nrow = len(srows) + 1
        st_shape = s4b.shapes.add_table(nrow, ncol, Inches(0.7), Inches(1.1),
                                        Inches(8.4), Inches(0.4 * nrow + 0.3))
        st_tbl = st_shape.table
        for ci, htext in enumerate(header):
            _cell_in(st_tbl, 0, ci, htext, size=12, bold=True, color=WHITE,
                     fill=accent)
        for ri, row in enumerate(srows, start=1):
            zebra = LIGHT if ri % 2 == 0 else WHITE
            for ci, val in enumerate(row):
                _cell_in(st_tbl, ri, ci, val, size=11,
                         bold=(ci == 0), fill=zebra)
        # Summary tiles (右側): 必要坪数 / 台数 / 参考保管費.
        tiles = [("必要坪数（保管）", summary["tsubo"]),
                 ("什器台数 / 間口", f"{summary['units']}台・{summary['cells']}間口"),
                 ("対象SKU", f"{summary['skus']} 品目"),
                 ("参考: 保管費/月", summary["cost"])]
        ty = 1.2
        for label, value in tiles:
            _rect(s4b, Inches(9.5), Inches(ty), Inches(3.2), Inches(1.0), LIGHT)
            _fill(s4b, [{"text": label, "pt": 10, "color": SUBTLE},
                        {"text": value, "pt": 16, "bold": True, "color": INK}],
                  Inches(9.65), Inches(ty + 0.08), Inches(2.95), Inches(0.85))
            ty += 1.15
        _footer(s4b)

    # --- Slide 4c: Staffing & process flow (人員配置と工程フロー) — model-driven -
    if staff is not None:
        s4c = prs.slides.add_slide(blank)
        _header_band(s4c, "③ 設計：人員配置と工程フロー")
        # Summary tiles: 総工数 / ピーク人数 / 終了時刻.
        stiles = staff["tiles"]
        tw = Inches(3.9)
        ttop = Inches(1.15)
        tth = Inches(1.35)
        for i, (label, value, unit) in enumerate(stiles):
            left = Inches(0.5 + i * (3.9 + 0.25))
            _rect(s4c, left, ttop, tw, tth, LIGHT)
            _rect(s4c, left, ttop, tw, Inches(0.1), accent)  # accent strip
            _fill(s4c, [{"text": label, "pt": 13, "bold": True, "color": SUBTLE}],
                  left, ttop + Inches(0.22), tw, Inches(0.4))
            vtf3 = _textbox(s4c, left, ttop + Inches(0.62), tw, Inches(0.7))
            vp = _para(vtf3, value, size=24, bold=True, color=INK, first=True)
            if unit:
                r_u = vp.add_run()
                r_u.text = f" {unit}"
                _set_run(r_u, size=13, color=SUBTLE)
        # 判定 line (充足/不足).
        _fill(s4c, [{"text": staff["verdict"], "pt": 16, "bold": True,
                     "color": (GREEN if staff["verdict_ok"] else RED)}],
              Inches(0.5), Inches(2.75), Inches(12.3), Inches(0.5))
        # Optional バッチ投入 one-line summary (a long schedule shrinks in place
        # rather than sliding under the 工程フロー table below it).
        flow_top = 3.4
        if staff["batch_line"]:
            _fill(s4c, [{"text": staff["batch_line"], "pt": 12, "color": SUBTLE}],
                  Inches(0.5), Inches(3.25), Inches(12.3), Inches(0.4))
            flow_top = 3.75
        # 工程フロー table (工程 / 区分 / 生産性 / 依存).
        header = staff["flow_header"]
        frows = staff["flow_rows"]
        nrow = len(frows) + 1
        ncol = len(header)
        ft_shape = s4c.shapes.add_table(nrow, ncol, Inches(0.5), Inches(flow_top),
                                        Inches(12.3), Inches(0.4 * nrow + 0.2))
        ft = ft_shape.table
        ft.columns[0].width = Inches(3.3)
        ft.columns[1].width = Inches(2.0)
        ft.columns[2].width = Inches(3.3)
        ft.columns[3].width = Inches(3.7)
        for ci, htext in enumerate(header):
            _cell_in(ft, 0, ci, htext, size=12, bold=True, color=WHITE,
                     fill=accent)
        for ri, row in enumerate(frows, start=1):
            zebra = LIGHT if ri % 2 == 0 else WHITE
            for ci, val in enumerate(row):
                _cell_in(ft, ri, ci, val, size=11, bold=(ci == 0), fill=zebra)
        _footer(s4c)

    # --- Slide 5: Scenario comparison (only if provided) ---------------------
    if scen:
        s5 = prs.slides.add_slide(blank)
        _header_band(s5, "④ 推奨と回収：シナリオ比較（現行 vs 代替案）")
        b_k = scen[0]["kpis"]
        metrics = _SCENARIO_METRICS
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

        _scell(0, 0, "指標", size=13, bold=True, color=WHITE, fill=accent)
        for ci, sc in enumerate(scen, start=1):
            tag = "（現行）" if sc["is_baseline"] else ""
            _scell(0, ci, f"{sc['name']}{tag}", size=13, bold=True,
                   color=WHITE, fill=accent)
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
        rec_paras = []
        for ins in recs:
            color = _SEV_COLOR.get(ins["severity"], INK)
            title = ins["title"] or ins["action"]
            detail = " ".join(x for x in (ins["fact"], ins["action"]) if x)
            # keep_next: a 指摘 headline must not be orphaned from its 提案.
            rec_paras.append({"text": f"■ {title}", "pt": 17, "bold": True,
                              "color": color, "keep_next": bool(detail)})
            if detail:
                rec_paras.append({"text": f"　→ {detail}", "pt": 13, "color": INK})
        _text_slides("④ 推奨：ご提案・次のステップ", rec_paras,
                     left=Inches(0.6), top=Inches(1.2),
                     width=Inches(12.1), height=Inches(5.6))

    # --- Final slide: Methodology / provenance -------------------------------
    # 前提条件 come from the caller / the model (see ``assumptions``); 危険側 and 注意
    # lines are bold + coloured so an unsafe-side 前提 reads as one AT A GLANCE.
    # No footer here: this slide IS the methodology statement.
    _text_slides(
        "⑤ 裏付け：前提条件とデータ出所",
        [{"text": f"・ {b['text']}", "pt": 16, "bold": b["level"] != "info",
          "color": b["color"]}
         for b in _assumption_blocks(kpis, prov, assumptions, model=model)],
        left=Inches(0.6), top=Inches(1.3), width=Inches(12.1), height=Inches(5.0),
        footer=False)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(out_path))
    return out_path
