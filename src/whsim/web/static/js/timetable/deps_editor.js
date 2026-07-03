// timetable/deps_editor.js — 工程依存 DAG editor for the analytic staffing solver.
// Extracted verbatim from timetable.js (facade precedent: designer/*.js). Reads/
// writes live solver state + its element ref off the shared `ctx`, and re-solves
// through `ctx.runSolver`, so behaviour is unchanged.
//
// Presets (標準フロー / 依存なし) + a compact per-process upstream multi-toggle:
// a downstream process doesn't ramp up until its upstream processes supply work.
import { el } from './dom.js';

export function createDepsEditor(ctx) {
  const { solverState } = ctx;

  function renderDepEditor() {
    if (!ctx.elSolverDeps) return;
    ctx.elSolverDeps.innerHTML = '';
    ctx.elSolverDeps.appendChild(el('div', 'tt-solver-deps-title', '工程依存（前工程が供給するまで後工程は立ち上がらない）'));
    const presets = el('div', 'tt-solver-presets');
    const std = el('button', 'tt-chip', '標準フロー（入荷→格納→…→出荷）');
    std.onclick = () => { solverState.deps = cloneDeps(solverState.defaultDeps); renderDepEditor(); ctx.runSolver(); };
    const none = el('button', 'tt-chip', '依存なし（並列）');
    none.onclick = () => { solverState.deps = {}; renderDepEditor(); ctx.runSolver(); };
    presets.appendChild(std); presets.appendChild(none);
    ctx.elSolverDeps.appendChild(presets);

    const ids = (solverState.processIds && solverState.processIds.length)
      ? solverState.processIds : Object.keys(solverState.defaultDeps);
    const grid = el('div', 'tt-solver-depgrid');
    for (const pid of ids) {
      const row = el('div', 'tt-solver-deprow');
      row.appendChild(el('span', 'tt-solver-depname', pid));
      const ups = el('span', 'tt-solver-depups');
      for (const up of ids) {
        if (up === pid) continue;
        const on = (solverState.deps[pid] || []).includes(up);
        const tag = el('button', 'tt-deptoggle' + (on ? ' on' : ''), up);
        tag.title = on ? `${up} を前工程から外す` : `${up} を前工程に追加`;
        tag.onclick = () => {
          const cur = new Set(solverState.deps[pid] || []);
          if (cur.has(up)) cur.delete(up); else cur.add(up);
          solverState.deps[pid] = [...cur];
          renderDepEditor(); ctx.runSolver();
        };
        ups.appendChild(tag);
      }
      row.appendChild(ups);
      grid.appendChild(row);
    }
    ctx.elSolverDeps.appendChild(grid);
  }
  function cloneDeps(d) { const o = {}; for (const k of Object.keys(d || {})) o[k] = [...(d[k] || [])]; return o; }

  return { renderDepEditor, cloneDeps };
}
