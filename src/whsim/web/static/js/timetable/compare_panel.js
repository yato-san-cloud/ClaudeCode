// timetable/compare_panel.js — scenario save + compare (作業バッチ/方式) for the
// analytic staffing solver. Extracted verbatim from timetable.js (facade
// precedent: designer/*.js). Reads the live solver window + its element ref off
// the shared `ctx`; opts (getProject/toast) come through ctx.o.
//
// 「💾 この条件をシナリオ保存」 freezes the current window/cap/placement as a named
// scenario; 「🔁 シナリオ比較を更新」 fetches every saved scenario and renders the
// same-volume comparison table with deltas vs the current design.
import { api, esc } from '../util.js';

export function createComparePanel(ctx) {
  const { solverState } = ctx;

  async function saveScenario() {
    const proj = typeof ctx.o.getProject === 'function' ? ctx.o.getProject() : null;
    if (!proj) { (ctx.o.toast || (() => {}))('プロジェクトを開いてください。', 'error'); return; }
    const label = (window.prompt('シナリオ名（例：朝寄せ案 / 夕締め案 / マルチ方式）', '案')
      || '').trim();
    if (!label) return;
    try {
      await api(`/api/projects/${encodeURIComponent(proj)}/scenarios`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      (ctx.o.toast || (() => {}))(`シナリオ「${label}」を保存しました。`, 'ok');
      loadCompare();
    } catch (e) {
      (ctx.o.toast || (() => {}))('保存に失敗: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  async function loadCompare() {
    const proj = typeof ctx.o.getProject === 'function' ? ctx.o.getProject() : null;
    if (!proj || !ctx.elSolverCompare) return;
    ctx.elSolverCompare.innerHTML = '<div class="tt-info">シナリオ比較を計算中…</div>';
    const qs = `start_hour=${solverState.start}&end_hour=${solverState.end}`
      + `&cap=${solverState.cap || 0}&placement=${encodeURIComponent(solverState.placement)}`;
    let data;
    try {
      data = await api(`/api/projects/${encodeURIComponent(proj)}/timetable/compare?${qs}`);
    } catch (e) {
      ctx.elSolverCompare.innerHTML = `<div class="tt-alert"><div class="tt-alert-head">比較に失敗</div><div>${esc(String(e.message || e))}</div></div>`;
      return;
    }
    renderCompare(data);
  }

  function renderCompare(data) {
    if (!data || !Array.isArray(data.rows) || data.rows.length <= 1) {
      ctx.elSolverCompare.innerHTML = '<div class="tt-info">保存シナリオがありません。'
        + '「💾 この条件をシナリオ保存」で 朝寄せ案／夕締め案／マルチ方式 などを保存すると、ここで比較できます。</div>';
      return;
    }
    const base = data.rows[0];
    const num = (v) => (v == null ? '—' : Math.round(Number(v)).toLocaleString());
    const yen = (v) => (v == null ? '—' : '¥' + Math.round(Number(v)).toLocaleString());
    const delta = (v, b) => {
      if (v == null || b == null || v === b) return '';
      const d = v - b; const up = d > 0;
      return `<span class="tt-cmp-d ${up ? 'up' : 'down'}">${up ? '▲' : '▼'}${Math.abs(Math.round(d)).toLocaleString()}</span>`;
    };
    const batchTxt = (bc) => {
      const ks = Object.keys(bc || {});
      return ks.length ? ks.map((k) => `${esc(k)}${bc[k]}便`).join(' ') : '随時';
    };
    let html = '<div class="tt-section-title">シナリオ比較（同じ物量を各設計で／デルタは現在比）</div>';
    html += '<div class="tt-matrix-scroll"><table class="tt-table tt-cmp-tbl"><thead><tr>'
      + '<th class="tt-rowhead">シナリオ</th><th>作業方式</th><th>バッチ</th>'
      + '<th class="tt-num-h">ピーク人数</th><th class="tt-num-h">総工数</th>'
      + '<th class="tt-num-h">終了</th><th class="tt-num-h">人件費/日</th>'
      + '<th class="tt-num-h">月額原価</th></tr></thead><tbody>';
    data.rows.forEach((r, i) => {
      const cur = i === 0;
      html += `<tr class="${cur ? 'tt-cmp-cur' : ''}">`
        + `<th class="tt-rowhead">${esc(r.label)}${r.feasible === false ? ' <span class="tt-cmp-bad">不足</span>' : ''}</th>`
        + `<td>${esc(r.method || '—')}</td>`
        + `<td>${batchTxt(r.batch_counts)}</td>`
        + `<td class="tt-num">${num(r.peak_headcount)}${cur ? '' : delta(r.peak_headcount, base.peak_headcount)}</td>`
        + `<td class="tt-num">${num(r.total_man_hours)}${cur ? '' : delta(r.total_man_hours, base.total_man_hours)}</td>`
        + `<td class="tt-num">${r.makespan_hour == null ? '—' : r.makespan_hour + '時'}</td>`
        + `<td class="tt-num">${yen(r.labour_cost_day)}${cur ? '' : delta(r.labour_cost_day, base.labour_cost_day)}</td>`
        + `<td class="tt-num">${yen(r.monthly_cost)}${cur ? '' : delta(r.monthly_cost, base.monthly_cost)}</td>`
        + '</tr>';
    });
    html += '</tbody></table></div>';
    ctx.elSolverCompare.innerHTML = html;
  }

  return { saveScenario, loadCompare };
}
