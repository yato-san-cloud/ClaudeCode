"""段(level) からのピックは時間がかかる — the vertical access time model.

Picking an upper 段 costs lift/reach time on top of the unit handling, different
for a manual picker (reach/ladder), a forklift/order-picker (mast hoist), and an
AS/RS crane (fast automated). The engine adds it per pick visit, so a run with
SKUs on high levels takes longer (and the 2D/3D replay dwell at each high pick
lengthens). Level 1 (ground/golden) is free, so single-level models are
byte-identical to before.
"""
from whsim import racktypes
from whsim.schema.model import Item, Location, Order, OrderLine, WarehouseModel


def test_level_one_is_free_and_higher_costs_more():
    assert racktypes.vertical_pick_s("medium", 1) == 0.0
    s2 = racktypes.vertical_pick_s("medium", 2)
    s4 = racktypes.vertical_pick_s("medium", 4)
    assert 0 < s2 < s4   # monotonic in height


def test_forklift_costs_more_than_manual_for_same_height():
    # pallet (forklift hoist 1.5 m pitch) vs medium (manual reach 0.45 m pitch) —
    # both at 段4, the forklift's vertical access dominates.
    assert racktypes.vertical_pick_s("pallet", 4) > racktypes.vertical_pick_s("medium", 4)
    assert racktypes.mover("pallet") == "forklift"
    assert racktypes.mover("medium") == "manual"
    assert racktypes.mover("asrs") == "crane"


def test_params_scale_the_time():
    base = racktypes.vertical_pick_s("medium", 4, manual_s_per_m=2.0)
    more = racktypes.vertical_pick_s("medium", 4, manual_s_per_m=4.0)
    assert more > base
    # faster forklift hoist → less vertical time
    fast = racktypes.vertical_pick_s("pallet", 4, lift_mps=0.8)
    slow = racktypes.vertical_pick_s("pallet", 4, lift_mps=0.2)
    assert fast < slow


def _model(level, rack_type="pallet"):
    m = WarehouseModel()
    m.layout.bounds.width = 30
    m.layout.bounds.depth = 20
    m.simulation.duration_s = 7200
    m.simulation.replications = 1
    m.locations = [Location(id=f"L{i}", x=10 + i, y=5, type="shelf",
                            rack_type=rack_type, level=level, sku=f"S{i}", capacity=100)
                   for i in range(6)]
    m.items = [Item(sku=f"S{i}", name=f"S{i}", ts_per_unit=1.5, default_location=f"L{i}")
               for i in range(6)]
    m.orders.outbound = [Order(order_id=f"O{j}", arrival_s=j * 30.0,
                               lines=[OrderLine(sku=f"S{i}", qty=2) for i in range(6)])
                         for j in range(20)]
    return m


def _picker_busy(res):
    return sum(e.get("busy", 0.0) for e in res.events if e.get("resource") == "picker")


def test_engine_upper_levels_take_longer():
    from whsim.engine.run import run_once
    b1 = _picker_busy(run_once(_model(1)))
    b4 = _picker_busy(run_once(_model(4)))
    assert b4 > b1 * 1.3   # top-pallet forklift hoist materially increases pick busy


def test_engine_level_one_unchanged_vs_no_vertical():
    # With everything on 段1, vertical access is 0 → the per-visit handle is exactly
    # qty*ts, i.e. byte-identical to the pre-vertical engine.
    from whsim.engine.build import build
    m = _model(1)
    world = build(m)
    assert all(v == 0.0 for v in world.sku_vert.values())
