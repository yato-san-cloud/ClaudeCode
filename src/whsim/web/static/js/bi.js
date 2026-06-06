// bi.js — 物量BI: split-screen ETL→material-flow. Left: base volumes aggregated
// in DuckDB (server) + a provisional 仮値 derivation (ケース→パレット). Right: the
// material-flow (物量→人時) that updates live as the 仮値 sliders move. The pallet
// derivation is client-side so it feels instant; derived values are badged 推計.
// Comments EN; UI JA. Brand tokens only; no idle loops; reduced-motion safe.

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

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
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
  .bi-badge{font-family:var(--font-mono);font-size:9.5px;letter-spacing:.04em;padding:2px 7px;border-radius:999px;
    border:1px solid var(--accent);color:var(--accent-ink);background:var(--accent-tint)}
  .bi-est{font-family:var(--font-mono);font-size:9px;padding:1px 6px;border-radius:4px;
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
    border-radius:var(--r-md);padding:10px 12px;transition:border-color var(--dur-2,160ms) var(--ease-out,ease)}
  .bi-proc.derived{border-left:3px solid var(--accent)}
  .bi-proc .pn{flex:1;min-width:0}
  .bi-proc .pn b{font-size:13px;font-weight:600;color:var(--ink-primary)}
  .bi-proc .pn .pv{font-size:10.5px;color:var(--ink-tertiary);font-family:var(--font-mono)}
  .bi-proc .mh{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:17px;font-weight:700;
    color:var(--ink-primary);text-align:right}
  .bi-proc .mh .u{font-size:10px;color:var(--ink-tertiary);font-weight:400;margin-left:2px}
  .bi-bar{height:5px;border-radius:3px;background:var(--line-hair);overflow:hidden;margin-top:6px}
  .bi-bar i{display:block;height:100%;background:var(--accent);border-radius:3px;transition:width var(--dur-2,160ms) var(--ease-out,ease)}
  .bi-total{display:flex;justify-content:space-between;align-items:baseline;padding:10px 12px;
    border-top:1px solid var(--line-hair);margin-top:4px}
  .bi-total .tv{font-family:var(--font-mono);font-size:16px;font-weight:700;color:var(--ink-primary)}
  .bi-empty{color:var(--ink-tertiary);text-align:center;padding:28px}
  @media (prefers-reduced-motion: reduce){ .bi-bar i,.bi-proc{transition:none} }
  `;
  document.head.appendChild(s);
}

export function mountBI(el, opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const toast = opts.toast || (() => {});
  const root = document.createElement('div');
  el.innerHTML = '';
  el.appendChild(root);

  let vol = null;       // base volumes from DuckDB
  let cpp = 40;         // 仮値: cases per pallet
  let palletProd = 18;  // 仮値: 格納 productivity (PL/h)

  function derived() {
    const inCases = (vol && vol.in_cases) || 0;
    const inPallets = cpp > 0 ? Math.ceil(inCases / cpp) : 0;
    return { inPallets, putawayMh: palletProd > 0 ? inPallets / palletProd : 0 };
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
      return { ...p, volume: v, prod, man_hours: mh };
    });
  }

  function render() {
    if (!getProject()) { root.innerHTML = '<div class="bi-empty">プロジェクトを選択してください。</div>'; return; }
    if (!vol) { root.innerHTML = '<div class="bi-empty">物量を集計中…</div>'; return; }
    const d = derived();
    const procs = processes();
    const maxMh = Math.max(1, ...procs.map((p) => p.man_hours));
    const totalMh = procs.reduce((s, p) => s + p.man_hours, 0);
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

    root.innerHTML = `
      <section class="bi-pane">
        <div class="bi-h"><h3>物量BI</h3><span class="sub">取込→集計→仮値で派生</span>
          <span class="bi-badge" style="margin-left:auto">${esc(vol.engine || 'DuckDB')}</span></div>
        ${baseGrid}
        ${deriveCard}
        <div class="bi-chain">※ パレット数は実値が無いため「ケース数 ÷ 積載数(仮値)」で派生。実データが入れば差し替わります（provenance＝生成・推計）。</div>
      </section>
      <section class="bi-pane" id="bi-right">
        <div class="bi-h"><h3>マテリアルフロー</h3><span class="sub">物量 → 人時（仮値とライブ連動）</span></div>
        ${renderFlow(procs, maxMh, totalMh)}
      </section>`;

    wire();
  }

  function renderFlow(procs, maxMh, totalMh) {
    const card = (p) => `
      <div class="bi-proc${p.derived ? ' derived' : ''}">
        <div class="pn"><b>${esc(p.id)}</b><div class="pv">${fmt(p.volume)} ${esc(driverUnit(p.driver))} ÷ ${fmt(p.prod)} ${esc(p.unit)}</div>
          <div class="bi-bar"><i style="width:${Math.min(100, (p.man_hours / maxMh) * 100)}%"></i></div></div>
        <div class="mh" data-mh="${p.id}">${fmt(p.man_hours, 1)}<span class="u">人時</span></div>
      </div>`;
    const inb = procs.filter((p) => p.sec === '入荷');
    const out = procs.filter((p) => p.sec === '出荷');
    return `
      <div class="bi-sec">入荷</div>${inb.map(card).join('')}
      <div class="bi-sec">出荷</div>${out.map(card).join('')}
      <div class="bi-total"><span>合計 必要人時/日</span><span class="tv" id="bi-totalmh">${fmt(totalMh, 1)} 人時</span></div>`;
  }

  function driverUnit(dr) {
    return { in_cases: 'ケース', in_pallets: 'PL', out_lines: '行', out_orders: '件' }[dr] || '';
  }

  // Live update on slider input — recompute the derivation + the right pane only
  // (no server round-trip; DuckDB already did the base aggregation).
  function wire() {
    const cppEl = root.querySelector('#bi-cpp');
    const ppEl = root.querySelector('#bi-pp');
    const update = () => {
      cpp = parseInt(cppEl.value, 10);
      palletProd = parseInt(ppEl.value, 10);
      root.querySelector('#bi-cpp-v').textContent = `${cpp} c/PL`;
      root.querySelector('#bi-pp-v').textContent = `${palletProd} PL/h`;
      const d = derived();
      root.querySelector('#bi-pallets').innerHTML = `${fmt(d.inPallets)}<span class="u">PL</span>`;
      root.querySelector('#bi-putmh').innerHTML = `${fmt(d.putawayMh, 1)}<span class="u">人時</span>`;
      root.querySelector('#bi-chain').textContent =
        `入荷ケース ${fmt(vol.in_cases)} ÷ ${cpp} = ${fmt(d.inPallets)} PL → ÷ ${palletProd} PL/h = ${fmt(d.putawayMh, 1)} 人時`;
      // right pane recompute (only the flow markup)
      const procs = processes();
      const maxMh = Math.max(1, ...procs.map((p) => p.man_hours));
      const totalMh = procs.reduce((s, p) => s + p.man_hours, 0);
      const right = root.querySelector('#bi-right');
      // keep the header, replace the flow
      right.innerHTML = `<div class="bi-h"><h3>マテリアルフロー</h3><span class="sub">物量 → 人時（仮値とライブ連動）</span></div>${renderFlow(procs, maxMh, totalMh)}`;
    };
    if (cppEl) cppEl.oninput = update;
    if (ppEl) ppEl.oninput = update;
  }

  async function load() {
    const name = getProject();
    if (!name) { render(); return; }
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(name)}/bi/volumes`);
      if (!r.ok) throw new Error(r.statusText);
      vol = await r.json();
      render();
    } catch (e) { root.innerHTML = `<div class="bi-empty">物量の集計に失敗: ${esc(e.message)}</div>`; toast('物量BIの読み込みに失敗', 'error'); }
  }

  load();
  return { refresh() { vol = null; render(); load(); }, dispose() { el.innerHTML = ''; } };
}
