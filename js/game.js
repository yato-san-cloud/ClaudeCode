// ============================================================
//  Bomberman — Game (orchestrator)
//
//  Classic <script> file (NO import/export). Declares the
//  top-level `class Game`, bootstrapped by main.js.
//
//  Owns the world (map, player, bombs, explosions, enemies,
//  powerups), the level/score/state machine, and the per-frame
//  update. Entities move THROUGH game.moveEntity / game.placeBomb
//  and read the world via game.map / game.bombAt (see spec).
//
//  COORDINATE MODEL: entity (x,y) are top-left pixels in play-field
//  space; the HUD offset is added only by the Renderer. Game logic
//  never adds HUD_HEIGHT.
// ============================================================

class Game {
  constructor(canvas) {
    this.ctx = canvas.getContext('2d');
    this.renderer = new Renderer(this.ctx);
    this.input = new Input();

    // Fields (declared here for clarity; (re)initialised in reset()).
    this.map = null;
    this.player = null;
    this.bombs = [];
    this.explosions = [];
    this.enemies = [];
    this.powerups = [];
    this.level = 1;
    this.score = 0;
    this.lives = START_LIVES;
    this.state = 'ready';
    this.readyTimer = 0; // ms remaining on the "get ready" banner

    this.reset();
  }

  // ---- Full game reset ---------------------------------------
  reset() {
    this.level = 1;
    this.score = 0;
    // Create the Player ONCE here so power-ups persist across levels.
    this.player = new Player(1, 1);
    this.lives = this.player.lives;
    this.bombs = [];
    this.explosions = [];
    this.enemies = [];
    this.powerups = [];
    this.startLevel(1);
  }

  // ---- Build a level -----------------------------------------
  startLevel(n) {
    this.level = n;

    const enemyCount = START_ENEMIES + (n - 1) * ENEMIES_PER_LEVEL;

    // 1) Pick candidate spawn cells FIRST: interior, non-pillar cells at
    //    Manhattan distance >= 6 from the player start (1,1). We force
    //    these EMPTY via `reserved`, so brick/empty state pre-generation
    //    does not matter — only geometry does.
    const candidates = [];
    for (let row = 1; row < ROWS - 1; row++) {
      for (let col = 1; col < COLS - 1; col++) {
        const isPillar = (row % 2 === 0 && col % 2 === 0);
        if (isPillar) continue;
        const dist = Math.abs(col - 1) + Math.abs(row - 1);
        if (dist >= 6) candidates.push({ col: col, row: row });
      }
    }
    this._shuffle(candidates);
    const spawns = candidates.slice(0, Math.min(enemyCount, candidates.length));

    // 2) Reserved = player start box + chosen enemy spawn cells.
    const reserved = [
      { col: 1, row: 1 },
      { col: 2, row: 1 },
      { col: 1, row: 2 },
    ];
    for (let i = 0; i < spawns.length; i++) reserved.push(spawns[i]);

    // 3) Generate the maze with those cells forced EMPTY.
    this.map = new GameMap();
    this.map.generate(reserved);

    // 4) Reset the player onto (1,1): centred, alive, brief invulnerability.
    //    Power-ups / lives / speed persist because the Player object is reused.
    this.player.respawn(1, 1);
    this.lives = this.player.lives;

    // 5) Clear transient world state.
    this.bombs = [];
    this.explosions = [];
    this.powerups = [];

    // 6) Spawn enemies on the cells we forced EMPTY.
    const speed = ENEMY_BASE_SPEED + (n - 1) * ENEMY_SPEED_PER_LEVEL;
    const smartCount = (n >= ENEMY_SMART_FROM_LEVEL) ? Math.floor(spawns.length / 2) : 0;
    this.enemies = [];
    for (let i = 0; i < spawns.length; i++) {
      this.enemies.push(new Enemy(spawns[i].col, spawns[i].row, {
        speed: speed,
        smart: i < smartCount,
      }));
    }

    // 7) Short "ready" banner, then play.
    this.readyTimer = 800;
    this.state = 'ready';
  }

