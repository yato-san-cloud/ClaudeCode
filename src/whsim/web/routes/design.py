"""③設計 analytic 試算 endpoints: 保管設備 sizing (+ layout apply), the LOGISTEED
原価積み上げ, the motion-time 生産性試算, and the 生産性ベンチマークライブラリ. All
closed-form (no DES) so the design screen feels instant."""

from __future__ import annotations

from fastapi import APIRouter

from ._common import _open

router = APIRouter()


@router.get("/api/projects/{name}/storage")
def api_storage(name: str, stock_days: float | None = None, tsubo_rate: float | None = None,
                aisle_factor: float | None = None, bulk_cases: int | None = None,
                office_tsubo: float | None = None, bulk_rack_type: str | None = None,
                working_hours_per_day: float | None = None,
                crane_vx: float | None = None, crane_vy: float | None = None,
                crane_tfix: float | None = None, asrs_command: str | None = None):
    """保管設備の試算: 物量→必要保管機器(間口/台数/坪)→保管費。Query params override
    the 試算 defaults (在庫日数・坪単価・通路率・bulk閾値・事務所坪)。bulk_rack_type=asrs
    で bulk C品を自動倉庫に寄せ、クレーン諸元(vx/vy/tfix)から FEM 9.851 クレーン台数を算出。"""
    from whsim import storage
    params = {"stock_days": stock_days, "tsubo_rate": tsubo_rate,
              "aisle_factor": aisle_factor, "bulk_cases": bulk_cases,
              "office_tsubo": office_tsubo, "bulk_rack_type": bulk_rack_type,
              "working_hours_per_day": working_hours_per_day,
              "crane_vx": crane_vx, "crane_vy": crane_vy, "crane_tfix": crane_tfix,
              "asrs_command": asrs_command}
    return storage.estimate_storage(_open(name).load_model(), params)


@router.post("/api/projects/{name}/storage/apply-layout")
def api_storage_apply(name: str, payload: dict | None = None):
    """保管設計→レイアウト反映: size the equipment from demand (same params as
    GET /storage, via the JSON body) and author it into the largest storage zone
    as shelf runs (REPLACING that zone's shelves), re-materialise locations, and
    mark layout/locations GENERATED. Returns the placement summary."""
    from whsim import storage
    from whsim.design import materialize_racks
    from whsim.provenance import Source
    proj = _open(name)
    model = proj.load_model()
    est = storage.estimate_storage(model, payload or {})
    if not est.get("has_data"):
        return {"ok": False, "message": "配置できる保管物量がまだありません。"}
    placed = storage.place_equipment(model, est)
    materialize_racks(model)
    proj.save_model(model)
    prov = proj.load_provenance()
    prov.mark("layout", Source.GENERATED)
    prov.mark("locations", Source.GENERATED)
    proj.save_provenance(prov)
    return {"ok": True, **placed, "locations": len(model.locations),
            "provenance_summary": prov.summary(),
            "message": (f"{placed['placed']}台を{placed['shelves']}列に配置しました"
                        + (f"（{placed['unplaced']}台は入りきりません）" if placed["unplaced"] else "。"))}


@router.get("/api/projects/{name}/cost")
def api_cost(name: str, labor_cost_per_hour: float | None = None,
             fixed_labor_per_month: float | None = None,
             tsubo_rate_per_month: float | None = None,
             delivery_cost_per_cage: float | None = None,
             system_cost_per_month: float | None = None,
             overhead_rate: float | None = None,
             working_days_per_month: float | None = None,
             nonworking: str | None = None):
    """原価試算: analytic 6費目 build-up (no sim). Query params override Settings
    unit prices live (so the 原価試算 screen feels instant); persistence is via
    PUT /settings. Returns the per-category breakdown with formulas."""
    from whsim import cost
    params = {k: v for k, v in {
        "labor_cost_per_hour": labor_cost_per_hour,
        "fixed_labor_per_month": fixed_labor_per_month,
        "tsubo_rate_per_month": tsubo_rate_per_month,
        "delivery_cost_per_cage": delivery_cost_per_cage,
        "system_cost_per_month": system_cost_per_month,
        "overhead_rate": overhead_rate,
        "working_days_per_month": working_days_per_month,
    }.items() if v is not None}
    if nonworking:
        params["nonworking"] = nonworking
    return cost.estimate_cost(_open(name).load_model(), params)


@router.get("/api/projects/{name}/pickrate")
def api_pickrate(name: str, walk_speed_mps: float | None = None,
                 handle_s_per_line: float | None = None,
                 sort_s_per_line: float | None = None,
                 lines_per_order: float | None = None,
                 labour_cost_per_hour: float | None = None,
                 working_hours_per_day: float | None = None):
    """生産性試算: 解析的(動作時間)なピッキング生産性を全作業方式について算出。
    MapMaker距離(レイアウト幾何)×動作時間で、オーダー/マルチ/トータルを DES なしで
    即比較する SLC 流のステップ②。Query params override the motion-time standards."""
    from whsim import pickrate
    params = {"walk_speed_mps": walk_speed_mps, "handle_s_per_line": handle_s_per_line,
              "sort_s_per_line": sort_s_per_line, "lines_per_order": lines_per_order,
              "labour_cost_per_hour": labour_cost_per_hour,
              "working_hours_per_day": working_hours_per_day}
    return pickrate.estimate_pickrate(_open(name).load_model(), params)


@router.get("/api/benchmarks")
def api_benchmarks():
    """生産性ベンチマークライブラリ: 物流形態別の想定生産性プリセット一覧。"""
    from whsim import benchmarks
    return {"benchmarks": benchmarks.catalog()}


@router.post("/api/projects/{name}/benchmark/{bid}/apply")
def api_benchmark_apply(name: str, bid: str):
    """物流形態プリセットを適用: 想定生産性→settings.benchmark_productivity、
    坪単価等の計画値→settings。荷姿の計画値は応答で返し、クライアントが基礎物量に
    seed する。原価/タイムチャート/想定vs実測の"想定"がこのベンチマークに切替わる。"""
    from whsim import benchmarks
    from whsim.provenance import Source
    proj = _open(name)
    model = proj.load_model()
    res = benchmarks.apply(model, bid)
    if not res.get("ok"):
        return res
    proj.save_model(model)
    prov = proj.load_provenance()
    prov.mark("settings", Source.INTERVIEW)
    proj.save_provenance(prov)
    return res
