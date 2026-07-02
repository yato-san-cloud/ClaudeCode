"""X線骨盤分析レポートのPDF生成。

紹介状とは別に、分析結果(注釈画像 + 計測値の表 + 所見)を
1枚のレポートとして出力する。整形外科への持参や院内記録を想定。
"""
import io
from datetime import datetime

from reportlab.lib.units import mm as MM
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics

from modules.referral_letter import _Doc, FONT, MARGIN_X, LINE

# 計測キー → 日本語ラベル (表示順もこの順)
_LABELS_FULL = [
    ("fhl_tilt_deg", "大腿骨頭ライン(FHL)傾斜", "°"),
    ("fhl_lower_side", "低い側(大腿骨頭)", ""),
    ("femur_diff", "大腿骨頭 高低差", None),   # px/mm ペア
    ("iliac_diff", "腸骨稜 高低差(FHL基準)", None),
    ("iliac_higher_side", "高い側(腸骨稜)", ""),
    ("symphysis_shift", "恥骨結合 側方偏位", "shift"),
    ("s2_shift", "S2 側方偏位", "shift"),
]

_LABELS_SIMPLE = {
    "pelvis_tilt": [
        ("tilt_angle_deg", "骨盤傾斜角", "°"),
        ("height_diff", "腸骨稜 高低差", None),
        ("higher_side", "高い側", ""),
    ],
    "leg_length": [
        ("vertical_diff", "大腿骨頭 高低差", None),
        ("lower_side", "低い側", ""),
    ],
    "spine_alignment": [
        ("max_deviation", "最大側方偏位", None),
        ("deviation_direction", "偏位方向", ""),
        ("cobb_angle_approx_deg", "Cobb角(概算)", "°"),
    ],
}

ANALYSIS_TITLES = {
    "pelvis_full": "骨盤総合分析（Gonstead式）",
    "pelvis_tilt": "骨盤傾斜分析",
    "leg_length": "脚長差分析（大腿骨頭高）",
    "spine_alignment": "脊椎アライメント分析",
}


def _fmt_pair(measurements, base_key):
    """xxx_px / xxx_mm のペアを "12.3mm (24.6px)" 形式へ。"""
    px = measurements.get(f"{base_key}_px")
    mm_v = measurements.get(f"{base_key}_mm")
    if px is None:
        return None
    if mm_v is not None:
        return f"{mm_v} mm（{px} px）"
    return f"{px} px"


def _fmt_shift(shift):
    if not isinstance(shift, dict):
        return None
    side = shift.get("side", "")
    if shift.get("mm") is not None:
        val = f"{shift['mm']} mm（{shift['px']} px）"
    else:
        val = f"{shift['px']} px"
    return f"{side}方向へ {val}" if side not in ("", "中央") else f"中央（{val}）"


def measurement_rows(measurements: dict, analysis_type: str):
    """レポート表用の (ラベル, 値) 行リストを作る。"""
    rows = []
    if analysis_type == "pelvis_full":
        spec = _LABELS_FULL
    else:
        spec = _LABELS_SIMPLE.get(analysis_type, [])

    for key, label, kind in spec:
        if kind is None:
            val = _fmt_pair(measurements, key)
        elif kind == "shift":
            val = _fmt_shift(measurements.get(key))
        else:
            raw = measurements.get(key)
            val = f"{raw}{kind}" if raw is not None else None
        if val is not None:
            rows.append((label, str(val)))

    # 腸骨稜高の内訳 (pelvis_full)
    heights_mm = measurements.get("iliac_height_mm")
    heights_px = measurements.get("iliac_height_px")
    if isinstance(heights_mm, dict):
        for side, v in heights_mm.items():
            rows.append((f"腸骨稜高（{side}）", f"{v} mm"))
    elif isinstance(heights_px, dict):
        for side, v in heights_px.items():
            rows.append((f"腸骨稜高（{side}）", f"{v} px"))

    scale = "設定済み" if measurements.get("calibrated") else "未設定（px表示）"
    rows.append(("スケール", scale))
    rows.append(("左右表記", measurements.get("convention", "")))
    return rows


