"""Round-5 template suite: every shipped template must be valid, runnable and
have a manifest whose headline_fields point at real model paths.

Parametrized over *every* id returned by ``templates.list_templates()`` so new
templates are covered automatically. Also pins the catalogue at >=5 templates.

Three legs guard a template, and a new one has to pass all three:

* it **loads** — ``test_model_validates`` (and the manifest resolves against it),
* its **floor is walkable** — ``test_layout_audit_is_clean``: レイアウト診断 finds
  no unreachable rack and exactly one connected floor, so the drawn map is one a
  picker could really work,
* it **runs** — ``test_short_run_is_clean`` (a fast smoke) and
  ``test_runnable_with_finite_kpis`` (the full shipped duration + replay).
"""

from __future__ import annotations

import math

import pytest

from whsim import layoutaudit, templates
from whsim.engine.graph import AisleGraph
from whsim.engine.run import run_once, run_replications
from whsim.kpis import compute
from whsim.rackgeom import rack_rects
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
def test_layout_audit_is_clean(template_id):
    """レイアウト診断 must be quiet on every shipped template.

    A template is the salesperson's starting point, so it may never ship a floor
    the engine itself could not route: no rack without a reachable pick face, and
    no isolated pocket (a bank of racking that seals an aisle, a room with no
    door). Same geometry the DES routes on — ``rackgeom.rack_rects`` — so a
    failure here is a genuine defect in the template's data, not a rendering
    artefact.
    """
    model = templates.load_template_model(template_id)
    walls = [{"points": [list(p) for p in w.points]} for w in model.layout.walls]
    audit = layoutaudit.audit(
        model.layout.bounds.width, model.layout.bounds.depth,
        AisleGraph._segments_from_walls(walls), rack_rects(model),
    )
    summary = audit["summary"]
    assert summary["unreachable_n"] == 0, (
        f"{template_id}: {summary['unreachable_n']} unreachable rack(s) — "
        f"first at {audit['unreachable'][:1]}")
    # A bare template (no racking at all) has nothing to partition: it reports 0
    # pockets. Anything with a floor must report exactly ONE walkable component.
    assert summary["components"] <= 1, (
        f"{template_id}: floor split into {summary['components']} pockets — "
        f"{[p['point'] for p in audit['components']]}")
    if summary["racks_n"]:
        assert summary["components"] == 1, f"{template_id}: no walkable floor found"
    assert summary["narrow_person_n"] == 0, (
        f"{template_id}: aisle too narrow to walk — {audit['narrow'][:1]}")


@pytest.mark.parametrize("template_id", TEMPLATE_IDS)
def test_short_run_is_clean(template_id):
    """A 30-minute simulation of every template completes and moves real work.

    The fast leg of the guard: it fails loudly on a template whose data cannot be
    simulated at all (no slotted SKU, a stage bound to a missing zone, resources
    that resolve to zero agents), without paying for the full shipped duration.

    A template that ships DEMAND and RACKING must also actually ship orders —
    "runs without raising" is too weak a bar for a proposal starting point. The
    deliberately empty ``blank`` template (no locations, 0 orders/hr) is exempt by
    its own data, not by an id whitelist.
    """
    model = templates.load_template_model(template_id)
    model.simulation.duration_s = 1800.0
    res = run_once(model)
    kpis = compute([res], model)
    assert math.isfinite(kpis["throughput_per_hr"])
    assert 0.0 <= kpis["picker_utilization"] <= 1.0

    has_work = bool(model.locations) and (
        model.orders.outbound or model.orders.profile.rate_per_hr > 0)
    if has_work:
        assert kpis["orders_completed"] > 0, f"{template_id}: nothing shipped in 30 min"
    else:
        assert kpis["orders_completed"] == 0


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
