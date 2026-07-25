// 任意の画面のスクリーンショットを撮るだけの道具。
//   node qa/shot.mjs <出力先> <評価する式>   例: node qa/shot.mjs /tmp "showGallery()"
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [out, expr, name = 'shot'] = process.argv.slice(2);
const P = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const b = await chromium.launch(existsSync(P) ? { executablePath: P } : {});
const p = await b.newPage({ viewport: { width: 420, height: 760 } });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.goto('file://' + fileURLToPath(new URL('../index.html', import.meta.url)));
await p.evaluate((e) => { sfx.muted = true; eval(e); }, expr);
await p.waitForTimeout(700);
await p.screenshot({ path: `${out}/${name}.png` });
await b.close();
console.log(`${out}/${name}.png`);
