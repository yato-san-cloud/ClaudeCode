// 画面遷移とシナリオ。
// 広告 → ストア → インストール → 「実物」 → 返金 → 本物のパズル、の一本道。

import { LEVELS, AD_LEVEL } from './levels.js';
import { PuzzleView, renderThumb } from './puzzle.js';
import { Popups, Interstitial, MergeGame } from './fake.js';
import { sfx } from './sfx.js';

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 画面 ---------- */

let current = 'boot';
function go(name) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === name);
  current = name;
}

let toastTimer = 0;
function toast(text, ms = 2600) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}

/* ---------- 画面いっぱいに拡大縮小 ---------- */

function fit() {
  const s = Math.min(window.innerWidth / 360, window.innerHeight / 640);
  const shell = $('#shell');
  shell.style.transform = `scale(${s})`;
  shell.style.marginBottom = `${(s - 1) * 640}px`;
}
window.addEventListener('resize', fit);

/* ---------- 進行状況の保存 ---------- */

const SAVE_KEY = 'pin-ad-game/cleared';
function loadCleared() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SAVE_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}
function saveCleared(set) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify([...set]));
  } catch {
    /* プライベートモードなどでは黙って諦める */
  }
}
let cleared = loadCleared();

/* ---------- 描画ループ ---------- */

const adView = new PuzzleView($('#adcanvas'));
const realView = new PuzzleView($('#realcanvas'));
let realLevel = null;
let realResolved = false;

function loop() {
  if (current === 'ad') {
    adView.update();
    adView.draw();
  } else if (current === 'real' && realLevel) {
    realView.update();
    realView.draw();
    updateGoal();
    if (!realResolved && realView.state !== 'play') {
      realResolved = true;
      finishRealLevel(realView.state === 'won');
    }
  }
  requestAnimationFrame(loop);
}

/* ---------- 広告 ---------- */

const shoutTop = $('#shout-top');
const shoutMid = $('#shout-mid');

function shout(el, html, cls = '') {
  el.className = `shout ${el === shoutTop ? 'top' : 'mid'} ${cls} on`;
  el.innerHTML = html;
}
function unshout(el) {
  el.classList.remove('on');
}

/** 偽の指をキャンバス上の座標へ動かす。 */
function fingerTo(px, py) {
  const c = $('#adcanvas');
  const k = c.clientWidth / c.width;
  const f = $('#finger');
  f.style.left = `${c.offsetLeft + px * k - 6}px`;
  f.style.top = `${c.offsetTop + py * k - 4}px`;
  f.classList.add('on');
}
function fingerTap() {
  const f = $('#finger');
  f.classList.remove('tap');
  void f.offsetWidth;
  f.classList.add('tap');
}
function fingerOff() {
  $('#finger').classList.remove('on');
}

function pinCenter(view, id) {
  const p = view.sand.pin(id);
  const CELLPX = view.canvas.width / 72;
  return [(p.x + p.w / 2) * CELLPX, (p.y + p.h / 2) * CELLPX];
}

let adPhase = 'demo';
let adDeaths = 0;

/** 広告の自動再生パート。下手なプレイヤーが盛大に失敗してみせる。 */
async function playDemo() {
  adPhase = 'demo';
  adView.interactive = false;
  adView.speed = 1; // デモは半速。溶岩が流れ切る前にピンを抜かせたい
  adView.load(AD_LEVEL);
  fingerOff();
  unshout(shoutTop);
  unshout(shoutMid);

  // 煽り文句と指の動きを重ねる。溶岩は数秒で流れ切ってしまうので、
  // まだ大量に落ちているうちに棚のピンを抜かせないと「大惨事」の絵にならない。
  await sleep(200);
  shout(shoutTop, 'ステージ 1');
  const [px, py] = pinCenter(adView, 2);
  await sleep(300);
  shout(shoutMid, 'ピンを抜いて<br>お宝を届けろ！');
  fingerTo(px, py);
  await sleep(700);
  unshout(shoutMid);
  fingerTap();
  sfx.pull();
  adView.pull(2);
  await sleep(250);
  fingerOff();

  shout(shoutMid, 'あ');
  await sleep(500);
  shout(shoutMid, 'えっ');
  await sleep(600);
  shout(shoutMid, '<span style="color:#ff5a4a">うわああ</span>');
  sfx.fail();
  await sleep(1500);

  unshout(shoutTop);
  shout(shoutMid, '99%の人が<br>ここで失敗します', 'sub');
  await sleep(1900);
  unshout(shoutMid);
  await sleep(300);

  // ここからプレイヤーに操作させる
  adPhase = 'play';
  adDeaths = 0;
  adView.speed = 2;
  adView.load(AD_LEVEL);
  adView.interactive = true;
  shout(shoutTop, 'あなたなら、できる？');
  await sleep(1600);
  unshout(shoutTop);
  watchAd();
}

