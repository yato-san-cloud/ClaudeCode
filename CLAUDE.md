# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Status

This repository is currently uninitialized: no source files, no commits, and no configured tooling. The remote is `yato-san-cloud/ClaudeCode` on a local proxy. When real code is added, this file should be updated with:

- Build, lint, test, and run commands (including how to run a single test)
- High-level architecture that spans multiple files
- Important conventions pulled from any README, `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` that gets added later

## Git Workflow

- Active development branch for Claude-authored changes: `claude/add-claude-documentation-oNCDe`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
