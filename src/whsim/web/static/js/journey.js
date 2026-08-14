// journey.js — guided 5-phase navigation stepper (self-contained ES module).
// Decouples the salesperson's mental model (案件を作る→分析→設計→検証→提案) from
// the underlying view panels. PM wires real panels via opts.onSelectView(viewId);
// this component only renders the stepper + sub-tabs + cross-cutting pins and
// reflects state (✓ done / 🔒 locked) from opts.getState().
import { esc } from './util.js';

// --- Shared contract: phases, their member views, and labels ------------------

// Each phase: id, ordinal label, short title, goal subtitle, ordered view list.
// The first view in `views` is the phase's landing sub-view (clicked on the pill).
const PHASES = [
  { id: 'intake', no: '①', title: '取込', goal: '案件を作り、出荷データを取り込む', views: ['overview'] },
  // ②分析 is the single "analysis home": 物量サマリ (facts) lands first, 対話分析
  // (ask/drill), 基礎物量 (仮値 what-if volume calculator), then マテリアルフロー
  // (荷役物量の工程フロー = the "step ①: 基礎物量" deliverable — volume creation
  // belongs to 分析, not 設計; the chain it defines then drops into the drawing).
  { id: 'analyze', no: '②', title: '分析', goal: '物量・波動・ABCを読み解く', views: ['dataanalysis', 'bianalytics', 'bi', 'materialflow'] },
  // ③設計 adds 生産性試算 (pickrate): analytic motion-time productivity from the
  // MapMaker距離 — the SLC-style "step ②" that picks オーダー/マルチ/トータル
  // before any heavyweight DES run.
  // 保管設計・棚割り は「レイアウト」内のサイドパネルに集約（designer/sidepanel.js）。
  { id: 'design', no: '③', title: '設計', goal: 'レイアウト・工程・人員を組み立てる', views: ['design', 'pickrate', 'timetable'] },
  // ④検証 = DESで裏取りするレーン。原価は「判定」内、ピック順序は「作業方法比較」内、
  // 2Dと3Dは1つの「ビュー」内トグルに集約（in-view toggle, app.js が #viewToggle で描画）。
  { id: 'validate', no: '④', title: '検証', goal: '捌けるかをKPIと動きで確かめる', views: ['dashboard', 'analysis', 'view2d', 'workcompare'] },
  { id: 'propose', no: '⑤', title: '提案', goal: '提案書とシナリオ比較で見せる', views: ['viewpng', 'compare', 'export'] },
];

// Cross-cutting views: available in every phase, pinned separately (own lane).
const CROSS = [
  { id: 'chat', label: 'OCTA', icon: '🐙' },
  { id: 'notes', label: '知見', icon: '📌' },
];

// Display labels for every view id (sub-tab buttons + landing targets).
const VIEW_LABEL = {
  overview: '概要', dashboard: 'ダッシュボード', dataanalysis: '物量サマリ', bianalytics: '対話分析', bi: '基礎物量', design: 'レイアウト',
  storage: '保管設計', materialflow: 'マテリアルフロー', timetable: '人員タイムチャート', analysis: 'KPI・判定',
  pickrate: '生産性試算', slotting: '棚割り', pickseq: 'ピック順序', view2d: '2D/3Dビュー', view3d: '3Dビュー', viewpng: '提案PNG', cost: '原価試算', workcompare: '作業方法比較', compare: 'シナリオ比較',
  export: 'エクスポート', chat: 'OCTA', notes: '知見',
};

