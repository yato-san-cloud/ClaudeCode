"""物理ストッパー・時間分離リリース・完成品staging — ライン運用の追加3機構。

`test_line_mechanics.py` の3機構は「1本のベルトを2種類の荷が流れる」前提で書かれて
いた。実際の出荷ラインはそうではなく、**停止線は選り分けない**: ぶつかった荷は全部
止まり、後続がその上流に溜まる。選り分けているのは時間で、完成品は台の脇に溜めて
おいて周期的にまとめて流す。3つの機構はそれぞれ、その前提が無いと測れないものを測る:

* **物理ストッパー** — 末端の列は死荷物ではなく**取り置きバッファ**。列の尻が自分の
  合流点まで戻ってきた引き込みの作業者は、止まっている荷を引ける（専任の番人は
  置かない）。これが無いと、末端に人が居ないラインは全部「止まる」としか読めない。
* **時間分離リリース (mode_B)** — 開放中は本線が完成品に占有され、検品済みの投入が
  止まる。**その能力損失こそがリリース周期の判断材料**で、周期を伸ばせば滞留が
  増え、縮めれば干渉が増える。
* **完成品staging** — 台脇の置き場が満杯なら梱包者が止まる。その背圧だけが
  「置き場を何台分取るか」を決める。ピークは提案にそのまま乗る数字。

全部 opt-in・既定オフで、同梱カタログのバイト同一は
`test_line_mechanics.py::test_the_default_engine_is_byte_identical_on_the_shipped_line`
が（このファイルを1行も変えずに）固定し続ける。数字は全て合成フィクスチャ。
"""

from __future__ import annotations

import math

import pytest
from test_line_mechanics import (  # the line fixtures live next door
    INSPECT,
    PACK,
    PICK,
    SHIP,
    _edge,
    _model,
)

from whsim import analytic, kpis, templates
from whsim.engine.build import build
from whsim.engine.run import run_once
from whsim.schema.model import Conveyor, Order, OrderLine, Station

SEED = 4


# --------------------------------------------------------------- the fixture
# 検品ライン E → 本線 T（末端に物理ストッパー）→ カーブ C。T の途中で引き込み S が
# 分岐し、その先に梱包台が1台。合流点の arc を動かせるので「列がどこまで戻ったら
# 手が届くか」を作り分けられる。


def _line(*, gate=None, junction_x=28.0, benches=1, stop_benches=0,
          release=None, staging=None, pull=True, pitch=1.0, rate=240.0,
          pack_time=90.0, duration=3600.0, orders=None, gate_arc=30.0,
          n_spurs=1):
    e = Conveyor(id="E", points=[[5.0, 4.0], [5.0, 12.0]], speed_mps=1.0,
                 load_kind="inspected", tote_pitch_m=pitch)
    t = Conveyor(id="T", points=[[0.0, 12.0], [40.0, 12.0]], speed_mps=1.0,
                 tote_pitch_m=pitch,
                 stop_gate=({"at_m": gate_arc, **gate} if gate else None))
    c = Conveyor(id="C", points=[[40.0, 12.0], [48.0, 12.0]], speed_mps=1.0,
                 tote_pitch_m=pitch)
    belts, edges, stations = [e, t, c], [_edge(PICK, INSPECT, "E")], []
    for i in range(n_spurs):
        x = junction_x - 4.0 * i
        sid = f"S{i + 1}"
        belts.append(Conveyor(id=sid, points=[[x, 12.0], [x, 16.0]],
                              speed_mps=0.5, tote_pitch_m=pitch))
        edges.append(_edge(INSPECT, PACK, sid))
        if benches:
            stations.append(Station(id=f"b{i + 1}", x=x, y=17.0, count=benches))
    edges += [_edge(PACK, SHIP, "T"), _edge(PACK, SHIP, "C")]
    if stop_benches:
        stations.append(Station(id="atgate", x=gate_arc, y=14.0, count=stop_benches))
    m = _model(belts, edges, pick_xy=[(3.0, 2.0), (7.0, 2.0)], pickers=4,
               rate=rate, pack_time=pack_time,
               stations=stations or [Station(id="pack", x=55.0, y=10.0, count=1)],
               duration=duration)
    m.process.divert_policy = "pull" if pull else "auto"
    if release is not None:
        m.process.release_schedule = release
    if staging is not None:
        m.process.bench_staging = staging
    if orders is not None:
        m.orders.outbound = [
            Order(order_id=f"O{i:03d}", arrival_s=float(a),
                  lines=[OrderLine(sku="S0", qty=1)])
            for i, a in enumerate(orders)]
    return m


