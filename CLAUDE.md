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

- `app.py` — Streamlit エントリ。サイドバー上部の **エンジントグル** (pandas / DuckDB) で経路が分岐。pandas は DataFrame、DuckDB は `Catalog` 経由のビュー。共通の `run_volume_trends` / `run_abc` / `run_peak` / `run_turnover` ラッパー越しに各タブが分析を呼ぶ
- `src/data_io.py` — pandas 経路の CSV/Excel ローダ。`FieldSpec` による論理項目定義、ヒューリスティック自動推定 (`initial_mapping`) と型変換 (`apply_mapping`)
- `src/duck_io.py` — DuckDB 経路の `Catalog`。`register_path` (CSV/Parquet/glob を `read_csv_auto`/`read_parquet` でスキャン) と `register_dataframe` (Excel・サンプル用) + `apply_mapping` で型キャスト済みビュー `v_<name>` を生成
- `src/analyses.py` — pandas 純粋関数: `volume_trends`, `abc_analysis`, `peak_analysis`, `inventory_turnover`, `summary_kpis`, `daily_anomalies`, `period_compare`, `sku_lifecycle`, `partner_weekday_matrix`, `simple_forecast`, `sku_portfolio`
- `src/sql_analyses.py` — SQL 版(`Catalog` を受ける): `volume_trends`, `abc_analysis`, `peak_analysis`, `inventory_turnover`, `summary_kpis`, `daily_anomalies`, `partner_weekday_matrix`, `period_compare`(`forecast`/`lifecycle`/`portfolio` は集計後の小さなフレームに対する後処理のため pandas 関数を再利用)
- `src/insights.py` — ルールベースの自動インサイトエンジン。`Insight` dataclass と 9 ディテクタ(`detect_volume_trend`, `detect_anomaly_days`, `detect_sku_concentration`, `detect_partner_dependence`, `detect_peak_concentration`, `detect_inbound_outbound_balance`, `detect_dead_stock`, `detect_stockout_risk`, `detect_multi_line_efficiency`) + `generate_insights` 集約関数。severity (critical/warning/info) と suggestion(改善ヒント)付き
- `src/charts.py` — plotly チャート生成ヘルパ
- `scripts/generate_sample_data.py` — 曜日/時間帯ピーク偏りを持つダミーデータ生成 (`build_frames` をアプリの「サンプルで試す」が直接利用)
- `tests/test_analyses.py` — pandas 4 分析のユニットテスト
- `tests/test_sql_analyses.py` — SQL 版が pandas 版と同じ結果を返すパリティテスト

## Conventions

- 論理項目は `src/data_io.py` の `*_FIELDS` で定義。新しい分析を増やす場合は同所に追加し、`initial_mapping`/`apply_mapping` を経由した標準化済み DataFrame を `analyses.py` の関数に渡す
- 分析関数は副作用なし・DataFrame を受け取り DataFrame を返す純粋関数を維持(テスト容易性のため)
- pandas 版を「正」とし、SQL 版は `tests/test_sql_analyses.py` でパリティを担保する。新分析を増やす際は両エンジン+パリティテストをセットで追加すること
- 巨大データの想定: DuckDB 経路では生データを pandas に materialize しないこと(集計後の小さな結果のみ `.df()` を呼ぶ)

## Git Workflow

- Active development branch for Claude-authored changes: `claude/3pl-inventory-analysis-tool-S2xc6`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
