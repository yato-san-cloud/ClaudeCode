"""コマンドラインインターフェース。

使用例:
    # 自社マスタだけで転記(外部API不要・最も確実)
    jancode-dimensions process 在庫.xlsx --master master.csv

    # マスタ→楽天→Yahoo の順にフォールバック(要APIキー)
    export RAKUTEN_APP_ID=xxxx
    export YAHOO_APP_ID=yyyy
    jancode-dimensions process 在庫.xlsx --providers local,rakuten,yahoo \\
        --master master.csv --output 在庫_転記済み.xlsx --sleep 1.0
"""

from __future__ import annotations

import argparse
import datetime as _dt
import sys
from typing import List

from .cache import Cache
from .excel_io import ExcelSheet
from .pipeline import LookupPipeline
from .providers import LocalMasterProvider, RakutenProvider, YahooProvider

_PROVIDER_FACTORIES = {
    "local": lambda args: LocalMasterProvider(args.master),
    "rakuten": lambda args: RakutenProvider(args.rakuten_app_id),
    "yahoo": lambda args: YahooProvider(args.yahoo_app_id),
}


def _build_providers(names: List[str], args) -> list:
    providers = []
    for name in names:
        factory = _PROVIDER_FACTORIES.get(name)
        if factory is None:
            raise SystemExit(f"未知のプロバイダ: {name} (利用可能: {list(_PROVIDER_FACTORIES)})")
        if name == "local" and not args.master:
            raise SystemExit("local プロバイダを使うには --master でマスタCSVを指定してください。")
        providers.append(factory(args))
    return providers


def cmd_process(args) -> int:
    provider_names = [n.strip() for n in args.providers.split(",") if n.strip()]
    providers = _build_providers(provider_names, args)
    cache = None if args.no_cache else Cache(args.cache)
    pipeline = LookupPipeline(providers, cache=cache, sleep_between=args.sleep)

    sheet = ExcelSheet(args.input, sheet=args.sheet)
    jan_col = sheet.find_jan_column(args.jan_column)
    out_cols = sheet.ensure_output_columns()
    now = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    processed = found = 0
    for row in sheet.iter_data_rows():
        jan_value = sheet.get(row, jan_col)
        if jan_value is None or str(jan_value).strip() == "":
            continue
        if args.limit and processed >= args.limit:
            break
        processed += 1
        result = pipeline.lookup(jan_value)

        # 取得元・照合商品名・取得日時は成否によらず記録する。
        sheet.set(row, out_cols["取得元"], result.source or "")
        sheet.set(row, out_cols["照合商品名"], result.title or "")
        sheet.set(row, out_cols["取得日時"], now)
        if result.found:
            found += 1
            dims = result.dimensions
            sheet.set(row, out_cols["幅(cm)"], dims.width_cm)
            sheet.set(row, out_cols["奥行(cm)"], dims.depth_cm)
            sheet.set(row, out_cols["高さ(cm)"], dims.height_cm)
            sheet.set(row, out_cols["三辺合計(cm)"], dims.total_cm)
            sheet.set(row, out_cols["備考"], "キャッシュ" if result.from_cache else "")
        else:
            sheet.set(row, out_cols["備考"], "サイズ取得できず")

        print(
            f"[{processed}] {result.jan}: "
            + (f"{result.dimensions.total_cm}cm ({result.source})" if result.found else "未取得")
        )

    if cache is not None:
        cache.close()

    if args.dry_run:
        print(f"\n[dry-run] 保存はスキップ。対象 {processed} 件 / 取得成功 {found} 件")
        return 0

    saved = sheet.save(args.output)
    print(f"\n完了: {saved} に保存。対象 {processed} 件 / 取得成功 {found} 件 "
          f"/ 未取得 {processed - found} 件")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="jancode-dimensions",
        description="在庫ExcelのJANコードから三辺サイズを調べて転記するツール。",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("process", help="ExcelのJAN列を処理して三辺サイズを転記する")
    p.add_argument("input", help="入力Excel(.xlsx)")
    p.add_argument("--output", help="出力先(.xlsx)。省略時は入力ファイルを上書き")
    p.add_argument("--sheet", help="対象シート名(省略時はアクティブシート)")
    p.add_argument("--jan-column", help="JAN列のヘッダ名(省略時は自動判定)")
    p.add_argument("--providers", default="local",
                   help="取得元をカンマ区切りで指定。順にフォールバック(既定: local)")
    p.add_argument("--master", help="自社マスタCSVのパス(local プロバイダ用)")
    p.add_argument("--rakuten-app-id", help="楽天アプリID(未指定時は環境変数 RAKUTEN_APP_ID)")
    p.add_argument("--yahoo-app-id", help="Yahoo アプリID(未指定時は環境変数 YAHOO_APP_ID)")
    p.add_argument("--cache", default=".jancode_cache.sqlite", help="キャッシュDBのパス")
    p.add_argument("--no-cache", action="store_true", help="キャッシュを使わない")
    p.add_argument("--sleep", type=float, default=0.0,
                   help="リモートAPI呼び出しの最小間隔(秒)。ローカル参照やキャッシュヒットでは待たない")
    p.add_argument("--limit", type=int, default=0, help="処理する最大件数(0=無制限)")
    p.add_argument("--dry-run", action="store_true", help="保存せず結果のみ表示")
    p.set_defaults(func=cmd_process)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
