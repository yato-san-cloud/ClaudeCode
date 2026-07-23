"""基本的な動作確認テスト。

実行: python3 tests/test_basic.py
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.referral_letter import generate_referral_pdf
from modules.xray_analyzer import (
    detect_landmarks, compute_measurements, render_annotated, patient_side,
    round_angle, round_mm,
)
from modules.xray_report import generate_xray_report_pdf, measurement_rows

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "static", "sample", "sample_pelvis.png")


def _sample_bytes():
    with open(SAMPLE, "rb") as f:
        return f.read()


def test_referral_pdf_is_valid():
    pdf = generate_referral_pdf({"patient_name": "山田太郎", "chief_complaint": "腰痛"})
    assert pdf.getvalue()[:4] == b"%PDF"


def test_referral_pdf_handles_long_text():
    long = "あ" * 800 + "\n" + "い" * 800
    pdf = generate_referral_pdf({
        "patient_name": "長文", "chief_complaint": long,
        "medical_history": long, "referral_reason": long,
    })
    assert pdf.getvalue()[:4] == b"%PDF"


def test_detect_landmarks_shapes():
    b = _sample_bytes()
    assert len(detect_landmarks(b, "pelvis_tilt")["landmarks"]) == 2
    assert len(detect_landmarks(b, "leg_length")["landmarks"]) == 2
    assert len(detect_landmarks(b, "spine_alignment")["landmarks"]) >= 3
    full = detect_landmarks(b, "pelvis_full")["landmarks"]
    assert {lm["id"] for lm in full} == {
        "left_femoral", "right_femoral", "left_iliac", "right_iliac",
        "left_ischium", "right_ischium", "symphysis", "s2",
    }


def test_unknown_type_falls_back_to_full():
    b = _sample_bytes()
    assert detect_landmarks(b, "nonsense")["analysis_type"] == "pelvis_full"


def test_patient_side_convention():
    # AP標準: 画面左 = 患者右
    assert patient_side(True, True) == "右"
    assert patient_side(False, True) == "左"
    assert patient_side(True, False) == "左"


def test_pelvis_full_measurements():
    b = _sample_bytes()
    lm = detect_landmarks(b, "pelvis_full")["landmarks"]
    m = compute_measurements(lm, "pelvis_full", mm_per_px=0.5)
    for key in ("fhl_tilt_deg", "femur_diff_px", "iliac_diff_px",
                "innominate_len_px", "innominate_diff_px", "pi_side",
                "symphysis_shift", "s2_shift", "rotation_warning",
                "clinical_summary"):
        assert key in m, key
    assert m["femur_diff_mm"] is not None
    assert m["symphysis_shift"]["side"] in ("右", "左", "中央")


def test_innominate_longer_side_is_pi():
    # 画面左の坐骨結節を大きく下げ、左寛骨を長く → 患者右(AP標準)がPI側
    b = _sample_bytes()
    lm = detect_landmarks(b, "pelvis_full")["landmarks"]
    by_id = {p["id"]: p for p in lm}
    by_id["left_ischium"]["y"] += 40   # 画面左の寛骨を縦に長く
    m = compute_measurements(lm, "pelvis_full", mm_per_px=0.5)
    assert m["pi_side"] == "右"          # 画面左＝患者右
    assert "右" in m["clinical_summary"]
    assert "PI" in m["clinical_summary"]


def test_positioning_caveat_in_note():
    b = _sample_bytes()
    lm = detect_landmarks(b, "pelvis_full")["landmarks"]
    m = compute_measurements(lm, "pelvis_full")
    assert "体位回旋" in m["analysis_note"]


def test_rotation_warning_flags_symphysis_shift():
    b = _sample_bytes()
    lm = detect_landmarks(b, "pelvis_full")["landmarks"]
    by_id = {p["id"]: p for p in lm}
    by_id["symphysis"]["x"] += 40   # 恥骨結合を中心線から大きくずらす
    m = compute_measurements(lm, "pelvis_full", mm_per_px=0.5)
    assert m["rotation_warning"] is True


def test_clinical_rounding_helpers():
    # 角度は0.5°刻み、長さは0.5mm刻み
    assert round_angle(2.51) == 2.5
    assert round_angle(2.8) == 3.0
    assert round_mm(3.9) == 4.0
    assert round_mm(3.1) == 3.0


def test_measurements_use_clinical_rounding():
    b = _sample_bytes()
    lm = detect_landmarks(b, "pelvis_full")["landmarks"]
    m = compute_measurements(lm, "pelvis_full", mm_per_px=0.5)
    # 角度は0.5刻み → 2倍して整数になる
    assert (m["fhl_tilt_deg"] * 2) == round(m["fhl_tilt_deg"] * 2)


def test_film_plane_note_when_calibrated():
    b = _sample_bytes()
    lm = detect_landmarks(b, "pelvis_full")["landmarks"]
    m = compute_measurements(lm, "pelvis_full", mm_per_px=0.5)
    assert "フィルム面" in m["analysis_note"]


def test_iliac_lower_side():
    # 画面左の腸骨稜を大きく下げる → 患者右(AP標準)が低位
    b = _sample_bytes()
    lm = detect_landmarks(b, "pelvis_full")["landmarks"]
    by_id = {p["id"]: p for p in lm}
    by_id["left_iliac"]["y"] += 60   # 画面左を大きく下げる = 患者右が低位
    by_id["right_iliac"]["y"] -= 20
    m = compute_measurements(lm, "pelvis_full", mm_per_px=0.5)
    assert m["iliac_lower_side"] == "右"


def test_measurement_changes_with_landmark_move():
    b = _sample_bytes()
    lm = detect_landmarks(b, "pelvis_tilt")["landmarks"]
    before = compute_measurements(lm, "pelvis_tilt")["tilt_angle_deg"]
    lm[1]["y"] += 50
    after = compute_measurements(lm, "pelvis_tilt")["tilt_angle_deg"]
    assert before != after


def test_calibration_gates_mm():
    b = _sample_bytes()
    lm = detect_landmarks(b, "pelvis_tilt")["landmarks"]
    assert compute_measurements(lm, "pelvis_tilt")["height_diff_mm"] is None
    assert compute_measurements(lm, "pelvis_tilt", mm_per_px=0.5)["height_diff_mm"] is not None


def test_render_annotated_returns_png():
    b = _sample_bytes()
    for atype in ("pelvis_full", "pelvis_tilt", "leg_length", "spine_alignment"):
        lm = detect_landmarks(b, atype)["landmarks"]
        img, m = render_annotated(b, atype, lm, 0.5)
        assert img[:8] == b"\x89PNG\r\n\x1a\n", atype
        assert m["calibrated"] is True


def test_render_with_filters_and_pa():
    b = _sample_bytes()
    lm = detect_landmarks(b, "pelvis_full")["landmarks"]
    img, m = render_annotated(
        b, "pelvis_full", lm,
        filters={"contrast": 1.4, "brightness": 0.9, "invert": True},
        ap_standard=False,
    )
    assert img[:8] == b"\x89PNG\r\n\x1a\n"
    assert "患者左" in m["convention"]


def test_xray_report_pdf():
    b = _sample_bytes()
    lm = detect_landmarks(b, "pelvis_full")["landmarks"]
    annotated, m = render_annotated(b, "pelvis_full", lm, 0.5)
    pdf = generate_xray_report_pdf({
        "patient": {"name": "山田太郎", "exam_date": "2026-07-01", "memo": "触診所見と一致。"},
        "clinic": {"name": "さくらカイロ", "practitioner": "佐藤"},
        "analysis_type": "pelvis_full",
        "measurements": m,
        "image_png": annotated,
    })
    assert pdf.getvalue()[:4] == b"%PDF"
    rows = measurement_rows(m, "pelvis_full")
    labels = [r[0] for r in rows]
    assert any("大腿骨頭ライン" in x for x in labels)
    assert any("恥骨結合" in x for x in labels)


def _make_dicom(photometric="MONOCHROME2", spacing=True):
    import numpy as np
    import cv2
    import pydicom
    from pydicom.dataset import Dataset, FileDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid

    h, w = 500, 420
    arr = np.full((h, w), 8000, np.uint16)
    cv2.ellipse(arr, (w // 2, int(h * 0.5)), (150, 95), 0, 0, 360, 22000, -1)
    cv2.circle(arr, (int(w * 0.35), int(h * 0.6)), 26, 32000, -1)
    cv2.circle(arr, (int(w * 0.65), int(h * 0.6)), 26, 32000, -1)
    wc = 20000
    if photometric == "MONOCHROME1":
        arr = 65535 - arr
        wc = 65535 - wc  # 反転データに合わせて窓中心も反転 (実データの挙動)

    meta = Dataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.1"
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\x00" * 128)
    ds.Modality = "CR"
    ds.BodyPartExamined = "PELVIS"
    ds.PhotometricInterpretation = photometric
    ds.SamplesPerPixel = 1
    ds.Rows = h
    ds.Columns = w
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.WindowCenter = wc
    ds.WindowWidth = 40000
    if spacing:
        ds.ImagerPixelSpacing = [0.143, 0.143]
    ds.PixelData = arr.tobytes()

    buf = io.BytesIO()
    ds.save_as(buf, write_like_original=False)
    return buf.getvalue()


def test_dicom_detected_and_loaded():
    from modules.dicom_loader import is_dicom, load_dicom
    data = _make_dicom()
    assert is_dicom(data)
    r = load_dicom(data)
    assert r["png"][:8] == b"\x89PNG\r\n\x1a\n"
    assert r["width"] == 420 and r["height"] == 500
    assert abs(r["mm_per_px"] - 0.143) < 1e-6
    assert r["spacing_source"] == "ImagerPixelSpacing"
    assert r["meta"]["body_part"] == "PELVIS"


def test_dicom_monochrome1_inverted():
    from modules.dicom_loader import load_dicom
    import numpy as np
    import cv2
    m2 = cv2.imdecode(np.frombuffer(load_dicom(_make_dicom("MONOCHROME2"))["png"], np.uint8), cv2.IMREAD_GRAYSCALE)
    m1 = cv2.imdecode(np.frombuffer(load_dicom(_make_dicom("MONOCHROME1"))["png"], np.uint8), cv2.IMREAD_GRAYSCALE)
    # MONOCHROME1は反転補正され、MONOCHROME2とほぼ同じ明暗になる
    assert abs(float(m2.mean()) - float(m1.mean())) < 25


def test_dicom_without_spacing_returns_none():
    from modules.dicom_loader import load_dicom
    r = load_dicom(_make_dicom(spacing=False))
    assert r["mm_per_px"] is None


def test_dicom_png_feeds_analyzer():
    from modules.dicom_loader import load_dicom
    png = load_dicom(_make_dicom())["png"]
    det = detect_landmarks(png, "pelvis_full")
    assert len(det["landmarks"]) == 8


def test_dicom_anisotropic_resampled_to_isotropic():
    from modules.dicom_loader import load_dicom
    import numpy as np, cv2, io
    import pydicom
    from pydicom.dataset import Dataset, FileDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid

    h, w = 400, 500
    arr = np.full((h, w), 8000, np.uint16)
    cv2.circle(arr, (w // 2, h // 2), 60, 30000, -1)
    meta = Dataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.1"
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\x00" * 128)
    ds.Modality = "CR"; ds.PhotometricInterpretation = "MONOCHROME2"
    ds.SamplesPerPixel = 1; ds.Rows = h; ds.Columns = w
    ds.BitsAllocated = 16; ds.BitsStored = 16; ds.HighBit = 15; ds.PixelRepresentation = 0
    ds.WindowCenter = 20000; ds.WindowWidth = 40000
    ds.ImagerPixelSpacing = [0.20, 0.14]  # row(y)=0.20, col(x)=0.14 非等方
    ds.PixelData = arr.tobytes()
    buf = io.BytesIO(); ds.save_as(buf, write_like_original=False)

    r = load_dicom(buf.getvalue())
    assert r["resampled_isotropic"] is True
    assert abs(r["mm_per_px"] - 0.14) < 1e-6      # 細かい方(col)が等方スケール
    assert r["width"] == 500                        # x はそのまま
    assert 565 <= r["height"] <= 575                # y を 0.20/0.14 倍に upsample


def test_dicom_uniform_image_no_nan():
    from modules.dicom_loader import _window_to_uint8
    import numpy as np

    class _DS:  # 窓情報なしの均一画像
        pass
    arr = np.full((10, 10), 1234, np.float32)
    out = _window_to_uint8(arr, _DS(), invert=False)
    assert out.dtype == np.uint8 and not np.isnan(out).any()


def test_simple_modes_gate_side_by_threshold():
    b = _sample_bytes()
    # pelvis_tilt: 2px差(未校正) → 同高
    lm = detect_landmarks(b, "pelvis_tilt")["landmarks"]
    d = {p["id"]: p for p in lm}
    d["left_iliac"]["y"] = 500
    d["right_iliac"]["y"] = 502
    assert compute_measurements(lm, "pelvis_tilt")["higher_side"] == "同高"
    # leg_length: 1px差 → 水平
    lm2 = detect_landmarks(b, "leg_length")["landmarks"]
    d2 = {p["id"]: p for p in lm2}
    d2["left_femoral"]["y"] = 600
    d2["right_femoral"]["y"] = 601
    assert compute_measurements(lm2, "leg_length")["lower_side"] == "水平"


def test_fhl_angle_is_acute_on_crossed_heads():
    b = _sample_bytes()
    lm = detect_landmarks(b, "pelvis_full")["landmarks"]
    d = {p["id"]: p for p in lm}
    d["left_femoral"]["x"] = 400; d["left_femoral"]["y"] = 300
    d["right_femoral"]["x"] = 100; d["right_femoral"]["y"] = 305  # x が交差
    assert compute_measurements(lm, "pelvis_full")["fhl_tilt_deg"] <= 90


def test_report_endpoints_harden_bad_input():
    import app as appmod
    c = appmod.app.test_client()
    b = _sample_bytes()
    import base64
    img = "data:image/png;base64," + base64.b64encode(b).decode()
    lm = detect_landmarks(b, "pelvis_full")["landmarks"]

    # patient/clinic が非dict、mm_per_px が文字列 → 500にならず正常処理 or 400
    r = c.post("/xray/report", json={
        "image": img, "analysis_type": "pelvis_full", "landmarks": lm,
        "mm_per_px": "not-a-number", "patient": "山田", "clinic": ["x"],
    })
    assert r.status_code in (200, 400), r.status_code

    # 壊れたランドマーク → 400 (500でない)
    r2 = c.post("/xray/export", json={
        "image": img, "analysis_type": "pelvis_full",
        "landmarks": [{"id": "left_femoral"}], "mm_per_px": None,
    })
    assert r2.status_code == 400, r2.status_code


def test_fmt_shift_missing_px():
    from modules.xray_report import _fmt_shift
    assert _fmt_shift({"side": "右"}) is None
    assert _fmt_shift({"px": 5.0, "mm": None, "side": "中央"}) is not None


def test_desktop_module_imports():
    """desktop.py が import エラーを出さずに起動可能なこと。"""
    import desktop
    assert hasattr(desktop, "main")
    assert hasattr(desktop, "_find_free_port")


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("PASS", fn.__name__)
    print("All %d tests passed" % len(fns))
