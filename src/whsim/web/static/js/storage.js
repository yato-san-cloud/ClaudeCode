// storage.js — ③設計「保管設計」: 保管設備の試算 (御社の設備費用算出ステップ).
// 物量 → 必要保管機器(間口/台数/坪) → 保管費 を、坪単価・在庫日数などのつまみで
// 即時に再計算して見せる。バックエンドは GET /api/projects/<p>/storage（純関数
// whsim.storage）。設備内訳は ECharts 横棒、機器数取纏めは表、保管費はカード。
// 値は再取得せず "つまみ→再フェッチ" だけ（計算は全てサーバ純関数）。EN comments / JA UI.
import { $, api, esc } from './util.js';
import * as echarts from 'echarts';

const TSUBO = '坪';
const fmt = (n, d = 0) => (n == null || isNaN(n) ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));
const yen = (n) => (n == null || isNaN(n) ? '—' : '¥' + Math.round(n).toLocaleString('ja-JP'));
const reduceMotion = () => matchMedia('(prefers-reduced-motion:reduce)').matches;

function tok(name, fb) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fb;
}
function hexA(hex, a) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) h = '16C0DE';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// The tunable 試算 knobs (mirrors whsim.storage DEFAULTS / params).
const KNOBS = [
  { key: 'stock_days', label: '在庫日数', min: 1, max: 60, step: 1, def: 14, unit: '日' },
  { key: 'tsubo_rate', label: '坪単価', min: 2000, max: 12000, step: 100, def: 4300, unit: '円/坪月' },
  { key: 'aisle_factor', label: '通路率', min: 1, max: 3, step: 0.1, def: 1.9, unit: '×' },
  { key: 'bulk_cases', label: 'bulk閾値', min: 4, max: 120, step: 1, def: 24, unit: 'ケース' },
];