// One-line "what this view does" — surfaced as a sub-tab tooltip (title) so the
// now-many views are recognisable without clicking (recognition over recall).
const VIEW_DESC = {
  overview: '案件の概要と準備状況を確認し、次の一手を決める（→②分析）',
  dashboard: 'KPI・稼働・イベント・3Dフロアを1画面で監視する',
  dataanalysis: '取込データのKPI・チャートで物量の全体像をつかむ',
  bianalytics: '言葉で問う：ABC・曜日×時間・SKU構成を深掘り',
  bi: '仮値で荷姿変換して基礎物量を作る（→人員タイムチャート）',
  design: 'レイアウト・ゾーン・棚を配置/編集（→④検証で実行）',
  storage: '物量から必要な保管設備・坪数を試算し配置',
  timetable: '工程別の必要人員を時間帯ごとに配置',
  materialflow: '工程フローの荷役物量を組む基礎物量（→人員タイムチャート）',
  pickrate: 'MapMaker距離×動作時間で生産性を即算（オーダー/マルチ/トータル）',
  slotting: 'スロッティング最適化＋保管戦略（加重歩行距離を最小化）',
  pickseq: 'ピック順序を2-optで最適化（オーダー/マルチ/トータル比較）',
  cost: '6費目を解析的に積み上げ（実行不要・爆速）',
  analysis: '捌けるかを判定：KPI・改善提案（原価もここ）',
  view2d: '動きを2D/3Dで可視化（切替）＋混雑ヒート',
  view3d: '3Dで設備・人・搬送を可視化',
  workcompare: 'DESで4方式を裏取り＋ピック順序を最適化',
  viewpng: '課題→裏付けを1枚にまとめた提案PNG',
  compare: '現行 vs 代替案を比較（投資回収）',
  export: '提案書（PPTX/PDF）を書き出す',
  chat: 'OCTA（横断アシスタント）',
  notes: '知見ボード（横断メモ）',
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
  .jn{display:flex;flex-direction:column;gap:var(--sp-2);width:100%;
    background:var(--bg-app,#fff);border-bottom:1px solid var(--line,rgba(120,140,170,.18));
    padding:var(--sp-2) var(--sp-4) var(--sp-2)}
  .jn-top{display:flex;align-items:stretch;gap:var(--sp-2)}
  .jn-steps{display:flex;align-items:stretch;gap:var(--sp-2);flex:1;min-width:0;
    overflow-x:auto;scrollbar-width:thin;padding-bottom:2px}
  .jn-steps::-webkit-scrollbar{height:6px}
  .jn-steps::-webkit-scrollbar-thumb{background:var(--line,rgba(120,140,170,.3));border-radius:3px}
  .jn-pill{display:flex;flex-direction:column;justify-content:center;gap:2px;
    flex:0 0 auto;min-width:120px;max-width:200px;text-align:left;cursor:pointer;
    background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:12px;padding:7px 12px;font:inherit;color:var(--ink-primary,#16202e);
    transition:border-color var(--dur-1) var(--ease-out),background var(--dur-1) var(--ease-out)}
  .jn-pill:hover{border-color:var(--accent,#16C0DE)}
  .jn-pill-head{display:flex;align-items:center;gap:6px;font-size:13.5px;font-weight:700;line-height:1.2}
  .jn-pill-no{color:var(--ink-tertiary,#8195a8);font-weight:800}
  .jn-pill-flag{margin-left:auto;font-size:12px}
  .jn-pill-goal{font-size:10.5px;color:var(--ink-tertiary,#8195a8);line-height:1.3;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .jn-pill.is-active{background:var(--accent,#16C0DE);border-color:var(--accent,#16C0DE);color:var(--ink-onAccent,#04222c)}
  .jn-pill.is-active .jn-pill-no,.jn-pill.is-active .jn-pill-goal{color:var(--ink-onAccent,#04222c);opacity:.8}
  .jn-pill.is-done{border-color:var(--accent,#16C0DE)}
  .jn-pill.is-locked{opacity:.85}
  .jn-pins{display:flex;align-items:center;gap:6px;flex:0 0 auto;
    padding-left:10px;margin-left:2px;border-left:1px solid var(--line,rgba(120,140,170,.18))}
  .jn-pin{display:flex;align-items:center;gap:5px;cursor:pointer;flex:0 0 auto;
    background:transparent;border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:999px;padding:6px 11px;font:inherit;font-size:12px;font-weight:600;
    color:var(--ink-secondary,#52677c);
    transition:border-color var(--dur-1) var(--ease-out),color var(--dur-1) var(--ease-out),background var(--dur-1) var(--ease-out)}
  .jn-pin:hover{border-color:var(--accent,#16C0DE)}
  .jn-pin.is-active{background:var(--accent,#16C0DE);border-color:var(--accent,#16C0DE);color:var(--ink-onAccent,#04222c)}
  .jn-pin-icon{font-size:13px}
  .jn-subs{display:flex;align-items:center;gap:6px;overflow-x:auto;scrollbar-width:thin;
    padding-bottom:2px;min-height:30px}
  .jn-subs::-webkit-scrollbar{height:6px}
  .jn-subs::-webkit-scrollbar-thumb{background:var(--line,rgba(120,140,170,.3));border-radius:3px}
  .jn-sub{flex:0 0 auto;cursor:pointer;background:transparent;
    border:1px solid var(--line,rgba(120,140,170,.18));border-radius:8px;
    padding:5px 12px;font:inherit;font-size:12.5px;font-weight:600;
    color:var(--ink-secondary,#52677c);
    transition:border-color var(--dur-1) var(--ease-out),color var(--dur-1) var(--ease-out),background var(--dur-1) var(--ease-out)}
  .jn-sub:hover{border-color:var(--accent,#16C0DE)}
  .jn-sub.is-active{background:var(--accent,#16C0DE);border-color:var(--accent,#16C0DE);color:var(--ink-onAccent,#04222c)}
  .jn-sub-hint{font-size:11px;color:var(--ink-tertiary,#8195a8);margin-left:4px;white-space:nowrap}
  /* Arrow-key affordance for the sub-tab row (unobtrusive; hidden when narrow). */
  .jn-kbdhint{margin-left:auto;flex:0 0 auto;font-size:var(--fs-micro,11px);
    line-height:1;color:var(--ink-tertiary,#8195a8);white-space:nowrap;user-select:none;
    letter-spacing:var(--ls-micro,0.04em)}
  /* Visible keyboard focus ring (does not affect mouse interaction visuals). */
  .jn-pill:focus-visible,.jn-pin:focus-visible,.jn-sub:focus-visible{
    outline:2px solid var(--line-focus,var(--accent,#16C0DE));outline-offset:2px}
  /* Visually-hidden live region for screen-reader status announcements. */
  .jn-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
    clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
  @media (max-width:700px){
    .jn{padding:var(--sp-2) var(--sp-2) 6px}
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
    .jn-kbdhint{display:none}
  }
  `;
  document.head.appendChild(s);
}

// --- Component ----------------------------------------------------------------

// One-line description of a view (shared with the phase-hint banner so the
// "what am I looking at" line is consistent across desktop tooltip + mobile).
export function viewDesc(v) { return VIEW_DESC[v] || ''; }

export function mountJourney(el, opts = {}) {
  injectStyle();
  const onSelectView = opts.onSelectView || (() => {});
  const getState = opts.getState || (() => ({ project: null, hasData: false, hasRun: false }));

  const root = document.createElement('div');
  root.className = 'jn';
  el.innerHTML = '';
  el.appendChild(root);

  let activeView = PHASES[0].views[0];
  // View id whose sub-tab should regain focus after a keyboard-driven update.
  let pendingFocusView = null;
  // Tracks what the current DOM was structurally built for, so routine state
  // changes (active phase/view, done/locked flags) can patch the EXISTING nodes
  // instead of rebuilding innerHTML. Sub-tabs are rebuilt only when the active
  // phase changes (different view set); a project change forces a full rebuild.
  let builtSubsPhaseId = undefined;

  // ✓ used to require having WALKED PAST a phase: import data, run, and stand on
  // ①取込 and the rail showed no progress at all — it reported where you had been
  // rather than what is actually done. Phases with a real state signal (案件 /
  // 実データ / 実行) now read that signal wherever you stand; the rest keep the
  // positional rule. The phase you are ON never shows ✓ (it has the active spine,
  // and "完了" on the step you are working in reads as a lie).
  function phaseStatus(phase, state) {
    const locked = RUN_REQUIRED.has(phase.id) && !state.hasRun;
    const idx = PHASES.findIndex((p) => p.id === phase.id);
    const activePhaseId = VIEW_TO_PHASE[activeView] || null;
    const activeIdx = activePhaseId ? PHASES.findIndex((p) => p.id === activePhaseId) : -1;
    let done = false;
    if (phase.id === 'intake') done = !!state.project;
    else if (DATA_HINTED.has(phase.id)) done = !!state.hasData;
    else if (phase.id === 'validate') done = !!state.hasRun;
    else if (activeIdx >= 0 && idx < activeIdx) done = true;  // 設計/提案: 通過で判定
    if (activeIdx >= 0 && idx === activeIdx) done = false;
    return { locked, done };
  }

  // --- Static skeleton ---------------------------------------------------------
  // Built once. Pills and pins are a fixed set, so their nodes are created here
  // and only have classes/aria patched on subsequent state changes. The sub-tab
  // row content is (re)built by patchSubs() because its members vary by phase.
  function buildSkeleton() {
    const steps = PHASES.map((p) =>
      `<button class="jn-pill" data-phase="${p.id}">
        <span class="jn-pill-head"><span class="jn-pill-no" aria-hidden="true">${p.no}</span><span>${esc(p.title)}</span>
          <span class="jn-pill-flag" aria-hidden="true"></span></span>
        <span class="jn-pill-goal">${esc(p.goal)}</span>
      </button>`).join('');

    const pins = CROSS.map((c) =>
      `<button class="jn-pin" data-view="${c.id}" title="${esc(c.label)}">
        <span class="jn-pin-icon">${c.icon}</span><span>${esc(c.label)}</span>
      </button>`).join('');

    // Stepper is a step-ordered navigation landmark (not a tablist, per WAI-ARIA
    // APG: phases are a process, sub-views are the tabs).
    root.innerHTML =
      `<nav class="jn-top" aria-label="進行ステップ">
         <div class="jn-steps">${steps}</div>
         <div class="jn-pins">${pins}</div>
         <span id="jn-lock-reason" class="jn-sr">この手順はシミュレーション実行後に確認できます</span>
       </nav>
       <div class="jn-subs" role="tablist" aria-label="サブビュー"></div>
       <span class="jn-sr" aria-live="polite" data-jn-live></span>`;

    builtSubsPhaseId = undefined; // force patchSubs() to render its contents
  }

  // Patch the fixed pill/pin nodes from current state (no innerHTML rebuild).
  function patchTop(state, activePhaseId) {
    root.querySelectorAll('.jn-pill').forEach((btn) => {
      const p = PHASES.find((q) => q.id === btn.dataset.phase);
      if (!p) return;
      const { locked, done } = phaseStatus(p, state);
      const isActive = p.id === activePhaseId;
      btn.classList.toggle('is-active', isActive);
      btn.classList.toggle('is-done', done);
      btn.classList.toggle('is-locked', locked);
      btn.setAttribute('aria-current', isActive ? 'step' : 'false');
      if (locked) {
        btn.setAttribute('aria-disabled', 'true');
        btn.setAttribute('aria-describedby', 'jn-lock-reason');
        btn.title = 'シミュレーション実行後に確認できます';
      } else {
        btn.removeAttribute('aria-disabled');
        btn.removeAttribute('aria-describedby');
        btn.title = p.goal;
      }
      // Visual flag + a text/aria equivalent so state is not conveyed by colour/icon alone.
      let flag = '';
      let flagLabel = '';
      if (locked) { flag = '🔒'; flagLabel = 'ロック中'; }
      else if (done) { flag = '✓'; flagLabel = '完了'; }
      const flagEl = btn.querySelector('.jn-pill-flag');
      if (flagEl) flagEl.textContent = flag;
      // Maintain the per-pill SR state suffix (sibling of the visual flag).
      let srEl = btn.querySelector('.jn-pill-head .jn-sr');
      if (flag) {
        if (!srEl) {
          srEl = document.createElement('span');
          srEl.className = 'jn-sr';
          flagEl.insertAdjacentElement('afterend', srEl);
        }
        srEl.textContent = `（${flagLabel}）`;
      } else if (srEl) {
        srEl.remove();
      }
    });

    root.querySelectorAll('.jn-pin').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.view === activeView);
    });
  }

  // (Re)render the sub-tab row. Rebuilds its inner nodes only when the active
  // phase changes (different view set); otherwise patches active/selected state.
  function patchSubs(state, activePhaseId) {
    const subsEl = root.querySelector('.jn-subs');
    if (!subsEl) return;

    if (builtSubsPhaseId !== activePhaseId) {
      // Structure changed: build the tab/hint nodes for this phase once.
      let html = '';
      if (activePhaseId) {
        const p = PHASES.find((q) => q.id === activePhaseId);
        html = p.views.map((v) =>
          // role=tab + aria-selected + aria-controls(panel id) + roving tabindex.
          // Panel ids follow the `panel-<view>` convention; tabpanel role is
          // applied to the referenced panel if present (see linkPanels()).
          `<button class="jn-sub" data-view="${v}" role="tab" id="jn-tab-${v}"`
          + ` aria-controls="panel-${v}" aria-selected="false" tabindex="-1"`
          + (VIEW_DESC[v] ? ` title="${esc(VIEW_DESC[v])}"` : '')
          + `>${esc(VIEW_LABEL[v] || v)}</button>`).join('');
        html += '<span class="jn-sub-hint" data-jn-subhint hidden></span>';
        // Arrow-key affordance lives at the end of the row (own lane via margin).
        html += '<span class="jn-kbdhint" aria-hidden="true">← / →</span>';
      } else {
        html = '<span class="jn-sub-hint" data-jn-subhint></span>';
      }
      subsEl.innerHTML = html;
      builtSubsPhaseId = activePhaseId;
      linkPanels();
    }

    // Patch roving tabindex + selected state on the (now-present) tabs.
    if (activePhaseId) {
      subsEl.querySelectorAll('.jn-sub[role="tab"]').forEach((tab) => {
        const isActive = tab.dataset.view === activeView;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        tab.tabIndex = isActive ? 0 : -1;
      });
    }

    // Update the contextual hint text (locked / data-hinted / cross-cutting).
    const hintEl = subsEl.querySelector('[data-jn-subhint]');
    if (hintEl) {
      let hint = '';
      if (activePhaseId) {
        const p = PHASES.find((q) => q.id === activePhaseId);
        const { locked } = phaseStatus(p, state);
        if (locked) hint = '🔒 実行するとここで結果を確認できます';
        else if (DATA_HINTED.has(p.id) && !state.hasData) hint = 'データ取込後がおすすめ';
        // Otherwise show what the ACTIVE sub-view does (recognition aid, touch-
        // friendly — a persistent "what am I looking at" line, not just a tooltip).
        else hint = VIEW_DESC[activeView] || '';
      } else {
        hint = VIEW_DESC[activeView]
          || (activeView === 'chat' ? 'OCTA（横断アシスタント）' : '知見ボード（横断メモ）');
      }
      hintEl.textContent = hint;
      hintEl.hidden = !hint;
    }
  }

  // Ensure each controlled panel is a referenceable tabpanel when it exists.
  // Run once per sub-tab rebuild (idempotent on the panels it touches).
  function linkPanels() {
    root.querySelectorAll('.jn-sub[role="tab"]').forEach((tab) => {
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (!panel) return;
      if (!panel.getAttribute('role')) panel.setAttribute('role', 'tabpanel');
      if (!panel.getAttribute('aria-labelledby')) panel.setAttribute('aria-labelledby', tab.id);
    });
  }

  // Incremental state reflection: patch the existing DOM in place. No innerHTML
  // teardown, no per-node listener re-wiring (delegated listeners live on root).
  function render() {
    const state = getState();
    const activePhaseId = VIEW_TO_PHASE[activeView] || null;
    patchTop(state, activePhaseId);
    patchSubs(state, activePhaseId);
    announce(state, activePhaseId);
    // After a keyboard-driven update, keep focus on the now-selected tab.
    if (pendingFocusView) {
      const t = root.querySelector(`.jn-sub[role="tab"][data-view="${pendingFocusView}"]`);
      pendingFocusView = null;
      if (t) t.focus();
    }
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

  // --- Delegated event handling -----------------------------------------------
  // One click + one keydown listener on the container, wired exactly once at
  // mount. They survive every render because the container is never rebuilt for
  // routine state changes, eliminating the per-render re-registration churn.

  function onClick(e) {
    const phaseBtn = e.target.closest('[data-phase]');
    if (phaseBtn && root.contains(phaseBtn)) {
      const phase = PHASES.find((p) => p.id === phaseBtn.dataset.phase);
      if (!phase) return;
      const state = getState();
      const { locked } = phaseStatus(phase, state);
      select(phase.views[0]);
      if (locked && typeof opts.onLockedAttempt === 'function') {
        opts.onLockedAttempt(phase.id, phase.views[0]);
      }
      return;
    }
    const viewBtn = e.target.closest('[data-view]');
    if (viewBtn && root.contains(viewBtn)) {
      select(viewBtn.dataset.view);
    }
  }

  // Sub-tab keyboard model (WAI-ARIA APG tabs): roving focus with
  // ←/→/Home/End moving + selecting, Enter/Space activating.
  function onKeyDown(e) {
    const tab = e.target.closest('.jn-sub[role="tab"]');
    if (!tab || !root.contains(tab)) return;
    const tabs = Array.from(root.querySelectorAll('.jn-sub[role="tab"]'));
    const i = tabs.indexOf(tab);
    if (i < 0) return;
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
    select(tabs[next].dataset.view); // patches in place; focus restored in render()
  }

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeyDown);

  function select(viewId) {
    if (!viewId) return;
    activeView = viewId;
    onSelectView(viewId);
    render();
  }

  buildSkeleton();
  render();

  return {
    setActive(viewId) {
      if (!viewId || viewId === activeView) { render(); return; }
      activeView = viewId;
      render();
    },
    refresh() { render(); },
    dispose() {
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeyDown);
      el.innerHTML = '';
    },
  };
}
