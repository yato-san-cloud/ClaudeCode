// 「線を引いて守る」系の広告ゲーム。
// 画面下の主人公めがけて岩や矢が降ってくる。指でドラッグしてインクの線を描き、
// 物理的な屋根を作って全部受け止めれば勝ち。1 つでも当たったら負け。
// インクの総量には上限があるので、闇雲に描くと肝心なところで描けなくなる。
//
// ★ 構成は src/ads/rescue.js に合わせている。
//   トップレベルの宣言は export const DRAWLINE ただ 1 つ。
//   状態もヘルパも全部 create() の中に閉じ込める（バンドル後は同じスコープに並ぶため）。

export const DRAWLINE = {
  meta: {
    id: 'drawline',
    title: 'インクで守れ',
    hook: '99%が守り切れない防衛パズル',
    icon: '✏️',
    reality: '実際は…数字を合体させる放置ゲーム',
    stages: 4,
    tint: '#12a5c4',
  },

  create(api) {
    const { W, H, sfx, rnd } = api;

    // --- 盤面の定数 ---
    const HERO_X = W / 2;    // 主人公はいつも画面中央に立っている
    const HERO_Y = H - 44;   // 主人公の足元の y
    const LINE_W = 8;        // インクの線の太さ。太いほど守れるし描き味も良い
    const SPAWN_Y = -26;     // 落下物が湧く高さ
    const VY0 = 72;          // 落下の初速
    const GRAV = 92;         // 落下の加速度
    const REGEN = 3;         // インクの自然回復 (毎秒)
    const FADE = 0.6;        // 弾かれた落下物が砕けて消えるまでの秒数
    const WALL_Y = 250;      // 壊せる岩壁の高さ (ステージ4)

    /** y0 から y1 まで落ちるのにかかる秒数。 */
    const fallTime = (y0, y1) => (Math.sqrt(VY0 * VY0 + 2 * GRAV * (y1 - y0)) - VY0) / GRAV;

    const T_HERO = fallTime(SPAWN_Y, HERO_Y - 22); // 主人公の胴体に届くまでの時間

    /**
     * x0 に湧いた落下物を target に着弾させる水平速度。
     * 斜めになりすぎると「頭上に屋根を張る」だけでは守れなくなってしまうので、
     * 上限をかけて必ずクリア可能な角度に収める。
     */
    const aim = (x0, target) => Math.max(-84, Math.min(84, (target - x0) / T_HERO));

    /** 落下物を等間隔に並べた配列を作る。 */
    const seq = (n, gap, t0, f) => {
      const out = [];
      for (let i = 0; i < n; i++) out.push(Object.assign({ t: t0 + i * gap }, f(i)));
      return out;
    };

    // 落下物の種類。当たり判定はどれも「半径 r の円」で共通。
    const KINDS = {
      rock: { r: 13, face: '#8d96a8', dark: '#59627450' },
      arrow: { r: 9, face: '#dfe7f4', dark: '#8892a6' },
      lava: { r: 11, face: '#ff9a2a', dark: '#c8380a' },
      bomb: { r: 12, face: '#333a4a', dark: '#141822' },
    };

    // 各ステージ: 一言説明・インク総量・壊せる壁・落下物の出現表。
    // 出現表は { t, x, vx, type }。t は秒、x は湧く位置、vx は水平速度。
    const STAGES = [
      {
        hint: 'ドラッグで線を引く。真上から落ちる岩を受け止めろ',
        ink: 230,
        blocks: [],
        wave: seq(6, 1.15, 0.4, (i) => ({
          x: HERO_X + [-12, 9, 0, -18, 14, -5][i],
          vx: 0,
          type: 'rock',
        })),
      },
      {
        hint: '矢が左右から交互に飛んでくる',
        ink: 270,
        blocks: [],
        wave: seq(7, 1.05, 0.5, (i) => {
          const x0 = i % 2 === 0 ? 42 : W - 42;
          return { x: x0, vx: aim(x0, HERO_X + ((i % 3) - 1) * 14), type: 'arrow' };
        }),
      },
      {
        hint: '溶岩のしずくが斜めに散らばって降ってくる',
        ink: 310,
        blocks: [],
        wave: seq(10, 0.78, 0.45, (i) => {
          const x0 = 30 + ((i * 97) % 300);
          // 3 個に 2 個は主人公狙い。残りは端に落ちるだけの引っかけ
          const aimed = i % 3 !== 2;
          const target = aimed ? HERO_X + ((i % 5) - 2) * 12 : i % 2 ? 46 : W - 46;
          return { x: x0, vx: aim(x0, target), type: i % 4 === 3 ? 'rock' : 'lava' };
        }),
      },
      {
        hint: '岩壁は砕ける。真ん中の穴は自分でふさげ',
        ink: 330,
        blocks: [62, 96, 130, 230, 264, 298].map((x) => ({ x, y: WALL_Y, w: 34, h: 16 })),
        wave: seq(10, 0.8, 0.5, (i) => {
          const pat = i % 4;
          // 壁の切れ目 (x=147..213) をまっすぐ抜けてくる本命
          if (pat === 0) return { x: HERO_X - 8, vx: 0, type: 'rock' };
          if (pat === 2) return { x: HERO_X + 10, vx: 0, type: 'bomb' };
          // 斜めの弾。序盤は壁が受けてくれるが、壁が砕けたあとは素通りする
          if (pat === 1) return { x: 40, vx: aim(40, HERO_X - 10), type: 'bomb' };
          return { x: W - 40, vx: aim(W - 40, HERO_X + 10), type: 'arrow' };
        }),
      },
    ];

    // --- 状態はすべてここに閉じ込める ---
    let st = STAGES[0];
    let strokes = [];   // 引き終わったインクの線 { pts: [{x,y}], glow }
    let cur = null;     // ドラッグ中の線
    let hazards = [];   // 落下中のもの
    let blocks = [];    // 壊せる岩壁
    let parts = [];     // 破片・火花
    let ink = 0;
    let inkMax = 1;
    let time = 0;
    let nextIdx = 0;    // 次に湧かせる wave の番号
    let done = 0;       // 決着した落下物の数
    let clearT = 0;
    let over = false;
    let mood = 'calm';
    let shake = 0;
    let flash = 0;
    let noInk = 0;      // インク切れの点滅
    let lastDraw = 0;   // 演出用の時刻。決着後も揺れや火花を動かすために draw 側で持つ
    const cp = { x: 0, y: 0 }; // 最近接点の受け皿 (毎フレーム使い回す)

    const game = {
      hint: STAGES[0].hint,

      start(i) {
        st = STAGES[i % STAGES.length];
        game.hint = st.hint;
        strokes = [];
        cur = null;
        hazards = [];
        parts = [];
        blocks = st.blocks.map((b) => Object.assign({ alive: true }, b));
        ink = inkMax = st.ink;
        time = 0;
        nextIdx = 0;
        done = 0;
        clearT = 0;
        over = false;
        mood = 'calm';
        shake = 0;
        flash = 0;
        noInk = 0;
        lastDraw = 0;
      },

      update(dt) {
        if (over) return;
        time += dt;
        ink = Math.min(inkMax, ink + REGEN * dt);

        // 出現
        while (nextIdx < st.wave.length && time >= st.wave[nextIdx].t) {
          spawn(st.wave[nextIdx]);
          nextIdx++;
        }

        // すり抜け防止のため、物理は細かく刻んで進める
        const steps = Math.max(1, Math.min(12, Math.ceil(dt / 0.008)));
        const h = dt / steps;
        for (let s = 0; s < steps && !over; s++) step(h);

        // 主人公の表情。真上に迫っているものがあれば怯える
        if (!over) {
          mood = 'calm';
          for (const z of hazards) {
            if (z.blocked) continue;
            if (Math.abs(z.x - HERO_X) < 62 && z.y > HERO_Y - 220) { mood = 'scared'; break; }
          }
        }

        // 全部しのぎ切ったらクリア
        if (!over && nextIdx >= st.wave.length && hazards.length === 0) {
          clearT += dt;
          if (clearT > 0.35) {
            over = true;
            mood = 'happy';
            api.say('守り切った！', 1100);
            api.win();
          }
        }
      },

      /** 検証用: 主人公の頭上に水平な屋根を一本引く。これで必ず全部受け止まる。 */
      solve() {
        const y = HERO_Y - 72;
        const x0 = HERO_X - 82;
        const x1 = HERO_X + 82;
        game.pointer(x0, y, 'down');
        for (let i = 1; i <= 8; i++) game.pointer(x0 + ((x1 - x0) * i) / 8, y, 'move');
        game.pointer(x1, y, 'up');
      },

      pointer(x, y, ph) {
        if (over) return;
        x = Math.max(2, Math.min(W - 2, x));
        y = Math.max(2, Math.min(H - 2, y));

        if (ph === 'down') {
          if (ink < 2) { noInk = 0.6; sfx.fail(); return; }
          cur = { pts: [{ x, y }], glow: 0 };
          strokes.push(cur);
          sfx.tap();
          return;
        }
        if (!cur) return;

        if (ph === 'move') {
          const last = cur.pts[cur.pts.length - 1];
          let dx = x - last.x;
          let dy = y - last.y;
          let d = Math.hypot(dx, dy);
          if (d < 3) return;
          if (d > ink) {
            // 残量ぶんだけ伸ばして打ち止め
            const k = ink / d;
            dx *= k; dy *= k; d = ink;
            noInk = 0.6;
          }
          ink -= d;
          cur.pts.push({ x: last.x + dx, y: last.y + dy });
          if (ink < 2) { ink = 0; endStroke(); sfx.fail(); }
          return;
        }

        endStroke();
      },

      draw(ctx) {
        cosmetic();
        ctx.save();
        if (shake > 0) ctx.translate((rnd() - 0.5) * shake, (rnd() - 0.5) * shake);

        // 背景 (夜空と両脇の岩壁)
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#132038');
        bg.addColorStop(0.55, '#1b2a44');
        bg.addColorStop(1, '#0b101d');
        ctx.fillStyle = bg;
        ctx.fillRect(-12, -12, W + 24, H + 24);
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        for (let k = 0; k < 26; k++) {
          const sx = (k * 137) % W;
          const sy = (k * 61) % 300;
          ctx.globalAlpha = 0.15 + ((k * 7) % 5) * 0.09;
          ctx.fillRect(sx, sy, 1.6, 1.6);
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#141c2e';
        ctx.fillRect(-12, -12, 26, H + 24);
        ctx.fillRect(W - 14, -12, 26, H + 24);

        // 地面
        const gd = ctx.createLinearGradient(0, HERO_Y - 6, 0, H);
        gd.addColorStop(0, '#3b3b52');
        gd.addColorStop(1, '#1a1a28');
        ctx.fillStyle = gd;
        ctx.fillRect(-12, HERO_Y, W + 24, H - HERO_Y + 12);
        ctx.fillStyle = 'rgba(255,255,255,.10)';
        ctx.fillRect(-12, HERO_Y, W + 24, 2);

        // 壊せる岩壁
        for (const b of blocks) {
          if (!b.alive) continue;
          gfx.roundRect(ctx, b.x - b.w / 2, b.y - b.h / 2, b.w, b.h, 4, '#7d6a4e', '#4c3f2c', 2);
          ctx.fillStyle = 'rgba(255,255,255,.14)';
          ctx.fillRect(b.x - b.w / 2 + 4, b.y - b.h / 2 + 3, b.w - 8, 3);
        }

        // これから湧くものの予告
        for (let i = nextIdx; i < st.wave.length; i++) {
          const w = st.wave[i];
          const left = w.t - time;
          if (left > 0.75) break;
          ctx.save();
          ctx.globalAlpha = 0.35 + 0.35 * Math.sin(time * 22);
          ctx.translate(Math.max(16, Math.min(W - 16, w.x)), 72);
          ctx.rotate(Math.atan2(VY0, w.vx) - Math.PI / 2);
          ctx.fillStyle = '#ff6b5a';
          ctx.beginPath();
          ctx.moveTo(0, 9);
          ctx.lineTo(-7, -5);
          ctx.lineTo(7, -5);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }

        // 主人公 (落下物より先に描いて、当たった瞬間は隠れるように)
        gfx.guy(ctx, HERO_X, HERO_Y, 1.2, mood, '#4a7de0');

        // インクの線
        for (const s of strokes) drawStroke(ctx, s);

        // 落下物
        for (const z of hazards) drawHazard(ctx, z);

        // 火花・破片
        for (const p of parts) {
          ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.max));
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
        }
        ctx.globalAlpha = 1;

        // 被弾の白フラッシュ
        if (flash > 0) {
          ctx.fillStyle = `rgba(255,90,74,${Math.min(0.55, flash * 0.55)})`;
          ctx.fillRect(-12, -12, W + 24, H + 24);
        }
        ctx.restore();

        drawHud(ctx);
      },
    };

    /**
     * 揺れ・火花・線の発光といった見た目だけの進行。
     * update() は決着すると呼ばれなくなるので、draw() 側で自前に時間を計る。
     * (被弾の赤フラッシュが出っぱなしで固まるのを防ぐ)
     */
    function cosmetic() {
      const now = Date.now();
      const d = lastDraw ? Math.min(0.05, (now - lastDraw) / 1000) : 0.016;
      lastDraw = now;
      if (shake > 0) shake -= d * 26;
      if (flash > 0) flash -= d * 2.6;
      if (noInk > 0) noInk -= d;
      for (const s of strokes) if (s.glow > 0) s.glow -= d * 3;
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life -= d;
        if (p.life <= 0) { parts.splice(i, 1); continue; }
        p.vy += 260 * d;
        p.x += p.vx * d;
        p.y += p.vy * d;
      }
    }

    /** ドラッグ中の線を確定する。点が 1 つだけなら捨てる。 */
    function endStroke() {
      if (cur && cur.pts.length < 2) strokes.splice(strokes.indexOf(cur), 1);
      cur = null;
    }

    /** 出現表 1 件から落下物を作る。 */
    function spawn(w) {
      const k = KINDS[w.type];
      hazards.push({
        x: w.x,
        y: SPAWN_Y,
        vx: w.vx,
        vy: VY0,
        r: k.r,
        type: w.type,
        spin: 0,
        spinV: w.type === 'rock' ? (rnd() - 0.5) * 4 : 0,
        blocked: false,
        fade: 0,
      });
      sfx.popup();
    }

    /** 点 (px,py) と線分 ab の最近接点を cp に入れ、距離を返す。 */
    function closestOnSeg(px, py, ax, ay, bx, by) {
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      cp.x = ax + dx * t;
      cp.y = ay + dy * t;
      return Math.hypot(px - cp.x, py - cp.y);
    }

    /** 落下物を法線方向に弾く。弾かれたものは無害になり、砕けながら滑り落ちる。 */
    function knock(z, nx, ny, push) {
      let d = Math.hypot(nx, ny);
      if (d < 0.0001) { nx = 0; ny = -1; d = 1; }
      nx /= d;
      ny /= d;
      z.x += nx * (push || 0);
      z.y += ny * (push || 0);
      const vn = z.vx * nx + z.vy * ny;
      if (vn < 0) {
        // 反発は控えめ。残った接線成分で線に沿ってずり落ちる
        z.vx -= 1.45 * vn * nx;
        z.vy -= 1.45 * vn * ny;
      }
      z.vx *= 0.88;
      z.vy *= 0.88;
      z.blocked = true;
      z.fade = 0;
      z.spinV = (rnd() - 0.5) * 16;
    }

    /** 破片をばらまく。 */
    function burst(x, y, color, n) {
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const sp = 40 + rnd() * 150;
        parts.push({
          x, y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 40,
          life: 0.3 + rnd() * 0.35,
          max: 0.65,
          color,
          s: 2 + rnd() * 3,
        });
      }
    }

    /** 物理 1 刻み。h は秒。 */
    function step(h) {
      for (let i = hazards.length - 1; i >= 0; i--) {
        const z = hazards[i];
        z.vy += GRAV * h;
        z.x += z.vx * h;
        z.y += z.vy * h;
        z.spin += z.spinV * h;

        // 弾かれたものは砕けて消えるだけ。もう主人公には当たらない
        if (z.blocked) {
          z.fade += h;
          if (z.fade >= FADE || z.y > H + 40) { hazards.splice(i, 1); done++; }
          continue;
        }

        // 壊せる岩壁 (壁は 1 発で砕け、落下物もそこで止まる)
        let hit = false;
        for (const b of blocks) {
          if (!b.alive) continue;
          const qx = Math.max(b.x - b.w / 2, Math.min(b.x + b.w / 2, z.x));
          const qy = Math.max(b.y - b.h / 2, Math.min(b.y + b.h / 2, z.y));
          const dx = z.x - qx;
          const dy = z.y - qy;
          if (dx * dx + dy * dy > z.r * z.r) continue;
          b.alive = false;
          burst(b.x, b.y, '#a58c62', 16);
          burst(z.x, z.y, '#e8d6a8', 8);
          knock(z, dx, dy, 0);
          sfx.merge();
          shake = Math.max(shake, 8);
          hit = true;
          break;
        }
        if (hit) continue;

        // インクの線
        for (const s of strokes) {
          const p = s.pts;
          for (let k = 0; k + 1 < p.length; k++) {
            const need = z.r + LINE_W / 2;
            const d = closestOnSeg(z.x, z.y, p[k].x, p[k].y, p[k + 1].x, p[k + 1].y);
            if (d > need) continue;
            knock(z, z.x - cp.x, z.y - cp.y, need - d);
            s.glow = 0.32;
            burst(cp.x, cp.y, z.type === 'lava' ? '#ffd06b' : '#9ef2ff', z.type === 'bomb' ? 20 : 12);
            sfx.coin();
            shake = Math.max(shake, z.type === 'bomb' ? 9 : 5);
            hit = true;
            break;
          }
          if (hit) break;
        }
        if (hit) continue;

        // 主人公に直撃
        const bx = Math.max(HERO_X - 13, Math.min(HERO_X + 13, z.x));
        const by = Math.max(HERO_Y - 38, Math.min(HERO_Y, z.y));
        if ((z.x - bx) ** 2 + (z.y - by) ** 2 <= z.r * z.r) {
          burst(z.x, z.y, '#ff7a5a', 24);
          shake = 14;
          flash = 1;
          mood = 'dead';
          over = true;
          hazards.splice(i, 1);
          api.lose('主人公に直撃した');
          return;
        }

        // 地面に落ちて砕けた / 画面外
        if (z.y - z.r > HERO_Y) {
          burst(z.x, HERO_Y - 2, '#6b7488', 10);
          hazards.splice(i, 1);
          done++;
          continue;
        }
        if (z.x < -70 || z.x > W + 70 || z.y > H + 60) { hazards.splice(i, 1); done++; }
      }
    }

    /** インクの線。外側の光 → 本体 → 芯の 3 重で描くと「インク」らしくなる。 */
    function drawStroke(ctx, s) {
      const p = s.pts;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(p[0].x, p[0].y);
      for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
      if (p.length === 1) ctx.lineTo(p[0].x + 0.1, p[0].y);
      const g = Math.max(0, s.glow);
      ctx.strokeStyle = `rgba(70,224,255,${0.2 + g * 0.6})`;
      ctx.lineWidth = LINE_W + 8 + g * 8;
      ctx.stroke();
      ctx.strokeStyle = g > 0.05 ? '#a8f4ff' : '#2ec9ee';
      ctx.lineWidth = LINE_W;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(232,252,255,.92)';
      ctx.lineWidth = LINE_W * 0.32;
      ctx.stroke();
      ctx.restore();
    }

    /** 落下物 1 つ。 */
    function drawHazard(ctx, z) {
      const k = KINDS[z.type];
      ctx.save();
      ctx.translate(z.x, z.y);
      if (z.blocked) {
        const t = Math.max(0, 1 - z.fade / FADE);
        ctx.globalAlpha = t;
        ctx.scale(0.55 + t * 0.45, 0.55 + t * 0.45);
      }

      if (z.type === 'arrow') {
        ctx.rotate(Math.atan2(z.vy, z.vx) - Math.PI / 2);
        ctx.strokeStyle = '#a9743f';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, -16);
        ctx.lineTo(0, 8);
        ctx.stroke();
        ctx.fillStyle = k.face;
        ctx.beginPath();
        ctx.moveTo(0, 16);
        ctx.lineTo(-6, 5);
        ctx.lineTo(6, 5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#e05a5a';
        ctx.fillRect(-5, -18, 10, 4);
      } else if (z.type === 'bomb') {
        gfx.circle(ctx, 0, 0, k.r, k.face, k.dark, 2);
        gfx.circle(ctx, -4, -4, 3.4, 'rgba(255,255,255,.32)');
        ctx.strokeStyle = '#c9a15a';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(3, -k.r + 1);
        ctx.quadraticCurveTo(10, -k.r - 6, 5, -k.r - 11);
        ctx.stroke();
        gfx.circle(ctx, 5, -k.r - 12, 2.6 + Math.sin(z.spin * 9 + z.y * 0.3) * 0.9, '#ffd15c');
      } else if (z.type === 'lava') {
        ctx.rotate(Math.atan2(z.vy, z.vx) - Math.PI / 2);
        const gr = ctx.createRadialGradient(0, 0, 1, 0, 0, k.r + 5);
        gr.addColorStop(0, '#fff0b0');
        gr.addColorStop(0.45, k.face);
        gr.addColorStop(1, 'rgba(200,56,10,0)');
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.arc(0, 0, k.r + 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = k.face;
        ctx.beginPath();
        ctx.moveTo(0, -k.r - 8);
        ctx.quadraticCurveTo(k.r, -k.r * 0.2, 0, k.r);
        ctx.quadraticCurveTo(-k.r, -k.r * 0.2, 0, -k.r - 8);
        ctx.fill();
        gfx.circle(ctx, -2.5, 1, 2.6, 'rgba(255,255,255,.6)');
      } else {
        ctx.rotate(z.spin);
        ctx.fillStyle = k.face;
        ctx.beginPath();
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          const rr = k.r * (i % 2 ? 0.84 : 1);
          ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,.28)';
        ctx.beginPath();
        ctx.arc(-k.r * 0.28, k.r * 0.3, k.r * 0.44, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.22)';
        ctx.beginPath();
        ctx.arc(k.r * 0.3, -k.r * 0.34, k.r * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    /** 上部のインク残量ゲージと残数表示。 */
    function drawHud(ctx) {
      const bx = 62;
      const by = 14;
      const bw = W - 118; // 右端は残量の数字の場所として空けておく
      const bh = 16;
      const p = Math.max(0, Math.min(1, ink / inkMax));
      const low = p < 0.25;

      gfx.roundRect(ctx, bx, by, bw, bh, 8, 'rgba(0,0,0,.5)', 'rgba(255,255,255,.28)', 1.5);
      if (p > 0.005) {
        const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
        g.addColorStop(0, low ? '#ff8a6a' : '#2ec9ee');
        g.addColorStop(1, low ? '#ff5a4a' : '#9ef2ff');
        gfx.roundRect(ctx, bx + 2, by + 2, (bw - 4) * p, bh - 4, 6, g);
      }
      const blink = noInk > 0 && Math.sin(noInk * 40) > 0;
      gfx.text(ctx, 'インク', 14, by + bh / 2 + 1, {
        size: 13,
        align: 'left',
        color: blink || low ? '#ff9a8a' : '#cfe9ff',
      });
      gfx.text(ctx, `${Math.round(ink)}`, W - 14, by + bh / 2 + 1, {
        size: 13,
        align: 'right',
        color: low ? '#ff9a8a' : '#cfe9ff',
      });

      const left = st.wave.length - done;
      gfx.text(ctx, `のこり ${left}`, W - 14, by + bh + 14, { size: 13, align: 'right', color: '#ffd15c' });
      if (noInk > 0) gfx.text(ctx, 'インクが足りない！', W / 2, by + bh + 14, { size: 13, color: '#ff9a8a' });
    }

    return game;
  },
};
