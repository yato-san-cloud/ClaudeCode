// designer/sidepanel.js — the docked right-hand SIDE-TABLE that brings 保管設計
// (storage sizing + 段 vertical tuner) and 棚割り (slotting optimisation) INSIDE
// the layout (配置) screen, so the ③設計 phase no longer needs separate
// top-level sub-tabs for them. Mixed into Designer.prototype by core.js.
//
// SYNTHESIS: core.js does `Object.assign(Designer.prototype, sidePanelMethods)`.
//
// The panel is a collapsible, width-resizable drawer docked to the right edge of
// the designer body. Its open/collapsed state and width persist in localStorage.
// It HOSTS the standalone modules unchanged — `mountStorage(el, opts)` /
// `mountSlotting(el, opts)` — passing { getProject, toast }, so those modules stay
// usable on their own elsewhere (we only supply host elements + opts).
//
// When either hosted module mutates the model (保管設計's レイアウトに配置 fires
// `whsim:model-changed`, 棚割りの適用 fires `whsim:design-changed`), the designer
// re-reads the live model from the server and re-renders so new shelves / pegging
// appear on the canvas immediately. (app.js already re-opens the project on
// `whsim:model-changed`, which rebuilds the Designer; we also self-heal on
// `whsim:design-changed`, which app.js does NOT handle.)
import { mountStorage } from '../storage.js';
import { mountSlotting } from '../slotting.js';

const LS_OPEN = 'whsim-designer-sidepanel-open';   // '1' | '0'
const LS_TAB = 'whsim-designer-sidepanel-tab';     // 'storage' | 'slotting'
const LS_WIDTH = 'whsim-designer-sidepanel-w';     // px
const MIN_W = 300;
const MAX_W = 720;
const DEFAULT_W = 420;

