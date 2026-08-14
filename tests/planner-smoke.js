/*
 * 作業計画ウィザード（planner.html）smoke test
 * 実行: node tests/planner-smoke.js
 * クロス連携（生成物→index.htmlの取り込み）まで検証する
 */
const fs = require("fs");
const path = require("path");

let pw;
try { pw = require("playwright"); }
catch (e) { pw = require("/opt/node22/lib/node_modules/playwright"); }

const CHROMIUM =
  process.env.SMOKE_CHROMIUM ||
  (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

const PLANNER = "file://" + path.resolve(__dirname, "..", "planner.html");
const EDITOR  = "file://" + path.resolve(__dirname, "..", "index.html");

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "  ok " : "  NG ") + name + (ok ? "" : "  <- " + detail));
  if (!ok) failures++;
}

(async () => {
  const browser = await pw.chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", e => errs.push("PAGEERR: " + e.message));
  p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });

  console.log("[1] ウィザード: テンプレート選択→入力→生成");
  await p.goto(PLANNER);
  check("テンプレートが8種表示", await p.locator(".tcard").count() === 8,
    String(await p.locator(".tcard").count()));

  await p.click('.tcard[data-k="clean"]');
  const toolsPrefill = await p.inputValue("#q-tools");
  check("タイプ選択で道具が自動入力", toolsPrefill.includes("ほうき"), toolsPrefill);

  await p.fill("#q-goal", "返品エリアの棚を整備して写真で記録");
  await p.fill("#q-place", "第2工場 A棟 返品エリア");
  await p.fill("#q-target", "棚A〜C");
  await p.fill("#q-done", "床に物がなく全ラベルが手前を向いている状態");
  await p.fill("#q-contact", "佐藤班長");
  await p.fill("#q-min", "60");
  await p.click("#btn-gen");
  await p.waitForSelector("#result", { state: "visible" });

  check("業務フロー表示", await p.locator("#r-flow .fbox").count() >= 3);
  check("手順骨格に対象名が展開", (await p.textContent("#r-skel")).includes("棚A〜C"));

  const sheet = await p.textContent("#r-sheet");
  check("指示書: 【撮影】ブロック（契約形式）",
    sheet.includes("【撮影】No.01") && sheet.includes("対象：") && sheet.includes("合格条件："), sheet.slice(0, 120));
  check("指示書: 完了の見た目・末尾3欄",
    sheet.includes("[完了の見た目]") && sheet.includes("■ 終わったら") && sheet.includes("■ 困ったとき") && sheet.includes("■ 帰る前に"));
  check("指示書: 連絡先が展開", sheet.includes("佐藤班長"));

  console.log("[2] 生成物の取得（指示書md / 骨格json / AIプロンプト）");
  const artifacts = await p.evaluate(() => ({
    md: buildSheet(lastGen),
    json: buildSkeletonJson(lastGen),
    ai: buildAiPrompt(lastGen),
  }));
  check("骨格jsonがパース可能", (() => { try { JSON.parse(artifacts.json); return true; } catch (e) { return false; } })());
  const skel = JSON.parse(artifacts.json);
  check("骨格jsonに教育メモ（完了条件）",
    skel.steps.length >= 4 && !!skel.steps[0].edu && !!skel.steps[0].edu.done, JSON.stringify(skel.steps[0]));
  check("AIプロンプトに契約形式と禁止語ルール",
    artifacts.ai.includes("【撮影】No.01") && artifacts.ai.includes("適宜"));

  console.log("[3] クロス連携: 生成物 → index.html 取り込み");
  const e = await ctx.newPage();
  const eErrs = [];
  e.on("pageerror", x => eErrs.push(x.message));
  await e.goto(EDITOR);
  await e.waitForSelector("#v-home:not([hidden])");
  const viaJson = await e.evaluate(t => {
    const a = parseImport(t, "骨格_test.json");
    return a.length === 1 ? { n: a[0].steps.length, title: a[0].title, edu: a[0].steps[0].edu && a[0].steps[0].edu.done } : null;
  }, artifacts.json);
  check("骨格json→エディタ取り込み", !!viaJson && viaJson.n === skel.steps.length && viaJson.title.includes("返品エリア"),
    JSON.stringify(viaJson));
  const viaMd = await e.evaluate(t => {
    const a = parseImport(t, "指示書_test.md");
    return a.length === 1 ? { n: a[0].steps.length, t1: a[0].steps[0].title } : null;
  }, artifacts.md);
  check("指示書md（撮影ブロック）→エディタ取り込み", !!viaMd && viaMd.n >= 2, JSON.stringify(viaMd));

  console.log("[4] クイック生成（未記入→【要記入】）");
  await p.click("#btn-back");
  await p.click('.tcard[data-k="inspect"]');
  for (const id of ["q-goal","q-place","q-target","q-done","q-contact","q-min"]) await p.fill("#"+id, "");
  await p.click("#btn-quick");
  await p.waitForSelector("#result", { state: "visible" });
  const quickSheet = await p.textContent("#r-sheet");
  check("クイック生成: 空欄が【要記入】で可視化", quickSheet.includes("【要記入】"));

  check("planner側 JSエラーなし", errs.length === 0, errs.join(" | "));
  check("editor側 JSエラーなし", eErrs.length === 0, eErrs.join(" | "));

  await browser.close();
  console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURE(S)");
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