  // ---- Queries the entities rely on --------------------------
  bombAt(col, row) {
    for (let i = 0; i < this.bombs.length; i++) {
      const b = this.bombs[i];
      if (b.col === col && b.row === row) return b;
    }
    return null;
  }

  powerupAt(col, row) {
    for (let i = 0; i < this.powerups.length; i++) {
      const p = this.powerups[i];
      if (p.col === col && p.row === row) return p;
    }
    return null;
  }

  // Place a bomb for `owner` at (col,row) if allowed; returns the Bomb or null.
  placeBomb(col, row, owner) {
    let active = 0;
    for (let i = 0; i < this.bombs.length; i++) {
      if (this.bombs[i].owner === owner) active++;
    }
    if (active < owner.maxBombs &&
        this.bombAt(col, row) === null &&
        this.map.isEmpty(col, row)) {
      const bomb = new Bomb(col, row, owner.range, owner);
      this.bombs.push(bomb);
      // The owner may walk off its own freshly-placed bomb.
      if (owner === this.player && this.player.passBombs) {
        this.player.passBombs.add(col + ',' + row);
      }
      Sound.place();
      return bomb;
    }
    return null;
  }

  // Move an entity, resolving collisions vs walls/bricks/bombs.
  // Bombs are pass-through only for cells listed in entity.passBombs.
  moveEntity(entity, dx, dy) {
    const self = this;
    const isSolid = function (c, r) {
      return self.map.isSolidTile(c, r) ||
        (self.bombAt(c, r) !== null &&
          !(entity.passBombs && entity.passBombs.has(c + ',' + r)));
    };

    const res = Physics.moveAABB(entity, dx, dy, isSolid);

    // Once the entity no longer overlaps a bomb it was passing through,
    // drop that pass-through grant so the bomb becomes solid again.
    if (entity.passBombs && entity.passBombs.size > 0) {
      const keys = Array.from(entity.passBombs);
      for (let i = 0; i < keys.length; i++) {
        const parts = keys[i].split(',');
        const col = parseInt(parts[0], 10);
        const row = parseInt(parts[1], 10);
        if (!Physics.overlapsCell(entity, col, row)) {
          entity.passBombs.delete(keys[i]);
        }
      }
    }

    return res;
  }

  // ---- Detonate one bomb -> spawn an Explosion ---------------
  detonate(bomb) {
    const idx = this.bombs.indexOf(bomb);
    if (idx !== -1) this.bombs.splice(idx, 1);

    const result = computeExplosion(bomb.col, bomb.row, bomb.range, this.map);
    const explosion = new Explosion(result.cells);
    this.explosions.push(explosion);

    for (let i = 0; i < result.bricks.length; i++) {
      const br = result.bricks[i];
      this.map.destroyBrick(br.col, br.row);
      this.score += SCORE_BRICK;
      if (Math.random() < POWERUP_CHANCE && this.powerupAt(br.col, br.row) === null) {
        this.powerups.push(new Powerup(br.col, br.row, Powerup.randomType()));
      }
    }

    Sound.explode();
    return explosion;
  }

  // ---- Lose a life -------------------------------------------
  loseLife() {
    this.player.lives -= 1;
    this.lives = this.player.lives;
    Sound.death();
    if (this.player.lives <= 0) {
      this.state = 'gameover';
      return;
    }
    // Fair restart of the current tile.
    this.player.respawn(1, 1);
    this.bombs = [];
    this.explosions = [];
  }

  // ---- Apply a collected power-up ----------------------------
  _applyPowerup(type) {
    const pl = this.player;
    if (type === PowerupType.BOMB) {
      pl.maxBombs = Math.min(pl.maxBombs + 1, MAX_BOMBS);
    } else if (type === PowerupType.FIRE) {
      pl.range = Math.min(pl.range + 1, MAX_RANGE);
    } else if (type === PowerupType.SPEED) {
      pl.speed = Math.min(pl.speed + PLAYER_SPEED_STEP, PLAYER_SPEED_MAX);
    }
  }

