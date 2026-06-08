// bi.js — 物量BI: split-screen ETL→material-flow. Left: base volumes aggregated
// in DuckDB (server) + a provisional 仮値 derivation (ケース→パレット). Right: the
// material-flow (物量→人時) that updates live as the 仮値 sliders move. The pallet
// derivation is client-side so it feels instant; derived values are badged 推計.
// Comments EN; UI JA. Brand tokens only; no idle loops; reduced-motion safe.
import { esc } from './util.js';

// Productivity standards mirror analysis/staffing GENERIC_PROCESSES (editable
// JP-warehouse defaults). 格納 is driven by *pallets* here — the live link.
const PROCS = [
  { id: '入荷検品', sec: '入荷', driver: 'in_cases', prod: 40, unit: 'ケース/h' },
  { id: '格納', sec: '入荷', driver: 'in_pallets', prod: null, unit: 'PL/h', derived: true },
  { id: 'ピッキング', sec: '出荷', driver: 'out_lines', prod: 60, unit: '行/h' },
  { id: '検品', sec: '出荷', driver: 'out_lines', prod: 120, unit: '行/h' },
  { id: '梱包', sec: '出荷', driver: 'out_orders', prod: 30, unit: '件/h' },
  { id: '出荷', sec: '出荷', driver: 'out_orders', prod: 120, unit: '件/h' },
];

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
  /* drill-context focus: gently emphasize the control the 分析BI sent us to */
  .bi-focus{box-shadow:0 0 0 2px var(--accent);border-radius:var(--r-md);
    transition:box-shadow var(--dur-2) var(--ease-out)}
  @media (prefers-reduced-motion: reduce){ .bi-bar i,.bi-proc,.bi-focus{transition:none} }
  `;
  document.head.appendChild(s);
}

export function mountBI(el, opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const toast = opts.toast || (() => {});
  // Optional drill-context: the 分析BI view navigates here and may pass a focus
  // hint (e.g. {peak:true} or {abc:'A'}). app.js wires opts.getFocus; refresh()
  // can also take an explicit focus. Fully backward-compatible: no focus = today.
  const getFocus = typeof opts.getFocus === 'function' ? opts.getFocus : (() => null);
  let pendingFocus = null;  // focus to honour on the next render
  const root = document.createElement('div');
  el.innerHTML = '';
  el.appendChild(root);

  let vol = null;       // base volumes from DuckDB
  let loadErr = null;   // last load() failure (null = none); drives the retry state
  let cpp = 40;         // 仮値: cases per pallet
  let palletProd = 18;  // 仮値: 格納 productivity (PL/h)
  let qtyPerCase = 0;   // 仮値: pieces per case (行→ピース / ケース→ピース検算); 0 = seed from data
  let linesPerOrder = 0;// 仮値: lines per order (受注→出荷ライン); 0 = seed from data
  let peak = 1.0;       // 仮値: peak-day factor (日量→ピーク係数)
  let showPeak = false; // right pane: 平常 vs ピーク toggle

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
    return {
      inPallets, putawayMh: palletProd > 0 ? inPallets / palletProd : 0,
      piecesFromLines, piecesActual, linesFromOrders, piecesFromCases,
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
    };
    return PROCS.map((p) => {
      const v = drv[p.driver] || 0;
      const prod = p.derived ? palletProd : p.prod;
      const mh = prod > 0 ? v / prod : 0;
      // 日量→ピーク係数: scale to a peak-day staffing assumption.
      const mhPeak = mh * peak;
      return { ...p, volume: v, prod, man_hours: mh, man_hours_peak: mhPeak };
    });
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
        <div class="bi-h"><h3>物量BI</h3><span class="sub">取込→集計→仮値で派生</span>
          <span class="bi-badge" style="margin-left:auto">${esc(vol.engine || 'DuckDB')}</span></div>
        ${baseGrid}
        ${deriveCard}
        ${linesPiecesCard}
        ${ordersLinesCard}
        ${casePiecesCard}
        ${peakCard}
        <div class="bi-chain">※ 派生値は実値が無いため仮値で派生／補完。実データが入れば差し替わります（provenance＝生成・推計）。</div>
      </section>
      <section class="bi-pane" id="bi-right">
        ${rightHeader()}
        ${renderFlow(procs, maxMh, totalMh)}
      </section>`;

    wire();
    applyFocus();
  }

  // Resolve a focus hint (explicit pending one wins, else opts.getFocus()) and,
  // if present, gently highlight + scroll the relevant control into view. Used
  // by the 分析BI drill-down; a no-op when no focus is provided.
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

  function renderFlow(procs, maxMh, totalMh) {
    const mhOf = (p) => (showPeak ? p.man_hours_peak : p.man_hours);
    const card = (p) => `
      <div class="bi-proc${p.derived ? ' derived' : ''}">
        <div class="pn"><b>${esc(p.id)}</b><div class="pv">${fmt(p.volume)} ${esc(driverUnit(p.driver))} ÷ ${fmt(p.prod)} ${esc(p.unit)}${showPeak ? ` ×${fmt(peak, 2)}` : ''}</div>
          <div class="bi-bar" role="img" aria-label="${esc(p.id)} ${fmt(mhOf(p), 1)} 人時（合計比 ${fmt((mhOf(p) / maxMh) * 100)}%）"><i style="width:${Math.min(100, (mhOf(p) / maxMh) * 100)}%"></i></div></div>
        <div class="mh" data-mh="${p.id}">${fmt(mhOf(p), 1)}<span class="u">人時</span></div>
      </div>`;
    const inb = procs.filter((p) => p.sec === '入荷');
    const out = procs.filter((p) => p.sec === '出荷');
    const totalLabel = showPeak ? `合計 必要人時/日（ピーク ×${fmt(peak, 2)}）` : '合計 必要人時/日';
    return `
      <div class="bi-sec">入荷</div>${inb.map(card).join('')}
      <div class="bi-sec">出荷</div>${out.map(card).join('')}
      <div class="bi-total"><span>${totalLabel}</span><span class="tv" id="bi-totalmh">${fmt(totalMh, 1)} 人時</span></div>`;
  }

  function driverUnit(dr) {
    return { in_cases: 'ケース', in_pallets: 'PL', out_lines: '行', out_orders: '件' }[dr] || '';
  }

  // Live update on slider input — recompute every 仮値 derivation + the right
  // pane (no server round-trip; DuckDB already did the base aggregation). Each
  // recipe updates its own out/chain in place; the right pane uses the peak-aware
  // key so the ピーク係数 + toggle reflect immediately.
  const setText = (sel, txt) => { const n = root.querySelector(sel); if (n) n.textContent = txt; };
  const setHTML = (sel, html) => { const n = root.querySelector(sel); if (n) n.innerHTML = html; };

  function repaintRight() {
    const procs = processes();
    const mhKey = (p) => (showPeak ? p.man_hours_peak : p.man_hours);
    const maxMh = Math.max(1, ...procs.map(mhKey));
    const totalMh = procs.reduce((s, p) => s + mhKey(p), 0);
    const right = root.querySelector('#bi-right');
    if (right) right.innerHTML = `${rightHeader()}${renderFlow(procs, maxMh, totalMh)}`;
  }

  function wire() {
    const on = (sel, ev, fn) => { const n = root.querySelector(sel); if (n) n[ev] = fn; };

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

  async function load() {
    const name = getProject();
    if (!name) { render(); return; }
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(name)}/bi/volumes`);
      if (!r.ok) throw new Error(r.statusText);
      vol = await r.json();
      loadErr = null;
      render();
    } catch (e) { loadErr = e && e.message ? e.message : String(e); render(); toast('物量BIの読み込みに失敗', 'error'); }
  }

  load();
  return {
    // refresh() works as before; pass a focus hint (e.g. {peak:true}) to honour
    // a 分析BI drill-down once the data finishes loading.
    refresh(focus) { if (focus) pendingFocus = focus; loadErr = null; vol = null; render(); load(); },
    dispose() { el.innerHTML = ''; },
  };
}
