// 落砂シミュレーション (falling-sand) エンジン。
// セル単位のセルオートマトンで溶岩(液体)・お宝(粉体)・岩(粉体)を動かす。
// 決定論的な乱数を使うので、tools/verify.mjs でヘッドレス検証ができる。

export const EMPTY = 0;
export const WALL = 1;
export const PIN = 2;
export const LAVA = 3;
export const GOLD = 4;
export const HERO = 5;
export const DRAIN = 6;
export const STONE = 7;

// 描画色。1マスごとに 4 種類の濃淡からランダムに選んで質感を出す。
const PALETTE = {
  [WALL]: [[54, 60, 82], [46, 52, 72], [62, 69, 92], [40, 46, 64]],
  [PIN]: [[247, 200, 84], [255, 219, 122], [222, 176, 60], [255, 236, 170]],
  [LAVA]: [[255, 92, 26], [255, 148, 40], [231, 54, 22], [255, 196, 74]],
  [GOLD]: [[255, 206, 61], [255, 232, 138], [226, 165, 34], [255, 246, 200]],
  [DRAIN]: [[44, 48, 64], [14, 16, 24], [56, 61, 80], [9, 10, 17]], // 格子状の排水口に見せる
  [HERO]: [[124, 98, 66], [104, 80, 52], [140, 112, 78], [92, 72, 48]], // 宝物庫の床
  [STONE]: [[132, 138, 152], [108, 114, 128], [156, 162, 176], [92, 98, 112]],
};

