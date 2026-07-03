"""DICOM (.dcm) レントゲンの読み込み。

臨床現場の実X線はほぼDICOM形式で、以下を扱えることがプロ用途の要件:
- 圧縮転送構文 (JPEG / JPEG2000 / RLE) のデコード
- VOI LUT / Window-Level を適用した診断向けの階調
- MONOCHROME1 (白黒逆) の正規化
- PixelSpacing からの自動スケール取得 (mm/px) → キャリブレーション不要

方針: DICOMを 8bit PNG に正規化して返し、以降は通常画像と同じ経路に載せる。
mm_per_px が取れた場合は同時に返し、フロントで自動キャリブレーションに使う。
"""
import io

import numpy as np


def is_dicom(data: bytes) -> bool:
    """DICOMか判定。標準は 128byte preamble + 'DICM'。preamble無しにも一応対応。"""
    if len(data) < 132:
        return False
    if data[128:132] == b"DICM":
        return True
    # preamble無しDICOM: 先頭が group 0002/0008 のリトルエンディアンで始まることが多い
    return data[:4] in (b"\x02\x00\x00\x00", b"\x08\x00\x00\x00", b"\x08\x00\x05\x00")


def _window_to_uint8(arr, ds):
    """VOI LUT / Window-Level を適用し 0-255 に正規化する。"""
    arr = arr.astype(np.float32)

    # Rescale slope/intercept (CT等。X線でも稀に存在)
    slope = float(getattr(ds, "RescaleSlope", 1) or 1)
    intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
    if slope != 1 or intercept != 0:
        arr = arr * slope + intercept

    def _first(v):
        if v is None:
            return None
        if isinstance(v, str):
            return float(v)
        if hasattr(v, "__iter__"):
            return float(next(iter(v)))
        return float(v)

    windowed = None

    # 1) 明示的な VOI LUT Sequence (非線形階調) がある場合のみ適用し、min-maxで0-255へ正規化
    if getattr(ds, "VOILUTSequence", None):
        try:
            from pydicom.pixel_data_handlers.util import apply_voi_lut
            v = apply_voi_lut(arr, ds).astype(np.float32)
            lo, hi = float(v.min()), float(v.max())
            if hi > lo:
                windowed = (v - lo) / (hi - lo) * 255.0
        except Exception:
            windowed = None

    # 2) Window Center/Width の線形窓 (最も一般的。自前計算で確実に0-255へ)
    if windowed is None:
        wc = _first(getattr(ds, "WindowCenter", None))
        ww = _first(getattr(ds, "WindowWidth", None))
        if wc is not None and ww is not None:
            if ww < 1:
                ww = 1
            lo, hi = wc - ww / 2, wc + ww / 2
            windowed = np.clip((arr - lo) / (hi - lo), 0, 1) * 255.0

    # 3) パーセンタイルの min-max (窓情報が無い場合)
    if windowed is None:
        lo, hi = np.percentile(arr, 0.5), np.percentile(arr, 99.5)
        if hi <= lo:
            lo, hi = float(arr.min()), float(arr.max() or 1)
        windowed = np.clip((arr - lo) / (hi - lo), 0, 1) * 255.0

    out = np.clip(windowed, 0, 255).astype(np.uint8)

    # MONOCHROME1 は「値が大きいほど暗い」→ 通常表示に合わせて反転
    if str(getattr(ds, "PhotometricInterpretation", "")).upper() == "MONOCHROME1":
        out = 255 - out
    return out


def _pixel_spacing_mm_per_px(ds):
    """mm/px を取得。優先: ImagerPixelSpacing > PixelSpacing。無ければ None。

    注: 検出器面のスペーシングであり、被写体の拡大率は未補正 (実運用上の限界)。
    """
    for attr in ("ImagerPixelSpacing", "PixelSpacing"):
        val = getattr(ds, attr, None)
        if val is not None:
            try:
                row = float(val[0])
                if row > 0:
                    return row, attr
            except (TypeError, ValueError, IndexError):
                continue
    return None, None


def load_dicom(data: bytes) -> dict:
    """DICOMバイト列を読み、PNG(bytes) と メタ情報を返す。

    returns:
      {
        "png": bytes,               # 8bit グレースケールPNG
        "width", "height": int,
        "mm_per_px": float|None,    # 取得できた場合のみ
        "spacing_source": str|None, # "ImagerPixelSpacing" 等
        "meta": {modality, body_part, study_date, ...},
      }
    """
    import pydicom

    ds = pydicom.dcmread(io.BytesIO(data), force=True)
    arr = ds.pixel_array  # 圧縮構文はプラグインで自動デコード

    # マルチフレームは先頭フレームのみ (パノラマ等の想定外形状を防ぐ)
    if arr.ndim == 3 and arr.shape[-1] not in (3, 4):
        arr = arr[0]
    if arr.ndim == 3 and arr.shape[-1] in (3, 4):
        arr = arr[..., 0]

    img8 = _window_to_uint8(arr, ds)
    h, w = img8.shape[:2]

    mm_per_px, source = _pixel_spacing_mm_per_px(ds)

    # cv2 で PNG へ (依存を1つに集約)
    import cv2
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
        "meta": {
            "modality": _s("Modality"),
            "body_part": _s("BodyPartExamined"),
            "study_date": _s("StudyDate"),
            "view_position": _s("ViewPosition"),
            "photometric": _s("PhotometricInterpretation"),
        },
    }
