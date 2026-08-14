/*
 * Copilot 365 エージェント「作業計画プランナー」出力契約テスト
 * 実行: node tests/copilot-agent-contract.js
 *
 * docs/copilot-planner-agent.md の指示どおりにエージェントが出力した想定の
 * サンプル（指示書.md / 骨格JSON）が、index.html の取り込み（parseImport）で
 * 正しく骨格マニュアルになることを検証する。
 * ラベル語（対象／ファイル名／合格条件）と JSON キー名は凍結契約
 * （docs/rk-interface-spec.md §7）。この形式を変えるとここが落ちる。
 */
const fs = require("fs");
const path = require("path");

let pw;
try { pw = require("playwright"); }
catch (e) { pw = require("/opt/node22/lib/node_modules/playwright"); }

const CHROMIUM =
  process.env.SMOKE_CHROMIUM ||
  (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

const EDITOR = "file://" + path.resolve(__dirname, "..", "index.html");

/* ---- エージェントの想定出力①：作業指示書（第1部＋撮影ブロック） ---- */
const AGENT_SHEET = `# 作業指示書：プレス2号機まわりの安全通路を確保する

今日やること：プレス2号機まわりの安全通路を確保する（完了状態：白線内に物がなく通路幅80cmが確保されている状態）
場所：第1工場 プレスエリア ／ 対象：プレス2号機の周囲通路 ／ 想定時間：約45分

準備するもの：
・軍手
・台車
・ウエス

1. □ 作業前の通路の状態を撮影（2分）
   [完了の見た目] 通路全体が1枚に収まった写真がある状態
   【撮影】No.01 ／ 対象：プレス2号機周囲の通路全景（作業前） ／ ファイル名：01_通路全景作業前.jpg
   　　　　合格条件：白線と通路全体が1枚に写っていること

2. □ ［本日必達］白線内の資材を台車で仮置き場へ移す（15分）
   [完了の見た目] 白線の内側に資材が1つも置かれていない状態

3. □ 通路の油汚れをウエスで拭き取る（10分）
   [完了の見た目] 目視で油のテカリが見えない状態

4. □ 作業後の通路を撮影（3分）
   [完了の見た目] 作業前と同じ位置から撮った写真がある状態
   【撮影】No.02 ／ 対象：プレス2号機周囲の通路全景（作業後） ／ ファイル名：02_通路全景作業後.jpg
   　　　　合格条件：白線内に物が写っていないこと

5. □ 写真2枚と結果を報告する（5分）
   [完了の見た目] 作業前後の写真2枚が送付済みの状態

■ 終わったら：田中職長に、撮影した写真とチェック結果を送る
■ 困ったとき：10分手が止まったら、田中職長に「◯番で止まっています」と伝える
■ 帰る前に：［本日必達］が残っている場合は、退勤前に田中職長の確認を受ける
`;

/* ---- エージェントの想定出力②：骨格マニュアルJSON（第3部） ---- */
const AGENT_JSON = JSON.stringify({
  title: "プレス2号機まわりの安全通路を確保する",
  place: "第1工場 プレスエリア",
  tools: "軍手、台車、ウエス",
  note: "Copilotエージェント「作業計画プランナー」から生成",
  status: "draft",
  steps: [
    { type: "step",  title: "作業前の通路の状態を撮影", desc: "指定ファイル名：01_通路全景作業前.jpg",
      edu: { time: "2分", done: "通路全体が1枚に収まった写真がある状態", mistake: "", escalate: "" } },
    { type: "step",  title: "白線内の資材を台車で仮置き場へ移す", desc: "",
      edu: { time: "15分", done: "白線の内側に資材が1つも置かれていない状態", mistake: "重量物を手で運ぶ", escalate: "10分止まったら田中職長へ" } },
    { type: "step",  title: "通路の油汚れをウエスで拭き取る", desc: "",
      edu: { time: "10分", done: "目視で油のテカリが見えない状態", mistake: "", escalate: "" } },
    { type: "check", title: "作業後の通路を撮影", desc: "指定ファイル名：02_通路全景作業後.jpg",
      edu: { time: "3分", done: "作業前と同じ位置から撮った写真がある状態", mistake: "", escalate: "" } },
    { type: "step",  title: "写真2枚と結果を報告する", desc: "",
      edu: { time: "5分", done: "作業前後の写真2枚が送付済みの状態", mistake: "", escalate: "" } },
  ],
}, null, 2);

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "  ok " : "  NG ") + name + (ok ? "" : "  <- " + detail));
  if (!ok) failures++;
}

