"""DICOM (.dcm) レントゲンの読み込み。

臨床現場の実X線はほぼDICOM形式で、以下を扱えることがプロ用途の要件:
- 圧縮転送構文 (JPEG / JPEG2000 / RLE) のデコード
- VOI LUT / Window-Level を適用した診断向けの階調
- MONOCHROME1 (白黒逆) / カラー(RGB/YBR/PALETTE) の正規化
- マルチフレームの先頭フレーム抽出
- PixelSpacing からの自動スケール取得。非等方(row≠col)は等方へリサンプル

方針: DICOMを 8bit グレースケールPNG に正規化して返し、以降は通常画像と同じ
経路に載せる。mm_per_px が取れた場合は同時に返し、自動キャリブレーションに使う。
"""
import io

import numpy as np


def is_dicom(data: bytes) -> bool:
    """DICOMか判定。標準は 128byte preamble + 'DICM'。preamble無しは実読込で確認。"""
    if len(data) >= 132 and data[128:132] == b"DICM":
        return True
    # preamble無しDICOM: 先頭グループが 0002/0008 で始まることが多い。安価な前段フィルタ
    if data[:2] not in (b"\x02\x00", b"\x08\x00"):
        return False
    # 実際に読めるか (pixel も group2 も無いものは弾く)
    try:
        import pydicom
        ds = pydicom.dcmread(io.BytesIO(data), force=True, stop_before_pixels=True)
        return bool(getattr(ds, "SOPClassUID", None) or "PixelData" in ds
                    or getattr(ds, "Modality", None))
    except Exception:
        return False


def _first(v):
    if v is None:
        return None
    if isinstance(v, str):
        return float(v)
    if hasattr(v, "__iter__"):
        return float(next(iter(v)))
    return float(v)


def _window_to_uint8(arr, ds, invert):
    """VOI LUT / Window-Level を適用し 0-255 に正規化する。invert=True で白黒反転。"""
    arr = arr.astype(np.float32)

    slope = float(getattr(ds, "RescaleSlope", 1) or 1)
    intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
    if slope != 1 or intercept != 0:
        arr = arr * slope + intercept

    windowed = None

    # 1) 明示的な VOI LUT Sequence (非線形階調) → 適用し min-max で 0-255 へ
    if getattr(ds, "VOILUTSequence", None):
        apply_voi_lut = None
        try:
            from pydicom.pixels import apply_voi_lut  # pydicom 3.x
        except Exception:
            try:
                from pydicom.pixel_data_handlers.util import apply_voi_lut
            except Exception:
                apply_voi_lut = None
        if apply_voi_lut is not None:
            try:
                v = np.asarray(apply_voi_lut(arr, ds), dtype=np.float32)
                lo, hi = float(v.min()), float(v.max())
                if hi > lo:
                    windowed = (v - lo) / (hi - lo) * 255.0
            except Exception:
                windowed = None

    # 2) Window Center/Width の線形窓 (最も一般的。自前計算で確実に 0-255 へ)
    if windowed is None:
        wc = _first(getattr(ds, "WindowCenter", None))
        ww = _first(getattr(ds, "WindowWidth", None))
        if wc is not None and ww is not None:
            if ww < 1:
                ww = 1
            lo, hi = wc - ww / 2, wc + ww / 2
            windowed = np.clip((arr - lo) / (hi - lo), 0, 1) * 255.0

    # 3) パーセンタイルの min-max (窓情報が無い場合)。均一画像は 0 に落とす
    if windowed is None:
        lo, hi = np.percentile(arr, 0.5), np.percentile(arr, 99.5)
        if hi <= lo:
            lo, hi = float(arr.min()), float(arr.max())
        if hi <= lo:
            windowed = np.zeros_like(arr)          # 均一画像: NaN を避ける
        else:
            windowed = np.clip((arr - lo) / (hi - lo), 0, 1) * 255.0

    out = np.clip(np.nan_to_num(windowed), 0, 255).astype(np.uint8)
    if invert:
        out = 255 - out
    return out


