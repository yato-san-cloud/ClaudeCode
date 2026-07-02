#!/usr/bin/env python3
"""ファイル命名規則リント(読み取り専用)。

docs/02_運用ルール_命名・版管理・正本.md の命名規則(N系・V-4)への
違反を検出して報告する。ファイルには一切触らない。

使い方:
    python3 name_lint.py <ディレクトリ>            # 再帰走査
    python3 name_lint.py --list names.txt          # ファイル名一覧(1行1件)を検査
    python3 name_lint.py --names "a_v1.md" "b.md"  # 直接指定

Driveのファイルはローカルに無いので、ファイル名一覧を貼り付けた
テキストを --list で渡す使い方が基本。
終了コード: 常に0(レポートツールであり、ゲートではない)。
"""

import argparse
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

# N-3: 鮮度を偽装しがちな禁止語(次版が出た瞬間に嘘になる)
FORBIDDEN_WORDS = ["最新", "final", "Final", "FINAL", "fix", "FIX", "確定版"]
# 検査対象外(一時ファイル・システムファイル)
SKIP_PATTERNS = [
    re.compile(r"^[._~]"),
    re.compile(r"\.(bak|tmp|lnk|ini|db)(\.|$)", re.IGNORECASE),
]
# 常設の生きた文書(版・日付を持たないことが正しい)
LIVING_DOC_STEMS = {"moc", "readme", "claude", "index", "plan"}
# 版トークン: v1 / v3_1 / Rev10 / P1〜P9(シナリオ)
VERSION_RE = re.compile(r"(?:^|[_\s（(])(v\d+(?:[._]\d+)?|Rev\d+)(?:[_\s.）)]|$)", re.IGNORECASE)
# 日付トークン: 260702 / 20260702 / 先頭0629形式
DATE_RE = re.compile(r"(?:^|[_\s（(])(20\d{6}|\d{6})(?:[_\s.）)]|$)")
DATE_PREFIX_RE = re.compile(r"^\d{4}_")


def should_skip(name: str) -> bool:
    return any(p.search(name) for p in SKIP_PATTERNS)


def base_key(stem: str) -> str:
    """版・日付トークンを除いた「系統」キー。版チェーンのグルーピング用。"""
    key = VERSION_RE.sub("_", stem)
    key = DATE_RE.sub("_", key)
    key = re.sub(r"[_\s]+", "_", key).strip("_")
    return unicodedata.normalize("NFKC", key).lower()


def lint_name(name: str) -> list[str]:
    issues = []
    stem = Path(name).stem
    if stem.lower() in LIVING_DOC_STEMS:
        return issues

    for word in FORBIDDEN_WORDS:
        if word in stem:
            issues.append(f"[N-3] 禁止語「{word}」を含む(最新の宣言はMOCの★で)")
            break

    if re.search(r"[ 　]", stem):
        issues.append("[N-4] 空白を含む(アンダースコア推奨)")

    has_version = bool(VERSION_RE.search(stem))
    has_date = bool(DATE_RE.search(stem)) or bool(DATE_PREFIX_RE.match(stem))
    if not has_version and not has_date:
        issues.append("[N-1/N-2] 日付(YYMMDD)も版(vN/RevN)も無い(どちらかを推奨)")

    return issues


def collect_names(args) -> list[str]:
    if args.list:
        text = Path(args.list).read_text(encoding="utf-8")
        return [line.strip() for line in text.splitlines() if line.strip()]
    if args.names:
        return args.names
    if args.directory:
        root = Path(args.directory)
        if not root.is_dir():
            sys.exit(f"ディレクトリが見つかりません: {root}")
        return [str(p.relative_to(root)) for p in sorted(root.rglob("*")) if p.is_file()]
    sys.exit("入力がありません。ディレクトリ、--list、--names のいずれかを指定してください。")


def main() -> None:
    ap = argparse.ArgumentParser(description="ファイル命名規則リント(読み取り専用)")
    ap.add_argument("directory", nargs="?", help="走査するディレクトリ")
    ap.add_argument("--list", help="ファイル名一覧テキスト(1行1件)")
    ap.add_argument("--names", nargs="+", help="ファイル名を直接指定")
    args = ap.parse_args()

    names = [n for n in collect_names(args) if not should_skip(Path(n).name)]
    if not names:
        print("検査対象がありません。")
        return

    total_issues = 0
    chains: dict[str, list[str]] = defaultdict(list)

    print(f"=== 命名規則リント: {len(names)}件 ===\n")
    for name in names:
        fname = Path(name).name
        issues = lint_name(fname)
        stem = Path(fname).stem
        if VERSION_RE.search(stem):
            chains[base_key(stem)].append(name)
        if issues:
            total_issues += len(issues)
            print(f"⚠ {name}")
            for issue in issues:
                print(f"    {issue}")

    multi = {k: v for k, v in chains.items() if len(v) >= 3}
    if multi:
        print("\n=== [V-4] 3版以上が同居する系統(アーカイブ候補の確認を) ===")
        for key, files in sorted(multi.items()):
            print(f"  系統: {key} ({len(files)}版)")
            for f in sorted(files):
                print(f"    - {f}")

    print(f"\n検出: 名前の問題 {total_issues}件 / 多版同居 {len(multi)}系統")
    print("※本ツールは報告のみ。リネーム・移動・削除は行いません(遡及リネームは非推奨: docs/02参照)。")


if __name__ == "__main__":
    main()
