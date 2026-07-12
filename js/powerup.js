// ============================================================
//  Bomberman — Powerup
//
//  A collectible dropped when a brick is destroyed. Pure data +
//  a pulse timer for the Renderer; pickup logic lives in Game and
//  drawing lives in the Renderer.
//
//  Classic <script>: `Powerup` is declared at top level and is
//  visible to all later script files. No import/export.
// ============================================================

class Powerup {
  constructor(col, row, type) {
    this.col = col;
    this.row = row;
    this.type = type;   // one of PowerupType.{BOMB,FIRE,SPEED}
    this.t = 0;         // seconds elapsed, drives the pulsing draw
  }

  // Advance the pulse animation. dt is in seconds.
  update(dt) {
    this.t += dt;
  }

  cell() {
    return { col: this.col, row: this.row };
  }

  // Weighted random power-up type: BOMB 0.4, FIRE 0.4, SPEED 0.2.
  static randomType() {
    const r = Math.random();
    if (r < 0.4) return PowerupType.BOMB;
    if (r < 0.8) return PowerupType.FIRE;
    return PowerupType.SPEED;
  }
}
