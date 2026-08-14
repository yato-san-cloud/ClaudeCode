"""受け入れ監査で出た3つの穴の回帰: 縮退移動のKPI化・全repログ保存・AGVの方式追従。

監査の指摘: (1) 経路グラフが解けず直線に縮退した移動 (`unroutable_count`) を実行時に
誰も読んでいない、(2) kpis.json はNレプリケーションの平均なのに保存されるログは
rep0 だけで再導出できない、(3) AGV のディスパッチ/ルーティングは常に FIFO+NN で
`routing_policy` が届かない。それぞれの修正をここで固定する。
"""
from __future__ import annotations

import json

from whsim import eventlog, kpis as kpi_mod, templates
from whsim.engine.run import run_replications


def _short(template: str = "ecommerce_small"):
    m = templates.load_template_model(template)
    m.simulation.duration_s = 900.0
    m.simulation.replications = 1
    return m


# ------------------------------------------------- (1) unroutable → KPI/判定


def test_unroutable_legs_is_a_kpi_and_zero_on_healthy_layouts():
    results, _ = run_replications(_short())
    k = kpi_mod.compute(results, templates.load_template_model("ecommerce_small"))
    assert k["unroutable_legs"] == 0
    assert "縮退" not in k["verdict"]


def test_unroutable_legs_reaches_the_verdict_when_nonzero():
    """縮退が起きた run は判定文で警告される（黙って直線を歩かない）。"""
    results, _ = run_replications(_short())
    results[0].unroutable_legs = 7
    k = kpi_mod.compute(results, templates.load_template_model("ecommerce_small"))
    assert k["unroutable_legs"] == 7
    assert "直線距離に縮退した移動" in k["verdict"]


# ----------------------------------------------------- (2) 全repログの保存


def test_dump_all_writes_every_replication(tmp_path):
    m = _short()
    m.simulation.replications = 3
    results, _ = run_replications(m)
    n = eventlog.dump_all(results, tmp_path)
    assert n == 3
    # rep0 のファイル名は従来どおり（既存の読み手・エンドポイントを壊さない）
    assert (tmp_path / eventlog.EVENTS_JSONL).is_file()
    assert (tmp_path / "events_rep01.jsonl").is_file()
    assert (tmp_path / "events_rep02.jsonl").is_file()
    # 各ファイルはそのrepのログと逐語一致 → 出荷KPI(平均)が出荷ログから再導出できる
    for i, res in enumerate(results):
        name = eventlog.EVENTS_JSONL if i == 0 else f"events_rep{i:02d}.jsonl"
        lines = (tmp_path / name).read_text("utf-8").splitlines()
        assert [json.loads(x) for x in lines] == res.events


# ------------------------------------------- (3) AGV が routing_policy に従う


def _agv_model(policy: str | None):
    m = _short()
    pick_idx = next(i for i, s in enumerate(m.process.stages) if s.id == "pick")
    m.process.stages[pick_idx].method = "agv"
    m.resources.equipment = [type(m.resources.equipment[0])(
        id="agv1", type="agv", count=2, speed_mps=1.6, x=5.0, y=15.0)] \
        if m.resources.equipment else m.resources.equipment
    if not m.resources.equipment:
        from whsim.schema.model import Equipment
        m.resources.equipment = [Equipment(id="agv1", type="agv", count=2,
                                           speed_mps=1.6, x=5.0, y=15.0)]
    if policy:
        m.process.routing_policy = policy
    return m


def test_agv_follows_the_routing_policy(monkeypatch):
    """policy 指定時は AGV のツアーも pickroute を通り、未指定は従来の NN のまま。"""
    from whsim.engine import pickroute

    calls: list[str] = []
    orig = pickroute.route_order

    def spy(policy, start, pts):
        calls.append(policy)
        return orig(policy, start, pts)

    monkeypatch.setattr(pickroute, "route_order", spy)

    run_replications(_agv_model(None))
    assert calls == [], "既定(nearest)の AGV が pickroute を呼んではいけない"

    run_replications(_agv_model("s_shape"))
    assert calls and all(c == "s_shape" for c in calls), \
        "routing_policy=s_shape が AGV のツアーに届いていない"