def _events(res, name):
    return [e for e in res.events if e["event"] == name]


_ALL = {"mode": "all"}
_RELEASE = {"period_s": 900.0, "window_s": 180.0, "stack_rate_per_hr": 280.0,
            "load_kind": "packed"}


# ==================================================== 機構1: 物理ストッパー


def test_a_physical_stopper_stops_every_kind_a_select_gate_would_let_pass():
    """選択性なし: 種別に関わらず全部ぶつかって止まる。

    選択停止ゲートは「名指した種別だけ」止める。同じ位置・同じ図面で ``mode: "all"``
    にすると、通していた側も止まる — これが契約 §stopper.selectivity の全部。
    """
    sel = build(_line(gate={"pass_states": ["inspected"]}))
    phys = build(_line(gate=_ALL))
    sgate = next(c.gate for c in sel.conveyors if c.id == "T")
    pgate = next(c.gate for c in phys.conveyors if c.id == "T")
    assert sgate.stops("inspected") is False and sgate.stops("packed") is True
    assert pgate.stops("inspected") is True and pgate.stops("packed") is True
    assert pgate.stop_all is True and pgate.stop_kinds == frozenset()
    # 選択停止のままなら列は作らない = 従来のコード経路 (バイト同一の側)
    assert all(c.stopper is None for c in sel.conveyors)
    assert [c.id for c in phys.stoppers] == ["T"]


def test_the_queue_grows_backward_one_load_per_pitch_and_that_sets_who_can_reach_it():
    """列は1個/ピッチずつ上流へ伸び、届く範囲はその位置で決まる（純関数）。

    `reach_index` は「合流点に一番近い、まだ通り過ぎられていない荷」を返す。列が
    自分のところまで戻っていなければ ``None`` — 本線を歩いて拾いには行かない。
    """
    world = build(_line(gate=_ALL, junction_x=28.0))
    stp = next(c.stopper for c in world.conveyors if c.id == "T")
    stp.queue = [object()] * 5                       # 30, 29, 28, 27, 26 m
    assert [round(stp.arc_of(i), 3) for i in range(5)] == [30.0, 29.0, 28.0, 27.0, 26.0]
    assert stp.reach_index(28.0) == 2                # 合流点に立つ荷
    assert stp.reach_index(26.5) == 4                # もっと上流の合流点
    assert stp.reach_index(31.0) == 0                # ゲートの下流に立つ人は先頭
    stp.queue = [object()]
    assert stp.reach_index(28.0) is None             # まだ届いていない


# 12件を2秒おきに投入し、梱包を1台・300秒にすると、1件だけが流れながら引き込まれて
# 残り8件が列を作る（残りはまだラインの手前）。列の最大は8個 = 合流点が停止線から
# 8ピッチ以内なら手が届き、それより上流なら永久に届かない — 決定論的な閾値。
_TWELVE = [i * 2.0 for i in range(12)]


def test_a_worker_pulls_a_stationary_load_once_the_queue_reaches_their_junction():
    """滞留した検品済みは近傍の作業者が引き込む（契約 §stopper.recovery）。

    合流点が停止線の近く（列がすぐ届く）なら引き戻しが起き、遠ければ起きない。
    同じ需要・同じ人員なので、差は**列が誰に届いたか**だけ。
    """
    near = run_once(_line(gate=_ALL, junction_x=29.0, orders=_TWELVE,
                          pack_time=300.0, duration=1800.0), seed=SEED)
    far = run_once(_line(gate=_ALL, junction_x=10.0, orders=_TWELVE,
                         pack_time=300.0, duration=1800.0), seed=SEED)
    assert len(_events(near, "stopper_pull")) > 0
    assert len(_events(far, "stopper_pull")) == 0
    assert len(_events(near, "stopper_hold")) == len(_events(far, "stopper_hold"))
    # 引き戻せた分だけラインは流れる (引き戻しは throughput そのもの)
    assert len(_events(near, "order_complete")) > len(_events(far, "order_complete"))


