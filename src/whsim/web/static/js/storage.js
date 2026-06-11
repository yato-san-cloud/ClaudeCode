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
        <div data-tbl></div></div>`;
    buildChart(root.querySelector('[data-ec]'));
    buildTable(root.querySelector('[data-tbl]'));
    wireKnobs();
    const csv = root.querySelector('[data-csv]');
    if (csv) csv.onclick = () => exportCsv();
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
    refresh() { data = null; load(); },
    dispose() {
      document.removeEventListener('themechange', onTheme);
      if (ro) { ro.disconnect(); ro = null; }
      if (debounce) clearTimeout(debounce);
      disposeChart();
      el.innerHTML = '';
    },
  };
}
