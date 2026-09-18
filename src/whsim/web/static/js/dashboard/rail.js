// dashboard/rail.js — ダッシュボード右レール (~320px) の縦積みチャートカード.
//
// Four quiet cards, each answering one question at a glance:
//   1. 処理推移       — 累積完了(done)の推移 + 仕掛(wip) を薄く重ねる (ECharts)
//   2. 設備稼働状況   — ボトルネック資源の 稼働/待機 ドーナツ (ECharts)
//   3. オーダー状況   — 完了/未処理 ドーナツ (ECharts)
//   4. 工程別稼働率   — 素の div による横バー (チャート1個ぶん軽い)
//
// The skeleton is built ONCE; update() only re-fills text and calls
// setOption(opt, true) on the kept ECharts instances (never one per update).
// Colours are read from CSS tokens at render time, and a MutationObserver on
// <html> re-renders on theme flip so the canvases follow light/dark.
//
// never-blocks: no run / partial payloads / missing fields render the card
// frames with a centred 「—」 and no chart instance — never a throw, never a
// blank box. EN comments / JA UI.
import { esc } from '../util.js';
import * as echarts from 'echarts';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

// Finite-number gate: anything else (null / undefined / NaN / string) → null,
// which every renderer below reads as "no data" rather than a zero.
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

const fmt = (n, d = 0) => (n == null ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));

const reduceMotion = () => {
  try { return matchMedia('(prefers-reduced-motion:reduce)').matches; } catch (_) { return false; }
};

function tok(name, fb) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  } catch (_) { return fb; }
}

// Utilisation arrives as a 0–1 fraction from the engine; be tolerant of a
// payload that already carries percent (never invent, only normalise).
function pct(v) {
  const n = num(v);
  if (n == null || n < 0) return null;
  return n <= 1.0001 ? n * 100 : Math.min(n, 100);
}

// Threshold tone shared by the utilisation donut and the bar list.
function utilTone(p) {
  if (p == null) return 'ok';
  if (p > 95) return 'bad';
  if (p > 80) return 'warn';
  return 'ok';
}
const toneColor = (t) => tok(`--${t}`, t === 'bad' ? '#C4453F' : t === 'warn' ? '#B7791F' : '#2E7D55');

// 工程別稼働率: every *_utilization the engine may emit, in display order.
const UTIL_ROWS = [
  { key: 'picker_utilization', label: 'ピッキング' },
  { key: 'packer_utilization', label: '梱包' },
  { key: 'agv_utilization', label: 'AGV' },
  { key: 'conveyor_utilization', label: 'コンベヤ' },
  { key: 'sort_utilization', label: '仕分け' },
  { key: 'sorter_utilization', label: 'ソーター' },
  { key: 'replenisher_utilization', label: '補充' },
  { key: 'inspector_utilization', label: '検品' },
];