def test_a_pull_only_happens_once_the_queue_is_long_enough_to_stand_at_the_junction():
    """届く条件は「列の尻が合流点まで戻っている」— 本線を歩いて拾いには行かない。

    停止線 30m・合流点 29m・ピッチ1m なら、列が2個以上あるときだけ手が届く。
    ログの ``queue`` は抜いた**後**の長さなので、+1 が抜く直前の長さ。
    """
    res = run_once(_line(gate=_ALL, junction_x=29.0, orders=_TWELVE,
                         pack_time=300.0, duration=1800.0), seed=SEED)
    pulls = _events(res, "stopper_pull")
    assert pulls
    need = math.ceil((30.0 - 29.0) / 1.0) + 1
    for e in pulls:
        assert e["queue"] + 1 >= need, e


def test_a_stopper_the_drawing_says_is_unpullable_takes_nothing_back():
    """``pullable: false`` = 手の届かないストッパー。列は育つだけ。

    既定は ``mode`` に従う（物理ストッパーの列は働く場所、選択停止の列は違う）ので、
    明示的に否定したときだけこの読みになる。
    """
    on = run_once(_line(gate=_ALL, junction_x=29.0, orders=_TWELVE,
                        pack_time=300.0, duration=1800.0), seed=SEED)
    off = run_once(_line(gate={"mode": "all", "pullable": False}, junction_x=29.0,
                         orders=_TWELVE, pack_time=300.0, duration=1800.0), seed=SEED)
    assert len(_events(on, "stopper_pull")) > 0
    assert len(_events(off, "stopper_pull")) == 0


def test_the_people_standing_at_the_stop_line_still_take_loads_off_it():
    """停止線に梱包台が描かれていれば、その人も列から取る（専任は前提にしないが、
    描かれていれば居る）。誰も描かれていなければ ``stopper_take`` は1件も出ない。"""
    manned = run_once(_line(gate=_ALL, junction_x=6.0, stop_benches=2), seed=SEED)
    bare = run_once(_line(gate=_ALL, junction_x=6.0), seed=SEED)
    assert len(_events(manned, "stopper_take")) > 0
    assert len(_events(bare, "stopper_take")) == 0


def test_a_stopper_nobody_can_reach_and_nobody_releases_says_so_instead_of_hanging():
    """出口の無いストッパー = 線は本当に止まる。人を発明せず、**そう言う**。

    `pack_unmanned` と同じ扱い: 走り切る（ハングしない）が、判定文が原因と直し方を
    名指しする。
    """
    res = run_once(_line(gate=_ALL, junction_x=10.0, orders=_TWELVE,
                         pack_time=300.0, duration=1800.0), seed=SEED)
    k = kpis.compute([res], None)
    assert k["stopper_stops"] > 0
    assert k["stopper_pulls"] == 0 and k["stopper_windows"] == 0
    assert k["stopper_queue_peak"] > 0
    assert "滞留を取る手段が図面にありません" in k["verdict"]


def test_a_queued_load_holds_its_trunk_slot_so_the_jam_walks_back_upstream():
    """止まった荷は本線のスロットを持ったまま = 滞留は上流へ伝わる（バッファの実体）。"""
    res = run_once(_line(gate=_ALL, junction_x=6.0, rate=480.0), seed=SEED)
    k = kpis.compute([res], None)
    trunk = k["conveyors"]["T"]
    assert trunk["peak_occupancy"] >= k["stopper_queue_peak"] > 1
    # 本線が埋まれば上流の受け渡しが待たされる (背圧が検品ラインへ)
    assert k["conveyors"]["E"]["blocked"] > 0


# ============================================== 機構2: 時間分離リリース (mode_B)


