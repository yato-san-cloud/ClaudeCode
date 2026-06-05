#!/usr/bin/env python3
"""感度分析: 主要パラメータを動かしたとき勝率がどう変わるかを定量化。
『Synapseが勝つ』という結論が前提にどれだけ依存して脆いかを暴く。"""
import copy
import market_sim as M

N = 4000
SEED = 7
companies = list(M.PARAMS)
BASE = copy.deepcopy(M.PARAMS)

def scenario(name, mutate):
    M.PARAMS = copy.deepcopy(BASE)
    mutate(M.PARAMS)
    win, dead = M.compute_winprobs(N, SEED)
    return name, win

scenarios = []
scenarios.append(scenario("①ベースライン(私の素の前提)", lambda P: None))

def s2(P):  # ロボOSの倍率が並(=コモディティ化。CEO自身が恐れたシナリオ)
    P["Synapse"]["mult_lo"], P["Synapse"]["mult_hi"] = 8, 12
scenarios.append(scenario("②Synapse倍率を並に(20→10倍級)", s2))

def s3(P):  # NVIDIA/Tesla/中国がSynapseをOSごと飲み込む
    P["Synapse"]["inc_pressure"] = 0.30
scenarios.append(scenario("③Synapseへの巨人圧力 強(0.16→0.30)", s3))

def s4(P):  # GridMindが公益事業化を回避(電力支配のまま高倍率)
    P["GridMind"]["reg_cap"] = 0.95
    P["GridMind"]["mult_lo"], P["GridMind"]["mult_hi"] = 10, 16
scenarios.append(scenario("④GridMindが公益化を回避(電力帝国化)", s4))

def s5(P):  # 自律金融が早期承認、Heliosが一気に伸びる
    P["Helios"]["cagr"] = 0.70
    P["Helios"]["reg_cap"] = 0.90
scenarios.append(scenario("⑤Helios追風(自律金融早期承認)", s5))

def s6(P):  # 全社の倍率を同一(10倍)に。Synapseの勝ちが倍率ゲタだけだったか検証
    for c in P:
        P[c]["mult_lo"], P[c]["mult_hi"] = 8, 12
scenarios.append(scenario("⑥全社の倍率を同一化(10倍級)", s6))

# 出力
M.PARAMS = BASE
print(f"\n感度分析: 各シナリオの勝率(%)  N={N}/シナリオ  seed={SEED}")
print("="*100)
print(f"{'シナリオ':<34}" + "".join(f"{c:>11}" for c in companies))
print("-"*100)
for name, win in scenarios:
    print(f"{name:<34}" + "".join(f"{win[c]*100:>10.1f}%" for c in companies))
print("="*100)
print("読み方: ①と②③⑥を比べると、Synapseの勝率が『倍率と巨人圧力の前提』に強く依存していることが分かる。")
