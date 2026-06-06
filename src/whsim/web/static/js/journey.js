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
  { id: 'design', no: '③', title: '設計', goal: 'レイアウトと工程・人員を組む', views: ['bi', 'design', 'materialflow', 'timetable'] },
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
  overview: '概要', dataanalysis: 'データ分析', bi: '物量BI', design: 'レイアウト',
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
  /* Visible keyboard focus ring (does not affect mouse interaction visuals). */
  .jn-pill:focus-visible,.jn-pin:focus-visible,.jn-sub:focus-visible{
    outline:2px solid var(--accent,#2f7bff);outline-offset:2px}
  /* Visually-hidden live region for screen-reader status announcements. */
  .jn-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
    clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
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
  // View id whose sub-tab should regain focus after a keyboard-driven re-render.
  let pendingFocusView = null;

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
      // Visual flag + a text/aria equivalent so state is not conveyed by colour/icon alone.
      let flag = '';
      let flagLabel = '';
      if (locked) { flag = '🔒'; flagLabel = 'ロック中'; }
      else if (done) { flag = '✓'; flagLabel = '完了'; }
      const cls = ['jn-pill'];
      if (isActive) cls.push('is-active');
      if (done) cls.push('is-done');
      if (locked) cls.push('is-locked');
      const title = locked ? 'シミュレーション実行後に確認できます' : esc(p.goal);
      // Accessible name: ordinal + title + (state). aria-current marks the active step.
      // Locked pills are aria-disabled (not native disabled) so the existing
      // click-through-to-empty-state behaviour is preserved.
      const flagAria = flag
        ? `<span class="jn-pill-flag" aria-hidden="true">${flag}</span><span class="jn-sr">（${flagLabel}）</span>`
        : '<span class="jn-pill-flag" aria-hidden="true"></span>';
      const describedBy = locked ? ' aria-describedby="jn-lock-reason"' : '';
      return `<button class="${cls.join(' ')}" data-phase="${p.id}" title="${title}"`
        + ` aria-current="${isActive ? 'step' : 'false'}"`
        + (locked ? ' aria-disabled="true"' : '') + describedBy + `>
        <span class="jn-pill-head"><span class="jn-pill-no" aria-hidden="true">${p.no}</span><span>${esc(p.title)}</span>
          ${flagAria}</span>
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
        // role=tab + aria-selected + aria-controls(panel id) + roving tabindex.
        // Panel ids follow the `panel-<view>` convention; tabpanel role is applied
        // to the referenced panel if present (see wire()).
        return `<button class="jn-sub${isActive ? ' is-active' : ''}" data-view="${v}"`
          + ` role="tab" id="jn-tab-${v}" aria-controls="panel-${v}"`
          + ` aria-selected="${isActive ? 'true' : 'false'}" tabindex="${isActive ? '0' : '-1'}"`
          + `>${esc(VIEW_LABEL[v] || v)}</button>`;
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

    // Stepper is a step-ordered navigation landmark (not a tablist, per WAI-ARIA
    // APG: phases are a process, sub-views are the tabs).
    root.innerHTML =
      `<nav class="jn-top" aria-label="進行ステップ">
         <div class="jn-steps">${steps}</div>
         <div class="jn-pins">${pins}</div>
         <span id="jn-lock-reason" class="jn-sr">この手順はシミュレーション実行後に確認できます</span>
       </nav>
       <div class="jn-subs" role="tablist" aria-label="サブビュー">${subs}</div>
       <span class="jn-sr" aria-live="polite" data-jn-live></span>`;

    announce(state, activePhaseId);
    wire();
  }

  // Announce the current step + sub-view (and any locked/data hint) politely.
  function announce(state, activePhaseId) {
    const live = root.querySelector('[data-jn-live]');
    if (!live) return;
    let msg = '';
    if (activePhaseId) {
      const p = PHASES.find((q) => q.id === activePhaseId);
      const { locked } = phaseStatus(p, state);
      msg = `${p.no} ${p.title}：${VIEW_LABEL[activeView] || activeView}`;
      if (locked) msg += '（ロック中：実行後に確認できます）';
      else if (DATA_HINTED.has(p.id) && !state.hasData) msg += '（データ取込後がおすすめ）';
    } else {
      msg = VIEW_LABEL[activeView] || activeView;
    }
    live.textContent = msg;
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

    // Sub-tab keyboard model (WAI-ARIA APG tabs): roving focus with
    // ←/→/Home/End moving + selecting, Enter/Space activating.
    const tabs = Array.from(root.querySelectorAll('.jn-sub[role="tab"]'));
    tabs.forEach((tab, i) => {
      // Ensure the controlled panel is a referenceable tabpanel when it exists.
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) {
        if (!panel.getAttribute('role')) panel.setAttribute('role', 'tabpanel');
        if (!panel.getAttribute('aria-labelledby')) panel.setAttribute('aria-labelledby', tab.id);
      }
      tab.onkeydown = (e) => {
        let next = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tabs.length - 1;
        else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          pendingFocusView = tab.dataset.view;
          select(tab.dataset.view);
          return;
        } else return;
        e.preventDefault();
        pendingFocusView = tabs[next].dataset.view;
        select(tabs[next].dataset.view); // re-renders; focus restored below
      };
    });
    // After a keyboard-driven re-render, keep focus on the now-selected tab.
    if (pendingFocusView) {
      const t = root.querySelector(`.jn-sub[role="tab"][data-view="${pendingFocusView}"]`);
      pendingFocusView = null;
      if (t) t.focus();
    }
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
