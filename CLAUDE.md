# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`jancode-dimensions` — 在庫Excel(.xlsx)のJANコードから三辺サイズ(幅・奥行・高さ)と三辺合計(cm)を調べて同一シートに転記するPython製CLIツール。Python 3.9+。ランタイム依存は openpyxl と requests(オンラインプロバイダ使用時のみ)。

## Commands

- Install (dev): `pip install -e ".[dev]"` または `pip install -r requirements.txt`
- Run all tests: `python3 -m pytest -q`
- Run a single test: `python3 -m pytest tests/test_parser.py::test_total -q`
- Run the CLI without installing: `PYTHONPATH=src python3 -m jancode_dimensions process <入力.xlsx> --master <マスタ.csv> --output <出力.xlsx>`
- Installed entry point: `jancode-dimensions process ...`

テストは外部API・ネットワークに依存しない(楽天/Yahooプロバイダは実呼び出しをテストしない方針)。

## Architecture

処理の流れ: Excel(JAN列) → `LookupPipeline` → SQLiteキャッシュ → プロバイダ群(指定順にフォールバック) → 出力列へ転記。

- `src/jancode_dimensions/cli.py` — argparse CLI(`process` サブコマンド)。行ごとに pipeline を呼び、出力列へ書き込む
- `pipeline.py` — 探索順序(キャッシュ→プロバイダ)、JAN正規化(`normalize_jan`: Excel由来の`.0`/空白/ハイフンを吸収)、リモート呼び出しのスロットリング(`--sleep`)、商品名ヒント(title_hint)の引き継ぎ(入力Excelの`商品名`列→先行プロバイダで判明した商品名→後続プロバイダの順)
- `cache.py` — SQLiteキャッシュ。`verified`(人手確認済み)の行はサイズ無しでもオンライン再検索より優先される
- `providers/` — 取得元。`base.DimensionProvider` の `lookup(jan) -> ProductInfo | None` を実装して追加する。リモートAPIを叩くものは `is_remote = True` を立てるとスロットリング対象になる。通信エラーは握りつぶして None を返す(バッチを止めない)契約
  - `local_master.py` — 自社マスタCSV(個別列 or サイズ文字列列、mm列名はcmへ換算)
  - `rakuten.py` / `yahoo.py` — 商品検索APIの説明文からテキスト抽出(要APIキー、環境変数 `RAKUTEN_APP_ID` / `YAHOO_APP_ID`)
  - `ai_estimate.py` — Claude API(structured outputs)で商品名から推定。商品名(title_hint)必須、無ければ推定しない。結果は備考列で「AI推定(要確認)」と明示。テストはクライアントをスタブ注入して行う(実API呼び出し禁止)
- `parser.py` — 「幅30×奥行20×高さ10cm」等の自由テキストから寸法抽出。ラベル付き表記を3連表記より優先
- `excel_io.py` — .xlsx読み書き。JAN列ヘッダの自動判定と、出力列の冪等な確保(同名列は再利用し、再実行しても列が増えない)

## Key Invariants

- 寸法は常にcmで保持する(`models.Dimensions`)。三辺合計は軸の割り当て順に依存しないため配送サイズ判定に安全
- 入力Excelの既存列(特に`商品名`)は上書きしない。取得元で見つかった商品名は照合用の`照合商品名`列へ出力する
- JANコード自体にサイズ情報は無い。必ずプロバイダ(参照元)経由で解決する。Amazon PA-APIは2026-05-15廃止のため非対応

## Git Workflow

- Claude-authored changes go on session-specific `claude/*` branches (follow the session instructions for the branch name)
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
