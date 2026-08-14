"""DoD 1: the three outputs validate against schemas taken from the contract.

The validator itself is in-tree, so it is cross-checked here against the
reference `jsonschema` implementation when that happens to be importable (it is
never installed for log-forge's sake -- the test skips when it is absent).
"""

from __future__ import annotations

import json

import pytest

from lfcore import validate as V
from lfcore.convert import convert, convert_to_dir
from lfcore.jsonschema_lite import SchemaError, load_schema, validate


def test_outputs_validate_against_contract_schemas(sample_set, default_mapping, tmp_path):
    _, written = convert_to_dir(sample_set["xlsx"], default_mapping, tmp_path / "out")

    assert set(written) == {
        "orders.json", "events.jsonl", "calibration.json", "error_table.csv", "meta.json"
    }
    assert V.validate_dir(tmp_path / "out") == []


def test_events_are_monotonic_and_carry_only_restorable_types(sample_set, default_mapping):
    result = convert(sample_set["xlsx"], default_mapping)
    times = [event["t"] for event in result.events]
    types = {event["type"] for event in result.events}

    assert times == sorted(times), "contract §7: t must be non-decreasing within a file"
    assert types == {"task_assign", "pick_start", "pick_end"}
    assert result.meta["events"]["not_restorable"] == [
        "load", "move_end", "move_start", "unload", "wait_end", "wait_start"
    ]


def test_orders_shape_matches_contract(sample_set, default_mapping):
    result = convert(sample_set["xlsx"], default_mapping)
    assert result.orders, "sample must produce order lines"
    for order in result.orders[:50]:
        assert set(order) <= {"order_id", "loc_id", "qty", "ready_t"}
        assert {"order_id", "loc_id", "qty"} <= set(order)
    assert V.validate_orders(result.orders) == []


@pytest.mark.parametrize(
    "bad_event, expect",
    [
        ({"type": "pick_start"}, "missing required property 't'"),
        ({"t": 1.0}, "missing required property 'type'"),
        ({"t": -1.0, "type": "pick_start"}, "minimum"),
        ({"t": 1.0, "type": "picked"}, "matches none"),
        ({"t": 1.0, "type": "pick_start", "actor": "P01"}, "unexpected property"),
        ({"t": "1.0", "type": "pick_start"}, "expected type number"),
    ],
)
def test_broken_events_are_rejected(bad_event, expect):
    errors = validate(bad_event, V.schema_for("events.jsonl"), "e")
    assert errors, f"{bad_event} should not validate"
    assert any(expect in message for message in errors), errors


def test_extension_event_type_is_allowed_but_must_be_prefixed():
    schema = V.schema_for("events.jsonl")
    assert validate({"t": 1.0, "type": "x_scan"}, schema, "e") == []
    assert validate({"t": 1.0, "type": "scan"}, schema, "e") != []


def test_backwards_time_is_caught_by_the_contract_assertion():
    events = [{"t": 5.0, "type": "pick_start"}, {"t": 1.0, "type": "pick_end"}]
    assert any("backwards" in message for message in V.validate_events(events))


def test_wait_pairing_is_checked():
    unbalanced = [{"t": 1.0, "type": "wait_end", "actorId": "P01"}]
    assert any("wait_end without" in m for m in V.validate_events(unbalanced))
    unclosed = [{"t": 1.0, "type": "wait_start", "actorId": "P01"}]
    assert any("unclosed" in m for m in V.validate_events(unclosed))
    paired = [
        {"t": 1.0, "type": "wait_start", "actorId": "P01"},
        {"t": 2.0, "type": "wait_end", "actorId": "P01"},
    ]
    assert V.validate_events(paired) == []


def test_calibration_requires_provenance():
    schema = V.schema_for("calibration.json")
    complete = {
        "schema_version": "1.0",
        "pick_time_s": {"dist": "lognorm", "params": {"s": 0.4, "scale": 12.0},
                        "n": 100, "ks_p": 0.3},
        "source": "synthetic", "fitted_at": "2025-07-01 17:00:00",
    }
    assert validate(complete, schema, "c") == []

    for missing in ("n", "ks_p", "params", "dist"):
        broken = json.loads(json.dumps(complete))
        broken["pick_time_s"].pop(missing)
        assert validate(broken, schema, "c") != [], f"{missing} must be mandatory"

    wrong_dist = json.loads(json.dumps(complete))
    wrong_dist["pick_time_s"]["dist"] = "logNormal"
    assert validate(wrong_dist, schema, "c") != [], "dist names follow scipy.stats"


def test_validator_refuses_schemas_it_does_not_understand(tmp_path):
    path = tmp_path / "bad.schema.json"
    path.write_text(json.dumps({"type": "object", "dependencies": {}}), encoding="utf-8")
    with pytest.raises(SchemaError):
        load_schema(path)


def test_cross_checked_against_reference_jsonschema(sample_set, default_mapping, tmp_path):
    """If the reference implementation is available, it must agree with ours."""
    jsonschema = pytest.importorskip("jsonschema")
    _, written = convert_to_dir(sample_set["xlsx"], default_mapping, tmp_path / "out")

    orders = json.loads(written["orders.json"].read_text(encoding="utf-8"))
    calibration = json.loads(written["calibration.json"].read_text(encoding="utf-8"))
    meta = json.loads(written["meta.json"].read_text(encoding="utf-8"))
    events = [
        json.loads(line)
        for line in written["events.jsonl"].read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]

    jsonschema.validate(orders, V.schema_for("orders.json"))
    jsonschema.validate(calibration, V.schema_for("calibration.json"))
    jsonschema.validate(meta, V.schema_for("meta.json"))
    event_schema = V.schema_for("events.jsonl")
    for event in events[:200]:
        jsonschema.validate(event, event_schema)

    # ... and it must reject what ours rejects.
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"t": 1.0, "type": "picked"}, event_schema)
