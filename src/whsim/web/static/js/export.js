// export.js — proposal / export panel for a finished run.
//
// Inspired by Megasoft Logi3D's "見積もりを3DCG化した営業ツール" and its
// 動線一覧CSV: turn a completed simulation into client-ready outputs —
// KPI CSV, a 動線一覧 (flow-line) CSV, and a printable 提案書 (proposal)
// preview built from the proposal PNG + KPI summary.
//
// Public API:
//   new ExportView(container, { getProjectName })  — build UI into `container`
//   view.refresh()                                  — re-read state, re-render
//   view.dispose()                                  — tear down + detach
//
// Self-contained ES module, no imports. Defensive throughout: missing fields
// render as "—"; absent project/run shows a friendly placeholder; empty
// keyframes contribute 0.

// ---- scoped style injection -------------------------------------------------
//
// A single <style> tag, keyed by a unique id, scoped entirely under `#export`
// so it cannot leak into the rest of the dark app chrome. Purely additive: it
// restyles the existing DOM produced below (no markup/behaviour changes) to
// match the V3 proposal mock — white printable proposal sheet, quiet dark
// export cards, one accented verdict bar, tabular numerics, and a single
// once-on-enter motion pass that fully stops under reduced-motion.

const EXPORT_STYLE_ID = 'whsim-export-style-v3';

function injectStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(EXPORT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = EXPORT_STYLE_ID;
  style.textContent = EXPORT_CSS;
  document.head.appendChild(style);
}

