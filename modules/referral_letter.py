"""紹介状PDFの生成。

ReportLab の canvas を使いつつ、以下を担保する:
- 日本語(全角/半角混在)を文字幅ベースで正しく折り返す
- ページ下端に達したら自動で改ページする(長い問診内容でも崩れない)
- X線注釈画像を添付できる(任意)
"""
import io
from datetime import datetime
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
FONT = "HeiseiKakuGo-W5"

MARGIN_X = 25 * mm
TOP_Y = 297 * mm - 25 * mm   # A4 height - top margin
BOTTOM_Y = 25 * mm
LINE = 6 * mm


class _Doc:
    """改ページを意識した縦書きカーソル。"""

    def __init__(self):
        self.buf = io.BytesIO()
        self.c = canvas.Canvas(self.buf, pagesize=A4)
        self.w, self.h = A4
        self.y = TOP_Y

    def space(self, amount):
        self.y -= amount
        self._maybe_break()

    def _maybe_break(self, needed=LINE):
        if self.y - needed < BOTTOM_Y:
            self.c.showPage()
            self.y = TOP_Y

    def wrapped(self, text, x, max_width, size=10, leading=LINE):
        """文字幅で折り返しつつ描画。実際に使った高さ分カーソルを進める。"""
        self.c.setFont(FONT, size)
        for line in _wrap(text, max_width, size):
            self._maybe_break(leading)
            self.c.drawString(x, self.y, line)
            self.y -= leading

    def label_value(self, label, value, size=10):
        """ラベル + 値。値が長ければラベル列の下に折り返す。"""
        if value is None:
            value = ""
        self._maybe_break(LINE)
        self.c.setFont(FONT, size)
        self.c.drawString(MARGIN_X + 5 * mm, self.y, f"{label}:")
        value_x = MARGIN_X + 35 * mm
        max_w = self.w - MARGIN_X - value_x
        lines = _wrap(str(value), max_w, size) or [""]
        self.c.drawString(value_x, self.y, lines[0])
        self.y -= LINE
        for extra in lines[1:]:
            self._maybe_break(LINE)
            self.c.drawString(value_x, self.y, extra)
            self.y -= LINE

    def section(self, title, size=11):
        self.space(5 * mm)
        self._maybe_break(LINE)
        self.c.setFont(FONT, size)
        self.c.setLineWidth(0.5)
        self.c.line(MARGIN_X, self.y - 1, self.w - MARGIN_X, self.y - 1)
        self.c.drawString(MARGIN_X + 2 * mm, self.y + 1, f"【{title}】")
        self.y -= 9 * mm


def _wrap(text, max_width, size):
    """stringWidth で全角/半角を区別しつつ折り返す。改行も尊重。"""
    if not text:
        return []
    out = []
    for paragraph in str(text).split("\n"):
        if paragraph == "":
            out.append("")
            continue
        cur = ""
        for ch in paragraph:
            if pdfmetrics.stringWidth(cur + ch, FONT, size) > max_width and cur:
                out.append(cur)
                cur = ch
            else:
                cur += ch
        out.append(cur)
    return out


