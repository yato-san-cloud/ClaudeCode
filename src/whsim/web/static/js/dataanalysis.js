// dataanalysis.js — 物量サマリタブ: WMS 実データ分析 (3PL エンジン統合のフロント)。
// ②分析の着地点（分析ホーム）: 事実チップ＋「対話分析」「基礎物量」へのドリルを先頭に表示.
// サンプル or アップロード → /api/analysis/* → KPI・インサイト・チャートを描画.
// チャートは ECharts (市販BI級): 物量推移(エリア+dataZoom)・ABCパレート(棒+累積%)・
// 曜日別ピーク(棒)・時間帯ピーク(棒)・時間帯別必要人員(エリア). 自己完結 (テーマは
// CSS 変数を getComputedStyle で参照し、themechange で再描画).
import { esc } from './util.js';
import * as echarts from 'echarts';
import { ABC_COLOR } from './constants.js';

// Insight-card border colours, keyed by severity (resolved from theme tokens).
const SEV = {
  critical: { c: '#FF5A78', t: '重大' },
  warning:  { c: '#F5B05A', t: '注意' },
  info:     { c: '#34E3FF', t: '情報' },
};
function refreshSevColors() {
  SEV.critical.c = cssColor('--bad', '#FF5A78');
  SEV.warning.c = cssColor('--warn', '#F5B05A');
  SEV.info.c = cssColor('--info', cssColor('--accent', '#34E3FF'));
}
function cssColor(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
// ABC rank palette (shared --rank-a/b/c tokens, falling back to constants).
let RANK_C = { A: ABC_COLOR.A, B: ABC_COLOR.B, C: ABC_COLOR.C };
function refreshRankColors() {
  RANK_C = {
    A: cssColor('--rank-a', ABC_COLOR.A),
    B: cssColor('--rank-b', ABC_COLOR.B),
    C: cssColor('--rank-c', ABC_COLOR.C),
  };
}
const reduceMotion = () => matchMedia('(prefers-reduced-motion:reduce)').matches;
function hexAlpha(hex, a) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) h = '16C0DE';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
// Live design tokens an ECharts option needs (rebuilt per render → theme-aware).
function palette() {
  const accent = cssColor('--accent', '#16C0DE');
  return {
    accent, accentSoft: hexAlpha(accent, 0.4),
    ink: cssColor('--ink-primary', '#37352F'),
    ink2: cssColor('--ink-secondary', 'rgba(55,53,47,0.65)'),
    ink3: cssColor('--ink-tertiary', 'rgba(55,53,47,0.45)'),
    line: cssColor('--line-hair', 'rgba(55,53,47,0.09)'),
    lineStrong: cssColor('--line-strong', 'rgba(55,53,47,0.16)'),
    panel: cssColor('--bg-app', '#FFFFFF'),
    warn: cssColor('--warn', '#B7791F'), bad: cssColor('--bad', '#C4453F'),
    fontMono: cssColor('--font-mono', 'monospace'), fontSans: cssColor('--font-sans', 'sans-serif'),
  };
}
function tipStyle(p) {
  return {
    backgroundColor: p.panel, borderColor: p.lineStrong, borderWidth: 1,
    textStyle: { color: p.ink, fontSize: 12, fontFamily: p.fontSans },
    extraCssText: 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.16);',
  };
}
function toolbox(p) {
  return {
    right: 6, top: 2, iconStyle: { borderColor: p.ink3 },
    emphasis: { iconStyle: { borderColor: p.accent } },
    feature: { saveAsImage: { title: '画像保存', backgroundColor: p.panel, pixelRatio: 2 }, restore: { title: '初期化' } },
  };
}