// All rules are namespaced under `#export` (the mount container) so nothing
// here affects the dark app shell. Motion uses transform/opacity only.
const EXPORT_CSS = `
#export {
  /* Chrome tracks the app theme: alias the private vars to the shell tokens
     so the export panel is theme-aware (dark/light) rather than fixed. */
  --x-ease-out: var(--ease-out);
  --x-ease-in: cubic-bezier(.4,0,1,1);
  --x-dur-1: var(--dur-1);
  --x-dur-2: var(--dur-2);
  --x-dur-3: var(--dur-3);

  --x-panel: var(--bg-app);
  --x-panel-2: var(--bg-sunken);
  --x-ink-0: var(--ink-primary);
  --x-ink-1: var(--ink-secondary);
  --x-ink-2: var(--ink-tertiary);
  --x-line: var(--line-hair);
  --x-line-strong: var(--line-strong);
  --x-cyan: var(--accent);
  /* One reusable cyan channel: rgb(var(--x-cyan-rgb)/.NN) for tints/glows. */
  --x-cyan-rgb: 52 227 255;
  --x-cyan-hi: #7EF6FF;
  --x-tech: #2F7BFF;
  --x-deep: #0C5F86;

  /* Print-white proposal sheet palette stays local (intentionally not theme-aware). */
  --x-paper: #FFFFFF;
  --x-paper-ink-0: #0B1220;
  --x-paper-ink-1: #3D4A60;
  --x-paper-ink-2: #8593A8;
  --x-paper-line: #E7EBF1;
  --x-paper-line-2: #F0F2F6;
  --x-paper-tint: #F7F9FC;
  --x-ok-ink: #0E7A52;
  --x-warn-ink: #9A6212;
  --x-err-ink: #C0334C;
}
#export .export-view { display: block; }
#export .tnum, #export .num { font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }

/* ---- export panel: dark, quiet card grid ---- */
#export .export-panel {
  border: 1px solid var(--x-line);
  border-radius: 12px;
  background: var(--x-panel);
  padding: 16px;
  margin: 0 auto 18px;
  max-width: 794px;
}
#export .export-head { margin-bottom: 12px; }
#export .export-h2 {
  font-size: 14px; letter-spacing: 0.04em; font-weight: 600;
  margin: 0 0 3px; color: var(--x-ink-0);
}
#export .export-desc { font-size: 11.5px; color: var(--x-ink-2); margin: 0; line-height: 1.5; }

#export .export-actions { display: grid; grid-template-columns: 1fr; gap: 8px; }
#export .export-actions-secondary {
  display: flex; flex-wrap: wrap; gap: 8px;
  margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--x-line);
}

/* document download buttons styled as quiet cards */
#export .export-doc-btn {
  display: flex; align-items: center; gap: 10px;
  width: 100%; text-align: left;
  border: 1px solid var(--x-line); border-radius: 8px;
  background: rgba(255,255,255,0.015);
  color: var(--x-ink-0);
  padding: 11px 13px; font: inherit; font-size: 13px; font-weight: 500;
  cursor: pointer; position: relative;
  transition:
    border-color var(--x-dur-1) var(--x-ease-out),
    background var(--x-dur-1) var(--x-ease-out),
    box-shadow var(--x-dur-1) var(--x-ease-out),
    transform var(--x-dur-1) var(--x-ease-out);
}
#export .export-doc-btn::before {
  content: ""; width: 8px; height: 8px; flex-shrink: 0; border-radius: 2px;
  background: var(--x-panel-2); border: 1px solid var(--x-line-strong);
  box-shadow: 0 0 0 0 rgb(var(--x-cyan-rgb)/0);
  transition: box-shadow var(--x-dur-1) var(--x-ease-out), border-color var(--x-dur-1) var(--x-ease-out);
}
@media (hover: hover) {
  #export .export-doc-btn:hover {
    border-color: rgb(var(--x-cyan-rgb)/0.35);
    background: rgb(var(--x-cyan-rgb)/0.035);
    transform: translateY(-1px);
  }
  #export .export-doc-btn:hover::before {
    border-color: rgb(var(--x-cyan-rgb)/0.45);
    box-shadow: 0 0 10px rgb(var(--x-cyan-rgb)/0.55);
  }
}
#export .export-doc-btn:active { transform: scale(.98); transition-timing-function: var(--x-ease-in); }
#export .export-doc-btn:focus-visible { outline: 2px solid var(--line-focus); outline-offset: 2px; }
#export .export-doc-btn[disabled] { cursor: default; opacity: 0.85; transform: none; }

/* primary download: the one restrained cyan accent in the dark card grid */
#export .export-doc-btn.primary {
  color: #04121A; font-weight: 600;
  background: linear-gradient(180deg, var(--x-cyan-hi), var(--x-cyan));
  border-color: transparent;
  box-shadow: 0 0 0 1px rgb(var(--x-cyan-rgb)/0.35), 0 6px 16px rgb(var(--x-cyan-rgb)/0.16);
}
#export .export-doc-btn.primary::before {
  background: rgba(4,18,26,0.18); border-color: rgba(4,18,26,0.25);
}
@media (hover: hover) {
  #export .export-doc-btn.primary:hover { filter: brightness(1.06); transform: translateY(-1px); }
}

/* secondary link-style actions */
#export .export-link-btn {
  border: 1px solid var(--x-line); border-radius: 7px;
  background: transparent; color: var(--x-ink-1);
  padding: 7px 12px; font: inherit; font-size: 12px; cursor: pointer;
  transition:
    border-color var(--x-dur-1) var(--x-ease-out),
    color var(--x-dur-1) var(--x-ease-out),
    background var(--x-dur-1) var(--x-ease-out),
    transform var(--x-dur-1) var(--x-ease-out);
}
@media (hover: hover) {
  #export .export-link-btn:hover {
    border-color: rgb(var(--x-cyan-rgb)/0.32); color: var(--x-cyan-hi);
    background: rgb(var(--x-cyan-rgb)/0.04);
  }
}
#export .export-link-btn:active { transform: scale(.98); transition-timing-function: var(--x-ease-in); }
#export .export-link-btn:focus-visible { outline: 2px solid var(--line-focus); outline-offset: 2px; }

/* optimistic press feedback on doc buttons (visual only) */
#export .export-doc-btn[data-busy="1"]::before { box-shadow: 0 0 10px rgb(var(--x-cyan-rgb)/0.55); }

#export .spinner {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.25); border-top-color: currentColor;
  display: inline-block; vertical-align: -2px; margin-right: 7px;
  animation: x-spin 700ms linear infinite;
}
#export .export-doc-btn.primary .spinner { border-color: rgba(4,18,26,0.30); border-top-color: #04121A; }
@keyframes x-spin { to { transform: rotate(360deg); } }

#export .export-empty, #export .export-loading {
  max-width: 794px; margin: 0 auto;
  border: 1px solid var(--x-line); border-radius: 12px;
  background: var(--x-panel);
}

/* ---- proposal sheet: white, printable ---- */
#export .proposal-sheet {
  font-variant-numeric: tabular-nums;
}
#export .proposal-sheet::before {
  content: ""; position: absolute; inset: 0 0 auto 0; height: 3px;
  background: linear-gradient(90deg, var(--x-cyan), var(--x-tech) 60%, var(--x-deep));
  border-radius: 10px 10px 0 0;
}
#export .proposal-sheet { position: relative; }
#export .proposal-title { letter-spacing: -0.02em; }

/* verdict bar — the single page accent, with a left rule that grows on enter */
#export .proposal-verdict { position: relative; overflow: hidden; }
#export .proposal-verdict::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0;
  width: 3px; border-radius: 8px 0 0 8px;
  background: currentColor; opacity: 0.55;
  transform: scaleX(1); transform-origin: left center;
}

/* ============================================================
   Proposal sheet typography + document structure (mock-aligned)
   Purely additive: lifts body type to 14px/1.6, gives sections an
   uppercase ruled heading, and adds a KPI card grid. No markup the
   public API depends on changes.
   ============================================================ */
#export .proposal-sheet {
  font-size: 14px; line-height: 1.6; color: var(--x-paper-ink-1);
}
#export .proposal-sheet b { color: var(--x-paper-ink-0); }

/* document header: logo · title · meta column */
#export .doc-head {
  display: flex; align-items: flex-start; gap: 16px;
  padding-bottom: 20px; margin-bottom: 4px;
  border-bottom: 1px solid var(--x-paper-line);
}
#export .doc-logo {
  width: 48px; height: 48px; flex-shrink: 0;
  border: 1.5px dashed #C9D1DE; border-radius: 8px;
  display: grid; place-items: center;
  color: var(--x-paper-ink-2); font-size: 9px;
  text-align: center; line-height: 1.2; letter-spacing: 0.04em;
}
#export .doc-title { min-width: 0; }
#export .doc-meta {
  margin-left: auto; text-align: right;
  font-size: 11px; color: var(--x-paper-ink-2); line-height: 1.85;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
#export .doc-meta b { color: var(--x-paper-ink-0); font-weight: 700; }

/* section block + ruled, uppercase heading */
#export .proposal-section { margin-top: 28px; }
#export .sec-title {
  font-size: 11px; letter-spacing: 0.13em; text-transform: uppercase;
  color: var(--x-paper-ink-2); font-weight: 600;
  margin: 0 0 12px;
  display: flex; align-items: center; gap: 10px;
}
#export .sec-title > span:first-child { letter-spacing: -0.01em; }
#export .sec-title::after { content: ""; flex: 1; height: 1px; background: var(--x-paper-line-2); }

/* KPI card grid (replaces the bare 2-column table) */
#export .kpi-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
}
#export .kpi-card {
  border: 1px solid var(--x-paper-line); border-radius: 9px;
  padding: 12px 13px; background: var(--x-paper);
}
#export .kpi-card .k-label {
  font-size: 10.5px; color: var(--x-paper-ink-2);
  margin-bottom: 5px; letter-spacing: 0.02em;
}
#export .kpi-card .k-val {
  font-variant-numeric: tabular-nums;
  font-size: 22px; font-weight: 700; color: var(--x-paper-ink-0); line-height: 1.05;
}
#export .kpi-card .k-val .u {
  font-size: 11px; font-weight: 400; color: var(--x-paper-ink-2); margin-left: 3px;
}
#export .kpi-card .k-sub {
  font-size: 10.5px; margin-top: 5px; font-variant-numeric: tabular-nums;
  color: var(--x-paper-ink-2);
}
@media (max-width: 560px) { #export .kpi-grid { grid-template-columns: repeat(2, 1fr); } }

/* scenario comparison: right-aligned tabular numerics */
#export table.proposal-scn { width: 100%; border-collapse: collapse; font-size: 12px; }
#export table.proposal-scn th,
#export table.proposal-scn td {
  text-align: right; padding: 9px 12px; border-bottom: 1px solid var(--x-paper-line-2);
}
#export table.proposal-scn th:first-child,
#export table.proposal-scn td:first-child { text-align: left; }
#export table.proposal-scn thead th {
  font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--x-paper-ink-2); font-weight: 600;
  border-bottom: 1px solid var(--x-paper-line);
}
#export table.proposal-scn td.num {
  font-variant-numeric: tabular-nums; color: var(--x-paper-ink-0);
}
#export table.proposal-scn tbody tr:last-child td { border-bottom: none; }
#export table.proposal-scn tr.hi td { background: rgba(52,227,255,0.06); }
#export table.proposal-scn tr.hi td:first-child { color: var(--x-deep); font-weight: 600; }
#export table.proposal-scn tr.hi td.num { color: var(--x-deep); font-weight: 700; }

/* provenance footer mini-bar (only rendered when a value exists) */
#export .prov-foot {
  margin-top: 18px; border-top: 1px solid var(--x-paper-line); padding-top: 14px;
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  font-size: 10.5px; color: var(--x-paper-ink-2);
}
#export .prov-foot .lbl { letter-spacing: 0.04em; white-space: nowrap; }
#export .prov-bar {
  flex: 1; min-width: 120px; height: 8px; border-radius: 4px; overflow: hidden;
  display: flex; border: 1px solid var(--x-paper-line);
}
#export .prov-bar .real { background: var(--x-cyan); }
#export .prov-bar .est { background: #DCE2EC; }
#export .prov-legend { display: flex; gap: 14px; }
#export .prov-legend span { display: flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; }
#export .prov-legend i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }

/* ============================================================
   Entrance choreography — once on enter, transform/opacity only
   ============================================================ */
@keyframes x-sheet-in {
  0%   { opacity: 0; transform: translateY(8px) scale(1); }
  70%  { opacity: 1; transform: translateY(0) scale(1.005); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes x-fade-up {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes x-rule-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }

#export .export-view.is-anim .export-panel {
  opacity: 0; will-change: opacity, transform;
  animation: x-fade-up var(--x-dur-3) var(--x-ease-out) both;
}
#export .export-view.is-anim .proposal-sheet {
  opacity: 0; will-change: opacity, transform;
  animation: x-sheet-in var(--x-dur-3) var(--x-ease-out) 60ms both;
}
#export .export-view.is-anim .proposal-verdict::before {
  transform: scaleX(0);
  animation: x-rule-grow var(--x-dur-3) var(--x-ease-out) 260ms both;
}
#export .export-view.is-anim .kpi-card,
#export .export-view.is-anim table.proposal-scn tbody tr {
  opacity: 0; will-change: opacity, transform;
  animation: x-fade-up var(--x-dur-3) var(--x-ease-out) both;
  animation-delay: var(--x-stagger, 0ms);
}

@media (prefers-reduced-motion: reduce) {
  #export *, #export *::before, #export *::after {
    transition: none !important; animation: none !important;
  }
  #export .export-view.is-anim .export-panel,
  #export .export-view.is-anim .proposal-sheet,
  #export .export-view.is-anim .kpi-card,
  #export .export-view.is-anim table.proposal-scn tbody tr { opacity: 1 !important; transform: none !important; }
  #export .export-view.is-anim .proposal-verdict::before { transform: scaleX(1) !important; }
  #export .spinner { animation: none !important; }
}
`;

