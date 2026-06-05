#!/usr/bin/env python3
"""
計量モンテカルロ・シミュレーション: 6社 10年(2026-2036)の競争
================================================================
これは「予測」ではなく、明示したパラメータ(事前推定)の下で
確率的ショックを毎回引いて1万回試行し、結果の分布を出すもの。
パラメータは全て下の PARAMS で編集可能。seed固定で再現可能。

各社の状態: 年間売上(scale, $B) / 現金($B) / 堀(0-1) / 生存・独立フラグ
毎年: 市場成長 ± シェア争奪 - 既存巨人の圧力 ± ショック + ノイズ で売上が動く。
現金が尽きると、堀と評価額に応じて「被買収」か「消滅」。
評価額 = 売上 × セクター倍率 × マクロ・センチメント(規制上限あり)。
勝者 = 2036年に生存している中で評価額最大の社。
"""
import random
import statistics
from collections import defaultdict

N_TRIALS = 10000
YEARS = list(range(2026, 2037))  # 2026..2036 inclusive (11 time points, 10 transitions)
SEED = 42

# ----------------------------------------------------------------------
# パラメータ(事前推定 — ここを編集すれば結論が変わる)
# ----------------------------------------------------------------------
# scale0      : 2026年の年間売上($B) ※Helios/MeridianはAUM/TPVでなく手数料収入相当
# cagr        : 売上成長率の中央値(初期、年とともに逓減)
# vol         : 成長率のばらつき(対数正規シグマ)
# margin_cap  : 成熟時の営業利益率
# burn0       : 初期の年間赤字($B、黒字化まで)
# mult_lo/hi  : 評価倍率(売上倍率)のレンジ
# moat0       : 初期の堀(0-1)
# moat_gain   : 年あたり堀の増加
# inc_pressure: 既存巨人による年間成長押し下げ(中盤以降)
# reg_cap     : 規制で評価倍率に天井がかかる係数(1=なし, <1で抑制)
# shock_*     : 各ショックへの感応度(負=逆風, 正=追風), その年の成長に加算
PARAMS = {
    "Helios": dict(  # AI自律資本配分
        scale0=0.03, cagr=0.55, vol=0.45, margin_cap=0.45, burn0=0.04,
        mult_lo=8, mult_hi=14, moat0=0.45, moat_gain=0.05, inc_pressure=0.10,
        reg_cap=0.75,  # 34年プロシクリカリティ規制で成長/倍率に天井
        s_ai_finance=-0.35, s_semi=0.0, s_edu=0.0, s_grid=0.0, s_robot=0.0, s_verifiable=+0.10),
    "Synapse": dict(  # ロボ頭脳OS
        scale0=0.03, cagr=0.65, vol=0.55, margin_cap=0.40, burn0=0.06,
        mult_lo=12, mult_hi=20, moat0=0.40, moat_gain=0.055, inc_pressure=0.16,  # NVIDIA/Tesla/中国
        reg_cap=0.95,
        s_ai_finance=0.0, s_semi=-0.30, s_edu=0.0, s_grid=0.0, s_robot=-0.20, s_verifiable=+0.05),
    "Axiom": dict(  # 移動権マーケット
        scale0=0.005, cagr=0.70, vol=0.55, margin_cap=0.30, burn0=0.05,
        mult_lo=6, mult_hi=10, moat0=0.30, moat_gain=0.05, inc_pressure=0.20,  # Uber/Waymo供給支配
        reg_cap=0.70,  # 35年公益事業化
        s_ai_finance=0.0, s_semi=-0.18, s_edu=0.0, s_grid=0.0, s_robot=0.0, s_verifiable=0.0),
    "Cerebra": dict(  # 認知教育OS
        scale0=0.005, cagr=0.62, vol=0.55, margin_cap=0.35, burn0=0.04,
        mult_lo=8, mult_hi=14, moat0=0.30, moat_gain=0.05, inc_pressure=0.18,  # OpenAI/Google無料配布
        reg_cap=0.85,
        s_ai_finance=0.0, s_semi=0.0, s_edu=-0.40, s_grid=0.0, s_robot=0.0, s_verifiable=+0.08),
    "GridMind": dict(  # 電力VPP-OS
        scale0=0.022, cagr=0.60, vol=0.40, margin_cap=0.30, burn0=0.03,
        mult_lo=6, mult_hi=9, moat0=0.45, moat_gain=0.06, inc_pressure=0.10,  # Tesla Energy
        reg_cap=0.65,  # 35年公益事業化で利潤に強い天井
        s_ai_finance=0.0, s_semi=+0.08, s_edu=0.0, s_grid=+0.30, s_robot=0.0, s_verifiable=0.0),
    "Meridian": dict(  # 惑星間/エージェント決済
        scale0=0.001, cagr=0.68, vol=0.65, margin_cap=0.40, burn0=0.05,
        mult_lo=8, mult_hi=15, moat0=0.25, moat_gain=0.045, inc_pressure=0.30,  # Visa/中銀/マスクX Money
        reg_cap=0.80,
        s_ai_finance=-0.20, s_semi=0.0, s_edu=0.0, s_grid=0.0, s_robot=0.0, s_verifiable=+0.12),
}

