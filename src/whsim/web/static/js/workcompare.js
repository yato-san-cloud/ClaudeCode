// workcompare.js — ⑤提案「作業方法比較」: シングル/マルチ/ゾーン/トータル を実行比較.
// deep-research の指針: 全方式は「移動 vs 仕分け」のトレードオフの一点。4プリセットを
// SimPyで実行し、①横並びKPI（シングルオーダーをベースラインにデルタ）②移動vs仕分けの散布図
// （x=移動/件, y=仕分/件, バブル=¥/件）③注文プロファイルからの推奨、を出す。
// バックエンド: POST /workmethod/compare（純: whsim.workmethod + scenario runner）。
// 「この方式で設計」で選んだ方式をモデルのピッキング工程に反映。EN comments / JA UI.
import { esc, api } from './util.js';
import * as echarts from 'echarts';
import { startRunProgress } from './progress.js';

const fmt = (n, d = 0) => (n == null || isNaN(n) ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));
const yen = (n) => (n == null || isNaN(n) ? '—' : '¥' + Math.round(n).toLocaleString('ja-JP'));
const pctStr = (g) => (g == null ? '' : (g >= 0 ? '+' : '') + Math.round(g * 100) + '%');
const reduceMotion = () => matchMedia('(prefers-reduced-motion:reduce)').matches;
function tok(name, fb) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fb;
}
const COLORS = { discrete: '#16C0DE', multi: '#2ee6a0', zone: '#9b6bff', total: '#f5b05a' };

function injectStyle() {
  if (document.getElementById('wc-style')) return;
  const s = document.createElement('style');
  s.id = 'wc-style';
  s.textContent = `
  #workcompare.panel{overflow:auto}
  .wc{display:flex;flex-direction:column;gap:16px;max-width:1120px;margin:0 auto;width:100%;
    padding:8px 2px 40px;color:var(--ink-primary);font-family:var(--font-sans)}
  .wc-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  .wc-head h2{font-size:var(--fs-title,17px);margin:0}
  .wc-head .sub{font-size:var(--fs-sm,12.5px);color:var(--ink-secondary)}
  .wc-run{margin-left:auto;padding:9px 18px;border:none;border-radius:10px;cursor:pointer;
    background:var(--accent);color:var(--ink-onAccent,#04222c);font:inherit;font-weight:700}
  .wc-run:hover{background:var(--accent-hover)} .wc-run:disabled{opacity:.55;cursor:wait}
  .wc-rec{padding:11px 15px;border:1px solid var(--accent);border-left:4px solid var(--accent);
    border-radius:12px;background:var(--accent-tint,rgba(22,192,222,.06));font-size:13px}
  .wc-rec b{color:var(--accent-ink,var(--accent))}
  .wc-ec{width:100%;height:320px}
  .wc-tbl{width:100%;border-collapse:collapse;font-size:var(--fs-sm,12.5px)}
  .wc-tbl th,.wc-tbl td{padding:8px 10px;border-bottom:1px solid var(--line-hair);text-align:right;white-space:nowrap}
  .wc-tbl th:first-child,.wc-tbl td:first-child{text-align:left}
  .wc-tbl th{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary);font-weight:700}
  .wc-tbl .num{font-family:var(--font-mono)}
  .wc-tbl tr.rec td{background:var(--accent-tint,rgba(22,192,222,.08))}
  .wc-sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:middle}
  .wc-d-up{color:#34c97a;font-size:11px} .wc-d-dn{color:var(--warn,#f5b05a);font-size:11px}
  .wc-adopt{padding:5px 12px;border-radius:8px;border:1px solid var(--accent);background:transparent;
    color:var(--accent);font:inherit;font-weight:700;font-size:12px;cursor:pointer}
  .wc-adopt:hover{background:var(--accent-tint-2,rgba(22,192,222,.14))}
  .wc-empty{padding:40px;text-align:center;color:var(--ink-tertiary)}
  .wc-note{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary)}
  .wc-sweep-btn{padding:9px 16px;border:1px solid var(--accent);border-radius:10px;cursor:pointer;
    background:transparent;color:var(--accent);font:inherit;font-weight:700}
  .wc-sweep-btn:hover{background:var(--accent-tint,rgba(22,192,222,.1))} .wc-sweep-btn:disabled{opacity:.55;cursor:wait}
  .wc-sweep{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--line-hair);
    border-radius:12px;background:var(--surface-1,rgba(127,127,127,.04))}
  .wc-sweep h3{margin:0;font-size:var(--fs-sm,13px)}
  .wc-sweep .meta{font-size:var(--fs-micro,10.5px);color:var(--ink-secondary)}
  .wc-sweep tr.best td{background:var(--accent-tint,rgba(22,192,222,.1));font-weight:600}
  .wc-badge-ng{color:var(--warn,#f5b05a);font-weight:700}
  .wc-badge-ok{color:#34c97a;font-weight:700}
  `;
  document.head.appendChild(s);
}

