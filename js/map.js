// ============================================================
//  Bomberman — GameMap
//
//  Owns the tile grid: grid[row][col] holds a TileType.
//  Border cells and (even,even) interior "pillar" cells are WALL;
//  other interior cells are BRICK (prob BRICK_DENSITY) else EMPTY.
//  Reserved cells (player start + enemy spawns) are forced EMPTY.
//
//  Classic <script>: `class GameMap` becomes a top-level global.
// ============================================================

class GameMap {
  constructor() {
    this.cols = COLS;
    this.rows = ROWS;
    this.grid = [];
    this.generate([]);
  }

  // Build a fresh maze. `reserved` = array of {col,row} forced to EMPTY.
  generate(reserved) {
    const grid = new Array(this.rows);
    for (let row = 0; row < this.rows; row++) {
      const line = new Array(this.cols);
      for (let col = 0; col < this.cols; col++) {
        if (row === 0 || col === 0 || row === this.rows - 1 || col === this.cols - 1) {
          // Outer border is always hard wall.
          line[col] = TileType.WALL;
        } else if (row % 2 === 0 && col % 2 === 0) {
          // Interior pillars form the classic grid of hard walls.
          line[col] = TileType.WALL;
        } else {
          // Remaining interior cells: brick with probability BRICK_DENSITY.
          line[col] = (Math.random() < BRICK_DENSITY) ? TileType.BRICK : TileType.EMPTY;
        }
      }
      grid[row] = line;
    }
    this.grid = grid;

    // Force reserved cells clear (player spawn box + enemy spawns).
    if (reserved) {
      for (let i = 0; i < reserved.length; i++) {
        const r = reserved[i];
        if (r && this.inBounds(r.col, r.row)) {
          this.grid[r.row][r.col] = TileType.EMPTY;
        }
      }
    }
    return this.grid;
  }

  // ---- Bounds-safe queries (OOB behaves as a solid wall) -----

  inBounds(col, row) {
    return col >= 0 && row >= 0 && col < this.cols && row < this.rows;
  }

  tileAt(col, row) {
    if (!this.inBounds(col, row)) return TileType.WALL;
    return this.grid[row][col];
  }

  setTile(col, row, type) {
    if (this.inBounds(col, row)) this.grid[row][col] = type;
  }

  isWall(col, row) {
    // Hard, indestructible wall OR out of bounds.
    return this.tileAt(col, row) === TileType.WALL;
  }

  isBrick(col, row) {
    return this.tileAt(col, row) === TileType.BRICK;
  }

  isEmpty(col, row) {
    // OOB is not empty (it is a wall).
    return this.inBounds(col, row) && this.grid[row][col] === TileType.EMPTY;
  }

  // Blocks movement AND stops explosion flames. OOB counts as solid.
  isSolidTile(col, row) {
    const t = this.tileAt(col, row);
    return t === TileType.WALL || t === TileType.BRICK;
  }

  // Destroy a brick, turning it to floor. Returns true only if a brick was there.
  destroyBrick(col, row) {
    if (this.tileAt(col, row) === TileType.BRICK) {
      this.grid[row][col] = TileType.EMPTY;
      return true;
    }
    return false;
  }

  forEachCell(cb) {
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        cb(col, row, this.grid[row][col]);
      }
    }
  }
}
