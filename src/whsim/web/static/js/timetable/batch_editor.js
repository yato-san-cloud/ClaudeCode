// timetable/batch_editor.js — バッチ投入スケジュール editor for the analytic
// staffing solver. Extracted verbatim from timetable.js (facade precedent:
// designer/*.js). It reads/writes the live solver state and its element ref off
// the shared `ctx`, and re-solves through `ctx.runSolver`, so behaviour is
// unchanged from the previous inline closure.
//
// The day's volume for a section lands in batches at given hours; this is how a
// batch operation actually releases work (e.g. 入荷 朝70%/昼20%/夕10%). Per section
// a 便数 stepper adds/removes batches and each batch is a SLIDER whose ratios
// auto-rebalance to 100% (drag one up, the others give way). The solver gates the
// section's first process to what has landed by each hour.
import { el } from './dom.js';

// Sections that can carry a batch-release schedule (入荷=arrivals, 出荷=order cutoffs).
export const BATCH_SECTIONS = ['入荷', '出荷'];
// Presets the planner can one-click instead of typing rows.
const BATCH_PRESETS = {
  入荷: { 'なし（随時）': [], '昼1便': [{ hour: 12, pct: 100 }],
    '朝70/昼20/夕10': [{ hour: 8, pct: 70 }, { hour: 12, pct: 20 }, { hour: 15, pct: 10 }] },
  出荷: { 'なし（随時）': [], '夕締め1便': [{ hour: 16, pct: 100 }],
    '昼40/夕60': [{ hour: 11, pct: 40 }, { hour: 16, pct: 60 }] },
};

