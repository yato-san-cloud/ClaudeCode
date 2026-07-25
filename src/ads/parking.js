// 「駐車場パズル」系の広告ゲーム。
// ぎゅう詰めの駐車場から、車を 1 台ずつタップして出庫させる。
// 車は自分が向いている方向にしか進めないので、外側の車から順に逃がしていく。
//
// 盤面は「空っぽの駐車場に、出庫できる状態を保ったまま車を詰めていく」逆再生方式で作る。
// 置いた順の逆が、そのまま正解の出庫順 (= solve() の手順) になる。
// また、車を出す行為は他車の進路を空けることにしかならないので、原理的に詰みは起きない。
// (念のため「動かせる車が 1 台も無い」場合の警告表示だけは用意してある)

export const PARKING = {
  meta: {
    id: 'parking',
    title: '駐車場パズル',
    hook: '車を出すだけ。なのに97%が詰む',
    icon: '🚗',
    reality: '実際は…広告を見て待つだけの放置ゲーム',
    stages: 4,
    tint: '#2f7fb5',
  },

  create(api) {
    const { W, H, sfx } = api;

    // 各ステージ: マス目・出口になる辺・詰め込む台数・一言説明
    const STAGES = [
      {
        cols: 4, rows: 4, exits: ['up', 'right', 'down', 'left'], cars: 5,
        hint: '車をタップ！向いている方へまっすぐ発進する',
      },
      {
        cols: 5, rows: 5, exits: ['up', 'right', 'down', 'left'], cars: 9,
        hint: 'ふさがれた車は動けない。外側の車から逃がそう',
      },
      {
        cols: 5, rows: 6, exits: ['up', 'right', 'down'], cars: 12,
        hint: '左は壁。上・右・下の3方向からしか出られない',
      },
      {
        cols: 6, rows: 6, exits: ['up', 'right'], cars: 14,
        hint: '出口は上と右だけ。手前をどかしてから奥を出す',
      },
    ];

    // 方向まわりの定数。dir は 'up' | 'right' | 'down' | 'left'
    const DIRV = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
    const ANG = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 };

    // 車のボディ色 [表, 影]
    const PAINT = [
      ['#e64a3c', '#9c281f'],
      ['#3f8fe0', '#215a91'],
      ['#46b96b', '#217041'],
      ['#f2a63a', '#a5651a'],
      ['#a274e4', '#5c3a96'],
      ['#2ec2c2', '#146f74'],
      ['#ee6fa8', '#9c3566'],
      ['#e2cf46', '#93840f'],
    ];

    // 盤面の配置領域 (この中に収まるようマス目のサイズを決める)
    const AREA_TOP = 92;
    const AREA_H = 416;
    const AREA_W = 316;

    // --- 状態はすべてここに閉じ込める ---
    let cfg = STAGES[0];
    let cols = 4, rows = 4;
    let cell = 70, bx = 0, by = 0, bw = 0, bh = 0;
    let cars = [];      // 盤上に残っている車 (出庫アニメ中も含む)
    let order = [];     // 正解の出庫順 (生成した順の逆)
    let total = 0;      // そのステージの総台数
    let taps = 0;       // タップ回数
    let puffs = [];     // 「ブブー！」などの浮き出し演出
    let stuck = false;  // 動かせる車が無い (通常は起きない)
    let winTimer = -1;  // 全車出庫後のちょっとした間
    let time = 0;
    let auto = false;   // solve() 中か
    let autoIdx = 0;
    let autoWait = 0;

    const EXIT_DUR = 0.46; // 出庫アニメの長さ(秒)
    const BUMP_DUR = 0.3;  // 跳ね返りの長さ(秒)

    const game = {
      hint: STAGES[0].hint,

      start(i) {
        cfg = STAGES[i % STAGES.length];
        game.hint = cfg.hint;
        cols = cfg.cols;
        rows = cfg.rows;
        cell = Math.min(AREA_W / cols, 360 / rows);
        bw = cell * cols;
        bh = cell * rows;
        bx = (W - bw) / 2;
        by = AREA_TOP + (AREA_H - bh) / 2;

        cars = [];
        order = [];
        puffs = [];
        taps = 0;
        stuck = false;
        winTimer = -1;
        time = 0;
        auto = false;
        autoIdx = 0;
        autoWait = 0;

        build();
        total = cars.length;
      },

      update(dt) {
        time += dt;

        // 車のアニメーション
        for (let i = cars.length - 1; i >= 0; i--) {
          const k = cars[i];
          if (k.flash > 0) k.flash -= dt;
          if (k.state === 'bump') {
            k.t += dt / BUMP_DUR;
            if (k.t >= 1) { k.state = 'parked'; k.t = 0; }
          } else if (k.state === 'exit') {
            k.t += dt / EXIT_DUR;
            if (k.t >= 1) {
              k.state = 'gone';
              cars.splice(i, 1);
              // 空いた駐車マスに土煙を残す
              const s = slotRect(k);
              puffs.push({ x: s.x + s.w / 2, y: s.y + s.h / 2, ring: true, life: 0.45, max: 0.45 });
              stuck = cars.length > 0 && !cars.some((c) => blockerOf(c) === null);
            }
          }
          offsetOf(k);
        }

        // 浮き出しテキスト
        for (let i = puffs.length - 1; i >= 0; i--) {
          const p = puffs[i];
          p.life -= dt;
          if (p.life <= 0) puffs.splice(i, 1);
        }

        // solve() 中は 1 台ずつ順番に出していく
        if (auto && winTimer < 0) {
          autoWait -= dt;
          const busy = cars.some((k) => k.state === 'exit');
          if (!busy && autoWait <= 0) {
            let pick = null;
            for (let i = autoIdx; i < order.length; i++) {
              const k = order[i];
              if (k.state === 'parked' && blockerOf(k) === null) { pick = k; autoIdx = i + 1; break; }
            }
            // 保険: 正解手順から外れても出せる車があれば出す
            if (!pick) pick = cars.find((k) => k.state === 'parked' && blockerOf(k) === null) || null;
            if (pick) { launch(pick); autoWait = 0.09; }
          }
        }

        // 全車出庫でクリア
        if (cars.length === 0 && winTimer < 0) {
          winTimer = 0.42;
          api.say('全車 出庫完了！', 1100);
        } else if (winTimer > 0) {
          winTimer -= dt;
          if (winTimer <= 0) { winTimer = 0; api.win(); }
        }
      },

      /** 検証用: 正解の出庫順で 1 台ずつ自動発進させる (update 側で進む)。 */
      solve() {
        auto = true;
        autoIdx = 0;
        autoWait = 0.05;
      },

      pointer(x, y, ph) {
        if (ph !== 'down' || auto || winTimer >= 0) return;
        for (const k of cars) {
          if (k.state !== 'parked') continue;
          const r = slotRect(k);
          if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
          taps++;
          const b = blockerOf(k);
          if (b === null) {
            launch(k);
          } else {
            // ふさがれている: 少し出かかって跳ね返る
            k.state = 'bump';
            k.t = 0;
            if (b && b !== 'wall') b.flash = 0.45;
            honk();
            puffs.push({ x: r.x + r.w / 2, y: r.y + r.h / 2 - 14, text: 'ブブー！', life: 0.85, max: 0.85 });
          }
          return;
        }
      },

      draw(ctx) {
        drawGround(ctx);
        drawLot(ctx);
        drawEdges(ctx);

        // 停まっている車 → 出庫中の車 の順に描くと、走り去る車が手前になる
        for (const k of cars) if (k.state !== 'exit') drawCar(ctx, k);
        for (const k of cars) if (k.state === 'exit') drawCar(ctx, k);

        drawPuffs(ctx);
        drawHud(ctx);
        if (stuck) drawStuck(ctx);
      },
    };

    // ====================================================================
    // 盤面づくり
    // ====================================================================

    /**
     * 空の駐車場に「今すぐ出庫できる位置」だけを選んで車を足していく。
     * i 番目に置いた車は 0..i-1 番の車に一切ふさがれていないので、
     * 逆順 (最後に置いた車から) に出せば必ず全部出せる。
     */
    function build() {
      const occ = new Array(cols * rows).fill(null);
      const at = (c, r) => (c < 0 || c >= cols || r < 0 || r >= rows ? undefined : occ[r * cols + c]);

      while (cars.length < cfg.cars) {
        const cand = [];
        for (const dir of cfg.exits) {
          const horiz = dir === 'left' || dir === 'right';
          for (const len of [2, 3]) {
            const maxC = horiz ? cols - len : cols - 1;
            const maxR = horiz ? rows - 1 : rows - len;
            for (let c = 0; c <= maxC; c++) {
              for (let r = 0; r <= maxR; r++) {
                if (!freeRun(at, c, r, len, horiz)) continue;
                if (!freePath(at, c, r, len, horiz, dir)) continue;
                cand.push({ c, r, len, horiz, dir });
              }
            }
          }
        }
        if (!cand.length) break;

        // 向きが偏らないよう、まず方向を選んでからその中で選ぶ
        const dirs = cfg.exits.filter((d) => cand.some((k) => k.dir === d));
        const dir = dirs[Math.floor(api.rnd() * dirs.length) % dirs.length];
        const byDir = cand.filter((k) => k.dir === dir);
        const longs = byDir.filter((k) => k.len === 3);
        const pool = longs.length && api.rnd() < 0.5 ? longs : byDir;
        const p = pool[Math.floor(api.rnd() * pool.length) % pool.length];

        const car = {
          c: p.c, r: p.r, len: p.len, horiz: p.horiz, dir: p.dir,
          paint: PAINT[(cars.length * 3) % PAINT.length],
          state: 'parked', t: 0, ox: 0, oy: 0, dist: 0, flash: 0,
        };
        for (let q = 0; q < p.len; q++) {
          const cc = p.horiz ? p.c + q : p.c;
          const rr = p.horiz ? p.r : p.r + q;
          occ[rr * cols + cc] = car;
        }
        cars.push(car);
      }

      order = cars.slice().reverse();
    }

    /** 車体が入るマスがすべて空いているか。 */
    function freeRun(at, c, r, len, horiz) {
      for (let q = 0; q < len; q++) {
        if (at(horiz ? c + q : c, horiz ? r : r + q) !== null) return false;
      }
      return true;
    }

    /** 鼻先から場外までの進路が空いているか。 */
    function freePath(at, c, r, len, horiz, dir) {
      const [dx, dy] = DIRV[dir];
      let x = horiz ? (dir === 'right' ? c + len - 1 : c) : c;
      let y = horiz ? r : dir === 'down' ? r + len - 1 : r;
      x += dx; y += dy;
      while (x >= 0 && x < cols && y >= 0 && y < rows) {
        if (at(x, y) !== null) return false;
        x += dx; y += dy;
      }
      return true;
    }

    // ====================================================================
    // ルール
    // ====================================================================

    /** そのマスに停まっている車 (出庫中の車は居ないものとして扱う)。 */
    function carAt(c, r) {
      for (const k of cars) {
        if (k.state === 'exit' || k.state === 'gone') continue;
        for (let q = 0; q < k.len; q++) {
          const cc = k.horiz ? k.c + q : k.c;
          const rr = k.horiz ? k.r : k.r + q;
          if (cc === c && rr === r) return k;
        }
      }
      return null;
    }

    /** 進路をふさいでいるもの。null なら出庫できる。'wall' は出口でない辺。 */
    function blockerOf(k) {
      const [dx, dy] = DIRV[k.dir];
      let x = k.horiz ? (k.dir === 'right' ? k.c + k.len - 1 : k.c) : k.c;
      let y = k.horiz ? k.r : k.dir === 'down' ? k.r + k.len - 1 : k.r;
      x += dx; y += dy;
      while (x >= 0 && x < cols && y >= 0 && y < rows) {
        const o = carAt(x, y);
        if (o && o !== k) return o;
        x += dx; y += dy;
      }
      return cfg.exits.indexOf(k.dir) >= 0 ? null : 'wall';
    }

    /** 出庫開始。画面外まで走り抜ける距離を測っておく。 */
    function launch(k) {
      const r = slotRect(k);
      k.state = 'exit';
      k.t = 0;
      k.dist =
        k.dir === 'right' ? W - r.x + 30 :
        k.dir === 'left' ? r.x + r.w + 30 :
        k.dir === 'up' ? r.y + r.h + 30 :
        H - r.y + 30;
      sfx.pull();
    }

    /** クラクション。 */
    function honk() {
      sfx.tone?.(233, 0.13, { type: 'square', gain: 0.05 });
      sfx.tone?.(185, 0.2, { type: 'square', gain: 0.05, delay: 0.15 });
    }

    // ====================================================================
    // 座標とアニメーション
    // ====================================================================

    /** 駐車マス (アニメ前) の矩形。 */
    function slotRect(k) {
      return {
        x: bx + k.c * cell,
        y: by + k.r * cell,
        w: (k.horiz ? k.len : 1) * cell,
        h: (k.horiz ? 1 : k.len) * cell,
      };
    }

    /** 状態に応じた表示オフセットを k.ox / k.oy に入れる。 */
    function offsetOf(k) {
      const [dx, dy] = DIRV[k.dir];
      let d = 0;
      if (k.state === 'bump') {
        d = Math.sin(Math.min(1, k.t) * Math.PI) * cell * 0.16;
      } else if (k.state === 'exit') {
        const t = Math.min(1, k.t);
        // 出だしに少しだけ後ろへ下がってから加速する
        if (t < 0.18) d = -Math.sin((t / 0.18) * Math.PI) * 5;
        else { const u = (t - 0.18) / 0.82; d = k.dist * u * u; }
      }
      k.ox = dx * d;
      k.oy = dy * d;
    }

    // ====================================================================
    // 描画
    // ====================================================================

    function drawGround(ctx) {
      gfx.sky(ctx, W, H, '#1b2330', '#0d1218');
      // うっすら斜めのライト
      ctx.save();
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = '#7fd0ff';
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(W * 0.6, 0); ctx.lineTo(0, H * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function drawLot(ctx) {
      // 路面
      gfx.roundRect(ctx, bx - 5, by - 5, bw + 10, bh + 10, 13, '#171c24');
      gfx.roundRect(ctx, bx, by, bw, bh, 9, '#414855');
      ctx.save();
      gfx.roundPath(ctx, bx, by, bw, bh, 9);
      ctx.clip();
      // 区画線
      ctx.strokeStyle = 'rgba(255,255,255,.17)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let c = 1; c < cols; c++) {
        ctx.moveTo(bx + c * cell, by + 3);
        ctx.lineTo(bx + c * cell, by + bh - 3);
      }
      for (let r = 1; r < rows; r++) {
        ctx.moveTo(bx + 3, by + r * cell);
        ctx.lineTo(bx + bw - 3, by + r * cell);
      }
      ctx.stroke();
      // 汚れ
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = '#000';
      for (let i = 0; i < 7; i++) {
        const px = bx + ((i * 97) % bw);
        const py = by + ((i * 131) % bh);
        gfx.circle(ctx, px, py, 16 + (i % 3) * 7, '#000');
      }
      ctx.restore();
    }

    /** 外周: 出口の辺は黄色い矢印、そうでない辺はコンクリの壁。 */
    function drawEdges(ctx) {
      for (const dir of ['up', 'right', 'down', 'left']) {
        const open = cfg.exits.indexOf(dir) >= 0;
        if (open) drawExit(ctx, dir);
        else drawWall(ctx, dir);
      }
    }

    function drawWall(ctx, dir) {
      const t = 9;
      let x, y, w, h;
      if (dir === 'up') { x = bx - 9; y = by - t - 3; w = bw + 18; h = t; }
      else if (dir === 'down') { x = bx - 9; y = by + bh + 3; w = bw + 18; h = t; }
      else if (dir === 'left') { x = bx - t - 3; y = by - 9; w = t; h = bh + 18; }
      else { x = bx + bw + 3; y = by - 9; w = t; h = bh + 18; }
      gfx.roundRect(ctx, x, y, w, h, 3, '#5a6272');
      ctx.save();
      ctx.globalAlpha = 0.5;
      gfx.roundRect(ctx, x, y, dir === 'left' || dir === 'right' ? 3 : w, dir === 'left' || dir === 'right' ? h : 3, 2, '#8d97a9');
      ctx.restore();
    }

    function drawExit(ctx, dir) {
      const [ox, oy] = DIRV[dir];
      const px = -oy, py = ox; // 辺に沿った向き
      const cx = bx + bw / 2 + ox * (bw / 2);
      const cy = by + bh / 2 + oy * (bh / 2);
      const half = (dir === 'up' || dir === 'down' ? bw : bh) / 2 - 4;

      // 出口ラインは黄色い破線
      ctx.save();
      ctx.strokeStyle = 'rgba(255,209,92,.9)';
      ctx.lineWidth = 4;
      ctx.setLineDash([11, 7]);
      ctx.lineDashOffset = -time * 26;
      ctx.beginPath();
      ctx.moveTo(cx + ox * 3 - px * half, cy + oy * 3 - py * half);
      ctx.lineTo(cx + ox * 3 + px * half, cy + oy * 3 + py * half);
      ctx.stroke();
      ctx.restore();

      // 外向きの矢印 2 つ。順に光らせて「ここから出る」を強調
      for (let i = 0; i < 2; i++) {
        const base = 7 + i * 6.5;
        ctx.save();
        ctx.globalAlpha = 0.55 + 0.45 * Math.sin(time * 5 - i * 1.1);
        ctx.fillStyle = '#ffd15c';
        ctx.beginPath();
        ctx.moveTo(cx + ox * (base + 6.5), cy + oy * (base + 6.5));
        ctx.lineTo(cx + ox * base - px * 7.5, cy + oy * base - py * 7.5);
        ctx.lineTo(cx + ox * base + px * 7.5, cy + oy * base + py * 7.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    /** 1 台ぶんの車。上向きの車を描いてから向きに合わせて回す。 */
    function drawCar(ctx, k) {
      const r = slotRect(k);
      const pad = cell * 0.11;
      const x = r.x + k.ox + pad;
      const y = r.y + k.oy + pad;
      const w = r.w - pad * 2;
      const h = r.h - pad * 2;

      // 影は画面の座標系のまま落とす
      ctx.save();
      ctx.globalAlpha = 0.32;
      gfx.roundRect(ctx, x + 3, y + 4, w, h, Math.min(w, h) * 0.3, '#000');
      ctx.restore();

      const bwd = Math.min(w, h);          // 車幅
      const bln = Math.max(w, h);          // 車長
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate(ANG[k.dir]);
      drawBody(ctx, bwd, bln, k);
      ctx.restore();
    }

    /** 原点を中心に、鼻先を -Y 方向に向けた車。 */
    function drawBody(ctx, bwd, bln, k) {
      const hw = bwd / 2, hl = bln / 2;
      const rad = bwd * 0.26;

      // タイヤ (前後 2 本のバーとして描き、真ん中をボディで隠す)
      const tOut = bwd * 0.07;
      ctx.fillStyle = '#12151c';
      gfx.roundRect(ctx, -hw - tOut, -hl * 0.72, bwd + tOut * 2, bln * 0.2, bwd * 0.07, '#12151c');
      gfx.roundRect(ctx, -hw - tOut, hl * 0.5, bwd + tOut * 2, bln * 0.2, bwd * 0.07, '#12151c');

      // ボディ
      const g = ctx.createLinearGradient(-hw, 0, hw, 0);
      g.addColorStop(0, k.paint[1]);
      g.addColorStop(0.32, k.paint[0]);
      g.addColorStop(0.72, k.paint[0]);
      g.addColorStop(1, k.paint[1]);
      gfx.roundPath(ctx, -hw, -hl, bwd, bln, rad);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.45)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 天面のハイライト
      ctx.save();
      ctx.globalAlpha = 0.2;
      gfx.roundRect(ctx, -hw + bwd * 0.1, -hl + bln * 0.05, bwd * 0.2, bln * 0.9, bwd * 0.1, '#fff');
      ctx.restore();

      // フロントガラス・ルーフ・リアガラス
      gfx.roundRect(ctx, -hw * 0.7, -hl * 0.56, bwd * 0.7, bln * 0.17, bwd * 0.09, '#bfe6fb');
      gfx.roundRect(ctx, -hw * 0.76, -hl * 0.3, bwd * 0.76, bln * 0.32, bwd * 0.1, k.paint[1]);
      gfx.roundRect(ctx, -hw * 0.66, hl * 0.34, bwd * 0.66, bln * 0.14, bwd * 0.08, '#8fc4e2');

      // 進行方向の矢印 (ルーフの上)
      ctx.save();
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(0, -hl * 0.24);
      ctx.lineTo(-bwd * 0.16, -hl * 0.05);
      ctx.lineTo(bwd * 0.16, -hl * 0.05);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // ヘッドライト / テールランプ
      gfx.roundRect(ctx, -hw * 0.78, -hl + bln * 0.03, bwd * 0.24, bln * 0.05, 2, '#fff6c0');
      gfx.roundRect(ctx, hw * 0.54, -hl + bln * 0.03, bwd * 0.24, bln * 0.05, 2, '#fff6c0');
      gfx.roundRect(ctx, -hw * 0.78, hl - bln * 0.08, bwd * 0.24, bln * 0.05, 2, '#ff6a5a');
      gfx.roundRect(ctx, hw * 0.54, hl - bln * 0.08, bwd * 0.24, bln * 0.05, 2, '#ff6a5a');

      // ふさいでいる車が光る
      if (k.flash > 0) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, k.flash * 2.4);
        gfx.roundPath(ctx, -hw, -hl, bwd, bln, rad);
        ctx.strokeStyle = '#ff4a3a';
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.restore();
      }
    }

    function drawPuffs(ctx) {
      for (const p of puffs) {
        const t = 1 - p.life / p.max;
        ctx.save();
        ctx.globalAlpha = Math.min(1, p.life / (p.max * 0.5));
        if (p.ring) {
          // 出庫したマスに残る土煙
          gfx.circle(ctx, p.x, p.y, 8 + t * cell * 0.55, null, 'rgba(255,255,255,.5)', 3);
        } else {
          ctx.font = '900 19px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineWidth = 5;
          ctx.strokeStyle = 'rgba(0,0,0,.8)';
          ctx.strokeText(p.text, p.x, p.y - t * 22);
          ctx.fillStyle = '#ffd15c';
          ctx.fillText(p.text, p.x, p.y - t * 22);
        }
        ctx.restore();
      }
    }

    function drawHud(ctx) {
      const left = cars.filter((k) => k.state !== 'exit').length;
      gfx.text(ctx, `のこり ${left} 台`, 20, 33, { size: 21, align: 'left' });
      gfx.text(ctx, `タップ ${taps}`, W - 20, 33, { size: 13, align: 'right', color: 'rgba(255,255,255,.6)', weight: 700 });

      const barW = W - 40;
      gfx.roundRect(ctx, 20, 47, barW, 8, 4, 'rgba(0,0,0,.45)');
      const p = total ? (total - left) / total : 0;
      if (p > 0) gfx.roundRect(ctx, 20, 47, Math.max(8, barW * p), 8, 4, '#ffd15c');

      gfx.text(ctx, '黄色い矢印の辺から出庫できる', W / 2, 72, {
        size: 12, color: 'rgba(255,255,255,.6)', weight: 700,
      });
    }

    function drawStuck(ctx) {
      const y = H - 34;
      gfx.roundRect(ctx, 30, y - 15, W - 60, 30, 8, 'rgba(192,57,43,.92)');
      gfx.text(ctx, '動かせる車がありません。やり直してください', W / 2, y, { size: 12.5 });
    }

    return game;
  },
};
