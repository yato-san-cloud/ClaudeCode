// cost.js — ⑤提案「原価試算」: 解析的な原価積み上げ (御社の試算フロー 6費目).
// 物量→工数→原価を、人件費単価・坪単価・台車単価…のつまみで即時に再計算して見せる。
// すべての金額に「物量 × 単価 = ¥」の式を併記（御社ツール同様の透明性）。値はサーバの
// 純関数 whsim.cost が返す（GET /cost に単価をクエリ）。保存は PUT /settings に永続化。
// 「爆速・透明」レーン — シミュレーション実行は不要。EN comments / JA UI.
import { esc, api } from './util.js';
import * as echarts from 'echarts';

const fmt = (n, d = 0) => (n == null || isNaN(n) ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));
const yen = (n) => (n == null || isNaN(n) ? '—' : '¥' + Math.round(n).toLocaleString('ja-JP'));
const reduceMotion = () => matchMedia('(prefers-reduced-motion:reduce)').matches;
function tok(name, fb) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fb;
}

// 単価フィールド (mirror whsim.schema Settings / whsim.cost params). step/suffix
// drive the number inputs; `def` is the JP-market default.
const FIELDS = [
  { key: 'labor_cost_per_hour', label: '人件費単価', def: 2000, step: 50, unit: '円/人時' },
  { key: 'fixed_labor_per_month', label: '固定人件費(管理者等)', def: 0, step: 50000, unit: '円/月' },
  { key: 'tsubo_rate_per_month', label: '保管坪単価', def: 4300, step: 100, unit: '円/坪月' },
  { key: 'delivery_cost_per_cage', label: '配送単価', def: 0, step: 50, unit: '円/カゴ台車' },
  { key: 'system_cost_per_month', label: 'システム費', def: 0, step: 50000, unit: '円/月' },
  { key: 'overhead_rate', label: '運営費率', def: 0, step: 0.01, unit: '比率(0.05=5%)' },
  { key: 'working_days_per_month', label: '稼働日数', def: 22, step: 1, unit: '日/月' },
];
const CAT_COLOR = ['#16C0DE', '#2ee6a0', '#f5b05a', '#9b6bff', '#8895a8'];

function injectStyle() {
  if (document.getElementById('co-style')) return;
  const s = document.createElement('style');
  s.id = 'co-style';
  s.textContent = `
  #cost.panel{overflow:auto}
  .co{display:flex;flex-direction:column;gap:16px;max-width:1120px;margin:0 auto;width:100%;
    padding:8px 2px 40px;color:var(--ink-primary);font-family:var(--font-sans)}
  .co-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  .co-head h2{font-size:var(--fs-title,17px);margin:0}
  .co-head .sub{font-size:var(--fs-sm,12.5px);color:var(--ink-secondary)}
  .co-bench{margin-left:auto;font:inherit;font-size:12px;padding:6px 10px;border-radius:8px;
    border:1px solid var(--line-strong,rgba(120,140,170,.4));background:var(--bg-app);color:var(--ink-primary)}
  .co-hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
  .co-card{padding:12px 16px;border:1px solid var(--line-hair);border-radius:12px;background:var(--bg-sunken)}
  .co-card.hero{border-left:4px solid var(--accent);background:var(--accent-tint,rgba(22,192,222,.06))}
  .co-card .l{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary)}
  .co-card .v{font-family:var(--font-mono);font-size:21px;font-weight:700;white-space:nowrap}
  .co-card .d{font-family:var(--font-mono);font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary)}
  /* 単価 settings */
  .co-knobs{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;padding:12px 16px;
    border:1px solid var(--line-hair);border-radius:12px;background:var(--bg-panel)}
  .co-knob{display:flex;flex-direction:column;gap:3px;min-width:140px}
  .co-knob label{font-size:var(--fs-micro,10.5px);color:var(--ink-secondary)}
  .co-knob input{width:100%;font:inherit;font-family:var(--font-mono);padding:6px 8px;border-radius:8px;
    border:1px solid var(--line-strong,rgba(120,140,170,.4));background:var(--bg-app);color:var(--ink-primary)}
  .co-knob .u{font-size:9px;color:var(--ink-tertiary)}
  .co-save{align-self:center;font-family:var(--font-mono);font-size:var(--fs-sm,12px);
    border:1px solid var(--accent);border-radius:10px;background:var(--accent);color:var(--ink-onAccent,#04222c);
    font-weight:700;padding:8px 16px;cursor:pointer}
  .co-save:hover{background:var(--accent-hover)} .co-save:disabled{opacity:.55;cursor:wait}
  .co-reset{align-self:center;font-family:var(--font-mono);font-size:var(--fs-micro);color:var(--ink-secondary);
    border:1px solid var(--line-strong);border-radius:8px;background:transparent;padding:6px 12px;cursor:pointer}
  /* 6費目 breakdown table */
  .co-tbl{width:100%;border-collapse:collapse;font-size:var(--fs-sm,12.5px)}
  .co-tbl th,.co-tbl td{padding:8px 10px;border-bottom:1px solid var(--line-hair);text-align:left;vertical-align:top}
  .co-tbl th{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary);font-weight:700}
  .co-tbl .num{font-family:var(--font-mono);text-align:right;white-space:nowrap}
  .co-tbl .formula{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary);font-family:var(--font-mono)}
  .co-tbl tr.total td{border-top:2px solid var(--line-strong);font-weight:700;font-size:14px}
  .co-tbl tr.zero td{opacity:.5}
  .co-sec{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary);margin:2px 0}
  .co-ec{width:100%;height:230px}
  .co-empty{padding:40px;text-align:center;color:var(--ink-tertiary)}
  .co-note{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary)}
  `;
  document.head.appendChild(s);
}

