// bianalytics.js — 分析BIビュー. A ThoughtSpot-style "ask in words → chart"
// surface over the already-aggregated analysis endpoint, plus auto-insight cards
// and three hand-rolled SVG charts (ABC Pareto / weekday heatmap / time series).
// Everything renders client-side from one GET — no server round-trip on interaction.
//
// World-view (strict): Void/panel surfaces from tokens, a single theme accent
// (--accent, blue↔cyan per light/dark) + semantic green/amber/red only,
// Chakra(display)/Grotesk(sans)/Space Mono(numerics). 120–180ms ease-out, no
// idle loops, reduced-motion safe, data-ink maximised (hairline rules, no
// frames/shadows). Comments EN; UI JA.
//
// Accent: injected CSS uses var(--accent) directly so it follows the theme.
// Where SVG needs a literal colour string (stroke/fill attrs) we read --accent
// once via getComputedStyle and refresh it on the `themechange` document event.
import { esc } from './util.js';

const ACCENT_FALLBACK = '#34E3FF';   // cyan fallback when --accent is unreadable
const WARN = 'var(--warn)';
const BAD = 'var(--bad)';
const TIP_W = 220;                    // tooltip width (kept in sync with .bia-tip CSS)

// Read the live --accent token (resolved hex) for use inside SVG attribute
// strings. Refreshed on `themechange` so self-drawn charts follow the theme.
function readAccent() {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim();
  return v || ACCENT_FALLBACK;
}
// Convert a hex (#rgb/#rrggbb) accent to an rgba() string at the given alpha;
// non-hex values fall back to the resolved fallback so charts never break.
function accentAlpha(hex, a) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) h = ACCENT_FALLBACK.slice(1);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
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

  /* ── enter-only motion (mirror of analysis.js .an-in idiom) ── */
  .bia-anim{opacity:0;transform:translateY(6px);will-change:transform,opacity}
  .bia-anim.bia-in{opacity:1;transform:none;
    transition:opacity var(--dur-3) var(--ease-out),transform var(--dur-3) var(--ease-out)}
  .bia-anim.bia-settled{will-change:auto}
  @media (prefers-reduced-motion:reduce){
    .bia-anim{opacity:1;transform:none}
    .bia-anim.bia-in{transition:none}
  }

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
  /* one pill per active facet — the ✕ removes just that facet */
  .bia-pill{appearance:none;display:inline-flex;align-items:center;gap:var(--sp-2);font-family:var(--font-mono);
    font-size:var(--fs-micro);color:var(--accent);background:var(--accent-tint-2);
    border:1px solid var(--accent);border-radius:var(--r-pill);padding:var(--sp-1) var(--sp-3);cursor:pointer;
    transition:opacity var(--dur-1) var(--ease-out)}
  .bia-pill:hover{opacity:.75}
  .bia-pill:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .bia-pill .x{font-weight:700}
  /* "すべて解除" reset — quieter, no accent fill */
  .bia-fclear{appearance:none;font-family:var(--font-mono);font-size:var(--fs-micro);color:var(--ink-secondary);
    background:transparent;border:1px solid var(--line-hair);border-radius:var(--r-pill);
    padding:var(--sp-1) var(--sp-3);cursor:pointer;transition:color var(--dur-1) var(--ease-out),border-color var(--dur-1) var(--ease-out)}
  .bia-fclear:hover{color:var(--ink-primary);border-color:var(--line-strong)}
  .bia-fclear:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  @media (prefers-reduced-motion:reduce){.bia-pill,.bia-fclear{transition:none}}

  /* ── error / retry state (mirror of bi.js / dataanalysis.js) ── */
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

  /* Data/filter re-aggregation tween is driven by a small rAF lerp in JS
     (snapshotMarks/tweenMarks), gated on prefers-reduced-motion there; the
     heatmap cell keeps only its hover transform transition (above). */

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
    cursor:pointer;text-decoration:none;
    transition:opacity var(--dur-1) var(--ease-out)}
  .bia-drill a:hover{opacity:.7}
  @media (prefers-reduced-motion:reduce){.bia-drill a{transition:none}}

  /* ── shared chart shell ── */
  .bia-chart{background:var(--bg-panel);border:1px solid var(--line-hair);border-radius:var(--r-lg);padding:16px}
  .bia-ch-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:10px}
  .bia-ch-h h3{margin:0;font-family:var(--font-display);font-size:14px;font-weight:600;color:var(--ink-primary)}
  .bia-ch-h .sub{font-size:11px;color:var(--ink-tertiary)}
  .bia-ch-h .leg{margin-left:auto;display:flex;gap:12px;font-size:10.5px;color:var(--ink-tertiary);
    font-family:var(--font-mono)}
  .bia-ch-h .leg i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
  .bia-leg{cursor:pointer;border-radius:var(--r-xs);padding:0 var(--sp-1);
    transition:color var(--dur-1) var(--ease-out)}
  .bia-leg:hover{color:var(--ink-secondary)}
  .bia-leg.sel{color:var(--accent)}
  @media (prefers-reduced-motion:reduce){.bia-leg{transition:none}}
  .bia svg{display:block;width:100%;height:auto}
  .bia svg text{font-family:var(--font-mono);fill:var(--ink-tertiary)}
  .bia svg .axt{fill:var(--ink-secondary)}
  .bia svg .vlab{fill:var(--ink-secondary);font-variant-numeric:tabular-nums}
  /* cross-filter: clickable marks + de-emphasised non-matching marks */
  .bia-bar{cursor:pointer;transition:opacity var(--dur-2) var(--ease-out)}
  .bia-bar.off{opacity:.22}
  .bia-cell.off{opacity:.3}
  .bia-pt[data-hr]{cursor:pointer}
  /* brushing: live drag band + committed selection band on the hour sparkline */
  .bia-brush{pointer-events:none}
  .bia-brush-live{pointer-events:none}
  @media (prefers-reduced-motion:reduce){.bia-bar{transition:none}}

  /* ── weekday heatmap ── */
  .bia-heat{display:flex;gap:6px}
  .bia-cell{flex:1;border-radius:var(--r-sm);aspect-ratio:1/1.05;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:2px;border:1px solid var(--line-soft);
    cursor:pointer;transition:transform var(--dur-1,90ms) var(--ease-out,ease)}
  .bia-cell:hover{transform:translateY(-2px)}
  @media (prefers-reduced-motion:reduce){.bia-cell{transition:none}.bia-cell:hover{transform:none}}
  .bia-cell.max{outline:2px solid var(--accent);outline-offset:2px}
  .bia-cell.sel{outline:2px solid var(--accent);outline-offset:2px}
  .bia-cell .wd{font-family:var(--font-display);font-size:12px;font-weight:600}
  .bia-cell .vv{font-family:var(--font-mono);font-size:10px;font-variant-numeric:tabular-nums}

  /* ── tooltip (fixed width 220px — mirrored by TIP_W to avoid reflow reads) ── */
  .bia-tip{position:fixed;z-index:50;pointer-events:none;opacity:0;transform:translateY(2px);
    width:220px;box-sizing:border-box;
    background:var(--bg-app);border:1px solid var(--line-strong);border-radius:var(--r-md);
    padding:var(--sp-2) var(--sp-3);font-size:var(--fs-xs);color:var(--ink-primary);box-shadow:0 4px 16px rgba(0,0,0,.16);
    transition:opacity var(--dur-1) var(--ease-out);white-space:normal}
  .bia-tip.on{opacity:1}
  .bia-tip .n{font-family:var(--font-mono);font-variant-numeric:tabular-nums;color:var(--accent);font-weight:700}

  /* ── empty / scaffold ── */
  .bia-empty{background:var(--bg-panel);border:1px dashed var(--line-strong);border-radius:var(--r-lg);
    padding:30px;text-align:center;color:var(--ink-tertiary);font-size:13px;line-height:1.7}
  .bia-empty b{color:var(--ink-secondary)}
  .bia-empty-acts{display:flex;flex-wrap:wrap;gap:var(--sp-3);justify-content:center;align-items:center;margin-top:var(--sp-4)}
  .bia-cta{display:inline-block;font-family:var(--font-mono);font-size:var(--fs-sm);
    color:var(--accent);border:1px solid var(--accent);border-radius:var(--r-pill);
    padding:var(--sp-2) var(--sp-5);cursor:pointer;transition:background var(--dur-2) var(--ease-out)}
  .bia-cta:hover{background:var(--accent-tint-2)}
  /* primary (filled) variant — the data-import call to action */
  .bia-cta.primary{color:var(--bg-app);background:var(--accent);border-color:var(--accent);font-weight:700}
  .bia-cta.primary:hover{opacity:.88;background:var(--accent)}
  @media (prefers-reduced-motion:reduce){.bia-cta{transition:none}}
  .bia-scaffold{opacity:.5;filter:grayscale(.4)}
  `;
  document.head.appendChild(s);
}

export function mountBIAnalytics(el, opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const toast = opts.toast || (() => {});
  // Optional Cody delegation: when a question matches no keyword rule and this
  // is a function, the raw question is handed to Cody. Back-compatible: when
  // unset, the legacy "近い質問" suggestion list is shown instead.
  const askCody = typeof opts.askCody === 'function' ? opts.askCody : null;

  // Drill: ask PM-side to switch the active view. This file only fires the event;
  // the host listens for `whsim:nav` and performs the actual view switch.
  const nav = (view) => document.dispatchEvent(new CustomEvent('whsim:nav', { detail: { view } }));

  // Live accent (resolved hex) for SVG attribute strings. Read once, refreshed on
  // the `themechange` document event so self-drawn charts follow light/dark.
  let accent = readAccent();
  let accent40 = accentAlpha(accent, 0.4);
  function onThemeChange() {
    accent = readAccent();
    accent40 = accentAlpha(accent, 0.4);
    if (data && data.has_data) render();   // re-tint SVGs with the new accent
  }
  document.addEventListener('themechange', onThemeChange);

  // ── intra-view cross-filter state (TRUE propagation via xtab) ───────────
  // A click on a bar / weekday cell / legend rank / hour toggles a facet; the
  // weekday-heatmap, hourly chart and insight cards then RE-AGGREGATE from the
  // `xtab` cell array filtered to ALL active facets (no refetch). The `abc`
  // facet pins a clicked SKU (display-only on the Pareto); `rank` is the facet
  // that actually propagates from an ABC click/legend.
  //
  // MULTI-SELECT: `rank`, `weekday` and `hour` are SETS of selected values
  // (Set<string|number>). An EMPTY set means the facet is inactive (no
  // constraint). `filteredCells()` matches a cell when its facet value is IN the
  // set. Plain click toggles a single value (replace/clear); SHIFT or Ctrl/Cmd
  // click adds/removes from the set. `abc` stays a single pinned SKU (or null).
  let filterState = { abc: null, rank: new Set(), weekday: new Set(), hour: new Set() };
  // weekday is stored as the numeric xtab index (0=月..6=日) for clean joins;
  // labels are derived via xtabWeekdays() / WD for display.
  const PROPAGATING = ['rank', 'weekday', 'hour'];   // facets that re-aggregate via xtab
  const facetActive = (k) => filterState[k] instanceof Set && filterState[k].size > 0;
  const filterActive = () => PROPAGATING.some((k) => facetActive(k)) || filterState.abc != null;
  const propagatingActive = () => PROPAGATING.some((k) => facetActive(k));
  // Count of propagating facets that have at least one selected value.
  const activePropagatingFacets = () => PROPAGATING.filter((k) => facetActive(k));
  // Sorted member array of a facet's set (numbers ascending, else lexical).
  function facetValues(key) {
    const s = filterState[key];
    if (!(s instanceof Set)) return [];
    return Array.from(s).sort((a, b) => (typeof a === 'number' && typeof b === 'number')
      ? a - b : String(a).localeCompare(String(b)));
  }
  const freshFilterState = () => ({ abc: null, rank: new Set(), weekday: new Set(), hour: new Set() });
  function clearFilter() {
    filterState = freshFilterState();
    render();
  }
  // Remove an entire facet (the "abc" facet, or all members of a set facet).
  function clearFacet(key) {
    if (key === 'abc') filterState.abc = null;
    else if (filterState[key] instanceof Set) filterState[key].clear();
    render();
  }
  // Remove a single value from a set facet (used by per-value pills).
  function removeFacetValue(key, val) {
    if (filterState[key] instanceof Set) filterState[key].delete(val);
    render();
  }
  // Toggle a value in a set facet.
  //   additive=false (plain click): single-select — if the set is exactly {val}
  //     clear it, otherwise replace the whole set with {val}.
  //   additive=true (shift/ctrl/cmd click): add the value, or remove it if present.
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
  // Detect the additive modifier from a keyboard/pointer event.
  const isAdditive = (e) => !!(e && (e.shiftKey || e.ctrlKey || e.metaKey));

  // ── xtab helpers: derive filtered cell sets + re-aggregations ───────────
  const xtabCells = () => (data && Array.isArray(data.xtab) ? data.xtab : []);
  const xtabWeekdays = () => (data && Array.isArray(data.xtab_weekdays) && data.xtab_weekdays.length
    ? data.xtab_weekdays : WD);
  // Cells matching ALL currently-active propagating facets (rank/weekday/hour).
  // `except` lets a chart exclude its own facet so it shows the full distribution
  // along its own axis (e.g. the weekday heatmap ignores the weekday facet so
  // every weekday stays visible, with the selected one highlighted instead).
  function filteredCells(except) {
    return xtabCells().filter((c) => {
      if (except !== 'rank' && facetActive('rank') && !filterState.rank.has(c.rank)) return false;
      if (except !== 'weekday' && facetActive('weekday') && !filterState.weekday.has(c.weekday)) return false;
      if (except !== 'hour' && facetActive('hour') && !filterState.hour.has(c.hour)) return false;
      return true;
    });
  }
  // Per-weekday totals (qty) from cells, indexed 0..6; ignores the weekday facet.
  function weekdayProfile() {
    const wd = xtabWeekdays();
    const totals = wd.map(() => 0);
    filteredCells('weekday').forEach((c) => {
      if (c.weekday >= 0 && c.weekday < totals.length) totals[c.weekday] += (c.qty || 0);
    });
    return wd.map((label, i) => ({ label, weekday: i, qty: totals[i] }));
  }
  // Per-hour totals (qty) from cells, indexed 0..23; ignores the hour facet.
  function hourProfile() {
    const totals = new Array(24).fill(0);
    filteredCells('hour').forEach((c) => {
      if (c.hour >= 0 && c.hour < 24) totals[c.hour] += (c.qty || 0);
    });
    // mirror the default `hourly` label shape ("HH時") so tooltips read naturally
    return totals.map((qty, h) => ({ label: `${h}時`, hour: h, qty }));
  }
  // weekday index → display label (月..日) using the payload's order when present.
  const weekdayLabel = (i) => (i == null ? '' : (xtabWeekdays()[i] || WD[i] || String(i)));
  // Human-readable summary of the active facets, for card/insight copy.
  // Multi-valued facets join their members with "・" (e.g. "火・水曜").
  function filterDescription() {
    const parts = [];
    if (facetActive('rank')) parts.push(`ランク${facetValues('rank').join('・')}`);
    if (facetActive('weekday')) parts.push(`${facetValues('weekday').map(weekdayLabel).join('・')}曜`);
    if (facetActive('hour')) parts.push(`${facetValues('hour').join('・')}時`);
    return parts.join(' · ') || '選択';
  }
  // xtab_sku: per-SKU × weekday breakdown ([{sku, weekday, qty, lines}]); empty
  // when the server has no data. Used to RE-RANK the ABC Pareto under a
  // weekday-only selection (a true re-aggregation, not a dim+annotate).
  const xtabSku = () => (data && Array.isArray(data.xtab_sku) ? data.xtab_sku : []);
  const hasSkuXtab = () => xtabSku().length > 0;
  // True only when the weekday facet is the SOLE active facet (≥1 weekday, and
  // no rank/hour facet) AND per-SKU weekday data exists — the one case where we
  // can honestly re-rank individual SKUs by the selected weekday(s).
  function weekdayOnlySelection() {
    return facetActive('weekday') && !facetActive('rank') && !facetActive('hour') && hasSkuXtab();
  }
  // Re-aggregate the abc[] SKUs by summing xtab_sku over the selected weekday(s),
  // re-sort descending by the filtered qty, then recompute cumulative %/ranks for
  // THAT selection. Returns the same row shape as data.abc (sku/name/qty/cum/rank)
  // so the Pareto renderer is unchanged. Falls back to data.abc when not eligible.
  function paretoRows() {
    const base = (data.abc || []).slice();
    if (!weekdayOnlySelection() || !base.length) return { rows: base, reranked: false };
    const days = filterState.weekday;          // Set<number>
    const byName = new Map();                   // display name → meta (carry name)
    base.forEach((r) => { byName.set(r.sku || r.name, { sku: r.sku, name: r.name }); });
    const qtyBy = new Map();                     // sku-key → summed qty for selection
    xtabSku().forEach((c) => {
      if (!days.has(c.weekday)) return;
      const key = c.sku;
      if (!byName.has(key)) return;             // only re-rank known abc SKUs
      qtyBy.set(key, (qtyBy.get(key) || 0) + (c.qty || 0));
    });
    // Build rows for every abc SKU (0 when it has no rows on the selected days).
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

  // Rank-level A/B/C distribution (lines + qty) for the *fully* filtered cells —
  // used by the ABC chart when a weekday/hour facet makes per-SKU bars invalid.
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

  // one floating tooltip reused by every chart
  const tip = document.createElement('div');
  tip.className = 'bia-tip';
  document.body.appendChild(tip);
  const showTip = (html, ev) => {
    tip.innerHTML = html;
    tip.classList.add('on');
    const px = (ev.clientX || 0) + 14;
    const py = (ev.clientY || 0) + 14;
    // Tooltip width is fixed in CSS (TIP_W); use the constant rather than
    // reading offsetWidth, which would force a layout reflow on every hover.
    tip.style.left = `${Math.min(px, window.innerWidth - TIP_W - 8)}px`;
    tip.style.top = `${py}px`;
  };
  const hideTip = () => tip.classList.remove('on');

  let data = null;          // analysis payload
  let lastParetoRows = [];  // rows actually drawn by svgPareto (default or re-ranked)
  let loadErr = null;       // last load() failure (null = none); drives the retry state
  let exIdx = 0, exTimer = 0;
  let animatedOnce = false; // stagger fade-in only on first data arrival, not on
                            // every filter/theme re-render

  // ── lightweight rule mapper: keyword → {section, answer} ──────────────
  // Pure string rules over Japanese keywords; never calls the server. Unknown
  // questions fall through to a "近い質問" suggestion list (the examples).
  function answerQuestion(qRaw) {
    const q = (qRaw || '').trim();
    if (!q) { setAnswer(''); clearDim(); return; }
    const has = (...ks) => ks.some((k) => q.includes(k));

    // ABC / 上位 / 偏り
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
    // 曜日（梱包/詰まる/混む/物量 を含む曜日質問）
    if (has('曜日') || has('梱包', '詰ま', '混む', '忙しい')) {
      const w = data.by_weekday || [];
      if (!w.length) return suggestNoData('weekday');
      const mx = w.reduce((a, b) => ((b.qty || 0) > (a.qty || 0) ? b : a), w[0]);
      focus('weekday');
      setAnswer(`物量が最も多い曜日は <span class="hit">${esc(mx.label)}曜</span>（<b>${fmt(mx.qty)}</b>）。ここが詰まりやすい曜日です。`);
      return;
    }
    // ピーク / 時間帯 / 時間
    if (has('ピーク', '時間帯', '時間', '何時', 'ピーク時')) {
      const h = data.hourly || [];
      if (!h.length) return suggestNoData('time');
      const mx = h.reduce((a, b) => ((b.qty || 0) > (a.qty || 0) ? b : a), h[0]);
      focus('time');
      setAnswer(`ピークは <span class="hit">${esc(mx.label)}</span> 帯（<b>${fmt(mx.qty)}</b>）。人員はこの時間に厚く。`);
      return;
    }
    // データ範囲 / 期間
    if (has('範囲', '期間', 'いつ', '何日', 'データ')) {
      const d = data.daily || [];
      if (!d.length) return suggestNoData('time');
      focus('time');
      const total = d.reduce((s, r) => s + (r.qty || 0), 0);
      setAnswer(`データ範囲は <span class="hit">${fmt(d.length)}日分</span>（${esc(d[0].label || '')}〜${esc(d[d.length - 1].label || '')}）、合計 <b>${fmt(total)}</b>。`);
      return;
    }
    // fall-through (no rule matched): delegate to Cody if available, else suggest.
    clearDim();
    if (askCody) {
      // Show an inline handoff note first so the jump to Cody is not jarring.
      setAnswer(`<span class="sug">OCTA に聞いています…「<b>${esc(q)}</b>」</span>`);
      askCody(q);
      return;
    }
    setAnswer(`<span class="sug">うまく解釈できませんでした。近い質問: ${EXAMPLES.slice(0, 3).map((e) => `<u data-ex="${esc(e)}">${esc(e)}</u>`).join(' / ')}</span>`);
    // [data-ex] clicks are handled by a single delegated listener on root (wireAsk).
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
    if (tgt && !matchMedia('(prefers-reduced-motion:reduce)').matches) {
      tgt.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
  function clearDim() { root.querySelectorAll('[data-sec]').forEach((n) => n.classList.remove('bia-dim')); }

  // ── auto-insights (max 3): fact line + implication line ───────────────
  // When a propagating facet (rank/weekday/hour) is active the weekday & hour
  // figures are recomputed from the filtered xtab cells so the numbers reflect
  // the current selection; otherwise the default unfiltered aggregates are used.
  function insights() {
    const out = [];
    const filtered = propagatingActive();
    const selLabel = filterDescription();   // e.g. "ランクA · 火曜" for card copy
    const abc = data.abc || [];
    if (abc.length) {
      if (weekdayOnlySelection()) {
        // weekday-only + per-SKU data: a TRUE re-rank of the SKUs by the
        // selected weekday(s) — report the re-aggregated top-20% concentration.
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
        // per-SKU re-ranking is impossible from rank-level xtab; report the
        // rank-level mix of the selection instead of pretending to re-rank.
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

  // ── ③ ABC Pareto (SVG): bars desc + cumulative line on right axis ─────
  // rankOf: A (cum≤70%) / B (≤90%) / C — used for both colour and rank filter.
  function rankOf(r) {
    if (r.rank === 'A' || r.rank === 'B' || r.rank === 'C') return r.rank;
    if (r.cum != null) return r.cum <= 0.7 ? 'A' : r.cum <= 0.9 ? 'B' : 'C';
    return 'C';
  }
  function svgPareto() {
    // paretoRows() returns the default abc[] OR, under a weekday-ONLY selection
    // with per-SKU data (xtab_sku), a TRUE re-aggregation: SKUs re-summed over the
    // selected weekday(s), re-sorted desc, with fresh cumulative %/ranks.
    const pr = paretoRows();
    const a = pr.rows.slice();
    const reranked = pr.reranked;
    // expose the rendered rows (default OR re-ranked) so the bar tooltip/click
    // wiring can look a bar up by its index against the SAME array that drew it.
    lastParetoRows = a;
    if (!a.length) return scaffold('abc', 'ABCパレート', '物量降順の棒＋累積%線');
    // When a propagating facet is active that we CANNOT honestly re-rank (hour
    // facet, or rank/weekday mixes, or weekday without per-SKU data), the per-SKU
    // ordering no longer reflects the selection. Rather than fake it, we dim the
    // bars and overlay the rank-level A/B/C split of the selection. The
    // weekday-only-with-sku-data case is handled by `reranked` above instead.
    const dimSku = propagatingActive() && !reranked;
    const W = 760, H = 260, ml = 8, mr = 38, mt = 14, mb = 28;
    const iw = W - ml - mr, ih = H - mt - mb;
    const n = a.length;
    const maxQ = Math.max(...a.map((r) => r.qty || 0), 1);
    const bw = iw / n;
    const x = (i) => ml + i * bw;
    const yBar = (q) => mt + ih - (q / maxQ) * ih;
    const yCum = (c) => mt + ih - (c) * ih; // c is 0..1
    const colOf = (r) => { const k = rankOf(r); return k === 'A' ? accent : k === 'B' ? accent40 : 'var(--line-strong)'; };
    // active cross-filter: a specific sku (bar) or one/more ranks (legend) may be
    // selected. fRank is the multi-valued rank set (empty = no constraint).
    const fSku = filterState.abc;
    const isMatch = (r) => (fSku == null || (r.sku || r.name) === fSku)
      && (!facetActive('rank') || filterState.rank.has(rankOf(r)));
    // bars (label the top few; hide labels on thin bars to avoid clutter)
    const LABEL_TOP = Math.min(5, n);          // label at most the first 5 bars
    let bars = '', vlabs = '';
    a.forEach((r, i) => {
      const h = mt + ih - yBar(r.qty || 0);
      // dim when a weekday/hour facet invalidates per-SKU ranking, or when a
      // sku/rank facet is active and this bar doesn't match it.
      const off = dimSku || (filterActive() && !isMatch(r));
      bars += `<rect class="bia-bar${off ? ' off' : ''}" data-i="${i}" data-sku="${esc(r.sku || r.name || '')}" `
        + `x="${(x(i) + 1).toFixed(1)}" y="${yBar(r.qty || 0).toFixed(1)}" `
        + `width="${Math.max(1, bw - 2).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" `
        + `fill="${colOf(r)}" rx="1"></rect>`;
      // value labels: only top-N bars and only when the bar is wide enough to read
      if (i < LABEL_TOP && bw >= 16 && (r.qty || 0) > 0) {
        vlabs += `<text class="vlab" x="${(x(i) + bw / 2).toFixed(1)}" y="${(yBar(r.qty || 0) - 4).toFixed(1)}" `
          + `font-size="9" text-anchor="middle">${fmt(r.qty)}</text>`;
      }
    });
    // cumulative polyline (use provided cum, else derive)
    let acc = 0; const tot = a.reduce((s, r) => s + (r.qty || 0), 0) || 1;
    const pts = a.map((r, i) => {
      const c = r.cum != null ? r.cum : (acc += (r.qty || 0) / tot, acc);
      return `${(x(i) + bw / 2).toFixed(1)},${yCum(Math.min(1, c)).toFixed(1)}`;
    }).join(' ');
    // 70/90 guides + right axis ticks
    const guide = (frac, label, col) => {
      const yy = yCum(frac).toFixed(1);
      return `<line x1="${ml}" x2="${ml + iw}" y1="${yy}" y2="${yy}" stroke="${col}" stroke-width="1" stroke-dasharray="3 3" opacity=".5"></line>`
        + `<text x="${ml + iw + 4}" y="${(+yy + 3).toFixed(1)}" font-size="9">${label}</text>`;
    };
    let axis = '';
    [0, 0.5, 1].forEach((f) => {
      axis += `<text x="${ml + iw + 4}" y="${(yCum(f) + 3).toFixed(1)}" font-size="9">${pct(f)}</text>`;
    });
    const top = a[0];
    // overlay shown when per-SKU bars are dimmed: the honest rank-level A/B/C
    // split of the current selection (we do NOT re-rank individual SKUs).
    let overlay = '';
    if (dimSku) {
      const dist = rankDistribution();
      const totQ = dist.reduce((s, r) => s + (r.qty || 0), 0) || 1;
      const parts = dist.map((r) => `${esc(r.rank)} ${pct((r.qty || 0) / totQ)}`).join('　');
      const note = `${filterDescription()}で絞込中`;
      overlay = `<text x="${(ml + iw / 2).toFixed(1)}" y="${(mt + ih / 2 - 8).toFixed(1)}" `
        + `font-size="12" text-anchor="middle" class="axt">${esc(note)}</text>`
        + `<text x="${(ml + iw / 2).toFixed(1)}" y="${(mt + ih / 2 + 10).toFixed(1)}" `
        + `font-size="11" text-anchor="middle" class="vlab" font-family="var(--font-mono)">${esc('選択物量のランク構成 ' + parts)}</text>`;
    }
    const aria = dimSku
      ? `ABCパレート図。${esc(filterDescription())}で絞込中のため個別SKUの再ランクは表示できません。選択物量のランク構成を表示。`
      : reranked
        ? `ABCパレート図。${esc(filterDescription())}で再集計し、${fmt(n)}品目を選択物量の降順で再ランク表示。最上位は ${esc(top.name || top.sku || '')}、物量 ${fmt(top.qty)}。`
        : `ABCパレート図。${fmt(n)}品目を物量降順で表示。最上位は ${esc(top.name || top.sku || '')}、物量 ${fmt(top.qty)}。`;
    const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">
      ${guide(0.7, '70%', WARN)}${guide(0.9, '90%', BAD)}
      ${bars}
      ${dimSku ? '' : vlabs}
      <polyline points="${pts}" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round"${dimSku ? ' opacity=".22"' : ''}></polyline>
      ${a.map((r, i) => { let c2 = r.cum != null ? r.cum : 0; return `<circle cx="${(x(i) + bw / 2).toFixed(1)}" cy="${yCum(Math.min(1, c2)).toFixed(1)}" r="2" fill="${accent}"${dimSku ? ' opacity=".22"' : ''}></circle>`; }).join('')}
      ${axis}
      ${overlay}
    </svg>`;
    // subtitle states the active selection: re-ranked / dim+annotate / default.
    const sub = reranked ? `${filterDescription()}で再集計（再ランク済み）`
      : dimSku ? `${filterDescription()}で絞込中・再ランク不可`
        : `${fmt(n)}品目を物量降順で`;
    // legend ranks are clickable filters (data-rank)
    return chartShell('abc', 'ABCパレート', sub, svg, [
      [accent, 'A (〜70%)', 'A'], [accent40, 'B (〜90%)', 'B'], ['var(--line-strong)', 'C', 'C'],
    ]);
  }

  // ── ④ weekday mini-heatmap: 7 accent-shade cells, ring on max ─────────
  // Re-aggregates from filtered xtab cells whenever a propagating facet
  // (rank/hour) is active, so e.g. selecting rank A shows A's weekday profile.
  // The weekday facet itself is excluded from the filter (every weekday stays
  // visible) and instead surfaces as a highlighted .sel cell.
  function heatWeekday() {
    const haveXtab = xtabCells().length > 0;
    let series;   // [{label, qty, weekday}] indexed for cells (weekday may be null)
    if (haveXtab) {
      series = weekdayProfile();   // re-aggregated, intersects active facets
    } else {
      const raw = data.by_weekday || [];
      if (!raw.length) return scaffold('weekday', '曜日別ヒートマップ', '7セルの濃淡');
      const byLabel = {}; raw.forEach((r) => { byLabel[r.label] = r.qty || 0; });
      series = WD.every((d) => d in byLabel)
        ? WD.map((d, i) => ({ label: d, qty: byLabel[d], weekday: i }))
        : raw.map((r) => ({ label: r.label, qty: r.qty || 0, weekday: WD.indexOf(r.label) }));
    }
    if (!series.length) return scaffold('weekday', '曜日別ヒートマップ', '7セルの濃淡');
    const max = Math.max(...series.map((r) => r.qty || 0), 1);
    const mxRow = series.reduce((a, b) => ((b.qty || 0) > (a.qty || 0) ? b : a), series[0]);
    const fWd = filterState.weekday;     // Set<number> of selected weekday indices
    const cells = series.map((r) => {
      const t = (r.qty || 0) / max;                 // 0..1
      const a = 0.10 + t * 0.78;                     // alpha ramp on accent
      const isMax = (r.qty || 0) === max && max > 0;
      const sel = r.weekday != null && fWd.has(r.weekday);
      // high-contrast ink on dark cells; tertiary-ink-ish on faint cells
      const ink = t > 0.55 ? 'var(--bg-app)' : 'var(--ink-secondary)';
      // tween cell intensity via CSS transition on background (data-driven recolour)
      return `<div class="bia-cell bia-tcell${isMax ? ' max' : ''}${sel ? ' sel' : ''}"
        data-hd="${esc(r.label)}|${r.qty || 0}" data-wd="${r.weekday == null ? '' : r.weekday}" role="button" tabindex="0"
        aria-label="${esc(r.label)}曜 物量 ${fmt(r.qty)}${sel ? '（選択中）' : ''}"
        style="background:${accentAlpha(accent, +a.toFixed(3))}">
        <span class="wd" style="color:${ink}">${esc(r.label)}</span>
        <span class="vv" style="color:${ink}">${fmt(r.qty)}</span></div>`;
    }).join('');
    const subtitle = propagatingActive() ? `${esc(filterDescription())}で絞込中` : '濃いほど物量大';
    const aria = `曜日別ヒートマップ。物量が最も多いのは ${esc(mxRow.label)}曜（${fmt(mxRow.qty)}）。`;
    const heat = `<div class="bia-heat" role="img" aria-label="${esc(aria)}">${cells}</div>`;
    return chartShell('weekday', '曜日別ヒートマップ', subtitle, heat, null);
  }

  // ── ⑤ time series: daily area (faint cyan fill + line) + hourly sparkline
  // The hourly curve is RE-AGGREGATED from filtered xtab cells (so selecting
  // 火曜 reshapes it to Tuesday). The daily series is filtered to matching
  // weekdays ONLY when a weekday facet is the sole active facet (day index
  // carries weekday via day%7, matching the server's floor(arrival_s/86400)%7);
  // otherwise the full series is shown so the trend stays readable.
  function timeSeries() {
    const allDaily = data.daily || [];
    const haveXtab = xtabCells().length > 0;
    // hourly: re-aggregate from xtab when available, else fall back to default
    const hourly = haveXtab
      ? hourProfile().map((r) => ({ ...r, label: `${r.hour}時` }))
      : (data.hourly || []).map((r) => ({ ...r, label: r.label || (r.hour != null ? `${r.hour}時` : '') }));
    // daily: filter to the selected weekday(s) only when weekday is the lone active
    // facet (multi-select supported — keep any day whose weekday is in the set).
    const onlyWeekday = facetActive('weekday')
      && !facetActive('rank') && !facetActive('hour');
    const daily = (onlyWeekday && allDaily.length && allDaily.every((r) => r.day != null))
      ? allDaily.filter((r) => filterState.weekday.has(r.day % 7))
      : allDaily;
    if (!daily.length && !hourly.length) return scaffold('time', '時系列', '日次エリア＋時間スパークライン');
    let body = '';
    if (daily.length) body += areaSVG(daily, 'daily');
    if (hourly.length) {
      const hsub = propagatingActive() ? `${esc(filterDescription())}で絞込中` : 'スパークライン';
      body += `<div style="margin-top:14px"><div class="bia-ch-h" style="margin-bottom:6px">
        <h3 style="font-size:12px">時間帯</h3><span class="sub">${hsub}</span></div>${sparkSVG(hourly)}</div>`;
    }
    let sub = daily.length ? `日次 ${fmt(daily.length)}日` : '時間帯別';
    if (onlyWeekday && daily.length) {
      sub += `（${facetValues('weekday').map(weekdayLabel).join('・')}曜のみ）`;
    }
    return chartShell('time', '時系列', sub, body, null);
  }

  function areaSVG(d, kind) {
    const W = 760, H = 170, ml = 8, mr = 8, mt = 12, mb = 22;
    const iw = W - ml - mr, ih = H - mt - mb, n = d.length;
    const max = Math.max(...d.map((r) => r.qty || 0), 1);
    const x = (i) => ml + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (q) => mt + ih - (q / max) * ih;
    const line = d.map((r, i) => `${x(i).toFixed(1)},${y(r.qty || 0).toFixed(1)}`).join(' ');
    const area = `${ml},${(mt + ih).toFixed(1)} ${line} ${(ml + iw).toFixed(1)},${(mt + ih).toFixed(1)}`;
    const labels = [0, Math.floor(n / 2), n - 1].filter((i, k, a) => a.indexOf(i) === k && i >= 0);
    const dots = d.map((r, i) => `<rect class="bia-pt" data-pt="${esc(r.label || '')}|${r.qty || 0}" x="${(x(i) - Math.max(3, iw / n / 2)).toFixed(1)}" y="${mt}" width="${Math.max(6, iw / n).toFixed(1)}" height="${ih}" fill="transparent"></rect>`).join('');
    // y-axis: a couple of tick labels (max + mid) so the magnitude is legible
    const yticks = [max, max / 2].map((v) => `<text x="${ml}" y="${(y(v) - 3).toFixed(1)}" font-size="8" text-anchor="start">${fmt(v)}</text>`).join('');
    // peak callout: dot + value label on the highest day
    const pi = d.reduce((bi, r, i) => ((r.qty || 0) > (d[bi].qty || 0) ? i : bi), 0);
    const peak = `<circle cx="${x(pi).toFixed(1)}" cy="${y(d[pi].qty || 0).toFixed(1)}" r="3" fill="${accent}"></circle>`
      + `<text class="vlab" x="${x(pi).toFixed(1)}" y="${(y(d[pi].qty || 0) - 6).toFixed(1)}" font-size="9" text-anchor="middle">${fmt(d[pi].qty)}</text>`;
    const aria = `日次物量の推移。${fmt(n)}日分、最大は ${esc(d[pi].label || '')} の ${fmt(d[pi].qty)}。`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">
      <polygon points="${area}" fill="${accentAlpha(accent, 0.12)}"></polygon>
      <polyline points="${line}" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round"></polyline>
      ${yticks}
      ${peak}
      ${labels.map((i) => `<text x="${x(i).toFixed(1)}" y="${H - 6}" font-size="9" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(d[i].label || '')}</text>`).join('')}
      ${dots}
    </svg>`;
  }

  function sparkSVG(h) {
    const W = 760, H = 70, ml = 8, mr = 8, mt = 8, mb = 16;
    const iw = W - ml - mr, ih = H - mt - mb, n = h.length;
    const max = Math.max(...h.map((r) => r.qty || 0), 1);
    const x = (i) => ml + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (q) => mt + ih - (q / max) * ih;
    const line = h.map((r, i) => `${x(i).toFixed(1)},${y(r.qty || 0).toFixed(1)}`).join(' ');
    const mxi = h.reduce((bi, r, i) => ((r.qty || 0) > (h[bi].qty || 0) ? i : bi), 0);
    const hourSel = filterState.hour;   // Set<number> of selected hours
    // hourly hotspots are also clickable cross-filters on the hour facet (data-hr);
    // each carries data-i / data-x so the brush handler can map a pointer x back to
    // an hour index without re-reading layout. Geometry constants are exposed on the
    // SVG via data-* so brushHour() can build the visual band in viewBox units.
    const bars = h.map((r, i) => {
      const seld = r.hour != null && hourSel.has(r.hour);
      return `<rect class="bia-pt${seld ? ' sel' : ''}" data-pt="${esc(r.label || '')}|${r.qty || 0}"`
        + `${r.hour != null ? ` data-hr="${r.hour}"` : ''} data-i="${i}" role="button" tabindex="0"`
        + ` aria-label="${esc(r.label || '')} 物量 ${fmt(r.qty)}${seld ? '（選択中）' : ''}"`
        + ` x="${(x(i) - Math.max(3, iw / n / 2)).toFixed(1)}" y="${mt}" width="${Math.max(5, iw / n).toFixed(1)}" height="${ih}" fill="transparent"></rect>`;
    }).join('');
    // brushed band: shade the contiguous selected-hour range so a drag selection
    // reads as a single region (mirror of a Tableau range brush). Only when the
    // selected hours map to known indices in this series.
    let band = '';
    if (hourSel.size) {
      const idxs = h.map((r, i) => (r.hour != null && hourSel.has(r.hour) ? i : -1)).filter((i) => i >= 0);
      if (idxs.length) {
        const i0 = Math.min(...idxs), i1 = Math.max(...idxs);
        const half = Math.max(3, iw / n / 2);
        const bx = (x(i0) - half).toFixed(1);
        const bw = (x(i1) + half - (x(i0) - half)).toFixed(1);
        band = `<rect class="bia-brush" x="${bx}" y="${mt}" width="${bw}" height="${ih}" `
          + `fill="${accentAlpha(accent, 0.14)}" stroke="${accent40}" stroke-width="1" rx="2" pointer-events="none"></rect>`;
      }
    }
    const aria = `時間帯スパークライン。ピークは ${esc(h[mxi].label || '')}（${fmt(h[mxi].qty)}）。`
      + (hourSel.size ? `現在 ${facetValues('hour').join('・')}時を選択中。ドラッグで時間帯の範囲を選択できます。` : 'ドラッグで時間帯の範囲を選択できます。');
    // data-brush carries the layout the pointer handler needs (ml/iw/n) in viewBox
    // units so it can convert client-x → hour index. A transparent full-width hit
    // layer (.bia-brushlayer) under the bars captures pointerdown for the drag.
    return `<svg class="bia-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}"
      data-brush="1" data-ml="${ml}" data-iw="${iw}" data-n="${n}" data-mt="${mt}" data-ih="${ih}">
      ${band}
      <polyline points="${line}" fill="none" stroke="${accent40}" stroke-width="1.5"></polyline>
      <circle cx="${x(mxi).toFixed(1)}" cy="${y(h[mxi].qty || 0).toFixed(1)}" r="3" fill="${accent}"></circle>
      <text x="${x(mxi).toFixed(1)}" y="${(y(h[mxi].qty || 0) - 6).toFixed(1)}" font-size="9" text-anchor="middle" class="axt">${esc(h[mxi].label || '')}</text>
      <rect class="bia-brushlayer" x="${ml}" y="${mt}" width="${iw}" height="${ih}" fill="transparent" style="cursor:ew-resize"></rect>
      ${bars}
    </svg>`;
  }

  function chartShell(sec, title, sub, body, legend) {
    // legend rows: [colour, label] or [colour, label, rank] — a rank makes the
    // row a clickable cross-filter (data-rank), with .sel showing the active one.
    const leg = legend ? `<div class="leg">${legend.map(([c, t, rank]) => {
      const sel = rank && facetActive('rank') && filterState.rank.has(rank) ? ' sel' : '';
      const attrs = rank ? ` class="bia-leg${sel}" data-rank="${esc(rank)}" role="button" tabindex="0"` : '';
      return `<span${attrs}><i style="background:${c}"></i>${esc(t)}</span>`;
    }).join('')}</div>` : '';
    return `<section class="bia-chart" data-sec="${sec}">
      <div class="bia-ch-h"><h3>${esc(title)}</h3><span class="sub">${esc(sub)}</span>${leg}</div>
      ${body}</section>`;
  }

  // empty-state scaffold for a chart whose array is missing — frame kept, no fabrication
  function scaffold(sec, title, sub) {
    return `<section class="bia-chart bia-scaffold" data-sec="${sec}">
      <div class="bia-ch-h"><h3>${esc(title)}</h3><span class="sub">${esc(sub)}</span></div>
      <div class="bia-empty" style="border:none;padding:18px">この図は実データが入ると描画されます。</div>
    </section>`;
  }

  // ── render ────────────────────────────────────────────────────────────
  function render() {
    // Any path below rewrites root.innerHTML, orphaning the previous render's
    // brush listeners; tear them down up-front so non-chart branches don't leak
    // (the full-data branch re-attaches via rebindBrush() at the end).
    teardownBrush();
    const name = getProject();
    if (!name) {
      root.innerHTML = '<div class="bia-empty">プロジェクトを選択してください。</div>';
      return;
    }
    if (loadErr) {
      // recoverable error: never leave a stuck spinner/blank — offer 再試行.
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
      // animated spinner replaces the old plain "読み込み中…" text
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

    // snapshot current chart geometry so we can tween old→new on re-aggregation
    const snap = animatedOnce ? snapshotMarks() : null;
    const ins = insights();
    root.innerHTML = `
      ${askBox()}
      ${chipsRow()}
      ${filterBar()}
      ${ins.length ? `<div class="bia-ins">${ins.map(insCard).join('')}</div>` : ''}
      ${svgPareto()}
      ${heatWeekday()}
      ${timeSeries()}`;
    wireAsk();
    wireInsights();
    wireCharts();
    wireFilterBar();
    rebindBrush();   // (re)attach hour-sparkline brush to the freshly-built SVG
    enterAnimate();
    if (snap) tweenMarks(snap);   // lightweight rAF lerp from previous geometry
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

  // example questions rendered as clickable quick-chips (click fills + submits)
  function chipsRow() {
    return `<div class="bia-chips" role="group" aria-label="質問の例">
      ${EXAMPLES.map((e) => `<button type="button" class="bia-chip" data-ex="${esc(e)}">${esc(e)}</button>`).join('')}
    </div>`;
  }

  // cross-filter active-filter pills — MULTI-SELECT aware: one removable pill per
  // *selected value* (so ランク:A and ランク:B are two pills, each with its own ✕),
  // plus a "すべて解除" reset. A pill's ✕ removes only that single value via
  // [data-facet,data-val]; the abc pill (single) clears the whole abc facet. The
  // set can never get stuck — every member is independently removable and refresh()
  // rebuilds fresh empty Sets. Bar is empty (but present) when no facet active.
  function filterBar() {
    if (!filterActive()) return '<div class="bia-filterbar"></div>';
    // [facetKey, value-or-null, displayLabel] for every currently-active value
    const pills = [];
    if (filterState.abc != null) pills.push(['abc', null, `SKU:${filterState.abc}`]);
    if (facetActive('rank')) {
      facetValues('rank').forEach((v) => pills.push(['rank', v, `ランク:${v}`]));
    }
    if (facetActive('weekday')) {
      facetValues('weekday').forEach((v) => pills.push(['weekday', v, `曜日:${weekdayLabel(v)}`]));
    }
    if (facetActive('hour')) {
      facetValues('hour').forEach((v) => pills.push(['hour', v, `時間:${v}時`]));
    }
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

  // ── data/filter re-aggregation tween (lightweight rAF lerp) ─────────────
  // On a filter-driven re-render we snapshot the OLD geometry (bar y/height,
  // heatmap cell alpha) keyed by stable data-attrs, then lerp the freshly-built
  // marks from old→new over ~var(--dur-3). Gated on reduced-motion. Polylines
  // whose point counts changed (e.g. weekday-filtered daily) just snap (no lerp).
  let tweenRAF = 0;

  // ── brushing on the hour sparkline (pointer drag → contiguous hour range) ──
  // Every render builds a fresh .bia-spark element, so brush listeners must be
  // (a) rebound to the new node and (b) torn down for the old one. We keep a list
  // of teardown fns; rebindBrush() runs them before wiring the new node, and
  // dispose() runs them too. The document-level move/up listeners exist ONLY for
  // the duration of an active drag (added on pointerdown, removed on pointerup),
  // and that pointerup remover is also captured as a teardown so a re-render or
  // dispose mid-drag cannot leak them.
  let brushTeardowns = [];
  function teardownBrush() {
    brushTeardowns.forEach((fn) => { try { fn(); } catch (_) { /* noop */ } });
    brushTeardowns = [];
  }
  function rebindBrush() {
    teardownBrush();                       // detach the previous render's listeners
    const svg = root.querySelector('svg.bia-spark[data-brush]');
    if (!svg) return;
    const layer = svg.querySelector('.bia-brushlayer');
    if (!layer) return;
    const ml = parseFloat(svg.dataset.ml) || 0;
    const iw = parseFloat(svg.dataset.iw) || 1;
    const n = parseInt(svg.dataset.n, 10) || 0;
    const mt = parseFloat(svg.dataset.mt) || 0;
    const ih = parseFloat(svg.dataset.ih) || 0;
    if (n <= 0) return;
    // Map a client-x to an hour index (0..n-1) using the SVG's own scale so it
    // works regardless of the rendered (responsive) width.
    const idxAt = (clientX) => {
      const box = svg.getBoundingClientRect();
      if (!box.width) return 0;
      const vx = ((clientX - box.left) / box.width) * (iw + ml * 2); // → viewBox x
      const t = n <= 1 ? 0 : (vx - ml) / iw;
      return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
    };
    let dragging = false, startIdx = 0, liveBand = null, moved = false;
    const reduce = () => matchMedia('(prefers-reduced-motion:reduce)').matches;
    const drawLive = (i0, i1) => {
      const a = Math.min(i0, i1), b = Math.max(i0, i1);
      const half = Math.max(3, iw / n / 2);
      const xAt = (i) => ml + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
      const bx = xAt(a) - half;
      const bw = (xAt(b) + half) - bx;
      if (!liveBand) {
        liveBand = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        liveBand.setAttribute('class', 'bia-brush-live');
        liveBand.setAttribute('fill', accentAlpha(accent, 0.18));
        liveBand.setAttribute('stroke', accent);
        liveBand.setAttribute('stroke-width', '1');
        liveBand.setAttribute('rx', '2');
        liveBand.setAttribute('pointer-events', 'none');
        svg.appendChild(liveBand);
      }
      liveBand.setAttribute('x', bx.toFixed(1));
      liveBand.setAttribute('y', mt.toFixed(1));
      liveBand.setAttribute('width', Math.max(0, bw).toFixed(1));
      liveBand.setAttribute('height', ih.toFixed(1));
    };
    const clearLive = () => { if (liveBand && liveBand.parentNode) liveBand.parentNode.removeChild(liveBand); liveBand = null; };
    const onMove = (e) => {
      if (!dragging) return;
      const i = idxAt(e.clientX);
      if (i !== startIdx) moved = true;
      if (!reduce()) drawLive(startIdx, i);
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      const i = idxAt(e.clientX);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      clearLive();
      // A real drag (>1 cell) commits a contiguous RANGE to the hour facet,
      // replacing any prior hour selection. A no-move "drag" (== click) is left to
      // the per-bar click handler, so we don't double-handle a single tap.
      if (!moved) return;
      const a = Math.min(startIdx, i), b = Math.max(startIdx, i);
      // index → hour via the bar that drew it (data-i carries the index).
      const hourOf = (idx) => {
        const bar = svg.querySelector(`.bia-pt[data-i="${idx}"][data-hr]`);
        return bar ? Number(bar.dataset.hr) : null;
      };
      const next = new Set();
      for (let k = a; k <= b; k += 1) { const hr = hourOf(k); if (hr != null) next.add(hr); }
      filterState.hour = next;             // replace with the brushed range
      render();
    };
    const onDown = (e) => {
      // primary button / touch / pen only
      if (e.button != null && e.button !== 0) return;
      dragging = true; moved = false;
      startIdx = idxAt(e.clientX);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      // capture an interim teardown so a re-render or dispose mid-drag removes the
      // document listeners and any live band (no leak, no stuck overlay).
      brushTeardowns.push(() => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        clearLive();
      });
    };
    // Attach to the SVG (not just the hit layer) so a pointerdown that lands on a
    // bar still starts a brush; bars keep their own click for single-hour taps
    // (a no-move drag commits nothing, so the tap's click is the sole handler).
    svg.addEventListener('pointerdown', onDown);
    brushTeardowns.push(() => svg.removeEventListener('pointerdown', onDown));
  }

  function dur3ms() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--dur-3').trim();
    if (v.endsWith('ms')) return parseFloat(v) || 200;
    if (v.endsWith('s')) return (parseFloat(v) || 0.2) * 1000;
    return 200;
  }
  // Read current ABC bar + heatmap cell geometry into a lookup keyed by data-attr.
  function snapshotMarks() {
    const bars = {};
    root.querySelectorAll('rect.bia-bar[data-sku]').forEach((b) => {
      bars[b.dataset.sku] = { y: parseFloat(b.getAttribute('y')), h: parseFloat(b.getAttribute('height')) };
    });
    const cells = {};
    root.querySelectorAll('.bia-tcell[data-wd]').forEach((c) => {
      cells[c.dataset.wd] = c.style.background || '';
    });
    return { bars, cells };
  }
  // Parse the trailing alpha out of an "rgba(r,g,b,a)" string (cell intensity).
  function rgbaAlpha(s) {
    const m = /rgba?\([^)]*,\s*([0-9.]+)\s*\)/.exec(s || '');
    return m ? parseFloat(m[1]) : null;
  }
  function setRgbaAlpha(s, a) {
    return (s || '').replace(/(rgba?\([^)]*,\s*)[0-9.]+(\s*\))/, `$1${a.toFixed(3)}$2`);
  }
  function tweenMarks(snap) {
    if (matchMedia('(prefers-reduced-motion:reduce)').matches) return;
    // build animation plan from new marks that also existed in the snapshot
    const plan = [];
    root.querySelectorAll('rect.bia-bar[data-sku]').forEach((b) => {
      const from = snap.bars[b.dataset.sku]; if (!from) return;
      const toY = parseFloat(b.getAttribute('y')), toH = parseFloat(b.getAttribute('height'));
      if (from.y === toY && from.h === toH) return;
      plan.push({ kind: 'bar', el: b, fromY: from.y, fromH: from.h, toY, toH });
    });
    root.querySelectorAll('.bia-tcell[data-wd]').forEach((c) => {
      const fromBg = snap.cells[c.dataset.wd]; if (fromBg == null) return;
      const fa = rgbaAlpha(fromBg), ta = rgbaAlpha(c.style.background);
      if (fa == null || ta == null || fa === ta) return;
      plan.push({ kind: 'cell', el: c, fromA: fa, toA: ta, tmpl: c.style.background });
    });
    if (!plan.length) return;
    // seed marks at their FROM state, then rAF-lerp to the TRUE (final) state.
    plan.forEach((p) => {
      if (p.kind === 'bar') { p.el.setAttribute('y', p.fromY); p.el.setAttribute('height', p.fromH); }
      else { p.el.style.background = setRgbaAlpha(p.tmpl, p.fromA); }
    });
    const dur = dur3ms();
    const t0 = performance.now();
    if (tweenRAF) cancelAnimationFrame(tweenRAF);
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);   // easeOutCubic
      plan.forEach((p) => {
        if (p.kind === 'bar') {
          p.el.setAttribute('y', (p.fromY + (p.toY - p.fromY) * e).toFixed(1));
          p.el.setAttribute('height', (p.fromH + (p.toH - p.fromH) * e).toFixed(1));
        } else {
          p.el.style.background = setRgbaAlpha(p.tmpl, p.fromA + (p.toA - p.fromA) * e);
        }
      });
      if (k < 1) tweenRAF = requestAnimationFrame(step);
      else tweenRAF = 0;
    };
    tweenRAF = requestAnimationFrame(step);
  }

  // stagger fade-in: mirror of analysis.js .an-in/.an-settled idiom (no import).
  // Runs once per data load; filter/theme re-renders skip it to avoid re-flashing.
  function enterAnimate() {
    if (animatedOnce) return;
    animatedOnce = true;
    const reduce = matchMedia('(prefers-reduced-motion:reduce)').matches;
    const items = Array.from(root.querySelectorAll('.bia-ins, .bia-chart'));
    items.forEach((n) => n.classList.add('bia-anim'));
    if (reduce) { items.forEach((n) => n.classList.add('bia-in', 'bia-settled')); return; }
    requestAnimationFrame(() => {
      items.forEach((n, i) => {
        window.setTimeout(() => {
          n.classList.add('bia-in');
          n.addEventListener('transitionend', function once() {
            n.classList.add('bia-settled');
            n.removeEventListener('transitionend', once);
          });
        }, i * 40);
      });
    });
  }

  function insCard(c) {
    return `<div class="bia-card" data-go="${c.sec}">
      <div class="kic">${esc(c.kic)}</div>
      <div class="fact">${c.fact}</div>
      <div class="imp">${esc(c.imp)}</div>
      <div class="bia-drill">
        <a data-nav="bi" role="link" tabindex="0">物量BIで見る →</a>
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

  // Single delegated click handler on root for every [data-ex] (chips +
  // inline "近い質問" suggestions) — avoids re-binding per question/chip.
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
    // drill links fire `whsim:nav` and must not bubble into the card's focus()
    root.querySelectorAll('[data-nav]').forEach((a) => {
      const go = (e) => { e.stopPropagation(); e.preventDefault(); nav(a.dataset.nav); };
      a.onclick = go;
      a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
    });
  }

  function wireCharts() {
    // ABC bars: tooltip + click → cross-filter on that SKU
    root.querySelectorAll('.bia-bar').forEach((b) => {
      // look the row up against the SAME array that drew the bar (default abc OR
      // the re-ranked rows) so data-i stays valid after a weekday re-rank.
      const rowOf = () => lastParetoRows[+b.dataset.i];
      b.addEventListener('mousemove', (e) => {
        const r = rowOf(); if (!r) return;
        showTip(`<b>${esc(r.name || r.sku)}</b><br>物量 <span class="n">${fmt(r.qty)}</span> · 累積 <span class="n">${pct(r.cum || 0)}</span>`, e);
      });
      b.addEventListener('mouseleave', hideTip);
      // Clicking a bar pins that SKU (in-chart highlight) AND maps it to its rank
      // so the selection PROPAGATES (xtab is rank-level). Plain click re-pins a
      // single rank; shift/ctrl/cmd ADDS the rank to the multi-select set. Re-
      // clicking the same SKU clears the pin (and removes its rank). Never sticks.
      b.addEventListener('click', (e) => {
        hideTip();
        const r = rowOf(); if (!r) return;
        const sku = b.dataset.sku;
        const rk = rankOf(r);
        const additive = isAdditive(e);
        if (filterState.abc === sku) {        // toggle off this pinned sku
          filterState.abc = null;
          filterState.rank.delete(rk);
        } else {                              // pin sku + propagate its rank
          filterState.abc = sku;
          if (additive) filterState.rank.add(rk);
          else { filterState.rank.clear(); filterState.rank.add(rk); }
        }
        render();
      });
    });
    // ABC legend ranks: click → cross-filter on rank A/B/C
    root.querySelectorAll('.bia-leg').forEach((l) => {
      const go = (e) => toggleFilter('rank', l.dataset.rank, isAdditive(e));
      l.addEventListener('click', go);
      // Enter/Space toggle single; Shift+Enter (or Ctrl/Cmd) add to the set.
      l.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } });
    });
    // weekday cells: tooltip + click → cross-filter on that weekday
    root.querySelectorAll('.bia-cell').forEach((c) => {
      c.addEventListener('mousemove', (e) => {
        const [lab, q] = (c.dataset.hd || '|').split('|');
        showTip(`<b>${esc(lab)}曜</b> · <span class="n">${fmt(+q)}</span>`, e);
      });
      c.addEventListener('mouseleave', hideTip);
      // data-wd is the numeric xtab weekday index (0..6) as a string; coerce to a
      // Number so it joins cleanly against c.weekday in filteredCells(). Empty =>
      // unknown weekday (no xtab match) -> skip toggling.
      const go = (e) => {
        hideTip();
        const wd = c.dataset.wd;
        if (wd === '' || wd == null) return;
        toggleFilter('weekday', Number(wd), isAdditive(e));
      };
      c.addEventListener('click', go);
      // Enter/Space toggle single; Shift+Enter (or Ctrl/Cmd) add to the set.
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } });
    });
    // time-series hover hotspots (daily area + hourly spark). Hourly hotspots
    // (data-hr) additionally toggle the hour facet → re-aggregates weekday +
    // insights + ABC overlay via xtab; daily hotspots stay hover-only.
    root.querySelectorAll('.bia-pt').forEach((p) => {
      p.addEventListener('mousemove', (e) => {
        const [lab, q] = (p.dataset.pt || '|').split('|');
        showTip(`<b>${esc(lab)}</b> · <span class="n">${fmt(+q)}</span>`, e);
      });
      p.addEventListener('mouseleave', hideTip);
      if (p.dataset.hr != null && p.dataset.hr !== '') {
        const go = (e) => { hideTip(); toggleFilter('hour', Number(p.dataset.hr), isAdditive(e)); };
        p.addEventListener('click', go);
        // Enter/Space toggle single; Shift+Enter (or Ctrl/Cmd) add to the set.
        p.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } });
      }
    });
  }

  function wireFilterBar() {
    // each pill's ✕ removes only ITS value: a set-facet pill carries data-val and
    // removes that one member (weekday/hour vals are numeric in the Set, so coerce
    // the string back); the abc pill (no data-val) clears the whole abc facet.
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

  // ── example placeholder rotation (gated: one-shot per visit, NOT a loop) ─
  // Single 5s rotation through examples; stops after one full pass to honour the
  // "no idle loops" rule and is skipped entirely under reduced-motion.
  function startExampleRotation() {
    if (matchMedia('(prefers-reduced-motion:reduce)').matches) return;
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

  // click-away clears an active hour brush: a click inside this view that is NOT
  // on an interactive mark / pill / question UI drops the hour facet. Registered
  // once on document and removed in dispose() (never per-render → no duplicates).
  function onClickAway(e) {
    if (!facetActive('hour')) return;
    const t = e.target;
    if (!el.contains(t)) return;                       // clicks elsewhere ignored
    // ignore clicks on anything interactive so we don't fight the real handlers
    if (t.closest && t.closest('.bia-pt,.bia-bar,.bia-cell,.bia-leg,.bia-pill,'
      + '.bia-fclear,.bia-chip,.bia-spark,.bia-ask,.bia-card,.bia-drill a,[data-ex]')) return;
    filterState.hour.clear();
    render();
  }
  document.addEventListener('click', onClickAway);

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
      render();   // render() shows the 再試行 error state (never a stuck spinner)
      toast('分析BIの読み込みに失敗', 'error');
    }
  }

  load();
  return {
    refresh() {
      data = null;
      loadErr = null;
      animatedOnce = false;                 // re-animate next load
      filterState = freshFilterState();      // drop ALL stale facets (fresh empty Sets)
      render();
      load();
    },
    dispose() {
      stopRotation();
      if (tweenRAF) { cancelAnimationFrame(tweenRAF); tweenRAF = 0; }
      teardownBrush();   // detach brush pointerdown + any in-flight drag listeners
      document.removeEventListener('click', onClickAway);
      document.removeEventListener('keydown', onSlash);
      document.removeEventListener('themechange', onThemeChange);
      if (tip.parentNode) tip.parentNode.removeChild(tip);
      el.innerHTML = '';
    },
  };
}
