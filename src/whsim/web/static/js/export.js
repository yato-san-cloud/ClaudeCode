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
  --x-ease-out: cubic-bezier(.16,1,.3,1);
  --x-ease-in: cubic-bezier(.4,0,1,1);
  --x-dur-1: 120ms;
  --x-dur-2: 180ms;
  --x-dur-3: 240ms;

  --x-panel: #0E1726;
  --x-panel-2: #111E33;
  --x-ink-0: #EAF2FA;
  --x-ink-1: #9FB2C8;
  --x-ink-2: #607389;
  --x-line: rgba(255,255,255,0.07);
  --x-line-strong: rgba(255,255,255,0.12);
  --x-cyan: #34E3FF;
  --x-cyan-hi: #7EF6FF;
  --x-tech: #2F7BFF;
  --x-deep: #0C5F86;

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
  box-shadow: 0 0 0 0 rgba(52,227,255,0);
  transition: box-shadow var(--x-dur-1) var(--x-ease-out), border-color var(--x-dur-1) var(--x-ease-out);
}
@media (hover: hover) {
  #export .export-doc-btn:hover {
    border-color: rgba(52,227,255,0.35);
    background: rgba(52,227,255,0.035);
    transform: translateY(-1px);
  }
  #export .export-doc-btn:hover::before {
    border-color: rgba(52,227,255,0.45);
    box-shadow: 0 0 10px rgba(52,227,255,0.55);
  }
}
#export .export-doc-btn:active { transform: scale(.98); transition-timing-function: var(--x-ease-in); }
#export .export-doc-btn:focus-visible { outline: 2px solid var(--x-cyan-hi); outline-offset: 2px; }
#export .export-doc-btn[disabled] { cursor: default; opacity: 0.85; transform: none; }

/* primary download: the one restrained cyan accent in the dark card grid */
#export .export-doc-btn.primary {
  color: #04121A; font-weight: 600;
  background: linear-gradient(180deg, var(--x-cyan-hi), var(--x-cyan));
  border-color: transparent;
  box-shadow: 0 0 0 1px rgba(52,227,255,0.35), 0 6px 16px rgba(52,227,255,0.16);
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
    border-color: rgba(52,227,255,0.32); color: var(--x-cyan-hi);
    background: rgba(52,227,255,0.04);
  }
}
#export .export-link-btn:active { transform: scale(.98); transition-timing-function: var(--x-ease-in); }
#export .export-link-btn:focus-visible { outline: 2px solid var(--x-cyan-hi); outline-offset: 2px; }

/* optimistic press feedback on doc buttons (visual only) */
#export .export-doc-btn[data-busy="1"]::before { box-shadow: 0 0 10px rgba(52,227,255,0.55); }

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

/* summary KPI table: tabular, right-aligned values */
#export table.proposal-kpis td { font-variant-numeric: tabular-nums; }

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
#export .export-view.is-anim table.proposal-kpis tbody tr {
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
  #export .export-view.is-anim table.proposal-kpis tbody tr { opacity: 1 !important; transform: none !important; }
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