  // ---- Per-frame update (dt in SECONDS) ----------------------
  update(dt) {
    const input = this.input;

    // --- Global edge-triggered actions ---
    if (input.consumePause() && (this.state === 'playing' || this.state === 'paused')) {
      this.state = (this.state === 'playing') ? 'paused' : 'playing';
    }
    if (input.consumeRestart()) {
      this.reset();
      return;
    }
    if (this.state === 'won') {
      if (input.consumeAnyKey()) {
        this.startLevel(this.level + 1);
      }
      return;
    }
    if (this.state === 'gameover') {
      return; // only Restart (handled above) leaves this state
    }
    if (this.state === 'ready') {
      this.readyTimer -= dt * 1000;
      if (this.readyTimer <= 0) this.state = 'playing';
      return;
    }
    if (this.state !== 'playing') return;

    // --- Entities ---
    this.player.update(dt, this);
    for (let i = 0; i < this.enemies.length; i++) {
      this.enemies[i].update(dt, this);
    }

    // --- Advance bomb fuses ---
    for (let i = 0; i < this.bombs.length; i++) {
      this.bombs[i].update(dt);
    }

    // --- Chain detonation: detonate any bomb whose fuse is spent OR whose
    //     cell is covered by an explosion created THIS tick; repeat until
    //     stable. Guarded against runaway loops. ---
    const freshExplosions = [];
    let guard = 0;
    let pending = true;
    while (pending && guard++ < 1000) {
      pending = false;
      for (let i = 0; i < this.bombs.length; i++) {
        const b = this.bombs[i];
        let trigger = b.exploded;
        if (!trigger) {
          for (let j = 0; j < freshExplosions.length; j++) {
            if (freshExplosions[j].covers(b.col, b.row)) { trigger = true; break; }
          }
        }
        if (trigger) {
          freshExplosions.push(this.detonate(b));
          pending = true;
          break; // this.bombs mutated; restart the scan
        }
      }
    }

    // --- Advance + cull explosions ---
    for (let i = 0; i < this.explosions.length; i++) {
      this.explosions[i].update(dt);
    }
    this.explosions = this.explosions.filter(function (ex) { return !ex.done; });

    // --- Advance power-up pulse animation ---
    for (let i = 0; i < this.powerups.length; i++) {
      this.powerups[i].update(dt);
    }

    // --- Enemies caught in flames (before player damage so a shared blast
    //     both scores the kill and costs a life). ---
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const ec = this.enemies[i].cell();
      let burned = false;
      for (let j = 0; j < this.explosions.length; j++) {
        if (this.explosions[j].covers(ec.col, ec.row)) { burned = true; break; }
      }
      if (burned) {
        this.enemies.splice(i, 1);
        this.score += SCORE_ENEMY;
        Sound.death();
      }
    }

    // --- Player damage (flames or touching an enemy) ---
    if (!this.player.isInvulnerable()) {
      const pc = this.player.cell();
      let hit = false;
      for (let j = 0; j < this.explosions.length; j++) {
        if (this.explosions[j].covers(pc.col, pc.row)) { hit = true; break; }
      }
      if (!hit) {
        for (let j = 0; j < this.enemies.length; j++) {
          const ec = this.enemies[j].cell();
          if (ec.col === pc.col && ec.row === pc.row) { hit = true; break; }
        }
      }
      if (hit) this.loseLife();
    }

    // --- Pick-ups (player standing on a power-up) ---
    if (this.player.alive) {
      const pc = this.player.cell();
      for (let i = this.powerups.length - 1; i >= 0; i--) {
        const p = this.powerups[i];
        if (p.col === pc.col && p.row === pc.row) {
          this._applyPowerup(p.type);
          this.score += SCORE_POWERUP;
          Sound.pickup();
          this.powerups.splice(i, 1);
        }
      }
    }

    // --- Win: all enemies cleared (unless we just died out this tick) ---
    if (this.state === 'playing' && this.enemies.length === 0) {
      this.state = 'won';
      this.score += SCORE_LEVEL;
      Sound.win();
      // Clear any stale "any key" latch so the banner is actually shown.
      this.input.consumeAnyKey();
    }
  }

  // ---- Render one frame --------------------------------------
  render() {
    this.renderer.draw(this);
  }

  // ---- Utilities ---------------------------------------------
  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
}
