"""Self-contained JSON Schema validation + the contract's common assertions.

The jsonschema package is deliberately NOT a dependency: the subset the layout
schema uses (type/const/enum/required/properties/items/prefixItems/oneOf/$ref/…)
is small enough to implement here, and the tool stays installable with the five
libraries the run allows.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import networkx as nx
import shapely
from shapely.geometry import shape
from shapely.strtree import STRtree

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema" / "layout.schema.json"

_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
}


def load_schema(path: str | Path | None = None) -> dict[str, Any]:
    return json.loads(Path(path or SCHEMA_PATH).read_text(encoding="utf-8"))


def _resolve_ref(root: dict[str, Any], ref: str) -> dict[str, Any]:
    if not ref.startswith("#"):
        raise ValueError(f"外部参照は未対応です: {ref}")
    cur: Any = root
    for token in ref.lstrip("#/").split("/"):
        if not token:
            continue
        token = token.replace("~1", "/").replace("~0", "~")
        cur = cur[token]
    return cur


def validate(instance: Any, schema: dict[str, Any], root: dict[str, Any] | None = None,
             path: str = "$") -> list[str]:
    """Return a list of human-readable validation errors (empty = valid)."""
    root = root if root is not None else schema
    errors: list[str] = []
    if schema is True or schema == {}:
        return errors
    if schema is False:
        return [f"{path}: スキーマが常に不合格"]

    if "$ref" in schema:
        errors += validate(instance, _resolve_ref(root, schema["$ref"]), root, path)

    if "type" in schema:
        types = schema["type"]
        types = [types] if isinstance(types, str) else list(types)
        if not any(_TYPE_CHECKS.get(t, lambda _v: False)(instance) for t in types):
            errors.append(f"{path}: 型が {'/'.join(types)} ではありません ({type(instance).__name__})")
            return errors

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: {schema['const']!r} である必要があります (実際: {instance!r})")
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: {schema['enum']!r} のいずれかである必要があります (実際: {instance!r})")

    if isinstance(instance, dict):
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{path}: 必須プロパティ {key!r} がありません")
        props = schema.get("properties", {})
        for key, subschema in props.items():
            if key in instance:
                errors += validate(instance[key], subschema, root, f"{path}.{key}")
        extra = schema.get("additionalProperties")
        if extra is not None and extra is not True:
            for key, value in instance.items():
                if key in props:
                    continue
                if extra is False:
                    errors.append(f"{path}: 未知のプロパティ {key!r}")
                else:
                    errors += validate(value, extra, root, f"{path}.{key}")

    if isinstance(instance, list):
        prefix = schema.get("prefixItems", [])
        for index, subschema in enumerate(prefix):
            if index < len(instance):
                errors += validate(instance[index], subschema, root, f"{path}[{index}]")
        items = schema.get("items")
        if isinstance(items, dict):
            for index in range(len(prefix), len(instance)):
                errors += validate(instance[index], items, root, f"{path}[{index}]")
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: 要素数 {len(instance)} < minItems {schema['minItems']}")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{path}: 要素数 {len(instance)} > maxItems {schema['maxItems']}")

    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append(f"{path}: 文字数 {len(instance)} < minLength {schema['minLength']}")
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            errors.append(f"{path}: 文字数 {len(instance)} > maxLength {schema['maxLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], instance):
            errors.append(f"{path}: pattern {schema['pattern']!r} に一致しません")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path}: {instance} < minimum {schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{path}: {instance} > maximum {schema['maximum']}")
        if "exclusiveMinimum" in schema and instance <= schema["exclusiveMinimum"]:
            errors.append(f"{path}: {instance} <= exclusiveMinimum {schema['exclusiveMinimum']}")
        if "exclusiveMaximum" in schema and instance >= schema["exclusiveMaximum"]:
            errors.append(f"{path}: {instance} >= exclusiveMaximum {schema['exclusiveMaximum']}")

    for subschema in schema.get("allOf", []):
        errors += validate(instance, subschema, root, path)
    if "anyOf" in schema and not any(
        not validate(instance, s, root, path) for s in schema["anyOf"]
    ):
        errors.append(f"{path}: anyOf のどの選択肢にも一致しません")
    if "oneOf" in schema:
        branch_errors = [validate(instance, s, root, path) for s in schema["oneOf"]]
        matched = sum(1 for e in branch_errors if not e)
        if matched != 1:
            errors.append(f"{path}: oneOf に一致した選択肢が {matched} 個（1個である必要）")
            if matched == 0:
                # Surface the closest branch's reasons, else the message is useless.
                closest = min(branch_errors, key=len)
                errors.extend(f"  ↳ {e}" for e in closest[:5])
    if "not" in schema and not validate(instance, schema["not"], root, path):
        errors.append(f"{path}: not スキーマに一致してしまいました")
    return errors


# ---------------------------------------------------------------- assertions


@dataclass
class AssertionResult:
    edge_rack_intersections: int = 0
    intersecting_edges: list[str] = field(default_factory=list)
    connected: bool = True
    component_count: int = 0
    isolated_nodes: list[str] = field(default_factory=list)
    dangling_edges: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return (
            self.edge_rack_intersections == 0
            and self.connected
            and not self.dangling_edges
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "edge_rack_intersections": self.edge_rack_intersections,
            "intersecting_edges": self.intersecting_edges[:50],
            "connected": self.connected,
            "component_count": self.component_count,
            "isolated_nodes": self.isolated_nodes[:200],
            "dangling_edges": self.dangling_edges[:50],
            "ok": self.ok,
        }


def _features(layout: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    return [
        f
        for f in layout.get("features", [])
        if isinstance(f, dict) and (f.get("properties") or {}).get("kind") == kind
    ]


def check_assertions(layout: dict[str, Any]) -> AssertionResult:
    """The contract's common assertions, run on the emitted document itself."""
    result = AssertionResult()
    racks = [shape(f["geometry"]) for f in _features(layout, "rack")]
    edge_features = _features(layout, "edge")
    edges = [shape(f["geometry"]) for f in edge_features]

    if racks and edges:
        tree = STRtree(racks)
        pairs = tree.query(edges, predicate="intersects")
        hit_edge_indices = sorted({int(i) for i in pairs[0]}) if pairs.size else []
        result.edge_rack_intersections = len(hit_edge_indices)
        result.intersecting_edges = [
            str(edge_features[i]["properties"].get("id")) for i in hit_edge_indices
        ]

    node_ids = [str(f["properties"]["id"]) for f in _features(layout, "node")]
    graph = nx.Graph()
    graph.add_nodes_from(node_ids)
    known = set(node_ids)
    for feature in edge_features:
        props = feature["properties"]
        frm, to = str(props.get("from")), str(props.get("to"))
        if frm not in known or to not in known:
            result.dangling_edges.append(str(props.get("id")))
            continue
        graph.add_edge(frm, to)
    if node_ids:
        components = sorted(nx.connected_components(graph), key=len, reverse=True)
        result.component_count = len(components)
        result.connected = len(components) == 1
        for component in components[1:]:
            result.isolated_nodes.extend(sorted(component))
    return result


def path_hits_racks(layout: dict[str, Any], path_geom: Any) -> int:
    """Count rack polygons a given path geometry intersects (0 expected)."""
    racks = [shape(f["geometry"]) for f in _features(layout, "rack")]
    if not racks or path_geom is None:
        return 0
    return int(sum(1 for rack in racks if shapely.intersects(path_geom, rack)))
