# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser game parodying deceptive mobile game ads: an ad shows an engaging pin-pulling
puzzle, "installing" it yields a completely different merge game, and requesting a refund
finally unlocks the puzzle the ad promised. See `README.md` for the full flow and for the
level-design pitfalls that the physics engine imposes.

Everything is Japanese-facing. UI strings, comments, and docs are in Japanese.

## Commands

```
node build.mjs            # src/ + template.html -> index.html (the distributable)
node tools/verify.mjs     # headless physics verification of every level
node tools/verify.mjs -v  # same, with per-step logs
npm i && node tools/smoke.mjs [outdir]   # real-browser playthrough + screenshots
```

There is no test runner, linter, or dev server. `tools/verify.mjs` is the test suite:
it asserts that each level's `solution` wins, each `traps` entry loses, and that the
collectable maximum exceeds `need` by at least 10%.

`tools/smoke.mjs` needs Playwright (`npm i`). It points at the preinstalled Chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; do not run `playwright install`.

## Architecture

`index.html` is a **generated single file** — never edit it directly. Edit `src/` and
`template.html`, then run `node build.mjs`. The bundler concatenates `src/*.js` in a fixed
order after stripping `import`/`export`, so all modules share one scope: **top-level names
must be unique across modules**.

- `src/sand.js` — falling-sand cellular automaton. Deterministic xorshift RNG, which is what
  makes headless level verification possible. Lava is a liquid, gold and stone are powders,
  drains consume lava/gold but not stone.
- `src/levels.js` — every level as rectangles plus a `solution` and `traps` used by both the
  verifier and the in-game hints. Its header comment records the geometry rules that must
  hold; violating them produces levels that look fine but are unwinnable or unfair.
- `src/puzzle.js` — canvas rendering and pin input, shared by the ad demo and the real game.
- `src/fake.js` — the merge game, popup queue, and full-screen interstitials.
- `src/app.js` — screen routing and the scripted ad sequence.

## Conventions

- Changing anything in `sand.js` or `levels.js` requires re-running `tools/verify.mjs`.
  Level geometry is unforgiving and visual inspection is not sufficient.
- Keep the escape routes out of the fake merge game intact — there are three, so a player can
  always reach the real puzzle.
- Do not name real companies or apps; all brands in the parody are invented.

## Git Workflow

- Active development branch for Claude-authored changes: `claude/deceptive-game-ad-dp2xkq`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
