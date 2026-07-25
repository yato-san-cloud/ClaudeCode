// src/ の ES モジュールと CSS を 1 枚の index.html にまとめる。
//   node build.mjs
// 単体ファイルにしておくと、ダブルクリックで開くだけで遊べる (file:// でも動く)。
// 一方 src/ は ES モジュールのままなので、tools/verify.mjs から直接 import できる。

import { readFileSync, writeFileSync } from 'node:fs';

// 依存順に並べる。バンドル後は 1 つのスコープに展開されるので、
// モジュール間で名前がぶつからないようにしておくこと。
const ORDER = ['sand.js', 'levels.js', 'sfx.js', 'puzzle.js', 'fake.js', 'app.js'];

function strip(src, name) {
  const out = [];
  for (const line of src.split('\n')) {
    if (/^\s*import\s.*from\s*['"].*['"];?\s*$/.test(line)) continue; // import 行は落とす
    if (/^\s*export\s*\{[^}]*\}\s*;?\s*$/.test(line)) continue; // 再エクスポート行も落とす
    out.push(line.replace(/^(\s*)export\s+(?=const|let|var|function|class|async)/, '$1'));
  }
  return `/* ===== src/${name} ===== */\n${out.join('\n').trim()}\n`;
}

const js = ORDER.map((f) => strip(readFileSync(new URL(`src/${f}`, import.meta.url), 'utf8'), f)).join('\n');
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
