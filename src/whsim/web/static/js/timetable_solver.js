// timetable_solver.js — browser-side mirror of whsim.timetable (Python).
//
// Volume-flow-constrained staffing solver, ported 1:1 from the standalone
// timetable_solver.html v1.1 and kept byte-for-byte equivalent to the Python
// `whsim/timetable.py` (a parity test runs both on the seed data and compares).
// Pure, framework-free ES module: the タイムチャート tab re-solves entirely
// client-side as sliders move, so live recalc has zero round-trip latency.
//
// The DATA contract keeps the documented Japanese keys (配置方式/依存/篁採用値/
// 物量/制約…); the solve RESULT uses English keys (see solve()).

export const SLOT_MINUTES = 30;
export const DAY_END_MINUTES = 1800; // 30:00 — logistics days run past midnight

export const SECTION_COLOR = {
  '入荷': '#fbbf24',
  // Non-accent indigo/violet so the cyan brand accent stays the sole accent
  // across stacked-area / legend / matrix / dots (was brand-blue #3b82f6).
  '出荷ケース': '#7C6CF0',
  '出荷バラ': '#10b981',
  'ステージング': '#f97316',
  '間接': '#6b7280',
};
// Section → whsim layout zone type (ZONE_JP keys); 間接 has no warehouse zone.
export const SECTION_ZONE_TYPE = {
  '入荷': 'receiving',
  '出荷ケース': 'storage',
  '出荷バラ': 'picking',
  'ステージング': 'staging',
  '間接': 'office',
};

export function timeToMin(s) {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
}
export function minToTime(m) {
  const h = Math.floor(m / 60);
  const mm = Math.floor(m % 60);
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}
export function generateSlots() {
  const slots = [];
  for (let m = 0; m < DAY_END_MINUTES; m += SLOT_MINUTES) slots.push(m);
  return slots;
}

export function topologicalSort(processes) {
  const sorted = [];
  const visited = new Set();
  const procMap = Object.fromEntries(processes.map((p) => [p.id, p]));
  function visit(p) {
    if (visited.has(p.id)) return;
    visited.add(p.id);
    for (const dep of (p['依存'] || [])) {
      const depProc = procMap[dep];
      if (depProc) visit(depProc);
    }
    sorted.push(p);
  }
  for (const p of processes) visit(p);
  return sorted;
}

// Round to match Python's f"{x:.0f}" (round-half-to-even) for warning text only.
function fmt0(x) {
  const r = Math.round(x);
  if (Math.abs(x - Math.trunc(x) - 0.5) < 1e-9) {
    const fl = Math.floor(x);
    return (fl % 2 === 0 ? fl : fl + 1).toString();
  }
  return r.toString();
}

