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

// Tables keep their labels on one line (see .an-tbl rules), so a card too narrow
// for the columns scrolls them sideways rather than wrapping them to shreds.
function scrollWrap(node) {
  const w = el('div', { class: 'an-tblwrap' });
  w.appendChild(node);
  return w;
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
  --an-d-up:var(--ok,#2E7D55);
  --an-d-dn:var(--bad,#C4453F);
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

/* 信頼区間 (95%CI ± half-width) under a hero value; quiet, tabular. */
#analysis .an-view .an-ci{
  margin-top:5px;font-size:var(--fs-xs,12px);line-height:1.3;
  color:var(--ink-secondary,var(--ink-mut,#9AA4B2));
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;
}
#analysis .an-view .an-ci .an-ci-pm{color:var(--ink-primary,#e6edf3);font-weight:700}
/* replication guidance note (below the hero grid). */
#analysis .an-view .an-ci-note{
  margin:12px 0 0;padding:9px 12px;border-radius:8px;
  font-size:var(--fs-xs,12px);line-height:1.5;
  color:var(--ink-secondary,var(--ink-mut,#9AA4B2));
  border:1px solid var(--line-hair,rgba(255,255,255,.08));
  background:var(--bg-sunken,rgba(255,255,255,.02));
}
#analysis .an-view .an-ci-note.single{
  color:var(--warn,#F5B05A);
  border-color:color-mix(in srgb,var(--warn,#F5B05A) 30%,transparent);
}
/* 代表日ディスクロージャ: an unobtrusive note that reconciles the simulated
   single-day KPI counts with the ②分析 multi-day totals. Accent left-rule so it
   reads as a "why these numbers" cue, not a warning. */
#analysis .an-view .an-repday{
  margin:10px 0 2px;padding:9px 12px 9px 13px;border-radius:8px;
  font-size:var(--fs-xs,12px);line-height:1.5;
  color:var(--ink-secondary,var(--ink-mut,#9AA4B2));
  border:1px solid var(--line-hair,rgba(255,255,255,.08));
  border-left:2px solid var(--accent,#16C0DE);
  background:var(--bg-sunken,rgba(255,255,255,.02));
}
#analysis .an-view .an-repday b{
  color:var(--ink-primary,#e6edf3);font-weight:700;
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;
}

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
/* A second-level heading INSIDE a card (a card can hold two read-outs; the
   deck used to lean on an ad-hoc inline-styled .chart-sub for the break). */
#analysis .an-view .an-subhead{
  margin:var(--sp-6,24px) 0 2px;padding-top:var(--sp-4,16px);
  border-top:1px solid var(--line-soft,var(--line-hair,rgba(255,255,255,.055)));
  font-size:var(--fs-sm,13px);font-weight:var(--fw-semibold,600);
  color:var(--ink-primary,inherit);letter-spacing:-.004em;
}
#analysis .an-view .an-subhead + .chart-sub{margin-top:2px;margin-bottom:var(--sp-3,12px)}

/* ============================================================
   MOTION — enter-only, transform/opacity, ease-out
   ============================================================ */

/* (1) stagger fade-in for hero cells + KPI cards (translateY 6px -> 0).
   .an-stat cells sit inside a hairline-divided plate, so they fade only (a
   translate would tear the shared 1px rules apart mid-flight). */
#analysis .an-view .kpi-hero-cell,
#analysis .an-view .kpi-card{
  opacity:0;transform:translateY(6px);will-change:transform,opacity;
}
#analysis .an-view .an-stat{opacity:0;will-change:opacity}
#analysis .an-view .kpi-hero-cell.an-in,
#analysis .an-view .kpi-card.an-in{
  opacity:1;transform:none;
  transition:opacity var(--an-d2) var(--an-ease),
    transform var(--an-d2) var(--an-ease);
}
#analysis .an-view .an-stat.an-in{
  opacity:1;transition:opacity var(--an-d2) var(--an-ease);
}
#analysis .an-view .kpi-hero-cell.an-settled,
#analysis .an-view .kpi-card.an-settled,
#analysis .an-view .an-stat.an-settled{will-change:auto}

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
/* 生産性フィードバック (想定→実測→採用) */
#analysis .an-view .an-prod{display:flex;flex-direction:column;gap:8px;margin-top:8px}
#analysis .an-view .an-prod-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;
  padding:9px 12px;border:1px solid var(--line-hair,rgba(255,255,255,.08));border-radius:10px;
  background:var(--bg-sunken,rgba(255,255,255,.02))}
#analysis .an-view .an-prod-row.adopted{border-color:var(--accent,#16C0DE);
  background:color-mix(in srgb,var(--accent,#16C0DE) 8%,transparent)}
#analysis .an-view .an-prod-name{font-weight:700;min-width:84px}
#analysis .an-view .an-prod-vals{display:flex;align-items:center;gap:8px;flex:1;flex-wrap:wrap;
  font-family:var(--font-mono,monospace);font-size:13px;color:var(--ink-secondary,#9fb0c0)}
#analysis .an-view .an-prod-meas{color:var(--ink-primary,#e6edf3);font-weight:700}
#analysis .an-view .an-prod-arrow{color:var(--ink-tertiary,#8195a8)}
#analysis .an-view .an-prod-gap{font-weight:700;padding:0 6px;border-radius:5px}
#analysis .an-view .an-prod-gap.up{color:#34c97a}
#analysis .an-view .an-prod-gap.down{color:var(--warn,#f5b05a)}
#analysis .an-view .an-prod-btn{flex:none;padding:6px 14px;border-radius:8px;cursor:pointer;
  border:1px solid var(--accent,#16C0DE);background:transparent;color:var(--accent,#16C0DE);
  font:inherit;font-weight:700;font-size:12px;white-space:nowrap}
#analysis .an-view .an-prod-btn:hover{background:color-mix(in srgb,var(--accent,#16C0DE) 14%,transparent)}
#analysis .an-view .an-prod-btn.on{background:var(--accent,#16C0DE);color:var(--ink-onAccent,#04222c)}

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
/* Numerals: the UI font (Inter) with TABULAR figures — columns still line up
   digit-for-digit, but the page reads like a printed proposal instead of a
   terminal. (This used to force --font-mono on every numeric surface; at
   26-34px a typewriter face was the single loudest "tech demo" signal on the
   screen.) Slight negative tracking keeps the big metrics compact. */
#analysis .an-view .num,
#analysis .an-view .delta,
#analysis .an-view .c-metric,
#analysis .an-view .kpi-value,
#analysis .an-view .an-area-svg text,
#analysis .an-view .an-tbl td,
#analysis .an-view .an-tbl th{
  font-family:var(--font-sans,inherit);
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;
}
#analysis .an-view .c-metric,
#analysis .an-view .kpi-value{letter-spacing:-.02em}

/* inline legend (top), short colour bars */
#analysis .an-view .an-legend{
  display:flex;gap:16px;flex-wrap:wrap;margin:2px 0 8px;
}
#analysis .an-view .an-lg{
  display:inline-flex;align-items:center;gap:6px;
  font-size:var(--fs-xs,12px);color:var(--ink-secondary,var(--ink-mut,#9AA4B2));
  font-family:var(--font-sans,inherit);
}
#analysis .an-view .an-lg.bn{color:var(--warn,#F5B05A)}
#analysis .an-view .an-sw{width:14px;height:3px;border-radius:var(--r-xs,4px);flex:none}

/* the area svg itself rises once (re-uses .an-chart-rise contract below) */
#analysis .an-view .an-area-svg{display:block;width:100%}

/* ============================================================
   PER-STAGE ANALYSIS TABLE (difference by structure, not colour)
   ============================================================ */
#analysis .an-view .an-tbl{
  width:100%;border-collapse:collapse;font-size:13px;
}
#analysis .an-view .an-tbl thead th{
  font-family:var(--font-sans,inherit);
  font-weight:var(--fw-semibold,600);font-size:var(--fs-micro,11px);
  letter-spacing:.06em;text-transform:uppercase;
  color:var(--ink-tertiary,var(--ink-dim,#5C6675));
  text-align:right;padding:0 0 9px;white-space:nowrap;
  border-bottom:1px solid var(--line-hair,rgba(255,255,255,.08));
}
#analysis .an-view .an-tbl thead th:first-child{text-align:left}
/* Unit lives in the header, never repeated on every row. */
#analysis .an-view .an-tbl thead th .u{
  margin-left:5px;font-weight:var(--fw-regular,400);letter-spacing:.02em;
  color:var(--ink-faint,rgba(150,150,150,.5));text-transform:none;
}
#analysis .an-view .an-tbl tbody td{
  padding:11px 0;text-align:right;
  border-bottom:1px solid var(--line-soft,var(--line-hair,rgba(255,255,255,.055)));
  color:var(--ink,inherit);font-variant-numeric:tabular-nums;
}
/* Column gutters. Every table gets a small one (with zero, 「ピッキング」 and
   「90.8%」 touch); the wide full-width tables opt into a generous one via
   .an-tbl--cols. Half-width cards keep the tight setting so their columns still
   fit — and if they ever do not, .an-tblwrap scrolls rather than wraps. */
#analysis .an-view .an-tbl thead th + th,
#analysis .an-view .an-tbl tbody td + td{padding-left:var(--sp-3,12px)}
#analysis .an-view .an-tbl--cols thead th + th,
#analysis .an-view .an-tbl--cols tbody td + td{padding-left:var(--sp-5,20px)}
/* Labels and verdict chips must never wrap mid-word, whatever the column width. */
#analysis .an-view .an-tbl tbody td:first-child{white-space:nowrap}
#analysis .an-view .an-vd{white-space:nowrap;display:inline-block}
/* …which means a very narrow card scrolls the table instead of shredding it. */
#analysis .an-view .an-tblwrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
#analysis .an-view .an-tbl tbody td:first-child{
  text-align:left;font-family:var(--font-sans,inherit);font-weight:500;
}
#analysis .an-view .an-tbl tbody tr:last-child td{border-bottom:0}
@media(hover:hover){
  #analysis .an-view .an-tbl tbody tr:hover td{background:var(--bg-hover,rgba(255,255,255,.03))}
}
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
  width:54px;height:5px;border-radius:var(--r-xs,4px);position:relative;overflow:hidden;
  background:var(--line-soft,var(--line-hair,rgba(255,255,255,.06)));
}
#analysis .an-view .an-util-bar i{
  position:absolute;left:0;top:0;bottom:0;border-radius:var(--r-xs,4px);
  background:var(--ink-secondary,var(--ink-mut,#9AA4B2));
}
#analysis .an-view .an-util-bar i.an-pri{background:var(--accent,#34E3FF)}
#analysis .an-view .an-util-bar i.an-w{background:var(--warn,#F5B05A)}
#analysis .an-view .an-vd{
  font-size:var(--fs-micro,11px);font-weight:500;letter-spacing:.03em;
  padding:3px 9px;border-radius:var(--r-sm,6px);font-family:var(--font-sans,inherit);
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
/* Note under a table: a contained warn plate (it used to be a bare hairline +
   grey run of text, which read as a footnote rather than as the caveat that
   qualifies the numbers directly above it). */
#analysis .an-view .an-tbl-note{
  margin-top:16px;padding:11px 14px;border-radius:var(--r-card,10px);
  border:1px solid var(--warn-line,rgba(245,176,90,.28));
  background:var(--warn-tint,rgba(245,176,90,.08));
  font-size:var(--fs-xs,12px);color:var(--warn-ink,#8A5A12);
  display:flex;gap:10px;align-items:flex-start;line-height:1.6;
}
#analysis .an-view .an-tbl-note .an-ic{
  flex:none;margin-top:1px;font-size:13px;line-height:1.3;
  color:var(--warn,#F5B05A);
}

/* ============================================================
   STAT PANEL — a hairline-divided instrument row (通路の混雑 ほか)
   ------------------------------------------------------------
   Replaces a 4-up grid of free-floating boxes that left an orphan row of two
   and let a wrapping label shove one value a line lower than its neighbours.
   One plate, 3 per row, fixed label height ⇒ every value sits on one baseline.
   ============================================================ */
#analysis .an-view .an-stats{
  display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;
  background:var(--line-hair,rgba(255,255,255,.08));
  border:1px solid var(--line-hair,rgba(255,255,255,.08));
  border-radius:var(--r-card,10px);overflow:hidden;margin-top:var(--sp-4,16px);
}
#analysis .an-view .an-stat{background:var(--bg-app,transparent);padding:13px 16px 15px;min-width:0}
#analysis .an-view .an-stat-label{
  display:flex;align-items:center;gap:7px;min-height:2.6em;
  font-family:var(--font-sans,inherit);font-size:var(--fs-xs,12px);
  line-height:1.3;color:var(--ink-secondary,var(--ink-mut,#9AA4B2));
}
#analysis .an-view .an-stat-value{
  margin-top:5px;font-size:26px;line-height:1.1;
  font-weight:var(--fw-semibold,600);letter-spacing:-.02em;
  color:var(--ink-primary,inherit);
}
/* Unit scales WITH the value (em), so the detail row keeps the same optical
   ratio as the headline row instead of a 14px unit next to a 19px number. */
#analysis .an-view .an-stat-value .kpi-unit{
  font-size:.56em;margin-left:4px;font-weight:var(--fw-medium,500);
  letter-spacing:0;color:var(--ink-tertiary,#8195a8);
}
/* Detail tier: same plate, quieter type — hierarchy without a second widget. */
#analysis .an-view .an-stats.is-detail{margin-top:var(--sp-2,8px)}
#analysis .an-view .an-stats.is-detail .an-stat{padding:11px 16px 12px}
#analysis .an-view .an-stats.is-detail .an-stat-label{min-height:0}
#analysis .an-view .an-stats.is-detail .an-stat-value{font-size:19px;font-weight:var(--fw-semibold,600)}
/* A stat that is itself the warning (強制通過>0) carries a warn dot + ink. */
#analysis .an-view .an-stat.is-warn .an-stat-label::before{
  content:"";flex:none;width:6px;height:6px;border-radius:50%;
  background:var(--warn,#F5B05A);
}
#analysis .an-view .an-stat.is-warn .an-stat-value{color:var(--warn-ink,#8A5A12)}
@media(max-width:880px){
  #analysis .an-view .an-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-width:460px){
  #analysis .an-view .an-stats{grid-template-columns:minmax(0,1fr)}
}

/* ---- ranked-location table (最も混んだ通路) -------------------------------
   The wait column reuses the .an-util bar vocabulary from 工程別分析 so "how
   much worse is the worst one" is legible before the digits are read. */
#analysis .an-view .an-tbl th.an-rank,
#analysis .an-view .an-tbl td.an-rank{
  width:38px;text-align:left;padding-left:12px;   /* clears the .an-flag spine */
  color:var(--ink-tertiary,#8195a8);
  font-size:var(--fs-xs,12px);font-variant-numeric:tabular-nums;font-weight:500;
}
#analysis .an-view .an-tbl tbody tr.an-flag td.an-rank{color:var(--warn-ink,#8A5A12);font-weight:700}
/* The place name is the row's subject: left-aligned, and it absorbs the slack
   so the numeric columns stay pinned to the right edge. */
#analysis .an-view .an-tbl th.an-where,
#analysis .an-view .an-tbl td.an-where{text-align:left;width:100%}

/* ============================================================
   PLACEHOLDER — no project / loading / failed fetch
   ------------------------------------------------------------
   These three states used to be one bare grey <p> each, which read as "the
   page is broken" rather than "there is nothing here yet". Same plate as the
   other empty states in the app: glyph + one line of what + one line of how.
   ============================================================ */
#analysis .an-ph{
  display:flex;gap:18px;align-items:center;max-width:560px;margin:56px auto;
  padding:22px 24px;border:1px dashed var(--line-strong,rgba(150,172,200,.22));
  border-radius:var(--r-card,10px);background:var(--bg-sunken,transparent);
}
#analysis .an-ph-ic{flex:none;color:var(--ink-faint,#8195a8)}
#analysis .an-ph-title{
  font-size:var(--fs-body,14px);font-weight:var(--fw-semibold,600);
  color:var(--ink-primary,inherit);line-height:1.5;
}
#analysis .an-ph-hint{
  margin-top:4px;font-size:var(--fs-xs,12px);line-height:1.65;
  color:var(--ink-tertiary,#8195a8);
}
#analysis .an-ph--loading{border-style:solid;border-color:var(--line-hair,rgba(255,255,255,.08))}
#analysis .an-ph--loading .an-ph-ic{animation:an-ph-pulse 1.5s var(--ease,ease) infinite}
@keyframes an-ph-pulse{0%,100%{opacity:.35}50%{opacity:.85}}
#analysis .an-ph--error{
  border-style:solid;border-color:var(--bad-line,rgba(255,90,120,.3));
  background:var(--bad-tint,rgba(255,90,120,.08));
}
#analysis .an-ph--error .an-ph-ic{color:var(--bad,#C4453F)}
#analysis .an-ph--error .an-ph-title{color:var(--bad-ink,#97322E)}
@media (prefers-reduced-motion: reduce){
  #analysis .an-ph--loading .an-ph-ic{animation:none;opacity:.6}
}

