#!/usr/bin/env node
// usage: node spec/validate.js src/units/unit01.js [more files...]
// ユニットファイルが SCHEMA.md(v5) の規則に従うか機械チェックする。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const TRACKS = ["overview", "basic", "advanced", "tips", "practice-basic", "practice-adv"];
const TYPE_REQUIRED_TRACKS = ["basic", "advanced", "practice-basic", "practice-adv"];

let totalErrs = 0;

function validateFile(file) {
  const errs = [];
  const src = fs.readFileSync(file, "utf8");
  const base = path.basename(file, ".js"); // unitNN

  if (src.toLowerCase().includes("</scr" + "ipt")) errs.push("文字列中に </scr" + "ipt を含む(禁止)");

  const ctx = { window: {} };
  vm.createContext(ctx);
  try {
    vm.runInContext(src, ctx);
  } catch (e) {
    console.error(`[${base}] 構文/実行エラー: ${e.message}`);
    totalErrs++;
    return;
  }
  const units = (ctx.window.DOJO_UNITS || []);
  if (units.length !== 1) errs.push(`DOJO_UNITSへのpushがちょうど1件であること(現在${units.length}件)`);
  const u = units[0] || {};

  if (u.id !== base) errs.push(`id "${u.id}" がファイル名 "${base}" と不一致`);
  if (typeof u.no !== "number" || u.no < 1 || u.no > 30) errs.push("no は1〜30の数値");
  if (!TRACKS.includes(u.track)) errs.push(`track は ${TRACKS.join("|")} のいずれか(現在: ${u.track})`);
  if (!u.icon) errs.push("icon がない");
  if (!u.name) errs.push("name がない");
  if (!/^#[0-9a-fA-F]{6}$/.test(u.color || "")) errs.push("color は #rrggbb 形式");
  if (!u.desc) errs.push("desc がない");
  if (!Array.isArray(u.lessons) || u.lessons.length < 4 || u.lessons.length > 6)
    errs.push(`lessons は4〜6件(現在${(u.lessons || []).length}件)`);

  const typeRequired = TYPE_REQUIRED_TRACKS.includes(u.track) && u.no >= 2 && u.intro !== true;

  (u.lessons || []).forEach((l, li) => {
    const at = `lesson[${li}] "${(l.title || "").slice(0, 20)}"`;
    if (!l.title) errs.push(`${at}: title がない`);
    if (!l.doc || typeof l.doc !== "string") errs.push(`${at}: doc がない`);
    else {
      if (!l.doc.includes("<pre")) errs.push(`${at}: doc に <pre> コード例がない`);
      if (l.doc.length < 300) errs.push(`${at}: doc が短すぎる(${l.doc.length}字)`);
    }
    const exs = l.exercises || [];
    if (exs.length < 4 || exs.length > 6) errs.push(`${at}: exercises は4〜6問(現在${exs.length}問)`);
    let fills = 0, types = 0;
    exs.forEach((x, xi) => {
      const xat = `${at} ex[${xi}](${x.type})`;
      if (!x.e || x.e.length < 20) errs.push(`${xat}: 解説 e が20文字未満`);
      if (!x.q) errs.push(`${xat}: q がない`);
      if (x.type === "mc") {
        if (!Array.isArray(x.c) || x.c.length !== 4) errs.push(`${xat}: c は4択`);
        else if (new Set(x.c).size !== 4) errs.push(`${xat}: 選択肢に重複`);
        if (!Number.isInteger(x.a) || x.a < 0 || x.a > 3) errs.push(`${xat}: a は0〜3`);
        if (x.code && !x.lang) errs.push(`${xat}: code があるのに lang がない`);
      } else if (x.type === "fill") {
        fills++;
        if (!["m", "dax"].includes(x.lang)) errs.push(`${xat}: lang は m|dax`);
        const slots = [...(x.code || "").matchAll(/【(\d+)】/g)].map(m => +m[1]);
        const uniq = [...new Set(slots)].sort((a, b) => a - b);
        if (slots.length === 0) errs.push(`${xat}: code に【n】スロットがない`);
        if (uniq.some((v, i) => v !== i)) errs.push(`${xat}: スロット番号が0からの連番でない`);
        if (!Array.isArray(x.answers) || x.answers.length !== uniq.length)
          errs.push(`${xat}: answers の数(${(x.answers || []).length})がスロット数(${uniq.length})と不一致`);
        if (!Array.isArray(x.bank)) errs.push(`${xat}: bank がない`);
        else {
          if (new Set(x.bank).size !== x.bank.length) errs.push(`${xat}: bank に重複トークン`);
          const used = new Set(x.answers || []);
          if (x.bank.length < used.size + 2) errs.push(`${xat}: bank はダミー2個以上必要(現在${x.bank.length}個/使用${used.size}個)`);
          (x.answers || []).forEach(a => {
            if (!Number.isInteger(a) || a < 0 || a >= x.bank.length) errs.push(`${xat}: answers に不正index ${a}`);
          });
        }
      } else if (x.type === "type") {
        types++;
        if (!["m", "dax"].includes(x.lang)) errs.push(`${xat}: lang は m|dax`);
        if (!x.answer || x.answer.length < 5) errs.push(`${xat}: answer がない/短すぎ`);
        if (x.scaffold && !x.answer.startsWith(x.scaffold.trimEnd().slice(0, 3)))
          errs.push(`${xat}: answer が scaffold を含む全文になっていない可能性`);
        if (!x.hint) errs.push(`${xat}: hint がない`);
        if (x.answer && x.answer.split("\n").length > 6) errs.push(`${xat}: answer が長すぎる(6行超)`);
      } else {
        errs.push(`${xat}: 不明なtype "${x.type}"`);
      }
    });
    if (fills < 1) errs.push(`${at}: fill が1問以上必要`);
    if (typeRequired && types < 1) errs.push(`${at}: このトラック(${u.track})のユニットは type が1問以上必要`);
  });
  if (u.final === true && u.lessons && u.lessons.length) {
    const last = u.lessons[u.lessons.length - 1];
    const t = (last.exercises || []).filter(x => x.type === "type").length;
    if (t < 2) errs.push("卒業試験(最終レッスン)は type 2問以上");
    if ((last.exercises || []).length < 6) errs.push("卒業試験は6問");
  }

  if (errs.length) {
    console.error(`[${base}] NG (${errs.length}件):`);
    errs.forEach(e => console.error("  - " + e));
    totalErrs += errs.length;
  } else {
    const nq = u.lessons.reduce((n, l) => n + l.exercises.length, 0);
    console.log(`[${base}] OK: track=${u.track} no=${u.no} ${u.lessons.length} lessons, ${nq} exercises`);
  }
}

const files = process.argv.slice(2);
if (!files.length) { console.error("usage: node spec/validate.js <unit files...>"); process.exit(2); }
files.forEach(validateFile);
process.exit(totalErrs ? 1 : 0);
