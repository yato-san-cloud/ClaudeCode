/**
 * MEDICALPASS 自動順番予約
 *
 * 使い方:
 *   npm run book        # 受付開始時刻(既定 06:00 JST)まで待って予約を1件取る
 *   npm run book:dry    # 今すぐログイン〜メニュー画面までの動作確認のみ（予約はしない）
 *
 * 設計方針:
 *  - 自分の予約1件を、開始時刻ちょうどに「人間1人分」の操作として行う
 *  - 失敗時のみ数秒間隔でリトライ（config.retry）。サーバーへの連打はしない
 *  - 各ステップでスクリーンショットを保存し、結果を Webhook で通知（任意）
 */
import { chromium } from 'playwright';
import {
  loadDotEnv, loadConfig, log, sleep, notify, saveShot,
  measureClockOffsetMs, nextJstTimeToEpochMs,
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

/** ページ内に指定テキスト群のいずれかが表示されているか */
async function pageHasText(page, texts) {
  for (const t of texts) {
    if (await page.getByText(t, { exact: false }).first().isVisible().catch(() => false)) return t;
  }
  return null;
}

/** 必要ならログインする（メール+パスワードのフォームを汎用的に検出） */
async function ensureLoggedIn(page) {
  await page.goto(config.departmentUrl, { waitUntil: 'domcontentloaded' });

  // ログインフォームが直接出ていなければ「ログイン」リンクを探す
  const hasPw = async () => (await page.locator('input[type=password]').count()) > 0;
  if (!(await hasPw())) {
    const loginLink = page.getByText('ログイン', { exact: false }).first();
    if (await loginLink.isVisible().catch(() => false)) {
      await loginLink.click();
      await page.waitForLoadState('domcontentloaded');
    }
  }
  if (await hasPw()) {
    log('ログインフォームを検出。ログインします。');
    const emailInput = page.locator('input[type=email], input[name*="email" i], input[name*="mail" i]').first();
    await emailInput.fill(email);
    await page.locator('input[type=password]').first().fill(password);
    await saveShot(page, shots, 'login-filled');
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.locator('button[type=submit], input[type=submit]').first().click(),
    ]);
    if (await hasPw()) {
      await saveShot(page, shots, 'login-failed');
      throw new Error('ログインに失敗した可能性があります（パスワード欄が残っています）');
    }
    log('ログイン成功。');
  } else {
    log('ログインフォームなし（セッション有効 or ログイン不要ページ）。');
  }
  await saveShot(page, shots, 'after-login');
}

/** 1回分の予約試行。成功したら受付結果テキストを返し、まだ受付前なら null */
async function attemptBooking(page, attemptNo) {
  await page.goto(config.departmentUrl, { waitUntil: 'domcontentloaded' });

  if (await pageHasText(page, config.closedTexts)) {
    log(`試行${attemptNo}: まだ受付時間外の表示。`);
    return null;
  }

  const menu = page.getByText(config.menuText, { exact: false }).first();
  if (!(await menu.isVisible().catch(() => false))) {
    log(`試行${attemptNo}: メニュー「${config.menuText}」が見つかりません。`);
    await saveShot(page, shots, `attempt${attemptNo}-no-menu`);
    return null;
  }
  await menu.click();
  await page.waitForLoadState('domcontentloaded');
  await saveShot(page, shots, `attempt${attemptNo}-menu-clicked`);

  // 確認系ボタンを最大6画面ぶん進める
  for (let step = 0; step < 6; step++) {
    const success = await pageHasText(page, config.successTexts);
    if (success) {
      await saveShot(page, shots, `attempt${attemptNo}-SUCCESS`);
      const body = (await page.locator('body').innerText()).slice(0, 1000);
      return `「${success}」を確認\n---\n${body}`;
    }
    let clicked = false;
    for (const label of config.proceedButtonTexts) {
      const btn = page.getByRole('button', { name: label }).or(
        page.locator(`input[type=submit][value*="${label}"], a:has-text("${label}")`)
      ).first();
      if (await btn.isVisible().catch(() => false)) {
        log(`  → ボタン「${label}」をクリック`);
        await btn.click();
        await page.waitForLoadState('domcontentloaded');
        await saveShot(page, shots, `attempt${attemptNo}-step${step}-${label}`);
        clicked = true;
        break;
      }
    }
    if (!clicked) break;
  }
  const success = await pageHasText(page, config.successTexts);
  if (success) {
    await saveShot(page, shots, `attempt${attemptNo}-SUCCESS`);
    return `「${success}」を確認`;
  }
  log(`試行${attemptNo}: 完了画面に到達できませんでした。`);
  await saveShot(page, shots, `attempt${attemptNo}-stuck`);
  return null;
}

// ---- メイン ----
const offset = await measureClockOffsetMs();
const now = () => Date.now() + offset;
log(`時刻同期: ローカル時計との差 ${offset}ms (NICT基準)`);

const targetMs = DRY_RUN ? now() : nextJstTimeToEpochMs(config.targetTimeJst);
log(DRY_RUN
  ? 'ドライラン: 今すぐログイン確認のみ行います（予約はしません）'
  : `目標時刻(JST): ${config.targetTimeJst} → あと ${Math.round((targetMs - now()) / 60000)} 分`);

// 開始 preOpenLeadMinutes 分前までスリープ
const wakeMs = targetMs - (config.preOpenLeadMinutes ?? 5) * 60000;
if (now() < wakeMs) {
  log(`受付 ${config.preOpenLeadMinutes} 分前まで待機します...`);
  await sleep(wakeMs - now());
}

const browser = await chromium.launch({ headless: !!config.headless });
try {
  const context = await browser.newContext({ locale: 'ja-JP' });
  const page = await context.newPage();
  await ensureLoggedIn(page);

  if (DRY_RUN) {
    const menuVisible = await page.getByText(config.menuText, { exact: false }).first()
      .isVisible().catch(() => false);
    log(`ドライラン結果: ログインOK / メニュー「${config.menuText}」表示=${menuVisible}`);
    log('スクリーンショットを screenshots/ に保存しました。ここで終了します。');
    process.exit(0);
  }

  // 開始0.5秒前まで待ってから試行開始
  if (now() < targetMs - 500) await sleep(targetMs - 500 - now());
  log('受付開始時刻。予約を試行します。');

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
    await notify('❌ おおはしこどもクリニック 予約失敗。スクリーンショットを確認してください。');
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