/** 広告内プレイの勝敗を見張る。 */
function watchAd() {
  const check = setInterval(async () => {
    if (adPhase !== 'play' || current !== 'ad') return clearInterval(check);
    if (adView.state === 'won') {
      clearInterval(check);
      sfx.win();
      shout(shoutMid, '<span style="color:#ffe27a">クリア！</span>');
      await sleep(1300);
      shout(shoutMid, 'ステージは<br><span style="color:#ffe27a">1000以上</span>！', 'sub');
      await sleep(1800);
      unshout(shoutMid);
      pulseInstall();
    } else if (adView.state === 'lost') {
      clearInterval(check);
      adDeaths++;
      sfx.fail();
      if (adDeaths >= 2) {
        shout(shoutMid, '続きは<br>アプリで！', 'sub');
        await sleep(1600);
        unshout(shoutMid);
        pulseInstall();
        return;
      }
      shout(shoutMid, 'おしい！');
      await sleep(1200);
      unshout(shoutMid);
      adView.load(AD_LEVEL);
      adView.interactive = true;
      watchAd();
    }
  }, 200);
}

function pulseInstall() {
  const b = $('#ad-install');
  b.textContent = '▶ 無料でインストール';
  b.style.fontSize = '21px';
}

/** スキップボタン。2 回は逃げ、3 回目でようやく効く（が、行き先は同じ）。 */
function armSkip() {
  const skip = $('#skip');
  skip.classList.remove('show');
  skip.style.top = '32px';
  skip.style.right = '8px';
  let dodges = 0;
  setTimeout(() => skip.classList.add('show'), 5000);
  skip.onclick = () => {
    if (dodges === 0) { skip.style.top = '300px'; dodges++; return; }
    if (dodges === 1) { skip.style.top = '120px'; skip.style.right = '250px'; dodges++; return; }
    toStore();
  };
}

/* ---------- ストア ---------- */

function buildStore() {
  const shots = $('#shots');
  shots.innerHTML = '';
  for (const lv of [LEVELS[0], LEVELS[3], LEVELS[4]]) {
    shots.append(renderThumb(lv, 108, 156));
  }
}

function toStore() {
  buildStore();
  go('store');
  $('#store').scrollTop = 0;
}

/* ---------- インストール ---------- */

async function doInstall() {
  go('install');
  const bar = $('#install-bar');
  const label = $('#install-label');
  bar.style.width = '0%';

  const steps = [
    [8, 120], [23, 90], [41, 80], [58, 70], [72, 90], [83, 140], [87, 400],
    [88, 700], [89, 900], [91, 700], [94, 500], [97, 400], [99, 1400], [99, 1800],
  ];
  for (const [pct, ms] of steps) {
    bar.style.width = `${pct}%`;
    label.textContent = pct >= 99 ? '残り時間を計算しています…' : `ダウンロード中… ${pct}%`;
    await sleep(ms);
  }
  bar.style.width = '100%';
  label.textContent = 'インストールが完了しました';
  sfx.cash();
  $('#install-open').classList.remove('hide');
}

/* ---------- 実物のゲーム ---------- */

const popups = new Popups($('#veil'));
const interstitial = new Interstitial($('#interstitial'));
let merge = null;

function toGame() {
  go('game');
  merge = new MergeGame($('#game'), {
    popups,
    interstitial,
    toast,
    onRefund: doRefund,
  });
  merge.intro();
}

/* ---------- 返金 ---------- */

async function doRefund() {
  $('#veil').classList.remove('on');
  $('#veil').innerHTML = '';
  go('refund');
  const log = $('#refund-log');
  log.innerHTML = '';
  const lines = [
    'リクエストを送信しています…',
    '購入履歴を照合しています…',
    'プレイ時間を確認しています…',
    '広告の内容と実際のゲーム内容を比較しています…',
    '相違を確認しました。',
  ];
  for (const l of lines) {
    const d = document.createElement('div');
    d.className = 'tiny';
    d.style.opacity = '0.85';
    d.textContent = `› ${l}`;
    log.append(d);
    await sleep(750);
  }
  await sleep(400);
  sfx.win();
  $('#refund-done').classList.remove('hide');
}

