/**
 * MEDICALPASS 自動順番予約（おおはしこどもクリニック 三島）
 *
 * 使い方:
 *   npm run book         # 受付開始時刻(既定 06:00 JST)まで待って予約を1件取る
 *   npm run book:dry     # ログイン〜メニュー検出までの動作確認（予約はしない）
 *   npm run preflight    # ログインして画面上の受診者/メニュー候補を洗い出して報告
 *   npm run book -- --daily   # 毎朝くり返し実行（常駐）
 *
 * 確認済みの MEDICALPASS 患者フロー:
 *   1. https://medicalpass.jp/users/login でメール+パスワードでログイン
 *   2. 診療科ページ (departments/2860) へ
 *   3. （家族を複数登録している場合）受診者を選択
 *   4. メニュー「診察 / 注射 / 診察＋注射」から選ぶ
 *   5. 受付内容の確認 → 「受付する」
 *   6. 受付番号（整理券）が発行されて完了
 *
 * 設計方針:
 *  - 自分の予約1件を、開始時刻ちょうどに「人間1人分」の操作として行う
 *  - 失敗時のみ数秒間隔でリトライ（config.retry）。サーバーへの連打はしない
 *  - 画面の文言が多少違っても、キーワード一致で正しいボタンを自力で選ぶ
 *  - 各ステップでスクリーンショット＋HTMLを保存し、結果を Webhook で通知（任意）
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  loadDotEnv, loadConfig, log, sleep, notify, saveShot, ensureDir,
  measureClockOffsetMs, nextJstTimeToEpochMs, launchOptions,
  scoreLabelByKeywords, rankProceedLabel, looksLikeReceipt,
} from './lib.js';

loadDotEnv();
const config = loadConfig(process.env.CONFIG_FILE || 'config.json');
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const PREFLIGHT = argv.includes('--preflight');
const DAILY = argv.includes('--daily');
const NOW = argv.includes('--now'); // 待たずに今すぐ予約（受付中の時 or 動作検証用）
const shots = config.screenshotsDir || 'screenshots';

const email = process.env.MEDICALPASS_EMAIL;
const password = process.env.MEDICALPASS_PASSWORD;
if (!email || !password) {
  console.error('MEDICALPASS_EMAIL / MEDICALPASS_PASSWORD を .env に設定してください。');
  process.exit(1);
}

/** 失敗解析用に HTML を保存 */
async function dumpHtml(page, name) {
  try {
    ensureDir(shots);
    fs.writeFileSync(path.join(shots, `${name}.html`), await page.content());
  } catch { /* noop */ }
}

/** ページ内の押せる要素（テキスト付き）を列挙する */
async function collectActionables(page) {
  return page.evaluate(() => {
    const sel = 'a, button, input[type=submit], input[type=button], [role=button], [onclick]';
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
      if (!visible || !text) continue;
      const key = text + '|' + el.tagName;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: text.slice(0, 120), tag: el.tagName.toLowerCase() });
    }
    return out;
  }).catch(() => []);
}

/** 本文テキスト（判定用） */
async function bodyText(page) {
  return page.locator('body').innerText().catch(() => '');
}

const CLICKABLE = 'a, button, input[type=submit], input[type=button], [role=button], [onclick]';
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * クリック可能な要素だけを対象に、テキスト一致でクリックする。
 * 説明文の<p>などを誤クリックしないよう、getByText は使わない。
 * 完全一致 → 部分一致 → input[value] の順に探す。
 */
