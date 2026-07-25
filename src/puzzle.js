// パズル画面。落砂シミュレーションの描画とピン操作を担当する。
// 広告のデモ再生と、返金後の「本物のゲーム」の両方で同じものを使う。

import { Sand, EMPTY, HERO, LAVA } from './sand.js';
import { GRID_W, GRID_H } from './levels.js';

const CELL = 5; // 1 セル = 5px → キャンバスは 360 x 520
const STEPS_PER_FRAME = 2; // 体感速度。検証スクリプトのティック数 x2 が実時間の目安

export class PuzzleView {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = GRID_W * CELL;
    canvas.height = GRID_H * CELL;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;

    // セル配列は等倍の裏キャンバスに焼いてから拡大して貼る (ドット絵の質感)
    this.off = document.createElement('canvas');
    this.off.width = GRID_W;
    this.off.height = GRID_H;
    this.offCtx = this.off.getContext('2d');
    this.img = this.offCtx.createImageData(GRID_W, GRID_H);

    this.sand = new Sand(GRID_W, GRID_H);
    this.state = 'idle'; // idle | play | won | lost
    this.shake = 0;
    this.frame = 0;
    this.interactive = true;
    this.speed = STEPS_PER_FRAME; // 広告のデモは半速にして煽り文句を読ませる
    this.onPull = null;
    canvas.addEventListener('pointerdown', (e) => this.tap(e));
  }

  load(level) {
    this.level = level;
    this.sand.build(level);
    this.hero = level.build.find((b) => b[0] === 'hero');
    this.state = 'play';
    this.shake = 0;
    this.frame = 0;
  }

  get progress() {
    return this.level ? Math.min(1, this.sand.collected / this.level.need) : 0;
  }

  /** 画面座標からピンを探す。細いピンでも押しやすいよう少し広めに判定する。 */
  pinAt(px, py) {
    const gx = px / CELL;
    const gy = py / CELL;
    for (const p of this.sand.pins) {
      if (p.gone) continue;
      if (gx >= p.x - 2 && gx <= p.x + p.w + 2 && gy >= p.y - 2.5 && gy <= p.y + p.h + 2.5) return p;
      // 取っ手の丸も当たり判定に含める
      const hx = p.x + p.w / 2;
      const hy = p.y + p.h / 2;
      if ((gx - hx) ** 2 + (gy - hy) ** 2 < 16) return p;
    }
    return null;
  }

  tap(e) {
    if (!this.interactive || this.state !== 'play') return;
    const r = this.canvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * this.canvas.width;
    const py = ((e.clientY - r.top) / r.height) * this.canvas.height;
    const pin = this.pinAt(px, py);
    if (pin) this.pull(pin.id);
  }

  pull(id) {
    if (this.sand.pull(id) && this.onPull) this.onPull(id);
  }

  update() {
    this.frame++;
    if (this.state !== 'play') {
      // 決着後も少しだけ動かして、溶岩や宝が落ち着くところを見せる
      for (let i = 0; i < this.speed; i++) this.sand.step();
      if (this.shake > 0) this.shake -= 0.6;
      return;
    }
    for (let i = 0; i < this.speed; i++) {
      this.sand.step();
      if (this.sand.dead) { this.state = 'lost'; this.shake = 9; break; }
      if (this.sand.won) { this.state = 'won'; break; }
    }
    if (this.sand.stuck) this.state = 'lost';
    if (this.shake > 0) this.shake -= 0.6;
  }

  /** 勇者の表情。溶岩が上に見えたら怯える。 */
  mood() {
    if (this.state === 'lost' || this.sand.dead) return 'dead';
    if (this.state === 'won') return 'happy';
    if (!this.hero) return 'calm';
    const [, hx, hy, hw] = this.hero;
    for (let y = Math.max(0, hy - 26); y < hy; y++) {
      for (let x = hx; x < hx + hw; x++) {
        if (this.sand.cells[y * GRID_W + x] === LAVA) return 'scared';
      }
    }
    return 'calm';
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;

    ctx.save();
    if (this.shake > 0) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    // 洞窟の背景
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1a2033');
    bg.addColorStop(1, '#0a0c14');
    ctx.fillStyle = bg;
    ctx.fillRect(-12, -12, W + 24, H + 24);

    if (this.hero) this.drawHero();

    // 粒子・壁の層
    this.sand.paint(this.img);
    this.offCtx.putImageData(this.img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.off, 0, 0, W, H);

    this.drawPins();
    this.drawSparks();

    // 溶岩の照り返し
    if (this.mood() === 'scared' || this.state === 'lost') {
      ctx.fillStyle = `rgba(255,80,20,${0.05 + 0.03 * Math.sin(this.frame / 6)})`;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  drawHero() {
    const { ctx } = this;
    const [, hx, hy, hw] = this.hero;
    const cx = (hx + hw / 2) * CELL;
    const feet = hy * CELL;
    const mood = this.mood();
    const s = 1.35;

    ctx.save();
    ctx.translate(cx, feet);
    ctx.scale(s, s);

    // マント
    ctx.fillStyle = '#b4283c';
    ctx.beginPath();
    ctx.moveTo(-9, -24);
    ctx.lineTo(9, -24);
    ctx.lineTo(12, 0);
    ctx.lineTo(-12, 0);
    ctx.closePath();
    ctx.fill();

    // 胴と脚
    ctx.fillStyle = '#3f6fd8';
    ctx.fillRect(-7, -22, 14, 16);
    ctx.fillStyle = '#2a3450';
    ctx.fillRect(-6, -7, 4, 7);
    ctx.fillRect(2, -7, 4, 7);

    // 兜
    ctx.fillStyle = '#d7dde9';
    ctx.beginPath();
    ctx.arc(0, -27, 8, Math.PI, 0);
    ctx.fill();
    ctx.fillRect(-8, -27, 16, 5);
    ctx.fillStyle = '#f2c14e';
    ctx.fillRect(-1.5, -35, 3, 6); // 飾り羽根

    // 顔
    ctx.fillStyle = '#12151f';
    ctx.fillRect(-6, -24, 12, 5);
    ctx.fillStyle = mood === 'dead' ? '#ff5a4a' : '#8fe3ff';
    if (mood === 'dead') {
      ctx.fillRect(-4.5, -23.5, 3, 3);
      ctx.fillRect(1.5, -23.5, 3, 3);
    } else if (mood === 'scared') {
      ctx.fillRect(-4.5, -23.5, 3.5, 4);
      ctx.fillRect(1, -23.5, 3.5, 4);
    } else if (mood === 'happy') {
      ctx.fillRect(-4.5, -23, 3, 2);
      ctx.fillRect(1.5, -23, 3, 2);
    } else {
      ctx.fillRect(-4, -23, 2.5, 2.5);
      ctx.fillRect(1.5, -23, 2.5, 2.5);
    }

    // 盾
    ctx.fillStyle = '#e0b13a';
    ctx.beginPath();
    ctx.moveTo(9, -21);
    ctx.lineTo(16, -19);
    ctx.lineTo(16, -8);
    ctx.lineTo(12.5, -4);
    ctx.lineTo(9, -8);
    ctx.closePath();
    ctx.fill();

    if (mood === 'happy') {
      ctx.fillStyle = '#fff2a8';
      ctx.font = 'bold 13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('♪', 0, -40);
    }
    ctx.restore();
  }

  drawPins() {
    const { ctx } = this;
    const pulse = 0.5 + 0.5 * Math.sin(this.frame / 14);
    for (const p of this.sand.pins) {
      if (p.gone) continue;
      const x = p.x * CELL;
      const y = p.y * CELL;
      const w = p.w * CELL;
      const h = p.h * CELL;

      // 抜ける前のピンは光る縁で「触れる」ことを示す
      if (!p.pulling && this.interactive) {
        ctx.strokeStyle = `rgba(255,255,255,${0.2 + 0.35 * pulse})`;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
      }

      // 取っ手の輪と番号
      const cx = x + w / 2;
      const cy = y + h / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 11, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(20,16,8,0.78)';
      ctx.fill();
      ctx.strokeStyle = p.pulling ? '#8b7333' : '#ffd76e';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.fillStyle = p.pulling ? '#8b7333' : '#ffe9a8';
      ctx.font = 'bold 12px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.label ?? String(p.id), cx, cy + 0.5);

      // 引き抜く向きの矢印
      if (!p.pulling) {
        const dx = p.dir === 'left' ? -1 : p.dir === 'right' ? 1 : 0;
        const dy = p.dir === 'up' ? -1 : p.dir === 'down' ? 1 : 0;
        ctx.fillStyle = `rgba(255,231,168,${0.35 + 0.5 * pulse})`;
        ctx.beginPath();
        ctx.moveTo(cx + dx * 20 + dy * 5, cy + dy * 20 + dx * 5);
        ctx.lineTo(cx + dx * 20 - dy * 5, cy + dy * 20 - dx * 5);
        ctx.lineTo(cx + dx * 27, cy + dy * 27);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  drawSparks() {
    const { ctx } = this;
    for (const s of this.sand.sparks) {
      const a = s.life / 14;
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = s.kind === 'coin' ? '#fff3b0' : '#ff8a3d';
      const r = (1 - a) * 5 + 1;
      ctx.beginPath();
      ctx.arc(s.x * CELL + CELL / 2, s.y * CELL + CELL / 2 - (1 - a) * 8, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

/** ストアの「スクリーンショット」用に、盤面を小さく描いた静止画を作る。 */
export function renderThumb(level, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const sand = new Sand(GRID_W, GRID_H);
  sand.build(level);
  for (let i = 0; i < 60; i++) sand.step();

  const off = document.createElement('canvas');
  off.width = GRID_W;
  off.height = GRID_H;
  const octx = off.getContext('2d');
  const img = octx.createImageData(GRID_W, GRID_H);
  sand.paint(img);
  octx.putImageData(img, 0, 0);

  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#1a2033');
  g.addColorStop(1, '#0a0c14');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, w, h);
  return c;
}

export { CELL, EMPTY, HERO };
