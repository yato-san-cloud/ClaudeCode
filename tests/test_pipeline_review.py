"""Regression tests for the schema & data-pipeline review.

Each test pins a real defect found during review: it would fail against the
pre-fix code and passes after the minimal fix. Grouped by module.
"""

import io
import json
import zipfile
from pathlib import Path

import pytest

from whsim import templates
from whsim.design import materialize_racks
from whsim.importer import import_bytes, import_zip
from whsim.project import Project, safe_name
from whsim.provenance import Provenance, Source
from whsim.schema import model as M
from whsim.schema.model import WarehouseModel


def _zip(files: dict[str, bytes | str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, content in files.items():
            z.writestr(name, content)
    return buf.getvalue()


# --- schema: the core invariant (every field has a default) -----------------
def test_every_schema_model_is_constructible_with_no_args():
    """The load-bearing contract: every BaseModel must have all-defaulted
    fields, so any subtree validates and the model 'never blocks on missing
    data'. Previously Zone/Location/Item/Order/... had required id/sku keys."""
    import inspect

    from pydantic import BaseModel

    offenders = []
    for _name, obj in inspect.getmembers(M):
        if inspect.isclass(obj) and issubclass(obj, BaseModel) and obj is not BaseModel:
            required = [fn for fn, f in obj.model_fields.items() if f.is_required()]
            if required:
                offenders.append((obj.__name__, required))
    assert not offenders, f"models with required (no-default) fields: {offenders}"


def test_import_with_missing_keys_is_not_fatal():
    """A products file where a row is missing 'sku' must not reject the bundle:
    tolerant import means it validates with a defaulted key."""
    tmpl = templates.load_template_dict("ecommerce_small")
    items = [{"name": "no sku here"}, {"sku": "REAL", "name": "ok"}]
    res = import_bytes(tmpl, _zip({"product_master.json": json.dumps(items)}))
    assert len(res.model.items) == 2
    assert res.model.items[0].sku == ""  # defaulted, not fatal


def test_schema_round_trip_fidelity():
    m = templates.load_template_model("ecommerce_small")
    again = WarehouseModel.model_validate_json(m.model_dump_json())
    assert again.model_dump() == m.model_dump()


# --- importer: corrupt ZIP / encoding tolerance -----------------------------
def test_corrupt_zip_bytes_is_not_fatal():
    tmpl = templates.load_template_dict("ecommerce_small")
    res = import_bytes(tmpl, b"this is definitely not a zip file")
    # template kept intact, a warning recorded, no exception
    assert len(res.model.locations) == 99
    assert any("ZIP" in w for w in res.warnings)


def test_corrupt_zip_file_is_not_fatal(tmp_path: Path):
    tmpl = templates.load_template_dict("ecommerce_small")
    p = tmp_path / "bad.zip"
    p.write_bytes(b"garbage")
    res = import_zip(tmpl, p)
    assert len(res.model.locations) == 99
    assert res.warnings


def test_cp932_japanese_json_is_decoded_not_skipped():
    """Japanese exports are commonly CP932/Shift-JIS. They must import, not be
    skipped as 'invalid JSON'."""
    tmpl = templates.load_template_dict("ecommerce_small")
    raw = json.dumps([{"sku": "X", "name": "日本語商品名"}],
                     ensure_ascii=False).encode("cp932")
    res = import_bytes(tmpl, _zip({"product_master.json": raw}))
    assert "items" in res.touched_subtrees
    assert res.model.items[0].name == "日本語商品名"


def test_corrupt_member_does_not_break_other_files():
    """One unreadable member must not stop the others (already partly covered
    by test_importer, here we ensure a truncated/odd entry just gets skipped)."""
    tmpl = templates.load_template_dict("ecommerce_small")
    good = [{"order_id": "O1", "lines": [{"sku": "SKU0000", "qty": 1}]}]
    res = import_bytes(tmpl, _zip({
        "outbound.json": json.dumps(good),
        "weird.json": b"\xff\xfe\x00bad",  # undecodable -> skipped
    }))
    assert res.model.orders.outbound[0].order_id == "O1"
    assert any("weird.json" in w for w in res.warnings)


# --- provenance: corrupt file recovery --------------------------------------
def test_provenance_recovers_from_corrupt_source_value():
    p = Provenance("t", {"items": "not_a_real_source", "layout": "imported"})
    assert p.subtrees["items"] is Source.PROVISIONAL
    assert p.subtrees["layout"] is Source.IMPORTED


def test_provenance_confidence_denominator_no_double_count():
    p = Provenance("t")
    p.mark("items", Source.IMPORTED)
    p.mark("layout", Source.INTERVIEW)
    # 2 of the 8 mergeable subtrees are real
    assert p.confidence() == pytest.approx(2 / len(p.subtrees))


# --- project: name sanitization, atomic write, run resolution ---------------
def test_project_name_traversal_is_blocked(tmp_path: Path):
    base = tmp_path / "projects"
    proj = Project.create("../escaped", "ecommerce_small", base=base)
    # must stay inside the projects/ base dir, never escape via '..'
    assert base.resolve() in proj.root.resolve().parents


def test_safe_name_rejects_empty_and_keeps_japanese():
    assert safe_name("../../etc/passwd") == "passwd"
    assert safe_name("倉庫A") == "倉庫A"
    with pytest.raises(ValueError):
        safe_name("../")


def test_latest_run_dir_is_numeric_not_lexicographic(tmp_path: Path):
    proj = Project.create("p", "ecommerce_small", base=tmp_path / "projects")
    for _ in range(3):
        proj.new_run_dir()
    # force the lexicographic-vs-numeric trap: run_0010 > run_0009 numerically
    (proj.runs_dir / "run_0009").mkdir(exist_ok=True)
    (proj.runs_dir / "run_0010").mkdir(exist_ok=True)
    assert proj.latest_run_dir().name == "run_0010"
    assert proj.new_run_dir().name == "run_0011"


def test_save_model_is_atomic_and_recoverable(tmp_path: Path):
    proj = Project.create("p", "ecommerce_small", base=tmp_path / "projects")
    m = proj.load_model()
    m.meta.name = "edited"
    proj.save_model(m)
    # no leftover temp files, model reloads cleanly
    assert not list(proj.root.glob(".tmp-*"))
    assert proj.load_model().meta.name == "edited"


# --- design: materialize_racks SKU integrity --------------------------------
def test_materialize_racks_never_orphans_skus_when_no_slots():
    """Degenerate rack params (margin >= zone size) yield zero slots; the model
    must not delete every location and orphan all item SKUs."""
    m = templates.load_template_model("ecommerce_small")
    storage = next(z for z in m.layout.zones if z.id == "storage")
    storage.rack.margin = max(storage.w, storage.h)
    materialize_racks(m)
    ids = {loc.id for loc in m.locations}
    orphans = [it.sku for it in m.items if it.default_location not in ids]
    assert not orphans
    assert m.locations  # existing locations preserved, not wiped


def test_materialize_racks_pegs_every_item_to_a_real_slot():
    m = templates.load_template_model("ecommerce_small")
    storage = next(z for z in m.layout.zones if z.id == "storage")
    storage.rack.col_spacing = 3.0
    storage.rack.row_spacing = 2.0
    materialize_racks(m)
    ids = {loc.id for loc in m.locations}
    assert all(it.default_location in ids for it in m.items)
    # SKU count conserved
    assert len({it.sku for it in m.items}) == len(m.items)
