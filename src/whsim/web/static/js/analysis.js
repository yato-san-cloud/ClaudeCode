// analysis.js — the "分析" (analysis) dashboard view for whsim.
//
// Consolidates an analysis-tool-style summary INTO whsim: it fetches the
// reshaped KPI payload from `GET /api/projects/{name}/analysis` and renders a
// Notion-style summary screen — "自動で見つけた注目ポイント" (指摘→提案 callouts)
// → 主要KPI hero grid → grouped standard KPIs → two lightweight self-drawn
// inline-SVG charts (per-stage congestion bar + cost / volume bar).
//
// Public API:
//   export async function mountAnalysis(targetEl, projectName)
//     — fetch the payload and render it into `targetEl`. Re-renders on the
//       document `themechange` event so SVG colours follow light/dark theme.
//
// Markup uses EXACTLY the CSS classes the shell owner defines in styles.css:
//   .an-section / .an-section-title
//   .callout (.danger|.warn|.info|.ok) > .c-icon / .c-main (.c-title/.c-fact/
//     .c-action) / .c-metric
//   .kpi-hero > .kpi-hero-cell (.kpi-label/.kpi-value/.kpi-unit/.delta.up|.down)
//   .kpi-group > .kpi-group-label + .kpi-grid > .kpi-card (.kpi-label/.kpi-value)
//   .chart-card > .chart-title/.chart-sub + inline <svg>
// Chart colours are read from CSS variables via getComputedStyle so they track
// the active theme. This module ships NO CSS of its own.
//
// Defensive throughout: a missing payload, empty insights, or a thin analytic
// estimate (few KPIs) must never throw; absent sections are simply omitted.

const SVGNS = 'http://www.w3.org/2000/svg';

// Unique id for the scoped stylesheet this module injects (additive over the
// shell's styles.css .an-* rules; everything is confined under #analysis).
const STYLE_ID = 'whsim-an-v3-style';

// ---- small helpers ----------------------------------------------------------

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Resolve a CSS custom property off :root (theme-aware). Falls back if unset.
function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name).trim();
    return v || fallback;
  } catch (_e) {
    return fallback;
  }
}

// Thousands separators for an integer-ish number.
function group(n) {
  if (!isNum(n)) return String(n);
  const neg = n < 0 ? '-' : '';
  const [intPart, frac] = Math.abs(n).toString().split('.');
  const g = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg + g + (frac ? '.' + frac : '');
}

function el(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
  }
  if (text != null) node.textContent = text;
  return node;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

// ---- scoped stylesheet (additive over styles.css; confined to #analysis) ----
//
// Everything here is namespaced under `#analysis` so it can only ever refine the
// analysis view — never the rest of the app. It REFINES the shell's .an-* rules
// (luminance hierarchy, tabular numerics, single-accent series, white-alpha
// borders) and carries the enter-only motion layer (transform/opacity only,
// `--ease-out`/`--dur-*` tokens, full `prefers-reduced-motion` stop). Injected
// once; idempotent.
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#analysis .an-view{
  --an-ease:var(--ease-out,cubic-bezier(.16,1,.3,1));
  --an-d1:var(--dur-1,120ms);
  --an-d2:var(--dur-2,180ms);
  --an-d3:var(--dur-3,240ms);
  --an-d-up:#34D399;
  --an-d-dn:#F87171;
}

/* All numerics tabular + grouped (Stripe data clarity). */
#analysis .an-view .kpi-value,
#analysis .an-view .kpi-hero .kpi-value,
#analysis .an-view .num,
#analysis .an-view .delta,
#analysis .an-view .c-metric{
  font-variant-numeric:tabular-nums;
  font-feature-settings:"tnum" 1;
}

/* ---- hero: luminance-lifted cells, single-accent rail ---- */
#analysis .an-view .kpi-hero-cell{
  position:relative;overflow:hidden;
  transition:border-color var(--an-d1) var(--an-ease),
    background-color var(--an-d1) var(--an-ease),
    transform var(--an-d1) var(--an-ease);
}
#analysis .an-view .kpi-hero-cell::after{
  content:"";position:absolute;left:0;top:0;bottom:0;width:2px;
  background:var(--accent);opacity:0;
  transition:opacity var(--an-d2) var(--an-ease);
}
@media(hover:hover){
  #analysis .an-view .kpi-hero-cell:hover{border-color:var(--line-strong,rgba(255,255,255,.14))}
  #analysis .an-view .kpi-hero-cell:hover::after{opacity:.55}
}
#analysis .an-view .kpi-hero-cell .kpi-value{letter-spacing:-.015em}

/* delta: arrow + sign + muted colour + 60px sparkline (triple-encoded) */
#analysis .an-view .delta{display:inline-flex;align-items:center;gap:5px}
#analysis .an-view .delta.up{color:var(--an-d-up)}
#analysis .an-view .delta.down{color:var(--an-d-dn)}
#analysis .an-view .delta .an-arw{font-size:9px;line-height:1}
#analysis .an-view .an-spark{display:block;flex:none;color:currentColor}
#analysis .an-view .an-spark polyline{
  stroke-dasharray:var(--an-len,80);
  stroke-dashoffset:var(--an-len,80);
}

/* ---- standard KPI cards: lifted surface, quiet hover ---- */
#analysis .an-view .kpi-card{
  transition:border-color var(--an-d1) var(--an-ease),
    background-color var(--an-d1) var(--an-ease),
    transform var(--an-d1) var(--an-ease);
}
@media(hover:hover){
  #analysis .an-view .kpi-card:hover{
    border-color:var(--line-strong,rgba(255,255,255,.14));
    transform:translateY(-1px);
  }
}

