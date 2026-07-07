# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

現場マニュアル作成ツール — a single-file, offline-first HTML app for creating photo-based work-instruction manuals on site (smartphone camera → annotated steps → standalone HTML export). UI text is Japanese.

- `index.html` — the entire app: editor UI, IndexedDB persistence (localStorage fallback), canvas photo annotation, and `buildDoc()` which generates the standalone viewer HTML
- `docs/operations-design.md` — operations/rollout design (Teams / Kintone management, anti-formalization loops)
- `tests/smoke.js` — Playwright end-to-end smoke test
- `README.md` — user-facing usage

## Commands

- No build/lint step. Plain HTML+CSS+JS with **no external dependencies** — this is an offline requirement, keep it that way (no CDN scripts, no fetch).
- Test: `node tests/smoke.js` (resolves Playwright from global install at `/opt/node22/lib/node_modules` and Chromium at `/opt/pw-browsers/chromium` when present; override with `SMOKE_CHROMIUM`).

## Architecture notes

- Exported manuals embed their data once in `<script type="application/json" id="__manualdata">`; the viewer JS assigns `img[data-p]` sources from that JSON at load, and `parseImport()` reads it back for round-trip editing (photos re-imported are the annotated/baked versions; `photoOrig`/`marks` are intentionally not embedded to keep file size down).
- Inside `buildDoc()` every closing script tag must be written `<\/script>`, and the `VIEWER_JS` template literal must not contain backticks, `${`, or single backslashes (write `\\n` etc.) — it is embedded verbatim into generated HTML.
- Storage: IndexedDB `genba_tool`/`manuals`; on any IDB failure the app flips to a localStorage fallback (`genba_manuals_ls`). v1 single-manual data (`genba_manual_v1`) is migrated once at startup.

## Git Workflow

- Development branch is assigned per task by the harness (current: `claude/field-manual-tool-hgcc93`)
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
