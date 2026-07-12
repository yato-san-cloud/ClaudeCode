// ============================================================
//  Bomberman — bombs & explosions
//
//  Classic <script> file: declares top-level `class Bomb`,
//  `class Explosion`, and `function computeExplosion(...)`.
//  Relies on globals from config.js (TILE, DIRS, DIR_LIST,
//  BOMB_FUSE_MS, EXPLOSION_MS).
// ============================================================

// ---- Bomb ---------------------------------------------------
class Bomb {
  constructor(col, row, range, owner) {
    this.col = col;
    this.row = row;
    this.range = range;
    this.owner = owner;
    this.fuse = BOMB_FUSE_MS; // ms remaining before detonation
    this.t = 0;               // seconds elapsed (for animation)
  }

  // dt is in SECONDS; fuse is tracked in ms.
  update(dt) {
    this.fuse -= dt * 1000;
    this.t += dt;
  }

  get exploded() {
    return this.fuse <= 0;
  }

  detonateNow() {
    this.fuse = 0;
  }

  cell() {
    return { col: this.col, row: this.row };
  }

  center() {
    return { x: this.col * TILE + TILE / 2, y: this.row * TILE + TILE / 2 };
  }
}

// ---- computeExplosion ---------------------------------------
// Returns { cells, bricks }. cells describe every flame tile;
// bricks are the {col,row} of bricks the blast destroys.
function computeExplosion(col, row, range, map) {
  const cells = [{ col: col, row: row, dir: 'center', kind: 'center' }];
  const bricks = [];

  for (const dir of DIR_LIST) {
    const d = DIRS[dir];
    for (let step = 1; step <= range; step++) {
      const c = col + d.dc * step;
      const r = row + d.dr * step;

      if (map.isWall(c, r)) {
        break; // hard wall stops the flame; don't include it
      }
      if (map.isBrick(c, r)) {
        cells.push({ col: c, row: r, dir: dir, kind: 'tip' });
        bricks.push({ col: c, row: r });
        break; // brick absorbs the flame at its tip
      }
      cells.push({ col: c, row: r, dir: dir, kind: (step === range ? 'tip' : 'arm') });
    }
  }

  return { cells: cells, bricks: bricks };
}

// ---- Explosion ----------------------------------------------
class Explosion {
  constructor(cells) {
    this.cells = cells;
    this.life = EXPLOSION_MS; // ms remaining
    this.t = 0;               // seconds elapsed
    this.done = false;

    // O(1) coverage lookups keyed by 'col,row'.
    this._keys = new Set();
    for (const cell of cells) {
      this._keys.add(cell.col + ',' + cell.row);
    }
  }

  update(dt) {
    this.life -= dt * 1000;
    this.t += dt;
    if (this.life <= 0) {
      this.done = true;
    }
  }

  covers(col, row) {
    return this._keys.has(col + ',' + row);
  }

  progress() {
    const p = (EXPLOSION_MS - this.life) / EXPLOSION_MS;
    return p < 0 ? 0 : (p > 1 ? 1 : p);
  }
}
