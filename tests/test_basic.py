"""基本的な動作確認テスト。

実行: python3 tests/test_basic.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.referral_letter import generate_referral_pdf
from modules.xray_analyzer import (
    detect_landmarks, compute_measurements, render_annotated, patient_side,
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
        "left_femoral", "right_femoral", "left_iliac", "right_iliac", "symphysis", "s2",
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
                "symphysis_shift", "s2_shift", "iliac_height_px"):
        assert key in m, key
    assert m["femur_diff_mm"] is not None
    assert m["symphysis_shift"]["side"] in ("右", "左", "中央")


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
