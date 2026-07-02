# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

「業務OS」リポジトリ — 物流プロジェクト業務(議事録・審議回答・要件定義・調査依頼・版管理)をAIと分担するためのSkill・テンプレート・運用ルール集。案件固有の成果物はGoogle Driveにあり、ここには業務の「型」だけを置く。全体像は `README.md`、業務分析は `docs/00_業務マップ.md` を参照。

## Working Rules

- Google DriveのファイルはMCP経由で**読み取りのみ**。書き込み・リネーム・削除は提案に留め、実行はユーザーが行う
- 配布・送信・削除の実行はしない(ドラフトとチェックまでがAIの担当)
- 🔒私的メモ(人物評・交渉戦術)の内容を配布物・引継ぎ書に転記しない
- ファイル命名・版管理・正本の扱いは `docs/02_運用ルール_命名・版管理・正本.md` に従う
- Skillを更新したら該当する `templates/` との整合を確認する

## Verification

- `scripts/name_lint.py` は標準ライブラリのみで動作。動作確認: `python3 scripts/name_lint.py --names "テスト_v1.md"`
- Skill変更時はYAMLフロントマター(name/description)の構文を確認

## Git Workflow

- Claude作業ブランチはセッションごとに指定される(現行: `claude/workflow-automation-strategy-efcre3`)
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
