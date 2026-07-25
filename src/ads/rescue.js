// 「お姫様救出」系の広告ゲーム。
// 迫りくる危機に対して 3 つの道具から 1 つを選ぶ。選択を誤ると悲惨な結末。
//
// ★ このファイルは他の広告ゲームを書くときの手本。
//   トップレベルの宣言は export const RESCUE ただ 1 つ。
//   状態は必ず create() の中に閉じ込める（バンドル後は全部が同じスコープに並ぶため）。

export const RESCUE = {
  meta: {
    id: 'rescue',
    title: 'お姫様救出',
    hook: '99%が失敗する救出パズル',
    icon: '🆘',
    reality: '実際は…お城の内装コーデ',
    stages: 4,
    tint: '#c0392b',
  },

  create(api) {
    const { W, H, sfx } = api;

    // 各ステージ: 危機の種類・道具 3 つ・正解の番号・失敗時の一言
    const STAGES = [
      {
        hint: '溶岩が上がってくる！',
        peril: 'lava',
        items: ['🧊', '🪣', '🪵'],
        right: 0,
        wrong: ['', 'バケツで溶岩はすくえない', '薪をくべてどうする'],
        winLine: '氷で溶岩が固まった！',
      },
      {
        hint: '水槽の水位が上がっている',
        peril: 'water',
        items: ['🐟', '🔌', '🧽'],
        right: 1,
        wrong: ['エサやりをしている場合か', '', 'スポンジで吸い切れる量ではない'],
        winLine: '栓を抜いて排水した！',
      },
      {
        hint: '上から岩が落ちてくる',
        peril: 'rock',
        items: ['☂️', '🛡️', '🎈'],
        right: 1,
        wrong: ['傘で岩は防げない', '', '浮いても岩は落ちてくる'],
        winLine: '盾で受け止めた！',
      },
      {
        hint: '檻ごと溶岩に沈んでいく',
        peril: 'cage',
        items: ['🔑', '🍖', '📢'],
        right: 0,
        wrong: ['', '肉を渡してどうする', '叫んでも誰も来ない'],
        winLine: '鍵を開けて脱出した！',
      },
    ];

    // --- 状態はすべてここに閉じ込める ---
    let st = STAGES[0];
    let level = 0; // 危機の進行度 0..1
    let phase = 'choose'; // choose | resolve | over
    let picked = -1;
    let timer = 0;
    let shake = 0;
    let rocks = [];

    const ITEM_Y = H - 62;
    const ITEM_R = 34;
    const itemX = (i) => W / 2 + (i - 1) * 100;

    const game = {
      hint: STAGES[0].hint,

      start(i) {
        st = STAGES[i % STAGES.length];
        game.hint = st.hint;
        level = 0;
        phase = 'choose';
        picked = -1;
        timer = 0;
        shake = 0;
        rocks = st.peril === 'rock'
          ? [0, 1, 2].map((k) => ({ x: 80 + k * 100, y: -40 - k * 90, r: 16 + k * 3 }))
          : [];
      },

      update(dt) {
        if (phase === 'choose') {
          level += dt * 0.115; // 約 8.7 秒で手遅れ
          if (st.peril === 'rock') {
            for (const r of rocks) {
              r.y += dt * 78;
              if (r.y > H * 0.62) r.y = -40;
            }
          }
          if (level >= 1) {
            phase = 'over';
            api.lose('迷っているうちに手遅れになった');
          }
          return;
        }

        if (phase === 'resolve') {
          timer += dt;
          if (shake > 0) shake -= dt * 26;
          const ok = picked === st.right;
          if (!ok) level = Math.min(1, level + dt * 0.5);
          if (timer > 1.25) {
            phase = 'over';
            if (ok) api.win();
            else api.lose(st.wrong[picked]);
          }
        }
      },

      /** 検証用: 正しい道具を選ぶ。 */
      solve() {
        game.pointer(itemX(st.right), ITEM_Y, 'down');
      },

      pointer(x, y, ph) {
        if (ph !== 'down' || phase !== 'choose') return;
        for (let i = 0; i < 3; i++) {
          const dx = x - itemX(i);
          const dy = y - ITEM_Y;
          if (dx * dx + dy * dy > ITEM_R * ITEM_R) continue;
          picked = i;
          phase = 'resolve';
          timer = 0;
          sfx.tap();
          if (i === st.right) {
            api.say(st.winLine, 1200);
          } else {
            shake = 9;
            sfx.fail();
            api.say('えっ', 900);
          }
          return;
        }
      },

      draw(ctx) {
        ctx.save();
        if (shake > 0) ctx.translate((api.rnd() - 0.5) * shake, (api.rnd() - 0.5) * shake);

        // 背景と岩壁
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#3b2b46');
        bg.addColorStop(1, '#171226');
        ctx.fillStyle = bg;
        ctx.fillRect(-10, -10, W + 20, H + 20);
        ctx.fillStyle = '#241a30';
        ctx.fillRect(-10, -10, 34, H + 20);
        ctx.fillRect(W - 24, -10, 34, H + 20);

        const solved = phase !== 'choose' && picked === st.right;
        const shown = solved ? Math.max(0, level - (timer / 1.25) * level) : level;
        const perilTop = H * 0.72 - shown * (H * 0.40);

        // 吊るされた人
        const swing = Math.sin(Date.now() / 420) * 3;
        const heroY = H * 0.44;
        ctx.strokeStyle = '#8a7a5a';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(W / 2, 0);
        ctx.lineTo(W / 2 + swing, heroY - 34);
        ctx.stroke();

        if (st.peril === 'cage') {
          ctx.strokeStyle = '#9aa3b8';
          ctx.lineWidth = 3;
          ctx.strokeRect(W / 2 - 34 + swing, heroY - 40, 68, 58);
          for (let k = 1; k < 5; k++) {
            ctx.beginPath();
            ctx.moveTo(W / 2 - 34 + swing + k * 13.6, heroY - 40);
            ctx.lineTo(W / 2 - 34 + swing + k * 13.6, heroY + 18);
            ctx.stroke();
          }
        }

        const scared = shown > 0.45 || (phase !== 'choose' && picked !== st.right);
        drawHero(ctx, W / 2 + swing, heroY + 18, solved ? 'happy' : scared ? 'scared' : 'calm');

        // 落石は人の手前を通す
        if (st.peril === 'rock') {
          for (const r of rocks) {
            ctx.fillStyle = '#6b7280';
            ctx.beginPath();
            ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#4b5563';
            ctx.beginPath();
            ctx.arc(r.x - r.r * 0.3, r.y + r.r * 0.25, r.r * 0.45, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // 迫りくる危機
        drawPeril(ctx, st.peril, perilTop, shown);

        // 道具ボタン
        for (let i = 0; i < 3; i++) {
          const cx = itemX(i);
          const on = picked === i;
          const gone = phase !== 'choose' && !on;
          ctx.globalAlpha = gone ? 0.3 : 1;
          ctx.beginPath();
          ctx.arc(cx, ITEM_Y, ITEM_R, 0, Math.PI * 2);
          ctx.fillStyle = on ? '#ffd15c' : 'rgba(255,255,255,.14)';
          ctx.fill();
          ctx.strokeStyle = on ? '#fff3c4' : 'rgba(255,255,255,.5)';
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.font = '30px system-ui, "Noto Color Emoji", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(st.items[i], cx, ITEM_Y + 2);
          ctx.globalAlpha = 1;
        }

        // 残り時間のバー
        if (phase === 'choose') {
          ctx.fillStyle = 'rgba(0,0,0,.4)';
          ctx.fillRect(24, H - 16, W - 48, 6);
          ctx.fillStyle = level > 0.7 ? '#ff5a4a' : '#ffd15c';
          ctx.fillRect(24, H - 16, (W - 48) * (1 - level), 6);
        }
        ctx.restore();
      },
    };

    /** 吊るされている人。 */
    function drawHero(ctx, x, feet, mood) {
      ctx.save();
      ctx.translate(x, feet);
      ctx.fillStyle = '#e8c34a';
      ctx.beginPath();
      ctx.moveTo(-11, 0);
      ctx.lineTo(11, 0);
      ctx.lineTo(7, -22);
      ctx.lineTo(-7, -22);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#f3c9a0';
      ctx.beginPath();
      ctx.arc(0, -31, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#5b3a1f';
      ctx.beginPath();
      ctx.arc(0, -34, 9.5, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#1b2233';
      if (mood === 'scared') {
        ctx.beginPath(); ctx.arc(-3.4, -32, 2.4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(3.4, -32, 2.4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(0, -26, 2.6, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(-3.4, -32, 1.7, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(3.4, -32, 1.7, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#1b2233';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        if (mood === 'happy') ctx.arc(0, -27.5, 3.2, 0.15 * Math.PI, 0.85 * Math.PI);
        else { ctx.moveTo(-2.6, -27); ctx.lineTo(2.6, -27); }
        ctx.stroke();
      }
      ctx.restore();
    }

    /** 下から迫ってくるもの。 */
    function drawPeril(ctx, kind, top, amount) {
      if (kind === 'rock') {
        ctx.fillStyle = '#3a2f26';
        ctx.fillRect(0, H * 0.72, W, H);
        return;
      }
      const hot = kind === 'lava' || kind === 'cage';
      const g = ctx.createLinearGradient(0, top, 0, H);
      if (hot) {
        g.addColorStop(0, '#ffb020');
        g.addColorStop(0.35, '#ff5a1a');
        g.addColorStop(1, '#8a1c06');
      } else {
        g.addColorStop(0, '#7fd4ff');
        g.addColorStop(1, '#0a4a7a');
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, top);
      const t = Date.now() / 260;
      for (let x = 0; x <= W; x += 12) {
        ctx.lineTo(x, top + Math.sin(x / 26 + t) * 4);
      }
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      ctx.fill();

      if (hot) {
        ctx.globalAlpha = 0.35 + 0.2 * Math.sin(Date.now() / 180);
        ctx.fillStyle = '#ffdd7a';
        for (let k = 0; k < 5; k++) {
          const bx = ((k * 79 + Date.now() / 26) % W);
          ctx.beginPath();
          ctx.arc(bx, top + 8 + (k % 3) * 7, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    return game;
  },
};
