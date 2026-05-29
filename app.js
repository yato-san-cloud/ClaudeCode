'use strict';

/* ============ 共通ユーティリティ ============ */
const $ = (sel, el = document) => el.querySelector(sel);
const stage = $('#gameStage');

function vibrate(p) {
  if (navigator.vibrate) try { navigator.vibrate(p); } catch (_) {}
}

function hi(key, val) {
  const k = 'himagami_hi_' + key;
  const cur = Number(localStorage.getItem(k) || 0);
  if (val == null) return cur;
  if (val > cur) { localStorage.setItem(k, val); return val; }
  return cur;
}
// 小さいほど良いスコア用（反射神経）
function hiLow(key, val) {
  const k = 'himagami_lo_' + key;
  const cur = Number(localStorage.getItem(k) || 0);
  if (val == null) return cur;
  if (cur === 0 || val < cur) { localStorage.setItem(k, val); return val; }
  return cur;
}

function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('#' + screenId).classList.add('active');
}

function confetti(n = 40) {
  const emojis = ['🎉', '✨', '🎊', '⭐️', '💖', '🔥'];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.textContent = emojis[(Math.random() * emojis.length) | 0];
    c.style.left = Math.random() * 100 + 'vw';
    c.style.animationDuration = (1 + Math.random() * 1.5) + 's';
    c.style.animationDelay = Math.random() * 0.3 + 's';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 3000);
  }
}

/* ============ ナビゲーション ============ */
let cleanup = null;

document.querySelectorAll('.game-card').forEach(card => {
  card.addEventListener('click', () => {
    vibrate(15);
    const game = card.dataset.game;
    stage.innerHTML = '';
    if (cleanup) { cleanup(); cleanup = null; }
    show('game');
    GAMES[game]();
  });
});

$('#backBtn').addEventListener('click', () => {
  vibrate(10);
  if (cleanup) { cleanup(); cleanup = null; }
  stage.innerHTML = '';
  show('home');
});

/* ============ ゲーム本体 ============ */
const GAMES = {};

/* --- 反射神経テスト --- */
GAMES.reaction = function () {
  const best = hiLow('reaction');
  stage.innerHTML = `
    <h2 class="g-title">⚡️ 反射神経テスト</h2>
    <p class="g-sub" id="rInfo">赤い画面が緑になった瞬間にタップ！</p>
    <div class="reaction-zone rz-idle" id="rZone">タップしてスタート</div>
    <p class="g-score">自己ベスト: <span class="hi">${best ? best + 'ms' : '—'}</span></p>
  `;
  const zone = $('#rZone'), info = $('#rInfo');
  let state = 'idle', startTime = 0, timer = null;

  function reset() {
    state = 'idle';
    zone.className = 'reaction-zone rz-idle';
    zone.textContent = 'タップしてスタート';
    info.textContent = '赤い画面が緑になった瞬間にタップ！';
  }
  function arm() {
    state = 'wait';
    zone.className = 'reaction-zone rz-wait';
    zone.textContent = '緑になるまで待て…';
    info.textContent = '早押し厳禁！';
    timer = setTimeout(() => {
      state = 'go';
      zone.className = 'reaction-zone rz-go';
      zone.textContent = '今だ！タップ！';
      startTime = performance.now();
    }, 1200 + Math.random() * 2800);
  }
  function tap() {
    if (state === 'idle') { arm(); return; }
    if (state === 'wait') {
      clearTimeout(timer);
      state = 'early';
      zone.className = 'reaction-zone rz-early';
      zone.textContent = 'お手つき！😅 タップでリトライ';
      vibrate([60, 40, 60]);
      state = 'idle';
      return;
    }
    if (state === 'go') {
      const ms = Math.round(performance.now() - startTime);
      const b = hiLow('reaction', ms);
      vibrate(30);
      zone.className = 'reaction-zone rz-idle';
      zone.textContent = `${ms}ms！`;
      info.innerHTML = ms === b
        ? `🎉 自己ベスト更新！`
        : `自己ベスト: ${b}ms — タップで再挑戦`;
      if (ms === b) confetti(25);
      $('.hi').textContent = b + 'ms';
      state = 'idle';
    }
  }
  zone.addEventListener('click', tap);
  cleanup = () => clearTimeout(timer);
};

