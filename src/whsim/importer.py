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


# Decoding fallbacks: UTF-8 first, then the encodings a Japanese customer's
# export is most likely to use (Shift-JIS / CP932), before giving up.
_DECODINGS: tuple[str, ...] = ("utf-8-sig", "utf-8", "cp932", "shift_jis")


def _decode(raw: bytes) -> str:
    """Decode dropped bytes tolerantly. Tries UTF-8 (with/without BOM) then the
    common Japanese codecs; raises UnicodeDecodeError only if all fail."""
    last: UnicodeDecodeError | None = None
    for enc in _DECODINGS:
        try:
            return raw.decode(enc)
        except UnicodeDecodeError as e:  # noqa: PERF203
            last = e
    assert last is not None
    raise last


# Zip-bomb / abuse safety caps. A customer bundle is a handful of small JSON
# exports, so these limits are generous but bound a hostile/corrupt archive.
MAX_ENTRIES = 10_000              # number of members we will look at
MAX_ENTRY_BYTES = 256 * 1024 * 1024   # per-entry uncompressed cap (256 MiB)
MAX_TOTAL_BYTES = 512 * 1024 * 1024   # whole-archive uncompressed cap (512 MiB)

# Maximum bracket-nesting depth we will accept in a member's JSON. CPython's
# ``json`` decoder recurses per nesting level, so a hostile member of the form
# ``[[[[...]]]]`` (tens of thousands deep) raises ``RecursionError`` -- which is
# NOT a ``JSONDecodeError`` and would otherwise escape the tolerant parse path
# and 500 the import endpoint (a cheap DoS: a few KB of bytes). We cheaply
# pre-scan the raw text and reject over-deep documents as "invalid JSON" before
# handing them to ``json.loads``. A genuine customer export nests only a few
# levels (orders -> lines), so this bound is generous.
MAX_JSON_DEPTH = 200


def _json_too_deep(text: str, limit: int = MAX_JSON_DEPTH) -> bool:
    """True if the JSON text nests brackets/braces deeper than ``limit``.

    A linear scan that ignores brackets inside string literals (so a ``"]"``
    in a value never inflates the count). Cheap relative to ``json.loads`` and
    runs first so a recursion bomb is rejected without ever recursing."""
    depth = 0
    in_str = False
    escape = False
    for ch in text:
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "[{":
            depth += 1
            if depth > limit:
                return True
        elif ch in "]}":
            if depth > 0:
                depth -= 1
    return False


def _is_unsafe_member(name: str) -> bool:
    """Reject path-traversal / absolute members so a malicious archive can never
    be made to escape an extraction root (defence-in-depth; we read into memory
    here, but callers may extract)."""
    if name.startswith("/") or name.startswith("\\"):
        return True
    # normalize separators and look for any parent-dir component
    parts = name.replace("\\", "/").split("/")
    if ".." in parts:
        return True
    # Windows drive-absolute (e.g. C:\...) or UNC
    if len(name) >= 2 and name[1] == ":":
        return True
    return False


def _read_zip_entries(
    zf: zipfile.ZipFile, warnings: list[str] | None = None
) -> list[tuple[str, bytes]]:
    """Read every .json entry from an open ZipFile, skipping unreadable ones.

    Tolerant + safe: caps the number of entries and the total/per-entry
    uncompressed size (zip-bomb guard), and skips path-traversal members."""
    warns = warnings if warnings is not None else []
    out: list[tuple[str, bytes]] = []
    total = 0
    for i, info in enumerate(zf.infolist()):
        if i >= MAX_ENTRIES:
            warns.append(
                f"ZIP内のエントリ数が上限({MAX_ENTRIES})を超えたため、以降を無視しました。"
            )
            break
        name = info.filename
        if name.endswith("/") or not name.lower().endswith(".json"):
            continue
        if _is_unsafe_member(name):
            warns.append(f"{name}: 安全でないパスのためスキップしました。")
            continue
        if info.file_size > MAX_ENTRY_BYTES:
            warns.append(
                f"{name}: 展開後サイズが大きすぎる({info.file_size}バイト)ためスキップしました。"
            )
            continue
        if total + info.file_size > MAX_TOTAL_BYTES:
            warns.append("ZIPの合計展開サイズが上限を超えたため、以降のファイルを無視しました。")
            break
        try:
            data = zf.read(name)
        except Exception:  # noqa: BLE001 - a corrupt member must not be fatal
            continue
        total += len(data)
        out.append((name, data))
    return out


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
            text = _decode(raw)
        except UnicodeDecodeError as e:
            warnings.append(f"{name}: skipped (invalid JSON: {e})")
            continue
        if _json_too_deep(text):
            # Reject a recursion-bomb member up front so json.loads never
            # recurses into a RecursionError (which would escape this tolerant
            # loop and 500 the import). Treat it like any other unparseable file.
            warnings.append(f"{name}: skipped (JSON nesting too deep)")
            continue
        try:
            data = json.loads(text)
        except (json.JSONDecodeError, RecursionError) as e:
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
    # Import-only hardening (the schema itself stays strict for the editor):
    #  * coerce_messy: clamp negative/zero/out-of-range numbers a customer file
    #    might carry, so the sim never divides-by-zero or silences demand;
    #  * normalize_ids: blank / duplicate ids would silently collide in
    #    downstream dict maps (lost zones / SKUs / orders) -- auto-assign stable
    #    unique ids instead of dropping data.
    # Both surface every change as a warning rather than mutating silently.
    warnings.extend(model.coerce_messy())
    warnings.extend(model.normalize_ids())
    return ImportResult(model=model, touched_subtrees=touched, warnings=warnings,
                        files_seen=seen)


def import_zip(template_dict: dict, zip_path: str | Path) -> ImportResult:
    zip_warnings: list[str] = []
    try:
        with zipfile.ZipFile(Path(zip_path)) as zf:
            files = _read_zip_entries(zf, zip_warnings)
    except zipfile.BadZipFile as e:
        # A corrupt / non-ZIP file must not be fatal: keep the template as-is.
        res = merge_into_template(template_dict, [])
        res.warnings.append(f"ZIPを開けませんでした ({e}); テンプレートをそのまま使用します。")
        return res
    if not files:
        res = merge_into_template(template_dict, [])
        res.warnings = zip_warnings + res.warnings
        res.warnings.append("ZIP contained no .json files; kept template as-is.")
        return res
    res = merge_into_template(template_dict, files)
    res.warnings = zip_warnings + res.warnings
    return res


def import_bytes(template_dict: dict, zip_bytes: bytes) -> ImportResult:
    zip_warnings: list[str] = []
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            files = _read_zip_entries(zf, zip_warnings)
    except zipfile.BadZipFile as e:
        res = merge_into_template(template_dict, [])
        res.warnings.append(f"ZIPを開けませんでした ({e}); テンプレートをそのまま使用します。")
        return res
    res = merge_into_template(template_dict, files)
    res.warnings = zip_warnings + res.warnings
    return res
