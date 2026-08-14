#!/usr/bin/env node
// JSエンジン（app/tariff-bancho.html 内 //<engine> ブロック）と
// Python版PoC（poc/tariff_calc.py）の計算結果一致を検証する。
// usage: node app/tests/parity.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- エンジン抽出 ---
const html = fs.readFileSync(path.join(ROOT, "app", "tariff-bancho.html"), "utf-8");
const engineSrc = html.split("//<engine>")[1].split("//</engine>")[0];
const ctx = vm.createContext({});
new vm.Script(engineSrc).runInContext(ctx);

// --- マスタ構築（poc/data のCSVから、アプリの buildDemoState と同じ手順） ---
const readCsv = (f) => ctx.parseTable(fs.readFileSync(path.join(ROOT, "poc", "data", f), "utf-8"));
const zrows = readCsv("zones.csv").slice(1);
const trows = readCsv("tariff.csv").slice(1);
const crows = readCsv("contracts.csv").slice(1);
const carriers = crows.map(([name, disc, vol, fuel, minFare, timedFee]) => {
  const zoneByPref = {};
  zrows.filter(r => r[0] === name).forEach(r => { zoneByPref[r[1]] = r[2]; });
  return {
    name,
    discountRate: parseFloat(disc),
    volumeKgPerM3: parseFloat(vol),
    minFare: Number(minFare),
    timedFee: Number(timedFee),
    surcharges: [{ date: "2020-01-01", rate: parseFloat(fuel) }],
    zoneByPref,
    tariff: trows.filter(r => r[0] === name)
      .map(r => ({ from: r[1], to: r[2], maxKg: Number(r[3]), fare: Number(r[4]) })),
  };
});

// --- ケース生成（決定的） ---
const prefs = ["東京", "大阪", "北海道", "福岡", "沖縄", "愛知", "広島", "宮城", "高知", "埼玉", "京都", "神奈川"];
const combos = [
  { weight: 1, volume: 0, timed: false },
  { weight: 29.9, volume: 0, timed: false },
  { weight: 30.1, volume: 0, timed: true },
  { weight: 80, volume: 0.4, timed: false },
  { weight: 100, volume: 0.3572, timed: false },   // 容積換算の境界近傍
  { weight: 450, volume: 0, timed: true },
  { weight: 2000, volume: 0, timed: false },        // 最上位帯ちょうど
  { weight: 2001, volume: 0, timed: false },        // 帯域超過
  { weight: 0.5, volume: 0, timed: false },         // 最低運賃フロア域
  { weight: 100, volume: 7.15, timed: false },      // 容積で帯域超過
];
const cases = [];
for (const from of prefs) for (const to of prefs) for (const c of combos)
  cases.push({ from, to, ...c });

// --- Python側の結果 ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "parity-"));
const casesPath = path.join(tmp, "cases.json");
fs.writeFileSync(casesPath, JSON.stringify(cases));
const pyOut = execFileSync("python3", [path.join(ROOT, "poc", "export_quotes.py"), casesPath], { encoding: "utf-8" });
const pyResults = JSON.parse(pyOut);

// --- JS側の結果と比較 ---
let mismatches = [];
cases.forEach((cs, i) => {
  for (const carrier of carriers) {
    const js = ctx.quoteCarrier(carrier, {
      fromPref: cs.from, toPref: cs.to, weightKg: cs.weight, volumeM3: cs.volume,
      timed: cs.timed, date: "2026-08-14",
    });
    const py = pyResults[i][carrier.name];
    const jsCmp = { ok: js.ok, total: js.ok ? js.total : null, band: js.ok ? js.band : null, chargeable: js.ok ? js.chargeable : null };
    const same = jsCmp.ok === py.ok
      && (jsCmp.total === py.total)
      && (jsCmp.band === (py.band ?? null))
      && (!jsCmp.ok || Number(jsCmp.chargeable) === Number(py.chargeable));
    if (!same) mismatches.push({ case: cs, carrier: carrier.name, js: jsCmp, py });
  }
});

const totalChecks = cases.length * carriers.length;
if (mismatches.length) {
  console.error(`PARITY FAIL: ${mismatches.length}/${totalChecks} mismatches`);
  console.error(JSON.stringify(mismatches.slice(0, 5), null, 2));
  process.exit(1);
}
console.log(`PARITY OK: ${totalChecks} checks (${cases.length} cases x ${carriers.length} carriers) all match`);
