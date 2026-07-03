"""自動検出の品質を合成骨盤バッテリーで測る回帰テスト。

大腿骨頭・腸骨稜の真値を既知にして、detect_landmarks の初期値がどれだけ当たるかを
対角長に対する誤差割合で評価する。閾値は現状性能に十分な余裕を持たせ、
大きな劣化(回帰)を検出する番犬として機能させる。

注意: これは合成画像での指標であり、実X線での精度を保証するものではない。
実機での最終調整は実際のフィルムを用いて行う前提。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import cv2

from modules.xray_analyzer import detect_landmarks


def _synth_pelvis(w, h, rng, tilt=0.0, contrast=1.0, noise=8.0, crest_dy=0.0):
    """真値つき合成骨盤 X線。返り値: (png_bytes, ground_truth_dict)。"""
    img = np.full((h, w), 40, np.float32)

    r = int(w * 0.055)
    fl = (int(w * 0.36), int(h * 0.60 + tilt * h))
    fr = (int(w * 0.64), int(h * 0.60 - tilt * h))
    for c in (fl, fr):
        cv2.circle(img, c, r, 210, -1)
        cv2.circle(img, c, int(r * 0.6), 150, -1)

    cv2.ellipse(img, (w // 2, int(h * 0.5)), (int(w * 0.30), int(h * 0.17)),
                0, 0, 360, 110, -1)

    crest_l = (int(w * 0.28), int(h * 0.26 + crest_dy * h))
    crest_r = (int(w * 0.72), int(h * 0.26 - crest_dy * h))
    ptsL = np.array([[int(w * 0.42), int(h * 0.34)], crest_l, [int(w * 0.20), int(h * 0.36)],
                     [int(w * 0.26), int(h * 0.52)], [int(w * 0.44), int(h * 0.50)]], np.int32)
    ptsR = np.array([[int(w * 0.58), int(h * 0.34)], crest_r, [int(w * 0.80), int(h * 0.36)],
                     [int(w * 0.74), int(h * 0.52)], [int(w * 0.56), int(h * 0.50)]], np.int32)
    cv2.fillPoly(img, [ptsL], 130)
    cv2.fillPoly(img, [ptsR], 130)
    cv2.polylines(img, [ptsL], True, 170, 2)
    cv2.polylines(img, [ptsR], True, 170, 2)

    for i in range(4):
        yy = int(h * 0.10 + i * h * 0.05)
        cv2.rectangle(img, (int(w / 2 - w * 0.03), yy),
                      (int(w / 2 + w * 0.03), yy + int(h * 0.035)), 120, -1)

    img = np.clip((img - 127.5) * contrast + 127.5, 0, 255)
    img = np.clip(img + rng.normal(0, noise, (h, w)), 0, 255).astype(np.uint8)
    img = cv2.GaussianBlur(img, (3, 3), 0)
    png = cv2.imencode(".png", cv2.cvtColor(img, cv2.COLOR_GRAY2BGR))[1].tobytes()
    return png, {"left_femoral": fl, "right_femoral": fr,
                 "left_iliac": crest_l, "right_iliac": crest_r}


_SIZES = [(500, 600), (900, 1100), (1400, 1700)]
_CONDS = [
    dict(tilt=0.0, contrast=1.0, noise=8, crest_dy=0.0),
    dict(tilt=0.02, contrast=1.0, noise=8, crest_dy=0.01),
    dict(tilt=-0.03, contrast=0.7, noise=14, crest_dy=-0.015),
    dict(tilt=0.01, contrast=1.4, noise=20, crest_dy=0.02),
    dict(tilt=0.0, contrast=0.6, noise=6, crest_dy=0.0),
]


def _run_battery():
    rng = np.random.default_rng(42)
    fem, crest = [], []
    for (w, h) in _SIZES:
        for c in _CONDS:
            png, gt = _synth_pelvis(w, h, rng, **c)
            det = detect_landmarks(png, "pelvis_full")
            d = {l["id"]: (l["x"], l["y"]) for l in det["landmarks"]}
            diag = (w ** 2 + h ** 2) ** 0.5
            for k in ("left_femoral", "right_femoral"):
                fem.append(((d[k][0] - gt[k][0]) ** 2 + (d[k][1] - gt[k][1]) ** 2) ** 0.5 / diag)
            for k in ("left_iliac", "right_iliac"):
                crest.append(((d[k][0] - gt[k][0]) ** 2 + (d[k][1] - gt[k][1]) ** 2) ** 0.5 / diag)
    return np.array(fem), np.array(crest)


def test_femoral_head_detection_accuracy():
    fem, _ = _run_battery()
    # 現状 mean~0.012 / max~0.057。余裕をもって回帰を検出する番犬。
    assert fem.mean() < 0.05, f"femoral mean error regressed: {fem.mean():.3f}"
    assert fem.max() < 0.10, f"femoral max error regressed: {fem.max():.3f}"


def test_iliac_crest_detection_accuracy():
    _, crest = _run_battery()
    # 腸骨稜は上縁走査で相対的に難しい。gross な破綻のみ検出。
    assert crest.mean() < 0.11, f"crest mean error regressed: {crest.mean():.3f}"
    assert crest.max() < 0.20, f"crest max error regressed: {crest.max():.3f}"


if __name__ == "__main__":
    fem, crest = _run_battery()
    print(f"femoral: mean={fem.mean():.3f} p90={np.percentile(fem, 90):.3f} max={fem.max():.3f}")
    print(f"crest  : mean={crest.mean():.3f} p90={np.percentile(crest, 90):.3f} max={crest.max():.3f}")
    test_femoral_head_detection_accuracy()
    test_iliac_crest_detection_accuracy()
    print("detection quality OK")
