# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

**まきばのしずく (Makiba no Shizuku)** — a cute, vast, commercial‑grade ranch‑management
simulator that ships as a single self‑contained `index.html` (Canvas2D world + HTML/CSS UI
overlay, vanilla JS, no engine, no external assets, no CDN). See `README.md` for the player‑
facing overview and `docs/design/` for the full design docs.

## Build / test / run

```bash
npm install        # dev-only: Playwright for the headless QA harness
npm run build      # node tools/build.js — assembles src/ -> index.html (+ build/makiba-no-shizuku.html)
npm test           # node tools/test-playwright.js — headless Chromium: boot, drive a scenario,
                   #   capture console errors + screenshots into build/shots/, write build/qa-summary.json
npm run smoke      # boot-only smoke test
```

- Chromium for tests is the pre-installed one; the harness launches it via
  `executablePath: '/opt/pw-browsers/chromium'` (Playwright's own build id may differ).
- There is no separate lint step. Syntax-check a module with `node --check src/js/<name>.js`.
- `index.html` and `build/` are git-ignored during development; the final `index.html` is
  force-added as the playable deliverable in a release commit.

## Architecture (how it fits together)

Modules in `src/js/` each attach to a global `Game` namespace and are concatenated **in the
fixed order in `tools/build.js`**, each wrapped in its own IIFE. `data/content.json` +
`data/balance.json` are embedded as `Game.RAW` and normalized by `00-data.js` into the frozen
`Game.DATA` API. Load order: `00-data → util → state → save → time → economy → world → crops →
animals → sprites → render → audio → input → ui → tutorial → game`.

Key contracts (full detail in `docs/design/architecture.md` and `docs/design/IMPLEMENTER_BRIEF.md`):

- **Daily-sim model:** all heavy simulation runs once per in-game day in `bus.on('day:advance')`
  handlers (Economy market → Crops → Animals → Economy events/goals/rank). Per-tick `update(steps)`
  is smooth cosmetic work only. Fast-forward fires `day:advance` N times with no `update()`.
- **Read the live `Game.state`;** never cache the state object (Save.load / newGame swap it via
  `Game.State.set`). Modules own their sub-trees; money only via `Economy.debit/credit`, inventory
  only via `Economy.addItem/removeItem`.
- **Randomness:** gameplay RNG via `Game.Util.rng()` (seeded, persisted in `state.rngState`);
  cosmetic-only jitter via `Game.Util.hash01`. No `Math.random()` in sim logic (the sole exception
  is initial seed generation in `state.js`).
- **Decoupling:** sim modules never call `Game.UI` directly — they `bus.emit('notify', …)`.
  Sprites/Render draw functions are pure `(ctx, …)`. `opts.size` for `Sprites.animal` is a ~1.0
  multiplier, not pixels.
- **Test hooks:** `Game.test.*` (newGame, snapshot, advanceDays, buyAnimal, build, plant, sellAll,
  petRandom, save, load, errors) drive the game deterministically for the headless harness.

## Git workflow

- Do Claude-authored work on the designated feature branch for the task (currently
  `claude/ultracode-cow-ranch-sim-1mswmg`); create it from the default branch if missing.
- Push with `git push -u origin <branch-name>`; retry up to 4× with exponential backoff
  (2s, 4s, 8s, 16s) on network errors only.
- Do not open pull requests unless the user explicitly requests one.
- GitHub interactions go through the `mcp__github__*` tools; the `gh` CLI is not available.
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode`.
