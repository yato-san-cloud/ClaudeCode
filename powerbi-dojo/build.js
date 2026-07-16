#!/usr/bin/env node
// 単一 index.html を src/ から組み立てる
const fs = require("fs");
const path = require("path");
const R = __dirname;
const read = f => fs.readFileSync(path.join(R, f), "utf8");

const unitFiles = fs.readdirSync(path.join(R, "src/units"))
  .filter(f => /^unit\d{2}\.js$/.test(f)).sort();

const html = `<title>Power BI 道場 〜物流データアナリスト養成〜</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${read("src/style.css")}
</style>
${read("src/body.html")}
<script>
${read("src/editor.js")}
${unitFiles.map(u => read("src/units/" + u)).join("\n")}
${read("src/app.js")}
</script>
`;

fs.writeFileSync(path.join(R, "index.html"), html);
console.log(`built index.html: ${(html.length / 1024).toFixed(0)} KB, units: ${unitFiles.length} (${unitFiles.join(", ")})`);
