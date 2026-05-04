# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

3PL 倉庫 物量分析ツール — Streamlit + pandas + plotly ベースのダッシュボード。WMS 出力(CSV / Excel)を取り込み、物量推移 / ABC / ピーク / 在庫回転を分析する。

## Commands

- 依存インストール: `pip install -r requirements.txt`
- アプリ起動: `streamlit run app.py`
- テスト全体: `pytest -q`
- 単一テスト: `pytest tests/test_analyses.py::test_abc_analysis_assigns_ranks -q`
- サンプルデータ生成: `python scripts/generate_sample_data.py --out sample_data --days 90`

## Architecture

- `app.py` — Streamlit エントリ。サイドバーで 3 種ファイル(出荷/入荷/在庫)のアップロード + 列マッピング UI、メインはタブ(物量推移 / ABC / ピーク / 在庫回転)
- `src/data_io.py` — CSV/Excel ローダ、`FieldSpec` による論理項目定義、ヒューリスティック自動推定 (`initial_mapping`) と型変換 (`apply_mapping`)
- `src/analyses.py` — Streamlit 非依存の純粋関数 4 本: `volume_trends`, `abc_analysis`, `peak_analysis`, `inventory_turnover`。標準化された論理列名 (`date`, `timestamp`, `sku`, `qty`, `partner`, `location`) を入力に取る
- `src/charts.py` — plotly チャート生成ヘルパ
- `scripts/generate_sample_data.py` — 曜日/時間帯ピーク偏りを持つダミーデータ生成
- `tests/test_analyses.py` — pytest によるユニットテスト

## Conventions

- 論理項目は `src/data_io.py` の `*_FIELDS` で定義。新しい分析を増やす場合は同所に追加し、`initial_mapping`/`apply_mapping` を経由した標準化済み DataFrame を `analyses.py` の関数に渡す
- 分析関数は副作用なし・DataFrame を受け取り DataFrame を返す純粋関数を維持(テスト容易性のため)

## Git Workflow

- Active development branch for Claude-authored changes: `claude/3pl-inventory-analysis-tool-S2xc6`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
