// ステージのヘッドレス検証。
//   node tools/verify.mjs
// 各ステージについて
//   - solution の手順でクリアできること
//   - traps の手順でちゃんと失敗すること
// を実際に物理シミュレーションを回して確かめる。乱数は決定論的なので結果は再現する。

import { Sand, LAVA, GOLD } from '../src/sand.js';
import { LEVELS, GRID_W, GRID_H } from '../src/levels.js';

const SETTLE = 30; // 「落ち着いた」とみなす連続静止ティック数
const MAX_TICKS = 20000;

function count(sand, type) {
  let n = 0;
  for (let i = 0; i < sand.cells.length; i++) if (sand.cells[i] === type) n++;
  return n;
}

function run(level, steps) {
  const sand = new Sand(GRID_W, GRID_H);
  sand.build(level);

  let si = 0;
  let waited = 0;
  const log = [];

  for (let t = 0; t < MAX_TICKS; t++) {
    if (si < steps.length) {
      const s = steps[si];
      const ready = s.wait === 'settle' ? sand.idle >= SETTLE : waited >= s.wait;
      if (ready) {
        sand.pull(s.pin);
        log.push(`t=${t} ピン${s.pin}を抜く (溶岩残 ${count(sand, LAVA)} / 宝残 ${sand.goldLeft})`);
        si++;
        waited = 0;
      } else {
        waited++;
      }
    }

    sand.step();

    if (sand.dead) return { result: 'dead', t, sand, log };
    if (sand.won) return { result: 'won', t, sand, log };
    if (si >= steps.length && sand.idle >= SETTLE * 3) break;
  }

  const result = sand.won ? 'won' : sand.dead ? 'dead' : 'stuck';
  return { result, t: sand.tick, sand, log };
}

let failures = 0;
const verbose = process.argv.includes('-v');

for (const level of LEVELS) {
  console.log(`\n=== ステージ${level.id} 「${level.name}」 (目標 ${level.need}) ===`);

  const sol = run(level, level.solution);
  const ok = sol.result === 'won';
  console.log(
    `  ${ok ? 'OK  ' : 'NG  '}解法: ${sol.result} / 回収 ${sol.sand.collected} / ` +
      `残り宝 ${sol.sand.goldLeft} / 溶岩残 ${count(sol.sand, LAVA)} / ${sol.t}ティック`
  );
  if (!ok || verbose) sol.log.forEach((l) => console.log(`        ${l}`));
  if (!ok) failures++;

  // 解法は目標に届いた瞬間に止まるので、それだけでは余裕が分からない。
  // 目標を無限にして最後まで回し、回収上限に何割の余裕があるかを見る。
  // 余裕が無いと、プレイヤーが別の正しい順番で解いたときに数個足りず理不尽になる。
  const cap = run({ ...level, need: Infinity }, level.solution).sand.collected;
  const slack = cap - level.need;
  const enough = slack >= Math.max(10, level.need * 0.1);
  console.log(`  ${enough ? 'OK  ' : 'NG  '}回収上限 ${cap} (目標+${slack})`);
  if (!enough) failures++;

  for (const trap of level.traps) {
    const r = run(level, trap.steps);
    // 罠は「死ぬ」か「宝が足りず詰む」のどちらかで失敗すべき。クリアできてしまったら罠になっていない。
    const trapped = r.result !== 'won';
    console.log(`  ${trapped ? 'OK  ' : 'NG  '}罠 (${trap.label}): ${r.result} / 回収 ${r.sand.collected}`);
    if (!trapped || verbose) r.log.forEach((l) => console.log(`        ${l}`));
    if (!trapped) failures++;
  }
}

console.log(failures === 0 ? '\n全ステージ検証OK' : `\n${failures} 件の問題あり`);
process.exit(failures === 0 ? 0 : 1);
