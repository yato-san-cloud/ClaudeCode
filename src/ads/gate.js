// 「数字ゲート／軍隊増殖ランナー」系の広告ゲーム。
// 棒人間の集団が道を自動で走り、対で現れるゲートのどちらかを通ると人数が増減する。
// ゲートを抜けきったら敵軍との数比べ（バトル）。多いほうが勝ち。
//
// 規約: トップレベルの宣言は export const GATE ただ 1 つ。
// 状態はすべて create() の中に閉じ込める（バンドル後は全部が同じスコープに並ぶため）。

import { gfx } from '../gfx.js';

export const GATE = {
  meta: {
    id: 'gate',
    title: '数字ゲート',
    hook: '最後まで正解できるのは3%',
    icon: '🚪',
    reality: '実際は…放置系のタワー建設',
    stages: 4,
    tint: '#2e86de',
  },

  create(api) {
    const { W, H, sfx } = api;

    // --- レイアウト定数 ---
    const ROAD_L = 22;              // 道の左端
    const ROAD_R = W - 22;          // 道の右端
    const CROWD_Y = 392;            // 自軍の足元。画面上は固定で、道のほうが流れる
    const MOVE_L = ROAD_L + 30;     // 指でつまめる範囲
    const MOVE_R = ROAD_R - 30;
    const LANE_L = W * 0.28;        // 左ゲートの正面
    const LANE_R = W * 0.72;        // 右ゲートの正面
    const SPEED = 120;              // 前進速度 px/秒
    const FIRST_ROW = 210;          // 最初のゲートまでの距離
    const ROW_GAP = 140;            // ゲート間の距離
    const ENEMY_PAD = 250;          // 最後のゲートから敵陣まで
    const BATTLE_GAP = 92;          // ここまで詰めたら激突
    const GATE_H = 52;

    // --- 演算子 ---
    const mul = (v) => ({ k: 'mul', v });
    const add = (v) => ({ k: 'add', v });
    const sub = (v) => ({ k: 'sub', v });
    const div = (v) => ({ k: 'div', v });
    const OPS = {
      label: (o) => (o.k === 'mul' ? '×' : o.k === 'add' ? '+' : o.k === 'sub' ? '−' : '÷') + o.v,
      plus: (o) => o.k === 'mul' || o.k === 'add', // 見た目の色分け（増える＝緑）
      apply: (o, n) => {
        if (o.k === 'mul') return Math.floor(n * o.v);
        if (o.k === 'add') return n + o.v;
        if (o.k === 'sub') return Math.max(0, n - o.v);
        return Math.max(0, Math.floor(n / o.v));
      },
    };

    // 各ステージ: 開始人数・敵の人数・ゲート列 [左, 右]。
    // どれも「最善手を通せば必ず敵を上回る」ように数値を組んである。
    //  1: 12 →×3→ 36 →×4→ 144  (敵100)  ／ 他の道は最大 72
    //  2:  8 →+20→ 28 →×3→ 84 →×2→ 168 (敵140) ／ 次点は 136
    //  3:  4 →+22→ 26 →×4→ 104 →×2→ 208 →×3→ 624 (敵480) ／ 勝てるのは 2 通り
    //  4:  3 →+28→ 31 →×5→ 155 →×2→ 310 →+120→ 430 →×2→ 860 (敵700) ／ 勝ち筋は 1 本だけ
    const STAGES = [
      {
        hint: '左右にドラッグして、人数が増えるゲートを通ろう',
        start: 12,
        enemy: 100,
        rows: [
          [mul(3), add(6)],
          [add(30), mul(4)],
        ],
      },
      {
        hint: 'かけ算は人数が多いほど効く。通す順番が勝負',
        start: 8,
        enemy: 140,
        rows: [
          [mul(2), add(20)],
          [mul(3), add(40)],
          [add(30), mul(2)],
        ],
      },
      {
        hint: '赤いゲートは人数が減る。目先の大きい数字に釣られるな',
        start: 4,
        enemy: 480,
        rows: [
          [mul(6), add(22)],
          [mul(4), add(35)],
          [sub(30), mul(2)],
          [mul(3), add(90)],
        ],
      },
      {
        hint: 'ゲート5連続。敵は700人、勝ち筋はたった1本',
        start: 3,
        enemy: 700,
        rows: [
          [mul(7), add(28)],
          [mul(5), add(55)],
          [sub(40), mul(2)],
          [add(120), div(2)],
          [add(100), mul(2)],
        ],
      },
    ];

    // 集団の並び位置（単位円内に均等散らし）。黄金角スパイラルなので、
    // 先頭 n 個だけ使うと半径 √(n/64) の円に均等に収まる＝人数が増えると自然に群れが広がる。
    const SPOTS = [];
    for (let i = 0; i < 64; i++) {
      const a = i * 2.39996;
      const r = Math.sqrt((i + 0.5) / 64);
      SPOTS.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    // 奥（y が小さい）から描くための順番。毎フレームのソートを避けて先に作っておく。
    const ORDER = SPOTS.map((_, i) => i).sort((a, b) => SPOTS[a].y - SPOTS[b].y);
    const BLOB_RX = 54;
    const BLOB_RY = 24;

    // --- 状態はすべてここに閉じ込める ---
    let st = STAGES[0];
    let rows = [];
    let count = 0;
    let enemy = 0;
    let enemyDist = 0;
    let travel = 0;
    let crowdX = W / 2;
    let targetX = W / 2;
    let passedN = 0;
    let phase = 'run'; // run | battle | over
    let btime = 0;
    let loss = 0;
    let pops = [];
    let auto = false;
    let shake = 0;
    let pop = 0;
    let clock = 0;

    const game = {
      hint: STAGES[0].hint,

      start(i) {
        st = STAGES[i % STAGES.length];
        game.hint = st.hint;
        rows = st.rows.map((ops, k) => ({ ops, dist: FIRST_ROW + k * ROW_GAP, taken: -1 }));
        enemyDist = rows[rows.length - 1].dist + ENEMY_PAD;
        count = st.start;
        enemy = st.enemy;
        travel = 0;
        crowdX = W / 2;
        targetX = W / 2;
        passedN = 0;
        phase = 'run';
        btime = 0;
        loss = 0;
        pops = [];
        auto = false;
        shake = 0;
        pop = 0;
        clock = 0;
      },

      update(dt) {
        clock += dt;
        if (shake > 0) shake = Math.max(0, shake - dt * 34);
        if (pop > 0) pop = Math.max(0, pop - dt * 3);
        for (let i = pops.length - 1; i >= 0; i--) {
          pops[i].life -= dt;
          pops[i].y -= dt * 36;
          if (pops[i].life <= 0) pops.splice(i, 1);
        }

        if (phase === 'run') {
          if (auto) targetX = bestLane();
          crowdX += (targetX - crowdX) * Math.min(1, dt * 12);
          travel += SPEED * dt;

          // 追い越したゲートを順に処理（1 フレームで 2 段は跨がない想定だが一応ループ）
          while (passedN < rows.length && travel >= rows[passedN].dist) {
            if (!passGate(rows[passedN])) return;
            passedN++;
          }

          if (travel >= enemyDist - BATTLE_GAP) {
            travel = enemyDist - BATTLE_GAP;
            phase = 'battle';
            btime = 0;
            loss = Math.min(count, enemy);
            shake = 11;
            sfx.merge();
            api.say('突撃！', 900);
          }
          return;
        }

        if (phase === 'battle') {
          btime += dt;
          if (btime < 1.15 && shake <= 0) shake = 7; // ぶつかっている間は揺らし続ける
          if (btime > 1.55) {
            phase = 'over';
            if (count > enemy) {
              api.say('突破！', 1200);
              api.win();
            } else {
              api.lose(`自軍${count}人では敵${enemy}人に押し負ける`);
            }
          }
        }
      },

      /** 検証用: 以降のゲートを全部読んで、最終人数が最大になる側へ自動で寄る。 */
      solve() {
        auto = true;
      },

      pointer(x, y, ph) {
        if (phase !== 'run' || ph === 'up') return;
        auto = false;
        targetX = gfx.clamp(x, MOVE_L, MOVE_R);
      },

      draw(ctx) {
        ctx.save();
        if (shake > 0) ctx.translate((api.rnd() - 0.5) * shake, (api.rnd() - 0.5) * shake);

        drawRoad(ctx);

        // 激突の進み具合 0..1。決着後も 1 のまま保って「敵が消えた画」を残す
        const bp = phase === 'run' ? 0 : Math.min(1, btime / 1.1);
        const myY = CROWD_Y - bp * 12;
        const enY = CROWD_Y - (enemyDist - travel) + bp * 12;
        // 激突中は相打ちぶんを両軍から削る。loss は走行中 0 なので素の人数になる
        const myNow = Math.max(0, Math.round(count - loss * bp));
        const enNow = Math.max(0, Math.round(enemy - loss * bp));

        // 敵軍（奥）→ ゲート → 自軍 の順に重ねる
        if (enY > -40 && enNow > 0) {
          drawCrowd(ctx, W / 2, enY, enNow, '#d64541', bp > 0.2 ? 'scared' : 'calm', 1);
        }
        for (const r of rows) drawGate(ctx, r);
        if (myNow > 0) {
          // ゲート通過直後だけ群れをふくらませて「増えた！」を見せる
          drawCrowd(ctx, crowdX, myY, myNow, '#3f6fd8', bp > 0.2 && count > enemy ? 'happy' : 'calm', 1 + pop * 0.18);
        }

        // ゲート通過時に飛ぶ数字
        for (const p of pops) {
          ctx.globalAlpha = Math.min(1, p.life * 2.2);
          gfx.text(ctx, p.text, p.x, p.y, { size: 26, color: p.color });
          ctx.globalAlpha = 1;
        }

        // 遠景のもや。奥から湧いて出る絵をぼかしつつ、上のバーとの境界を作る
        const hz = ctx.createLinearGradient(0, 0, 0, 76);
        hz.addColorStop(0, 'rgba(16,22,36,.94)');
        hz.addColorStop(1, 'rgba(16,22,36,0)');
        ctx.fillStyle = hz;
        ctx.fillRect(0, 0, W, 76);

        // 人数バッジ
        drawBadge(ctx, crowdX, myY + 56, myNow, '#7fb0ff');
        if (enY > 140 && enNow > 0) drawBadge(ctx, W / 2, enY - 76, enNow, '#ff9a94');

        drawHud(ctx);
        ctx.restore();
      },
    };

    /** ゲートを 1 段通す。全滅したら false を返して以降の処理を止める。 */
    function passGate(row) {
      const side = crowdX < W / 2 ? 0 : 1;
      const op = row.ops[side];
      const before = count;
      count = OPS.apply(op, count);
      row.taken = side;
      pop = 1;
      pops.push({
        x: side ? LANE_R : LANE_L,
        y: CROWD_Y - 52,
        text: OPS.label(op),
        color: count >= before ? '#9dffc0' : '#ffa8a2',
        life: 0.9,
      });
      if (count > before) sfx.coin(); else sfx.fail();
      if (count <= 0) {
        count = 0;
        phase = 'over';
        api.lose('ゲートで軍が全滅した');
        return false;
      }
      return true;
    }

    /** 残りのゲートを全部読んだうえで、いま寄るべきレーンの中心 x。 */
    function bestLane() {
      if (passedN >= rows.length) return targetX;
      const r = rows[passedN];
      const l = bestFrom(passedN + 1, OPS.apply(r.ops[0], count));
      const rr = bestFrom(passedN + 1, OPS.apply(r.ops[1], count));
      return l >= rr ? LANE_L : LANE_R;
    }

    /** i 段目以降を最善で通したときの最終人数。段数は最大 5 なので総当たりで足りる。 */
    function bestFrom(i, n) {
      if (i >= rows.length) return n;
      return Math.max(
        bestFrom(i + 1, OPS.apply(rows[i].ops[0], n)),
        bestFrom(i + 1, OPS.apply(rows[i].ops[1], n)),
      );
    }

    /** 草地とアスファルト。横線を流して疾走感を出す。 */
    function drawRoad(ctx) {
      gfx.sky(ctx, W, H, '#63c46f', '#2c7541');
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#3f4c63');
      g.addColorStop(1, '#606f8a');
      ctx.fillStyle = g;
      ctx.fillRect(ROAD_L, 0, ROAD_R - ROAD_L, H);

      ctx.fillStyle = 'rgba(255,255,255,.07)';
      const step = 46;
      for (let y = ((CROWD_Y + travel) % step) - step; y < H + step; y += step) {
        ctx.fillRect(ROAD_L + 5, y, ROAD_R - ROAD_L - 10, 5);
      }
      ctx.fillStyle = 'rgba(255,255,255,.2)';
      for (let y = ((CROWD_Y + travel) % 34) - 34; y < H; y += 34) {
        ctx.fillRect(W / 2 - 2, y, 4, 17);
      }
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.fillRect(ROAD_L, 0, 3, H);
      ctx.fillRect(ROAD_R - 3, 0, 3, H);
    }

    /** ゲート 1 段（左右 2 枚）。 */
    function drawGate(ctx, row) {
      const y = CROWD_Y - (row.dist - travel);
      // くぐり終わったゲートは足元で消す（下のバーに被せない）
      const fade = gfx.clamp((CROWD_Y + 30 - y) / 40, 0, 1);
      if (y < -GATE_H || fade <= 0) return;
      const top = y - GATE_H / 2;
      const w = W / 2 - ROAD_L - 4;
      for (let s = 0; s < 2; s++) {
        const o = row.ops[s];
        const x = s ? W / 2 + 4 : ROAD_L;
        const up = OPS.plus(o);
        const col = up ? '#2ecc71' : '#e74c3c';
        ctx.globalAlpha = fade * (row.taken >= 0 && row.taken !== s ? 0.22 : 0.95);
        gfx.roundRect(ctx, x, top, w, GATE_H, 10, up ? 'rgba(46,204,113,.32)' : 'rgba(231,76,60,.32)', col, 3);
        gfx.roundRect(ctx, x, top, w, 9, 4, col);
        gfx.text(ctx, OPS.label(o), x + w / 2, y + 6, { size: 27, color: '#fff', weight: 900 });
        ctx.globalAlpha = 1;
      }
    }

    /** 棒人間の集団。多いときは 64 体で頭打ちにして間引く。 */
    function drawCrowd(ctx, cx, cy, n, color, mood, grow) {
      const shown = Math.max(1, Math.min(64, n));
      for (const i of ORDER) {
        if (i >= shown) continue;
        const sp = SPOTS[i];
        const gx = cx + sp.x * BLOB_RX * grow;
        const gy = cy + sp.y * BLOB_RY * grow + Math.sin(clock * 9 + i * 1.7) * 1.6;
        gfx.guy(ctx, gx, gy, 0.4 + (sp.y + 1) * 0.055, mood, color);
      }
    }

    /** 集団に付く人数バッジ。画面外にはみ出さないよう x を丸める。 */
    function drawBadge(ctx, cx, y, n, col) {
      const label = n + '人';
      const w = 46 + String(n).length * 14;
      const x = gfx.clamp(cx, w / 2 + 8, W - w / 2 - 8);
      gfx.roundRect(ctx, x - w / 2, y - 17, w, 34, 17, 'rgba(12,16,26,.66)', col, 3);
      gfx.text(ctx, label, x, y + 1, { size: 20, color: '#fff', weight: 900 });
    }

    /** 上部の情報バーと下部の進捗バー。 */
    function drawHud(ctx) {
      gfx.roundRect(ctx, 12, 8, 112, 28, 14, 'rgba(12,16,26,.6)', 'rgba(255,255,255,.35)', 2);
      gfx.text(ctx, `ゲート ${Math.min(passedN + 1, rows.length)}/${rows.length}`, 68, 23, { size: 15 });
      gfx.roundRect(ctx, W - 124, 8, 112, 28, 14, 'rgba(12,16,26,.6)', '#e74c3c', 2);
      gfx.text(ctx, `敵 ${enemy}人`, W - 68, 23, { size: 15, color: '#ffb8b2' });

      const x0 = 26;
      const x1 = W - 26;
      const y = 500;
      gfx.roundRect(ctx, x0, y - 4, x1 - x0, 8, 4, 'rgba(0,0,0,.4)');
      const p = gfx.clamp(travel / enemyDist, 0, 1);
      gfx.roundRect(ctx, x0, y - 4, (x1 - x0) * p, 8, 4, '#ffd15c');
      for (const r of rows) {
        gfx.circle(ctx, x0 + (x1 - x0) * (r.dist / enemyDist), y, 4, travel >= r.dist ? '#ffd15c' : 'rgba(255,255,255,.6)');
      }
      gfx.circle(ctx, x1, y, 5.5, '#e74c3c', '#fff', 2);
    }

    return game;
  },
};
