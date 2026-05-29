"""骨盤・脊椎レントゲンのランドマーク検出と計測。

設計方針:
- detect_landmarks: 画像から基準点(ランドマーク)を自動推定して返す。描画はしない。
- compute_measurements: ランドマーク座標から角度・距離を計算する(キャリブレーション対応)。
- render_annotated: (ユーザー補正後の)ランドマークで注釈画像を描画する。

自動検出はあくまで初期値。フロントで施術者がドラッグ補正し、確定した座標で
compute / render を呼ぶ「ヒューマン・イン・ザ・ループ」を前提にしている。
"""
import cv2
import numpy as np
import math

# 表示色 (フロントのSVGと合わせるため16進も併記)
COLORS = {
    "iliac": (59, 59, 255),       # 赤  #ff3b3b
    "femoral": (255, 199, 0),     # 水  #00c7ff (BGR)
    "spine": (80, 200, 80),       # 緑  #50c850
    "line": (0, 200, 0),
    "guide": (200, 200, 200),
}


def _decode(image_bytes):
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("画像を読み込めませんでした")
    return img


def _edges(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    blurred = cv2.GaussianBlur(enhanced, (5, 5), 0)
    edges = cv2.Canny(blurred, 30, 100)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    return cv2.dilate(edges, kernel, iterations=1)


# --------------------------------------------------------------------------
# ランドマーク検出 (初期値の推定)
# --------------------------------------------------------------------------
def detect_landmarks(image_bytes: bytes, analysis_type: str) -> dict:
    img = _decode(image_bytes)
    h, w = img.shape[:2]
    edges = _edges(img)

    if analysis_type == "leg_length":
        landmarks = _detect_femoral_heads(edges, h, w)
        ltype = "points"
    elif analysis_type == "spine_alignment":
        landmarks = _detect_spine(edges, h, w)
        ltype = "polyline"
    else:
        analysis_type = "pelvis_tilt"
        landmarks = _detect_iliac_crests(edges, h, w)
        ltype = "points"

    return {
        "analysis_type": analysis_type,
        "landmark_type": ltype,
        "width": w,
        "height": h,
        "midline_x": w // 2,
        "landmarks": landmarks,
    }


def _detect_iliac_crests(edges, h, w):
    roi_top, roi_bottom = int(h * 0.25), int(h * 0.65)
    roi = edges[roi_top:roi_bottom, :]
    contours, _ = cv2.findContours(roi, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    large = sorted((c for c in contours if cv2.contourArea(c) > 500),
                   key=cv2.contourArea, reverse=True)

    mid_x = w // 2
    left = right = None
    for c in large:
        c[:, :, 1] += roi_top
        M = cv2.moments(c)
        if M["m00"] == 0:
            continue
        cx, cy = int(M["m10"] / M["m00"]), int(M["m01"] / M["m00"])
        if cx < mid_x and left is None:
            left = (cx, cy)
        elif cx >= mid_x and right is None:
            right = (cx, cy)
        if left and right:
            break

    left = left or (int(w * 0.30), int(h * 0.35))
    right = right or (int(w * 0.70), int(h * 0.35))
    return [
        {"id": "left_iliac", "label": "左腸骨稜", "x": left[0], "y": left[1], "color": "#ff3b3b"},
        {"id": "right_iliac", "label": "右腸骨稜", "x": right[0], "y": right[1], "color": "#ff3b3b"},
    ]


def _detect_femoral_heads(edges, h, w):
    roi_top = int(h * 0.5)
    roi = edges[roi_top:, :]
    left_x, right_x = int(w * 0.35), int(w * 0.65)

    def first_edge(col_x):
        col = roi[:, col_x]
        pts = np.where(col > 0)[0]
        return roi_top + (int(pts[0]) if len(pts) else int(h * 0.1))

    return [
        {"id": "left_femoral", "label": "左大腿骨頭", "x": left_x, "y": first_edge(left_x), "color": "#00c7ff"},
        {"id": "right_femoral", "label": "右大腿骨頭", "x": right_x, "y": first_edge(right_x), "color": "#00c7ff"},
    ]


def _detect_spine(edges, h, w):
    mid_x = w // 2
    strip = int(w * 0.15)
    spine_roi = edges[:, mid_x - strip: mid_x + strip]

    pts = []
    n = 7
    step = h // n
    for i in range(n):
        r0, r1 = i * step, min((i + 1) * step, h)
        band = spine_roi[r0:r1, :]
        ys, xs = np.where(band > 0)
        if len(xs):
            cx = int(np.mean(xs)) + mid_x - strip
            cy = r0 + int(np.mean(ys))
        else:
            cx, cy = mid_x, r0 + step // 2
        pts.append((cx, cy))

    return [
        {"id": f"spine_{i}", "label": f"椎体{i + 1}", "x": p[0], "y": p[1], "color": "#50c850"}
        for i, p in enumerate(pts)
    ]


# --------------------------------------------------------------------------
# 計測 (キャリブレーション対応)
# --------------------------------------------------------------------------
def compute_measurements(landmarks: list, analysis_type: str,
                         mm_per_px: float = None, midline_x: float = None) -> dict:
    """ランドマーク座標から計測値を算出。

    mm_per_px が None の場合は mm 換算せず px のみ返す(キャリブレーション未実施)。
    """
    pts = {lm["id"]: (float(lm["x"]), float(lm["y"])) for lm in landmarks}

    def mm(px):
        return round(px * mm_per_px, 1) if mm_per_px else None

    note = "自動検出の初期値です。基準点を確認・補正のうえご判断ください。"
    if not mm_per_px:
        note += " ※mm換算はスケール未設定のため未表示。"

    if analysis_type == "leg_length":
        l, r = pts["left_femoral"], pts["right_femoral"]
        diff_px = abs(l[1] - r[1])
        return {
            "vertical_diff_px": round(diff_px, 1),
            "vertical_diff_mm": mm(diff_px),
            "lower_side": "左" if l[1] > r[1] else "右",
            "calibrated": bool(mm_per_px),
            "analysis_note": note,
        }

    if analysis_type == "spine_alignment":
        ordered = sorted(((lm["id"], pts[lm["id"]]) for lm in landmarks),
                         key=lambda kv: kv[1][1])
        coords = [c for _, c in ordered]
        top, bottom = coords[0], coords[-1]
        axis_x = (top[0] + bottom[0]) / 2
        devs = [c[0] - axis_x for c in coords]
        max_dev = max(devs, key=abs) if devs else 0.0
        mid = coords[len(coords) // 2]
        half_h = max((bottom[1] - top[1]) / 2, 1)
        cobb = math.degrees(math.atan2(abs(mid[0] - axis_x), half_h))
        return {
            "max_deviation_px": round(abs(max_dev), 1),
            "max_deviation_mm": mm(abs(max_dev)),
            "deviation_direction": "左" if max_dev < 0 else "右",
            "cobb_angle_approx_deg": round(cobb, 1),
            "calibrated": bool(mm_per_px),
            "analysis_note": note,
        }

    # pelvis_tilt
    l, r = pts["left_iliac"], pts["right_iliac"]
    dy, dx = r[1] - l[1], r[0] - l[0]
    angle = math.degrees(math.atan2(dy, dx))
    diff_px = abs(dy)
    return {
        "tilt_angle_deg": round(angle, 2),
        "height_diff_px": round(diff_px, 1),
        "height_diff_mm": mm(diff_px),
        "higher_side": "左" if l[1] < r[1] else "右",
        "calibrated": bool(mm_per_px),
        "analysis_note": note,
    }


# --------------------------------------------------------------------------
# 注釈画像の描画 (確定したランドマークで)
# --------------------------------------------------------------------------
def render_annotated(image_bytes: bytes, analysis_type: str,
                     landmarks: list, mm_per_px: float = None) -> tuple:
    img = _decode(image_bytes)
    h, w = img.shape[:2]
    result = img.copy()
    pts = {lm["id"]: (int(round(float(lm["x"]))), int(round(float(lm["y"])))) for lm in landmarks}
    m = compute_measurements(landmarks, analysis_type, mm_per_px, w // 2)

    if analysis_type == "leg_length":
        l, r = pts["left_femoral"], pts["right_femoral"]
        for p in (l, r):
            cv2.circle(result, p, 10, COLORS["femoral"], 2)
            cv2.line(result, (p[0], p[1]), (p[0], h), COLORS["femoral"], 1, cv2.LINE_AA)
        cv2.line(result, l, r, (0, 165, 255), 2)
        _label(result, l, "L"), _label(result, r, "R")
        txt = f"diff: {m['vertical_diff_px']}px"
        if m["vertical_diff_mm"] is not None:
            txt += f" / {m['vertical_diff_mm']}mm"
        _caption(result, txt)

    elif analysis_type == "spine_alignment":
        ordered = [pts[lm["id"]] for lm in sorted(landmarks, key=lambda lm: float(lm["y"]))]
        for i, p in enumerate(ordered):
            cv2.circle(result, p, 5, COLORS["spine"], -1)
            if i:
                cv2.line(result, ordered[i - 1], p, COLORS["spine"], 2)
        top, bottom = ordered[0], ordered[-1]
        cv2.line(result, top, bottom, COLORS["guide"], 1, cv2.LINE_AA)
        txt = f"max dev: {m['max_deviation_px']}px"
        if m["max_deviation_mm"] is not None:
            txt += f" / {m['max_deviation_mm']}mm"
        txt += f"  Cobb~{m['cobb_angle_approx_deg']}deg"
        _caption(result, txt)

    else:  # pelvis_tilt
        l, r = pts["left_iliac"], pts["right_iliac"]
        for p in (l, r):
            cv2.circle(result, p, 8, COLORS["iliac"], -1)
        cv2.line(result, l, r, COLORS["line"], 2)
        cv2.line(result, (0, l[1]), (w, l[1]), (255, 255, 0), 1, cv2.LINE_AA)
        cv2.line(result, (w // 2, 0), (w // 2, h), COLORS["guide"], 1, cv2.LINE_AA)
        _label(result, l, "L"), _label(result, r, "R")
        txt = f"tilt: {m['tilt_angle_deg']}deg"
        if m["height_diff_mm"] is not None:
            txt += f"  diff: {m['height_diff_mm']}mm"
        _caption(result, txt)

    ok, encoded = cv2.imencode(".png", result)
    return encoded.tobytes(), m


def _label(img, p, text):
    cv2.putText(img, text, (p[0] + 10, p[1] - 12),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)


def _caption(img, text):
    h, w = img.shape[:2]
    overlay = img.copy()
    cv2.rectangle(overlay, (8, h - 34), (8 + 11 * len(text), h - 8), (0, 0, 0), -1)
    cv2.addWeighted(overlay, 0.55, img, 0.45, 0, img)
    cv2.putText(img, text, (14, h - 15),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1)


# --------------------------------------------------------------------------
# 後方互換: 自動検出 → 注釈までを一括 (旧API)
# --------------------------------------------------------------------------
def analyze_pelvis(image_bytes: bytes, analysis_type: str = "pelvis_tilt") -> tuple:
    det = detect_landmarks(image_bytes, analysis_type)
    return render_annotated(image_bytes, det["analysis_type"], det["landmarks"])