/* --- 連打スピード --- */
GAMES.tap = function () {
  const DURATION = 5;
  const best = hi('tap');
  stage.innerHTML = `
    <h2 class="g-title">🔥 連打スピード</h2>
    <p class="g-sub" id="tInfo">${DURATION}秒間で何回タップできる？</p>
    <div class="g-big" id="tCount">0</div>
    <button class="tap-btn" id="tBtn">TAP!</button>
    <p class="g-score">最高記録: <span class="hi">${best || '—'}</span> 回</p>
  `;
  const btn = $('#tBtn'), countEl = $('#tCount'), info = $('#tInfo');
  let count = 0, started = false, timer = null;

  btn.addEventListener('click', () => {
    if (!started) {
      started = true;
      count = 0;
      let left = DURATION;
      info.textContent = `残り ${left}.0 秒`;
      const t0 = performance.now();
      timer = setInterval(() => {
        const el = (performance.now() - t0) / 1000;
        left = Math.max(0, DURATION - el);
        info.textContent = `残り ${left.toFixed(1)} 秒`;
        if (left <= 0) finish();
      }, 50);
    }
    count++;
    countEl.textContent = count;
    vibrate(8);
  });

  function finish() {
    clearInterval(timer);
    btn.disabled = true;
    const b = hi('tap', count);
    const fresh = count >= b && count > 0;
    info.innerHTML = fresh ? `🎉 新記録！${count}回（${(count / DURATION).toFixed(1)}回/秒）` : `結果: ${count}回`;
    $('.hi').textContent = b;
    if (fresh) { confetti(30); vibrate([40, 30, 80]); }
    const retry = document.createElement('button');
    retry.className = 'btn ghost';
    retry.textContent = 'もう一回';
    retry.style.marginTop = '.5rem';
    retry.onclick = () => GAMES.tap();
    stage.appendChild(retry);
  }
  cleanup = () => clearInterval(timer);
};

/* --- 運命のガチャ --- */
GAMES.gacha = function () {
  const ranks = [
    { r: 'SSS', msg: '伝説の引き！今日は無敵だ🔥', p: 1,  c1: '#ffd700', c2: '#ff8a00', t: '#3a2400' },
    { r: 'SS',  msg: '超ラッキー！宝くじ買え💰',   p: 4,  c1: '#e052ff', c2: '#7b2ff7', t: '#fff' },
    { r: 'S',   msg: 'かなり good！いい日になる✨', p: 12, c1: '#00c9a7', c2: '#00b4d8', t: '#04261f' },
    { r: 'A',   msg: 'まずまず。普通に頑張ろう👍',  p: 23, c1: '#3a86ff', c2: '#4361ee', t: '#fff' },
    { r: 'B',   msg: 'まあこんな日もある😌',        p: 30, c1: '#6c757d', c2: '#495057', t: '#fff' },
    { r: 'C',   msg: '今日は大人しくしとこ…🫠',     p: 22, c1: '#8d99ae', c2: '#5c677d', t: '#fff' },
    { r: 'Z',   msg: '逆にレア！？事故レベル💀',     p: 8,  c1: '#2b2d42', c2: '#000', t: '#ff4d6d' },
  ];
  const pulls = hi('gacha_pulls');
  stage.innerHTML = `
    <h2 class="g-title">🎰 運命のガチャ</h2>
    <p class="g-sub">ボタンを引いて今日のレア度を占おう</p>
    <div id="gResult"></div>
    <button class="btn" id="gPull">ガチャを引く！</button>
    <p class="g-score">これまで <span class="hi">${pulls}</span> 回引いた</p>
  `;
  const result = $('#gResult'), pull = $('#gPull');

  pull.addEventListener('click', () => {
    vibrate([15, 25, 15]);
    const total = ranks.reduce((s, r) => s + r.p, 0);
    let roll = Math.random() * total, pick = ranks[ranks.length - 1];
    for (const r of ranks) { if (roll < r.p) { pick = r; break; } roll -= r.p; }

    const n = hi('gacha_pulls') + 1;
    localStorage.setItem('himagami_hi_gacha_pulls', n);
    $('.hi').textContent = n;

    result.innerHTML = `
      <div class="gacha-card" style="background:linear-gradient(140deg,${pick.c1},${pick.c2});color:${pick.t}">
        <div class="rarity-label">RARITY</div>
        <div class="gacha-rank">${pick.r}</div>
        <div class="gacha-msg">${pick.msg}</div>
      </div>`;
    pull.textContent = 'もう一回引く';
    if (['SSS', 'SS', 'S'].includes(pick.r)) { confetti(pick.r === 'SSS' ? 60 : 35); vibrate([30, 20, 60]); }
  });
};