def generate_referral_pdf(data: dict, xray_image: bytes = None) -> io.BytesIO:
    doc = _Doc()
    c = doc.c
    right_x = doc.w - MARGIN_X

    # タイトル
    c.setFont(FONT, 20)
    c.drawCentredString(doc.w / 2, doc.y, "紹 介 状")
    doc.space(15 * mm)

    # 日付
    c.setFont(FONT, 10)
    today = datetime.now()
    c.drawRightString(right_x, doc.y, f"{today.year}年{today.month}月{today.day}日")
    doc.space(12 * mm)

    # 宛先
    c.setFont(FONT, 12)
    dest = data.get("destination_hospital", "") or "　　　　　　　　　　"
    c.drawString(MARGIN_X, doc.y, f"{dest}　御中")
    doc.space(8 * mm)
    c.setFont(FONT, 10)
    c.drawString(MARGIN_X, doc.y, "担当医　先生　御侍史")
    doc.space(15 * mm)

    # 差出人 (右寄せ)
    c.setFont(FONT, 10)
    clinic = data.get("clinic_name", "") or "＿＿＿＿＿＿＿＿"
    chiro = data.get("chiropractor_name", "") or "＿＿＿＿＿＿"
    for line in [f"院名: {clinic}"]:
        c.drawRightString(right_x, doc.y, line)
        doc.space(6 * mm)
    if data.get("clinic_address"):
        c.drawRightString(right_x, doc.y, f"住所: {data['clinic_address']}")
        doc.space(6 * mm)
    if data.get("clinic_phone"):
        c.drawRightString(right_x, doc.y, f"TEL: {data['clinic_phone']}")
        doc.space(6 * mm)
    c.drawRightString(right_x, doc.y, f"施術者: {chiro}")
    doc.space(15 * mm)

    # 挨拶
    body_w = doc.w - 2 * MARGIN_X
    doc.wrapped("拝啓　時下ますますご清栄のこととお慶び申し上げます。", MARGIN_X, body_w)
    doc.wrapped("下記の患者様をご紹介申し上げます。ご高診の程、何卒よろしくお願いいたします。",
                MARGIN_X, body_w)
    doc.space(6 * mm)

    # 患者情報
    doc.section("患者情報")
    name = f"{data.get('patient_name', '')}（{data.get('patient_name_kana', '')}）"
    doc.label_value("氏名", name)
    doc.label_value("生年月日", data.get("patient_dob", ""))
    doc.label_value("性別", data.get("patient_gender", ""))
    doc.label_value("住所", data.get("patient_address", ""))
    doc.label_value("電話番号", data.get("patient_phone", ""))

    # 臨床情報
    doc.section("臨床情報")
    clinical = [
        ("主訴", data.get("chief_complaint", "")),
        ("症状部位", data.get("symptom_location", "")),
        ("症状期間", data.get("symptom_duration", "")),
        ("痛みレベル", f"{data.get('pain_level', '')}/10" if data.get("pain_level") else ""),
        ("既往歴", data.get("medical_history", "")),
        ("服用中の薬", data.get("current_medications", "")),
    ]
    for label, value in clinical:
        if value:
            doc.label_value(label, value)

    # 紹介目的
    doc.section("紹介目的")
    reason = data.get("referral_reason", "") or "骨盤・脊椎のX線検査をお願いしたく、ご紹介申し上げます。"
    doc.wrapped(reason, MARGIN_X + 5 * mm, body_w - 5 * mm)

    # 依頼事項
    doc.space(3 * mm)
    doc.wrapped("【ご依頼事項】", MARGIN_X, body_w)
    for req in ["1. 骨盤正面のX線撮影（立位）", "2. 腰椎側面のX線撮影", "3. 上記検査結果のご教示"]:
        doc.wrapped(req, MARGIN_X + 5 * mm, body_w - 5 * mm)

    # X線添付 (任意)
    if xray_image:
        _embed_image(doc, xray_image)

    # 結語
    doc.space(8 * mm)
    doc._maybe_break(LINE)
    c.drawRightString(right_x, doc.y, "敬具")

    c.save()
    doc.buf.seek(0)
    return doc.buf


def _embed_image(doc, image_bytes):
    doc.section("添付: X線所見")
    try:
        img = ImageReader(io.BytesIO(image_bytes))
        iw, ih = img.getSize()
    except Exception:
        doc.wrapped("(画像を読み込めませんでした)", MARGIN_X + 5 * mm, doc.w - 2 * MARGIN_X)
        return

    max_w = doc.w - 2 * MARGIN_X
    max_h = 120 * mm
    scale = min(max_w / iw, max_h / ih)
    draw_w, draw_h = iw * scale, ih * scale

    doc._maybe_break(draw_h)
    doc.y -= draw_h
    doc.c.drawImage(img, MARGIN_X, doc.y, width=draw_w, height=draw_h,
                    preserveAspectRatio=True, mask="auto")
    doc.space(4 * mm)
