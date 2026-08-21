"""cad2loc CLI.

    cad2loc input.dxf --config mapping.yaml -o layout.geojson

Exit codes: 0 = 成功 / 2 = 入力が扱えない（DWG・空図面・設定不備）/
3 = 契約検証に不合格（スキーマ or 共通アサーション）/ 1 = 想定外の例外。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import GENERATOR
from .config import load_config
from .errors import Cad2locError
from .pipeline import convert


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cad2loc",
        description="倉庫DXF図面 → WHSIM_CONTRACTS v1.0 準拠の layout.geojson",
    )
    parser.add_argument("input", help="入力DXF（DWGは事前にDXFへ変換すること）")
    parser.add_argument("-c", "--config", default=None, help="mapping.yaml（省略時は既定値）")
    parser.add_argument("-o", "--output", default="layout.geojson", help="出力GeoJSON")
    parser.add_argument("--report", default=None, help="report.json（既定: 出力と同じ場所）")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="共通アサーション不合格でも出力を書く代わりに、書かずに終了する",
    )
    parser.add_argument("-q", "--quiet", action="store_true", help="標準出力への要約を抑制")
    parser.add_argument("--version", action="version", version=GENERATOR)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        cfg = load_config(args.config)
        result = convert(args.input, cfg)
    except Cad2locError as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - top-level guard: no traceback for the user
        print(f"想定外のエラー: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    out_path = Path(args.output)
    report_path = Path(args.report) if args.report else out_path.parent / "report.json"
    if out_path.parent and not out_path.parent.exists():
        out_path.parent.mkdir(parents=True, exist_ok=True)

    if not (args.strict and not result.ok):
        out_path.write_text(
            json.dumps(result.layout, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    report_path.write_text(
        json.dumps(result.report, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    counts = result.report["counts"]
    if not args.quiet:
        print(
            f"{args.input} → {out_path}  "
            f"rack={counts['rack']} zone={counts['zone']} "
            f"node={counts['node']} edge={counts['edge']}"
        )
        print(f"report: {report_path}")
        for warning in result.report["warnings"]:
            print(f"  警告: {warning}")
        if result.report["unclassified"]:
            total = sum(u["count"] for u in result.report["unclassified"])
            print(f"  未分類図形 {total} 個（詳細は report.json）")
        if result.report["isolated_nodes"]:
            print(f"  孤立ノード {len(result.report['isolated_nodes'])} 個を除外（report.json）")

    if result.schema_errors:
        print(f"契約違反: JSON Schema 不合格 {len(result.schema_errors)} 件", file=sys.stderr)
        for error in result.schema_errors[:10]:
            print(f"  {error}", file=sys.stderr)
        return 3
    assertions = result.assertions
    if assertions is not None and not assertions.ok:
        print("契約違反: 共通アサーション不合格", file=sys.stderr)
        if assertions.edge_rack_intersections:
            print(
                f"  edge×rack 交差 {assertions.edge_rack_intersections} 件",
                file=sys.stderr,
            )
        if not assertions.connected:
            print(f"  通路グラフが非連結（成分 {assertions.component_count} 個）", file=sys.stderr)
        if assertions.dangling_edges:
            print(f"  参照先の無い edge {len(assertions.dangling_edges)} 件", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
