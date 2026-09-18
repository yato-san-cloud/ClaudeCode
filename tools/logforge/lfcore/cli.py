"""Command line interface: convert / synth / validate."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .convert import convert_to_dir
from .mapping import MappingError
from .tables import InputError
from .validate import validate_dir


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="logforge",
        description="WMS実績 (Excel/CSV) → WHSIM_CONTRACTS v1.0 の orders.json / "
        "events.jsonl / calibration.json",
    )
    parser.add_argument("--version", action="version", version=f"log-forge {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    convert_cmd = sub.add_parser("convert", help="実績表を契約準拠の入力群に変換する")
    convert_cmd.add_argument("input", help="入力の Excel/CSV")
    convert_cmd.add_argument("--mapping", "-m", required=True, help="mapping.yaml")
    convert_cmd.add_argument("-o", "--outdir", required=True, help="出力ディレクトリ")
    convert_cmd.add_argument(
        "--created-at",
        default=None,
        help="meta.json の created_at を固定する (省略時は現在時刻。出力の他ファイルは"
        "時刻を含まないので、これを固定すると全出力がバイト再現可能)",
    )
    convert_cmd.add_argument("--quiet", action="store_true", help="サマリを表示しない")

    synth_cmd = sub.add_parser("synth", help="合成サンプル (既知の真値) を生成する")
    synth_cmd.add_argument("-o", "--outdir", required=True)
    synth_cmd.add_argument("--rows", type=int, default=1200)
    synth_cmd.add_argument("--seed", type=int, default=20250701)
    synth_cmd.add_argument("--dirty", action="store_true", help="不正行を混入した版も作る")

    validate_cmd = sub.add_parser("validate", help="出力ディレクトリを契約スキーマで検証する")
    validate_cmd.add_argument("outdir")
    return parser


def _run_convert(args: argparse.Namespace) -> int:
    try:
        result, written = convert_to_dir(
            args.input, args.mapping, args.outdir, created_at=args.created_at
        )
    except (MappingError, InputError, FileNotFoundError, KeyError, ValueError) as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        return 1

    problems = validate_dir(args.outdir)
    if not args.quiet:
        counts = result.meta["counts"]
        print(f"入力 {counts['rows_read']} 行 → 採用 {counts['rows_accepted']} 行 "
              f"/ 隔離 {counts['rows_read'] - counts['rows_accepted']} 行")
        print(f"orders.json      : {counts['orders']} 行")
        print(f"events.jsonl     : {counts['events']} 件 "
              f"{result.meta['events']['emitted_types']}")
        print(f"  復元不能なtype : {result.meta['events']['not_restorable']}")
        for name, series in sorted(result.calibration.items()):
            if isinstance(series, dict) and "dist" in series:
                print(f"calibration      : {name} = {series['dist']} {series['params']} "
                      f"(n={series['n']}, ks_p={series['ks_p']})")
        print(f"error_table.csv  : {counts['error_rows']} 行")
        for note in result.notes:
            print(f"  注記: {note}")
        print(f"t0               : {result.meta['t0']}")
        print(f"出力             : {Path(args.outdir).resolve()}")
        for name in sorted(written):
            print(f"  - {name}")

    if problems:
        print("契約スキーマ検証に失敗:", file=sys.stderr)
        for problem in problems[:20]:
            print(f"  - {problem}", file=sys.stderr)
        return 3
    if not args.quiet:
        print("契約スキーマ検証: OK")
    return 0


def _run_synth(args: argparse.Namespace) -> int:
    from .synth import generate

    files = generate(args.outdir, rows=args.rows, seed=args.seed, dirty=False)
    for name, path in files.items():
        print(f"{name:7s} {path}")
    if args.dirty:
        dirty_files = generate(args.outdir, rows=args.rows, seed=args.seed, dirty=True)
        for name, path in dirty_files.items():
            print(f"{name:7s} {path}")
    return 0


def _run_validate(args: argparse.Namespace) -> int:
    problems = validate_dir(args.outdir)
    if problems:
        for problem in problems:
            print(f"NG {problem}")
        return 3
    print("OK 契約スキーマ検証に合格")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "convert":
        return _run_convert(args)
    if args.command == "synth":
        return _run_synth(args)
    return _run_validate(args)
