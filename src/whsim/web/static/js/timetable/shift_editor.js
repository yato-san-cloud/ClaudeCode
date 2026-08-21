// timetable/shift_editor.js — シフト・休憩モデル editor for the analytic staffing
// solver. Extracted verbatim from timetable.js (facade precedent: designer/*.js).
// Reads/writes live solver state + its element ref off the shared `ctx`, and
// re-solves through `ctx.runSolver`, so behaviour is unchanged.
//
// 休憩帯 (hours with no work), シフトパターン (named windows with a per-shift max
// 人数 + 時給) and a fallback 既定時給. The solver zeros break hours (volume shifts
// elsewhere), caps each hour's total by Σ max_workers of the covering shifts, and
// prices a 人件費/日 line. Empty plan = legacy behaviour.
import { el } from './dom.js';

// One-click シフト・休憩 presets the planner can drop instead of typing rows.
const SHIFT_PRESETS = {
  'なし': { breaks: [], shifts: [], default_wage_per_hr: 1200 },
  '昼休憩12-13': { breaks: [{ start: 12, end: 13 }], shifts: [], default_wage_per_hr: 1200 },
  '2交代(8-17,17-22)': {
    breaks: [{ start: 12, end: 13 }],
    shifts: [
      { label: '日勤', start: 8, end: 17, max_workers: 20, wage_per_hr: 1200 },
      { label: '遅番', start: 17, end: 22, max_workers: 12, wage_per_hr: 1400 },
    ],
    default_wage_per_hr: 1200,
  },
};

