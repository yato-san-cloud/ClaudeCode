"""完成品staging の排出天井 — 鏡写しできない3機構のうち、閉じた1点だけ。

不変条件17 は「物理ストッパー / 時間分離リリース / 完成品staging に解析側の鏡は
無い。`analytic` は名乗って降りる」と言う。名乗ること自体は正しかったが、**降りた
先が甘くないことは誰も測っていなかった**。測ったら甘かった: 完成品staging が張られた
図面で、歴史的な答え（`min(ベルト段の合計レート, μ_pack)`）は実測スループットを
**平均 +472%・最悪 +1614%** 上回っていた（周期1200s・置き場1個/台の合成ラインで
「60件/h」と言い、走らせると 8.5件/h）。名乗りは「DES で裏を取れ」の意味であって
「この数字は何でもよい」の意味ではない。

閉じられたのは**保存則**だからである: 完成品は置き場を通ってしか出荷に出られず、
置き場はリリースの窓の中でしか空かない（`processes._load_staging` は
`release_agent` の窓の中でしか `get` しない）。しかも drain は**全部の置き場が空に
なった瞬間に break する**ので、1つの窓で出て行くのは

    置き場の総数 ``room`` ＋ 満杯で put をブロックされている梱包者 ``hands``

——後者は「梱包し終えて手に持ったまま止まっている1個」で、drain が1個引くたびに
その put が通る。よって **X ≤ (room + hands) / 周期**。

**何が上界で、何が較正値か**（このファイルの主張の本体）:

* `bound_per_hr` は**証明できる上界**（窓の外 ≤ room + hands、窓の中 ≤ 窓長×μ_pack）。
* `per_hr` は**較正値**。break の議論は drain がシミュ時間を消費しないときに厳密で、
  本線に空きが無くて待つ窓ではその分だけ甘くなる。実測でしか正当化できない。
* 能力に効くのは `per_hr` の方で、`min()` が誠実さの本体。証明できる上界の方は
  **開示**として並べて出す（読む側が「どちらを読んでいるか」を選べるように）。

**鏡が無いことは変わらない**: ピーク・背圧・滞留・未梱包の流出（`stopper_leaks`）は
いまも DES にしか無い。`line_mechanics_mirrored: False` と `unmirrored` は出たままで、
天井はそれと同居する（降りたことと、降りた先が甘くないことは別の主張である）。
"""

from __future__ import annotations

import time

import pytest
from test_line_stopper import _ALL, _RELEASE, SEED, _line

from whsim import analytic, kpis, templates
from whsim.engine.build import build
from whsim.engine.run import run_once

SAT = 3000.0        # 需要飽和: 合成ラインのどの構成の天井よりはるかに上


def _drain(m):
    line = analytic._belt_stages(m)
    n = sum(max(0, s.count) for s in m.resources.stations) or 1
    return analytic._release_drain(m, line, n, max(m.process.pack_time_s, 0.0))


# ------------------------------------------------- 同梱カタログは一切触らない

@pytest.mark.parametrize("template_id",
                         [t["template_id"] for t in templates.list_templates()])
def test_the_catalogue_authors_none_of_this_so_no_ceiling_is_ever_computed(template_id):
    """同梱テンプレは3機構とも書いていない ⇒ 天井は計算されず、キーも出ない。"""
    m = templates.load_template_model(template_id)
    assert analytic._release_plan(m) is None
    assert analytic._staging_capacity(m) == 0
    cv = analytic.estimate(m)["conveyor"]
    assert cv is None or "release_drain" not in cv


def test_the_ceiling_is_inert_before_it_reads_the_drawing():
    """不活性の判定が先＝機構が書かれていなければ幾何も需要も読まない。"""
    m = _line(gate=_ALL, junction_x=28.0)                  # ストッパーだけ
    assert _drain(m) is None
    m2 = _line(gate=_ALL, junction_x=28.0, staging={"capacity": 6})  # 出口が無い
    assert _drain(m2) is None
    assert build(m2).bench_staging is None                 # engine も張らない


