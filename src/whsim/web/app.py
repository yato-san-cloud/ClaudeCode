"""FastAPI app: the salesperson-facing web product.

Wraps the whsim core (templates, importer, engine, KPIs, renderers) behind a
small REST API and serves the single-page frontend. The frontend lets a
salesperson pick a template, drop in a customer ZIP, confirm a few headline
numbers, run the simulation, and watch an animated 2D/3D replay -- all without
touching simulation vocabulary.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from whsim import analytic, cody, kpis as kpi_mod, templates
from whsim.engine.run import run_replications
from whsim.project import Project
from whsim.provenance import Source
from whsim.render.png2d import render as render_png
from whsim.render.replay import build_replay

STATIC = Path(__file__).resolve().parent / "static"

# Monte-Carlo replications behind every web run (variability is shown, not configured).
MONTE_CARLO_REPS = 10

app = FastAPI(title="whsim", version="0.1.0")

# Bound concurrent heavy runs so a burst of /run(-scenarios) can't saturate the
# worker thread pool and starve the rest of the API. The event loop is single-
# threaded, so a plain counter is race-free (no lock needed).
MAX_INFLIGHT_RUNS = 6
_inflight_runs = 0


def _enter_run() -> None:
    global _inflight_runs
    if _inflight_runs >= MAX_INFLIGHT_RUNS:
        raise HTTPException(429, "現在シミュレーションが混み合っています。少し待ってから再実行してください。")
    _inflight_runs += 1


def _exit_run() -> None:
    global _inflight_runs
    _inflight_runs = max(0, _inflight_runs - 1)


def _safe_name(name: str) -> str:
    """Validate a user-supplied identifier that becomes a filesystem path segment.

    Project names (and run/compare ids) are used directly under ``projects/`` and
    ``runs/`` (``base / name``), so an attacker-controlled ``..`` or path
    separator must never escape the workspace.

    Crucially we don't just *check* the raw name and pass it through: the actual
    on-disk segment is decided by ``whsim.project.safe_name`` (called inside
    ``Project.create`` / ``Project.open``), which silently transforms unsafe
    characters (``a:b`` -> ``a_b``, control chars -> ``_``, ...). The web layer
    used to apply a *different*, looser check, so path-building endpoints
    (delete / rename / duplicate / compare-png) computed ``projects/<raw>`` while
    the project actually lived at ``projects/<sanitised>`` -- a real bug that
    pointed those operations at the wrong (or a non-existent) directory.

    The fix: reject (400) anything that is not already in canonical form, i.e.
    any name the project sanitiser would have transformed. That keeps a single
    source of truth (the accepted name == the stored segment) and still rejects
    separators / NUL / dot-only names exactly as before.
    """
    name = (name or "").strip()
    if not name or set(name) <= {"."}:
        raise HTTPException(400, "invalid name")
    if "/" in name or "\\" in name or "\x00" in name or name in (".", ".."):
        raise HTTPException(400, "invalid name")
    # Single source of truth: the name must already be exactly what the project
    # sanitiser would store, so the segment used for path building can never
    # diverge from where the project actually lives on disk.
    from whsim.project import safe_name as _project_safe_name
    try:
        if _project_safe_name(name) != name:
            raise HTTPException(400, "invalid name")
    except (ValueError, TypeError):
        raise HTTPException(400, "invalid name")
    return name


def _set_by_path(model_dict: dict, path: str, value) -> str:
    """Set a dotted path like 'resources.workers.0.count'; return top subtree."""
    parts = path.split(".")
    cur = model_dict
    for p in parts[:-1]:
        cur = cur[int(p)] if p.isdigit() else cur[p]
    last = parts[-1]
    if last.isdigit():
        cur[int(last)] = value
    else:
        cur[last] = value
    return parts[0]


# ---- API --------------------------------------------------------------------

@app.get("/favicon.ico")
def favicon():
    # No icon asset shipped; answer 204 so the browser stops logging a 404.
    return Response(status_code=204)


@app.get("/api/templates")
def api_templates():
    return templates.list_templates()


@app.get("/api/materialflow/seed")
def api_materialflow_seed():
    """Material-flow skeleton (process flow + units/productivity) for the
    荷役物量 authoring screen."""
    from whsim.analysis import staffing
    return {"flow": staffing.flow_seed()}


@app.post("/api/materialflow/generate")
def api_materialflow_generate(payload: dict | None = None):
    """不足データ作成: estimate every process's 荷役物量 from a partial base."""
    from whsim.analysis import staffing
    base = (payload or {}).get("base") or {}
    return {"volumes": staffing.generate_flow_volumes(base)}


@app.post("/api/materialflow/scenario")
def api_materialflow_scenario(payload: dict | None = None):
    """Turn authored per-process 荷役物量 into a timetable scenario (→ 人員配置)."""
    from whsim.analysis import staffing
    volumes = (payload or {}).get("volumes") or {}
    return staffing.scenario_from_volumes(volumes)


@app.get("/api/racktypes")
def api_racktypes():
    """Storage-equipment presets (軽量棚/中量棚/パレットラック/ネステナー/…) for the
    designer's 棚種別 picker — each with cell footprint, capacity and colour."""
    from whsim import racktypes
    return racktypes.catalog()


