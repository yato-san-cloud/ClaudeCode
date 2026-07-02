"""骨盤・脊椎レントゲンのランドマーク検出と計測。

設計方針:
- detect_landmarks: 画像から基準点(ランドマーク)の初期位置を自動推定する。描画はしない。
- compute_measurements: ランドマーク座標から角度・距離を計算する(キャリブレーション対応)。
- render_annotated: 確定したランドマークで注釈画像を描画する。

自動検出はあくまで初期値。フロントで施術者がドラッグ補正し、確定した座標で
compute / render を呼ぶ「ヒューマン・イン・ザ・ループ」を前提にしている。

左右の表記について:
    正面(AP)像の標準表示では「画面の左 = 患者の右」。本モジュールの landmark id は
    画面座標基準 (left_* = 画面左) で固定し、表示・計測結果の側名は ap_standard
    フラグで患者側に変換する (ap_standard=False は PA など反転表示用)。
"""
import cv2
import numpy as np
import math

ANALYSIS_TYPES = ("pelvis_full", "pelvis_tilt", "leg_length", "spine_alignment")

# BGR描画色 (フロントSVGと対応: #16進はJS側)
C_FEMORAL = (255, 199, 0)    # #00c7ff 水色
C_ILIAC = (59, 59, 255)      # #ff3b3b 赤
C_SPINE = (80, 200, 80)      # #50c850 緑
C_MIDLINE = (200, 200, 200)  # #c8c8c8 灰
C_FHL = (0, 215, 255)        # #ffd700 金 (大腿骨頭ライン)
C_SYM = (255, 80, 255)       # #ff50ff 紫


def _decode(image_bytes):
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("画像を読み込めませんでした")
    return img


def _gray_enhanced(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return clahe.apply(gray)


def _edges(gray):
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 30, 100)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    return cv2.dilate(edges, kernel, iterations=1)


def patient_side(viewer_left: bool, ap_standard: bool = True) -> str:
    """画面上の左右を患者の左右に変換する。AP標準: 画面左 = 患者右。"""
    if ap_standard:
        return "右" if viewer_left else "左"
    return "左" if viewer_left else "右"


def apply_display_filters(img, filters):
    """明るさ/コントラスト/白黒反転。フロントの CSS filter と同一の式:
    out = brightness * (contrast * in + 127.5 * (1 - contrast)), その後 invert。
    """
    if not filters:
        return img
    a = float(filters.get("contrast", 1.0) or 1.0)
    k = float(filters.get("brightness", 1.0) or 1.0)
    a = min(max(a, 0.3), 3.0)
    k = min(max(k, 0.3), 3.0)
    out = cv2.convertScaleAbs(img, alpha=a * k, beta=127.5 * (1.0 - a) * k)
    if filters.get("invert"):
        out = 255 - out
    return out


# ==========================================================================
# ランドマーク検出 (初期値の推定)
# ==========================================================================
def detect_landmarks(image_bytes: bytes, analysis_type: str) -> dict:
    img = _decode(image_bytes)
    h, w = img.shape[:2]
    gray = _gray_enhanced(img)
    edges = _edges(gray)

    if analysis_type not in ANALYSIS_TYPES:
        analysis_type = "pelvis_full"

    if analysis_type == "pelvis_full":
        landmarks = _detect_pelvis_full(gray, edges, h, w)
    elif analysis_type == "leg_length":
        landmarks = _detect_femoral_heads(gray, edges, h, w)
    elif analysis_type == "spine_alignment":
        landmarks = _detect_spine(edges, h, w)
    else:
        landmarks = _detect_iliac_crests(edges, h, w)

    return {
        "analysis_type": analysis_type,
        "width": w,
        "height": h,
        "landmarks": landmarks,
    }


