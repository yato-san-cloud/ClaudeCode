"""採点表レール endpoints: the design's dependent-variable scorecard (GET on the
saved model, POST on an unsaved in-memory overlay for live drag-time rescoring) and
the named-scenario store (list / save / delete). All analytic (no DES); never-blocks.
"""

from __future__ import annotations

import json

from fastapi import APIRouter

from ._common import _open

router = APIRouter()


@router.get("/api/projects/{name}/scorecard")
def api_scorecard(name: str):
    """採点表レール: the design's dependent variables (判定/人員/原価/生産性/坪数/
    連鎖) recomputed analytically (no DES, 爆速) on every edit. Composes the
    existing pure estimators into the fixed 6-row payload the right-dock rail
    renders, plus a `run` block (the last DES run's headline numbers) for its
    解析値 vs 実測 delta. Honours 'never blocks': a bare model returns 200 with
    all 6 rows (value="—" where there is no data); no run → run.exists=false."""
    from whsim import scorecard
    proj = _open(name)
    model = proj.load_model()
    run_metrics = None
    rd = proj.latest_run_dir()
    if rd is not None and (rd / "kpis.json").is_file():
        try:
            run_metrics = json.loads((rd / "kpis.json").read_text("utf-8"))
        except Exception:  # noqa: BLE001 — a corrupt run never wedges the rail
            run_metrics = None
    return scorecard.build_scorecard(model, run_metrics)


@router.get("/api/projects/{name}/scenarios")
def api_scenarios_list(name: str):
    """採点表レール Stage2: 保存済みシナリオ（名前つき設計スナップショット＋採点表）
    の一覧。各シナリオは保存時の scorecard を含むので、レールは現在値との
    デルタを round-trip なしで描ける。Tolerant: 壊れた1件は飛ばす。"""
    from whsim import scenariostore
    return {"scenarios": scenariostore.list_scenarios(_open(name))}


@router.post("/api/projects/{name}/scenarios")
def api_scenarios_save(name: str, payload: dict | None = None):
    """現在の設計（or 編集中セクション）を名前つきシナリオとして凍結保存。
    本文: {label, sections?}。sections があれば未保存の編集案をそのまま凍結する
    （ライブ採点と同じ overlay）。保存したシナリオのヘッダ（採点表込み）を返す。"""
    from whsim import scenariostore
    p = payload or {}
    label = str(p.get("label") or "").strip() or "シナリオ"
    return scenariostore.save_scenario(_open(name), label, p.get("sections"))


@router.delete("/api/projects/{name}/scenarios/{sid}")
def api_scenarios_delete(name: str, sid: str):
    from whsim import scenariostore
    return {"ok": scenariostore.delete_scenario(_open(name), sid)}


@router.post("/api/projects/{name}/scorecard")
def api_scorecard_live(name: str, payload: dict | None = None):
    """採点表レール (LIVE): same as GET, but score an *unsaved* in-memory model.

    The designer emits `whsim:design-dirty` with its current edit sections
    ({layout, resources, process, routes, settings}); the rail POSTs them here so
    the dependent variables move WHILE you drag a shelf — no save round-trip. The
    body sections are overlaid onto the saved model dict, re-validated, and scored.
    Tolerant: a missing/invalid section falls back to the saved model so the rail
    never wedges ('never blocks'). The run block still comes from the last DES run.
    """
    from whsim import scorecard
    from whsim.schema.model import WarehouseModel
    proj = _open(name)
    md = proj.load_model().model_dump()
    for key in ("layout", "resources", "process", "routes", "settings"):
        val = (payload or {}).get(key)
        if val is not None:
            md[key] = val
    try:
        model = WarehouseModel.model_validate(md)
    except Exception:  # noqa: BLE001 — bad edit sections → score the saved model
        model = proj.load_model()
    run_metrics = None
    rd = proj.latest_run_dir()
    if rd is not None and (rd / "kpis.json").is_file():
        try:
            run_metrics = json.loads((rd / "kpis.json").read_text("utf-8"))
        except Exception:  # noqa: BLE001 — a corrupt run never wedges the rail
            run_metrics = None
    return scorecard.build_scorecard(model, run_metrics)
