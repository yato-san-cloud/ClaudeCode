"""DXF -> (layout.geojson, report.json). One pass, never blocks on ambiguity."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import GENERATOR
from .aisles import GraphResult, build_graph, shortest_path_geometry
from .config import Config
from .dxfread import read_geometry
from .layout import build_layout
from .racks import Rack, extract_racks
from .validate import AssertionResult, check_assertions, load_schema, validate


@dataclass
class ConversionResult:
    layout: dict[str, Any]
    report: dict[str, Any]
    racks: list[Rack] = field(default_factory=list)
    graph: GraphResult | None = None
    schema_errors: list[str] = field(default_factory=list)
    assertions: AssertionResult | None = None

    @property
    def ok(self) -> bool:
        return not self.schema_errors and bool(self.assertions and self.assertions.ok)


def _zones(raw, cfg: Config) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    from .racks import clean_polygon

    zones: list[dict[str, Any]] = []
    notes: list[dict[str, Any]] = []
    for index, ring in enumerate(raw.by_kind("zone", "ring")):
        poly = clean_polygon(ring["points"])
        if poly is None:
            notes.append(
                {"layer": ring["layer"], "dxftype": ring["type"], "reason": "ゾーンの閉図形が不正"}
            )
            continue
        zones.append(
            {
                "id": f"z{index + 1:04d}",
                "label": cfg.zone_label(ring["layer"]),
                "polygon": poly,
            }
        )
    loose = len(raw.by_kind("zone", "segment"))
    if loose:
        notes.append({"reason": f"ゾーンレイヤの線分 {loose} 本は閉図形でないため無視"})
    return zones, notes


def convert(dxf_path: str | Path, cfg: Config) -> ConversionResult:
    source = Path(dxf_path)
    raw = read_geometry(source, cfg)
    racks, rack_notes = extract_racks(raw, cfg)
    zones, zone_notes = _zones(raw, cfg)
    graph = build_graph(raw, racks, cfg)

    decimals = int(cfg.get("output", "coord_decimals", default=4))
    meta = {
        "generator": GENERATOR,
        "source": source.name,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "units": {"scale_to_m": raw.scale, "offset_m": [round(v, 4) + 0.0 for v in raw.offset]},
        "grid_spacing_m": round(graph.grid_spacing_m, 4),
        "counts": {
            "rack": len(racks),
            "zone": len(zones),
            "node": len(graph.nodes),
            "edge": len(graph.edges),
        },
    }
    layout = build_layout(racks, graph, zones, meta, decimals)

    schema_errors = validate(layout, load_schema())
    assertions = check_assertions(layout)

    sample_path = None
    if len(graph.nodes) >= 2:
        geom = shortest_path_geometry(
            graph.nodes, graph.edges, graph.nodes[0].id, graph.nodes[-1].id
        )
        if geom is not None:
            sample_path = {
                "from": graph.nodes[0].id,
                "to": graph.nodes[-1].id,
                "length_m": round(geom.length, 3),
            }

    report = {
        "schema_version": "1.0",
        "generator": GENERATOR,
        "source": str(source),
        "created_at": meta["created_at"],
        "dxf": {
            "entities_read": raw.entity_count,
            "recovered": raw.recovered,
            "recover_errors": raw.recover_errors[:20],
        },
        "transform": {
            "scale_to_m": raw.scale,
            "offset_m": [round(v, 6) + 0.0 for v in raw.offset],
            "source_bounds": list(raw.bounds_source) if raw.bounds_source else None,
        },
        "counts": meta["counts"],
        "rack_sources": {
            "polyline": sum(1 for r in racks if r.source == "polyline"),
            "cluster": sum(1 for r in racks if r.source == "cluster"),
        },
        "unclassified": raw.unclassified,
        "ambiguous": raw.ambiguous + rack_notes + zone_notes + graph.notes,
        "isolated_nodes": graph.dropped_nodes,
        "warnings": list(raw.warnings),
        "assertions": {
            "schema_valid": not schema_errors,
            "schema_errors": schema_errors[:50],
            **assertions.as_dict(),
        },
        "sample_shortest_path": sample_path,
    }
    if not racks:
        report["warnings"].append("ラックが1つも抽出できませんでした（mapping.yaml のレイヤ設定を確認）")
    if not graph.nodes:
        report["warnings"].append("通路ノードが1つも生成されませんでした")

    return ConversionResult(
        layout=layout,
        report=report,
        racks=racks,
        graph=graph,
        schema_errors=schema_errors,
        assertions=assertions,
    )