function injectStyle() {
  if (document.getElementById('da-style')) return;
  const s = document.createElement('style');
  s.id = 'da-style';
  s.textContent = `
  .da{display:flex;flex-direction:column;gap:16px;width:100%;padding:4px 2px 24px}
  /* ── 分析ホーム strip: fact chips + drill links to the other ② sub-views ── */
  .da-home{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
    background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-left:4px solid var(--accent,#16C0DE);border-radius:12px;padding:9px 14px}
  .da-home-t{font-size:var(--fs-sm,12.5px);font-weight:700;color:var(--ink-primary,#16202e)}
  .da-home-chip{display:inline-flex;align-items:baseline;gap:6px;font-size:var(--fs-xs,12px);
    color:var(--ink-secondary,#52677c);background:var(--bg-app,#fff);
    border:1px solid var(--line,rgba(120,140,170,.18));border-radius:999px;padding:3px 10px}
  .da-home-chip i{font-style:normal;font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary,#8195a8)}
  .da-home-chip b{font-weight:700;color:var(--ink-primary,#16202e);font-variant-numeric:tabular-nums}
  .da-home-links{margin-left:auto;display:flex;gap:14px}
  .da-home-link{border:none;background:none;padding:0;font:inherit;font-size:var(--fs-sm,12.5px);
    font-weight:600;color:var(--accent,#16C0DE);cursor:pointer;white-space:nowrap}
  .da-home-link:hover{text-decoration:underline}
  .da-home-link:focus-visible{outline:2px solid var(--accent,#16C0DE);outline-offset:2px}
  @media(max-width:640px){.da-home-links{margin-left:0;flex-basis:100%}}
  .da-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .da-bar .da-btn{padding:var(--sp-2) var(--sp-4);border-radius:10px;border:1px solid var(--accent);
    background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);
    font-weight:600;cursor:pointer;font:inherit}
  .da-bar .da-btn.primary{background:var(--accent);color:var(--ink-onAccent);border:none}
  .da-bar .da-btn:hover{filter:brightness(1.07)}
  .da-bar .da-hint{font-size:var(--fs-xs);color:var(--ink-tertiary,#8195a8)}
  .da-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
  .da-kpi{background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:12px;padding:13px 15px;transition:border-color var(--dur-1) var(--ease-out)}
  .da-kpi:hover{border-color:var(--line-strong)}
  .da-kpi .l{font-size:var(--fs-micro);letter-spacing:.06em;color:var(--ink-tertiary,#8195a8);
    text-transform:uppercase;margin-bottom:7px}
  .da-kpi .v{font-size:var(--fs-title);font-weight:700;color:var(--ink-primary,#16202e);line-height:1.05}
  .da-kpi .v small{font-size:var(--fs-sm);font-weight:500;color:var(--ink-secondary,#52677c)}
  .da-cards{display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-3)}
  @media(max-width:900px){.da-cards{grid-template-columns:1fr}}
  .da-card{background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:14px;padding:var(--sp-5)}
  .da-card h3{margin:0 0 14px;font-size:var(--fs-body);font-weight:600;color:var(--ink-primary,#16202e)}
  .da-ec{width:100%}
  .da-ins{display:flex;flex-direction:column;gap:9px}
  .da-i{display:flex;gap:11px;padding:11px 13px;border-radius:11px;border:1px solid var(--line,rgba(120,140,170,.18));
    background:var(--bg-app,#fff);border-left-width:4px}
  .da-i .ico{font-size:var(--fs-section);line-height:1.3}
  .da-i .ti{font-weight:600;color:var(--ink-primary,#16202e);font-size:var(--fs-sm)}
  .da-i .de{font-size:var(--fs-xs);color:var(--ink-secondary,#52677c);margin-top:3px;line-height:1.5}
  .da-i .su{font-size:var(--fs-micro);color:var(--ink-tertiary,#8195a8);margin-top:5px}
  .da-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
    min-height:300px;text-align:center;color:var(--ink-tertiary,#8195a8)}
  .da-empty b{font-size:var(--fs-title);color:var(--ink-primary,#16202e)}
  .da-chart-empty{display:flex;align-items:center;justify-content:center;min-height:120px;
    color:var(--ink-tertiary,#8195a8);font-size:var(--fs-sm)}
  .da-src{font-size:var(--fs-micro);color:var(--ink-tertiary,#8195a8);font-family:monospace}
  /* ── one-click ingest banner (upload → project orders) ── */
  .da-ingest{display:flex;align-items:center;gap:14px;flex-wrap:wrap;
    background:var(--ok-tint,rgba(52,227,160,.08));border:1px solid var(--ok-line,rgba(52,227,160,.3));
    border-left:4px solid var(--ok,#34c97a);border-radius:12px;padding:12px 16px}
  .da-ingest-t{font-size:var(--fs-sm,12.5px);color:var(--ink-secondary,#52677c);min-width:240px;flex:1}
  .da-ingest-t b{color:var(--ink-primary,#16202e)}
  .da-ingest-sub{display:block;font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary,#8195a8);margin-top:2px}
  .da-ingest .da-btn{white-space:nowrap}
  .da-ingest .da-btn[data-act="master"]{margin-left:auto}
  /* 取込項目の紐付け確認 (column-mapping transparency) */
  .da-map{border:1px solid var(--line,rgba(120,140,170,.18));border-radius:12px;
    padding:10px 14px;background:var(--bg-panel,#f7f6f3)}
  .da-map-h{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary,#8195a8);font-weight:700}
  .da-map-rows{display:flex;gap:8px;flex-wrap:wrap;margin-top:5px}
  .da-map-chip{font-size:var(--fs-xs,12px);color:var(--ink-secondary,#52677c);
    background:var(--bg-app,#fff);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:999px;padding:3px 11px}
  .da-map-chip i{font-style:normal;color:var(--ink-primary,#16202e)}
  .da-map-chip.miss{border-color:var(--warn,#f5b05a)}
  .da-map-chip.miss i{color:var(--warn,#b7791f)}
  .da-clean .da-clean-chip{font-size:var(--fs-xs,12px);color:var(--ink-secondary,#52677c);
    background:var(--bg-app,#fff);border:1px solid var(--line,rgba(120,140,170,.18));border-radius:999px;padding:3px 11px}
  .da-clean-chip b{font-family:var(--font-mono);color:var(--ink-primary,#16202e)}
  .da-clean-chip.warn{border-color:var(--warn,#f5b05a)} .da-clean-chip.warn b{color:var(--warn,#b7791f)}
  .da-clean-chip.bad{border-color:var(--bad,#c4453f)} .da-clean-chip.bad b{color:var(--bad,#c4453f)}
  .da-clean-note{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary,#8195a8);margin-top:5px}
  /* ── drag-and-drop affordance (drop a CSV/Excel anywhere on the panel) ── */
  #dataanalysis.da-drag, .da-drag{position:relative}
  .da-drag::after{content:"⤓ ここにCSV/Excelをドロップして取り込み";
    position:absolute;inset:6px;z-index:30;display:flex;align-items:center;justify-content:center;
    font-family:var(--font-mono);font-size:15px;color:var(--accent);
    background:color-mix(in srgb,var(--bg-app,#fff) 78%,transparent);
    border:2px dashed var(--accent);border-radius:14px;pointer-events:none}
  .da-err{display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:var(--sp-3);min-height:240px;text-align:center;
    border:1px solid var(--line-hair,rgba(120,140,170,.18));border-radius:var(--r-3,14px);
    background:var(--bg-sunken,#f7f6f3);padding:var(--sp-6)}
  .da-err b{font-size:var(--fs-section);color:var(--ink-primary,#16202e)}
  .da-err .da-err-msg{font-size:var(--fs-sm);color:var(--ink-secondary,#52677c);
    font-family:monospace;max-width:48ch;word-break:break-word}
  .da-err .da-retry{padding:var(--sp-2) var(--sp-5);border-radius:10px;border:none;
    background:var(--accent);color:var(--ink-onAccent);font-weight:600;cursor:pointer;font:inherit;
    transition:filter var(--dur-1,.12s) var(--ease-out,ease)}
  .da-err .da-retry:hover{filter:brightness(1.07)}
  @media(prefers-reduced-motion:reduce){.da-err .da-retry{transition:none}}
  `;
  document.head.appendChild(s);
}

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
const pct = (n) => (n == null ? '—' : (n * 100).toFixed(0) + '%');

