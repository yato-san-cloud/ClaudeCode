"""在庫・棚割り endpoints: 在庫最適化 (安全在庫・発注点), 棚割り最適化 (加重歩行距離
＋併買アフィニティ＋季節性), and the フリーロケ vs 固定ロケ 保管戦略 recommendation.
All analytic (no sim); slotting/apply is the only mutator (writes the pegging, never
the schema). never-blocks: no demand → {available:false} / placed=0."""

from __future__ import annotations

from fastapi import APIRouter

from ._common import Source, _open

router = APIRouter()


@router.get("/api/projects/{name}/inventory-opt")
def api_inventory_opt(name: str, lead_time: float = 3.0, review: float = 0.0,
                      service_level: float = 0.95):
    """在庫最適化: SKU 別の 安全在庫・発注点 を出荷実績から解析的に試算する。

    ①取込で永続化した出荷テーブル (analysis/shipments.csv) を優先し、無ければ
    model.orders から復元 (物量サマリと同じ二段構え)。パラメータは query のみ
    (lead_time=LT日 / review=発注間隔R日〔0=発注点方式〕 / service_level=サービス率)
    で、スキーマには保存しない。需要データがまだ無ければ {available:false} を返す
    ── never-blocks。σ は観測期間の需要ゼロ日も含めて実測から直接求める。"""
    import pandas as pd  # noqa: F401 — inventoryopt / ingest need pandas importable

    from whsim.analysis import ingest, inventoryopt, tablestore
    proj = _open(name)
    ship = tablestore.load_saved_table(proj, "shipments")
    if ship is None:
        ship = ingest.orders_to_frame(proj.load_model().orders.outbound)
    if ship is None or ship.empty:
        return {"available": False,
                "message": "出荷データがまだありません。①取込で出荷実績を取り込んでください。"}
    return inventoryopt.analyze(ship, lead_time_days=lead_time, review_days=review,
                                service_level=service_level)


@router.get("/api/projects/{name}/slotting")
def api_slotting(name: str, affinity_weight: float = 0.0, include_seasonality: int = 0):
    """棚割り: current weighted pick-distance, the optimisation preview (BEFORE vs
    AFTER + top SKU moves), and the storage-strategy recommendation — all analytic
    (no sim, no mutation). 'never blocks': a bare model returns placed=0 / strategy
    available=false rather than an error.

    Additive knobs: ``affinity_weight`` (0–1) blends a 併買 co-pick pull into the
    greedy (0 = the legacy result, byte-identical); ``include_seasonality=1`` adds a
    月次 ABC-drift 入替候補リスト from the saved shipments table (recommendation only)."""
    from whsim import slottingopt, storagestrategy
    proj = _open(name)
    model = proj.load_model()
    aff = min(1.0, max(0.0, float(affinity_weight)))
    base = slottingopt.optimize(model, affinity_weight=0.0)
    plan = base if aff <= 0.0 else slottingopt.optimize(model, affinity_weight=aff)
    out = {
        "optimization": slottingopt.plan_summary(plan),
        "strategy": storagestrategy.recommend(model),
        "affinity": slottingopt.affinity_report(model, aff, baseline=base, plan=plan),
    }
    if include_seasonality:
        out["seasonality"] = _seasonality_block(proj)
    return out


def _seasonality_block(proj) -> dict:
    """季節性: read the saved shipments table and hand (month, sku, qty) rows to the
    analytic seasonality solver. Tolerant — a missing table / dateless data returns
    the ``available=false`` shape rather than raising (never blocks)."""
    from whsim import slottingopt
    from whsim.analysis import tablestore
    df = tablestore.load_saved_table(proj, "shipments")
    if df is None or "date" not in df.columns or "sku" not in df.columns:
        return {"available": False, "months_observed": 0, "rows": [],
                "message": "月次の入替候補には、日付つき出荷データの取込が必要です。"}
    try:
        import pandas as pd
        d = df.dropna(subset=["date"]).copy()
        d["month"] = pd.to_datetime(d["date"], errors="coerce").dt.strftime("%Y-%m")
        d = d.dropna(subset=["month"])
        qty = d["qty"] if "qty" in d.columns else 1
        records = list(zip(d["month"], d["sku"].astype(str),
                           qty if "qty" in d.columns else [1] * len(d)))
    except Exception:  # noqa: BLE001 — a malformed table must not block the view
        return {"available": False, "months_observed": 0, "rows": [],
                "message": "出荷データの日付を解釈できませんでした。"}
    return slottingopt.seasonality(records)


@router.post("/api/projects/{name}/slotting/apply")
def api_slotting_apply(name: str, payload: dict | None = None):
    """棚割りを最適化して適用: write the optimised pegging onto item.default_location
    / loc.sku (NEVER the schema), persist, and mark locations as INTERVIEW-sourced.
    Returns the same summary as GET plus the placed count."""
    from whsim import slottingopt
    proj = _open(name)
    model = proj.load_model()
    aff = min(1.0, max(0.0, float((payload or {}).get("affinity_weight", 0.0) or 0.0)))
    plan = slottingopt.optimize(model, affinity_weight=aff)
    placed = slottingopt.apply_plan(model, plan)
    proj.save_model(model)
    prov = proj.load_provenance()
    prov.mark("locations", Source.INTERVIEW)
    proj.save_provenance(prov)
    summary = slottingopt.plan_summary(plan)
    summary["applied"] = placed
    summary["message"] = (
        f"{placed}SKUを最適スロットに割付。加重歩行距離を"
        f"{round(plan.reduction_pct * 100)}%短縮しました。"
        if plan.reduction > 0 else f"{placed}SKUを割付しました。"
    )
    return summary


@router.get("/api/projects/{name}/storage-strategy")
def api_storage_strategy(name: str, active_days: float | None = None):
    """保管戦略: フリーロケ vs 固定ロケ(リザーブ＋アクティブ) を velocity/cube/turnover
    から per-SKU + 全体で推奨。補充回数/日と 歩行短縮 vs 補充工数 のトレードオフ付き。"""
    from whsim import storagestrategy
    params = {"active_days": active_days} if active_days is not None else {}
    return storagestrategy.recommend(_open(name).load_model(), params)
