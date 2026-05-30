# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Status

This repository hosts **VoxelCraft**, a Minecraft-style browser voxel game built
on Three.js with no build step (ES modules + CDN importmap). See `README.md` for
the full feature list and controls.

### Commands

- **Run:** `npm start` — serves the game at http://localhost:8080 via the
  zero-dependency `server.js` (ES modules require HTTP, not `file://`).
- **Test:** `npm test` — runs Node's built-in test runner over the pure-logic
  modules.
- **Run a single test:** `node --test --test-name-pattern "crafting"`
- **Syntax check a module:** `node --check js/<file>.js`

### Architecture

Code is split into **pure game logic** (Node-testable, no DOM/Three.js) and the
**rendering/IO layer**:

- Logic: `js/noise.js`, `js/blocks.js`, `js/chunk.js`, `js/terrain.js`,
  `js/world.js`, `js/inventory.js`, `js/crafting.js`, `js/player.js`,
  `js/save.js`
- Rendering/IO: `js/atlas.js`, `js/renderer.js`, `js/mobs.js`, `js/ui.js`,
  `js/main.js` (bootstrap + main loop)

Keep new gameplay logic in the pure modules with matching tests in
`test/logic.test.js`; reserve Three.js/DOM usage for the rendering layer.

## Git Workflow

- Active development branch for Claude-authored changes: `claude/add-claude-documentation-oNCDe`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
