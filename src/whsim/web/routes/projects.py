"""Project lifecycle and model-editing endpoints: create/list/delete/rename/
duplicate, the demo bootstrap, the model/full views, headline & dotted-path
edits, design saves, settings, and inventory slotting."""

from __future__ import annotations

import json
import shutil

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from whsim import templates
from whsim.project import Project

from ._common import (
    Source,
    _free_project_name,
    _headline_values,
    _open,
    _project_dir,
    _read_upload,
    _safe_name,
    _sample_zip_path,
    _set_by_path,
)

router = APIRouter()


@router.get("/api/projects")
def api_projects():
    from whsim.project import PROJECTS_DIR
    if not PROJECTS_DIR.is_dir():
        return []
    return sorted(p.name for p in PROJECTS_DIR.iterdir()
                  if (p / "project.json").is_file())


@router.post("/api/projects")
def api_create(payload: dict):
    name = _safe_name(payload.get("name") or "")
    template = payload.get("template") or "ecommerce_small"
    try:
        proj = Project.create(name, template)
    except FileNotFoundError:
        # Unknown template id: a clean 400, not a 500.
        raise HTTPException(400, f"unknown template {template!r}")
    return {"name": name, "template": template, "root": str(proj.root)}


@router.post("/api/projects/sample")
def api_sample(payload: dict | None = None):
    """One-click demo project: create from the default template and, if a bundled
    sample customer ZIP is available, auto-import it so the project is immediately
    runnable with realistic numbers.

    Body (optional): ``{"name": str}``. If omitted or already taken, a free name
    is auto-picked (``デモ`` then ``demo-2``, ``demo-3``, ...). Returns
    ``{"name": str, "ready": bool}`` where ``ready`` is True once sample data was
    imported (so the salesperson can run straight away)."""
    payload = payload or {}
    raw = payload.get("name")
    preferred = _safe_name(raw) if isinstance(raw, str) and raw.strip() else "デモ"
    name = _free_project_name(preferred)

    try:
        proj = Project.create(name, "ecommerce_small")
    except FileNotFoundError:
        raise HTTPException(400, "デモ用テンプレートが見つかりません。")

    ready = False
    zip_path = _sample_zip_path()
    if zip_path is not None and zip_path.is_file():
        try:
            proj.import_zip(zip_path)
            ready = True
        except Exception:  # noqa: BLE001 — never block: ship a runnable template anyway
            ready = False
    return {"name": name, "ready": ready}


@router.get("/api/samples")
def api_samples_list():
    """List the user's LOCAL personal samples (frozen project snapshots). These
    live in a gitignored ``samples/`` dir and never leave the machine."""
    from whsim import samplestore
    return samplestore.list_samples()


@router.post("/api/samples")
def api_sample_save(payload: dict):
    """Freeze the current project as a personal sample. Body:
    ``{"project": str, "label"?: str}``."""
    from whsim import samplestore
    proj = _open(payload.get("project") or "")
    return samplestore.save_sample(proj, payload.get("label") or "")


@router.post("/api/samples/{sid}/instantiate")
def api_sample_instantiate(sid: str, payload: dict | None = None):
    """Create a fresh project from a personal sample. Body (optional):
    ``{"name"?: str}`` — a free name is auto-picked if omitted/taken."""
    from whsim import samplestore
    payload = payload or {}
    raw = payload.get("name")
    base = samplestore.list_samples()
    label = next((m.get("label") for m in base if m.get("id") == sid), None)
    preferred = _safe_name(raw) if isinstance(raw, str) and raw.strip() else (label or "sample")
    name = _free_project_name(preferred)
    try:
        samplestore.instantiate(sid, name)
    except FileNotFoundError:
        raise HTTPException(404, f"no sample {sid!r}")
    return {"name": name}


@router.delete("/api/samples/{sid}")
def api_sample_delete(sid: str):
    from whsim import samplestore
    if not samplestore.delete_sample(sid):
        raise HTTPException(404, f"no sample {sid!r}")
    return {"ok": True}


@router.delete("/api/projects/{name}")
def api_delete(name: str):
    """Delete a project workspace and all its artifacts."""
    d = _project_dir(name)
    if not (d / "project.json").is_file():
        raise HTTPException(404, f"no project {name!r}")
    shutil.rmtree(d, ignore_errors=False)
    return {"ok": True}


