"""Round-5 template suite: every shipped template must be valid, runnable and
have a manifest whose headline_fields point at real model paths.

Parametrized over *every* id returned by ``templates.list_templates()`` so new
templates are covered automatically. Also pins the catalogue at >=5 templates.
"""

from __future__ import annotations

import math

import pytest

from whsim import templates
from whsim.engine.run import run_replications
from whsim.kpis import compute
from whsim.render.replay import build_replay
from whsim.schema.model import WarehouseModel

TEMPLATE_IDS = [t["template_id"] for t in templates.list_templates()]


def _resolve(obj, path: str):
    """Resolve a dotted/indexed headline path against a raw model dict.

    Lists are indexed by integer segments (e.g. ``resources.workers.0.count``).
    Raises (KeyError/IndexError/ValueError) if the path does not resolve, which
    is exactly the assertion we want.
    """
    cur = obj
    for part in path.split("."):
        if isinstance(cur, list):
            cur = cur[int(part)]
        else:
            cur = cur[part]
    return cur


def test_catalogue_has_at_least_five_templates():
    ids = [t["template_id"] for t in templates.list_templates()]
    assert len(ids) >= 5, f"expected >=5 templates, found {ids}"
    assert len(ids) == len(set(ids)), f"duplicate template ids: {ids}"


@pytest.mark.parametrize("template_id", TEMPLATE_IDS)
def test_manifest_is_well_formed(template_id):
    manifest = templates.load_manifest(template_id)
    assert manifest.get("name"), f"{template_id}: manifest name is empty"
    assert isinstance(manifest["name"], str)

    hf = manifest.get("headline_fields")
    assert hf, f"{template_id}: no headline_fields"
    assert 4 <= len(hf) <= 7, f"{template_id}: {len(hf)} headline_fields (want 4-7)"

    raw = templates.load_template_dict(template_id)
    for field in hf:
        assert "path" in field and "label" in field, f"{template_id}: {field}"
        # Path must resolve in the model (so the "キー項目" editor can read/write it).
        _resolve(raw, field["path"])
        if field.get("type") == "choice":
            assert field.get("choices"), f"{template_id}: choice without choices"


@pytest.mark.parametrize("template_id", TEMPLATE_IDS)
def test_model_validates(template_id):
    model = templates.load_template_model(template_id)
    assert isinstance(model, WarehouseModel)
    # Round-trips through validation cleanly.
    WarehouseModel.model_validate(model.model_dump())


@pytest.mark.parametrize("template_id", TEMPLATE_IDS)
def test_runnable_with_finite_kpis(template_id):
    model = templates.load_template_model(template_id)
    results, heat = run_replications(model, reps=1)
    assert results, f"{template_id}: no run results"

    kpis = compute(results, model)
    assert kpis["orders_completed"] >= 0
    for key in (
        "throughput_per_hr",
        "total_cost_per_order",
        "monthly_cost",
        "bottleneck_utilization",
        "completion_rate",
    ):
        assert math.isfinite(kpis[key]), f"{template_id}: {key} not finite"

    # Replay document builds for the first replication (the 2D/3D viewers' contract).
    replay = build_replay(model, results[0], kpis)
    assert replay.get("workers") is not None
