// 「穴を掘って宝にたどり着く」系の広告ゲーム。
// 溶岩と岩盤を避けながらルートを選び、限られたスタミナで宝石を集めて宝箱へ。
//
// ステージは ASCII マップで持ち、内部に幅優先探索のソルバを積んである。
// solve() はそのソルバの最短手をなぞるだけなので、
// 「クリア不能なステージを置いてしまう」事故が起きない。

export const DIG = {
  meta: {
    id: 'dig',
    title: '地底の宝さがし',
    hook: 'ルートを間違えると溶岩直行',
    icon: '⛏️',
    reality: '実際は…放置系コイン増やし',
    stages: 4,
    tint: '#8a5a1f',
  },

  create(api) {
    const { W, H, sfx } = api;

    // . 土 / # 岩盤(掘れない) / L 溶岩(即死) / G 宝石 / T 宝箱 / S 開始地点
    const STAGES = [
      {
        hint: '宝石を全部拾って宝箱へ。',
        stamina: 19, // 最短 16 手
        map: [
          '...S....',
          '..#..#..',
          '..#..#..',
          '.....G..',
          '.##.##..',
          '.#L..#..',
          '.#...#..',
          '.....#..',
          '..##....',
          '..#..G..',
          '...T....',
        ],
      },
      {
        hint: '溶岩だまりの脇を通るしかない。',
        stamina: 26, // 最短 23 手
        map: [
          '..S.....',
          '.##.###.',
          '.#....G.',
          '.#.##.#.',
          '...#L.#.',
          '.#.#LL#.',
          '.#....#.',
          '.####.#.',
          'G.....#.',
          '.####...',
          '...T....',
        ],
      },
      {
        hint: '遠回りが正解のときもある。',
        stamina: 33, // 最短 30 手
        map: [
          '.S......',
          '.#.####.',
          '.#....#.',
          '.#.##.#.',
          '.G.#L.#.',
          '.###L#..',
          '....L#.G',
          '.##..#.#',
          '.#L..#..',
          '.#.###.#',
          '...T....',
        ],
      },
      {
        hint: 'スタミナがぎりぎり。無駄足は許されない。',
        stamina: 39, // 最短 37 手
        map: [
          'S.......',
          '.######.',
          '.....G#.',
          '####..#.',
          'L..#.##.',
          '.G.#....',
          '.###.##.',
          '.....#L.',
          '####.#..',
          'G....#.#',
          '...T....',
        ],
      },
    ];

    const COLS = 8;
    const ROWS = 11;
    const CELL = 40;
    const OX = (W - COLS * CELL) / 2;
    const OY = 62;

    // --- 状態はすべてここに閉じ込める ---
    let st = STAGES[0];
    let grid = [];
    let dug = [];
    let pos = 0;
    let start = 0;
    let stamina = 0;
    let gems = [];
    let got = 0;
    let treasure = 0;
    let over = false;
    let anim = 0;
    let bump = null; // 掘れない場所を叩いたときの演出
    let route = null; // solve() 用の手順
    let routeAt = 0;
    let routeWait = 0;

    const idx = (c, r) => r * COLS + c;
    const colOf = (i) => i % COLS;
    const rowOf = (i) => (i / COLS) | 0;
    const cellX = (i) => OX + colOf(i) * CELL;
    const cellY = (i) => OY + rowOf(i) * CELL;

    /** 4 近傍。盤外は返さない。 */
    function neighbors(i) {
      const c = colOf(i);
      const r = rowOf(i);
      const out = [];
      if (c > 0) out.push(i - 1);
      if (c < COLS - 1) out.push(i + 1);
      if (r > 0) out.push(i - COLS);
      if (r < ROWS - 1) out.push(i + COLS);
      return out;
    }

    const passable = (i) => grid[i] !== '#' && grid[i] !== 'L';

    /**
     * 幅優先探索で「全宝石を拾って宝箱へ着く」最短手順を求める。
     * 状態は (位置, 拾った宝石のビット) 。宝石は最大 3 個なので状態数はごく少ない。
     * 見つからなければ null（＝ステージ定義のミス）。
     */
    function solveRoute() {
      const full = (1 << gems.length) - 1;
      const key = (p, m) => p * 16 + m;
      const seen = new Set([key(start, 0)]);
      let q = [{ p: start, m: 0, path: [] }];
      while (q.length) {
        const next = [];
        for (const cur of q) {
          for (const n of neighbors(cur.p)) {
            if (!passable(n)) continue;
            let m = cur.m;
            const gi = gems.indexOf(n);
            if (gi >= 0) m |= 1 << gi;
            const k = key(n, m);
            if (seen.has(k)) continue;
            seen.add(k);
            const path = [...cur.path, n];
            if (n === treasure && m === full) return path;
            next.push({ p: n, m, path });
          }
        }
        q = next;
      }
      return null;
    }

    /** 1 マス進む。掘れない場所なら跳ね返す。 */
    function step(target) {
      if (over) return;
      if (!neighbors(pos).includes(target)) return;

      if (grid[target] === '#') {
        bump = { i: target, t: 0.35, why: '岩盤は掘れない' };
        sfx.tap();
        return;
      }
      stamina--;
      dug[target] = true;
      pos = target;

      if (grid[target] === 'L') {
        over = true;
        api.lose('溶岩を掘り当ててしまった');
        return;
      }
      const gi = gems.indexOf(target);
      if (gi >= 0 && !gems.taken?.[gi]) {
        grid[target] = '.';
        got++;
        sfx.coin();
      } else {
        sfx.tap();
      }
      if (target === treasure) {
        if (got >= gems.length) {
          over = true;
          api.win();
        } else {
          api.say(`宝石があと ${gems.length - got} 個`, 900);
        }
        return;
      }
      if (stamina <= 0) {
        over = true;
        api.lose('スタミナが尽きた');
      }
    }

    const game = {
      hint: STAGES[0].hint,

      start(i) {
        st = STAGES[i % STAGES.length];
        game.hint = st.hint;
        grid = st.map.join('').split('');
        dug = new Array(COLS * ROWS).fill(false);
        gems = [];
        over = false;
        got = 0;
        anim = 0;
        bump = null;
        route = null;
        routeAt = 0;
        routeWait = 0;
        stamina = st.stamina;

        for (let k = 0; k < grid.length; k++) {
          if (grid[k] === 'S') { start = k; grid[k] = '.'; }
          else if (grid[k] === 'T') treasure = k;
          else if (grid[k] === 'G') gems.push(k);
        }
        pos = start;
        dug[start] = true;
      },

      /** 検証用: ソルバの最短手順を 1 手ずつなぞる。 */
      solve() {
        route = solveRoute();
        routeAt = 0;
        routeWait = 0;
        if (!route) api.lose('このステージは解けない (定義ミス)');
      },

      update(dt) {
        anim += dt;
        if (bump) { bump.t -= dt; if (bump.t <= 0) bump = null; }
        if (route && !over) {
          routeWait -= dt;
          if (routeWait <= 0) {
            routeWait = 0.06;
            if (routeAt < route.length) step(route[routeAt++]);
          }
        }
      },

      pointer(x, y, ph) {
        if (ph !== 'down' || over) return;
        const c = Math.floor((x - OX) / CELL);
        const r = Math.floor((y - OY) / CELL);
        if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return;
        step(idx(c, r));
      },

      draw(ctx) {
        // 空と地面
        const sky = ctx.createLinearGradient(0, 0, 0, OY);
        sky.addColorStop(0, '#2b4a6b');
        sky.addColorStop(1, '#6b4a2b');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, W, OY);
        ctx.fillStyle = '#241608';
        ctx.fillRect(0, OY, W, H - OY);

        for (let i = 0; i < grid.length; i++) {
          const x = cellX(i);
          const y = cellY(i);
          const t = grid[i];
          const open = dug[i];

          if (t === '#') {
            ctx.fillStyle = '#4a4a52';
            ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
            ctx.fillStyle = '#3a3a42';
            ctx.fillRect(x + 6, y + 8, CELL - 14, CELL - 18);
          } else if (open) {
            ctx.fillStyle = '#150d05';
            ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
          } else {
            ctx.fillStyle = t === 'L' ? '#7a2408' : '#7a4c22';
            ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
            ctx.fillStyle = t === 'L' ? '#8d2c0a' : '#6a4019';
            for (let k = 0; k < 3; k++) {
              ctx.fillRect(x + 5 + ((i * 7 + k * 13) % 24), y + 6 + ((i * 11 + k * 9) % 26), 4, 3);
            }
          }

          // 溶岩は掘る前から少し透けて見せる（理不尽にしないため）
          if (t === 'L') {
            const g = 0.55 + 0.25 * Math.sin(anim * 3 + i);
            ctx.fillStyle = `rgba(255,110,30,${open ? 0.95 : g})`;
            ctx.fillRect(x + 4, y + 4, CELL - 8, CELL - 8);
            ctx.fillStyle = `rgba(255,210,120,${open ? 0.9 : 0.5})`;
            ctx.fillRect(x + 11, y + 11, CELL - 22, CELL - 22);
          }
          if (t === 'G') {
            ctx.fillStyle = '#7fe8ff';
            ctx.beginPath();
            ctx.moveTo(x + CELL / 2, y + 9);
            ctx.lineTo(x + CELL - 10, y + CELL / 2);
            ctx.lineTo(x + CELL / 2, y + CELL - 9);
            ctx.lineTo(x + 10, y + CELL / 2);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,.65)';
            ctx.beginPath();
            ctx.moveTo(x + CELL / 2, y + 11);
            ctx.lineTo(x + CELL / 2 + 6, y + CELL / 2 - 3);
            ctx.lineTo(x + CELL / 2, y + CELL / 2);
            ctx.closePath();
            ctx.fill();
          }
          if (i === treasure) {
            ctx.fillStyle = '#b06a1e';
            ctx.fillRect(x + 7, y + 15, CELL - 14, CELL - 22);
            ctx.fillStyle = '#e0a83a';
            ctx.fillRect(x + 7, y + 15, CELL - 14, 5);
            ctx.fillRect(x + CELL / 2 - 2, y + 20, 4, 6);
          }
        }

        // 掘れないマスを叩いたときの合図
        if (bump) {
          ctx.strokeStyle = `rgba(255,90,74,${bump.t / 0.35})`;
          ctx.lineWidth = 3;
          ctx.strokeRect(cellX(bump.i) + 2, cellY(bump.i) + 2, CELL - 4, CELL - 4);
        }

        // 掘り進める先を光らせる
        if (!over) {
          for (const n of neighbors(pos)) {
            if (grid[n] === '#') continue;
            ctx.strokeStyle = `rgba(255,231,168,${0.25 + 0.2 * Math.sin(anim * 4)})`;
            ctx.lineWidth = 2;
            ctx.strokeRect(cellX(n) + 3, cellY(n) + 3, CELL - 6, CELL - 6);
          }
        }

        // 掘っている人
        const px = cellX(pos) + CELL / 2;
        const py = cellY(pos) + CELL / 2;
        ctx.fillStyle = '#ffd15c';
        ctx.beginPath();
        ctx.arc(px, py - 7, 8, Math.PI, 0);
        ctx.fill();
        ctx.fillStyle = '#3f6fd8';
        ctx.fillRect(px - 7, py - 7, 14, 13);
        ctx.fillStyle = '#f3c9a0';
        ctx.beginPath();
        ctx.arc(px, py - 8, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1b2233';
        ctx.beginPath(); ctx.arc(px - 2, py - 8, 1.4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(px + 2, py - 8, 1.4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#c0c6d4';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(px + 6, py + 5);
        ctx.lineTo(px + 13, py - 3 + Math.sin(anim * 9) * 2);
        ctx.stroke();

        // HUD
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.fillRect(0, 0, W, OY);
        ctx.font = '800 15px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = stamina <= 5 ? '#ff8a7a' : '#fff';
        ctx.fillText(`⛏ スタミナ ${stamina}`, 16, 24);
        ctx.fillStyle = '#7fe8ff';
        ctx.textAlign = 'right';
        ctx.fillText(`💎 ${got} / ${gems.length}`, W - 16, 24);

        ctx.fillStyle = 'rgba(0,0,0,.45)';
        ctx.fillRect(16, 40, W - 32, 7);
        ctx.fillStyle = stamina <= 5 ? '#ff5a4a' : '#ffd15c';
        ctx.fillRect(16, 40, (W - 32) * Math.max(0, stamina / st.stamina), 7);
      },
    };

    return game;
  },
};