async function clickByText(page, text) {
  const candidates = [
    page.locator(CLICKABLE).filter({ hasText: new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`) }),
    page.locator(CLICKABLE).filter({ hasText: text }),
    page.locator(`input[type=submit][value*="${text.replace(/"/g, '')}"], input[type=button][value*="${text.replace(/"/g, '')}"]`),
  ];
  for (const loc of candidates) {
    const el = loc.first();
    if (await el.isVisible().catch(() => false)) {
      await el.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(300);
      return true;
    }
  }
  return false;
}

/** ログインする（既にセッションがあればスキップ） */
async function ensureLoggedIn(page) {
  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
  const pwField = page.locator('input[type=password]').first();
  if (await pwField.isVisible().catch(() => false)) {
    log('ログイン中...');
    await page.locator('input[type=email], input[name*="email" i], input[name*="mail" i]').first().fill(email);
    await pwField.fill(password);
    await saveShot(page, shots, 'login-filled');
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.locator('button[type=submit], input[type=submit], button:has-text("ログイン")').first().click(),
    ]).catch(() => {});
    await page.waitForTimeout(1000);
    if (await page.locator('input[type=password]').first().isVisible().catch(() => false)) {
      await saveShot(page, shots, 'login-failed');
      await dumpHtml(page, 'login-failed');
      throw new Error('ログイン失敗（パスワード欄が残っています）。メール/パスワードを確認してください。');
    }
    log('ログイン成功。');
  } else {
    log('既存セッションを利用（ログイン画面が出ませんでした）。');
  }
  await saveShot(page, shots, 'after-login');
}

/** 家族を複数登録している場合、受診者を選択する */
async function selectPatientIfNeeded(page) {
  const name = config.patientName?.trim();
  if (!name) return;
  if (await clickByText(page, name)) log(`受診者「${name}」を選択。`);
}

/** メニュー候補から最善のものをキーワード一致で選んでクリック */
async function clickBestMenu(page) {
  const items = await collectActionables(page);
  const scored = items
    .map((it) => ({ ...it, score: scoreLabelByKeywords(it.text, config.menuTextCandidates) }))
    .filter((it) => it.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  const best = scored[0];
  log(`メニュー選択: 「${best.text}」(score ${best.score})` +
      (scored.length > 1 ? ` / 他候補: ${scored.slice(1, 4).map((s) => s.text).join(', ')}` : ''));
  if (await clickByText(page, best.text)) return best.text;
  return null;
}

/** 確認画面を、前進ボタンを自力で選びながら進める。受付番号が出たら成功 */
async function advanceWizard(page, attemptNo) {
  let lastFingerprint = '';
  for (let step = 0; step < 8; step++) {
    if (looksLikeReceipt(await bodyText(page), config.successTexts)) return true;
    const items = await collectActionables(page);
    const scored = items
      .map((it) => ({ ...it, score: rankProceedLabel(it.text, config.proceedButtonTexts) }))
      .filter((it) => it.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) break;
    const btn = scored[0];
    log(`  step${step}: 「${btn.text}」(score ${btn.score})`);
    const before = page.url() + '|' + btn.text;
    await clickByText(page, btn.text);
    await saveShot(page, shots, `attempt${attemptNo}-step${step}`);
    // 画面が全く変わらない（URLも押すボタンも同じ）なら空回りとみなして中断
    const after = page.url() + '|' + btn.text;
    if (after === before && after === lastFingerprint) {
      log('  画面が変化しないため中断します。');
      break;
    }
    lastFingerprint = after;
  }
  return looksLikeReceipt(await bodyText(page), config.successTexts);
}

/** 1回分の予約試行。成功時は結果文字列、受付前/失敗時は null */
async function attemptBooking(page, attemptNo) {
  await page.goto(config.departmentUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);

  const bt = await bodyText(page);
  const closed = config.closedTexts.find((t) => bt.includes(t));
  if (closed) {
    log(`試行${attemptNo}: まだ受付前/受付停止（「${closed}」）。`);
    return null;
  }

  await selectPatientIfNeeded(page);

  if (!(await clickBestMenu(page))) {
    log(`試行${attemptNo}: メニュー候補が見つかりません。`);
    await saveShot(page, shots, `attempt${attemptNo}-no-menu`);
    await dumpHtml(page, `attempt${attemptNo}-no-menu`);
    return null;
  }
  await saveShot(page, shots, `attempt${attemptNo}-menu`);

  if (await advanceWizard(page, attemptNo)) {
    await saveShot(page, shots, `attempt${attemptNo}-SUCCESS`);
    const body = (await bodyText(page)).slice(0, 800);
    const m = body.match(/(受付|整理)番号\s*[:：]?\s*\d+/);
    return `${m ? m[0] : '受付完了'}\n---\n${body}`;
  }
  log(`試行${attemptNo}: 完了画面に到達できず。`);
  await saveShot(page, shots, `attempt${attemptNo}-stuck`);
  await dumpHtml(page, `attempt${attemptNo}-stuck`);
  return null;
}

/** ログイン後の画面から、受診者候補とメニュー候補を洗い出して報告する */
async function preflight(page) {
  await page.goto(config.departmentUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(500);
  await saveShot(page, shots, 'preflight-department');
  await dumpHtml(page, 'preflight-department');
  const items = await collectActionables(page);
  log(`診療科ページで見つけた押せる要素 ${items.length} 個:`);
  for (const it of items) {
    const ms = scoreLabelByKeywords(it.text, config.menuTextCandidates);
    log(`   [${it.tag}] ${it.text}${ms > 0 ? `  ← メニュー候補(score ${ms})` : ''}`);
  }
  const bt = await bodyText(page);
  const closed = config.closedTexts.find((t) => bt.includes(t));
  log(closed ? `現在の状態: 受付前/停止（「${closed}」）` : '現在の状態: 受付可能な表示は出ていそうです');
  log('screenshots/preflight-department.{png,html} を保存しました。');
}

/** 1日分の予約処理（本番） */
async function runOnce(browser) {
  const offset = await measureClockOffsetMs();
  const now = () => Date.now() + offset;
  log(`時刻同期: ローカル時計との差 ${offset}ms (NICT基準)`);
  const targetMs = NOW ? now() : nextJstTimeToEpochMs(config.targetTimeJst);
  if (NOW) {
    log('即時モード: 待たずに今すぐ予約を試行します。');
  } else {
    log(`目標時刻(JST) ${config.targetTimeJst} まで あと ${Math.round((targetMs - now()) / 60000)} 分`);
    const wakeMs = targetMs - (config.preOpenLeadMinutes ?? 5) * 60000;
    if (now() < wakeMs) {
      log(`受付 ${config.preOpenLeadMinutes} 分前まで待機...`);
      await sleep(wakeMs - now());
    }
  }

  const context = await browser.newContext({ locale: 'ja-JP' });
  const page = await context.newPage();
  try {
    await ensureLoggedIn(page);
    if (now() < targetMs - 500) await sleep(targetMs - 500 - now());
    log('受付開始。予約を試行します。');

    const { intervalSeconds = 3, maxAttempts = 40 } = config.retry ?? {};
    let result = null;
    for (let i = 1; i <= maxAttempts && !result; i++) {
      result = await attemptBooking(page, i);
      if (!result && i < maxAttempts) await sleep(intervalSeconds * 1000);
    }
    if (result) {
      log('✅ 予約成功!');
      console.log(result);
      await notify(`✅ おおはしこどもクリニック 予約成功\n${result.slice(0, 500)}`);
      return true;
    }
    log('❌ 予約できませんでした。screenshots/ を確認してください。');
    await notify('❌ おおはしこどもクリニック 予約失敗。screenshots/ を確認してください。');
    return false;
  } finally {
    await context.close().catch(() => {});
  }
}

// ---- メイン ----
function withNetworkGuard(fn) {
  return fn().catch((e) => {
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_NAME_NOT_RESOLVED|net::ERR/.test(e.message || '')) {
      log('❌ medicalpass.jp に到達できません（ネットワーク遮断）。');
      log('   手元のPCで実行するか、環境のネットワーク許可に medicalpass.jp を追加してください。');
      process.exit(2);
    }
    throw e;
  });
}

const browser = await chromium.launch(launchOptions(config));
try {
  if (PREFLIGHT || DRY_RUN) {
    const context = await browser.newContext({ locale: 'ja-JP' });
    const page = await context.newPage();
    await withNetworkGuard(() => ensureLoggedIn(page));
    if (PREFLIGHT) await preflight(page);
    else {
      await page.goto(config.departmentUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const menu = await clickBestMenu(page).catch(() => null);
      log(`ドライラン結果: ログインOK / メニュー検出=${menu ?? 'なし'}（ここで停止、予約はしません）`);
    }
  } else if (DAILY) {
    log('常駐モード: 毎朝くり返し予約します（Ctrl+Cで停止）。');
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await withNetworkGuard(() => runOnce(browser));
      log('翌日の受付開始を待ちます...');
      await sleep(60 * 1000); // 目標時刻を過ぎてから次サイクルへ（nextJstが翌日を返す）
    }
  } else {
    const ok = await withNetworkGuard(() => runOnce(browser));
    if (!ok) process.exitCode = 1;
  }
} finally {
  await browser.close();
}
