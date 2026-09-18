"""パラメータ自動掃引 (ミニOptQuest) endpoint.

Sweeps 作業方式 × 人員数 × まとめ数 over the analytic evaluators and returns a
ranked table (see :mod:`whsim.sweep`). Cheap because every point is scored
analytically — the commercial 「機械が最適を探した」 story without a DES run. The
top picks are meant to be back-tested via ▶実行 (DES) from the UI."""

from __future__ import annotations

from fastapi import APIRouter

from whsim import sweep as sweep_mod
from whsim.analysis import staffing

from ._common import _open

router = APIRouter()


@router.post("/api/projects/{name}/sweep")
def api_sweep(name: str, payload: dict | None = None):
    """作業方式×人員数×まとめ数 を解析的に総当り評価し、順位表を返す。

    Body (all optional): ``grid`` with axis overrides
    (``methods`` / ``pickers`` / ``orders_per_trip``). Volumes come from the
    project's best-available 物量 (BI 仮値 → measured orders); no demand yet →
    ``{available: false}`` (never-blocks)."""
    proj = _open(name)
    model = proj.load_model()
    volumes = staffing.project_volumes(proj)
    grid = (payload or {}).get("grid") if isinstance(payload, dict) else None
    return sweep_mod.run_sweep(model, volumes, grid)