export function mountWorkCompare(el, opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const toast = opts.toast || (() => {});
  const root = document.createElement('div');
  root.className = 'wc';
  el.innerHTML = '';
  el.appendChild(root);

  let chart = null;
  let ro = null;
  let data = null;
  let running = false;
  let sweepData = null;   // last 自動掃引 (mini-OptQuest) result
  let sweeping = false;
  // The analytic recommendation handed over from ③設計「生産性試算」(pickrate).
  // We highlight it and, after the DES run, reconcile 解析推奨 vs DES推奨.
  let analyticPick = null;   // {id, label}
  function disposeChart() { if (chart) { try { chart.dispose(); } catch (_) { /* noop */ } chart = null; } }

  async function run() {
    const name = getProject();
    if (!name) { toast('先にプロジェクトを選択してください。', 'error'); return; }
    if (running) return;
    running = true;
    renderRunning();
    const prog = startRunProgress({ getProject: () => name,
      onCancel: () => api(`/api/projects/${encodeURIComponent(name)}/run/cancel`, { method: 'POST' }).catch(() => {}),
      title: '4方式をDESで比較実行中…', sub: 'シングルオーダー・マルチオーダー・ゾーン（リレー）・トータルをそれぞれ回して移動vs仕分けを実測します。' });
    try {
      data = await api(`/api/projects/${encodeURIComponent(name)}/workmethod/compare`, { method: 'POST' });
      if (data && data.cancelled) {
        prog.stop('cancelled');
        root.innerHTML = headHtml() + '<div class="wc-empty">比較を中止しました。</div>';
        wireHead();
        return;
      }
      render();
    } catch (e) {
      data = null;
      root.innerHTML = headHtml() + `<div class="wc-empty">比較の実行に失敗しました：${esc(e && e.message ? e.message : e)}</div>`;
      wireHead();
    } finally { running = false; prog.stop(); }
  }

  function headHtml() {
    return `<div class="wc-head"><h2>作業方法比較</h2>
      <span class="sub">シングル / マルチ / ゾーン / トータル を実行して「移動 vs 仕分け」で比べる</span>
      <button type="button" class="wc-sweep-btn" data-sweep${sweeping ? ' disabled' : ''}>${sweeping ? '掃引中…' : '⚡ 自動掃引（解析）'}</button>
      <button type="button" class="wc-run" data-run${running ? ' disabled' : ''}>${running ? '比較を実行中…' : '▶ 4方式を比較実行'}</button></div>`;
  }
  function wireHead() {
    const b = root.querySelector('[data-run]');
    if (b) b.onclick = () => run();
    const s = root.querySelector('[data-sweep]');
    if (s) s.onclick = () => runSweep();
  }
  function renderRunning() {
    disposeChart();
    root.innerHTML = headHtml() + '<div class="wc-empty">4方式をSimPyで実行中… （シングル／マルチ／ゾーン／トータル）</div>';
    wireHead();
  }

  function render() {
    disposeChart();
    const d = data || {};
    const methods = d.methods || [];
    if (!methods.length) {
      const ap = analyticPick
        ? `<div class="wc-rec">解析（生産性試算）の推奨は <b>${esc(analyticPick.label)}</b>。`
          + `「▶ 4方式を比較実行」でDESを回し、移動/仕分け以外（混雑・待ち）も含めて裏取りします。</div>`
        : '';
      root.innerHTML = headHtml() + ap + sweepHtml()
        + '<div class="wc-empty">「▶ 4方式を比較実行」を押すと、各方式を実行して比較します。</div>';
      wireHead(); wireSweep(); return;
    }
    const rec = d.recommend || {};
    const recRow = (m) => (m.id === rec.id);
    // baton reconciliation: did the heavyweight DES agree with the fast analytic?
    let reconcile = '';
    if (analyticPick && rec.id) {
      const agree = analyticPick.id === rec.id;
      const desName = (methods.find((m) => m.id === rec.id) || {}).label || rec.name || rec.id;
      reconcile = `<div class="wc-rec" style="border-left-color:${agree ? 'var(--accent)' : 'var(--warn,#f5b05a)'}">`
        + `解析（生産性試算）の推奨：<b>${esc(analyticPick.label)}</b> → DES検証の推奨：<b>${esc(desName)}</b>`
        + `　<b>${agree ? '✓ 一致（裏取りOK）' : '⚠ 不一致 — 移動/仕分け以外（混雑・待ち）が効いています'}</b></div>`;
    }
    root.innerHTML = headHtml()
      + reconcile
      + (rec.name ? `<div class="wc-rec">注文プロファイルからの推奨：<b>${esc(rec.name)}</b> — ${esc(rec.reason || '')}</div>` : '')
      + '<div class="wc-ec" data-ec></div>'
      + '<table class="wc-tbl"><thead><tr>'
      + '<th>作業方法</th><th>¥/件</th><th>処理(件/時)</th><th>人員</th><th>稼働率</th>'
      + '<th>移動/件(m)</th><th>仕分/件(s)</th><th>採用</th></tr></thead><tbody>'
      + methods.map((m) => {
        const k = m.kpis; const dl = m.delta || {};
        const dcost = m.id === d.baseline_id ? '<span class="wc-note">基準</span>'
          : `<span class="${dl.cost_per_order <= 0 ? 'wc-d-up' : 'wc-d-dn'}">${pctStr(dl.cost_per_order)}</span>`;
        const apTag = (analyticPick && analyticPick.id === m.id)
          ? ' <span class="wc-note" style="color:var(--accent);font-weight:700">解析推奨</span>' : '';
        return `<tr class="${recRow(m) ? 'rec' : ''}">`
          + `<td><span class="wc-sw" style="background:${COLORS[m.id] || '#888'}"></span>${esc(m.label)}${apTag}</td>`
          + `<td class="num">${m.currency || '¥'}${fmt(k.cost_per_order, 1)} ${dcost}</td>`
          + `<td class="num">${fmt(k.throughput_per_hr, 0)}</td>`
          + `<td class="num">${fmt(k.headcount)}名</td>`
          + `<td class="num">${fmt(k.picker_utilization * 100)}%</td>`
          + `<td class="num">${fmt(m.travel_per_order_m, 0)}</td>`
          + `<td class="num">${fmt(m.sort_per_order_s, 1)}</td>`
          + `<td><button type="button" class="wc-adopt" data-adopt="${esc(m.id)}">この方式で設計 →</button></td>`
          + '</tr>';
      }).join('')
      + '</tbody></table>'
      + '<div class="wc-note">※ 散布図：左下ほど移動・仕分けが少ない。トータルは移動最小だが仕分け工数が立つ＝トレードオフ。'
      + '「この方式で設計」でモデルのピッキング工程に反映し、再実行・原価へ繋がります。</div>'
      + sweepHtml();
    buildScatter(root.querySelector('[data-ec]'), methods, rec.id);
    wireHead();
    wireSweep();
    root.querySelectorAll('[data-adopt]').forEach((b) => { b.onclick = () => adopt(b.dataset.adopt); });
  }

  // ⚡自動掃引（ミニOptQuest）: sweep 作業方式×人員数×まとめ数 analytically and rank.
  // POST /sweep is near-instant (analytic evaluators), so we don't use the DES
  // progress overlay — just a lightweight inline state.
  async function runSweep() {
    const name = getProject();
    if (!name) { toast('先にプロジェクトを選択してください。', 'error'); return; }
    if (sweeping) return;
    sweeping = true;
    render();
    try {
      const res = await api(`/api/projects/${encodeURIComponent(name)}/sweep`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      sweepData = res;
    } catch (e) {
      sweepData = { available: false, reason: (e && e.message ? e.message : String(e)) };
    } finally { sweeping = false; render(); }
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
    root.querySelectorAll('[data-sweep-adopt]').forEach((b) => {
      b.onclick = () => adoptSweep(parseInt(b.dataset.sweepAdopt, 10));
    });
  }

  // 採用: reuse the same /apply dotted-path seam as adopt(), applying the winning
  // combo's method (pick stage work, with its orders_per_trip) AND — when the model
  // exposes a picker worker group — its picker count in one atomic edit.
  async function adoptSweep(rank) {
    const name = getProject();
    const d = sweepData;
    const r = (d && d.rows || []).find((x) => x.rank === rank);
    if (!name || !r) return;
    const base = WORK_PRESETS[r.method_id];
    if (!base) { toast('方式が見つかりません。', 'error'); return; }
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
      await api(`/api/projects/${encodeURIComponent(name)}/apply`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ edits }) });
      const cntMsg = appliedCount ? `・人員${r.pickers}名` : `（人員は${r.pickers}名目安で手動設定を）`;
      toast(`「${r.method_label}／${r.orders_per_trip}件/巡${cntMsg}」を反映。▶実行（DES）で裏取りしてください。`, 'ok');
    } catch (e) { toast('反映に失敗: ' + (e && e.message ? e.message : e), 'error'); }
  }

  function buildScatter(node, methods, recId) {
    if (!node) return;
    const ink = tok('--ink-secondary', '#52677c');
    const line = tok('--line-hair', 'rgba(120,140,170,.18)');
    const costs = methods.map((m) => m.kpis.cost_per_order || 1);
    const cmin = Math.min(...costs), cmax = Math.max(...costs);
    const bubble = (c) => 18 + (cmax > cmin ? (c - cmin) / (cmax - cmin) : 0) * 34;
    chart = echarts.init(node, null, { renderer: 'canvas' });
    chart.setOption({
      animation: !reduceMotion(),
      grid: { left: 56, right: 24, top: 16, bottom: 48 },
      tooltip: {
        formatter: (p) => {
          const m = p.data.m;
          return `<b>${esc(m.label)}</b><br>移動 ${fmt(m.travel_per_order_m, 0)} m/件`
            + `<br>仕分 ${fmt(m.sort_per_order_s, 1)} s/件<br>¥/件 ${fmt(m.kpis.cost_per_order, 1)}`;
        },
      },
      xAxis: { name: '移動/件 (m)  →多い', nameLocation: 'middle', nameGap: 28,
        nameTextStyle: { color: ink }, axisLabel: { color: ink },
        splitLine: { lineStyle: { color: line } } },
      yAxis: { name: '仕分/件 (s)  →多い', nameLocation: 'middle', nameGap: 38,
        nameTextStyle: { color: ink }, axisLabel: { color: ink },
        splitLine: { lineStyle: { color: line } } },
      series: [{
        type: 'scatter',
        data: methods.map((m) => ({
          value: [m.travel_per_order_m, m.sort_per_order_s], m,
          symbolSize: bubble(m.kpis.cost_per_order || 1),
          itemStyle: { color: COLORS[m.id] || '#888',
            borderColor: m.id === recId ? '#fff' : 'transparent', borderWidth: m.id === recId ? 2 : 0,
            opacity: 0.85 },
          label: { show: true, position: 'right', formatter: m.label, color: ink, fontSize: 11 },
        })),
      }],
    }, true);
    if (typeof ResizeObserver !== 'undefined') {
      ro = ro || new ResizeObserver(() => { try { chart && chart.resize(); } catch (_e) { /* noop */ } });
      ro.observe(node);
    }
  }

  // この方式で設計: write the chosen preset's work axes onto the pick stage via the
  // dotted-path apply endpoint, so the model's ピッキング工程 becomes that method.
  async function adopt(mid) {
    const name = getProject();
    const m = (data && data.methods || []).find((x) => x.id === mid);
    if (!name || !m) return;
    try {
      // Resolve the pick stage index from the model so the edit path is correct.
      const model = await api(`/api/projects/${encodeURIComponent(name)}/model`);
      // /model returns headline fields; fall back to index 2 (pick) — the apply
      // endpoint is tolerant and skips a bad path, so this never corrupts data.
      const presets = WORK_PRESETS;
      const work = presets[mid];
      if (!work) { toast('方式が見つかりません。', 'error'); return; }
      const edits = {}; edits['process.stages.2.work'] = work;
      await api(`/api/projects/${encodeURIComponent(name)}/apply`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ edits }) });
      toast(`「${m.label}」をピッキング工程に反映しました。実行で効果を確認できます。`, 'ok');
      void model;
    } catch (e) { toast('反映に失敗: ' + (e && e.message ? e.message : e), 'error'); }
  }

  const onTheme = () => { if (data) render(); };
  document.addEventListener('themechange', onTheme);
  render();   // initial empty state with the run button

  return {
    refresh() { /* keep last result across revisits */ },
    // baton from ③設計「生産性試算」: highlight that method and, if not yet run,
    // auto-start the DES comparison so 解析→DES is one click.
    setAnalyticPick(pick) {
      analyticPick = pick && pick.id ? pick : null;
      if (analyticPick && !data && !running) { run(); return; }
      render();
    },
    dispose() {
      document.removeEventListener('themechange', onTheme);
      if (ro) { ro.disconnect(); ro = null; }
      disposeChart();
      el.innerHTML = '';
    },
  };
}

// 5-axis presets mirrored from whsim.workmethod.METHOD_PRESETS (for 採用 write-back).
const WORK_PRESETS = {
  discrete: { orders_per_trip: 1, zoning: 'none', consolidation: 'pick', release: 'continuous' },
  multi: { orders_per_trip: 8, zoning: 'none', consolidation: 'pick', release: 'continuous' },
  zone: { orders_per_trip: 4, zoning: 'parallel', consolidation: 'pick', release: 'continuous' },
  total: { orders_per_trip: 16, zoning: 'none', consolidation: 'sort', release: 'continuous' },
};