@router.post("/api/projects/{name}/rename")
def api_rename(name: str, payload: dict):
    """Rename a project directory (src -> to). 404 if src missing, 400 if dest
    exists or the target name is invalid."""
    src = _project_dir(name)
    if not (src / "project.json").is_file():
        raise HTTPException(404, f"no project {name!r}")
    to = _safe_name(payload.get("to") or "")
    dst = _project_dir(to)
    if dst.exists():
        raise HTTPException(400, f"project {to!r} already exists")
    shutil.move(str(src), str(dst))
    # Keep the stored display name in sync so listings/proposals match.
    try:
        meta = json.loads((dst / "project.json").read_text("utf-8"))
        meta["name"] = to
        (dst / "project.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
    except Exception:  # noqa: BLE001 — never block on metadata bookkeeping
        pass
    return {"ok": True, "name": to}


@router.post("/api/projects/{name}/duplicate")
def api_duplicate(name: str, payload: dict):
    """Copy a project to a new name. 404 if src missing, 400 if dest exists."""
    src = _project_dir(name)
    if not (src / "project.json").is_file():
        raise HTTPException(404, f"no project {name!r}")
    to = _safe_name(payload.get("to") or "")
    dst = _project_dir(to)
    if dst.exists():
        raise HTTPException(400, f"project {to!r} already exists")
    shutil.copytree(src, dst)
    try:
        meta = json.loads((dst / "project.json").read_text("utf-8"))
        meta["name"] = to
        (dst / "project.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "name": to}


@router.get("/api/projects/{name}/model")
def api_model(name: str):
    proj = _open(name)
    manifest = templates.load_manifest(proj.meta()["template_id"])
    model = proj.load_model()
    # Surface whether a completed run exists (+ its KPIs) so reopening a project
    # restores the ④検証/⑤提案 result state instead of re-locking those phases
    # until the user runs again (a project with a run should read as "already run").
    has_run = False
    kpis = None
    try:
        rd = proj.latest_run_dir()
        if rd is not None and (rd / "kpis.json").is_file():
            has_run = True
            kpis = json.loads((rd / "kpis.json").read_text("utf-8"))
    except Exception:  # noqa: BLE001 — best-effort; never block the open
        has_run, kpis = False, None
    return {
        "name": name,
        "headline_fields": manifest.get("headline_fields", []),
        "headline_values": _headline_values(model.model_dump(), manifest),
        "provenance": proj.load_provenance().to_dict(),
        "provenance_summary": proj.load_provenance().summary(),
        "has_run": has_run,
        "kpis": kpis,
    }


@router.get("/api/projects/{name}/full")
def api_full(name: str):
    """The full model document, for the interactive design editor."""
    proj = _open(name)
    return JSONResponse(json.loads(proj.model_file.read_text("utf-8")))


@router.post("/api/projects/{name}/design")
def api_design(name: str, payload: dict):
    """Apply design edits (layout / resources / process). Re-materialises racks
    from storage zones so a layout change immediately affects routing & KPIs."""
    from whsim.design import materialize_racks
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    md = json.loads(proj.model_file.read_text("utf-8"))
    prov = proj.load_provenance()
    if payload.get("routes") is not None:
        md["routes"] = payload["routes"]  # manual flow-line studies
    for section in ("layout", "resources", "process"):
        if section in payload and payload[section] is not None:
            md[section] = payload[section]
            prov.mark(section, Source.INTERVIEW)
            if section == "layout":
                prov.mark("locations", Source.INTERVIEW)
    model = WarehouseModel.model_validate(md)
    if "layout" in payload:
        materialize_racks(model)
    proj.save_model(model)
    proj.save_provenance(prov)
    return {"ok": True, "provenance_summary": prov.summary(),
            "locations": len(model.locations)}


@router.post("/api/projects/{name}/apply")
def api_apply(name: str, payload: dict):
    """Apply a batch of structured dotted-path edits, then re-validate & save.

    Backend for the frontend's "適用して再実行": each edit in ``edits`` is applied
    to the model dict via ``_set_by_path`` tolerantly (a bad path is skipped and
    collected, never fatal — honours "never blocks"). Touched top-level subtrees
    are marked INTERVIEW; if a layout/locations/storage path was touched, racks
    are re-materialised so routing/KPIs reflect the change. The frontend calls
    this and then the existing /run."""
    from whsim.design import materialize_racks
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    edits = payload.get("edits")
    if not isinstance(edits, dict):
        raise HTTPException(400, "edits は {path: value} のオブジェクトで指定してください。")

    md = json.loads(proj.model_file.read_text("utf-8"))
    applied: list[str] = []
    skipped: list[str] = []
    touched_subtrees: set[str] = set()
    for path, value in edits.items():
        try:
            subtree = _set_by_path(md, str(path), value)
        except (KeyError, IndexError, ValueError, TypeError):
            skipped.append(str(path))
            continue
        applied.append(str(path))
        touched_subtrees.add(subtree)

    # Re-validate the whole document; a value that violates the schema rolls the
    # whole apply back (the on-disk model is untouched until validation passes).
    from pydantic import ValidationError
    try:
        model = WarehouseModel.model_validate(md)
    except ValidationError as e:
        raise HTTPException(400, f"invalid value: {e.errors()[0].get('msg', 'validation error')}")

    # Re-materialise racks when the layout / locations / storage intent changed.
    if any(p.split(".")[0] in ("layout", "locations") or "storage" in p
           for p in applied):
        materialize_racks(model)

    proj.save_model(model)
    prov = proj.load_provenance()
    for sub in touched_subtrees:
        prov.mark(sub, Source.INTERVIEW)
        if sub == "layout":
            prov.mark("locations", Source.INTERVIEW)
    proj.save_provenance(prov)
    return {"ok": True, "applied": applied, "skipped": skipped,
            "provenance_summary": prov.summary()}


# ---- settings (commercial / costing knobs) ----------------------------------

# Known cost-model knobs that live under the model's `settings` subtree. The
# schema owner adds a `settings` submodel with these flat, defaulted fields;
# kpis reads them. We mirror the numeric ones here ONLY to give a tolerant,
# schema-agnostic 400 on a clearly non-numeric value (structural type error)
# even before the schema field lands. `currency` is a free string.
_SETTINGS_NUMERIC = (
    "labor_cost_per_hour", "working_hours_per_day",
    "working_days_per_month", "agv_cost_per_month",
    # 原価積み上げ unit prices (原価試算 screen).
    "forklift_cost_per_hour", "fixed_labor_per_month", "tsubo_rate_per_month",
    "delivery_cost_per_cage", "system_cost_per_month", "overhead_rate",
)


@router.get("/api/projects/{name}/settings")
def api_get_settings(name: str):
    """Return the flat `settings` dict from the model (``{}`` if absent).

    Reads the on-disk model document directly so it round-trips even when the
    schema does not (yet) define a `settings` field — never 500s."""
    proj = _open(name)
    try:
        md = json.loads(proj.model_file.read_text("utf-8"))
        settings = md.get("settings")
    except Exception:  # noqa: BLE001 — best effort, never fatal
        settings = None
    return settings if isinstance(settings, dict) else {}


@router.put("/api/projects/{name}/settings")
def api_put_settings(name: str, payload: dict):
    """Merge a flat settings dict into the model's `settings` subtree.

    Tolerant: unknown keys are ignored, a missing `settings` subtree is created.
    A 400 is returned only on a structural type error (a known numeric knob given
    a non-numeric value). The whole document is re-validated with WarehouseModel
    so an edit that breaks the schema rolls back. Persists by writing the merged
    document straight to disk so `settings` survives whether or not the schema
    yet declares the field (``save_model`` would drop unknown keys). Marks the
    `settings` subtree provenance as INTERVIEW."""
    from pydantic import ValidationError

    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    if not isinstance(payload, dict):
        raise HTTPException(400, "settings は {キー: 値} のオブジェクトで指定してください。")

    md = json.loads(proj.model_file.read_text("utf-8"))
    cur = md.get("settings")
    if not isinstance(cur, dict):
        cur = {}

    # Merge: ignore unknown keys; coerce/validate known numeric knobs.
    merged = dict(cur)
    for key, value in payload.items():
        if key in _SETTINGS_NUMERIC:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                # Tolerate a numeric string, else 400 (structural type error).
                try:
                    value = float(value)
                except (TypeError, ValueError):
                    raise HTTPException(400, f"{key} は数値で指定してください。")
            merged[key] = value
        elif key == "currency":
            merged[key] = str(value)
        elif key == "productivity_overrides":
            # 生産性フィードバック: a {process_id: rate} map of 実測採用値. Keep only
            # positive-number values; an empty/invalid map clears the overrides.
            ov = {}
            if isinstance(value, dict):
                for pk, pv in value.items():
                    try:
                        f = float(pv)
                    except (TypeError, ValueError):
                        continue
                    if f > 0:
                        ov[str(pk)] = f
            merged[key] = ov
        elif key == "brand":
            # 提案書ブランドテーマ: merge known string fields into the existing brand
            # (so a logo_path set by the upload endpoint survives a text-only save);
            # anything else is ignored. All values are coerced to strings.
            cur_brand = merged.get("brand")
            b = dict(cur_brand) if isinstance(cur_brand, dict) else {}
            if isinstance(value, dict):
                for bk in ("company_name", "client_name", "accent_color",
                           "logo_path", "footer_note"):
                    if bk in value and value[bk] is not None:
                        b[bk] = str(value[bk])
            merged["brand"] = b
        elif key == "wording":
            # 提案書の用語ガード: normalise through whsim.wording so only the four
            # known sections survive (禁止語/正規表現/言い換え/例外) and a malformed
            # guide can never land in the model. {} clears it = 検査を無効に戻す.
            from whsim import wording as _wording
            merged["wording"] = _wording.normalise_rules(value)
        # Unknown keys: ignored (forward-compatible, never fatal).
    md["settings"] = merged

    # Re-validate the whole document so a structurally broken edit rolls back.
    # If the schema does not yet declare `settings`, validation ignores it
    # (extra fields), which is fine: we persist the raw dict ourselves below.
    try:
        WarehouseModel.model_validate(md)
    except ValidationError as e:
        raise HTTPException(400, f"invalid value: {e.errors()[0].get('msg', 'validation error')}")

    # Persist by writing the merged document directly (NOT save_model, which
    # round-trips through model_dump_json and would drop a not-yet-schema'd key).
    proj.model_file.write_text(json.dumps(md, ensure_ascii=False, indent=2), "utf-8")
    prov = proj.load_provenance()
    prov.mark("settings", Source.INTERVIEW)
    proj.save_provenance(prov)
    return {"ok": True, "settings": merged}


# Accepted brand-logo image signatures (magic bytes). PNG/JPEG/GIF are what
# python-pptx and reportlab reliably embed; a non-image upload is rejected here
# so a bad file never reaches the export cover (which also guards it).
_LOGO_SIGNATURES = (
    b"\x89PNG\r\n\x1a\n",  # PNG
    b"\xff\xd8\xff",       # JPEG
    b"GIF87a", b"GIF89a",  # GIF
)


@router.post("/api/projects/{name}/brand/logo")
async def api_upload_brand_logo(name: str, file: UploadFile):
    """Store a proposal brand logo under ``projects/<name>/brand/logo.png`` and
    point ``settings.brand.logo_path`` at it so the PPTX/PDF cover picks it up.

    Tolerant: a non-image (or oversized) upload is a friendly 400/413, never a
    500. The bytes are stored verbatim (the export sniffs image type by content,
    not the filename), so a JPEG/GIF is fine even though the file is named .png."""
    proj = _open(name)
    data = await _read_upload(file)
    if not any(data.startswith(sig) for sig in _LOGO_SIGNATURES):
        raise HTTPException(400, "画像ファイル（PNG / JPEG / GIF）を指定してください。")
    brand_dir = proj.root / "brand"
    brand_dir.mkdir(parents=True, exist_ok=True)
    rel = "brand/logo.png"
    (proj.root / rel).write_bytes(data)

    # Persist the project-relative path into settings.brand.logo_path (create the
    # settings/brand subtrees as needed). Written straight to disk so it survives
    # whether or not save_model would round-trip the key.
    md = json.loads(proj.model_file.read_text("utf-8"))
    settings = md.get("settings")
    if not isinstance(settings, dict):
        settings = {}
    brand = settings.get("brand")
    if not isinstance(brand, dict):
        brand = {}
    brand["logo_path"] = rel
    settings["brand"] = brand
    md["settings"] = settings
    proj.model_file.write_text(json.dumps(md, ensure_ascii=False, indent=2), "utf-8")
    prov = proj.load_provenance()
    prov.mark("settings", Source.INTERVIEW)
    proj.save_provenance(prov)
    return {"ok": True, "logo_path": rel}


@router.get("/api/projects/{name}/workmethod/recommend")
def api_workmethod_recommend(name: str):
    """Suggest a work method for the loaded project's order profile."""
    from whsim import workmethod
    proj = _open(name)
    model = proj.load_model()
    return workmethod.recommend(model).to_dict()


@router.post("/api/projects/{name}/assign-inventory")
def api_assign_inventory(name: str, payload: dict | None = None):
    """Slot the loaded inventory (SKUs) onto the created storage locations."""
    from whsim import slotting
    proj = _open(name)
    model = proj.load_model()
    strategy = (payload or {}).get("strategy", "abc")
    summary = slotting.assign_inventory(model, strategy=strategy)
    proj.save_model(model)
    prov = proj.load_provenance()
    prov.mark("locations", Source.INTERVIEW)
    proj.save_provenance(prov)
    return summary


@router.post("/api/projects/{name}/headline")
def api_headline(name: str, payload: dict):
    proj = _open(name)
    md = json.loads(proj.model_file.read_text("utf-8"))
    prov = proj.load_provenance()
    for path, value in payload.items():
        try:
            subtree = _set_by_path(md, path, value)
        except (KeyError, IndexError, ValueError, TypeError) as e:
            raise HTTPException(400, f"invalid field path {path!r}: {e}")
        prov.mark(subtree, Source.INTERVIEW)
    from pydantic import ValidationError

    from whsim.schema.model import WarehouseModel
    try:
        model = WarehouseModel.model_validate(md)
    except ValidationError as e:
        raise HTTPException(400, f"invalid value: {e.errors()[0].get('msg', 'validation error')}")
    proj.save_model(model)
    proj.save_provenance(prov)
    return {"ok": True, "provenance_summary": prov.summary()}
