// Chunk data + mesh building. Pure logic (produces plain typed arrays), so the
// geometry builder is unit-testable in Node without Three.js.

import { ATLAS_COLS, ATLAS_ROWS, BLOCK_BY_ID, getBlock } from './blocks.js';

export const CHUNK_SIZE = 16;     // x and z
export const WORLD_HEIGHT = 128;  // y

export function chunkIndex(x, y, z) {
  return x + z * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE;
}

export function inChunkBounds(x, y, z) {
  return (
    x >= 0 && x < CHUNK_SIZE &&
    z >= 0 && z < CHUNK_SIZE &&
    y >= 0 && y < WORLD_HEIGHT
  );
}

export class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.blocks = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
    this.dirty = true;     // needs remesh
    this.generated = false;
    this.mesh = null;      // Three.js Mesh (set by renderer)
  }

  get(x, y, z) {
    if (!inChunkBounds(x, y, z)) return 0;
    return this.blocks[chunkIndex(x, y, z)];
  }

  set(x, y, z, id) {
    if (!inChunkBounds(x, y, z)) return;
    this.blocks[chunkIndex(x, y, z)] = id;
    this.dirty = true;
  }
}

// Per-face geometry data. Faces order matches blocks.js faces array:
// [px, nx, py, ny, pz, nz].
const FACES = [
  { // +X
    dir: [1, 0, 0],
    corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
    normal: [1, 0, 0],
  },
  { // -X
    dir: [-1, 0, 0],
    corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]],
    normal: [-1, 0, 0],
  },
  { // +Y (top)
    dir: [0, 1, 0],
    corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
    normal: [0, 1, 0],
  },
  { // -Y (bottom)
    dir: [0, -1, 0],
    corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
    normal: [0, -1, 0],
  },
  { // +Z
    dir: [0, 0, 1],
    corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]],
    normal: [0, 0, 1],
  },
  { // -Z
    dir: [0, 0, -1],
    corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
    normal: [0, 0, -1],
  },
];

const PAD = 0.001; // shrink UVs slightly to avoid atlas bleeding

function tileUV(tileIndexValue) {
  const col = tileIndexValue % ATLAS_COLS;
  const row = Math.floor(tileIndexValue / ATLAS_COLS);
  const u0 = col / ATLAS_COLS + PAD;
  const v0 = 1 - (row + 1) / ATLAS_ROWS + PAD;
  const u1 = (col + 1) / ATLAS_COLS - PAD;
  const v1 = 1 - row / ATLAS_ROWS - PAD;
  return [u0, v0, u1, v1];
}

// Should a face between `self` and `neighbour` be drawn?
function shouldDrawFace(selfId, neighbourId) {
  if (neighbourId === 0) return true; // air
  const nb = BLOCK_BY_ID[neighbourId];
  if (!nb) return true;
  // Draw if neighbour is transparent AND it's a different block type
  // (so adjacent water/leaves of the same kind don't draw internal faces).
  if (nb.transparent && neighbourId !== selfId) return true;
  return false;
}

// Build geometry arrays for a chunk. `getWorldBlock(wx, wy, wz)` returns the
// block id at world coordinates (used for cross-chunk face culling).
// Returns { positions, normals, uvs, colors, indices } as plain arrays.
export function buildChunkGeometry(chunk, getWorldBlock) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  let vertCount = 0;

  const baseX = chunk.cx * CHUNK_SIZE;
  const baseZ = chunk.cz * CHUNK_SIZE;

  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const id = chunk.blocks[chunkIndex(x, y, z)];
        if (id === 0) continue;
        const block = BLOCK_BY_ID[id];
        if (!block || !block.faces) continue;

        const wx = baseX + x;
        const wz = baseZ + z;

        for (let f = 0; f < 6; f++) {
          const face = FACES[f];
          const nx = wx + face.dir[0];
          const ny = y + face.dir[1];
          const nz = wz + face.dir[2];
          const neighbourId = getWorldBlock(nx, ny, nz);
          if (!shouldDrawFace(id, neighbourId)) continue;

          const tile = block.faces[f];
          const [u0, v0, u1, v1] = tileUV(tile);
          // Per-face UV corner order matching `corners`.
          const faceUV = [
            [u0, v0], [u0, v1], [u1, v1], [u1, v0],
          ];

          // Simple ambient-style face shading for depth perception.
          let shade = 1.0;
          if (f === 2) shade = 1.0;        // top brightest
          else if (f === 3) shade = 0.55;  // bottom darkest
          else if (f === 0 || f === 1) shade = 0.8;
          else shade = 0.7;

          for (let c = 0; c < 4; c++) {
            const corner = face.corners[c];
            positions.push(wx + corner[0], y + corner[1], wz + corner[2]);
            normals.push(face.normal[0], face.normal[1], face.normal[2]);
            uvs.push(faceUV[c][0], faceUV[c][1]);
            colors.push(shade, shade, shade);
          }
          indices.push(
            vertCount, vertCount + 1, vertCount + 2,
            vertCount, vertCount + 2, vertCount + 3
          );
          vertCount += 4;
        }
      }
    }
  }

  return { positions, normals, uvs, colors, indices };
}