/* ---- callouts: quiet hover lift ---- */
#analysis .an-view .callout{
  transition:transform var(--an-d1) var(--an-ease),
    border-color var(--an-d1) var(--an-ease);
}
@media(hover:hover){
  #analysis .an-view .callout:hover{transform:translateY(-1px)}
}
#analysis .an-view .c-apply,
#analysis .an-view .c-action{
  transition:transform var(--an-d1) var(--an-ease),
    filter var(--an-d1) var(--an-ease);
}
#analysis .an-view .c-apply:active{transform:scale(.97)}

/* ---- chart cards: quiet chrome ---- */
#analysis .an-view .chart-card{
  transition:border-color var(--an-d1) var(--an-ease);
}
@media(hover:hover){
  #analysis .an-view .chart-card:hover{border-color:var(--line-strong,rgba(255,255,255,.14))}
}

/* ============================================================
   MOTION — enter-only, transform/opacity, ease-out
   ============================================================ */

/* (1) stagger fade-in for hero cells + KPI cards (translateY 6px -> 0) */
#analysis .an-view .kpi-hero-cell,
#analysis .an-view .kpi-card{
  opacity:0;transform:translateY(6px);will-change:transform,opacity;
}
#analysis .an-view .kpi-hero-cell.an-in,
#analysis .an-view .kpi-card.an-in{
  opacity:1;transform:none;
  transition:opacity var(--an-d2) var(--an-ease),
    transform var(--an-d2) var(--an-ease);
}
#analysis .an-view .kpi-hero-cell.an-settled,
#analysis .an-view .kpi-card.an-settled{will-change:auto}

/* sections + callouts: gentle one-shot rise */
#analysis .an-view .callout,
#analysis .an-view .chart-card{
  opacity:0;transform:translateY(6px);will-change:transform,opacity;
}
#analysis .an-view .callout.an-in,
#analysis .an-view .chart-card.an-in{
  opacity:1;transform:none;
  transition:opacity var(--an-d3) var(--an-ease),
    transform var(--an-d3) var(--an-ease);
}

/* (2) sparkline draw-on, once (stroke-dashoffset) */
#analysis .an-view .an-spark.an-draw polyline{
  transition:stroke-dashoffset 560ms var(--an-ease);
  stroke-dashoffset:0;
}

/* (3) chart rise: opacity + tiny scaleY from bottom, once */
#analysis .an-view svg.an-chart-rise{
  transform-box:fill-box;transform-origin:bottom;
  opacity:0;transform:scaleY(.97);
}
#analysis .an-view svg.an-chart-rise.an-in{
  opacity:1;transform:none;
  transition:opacity var(--an-d3) var(--an-ease),
    transform var(--an-d3) var(--an-ease);
}

/* ============================================================
   STACKED-AREA chart card (per-stage processing composition)
   ============================================================ */
/* Mono numerics everywhere in this module's numeric surfaces (Space Mono). */
#analysis .an-view .num,
#analysis .an-view .delta,
#analysis .an-view .c-metric,
#analysis .an-view .kpi-value,
#analysis .an-view .an-area-svg text,
#analysis .an-view .an-tbl td,
#analysis .an-view .an-tbl th{
  font-family:var(--font-mono,"Space Mono",ui-monospace,SFMono-Regular,monospace);
}