function injectStyle() {
  if (document.getElementById('st-style')) return;
  const s = document.createElement('style');
  s.id = 'st-style';
  s.textContent = `
  #storage.panel{overflow:auto}
  .st{display:flex;flex-direction:column;gap:var(--sp-4,16px);max-width:1120px;margin:0 auto;
    width:100%;padding:var(--sp-2,8px) 2px var(--sp-8,40px);color:var(--ink-primary);font-family:var(--font-sans)}
  .st-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  .st-head h2{font-size:var(--fs-title,17px);margin:0}
  .st-head .sub{font-size:var(--fs-sm,12.5px);color:var(--ink-secondary)}
  /* cost cards */
  .st-cost{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
  .st-card{padding:12px 16px;border:1px solid var(--line-hair);border-radius:12px;background:var(--bg-sunken)}
  .st-card.hero{border-left:4px solid var(--accent);background:var(--accent-tint,rgba(22,192,222,.06))}
  .st-card .l{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary)}
  .st-card .v{font-family:var(--font-mono);font-size:21px;font-weight:700;white-space:nowrap}
  .st-card .d{font-family:var(--font-mono);font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary)}
  /* knobs */
  .st-knobs{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end;
    padding:12px 16px;border:1px solid var(--line-hair);border-radius:12px;background:var(--bg-panel)}
  .st-knob{display:flex;flex-direction:column;gap:3px;min-width:150px;flex:1}
  .st-knob .kl{font-size:var(--fs-micro,10.5px);color:var(--ink-secondary);display:flex;justify-content:space-between}
  .st-knob .kl b{font-family:var(--font-mono);color:var(--ink-primary)}
  .st-knob input[type=range]{width:100%;accent-color:var(--accent)}
  .st-reset{align-self:center;font-family:var(--font-mono);font-size:var(--fs-micro,10.5px);
    color:var(--ink-secondary);border:1px solid var(--line-strong);border-radius:999px;
    background:transparent;padding:4px 12px;cursor:pointer}
  .st-reset:hover{color:var(--accent);border-color:var(--accent)}
  /* table */
  .st-sec{border:1px solid var(--line-hair);border-radius:12px;overflow:hidden}
  .st-sec h3{font-size:var(--fs-sm,12.5px);margin:0;padding:9px 14px;background:var(--bg-sunken);
    border-bottom:1px solid var(--line-hair)}
  .st-ec{height:240px}
  table.st-tbl{width:100%;border-collapse:collapse;font-size:var(--fs-sm,12.5px)}
  table.st-tbl th,table.st-tbl td{padding:7px 12px;text-align:right;border-bottom:1px solid var(--line-hair)}
  table.st-tbl th{color:var(--ink-tertiary);font-weight:600;font-size:var(--fs-micro,10.5px);text-align:right}
  table.st-tbl th:first-child,table.st-tbl td:first-child{text-align:left}
  table.st-tbl td.m{font-family:var(--font-mono)}
  table.st-tbl tr.tot td{font-weight:700;border-top:2px solid var(--line-strong);background:var(--bg-sunken)}
  .st-sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:7px;vertical-align:middle}
  .st-empty{padding:34px;text-align:center;color:var(--ink-tertiary)}
  .st-empty b{color:var(--ink-secondary)}
  .st-csv{margin-left:auto;font-family:var(--font-mono);font-size:var(--fs-micro,10.5px);
    color:var(--ink-secondary);border:1px solid var(--line-strong);border-radius:999px;
    background:transparent;padding:4px 12px;cursor:pointer}
  .st-csv:hover{color:var(--accent);border-color:var(--accent)}
  /* 試算 → レイアウト反映 CTA (the next-step of this view) */
  .st-apply{padding:12px 16px;border:1px solid var(--ok-line,rgba(52,227,160,.3));
    border-left:4px solid var(--ok,#34c97a);border-radius:12px;
    background:var(--ok-tint,rgba(52,227,160,.07));display:flex;flex-direction:column;gap:9px}
  .st-apply-t{font-size:var(--fs-sm,12.5px);color:var(--ink-secondary)}
  .st-apply-btn{align-self:flex-start;padding:9px 16px;border:none;border-radius:10px;
    background:var(--accent);color:var(--ink-onAccent,#04222c);font:inherit;font-weight:700;cursor:pointer}
  .st-apply-btn:hover{background:var(--accent-hover)}
  .st-apply-btn:disabled{opacity:.55;cursor:wait}
  /* 段(level) vertical-pick-time tuner */
  .st-vt{border:1px solid var(--line-hair);border-radius:12px;overflow:hidden}
  .st-vt h3{font-size:var(--fs-sm,12.5px);margin:0;padding:9px 14px;background:var(--bg-sunken);
    border-bottom:1px solid var(--line-hair);display:flex;align-items:baseline;gap:10px}
  .st-vt h3 .sub{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary);font-weight:400}
  .st-vt-body{padding:12px 16px;display:flex;flex-direction:column;gap:12px}
  .st-vt-knobs{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end}
  .st-vt-knob{display:flex;flex-direction:column;gap:3px;min-width:170px;flex:1}
  .st-vt-knob .kl{font-size:var(--fs-micro,10.5px);color:var(--ink-secondary);display:flex;justify-content:space-between}
  .st-vt-knob .kl b{font-family:var(--font-mono);color:var(--ink-primary)}
  .st-vt-knob input[type=range]{width:100%;accent-color:var(--accent)}
  .st-vt-tbl-wrap{overflow:auto}
  table.st-vt-tbl{width:100%;border-collapse:collapse;font-size:var(--fs-sm,12.5px);min-width:480px}
  table.st-vt-tbl th,table.st-vt-tbl td{padding:6px 10px;text-align:right;border-bottom:1px solid var(--line-hair);white-space:nowrap}
  table.st-vt-tbl th{color:var(--ink-tertiary);font-weight:600;font-size:var(--fs-micro,10.5px)}
  table.st-vt-tbl th:first-child,table.st-vt-tbl td:first-child{text-align:left}
  table.st-vt-tbl td.m{font-family:var(--font-mono)}
  table.st-vt-tbl td.slow{font-weight:700;color:var(--warn,#e0843c);background:var(--warn-tint,rgba(224,132,60,.1))}
  .st-vt-mover{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary)}
  .st-vt-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .st-vt-save{padding:8px 16px;border:none;border-radius:10px;background:var(--accent);
    color:var(--ink-onAccent,#04222c);font:inherit;font-weight:700;cursor:pointer}
  .st-vt-save:hover{background:var(--accent-hover)}
  .st-vt-save:disabled{opacity:.55;cursor:wait}
  .st-vt-note{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary)}
  `;
  document.head.appendChild(s);
}

