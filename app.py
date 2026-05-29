import io
import base64
import json
from datetime import datetime
from flask import Flask, render_template, request, send_file, jsonify
from modules.referral_letter import generate_referral_pdf
from modules.xray_analyzer import detect_landmarks, compute_measurements, render_annotated

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024

PATIENT_FIELDS = [
    "patient_name", "patient_name_kana", "patient_dob", "patient_gender",
    "patient_address", "patient_phone", "chief_complaint", "symptom_duration",
    "symptom_location", "pain_level", "medical_history", "current_medications",
    "referral_reason", "clinic_name", "chiropractor_name", "clinic_address",
    "clinic_phone", "destination_hospital",
]


def _download_name(form_data):
    name = form_data.get("patient_name") or "不明"
    return f"紹介状_{name}_{datetime.now().strftime('%Y%m%d')}.pdf"


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
                xray_bytes = base64.b64decode(b64.split(",")[-1])
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
    """画像をアップロードし、ランドマークを自動検出して返す(描画はフロント側)。"""
    if request.method == "POST":
        if "xray_image" not in request.files or not request.files["xray_image"].filename:
            return jsonify({"error": "画像がアップロードされていません"}), 400

        image_bytes = request.files["xray_image"].read()
        analysis_type = request.form.get("analysis_type", "pelvis_tilt")

        try:
            detection = detect_landmarks(image_bytes, analysis_type)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

        detection["image"] = (
            "data:image/png;base64," + base64.b64encode(image_bytes).decode("utf-8")
        )
        return jsonify(detection)

    return render_template("xray.html")


@app.route("/xray/export", methods=["POST"])
def xray_export():
    """補正後のランドマークで注釈画像を確定描画し、計測値とともに返す。"""
    data = request.get_json(silent=True) or {}
    image_b64 = data.get("image", "")
    analysis_type = data.get("analysis_type", "pelvis_tilt")
    landmarks = data.get("landmarks", [])
    mm_per_px = data.get("mm_per_px")

    if not image_b64 or not landmarks:
        return jsonify({"error": "画像またはランドマークがありません"}), 400

    try:
        image_bytes = base64.b64decode(image_b64.split(",")[-1])
    except Exception:
        return jsonify({"error": "画像のデコードに失敗しました"}), 400

    annotated, measurements = render_annotated(
        image_bytes, analysis_type, landmarks, mm_per_px
    )
    return jsonify({
        "image": "data:image/png;base64," + base64.b64encode(annotated).decode("utf-8"),
        "measurements": measurements,
    })


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
