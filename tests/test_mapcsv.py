"""MapMaker (Hitachi WorldMap) Map CSV importer — parser + web endpoint."""

import pytest
from fastapi.testclient import TestClient

from whsim import mapcsv
from whsim.web.app import app

# A MapMaker-flavoured Map CSV: META/BBOX extents, OBJ rows for SHELF/WALL/STATION,
# plus rows the single-floor model skips (CONSTRAINED_AREA / STAIRS).
SAMPLE = """META,BBOX,0,0,40,20
OBJ,SHELF,SH001,2,2,4,18
OBJ,SHELF,SH002,8,2,10,18
OBJ,WALL,W1,0,0,40,0
OBJ,STATION,pack,36,10
OBJ,CONSTRAINED_AREA,C1,20,0,22,20
META,SHELF_NAME_LIST,SH001,A-01,A-02
"""


def test_parse_shelves_walls_stations():
    res = mapcsv.import_mapcsv_bytes(SAMPLE.encode("utf-8"))
    assert res["bounds"]["width"] == pytest.approx(40.0)
    assert res["bounds"]["depth"] == pytest.approx(20.0)
    assert len(res["zones"]) == 1
    z = res["zones"][0]
    assert z["type"] == "storage"
    assert len(z["shelves"]) == 2           # two SHELF rectangles
    assert res["stats"]["walls"] == 1
    assert res["stats"]["stations"] == 1
    assert res["stats"]["units"] == "m"
    # constrained area is noted, not geometried
    assert any("CONSTRAINED_AREA" in w for w in res["warnings"])


def test_mm_unit_autodetect():
    big = "META,BBOX,0,0,40000,20000\nOBJ,SHELF,S,1000,1000,3000,19000\n"
    res = mapcsv.import_mapcsv_bytes(big.encode("utf-8"))
    assert res["stats"]["units"] == "mm"
    assert res["bounds"]["width"] == pytest.approx(40.0)  # 40000mm -> 40m


def test_unrecognised_csv_is_tolerant():
    res = mapcsv.import_mapcsv_bytes(b"foo,bar,baz\n1,2,3\n")
    assert res["zones"] == []
    assert res["warnings"]  # explained, not fatal


def test_shelves_materialise_locations():
    """Imported SHELF areas must turn into real location cells via the engine."""
    from whsim import design
    from whsim.schema.model import WarehouseModel
    res = mapcsv.import_mapcsv_bytes(SAMPLE.encode("utf-8"))
    m = WarehouseModel()
    m.layout.zones = [__import__("whsim.schema.model", fromlist=["Zone"]).Zone(**z)
                      for z in res["zones"]]
    design.materialize_racks(m)
    assert len(m.locations) > 0


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", tmp_path / "projects")
    return TestClient(app)


def test_import_endpoint(client):
    assert client.post("/api/projects",
                       json={"name": "mm", "template": "ecommerce_small"}).status_code == 200
    r = client.post("/api/projects/mm/import-mapcsv",
                    files={"file": ("map.csv", SAMPLE.encode("utf-8"), "text/csv")})
    assert r.status_code == 200
    j = r.json()
    assert j["shelves"] == 2
    assert j["locations"] > 0
    # a bad file must not 500
    bad = client.post("/api/projects/mm/import-mapcsv",
                      files={"file": ("x.csv", b"\x00\x01nonsense", "text/csv")})
    assert bad.status_code == 200