// ---- formatting helpers ----------------------------------------------------

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Yen with thousands separators.
function yen(v, decimals = 0) {
  if (!isNum(v)) return '—';
  const fixed = v.toFixed(decimals);
  const [intPart, frac] = fixed.split('.');
  const sign = intPart.startsWith('-') ? '-' : '';
  const digits = sign ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '¥' + sign + grouped + (frac ? '.' + frac : '');
}

function num(v, decimals = 0) {
  if (!isNum(v)) return '—';
  return v.toFixed(decimals);
}

function minutes(seconds, decimals = 1) {
  if (!isNum(seconds)) return '—';
  return (seconds / 60).toFixed(decimals) + '分';
}

// Headcount: explicit `headcount`, else sum of staffing counts.
function headcountOf(k) {
  if (isNum(k.headcount)) return k.headcount;
  const parts = [k.n_pickers, k.n_packers, k.n_agvs].filter(isNum);
  if (!parts.length) return null;
  return parts.reduce((a, b) => a + b, 0);
}

// completion_rate as a fraction (0–1) if derivable, else null.
function completionFraction(k) {
  if (isNum(k.completion_rate)) return Math.abs(k.completion_rate) <= 1 ? k.completion_rate : k.completion_rate / 100;
  if (isNum(k.orders_completed) && isNum(k.orders_arrived) && k.orders_arrived > 0) {
    return k.orders_completed / k.orders_arrived;
  }
  return null;
}

// ---- CSV building -----------------------------------------------------------