@app.post("/api/cody/chat")
def api_cody_chat(payload: dict):
    """Cody mascot chat: turn a Japanese message into a reply + intent.

    Assembles a context (available templates, and — if a project is named and
    cheap to read — whether it has a finished run plus its latest KPIs) and
    delegates ALL dialogue/intent decisions to ``cody.respond`` (the LLM seam).
    This endpoint never executes whsim actions: the frontend runs the returned
    intent against the existing endpoints. Honours "never blocks": any read that
    fails leaves ``has_run``/``kpis`` as their safe defaults (False / None).
    """
    # Coerce defensively: the frontend always sends strings, but a stray number
    # / object must not 500 the chat seam (cody.respond expects a str message).
    raw_msg = payload.get("message")
    message = raw_msg if isinstance(raw_msg, str) else ("" if raw_msg is None else str(raw_msg))
    raw_proj = payload.get("project")
    project = raw_proj if isinstance(raw_proj, str) else None

    has_run = False
    kpis = None
    if project:
        try:
            proj = Project.open(project)
            rd = proj.latest_run_dir()
            if rd is not None and (rd / "kpis.json").is_file():
                has_run = True
                kpis = json.loads((rd / "kpis.json").read_text("utf-8"))
        except Exception:  # noqa: BLE001 — context is best-effort, never fatal
            has_run = False
            kpis = None

    context = {
        "project": project,
        "templates": templates.list_templates(),
        "has_run": has_run,
        "kpis": kpis,
    }
    result = cody.respond(message, context)
    result["project"] = project
    return result


@app.get("/api/projects")
def api_projects():
    from whsim.project import PROJECTS_DIR
    if not PROJECTS_DIR.is_dir():
        return []
    return sorted(p.name for p in PROJECTS_DIR.iterdir()
                  if (p / "project.json").is_file())


@app.post("/api/projects")
def api_create(payload: dict):
    name = _safe_name(payload.get("name") or "")
    template = payload.get("template") or "ecommerce_small"
    try:
        proj = Project.create(name, template)
    except FileNotFoundError:
        # Unknown template id: a clean 400, not a 500.
        raise HTTPException(400, f"unknown template {template!r}")
    return {"name": name, "template": template, "root": str(proj.root)}


def _free_project_name(preferred: str) -> str:
    """Pick a non-colliding project name. Try `preferred`, then `demo-2`,
    `demo-3`, ... so the one-click demo never fails because a name is taken."""
    from whsim.project import PROJECTS_DIR

    def taken(n: str) -> bool:
        return (PROJECTS_DIR / n / "project.json").is_file()

    if not taken(preferred):
        return preferred
    base = preferred if preferred != "デモ" else "demo"
    i = 2
    while taken(f"{base}-{i}"):
        i += 1
    return f"{base}-{i}"


def _sample_zip_path() -> Path | None:
    """Locate the bundled sample ZIP under the repo's examples/, generating it
    on demand if the helper is available. Returns None if nothing can be found."""
    # Resolve examples/ relative to the installed package's repo root.
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / "examples" / "acme_upload.zip"
        if cand.is_file():
            return cand
    # Not present: try to generate it via the bundled script (best effort).
    for parent in here.parents:
        script = parent / "scripts" / "gen_sample_data.py"
        if script.is_file():
            try:
                import runpy
                runpy.run_path(str(script), run_name="__main__")
            except Exception:  # noqa: BLE001 — generation is best effort
                pass
            cand = parent / "examples" / "acme_upload.zip"
            return cand if cand.is_file() else None
    return None


@app.post("/api/projects/sample")
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


def _project_dir(name: str) -> Path:
    """Resolve a validated project name to its directory under PROJECTS_DIR.

    Read PROJECTS_DIR lazily on each call so tests that monkeypatch it (into a
    tmp dir) are honoured. The name is validated with ``_safe_name`` first, so
    no separator / traversal can escape the workspace."""
    from whsim.project import PROJECTS_DIR
    return PROJECTS_DIR / _safe_name(name)


@app.delete("/api/projects/{name}")
def api_delete(name: str):
    """Delete a project workspace and all its artifacts."""
    d = _project_dir(name)
    if not (d / "project.json").is_file():
        raise HTTPException(404, f"no project {name!r}")
    shutil.rmtree(d, ignore_errors=False)
    return {"ok": True}


@app.post("/api/projects/{name}/rename")
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


@app.post("/api/projects/{name}/duplicate")
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


@app.get("/api/projects/{name}/model")
def api_model(name: str):
    proj = _open(name)
    manifest = templates.load_manifest(proj.meta()["template_id"])
    model = proj.load_model()
    return {
        "name": name,
        "headline_fields": manifest.get("headline_fields", []),
        "headline_values": _headline_values(model.model_dump(), manifest),
        "provenance": proj.load_provenance().to_dict(),
        "provenance_summary": proj.load_provenance().summary(),
    }


@app.get("/api/projects/{name}/full")
def api_full(name: str):
    """The full model document, for the interactive design editor."""
    proj = _open(name)
    return JSONResponse(json.loads(proj.model_file.read_text("utf-8")))


@app.post("/api/projects/{name}/design")
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


@app.post("/api/projects/{name}/apply")
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
)


@app.get("/api/projects/{name}/settings")
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


@app.put("/api/projects/{name}/settings")
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


@app.post("/api/workmethod/name")
def api_workmethod_name(payload: dict | None = None):
    """Reverse-name a 5-axis WorkMethod: return {name, explain}.

    Stateless: the floor-plan editor POSTs the axes a salesperson is turning and
    immediately shows "＝<name>" plus a plain-language explanation, so a novice
    sees what the combination is called and an expert recognises it."""
    from whsim import workmethod
    from whsim.schema.model import WorkMethod
    work = WorkMethod.model_validate(payload or {})
    return {"name": workmethod.method_name(work),
            "explain": workmethod.explain(work)}


@app.get("/api/projects/{name}/workmethod/recommend")
def api_workmethod_recommend(name: str):
    """Suggest a work method for the loaded project's order profile."""
    from whsim import workmethod
    proj = _open(name)
    model = proj.load_model()
    return workmethod.recommend(model).to_dict()


