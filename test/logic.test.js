// Unit tests for the pure game-logic modules (no DOM / Three.js).
// Run with: npm test   (uses Node's built-in test runner).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Perlin2D, mulberry32, hashSeed } from '../js/noise.js';
import { Chunk, chunkIndex, inChunkBounds, buildChunkGeometry, CHUNK_SIZE } from '../js/chunk.js';
import { BLOCKS, isSolid, isTransparent } from '../js/blocks.js';
import { TerrainGenerator } from '../js/terrain.js';
import { World } from '../js/world.js';
import { Inventory, MAX_STACK } from '../js/inventory.js';
import { matchRecipe, RECIPES } from '../js/crafting.js';
import { Player } from '../js/player.js';
import { buildSave, applySave } from '../js/save.js';

test('noise: deterministic for same seed, differs for different seeds', () => {
  const a = new Perlin2D('seedA');
  const b = new Perlin2D('seedA');
  const c = new Perlin2D('seedB');
  assert.equal(a.noise(12.3, 4.5), b.noise(12.3, 4.5));
  assert.notEqual(a.noise(12.3, 4.5), c.noise(12.3, 4.5));
  // Range roughly within [-1, 1].
  for (let i = 0; i < 50; i++) {
    const v = a.fbm(i * 1.7, i * 0.3, 4);
    assert.ok(v >= -1.0001 && v <= 1.0001, `fbm out of range: ${v}`);
  }
});

test('mulberry32 deterministic and in [0,1)', () => {
  const r1 = mulberry32(hashSeed('x'));
  const r2 = mulberry32(hashSeed('x'));
  for (let i = 0; i < 10; i++) {
    const v = r1();
    assert.equal(v, r2());
    assert.ok(v >= 0 && v < 1);
  }
});

test('chunk indexing round-trips and respects bounds', () => {
  assert.equal(chunkIndex(0, 0, 0), 0);
  assert.equal(chunkIndex(1, 0, 0), 1);
  assert.equal(chunkIndex(0, 0, 1), CHUNK_SIZE);
  assert.ok(inChunkBounds(0, 0, 0));
  assert.ok(!inChunkBounds(-1, 0, 0));
  assert.ok(!inChunkBounds(CHUNK_SIZE, 0, 0));
});

test('block flags', () => {
  assert.ok(isSolid(BLOCKS.STONE.id));
  assert.ok(!isSolid(BLOCKS.AIR.id));
  assert.ok(!isSolid(BLOCKS.WATER.id));
  assert.ok(isTransparent(BLOCKS.LEAVES.id));
  assert.ok(!isTransparent(BLOCKS.STONE.id));
});

test('mesh: isolated block has 6 visible faces; enclosed block has 0', () => {
  const chunk = new Chunk(0, 0);
  chunk.set(5, 5, 5, BLOCKS.STONE.id);
  const getLocal = (x, y, z) => chunk.get(x, y, z);
  const geo = buildChunkGeometry(chunk, getLocal);
  // 6 faces * 4 verts * 3 coords = 72 positions; 6 * 6 = 36 indices.
  assert.equal(geo.positions.length, 72);
  assert.equal(geo.indices.length, 36);

  // Surround it fully -> centre contributes no faces, neighbours each have 5.
  const chunk2 = new Chunk(0, 0);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        chunk2.set(5 + dx, 5 + dy, 5 + dz, BLOCKS.STONE.id);
  const geo2 = buildChunkGeometry(chunk2, (x, y, z) => chunk2.get(x, y, z));
  // The fully enclosed centre block must contribute zero of its 6 faces; we
  // verify by checking no face sits entirely on the centre cube's interior —
  // simpler: total faces of a solid 3x3x3 cube = surface area = 6*9 = 54 faces.
  assert.equal(geo2.indices.length / 6, 54);
});

test('terrain: deterministic height + bedrock floor + filled surface', () => {
  const gen = new TerrainGenerator('abc');
  const h1 = gen.heightAt(10, 20);
  const h2 = new TerrainGenerator('abc').heightAt(10, 20);
  assert.equal(h1, h2);

  const chunk = new Chunk(0, 0);
  gen.generateChunkTerrain(chunk);
  assert.ok(chunk.generated);
  // Bedrock at y=0 everywhere.
  assert.equal(chunk.get(0, 0, 0), BLOCKS.BEDROCK.id);
  // There is at least some non-air above bedrock.
  let nonAir = 0;
  for (let i = 0; i < chunk.blocks.length; i++) if (chunk.blocks[i] !== 0) nonAir++;
  assert.ok(nonAir > 100);
});

test('world: set/get blocks, edits recorded, raycast hits', () => {
  const world = new World('rayseed');
  world.ensureChunk(0, 0);
  world.setBlock(3, 70, 3, BLOCKS.STONE.id);
  assert.equal(world.getBlock(3, 70, 3), BLOCKS.STONE.id);
  assert.ok(world.edits.has('3,70,3'));

  // Cast straight down onto the placed block from above.
  const hit = world.raycast([3.5, 75, 3.5], [0, -1, 0], 10);
  assert.ok(hit.hit);
  assert.deepEqual(hit.block, [3, 70, 3]);
  // Normal should point up (we came from above).
  assert.deepEqual(hit.normal, [0, 1, 0]);
});