// ── ECharts option builders. Each returns an option object (or null when the
// data array is empty, so the caller can show a friendly placeholder). ──────

// daily quantity area + dataZoom scrub
function trendOption(rows) {
  if (!rows || !rows.length) return null;
  const p = palette();
  const cats = rows.map((r) => r.label || '');
  const vals = rows.map((r) => r.qty || 0);
  return {
    animation: !reduceMotion(),
    grid: { left: 52, right: 18, top: 16, bottom: rows.length > 1 ? 56 : 30 },
    toolbox: toolbox(p),
    tooltip: { trigger: 'axis', ...tipStyle(p), formatter: (ps) => `<b>${esc(ps[0].axisValue)}</b> · ${fmt(ps[0].data)}` },
    dataZoom: rows.length > 8 ? [
      { type: 'inside' },
      { type: 'slider', height: 20, bottom: 16, borderColor: p.line, fillerColor: hexAlpha(p.accent, 0.14),
        handleStyle: { color: p.accent }, textStyle: { color: p.ink3, fontFamily: p.fontMono } },
    ] : undefined,
    xAxis: { type: 'category', data: cats, boundaryGap: false,
      axisLabel: { color: p.ink3, fontFamily: p.fontMono, hideOverlap: true },
      axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: { color: p.ink3, fontFamily: p.fontMono }, splitLine: { lineStyle: { color: p.line } } },
    series: [{
      name: '物量', type: 'line', data: vals, showSymbol: false, symbol: 'circle', symbolSize: 4,
      lineStyle: { color: p.accent, width: 2 }, itemStyle: { color: p.accent },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: hexAlpha(p.accent, 0.22) }, { offset: 1, color: hexAlpha(p.accent, 0.02) }]) },
      markPoint: { symbol: 'pin', symbolSize: 38, data: [{ type: 'max', name: '最大' }],
        itemStyle: { color: p.accent }, label: { color: p.panel, fontSize: 9, fontFamily: p.fontMono } },
    }],
  };
}

