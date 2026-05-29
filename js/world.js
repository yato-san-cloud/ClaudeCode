// World manager: chunk storage, block get/set across chunks, tree decoration
// with cross-chunk deferral, player-edit tracking for saves, and a DDA voxel
// raycast. Pure logic — no Three.js, so it is Node-testable.

import { Chunk, CHUNK_SIZE, WORLD_HEIGHT, chunkIndex } from './chunk.js';
import { TerrainGenerator, SEA_LEVEL } from './terrain.js';
import { BLOCKS, isSolid } from './blocks.js';

export function chunkKey(cx, cz) {
  return cx + ',' + cz;
}

export function worldToChunk(wx, wz) {
  return {
    cx: Math.floor(wx / CHUNK_SIZE),
    cz: Math.floor(wz / CHUNK_SIZE),
  };
}

export class World {
  constructor(seed = 'minecraft') {
    this.seed = seed;
    this.gen = new TerrainGenerator(seed);
    this.chunks = new Map();        // key -> Chunk
    this.pending = new Map();       // chunkKey -> [{lx,ly,lz,id}] decoration spillover
    this.edits = new Map();         // "wx,wy,wz" -> id  (player edits, for saving)
    this.newlyDirty = new Set();    // chunkKeys needing remesh (consumed by renderer)
  }

  getChunk(cx, cz) {
    return this.chunks.get(chunkKey(cx, cz));
  }

  hasChunk(cx, cz) {
    const c = this.chunks.get(chunkKey(cx, cz));
    return !!(c && c.generated);
  }

  ensureChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    let chunk = this.chunks.get(key);
    if (chunk && chunk.generated) return chunk;
    if (!chunk) {
      chunk = new Chunk(cx, cz);
      this.chunks.set(key, chunk);
    }
    this.gen.generateChunkTerrain(chunk);

    // Apply any decoration spillover queued before this chunk existed.
    const pend = this.pending.get(key);
    if (pend) {
      for (const e of pend) {
        const idx = chunkIndex(e.lx, e.ly, e.lz);
        if (chunk.blocks[idx] === 0 || e.overwrite) chunk.blocks[idx] = e.id;
      }
      this.pending.delete(key);
    }

    // Decorate with trees (may write into neighbouring chunks).
    const trees = this.gen.collectTrees(cx, cz);
    for (const t of trees) this._placeTree(t.x, t.y, t.z);

