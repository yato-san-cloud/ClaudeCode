// journey.js — guided 5-phase navigation stepper (self-contained ES module).
// Decouples the salesperson's mental model (案件を作る→分析→設計→検証→提案) from
// the underlying view panels. PM wires real panels via opts.onSelectView(viewId);
// this component only renders the stepper + sub-tabs + cross-cutting pins and
// reflects state (✓ done / 🔒 locked) from opts.getState().

// --- Shared contract: phases, their member views, and labels ------------------

// Each phase: id, ordinal label, short title, goal subtitle, ordered view list.
// The first view in `views` is the phase's landing sub-view (clicked on the pill).
const PHASES = [
  { id: 'intake', no: '①', title: '取込', goal: '案件を作り顧客データを取り込む', views: ['overview'] },
  { id: 'analyze', no: '②', title: '分析', goal: '物量・波動・ABCを把握する', views: ['dataanalysis'] },
  { id: 'design', no: '③', title: '設計', goal: 'レイアウトと工程・人員を組む', views: ['design', 'materialflow', 'timetable'] },
  { id: 'validate', no: '④', title: '検証', goal: '捌けるかをKPIと動きで確認', views: ['analysis', 'view2d', 'view3d'] },
  { id: 'propose', no: '⑤', title: '提案', goal: '提案書とシナリオ比較を出す', views: ['viewpng', 'compare', 'export'] },
];

// Cross-cutting views: available in every phase, pinned separately (own lane).
const CROSS = [
  { id: 'chat', label: 'Cody', icon: '💬' },
  { id: 'notes', label: '知見', icon: '📌' },
];

// Display labels for every view id (sub-tab buttons + landing targets).
const VIEW_LABEL = {
  overview: '概要', dataanalysis: 'データ分析', design: 'レイアウト',
  materialflow: 'マテリアルフロー', timetable: '人員タイムチャート', analysis: 'KPI・判定',
  view2d: '2Dアニメ', view3d: '3Dビュー', viewpng: '提案PNG', compare: 'シナリオ比較',
  export: 'エクスポート', chat: 'Cody', notes: '知見',
};

// Phases that require a completed run (hasRun) before their KPIs/output are real.
const RUN_REQUIRED = new Set(['validate', 'propose']);
// Phases that are more useful once data is imported (soft hint only).
const DATA_HINTED = new Set(['analyze']);

// viewId → phaseId lookup (built once from PHASES; cross-cutting → null phase).
const VIEW_TO_PHASE = (() => {
  const m = {};
  for (const p of PHASES) for (const v of p.views) m[v] = p.id;
  return m;
})();

// --- Styling ------------------------------------------------------------------

