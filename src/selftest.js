/**
 * ネットワーク不要の自己テスト。時刻計算・設定読み込みの健全性を確認する。
 *   node src/selftest.js
 */
import assert from 'node:assert';
import { loadConfig, nextJstTimeToEpochMs } from './lib.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// config.json が読めて必須キーが揃っている
check('config.json が読み込める', () => {
  const c = loadConfig();
  for (const k of ['loginUrl', 'departmentUrl', 'targetTimeJst', 'menuTextCandidates',
    'proceedButtonTexts', 'successTexts', 'closedTexts']) {
    assert.ok(c[k] !== undefined, `missing key: ${k}`);
  }
  assert.match(c.targetTimeJst, /^\d{2}:\d{2}:\d{2}$/);
});

// nextJstTimeToEpochMs は必ず未来の時刻を返す
check('目標時刻は常に未来', () => {
  const ms = nextJstTimeToEpochMs('06:00:00');
  assert.ok(ms > Date.now(), '過去の時刻を返した');
  assert.ok(ms - Date.now() <= 24 * 3600 * 1000 + 1000, '24時間より先を返した');
});

// 目標時刻の JST 時刻が 06:00 になっている（TZに依存しない検算）
check('目標時刻のJSTが06:00である', () => {
  const ms = nextJstTimeToEpochMs('06:00:00');
  const jst = new Date(ms + 9 * 3600 * 1000); // UTC表現をJST壁時計に
  assert.strictEqual(jst.getUTCHours(), 6);
  assert.strictEqual(jst.getUTCMinutes(), 0);
  assert.strictEqual(jst.getUTCSeconds(), 0);
});

console.log(`\n${passed} tests passed.`);
