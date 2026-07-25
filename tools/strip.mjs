// ES モジュールを「1 スコープに並べても動く素のスクリプト」に落とす。
// build.mjs と qa/one.mjs の両方から使う。

export function strip(src, name) {
  const out = [];
  for (const line of src.split('\n')) {
    if (/^\s*import\s.*from\s*['"].*['"];?\s*$/.test(line)) continue; // import 行は落とす
    if (/^\s*export\s*\{[^}]*\}\s*;?\s*$/.test(line)) continue; // 再エクスポート行も落とす
    out.push(line.replace(/^(\s*)export\s+(?=const|let|var|function|class|async)/, '$1'));
  }
  return `/* ===== src/${name} ===== */\n${out.join('\n').trim()}\n`;
}