# -------------------------------------------------------------- 導出そのもの

def test_the_ceiling_is_the_room_plus_one_finished_item_per_pair_of_hands():
    """閉形式を手計算で押さえる（これが変わったら導出が変わったということ）。

    引き込み2本・各1台・置き場6個/台 ⇒ room = 12、hands = 2、周期600s。
    末端のカーブ C には台が描かれておらず余り台も無いので**0席**（engine は C にも
    Store を張るが、そこで梱包する人が図面に居ない＝完成品は生まれない）。
    """
    m = _line(gate=_ALL, junction_x=28.0, n_spurs=2, benches=1, rate=SAT,
              pack_time=60.0, release={**_RELEASE, "period_s": 600.0,
                                       "window_s": 120.0},
              staging={"capacity": 6}, duration=7200.0)
    d = _drain(m)
    assert (d["staging_slots"], d["blocked_hands"]) == (12, 2)
    assert d["per_cycle"] == 14
    assert d["per_hr"] == pytest.approx(14 / 600.0 * 3600.0)   # = 84件/h
    assert d["calibrated"] is True


def test_the_calibrated_reading_does_not_depend_on_the_window_and_the_bound_does():
    """周期で閉じる話なので、窓を伸ばしても**較正値は1件も動かない**。

    証明できる上界の方は窓の中の梱包を数えるので窓長に比例して緩む——2つを別の
    キーで出す理由がこれ（「窓を長くすれば能力が上がる」は staging が空になった
    瞬間に drain が止まる以上、成り立たない）。
    """
    def cv(window):
        m = _line(gate=_ALL, junction_x=28.0, n_spurs=2, rate=SAT, pack_time=60.0,
                  release={**_RELEASE, "period_s": 600.0, "window_s": window},
                  staging={"capacity": 6}, duration=7200.0)
        return analytic.estimate(m)["conveyor"]

    short, long = cv(120.0), cv(300.0)
    assert short["release_drain"]["per_hr"] == long["release_drain"]["per_hr"]
    assert short["capacity_per_hr"] == long["capacity_per_hr"]
    assert long["release_drain"]["bound_per_hr"] > short["release_drain"]["bound_per_hr"]
    # 較正値は必ず上界の下 (min にどちらを入れているかが逆転しない)
    for c in (short, long):
        assert c["release_drain"]["per_hr"] <= c["release_drain"]["bound_per_hr"]


def test_the_serial_boarding_time_only_ever_tightens_the_provable_bound():
    """``board_time_s`` は「1個ずつ人が載せる」直列性＝上界を締めるだけ。"""
    base = _line(gate=_ALL, junction_x=28.0, rate=SAT, pack_time=60.0,
                 release={**_RELEASE, "period_s": 600.0, "window_s": 300.0},
                 staging={"capacity": 6}, duration=7200.0)
    slow = _line(gate=_ALL, junction_x=28.0, rate=SAT, pack_time=60.0,
                 release={**_RELEASE, "period_s": 600.0, "window_s": 300.0,
                          "board_time_s": 120.0},
                 staging={"capacity": 6}, duration=7200.0)
    a, b = _drain(base), _drain(slow)
    assert b["bound_per_hr"] < a["bound_per_hr"]
    assert b["per_hr"] == a["per_hr"]          # 較正値は drain の中身を数えていない


# --------------------------------------- 不変条件11: engine の配線と食い違わない

