"""Cross-cutting / stateless endpoints: templates, rack presets, Cody chat,
material-flow & timetable seeds, work-method naming, notes and the favicon."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response

from whsim import cody, templates
from whsim.project import Project

from ._common import _open

router = APIRouter()


def _build_version() -> dict:
    """Package version + git commit of the running checkout (best-effort).

    Computed once at import: `whsim serve --reload` restarts the process on
    every code change (incl. the dev auto-sync's reset --hard), so the cache
    always reflects the running build. Git absent (e.g. wheel install) is fine —
    the commit fields are simply null. Never raises ("never blocks").
    """
    repo = Path(__file__).resolve().parents[4]  # routes/web/whsim/src -> repo
    ver = None
    try:
        # Prefer the checkout's pyproject so a `git pull` shows the new version
        # immediately (editable installs pin importlib.metadata at install time).
        import tomllib
        with open(repo / "pyproject.toml", "rb") as f:
            ver = tomllib.load(f)["project"]["version"]
    except Exception:  # noqa: BLE001 — fall back to installed metadata
        ver = None
    if not ver:
        try:
            from importlib.metadata import version as _pkg_version
            ver = _pkg_version("whsim")
        except Exception:  # noqa: BLE001 — metadata may be missing in odd installs
            ver = "dev"
    commit = commit_time = None
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "log", "-1", "--format=%h\t%ci"],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0 and "\t" in out.stdout:
            commit, commit_time = out.stdout.strip().split("\t", 1)
    except Exception:  # noqa: BLE001 — git is optional context, never fatal
        pass
    return {"version": ver, "commit": commit, "commit_time": commit_time}


_VERSION = _build_version()


@router.get("/api/version")
def api_version():
    """Running build: package version + git commit hash/time (nulls without git).

    Surfaced as the header badge so anyone can tell at a glance whether the
    browser is looking at the latest push (the dev loop auto-syncs + reloads)."""
    return _VERSION


@router.get("/favicon.ico")
def favicon():
    # No icon asset shipped; answer 204 so the browser stops logging a 404.
    return Response(status_code=204)


@router.get("/api/templates")
def api_templates():
    return templates.list_templates()


@router.get("/api/materialflow/seed")
def api_materialflow_seed():
    """Material-flow skeleton (process flow + units/productivity) for the
    荷役物量 authoring screen."""
    from whsim.analysis import staffing
    return {"flow": staffing.flow_seed()}


@router.post("/api/materialflow/generate")
def api_materialflow_generate(payload: dict | None = None):
    """不足データ作成: estimate every process's 荷役物量 from a partial base."""
    from whsim.analysis import staffing
    base = (payload or {}).get("base") or {}
    return {"volumes": staffing.generate_flow_volumes(base)}


@router.post("/api/materialflow/scenario")
def api_materialflow_scenario(payload: dict | None = None):
    """Turn authored per-process 荷役物量 into a timetable scenario (→ 人員配置)."""
    from whsim.analysis import staffing
    volumes = (payload or {}).get("volumes") or {}
    return staffing.scenario_from_volumes(volumes)


@router.get("/api/racktypes")
def api_racktypes():
    """Storage-equipment presets (軽量棚/中量棚/パレットラック/ネステナー/…) for the
    designer's 棚種別 picker — each with cell footprint, capacity and colour."""
    from whsim import racktypes
    return racktypes.catalog()


@router.get("/api/racktypes/vertical")
def api_racktypes_vertical(lift: float | None = None, reach: float | None = None):
    """Per-rack vertical pick-time preview for the two 段(level) knobs.

    For each rack-type id, returns its label, mover (manual/forklift/crane),
    per-level shelf pitch (m), and the extra ``vertical_pick_s`` at every level
    (1..levels) for the given lift speed / manual reach penalty. Omitted params
    fall back to the model defaults (process.lift_speed_mps / manual_reach_s_per_m),
    so the 保管設計 preview matches what the engine will charge. Stateless,
    never blocks (bad numbers are clamped by the underlying pure functions)."""
    from whsim import racktypes
    from whsim.schema.model import Process
    defaults = Process()
    lift_mps = defaults.lift_speed_mps if lift is None else float(lift)
    reach_s = defaults.manual_reach_s_per_m if reach is None else float(reach)
    rows = []
    for rid in racktypes.ORDER:
        preset = racktypes.RACK_TYPES[rid]
        levels = int(preset.get("levels", 1))
        rows.append({
            "id": rid,
            "label": preset["label"],
            "color": preset["color"],
            "mover": racktypes.mover(rid),
            "levels": levels,
            "pitch_m": racktypes._LEVEL_H.get(rid, 0.0),
            "vertical_s": [
                round(racktypes.vertical_pick_s(rid, lvl, lift_mps, reach_s), 2)
                for lvl in range(1, levels + 1)
            ],
        })
    return {"lift_speed_mps": lift_mps, "manual_reach_s_per_m": reach_s,
            "defaults": {"lift_speed_mps": defaults.lift_speed_mps,
                         "manual_reach_s_per_m": defaults.manual_reach_s_per_m},
            "rack_types": rows}


@router.post("/api/cody/chat")
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


@router.post("/api/routes/network")
def api_routes_network(payload: dict | None = None):
    """経路ネットワーク自動生成 (MapMaker's 経路自動計算, as a pure function).

    Stateless: the 動線 editor POSTs its LIVE (possibly unsaved) layout —
    bounds + walls + shelf footprints — and gets back the walkable lane network
    plus wall/棚-aware shortest paths for any (a, b) queries. Powered by the
    same ``engine.graph.AisleGraph`` the simulation itself routes with, so the
    drawn 動線 and the simulated travel agree by construction.

    Body: {bounds:{width,depth}, walls:[{points:[[x,y],..]},..],
           shelves:[[x,y,w,h],..], include_edges:bool,
           queries:[{a:[x,y], b:[x,y]},..]}
    →     {enabled, resolution, edges:[[x1,y1,x2,y2],..]?, paths:[{points,distance_m},..]}

    Tolerant: malformed walls/shelves/queries are skipped, never a 500.
    """
    from whsim.engine.graph import AisleGraph, simplify_collinear
    p = payload or {}
    bounds = p.get("bounds") or {}

    def _f(v, default):
        try:
            return float(v)
        except (TypeError, ValueError):
            return default
    width = max(1.0, _f(bounds.get("width"), 80.0))
    depth = max(1.0, _f(bounds.get("depth"), 40.0))

    walls = [w for w in (p.get("walls") or []) if isinstance(w, dict)]
    try:
        segments = AisleGraph._segments_from_walls(walls)
    except (TypeError, ValueError):  # noqa: BLE001 — junk points: route without walls
        segments = []
    obstacles: list[tuple[float, float, float, float]] = []
    for sh in (p.get("shelves") or []):
        try:
            x, y, w, h = (float(v) for v in sh[:4])
            if w > 0 and h > 0:
                obstacles.append((x, y, w, h))
        except (TypeError, ValueError, IndexError):
            continue

    # Display-grade resolution: keep the grid small enough that the edge list
    # stays drawable (≤ ~6000 nodes → ≤ ~12k edges) while paths remain ~1m-true.
    res = max(1.0, ((width * depth) / 6000.0) ** 0.5)
    g = AisleGraph(width, depth, segments, resolution=res, obstacle_rects=obstacles)

    out: dict = {
        "enabled": bool(segments or obstacles),
        "resolution": g.resolution,
        "paths": [],
    }
    if p.get("include_edges"):
        out["edges"] = [list(e) for e in g.edges_xy()]
    for q in (p.get("queries") or []):
        try:
            a = (float(q["a"][0]), float(q["a"][1]))
            b = (float(q["b"][0]), float(q["b"][1]))
        except (TypeError, ValueError, KeyError, IndexError):
            continue
        pts = simplify_collinear(g.path(a, b))
        dist = g.distance(a, b)
        out["paths"].append({"points": [list(pt) for pt in pts],
                             "distance_m": round(dist, 2)})
    return out


@router.post("/api/workmethod/name")
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


@router.get("/api/timetable/seed")
def api_timetable_seed():
    """Bundled work-timetable dataset (process master + productivity + scenarios).

    The タイムチャート tab fetches this once and then re-solves entirely client-side
    as the user drags sliders, so live recalc has zero round-trip latency."""
    from whsim import timetable
    seed = timetable.load_seed()
    seed["section_color"] = timetable.SECTION_COLOR
    seed["section_zone_type"] = timetable.SECTION_ZONE_TYPE
    return seed


@router.post("/api/timetable/solve")
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


@router.get("/api/projects/{name}/notes")
def api_notes_list(name: str, anchor: str | None = None):
    """知見ボード: anchored notes for a project (newest first)."""
    from whsim import notes
    return {"notes": notes.list_notes(_open(name), anchor)}


@router.post("/api/projects/{name}/notes")
def api_notes_add(name: str, payload: dict):
    """Post a note pinned to an anchor (生産性/工程/シナリオ/設計/結果/general…)."""
    from whsim import notes
    p = payload or {}
    try:
        return notes.add_note(_open(name), p.get("anchor", "general"),
                              p.get("author", ""), p.get("text", ""))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/api/projects/{name}/notes/{note_id}")
def api_notes_delete(name: str, note_id: str):
    from whsim import notes
    return {"ok": notes.delete_note(_open(name), note_id)}
