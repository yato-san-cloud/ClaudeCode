/**
 * ネットワーク不要の自己テスト。時刻計算・設定・画面解析ロジックの健全性を確認する。
 *   node src/selftest.js
 */
import assert from 'node:assert';
import {
  loadConfig, nextJstTimeToEpochMs,
  scoreLabelByKeywords, rankProceedLabel, looksLikeReceipt,
} from './lib.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// --- 設定 ---
check('config.json が読み込める', () => {
  const c = loadConfig();
  for (const k of ['loginUrl', 'departmentUrl', 'targetTimeJst', 'menuTextCandidates',
    'proceedButtonTexts', 'successTexts', 'closedTexts']) {
    assert.ok(c[k] !== undefined, `missing key: ${k}`);
  }
  assert.match(c.targetTimeJst, /^\d{2}:\d{2}:\d{2}$/);
});

// --- 時刻計算 ---
check('目標時刻は常に未来', () => {
  const ms = nextJstTimeToEpochMs('06:00:00');
  assert.ok(ms > Date.now());
  assert.ok(ms - Date.now() <= 24 * 3600 * 1000 + 1000);
});

check('目標時刻のJSTが06:00である', () => {
  const jst = new Date(nextJstTimeToEpochMs('06:00:00') + 9 * 3600 * 1000);
  assert.strictEqual(jst.getUTCHours(), 6);
  assert.strictEqual(jst.getUTCMinutes(), 0);
  assert.strictEqual(jst.getUTCSeconds(), 0);
});

// --- メニュー一致スコア ---
check('メニュー: 完全一致が最高スコア', () => {
  const kw = ['診察', '一般診察', '診察＋注射'];
  assert.strictEqual(scoreLabelByKeywords('診察', kw), 3);
  assert.ok(scoreLabelByKeywords('診察のみ', kw) >= 1);
  assert.ok(scoreLabelByKeywords('予防接種の予約', kw) === 0);
});

check('メニュー: 空白や大小を無視して一致', () => {
  assert.ok(scoreLabelByKeywords('  診 察 ', ['診察']) >= 2);
});

// --- 前進ボタン選択 ---
check('前進ボタン: 受付するは正、戻る/キャンセルは負', () => {
  const proceed = ['受付する', '予約する', '次へ', '確認', '確定'];
  assert.ok(rankProceedLabel('受付する', proceed) > 0);
  assert.ok(rankProceedLabel('次へ', proceed) > 0);
  assert.ok(rankProceedLabel('戻る', proceed) < 0);
  assert.ok(rankProceedLabel('キャンセル', proceed) < 0);
  assert.ok(rankProceedLabel('ログアウト', proceed) < 0);
  // 「予約をキャンセル」のように前進語を含んでも回避語があれば押さない
  assert.ok(rankProceedLabel('予約をキャンセル', proceed) < 0);
});

// --- 完了判定 ---
check('完了判定: 受付番号・完了メッセージを検出', () => {
  assert.ok(looksLikeReceipt('受付番号: 12 番でお待ちください'));
  assert.ok(looksLikeReceipt('整理番号 3'));
  assert.ok(looksLikeReceipt('受付が完了しました'));
  assert.ok(!looksLikeReceipt('受付時間外です'));
  assert.ok(!looksLikeReceipt('メニューを選択してください'));
});

console.log(`\n${passed} tests passed.`);
