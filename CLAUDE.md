# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Status

This repository is effectively empty. The only tracked file is this `CLAUDE.md` (added in the single commit on `claude/add-claude-documentation-oNCDe`). There is no source code, no build system, no tests, no lint config, and no CI.

When real code is introduced, update this file with:

- Build, lint, test, and run commands (including how to run a single test)
- High-level architecture that spans multiple files (the "why" of the layout, not per-file descriptions)
- Important conventions pulled from any README, `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` added later

## Git Workflow

- Remote: `yato-san-cloud/ClaudeCode` (served via a local proxy)
- Active Claude-authored branches observed so far: `claude/add-claude-documentation-oNCDe`, `claude/add-claude-documentation-KQXSt`. New Claude sessions are typically assigned their own `claude/...` branch — develop there, do not push to a different branch without explicit permission.
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only.
- Do not open pull requests unless the user explicitly requests one.

## GitHub Integration

- Use the `mcp__github__*` MCP tools for all GitHub interactions (viewing PRs, posting comments, checking CI, etc.). The `gh` CLI and direct GitHub API access are not available.
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only; calls targeting other repositories will be denied.
- Be frugal about posting replies on GitHub — only comment when genuinely necessary.