export function createBatchEditor(ctx) {
  const { solverState } = ctx;
  let batchSolveTimer = 0;

  // Distribute so the batch at `idx` becomes `val`% and the rest share (100-val)%
  // in proportion to their current weights (equal share when they're all zero).
  function rebalance(rows, idx, val) {
    const n = rows.length;
    if (!n) return;
    val = Math.max(0, Math.min(100, Math.round(val)));
    if (n === 1) { rows[0].pct = 100; return; }
    rows[idx].pct = val;
    const others = rows.map((_, i) => i).filter((i) => i !== idx);
    const rest = 100 - val;
    const otherSum = others.reduce((a, i) => a + (Number(rows[i].pct) || 0), 0);
    others.forEach((i) => {
      rows[i].pct = otherSum > 0 ? (rows[i].pct / otherSum) * rest : rest / others.length;
    });
    // integer round, then distribute the residual across the OTHER bars one unit at
    // a time (never below 0) so Σ stays EXACTLY 100 even when the largest other bar
    // is smaller than the drift.
    rows.forEach((r) => { r.pct = Math.round(r.pct); });
    let drift = 100 - rows.reduce((a, r) => a + r.pct, 0);
    const ring = [...others].sort((a, b) => rows[b].pct - rows[a].pct);
    let guard = 0;
    while (drift !== 0 && ring.length && guard < 1000) {
      const i = ring[guard % ring.length];
      if (drift > 0) { rows[i].pct += 1; drift -= 1; }
      else if (rows[i].pct > 0) { rows[i].pct -= 1; drift += 1; }
      guard += 1;
    }
  }
  function equalSplit(rows) {
    const n = rows.length;
    if (!n) return;
    const base = Math.floor(100 / n);
    rows.forEach((r) => { r.pct = base; });
    rows[0].pct += 100 - base * n;   // residual onto the first
  }
  function suggestHour(rows) {
    const s = solverState.start, e = Math.max(s + 1, Math.min(24, solverState.end));
    if (!rows.length) return s;
    const step = Math.max(1, Math.round((e - s) / (rows.length + 1)));
    return Math.min(e - 1, (Math.max(...rows.map((r) => r.hour)) || s) + step);
  }
  function setBatchCount(sec, n) {
    const rows = solverState.batches[sec] ? [...solverState.batches[sec]] : [];
    n = Math.max(0, Math.min(8, n));
    while (rows.length < n) rows.push({ hour: suggestHour(rows), pct: 0 });
    while (rows.length > n) rows.pop();
    if (n === 0) delete solverState.batches[sec];
    else { equalSplit(rows); solverState.batches[sec] = rows; }
    renderBatchEditor(); ctx.runSolver();
  }

  function renderBatchEditor() {
    if (!ctx.elSolverBatches) return;
    ctx.elSolverBatches.innerHTML = '';
    ctx.elSolverBatches.appendChild(el('div', 'tt-solver-deps-title',
      'バッチ投入スケジュール（便数を増減、スライダーで比率を調整＝自動で合計100%。空＝随時）'));
    for (const sec of BATCH_SECTIONS) {
      const rows = solverState.batches[sec] || [];
      const block = el('div', 'tt-batch-block');
      const head = el('div', 'tt-batch-head');
      head.appendChild(el('span', 'tt-batch-sec', sec));
      // 便数 stepper
      const step = el('span', 'tt-batch-step');
      const minus = el('button', 'tt-batch-stepbtn', '−'); minus.title = '便を減らす';
      minus.onclick = () => setBatchCount(sec, rows.length - 1);
      const count = el('span', 'tt-batch-count', `${rows.length}便`);
      const plus = el('button', 'tt-batch-stepbtn', '＋'); plus.title = '便を増やす';
      plus.onclick = () => setBatchCount(sec, rows.length + 1);
      step.appendChild(minus); step.appendChild(count); step.appendChild(plus);
      head.appendChild(step);
      // presets
      const presets = el('span', 'tt-solver-presets');
      for (const [label, def] of Object.entries(BATCH_PRESETS[sec] || {})) {
        const chip = el('button', 'tt-chip', label);
        chip.onclick = () => {
          solverState.batches[sec] = def.map((d) => ({ ...d }));
          if (!solverState.batches[sec].length) delete solverState.batches[sec];
          renderBatchEditor(); ctx.runSolver();
        };
        presets.appendChild(chip);
      }
      head.appendChild(presets);
      block.appendChild(head);

      // slider rows (hour + range + live %). Dragging one rebalances the others.
      const grid = el('div', 'tt-batch-grid');
      const sliders = []; const pcts = [];
      rows.forEach((r, i) => {
        const row = el('div', 'tt-batch-srow');
        const hIn = el('input', 'tt-mini'); hIn.type = 'number'; hIn.min = '0'; hIn.max = '30';
        hIn.value = String(r.hour); hIn.setAttribute('aria-label', `${sec} 便${i + 1} 時刻`);
        hIn.oninput = () => { r.hour = parseInt(hIn.value, 10) || 0; scheduleBatchSolve(); };
        const slider = el('input', 'tt-batch-slider'); slider.type = 'range';
        slider.min = '0'; slider.max = '100'; slider.step = '1'; slider.value = String(r.pct);
        slider.setAttribute('aria-label', `${sec} 便${i + 1} 割合`);
        const pct = el('span', 'tt-batch-pct', `${Math.round(r.pct)}%`);
        slider.oninput = () => {
          rebalance(rows, i, parseFloat(slider.value) || 0);
          sliders.forEach((s, k) => { s.value = String(rows[k].pct); });
          pcts.forEach((p, k) => { p.textContent = `${rows[k].pct}%`; });
          scheduleBatchSolve();
        };
        const del = el('button', 'tt-batch-del', '×'); del.title = 'この便を削除';
        del.onclick = () => {
          rows.splice(i, 1);
          if (!rows.length) delete solverState.batches[sec];
          else { equalSplit(rows); solverState.batches[sec] = rows; }
          renderBatchEditor(); ctx.runSolver();
        };
        row.appendChild(el('span', 'tt-batch-blabel', `便${i + 1}`));
        row.appendChild(hIn); row.appendChild(el('span', 'tt-batch-x', '時'));
        row.appendChild(slider); row.appendChild(pct); row.appendChild(del);
        sliders.push(slider); pcts.push(pct);
        grid.appendChild(row);
      });
      block.appendChild(grid);
      if (!rows.length) {
        block.appendChild(el('div', 'tt-batch-note', '随時（バッチなし）。＋で便を追加すると比率を割り当てられます。'));
      }
      ctx.elSolverBatches.appendChild(block);
    }
  }
  function scheduleBatchSolve() {
    if (batchSolveTimer) clearTimeout(batchSolveTimer);
    batchSolveTimer = setTimeout(ctx.runSolver, ctx.DEBOUNCE_MS);
  }

  return { renderBatchEditor };
}