def test_mode_b_opens_the_stopper_drains_the_staging_and_lets_the_queue_through():
    res = run_once(_line(gate=_ALL, junction_x=28.0, release=_RELEASE,
                         staging={"capacity": 6}), seed=SEED)
    opens = _events(res, "stopper_open")
    closes = _events(res, "stopper_close")
    assert len(opens) == len(closes) >= 3
    assert _events(res, "release_board"), "台の完成品が本線へ載っていない"
    assert _events(res, "stopper_release"), "列の荷が開放で流れていない"
    # 開いた分だけ閉じる & 窓は周期を超えない
    for o, c in zip(opens, closes):
        assert 0.0 < c["t"] - o["t"] <= _RELEASE["period_s"] + 1e-9
    # 積み付けはカーブの先の工程で、完成品も未梱包の流出も同じ口を通る
    assert len(_events(res, "stack_done")) == \
        len(_events(res, "release_board")) + len(_events(res, "stopper_leak"))


def test_the_release_holds_mode_as_induction_and_that_is_the_interference_cost():
    """開放中に検品済みは本線へ入らない — 混流させないとはそういうこと。

    止めた秒数は KPI として出る。これがリリース周期の判断材料そのもの。
    """
    res = run_once(_line(gate=_ALL, junction_x=28.0, release=_RELEASE,
                         staging={"capacity": 6}), seed=SEED)
    k = kpis.compute([res], None)
    assert k["stopper_induction_holds"] > 0
    assert k["stopper_induction_hold_s"] > 0.0
    assert 0.0 < k["stopper_open_share"] < 1.0
    windows = [(o["t"], c["t"]) for o, c in zip(_events(res, "stopper_open"),
                                                _events(res, "stopper_close"))]
    boards = {(e["t"], e["order_id"]) for e in _events(res, "release_board")}
    for e in res.events:
        if e["event"] != "conveyor_on" or e.get("conveyor") != "T":
            continue
        if (e["t"], e["order_id"]) in boards:
            continue                       # 完成品を載せたのは窓の中で正しい
        # 端点は窓の内側ではない: 開いた瞬間に「もう乗っていた」荷と、閉じた瞬間に
        # 待ちが解けて乗る荷は、どちらも時間分離を破っていない。
        assert not any(a < e["t"] < b for a, b in windows), \
            "開放中に検品済みが本線へ入っている"


def test_a_longer_release_period_needs_more_room_beside_the_benches():
    """周期を伸ばすほど台の脇に完成品が積み上がる — 顧客の問い（周期別の必要容量）
    そのもの。置き場を実質無制限にして「本当は何個要るのか」を測る。"""
    peaks = {}
    for period in (600.0, 1200.0, 1800.0):
        m = _line(gate=_ALL, junction_x=28.0, rate=120.0, pack_time=60.0,
                  release={**_RELEASE, "period_s": period},
                  staging={"capacity": 500}, duration=7200.0)
        peaks[period] = kpis.compute([run_once(m, seed=SEED)], None)
    assert (peaks[600.0]["bench_staging_peak"]
            < peaks[1200.0]["bench_staging_peak"]
            < peaks[1800.0]["bench_staging_peak"])
    assert (peaks[600.0]["stopper_windows"]
            > peaks[1200.0]["stopper_windows"]
            > peaks[1800.0]["stopper_windows"])
    assert peaks[600.0]["bench_staging_blocks"] == 0     # 実質無制限＝天井ではない


def test_a_window_that_drains_until_empty_still_closes():
    """``window_s`` 未指定 = 出し切るまで。ただし次の周期に重ならない（never-blocks）。"""
    plan = {"period_s": 600.0, "stack_rate_per_hr": 120.0, "load_kind": "packed"}
    res = run_once(_line(gate=_ALL, junction_x=28.0, release=plan,
                         staging={"capacity": 4}), seed=SEED)
    opens, closes = _events(res, "stopper_open"), _events(res, "stopper_close")
    assert len(closes) == len(opens) >= 3
    for o, c in zip(opens, closes):
        assert 0.0 <= c["t"] - o["t"] <= plan["period_s"] + 1e-9


