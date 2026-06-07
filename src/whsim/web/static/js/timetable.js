// timetable.js — the "タイムチャート" (work-timetable) tab for whsim.
//
// A volume-flow staffing planner: pick a scenario, see the 30-min slot × process
// headcount allocation as a stacked gantt + matrix + KPI cards, and drag sliders
// (生産性 / 作業帯 / 配置方式 / 物量 / 制約) to re-solve LIVE — the solve runs
// entirely client-side (timetable_solver.js, a parity-tested mirror of the Python
// engine) so recalc is instant. A time cursor scrubs the day; on change the
// controller emits the current per-section/per-worker headcount so the 2D/3D
// views can reflect "how many people are working where, right now" (時刻連動).
//
// Public API:
//   mountTimetable(targetEl, opts) -> controller
//     opts.getProject(): string|null
//     opts.onChange(payload): void   — { result, minute, headcount, by_section, by_worker }
//   controller: { el, recompute(), setMinute(min), headcountAt(min), result, destroy() }
//
// Framework-free ES module. Theme-aware (re-renders the gantt on `themechange`).
// Ships its own CSS class contract (tt-* in styles.css); no CDN, no build step.

import {
  solve, generateSlots, minToTime, timeToMin, SECTION_COLOR, SECTION_ZONE_TYPE,
} from './timetable_solver.js';

const SLOTS = generateSlots();           // 60 half-hour marks, 0..1770 min
const N = SLOTS.length;
const SECTIONS = ['入荷', '出荷ケース', '出荷バラ', 'ステージング', '間接'];
const ZONE_JP = { receiving: '入荷', storage: '保管', picking: 'ピッキング',
  packing: '梱包', shipping: '出荷', staging: '一時保管', office: '事務' };

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function r1(v) { return isNum(v) ? Math.round(v * 10) / 10 : 0; }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (_e) { return fallback; }
}
// Read a duration token (e.g. --dur-2: 160ms) as a number of ms; falls back to a
// token-consistent default. Keeps JS timing in lockstep with the CSS scale instead
// of hard-coded magic numbers.
function durMs(name, fallback) {
  const raw = cssVar(name, '');
  if (raw) {
    const m = /([\d.]+)\s*(ms|s)?/.exec(raw);
    if (m) return parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1);
  }
  return fallback;
}
const DEBOUNCE_MS = durMs('--dur-3', 240);   // live re-solve debounce (was 180)
const SYNC_FADE_MS = durMs('--dur-4', 420);  // cursor-sync emphasis fade (was 600)
const DUR_RESIZE_MS = durMs('--dur-3', 240); // resize debounce

// Scoped styles for elements this module adds on top of the styles.css tt-*
// contract (the cursor-sync indicator). Token-only: no raw hex / px durations /
// off-grid spacing. Injected once.
function injectStyle() {
  if (document.getElementById('tt-js-style')) return;
  const s = document.createElement('style');
  s.id = 'tt-js-style';
  s.textContent = `
  .tt-cursor-sync{display:inline-flex;align-items:center;gap:var(--sp-1);
    font-size:var(--fs-micro);color:var(--ink-tertiary);white-space:nowrap;
    opacity:0;transition:opacity var(--dur-2) var(--ease-out)}
  .tt-cursor-sync.on{opacity:1}
  .tt-cursor-sync i{width:var(--sp-1);height:var(--sp-1);border-radius:var(--r-pill);
    background:var(--accent);flex:0 0 auto;transition:transform var(--dur-2) var(--ease-out)}
  .tt-cursor-sync.moved i{transform:scale(1.6)}
  .tt-recalc-pill{display:inline-flex;align-items:center;gap:var(--sp-1);
    font-size:var(--fs-micro);color:var(--ink-onAccent);
    background:var(--accent);border-radius:var(--r-pill);
    padding:var(--sp-1) var(--sp-2);white-space:nowrap;
    opacity:0;pointer-events:none;transition:opacity var(--dur-2) var(--ease-out)}
  .tt-recalc-pill.on{opacity:1}
  .tt-empty{display:flex;flex-direction:column;align-items:flex-start;gap:var(--sp-2);
    padding:var(--sp-4);border:1px dashed var(--line-strong,var(--line));
    border-radius:var(--r-lg);background:var(--bg-panel)}
  .tt-empty-title{font-weight:700;color:var(--ink-primary);font-size:var(--fs-section)}
  .tt-empty-body{color:var(--ink-secondary);font-size:var(--fs-sm);max-width:48ch}
  @media (prefers-reduced-motion: reduce){ .tt-cursor-sync,.tt-cursor-sync i,.tt-recalc-pill{transition:none} }
  `;
  document.head.appendChild(s);
}

