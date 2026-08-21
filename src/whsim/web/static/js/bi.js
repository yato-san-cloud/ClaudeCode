// bi.js — 基礎物量 (volume what-if): split-screen ETL→material-flow. Left: base volumes aggregated
// in DuckDB (server) + a provisional 仮値 derivation (ケース→パレット). Right: the
// material-flow (物量→人時) that updates live as the 仮値 sliders move, drawn with
// ECharts (horizontal bar by 工程, coloured by 入荷/出荷 section, with the 平常/ピーク
// toggle). The pallet derivation is client-side so it feels instant; derived values
// are badged 推計. Comments EN; UI JA. Theme-aware (rebuilt on themechange);
// responsive (resize); reduced-motion safe.
//
// 荷姿 (load units): the 容器/台車 入数 used here are NOT this screen's private
// constants — they are a VIEW of the project's 荷姿カタログ (`whsim/loadunit.py`,
// GET/POST /api/projects/{n}/loadunits). The two sliders read the selected
// 容器/台車's capacity and write edits back, so the flow screen, the engine and
// the cost stack all see the same 入数 (ARCHITECTURE: mirrored constants must
// have ONE source). The catalogue's seeded defaults are オリコン30点 / カゴ台車14個,
// which is exactly what this screen hardcoded before — so nothing moves for a
// project that has never edited the catalogue. never-blocks: an older server
// (404), a failed fetch or no open project simply leaves the catalogue empty and
// the screen keeps the historical fixed values.
import { esc } from './util.js';
import * as echarts from 'echarts';

const reduceMotion = () => matchMedia('(prefers-reduced-motion:reduce)').matches;
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function hexAlpha(hex, a) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) h = '16C0DE';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
// Live tokens an ECharts option needs (rebuilt per render → theme-aware).
function biPalette() {
  const accent = cssVar('--accent', '#16C0DE');
  return {
    accent, inbound: cssVar('--rank-b', '#5B9BD5'),
    ink: cssVar('--ink-primary', '#37352F'),
    ink2: cssVar('--ink-secondary', 'rgba(55,53,47,0.65)'),
    ink3: cssVar('--ink-tertiary', 'rgba(55,53,47,0.45)'),
    line: cssVar('--line-hair', 'rgba(55,53,47,0.09)'),
    lineStrong: cssVar('--line-strong', 'rgba(55,53,47,0.16)'),
    panel: cssVar('--bg-app', '#FFFFFF'),
    fontMono: cssVar('--font-mono', 'monospace'), fontSans: cssVar('--font-sans', 'sans-serif'),
  };
}

// Productivity standards mirror analysis/staffing GENERIC_PROCESSES (editable
// JP-warehouse defaults). 格納 is driven by *pallets* here — the live link.
// Used ONLY as a fallback when there is no project / the work-process master
// fetch fails; otherwise the project's editable master drives the list (so a
// renamed/added/removed process flows through here too). See loadProcs().
const DEFAULT_PROCS = [
  { id: '入荷検品', sec: '入荷', driver: 'in_cases', prod: 40, unit: 'ケース/h' },
  { id: '格納', sec: '入荷', driver: 'in_pallets', prod: null, unit: 'PL/h', derived: true },
  { id: 'ピッキング', sec: '出荷', driver: 'out_lines', prod: 60, unit: '行/h' },
  { id: '検品', sec: '出荷', driver: 'out_lines', prod: 120, unit: '行/h' },
  // 梱包/出荷 are 荷姿-driven (オリコン詰め・カゴ台車積込) — the 仮値派生 numbers.
  { id: '梱包', sec: '出荷', driver: 'out_orikon', prod: 25, unit: 'OC/h' },
  { id: '出荷', sec: '出荷', driver: 'out_cages', prod: 12, unit: '台車/h' },
];

// BI-specific overrides keyed by process id. The work-process master drives
// processes off the analysis driver catalogue (in_lines/in_qty/out_lines/
// out_orders), but this 基礎物量 view runs the 仮値派生 chain (ケース→パレット→
// オリコン→カゴ台車) and pegs 格納 to *pallets* (the live putaway link). So when
// we adopt the master's list we re-map known process ids onto these BI drivers/
// productivities/units; unknown (custom) processes keep the master's own
// driver/prod/unit. This keeps the default 6-process case byte-identical to
// DEFAULT_PROCS while still reflecting renames/additions/removals.
const BI_OVERRIDES = Object.fromEntries(
  DEFAULT_PROCS.map((p) => [p.id, { driver: p.driver, prod: p.prod, unit: p.unit, derived: !!p.derived }]),
);

// Map a work-process master row → the {id,sec,driver,prod,unit,derived} shape
// this view consumes. Honours BI_OVERRIDES by id; falls back to the master's own
// fields (the API gives section/driver, and prod or productivity, and unit).
function biShape(p) {
  const ov = BI_OVERRIDES[p.id];
  const base = {
    id: p.id,
    sec: p.section || p.sec || '出荷',
    driver: p.driver || 'out_lines',
    prod: (p.prod != null ? p.prod : p.productivity) ?? null,
    unit: p.unit || '行/h',
    derived: !!p.derived,
  };
  return ov ? { ...base, ...ov } : base;
}

const fmt = (n, d = 0) => (n == null || isNaN(n) ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));

