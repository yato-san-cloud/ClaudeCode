"""Round-1 commercial-hardening regression tests for the schema & data pipeline.

Each test pins a concrete defect or hardening goal from the round-1 pass. Every
test fails against the pre-fix code and passes after the fix. Grouped by module.

Owned modules under test: schema, importer, provenance, project, design, cad,
distances, workmethod. (Engine/web are other owners' and are not touched here.)
"""

from __future__ import annotations

import inspect
import io
import json
import zipfile
from pathlib import Path

import pytest
from pydantic import BaseModel

from whsim import templates
from whsim.design import materialize_racks
from whsim.importer import import_bytes
from whsim.project import Project
from whsim.schema import model as M
from whsim.schema.model import Item, WarehouseModel


def _zip(files: dict[str, bytes | str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, content in files.items():
            z.writestr(name, content)
    return buf.getvalue()


# --------------------------------------------------------------------------- #
# KNOWN DEFECT: blank / duplicate id collision (lost zones / SKUs / orders)
# --------------------------------------------------------------------------- #
def test_blank_skus_get_unique_ids_no_collision():
    """Two blank SKUs used to collapse to one entry in item_by_sku(); they must
    each get a stable unique id so neither item is lost."""
    m = WarehouseModel.model_validate(
        {"items": [{"name": "a"}, {"name": "b"}, {"sku": "REAL"}]}
    )
    warns = m.normalize_ids()
    skus = [it.sku for it in m.items]
    assert len(set(skus)) == 3  # all distinct -> none lost in a dict map
    assert "" not in skus
    assert len(m.item_by_sku()) == 3
    assert warns  # the auto-assignment is surfaced, not silent


def test_duplicate_ids_are_de_duplicated_and_first_holder_keeps_key():
    m = WarehouseModel.model_validate(
        {
            "locations": [{"id": "L1"}, {"id": "L1"}, {"id": "L1"}],
            "layout": {"zones": [{"id": "z"}, {"id": "z"}]},
            "orders": {"outbound": [{"order_id": "O"}, {"order_id": "O"}]},
        }
    )
    m.normalize_ids()
    assert len({lc.id for lc in m.locations}) == 3
    assert len(m.location_by_id()) == 3  # no overwrite -> 3 locations survive
    assert len({z.id for z in m.layout.zones}) == 2
    assert len({o.order_id for o in m.orders.outbound}) == 2


def test_normalize_ids_repairs_references_for_renamed_keys():
    """A blank location id that gets auto-named must still be reachable from the
    item that pegged to it (default_location). A renamed *duplicate* SKU must
    NOT steal references that legitimately point at the first holder."""
    m = WarehouseModel.model_validate(
        {
            "items": [{"sku": "X"}, {"sku": "X"}],  # dup -> X, X-2
            "locations": [{"id": "", "sku": "X"}],  # blank id, refs sku X
            "orders": {
                "outbound": [{"order_id": "O", "lines": [{"sku": "X", "qty": 1}]}]
            },
        }
    )
    m.normalize_ids()
    # reference to the surviving 'X' (first item) must stay 'X', not 'X-2'
    assert m.locations[0].sku == "X"
    assert m.orders.outbound[0].lines[0].sku == "X"
    # the blank location id is now concrete and unique
    assert m.locations[0].id and m.locations[0].id in m.location_by_id()


def test_importer_normalizes_blank_ids_end_to_end():
    """The defect end-to-end: a product master with blank/duplicate SKUs must
    not silently drop rows on import."""
    tmpl = {"items": []}
    items = [{"name": "no sku"}, {"name": "also no sku"}, {"sku": "DUP"}, {"sku": "DUP"}]
    res = import_bytes(tmpl, _zip({"product_master.json": json.dumps(items)}))
    assert len(res.model.items) == 4
    assert len(res.model.item_by_sku()) == 4  # nothing collapsed
    assert any("自動採番" in w or "重複" in w for w in res.warnings)


# --------------------------------------------------------------------------- #
# Schema: defaults, mutable-default isolation, messy-input coercion (import)
# --------------------------------------------------------------------------- #
def test_no_shared_mutable_default_instances():
    """Mutable defaults must use default_factory: two fresh models must not
    share the same list/dict object (a classic shared-instance bug)."""
    a = WarehouseModel()
    b = WarehouseModel()
    a.items.append(Item(sku="only-in-a"))
    a.distance_overrides["k"] = 1.0
    a.resources.workers.append(M.WorkerGroup(id="extra"))
    assert b.items == []
    assert b.distance_overrides == {}
    # default worker group is also not shared between models
    assert len(b.resources.workers) == 1
    assert a.resources.workers is not b.resources.workers


def test_every_schema_model_constructible_with_no_args():
    offenders = []
    for _n, obj in inspect.getmembers(M):
        if inspect.isclass(obj) and issubclass(obj, BaseModel) and obj is not BaseModel:
            req = [fn for fn, f in obj.model_fields.items() if f.is_required()]
            if req:
                offenders.append((obj.__name__, req))
    assert not offenders, f"models with required fields: {offenders}"


def test_coerce_messy_clamps_negatives_and_zero_without_rejecting():
    m = WarehouseModel.model_validate(
        {
            "simulation": {"duration_s": -100, "replications": 0, "work_days_per_month": -3},
            "process": {"walk_speed_mps": 0, "batch_size": -5},
            "orders": {"profile": {"peak_factor": -2.0, "rate_per_hr": -10}},
            "resources": {"workers": [{"count": -4, "speed_mps": 0}]},
            "items": [{"sku": "A", "pick_freq": -1.0, "case_qty": 0}],
            "locations": [{"id": "L", "capacity": -9, "qty": -1}],
        }
    )
    warns = m.coerce_messy()
    assert m.simulation.duration_s >= 1.0
    assert m.simulation.replications >= 1
    assert m.simulation.work_days_per_month >= 1
    assert m.process.walk_speed_mps > 0  # would divide-by-zero otherwise
    assert m.process.batch_size >= 1
    assert m.orders.profile.peak_factor >= 0.0
    assert m.orders.profile.rate_per_hr >= 0.0
    assert m.resources.workers[0].count >= 0
    assert m.resources.workers[0].speed_mps > 0
    assert m.items[0].pick_freq >= 0.0
    assert m.items[0].case_qty >= 1
    assert m.locations[0].capacity >= 0
    assert m.locations[0].qty >= 0
    assert warns  # every clamp surfaced


def test_importer_coerces_numbers_in_strings_and_clamps():
    """A customer JSON often stores numbers as strings; import must read them
    and clamp impossible values, never reject the bundle."""
    tmpl = {"items": []}
    items = [{"sku": "A", "ts_per_unit": "2.5", "case_qty": "12", "pick_freq": "-1"}]
    res = import_bytes(tmpl, _zip({"product_master.json": json.dumps(items)}))
    it = res.model.items[0]
    assert it.ts_per_unit == 2.5
    assert it.case_qty == 12
    assert it.pick_freq == 0.0  # negative clamped


def test_schema_stays_strict_for_interactive_edits():
    """The coercion lives on the IMPORT path only: a genuinely bad value handed
    to model_validate directly must still raise (so the web editor can 400)."""
    import pydantic

    with pytest.raises(pydantic.ValidationError):
        M.WorkerGroup.model_validate({"count": "lots"})


# --------------------------------------------------------------------------- #
# Importer: zip-bomb / path-traversal safety, encoding & delimiter tolerance
# --------------------------------------------------------------------------- #
def test_zip_path_traversal_member_is_skipped():
    tmpl = {"items": []}
    good = [{"sku": "OK"}]
    zb = _zip(
        {
            "../../evil/product_master.json": json.dumps(good),
            "product_master.json": json.dumps(good),
        }
    )
    res = import_bytes(tmpl, zb)
    assert any("安全でないパス" in w for w in res.warnings)
    # the safe member still imported
    assert res.model.items[0].sku == "OK"


def test_zip_entry_count_cap_is_enforced():
    """A pathological archive with a huge member count must not be processed
    without bound; the cap is noted as a warning."""
    from whsim import importer

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for i in range(importer.MAX_ENTRIES + 5):
            z.writestr(f"f{i}.json", "{}")
    res = import_bytes({"items": []}, buf.getvalue())
    assert any("エントリ数が上限" in w for w in res.warnings)


def test_zip_oversized_entry_is_skipped(monkeypatch):
    """An entry whose DECLARED uncompressed size exceeds the per-entry cap is
    skipped on its header alone -- the importer never inflates it into memory
    (zip-bomb guard). Cap is monkeypatched low to keep the test cheap."""
    from whsim import importer

    monkeypatch.setattr(importer, "MAX_ENTRY_BYTES", 1024)
    big = "x" * 4096  # 4 KiB uncompressed, well over the 1 KiB cap
    zb = _zip({"huge.json": big, "product_master.json": json.dumps([{"sku": "S"}])})
    res = import_bytes({"items": []}, zb)
    assert any("大きすぎる" in w for w in res.warnings)
    assert res.model.items[0].sku == "S"  # the safe small file still imported


def test_zip_total_size_cap_stops_processing(monkeypatch):
    from whsim import importer

    monkeypatch.setattr(importer, "MAX_ENTRY_BYTES", 10_000)
    monkeypatch.setattr(importer, "MAX_TOTAL_BYTES", 2048)
    zb = _zip({f"f{i}.json": "x" * 1500 for i in range(5)})
    res = import_bytes({"items": []}, zb)
    assert any("合計展開サイズ" in w for w in res.warnings)


def test_cp932_and_bom_decoded_not_skipped():
    raw = json.dumps([{"sku": "X", "name": "日本語"}], ensure_ascii=False).encode("cp932")
    res = import_bytes({"items": []}, _zip({"product_master.json": raw}))
    assert res.model.items[0].name == "日本語"


# --------------------------------------------------------------------------- #
# Project: corrupt / empty file recovery, atomic write
# --------------------------------------------------------------------------- #
def test_load_model_recovers_from_corrupt_json(tmp_path: Path):
    proj = Project.create("p", "ecommerce_small", base=tmp_path / "projects")
    proj.model_file.write_text("{ this is not json", encoding="utf-8")
    m = proj.load_model()  # must not raise
    assert isinstance(m, WarehouseModel)
    assert m.simulation.duration_s > 0  # recovered to a valid default model


def test_load_model_recovers_from_empty_file(tmp_path: Path):
    proj = Project.create("p", "ecommerce_small", base=tmp_path / "projects")
    proj.model_file.write_text("", encoding="utf-8")
    assert isinstance(proj.load_model(), WarehouseModel)


def test_meta_recovers_from_corrupt_project_json(tmp_path: Path):
    proj = Project.create("p", "ecommerce_small", base=tmp_path / "projects")
    proj.project_file.write_text("garbage", encoding="utf-8")
    meta = proj.meta()  # must not raise / KeyError downstream
    assert "template_id" in meta and "name" in meta


def test_load_provenance_recovers_from_corrupt_file(tmp_path: Path):
    proj = Project.create("p", "ecommerce_small", base=tmp_path / "projects")
    proj.provenance_file.write_text("not json at all", encoding="utf-8")
    prov = proj.load_provenance()  # must not raise
    assert 0.0 <= prov.confidence() <= 1.0


# --------------------------------------------------------------------------- #
# Design: materialize_racks keeps SKU pegging consistent
# --------------------------------------------------------------------------- #
def test_materialize_racks_pegs_every_item_to_real_slot():
    m = templates.load_template_model("ecommerce_small")
    storage = next(z for z in m.layout.zones if z.id == "storage")
    storage.rack.col_spacing = 3.0
    storage.rack.row_spacing = 2.0
    materialize_racks(m)
    ids = {loc.id for loc in m.locations}
    assert all(it.default_location in ids for it in m.items)
    assert len({it.sku for it in m.items}) == len(m.items)


# --------------------------------------------------------------------------- #
# CAD: garbage / empty DXF is tolerated (never raises)
# --------------------------------------------------------------------------- #
def test_cad_garbage_dxf_is_tolerated():
    from whsim.cad import import_dxf_bytes

    r = import_dxf_bytes(b"this is not a DXF file")
    assert r["bounds"] == {"width": 0.0, "depth": 0.0}
    assert r["warnings"]  # human-readable warning, no exception


def test_cad_empty_dxf_is_tolerated():
    from whsim.cad import import_dxf_bytes

    r = import_dxf_bytes(b"")
    assert r["walls"] == [] and r["zones"] == []
    assert r["warnings"]


# --------------------------------------------------------------------------- #
# Distances: malformed matrices tolerated
# --------------------------------------------------------------------------- #
def test_distances_malformed_json_is_tolerated_not_raised():
    from whsim.distances import import_distance_matrix_bytes

    r = import_distance_matrix_bytes(b"{ this is broken json", filename="m.json")
    assert r["count"] == 0
    assert r["warnings"]


def test_distances_garbage_csv_is_tolerated():
    from whsim.distances import import_distance_matrix_bytes

    r = import_distance_matrix_bytes(b"col1;col2;col3\nfoo;bar;baz\n", filename="m.csv")
    # no recognisable distances; tolerant empty result, no exception
    assert r["count"] == 0


def test_distances_semicolon_delimiter_and_decimal_comma():
    from whsim.distances import import_distance_matrix_bytes, lookup

    data = "from;to;distance\nL1;L2;12,5\n".encode("utf-8")
    r = import_distance_matrix_bytes(data, filename="m.csv")
    assert lookup(r["pairs"], "L1", "L2") == 12.5