# ショックの年あたり発生確率(毎試行・毎年 独立に抽選 → 試行ごとに歴史が変わる)
SHOCK_HAZARD = {
    "ai_finance": 0.10,   # AI委任金融事故
    "semi":       0.08,   # 半導体/地政学危機
    "edu":        0.09,   # 教育スキャンダル
    "grid":       0.10,   # 災害→VPP英雄化
    "robot":      0.07,   # ロボ死亡事故
    "verifiable": 0.14,   # 検証可能AIの普及(監査先行組に追風)
}

# マスク超え判定の閾値($B、生存社の評価額がこれを超えたら「超克」とみなす proxy)
MUSK_THRESHOLD = 300.0

# ----------------------------------------------------------------------
def macro_path(rng):
    """マクロ・センチメント(評価倍率係数)と資金調達環境を年次で生成。
    26-27過熱 → 28-29崩壊/リセッション → 30底 → 31-36再加速、にノイズ。"""
    base = {2026:1.25, 2027:1.35, 2028:0.70, 2029:0.55, 2030:0.80,
            2031:1.05, 2032:1.15, 2033:1.10, 2034:1.00, 2035:1.05, 2036:1.10}
    fund = {2026:1.2, 2027:1.3, 2028:0.4, 2029:0.3, 2030:0.7,
            2031:1.0, 2032:1.1, 2033:1.0, 2034:0.9, 2035:1.0, 2036:1.0}
    # バブル崩壊の年を ±1 でずらす
    shift = rng.choice([-1, 0, 0, 1])
    senti, funding = {}, {}
    for y in YEARS:
        yy = min(2036, max(2026, y + shift))
        senti[y] = base[yy] * rng.lognormvariate(0, 0.12)
        funding[y] = fund[yy] * rng.lognormvariate(0, 0.15)
    return senti, funding

def draw_trial_params(rng):
    """私の『不確実性』を正直に表現: 各社の主要パラメータを毎試行 分布から引く。
    点推定が当たる保証はない → 事前の幅を確率的に反映する。"""
    TP = {}
    for c, p in PARAMS.items():
        TP[c] = dict(p)  # copy
        TP[c]["cagr"] = max(0.1, rng.gauss(p["cagr"], 0.18))          # 成長率の不確実性
        center = (p["mult_lo"] + p["mult_hi"]) / 2
        spread = (p["mult_hi"] - p["mult_lo"]) / 2
        cm = max(3.0, rng.gauss(center, spread * 0.9))                # 倍率の中心自体が不確実
        TP[c]["mult_lo"], TP[c]["mult_hi"] = cm * 0.8, cm * 1.2
        TP[c]["inc_pressure"] = max(0.0, rng.gauss(p["inc_pressure"], 0.07))  # 巨人の圧力も不確実
        TP[c]["reg_cap"] = min(1.0, max(0.4, rng.gauss(p["reg_cap"], 0.12)))  # 規制天井も不確実
    return TP

