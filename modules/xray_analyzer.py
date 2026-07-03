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
C_ISCHIUM = (74, 162, 255)   # #ffa24a 橙 (坐骨結節/寛骨長)


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


# 臨床的に意味のある丸め。X線の拡大率・ポジショニング・点の手置き誤差を
# 考えると、角度0.01°やmm0.1のような桁は過剰精度（硬派な術者ほど嫌う）。
# 角度は0.5°、長さは0.5mm刻みに丸め、道具が身の丈を分かっている状態にする。
# JS(Math.round)と一致させるため half-up で丸める(Python標準roundは偶数丸め)。
# 計測値は非負(絶対差・角度)なので floor(x+0.5) で十分。
def round_angle(deg: float) -> float:
    return math.floor(deg * 2 + 0.5) / 2


def round_mm(mm_val: float) -> float:
    return math.floor(mm_val * 2 + 0.5) / 2


def _significant(diff_px: float, mm_per_px) -> bool:
    """左右差が臨床的に有意か。校正時は表示と同じ丸めで mm≥5、未校正は 3px フロア。"""
    if mm_per_px:
        return round_mm(diff_px * mm_per_px) >= 5.0
    return diff_px >= 3.0


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
    """大腿骨頭は球形に近く円として写るため Hough 円検出を試みる。
    実X線で検証済みのパラメータを用いる(過度に緩めると仙骨等の偽円を拾うため)。"""
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