export function mountTimetable(targetEl, opts = {}) {
  const target = typeof targetEl === 'string' ? document.querySelector(targetEl) : targetEl;
  if (!target) throw new Error('mountTimetable: target element not found');
  const o = opts && typeof opts === 'object' ? opts : {};
  injectStyle();

  // ---- state ----
  let seed = null;                  // { processes, productivity, scenarios, ... }
  let scenarioName = null;
  let processes = [];               // editable working copy (band / mode / productivity_key)
  let productivity = {};            // editable working copy (篁採用値)
  let volumes = {};                 // editable working copy of scenario 物量
  let constraints = {};             // editable working copy of scenario 制約
  let pendingExternal = null;       // data-derived scenario queued before seed loads
  let result = null;
  let cursorSlot = 26;              // 13:00 default (typical peak)
  let recalcTimer = null;
  let destroyed = false;
  let layout = null;               // { bounds:{width,depth}, zones:[…] } or null

  // ---- canvas-churn caches ----
  // Resizing canvas.width clears + reallocates the backing store and is costly,
  // so we only do it when the CSS size or DPR actually changes. The gantt chart
  // (stacked areas + grid + total line) is expensive but only depends on the
  // solve result, so we cache it to an offscreen canvas and per-cursor just blit
  // the cache + draw the 1px cursor line (scrubbing becomes O(1)).
  let ganttCssW = 0, ganttDpr = 0;       // last applied gantt backing-store size
  let ganttGeom = null;                  // { padL,padR,padT,padB,plotW,plotH,X }
  let ganttCache = null;                 // offscreen canvas holding the chart
  let mapCssW = 0, mapDpr = 0;           // last applied staff-map backing-store size
  let resizeTimer = null;

  // ---- DOM scaffold ----
  const root = el('div', 'tt-view');
  root.innerHTML = '<div class="tt-loading">タイムチャートを読み込み中…</div>';
  target.appendChild(root);

  // Sub-containers (filled after seed loads).
  let elScenario, elKpis, elWarn, elCursor, elGantt, elGanttCanvas, elMatrix, elParams, elRecalc;
  let elMap, elMapCanvas, elMapTitle;
  let elCursorSync;          // low-key "時刻連動中" indicator near the time cursor
  let syncFadeTimer = null;  // briefly emphasizes the indicator when the cursor moves

  function build() {
    root.innerHTML = '';

    // Toolbar: scenario + actions
    const bar = el('div', 'tt-bar');
    const lab = el('label', 'tt-scenario');
    lab.appendChild(el('span', null, 'シナリオ'));
    elScenario = el('select');
    for (const name of Object.keys(seed.scenarios)) {
      const op = el('option', null, name); op.value = name; elScenario.appendChild(op);
    }
    elScenario.value = scenarioName;
    elScenario.onchange = () => { loadScenario(elScenario.value); recompute(); };
    lab.appendChild(elScenario);
    bar.appendChild(lab);

    const reset = el('button', 'tt-btn', '↺ 既定値に戻す');
    reset.onclick = () => { loadScenario(scenarioName, true); recompute(); };
    bar.appendChild(reset);

    const tsv = el('button', 'tt-btn', '📋 TSVコピー');
    tsv.onclick = copyTSV;
    bar.appendChild(tsv);

    // "再計算中…" pill — surfaced while a slider edit is debounced / solving.
    elRecalc = el('span', 'tt-recalc-pill');
    elRecalc.setAttribute('aria-live', 'polite');
    elRecalc.textContent = '再計算中…';
    bar.appendChild(elRecalc);
    root.appendChild(bar);

    // KPI cards
    elKpis = el('div', 'tt-kpis');
    root.appendChild(elKpis);

    // Warnings
    elWarn = el('div', 'tt-warn');
    root.appendChild(elWarn);

    // Time cursor (scrubber + readout) — drives the gantt cursor and the
    // per-time headcount payload consumed by the 2D/3D linkage.
    const cur = el('div', 'tt-cursor');
    elCursor = el('input'); elCursor.type = 'range';
    elCursor.min = '0'; elCursor.max = String(N - 1); elCursor.step = '1';
    elCursor.value = String(cursorSlot);
    elCursor.className = 'tt-cursor-range';
    elCursor.setAttribute('aria-label', '時刻');
    elCursor.oninput = () => { cursorSlot = parseInt(elCursor.value, 10) || 0; onCursor(); };
    const curRead = el('span', 'tt-cursor-read'); curRead.id = 'ttCursorRead';
    // The REAL readout is the polite live region (時刻 + 総人数 + 内訳); the
    // decorative sync cue below is silenced (aria-hidden) to avoid double-speak.
    curRead.setAttribute('aria-live', 'polite');
    curRead.setAttribute('role', 'status');
    // Low-key live cue: signals that the 2D/3D replay is following this time
    // cursor (時刻連動). Static / token-styled; no toasts. Fades in on movement.
    elCursorSync = el('div', 'tt-cursor-sync');
    elCursorSync.setAttribute('aria-hidden', 'true');
    elCursorSync.appendChild(el('i'));
    elCursorSync.appendChild(el('span', null, '時刻連動中（2D/3Dが追従）'));
    cur.appendChild(el('span', 'tt-cursor-label', '時刻'));
    cur.appendChild(elCursor);
    cur.appendChild(curRead);
    cur.appendChild(elCursorSync);
    root.appendChild(cur);

    // Live staffing map — the warehouse floorplan with per-zone worker dots at
    // the current time. Editing any slider re-solves and repaints this instantly
    // (the 時刻連動: タイムチャートをいじると 2D が変わる).
    elMap = el('div', 'tt-map');
    elMapTitle = el('div', 'tt-section-title', 'ライブ配置マップ（その時刻に、どのゾーンへ何人）');
    elMap.appendChild(elMapTitle);
    elMapCanvas = el('canvas', 'tt-map-canvas');
    elMapCanvas.setAttribute('role', 'img');
    elMapCanvas.setAttribute('aria-label', 'ライブ配置マップ（指定時刻のゾーン別作業者配置）');
    elMap.appendChild(elMapCanvas);
    root.appendChild(elMap);

    // Gantt
    elGantt = el('div', 'tt-gantt');
    elGantt.appendChild(el('div', 'tt-section-title', '配置ガント（30分 × 工程、色＝セクション、太線＝総人数）'));
    elGanttCanvas = el('canvas', 'tt-gantt-canvas');
    elGanttCanvas.setAttribute('role', 'img');
    elGanttCanvas.setAttribute('aria-label', '配置ガント（30分刻みのセクション別人数積み上げと総人数推移）');
    elGantt.appendChild(elGanttCanvas);
    elGantt.appendChild(ganttLegend());
    root.appendChild(elGantt);

    // Matrix
    elMatrix = el('div', 'tt-matrix');
    root.appendChild(elMatrix);

    // Parameters (collapsible)
    const det = el('details', 'tt-params'); det.open = true;
    det.appendChild(el('summary', null, 'パラメータ設定（動かすと即再計算）'));
    elParams = el('div', 'tt-params-body');
    det.appendChild(elParams);
    root.appendChild(det);
  }

  // Zero-scenario state: don't throw or render a blank tab — explain + give a CTA.
  function renderEmptyState() {
    root.innerHTML = '';
    const box = el('div', 'tt-empty');
    box.appendChild(el('div', 'tt-empty-title', 'シナリオがまだありません'));
    box.appendChild(el('div', 'tt-empty-body',
      'マテリアルフローで荷役物量を作成し「タイムチャートで人員配置 →」を押すと、ここに配置計画が表示されます。'));
    const cta = el('button', 'tt-btn', 'マテリアルフローへ');
    cta.onclick = () => document.dispatchEvent(new CustomEvent('whsim:goto', { detail: { view: 'materialflow' } }));
    box.appendChild(cta);
    root.appendChild(box);
  }

  function ganttLegend() {
    const leg = el('div', 'tt-legend');
    for (const s of SECTIONS) {
      const i = el('span', 'tt-legend-item');
      const sw = el('i'); sw.style.background = SECTION_COLOR[s] || 'var(--ink-tertiary,#8195a8)';
      i.appendChild(sw); i.appendChild(document.createTextNode(s));
      leg.appendChild(i);
    }
    return leg;
  }

  // ---- scenario / working-copy management ----
  function loadScenario(name, _force) {
    scenarioName = name;
    processes = clone(seed.processes);
    productivity = clone(seed.productivity);
    const sc = seed.scenarios[name] || {};
    volumes = clone(sc['物量'] || {});
    constraints = clone(sc['制約'] || {});
  }

  function currentScenario() {
    return { '物量': volumes, '制約': constraints };
  }

  // ---- compute + render ----
  function recompute() {
    if (!seed) return;
    setRecalcPill(false);
    result = solve(currentScenario(), processes, productivity);
    ganttCache = null;    // result changed → rebuild the chart cache on next render
    renderKpis();
    renderWarnings();
    renderGantt();
    renderMatrix();
    onCursor();           // refresh readout + notify listeners
  }

  function setRecalcPill(on) {
    if (elRecalc) elRecalc.classList.toggle('on', !!on);
  }

  function scheduleRecompute() {
    if (recalcTimer) clearTimeout(recalcTimer);
    setRecalcPill(true);
    recalcTimer = setTimeout(() => { if (!destroyed) recompute(); }, DEBOUNCE_MS);
  }

  function renderKpis() {
    const r = result;
    const diff = r.total_assigned_hours - r.total_required_hours;
    const pk = r.peak_headcount;
    const pkTime = minToTime(SLOTS[r.peak_slot_index]);
    const pt = (r.by_worker_type['PT'] || {}).peak || 0;
    const fm = (r.by_worker_type['Fマン'] || {}).peak || 0;
    const cards = [
      ['総必要工数', r1(r.total_required_hours), 'h'],
      ['総配置工数', r1(r.total_assigned_hours), 'h'],
      ['差分（配置−必要）', (diff >= 0 ? '+' : '') + r1(diff), 'h', diff < 0 ? 'bad' : 'good'],
      ['ピーク人数', pk, `名 (PT${pt}/Fマン${fm})`],
      ['ピーク時間帯', pkTime, '〜'],
    ];
    elKpis.innerHTML = '';
    for (const [label, value, unit, tone] of cards) {
      const c = el('div', 'tt-kpi' + (tone ? ' ' + tone : ''));
      c.appendChild(el('div', 'tt-kpi-label', label));
      const v = el('div', 'tt-kpi-value', String(value));
      if (unit) v.appendChild(el('span', 'tt-kpi-unit', ' ' + unit));
      c.appendChild(v);
      elKpis.appendChild(c);
    }
  }

  function renderWarnings() {
    const ws = result.warnings || [];
    elWarn.innerHTML = '';
    if (!ws.length) {
      const ok = el('div', 'tt-info', '✓ 制約・物量に問題はありません。');
      elWarn.appendChild(ok);
      return;
    }
    const box = el('div', 'tt-alert');
    box.appendChild(el('div', 'tt-alert-head', `⚠ ${ws.length}件の注意点`));
    const ul = el('ul');
    for (const w of ws) ul.appendChild(el('li', null, w));
    box.appendChild(ul);
    elWarn.appendChild(box);
  }

  // ---- gantt (stacked area by section + total line + cursor) ----
  // The chart (grid + stacked areas + total + cap line) only depends on the solve
  // result, so we draw it ONCE to an offscreen cache. Per cursor tick we just blit
  // the cache and stroke the 1px cursor line — O(1) scrubbing, no full repaint and
  // no backing-store reallocation (cv.width is only set when CSS size / DPR change).
  function ensureGanttBacking() {
    const cv = elGanttCanvas;
    const cssW = cv.clientWidth || 720;
    const cssH = 240;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cssW !== ganttCssW || dpr !== ganttDpr) {
      cv.width = cssW * dpr; cv.height = cssH * dpr;
      ganttCssW = cssW; ganttDpr = dpr;
      ganttCache = null; // backing store reallocated → cache invalid
    }
    return { cssW, cssH, dpr };
  }

  function buildGanttCache(cssW, cssH, dpr) {
    const cache = document.createElement('canvas');
    cache.width = cssW * dpr; cache.height = cssH * dpr;
    const ctx = cache.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const padL = 34, padR = 8, padT = 10, padB = 22;
    const plotW = cssW - padL - padR, plotH = cssH - padT - padB;
    const ink = cssVar('--canvas-zone-ink', '#8a93a0');
    const faint = cssVar('--canvas-ink-faint', '#9aa4b0');
    const maxTotal = Math.max(1, ...result.headcount_by_slot);
    const X = (i) => padL + (i / (N - 1)) * plotW;
    const Y = (v) => padT + plotH - (v / maxTotal) * plotH;
    ganttGeom = { padL, padR, padT, padB, plotW, plotH, X };

    // y grid + labels
    ctx.strokeStyle = cssVar('--canvas-shell', '#dde3ea');
    ctx.fillStyle = faint; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    const step = maxTotal <= 20 ? 5 : maxTotal <= 50 ? 10 : 20;
    for (let v = 0; v <= maxTotal; v += step) {
      const y = Y(v);
      ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke();
      ctx.globalAlpha = 1; ctx.fillText(String(v), padL - 4, y + 3);
    }
    // x labels every 2h (4 slots)
    ctx.textAlign = 'center';
    for (let i = 0; i < N; i += 4) {
      ctx.fillText(minToTime(SLOTS[i]), X(i), cssH - 6);
    }

    // stacked areas by section (bottom→top)
    const bottoms = new Array(N).fill(0);
    for (const sec of SECTIONS) {
      const secProcs = result.processes.filter((p) => p.section === sec);
      if (!secProcs.length) continue;
      const tops = bottoms.map((b, i) => b + secProcs.reduce((a, p) => a + p.headcounts[i], 0));
      ctx.beginPath();
      ctx.moveTo(X(0), Y(bottoms[0]));
      for (let i = 0; i < N; i++) ctx.lineTo(X(i), Y(tops[i]));
      for (let i = N - 1; i >= 0; i--) ctx.lineTo(X(i), Y(bottoms[i]));
      ctx.closePath();
      ctx.fillStyle = hexA(SECTION_COLOR[sec] || cssVar('--ink-tertiary', '#8195a8'), 0.78);
      ctx.fill();
      for (let i = 0; i < N; i++) bottoms[i] = tops[i];
    }
    // total line
    ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < N; i++) (i ? ctx.lineTo(X(i), Y(result.headcount_by_slot[i])) : ctx.moveTo(X(i), Y(result.headcount_by_slot[i])));
    ctx.stroke(); ctx.lineWidth = 1;
    // peak-cap line
    const cap = constraints['ピーク人数上限'];
    if (cap && cap <= maxTotal) {
      ctx.strokeStyle = cssVar('--bad', '#e31a1c'); ctx.setLineDash([5, 4]); ctx.beginPath();
      ctx.moveTo(padL, Y(cap)); ctx.lineTo(cssW - padR, Y(cap)); ctx.stroke(); ctx.setLineDash([]);
    }
    ganttCache = cache;
  }

  // Cheap per-cursor path: blit the cached chart, draw the 1px cursor line.
  function drawGanttCursor() {
    if (!ganttGeom) return;
    const cv = elGanttCanvas;
    const { cssW, cssH, dpr } = ensureGanttBacking();
    if (!ganttCache) { buildGanttCache(cssW, cssH, dpr); } // size/DPR changed → rebuild
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(ganttCache, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { padT, plotH, X } = ganttGeom;
    const cx = X(cursorSlot);
    ctx.strokeStyle = cssVar('--accent', '#16C0DE'); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + plotH); ctx.stroke(); ctx.lineWidth = 1;
  }

  function renderGantt() {
    if (!result) return;
    const { cssW, cssH, dpr } = ensureGanttBacking();
    if (!ganttCache) buildGanttCache(cssW, cssH, dpr);
    drawGanttCursor();
  }

  function hexA(hex, a) {
    const h = (hex || '#999999').replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ---- live staffing map (floorplan + per-zone worker dots @ current time) ----
  function renderStaffMap() {
    if (!elMapCanvas || !result) return;
    const cv = elMapCanvas;
    const cssW = cv.clientWidth || 720;
    const cssH = 260;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cssW !== mapCssW || dpr !== mapDpr) {
      cv.width = cssW * dpr; cv.height = cssH * dpr; // only reallocate when size/DPR changes
      mapCssW = cssW; mapDpr = dpr;
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const minute = SLOTS[cursorSlot];
    const hc = headcountAt(minute);
    if (elMapTitle) {
      elMapTitle.textContent = `ライブ配置マップ — ${minToTime(minute)} 時点（総${hc.total}名）`;
    }
    cv.setAttribute('aria-label', `ライブ配置マップ ${minToTime(minute)} 時点、総${hc.total}名のゾーン別作業者配置`);
    const shell = cssVar('--canvas-shell', '#bbb');
    const zoneInk = cssVar('--canvas-zone-ink', '#8a93a0');
    const pad = 14;
    const zmap = seed.section_zone_type || SECTION_ZONE_TYPE;

    if (layout && layout.bounds && Array.isArray(layout.zones) && layout.zones.length) {
      const b = layout.bounds;
      const sc = Math.min((cssW - 2 * pad) / (b.width || 1), (cssH - 2 * pad) / (b.depth || 1));
      const ox = (cssW - (b.width || 0) * sc) / 2, oy = (cssH - (b.depth || 0) * sc) / 2;
      const X = (x) => ox + x * sc, Y = (y) => cssH - oy - y * sc;
      ctx.strokeStyle = shell; ctx.lineWidth = 1.5;
      ctx.strokeRect(X(0), Y(b.depth), b.width * sc, b.depth * sc);
      for (const z of layout.zones) {
        ctx.fillStyle = hexA(z.color || '#dddddd', 0.28);
        ctx.fillRect(X(z.x), Y(z.y + z.h), z.w * sc, z.h * sc);
        ctx.fillStyle = zoneInk; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(ZONE_JP[z.type] || z.type, X(z.x + z.w / 2), Y(z.y + z.h / 2) - 2);
      }
      const fallback = [];
      for (const sec of SECTIONS) {
        const n = hc.by_section[sec] || 0;
        if (!n) continue;
        const z = layout.zones.find((zz) => zz.type === zmap[sec]);
        if (!z) { fallback.push([sec, n]); continue; }
        drawDots(ctx, X(z.x), Y(z.y + z.h), z.w * sc, z.h * sc, n, SECTION_COLOR[sec]);
        ctx.fillStyle = SECTION_COLOR[sec]; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(`${sec} ${n}`, X(z.x + z.w / 2), Y(z.y + z.h) + 12);
      }
      drawFallback(ctx, cssW, cssH, fallback);
    } else {
      drawSchematic(ctx, cssW, cssH, hc);
    }
  }

  function drawDots(ctx, x, y, w, h, n, color) {
    const cap = Math.min(n, 80);
    const cols = Math.max(1, Math.ceil(Math.sqrt(cap * (w / Math.max(h, 1)))));
    const rows = Math.ceil(cap / cols);
    const cw = w / cols, ch = h / rows;
    const r = Math.max(1.6, Math.min(4.5, Math.min(cw, ch) * 0.28));
    ctx.fillStyle = color || cssVar('--ink-tertiary', '#16C0DE');
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 0.6;
    let k = 0;
    for (let ry = 0; ry < rows && k < cap; ry++) {
      for (let cx = 0; cx < cols && k < cap; cx++, k++) {
        ctx.beginPath(); ctx.arc(x + cw * (cx + 0.5), y + ch * (ry + 0.5), r, 0, 7);
        ctx.fill(); ctx.stroke();
      }
    }
  }

  function drawFallback(ctx, W, H, list) {
    if (!list.length) return;
    let x = 14; const y = H - 14;
    ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left';
    for (const [sec, n] of list) {
      ctx.fillStyle = SECTION_COLOR[sec] || cssVar('--ink-tertiary', '#16C0DE');
      const dots = Math.min(n, 12);
      for (let i = 0; i < dots; i++) { ctx.beginPath(); ctx.arc(x + i * 7 + 2, y - 3, 2.6, 0, 7); ctx.fill(); }
      const tx = x + dots * 7 + 6;
      ctx.fillStyle = cssVar('--canvas-zone-ink', '#888');
      ctx.fillText(`${sec} ${n}`, tx, y);
      x = tx + ctx.measureText(`${sec} ${n}`).width + 18;
    }
  }

  function drawSchematic(ctx, W, H, hc) {
    const pad = 14, gap = 8;
    const laneW = (W - 2 * pad - gap * (SECTIONS.length - 1)) / SECTIONS.length;
    ctx.textAlign = 'center';
    SECTIONS.forEach((sec, i) => {
      const x = pad + i * (laneW + gap), y = pad, h = H - 2 * pad - 16;
      ctx.fillStyle = hexA(SECTION_COLOR[sec] || '#999', 0.14); ctx.fillRect(x, y, laneW, h);
      ctx.strokeStyle = cssVar('--canvas-shell', '#ccc'); ctx.lineWidth = 1; ctx.strokeRect(x, y, laneW, h);
      const n = hc.by_section[sec] || 0;
      drawDots(ctx, x + 4, y + 4, laneW - 8, h - 8, n, SECTION_COLOR[sec]);
      ctx.fillStyle = SECTION_COLOR[sec]; ctx.font = 'bold 11px sans-serif';
      ctx.fillText(`${sec} ${n}`, x + laneW / 2, H - pad);
    });
  }

  // ---- matrix (process rows × 30-min cols, colour by headcount) ----
  function renderMatrix() {
    elMatrix.innerHTML = '';
    elMatrix.appendChild(el('div', 'tt-section-title', '配置マトリクス（30分刻み・人数）'));
    const wrap = el('div', 'tt-matrix-scroll');
    const tbl = el('table', 'tt-table');
    // header
    const thead = el('thead'); const hr = el('tr');
    hr.appendChild(el('th', 'tt-rowhead', '工程'));
    for (let i = 0; i < N; i += 2) hr.appendChild(el('th', 'tt-time', minToTime(SLOTS[i])));
    hr.appendChild(el('th', 'tt-total', '合計h'));
    thead.appendChild(hr); tbl.appendChild(thead);
    const tb = el('tbody');
    for (const p of result.processes) {
      const tr = el('tr');
      const name = el('th', 'tt-rowhead');
      const dot = el('i', 'tt-dot'); dot.style.background = SECTION_COLOR[p.section] || 'var(--ink-tertiary,#8195a8)';
      name.appendChild(dot); name.appendChild(document.createTextNode(p.id));
      tr.appendChild(name);
      // render every other slot to keep the table readable (sum the pair)
      for (let i = 0; i < N; i += 2) {
        const n = p.headcounts[i] + (p.headcounts[i + 1] || 0);
        const td = el('td', 'tt-cell n' + Math.min(8, Math.ceil(n / 2)));
        td.textContent = n ? String(Math.max(p.headcounts[i], p.headcounts[i + 1] || 0)) : '';
        if (i === cursorSlot || i + 1 === cursorSlot) td.classList.add('tt-cell-cursor');
        tr.appendChild(td);
      }
      tr.appendChild(el('td', 'tt-total', String(r1(p.assigned_hours))));
      tb.appendChild(tr);
    }
    // worker-type subtotal rows
    for (const wt of Object.keys(result.by_worker_type)) {
      const d = result.by_worker_type[wt];
      const tr = el('tr', 'tt-subtotal');
      tr.appendChild(el('th', 'tt-rowhead', '小計: ' + wt));
      for (let i = 0; i < N; i += 2) {
        tr.appendChild(el('td', 'tt-cell', String(Math.max(d.by_slot[i], d.by_slot[i + 1] || 0) || '')));
      }
      tr.appendChild(el('td', 'tt-total', String(r1(d.total_hours))));
      tb.appendChild(tr);
    }
    // grand total row
    const gt = el('tr', 'tt-grandtotal');
    gt.appendChild(el('th', 'tt-rowhead', '時刻総人数'));
    for (let i = 0; i < N; i += 2) {
      gt.appendChild(el('td', 'tt-cell', String(Math.max(result.headcount_by_slot[i], result.headcount_by_slot[i + 1] || 0) || '')));
    }
    gt.appendChild(el('td', 'tt-total', String(r1(result.total_assigned_hours))));
    tb.appendChild(gt);
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
    elMatrix.appendChild(wrap);
  }

  // ---- parameter panel (live controls) ----
  function renderParams() {
    elParams.innerHTML = '';
    // constraints + a couple of scenario volumes get a compact row first.
    const cons = el('div', 'tt-param-group');
    cons.appendChild(el('div', 'tt-param-group-title', '制約'));
    cons.appendChild(numberField('ピーク人数上限', constraints['ピーク人数上限'] || 0, (v) => { constraints['ピーク人数上限'] = v; }, '名'));
    elParams.appendChild(cons);

    // one editable row per process
    const grp = el('div', 'tt-param-group');
    grp.appendChild(el('div', 'tt-param-group-title', '工程ごとの設定'));
    for (const p of processes) {
      const row = el('div', 'tt-param-row');
      const head = el('div', 'tt-param-head');
      const dot = el('i', 'tt-dot'); dot.style.background = SECTION_COLOR[p.section] || 'var(--ink-tertiary,#8195a8)';
      head.appendChild(dot); head.appendChild(el('span', 'tt-param-name', p.id));
      row.appendChild(head);

      // mode
      const modeSel = el('select', 'tt-mini');
      for (const [val, txt] of [['dynamic', '🟣 物量÷生産性'], ['fixed_n', '🟠 固定人数']]) {
        const op = el('option', null, txt); op.value = val; modeSel.appendChild(op);
      }
      modeSel.value = p['配置方式'] || 'dynamic';
      modeSel.onchange = () => { p['配置方式'] = modeSel.value; scheduleRecompute(); };
      row.appendChild(labeled('配置', modeSel));

      // productivity slider (only meaningful for dynamic w/ volume)
      const prod = productivity[p.productivity_key];
      if (prod && !prod.fixed_hours) {
        const base = prod['篁採用値'];
        const sld = el('input', 'tt-slider'); sld.type = 'range';
        sld.min = String(Math.max(1, Math.round(base * 0.2)));
        sld.max = String(Math.round(base * 3));
        sld.step = '1'; sld.value = String(base);
        const out = el('span', 'tt-slider-out', `${base} ${prod['単位'] || ''}`);
        sld.oninput = () => {
          prod['篁採用値'] = parseInt(sld.value, 10) || base;
          out.textContent = `${prod['篁採用値']} ${prod['単位'] || ''}`;
          scheduleRecompute();
        };
        row.appendChild(labeled('生産性', wrapInline(sld, out)));
      }

      // band start / end
      const bandStart = timeSelect(p['default_時間帯'][0], (v) => { p['default_時間帯'][0] = v; scheduleRecompute(); });
      const bandEnd = timeSelect(p['default_時間帯'][1], (v) => { p['default_時間帯'][1] = v; scheduleRecompute(); });
      row.appendChild(labeled('作業帯', wrapInline(bandStart, el('span', null, '〜'), bandEnd)));

      // deps (read-only badges)
      if ((p['依存'] || []).length) {
        const badges = el('span', 'tt-deps');
        for (const d of p['依存']) badges.appendChild(el('span', 'tt-dep-badge', d));
        row.appendChild(labeled('依存', badges));
      }
      grp.appendChild(row);
    }
    elParams.appendChild(grp);
  }

  function labeled(label, control) {
    const w = el('label', 'tt-field');
    w.appendChild(el('span', 'tt-field-label', label));
    w.appendChild(control);
    return w;
  }
  function wrapInline(...nodes) {
    const w = el('span', 'tt-inline');
    for (const n of nodes) w.appendChild(n);
    return w;
  }
  function numberField(label, value, onChange, unit) {
    const inp = el('input', 'tt-mini'); inp.type = 'number'; inp.value = String(value); inp.min = '0';
    inp.oninput = () => { onChange(parseFloat(inp.value) || 0); scheduleRecompute(); };
    const w = wrapInline(inp); if (unit) w.appendChild(el('span', 'tt-unit', unit));
    return labeled(label, w);
  }
  function timeSelect(value, onChange) {
    const sel = el('select', 'tt-mini');
    for (let m = 0; m <= 1800; m += 30) {
      const t = minToTime(m); const op = el('option', null, t); op.value = t; sel.appendChild(op);
    }
    sel.value = value;
    sel.onchange = () => onChange(sel.value);
    return sel;
  }

  // ---- cursor / linkage ----
  function headcountAt(minute) {
    if (!result) return { total: 0, by_section: {}, by_worker: {} };
    let idx = Math.floor(minute / 30);
    if (idx < 0) idx = 0; if (idx >= N) idx = N - 1;
    const by_section = {}; const by_worker = {};
    for (const s of SECTIONS) by_section[s] = 0;
    for (const p of result.processes) {
      const n = p.headcounts[idx] || 0;
      by_section[p.section] = (by_section[p.section] || 0) + n;
      by_worker[p.worker_type] = (by_worker[p.worker_type] || 0) + n;
    }
    return { total: result.headcount_by_slot[idx] || 0, by_section, by_worker, slot: idx };
  }

  function onCursor() {
    const minute = SLOTS[cursorSlot];
    const hc = headcountAt(minute);
    const read = document.getElementById('ttCursorRead');
    if (read) {
      const parts = Object.entries(hc.by_worker).filter(([, n]) => n > 0)
        .map(([w, n]) => `${w}${n}`).join(' / ');
      read.textContent = `${minToTime(minute)}　総${hc.total}名${parts ? '（' + parts + '）' : ''}`;
    }
    if (elCursor && elCursor.value !== String(cursorSlot)) elCursor.value = String(cursorSlot);
    // Show the low-key "時刻連動中" cue: the 2D/3D replay follows this cursor.
    // Static once result exists; briefly re-emphasized so movement is felt.
    if (elCursorSync) {
      elCursorSync.classList.toggle('on', !!result);
      if (syncFadeTimer) clearTimeout(syncFadeTimer);
      elCursorSync.classList.add('moved');
      syncFadeTimer = setTimeout(() => { if (elCursorSync) elCursorSync.classList.remove('moved'); }, SYNC_FADE_MS);
    }
    if (ganttCache) drawGanttCursor(); else renderGantt(); // O(1) cursor move
    renderStaffMap();   // repaint workers for this time (the 時刻連動)
    if (typeof o.onChange === 'function') {
      o.onChange({
        result, minute, headcount: hc.total, by_section: hc.by_section, by_worker: hc.by_worker,
        section_zone_type: seed.section_zone_type || SECTION_ZONE_TYPE, colors: SECTION_COLOR,
      });
    }
    document.dispatchEvent(new CustomEvent('whsim:timetable-change', {
      detail: { minute, headcount: hc.total, by_section: hc.by_section },
    }));
  }

  // ---- TSV export (Excel-paste) ----
  function copyTSV() {
    if (!result) return;
    const head = ['工程', ...SLOTS.map(minToTime), '合計h'];
    const lines = [head.join('\t')];
    for (const p of result.processes) {
      lines.push([p.id, ...p.headcounts.map(String), r1(p.assigned_hours)].join('\t'));
    }
    lines.push(['時刻総人数', ...result.headcount_by_slot.map(String), r1(result.total_assigned_hours)].join('\t'));
    const text = lines.join('\n');
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => flash('TSVをコピーしました（Excelに貼り付け可）'))
      .catch(() => flash('コピーできませんでした', true));
  }
  function flash(msg, bad) {
    document.dispatchEvent(new CustomEvent('whsim:toast', { detail: { msg, kind: bad ? 'error' : 'ok' } }));
  }

  // ---- init ----
  async function init() {
    try {
      const r = await fetch('/api/timetable/seed');
      seed = await r.json();
    } catch (_e) {
      root.innerHTML = '<div class="tt-loading">タイムチャートのデータ取得に失敗しました。</div>';
      return;
    }
    if (typeof o.fetchLayout === 'function') {
      try { layout = await o.fetchLayout(); } catch (_e) { layout = null; }
    } else {
      // No layout source wired → live map falls back to the schematic. Note it.
      flash('レイアウト情報が取得できないため、配置マップは簡易表示です。');
    }
    // A pending data-derived scenario can stand in for an empty seed.
    if (!seed.scenarios || !Object.keys(seed.scenarios).length) {
      if (pendingExternal) { applyExternalScenario(pendingExternal); pendingExternal = null; return; }
      renderEmptyState();
      return;
    }
    scenarioName = Object.keys(seed.scenarios)[0];
    loadScenario(scenarioName);
    build();
    renderParams();
    recompute();
    if (pendingExternal) { applyExternalScenario(pendingExternal); pendingExternal = null; }
  }

  // Merge a data-derived generic scenario (from 物量分析) into the seed and solve it.
  function applyExternalScenario(payload) {
    if (!seed || !payload || !payload.scenarios) return;
    seed.processes = payload.processes || seed.processes;
    seed.productivity = payload.productivity || seed.productivity;
    Object.assign(seed.scenarios, payload.scenarios);
    scenarioName = Object.keys(payload.scenarios)[0] || scenarioName;
    loadScenario(scenarioName);
    build();
    renderParams();
    recompute();
  }

  const onTheme = () => { if (result) { ganttCache = null; renderGantt(); renderStaffMap(); } };
  document.addEventListener('themechange', onTheme);

  // Debounced resize: CSS width may change → invalidate the gantt cache and
  // re-render both canvases. Removed in destroy(). (controller.resize existed but
  // nothing was driving it.)
  const onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (destroyed || !result) return;
      ganttCache = null; renderGantt(); renderStaffMap();
    }, DUR_RESIZE_MS);
  };
  window.addEventListener('resize', onResize);

  const controller = {
    el: root,
    get result() { return result; },
    recompute,
    headcountAt,
    setMinute(min) { cursorSlot = Math.max(0, Math.min(N - 1, Math.floor(min / 30))); onCursor(); },
    setLayout(l) { layout = l || null; if (result) renderStaffMap(); },
    // Load a data-derived generic scenario (from 物量分析) and solve it. Queues
    // if the seed hasn't loaded yet (handoff can fire right after mount).
    loadExternal(payload) {
      if (!payload || !payload.scenarios) return;
      if (!seed) { pendingExternal = payload; return; }
      applyExternalScenario(payload);
    },
    resize() { if (result) { ganttCache = null; renderGantt(); renderStaffMap(); } },
    destroy() {
      destroyed = true;
      if (recalcTimer) clearTimeout(recalcTimer);
      if (syncFadeTimer) clearTimeout(syncFadeTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      document.removeEventListener('themechange', onTheme);
      window.removeEventListener('resize', onResize);
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };

  init();
  return controller;
}

export default mountTimetable;
