// ============================================================
//  Bomberman — Enemy
//
//  Classic <script> file (NO import/export). Declares the
//  top-level `class Enemy`, visible to all later files.
//
//  Enemies move GRID-ALIGNED: they walk cell-by-cell along a
//  single axis to the centre of an adjacent cell, then pick a
//  new direction at each cell centre. They never move by free
//  AABB and never resolve their own damage or place bombs.
// ============================================================

class Enemy {
  constructor(col, row, opts) {
    opts = opts || {};
    // Top-left position, centred on the start cell via the SPEC formula.
    this.x = col * TILE + (TILE - ENTITY_SIZE) / 2;
    this.y = row * TILE + (TILE - ENTITY_SIZE) / 2;
    this.size  = ENTITY_SIZE;
    this.speed = (typeof opts.speed === 'number') ? opts.speed : ENEMY_BASE_SPEED;
    this.smart = !!opts.smart;
    this.alive = true;
    this.dir   = null;                 // 'up'|'down'|'left'|'right'|null
    this.t     = 0;                    // animation seconds
    this.target = null;                // pixel {x,y} top-left of the cell we walk to
  }

  // Occupied cell = cell of the entity's centre.
  cell() {
    const cx = this.x + ENTITY_SIZE / 2;
    const cy = this.y + ENTITY_SIZE / 2;
    return { col: Math.floor(cx / TILE), row: Math.floor(cy / TILE) };
  }

  // Top-left pixel position that centres this entity on cell (col,row).
  _cellTopLeft(col, row) {
    return {
      x: col * TILE + (TILE - ENTITY_SIZE) / 2,
      y: row * TILE + (TILE - ENTITY_SIZE) / 2,
    };
  }

  // A cell an enemy may walk INTO: in-bounds non-solid floor with no bomb.
  _enterable(col, row, game) {
    return !game.map.isSolidTile(col, row) && game.bombAt(col, row) === null;
  }

  update(dt, game) {
    if (!this.alive) return;
    this.t += dt;

    const arrived =
      this.target !== null &&
      Math.abs(this.x - this.target.x) <= 1 &&
      Math.abs(this.y - this.target.y) <= 1;

    if (this.dir === null || this.target === null || arrived) {
      // Snap exactly onto the cell centre before deciding.
      if (this.target !== null) {
        this.x = this.target.x;
        this.y = this.target.y;
      }
      this._decide(game);
      // If a direction was chosen, set the target to the adjacent cell centre.
      if (this.dir !== null) {
        const cur = this.cell();
        const d = DIRS[this.dir];
        this.target = this._cellTopLeft(cur.col + d.dc, cur.row + d.dr);
      } else {
        this.target = null;
      }
      return; // idle this frame; walk next frame toward the fresh target.
    }

    // Step toward the target along the single active axis without overshoot.
    const step = this.speed * dt;
    // X axis
    if (this.x < this.target.x) {
      this.x = Math.min(this.x + step, this.target.x);
    } else if (this.x > this.target.x) {
      this.x = Math.max(this.x - step, this.target.x);
    } else {
      this.x = this.target.x; // keep perpendicular axis exact (no drift)
    }
    // Y axis
    if (this.y < this.target.y) {
      this.y = Math.min(this.y + step, this.target.y);
    } else if (this.y > this.target.y) {
      this.y = Math.max(this.y - step, this.target.y);
    } else {
      this.y = this.target.y; // keep perpendicular axis exact (no drift)
    }
  }

  // Choose a new `dir` while standing on a cell centre. Sets this.dir.
  _decide(game) {
    const cur = this.cell();

    // Candidate directions whose next cell is enterable.
    const candidates = [];
    for (let i = 0; i < DIR_LIST.length; i++) {
      const dir = DIR_LIST[i];
      const d = DIRS[dir];
      if (this._enterable(cur.col + d.dc, cur.row + d.dr, game)) {
        candidates.push(dir);
      }
    }

    if (candidates.length === 0) {
      this.dir = null;
      return;
    }

    const reverse = this._reverseOf(this.dir);

    // Smart: usually head toward the player.
    if (this.smart && game.player && game.player.cell && Math.random() < 0.65) {
      const goal = game.player.cell();
      let best = null;
      let bestDist = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const dir = candidates[i];
        // Avoid reversing unless it is the only option.
        if (dir === reverse && candidates.length > 1) continue;
        const d = DIRS[dir];
        const nc = cur.col + d.dc;
        const nr = cur.row + d.dr;
        const dist = Math.abs(nc - goal.col) + Math.abs(nr - goal.row);
        if (dist < bestDist) {
          bestDist = dist;
          best = dir;
        }
      }
      if (best !== null) {
        this.dir = best;
        return;
      }
      // Fall through to basic behaviour if only the reverse was available.
    }

    // Basic behaviour.
    // Keep current direction with high probability if still viable.
    if (this.dir !== null && candidates.indexOf(this.dir) !== -1 && Math.random() < 0.7) {
      // keep this.dir
      return;
    }

    // Pick a random candidate, avoiding the reverse unless it is the only one.
    let pool = candidates.filter((dir) => dir !== reverse);
    if (pool.length === 0) pool = candidates;
    this.dir = pool[Math.floor(Math.random() * pool.length)];
  }

  _reverseOf(dir) {
    switch (dir) {
      case 'up':    return 'down';
      case 'down':  return 'up';
      case 'left':  return 'right';
      case 'right': return 'left';
      default:      return null;
    }
  }
}
