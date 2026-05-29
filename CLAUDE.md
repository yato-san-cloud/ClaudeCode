# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Status

This repository hosts **おションション** — a Notion-style note-taking web app. It is a
zero-dependency, no-build vanilla web app (HTML / CSS / JavaScript).

### Project layout

- `index.html` — markup and app shell
- `styles.css` — Notion-like styling, light/dark themes
- `app.js` — single IIFE: state, block editor, `localStorage` persistence (no deps)
- `README.md` — user-facing documentation

### Run

There is no build step. Open `index.html` directly, or serve the folder:

```bash
python3 -m http.server 8000   # → http://localhost:8000
```

### Lint / test

No test framework is configured. Syntax-check the script with `node --check app.js`.
Behavior is verified with ad-hoc Playwright smoke scripts driving `file://index.html`
(Playwright is available globally under `/opt/node22/lib/node_modules`).

### Architecture notes

- A page is `{ id, emoji, title, cover, blocks[] }`; a block is `{ id, type, text, checked }`.
- The editor is `contenteditable`-based; caret get/set, block split/merge, slash menu,
  markdown shortcuts, and drag-reorder are all hand-rolled.
- Two non-obvious gotchas handled in code:
  - `contenteditable` turns a trailing space into `&nbsp;` (` `) — normalized before
    matching markdown shortcuts (`# `, `- `, etc.).
  - The HTML `hidden` attribute is overridden by author `display` rules, so a global
    `[hidden] { display: none !important; }` rule keeps show/hide toggling correct.
  - Saves are debounced but flushed on `visibilitychange` / `pagehide` / `beforeunload`.

## Git Workflow

- Active development branch for Claude-authored changes: `claude/add-claude-documentation-oNCDe`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
