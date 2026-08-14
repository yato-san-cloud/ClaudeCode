"""mapping.yaml — every drawing-specific decision lives here, none in the code.

Layer names, colours and unit factors differ per drawing office, so the tool
hardcodes nothing: layer -> kind (rack candidate / wall / zone / ignore) and the
drawing-unit -> metre factor are configuration.
"""

from __future__ import annotations

import copy
import fnmatch
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .errors import Cad2locError

# Defaults are deliberately generous: an unknown drawing still produces output
# (unmatched layers are reported, not fatal).
DEFAULTS: dict[str, Any] = {
    "units": {
        # number (drawing unit -> metre) or "auto" (guess mm vs m from extents)
        "scale_to_m": "auto",
        "auto_mm_threshold": 2000.0,
    },
    "origin": {
        # "bbox_min" = translate so the drawing's lower-left corner is (0, 0)
        "mode": "bbox_min",
    },
    "layers": {
        "rack": ["*rack*", "*shelf*", "*棚*", "*ラック*"],
        "wall": ["*wall*", "*壁*", "*躯体*", "*outline*"],
        "zone": ["*zone*", "*area*", "*エリア*", "*ゾーン*"],
        "ignore": [
            "defpoints",
            "*dim*",
            "*text*",
            "*文字*",
            "*寸法*",
            "*hatch*",
            "*grid*",
            "*通り芯*",
        ],
    },
    # layer name -> human label for zone features
    "zone_labels": {},
    "rack_detect": {
        "min_area_m2": 0.3,
        "max_area_m2": 2000.0,
        "close_tolerance_m": 0.05,
        "cluster": {
            "enabled": True,
            "eps_m": 0.7,
            "min_samples": 4,
            "sample_step_m": 0.25,
            "min_width_m": 0.15,
            # a cluster overlapping an already-found rack by more than this
            # fraction of its own area is a duplicate and dropped
            "dedupe_overlap": 0.5,
        },
    },
    "aisle_graph": {
        "grid_spacing_m": 1.0,
        "clearance_m": 0.35,
        "envelope_margin_m": 2.0,
        "emit_width": True,
        "max_nodes": 20000,
        "keep_main_component_only": True,
    },
    "output": {
        "coord_decimals": 4,
    },
}


def _deep_merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def _norm(name: str) -> str:
    """Fold width/case so 半角/全角 layer names match the same pattern."""
    return unicodedata.normalize("NFKC", str(name)).strip().casefold()


@dataclass
class Config:
    data: dict[str, Any] = field(default_factory=lambda: copy.deepcopy(DEFAULTS))
    path: Path | None = None

    # -- generic access -------------------------------------------------
    def get(self, *keys: str, default: Any = None) -> Any:
        cur: Any = self.data
        for key in keys:
            if not isinstance(cur, dict) or key not in cur:
                return default
            cur = cur[key]
        return cur

    # -- layer classification -------------------------------------------
    def classify_layer(self, layer: str) -> str:
        """Return one of rack / wall / zone / ignore / unclassified.

        Precedence is fixed (ignore wins, then rack, wall, zone) so a drawing
        that puts dimensions on a layer called "RACK_DIM" can be excluded by
        listing it under ignore.
        """
        name = _norm(layer)
        for kind in ("ignore", "rack", "wall", "zone"):
            for pattern in self.get("layers", kind, default=[]) or []:
                if fnmatch.fnmatch(name, _norm(pattern)):
                    return kind
        return "unclassified"

    def zone_label(self, layer: str) -> str:
        labels = self.get("zone_labels", default={}) or {}
        for key, value in labels.items():
            if _norm(key) == _norm(layer):
                return str(value)
        return str(layer)


def load_config(path: str | Path | None) -> Config:
    """Load mapping.yaml on top of the defaults. No file = pure defaults."""
    if path is None:
        return Config()
    p = Path(path)
    if not p.exists():
        raise Cad2locError(f"設定ファイルが見つかりません: {p}", "--config のパスを確認してください")
    try:
        raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise Cad2locError(f"mapping.yaml を解釈できません: {p}", str(exc)) from exc
    if not isinstance(raw, dict):
        raise Cad2locError(f"mapping.yaml のトップレベルはマッピングである必要があります: {p}")
    # サブキーの型も設定不備として即座に落とす: `layers:` にリスト等を書くと
    # deep merge が既定値を黙って採用し「設定したのにラック0件・exit 0」という
    # 追いにくい空振りになる（受け入れ監査の指摘）。
    for key in ("layers", "units", "racks", "aisles"):
        if key in raw and not isinstance(raw[key], dict):
            raise Cad2locError(
                f"mapping.yaml の `{key}:` はマッピングである必要があります"
                f"（{type(raw[key]).__name__} が指定されています）: {p}")
    return Config(data=_deep_merge(DEFAULTS, raw), path=p)