// Quote a CSV field per RFC 4180 when it contains comma/quote/newline.
function csvField(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(cells) {
  return cells.map(csvField).join(',');
}

// Manhattan distance between two keyframes [t,x,y,state].
function manhattan(a, b) {
  const ax = isNum(a && a[1]) ? a[1] : 0;
  const ay = isNum(a && a[2]) ? a[2] : 0;
  const bx = isNum(b && b[1]) ? b[1] : 0;
  const by = isNum(b && b[2]) ? b[2] : 0;
  return Math.abs(bx - ax) + Math.abs(by - ay);
}

// Per-mover flow-line stats from a list of keyframes.
function moverStats(keyframes) {
  const kf = Array.isArray(keyframes) ? keyframes : [];
  if (!kf.length) return { distance: 0, duration: 0, legs: 0 };
  let distance = 0;
  let legs = 0;
  for (let i = 1; i < kf.length; i += 1) {
    const d = manhattan(kf[i - 1], kf[i]);
    if (d > 0) {
      distance += d;
      legs += 1;
    }
  }
  const first = kf[0];
  const last = kf[kf.length - 1];
  const t0 = isNum(first && first[0]) ? first[0] : 0;
  const t1 = isNum(last && last[0]) ? last[0] : 0;
  return { distance, duration: Math.max(0, t1 - t0), legs };
}

// ---- view -------------------------------------------------------------------

export class ExportView {
  constructor(container, opts) {
    this.container = container;
    this.opts = opts && typeof opts === 'object' ? opts : {};
    this.root = null;
    this.replay = null;
    this.pngUrl = null;
    this._objectUrls = [];
    this._reqToken = 0;
    this._motionTimers = [];
    injectStyle();
    this.refresh();
  }

  // Once-on-enter motion: arm CSS entrance animations on the live DOM, assign
  // stagger delays to the summary-table rows, and count up the already-rendered
  // numeric cells. Fully no-ops under reduced-motion (final values stay put).
  _armMotion() {
    const root = this.root;
    if (!root) return;
    let reduce = false;
    try {
      reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_e) { /* ignore */ }
    if (reduce) return;

    // Stagger the entering groups ~36ms apart, after the sheet rises: KPI cards
    // first, then the (optional) summary table rows / scenario rows.
    const cards = root.querySelectorAll('.kpi-card');
    cards.forEach((el, i) => { el.style.setProperty('--x-stagger', (300 + i * 36) + 'ms'); });
    const base = 300 + cards.length * 36;
    const rows = root.querySelectorAll('table.proposal-scn tbody tr');
    rows.forEach((tr, i) => { tr.style.setProperty('--x-stagger', (base + i * 36) + 'ms'); });

    root.classList.add('is-anim');

    // Settle: clear will-change once the entrance is done.
    const settle = base + rows.length * 36 + 320;
    this._motionTimers.push(window.setTimeout(() => {
      root.querySelectorAll('.export-panel, .proposal-sheet, .kpi-card, table.proposal-scn tbody tr')
        .forEach((el) => { el.style.willChange = 'auto'; });
    }, settle));

    // Count-up the already-rendered numeric cells (<=600ms, ease-out).
    this._motionTimers.push(window.setTimeout(() => this._countUpAll(), 260));
  }

  // rAF count-up over any element carrying a finished numeric string. We parse
  // the rendered text (keeping prefix like ¥ and suffix like 件/時) so the final
  // text is unchanged; we only animate from 0 -> value visually.
  _countUpAll() {
    const root = this.root;
    if (!root) return;
    const cells = root.querySelectorAll('[data-x-count]');
    cells.forEach((el) => this._countUp(el));
  }

  _countUp(el) {
    const target = parseFloat(el.getAttribute('data-x-count'));
    if (!Number.isFinite(target)) return;
    const dec = parseInt(el.getAttribute('data-x-dec') || '0', 10);
    const group = el.getAttribute('data-x-group') === '1';
    const prefix = el.getAttribute('data-x-prefix') || '';
    const suffix = el.getAttribute('data-x-suffix') || '';
    const final = el.textContent;
    const easeOut = (t) => 1 - Math.pow(1 - t, 3);
    const fmt = (v) => {
      let s = v.toFixed(dec);
      if (group) {
        const parts = s.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        s = parts.join('.');
      }
      return prefix + s + suffix;
    };
    const dur = 600;
    let start = null;
    const frame = (ts) => {
      if (!this.root) return; // disposed mid-flight
      if (start === null) start = ts;
      const p = Math.min(1, (ts - start) / dur);
      el.textContent = fmt(target * easeOut(p));
      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        el.textContent = final; // restore exact rendered string
      }
    };
    requestAnimationFrame(frame);
  }

  _projectName() {
    try {
      const fn = this.opts.getProjectName;
      const n = typeof fn === 'function' ? fn() : null;
      return (typeof n === 'string' && n.trim()) ? n.trim() : null;
    } catch (_e) {
      return null;
    }
  }

  refresh() {
    const name = this._projectName();
    const token = (this._reqToken += 1);

    this._clearRoot();
    const root = document.createElement('div');
    root.className = 'export-view';
    root.style.fontFamily = 'inherit';
    root.style.color = 'var(--ink-primary)';
    this.container.appendChild(root);
    this.root = root;

    if (!name) {
      this._renderPlaceholder('実行後にエクスポートできます。');
      return;
    }

    this._renderLoading();

    fetch(`/api/projects/${encodeURIComponent(name)}/replay`, { headers: { Accept: 'application/json' } })
      .then((res) => {
        if (!res.ok) throw new Error('no-run');
        return res.json();
      })
      .then((replay) => {
        if (token !== this._reqToken) return; // superseded by a newer refresh
        this.replay = replay && typeof replay === 'object' ? replay : {};
        this.pngUrl = `/api/projects/${encodeURIComponent(name)}/png`;
        this._render(name);
      })
      .catch(() => {
        if (token !== this._reqToken) return;
        this.replay = null;
        this._renderPlaceholder('実行後にエクスポートできます。');
      });
  }

  _clearMotionTimers() {
    if (Array.isArray(this._motionTimers)) {
      this._motionTimers.forEach((t) => { try { clearTimeout(t); } catch (_e) { /* ignore */ } });
    }
    this._motionTimers = [];
  }

  _clearRoot() {
    this._clearMotionTimers();
    if (this.root && this.root.parentNode === this.container) {
      this.container.removeChild(this.root);
    }
    this.root = null;
    this._revokeUrls();
  }

  _revokeUrls() {
    this._objectUrls.forEach((u) => {
      try { URL.revokeObjectURL(u); } catch (_e) { /* ignore */ }
    });
    this._objectUrls = [];
  }

  _renderPlaceholder(message) {
    const p = document.createElement('p');
    p.className = 'export-empty';
    p.style.color = 'var(--ink-tertiary)';
    p.style.padding = '16px';
    p.textContent = message;
    this.root.appendChild(p);
  }

  _renderLoading() {
    const p = document.createElement('p');
    p.className = 'export-loading';
    p.style.color = 'var(--ink-secondary)';
    p.style.padding = '16px';
    p.textContent = '読み込み中…';
    this.root.appendChild(p);
  }

  _render(name) {
    // Clear loading text but keep root.
    this.root.textContent = '';
    this.root.classList.remove('is-anim');
    this.root.appendChild(this._buildExportPanel(name));
    this.root.appendChild(this._buildProposal(name));
    this._armMotion();
  }

  _toast(msg, kind) {
    try {
      const fn = this.opts.toast;
      if (typeof fn === 'function') fn(msg, kind);
    } catch (_e) { /* ignore */ }
  }

  // ---- "提案書を作成" panel ----

  _buildExportPanel(name) {
    const panel = document.createElement('section');
    panel.className = 'export-panel export-no-print';

    const head = document.createElement('div');
    head.className = 'export-head';
    const h = document.createElement('h2');
    h.className = 'export-h2';
    h.textContent = '提案書を作成';
    const desc = document.createElement('p');
    desc.className = 'export-desc';
    desc.textContent = '含まれる内容: KPIサマリ・レイアウト図・シナリオ比較・推奨アクション。';
    head.appendChild(h);
    head.appendChild(desc);
    panel.appendChild(head);

    // Primary document downloads (server-generated).
    const docs = document.createElement('div');
    docs.className = 'export-actions';
    docs.appendChild(this._docBtn('提案書をダウンロード (PPTX)', 'pptx', name, true));
    docs.appendChild(this._docBtn('提案書をダウンロード (PDF)', 'pdf', name, false));
    docs.appendChild(this._pngBtn('提案PNGを保存', name));
    docs.appendChild(this._viewerBtn(name));
    panel.appendChild(docs);

    // Secondary: data exports + print.
    const more = document.createElement('div');
    more.className = 'export-actions-secondary';
    more.appendChild(this._linkBtn('KPIをCSV出力', () => this._downloadKpiCsv(name)));
    more.appendChild(this._linkBtn('動線一覧をCSV出力', () => this._downloadRoutesCsv(name)));
    more.appendChild(this._linkBtn('簡易印刷', () => { try { window.print(); } catch (_e) { /* ignore */ } }));
    panel.appendChild(more);

    return panel;
  }

  // A primary document-download button with a busy/spinner state. Fetches the
  // file as a blob so we can show progress and surface errors as toasts
  // (window.open can't tell us whether generation failed).
  _docBtn(label, fmt, name, primary) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'export-doc-btn' + (primary ? ' primary' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => this._downloadDoc(btn, label, fmt, name));
    return btn;
  }

  async _downloadDoc(btn, label, fmt, name) {
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>生成中…';
    const url = `/api/projects/${encodeURIComponent(name)}/proposal.${fmt}`;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/octet-stream' } });
      if (!res.ok) {
        let detail = `生成に失敗しました (${res.status})`;
        try { const j = await res.json(); if (j && j.detail) detail = j.detail; } catch (_e) { /* ignore */ }
        throw new Error(detail);
      }
      const blob = await res.blob();
      const dl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dl;
      a.download = `${name}_提案書.${fmt}`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => { try { URL.revokeObjectURL(dl); } catch (_e) { /* ignore */ } }, 4000);
      this._toast(`提案書(${fmt.toUpperCase()})を作成しました。`, 'ok');
    } catch (err) {
      this._toast('提案書の作成に失敗しました: ' + (err && err.message ? err.message : ''), 'error');
    } finally {
      btn.dataset.busy = '';
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = label;
    }
  }

  // Download the proposal PNG (already produced by a run) as a file.
  _pngBtn(label, name) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'export-doc-btn';
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>保存中…';
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(name)}/png`);
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        const blob = await res.blob();
        const dl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = dl;
        a.download = `${name}_提案.png`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => { try { URL.revokeObjectURL(dl); } catch (_e) { /* ignore */ } }, 4000);
        this._toast('提案PNGを保存しました。', 'ok');
      } catch (err) {
        this._toast('PNGの保存に失敗しました: ' + (err && err.message ? err.message : ''), 'error');
      } finally {
        btn.dataset.busy = '';
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        btn.textContent = label;
      }
    });
    return btn;
  }

  // 共有ビューアHTML: a single self-contained, read-only HTML file the salesperson
  // can mail to the 荷主 — KPI cards, proposal PNG, scorecard, and a 2D replay
  // player, all inlined (no server, opens from file://).
  _viewerBtn(name) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'export-doc-btn';
    const label = '🔗 共有ビューアHTML';
    btn.textContent = label;
    btn.title = '単一HTMLファイル。メール添付でそのまま開けます（読み取り専用）';
    btn.addEventListener('click', async () => {
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>生成中…';
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(name)}/export/viewer`);
        if (!res.ok) throw new Error(`生成に失敗しました (${res.status})`);
        const blob = await res.blob();
        const dl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = dl;
        a.download = `${name}_共有ビューア.html`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => { try { URL.revokeObjectURL(dl); } catch (_e) { /* ignore */ } }, 4000);
        this._toast('共有ビューアHTMLを作成しました。', 'ok');
      } catch (err) {
        this._toast('共有ビューアの作成に失敗しました: ' + (err && err.message ? err.message : ''), 'error');
      } finally {
        btn.dataset.busy = '';
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        btn.textContent = label;
      }
    });
    // Descriptive note beneath the button (mail-attachable, read-only).
    const note = document.createElement('p');
    note.className = 'export-desc';
    note.style.margin = '2px 2px 0';
    note.textContent = '単一HTMLファイル。メール添付でそのまま開けます（読み取り専用）。';
    const wrap = document.createElement('div');
    wrap.appendChild(btn);
    wrap.appendChild(note);
    return wrap;
  }

  _linkBtn(label, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'export-link-btn';
    btn.textContent = label;
    btn.addEventListener('click', handler);
    return btn;
  }

  // ---- KPI CSV ----

  _kpiRows() {
    const k = (this.replay && this.replay.kpis && typeof this.replay.kpis === 'object') ? this.replay.kpis : {};
    const compFrac = completionFraction(k);
    const rows = [
      ['判定', (typeof k.verdict === 'string' && k.verdict) ? k.verdict : '—'],
      ['需要対応', k.can_handle_demand === true ? '可' : (k.can_handle_demand === false ? '不可' : '—')],
      ['スループット(件/時)', isNum(k.throughput_per_hr) ? num(k.throughput_per_hr, 1) : '—'],
      ['出荷完了数(件)', isNum(k.orders_completed) ? num(k.orders_completed, 0) : '—'],
      ['受注数(件)', isNum(k.orders_arrived) ? num(k.orders_arrived, 0) : '—'],
      ['出荷完了率(%)', compFrac != null ? (compFrac * 100).toFixed(1) : '—'],
      ['ボトルネック工程', (typeof k.bottleneck_jp === 'string' && k.bottleneck_jp) ? k.bottleneck_jp : '—'],
      ['ボトルネック稼働率(%)', isNum(k.bottleneck_utilization) ? pctVal(k.bottleneck_utilization, 1) : '—'],
      ['ピッカー稼働率(%)', isNum(k.picker_utilization) ? pctVal(k.picker_utilization, 1) : '—'],
      ['梱包稼働率(%)', isNum(k.packer_utilization) ? pctVal(k.packer_utilization, 1) : '—'],
      ['AGV稼働率(%)', isNum(k.agv_utilization) ? pctVal(k.agv_utilization, 1) : '—'],
      ['ピッカー数(名)', isNum(k.n_pickers) ? num(k.n_pickers, 0) : '—'],
      ['梱包員数(名)', isNum(k.n_packers) ? num(k.n_packers, 0) : '—'],
      ['AGV台数(台)', isNum(k.n_agvs) ? num(k.n_agvs, 0) : '—'],
      ['必要人員(名)', isNum(headcountOf(k)) ? num(headcountOf(k), 0) : '—'],
      ['サイクル中央値(秒)', isNum(k.cycle_p50_s) ? num(k.cycle_p50_s, 1) : '—'],
      ['サイクル95%ile(秒)', isNum(k.cycle_p95_s) ? num(k.cycle_p95_s, 1) : '—'],
      ['1件あたり歩行(m)', isNum(k.walk_per_order_m) ? num(k.walk_per_order_m, 1) : '—'],
      ['1件あたりコスト(円)', isNum(k.total_cost_per_order) ? num(k.total_cost_per_order, 1) : '—'],
      ['月間コスト(円)', isNum(k.monthly_cost) ? num(k.monthly_cost, 0) : '—'],
      ['人件費単価(円/人時)', isNum(k.labour_rate_per_hr) ? num(k.labour_rate_per_hr, 0) : '—'],
      ['初期投資(円)', isNum(k.capex_total) ? num(k.capex_total, 0) : '—'],
    ];
    return rows;
  }

  _downloadKpiCsv(name) {
    const lines = ['項目,値'];
    this._kpiRows().forEach((r) => { lines.push(csvRow(r)); });
    this._triggerDownload(lines.join('\r\n'), `${name}_kpi.csv`);
  }

  // ---- 動線一覧 CSV ----

  _routeData() {
    const r = this.replay || {};
    const workers = Array.isArray(r.workers) ? r.workers : [];
    const agvs = Array.isArray(r.agvs) ? r.agvs : [];
    const rows = [];
    let tDist = 0;
    let tDur = 0;
    let tLegs = 0;

    const collect = (list, kindJp, prefix) => {
      list.forEach((m, i) => {
        const mm = m && typeof m === 'object' ? m : {};
        const id = (mm.id != null && mm.id !== '') ? String(mm.id) : `${prefix}${i + 1}`;
        const s = moverStats(mm.keyframes);
        tDist += s.distance;
        tDur = Math.max(tDur, s.duration);
        tLegs += s.legs;
        rows.push([id, kindJp, s.distance.toFixed(1), s.duration.toFixed(1), String(s.legs)]);
      });
    };

    collect(workers, '作業員', 'W');
    collect(agvs, 'AGV', 'A');
    return { rows, total: { tDist, tDur, tLegs } };
  }

  _downloadRoutesCsv(name) {
    const { rows, total } = this._routeData();
    const lines = ['ID,種別,総移動距離(m),移動時間(秒),移動回数'];
    rows.forEach((r) => { lines.push(csvRow(r)); });
    lines.push(csvRow(['合計', '', total.tDist.toFixed(1), total.tDur.toFixed(1), String(total.tLegs)]));
    this._triggerDownload(lines.join('\r\n'), `${name}_routes.csv`);
  }

  // ---- download plumbing ----

  _triggerDownload(text, filename) {
    // UTF-8 BOM so Excel renders Japanese correctly.
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer revocation so the download can start.
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_e) { /* ignore */ } }, 4000);
  }

  // ---- 提案書 preview ----

  _buildProposal(name) {
    const r = this.replay || {};
    const meta = (r.meta && typeof r.meta === 'object') ? r.meta : {};
    const k = (r.kpis && typeof r.kpis === 'object') ? r.kpis : {};

    const sheet = document.createElement('section');
    sheet.className = 'export-proposal proposal-sheet';
    sheet.style.background = '#fff';
    sheet.style.color = '#1f2733';
    sheet.style.maxWidth = '794px'; // ~A4 at 96dpi
    sheet.style.margin = '0 auto';
    sheet.style.padding = '28px 32px';
    sheet.style.border = '1px solid var(--line, #e3e8ee)';
    sheet.style.borderRadius = '10px';
    sheet.style.boxShadow = '0 1px 4px rgba(0,0,0,.06)';

    // ---- Document header: logo · title block · meta column ----
    // Customer / project metadata is not carried in the replay payload, so those
    // rows render an honest em-dash placeholder rather than a fabricated value;
    // the warehouse name and an issue date (the only metadata we actually have)
    // are filled from real data.
    const whName = (typeof meta.name === 'string' && meta.name.trim()) ? meta.name.trim() : name;

    const head = document.createElement('div');
    head.className = 'doc-head';

    const logo = document.createElement('div');
    logo.className = 'doc-logo';
    logo.innerHTML = 'LOGO<br>WHSiM';
    head.appendChild(logo);

    const titleBox = document.createElement('div');
    titleBox.className = 'doc-title';
    const title = document.createElement('h1');
    title.className = 'proposal-title';
    title.textContent = `${whName} 倉庫運用 提案書`;
    title.style.fontSize = '22px';
    title.style.fontWeight = '700';
    title.style.margin = '0 0 4px';
    titleBox.appendChild(title);
    const sub = document.createElement('p');
    sub.className = 'proposal-subtitle';
    sub.style.fontSize = '12px';
    sub.style.color = 'var(--x-paper-ink-2)';
    sub.style.letterSpacing = '0.04em';
    sub.style.margin = '0';
    const dur = isNum(meta.duration_s) ? `シミュレーション ${(meta.duration_s / 3600).toFixed(1)}時間相当` : 'WAREHOUSE OPERATIONS PROPOSAL';
    sub.textContent = dur;
    titleBox.appendChild(sub);
    head.appendChild(titleBox);

    // Meta column: issue date is real (今日); customer/project are placeholders.
    const metaCol = document.createElement('div');
    metaCol.className = 'doc-meta';
    const issued = new Date().toISOString().slice(0, 10); // 発行日 (YYYY-MM-DD)
    const metaRow = (label, value) => {
      const row = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = value;
      row.appendChild(document.createTextNode(label + ' '));
      row.appendChild(b);
      return row;
    };
    metaCol.appendChild(metaRow('発行日', issued));
    metaCol.appendChild(metaRow('顧客名', '—'));
    metaCol.appendChild(metaRow('案件', '—'));
    head.appendChild(metaCol);
    sheet.appendChild(head);

    // Verdict headline
    const verdict = document.createElement('div');
    verdict.className = 'proposal-verdict';
    const ok = k.can_handle_demand;
    const good = ok === true || (ok == null && false);
    const bad = ok === false;
    verdict.textContent = (typeof k.verdict === 'string' && k.verdict) ? k.verdict : '—';
    verdict.style.fontSize = '17px';
    verdict.style.fontWeight = '700';
    verdict.style.padding = '12px 14px';
    verdict.style.borderRadius = '8px';
    verdict.style.margin = '24px 0 0';
    if (bad) {
      verdict.style.color = 'var(--bad, #b30000)';
      verdict.style.background = 'rgba(179,0,0,.07)';
      verdict.style.border = '1px solid rgba(179,0,0,.25)';
    } else if (good) {
      verdict.style.color = 'var(--ok, #1a7a3c)';
      verdict.style.background = 'rgba(26,122,60,.07)';
      verdict.style.border = '1px solid rgba(26,122,60,.25)';
    } else {
      verdict.style.color = 'var(--ink, #1f2733)';
      verdict.style.background = 'var(--surface, #f5f7fa)';
      verdict.style.border = '1px solid var(--line, #e3e8ee)';
    }
    sheet.appendChild(verdict);

    // KPI card grid — the bare 2-column table promoted to big-number cards.
    sheet.appendChild(this._section('主要KPI', this._buildKpiGrid(k)));

    // Proposal PNG
    if (this.pngUrl) {
      const figWrap = this._section('レイアウト縮図と混雑ヒートマップ', null);
      const fig = document.createElement('figure');
      fig.className = 'proposal-figure';
      fig.style.margin = '20px 0 0';
      const img = document.createElement('img');
      img.className = 'proposal-image';
      img.src = this.pngUrl;
      img.alt = `${whName} の提案図`;
      img.style.maxWidth = '100%';
      img.style.display = 'block';
      img.style.border = '1px solid var(--line, #e3e8ee)';
      img.style.borderRadius = '6px';
      img.addEventListener('error', () => { figWrap.style.display = 'none'; });
      fig.appendChild(img);
      figWrap.appendChild(fig);
      sheet.appendChild(figWrap);
    }

    // Scenario comparison — only when the replay actually carries scenarios
    // (this endpoint typically does not, so it stays absent rather than faked).
    const scn = this._buildScenarioTable(r);
    if (scn) sheet.appendChild(this._section('シナリオ比較', scn));

    // Footer assumptions
    const footer = document.createElement('p');
    footer.className = 'proposal-footer';
    footer.style.fontSize = '11px';
    footer.style.color = 'var(--muted, #6b7785)';
    footer.style.marginTop = '18px';
    footer.style.paddingTop = '10px';
    footer.style.borderTop = '1px solid var(--line, #e3e8ee)';
    const labour = isNum(k.labour_rate_per_hr) ? yen(k.labour_rate_per_hr, 0) + '/人時' : '—';
    const capex = isNum(k.capex_total) ? yen(k.capex_total, 0) : '—';
    footer.textContent = `前提: 人件費 ${labour}、AGV投資 ${capex}。本提案書はシミュレーション結果に基づく試算です。`;
    sheet.appendChild(footer);

    // Provenance mini-bar ("N% your data") — rendered only when a real value is
    // present in the replay payload; never fabricated.
    const prov = this._buildProvenanceFoot(r);
    if (prov) sheet.appendChild(prov);

    return sheet;
  }

  // A document section: ruled, uppercase heading + body. The first label span is
  // tracked so it can carry the tighter heading letter-spacing from CSS.
  _section(label, body) {
    const sec = document.createElement('section');
    sec.className = 'proposal-section';
    const h = document.createElement('div');
    h.className = 'sec-title';
    const span = document.createElement('span');
    span.textContent = label;
    h.appendChild(span);
    sec.appendChild(h);
    if (body) sec.appendChild(body);
    return sec;
  }

  // KPI card grid (repeat(3,1fr)): big mono value + label + sub-note. Only KPIs
  // that actually exist in the replay's kpis are emitted; the once-on-enter
  // count-up reuses the same data-x-* contract as the legacy summary table.
  _buildKpiGrid(k) {
    const compFrac = completionFraction(k);
    const compPctScaled = compFrac != null ? (Math.abs(compFrac) <= 1 ? compFrac * 100 : compFrac) : null;
    const hc = headcountOf(k);

    // [label, valueText, unit|null, sub|null, countMeta|null, present]
    const defs = [
      ['スループット',
        isNum(k.throughput_per_hr) ? num(k.throughput_per_hr, 1) : '—',
        '件/時',
        isNum(k.orders_completed) ? num(k.orders_completed, 0) + ' 件 完了' : null,
        isNum(k.throughput_per_hr) ? { value: k.throughput_per_hr, dec: 1 } : null,
        isNum(k.throughput_per_hr)],
      ['出荷完了率',
        compPctScaled != null ? compPctScaled.toFixed(1) : '—',
        '%',
        (isNum(k.orders_completed) && isNum(k.orders_arrived))
          ? num(k.orders_completed, 0) + ' / ' + num(k.orders_arrived, 0) + ' 件' : null,
        compPctScaled != null ? { value: compPctScaled, dec: 1 } : null,
        compPctScaled != null],
      ['1件あたりコスト',
        isNum(k.total_cost_per_order) ? num(k.total_cost_per_order, 0) : '—',
        '円/件',
        isNum(k.monthly_cost) ? '月間 ' + yen(k.monthly_cost, 0) : null,
        isNum(k.total_cost_per_order) ? { value: k.total_cost_per_order, dec: 0, group: true, prefix: '¥' } : null,
        isNum(k.total_cost_per_order)],
      ['必要人員',
        isNum(hc) ? num(hc, 0) : '—',
        '名',
        this._headcountSub(k),
        isNum(hc) ? { value: hc, dec: 0 } : null,
        isNum(hc)],
      ['投資回収',
        (isNum(k.payback_months) && k.payback_months > 0) ? num(k.payback_months, 1) : '—',
        'ヶ月',
        isNum(k.capex_total) && k.capex_total > 0 ? '投資 ' + yen(k.capex_total, 0) : null,
        (isNum(k.payback_months) && k.payback_months > 0) ? { value: k.payback_months, dec: 1 } : null,
        isNum(k.payback_months) && k.payback_months > 0],
      ['仮置き最大WIP',
        isNum(k.wip_max) ? num(k.wip_max, 0) : '—',
        'トート',
        isNum(k.staging_capacity) && k.staging_capacity > 0 ? '上限 ' + num(k.staging_capacity, 0) : null,
        isNum(k.wip_max) ? { value: k.wip_max, dec: 0 } : null,
        isNum(k.wip_max) && (k.staging_capacity == null || k.staging_capacity > 0)],
    ];

    const grid = document.createElement('div');
    grid.className = 'kpi-grid';
    defs.filter((d) => d[5]).forEach(([label, valueText, unit, sub, count]) => {
      const card = document.createElement('div');
      card.className = 'kpi-card';

      const lab = document.createElement('div');
      lab.className = 'k-label';
      lab.textContent = label;
      card.appendChild(lab);

      const val = document.createElement('div');
      val.className = 'k-val tnum';
      const prefix = count && count.prefix ? count.prefix : '';
      const valSpan = document.createElement('span');
      valSpan.textContent = prefix + valueText;
      // Count-up tags drive only the 0 -> value animation; text stays authoritative.
      if (count && isNum(count.value)) {
        valSpan.setAttribute('data-x-count', String(count.value));
        valSpan.setAttribute('data-x-dec', String(count.dec || 0));
        if (count.group) valSpan.setAttribute('data-x-group', '1');
        if (count.prefix) valSpan.setAttribute('data-x-prefix', count.prefix);
      }
      val.appendChild(valSpan);
      if (unit) {
        const u = document.createElement('span');
        u.className = 'u';
        u.textContent = unit;
        val.appendChild(u);
      }
      card.appendChild(val);

      if (sub) {
        const s = document.createElement('div');
        s.className = 'k-sub';
        s.textContent = sub;
        card.appendChild(s);
      }
      grid.appendChild(card);
    });
    return grid;
  }

  _headcountSub(k) {
    const parts = [];
    if (isNum(k.n_pickers)) parts.push('ピッカー ' + num(k.n_pickers, 0));
    if (isNum(k.n_packers)) parts.push('梱包 ' + num(k.n_packers, 0));
    if (isNum(k.n_agvs) && k.n_agvs > 0) parts.push('AGV ' + num(k.n_agvs, 0));
    return parts.length ? parts.join(' · ') : null;
  }

  // Scenario comparison table — rendered only when the replay carries a
  // non-empty `scenarios` array. Each row: name + the numeric columns present.
  // Returns null when there is nothing real to show.
  _buildScenarioTable(r) {
    const list = Array.isArray(r && r.scenarios) ? r.scenarios : null;
    if (!list || !list.length) return null;

    const cols = [
      ['¥/件', (s) => isNum(s.total_cost_per_order) ? yen(s.total_cost_per_order, 0) : '—'],
      ['必要人員', (s) => isNum(headcountOf(s)) ? num(headcountOf(s), 0) + '名' : '—'],
      ['回収月数', (s) => (isNum(s.payback_months) && s.payback_months > 0) ? num(s.payback_months, 1) + 'ヶ月' : '—'],
    ];

    const table = document.createElement('table');
    table.className = 'proposal-scn';
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    const nameTh = document.createElement('th');
    nameTh.textContent = 'シナリオ';
    htr.appendChild(nameTh);
    cols.forEach(([h]) => { const th = document.createElement('th'); th.textContent = h; htr.appendChild(th); });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    list.forEach((s) => {
      const sc = s && typeof s === 'object' ? s : {};
      const tr = document.createElement('tr');
      if (sc.recommended === true) tr.className = 'hi';
      const td0 = document.createElement('td');
      td0.textContent = (typeof sc.name === 'string' && sc.name) ? sc.name : '—';
      tr.appendChild(td0);
      cols.forEach(([, fn]) => { const td = document.createElement('td'); td.className = 'num'; td.textContent = fn(sc); tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  // Provenance footer ("実データ N%"): a two-segment bar. Reads a real fraction
  // from replay.provenance (number 0-1 or 0-100, or {real_pct}/{real}). Returns
  // null when no value exists — nothing is invented.
  _buildProvenanceFoot(r) {
    const realPct = this._provenancePct(r);
    if (realPct == null) return null;
    const real = Math.max(0, Math.min(100, realPct));
    const est = 100 - real;

    const foot = document.createElement('div');
    foot.className = 'prov-foot';

    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = 'データ出所';
    foot.appendChild(lbl);

    const bar = document.createElement('div');
    bar.className = 'prov-bar';
    bar.title = `実データ ${real.toFixed(0)}% / 生成・推計 ${est.toFixed(0)}%`;
    const realSeg = document.createElement('div');
    realSeg.className = 'real';
    realSeg.style.width = real + '%';
    const estSeg = document.createElement('div');
    estSeg.className = 'est';
    estSeg.style.width = est + '%';
    bar.appendChild(realSeg);
    bar.appendChild(estSeg);
    foot.appendChild(bar);

    const legend = document.createElement('div');
    legend.className = 'prov-legend';
    const leg = (color, text) => {
      const span = document.createElement('span');
      const i = document.createElement('i');
      i.style.background = color;
      span.appendChild(i);
      span.appendChild(document.createTextNode(text));
      return span;
    };
    legend.appendChild(leg('var(--x-cyan)', `実データ ${real.toFixed(0)}%`));
    legend.appendChild(leg('#DCE2EC', `生成・推計 ${est.toFixed(0)}%`));
    foot.appendChild(legend);

    return foot;
  }

  // Best-effort extraction of a real-data percentage (0-100) from whatever shape
  // a provenance value might take; null when nothing usable is present.
  _provenancePct(r) {
    const p = r && r.provenance;
    if (p == null) return null;
    if (isNum(p)) return Math.abs(p) <= 1 ? p * 100 : p;
    if (typeof p === 'object') {
      const cand = [p.real_pct, p.real_percent, p.real, p.your_data_pct, p.percent];
      for (const v of cand) {
        if (isNum(v)) return Math.abs(v) <= 1 ? v * 100 : v;
      }
    }
    return null;
  }

  dispose() {
    this._reqToken += 1; // invalidate any in-flight fetch
    this._clearRoot();
    this.replay = null;
    this.pngUrl = null;
    this.container = null;
  }
}

// Utility kept outside the class: percent value as a bare number string
// (no % sign) for CSV cells. Accepts fraction or already-% input.
function pctVal(v, decimals = 1) {
  if (!isNum(v)) return '—';
  const scaled = Math.abs(v) <= 1.0 ? v * 100 : v;
  return scaled.toFixed(decimals);
}
