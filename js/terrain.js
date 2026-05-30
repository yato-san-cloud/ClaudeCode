// Procedural terrain generation. Pure logic (no DOM / Three.js) -> testable.

import { Perlin2D, hashSeed, mulberry32 } from './noise.js';
import { BLOCKS } from './blocks.js';
import { CHUNK_SIZE, WORLD_HEIGHT, chunkIndex } from './chunk.js';

export const SEA_LEVEL = 40;

export const BIOME = {
  OCEAN: 'ocean',
  BEACH: 'beach',
  PLAINS: 'plains',
  DESERT: 'desert',
  MOUNTAINS: 'mountains',
  SNOW: 'snow',
};

export class TerrainGenerator {
  constructor(seed = 'minecraft') {
    this.seed = seed;
    const s = hashSeed(seed);
    this.heightNoise = new Perlin2D(s ^ 0x9e3779b9);
    this.detailNoise = new Perlin2D(s ^ 0x85ebca6b);
    this.biomeNoise = new Perlin2D(s ^ 0xc2b2ae35);
    this.tempNoise = new Perlin2D(s ^ 0x27d4eb2f);
    this.caveNoise = new Perlin2D(s ^ 0x165667b1);
    this.oreNoise = new Perlin2D(s ^ 0xd3a2646c);
  }

  biomeAt(wx, wz) {
    const b = this.biomeNoise.fbm(wx, wz, 2, 0.5, 2, 0.0035);
    const t = this.tempNoise.fbm(wx, wz, 2, 0.5, 2, 0.0021);
    if (b > 0.45) return BIOME.MOUNTAINS;
    if (t > 0.5) return BIOME.DESERT;
    if (t < -0.5) return BIOME.SNOW;
    return BIOME.PLAINS;
  }

  heightAt(wx, wz) {
    // Base rolling terrain.
    let h = this.heightNoise.fbm(wx, wz, 5, 0.5, 2, 0.006);
    // Detail ridges.
    const d = this.detailNoise.fbm(wx, wz, 3, 0.5, 2.2, 0.02);
    h = h * 0.8 + d * 0.2;

    const biome = this.biomeAt(wx, wz);
    let amplitude = 18;
    let base = SEA_LEVEL;
    if (biome === BIOME.MOUNTAINS) {
      amplitude = 48;
      base = SEA_LEVEL + 6;
    } else if (biome === BIOME.DESERT) {
      amplitude = 10;
      base = SEA_LEVEL + 1;
    } else if (biome === BIOME.PLAINS || biome === BIOME.SNOW) {
      amplitude = 14;
    }
    let height = Math.floor(base + h * amplitude);
    if (height < 4) height = 4;
    if (height > WORLD_HEIGHT - 12) height = WORLD_HEIGHT - 12;
    return height;
  }

  // 3D-ish cave carving using layered 2D noise sampled at offset planes.
  isCave(wx, wy, wz) {
    if (wy < 6 || wy > SEA_LEVEL + 6) return false;
    const a = this.caveNoise.fbm(wx, wz + wy * 31.7, 3, 0.5, 2, 0.05);
    const b = this.caveNoise.fbm(wx + wy * 17.3, wz, 3, 0.5, 2, 0.05);
    return a * a + b * b < 0.012;
  }

  oreAt(wx, wy, wz) {
    // Deterministic per-voxel ore roll, denser deeper.
    const n = this.oreNoise.fbm(wx + wy * 7.1, wz - wy * 3.3, 2, 0.5, 2, 0.08);
    if (wy < 24 && n > 0.72) return BLOCKS.IRON.id;
    if (wy < 48 && n > 0.66) return BLOCKS.COAL.id;
    return 0;
  }

  // Fill a chunk's base terrain (no trees — those are decorated separately).
  generateChunkTerrain(chunk) {
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    const B = BLOCKS;

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        const height = this.heightAt(wx, wz);
        const biome = this.biomeAt(wx, wz);

        for (let y = 0; y <= Math.max(height, SEA_LEVEL); y++) {
          let id = 0;
          if (y === 0) {
            id = B.BEDROCK.id;
          } else if (y > height) {
            // Above the surface: water up to sea level.
            id = y <= SEA_LEVEL ? B.WATER.id : 0;
          } else if (y === height) {
            // Surface block by biome.
            if (height <= SEA_LEVEL) {
              id = B.SAND.id; // underwater / shoreline
            } else if (biome === BIOME.DESERT) {
              id = B.SAND.id;
            } else if (biome === BIOME.SNOW) {
              id = B.SNOW.id;
            } else if (biome === BIOME.MOUNTAINS && height > SEA_LEVEL + 28) {
              id = B.STONE.id;
            } else {
              id = B.GRASS.id;
            }
          } else if (y >= height - 3) {
            id = biome === BIOME.DESERT ? B.SAND.id : B.DIRT.id;
          } else {
            id = B.STONE.id;
            const ore = this.oreAt(wx, y, wz);
            if (ore) id = ore;
          }

          // Carve caves out of solid stone/dirt (not water/bedrock surface).
          if (id !== 0 && id !== B.WATER.id && id !== B.BEDROCK.id && y < height && this.isCave(wx, y, wz)) {
            id = 0;
          }

          if (id !== 0) chunk.blocks[chunkIndex(lx, y, wz - baseZ)] = id;
        }
      }
    }
    chunk.generated = true;
  }

  // Deterministic tree positions for a chunk. Returns world-coord trunk bases.
  collectTrees(cx, cz) {
    const trees = [];
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        const biome = this.biomeAt(wx, wz);
        if (biome === BIOME.DESERT || biome === BIOME.OCEAN) continue;
        const height = this.heightAt(wx, wz);
        if (height <= SEA_LEVEL) continue;
        // Per-column deterministic chance.
        const rng = mulberry32(hashSeed(`${this.seed}:${wx}:${wz}`));
        const density = biome === BIOME.MOUNTAINS ? 0.012 : 0.025;
        if (rng() < density) {
          trees.push({ x: wx, y: height + 1, z: wz });
        }
      }
    }
    return trees;
  }
}
