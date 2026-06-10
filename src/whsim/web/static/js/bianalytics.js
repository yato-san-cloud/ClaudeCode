// bianalytics.js — きいて分析ビュー. A ThoughtSpot-style "ask in words → chart"
// surface over the already-aggregated analysis endpoint, plus auto-insight cards
// and three commercial-grade ECharts visualisations:
//   ・ABCパレート  : bar (rank-coloured) + cumulative line on a second axis, with
//                    70/90% ABC band guides and toolbox (saveAsImage / restore).
//   ・曜日別ヒート  : single-row heatmap with a visualMap colour ramp.
//   ・時系列        : daily area line with brush + slider dataZoom (scrub by day) +
//                    an hourly bar sparkline that doubles as the hour cross-filter.
// Everything renders client-side from one GET — no server round-trip on interaction.
//
// Cross-filter: clicking a Pareto bar (→ its rank), a heatmap cell (→ weekday),
// a legend rank, or an hourly bar / dataZoom brush (→ hour range) toggles a facet;
// the other charts + insight cards RE-AGGREGATE from the filtered `xtab` cells.
//
// Theme: ECharts options are rebuilt from live CSS tokens (read via
// getComputedStyle) and re-applied on the document `themechange` event, so charts
// follow light/dark. Responsive via ResizeObserver + window resize. Reduced-motion
// disables ECharts animation. Comments EN; UI JA.
import { esc } from './util.js';
import * as echarts from 'echarts';
import { ABC_COLOR } from './constants.js';

const ACCENT_FALLBACK = '#16C0DE';
const TIP_W = 220;                    // tooltip width (kept in sync with .bia-tip CSS)

// ── theme token reader ──────────────────────────────────────────────────
// Resolve a CSS custom property to a concrete value (ECharts paints can't use
// var()). Refreshed whenever we (re)build options, so charts track the theme.
function tok(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
// Convert a hex (#rgb/#rrggbb) to rgba() at the given alpha; non-hex falls back.
function hexAlpha(hex, a) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) h = ACCENT_FALLBACK.slice(1);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
const reduceMotion = () => matchMedia('(prefers-reduced-motion:reduce)').matches;

// Snapshot the live design tokens an ECharts option needs. Rebuilt per render so
// a themechange (which mutates the CSS vars) is picked up by the next setOption.
function palette() {
  const accent = tok('--accent', ACCENT_FALLBACK);
  return {
    accent,
    accentSoft: hexAlpha(accent, 0.4),
    accentFill: hexAlpha(accent, 0.14),
    ink: tok('--ink-primary', '#37352F'),
    ink2: tok('--ink-secondary', 'rgba(55,53,47,0.65)'),
    ink3: tok('--ink-tertiary', 'rgba(55,53,47,0.45)'),
    line: tok('--line-hair', 'rgba(55,53,47,0.09)'),
    lineStrong: tok('--line-strong', 'rgba(55,53,47,0.16)'),
    panel: tok('--bg-app', '#FFFFFF'),
    sunken: tok('--bg-sunken', '#FBFBFA'),
    warn: tok('--warn', '#B7791F'),
    bad: tok('--bad', '#C4453F'),
    // ABC band fills track the shared constants palette (A/B/C).
    rankA: tok('--rank-a', ABC_COLOR.A),
    rankB: tok('--rank-b', ABC_COLOR.B),
    rankC: tok('--rank-c', ABC_COLOR.C),
    fontMono: tok('--font-mono', 'monospace'),
    fontSans: tok('--font-sans', 'sans-serif'),
  };
}
// Shared tooltip styling so every chart's floating tooltip matches the panel.
function tipStyle(p) {
  return {
    backgroundColor: p.panel,
    borderColor: p.lineStrong,
    borderWidth: 1,
    textStyle: { color: p.ink, fontSize: 12, fontFamily: p.fontSans },
    extraCssText: 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.16);',
  };
}
// Standard toolbox (image save + restore) — the saveAsImage label/icons are JA.
function toolbox(p) {
  return {
    right: 8, top: 4,
    iconStyle: { borderColor: p.ink3 },
    emphasis: { iconStyle: { borderColor: p.accent } },
    feature: {
      saveAsImage: { title: '画像保存', backgroundColor: p.panel, pixelRatio: 2 },
      restore: { title: '初期化' },
    },
  };
}

const WD = ['月', '火', '水', '木', '金', '土', '日'];

// Rotating example questions (also seed the lightweight rule mapper below).
const EXAMPLES = [
  '梱包が詰まる曜日は？',
  'ABC上位20%は？',
  'ピーク時間帯は？',
  '物量が多い曜日は？',
  'データ範囲は？',
];

