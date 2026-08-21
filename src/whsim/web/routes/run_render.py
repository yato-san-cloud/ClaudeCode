"""Run-artifact endpoints: the replay JSON, the proposal PNG, the per-scenario
comparison images, and the editable PPTX/PDF proposal export.

The heavy ``/run`` and ``/run-scenarios`` endpoints themselves stay in
``whsim.web.app`` together with the in-flight concurrency guard and the
``run_replications`` symbol, so the existing tests can monkeypatch
``whsim.web.app.run_replications`` / ``_inflight_runs`` against the same module
namespace the endpoints execute in."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse, JSONResponse

from ._common import _call_export, _open, _proposal_extras, _safe_name

router = APIRouter()


@router.get("/api/projects/{name}/proposal.{fmt}")
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


@router.get("/api/projects/{name}/compare-png/{cmp}/{i}")
def api_compare_png(name: str, cmp: str, i: int):
    proj = _open(name)
    cmp = _safe_name(cmp)
    png = proj.runs_dir / cmp / f"s{i}.png"
    if not png.is_file():
        raise HTTPException(404, "no such comparison image")
    return FileResponse(png)


@router.get("/api/projects/{name}/replay")
def api_replay(name: str):
    proj = _open(name)
    rd = proj.latest_run_dir()
    replay_file = (rd / "replay.json") if rd is not None else None
    # Use the stored run replay only while it is still FRESH — i.e. the model has
    # not been edited since that run. Otherwise (no run yet, or the layout changed)
    # return a run-free layout replay so 2D/3D reflect the CURRENT design
    # immediately; ▶実行 then refreshes it with the moving agents.
    if replay_file is not None and replay_file.is_file():
        try:
            fresh = proj.model_file.stat().st_mtime <= replay_file.stat().st_mtime
        except OSError:
            fresh = True
        if fresh:
            return JSONResponse(json.loads(replay_file.read_text("utf-8")))
    from whsim.render.replay import build_layout_replay
    return JSONResponse(build_layout_replay(proj.load_model()))


def _sku_xy_and_dist(model, fast: bool = False):
    """Build the SKU->position map and a distance function.

    Mirrors ``engine.build``'s sku_xy resolution (item default_location, then any
    SKU pinned on a location). ``fast=True`` forces Manhattan shelf-distance — the
    ③設計 estimate must be snappy (a wall-aware 2-opt over the day's consolidated
    tour is multi-second); ④検証 DES does the wall-aware truth. ``fast=False`` uses
    the wall-aware graph when walls/shelves exist (closer to the engine)."""
    from whsim.engine.routing import manhattan

    loc_by_id = model.location_by_id()
    sku_xy: dict[str, tuple[float, float]] = {}
    for it in model.items:
        if it.default_location and it.default_location in loc_by_id:
            loc = loc_by_id[it.default_location]
            sku_xy[it.sku] = (loc.x, loc.y)
    for loc in model.locations:
        if loc.sku and loc.sku not in sku_xy:
            sku_xy[loc.sku] = (loc.x, loc.y)

    if fast:
        return sku_xy, manhattan, False
    from whsim.engine.graph import AisleGraph
    graph = AisleGraph.from_model(model)
    if graph.enabled:
        def dist(a, b):
            return graph.distance(a, b)
        return sku_xy, dist, True
    return sku_xy, manhattan, False


def _depot_xy(model) -> tuple[float, float]:
    """Where a pick tour starts/returns: the first pack station, else floor mid."""
    if model.resources.stations:
        s = model.resources.stations[0]
        return (float(s.x), float(s.y))
    b = model.layout.bounds
    return (b.width / 2.0, 0.0)


def _order_pts(model, sku_xy):
    """Per-order pick-point lists (skipping unplaced SKUs)."""
    out = []
    for o in model.orders.outbound:
        pts = [sku_xy[ln.sku] for ln in o.lines if ln.sku in sku_xy]
        if pts:
            out.append(pts)
    return out


@router.post("/api/projects/{name}/routecompare")
def api_routecompare(name: str, body: dict | None = None):
    """ピッカー経路方式の比較表: 同一オーダー集合を各方式（S字/折り返し/
    最大ギャップ/2-opt）で歩いた総距離（閉形式・DES不要）。

    never-blocks: ロケーション未配置/オーダー無しでも has_data:false を返す
    （500 にしない）。採用は `process.routing_policy` への1フィールド書込みで
    エンジンまで届く（schema/build/processes 配線済み）。"""
    from whsim import routecompare
    body = body or {}
    model = _open(name).load_model()
    return routecompare.compare(
        model,
        policies=tuple(body.get("policies") or routecompare.DEFAULT_POLICIES),
        n_orders=int(body.get("n_orders", 50)),
        seed=int(body.get("seed", 42)),
    )


@router.get("/api/projects/{name}/pickseq")
def api_pickseq(name: str):
    """ピック順序最適化: compare tour length + estimated pick time for
    naive(S-shape順) vs greedy(NN) vs optimized(2-opt) across the three pick
    modes — order(都度) / multi-order(まとめ) / total(トータル).

    Uses the same distance model the engine uses (wall-aware graph > Manhattan),
    so the % distance/time reduction is consistent with a DES run but computed in
    closed form (no simulation). never-blocks: an empty model returns has_data
    false with zeroed methods rather than a 500."""
    from whsim import picktour

    proj = _open(name)
    model = proj.load_model()
    # fast=True → Manhattan shelf-distance so clicking the tab is ~instant; the
    # 2-opt % reductions are faithful as a ratio. ④検証 DES adds the wall-aware truth.
    sku_xy, dist, wall_aware = _sku_xy_and_dist(model, fast=True)
    depot = _depot_xy(model)
    orders_pts = _order_pts(model, sku_xy)

    # Keep the comparison snappy (clicking the tab should be ~instant): the % is a
    # ratio, so an evenly-strided representative sample is faithful. The wall-aware
    # 2-opt over the full day's consolidated tour is otherwise multi-second.
    _PICKSEQ_MAX_ORDERS = 60
    sampled = len(orders_pts) > _PICKSEQ_MAX_ORDERS
    if sampled:
        stride = len(orders_pts) / _PICKSEQ_MAX_ORDERS
        orders_pts = [orders_pts[int(i * stride)] for i in range(_PICKSEQ_MAX_ORDERS)]

    walk_speed = max(0.1, float(model.process.walk_speed_mps))
    handle_s = 6.0  # seconds per pick line (motion-time default, mirrors pickrate)

    # Pick modes group the orders into the batches a tour actually sweeps:
    #   order       — one order per tour (都度)
    #   multi-order — orders_per_trip orders fused into one tour (まとめ)
    #   total       — the whole day fused, SKU-deduped (トータル)
    work = model.process.effective_work()
    batch = max(1, int(getattr(work, "orders_per_trip", 1)) or 1)
    if batch <= 1:
        batch = max(2, int(model.process.batch_size) or 4)

    def chunks(seq, k):
        return [seq[i:i + k] for i in range(0, len(seq), k)] or [[]]

    mode_specs = [
        ("order", "都度（1オーダー）", chunks(orders_pts, 1)),
        ("multi", f"まとめ（{batch}オーダー）", chunks(orders_pts, batch)),
        ("total", "トータル（一括）", [orders_pts] if orders_pts else [[]]),
    ]

    def tour_for_batch(batch_orders, method):
        """(length, n_picks) for one consolidated batch under a method.
        Total-pick dedups shared locations; order/multi keep every line."""
        pts, route = picktour.consolidated_tour(
            depot, batch_orders, dist,
            optimize_tour=(method == "optimized"),
        )
        n_picks = sum(len(o) for o in batch_orders)
        if not pts:
            return 0.0, n_picks
        if method == "naive":
            route = picktour.naive_route(pts)
        elif method == "greedy":
            route = picktour.greedy_nn(depot, pts, dist)
        length = picktour.route_length(depot, pts, route, dist)
        return length, n_picks

    methods = ("naive", "greedy", "optimized")
    modes_out = []
    has_data = bool(orders_pts)
    for mid, mlabel, batches in mode_specs:
        per_method = {}
        for method in methods:
            tot_len = 0.0
            tot_picks = 0
            for b in batches:
                if not b:
                    continue
                length, n_picks = tour_for_batch(b, method)
                tot_len += length
                tot_picks += n_picks
            # estimated pick time: travel (walk) + line handling.
            est_time_s = tot_len / walk_speed + tot_picks * handle_s
            per_method[method] = {
                "length_m": round(tot_len, 1),
                "time_s": round(est_time_s, 1),
                "n_picks": tot_picks,
            }
        base = per_method["naive"]["length_m"] or 1.0
        base_t = per_method["naive"]["time_s"] or 1.0
        opt = per_method["optimized"]
        modes_out.append({
            "id": mid, "label": mlabel,
            "methods": per_method,
            "dist_reduction_pct": round((1.0 - opt["length_m"] / base) * 100.0, 1),
            "time_reduction_pct": round((1.0 - opt["time_s"] / base_t) * 100.0, 1),
        })

    # Recommended mode = the largest optimized distance reduction over naive.
    recommend = (max(modes_out, key=lambda m: m["dist_reduction_pct"])["id"]
                 if has_data else "order")
    best = next((m for m in modes_out if m["id"] == recommend), None)
    headline = best["dist_reduction_pct"] if best else 0.0
    mode_jp = {"order": "都度", "multi": "まとめ", "total": "トータル"}.get(recommend, "都度")
    verdict = (
        f"2-opt最適化で移動距離を最大 {headline:.0f}% 削減"
        f"（{mode_jp}ピックが最も効果的）。"
        if has_data else
        "オーダー（出荷データ）を取込むと、ピック順序の最適化効果を試算します。"
    )

    return JSONResponse({
        "has_data": has_data,
        "n_orders": len(orders_pts),
        "sampled": sampled,
        "wall_aware": wall_aware,
        "walk_speed_mps": walk_speed,
        "handle_s_per_line": handle_s,
        "methods": ["naive", "greedy", "optimized"],
        "method_labels": {"naive": "ナイーブ（並び順）",
                          "greedy": "貪欲（最近傍）",
                          "optimized": "最適化（2-opt）"},
        "modes": modes_out,
        "recommend_mode": recommend,
        "headline_reduction_pct": headline,
        "verdict": verdict,
    })


@router.get("/api/projects/{name}/runs/{run}/events.{fmt}")
def api_run_events(name: str, run: str, fmt: str, rep: int = 0):
    """生イベントログのダウンロード — その KPI が何から出たのかを開ける形で渡す。

    ``run`` は run ディレクトリ名（``latest`` で最新）。``jsonl`` はエンジンが
    書いたものをそのまま（1行1イベント・無加工）、``json`` は同じ内容の配列、
    ``csv`` は日本語Excelが開ける BOM 付き（共通5列＋残りは meta の JSON 列）。
    ``?rep=N`` で N 番目のレプリケーションのログ（既定 0）— kpis.json は全rep
    平均なので、監査は全 rep を取れなければ再導出にならない。
    never-blocks: ログを持たない過去の run・存在しない rep は 404（500 にしない）。"""
    from whsim import eventlog
    if fmt not in ("jsonl", "json", "csv"):
        raise HTTPException(404, "unknown format")
    proj = _open(name)
    rd = (proj.latest_run_dir() if run == "latest"
          else proj.runs_dir / _safe_name(run))
    fname = eventlog.EVENTS_JSONL if rep <= 0 else f"events_rep{rep:02d}.jsonl"
    if rd is None or not (rd / fname).is_file():
        raise HTTPException(404, "no event log for this run/rep")
    if fmt == "jsonl":
        return FileResponse(rd / fname,
                            media_type="application/x-ndjson",
                            filename=f"{name}_{rd.name}_{fname}")
    events = [json.loads(x) for x in
              (rd / fname).read_text("utf-8").splitlines() if x.strip()]
    if fmt == "json":
        return JSONResponse(events)
    return Response(
        eventlog.to_csv(events), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition":
                 f'attachment; filename="{rd.name}_events.csv"'})


@router.get("/api/projects/{name}/png")
def api_png(name: str):
    proj = _open(name)
    rd = proj.latest_run_dir()
    if rd is None or not (rd / "layout_heatmap.png").is_file():
        raise HTTPException(404, "no png yet")
    return FileResponse(rd / "layout_heatmap.png")