function injectStyle() {
  if (document.getElementById('jn-style')) return;
  const s = document.createElement('style');
  s.id = 'jn-style';
  s.textContent = `
  .jn{display:flex;flex-direction:column;gap:10px;width:100%;
    background:var(--bg-app,#fff);border-bottom:1px solid var(--line,rgba(120,140,170,.18));
    padding:10px 14px 8px}
  .jn-top{display:flex;align-items:stretch;gap:8px}
  .jn-steps{display:flex;align-items:stretch;gap:8px;flex:1;min-width:0;
    overflow-x:auto;scrollbar-width:thin;padding-bottom:2px}
  .jn-steps::-webkit-scrollbar{height:6px}
  .jn-steps::-webkit-scrollbar-thumb{background:var(--line,rgba(120,140,170,.3));border-radius:3px}
  .jn-pill{display:flex;flex-direction:column;justify-content:center;gap:2px;
    flex:0 0 auto;min-width:120px;max-width:200px;text-align:left;cursor:pointer;
    background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:12px;padding:7px 12px;font:inherit;color:var(--ink-primary,#16202e);
    transition:border-color .12s,background .12s}
  .jn-pill:hover{border-color:var(--accent,#2f7bff)}
  .jn-pill-head{display:flex;align-items:center;gap:6px;font-size:13.5px;font-weight:700;line-height:1.2}
  .jn-pill-no{color:var(--ink-tertiary,#8195a8);font-weight:800}
  .jn-pill-flag{margin-left:auto;font-size:12px}
  .jn-pill-goal{font-size:10.5px;color:var(--ink-tertiary,#8195a8);line-height:1.3;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .jn-pill.is-active{background:var(--accent,#2f7bff);border-color:var(--accent,#2f7bff);color:#04222c}
  .jn-pill.is-active .jn-pill-no,.jn-pill.is-active .jn-pill-goal{color:rgba(4,34,44,.8)}
  .jn-pill.is-done{border-color:var(--accent,#2f7bff)}
  .jn-pill.is-locked{opacity:.85}
  .jn-pins{display:flex;align-items:center;gap:6px;flex:0 0 auto;
    padding-left:10px;margin-left:2px;border-left:1px solid var(--line,rgba(120,140,170,.18))}
  .jn-pin{display:flex;align-items:center;gap:5px;cursor:pointer;flex:0 0 auto;
    background:transparent;border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:999px;padding:6px 11px;font:inherit;font-size:12px;font-weight:600;
    color:var(--ink-secondary,#52677c);transition:border-color .12s,color .12s,background .12s}
  .jn-pin:hover{border-color:var(--accent,#2f7bff)}
  .jn-pin.is-active{background:var(--accent,#2f7bff);border-color:var(--accent,#2f7bff);color:#04222c}
  .jn-pin-icon{font-size:13px}
  .jn-subs{display:flex;align-items:center;gap:6px;overflow-x:auto;scrollbar-width:thin;
    padding-bottom:2px;min-height:30px}
  .jn-subs::-webkit-scrollbar{height:6px}
  .jn-subs::-webkit-scrollbar-thumb{background:var(--line,rgba(120,140,170,.3));border-radius:3px}
  .jn-sub{flex:0 0 auto;cursor:pointer;background:transparent;
    border:1px solid var(--line,rgba(120,140,170,.18));border-radius:8px;
    padding:5px 12px;font:inherit;font-size:12.5px;font-weight:600;
    color:var(--ink-secondary,#52677c);transition:border-color .12s,color .12s,background .12s}
  .jn-sub:hover{border-color:var(--accent,#2f7bff)}
  .jn-sub.is-active{background:var(--accent,#2f7bff);border-color:var(--accent,#2f7bff);color:#04222c}
  .jn-sub-hint{font-size:11px;color:var(--ink-tertiary,#8195a8);margin-left:4px;white-space:nowrap}
  @media (max-width:700px){
    .jn{padding:8px 8px 6px}
    /* Stack: the 5-phase stepper takes the full first line (horizontally
       scrollable), the cross-cutting pins wrap onto their own line below. */
    .jn-top{flex-wrap:wrap}
    .jn-steps{flex:1 1 100%}
    .jn-pins{margin-left:0;padding-left:0;border-left:none}
    .jn-pill{min-width:78px;max-width:140px;padding:6px 9px}
    .jn-pill-head{font-size:12px}
    .jn-pill-goal{display:none}
    .jn-pin{padding:6px 9px}
    .jn-sub-hint{display:none}
  }
  `;
  document.head.appendChild(s);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// --- Component ----------------------------------------------------------------

export function mountJourney(el, opts = {}) {
  injectStyle();
  const onSelectView = opts.onSelectView || (() => {});
  const getState = opts.getState || (() => ({ project: null, hasData: false, hasRun: false }));

  const root = document.createElement('div');
  root.className = 'jn';
  el.innerHTML = '';
  el.appendChild(root);

  let activeView = PHASES[0].views[0];

  function phaseStatus(phase, state) {
    const locked = RUN_REQUIRED.has(phase.id) && !state.hasRun;
    const idx = PHASES.findIndex((p) => p.id === phase.id);
    const activePhaseId = VIEW_TO_PHASE[activeView] || null;
    const activeIdx = activePhaseId ? PHASES.findIndex((p) => p.id === activePhaseId) : -1;
    let done = false;
    if (activeIdx >= 0 && idx < activeIdx) {
      if (phase.id === 'intake') done = !!state.project;
      else if (DATA_HINTED.has(phase.id)) done = !!state.hasData;
      else if (RUN_REQUIRED.has(phase.id)) done = !!state.hasRun;
      else done = true;
    }
    return { locked, done };
  }

  function render() {
    const state = getState();
    const activePhaseId = VIEW_TO_PHASE[activeView] || null;

    const steps = PHASES.map((p) => {
      const { locked, done } = phaseStatus(p, state);
      const isActive = p.id === activePhaseId;
      let flag = '';
      if (locked) flag = '🔒';
      else if (done) flag = '✓';
      const cls = ['jn-pill'];
      if (isActive) cls.push('is-active');
      if (done) cls.push('is-done');
      if (locked) cls.push('is-locked');
      const title = locked ? 'シミュレーション実行後に確認できます' : esc(p.goal);
      return `<button class="${cls.join(' ')}" data-phase="${p.id}" title="${title}" aria-current="${isActive ? 'step' : 'false'}">
        <span class="jn-pill-head"><span class="jn-pill-no">${p.no}</span><span>${esc(p.title)}</span>
          <span class="jn-pill-flag">${flag}</span></span>
        <span class="jn-pill-goal">${esc(p.goal)}</span>
      </button>`;
    }).join('');

    const pins = CROSS.map((c) => {
      const isActive = c.id === activeView;
      return `<button class="jn-pin${isActive ? ' is-active' : ''}" data-view="${c.id}" title="${esc(c.label)}">
        <span class="jn-pin-icon">${c.icon}</span><span>${esc(c.label)}</span>
      </button>`;
    }).join('');

    let subs = '';
    if (activePhaseId) {
      const p = PHASES.find((q) => q.id === activePhaseId);
      const { locked } = phaseStatus(p, state);
      subs = p.views.map((v) => {
        const isActive = v === activeView;
        return `<button class="jn-sub${isActive ? ' is-active' : ''}" data-view="${v}">${esc(VIEW_LABEL[v] || v)}</button>`;
      }).join('');
      if (locked) {
        subs += '<span class="jn-sub-hint">🔒 実行するとここで結果を確認できます</span>';
      } else if (DATA_HINTED.has(p.id) && !state.hasData) {
        subs += '<span class="jn-sub-hint">データ取込後がおすすめ</span>';
      }
    } else {
      const label = activeView === 'chat' ? 'Cody（横断アシスタント）' : '知見ボード（横断メモ）';
      subs = `<span class="jn-sub-hint">${esc(label)}</span>`;
    }

    root.innerHTML =
      `<div class="jn-top">
         <div class="jn-steps" role="navigation" aria-label="進行ステップ">${steps}</div>
         <div class="jn-pins">${pins}</div>
       </div>
       <div class="jn-subs" role="tablist">${subs}</div>`;

    wire();
  }

  function wire() {
    root.querySelectorAll('[data-phase]').forEach((b) => {
      b.onclick = () => {
        const phase = PHASES.find((p) => p.id === b.dataset.phase);
        if (!phase) return;
        const state = getState();
        const { locked } = phaseStatus(phase, state);
        select(phase.views[0]);
        if (locked && typeof opts.onLockedAttempt === 'function') {
          opts.onLockedAttempt(phase.id, phase.views[0]);
        }
      };
    });
    root.querySelectorAll('[data-view]').forEach((b) => {
      b.onclick = () => select(b.dataset.view);
    });
  }

  function select(viewId) {
    if (!viewId) return;
    activeView = viewId;
    onSelectView(viewId);
    render();
  }

  render();

  return {
    setActive(viewId) {
      if (!viewId || viewId === activeView) { render(); return; }
      activeView = viewId;
      render();
    },
    refresh() { render(); },
    dispose() { el.innerHTML = ''; },
  };
}