function injectStyle() {
  if (document.getElementById('drail-style')) return;
  const s = document.createElement('style');
  s.id = 'drail-style';
  s.textContent = `
  /* The shell (.dash-rail) turns into a 3-column grid under 1400px; a single
     child would then sit in 1/3 of the row with two empty columns, so span the
     whole row and take the columns over ourselves. */
  .drail{display:flex;flex-direction:column;gap:var(--sp-2,8px);width:100%;min-width:0;
    grid-column:1/-1}
  @media (max-width:1400px){
    .drail{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:start;
      gap:var(--sp-3,12px)}
  }
  @media (max-width:900px){.drail{grid-template-columns:minmax(0,1fr)}}
  .drail-card{display:flex;flex-direction:column;gap:var(--sp-2,8px);min-width:0;
    padding:var(--sp-3,12px);background:var(--bg-app);border:1px solid var(--line-hair);
    border-radius:var(--r-lg,12px);box-shadow:var(--sh-xs)}
  .drail-hd{display:flex;align-items:center;gap:var(--sp-2,8px);min-width:0}
  .drail-ttl{font-size:13px;font-weight:var(--fw-semibold,600);color:var(--ink-secondary);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .drail-hd-r{margin-left:auto;flex:0 0 auto;display:flex;align-items:center;gap:6px}
  .drail-sel{font:inherit;font-size:var(--fs-micro,11px);color:var(--ink-tertiary);
    background:var(--bg-panel);border:1px solid var(--line-hair);border-radius:var(--r-sm,6px);
    padding:2px 6px;cursor:pointer}
  .drail-sel:focus-visible{outline:2px solid var(--line-focus,#0E8FA8);outline-offset:1px}
  .drail-sel:disabled{opacity:.5;cursor:default}
  .drail-body{position:relative;min-width:0}
  .drail-chart{width:100%;min-width:0}
  .drail-chart.h-trend{height:132px}
  .drail-chart.h-donut{height:124px}
  .drail-hole{position:absolute;inset:0;display:flex;flex-direction:column;
    align-items:center;justify-content:center;pointer-events:none;gap:1px}
  .drail-hole b{font-size:var(--fs-metric,26px);font-weight:var(--fw-semibold,600);
    line-height:1.05;color:var(--ink-primary);font-variant-numeric:tabular-nums;
    letter-spacing:-0.015em}
  .drail-hole span{font-size:var(--fs-micro,11px);color:var(--ink-tertiary);
    white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
  .drail-legend{display:flex;flex-direction:column;gap:4px;margin-top:2px}
  .drail-lg{display:flex;align-items:center;gap:6px;font-size:var(--fs-xs,12px);
    color:var(--ink-secondary);min-width:0}
  .drail-dot{flex:0 0 auto;width:8px;height:8px;border-radius:var(--r-pill,999px)}
  .drail-lb{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .drail-lv{margin-left:auto;flex:0 0 auto;color:var(--ink-primary);
    font-variant-numeric:tabular-nums;font-weight:var(--fw-medium,500)}
  .drail-lv i{font-style:normal;color:var(--ink-tertiary);font-weight:var(--fw-regular,400);
    margin-right:5px}
  .drail-foot{display:flex;align-items:center;gap:var(--sp-2,8px);min-width:0;
    font-size:var(--fs-micro,11px);color:var(--ink-tertiary);
    font-variant-numeric:tabular-nums}
  .drail-foot .d{margin-left:auto;flex:0 0 auto;font-weight:var(--fw-semibold,600)}
  .drail-foot .d.ok{color:var(--ok)}
  .drail-foot .d.warn{color:var(--warn)}
  .drail-foot .d.bad{color:var(--bad)}
  .drail-foot .d.flat{color:var(--ink-faint)}
  .drail-bars{display:flex;flex-direction:column;gap:6px}
  .drail-bar{display:grid;grid-template-columns:62px 1fr 38px;align-items:center;
    gap:8px;min-width:0}
  .drail-bar .bl{font-size:var(--fs-micro,11px);color:var(--ink-secondary);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .drail-bar .bt{height:6px;border-radius:var(--r-pill,999px);background:var(--bg-hover);
    overflow:hidden}
  .drail-bar .bt i{display:block;height:100%;border-radius:var(--r-pill,999px)}
  .drail-bar .bv{font-size:var(--fs-micro,11px);color:var(--ink-primary);text-align:right;
    font-variant-numeric:tabular-nums}
  .drail-empty{display:none;align-items:center;justify-content:center;
    color:var(--ink-faint);font-size:var(--fs-section,16px);min-height:64px}
  .drail-card.is-empty .drail-chart,
  .drail-card.is-empty .drail-hole,
  .drail-card.is-empty .drail-legend,
  .drail-card.is-empty .drail-bars,
  .drail-card.is-empty .drail-foot{display:none}
  .drail-card.is-empty .drail-empty{display:flex}
  @media (prefers-reduced-motion:no-preference){
    .drail-bar .bt i{transition:width var(--dur-3,240ms) var(--ease-out,ease)}
  }
  `;
  document.head.appendChild(s);
}

// One card frame. `extra` goes between the header and the empty-state slot.
function cardHtml(id, title, right, body) {
  return `<section class="drail-card is-empty" data-card="${id}">
    <div class="drail-hd"><span class="drail-ttl">${title}</span>
      <span class="drail-hd-r">${right || ''}</span></div>
    ${body}
    <div class="drail-empty" aria-hidden="true">—</div>
  </section>`;
}