    // Re-apply player edits for this chunk so saves survive regeneration.
    // Skip entirely when nothing has been edited (the common first-load case).
    if (this.edits.size > 0) {
      const baseX = cx * CHUNK_SIZE;
      const baseZ = cz * CHUNK_SIZE;
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          for (let y = 0; y < WORLD_HEIGHT; y++) {
            const ek = (baseX + lx) + ',' + y + ',' + (baseZ + lz);
            if (this.edits.has(ek)) {
              chunk.blocks[chunkIndex(lx, y, lz)] = this.edits.get(ek);
            }
          }
        }
      }
    }

    chunk.dirty = true;
    this.newlyDirty.add(key);
    return chunk;
  }

  _placeTree(wx, baseY, wz) {
    const trunkH = 4 + (Math.abs((wx * 31 + wz * 17) % 3));
    // Leaves canopy.
    const top = baseY + trunkH;
    for (let dy = -2; dy <= 1; dy++) {
      const r = dy <= -1 ? 2 : 1;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx === 0 && dz === 0 && dy < 1) continue; // leave room for trunk
          if (Math.abs(dx) === r && Math.abs(dz) === r && Math.random() < 0.4) continue;
          this._decorate(wx + dx, top + dy, wz + dz, BLOCKS.LEAVES.id, false);
        }
      }
    }
    // Trunk.
    for (let i = 0; i < trunkH; i++) {
      this._decorate(wx, baseY + i, wz, BLOCKS.WOOD.id, true);
    }
  }

  // Decoration write: applies to a generated chunk or queues spillover.
  _decorate(wx, wy, wz, id, overwrite) {
    if (wy < 0 || wy >= WORLD_HEIGHT) return;
    const { cx, cz } = worldToChunk(wx, wz);
    const key = chunkKey(cx, cz);
    const chunk = this.chunks.get(key);
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    if (chunk && chunk.generated) {
      const idx = chunkIndex(lx, wy, lz);
      if (chunk.blocks[idx] === 0 || overwrite) {
        chunk.blocks[idx] = id;
        chunk.dirty = true;
        this.newlyDirty.add(key);
      }
    } else {
      let arr = this.pending.get(key);
      if (!arr) { arr = []; this.pending.set(key, arr); }
      arr.push({ lx, ly: wy, lz, id, overwrite });
    }
  }

  getBlock(wx, wy, wz) {
    if (wy < 0 || wy >= WORLD_HEIGHT) return 0;
    const { cx, cz } = worldToChunk(wx, wz);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk || !chunk.generated) return 0;
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    return chunk.blocks[chunkIndex(lx, wy, lz)];
  }

  // Player-facing block set: applies, records for save, flags affected chunks.
  setBlock(wx, wy, wz, id) {
    if (wy < 0 || wy >= WORLD_HEIGHT) return false;
    const { cx, cz } = worldToChunk(wx, wz);
    const chunk = this.ensureChunk(cx, cz);
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    chunk.blocks[chunkIndex(lx, wy, lz)] = id;
    chunk.dirty = true;
    this.newlyDirty.add(chunkKey(cx, cz));
    this.edits.set(wx + ',' + wy + ',' + wz, id);

    // Mark neighbour chunks dirty when editing on a chunk border.
    if (lx === 0) this._flagNeighbour(cx - 1, cz);
    if (lx === CHUNK_SIZE - 1) this._flagNeighbour(cx + 1, cz);
    if (lz === 0) this._flagNeighbour(cx, cz - 1);
    if (lz === CHUNK_SIZE - 1) this._flagNeighbour(cx, cz + 1);
    return true;
  }

  _flagNeighbour(cx, cz) {
    const key = chunkKey(cx, cz);
    const c = this.chunks.get(key);
    if (c && c.generated) {
      c.dirty = true;
      this.newlyDirty.add(key);
    }
  }

  // Highest solid (non-air, non-water) block at a column; for spawning.
  surfaceHeight(wx, wz) {
    const { cx, cz } = worldToChunk(wx, wz);
    this.ensureChunk(cx, cz);
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      const id = this.getBlock(wx, y, wz);
      if (id !== 0 && id !== BLOCKS.WATER.id) return y + 1;
    }
    return SEA_LEVEL + 1;
  }

  // DDA voxel raycast. origin/dir are arrays [x,y,z]; dir need not be unit.
  // Returns { hit, block:[x,y,z], normal:[x,y,z], id } or { hit:false }.
  raycast(origin, dir, maxDist = 8) {
    let [ox, oy, oz] = origin;
    let [dx, dy, dz] = dir;
    const len = Math.hypot(dx, dy, dz);
    if (len === 0) return { hit: false };
    dx /= len; dy /= len; dz /= len;

    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);

    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    const stepZ = Math.sign(dz);

    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

    const distToBoundary = (o, s) => {
      const cell = Math.floor(o);
      return s > 0 ? cell + 1 - o : o - cell;
    };
    let tMaxX = dx !== 0 ? distToBoundary(ox, stepX) * tDeltaX : Infinity;
    let tMaxY = dy !== 0 ? distToBoundary(oy, stepY) * tDeltaY : Infinity;
    let tMaxZ = dz !== 0 ? distToBoundary(oz, stepZ) * tDeltaZ : Infinity;

    let normal = [0, 0, 0];
    let t = 0;
    while (t <= maxDist) {
      const id = this.getBlock(x, y, z);
      if (id !== 0 && isSolid(id)) {
        return { hit: true, block: [x, y, z], normal, id };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; normal = [-stepX, 0, 0];
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; normal = [0, -stepY, 0];
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; normal = [0, 0, -stepZ];
      }
    }
    return { hit: false };
  }
}
