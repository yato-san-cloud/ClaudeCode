"""FastAPI app: the salesperson-facing web product.

Wraps the whsim core (templates, importer, engine, KPIs, renderers) behind a
small REST API and serves the single-page frontend. The frontend lets a
salesperson pick a template, drop in a customer ZIP, confirm a few headline
numbers, run the simulation, and watch an animated 2D/3D replay -- all without
touching simulation vocabulary.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from whsim import analytic, kpis as kpi_mod, templates
from whsim.engine.run import run_replications
from whsim.project import Project
from whsim.provenance import Source
from whsim.render.png2d import render as render_png
from whsim.render.replay import build_replay

STATIC = Path(__file__).resolve().parent / "static"

# Monte-Carlo replications behind every web run (variability is shown, not configured).
MONTE_CARLO_REPS = 10

app = FastAPI(title="whsim", version="0.1.0")


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

@app.get("/api/templates")
def api_templates():
    return templates.list_templates()


@app.get("/api/projects")
def api_projects():
    from whsim.project import PROJECTS_DIR
    if not PROJECTS_DIR.is_dir():
        return []
    return sorted(p.name for p in PROJECTS_DIR.iterdir()
                  if (p / "project.json").is_file())


@app.post("/api/projects")
def api_create(payload: dict):
    name = (payload.get("name") or "").strip()
    template = payload.get("template") or "ecommerce_small"
    if not name:
        raise HTTPException(400, "name required")
    proj = Project.create(name, template)
    return {"name": name, "template": template, "root": str(proj.root)}


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


@app.post("/api/projects/{name}/import-cad")
async def api_import_cad(name: str, file: UploadFile):
    """Import a DXF floor plan -> merge its bounds/walls/zones into the layout."""
    from whsim import cad
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    data = await file.read()
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
    data = await file.read()
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


@app.get("/api/projects/{name}/proposal.{fmt}")
def api_proposal(name: str, fmt: str):
    """Generate an editable PPTX or a PDF proposal from the latest run."""
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
    builder = export_doc.build_pptx if fmt == "pptx" else export_doc.build_pdf
    builder(kpis, proj.meta()["name"], prov, png if png.is_file() else None, out)
    media = ("application/vnd.openxmlformats-officedocument.presentationml.presentation"
             if fmt == "pptx" else "application/pdf")
    return FileResponse(out, media_type=media, filename=f"{name}_提案書.{fmt}")


@app.post("/api/projects/{name}/headline")
def api_headline(name: str, payload: dict):
    proj = _open(name)
    md = json.loads(proj.model_file.read_text("utf-8"))
    prov = proj.load_provenance()
    for path, value in payload.items():
        subtree = _set_by_path(md, path, value)
        prov.mark(subtree, Source.INTERVIEW)
    from whsim.schema.model import WarehouseModel
    proj.save_model(WarehouseModel.model_validate(md))
    proj.save_provenance(prov)
    return {"ok": True, "provenance_summary": prov.summary()}


@app.post("/api/projects/{name}/import")
async def api_import(name: str, file: UploadFile):
    import tempfile
    proj = _open(name)
    # Write to a temp file; Project.import_zip copies it into the project's raw/.
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tf:
        tf.write(await file.read())
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


@app.post("/api/projects/{name}/run")
def api_run(name: str):
    proj = _open(name)
    model = proj.load_model()
    # Monte-Carlo: many stochastic order sequences; rep 0 carries the replay.
    results, heat = run_replications(model, reps=MONTE_CARLO_REPS)
    res = results[0]
    metrics = kpi_mod.compute(results)
    est = analytic.estimate(model)

    run_dir = proj.new_run_dir()
    (run_dir / "kpis.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2), "utf-8")
    import numpy as np
    np.save(run_dir / "heatmap.npy", heat)
    replay = build_replay(model, res, metrics)
    (run_dir / "replay.json").write_text(
        json.dumps(replay, ensure_ascii=False), "utf-8")
    render_png(model, heat, metrics, proj.load_provenance().summary(),
               run_dir / "layout_heatmap.png")
    return {"kpis": metrics, "estimate": est, "run": run_dir.name}


@app.post("/api/projects/{name}/run-scenarios")
def api_run_scenarios(name: str, payload: dict | None = None):
    """Run several what-ifs over the current model and return a comparison."""
    from whsim.engine.scenarios import (
        default_scenarios, payback_months, run_scenario,
    )
    from whsim.schema.model import Scenario
    proj = _open(name)
    base = proj.load_model()

    payload = payload or {}
    raw = payload.get("scenarios")
    scenarios = ([Scenario.model_validate(s) for s in raw] if raw
                 else default_scenarios(base))

    cmp_id = proj.new_run_dir().name.replace("run_", "compare_")
    cmp_dir = proj.runs_dir / cmp_id
    cmp_dir.mkdir(parents=True, exist_ok=True)
    prov = proj.load_provenance().summary()

    from whsim.engine.scenarios import apply_scenario
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
    return {"compare_id": cmp_id, "baseline": baseline, "alternatives": alternatives}


@app.get("/api/projects/{name}/compare-png/{cmp}/{i}")
def api_compare_png(name: str, cmp: str, i: int):
    proj = _open(name)
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
        if not can_handle:
            wtxt = f"（待ち {wait_min:.1f}分）" if wait_min is not None else ""
            insights.append({
                "severity": "danger", "icon": "alert",
                "title": f"{bottleneck_jp}がボトルネック{wtxt}",
                "fact": f"稼働率 <span class=\"num\">{round(bn_util * 100)}</span>% / "
                        f"出荷完了 <span class=\"num\">{round(completion * 100)}</span>%。",
                "metric": f"{round(bn_util * 100)}%",
                "action": action,
            })
        elif bn_util >= 0.85:
            insights.append({
                "severity": "warn", "icon": "trend",
                "title": f"{bottleneck_jp}の稼働率が高水準",
                "fact": f"稼働率 <span class=\"num\">{round(bn_util * 100)}</span>%。"
                        f"需要増で逼迫の恐れ。",
                "metric": f"{round(bn_util * 100)}%",
                "action": f"繁忙時間帯の{bottleneck_jp}増強余地を確認。",
            })
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
        insights.append({
            "severity": "info", "icon": "info",
            "title": f"AGV {n_agvs}台の稼働率は {round(agv_u * 100)}%",
            "fact": "低稼働なら台数の見直し、高稼働なら増車の検討材料。",
            "metric": f"{round(agv_u * 100)}%",
        })

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