def run_trial(rng):
    P = draw_trial_params(rng)
    # 初期現金 = おおよそ1.2〜2.2年分のランウェイ(小規模社ほど薄い)
    state = {c: dict(scale=P[c]["scale0"], cash=P[c]["burn0"] * rng.uniform(1.2, 2.2),
                     moat=P[c]["moat0"], alive=True, independent=True, acq_value=0.0) for c in P}
    senti, funding = macro_path(rng)

    for i, y in enumerate(YEARS[:-1]):  # transitions
        # --- ショック抽選(この年・この試行) ---
        shocks = {k: (rng.random() < h) for k, h in SHOCK_HAZARD.items()}
        # 市場成熟による成長逓減係数
        decay = max(0.25, 1.0 - 0.07 * i)

        for c, p in P.items():
            s = state[c]
            if not s["alive"]:
                continue
            # --- 成長率の組み立て ---
            g = p["cagr"] * decay
            # 既存巨人の圧力は中盤(>=2029)から効く
            if y >= 2029:
                g -= p["inc_pressure"] * (1 - 0.5 * s["moat"])  # 堀が圧力を半減
            # ショックの影響(堀が逆風を緩和、追風はそのまま)
            for key, sk in [("ai_finance","s_ai_finance"),("semi","s_semi"),
                            ("edu","s_edu"),("grid","s_grid"),("robot","s_robot"),
                            ("verifiable","s_verifiable")]:
                if shocks[key]:
                    eff = p[sk]
                    if eff < 0:
                        eff *= (1 - 0.6 * s["moat"])  # 堀が逆風を最大6割緩和
                    g += eff
            # robotショックは安全堀が高ければ追風に反転(Synapseの安全実績)
            if shocks["robot"] and c == "Synapse" and s["moat"] > 0.6:
                g += 0.30
            # ノイズ
            g = g * rng.lognormvariate(0, p["vol"]) - (rng.random() < 0.03) * 0.5  # 稀に大失策
            g = max(-0.6, g)

            new_scale = s["scale"] * (1 + g)
            new_scale = max(0.0005, new_scale)

            # --- 現金繰り ---
            margin = p["margin_cap"] * min(1.0, i / 5.0)  # 年とともに黒字化
            burn = max(0.0, p["burn0"] * max(0.0, 1 - i / 6.0)) + new_scale * 0.25 * decay  # 成長投資込み
            fcf = new_scale * margin - burn
            # 資金調達: 環境が許し(funding>0.55)、成長していて、ランウェイが薄い時のみ。
            # 早期はストーリーで(burn基準)、後期は規模で(scale基準)調達できる。
            raise_amt = 0.0
            target_runway = 2.0 * burn
            if funding[y] > 0.55 and g > 0.0 and s["cash"] < target_runway:
                capacity = max(new_scale, burn) * 1.5 * funding[y] * rng.uniform(0.5, 1.3)
                raise_amt = capacity
            s["cash"] += fcf + raise_amt
            s["scale"] = new_scale
            s["moat"] = min(0.95, s["moat"] + p["moat_gain"] * (0.5 + 0.5 * (g > 0)))

            # --- 現金危機の判定 ---
            if s["cash"] < 0:
                # 評価額(被買収価値)
                mult = rng.uniform(p["mult_lo"], p["mult_hi"]) * senti[y] * p["reg_cap"]
                val = new_scale * mult
                # 堀と評価が高いほど「消滅」でなく「被買収」になりやすい
                attractiveness = 0.5 * s["moat"] + min(0.5, val / 10.0)
                if rng.random() < attractiveness:
                    s["independent"] = False
                    s["acq_value"] = val * rng.uniform(0.8, 1.3)  # 買収プレミアム
                    s["cash"] = 0.0  # 親会社が補填(生存はするが独立喪失)
                else:
                    s["alive"] = False

    # --- 2036年 最終評価 ---
    results = {}
    for c, p in P.items():
        s = state[c]
        if not s["alive"]:
            results[c] = dict(status="dead", val=0.0, scale=0.0, independent=False)
        else:
            mult = rng.uniform(p["mult_lo"], p["mult_hi"]) * senti[2036] * p["reg_cap"]
            val = s["scale"] * mult if s["independent"] else max(s["acq_value"], s["scale"] * mult)
            status = "independent" if s["independent"] else "acquired"
            results[c] = dict(status=status, val=val, scale=s["scale"], independent=s["independent"])
    return results

