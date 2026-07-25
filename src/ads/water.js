// 「水分けパズル」系の広告ゲーム。
// 試験管をタップして選び、もう 1 本タップするとその上の色がまとめて注がれる。
// すべての試験管が「空」か「単色で満杯」になればクリア。
//
// 盤面は毎回ランダムに作るが、そのまま出すと解けない配置が混ざるので、
// 内蔵ソルバ（深さ優先＋既出局面カット）で解けることを確認してから採用する。
// 見つけた手順はそのまま solve() の答えとして使い回す。
//
// 規約どおりトップレベルの宣言は export const WATER ただ 1 つ。
// 状態も関数もすべて create() の中に閉じ込めている。

export const WATER = {
  meta: {
    id: 'water',
    title: '水分けパズル',
    hook: '99%が3問目で詰まる色分け',
    icon: '🧪',
    reality: '実際は…城下町の内装コーデ',
    stages: 4,
    tint: '#2f8ef4',
  },

  create(api) {
    const { W, H, sfx } = api;

    const CAP = 4; // 試験管 1 本に入る層の数

    // 液体の色。b=基本色 / l=光が当たる側 / d=影側。横グラデにして筒っぽく見せる。
    // 色数が少ないステージほど離れた色相だけを使いたいので、この並び順の頭から取る。
    const COLORS = [
      { b: '#ff4d5a', l: '#ff9aa2', d: '#b81b28' }, // 赤
      { b: '#3ddc7f', l: '#96f2bb', d: '#0f9a55' }, // 緑
      { b: '#4d90ff', l: '#a4c6ff', d: '#1550bd' }, // 青
      { b: '#ffe14d', l: '#fff5a8', d: '#bd9c00' }, // 黄
      { b: '#b06bff', l: '#dab6ff', d: '#6f2ec4' }, // 紫
      { b: '#35d6e0', l: '#a2f0f5', d: '#0e909a' }, // 水
      { b: '#ff6fc0', l: '#ffb6e0', d: '#c22b87' }, // 桃
      { b: '#ff9f2e', l: '#ffcd82', d: '#bd6300' }, // 橙
    ];

    // ステージ構成。lo/hi は「採用したい正解手数」の範囲（易しすぎ・長すぎを避ける）。
    const STAGES = [
      {
        tubes: 4, colors: 3, lo: 6, hi: 11,
        hint: '試験管をタップ→もう1本タップで注ぐ',
        fallback: [[1, 2, 0, 1], [0, 0, 0, 1], [2, 1, 2, 2], []],
      },
      {
        tubes: 5, colors: 4, lo: 9, hi: 15,
        hint: '空いている試験管は1本だけ。順番が肝心',
        fallback: [[0, 3, 1, 3], [2, 0, 3, 0], [3, 2, 2, 1], [1, 2, 0, 1], []],
      },
      {
        tubes: 7, colors: 5, lo: 13, hi: 20,
        hint: '同じ色の上か、空の試験管にだけ注げる',
        fallback: [[4, 0, 2, 0], [4, 1, 2, 2], [3, 2, 3, 1], [4, 1, 3, 0], [0, 3, 1, 4], [], []],
      },
      {
        tubes: 9, colors: 7, lo: 18, hi: 30,
        hint: '最終ステージ。迷ったら「もどす」で戻ろう',
        fallback: [[6, 6, 5, 4], [5, 5, 2, 6], [4, 3, 6, 3], [1, 2, 1, 0], [0, 2, 5, 4], [2, 3, 0, 1], [0, 3, 4, 1], [], []],
      },
    ];

    // ---------------- 盤面ロジック（副作用なしの純粋関数） ----------------

    /** 一番上に同じ色が何段続いているか。 */
    const runLen = (t) => {
      if (!t.length) return 0;
      let n = 1;
      for (let i = t.length - 2; i >= 0 && t[i] === t[t.length - 1]; i--) n++;
      return n;
    };

    /** 単色で満杯（＝完成）か。 */
    const tubeDone = (t) => t.length === CAP && runLen(t) === CAP;

    const boardDone = (b) => b.every((t) => t.length === 0 || tubeDone(t));

    /**
     * i から j へ注げるか。本家どおり「注ぎ先が空 or 一番上が同色」＋「空きがある」。
     * 完成済みの試験管からは注げない（崩しても得がないので操作ミスを防ぐ）。
     */
    const canPour = (b, i, j) => {
      if (i === j || i < 0 || j < 0) return false;
      const f = b[i], t = b[j];
      if (!f.length || tubeDone(f)) return false;
      if (t.length >= CAP) return false;
      return t.length === 0 || t[t.length - 1] === f[f.length - 1];
    };

    /** 実際に移る段数（注ぎ先に入りきらない分は残る）。 */
    const pourAmount = (b, i, j) => Math.min(runLen(b[i]), CAP - b[j].length);

    /** ソルバ用の手の列挙。良さそうな手が先に来るよう並べ替える。 */
    const genMoves = (b) => {
      const list = [];
      for (let i = 0; i < b.length; i++) {
        const f = b[i];
        if (!f.length || tubeDone(f)) continue;
        const k = runLen(f);
        for (let j = 0; j < b.length; j++) {
          if (i === j) continue;
          const t = b[j];
          const space = CAP - t.length;
          if (space <= 0) continue;
          if (t.length === 0) {
            if (k === f.length) continue; // 中身が 1 色だけの管を空へ移すのは無意味
          } else if (t[t.length - 1] !== f[f.length - 1]) continue;
          const n = Math.min(k, space);
          let score = 0;
          if (t.length + n === CAP && runLen(t) === t.length) score += 100; // 注ぎ先が完成する
          if (n === k) score += 40; // 一番上をまるごと動かせる
          if (k === f.length) score += 20; // 注ぎ元が空になる
          if (t.length === 0) score -= 25; // 空きを 1 本つぶす
          if (n < k) score -= 30; // 積み残しが出る
          list.push({ i, j, n, score });
        }
      }
      list.sort((a, b2) => b2.score - a.score);
      return list;
    };

    const applyMove = (b, m) => {
      const nb = b.map((t) => t.slice());
      const c = nb[m.i][nb[m.i].length - 1];
      for (let k = 0; k < m.n; k++) { nb[m.i].pop(); nb[m.j].push(c); }
      return nb;
    };

    /** 試験管は入れ替えても同じ盤面なので、並べ替えて正規化した文字列を鍵にする。 */
    const keyOf = (b) => b.map((t) => t.join(',')).sort().join('|');

    /** 解ければ手順の配列、解けなければ null。 */
    const solveBoard = (start) => {
      const seen = new Set();
      const path = [];
      let budget = 120000;
      const rec = (b) => {
        if (budget-- <= 0) return false;
        if (boardDone(b)) return true;
        const k = keyOf(b);
        if (seen.has(k)) return false;
        seen.add(k);
        for (const m of genMoves(b)) {
          path.push(m);
          if (rec(applyMove(b, m))) return true;
          path.pop();
        }
        return false;
      };
      return rec(start.map((t) => t.slice())) ? path : null;
    };

    /** 色を均等に配ってシャッフルするだけの雑な生成。解けるかは別途ソルバで見る。 */
    const shuffled = (nTubes, nColors) => {
      const pool = [];
      for (let c = 0; c < nColors; c++) for (let k = 0; k < CAP; k++) pool.push(c);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(api.rnd() * (i + 1));
        const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
      }
      const b = [];
      for (let i = 0; i < nColors; i++) b.push(pool.slice(i * CAP, i * CAP + CAP));
      while (b.length < nTubes) b.push([]);
      return b;
    };

    /**
     * 「解けることを確認済み」の盤面と、その正解手順を作る。
     * 手数が狙いの範囲に入るものを優先し、どうしても見つからなければ
     * 検証済みの決め打ち盤面に落とす（運任せにしない）。
     */
    const buildStage = (cfg) => {
      let loose = null;
      for (let a = 0; a < 240; a++) {
        const b = shuffled(cfg.tubes, cfg.colors);
        if (boardDone(b)) continue;
        const path = solveBoard(b);
        if (!path) continue;
        if (!loose) loose = { board: b, path };
        if (path.length >= cfg.lo && path.length <= cfg.hi) return { board: b, path };
      }
      if (loose) return loose;
      const fb = cfg.fallback.map((t) => t.slice());
      return { board: fb, path: solveBoard(fb) || [] };
    };

    // ---------------- 見た目の配置 ----------------

    const BAR_Y = 30;    // 上部の情報バーの中心
    const BTN_Y = 474;   // ボタンの中心
    const BTN_W = 132, BTN_H = 44;
    const btnRect = (k) => ({ x: W / 2 + (k === 0 ? -BTN_W - 8 : 8), y: BTN_Y - BTN_H / 2, w: BTN_W, h: BTN_H });

    /** 本数に応じて試験管の大きさと位置を決める。5 本までは 1 段、それ以上は 2 段。 */
    const buildGeo = (n) => {
      const rows = n <= 5 ? 1 : 2;
      const per = Math.ceil(n / rows);
      const availW = W - 36;
      const tw = Math.min(rows === 1 ? 58 : 50, (availW - (per - 1) * 14) / per);
      const gap = per > 1 ? Math.min(34, (availW - per * tw) / (per - 1)) : 0;
      const segH = rows === 1 ? 52 : 34;
      const rim = 10, wall = 3.5;
      const th = CAP * segH + rim + wall;
      const areaTop = 58, areaBot = 444;
      const rowGap = 26;
      const totalH = rows * th + (rows - 1) * rowGap;
      const y0 = areaTop + (areaBot - areaTop - totalH) / 2;
      const slots = [];
      const shelves = [];
      for (let r = 0; r < rows; r++) {
        const cnt = Math.min(per, n - r * per);
        const rowW = cnt * tw + (cnt - 1) * gap;
        const x0 = (W - rowW) / 2;
        const cy = y0 + r * (th + rowGap) + th / 2;
        for (let k = 0; k < cnt; k++) slots.push({ cx: x0 + k * (tw + gap) + tw / 2, cy });
        shelves.push({ x: x0 - 14, y: cy + th / 2 - 3, w: rowW + 28 });
      }
      return { slots, shelves, tw, th, segH, rim, wall, pitch: tw + gap, rows };
    };

    // ---------------- 状態（すべてここに閉じ込める） ----------------

    let cfg = STAGES[0];
    let geo = buildGeo(4);
    let board = [];
    let initial = [];
    let answer = [];
    let history = [];
    let sel = -1;
    let moves = 0;
    let phase = 'play'; // play | cele
    let celeT = 0;
    let anim = null;
    let parts = [];
    let wob = [];
    let bump = [];
    let shake = 0;
    let auto = false;
    let autoIdx = 0;
    let autoWait = 0;
    let time = 0;

    const T_LIFT = 0.22, T_BACK = 0.20;
    const pourDur = (n) => 0.12 + 0.16 * n;

    /** 注ぐときの持ち上げ位置と傾き。画面外へ出ないように内側へ寄せる。 */
    const pourPose = (fi, ti) => {
      const a = geo.slots[fi], b = geo.slots[ti];
      let dir = a.cx <= b.cx ? 1 : -1; // +1: 右へ注ぐ（注ぎ元は左側に立つ）
      if (dir === 1 && b.cx < W * 0.42) dir = -1;
      if (dir === -1 && b.cx > W * 0.58) dir = 1;
      const ang = (geo.rows === 1 ? 0.62 : 0.55) * dir; // 長い管ほど深く傾けて場所を取らせない
      const co = Math.cos(ang), si = Math.sin(ang);
      const lx = dir * geo.tw / 2, ly = -geo.th / 2; // 注ぎ口（傾けた側の上角）
      const hw = Math.abs(geo.tw / 2 * co) + Math.abs(geo.th / 2 * si);
      const hh = Math.abs(geo.tw / 2 * si) + Math.abs(geo.th / 2 * co);
      const wantX = b.cx - dir * 9;
      const wantY = b.cy - geo.th / 2 - 26;
      let cx = wantX - (lx * co - ly * si);
      let cy = wantY - (lx * si + ly * co);
      cx = Math.max(hw + 4, Math.min(W - hw - 4, cx));
      cy = Math.max(hh + 50, Math.min(H - hh - 60, cy));
      return { cx, cy, ang, dir };
    };

    /** 連続する同色をまとめて {c, u} の列にする（u は段数、小数可）。 */
    const runsOf = (arr) => {
      const r = [];
      for (const c of arr) {
        if (r.length && r[r.length - 1].c === c) r[r.length - 1].u += 1;
        else r.push({ c, u: 1 });
      }
      return r;
    };

    const addUnits = (runs, c, u) => {
      if (u <= 0) return runs;
      if (runs.length && runs[runs.length - 1].c === c) runs[runs.length - 1].u += u;
      else runs.push({ c, u });
      return runs;
    };

    const spawn = (x, y, c, n, up) => {
      for (let k = 0; k < n; k++) {
        parts.push({
          x, y, c,
          vx: (Math.random() - 0.5) * 120,
          vy: up ? -60 - Math.random() * 120 : -20 - Math.random() * 60,
          r: 1.6 + Math.random() * 2.4,
          life: 0.45 + Math.random() * 0.4,
          max: 0.9,
        });
      }
    };

    const startPour = (i, j) => {
      const n = pourAmount(board, i, j);
      if (n <= 0) return false;
      const c = board[i][board[i].length - 1];
      history.push({ b: board.map((t) => t.slice()), m: moves });
      if (history.length > 200) history.shift();
      const preF = board[i].slice(), preT = board[j].slice();
      for (let k = 0; k < n; k++) { board[i].pop(); board[j].push(c); }
      moves++;
      sel = -1;
      anim = { fi: i, ti: j, c, n, preF, preT, ph: 'lift', t: 0, pose: pourPose(i, j), wasDone: tubeDone(preT) };
      sfx.pull();
      return true;
    };

    const finishPour = () => {
      const a = anim;
      anim = null;
      bump[a.ti] = 1;
      wob[a.ti] = 1;
      if (!a.wasDone && tubeDone(board[a.ti])) {
        const s = geo.slots[a.ti];
        spawn(s.cx, s.cy - geo.th / 2 + 16, a.c, 16, true);
        sfx.merge();
      }
      if (boardDone(board)) {
        phase = 'cele';
        celeT = 0;
        api.say('ぜんぶそろった！', 1100);
        for (let k = 0; k < geo.slots.length; k++) {
          if (!board[k].length) continue;
          spawn(geo.slots[k].cx, geo.slots[k].cy - geo.th / 2 + 10, board[k][0], 10, true);
        }
      }
    };

    const hitTube = (x, y) => {
      const hw = Math.min(geo.pitch, geo.tw + 26) / 2;
      for (let i = 0; i < geo.slots.length; i++) {
        const s = geo.slots[i];
        if (Math.abs(x - s.cx) <= hw && Math.abs(y - s.cy) <= geo.th / 2 + 12) return i;
      }
      return -1;
    };

    const undo = () => {
      if (!history.length || anim || phase !== 'play') return;
      const h = history.pop();
      board = h.b;
      moves = h.m;
      sel = -1;
      auto = false;
      sfx.popup();
    };

    const reset = () => {
      if (anim || phase !== 'play') return;
      board = initial.map((t) => t.slice());
      history = [];
      moves = 0;
      sel = -1;
      auto = false;
      sfx.popup();
    };

    const game = {
      hint: STAGES[0].hint,

      start(i) {
        cfg = STAGES[i % STAGES.length];
        game.hint = cfg.hint;
        geo = buildGeo(cfg.tubes);
        const made = buildStage(cfg);
        initial = made.board.map((t) => t.slice());
        board = made.board.map((t) => t.slice());
        answer = made.path;
        history = [];
        sel = -1;
        moves = 0;
        phase = 'play';
        celeT = 0;
        anim = null;
        parts = [];
        wob = geo.slots.map(() => 0);
        bump = geo.slots.map(() => 0);
        shake = 0;
        auto = false;
        autoIdx = 0;
        autoWait = 0;
        time = 0;
      },

      update(dt) {
        const spd = auto ? 4.5 : 1; // 自動再生はまとめて早送り
        const d = dt * spd;
        time += dt;
        if (shake > 0) shake = Math.max(0, shake - dt * 34);
        for (let i = 0; i < wob.length; i++) {
          if (wob[i] > 0) wob[i] = Math.max(0, wob[i] - d * 1.6);
          if (bump[i] > 0) bump[i] = Math.max(0, bump[i] - d * 4.5);
        }

        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          p.life -= d;
          if (p.life <= 0) { parts.splice(i, 1); continue; }
          p.vy += 420 * d;
          p.x += p.vx * d;
          p.y += p.vy * d;
        }

        if (anim) {
          anim.t += d;
          if (anim.ph === 'lift' && anim.t >= T_LIFT) { anim.ph = 'pour'; anim.t = 0; }
          else if (anim.ph === 'pour') {
            const dur = pourDur(anim.n);
            const s = geo.slots[anim.ti];
            const lv = anim.preT.length + anim.n * Math.min(1, anim.t / dur);
            if (Math.random() < 0.5) {
              spawn(s.cx + (Math.random() - 0.5) * geo.tw * 0.5,
                s.cy + geo.th / 2 - geo.wall - lv * geo.segH, anim.c, 1, false);
            }
            wob[anim.ti] = 1;
            if (anim.t >= dur) { anim.ph = 'back'; anim.t = 0; }
          } else if (anim.ph === 'back' && anim.t >= T_BACK) {
            finishPour();
          }
        }

        if (phase === 'cele') {
          celeT += d;
          if (celeT > 0.55) { phase = 'done'; api.win(); }
          return;
        }

        // solve() 用の自動再生。1 手ずつ update から流し込む。
        if (auto && !anim && phase === 'play') {
          autoWait -= d;
          if (autoWait <= 0) {
            if (autoIdx < answer.length) {
              const m = answer[autoIdx++];
              if (canPour(board, m.i, m.j)) startPour(m.i, m.j);
              autoWait = 0.06;
            } else {
              auto = false;
            }
          }
        }
      },

      /** 検証用: 初手から正解手順をなぞって自動でクリアする。 */
      solve() {
        board = initial.map((t) => t.slice());
        history = [];
        moves = 0;
        sel = -1;
        anim = null;
        parts = [];
        phase = 'play';
        auto = true;
        autoIdx = 0;
        autoWait = 0;
      },

      pointer(x, y, ph) {
        if (ph !== 'down' || phase !== 'play') return;
        if (anim) return;

        const b0 = btnRect(0), b1 = btnRect(1);
        if (x >= b0.x && x <= b0.x + b0.w && y >= b0.y && y <= b0.y + b0.h) { undo(); return; }
        if (x >= b1.x && x <= b1.x + b1.w && y >= b1.y && y <= b1.y + b1.h) { reset(); return; }

        const i = hitTube(x, y);
        if (i < 0) { sel = -1; return; }

        if (sel < 0) {
          if (!board[i].length || tubeDone(board[i])) { shake = 7; sfx.tap(); return; }
          sel = i;
          bump[i] = 1;
          sfx.tap();
          return;
        }
        if (sel === i) { sel = -1; sfx.tap(); return; }
        if (canPour(board, sel, i)) { auto = false; startPour(sel, i); return; }
        // 注げないときは、中身があればそちらを選び直す
        if (board[i].length && !tubeDone(board[i])) { sel = i; bump[i] = 1; sfx.tap(); }
        else { shake = 7; sfx.tap(); }
      },

      draw(ctx) {
        ctx.save();
        if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

        // 背景（実験室っぽい暗い青）
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#1d2a4d');
        bg.addColorStop(0.55, '#111a33');
        bg.addColorStop(1, '#080c1a');
        ctx.fillStyle = bg;
        ctx.fillRect(-12, -12, W + 24, H + 24);
        const glow = ctx.createRadialGradient(W / 2, 120, 10, W / 2, 120, 250);
        glow.addColorStop(0, 'rgba(90,150,255,.20)');
        glow.addColorStop(1, 'rgba(90,150,255,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, W, H);

        drawBar(ctx);

        // 試験管を置く棚
        for (const sh of geo.shelves) {
          gfx.roundRect(ctx, sh.x, sh.y, sh.w, 9, 4.5, 'rgba(255,255,255,.10)');
          ctx.fillStyle = 'rgba(0,0,0,.22)';
          ctx.fillRect(sh.x + 4, sh.y + 9, sh.w - 8, 4);
        }

        // 液の流れはガラスの奥に回す
        const fr = anim ? pourFrame() : null;
        if (fr && anim.ph === 'pour') drawStream(ctx, fr);

        // 据え置きの試験管
        for (let i = 0; i < geo.slots.length; i++) {
          if (anim && anim.fi === i) continue; // 注いでいる本体は最後に上へ描く
          const s = geo.slots[i];
          let runs;
          if (anim && anim.ti === i) {
            const p = anim.ph === 'lift' ? 0 : anim.ph === 'back' ? 1 : Math.min(1, anim.t / pourDur(anim.n));
            runs = addUnits(runsOf(anim.preT), anim.c, anim.n * p);
          } else {
            runs = runsOf(board[i]);
          }
          const lift = (sel === i ? 12 : 0) + (bump[i] > 0 ? Math.sin(bump[i] * Math.PI) * 4 : 0);
          ctx.save();
          ctx.translate(s.cx, s.cy - lift);
          drawTube(ctx, runs, {
            sel: sel === i,
            target: !!(anim && anim.ti === i),
            done: tubeDone(board[i]) && !(anim && anim.ti === i),
            wob: wob[i],
          });
          ctx.restore();
        }

        // 注いでいる試験管は一番手前
        if (fr) drawPourTube(ctx, fr);

        // しぶき
        for (const p of parts) {
          const c = COLORS[p.c];
          ctx.globalAlpha = Math.min(1, p.life / 0.35);
          ctx.fillStyle = c.l;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        drawButtons(ctx);
        ctx.restore();
      },
    };

    // ---------------- 描画のこまごま ----------------

    /** 試験管の輪郭。上は角丸、底は丸い。 */
    function glassPath(ctx, x, y, w, h) {
      const rb = Math.min(w * 0.46, h * 0.28), rt = 6;
      ctx.beginPath();
      ctx.moveTo(x, y + rt);
      ctx.quadraticCurveTo(x, y, x + rt, y);
      ctx.lineTo(x + w - rt, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + rt);
      ctx.lineTo(x + w, y + h - rb);
      ctx.quadraticCurveTo(x + w, y + h, x + w - rb, y + h);
      ctx.lineTo(x + rb, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - rb);
      ctx.closePath();
    }

    /** 中心を原点として 1 本描く。呼ぶ側で translate / rotate しておくこと。 */
    function drawTube(ctx, runs, o) {
      const { tw, th, segH, rim, wall } = geo;
      const x = -tw / 2, y = -th / 2;

      glassPath(ctx, x, y, tw, th);
      ctx.fillStyle = 'rgba(200,225,255,.10)';
      ctx.fill();

      // 中身
      ctx.save();
      glassPath(ctx, x + wall, y + rim, tw - wall * 2, th - rim - wall);
      ctx.clip();
      const ib = y + th - wall;
      const iw = tw - wall * 2;
      let acc = 0;
      for (const r of runs) {
        if (r.u <= 0.002) continue;
        const c = COLORS[r.c];
        const g = ctx.createLinearGradient(x + wall, 0, x + wall + iw, 0);
        g.addColorStop(0, c.d);
        g.addColorStop(0.3, c.b);
        g.addColorStop(0.62, c.l);
        g.addColorStop(1, c.d);
        ctx.fillStyle = g;
        ctx.fillRect(x + wall, ib - (acc + r.u) * segH, iw, r.u * segH + 0.7);
        acc += r.u;
      }
      // 水面（注いだ直後は波打たせる）
      if (acc > 0.002) {
        const c = COLORS[runs[runs.length - 1].c];
        const sy = ib - acc * segH;
        const amp = (o.wob || 0) * 2.6;
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = c.l;
        ctx.beginPath();
        ctx.moveTo(x + wall, sy + 5);
        for (let px = 0; px <= iw; px += 3) {
          ctx.lineTo(x + wall + px, sy + Math.sin(px / 6 + time * 9) * amp);
        }
        ctx.lineTo(x + wall + iw, sy + 5);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      // ガラスの光沢
      gfx.roundRect(ctx, x + wall + 2.5, y + rim + 6, 3.5, th - rim - wall - 20, 2, 'rgba(255,255,255,.26)');

      // 縁取り。完成した管は金色、選択中は水色に光らせる
      glassPath(ctx, x, y, tw, th);
      if (o.done) {
        ctx.shadowColor = 'rgba(255,214,102,.85)';
        ctx.shadowBlur = 12;
        ctx.strokeStyle = '#ffd666';
        ctx.lineWidth = 3;
      } else if (o.sel || o.target) {
        ctx.shadowColor = 'rgba(120,240,255,.9)';
        ctx.shadowBlur = 12;
        ctx.strokeStyle = '#7ff0ff';
        ctx.lineWidth = 3;
      } else {
        ctx.strokeStyle = 'rgba(225,240,255,.55)';
        ctx.lineWidth = 2.2;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 飲み口
      ctx.beginPath();
      ctx.ellipse(0, y + 2.5, tw / 2 - 1.5, 3.6, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(10,16,32,.55)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(235,245,255,.55)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    /** 注ぎ中の本体＋液の流れ。 */
    function drawPouring(ctx) {
      const { tw, th, segH, wall } = geo;
      const from = geo.slots[anim.fi];
      const to = geo.slots[anim.ti];
      const po = anim.pose;
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

      let k = 1, p = 0;
      if (anim.ph === 'lift') k = ease(Math.min(1, anim.t / T_LIFT));
      else if (anim.ph === 'pour') { k = 1; p = Math.min(1, anim.t / pourDur(anim.n)); }
      else { k = 1 - ease(Math.min(1, anim.t / T_BACK)); p = 1; }

      const cx = from.cx + (po.cx - from.cx) * k;
      const cy = from.cy + (po.cy - from.cy) * k - Math.sin(k * Math.PI) * 16;
      const ang = po.ang * k;

      // 残っている中身（上から n 段ぶんが p に応じて減る）
      const rest = anim.preF.slice(0, anim.preF.length - anim.n);
      const runs = addUnits(runsOf(rest), anim.c, anim.n * (1 - p));

      // 流れは試験管より奥に描くので先に
      if (anim.ph === 'pour') {
        const co = Math.cos(ang), si = Math.sin(ang);
        const lx = po.dir * tw / 2, ly = -th / 2;
        const px = cx + lx * co - ly * si;
        const py = cy + lx * si + ly * co;
        const lv = anim.preT.length + anim.n * p;
        const qx = to.cx;
        const qy = to.cy + th / 2 - wall - lv * segH;
        const c = COLORS[anim.c];
        ctx.save();
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.quadraticCurveTo((px + qx) / 2 + po.dir * 12, py + (qy - py) * 0.18, qx, qy);
        ctx.strokeStyle = c.b;
        ctx.lineWidth = 8;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.quadraticCurveTo((px + qx) / 2 + po.dir * 12, py + (qy - py) * 0.18, qx, qy);
        ctx.strokeStyle = c.l;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.75;
        ctx.stroke();
        ctx.globalAlpha = 1;
        // 着水のきらめき
        ctx.fillStyle = c.l;
        ctx.globalAlpha = 0.55 + 0.35 * Math.sin(time * 26);
        ctx.beginPath();
        ctx.ellipse(qx, qy, 9, 3.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      // 手前に浮いていることが分かるよう、影を落として中身を不透明にする
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.6)';
      ctx.shadowBlur = 18;
      glassPath(ctx, -tw / 2, -th / 2, tw, th);
      ctx.fillStyle = 'rgba(10,15,30,.94)';
      ctx.fill();
      ctx.restore();
      drawTube(ctx, runs, { sel: false, done: false, wob: 0.5 });
      ctx.restore();
    }

    /** 上部の情報バー。 */
    function drawBar(ctx) {
      const done = board.reduce((n, t) => n + (tubeDone(t) ? 1 : 0), 0);
      const need = cfg.colors;
      chip(ctx, 14, BAR_Y - 15, 150, 30, `そろった ${done} / ${need}`, done >= need ? '#ffd666' : '#dce8ff');
      chip(ctx, W - 14 - 118, BAR_Y - 15, 118, 30, `手数 ${moves}`, '#dce8ff');
    }

    function chip(ctx, x, y, w, h, label, color) {
      gfx.roundRect(ctx, x, y, w, h, h / 2, 'rgba(255,255,255,.10)', 'rgba(255,255,255,.18)', 1.5);
      gfx.text(ctx, label, x + w / 2, y + h / 2 + 0.5, { size: 15, weight: 700, color });
    }

    /** 「もどす」「はじめから」。キャンバス内に描いて自前で当たりを取る。 */
    function drawButtons(ctx) {
      const labels = ['もどす', 'はじめから'];
      for (let k = 0; k < 2; k++) {
        const r = btnRect(k);
        const off = k === 0 ? !history.length : moves === 0;
        ctx.globalAlpha = off ? 0.38 : 1;
        gfx.roundRect(ctx, r.x, r.y, r.w, r.h, 13,
          k === 0 ? 'rgba(96,150,255,.30)' : 'rgba(255,255,255,.12)',
          'rgba(255,255,255,.42)', 2);
        gfx.text(ctx, labels[k], r.x + r.w / 2, r.y + r.h / 2 + 1, { size: 18, weight: 800, color: '#fff' });
        ctx.globalAlpha = 1;
      }
    }

    return game;
  },
};
