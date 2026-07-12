// ============================================================
//  Bomberman — Renderer
//
//  Classic <script> file (NO import/export). Declares the
//  top-level `class Renderer`, visible to all later files.
//
//  Renders ONE frame from the Game object. draw(game) must NOT
//  mutate any game state — it only reads. All visuals are pure
//  procedural canvas primitives; no images/fonts/CDNs.
//
//  COORDINATE MODEL: entity (x,y) are top-left pixels in PLAY-FIELD
//  space where (0,0) is the top-left of the grid. The HUD band is
//  added ONLY here, by translating the play-field draw by +HUD_HEIGHT
//  in Y. Game logic never adds it.
// ============================================================

class Renderer {
  constructor(ctx) {
    this.ctx = ctx;
  }

  // ---- Public: draw a full frame ----------------------------
  draw(game) {
    const ctx = this.ctx;
    if (!ctx || !game) return;

    // 1) Clear + HUD band + play-field background.
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    this._drawBackground(ctx);
    this._drawHudBand(ctx);

    // 2) HUD text/icons.
    this._drawHud(ctx, game);

    // 3-9) Play field: everything offset by +HUD_HEIGHT in Y.
    ctx.save();
    ctx.translate(0, HUD_HEIGHT);

    this._drawFloor(ctx);
    this._drawTiles(ctx, game.map);
    this._drawPowerups(ctx, game.powerups);
    this._drawBombs(ctx, game.bombs);
    this._drawExplosions(ctx, game.explosions);
    this._drawEnemies(ctx, game.enemies);
    this._drawPlayer(ctx, game.player);

    ctx.restore();

    // 10) State overlays (paused / won / gameover / ready).
    this._drawOverlay(ctx, game);
  }

  // ============================================================
  //  Backgrounds
  // ============================================================
  _drawBackground(ctx) {
    // Play-field backdrop gradient (behind the grass checker so
    // any translucency reads nicely).
    const g = ctx.createLinearGradient(0, HUD_HEIGHT, 0, CANVAS_H);
    g.addColorStop(0, COLORS.bgTop);
    g.addColorStop(1, COLORS.bgBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, HUD_HEIGHT, CANVAS_W, PLAY_H);
  }

  _drawHudBand(ctx) {
    ctx.fillStyle = COLORS.hudBg;
    ctx.fillRect(0, 0, CANVAS_W, HUD_HEIGHT);
    // Thin accent line separating HUD from play field.
    ctx.fillStyle = COLORS.wallLo;
    ctx.fillRect(0, HUD_HEIGHT - 2, CANVAS_W, 2);
  }

