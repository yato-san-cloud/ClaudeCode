"""A dependency-free JSON Schema (draft-07 subset) validator.

Only the keywords used by ``tools/logforge/schema/*.json`` are implemented, and
an unknown keyword is a hard error rather than a silent pass -- a validator that
quietly ignores a rule it does not understand is worse than no validator, since
it reports "valid" for a document nobody checked.

Supported: type, const, enum, required, properties, patternProperties,
additionalProperties, items, minimum, maximum, minLength, minItems,
minProperties, pattern, anyOf, allOf.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

_ANNOTATIONS = frozenset({"$schema", "$id", "title", "description", "examples", "default"})

_SUPPORTED = frozenset(
    {
        "type",
        "const",
        "enum",
        "required",
        "properties",
        "patternProperties",
        "additionalProperties",
        "items",
        "minimum",
        "maximum",
        "minLength",
        "minItems",
        "minProperties",
        "pattern",
        "anyOf",
        "allOf",
    }
)


class SchemaError(ValueError):
    """The schema itself is malformed / uses an unsupported keyword."""


def load_schema(path: str | Path) -> dict[str, Any]:
    schema = json.loads(Path(path).read_text(encoding="utf-8"))
    _check_schema(schema, "#")
    return schema


def validate(instance: Any, schema: dict[str, Any], path: str = "$") -> list[str]:
    """Return a list of human-readable errors ([] means valid)."""
    errors: list[str] = []
    _validate(instance, schema, path, errors)
    return errors


# --------------------------------------------------------------------------- #
# schema self-check
# --------------------------------------------------------------------------- #
def _check_schema(schema: Any, where: str) -> None:
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        raise SchemaError(f"{where}: schema must be an object")
    for key, value in schema.items():
        if key in _ANNOTATIONS:
            continue
        if key not in _SUPPORTED:
            raise SchemaError(f"{where}: unsupported schema keyword {key!r}")
        if key in ("properties", "patternProperties"):
            for name, sub in value.items():
                _check_schema(sub, f"{where}/{key}/{name}")
        elif key in ("items", "additionalProperties"):
            _check_schema(value, f"{where}/{key}")
        elif key in ("anyOf", "allOf"):
            for i, sub in enumerate(value):
                _check_schema(sub, f"{where}/{key}/{i}")


# --------------------------------------------------------------------------- #
# instance validation
# --------------------------------------------------------------------------- #
def _type_ok(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    raise SchemaError(f"unknown type {expected!r}")


def _validate(inst: Any, schema: Any, path: str, errors: list[str]) -> None:
    if schema is True or schema == {}:
        return
    if schema is False:
        errors.append(f"{path}: not allowed here")
        return

    if "type" in schema:
        expected = schema["type"]
        options = [expected] if isinstance(expected, str) else list(expected)
        if not any(_type_ok(inst, opt) for opt in options):
            errors.append(f"{path}: expected type {'|'.join(options)}, got {type(inst).__name__}")
            return

    if "const" in schema and inst != schema["const"]:
        errors.append(f"{path}: must be {schema['const']!r}, got {inst!r}")
    if "enum" in schema and inst not in schema["enum"]:
        errors.append(f"{path}: {inst!r} is not one of {schema['enum']}")

    if "anyOf" in schema and not any(
            not validate(inst, sub, path) for sub in schema["anyOf"]):
        errors.append(f"{path}: {inst!r} matches none of the allowed forms")
    if "allOf" in schema:
        for sub in schema["allOf"]:
            _validate(inst, sub, path, errors)

    if isinstance(inst, str):
        if "minLength" in schema and len(inst) < schema["minLength"]:
            errors.append(f"{path}: shorter than minLength {schema['minLength']}")
        if "pattern" in schema and re.search(schema["pattern"], inst) is None:
            errors.append(f"{path}: {inst!r} does not match {schema['pattern']!r}")

    if isinstance(inst, (int, float)) and not isinstance(inst, bool):
        if "minimum" in schema and inst < schema["minimum"]:
            errors.append(f"{path}: {inst} < minimum {schema['minimum']}")
        if "maximum" in schema and inst > schema["maximum"]:
            errors.append(f"{path}: {inst} > maximum {schema['maximum']}")

    if isinstance(inst, list):
        if "minItems" in schema and len(inst) < schema["minItems"]:
            errors.append(f"{path}: fewer than minItems {schema['minItems']}")
        if "items" in schema:
            for i, item in enumerate(inst):
                _validate(item, schema["items"], f"{path}[{i}]", errors)

    if isinstance(inst, dict):
        _validate_object(inst, schema, path, errors)


def _validate_object(inst: dict, schema: dict, path: str, errors: list[str]) -> None:
    for key in schema.get("required", []):
        if key not in inst:
            errors.append(f"{path}: missing required property {key!r}")
    if "minProperties" in schema and len(inst) < schema["minProperties"]:
        errors.append(f"{path}: fewer than minProperties {schema['minProperties']}")

    props = schema.get("properties", {})
    pattern_props = schema.get("patternProperties", {})
    additional = schema.get("additionalProperties", True)

    for key, value in inst.items():
        child = f"{path}.{key}"
        matched = False
        if key in props:
            _validate(value, props[key], child, errors)
            matched = True
        for pattern, sub in pattern_props.items():
            if re.search(pattern, key):
                _validate(value, sub, child, errors)
                matched = True
        if matched:
            continue
        if additional is False:
            errors.append(f"{path}: unexpected property {key!r}")
        elif additional is not True:
            _validate(value, additional, child, errors)