test('world: ensureChunk is idempotent', () => {
  const world = new World('idem');
  const c1 = world.ensureChunk(2, 2);
  const c2 = world.ensureChunk(2, 2);
  assert.equal(c1, c2);
});

test('inventory: stacking, overflow, remove, consume, swap', () => {
  const inv = new Inventory();
  const leftover = inv.add(BLOCKS.DIRT.id, MAX_STACK + 5);
  assert.equal(leftover, 0);
  assert.equal(inv.count(BLOCKS.DIRT.id), MAX_STACK + 5);

  assert.equal(inv.remove(BLOCKS.DIRT.id, 10), 10);
  assert.equal(inv.count(BLOCKS.DIRT.id), MAX_STACK - 5);

  inv.selected = 0;
  const before = inv.count(BLOCKS.DIRT.id);
  const consumed = inv.consumeSelected();
  assert.equal(consumed, BLOCKS.DIRT.id);
  assert.equal(inv.count(BLOCKS.DIRT.id), before - 1);

  // Swap two slots.
  inv.slots[10] = { id: BLOCKS.STONE.id, count: 3 };
  inv.swap(0, 10);
  assert.equal(inv.slots[0].id, BLOCKS.STONE.id);
});

test('inventory: overflow returns remainder when full', () => {
  const inv = new Inventory(1); // single slot
  const leftover = inv.add(BLOCKS.DIRT.id, MAX_STACK + 10);
  assert.equal(leftover, 10);
});

test('crafting: wood -> planks; unknown mix -> null', () => {
  const grid = [{ id: BLOCKS.WOOD.id, count: 1 }, null, null, null];
  const r = matchRecipe(grid);
  assert.ok(r);
  assert.equal(r.result.id, BLOCKS.PLANK.id);
  assert.equal(r.result.count, 4);

  const bad = [
    { id: BLOCKS.WOOD.id, count: 1 },
    { id: BLOCKS.STONE.id, count: 1 },
    null, null,
  ];
  assert.equal(matchRecipe(bad), null);

  assert.equal(matchRecipe([null, null, null, null]), null);
  assert.ok(RECIPES.length >= 3);
});

test('player: gravity makes the player fall and land on ground', () => {
  const world = new World('phys');
  world.ensureChunk(0, 0);
  // Build a floor at y=64 around origin.
  for (let x = -2; x <= 2; x++)
    for (let z = -2; z <= 2; z++)
      world.setBlock(x, 64, z, BLOCKS.STONE.id);

  const player = new Player(0.5, 80, 0.5);
  const input = { forward: false, back: false, left: false, right: false, jump: false, sneak: false, run: false };
  for (let i = 0; i < 200; i++) player.update(0.05, input, world);
  // Should have landed on top of the floor (y = 65).
  assert.ok(player.onGround, 'player should be on ground');
  assert.ok(Math.abs(player.position.y - 65) < 0.05, `landed at ${player.position.y}`);
});

test('player: cannot fall through; collides walking into a wall', () => {
  const world = new World('wall');
  world.ensureChunk(0, 0);
  for (let x = -2; x <= 2; x++)
    for (let z = -2; z <= 2; z++)
      world.setBlock(x, 64, z, BLOCKS.STONE.id);
  // Wall at x=2.
  for (let y = 65; y <= 67; y++)
    for (let z = -2; z <= 2; z++)
      world.setBlock(2, y, z, BLOCKS.STONE.id);

  const player = new Player(0.5, 66, 0.5);
  const input = { forward: false, back: false, left: false, right: true, jump: false, sneak: false, run: false };
  // Walk toward +x into the wall for a while (right maps to +x at yaw 0).
  for (let i = 0; i < 100; i++) player.update(0.05, input, world);
  assert.ok(player.position.x < 2 - player.half + 0.01, `stopped by wall at ${player.position.x}`);
});

test('save: round-trips edits, player and inventory', () => {
  const world = new World('saveseed');
  world.ensureChunk(0, 0);
  world.setBlock(1, 70, 1, BLOCKS.GLASS.id);
  const player = new Player(5, 72, 6);
  player.yaw = 1.2; player.pitch = -0.3; player.flying = true;
  const inv = new Inventory();
  inv.add(BLOCKS.STONE.id, 20);
  inv.selected = 2;

  const snap = buildSave(world, player, inv);
  const json = JSON.parse(JSON.stringify(snap)); // ensure serializable

  const world2 = new World(json.seed);
  const player2 = new Player(0, 0, 0);
  const inv2 = new Inventory();
  applySave(json, world2, player2, inv2);

  assert.equal(world2.edits.get('1,70,1'), BLOCKS.GLASS.id);
  assert.equal(player2.position.x, 5);
  assert.equal(player2.flying, true);
  assert.equal(inv2.count(BLOCKS.STONE.id), 20);
  assert.equal(inv2.selected, 2);

  // After regenerating that chunk, the saved edit must be applied.
  const c = world2.ensureChunk(0, 0);
  assert.equal(world2.getBlock(1, 70, 1), BLOCKS.GLASS.id);
});