  _drawFloor(ctx) {
    // Subtle grass checker across the whole play field.
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        ctx.fillStyle = ((r + c) & 1) ? COLORS.floorB : COLORS.floorA;
        ctx.fillRect(c * TILE, r * TILE, TILE, TILE);
      }
    }
  }

  // ============================================================
  //  HUD
  // ============================================================
  _drawHud(ctx, game) {
    const player = game.player || {};
    const midY = HUD_HEIGHT / 2;

    // Layout: a row of labelled stats spread across the band.
    // Each stat is drawn as ICON + tiny label + value.
    const enemies = Array.isArray(game.enemies)
      ? game.enemies.filter(function (e) { return e && e.alive; }).length
      : 0;

    const stats = [
      { icon: 'life',  label: 'LIVES',   value: this._num(player.lives) },
      { icon: 'bomb',  label: 'BOMBS',   value: this._num(player.maxBombs) },
      { icon: 'fire',  label: 'FIRE',    value: this._num(player.range) },
      { icon: 'speed', label: 'SPEED',   value: this._num(player.speed) },
      { icon: 'enemy', label: 'ENEMIES', value: enemies },
      { icon: 'level', label: 'LEVEL',   value: this._num(game.level, 1) },
      { icon: 'score', label: 'SCORE',   value: this._num(game.score, 0) },
    ];

    ctx.textBaseline = 'middle';

    // Distribute stats evenly. SCORE is given extra weight so big
    // numbers don't collide with the right edge.
    const padL = 14;
    const padR = 14;
    const usable = CANVAS_W - padL - padR;
    const slot = usable / stats.length;

    for (let i = 0; i < stats.length; i++) {
      const s = stats[i];
      const x0 = padL + slot * i;
      let x = x0;

      // Icon.
      ctx.save();
      ctx.translate(x + 10, midY);
      this._drawHudIcon(ctx, s.icon);
      ctx.restore();
      x += 24;

      // Label (dim, small) above the value; value (bright) below.
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.hudDim;
      ctx.font = '600 10px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(s.label, x, midY - 9);

      ctx.fillStyle = COLORS.hud;
      ctx.font = '700 16px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(String(s.value), x, midY + 8);
    }
  }

  _num(v, fallback) {
    if (typeof v === 'number' && isFinite(v)) return Math.round(v);
    return (typeof fallback === 'number') ? fallback : '-';
  }

  // Tiny procedural HUD icons, centred at (0,0), ~16px tall.
  _drawHudIcon(ctx, kind) {
    ctx.save();
    switch (kind) {
      case 'life': {
        // Heart.
        ctx.fillStyle = COLORS.bad;
        ctx.beginPath();
        ctx.moveTo(0, 5);
        ctx.bezierCurveTo(-7, -3, -5, -8, 0, -3);
        ctx.bezierCurveTo(5, -8, 7, -3, 0, 5);
        ctx.fill();
        break;
      }
      case 'bomb': {
        ctx.fillStyle = COLORS.bomb;
        ctx.beginPath();
        ctx.arc(0, 2, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = COLORS.fuse;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(3, -3);
        ctx.lineTo(6, -7);
        ctx.stroke();
        ctx.fillStyle = COLORS.spark;
        ctx.beginPath();
        ctx.arc(6.5, -7.5, 1.6, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'fire': {
        const g = ctx.createRadialGradient(0, 1, 1, 0, 1, 8);
        g.addColorStop(0, COLORS.flameCore);
        g.addColorStop(0.5, COLORS.flameMid);
        g.addColorStop(1, COLORS.flameEdge);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, -8);
        ctx.quadraticCurveTo(6, -1, 3, 5);
        ctx.quadraticCurveTo(0, 8, -3, 5);
        ctx.quadraticCurveTo(-6, -1, 0, -8);
        ctx.fill();
        break;
      }
      case 'speed': {
        ctx.fillStyle = COLORS.puSpeed;
        ctx.beginPath();
        ctx.moveTo(4, -7);
        ctx.lineTo(-3, 1);
        ctx.lineTo(0, 1);
        ctx.lineTo(-4, 7);
        ctx.lineTo(4, -1);
        ctx.lineTo(1, -1);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'enemy': {
        ctx.fillStyle = COLORS.enemy;
        this._roundRectPath(ctx, -6, -6, 12, 12, 5);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(-2.3, -1, 1.6, 0, Math.PI * 2);
        ctx.arc(2.3, -1, 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#101018';
        ctx.beginPath();
        ctx.arc(-2.3, -1, 0.8, 0, Math.PI * 2);
        ctx.arc(2.3, -1, 0.8, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'level': {
        ctx.fillStyle = COLORS.puFire;
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
          const a = -Math.PI / 2 + i * (Math.PI * 2 / 5);
          const ai = a + Math.PI / 5;
          ctx.lineTo(Math.cos(a) * 7, Math.sin(a) * 7);
          ctx.lineTo(Math.cos(ai) * 3, Math.sin(ai) * 3);
        }
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'score':
      default: {
        ctx.strokeStyle = COLORS.fuse;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(0, 1, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = COLORS.fuse;
        ctx.font = '700 9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('$', 0, 1.5);
        break;
      }
    }
    ctx.restore();
  }

  // ============================================================
  //  Tiles
  // ============================================================
  _drawTiles(ctx, map) {
    if (!map || !map.grid) return;
    for (let r = 0; r < ROWS; r++) {
      const rowArr = map.grid[r];
      if (!rowArr) continue;
      for (let c = 0; c < COLS; c++) {
        const t = rowArr[c];
        if (t === TileType.WALL) {
          this._drawWall(ctx, c * TILE, r * TILE);
        } else if (t === TileType.BRICK) {
          this._drawBrick(ctx, c * TILE, r * TILE);
        }
      }
    }
  }

  _drawWall(ctx, x, y) {
    const s = TILE;
    const b = Math.max(3, Math.round(TILE * 0.11));
    // Base.
    ctx.fillStyle = COLORS.wall;
    ctx.fillRect(x, y, s, s);
    // Highlight top + left bevel.
    ctx.fillStyle = COLORS.wallHi;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + s, y);
    ctx.lineTo(x + s - b, y + b);
    ctx.lineTo(x + b, y + b);
    ctx.lineTo(x + b, y + s - b);
    ctx.lineTo(x, y + s);
    ctx.closePath();
    ctx.fill();
    // Shadow bottom + right bevel.
    ctx.fillStyle = COLORS.wallLo;
    ctx.beginPath();
    ctx.moveTo(x + s, y);
    ctx.lineTo(x + s, y + s);
    ctx.lineTo(x, y + s);
    ctx.lineTo(x + b, y + s - b);
    ctx.lineTo(x + s - b, y + s - b);
    ctx.lineTo(x + s - b, y + b);
    ctx.closePath();
    ctx.fill();
    // Inset face.
    ctx.fillStyle = COLORS.wall;
    ctx.fillRect(x + b, y + b, s - 2 * b, s - 2 * b);
  }

  _drawBrick(ctx, x, y) {
    const s = TILE;
    const pad = 2;
    const rad = Math.max(4, Math.round(TILE * 0.14));
    // Rounded body.
    this._roundRectPath(ctx, x + pad, y + pad, s - 2 * pad, s - 2 * pad, rad);
    ctx.fillStyle = COLORS.brick;
    ctx.fill();
    // Top highlight strip.
    ctx.save();
    this._roundRectPath(ctx, x + pad, y + pad, s - 2 * pad, s - 2 * pad, rad);
    ctx.clip();
    ctx.fillStyle = COLORS.brickHi;
    ctx.fillRect(x + pad, y + pad, s - 2 * pad, Math.round(s * 0.28));
    // Bottom shadow strip.
    ctx.fillStyle = COLORS.brickLo;
    ctx.fillRect(x + pad, y + s - pad - Math.round(s * 0.22), s - 2 * pad, Math.round(s * 0.22));
    // Mortar lines (a couple, horizontal + a staggered vertical).
    ctx.strokeStyle = COLORS.brickLo;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + pad, y + s * 0.5);
    ctx.lineTo(x + s - pad, y + s * 0.5);
    ctx.moveTo(x + s * 0.5, y + pad);
    ctx.lineTo(x + s * 0.5, y + s * 0.5);
    ctx.moveTo(x + s * 0.32, y + s * 0.5);
    ctx.lineTo(x + s * 0.32, y + s - pad);
    ctx.moveTo(x + s * 0.68, y + s * 0.5);
    ctx.lineTo(x + s * 0.68, y + s - pad);
    ctx.stroke();
    ctx.restore();
  }

  // ============================================================
  //  Power-ups
  // ============================================================
  _drawPowerups(ctx, powerups) {
    if (!Array.isArray(powerups)) return;
    for (let i = 0; i < powerups.length; i++) {
      const p = powerups[i];
      if (!p) continue;
      this._drawPowerup(ctx, p);
    }
  }

  _drawPowerup(ctx, p) {
    const cx = p.col * TILE + TILE / 2;
    const cy = p.row * TILE + TILE / 2;
    const t = p.t || 0;
    const pulse = 1 + 0.08 * Math.sin(t * 5);
    const half = Math.round(TILE * 0.32) * pulse;

    let color, letter;
    if (p.type === PowerupType.BOMB) { color = COLORS.puBomb; letter = 'B'; }
    else if (p.type === PowerupType.FIRE) { color = COLORS.puFire; letter = 'F'; }
    else if (p.type === PowerupType.SPEED) { color = COLORS.puSpeed; letter = 'S'; }
    else { color = COLORS.puBomb; letter = '?'; }

    ctx.save();
    // Soft glow.
    ctx.globalAlpha = 0.35 + 0.15 * Math.sin(t * 5);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, half * 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Rounded badge.
    this._roundRectPath(ctx, cx - half, cy - half, half * 2, half * 2, half * 0.5);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.stroke();

    // Letter.
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 ' + Math.round(half * 1.3) + 'px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, cx, cy + 1);
    ctx.restore();
  }

  // ============================================================
  //  Bombs
  // ============================================================
  _drawBombs(ctx, bombs) {
    if (!Array.isArray(bombs)) return;
    for (let i = 0; i < bombs.length; i++) {
      const b = bombs[i];
      if (!b) continue;
      this._drawBomb(ctx, b);
    }
  }

  _drawBomb(ctx, b) {
    const cx = b.col * TILE + TILE / 2;
    const cy = b.row * TILE + TILE / 2;
    const base = TILE * 0.34;

    // Pulse quickens as the fuse nears 0.
    const fuseLeft = Math.max(0, (typeof b.fuse === 'number') ? b.fuse : BOMB_FUSE_MS);
    const urgency = 1 - Math.min(1, fuseLeft / BOMB_FUSE_MS); // 0 -> 1
    const freq = 6 + urgency * 22;
    const t = b.t || 0;
    const pulse = 1 + (0.06 + urgency * 0.12) * Math.abs(Math.sin(t * freq));
    const r = base * pulse;

    ctx.save();
    // Body sphere.
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.2, cx, cy, r);
    g.addColorStop(0, COLORS.bombHi);
    g.addColorStop(0.4, COLORS.bomb);
    g.addColorStop(1, '#050508');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // Specular highlight.
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.arc(cx - r * 0.32, cy - r * 0.38, r * 0.22, 0, Math.PI * 2);
    ctx.fill();

    // Fuse stem.
    ctx.strokeStyle = COLORS.fuse;
    ctx.lineWidth = Math.max(2, TILE * 0.06);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.5, cy - r * 0.75);
    ctx.quadraticCurveTo(cx + r * 0.95, cy - r * 1.15, cx + r * 0.7, cy - r * 1.4);
    ctx.stroke();

    // Lit spark (flickers with urgency).
    const sparkR = (TILE * 0.09) * (1 + 0.5 * Math.abs(Math.sin(t * (freq + 4))));
    const sg = ctx.createRadialGradient(cx + r * 0.7, cy - r * 1.4, 0, cx + r * 0.7, cy - r * 1.4, sparkR * 2);
    sg.addColorStop(0, COLORS.flameCore);
    sg.addColorStop(0.5, COLORS.spark);
    sg.addColorStop(1, 'rgba(255,90,60,0)');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.arc(cx + r * 0.7, cy - r * 1.4, sparkR * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ============================================================
  //  Explosions
  // ============================================================
  _drawExplosions(ctx, explosions) {
    if (!Array.isArray(explosions)) return;
    for (let i = 0; i < explosions.length; i++) {
      const ex = explosions[i];
      if (!ex || !Array.isArray(ex.cells)) continue;
      this._drawExplosion(ctx, ex);
    }
  }

  _drawExplosion(ctx, ex) {
    const p = (typeof ex.progress === 'function') ? ex.progress() : 0;
    // Grow in over the first ~30%, hold, then fade the last ~40%.
    const grow = Math.min(1, p / 0.3);
    const scale = 0.55 + 0.45 * this._easeOut(grow);
    const alpha = p < 0.6 ? 1 : this._easeIn(1 - (p - 0.6) / 0.4);

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < ex.cells.length; i++) {
      const cell = ex.cells[i];
      if (!cell) continue;
      const cx = cell.col * TILE + TILE / 2;
      const cy = cell.row * TILE + TILE / 2;
      const isCenter = (cell.kind === 'center' || cell.dir === 'center');
      this._drawFlameCell(ctx, cx, cy, cell.dir, isCenter, scale);
    }
    ctx.restore();
  }

  _drawFlameCell(ctx, cx, cy, dir, isCenter, scale) {
    const R = (TILE * 0.5) * scale;

    // Hot radial gradient body.
    const g = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    g.addColorStop(0, COLORS.flameCore);
    g.addColorStop(0.45, COLORS.flameMid);
    g.addColorStop(1, 'rgba(255,59,47,0)');

    if (isCenter) {
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      // Bright inner core.
      ctx.fillStyle = COLORS.flameCore;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.4, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    // Arm: a capsule oriented along its direction.
    const horiz = (dir === 'left' || dir === 'right');
    ctx.save();
    ctx.translate(cx, cy);
    if (horiz) ctx.rotate(0); else ctx.rotate(Math.PI / 2);
    // After rotation, draw a horizontal capsule spanning the full tile.
    const halfLen = R;               // reaches tile edges
    const halfThick = R * 0.62;
    ctx.fillStyle = g;
    this._capsulePath(ctx, -halfLen, -halfThick, halfLen * 2, halfThick * 2);
    ctx.fill();
    // Hot core streak.
    ctx.fillStyle = COLORS.flameCore;
    this._capsulePath(ctx, -halfLen * 0.85, -halfThick * 0.4, halfLen * 1.7, halfThick * 0.8);
    ctx.fill();
    ctx.restore();
  }

  // ============================================================
  //  Enemies
  // ============================================================
  _drawEnemies(ctx, enemies) {
    if (!Array.isArray(enemies)) return;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e || !e.alive) continue;
      this._drawEnemy(ctx, e);
    }
  }

  _drawEnemy(ctx, e) {
    const size = e.size || ENTITY_SIZE;
    const t = e.t || 0;
    const bob = Math.sin(t * 7) * 2;
    const cx = e.x + size / 2;
    const cy = e.y + size / 2 + bob;

    const body = e.smart ? COLORS.enemySmart : COLORS.enemy;
    const dark = e.smart ? COLORS.enemySmartDk : COLORS.enemyDk;

    const half = size / 2;
    ctx.save();

    // Contact shadow.
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(cx, e.y + size - 1, half * 0.8, half * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();

    // Rounded blob body with vertical shading.
    const grad = ctx.createLinearGradient(cx, cy - half, cx, cy + half);
    grad.addColorStop(0, body);
    grad.addColorStop(1, dark);
    ctx.fillStyle = grad;
    this._roundRectPath(ctx, cx - half, cy - half, size, size, half * 0.55);
    ctx.fill();

    // Little wobbly feet suggestion.
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.arc(cx - half * 0.45, cy + half * 0.85, half * 0.22, 0, Math.PI * 2);
    ctx.arc(cx + half * 0.45, cy + half * 0.85, half * 0.22, 0, Math.PI * 2);
    ctx.fill();

    // Eyes look toward dir.
    this._drawEyes(ctx, cx, cy - half * 0.12, half * 0.62, half * 0.3, e.dir, half * 0.24, half * 0.12);
    ctx.restore();
  }

  // ============================================================
  //  Player
  // ============================================================
  _drawPlayer(ctx, pl) {
    if (!pl || !pl.alive) return;

    // Invulnerability blink: skip draw on alternating ~120ms windows.
    if (typeof pl.isInvulnerable === 'function' && pl.isInvulnerable()) {
      const t = pl.t || 0;
      const window120 = Math.floor((t * 1000) / 120);
      if (window120 & 1) return;
    }

    const size = pl.size || ENTITY_SIZE;
    const t = pl.t || 0;
    const step = pl.moving ? Math.sin(t * 12) * 2 : 0;
    const cx = pl.x + size / 2;
    const cy = pl.y + size / 2 - Math.abs(step) * 0.5;
    const half = size / 2;

    ctx.save();

    // Contact shadow.
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(cx, pl.y + size - 1, half * 0.8, half * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body with vertical shading.
    const grad = ctx.createLinearGradient(cx, cy - half, cx, cy + half);
    grad.addColorStop(0, COLORS.player);
    grad.addColorStop(1, COLORS.playerDk);
    ctx.fillStyle = grad;
    this._roundRectPath(ctx, cx - half, cy - half, size, size, half * 0.5);
    ctx.fill();

    // Helmet band (facing cue direction as a little visor).
    ctx.fillStyle = COLORS.playerDk;
    this._roundRectPath(ctx, cx - half, cy - half * 0.75, size, half * 0.5, half * 0.25);
    ctx.fill();

    // Feet.
    ctx.fillStyle = COLORS.playerDk;
    ctx.beginPath();
    ctx.arc(cx - half * 0.4, cy + half * 0.9 + step, half * 0.22, 0, Math.PI * 2);
    ctx.arc(cx + half * 0.4, cy + half * 0.9 - step, half * 0.22, 0, Math.PI * 2);
    ctx.fill();

    // Eyes + facing cue.
    this._drawEyes(ctx, cx, cy - half * 0.05, half * 0.6, half * 0.34, pl.facing, half * 0.26, half * 0.13);

    // Facing arrow chin.
    this._drawFacingCue(ctx, cx, cy, half, pl.facing);

    ctx.restore();
  }

  // Shared eye drawing. (cx,cy) eye row centre; spread = distance
  // between eyes; ry = eye vertical radius baseline. dir shifts pupils.
  _drawEyes(ctx, cx, cy, spread, ry, dir, eyeR, pupilR) {
    let px = 0, py = 0;
    if (dir === 'left') px = -1;
    else if (dir === 'right') px = 1;
    else if (dir === 'up') py = -1;
    else if (dir === 'down') py = 1;

    const exs = [cx - spread / 2, cx + spread / 2];
    for (let i = 0; i < 2; i++) {
      const ex = exs[i];
      // White.
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex, cy, eyeR, 0, Math.PI * 2);
      ctx.fill();
      // Pupil offset toward facing.
      ctx.fillStyle = '#12121c';
      ctx.beginPath();
      ctx.arc(ex + px * eyeR * 0.4, cy + py * eyeR * 0.4, pupilR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawFacingCue(ctx, cx, cy, half, facing) {
    // A small bright triangle at the character edge pointing where
    // it faces — a readable directional cue.
    const d = half * 0.92;
    let ax = cx, ay = cy;
    let rot = 0;
    if (facing === 'up') { ay = cy - d; rot = -Math.PI / 2; }
    else if (facing === 'down') { ay = cy + d; rot = Math.PI / 2; }
    else if (facing === 'left') { ax = cx - d; rot = Math.PI; }
    else { ax = cx + d; rot = 0; } // right / default

    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(rot);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.moveTo(half * 0.16, 0);
    ctx.lineTo(-half * 0.12, -half * 0.18);
    ctx.lineTo(-half * 0.12, half * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ============================================================
  //  Overlays
  // ============================================================
  _drawOverlay(ctx, game) {
    const state = game.state;
    if (state !== 'paused' && state !== 'won' && state !== 'gameover' && state !== 'ready') {
      return;
    }

    // Semi-transparent backdrop.
    ctx.save();
    ctx.fillStyle = (state === 'ready') ? 'rgba(6,10,20,0.45)' : 'rgba(6,10,20,0.66)';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const midX = CANVAS_W / 2;
    const midY = CANVAS_H / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    let title = '';
    let subs = [];
    let titleColor = COLORS.hud;

    if (state === 'paused') {
      title = 'PAUSED';
      subs = ['Press P or Esc to resume'];
    } else if (state === 'won') {
      title = 'LEVEL CLEAR!';
      titleColor = COLORS.good;
      subs = ['Score: ' + this._num(game.score, 0), 'Press any key to continue'];
    } else if (state === 'gameover') {
      title = 'GAME OVER';
      titleColor = COLORS.bad;
      subs = ['Score: ' + this._num(game.score, 0), 'Press R to restart'];
    } else if (state === 'ready') {
      title = 'LEVEL ' + this._num(game.level, 1);
      subs = ['Get ready!'];
    }

    // Title with drop shadow.
    ctx.font = '800 44px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(title, midX + 3, midY - 20 + 3);
    ctx.fillStyle = titleColor;
    ctx.fillText(title, midX, midY - 20);

    // Subtitles.
    ctx.font = '600 18px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    for (let i = 0; i < subs.length; i++) {
      const y = midY + 22 + i * 26;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillText(subs[i], midX + 2, y + 2);
      ctx.fillStyle = (i === 0 && subs.length > 1) ? COLORS.hud : COLORS.hudDim;
      ctx.fillText(subs[i], midX, y);
    }

    ctx.restore();
  }

  // ============================================================
  //  Primitive helpers
  // ============================================================
  _roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  _capsulePath(ctx, x, y, w, h) {
    this._roundRectPath(ctx, x, y, w, h, Math.min(w, h) / 2);
  }

  _easeOut(t) {
    const c = Math.max(0, Math.min(1, t));
    return 1 - (1 - c) * (1 - c);
  }

  _easeIn(t) {
    const c = Math.max(0, Math.min(1, t));
    return c * c;
  }
}