export function solve(scenario, processes, productivity) {
  const slots = generateSlots();
  const nSlots = slots.length;
  const result = {
    slots,
    processes: [],
    headcount_by_slot: new Array(nSlots).fill(0),
    total_required_hours: 0,
    total_assigned_hours: 0,
    warnings: [],
  };

  const sortedProcesses = topologicalSort(processes);
  const cumulativeMap = {};
  const volumes = (scenario && scenario['物量']) || {};

  for (const proc of sortedProcesses) {
    const prod = productivity[proc.productivity_key];
    if (!prod) {
      result.warnings.push(`生産性マスタに ${proc.productivity_key} がない (工程: ${proc.id})`);
      continue;
    }

    const hasVolume = proc.volume_key != null && !prod.fixed_hours;
    let mode = proc['配置方式'] || (hasVolume ? 'dynamic' : 'fixed_n');
    if (mode === 'dynamic' && !hasVolume) {
      result.warnings.push(`${proc.id}: 物量定義がないため「固定人数」モードに自動切替`);
      mode = 'fixed_n';
    }
    const targetVolume = hasVolume ? (volumes[proc.volume_key] || 0) : null;
    const rate = hasVolume ? prod['篁採用値'] : null;

    const start = timeToMin(proc['default_時間帯'][0]);
    const end = timeToMin(proc['default_時間帯'][1]);
    const bandHours = (end - start) / 60;
    const fixedCount = proc['固定人数'] || 1;

    let requiredHours;
    if (mode === 'fixed_n') requiredHours = fixedCount * bandHours;
    else requiredHours = targetVolume / rate;

    const headcounts = new Array(nSlots).fill(0);
    const cumulative = new Array(nSlots + 1).fill(0);

    if (mode === 'fixed_n') {
      const n = fixedCount;
      let cum = 0;
      for (let i = 0; i < nSlots; i++) {
        const t = slots[i];
        if (t >= start && t < end) {
          headcounts[i] = n;
          if (hasVolume) cum += n * rate * 0.5;
        }
        cumulative[i + 1] = cum;
      }
      if (hasVolume && targetVolume > 0 && cum < targetVolume * 0.99) {
        result.warnings.push(`${proc.id} [固定人数]: 物量未達 (目標${fmt0(targetVolume)} → 配置${fmt0(cum)}、達成率${fmt0(cum / targetVolume * 100)}%)`);
      } else if (hasVolume && targetVolume > 0 && cum > targetVolume * 1.1) {
        result.warnings.push(`${proc.id} [固定人数]: 物量過剰 (目標${fmt0(targetVolume)} → 配置${fmt0(cum)}、達成率${fmt0(cum / targetVolume * 100)}%) ← 人数を減らせます`);
      }
    } else {
      let cum = 0;
      for (let i = 0; i < nSlots; i++) {
        const t = slots[i];
        if (t < start || t >= end) { cumulative[i + 1] = cum; continue; }
        const remaining = targetVolume - cum;
        if (remaining <= 0) { cumulative[i + 1] = cum; continue; }
        const remainingH = ((end - t) / 30) * 0.5;
        let need = Math.max(1, Math.ceil(remaining / rate / remainingH));

        const deps = proc['依存'] || [];
        if (deps.length > 0) {
          let maxDepThroughput = Infinity;
          for (const depId of deps) {
            const depCumArr = cumulativeMap[depId];
            if (!depCumArr) continue;
            const depCum = depCumArr[i + 1];
            const dep = sortedProcesses.find((p) => p.id === depId);
            if (!dep) continue;
            const depProd = productivity[dep.productivity_key] || {};
            const depHasVolume = dep.volume_key != null && !depProd.fixed_hours;
            if (!depHasVolume) continue;
            const depTarget = volumes[dep.volume_key] || 1;
            const progress = depCum / depTarget;
            const ownPossibleCum = progress * targetVolume;
            const ownPossibleInput = Math.max(0, ownPossibleCum - cum);
            if (ownPossibleInput < maxDepThroughput) maxDepThroughput = ownPossibleInput;
          }
          if (maxDepThroughput < Infinity) {
            const maxPossible = Math.floor(maxDepThroughput / rate / 0.5);
            need = Math.min(need, maxPossible);
            if (need < 0) need = 0;
          }
        }
        headcounts[i] = need;
        cum += need * rate * 0.5;
        cumulative[i + 1] = cum;
      }
      if (cum < targetVolume * 0.99) {
        result.warnings.push(`${proc.id} [動的]: 物量未達 (目標${fmt0(targetVolume)} → 配置${fmt0(cum)}、達成率${fmt0(cum / targetVolume * 100)}%)。作業帯/依存制約を確認`);
      }
    }

    const assignedHours = headcounts.reduce((a, b) => a + b, 0) * 0.5;
    const achievedVolume = hasVolume ? cumulative[cumulative.length - 1] : null;

    result.processes.push({
      id: proc.id,
      section: proc.section,
      worker_type: proc.worker_type,
      mode,
      fixed_count: fixedCount,
      deps: proc['依存'] || [],
      target_volume: targetVolume,
      productivity: rate,
      unit: prod['単位'],
      required_hours: requiredHours,
      peak: Math.max(...headcounts),
      assigned_hours: assignedHours,
      achieved_volume: achievedVolume,
      diff: assignedHours - requiredHours,
      headcounts,
      cumulative,
      band: [proc['default_時間帯'][0], proc['default_時間帯'][1]],
    });
    headcounts.forEach((n, i) => { result.headcount_by_slot[i] += n; });
    result.total_required_hours += requiredHours;
    result.total_assigned_hours += assignedHours;
    cumulativeMap[proc.id] = cumulative;
  }

  const constraints = (scenario && scenario['制約']) || {};
  const cap = constraints['ピーク人数上限'];
  if (cap) {
    const mx = Math.max(...result.headcount_by_slot);
    if (mx > cap) {
      const idx = result.headcount_by_slot.indexOf(mx);
      result.warnings.push(`総人数ピーク ${mx}名 が上限 ${cap}名 を超過 (${minToTime(slots[idx])}〜)`);
    }
  }

  result.peak_headcount = Math.max(...result.headcount_by_slot);
  result.peak_slot_index = result.headcount_by_slot.indexOf(result.peak_headcount);

  const workerTypes = [...new Set(processes.map((p) => p.worker_type))];
  const byWorker = {};
  for (const w of workerTypes) byWorker[w] = { by_slot: new Array(nSlots).fill(0), total_hours: 0, peak: 0 };
  for (const r of result.processes) {
    if (!byWorker[r.worker_type]) continue;
    r.headcounts.forEach((n, i) => { byWorker[r.worker_type].by_slot[i] += n; });
    byWorker[r.worker_type].total_hours += r.assigned_hours;
  }
  for (const w of workerTypes) byWorker[w].peak = Math.max(...byWorker[w].by_slot);
  result.by_worker_type = byWorker;

  const order = Object.fromEntries(processes.map((p, i) => [p.id, i]));
  result.processes.sort((a, b) => (order[a.id] ?? 1e6) - (order[b.id] ?? 1e6));
  return result;
}

export default solve;
