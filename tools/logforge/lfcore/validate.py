"""Validate log-forge's own outputs against the schemas taken from the contract.

The schemas in ``tools/logforge/schema/`` are transcribed from
WHSIM_CONTRACTS.md v1.0; they are checked with the in-tree draft-07 subset
validator so the tool needs no extra dependency. On top of the per-file schemas
the shared assertions of contract §7 that apply to log-forge's outputs are
checked too: t is monotonically non-decreasing inside events.jsonl, and
wait_start / wait_end pair up per actor.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .jsonschema_lite import load_schema, validate

SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schema"

_SCHEMA_FILES = {
    "orders.json": "orders.schema.json",
    "events.jsonl": "event.schema.json",
    "calibration.json": "calibration.schema.json",
    "meta.json": "meta.schema.json",
}


def schema_for(filename: str) -> dict[str, Any]:
    return load_schema(SCHEMA_DIR / _SCHEMA_FILES[filename])


def validate_orders(orders: list) -> list[str]:
    return validate(orders, schema_for("orders.json"), "orders")


def validate_events(events: list[dict]) -> list[str]:
    schema = schema_for("events.jsonl")
    errors: list[str] = []
    previous_t: float | None = None
    open_waits: dict[str, int] = {}
    for index, event in enumerate(events):
        errors.extend(validate(event, schema, f"events[{index}]"))
        t = event.get("t")
        if isinstance(t, (int, float)):
            if previous_t is not None and t < previous_t:
                errors.append(f"events[{index}]: t went backwards ({previous_t} -> {t})")
            previous_t = t
        actor = event.get("actorId", "")
        if event.get("type") == "wait_start":
            open_waits[actor] = open_waits.get(actor, 0) + 1
        elif event.get("type") == "wait_end":
            if open_waits.get(actor, 0) <= 0:
                errors.append(f"events[{index}]: wait_end without a matching wait_start")
            else:
                open_waits[actor] -= 1
    for actor, count in sorted(open_waits.items()):
        if count:
            errors.append(f"events: {count} unclosed wait_start for actor {actor!r}")
    return errors


def validate_calibration(calibration: dict) -> list[str]:
    return validate(calibration, schema_for("calibration.json"), "calibration")


def validate_meta(meta: dict) -> list[str]:
    return validate(meta, schema_for("meta.json"), "meta")


def validate_result(orders: list, events: list[dict], calibration: dict, meta: dict) -> list[str]:
    return (
        validate_orders(orders)
        + validate_events(events)
        + validate_calibration(calibration)
        + validate_meta(meta)
    )


def validate_dir(outdir: str | Path) -> list[str]:
    """Validate an output directory on disk (what a downstream tool would read)."""
    outdir = Path(outdir)
    errors: list[str] = []
    orders_path = outdir / "orders.json"
    events_path = outdir / "events.jsonl"
    calibration_path = outdir / "calibration.json"
    meta_path = outdir / "meta.json"

    for path in (orders_path, events_path, calibration_path, meta_path):
        if not path.exists():
            errors.append(f"{path.name}: missing")
    if errors:
        return errors

    orders = json.loads(orders_path.read_text(encoding="utf-8"))
    events = []
    for lineno, line in enumerate(events_path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as exc:
            errors.append(f"events.jsonl:{lineno}: not valid JSON ({exc})")
    calibration = json.loads(calibration_path.read_text(encoding="utf-8"))
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    return errors + validate_result(orders, events, calibration, meta)