# ----------------------------------------------------------------------
def main():
    rng = random.Random(SEED)
    agg = {c: dict(vals=[], scales=[], dead=0, acquired=0, independent=0,
                   wins=0, indep_wins=0) for c in PARAMS}
    musk_beat = 0

    for _ in range(N_TRIALS):
        res = run_trial(rng)
        # 勝者 = 生存社の中で評価額最大
        alive = {c: r for c, r in res.items() if r["status"] != "dead"}
        winner = max(alive, key=lambda c: alive[c]["val"]) if alive else None
        indep = {c: r for c, r in res.items() if r["status"] == "independent"}
        indep_winner = max(indep, key=lambda c: indep[c]["val"]) if indep else None
        if winner:
            agg[winner]["wins"] += 1
        if indep_winner:
            agg[indep_winner]["indep_wins"] += 1
        if any(r["val"] > MUSK_THRESHOLD for r in alive.values()):
            musk_beat += 1
        for c, r in res.items():
            agg[c]["vals"].append(r["val"])
            agg[c]["scales"].append(r["scale"])
            agg[c][r["status"]] += 1

    def pct(x, q):
        x = sorted(x)
        k = (len(x) - 1) * q
        f = int(k)
        return x[f] + (x[min(f+1, len(x)-1)] - x[f]) * (k - f)

    print(f"\nモンテカルロ {N_TRIALS} 試行 (seed={SEED})  単位: 評価額$B / 売上$B")
    print("="*108)
    hdr = f"{'社':<10}{'勝率':>7}{'独立勝率':>9}{'生存率':>8}{'独立率':>8}{'被買収':>8}{'消滅':>7}{'評価額中央':>11}{'評価P10-P90':>16}{'売上中央':>9}"
    print(hdr); print("-"*108)
    order = sorted(PARAMS, key=lambda c: -agg[c]["wins"])
    for c in order:
        a = agg[c]
        win = a["wins"]/N_TRIALS; iwin = a["indep_wins"]/N_TRIALS
        surv = (a["independent"]+a["acquired"])/N_TRIALS
        ind = a["independent"]/N_TRIALS; acq = a["acquired"]/N_TRIALS; dead = a["dead"]/N_TRIALS
        vmed = statistics.median(a["vals"]); vlo = pct(a["vals"],0.10); vhi = pct(a["vals"],0.90)
        smed = statistics.median(a["scales"])
        print(f"{c:<10}{win*100:>6.1f}%{iwin*100:>8.1f}%{surv*100:>7.1f}%{ind*100:>7.1f}%{acq*100:>7.1f}%{dead*100:>6.1f}%"
              f"{vmed:>10.1f}{('  '+format(vlo,'.1f')+'-'+format(vhi,'.1f')):>16}{smed:>9.2f}")
    print("-"*108)
    print(f"いずれかの社が評価額 ${MUSK_THRESHOLD:.0f}B 超(=マスク超えproxy)に到達した試行: {musk_beat/N_TRIALS*100:.2f}%")
    print("="*108)

if __name__ == "__main__":
    main()


def compute_winprobs(n, seed):
    rng = random.Random(seed)
    wins = defaultdict(int); dead = defaultdict(int)
    for _ in range(n):
        res = run_trial(rng)
        alive = {c: r for c, r in res.items() if r["status"] != "dead"}
        if alive:
            w = max(alive, key=lambda c: alive[c]["val"]); wins[w] += 1
        for c, r in res.items():
            if r["status"] == "dead": dead[c] += 1
    return {c: wins[c]/n for c in PARAMS}, {c: dead[c]/n for c in PARAMS}
