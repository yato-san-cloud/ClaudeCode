import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from jancode_dimensions.parser import parse_dimensions  # noqa: E402


@pytest.mark.parametrize(
    "text, expected",
    [
        # ラベル付き・単位末尾
        ("幅30×奥行20×高さ10cm", (30.0, 20.0, 10.0)),
        # ラベル付き・各単位あり・コロン区切り
        ("幅: 30cm 奥行: 20cm 高さ: 10cm", (30.0, 20.0, 10.0)),
        # W/D/H 表記
        ("W30×D20×H10cm", (30.0, 20.0, 10.0)),
        # 「約」入り
        ("サイズ 約 30 × 20 × 10 cm です", (30.0, 20.0, 10.0)),
        # 単位なし3連(既定cm)
        ("30×20×10", (30.0, 20.0, 10.0)),
        # 各数値に単位付き
        ("30cm×20cm×10cm", (30.0, 20.0, 10.0)),
        # 全角数字・全角単位
        ("３０×２０×１０ｃｍ", (30.0, 20.0, 10.0)),
        # 小数
        ("30.5×20×10.2cm", (30.5, 20.0, 10.2)),
        # mm 入力 → cm 変換
        ("300×200×100mm", (30.0, 20.0, 10.0)),
        # ラベル付きで末尾だけ単位(mm補完)
        ("幅300×奥行200×高さ100mm", (30.0, 20.0, 10.0)),
    ],
)
def test_parse_ok(text, expected):
    dims = parse_dimensions(text)
    assert dims is not None, f"抽出失敗: {text}"
    assert (dims.width_cm, dims.depth_cm, dims.height_cm) == expected


def test_total():
    dims = parse_dimensions("幅30×奥行20×高さ10cm")
    assert dims.total_cm == 60.0


@pytest.mark.parametrize(
    "text",
    [
        None,
        "",
        "サイズ情報なし",
        "重さ500g",
        "2個セット",
    ],
)
def test_parse_none(text):
    assert parse_dimensions(text) is None


def test_zero_rejected():
    # 0 を含む寸法は無効扱い
    assert parse_dimensions("0×20×10cm") is None
