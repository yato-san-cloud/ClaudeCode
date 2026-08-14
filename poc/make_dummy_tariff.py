#!/usr/bin/env python3
"""ダミータリフ生成スクリプト。

架空の路線便3社（A運輸・B急便・C物流）の地帯区分表とタリフ表をCSVで生成する。
運賃額は完全に架空。実運用ではこのスクリプトごと捨てて、
契約タリフを同じスキーマのCSVに起こして差し替える。
"""

import csv
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

# 地方 → 都道府県
REGIONS = {
    "北海道": ["北海道"],
    "東北": ["青森", "岩手", "宮城", "秋田", "山形", "福島"],
    "北関東": ["茨城", "栃木", "群馬"],
    "南関東": ["埼玉", "千葉", "東京", "神奈川"],
    "中部": ["新潟", "富山", "石川", "福井", "山梨", "長野", "岐阜", "静岡", "愛知", "三重"],
    "関西": ["滋賀", "京都", "大阪", "兵庫", "奈良", "和歌山"],
    "中四国": ["鳥取", "島根", "岡山", "広島", "山口", "徳島", "香川", "愛媛", "高知"],
    "九州": ["福岡", "佐賀", "長崎", "熊本", "大分", "宮崎", "鹿児島"],
    # 沖縄は3社とも路線網対象外（要個別見積り）という設定
}

# 各社の地帯定義：地帯名 → (構成地方リスト, 距離計算用の座標)
# 会社ごとに地帯の切り方が違う、という路線便の実態を模している
CARRIER_ZONES = {
    "A運輸": {
        "北海道": (["北海道"], 0.0),
        "東北": (["東北"], 1.0),
        "関東": (["北関東", "南関東"], 2.0),
        "中部": (["中部"], 3.0),
        "関西": (["関西"], 4.0),
        "中四国": (["中四国"], 5.0),
        "九州": (["九州"], 6.0),
    },
    "B急便": {
        "北海道": (["北海道"], 0.0),
        "東北": (["東北"], 1.0),
        "北関東": (["北関東"], 1.8),
        "南関東": (["南関東"], 2.2),
        "中部": (["中部"], 3.0),
        "関西": (["関西"], 4.0),
        "中四国": (["中四国"], 5.0),
        "九州": (["九州"], 6.0),
    },
    "C物流": {
        "東日本": (["北海道", "東北"], 0.7),
        "関東": (["北関東", "南関東"], 2.0),
        "中部": (["中部"], 3.0),
        "西日本": (["関西", "中四国"], 4.5),
        "九州": (["九州"], 6.0),
    },
}

# 会社ごとの運賃カーブ（lane_base = b0 + k * 地帯間距離）
CARRIER_CURVE = {
    "A運輸": (1400, 700),
    "B急便": (1300, 760),
    "C物流": (1550, 640),
}

# 重量帯（上限kg）と倍率：帯が上がるほどkg単価が下がる特積みの一般的な形
WEIGHT_BANDS = [
    (30, 1.0),
    (50, 1.3),
    (100, 1.9),
    (150, 2.4),
    (200, 2.8),
    (300, 3.6),
    (500, 5.0),
    (1000, 8.0),
    (1500, 10.5),
    (2000, 12.5),
]


def round10(x):
    return int(round(x / 10.0)) * 10


def main():
    os.makedirs(DATA, exist_ok=True)

    with open(os.path.join(DATA, "zones.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["carrier", "prefecture", "zone"])
        for carrier, zones in CARRIER_ZONES.items():
            for zone, (regions, _idx) in zones.items():
                for region in regions:
                    for pref in REGIONS[region]:
                        w.writerow([carrier, pref, zone])

    with open(os.path.join(DATA, "tariff.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["carrier", "from_zone", "to_zone", "max_kg", "fare"])
        for carrier, zones in CARRIER_ZONES.items():
            b0, k = CARRIER_CURVE[carrier]
            for fz, (_, fi) in zones.items():
                for tz, (_, ti) in zones.items():
                    lane_base = b0 + k * abs(fi - ti)
                    for max_kg, mult in WEIGHT_BANDS:
                        w.writerow([carrier, fz, tz, max_kg, round10(lane_base * mult)])

    with open(os.path.join(DATA, "contracts.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([
            "carrier", "discount_rate", "volume_kg_per_m3",
            "fuel_surcharge_rate", "min_fare", "timed_delivery_fee",
        ])
        w.writerow(["A運輸", 0.45, 280, 0.08, 1000, 500])
        w.writerow(["B急便", 0.40, 270, 0.07, 900, 800])
        w.writerow(["C物流", 0.50, 300, 0.09, 1100, 0])

    print("generated:", ", ".join(["zones.csv", "tariff.csv", "contracts.csv"]))


if __name__ == "__main__":
    main()
