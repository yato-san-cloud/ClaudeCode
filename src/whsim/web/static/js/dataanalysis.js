// dataanalysis.js — 物量サマリタブ: WMS 実データ分析 (3PL エンジン統合のフロント)。
// ②分析の着地点（分析ホーム）: 事実チップ＋「対話分析」「基礎物量」へのドリルを先頭に表示.
// 導線は PROJECT-FIRST (B3): 既定で①取込済みのプロジェクト出荷データを自動分析
// (/api/projects/<name>/analysis/bundle)。手元ファイル単体の下見は明示的な副導線
// 「ファイル単体でためす（保存しません）」に格下げし、そこから reviewShipments()
// で①取込へワンクリックで橋渡しする (import ロジックは複製しない)。
// チャートは ECharts (市販BI級): 物量推移(エリア+dataZoom)・ABCパレート(棒+累積%)・
// 曜日別ピーク(棒)・時間帯ピーク(棒)・時間帯別必要人員(エリア). 自己完結 (テーマは
// CSS 変数を getComputedStyle で参照し、themechange で再描画).
import { esc } from './util.js';
import * as echarts from 'echarts';
import { ABC_COLOR } from './constants.js';
// ①取込の出荷ETL seam (副導線「このデータをプロジェクトへ取込」で再利用; 複製しない).
import { reviewShipments } from './imports.js';

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
  /* Full-bleed dashboard: a 6-track grid so each chart row fills the viewport
     width (trend+weekday / ABC+hour), with chart heights tied to the viewport
     so the 全体感 is visible without scrolling on a normal screen. */
  .da-cards{display:grid;grid-template-columns:repeat(6,1fr);gap:var(--sp-3)}
  .da-card.sp4{grid-column:span 4}.da-card.sp2{grid-column:span 2}
  .da-card.sp6,.da-card.full{grid-column:1/-1}
  @media(max-width:1100px){.da-card.sp4,.da-card.sp2{grid-column:1/-1}}
  .da-card{background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:14px;padding:var(--sp-5);min-width:0}
  .da-card h3{margin:0 0 14px;font-size:var(--fs-body);font-weight:600;color:var(--ink-primary,#16202e)}
  .da-ec{width:100%}
  .da-ins{display:flex;flex-direction:column;gap:9px}
  /* ── 自動インサイト: compact collapsible strip (collapsed by default) ── */
  .da-insx{border:1px solid var(--line,rgba(120,140,170,.18));border-radius:12px;
    background:var(--bg-panel,#f7f6f3)}
  .da-insx>summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap;cursor:pointer;
    padding:8px 14px;font-size:var(--fs-sm,12.5px);font-weight:600;color:var(--ink-primary,#16202e);
    list-style:none;user-select:none}
  .da-insx>summary::-webkit-details-marker{display:none}
  .da-insx>summary::after{content:"▸";margin-left:auto;color:var(--ink-tertiary,#8195a8);
    transition:transform var(--dur-1,.12s) var(--ease-out,ease)}
  .da-insx[open]>summary::after{transform:rotate(90deg)}
  .da-insx-chip{display:inline-flex;align-items:center;gap:5px;font-size:var(--fs-micro,10.5px);
    font-weight:700;border-radius:999px;padding:2px 9px;border:1px solid var(--line,rgba(120,140,170,.18));
    background:var(--bg-app,#fff)}
  .da-insx-top{font-weight:500;color:var(--ink-secondary,#52677c);font-size:var(--fs-xs,12px);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46ch}
  .da-insx-body{padding:4px 12px 12px}
  @media(prefers-reduced-motion:reduce){.da-insx>summary::after{transition:none}}
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
  /* ── 在庫最適化 (安全在庫・発注点) card ── */
  .da-inv{display:flex;flex-direction:column;gap:12px}
  .da-inv-ctrls{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end}
  .da-inv-f{display:flex;flex-direction:column;gap:4px}
  .da-inv-f label{font-size:var(--fs-micro,10.5px);letter-spacing:.04em;
    color:var(--ink-tertiary,#8195a8);text-transform:uppercase}
  .da-inv-f input,.da-inv-f select{font:inherit;font-size:var(--fs-sm,12.5px);
    color:var(--ink-primary,#16202e);background:var(--bg-app,#fff);
    border:1px solid var(--line,rgba(120,140,170,.18));border-radius:8px;padding:5px 9px}
  .da-inv-f input{width:88px;font-variant-numeric:tabular-nums}
  .da-inv-f input:focus,.da-inv-f select:focus{outline:2px solid var(--accent,#16C0DE);outline-offset:1px}
  .da-inv-sum{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .da-inv-chip{display:inline-flex;align-items:baseline;gap:6px;font-size:var(--fs-xs,12px);
    color:var(--ink-secondary,#52677c);background:var(--bg-app,#fff);
    border:1px solid var(--line,rgba(120,140,170,.18));border-radius:999px;padding:3px 11px}
  .da-inv-chip i{font-style:normal;font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary,#8195a8)}
  .da-inv-chip b{font-weight:700;color:var(--ink-primary,#16202e);font-variant-numeric:tabular-nums}
  .da-inv-tbl-wrap{max-height:360px;overflow:auto;border:1px solid var(--line,rgba(120,140,170,.18));border-radius:10px}
  table.da-inv-tbl{width:100%;border-collapse:collapse;font-size:var(--fs-xs,12px)}
  table.da-inv-tbl th,table.da-inv-tbl td{padding:6px 10px;text-align:right;white-space:nowrap}
  table.da-inv-tbl th:first-child,table.da-inv-tbl td:first-child{text-align:left}
  table.da-inv-tbl thead th{position:sticky;top:0;z-index:1;background:var(--bg-panel,#f7f6f3);
    color:var(--ink-tertiary,#8195a8);font-weight:600;
    border-bottom:1px solid var(--line-strong,rgba(120,140,170,.3))}
  table.da-inv-tbl td{color:var(--ink-secondary,#52677c);font-variant-numeric:tabular-nums;
    border-bottom:1px solid var(--line,rgba(120,140,170,.12))}
  table.da-inv-tbl td:first-child{color:var(--ink-primary,#16202e);font-weight:600}
  table.da-inv-tbl tbody tr:hover td{background:color-mix(in srgb,var(--accent,#16C0DE) 6%,transparent)}
  .da-inv-badge{display:inline-block;font-size:var(--fs-micro,10.5px);font-weight:700;
    border-radius:6px;padding:1px 7px;border:1px solid currentColor}
  .da-inv-badge.normal{color:var(--info,#2f7ec4)} .da-inv-badge.poisson{color:var(--warn,#b7791f)}
  .da-inv-rank{display:inline-block;min-width:16px;text-align:center;font-weight:700;font-size:var(--fs-micro,10.5px)}
  .da-inv-note{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary,#8195a8);line-height:1.5}
  .da-inv-empty{padding:18px;text-align:center;color:var(--ink-tertiary,#8195a8);font-size:var(--fs-sm,12.5px)}
  /* ── purpose line: this view's single explicit job (project-first) ── */
  .da-purpose{font-size:var(--fs-xs,12px);color:var(--ink-secondary,#52677c);line-height:1.55;padding:0 2px}
  .da-purpose b{color:var(--ink-primary,#16202e);font-weight:700}
  /* ── 副導線: ファイル単体でためす (a clearly-secondary, collapsed sandbox) ── */
  .da-try{border:1px dashed var(--line-strong,rgba(120,140,170,.3));border-radius:12px;
    background:var(--bg-panel,#f7f6f3)}
  .da-try>summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;user-select:none;
    padding:9px 14px;font-size:var(--fs-sm,12.5px);font-weight:600;color:var(--ink-secondary,#52677c)}
  .da-try>summary::-webkit-details-marker{display:none}
  .da-try>summary::before{content:"🧪";font-size:var(--fs-sm,12.5px)}
  .da-try>summary::after{content:"▸";margin-left:auto;color:var(--ink-tertiary,#8195a8);
    transition:transform var(--dur-1,.12s) var(--ease-out,ease)}
  .da-try[open]>summary::after{transform:rotate(90deg)}
  .da-try-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px}
  .da-try-note{font-size:var(--fs-xs,12px);color:var(--ink-tertiary,#8195a8);line-height:1.55}
  .da-try-acts{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  /* ── standalone-result banner: this bundle is NOT saved to the project ── */
  .da-standalone{display:flex;align-items:center;gap:12px;flex-wrap:wrap;
    background:color-mix(in srgb,var(--warn,#f5b05a) 12%,var(--bg-panel,#f7f6f3));
    border:1px solid var(--warn,#f5b05a);border-radius:12px;padding:9px 14px}
  .da-standalone .t{font-size:var(--fs-sm,12.5px);font-weight:700;color:var(--ink-primary,#16202e)}
  .da-standalone .d{font-size:var(--fs-xs,12px);color:var(--ink-secondary,#52677c);min-width:0}
  .da-standalone .sp{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
  @media(prefers-reduced-motion:reduce){.da-try>summary::after{transition:none}}
  `;
  document.head.appendChild(s);
}

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
const pct = (n) => (n == null ? '—' : (n * 100).toFixed(0) + '%');

// 在庫最適化: モデル表示ラベルと サービス率(=欠品許容の裏返し) の選択肢。
const INV_MODEL = { normal: '正規', poisson: 'ポアソン' };
const SERVICE_OPTS = [[0.9, '90'], [0.95, '95'], [0.975, '97.5'], [0.99, '99'], [0.999, '99.9']];
// service level → percent label without trailing zeros (0.975 → "97.5").
const slPct = (v) => String(+(Number(v) * 100).toFixed(1));

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
    // 稼働SKU：商品マスタ未取込 (sku_master=0) のときは分母「/ 0」を出さない
    // (「50 / 0」は壊れて見える)。マスタがある時だけ 稼働/全体 を併記する。
    ['稼働SKU', k.sku_master
      ? `${fmt(k.sku_active)}<small> / ${fmt(k.sku_master)}</small>`
      : fmt(k.sku_active)],
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

// ── 在庫最適化 (安全在庫・発注点) ─────────────────────────────────────────
// 実測需要 σ から安全在庫・発注点を試算する 分析ホームのカード。純ビルダー2つ
// (シェル + 本体) で、本体は制御変更のたびに /inventory-opt を叩いて差し替える。
// The card body: totals chips + a scrollable per-SKU table + the honest caveat.
function invBodyHtml(data, params) {
  if (!data) return '<div class="da-inv-empty">計算中…</div>';
  if (data.available === false) {
    return `<div class="da-inv-empty">${esc(data.message || '出荷データがありません。①取込で取り込んでください。')}</div>`;
  }
  const rows = data.rows || [];
  const t = data.totals || {};
  const periodic = Number(params.review) > 0;     // 定期発注 → 目標在庫列を追加
  const head = ['SKU', 'ABC', 'モデル', '日平均', 'σ', '安全在庫', '発注点']
    .concat(periodic ? ['目標在庫'] : []);
  const body = rows.map((r) => {
    const cls = r.model === 'poisson' ? 'poisson' : 'normal';
    const badge = `<span class="da-inv-badge ${cls}">${INV_MODEL[r.model] || esc(r.model)}</span>`;
    const rank = r.abc
      ? `<span class="da-inv-rank" style="color:${RANK_C[r.abc] || 'inherit'}">${esc(r.abc)}</span>` : '—';
    const cells = [esc(r.sku), rank, badge, fmt(r.mu_d), fmt(r.sigma_d),
      fmt(r.safety_stock), fmt(r.rop)].concat(periodic ? [fmt(r.target_level)] : []);
    return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  }).join('');
  const chips = [
    ['総安全在庫', `${fmt(t.total_safety_stock)} 点`],
    ['対象SKU', fmt(t.skus)],
    ['サービス率', `${slPct(t.service_level)}%`],
    ['z値', fmt(t.z)],
    ['観測日数', `${fmt(t.days_observed)} 日`],
  ];
  return `<div class="da-inv-sum">${chips.map(([l, v]) =>
    `<span class="da-inv-chip"><i>${l}</i><b>${v}</b></span>`).join('')}</div>
    <div class="da-inv-tbl-wrap"><table class="da-inv-tbl">
      <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${body || `<tr><td colspan="${head.length}" class="da-inv-empty">対象SKUがありません</td></tr>`}</tbody>
    </table></div>
    ${data.truncated ? `<div class="da-inv-note">物量上位 ${rows.length} SKU を表示（全 ${fmt(t.skus)} SKU 中）。</div>` : ''}
    <div class="da-inv-note">※ ${esc(data.note || '')}</div>`;
}

function invCardShell(params) {
  const opts = SERVICE_OPTS.map(([v, lbl]) =>
    `<option value="${v}"${Math.abs(v - params.service_level) < 1e-9 ? ' selected' : ''}>`
    + `サービス率 ${lbl}%（欠品許容 ${+(100 - v * 100).toFixed(1)}%）</option>`).join('');
  return `<div class="da-card full"><h3>在庫最適化（安全在庫・発注点）</h3>
    <div class="da-inv">
      <div class="da-inv-ctrls">
        <div class="da-inv-f"><label for="inv-lt">リードタイム(日)</label>
          <input id="inv-lt" type="number" min="0" step="0.5" value="${params.lead_time}" data-inv-ctl="lead_time"></div>
        <div class="da-inv-f"><label for="inv-rv">発注間隔(日 · 0=発注点方式)</label>
          <input id="inv-rv" type="number" min="0" step="1" value="${params.review}" data-inv-ctl="review"></div>
        <div class="da-inv-f"><label for="inv-sl">欠品許容率（サービス率）</label>
          <select id="inv-sl" data-inv-ctl="service_level">${opts}</select></div>
      </div>
      <div data-inv-body>${invBodyHtml(null, params)}</div>
    </div></div>`;
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

// The view's single, explicit purpose line (project-first). Keeps the page's
// job unambiguous per the phasehint/journey copy work — analyse the project's
// own imported 出荷 data; the file-single sandbox is the labelled exception.
function purposeLine() {
  return `<div class="da-purpose"><b>②物量サマリ</b>：①取込で取り込んだ<b>出荷実績</b>を`
    + `自動分析します（物量推移・ABC・ピーク・在庫）。データの追加・差し替えは<b>①取込</b>で。</div>`;
}

// 副導線: the demoted, clearly-labelled "try a file without saving" sandbox.
// Collapsed by default so the project path stays front-and-centre. Offers both a
// throwaway file analysis (/api/analysis/upload) and the bundled sample.
function tryPanel() {
  return `<details class="da-try">
    <summary>ファイル単体でためす（プロジェクトに保存しません）</summary>
    <div class="da-try-body">
      <div class="da-try-note">手元の出荷CSV/Excelを、プロジェクトに取り込まずにその場で分析します。
        気に入ったら結果画面の「このデータをプロジェクトへ取込」で①取込へ渡せます。</div>
      <div class="da-try-acts">
        <label class="da-btn" style="cursor:pointer">出荷ファイルを選ぶ
          <input type="file" data-act="try-file" accept=".csv,.tsv,.txt,.xls,.xlsx,.json" hidden></label>
        <button class="da-btn" data-act="sample">サンプルで試す</button>
        <span class="da-hint">CSV / Excel（出荷実績）</span>
      </div>
    </div>
  </details>`;
}

// Banner shown when the on-screen bundle is a file-single试算 (NOT project data).
// Its primary CTA bridges into the existing ①取込 flow (reuses reviewShipments).
function standaloneBanner(hasFile, fileName) {
  const importLabel = hasFile
    ? 'このデータをプロジェクトへ取込 →' : '①取込で実データを取り込む →';
  return `<div class="da-standalone" role="status">
    <span class="t">🧪 ファイル単体の試算</span>
    <span class="d">「${esc(fileName)}」を分析中 — この結果は<b>プロジェクトに保存されていません</b>。</span>
    <span class="sp">
      <button class="da-btn primary" data-act="to-project">${importLabel}</button>
      <button class="da-btn" data-act="back-project">プロジェクトのデータに戻る</button>
    </span>
  </div>`;
}

// A chart card whose body is an ECharts mount node (id) or a friendly empty
// note. `span` is the grid track class (sp4/sp2/full); heights follow the
// viewport so the dashboard reads at a glance (全体感) without scrolling.
function chartCard(title, id, hasData, span = 'sp4', h = 'clamp(220px,30vh,340px)') {
  const body = hasData
    ? `<div class="da-ec" data-ec="${id}" style="height:${h}"></div>`
    : `<div class="da-chart-empty" style="min-height:${h}">データなし</div>`;
  return `<div class="da-card ${span}"><h3>${title}</h3>${body}</div>`;
}

// 自動インサイト as a one-line collapsible strip: severity counts + the top
// finding inline; the full card list only on expand (collapsed by default —
// the dashboard keeps the screen, the insights keep their depth).
function insightsStrip(ins) {
  if (!ins || !ins.length) {
    return `<details class="da-insx"><summary>💡 自動インサイト 0件
      <span class="da-insx-top">指摘事項はありません</span></summary></details>`;
  }
  const counts = { critical: 0, warning: 0, info: 0 };
  ins.forEach((i) => {
    counts[i && counts[i.severity] !== undefined ? i.severity : 'info'] += 1;
  });
  const chips = ['critical', 'warning', 'info'].filter((k) => counts[k]).map((k) =>
    `<span class="da-insx-chip" style="color:${SEV[k].c};border-color:${SEV[k].c}">
       ${SEV[k].t} ${counts[k]}</span>`).join('');
  return `<details class="da-insx">
    <summary>💡 自動インサイト ${ins.length}件 ${chips}
      <span class="da-insx-top">${esc((ins[0] && ins[0].title) || '')}</span></summary>
    <div class="da-insx-body">${insightList(ins)}</div>
  </details>`;
}

export function mountDataAnalysis(el, opts = {}) {
  injectStyle();
  refreshRankColors();
  refreshSevColors();
  const root = document.createElement('div');
  root.className = 'da';
  el.innerHTML = '';
  el.appendChild(root);
  let bundle = null;
  let projState = 'none'; // 'none' (no project) | 'nodata' (project, no demand yet) | 'data'
  // File-single sandbox: the File currently analysed standalone (null = none /
  // sample). Held so 「このデータをプロジェクトへ取込」 can hand the same file to ①取込.
  let standaloneFile = null;
  const toast = opts.toast || (() => {});
  const getProject = opts.getProject || (() => null);
  // 在庫最適化 card state: query-only params (never persisted), cached last
  // response, and a debounce handle for the control inputs.
  const invParams = { lead_time: 3, review: 0, service_level: 0.95 };
  let invData = null;
  let invTimer = null;

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

  // The 紐付け確認 panel content now comes from the bundle's persisted meta
  // (what ①取込 resolved at import time) — not from a local upload.
  function mapPanel(b) {
    const m = b && b.meta && b.meta.shipments;
    if (!m || !Array.isArray(m.mapping) || !m.mapping.length) return '';
    return `<details class="da-insx">
      <summary>🔗 取込項目の紐付け（①取込で自動解決）
        <span class="da-insx-top">${esc(m.filename || '')}</span></summary>
      <div class="da-insx-body"><div class="da-map" style="border:none;padding:0">
        <div class="da-map-rows">${m.mapping.map((mp) =>
    `<span class="da-map-chip${mp.column ? '' : ' miss'}">${esc(mp.field)}
       <i>→ ${mp.column ? esc(mp.column) : '未検出'}</i></span>`).join('')}
        </div>${(m.item_mapping || []).length
    ? `<div class="da-map-h" style="margin-top:6px">商品マスタの紐付け</div>
       <div class="da-map-rows">${m.item_mapping.map((mp) =>
    `<span class="da-map-chip${mp.column ? '' : ' miss'}">${esc(mp.field)}
       <i>→ ${mp.column ? esc(mp.column) : '未検出'}</i></span>`).join('')}</div>` : ''}
        ${cleansingHtml(m.cleansing)}
      </div></div>
    </details>`;
  }

  function render(b) {
    disposeCharts();
    const isProj = b && String(b.source || '').startsWith('project');
    const isStandalone = b && !isProj;   // 'upload' / 'sample' — not project data

    let html = purposeLine() + homeHeader(b);

    // Context strip: a standalone試算 gets the 未保存 banner (+ import bridge);
    // project data gets the slim provenance hint. No competing sample button.
    if (isStandalone) {
      html += standaloneBanner(!!standaloneFile, standaloneFile ? standaloneFile.name : 'サンプルデータ');
    } else if (isProj) {
      html += `<div class="da-bar">
         ${b.orders_imported
    ? `<span class="da-hint">①取込のデータを分析中${b.meta && b.meta.shipments && b.meta.shipments.filename
      ? `: <b>${esc(b.meta.shipments.filename)}</b>` : ''}（データの追加・差替は①取込で）</span>`
    : `<span class="da-hint">テンプレの<b>仮データ</b>を表示中 — ①取込で実データに差し替えられます</span>
         <button class="da-btn" data-act="goto-intake">①取込へ →</button>`}
         ${b.source ? `<span class="da-src" style="margin-left:auto">source: ${b.source}</span>` : ''}
       </div>`;
    }

    if (b) {
      html +=
        kpiCards(b.kpis) +
        insightsStrip(b.insights) +
        mapPanel(b) +
        `<div class="da-cards">
           ${chartCard('物量推移（日次）', 'trend', !!(b.trend_daily && b.trend_daily.length), 'sp4')}
           ${chartCard('曜日別ピーク', 'weekday', !!(b.peak && b.peak.by_weekday && b.peak.by_weekday.length), 'sp2')}
           ${chartCard('ABCパレート（上位SKU）', 'abc', !!(b.abc_sku && b.abc_sku.length), 'sp4')}
           ${chartCard('時間帯別ピーク', 'hour', !!(b.peak && b.peak.by_hour && b.peak.by_hour.length), 'sp2')}
           ${staffingCard(b.staffing)}
           ${isProj ? invCardShell(invParams) : ''}
         </div>`;
    } else if (projState === 'nodata') {
      html += `<div class="da-empty"><b>まだ実データがありません</b>
           <div>①取込で出荷実績（CSV / Excel）を取り込むと、ここに物量推移・ABC・ピークの全体像が表示されます。</div>
           <button class="da-btn primary" data-act="goto-intake">①取込でデータを取り込む →</button></div>`;
    } else {
      html += `<div class="da-empty"><b>WMSデータを分析</b>
           <div>①取込で出荷実績を取り込むと、ここに全体像が表示されます。下の「ファイル単体でためす」で下見もできます。</div>
           <button class="da-btn primary" data-act="goto-intake">①取込へ →</button></div>`;
    }

    // 副導線 sandbox — always available EXCEPT while a standalone result is on
    // screen (the banner already owns that context, so no duplicate picker).
    if (!isStandalone) html += tryPanel();

    root.innerHTML = html;
    wire();
    mountAllCharts(b);
    mountInventory();
  }

  // 在庫最適化 card: wire its controls, then paint from cache or fetch fresh.
  // Only present on a project bundle (the endpoint reads the project's shipments).
  function mountInventory() {
    const host = root.querySelector('[data-inv-body]');
    if (!host) return;
    wireInvControls();
    if (invData) host.innerHTML = invBodyHtml(invData, invParams);
    else loadInventory();
  }
  function wireInvControls() {
    root.querySelectorAll('[data-inv-ctl]').forEach((ctl) => {
      const key = ctl.dataset.invCtl;
      const isSelect = ctl.tagName === 'SELECT';
      const apply = () => {
        const v = parseFloat(ctl.value);
        invParams[key] = (!isFinite(v) || v < 0) ? (isSelect ? invParams[key] : 0) : v;
        clearTimeout(invTimer);
        invTimer = setTimeout(loadInventory, isSelect ? 0 : 350);   // debounce typing
      };
      ctl.addEventListener(isSelect ? 'change' : 'input', apply);
    });
  }
  async function loadInventory() {
    const proj = getProject();
    if (!proj) return;
    let host = root.querySelector('[data-inv-body]');
    if (host) host.innerHTML = invBodyHtml(null, invParams);   // 計算中…
    try {
      const q = `lead_time=${encodeURIComponent(invParams.lead_time)}`
        + `&review=${encodeURIComponent(invParams.review)}`
        + `&service_level=${encodeURIComponent(invParams.service_level)}`;
      invData = await getJSON(`/api/projects/${encodeURIComponent(proj)}/inventory-opt?${q}`);
    } catch (e) {
      invData = { available: false, message: '在庫最適化を取得できませんでした: ' + (e.message || e) };
    }
    host = root.querySelector('[data-inv-body]');   // re-query (render may have re-run)
    if (host) host.innerHTML = invBodyHtml(invData, invParams);
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
  const nav = (view) => document.dispatchEvent(new CustomEvent('whsim:nav', { detail: { view } }));

  // 副導線: analyse a hand-picked file WITHOUT saving to the project. Keeps the
  // File so 「このデータをプロジェクトへ取込」 can hand it to the ①取込 ETL later.
  function analyzeFile(file) {
    if (!file) return;
    standaloneFile = file;
    load(() => {
      const fd = new FormData();
      fd.append('shipments', file);
      return getJSON('/api/analysis/upload', { method: 'POST', body: fd });
    }, `「${file.name}」を分析中…`);
  }
  // Bridge the standalone試算 into the real project via the existing ①取込 seam
  // (reviewShipments opens the 取込プレビュー dock; commit runs the normal ETL).
  // No project ⇒ send the user to ①取込 to make one. Sample試算 has no file, so it
  // just routes to ①取込 where real data is imported.
  function importToProject() {
    if (!getProject()) {
      toast('先にプロジェクトを作成してください（①取込）。', 'error');
      nav('overview');
      return;
    }
    if (standaloneFile) {
      reviewShipments(standaloneFile);   // reuse ①取込 ETL; no duplicated import logic
      nav('overview');
      toast('①取込のプレビューで取込を確定してください。', 'info');
    } else {
      nav('overview');
      toast('①取込で実データ（CSV/Excel）を取り込んでください。', 'info');
    }
  }

  function wire() {
    // 分析ホーム drill links → sibling ② views (the shell listens for whsim:nav).
    root.querySelectorAll('.da-home-link[data-nav]').forEach((btn) => {
      btn.onclick = () => nav(btn.dataset.nav);
    });
    // 副導線 sandbox: file picker + sample (both throwaway, never saved).
    const tryFile = root.querySelector('[data-act="try-file"]');
    if (tryFile) tryFile.onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) analyzeFile(f);
    };
    const sample = root.querySelector('[data-act="sample"]');
    if (sample) sample.onclick = () => {
      standaloneFile = null;   // sample bundle has no backing file
      load(() => getJSON('/api/analysis/sample'), 'サンプルデータを分析中…');
    };
    // Standalone-result banner: bridge to ①取込 / return to project data.
    const toProj = root.querySelector('[data-act="to-project"]');
    if (toProj) toProj.onclick = importToProject;
    const backProj = root.querySelector('[data-act="back-project"]');
    if (backProj) backProj.onclick = () => loadProject();
    const intake = root.querySelector('[data-act="goto-intake"]');
    if (intake) intake.onclick = () => nav('overview');
    const ttBtn = root.querySelector('[data-act="to-timetable"]');
    if (ttBtn) ttBtn.onclick = () => document.dispatchEvent(new CustomEvent(
      'whsim:load-timetable', { detail: { scenario: bundle && bundle.timetable_scenario } }));
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

  // Project-first: analyse the project's own imported data (persisted by the
  // ①取込 ETL). available:false ⇒ no demand yet → point at ①取込.
  async function loadProject() {
    const proj = getProject();
    invData = null;   // a project switch / fresh import must re-derive 在庫最適化
    standaloneFile = null;   // returning to project data clears the sandbox context
    if (!proj) { projState = 'none'; render(null); return; }
    await load(async () => {
      const b = await getJSON(`/api/projects/${encodeURIComponent(proj)}/analysis/bundle`);
      if (b && b.available === false) { projState = 'nodata'; return null; }
      projState = 'data';
      return b;
    }, 'プロジェクトデータを分析中…');
  }
  loadProject();

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
    // Called by the shell after every ①取込 import — the dashboard follows live.
    refresh() { loadProject(); },
  };
}