function pct(v, decimals = 0) {
  if (!isNum(v)) return '—';
  // completion_rate / utilization may arrive as fraction (0–1) or already %.
  const scaled = Math.abs(v) <= 1.0 ? v * 100 : v;
  return scaled.toFixed(decimals) + '%';
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

    // Stagger the summary KPI rows ~36ms apart, after the sheet rises.
    const rows = root.querySelectorAll('table.proposal-kpis tbody tr');
    rows.forEach((tr, i) => { tr.style.setProperty('--x-stagger', (300 + i * 36) + 'ms'); });

    root.classList.add('is-anim');

    // Settle: clear will-change once the entrance is done.
    const settle = 300 + rows.length * 36 + 320;
    this._motionTimers.push(window.setTimeout(() => {
      root.querySelectorAll('.export-panel, .proposal-sheet, table.proposal-kpis tbody tr')
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
    el.style.willChange = 'contents';
    const frame = (ts) => {
      if (!this.root) return; // disposed mid-flight
      if (start === null) start = ts;
      const p = Math.min(1, (ts - start) / dur);
      el.textContent = fmt(target * easeOut(p));
      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        el.textContent = final; // restore exact rendered string
        el.style.willChange = 'auto';
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
    root.style.color = 'var(--ink, #1f2733)';
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
    p.style.color = 'var(--muted, #6b7785)';
    p.style.padding = '16px';
    p.textContent = message;
    this.root.appendChild(p);
  }

  _renderLoading() {
    const p = document.createElement('p');
    p.className = 'export-loading';
    p.style.color = 'var(--muted, #6b7785)';
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

    // Title
    const whName = (typeof meta.name === 'string' && meta.name.trim()) ? meta.name.trim() : name;
    const title = document.createElement('h1');
    title.className = 'proposal-title';
    title.textContent = `${whName} 倉庫運用 提案書`;
    title.style.fontSize = '22px';
    title.style.fontWeight = '700';
    title.style.margin = '0 0 6px';
    sheet.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'proposal-subtitle';
    sub.style.fontSize = '12px';
    sub.style.color = 'var(--muted, #6b7785)';
    sub.style.margin = '0 0 16px';
    const dur = isNum(meta.duration_s) ? `シミュレーション ${(meta.duration_s / 3600).toFixed(1)}時間相当` : '';
    sub.textContent = dur;
    sheet.appendChild(sub);

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
    verdict.style.margin = '0 0 18px';
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

    // KPI summary table
    sheet.appendChild(this._buildSummaryTable(k));

    // Proposal PNG
    if (this.pngUrl) {
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
      img.addEventListener('error', () => { fig.style.display = 'none'; });
      fig.appendChild(img);
      sheet.appendChild(fig);
    }

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

    return sheet;
  }

  _buildSummaryTable(k) {
    const compFrac = completionFraction(k);
    const bnName = (typeof k.bottleneck_jp === 'string' && k.bottleneck_jp) ? k.bottleneck_jp : null;
    const bnUtil = isNum(k.bottleneck_utilization) ? pct(k.bottleneck_utilization, 0) : null;
    const hc = headcountOf(k);

    // Each item: [label, renderedText, countMeta|null]. countMeta drives the
    // optional once-on-enter count-up; the rendered text is the source of truth
    // and stays identical (count-up only animates 0 -> value, then restores it).
    const compPctScaled = compFrac != null ? (Math.abs(compFrac) <= 1 ? compFrac * 100 : compFrac) : null;
    const items = [
      ['スループット',
        isNum(k.throughput_per_hr) ? num(k.throughput_per_hr, 1) + ' 件/時' : '—',
        isNum(k.throughput_per_hr) ? { value: k.throughput_per_hr, dec: 1, suffix: ' 件/時' } : null],
      ['出荷完了率',
        compFrac != null ? pct(compFrac, 1) : '—',
        compPctScaled != null ? { value: compPctScaled, dec: 1, suffix: '%' } : null],
      ['ボトルネック',
        bnName ? (bnName + (bnUtil ? ' ' + bnUtil : '')) : '—', null],
      ['必要人員',
        isNum(hc) ? num(hc, 0) + ' 名' : '—',
        isNum(hc) ? { value: hc, dec: 0, suffix: ' 名' } : null],
      ['1件あたりコスト',
        yen(k.total_cost_per_order, 1),
        isNum(k.total_cost_per_order) ? { value: k.total_cost_per_order, dec: 1, group: true, prefix: '¥' } : null],
      ['月間コスト',
        yen(k.monthly_cost, 0),
        isNum(k.monthly_cost) ? { value: k.monthly_cost, dec: 0, group: true, prefix: '¥' } : null],
    ];
    if (isNum(k.payback_months) && k.payback_months > 0) {
      items.push(['投資回収',
        num(k.payback_months, 1) + ' ヶ月',
        { value: k.payback_months, dec: 1, suffix: ' ヶ月' }]);
    }

    const table = document.createElement('table');
    table.className = 'proposal-kpis';
    table.style.borderCollapse = 'collapse';
    table.style.width = '100%';
    table.style.fontSize = '13px';

    const tbody = document.createElement('tbody');
    items.forEach(([label, value, count]) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = label;
      th.style.textAlign = 'left';
      th.style.fontWeight = '600';
      th.style.padding = '8px 12px';
      th.style.width = '40%';
      th.style.background = 'var(--surface, #f5f7fa)';
      th.style.border = '1px solid var(--line, #e3e8ee)';
      const td = document.createElement('td');
      td.className = 'tnum';
      td.textContent = value;
      td.style.textAlign = 'right';
      td.style.padding = '8px 12px';
      td.style.fontWeight = '700';
      td.style.border = '1px solid var(--line, #e3e8ee)';
      // Tag numeric value cells so the once-on-enter count-up can animate them.
      // The rendered text above is authoritative; these attributes only drive
      // the optional 0 -> value animation and are ignored under reduced-motion.
      if (count && isNum(count.value)) {
        td.setAttribute('data-x-count', String(count.value));
        td.setAttribute('data-x-dec', String(count.dec || 0));
        if (count.group) td.setAttribute('data-x-group', '1');
        if (count.prefix) td.setAttribute('data-x-prefix', count.prefix);
        if (count.suffix) td.setAttribute('data-x-suffix', count.suffix);
      }
      tr.appendChild(th);
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
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
