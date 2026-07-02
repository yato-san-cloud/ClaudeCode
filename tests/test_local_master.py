import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from jancode_dimensions.models import Dimensions  # noqa: E402
from jancode_dimensions.providers import LocalMasterProvider  # noqa: E402


def _write(tmp_path, text):
    p = tmp_path / "master.csv"
    p.write_text(text, encoding="utf-8")
    return str(p)


def test_individual_cm_columns(tmp_path):
    path = _write(tmp_path, "JANコード,商品名,幅,奥行,高さ\n4901234567894,商品A,30,20,10\n")
    prov = LocalMasterProvider(path)
    info = prov.lookup("4901234567894")
    assert info is not None
    assert info.title == "商品A"
    assert info.dimensions == Dimensions(30.0, 20.0, 10.0)


def test_mm_columns_converted_to_cm(tmp_path):
    path = _write(tmp_path, "jan,商品名,幅mm,奥行mm,高さmm\n4901234567894,A,300,200,100\n")
    prov = LocalMasterProvider(path)
    info = prov.lookup("4901234567894")
    assert info.dimensions == Dimensions(30.0, 20.0, 10.0)


def test_size_text_column(tmp_path):
    path = _write(tmp_path, "jan,サイズ\n4900000000001,幅40×奥行30×高さ25cm\n")
    prov = LocalMasterProvider(path)
    info = prov.lookup("4900000000001")
    assert info.dimensions is not None
    assert info.dimensions.total_cm == 95.0


def test_size_text_fallback_when_columns_empty(tmp_path):
    # 個別列が空でもサイズ文字列列から補完する
    path = _write(
        tmp_path,
        "jan,幅,奥行,高さ,サイズ\n4900000000002,,,,30×20×10cm\n",
    )
    prov = LocalMasterProvider(path)
    info = prov.lookup("4900000000002")
    assert info.dimensions == Dimensions(30.0, 20.0, 10.0)


def test_jan_normalization_on_lookup(tmp_path):
    path = _write(tmp_path, "jan,幅,奥行,高さ\n4901234567894,1,2,3\n")
    prov = LocalMasterProvider(path)
    # Excel由来の小数化・空白・ハイフンを吸収する
    assert prov.lookup("4901234567894.0") is not None
    assert prov.lookup(" 4901234567894 ") is not None
    assert prov.lookup("4-901234-567894") is not None


def test_unknown_jan_returns_none(tmp_path):
    path = _write(tmp_path, "jan,幅,奥行,高さ\n4901234567894,1,2,3\n")
    prov = LocalMasterProvider(path)
    assert prov.lookup("4999999999999") is None


def test_missing_jan_column_raises(tmp_path):
    path = _write(tmp_path, "コード,幅,奥行,高さ\n123,1,2,3\n")
    with pytest.raises(ValueError):
        LocalMasterProvider(path)