/* ---------- 本物のパズル ---------- */

function buildLevelGrid() {
  const grid = $('#real-grid');
  grid.innerHTML = '';
  LEVELS.forEach((lv, i) => {
    const open = i === 0 || cleared.has(LEVELS[i - 1].id);
    const b = document.createElement('button');
    b.className = 'levelcard';
    b.disabled = !open;
    b.innerHTML =
      `<div class="no">STAGE ${lv.id}</div>` +
      `<div class="nm">${open ? lv.name : '？？？'}</div>` +
      `<div class="st">${cleared.has(lv.id) ? '★ クリア' : open ? `目標 ${lv.need}` : '🔒 未解放'}</div>`;
    b.onclick = () => startRealLevel(lv);
    grid.append(b);
  });
  const all = LEVELS.every((l) => cleared.has(l.id));
  $('#real-allclear').classList.toggle('hide', !all);
}

function showSelect() {
  realLevel = null;
  buildLevelGrid();
  $('#real-select').classList.remove('hide');
  $('#real-play').classList.add('hide');
  $('#real-title').textContent = 'ステージ選択';
  $('#real-sub').textContent = `${cleared.size} / ${LEVELS.length} クリア`;
  $('#real-back').classList.add('hide');
  go('real');
}

function startRealLevel(level) {
  realLevel = level;
  realResolved = false;
  realView.load(level);
  realView.interactive = true;
  $('#real-select').classList.add('hide');
  $('#real-play').classList.remove('hide');
  $('#real-title').textContent = `${level.id}. ${level.name}`;
  $('#real-sub').textContent = '';
  $('#real-hint').textContent = level.intro;
  $('#real-back').classList.remove('hide');
  $('#real-banner').classList.add('hide');
  $('#real-next').classList.add('hide');
  go('real');
}

function updateGoal() {
  if (!realLevel) return;
  const c = realView.sand.collected;
  $('#real-bar').style.width = `${Math.min(100, (c / realLevel.need) * 100)}%`;
  $('#real-num').textContent = `${c} / ${realLevel.need}`;
}

function finishRealLevel(won) {
  const banner = $('#real-banner');
  banner.classList.remove('hide');
  if (won) {
    sfx.win();
    cleared.add(realLevel.id);
    saveCleared(cleared);
    banner.innerHTML = '<div class="t" style="color:#ffe27a">クリア！</div><div class="s">お宝を届けた</div>';
    $('#real-next').classList.remove('hide');
    $('#real-hint').textContent = '';
  } else {
    sfx.fail();
    const dead = realView.sand.dead;
    banner.innerHTML =
      `<div class="t" style="color:#ff6b6b">${dead ? '溶岩に沈んだ' : '宝が足りない'}</div>` +
      '<div class="s">やり直そう</div>';
    $('#real-hint').textContent = `ヒント：${realLevel.hint}`;
  }
}

/* ---------- 配線 ---------- */

function wire() {
  $('#boot-start').onclick = () => {
    sfx.init();
    go('ad');
    armSkip();
    playDemo();
  };

  $('#mute').onclick = () => {
    sfx.muted = !sfx.muted;
    $('#mute').textContent = sfx.muted ? '🔇' : '🔊';
  };

  $('#ad-install').onclick = toStore;
  $('#store-install').onclick = doInstall;
  $('#install-open').onclick = toGame;
  $('#refund-play').onclick = showSelect;

  $('#real-back').onclick = showSelect;
  $('#real-retry').onclick = () => startRealLevel(realLevel);
  $('#real-next').onclick = () => {
    const i = LEVELS.indexOf(realLevel);
    if (i + 1 < LEVELS.length) startRealLevel(LEVELS[i + 1]);
    else showSelect();
  };
  $('#real-reset').onclick = async () => {
    const a = await popups.show({
      title: '進行状況を消しますか？',
      body: 'クリア済みのステージがすべて未解放に戻ります。',
      buttons: [
        { label: '消す', cls: '', value: 'yes' },
        { label: 'やめる', cls: 'ghost', value: 'no' },
      ],
    });
    if (a !== 'yes') return;
    cleared = new Set();
    saveCleared(cleared);
    buildLevelGrid();
    toast('進行状況を消しました');
  };
}

fit();
wire();
buildLevelGrid();
requestAnimationFrame(loop);
