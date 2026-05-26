import io
from datetime import datetime
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
FONT = "HeiseiKakuGo-W5"


def generate_referral_pdf(data: dict) -> io.BytesIO:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    w, h = A4

    margin_x = 25 * mm
    y = h - 30 * mm

    # Title
    c.setFont(FONT, 20)
    c.drawCentredString(w / 2, y, "紹 介 状")
    y -= 15 * mm

    # Date
    c.setFont(FONT, 10)
    today = datetime.now()
    c.drawRightString(w - margin_x, y, f"{today.year}年{today.month}月{today.day}日")
    y -= 12 * mm

    # Destination
    c.setFont(FONT, 12)
    dest = data.get("destination_hospital", "") or "　　　　　　　　　　"
    c.drawString(margin_x, y, f"{dest}　御中")
    y -= 8 * mm
    c.setFont(FONT, 10)
    c.drawString(margin_x, y, "担当医　先生　御侍史")
    y -= 15 * mm

    # Sender info (right-aligned block)
    c.setFont(FONT, 10)
    clinic = data.get("clinic_name", "") or "＿＿＿＿＿＿＿＿"
    chiro = data.get("chiropractor_name", "") or "＿＿＿＿＿＿"
    clinic_addr = data.get("clinic_address", "") or ""
    clinic_phone = data.get("clinic_phone", "") or ""

    right_x = w - margin_x
    c.drawRightString(right_x, y, f"院名: {clinic}")
    y -= 6 * mm
    if clinic_addr:
        c.drawRightString(right_x, y, f"住所: {clinic_addr}")
        y -= 6 * mm
    if clinic_phone:
        c.drawRightString(right_x, y, f"TEL: {clinic_phone}")
        y -= 6 * mm
    c.drawRightString(right_x, y, f"施術者: {chiro}")
    y -= 15 * mm

    # Greeting
    c.setFont(FONT, 10)
    c.drawString(margin_x, y, "拝啓　時下ますますご清栄のこととお慶び申し上げます。")
    y -= 7 * mm
    c.drawString(
        margin_x, y, "下記の患者様をご紹介申し上げます。ご高診の程、何卒よろしくお願いいたします。"
    )
    y -= 12 * mm

    # Patient info section
    c.setFont(FONT, 11)
    _draw_section_header(c, margin_x, y, w - margin_x, "患者情報")
    y -= 9 * mm

    c.setFont(FONT, 10)
    fields = [
        ("氏名", f"{data.get('patient_name', '')}（{data.get('patient_name_kana', '')}）"),
        ("生年月日", data.get("patient_dob", "")),
        ("性別", data.get("patient_gender", "")),
        ("住所", data.get("patient_address", "")),
        ("電話番号", data.get("patient_phone", "")),
    ]
    for label, value in fields:
        c.drawString(margin_x + 5 * mm, y, f"{label}:")
        c.drawString(margin_x + 35 * mm, y, value)
        y -= 6 * mm

    y -= 5 * mm

    # Clinical info section
    _draw_section_header(c, margin_x, y, w - margin_x, "臨床情報")
    y -= 9 * mm

    c.setFont(FONT, 10)
    clinical_fields = [
        ("主訴", data.get("chief_complaint", "")),
        ("症状部位", data.get("symptom_location", "")),
        ("症状期間", data.get("symptom_duration", "")),
        ("痛みレベル", f"{data.get('pain_level', '')}/10" if data.get("pain_level") else ""),
        ("既往歴", data.get("medical_history", "")),
        ("服用中の薬", data.get("current_medications", "")),
    ]
    for label, value in clinical_fields:
        if not value:
            continue
        c.drawString(margin_x + 5 * mm, y, f"{label}:")
        text = value
        if len(text) > 40:
            c.drawString(margin_x + 35 * mm, y, text[:40])
            y -= 6 * mm
            c.drawString(margin_x + 35 * mm, y, text[40:])
        else:
            c.drawString(margin_x + 35 * mm, y, text)
        y -= 6 * mm

    y -= 5 * mm

    # Referral reason section
    _draw_section_header(c, margin_x, y, w - margin_x, "紹介目的")
    y -= 9 * mm

    c.setFont(FONT, 10)
    reason = data.get("referral_reason", "") or "骨盤・脊椎のX線検査をお願いしたく、ご紹介申し上げます。"
    _draw_wrapped_text(c, margin_x + 5 * mm, y, reason, w - 2 * margin_x - 10 * mm, FONT, 10)
    y -= 6 * mm * (len(reason) // 45 + 1)

    y -= 5 * mm

    # Request
    c.setFont(FONT, 10)
    c.drawString(margin_x, y, "【ご依頼事項】")
    y -= 7 * mm
    requests = [
        "1. 骨盤正面のX線撮影（立位）",
        "2. 腰椎側面のX線撮影",
        "3. 上記検査結果のご教示",
    ]
    for req in requests:
        c.drawString(margin_x + 5 * mm, y, req)
        y -= 6 * mm

    y -= 10 * mm

    # Closing
    c.drawRightString(right_x, y, "敬具")

    c.save()
    buf.seek(0)
    return buf


def _draw_section_header(c, x1, y, x2, title):
    c.setFont(FONT, 11)
    c.setLineWidth(0.5)
    c.line(x1, y - 1, x2, y - 1)
    c.drawString(x1 + 2 * mm, y + 1, f"【{title}】")


def _draw_wrapped_text(c, x, y, text, max_width, font, size):
    c.setFont(font, size)
    chars_per_line = int(max_width / (size * 0.6))
    lines = [text[i : i + chars_per_line] for i in range(0, len(text), chars_per_line)]
    for line in lines:
        c.drawString(x, y, line)
        y -= size * 1.5
