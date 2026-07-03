/**
 * MEDICALPASS 自動順番予約（おおはしこどもクリニック 三島）
 *
 * 使い方:
 *   npm run book        # 受付開始時刻(既定 06:00 JST)まで待って予約を1件取る
 *   npm run book:dry    # 今すぐログイン〜メニュー画面までの動作確認のみ（予約はしない）
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
 *  - 各ステップでスクリーンショット＋HTMLを保存し、結果を Webhook で通知（任意）
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  loadDotEnv, loadConfig, log, sleep, notify, saveShot, ensureDir,
  measureClockOffsetMs, nextJstTimeToEpochMs, launchOptions,
} from './lib.js';

loadDotEnv();
const config = loadConfig();
const DRY_RUN = process.argv.includes('--dry-run');
const shots = config.screenshotsDir || 'screenshots';

const email = process.env.MEDICALPASS_EMAIL;
const password = process.env.MEDICALPASS_PASSWORD;
if (!email || !password) {
  console.error('MEDICALPASS_EMAIL / MEDICALPASS_PASSWORD を .env に設定してください。');
  process.exit(1);
}

/** ページ内に指定テキスト群のいずれかが表示されているか。見つかればそのテキストを返す */
async function firstVisibleText(page, texts) {
  for (const t of texts) {
    if (await page.getByText(t, { exact: false }).first().isVisible().catch(() => false)) return t;
  }
  return null;
}

/** 失敗解析用に HTML を保存 */
async function dumpHtml(page, name) {
  try {
    ensureDir(shots);
    fs.writeFileSync(path.join(shots, `${name}.html`), await page.content());
  } catch { /* noop */ }
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
  const target = page.getByText(name, { exact: false }).first();
  if (await target.isVisible().catch(() => false)) {
    log(`受診者「${name}」を選択。`);
    await target.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }
}

/** メニュー候補のうち最初に見つかったものをクリック。押せたら true */
async function clickMenu(page) {
  for (const label of config.menuTextCandidates) {
    const el = page.getByRole('button', { name: label })
      .or(page.getByRole('link', { name: label }))
      .or(page.getByText(label, { exact: false }))
      .first();
    if (await el.isVisible().catch(() => false)) {
      log(`メニュー「${label}」をクリック。`);
      await el.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return label;
    }
  }
  return null;
}

/** 1回分の予約試行。成功時は結果文字列、受付前/失敗時は null */
async function attemptBooking(page, attemptNo) {
  await page.goto(config.departmentUrl, { waitUntil: 'domcontentloaded' });

  const closed = await firstVisibleText(page, config.closedTexts);
  if (closed) {
    log(`試行${attemptNo}: まだ受付前/受付停止（「${closed}」）。`);
    return null;
  }

  await selectPatientIfNeeded(page);

  if (!(await clickMenu(page))) {
    log(`試行${attemptNo}: メニューが見つかりません（受付開始直前 or ラベル要調整）。`);
    await saveShot(page, shots, `attempt${attemptNo}-no-menu`);
    await dumpHtml(page, `attempt${attemptNo}-no-menu`);
    return null;
  }
  await saveShot(page, shots, `attempt${attemptNo}-menu`);

  // 確認画面を最大6段まで進める
  for (let step = 0; step < 6; step++) {
    const success = await firstVisibleText(page, config.successTexts);
    if (success) break;
    let clicked = false;
    for (const label of config.proceedButtonTexts) {
      const btn = page.getByRole('button', { name: label })
        .or(page.locator(`input[type=submit][value*="${label}"]`))
        .or(page.getByRole('link', { name: label }))
        .first();
      if (await btn.isVisible().catch(() => false)) {
        log(`  → 「${label}」`);
        await btn.click().catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await saveShot(page, shots, `attempt${attemptNo}-step${step}-${label}`);
        clicked = true;
        break;
      }
    }
    if (!clicked) break;
  }

  const success = await firstVisibleText(page, config.successTexts);
  if (success) {
    await saveShot(page, shots, `attempt${attemptNo}-SUCCESS`);
    const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 800);
    return `「${success}」を確認\n---\n${body}`;
  }
  log(`試行${attemptNo}: 完了画面に到達できず。`);
  await saveShot(page, shots, `attempt${attemptNo}-stuck`);
  await dumpHtml(page, `attempt${attemptNo}-stuck`);
  return null;
}

// ---- メイン ----
const offset = await measureClockOffsetMs();
const now = () => Date.now() + offset;
log(`時刻同期: ローカル時計との差 ${offset}ms (NICT基準)`);

const targetMs = DRY_RUN ? now() : nextJstTimeToEpochMs(config.targetTimeJst);
log(DRY_RUN
  ? 'ドライラン: ログイン確認のみ（予約はしません）'
  : `目標時刻(JST) ${config.targetTimeJst} まで あと ${Math.round((targetMs - now()) / 60000)} 分`);

const wakeMs = targetMs - (config.preOpenLeadMinutes ?? 5) * 60000;
if (now() < wakeMs) {
  log(`受付 ${config.preOpenLeadMinutes} 分前まで待機...`);
  await sleep(wakeMs - now());
}

const browser = await chromium.launch(launchOptions(config));
try {
  const context = await browser.newContext({ locale: 'ja-JP' });
  const page = await context.newPage();
  try {
    await ensureLoggedIn(page);
  } catch (e) {
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_NAME_NOT_RESOLVED|net::ERR/.test(e.message)) {
      log('❌ medicalpass.jp に到達できません（ネットワーク遮断）。');
      log('   この環境のポリシーで medicalpass.jp がブロックされている可能性があります。');
      log('   手元のPCで実行するか、環境のネットワーク許可に medicalpass.jp を追加してください。');
      process.exit(2);
    }
    throw e;
  }

  if (DRY_RUN) {
    await page.goto(config.departmentUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await saveShot(page, shots, 'dry-department');
    await dumpHtml(page, 'dry-department');
    const menu = await clickMenu(page).catch(() => null);
    log(`ドライラン結果: ログインOK / 診療科ページ到達 / メニュー検出=${menu ?? 'なし'}`);
    log('screenshots/ に dry-department.{png,html} を保存しました。これを見て config を詰められます。');
    process.exit(0);
  }

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
  } else {
    log('❌ 予約できませんでした。screenshots/ を確認してください。');
    await notify('❌ おおはしこどもクリニック 予約失敗。screenshots/ を確認してください。');
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