/* prefers-reduced-motion: stop all, land at resting state with real values */
@media (prefers-reduced-motion: reduce){
  #analysis .an-view *{animation:none!important;transition:none!important}
  #analysis .an-view .kpi-hero-cell,
  #analysis .an-view .kpi-card,
  #analysis .an-view .an-stat,
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

// ---- placeholder states (no project / loading / failed fetch) ---------------

// 34px outline glyphs, decorative — the sentence beside them carries the meaning.
const PH_GLYPH = {
  empty: '<path d="M3 21h18"/><rect x="4" y="12" width="4" height="6" rx="1"/>'
    + '<rect x="10" y="8" width="4" height="10" rx="1"/>'
    + '<rect x="16" y="14" width="4" height="4" rx="1"/><path d="M4 6h7"/>',
  loading: '<path d="M3 21h18"/><rect x="4" y="14" width="4" height="4" rx="1"/>'
    + '<rect x="10" y="11" width="4" height="7" rx="1"/>'
    + '<rect x="16" y="8" width="4" height="10" rx="1"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
};

function buildPlaceholder(kind, title, hint) {
  const box = el('div', { class: 'an-ph an-ph--' + kind });
  const ic = el('div', { class: 'an-ph-ic' });
  ic.innerHTML = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" '
    + 'stroke-linejoin="round" aria-hidden="true">'
    + (PH_GLYPH[kind] || PH_GLYPH.empty) + '</svg>';
  box.appendChild(ic);
  const main = el('div', { class: 'an-ph-main' });
  main.appendChild(el('div', { class: 'an-ph-title' }, title));
  if (hint) main.appendChild(el('div', { class: 'an-ph-hint' }, hint));
  box.appendChild(main);
  return box;
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
    const metric = el('div', { class: 'c-metric' }, String(ins.metric));
    // Optional unit: a bare "3" floating at 22px reads as a decoration; "3 件"
    // reads as a count. Additive — payload insights that omit it are unchanged.
    if (ins.metric_unit) {
      metric.appendChild(el('span', { class: 'c-metric-unit' }, ins.metric_unit));
    }
    card.appendChild(metric);
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

// A 60x20 direction glyph whose slope encodes delta.dir. Deliberately a CLEAN
// straight line: an earlier noisy 8-point version read as a tiny time series
// sitting beside real numbers — on a page whose whole contract is "every figure
// comes from the log", an invented wiggle is a lie in miniature. A straight
// diagonal reads as iconography, not data. `dir` is 'up' | 'down'.
function deltaSparkline(dir) {
  const up = dir === 'up';
  const ys = up ? [15, 5] : [5, 15];
  const pts = ys.map((y, i) => `${i * 60},${y}`).join(' ');
  const svg = svgEl('svg', { class: 'an-spark', width: '60', height: '20',
    viewBox: '0 0 60 20', 'aria-hidden': 'true' });
  svg.appendChild(svgEl('polyline', { fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    points: pts }));
  return svg;
}

// ---- 信頼区間 (confidence interval) annotations -----------------------------
//
// The run payload carries a 95% t-CI over the Monte-Carlo replications
// (`payload.ci`), reshaped by the backend into display-unit half-widths on the
// hero KPIs (`h.ci`) — the trust signal a 荷主 asks for ("この数字はどれくらい
// 堅いのか"). These helpers render the ± and the honest replication guidance.

// A small "±half-width (95%CI, n=N)" annotation for a headline KPI. Returns null
// when there is no interval (single run, or the thin analytic estimate).
function ciBadge(ci) {
  if (!ci || !isNum(ci.half_width)) return null;
  const line = el('div', { class: 'an-ci' });
  line.appendChild(el('span', { class: 'an-ci-pm' }, `±${group(ci.half_width)}`));
  const nTxt = isNum(ci.n) ? `, n=${ci.n}` : '';
  line.appendChild(document.createTextNode(` (95%CI${nTxt})`));
  return line;
}

// Honest replication guidance from the run's CI block:
//   n=1              → single-run disclosure (no width; auto-reduced for scale).
//   n<n_recommended  → how many more reps reach the ±5% relative-error target.
// Returns null when the run already meets the target (or there is no CI block —
// e.g. the analytic estimate). `n_recommended` is a plain count, so it is read
// straight off the raw per-metric CI entries (unit-independent).
function buildCiNote(ci) {
  if (!ci || typeof ci !== 'object') return null;
  const n = ci.n;
  if (n === 1) {
    return el('p', { class: 'an-ci-note single' },
      '単一実行（幅なし）— 大規模データのため反復1回に自動調整');
  }
  const metrics = ci.metrics && typeof ci.metrics === 'object' ? ci.metrics : {};
  let need = 0;
  for (const k in metrics) {
    const e = metrics[k];
    if (e && isNum(e.n_recommended)) need = Math.max(need, e.n_recommended);
  }
  if (isNum(n) && need > n) {
    return el('p', { class: 'an-ci-note' },
      `精度目安: ±5%にはあと ${need - n} 回のレプリケーションが必要（設定で反復数を上げられます）`);
  }
  return null;
}

// 代表日 disclosure note (below the hero). The run collapses a multi-day import
// to its busiest single day for capacity sizing, so the KPI counts (e.g. 83
// オーダー) look far smaller than the ②分析 totals (e.g. 1,494件/27日). This one
// line tells the salesperson those numbers reconcile — no data was lost. Returns
// null for single-day / estimate runs (rep_day absent) so nothing renders there.
function buildRepDayNote(rd) {
  if (!rd || typeof rd !== 'object') return null;
  const days = rd.total_days, tot = rd.total_orders, dayN = rd.day_orders;
  if (!isNum(days) || !isNum(tot) || !isNum(dayN)) return null;
  const wd = (typeof rd.weekday === 'string' && rd.weekday) ? `（${rd.weekday}曜相当）` : '';
  const note = el('p', { class: 'an-repday' });
  note.appendChild(document.createTextNode(`最繁日${wd}を代表日としてシミュレーション：`));
  note.appendChild(el('b', null, `${group(dayN)}オーダー`));
  note.appendChild(document.createTextNode(
    `（全${group(days)}日・${group(tot)}件の中で最も忙しい日）`));
  return note;
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
    // 95%CI ± half-width under the value (omitted when there is no interval).
    const ci = ciBadge(h.ci);
    if (ci) cell.appendChild(ci);
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

function buildKpiSection(kpis, ci, repDay) {
  const sec = el('section', { class: 'an-section' });
  sec.appendChild(el('h2', { class: 'an-section-title' }, '主要KPI'));
  const hero = Array.isArray(kpis.hero) ? kpis.hero : [];
  if (hero.length) sec.appendChild(buildHero(hero));
  // 代表日 disclosure right under the hero: reconciles the single-day KPI counts
  // with the ②分析 multi-day totals (absent → nothing rendered).
  const repNote = buildRepDayNote(repDay);
  if (repNote) sec.appendChild(repNote);
  // Replication guidance right below the hero (single-run note or ±5% target).
  const note = buildCiNote(ci);
  if (note) sec.appendChild(note);
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

  const ariaLabel = o.ariaLabel
    || ('棒グラフ。' + labels.map((lab, i) => `${lab}: ${isNum(nums[i]) ? group(nums[i]) : '—'}${o.suffix || ''}`).join('、') + '。');
  const s = svgEl('svg', { class: 'an-chart-rise', viewBox: `0 0 ${W} ${H}`,
    width: '100%', role: 'img', 'aria-label': ariaLabel });
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
// (labels + values, peak_label). 処理(件) has no per-stage source anywhere, so
// it still renders an em dash rather than a fabricated number. 平均待ち(s) DOES
// have one for the stages the engine measures a queue wait for — the raw run
// KPIs carry `pick_wait_mean_s` / `sort_wait_mean_s` — so those two rows show
// the measured figure and every other stage keeps its em dash (梱包 and AGV搬送
// have no per-stage mean wait in the log; `agv_wait_s` is a TOTAL, not a mean,
// and printing it in a "平均待ち" column would be a different statistic wearing
// this column's label). The DOM contract (5 columns) is preserved either way.
// 判定 is derived from the real utilisation and the (real) bottleneck label.

// 工程ラベル → その工程の「平均待ち」を持つ生KPIキー。ここに無い工程は em dash。
// ラベルは `_analysis_payload` が組む charts.stages.labels と同一の語彙。
const STAGE_WAIT_KEY = {
  'ピッキング': 'pick_wait_mean_s',
  '種まき仕分け': 'sort_wait_mean_s',
};

function buildStageTable(labels, values, peakLabel, raw) {
  const wrap = el('div', { class: 'chart-card' });
  wrap.appendChild(el('div', { class: 'chart-title' }, '工程別 分析'));
  // (was 「差は色でなく構造…で示す」— a note about how the table is DRAWN. The
  // reader needs to know what it SAYS; the drawing speaks for itself.)
  wrap.appendChild(el('div', { class: 'chart-sub' },
    '工程ごとの稼働率と待ち。最繁忙（律速）の工程を強調しています。'));

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

    // 処理(件) — no honest per-stage source anywhere → em dash.
    tr.appendChild(el('td', { class: 'num' }, '—'));
    // 平均待ち(s) — measured per-stage queue wait from the raw run KPIs when the
    // engine logs one for this stage; em dash otherwise (never a stand-in).
    const waitKey = STAGE_WAIT_KEY[lab];
    const waitVal = (waitKey && raw && typeof raw === 'object') ? raw[waitKey] : null;
    tr.appendChild(el('td', { class: 'num' },
      isNum(waitVal) ? group(Math.round(waitVal * 10) / 10) : '—'));

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
  wrap.appendChild(scrollWrap(table));

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

// 生産性の内訳 (要素作業分解): a horizontal stacked bar of ピッカー在席時間
// (移動/手扱い/手待ち) + the headline 件/人時, with the per-hour minute split —
// the 生産性Sim reading (要素作業量→要素作業時間→生産性) over the real DES log.
const PROD_PART_COLOR = {
  walk: 'var(--warn,#f5b05a)', handle: 'var(--accent,#16C0DE)',
  idle: 'var(--line-strong,rgba(120,140,170,.45))',
};
function buildProductivityCard(prod) {
  const parts = (prod.parts || []).filter((p) => p.share > 0);
  if (!parts.length) return null;
  const card = el('div', { class: 'chart-card' });
  card.appendChild(el('div', { class: 'chart-title' }, '生産性の内訳（ピッカー1人・1時間あたり）'));
  const mins = (sh) => Math.round(sh * 60);
  const split = parts.map((p) => `${p.label}${mins(p.share)}分`).join('＋');
  // Headline 件/人時 with its 95%CI ± half-width inline (e.g. 「142 ±6 件/人時
  // (95%CI, n=5)」) when the run carries one; plain figure otherwise.
  const pm = (prod.ci && isNum(prod.ci.half_width)) ? ` ±${group(prod.ci.half_width)}` : '';
  const ciTail = (prod.ci && isNum(prod.ci.half_width) && isNum(prod.ci.n))
    ? ` (95%CI, n=${prod.ci.n})` : '';
  card.appendChild(el('div', { class: 'chart-sub' },
    `${prod.per_hr || 0}${pm} 件/人時${ciTail} ＝ 在席60分のうち ${split}`));
  // stacked bar (flexbox; theme-aware via CSS vars, no SVG needed)
  const bar = el('div', {
    style: 'display:flex;height:26px;border-radius:8px;overflow:hidden;margin:8px 0 4px',
    role: 'img',
    'aria-label': `ピッカー時間の内訳。${parts.map((p) => `${p.label} ${Math.round(p.share * 100)}%`).join('、')}。`,
  });
  for (const p of parts) {
    bar.appendChild(el('div', {
      style: `flex:0 0 ${(p.share * 100).toFixed(1)}%;background:${PROD_PART_COLOR[p.key] || '#888'}`,
      title: `${p.label} ${(p.share * 100).toFixed(0)}%`,
    }));
  }
  card.appendChild(bar);
  const legend = el('div', { style: 'display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--ink-secondary)' });
  for (const p of parts) {
    const item = el('span', { style: 'display:inline-flex;align-items:center;gap:5px' });
    item.appendChild(el('span', {
      style: `width:10px;height:10px;border-radius:2px;display:inline-block;background:${PROD_PART_COLOR[p.key] || '#888'}`,
    }));
    item.appendChild(document.createTextNode(`${p.label} ${(p.share * 100).toFixed(0)}%`));
    legend.appendChild(item);
  }
  card.appendChild(legend);
  // The actionable reading: walking share is the layout/slotting lever.
  const walk = parts.find((p) => p.key === 'walk');
  if (walk && walk.share >= 0.35) {
    card.appendChild(el('div', { class: 'chart-sub', style: 'margin-top:6px' },
      `移動が${Math.round(walk.share * 100)}%を占めています。A品の出荷口寄せ・通路見直しで詰められる比率です。`));
  }
  return card;
}

function buildChartsSection(charts, currency, raw) {
  const stages = charts.stages || {};
  const cost = charts.cost || null;
  const prod = charts.productivity || null;
  const hasStages = Array.isArray(stages.labels) && stages.labels.length;
  const hasCost = cost && Array.isArray(cost.labels) && cost.labels.length;
  const hasProd = prod && Array.isArray(prod.parts) && prod.parts.length;
  if (!hasStages && !hasCost && !hasProd) return null;

  const sec = el('section', { class: 'an-section' });
  sec.appendChild(el('h2', { class: 'an-section-title' }, '物量の動き / コスト'));
  const grid = el('div', { class: 'chart-grid' });

  if (hasProd) {
    const card = buildProductivityCard(prod);
    if (card) grid.appendChild(card);
  }

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
    grid.appendChild(buildStageTable(labels, values, peak, raw));
  }

  if (hasCost) {
    const cur = cost.currency || currency || '¥';
    const svg = barChart(cost.labels, cost.values || [], {
      color: cssVar('--outbound', '#0d9488'),
      fmt: (v) => cur + group(Math.round(v * 100) / 100),
      ariaLabel: '1件あたりコスト内訳の棒グラフ。' + (cost.labels || []).map((lab, i) => {
        const v = (cost.values || [])[i];
        return `${lab}: ${isNum(v) ? cur + group(Math.round(v * 100) / 100) : '—'}`;
      }).join('、') + '。',
    });
    grid.appendChild(buildChartCard('1件あたりコスト内訳',
      `${cur} / 件。人件費と設備費の内訳。`, svg));
  }

  sec.appendChild(grid);
  return sec;
}

// ---- 通路の混雑 (通路干渉) + 経路の警告 -------------------------------------
//
// These read the run's RAW KPI document (`kpis.json`, fetched alongside the
// reshaped analysis payload — see mountAnalysis), because the reshaped payload
// deliberately carries only the headline hierarchy. Three read-outs live there
// and had no display at all:
//
//   congestion_wait_* / congestion.top_cells — how long agents queued behind
//     each other in the aisles, and WHERE. Only ever non-zero when
//     `simulation.aisle_interference` was on AND the floor actually contended,
//     so the gate is the VALUE (waits > 0), not the flag: a run with the flag on
//     and an empty floor renders nothing, exactly as before.
//   path_violations — replay legs drawn THROUGH a rack (the routing graph did
//     not see that rack ⇒ every travel figure in the run is understated).
//   unroutable_legs — legs the aisle graph could not solve, degraded to a
//     straight line (same understatement, different cause).
//
// The last two are correctness warnings, not tuning hints, so they render as
// danger callouts at the top of the view. All three are absent-by-default: a run
// without them adds not one pixel.

// The worst cells worth naming on screen. The payload carries up to 10; three is
// enough to point at an aisle and short enough to read.
const TOP_CELLS_SHOWN = 3;

// Grid cell (index) → its centre in floor metres, using the same lattice pitch
// the engine contended on (`simulation.heatmap_grid_m`). Returns null when the
// pitch is unknown or the cell is not a 2-tuple, so the caller can fall back to
// naming the raw cell instead of inventing a coordinate.
function cellCentreM(cell, gridM) {
  if (!isNum(gridM) || gridM <= 0) return null;
  if (!Array.isArray(cell) || cell.length !== 2) return null;
  if (!isNum(cell[0]) || !isNum(cell[1])) return null;
  return [Math.round((cell[0] + 0.5) * gridM), Math.round((cell[1] + 0.5) * gridM)];
}

// The six congestion read-outs, in reading order. The first three answer "how
// bad" (headline tier); the rest are the breakdown behind them (detail tier) —
// see buildStatPanels, which splits the list at LEAD_STATS.
const LEAD_STATS = 3;

function congestionKpiItems(raw) {
  const items = [];
  const push = (label, value, unit) => items.push({ label, value, unit });
  if (isNum(raw.congestion_wait_total_s)) {
    push('通路の待ち 合計', Math.round(raw.congestion_wait_total_s / 60 * 10) / 10, '分');
  }
  if (isNum(raw.congestion_wait_share)) {
    push('移動時間に占める待ち', Math.round(raw.congestion_wait_share * 1000) / 10, '%');
  }
  if (isNum(raw.congestion_wait_p95_s)) {
    push('待ちの p95', Math.round(raw.congestion_wait_p95_s * 10) / 10, '秒');
  }
  if (isNum(raw.congestion_waits)) {
    push('待ちの発生回数', Math.round(raw.congestion_waits), '回');
  }
  if (isNum(raw.congestion_wait_mean_s) && raw.congestion_wait_mean_s > 0) {
    push('1回あたりの待ち', Math.round(raw.congestion_wait_mean_s * 10) / 10, '秒');
  }
  if (isNum(raw.congestion_forced_passes) && raw.congestion_forced_passes > 0) {
    const fp = raw.congestion_forced_passes;
    // レプリケーション平均は端数になる (10repで1回 ⇒ 0.1)。丸めて「0回」と
    // 言いながら直下で警告する矛盾を避け、端数はそのまま1桁で見せる。
    items.push({
      label: '強制通過', value: fp >= 1 ? Math.round(fp) : fp.toFixed(1),
      unit: '回', warn: true,
    });
  }
  return items;
}

// One hairline-divided plate of stats. `detail` renders the quieter second tier.
function buildStatPanel(items, detail) {
  const panel = el('div', { class: 'an-stats' + (detail ? ' is-detail' : '') });
  items.forEach((it) => {
    const cell = el('div', { class: 'an-stat' + (it.warn ? ' is-warn' : '') });
    cell.appendChild(el('div', { class: 'an-stat-label' }, it.label));
    const v = el('div', { class: 'an-stat-value num' });
    v.appendChild(valueSpan(it.value, it.unit));
    cell.appendChild(v);
    panel.appendChild(cell);
  });
  return panel;
}

// Headline plate + (when there are more) the breakdown plate under it. A single
// short list stays one plate — never a plate of one cell next to empty space.
function buildStatPanels(items) {
  const out = [];
  if (!items.length) return out;
  if (items.length <= LEAD_STATS + 1) {
    out.push(buildStatPanel(items, false));
    return out;
  }
  out.push(buildStatPanel(items.slice(0, LEAD_STATS), false));
  out.push(buildStatPanel(items.slice(LEAD_STATS), true));
  return out;
}

// Top congested cells as a small table. `gridM` (the model's lattice pitch) turns
// a cell index into floor metres; without it the cell is named as a cell.
// A header cell whose unit is set apart from its label (so the unit never has to
// be repeated on every row).
function unitTh(label, unit) {
  const th = el('th', null, label);
  if (unit) th.appendChild(el('span', { class: 'u' }, unit));
  return th;
}

function buildTopCellsTable(top, gridM) {
  const rows = top.slice(0, TOP_CELLS_SHOWN).filter((r) => r && typeof r === 'object');
  if (!rows.length) return null;
  const table = el('table', { class: 'an-tbl an-tbl--cols' });
  const thead = el('thead');
  const htr = el('tr');
  htr.appendChild(el('th', { class: 'an-rank' }, ''));
  htr.appendChild(el('th', { class: 'an-where' }, '最も混んだ通路'));
  htr.appendChild(unitTh('待ち', '秒'));
  htr.appendChild(unitTh('待ち回数', '回'));
  thead.appendChild(htr);
  table.appendChild(thead);
  // Worst-first, so the bar length is read against the row that tops the list.
  const worst = rows.reduce(
    (a, r) => Math.max(a, isNum(r.wait_s) ? r.wait_s : 0), 0);
  const tbody = el('tbody');
  rows.forEach((r, i) => {
    const tr = el('tr', i === 0 ? { class: 'an-flag' } : null);
    const m = cellCentreM(r.cell, gridM);
    const where = m
      ? `約 (${group(m[0])}, ${group(m[1])}) m 付近`
      : (Array.isArray(r.cell) ? `格子セル (${r.cell.join(', ')})` : '—');
    tr.appendChild(el('td', { class: 'an-rank' }, String(i + 1)));
    tr.appendChild(el('td', { class: 'an-where' }, where));

    // 待ち: number + a proportional bar (same .an-util vocabulary as 工程別分析)
    // so "how much worse is the worst aisle" lands before the digits are read.
    const waitTd = el('td');
    const cell = el('span', { class: 'an-util' });
    cell.appendChild(el('span', { class: 'num' },
      isNum(r.wait_s) ? group(Math.round(r.wait_s * 10) / 10) : '—'));
    const bar = el('span', { class: 'an-util-bar' });
    const fill = el('i', { class: i === 0 ? 'an-w' : '' });
    const pct = (worst > 0 && isNum(r.wait_s))
      ? Math.max(0, Math.min(100, (r.wait_s / worst) * 100)) : 0;
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    cell.appendChild(bar);
    waitTd.appendChild(cell);
    tr.appendChild(waitTd);

    tr.appendChild(el('td', { class: 'num' },
      isNum(r.hits) ? group(Math.round(r.hits * 10) / 10) : '—'));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

function buildCongestionSection(raw, gridM) {
  if (!raw || typeof raw !== 'object') return null;
  // Gate on the VALUE, not on the aisle-interference flag: a run with no
  // measured waiting has nothing to say here (and the flag is not in the KPIs).
  const waits = raw.congestion_waits;
  if (!isNum(waits) || waits <= 0) return null;

  const sec = el('section', { class: 'an-section' });
  const title = el('h2', { class: 'an-section-title' }, '通路の混雑（通路干渉）');
  title.appendChild(el('span', { class: 'sub' }, '実行時に計測した待ち'));
  sec.appendChild(title);

  const card = el('div', { class: 'chart-card' });
  card.appendChild(el('div', { class: 'chart-title' }, '通路の待ち時間'));
  card.appendChild(el('div', { class: 'chart-sub' },
    '同じ通路を同じ向きに通ろうとして、他の作業者の後ろで待った時間です。'
    + '移動時間に占める割合が大きいほど、通路幅・動線・棚の配置を見直す余地があります。'));

  buildStatPanels(congestionKpiItems(raw)).forEach((p) => card.appendChild(p));

  const top = (raw.congestion && Array.isArray(raw.congestion.top_cells))
    ? raw.congestion.top_cells : [];
  const tbl = buildTopCellsTable(top, gridM);
  if (tbl) {
    card.appendChild(el('div', { class: 'an-subhead' }, '待ちが積み上がった場所'));
    card.appendChild(el('div', { class: 'chart-sub' },
      '「通路が狭い」ではなく「この通路」が直す対象になります。'));
    card.appendChild(scrollWrap(tbl));
  }
  if (isNum(raw.congestion_forced_passes) && raw.congestion_forced_passes > 0) {
    const note = el('div', { class: 'an-tbl-note' });
    note.appendChild(el('span', { class: 'an-ic' }, '⚠'));
    note.appendChild(el('span', null,
      '待ちが上限に達して強制的に通過させた区間があります。実際の現場では、'
      + 'その通路で行き詰まり（すれ違い待ち）が起きる想定です。'));
    card.appendChild(note);
  }
  sec.appendChild(card);
  return sec;
}

// 経路の警告: correctness counters that mean "the travel behind every number in
// this run is understated". Returned as insight-shaped objects so they render
// through the SAME callout builder as the rest of the view.
function routeWarningCallouts(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const out = [];
  const unroutable = raw.unroutable_legs;
  if (isNum(unroutable) && unroutable > 0) {
    out.push({
      severity: 'danger', icon: 'alert',
      title: '通路グラフで解けなかった移動があります',
      fact: `通路グラフで解決できず直線距離に縮退した移動が <span class="num">${group(Math.round(unroutable))}</span> 件。`
        + 'この分の移動距離・移動時間は実際より短く出ています。',
      metric: group(Math.round(unroutable)),
      metric_unit: '件',
      action: '取込レイアウトの通路が塞がっていないか確認してください。',
    });
  }
  const violations = raw.path_violations;
  if (isNum(violations) && violations > 0) {
    out.push({
      severity: 'danger', icon: 'alert',
      title: '経路が棚を貫通しています',
      fact: `棚を突き抜けた移動が <span class="num">${group(Math.round(violations))}</span> 件。`
        + '経路グラフがその棚を見ていないため、移動距離が実際より短く出ています。',
      metric: group(Math.round(violations)),
      metric_unit: '件',
      action: 'レイアウトの棚定義（位置・大きさ）を確認してください。',
    });
  }
  return out;
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
  // Every card that holds a stamped number MUST be in this list: the sequence
  // zeroes each .num[data-count] up front and only the cards listed here ever
  // count it back up (an omitted card renders a permanent 0).
  const cards = Array.from(root.querySelectorAll('.kpi-hero-cell, .kpi-card, .an-stat'));
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

// ---- 生産性フィードバック (想定 → 実測 → 採用) -------------------------------
// Show per-process benchmark (想定) vs this-layout measured (実測) productivity,
// and let the user adopt the measured value into the 原価試算 with one click.
// Adopting persists to settings.productivity_overrides and re-renders.
async function adoptProductivity(targetEl, process, rate, adopt) {
  const proj = targetEl && targetEl._anProject;
  if (!proj) return;
  try {
    const sres = await fetch(`/api/projects/${encodeURIComponent(proj)}/settings`);
    const settings = sres.ok ? await sres.json() : {};
    const ov = (settings && typeof settings.productivity_overrides === 'object'
      && settings.productivity_overrides) ? { ...settings.productivity_overrides } : {};
    if (adopt) ov[process] = rate; else delete ov[process];
    await fetch(`/api/projects/${encodeURIComponent(proj)}/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productivity_overrides: ov }),
    });
    document.dispatchEvent(new CustomEvent('whsim:toast',
      { detail: { msg: adopt ? `${process}の実測値を原価に採用しました。` : `${process}を想定値に戻しました。`, kind: 'ok' } }));
    // Re-fetch analysis so the adopted state + (if open) cost reflect it.
    const ar = await fetch(`/api/projects/${encodeURIComponent(proj)}/analysis`);
    if (ar.ok) { targetEl._anPayload = await ar.json(); render(targetEl, targetEl._anPayload); }
  } catch (e) {
    document.dispatchEvent(new CustomEvent('whsim:toast',
      { detail: { msg: '採用に失敗しました。', kind: 'error' } }));
  }
}

function buildProdFeedback(compare, targetEl) {
  if (!Array.isArray(compare) || !compare.length) return null;
  const sec = el('section', { class: 'an-section' });
  sec.appendChild(el('h2', { class: 'an-section-title' }, '生産性フィードバック（想定 → 実測）'));
  const card = el('div', { class: 'chart-card' });
  card.appendChild(el('div', { class: 'chart-sub' },
    'このレイアウトで実測した生産性です。ベンチマーク（想定）より低ければ、A品の配置や通路を見直して再実行すると改善します。「採用」で原価試算に反映。'));
  const grid = el('div', { class: 'an-prod' });
  for (const r of compare) {
    const better = r.measured >= r.benchmark;
    const row = el('div', { class: 'an-prod-row' + (r.adopted ? ' adopted' : '') });
    row.appendChild(el('div', { class: 'an-prod-name' }, r.process));
    const vals = el('div', { class: 'an-prod-vals' });
    vals.appendChild(el('span', { class: 'an-prod-bench' }, `想定 ${fmtCount(r.benchmark, 0)}`));
    vals.appendChild(el('span', { class: 'an-prod-arrow' }, '→'));
    vals.appendChild(el('span', { class: 'an-prod-meas' }, `実測 ${fmtCount(r.measured, 0)} ${r.unit}`));
    const gapPct = Math.round(r.gap * 100);
    vals.appendChild(el('span', { class: 'an-prod-gap ' + (better ? 'up' : 'down') },
      (gapPct >= 0 ? '+' : '') + gapPct + '%'));
    row.appendChild(vals);
    const btn = el('button', { class: 'an-prod-btn' + (r.adopted ? ' on' : '') },
      r.adopted ? '✓ 採用中（戻す）' : '実測を採用 →');
    btn.onclick = () => adoptProductivity(targetEl, r.process, r.measured, !r.adopted);
    row.appendChild(btn);
    grid.appendChild(row);
  }
  card.appendChild(grid);
  sec.appendChild(card);
  return sec;
}

// ---- mount ------------------------------------------------------------------

// The run's RAW KPI document (`kpis.json`) for THIS project. `/analysis` reshapes
// the KPIs into the headline hierarchy and drops the rest, so the congestion /
// routing read-outs are read from the project's own run artifact instead. Scoped
// to the project name (never a module-level cache) so switching projects can
// never show the previous project's run. Returns null for a project with no run
// (and on any failure — these read-outs are additive, never load-bearing).
async function fetchRawKpis(projectName) {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/model`);
    if (!res.ok) return null;
    const m = await res.json();
    if (!m || !m.has_run || !m.kpis || typeof m.kpis !== 'object') return null;
    return m.kpis;
  } catch (_e) {
    return null;
  }
}

// The congestion lattice pitch (`simulation.heatmap_grid_m`) — the metres per
// cell the engine contended on, needed to name a congested cell in floor metres.
// Fetched LAZILY and only when there is actually a congested cell to name, since
// it costs a full model read; without it the cells are named as cells, never as
// a guessed coordinate.
async function fetchGridPitch(projectName, raw) {
  const top = (raw && raw.congestion && Array.isArray(raw.congestion.top_cells))
    ? raw.congestion.top_cells : [];
  if (!top.length) return null;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/full`);
    if (!res.ok) return null;
    const md = await res.json();
    const g = md && md.simulation ? md.simulation.heatmap_grid_m : null;
    return isNum(g) && g > 0 ? g : null;
  } catch (_e) {
    return null;
  }
}

function render(targetEl, payload) {
  injectStyle();
  targetEl.innerHTML = '';
  const root = el('div', { class: 'an-view' });

  const data = payload && typeof payload === 'object' ? payload : {};
  const insights = Array.isArray(data.insights) ? data.insights : [];
  const kpis = data.kpis && typeof data.kpis === 'object' ? data.kpis : {};
  const charts = data.charts && typeof data.charts === 'object' ? data.charts : {};
  // The run's RAW KPI document + the lattice pitch its congestion cells are on,
  // stashed by mountAnalysis. Both null for the analytic estimate / a project
  // with no run — every consumer below degrades to rendering nothing.
  const raw = (targetEl && targetEl._anKpis && typeof targetEl._anKpis === 'object')
    ? targetEl._anKpis : null;
  const gridM = (targetEl && isNum(targetEl._anGridM)) ? targetEl._anGridM : null;

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

  // 経路の警告 (棚貫通 / 経路グラフ未解決): correctness first — these say the
  // run's own travel figures are understated, so they sit above the read-out
  // they qualify. Nothing renders when both counters are zero/absent. They get
  // their own titled section: unlabelled red plates between the verdict and
  // 「自動で見つけた注目ポイント」 read as part of neither.
  const warnings = routeWarningCallouts(raw);
  if (warnings.length) {
    const wsec = el('section', { class: 'an-section' });
    const wtitle = el('h2', { class: 'an-section-title' }, '先に確認したい点');
    wtitle.appendChild(el('span', { class: 'sub' },
      'この結果の移動距離は実際より短く出ています'));
    wsec.appendChild(wtitle);
    warnings.forEach((ins) => wsec.appendChild(buildCallout(ins)));
    root.appendChild(wsec);
  }

  root.appendChild(buildInsightsSection(insights));
  root.appendChild(buildKpiSection(kpis, data.ci, data.rep_day));
  // 通路の混雑: only present when the run actually measured aisle waiting.
  const congSec = buildCongestionSection(raw, gridM);
  if (congSec) root.appendChild(congSec);
  const chartsSec = buildChartsSection(charts, data.currency, raw);
  if (chartsSec) root.appendChild(chartsSec);
  const prodSec = buildProdFeedback(data.productivity_compare, targetEl);
  if (prodSec) root.appendChild(prodSec);

  targetEl.appendChild(root);

  // Kick off the one-time enter sequence now the DOM is live (so getTotalLength
  // and layout are valid). Guarded so a failure here never blanks the view.
  try { animateView(root); } catch (_e) { /* visuals only — never fatal */ }
}

export async function mountAnalysis(targetEl, projectName) {
  if (!targetEl) return;
  // No project yet: show a friendly prompt instead of fetching /projects/null.
  injectStyle();
  if (typeof projectName !== 'string' || !projectName.trim()) {
    disposeAnalysis(targetEl);
    targetEl.innerHTML = '';
    targetEl.appendChild(buildPlaceholder('empty', 'まだ分析するデータがありません',
      'プロジェクトを作成して「▶実行」すると、判定・KPI・改善提案がここに並びます。'));
    return;
  }
  targetEl.innerHTML = '';
  targetEl.appendChild(buildPlaceholder('loading', '分析を読み込み中…',
    '実行結果からKPIと注目ポイントを組み立てています。'));

  let payload = null;
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(projectName)}/analysis`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    payload = await res.json();
  } catch (err) {
    targetEl.innerHTML = '';
    targetEl.appendChild(buildPlaceholder('error', '分析データを取得できませんでした',
      '通信に失敗した可能性があります。ページを再読み込みするか、もう一度「▶実行」してください。'));
    return;
  }

  // Stash the latest payload on the element so the (one-time) theme handler
  // always re-renders the CURRENT data, not the payload captured on first mount.
  targetEl._anPayload = payload;
  targetEl._anProject = projectName;  // for the 生産性フィードバック 採用 button
  targetEl._anKpis = await fetchRawKpis(projectName);
  targetEl._anGridM = await fetchGridPitch(projectName, targetEl._anKpis);
  render(targetEl, payload);

  // Re-render on theme change so the self-drawn SVG charts pick up new
  // CSS-variable colours (nice-to-have; harmless if the event never fires).
  // Exactly ONE listener per mounted instance: tear down the previous handler
  // (from an earlier mount of this element) before registering the new one so
  // listeners never pile up across tab switches. `disposeAnalysis` runs the
  // same teardown for explicit unmount/dispose paths.
  if (targetEl._anThemeHandler) {
    document.removeEventListener('themechange', targetEl._anThemeHandler);
    targetEl._anThemeHandler = null;
  }
  const handler = () => render(targetEl, targetEl._anPayload);
  targetEl._anThemeHandler = handler;
  document.addEventListener('themechange', handler);
}

// Teardown: remove the themechange listener for a previously-mounted element
// and drop its cached payload. Idempotent; safe to call on an unmounted element.
function disposeAnalysis(targetEl) {
  if (!targetEl) return;
  if (targetEl._anThemeHandler) {
    document.removeEventListener('themechange', targetEl._anThemeHandler);
    targetEl._anThemeHandler = null;
  }
  targetEl._anPayload = null;
  targetEl._anKpis = null;
  targetEl._anGridM = null;
}
