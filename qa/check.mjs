// 広告ミニゲームの自動検証。
//   node qa/check.mjs [スクショ出力先]
// 各ゲームの各ステージについて game.solve() を呼び、実ブラウザで win に到達するか確かめる。
// あわせてページ例外・console.error を 1 件でも拾ったら失敗にする。

import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outDir = process.argv[2] ?? 'qa/shots';
mkdirSync(outDir, { recursive: true });

const PREINSTALLED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {});
const page = await browser.newPage({ viewport: { width: 420, height: 760 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('file://' + fileURLToPath(new URL('../index.html', import.meta.url)));
await page.evaluate(() => { sfx.muted = true; });

const games = await page.evaluate(() => MINI_GAMES.map((g) => ({ id: g.meta.id, title: g.meta.title, stages: g.meta.stages })));
console.log(`登録されている広告ゲーム: ${games.length} 本\n`);

let failures = 0;
for (const [gi, g] of games.entries()) {
  const results = [];
  for (let s = 0; s < g.stages; s++) {
    const r = await page.evaluate(
      async ([gi, s]) => {
        startMini(MINI_GAMES[gi], s);
        await new Promise((r) => setTimeout(r, 120));
        if (typeof miniHost.game.solve !== 'function') return 'solve()未実装';
        try { miniHost.game.solve(); } catch (e) { return 'solve()で例外: ' + e.message; }
        for (let t = 0; t < 300; t++) {
          if (miniHost.state !== 'play') break;
          await new Promise((r) => setTimeout(r, 50));
        }
        return miniHost.state;
      },
      [gi, s]
    );
    results.push(r);
    if (r !== 'won') failures++;
  }
  const ok = results.every((r) => r === 'won');
  console.log(`${ok ? 'OK  ' : 'NG  '}${g.title} (${g.id}): ${results.join(', ')}`);
  await page.evaluate((gi) => startMini(MINI_GAMES[gi], 0), gi);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/${g.id}.png` });
}

await page.evaluate(() => showGallery());
await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/00-gallery.png` });
await browser.close();

if (errors.length) {
  console.log(`\nコンソールエラー ${errors.length} 件:`);
  [...new Set(errors)].forEach((e) => console.log('  ' + e));
  failures++;
}
console.log(failures === 0 ? '\n全ゲーム検証OK' : `\n${failures} 件の問題あり`);
process.exit(failures === 0 ? 0 : 1);