/* inline legend (top), short colour bars */
#analysis .an-view .an-legend{
  display:flex;gap:16px;flex-wrap:wrap;margin:2px 0 8px;
}
#analysis .an-view .an-lg{
  display:inline-flex;align-items:center;gap:6px;
  font-size:11.5px;color:var(--ink-secondary,var(--ink-mut,#9AA4B2));
  font-family:var(--font-sans,inherit);
}
#analysis .an-view .an-lg.bn{color:var(--warn,#F5B05A)}
#analysis .an-view .an-sw{width:14px;height:3px;border-radius:2px;flex:none}

/* the area svg itself rises once (re-uses .an-chart-rise contract below) */
#analysis .an-view .an-area-svg{display:block;width:100%}

/* ============================================================
   PER-STAGE ANALYSIS TABLE (difference by structure, not colour)
   ============================================================ */
#analysis .an-view .an-tbl{
  width:100%;border-collapse:collapse;font-size:13px;
}
#analysis .an-view .an-tbl thead th{
  font-family:var(--font-mono,"Space Mono",monospace);
  font-weight:500;font-size:10px;letter-spacing:.08em;text-transform:uppercase;
  color:var(--ink-secondary,var(--ink-dim,#5C6675));
  text-align:right;padding:0 0 9px;
  border-bottom:1px solid var(--line,rgba(255,255,255,.08));
}
#analysis .an-view .an-tbl thead th:first-child{text-align:left}
#analysis .an-view .an-tbl tbody td{
  padding:11px 0;text-align:right;
  border-bottom:1px solid var(--line-soft,var(--line-hair,rgba(255,255,255,.055)));
  color:var(--ink,inherit);font-variant-numeric:tabular-nums;
}
#analysis .an-view .an-tbl tbody td:first-child{
  text-align:left;font-family:var(--font-sans,inherit);font-weight:500;
}
#analysis .an-view .an-tbl tbody tr:last-child td{border-bottom:0}
/* bottleneck row: structural, restrained — left rule + faint band, no loud colour */
#analysis .an-view .an-tbl tbody tr.an-flag td:first-child{
  box-shadow:inset 2px 0 0 var(--warn,#F5B05A);
}
#analysis .an-view .an-tbl tbody tr.an-flag td{
  background:color-mix(in srgb, var(--warn,#F5B05A) 4%, transparent);
}
/* util mini-bar (right aligned) */
#analysis .an-view .an-util{display:inline-flex;align-items:center;gap:9px;justify-content:flex-end}
#analysis .an-view .an-util-bar{
  width:54px;height:5px;border-radius:3px;position:relative;overflow:hidden;
  background:var(--line-soft,var(--line-hair,rgba(255,255,255,.06)));
}
#analysis .an-view .an-util-bar i{
  position:absolute;left:0;top:0;bottom:0;border-radius:3px;
  background:var(--ink-secondary,var(--ink-mut,#9AA4B2));
}
#analysis .an-view .an-util-bar i.an-pri{background:var(--accent,#34E3FF)}
#analysis .an-view .an-util-bar i.an-w{background:var(--warn,#F5B05A)}
#analysis .an-view .an-vd{
  font-size:10.5px;font-weight:500;letter-spacing:.03em;
  padding:3px 9px;border-radius:5px;font-family:var(--font-sans,inherit);
  border:1px solid var(--line,rgba(255,255,255,.08));
  color:var(--ink-secondary,var(--ink-mut,#9AA4B2));
}
#analysis .an-view .an-vd.ok{
  border-color:color-mix(in srgb,var(--ok,#2EE6A0) 32%,transparent);
  color:var(--ok,#2EE6A0);
}
#analysis .an-view .an-vd.warn{
  border-color:color-mix(in srgb,var(--warn,#F5B05A) 40%,transparent);
  color:var(--warn,#F5B05A);
}
#analysis .an-view .an-tbl-note{
  margin-top:13px;padding-top:12px;
  border-top:1px solid var(--line-soft,var(--line-hair,rgba(255,255,255,.055)));
  font-size:11.5px;color:var(--ink-secondary,var(--ink-mut,#9AA4B2));
  display:flex;gap:8px;align-items:flex-start;line-height:1.5;
}
#analysis .an-view .an-tbl-note .an-ic{color:var(--warn,#F5B05A);flex:none;margin-top:1px}

/* prefers-reduced-motion: stop all, land at resting state with real values */
@media (prefers-reduced-motion: reduce){
  #analysis .an-view *{animation:none!important;transition:none!important}
  #analysis .an-view .kpi-hero-cell,
  #analysis .an-view .kpi-card,
  #analysis .an-view .callout,
  #analysis .an-view .chart-card{opacity:1!important;transform:none!important}
  #analysis .an-view .an-spark polyline{stroke-dashoffset:0!important}
  #analysis .an-view svg.an-chart-rise{opacity:1!important;transform:none!important}
}
`;
  const style = el('style', { id: STYLE_ID });
  style.textContent = css;
  document.head.appendChild(style);
}

// Honour the reduced-motion preference (re-checked at each render).
function prefersReducedMotion() {
  try {
    return window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_e) {
    return false;
  }
}

// ---- icons (24x24 outline, stroke=currentColor — colour via .c-icon) --------

const ICONS = {
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  trend: '<path d="M3 17l6-6 4 4 7-8"/><path d="M21 7v5h-5"/>',
  bars: '<rect x="3" y="11" width="4" height="9" rx="1"/><rect x="10" y="4" width="4" height="16" rx="1"/><rect x="17" y="14" width="4" height="6" rx="1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};

function iconSvg(name) {
  const inner = ICONS[name] || ICONS.info;
  return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
    + 'stroke-linejoin="round">' + inner + '</svg>';
}

// ---- callouts ("指摘 → 提案") -----------------------------------------------

const SEVERITIES = ['danger', 'warn', 'info', 'ok'];

function buildCallout(ins) {
  const sev = SEVERITIES.includes(ins.severity) ? ins.severity : 'info';
  const card = el('div', { class: 'callout ' + sev });

  const ic = el('div', { class: 'c-icon' });
  ic.innerHTML = iconSvg(ins.icon);
  card.appendChild(ic);

  const main = el('div', { class: 'c-main' });
  main.appendChild(el('div', { class: 'c-title' }, ins.title || ''));
  // .c-fact may carry inline <span class="num">…</span> markup from the API.
  const fact = el('div', { class: 'c-fact' });
  fact.innerHTML = ins.fact || '';
  main.appendChild(fact);
  // info callouts intentionally omit the recommended-action chip.
  if (ins.action && sev !== 'info') {
    const action = el('a', { class: 'c-action' });
    action.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" '
      + 'fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    action.appendChild(el('span', null, ins.action));
    main.appendChild(action);
  }
  // Actionable insight: "適用して再実行" closes the loop via a shared event that
  // app.js listens for (applies the edit, then re-runs the simulation).
  if (ins.edit && typeof ins.edit === 'object' && typeof ins.edit.path === 'string') {
    const edit = ins.edit;
    const btn = el('button', { class: 'c-apply', type: 'button' });
    const label = (typeof edit.label === 'string' && edit.label.trim())
      ? edit.label.trim() : '適用して再実行';
    btn.setAttribute('aria-label', label);
    btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" '
      + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
      + 'stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/>'
      + '<path d="M3 3v5h5"/></svg>';
    btn.appendChild(el('span', null, '適用して再実行'));
    btn.addEventListener('click', () => {
      btn.disabled = true;
      const edits = {}; edits[edit.path] = edit.value;
      document.dispatchEvent(new CustomEvent('whsim:apply-run', { detail: { edits } }));
    });
    main.appendChild(btn);
  }
  card.appendChild(main);

  if (ins.metric != null && ins.metric !== '') {
    card.appendChild(el('div', { class: 'c-metric' }, String(ins.metric)));
  }
  return card;
}

function buildInsightsSection(insights) {
  const sec = el('section', { class: 'an-section' });
  sec.appendChild(el('h2', { class: 'an-section-title' }, '自動で見つけた注目ポイント'));
  if (!insights.length) {
    sec.appendChild(el('p', { class: 'c-fact' }, '注目すべき点は見つかりませんでした。'));
    return sec;
  }
  const list = el('div', { class: 'callouts' });
  insights.forEach((ins) => { if (ins) list.appendChild(buildCallout(ins)); });
  sec.appendChild(list);
  return sec;
}

// ---- KPIs -------------------------------------------------------------------

function valueSpan(value, unit) {
  const wrap = document.createDocumentFragment();
  const span = el('span', { class: 'num' }, isNum(value) ? group(value) : String(value));
  // Stamp the raw target + decimal count so the (display-only) count-up
  // animation can render intermediate frames with identical formatting and
  // land EXACTLY on the real value. Non-numeric values are left untouched.
  if (isNum(value)) {
    const frac = Math.abs(value).toString().split('.')[1];
    span.dataset.count = String(value);
    span.dataset.decimals = String(frac ? frac.length : 0);
  }
  wrap.appendChild(span);
  if (unit) wrap.appendChild(el('span', { class: 'kpi-unit' }, unit));
  return wrap;
}

// Format a numeric to N decimals WITH thousands separators (count-up frames).
function fmtCount(value, decimals) {
  const neg = value < 0 ? '-' : '';
  const fixed = Math.abs(value).toFixed(decimals);
  const [intPart, frac] = fixed.split('.');
  const g = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg + g + (frac ? '.' + frac : '');
}

// A 60x20 sparkline whose slope encodes the delta direction. Purely a visual
// flourish keyed off the existing delta.dir — it invents no data labels and is
// drawn-on once. `dir` is 'up' | 'down'.
function deltaSparkline(dir) {
  const up = dir === 'up';
  // Gentle, slightly noisy monotone trend (8 points across 60px).
  const ys = up
    ? [15, 14, 14.5, 12, 12.5, 9, 9.5, 6]
    : [6, 7, 6.5, 9, 8.5, 11, 11.5, 14];
  const pts = ys.map((y, i) => `${(i * 60) / 7},${y}`).join(' ');
  const svg = svgEl('svg', { class: 'an-spark', width: '60', height: '20',
    viewBox: '0 0 60 20', 'aria-hidden': 'true' });
  svg.appendChild(svgEl('polyline', { fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    points: pts }));
  return svg;
}

function buildHero(heroItems) {
  const grid = el('div', { class: 'kpi-hero' });
  heroItems.forEach((h) => {
    if (!h) return;
    const cell = el('div', { class: 'kpi-hero-cell' });
    cell.appendChild(el('div', { class: 'kpi-label' }, h.label || ''));
    const val = el('div', { class: 'kpi-value' });
    val.appendChild(valueSpan(h.value, h.unit));
    cell.appendChild(val);
    if (h.delta && (h.delta.dir === 'up' || h.delta.dir === 'down')) {
      const d = el('div', { class: 'delta ' + h.delta.dir });
      const arw = el('span', { class: 'an-arw' }, h.delta.dir === 'up' ? '▲' : '▼');
      d.appendChild(arw);
      d.appendChild(el('span', null, h.delta.text || ''));
      d.appendChild(deltaSparkline(h.delta.dir));
      cell.appendChild(d);
    }
    grid.appendChild(cell);
  });
  return grid;
}

function buildKpiGroups(groups) {
  const frag = document.createDocumentFragment();
  groups.forEach((grp) => {
    if (!grp || !Array.isArray(grp.items) || !grp.items.length) return;
    const wrap = el('div', { class: 'kpi-group' });
    wrap.appendChild(el('div', { class: 'kpi-group-label' }, grp.label || ''));
    const grid = el('div', { class: 'kpi-grid' });
    grp.items.forEach((it) => {
      if (!it) return;
      const card = el('div', { class: 'kpi-card' });
      card.appendChild(el('div', { class: 'kpi-label' }, it.label || ''));
      const val = el('div', { class: 'kpi-value num' });
      val.appendChild(valueSpan(it.value, it.unit));
      card.appendChild(val);
      grid.appendChild(card);
    });
    if (grid.children.length) {
      wrap.appendChild(grid);
      frag.appendChild(wrap);
    }
  });
  return frag;
}

function buildKpiSection(kpis) {
  const sec = el('section', { class: 'an-section' });
  sec.appendChild(el('h2', { class: 'an-section-title' }, '主要KPI'));
  const hero = Array.isArray(kpis.hero) ? kpis.hero : [];
  if (hero.length) sec.appendChild(buildHero(hero));
  const groups = Array.isArray(kpis.groups) ? kpis.groups : [];
  if (groups.length) sec.appendChild(buildKpiGroups(groups));
  if (!hero.length && !groups.length) {
    sec.appendChild(el('p', { class: 'c-fact' }, 'KPIがまだありません。'));
  }
  return sec;
}

// ---- charts (lightweight self-drawn inline SVG) -----------------------------

// A vertical bar chart. `highlightLabel` paints the matching bar with the
// "warn" colour to mark the bottleneck/peak. Colours are theme-aware.
function barChart(labels, values, opts) {
  const o = opts || {};
  const W = 460, H = 240, m = { t: 16, r: 16, b: 38, l: 48 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const nums = values.map((v) => (isNum(v) ? v : 0));
  const maxY = Math.max(0.0001, Math.max(...nums) * 1.12);
  const n = Math.max(1, nums.length);
  const gap = iw / n, bw = gap * 0.58;
  const yOf = (v) => m.t + ih - ih * (v / maxY);

  const base = o.color || cssVar('--accent', '#2383e2');
  const peak = o.peakColor || cssVar('--warn', '#e2961a');
  const hair = cssVar('--line-hair', 'rgba(55,53,47,0.09)');
  const faint = cssVar('--ink-secondary', 'rgba(55,53,47,0.45)');

  const s = svgEl('svg', { class: 'an-chart-rise', viewBox: `0 0 ${W} ${H}`,
    width: '100%', role: 'img' });
  // gridlines + y labels
  for (let t = 0; t <= 4; t++) {
    const v = (maxY * t) / 4, yy = yOf(v);
    s.appendChild(svgEl('line', { x1: m.l, y1: yy, x2: W - m.r, y2: yy,
      stroke: hair, 'stroke-width': '1' }));
    const lab = svgEl('text', { x: m.l - 8, y: yy + 4, 'text-anchor': 'end',
      'font-size': '11', fill: faint });
    lab.textContent = String(Math.round(v)) + (o.suffix || '');
    s.appendChild(lab);
  }
  nums.forEach((v, i) => {
    const cx = m.l + gap * i + gap / 2;
    const h = ih * (v / maxY);
    const isPeak = o.highlightLabel != null && labels[i] === o.highlightLabel;
    s.appendChild(svgEl('rect', { x: cx - bw / 2, y: yOf(v), width: bw,
      height: Math.max(0, h), rx: '3', fill: isPeak ? peak : base }));
    // value above bar
    const vt = svgEl('text', { x: cx, y: yOf(v) - 5, 'text-anchor': 'middle',
      'font-size': '11', fill: faint });
    vt.textContent = (o.fmt ? o.fmt(v) : String(v)) + (o.suffix || '');
    s.appendChild(vt);
    // x label
    const xt = svgEl('text', { x: cx, y: H - 12, 'text-anchor': 'middle',
      'font-size': '11.5', fill: faint });
    xt.textContent = labels[i];
    s.appendChild(xt);
  });
  return s;
}

function buildChartCard(title, sub, svg) {
  const card = el('div', { class: 'chart-card' });
  card.appendChild(el('div', { class: 'chart-title' }, title));
  if (sub) card.appendChild(el('div', { class: 'chart-sub' }, sub));
  if (svg) card.appendChild(svg);
  return card;
}

// ---- stacked-area composition (per-stage processing share) -----------------
//
// HONEST DATA: the analysis payload carries no time series, only the real
// per-stage utilisation (`charts.stages.values`). We therefore render the
// real per-stage figures as a stacked-area COMPOSITION across the process
// pipeline (picking → packing → … in the order the engine emits them). No
// hourly numbers, counts, or waits are invented; we plot exactly the values
// the engine measured. The x-axis is the (real) ordered stage sequence, not a
// fabricated clock. Single cyan series (the primary/first stage); every other
// band is neutral so cyan stays <5% of area. The bottleneck band is outlined
// in `warn` and annotated. Horizontal grid only; inline top legend with short
// colour bars is built separately by `buildStageLegend`.
//
// Each band's height at stage i is that stage's own measured value; the bands
// are stacked so the silhouette reads as the cumulative processing profile
// across the pipeline. `peakLabel` marks the bottleneck stage.
function stackedAreaChart(labels, values, peakLabel) {
  const W = 720, H = 312;
  const plot = { l: 56, r: 20, t: 22, b: 40 };
  const x0 = plot.l, x1 = W - plot.r, y0 = H - plot.b, yTop = plot.t;
  const iw = x1 - x0, ih = y0 - yTop;
  const nums = values.map((v) => (isNum(v) && v > 0 ? v : 0));
  const n = nums.length;

  // Neutral layer ramp (so only ONE band — the first/primary — is cyan).
  const accent = cssVar('--accent', cssVar('--cyan', '#34E3FF'));
  const warn = cssVar('--warn', '#F5B05A');
  const neutralVars = ['--n1', '--n2', '--n3'];
  const neutralFallback = ['#4A5A72', '#3A4860', '#323E54'];
  const ink = cssVar('--ink-secondary', cssVar('--ink-dim', '#5C6675'));
  const hair = cssVar('--line-hair', 'rgba(255,255,255,.04)');
  const axis = cssVar('--line', 'rgba(255,255,255,.09)');

  // colour for band i: first band cyan; rest cycle the neutral ramp; the
  // bottleneck band always carries the warn outline regardless of fill.
  function bandColor(i, label) {
    if (label === peakLabel) return warn;
    if (i === 0) return accent;
    const k = (i - 1) % neutralVars.length;
    return cssVar(neutralVars[k], neutralFallback[k]);
  }

  // y-scale: stack heights so the tallest cumulative column fits with headroom.
  // We stack the bands bottom→top; the cumulative max sets the scale.
  let cumMax = 0;
  { let acc = 0; for (let i = 0; i < n; i++) { acc += nums[i]; if (acc > cumMax) cumMax = acc; } }
  const maxY = Math.max(0.0001, cumMax * 1.1);
  const xOf = (i) => (n <= 1 ? x0 + iw / 2 : x0 + (iw * i) / (n - 1));
  const yOf = (v) => y0 - ih * (v / maxY);

  const svg = svgEl('svg', { class: 'an-area-svg an-chart-rise',
    viewBox: `0 0 ${W} ${H}`, width: '100%',
    preserveAspectRatio: 'xMidYMid meet', role: 'img',
    'aria-label': '工程別処理量の積み上げエリアチャート（実測の工程別指標を構成比として表示）。' });

  // horizontal grid + y labels (4 rows), faint.
  const gridG = svgEl('g', { 'font-family': 'inherit', 'font-size': '10', fill: ink });
  for (let t = 0; t <= 3; t++) {
    const v = (maxY * t) / 3, yy = yOf(v);
    gridG.appendChild(svgEl('line', { x1: x0, y1: yy, x2: x1, y2: yy,
      stroke: t === 0 ? axis : hair, 'stroke-width': '1' }));
    const lab = svgEl('text', { x: x0 - 8, y: yy + 4, 'text-anchor': 'end' });
    lab.textContent = String(Math.round(v));
    gridG.appendChild(lab);
  }
  svg.appendChild(gridG);

  // Build cumulative top-edge for each band (bottom→top stacking). lower[i] is
  // the running baseline before adding band b; upper = lower + band value.
  const baselines = new Array(n).fill(0); // running cumulative at each x point
  // We draw bands from the LAST (topmost) to the FIRST so earlier (cyan) sits
  // visually in front; but stacking math is per-x cumulative across all bands.
  // Compute each band's absolute top at its own x; for an area silhouette we
  // interpolate the cumulative profile across stages.
  // cumulative[i] after adding bands 0..k.
  const order = labels.map((_, i) => i);
  // Precompute cumulative tops: cum[k][i] = sum of values[0..k] at point i.
  // Since each band has a single value spread across the pipeline, we render
  // each band as a filled ribbon between its lower and upper cumulative edges.
  const lowerEdge = order.map(() => new Array(n).fill(0));
  const upperEdge = order.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < n; k++) {
      lowerEdge[k][i] = acc;
      acc += nums[k];
      upperEdge[k][i] = acc;
    }
  }

  // Draw bands back-to-front (topmost first) so the cyan primary reads cleanly.
  for (let k = n - 1; k >= 0; k--) {
    const col = bandColor(k, labels[k]);
    const isPeak = labels[k] === peakLabel;
    // ribbon path: top edge L→R, bottom edge R→L
    let d = '';
    for (let i = 0; i < n; i++) {
      d += (i === 0 ? 'M' : 'L') + xOf(i).toFixed(1) + ',' + yOf(upperEdge[k][i]).toFixed(1) + ' ';
    }
    for (let i = n - 1; i >= 0; i--) {
      d += 'L' + xOf(i).toFixed(1) + ',' + yOf(lowerEdge[k][i]).toFixed(1) + ' ';
    }
    d += 'Z';
    svg.appendChild(svgEl('path', { d, fill: col,
      'fill-opacity': isPeak ? '0.20' : (k === 0 ? '0.26' : '0.16'),
      stroke: col, 'stroke-width': isPeak ? '1.5' : (k === 0 ? '1.7' : '1'),
      'stroke-opacity': isPeak ? '0.9' : (k === 0 ? '1' : '0.7') }));
  }

  // Peak annotation on the bottleneck stage (real label), if present.
  const pIdx = peakLabel != null ? labels.indexOf(peakLabel) : -1;
  if (pIdx >= 0) {
    const px = xOf(pIdx);
    const ann = svgEl('g', {});
    ann.appendChild(svgEl('line', { x1: px, y1: yTop, x2: px, y2: y0,
      stroke: warn, 'stroke-width': '1', 'stroke-dasharray': '3 3',
      'stroke-opacity': '.55' }));
    ann.appendChild(svgEl('circle', { cx: px, cy: yOf(upperEdge[pIdx][pIdx]),
      r: '3', fill: warn }));
    const t1 = svgEl('text', { x: px, y: yTop + 8, 'text-anchor': 'middle',
      'font-size': '10', fill: warn });
    t1.textContent = 'ピーク ' + peakLabel;
    const t2 = svgEl('text', { x: px, y: yTop + 20, 'text-anchor': 'middle',
      'font-size': '10', fill: warn, 'fill-opacity': '.82' });
    t2.textContent = '律速工程';
    // keep labels inside the plot horizontally for edge stages
    if (pIdx === 0) { t1.setAttribute('text-anchor', 'start'); t2.setAttribute('text-anchor', 'start'); t1.setAttribute('x', px); t2.setAttribute('x', px); }
    if (pIdx === n - 1) { t1.setAttribute('text-anchor', 'end'); t2.setAttribute('text-anchor', 'end'); }
    ann.appendChild(t1);
    ann.appendChild(t2);
    svg.appendChild(ann);
  }

  // x-axis labels: the real ordered stage names.
  const xg = svgEl('g', { 'font-family': 'inherit', 'font-size': '10',
    fill: ink, 'text-anchor': 'middle' });
  labels.forEach((lab, i) => {
    const t = svgEl('text', { x: xOf(i), y: y0 + 18,
      fill: lab === peakLabel ? warn : ink });
    t.textContent = lab;
    xg.appendChild(t);
  });
  svg.appendChild(xg);

  return svg;
}

// inline legend (top), short colour bars — mirrors the band colours used by
// stackedAreaChart so the two never drift. The bottleneck entry uses .bn.
function buildStageLegend(labels, peakLabel) {
  const wrap = el('div', { class: 'an-legend' });
  const accent = cssVar('--accent', cssVar('--cyan', '#34E3FF'));
  const warn = cssVar('--warn', '#F5B05A');
  const neutralVars = ['--n1', '--n2', '--n3'];
  const neutralFallback = ['#4A5A72', '#3A4860', '#323E54'];
  labels.forEach((lab, i) => {
    const isPeak = lab === peakLabel;
    let col;
    if (isPeak) col = warn;
    else if (i === 0) col = accent;
    else { const k = (i - 1) % neutralVars.length; col = cssVar(neutralVars[k], neutralFallback[k]); }
    const lg = el('span', { class: 'an-lg' + (isPeak ? ' bn' : '') });
    const sw = el('span', { class: 'an-sw' });
    sw.style.background = col;
    lg.appendChild(sw);
    lg.appendChild(document.createTextNode(isPeak ? lab + ' · ボトルネック' : lab));
    wrap.appendChild(lg);
  });
  return wrap;
}

// ---- per-stage analysis table (difference by structure, not colour) --------
//
// HONEST DATA: built from the real per-stage utilisation in `charts.stages`
// (labels + values, peak_label). The payload exposes no per-stage processing
// counts or per-stage waits, so those columns render an em dash rather than a
// fabricated number — the DOM contract (5 columns) is preserved either way.
// 判定 is derived from the real utilisation and the (real) bottleneck label.
function buildStageTable(labels, values, peakLabel) {
  const wrap = el('div', { class: 'chart-card' });
  wrap.appendChild(el('div', { class: 'chart-title' }, '工程別 分析'));
  wrap.appendChild(el('div', { class: 'chart-sub' }, '差は色でなく構造（左罫線・帯・右揃え）で示す'));

  const table = el('table', { class: 'an-tbl' });
  const thead = el('thead');
  const htr = el('tr');
  ['工程', '稼働率', '処理(件)', '平均待ち(s)', '判定'].forEach((h) => {
    htr.appendChild(el('th', null, h));
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el('tbody');
  let bottleneckShown = false;
  labels.forEach((lab, i) => {
    const util = isNum(values[i]) ? values[i] : null; // already a percentage
    const isPeak = lab === peakLabel;
    const tr = el('tr', isPeak ? { class: 'an-flag' } : null);
    if (isPeak) bottleneckShown = true;

    // 工程
    tr.appendChild(el('td', null, lab));

    // 稼働率 (real util-bar)
    const utilTd = el('td');
    const cell = el('span', { class: 'an-util' });
    cell.appendChild(el('span', { class: 'num' },
      util != null ? group(Math.round(util * 10) / 10) + '%' : '—'));
    const bar = el('span', { class: 'an-util-bar' });
    const fill = el('i', { class: isPeak ? 'an-w' : (i === 0 ? 'an-pri' : '') });
    fill.style.width = (util != null ? Math.max(0, Math.min(100, util)) : 0) + '%';
    bar.appendChild(fill);
    cell.appendChild(bar);
    utilTd.appendChild(cell);
    tr.appendChild(utilTd);

    // 処理(件) — no honest per-stage source in payload → em dash.
    tr.appendChild(el('td', { class: 'num' }, '—'));
    // 平均待ち(s) — no honest per-stage source in payload → em dash.
    tr.appendChild(el('td', { class: 'num' }, '—'));

    // 判定 — derived from real utilisation + bottleneck flag.
    const vtd = el('td');
    let cls = 'an-vd ok', txt = '良好';
    if (isPeak || (util != null && util >= 85)) { cls = 'an-vd warn'; txt = '要注意'; }
    else if (util == null) { cls = 'an-vd'; txt = '—'; }
    vtd.appendChild(el('span', { class: cls }, txt));
    tr.appendChild(vtd);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  // restrained bottleneck note (only when a bottleneck row is present).
  if (bottleneckShown && peakLabel) {
    const note = el('div', { class: 'an-tbl-note' });
    const ic = el('span', { class: 'an-ic' }, '⚠');
    note.appendChild(ic);
    note.appendChild(el('span', null,
      `${peakLabel}が最繁忙工程で全体スループットを律速。当該工程の能力増強でサイクル短縮を検討。`));
    wrap.appendChild(note);
  }
  return wrap;
}

function buildChartsSection(charts, currency) {
  const stages = charts.stages || {};
  const cost = charts.cost || null;
  const hasStages = Array.isArray(stages.labels) && stages.labels.length;
  const hasCost = cost && Array.isArray(cost.labels) && cost.labels.length;
  if (!hasStages && !hasCost) return null;

  const sec = el('section', { class: 'an-section' });
  sec.appendChild(el('h2', { class: 'an-section-title' }, '物量の動き / コスト'));
  const grid = el('div', { class: 'chart-grid' });

  if (hasStages) {
    // Stacked-area composition (mock core) built from the REAL per-stage
    // utilisation series. No fabricated time/counts — the bands are the
    // measured per-stage figures, stacked across the ordered pipeline.
    const labels = stages.labels;
    const values = stages.values || [];
    const peak = stages.peak_label;

    const card = el('div', { class: 'chart-card' });
    card.appendChild(el('div', { class: 'chart-title' }, '工程別 処理量（積み上げ）'));
    const sub = peak
      ? `工程別の実測指標を構成比として積み上げ。${peak}が最繁忙工程。`
      : '工程別の実測指標を構成比として積み上げ。';
    card.appendChild(el('div', { class: 'chart-sub' }, sub));
    card.appendChild(buildStageLegend(labels, peak));
    card.appendChild(stackedAreaChart(labels, values, peak));
    grid.appendChild(card);

    // Per-stage analysis table (structure, not colour).
    grid.appendChild(buildStageTable(labels, values, peak));
  }

  if (hasCost) {
    const cur = cost.currency || currency || '¥';
    const svg = barChart(cost.labels, cost.values || [], {
      color: cssVar('--outbound', '#0d9488'),
      fmt: (v) => cur + group(Math.round(v * 100) / 100),
    });
    grid.appendChild(buildChartCard('1件あたりコスト内訳',
      `${cur} / 件。人件費と設備費の内訳。`, svg));
  }

  sec.appendChild(grid);
  return sec;
}

// ---- motion controller (enter-only; transform/opacity; CLS=0) ---------------

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

// rAF count-up from 0 to the stamped target. Display-only: the final frame
// lands EXACTLY on the real value with identical grouping/decimals. Height is
// fixed by the resting text so there is no layout shift (CLS=0).
function countUp(span, dur) {
  const target = parseFloat(span.dataset.count);
  if (!Number.isFinite(target)) return;
  const decimals = parseInt(span.dataset.decimals || '0', 10);
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / dur);
    span.textContent = fmtCount(target * easeOutCubic(t), decimals);
    if (t < 1) requestAnimationFrame(tick);
    else span.textContent = fmtCount(target, decimals);
  }
  requestAnimationFrame(tick);
}

// Drive the one-shot enter sequence over a freshly-rendered .an-view.
//  - reduced motion: land everything at rest immediately (real values kept).
//  - otherwise: stagger cards (30ms), count up numbers (<=600ms), draw
//    sparklines + rise charts once. No loops; will-change cleared on settle.
function animateView(root) {
  const numSpans = Array.from(root.querySelectorAll('.num[data-count]'));
  const cards = Array.from(root.querySelectorAll('.kpi-hero-cell, .kpi-card'));
  const callouts = Array.from(root.querySelectorAll('.callout, .chart-card'));
  const sparks = Array.from(root.querySelectorAll('.an-spark'));
  const charts = Array.from(root.querySelectorAll('svg.an-chart-rise'));

  // Measure each sparkline so its draw-on dash length is exact.
  sparks.forEach((svg) => {
    const pl = svg.querySelector('polyline');
    if (!pl) return;
    try { svg.style.setProperty('--an-len', pl.getTotalLength().toFixed(1)); }
    catch (_e) { /* getTotalLength unsupported — CSS fallback length applies */ }
  });

  if (prefersReducedMotion()) {
    cards.forEach((c) => c.classList.add('an-in'));
    callouts.forEach((c) => c.classList.add('an-in'));
    charts.forEach((c) => c.classList.add('an-in'));
    sparks.forEach((s) => s.classList.add('an-draw'));
    // Numbers already hold their real (grouped) value in the markup — nothing
    // else to do; the count-up is purely a visual flourish.
    return;
  }

  // Hold numeric values at 0 until their card animates in (the count-up gives
  // them life). Non-card numbers (charts area) are left as-is.
  numSpans.forEach((span) => {
    const decimals = parseInt(span.dataset.decimals || '0', 10);
    span.textContent = fmtCount(0, decimals);
  });

  // Callouts + verdict rise first (above the fold context).
  requestAnimationFrame(() => {
    callouts.forEach((c, i) => {
      window.setTimeout(() => c.classList.add('an-in'), i * 30);
    });

    // KPI cards stagger in, then count up + draw their sparkline.
    cards.forEach((card, i) => {
      window.setTimeout(() => {
        card.classList.add('an-in');
        card.querySelectorAll('.num[data-count]').forEach((span) => {
          countUp(span, 600);
        });
        card.querySelectorAll('.an-spark').forEach((s) => s.classList.add('an-draw'));
        card.addEventListener('transitionend', function once() {
          card.classList.add('an-settled');
          card.removeEventListener('transitionend', once);
        });
      }, i * 30);
    });

    // Charts rise once, after the cards have begun.
    window.setTimeout(() => {
      charts.forEach((c) => c.classList.add('an-in'));
    }, cards.length * 30 + 80);
  });
}

// ---- mount ------------------------------------------------------------------

function render(targetEl, payload) {
  injectStyle();
  targetEl.innerHTML = '';
  const root = el('div', { class: 'an-view' });

  const data = payload && typeof payload === 'object' ? payload : {};
  const insights = Array.isArray(data.insights) ? data.insights : [];
  const kpis = data.kpis && typeof data.kpis === 'object' ? data.kpis : {};
  const charts = data.charts && typeof data.charts === 'object' ? data.charts : {};

  // Headline verdict banner (plain-language, from whsim's KPIs).
  if (typeof data.verdict === 'string' && data.verdict) {
    const sev = data.verdict.startsWith('対応可能') ? 'ok' : 'warn';
    const banner = el('div', { class: 'callout ' + sev });
    const ic = el('div', { class: 'c-icon' });
    ic.innerHTML = iconSvg(sev === 'ok' ? 'check' : 'alert');
    banner.appendChild(ic);
    const main = el('div', { class: 'c-main' });
    main.appendChild(el('div', { class: 'c-title' }, data.verdict));
    banner.appendChild(main);
    root.appendChild(banner);
  }

  // "estimate" source: gentle note that this is the instant analytic fallback.
  if (data.source === 'estimate') {
    const note = el('p', { class: 'chart-sub' },
      '※ 詳細シミュレーション未実行のため、簡易推計値を表示しています。');
    root.appendChild(note);
  }

  root.appendChild(buildInsightsSection(insights));
  root.appendChild(buildKpiSection(kpis));
  const chartsSec = buildChartsSection(charts, data.currency);
  if (chartsSec) root.appendChild(chartsSec);

  targetEl.appendChild(root);

  // Kick off the one-time enter sequence now the DOM is live (so getTotalLength
  // and layout are valid). Guarded so a failure here never blanks the view.
  try { animateView(root); } catch (_e) { /* visuals only — never fatal */ }
}

export async function mountAnalysis(targetEl, projectName) {
  if (!targetEl) return;
  // No project yet: show a friendly prompt instead of fetching /projects/null.
  if (typeof projectName !== 'string' || !projectName.trim()) {
    targetEl._anPayload = null;
    targetEl.innerHTML = '';
    targetEl.appendChild(el('p', { class: 'c-fact' },
      '先にプロジェクトを作成して「実行」すると、ここに分析が表示されます。'));
    return;
  }
  targetEl.innerHTML = '';
  targetEl.appendChild(el('p', { class: 'chart-sub' }, '分析を読み込み中…'));

  let payload = null;
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(projectName)}/analysis`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    payload = await res.json();
  } catch (err) {
    targetEl.innerHTML = '';
    targetEl.appendChild(el('p', { class: 'c-fact' },
      '分析データを取得できませんでした。'));
    return;
  }

  // Stash the latest payload on the element so the (one-time) theme handler
  // always re-renders the CURRENT data, not the payload captured on first mount.
  targetEl._anPayload = payload;
  render(targetEl, payload);

  // Re-render on theme change so the self-drawn SVG charts pick up new
  // CSS-variable colours (nice-to-have; harmless if the event never fires).
  if (!targetEl._anThemeHandler) {
    const handler = () => render(targetEl, targetEl._anPayload);
    targetEl._anThemeHandler = handler;
    document.addEventListener('themechange', handler);
  }
}