(async () => {
  console.log("[1] 契約書式の静的チェック（RK/parseShotBlocksと同じ読み方）");
  const shotRe = /【撮影】No\.(\d+)\s*[／\/]\s*対象：(.+?)\s*[／\/]\s*ファイル名：(\S+)/g;
  const shots = [...AGENT_SHEET.matchAll(shotRe)];
  check("【撮影】ブロックが2件以上", shots.length >= 2, String(shots.length));
  check("No.が01から連番", shots.map(m => +m[1]).join(",") === "1,2", shots.map(m => m[1]).join(","));
  check("ファイル名が「連番_内容.jpg」形式", shots.every(m => /^\d{2}_.+\.jpg$/.test(m[3])),
    shots.map(m => m[3]).join(","));
  check("合格条件行が撮影ブロックと同数",
    (AGENT_SHEET.match(/合格条件：/g) || []).length === shots.length);
  check("禁止語（適宜・必要に応じて・状況を見て）を含まない",
    !/適宜|必要に応じて|状況を見て/.test(AGENT_SHEET));
  check("末尾3欄（終わったら・困ったとき・帰る前に）",
    ["■ 終わったら", "■ 困ったとき", "■ 帰る前に"].every(s => AGENT_SHEET.includes(s)));

  console.log("[2] index.html への取り込み（ラウンドトリップ）");
  const browser = await pw.chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const p = await (await browser.newContext()).newPage();
  const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  await p.goto(EDITOR);
  await p.waitForSelector("#v-home:not([hidden])");

  const viaMd = await p.evaluate(t => {
    const a = parseImport(t, "指示書_安全通路.md");
    return a.length === 1 ? {
      n: a[0].steps.length, title: a[0].title,
      t1: a[0].steps[0].title, done1: a[0].steps[0].edu && a[0].steps[0].edu.done,
      desc1: a[0].steps[0].desc,
    } : null;
  }, AGENT_SHEET);
  check("指示書.md → 取り込み成功", !!viaMd, "parseImportが空");
  check("  タイトル＝今日やること", !!viaMd && viaMd.title.includes("安全通路"), viaMd && viaMd.title);
  check("  対象→手順タイトル", !!viaMd && viaMd.t1.includes("通路全景（作業前）"), viaMd && viaMd.t1);
  check("  合格条件→edu.done", !!viaMd && !!viaMd.done1 && viaMd.done1.includes("白線"), viaMd && viaMd.done1);
  check("  ファイル名→説明欄", !!viaMd && viaMd.desc1.includes("01_通路全景作業前.jpg"), viaMd && viaMd.desc1);

  const viaJson = await p.evaluate(t => {
    const a = parseImport(t, "骨格_安全通路.json");
    return a.length === 1 ? {
      n: a[0].steps.length, title: a[0].title, status: a[0].status,
      types: a[0].steps.map(s => s.type).join(","),
      edu2: a[0].steps[1].edu, tools: a[0].tools,
    } : null;
  }, AGENT_JSON);
  check("骨格JSON → 取り込み成功", !!viaJson && viaJson.n === 5, viaJson && String(viaJson.n));
  check("  手順タイプ保持（step/check）", !!viaJson && viaJson.types === "step,step,step,check,step",
    viaJson && viaJson.types);
  check("  教育メモ4項目保持", !!viaJson && viaJson.edu2 &&
    !!viaJson.edu2.time && !!viaJson.edu2.done && !!viaJson.edu2.mistake && !!viaJson.edu2.escalate,
    viaJson && JSON.stringify(viaJson.edu2));
  check("  準備物・状態（draft）保持", !!viaJson && viaJson.tools.includes("台車") && viaJson.status === "draft");
  check("editor側 JSエラーなし", errs.length === 0, errs.join(" | "));

  await browser.close();
  console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURE(S)");
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