/**
 * 右レール — 縦積みチャートカード.
 * @param {HTMLElement} host
 * @param {object} ctx  read-only dashboard context (see dashboard.js)
 * @returns {{update:Function, dispose:Function, resize:Function}}
 */
export function mountRail(host, ctx) {
  if (!host) return null;
  injectStyle();

  const root = document.createElement('div');
  root.className = 'drail';
  root.innerHTML =
    cardHtml('trend', '処理推移',
      `<select class="drail-sel" data-sel="range" aria-label="表示範囲">
         <option value="all">全体</option><option value="recent">直近</option>
       </select>`,
      `<div class="drail-body"><div class="drail-chart h-trend" data-chart="trend"></div></div>
       <div class="drail-foot" data-foot="trend"></div>`)
    + cardHtml('util', '設備稼働状況', '',
      `<div class="drail-body"><div class="drail-chart h-donut" data-chart="util"></div>
         <div class="drail-hole" data-hole="util"></div></div>
       <div class="drail-legend" data-legend="util"></div>`)
    + cardHtml('order', 'オーダー状況', '',
      `<div class="drail-body"><div class="drail-chart h-donut" data-chart="order"></div>
         <div class="drail-hole" data-hole="order"></div></div>
       <div class="drail-legend" data-legend="order"></div>`)
    + cardHtml('stage', '工程別稼働率', '',
      '<div class="drail-bars" data-bars="stage"></div>');
  host.innerHTML = '';
  host.appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const cards = {
    trend: q('[data-card=trend]'), util: q('[data-card=util]'),
    order: q('[data-card=order]'), stage: q('[data-card=stage]'),
  };
  const nodes = {
    trend: q('[data-chart=trend]'), util: q('[data-chart=util]'), order: q('[data-chart=order]'),
  };

  let cur = ctx || null;
  let range = 'all';          // 全体 / 直近 (last quarter of the series)
  let pending = false;        // a chart wanted to draw while its host had 0 width
  const charts = { trend: null, util: null, order: null };

  function killChart(key) {
    if (charts[key]) { try { charts[key].dispose(); } catch (_) { /* noop */ } charts[key] = null; }
  }
  // Lazy init: an ECharts instance created on a zero-width node stays zero-wide,
  // so defer until the rail is actually laid out (the ResizeObserver retries).
  function ensureChart(key) {
    const node = nodes[key];
    if (!node) return null;
    if (!node.clientWidth || !node.clientHeight) { pending = true; return null; }
    if (!charts[key]) {
      try { charts[key] = echarts.init(node, null, { renderer: 'canvas' }); } catch (_) { return null; }
    }
    return charts[key];
  }
  const setEmpty = (key, empty) => {
    if (cards[key]) cards[key].classList.toggle('is-empty', !!empty);
    if (empty && charts[key]) killChart(key);
  };

  // Shared tooltip chrome so both themes read correctly.
  const tipStyle = () => ({
    backgroundColor: tok('--bg-app', '#fff'),
    borderColor: tok('--line-hair', 'rgba(0,0,0,.09)'),
    borderWidth: 1,
    padding: [6, 8],
    textStyle: { color: tok('--ink-primary', '#37352F'), fontSize: 11 },
    extraCssText: 'box-shadow:none',
  });

  // -------------------------------------------------------------------------
  // 1. 処理推移 — cumulative done (area+line) + wip on a secondary axis
  // -------------------------------------------------------------------------
  function renderTrend(k) {
    const raw = cur && cur.replay && Array.isArray(cur.replay.series) ? cur.replay.series : [];
    let pts = raw.filter((p) => p && num(p.t) != null);
    const sel = q('[data-sel=range]');
    if (sel) { sel.value = range; sel.disabled = pts.length < 4; }
    if (pts.length < 2) {
      setEmpty('trend', true);
      const foot = q('[data-foot=trend]');
      if (foot) foot.innerHTML = '';
      return;
    }
    if (range === 'recent') {
      const from = Math.max(0, pts.length - Math.max(2, Math.ceil(pts.length / 4)));
      pts = pts.slice(from);
    }
    setEmpty('trend', false);

    const done = pts.map((p) => [p.t / 3600, num(p.done) || 0]);
    const wip = pts.map((p) => [p.t / 3600, num(p.wip) || 0]);
    const hasWip = wip.some((d) => d[1] > 0);

    const accent = tok('--accent', '#16C0DE');
    const hair = tok('--line-hair', 'rgba(0,0,0,.09)');
    const faint = tok('--ink-faint', 'rgba(0,0,0,.32)');
    const ter = tok('--ink-tertiary', 'rgba(0,0,0,.45)');
    // Tick unit follows the real span: a replay window is ~900s, and rounding
    // that to 0.1h printed duplicate ticks (0h 0.1h 0.1h 0.2h 0.2h 0.3h).
    const spanH = done[done.length - 1][0] - done[0][0];
    const hour = spanH < 1.5
      ? (v) => `${Math.round(v * 60)}分`
      : (v) => `${Math.round(v * 10) / 10}h`;

    // Footer first: it must stay truthful even if the canvas init is deferred.
    const foot = q('[data-foot=trend]');
    if (foot) {
      const kk = k || {};
      const last = done[done.length - 1][1];
      const curDone = num(kk.orders_completed) != null ? kk.orders_completed : last;
      // The reference is 到着オーダー (measured), NOT a goal: nothing here may
      // invent a target the data does not carry.
      const arrived = num(kk.orders_arrived);
      let dHtml = '';
      if (arrived != null && arrived > 0) {
        const d = ((curDone - arrived) / arrived) * 100;
        const tone = d >= -1 ? 'ok' : (d >= -20 ? 'warn' : 'bad');
        const sign = d > 0 ? '+' : (d < 0 ? '−' : '±');
        dHtml = `<span class="d ${tone}">${esc(sign + fmt(Math.abs(d), 1))}%</span>`;
      }
      foot.innerHTML = `<span>完了 ${esc(fmt(curDone))} ／ 到着 ${esc(arrived == null ? '—' : fmt(arrived))}</span>${dHtml}`;
    }

    const chart = ensureChart('trend');
    if (!chart) return;
    chart.setOption({
      animation: !reduceMotion(),
      grid: { left: 8, right: 8, top: 10, bottom: 2, containLabel: true },
      tooltip: Object.assign({
        trigger: 'axis',
        formatter: (ps) => {
          if (!Array.isArray(ps) || !ps.length) return '';
          const t = hour(ps[0].value[0]);
          const rows = ps.map((p) => `${esc(p.seriesName)} ${fmt(p.value[1])}`).join('<br>');
          return `${esc(t)}<br>${rows}`;
        },
      }, tipStyle()),
      xAxis: {
        type: 'value', min: 'dataMin', max: 'dataMax',
        axisLine: { lineStyle: { color: hair } },
        axisTick: { show: false },
        axisLabel: { color: ter, fontSize: 10, hideOverlap: true, formatter: hour },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: 'value', min: 0,
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { color: ter, fontSize: 10, formatter: (v) => fmt(v) },
          splitLine: { lineStyle: { color: hair, width: 1 } },
        },
        {
          type: 'value', min: 0, show: hasWip,
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { color: faint, fontSize: 10, formatter: (v) => fmt(v) },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '完了', type: 'line', showSymbol: false, smooth: 0.25,
          lineStyle: { width: 1.8, color: accent },
          itemStyle: { color: accent },
          areaStyle: { color: accent, opacity: 0.14 },
          data: done,
        },
        {
          name: '仕掛', type: 'line', yAxisIndex: 1, showSymbol: false, smooth: 0.25,
          lineStyle: { width: 1, color: faint, type: 'dashed' },
          itemStyle: { color: faint },
          data: hasWip ? wip : [],
        },
      ],
    }, true);
  }

  // Donut option shared by cards 2 and 3.
  function donutOption(slices) {
    return {
      animation: !reduceMotion(),
      tooltip: Object.assign({ trigger: 'item', formatter: (p) => `${esc(p.name)} ${esc(p.data.tip || fmt(p.value))}` }, tipStyle()),
      series: [{
        type: 'pie', radius: ['62%', '82%'], center: ['50%', '50%'],
        avoidLabelOverlap: false, silent: false,
        label: { show: false }, labelLine: { show: false },
        emphasis: { scale: false, itemStyle: { opacity: 0.88 } },
        itemStyle: { borderWidth: 2, borderColor: tok('--bg-app', '#fff') },
        data: slices,
      }],
    };
  }

  const legendHtml = (rows) => rows.map((r) => `<div class="drail-lg">
      <span class="drail-dot" style="background:${esc(r.color)}"></span>
      <span class="drail-lb">${esc(r.label)}</span>
      <span class="drail-lv">${r.sub ? `<i>${esc(r.sub)}</i>` : ''}${esc(r.value)}</span>
    </div>`).join('');

  // -------------------------------------------------------------------------
  // 2. 設備稼働状況 — bottleneck resource: 稼働 / 待機
  // -------------------------------------------------------------------------
  function renderUtil(k) {
    const kk = k || {};
    let p = pct(kk.bottleneck_utilization);
    let fallbackLabel = null;
    if (p == null) {
      // Fall back to the hottest *_utilization actually present.
      let best = null;
      UTIL_ROWS.forEach((r) => {
        const v = pct(kk[r.key]);
        if (v != null && (best == null || v > best.v)) best = { v, label: r.label };
      });
      // Name the process we actually charted, not the engine's bottleneck_jp:
      // they can disagree when bottleneck_utilization is absent.
      if (best) { p = best.v; fallbackLabel = best.label; }
    }
    if (p == null) { setEmpty('util', true); return; }
    setEmpty('util', false);

    const label = fallbackLabel
      || (typeof kk.bottleneck_jp === 'string' && kk.bottleneck_jp ? kk.bottleneck_jp : '主要設備');
    const busy = Math.max(0, Math.min(100, p));
    const idle = Math.max(0, 100 - busy);
    const cBusy = toneColor(utilTone(busy));
    // One colour for the slice AND its legend dot, or the legend stops keying
    // the chart (--bg-hover was too faint to read as a swatch).
    const cIdle = tok('--bg-active', '#EAE9E4');

    const chart = ensureChart('util');
    if (chart) {
      chart.setOption(donutOption([
        { name: '稼働', value: busy, tip: `${fmt(busy, 1)}%`, itemStyle: { color: cBusy } },
        { name: '待機', value: idle, tip: `${fmt(idle, 1)}%`, itemStyle: { color: cIdle } },
      ]), true);
    }
    const hole = q('[data-hole=util]');
    if (hole) {
      hole.innerHTML = `<b>${esc(fmt(busy, 0))}%</b><span>${esc(label)}</span>`;
    }
    const lg = q('[data-legend=util]');
    if (lg) {
      lg.innerHTML = legendHtml([
        { color: cBusy, label: '稼働', value: `${fmt(busy, 1)}%` },
        { color: cIdle, label: '待機', value: `${fmt(idle, 1)}%` },
      ]);
    }
  }

  // -------------------------------------------------------------------------
  // 3. オーダー状況 — 完了 / 未処理
  // -------------------------------------------------------------------------
  function renderOrder(k) {
    const kk = k || {};
    const doneN = num(kk.orders_completed);
    const arrived = num(kk.orders_arrived);
    if (doneN == null || arrived == null || arrived <= 0) { setEmpty('order', true); return; }
    setEmpty('order', false);

    const completed = Math.max(0, Math.min(doneN, arrived));
    const openN = Math.max(0, arrived - completed);
    const rate = pct(kk.completion_rate);
    const ratePct = rate != null ? rate : (completed / arrived) * 100;
    const openPct = 100 - ratePct;
    const cDone = tok('--accent', '#16C0DE');
    const cOpen = tok('--bg-active', '#EAE9E4');

    const chart = ensureChart('order');
    if (chart) {
      chart.setOption(donutOption([
        { name: '完了', value: completed, tip: `${fmt(completed)}件 (${fmt(ratePct, 0)}%)`, itemStyle: { color: cDone } },
        { name: '未処理', value: openN, tip: `${fmt(openN)}件 (${fmt(openPct, 0)}%)`, itemStyle: { color: cOpen } },
      ]), true);
    }
    const hole = q('[data-hole=order]');
    if (hole) hole.innerHTML = `<b>${esc(fmt(ratePct, 0))}%</b><span>出荷完了率</span>`;
    const lg = q('[data-legend=order]');
    if (lg) {
      lg.innerHTML = legendHtml([
        { color: cDone, label: '完了', sub: `${fmt(completed)}件`, value: `${fmt(ratePct, 0)}%` },
        { color: cOpen, label: '未処理', sub: `${fmt(openN)}件`, value: `${fmt(openPct, 0)}%` },
      ]);
    }
  }

  // -------------------------------------------------------------------------
  // 4. 工程別稼働率 — plain divs (lighter than a 4th chart, matches the mockup)
  // -------------------------------------------------------------------------
  function renderStage(k) {
    const kk = k || {};
    const rows = [];
    UTIL_ROWS.forEach((r) => {
      const p = pct(kk[r.key]);
      if (p != null && p > 0) rows.push({ label: r.label, p });
    });
    const bars = q('[data-bars=stage]');
    if (!rows.length) { setEmpty('stage', true); if (bars) bars.innerHTML = ''; return; }
    setEmpty('stage', false);
    if (!bars) return;
    bars.innerHTML = rows.map((r) => {
      const w = Math.max(2, Math.min(100, r.p));
      const c = toneColor(utilTone(r.p));
      return `<div class="drail-bar">
        <span class="bl">${esc(r.label)}</span>
        <span class="bt"><i style="width:${w.toFixed(1)}%;background:${esc(c)}"></i></span>
        <span class="bv">${esc(fmt(r.p, 0))}%</span>
      </div>`;
    }).join('');
  }

  function render() {
    pending = false;
    const k = cur && cur.hasRun && cur.kpis && typeof cur.kpis === 'object' ? cur.kpis : null;
    // Each card guards itself so one bad block cannot blank the whole rail.
    try { renderTrend(k); } catch (_) { setEmpty('trend', true); }
    try { renderUtil(k); } catch (_) { setEmpty('util', true); }
    try { renderOrder(k); } catch (_) { setEmpty('order', true); }
    try { renderStage(k); } catch (_) { setEmpty('stage', true); }
  }

  // Range select (全体 / 直近) — only the trend card cares.
  const onChange = (ev) => {
    const sel = ev.target && ev.target.closest ? ev.target.closest('[data-sel=range]') : null;
    if (!sel) return;
    range = sel.value === 'recent' ? 'recent' : 'all';
    try { renderTrend(cur && cur.hasRun ? cur.kpis : null); } catch (_) { setEmpty('trend', true); }
  };
  root.addEventListener('change', onChange);

  // Layout changes: retry a deferred init, otherwise just re-measure.
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      if (pending) { try { render(); } catch (_) { /* never-blocks */ } return; }
      Object.keys(charts).forEach((key) => { if (charts[key]) { try { charts[key].resize(); } catch (_) { /* noop */ } } });
    });
    try { ro.observe(root); } catch (_) { ro = null; }
  }

  // Theme flip: token colours were baked into the options, so redraw.
  let mo = null;
  if (typeof MutationObserver !== 'undefined') {
    mo = new MutationObserver(() => { try { render(); } catch (_) { /* never-blocks */ } });
    try {
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    } catch (_) { mo = null; }
  }

  render();

  return {
    update(next) {
      cur = next || cur;
      try { render(); } catch (_) { /* never-blocks */ }
    },
    resize() {
      if (pending) { try { render(); } catch (_) { /* never-blocks */ } return; }
      Object.keys(charts).forEach((key) => { if (charts[key]) { try { charts[key].resize(); } catch (_) { /* noop */ } } });
    },
    dispose() {
      root.removeEventListener('change', onChange);
      if (ro) { try { ro.disconnect(); } catch (_) { /* noop */ } ro = null; }
      if (mo) { try { mo.disconnect(); } catch (_) { /* noop */ } mo = null; }
      Object.keys(charts).forEach(killChart);
      host.innerHTML = '';
    },
  };
}