export const sidePanelMethods = {
  // Build the drawer once, after the shell. Idempotent: a second call is a no-op
  // (the panel survives _renderTool, which only rebuilds this.body's children).
  _buildSidePanel() {
    if (this._sp) return;
    const sp = (this._sp = {
      open: this._spReadOpen(),
      tab: this._spReadTab(),
      width: this._spReadWidth(),
      mounted: { storage: null, slotting: null },
      hosts: { storage: null, slotting: null },
    });

    // ---- drawer shell (absolutely docked to the body's right edge) ----------
    const panel = document.createElement('div');
    panel.className = 'dz-sidepanel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', '設計サイドテーブル（保管設計・棚割り）');
    sp.panel = panel;

    // resize handle (left edge of the drawer)
    const grip = document.createElement('div');
    grip.className = 'dz-sp-grip';
    grip.title = 'ドラッグで幅を変更';
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-orientation', 'vertical');
    panel.appendChild(grip);
    sp.grip = grip;
    this._on(grip, 'mousedown', (e) => this._spStartResize(e));

    // header: collapse toggle + tab buttons
    const head = document.createElement('div');
    head.className = 'dz-sp-head';
    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'dz-sp-collapse';
    collapse.title = 'サイドテーブルを閉じる';
    collapse.setAttribute('aria-label', 'サイドテーブルを閉じる');
    collapse.textContent = '⟩';
    this._on(collapse, 'click', () => this._spToggle(false));
    head.appendChild(collapse);

    const tabs = document.createElement('div');
    tabs.className = 'dz-sp-tabs';
    sp.tabBtns = {};
    for (const [key, label, tip] of [
      ['storage', '保管設計', '物量→保管機器→間口/坪数/保管費。段(高さ)ピック時間も調整'],
      ['slotting', '棚割り', '加重歩行距離を最小化するスロッティング最適化と保管戦略'],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dz-sp-tab';
      b.textContent = label;
      b.title = tip;
      b.setAttribute('aria-label', `${label}: ${tip}`);
      this._on(b, 'click', () => this._spSelect(key));
      tabs.appendChild(b);
      sp.tabBtns[key] = b;
    }
    head.appendChild(tabs);
    panel.appendChild(head);

    // body: a scroll container that the hosted module renders into. overflow-y
    // auto so 保管設計/棚割り (which can be tall) scroll independently and never
    // clip; the canvas to the left stays fully usable.
    const body = document.createElement('div');
    body.className = 'dz-sp-body';
    panel.appendChild(body);
    sp.body = body;

    // ---- collapsed rail tab (a thin vertical handle to re-open) --------------
    const rail = document.createElement('button');
    rail.type = 'button';
    rail.className = 'dz-sp-rail';
    rail.title = '保管設計・棚割りを開く';
    rail.setAttribute('aria-label', '保管設計・棚割りのサイドテーブルを開く');
    rail.innerHTML = '<span>保管設計・棚割り</span>';
    this._on(rail, 'click', () => this._spToggle(true));
    sp.rail = rail;

    this.container.appendChild(panel);
    this.container.appendChild(rail);

    // React to model mutations from the hosted modules (see file header).
    sp.onModelChanged = () => this._spOnModelChanged();
    document.addEventListener('whsim:design-changed', sp.onModelChanged);
    this._listeners.push([document, 'whsim:design-changed', sp.onModelChanged]);

    this._spApplyState();
    if (sp.open) this._spEnsureMounted();
  },

  // ---- persisted state helpers ---------------------------------------------
  _spReadOpen() { try { return localStorage.getItem(LS_OPEN) === '1'; } catch (_e) { return false; } },
  _spReadTab() {
    try { const t = localStorage.getItem(LS_TAB); return t === 'slotting' ? 'slotting' : 'storage'; }
    catch (_e) { return 'storage'; }
  },
  _spReadWidth() {
    try { const w = parseInt(localStorage.getItem(LS_WIDTH), 10); return this._spClampW(w || DEFAULT_W); }
    catch (_e) { return DEFAULT_W; }
  },
  _spClampW(w) { return Math.max(MIN_W, Math.min(MAX_W, Math.round(w) || DEFAULT_W)); },
  _spPersist() {
    if (!this._sp) return;
    try {
      localStorage.setItem(LS_OPEN, this._sp.open ? '1' : '0');
      localStorage.setItem(LS_TAB, this._sp.tab);
      localStorage.setItem(LS_WIDTH, String(this._sp.width));
    } catch (_e) { /* private mode: state just won't persist */ }
  },

  // ---- open / collapse ------------------------------------------------------
  _spToggle(open) {
    if (!this._sp) return;
    this._sp.open = !!open;
    this._spPersist();
    this._spApplyState();
    if (open) this._spEnsureMounted();
  },
  _spSelect(tab) {
    if (!this._sp) return;
    this._sp.tab = tab === 'slotting' ? 'slotting' : 'storage';
    if (!this._sp.open) this._sp.open = true;
    this._spPersist();
    this._spApplyState();
    this._spEnsureMounted();
  },

  // Reflect open/tab/width into the DOM + reserve body space so the canvas and
  // inspector shrink (never get covered). Then refit the canvas to the new width.
  _spApplyState() {
    const sp = this._sp; if (!sp) return;
    const open = sp.open;
    sp.panel.style.width = sp.width + 'px';
    sp.panel.style.transform = open ? 'translateX(0)' : `translateX(${sp.width + 24}px)`;
    sp.panel.style.pointerEvents = open ? 'auto' : 'none';
    sp.panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    sp.rail.style.display = open ? 'none' : 'flex';
    for (const k in sp.tabBtns) sp.tabBtns[k].classList.toggle('active', open && sp.tab === k);
    // Reserve horizontal space on the body so canvas/library/inspector reflow
    // (the body's children are rebuilt by _renderTool, but the body element —
    // and thus this padding — persists across those rebuilds).
    if (this.body) this.body.style.paddingRight = open ? (sp.width + 12) + 'px' : '';
    // refit the active canvas into the new width.
    if (this.canvas) { this._fitCanvas(); this._repaint(); this._updateStatus && this._updateStatus(); }
  },

  // Lazily mount the hosted module for the active tab (and keep the other one if
  // already mounted). Mount once; afterwards just refresh on (re)entry.
  _spEnsureMounted() {
    const sp = this._sp; if (!sp || !sp.open) return;
    const tab = sp.tab;
    // show only the active host; create hosts on demand.
    for (const k of ['storage', 'slotting']) {
      if (sp.hosts[k]) sp.hosts[k].style.display = (k === tab) ? 'block' : 'none';
    }
    if (!sp.hosts[tab]) {
      const host = document.createElement('div');
      host.className = 'dz-sp-host';
      sp.body.appendChild(host);
      sp.hosts[tab] = host;
      const opts = { getProject: () => this._spProject(), toast: (m, k) => this._spToast(m, k) };
      sp.mounted[tab] = (tab === 'storage') ? mountStorage(host, opts) : mountSlotting(host, opts);
    } else if (sp.mounted[tab] && sp.mounted[tab].refresh) {
      sp.mounted[tab].refresh();
    }
  },

  // Resolve the current project name without a host handler: the project <select>
  // in the app header reflects the open project, and is updated on every open.
  _spProject() {
    if (this.handlers && typeof this.handlers.getProject === 'function') {
      const p = this.handlers.getProject(); if (p) return p;
    }
    const sel = document.getElementById('projectSelect');
    return (sel && sel.value) ? sel.value : null;
  },

  // Lightweight transient toast inside the drawer (the designer has no global
  // toast handler). Falls back silently if the panel was disposed.
  _spToast(msg, kind) {
    const sp = this._sp; if (!sp || !sp.body) return;
    let t = sp.toastEl;
    if (!t) {
      t = document.createElement('div');
      t.className = 'dz-sp-toast';
      sp.panel.appendChild(t);
      sp.toastEl = t;
    }
    t.textContent = String(msg);
    t.dataset.kind = kind || 'info';
    t.classList.add('show');
    clearTimeout(sp._toastTimer);
    sp._toastTimer = setTimeout(() => { if (sp.toastEl) sp.toastEl.classList.remove('show'); }, 3200);
  },

  // A hosted module mutated the model on the server (棚割り適用 / 保管配置). Re-read
  // the live model and re-render so the canvas shows the new shelves / pegging.
  // Guarded so a burst of events costs one refetch.
  async _spOnModelChanged() {
    if (this._spReloading) return;
    this._spReloading = true;
    try {
      const proj = this._spProject();
      if (!proj) return;
      const model = await fetch(`/api/projects/${encodeURIComponent(proj)}/full`,
        { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null));
      if (model) this.setModel(model);   // re-normalise + repaint the canvas
    } catch (_e) { /* tolerant: keep the current model */ }
    finally { this._spReloading = false; }
  },

  // ---- width resize (drag the left grip) -----------------------------------
  _spStartResize(e) {
    e.preventDefault();
    const sp = this._sp; if (!sp) return;
    const startX = e.clientX;
    const startW = sp.width;
    const move = (ev) => {
      // drag left = wider (the grip is on the panel's left edge).
      sp.width = this._spClampW(startW + (startX - ev.clientX));
      sp.panel.style.width = sp.width + 'px';
      if (this.body) this.body.style.paddingRight = (sp.width + 12) + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      this._spPersist();
      if (this.canvas) { this._fitCanvas(); this._repaint(); }
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  },

  // Tear down hosted modules (called from dispose()).
  _spDispose() {
    const sp = this._sp; if (!sp) return;
    for (const k of ['storage', 'slotting']) {
      const m = sp.mounted[k];
      if (m && m.dispose) { try { m.dispose(); } catch (_e) { /* noop */ } }
    }
    clearTimeout(sp._toastTimer);
    this._sp = null;
  },

  // Scoped styles for the drawer (injected once, under .designer-root).
  _spInjectStyle() {
    if (document.getElementById('dz-sidepanel-style')) return;
    const s = document.createElement('style');
    s.id = 'dz-sidepanel-style';
    s.textContent = `
    .designer-root .dz-sidepanel{
      position:absolute;top:0;right:0;height:100%;display:flex;flex-direction:column;
      background:var(--bg-panel);border-left:1px solid var(--line-strong);
      box-shadow:-8px 0 24px rgba(15,23,32,.10);z-index:25;min-width:${MIN_W}px;max-width:${MAX_W}px;
      transition:transform var(--dur-2,160ms) var(--ease-out,ease);will-change:transform;
    }
    @media (prefers-reduced-motion:reduce){
      .designer-root .dz-sidepanel{transition:none}
    }
    .designer-root .dz-sp-grip{
      position:absolute;left:-3px;top:0;width:8px;height:100%;cursor:ew-resize;z-index:2;
    }
    .designer-root .dz-sp-grip::after{
      content:"";position:absolute;left:3px;top:0;width:2px;height:100%;background:transparent;
      transition:background var(--dur-1,90ms) var(--ease-out,ease);
    }
    .designer-root .dz-sp-grip:hover::after{background:var(--accent,#2383E2)}
    .designer-root .dz-sp-head{
      flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:8px 10px;
      border-bottom:1px solid var(--line-hair);background:var(--bg-sunken);
    }
    .designer-root .dz-sp-collapse{
      flex:0 0 auto;width:26px;height:26px;padding:0;border:1px solid var(--line-hair);
      border-radius:var(--r-sm);background:var(--bg-app);color:var(--ink-secondary);
      cursor:pointer;font-size:14px;line-height:1;
    }
    .designer-root .dz-sp-tabs{display:flex;gap:4px;flex:1;min-width:0;}
    .designer-root .dz-sp-tab{
      flex:1;padding:6px 8px;border:1px solid var(--line-hair);border-radius:var(--r-sm);
      background:var(--bg-app);color:var(--ink-secondary);font-size:12.5px;font-weight:700;cursor:pointer;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .designer-root .dz-sp-tab.active{
      background:var(--ink-primary);color:var(--bg-app);border-color:var(--ink-primary);
    }
    .designer-root .dz-sp-body{
      flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px 12px 16px;
      -webkit-overflow-scrolling:touch;
    }
    .designer-root .dz-sp-host{min-height:0;}
    .designer-root .dz-sp-rail{
      position:absolute;top:50%;right:0;transform:translateY(-50%);z-index:24;
      display:flex;align-items:center;justify-content:center;writing-mode:vertical-rl;
      padding:14px 6px;border:1px solid var(--line-strong);border-right:none;
      border-radius:var(--r-md) 0 0 var(--r-md);background:var(--bg-panel);
      color:var(--ink-secondary);font-size:12px;font-weight:700;cursor:pointer;
      box-shadow:-4px 0 14px rgba(15,23,32,.08);letter-spacing:.04em;
    }
    .designer-root .dz-sp-rail:hover{color:var(--ink-primary);border-color:var(--accent,#2383E2)}
    .designer-root .dz-sp-toast{
      position:absolute;left:12px;right:12px;bottom:12px;z-index:3;
      padding:9px 12px;border-radius:var(--r-md);font-size:12.5px;line-height:1.5;
      background:var(--ink-primary);color:var(--bg-app);box-shadow:var(--sh-lg);
      opacity:0;transform:translateY(6px);pointer-events:none;
      transition:opacity var(--dur-2,160ms) var(--ease-out,ease),transform var(--dur-2,160ms) var(--ease-out,ease);
    }
    .designer-root .dz-sp-toast.show{opacity:1;transform:translateY(0)}
    .designer-root .dz-sp-toast[data-kind=error]{background:var(--bad,#e3401c)}
    .designer-root .dz-sp-toast[data-kind=ok]{background:var(--ok,#1db954)}
    /* On narrow viewports the drawer takes the full body width when open. */
    @media (max-width:880px){
      .designer-root .dz-sidepanel{max-width:100%;width:100%!important;}
    }
    `;
    document.head.appendChild(s);
  },
};
