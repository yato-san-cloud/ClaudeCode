/**
 * 偵察スクリプト: MEDICALPASS の予約画面の構造を記録する。
 *
 * 使い方:
 *   npm run inspect
 *
 * ブラウザが開くので、普段どおり手で操作してください（ログイン→メニュー選択→
 * 確認画面の手前まで）。ページを移動するたびに HTML・スクリーンショット・
 * API通信ログが recon-output/ に自動保存されます。終わったらブラウザを閉じるだけ。
 *
 * このスクリプト自身は一切クリックしません（予約が発生する操作はすべて人間の判断）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadDotEnv, loadConfig, ensureDir, timestamp, log } from './lib.js';

loadDotEnv();
const config = loadConfig();

const outDir = ensureDir(path.join('recon-output', timestamp()));
const netLog = [];
let pageCount = 0;

async function snapshotPage(page, label) {
  const n = String(++pageCount).padStart(2, '0');
  const base = path.join(outDir, `${n}_${label}`);
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    fs.writeFileSync(`${base}.html`, await page.content());
    await page.screenshot({ path: `${base}.png`, fullPage: true });

    // クリック可能要素とフォームの一覧を抽出
    const elements = await page.evaluate(() => {
      const pick = (els, type) =>
        [...els].map((el) => ({
          type,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.value || '').trim().slice(0, 80),
          href: el.href || undefined,
          name: el.name || undefined,
          id: el.id || undefined,
          class: el.className?.toString().slice(0, 120) || undefined,
        }));
      return [
        ...pick(document.querySelectorAll('a'), 'link'),
        ...pick(document.querySelectorAll('button, input[type=submit], input[type=button]'), 'button'),
        ...pick(document.querySelectorAll('input:not([type=submit]):not([type=button]), select, textarea'), 'input'),
        ...pick(document.querySelectorAll('form'), 'form'),
      ];
    });
    fs.writeFileSync(`${base}.elements.json`, JSON.stringify({ url: page.url(), elements }, null, 2));
    log(`保存: ${base}.{html,png,elements.json}  <- ${page.url()}`);
  } catch (e) {
    log(`スナップショット失敗 (${label}):`, e.message);
  }
}

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ locale: 'ja-JP' });
const page = await context.newPage();

// XHR/fetch のリクエスト・レスポンスを記録（JSONのみボディも保存）
page.on('response', async (res) => {
  const req = res.request();
  if (!['xhr', 'fetch', 'document'].includes(req.resourceType())) return;
  const entry = {
    time: new Date().toISOString(),
    method: req.method(),
    url: req.url(),
    status: res.status(),
    postData: req.postData()?.slice(0, 2000),
  };
  const ct = res.headers()['content-type'] || '';
  if (ct.includes('json')) {
    entry.body = (await res.text().catch(() => '')).slice(0, 5000);
  }
  netLog.push(entry);
});

page.on('framenavigated', async (frame) => {
  if (frame !== page.mainFrame()) return;
  const label = new URL(frame.url()).pathname.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 60) || 'root';
  await snapshotPage(page, label);
});

log(`記録開始: ${config.departmentUrl}`);
log(`保存先: ${outDir}`);
log('ブラウザで普段どおり操作してください。終わったらブラウザを閉じてください。');
await page.goto(config.departmentUrl).catch((e) => log('初回アクセス失敗:', e.message));

// ブラウザが閉じられるまで待機
await new Promise((resolve) => browser.on('disconnected', resolve));

fs.writeFileSync(path.join(outDir, 'network.json'), JSON.stringify(netLog, null, 2));
console.log(`\n完了。${outDir} をClaudeに共有してください（診察券番号などが写っていないか確認の上で）。`);