def test_the_room_the_oracle_counts_never_exceeds_the_store_the_engine_wires():
    """解析が数える置き場は **engine が張った Store の容量以下**でなければならない。

    多く数えれば天井が上がる＝甘い側に倒れる。停止線の手（`linemech.bench_ledger`
    でしか解けない。不変条件11: 写しを2つ作らない）は**数えていない**ので、
    食い違いは必ず「解析が少なく数える」向きに出る。
    """
    cases = [
        _line(gate=_ALL, junction_x=28.0, release=_RELEASE, staging={"capacity": 6}),
        _line(gate=_ALL, junction_x=28.0, n_spurs=3, benches=2, release=_RELEASE,
              staging={"capacity": 20}),
        _line(gate=_ALL, junction_x=28.0, n_spurs=2, stop_benches=2,
              release=_RELEASE, staging={"capacity": 4}),
        _line(gate=_ALL, junction_x=10.0, n_spurs=2, benches=0, release=_RELEASE,
              staging={"capacity": 6}),
    ]
    for m in cases:
        world = build(m)
        wired = sum(s.capacity for s in (world.bench_staging or {}).values())
        d = _drain(m)
        got = d["staging_slots"] if d else 0
        assert got <= wired, (got, wired)


def test_the_ceiling_exists_exactly_where_the_engine_wires_the_buffer():
    """「天井が計算される」と「engine が置き場を張る」は同じ図面で起きる。"""
    cases = [
        (_line(gate=_ALL, junction_x=28.0, release=_RELEASE,
               staging={"capacity": 6}), True),
        (_line(gate=_ALL, junction_x=28.0, release=_RELEASE), False),
        (_line(gate=_ALL, junction_x=28.0, staging={"capacity": 6}), False),
        (_line(gate=_ALL, junction_x=28.0, release=_RELEASE,
               staging={"capacity": 0}), False),
        (_line(gate=None, junction_x=28.0, release=_RELEASE,
               staging={"capacity": 6}), False),
    ]
    for m, wired in cases:
        assert bool(build(m).bench_staging) is wired
        cv = analytic.estimate(m)["conveyor"]
        assert ("release_drain" in cv) is wired


def test_the_ceiling_reaches_neither_the_gate_nor_the_pull_closed_form():
    """降りたままである＝別の機構の式は1つも呼ばない（不変条件17の主張）。"""
    from whsim.linemech import gate as gate_mod
    from whsim.linemech import pull as pull_mod

    reached = []
    orig_g, orig_p = gate_mod.gate_line_estimate, pull_mod.estimate
    gate_mod.gate_line_estimate = lambda *a, **k: reached.append("gate")
    pull_mod.estimate = lambda *a, **k: reached.append("pull")
    try:
        cv = analytic.estimate(
            _line(gate=_ALL, junction_x=28.0, release=_RELEASE,
                  staging={"capacity": 6}))["conveyor"]
    finally:
        gate_mod.gate_line_estimate, pull_mod.estimate = orig_g, orig_p
    assert reached == []
    assert cv["line_mechanics_mirrored"] is False
    assert cv["unmirrored"] == ["stopper", "release_schedule", "bench_staging"]
    assert cv["release_drain"]["calibrated"] is True


# ------------------------------------------------- DES との一致（落ちうる検査）

@pytest.mark.parametrize("period,cap,n_spurs,benches,measured", [
    (600.0, 2, 1, 1, 17.5),
    (600.0, 6, 2, 1, 81.5),
    (1200.0, 2, 2, 2, 34.0),
])
def test_the_ceiling_agrees_with_the_run_within_its_validated_band(
        period, cap, n_spurs, benches, measured):
    """需要を飽和させた実測スループットと突き合わせる。

    帯は **−15% 〜 +68%**（合成288構成・2 seed・8時間の実測。下側＝辛い側は能力の
    天井としては安全側）。`measured` は参考値で、実際に走らせた値と突き合わせる。
    """
    m = _line(gate=_ALL, junction_x=28.0, n_spurs=n_spurs, benches=benches,
              rate=SAT, pack_time=60.0,
              release={**_RELEASE, "period_s": period, "window_s": period * 0.2},
              staging={"capacity": cap}, duration=7200.0)
    cap_est = analytic.estimate(m)["conveyor"]["capacity_per_hr"]
    k = kpis.compute([run_once(m, seed=SEED)], m)
    x = k["throughput_per_hr"]
    assert x == pytest.approx(measured, rel=0.25), x
    err = (cap_est - x) / x
    assert -0.15 <= err <= 0.68, (cap_est, x, err)


