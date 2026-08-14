#!/usr/bin/env node
// 単一 index.html(Artifact/ローカル用)と pwa/index.html(ホスティング用PWA)を src/ から組み立てる
const fs = require("fs");
const path = require("path");
const R = __dirname;
const read = f => fs.readFileSync(path.join(R, f), "utf8");

const unitFiles = fs.readdirSync(path.join(R, "src/units"))
  .filter(f => /^unit\d{2}\.js$/.test(f)).sort();

const dictPath = path.join(R, "src/dictionary.js");
const dictJs = fs.existsSync(dictPath) ? fs.readFileSync(dictPath, "utf8") : "";

const HEAD_COMMON = `<title>Power BI 道場 〜物流データアナリスト養成〜</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="PBI道場">
<meta name="theme-color" content="#e8641b">`;

// PWA(ホスティング)版だけに付くヘッダー: マニフェスト・アイコン・サービスワーカー登録
const HEAD_PWA = `
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" type="image/png" sizes="192x192" href="icon-192.png">
<scr` + `ipt>
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  addEventListener("load", () => { navigator.serviceWorker.register("./sw.js").catch(() => {}); });
}
</scr` + `ipt>`;

function page(headExtra) {
  return `${HEAD_COMMON}${headExtra}
<style>
${read("src/style.css")}
</style>
${read("src/body.html")}
<script>
${read("src/editor.js")}
${dictJs}
${unitFiles.map(u => read("src/units/" + u)).join("\n")}
${read("src/app.js")}
</script>
`;
}

const artifactHtml = page("");
fs.writeFileSync(path.join(R, "index.html"), artifactHtml);

fs.mkdirSync(path.join(R, "pwa"), { recursive: true });
fs.writeFileSync(path.join(R, "pwa/index.html"), page(HEAD_PWA));

console.log(`built index.html: ${(artifactHtml.length / 1024).toFixed(0)} KB, units: ${unitFiles.length}`);
console.log("built pwa/index.html (manifest + service worker 付き)");
