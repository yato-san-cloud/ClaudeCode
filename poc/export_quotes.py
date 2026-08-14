#!/usr/bin/env python3
"""パリティテスト用：ケースJSONを読み、Python版エンジンの結果をJSONで出力する。

usage: python3 export_quotes.py cases.json > results.json
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tariff_calc import load_masters, quote  # noqa: E402


def main():
    cases = json.load(open(sys.argv[1], encoding="utf-8"))
    zones, tariff, contracts = load_masters()
    out = []
    for case in cases:
        row = {}
        for carrier, c in contracts.items():
            r = quote(carrier, c, zones, tariff,
                      case["from"], case["to"], case["weight"], case["volume"], case["timed"])
            row[carrier] = {
                "ok": r["total"] is not None,
                "total": r["total"],
                "band": r.get("band"),
                "chargeable": r.get("chargeable"),
            }
        out.append(row)
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