def test_without_the_ceiling_the_oracle_oversold_this_line_several_fold():
    """**天井を外した答え**が実測の何倍だったかを固定する（判断の根拠そのもの）。

    ここが破れたら「天井は要らなかった」ということなので、判断を見直すこと。
    """
    m = _line(gate=_ALL, junction_x=28.0, rate=SAT, pack_time=60.0,
              release={**_RELEASE, "period_s": 1200.0, "window_s": 240.0},
              staging={"capacity": 1}, duration=7200.0)
    plain = _line(gate=_ALL, junction_x=28.0, rate=SAT, pack_time=60.0,
                  duration=7200.0)
    without = analytic.estimate(plain)["conveyor"]["capacity_per_hr"]
    with_ = analytic.estimate(m)["conveyor"]["capacity_per_hr"]
    x = kpis.compute([run_once(m, seed=SEED)], m)["throughput_per_hr"]
    assert without / x > 5.0, (without, x)          # 歴史的な答えは5倍以上 甘い
    assert with_ / x < 2.0, (with_, x)              # 天井つきは2倍未満
    assert with_ < without


def test_a_line_with_no_staging_keeps_exactly_the_historical_answer():
    """置き場を書いていない図面では天井は計算されず、数字は1バイトも動かない。

    実測（64構成: ストッパー単独 / リリースのみ × pull/auto × 合流点2 × 需要2 × 台数）では
    歴史的な答えは実測の 1.01〜1.81倍で、甘い側に外れた構成は**0**だった。
    """
    m = _line(gate=_ALL, junction_x=28.0, release=_RELEASE)
    cv = analytic.estimate(m)["conveyor"]
    assert "release_drain" not in cv
    assert cv["binding"] != "staging"
    k = kpis.compute([run_once(m, seed=SEED)], m)
    assert cv["capacity_per_hr"] >= k["throughput_per_hr"]


def test_the_stacking_crew_is_a_provable_ceiling_of_its_own():
    """積み付けを通らずに出て行く完成品は無い ⇒ ``stackers × stack_rate`` は上界。

    こちらは較正ではなく**証明できる**（未梱包で流れ出た荷も同じ口を通るので、実際は
    これより更に少ない）。書いていない図面では engine も待たせないので制約ではなく、
    `stack_per_hr` は `None` になる。
    """
    tight = _line(gate=_ALL, junction_x=28.0, n_spurs=2, rate=SAT, pack_time=60.0,
                  release={**_RELEASE, "period_s": 600.0, "window_s": 120.0,
                           "stack_rate_per_hr": 30.0},
                  staging={"capacity": 6}, duration=7200.0)
    d = _drain(tight)
    assert d["stack_per_hr"] == 30.0
    assert d["per_hr"] == 30.0                       # 84件/h の置き場より積み付けが先
    cv = analytic.estimate(tight)["conveyor"]
    assert cv["capacity_per_hr"] == pytest.approx(30.0)
    k = kpis.compute([run_once(tight, seed=SEED)], tight)
    assert k["throughput_per_hr"] <= 30.0 + 1e-9     # 上界として実測を上回らない
    free = _line(gate=_ALL, junction_x=28.0, n_spurs=2, rate=SAT, pack_time=60.0,
                 release={"period_s": 600.0, "window_s": 120.0},
                 staging={"capacity": 6}, duration=7200.0)
    assert _drain(free)["stack_per_hr"] is None


