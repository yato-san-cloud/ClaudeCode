#!/usr/bin/env python3
"""数字整合監査(候補16)。読み取り専用のレポートツール。

numbers.json(単一数字ソース)を正とし、md/html文書中の
`<!-- num:キー名 -->` アノテーションの直後(同じ行 or 次の行)にある数値を
パースして突合する。設計は docs/03_数字整合監査_設計.md を参照。

一方通行原則: numbers.jsonが上流、文書は下流。本ツールはズレの「検出」までで、
どちらが正しいか・どう直すかは常に人間が判断する(運用ルールM-5)。

判定5種:
    ✅ 一致       … アノテーションの値とJSONの値が一致
    ❌ 不一致     … アノテーションはあるが値が違う(両方の値を表示)
    ⚠️ 未登録キー … アノテーションのキーがJSONに無い
    🛑 スキーマ不備 … JSON側にキーはあるが `value` 等の必須項目が欠けている/
                    数値として解釈できない(numbers.jsonの手動転記ミス。要修正はJSON側)
    📋 未登場     … JSONにあるが、走査対象のどの文書にもアノテーションで
                    登場しない(参考情報。文書化を忘れているだけの場合もある)

numbers.jsonは人間がxlsxから手動転記する運用のため、構文的には正しいJSONでも
`value`欠落等のスキーマ違反が起こり得る。そのようなキーは監査対象から除外しつつ
🛑として報告する(例外を投げて異常終了することはない。読み取り専用ツールとして、
どんな入力に対しても終了コード0でレポートを返し切ることを優先する)。

--grep: アノテーションが無い箇所でも、JSONの値がテキストとして生一致する
        箇所を検索し、「アノテーション追加候補」として提案する。

使い方:
    python3 numbers_check.py numbers.json 文書1.md 文書2.html ...
    python3 numbers_check.py numbers.json 文書1.md --grep

制約:
    - 標準ライブラリのみ。読み取り専用(入力ファイルを一切変更しない)
    - 終了コードは常に0(レポートツールであり、ゲートではない)
    - 対象はテキストとして開けるmd/htmlのみ。pptx・xlsxの内部は対象外
      (docs/03の「限界」節を参照。PPTを監査したい場合は転記元mdを経由させる運用とする)
"""

from __future__ import annotations

import argparse
import difflib
import json
import math
import re
import sys
import unicodedata
from pathlib import Path
from typing import Optional

ANNOTATION_RE = re.compile(r"<!--\s*num:([A-Za-z0-9_]+)\s*-->")

# 数値本体: 全角→半角はNFKCで事前正規化してから適用する。
# ▲ は財務資料でよく使われる負号(△ではなく▲のみを対象とする、と仕様で明示)。
NUMBER_RE = re.compile(
    r"(?P<sign>▲|-)?"
    r"(?P<num>[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)"
)
# 数値直後の単位トークン(空白・タグ開始・改行までの短い連続文字)
UNIT_RE = re.compile(r"[^\s<>\d,.\-▲]{0,8}")


