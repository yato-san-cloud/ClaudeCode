"""レイアウトの外部エクスポート endpoints — GeoJSON と CSV。

図面を**レンダラ非依存の中間形式**で外へ出す2本 (`whsim.geoexport`):

* ``GET /api/projects/{name}/layout.geojson`` — 1 Feature = 間口1つ (RFC 7946)。
  `?grouped=1` で段を畳んだ棚 (間口列) 単位。three.js / Collada / 地理系ツール向け。
* ``GET /api/projects/{name}/layout.csv`` — 間口1行の BOM 付き UTF-8 CSV。
  Power BI (Deneb / Vega-Lite) は**データモデルの行**を受けるので、実務の入口はこちら。

どちらも同じ `geoexport._rows` から出るので、2つの表現が食い違うことはない。読み取り
専用 (モデルを一切変更しない・シミュレーションに触れない) で、never-blocks:
ロケーション0件のプロジェクトでも空の FeatureCollection / ヘッダのみの CSV を返す。
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, Response

from whsim import geoexport

from ._common import _open

router = APIRouter()


def _disposition(name: str, filename: str) -> dict[str, str]:
    """Content-Disposition with an ASCII fallback + RFC 5987 UTF-8 name.

    プロジェクト名は日本語のことがあるので、素の filename= には入れられない。"""
    star = quote(f"{name}_{filename}", safe="")
    return {"Content-Disposition":
            f'attachment; filename="{filename}"; filename*=UTF-8\'\'{star}'}


def _metrics_for(model, metrics: int):
    """`?metrics=1` (既定) のときだけ 出荷実績/在庫 から数値属性を実測して返す。"""
    if not metrics:
        return None
    return geoexport.metrics_from_orders(model) or None


@router.get("/api/projects/{name}/layout.geojson")
def api_layout_geojson(name: str, grouped: bool = False, metrics: bool = True):
    """レイアウトの GeoJSON (FeatureCollection)。

    ``?grouped=1`` で段 (level) を畳んだ棚単位 Feature、``?metrics=0`` で数値属性を
    穴 (null) のまま出す。座標は**倉庫ローカルのメートル・原点は左下・y は上向き**
    (緯度経度ではない) — 詳細は `docs/geojson-export.md`。"""
    proj = _open(name)
    model = proj.load_model()
    mode = "grouped" if grouped else "per-level"
    try:
        fc = geoexport.to_geojson(model, level_mode=mode,
                                  metrics=_metrics_for(model, metrics))
    except ValueError as e:  # unknown level_mode is the only raise (never from data)
        raise HTTPException(400, str(e))
    return JSONResponse(fc, headers=_disposition(name, "layout.geojson"),
                        media_type="application/geo+json")


@router.get("/api/projects/{name}/layout.csv")
def api_layout_csv(name: str, metrics: bool = True):
    """間口1行のレイアウト CSV (BOM 付き UTF-8) — Power BI / Excel の入口。

    列は ``location_id,x,y,w,d,level,area,rack_no,aisle`` ＋ 数値属性スロット。
    ``x``/``y`` は矩形の左下角 (m)、``w``/``d`` を足すと右上角。GeoJSON と同一の幾何源。"""
    proj = _open(name)
    model = proj.load_model()
    body = geoexport.to_layout_csv(model, metrics=_metrics_for(model, metrics))
    return Response(body, media_type="text/csv; charset=utf-8",
                    headers=_disposition(name, "layout.csv"))


@router.get("/api/projects/{name}/runs.csv")
def api_runs_csv(name: str):
    """Power BI 用スタースキーマの次元表: プロジェクトの全 run（1行1run）。

    kpi_facts.csv と run_id で結合する。never-blocks: run が無ければヘッダのみ。"""
    from whsim import geoexport
    proj = _open(name)
    return Response(geoexport.to_runs_csv(geoexport.project_run_summaries(proj)),
                    media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition":
                             f'attachment; filename="{name}_runs.csv"'})


@router.get("/api/projects/{name}/kpi-facts.csv")
def api_kpi_facts_csv(name: str):
    """Power BI 用ファクト表（long format: run_id × kpi × value）。

    値は各 run の kpis.json（イベントログ集計）からの転記のみ — この層は
    集計しない。ベルト別などの入れ子は dotted key（conveyors.spur1n.…）。"""
    from whsim import geoexport
    proj = _open(name)
    return Response(geoexport.to_kpi_facts_csv(geoexport.project_run_summaries(proj)),
                    media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition":
                             f'attachment; filename="{name}_kpi_facts.csv"'})