def _hough_femoral_pair(gray, h, w):
    """大腿骨頭は球形に近く円として写るため Hough 円検出を試みる。"""
    roi_top = int(h * 0.40)
    roi_bottom = int(h * 0.90)
    roi = cv2.GaussianBlur(gray[roi_top:roi_bottom, :], (7, 7), 2)
    try:
        circles = cv2.HoughCircles(
            roi, cv2.HOUGH_GRADIENT, dp=1.2, minDist=w * 0.20,
            param1=110, param2=28,
            minRadius=max(6, int(w * 0.035)), maxRadius=int(w * 0.13),
        )
    except cv2.error:
        return None
    if circles is None:
        return None

    mid_x = w / 2
    lefts, rights = [], []
    for cx, cy, r in circles[0]:
        item = (float(cx), float(cy) + roi_top, float(r))
        (lefts if cx < mid_x else rights).append(item)
    if not lefts or not rights:
        return None

    # 高さと半径が最も揃った左右ペアを選ぶ
    best, best_score = None, None
    for lx, ly, lr in lefts:
        for rx, ry, rr in rights:
            score = abs(ly - ry) + abs(lr - rr) * 2 + abs((mid_x - lx) - (rx - mid_x)) * 0.5
            if best_score is None or score < best_score:
                best_score, best = score, ((lx, ly), (rx, ry))
    return best


def _scan_femoral_fallback(edges, h, w):
    """フォールバック: 左右の代表列で最初に現れるエッジを骨頭上縁とみなす。"""
    roi_top = int(h * 0.5)
    roi = edges[roi_top:, :]

    def first_edge(col_x):
        col = roi[:, col_x]
        pts = np.where(col > 0)[0]
        return roi_top + (int(pts[0]) if len(pts) else int(h * 0.1))

    lx, rx = int(w * 0.35), int(w * 0.65)
    return (lx, first_edge(lx)), (rx, first_edge(rx))


def _detect_femoral_heads(gray, edges, h, w):
    pair = _hough_femoral_pair(gray, h, w)
    if pair is None:
        pair = _scan_femoral_fallback(edges, h, w)
    (lx, ly), (rx, ry) = pair
    return [
        {"id": "left_femoral", "label": "大腿骨頭(画面左)", "x": int(lx), "y": int(ly), "color": "#00c7ff"},
        {"id": "right_femoral", "label": "大腿骨頭(画面右)", "x": int(rx), "y": int(ry), "color": "#00c7ff"},
    ]


