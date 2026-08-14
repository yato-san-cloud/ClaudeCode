#!/usr/bin/env python3
"""路線便タリフ計算エンジン PoC。

使い方:
    python3 tariff_calc.py --from 東京 --to 大阪 --weight 80 --volume 0.4
    python3 tariff_calc.py --from 埼玉 --to 福岡 --weight 450 --timed

data/ 配下のCSVを読み、登録済み運送会社ごとに
  課金重量 = max(実重量, 容積重量) の決定
  → 地帯区分の表引き → 重量帯の表引き → 割引・割増・サーチャージ
を計算して、安い順に並べる。

計算順序・端数処理は仮置き（割引後運賃にサーチャージを乗せ、10円未満切り上げ、
最低運賃でフロア）。実契約では会社ごとに流儀が違うため、請求書と突合して
CONTRACTS のルールを合わせ込むこと。
"""

import argparse
import csv
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def load_masters():
    zones = {}  # (carrier, pref) -> zone
    with open(os.path.join(DATA, "zones.csv"), encoding="utf-8") as f:
        for row in csv.DictReader(f):
            zones[(row["carrier"], row["prefecture"])] = row["zone"]

    tariff = {}  # (carrier, from_zone, to_zone) -> [(max_kg, fare), ...] 昇順
    with open(os.path.join(DATA, "tariff.csv"), encoding="utf-8") as f:
        for row in csv.DictReader(f):
            key = (row["carrier"], row["from_zone"], row["to_zone"])
            tariff.setdefault(key, []).append((int(row["max_kg"]), int(row["fare"])))
    for bands in tariff.values():
        bands.sort()

    contracts = {}  # carrier -> dict
    with open(os.path.join(DATA, "contracts.csv"), encoding="utf-8") as f:
        for row in csv.DictReader(f):
            contracts[row["carrier"]] = {
                "discount_rate": float(row["discount_rate"]),
                "volume_kg_per_m3": float(row["volume_kg_per_m3"]),
                "fuel_surcharge_rate": float(row["fuel_surcharge_rate"]),
                "min_fare": int(row["min_fare"]),
                "timed_delivery_fee": int(row["timed_delivery_fee"]),
            }
    return zones, tariff, contracts


def ceil10(x):
    return int(math.ceil(x / 10.0)) * 10


def quote(carrier, c, zones, tariff, from_pref, to_pref, weight, volume, timed):
    """1社分の見積り。対象外・帯域外は reason 付きで None 運賃を返す。"""
    fz = zones.get((carrier, from_pref))
    tz = zones.get((carrier, to_pref))
    if fz is None or tz is None:
        return {"carrier": carrier, "total": None, "reason": "地帯対象外（要個別見積り）"}

    vol_kg = math.ceil(volume * c["volume_kg_per_m3"]) if volume else 0
    chargeable = max(weight, vol_kg)
    basis = "容積" if vol_kg > weight else "実重量"

    bands = tariff.get((carrier, fz, tz), [])
    band = next(((mk, fare) for mk, fare in bands if chargeable <= mk), None)
    if band is None:
        return {"carrier": carrier, "total": None,
                "reason": f"重量帯超過 {chargeable}kg（貸切見積りへ）"}
    max_kg, list_fare = band

    discounted = list_fare * (1 - c["discount_rate"])
    timed_fee = c["timed_delivery_fee"] if timed else 0
    surcharge = (discounted + timed_fee) * c["fuel_surcharge_rate"]
    total = max(ceil10(discounted + timed_fee + surcharge), c["min_fare"])

    return {
        "carrier": carrier,
        "lane": f"{fz}→{tz}",
        "chargeable": chargeable,
        "basis": basis,
        "band": max_kg,
        "list_fare": list_fare,
        "discounted": int(discounted),
        "timed_fee": timed_fee,
        "surcharge": int(surcharge),
        "total": total,
        "reason": "",
    }


def main():
    ap = argparse.ArgumentParser(description="路線便タリフ計算PoC（ダミータリフ）")
    ap.add_argument("--from", dest="from_pref", required=True, help="発地の都道府県（例: 東京）")
    ap.add_argument("--to", dest="to_pref", required=True, help="着地の都道府県（例: 大阪）")
    ap.add_argument("--weight", type=float, required=True, help="実重量 kg")
    ap.add_argument("--volume", type=float, default=0.0, help="容積 m3")
    ap.add_argument("--timed", action="store_true", help="時間指定あり")
    args = ap.parse_args()

    zones, tariff, contracts = load_masters()
    results = [
        quote(carrier, c, zones, tariff,
              args.from_pref, args.to_pref, args.weight, args.volume, args.timed)
        for carrier, c in contracts.items()
    ]
    results.sort(key=lambda r: (r["total"] is None, r["total"] or 0))

    cond = f"{args.from_pref}→{args.to_pref} 実重量{args.weight:g}kg"
    if args.volume:
        cond += f" 容積{args.volume:g}m3"
    if args.timed:
        cond += " 時間指定"
    print(f"■ {cond}")
    for i, r in enumerate(results):
        mark = "★" if i == 0 and r["total"] is not None else " "
        if r["total"] is None:
            print(f" {mark} {r['carrier']}: ― {r['reason']}")
            continue
        print(
            f" {mark} {r['carrier']}: {r['total']:,}円"
            f"  [{r['lane']} / 課金{r['chargeable']:g}kg({r['basis']}) / 〜{r['band']}kg帯]"
            f"  定価{r['list_fare']:,} → 割引後{r['discounted']:,}"
            + (f" +時間指定{r['timed_fee']}" if r["timed_fee"] else "")
            + f" +燃調{r['surcharge']:,}"
        )


if __name__ == "__main__":
    main()
