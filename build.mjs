// src/ の ES モジュールと CSS を 1 枚の index.html にまとめる。
//   node build.mjs
// 単体ファイルにしておくと、ダブルクリックで開くだけで遊べる (file:// でも動く)。
// 一方 src/ は ES モジュールのままなので、tools/verify.mjs から直接 import できる。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { strip } from './tools/strip.mjs';

// 依存順に並べる。バンドル後は 1 つのスコープに展開されるので、
// モジュール間で名前がぶつからないようにしておくこと。
// src/ads/*.js は自動で拾う (各ファイルはトップレベル宣言が 1 つだけという規約)。
const ADS = readdirSync(new URL('src/ads', import.meta.url))
  .filter((f) => f.endsWith('.js'))
  .sort()
  .map((f) => `ads/${f}`);

const ORDER = ['sand.js', 'levels.js', 'sfx.js', 'gfx.js', 'mini.js', 'puzzle.js', ...ADS, 'fake.js', 'app.js'];

const js = ORDER.map((f) => strip(readFileSync(new URL(`src/${f}`, import.meta.url), 'utf8'), f)).join('\n');

// src/ads/ に置いたのに app.js の MINI_GAMES へ登録し忘れる、という事故が起きやすいので機械的に検査する。
const appSrc = readFileSync(new URL('src/app.js', import.meta.url), 'utf8');
const registry = appSrc.match(/const MINI_GAMES = \[([^\]]*)\]/)?.[1] ?? '';
const missing = [];
for (const f of ADS) {
  const name = readFileSync(new URL(`src/${f}`, import.meta.url), 'utf8').match(/^export const ([A-Z0-9_]+)\s*=/m)?.[1];
  if (!name) throw new Error(`src/${f}: トップレベルに export const <大文字ID> = {...} がありません`);
  if (!registry.includes(name)) missing.push(`${f} (${name})`);
}
if (missing.length) {
  throw new Error(`app.js の MINI_GAMES に登録されていない広告ゲームがあります:\n  ${missing.join('\n  ')}`);
}
const css = readFileSync(new URL('src/style.css', import.meta.url), 'utf8');
const body = readFileSync(new URL('template.html', import.meta.url), 'utf8');

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>広告詐欺ゲーム</title>
<meta name="description" content="広告で見たゲームと、実際に落としたゲームは違う。">
<style>
${css}
</style>
</head>
<body>
${body}
<script>
${js}
</script>
</body>
</html>
`;

writeFileSync(new URL('index.html', import.meta.url), html);
console.log(`index.html を書き出しました (${(html.length / 1024).toFixed(1)} KB)`);