// ABC: top-N SKU bars coloured by rank + cumulative % line (Pareto, dual axis)
function abcOption(rows) {
  if (!rows || !rows.length) return null;
  const p = palette();
  const top = rows.slice(0, 20);
  const tot = rows.reduce((s, r) => s + (r.qty || 0), 0) || 1;
  let acc = 0;
  const cum = top.map((r) => { acc += (r.qty || 0) / tot; return Math.min(1, acc) * 100; });
  const colOf = (r) => RANK_C[r.rank] || RANK_C.C;
  return {
    animation: !reduceMotion(),
    grid: { left: 52, right: 50, top: 24, bottom: top.length > 10 ? 60 : 34 },
    toolbox: toolbox(p),
    legend: { top: 0, right: 86, icon: 'roundRect', itemWidth: 10, itemHeight: 10, selectedMode: false,
      data: ['A (〜70%)', 'B (〜90%)', 'C'], textStyle: { color: p.ink3, fontSize: 10, fontFamily: p.fontMono } },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...tipStyle(p),
      formatter: (ps) => { const i = ps[0].dataIndex; const r = top[i]; return `<b>${esc(r.sku)}</b><br>物量 ${fmt(r.qty)} · ランク ${esc(r.rank)}<br>累積 ${pct(cum[i] / 100)}`; } },
    xAxis: { type: 'category', data: top.map((r) => r.sku),
      axisLabel: { color: p.ink3, fontFamily: p.fontMono, rotate: top.length > 8 ? 40 : 0, interval: 0, hideOverlap: true,
        formatter: (v) => (String(v).length > 8 ? `${String(v).slice(0, 8)}…` : v) },
      axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false } },
    yAxis: [
      { type: 'value', name: '物量', nameTextStyle: { color: p.ink3, fontSize: 10, fontFamily: p.fontMono },
        axisLabel: { color: p.ink3, fontFamily: p.fontMono }, splitLine: { lineStyle: { color: p.line } } },
      { type: 'value', name: '累積%', min: 0, max: 100, nameTextStyle: { color: p.ink3, fontSize: 10, fontFamily: p.fontMono },
        axisLabel: { color: p.ink3, fontFamily: p.fontMono, formatter: '{value}%' }, splitLine: { show: false } },
    ],
    series: [
      { name: 'A (〜70%)', type: 'bar', data: [], itemStyle: { color: RANK_C.A } },
      { name: 'B (〜90%)', type: 'bar', data: [], itemStyle: { color: RANK_C.B } },
      { name: 'C', type: 'bar', data: [], itemStyle: { color: RANK_C.C } },
      { name: '物量', type: 'bar', yAxisIndex: 0, barMaxWidth: 30,
        data: top.map((r) => ({ value: r.qty || 0, itemStyle: { color: colOf(r) } })) },
      { name: '累積%', type: 'line', yAxisIndex: 1, data: cum, symbol: 'circle', symbolSize: 5,
        lineStyle: { color: p.accent, width: 2 }, itemStyle: { color: p.accent }, z: 5,
        // 70/90% ABC band guides ride the cumulative-% series so they map to the
        // percentage axis (yAxisIndex 1), not the 物量 scale.
        markLine: { silent: true, symbol: 'none', label: { color: p.ink2, fontFamily: p.fontMono, fontSize: 9, formatter: '{b}' },
          data: [
            { yAxis: 70, name: '70%', lineStyle: { color: p.warn, type: 'dashed' } },
            { yAxis: 90, name: '90%', lineStyle: { color: p.bad, type: 'dashed' } },
          ] } },
    ],
  };
}

// peak: weekday bars
function weekdayOption(rows) {
  if (!rows || !rows.length) return null;
  const p = palette();
  return {
    animation: !reduceMotion(),
    grid: { left: 46, right: 16, top: 14, bottom: 28 },
    toolbox: toolbox(p),
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...tipStyle(p),
      formatter: (ps) => `<b>${esc(ps[0].axisValue)}</b> · ${fmt(ps[0].data)}` },
    xAxis: { type: 'category', data: rows.map((r) => r.weekday),
      axisLabel: { color: p.ink2, fontFamily: p.fontMono }, axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: { color: p.ink3, fontFamily: p.fontMono }, splitLine: { lineStyle: { color: p.line } } },
    series: [{ type: 'bar', data: rows.map((r) => r.qty || 0), barMaxWidth: 38,
      itemStyle: { color: p.accent, borderRadius: [4, 4, 0, 0] } }],
  };
}

// peak: hourly bars (0..23)
function hourOption(rows) {
  if (!rows || !rows.length) return null;
  const p = palette();
  return {
    animation: !reduceMotion(),
    grid: { left: 44, right: 16, top: 14, bottom: 26 },
    toolbox: toolbox(p),
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...tipStyle(p),
      formatter: (ps) => `<b>${esc(ps[0].axisValue)}時</b> · ${fmt(ps[0].data)}` },
    xAxis: { type: 'category', data: rows.map((r) => r.hour),
      axisLabel: { color: p.ink3, fontFamily: p.fontMono, interval: 3 },
      axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: { color: p.ink3, fontFamily: p.fontMono }, splitLine: { lineStyle: { color: p.line } } },
    series: [{ type: 'bar', data: rows.map((r) => r.qty || 0), barMaxWidth: 18, itemStyle: { color: hexAlpha(p.accent, 0.6) } }],
  };
}

// 24-hour total required-headcount area chart.
function headcountOption(hours) {
  if (!hours || !hours.length) return null;
  const p = palette();
  return {
    animation: !reduceMotion(),
    grid: { left: 40, right: 16, top: 16, bottom: 26 },
    toolbox: toolbox(p),
    tooltip: { trigger: 'axis', ...tipStyle(p), formatter: (ps) => `<b>${esc(ps[0].axisValue)}時</b> · ${fmt(ps[0].data)} 名` },
    xAxis: { type: 'category', data: hours.map((_, i) => i), boundaryGap: false,
      axisLabel: { color: p.ink3, fontFamily: p.fontMono, interval: 3 },
      axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: { color: p.ink3, fontFamily: p.fontMono }, splitLine: { lineStyle: { color: p.line } }, minInterval: 1 },
    series: [{ type: 'line', data: hours, step: 'middle', showSymbol: false,
      lineStyle: { color: p.accent, width: 2 }, itemStyle: { color: p.accent },
      areaStyle: { color: hexAlpha(p.accent, 0.16) },
      markPoint: { symbol: 'pin', symbolSize: 36, data: [{ type: 'max', name: '最大' }],
        itemStyle: { color: p.accent }, label: { color: p.panel, fontSize: 9, fontFamily: p.fontMono } } }],
  };
}

