"""実データ取込の堅牢化 — native .rmpm / WMS Excel(タイトル行・合計行・.xls) / DXF."""
from pathlib import Path

import pandas as pd
from fastapi.testclient import TestClient

from whsim import rmpm
from whsim.analysis.data_io import (
    SHIPMENT_FIELDS, initial_mapping, load_table,
)
from whsim.web.app import app

FIX = Path(__file__).parent / "fixtures"
REF = Path(__file__).parent.parent / "reference" / "mapmaker" / "exported"

client = TestClient(app)


# ---- MapMaker native .rmpm (Java serialization) ------------------------------

def test_native_rmpm_matches_json_oracle():
    """The native Java-serialized save must decode to EXACTLY the layout the
    official JSON export carries (same shelves, names, coords, bounds)."""
    native = (REF / "(LW)最終版レイアウト_Rev2.rmpm").read_bytes()
    oracle = (REF / "(LW)最終版レイアウト_Rev2.rmpm.json").read_bytes()
    rn = rmpm.import_rmpm_bytes(native)
    ro = rmpm.import_rmpm_bytes(oracle)
    assert rn["stats"]["shelves"] == ro["stats"]["shelves"] == 602
    assert rn["bounds"] == ro["bounds"]
    mn = {s["name"]: s for s in rn["zones"][0]["shelves"]}
    mo = {s["name"]: s for s in ro["zones"][0]["shelves"]}
    assert set(mn) == set(mo)
    worst = max(abs(mn[k][a] - mo[k][a]) for k in mn for a in ("x", "y", "w", "h"))
    assert worst < 0.002


def test_native_rmpm_via_endpoint(tmp_path):
    r = client.post("/api/projects", json={"name": "rmpmnat", "template": "ecommerce_small"})
    try:
        native = (REF / "(LW)最終版レイアウト_Rev2.rmpm").read_bytes()
        res = client.post("/api/projects/rmpmnat/import-rmpm",
                          files={"file": ("LW_Rev2.rmpm", native, "application/octet-stream")})
        assert res.status_code == 200, res.text
        d = res.json()
        assert d["stats"]["shelves"] == 602
    finally:
        client.delete("/api/projects/rmpmnat")


def test_rmpm_garbage_is_friendly_400():
    client.post("/api/projects", json={"name": "rmpmbad", "template": "ecommerce_small"})
    try:
        res = client.post("/api/projects/rmpmbad/import-rmpm",
                          files={"file": ("x.rmpm", b"\xac\xed\x00\x05garbage", "application/octet-stream")})
        assert res.status_code == 400
        assert "rmpm" in res.json()["detail"].lower() or "解釈" in res.json()["detail"]
    finally:
        client.delete("/api/projects/rmpmbad")


# ---- WMS Excel: title rows above the header / 合計 row / legacy .xls ---------

def test_xlsx_with_title_rows_finds_header_and_maps():
    buf = (FIX / "shipments_wms.xlsx").read_bytes()
    df = load_table(buf, "00101_202507.xlsx")
    assert "商品ｺｰﾄﾞ" in df.columns and "出荷ﾊﾞﾗ数" in df.columns
    # 合計 row dropped; only data rows remain
    assert not df.iloc[:, 0].astype(str).str.contains("合計").any()
    mapping = initial_mapping(df, SHIPMENT_FIELDS)
    assert mapping["sku"] == "商品ｺｰﾄﾞ"
    assert mapping["date"] == "出荷日"
    assert mapping["qty"] in ("出荷ﾊﾞﾗ数", "出荷ｹｰｽ数")


def test_legacy_xls_loads_via_xlrd():
    buf = (FIX / "inbound_legacy.xls").read_bytes()
    df = load_table(buf, "00102_202507.xls")
    assert len(df) == 60
    assert "商品ｺｰﾄﾞ" in df.columns and "入荷数" in df.columns


def test_csv_with_title_rows_finds_header():
    csv = ("出荷データ抽出\n,,\n出荷日,商品コード,数量\n"
           "2025/07/01,A1,3\n2025/07/01,B2,5\n").encode("cp932")
    df = load_table(csv, "extract.csv")
    assert list(df.columns)[:3] == ["出荷日", "商品コード", "数量"]
    assert len(df) == 2


def test_header_newlines_and_zenkaku_normalised():
    csv = "出荷\n日,商品　コード,数量\n2025/07/01,A1,3\n".encode("utf-8")
    # quoted header cell with a newline
    csv = '"出荷\n日","商品　コード",数量\n2025/07/01,A1,3\n'.encode("utf-8")
    df = load_table(csv, "x.csv")
    assert "出荷 日" in df.columns and "商品 コード" in df.columns


# ---- DXF: DWG mis-save detected with a friendly message ----------------------

def test_dwg_disguised_as_dxf_gets_friendly_message(tmp_path):
    from whsim import cad
    p = tmp_path / "drawing.dxf"
    p.write_bytes(b"AC1032" + b"\x00" * 64)     # DWG 2018 magic
    res = cad.import_dxf(p)
    assert any("DWG" in w for w in res["warnings"])
    assert res["stats"]["walls"] == 0
