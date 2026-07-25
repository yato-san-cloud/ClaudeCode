// 「ロープ切り」系の広告ゲーム。
// 天井から吊るされた宝箱・岩・爆弾。正しいロープを正しい順番で切って、宝を勇者のカゴへ届ける。
// 切る順番でシーソーの傾きや扉の開閉が変わり、落下物の行き先が変わる。
//
// 規約: トップレベルの宣言は export const ROPE ただ 1 つ。状態は全部 create() の中に閉じ込める。

export const ROPE = {
  meta: {
    id: 'rope',
    title: 'ロープを切れ',
    hook: '99%が宝を溶岩に落とす',
    icon: '✂️',
    reality: '実際は…ロープ工場の放置ゲー',
    stages: 4,
    tint: '#c4661f',
  },

  create(api) {
    const { W, H, sfx } = api;

    const CEIL = 36; // 天井の下端
    const FLOOR = 470; // 地面の高さ
    const GRAV = 900;
    const STEP = 1 / 120; // 物理は固定ステップ。dt に依存させないための刻み
    const CUT_R = 20; // ロープの当たり判定（太めに取る）

    // 吊るされる物。r は半径、mass が重いものはスイッチを踏める
    const KIND = {
      treasure: { r: 13, mass: 1.0 },
      rock: { r: 21, mass: 3.0 },
      bomb: { r: 15, mass: 1.6 },
      weight: { r: 16, mass: 3.0 },
    };

    const cl = (v, a, b) => (v < a ? a : v > b ? b : v);

    /** 板を 1 枚。pass を指定すると「その半径以下の物はすり抜ける」格子になる。 */
    const bar = (x1, y1, x2, y2, o = {}) => ({
      x1, y1, x2, y2,
      half: o.half ?? 5,
      mu: o.mu ?? 2.4, // 摩擦（大きいほど滑らない）
      bounce: o.bounce ?? 0.1,
      style: o.style ?? 'wood',
      pass: o.pass ?? 0,
      frag: !!o.frag, // 重い物がぶつかると壊れる
      id: o.id ?? '',
      on: true,
      anim: 1,
    });

    /** 地面を危険地帯で切り分けて板にする。左右の壁も足す。 */
    const ground = (pits) => {
      const out = [];
      let x = 4;
      for (const p of [...pits].sort((a, b) => a.x0 - b.x0)) {
        if (p.x0 > x) out.push(bar(x, FLOOR, p.x0, FLOOR, { style: 'ground', half: 6, mu: 3.4 }));
        x = Math.max(x, p.x1);
      }
      if (x < W - 4) out.push(bar(x, FLOOR, W - 4, FLOOR, { style: 'ground', half: 6, mu: 3.4 }));
      out.push(bar(6, CEIL, 6, FLOOR + 6, { style: 'wall', half: 6, mu: 1.4, bounce: 0.2 }));
      out.push(bar(W - 6, CEIL, W - 6, FLOOR + 6, { style: 'wall', half: 6, mu: 1.4, bounce: 0.2 }));
      return out;
    };

    // --- ステージ定義 -----------------------------------------------------
    // make() は毎回まっさらな盤面を作って返す（やり直しても同じ形になるように）。
    const STAGES = [
      {
        hint: '宝箱のロープを切って滑り台へ。岩の真下には勇者がいる',
        make: () => ({
          hero: 286,
          pits: [{ x0: 4, x1: 176, kind: 'lava' }],
          bars: [bar(44, 292, 240, 372)],
          see: null,
          switches: [],
          ropes: [
            { x: 88, len: 116, kind: 'treasure' },
            { x: 286, len: 92, kind: 'rock' },
          ],
          solve: [{ rope: 0, at: 0 }],
        }),
      },
      {
        hint: '岩でスイッチを踏んで鉄扉を開けてから、宝箱を滑らせる',
        make: () => ({
          hero: 300,
          pits: [{ x0: 112, x1: 246, kind: 'lava' }],
          bars: [
            bar(108, 286, 238, 336),
            bar(250, 370, 330, 370, { style: 'steel', id: 'gate', half: 6, mu: 4.5 }),
          ],
          see: null,
          switches: [{ x: 46, y: FLOOR - 13, w: 62, h: 13, target: 'gate' }],
          ropes: [
            { x: 140, len: 108, kind: 'treasure' },
            { x: 76, len: 92, kind: 'rock' },
            { x: 300, len: 74, kind: 'bomb' },
          ],
          solve: [{ rope: 1, at: 0 }, { rope: 0, at: 1.6 }],
        }),
      },
      {
        hint: '錘を切るとシーソーが左に傾く。順番を間違えると宝は溶岩へ',
        make: () => ({
          hero: 68,
          pits: [{ x0: 232, x1: 356, kind: 'lava' }],
          bars: [
            bar(14, 362, 36, 398, { half: 4 }),
            bar(130, 362, 102, 398, { half: 4 }),
          ],
          see: { x: 190, y: 330, half: 92, bias: -1.5, maxAng: 0.3 },
          switches: [],
          ropes: [
            { x: 222, len: 112, kind: 'treasure' },
            { host: 'see', off: 66, len: 54, kind: 'weight' },
            { x: 68, len: 88, kind: 'rock' },
            { x: 140, len: 150, kind: 'rock' },
          ],
          solve: [{ rope: 1, at: 0 }, { rope: 0, at: 1.8 }],
        }),
      },
      {
        hint: 'シーソー→滑り台→格子。格子は宝だけを通す。重い物を落とすと格子ごと割れる',
        make: () => ({
          hero: 68,
          pits: [{ x0: 236, x1: 356, kind: 'lava' }],
          bars: [
            bar(168, 288, 80, 325),
            bar(26, 286, 26, 392, { style: 'wall', half: 5, mu: 1.4 }),
            bar(36, 368, 68, 378, { style: 'grate', half: 4, pass: 14, mu: 3.0, frag: true, id: 'grate' }),
            bar(68, 378, 100, 368, { style: 'grate', half: 4, pass: 14, mu: 3.0, frag: true, id: 'grate' }),
          ],
          see: { x: 218, y: 232, half: 82, bias: -1.5, maxAng: 0.3 },
          switches: [],
          ropes: [
            { x: 252, len: 100, kind: 'treasure' },
            { host: 'see', off: 58, len: 50, kind: 'weight' },
            { x: 120, len: 120, kind: 'rock' },
            { x: 68, len: 110, kind: 'bomb' },
            { x: 330, len: 70, kind: 'treasure' },
          ],
          solve: [{ rope: 1, at: 0 }, { rope: 0, at: 1.8 }],
        }),
      },
    ];

    // --- 状態 -------------------------------------------------------------
    let world = null;
    let phase = 'play'; // play | cleared | over
    let clearT = 0;
    let calmT = 0;
    let acc = 0;
    let tSim = 0;
    let shake = 0;
    let auto = []; // solve() が積む予約
    let autoT = 0;
    let parts = [];
    let blade = [];
    let px = 0;
    let py = 0;
    let heroMood = 'calm';
    let stageIx = 0;

    // シーソーの板は毎ステップ座標が変わるので使い回す
    const seeBar = bar(0, 0, 0, 0, { style: 'seesaw', half: 6, mu: 2.4 });
    seeBar.see = true;

    const seePt = (s, o) => ({ x: s.x + o * Math.cos(s.ang), y: s.y + o * Math.sin(s.ang) });

    /** ロープの根元（天井 or シーソーの腕）。 */
    const ropeTop = (r) => (r.host === 'see' ? seePt(world.see, r.off) : { x: r.x, y: CEIL });

    const catchBox = () => ({ x0: world.hero - 34, y0: FLOOR - 72, x1: world.hero + 34, y1: FLOOR - 6 });
    const hurtBox = () => ({ x0: world.hero - 26, y0: FLOOR - 70, x1: world.hero + 26, y1: FLOOR });
    const inBox = (b, x, y) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;
    const boxDist = (b, x, y) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));

    const puff = (x, y, color, n = 5, spd = 90) => {
      for (let k = 0; k < n; k++) {
        if (parts.length > 140) break;
        const a = api.rnd() * Math.PI * 2;
        const v = spd * (0.3 + api.rnd() * 0.7);
        parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 30, life: 0.5 + api.rnd() * 0.4, max: 0.9, c: color, s: 2 + api.rnd() * 2.5 });
      }
    };

    const fail = (msg) => {
      if (phase !== 'play') return;
      phase = 'over';
      heroMood = 'dead';
      shake = 12;
      api.say('失敗…', 1000);
      api.lose(msg);
    };

    const clearStage = () => {
      if (phase !== 'play') return;
      phase = 'cleared';
      clearT = 0;
      heroMood = 'happy';
      sfx.coin();
      api.say('宝を届けた！', 1100);
      puff(world.hero, FLOOR - 46, '#ffd75c', 16, 150);
    };

    // --- 物理 -------------------------------------------------------------
    /** 有効な板の一覧（シーソーの板は毎回作り直す）。 */
    const activeBars = () => {
      const list = [];
      for (const b of world.bars) if (b.on) list.push(b);
      if (world.see) {
        const s = world.see;
        const a = seePt(s, -s.half);
        const c = seePt(s, s.half);
        seeBar.x1 = a.x; seeBar.y1 = a.y; seeBar.x2 = c.x; seeBar.y2 = c.y;
        list.push(seeBar);
      }
      return list;
    };

    const armBomb = (it) => {
      if (it.kind !== 'bomb' || it.fuse >= 0) return;
      it.fuse = 0.5;
      sfx.pull();
    };

    const boom = (it) => {
      it.alive = false;
      shake = 14;
      sfx.fail();
      puff(it.x, it.y, '#ffb020', 20, 260);
      puff(it.x, it.y, '#fff0b0', 10, 180);
      for (const b of world.bars) {
        if (!b.on || !b.blast) continue;
        const t = cl(((it.x - b.x1) * (b.x2 - b.x1) + (it.y - b.y1) * (b.y2 - b.y1)) / (((b.x2 - b.x1) ** 2 + (b.y2 - b.y1) ** 2) || 1), 0, 1);
        if (Math.hypot(it.x - (b.x1 + (b.x2 - b.x1) * t), it.y - (b.y1 + (b.y2 - b.y1) * t)) < 62) b.on = false;
      }
      for (const o of world.items) {
        if (o === it || !o.alive || !o.free) continue;
        const d = Math.hypot(o.x - it.x, o.y - it.y) || 1;
        if (d > 95) continue;
        const k = ((95 - d) / 95) * 340;
        o.vx += ((o.x - it.x) / d) * k;
        o.vy += ((o.y - it.y) / d) * k - 70;
        if (o.kind === 'treasure' && d < 48) { o.alive = false; fail('宝箱を爆風で吹き飛ばした'); }
      }
      if (boxDist(hurtBox(), it.x, it.y) < 62) fail('爆風に巻き込まれた');
    };

    /** 円 vs 線分。押し戻し＋反発＋斜面の摩擦だけの簡易物理。 */
    const hitBar = (it, b, h) => {
      if (b.pass && it.r <= b.pass) return;
      const dx = b.x2 - b.x1;
      const dy = b.y2 - b.y1;
      const L2 = dx * dx + dy * dy || 1;
      const t = cl(((it.x - b.x1) * dx + (it.y - b.y1) * dy) / L2, 0, 1);
      const cx = b.x1 + dx * t;
      const cy = b.y1 + dy * t;
      let nx = it.x - cx;
      let ny = it.y - cy;
      let d = Math.hypot(nx, ny);
      const rad = it.r + b.half;
      if (d >= rad) return;
      if (d < 0.0001) { nx = 0; ny = -1; d = 1; }
      nx /= d; ny /= d;
      it.x += nx * (rad - d);
      it.y += ny * (rad - d);
      const vn = it.vx * nx + it.vy * ny;
      if (vn < 0) {
        if (vn < -260) puff(cx, cy, '#8a7a5a', 3, 60);
        it.vx -= (1 + b.bounce) * vn * nx;
        it.vy -= (1 + b.bounce) * vn * ny;
      }
      const tx = -ny;
      const ty = nx;
      const vt = it.vx * tx + it.vy * ty;
      const nvt = vt * Math.max(0, 1 - b.mu * h);
      it.vx += (nvt - vt) * tx;
      it.vy += (nvt - vt) * ty;
      it.touch = true;
      it.spin = it.vx / it.r;
      armBomb(it);
      if (b.frag && it.mass >= 2.5 && vn < -100) {
        for (const o of world.bars) if (o.id === b.id) { o.on = false; puff((o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2, '#5d6470', 7, 130); }
        shake = 9;
        sfx.fail();
      }
      if (b.see) {
        const s = world.see;
        it.onSee = true;
        it.seeOff = (it.x - s.x) * Math.cos(s.ang) + (it.y - s.y) * Math.sin(s.ang);
      }
    };

    /** 物どうしの押し合い。積み重なりが見た目どおりになる程度の簡易版。 */
    const pairs = () => {
      const list = world.items.filter((o) => o.alive);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (!a.free && !b.free) continue;
          let nx = b.x - a.x;
          let ny = b.y - a.y;
          let d = Math.hypot(nx, ny);
          const rr = a.r + b.r;
          if (d >= rr) continue;
          if (d < 0.0001) { nx = 0; ny = 1; d = 1; }
          nx /= d; ny /= d;
          const push = rr - d;
          const ia = a.free ? 1 / a.mass : 0;
          const ib = b.free ? 1 / b.mass : 0;
          const sum = ia + ib || 1;
          a.x -= nx * push * (ia / sum);
          a.y -= ny * push * (ia / sum);
          b.x += nx * push * (ib / sum);
          b.y += ny * push * (ib / sum);
          const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rv < 0) {
            const jm = (-1.05 * rv) / sum;
            a.vx -= nx * jm * ia; a.vy -= ny * jm * ia;
            b.vx += nx * jm * ib; b.vy += ny * jm * ib;
            if (rv < -240) { armBomb(a); armBomb(b); }
          }
        }
      }
    };

    const sink = (it, kind) => {
      it.alive = false;
      sfx.tap();
      puff(it.x, FLOOR + 4, kind === 'lava' ? '#ff8a30' : '#7fd4ff', 10, 120);
    };

    const checkItem = (it) => {
      if (it.y > H + 70 || it.x < -50 || it.x > W + 50) {
        it.alive = false;
        if (it.kind === 'treasure') fail('宝を画面の外へ飛ばした');
        return;
      }
      for (const p of world.pits) {
        if (it.x > p.x0 - it.r * 0.5 && it.x < p.x1 + it.r * 0.5 && it.y + it.r * 0.5 > FLOOR + 4) {
          sink(it, p.kind);
          if (it.kind === 'treasure') fail(p.kind === 'lava' ? '宝箱を溶岩に落とした' : '宝箱を沈めてしまった');
          return;
        }
      }
      if (phase !== 'play') return;
      if (it.kind === 'treasure') {
        if (inBox(catchBox(), it.x, it.y)) { it.alive = false; clearStage(); }
      } else if (inBox(hurtBox(), it.x, it.y)) {
        it.alive = false;
        shake = 12;
        fail(it.kind === 'bomb' ? '爆弾が勇者に直撃した' : '落ちてきた物が勇者を潰した');
      }
    };

    const checkSwitches = () => {
      for (const s of world.switches) {
        if (s.on) continue;
        for (const it of world.items) {
          if (!it.alive || !it.free || it.mass < 2.5) continue;
          if (it.x < s.x - it.r || it.x > s.x + s.w + it.r) continue;
          if (it.y + it.r < s.y - 2 || it.y > s.y + s.h + it.r) continue;
          s.on = true;
          sfx.merge();
          api.say('鉄扉が開いた！', 900);
          for (const b of world.bars) if (b.id === s.target) b.on = false;
          puff(s.x + s.w / 2, s.y, '#9aa3b8', 8, 110);
          break;
        }
      }
    };

    /** シーソーの傾き。ぶら下がった錘と、板に乗っている物のモーメントで決まる。 */
    const stepSee = (h) => {
      const s = world.see;
      if (!s) return;
      let tq = s.bias;
      for (const r of world.ropes) if (!r.cut && r.host === 'see') tq += KIND[r.kind].mass * (r.off / s.half);
      for (const it of world.items) if (it.alive && it.free && it.onSee) tq += it.mass * (it.seeOff / s.half);
      const target = cl(tq * 1.6, -1, 1) * s.maxAng;
      s.ang += cl(target - s.ang, -1.1 * h, 1.1 * h);
    };

    /**
     * 「もう何も起きない」状態になったら失敗にする。
     * まだ宝が吊るされている / スイッチを押せる岩が残っている間は待つ。
     */
    const checkSettle = (h) => {
      if (phase !== 'play') return;
      let moving = false;
      for (const it of world.items) if (it.alive && it.free && Math.hypot(it.vx, it.vy) > 14) moving = true;
      const treasureLeft = world.ropes.some((r) => !r.cut && r.kind === 'treasure');
      const switchLeft = world.switches.some((s) => !s.on) && world.ropes.some((r) => !r.cut && KIND[r.kind].mass >= 2.5);
      if (!moving && !treasureLeft && !switchLeft) {
        calmT += h;
        if (calmT > 2) fail('宝が勇者に届かなかった');
      } else calmT = 0;
    };

    const step = (h) => {
      tSim += h;
      stepSee(h);
      for (const r of world.ropes) {
        if (r.cut) continue;
        const t = ropeTop(r);
        r.item.x = t.x;
        r.item.y = t.y + r.len;
        r.item.vx = 0;
        r.item.vy = 0;
      }
      const bars = activeBars();
      for (const it of world.items) {
        if (!it.alive || !it.free) continue;
        it.vy += GRAV * h;
        it.x += it.vx * h;
        it.y += it.vy * h;
        it.onSee = false;
        it.touch = false;
        for (const b of bars) hitBar(it, b, h);
        it.rot += it.spin * h;
      }
      pairs();
      for (const it of world.items) {
        if (!it.alive || !it.free) continue;
        checkItem(it);
      }
      for (const it of world.items) {
        if (!it.alive || it.fuse < 0) continue;
        it.fuse -= h;
        if (it.fuse <= 0) boom(it);
      }
      checkSwitches();
      checkSettle(h);
    };

    // --- 入力 -------------------------------------------------------------
    const distPS = (x, y, x1, y1, x2, y2) => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const t = cl(((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      return Math.hypot(x - (x1 + dx * t), y - (y1 + dy * t));
    };

    const cutRope = (i) => {
      const r = world.ropes[i];
      if (!r || r.cut || phase !== 'play') return;
      r.cut = true;
      r.item.free = true;
      r.item.vx = 0;
      r.item.vy = 0;
      r.item.spin = 0;
      sfx.pull();
      puff(r.item.x, r.item.y - r.item.r, '#caa46a', 6, 80);
    };

    /**
     * なぞった線（タップなら 1 点）がロープを横切ったら切る。
     * ロープは細いので、吊り物の中心までを当たり判定に含めて太めに取る。
     */
    const slash = (ax, ay, bx, by) => {
      for (let i = 0; i < world.ropes.length; i++) {
        const r = world.ropes[i];
        if (r.cut) continue;
        const t = ropeTop(r);
        let best = 1e9;
        for (let k = 0; k <= 8; k++) {
          const sx = ax + ((bx - ax) * k) / 8;
          const sy = ay + ((by - ay) * k) / 8;
          best = Math.min(best, distPS(sx, sy, t.x, t.y, r.item.x, r.item.y));
        }
        if (best < CUT_R) cutRope(i);
      }
    };

    // --- 描画ヘルパ -------------------------------------------------------
    const ROCKR = [1.0, 0.86, 1.06, 0.9, 1.0, 0.82, 1.04, 0.92, 0.96];

    const drawChest = (ctx, x, y, r, rot) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      const w = r * 2.05;
      const hh = r * 1.6;
      gfx.roundRect(ctx, -w / 2, -hh / 2, w, hh, 3, '#b3702a', '#5b3410', 2);
      gfx.roundRect(ctx, -w / 2, -hh / 2, w, hh * 0.42, 3, '#d99a3c', '#5b3410', 2);
      ctx.fillStyle = '#f2d06b';
      ctx.fillRect(-w / 2 + 1, -hh * 0.06, w - 2, 3);
      ctx.fillStyle = '#f7e08a';
      ctx.fillRect(-3.5, -hh * 0.14, 7, 8);
      ctx.fillStyle = '#7a4a12';
      ctx.fillRect(-1.2, -hh * 0.06, 2.4, 3.5);
      ctx.restore();
    };

    const drawRock = (ctx, x, y, r, rot, seed) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.beginPath();
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const rr = r * ROCKR[(i + seed) % 9];
        const vx = Math.cos(a) * rr;
        const vy = Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
      }
      ctx.closePath();
      ctx.fillStyle = '#6d7480';
      ctx.fill();
      ctx.strokeStyle = '#3d434d';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#878f9c';
      ctx.beginPath();
      ctx.arc(-r * 0.28, -r * 0.3, r * 0.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const drawBomb = (ctx, x, y, r, lit) => {
      ctx.save();
      ctx.translate(x, y);
      gfx.circle(ctx, 0, 0, r, '#2b2f38', '#12151b', 2);
      gfx.circle(ctx, -r * 0.32, -r * 0.34, r * 0.26, 'rgba(255,255,255,.35)');
      ctx.strokeStyle = '#a8763c';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.quadraticCurveTo(r * 0.5, -r * 1.5, r * 0.85, -r * 1.15);
      ctx.stroke();
      if (lit) {
        const f = 3 + Math.sin(Date.now() / 55) * 1.6;
        gfx.circle(ctx, r * 0.85, -r * 1.15, f, '#ffd45c');
        gfx.circle(ctx, r * 0.85, -r * 1.15, f * 0.5, '#fff6d0');
      }
      ctx.restore();
    };

    const drawWeight = (ctx, x, y, r) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.strokeStyle = '#8d939e';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, -r * 0.95, r * 0.34, Math.PI, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-r * 0.85, r * 0.8);
      ctx.lineTo(-r * 0.55, -r * 0.65);
      ctx.lineTo(r * 0.55, -r * 0.65);
      ctx.lineTo(r * 0.85, r * 0.8);
      ctx.closePath();
      ctx.fillStyle = '#5a6270';
      ctx.fill();
      ctx.strokeStyle = '#2f353f';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#7e8794';
      ctx.fillRect(-r * 0.45, -r * 0.45, r * 0.9, r * 0.28);
      ctx.restore();
    };

    const drawItem = (ctx, it) => {
      if (!it.alive) return;
      if (it.kind === 'treasure') drawChest(ctx, it.x, it.y, it.r, it.rot);
      else if (it.kind === 'rock') drawRock(ctx, it.x, it.y, it.r, it.rot, it.seed);
      else if (it.kind === 'bomb') drawBomb(ctx, it.x, it.y, it.r, it.fuse >= 0);
      else drawWeight(ctx, it.x, it.y, it.r);
    };

    /** ロープ 1 本。撚りが見えるように 2 本線で描く。 */
    const drawRope = (ctx, x1, y1, x2, y2) => {
      ctx.save();
      ctx.strokeStyle = '#6b4a22';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.strokeStyle = '#c9a05a';
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(90,60,25,.75)';
      ctx.lineWidth = 1.6;
      const len = Math.hypot(x2 - x1, y2 - y1);
      const n = Math.max(1, Math.floor(len / 7));
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 0.55) / n;
        ctx.moveTo(x1 + (x2 - x1) * t0 - 2.6, y1 + (y2 - y1) * t0);
        ctx.lineTo(x1 + (x2 - x1) * t1 + 2.6, y1 + (y2 - y1) * t1);
      }
      ctx.stroke();
      ctx.restore();
    };

    const drawBar = (ctx, b) => {
      const ang = Math.atan2(b.y2 - b.y1, b.x2 - b.x1);
      const len = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
      ctx.save();
      ctx.translate((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2);
      ctx.rotate(ang);
      const t = b.half * 2;
      if (b.style === 'steel') {
        const w = len * b.anim;
        gfx.roundRect(ctx, -len / 2, -t / 2, Math.max(2, w), t, 3, '#98a2b4', '#5b6472', 2);
        ctx.fillStyle = 'rgba(255,255,255,.35)';
        for (let i = 0; i < 5; i++) ctx.fillRect(-len / 2 + 6 + i * (w / 5), -t / 2 + 2, 2, t - 4);
      } else if (b.style === 'grate') {
        gfx.roundRect(ctx, -len / 2, -t / 2, len, t, 2, '#5d6470', '#333944', 2);
        ctx.strokeStyle = '#39404b';
        ctx.lineWidth = 2;
        for (let i = 1; i < 7; i++) {
          const gx = -len / 2 + (len * i) / 7;
          ctx.beginPath();
          ctx.moveTo(gx, -t / 2);
          ctx.lineTo(gx, t / 2);
          ctx.stroke();
        }
      } else if (b.style === 'wall' || b.style === 'ground') {
        gfx.roundRect(ctx, -len / 2, -t / 2, len, t, 2, '#5a4c42', '#33291f', 2);
      } else {
        gfx.roundRect(ctx, -len / 2, -t / 2, len, t, 3, '#8a5a30', '#4a2e13', 2);
        ctx.strokeStyle = 'rgba(255,220,170,.22)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(-len / 2 + 4, -1);
        ctx.lineTo(len / 2 - 4, -1);
        ctx.stroke();
        ctx.fillStyle = '#3c2611';
        gfx.circle(ctx, -len / 2 + 7, 0, 1.8, '#3c2611');
        gfx.circle(ctx, len / 2 - 7, 0, 1.8, '#3c2611');
      }
      ctx.restore();
    };

    const drawHero = (ctx) => {
      const hx = world.hero;
      const rimY = FLOOR - 66;
      // 足元の影
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      ctx.ellipse(hx, FLOOR - 1, 20, 5, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.restore();
      gfx.guy(ctx, hx, FLOOR, 1.15, heroMood, '#3f6fd8');
      // カゴを掲げる腕
      ctx.save();
      ctx.strokeStyle = '#f3c9a0';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(hx - 8, FLOOR - 22);
      ctx.lineTo(hx - 20, FLOOR - 44);
      ctx.moveTo(hx + 8, FLOOR - 22);
      ctx.lineTo(hx + 20, FLOOR - 44);
      ctx.stroke();
      // カゴ
      ctx.beginPath();
      ctx.moveTo(hx - 32, rimY);
      ctx.lineTo(hx + 32, rimY);
      ctx.lineTo(hx + 23, rimY + 24);
      ctx.lineTo(hx - 23, rimY + 24);
      ctx.closePath();
      ctx.fillStyle = '#a9762f';
      ctx.fill();
      ctx.strokeStyle = '#5f3d11';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,225,170,.45)';
      ctx.lineWidth = 1.6;
      for (let i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(hx - 32 + i * 3, rimY + i * 6);
        ctx.lineTo(hx + 32 - i * 3, rimY + i * 6);
        ctx.stroke();
      }
      gfx.roundRect(ctx, hx - 34, rimY - 5, 68, 7, 3, '#c68c39', '#5f3d11', 2);
      ctx.restore();
    };

    const drawPit = (ctx, p) => {
      const g = ctx.createLinearGradient(0, FLOOR - 6, 0, H);
      if (p.kind === 'lava') {
        g.addColorStop(0, '#ffc24a');
        g.addColorStop(0.3, '#ff6a1a');
        g.addColorStop(1, '#7d1a05');
      } else {
        g.addColorStop(0, '#7fd4ff');
        g.addColorStop(1, '#0a4a7a');
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      const t = Date.now() / 250;
      ctx.moveTo(p.x0, FLOOR);
      for (let x = p.x0; x <= p.x1; x += 10) ctx.lineTo(x, FLOOR - 3 + Math.sin(x / 22 + t) * 3);
      ctx.lineTo(p.x1, H);
      ctx.lineTo(p.x0, H);
      ctx.closePath();
      ctx.fill();
      if (p.kind === 'lava') {
        ctx.globalAlpha = 0.4 + 0.25 * Math.sin(Date.now() / 200);
        ctx.fillStyle = '#ffe9a0';
        for (let k = 0; k < 5; k++) {
          const bx = p.x0 + ((k * 61 + Date.now() / 30) % Math.max(20, p.x1 - p.x0));
          gfx.circle(ctx, bx, FLOOR + 8 + (k % 3) * 9, 2.6, '#ffe9a0');
        }
        ctx.globalAlpha = 1;
      }
    };

    // --- ゲーム本体 -------------------------------------------------------
    const game = {
      hint: STAGES[0].hint,

      start(i) {
        stageIx = i % STAGES.length;
        const st = STAGES[stageIx];
        const w = st.make();
        w.pits = w.pits ?? [];
        w.bars = [...w.bars, ...ground(w.pits)];
        w.items = [];
        w.ropes.forEach((r, k) => {
          const kd = KIND[r.kind];
          r.cut = false;
          r.host = r.host ?? null;
          r.off = r.off ?? 0;
          const it = {
            kind: r.kind, r: kd.r, mass: kd.mass, x: r.x ?? 0, y: CEIL + r.len,
            vx: 0, vy: 0, rot: 0, spin: 0, alive: true, free: false, fuse: -1,
            onSee: false, seeOff: 0, touch: false, seed: k % 9,
          };
          r.item = it;
          w.items.push(it);
        });
        if (w.see) w.see.ang = 0;
        world = w;
        game._w = w; // ★調整用（あとで消す）
        game.hint = st.hint;
        phase = 'play';
        clearT = 0;
        calmT = 0;
        acc = 0;
        tSim = 0;
        shake = 0;
        auto = [];
        autoT = 0;
        parts = [];
        blade = [];
        heroMood = 'calm';
        // シーソーは初期の釣り合いまで一気に振っておく
        if (w.see) for (let k = 0; k < 240; k++) stepSee(STEP);
        for (const r of w.ropes) {
          const t = ropeTop(r);
          r.item.x = t.x;
          r.item.y = t.y + r.len;
        }
      },

      /** 検証用: そのステージの正解手順で自動的に切る。update() 側で順に処理する。 */
      solve() {
        auto = world.solve.map((s) => ({ rope: s.rope, at: s.at }));
        autoT = 0;
      },

      update(dt) {
        if (phase === 'over') return;
        if (auto.length) {
          autoT += dt;
          while (auto.length && auto[0].at <= autoT) cutRope(auto.shift().rope);
        }
        if (shake > 0) shake = Math.max(0, shake - dt * 32);
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          p.life -= dt;
          if (p.life <= 0) { parts.splice(i, 1); continue; }
          p.vy += GRAV * 0.55 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
        }
        for (let i = blade.length - 1; i >= 0; i--) {
          blade[i].life -= dt;
          if (blade[i].life <= 0) blade.splice(i, 1);
        }
        if (phase === 'cleared') {
          clearT += dt;
          if (clearT >= 0.45) { phase = 'over'; api.win(); }
          return;
        }
        // 固定ステップで進める（dt に依存しない決定論的な動き）
        acc = Math.min(0.3, acc + dt);
        let n = 0;
        while (acc >= STEP && n < 48) {
          acc -= STEP;
          step(STEP);
          n++;
          if (phase !== 'play') break;
        }
        // 危険が迫っていたら怖がる
        if (phase === 'play') {
          let danger = false;
          for (const it of world.items) {
            if (!it.alive || !it.free || it.kind === 'treasure') continue;
            if (Math.abs(it.x - world.hero) < 70 && it.y > 120) danger = true;
          }
          heroMood = danger ? 'scared' : 'calm';
        }
      },

      pointer(x, y, ph) {
        if (phase !== 'play') return;
        if (ph === 'down') { px = x; py = y; blade.length = 0; }
        blade.push({ x, y, life: 0.28 });
        if (blade.length > 24) blade.shift();
        slash(px, py, x, y);
        px = x;
        py = y;
      },

      draw(ctx) {
        ctx.save();
        if (shake > 0) ctx.translate((api.rnd() - 0.5) * shake, (api.rnd() - 0.5) * shake);

        // 洞窟の背景
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#332a44');
        bg.addColorStop(0.55, '#221c33');
        bg.addColorStop(1, '#161122');
        ctx.fillStyle = bg;
        ctx.fillRect(-14, -14, W + 28, H + 28);
        for (let k = 0; k < 14; k++) {
          gfx.circle(ctx, 24 + ((k * 83) % (W - 48)), 80 + ((k * 149) % 330), 12 + (k % 4) * 7, 'rgba(255,255,255,.022)');
        }

        for (const p of world.pits) drawPit(ctx, p);

        // 天井の岩盤
        ctx.fillStyle = '#3b3145';
        ctx.fillRect(-14, -14, W + 28, CEIL + 14);
        ctx.fillStyle = 'rgba(0,0,0,.16)';
        for (let k = 0; k < 7; k++) ctx.fillRect((k * 57) % W, 4 + (k % 3) * 9, 30 + (k % 4) * 12, 7);
        ctx.fillStyle = '#2c2436';
        ctx.beginPath();
        ctx.moveTo(-14, CEIL - 8);
        for (let x = -14; x <= W + 14; x += 24) ctx.lineTo(x + 12, CEIL + (x % 48 === 0 ? 9 : 3));
        ctx.lineTo(W + 14, CEIL - 8);
        ctx.closePath();
        ctx.fill();

        for (const b of world.bars) {
          if (!b.on && b.style !== 'steel') continue;
          if (!b.on) { b.anim = Math.max(0, b.anim - 0.09); if (b.anim <= 0.01) continue; }
          drawBar(ctx, b);
        }

        // シーソー
        if (world.see) {
          const s = world.see;
          const a = seePt(s, -s.half);
          const c = seePt(s, s.half);
          seeBar.x1 = a.x; seeBar.y1 = a.y; seeBar.x2 = c.x; seeBar.y2 = c.y;
          ctx.fillStyle = '#4a4256';
          ctx.beginPath();
          ctx.moveTo(s.x - 16, s.y + 34);
          ctx.lineTo(s.x + 16, s.y + 34);
          ctx.lineTo(s.x, s.y + 2);
          ctx.closePath();
          ctx.fill();
          drawBar(ctx, seeBar);
          gfx.circle(ctx, s.x, s.y, 5, '#c9cfda', '#4a4256', 2);
        }

        // スイッチ
        for (const s of world.switches) {
          const dy = s.on ? 6 : 0;
          gfx.roundRect(ctx, s.x - 4, s.y + dy, s.w + 8, s.h - dy, 3, s.on ? '#5ec07a' : '#c0562f', '#2b2233', 2);
          gfx.text(ctx, s.on ? 'ON' : 'PUSH', s.x + s.w / 2, s.y + dy + (s.h - dy) / 2 + 1, { size: 9, color: '#fff' });
        }

        drawHero(ctx);

        // ロープと吊り物
        for (const r of world.ropes) {
          const t = ropeTop(r);
          if (r.cut) {
            const sway = Math.sin(Date.now() / 420 + r.x) * 3;
            drawRope(ctx, t.x, t.y, t.x + sway, t.y + 16);
          } else {
            const sway = Math.sin(Date.now() / 620 + t.x) * 2;
            drawRope(ctx, t.x, t.y, r.item.x + sway, r.item.y - r.item.r);
            gfx.circle(ctx, t.x, t.y + 1, 4.5, '#9aa3b8', '#4a4256', 2);
          }
        }
        for (const it of world.items) if (!it.free) drawItem(ctx, it);
        for (const it of world.items) if (it.free) drawItem(ctx, it);

        // 粒子
        for (const p of parts) {
          ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.max));
          gfx.circle(ctx, p.x, p.y, p.s, p.c);
        }
        ctx.globalAlpha = 1;

        // なぞった軌跡
        if (blade.length > 1) {
          ctx.save();
          ctx.lineCap = 'round';
          for (let i = 1; i < blade.length; i++) {
            const a = blade[i - 1];
            const b = blade[i];
            ctx.globalAlpha = Math.max(0, b.life / 0.28) * 0.8;
            ctx.strokeStyle = '#fff6c8';
            ctx.lineWidth = 1 + (i / blade.length) * 5;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
          ctx.restore();
          ctx.globalAlpha = 1;
        }
        ctx.restore();
      },
    };

    return game;
  },
};
