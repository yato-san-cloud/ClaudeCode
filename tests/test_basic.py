"""基本的な動作確認テスト。

実行: python3 tests/test_basic.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.referral_letter import generate_referral_pdf
from modules.xray_analyzer import detect_landmarks, compute_measurements, render_annotated

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
    lm = detect_landmarks(b, "pelvis_tilt")["landmarks"]
    img, _ = render_annotated(b, "pelvis_tilt", lm, 0.5)
    assert img[:8] == b"\x89PNG\r\n\x1a\n"


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
