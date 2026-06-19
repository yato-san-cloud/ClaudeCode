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
import { api, esc } from './util.js';
import { ZONE_JP } from './constants.js';

const SLOTS = generateSlots();           // 60 half-hour marks, 0..1770 min
const N = SLOTS.length;
const SECTIONS = ['入荷', '出荷ケース', '出荷バラ', 'ステージング', '間接'];

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
  /* analytic staffing solver panel */
  .tt-solver{border:1px solid var(--line);border-radius:var(--r-lg,12px);
    background:var(--panel-2,var(--bg-panel));padding:var(--sp-2,8px) var(--sp-3,12px)}
  .tt-solver>summary{cursor:pointer;font-weight:700;color:var(--ink-primary,var(--ink));
    font-size:var(--fs-sm,13px);padding:var(--sp-1,4px) 0}
  .tt-solver-body{display:flex;flex-direction:column;gap:var(--sp-3,12px);padding-top:var(--sp-2,8px)}
  .tt-solver-ctrl{display:flex;flex-wrap:wrap;gap:var(--sp-3,12px);align-items:flex-end}
  .tt-solver-field{display:flex;flex-direction:column;gap:4px;font-size:var(--fs-micro,11px);
    color:var(--ink-secondary,var(--muted))}
  .tt-solver-flabel{font-size:var(--fs-micro,11px);color:var(--muted,var(--ink-tertiary))}
  .tt-solver-run{align-self:flex-end;background:var(--accent,#16C0DE);
    color:var(--ink-onAccent,#04222C);border-color:var(--accent,#16C0DE);font-weight:700}
  .tt-solver-run:hover{background:var(--accent-hover,#3AD3EE)}
  .tt-seg{display:inline-flex;border:1px solid var(--line);border-radius:var(--r-md,8px);overflow:hidden}
  .tt-seg-btn{padding:6px 10px;border:0;background:var(--panel,var(--bg-app));color:var(--ink,var(--ink-primary));
    font-size:var(--fs-sm,13px);cursor:pointer}
  .tt-seg-btn.on{background:var(--accent,#16C0DE);color:var(--ink-onAccent,#04222C);font-weight:700}
  .tt-solver-deps-title,.tt-solver-curve .tt-section-title{font-size:var(--fs-sm,13px);
    font-weight:700;color:var(--ink-primary,var(--ink));margin-bottom:var(--sp-1,4px)}
  .tt-solver-presets{display:flex;gap:var(--sp-2,8px);flex-wrap:wrap;margin-bottom:var(--sp-2,8px)}
  .tt-chip{padding:4px 10px;border:1px solid var(--line);border-radius:var(--r-pill,999px);
    background:var(--panel,var(--bg-app));color:var(--ink,var(--ink-primary));font-size:var(--fs-micro,11px);cursor:pointer}
  .tt-chip:hover{background:var(--bg-hover)}
  .tt-solver-depgrid{display:flex;flex-direction:column;gap:4px}
  .tt-solver-deprow{display:flex;align-items:center;gap:var(--sp-2,8px);flex-wrap:wrap}
  .tt-solver-depname{min-width:84px;font-size:var(--fs-micro,11px);font-weight:600;color:var(--ink,var(--ink-primary))}
  .tt-solver-depups{display:flex;gap:4px;flex-wrap:wrap}
  .tt-deptoggle{padding:2px 8px;border:1px solid var(--line);border-radius:var(--r-pill,999px);
    background:var(--panel,var(--bg-app));color:var(--muted,var(--ink-tertiary));font-size:var(--fs-micro,11px);cursor:pointer}
  .tt-deptoggle.on{background:var(--accent-tint,#E4F8FC);border-color:var(--accent,#16C0DE);
    color:var(--accent-ink,var(--accent));font-weight:700}
  /* バッチ投入スケジュール editor */
  .tt-solver-batches{display:flex;flex-direction:column;gap:var(--sp-2,8px);
    margin-top:var(--sp-2,8px);padding-top:var(--sp-2,8px);border-top:1px solid var(--line-hair,var(--line))}
  .tt-batch-block{display:flex;flex-direction:column;gap:4px}
  .tt-batch-head{display:flex;align-items:center;gap:var(--sp-2,8px);flex-wrap:wrap}
  .tt-batch-sec{min-width:40px;font-size:var(--fs-sm,13px);font-weight:700;color:var(--ink,var(--ink-primary))}
  .tt-batch-step{display:inline-flex;align-items:center;gap:6px;background:var(--bg-sunken,rgba(120,140,170,.1));
    border:1px solid var(--line-hair,var(--line));border-radius:var(--r-pill,999px);padding:2px 4px}
  .tt-batch-stepbtn{width:22px;height:22px;border:none;border-radius:50%;cursor:pointer;
    background:var(--panel,var(--bg-app));color:var(--ink,var(--ink-primary));font-size:14px;line-height:1}
  .tt-batch-stepbtn:hover{background:var(--accent,#16C0DE);color:var(--ink-onAccent,#04222C)}
  .tt-batch-count{min-width:30px;text-align:center;font-size:var(--fs-micro,11px);font-weight:700;
    font-variant-numeric:tabular-nums;color:var(--ink,var(--ink-primary))}
  .tt-batch-grid{display:flex;flex-direction:column;gap:5px}
  .tt-batch-srow{display:grid;grid-template-columns:34px 46px 16px 1fr 38px 22px;gap:7px;align-items:center}
  .tt-batch-srow .tt-mini{width:46px}
  .tt-batch-blabel{font-size:var(--fs-micro,11px);color:var(--muted,var(--ink-tertiary))}
  .tt-batch-slider{width:100%;accent-color:var(--accent,#16C0DE);cursor:pointer}
  .tt-batch-pct{font-size:var(--fs-micro,11px);font-weight:700;text-align:right;
    font-variant-numeric:tabular-nums;color:var(--accent-ink,var(--accent,#16C0DE))}
  .tt-batch-x{font-size:var(--fs-micro,11px);color:var(--muted,var(--ink-tertiary))}
  .tt-batch-del{border:none;background:transparent;color:var(--muted,var(--ink-tertiary));
    font-size:14px;line-height:1;cursor:pointer;padding:0 2px}
  .tt-batch-del:hover{color:var(--bad,#ff6b7d)}
  .tt-batch-note{font-size:var(--fs-micro,11px);color:var(--muted,var(--ink-tertiary))}
  /* scenario save + compare */
  .tt-cmp-bar{display:flex;gap:var(--sp-2,8px);flex-wrap:wrap;margin-top:var(--sp-2,8px);
    padding-top:var(--sp-2,8px);border-top:1px solid var(--line-hair,var(--line))}
  .tt-cmp-tbl th,.tt-cmp-tbl td{padding:4px 8px}
  .tt-cmp-cur th,.tt-cmp-cur td{background:var(--accent-tint,#E4F8FC)}
  .tt-cmp-d{margin-left:5px;font-size:10px;font-weight:700;font-variant-numeric:tabular-nums}
  .tt-cmp-d.up{color:var(--bad,#e3401c)} .tt-cmp-d.down{color:var(--ok,#1db954)}
  .tt-cmp-bad{font-size:10px;font-weight:700;color:var(--bad,#e3401c)}
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

  // ---- analytic staffing solver (稼働窓 + 上限 + 依存 + 前詰め/均等) ----------
  let elSolver, elSolverDeps, elSolverBatches, elSolverSummary, elSolverCurve, elSolverCompare;
  let solverResult = null;
  const solverState = {
    start: 9, end: 18, cap: 0, placement: 'front',
    deps: {}, defaultDeps: {}, processIds: [], _seededDeps: false,
    batches: {}, _seededBatches: false,  // {section: [{hour, pct}]} バッチ投入
  };
  // Sections that can carry a batch-release schedule (入荷=arrivals, 出荷=order cutoffs).
  const BATCH_SECTIONS = ['入荷', '出荷'];
  // Presets the planner can one-click instead of typing rows.
  const BATCH_PRESETS = {
    入荷: { 'なし（随時）': [], '昼1便': [{ hour: 12, pct: 100 }],
      '朝70/昼20/夕10': [{ hour: 8, pct: 70 }, { hour: 12, pct: 20 }, { hour: 15, pct: 10 }] },
    出荷: { 'なし（随時）': [], '夕締め1便': [{ hour: 16, pct: 100 }],
      '昼40/夕60': [{ hour: 11, pct: 40 }, { hour: 16, pct: 60 }] },
  };

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

    // Analytic staffing SOLVER (稼働時間＋上限人数＋依存＋前詰め/均等 → 解析的人員)
    buildSolverPanel();
  }

  // ---- analytic staffing solver (稼働窓 + 上限 + 依存 DAG + 前詰め/均等) -------
  // A second, complementary planner: instead of placing volume across 30-min
  // slots from work-bands, you set an operating window (start–end hour) and a
  // headcount CAP, and the backend solves the per-HOUR headcount per process that
  // clears the day under the cap, honouring precedence (入荷→格納→…→出荷) and a
  // placement choice (前詰め vs 均等). Analytic, instant.
  function buildSolverPanel() {
    elSolver = el('details', 'tt-solver'); elSolver.open = true;
    elSolver.appendChild(el('summary', null, 'ソルバー（稼働時間・上限人数・依存・前詰め/均等）'));
    const body = el('div', 'tt-solver-body');

    // Controls row: window, cap, placement, run.
    const ctrl = el('div', 'tt-solver-ctrl');
    solverState.startEl = numInput(solverState.start, 0, 30, (v) => { solverState.start = v; });
    solverState.endEl = numInput(solverState.end, 1, 30, (v) => { solverState.end = v; });
    solverState.capEl = numInput(solverState.cap, 0, 999, (v) => { solverState.cap = v; });
    ctrl.appendChild(ctrlField('稼働開始(時)', solverState.startEl));
    ctrl.appendChild(ctrlField('稼働終了(時)', solverState.endEl));
    ctrl.appendChild(ctrlField('上限人数(0=無制限)', solverState.capEl));

    const placeWrap = el('div', 'tt-seg');
    for (const [val, txt] of [['front', '前詰め（早く終える）'], ['level', '均等（平準化）']]) {
      const b = el('button', 'tt-seg-btn' + (solverState.placement === val ? ' on' : ''), txt);
      b.dataset.place = val;
      b.onclick = () => {
        solverState.placement = val;
        placeWrap.querySelectorAll('.tt-seg-btn').forEach((x) => x.classList.toggle('on', x.dataset.place === val));
        runSolver();
      };
      placeWrap.appendChild(b);
    }
    ctrl.appendChild(ctrlField('配置方針', placeWrap));

    const run = el('button', 'tt-btn tt-solver-run', '▶ ソルバー実行');
    run.onclick = runSolver;
    ctrl.appendChild(run);
    body.appendChild(ctrl);

    // Dependency editor (presets + per-process upstream edges).
    elSolverDeps = el('div', 'tt-solver-deps');
    body.appendChild(elSolverDeps);

    // Batch-release schedule editor (入荷/出荷 の {時刻, %} 投入).
    elSolverBatches = el('div', 'tt-solver-batches');
    body.appendChild(elSolverBatches);

    // Summary + per-hour curve render targets.
    elSolverSummary = el('div', 'tt-solver-summary');
    body.appendChild(elSolverSummary);
    elSolverCurve = el('div', 'tt-solver-curve');
    body.appendChild(elSolverCurve);

    // Scenario save + compare (作業バッチ/方式の比較).
    const cmpBar = el('div', 'tt-cmp-bar');
    const saveBtn = el('button', 'tt-chip', '💾 この条件をシナリオ保存');
    saveBtn.onclick = saveScenario;
    const cmpBtn = el('button', 'tt-chip', '🔁 シナリオ比較を更新');
    cmpBtn.onclick = loadCompare;
    cmpBar.appendChild(saveBtn); cmpBar.appendChild(cmpBtn);
    body.appendChild(cmpBar);
    elSolverCompare = el('div', 'tt-solver-compare');
    body.appendChild(elSolverCompare);

    elSolver.appendChild(body);
    root.appendChild(elSolver);
    renderDepEditor();
    renderBatchEditor();
  }

  // ---- scenario save + compare (作業バッチ/方式) ------------------------------
  async function saveScenario() {
    const proj = typeof o.getProject === 'function' ? o.getProject() : null;
    if (!proj) { (o.toast || (() => {}))('プロジェクトを開いてください。', 'error'); return; }
    const label = (window.prompt('シナリオ名（例：朝寄せ案 / 夕締め案 / マルチ方式）', '案')
      || '').trim();
    if (!label) return;
    try {
      await api(`/api/projects/${encodeURIComponent(proj)}/scenarios`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      (o.toast || (() => {}))(`シナリオ「${label}」を保存しました。`, 'ok');
      loadCompare();
    } catch (e) {
      (o.toast || (() => {}))('保存に失敗: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  async function loadCompare() {
    const proj = typeof o.getProject === 'function' ? o.getProject() : null;
    if (!proj || !elSolverCompare) return;
    elSolverCompare.innerHTML = '<div class="tt-info">シナリオ比較を計算中…</div>';
    const qs = `start_hour=${solverState.start}&end_hour=${solverState.end}`
      + `&cap=${solverState.cap || 0}&placement=${encodeURIComponent(solverState.placement)}`;
    let data;
    try {
      data = await api(`/api/projects/${encodeURIComponent(proj)}/timetable/compare?${qs}`);
    } catch (e) {
      elSolverCompare.innerHTML = `<div class="tt-alert"><div class="tt-alert-head">比較に失敗</div><div>${esc(String(e.message || e))}</div></div>`;
      return;
    }
    renderCompare(data);
  }

  function renderCompare(data) {
    if (!data || !Array.isArray(data.rows) || data.rows.length <= 1) {
      elSolverCompare.innerHTML = '<div class="tt-info">保存シナリオがありません。'
        + '「💾 この条件をシナリオ保存」で 朝寄せ案／夕締め案／マルチ方式 などを保存すると、ここで比較できます。</div>';
      return;
    }
    const base = data.rows[0];
    const num = (v) => (v == null ? '—' : Math.round(Number(v)).toLocaleString());
    const yen = (v) => (v == null ? '—' : '¥' + Math.round(Number(v)).toLocaleString());
    const delta = (v, b) => {
      if (v == null || b == null || v === b) return '';
      const d = v - b; const up = d > 0;
      return `<span class="tt-cmp-d ${up ? 'up' : 'down'}">${up ? '▲' : '▼'}${Math.abs(Math.round(d)).toLocaleString()}</span>`;
    };
    const batchTxt = (bc) => {
      const ks = Object.keys(bc || {});
      return ks.length ? ks.map((k) => `${esc(k)}${bc[k]}便`).join(' ') : '随時';
    };
    let html = '<div class="tt-section-title">シナリオ比較（同じ物量を各設計で／デルタは現在比）</div>';
    html += '<div class="tt-matrix-scroll"><table class="tt-table tt-cmp-tbl"><thead><tr>'
      + '<th class="tt-rowhead">シナリオ</th><th>作業方式</th><th>バッチ</th>'
      + '<th class="tt-num-h">ピーク人数</th><th class="tt-num-h">総工数</th>'
      + '<th class="tt-num-h">終了</th><th class="tt-num-h">月額原価</th></tr></thead><tbody>';
    data.rows.forEach((r, i) => {
      const cur = i === 0;
      html += `<tr class="${cur ? 'tt-cmp-cur' : ''}">`
        + `<th class="tt-rowhead">${esc(r.label)}${r.feasible === false ? ' <span class="tt-cmp-bad">不足</span>' : ''}</th>`
        + `<td>${esc(r.method || '—')}</td>`
        + `<td>${batchTxt(r.batch_counts)}</td>`
        + `<td class="tt-num">${num(r.peak_headcount)}${cur ? '' : delta(r.peak_headcount, base.peak_headcount)}</td>`
        + `<td class="tt-num">${num(r.total_man_hours)}${cur ? '' : delta(r.total_man_hours, base.total_man_hours)}</td>`
        + `<td class="tt-num">${r.makespan_hour == null ? '—' : r.makespan_hour + '時'}</td>`
        + `<td class="tt-num">${yen(r.monthly_cost)}${cur ? '' : delta(r.monthly_cost, base.monthly_cost)}</td>`
        + '</tr>';
    });
    html += '</tbody></table></div>';
    elSolverCompare.innerHTML = html;
  }

  // ---- バッチ投入スケジュール editor ------------------------------------------
  // The day's volume for a section lands in batches at given hours; this is how a
  // batch operation actually releases work (e.g. 入荷 朝70%/昼20%/夕10%). Per section
  // a 便数 stepper adds/removes batches and each batch is a SLIDER whose ratios
  // auto-rebalance to 100% (drag one up, the others give way). The solver gates the
  // section's first process to what has landed by each hour.

  // Distribute so the batch at `idx` becomes `val`% and the rest share (100-val)%
  // in proportion to their current weights (equal share when they're all zero).
  function rebalance(rows, idx, val) {
    const n = rows.length;
    if (!n) return;
    val = Math.max(0, Math.min(100, Math.round(val)));
    if (n === 1) { rows[0].pct = 100; return; }
    rows[idx].pct = val;
    const others = rows.map((_, i) => i).filter((i) => i !== idx);
    const rest = 100 - val;
    const otherSum = others.reduce((a, i) => a + (Number(rows[i].pct) || 0), 0);
    others.forEach((i) => {
      rows[i].pct = otherSum > 0 ? (rows[i].pct / otherSum) * rest : rest / others.length;
    });
    // integer round, then distribute the residual across the OTHER bars one unit at
    // a time (never below 0) so Σ stays EXACTLY 100 even when the largest other bar
    // is smaller than the drift.
    rows.forEach((r) => { r.pct = Math.round(r.pct); });
    let drift = 100 - rows.reduce((a, r) => a + r.pct, 0);
    const ring = [...others].sort((a, b) => rows[b].pct - rows[a].pct);
    let guard = 0;
    while (drift !== 0 && ring.length && guard < 1000) {
      const i = ring[guard % ring.length];
      if (drift > 0) { rows[i].pct += 1; drift -= 1; }
      else if (rows[i].pct > 0) { rows[i].pct -= 1; drift += 1; }
      guard += 1;
    }
  }
  function equalSplit(rows) {
    const n = rows.length;
    if (!n) return;
    const base = Math.floor(100 / n);
    rows.forEach((r) => { r.pct = base; });
    rows[0].pct += 100 - base * n;   // residual onto the first
  }
  function suggestHour(rows) {
    const s = solverState.start, e = Math.max(s + 1, Math.min(24, solverState.end));
    if (!rows.length) return s;
    const step = Math.max(1, Math.round((e - s) / (rows.length + 1)));
    return Math.min(e - 1, (Math.max(...rows.map((r) => r.hour)) || s) + step);
  }
  function setBatchCount(sec, n) {
    const rows = solverState.batches[sec] ? [...solverState.batches[sec]] : [];
    n = Math.max(0, Math.min(8, n));
    while (rows.length < n) rows.push({ hour: suggestHour(rows), pct: 0 });
    while (rows.length > n) rows.pop();
    if (n === 0) delete solverState.batches[sec];
    else { equalSplit(rows); solverState.batches[sec] = rows; }
    renderBatchEditor(); runSolver();
  }

  function renderBatchEditor() {
    if (!elSolverBatches) return;
    elSolverBatches.innerHTML = '';
    elSolverBatches.appendChild(el('div', 'tt-solver-deps-title',
      'バッチ投入スケジュール（便数を増減、スライダーで比率を調整＝自動で合計100%。空＝随時）'));
    for (const sec of BATCH_SECTIONS) {
      const rows = solverState.batches[sec] || [];
      const block = el('div', 'tt-batch-block');
      const head = el('div', 'tt-batch-head');
      head.appendChild(el('span', 'tt-batch-sec', sec));
      // 便数 stepper
      const step = el('span', 'tt-batch-step');
      const minus = el('button', 'tt-batch-stepbtn', '−'); minus.title = '便を減らす';
      minus.onclick = () => setBatchCount(sec, rows.length - 1);
      const count = el('span', 'tt-batch-count', `${rows.length}便`);
      const plus = el('button', 'tt-batch-stepbtn', '＋'); plus.title = '便を増やす';
      plus.onclick = () => setBatchCount(sec, rows.length + 1);
      step.appendChild(minus); step.appendChild(count); step.appendChild(plus);
      head.appendChild(step);
      // presets
      const presets = el('span', 'tt-solver-presets');
      for (const [label, def] of Object.entries(BATCH_PRESETS[sec] || {})) {
        const chip = el('button', 'tt-chip', label);
        chip.onclick = () => {
          solverState.batches[sec] = def.map((d) => ({ ...d }));
          if (!solverState.batches[sec].length) delete solverState.batches[sec];
          renderBatchEditor(); runSolver();
        };
        presets.appendChild(chip);
      }
      head.appendChild(presets);
      block.appendChild(head);

      // slider rows (hour + range + live %). Dragging one rebalances the others.
      const grid = el('div', 'tt-batch-grid');
      const sliders = []; const pcts = [];
      rows.forEach((r, i) => {
        const row = el('div', 'tt-batch-srow');
        const hIn = el('input', 'tt-mini'); hIn.type = 'number'; hIn.min = '0'; hIn.max = '30';
        hIn.value = String(r.hour); hIn.setAttribute('aria-label', `${sec} 便${i + 1} 時刻`);
        hIn.oninput = () => { r.hour = parseInt(hIn.value, 10) || 0; scheduleBatchSolve(); };
        const slider = el('input', 'tt-batch-slider'); slider.type = 'range';
        slider.min = '0'; slider.max = '100'; slider.step = '1'; slider.value = String(r.pct);
        slider.setAttribute('aria-label', `${sec} 便${i + 1} 割合`);
        const pct = el('span', 'tt-batch-pct', `${Math.round(r.pct)}%`);
        slider.oninput = () => {
          rebalance(rows, i, parseFloat(slider.value) || 0);
          sliders.forEach((s, k) => { s.value = String(rows[k].pct); });
          pcts.forEach((p, k) => { p.textContent = `${rows[k].pct}%`; });
          scheduleBatchSolve();
        };
        const del = el('button', 'tt-batch-del', '×'); del.title = 'この便を削除';
        del.onclick = () => {
          rows.splice(i, 1);
          if (!rows.length) delete solverState.batches[sec];
          else { equalSplit(rows); solverState.batches[sec] = rows; }
          renderBatchEditor(); runSolver();
        };
        row.appendChild(el('span', 'tt-batch-blabel', `便${i + 1}`));
        row.appendChild(hIn); row.appendChild(el('span', 'tt-batch-x', '時'));
        row.appendChild(slider); row.appendChild(pct); row.appendChild(del);
        sliders.push(slider); pcts.push(pct);
        grid.appendChild(row);
      });
      block.appendChild(grid);
      if (!rows.length) {
        block.appendChild(el('div', 'tt-batch-note', '随時（バッチなし）。＋で便を追加すると比率を割り当てられます。'));
      }
      elSolverBatches.appendChild(block);
    }
  }
  let batchSolveTimer = 0;
  function scheduleBatchSolve() {
    if (batchSolveTimer) clearTimeout(batchSolveTimer);
    batchSolveTimer = setTimeout(runSolver, DEBOUNCE_MS);
  }

  function ctrlField(label, control) {
    const w = el('label', 'tt-solver-field');
    w.appendChild(el('span', 'tt-solver-flabel', label));
    w.appendChild(control);
    return w;
  }
  function numInput(value, min, max, onChange) {
    const inp = el('input', 'tt-mini'); inp.type = 'number';
    inp.min = String(min); inp.max = String(max); inp.value = String(value);
    inp.oninput = () => onChange(parseInt(inp.value, 10) || 0);
    return inp;
  }

  // Dependency editor: presets + a compact per-process upstream multi-toggle.
  function renderDepEditor() {
    if (!elSolverDeps) return;
    elSolverDeps.innerHTML = '';
    elSolverDeps.appendChild(el('div', 'tt-solver-deps-title', '工程依存（前工程が供給するまで後工程は立ち上がらない）'));
    const presets = el('div', 'tt-solver-presets');
    const std = el('button', 'tt-chip', '標準フロー（入荷→格納→…→出荷）');
    std.onclick = () => { solverState.deps = cloneDeps(solverState.defaultDeps); renderDepEditor(); runSolver(); };
    const none = el('button', 'tt-chip', '依存なし（並列）');
    none.onclick = () => { solverState.deps = {}; renderDepEditor(); runSolver(); };
    presets.appendChild(std); presets.appendChild(none);
    elSolverDeps.appendChild(presets);

    const ids = (solverState.processIds && solverState.processIds.length)
      ? solverState.processIds : Object.keys(solverState.defaultDeps);
    const grid = el('div', 'tt-solver-depgrid');
    for (const pid of ids) {
      const row = el('div', 'tt-solver-deprow');
      row.appendChild(el('span', 'tt-solver-depname', pid));
      const ups = el('span', 'tt-solver-depups');
      for (const up of ids) {
        if (up === pid) continue;
        const on = (solverState.deps[pid] || []).includes(up);
        const tag = el('button', 'tt-deptoggle' + (on ? ' on' : ''), up);
        tag.title = on ? `${up} を前工程から外す` : `${up} を前工程に追加`;
        tag.onclick = () => {
          const cur = new Set(solverState.deps[pid] || []);
          if (cur.has(up)) cur.delete(up); else cur.add(up);
          solverState.deps[pid] = [...cur];
          renderDepEditor(); runSolver();
        };
        ups.appendChild(tag);
      }
      row.appendChild(ups);
      grid.appendChild(row);
    }
    elSolverDeps.appendChild(grid);
  }
  function cloneDeps(d) { const o = {}; for (const k of Object.keys(d || {})) o[k] = [...(d[k] || [])]; return o; }

  // POST the window/cap/deps/placement to the analytic solver and render.
  async function runSolver() {
    const proj = typeof o.getProject === 'function' ? o.getProject() : null;
    if (!proj) {
      if (elSolverSummary) elSolverSummary.innerHTML = '<div class="tt-info">プロジェクトを開くと、稼働窓・上限・依存からソルバーで人員を解けます。</div>';
      return;
    }
    if (elSolverSummary) elSolverSummary.innerHTML = '<div class="tt-info">ソルバー計算中…</div>';
    const body = {
      start_hour: solverState.start, end_hour: solverState.end,
      cap: solverState.cap || null, placement: solverState.placement,
      dependencies: solverState.deps,
      // Send the batch schedule once the user has touched it (seeded flag set),
      // so the backend persists/applies it; before that, let the saved one stand.
      ...(solverState._seededBatches ? { batches: solverState.batches } : {}),
    };
    let res;
    try {
      res = await api(`/api/projects/${encodeURIComponent(proj)}/timetable/solve-staffing`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (e) {
      if (elSolverSummary) elSolverSummary.innerHTML = `<div class="tt-alert"><div class="tt-alert-head">ソルバーに失敗しました</div><div>${esc(String(e.message || e))}</div></div>`;
      return;
    }
    solverResult = res;
    if (res && res.default_dependencies && !solverState._seededDeps) {
      solverState.defaultDeps = res.default_dependencies;
      solverState.processIds = (res.processes || []).map((p) => p.id);
      if (!Object.keys(solverState.deps).length) solverState.deps = cloneDeps(res.default_dependencies);
      solverState._seededDeps = true;
      renderDepEditor();
    }
    // Seed the batch editor from the persisted schedule on first solve.
    if (res && !solverState._seededBatches) {
      const saved = res.batches && typeof res.batches === 'object' ? res.batches : {};
      solverState.batches = {};
      for (const [sec, rows] of Object.entries(saved)) {
        if (Array.isArray(rows) && rows.length) {
          solverState.batches[sec] = rows.map((d) => ({ hour: d.hour, pct: d.pct }));
        }
      }
      solverState._seededBatches = true;
      renderBatchEditor();
    }
    renderSolver();
  }

  function renderSolver() {
    const r = solverResult;
    if (!r) return;
    if (r.available === false) {
      elSolverSummary.innerHTML = `<div class="tt-info">${esc(r.message || '荷役物量がまだありません。')}</div>`;
      elSolverCurve.innerHTML = '';
      return;
    }
    // Summary cards.
    const feasTone = r.feasible ? 'good' : 'bad';
    const cards = [
      ['総工数', r1(r.total_man_hours), '人時'],
      ['ピーク人数', r.peak_headcount, `名 (${r.peak_hour}時)`],
      ['終了時刻', `${r.makespan_hour}時`, ''],
      ['判定', r.feasible ? '充足' : '不足', r.feasible ? '' : `${r1(r.shortfall_man_hours)}人時`, feasTone],
    ];
    let html = '<div class="tt-kpis">';
    for (const [label, value, unit, tone] of cards) {
      html += `<div class="tt-kpi${tone ? ' ' + tone : ''}"><div class="tt-kpi-label">${esc(label)}</div>`
        + `<div class="tt-kpi-value">${esc(String(value))}${unit ? `<span class="tt-kpi-unit"> ${esc(unit)}</span>` : ''}</div></div>`;
    }
    html += '</div>';
    if (r.cap_exceeded) html += `<div class="tt-alert"><div class="tt-alert-head">⚠ 上限超過</div><div>ピーク ${r.peak_headcount}名 が上限 ${r.cap}名 を超えています。</div></div>`;
    else if (!r.feasible) html += `<div class="tt-alert"><div class="tt-alert-head">⚠ 物量未達</div><div>稼働窓・上限・依存の制約内で当日物量を処理しきれません（不足 ${r1(r.shortfall_man_hours)}人時）。窓を広げるか上限を上げてください。</div></div>`;
    elSolverSummary.innerHTML = html;
    renderSolverCurve(r);
  }

  // Per-hour headcount table (process rows × hour columns) + total row. Plain DOM
  // table (no canvas) so it always prints/scrolls and the curve change is legible.
  // Each process row leads with its 物量 + 生産性 (the two analytic drivers of the
  // headcount) so the planner reads the WHY at a glance; those two cells are jump
  // links to the screen that owns the value (物量→マテリアルフロー, 生産性→生産性試算).
  function renderSolverCurve(r) {
    const hours = r.hours || [];
    let html = '<div class="tt-section-title">時間帯別 必要人員（工程 × 時、解析ソルバー）'
      + '<span class="tt-curve-hint">物量・生産性の数値をクリックすると設定画面へ移動します</span></div>';
    html += '<div class="tt-matrix-scroll"><table class="tt-table"><thead><tr><th class="tt-rowhead">工程</th>'
      + '<th class="tt-num-h">物量/日</th><th class="tt-num-h">生産性</th>';
    for (const h of hours) html += `<th class="tt-time">${h}時</th>`;
    html += '<th class="tt-total">人時</th><th class="tt-total">終</th></tr></thead><tbody>';
    for (const p of r.processes) {
      const color = SECTION_COLOR[p.section] || 'var(--ink-tertiary,#8195a8)';
      const baseUnit = String(p.unit || '').replace('/h', '');     // 行/h → 行
      const volTxt = `${r1(p.daily_volume).toLocaleString()}${baseUnit ? ` ${esc(baseUnit)}` : ''}`;
      const prodTxt = `${r1(p.productivity).toLocaleString()} ${esc(p.unit || '')}`;
      html += `<tr><th class="tt-rowhead"><i class="tt-dot" style="background:${esc(color)}"></i>${esc(p.id)}</th>`;
      html += `<td class="tt-num tt-jump" data-jump="materialflow" data-proc="${esc(p.id)}"`
        + ` title="${esc(p.id)} の物量（${esc(p.driver || '')}）— クリックでマテリアルフローへ">${volTxt}</td>`;
      html += `<td class="tt-num tt-jump" data-jump="pickrate" data-proc="${esc(p.id)}"`
        + ` title="${esc(p.id)} の採用生産性（3段: 実測>想定>既定）— クリックで生産性試算へ">${prodTxt}</td>`;
      for (let i = 0; i < hours.length; i++) {
        const n = p.headcount_by_hour[i] || 0;
        html += `<td class="tt-cell n${Math.min(8, n)}">${n || ''}</td>`;
      }
      const fin = p.feasible ? `${p.finish_hour}時` : '✕';
      html += `<td class="tt-total">${r1(p.man_hours)}</td><td class="tt-total${p.feasible ? '' : ' bad'}">${esc(fin)}</td></tr>`;
    }
    html += '<tr class="tt-grandtotal"><th class="tt-rowhead">時刻総人数</th><td class="tt-num"></td><td class="tt-num"></td>';
    for (const n of (r.total_headcount_by_hour || [])) {
      const over = r.cap && n > r.cap;
      html += `<td class="tt-cell${over ? ' tt-cell-cursor' : ''}">${n || ''}</td>`;
    }
    html += `<td class="tt-total">${r1(r.total_man_hours)}</td><td class="tt-total">${r.makespan_hour}時</td></tr>`;
    html += '</tbody></table></div>';
    elSolverCurve.innerHTML = html;
    elSolverCurve.querySelectorAll('.tt-jump').forEach((cell) => {
      cell.onclick = () => document.dispatchEvent(
        new CustomEvent('whsim:nav', { detail: { view: cell.dataset.jump, process: cell.dataset.proc } }));
    });
  }

  // Zero-scenario state: don't throw or render a blank tab — explain + give a CTA.
  function renderEmptyState() {
    root.innerHTML = '';
    const box = el('div', 'tt-empty');
    box.appendChild(el('div', 'tt-empty-title', 'シナリオがまだありません'));
    box.appendChild(el('div', 'tt-empty-body',
      'マテリアルフローで荷役物量を作成し「タイムチャートで人員配置 →」を押すと、ここに配置計画が表示されます。'));
    const cta = el('button', 'tt-btn', 'マテリアルフローへ');
    cta.onclick = () => document.dispatchEvent(new CustomEvent('whsim:nav', { detail: { view: 'materialflow' } }));
    box.appendChild(cta);
    root.appendChild(box);
    // Even with no work-band scenario, the analytic solver can staff straight
    // from the project's volumes — so offer it here too.
    buildSolverPanel();
    runSolver();
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
    runSolver();   // solve the analytic staffing panel from the project's volumes
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
    runSolver();
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
    setLayout(l) {
      layout = l || null;
      if (result) renderStaffMap();
      // setLayout fires when the active project changes → re-solve the analytic
      // staffing panel against the new project's volumes (the deps re-seed once).
      if (elSolver) { solverState._seededDeps = false; solverState.deps = {}; runSolver(); }
    },
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