export function mountCost(el, opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const toast = opts.toast || (() => {});
  const root = document.createElement('div');
  root.className = 'co';
  el.innerHTML = '';
  el.appendChild(root);

  let chart = null;
  let ro = null;
  let data = null;
  let debounce = 0;
  const knob = {};
  FIELDS.forEach((f) => { knob[f.key] = f.def; });
  let seeded = false;       // pull saved settings once to seed the inputs
  let benchmarks = [];      // 物流形態ライブラリ (一覧, fetched once)
  let curBench = '';        // applied benchmark id

  function disposeChart() { if (chart) { try { chart.dispose(); } catch (_) { /* noop */ } chart = null; } }

  async function seed() {
    if (seeded) return;
    seeded = true;
    const name = getProject();
    if (!name) return;
    try {
      const s = await api(`/api/projects/${encodeURIComponent(name)}/settings`);
      FIELDS.forEach((f) => { if (s && s[f.key] != null) knob[f.key] = Number(s[f.key]); });
      curBench = (s && s.benchmark_id) || '';
    } catch (_e) { /* defaults are fine */ }
    try {
      const r = await api('/api/benchmarks');
      benchmarks = (r && r.benchmarks) || [];
    } catch (_e) { benchmarks = []; }
  }

  // Apply a 物流形態プリセット (想定生産性＋計画値) then refetch the cost.
  async function applyBench(bid) {
    const name = getProject();
    if (!name || !bid) { curBench = ''; load(); return; }
    try {
      const r = await api(`/api/projects/${encodeURIComponent(name)}/benchmark/${encodeURIComponent(bid)}/apply`,
        { method: 'POST' });
      if (r && r.ok) {
        curBench = bid;
        if (r.planning && r.planning.tsubo_rate_per_month != null) {
          knob.tsubo_rate_per_month = Number(r.planning.tsubo_rate_per_month);
        }
        toast(r.message || 'ベンチマークを適用しました。', 'ok');
      }
    } catch (e) { toast('適用に失敗: ' + (e && e.message ? e.message : e), 'error'); }
    load();
  }

  async function load() {
    const name = getProject();
    if (!name) { renderEmpty('プロジェクトを選択してください。'); return; }
    const qs = FIELDS.map((f) => `${f.key}=${encodeURIComponent(knob[f.key])}`).join('&');
    try {
      data = await api(`/api/projects/${encodeURIComponent(name)}/cost?${qs}`);
      render();
    } catch (e) {
      renderEmpty('読み込めませんでした：' + (e && e.message ? e.message : e));
    }
  }
  function onKnob() { if (debounce) clearTimeout(debounce); debounce = setTimeout(load, 200); }

  function renderEmpty(msg) {
    disposeChart();
    root.innerHTML = `<div class="co-head"><h2>原価試算（試算フロー 6費目）</h2>
      <span class="sub">物量 → 工数 → 原価を解析的に積み上げ（実行不要）</span></div>
      <div class="co-empty">${esc(msg)}</div>`;
  }

  function knobsHtml() {
    return `<div class="co-knobs">
      ${FIELDS.map((f) => `<div class="co-knob">
        <label>${esc(f.label)}</label>
        <input type="number" data-k="${f.key}" min="0" step="${f.step}" value="${knob[f.key]}">
        <span class="u">${esc(f.unit)}</span></div>`).join('')}
      <button type="button" class="co-reset" data-reset>初期値</button>
      <button type="button" class="co-save" data-save>💾 単価を保存</button>
    </div>`;
  }

  function render() {
    disposeChart();
    const d = data || {};
    const cats = d.categories || [];
    const benchOpts = ['<option value="">物流形態テンプレ（想定生産性）…</option>']
      .concat(benchmarks.map((bm) => `<option value="${esc(bm.id)}"${bm.id === curBench ? ' selected' : ''}>`
        + `${esc(bm.label)}${bm.seed ? '（seed）' : ''}</option>`)).join('');
    root.innerHTML = `
      <div class="co-head"><h2>原価試算（試算フロー 6費目）</h2>
        <span class="sub">物量 → 工数 → 原価を解析的に積み上げ（爆速・実行不要）。
        ${d.working_days ? `稼働日 ${fmt(d.working_days)}日` : ''}</span>
        <select class="co-bench" data-bench aria-label="物流形態ベンチマーク">${benchOpts}</select></div>
      <div class="co-hero">
        <div class="co-card hero"><div class="l">月間コスト（合計）</div>
          <div class="v">${yen(d.total_yen_month)}</div><div class="d">解析的見積り</div></div>
        <div class="co-card"><div class="l">1件あたりコスト</div>
          <div class="v">${d.currency || '¥'}${fmt(d.cost_per_order, 1)}</div>
          <div class="d">${fmt(d.orders_per_month)} 件/月</div></div>
        <div class="co-card"><div class="l">必要工数（解析）</div>
          <div class="v">${fmt(d.mh_per_day, 1)} <span style="font-size:12px">人時/日</span></div>
          <div class="d">工程別 物量÷生産性</div></div>
      </div>
      <div class="co-sec">単価設定（編集すると即時に再計算。「保存」でこのプロジェクトに記録）</div>
      ${knobsHtml()}
      <div class="co-ec" data-ec></div>
      <table class="co-tbl"><thead><tr><th>費目</th><th>算出根拠</th><th class="num">月額</th></tr></thead>
        <tbody>
          ${cats.map((c) => `<tr class="${(c.yen_month || 0) === 0 ? 'zero' : ''}">
            <td><b>${esc(c.label)}</b><div class="formula">${esc(c.formula || '')}</div></td>
            <td class="co-sec">${esc(c.basis || '')}</td>
            <td class="num">${yen(c.yen_month)}</td></tr>`).join('')}
          <tr class="total"><td>合計</td><td></td><td class="num">${yen(d.total_yen_month)}</td></tr>
        </tbody></table>
      <div class="co-note">※ これは解析的（決定論）見積りです。待ち・混雑・ピーク日の捌けは
        ④検証のシミュレーションで叩いてください。輸配送/システム/運営は単価0のあいだ計上されません。</div>`;
    buildChart(root.querySelector('[data-ec]'), cats);
    wire();
  }

  function buildChart(node, cats) {
    if (!node) return;
    const ink = tok('--ink-secondary', '#52677c');
    const line = tok('--line-hair', 'rgba(120,140,170,.18)');
    const rows = cats.filter((c) => (c.yen_month || 0) > 0);
    chart = echarts.init(node, null, { renderer: 'canvas' });
    chart.setOption({
      animation: !reduceMotion(),
      grid: { left: 8, right: 24, top: 10, bottom: 4, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' },
        valueFormatter: (v) => yen(v) },
      xAxis: { type: 'value', axisLabel: { color: ink, formatter: (v) => (v >= 1e6 ? (v / 1e6) + 'M' : v) },
        splitLine: { lineStyle: { color: line } } },
      yAxis: { type: 'category', inverse: true, data: rows.map((c) => c.label.replace(/^[①-⑨]\s*/, '')),
        axisLabel: { color: ink }, axisLine: { show: false }, axisTick: { show: false } },
      series: [{ type: 'bar', barMaxWidth: 26, data: rows.map((c, i) => ({
        value: c.yen_month, itemStyle: { color: CAT_COLOR[i % CAT_COLOR.length], borderRadius: [0, 4, 4, 0] } })),
        label: { show: true, position: 'right', color: ink, formatter: (pt) => yen(pt.value) } }],
    }, true);
    if (typeof ResizeObserver !== 'undefined') {
      ro = ro || new ResizeObserver(() => { try { chart && chart.resize(); } catch (_e) { /* noop */ } });
      ro.observe(node);
    }
  }

  function wire() {
    root.querySelectorAll('input[data-k]').forEach((inp) => {
      inp.oninput = () => { knob[inp.dataset.k] = Number(inp.value) || 0; onKnob(); };
    });
    const reset = root.querySelector('[data-reset]');
    if (reset) reset.onclick = () => { FIELDS.forEach((f) => { knob[f.key] = f.def; }); load(); };
    const save = root.querySelector('[data-save]');
    if (save) save.onclick = () => persist(save);
    const bench = root.querySelector('[data-bench]');
    if (bench) bench.onchange = () => applyBench(bench.value);
  }

  // Persist the 単価 to the project settings (so KPIs/proposal use them too).
  async function persist(btn) {
    const name = getProject();
    if (!name) { toast('先にプロジェクトを選択してください。', 'error'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    try {
      const body = {};
      FIELDS.forEach((f) => { body[f.key] = knob[f.key]; });
      await api(`/api/projects/${encodeURIComponent(name)}/settings`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast('単価を保存しました。提案書・KPIにも反映されます。', 'ok');
    } catch (e) {
      toast('保存に失敗: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '💾 単価を保存'; }
    }
  }

  const onTheme = () => { if (data) render(); };
  document.addEventListener('themechange', onTheme);
  (async () => { await seed(); load(); })();

  return {
    refresh() { seeded = false; data = null; (async () => { await seed(); load(); })(); },
    dispose() {
      document.removeEventListener('themechange', onTheme);
      if (ro) { ro.disconnect(); ro = null; }
      disposeChart();
      el.innerHTML = '';
    },
  };
}
