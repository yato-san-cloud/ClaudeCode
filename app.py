import os
import json
import io
import base64
from datetime import datetime
from flask import Flask, render_template, request, send_file, jsonify
from modules.referral_letter import generate_referral_pdf
from modules.xray_analyzer import analyze_pelvis

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/referral", methods=["GET", "POST"])
def referral():
    if request.method == "POST":
        form_data = {
            "patient_name": request.form.get("patient_name", ""),
            "patient_name_kana": request.form.get("patient_name_kana", ""),
            "patient_dob": request.form.get("patient_dob", ""),
            "patient_gender": request.form.get("patient_gender", ""),
            "patient_address": request.form.get("patient_address", ""),
            "patient_phone": request.form.get("patient_phone", ""),
            "chief_complaint": request.form.get("chief_complaint", ""),
            "symptom_duration": request.form.get("symptom_duration", ""),
            "symptom_location": request.form.get("symptom_location", ""),
            "pain_level": request.form.get("pain_level", ""),
            "medical_history": request.form.get("medical_history", ""),
            "current_medications": request.form.get("current_medications", ""),
            "referral_reason": request.form.get("referral_reason", ""),
            "clinic_name": request.form.get("clinic_name", ""),
            "chiropractor_name": request.form.get("chiropractor_name", ""),
            "clinic_address": request.form.get("clinic_address", ""),
            "clinic_phone": request.form.get("clinic_phone", ""),
            "destination_hospital": request.form.get("destination_hospital", ""),
        }

        pdf_buffer = generate_referral_pdf(form_data)
        return send_file(
            pdf_buffer,
            mimetype="application/pdf",
            as_attachment=True,
            download_name=f"紹介状_{form_data['patient_name']}_{datetime.now().strftime('%Y%m%d')}.pdf",
        )

    return render_template("referral.html")


@app.route("/xray", methods=["GET", "POST"])
def xray():
    if request.method == "POST":
        if "xray_image" not in request.files:
            return jsonify({"error": "画像がアップロードされていません"}), 400

        file = request.files["xray_image"]
        if file.filename == "":
            return jsonify({"error": "ファイルが選択されていません"}), 400

        image_bytes = file.read()
        analysis_type = request.form.get("analysis_type", "pelvis_tilt")

        result_image, measurements = analyze_pelvis(image_bytes, analysis_type)

        result_b64 = base64.b64encode(result_image).decode("utf-8")

        return jsonify(
            {
                "image": result_b64,
                "measurements": measurements,
            }
        )

    return render_template("xray.html")


@app.route("/api/google-form-webhook", methods=["POST"])
def google_form_webhook():
    """Google Formの回答をWebhookで受け取り、紹介状PDFを生成するエンドポイント"""
    data = request.get_json()
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

    form_data = {}
    for jp_key, en_key in field_mapping.items():
        form_data[en_key] = data.get(jp_key, "")

    form_data.setdefault("clinic_name", "")
    form_data.setdefault("chiropractor_name", "")
    form_data.setdefault("clinic_address", "")
    form_data.setdefault("clinic_phone", "")
    form_data.setdefault("destination_hospital", "")

    pdf_buffer = generate_referral_pdf(form_data)

    return send_file(
        pdf_buffer,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=f"紹介状_{form_data.get('patient_name', '不明')}_{datetime.now().strftime('%Y%m%d')}.pdf",
    )


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
