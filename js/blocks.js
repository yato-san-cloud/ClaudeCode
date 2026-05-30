// Block registry — pure data, no DOM. Safe to import in Node tests.
//
// Each block has per-face tile indices into the texture atlas (a 4x4 grid).
// Faces order: [px, nx, py, ny, pz, nz] = [+X, -X, +Y(top), -Y(bottom), +Z, -Z].
// `solid` controls collision + face culling. `transparent` controls whether a
// neighbouring face should still be drawn (e.g. leaves, water, glass).

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 4;

// Atlas tile coordinates (col, row). Used both for procedural texture
// generation and for UV mapping.
export const TILES = {
  GRASS_TOP: [0, 0],
  GRASS_SIDE: [1, 0],
  DIRT: [2, 0],
  STONE: [3, 0],
  SAND: [0, 1],
  WOOD_TOP: [1, 1],
  WOOD_SIDE: [2, 1],
  LEAVES: [3, 1],
  WATER: [0, 2],
  COBBLE: [1, 2],
  PLANK: [2, 2],
  BEDROCK: [3, 2],
  GLASS: [0, 3],
  COAL: [1, 3],
  IRON: [2, 3],
  SNOW: [3, 3],
};

function tileIndex([col, row]) {
  return row * ATLAS_COLS + col;
}

function uniform(tile) {
  const i = tileIndex(tile);
  return [i, i, i, i, i, i];
}

function topBottomSide(top, bottom, side) {
  const t = tileIndex(top);
  const b = tileIndex(bottom);
  const s = tileIndex(side);
  // [px, nx, py(top), ny(bottom), pz, nz]
  return [s, s, t, b, s, s];
}

// id 0 is reserved for AIR.
export const BLOCKS = {
  AIR:     { id: 0, name: 'Air', solid: false, transparent: true, faces: null },
  GRASS:   { id: 1, name: 'Grass', solid: true, transparent: false, faces: topBottomSide(TILES.GRASS_TOP, TILES.DIRT, TILES.GRASS_SIDE) },
  DIRT:    { id: 2, name: 'Dirt', solid: true, transparent: false, faces: uniform(TILES.DIRT) },
  STONE:   { id: 3, name: 'Stone', solid: true, transparent: false, faces: uniform(TILES.STONE) },
  SAND:    { id: 4, name: 'Sand', solid: true, transparent: false, faces: uniform(TILES.SAND) },
  WOOD:    { id: 5, name: 'Wood', solid: true, transparent: false, faces: topBottomSide(TILES.WOOD_TOP, TILES.WOOD_TOP, TILES.WOOD_SIDE) },
  LEAVES:  { id: 6, name: 'Leaves', solid: true, transparent: true, faces: uniform(TILES.LEAVES) },
  WATER:   { id: 7, name: 'Water', solid: false, transparent: true, liquid: true, faces: uniform(TILES.WATER) },
  COBBLE:  { id: 8, name: 'Cobblestone', solid: true, transparent: false, faces: uniform(TILES.COBBLE) },
  PLANK:   { id: 9, name: 'Planks', solid: true, transparent: false, faces: uniform(TILES.PLANK) },
  BEDROCK: { id: 10, name: 'Bedrock', solid: true, transparent: false, faces: uniform(TILES.BEDROCK) },
  GLASS:   { id: 11, name: 'Glass', solid: true, transparent: true, faces: uniform(TILES.GLASS) },
  COAL:    { id: 12, name: 'Coal Ore', solid: true, transparent: false, faces: uniform(TILES.COAL) },
  IRON:    { id: 13, name: 'Iron Ore', solid: true, transparent: false, faces: uniform(TILES.IRON) },
  SNOW:    { id: 14, name: 'Snow', solid: true, transparent: false, faces: topBottomSide(TILES.SNOW, TILES.DIRT, TILES.SNOW) },
};

// id -> block lookup.
export const BLOCK_BY_ID = (() => {
  const arr = [];
  for (const key in BLOCKS) {
    const b = BLOCKS[key];
    arr[b.id] = { key, ...b };
  }
  return arr;
})();

export function getBlock(id) {
  return BLOCK_BY_ID[id] || BLOCKS.AIR;
}

export function isSolid(id) {
  const b = BLOCK_BY_ID[id];
  return b ? !!b.solid : false;
}

export function isTransparent(id) {
  const b = BLOCK_BY_ID[id];
  return b ? !!b.transparent : true;
}

export function isLiquid(id) {
  const b = BLOCK_BY_ID[id];
  return b ? !!b.liquid : false;
}