export function mountStorage(el, opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const toast = opts.toast || (() => {});
  const root = document.createElement('div');
  root.className = 'st';
  el.innerHTML = '';
  el.appendChild(root);

  let chart = null;
  let ro = null;
  let data = null;
  const knob = {};                  // live knob values
  KNOBS.forEach((k) => { knob[k.key] = k.def; });
  let debounce = 0;

  // 段(level) vertical-pick-time tuner state (independent of the 試算 knobs).
  // lift = process.lift_speed_mps, reach = process.manual_reach_s_per_m. We load
  // the saved values from the model on mount, preview live, and save back via
  // /design (merging the current process subtree so other fields survive).
  const vt = { lift: 0.4, reach: 2.0, def: { lift: 0.4, reach: 2.0 },
    data: null, debounce: 0, loaded: false };

  function disposeChart() { if (chart) { try { chart.dispose(); } catch (_) { /* noop */ } chart = null; } }

  async function load() {
    const name = getProject();
    if (!name) { renderEmpty('プロジェクトを選択してください。'); return; }
    const qs = KNOBS.map((k) => `${k.key}=${encodeURIComponent(knob[k.key])}`).join('&');
    try {
      data = await api(`/api/projects/${encodeURIComponent(name)}/storage?${qs}`);
      render();
    } catch (e) {
      renderEmpty('読み込めませんでした：' + (e && e.message ? e.message : e));
    }
  }
  // Knob change → refetch (server is a pure function), debounced so dragging is smooth.
  function onKnob() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(load, 180);
  }

  function renderEmpty(msg) {
    disposeChart();
    root.innerHTML = `<div class="st-head"><h2>保管設計（設備の試算）</h2>
      <span class="sub">物量 → 必要保管機器 → 間口・坪数 → 保管費</span></div>
      <div class="st-empty"><b>${esc(msg)}</b><br>
      ②分析で出荷データを取り込み、ABC分類が付くと、保管設備の必要数と保管費を試算します。</div>`;
  }

  function knobsBar() {
    return `<div class="st-knobs">
      ${KNOBS.map((k) => `<label class="st-knob">
        <span class="kl">${esc(k.label)} <b data-kv="${k.key}">${fmt(knob[k.key], k.step < 1 ? 1 : 0)}${esc(k.unit)}</b></span>
        <input type="range" data-knob="${k.key}" min="${k.min}" max="${k.max}" step="${k.step}" value="${knob[k.key]}" />
      </label>`).join('')}
      <button type="button" class="st-reset" data-reset>初期値に戻す</button>
    </div>`;
  }

  function render() {
    disposeChart();
    if (!data || !data.has_data) {
      renderEmpty('保管物量を算出できる実データがまだありません。');
      // still show the knobs so the page isn't dead
      root.insertAdjacentHTML('beforeend', knobsBar());
      wireKnobs();
      mountVt();
      return;
    }
    const c = data.cost, t = data.totals;
    root.innerHTML = `
      <div class="st-head"><h2>保管設計（設備の試算）</h2>
        <span class="sub">物量 → 必要保管機器 → 間口・坪数 → 保管費（在庫日数 ${fmt(data.params.stock_days)}日・${data.working_days}日分の出荷から）</span>
      </div>
      ${knobsBar()}
      <div class="st-cost">
        <div class="st-card hero"><div class="l">必要坪数（保管）</div><div class="v">${fmt(t.tsubo_storage, 1)} ${TSUBO}</div>
          <div class="d">通路率 ×${fmt(data.params.aisle_factor, 1)} 込み</div></div>
        <div class="st-card"><div class="l">什器台数 / 間口</div><div class="v">${fmt(t.units)} 台</div>
          <div class="d">${fmt(t.cells)} 間口・${fmt(t.skus)} SKU</div></div>
        <div class="st-card"><div class="l">参考: 保管費 / 月</div><div class="v">${yen(c.total_yen)}</div>
          <div class="d">倉庫料 ${yen(c.warehouse_yen)} ＋ 設備 ${yen(c.equipment_yen)}</div></div>
      </div>
      <div class="st-sec"><h3>必要保管機器（坪数の内訳）</h3><div class="st-ec" data-ec></div></div>
      <div class="st-sec"><h3>設備機器数 取りまとめ
        <button type="button" class="st-csv" data-csv>⤓ CSV出力</button></h3>
        <div data-tbl></div></div>
      <div class="st-apply">
        <div class="st-apply-t">この什器構成を保管ゾーンに自動配置します（既存の棚は置き換え。配置後はレイアウトで自由に調整できます）。</div>
        <button type="button" class="st-apply-btn" data-apply>⛏ この設備をレイアウトに配置 →</button>
      </div>`;
    buildChart(root.querySelector('[data-ec]'));
    buildTable(root.querySelector('[data-tbl]'));
    wireKnobs();
    const csv = root.querySelector('[data-csv]');
    if (csv) csv.onclick = () => exportCsv();
    const ap = root.querySelector('[data-apply]');
    if (ap) ap.onclick = () => applyLayout(ap);
    mountVt();
  }

  // 試算 → レイアウト: author the sized equipment into the storage zone (server
  // replaces that zone's shelves + re-materialises locations), then reopen the
  // project (provenance/readiness refresh) and land on the designer to adjust.
  async function applyLayout(btn) {
    const name = getProject();
    if (!name) { toast('先にプロジェクトを作ってください。', 'error'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '配置中…'; }
    try {
      const body = {};
      KNOBS.forEach((k) => { body[k.key] = knob[k.key]; });
      const r = await api(`/api/projects/${encodeURIComponent(name)}/storage/apply-layout`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r || !r.ok) { toast((r && r.message) || '配置できませんでした。', 'error'); return; }
      toast(r.message || '配置しました。', 'ok');
      document.dispatchEvent(new CustomEvent('whsim:model-changed', { detail: { nav: 'design' } }));
    } catch (e) {
      toast('配置に失敗: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⛏ この設備をレイアウトに配置 →'; }
    }
  }

  function buildChart(node) {
    if (!node) return;
    const accent = tok('--accent', '#16C0DE');
    const ink2 = tok('--ink-secondary', '#52677c');
    const ink3 = tok('--ink-tertiary', '#8195a8');
    const line = tok('--line-hair', 'rgba(120,140,170,.18)');
    const rows = data.by_method.slice().reverse(); // ECharts y-axis is bottom-up
    chart = echarts.init(node, null, { renderer: 'canvas' });
    chart.setOption({
      animation: !reduceMotion(),
      grid: { left: 8, right: 16, top: 10, bottom: 24, containLabel: true },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        backgroundColor: tok('--bg-app', '#fff'), borderColor: tok('--line-strong', '#ccc'),
        textStyle: { color: tok('--ink-primary', '#222'), fontSize: 12 },
        formatter: (ps) => {
          const m = rows[ps[0].dataIndex];
          return `<b>${esc(m.label)}</b><br>坪数 ${fmt(m.footprint_tsubo, 1)}${TSUBO}<br>`
            + `台数 ${fmt(m.units)}・間口 ${fmt(m.cells)}<br>SKU ${fmt(m.items)}・月額 ${yen(m.monthly_yen)}`;
        },
      },
      xAxis: { type: 'value', name: '坪', nameTextStyle: { color: ink3 },
        axisLabel: { color: ink3, fontFamily: 'monospace' }, splitLine: { lineStyle: { color: line } } },
      yAxis: { type: 'category', data: rows.map((m) => m.label),
        axisLabel: { color: ink2 }, axisLine: { lineStyle: { color: line } }, axisTick: { show: false } },
      series: [{
        type: 'bar', barMaxWidth: 26,
        data: rows.map((m) => ({ value: m.footprint_tsubo, itemStyle: { color: hexA(m.color || accent, 0.85), borderRadius: [0, 4, 4, 0] } })),
        label: { show: true, position: 'right', color: ink2, fontFamily: 'monospace',
          formatter: (d) => `${fmt(d.value, 1)}${TSUBO}` },
      }],
    });
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => { try { chart.resize(); } catch (_) { /* noop */ } });
      ro.observe(node);
    }
  }

  function buildTable(node) {
    if (!node) return;
    const t = data.totals, c = data.cost;
    const rows = data.by_method.map((m) => `<tr>
      <td><span class="st-sw" style="background:${esc(m.color)}"></span>${esc(m.label)}</td>
      <td class="m">${fmt(m.items)}</td><td class="m">${fmt(m.cases)}</td>
      <td class="m">${fmt(m.cells)}</td><td class="m">${fmt(m.units)}</td>
      <td class="m">${fmt(m.footprint_tsubo, 1)}</td><td class="m">${yen(m.monthly_yen)}</td></tr>`).join('');
    node.innerHTML = `<table class="st-tbl">
      <thead><tr><th>保管方法</th><th>SKU</th><th>ケース</th><th>間口</th><th>台数</th><th>坪数</th><th>設備/月</th></tr></thead>
      <tbody>${rows}
        <tr class="tot"><td>合計</td><td class="m">${fmt(t.skus)}</td><td class="m">—</td>
          <td class="m">${fmt(t.cells)}</td><td class="m">${fmt(t.units)}</td>
          <td class="m">${fmt(t.tsubo_storage, 1)}</td><td class="m">${yen(c.equipment_yen)}</td></tr>
      </tbody></table>`;
  }

  function exportCsv() {
    if (!data || !data.by_method) return;
    const head = '保管方法,SKU,ケース,間口,台数,坪数,設備月額';
    const lines = data.by_method.map((m) =>
      [m.label, m.items, m.cases, m.cells, m.units, m.footprint_tsubo, Math.round(m.monthly_yen)].join(','));
    const blob = new Blob(['﻿' + [head, ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `storage_${getProject() || 'data'}.csv`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    toast('保管機器数をCSV出力しました。', 'info');
  }

  // ---- 段(level) vertical-pick-time tuner --------------------------------
  const MOVER_LABEL = { manual: '手作業', forklift: 'フォーク', crane: 'クレーン' };

  // Pull the saved knob values out of the model once (so the sliders show the
  // persisted state on first paint). Never blocks: any failure keeps defaults.
  async function loadVtModel() {
    if (vt.loaded) return;
    const name = getProject();
    if (!name) return;
    try {
      const full = await api(`/api/projects/${encodeURIComponent(name)}/full`);
      const p = (full && full.process) || {};
      if (typeof p.lift_speed_mps === 'number') vt.lift = p.lift_speed_mps;
      if (typeof p.manual_reach_s_per_m === 'number') vt.reach = p.manual_reach_s_per_m;
    } catch (_) { /* keep defaults */ }
    vt.loaded = true;
  }

  // Fetch the per-rack preview for the current knob values (pure server fn).
  async function loadVtPreview() {
    try {
      vt.data = await api(`/api/racktypes/vertical?lift=${encodeURIComponent(vt.lift)}`
        + `&reach=${encodeURIComponent(vt.reach)}`);
      if (vt.data && vt.data.defaults) vt.def = {
        lift: vt.data.defaults.lift_speed_mps, reach: vt.data.defaults.manual_reach_s_per_m,
      };
    } catch (_) { vt.data = null; }
    renderVtBody();
  }

  function onVtKnob() {
    if (vt.debounce) clearTimeout(vt.debounce);
    vt.debounce = setTimeout(loadVtPreview, 160);
  }

  function vtSection() {
    return `<div class="st-vt">
      <h3>段からのピック時間（垂直アクセス）
        <span class="sub">上の段ほど時間がかかる。フォーク昇降速度と手伸ばし時間で再計算（④検証のDESにも反映）</span></h3>
      <div class="st-vt-body" data-vt></div>
    </div>`;
  }

  function renderVtBody() {
    const node = root.querySelector('[data-vt]');
    if (!node) return;
    const knobs = `<div class="st-vt-knobs">
      <label class="st-vt-knob">
        <span class="kl">フォーク昇降速度 <b data-vtkv="lift">${fmt(vt.lift, 2)} m/s</b></span>
        <input type="range" data-vtknob="lift" min="0.1" max="1.5" step="0.05" value="${vt.lift}" />
      </label>
      <label class="st-vt-knob">
        <span class="kl">手伸ばし時間 <b data-vtkv="reach">${fmt(vt.reach, 1)} s/m</b></span>
        <input type="range" data-vtknob="reach" min="0.5" max="6" step="0.1" value="${vt.reach}" />
      </label>
    </div>`;
    let table = '<div class="st-vt-note">プレビューを読み込めませんでした。</div>';
    const rows = vt.data && vt.data.rack_types;
    if (rows && rows.length) {
      const maxLevels = rows.reduce((m, r) => Math.max(m, r.levels), 0);
      const heads = [];
      for (let l = 1; l <= maxLevels; l++) heads.push(`<th>${l}段</th>`);
      const body = rows.map((r) => {
        const slowest = Math.max(...r.vertical_s);
        const cells = [];
        for (let l = 0; l < maxLevels; l++) {
          if (l >= r.levels) { cells.push('<td class="m">—</td>'); continue; }
          const v = r.vertical_s[l];
          const slow = v > 0 && v === slowest ? ' slow' : '';
          cells.push(`<td class="m${slow}">${v === 0 ? '0' : '+' + fmt(v, 1)}</td>`);
        }
        return `<tr>
          <td><span class="st-sw" style="background:${esc(r.color)}"></span>${esc(r.label)}
            <span class="st-vt-mover">(${esc(MOVER_LABEL[r.mover] || r.mover)})</span></td>
          ${cells.join('')}</tr>`;
      }).join('');
      table = `<div class="st-vt-tbl-wrap"><table class="st-vt-tbl">
        <thead><tr><th>保管設備</th>${heads.join('')}</tr></thead>
        <tbody>${body}</tbody></table></div>
        <div class="st-vt-note">単位は1段目（地面）からの追加秒数。最も遅い段を強調。</div>`;
    }
    const dirty = vt.lift !== vt.def.lift || vt.reach !== vt.def.reach;
    const actions = `<div class="st-vt-actions">
      <button type="button" class="st-vt-save" data-vtsave>この値を保存</button>
      <button type="button" class="st-reset" data-vtreset${dirty ? '' : ' disabled'}>既定に戻す</button>
    </div>`;
    node.innerHTML = knobs + table + actions;
    wireVt();
  }

  function wireVt() {
    root.querySelectorAll('[data-vtknob]').forEach((inp) => {
      inp.oninput = () => {
        const k = inp.dataset.vtknob;
        vt[k] = parseFloat(inp.value);
        const lab = root.querySelector(`[data-vtkv="${k}"]`);
        if (lab) lab.textContent = k === 'lift' ? `${fmt(vt.lift, 2)} m/s` : `${fmt(vt.reach, 1)} s/m`;
        onVtKnob();
      };
    });
    const save = root.querySelector('[data-vtsave]');
    if (save) save.onclick = () => saveVt(save);
    const reset = root.querySelector('[data-vtreset]');
    if (reset) reset.onclick = () => { vt.lift = vt.def.lift; vt.reach = vt.def.reach; loadVtPreview(); };
  }

  // Merge the two knobs into the model's process subtree and persist via /design
  // (GET /full first so we don't clobber other process fields).
  async function saveVt(btn) {
    const name = getProject();
    if (!name) { toast('先にプロジェクトを作ってください。', 'error'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    try {
      const full = await api(`/api/projects/${encodeURIComponent(name)}/full`);
      const process = { ...((full && full.process) || {}),
        lift_speed_mps: vt.lift, manual_reach_s_per_m: vt.reach };
      const r = await api(`/api/projects/${encodeURIComponent(name)}/design`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ process }) });
      if (!r || !r.ok) { toast('保存できませんでした。', 'error'); return; }
      toast('段ピック時間の設定を保存しました。', 'ok');
      document.dispatchEvent(new CustomEvent('whsim:design-dirty', { detail: { section: 'process' } }));
    } catch (e) {
      toast('保存に失敗: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'この値を保存'; }
    }
  }

  // Mount the vertical tuner under whatever was just rendered.
  async function mountVt() {
    if (!getProject()) return;
    root.insertAdjacentHTML('beforeend', vtSection());
    await loadVtModel();
    await loadVtPreview();
  }

  function wireKnobs() {
    root.querySelectorAll('[data-knob]').forEach((inp) => {
      inp.oninput = () => {
        const k = inp.dataset.knob;
        const spec = KNOBS.find((x) => x.key === k);
        knob[k] = parseFloat(inp.value);
        const lab = root.querySelector(`[data-kv="${k}"]`);
        if (lab) lab.textContent = `${fmt(knob[k], spec.step < 1 ? 1 : 0)}${spec.unit}`;
        onKnob();
      };
    });
    const reset = root.querySelector('[data-reset]');
    if (reset) reset.onclick = () => { KNOBS.forEach((k) => { knob[k.key] = k.def; }); load(); };
  }

  function onTheme() { if (data && data.has_data) render(); }
  document.addEventListener('themechange', onTheme);

  load();
  return {
    refresh() { data = null; vt.loaded = false; load(); },
    dispose() {
      document.removeEventListener('themechange', onTheme);
      if (ro) { ro.disconnect(); ro = null; }
      if (debounce) clearTimeout(debounce);
      if (vt.debounce) clearTimeout(vt.debounce);
      disposeChart();
      el.innerHTML = '';
    },
  };
}
