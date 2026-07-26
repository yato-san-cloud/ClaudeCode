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
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push("PAGEERR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  page.on("dialog", d => {
    if (d.type() === "prompt") d.accept("ここを確認");
    else d.accept();
  });

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

  // 文字入れツール（promptは dialog ハンドラで自動入力）
  await page.click(".photo-slot img");
  await page.waitForSelector("#annot:not([hidden])");
  await page.click('.tl[data-tool="text"]');
  const box2 = await page.locator("#an-cv").boundingBox();
  await page.mouse.click(box2.x + box2.width * 0.5, box2.y + box2.height * 0.5);
  await page.click("#an-save");
  const marks2 = await page.evaluate(() => (cur.steps[0].marks || []).length);
  check("文字入れが追加される", marks2 === 2, "marks=" + marks2);

  // 手順の複製（直下に挿入）
  await page.click(".step .sdup");
  const dupCount = await page.evaluate(() => cur.steps.length);
  const dupTitle = await page.evaluate(() => cur.steps[1].title);
  check("手順の複製", dupCount === 2 && dupTitle === "電源スイッチ確認", `count=${dupCount} title=${dupTitle}`);
  await page.evaluate(() => { cur.steps.splice(1,1); save(); renderSteps(); });

  await page.evaluate(() => { cur.reviewDate = "2020-01-01"; cur.status = "active"; save(); });
  await page.waitForTimeout(700); // autosave debounce

  console.log("[2] 永続化: リロード後も残る");
  await page.reload();
  await page.waitForSelector(".mcard");
  const cardTitle = await page.textContent(".mtitle");
  check("一覧にカード表示", cardTitle.includes("テスト点検マニュアル"), cardTitle);
  const overChip = await page.locator(".chip.st-over").count();
  check("期限切れ→要見直しチップ", overChip === 1, "count=" + overChip);

  // 検索フィルタ
  await page.fill("#search", "存在しない設備");
  check("検索：0件で該当なし表示", await page.locator(".mcard").count() === 0 && await page.isVisible("#no-hit"));
  await page.fill("#search", "点検");
  check("検索：ヒットで再表示", await page.locator(".mcard").count() === 1);
  await page.fill("#search", "");

  // 空マニュアルのゴミ掃除（新規→即戻る）
  await page.click("#btn-new");
  await page.waitForSelector("#v-edit:not([hidden])");
  await page.click("#btn-back");
  await page.waitForSelector("#v-home:not([hidden])");
  check("空マニュアルは残らない", await page.locator(".mcard").count() === 1);

  // 未提出の変更チップ（書き出し→クリア、編集→再表示）
  // goHome() は非同期。cur===null になるまで待たないと一覧の再描画前を読んでしまう
  const backToHome = async () => {
    await page.click("#btn-back");
    await page.waitForFunction(() => cur === null);
  };
  await page.click(".mcard");
  await page.waitForSelector("#v-edit:not([hidden])");
  await page.evaluate(() => exportHTML(cur));
  await page.waitForTimeout(300);
  await backToHome();
  const dirtyAfterExport = await page.locator(".chip.st-dirty").count();
  await page.click(".mcard");
  await page.click("details.mgmt summary");
  await page.fill("#m-note", "手順3を修正");
  await page.waitForTimeout(600);
  await backToHome();
  const dirtyAfterEdit = await page.locator(".chip.st-dirty").count();
  check("未提出の変更チップ", dirtyAfterExport === 0 && dirtyAfterEdit === 1,
    `afterExport=${dirtyAfterExport} afterEdit=${dirtyAfterEdit}`);

  console.log("[3] 品質スコア・承認チェック・台帳・教育メモ");
  await page.click(".mcard");
  await page.waitForSelector("#v-edit:not([hidden])");
  await page.click("#d-quality summary");
  const scoreTxt = await page.textContent("#q-score");
  check("品質スコア表示", /\d+ \/ 100/.test(scoreTxt), scoreTxt);
  const scoreBefore = parseInt(scoreTxt, 10);
  await page.check('#d-quality input[data-ap="photoSecurity"]');
  await page.waitForTimeout(100);
  const scoreAfter = parseInt(await page.textContent("#q-score"), 10);
  check("承認チェックでスコア加点", scoreAfter > scoreBefore, `${scoreBefore} -> ${scoreAfter}`);
  await page.fill("#ef-before", "30");
  await page.fill("#ef-after", "10");
  await page.fill("#ef-count", "20");
  await page.waitForTimeout(700);
  const savedVal = await page.inputValue("#ef-saved");
  check("月間削減見込みの自動計算", savedVal === "6.7 h/月", savedVal);
  const csvHead = await page.evaluate(() => ledgerCsv(cur).slice(0, 200));
  check("台帳CSV（BOM+品質列）", csvHead.charCodeAt(0) === 0xFEFF && csvHead.includes("qualityScore"), csvHead.slice(0, 60));

  // 作業指示書（Copilotジェネレーター）の【撮影】ブロック取込
  const shotTxt = [
    "# 返品エリア 環境整備",
    "今日やること：返品エリアの棚を整備し、写真で記録する",
    "1. □ 棚Bの床の物をカゴに移す（5分）",
    "【撮影】No.02 ／ 対象：棚Bの全景 ／ ファイル名：02_棚B.jpg",
    "　　　　合格条件：床に物が置かれていない状態",
    "2. □ 棚Aのラベルを手前に向ける（10分）",
    "【撮影】No.01 ／ 対象：棚Aのラベル ／ ファイル名：01_ラベル.jpg",
    "合格条件：ラベルの文字が読めること",
  ].join("\n");
  const shot = await page.evaluate(t => {
    const a = parseImport(t, "shiji.md");
    if (a.length !== 1) return null;
    const m = a[0];
    return { n: m.steps.length, title: m.title,
      t1: m.steps[0].title, d1: m.steps[0].edu && m.steps[0].edu.done, f1: m.steps[0].desc };
  }, shotTxt);
  check("作業指示書の撮影ブロック取込（No順・合格条件→完了条件）",
    !!shot && shot.n === 2 && shot.t1 === "棚Aのラベル"
    && shot.d1 === "ラベルの文字が読めること" && shot.f1.includes("01_ラベル.jpg")
    && shot.title.includes("返品エリア"),
    JSON.stringify(shot));
  await page.click(".step details.edu summary");
  await page.fill('.step [data-edu="done"]', "ランプが緑点灯した状態");
  await page.waitForTimeout(700);

  console.log("[4] 書き出しHTML(ビューア)");
  const html = await page.evaluate(() => buildDoc(cur));
  check("書き出しに教育メモと品質を埋め込み", html.includes("完了条件") && html.includes("品質・改善効果"));
  const rt = await page.evaluate(h => { const a = parseImport(h); return a.length === 1 ? a[0].title : ""; }, html);
  check("再取り込み(ラウンドトリップ)", rt === "テスト点検マニュアル", "got=" + rt);
  const rtExt = await page.evaluate(h => {
    const a = parseImport(h);
    return { edu: a[0].steps[0].edu ? a[0].steps[0].edu.done : "", ap: !!a[0].ext.approval.photoSecurity };
  }, html);
  check("再取り込みで教育メモ・承認チェック保持", rtExt.edu === "ランプが緑点灯した状態" && rtExt.ap, JSON.stringify(rtExt));

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

  check("ビューアに品質セクション", await v.locator(".q-sec").count() === 1);
  check("ビューアに完了条件表示", (await v.textContent(".edu-row.ok")).includes("ランプが緑点灯"));
  await v.click("#v-genba");
  const gTitle = await v.textContent("#g-title");
  check("現場モードで手順表示", gTitle === "電源スイッチ確認", gTitle);
  check("現場モードに完了条件表示", await v.isVisible("#g-done"));
  await v.click("#g-next"); // 1手順のみ→完了で閉じる
  check("現場モード完了で閉じる", await v.isHidden("#genba"));

  await v.click("#v-fb");
  await v.fill("#fb-text", "バルブが電動化されている");
  await v.click("#fb-add");
  const fbCount = await v.locator("#fb-list li:not(.fb-empty)").count();
  check("フィードバック追加", fbCount === 1, "count=" + fbCount);
  await v.click("#fb-close");

  // 写真タップで拡大（ライトボックス）
  await v.click("img[data-p]");
  check("写真タップで拡大表示", await v.isVisible("#lb"));
  await v.click("#lb");
  check("拡大を閉じる", await v.isHidden("#lb"));

  // 点検記録コピー
  await v.fill("#ck-name", "山田");
  await v.click("#ck-copy");
  await v.waitForTimeout(300);
  const ckBtnTxt = await v.textContent("#ck-copy");
  check("点検記録コピー", ckBtnTxt.includes("コピーしました"), ckBtnTxt);

  check("エディタ側 JSエラーなし", errs.length === 0, errs.join(" | "));
  check("ビューア側 JSエラーなし", verrs.length === 0, verrs.join(" | "));

  await browser.close();
  fs.unlinkSync(viewerPath);
  console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURE(S)");
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