@pytest.mark.parametrize("pull", [True, False])
def test_the_auto_cascade_lands_on_a_pull_line_here_and_errs_gloomy(pull):
    """降りると ``divert_policy`` に関わらず ``_overflow_cascade`` が当たる。

    `_overflow_cascade` の docstring は長らく「pull は `linemech.pull` が先に取るので
    ここへは届かない」と書いていたが、**降りる機構が書かれた瞬間にそれは偽になる**
    （両方の鏡を使わずに `_conveyor_estimate` へ落ちるので、pull のラインに `auto` の
    水詰めが当たる）。方式で分岐して直すのではなく、**どちらに外れるかを測って書く**
    のがここの主張: 実測144構成で pull 平均 +0.436・auto 平均 +0.289（＝辛い側）、
    甘い側に出たのは各1/72 でしかも**方式に依らず同じ構成**——原因は方式ではなく
    「ストッパーの列が本線のスロットを握る」ことで、そこは今も鏡が無い。
    """
    m = _line(gate=_ALL, junction_x=28.0, n_spurs=2, benches=1, rate=1800.0,
              pack_time=60.0, pull=pull,
              release={**_RELEASE, "period_s": 600.0, "window_s": 120.0},
              staging={"capacity": 6}, duration=7200.0)
    cv = analytic.estimate(m)["conveyor"]
    assert cv["line_mechanics_mirrored"] is False      # 降りている
    k = kpis.compute([run_once(m, seed=SEED)], m)
    assert cv["block_ratio_est"] >= k["conveyor_block_ratio"] - 0.17, (
        cv["block_ratio_est"], k["conveyor_block_ratio"])


def test_the_binding_stage_is_named_staging_when_the_drain_is_what_binds():
    m = _line(gate=_ALL, junction_x=28.0, rate=SAT, pack_time=60.0,
              release={**_RELEASE, "period_s": 1200.0, "window_s": 240.0},
              staging={"capacity": 1}, duration=7200.0)
    cv = analytic.estimate(m)["conveyor"]
    assert cv["binding"] == "staging"
    assert cv["capacity_per_hr"] == pytest.approx(cv["release_drain"]["per_hr"])
    # 置き場を潤沢にすれば縛るのは梱包台に戻る
    roomy = _line(gate=_ALL, junction_x=28.0, rate=SAT, pack_time=60.0,
                  release={**_RELEASE, "period_s": 600.0, "window_s": 120.0},
                  staging={"capacity": 400}, duration=7200.0)
    assert analytic.estimate(roomy)["conveyor"]["binding"] != "staging"


# ------------------------------------------------------------ never-blocks / 爆速

@pytest.mark.parametrize("staging", [
    {"capacity": "六"}, {"capacity": None}, {"capacity": -3}, {}, None, "12",
])
def test_a_staging_that_is_not_a_number_is_not_a_buffer(staging):
    m = _line(gate=_ALL, junction_x=28.0, release=_RELEASE)
    m.process.bench_staging = staging
    assert build(m).bench_staging is None
    assert _drain(m) is None
    assert "release_drain" not in analytic.estimate(m)["conveyor"]


@pytest.mark.parametrize("release", [
    {"period_s": 0.0}, {"period_s": "毎時"}, {}, None, 42,
])
def test_a_release_that_never_fires_computes_no_ceiling(release):
    m = _line(gate=_ALL, junction_x=28.0, staging={"capacity": 6})
    m.process.release_schedule = release
    assert build(m).bench_staging is None
    assert _drain(m) is None


def test_a_broken_window_still_leaves_the_period_doing_the_work():
    """値ごとに独立して既定へ落ちる（``build._num``）: 窓が壊れても周期は生きる。"""
    m = _line(gate=_ALL, junction_x=28.0,
              release={"period_s": 900.0, "window_s": "五分",
                       "stack_rate_per_hr": 280.0},
              staging={"capacity": 6})
    d = _drain(m)
    assert d is not None and d["period_s"] == 900.0
    assert build(m).release_schedule["window_s"] == 0.0


def test_the_ceiling_costs_nothing_against_the_50ms_budget():
    m = _line(gate=_ALL, junction_x=28.0, n_spurs=3, benches=2, release=_RELEASE,
              staging={"capacity": 20})
    analytic.estimate(m)
    t0 = time.perf_counter()
    for _ in range(10):
        analytic.estimate(m)
    assert (time.perf_counter() - t0) / 10 < 0.05


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
