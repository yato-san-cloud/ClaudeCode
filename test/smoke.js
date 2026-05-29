/*
 * test/smoke.js — ブラウザ無しで沼のゲームロジックを検証するスモークテスト。
 *
 *   node test/smoke.js
 *
 * Canvas/DOM に依存しない physics / board / game を読み込み、オート打ちで
 * 一定時間まわして「玉詰まりが起きない」「捕獲・大当たりが発生する」
 * 「整合が取れている」ことを確認する。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// 再現性のため Math.random をシード付き PRNG（mulberry32）に差し替える。
(function seedRandom(seed) {
  let a = seed >>> 0;
  Math.random = function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})(20260529);

// 各モジュールは window 名前空間に自己登録する（IIFE）。
global.window = global;
const root = path.join(__dirname, '..');
for (const f of ['js/physics.js', 'js/audio.js', 'js/board.js', 'js/game.js']) {
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(root, f), 'utf8'));
}
const Numa = global.Numa;

let captures = 0;
let vhits = 0;
const board = new Numa.Board();
const game = new Numa.Game(board, Numa.audio, {
  onStats() {},
  onMessage() {},
  onZawa() {},
  onResult() {},
});
const origCapture = game._capture.bind(game);
game._capture = (b) => {
  captures++;
  origCapture(b);
};
const origHitV = game._hitV.bind(game);
game._hitV = () => {
  vhits++;
  origHitV();
};

game.setAutoFire(true);

const dt = 1 / 60;
let maxBalls = 0;
for (let i = 0; i < 60 * 240; i++) {
  game.update(dt);
  if (game.balls.length > maxBalls) maxBalls = game.balls.length;
}
const s = game.stats();

const checks = [
  ['玉が発射されている', s.launches > 20],
  ['同時玉数が上限以内', maxBalls <= Numa.CONFIG.maxBalls],
  ['玉詰まりが無い（盤面が枯れない）', game.balls.length <= Numa.CONFIG.maxBalls],
  ['ステージ捕獲が発生する', captures > 0],
  ['V入賞数 ≤ 捕獲数（整合）', vhits <= captures],
  ['大当たりが発生する', game.hits > 0],
];

console.log('=== 沼 スモークテスト（240秒相当） ===');
console.log(
  `発射:${s.launches} 捕獲:${captures} V:${vhits} 大当り:${game.hits} 出玉:${s.dejama} 収支:¥${s.balance} 最大同時玉:${maxBalls}`
);
let ok = true;
for (const [name, pass] of checks) {
  console.log((pass ? '  ✓ ' : '  ✗ ') + name);
  if (!pass) ok = false;
}
console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