def generate_xray_report_pdf(payload: dict) -> io.BytesIO:
    """分析レポートPDFを生成する。

    payload:
      patient: {name, exam_date, memo}
      clinic: {name, practitioner}
      analysis_type: str
      measurements: dict (compute_measurements の出力)
      image_png: bytes (注釈済み画像) ※任意
    """
    patient = payload.get("patient") or {}
    clinic = payload.get("clinic") or {}
    analysis_type = payload.get("analysis_type", "pelvis_full")
    measurements = payload.get("measurements") or {}
    image_png = payload.get("image_png")

    doc = _Doc()
    c = doc.c
    right_x = doc.w - MARGIN_X
    body_w = doc.w - 2 * MARGIN_X

    # ヘッダ
    c.setFont(FONT, 16)
    c.drawCentredString(doc.w / 2, doc.y, "X線骨盤分析レポート")
    doc.space(8 * MM)

    c.setFont(FONT, 9)
    today = datetime.now()
    c.drawRightString(right_x, doc.y, f"作成日: {today.year}年{today.month}月{today.day}日")
    doc.space(6 * MM)

    if clinic.get("name") or clinic.get("practitioner"):
        line = "　".join(x for x in [clinic.get("name", ""), clinic.get("practitioner", "")] if x)
        c.drawRightString(right_x, doc.y, line)
        doc.space(6 * MM)

    # 患者情報
    doc.section("患者情報")
    doc.label_value("氏名", patient.get("name", ""))
    doc.label_value("検査日", patient.get("exam_date", ""))
    doc.label_value("分析種別", ANALYSIS_TITLES.get(analysis_type, analysis_type))

    # 注釈画像
    if image_png:
        doc.section("分析画像")
        try:
            img = ImageReader(io.BytesIO(image_png))
            iw, ih = img.getSize()
            max_w = body_w
            max_h = 110 * MM
            scale = min(max_w / iw, max_h / ih)
            dw, dh = iw * scale, ih * scale
            doc._maybe_break(dh + 4 * MM)
            doc.y -= dh
            c.drawImage(img, MARGIN_X + (body_w - dw) / 2, doc.y,
                        width=dw, height=dh, preserveAspectRatio=True, mask="auto")
            doc.space(4 * MM)
        except Exception:
            doc.wrapped("（画像を読み込めませんでした）", MARGIN_X + 5 * MM, body_w)

    # 計測値の表
    doc.section("計測結果")
    rows = measurement_rows(measurements, analysis_type)
    label_w = 62 * MM
    row_h = LINE + 1.2 * MM
    c.setFont(FONT, 10)
    for label, value in rows:
        doc._maybe_break(row_h)
        c.setFont(FONT, 10)
        c.setStrokeColorRGB(0.85, 0.88, 0.91)
        c.setLineWidth(0.4)
        c.line(MARGIN_X, doc.y - 1.5 * MM, doc.w - MARGIN_X, doc.y - 1.5 * MM)
        c.drawString(MARGIN_X + 2 * MM, doc.y, label)
        c.drawString(MARGIN_X + label_w, doc.y, value)
        doc.y -= row_h
    c.setStrokeColorRGB(0, 0, 0)

    # 所見
    memo = (patient.get("memo") or "").strip()
    if memo:
        doc.section("所見・メモ")
        doc.wrapped(memo, MARGIN_X + 2 * MM, body_w - 4 * MM)

    # 免責
    doc.space(6 * MM)
    doc._maybe_break(3 * LINE)
    c.setFont(FONT, 8)
    c.setFillColorRGB(0.45, 0.45, 0.45)
    disclaimer = ("本レポートの計測値は画像上の基準点に基づく参考値であり、医学的診断ではありません。"
                  "診断・治療方針の決定は医師の判断によります。")
    for seg in _split_by_width(disclaimer, body_w, 8):
        c.drawString(MARGIN_X, doc.y, seg)
        doc.y -= 4.2 * MM
    c.setFillColorRGB(0, 0, 0)

    c.save()
    doc.buf.seek(0)
    return doc.buf


def _split_by_width(text, max_width, size):
    out, cur = [], ""
    for ch in text:
        if pdfmetrics.stringWidth(cur + ch, FONT, size) > max_width and cur:
            out.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out