def test_a_load_released_without_being_packed_is_not_sold_as_a_completed_order():
    """開放は前に居るものを全部流す — まだ梱包していない検品済みも含めて。

    それを完了に数えると未梱包の出荷を成果として売ることになるので数えない。件数は
    `stopper_leaks` に残り、判定文が周期と人員のどちらかを直せと言う。
    """
    res = run_once(_line(gate=_ALL, junction_x=6.0, release=_RELEASE,
                         staging={"capacity": 6}), seed=SEED)
    k = kpis.compute([res], None)
    leaked = {e["order_id"] for e in _events(res, "stopper_leak")}
    done = {e["order_id"] for e in _events(res, "order_complete")}
    assert leaked and not (leaked & done)
    assert k["stopper_leaks"] == len(leaked)
    assert "未梱包のまま流れ出た荷" in k["verdict"]


# ============================================== 機構3: 完成品staging


def test_a_full_staging_blocks_the_packer_and_that_back_pressure_is_the_point():
    tight = kpis.compute([run_once(_line(gate=_ALL, junction_x=28.0,
                                         release=_RELEASE, staging={"capacity": 1}),
                                   seed=SEED)], None)
    roomy = kpis.compute([run_once(_line(gate=_ALL, junction_x=28.0,
                                         release=_RELEASE, staging={"capacity": 200}),
                                   seed=SEED)], None)
    assert tight["bench_staging_blocks"] > 0
    assert tight["bench_staging_block_s"] > 0.0
    assert roomy["bench_staging_blocks"] == 0
    # 詰まった置き場は梱包を止める = throughput が落ちる
    assert tight["orders_completed"] < roomy["orders_completed"]


def test_the_staging_peak_is_reported_per_bench_and_in_total():
    res = run_once(_line(gate=_ALL, junction_x=28.0, n_spurs=2,
                         release=_RELEASE, staging={"capacity": 6}), seed=SEED)
    k = kpis.compute([res], None)
    per = {b: v["staging_peak"] for b, v in k["conveyors"].items()}
    assert per["S1"] > 0 and per["S2"] > 0
    assert per["E"] == 0 and per["T"] == 0        # 通過するだけの帯に置き場は無い
    assert k["bench_staging_peak"] >= max(per.values())
    assert k["bench_staging_peak"] <= sum(per.values())
    assert k["bench_staging_capacity"] == 6 * 3   # S1/S2/C の台数分


def test_staging_with_no_way_to_release_it_is_not_wired_at_all():
    """出口の無いバッファはバッファではなく壁 — 張らないのが never-blocks の答え。"""
    world = build(_line(gate=_ALL, junction_x=28.0, staging={"capacity": 4}))
    assert world.bench_staging is None
    assert build(_line(gate=_ALL, junction_x=28.0, release=_RELEASE,
                       staging={"capacity": 4})).bench_staging is not None


# ============================================== KPI: ピークは平均してはいけない


def test_the_peaks_aggregate_across_replications_as_the_maximum():
    """レンタル数量・置き場面積の根拠になる数字は**最大**で集約する。

    平均すると「どの回でも観測されなかった小さい値」を売ることになる。「いつ」は
    その最大を出した回から採る（時刻の平均はどの run でも何も起きていない瞬間）。
    """
    m = _line(gate=_ALL, junction_x=28.0, release=_RELEASE, staging={"capacity": 6})
    reps = [run_once(m, seed=s) for s in (1, 2, 3, 4)]
    each = [kpis.compute([r], None) for r in reps]
    agg = kpis.compute(reps, None)
    for key in ("bench_staging_peak", "stopper_queue_peak",
                "stopper_trunk_occupancy_peak"):
        vals = [k[key] for k in each]
        assert agg[key] == max(vals), key
        assert agg[key] > statistics_fmean(vals) - 1e-9
        assert agg["spread"][key]["how"] == "max"
    # 「いつ」はその回のもの
    top = max(range(len(each)), key=lambda i: each[i]["bench_staging_peak"])
    assert agg["bench_staging_peak_t"] == each[top]["bench_staging_peak_t"]
    assert agg["spread"]["bench_staging_peak"]["replication"] == top + 1


def statistics_fmean(xs):
    return sum(xs) / len(xs)


def test_a_per_belt_staging_peak_is_a_maximum_too():
    m = _line(gate=_ALL, junction_x=28.0, n_spurs=2, release=_RELEASE,
              staging={"capacity": 6})
    reps = [run_once(m, seed=s) for s in (1, 2, 3)]
    each = [kpis.compute([r], None)["conveyors"]["S1"]["staging_peak"] for r in reps]
    assert kpis.compute(reps, None)["conveyors"]["S1"]["staging_peak"] == max(each)