def _to_intensity(ds):
    """pixel_array を 2D の強度配列にし、(arr, invert) を返す。
    マルチフレーム/カラー/パレットを吸収する。"""
    import cv2
    arr = ds.pixel_array
    photometric = str(getattr(ds, "PhotometricInterpretation", "")).upper()

    # 先頭フレームへ (frames, H, W[, C]) の先頭次元を畳む
    while arr.ndim > 3:
        arr = arr[0]

    if photometric == "PALETTE COLOR":
        try:
            try:
                from pydicom.pixels import apply_color_lut
            except Exception:
                from pydicom.pixel_data_handlers.util import apply_color_lut
            rgb = np.asarray(apply_color_lut(arr, ds))
            gray = cv2.cvtColor(_as_u8(rgb[..., :3]), cv2.COLOR_RGB2GRAY)
            return gray.astype(np.float32), False
        except Exception:
            # LUT 失敗時はインデックスをそのまま強度扱い (最悪でも黒画は避ける)
            return arr.astype(np.float32), False

    if arr.ndim == 3 and arr.shape[-1] in (3, 4):
        rgb = arr[..., :3]
        if photometric.startswith("YBR"):
            try:
                try:
                    from pydicom.pixels import convert_color_space
                except Exception:
                    from pydicom.pixel_data_handlers.util import convert_color_space
                rgb = convert_color_space(arr[..., :3], photometric, "RGB")
            except Exception:
                pass
        gray = cv2.cvtColor(_as_u8(rgb), cv2.COLOR_RGB2GRAY)
        return gray.astype(np.float32), False

    if arr.ndim == 3:
        arr = arr[0]  # マルチフレーム グレースケール

    return arr, (photometric == "MONOCHROME1")


def _as_u8(rgb):
    rgb = np.asarray(rgb)
    if rgb.dtype == np.uint8:
        return rgb
    lo, hi = float(rgb.min()), float(rgb.max())
    if hi <= lo:
        return np.zeros(rgb.shape, np.uint8)
    return ((rgb.astype(np.float32) - lo) / (hi - lo) * 255).astype(np.uint8)


def _pixel_spacing(ds):
    """(row_spacing, col_spacing, source) を返す。DICOMの並びは [row(y), col(x)]。"""
    for attr in ("ImagerPixelSpacing", "PixelSpacing"):
        val = getattr(ds, attr, None)
        if val is None:
            continue
        try:
            row = float(val[0])
            col = float(val[1]) if len(val) > 1 else row
            if row > 0 and col > 0:
                return row, col, attr
        except (TypeError, ValueError, IndexError):
            continue
    return None, None, None


def load_dicom(data: bytes) -> dict:
    """DICOMバイト列を読み、グレースケールPNG(bytes) と メタ情報を返す。

    非等方 PixelSpacing の場合は等方へリサンプルし、リサンプル後の mm/px を返す
    (横方向のスケール誤りと画像の歪みを防ぐ)。
    """
    import cv2
    import pydicom

    ds = pydicom.dcmread(io.BytesIO(data), force=True)
    arr, invert = _to_intensity(ds)
    img8 = _window_to_uint8(arr, ds, invert)
    if img8.ndim != 2:
        img8 = img8[..., 0]
    h, w = img8.shape[:2]

    row, col, source = _pixel_spacing(ds)
    mm_per_px = None
    if row and col:
        target = min(row, col)
        if abs(row - col) / max(row, col) > 0.01:
            # 等方化: 各画素が target[mm] 四方になるようリサンプル
            sx, sy = col / target, row / target
            img8 = cv2.resize(img8, (max(1, round(w * sx)), max(1, round(h * sy))),
                              interpolation=cv2.INTER_AREA)
            h, w = img8.shape[:2]
        mm_per_px = round(target, 4)

    ok, enc = cv2.imencode(".png", img8)
    if not ok:
        raise ValueError("DICOMのPNG変換に失敗しました")

    def _s(attr):
        v = getattr(ds, attr, None)
        return str(v) if v is not None else ""

    return {
        "png": enc.tobytes(),
        "width": int(w),
        "height": int(h),
        "mm_per_px": mm_per_px,
        "spacing_source": source,
        "resampled_isotropic": bool(row and col and abs(row - col) / max(row, col) > 0.01),
        "meta": {
            "modality": _s("Modality"),
            "body_part": _s("BodyPartExamined"),
            "study_date": _s("StudyDate"),
            "view_position": _s("ViewPosition"),
            "photometric": _s("PhotometricInterpretation"),
        },
    }
