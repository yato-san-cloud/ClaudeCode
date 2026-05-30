// Procedural texture atlas generated on a <canvas>. Avoids shipping any binary
// image assets — every block texture is painted at runtime. Browser-only.

import { ATLAS_COLS, ATLAS_ROWS, TILES } from './blocks.js';

const TILE_PX = 16; // texels per tile

// Tiny deterministic per-pixel jitter so textures look grainy, not flat.
function noiseAt(x, y, salt) {
  const n = Math.sin((x * 12.9898 + y * 78.233 + salt * 37.719)) * 43758.5453;
  return n - Math.floor(n); // 0..1
}

function shade(hex, amt) {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  const f = 1 + amt;
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${cl(r)},${cl(g)},${cl(b)})`;
}

// Paint a single tile with a base colour + grain.
function paintGrain(ctx, ox, oy, base, grain = 0.12, salt = 1) {
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      const n = (noiseAt(x, y, salt) - 0.5) * 2 * grain;
      ctx.fillStyle = shade(base, n);
      ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  }
}

// Each painter draws into the tile at (ox,oy).
const PAINTERS = {
  [key(TILES.GRASS_TOP)]: (c, x, y) => paintGrain(c, x, y, 0x5fae46, 0.16, 3),
  [key(TILES.GRASS_SIDE)]: (c, x, y) => {
    paintGrain(c, x, y, 0x8a6240, 0.12, 4); // dirt base
    // green top strip
    for (let yy = 0; yy < 5; yy++) {
      for (let xx = 0; xx < TILE_PX; xx++) {
        const n = (noiseAt(xx, yy, 9) - 0.5) * 0.3;
        c.fillStyle = shade(0x5fae46, n);
        const jag = yy === 4 ? (noiseAt(xx, 1, 7) > 0.5 ? 1 : 0) : 1;
        if (jag) c.fillRect(x + xx, y + yy, 1, 1);
      }
    }
  },
  [key(TILES.DIRT)]: (c, x, y) => paintGrain(c, x, y, 0x8a6240, 0.14, 4),
  [key(TILES.STONE)]: (c, x, y) => paintGrain(c, x, y, 0x888888, 0.13, 5),
  [key(TILES.SAND)]: (c, x, y) => paintGrain(c, x, y, 0xe0d29a, 0.08, 6),
  [key(TILES.WOOD_TOP)]: (c, x, y) => {
    paintGrain(c, x, y, 0xb5905a, 0.1, 7);
    c.fillStyle = shade(0x6e5230, 0);
    c.fillRect(x + 6, y + 6, 4, 4);
  },
  [key(TILES.WOOD_SIDE)]: (c, x, y) => {
    paintGrain(c, x, y, 0x7a5c34, 0.08, 8);
    for (let xx = 0; xx < TILE_PX; xx += 4) {
      c.fillStyle = shade(0x5e441f, 0);
      c.fillRect(x + xx, y, 1, TILE_PX);
    }
  },
  [key(TILES.LEAVES)]: (c, x, y) => paintGrain(c, x, y, 0x3c8f33, 0.22, 9),
  [key(TILES.WATER)]: (c, x, y) => paintGrain(c, x, y, 0x3a6fd0, 0.06, 10),
  [key(TILES.COBBLE)]: (c, x, y) => {
    paintGrain(c, x, y, 0x787878, 0.18, 11);
    c.fillStyle = shade(0x555555, 0);
    for (let i = 0; i < 6; i++) {
      const rx = Math.floor(noiseAt(i, 1, 12) * 12);
      const ry = Math.floor(noiseAt(i, 2, 13) * 12);
      c.fillRect(x + rx, y + ry, 3, 3);
    }
  },
  [key(TILES.PLANK)]: (c, x, y) => {
    paintGrain(c, x, y, 0xb98a4f, 0.08, 14);
    c.fillStyle = shade(0x8a6638, 0);
    for (let yy = 0; yy < TILE_PX; yy += 4) c.fillRect(x, y + yy, TILE_PX, 1);
  },
  [key(TILES.BEDROCK)]: (c, x, y) => paintGrain(c, x, y, 0x444444, 0.3, 15),
  [key(TILES.GLASS)]: (c, x, y) => {
    paintGrain(c, x, y, 0xbfe6f0, 0.05, 16);
    c.fillStyle = 'rgba(255,255,255,0.6)';
    c.fillRect(x + 1, y + 1, TILE_PX - 2, 1);
    c.fillRect(x + 1, y + 1, 1, TILE_PX - 2);
  },
  [key(TILES.COAL)]: (c, x, y) => {
    paintGrain(c, x, y, 0x888888, 0.13, 5);
    c.fillStyle = '#1a1a1a';
    for (let i = 0; i < 5; i++) {
      const rx = Math.floor(noiseAt(i, 3, 21) * 12);
      const ry = Math.floor(noiseAt(i, 4, 22) * 12);
      c.fillRect(x + rx, y + ry, 3, 3);
    }
  },
  [key(TILES.IRON)]: (c, x, y) => {
    paintGrain(c, x, y, 0x888888, 0.13, 5);
    c.fillStyle = '#caa67a';
    for (let i = 0; i < 5; i++) {
      const rx = Math.floor(noiseAt(i, 5, 31) * 12);
      const ry = Math.floor(noiseAt(i, 6, 32) * 12);
      c.fillRect(x + rx, y + ry, 3, 3);
    }
  },
  [key(TILES.SNOW)]: (c, x, y) => paintGrain(c, x, y, 0xf4fbff, 0.05, 40),
};

function key([col, row]) {
  return col + '_' + row;
}

// Build and return the atlas canvas.
export function buildAtlasCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * TILE_PX;
  canvas.height = ATLAS_ROWS * TILE_PX;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // Default fill (magenta = missing) helps catch unpainted tiles.
  ctx.fillStyle = '#ff00ff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const k in PAINTERS) {
    const [col, row] = k.split('_').map(Number);
    PAINTERS[k](ctx, col * TILE_PX, row * TILE_PX);
  }
  return canvas;
}
