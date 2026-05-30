"""Tolerant import of a customer ZIP (or loose JSON files) into the model.

Rules that make the product feel gentle:
  * Per-file parsing. One broken file never rejects the whole bundle.
  * Partial import is fine -- only the subtrees present are overwritten; the rest
    keep their template values and stay 'provisional'.
  * The merged model is validated against the schema, so the result ALWAYS runs.

Each dropped file is routed to a canonical subtree by filename hint first, then
by sniffing the JSON shape as a fallback.
"""

from __future__ import annotations

import io
import json
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from whsim.schema.model import WarehouseModel

# filename substring -> (subtree, optional subkey)
FILENAME_HINTS: list[tuple[str, tuple[str, str | None]]] = [
    ("product_master", ("items", None)),
    ("products", ("items", None)),
    ("item", ("items", None)),
    ("sku", ("items", None)),
    ("outbound", ("orders", "outbound")),
    ("inbound", ("orders", "inbound")),
    ("shipping", ("orders", "outbound")),
    ("receiving", ("orders", "inbound")),
    ("order", ("orders", None)),
    ("location", ("locations", None)),
    ("slot", ("locations", None)),
    ("layout", ("layout", None)),
    ("resource", ("resources", None)),
    ("worker", ("resources", None)),
    ("process", ("process", None)),
    ("simulation", ("simulation", None)),
    ("config", ("simulation", None)),
    ("meta", ("meta", None)),
]


@dataclass
class ImportResult:
    model: WarehouseModel
    touched_subtrees: set[str] = field(default_factory=set)
    warnings: list[str] = field(default_factory=list)
    files_seen: list[str] = field(default_factory=list)


def _sniff_subtree(data) -> tuple[str, str | None] | None:
    """Guess the target subtree from the JSON shape when the filename didn't say."""
    if isinstance(data, list) and data and isinstance(data[0], dict):
        keys = set(data[0])
        if "sku" in keys and "ts_per_unit" in keys or "abc_class" in keys:
            return ("items", None)
        if "order_id" in keys or "lines" in keys:
            return ("orders", "outbound")
        if "id" in keys and ("zone" in keys or {"x", "y"} <= keys):
            return ("locations", None)
        if "sku" in keys:
            return ("items", None)
    if isinstance(data, dict):
        if {"bounds", "zones"} & set(data):
            return ("layout", None)
        if {"workers", "equipment", "stations"} & set(data):
            return ("resources", None)
        if {"outbound", "inbound", "profile"} & set(data):
            return ("orders", None)
        if {"pick_strategy", "walk_speed_mps", "flow"} & set(data):
            return ("process", None)
        if {"duration_s", "random_seed"} & set(data):
            return ("simulation", None)
    return None


def _route(filename: str, data) -> tuple[str, str | None] | None:
    low = Path(filename).name.lower()
    for sub, target in FILENAME_HINTS:
        if sub in low:
            return target
    return _sniff_subtree(data)


def _deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _iter_json_files(zip_path: Path):
    with zipfile.ZipFile(zip_path) as zf:
        for name in zf.namelist():
            if name.endswith("/") or not name.lower().endswith(".json"):
                continue
            yield name, zf.read(name)


def merge_into_template(
    template_dict: dict, files: list[tuple[str, bytes]]
) -> ImportResult:
    """Merge dropped JSON files over a template dict, tolerantly."""
    merged = json.loads(json.dumps(template_dict))  # deep copy
    touched: set[str] = set()
    warnings: list[str] = []
    seen: list[str] = []

    for name, raw in files:
        seen.append(name)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            warnings.append(f"{name}: skipped (invalid JSON: {e})")
            continue

        route = _route(name, data)
        if route is None:
            warnings.append(f"{name}: skipped (could not match to any model part)")
            continue

        subtree, subkey = route
        if subkey is not None:
            merged.setdefault(subtree, {})[subkey] = data
        elif isinstance(data, dict) and isinstance(merged.get(subtree), dict):
            merged[subtree] = _deep_merge(merged[subtree], data)
        else:
            merged[subtree] = data
        touched.add(subtree)

    # The merge result must validate -- this is the "always runs" guarantee.
    model = WarehouseModel.model_validate(merged)
    return ImportResult(model=model, touched_subtrees=touched, warnings=warnings,
                        files_seen=seen)


def import_zip(template_dict: dict, zip_path: str | Path) -> ImportResult:
    files = list(_iter_json_files(Path(zip_path)))
    if not files:
        res = merge_into_template(template_dict, [])
        res.warnings.append("ZIP contained no .json files; kept template as-is.")
        return res
    return merge_into_template(template_dict, files)


def import_bytes(template_dict: dict, zip_bytes: bytes) -> ImportResult:
    files = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for name in zf.namelist():
            if name.endswith("/") or not name.lower().endswith(".json"):
                continue
            files.append((name, zf.read(name)))
    return merge_into_template(template_dict, files)