function kpiCards(k) {
  if (!k) return '';
  const cards = [
    ['総出荷ピース', fmt(k.total_pcs_out)],
    ['総出荷ライン', fmt(k.total_lines_out)],
    ['総オーダー', fmt(k.total_orders)],
    ['稼働SKU', `${fmt(k.sku_active)}<small> / ${fmt(k.sku_master)}</small>`],
    ['上位10%SKU集中', pct(k.top10_sku_share)],
    ['平均在庫回転', k.avg_turnover != null ? Number(k.avg_turnover).toFixed(2) : '—'],
    ['デッドストック率', pct(k.dead_sku_rate)],
    ['ピーク', `${k.peak_weekday || '—'}<small> ${fmt(k.peak_day_qty)}</small>`],
  ];
  return `<div class="da-grid">${cards.map(([l, v]) =>
    `<div class="da-kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}</div>`;
}

function insightList(ins) {
  if (!ins || !ins.length) return '<div class="da-empty">指摘事項はありません。</div>';
  return `<div class="da-ins">${ins.map((i) => {
    const sv = SEV[i.severity] || SEV.info;
    return `<div class="da-i" style="border-left-color:${sv.c}">
      <div class="ico">${i.icon || '•'}</div>
      <div><div class="ti">${i.title}</div>
        ${i.detail ? `<div class="de">${i.detail}</div>` : ''}
        ${i.suggestion ? `<div class="su">💡 ${i.suggestion}</div>` : ''}</div></div>`;
  }).join('')}</div>`;
}

function staffingCard(s) {
  if (!s || !s.processes || !s.processes.length) return '';
  const rows = s.processes.map((p) =>
    `<tr><td>${p.id}</td><td style="text-align:right">${fmt(p.daily_volume)}</td>` +
    `<td style="text-align:right;color:var(--ink-tertiary,#889)">${p.productivity}${p.unit}</td>` +
    `<td style="text-align:right;font-weight:700">${p.peak_headcount} 名</td>` +
    `<td style="text-align:right">${p.man_hours} 人時</td></tr>`).join('');
  return `<div class="da-card" style="grid-column:1/-1">
    <h3>工程別 必要人員（実データ由来・平均日）</h3>
    <div class="da-grid" style="margin-bottom:12px">
      <div class="da-kpi"><div class="l">ピーク人員</div><div class="v">${s.peak_headcount} <small>名</small></div></div>
      <div class="da-kpi"><div class="l">総工数</div><div class="v">${fmt(s.total_man_hours)} <small>人時/日</small></div></div>
      <div class="da-kpi"><div class="l">対象稼働日数</div><div class="v">${fmt(s.operating_days)} <small>日</small></div></div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:var(--fs-xs)">
      <thead><tr style="color:var(--ink-tertiary,#889);text-align:left">
        <th>工程</th><th style="text-align:right">日量</th><th style="text-align:right">生産性</th>
        <th style="text-align:right">ピーク</th><th style="text-align:right">工数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h3 style="margin:16px 0 6px">時間帯別 必要人員（合計）</h3>
    <div class="da-ec" data-ec="headcount" style="height:170px"></div>
    <div style="margin-top:12px"><button class="da-btn" data-act="to-timetable">タイムチャートで人員配置を見る →</button></div>
  </div>`;
}

// ②分析 landing header (分析ホーム): a slim strip of fact chips derived from the
// already-fetched bundle (「—」 when absent) + drill links to the sibling ② views
// (対話分析 / 基礎物量) via the shell's `whsim:nav` CustomEvent. Pure render;
// links are wired in wire().
function homeHeader(b) {
  const k = (b && b.kpis) || null;
  // ABC構成: A-rank share of total qty, re-derived from the ABC rows.
  let aShare = null;
  const abc = (b && b.abc_sku) || [];
  if (abc.length) {
    const tot = abc.reduce((s, r) => s + (r.qty || 0), 0);
    if (tot > 0) aShare = abc.reduce((s, r) => s + (r.rank === 'A' ? (r.qty || 0) : 0), 0) / tot;
  }
  const chips = [
    ['総物量', k && k.total_pcs_out != null ? `${fmt(k.total_pcs_out)} pcs` : '—'],
    ['ABC構成', aShare != null ? `A品 ${pct(aShare)}` : '—'],
    ['ピーク曜日', k && k.peak_weekday ? esc(k.peak_weekday) : '—'],
  ];
  return `<div class="da-home" role="navigation" aria-label="分析ホーム">
    <span class="da-home-t">分析ホーム</span>
    ${chips.map(([l, v]) => `<span class="da-home-chip"><i>${l}</i><b>${v}</b></span>`).join('')}
    <span class="da-home-links">
      <button type="button" class="da-home-link" data-nav="bianalytics">対話分析 →</button>
      <button type="button" class="da-home-link" data-nav="bi">基礎物量 →</button>
    </span>
  </div>`;
}

