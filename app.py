import os
import sys
import base64
from datetime import datetime
from flask import Flask, render_template, request, send_file, jsonify

from modules.referral_letter import generate_referral_pdf
from modules.xray_analyzer import detect_landmarks, render_annotated
from modules.xray_report import generate_xray_report_pdf
from modules.dicom_loader import is_dicom, load_dicom

APP_VERSION = "1.0.0"

# PyInstaller で固めた場合は展開先 (_MEIPASS) にテンプレート/静的ファイルが入る
BASE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
)
# 高解像度X線の base64 往復を見込んで大きめに確保
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024

PATIENT_FIELDS = [
    "patient_name", "patient_name_kana", "patient_dob", "patient_gender",
    "patient_address", "patient_phone", "chief_complaint", "symptom_duration",
    "symptom_location", "pain_level", "medical_history", "current_medications",
    "referral_reason", "clinic_name", "chiropractor_name", "clinic_address",
    "clinic_phone", "destination_hospital",
]


@app.context_processor
def inject_globals():
    return {"app_version": APP_VERSION}


def _download_name(form_data):
    name = form_data.get("patient_name") or "不明"
    return f"紹介状_{name}_{datetime.now().strftime('%Y%m%d')}.pdf"


def _decode_data_url(data_url: str) -> bytes:
    return base64.b64decode(data_url.split(",")[-1])


def _parse_filters(obj) -> dict:
    if not isinstance(obj, dict):
        return {}
    out = {}
    try:
        if "contrast" in obj:
            out["contrast"] = float(obj["contrast"])
        if "brightness" in obj:
            out["brightness"] = float(obj["brightness"])
    except (TypeError, ValueError):
        pass
    out["invert"] = bool(obj.get("invert"))
    return out


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/referral", methods=["GET", "POST"])
def referral():
    if request.method == "POST":
        form_data = {f: request.form.get(f, "") for f in PATIENT_FIELDS}

        # X線注釈画像の添付 (任意): base64 (フロントから) かファイルアップロード
        xray_bytes = None
        b64 = request.form.get("xray_attachment_b64", "")
        if b64:
            try:
                xray_bytes = _decode_data_url(b64)
            except Exception:
                xray_bytes = None
        elif "xray_attachment" in request.files and request.files["xray_attachment"].filename:
            xray_bytes = request.files["xray_attachment"].read()

        pdf_buffer = generate_referral_pdf(form_data, xray_image=xray_bytes)
        return send_file(
            pdf_buffer,
            mimetype="application/pdf",
            as_attachment=True,
            download_name=_download_name(form_data),
        )

    return render_template("referral.html")


@app.route("/xray", methods=["GET", "POST"])
def xray():
    """画像をアップロードし、ランドマーク初期位置を自動検出して返す(描画はフロント側)。"""
    if request.method == "POST":
        if "xray_image" not in request.files or not request.files["xray_image"].filename:
            return jsonify({"error": "画像がアップロードされていません"}), 400

        f = request.files["xray_image"]
        image_bytes = f.read()
        analysis_type = request.form.get("analysis_type", "pelvis_full")

        # DICOM(.dcm)なら PNG へ正規化し、PixelSpacing から自動スケールを取得
        dicom_info = None
        mimetype = f.mimetype if (f.mimetype or "").startswith("image/") else "image/png"
        if is_dicom(image_bytes) or (f.filename or "").lower().endswith(".dcm"):
            try:
                loaded = load_dicom(image_bytes)
            except Exception as e:
                return jsonify({"error": f"DICOMの読み込みに失敗しました: {e}"}), 400
            image_bytes = loaded["png"]
            mimetype = "image/png"
            dicom_info = {
                "mm_per_px": loaded["mm_per_px"],
                "spacing_source": loaded["spacing_source"],
                "meta": loaded["meta"],
            }

        try:
            detection = detect_landmarks(image_bytes, analysis_type)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

        detection["image"] = (
            f"data:{mimetype};base64," + base64.b64encode(image_bytes).decode("utf-8")
        )
        if dicom_info:
            detection["dicom"] = dicom_info
        return jsonify(detection)

    return render_template("xray.html")


