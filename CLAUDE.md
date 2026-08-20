# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Status

Documentation and Copilot Studio agent definitions. `poc/` holds the visit-prep PoC docs; `copilot-agents/` holds `.mcs.yml` agent definitions (schema of microsoft/skills-for-copilot-studio) ported from Claude Code skills. No build or test tooling; validate YAML with that plugin's `scripts/schema-lookup.bundle.js validate <file>`. The remote is `yato-san-cloud/ClaudeCode` on a local proxy. When real code is added, this file should be updated with:

- Build, lint, test, and run commands (including how to run a single test)
- High-level architecture that spans multiple files
- Important conventions pulled from any README, `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` that gets added later

## Repository Contents

- `poc/README.md` — 営業訪問準備PoC（workIQ × スピーダ × Copilot Studio）の全体像・設計判断・成功基準
- `poc/copilot-studio/instructions.md` — Copilot Studio の指示欄に貼るエージェント指示本文（唯一の原本）
- `poc/copilot-studio/setup-guide.md` — エージェント作成〜Teams/M365 Copilot 公開〜テストの手順書
- `poc/sample-data/test-data.md` — テスト用ダミーデータ（訪問予定CSV・SPEEDA貼り付け例・期待出力例・評価チェックリスト）
- `copilot-agents/README.md` — Claude Codeスキル群のCopilot Studio移植ポートフォリオ（共通push手順・実機確認事項）
- `copilot-agents/{visit-prep,fable5-optimizer,gyomu-flow,warehouse-planner}/` — 各エージェントの `agent.mcs.yml`・`topics/`・`knowledge/`・`PORT_NOTES.md`（settings.mcs.ymlは参照用でpush禁止）

## Git Workflow

- Active development branch for Claude-authored changes: `claude/add-claude-documentation-oNCDe`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
