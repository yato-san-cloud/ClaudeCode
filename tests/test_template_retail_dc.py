"""The 'retail_dc' sample — an abstracted retail / convenience-store ambient DC
at proposal scale. (The generic round-5 suite already proves every template is
valid + runnable; this pins the retail_dc-specific intent: chain-DC scale, a
clean 工程↔エリア chain, and an authored grid that survives re-materialisation so
the case-pick count never jumps when the user first edits the layout.)
"""

from whsim import design, scorecard, templates


def _model():
    return templates.load_template_model("retail_dc")


def test_in_catalogue():
    ids = [t["template_id"] for t in templates.list_templates()]
    assert "retail_dc" in ids


def test_chain_dc_scale_and_shell():
    m = _model()
    # proposal scale: ~600 case-pick locations (same order as a real chain DC).
    assert 500 <= len(m.locations) <= 700
    assert len(m.items) == len(m.locations)
    # a real building: an envelope wall + dock doors, on a several-thousand-m² floor.
    assert m.layout.bounds.width * m.layout.bounds.depth >= 5000
    assert m.layout.walls and m.layout.doors
    types = {z.type for z in m.layout.zones}
    assert {"receiving", "storage", "packing", "shipping"} <= types


def test_authored_grid_survives_rematerialise():
    # The authored locations must equal the storage zone's rack fill, so editing
    # (which triggers materialize_racks) never jumps the count.
    m = _model()
    before = len(m.locations)
    design.materialize_racks(m)
    assert len(m.locations) == before


def test_scorecard_is_clean():
    # An abstracted sample should present cleanly: feasible verdict + a valid
    # 工程↔エリア chain (stages bound to this layout's zone ids).
    m = _model()
    rows = {r["id"]: r for r in scorecard.build_scorecard(m)["rows"]}
    assert rows["chain"]["tone"] == "ok", rows["chain"]
    assert rows["verdict"]["tone"] == "ok", rows["verdict"]


def test_demand_profile_is_retail_shaped():
    # 多頻度小口・方面別ウェーブ: wave picking, route batches, many case lines/order.
    m = _model()
    assert m.process.pick_strategy == "wave"
    assert m.process.batch_size > 1
    assert m.orders.profile.lines_per_order_mean >= 20