/* --- 叫びメーター --- */
GAMES.scream = function () {
  const best = hi('scream');
  stage.innerHTML = `
    <h2 class="g-title">📢 叫びメーター</h2>
    <p class="g-sub" id="sInfo">マイクに向かって叫べ！最大音量を記録</p>
    <div style="display:flex;align-items:flex-end;gap:1.2rem">
      <div class="meter"><div class="meter-fill" id="sFill"></div></div>
      <div>
        <div class="g-big" id="sVal">0</div>
        <div class="g-score">最高: <span class="hi">${best}</span></div>
      </div>
    </div>
    <button class="btn" id="sStart">マイクを許可して開始</button>
  `;
  const fill = $('#sFill'), val = $('#sVal'), info = $('#sInfo'), startBtn = $('#sStart');
  let ctx, analyser, raf, stream, peak = 0;

  startBtn.addEventListener('click', async () => {
    if (ctx) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      info.textContent = '今だ！思いっきり叫べ〜！🗣️';
      startBtn.textContent = '計測中…（タップで終了）';
      startBtn.onclick = stop;

      const loop = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / data.length);
        const level = Math.min(100, Math.round(rms * 280));
        fill.style.height = level + '%';
        val.textContent = level;
        if (level > peak) {
          peak = level;
          const b = hi('scream', peak);
          $('.hi').textContent = b;
          if (peak >= 90) { fill.parentElement.classList.add('flash'); vibrate(20); }
        }
        raf = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) {
      info.textContent = '⚠️ マイクが使えませんでした。設定で許可してね。';
    }
  });

  function stop() {
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (ctx) ctx.close();
    ctx = null;
    const b = hi('scream');
    info.innerHTML = `最大音量 <b>${peak}</b> を記録！（自己ベスト ${b}）`;
    if (peak >= 80) confetti(25);
    startBtn.textContent = 'もう一回';
    startBtn.onclick = () => GAMES.scream();
  }
  cleanup = () => {
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (ctx) try { ctx.close(); } catch (_) {}
  };
};

/* --- シェイクバトル --- */
GAMES.shake = function () {
  const DURATION = 10;
  const best = hi('shake');
  stage.innerHTML = `
    <h2 class="g-title">📱 シェイクバトル</h2>
    <p class="g-sub" id="kInfo">${DURATION}秒間、スマホを全力で振れ！</p>
    <div class="g-big" id="kCount">0</div>
    <button class="btn" id="kStart">スタート</button>
    <p class="g-score">最高記録: <span class="hi">${best}</span> 回</p>
  `;
  const info = $('#kInfo'), countEl = $('#kCount'), startBtn = $('#kStart');
  let count = 0, last = 0, lastDir = 0, handler = null, timer = null;

  function begin() {
    count = 0; countEl.textContent = 0;
    let left = DURATION;
    info.textContent = `残り ${left}.0 秒`;
    const t0 = performance.now();
    timer = setInterval(() => {
      left = Math.max(0, DURATION - (performance.now() - t0) / 1000);
      info.textContent = `残り ${left.toFixed(1)} 秒`;
      if (left <= 0) finish();
    }, 50);

    handler = (e) => {
      const a = e.accelerationIncludingGravity || e.acceleration;
      if (!a) return;
      const mag = Math.abs(a.x || 0) + Math.abs(a.y || 0) + Math.abs(a.z || 0);
      const now = performance.now();
      if (mag > 24 && now - last > 90) {
        count++; last = now;
        countEl.textContent = count;
        vibrate(6);
      }
    };
    window.addEventListener('devicemotion', handler);
  }

  function finish() {
    clearInterval(timer);
    window.removeEventListener('devicemotion', handler);
    const b = hi('shake', count);
    const fresh = count >= b && count > 0;
    info.innerHTML = fresh ? `🎉 新記録！${count}回` : `結果: ${count}回`;
    $('.hi').textContent = b;
    if (fresh) confetti(30);
    startBtn.textContent = 'もう一回';
    startBtn.onclick = () => GAMES.shake();
  }

  startBtn.addEventListener('click', async () => {
    // iOS 13+ は許可が必要
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const res = await DeviceMotionEvent.requestPermission();
        if (res !== 'granted') { info.textContent = '⚠️ モーションセンサーの許可が必要です'; return; }
      } catch (_) {
        info.textContent = '⚠️ センサーが使えませんでした'; return;
      }
    } else if (typeof DeviceMotionEvent === 'undefined') {
      info.textContent = '⚠️ この端末ではモーションセンサーが使えません';
      return;
    }
    startBtn.textContent = '振れ振れ〜！';
    startBtn.disabled = true;
    begin();
  });

  cleanup = () => {
    clearInterval(timer);
    if (handler) window.removeEventListener('devicemotion', handler);
  };
};

