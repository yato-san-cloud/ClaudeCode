// index.html を実際のブラウザで通しプレイして、各画面のスクリーンショットを撮る。
//   node tools/smoke.mjs [出力ディレクトリ]
// コンソールエラーが 1 件でもあれば失敗扱いにする。

import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outDir = process.argv[2] ?? 'shots';
mkdirSync(outDir, { recursive: true });

// この環境には Chromium が同梱されている。playwright 側が期待するビルド番号とは
// ずれることがあるので、あれば実体を直接指す (`playwright install` は不要)。
const PREINSTALLED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const launchOpts = existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {};

const url = 'file://' + fileURLToPath(new URL('../index.html', import.meta.url));
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 420, height: 760 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const shot = async (name) => {
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`  撮影: ${name}.png`);
};
const step = (msg) => console.log(`▶ ${msg}`);
// CTA ボタンは常時ぷるぷる動いているので、Playwright の「静止待ち」を飛ばす
const tapCta = (sel) => page.click(sel, { force: true });

/** 落砂が落ち着くまで待つ。 */
const settle = (which) =>
  page.waitForFunction((w) => (w === 'ad' ? adView : realView).sand.idle >= 30, which, { timeout: 30000 });

await page.goto(url);
await page.waitForFunction(() => typeof adView !== 'undefined');
step('起動直後（広告ギャラリーが開く）');
await shot('01-start');
await page.evaluate(() => { sfx.muted = true; });

step('本編を最初から');
await page.click('#story-start');
await page.waitForSelector('#ad.on');

step('広告のデモ（下手なプレイヤーが失敗する）');
await page.waitForFunction(() => adView.state === 'lost', null, { timeout: 20000 });
await shot('02-ad-demo-fail');

step('広告内のプレイ（自分で解く）');
await page.waitForFunction(() => adPhase === 'play' && adView.state === 'play', null, { timeout: 20000 });
await settle('ad');
await page.evaluate(() => adView.pull(2));
await settle('ad');
await page.evaluate(() => adView.pull(1));
await page.waitForFunction(() => adView.state === 'won', null, { timeout: 30000 });
await shot('03-ad-clear');

step('ストア');
await tapCta('#ad-install');
await page.waitForTimeout(400);
await shot('04-store');

step('インストール');
await tapCta('#store-install');
await page.waitForSelector('#install-open:not(.hide)', { timeout: 30000 });
await shot('05-install');

step('実物のゲーム（ポップアップの行列）');
await tapCta('#install-open');
await page.waitForSelector('#veil.on');
await shot('06-game-popup');

// ポップアップを順に閉じる。× は逃げるので必ず一番下のボタンを押す
for (let i = 0; i < 8; i++) {
  const open = await page.evaluate(() => document.querySelector('#veil').classList.contains('on'));
  if (!open) break;
  await page.click('#veil .pop .stack button:last-child');
  await page.waitForTimeout(250);
}
await shot('07-game-board');

step('マージを数回して全画面広告を出す');
await page.click('#fg-spawn');
await page.waitForTimeout(200);
await page.click('#fg-spawn');
await page.waitForTimeout(200);
await page.click('#fg-spawn');
await page.waitForSelector('#interstitial.on', { timeout: 10000 });
await shot('08-interstitial');
await page.click('.adclose'); // 1 回目は逃げる
await page.waitForTimeout(300);
await page.click('.adclose');
await page.waitForTimeout(400);

step('返金');
await page.evaluate(() => merge.onRefund());
await page.waitForSelector('#refund-done:not(.hide)', { timeout: 20000 });
await shot('09-refund');

step('広告ギャラリー');
await tapCta('#refund-play');
await page.waitForSelector('#gallery.on');
await page.waitForTimeout(300);
await shot('10-gallery');

step('ピン抜きパズル');
await page.click('#gallery-cards .adcard');
await page.waitForSelector('#real.on');
await page.waitForTimeout(300);
await shot('10b-levels');

await page.click('#real-grid .levelcard');
await page.waitForTimeout(600);
await shot('11-stage1');
await settle('real');
await page.evaluate(() => realView.pull(2));
await settle('real');
await page.evaluate(() => realView.pull(1));
await page.waitForFunction(() => realView.state === 'won', null, { timeout: 30000 });
await page.waitForTimeout(400);
await shot('12-stage1-clear');

// 2 面目が解放されているか
const unlocked = await page.evaluate(() => {
  showSelect();
  return !document.querySelectorAll('#real-grid .levelcard')[1].disabled;
});
console.log(`▶ ステージ2の解放: ${unlocked ? 'OK' : 'NG'}`);

// 残りのステージも、定義された手順どおりに実際のブラウザでクリアできるか通す。
// ヘッドレス検証 (tools/verify.mjs) と同じ結果が出ることの確認でもある。
step('全ステージを手順どおりに攻略');
let allCleared = true;
for (let i = 1; i < 5; i++) {
  await page.evaluate((n) => startRealLevel(LEVELS[n]), i);
  const steps = await page.evaluate((n) => LEVELS[n].solution.map((s) => s.pin), i);
  for (const pin of steps) {
    await settle('real');
    await page.evaluate((p) => realView.pull(p), pin);
  }
  const won = await page
    .waitForFunction(() => realView.state === 'won', null, { timeout: 40000 })
    .then(() => true, () => false);
  const info = await page.evaluate(() => ({ c: realView.sand.collected, n: realLevel.need, s: realView.state }));
  console.log(`  ステージ${i + 1}: ${won ? 'クリア' : `失敗(${info.s})`} 回収 ${info.c}/${info.n}`);
  if (!won) allCleared = false;
}
await page.evaluate(() => showGallery());
await shot('13-gallery-progress');

// ギャラリーに並んだ広告ゲームも 1 本ずつ自動クリアできるか
step('広告ゲームの通し確認');
const minis = await page.evaluate(() => MINI_GAMES.map((g) => g.meta.title));
for (let i = 0; i < minis.length; i++) {
  const r = await page.evaluate(async (i) => {
    startMini(MINI_GAMES[i], 0);
    await new Promise((r) => setTimeout(r, 150));
    miniHost.game.solve();
    for (let t = 0; t < 400 && miniHost.state === 'play'; t++) await new Promise((r) => setTimeout(r, 50));
    return miniHost.state;
  }, i);
  console.log(`  ${minis[i]}: ${r === 'won' ? 'OK' : 'NG ' + r}`);
  if (r !== 'won') allCleared = false;
}

await browser.close();

if (errors.length) {
  console.log(`\nコンソールエラー ${errors.length} 件:`);
  errors.forEach((e) => console.log('  ' + e));
  process.exit(1);
}
if (!unlocked || !allCleared) process.exit(1);
console.log('\n通しプレイ OK');
