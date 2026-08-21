"""One-page A4 proposal PDF builder (reportlab)."""

from __future__ import annotations

from pathlib import Path
from xml.sax.saxutils import escape as _xml_escape

from ._data import (
    DASH,
    GREEN,
    INK,
    LIGHT,
    PRODUCT_NAME,
    RED,
    SUBTLE,
    _SCENARIO_METRICS,
    _SEV_COLOR,
    _assumptions_lines,
    _brand_section,
    _date_str,
    _delta_str,
    _detail_rows,
    _fmt_money,
    _fmt_num,
    _fmt_pct,
    _headline_tiles,
    _is_ok,
    _normalize_insights,
    _normalize_scenarios,
    _png_exists,
    _staffing_section,
    _storage_table,
    _verdict_text,
)
from .fonts import _register_cjk_font


def build_pdf(kpis: dict, model_name: str, provenance_summary: str,
              png_path, out_path, *, scenarios=None, insights=None,
              provenance=None, storage=None, model=None, brand=None) -> Path:
    """Build a multi-section A4 proposal PDF and write it to `out_path`.

    Mirrors the PPTX sections: cover header -> executive summary (verdict + hero
    tiles) -> layout & congestion -> KPI detail -> 人員配置と工程フロー (if the
    optional ``model`` carries demand) -> scenario comparison (if any) ->
    recommendations (if any) -> methodology / provenance. Optional params are the
    same as :func:`build_pptx` — including ``brand`` (提案書ブランドテーマ): the cover
    shows 宛先「〇〇御中」+ 提案元 + optional logo and the accent colour drives every
    heading rule / table header. A default/absent brand keeps the built-in accent.
    Missing inputs degrade gracefully.
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
    staff = _staffing_section(model)  # None when no demand / any failure
    font = _register_cjk_font()
    # 提案書ブランドテーマ: `accent` (defaulting to the built-in Notion-blue) drives
    # every heading rule / table header; the cover adds 宛先/提案元/ロゴ. A default/
    # absent brand keeps the built-in colour, so an unbranded PDF is unchanged.
    bstyle = _brand_section(brand, model)
    accent = bstyle["accent"]

    def _rgb(t):
        return colors.Color(t[0] / 255, t[1] / 255, t[2] / 255)

    product_style = ParagraphStyle(
        "product", fontName=font, fontSize=11, leading=15,
        textColor=_rgb(accent),
    )
    title_style = ParagraphStyle(
        "title", fontName=font, fontSize=24, leading=30, textColor=_rgb(INK),
    )
    sub_style = ParagraphStyle(
        "sub", fontName=font, fontSize=11, leading=16, textColor=_rgb(SUBTLE),
    )
    client_style = ParagraphStyle(  # 宛先「〇〇御中」 above the deck title
        "client", fontName=font, fontSize=15, leading=20, textColor=_rgb(INK),
    )
    section_style = ParagraphStyle(
        "section", fontName=font, fontSize=14, leading=20,
        textColor=_rgb(accent), spaceBefore=4, spaceAfter=4,
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
                                   _rgb(accent))]))
        story.append(rule)
        story.append(Spacer(1, 2 * mm))

    # --- Cover header ---------------------------------------------------------
    # Brand logo at the top of the cover. Guarded: a missing/corrupt image is
    # skipped silently (the cover still renders).
    if bstyle["logo_path"]:
        try:
            from PIL import Image as PILImage
            with PILImage.open(bstyle["logo_path"]) as im:
                iw, ih = im.size
            lh = 16 * mm
            lw = lh * (iw / ih) if ih else lh
            if lw > 60 * mm:
                lw = 60 * mm
                lh = lw * (ih / iw) if iw else lh
            story.append(RLImage(str(bstyle["logo_path"]), width=lw, height=lh))
            story.append(Spacer(1, 2 * mm))
        except Exception:  # noqa: BLE001 — brand logo is optional, never fatal
            pass
    story.append(Paragraph(f"{PRODUCT_NAME} ・ 提案書 / PROPOSAL", product_style))
    story.append(Spacer(1, 1.5 * mm))
    # 宛先「〇〇御中」 above the deck title (only when a client is named).
    if bstyle["client_name"]:
        story.append(Paragraph(f"{_xml_escape(bstyle['client_name'])} 御中",
                               client_style))
        story.append(Spacer(1, 1 * mm))
    story.append(Paragraph(f"{model_name} 倉庫運用シミュレーション提案", title_style))
    story.append(Paragraph(f"{_date_str()} ・ 概算見積り", sub_style))
    if bstyle["company_name"]:
        story.append(Paragraph(f"提案元：{_xml_escape(bstyle['company_name'])}",
                               sub_style))
    if bstyle["footer_note"]:
        story.append(Paragraph(_xml_escape(bstyle["footer_note"]), foot_style))
    story.append(Spacer(1, 4 * mm))

    # --- Executive summary ----------------------------------------------------
    _section("① 課題：エグゼクティブサマリー")
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
            ("LINEABOVE", (0, 0), (-1, 0), 2.5, _rgb(accent)),
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
    _section("② 設計：レイアウトと混雑度")
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
    _section("③ 検証：KPI詳細")
    data = [["指標", "値"]] + [list(r) for r in _detail_rows(kpis)]
    table = Table(data, colWidths=[avail_w * 0.6, avail_w * 0.4])
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), font),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BACKGROUND", (0, 0), (-1, 0), _rgb(accent)),
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

    # --- Storage design (保管設計) — only if an estimate is provided ----------
    st = _storage_table(storage)
    if st is not None:
        header, srows, summary = st
        _section("③ 設計：保管設備の試算（間口・台数・坪数）")
        sdata = [header] + srows
        stbl = Table(sdata, colWidths=[avail_w * 0.32, avail_w * 0.17,
                                       avail_w * 0.17, avail_w * 0.17, avail_w * 0.17])
        stbl.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), font),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("BACKGROUND", (0, 0), (-1, 0), _rgb(accent)),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("TEXTCOLOR", (0, 1), (-1, -1), _rgb(INK)),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _rgb(LIGHT)]),
            ("GRID", (0, 0), (-1, -1), 0.4, _rgb((0xD0, 0xDC, 0xEC))),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(stbl)
        story.append(Spacer(1, 2 * mm))
        story.append(Paragraph(
            f"合計：必要坪数 {summary['tsubo']}・什器 {summary['units']}台"
            f"（{summary['cells']}間口）・対象 {summary['skus']}品目"
            f"／参考保管費 {summary['cost']}/月", body_style))

    # --- Staffing & process flow (人員配置と工程フロー) — model-driven ---------
    if staff is not None:
        _section("③ 設計：人員配置と工程フロー")
        # Summary tiles: 総工数 / ピーク人数 / 終了時刻.
        minis = []
        for label, value, unit in staff["tiles"]:
            vtxt = f"{value} {unit}".strip()
            mt = Table([[Paragraph(label, tile_label)],
                        [Paragraph(vtxt, tile_value)]],
                       colWidths=[avail_w / 3 - 3])
            mt.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), _rgb(LIGHT)),
                ("LINEABOVE", (0, 0), (-1, 0), 2.5, _rgb(accent)),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]))
            minis.append(mt)
        stiles_tbl = Table([minis], colWidths=[avail_w / 3] * 3)
        stiles_tbl.setStyle(TableStyle([
            ("LEFTPADDING", (0, 0), (-1, -1), 2),
            ("RIGHTPADDING", (0, 0), (-1, -1), 2),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]))
        story.append(stiles_tbl)
        story.append(Spacer(1, 2 * mm))
        # 判定 line (充足/不足).
        staff_verdict_style = ParagraphStyle(
            "staffv", fontName=font, fontSize=11, leading=15,
            textColor=_rgb(GREEN if staff["verdict_ok"] else RED),
        )
        story.append(Paragraph(staff["verdict"], staff_verdict_style))
        # Optional バッチ投入 one-line summary.
        if staff["batch_line"]:
            story.append(Paragraph(staff["batch_line"], body_style))
        story.append(Spacer(1, 1.5 * mm))
        # 工程フロー table (工程 / 区分 / 生産性 / 依存).
        fdata = [staff["flow_header"]] + staff["flow_rows"]
        ftbl = Table(fdata, colWidths=[avail_w * 0.27, avail_w * 0.16,
                                       avail_w * 0.27, avail_w * 0.30])
        ftbl.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), font),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("BACKGROUND", (0, 0), (-1, 0), _rgb(accent)),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("TEXTCOLOR", (0, 1), (-1, -1), _rgb(INK)),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _rgb(LIGHT)]),
            ("GRID", (0, 0), (-1, -1), 0.4, _rgb((0xD0, 0xDC, 0xEC))),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(ftbl)

    # --- Scenario comparison (only if provided) ------------------------------
    if scen:
        _section("④ 推奨と回収：シナリオ比較（現行 vs 代替案）")
        b_k = scen[0]["kpis"]
        metrics = _SCENARIO_METRICS
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
            ("BACKGROUND", (0, 0), (-1, 0), _rgb(accent)),
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
        _section("④ 推奨：ご提案・次のステップ")
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
    _section("⑤ 裏付け：前提条件とデータ出所")
    for line in _assumptions_lines(kpis, prov):
        story.append(Paragraph(f"・ {line}", foot_style))

    doc.build(story)
    return out_path