const fmt = (n, d = 0) => (n == null || isNaN(n) ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (n, d = 0) => (n == null || isNaN(n) ? '—' : `${fmt(n * 100, d)}%`);

function injectStyle() {
  if (document.getElementById('bia-style')) return;
  const s = document.createElement('style');
  s.id = 'bia-style';
  s.textContent = `
  #bianalytics.panel{overflow:auto}
  .bia{display:flex;flex-direction:column;gap:var(--sp-4);max-width:1180px;
    margin:0 auto;width:100%;padding:var(--sp-2) 2px var(--sp-8);color:var(--ink-primary);font-family:var(--font-sans)}
  .bia-dim{opacity:.34;transition:opacity var(--dur-2) var(--ease-out)}
  @media (prefers-reduced-motion:reduce){.bia-dim{transition:none}}

  /* ── loading spinner ── */
  .bia-load{display:flex;align-items:center;justify-content:center;gap:var(--sp-3);
    padding:var(--sp-8);color:var(--ink-tertiary);font-size:var(--fs-sm)}
  .bia-spin{--bia-spin-sz:18px;width:var(--bia-spin-sz);height:var(--bia-spin-sz);
    border-radius:var(--r-pill);border:2px solid var(--line-strong);
    border-top-color:var(--accent);animation:bia-spin .7s linear infinite;flex:0 0 auto}
  @keyframes bia-spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.bia-spin{animation:none;border-top-color:var(--accent)}}

  /* ── ① question box (ThoughtSpot-style) ── */
  .bia-ask{position:relative}
  .bia-ask-in{display:flex;align-items:center;gap:var(--sp-3);background:var(--bg-panel);
    border:1px solid var(--line-hair);border-radius:var(--r-lg);padding:11px 14px;
    transition:border-color var(--dur-2) var(--ease-out),box-shadow var(--dur-2) var(--ease-out)}
  .bia-ask-in:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-tint-2)}
  .bia-ask-in .q{color:var(--accent);font-family:var(--font-mono);font-size:14px;flex:0 0 auto}
  .bia-ask-in input{flex:1;min-width:0;border:none;background:transparent;outline:none;
    font:inherit;font-size:14.5px;color:var(--ink-primary)}
  .bia-ask-in input::placeholder{color:var(--ink-tertiary)}
  .bia-ask-in .slash{font-family:var(--font-mono);font-size:var(--fs-micro);color:var(--ink-tertiary);
    border:1px solid var(--line-hair);border-radius:var(--r-sm);padding:2px 6px;flex:0 0 auto}
  .bia-answer{margin-top:var(--sp-2);font-size:var(--fs-sm);color:var(--ink-secondary);line-height:1.5;
    padding-left:var(--sp-1);min-height:18px}
  .bia-answer b{color:var(--ink-primary)}
  .bia-answer .hit{color:var(--accent);font-family:var(--font-mono);font-weight:700}
  .bia-answer .sug{color:var(--ink-tertiary)}
  .bia-answer .sug u{cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px}

  /* ── quick-chip example questions ── */
  .bia-chips{display:flex;flex-wrap:wrap;gap:var(--sp-2);margin-top:var(--sp-2);padding-left:var(--sp-1)}
  .bia-chip{appearance:none;font-family:var(--font-sans);font-size:var(--fs-xs);color:var(--ink-secondary);
    background:var(--bg-sunken);border:1px solid var(--line-hair);border-radius:var(--r-pill);
    padding:var(--sp-1) var(--sp-3);cursor:pointer;
    transition:border-color var(--dur-2) var(--ease-out),color var(--dur-2) var(--ease-out)}
  .bia-chip:hover{border-color:var(--accent);color:var(--ink-primary)}
  @media (prefers-reduced-motion:reduce){.bia-chip{transition:none}}

  /* ── cross-filter active-filter pills ── */
  .bia-filterbar{display:flex;align-items:center;flex-wrap:wrap;gap:var(--sp-2);min-height:24px;padding-left:var(--sp-1)}
  .bia-filterbar .lbl{font-family:var(--font-mono);font-size:var(--fs-micro);color:var(--ink-tertiary);
    letter-spacing:.08em}
  .bia-pill{appearance:none;display:inline-flex;align-items:center;gap:var(--sp-2);font-family:var(--font-mono);
    font-size:var(--fs-micro);color:var(--accent);background:var(--accent-tint-2);
    border:1px solid var(--accent);border-radius:var(--r-pill);padding:var(--sp-1) var(--sp-3);cursor:pointer;
    transition:opacity var(--dur-1) var(--ease-out)}
  .bia-pill:hover{opacity:.75}
  .bia-pill:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .bia-pill .x{font-weight:700}
  .bia-fclear{appearance:none;font-family:var(--font-mono);font-size:var(--fs-micro);color:var(--ink-secondary);
    background:transparent;border:1px solid var(--line-hair);border-radius:var(--r-pill);
    padding:var(--sp-1) var(--sp-3);cursor:pointer;transition:color var(--dur-1) var(--ease-out),border-color var(--dur-1) var(--ease-out)}
  .bia-fclear:hover{color:var(--ink-primary);border-color:var(--line-strong)}
  .bia-fclear:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  @media (prefers-reduced-motion:reduce){.bia-pill,.bia-fclear{transition:none}}

  /* ── error / retry state ── */
  .bia-err{display:flex;flex-direction:column;align-items:center;gap:var(--sp-3);text-align:center;
    padding:32px 20px;color:var(--ink-secondary)}
  .bia-err .msg{font-size:var(--fs-sm);color:var(--ink-secondary)}
  .bia-err .det{font-family:var(--font-mono);font-size:var(--fs-micro);color:var(--ink-tertiary)}
  .bia-retry{appearance:none;padding:var(--sp-2) var(--sp-5);border:1px solid var(--accent);border-radius:var(--r-md);
    background:var(--accent);color:var(--ink-onAccent);font:inherit;font-weight:700;cursor:pointer;
    transition:opacity var(--dur-1) var(--ease-out)}
  .bia-retry:hover{opacity:.88}
  .bia-retry:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  @media (prefers-reduced-motion:reduce){.bia-retry{transition:none}}

  /* ── ② auto-insight cards ── */
  .bia-ins{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  @media(max-width:820px){.bia-ins{grid-template-columns:1fr}}
  .bia-card{background:var(--bg-panel);border:1px solid var(--line-hair);border-radius:var(--r-lg);
    padding:14px 15px;display:flex;flex-direction:column;gap:7px;cursor:pointer;
    transition:border-color var(--dur-2,160ms) var(--ease-out,ease),transform var(--dur-2,160ms) var(--ease-out,ease)}
  .bia-card:hover{border-color:var(--accent);transform:translateY(-2px)}
  @media (prefers-reduced-motion:reduce){.bia-card{transition:none}.bia-card:hover{transform:none}}
  .bia-card .kic{font-family:var(--font-mono);font-size:var(--fs-micro);letter-spacing:.12em;text-transform:uppercase;
    color:var(--ink-tertiary)}
  .bia-card .fact{font-size:var(--fs-sm);color:var(--ink-primary);line-height:1.45}
  .bia-card .fact .n{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-weight:700;color:var(--accent)}
  .bia-card .imp{font-size:var(--fs-xs);color:var(--ink-secondary);line-height:1.45}
  .bia-card .go{margin-top:auto;font-family:var(--font-mono);font-size:10px;color:var(--ink-tertiary)}

  /* ── ②b drill links (cross-view nav) ── */
  .bia-drill{display:flex;flex-wrap:wrap;gap:14px;margin-top:2px}
  .bia-drill a{font-family:var(--font-sans);font-size:var(--fs-xs);color:var(--accent);
    cursor:pointer;text-decoration:none;transition:opacity var(--dur-1) var(--ease-out)}
  .bia-drill a:hover{opacity:.7}
  @media (prefers-reduced-motion:reduce){.bia-drill a{transition:none}}

  /* ── shared chart shell ── */
  .bia-chart{background:var(--bg-panel);border:1px solid var(--line-hair);border-radius:var(--r-lg);padding:16px}
  .bia-ch-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px}
  .bia-ch-h h3{margin:0;font-family:var(--font-display);font-size:14px;font-weight:600;color:var(--ink-primary)}
  .bia-ch-h .sub{font-size:11px;color:var(--ink-tertiary)}
  .bia-ch-h .hint{margin-left:auto;font-size:10.5px;color:var(--ink-tertiary);font-family:var(--font-mono)}
  /* the ECharts mount node — height is per-chart, width 100% (responsive) */
  .bia-ec{width:100%}

  /* ── empty / scaffold ── */
  .bia-empty{background:var(--bg-panel);border:1px dashed var(--line-strong);border-radius:var(--r-lg);
    padding:30px;text-align:center;color:var(--ink-tertiary);font-size:13px;line-height:1.7}
  .bia-empty b{color:var(--ink-secondary)}
  .bia-empty-acts{display:flex;flex-wrap:wrap;gap:var(--sp-3);justify-content:center;align-items:center;margin-top:var(--sp-4)}
  .bia-cta{display:inline-block;font-family:var(--font-mono);font-size:var(--fs-sm);
    color:var(--accent);border:1px solid var(--accent);border-radius:var(--r-pill);
    padding:var(--sp-2) var(--sp-5);cursor:pointer;transition:background var(--dur-2) var(--ease-out)}
  .bia-cta:hover{background:var(--accent-tint-2)}
  .bia-cta.primary{color:var(--bg-app);background:var(--accent);border-color:var(--accent);font-weight:700}
  .bia-cta.primary:hover{opacity:.88;background:var(--accent)}
  @media (prefers-reduced-motion:reduce){.bia-cta{transition:none}}
  .bia-scaffold{opacity:.5;filter:grayscale(.4)}
  .bia-scaffold-note{padding:18px;text-align:center;color:var(--ink-tertiary);font-size:13px}
  `;
  document.head.appendChild(s);
}

export function mountBIAnalytics(el, opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const toast = opts.toast || (() => {});
  // Optional Cody delegation: when a question matches no keyword rule and this
  // is a function, the raw question is handed to Cody.
  const askCody = typeof opts.askCody === 'function' ? opts.askCody : null;

  // Drill: ask PM-side to switch the active view (host listens for `whsim:nav`).
  const nav = (view) => document.dispatchEvent(new CustomEvent('whsim:nav', { detail: { view } }));

  // ── ECharts instance registry: id → instance. Disposed/cleared each render
  // so a re-aggregation never leaks canvases. ResizeObserver keeps them sized.
  const charts = new Map();
  let ro = null;
  function disposeCharts() {
    charts.forEach((c) => { try { c.dispose(); } catch (_) { /* noop */ } });
    charts.clear();
  }
  function ensureChart(node, id) {
    const inst = echarts.init(node, null, { renderer: 'canvas' });
    charts.set(id, inst);
    if (ro) ro.observe(node);
    return inst;
  }
  function onWinResize() { charts.forEach((c) => { try { c.resize(); } catch (_) { /* noop */ } }); }
  window.addEventListener('resize', onWinResize);
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { charts.forEach((c) => { try { c.resize(); } catch (_) { /* noop */ } }); });
  }

  function onThemeChange() {
    if (data && data.has_data) render();   // rebuild options from the new tokens
  }
  document.addEventListener('themechange', onThemeChange);

  // ── intra-view cross-filter state (TRUE propagation via xtab) ───────────
  // rank/weekday/hour are SETS (empty = inactive). abc is a single pinned SKU.
  let filterState = { abc: null, rank: new Set(), weekday: new Set(), hour: new Set() };
  const PROPAGATING = ['rank', 'weekday', 'hour'];
  const facetActive = (k) => filterState[k] instanceof Set && filterState[k].size > 0;
  const filterActive = () => PROPAGATING.some((k) => facetActive(k)) || filterState.abc != null;
  const propagatingActive = () => PROPAGATING.some((k) => facetActive(k));
  function facetValues(key) {
    const s = filterState[key];
    if (!(s instanceof Set)) return [];
    return Array.from(s).sort((a, b) => (typeof a === 'number' && typeof b === 'number')
      ? a - b : String(a).localeCompare(String(b)));
  }
  const freshFilterState = () => ({ abc: null, rank: new Set(), weekday: new Set(), hour: new Set() });
  function clearFilter() { filterState = freshFilterState(); render(); }
  function clearFacet(key) {
    if (key === 'abc') filterState.abc = null;
    else if (filterState[key] instanceof Set) filterState[key].clear();
    render();
  }
  function removeFacetValue(key, val) {
    if (filterState[key] instanceof Set) filterState[key].delete(val);
    render();
  }
  // Toggle a value in a set facet (additive = shift/ctrl/cmd → multi-select).
  function toggleFilter(key, val, additive) {
    const s = filterState[key];
    if (!(s instanceof Set)) return;
    if (additive) {
      if (s.has(val)) s.delete(val); else s.add(val);
    } else if (s.size === 1 && s.has(val)) {
      s.clear();
    } else {
      s.clear(); s.add(val);
    }
    render();
  }

  // ── xtab helpers: derive filtered cell sets + re-aggregations ───────────
  const xtabCells = () => (data && Array.isArray(data.xtab) ? data.xtab : []);
  const xtabWeekdays = () => (data && Array.isArray(data.xtab_weekdays) && data.xtab_weekdays.length
    ? data.xtab_weekdays : WD);
  function filteredCells(except) {
    return xtabCells().filter((c) => {
      if (except !== 'rank' && facetActive('rank') && !filterState.rank.has(c.rank)) return false;
      if (except !== 'weekday' && facetActive('weekday') && !filterState.weekday.has(c.weekday)) return false;
      if (except !== 'hour' && facetActive('hour') && !filterState.hour.has(c.hour)) return false;
      return true;
    });
  }
  function weekdayProfile() {
    const wd = xtabWeekdays();
    const totals = wd.map(() => 0);
    filteredCells('weekday').forEach((c) => {
      if (c.weekday >= 0 && c.weekday < totals.length) totals[c.weekday] += (c.qty || 0);
    });
    return wd.map((label, i) => ({ label, weekday: i, qty: totals[i] }));
  }
  function hourProfile() {
    const totals = new Array(24).fill(0);
    filteredCells('hour').forEach((c) => {
      if (c.hour >= 0 && c.hour < 24) totals[c.hour] += (c.qty || 0);
    });
    return totals.map((qty, h) => ({ label: `${h}時`, hour: h, qty }));
  }
  const weekdayLabel = (i) => (i == null ? '' : (xtabWeekdays()[i] || WD[i] || String(i)));
  function filterDescription() {
    const parts = [];
    if (facetActive('rank')) parts.push(`ランク${facetValues('rank').join('・')}`);
    if (facetActive('weekday')) parts.push(`${facetValues('weekday').map(weekdayLabel).join('・')}曜`);
    if (facetActive('hour')) parts.push(`${facetValues('hour').join('・')}時`);
    return parts.join(' · ') || '選択';
  }
  const xtabSku = () => (data && Array.isArray(data.xtab_sku) ? data.xtab_sku : []);
  const hasSkuXtab = () => xtabSku().length > 0;
  function weekdayOnlySelection() {
    return facetActive('weekday') && !facetActive('rank') && !facetActive('hour') && hasSkuXtab();
  }
  // Re-aggregate the abc[] SKUs by summing xtab_sku over the selected weekday(s).
  function paretoRows() {
    const base = (data.abc || []).slice();
    if (!weekdayOnlySelection() || !base.length) return { rows: base, reranked: false };
    const days = filterState.weekday;
    const byName = new Map();
    base.forEach((r) => { byName.set(r.sku || r.name, { sku: r.sku, name: r.name }); });
    const qtyBy = new Map();
    xtabSku().forEach((c) => {
      if (!days.has(c.weekday)) return;
      const key = c.sku;
      if (!byName.has(key)) return;
      qtyBy.set(key, (qtyBy.get(key) || 0) + (c.qty || 0));
    });
    let rows = base.map((r) => {
      const key = r.sku || r.name;
      return { sku: r.sku, name: r.name, qty: qtyBy.get(key) || 0 };
    });
    rows.sort((a, b) => (b.qty || 0) - (a.qty || 0));
    const tot = rows.reduce((s, r) => s + (r.qty || 0), 0) || 1;
    let acc = 0;
    rows = rows.map((r) => {
      acc += (r.qty || 0) / tot;
      const cum = Math.min(1, acc);
      const rank = cum <= 0.7 ? 'A' : cum <= 0.9 ? 'B' : 'C';
      const share = (r.qty || 0) / tot;
      return { ...r, cum, rank, share };
    });
    return { rows, reranked: true };
  }
  function rankDistribution() {
    const ranks = (data && Array.isArray(data.xtab_ranks) && data.xtab_ranks.length)
      ? data.xtab_ranks : ['A', 'B', 'C'];
    const byRank = {}; ranks.forEach((r) => { byRank[r] = { rank: r, lines: 0, qty: 0 }; });
    filteredCells().forEach((c) => {
      if (!byRank[c.rank]) byRank[c.rank] = { rank: c.rank, lines: 0, qty: 0 };
      byRank[c.rank].lines += (c.lines || 0);
      byRank[c.rank].qty += (c.qty || 0);
    });
    return ranks.map((r) => byRank[r]);
  }

  const root = document.createElement('div');
  root.className = 'bia';
  el.innerHTML = '';
  el.appendChild(root);

  let data = null;          // analysis payload
  let loadErr = null;       // last load() failure (null = none)
  let exIdx = 0, exTimer = 0;
  let dzTimer = 0;          // trailing-debounce timer for hourly dataZoom → facet

  // ── lightweight rule mapper: keyword → {section, answer} ──────────────
  function answerQuestion(qRaw) {
    const q = (qRaw || '').trim();
    if (!q) { setAnswer(''); clearDim(); return; }
    const has = (...ks) => ks.some((k) => q.includes(k));

    if (has('ABC', 'abc', '上位', '主力', '偏', 'パレート', '20%')) {
      const a = data.abc || [];
      if (!a.length) return suggestNoData('abc');
      const topN = Math.max(1, Math.round(a.length * 0.2));
      const top = a.slice(0, topN);
      const share = top.reduce((s, r) => s + (r.share || 0), 0);
      focus('abc');
      setAnswer(`上位 <b>${pct(topN / a.length)}</b> の SKU（<span class="hit">${fmt(topN)}品目</span>）が物量の <span class="hit">${pct(share)}</span> を占めます。最上位は <b>${esc(top[0].name || top[0].sku)}</b>。`);
      return;
    }
    if (has('曜日') || has('梱包', '詰ま', '混む', '忙しい')) {
      const w = data.by_weekday || [];
      if (!w.length) return suggestNoData('weekday');
      const mx = w.reduce((a, b) => ((b.qty || 0) > (a.qty || 0) ? b : a), w[0]);
      focus('weekday');
      setAnswer(`物量が最も多い曜日は <span class="hit">${esc(mx.label)}曜</span>（<b>${fmt(mx.qty)}</b>）。ここが詰まりやすい曜日です。`);
      return;
    }
    if (has('ピーク', '時間帯', '時間', '何時', 'ピーク時')) {
      const h = data.hourly || [];
      if (!h.length) return suggestNoData('time');
      const mx = h.reduce((a, b) => ((b.qty || 0) > (a.qty || 0) ? b : a), h[0]);
      focus('time');
      setAnswer(`ピークは <span class="hit">${esc(mx.label)}</span> 帯（<b>${fmt(mx.qty)}</b>）。人員はこの時間に厚く。`);
      return;
    }
    if (has('範囲', '期間', 'いつ', '何日', 'データ')) {
      const d = data.daily || [];
      if (!d.length) return suggestNoData('time');
      focus('time');
      const total = d.reduce((s, r) => s + (r.qty || 0), 0);
      setAnswer(`データ範囲は <span class="hit">${fmt(d.length)}日分</span>（${esc(d[0].label || '')}〜${esc(d[d.length - 1].label || '')}）、合計 <b>${fmt(total)}</b>。`);
      return;
    }
    clearDim();
    if (askCody) {
      setAnswer(`<span class="sug">OCTA に聞いています…「<b>${esc(q)}</b>」</span>`);
      askCody(q);
      return;
    }
    setAnswer(`<span class="sug">うまく解釈できませんでした。近い質問: ${EXAMPLES.slice(0, 3).map((e) => `<u data-ex="${esc(e)}">${esc(e)}</u>`).join(' / ')}</span>`);
  }

  function suggestNoData(section) {
    clearDim();
    setAnswer(`<span class="sug">この質問に必要なデータがまだありません（${esc(section)}）。①取込で実データを入れると回答できます。</span>`);
  }
  function runExample(text) {
    const inp = root.querySelector('[data-bia="q"]');
    if (inp) inp.value = text;
    answerQuestion(text);
  }
  function setAnswer(html) {
    const a = root.querySelector('[data-bia="answer"]');
    if (a) a.innerHTML = html;
  }

  // cross-highlight: dim everything, undim the focused chart, scroll to it
  function focus(section) {
    root.querySelectorAll('[data-sec]').forEach((n) => {
      n.classList.toggle('bia-dim', n.dataset.sec !== section);
    });
    const tgt = root.querySelector(`[data-sec="${section}"]`);
    if (tgt && !reduceMotion()) tgt.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function clearDim() { root.querySelectorAll('[data-sec]').forEach((n) => n.classList.remove('bia-dim')); }

  // ── auto-insights (max 3): fact line + implication line ───────────────
  function insights() {
    const out = [];
    const filtered = propagatingActive();
    const selLabel = filterDescription();
    const abc = data.abc || [];
    if (abc.length) {
      if (weekdayOnlySelection()) {
        const rows = paretoRows().rows.filter((r) => (r.qty || 0) > 0);
        if (rows.length) {
          const topN = Math.max(1, Math.round(rows.length * 0.2));
          const share = rows.slice(0, topN).reduce((s, r) => s + (r.share || 0), 0);
          out.push({
            sec: 'abc', kic: 'ABC 偏り（絞込中・再集計）',
            fact: `${esc(selLabel)} では上位20%の SKU（<span class="n">${fmt(topN)}品目</span>）が物量の <span class="n">${pct(share)}</span> を占有。`,
            imp: `この曜日の主力は ${rows[0].name || rows[0].sku}。曜日別にA品を寄せると効果的です。`,
          });
        }
      } else if (filtered) {
        const dist = rankDistribution();
        const tot = dist.reduce((s, r) => s + (r.qty || 0), 0) || 1;
        const aShare = (dist.find((r) => r.rank === 'A') || { qty: 0 }).qty / tot;
        out.push({
          sec: 'abc', kic: 'ABC 構成（絞込中）',
          fact: `${esc(selLabel)} の物量はランクA が <span class="n">${pct(aShare)}</span> を占有。`,
          imp: 'この絞込では個別SKUの再ランク付けはできません（ランク粒度の集計）。',
        });
      } else {
        const topN = Math.max(1, Math.round(abc.length * 0.2));
        const share = abc.slice(0, topN).reduce((s, r) => s + (r.share || 0), 0);
        const skew = share >= 0.8;
        out.push({
          sec: 'abc', kic: 'ABC 偏り',
          fact: `上位20%の SKU（<span class="n">${fmt(topN)}品目</span>）が物量の <span class="n">${pct(share)}</span> を占有。`,
          imp: skew ? '主力に偏在。A品を出荷口近くへ寄せれば歩行を大きく削減できます。'
            : '比較的フラット。ゾーニング効果は限定的、動線最適化を優先。',
        });
      }
    }
    const wk = filtered ? weekdayProfile().filter((r) => r.qty > 0) : (data.by_weekday || []);
    if (wk.length) {
      const mx = wk.reduce((a, b) => ((b.qty || 0) > (a.qty || 0) ? b : a), wk[0]);
      const avg = wk.reduce((s, r) => s + (r.qty || 0), 0) / wk.length;
      const ratio = avg > 0 ? mx.qty / avg : 1;
      out.push({
        sec: 'weekday', kic: filtered ? 'ピーク曜日（絞込中）' : 'ピーク曜日',
        fact: `<span class="n">${esc(mx.label)}曜</span>が最大（<span class="n">${fmt(mx.qty)}</span>、平均比 <span class="n">×${fmt(ratio, 1)}</span>）。`,
        imp: ratio >= 1.4 ? 'この曜日に人員を寄せるか、前倒し出荷で平準化を。' : '曜日の山は緩やか。日次の平準化余地は小さめ。',
      });
    }
    const hr = filtered ? hourProfile().filter((r) => r.qty > 0) : (data.hourly || []);
    if (hr.length && out.length < 3) {
      const mx = hr.reduce((a, b) => ((b.qty || 0) > (a.qty || 0) ? b : a), hr[0]);
      out.push({
        sec: 'time', kic: filtered ? 'ピーク時間帯（絞込中）' : 'ピーク時間帯',
        fact: `ピークは <span class="n">${esc(mx.label)}</span>（<span class="n">${fmt(mx.qty)}</span>）。`,
        imp: 'この時間帯にピッカーを厚く。シフトの山谷を合わせると待ちが減ります。',
      });
    }
    const dy = data.daily || [];
    if (dy.length && out.length < 3) {
      const total = dy.reduce((s, r) => s + (r.qty || 0), 0);
      out.push({
        sec: 'time', kic: 'データ範囲',
        fact: `<span class="n">${fmt(dy.length)}日分</span>、合計 <span class="n">${fmt(total)}</span> を集計。`,
        imp: `${esc(dy[0].label || '')}〜${esc(dy[dy.length - 1].label || '')} の実データに基づく分析です。`,
      });
    }
    return out.slice(0, 3);
  }

  // rankOf: A (cum≤70%) / B (≤90%) / C — used for both colour and rank filter.
  function rankOf(r) {
    if (r.rank === 'A' || r.rank === 'B' || r.rank === 'C') return r.rank;
    if (r.cum != null) return r.cum <= 0.7 ? 'A' : r.cum <= 0.9 ? 'B' : 'C';
    return 'C';
  }

  // ── chart shells: build an ECharts mount node inside a titled section ───
  function chartShell(sec, title, sub, hint, height) {
    const sect = document.createElement('section');
    sect.className = 'bia-chart';
    sect.dataset.sec = sec;
    sect.innerHTML = `<div class="bia-ch-h"><h3>${esc(title)}</h3><span class="sub">${esc(sub)}</span>`
      + `${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`
      + `<div class="bia-ec" data-ec="${esc(sec)}" style="height:${height}px"></div>`;
    return sect;
  }
  function scaffoldShell(sec, title, sub) {
    const sect = document.createElement('section');
    sect.className = 'bia-chart bia-scaffold';
    sect.dataset.sec = sec;
    sect.innerHTML = `<div class="bia-ch-h"><h3>${esc(title)}</h3><span class="sub">${esc(sub)}</span></div>`
      + `<div class="bia-scaffold-note">この図は実データが入ると描画されます。</div>`;
    return sect;
  }

  // ── ③ ABC Pareto: rank-coloured bars + cumulative % line (2nd axis) ────
  function buildPareto(node) {
    const p = palette();
    const pr = paretoRows();
    const a = pr.rows.slice();
    const reranked = pr.reranked;
    // When a facet we cannot honestly re-rank is active, dim the bars and show the
    // selection's rank-level A/B/C split instead of faking per-SKU order.
    const dimSku = propagatingActive() && !reranked;
    const colorOf = (r) => { const k = rankOf(r); return k === 'A' ? p.rankA : k === 'B' ? p.rankB : p.rankC; };
    const fSku = filterState.abc;
    const isMatch = (r) => (fSku == null || (r.sku || r.name) === fSku)
      && (!facetActive('rank') || filterState.rank.has(rankOf(r)));

    if (dimSku) {
      // honest rank-level composition bars (A/B/C) for the current selection
      const dist = rankDistribution();
      const totQ = dist.reduce((s, r) => s + (r.qty || 0), 0) || 1;
      const cats = dist.map((r) => `ランク${r.rank}`);
      const inst = ensureChart(node, 'abc');
      inst.setOption({
        animation: !reduceMotion(),
        grid: { left: 48, right: 24, top: 28, bottom: 28 },
        toolbox: toolbox(p),
        tooltip: {
          trigger: 'axis', axisPointer: { type: 'shadow' }, ...tipStyle(p),
          formatter: (ps) => {
            const r = dist[ps[0].dataIndex] || {};
            return `<b>ランク${esc(r.rank)}</b><br>物量 ${fmt(r.qty)}（${pct((r.qty || 0) / totQ)}）<br>ライン ${fmt(r.lines)}`;
          },
        },
        title: {
          text: `${filterDescription()}で絞込中・選択物量のランク構成`,
          left: 'center', top: 2,
          textStyle: { color: p.ink2, fontSize: 11, fontFamily: p.fontMono, fontWeight: 'normal' },
        },
        xAxis: {
          type: 'category', data: cats,
          axisLabel: { color: p.ink2, fontFamily: p.fontMono },
          axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false },
        },
        yAxis: {
          type: 'value', axisLabel: { color: p.ink3, fontFamily: p.fontMono },
          splitLine: { lineStyle: { color: p.line } },
        },
        series: [{
          type: 'bar', barMaxWidth: 80,
          data: dist.map((r) => ({ value: r.qty || 0, itemStyle: { color: colorOf({ rank: r.rank }) } })),
          label: { show: true, position: 'top', color: p.ink2, fontFamily: p.fontMono,
            formatter: (d) => pct((dist[d.dataIndex].qty || 0) / totQ) },
        }],
      }, true);
      return;
    }

    if (!a.length) { node.parentElement.replaceWith(scaffoldShell('abc', 'ABCパレート', '物量降順の棒＋累積%線')); return; }

    const cats = a.map((r, i) => r.name || r.sku || `#${i + 1}`);
    const tot = a.reduce((s, r) => s + (r.qty || 0), 0) || 1;
    let acc = 0;
    const cum = a.map((r) => { const c = r.cum != null ? r.cum : (acc += (r.qty || 0) / tot, acc); return Math.min(1, c) * 100; });
    const barData = a.map((r) => {
      const off = filterActive() && !isMatch(r);
      return { value: r.qty || 0, itemStyle: { color: colorOf(r), opacity: off ? 0.25 : 1 } };
    });
    // reflect the active selection in the section subtitle (re-ranked vs default)
    const sub = reranked ? `${filterDescription()}で再集計（再ランク済み）` : `${fmt(a.length)}品目を物量降順で`;
    const subEl = node.parentElement && node.parentElement.querySelector('.bia-ch-h .sub');
    if (subEl) subEl.textContent = sub;
    const inst = ensureChart(node, 'abc');
    inst.setOption({
      animation: !reduceMotion(),
      grid: { left: 52, right: 52, top: 16, bottom: a.length > 14 ? 56 : 30 },
      toolbox: toolbox(p),
      legend: {
        // Clickable rank legend (cross-filter). The A/B/C entries map to empty
        // proxy series, so ECharts "hiding" one on click is invisible; our
        // legendselectchanged handler maps the click to the rank facet + re-renders
        // (which rebuilds the legend fresh, so the swatches never stay greyed).
        top: 0, right: 90, icon: 'roundRect', itemWidth: 10, itemHeight: 10,
        textStyle: { color: p.ink3, fontSize: 10, fontFamily: p.fontMono },
        data: ['A (〜70%)', 'B (〜90%)', 'C'],
      },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' }, ...tipStyle(p),
        formatter: (ps) => {
          const i = ps[0].dataIndex; const r = a[i] || {};
          return `<b>${esc(r.name || r.sku)}</b><br>物量 ${fmt(r.qty)} · 累積 ${pct((r.cum != null ? r.cum : cum[i] / 100))}<br>ランク ${esc(rankOf(r))}`;
        },
      },
      xAxis: {
        type: 'category', data: cats,
        axisLabel: { show: a.length <= 20, color: p.ink3, fontFamily: p.fontMono, rotate: a.length > 8 ? 40 : 0,
          interval: 0, hideOverlap: true, formatter: (v) => (v.length > 8 ? `${v.slice(0, 8)}…` : v) },
        axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false },
      },
      yAxis: [
        { type: 'value', name: '物量', nameTextStyle: { color: p.ink3, fontFamily: p.fontMono, fontSize: 10 },
          axisLabel: { color: p.ink3, fontFamily: p.fontMono }, splitLine: { lineStyle: { color: p.line } } },
        { type: 'value', name: '累積%', min: 0, max: 100,
          nameTextStyle: { color: p.ink3, fontFamily: p.fontMono, fontSize: 10 },
          axisLabel: { color: p.ink3, fontFamily: p.fontMono, formatter: '{value}%' }, splitLine: { show: false } },
      ],
      series: [
        // ABC legend proxies (no data) so the rank colours show in the legend.
        { name: 'A (〜70%)', type: 'bar', data: [], itemStyle: { color: p.rankA } },
        { name: 'B (〜90%)', type: 'bar', data: [], itemStyle: { color: p.rankB } },
        { name: 'C', type: 'bar', data: [], itemStyle: { color: p.rankC } },
        {
          name: '物量', type: 'bar', yAxisIndex: 0, data: barData, barMaxWidth: 34,
        },
        {
          // cumulative % on the 2nd axis; the 70/90% ABC band guides ride this
          // series so `yAxis: 70/90` maps to the percentage scale (not 物量).
          name: '累積%', type: 'line', yAxisIndex: 1, data: cum, smooth: false,
          symbol: 'circle', symbolSize: 5, lineStyle: { color: p.accent, width: 2 },
          itemStyle: { color: p.accent }, z: 5,
          markLine: {
            silent: true, symbol: 'none',
            label: { color: p.ink2, fontFamily: p.fontMono, fontSize: 9, formatter: '{b}' },
            data: [
              { yAxis: 70, name: '70%', lineStyle: { color: p.warn, type: 'dashed' } },
              { yAxis: 90, name: '90%', lineStyle: { color: p.bad, type: 'dashed' } },
            ],
          },
        },
      ],
    }, true);
    // Click a bar → pin SKU + propagate its rank (plain = single, shift/ctrl = add).
    inst.on('click', { seriesName: '物量' }, (params) => {
      const r = a[params.dataIndex]; if (!r) return;
      const sku = r.sku || r.name;
      const rk = rankOf(r);
      const additive = !!(params.event && (params.event.shiftKey || params.event.ctrlKey || params.event.metaKey));
      if (filterState.abc === sku) { filterState.abc = null; filterState.rank.delete(rk); }
      else { filterState.abc = sku; if (additive) filterState.rank.add(rk); else { filterState.rank.clear(); filterState.rank.add(rk); } }
      render();
    });
    // Click a legend rank proxy → toggle that rank facet.
    inst.on('legendselectchanged', (params) => {
      const map = { 'A (〜70%)': 'A', 'B (〜90%)': 'B', 'C': 'C' };
      const rk = map[params.name];
      if (rk) toggleFilter('rank', rk, false);
    });
  }

  // ── ④ weekday heatmap (single-row) with visualMap colour ramp ──────────
  function buildWeekday(node) {
    const p = palette();
    const haveXtab = xtabCells().length > 0;
    let series;
    if (haveXtab) {
      series = weekdayProfile();
    } else {
      const raw = data.by_weekday || [];
      if (!raw.length) { node.parentElement.replaceWith(scaffoldShell('weekday', '曜日別ヒートマップ', '7セルの濃淡')); return; }
      const byLabel = {}; raw.forEach((r) => { byLabel[r.label] = r.qty || 0; });
      series = WD.every((d) => d in byLabel)
        ? WD.map((d, i) => ({ label: d, qty: byLabel[d], weekday: i }))
        : raw.map((r) => ({ label: r.label, qty: r.qty || 0, weekday: WD.indexOf(r.label) }));
    }
    if (!series.length) { node.parentElement.replaceWith(scaffoldShell('weekday', '曜日別ヒートマップ', '7セルの濃淡')); return; }
    const max = Math.max(...series.map((r) => r.qty || 0), 1);
    const fWd = filterState.weekday;
    const cats = series.map((r) => r.label);
    // heatmap data: [x, y(0), value]; carry index for click→weekday facet.
    const cells = series.map((r, i) => ({
      value: [i, 0, r.qty || 0],
      itemStyle: (r.weekday != null && fWd.has(r.weekday))
        ? { borderColor: p.accent, borderWidth: 2 } : undefined,
    }));
    const inst = ensureChart(node, 'weekday');
    inst.setOption({
      animation: !reduceMotion(),
      grid: { left: 12, right: 16, top: 10, bottom: 56, containLabel: true },
      toolbox: toolbox(p),
      tooltip: {
        ...tipStyle(p),
        formatter: (d) => `<b>${esc(series[d.value[0]].label)}曜</b> · ${fmt(d.value[2])}`,
      },
      xAxis: {
        type: 'category', data: cats, splitArea: { show: true },
        axisLabel: { color: p.ink2, fontFamily: p.fontMono, fontSize: 12 },
        axisLine: { show: false }, axisTick: { show: false },
      },
      yAxis: {
        type: 'category', data: [''], splitArea: { show: false },
        axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false },
      },
      visualMap: {
        min: 0, max, calculable: true, orient: 'horizontal', left: 'center', bottom: 4,
        inRange: { color: [hexAlpha(p.accent, 0.12), p.accent] },
        textStyle: { color: p.ink3, fontFamily: p.fontMono },
      },
      series: [{
        type: 'heatmap', data: cells,
        label: { show: true, color: p.ink, fontFamily: p.fontMono, fontSize: 11, formatter: (d) => fmt(d.value[2]) },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: hexAlpha(p.accent, 0.5) } },
      }],
    }, true);
    inst.on('click', (params) => {
      const r = series[params.value ? params.value[0] : params.dataIndex];
      if (!r || r.weekday == null) return;
      const additive = !!(params.event && (params.event.shiftKey || params.event.ctrlKey || params.event.metaKey));
      toggleFilter('weekday', r.weekday, additive);
    });
  }

  // ── ⑤ time series: daily area (dataZoom slider+brush) + hourly bars ────
  function buildDaily(node) {
    const p = palette();
    const allDaily = data.daily || [];
    const onlyWeekday = facetActive('weekday') && !facetActive('rank') && !facetActive('hour');
    const daily = (onlyWeekday && allDaily.length && allDaily.every((r) => r.day != null))
      ? allDaily.filter((r) => filterState.weekday.has(r.day % 7))
      : allDaily;
    if (!daily.length) { node.parentElement.replaceWith(scaffoldShell('time', '時系列', '日次エリア＋時間スパークライン')); return; }
    const cats = daily.map((r) => r.label || '');
    const vals = daily.map((r) => r.qty || 0);
    const inst = ensureChart(node, 'daily');
    inst.setOption({
      animation: !reduceMotion(),
      grid: { left: 52, right: 20, top: 18, bottom: 64 },
      toolbox: toolbox(p),
      tooltip: { trigger: 'axis', ...tipStyle(p),
        formatter: (ps) => `<b>${esc(ps[0].axisValue)}</b> · ${fmt(ps[0].data)}` },
      dataZoom: [
        { type: 'inside', filterMode: 'none' },
        { type: 'slider', height: 22, bottom: 18, filterMode: 'none',
          borderColor: p.line, fillerColor: hexAlpha(p.accent, 0.14),
          handleStyle: { color: p.accent }, moveHandleStyle: { color: p.accentSoft },
          dataBackground: { lineStyle: { color: p.accentSoft }, areaStyle: { color: hexAlpha(p.accent, 0.1) } },
          textStyle: { color: p.ink3, fontFamily: p.fontMono } },
      ],
      xAxis: {
        type: 'category', data: cats, boundaryGap: false,
        axisLabel: { color: p.ink3, fontFamily: p.fontMono, hideOverlap: true },
        axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false },
      },
      yAxis: { type: 'value', axisLabel: { color: p.ink3, fontFamily: p.fontMono },
        splitLine: { lineStyle: { color: p.line } } },
      series: [{
        name: '日次物量', type: 'line', data: vals, smooth: false,
        symbol: 'circle', symbolSize: 4, showSymbol: false,
        lineStyle: { color: p.accent, width: 2 }, itemStyle: { color: p.accent },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: hexAlpha(p.accent, 0.22) }, { offset: 1, color: hexAlpha(p.accent, 0.02) }]) },
        markPoint: { symbol: 'pin', symbolSize: 40, data: [{ type: 'max', name: 'ピーク' }],
          itemStyle: { color: p.accent }, label: { color: p.panel, fontSize: 9, fontFamily: p.fontMono } },
      }],
    }, true);
  }

  function buildHourly(node) {
    const p = palette();
    const haveXtab = xtabCells().length > 0;
    const hourly = haveXtab
      ? hourProfile().map((r) => ({ ...r, label: `${r.hour}時` }))
      : (data.hourly || []).map((r) => ({ ...r, label: r.label || (r.hour != null ? `${r.hour}時` : '') }));
    if (!hourly.length) { node.parentElement.replaceWith(scaffoldShell('hour', '時間帯', 'スパークライン')); return; }
    const cats = hourly.map((r) => r.label);
    const hourSel = filterState.hour;
    const bars = hourly.map((r) => ({
      value: r.qty || 0,
      itemStyle: { color: (r.hour != null && hourSel.has(r.hour)) ? p.accent : hexAlpha(p.accent, 0.5) },
    }));
    const inst = ensureChart(node, 'hour');
    inst.setOption({
      animation: !reduceMotion(),
      grid: { left: 44, right: 16, top: 12, bottom: 46 },
      toolbox: toolbox(p),
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...tipStyle(p),
        formatter: (ps) => `<b>${esc(ps[0].axisValue)}</b> · ${fmt(ps[0].data.value != null ? ps[0].data.value : ps[0].data)}` },
      // brush via dataZoom: drag the slider to commit a contiguous hour range.
      dataZoom: [
        { type: 'inside', filterMode: 'none' },
        { type: 'slider', height: 18, bottom: 14, filterMode: 'none',
          borderColor: p.line, fillerColor: hexAlpha(p.accent, 0.14), handleStyle: { color: p.accent },
          textStyle: { color: p.ink3, fontFamily: p.fontMono } },
      ],
      xAxis: { type: 'category', data: cats,
        axisLabel: { color: p.ink3, fontFamily: p.fontMono, interval: 3 },
        axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: p.ink3, fontFamily: p.fontMono },
        splitLine: { lineStyle: { color: p.line } } },
      series: [{ name: '時間帯物量', type: 'bar', data: bars, barMaxWidth: 22 }],
    }, true);
    // Single bar tap → toggle that hour facet (plain = single, shift = add).
    inst.on('click', (params) => {
      const r = hourly[params.dataIndex]; if (!r || r.hour == null) return;
      const additive = !!(params.event && (params.event.shiftKey || params.event.ctrlKey || params.event.metaKey));
      toggleFilter('hour', r.hour, additive);
    });
    // dataZoom drag → commit the visible hour range as the hour facet. Debounced
    // and deferred: a drag fires many `datazoom` ticks, and render() disposes the
    // very instance that's firing, so we read state synchronously then re-render on
    // a trailing timer (settled), guarding against disposing mid-dispatch.
    inst.on('datazoom', () => {
      const opt = inst.getOption();
      const dz = (opt.dataZoom || []).find((z) => z.type === 'slider') || (opt.dataZoom || [])[0];
      if (!dz) return;
      const n = hourly.length;
      const i0 = Math.max(0, Math.round((dz.start / 100) * (n - 1)));
      const i1 = Math.min(n - 1, Math.round((dz.end / 100) * (n - 1)));
      const next = new Set();
      if (!(i0 <= 0 && i1 >= n - 1)) {                 // full range = no selection
        for (let k = i0; k <= i1; k += 1) { const hr = hourly[k] && hourly[k].hour; if (hr != null) next.add(hr); }
      }
      const cur = Array.from(filterState.hour).sort().join(',');
      const nxt = Array.from(next).sort().join(',');
      if (cur === nxt) return;
      if (dzTimer) clearTimeout(dzTimer);
      dzTimer = setTimeout(() => { dzTimer = 0; filterState.hour = next; render(); }, 220);
    });
  }

  // ── render ────────────────────────────────────────────────────────────
  function render() {
    disposeCharts();
    const name = getProject();
    if (!name) { root.innerHTML = '<div class="bia-empty">プロジェクトを選択してください。</div>'; return; }
    if (loadErr) {
      root.innerHTML = `<div class="bia-err">
        <div class="msg">読み込めませんでした</div>
        <div class="det">${esc(loadErr)}</div>
        <button type="button" class="bia-retry" data-bia="retry">再試行</button>
      </div>`;
      const btn = root.querySelector('[data-bia="retry"]');
      if (btn) btn.onclick = () => { loadErr = null; data = null; render(); load(); };
      return;
    }
    if (!data) {
      root.innerHTML = `<div class="bia-load"><span class="bia-spin" aria-hidden="true"></span>
        <span>分析データを読み込み中…</span></div>`;
      return;
    }
    if (!data.has_data) {
      root.innerHTML = `
        ${askBox()}
        ${chipsRow()}
        <div class="bia-empty">
          <b>分析できる実データがまだありません。</b><br>
          受注・出荷の明細を取り込むと、ABC・曜日・時間帯の分析がここに表示されます。
          <div class="bia-empty-acts">
            <span class="bia-cta primary" data-bia="import">← データを取込む</span>
            <span class="bia-cta" data-bia="cta">① 取込へ</span>
          </div>
        </div>`;
      wireAsk();
      const imp = root.querySelector('[data-bia="import"]');
      if (imp) imp.onclick = () => nav('dataanalysis');
      const cta = root.querySelector('[data-bia="cta"]');
      if (cta) cta.onclick = () => { window.location.hash = '#/取込'; toast('①取込でデータを取り込んでください。', 'info'); };
      return;
    }

    // build the DOM scaffold (HTML for text bits; chart sections appended as nodes)
    const ins = insights();
    root.innerHTML = `
      ${askBox()}
      ${chipsRow()}
      ${filterBar()}
      ${ins.length ? `<div class="bia-ins">${ins.map(insCard).join('')}</div>` : ''}
      <div data-charts></div>`;
    const slot = root.querySelector('[data-charts]');
    // ABC pareto
    const paretoSec = chartShell('abc', 'ABCパレート', '物量降順の棒＋累積%線', 'バー/凡例クリックで絞込', 280);
    slot.appendChild(paretoSec);
    buildPareto(paretoSec.querySelector('[data-ec]'));
    // weekday heatmap
    const wkSub = propagatingActive() ? `${filterDescription()}で絞込中` : '濃いほど物量大';
    const wkSec = chartShell('weekday', '曜日別ヒートマップ', wkSub, 'セルクリックで曜日を絞込', 180);
    slot.appendChild(wkSec);
    buildWeekday(wkSec.querySelector('[data-ec]'));
    // daily time series
    const tSec = chartShell('time', '時系列（日次）', '日次エリア＋スクラブ', 'スライダーで日を絞込', 240);
    slot.appendChild(tSec);
    buildDaily(tSec.querySelector('[data-ec]'));
    // hourly sparkline (own facet section: time)
    const hSub = propagatingActive() ? `${filterDescription()}で絞込中` : 'スパークライン';
    const hSec = chartShell('hour', '時間帯', hSub, 'バー/スライダーで時間帯を絞込', 170);
    hSec.dataset.sec = 'time';   // share the 'time' focus target
    slot.appendChild(hSec);
    buildHourly(hSec.querySelector('[data-ec]'));

    wireAsk();
    wireInsights();
    wireFilterBar();
  }

  function askBox() {
    return `<div class="bia-ask">
      <div class="bia-ask-in">
        <span class="q">?</span>
        <input data-bia="q" type="text" placeholder="${esc(EXAMPLES[exIdx])}" aria-label="質問を入力" />
        <span class="slash">/</span>
      </div>
      <div class="bia-answer" data-bia="answer"></div>
    </div>`;
  }

  function chipsRow() {
    return `<div class="bia-chips" role="group" aria-label="質問の例">
      ${EXAMPLES.map((e) => `<button type="button" class="bia-chip" data-ex="${esc(e)}">${esc(e)}</button>`).join('')}
    </div>`;
  }

  function filterBar() {
    if (!filterActive()) return '<div class="bia-filterbar"></div>';
    const pills = [];
    if (filterState.abc != null) pills.push(['abc', null, `SKU:${filterState.abc}`]);
    if (facetActive('rank')) facetValues('rank').forEach((v) => pills.push(['rank', v, `ランク:${v}`]));
    if (facetActive('weekday')) facetValues('weekday').forEach((v) => pills.push(['weekday', v, `曜日:${weekdayLabel(v)}`]));
    if (facetActive('hour')) facetValues('hour').forEach((v) => pills.push(['hour', v, `時間:${v}時`]));
    const pillHtml = pills.map(([key, val, label]) =>
      `<button type="button" class="bia-pill" data-facet="${esc(key)}"`
      + `${val != null ? ` data-val="${esc(val)}"` : ''} aria-label="${esc(label)} を解除">`
      + `${esc(label)} <span class="x" aria-hidden="true">✕</span></button>`).join('');
    return `<div class="bia-filterbar" role="group" aria-label="適用中のフィルタ">
      <span class="lbl">絞込:</span>
      ${pillHtml}
      <button type="button" class="bia-fclear" data-bia="clearf">すべて解除</button>
    </div>`;
  }

  function insCard(c) {
    return `<div class="bia-card" data-go="${c.sec}">
      <div class="kic">${esc(c.kic)}</div>
      <div class="fact">${c.fact}</div>
      <div class="imp">${esc(c.imp)}</div>
      <div class="bia-drill">
        <a data-nav="bi" role="link" tabindex="0">物量シミュで見る →</a>
        <a data-nav="timetable" role="link" tabindex="0">人員設計へ →</a>
      </div>
      <div class="go">→ 該当チャートへ</div>
    </div>`;
  }

  // ── wiring ────────────────────────────────────────────────────────────
  function wireAsk() {
    const inp = root.querySelector('[data-bia="q"]');
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); answerQuestion(inp.value); }
        else if (e.key === 'Escape') { inp.value = ''; setAnswer(''); clearDim(); inp.blur(); }
      });
    }
    bindExampleDelegation();
  }

  let exDelegated = false;
  function bindExampleDelegation() {
    if (exDelegated) return;
    exDelegated = true;
    root.addEventListener('click', (e) => {
      const ex = e.target.closest('[data-ex]');
      if (ex && root.contains(ex)) { e.preventDefault(); runExample(ex.dataset.ex); }
    });
  }

  function wireInsights() {
    root.querySelectorAll('[data-go]').forEach((c) => { c.onclick = () => focus(c.dataset.go); });
    root.querySelectorAll('[data-nav]').forEach((a) => {
      const go = (e) => { e.stopPropagation(); e.preventDefault(); nav(a.dataset.nav); };
      a.onclick = go;
      a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
    });
  }

  function wireFilterBar() {
    root.querySelectorAll('.bia-pill[data-facet]').forEach((p) => {
      p.onclick = () => {
        const key = p.dataset.facet;
        if (key === 'abc' || p.dataset.val == null) { clearFacet(key); return; }
        const raw = p.dataset.val;
        const val = (key === 'weekday' || key === 'hour') ? Number(raw) : raw;
        removeFacetValue(key, val);
      };
    });
    const clr = root.querySelector('[data-bia="clearf"]');
    if (clr) clr.onclick = () => clearFilter();
  }

  // ── example placeholder rotation (gated: one-shot per visit) ─────────────
  function startExampleRotation() {
    if (reduceMotion()) return;
    let passes = 0;
    stopRotation();
    exTimer = setInterval(() => {
      exIdx = (exIdx + 1) % EXAMPLES.length;
      if (exIdx === 0 && ++passes >= 1) { stopRotation(); return; }
      const inp = root.querySelector('[data-bia="q"]');
      if (inp && !inp.value && document.activeElement !== inp) inp.placeholder = EXAMPLES[exIdx];
    }, 5000);
  }
  function stopRotation() { if (exTimer) { clearInterval(exTimer); exTimer = 0; } }

  // `/` focuses the question box from anywhere in this view
  function onSlash(e) {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!el.contains(t) && el.offsetParent === null) return;
    const inp = root.querySelector('[data-bia="q"]');
    if (inp) { e.preventDefault(); inp.focus(); }
  }
  document.addEventListener('keydown', onSlash);

  async function load() {
    const name = getProject();
    if (!name) { render(); return; }
    loadErr = null;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(name)}/bi/analysis`);
      if (!r.ok) throw new Error(r.statusText || `HTTP ${r.status}`);
      data = await r.json();
      render();
      startExampleRotation();
    } catch (e) {
      loadErr = (e && e.message) ? e.message : String(e);
      render();
      toast('きいて分析の読み込みに失敗', 'error');
    }
  }

  load();
  return {
    refresh() {
      data = null;
      loadErr = null;
      filterState = freshFilterState();
      render();
      load();
    },
    dispose() {
      stopRotation();
      if (dzTimer) { clearTimeout(dzTimer); dzTimer = 0; }
      disposeCharts();
      if (ro) { ro.disconnect(); ro = null; }
      window.removeEventListener('resize', onWinResize);
      document.removeEventListener('keydown', onSlash);
      document.removeEventListener('themechange', onThemeChange);
      el.innerHTML = '';
    },
  };
}
