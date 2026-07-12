# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-contained **Bomberman** clone that runs in the browser. Pure vanilla JavaScript, HTML, and
CSS — **no build step, no runtime dependencies, no external assets**. All graphics are drawn
procedurally on a `<canvas>` and all sound is synthesized with the Web Audio API.

## Run

The game is made of classic (non-module) `<script>` files, so it runs from `file://` with no server:

```bash
xdg-open index.html            # or just open index.html in a browser
# optional local server:
python3 -m http.server 8000    # then visit http://localhost:8000
```

## Test / verify

There is no unit-test framework (the game is a canvas render loop). Verify changes by loading the
page in a browser and playing, or drive it headlessly with Chromium via `playwright-core`:

```bash
npm i playwright-core          # dev-only; ignored by git
# load file://.../index.html, then assert against window.__game
# (main.js exposes the live Game instance as window.__game for debugging/tests)
```

Useful invariants to check after any gameplay change:
- No console errors / `pageerror` on load or during play.
- No entity center ever lands in a `WALL`/`BRICK` cell (`game.map.isWall(col,row)`).
- Bombs placed → appear in `game.bombs` → detonate (~`BOMB_FUSE_MS`) → `game.explosions` → clear.
- Clearing all enemies sets `game.state === 'won'`; running out of lives sets `'gameover'`.

`node --check js/<file>.js` catches syntax errors quickly for any single file.

## Architecture

All source lives in `js/` as classic scripts that share one global lexical scope. **Do not use
`import`/`export`** — declaring `class Foo {}` / `const BAR` at the top level of one file makes it
visible to every later file. `index.html` loads them in dependency order:

```
config → sound → map → physics → input → powerup → bomb → enemy → player → render → game → main
```

| File | Global(s) | Responsibility |
| --- | --- | --- |
| `config.js` | constants, `COLORS`, `TileType`, `DIRS`, `PowerupType` | Single source of truth for all tunables/enums/palette |
| `sound.js` | `Sound` | Synthesized Web Audio SFX; every method is no-throw |
| `map.js` | `GameMap` | Grid generation + bounds-safe tile queries |
| `physics.js` | `Physics` | Pure axis-separated AABB collision resolution |
| `input.js` | `Input` | Keyboard state; edge-triggered `consume*` actions |
| `powerup.js` | `Powerup` | Power-up entity + `Powerup.randomType()` |
| `bomb.js` | `Bomb`, `Explosion`, `computeExplosion()` | Fuses, blast-shape computation, flame lifetime |
| `enemy.js` | `Enemy` | Grid-aligned wander / chase AI |
| `player.js` | `Player` | Movement, bomb placement, stats, respawn |
| `render.js` | `Renderer` | All procedural canvas drawing + HUD + overlays |
| `game.js` | `Game` | State machine tying everything together |
| `main.js` | — | Canvas bootstrap + `requestAnimationFrame` loop |

### Key conventions

- **Coordinate model.** Entity `(x,y)` are pixel coordinates of the top-left corner in *play-field*
  space where `(0,0)` is the grid's top-left. The HUD band (`HUD_HEIGHT`) is added **only by the
  Renderer** when drawing (`screenY = y + HUD_HEIGHT`); game logic never adds it. An entity's cell is
  the cell of its center: `col = Math.floor((x + size/2) / TILE)`.
- **Time.** Every `update(dt, game)` receives `dt` in **seconds** (the main loop converts ms→s and
  clamps to `≤ 0.05`). Config timings are in **ms** — convert when comparing.
- **Central collision.** Entities move through `game.moveEntity(entity, dx, dy)` (walls/bricks/bombs
  + per-entity bomb pass-through), except `Enemy`, which does its own grid-aligned stepping.
- **The `Game` instance** is the hub passed into every entity `update()`; it owns `map`, `player`,
  `bombs`, `explosions`, `enemies`, `powerups`, `input`, and resolves all inter-entity interactions
  (damage, pickups, chain detonation, win/lose) each frame.

When changing gameplay feel, prefer editing constants in `config.js` over hard-coding values.

## Git Workflow

- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff
  (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
