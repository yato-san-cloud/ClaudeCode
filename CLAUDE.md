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
node tools/verify.mjs     # headless physics verification of every pin-puzzle level
node tools/verify.mjs -v  # same, with per-step logs
node qa/one.mjs <id>      # verify ONE ad mini-game in isolation (parallel-safe)
npm i && node qa/check.mjs [outdir]      # verify every ad mini-game in a real browser
npm i && node tools/smoke.mjs [outdir]   # full-story playthrough + screenshots
```

There is no test runner, linter, or dev server. Verification is split in two:

- `tools/verify.mjs` covers the pin puzzle's physics: each level's `solution` must win,
  each `traps` entry must lose, and the collectable maximum must exceed `need` by 10%+.
- `qa/one.mjs` / `qa/check.mjs` cover the ad mini-games: each calls the game's mandatory
  `solve()` hook and asserts the browser reaches a win, plus that idling never wins.
  `qa/one.mjs` writes to a temp file rather than `index.html`, so several people (or agents)
  can verify different games concurrently without stepping on each other.

Playwright is needed for the qa/ and smoke scripts (`npm i`). They point at the preinstalled
Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; do not run `playwright install`.

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
- `src/mini.js` — the contract and host for the ad mini-games. Its header comment is the
  authoritative spec; read it before touching anything under `src/ads/`.
- `src/ads/*.js` — one ad genre per file, auto-discovered by the bundler. Each file must
  declare **exactly one** top-level binding (`export const <UPPER_ID> = { meta, create }`)
  because everything lands in one scope; `qa/one.mjs` enforces this mechanically.
- `src/gfx.js` — shared canvas drawing helpers for the mini-games.
- `src/fake.js` — the merge game, popup queue, and full-screen interstitials.
- `src/app.js` — screen routing, the scripted ad sequence, and the `MINI_GAMES` registry.

## Conventions

- Changing anything in `sand.js` or `levels.js` requires re-running `tools/verify.mjs`.
  Level geometry is unforgiving and visual inspection is not sufficient.
- Every mini-game must implement `solve()`. Where the correct play is non-obvious (pathfinding,
  ordering), put an actual solver inside the game and drive `solve()` from it — see
  `src/ads/dig.js` (BFS) and `src/ads/tower.js` (bitmask DFS). This makes shipping an
  unsolvable stage structurally impossible rather than merely unlikely.
- Adding a file to `src/ads/` without registering it in `MINI_GAMES` fails the build by design.
- Keep the escape routes out of the fake merge game intact — there are three, so a player can
  always reach the real puzzle.
- Do not name real companies or apps; all brands in the parody are invented.

## Git Workflow

- Active development branch for Claude-authored changes: `claude/deceptive-game-ad-dp2xkq`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