# ============================================== never-blocks: 壊れた記述


@pytest.mark.parametrize("gate", [
    {"mode": "ALL"},                       # 大文字でも物理ストッパー
    {"mode": " all "},                     # 空白つき
])
def test_a_mode_written_loosely_still_reads_as_a_physical_stopper(gate):
    world = build(_line(gate=gate, junction_x=28.0))
    assert next(c.gate for c in world.conveyors if c.id == "T").stop_all is True


@pytest.mark.parametrize("gate", [
    {"mode": "everything"},                # 知らない語 ⇒ 従来の選択停止
    {"mode": None},
    {"mode": 7},
])
def test_a_mistyped_mode_falls_back_to_the_historical_gate_not_to_double_capacity(gate):
    """知らない ``mode`` を「全部止める」と読むと、黙ってラインの持ち高が倍になる。
    分からない語は**従来どおり**に読む（そして名前を1つも書いていなければゲート自体
    が無い）。"""
    world = build(_line(gate=gate, junction_x=28.0))
    assert all(c.gate is None for c in world.conveyors)
    assert world.stoppers == []


@pytest.mark.parametrize("plan", [
    {"period_s": 0.0}, {"period_s": -5.0}, {"period_s": "毎時"}, {}, None, 42,
])
def test_a_release_schedule_that_never_fires_is_not_a_schedule(plan):
    m = _line(gate=_ALL, junction_x=28.0, staging={"capacity": 4})
    m.process.release_schedule = plan
    world = build(m)
    assert world.release_schedule is None
    assert world.bench_staging is None
    res = run_once(m, seed=SEED)
    assert _events(res, "stopper_open") == []


@pytest.mark.parametrize("spec", [{"capacity": 0}, {"capacity": -3}, {}, None, "12"])
def test_a_staging_of_nothing_is_not_a_buffer(spec):
    m = _line(gate=_ALL, junction_x=28.0, release=_RELEASE)
    m.process.bench_staging = spec
    world = build(m)
    assert world.bench_staging is None
    res = run_once(m, seed=SEED)          # まだ走る: 列も開放も生きている
    assert _events(res, "stopper_open")


def test_a_release_with_no_stack_rate_is_not_a_constraint():
    m = _line(gate=_ALL, junction_x=28.0, staging={"capacity": 6},
              release={"period_s": 900.0, "window_s": 180.0})
    world = build(m)
    assert world.stack_crew is None and world.stack_time_s == 0.0
    k = kpis.compute([run_once(m, seed=SEED)], None)
    assert k["stack_loads"] > 0 and k["stack_utilization"] == 0.0


# ============================================== デッドロックしないこと


def test_the_line_keeps_moving_under_the_worst_combination():
    """止まった荷が本線のスロットを持つ設計で唯一怖いのは「引けない荷で埋まる」形。

    背圧が全部そろう最悪の組み合わせ（過負荷 + 置き場1個 + 短い周期 + pull）で、
    ラインが最後まで動き続けること・最後の窓のあとに列が確実に減ることを確かめる。
    """
    m = _line(gate=_ALL, junction_x=28.0, n_spurs=2, rate=600.0, pack_time=120.0,
              release={"period_s": 300.0, "window_s": 120.0,
                       "stack_rate_per_hr": 200.0, "load_kind": "packed"},
              staging={"capacity": 1}, duration=5400.0)
    res = run_once(m, seed=SEED)
    k = kpis.compute([res], m)
    assert k["orders_completed"] > 0
    assert k["stopper_windows"] >= 10
    # どの窓でも列は必ず空になる (= 本線のスロットは有限時間で必ず返る)
    for e in _events(res, "stopper_close"):
        after = [x for x in _events(res, "stopper_hold") if x["t"] > e["t"]]
        if after:
            assert after[0]["queue"] == 1, "開放後に列が残っている"
    # 梱包は最後まで動き続ける (直前1/4のシフトでも仕事をしている)
    late = [x for x in _events(res, "pack_done") if x["t"] > 0.75 * res.duration_s]
    assert late, "後半で梱包が止まっている＝どこかで詰まった"