// A chart card whose body is an ECharts mount node (id) or a friendly empty note.
function chartCard(title, id, hasData, full) {
  const body = hasData
    ? `<div class="da-ec" data-ec="${id}" style="height:200px"></div>`
    : `<div class="da-chart-empty">データなし</div>`;
  return `<div class="da-card"${full ? ' style="grid-column:1/-1"' : ''}><h3>${title}</h3>${body}</div>`;
}

export function mountDataAnalysis(el, opts = {}) {
  injectStyle();
  refreshRankColors();
  refreshSevColors();
  const root = document.createElement('div');
  root.className = 'da';
  el.innerHTML = '';
  el.appendChild(root);
  setupDropZone();
  let bundle = null;
  let lastFile = null;   // remember the upload so it can be ingested into the model
  let masterFile = null; // optional 商品マスタ (入数/名前/ABC enrichment)
  let lastImport = null; // last ingest result (mapping/summary) for the 確認 panel
  const toast = opts.toast || (() => {});
  const getProject = opts.getProject || (() => null);

  // ── ECharts registry: id → instance; disposed each render so no leaks. ──
  const charts = new Map();
  let ro = null;
  function disposeCharts() {
    charts.forEach((c) => { try { c.dispose(); } catch (_) { /* noop */ } });
    charts.clear();
  }
  function mountChart(id, option) {
    const node = root.querySelector(`[data-ec="${id}"]`);
    if (!node || !option) return;
    const inst = echarts.init(node, null, { renderer: 'canvas' });
    inst.setOption(option);
    charts.set(id, inst);
    if (ro) ro.observe(node);
  }
  function resizeAll() { charts.forEach((c) => { try { c.resize(); } catch (_) { /* noop */ } }); }
  const onWinResize = () => resizeAll();
  window.addEventListener('resize', onWinResize);
  if (typeof ResizeObserver !== 'undefined') ro = new ResizeObserver(() => resizeAll());

  // Build all charts for the current bundle (called after the DOM is laid out).
  function mountAllCharts(b) {
    if (!b) return;
    mountChart('trend', trendOption(b.trend_daily));
    mountChart('abc', abcOption(b.abc_sku));
    mountChart('weekday', weekdayOption(b.peak && b.peak.by_weekday));
    mountChart('hour', hourOption(b.peak && b.peak.by_hour));
    if (b.staffing) mountChart('headcount', headcountOption(b.staffing.total_headcount_by_hour));
  }

  function render(b) {
    disposeCharts();
    root.innerHTML =
      homeHeader(b) +
      `<div class="da-bar">
         <button class="da-btn primary" data-act="sample">▶ サンプルで試す</button>
         <button class="da-btn" data-act="upload">出荷データを取り込む</button>
         <input type="file" data-da-file accept=".csv,.xlsx,.xls,.json" hidden />
         <span class="da-hint">出荷WMSデータ(CSV/Excel)から物量推移・ABC・ピーク・在庫を分析</span>
         ${b && b.source ? `<span class="da-src" style="margin-left:auto">source: ${b.source}</span>` : ''}
       </div>` +
      // After an upload, offer one-click ingest into the project model (so BI +
      // SimPy use the real demand). Hidden for the bundled sample.
      (lastFile && b && b.source === 'upload'
        ? `<div class="da-ingest">
             <div class="da-ingest-t">「${esc(lastFile.name)}」を読み込みました。
               <b>このデータでシミュレーションしますか？</b>
               <span class="da-ingest-sub">出荷明細をオーダーとして取り込み、対話分析・基礎物量・実行に反映します。
               <br>商品マスタ（任意）を足すと <b>入数(CS入数)</b> が反映され、ケース/パレット/坪数の精度が上がります。
               <span data-master-name style="color:var(--accent)">${masterFile ? `商品マスタ: ${esc(masterFile.name)}` : ''}</span></span></div>
             <input type="file" data-da-master accept=".csv,.xlsx,.xls,.json" hidden />
             <button class="da-btn" data-act="master">＋ 商品マスタ（任意）</button>
             <button class="da-btn primary" data-act="ingest">このデータでシミュレーション（取り込む）→</button>
           </div>`
        : '') +
      (lastImport && lastImport.mapping
        ? `<div class="da-map">
             <div class="da-map-h">取込項目の紐付け（自動）</div>
             <div class="da-map-rows">${lastImport.mapping.map((mp) =>
               `<span class="da-map-chip${mp.column ? '' : ' miss'}">${esc(mp.field)}
                  <i>→ ${mp.column ? esc(mp.column) : '未検出'}</i></span>`).join('')}
             </div>${(lastImport.item_mapping || []).length
               ? `<div class="da-map-h" style="margin-top:6px">商品マスタの紐付け</div>
                  <div class="da-map-rows">${lastImport.item_mapping.map((mp) =>
                    `<span class="da-map-chip${mp.column ? '' : ' miss'}">${esc(mp.field)}
                       <i>→ ${mp.column ? esc(mp.column) : '未検出'}</i></span>`).join('')}</div>` : ''}
             ${cleansingHtml(lastImport.summary && lastImport.summary.cleansing)}
           </div>`
        : '') +
      (b
        ? kpiCards(b.kpis) +
          `<div class="da-cards">
             <div class="da-card"><h3>自動インサイト</h3>${insightList(b.insights)}</div>
             ${chartCard('物量推移（日次）', 'trend', !!(b.trend_daily && b.trend_daily.length))}
             ${chartCard('ABCパレート（上位SKU）', 'abc', !!(b.abc_sku && b.abc_sku.length))}
             ${chartCard('曜日別ピーク', 'weekday', !!(b.peak && b.peak.by_weekday && b.peak.by_weekday.length))}
             ${chartCard('時間帯別ピーク', 'hour', !!(b.peak && b.peak.by_hour && b.peak.by_hour.length), true)}
             ${staffingCard(b.staffing)}
           </div>`
        : `<div class="da-empty"><b>WMSデータを分析</b>
             <div>「サンプルで試す」ですぐ確認、または出荷データを取り込んでください。</div>
             <div data-da-projhint></div></div>`);
    wire();
    mountAllCharts(b);
    hintProjectData();
  }

  // The 物量サマリ analyses a *file*; a project that ALREADY carries imported
  // orders looks confusingly "empty" here. Detect that case and point at the
  // project-data views (対話分析/基礎物量) so nobody re-uploads what's already in.
  async function hintProjectData() {
    const slot = root.querySelector('[data-da-projhint]');
    const proj = getProject();
    if (!slot || !proj) return;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(proj)}/bi/volumes`);
      if (!r.ok) return;
      const v = await r.json();
      const orders = Number(v && (v.out_orders ?? (v.totals && v.totals.out_orders))) || 0;
      if (!orders) return;
      slot.innerHTML =
        `<div style="margin-top:10px;padding:10px 14px;border:1px solid var(--accent);border-radius:10px;
                     background:color-mix(in srgb,var(--accent) 8%,transparent);font-size:12.5px;max-width:52ch;">
           このプロジェクトには<b>取込済みの実データ</b>があります（この画面はファイル単体の分析用）。
           プロジェクトのデータは
           <a href="#" data-nav="bianalytics" style="color:var(--accent);font-weight:700">対話分析</a> ・
           <a href="#" data-nav="bi" style="color:var(--accent);font-weight:700">基礎物量</a> で確認できます。
         </div>`;
      slot.querySelectorAll('[data-nav]').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('whsim:nav', { detail: { view: a.dataset.nav } }));
        });
      });
    } catch (_e) { /* hint only — stay silent */ }
  }

  // `makePromise` is a thunk so the same fetch can be re-invoked by 再試行.
  async function load(makePromise, label) {
    root.querySelectorAll('[data-act]').forEach((b) => (b.disabled = true));
    const bar = root.querySelector('.da-hint');
    if (bar) bar.textContent = label;
    try {
      bundle = await makePromise();
      render(bundle);
    } catch (e) {
      toast('分析に失敗しました: ' + e.message, 'error');
      renderError(e, makePromise, label);
    }
  }
  function renderError(e, makePromise, label) {
    disposeCharts();
    root.querySelectorAll('[data-act]').forEach((b) => (b.disabled = false));
    const bar = root.querySelector('.da-hint');
    if (bar) bar.textContent = 'エラーが発生しました';
    let panel = root.querySelector('.da-err');
    if (!panel) { panel = document.createElement('div'); panel.className = 'da-err'; root.appendChild(panel); }
    panel.innerHTML =
      `<b>読み込めませんでした</b>` +
      `<div class="da-err-msg">${esc(e && e.message ? e.message : e)}</div>` +
      `<button type="button" class="da-retry">再試行</button>`;
    panel.querySelector('.da-retry').onclick = () => { panel.remove(); load(makePromise, label); };
  }
  async function getJSON(url, opt) {
    const r = await fetch(url, opt);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  }
  function wire() {
    // 分析ホーム drill links → sibling ② views (the shell listens for whsim:nav).
    root.querySelectorAll('.da-home-link[data-nav]').forEach((btn) => {
      btn.onclick = () => document.dispatchEvent(
        new CustomEvent('whsim:nav', { detail: { view: btn.dataset.nav } }));
    });
    const fileInput = root.querySelector('[data-da-file]');
    const sample = root.querySelector('[data-act="sample"]');
    if (sample) sample.onclick = () => load(() => getJSON('/api/analysis/sample'), 'サンプルデータを分析中…');
    const upload = root.querySelector('[data-act="upload"]');
    if (upload) upload.onclick = () => fileInput.click();
    const ttBtn = root.querySelector('[data-act="to-timetable"]');
    if (ttBtn) ttBtn.onclick = () => document.dispatchEvent(new CustomEvent(
      'whsim:load-timetable', { detail: { scenario: bundle && bundle.timetable_scenario } }));
    if (fileInput) fileInput.onchange = () => analyzeFile(fileInput.files[0]);
    const ingest = root.querySelector('[data-act="ingest"]');
    if (ingest) ingest.onclick = () => ingestFile();
    const masterBtn = root.querySelector('[data-act="master"]');
    const masterInput = root.querySelector('[data-da-master]');
    if (masterBtn && masterInput) masterBtn.onclick = () => masterInput.click();
    if (masterInput) masterInput.onchange = () => {
      masterFile = masterInput.files[0] || null;
      const lab = root.querySelector('[data-master-name]');
      if (lab) lab.textContent = masterFile ? `商品マスタ: ${masterFile.name}` : '';
    };
  }

  // クレンジング確認 (SLC「異常値タブ」の軽量版): 取込時に落とした行と異常値を表示。
  function cleansingHtml(c) {
    if (!c) return '';
    const chip = (label, n, cls) => (n
      ? `<span class="da-clean-chip${cls ? ' ' + cls : ''}">${label} <b>${Number(n).toLocaleString()}</b></span>` : '');
    const chips = [
      chip('読込行', c.rows_in, ''),
      chip('SKU空で除外', c.dropped_no_sku, 'warn'),
      chip('数量0で除外', c.dropped_zero_qty, 'warn'),
      chip('日付不正(仮timeline)', c.bad_date, 'warn'),
      chip('数量の異常値', c.qty_outliers, 'bad'),
    ].filter(Boolean).join('');
    if (!chips) return '';
    const note = c.qty_outliers
      ? `中央値 ${esc(String(c.qty_median))} に対し最大 ${esc(String(c.qty_max))}。元データの確認をおすすめします。`
      : '除外行はオーダー化していません（元データ修正で取り込めます）。';
    return `<div class="da-map-h" style="margin-top:8px">クレンジング確認</div>
      <div class="da-map-rows da-clean">${chips}</div>
      <div class="da-clean-note">${note}</div>`;
  }

  // Analyze an uploaded shipments file (describe it) and remember it so the user
  // can then ingest it into the project with one click.
  function analyzeFile(f) {
    if (!f) return;
    lastFile = f;
    load(() => {
      const fd = new FormData();
      fd.append('shipments', f);
      return getJSON('/api/analysis/upload', { method: 'POST', body: fd });
    }, `「${f.name}」を分析中…`);
  }

  // ETL: push the uploaded shipments into the project's outbound orders, so the
  // BI (対話分析) and the SimPy run use the REAL demand. Then refresh + jump to
  // 対話分析 so the effect is immediate.
  async function ingestFile() {
    const f = lastFile;
    const proj = getProject();
    if (!f) { toast('先に出荷データを取り込んでください。', 'error'); return; }
    if (!proj) { toast('先にプロジェクトを作成してください（左上の「作成」）。', 'error'); return; }
    const btn = root.querySelector('[data-act="ingest"]');
    if (btn) { btn.disabled = true; btn.textContent = '取り込み中…'; }
    try {
      const fd = new FormData();
      fd.append('shipments', f);
      if (masterFile) fd.append('items', masterFile);    // optional 商品マスタ
      const r = await getJSON(`/api/projects/${encodeURIComponent(proj)}/import/shipments`,
        { method: 'POST', body: fd });
      if (!r || !r.ok) { toast((r && r.message) || '取り込める明細がありませんでした。', 'error'); }
      else {
        toast(r.message || '取り込みました。', 'ok');
        lastImport = r;          // remember the mapping so render() can show it
        render(bundle);          // re-render to surface the 紐付け確認 panel
        // Refresh provenance / 実データ% / readiness, then show the BI on real data.
        document.dispatchEvent(new CustomEvent('whsim:model-changed', { detail: { nav: 'bianalytics' } }));
      }
    } catch (e) {
      toast('取り込みに失敗: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'このデータでシミュレーション（取り込む）→'; }
    }
  }

  // Drag-and-drop a file anywhere on the panel → analyze it. Attached once to the
  // panel element (survives render()'s innerHTML swaps of `root`).
  function setupDropZone() {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    let depth = 0; // dragenter/leave fire per child; count to know when we truly left
    el.addEventListener('dragenter', (e) => { stop(e); depth += 1; el.classList.add('da-drag'); });
    el.addEventListener('dragover', stop);
    el.addEventListener('dragleave', (e) => { stop(e); depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('da-drag'); });
    el.addEventListener('drop', (e) => {
      stop(e); depth = 0; el.classList.remove('da-drag');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) analyzeFile(f);
    });
  }
  render(bundle);

  // Re-render the current bundle (no refetch) and re-wire on theme flip so chart
  // paints (resolved at build time) pick up the new tokens.
  const onTheme = () => { refreshRankColors(); refreshSevColors(); render(bundle); };
  document.addEventListener('themechange', onTheme);

  return {
    dispose() {
      document.removeEventListener('themechange', onTheme);
      disposeCharts();
      if (ro) { ro.disconnect(); ro = null; }
      window.removeEventListener('resize', onWinResize);
      el.innerHTML = '';
    },
    refresh() {},
  };
}
