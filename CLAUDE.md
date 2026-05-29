# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Status

This repository hosts **沼 (NUMA)** — a browser-based fan recreation of the "沼"
hanemono pachinko machine from the manga *Kaiji*. It is a dependency-free static
site (HTML5 Canvas + a hand-rolled 2D physics engine + synthesized WebAudio).

### Commands

- **Run locally:** `npm start` (serves on :8080 via `python3 -m http.server`), or
  just open `index.html`. Serving over HTTP is preferred over `file://`.
- **Test:** `npm test` (runs `node test/smoke.js` — a headless check of physics,
  ball-jam prevention, and jackpot consistency; no browser/DOM required).
- **Syntax check a file:** `node --check js/<file>.js`.
- **Build:** none — static assets, ready for GitHub Pages (publish branch root `/`).

### Architecture

Scripts are plain (non-module) IIFEs that self-register onto a global `window.Numa`
namespace and load in dependency order via `<script>` tags in `index.html`
(physics → audio → board → game → main). This keeps it working from both
`file://` and Pages without bundling.

- `js/physics.js` — `Numa.physics`: `Ball`, circle (peg) and segment (wall)
  collision. Restitution is **velocity-dependent** (0 at low speed) so balls settle
  and slide instead of bouncing forever on slopes.
- `js/board.js` — `Numa.Board`: static layout (walls, pegs, chuckers, V-zone) and
  all drawing. The yakumono roof is built from a **dense row of pegs** (convex, so
  balls never jam on the ridge); the central "lid" pegs are removed when the wings
  open to form the capture mouth.
- `js/game.js` — `Numa.Game`: state machine (`normal`/`jackpot`), launch→`rail`→
  field→`stage` ball lifecycle, wing timing, probability-based V draw, scripted
  jackpot rounds, money/収支, and a ball-jam safety kick.
- `js/main.js` — bootstrap: DPR canvas scaling, rAF loop, HUD/controls binding.
- Tunable balance lives in `Numa.CONFIG` (game.js) and `CHUCKERS[].pCatch` (board.js).

## Git Workflow

- Active development branch for Claude-authored changes: `claude/add-claude-documentation-oNCDe`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
