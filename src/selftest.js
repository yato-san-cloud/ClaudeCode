/**
 * ネットワーク不要の自己テスト。時刻計算・設定・画面解析ロジックの健全性を確認する。
 *   node src/selftest.js
 */
import assert from 'node:assert';
import {
  loadConfig, nextJstTimeToEpochMs,
  scoreLabelByKeywords, rankProceedLabel, detectOutcome, extractReceiptNumber,
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

// --- 状態判定 (detectOutcome) ---
const cfg = {
  successTexts: ['受付が完了', '予約が完了'],
  closedTexts: ['受付時間外', '受付を停止', '定員'],
};

check('状態判定: 完了メッセージ＋受付番号 → success', () => {
  const o = detectOutcome('受付が完了しました\n受付番号: 12 番でお待ちください。', cfg);
  assert.strictEqual(o.status, 'success');
  assert.strictEqual(o.number, '12');
});

check('状態判定: 「現在の受付番号」は待ち状況表示なので success にしない', () => {
  assert.strictEqual(detectOutcome('現在の受付番号: 15', cfg).status, 'none');
  assert.strictEqual(detectOutcome('ただいまの呼び出し番号: 5番', cfg).status, 'none');
  assert.strictEqual(detectOutcome('診察中: 受付番号 8 の方', cfg).status, 'none');
});

check('状態判定: 待ち状況の行が混ざっても自分の番号を正しく抽出', () => {
  const text = 'ただいまの呼び出し 受付番号: 5\n受付が完了しました\n受付番号: 12 番でお待ちください。';
  const o = detectOutcome(text, cfg);
  assert.strictEqual(o.status, 'success');
  assert.strictEqual(o.number, '12');
  assert.strictEqual(extractReceiptNumber(text), '12');
});

check('状態判定: 受付済み → already（再試行しない=二重予約防止）', () => {
  assert.strictEqual(detectOutcome('既に受付済みです。受付番号: 12', cfg).status, 'already');
  assert.strictEqual(detectOutcome('本日はすでに予約されています', cfg).status, 'already');
});

check('状態判定: 受付時間外/停止 → closed', () => {
  assert.strictEqual(detectOutcome('受付時間外です', cfg).status, 'closed');
  assert.strictEqual(detectOutcome('定員に達したため受付を停止しました', cfg).status, 'closed');
});

check('状態判定: 通常のメニュー画面 → none', () => {
  assert.strictEqual(detectOutcome('受付内容を選択してください', cfg).status, 'none');
});

// --- 時刻計算（基準時刻を明示して検算） ---
check('目標時刻: 基準時刻を渡すと決定的に計算できる', () => {
  // 2026-07-16 05:00 JST (= 2026-07-15T20:00Z) 基準 → 同日 06:00 JST
  const base = Date.UTC(2026, 6, 15, 20, 0, 0);
  assert.strictEqual(nextJstTimeToEpochMs('06:00:00', base), Date.UTC(2026, 6, 15, 21, 0, 0));
  // 06:30 JST 基準 → 翌日 06:00 JST
  const after = Date.UTC(2026, 6, 15, 21, 30, 0);
  assert.strictEqual(nextJstTimeToEpochMs('06:00:00', after), Date.UTC(2026, 6, 16, 21, 0, 0));
  // "HH:MM" 形式でも動く
  assert.strictEqual(nextJstTimeToEpochMs('06:00', base), Date.UTC(2026, 6, 15, 21, 0, 0));
});

console.log(`\n${passed} tests passed.`);