def _blob_femoral_pair(gray, h, w):
    """明るい高密度ブロブの重心で大腿骨頭を推定する。円形度で選抜し、
    取れない側は代表列位置にフォールバックするため常に (L, R) を返す。"""
    roi_top, roi_bot = int(h * 0.48), int(h * 0.90)
    roi = gray[roi_top:roi_bot, :]
    thr = np.percentile(roi, 80)
    _, bw = cv2.threshold(roi, int(thr), 255, cv2.THRESH_BINARY)
    bw = cv2.morphologyEx(bw, cv2.MORPH_OPEN,
                          cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    mid_x = w // 2
    exp_area = math.pi * (w * 0.055) ** 2
    rmin, rmax = w * 0.03, w * 0.16

    def pick(x0, x1):
        sub = np.zeros_like(bw)
        sub[:, x0:x1] = bw[:, x0:x1]
        cnts, _ = cv2.findContours(sub, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        best, best_score = None, None
        for c in cnts:
            a = cv2.contourArea(c)
            if a < exp_area * 0.2:
                continue
            (_cx, _cy), rad = cv2.minEnclosingCircle(c)
            if not (rmin <= rad <= rmax):
                continue
            circ = a / (math.pi * rad * rad + 1e-6)
            score = circ - abs(a - exp_area) / exp_area * 0.2
            M = cv2.moments(c)
            if M["m00"] == 0:
                continue
            if best_score is None or score > best_score:
                best_score = score
                best = (M["m10"] / M["m00"], M["m01"] / M["m00"] + roi_top)
        return best

    left = pick(int(w * 0.18), mid_x) or (w * 0.35, h * 0.60)
    right = pick(mid_x, int(w * 0.82)) or (w * 0.65, h * 0.60)
    return left, right


def _detect_femoral_heads(gray, edges, h, w):
    """大腿骨頭検出。原理的な Hough を優先し(実X線で信頼できる)、Hough が
    円ペアを得られない画像でのみ明るいブロブ重心にフォールバックする。
    ブロブは中央の高密度構造(仙骨等)を拾い得るため、上書きには使わない。"""
    pair = _hough_femoral_pair(gray, h, w)
    if pair is None:
        pair = _blob_femoral_pair(gray, h, w)
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
    """Gonstead式 骨盤総合分析用の8点:
    大腿骨頭 左右 / 腸骨稜 左右 / 坐骨結節 左右 / 恥骨結合 / 第2仙骨結節(S2)。

    坐骨結節・恥骨結合・S2 は個体差が大きく自動検出が不安定なため、
    解剖学的な妥当位置を初期値として与え、術者の補正を前提とする。
    """
    femoral = _detect_femoral_heads(gray, edges, h, w)
    iliac = _detect_iliac_crests(edges, h, w)

    fl, fr = femoral[0], femoral[1]
    il, ir = iliac[0], iliac[1]
    mid_x = (fl["x"] + fr["x"]) // 2
    fem_y = (fl["y"] + fr["y"]) // 2
    crest_y = (il["y"] + ir["y"]) // 2

    # 坐骨結節: 大腿骨頭の下方やや内側。最下点付近を初期値に。
    def ischium(fx, fy):
        return int(fx + (mid_x - fx) * 0.25), int(min(h - 3, fy + h * 0.07))

    lix, liy = ischium(fl["x"], fl["y"])
    rix, riy = ischium(fr["x"], fr["y"])
    ischia = [
        {"id": "left_ischium", "label": "坐骨結節(画面左)", "x": lix, "y": liy, "color": "#ffa24a"},
        {"id": "right_ischium", "label": "坐骨結節(画面右)", "x": rix, "y": riy, "color": "#ffa24a"},
    ]

    symphysis = {"id": "symphysis", "label": "恥骨結合", "color": "#ff50ff",
                 "x": mid_x, "y": min(h - 5, int(fem_y + h * 0.04))}
    s2 = {"id": "s2", "label": "S2(第2仙骨結節)", "color": "#ff50ff",
          "x": mid_x, "y": int(crest_y + (fem_y - crest_y) * 0.45)}

    return femoral + iliac + ischia + [symphysis, s2]


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
        return round_mm(px * mm_per_px) if mm_per_px else None

    convention = "AP標準（画面左＝患者右）" if ap_standard else "反転表示（画面左＝患者左）"
    note = "自動検出の初期値を施術者が確認・補正した前提の参考値です。"
    if mm_per_px:
        note += " mm値はフィルム面上の実測で、撮影拡大率は未補正です。"
    else:
        note += " スケール未設定のためpx表示です。"
    if analysis_type in ("pelvis_full", "pelvis_tilt", "leg_length"):
        note += ("　骨盤計測は撮影時の体位回旋に敏感で、数度の回旋がmm単位の差を生むこと"
                 "が報告されています（Weinert 2005 ほか）。良好なポジショニングの像でご判断ください。")

    base = {"calibrated": bool(mm_per_px), "convention": convention, "analysis_note": note}

    if analysis_type == "pelvis_full":
        return {**_compute_pelvis_full(pts, mm, mm_per_px, ap_standard), **base}

    if analysis_type == "leg_length":
        l, r = pts["left_femoral"], pts["right_femoral"]
        diff_px = abs(l[1] - r[1])
        lower = (patient_side(l[1] > r[1], ap_standard)
                 if _significant(diff_px, mm_per_px) else "水平")
        return {
            "vertical_diff_px": round(diff_px, 1),
            "vertical_diff_mm": mm(diff_px),
            "lower_side": lower,
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
            "cobb_angle_approx_deg": round_angle(cobb),
            **base,
        }

    # pelvis_tilt
    l, r = pts["left_iliac"], pts["right_iliac"]
    dy, dx = r[1] - l[1], r[0] - l[0]
    angle = math.degrees(math.atan2(abs(dy), abs(dx)))  # 水平からの鋭角
    diff_px = abs(dy)
    higher = (patient_side(l[1] < r[1], ap_standard)
              if _significant(diff_px, mm_per_px) else "同高")
    return {
        "tilt_angle_deg": round_angle(angle),
        "height_diff_px": round(diff_px, 1),
        "height_diff_mm": mm(diff_px),
        "higher_side": higher,
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
    """Gonstead本式に沿った計測。

    基準軸は「真の水平（フィルム端）」。ローリング定規をフィルム端に平行に
    当てる本式に倣い、大腿骨頭・腸骨稜の高さ、寛骨長はすべて画像の縦(y)で測る。
    PI/AS判定は寛骨垂直長（腸骨稜→坐骨結節）の左右差に基づき、長い側=PI。
    """
    Lf, Rf = pts["left_femoral"], pts["right_femoral"]
    Li, Ri = pts["left_iliac"], pts["right_iliac"]
    Lis, Ris = pts["left_ischium"], pts["right_ischium"]
    mid_x = (Lf[0] + Rf[0]) / 2

    # 有意差しきい値 (校正時 mm≥5 / 未校正 3px フロア) は _significant に集約。
    def significant(diff_px):
        return _significant(diff_px, mm_per_px)

    # 大腿骨頭高低差 (真の水平基準 = 画像y差) → 低位側 = 短下肢(MD)側。
    # 反転/交差入力でも水平からの鋭角を返す (|dy|,|dx| で第1象限に畳む)。
    tilt = math.degrees(math.atan2(abs(Rf[1] - Lf[1]), abs(Rf[0] - Lf[0])))
    fem_diff = abs(Lf[1] - Rf[1])
    fhl_low = patient_side(Lf[1] > Rf[1], ap_standard) if significant(fem_diff) else "水平"

    # 腸骨稜高低差 (真の水平基準) → 低位側
    iliac_diff = abs(Li[1] - Ri[1])
    iliac_low = patient_side(Li[1] > Ri[1], ap_standard) if significant(iliac_diff) else "同高"

    # 寛骨垂直長 (腸骨稜→坐骨結節, 真の縦距離)。長い側 = PI, 短い側 = AS
    innom_L = abs(Lis[1] - Li[1])
    innom_R = abs(Ris[1] - Ri[1])
    innom_diff = abs(innom_L - innom_R)
    longer_viewer_left = innom_L > innom_R
    if significant(innom_diff):
        pi_side = patient_side(longer_viewer_left, ap_standard)
        as_side = patient_side(not longer_viewer_left, ap_standard)
    else:
        pi_side = as_side = None

    # 側方偏位 (垂直中心線 = 大腿骨頭中点を通る鉛直線からの水平ずれ)
    s_sym = float(pts["symphysis"][0] - mid_x)
    s_s2 = float(pts["s2"][0] - mid_x)

    def shift(side_val):
        return {
            "px": round(abs(side_val), 1),
            "mm": mm(abs(side_val)),
            "side": patient_side(side_val < 0, ap_standard) if significant(abs(side_val)) else "中央",
        }

    sym_shift = shift(s_sym)
    s2_shift = shift(s_s2)

    # 所見サマリ: PI/AS は寛骨長差に基づく「目安」まで。断定しない。
    if pi_side:
        summary = (f"寛骨垂直長は患者{pi_side}側が長い → 同側PI寛骨の目安"
                   f"（対側{as_side}はAS傾向）。")
        # 大腿骨頭低位側との整合（PIは短下肢側に出やすい）
        if fhl_low in ("右", "左"):
            if fhl_low == pi_side:
                summary += f" 大腿骨頭も{fhl_low}低位で短下肢側と一致。"
            else:
                summary += f" ただし大腿骨頭低位は{fhl_low}側で不一致（要確認）。"
    else:
        summary = "寛骨垂直長の左右差は僅少（有意差なし）。"

    # 回旋の警告: 恥骨結合/S2の偏位が大きいと、体位回旋が高さ計測を歪める
    rotation_warn = bool(sym_shift["side"] in ("右", "左") or s2_shift["side"] in ("右", "左"))
    if rotation_warn:
        summary += " ※恥骨結合/S2に偏位あり。体位回旋が高さ計測に影響している可能性。"

    result = {
        "fhl_tilt_deg": round_angle(abs(tilt)),
        "fhl_lower_side": fhl_low,
        "femur_diff_px": round(fem_diff, 1),
        "femur_diff_mm": mm(fem_diff),
        "iliac_diff_px": round(iliac_diff, 1),
        "iliac_diff_mm": mm(iliac_diff),
        "iliac_lower_side": iliac_low,
        "innominate_len_px": {
            patient_side(True, ap_standard): round(innom_L, 1),
            patient_side(False, ap_standard): round(innom_R, 1),
        },
        "innominate_diff_px": round(innom_diff, 1),
        "innominate_diff_mm": mm(innom_diff),
        "pi_side": pi_side or "左右差なし",
        "symphysis_shift": sym_shift,
        "s2_shift": s2_shift,
        "rotation_warning": rotation_warn,
        "clinical_summary": summary,
    }
    if mm_per_px:
        result["innominate_len_mm"] = {
            patient_side(True, ap_standard): mm(innom_L),
            patient_side(False, ap_standard): mm(innom_R),
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
        return f"{mm_val:g}mm{unit_suffix}"
    return f"{px_val:g}px{unit_suffix}"


def _render_pelvis_full(result, pts, m, h, w, sw, fs):
    """Gonstead本式の作図: 真の水平を基準に、大腿骨頭線・腸骨稜の水平参照線・
    寛骨長(腸骨稜→坐骨結節)・垂直中心線を描く。"""
    Lf, Rf = pts["left_femoral"], pts["right_femoral"]
    mid_x = (Lf[0] + Rf[0]) // 2
    thin = max(1, sw - 1)

    # 大腿骨頭線 + 各頭の水平参照線 (真の水平)
    cv2.line(result, Lf, Rf, C_FHL, sw, cv2.LINE_AA)
    _dashed_line(result, (0, Lf[1]), (w, Lf[1]), C_FHL, thin)
    _dashed_line(result, (0, Rf[1]), (w, Rf[1]), C_FHL, thin)

    # 垂直中心線 (大腿骨頭中点を通る鉛直線)
    cv2.line(result, (mid_x, 0), (mid_x, h), C_MIDLINE, thin, cv2.LINE_AA)

    # 大腿骨頭
    head_r = int(w * 0.045)
    for key in ("left_femoral", "right_femoral"):
        p = pts[key]
        cv2.circle(result, p, head_r, C_FEMORAL, sw, cv2.LINE_AA)
        cv2.drawMarker(result, p, C_FEMORAL, cv2.MARKER_CROSS, sw * 8, sw, cv2.LINE_AA)

    # 腸骨稜: 各稜の水平参照線 + マーカー
    for key in ("left_iliac", "right_iliac"):
        P = pts[key]
        _dashed_line(result, (0, P[1]), (w, P[1]), C_ILIAC, thin)
        _marker(result, P, C_ILIAC, sw)

    # 寛骨垂直長: 腸骨稜→坐骨結節の縦線 + 坐骨結節マーカー
    for ic, isk in (("left_iliac", "left_ischium"), ("right_iliac", "right_ischium")):
        cv2.line(result, pts[ic], pts[isk], C_ISCHIUM, sw, cv2.LINE_AA)
        _marker(result, pts[isk], C_ISCHIUM, sw)

    # 恥骨結合 / S2: 中心線への水平距離
    for key in ("symphysis", "s2"):
        P = pts[key]
        cv2.line(result, P, (mid_x, P[1]), C_SYM, thin, cv2.LINE_AA)
        _marker(result, P, C_SYM, sw)

    # 数値ラベル
    _label_text(result, f"FHL {m['fhl_tilt_deg']:g}°",
                (mid_x + int(w * 0.03), (Lf[1] + Rf[1]) // 2 - int(h * 0.015)), fs, C_FHL)
    _label_text(result, "Crest " + _fmt(m["iliac_diff_px"], m["iliac_diff_mm"]),
                (pts["left_iliac"][0] + int(w * 0.02), pts["left_iliac"][1] - int(h * 0.015)), fs, C_ILIAC)
    _label_text(result, "Innom " + _fmt(m["innominate_diff_px"], m["innominate_diff_mm"]),
                (pts["left_ischium"][0] - int(w * 0.15), pts["left_ischium"][1]), fs, C_ISCHIUM)
    _label_text(result, "Sym " + _fmt(m["symphysis_shift"]["px"], m["symphysis_shift"]["mm"]),
                (pts["symphysis"][0] + int(w * 0.02), pts["symphysis"][1] + int(h * 0.03)), fs, C_SYM)
    _label_text(result, "S2 " + _fmt(m["s2_shift"]["px"], m["s2_shift"]["mm"]),
                (pts["s2"][0] + int(w * 0.02), pts["s2"][1] - int(h * 0.01)), fs, C_SYM)


def _render_pelvis_tilt(result, pts, m, h, w, sw, fs):
    l, r = pts["left_iliac"], pts["right_iliac"]
    for p in (l, r):
        _marker(result, p, C_ILIAC, sw)
    cv2.line(result, l, r, (0, 200, 0), sw, cv2.LINE_AA)
    _dashed_line(result, (0, l[1]), (w, l[1]), (0, 215, 255), max(1, sw - 1))
    cv2.line(result, (w // 2, 0), (w // 2, h), C_MIDLINE, max(1, sw - 1), cv2.LINE_AA)
    txt = f"{m['tilt_angle_deg']:g}°  " + _fmt(m["height_diff_px"], m["height_diff_mm"])
    _label_text(result, txt,
                ((l[0] + r[0]) // 2 - int(w * 0.12), min(l[1], r[1]) - int(h * 0.03)), fs)


def _render_leg_length(result, pts, m, h, w, sw, fs):
    l, r = pts["left_femoral"], pts["right_femoral"]
    for p in (l, r):
        cv2.circle(result, p, int(w * 0.045), C_FEMORAL, sw, cv2.LINE_AA)
        cv2.drawMarker(result, p, C_FEMORAL, cv2.MARKER_CROSS, sw * 8, sw, cv2.LINE_AA)
        _dashed_line(result, p, (p[0], h), (255, 200, 0), max(1, sw - 1))
    cv2.line(result, l, r, (0, 165, 255), sw, cv2.LINE_AA)
    txt = "Head " + _fmt(m["vertical_diff_px"], m["vertical_diff_mm"]) + f"  low:{m['lower_side']}"
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
           + f"  Cobb~{m['cobb_angle_approx_deg']:g}°")
    _label_text(result, txt, (int(w * 0.05), h - int(h * 0.04)), fs)


# --------------------------------------------------------------------------
# 後方互換: 自動検出 → 注釈までを一括 (旧API)
# --------------------------------------------------------------------------
def analyze_pelvis(image_bytes: bytes, analysis_type: str = "pelvis_tilt") -> tuple:
    det = detect_landmarks(image_bytes, analysis_type)
    return render_annotated(image_bytes, det["analysis_type"], det["landmarks"])