// 型 -> 濃淡 の色引き。ImageData の Uint32 ビューに直接書き込む (ABGR)。
const LUT = new Uint32Array(8 * 4);
for (const key of Object.keys(PALETTE)) {
  const shades = PALETTE[key];
  for (let s = 0; s < 4; s++) {
    const [r, g, b] = shades[s];
    LUT[key * 4 + s] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
}

const NB8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

// 溶岩が 1 ステップで横移動できる最大距離。
// これが小さいと、棚の上に取り残された 1 粒が窓までたどり着けず、
// 「排水し切ったつもりで棚を抜いたら残り火が直撃」という理不尽が起きる。
// どの棚のどの位置からでも一手で逃げ口に届くよう、盤面の最大横幅より大きくしてある。
const LAVA_DISPERSION = 30;
/** 1 フレームに勇者が回収できるお宝の数。演出のため意図的に絞っている。 */
const PICKUP_PER_TICK = 7;

export class Sand {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.cells = new Uint8Array(n);
    this.shade = new Uint8Array(n);
    this.pinOf = new Uint8Array(n); // 1 始まりのピン ID。0 = ピンではない
    this.moved = new Uint8Array(n);
    this.heroCells = [];
    this.drainCells = [];
    this.pins = [];
    this.reset();
  }

  reset() {
    this.cells.fill(EMPTY);
    this.shade.fill(0);
    this.pinOf.fill(0);
    this.heroCells.length = 0;
    this.drainCells.length = 0;
    this.pins.length = 0;
    this.collected = 0;
    this.goldLeft = 0;
    this.dead = false;
    this.tick = 0;
    this.rngState = 0x9e3779b9;
    this.sparks = [];
    this.busy = 0; // 直近に動いたセル数。0 が続いたら「落ち着いた」と判定する
    this.idle = 0;
  }

  // xorshift32。Math.random と違い再現性があるので検証スクリプトで使える。
  rnd() {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 4294967296;
  }

  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  at(x, y) {
    if (!this.inside(x, y)) return WALL; // 場外は壁扱い
    return this.cells[y * this.w + x];
  }

  put(x, y, t, pinId = 0) {
    if (!this.inside(x, y)) return;
    const i = y * this.w + x;
    this.cells[i] = t;
    this.pinOf[i] = pinId;
    this.shade[i] = (this.rnd() * 4) | 0;
    if (t === HERO) this.heroCells.push(i);
    if (t === DRAIN) this.drainCells.push(i);
    if (t === GOLD) this.goldLeft++;
  }

  fillRect(x, y, w, h, t, pinId = 0) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.put(xx, yy, t, pinId);
    }
  }

  /** レベル定義からステージを組み立てる。 */
  build(level) {
    this.reset();
    for (const [kind, x, y, w, h] of level.build) {
      const t = { wall: WALL, lava: LAVA, gold: GOLD, hero: HERO, drain: DRAIN, stone: STONE }[kind];
      if (t === undefined) throw new Error(`不明なブロック種別: ${kind}`);
      this.fillRect(x, y, w, h, t);
    }
    for (const def of level.pins) {
      const pin = { ...def, prog: 0, pulling: false, gone: false };
      this.pins.push(pin);
      this.fillRect(pin.x, pin.y, pin.w, pin.h, PIN, pin.id);
    }
    this.need = level.need;
  }

  pin(id) {
    return this.pins.find((p) => p.id === id);
  }

  /** ピンを引き抜く。すでに抜けている / 抜き途中なら false。 */
  pull(id) {
    const p = this.pin(id);
    if (!p || p.pulling || p.gone) return false;
    p.pulling = true;
    // ピンを抜いた直後は「まだ落ち着いている」状態が続いてしまうのでリセットする。
    // これをしないと、待機判定が結果を見ないまま次の手に進んでしまう。
    this.idle = 0;
    return true;
  }

  /** 引き抜きアニメーションを 1 段階進め、ピンの占有セルを再配置する。 */
  stepPins() {
    for (const p of this.pins) {
      if (!p.pulling || p.gone) continue;
      p.prog = Math.min(1, p.prog + 0.075);

      // 一旦このピンのセルを全部消してから、残っている部分だけ描き直す。
      for (let yy = p.y; yy < p.y + p.h; yy++) {
        for (let xx = p.x; xx < p.x + p.w; xx++) {
          const i = yy * this.w + xx;
          if (this.pinOf[i] === p.id) {
            this.cells[i] = EMPTY;
            this.pinOf[i] = 0;
          }
        }
      }
      if (p.prog >= 1) {
        p.gone = true;
        continue;
      }

      const horiz = p.dir === 'left' || p.dir === 'right';
      const span = horiz ? p.w : p.h;
      const cut = Math.round(p.prog * span);
      let rx = p.x, ry = p.y, rw = p.w, rh = p.h;
      if (p.dir === 'left') { rw = p.w - cut; }
      else if (p.dir === 'right') { rx = p.x + cut; rw = p.w - cut; }
      else if (p.dir === 'up') { rh = p.h - cut; }
      else { ry = p.y + cut; rh = p.h - cut; }
      if (rw > 0 && rh > 0) this.fillRect(rx, ry, rw, rh, PIN, p.id);
    }
  }

  swap(i, j) {
    const { cells, shade } = this;
    cells[j] = cells[i];
    shade[j] = shade[i];
    cells[i] = EMPTY;
    shade[i] = 0;
    this.moved[j] = 1;
    this.busy++;
  }

  /** (x,y) の粒子を (nx,ny) に動かせるなら動かす。溶岩はお宝を溶かす。 */
  tryMove(x, y, nx, ny) {
    if (!this.inside(nx, ny)) return false;
    const i = y * this.w + x;
    const j = ny * this.w + nx;
    const dst = this.cells[j];
    if (dst === EMPTY) {
      this.swap(i, j);
      return true;
    }
    // 溶岩がお宝に触れたら溶かす。触れた側は今フレームは動かない。
    if (this.cells[i] === LAVA && dst === GOLD) {
      this.cells[j] = EMPTY;
      this.goldLeft--;
      this.busy++;
      this.sparks.push({ x: nx, y: ny, life: 12, kind: 'burn' });
      return true;
    }
    return false;
  }

  /** dir 方向に「落ちられる場所」を探し、見つかればそこまで流れる。 */
  flowTo(x, y, dir) {
    for (let s = 1; s <= LAVA_DISPERSION; s++) {
      const nx = x + dir * s;
      if (this.at(nx, y) !== EMPTY) return false;
      if (this.at(nx, y + 1) === EMPTY) return this.tryMove(x, y, nx, y);
    }
    return false;
  }

  /** dir 方向の一番遠い空きまで移動して水面を均す。 */
  levelTo(x, y, dir) {
    let target = x;
    for (let s = 1; s <= LAVA_DISPERSION; s++) {
      const nx = x + dir * s;
      if (this.at(nx, y) !== EMPTY) break;
      target = nx;
    }
    return target !== x && this.tryMove(x, y, target, y);
  }

  step() {
    this.moved.fill(0);
    this.busy = 0;
    this.stepPins();

    const { w, h, cells, moved } = this;
    for (let y = h - 2; y >= 0; y--) {
      const ltr = ((y + this.tick) & 1) === 0; // 走査方向を交互にして偏りを消す
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k;
        const i = y * w + x;
        const t = cells[i];
        if (t !== LAVA && t !== GOLD && t !== STONE) continue;
        if (moved[i]) continue;

        if (this.tryMove(x, y, x, y + 1)) continue;
        const d = this.rnd() < 0.5 ? -1 : 1;
        if (this.tryMove(x, y, x + d, y + 1)) continue;
        if (this.tryMove(x, y, x - d, y + 1)) continue;
        if (t !== LAVA) continue;

        // 溶岩の優先順位。この順番でないと排水し切れない。
        // 1. 落ち口があるなら流れる
        if (this.flowTo(x, y, d) || this.flowTo(x, y, -d)) continue;
        // 2. 落ち口が無く、横が宝なら溶かして道を作る。
        //    先に「均す」を許すと、宝の栓を避けて行き止まり側に溜まったまま固まってしまい、
        //    流し切ったはずの溶岩が棚を抜いた瞬間に降ってくる理不尽が起きる。
        if (this.at(x + d, y) === GOLD) { this.tryMove(x, y, x + d, y); continue; }
        if (this.at(x - d, y) === GOLD) { this.tryMove(x, y, x - d, y); continue; }
        // 3. どちらでもなければ水面を均す
        if (this.levelTo(x, y, d)) continue;
        this.levelTo(x, y, -d);
      }
    }

    this.resolveContacts();
    this.tick++;
    // 完全静止を待つと、はぐれた 1〜2 粒の往復で永久に落ち着かないことがあるので少し許容する。
    this.idle = this.busy <= 2 ? this.idle + 1 : 0;
  }

  /** 勇者と排水溝まわりの接触判定。全走査せず登録済みセルだけ見る。 */
  resolveContacts() {
    const { w, h, cells } = this;
    let picked = 0;

    for (const i of this.heroCells) {
      const hx = i % w, hy = (i / w) | 0;
      for (const [dx, dy] of NB8) {
        const nx = hx + dx, ny = hy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        const t = cells[j];
        if (t === LAVA) {
          this.dead = true;
        } else if (t === GOLD && picked < PICKUP_PER_TICK) {
          cells[j] = EMPTY;
          this.goldLeft--;
          this.collected++;
          picked++;
          this.sparks.push({ x: nx, y: ny, life: 14, kind: 'coin' });
        }
      }
    }

    // 排水溝は溶岩とお宝だけ飲み込む。岩は詰まって栓になる。
    for (const i of this.drainCells) {
      const dxc = i % w, dyc = (i / w) | 0;
      for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
        const nx = dxc + dx, ny = dyc + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        const t = cells[j];
        if (t === LAVA) cells[j] = EMPTY;
        else if (t === GOLD) { cells[j] = EMPTY; this.goldLeft--; }
      }
    }

    for (let k = this.sparks.length - 1; k >= 0; k--) {
      if (--this.sparks[k].life <= 0) this.sparks.splice(k, 1);
    }
  }

  get won() {
    return !this.dead && this.collected >= this.need;
  }

  /** お宝が尽きて目標に届かない、かつ場が落ち着いたら詰み。 */
  get stuck() {
    return !this.dead && !this.won && this.goldLeft + this.collected < this.need && this.idle > 30;
  }

  /** セル配列を ImageData に焼く。EMPTY だけ透明のまま残して背景を透かす。 */
  paint(imageData) {
    const buf = new Uint32Array(imageData.data.buffer);
    const { cells, shade } = this;
    for (let i = 0; i < cells.length; i++) {
      const t = cells[i];
      buf[i] = t === EMPTY ? 0 : LUT[t * 4 + shade[i]];
    }
  }
}
