// workcompare/sweep_panel.js — ⚡自動掃引（ミニOptQuest）panel for 作業方法比較.
// Extracted verbatim from workcompare.js (facade precedent: designer/*.js). The
// sweep owns its own state (last result + running flag); it renders into the same
// single innerHTML pass as the facade (facade concatenates `sweepHtml()` and calls
// `wireSweep()`), and re-renders the whole panel through `ctx.rerender`. Shared
// formatting vocabulary (fmt/yen/COLORS/WORK_PRESETS) and opts (getProject/toast/
// root) come in through `ctx`, so behaviour is unchanged.
//
// sweep 作業方式×人員数×まとめ数 analytically and rank. POST /sweep is near-instant
// (analytic evaluators), so we don't use the DES progress overlay — just a
// lightweight inline state.
import { esc, api } from '../util.js';
import { applyEdits } from '../adopt.js';

export function createSweepPanel(ctx) {
  const { fmt, yen, COLORS, WORK_PRESETS } = ctx;
  let sweepData = null;   // last 自動掃引 (mini-OptQuest) result
  let sweeping = false;

  async function runSweep() {
    const name = ctx.getProject();
    if (!name) { ctx.toast('先にプロジェクトを選択してください。', 'error'); return; }
    if (sweeping) return;
    sweeping = true;
    ctx.rerender();
    try {
      const res = await api(`/api/projects/${encodeURIComponent(name)}/sweep`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      sweepData = res;
    } catch (e) {
      sweepData = { available: false, reason: (e && e.message ? e.message : String(e)) };
    } finally { sweeping = false; ctx.rerender(); }
  }

  function sweepHtml() {
    const d = sweepData;
    if (!d) return '';
    if (!d.available) {
      return `<div class="wc-sweep"><h3>⚡ 自動掃引（解析）</h3>`
        + `<div class="wc-note">${esc(d.reason || '物量データがありません。①取込/②分析で出荷実績を取り込んでください。')}</div></div>`;
    }
    const rows = (d.rows || []).slice(0, 10);
    const win = d.window || {};
    const noPickerSeam = (d.picker_worker_index == null);
    const meta = `${fmt(d.evaluated)}通りを解析評価`
      + (d.truncated ? '（打ち切り）' : '')
      + `・${fmt(d.elapsed_s, 2)}秒・現行 ${fmt(d.current_pickers)}名`
      + (win.start_hour != null ? `・稼働 ${win.start_hour}–${win.end_hour}時` : '');
    return `<div class="wc-sweep">
      <h3>⚡ 自動掃引（解析）— 上位10案</h3>
      <div class="meta">${esc(d.objective || '')}</div>
      <div class="meta">${esc(meta)}</div>
      <div style="overflow-x:auto"><table class="wc-tbl"><thead><tr>
        <th>#</th><th>作業方法</th><th>まとめ</th><th>人員</th><th>可否</th>
        <th>時間(h)</th><th>ピーク</th><th>月次コスト</th><th>¥/件</th><th>採用</th>
      </tr></thead><tbody>`
      + rows.map((r) => `<tr class="${r.rank === 1 ? 'best' : ''}">`
        + `<td>${fmt(r.rank)}</td>`
        + `<td><span class="wc-sw" style="background:${COLORS[r.method_id] || '#888'}"></span>${esc(r.method_label)}</td>`
        + `<td class="num">${fmt(r.orders_per_trip)}件/巡</td>`
        + `<td class="num">${fmt(r.pickers)}名</td>`
        + `<td class="${r.feasible ? 'wc-badge-ok' : 'wc-badge-ng'}">${r.feasible ? '可' : '不可'}</td>`
        + `<td class="num">${fmt(r.makespan_hour, 1)}</td>`
        + `<td class="num">${fmt(r.peak)}</td>`
        + `<td class="num">${r.monthly_cost == null ? '—' : yen(r.monthly_cost)}</td>`
        + `<td class="num">¥${fmt(r.cost_per_order, 1)}</td>`
        + `<td><button type="button" class="wc-adopt" data-sweep-adopt="${fmt(r.rank)}">採用 →</button></td>`
        + '</tr>').join('')
      + '</tbody></table></div>'
      + `<div class="wc-note">${esc(d.note || '解析モデルによる即時評価です。上位案は▶実行（DES）で裏取りしてください。')}`
      + (noPickerSeam ? '　※ 人員グループが無いため方式・まとめのみ反映（人員数は表の値を目安に設定してください）。' : '')
      + '</div></div>';
  }

  function wireSweep() {
    ctx.root.querySelectorAll('[data-sweep-adopt]').forEach((b) => {
      b.onclick = () => adoptSweep(parseInt(b.dataset.sweepAdopt, 10));
    });
  }

  // 採用: reuse the same /apply dotted-path seam as adopt(), applying the winning
  // combo's method (pick stage work, with its orders_per_trip) AND — when the model
  // exposes a picker worker group — its picker count in one atomic edit.
  async function adoptSweep(rank) {
    const name = ctx.getProject();
    const d = sweepData;
    const r = (d && d.rows || []).find((x) => x.rank === rank);
    if (!name || !r) return;
    const base = WORK_PRESETS[r.method_id];
    if (!base) { ctx.toast('方式が見つかりません。', 'error'); return; }
    const work = { ...base, orders_per_trip: r.orders_per_trip };
    const edits = {};
    const pidx = (d.pick_stage_index != null) ? d.pick_stage_index : 2;
    edits[`process.stages.${pidx}.work`] = work;
    let appliedCount = false;
    if (d.picker_worker_index != null) {
      edits[`resources.workers.${d.picker_worker_index}.count`] = r.pickers;
      appliedCount = true;
    }
    try {
      // /apply は不正パスを黙って捨てるので、applied/skipped を検証してから成功と言う。
      await applyEdits(name, edits);
      const cntMsg = appliedCount ? `・人員${r.pickers}名` : `（人員は${r.pickers}名目安で手動設定を）`;
      ctx.toast(`「${r.method_label}／${r.orders_per_trip}件/巡${cntMsg}」を反映。▶実行（DES）で裏取りしてください。`, 'ok');
      document.dispatchEvent(new CustomEvent('whsim:model-changed', { detail: {} }));
    } catch (e) { ctx.toast('反映に失敗: ' + (e && e.message ? e.message : e), 'error'); }
  }

  return { runSweep, sweepHtml, wireSweep, isSweeping: () => sweeping };
}