@app.route("/xray/export", methods=["POST"])
def xray_export():
    """補正後のランドマークで注釈画像を確定描画し、計測値とともに返す。"""
    data = request.get_json(silent=True) or {}
    image_b64 = data.get("image", "")
    analysis_type = data.get("analysis_type", "pelvis_full")
    landmarks = data.get("landmarks", [])
    mm_per_px = data.get("mm_per_px")
    filters = _parse_filters(data.get("filters"))
    ap_standard = bool(data.get("ap_standard", True))

    if not image_b64 or not landmarks:
        return jsonify({"error": "画像またはランドマークがありません"}), 400

    try:
        image_bytes = _decode_data_url(image_b64)
    except Exception:
        return jsonify({"error": "画像のデコードに失敗しました"}), 400

    try:
        annotated, measurements = render_annotated(
            image_bytes, analysis_type, landmarks, mm_per_px,
            filters=filters, ap_standard=ap_standard,
        )
    except (ValueError, KeyError) as e:
        return jsonify({"error": f"描画に失敗しました: {e}"}), 400

    return jsonify({
        "image": "data:image/png;base64," + base64.b64encode(annotated).decode("utf-8"),
        "measurements": measurements,
    })


@app.route("/xray/report", methods=["POST"])
def xray_report():
    """補正後の状態から分析レポートPDFを生成して返す。"""
    data = request.get_json(silent=True) or {}
    image_b64 = data.get("image", "")
    analysis_type = data.get("analysis_type", "pelvis_full")
    landmarks = data.get("landmarks", [])
    mm_per_px = data.get("mm_per_px")
    filters = _parse_filters(data.get("filters"))
    ap_standard = bool(data.get("ap_standard", True))
    patient = data.get("patient") or {}
    clinic = data.get("clinic") or {}

    if not image_b64 or not landmarks:
        return jsonify({"error": "画像またはランドマークがありません"}), 400

    try:
        image_bytes = _decode_data_url(image_b64)
        annotated, measurements = render_annotated(
            image_bytes, analysis_type, landmarks, mm_per_px,
            filters=filters, ap_standard=ap_standard,
        )
    except (ValueError, KeyError) as e:
        return jsonify({"error": f"分析に失敗しました: {e}"}), 400

    pdf = generate_xray_report_pdf({
        "patient": patient,
        "clinic": clinic,
        "analysis_type": analysis_type,
        "measurements": measurements,
        "image_png": annotated,
    })

    name = patient.get("name") or "無記名"
    return send_file(
        pdf,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=f"X線分析レポート_{name}_{datetime.now().strftime('%Y%m%d')}.pdf",
    )


@app.route("/api/google-form-webhook", methods=["POST"])
def google_form_webhook():
    """Google Formの回答をWebhookで受け取り、紹介状PDFを生成するエンドポイント"""
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "データがありません"}), 400

    field_mapping = {
        "お名前": "patient_name",
        "フリガナ": "patient_name_kana",
        "生年月日": "patient_dob",
        "性別": "patient_gender",
        "住所": "patient_address",
        "電話番号": "patient_phone",
        "主な症状": "chief_complaint",
        "症状の期間": "symptom_duration",
        "症状の部位": "symptom_location",
        "痛みのレベル": "pain_level",
        "既往歴": "medical_history",
        "服用中の薬": "current_medications",
        "紹介理由": "referral_reason",
    }

    form_data = {en: data.get(jp, "") for jp, en in field_mapping.items()}
    for f in PATIENT_FIELDS:
        form_data.setdefault(f, "")

    pdf_buffer = generate_referral_pdf(form_data)
    return send_file(
        pdf_buffer,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=_download_name(form_data),
    )


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
