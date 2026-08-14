# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

路線便（LTL/特別積合せ）運賃タリフ計算の調査と自作ツール一式。市販調査 → Python PoC → 単一HTMLアプリ「タリフ番長」の順に育っている。

- `docs/rosenbin-tariff-tools-survey.md` — 市販ツールの市場調査レポート（5カテゴリ整理、build vs buy 判断）
- `poc/` — Python参照実装。`tariff_calc.py`（計算エンジンCLI）、`make_dummy_tariff.py`（架空3社のダミータリフCSV生成 → `poc/data/`）、`export_quotes.py`（パリティテスト用JSONエクスポート）
- `app/tariff-bancho.html` — 単一HTMLアプリ本体（計算・複数社比較・一括見積り・請求照合・タリフマスタ管理）。外部依存なし、localStorageのみ、Artifactとして公開可能
- `app/tests/parity.mjs` — JSエンジンとPython版の計算一致テスト

## Commands

- Run parity test: `node app/tests/parity.mjs`（1,000ケース×3社でJS/Python完全一致を要求）
- Regenerate dummy tariff data: `cd poc && python3 make_dummy_tariff.py`
- CLI quote: `python3 poc/tariff_calc.py --from 東京 --to 大阪 --weight 80 --volume 0.4`
- No build step, no linter configured. Node 22+ / Python 3 stdlib only.

## Architecture invariants

- **エンジンの二重実装**: 計算ロジックは `poc/tariff_calc.py` と `app/tariff-bancho.html` の `//<engine>`〜`//</engine>` ブロックに二重実装されている。どちらかを変えたら必ずもう片方も変え、`node app/tests/parity.mjs` を通すこと。パリティテストはHTMLからengineブロックを文字列抽出して実行するため、マーカーコメントを消さないこと
- **デモデータの同期**: アプリ内蔵のデモタリフは `poc/data/*.csv` をそのまま埋め込んだもの。CSVを再生成したらHTML内の埋め込みも差し替える
- **計算順序**: 割引 → 時間指定割増 → 燃料サーチャージ（適用日で選択）→ 10円単位切り上げ → 最低運賃フロア。ダミータリフは完全な架空データで、実在運送会社とは無関係という前提を崩さない
- **アプリの制約**: 単一ファイル・外部リソース参照なし（Artifact CSP対応）・ダウンロード起動なし（コピペでエクスポート）・データは端末外に出さない

## Git Workflow

- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
