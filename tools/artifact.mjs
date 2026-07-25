// index.html を Artifact 公開用の断片に変換する。
//   node tools/artifact.mjs [出力先]   既定: artifact.html
//
// Artifact 側が <!doctype>〜<body> の外枠を用意するので、
// こちらは <title> / <style> / 本文 / <script> だけを渡す。
// index.html から切り出すだけなので、ビルドし直せば公開用も自動で追随する。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const pick = (re, what) => {
  const m = src.match(re);
  if (!m) throw new Error(`index.html から${what}を取り出せませんでした。先に node build.mjs を実行してください`);
  return m[1];
};

const title = pick(/<title>([\s\S]*?)<\/title>/, 'タイトル');
const style = pick(/<style>([\s\S]*?)<\/style>/, 'スタイル');
const body = pick(/<body>([\s\S]*?)<\/body>/, '本文');

const arg = process.argv[2] ?? 'artifact.html';
const out = arg.startsWith('/') ? arg : fileURLToPath(new URL(`../${arg}`, import.meta.url));
writeFileSync(out, `<title>${title}</title>\n<style>\n${style}\n</style>\n${body.trim()}\n`);
console.log(`${out} を書き出しました (${(readFileSync(out, 'utf8').length / 1024).toFixed(1)} KB)`);
