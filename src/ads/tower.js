// 「数字タワー」系の広告ゲーム。
// 自分より小さい数のブロックだけを取り込んで成長し、最上段のボスを倒す。
// 取り込む順番と、×2 などの演算ブロックをいつ使うかが全て。
//
// 広告のためだけに発明されたメカニクスの代表格で、
// 後から有志が「本物」を作った、という経緯まで含めてこの企画に合っている。
//
// ステージ内にビットマスク総当りのソルバを積んであるので、
// 「クリア不能なステージを置いてしまう」事故が起きない。

export const TOWER = {
  meta: {
    id: 'tower',
    title: '数字タワー',
    hook: '順番を間違えると一瞬で負ける',
    icon: '🔢',
    reality: '実際は…城を建てる放置ゲーム',
    stages: 4,
    tint: '#3b5bab',
  },

  create(api) {
    const { W, H, sfx } = api;

    // 盤面は 3 列 x 5 行。'.' は空白。
    // 数値だけ = 取り込むブロック（自分の方が大きければ加算）
    // 'x2' 'd2' 'p30' 'm20' = 演算ブロック（無条件で取れる）
    // 'B' 始まり = ボス（倒したら勝ち）
    const STAGES = [
      {
        hint: '小さいものから取り込んでいけ。',
        start: 6,
        cells: [
          '.', 'B40', '.',
          '12', 'x2', '10',
          '.', '8', '.',
          '5', '.', '7',
          '.', '3', '.',
        ],
      },
      {
        hint: '×2 をいつ使うかで届く高さが変わる。',
        start: 5,
        cells: [
          '.', 'B90', '.',
          '20', 'x2', '25',
          '14', '.', '18',
          '.', 'x2', '.',
          '4', '6', '9',
        ],
      },
      {
        hint: '−15 のブロックは、踏まずに登る道がある。',
        start: 8,
        cells: [
          '.', 'B140', '.',
          '30', 'x2', '35',
          'm15', '.', '22',
          '16', 'p30', '12',
          '5', '.', '7',
        ],
      },
      {
        hint: '÷2 は罠。使わずに済むルートを探せ。',
        start: 8,
        cells: [
          '.', 'B260', '.',
          '60', 'x2', '70',
          'd2', '.', '45',
          '24', 'x2', '28',
          '6', 'm10', '9',
        ],
      },
    ];

    const COLS = 3;
    const ROWS = 5;
    const BW = 96;
    const BH = 62;
    const GAP = 8;
    const OX = (W - (COLS * BW + (COLS - 1) * GAP)) / 2;
    const OY = 40;

    // --- 状態はすべてここに閉じ込める ---
    let st = STAGES[0];
    let cells = [];
    let cleared = [];
    let value = 0;
    let over = false;
    let anim = 0;
    let pop = null; // 取り込んだ瞬間の演出
    let shake = 0;
    let route = null; // solve() 用の手順
    let routeAt = 0;
    let routeWait = 0;

    const blockX = (i) => OX + (i % COLS) * (BW + GAP);
    const blockY = (i) => OY + ((i / COLS) | 0) * (BH + GAP);

    /** ブロックの中身を解釈する。 */
    function parse(s) {
      if (s === '.') return null;
      if (s[0] === 'B') return { kind: 'boss', val: +s.slice(1) };
      if (s === 'x2') return { kind: 'op', op: 'x2', label: '×2' };
      if (s === 'd2') return { kind: 'op', op: 'd2', label: '÷2' };
      if (s[0] === 'p') return { kind: 'op', op: 'add', amount: +s.slice(1), label: `+${s.slice(1)}` };
      if (s[0] === 'm') return { kind: 'op', op: 'sub', amount: +s.slice(1), label: `−${s.slice(1)}` };
      return { kind: 'num', val: +s };
    }

    const nbs = (i) => {
      const c = i % COLS;
      const r = (i / COLS) | 0;
      const o = [];
      if (c > 0) o.push(i - 1);
      if (c < COLS - 1) o.push(i + 1);
      if (r > 0) o.push(i - COLS);
      if (r < ROWS - 1) o.push(i + COLS);
      return o;
    };

    /**
     * 最下段から「空きマス・取り込み済みマス」をたどって到達できる空間。
     * 空きマスを通れるようにしないと、盤面に穴を開けた瞬間に上が孤立して詰む。
     */
    function openSpace(list, done) {
      const open = new Array(list.length).fill(false);
      const stack = [];
      for (let c = 0; c < COLS; c++) {
        const i = (ROWS - 1) * COLS + c;
        if (!list[i] || done[i]) { open[i] = true; stack.push(i); }
      }
      while (stack.length) {
        for (const n of nbs(stack.pop())) {
          if (open[n] || (list[n] && !done[n])) continue;
          open[n] = true;
          stack.push(n);
        }
      }
      return open;
    }

    /** 最下段のブロック、または開いた空間に面しているブロックには手が届く。 */
    function reachableIn(open, list, done, i) {
      if (!list[i] || done[i]) return false;
      if (i >= (ROWS - 1) * COLS) return true;
      return nbs(i).some((n) => open[n]);
    }

    /** その手を打てるか。数値ブロックは自分の方が大きい必要がある。 */
    function canTakeIn(open, list, done, v, i) {
      if (!reachableIn(open, list, done, i)) return false;
      return list[i].kind === 'op' || v > list[i].val;
    }

    function applied(v, b) {
      if (b.kind === 'num' || b.kind === 'boss') return v + b.val;
      if (b.op === 'x2') return v * 2;
      if (b.op === 'd2') return Math.floor(v / 2);
      if (b.op === 'add') return v + b.amount;
      return Math.max(1, v - b.amount);
    }

    /**
     * 取り込む順番を総当りで探す（クリア済みの集合をビットマスクにして深さ優先＋メモ化）。
     * ブロックは最大 15 個なので状態数は高々 32768。
     */
    function solveOrder() {
      const n = cells.length;
      const seen = new Set();
      const path = [];

      // 演算ブロックがあるため、同じ盤面でも順番次第で戦力が変わる。
      // メモは (盤面, 戦力) の組で取らないと、正しい手順を刈ってしまう。
      const dfs = (done, v) => {
        const mask = done.reduce((m, d, i) => (d ? m | (1 << i) : m), 0);
        const key = `${mask}:${v}`;
        if (seen.has(key)) return false;
        seen.add(key);
        const open = openSpace(cells, done);
        for (let i = 0; i < n; i++) {
          const b = cells[i];
          if (!b || done[i]) continue;
          if (b.kind === 'boss') {
            if (reachableIn(open, cells, done, i) && v > b.val) { path.push(i); return true; }
            continue;
          }
          if (!canTakeIn(open, cells, done, v, i)) continue;
          done[i] = true;
          path.push(i);
          if (dfs(done, applied(v, b))) return true;
          path.pop();
          done[i] = false;
        }
        return false;
      };

      return dfs(new Array(n).fill(false), st.start) ? [...path] : null;
    }

    function take(i) {
      if (over || !cells[i] || cleared[i]) return;
      const b = cells[i];
      if (!reachableIn(openSpace(cells, cleared), cells, cleared, i)) return;

      if (b.kind !== 'op' && value <= b.val) {
        over = true;
        shake = 10;
        sfx.fail();
        api.lose(`${b.val} には ${value} では勝てない`);
        return;
      }

      const before = value;
      value = applied(value, b);
      cleared[i] = true;
      pop = { i, t: 0.45, delta: value - before };
      sfx.merge();

      if (b.kind === 'boss') {
        over = true;
        api.win();
      }
    }

    const game = {
      hint: STAGES[0].hint,

      start(i) {
        st = STAGES[i % STAGES.length];
        game.hint = st.hint;
        cells = st.cells.map(parse);
        cleared = new Array(cells.length).fill(false);
        value = st.start;
        over = false;
        anim = 0;
        pop = null;
        shake = 0;
        route = null;
        routeAt = 0;
        routeWait = 0;
      },

      /** 検証用: ソルバの手順を 1 手ずつなぞる。 */
      solve() {
        route = solveOrder();
        routeAt = 0;
        routeWait = 0;
        if (!route) api.lose('このステージは解けない (定義ミス)');
      },

      update(dt) {
        anim += dt;
        if (pop) { pop.t -= dt; if (pop.t <= 0) pop = null; }
        if (shake > 0) shake -= dt * 30;
        if (route && !over) {
          routeWait -= dt;
          if (routeWait <= 0) {
            routeWait = 0.18;
            if (routeAt < route.length) take(route[routeAt++]);
          }
        }
      },

      pointer(x, y, ph) {
        if (ph !== 'down' || over) return;
        for (let i = 0; i < cells.length; i++) {
          if (!cells[i] || cleared[i]) continue;
          const bx = blockX(i);
          const by = blockY(i);
          if (x >= bx && x <= bx + BW && y >= by && y <= by + BH) { take(i); return; }
        }
      },

      draw(ctx) {
        ctx.save();
        if (shake > 0) ctx.translate((api.rnd() - 0.5) * shake, (api.rnd() - 0.5) * shake);

        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#1d2a4d');
        bg.addColorStop(1, '#0c1220');
        ctx.fillStyle = bg;
        ctx.fillRect(-10, -10, W + 20, H + 20);

        const space = openSpace(cells, cleared);
        for (let i = 0; i < cells.length; i++) {
          const b = cells[i];
          if (!b) continue;
          const x = blockX(i);
          const y = blockY(i);

          if (cleared[i]) {
            ctx.strokeStyle = 'rgba(255,255,255,.08)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(x + 2, y + 2, BW - 4, BH - 4);
            ctx.setLineDash([]);
            continue;
          }

          const open = reachableIn(space, cells, cleared, i);
          const beatable = canTakeIn(space, cells, cleared, value, i);
          const fill =
            b.kind === 'boss' ? '#7a1f3d'
              : b.kind === 'op' ? (b.op === 'x2' || b.op === 'add' ? '#1f6f52' : '#6b4a12')
                : beatable ? '#2f4a8a' : '#4a3050';

          ctx.fillStyle = fill;
          ctx.beginPath();
          ctx.roundRect ? ctx.roundRect(x, y, BW, BH, 12) : ctx.rect(x, y, BW, BH);
          ctx.fill();
          ctx.strokeStyle = open
            ? beatable ? `rgba(255,231,168,${0.55 + 0.35 * Math.sin(anim * 5)})` : 'rgba(255,120,120,.6)'
            : 'rgba(255,255,255,.12)';
          ctx.lineWidth = open ? 3 : 1.5;
          ctx.stroke();

          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          if (b.kind === 'boss') {
            ctx.font = '800 11px system-ui, sans-serif';
            ctx.fillStyle = '#ffb3c4';
            ctx.fillText('BOSS', x + BW / 2, y + 15);
            ctx.font = '900 26px system-ui, sans-serif';
            ctx.fillStyle = '#fff';
            ctx.fillText(String(b.val), x + BW / 2, y + 38);
          } else if (b.kind === 'op') {
            ctx.font = '900 26px system-ui, sans-serif';
            ctx.fillStyle = '#fff';
            ctx.fillText(b.label, x + BW / 2, y + BH / 2);
          } else {
            ctx.font = '900 27px system-ui, sans-serif';
            ctx.fillStyle = beatable ? '#fff' : '#ffbcbc';
            ctx.fillText(String(b.val), x + BW / 2, y + BH / 2);
          }

          if (!open) {
            ctx.fillStyle = 'rgba(0,0,0,.45)';
            ctx.beginPath();
            ctx.roundRect ? ctx.roundRect(x, y, BW, BH, 12) : ctx.rect(x, y, BW, BH);
            ctx.fill();
          }
        }

        // 取り込んだ瞬間の増減表示
        if (pop) {
          const a = pop.t / 0.45;
          ctx.globalAlpha = a;
          ctx.font = '900 22px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillStyle = pop.delta >= 0 ? '#8ef5b0' : '#ff8a7a';
          ctx.fillText(
            `${pop.delta >= 0 ? '+' : ''}${pop.delta}`,
            blockX(pop.i) + BW / 2,
            blockY(pop.i) + BH / 2 - (1 - a) * 26
          );
          ctx.globalAlpha = 1;
        }

        // 自軍の数値
        const py = OY + ROWS * (BH + GAP) + 18;
        ctx.fillStyle = 'rgba(0,0,0,.4)';
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(W / 2 - 78, py - 4, 156, 54, 16) : ctx.rect(W / 2 - 78, py - 4, 156, 54);
        ctx.fill();
        ctx.strokeStyle = '#ffd76e';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '800 11px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,.65)';
        ctx.fillText('あなたの戦力', W / 2, py + 10);
        ctx.font = '900 30px system-ui, sans-serif';
        ctx.fillStyle = '#ffe27a';
        ctx.fillText(String(value), W / 2, py + 33);

        ctx.restore();
      },
    };

    return game;
  },
};
