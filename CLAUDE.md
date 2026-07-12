# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

The **Ook! & Cow Workbench** — a dependency-free, single-page web app to write,
run, single-step, convert and generate programs in the Ook!, Cow (COW) and
Brainfuck esoteric languages. See `README.md` for the full tour.

### Commands

- `node test.js` — run the engine test suite (no dependencies, no framework)
- `node build.js` — bundle into `dist/index.html` (standalone) and
  `dist/artifact.html` (body-only fragment)
- Run a single behaviour: `node -e "console.log(require('./esolang.js').run('cow','MoO MoO MoO OOM').output)"`
- There is no build step needed to *use* the app: open `index.html` in a browser

### Architecture

Every language flows through one intermediate representation (IR): source is
parsed into a normalised opcode stream, a single virtual machine executes it, and
each converter is `parse → IR → emit`. This is what keeps the three languages in
sync and makes any-to-any conversion free.

- `esolang.js` — the entire engine (parsers, emitters, `Machine` stepper, VM,
  text→code generator, curated examples). Dual-mode: `window.Esolang` in the
  browser, `module.exports` in Node, so the UI and tests share one source.
- `index.html` — the workbench UI; inline styles + glue, loads `esolang.js`.
- `test.js` — Node test suite covering all three languages, conversion, the
  generator, and error handling.
- `build.js` — inlines the engine to produce the `dist/` bundles.

Conventions: cells are unsigned bytes that wrap at 0–255; the pointer starts at
cell 0; `,` reads UTF-8 bytes with EOF = 0; the VM enforces a step limit. Keep
`esolang.js` browser/Node-agnostic (no Node-only globals in the shared paths) and
keep `test.js` green.

## Git Workflow

- Active development branch for Claude-authored changes: `claude/add-claude-documentation-oNCDe`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