# ============================================== 解析側: 降りることを名乗る


def test_the_analytic_side_declines_to_mirror_and_says_which_mechanism():
    m = _line(gate=_ALL, junction_x=28.0, release=_RELEASE, staging={"capacity": 6})
    cv = analytic.estimate(m)["conveyor"]
    assert cv["line_mechanics_mirrored"] is False
    assert cv["unmirrored"] == ["stopper", "release_schedule", "bench_staging"]
    only_stop = analytic.estimate(_line(gate=_ALL, junction_x=28.0))["conveyor"]
    assert only_stop["unmirrored"] == ["stopper"]


def test_a_stopper_takes_neither_the_gate_nor_the_pull_closed_form():
    """どちらの導出もこの形の線では成り立たない。**黙って別の式を当てない**のが要点。

    pull は「引かれなかった荷は失われる」損失系だが、ストッパーはそれを待ち行列に
    戻す。停止線の式はゲートに立つ手をサーバに置くが、物理ストッパーに番人は居ない。
    """
    from whsim.linemech import gate as gate_mod
    from whsim.linemech import pull as pull_mod

    reached = []
    orig_g, orig_p = gate_mod.gate_line_estimate, pull_mod.estimate
    gate_mod.gate_line_estimate = lambda *a, **k: reached.append("gate")
    pull_mod.estimate = lambda *a, **k: reached.append("pull")
    try:
        analytic.estimate(_line(gate=_ALL, junction_x=28.0))
    finally:
        gate_mod.gate_line_estimate, pull_mod.estimate = orig_g, orig_p
    assert reached == []


def test_the_catalogue_declares_nothing_because_it_authors_none_of_this():
    """同梱テンプレは1つも書いていない ⇒ キー自体が出ない＝答えは1バイトも動かない。"""
    for manifest in templates.list_templates():
        m = templates.load_template_model(manifest["template_id"])
        assert analytic._unmirrored_line_mechanics(m) == []
        assert m.process.release_schedule is None
        assert m.process.bench_staging is None
        cv = analytic.estimate(m)["conveyor"]
        assert cv is None or "line_mechanics_mirrored" not in cv


def test_the_predicates_read_the_same_drawing_the_engine_wires():
    """不変条件11: 解析の述語は engine.build の答えと一致していなければならない。

    写しである以上、ここが唯一の防波堤 — build が張る/張らないと、解析が名乗る/
    名乗らないが食い違った瞬間に、鏡の無い機構を鏡があるものとして価格してしまう。
    """
    cases = [
        _line(gate=None, junction_x=28.0),
        _line(gate={"stop_states": ["inspected"]}, junction_x=28.0),
        _line(gate=_ALL, junction_x=28.0),
        _line(gate={"mode": "all", "pullable": False}, junction_x=28.0),
        _line(gate={"stop_states": ["inspected"], "pullable": True}, junction_x=28.0),
        _line(gate=_ALL, junction_x=28.0, release=_RELEASE),
        _line(gate=_ALL, junction_x=28.0, release=_RELEASE, staging={"capacity": 6}),
        _line(gate=_ALL, junction_x=28.0, staging={"capacity": 6}),
        # 壊れた記述: 値ごとに独立して既定へ落ちる（窓の書き間違いでスケジュール
        # ごと消えると、engine は張っているのに解析は「何も無い」と名乗る）
        _line(gate=_ALL, junction_x=28.0,
              release={"period_s": 900.0, "window_s": "五分"},
              staging={"capacity": "六"}),
        _line(gate=_ALL, junction_x=28.0, release={"period_s": "毎時"},
              staging={"capacity": 6}),
    ]
    for m in cases:
        world = build(m)
        names = analytic._unmirrored_line_mechanics(m)
        assert ("stopper" in names) == bool(world.stoppers), m.process.release_schedule
        assert ("release_schedule" in names) == (world.release_schedule is not None)
        assert ("bench_staging" in names) == (world.bench_staging is not None)


