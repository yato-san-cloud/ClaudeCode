// 画面遷移とシナリオ。
// 広告 → ストア → インストール → 「実物」 → 返金 → 本物のパズル、の一本道。

import { LEVELS, AD_LEVEL } from './levels.js';
import { PuzzleView, renderThumb } from './puzzle.js';
import { MiniHost } from './mini.js';
import { Popups, Interstitial, MergeGame } from './fake.js';
import { sfx } from './sfx.js';
import { DIG } from './ads/dig.js';
import { DRAWLINE } from './ads/drawline.js';
import { GATE } from './ads/gate.js';
import { PARKING } from './ads/parking.js';
import { RESCUE } from './ads/rescue.js';
import { ROPE } from './ads/rope.js';
import { TOWER } from './ads/tower.js';
import { WATER } from './ads/water.js';

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 画面 ---------- */

let current = 'gallery';
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

// ゲーム ID -> クリア済みステージのキー集合。
// ピン抜きはステージ ID (1..5)、ミニゲームはステージ番号 (0 始まり) を入れる。
const SAVE_KEY = 'pin-ad-game/progress';

function loadProgress() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}');
    const out = {};
    for (const k of Object.keys(raw)) out[k] = new Set(raw[k]);
    return out;
  } catch {
    return {};
  }
}
function saveProgress() {
  try {
    const plain = {};
    for (const k of Object.keys(progress)) plain[k] = [...progress[k]];
    localStorage.setItem(SAVE_KEY, JSON.stringify(plain));
  } catch {
    /* プライベートモードなどでは黙って諦める */
  }
}
let progress = loadProgress();
const doneSet = (id) => (progress[id] ??= new Set());
function markDone(id, key) {
  doneSet(id).add(key);
  saveProgress();
}

/* ---------- 描画ループ ---------- */

const adView = new PuzzleView($('#adcanvas'));
const realView = new PuzzleView($('#realcanvas'));
let realLevel = null;
let realResolved = false;

const miniHost = new MiniHost($('#minicanvas'), {
  onWin: (stage) => finishMini(true, stage),
  onLose: (stage, reason) => finishMini(false, stage, reason),
});

