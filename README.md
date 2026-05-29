# VoxelCraft

A Minecraft-style voxel game that runs in the browser with **Three.js** — no
build step, no binary assets. Terrain, textures, and everything else are
generated procedurally at runtime.

![type: browser game](https://img.shields.io/badge/platform-browser-blue)

## Features

- **Infinite procedural world** — chunk-streamed (16×16×128) terrain built from
  custom Perlin/fBm noise, with biomes (plains, desert, mountains, snow), oceans,
  beaches, caves, ore veins, and trees.
- **Build & mine** — break and place blocks via DDA voxel raycasting, with a
  selection highlight and block drops.
- **First-person controls** — WASD movement, mouse look (pointer lock), jump,
  gravity, sprint, sneak, swept-AABB collision, and a double-jump creative-fly
  toggle.
- **15 block types** — grass, dirt, stone, sand, wood, leaves, water, cobble,
  planks, bedrock, glass, coal/iron ore, snow.
- **Inventory & hotbar** — 9-slot hotbar + 27-slot inventory, stack management,
  drag-to-move stacks.
- **Crafting** — 2×2 crafting grid with shapeless recipes (e.g. wood→planks,
  sand→glass).
- **Day/night cycle** — moving sun, shifting sky colour and lighting.
- **Hostile mobs** — zombies spawn at night, wander, chase, and deal damage;
  hearts HUD, death & respawn.
- **Save/Load** — world edits, player state, and inventory persist to
  `localStorage` (autosaves every 15s and on exit).

## Run it

ES modules can't load over `file://`, so serve over HTTP:

```bash
npm start        # zero-dependency static server on http://localhost:8080
```

Then open <http://localhost:8080>. (Any static server works; `npm start` uses
the bundled `server.js`.)

## Controls

| Action | Key |
| --- | --- |
| Move | `W` `A` `S` `D` |
| Look | Mouse (click to capture) |
| Jump | `Space` |
| Toggle fly | Double-tap `Space` |
| Sneak / fly down | `Shift` |
| Sprint | `Ctrl` |
| Break block / attack | Left click |
| Place block | Right click |
| Select hotbar slot | `1`–`9` or scroll |
| Inventory / crafting | `E` (or `Esc` to close) |
| Clear save | `F` |

## Architecture

The code separates **pure game logic** (Node-testable, no DOM/Three.js) from the
**rendering/IO layer**:

| Module | Responsibility |
| --- | --- |
| `js/noise.js` | Seeded Perlin + fBm noise, deterministic PRNG |
| `js/blocks.js` | Block registry, face/atlas tile mapping |
| `js/chunk.js` | Chunk storage + greedy-ish culled mesh geometry builder |
| `js/terrain.js` | Heightmaps, biomes, caves, ores, tree placement |
| `js/world.js` | Chunk manager, cross-chunk edits, DDA raycast, saves |
| `js/inventory.js` | Stacks, hotbar, add/remove/swap |
| `js/crafting.js` | Recipe matching |
| `js/player.js` | Movement, gravity, swept-AABB collision |
| `js/save.js` | Serialize/restore world + player + inventory |
| `js/atlas.js` | Procedural texture atlas painted on a canvas |
| `js/renderer.js` | Three.js scene, chunk meshes, lighting, day/night |
| `js/mobs.js` | Mob AI, physics, combat |
| `js/ui.js` | HUD, hotbar, inventory/crafting screen |
| `js/main.js` | Bootstrap + main loop wiring it all together |

## Tests

Pure-logic modules are covered by Node's built-in test runner:

```bash
npm test
```

Covers noise determinism, chunk indexing & face culling, terrain generation,
world get/set + raycast, inventory stacking, crafting, player physics
(gravity/landing/wall collision), and save round-tripping.

## License

MIT