def test_the_window_share_is_disclosed_but_never_multiplied_into_the_capacity():
    """窓の割合は**開示**であって上界ではない — 能力には一切かけない。

    「開放中は投入が止まるのだから能力はその分減る」は induction の話で、throughput
    の話ではない。窓が無い（出し切るまで）モデルには開示する数字も無い。
    """
    m = _line(gate=_ALL, junction_x=28.0, release={**_RELEASE, "period_s": 900.0,
                                                   "window_s": 300.0},
              staging={"capacity": 6})
    plain = _line(gate=_ALL, junction_x=28.0)
    cv, base = analytic.estimate(m)["conveyor"], analytic.estimate(plain)["conveyor"]
    assert cv["release_window_share"] == pytest.approx(1 / 3)
    assert cv["capacity_per_hr"] == base["capacity_per_hr"]   # 掛けていない
    drained = analytic.estimate(
        _line(gate=_ALL, junction_x=28.0,
              release={"period_s": 900.0, "stack_rate_per_hr": 280.0},
              staging={"capacity": 6}))["conveyor"]
    assert drained["line_mechanics_mirrored"] is False
    assert "release_window_share" not in drained


def test_the_cheap_window_share_bound_was_measured_and_is_not_a_bound():
    """再導入を防ぐための計測: ``capacity × (1 − 窓の割合)`` は上界ではない。

    ストッパーの手前は数十スロットのバッファで、窓の間も梱包台はそこから食い続ける。
    だから投入が止まっても梱包は止まらず、実測はこの「上界」を**甘い側に**越える。
    越えたことをここで固定しておかないと、いずれ誰かが安く見えるこの式を足す。
    """
    plan = {**_RELEASE, "period_s": 900.0, "window_s": 300.0}
    m = _line(gate=_ALL, junction_x=28.0, n_spurs=2, rate=600.0, pack_time=60.0,
              release=plan, staging={"capacity": 20}, duration=7200.0)
    cv = analytic.estimate(m)["conveyor"]
    naive = cv["capacity_per_hr"] * (1.0 - cv["release_window_share"])
    measured = kpis.compute([run_once(m, seed=SEED)], m)["throughput_per_hr"]
    assert measured > naive, (measured, naive)


def test_the_estimate_stays_fast_with_the_new_mechanisms_on():
    """50ms のピンは編集中の再試算のため。降りる判定は述語1本ぶんしか増やさない。"""
    import time

    m = _line(gate=_ALL, junction_x=28.0, n_spurs=2, release=_RELEASE,
              staging={"capacity": 6})
    analytic.estimate(m)
    t0 = time.perf_counter()
    for _ in range(5):
        analytic.estimate(m)
    assert (time.perf_counter() - t0) / 5 < 0.05


# ============================================== 既定OFF: 触っていないこと


def test_none_of_the_three_is_on_in_any_shipped_model():
    for manifest in templates.list_templates():
        m = templates.load_template_model(manifest["template_id"])
        assert m.process.release_schedule is None
        assert m.process.bench_staging is None
        assert all(not isinstance(c.stop_gate, dict) or not c.stop_gate
                   for c in m.resources.conveyors)


def test_a_model_with_none_of_them_reports_every_new_kpi_as_zero():
    m = templates.load_template_model("line_inspection")
    m.simulation.duration_s = 1800.0
    k = kpis.compute([run_once(m, seed=11)], m)
    for key in ("stopper_stops", "stopper_pulls", "stopper_takes",
                "stopper_recovery_ratio", "stopper_queue_peak",
                "stopper_queue_peak_t", "stopper_queue_mean", "stopper_windows",
                "stopper_open_share", "stopper_open_total_s",
                "stopper_drain_mean_s", "stopper_drain_max_s",
                "stopper_released_loads", "stopper_released_queue",
                "stopper_trunk_occupancy_peak", "stopper_induction_hold_s",
                "stopper_induction_holds", "stopper_leaks",
                "bench_staging_peak", "bench_staging_peak_t", "bench_staging_mean",
                "bench_staging_capacity", "bench_staging_blocks",
                "bench_staging_block_s", "stack_loads", "stack_busy_s",
                "stack_utilization", "n_stackers"):
        assert k[key] == 0, key
    assert all(v["staging_peak"] == 0 for v in k["conveyors"].values())
    assert not math.isnan(k["conveyor_utilization"])