@app.get("/api/timetable/seed")
def api_timetable_seed():
    """Bundled work-timetable dataset (process master + productivity + scenarios).

    The タイムチャート tab fetches this once and then re-solves entirely client-side
    as the user drags sliders, so live recalc has zero round-trip latency."""
    from whsim import timetable
    seed = timetable.load_seed()
    seed["section_color"] = timetable.SECTION_COLOR
    seed["section_zone_type"] = timetable.SECTION_ZONE_TYPE
    return seed


@app.post("/api/timetable/solve")
def api_timetable_solve(payload: dict | None = None):
    """Solve a staffing timetable. Stateless server-side mirror of the JS solver.

    Body: {scenario: name|object, processes?, productivity?}. Missing process /
    productivity masters fall back to the bundled seed; a string `scenario`
    selects a seed scenario by name. Used for tests, headless runs and export."""
    from whsim import timetable
    seed = timetable.load_seed()
    p = payload or {}
    processes = p.get("processes") or seed["processes"]
    productivity = p.get("productivity") or seed["productivity"]
    scenario = p.get("scenario")
    if isinstance(scenario, str):
        scenario = seed["scenarios"].get(scenario)
    if not isinstance(scenario, dict):
        scenario = next(iter(seed["scenarios"].values()))
    return timetable.solve(scenario, processes, productivity)


@app.get("/api/analysis/sample")
def api_analysis_sample():
    """Run the full data-analysis suite on the bundled demo WMS dataset.

    Powers the データ分析 tab's「サンプルで試す」: no upload needed, returns the
    whole bundle (KPIs, insights, trend, ABC, peak, turnover, forecast, …)."""
    from whsim.analysis.report import sample_bundle
    return sample_bundle()


@app.post("/api/analysis/upload")
async def api_analysis_upload(shipments: UploadFile, inbound: UploadFile | None = None,
                              inventory: UploadFile | None = None):
    """Analyse uploaded WMS files (出荷 required; 入荷/在庫 optional).

    Columns are auto-mapped heuristically (data_io.initial_mapping); the standard
    suite then runs and returns the same bundle shape as /api/analysis/sample."""
    import pandas as pd

    from whsim.analysis import report
    from whsim.analysis.data_io import (
        INBOUND_FIELDS,
        INVENTORY_FIELDS,
        SHIPMENT_FIELDS,
        apply_mapping,
        initial_mapping,
        load_table,
    )

    async def load(uf, fields):
        if uf is None:
            return pd.DataFrame()
        raw = await uf.read()
        try:
            df = load_table(raw, uf.filename)
        except Exception as e:  # noqa: BLE001 — surface a friendly 400
            raise HTTPException(400, f"読込に失敗しました（{uf.filename}）: {e}") from e
        return apply_mapping(df, initial_mapping(df, fields), fields)

    ship = await load(shipments, SHIPMENT_FIELDS)
    if ship.empty:
        raise HTTPException(400, "出荷データを読み込めませんでした。列名をご確認ください。")
    inb = await load(inbound, INBOUND_FIELDS)
    inv = await load(inventory, INVENTORY_FIELDS)
    bundle = report.run_all(ship, inb, inv)
    bundle["source"] = "upload"
    return bundle


MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB hard cap on any single upload