function injectStyle() {
  if (document.getElementById('bi-style')) return;
  const s = document.createElement('style');
  s.id = 'bi-style';
  s.textContent = `
  #bi.panel{overflow:auto}
  .bi{display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:1200px;margin:0 auto;
    width:100%;padding:8px 2px 28px;color:var(--ink-primary);font-family:var(--font-sans)}
  @media(max-width:880px){.bi{grid-template-columns:1fr}}
  .bi-pane{background:var(--bg-panel);border:1px solid var(--line-hair);border-radius:var(--r-lg);
    padding:16px;display:flex;flex-direction:column;gap:14px;min-width:0}
  .bi-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
  .bi-h h3{margin:0;font-family:var(--font-display);font-size:15px;font-weight:600;color:var(--ink-primary)}
  .bi-h .sub{font-size:11px;color:var(--ink-tertiary)}
  .bi-badge{font-family:var(--font-mono);font-size:9.5px;letter-spacing:.04em;padding:2px 7px;border-radius:var(--r-pill);
    border:1px solid var(--accent);color:var(--accent-ink);background:var(--accent-tint)}
  .bi-est{font-family:var(--font-mono);font-size:9px;padding:1px 6px;border-radius:var(--r-xs);
    background:var(--warn-tint);color:var(--warn-ink);border:1px solid var(--warn-line)}
  /* base metric grid */
  .bi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  .bi-m{background:var(--bg-app);border:1px solid var(--line-soft);border-radius:var(--r-md);padding:10px 11px}
  .bi-m .k{font-size:10.5px;color:var(--ink-tertiary)}
  .bi-m .v{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:18px;font-weight:700;
    color:var(--ink-primary);line-height:1.15;margin-top:3px}
  .bi-m .v .u{font-size:10px;font-weight:400;color:var(--ink-tertiary);margin-left:2px}
  /* derive card */
  .bi-derive{background:var(--bg-app);border:1px solid var(--line-soft);border-radius:var(--r-md);padding:13px 14px}
  .bi-derive .dl{font-size:12px;color:var(--ink-secondary);display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .bi-row{display:flex;align-items:center;gap:10px;margin:9px 0}
  .bi-row label{font-size:11px;color:var(--ink-secondary);flex:0 0 138px}
  .bi-row input[type=range]{flex:1;accent-color:var(--accent)}
  .bi-row select{flex:1;min-width:0;padding:5px 7px;border:1px solid var(--line-soft);
    border-radius:var(--r-sm);background:var(--bg-app);color:var(--ink-primary);font:inherit;font-size:12px}
  .bi-row select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .bi-row .rv{font-family:var(--font-mono);font-size:12px;color:var(--ink-primary);flex:0 0 92px;text-align:right}
  .bi-out{display:flex;align-items:baseline;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid var(--line-soft)}
  .bi-out .big{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:30px;font-weight:700;color:var(--accent-ink)}
  .bi-out .big .u{font-size:13px;color:var(--ink-tertiary);font-weight:400;margin-left:3px}
  .bi-chain{font-size:11px;color:var(--ink-tertiary);font-family:var(--font-mono);margin-top:6px}
  /* right: material-flow */
  .bi-sec{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-tertiary);
    margin:6px 0 2px;font-family:var(--font-mono)}
  .bi-proc{display:flex;align-items:center;gap:10px;background:var(--bg-app);border:1px solid var(--line-soft);
    border-radius:var(--r-md);padding:10px 12px;transition:border-color var(--dur-2) var(--ease-out)}
  .bi-proc.derived{border-left:3px solid var(--accent)}
  .bi-proc .pn{flex:1;min-width:0}
  .bi-proc .pn b{font-size:13px;font-weight:600;color:var(--ink-primary)}
  .bi-proc .pn .pv{font-size:10.5px;color:var(--ink-tertiary);font-family:var(--font-mono)}
  .bi-proc .mh{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:17px;font-weight:700;
    color:var(--ink-primary);text-align:right}
  .bi-proc .mh .u{font-size:10px;color:var(--ink-tertiary);font-weight:400;margin-left:2px}
  .bi-bar{height:5px;border-radius:var(--r-xs);background:var(--line-hair);overflow:hidden;margin-top:6px}
  .bi-bar i{display:block;height:100%;background:var(--accent);border-radius:var(--r-xs);transition:width var(--dur-2) var(--ease-out)}
  .bi-total{display:flex;justify-content:space-between;align-items:baseline;padding:10px 12px;
    border-top:1px solid var(--line-hair);margin-top:4px}
  .bi-total .tv{font-family:var(--font-mono);font-size:16px;font-weight:700;color:var(--ink-primary)}
  .bi-empty{color:var(--ink-tertiary);text-align:center;padding:28px}
  /* error/retry state: never leave the view stuck on a spinner/blank */
  .bi-err{display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;
    padding:32px 20px;color:var(--ink-secondary)}
  .bi-err .bi-err-msg{font-size:13px;color:var(--ink-secondary)}
  .bi-err .bi-err-detail{font-family:var(--font-mono);font-size:10.5px;color:var(--ink-tertiary)}
  .bi-retry{padding:8px 18px;border:1px solid var(--accent);border-radius:var(--r-md);
    background:var(--accent);color:var(--ink-onAccent);font:inherit;font-weight:700;cursor:pointer;
    transition:background var(--dur-1) var(--ease-out)}
  .bi-retry:hover{background:var(--accent-hover)}
  .bi-retry:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  @media (prefers-reduced-motion: reduce){ .bi-retry{transition:none} }
  /* drill-context focus: gently emphasize the control the 対話分析 sent us to */
  .bi-focus{box-shadow:0 0 0 2px var(--accent);border-radius:var(--r-md);
    transition:box-shadow var(--dur-2) var(--ease-out)}
  @media (prefers-reduced-motion: reduce){ .bi-bar i,.bi-proc,.bi-focus{transition:none} }
  /* 基礎物量 → タイムチャート CTA (the next-step of this view) */
  .bi-apply{margin-top:14px;padding:12px 14px;border:1px solid var(--ok-line,rgba(52,227,160,.3));
    border-left:4px solid var(--ok,#34c97a);border-radius:12px;
    background:var(--ok-tint,rgba(52,227,160,.07));display:flex;flex-direction:column;gap:9px}
  .bi-apply-t{font-size:11.5px;color:var(--ink-secondary)}
  .bi-apply-btn{align-self:flex-start;padding:9px 16px;border:none;border-radius:10px;
    background:var(--accent);color:var(--ink-onAccent,#04222c);font:inherit;font-weight:700;cursor:pointer}
  .bi-apply-btn:hover{background:var(--accent-hover)}
  .bi-apply-btn:disabled{opacity:.55;cursor:wait}
  /* 稼働日カレンダ weekday toggles */
  .bi-cal{display:flex;gap:5px;flex-wrap:wrap;margin:2px 0 4px}
  .bi-wd{width:30px;height:30px;border-radius:8px;border:1px solid var(--line-strong,rgba(120,140,170,.4));
    background:var(--accent-tint-2,rgba(22,192,222,.12));color:var(--ink-primary);font:inherit;font-size:12px;
    font-weight:700;cursor:pointer;transition:background var(--dur-1) var(--ease-out)}
  .bi-wd:hover{border-color:var(--accent)}
  .bi-wd.off{background:transparent;color:var(--ink-tertiary);border-style:dashed;text-decoration:line-through}
  @media (prefers-reduced-motion: reduce){ .bi-wd{transition:none} }
  `;
  document.head.appendChild(s);
}

