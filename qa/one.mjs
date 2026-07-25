// 広告ゲームを 1 本だけ単体でビルドして検証する。
//   node qa/one.mjs <id>        例: node qa/one.mjs rescue
//
// index.html には触らず、一時ファイルに専用のミニ HTML を書き出して検証するので、
// 複数人（複数エージェント）が同時に別々のゲームを検証しても衝突しない。
//
// 各ステージについて game.solve() を呼び、実ブラウザで win に到達するかを見る。
// あわせてページ例外・console.error・「決着しない」を失敗として扱う。

import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strip } from '../tools/strip.mjs';

const id = process.argv[2];
if (!id) {
  console.error('使い方: node qa/one.mjs <id>   (例: node qa/one.mjs rescue)');
  process.exit(2);
}

const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const adFile = new URL(`../src/ads/${id}.js`, import.meta.url);
if (!existsSync(adFile)) {
  console.error(`src/ads/${id}.js がありません`);
  process.exit(2);
}

const adSrc = readFileSync(adFile, 'utf8');
const m = adSrc.match(/^export const ([A-Z0-9_]+)\s*=/m);
if (!m) {
  console.error('トップレベルに `export const <大文字ID> = {...}` が見つかりません');
  process.exit(2);
}
const NAME = m[1];

// 規約チェック: トップレベルの宣言はその 1 つだけ
const tops = [...adSrc.matchAll(/^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm)].map((x) => x[1]);
if (tops.length !== 1 || tops[0] !== NAME) {
  console.error(`トップレベル宣言は ${NAME} ひとつだけにしてください。見つかったもの: ${tops.join(', ')}`);
  process.exit(2);
}

const js = ['sfx.js', 'gfx.js', 'mini.js'].map((f) => strip(read(f), f)).join('\n') +
  strip(adSrc, `ads/${id}.js`) +
  `\n/* ===== 検証用ブートストラップ ===== */\n` +
  `const ENTRY = ${NAME};\n` +
  `const host = new MiniHost(document.getElementById('c'));\n` +
  `sfx.muted = true;\n` +
  `requestAnimationFrame(function f(t){ host.frame(t); requestAnimationFrame(f); });\n`;

const html = `<!doctype html><meta charset="utf-8"><title>${id}</title>
<style>body{margin:0;background:#111}canvas{width:360px;height:520px;display:block}</style>
<canvas id="c"></canvas><script>\n${js}\n</script>`;

const out = join(tmpdir(), `minicheck-${id}.html`);
writeFileSync(out, html);

const PREINSTALLED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {});
const page = await browser.newPage({ viewport: { width: 400, height: 600 } });
const errors = [];
page.on('console', (e) => { if (e.type() === 'error') errors.push(e.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('file://' + out);
await page.waitForFunction(() => typeof host !== 'undefined');

const meta = await page.evaluate(() => ENTRY.meta);
console.log(`${meta.title} (${meta.id}) / ${meta.stages} ステージ`);
for (const k of ['id', 'title', 'hook', 'icon', 'reality', 'stages', 'tint']) {
  if (meta[k] === undefined) { console.error(`meta.${k} がありません`); process.exit(1); }
}
if (meta.id !== id) { console.error(`meta.id (${meta.id}) がファイル名 (${id}) と一致しません`); process.exit(1); }

let bad = 0;
for (let s = 0; s < meta.stages; s++) {
  const r = await page.evaluate(async (s) => {
    host.load(ENTRY, s);
    await new Promise((r) => setTimeout(r, 150));
    if (typeof host.game.solve !== 'function') return 'solve()が未実装';
    if (typeof host.game.hint !== 'string' || !host.game.hint) return 'hint が空';
    try { host.game.solve(); } catch (e) { return 'solve()で例外: ' + e.message; }
    for (let t = 0; t < 400; t++) {
      if (host.state !== 'play') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return host.state === 'play' ? '決着しない(20秒待った)' : host.state;
  }, s);
  const ok = r === 'won';
  if (!ok) bad++;
  console.log(`  ステージ${s + 1}: ${ok ? 'OK' : 'NG'} ${r}`);
  await page.screenshot({ path: join(tmpdir(), `minicheck-${id}-${s + 1}.png`) });
}

// 何もしないまま放置したときに勝手にクリアにならないか（触らずに勝てる＝パズルになっていない）
const idle = await page.evaluate(async () => {
  host.load(ENTRY, 0);
  for (let t = 0; t < 60; t++) {
    if (host.state === 'won') return 'won';
    await new Promise((r) => setTimeout(r, 50));
  }
  return host.state;
});
if (idle === 'won') { console.log('  NG 何も操作しなくてもクリアになる'); bad++; }

await browser.close();
console.log(`スクリーンショット: ${join(tmpdir(), `minicheck-${id}-*.png`)}`);
if (errors.length) {
  console.log(`コンソールエラー ${errors.length} 件:`);
  [...new Set(errors)].forEach((e) => console.log('  ' + e));
  bad++;
}
console.log(bad === 0 ? '検証OK' : `${bad} 件の問題あり`);
process.exit(bad === 0 ? 0 : 1);