async def _read_upload(file: UploadFile, max_bytes: int = MAX_UPLOAD_BYTES) -> bytes:
    """Read an upload in chunks with a hard size cap so a huge (or malicious)
    file can't exhaust memory. Raises 413 once the cap is exceeded."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1 << 20)  # 1 MiB at a time
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(413, f"ファイルが大きすぎます（上限 {max_bytes // (1024 * 1024)}MB）。")
        chunks.append(chunk)
    return b"".join(chunks)


@app.post("/api/projects/{name}/import-cad")
async def api_import_cad(name: str, file: UploadFile):
    """Import a DXF floor plan -> merge its bounds/walls/zones into the layout."""
    from whsim import cad
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    data = await _read_upload(file)
    try:
        res = cad.import_dxf_bytes(data)
    except Exception as e:  # noqa: BLE001 — tolerant: never 500 on a bad drawing
        raise HTTPException(400, f"DXF を解析できませんでした: {e}")
    md = json.loads(proj.model_file.read_text("utf-8"))
    if res.get("bounds"):
        md["layout"]["bounds"] = res["bounds"]
    if res.get("walls"):
        md["layout"]["walls"] = res["walls"]
    if res.get("zones"):
        md["layout"]["zones"] = res["zones"]
    model = WarehouseModel.model_validate(md)
    proj.save_model(model)
    prov = proj.load_provenance()
    prov.mark("layout", Source.IMPORTED)
    proj.save_provenance(prov)
    return {"bounds": res.get("bounds"), "walls": len(res.get("walls", [])),
            "zones": len(res.get("zones", [])), "warnings": res.get("warnings", []),
            "stats": res.get("stats", {})}


@app.post("/api/projects/{name}/import-mapcsv")
async def api_import_mapcsv(name: str, file: UploadFile):
    """Import a MapMaker (Hitachi WorldMap) Map CSV -> shelves/walls/stations.

    SHELF areas become a storage zone's authored `shelves`; locations then
    materialise inside the drawn shelves (MapMaker SHELF → cells)."""
    from whsim import design, mapcsv
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    data = await _read_upload(file)
    try:
        res = mapcsv.import_mapcsv_bytes(data)
    except Exception as e:  # noqa: BLE001 — tolerant: never 500 on a bad map
        raise HTTPException(400, f"Map CSV を解析できませんでした: {e}")
    md = json.loads(proj.model_file.read_text("utf-8"))
    if res.get("bounds"):
        md["layout"]["bounds"] = res["bounds"]
    if res.get("walls"):
        md["layout"]["walls"] = res["walls"]
    if res.get("zones"):
        md["layout"]["zones"] = res["zones"]
    if res.get("stations"):
        md.setdefault("resources", {})["stations"] = res["stations"]
    model = WarehouseModel.model_validate(md)
    design.materialize_racks(model)   # authored shelves -> location cells
    design.synthesize_items(model)    # ensure demand so the sim stays runnable
    proj.save_model(model)
    prov = proj.load_provenance()
    prov.mark("layout", Source.IMPORTED)
    proj.save_provenance(prov)
    return {"bounds": res.get("bounds"),
            "shelves": res.get("stats", {}).get("shelves", 0),
            "walls": len(res.get("walls", [])), "zones": len(res.get("zones", [])),
            "stations": len(res.get("stations", [])),
            "locations": len(model.locations),
            "warnings": res.get("warnings", []), "stats": res.get("stats", {})}


_TABLE_FIELDS = {"shipments": "SHIPMENT_FIELDS", "inbound": "INBOUND_FIELDS",
                 "master": "INVENTORY_FIELDS"}


@app.post("/api/projects/{name}/import-table")
async def api_import_table(name: str, file: UploadFile, kind: str = "shipments",
                           mapping: str | None = None):
    """Unified 入荷/出荷/商品マスタ import with column mapping.

    Loads a CSV/Excel, maps columns to whsim field keys (auto-detected, or the
    caller's `mapping` JSON), and builds model subtrees: 出荷→outbound orders,
    商品マスタ→items, 入荷→(counts; feeds 物量/analysis). Returns the *used* mapping +
    the file's columns so the UI can show/correct it. Tolerant: never 500."""
    import json as _json

    from whsim import design, tabular
    from whsim.analysis import data_io
    proj = _open(name)
    data = await _read_upload(file)
    fields = getattr(data_io, _TABLE_FIELDS.get(kind, "SHIPMENT_FIELDS"))
    try:
        df = data_io.load_table(data, file.filename)
    except Exception as e:  # noqa: BLE001 — tolerant
        raise HTTPException(400, f"表を読み込めませんでした: {e}")
    mp = _json.loads(mapping) if mapping else data_io.initial_mapping(df, fields)
    std = data_io.apply_mapping(df, mp, fields)

    model = proj.load_model()
    counts: dict = {}
    prov_key = "orders"
    if kind == "master":
        items = tabular.build_items(std)
        if items:
            model.items = items
        counts["items"] = len(items)
        prov_key = "items"
    elif kind == "inbound":
        counts["inbound_lines"] = int(len(std))
    else:  # shipments
        orders = tabular.build_orders(std, model.simulation.duration_s or 3600.0)
        if orders:
            model.orders.outbound = orders
        counts["orders"] = len(orders)
        counts["lines"] = int(len(std))
    design.materialize_racks(model)   # re-peg onto storage slots
    proj.save_model(model)
    prov = proj.load_provenance()
    if counts.get("orders") or counts.get("items"):
        prov.mark(prov_key, Source.IMPORTED)
    proj.save_provenance(prov)
    return {
        "kind": kind, "counts": counts, "columns": list(df.columns),
        "mapping": {f.key: {"label": f.label, "required": f.required,
                            "column": mp.get(f.key)} for f in fields},
        "provenance_summary": prov.summary(),
    }


@app.get("/api/projects/{name}/notes")
def api_notes_list(name: str, anchor: str | None = None):
    """知見ボード: anchored notes for a project (newest first)."""
    from whsim import notes
    return {"notes": notes.list_notes(_open(name), anchor)}


@app.post("/api/projects/{name}/notes")
def api_notes_add(name: str, payload: dict):
    """Post a note pinned to an anchor (生産性/工程/シナリオ/設計/結果/general…)."""
    from whsim import notes
    p = payload or {}
    try:
        return notes.add_note(_open(name), p.get("anchor", "general"),
                              p.get("author", ""), p.get("text", ""))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/projects/{name}/notes/{note_id}")
def api_notes_delete(name: str, note_id: str):
    from whsim import notes
    return {"ok": notes.delete_note(_open(name), note_id)}


@app.post("/api/projects/{name}/generate-missing")
def api_generate_missing(name: str):
    """不足データ作成: derive missing masters (商品マスタ/ピック頻度/在庫) from the
    real demand already in the model, then re-slot. Marked GENERATED in provenance
    so the % real-data figure never overstates inferred data."""
    from whsim import datagen, design
    proj = _open(name)
    model = proj.load_model()
    summary = datagen.generate_missing(model)
    design.materialize_racks(model)   # re-peg generated items onto storage slots
    proj.save_model(model)
    prov = proj.load_provenance()
    for st in summary.get("subtrees", []):
        prov.mark(st, Source.GENERATED)
    proj.save_provenance(prov)
    return {**summary, "provenance_summary": prov.summary()}


@app.post("/api/projects/{name}/assign-inventory")
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


@app.post("/api/projects/{name}/import-distances")
async def api_import_distances(name: str, file: UploadFile):
    """Import a measured shelf-to-shelf distance matrix (CSV/JSON) to refine routing."""
    from whsim import distances
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    data = await _read_upload(file)
    try:
        res = distances.import_distance_matrix_bytes(data, file.filename or "")
    except Exception as e:  # noqa: BLE001 — tolerant
        raise HTTPException(400, f"距離データを解析できませんでした: {e}")
    md = json.loads(proj.model_file.read_text("utf-8"))
    md["distance_overrides"] = res.get("pairs", {})
    proj.save_model(WarehouseModel.model_validate(md))
    return {"count": res.get("count", 0), "ids": len(res.get("ids", [])),
            "symmetric": res.get("symmetric", False),
            "warnings": res.get("warnings", [])}


def _latest_compare(proj: Project) -> dict | None:
    """Load the most recent persisted scenario comparison (``compare_*/compare.json``),
    or None if no comparison has been run. Never raises."""
    try:
        comps = sorted(proj.runs_dir.glob("compare_*"))
    except Exception:  # noqa: BLE001
        return None
    for d in reversed(comps):
        f = d / "compare.json"
        if f.is_file():
            try:
                data = json.loads(f.read_text("utf-8"))
                if isinstance(data, dict):
                    return data
            except Exception:  # noqa: BLE001 — skip a corrupt record
                continue
    return None


def _proposal_extras(proj: Project, model, metrics: dict) -> dict:
    """Assemble the richer optional args for export_doc from project artifacts.

    Returns ``{"scenarios", "insights", "provenance"}``:
      - ``scenarios``: the latest persisted what-if comparison (baseline +
        alternatives w/ payback), or None.
      - ``insights``: the SAME recommendation list the analysis dashboard shows,
        reused via ``_analysis_payload`` so the two never drift.
      - ``provenance``: the "N% your data" summary string.
    Every step degrades to None on missing/broken data so export never 500s."""
    scenarios = _latest_compare(proj)
    insights = None
    try:
        insights = _analysis_payload(model, metrics, "run").get("insights")
    except Exception:  # noqa: BLE001 — insights are an enhancement, never required
        insights = None
    try:
        provenance = proj.load_provenance().summary()
    except Exception:  # noqa: BLE001
        provenance = None
    return {"scenarios": scenarios, "insights": insights, "provenance": provenance}


def _call_export(builder, kpis, model_name, prov, png, out, extras: dict):
    """Call an export_doc builder, passing the richer optional args when the
    builder accepts them (export owner adds scenarios/insights/provenance). Falls
    back to the original positional signature if those params are absent, so the
    endpoint works against either version of export_doc."""
    try:
        return builder(kpis, model_name, prov, png, out,
                       scenarios=extras.get("scenarios"),
                       insights=extras.get("insights"),
                       provenance=extras.get("provenance"))
    except TypeError:
        # Older export_doc without the new optional params.
        return builder(kpis, model_name, prov, png, out)


@app.get("/api/projects/{name}/proposal.{fmt}")
def api_proposal(name: str, fmt: str):
    """Generate an editable PPTX or a PDF proposal from the latest run.

    Enriches the deliverable with the latest scenario comparison, the analysis
    dashboard's recommendations (shared via ``_analysis_payload``), and the
    provenance summary. Degrades gracefully: missing scenarios/insights are
    simply omitted, never a 500. Response/download behavior is unchanged."""
    from whsim import export_doc
    if fmt not in ("pptx", "pdf"):
        raise HTTPException(404, "unknown format")
    proj = _open(name)
    rd = proj.latest_run_dir()
    if rd is None or not (rd / "kpis.json").is_file():
        raise HTTPException(404, "no run yet")
    kpis = json.loads((rd / "kpis.json").read_text("utf-8"))
    png = rd / "layout_heatmap.png"
    out = rd / f"proposal.{fmt}"
    prov = proj.load_provenance().summary()
    try:
        extras = _proposal_extras(proj, proj.load_model(), kpis)
    except Exception:  # noqa: BLE001 — fall back to the bare proposal
        extras = {"scenarios": None, "insights": None, "provenance": prov}
    builder = export_doc.build_pptx if fmt == "pptx" else export_doc.build_pdf
    _call_export(builder, kpis, proj.meta()["name"], prov,
                 png if png.is_file() else None, out, extras)
    media = ("application/vnd.openxmlformats-officedocument.presentationml.presentation"
             if fmt == "pptx" else "application/pdf")
    return FileResponse(out, media_type=media, filename=f"{name}_提案書.{fmt}")


@app.post("/api/projects/{name}/headline")
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


@app.post("/api/projects/{name}/import")
async def api_import(name: str, file: UploadFile):
    import tempfile
    proj = _open(name)
    # Write to a temp file; Project.import_zip copies it into the project's raw/.
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tf:
        tf.write(await _read_upload(file))
        tmp = Path(tf.name)
    try:
        res = proj.import_zip(tmp)
    finally:
        tmp.unlink(missing_ok=True)
    return {
        "files": res.files_seen,
        "updated": sorted(res.touched_subtrees),
        "warnings": res.warnings,
        "provenance_summary": proj.load_provenance().summary(),
    }


def _run_blocking(proj: Project) -> dict:
    """The CPU-bound heart of a run (SimPy + KPIs + render + disk writes).

    Pulled out so the endpoint can hand it to a worker thread via
    ``run_in_threadpool``: the heavyweight discrete-event simulation must never
    execute on the event loop, or the whole server stalls for its duration."""
    model = proj.load_model()
    # Monte-Carlo: many stochastic order sequences; rep 0 carries the replay.
    results, heat = run_replications(model, reps=MONTE_CARLO_REPS)
    res = results[0]
    metrics = kpi_mod.compute(results, model)
    est = analytic.estimate(model)

    run_dir = proj.new_run_dir()
    (run_dir / "kpis.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2), "utf-8")
    import numpy as np
    np.save(run_dir / "heatmap.npy", heat)
    replay = build_replay(model, res, metrics)
    # Carry provenance so the proposal sheet's "実データ N%" bar lights up
    # (real_pct = imported + confirmed share; never fabricated).
    _prov = proj.load_provenance()
    replay["provenance"] = {"real_pct": round(_prov.confidence() * 100, 1),
                            "summary": _prov.summary()}
    (run_dir / "replay.json").write_text(
        json.dumps(replay, ensure_ascii=False), "utf-8")
    render_png(model, heat, metrics, proj.load_provenance().summary(),
               run_dir / "layout_heatmap.png")
    return {"kpis": metrics, "estimate": est, "run": run_dir.name}


@app.post("/api/projects/{name}/run")
async def api_run(name: str):
    proj = _open(name)
    # Offload the blocking SimPy run to a worker thread so concurrent requests
    # (e.g. /api/templates) stay responsive while a run is in flight; cap how
    # many heavy runs are in flight so a burst can't exhaust the thread pool.
    _enter_run()
    try:
        return await run_in_threadpool(_run_blocking, proj)
    finally:
        _exit_run()


def _run_scenarios_blocking(name: str, proj: Project, payload: dict) -> dict:
    """CPU-bound what-if comparison: runs every scenario through SimPy + render.

    Run in a worker thread (see ``api_run_scenarios``) so a multi-scenario
    comparison never blocks the event loop."""
    from whsim.engine.scenarios import (
        apply_scenario, default_scenarios, payback_months, run_scenario,
    )
    from whsim.schema.model import Scenario
    base = proj.load_model()

    raw = payload.get("scenarios")
    scenarios = ([Scenario.model_validate(s) for s in raw] if raw
                 else default_scenarios(base))

    # Derive a fresh compare id WITHOUT calling new_run_dir(): that helper
    # creates (and leaves) an empty run_NNNN directory, which would become the
    # project's latest_run_dir() and break /proposal, /png and /replay (they
    # require a kpis.json that an empty scenario dir never has). Index off both
    # existing run_* and compare_* dirs so ids stay monotonic and never collide.
    proj.runs_dir.mkdir(parents=True, exist_ok=True)
    import re as _re
    existing = [int(m.group(1)) for p in proj.runs_dir.glob("*")
                if (m := _re.fullmatch(r"(?:run|compare)_(\d+)", p.name))]
    nxt = (max(existing) + 1) if existing else 1
    cmp_id = f"compare_{nxt:04d}"
    cmp_dir = proj.runs_dir / cmp_id
    cmp_dir.mkdir(parents=True, exist_ok=True)
    prov = proj.load_provenance().summary()

    results = []
    for i, sc in enumerate(scenarios):
        res, metrics = run_scenario(base, sc, reps=6)
        model_i = apply_scenario(base, sc)
        render_png(model_i, res.heat, metrics, prov, cmp_dir / f"s{i}.png")
        results.append({"name": sc.name, "description": sc.description,
                        "kpis": metrics,
                        "png_url": f"/api/projects/{name}/compare-png/{cmp_id}/{i}"})

    baseline = results[0]
    alternatives = results[1:]
    for alt in alternatives:
        pb = payback_months(baseline["kpis"], alt["kpis"])
        alt["kpis"]["payback_months"] = pb
    out = {"compare_id": cmp_id, "baseline": baseline, "alternatives": alternatives}
    # Persist the comparison so the proposal export can include scenario tables
    # without re-running the (expensive) sweep. PNG urls are dropped to keep the
    # on-disk record self-contained.
    try:
        (cmp_dir / "compare.json").write_text(
            json.dumps(out, ensure_ascii=False, indent=2), "utf-8")
    except Exception:  # noqa: BLE001 — persistence is best effort, never fatal
        pass
    return out


@app.post("/api/projects/{name}/run-scenarios")
async def api_run_scenarios(name: str, payload: dict | None = None):
    """Run several what-ifs over the current model and return a comparison."""
    proj = _open(name)
    # Offload the (heavier still) multi-scenario sweep to a worker thread.
    _enter_run()
    try:
        return await run_in_threadpool(_run_scenarios_blocking, name, proj, payload or {})
    finally:
        _exit_run()


@app.get("/api/projects/{name}/compare-png/{cmp}/{i}")
def api_compare_png(name: str, cmp: str, i: int):
    proj = _open(name)
    cmp = _safe_name(cmp)
    png = proj.runs_dir / cmp / f"s{i}.png"
    if not png.is_file():
        raise HTTPException(404, "no such comparison image")
    return FileResponse(png)


@app.get("/api/projects/{name}/analysis")
def api_analysis(name: str):
    """Analysis-dashboard payload (the "分析" tab).

    Consolidates an analysis-tool-style summary INTO whsim: it reshapes the
    project's KPIs into insights ("指摘 -> 提案"), a hero/grouped KPI hierarchy,
    and a couple of small chart series. Honours whsim's "never blocks" invariant:
    if no SimPy run exists yet it falls back to the closed-form analytic estimate
    so the view always has something to show.
    """
    proj = _open(name)
    model = proj.load_model()
    rd = proj.latest_run_dir()
    source = "run"
    if rd is not None and (rd / "kpis.json").is_file():
        metrics = json.loads((rd / "kpis.json").read_text("utf-8"))
    else:
        # No heavyweight run yet: instant analytic estimate keeps the view alive.
        metrics = analytic.estimate(model)
        source = "estimate"
    return _analysis_payload(model, metrics, source)


@app.get("/api/projects/{name}/replay")
def api_replay(name: str):
    proj = _open(name)
    rd = proj.latest_run_dir()
    if rd is None or not (rd / "replay.json").is_file():
        raise HTTPException(404, "no run yet")
    return JSONResponse(json.loads((rd / "replay.json").read_text("utf-8")))


@app.get("/api/projects/{name}/png")
def api_png(name: str):
    proj = _open(name)
    rd = proj.latest_run_dir()
    if rd is None or not (rd / "layout_heatmap.png").is_file():
        raise HTTPException(404, "no png yet")
    return FileResponse(rd / "layout_heatmap.png")


def _analysis_payload(model, metrics: dict, source: str) -> dict:
    """Reshape whsim KPIs into the analysis-dashboard contract.

    Output:
      {
        source: "run" | "estimate",
        verdict: str | None,
        insights: [{severity, icon, title, fact, metric, action}],
        kpis: {hero: [{label, value, unit, delta}],
               groups: [{label, items:[{label, value, unit}]}]},
        charts: {stages: {...}, cost: {...}},
      }
    Defensive: every metric is read with .get and a default, so a thin analytic
    estimate (few keys) renders just as safely as a full Monte-Carlo run.
    """
    def g(key, default=0.0):
        v = metrics.get(key, default)
        return v if isinstance(v, (int, float)) else default

    md = model.model_dump()

    def _worker_edit(role: str, label_fmt: str) -> dict | None:
        """Build an {path,value,label} edit that bumps a worker group's count by
        one, reading the real schema index from the model dump. Returns None if
        no such worker group exists (so we never emit an invalid path)."""
        groups = md.get("resources", {}).get("workers", []) or []
        for i, w in enumerate(groups):
            if w.get("role") == role:
                cnt = int(w.get("count", 0))
                return {"path": f"resources.workers.{i}.count", "value": cnt + 1,
                        "label": label_fmt.format(n=cnt + 1)}
        return None

    def _agv_edit() -> dict | None:
        """Enable / raise the AGV fleet count by one. Targets the first AGV-type
        equipment entry if present; otherwise None (no equipment list to edit)."""
        equip = md.get("resources", {}).get("equipment", []) or []
        for i, e in enumerate(equip):
            if e.get("type") == "agv":
                cnt = int(e.get("count", 0))
                verb = "を1台追加" if cnt > 0 else "を1台導入"
                return {"path": f"resources.equipment.{i}.count", "value": cnt + 1,
                        "label": f"AGV{verb}"}
        return None

    cur = metrics.get("currency", "¥")
    pickers = int(g("n_pickers", 0))
    packers = int(g("n_packers", 0))
    headcount = int(g("headcount", pickers + packers))
    bottleneck_jp = metrics.get("bottleneck_jp")
    bn_util = g("bottleneck_utilization", g("picker_utilization", 0.0))
    completion = g("completion_rate", 1.0)
    pick_wait = metrics.get("pick_wait_mean_s")
    sort_wait = g("sort_wait_mean_s", 0.0)
    cost_per_order = g("total_cost_per_order", 0.0)
    monthly_cost = g("monthly_cost", 0.0)
    can_handle = bool(metrics.get("can_handle_demand", not metrics.get("overloaded", False)))

    # --- insights: "指摘 -> 提案" ------------------------------------------
    insights: list[dict] = []

    # 1) Bottleneck / capacity (danger if demand not met, warn if hot).
    if bottleneck_jp:
        wait_min = (pick_wait / 60.0) if isinstance(pick_wait, (int, float)) else None
        add_stage = {"梱包": "梱包台を1台増設", "ピッキング": "ピッカーを1名増員",
                     "AGV搬送": "AGVを1台追加", "種まき仕分け": "仕分け間口を増設"}
        action = f"{add_stage.get(bottleneck_jp, '当該工程の能力を増強')}で改善を検討。"
        # Compute a concrete one-click remedy from the live model. Map the raw
        # bottleneck stage to a count-bump on the corresponding resource; only
        # attach when a valid path+value can be derived (else omit `edit`).
        bn_raw = metrics.get("bottleneck")
        if bn_raw == "packing":
            remedy = _worker_edit("packer", "梱包担当を{n}名に増員")
        elif bn_raw == "picking":
            remedy = _worker_edit("picker", "ピッカーを{n}名に増員")
        elif bn_raw == "agv":
            remedy = _agv_edit()
        else:
            remedy = None
        if not can_handle:
            wtxt = f"（待ち {wait_min:.1f}分）" if wait_min is not None else ""
            ins = {
                "severity": "danger", "icon": "alert",
                "title": f"{bottleneck_jp}がボトルネック{wtxt}",
                "fact": f"稼働率 <span class=\"num\">{round(bn_util * 100)}</span>% / "
                        f"出荷完了 <span class=\"num\">{round(completion * 100)}</span>%。",
                "metric": f"{round(bn_util * 100)}%",
                "action": action,
            }
            if remedy:
                ins["edit"] = remedy
            insights.append(ins)
        elif bn_util >= 0.85:
            ins = {
                "severity": "warn", "icon": "trend",
                "title": f"{bottleneck_jp}の稼働率が高水準",
                "fact": f"稼働率 <span class=\"num\">{round(bn_util * 100)}</span>%。"
                        f"需要増で逼迫の恐れ。",
                "metric": f"{round(bn_util * 100)}%",
                "action": f"繁忙時間帯の{bottleneck_jp}増強余地を確認。",
            }
            if remedy:
                ins["edit"] = remedy
            insights.append(ins)
        else:
            insights.append({
                "severity": "ok", "icon": "check",
                "title": f"{bottleneck_jp}に余力あり（需要をさばけます）",
                "fact": f"最繁忙工程の稼働率 <span class=\"num\">{round(bn_util * 100)}</span>%。",
                "metric": f"{round(bn_util * 100)}%",
            })

    # 2) Sort/put-wall queueing (warn) if material.
    if sort_wait >= 30.0:
        insights.append({
            "severity": "warn", "icon": "bars",
            "title": f"種まき仕分けで待ちが発生（平均 {sort_wait / 60.0:.1f}分）",
            "fact": f"間口数 <span class=\"num\">{int(g('n_put_wall', 0))}</span> 口。",
            "metric": f"{sort_wait / 60.0:.1f}分",
            "action": "仕分け間口の追加、または波の平準化を検討。",
        })

    # 3) AGV under/over-utilisation (info) when an AGV fleet is present.
    n_agvs = int(g("n_agvs", 0))
    if n_agvs:
        agv_u = g("agv_utilization", 0.0)
        ins = {
            "severity": "info", "icon": "info",
            "title": f"AGV {n_agvs}台の稼働率は {round(agv_u * 100)}%",
            "fact": "低稼働なら台数の見直し、高稼働なら増車の検討材料。",
            "metric": f"{round(agv_u * 100)}%",
        }
        # When the fleet is running hot, offer a one-click "add an AGV".
        if agv_u >= 0.85:
            remedy = _agv_edit()
            if remedy:
                ins["edit"] = remedy
        insights.append(ins)

    # 4) Cost-per-order (info) when costed.
    if cost_per_order > 0:
        insights.append({
            "severity": "info", "icon": "info",
            "title": "1件あたり処理コスト",
            "fact": f"人件費・設備費を合算。月次コスト概算 "
                    f"<span class=\"num\">{cur}{round(monthly_cost):,}</span>。",
            "metric": f"{cur}{cost_per_order:,.1f}",
        })

    # --- hero KPIs ----------------------------------------------------------
    hero: list[dict] = []
    tput = g("throughput_per_hr", g("capacity_orders_per_hr", 0.0))
    if tput:
        hero.append({"label": "処理能力", "value": round(tput),
                     "unit": "件/時", "delta": None})
    hero.append({"label": "出荷完了率", "value": round(completion * 100),
                 "unit": "%",
                 "delta": {"dir": "up" if completion >= 0.98 else "down",
                           "text": "需要をさばけます" if can_handle else "要注意"}})
    if bottleneck_jp:
        hero.append({"label": f"{bottleneck_jp}稼働率", "value": round(bn_util * 100),
                     "unit": "%",
                     "delta": {"dir": "down" if bn_util >= 0.85 else "up",
                               "text": "高負荷" if bn_util >= 0.85 else "余力あり"}})
    if cost_per_order > 0:
        hero.append({"label": "1件あたりコスト", "value": round(cost_per_order, 1),
                     "unit": cur, "delta": None})
    if len(hero) < 4 and headcount:
        hero.append({"label": "必要人員", "value": headcount, "unit": "名", "delta": None})

    # --- grouped standard KPIs ---------------------------------------------
    groups: list[dict] = []
    vol = [it for it in (
        {"label": "到着オーダー", "value": round(g("orders_arrived")), "unit": "件"},
        {"label": "完了オーダー", "value": round(g("orders_completed")), "unit": "件"},
        {"label": "総歩行距離", "value": round(g("walk_total_m")), "unit": "m"},
        {"label": "1件あたり歩行", "value": round(g("walk_per_order_m"), 1), "unit": "m"},
    ) if it["value"]]
    if vol:
        groups.append({"label": "ボリューム", "items": vol})

    eff = []
    if g("picker_utilization"):
        eff.append({"label": "ピッキング稼働率",
                    "value": round(g("picker_utilization") * 100), "unit": "%"})
    if g("packer_utilization"):
        eff.append({"label": "梱包稼働率",
                    "value": round(g("packer_utilization") * 100), "unit": "%"})
    if g("cycle_mean_s"):
        eff.append({"label": "平均サイクル",
                    "value": round(g("cycle_mean_s") / 60.0, 1), "unit": "分"})
    if g("on_time_rate"):
        eff.append({"label": "納期遵守率",
                    "value": round(g("on_time_rate") * 100), "unit": "%"})
    if eff:
        groups.append({"label": "効率指標", "items": eff})

    cost_items = []
    if cost_per_order > 0:
        cost_items.append({"label": "1件あたりコスト",
                           "value": round(cost_per_order, 1), "unit": cur})
    if monthly_cost > 0:
        cost_items.append({"label": "月次コスト",
                           "value": round(monthly_cost), "unit": cur})
    if g("monthly_opex") > 0:
        cost_items.append({"label": "月次運用費",
                           "value": round(g("monthly_opex")), "unit": cur})
    if headcount:
        cost_items.append({"label": "人員", "value": headcount, "unit": "名"})
    if cost_items:
        groups.append({"label": "コスト・人員", "items": cost_items})

    # --- charts -------------------------------------------------------------
    # (a) per-stage utilisation (bar): the congestion picture.
    stage_rows = [("ピッキング", g("picker_utilization")),
                  ("梱包", g("packer_utilization"))]
    if n_agvs:
        stage_rows.append(("AGV搬送", g("agv_utilization")))
    if int(g("n_put_wall", 0)):
        stage_rows.append(("種まき仕分け", g("sort_utilization")))
    stages_chart = {
        "labels": [r[0] for r in stage_rows],
        "values": [round(r[1] * 100, 1) for r in stage_rows],
        "peak_label": bottleneck_jp,
    }

    # (b) cost breakdown (bar) per order: labour vs equipment.
    labour_po = g("labour_cost_per_order")
    equip_po = g("equipment_cost_per_order")
    cost_chart = None
    if labour_po or equip_po:
        cost_chart = {
            "labels": ["人件費", "設備費"],
            "values": [round(labour_po, 2), round(equip_po, 2)],
            "currency": cur,
        }

    return {
        "name": model.meta.name,
        "source": source,
        "verdict": metrics.get("verdict"),
        "insights": insights,
        "kpis": {"hero": hero[:4], "groups": groups},
        "charts": {"stages": stages_chart, "cost": cost_chart},
    }


def _open(name: str) -> Project:
    name = _safe_name(name)
    try:
        return Project.open(name)
    except FileNotFoundError:
        raise HTTPException(404, f"no project {name!r}")


def _headline_values(model_dict: dict, manifest: dict) -> dict:
    out = {}
    for f in manifest.get("headline_fields", []):
        path = f["path"]
        cur = model_dict
        try:
            for p in path.split("."):
                cur = cur[int(p)] if p.isdigit() else cur[p]
            out[path] = cur
        except (KeyError, IndexError, ValueError):
            out[path] = None
    return out


# ---- static frontend (mounted last so /api/* wins) --------------------------
app.mount("/", StaticFiles(directory=str(STATIC), html=True), name="static")