def _detect_iliac_crests(edges, h, w):
    """腸骨稜 = 骨盤上部で最も高い(上の)骨縁。左右の帯で上縁エッジを走査する。"""
    y0, y1 = int(h * 0.12), int(h * 0.60)

    def crest_in_band(x0, x1):
        band = edges[y0:y1, x0:x1]
        tops = []
        for col in range(band.shape[1]):
            ys = np.where(band[:, col] > 0)[0]
            if len(ys):
                tops.append((ys[0], col))
        if not tops:
            return (x0 + x1) // 2, int(h * 0.35)
        # ノイズ対策: 上端候補のうち上位25%の中央値を採る
        tops.sort(key=lambda t: t[0])
        take = tops[: max(3, len(tops) // 4)]
        ty = int(np.median([t[0] for t in take])) + y0
        tx = int(np.median([t[1] for t in take])) + x0
        return tx, ty

    lx, ly = crest_in_band(int(w * 0.18), int(w * 0.44))
    rx, ry = crest_in_band(int(w * 0.56), int(w * 0.82))
    return [
        {"id": "left_iliac", "label": "腸骨稜(画面左)", "x": lx, "y": ly, "color": "#ff3b3b"},
        {"id": "right_iliac", "label": "腸骨稜(画面右)", "x": rx, "y": ry, "color": "#ff3b3b"},
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


def _detect_pelvis_full(gray, edges, h, w):
    """Gonstead式 骨盤総合分析用の6点:
    大腿骨頭 左右 / 腸骨稜 左右 / 恥骨結合 / 第2仙骨結節(S2)。
    恥骨結合・S2 は個体差が大きいため妥当な初期位置のみ与え、補正前提とする。
    """
    femoral = _detect_femoral_heads(gray, edges, h, w)
    iliac = _detect_iliac_crests(edges, h, w)

    fl, fr = femoral[0], femoral[1]
    il, ir = iliac[0], iliac[1]
    mid_x = (fl["x"] + fr["x"]) // 2
    fem_y = (fl["y"] + fr["y"]) // 2
    crest_y = (il["y"] + ir["y"]) // 2

    symphysis = {"id": "symphysis", "label": "恥骨結合", "color": "#ff50ff",
                 "x": mid_x, "y": min(h - 5, int(fem_y + h * 0.04))}
    s2 = {"id": "s2", "label": "S2(第2仙骨結節)", "color": "#ff50ff",
          "x": mid_x, "y": int(crest_y + (fem_y - crest_y) * 0.45)}

    return femoral + iliac + [symphysis, s2]


# ==========================================================================
# 計測
# ==========================================================================
def compute_measurements(landmarks: list, analysis_type: str,
                         mm_per_px: float = None, ap_standard: bool = True) -> dict:
    """ランドマーク座標から計測値を算出。

    mm_per_px が None の場合は mm 換算せず px のみ返す(キャリブレーション未実施)。
    側名はすべて患者側 (ap_standard に従って変換)。
    """
    pts = {lm["id"]: (float(lm["x"]), float(lm["y"])) for lm in landmarks}

    def mm(px):
        return round(px * mm_per_px, 1) if mm_per_px else None

    convention = "AP標準（画面左＝患者右）" if ap_standard else "反転表示（画面左＝患者左）"
    note = "自動検出の初期値を施術者が確認・補正した結果を前提とした参考値です。"
    if not mm_per_px:
        note += " ※mm換算はスケール未設定のため未表示。"

    base = {"calibrated": bool(mm_per_px), "convention": convention, "analysis_note": note}

    if analysis_type == "pelvis_full":
        return {**_compute_pelvis_full(pts, mm, mm_per_px, ap_standard), **base}

    if analysis_type == "leg_length":
        l, r = pts["left_femoral"], pts["right_femoral"]
        diff_px = abs(l[1] - r[1])
        lower_viewer_left = l[1] > r[1]
        return {
            "vertical_diff_px": round(diff_px, 1),
            "vertical_diff_mm": mm(diff_px),
            "lower_side": patient_side(lower_viewer_left, ap_standard),
            **base,
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
            "deviation_direction": patient_side(max_dev < 0, ap_standard),
            "cobb_angle_approx_deg": round(cobb, 1),
            **base,
        }

    # pelvis_tilt
    l, r = pts["left_iliac"], pts["right_iliac"]
    dy, dx = r[1] - l[1], r[0] - l[0]
    angle = math.degrees(math.atan2(dy, dx))
    diff_px = abs(dy)
    return {
        "tilt_angle_deg": round(abs(angle), 2),
        "height_diff_px": round(diff_px, 1),
        "height_diff_mm": mm(diff_px),
        "higher_side": patient_side(l[1] < r[1], ap_standard),
        **base,
    }


def _fhl_frame(pts):
    """大腿骨頭ライン(FHL)の座標系。u=線方向(画面右向き), n=法線(画面上向き), M=中点。"""
    L = np.array(pts["left_femoral"])
    R = np.array(pts["right_femoral"])
    d = R - L
    norm = np.linalg.norm(d)
    u = d / norm if norm > 1e-6 else np.array([1.0, 0.0])
    n = np.array([u[1], -u[0]])
    if n[1] > 0:
        n = -n
    M = (L + R) / 2
    return L, R, u, n, M


def _compute_pelvis_full(pts, mm, mm_per_px, ap_standard):
    L, R, u, n, M = _fhl_frame(pts)

    # FHL傾斜: 画面右の骨頭が下 → 正
    tilt = math.degrees(math.atan2(R[1] - L[1], R[0] - L[0]))
    fem_diff = abs(R[1] - L[1])
    fem_lower_viewer_left = L[1] > R[1]

    # 腸骨稜高: FHLからの垂直距離 (Gonsteadの measured innominate 相当)
    hL = float(np.dot(np.array(pts["left_iliac"]) - M, n))
    hR = float(np.dot(np.array(pts["right_iliac"]) - M, n))
    iliac_diff = abs(hL - hR)
    iliac_higher_viewer_left = hL > hR

    # 側方偏位: FHL中点を通る垂直軸からの水平距離 (画面右向き正)
    s_sym = float(np.dot(np.array(pts["symphysis"]) - M, u))
    s_s2 = float(np.dot(np.array(pts["s2"]) - M, u))

    def shift(side_val):
        return {
            "px": round(abs(side_val), 1),
            "mm": mm(abs(side_val)),
            "side": patient_side(side_val < 0, ap_standard) if abs(side_val) > 0.5 else "中央",
        }

    result = {
        "fhl_tilt_deg": round(abs(tilt), 2),
        "fhl_lower_side": patient_side(fem_lower_viewer_left, ap_standard) if fem_diff > 0.5 else "水平",
        "femur_diff_px": round(fem_diff, 1),
        "femur_diff_mm": mm(fem_diff),
        "iliac_height_px": {
            patient_side(True, ap_standard): round(hL, 1),
            patient_side(False, ap_standard): round(hR, 1),
        },
        "iliac_diff_px": round(iliac_diff, 1),
        "iliac_diff_mm": mm(iliac_diff),
        "iliac_higher_side": patient_side(iliac_higher_viewer_left, ap_standard) if iliac_diff > 0.5 else "同高",
        "symphysis_shift": shift(s_sym),
        "s2_shift": shift(s_s2),
    }
    if mm_per_px:
        result["iliac_height_mm"] = {
            patient_side(True, ap_standard): mm(abs(hL)),
            patient_side(False, ap_standard): mm(abs(hR)),
        }
    return result


# ==========================================================================
# 注釈画像の描画
# ==========================================================================
def render_annotated(image_bytes: bytes, analysis_type: str, landmarks: list,
                     mm_per_px: float = None, filters: dict = None,
                     ap_standard: bool = True) -> tuple:
    img = apply_display_filters(_decode(image_bytes), filters)
    h, w = img.shape[:2]
    result = img.copy()
    pts = {lm["id"]: (int(round(float(lm["x"]))), int(round(float(lm["y"])))) for lm in landmarks}
    m = compute_measurements(landmarks, analysis_type, mm_per_px, ap_standard)

    sw = max(1, round(max(h, w) / 500))  # 線幅を解像度に追従させる
    fs = max(0.45, max(h, w) / 1400)     # 文字も同様

    _draw_rl_markers(result, w, h, ap_standard, fs)

    if analysis_type == "pelvis_full":
        _render_pelvis_full(result, pts, m, h, w, sw, fs)
    elif analysis_type == "leg_length":
        _render_leg_length(result, pts, m, h, w, sw, fs)
    elif analysis_type == "spine_alignment":
        _render_spine(result, pts, landmarks, m, h, w, sw, fs)
    else:
        _render_pelvis_tilt(result, pts, m, h, w, sw, fs)

    ok, encoded = cv2.imencode(".png", result)
    return encoded.tobytes(), m


def _pt(a):
    return int(round(float(a[0]))), int(round(float(a[1])))


def _line_along(img, origin, direction, color, sw, dashed=False):
    """origin を通り direction 方向の直線を画像端まで描く。"""
    o = np.array(origin, dtype=float)
    d = np.array(direction, dtype=float)
    p1 = _pt(o - d * 5000)
    p2 = _pt(o + d * 5000)
    if dashed:
        _dashed_line(img, p1, p2, color, sw)
    else:
        cv2.line(img, p1, p2, color, sw, cv2.LINE_AA)


def _dashed_line(img, p1, p2, color, sw, dash=14):
    p1 = np.array(p1, dtype=float)
    p2 = np.array(p2, dtype=float)
    length = np.linalg.norm(p2 - p1)
    if length < 1:
        return
    d = (p2 - p1) / length
    t = 0.0
    while t < length:
        a = p1 + d * t
        b = p1 + d * min(t + dash, length)
        cv2.line(img, _pt(a), _pt(b), color, sw, cv2.LINE_AA)
        t += dash * 2


def _label_text(img, text, org, fs, color=(255, 255, 255)):
    x, y = int(org[0]), int(org[1])
    cv2.putText(img, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, fs, (0, 0, 0),
                max(3, int(fs * 5)), cv2.LINE_AA)
    cv2.putText(img, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, fs, color,
                max(1, int(fs * 2)), cv2.LINE_AA)


def _draw_rl_markers(img, w, h, ap_standard, fs):
    left_mark = "R" if ap_standard else "L"
    right_mark = "L" if ap_standard else "R"
    _label_text(img, left_mark, (int(w * 0.03), int(h * 0.08)), fs * 2.2)
    _label_text(img, right_mark, (int(w * 0.93), int(h * 0.08)), fs * 2.2)


def _marker(img, p, color, sw, r=None):
    r = int(r or sw * 5)
    cv2.circle(img, p, r, (255, 255, 255), sw + 1, cv2.LINE_AA)
    cv2.circle(img, p, r, color, sw, cv2.LINE_AA)
    cv2.drawMarker(img, p, color, cv2.MARKER_CROSS, r * 2, max(1, sw // 2), cv2.LINE_AA)


def _fmt(px_val, mm_val, unit_suffix=""):
    if mm_val is not None:
        return f"{mm_val}mm{unit_suffix}"
    return f"{px_val}px{unit_suffix}"


def _render_pelvis_full(result, pts, m, h, w, sw, fs):
    npts = {k: np.array(v, dtype=float) for k, v in pts.items()}
    L, R = npts["left_femoral"], npts["right_femoral"]
    d = R - L
    norm = np.linalg.norm(d)
    u = d / norm if norm > 1e-6 else np.array([1.0, 0.0])
    n = np.array([u[1], -u[0]])
    if n[1] > 0:
        n = -n
    M = (L + R) / 2

    # 基準線: FHL + 垂直軸
    _line_along(result, M, u, C_FHL, sw)
    _line_along(result, M, n, C_MIDLINE, max(1, sw - 1), dashed=True)

    # 大腿骨頭
    head_r = int(w * 0.045)
    for key in ("left_femoral", "right_femoral"):
        p = pts[key]
        cv2.circle(result, p, head_r, C_FEMORAL, sw, cv2.LINE_AA)
        cv2.drawMarker(result, p, C_FEMORAL, cv2.MARKER_CROSS, sw * 8, sw, cv2.LINE_AA)

    # 腸骨稜: 点 + FHLへの垂線(計測線) + クレストライン
    for key in ("left_iliac", "right_iliac"):
        P = npts[key]
        foot = P - np.dot(P - M, n) * n
        _dashed_line(result, _pt(P), _pt(foot), C_ILIAC, max(1, sw - 1))
        seg = u * w * 0.09
        cv2.line(result, _pt(P - seg), _pt(P + seg), C_ILIAC, sw, cv2.LINE_AA)
        _marker(result, pts[key], C_ILIAC, sw)

    # 恥骨結合 / S2: 垂直軸への水平距離
    for key in ("symphysis", "s2"):
        P = npts[key]
        foot = P - np.dot(P - M, u) * u
        _dashed_line(result, _pt(P), _pt(foot), C_SYM, max(1, sw - 1))
        _marker(result, pts[key], C_SYM, sw)

    # 数値ラベル
    _label_text(result, f"FHL {m['fhl_tilt_deg']}deg",
                M + u * w * 0.16 + n * h * 0.02, fs, C_FHL)
    _label_text(result, "diff " + _fmt(m["iliac_diff_px"], m["iliac_diff_mm"]),
                npts["left_iliac"] + np.array([w * 0.02, -h * 0.015]), fs, C_ILIAC)
    _label_text(result, "SP " + _fmt(m["symphysis_shift"]["px"], m["symphysis_shift"]["mm"]),
                npts["symphysis"] + np.array([w * 0.02, h * 0.03]), fs, C_SYM)
    _label_text(result, "S2 " + _fmt(m["s2_shift"]["px"], m["s2_shift"]["mm"]),
                npts["s2"] + np.array([w * 0.02, -h * 0.01]), fs, C_SYM)
    _label_text(result, "FH " + _fmt(m["femur_diff_px"], m["femur_diff_mm"]),
                M + u * (-w * 0.24) + n * h * 0.02, fs, C_FEMORAL)


def _render_pelvis_tilt(result, pts, m, h, w, sw, fs):
    l, r = pts["left_iliac"], pts["right_iliac"]
    for p in (l, r):
        _marker(result, p, C_ILIAC, sw)
    cv2.line(result, l, r, (0, 200, 0), sw, cv2.LINE_AA)
    _dashed_line(result, (0, l[1]), (w, l[1]), (0, 215, 255), max(1, sw - 1))
    cv2.line(result, (w // 2, 0), (w // 2, h), C_MIDLINE, max(1, sw - 1), cv2.LINE_AA)
    txt = f"tilt {m['tilt_angle_deg']}deg  diff " + _fmt(m["height_diff_px"], m["height_diff_mm"])
    _label_text(result, txt,
                ((l[0] + r[0]) // 2 - int(w * 0.12), min(l[1], r[1]) - int(h * 0.03)), fs)


def _render_leg_length(result, pts, m, h, w, sw, fs):
    l, r = pts["left_femoral"], pts["right_femoral"]
    for p in (l, r):
        cv2.circle(result, p, int(w * 0.045), C_FEMORAL, sw, cv2.LINE_AA)
        cv2.drawMarker(result, p, C_FEMORAL, cv2.MARKER_CROSS, sw * 8, sw, cv2.LINE_AA)
        _dashed_line(result, p, (p[0], h), (255, 200, 0), max(1, sw - 1))
    cv2.line(result, l, r, (0, 165, 255), sw, cv2.LINE_AA)
    txt = "FH diff " + _fmt(m["vertical_diff_px"], m["vertical_diff_mm"]) + f"  low:{m['lower_side']}"
    _label_text(result, txt,
                ((l[0] + r[0]) // 2 - int(w * 0.14), max(l[1], r[1]) + int(h * 0.06)), fs)


def _render_spine(result, pts, landmarks, m, h, w, sw, fs):
    ordered = [pts[lm["id"]] for lm in sorted(landmarks, key=lambda lm: float(lm["y"]))]
    for i, p in enumerate(ordered):
        cv2.circle(result, p, sw * 3, C_SPINE, -1, cv2.LINE_AA)
        if i:
            cv2.line(result, ordered[i - 1], p, C_SPINE, sw, cv2.LINE_AA)
    _dashed_line(result, ordered[0], ordered[-1], C_MIDLINE, max(1, sw - 1))
    txt = ("dev " + _fmt(m["max_deviation_px"], m["max_deviation_mm"])
           + f"  Cobb~{m['cobb_angle_approx_deg']}deg")
    _label_text(result, txt, (int(w * 0.05), h - int(h * 0.04)), fs)


# --------------------------------------------------------------------------
# 後方互換: 自動検出 → 注釈までを一括 (旧API)
# --------------------------------------------------------------------------
def analyze_pelvis(image_bytes: bytes, analysis_type: str = "pelvis_tilt") -> tuple:
    det = detect_landmarks(image_bytes, analysis_type)
    return render_annotated(image_bytes, det["analysis_type"], det["landmarks"])
