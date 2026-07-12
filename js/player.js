// ============================================================
//  Bomberman — Player
//
//  Classic <script> file: `class Player` is declared at the top
//  level so every later script can see it. No import/export.
// ============================================================

class Player {
  constructor(col, row) {
    // Top-left corner, centred on cell (col,row) in play-field space.
    this.x = col * TILE + (TILE - ENTITY_SIZE) / 2;
    this.y = row * TILE + (TILE - ENTITY_SIZE) / 2;

    this.size = ENTITY_SIZE;
    this.speed = PLAYER_SPEED;
    this.maxBombs = START_BOMBS;
    this.range = START_RANGE;
    this.lives = START_LIVES;
    this.alive = true;

    this.invuln = 0;        // ms of invulnerability remaining
    this.t = 0;             // animation clock (seconds)
    this.facing = 'down';
    this.moving = false;

    // Bombs this player may currently walk through: set of 'col,row' keys.
    this.passBombs = new Set();

    this.spawnCol = col;
    this.spawnRow = row;
  }

  update(dt, game) {
    this.t += dt;
    this.invuln = Math.max(0, this.invuln - dt * 1000);

    // ---- Movement (single axis; no diagonals) ----
    const dir = game.input.primaryDirection();
    this.moving = !!dir;
    if (dir) {
      this.facing = dir;
      const dx = DIRS[dir].dc * this.speed * dt;
      const dy = DIRS[dir].dr * this.speed * dt;
      game.moveEntity(this, dx, dy);
    }

    // ---- Bomb placement ----
    if (game.input.consumeBomb()) {
      const c = this.cell();
      game.placeBomb(c.col, c.row, this);
    }
  }

  cell() {
    return {
      col: Math.floor((this.x + this.size / 2) / TILE),
      row: Math.floor((this.y + this.size / 2) / TILE),
    };
  }

  center() {
    return { x: this.x + this.size / 2, y: this.y + this.size / 2 };
  }

  isInvulnerable() {
    return this.invuln > 0;
  }

  die() {
    this.alive = false;
  }

  respawn(col, row) {
    this.x = col * TILE + (TILE - ENTITY_SIZE) / 2;
    this.y = row * TILE + (TILE - ENTITY_SIZE) / 2;
    this.alive = true;
    this.invuln = RESPAWN_INVULN_MS;
    this.passBombs.clear();
    this.facing = 'down';
    this.moving = false;
  }
}