def load_numbers(path: Path) -> tuple[dict, dict]:
    """numbers.jsonを読み込む。

    構文的には正しいJSONでも、`value`が欠けている・数値として解釈できない等
    スキーマ違反のレコードがあり得る(人間がxlsxから手動転記する運用のため)。
    そうしたレコードは`numbers`には含めず、`invalid`(key→理由)に振り分けて
    呼び出し側で🛑スキーマ不備として報告できるようにする。ここで例外を投げて
    落ちることはしない。
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    numbers: dict = {}
    invalid: dict = {}
    for idx, item in enumerate(data.get("numbers", []), start=1):
        if not isinstance(item, dict):
            invalid[f"(不正レコード#{idx})"] = f"オブジェクトではありません: {type(item).__name__}"
            continue
        key = item.get("key")
        if not key:
            invalid[f"(キー欠落#{idx})"] = "keyが欠落または空です(label: %s)" % item.get("label", "不明")
            continue
        if "value" not in item:
            invalid[key] = "valueキーが欠落しています"
            continue
        raw_value = item["value"]
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            invalid[key] = f"valueを数値として解釈できません: {raw_value!r}"
            continue
        # json.loadsはNaN/Infinityを黙って受理するため、有限数のみを監査対象にする
        if not math.isfinite(value):
            invalid[key] = f"valueが有限の数値ではありません: {raw_value!r}"
            continue
        entry = dict(item)
        entry["value"] = value
        numbers[key] = entry
    return numbers, invalid


def format_value(value: float, unit: str) -> str:
    sign = "▲" if value < 0 else ""
    absval = abs(value)
    if float(absval).is_integer():
        num_str = format(int(absval), ",")
    else:
        num_str = format(absval, ",")
    return f"{sign}{num_str}{unit or ''}"


def parse_number(text: str) -> Optional[tuple[float, str, str]]:
    """textの中から最初の数値+単位を拾う。見つからなければNone。
    戻り値: (数値, 単位文字列, マッチした生テキスト)
    """
    normalized = unicodedata.normalize("NFKC", text)
    m = NUMBER_RE.search(normalized)
    if not m:
        return None
    raw_num = m.group("num").replace(",", "")
    try:
        value = float(raw_num)
    except ValueError:
        return None
    if m.group("sign"):
        value = -value
    unit_m = UNIT_RE.match(normalized[m.end():])
    unit = unit_m.group(0) if unit_m else ""
    return value, unit, m.group(0) + unit


def values_match(doc_value: float, json_value: float) -> bool:
    return abs(doc_value - json_value) < 1e-6


def scan_document(
    path: Path, numbers: dict, invalid: Optional[dict] = None
) -> tuple[list[dict], set[str]]:
    """1文書を走査し、アノテーション照合結果のリストと、登場したキー集合を返す。"""
    invalid = invalid or {}
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    results = []
    seen_keys: set[str] = set()

    for lineno, line in enumerate(lines, start=1):
        for m in ANNOTATION_RE.finditer(line):
            key = m.group(1)
            seen_keys.add(key)
            after = line[m.end():]
            found = parse_number(after)
            matched_line = lineno
            if found is None and lineno < len(lines):
                found = parse_number(lines[lineno])  # lines[lineno] == 次行(0始まりのため)
                matched_line = lineno + 1

            if key in invalid:
                results.append({
                    "status": "invalid_entry",
                    "key": key,
                    "line": lineno,
                    "reason": invalid[key],
                })
                continue

            if key not in numbers:
                candidates = difflib.get_close_matches(key, numbers.keys(), n=1)
                results.append({
                    "status": "unknown_key",
                    "key": key,
                    "line": lineno,
                    "candidate": candidates[0] if candidates else None,
                })
                continue

            entry = numbers[key]
            json_value = entry["value"]
            json_unit = entry.get("unit", "")

            if found is None:
                results.append({
                    "status": "no_number_found",
                    "key": key,
                    "line": lineno,
                    "json_repr": format_value(json_value, json_unit),
                })
                continue

            doc_value, doc_unit, doc_raw = found
            if values_match(doc_value, json_value):
                results.append({
                    "status": "match",
                    "key": key,
                    "line": matched_line,
                    "label": entry.get("label", ""),
                    "doc_repr": doc_raw,
                    "json_repr": format_value(json_value, json_unit),
                })
            else:
                results.append({
                    "status": "mismatch",
                    "key": key,
                    "line": matched_line,
                    "label": entry.get("label", ""),
                    "doc_repr": doc_raw,
                    "json_repr": format_value(json_value, json_unit),
                })
    return results, seen_keys


def grep_candidates(path: Path, numbers: dict, seen_keys: set[str]) -> list[dict]:
    """アノテーション未使用のキーについて、JSONの値の生一致箇所を探す。"""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    found = []
    for key, entry in numbers.items():
        if key in seen_keys:
            continue
        value = entry["value"]
        unit = entry.get("unit", "")
        candidates = set()
        if float(value).is_integer():
            candidates.add(format(int(abs(value)), ","))
            candidates.add(str(int(abs(value))))
        else:
            candidates.add(format(abs(value), ","))
            candidates.add(str(abs(value)))
        for lineno, line in enumerate(lines, start=1):
            normalized = unicodedata.normalize("NFKC", line)
            if ANNOTATION_RE.search(line) and key in [
                mm.group(1) for mm in ANNOTATION_RE.finditer(line)
            ]:
                continue  # 既にアノテーション済みの行はgrep候補から除く
            for cand in candidates:
                if cand and cand in normalized:
                    found.append({
                        "key": key,
                        "label": entry.get("label", ""),
                        "line": lineno,
                        "matched": cand,
                        "unit": unit,
                    })
                    break
    return found


def main() -> None:
    ap = argparse.ArgumentParser(
        description="数字整合監査(読み取り専用)。numbers.jsonと文書中のアノテーションを突合する。"
    )
    ap.add_argument("numbers_json", help="numbers.json(または numbers.example.json)のパス")
    ap.add_argument("documents", nargs="+", help="走査対象のmd/htmlファイル(複数可)")
    ap.add_argument(
        "--grep", action="store_true",
        help="アノテーション未使用のJSON値について、生一致する箇所を追加提案する",
    )
    args = ap.parse_args()

    json_path = Path(args.numbers_json)
    if not json_path.is_file():
        print(f"numbers.jsonが見つかりません: {json_path}")
        sys.exit(0)

    try:
        numbers, invalid = load_numbers(json_path)
    except (json.JSONDecodeError, OSError) as e:
        print(f"numbers.jsonの読み込みに失敗しました: {e}")
        sys.exit(0)

    all_seen_keys: set[str] = set()
    counts = {
        "match": 0, "mismatch": 0, "unknown_key": 0,
        "no_number_found": 0, "invalid_entry": 0,
    }

    print(f"=== 数字整合監査: 文書{len(args.documents)}件 / JSON登録{len(numbers)}キー ===")
    print(f"JSONソース: {json_path}")
    print("※本ツールは報告のみ。文書・JSONの書き換えは行いません。")
    print(
        "※食い違いを見つけても、どちらが正しいかは判断しません"
        "(一方通行原則・運用ルールM-5: 疑うときはまずxlsxを確認)。\n"
    )

    if invalid:
        print("=== 🛑 numbers.json側のスキーマ不備(監査対象から除外) ===")
        for k, reason in invalid.items():
            print(f"  - {k}: {reason}")
        print("  → numbers.jsonの該当レコードを人間が修正してください。\n")

    doc_seen_map: dict[str, set[str]] = {}

    for doc_str in args.documents:
        doc_path = Path(doc_str)
        print(f"--- {doc_str} ---")
        if not doc_path.is_file():
            print("  (ファイルが見つかりません。スキップ)")
            continue
        try:
            results, seen_keys = scan_document(doc_path, numbers, invalid)
        except OSError as e:
            print(f"  (読み込みエラー: {e})")
            continue

        all_seen_keys |= seen_keys
        doc_seen_map[doc_str] = seen_keys

        if not results:
            print("  アノテーションは見つかりませんでした。")
        for r in results:
            if r["status"] == "match":
                counts["match"] += 1
                print(
                    f"  ✅ 一致 {r['key']} ({r['label']}): "
                    f"文書={r['doc_repr']} / JSON={r['json_repr']} (L{r['line']})"
                )
            elif r["status"] == "mismatch":
                counts["mismatch"] += 1
                print(
                    f"  ❌ 不一致 {r['key']} ({r['label']}): "
                    f"文書={r['doc_repr']} / JSON={r['json_repr']} (L{r['line']})"
                )
            elif r["status"] == "unknown_key":
                counts["unknown_key"] += 1
                hint = f" (タイプミス候補: {r['candidate']})" if r["candidate"] else ""
                print(
                    f"  ⚠️ 未登録キー {r['key']}: JSONに存在しません{hint} (L{r['line']})"
                )
            elif r["status"] == "no_number_found":
                counts["no_number_found"] += 1
                print(
                    f"  ⚠️ 数値未検出 {r['key']}: アノテーション直後に数値が見つかりません"
                    f" (JSON側の値: {r['json_repr']}) (L{r['line']})"
                )
            elif r["status"] == "invalid_entry":
                counts["invalid_entry"] += 1
                print(
                    f"  🛑 スキーマ不備 {r['key']}: numbers.json側の理由={r['reason']}"
                    f" (L{r['line']})"
                )

        if args.grep:
            candidates = grep_candidates(doc_path, numbers, seen_keys)
            if candidates:
                print("  --- --grep: アノテーション追加候補 ---")
                for c in candidates:
                    print(
                        f"  📎 {c['key']} ({c['label']}) の値「{c['matched']}{c['unit']}」"
                        f"の生一致を検出 (L{c['line']})。"
                        f"追加候補: <!-- num:{c['key']} -->"
                    )
        print()

    unregistered = [k for k in numbers if k not in all_seen_keys]
    if unregistered:
        print("=== 📋 JSONにあるが、走査した文書に未登場のキー(参考情報) ===")
        for k in unregistered:
            entry = numbers[k]
            print(
                f"  - {k} ({entry.get('label', '')}): "
                f"JSON値={format_value(entry['value'], entry.get('unit', ''))}"
            )
        print()

    print("=== サマリ ===")
    print(
        f"✅一致: {counts['match']} / ❌不一致: {counts['mismatch']} / "
        f"⚠️未登録キー: {counts['unknown_key']} / "
        f"📋未登場: {len(unregistered)} / 🛑スキーマ不備: {len(invalid)} / "
        f"(数値未検出: {counts['no_number_found']})"
    )
    if counts["mismatch"]:
        print("→ ❌不一致あり。まずxlsx(一次データ)とnumbers.jsonのどちらが最新かを確認してから、"
              "人間が該当文書を修正してください(一方通行原則・M-5)。")


if __name__ == "__main__":
    main()
