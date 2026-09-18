"""待っている荷は「列」であって1点ではない（replay の荷の位置）。

エンジンは止まった荷を**列**として解いている: 物理ストッパーの前は
``Stopper.arc_of`` が 1個/``tote_pitch_m`` で位置まで決めていて、その位置が
「どの引き込みの作業者が手を届かせられるか」を決めている。ところが replay は
全員を**止まった1点**に書いていた——投入待ちの荷は乗り口に、分岐待ちの荷は合流点に、
ストッパー前の荷はゲートに、何十個でも同じ座標で重なる。情報は在るのに捨てていた
ので、3D を作る側が毎回自分で間隔を引き直していた（不変条件11が禁じている「3つ目の
写し」がまさにそれ）。

ここで固定するのは3本: **投入待ち**（乗り口の上流へ）・**分岐待ち**（合流点の上流へ）・
**ストッパー前**（ゲートの上流へ）。どれも「列が無ければ1バイトも変わらない」のが
条件で、最後のテストがそれを固定する。フィクスチャは全部合成。
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter

from test_line_mechanics import (  # the line fixtures live next door
    INSPECT,
    PACK,
    PICK,
    SHIP,
    _edge,
    _model,
)

from whsim import beltgeom, kpis
from whsim.engine.run import run_once
from whsim.render.replay import build_replay
from whsim.schema.model import Conveyor, Station

PITCH = 0.5

# Captured from the PRE-CHANGE tree (a `git worktree` of HEAD, same model, same
# seed): a line that never makes anyone wait draws exactly what it always drew.
_NO_QUEUE_TOTES_SHA = \
    "2e1801754a46c7fe2b7159f511618da1a8396482b2a79815cec310e64cd744b9"


def _sha(obj) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, default=str, ensure_ascii=False).encode()
    ).hexdigest()


def _entry_line(*, pitch=PITCH, pack_time=180.0, rate=600.0, duration=1800.0):
    """1本のコンベアと 1台の梱包台。台が遅いのでベルトが満杯になり、ピッカーは
    乗り口で**順番待ちの列**になる（実案件で ~21 個が同じ座標に重なった形）。"""
    belt = Conveyor(id="E", points=[[5.0, 4.0], [5.0, 12.0]], speed_mps=1.0,
                    tote_pitch_m=pitch)
    return _model([belt], [_edge(PICK, PACK, "E")],
                  pick_xy=[(3.0, 2.0), (7.0, 2.0)], pickers=6, rate=rate,
                  pack_time=pack_time, duration=duration,
                  stations=[Station(id="pack", x=5.0, y=13.0, count=1)])


def _spur_line(*, pitch=PITCH, gate=None, pack_time=120.0, rate=300.0,
               duration=1800.0, pull=False):
    """検品ライン E → 本線 T（arc 28 で引き込み S が分岐）。台が1つしかないので
    本線の荷は合流点で待たされ、その列が上流へ伸びる。"""
    e = Conveyor(id="E", points=[[5.0, 4.0], [5.0, 12.0]], speed_mps=1.0,
                 tote_pitch_m=pitch, load_kind="inspected")
    t = Conveyor(id="T", points=[[0.0, 12.0], [40.0, 12.0]], speed_mps=1.0,
                 tote_pitch_m=pitch,
                 stop_gate=({"at_m": 34.0, **gate} if gate else None))
    s = Conveyor(id="S", points=[[28.0, 12.0], [28.0, 16.0]], speed_mps=0.5,
                 tote_pitch_m=pitch)
    m = _model([e, t, s],
               [_edge(PICK, INSPECT, "E"), _edge(INSPECT, PACK, "S"),
                _edge(PACK, SHIP, "T")],
               pick_xy=[(3.0, 2.0), (7.0, 2.0)], pickers=4, rate=rate,
               pack_time=pack_time, duration=duration,
               stations=[Station(id="b1", x=28.0, y=17.0, count=1)])
    m.process.divert_policy = "pull" if pull else "auto"
    return m


# --------------------------------------------------------------- sampling
# 荷の軌跡は (t, x, y, state) なので「いつどこに居たか」は replay だけから読める。


def _at(track: dict, t: float):
    """``t`` の時点でこの荷が**描かれる**場所 — ビューアと同じ線形補間で読む。

    キーフレームをそのまま読むと「走っている荷」まで直前の角に居ることになるので、
    重なりの数え方が嘘になる（動いている荷は重なっていない）。まだ生まれていない/
    もう終わった荷は ``None``。
    """
    kfs = track["keyframes"]
    if not kfs or kfs[0][0] > t or kfs[-1][0] < t:
        return None
    prev = kfs[0]
    for kf in kfs:
        if kf[0] > t:
            span = kf[0] - prev[0]
            f = ((t - prev[0]) / span) if span > 1e-9 else 0.0
            return (round(prev[1] + (kf[1] - prev[1]) * f, 6),
                    round(prev[2] + (kf[2] - prev[2]) * f, 6), prev[3])
        prev = kf
    return (prev[1], prev[2], prev[3])


def _stacks(doc: dict, t: float, where=None) -> Counter:
    """その瞬間、同じ座標に何個の荷が重なって描かれているか。"""
    pts = (_at(tr, t) for tr in doc["totes"])
    return Counter((p[0], p[1]) for p in pts
                   if p is not None and (where is None or where(p)))


def _worst(doc: dict, step: float = 2.0, where=None):
    """最も重なった瞬間: ``(重なり数, 座標, 時刻)``。"""
    win = doc["meta"]["replay_window_s"]
    worst = (0, None, 0.0)
    t = 0.0
    while t <= win:
        for xy, n in _stacks(doc, t, where).items():
            if n > worst[0]:
                worst = (n, xy, t)
        t += step
    return worst


def _run(m):
    res = run_once(m, seed=4)
    return res, build_replay(m, res, kpis.compute([res], m))


def _on_belt(m, belt_id, p, tol=1e-6) -> bool:
    pts = [(q[0], q[1]) for q in
           next(c for c in m.resources.conveyors if c.id == belt_id).points]
    return beltgeom.distance_to(p, pts) <= tol


# ==================================================== 1. 投入待ち（乗り口）

def test_totes_waiting_to_board_queue_up_the_belt_instead_of_stacking():
    """満杯のベルトに乗ろうとして待つ荷は、乗り口の**上流へ1個/ピッチ**で並ぶ。

    以前はこれが全部**乗り口の1点**だった（実案件で 21 個が (11.1, 34.3) に重なった）。
    """
    m = _entry_line()
    res, doc = _run(m)
    assert [e for e in res.events
            if e["event"] == "conveyor_on" and e.get("blocked")], "詰まっていること"
    # 乗り口 (5,4) とその上流だけを見る（末端で梱包を待つ荷の重なりは別件＝未修正、
    # :func:`processes._convey_chain` の注記）。
    n, xy, t = _worst(doc, where=lambda p: p[1] <= 4.0)
    assert n <= 1, f"{n} 個が {xy} に重なっている (t={t})"

    # 並び方そのものを見る: 乗り口 (5,4) から上流（-y 方向）へ 0.5 m 刻み。
    seen = set()
    for tr in doc["totes"]:
        for kf in tr["keyframes"]:
            if kf[3] == "carry" and kf[1] == 5.0 and kf[2] <= 4.0:
                seen.add(round(kf[2], 3))
    assert 4.0 in seen and 3.5 in seen and 3.0 in seen, sorted(seen)
    # 列は乗り口より上流にしか伸びない（ベルトの上には出ない）。
    assert max(seen) == 4.0
    # ピッチの整数倍の位置にしか立たない。
    assert all(abs(((4.0 - y) / PITCH) - round((4.0 - y) / PITCH)) < 1e-6
               for y in seen)


def test_the_boarding_tote_is_still_handed_over_at_the_boarding_point():
    """列の先頭は乗り口に居る＝手渡しは連続のまま（``carry`` の最後＝``belt`` の最初）。"""
    m = _entry_line()
    _res, doc = _run(m)
    checked = 0
    for tr in doc["totes"]:
        carry = [f for f in tr["keyframes"] if f[3] == "carry"]
        belt = [f for f in tr["keyframes"] if f[3] == "belt"]
        if not carry or not belt:
            continue
        assert (carry[-1][1], carry[-1][2]) == (belt[0][1], belt[0][2])
        checked += 1
    assert checked > 5


# ==================================================== 2. 分岐待ち（合流点）

def test_totes_stalled_at_a_junction_back_up_the_trunk_one_per_pitch():
    """引き込みが満杯で本線に止まる荷は、合流点から上流へ列になる。

    これが本線の背圧の絵そのもの（「本線が引き込み待ちで埋まる」）。以前は何十個でも
    合流点の1点に描かれていた。
    """
    m = _spur_line()
    _res, doc = _run(m)
    # 本線の上だけを見る（引き込みの末端で梱包を待つ荷の重なりは別件＝未修正、
    # :func:`processes._convey_chain` の注記）。
    n, xy, t = _worst(doc, where=lambda p: p[1] == 12.0)
    assert n <= 1, f"{n} 個が {xy} に重なっている (t={t})"

    # 合流点 (28,12) から上流（-x）へ 0.5 m 刻みで、本線の上に並ぶ。
    seen = {round(f[1], 3) for tr in doc["totes"] for f in tr["keyframes"]
            if f[3] == "belt" and f[2] == 12.0 and 20.0 <= f[1] <= 28.0}
    assert {28.0, 27.5, 27.0} <= seen, sorted(seen)
    assert all(_on_belt(m, "T", (x, 12.0)) for x in seen)


def test_the_queue_slides_forward_when_the_load_in_front_turns_off():
    """1つ抜けたら後ろは1ピッチ前へ詰まる（箱を取ると残りが滑り込む）。

    位置だけの話ではなく**順番**の話: 列の中で荷は追い越さないので、同じ荷の x は
    単調に増える（本線は +x 向き）。

    ⚠️ 見るのは合流点の手前 8 m だけ。ベルトのスロットは**計数資源**なので、飽和した
    本線では合流点で止まっている荷の数が「乗り口〜合流点」に物理的に入る数を超える
    ことがあり、そのとき列の尻は乗り口より上流に伸びる（列に加わった瞬間に 1ピッチ
    ぶん後ろへ置かれる荷が出る）。エンジンの数え方の帰結であって、列の描き方の問題
    ではない。
    """
    m = _spur_line()
    _res, doc = _run(m)
    moved = 0
    for tr in doc["totes"]:
        xs = [f[1] for f in tr["keyframes"]
              if f[3] == "belt" and f[2] == 12.0 and 20.0 <= f[1] <= 28.0]
        if len(xs) < 3:
            continue
        assert xs == sorted(xs), f"{tr['id']} が本線を後ろへ戻っている: {xs}"
        moved += sum(1 for a, b in zip(xs, xs[1:]) if 0 < b - a <= PITCH + 1e-9)
    assert moved > 5, "列が前へ詰まる動きが1つも出ていない"


# ==================================================== 3. ストッパーの前

def test_the_stopper_queue_is_drawn_where_the_engine_already_solved_it():
    """物理ストッパーの列は ``Stopper.arc_of`` が既に知っていた位置に描かれる。

    その位置は飾りではない: 「列の尻が自分の合流点まで戻ってきた引き込みの作業者が
    止まっている荷を引ける」の判定に使われている当の数字なので、絵と判定が違う位置を
    指していると、動画は「引けるはずのない荷を引いている」ように見える。
    """
    m = _spur_line(gate={"mode": "all"}, pull=True, pack_time=200.0)
    res, doc = _run(m)
    holds = [e for e in res.events if e["event"] == "stopper_hold"]
    assert holds, "ストッパーの前に列ができていること"
    deep = max(e["queue"] for e in holds)
    assert deep >= 3, f"列が浅すぎる (max={deep})"

    n, xy, t = _worst(doc, where=lambda p: p[1] == 12.0)
    assert n <= 1, f"{n} 個が {xy} に重なっている (t={t})"
    # ゲートは arc 34 = (34,12)。列はそこから上流へ 1個/ピッチ。
    seen = {round(f[1], 3) for tr in doc["totes"] for f in tr["keyframes"]
            if f[3] == "belt" and f[2] == 12.0 and 30.0 <= f[1] <= 34.0}
    assert {34.0, 33.5, 33.0} <= seen, sorted(seen)
    # エンジンの ``arc_of`` と同じ答えであること（2つ目の規則を作っていない）。
    stopper_arcs = [e["arc"] for e in holds]
    assert all(math.isclose(a, 34.0 - i * PITCH, abs_tol=1e-9) or a == 0.0
               for a, i in ((e["arc"], e["queue"] - 1) for e in holds)), stopper_arcs


# ==================================================== 4. 列が無ければ不変

def test_a_run_with_no_queue_draws_exactly_what_it_always_did():
    """詰まらないラインは 1 バイトも変わらない（additive + guard）。

    追加したキーフレームは「待たされたときだけ」出る: 空いているベルトは request が
    その場で granted されるので、列そのものが存在しない。
    """
    m = _entry_line(pack_time=1.0, rate=60.0, duration=600.0)
    res, doc = _run(m)
    assert not [e for e in res.events
                if e["event"] == "conveyor_on" and e.get("blocked")], "詰まっていない"
    # ダイジェストは**変更前のツリー**（`git worktree` の de0cc8f）で同じモデル・同じ
    # seed から採った値。今のツリーで凍らせた値ではないので、「変わっていない」の
    # 証拠になる。
    assert len(res.totes) == 14
    assert sum(len(t.keyframes) for t in res.totes) == 131
    assert _sha([[t.id, t.keyframes] for t in res.totes]) == _NO_QUEUE_TOTES_SHA
    # …そして荷はベルトの上だけを通る（乗り口の上流へ伸びる列は1本も出ていない）。
    for tr in doc["totes"]:
        belt_pts = [(f[1], f[2]) for f in tr["keyframes"] if f[3] == "belt"]
        assert all(_on_belt(m, "E", p) for p in belt_pts)
