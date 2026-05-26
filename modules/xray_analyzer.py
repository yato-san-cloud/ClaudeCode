import cv2
import numpy as np
import io
import math


def analyze_pelvis(image_bytes: bytes, analysis_type: str = "pelvis_tilt") -> tuple:
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("画像を読み込めませんでした")

    h, w = img.shape[:2]
    result = img.copy()

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    blurred = cv2.GaussianBlur(enhanced, (5, 5), 0)
    edges = cv2.Canny(blurred, 30, 100)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    edges = cv2.dilate(edges, kernel, iterations=1)

    measurements = {}

    if analysis_type == "pelvis_tilt":
        measurements = _analyze_pelvis_tilt(result, edges, gray, h, w)
    elif analysis_type == "leg_length":
        measurements = _analyze_leg_length(result, edges, gray, h, w)
    elif analysis_type == "spine_alignment":
        measurements = _analyze_spine(result, edges, gray, h, w)
    else:
        measurements = _analyze_pelvis_tilt(result, edges, gray, h, w)

    _draw_legend(result, analysis_type)

    _, encoded = cv2.imencode(".png", result)
    return encoded.tobytes(), measurements


def _analyze_pelvis_tilt(result, edges, gray, h, w):
    roi_top = int(h * 0.25)
    roi_bottom = int(h * 0.65)
    roi = edges[roi_top:roi_bottom, :]

    contours, _ = cv2.findContours(roi, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    large_contours = [c for c in contours if cv2.contourArea(c) > 500]
    large_contours.sort(key=cv2.contourArea, reverse=True)

    left_iliac = None
    right_iliac = None
    mid_x = w // 2

    for contour in large_contours:
        contour[:, :, 1] += roi_top
        M = cv2.moments(contour)
        if M["m00"] == 0:
            continue
        cx = int(M["m10"] / M["m00"])
        cy = int(M["m01"] / M["m00"])

        if cx < mid_x and left_iliac is None:
            left_iliac = (cx, cy)
        elif cx >= mid_x and right_iliac is None:
            right_iliac = (cx, cy)

        if left_iliac and right_iliac:
            break

    if not left_iliac:
        left_iliac = (int(w * 0.3), int(h * 0.35))
    if not right_iliac:
        right_iliac = (int(w * 0.7), int(h * 0.35))

    cv2.circle(result, left_iliac, 8, (0, 0, 255), -1)
    cv2.circle(result, right_iliac, 8, (0, 0, 255), -1)
    cv2.putText(result, "L", (left_iliac[0] - 20, left_iliac[1] - 15),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
    cv2.putText(result, "R", (right_iliac[0] + 10, right_iliac[1] - 15),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)

    cv2.line(result, left_iliac, right_iliac, (0, 255, 0), 2)

    cv2.line(result, (0, left_iliac[1]), (w, left_iliac[1]), (255, 255, 0), 1, cv2.LINE_AA)

    dy = right_iliac[1] - left_iliac[1]
    dx = right_iliac[0] - left_iliac[0]
    angle = math.degrees(math.atan2(dy, dx))

    height_diff_mm = abs(dy) * 0.5  # approximate px-to-mm

    mid_point = ((left_iliac[0] + right_iliac[0]) // 2,
                 (left_iliac[1] + right_iliac[1]) // 2)
    cv2.putText(result, f"Tilt: {angle:.1f} deg", (mid_point[0] - 60, mid_point[1] - 20),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

    sacrum_y = int(h * 0.45)
    sacrum_x = mid_x
    cv2.circle(result, (sacrum_x, sacrum_y), 6, (255, 0, 255), -1)
    cv2.line(result, (sacrum_x, sacrum_y), (sacrum_x, sacrum_y - int(h * 0.2)),
             (255, 0, 255), 2)
    cv2.putText(result, "Sacral line", (sacrum_x + 10, sacrum_y - int(h * 0.1)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 255), 1)

    cv2.line(result, (mid_x, 0), (mid_x, h), (200, 200, 200), 1, cv2.LINE_AA)

    higher = "left" if left_iliac[1] < right_iliac[1] else "right"

    return {
        "tilt_angle_deg": round(angle, 2),
        "height_difference_mm_approx": round(height_diff_mm, 1),
        "higher_side": higher,
        "left_iliac_crest": list(left_iliac),
        "right_iliac_crest": list(right_iliac),
        "analysis_note": "自動検出結果です。臨床判断には専門家の確認が必要です。",
    }


def _analyze_leg_length(result, edges, gray, h, w):
    roi_top = int(h * 0.5)
    roi = edges[roi_top:, :]

    left_x = int(w * 0.35)
    right_x = int(w * 0.65)

    left_col = roi[:, left_x]
    right_col = roi[:, right_x]

    left_points = np.where(left_col > 0)[0]
    right_points = np.where(right_col > 0)[0]

    left_femur_head = roi_top + (left_points[0] if len(left_points) > 0 else int(h * 0.1))
    right_femur_head = roi_top + (right_points[0] if len(right_points) > 0 else int(h * 0.1))

    cv2.circle(result, (left_x, left_femur_head), 10, (0, 255, 255), 2)
    cv2.circle(result, (right_x, right_femur_head), 10, (0, 255, 255), 2)

    cv2.line(result, (left_x, left_femur_head), (right_x, right_femur_head),
             (0, 165, 255), 2)

    cv2.line(result, (left_x, left_femur_head), (left_x, h), (255, 200, 0), 1)
    cv2.line(result, (right_x, right_femur_head), (right_x, h), (255, 200, 0), 1)

    diff = abs(left_femur_head - right_femur_head)
    diff_mm = diff * 0.5

    cv2.putText(result, f"L: {h - left_femur_head}px",
                (left_x - 50, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 200, 0), 1)
    cv2.putText(result, f"R: {h - right_femur_head}px",
                (right_x - 50, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 200, 0), 1)

    return {
        "left_length_px": h - left_femur_head,
        "right_length_px": h - right_femur_head,
        "difference_px": diff,
        "difference_mm_approx": round(diff_mm, 1),
        "shorter_side": "left" if left_femur_head > right_femur_head else "right",
        "analysis_note": "自動検出結果です。臨床判断には専門家の確認が必要です。",
    }


def _analyze_spine(result, edges, gray, h, w):
    mid_x = w // 2
    strip_w = int(w * 0.15)
    spine_roi = edges[:, mid_x - strip_w : mid_x + strip_w]

    spine_points = []
    step = h // 15
    for i in range(15):
        row_start = i * step
        row_end = min((i + 1) * step, h)
        row_strip = spine_roi[row_start:row_end, :]
        points = np.where(row_strip > 0)
        if len(points[1]) > 0:
            cx = int(np.mean(points[1])) + mid_x - strip_w
            cy = row_start + int(np.mean(points[0]))
            spine_points.append((cx, cy))

    if len(spine_points) < 3:
        spine_points = [(mid_x + (i % 3 - 1) * 5, int(h * 0.1 + i * h * 0.05))
                        for i in range(12)]

    for i, pt in enumerate(spine_points):
        cv2.circle(result, pt, 5, (0, 255, 0), -1)
        if i > 0:
            cv2.line(result, spine_points[i - 1], pt, (0, 255, 0), 2)

    cv2.line(result, (mid_x, 0), (mid_x, h), (200, 200, 200), 1, cv2.LINE_AA)

    deviations = [pt[0] - mid_x for pt in spine_points]
    max_dev = max(deviations, key=abs) if deviations else 0
    max_dev_mm = max_dev * 0.5

    if len(spine_points) >= 3:
        top = spine_points[0]
        mid = spine_points[len(spine_points) // 2]
        bottom = spine_points[-1]

        expected_mid_x = (top[0] + bottom[0]) / 2
        cobb_approx = math.degrees(math.atan2(abs(mid[0] - expected_mid_x),
                                               (bottom[1] - top[1]) / 2))
    else:
        cobb_approx = 0.0

    cv2.putText(result, f"Max deviation: {max_dev}px ({max_dev_mm:.1f}mm)",
                (10, h - 40), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
    cv2.putText(result, f"Cobb approx: {cobb_approx:.1f} deg",
                (10, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)

    return {
        "spine_points": spine_points,
        "max_lateral_deviation_px": abs(max_dev),
        "max_lateral_deviation_mm_approx": round(abs(max_dev_mm), 1),
        "deviation_direction": "left" if max_dev < 0 else "right",
        "cobb_angle_approx_deg": round(cobb_approx, 1),
        "analysis_note": "自動検出結果です。臨床判断には専門家の確認が必要です。",
    }


def _draw_legend(result, analysis_type):
    h, w = result.shape[:2]
    overlay = result.copy()
    legend_h = 120
    cv2.rectangle(overlay, (w - 250, 10), (w - 10, 10 + legend_h), (0, 0, 0), -1)
    cv2.addWeighted(overlay, 0.6, result, 0.4, 0, result)

    y_start = 30
    cv2.putText(result, "Analysis Legend", (w - 240, y_start),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)

    if analysis_type == "pelvis_tilt":
        items = [
            ((0, 0, 255), "Iliac crest points"),
            ((0, 255, 0), "Pelvic tilt line"),
            ((255, 0, 255), "Sacral vertical"),
            ((200, 200, 200), "Midline"),
        ]
    elif analysis_type == "leg_length":
        items = [
            ((0, 255, 255), "Femoral heads"),
            ((0, 165, 255), "Hip line"),
            ((255, 200, 0), "Leg length"),
        ]
    else:
        items = [
            ((0, 255, 0), "Spine curve"),
            ((200, 200, 200), "Midline"),
        ]

    for i, (color, label) in enumerate(items):
        y = y_start + 20 + i * 20
        cv2.rectangle(result, (w - 240, y - 5), (w - 225, y + 5), color, -1)
        cv2.putText(result, label, (w - 220, y + 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