export function mountBI(el, opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const toast = opts.toast || (() => {});
  // Optional drill-context: the 対話分析 view navigates here and may pass a focus
  // hint (e.g. {peak:true} or {abc:'A'}). app.js wires opts.getFocus; refresh()
  // can also take an explicit focus. Fully backward-compatible: no focus = today.
  const getFocus = typeof opts.getFocus === 'function' ? opts.getFocus : (() => null);
  let pendingFocus = null;  // focus to honour on the next render
  const root = document.createElement('div');
  el.innerHTML = '';
  el.appendChild(root);

  // ── right-pane ECharts (material-flow man-hours bar) ──────────────────
  let flowChart = null;
  let ro = null;
  function disposeChart() { if (flowChart) { try { flowChart.dispose(); } catch (_) { /* noop */ } flowChart = null; } }
  const resizeChart = () => { if (flowChart) { try { flowChart.resize(); } catch (_) { /* noop */ } } };
  window.addEventListener('resize', resizeChart);
  if (typeof ResizeObserver !== 'undefined') ro = new ResizeObserver(() => resizeChart());
  function onThemeChange() { if (vol && flowChart) drawFlowChart(); }
  document.addEventListener('themechange', onThemeChange);

  let vol = null;       // base volumes from DuckDB
  let procs = DEFAULT_PROCS.slice();  // work-process master (project's editable list; DEFAULT_PROCS = fallback)
  let loadErr = null;   // last load() failure (null = none); drives the retry state
  let cpp = 40;         // 仮値: cases per pallet
  let palletProd = 18;  // 仮値: 格納 productivity (PL/h)
  let qtyPerCase = 0;   // 仮値: pieces per case (行→ピース / ケース→ピース検算); 0 = seed from data
  let linesPerOrder = 0;// 仮値: lines per order (受注→出荷ライン); 0 = seed from data
  let peak = 1.0;       // 仮値: peak-day factor (日量→ピーク係数)
  let showPeak = false; // right pane: 平常 vs ピーク toggle
  // 荷姿の 入数. Seeded with the catalogue's own defaults so the screen shows the
  // historical numbers even before /loadunits answers (or when it never does).
  let piecesPerOrikon = 30; // 仮値: 容器の入数 (点/容器) — 選択中の容器の capacity.piece
  let unitsPerCage = 14;    // 仮値: 台車の積載 (容器/台) — 選択中の台車の capacity[容器]
  const nonworking = new Set(); // 非稼働日 weekday indices (0=月 … 6=日)

  // ---- 荷姿カタログ (ONE source: whsim/loadunit.py) -----------------------
  let units = [];           // [{id,name,kind,capacity,footprint_m2,provisional}]; [] = 未取得
  let containerRef = '';    // 選択中の容器 id ('' = カタログ未取得)
  let carrierRef = '';      // 選択中の台車 id ('' = カタログ未取得)
  let caseCap = 0;          // 選択台車のケース積載 (0 = 容器と同じ積載数とみなす)
  let carrierCapSet = true; // 台車にこの容器の積載数があるか (無い＝積めない、サーバと同じ扱い)
  let unitsNote = '';       // カタログ由来の注記 (入数/積載数が未設定 など)
  let serverConv = null;    // GET /loadunits/convert の応答 (chain を借りるため)

  const unitById = (id) => units.find((u) => u && u.id === id) || null;
  const unitName = (id) => { const u = unitById(id); return (u && u.name) || String(id || ''); };
  const capOf = (u, held) => {
    const v = u && u.capacity ? Number(u.capacity[held]) : 0;
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const containerOpts = () => units.filter((u) => u && u.kind === 'container');
  // 台車: カゴ台車/6輪カート/平台車. カタログに台車が1つも無ければパレットで代替する。
  const carrierOpts = () => {
    const c = units.filter((u) => u && u.kind === 'carrier');
    return c.length ? c : units.filter((u) => u && u.kind === 'pallet');
  };
  // The catalogue is usable only when it actually offers a 容器 AND a 台車;
  // otherwise the view stays on its historical fixed values.
  const hasCatalog = () => !!(units.length && containerRef && carrierRef);
  // Short unit label for the chain/readouts. オリコン keeps its historical 「OC」.
  const ocLabel = () => (hasCatalog() && containerRef !== 'orikon' ? unitName(containerRef) : 'OC');

  // Resolve the selected 容器/台車 out of the catalogue and mirror their 入数 onto
  // the two sliders. Defaults land on オリコン/カゴ台車 (capacity 30 / 14), so the
  // displayed numbers are the ones this screen has always shown.
  function syncFromCatalog() {
    unitsNote = '';
    carrierCapSet = true;
    if (!units.length) { containerRef = ''; carrierRef = ''; caseCap = 0; return; }
    const cs = containerOpts(), ks = carrierOpts();
    if (!cs.some((u) => u.id === containerRef)) containerRef = ((cs.find((u) => u.id === 'orikon') || cs[0] || {}).id) || '';
    if (!ks.some((u) => u.id === carrierRef)) carrierRef = ((ks.find((u) => u.id === 'cage') || ks[0] || {}).id) || '';
    const c = unitById(containerRef);
    if (c) {
      const v = capOf(c, 'piece');
      if (v > 0) piecesPerOrikon = v;
      else unitsNote = `「${c.name}」の入数が未設定です。スライダーを動かすと設定できます。`;
    }
    const k = unitById(carrierRef);
    caseCap = k ? capOf(k, 'case') : 0;
    if (k) {
      const v = capOf(k, containerRef);
      if (v > 0) unitsPerCage = v;
      else {
        carrierCapSet = false;
        unitsNote = `「${k.name}」に「${unitName(containerRef)}」の積載数が未設定です。スライダーを動かすと設定できます。`;
      }
    }
  }

  // 台車の台数. 容器とケースの積載数が同じときは従来どおり「(容器＋ケース)÷積載数」で、
  // 違うときはサーバ (loadunit.pack) と同じ「積載率の合計」で満杯を判定する。
  // 既定 (14/14) は前者に落ちるので、これまでの台数と1台も動かない。
  function cagesFor(containers, cases) {
    const capC = (carrierCapSet && unitsPerCage > 0) ? unitsPerCage : 0;
    const capK = caseCap > 0 ? caseCap : capC;
    if (capC <= 0 && capK <= 0) return 0;
    if (capC === capK) {
      const load = (containers || 0) + (cases || 0);
      return load > 0 ? Math.ceil(load / capC) : 0;
    }
    let occ = 0;
    if (capC > 0 && containers > 0) occ += containers / capC;
    if (capK > 0 && cases > 0) occ += cases / capK;
    return occ > 0 ? Math.ceil(occ - 1e-9) : 0;
  }

  // Seed 仮値 from server volumes once, so sliders open near the real numbers.
  function seedRecipes() {
    if (!vol) return;
    if (!qtyPerCase) {
      const q = Number(vol.avg_case_qty);
      qtyPerCase = q > 0 ? Math.round(q) : 12;
    }
    if (!linesPerOrder) {
      const lpo = (vol.out_orders > 0) ? (vol.out_lines || 0) / vol.out_orders : 0;
      linesPerOrder = lpo > 0 ? Math.max(1, Math.round(lpo * 10) / 10) : 1.5;
    }
  }

  function derived() {
    const inCases = (vol && vol.in_cases) || 0;
    const inPallets = cpp > 0 ? Math.ceil(inCases / cpp) : 0;
    // 行→ピース: complete pieces from lines×入数, or 検算 if pieces already exist.
    const outLines = (vol && vol.out_lines) || 0;
    const piecesFromLines = Math.round(outLines * qtyPerCase);
    const piecesActual = (vol && vol.out_pieces) || 0;
    // 受注→出荷ライン: complete lines from orders×明細数 when lines are missing.
    const outOrders = (vol && vol.out_orders) || 0;
    const linesFromOrders = Math.round(outOrders * linesPerOrder);
    // ケース→ピース 検算: out_pieces ≈ out_cases × 入数.
    const outCases = (vol && vol.out_cases) || 0;
    const piecesFromCases = Math.round(outCases * qtyPerCase);
    // 出荷側荷姿: バラピース → オリコン → (＋ケース) → カゴ台車。
    // ピース実績が無ければ 行×入数 の補完値で派生する（never blocks）。
    const effPieces = piecesActual > 0 ? piecesActual : piecesFromLines;
    const outOrikon = piecesPerOrikon > 0 ? Math.ceil(effPieces / piecesPerOrikon) : 0;
    const cageLoad = outOrikon + outCases;
    const outCages = cagesFor(outOrikon, outCases);
    return {
      inPallets, putawayMh: palletProd > 0 ? inPallets / palletProd : 0,
      piecesFromLines, piecesActual, linesFromOrders, piecesFromCases,
      effPieces, outOrikon, cageLoad, outCages,
    };
  }

  // Per-process daily volume + man-hours. 格納 is pallet-driven (the live link).
  function processes() {
    const d = derived();
    const drv = {
      in_cases: (vol && vol.in_cases) || 0,
      in_pallets: d.inPallets,
      out_lines: (vol && vol.out_lines) || 0,
      out_orders: (vol && vol.out_orders) || 0,
      out_orikon: d.outOrikon,
      out_cages: d.outCages,
    };
    return procs.map((p) => {
      const v = drv[p.driver] || 0;
      const prod = p.derived ? palletProd : p.prod;
      const mh = prod > 0 ? v / prod : 0;
      // 日量→ピーク係数: scale to a peak-day staffing assumption.
      const mhPeak = mh * peak;
      return { ...p, volume: v, prod, man_hours: mh, man_hours_peak: mhPeak };
    });
  }

  // 換算式の1行. サーバ (GET /loadunits/convert) が返す `chain` を優先し、式を
  // JS で二重実装しない。サーバの台数がこの画面の台数と食い違うとき（保存前の
  // スライダー操作中など）は、数字がちぐはぐに見えないよう従来の式に戻す。
  function chainText(d) {
    const outCases = (vol && vol.out_cases) || 0;
    if (serverConv && serverConv.chain
        && Math.round(Number(serverConv.containers) || 0) === Math.round(d.outOrikon)
        && Math.round(Number(serverConv.carriers) || 0) === Math.round(d.outCages)) {
      return serverConv.chain;
    }
    const capC = (carrierCapSet && unitsPerCage > 0) ? unitsPerCage : 0;
    const capK = caseCap > 0 ? caseCap : capC;
    const oc = ocLabel();
    const head = `バラ ${fmt(d.effPieces)} 点 ÷ ${piecesPerOrikon} = ${fmt(d.outOrikon)} ${oc}`;
    if (capC === capK) {
      return `${head} →（＋ケース ${fmt(outCases)}）÷ ${unitsPerCage} = ${fmt(d.outCages)} 台`;
    }
    const parts = [];
    if (capC > 0) parts.push(`${oc} ${fmt(d.outOrikon)}（積載${capC}）`);
    if (capK > 0) parts.push(`ケース ${fmt(outCases)}（積載${capK}）`);
    return `${head} → ${parts.join(' ＋ ')} = ${fmt(d.outCages)} 台`;
  }

  // Repaint the 容器/台車 outputs (+ the right pane) from a derived() snapshot.
  const refreshCageOut = (d) => {
    setHTML('#bi-oc', `${fmt(d.outOrikon)}<span class="u">${esc(ocLabel())}</span>`);
    setHTML('#bi-cage', `${fmt(d.outCages)}<span class="u">台</span>`);
    setText('#bi-cage-chain', chainText(d));
    repaintRight();
  };

  // Read the 荷姿カタログ. A 404 (older server), a failed fetch or no open project
  // leaves it empty — the screen then keeps its historical fixed 入数 (never blocks).
  async function loadUnits() {
    const name = getProject();
    if (!name) { units = []; syncFromCatalog(); return; }
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(name)}/loadunits`);
      if (!r.ok) throw new Error(r.statusText || `HTTP ${r.status}`);
      const data = await r.json();
      units = Array.isArray(data && data.units) ? data.units.filter((u) => u && u.id) : [];
    } catch (_e) {
      units = [];   // 旧サーバ/未接続: 従来の固定値のまま
    }
    syncFromCatalog();
  }

  // Write the slider values back into the catalogue and persist them, so the 入数
  // the rest of the app uses IS the one shown here. Debounced (a drag emits many
  // events); a failed POST is swallowed — the view keeps working, unsaved.
  let saveTimer = 0;
  function saveCatalog() {
    const name = getProject();
    if (!name || !hasCatalog()) return;
    const c = unitById(containerRef);
    if (c) c.capacity = { ...(c.capacity || {}), piece: piecesPerOrikon };
    // Only write the 台車's 積載数 once it is actually set (the slider sets it):
    // a 容器入数 edit must not invent an 積載数 the catalogue never had.
    const k = unitById(carrierRef);
    if (k && carrierCapSet) k.capacity = { ...(k.capacity || {}), [containerRef]: unitsPerCage };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = 0;
      try {
        const r = await fetch(`/api/projects/${encodeURIComponent(name)}/loadunits`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ units }),
        });
        if (!r.ok) throw new Error(r.statusText || `HTTP ${r.status}`);
        const data = await r.json();
        if (data && Array.isArray(data.units) && data.units.length) {
          units = data.units.filter((u) => u && u.id);
          syncFromCatalog();
        }
        // ③設計フローなど、同じカタログを見ている画面へ通知する (source で自分の
        // 変更は無視できるようにする — 操作中に再描画で入力が飛ばないように)。
        document.dispatchEvent(new CustomEvent('whsim:loadunits-changed', { detail: { source: 'bi' } }));
        fetchChain();
      } catch (_e) { /* 未接続: 画面の値はそのまま (保存されないだけ) */ }
    }, 500);
  }

  // Borrow the server's own conversion string (so the formula lives in one place).
  // Debounced; any failure just leaves the locally built chain in place.
  let chainTimer = 0;
  function fetchChain() {
    const name = getProject();
    serverConv = null;
    if (!name || !hasCatalog() || !vol) return;
    if (chainTimer) clearTimeout(chainTimer);
    chainTimer = setTimeout(async () => {
      chainTimer = 0;
      const d = derived();
      const q = `pieces=${encodeURIComponent(d.effPieces)}`
        + `&cases=${encodeURIComponent((vol && vol.out_cases) || 0)}`
        + `&container=${encodeURIComponent(containerRef)}`
        + `&carrier=${encodeURIComponent(carrierRef)}`;
      try {
        const r = await fetch(`/api/projects/${encodeURIComponent(name)}/loadunits/convert?${q}`);
        if (!r.ok) throw new Error(r.statusText || `HTTP ${r.status}`);
        const data = await r.json();
        if (data && typeof data.chain === 'string' && data.chain) {
          serverConv = data;
          setText('#bi-cage-chain', chainText(derived()));
        }
      } catch (_e) { /* 旧サーバ/未接続: 従来の式のまま */ }
    }, 350);
  }

  // Token-styled error + retry: if a fetch failed, show a recoverable message
  // with a 再試行 button that re-runs load(); never leave a stuck spinner/blank.
  function renderError() {
    root.innerHTML = `
      <div class="bi-err" role="alert">
        <div class="bi-err-msg">読み込めませんでした</div>
        ${loadErr ? `<div class="bi-err-detail">${esc(loadErr)}</div>` : ''}
        <button type="button" class="bi-retry" id="bi-retry">再試行</button>
      </div>`;
    const btn = root.querySelector('#bi-retry');
    if (btn) btn.onclick = () => { loadErr = null; vol = null; render(); load(); };
  }

  function render() {
    // Any branch below rewrites root.innerHTML, orphaning the right-pane canvas;
    // dispose it up-front so a re-render never leaks an ECharts instance.
    disposeChart();
    if (!getProject()) { root.innerHTML = '<div class="bi-empty">プロジェクトを選択してください。</div>'; return; }
    if (loadErr) { renderError(); return; }
    if (!vol) { root.innerHTML = '<div class="bi-empty">物量を集計中…</div>'; return; }
    seedRecipes();
    const d = derived();
    const procs = processes();
    const mhKey = (p) => (showPeak ? p.man_hours_peak : p.man_hours);
    const maxMh = Math.max(1, ...procs.map(mhKey));
    const totalMh = procs.reduce((s, p) => s + mhKey(p), 0);
    const estOut = vol.out_estimated ? '<span class="bi-est">推計</span>' : '';
    const estIn = vol.in_estimated ? '<span class="bi-est">推計</span>' : '';

    const baseGrid = `
      <div class="bi-grid">
        <div class="bi-m"><div class="k">出荷 行数/日</div><div class="v">${fmt(vol.out_lines)}<span class="u">行</span></div></div>
        <div class="bi-m"><div class="k">出荷 ピース/日</div><div class="v">${fmt(vol.out_pieces)}<span class="u">点</span></div></div>
        <div class="bi-m"><div class="k">出荷 オーダー/日</div><div class="v">${fmt(vol.out_orders)}<span class="u">件</span></div></div>
        <div class="bi-m"><div class="k">出荷 ケース/日</div><div class="v">${fmt(vol.out_cases)}<span class="u">c</span></div></div>
        <div class="bi-m"><div class="k">入荷 ケース/日 ${estIn}</div><div class="v">${fmt(vol.in_cases)}<span class="u">c</span></div></div>
        <div class="bi-m"><div class="k">平均入数</div><div class="v">${fmt(vol.avg_case_qty, 1)}<span class="u">点/c</span></div></div>
      </div>`;

    // 稼働日カレンダ: mark 非稼働日 (曜日) → その分の物量を稼働日に寄せ、/日 を再計算.
    const WDLABEL = ['月', '火', '水', '木', '金', '土', '日'];
    const calendarCard = `
      <div class="bi-derive">
        <div class="dl">稼働日カレンダ（非稼働日を除外し物量を稼働日へ寄せる）</div>
        <div class="bi-cal">
          ${WDLABEL.map((lab, i) => `<button type="button" class="bi-wd${nonworking.has(i) ? ' off' : ''}"
            data-wd="${i}" aria-pressed="${nonworking.has(i)}" title="${nonworking.has(i) ? '非稼働' : '稼働'}">${lab}</button>`).join('')}
        </div>
        <div class="bi-chain">稼働日 <b>${fmt(vol.working_days)}日</b>分の平均で表示中。
          ${nonworking.size ? `${Array.from(nonworking).sort().map((i) => WDLABEL[i]).join('・')}曜を非稼働として除外。` : '土日や祝日のボタンを押すと、その日の物量を稼働日に振り分けて再計算します。'}</div>
      </div>`;

    const deriveCard = `
      <div class="bi-derive">
        <div class="dl">ケース → パレット（仮値で派生）<span class="bi-est">推計</span></div>
        <div class="bi-row">
          <label>パレット積載数(仮値)</label>
          <input type="range" id="bi-cpp" min="10" max="80" step="1" value="${cpp}">
          <span class="rv" id="bi-cpp-v">${cpp} c/PL</span>
        </div>
        <div class="bi-row">
          <label>格納 生産性(仮値)</label>
          <input type="range" id="bi-pp" min="8" max="30" step="1" value="${palletProd}">
          <span class="rv" id="bi-pp-v">${palletProd} PL/h</span>
        </div>
        <div class="bi-out">
          <div><div class="k" style="font-size:10.5px;color:var(--ink-tertiary)">入荷パレット数/日</div>
            <div class="big" id="bi-pallets">${fmt(d.inPallets)}<span class="u">PL</span></div></div>
          <div style="margin-left:auto;text-align:right"><div class="k" style="font-size:10.5px;color:var(--ink-tertiary)">格納 人時</div>
            <div class="big" id="bi-putmh" style="font-size:22px">${fmt(d.putawayMh, 1)}<span class="u">人時</span></div></div>
        </div>
        <div class="bi-chain" id="bi-chain">入荷ケース ${fmt(vol.in_cases)} ÷ ${cpp} = ${fmt(d.inPallets)} PL → ÷ ${palletProd} PL/h = ${fmt(d.putawayMh, 1)} 人時</div>
      </div>`;

    // 行 → ピース: complete pieces from lines×入数, or 検算 against the actual.
    const hasPieces = (vol.out_pieces || 0) > 0;
    const linesPiecesOut = hasPieces
      ? `<div class="bi-out"><div><div class="k" style="font-size:10.5px;color:var(--ink-tertiary)">実績ピース/日</div>
            <div class="big" style="font-size:22px">${fmt(d.piecesActual)}<span class="u">点</span></div></div>
          <div style="margin-left:auto;text-align:right"><div class="k" style="font-size:10.5px;color:var(--ink-tertiary)">検算（行×入数）</div>
            <div class="big" id="bi-lp" style="font-size:22px">${fmt(d.piecesFromLines)}<span class="u">点</span></div></div></div>`
      : `<div class="bi-out"><div><div class="k" style="font-size:10.5px;color:var(--ink-tertiary)">出荷ピース/日（補完）</div>
            <div class="big" id="bi-lp">${fmt(d.piecesFromLines)}<span class="u">点</span></div></div></div>`;
    const linesPiecesCard = `
      <div class="bi-derive">
        <div class="dl">行 → ピース（仮値で${hasPieces ? '検算' : '補完'}）<span class="bi-est">推計</span></div>
        <div class="bi-row">
          <label>1行あたり入数(仮値)</label>
          <input type="range" id="bi-qpc" min="1" max="48" step="1" value="${qtyPerCase}">
          <span class="rv" id="bi-qpc-v">${qtyPerCase} 点/行</span>
        </div>
        ${linesPiecesOut}
        <div class="bi-chain" id="bi-lp-chain">出荷行 ${fmt(vol.out_lines)} × ${qtyPerCase} 点 = ${fmt(d.piecesFromLines)} 点${hasPieces ? `（実績 ${fmt(d.piecesActual)} 点との差 ${fmt(d.piecesFromLines - d.piecesActual)} 点）` : ''}</div>
      </div>`;

    // 受注 → 出荷ライン: complete lines from orders×明細数 (補完 when lines missing).
    const linesMissing = (vol.out_lines || 0) <= 0;
    const ordersLinesCard = `
      <div class="bi-derive">
        <div class="dl">受注 → 出荷ライン（仮値で${linesMissing ? '補完' : '検算'}）<span class="bi-est">推計</span></div>
        <div class="bi-row">
          <label>1受注あたり明細数(仮値)</label>
          <input type="range" id="bi-lpo" min="1" max="20" step="0.1" value="${linesPerOrder}">
          <span class="rv" id="bi-lpo-v">${fmt(linesPerOrder, 1)} 行/件</span>
        </div>
        <div class="bi-out">
          <div><div class="k" style="font-size:10.5px;color:var(--ink-tertiary)">出荷行/日（受注×明細数）</div>
            <div class="big" id="bi-lo" style="font-size:24px">${fmt(d.linesFromOrders)}<span class="u">行</span></div></div>
          ${linesMissing ? '' : `<div style="margin-left:auto;text-align:right"><div class="k" style="font-size:10.5px;color:var(--ink-tertiary)">実績行/日</div>
            <div class="big" style="font-size:22px">${fmt(vol.out_lines)}<span class="u">行</span></div></div>`}
        </div>
        <div class="bi-chain" id="bi-lo-chain">出荷オーダー ${fmt(vol.out_orders)} × ${fmt(linesPerOrder, 1)} 行 = ${fmt(d.linesFromOrders)} 行${linesMissing ? '' : `（実績 ${fmt(vol.out_lines)} 行との差 ${fmt(d.linesFromOrders - (vol.out_lines || 0))} 行）`}</div>
      </div>`;

    // ケース → ピース 検算: out_pieces ≈ out_cases × 入数 (shares 入数 slider).
    const casePiecesCard = ((vol.out_cases || 0) > 0 && hasPieces) ? `
      <div class="bi-derive">
        <div class="dl">ケース → ピース 検算<span class="bi-est">推計</span></div>
        <div class="bi-out">
          <div><div class="k" style="font-size:10.5px;color:var(--ink-tertiary)">実績ピース/日</div>
            <div class="big" style="font-size:22px">${fmt(d.piecesActual)}<span class="u">点</span></div></div>
          <div style="margin-left:auto;text-align:right"><div class="k" style="font-size:10.5px;color:var(--ink-tertiary)">ケース×入数</div>
            <div class="big" id="bi-cp" style="font-size:22px">${fmt(d.piecesFromCases)}<span class="u">点</span></div></div>
        </div>
        <div class="bi-chain" id="bi-cp-chain">出荷ケース ${fmt(vol.out_cases)} × ${qtyPerCase} 点 = ${fmt(d.piecesFromCases)} 点（実績との差 ${fmt(d.piecesFromCases - d.piecesActual)} 点）</div>
      </div>` : '';

    // ピース → 容器 → 台車: 出荷側の荷姿変換（データに無い前提条件を仮値で作る）。
    // 物量分析ツールの「梱包形態と入数」「搬送形態」に相当する whsim 版。どの容器/
    // 台車で見積もるかは 荷姿カタログ から選び、入数はそのカタログの値そのもの。
    const cat = hasCatalog();
    const contLabel = cat ? unitName(containerRef) : 'オリコン';
    const carrLabel = cat ? unitName(carrierRef) : 'カゴ台車';
    const ocU = ocLabel();
    const carrCapView = (carrierCapSet && unitsPerCage > 0) ? unitsPerCage : (unitsPerCage || 14);
    const pickRow = (id, label, opts, cur) => `
        <div class="bi-row">
          <label>${esc(label)}</label>
          <select id="${id}">${opts.map((u) => `<option value="${esc(u.id)}"${u.id === cur ? ' selected' : ''}>${esc(u.name || u.id)}</option>`).join('')}</select>
        </div>`;
    const cageCard = `
      <div class="bi-derive">
        <div class="dl">ピース → ${esc(contLabel)} → ${esc(carrLabel)}（出荷荷姿の仮値）<span class="bi-est">推計</span></div>
        ${cat ? pickRow('bi-cont', '容器（何に入れるか）', containerOpts(), containerRef) : ''}
        ${cat ? pickRow('bi-carr', '台車（何に載せるか）', carrierOpts(), carrierRef) : ''}
        <div class="bi-row">
          <label>${esc(contLabel)}入数(仮値)</label>
          <input type="range" id="bi-ppo" min="${Math.min(5, piecesPerOrikon)}" max="${Math.max(80, piecesPerOrikon)}" step="1" value="${piecesPerOrikon}">
          <span class="rv" id="bi-ppo-v">${piecesPerOrikon} 点/${esc(ocU)}</span>
        </div>
        <div class="bi-row">
          <label>${esc(carrLabel)}積載(仮値)</label>
          <input type="range" id="bi-upc" min="${Math.min(4, carrCapView)}" max="${Math.max(32, carrCapView)}" step="1" value="${carrCapView}">
          <span class="rv" id="bi-upc-v">${carrCapView} 個/台</span>
        </div>
        <div class="bi-out">
          <div><div class="k" style="font-size:10.5px;color:var(--ink-tertiary)">${esc(contLabel)}数/日</div>
            <div class="big" id="bi-oc">${fmt(d.outOrikon)}<span class="u">${esc(ocU)}</span></div></div>
          <div style="margin-left:auto;text-align:right"><div class="k" style="font-size:10.5px;color:var(--ink-tertiary)">出荷${esc(carrLabel)}数/日</div>
            <div class="big" id="bi-cage" style="font-size:24px">${fmt(d.outCages)}<span class="u">台</span></div></div>
        </div>
        <div class="bi-chain" id="bi-cage-chain">${esc(chainText(d))}</div>
        ${(cat && caseCap > 0 && carrierCapSet && caseCap !== unitsPerCage)
          ? `<div class="bi-chain">ケースは1台あたり ${caseCap} 個で積みます（${esc(carrLabel)}の積載数）。</div>` : ''}
        ${unitsNote ? `<div class="bi-chain">${esc(unitsNote)}</div>` : ''}
        ${cat ? '<div class="bi-chain">入数はプロジェクトの荷姿カタログの値です。ここでの変更は設計フローや原価にも反映されます。</div>' : ''}
      </div>`;

    // 日量 → ピーク係数: scales the right-pane man-hours to a peak-day assumption.
    const peakCard = `
      <div class="bi-derive">
        <div class="dl">日量 → ピーク係数（仮値で人時をスケール）<span class="bi-est">推計</span></div>
        <div class="bi-row">
          <label>ピーク係数(仮値)</label>
          <input type="range" id="bi-peak" min="1" max="2" step="0.05" value="${peak}">
          <span class="rv" id="bi-peak-v">×${fmt(peak, 2)}</span>
        </div>
        <div class="bi-row">
          <label>右の人時表示</label>
          <label style="flex:1;display:flex;align-items:center;gap:6px;font-size:11px">
            <input type="checkbox" id="bi-peak-tog" ${showPeak ? 'checked' : ''} style="flex:0 0 auto;accent-color:var(--accent)">
            ピーク日で表示（×${fmt(peak, 2)}）
          </label>
        </div>
        <div class="bi-chain">合計人時にピーク係数を乗じ、ピーク日の必要人員を見積もります。</div>
      </div>`;

    root.innerHTML = `
      <section class="bi-pane">
        <div class="bi-h"><h3>基礎物量</h3><span class="sub">取込→集計→仮値で派生</span>
          ${(vol.working_days || 1) > 1 ? `<span class="bi-badge">稼動日 ${fmt(vol.working_days)}日の平均</span>` : ''}
          <span class="bi-badge" style="margin-left:auto">${esc(vol.engine || 'DuckDB')}</span></div>
        ${baseGrid}
        ${calendarCard}
        ${deriveCard}
        ${linesPiecesCard}
        ${ordersLinesCard}
        ${casePiecesCard}
        ${cageCard}
        ${peakCard}
        <div class="bi-chain">※ 派生値は実値が無いため仮値で派生／補完。実データが入れば差し替わります（provenance＝生成・推計）。</div>
      </section>
      <section class="bi-pane" id="bi-right">
        ${rightHeader()}
        ${renderFlow(procs, maxMh, totalMh)}
        <div class="bi-apply">
          <div class="bi-apply-t">この基礎物量（仮値ごと）を保存し、人員タイムチャートに展開します。</div>
          <button type="button" class="bi-apply-btn" id="bi-apply-btn">💾 基礎物量を保存 → タイムチャートで人員配置 →</button>
        </div>
      </section>`;

    wire();
    drawFlowChart();   // paint the right-pane man-hours bar
    applyFocus();
  }

  // Resolve a focus hint (explicit pending one wins, else opts.getFocus()) and,
  // if present, gently highlight + scroll the relevant control into view. Used
  // by the 対話分析 drill-down; a no-op when no focus is provided.
  function applyFocus() {
    const focus = pendingFocus || getFocus() || null;
    pendingFocus = null;
    if (!focus || typeof focus !== 'object') return;
    let target = null;
    if (focus.peak) {
      // emphasize the ピーク係数 control (slider + 平常/ピーク toggle).
      target = root.querySelector('#bi-peak') || root.querySelector('#bi-peak-tog');
    } else if (focus.abc) {
      // ABC drill: highlight the right-pane material-flow so the user lands on
      // the per-process 人時 breakdown the ABC analysis pointed at.
      target = root.querySelector('#bi-right');
    }
    if (!target) return;
    const card = target.closest('.bi-derive, .bi-pane') || target;
    card.classList.add('bi-focus');
    try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_e) { /* older browsers */ }
    setTimeout(() => card.classList.remove('bi-focus'), 1800);
  }

  function rightHeader() {
    const mode = showPeak ? `ピーク日 ×${fmt(peak, 2)}` : '平常日';
    return `<div class="bi-h"><h3>マテリアルフロー</h3><span class="sub">物量 → 人時（仮値とライブ連動・${mode}）</span></div>`;
  }

  // The right pane now hosts an ECharts horizontal-bar of 人時 by 工程; this
  // returns the chart mount node + the total row. drawFlowChart() fills the canvas.
  function renderFlow(procs, maxMh, totalMh) {
    void procs; void maxMh;
    const totalLabel = showPeak ? `合計 必要人時/日（ピーク ×${fmt(peak, 2)}）` : '合計 必要人時/日';
    return `
      <div class="bi-flow-chart" data-bi-flow style="width:100%;height:300px"></div>
      <div class="bi-total"><span>${totalLabel}</span><span class="tv" id="bi-totalmh">${fmt(totalMh, 1)} 人時</span></div>`;
  }

  function driverUnit(dr) {
    return { in_cases: 'ケース', in_pallets: 'PL', out_lines: '行', out_orders: '件',
             out_orikon: 'OC', out_cages: '台車' }[dr] || '';
  }

  // Build/refresh the right-pane man-hours bar from the current procs. Inbound vs
  // outbound 工程 are coloured distinctly; the peak-aware key drives the values so
  // the ピーク toggle/slider reflect immediately. 格納 (derived) is marked.
  function drawFlowChart() {
    const node = root.querySelector('[data-bi-flow]');
    if (!node) return;
    const procs = processes();
    const mhOf = (p) => (showPeak ? p.man_hours_peak : p.man_hours);
    const p = biPalette();
    // top→bottom flow order; ECharts category axis stacks bottom→top, so reverse.
    const ordered = procs.slice().reverse();
    const cats = ordered.map((q) => q.id);
    const bars = ordered.map((q) => ({
      value: +mhOf(q).toFixed(2),
      itemStyle: { color: q.sec === '入荷' ? p.inbound : p.accent,
        borderColor: q.derived ? p.accent : 'transparent', borderWidth: q.derived ? 1.5 : 0,
        borderType: 'dashed', borderRadius: [0, 4, 4, 0] },
    }));
    if (!flowChart) {
      flowChart = echarts.init(node, null, { renderer: 'canvas' });
      if (ro) ro.observe(node);
    }
    flowChart.setOption({
      animation: !reduceMotion(),
      grid: { left: 8, right: 56, top: 28, bottom: 8, containLabel: true },
      legend: {
        top: 0, right: 4, icon: 'roundRect', itemWidth: 10, itemHeight: 10, selectedMode: false,
        data: ['入荷', '出荷'], textStyle: { color: p.ink3, fontSize: 10, fontFamily: p.fontMono },
      },
      tooltip: {
        trigger: 'item', backgroundColor: p.panel, borderColor: p.lineStrong, borderWidth: 1,
        textStyle: { color: p.ink, fontSize: 12, fontFamily: p.fontSans },
        extraCssText: 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.16);',
        formatter: (d) => {
          const q = ordered[d.dataIndex] || {};
          return `<b>${q.id}</b>${q.derived ? ' <span style="opacity:.7">(推計)</span>' : ''}<br>`
            + `${fmt(q.volume)} ${driverUnit(q.driver)} ÷ ${fmt(q.prod)} ${q.unit}`
            + `${showPeak ? ` ×${fmt(peak, 2)}` : ''}<br>人時 ${fmt(mhOf(q), 1)}`;
        },
      },
      xAxis: { type: 'value', axisLabel: { color: p.ink3, fontFamily: p.fontMono },
        splitLine: { lineStyle: { color: p.line } } },
      yAxis: { type: 'category', data: cats, inverse: false,
        axisLabel: { color: p.ink2, fontFamily: p.fontSans, fontSize: 12 },
        axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false } },
      series: [
        { name: '入荷', type: 'bar', data: [], itemStyle: { color: p.inbound } },
        { name: '出荷', type: 'bar', data: [], itemStyle: { color: p.accent } },
        { name: '人時', type: 'bar', data: bars, barMaxWidth: 22,
          label: { show: true, position: 'right', color: p.ink2, fontFamily: p.fontMono, fontSize: 10,
            formatter: (d) => fmt(d.value, 1) } },
      ],
    }, true);
  }

  // Live update on slider input — recompute every 仮値 derivation + the right
  // pane (no server round-trip; DuckDB already did the base aggregation). Each
  // recipe updates its own out/chain in place; the right pane uses the peak-aware
  // key so the ピーク係数 + toggle reflect immediately.
  const setText = (sel, txt) => { const n = root.querySelector(sel); if (n) n.textContent = txt; };
  const setHTML = (sel, html) => { const n = root.querySelector(sel); if (n) n.innerHTML = html; };

  // Live slider repaint: update the right-pane header text + total + redraw the
  // ECharts canvas IN PLACE (never rebuild #bi-right's innerHTML, which would
  // destroy the canvas node). If the canvas is somehow missing (first paint),
  // fall back to a full rebuild then draw.
  function repaintRight() {
    const procs = processes();
    const mhKey = (p) => (showPeak ? p.man_hours_peak : p.man_hours);
    const totalMh = procs.reduce((s, p) => s + mhKey(p), 0);
    const right = root.querySelector('#bi-right');
    if (!right) return;
    const node = right.querySelector('[data-bi-flow]');
    if (!node) {
      const maxMh = Math.max(1, ...procs.map(mhKey));
      right.innerHTML = `${rightHeader()}${renderFlow(procs, maxMh, totalMh)}`;
    }
    // header subtitle (平常/ピーク) + total label/value, updated in place
    const sub = right.querySelector('.bi-h .sub');
    if (sub) sub.textContent = `物量 → 人時（仮値とライブ連動・${showPeak ? `ピーク日 ×${fmt(peak, 2)}` : '平常日'}）`;
    const totalRow = right.querySelector('.bi-total');
    if (totalRow) {
      const label = showPeak ? `合計 必要人時/日（ピーク ×${fmt(peak, 2)}）` : '合計 必要人時/日';
      const lbl = totalRow.querySelector('span:first-child'); if (lbl) lbl.textContent = label;
      const tv = root.querySelector('#bi-totalmh'); if (tv) tv.textContent = `${fmt(totalMh, 1)} 人時`;
    }
    drawFlowChart();
  }

  function wire() {
    const on = (sel, ev, fn) => { const n = root.querySelector(sel); if (n) n[ev] = fn; };

    // 稼働日カレンダ: toggle a weekday's 稼働/非稼働 → refetch volumes (server
    // redistributes onto working days) → re-render with the new daily averages.
    root.querySelectorAll('.bi-wd[data-wd]').forEach((b) => {
      b.onclick = () => {
        const i = parseInt(b.dataset.wd, 10);
        if (nonworking.has(i)) nonworking.delete(i); else nonworking.add(i);
        load();   // refetch /bi/volumes?nonworking=… then render()
      };
    });

    // ケース → パレット (existing): drives 格納 pallets + putaway 人時.
    const updateCpp = () => {
      const cppEl = root.querySelector('#bi-cpp');
      const ppEl = root.querySelector('#bi-pp');
      cpp = parseInt(cppEl.value, 10);
      palletProd = parseInt(ppEl.value, 10);
      setText('#bi-cpp-v', `${cpp} c/PL`);
      setText('#bi-pp-v', `${palletProd} PL/h`);
      const d = derived();
      setHTML('#bi-pallets', `${fmt(d.inPallets)}<span class="u">PL</span>`);
      setHTML('#bi-putmh', `${fmt(d.putawayMh, 1)}<span class="u">人時</span>`);
      setText('#bi-chain',
        `入荷ケース ${fmt(vol.in_cases)} ÷ ${cpp} = ${fmt(d.inPallets)} PL → ÷ ${palletProd} PL/h = ${fmt(d.putawayMh, 1)} 人時`);
      repaintRight();
    };
    on('#bi-cpp', 'oninput', updateCpp);
    on('#bi-pp', 'oninput', updateCpp);

    // 行 → ピース + ケース → ピース 検算 (share the 入数 slider).
    const updateQpc = () => {
      const el = root.querySelector('#bi-qpc');
      qtyPerCase = parseInt(el.value, 10);
      setText('#bi-qpc-v', `${qtyPerCase} 点/行`);
      const d = derived();
      const hasPieces = (vol.out_pieces || 0) > 0;
      setHTML('#bi-lp', `${fmt(d.piecesFromLines)}<span class="u">点</span>`);
      setText('#bi-lp-chain',
        `出荷行 ${fmt(vol.out_lines)} × ${qtyPerCase} 点 = ${fmt(d.piecesFromLines)} 点${hasPieces ? `（実績 ${fmt(d.piecesActual)} 点との差 ${fmt(d.piecesFromLines - d.piecesActual)} 点）` : ''}`);
      // ケース → ピース 検算 shares this slider when present.
      setHTML('#bi-cp', `${fmt(d.piecesFromCases)}<span class="u">点</span>`);
      setText('#bi-cp-chain',
        `出荷ケース ${fmt(vol.out_cases)} × ${qtyPerCase} 点 = ${fmt(d.piecesFromCases)} 点（実績との差 ${fmt(d.piecesFromCases - d.piecesActual)} 点）`);
      refreshCageOut(d);  // バラ補完値の変化は荷姿派生 (OC/台車) にも波及する
    };
    on('#bi-qpc', 'oninput', updateQpc);

    // 受注 → 出荷ライン.
    const updateLpo = () => {
      const el = root.querySelector('#bi-lpo');
      linesPerOrder = Math.round(parseFloat(el.value) * 10) / 10;
      setText('#bi-lpo-v', `${fmt(linesPerOrder, 1)} 行/件`);
      const d = derived();
      const linesMissing = (vol.out_lines || 0) <= 0;
      setHTML('#bi-lo', `${fmt(d.linesFromOrders)}<span class="u">行</span>`);
      setText('#bi-lo-chain',
        `出荷オーダー ${fmt(vol.out_orders)} × ${fmt(linesPerOrder, 1)} 行 = ${fmt(d.linesFromOrders)} 行${linesMissing ? '' : `（実績 ${fmt(vol.out_lines)} 行との差 ${fmt(d.linesFromOrders - (vol.out_lines || 0))} 行）`}`);
    };
    on('#bi-lpo', 'oninput', updateLpo);

    // ピース → 容器 → 台車: 荷姿の入数 (梱包/出荷の人時ドライバー → 右も再描画)。
    // スライダーは荷姿カタログの入数そのものなので、動かした値は保存して全画面へ返す。
    const updateCage = () => {
      const ppoEl = root.querySelector('#bi-ppo');
      const upcEl = root.querySelector('#bi-upc');
      if (ppoEl) { const v = parseFloat(ppoEl.value); if (v > 0) piecesPerOrikon = v; }
      if (upcEl) { const v = parseFloat(upcEl.value); if (v > 0) { unitsPerCage = v; carrierCapSet = true; } }
      setText('#bi-ppo-v', `${piecesPerOrikon} 点/${ocLabel()}`);
      setText('#bi-upc-v', `${unitsPerCage} 個/台`);
      serverConv = null;          // 式は保存後に取り直す（数字の食い違いを見せない）
      refreshCageOut(derived());
      saveCatalog();
    };
    on('#bi-ppo', 'oninput', updateCage);
    on('#bi-upc', 'oninput', updateCage);

    // どの容器/台車で見積もるかの選択 (カタログの view — 入数はカタログから来る)。
    const updatePack = () => {
      const cEl = root.querySelector('#bi-cont');
      const kEl = root.querySelector('#bi-carr');
      if (cEl) containerRef = cEl.value;
      if (kEl) carrierRef = kEl.value;
      serverConv = null;
      syncFromCatalog();          // 入数を選択先のカタログ値へ引き直す
      render();                   // ラベル/レンジごと描き直す
      fetchChain();
    };
    on('#bi-cont', 'onchange', updatePack);
    on('#bi-carr', 'onchange', updatePack);

    // 保存 → タイムチャート: persist the 仮値派生 (bi/apply → bi.json + provenance)
    // then hand the from-bi scenario to the timetable via the shell event.
    on('#bi-apply-btn', 'onclick', async () => {
      const name = getProject();
      if (!name) { toast('先にプロジェクトを作ってください。', 'error'); return; }
      const btn = root.querySelector('#bi-apply-btn');
      if (btn) { btn.disabled = true; btn.textContent = '保存して展開中…'; }
      try {
        const params = {
          cases_per_pallet: cpp, pallet_prod: palletProd,
          lines_per_order: linesPerOrder, peak_factor: peak,
          pieces_per_orikon: piecesPerOrikon, units_per_cage: unitsPerCage,
          nonworking: Array.from(nonworking).sort((a, b) => a - b),
        };
        let r = await fetch(`/api/projects/${encodeURIComponent(name)}/bi/apply`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        });
        if (!r.ok) throw new Error(r.statusText || `HTTP ${r.status}`);
        r = await fetch(`/api/projects/${encodeURIComponent(name)}/timetable/from-bi`);
        if (!r.ok) throw new Error(r.statusText || `HTTP ${r.status}`);
        const tt = await r.json();
        if (!tt.available) throw new Error('基礎物量を展開できませんでした');
        document.dispatchEvent(new CustomEvent('whsim:load-timetable',
          { detail: { scenario: tt.scenario } }));
      } catch (e) {
        toast('展開に失敗: ' + (e && e.message ? e.message : e), 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '💾 基礎物量を保存 → タイムチャートで人員配置 →'; }
      }
    });

    // 日量 → ピーク係数: factor slider + 平常/ピーク toggle, both repaint right.
    const updatePeak = () => {
      const el = root.querySelector('#bi-peak');
      peak = Math.round(parseFloat(el.value) * 100) / 100;
      setText('#bi-peak-v', `×${fmt(peak, 2)}`);
      const tog = root.querySelector('#bi-peak-tog');
      const togLabel = tog && tog.parentElement;
      if (togLabel) togLabel.innerHTML = `<input type="checkbox" id="bi-peak-tog" ${showPeak ? 'checked' : ''} style="flex:0 0 auto;accent-color:var(--accent)"> ピーク日で表示（×${fmt(peak, 2)}）`;
      on('#bi-peak-tog', 'onchange', updateToggle);
      repaintRight();
    };
    const updateToggle = () => {
      const tog = root.querySelector('#bi-peak-tog');
      showPeak = !!(tog && tog.checked);
      repaintRight();
    };
    on('#bi-peak', 'oninput', updatePeak);
    on('#bi-peak-tog', 'onchange', updateToggle);
  }

  // Pull the project's editable work-process master and adopt it as the process
  // list (re-mapped onto this view's 仮値派生 drivers via biShape). On no project
  // or any failure, fall back to the hardcoded DEFAULT_PROCS so the view never
  // blocks. Tolerant: an empty/oddly-shaped list also falls back.
  async function loadProcs() {
    const name = getProject();
    if (!name) { procs = DEFAULT_PROCS.slice(); return; }
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(name)}/work-processes`);
      if (!r.ok) throw new Error(r.statusText || `HTTP ${r.status}`);
      const data = await r.json();
      const list = Array.isArray(data.processes) ? data.processes.filter((p) => p && p.id) : [];
      procs = list.length ? list.map(biShape) : DEFAULT_PROCS.slice();
    } catch (_e) {
      procs = DEFAULT_PROCS.slice();  // never blocks
    }
  }

  async function load() {
    const name = getProject();
    if (!name) { procs = DEFAULT_PROCS.slice(); units = []; syncFromCatalog(); render(); return; }
    await loadProcs();
    await loadUnits();      // 荷姿カタログ (失敗しても従来の固定値で続行)
    try {
      const nw = Array.from(nonworking).sort((a, b) => a - b).join(',');
      const r = await fetch(`/api/projects/${encodeURIComponent(name)}/bi/volumes`
        + (nw ? `?nonworking=${encodeURIComponent(nw)}` : ''));
      if (!r.ok) throw new Error(r.statusText);
      vol = await r.json();
      loadErr = null;
      render();
      fetchChain();
    } catch (e) { loadErr = e && e.message ? e.message : String(e); render(); toast('基礎物量の読み込みに失敗', 'error'); }
  }

  // The 荷姿 may be edited elsewhere (③設計フロー). Re-read the catalogue so the
  // two screens never disagree about 入数. Our own edits are skipped (they would
  // re-render the card mid-drag).
  function onUnitsChanged(ev) {
    if (ev && ev.detail && ev.detail.source === 'bi') return;
    if (!getProject()) return;
    loadUnits().then(() => { if (vol) { render(); fetchChain(); } }).catch(() => {});
  }
  document.addEventListener('whsim:loadunits-changed', onUnitsChanged);

  load();
  return {
    // refresh() works as before; pass a focus hint (e.g. {peak:true}) to honour
    // a 対話分析 drill-down once the data finishes loading.
    refresh(focus) { if (focus) pendingFocus = focus; loadErr = null; vol = null; render(); load(); },
    dispose() {
      disposeChart();
      if (ro) { ro.disconnect(); ro = null; }
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
      if (chainTimer) { clearTimeout(chainTimer); chainTimer = 0; }
      window.removeEventListener('resize', resizeChart);
      document.removeEventListener('themechange', onThemeChange);
      document.removeEventListener('whsim:loadunits-changed', onUnitsChanged);
      el.innerHTML = '';
    },
  };
}