export function createShiftEditor(ctx) {
  const { solverState } = ctx;
  let shiftSolveTimer = 0;

  function shiftDirty() { solverState._seededShift = true; }
  function scheduleShiftSolve() {
    shiftDirty();
    if (shiftSolveTimer) clearTimeout(shiftSolveTimer);
    shiftSolveTimer = setTimeout(ctx.runSolver, ctx.DEBOUNCE_MS);
  }
  function shiftNum(value, min, max, onChange, cls) {
    const inp = el('input', cls || 'tt-mini'); inp.type = 'number';
    inp.min = String(min); inp.max = String(max); inp.value = String(value);
    inp.oninput = () => onChange(parseFloat(inp.value) || 0);
    return inp;
  }

  function renderShiftEditor() {
    if (!ctx.elSolverShift) return;
    const plan = solverState.shiftPlan;
    ctx.elSolverShift.innerHTML = '';
    ctx.elSolverShift.appendChild(el('div', 'tt-solver-deps-title',
      'シフト・休憩（休憩帯は無配置、シフトは時間帯ごとの上限人数と時給。空＝従来どおり）'));

    // Presets.
    const presets = el('div', 'tt-solver-presets');
    for (const [label, def] of Object.entries(SHIFT_PRESETS)) {
      const chip = el('button', 'tt-chip', label);
      chip.onclick = () => {
        solverState.shiftPlan = {
          breaks: (def.breaks || []).map((b) => ({ ...b })),
          shifts: (def.shifts || []).map((s) => ({ ...s })),
          default_wage_per_hr: def.default_wage_per_hr || 1200,
        };
        shiftDirty(); renderShiftEditor(); ctx.runSolver();
      };
      presets.appendChild(chip);
    }
    ctx.elSolverShift.appendChild(presets);

    // 休憩帯 rows.
    const bwrap = el('div', 'tt-batch-block');
    const bhead = el('div', 'tt-batch-head');
    bhead.appendChild(el('span', 'tt-batch-sec', '休憩'));
    const baddBtn = el('button', 'tt-batch-stepbtn', '＋'); baddBtn.title = '休憩帯を追加';
    baddBtn.onclick = () => {
      plan.breaks.push({ start: 12, end: 13 });
      shiftDirty(); renderShiftEditor(); ctx.runSolver();
    };
    bhead.appendChild(baddBtn);
    bwrap.appendChild(bhead);
    (plan.breaks || []).forEach((b, i) => {
      const row = el('div', 'tt-shift-brow');
      row.appendChild(el('span', 'tt-batch-blabel', `休憩${i + 1}`));
      row.appendChild(shiftNum(b.start, 0, 30, (v) => { b.start = v; scheduleShiftSolve(); }));
      row.appendChild(el('span', 'tt-batch-x', '〜'));
      row.appendChild(shiftNum(b.end, 0, 30, (v) => { b.end = v; scheduleShiftSolve(); }));
      row.appendChild(el('span', 'tt-batch-x', '時'));
      const del = el('button', 'tt-batch-del', '×'); del.title = 'この休憩を削除';
      del.onclick = () => { plan.breaks.splice(i, 1); shiftDirty(); renderShiftEditor(); ctx.runSolver(); };
      row.appendChild(del);
      bwrap.appendChild(row);
    });
    if (!(plan.breaks || []).length) {
      bwrap.appendChild(el('div', 'tt-batch-note', '休憩帯なし。＋で 12〜13時 などの休憩を追加できます。'));
    }
    ctx.elSolverShift.appendChild(bwrap);

    // シフトパターン rows.
    const swrap = el('div', 'tt-batch-block');
    const shead = el('div', 'tt-batch-head');
    shead.appendChild(el('span', 'tt-batch-sec', 'シフト'));
    const saddBtn = el('button', 'tt-batch-stepbtn', '＋'); saddBtn.title = 'シフトを追加';
    saddBtn.onclick = () => {
      plan.shifts.push({ label: `シフト${plan.shifts.length + 1}`, start: 9, end: 18,
        max_workers: 20, wage_per_hr: plan.default_wage_per_hr || 1200 });
      shiftDirty(); renderShiftEditor(); ctx.runSolver();
    };
    shead.appendChild(saddBtn);
    swrap.appendChild(shead);
    (plan.shifts || []).forEach((s, i) => {
      const row = el('div', 'tt-shift-srow');
      const lab = el('input', 'tt-mini tt-shift-lab'); lab.type = 'text'; lab.value = s.label || '';
      lab.placeholder = '名称'; lab.setAttribute('aria-label', `シフト${i + 1} 名称`);
      lab.oninput = () => { s.label = lab.value; scheduleShiftSolve(); };
      row.appendChild(lab);
      row.appendChild(shiftNum(s.start, 0, 30, (v) => { s.start = v; scheduleShiftSolve(); }));
      row.appendChild(el('span', 'tt-batch-x', '〜'));
      row.appendChild(shiftNum(s.end, 0, 30, (v) => { s.end = v; scheduleShiftSolve(); }));
      row.appendChild(el('span', 'tt-batch-x', '時'));
      row.appendChild(el('span', 'tt-batch-blabel', '上限'));
      row.appendChild(shiftNum(s.max_workers, 0, 999, (v) => { s.max_workers = v; scheduleShiftSolve(); }));
      row.appendChild(el('span', 'tt-batch-blabel', '¥/時'));
      row.appendChild(shiftNum(s.wage_per_hr, 0, 99999, (v) => { s.wage_per_hr = v; scheduleShiftSolve(); }, 'tt-mini tt-shift-wage'));
      const del = el('button', 'tt-batch-del', '×'); del.title = 'このシフトを削除';
      del.onclick = () => { plan.shifts.splice(i, 1); shiftDirty(); renderShiftEditor(); ctx.runSolver(); };
      row.appendChild(del);
      swrap.appendChild(row);
    });
    if (!(plan.shifts || []).length) {
      swrap.appendChild(el('div', 'tt-batch-note',
        'シフトなし＝人数無制限（従来）。＋で 早番/遅番 などを追加すると各時間帯に上限人数がかかります。'));
    }
    ctx.elSolverShift.appendChild(swrap);

    // 既定時給 (wage outside any shift band).
    const wrow = el('div', 'tt-shift-brow');
    wrow.appendChild(el('span', 'tt-batch-blabel', '既定時給 ¥/時'));
    wrow.appendChild(shiftNum(plan.default_wage_per_hr, 0, 99999,
      (v) => { plan.default_wage_per_hr = v; scheduleShiftSolve(); }, 'tt-mini tt-shift-wage'));
    ctx.elSolverShift.appendChild(wrow);
  }

  // The plan to send: omit it until the user has touched it (so a saved plan stands).
  function currentShiftPlan() {
    const plan = solverState.shiftPlan || {};
    return {
      breaks: (plan.breaks || []).map((b) => ({ start: b.start, end: b.end })),
      shifts: (plan.shifts || []).map((s) => ({
        label: s.label || '', start: s.start, end: s.end,
        max_workers: s.max_workers, wage_per_hr: s.wage_per_hr,
      })),
      default_wage_per_hr: plan.default_wage_per_hr || 0,
    };
  }

  return { renderShiftEditor, currentShiftPlan };
}
