/*
 * 現場マニュアル作成ツール smoke test
 * 実行: node tests/smoke.js
 * 前提: Playwright（グローバル or /opt/node22/lib/node_modules）と Chromium
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

let pw;
try { pw = require("playwright"); }
catch (e) { pw = require("/opt/node22/lib/node_modules/playwright"); }

const CHROMIUM =
  process.env.SMOKE_CHROMIUM ||
  (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

const APP = "file://" + path.resolve(__dirname, "..", "index.html");

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "  ok " : "  NG ") + name + (ok ? "" : "  <- " + detail));
  if (!ok) failures++;
}

(async () => {
  const browser = await pw.chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push("PAGEERR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });

  console.log("[1] エディタ: 作成 → 写真 → 書き込み → 点検タイプ");
  await page.goto(APP);
  await page.waitForSelector("#v-home:not([hidden])");

  // 疑似「現場写真」をブラウザ内で生成
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 400; c.height = 300;
    const x = c.getContext("2d");
    x.fillStyle = "#888"; x.fillRect(0, 0, 400, 300);
    x.fillStyle = "#d33"; x.fillRect(150, 100, 100, 100);
    return c.toDataURL("image/jpeg", 0.9);
  });
  const photoBuf = Buffer.from(dataUrl.split(",")[1], "base64");

  await page.click("#btn-new");
  await page.waitForSelector("#v-edit:not([hidden])");
  await page.fill("#m-title", "テスト点検マニュアル");

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click("#add"),
  ]);
  await chooser.setFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: photoBuf });
  await page.waitForSelector(".photo-slot img");
  check("写真が手順に入る", true);

  await page.fill(".s-title", "電源スイッチ確認");
  await page.fill(".step-body textarea", "パネルのランプが緑であること");
  await page.click('.seg button[data-t="check"]');
  await page.waitForSelector(".step-num.n-check");
  check("手順タイプ=点検", true);

  await page.click(".photo-slot img");
  await page.waitForSelector("#annot:not([hidden])");
  await page.waitForFunction(() => document.getElementById("an-cv").width > 0);
  const box = await page.locator("#an-cv").boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 5 });
  await page.mouse.up();
  await page.click("#an-save");
  const marks = await page.evaluate(() => (cur.steps[0].marks || []).length);
  check("書き込み(丸)が1件保存される", marks === 1, "marks=" + marks);
  const hasOrig = await page.evaluate(() => !!cur.steps[0].photoOrig);
  check("元写真(photoOrig)を保持", hasOrig);

  await page.evaluate(() => { cur.reviewDate = "2020-01-01"; cur.status = "active"; save(); });
  await page.waitForTimeout(700); // autosave debounce

  console.log("[2] 永続化: リロード後も残る");
  await page.reload();
  await page.waitForSelector(".mcard");
  const cardTitle = await page.textContent(".mtitle");
  check("一覧にカード表示", cardTitle.includes("テスト点検マニュアル"), cardTitle);
  const overChip = await page.locator(".chip.st-over").count();
  check("期限切れ→要見直しチップ", overChip === 1, "count=" + overChip);

  console.log("[3] 書き出しHTML(ビューア)");
  await page.click(".mcard");
  await page.waitForSelector("#v-edit:not([hidden])");
  const html = await page.evaluate(() => buildDoc(cur));
  const rt = await page.evaluate(h => { const a = parseImport(h); return a.length === 1 ? a[0].title : ""; }, html);
  check("再取り込み(ラウンドトリップ)", rt === "テスト点検マニュアル", "got=" + rt);

  const viewerPath = path.join(os.tmpdir(), "genba_viewer_test.html");
  fs.writeFileSync(viewerPath, html);
  const v = await ctx.newPage();
  const verrs = [];
  v.on("pageerror", e => verrs.push(e.message));
  await v.goto("file://" + viewerPath);
  await v.waitForFunction(() => {
    const im = document.querySelector("img[data-p]");
    return im && im.src.indexOf("data:") === 0;
  });
  check("写真がJSONから復元される", true);
  check("期限切れバナー表示", await v.isVisible("#ov-banner"));

  await v.check('input[data-ck="0"]');
  const ckSaved = await v.evaluate(() =>
    Object.keys(localStorage).some(k => k.indexOf("gm_ck_") === 0));
  check("チェック状態がlocalStorageに保存", ckSaved);

  await v.click("#v-genba");
  const gTitle = await v.textContent("#g-title");
  check("現場モードで手順表示", gTitle === "電源スイッチ確認", gTitle);
  await v.click("#g-next"); // 1手順のみ→完了で閉じる
  check("現場モード完了で閉じる", await v.isHidden("#genba"));

  await v.click("#v-fb");
  await v.fill("#fb-text", "バルブが電動化されている");
  await v.click("#fb-add");
  const fbCount = await v.locator("#fb-list li:not(.fb-empty)").count();
  check("フィードバック追加", fbCount === 1, "count=" + fbCount);

  check("エディタ側 JSエラーなし", errs.length === 0, errs.join(" | "));
  check("ビューア側 JSエラーなし", verrs.length === 0, verrs.join(" | "));

  await browser.close();
  fs.unlinkSync(viewerPath);
  console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURE(S)");
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
