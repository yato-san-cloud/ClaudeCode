# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Status

This repository holds the documentation for the **PLAUD議事録 自動整理システム** — a pipeline that turns PLAUD voice-recorder meetings into structured minutes stored in Box, organized by customer, with a daily automated run. There is no application code; the executable side lives in Claude Code sessions (MCP connectors + a daily cron) and in Box.

Start with `meeting-notes/README.md` — it explains the architecture, all Box folder/file IDs, and the recovery procedure when a session (and its cron) has died. The operational source of truth is Box: `議事録/_運用ルール.md` (mirrored here as `meeting-notes/runbook.md`).

## Session recovery (most common task)

The daily cron is session-scoped and dies with the session. To restore it:

1. Confirm the PLAUD and Box connectors are enabled in this chat (`ListConnectors` → `enabledInChat: true`; if false, the user must toggle them in the chat's connector settings)
2. Recreate the cron from `meeting-notes/daily-task-prompt.md` (schedule `53 21 * * *` UTC = 6:53 JST)
3. Backlog is self-healing: anything recorded while the cron was dead is picked up on the next run via the `_processed.json` diff

## Conventions

- Minutes are stored **in Box only** (never Google Drive — user decision 2026-07-17), as `.md` + styled `.html`, named `YYYYMMDD_会議名.md`, in per-customer folders
- Box MCP uploads are text-only; binary files (docx) cannot be pushed to Box — generate docx locally and hand it to the user in chat when asked
- MCP server prefixes can change to UUIDs on reconnect; find tools via ToolSearch keyword search when `select:` misses

## Git Workflow

- Active development branch for Claude-authored changes: `claude/meeting-notes-mcp-nujtmu`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