/* --- 記憶ヘビ（サイモン風） --- */
GAMES.memory = function () {
  const best = hi('memory');
  const colors = ['#ff4d6d', '#3a86ff', '#06d6a0', '#f9c80e'];
  stage.innerHTML = `
    <h2 class="g-title">🧠 記憶ヘビ</h2>
    <p class="g-sub" id="mInfo">光る順番を覚えて、同じ順にタップ！</p>
    <div class="pad-grid" id="mGrid">
      ${colors.map((c, i) => `<button class="pad" data-i="${i}" style="background:${c};color:${c}"></button>`).join('')}
    </div>
    <button class="btn" id="mStart">スタート</button>
    <p class="g-score">最高レベル: <span class="hi">${best}</span></p>
  `;
  const info = $('#mInfo'), startBtn = $('#mStart');
  const pads = [...stage.querySelectorAll('.pad')];
  let seq = [], input = [], playing = false, timeouts = [];

  function lite(i, dur = 400) {
    return new Promise(res => {
      pads[i].classList.add('lit');
      vibrate(15);
      const t = setTimeout(() => { pads[i].classList.remove('lit'); setTimeout(res, 140); }, dur);
      timeouts.push(t);
    });
  }
  async function playSeq() {
    playing = true;
    info.textContent = `レベル ${seq.length} — よく見て…`;
    await new Promise(r => timeouts.push(setTimeout(r, 500)));
    for (const i of seq) await lite(i);
    playing = false;
    input = [];
    info.textContent = `あなたの番！（${seq.length}個）`;
  }
  function next() {
    seq.push((Math.random() * 4) | 0);
    playSeq();
  }
  function gameOver() {
    const lvl = seq.length - 1;
    const b = hi('memory', lvl);
    info.innerHTML = lvl >= b && lvl > 0 ? `🎉 新記録！レベル ${lvl}` : `ゲームオーバー… レベル ${lvl}`;
    $('.hi').textContent = b;
    vibrate([80, 50, 80]);
    if (lvl >= b && lvl > 0) confetti(25);
    startBtn.textContent = 'もう一回';
    startBtn.disabled = false;
    seq = [];
  }

  pads.forEach(pad => pad.addEventListener('click', async () => {
    if (playing || seq.length === 0) return;
    const i = Number(pad.dataset.i);
    await lite(i, 200);
    input.push(i);
    const idx = input.length - 1;
    if (input[idx] !== seq[idx]) { gameOver(); return; }
    if (input.length === seq.length) {
      info.textContent = '正解！👏';
      setTimeout(next, 600);
    }
  }));

  startBtn.addEventListener('click', () => {
    seq = []; input = [];
    startBtn.disabled = true;
    startBtn.textContent = 'プレイ中…';
    next();
  });

  cleanup = () => { timeouts.forEach(clearTimeout); };
};

/* ============ PWA / Service Worker ============ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