function loop(now) {
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
  } else if (current === 'mini') {
    miniHost.frame(now ?? 0);
    // ゲーム側が hint を書き換えることがあるので、プレイ中は毎フレーム拾い直す
    if (miniHost.state === 'play') {
      const h = miniHost.game?.hint ?? '';
      if ($('#mini-hint').textContent !== h) $('#mini-hint').textContent = h;
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

/* ---------- 広告ギャラリー ---------- */

// 広告で見かける定番ジャンルたち。ピン抜きだけは専用の画面を持つので別扱い。
const MINI_GAMES = [RESCUE, GATE, WATER, PARKING, DRAWLINE, ROPE, TOWER, DIG];

const PIN_CARD = {
  id: 'pin',
  title: 'ピン抜きパズル',
  hook: '順番を間違えると勇者が溶岩に沈む',
  icon: '🧩',
  reality: '実際は…タマゴ合体ゲーム',
  tint: '#7a3b1f',
  get stages() { return LEVELS.length; },
};

function galleryEntries() {
  return [
    { kind: 'pin', meta: PIN_CARD },
    ...MINI_GAMES.map((g) => ({ kind: 'mini', entry: g, meta: g.meta })),
  ];
}

function buildGallery() {
  const wrap = $('#gallery-cards');
  wrap.innerHTML = '';
  let done = 0;
  let total = 0;
  for (const e of galleryEntries()) {
    const n = doneSet(e.meta.id).size;
    const all = n >= e.meta.stages;
    done += n;
    total += e.meta.stages;
    const b = document.createElement('button');
    b.className = 'adcard';
    b.style.setProperty('--tint', e.meta.tint);
    b.innerHTML =
      `<span class="ic">${e.meta.icon}</span>` +
      `<span class="tx"><span class="nm">${e.meta.title}</span>` +
      `<div class="hk">${e.meta.hook}</div>` +
      `<div class="rl">${e.meta.reality}</div></span>` +
      `<span class="pg${all ? ' done' : ''}">${all ? '★' : ''}${n}/${e.meta.stages}</span>`;
    b.onclick = () => (e.kind === 'pin' ? showSelect() : startMini(e.entry, firstUncleared(e.entry)));
    wrap.append(b);
  }
  $('#gallery-sub').textContent = `${done} / ${total}`;
  $('#real-allclear').classList.toggle('hide', done < total);
}

/** まだクリアしていない最初のステージ。全部済みなら 0 に戻す。 */
function firstUncleared(entry) {
  const set = doneSet(entry.meta.id);
  for (let i = 0; i < entry.meta.stages; i++) if (!set.has(i)) return i;
  return 0;
}

function showGallery() {
  buildGallery();
  go('gallery');
}

function startMini(entry, stage) {
  miniHost.load(entry, stage);
  $('#mini-title').textContent = entry.meta.title;
  $('#mini-stage').textContent = `${stage + 1} / ${entry.meta.stages}`;
  $('#mini-hint').textContent = miniHost.game.hint ?? '';
  $('#mini-banner').classList.add('hide');
  $('#mini-next').classList.add('hide');
  go('mini');
}

function finishMini(won, stage, reason) {
  const banner = $('#mini-banner');
  banner.classList.remove('hide');
  if (won) {
    markDone(miniHost.entry.meta.id, stage);
    const more = stage + 1 < miniHost.entry.meta.stages;
    banner.innerHTML =
      '<div class="t" style="color:#ffe27a">クリア！</div>' +
      `<div class="s">${more ? '次のステージへ' : 'このジャンルは全部クリア'}</div>`;
    $('#mini-next').classList.toggle('hide', !more);
    $('#mini-hint').textContent = '';
  } else {
    banner.innerHTML =
      '<div class="t" style="color:#ff6b6b">失敗…</div>' +
      `<div class="s">${reason || 'やり直そう'}</div>`;
    $('#mini-hint').textContent = miniHost.game.hint ?? '';
  }
}

/* ---------- 本物のパズル ---------- */

function buildLevelGrid() {
  const grid = $('#real-grid');
  grid.innerHTML = '';
  LEVELS.forEach((lv, i) => {
    const open = i === 0 || doneSet('pin').has(LEVELS[i - 1].id);
    const b = document.createElement('button');
    b.className = 'levelcard';
    b.disabled = !open;
    b.innerHTML =
      `<div class="no">STAGE ${lv.id}</div>` +
      `<div class="nm">${open ? lv.name : '？？？'}</div>` +
      `<div class="st">${doneSet('pin').has(lv.id) ? '★ クリア' : open ? `目標 ${lv.need}` : '🔒 未解放'}</div>`;
    b.onclick = () => startRealLevel(lv);
    grid.append(b);
  });
}

function showSelect() {
  realLevel = null;
  buildLevelGrid();
  $('#real-select').classList.remove('hide');
  $('#real-play').classList.add('hide');
  $('#real-title').textContent = 'ステージ選択';
  $('#real-sub').textContent = `${doneSet('pin').size} / ${LEVELS.length} クリア`;
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
    markDone('pin', realLevel.id);
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

/** 本編（広告 → ストア → インストール → 実物 → 返金）を最初から流す。 */
function startStory() {
  go('ad');
  armSkip();
  playDemo();
}

function wire() {
  // 音声は最初のタップで初期化する（ブラウザが操作前の再生を許さないため）
  document.addEventListener('pointerdown', () => sfx.init(), { once: true });

  $('#story-start').onclick = startStory;

  $('#mute').onclick = () => {
    sfx.muted = !sfx.muted;
    $('#mute').textContent = sfx.muted ? '🔇' : '🔊';
  };

  $('#ad-install').onclick = toStore;
  $('#store-install').onclick = doInstall;
  $('#install-open').onclick = toGame;
  $('#refund-play').onclick = showGallery;

  $('#real-back').onclick = showGallery;
  $('#real-retry').onclick = () => startRealLevel(realLevel);
  $('#real-next').onclick = () => {
    const i = LEVELS.indexOf(realLevel);
    if (i + 1 < LEVELS.length) startRealLevel(LEVELS[i + 1]);
    else showSelect();
  };

  $('#mini-back').onclick = showGallery;
  $('#mini-retry').onclick = () => startMini(miniHost.entry, miniHost.stage);
  $('#mini-next').onclick = () => startMini(miniHost.entry, miniHost.stage + 1);

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
    progress = {};
    saveProgress();
    buildGallery();
    buildLevelGrid();
    toast('進行状況を消しました');
  };
}

fit();
wire();
buildLevelGrid();
buildGallery();
requestAnimationFrame(loop);
