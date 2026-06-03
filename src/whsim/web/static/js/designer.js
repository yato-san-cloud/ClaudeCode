// designer.js — interactive, structured/parametric warehouse design editor.
//
// Three sub-tools share one container and one deep-copied model:
//   (1) レイアウト  — Canvas2D floor view; select/move/resize zones, edit type
//                     and rack spacing, add/delete zones.
//   (2) 設備        — same floor view; click-to-place AGV / 自動倉庫 / 梱包台,
//                     draw コンベア polylines; edit count/speed; delete.
//   (3) フロー      — DOM workflow strip of stages with per-stage method
//                     dropdowns + a pick-strategy selector.
//
// Pure DOM / Canvas2D — no imports. Mutates an internal deep copy of `model`
// and only writes back to the host via handlers.save({layout, resources, process}).

// ---- constants -------------------------------------------------------------
const ZONE_JP = {
  receiving: '入荷', storage: '保管', picking: 'ピッキング',
  packing: '梱包', shipping: '出荷', staging: '一時保管',
};
const ZONE_TYPES = ['receiving', 'storage', 'picking', 'packing', 'shipping', 'staging'];
const ZONE_DEFAULT_COLOR = {
  receiving: '#74add1', storage: '#fdae61', picking: '#a6d96a',
  packing: '#f46d43', shipping: '#5e4fa2', staging: '#d9d9d9',
};
// Equipment palette: label, schema type, fill color.
const EQUIP_PALETTE = [
  { key: 'agv', label: 'AGV(搬送ロボ)', type: 'agv', color: '#1f78b4' },
  { key: 'conveyor', label: 'コンベア', type: 'conveyor', color: '#33a02c' },
  { key: 'asrs', label: '自動倉庫', type: 'asrs', color: '#6a3d9a' },
  { key: 'station', label: '梱包台', type: 'station', color: '#08519c' },
  { key: 'robot_arm', label: 'ロボットアーム', type: 'robot_arm', color: '#e6550d' },
  { key: 'crane', label: 'ホイストクレーン', type: 'crane', color: '#8c564b' },
];
// Layout object palette (PPT-like): pick an object, then click the floor to place it.
//   key       — palette/brush id (also a tooltip for the cursor)
//   label     — Japanese button label
//   zoneType  — schema zone type to create
//   w,h       — default footprint in meters
//   rack      — if set, the new zone is created with this parametric rack fill
const LAYOUT_PALETTE = [
  { key: 'shelf_block', label: '棚ブロック', zoneType: 'storage', w: 12, h: 8,
    rack: { col_spacing: 4, row_spacing: 3, margin: 2 } },
  { key: 'pack_station', label: '梱包台', zoneType: 'packing', w: 6, h: 4 },
  { key: 'receiving', label: '入荷ゾーン', zoneType: 'receiving', w: 10, h: 6 },
  { key: 'picking', label: 'ピッキングゾーン', zoneType: 'picking', w: 10, h: 6 },
  { key: 'shipping', label: '出荷ゾーン', zoneType: 'shipping', w: 10, h: 6 },
  { key: 'staging', label: '一時保管ゾーン', zoneType: 'staging', w: 8, h: 5 },
];
// Storage-equipment presets (mirror whsim.racktypes): bay×depth (m) + colour.
// Drawing a 棚ブロック creates a SHELF area of the chosen type; cells fill at its
// pitch (bays along the run, depth across).
const RACK_TYPES = {
  light:     { label: '軽量棚', bay: 0.9, depth: 0.45, color: '#7fb0f2' },
  medium:    { label: '中量棚', bay: 1.2, depth: 0.6, color: '#2ee6a0' },
  pallet:    { label: 'パレットラック', bay: 1.1, depth: 1.1, color: '#f5b05a' },
  nestainer: { label: 'ネステナー', bay: 1.1, depth: 1.4, color: '#9b6bff' },
  flow:      { label: 'フローラック', bay: 1.0, depth: 1.5, color: '#34e3ff' },
  asrs:      { label: '自動倉庫(AS/RS)', bay: 0.8, depth: 1.2, color: '#5cebff' },
};
const RACK_ORDER = ['light', 'medium', 'pallet', 'nestainer', 'flow', 'asrs'];
// Door palette for the 躯体 (building) tool: label, schema type, marker color.
const DOOR_PALETTE = [
  { type: 'dock', label: 'ドックドア', color: '#1f78b4' },
  { type: 'personnel', label: '通用口', color: '#33a02c' },
  { type: 'shutter', label: 'シャッター', color: '#888888' },
];
const DOOR_JP = { dock: 'ドックドア', personnel: '通用口', shutter: 'シャッター' };
const METHOD_OPTS = [
  { value: 'manual', label: '人手' }, { value: 'agv', label: 'AGV' },
  { value: 'conveyor', label: 'コンベア' }, { value: 'asrs', label: '自動倉庫' },
];
const METHOD_COLOR = {
  manual: '#9aa4b0', agv: '#1f78b4', conveyor: '#33a02c', asrs: '#6a3d9a',
};
const PICK_STRATS = [
  { value: 'discrete', label: '都度ピック' }, { value: 'batch', label: 'バッチ' },
  { value: 'zone', label: 'ゾーン' }, { value: 'wave', label: 'ウェーブ' },
];
// Work-method 5-axis controls (cf. docs/WORK_METHOD_DESIGN.md). Plain-Japanese
// labels for a non-expert; the expert term shows as a small sub-label. Only the
// pick stage exposes all 5 axes; other stages expose just transport (A).
const WORK_AXES = {
  // A 搬送主体: who moves — 人が歩く / 物が来る
  transport: { label: '誰が動く？', sub: '搬送 (transport)', opts: [
    { value: 'manual', label: '人が歩く' }, { value: 'agv', label: 'AGV/AMRが来る' },
    { value: 'conveyor', label: 'コンベアで来る' }, { value: 'asrs', label: '自動倉庫が出す' },
  ] },
  // C ゾーン分担
  zoning: { label: 'エリアを分けて並列に採る？', sub: 'ゾーン (zoning)', opts: [
    { value: 'none', label: '全域を1人で' }, { value: 'sequential', label: 'ゾーンを順に受け渡し' },
    { value: 'parallel', label: 'ゾーン分担で並列' },
  ] },
  // D 採り方: 摘み取り / 種まき
  consolidation: { label: 'オーダー別？ 総量→仕分け？', sub: '集約 (consolidation)', opts: [
    { value: 'pick', label: 'オーダー別に採る（摘み取り）' },
    { value: 'sort', label: '総量を採って後で仕分け（種まき）' },
  ] },
  // E 投入: 連続 / ウェーブ
  release: { label: 'いつ流す？', sub: '投入 (release)', opts: [
    { value: 'continuous', label: '随時（連続）' }, { value: 'wave', label: '締め単位（ウェーブ）' },
  ] },
};
// Default 5-axis work method (mirrors schema WorkMethod defaults; always valid).
const DEFAULT_WORK = {
  transport: 'manual', orders_per_trip: 1, zoning: 'none',
  consolidation: 'pick', release: 'continuous', wave_interval_s: 1800,
};
// 動線 (flow-line) movers: label, schema key, default speed (m/s), polyline color.
const MOVER_OPTS = [
  { value: 'person', label: '作業員' }, { value: 'forklift', label: 'フォークリフト' },
];
const MOVER_JP = { person: '作業員', forklift: 'フォークリフト' };
const MOVER_SPEED = { person: 1.2, forklift: 2.0 };
const MOVER_COLOR = { person: '#e7298a', forklift: '#1b9e77' };

const HANDLE = 12;        // bottom-right resize handle size in px
const MIN_M = 1;          // smallest zone dimension in meters
const SNAP = 0.5;         // grid snap in meters

// ---- theme-aware canvas palette --------------------------------------------
// Drawing colors are resolved from CSS custom properties at draw time (cached on
// the instance, refreshed on the `themechange` event). Fallbacks equal the prior
// hardcoded hexes so LIGHT mode is pixel-identical; dark variants live in
// styles.css. Chrome (toolbar/help/side panels) uses the app's CSS vars directly.
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function resolvePalette() {
  return {
    bg:           cssVar('--canvas-bg', 'transparent'),
    shell:        cssVar('--canvas-shell', '#333'),
    ink:          cssVar('--canvas-ink', '#3a4452'),
    inkDim:       cssVar('--canvas-ink-dim', '#aab2bd'),
    inkFaint:     cssVar('--canvas-ink-faint', '#9aa4b0'),
    rack:         cssVar('--canvas-rack', 'rgba(60,72,90,0.5)'),
    sel:          cssVar('--canvas-sel', '#1f2733'),
    selInk:       cssVar('--canvas-sel-ink', '#fff'),
    markerStroke: cssVar('--canvas-marker-stroke', '#fff'),
    badgeBg:      cssVar('--canvas-badge-bg', 'rgba(31,39,51,0.88)'),
    wall:         cssVar('--canvas-wall', '#5a6472'),
    draft:        cssVar('--canvas-draft', '#e31a1c'),
    accent:       cssVar('--accent', '#1f78b4'),
  };
}

// ---- small helpers ---------------------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o || {}));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const snap = (v) => Math.round(v / SNAP) * SNAP;
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 7)}`;
function hexA(hex, a) {                       // "#rrggbb" -> rgba()
  if (!hex || hex[0] !== '#') hex = '#cccccc';
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export class Designer {
  constructor(container, model, handlers) {
    this.container = container;
    this.handlers = handlers || {};
    this.tool = 'layout';          // 'layout' | 'equip' | 'building' | 'flow' | 'route'
    this.selected = null;          // {kind, id} of selected canvas object
    this.layoutBrush = null;       // active palette key in レイアウト tool (null = select/move)
    this.shelfType = 'medium';     // storage-equipment preset applied to new 棚ブロック
    this.showUnderlay = true;      // draw DXF walls as a faint trace underlay in レイアウト
    this.equipBrush = 'agv';       // active palette key in 設備 tool
    this.doorBrush = 'dock';       // active door type in 躯体 tool
    this.buildMode = 'wall';       // 'wall' | 'door' within the 躯体 tool
    this.wallDraft = null;         // [[x,y],...] while drawing a wall polyline
    this.conveyorDraft = null;     // [[x,y],...] while drawing a conveyor
    this.routeMover = 'person';    // active mover for new 動線 routes
    this.routeSpeed = MOVER_SPEED.person; // active speed (m/s) for new routes
    this.routeDraft = null;        // [[x,y],...] while drawing a 動線 polyline
    this.flowMode = false;         // フロー tool: true = clicking zones lays the flow
    this.flowCursor = 0;           // index into process.flow currently being placed
    this.flowMethodStage = null;   // stage id whose method popover is open
    this.drag = null;              // active drag state on the canvas
    this._listeners = [];          // [el, type, fn] for clean dispose()
    this.pal = resolvePalette();   // cached theme-aware canvas palette
    this._normalize(model);
    this._buildShell();
    this._bindWindow();
    this._bindKeys();
    this._bindTheme();
    this._selectTool('layout');
  }

  // Re-resolve the canvas palette and repaint when the app toggles light/dark.
  // (Bound once on the document; cleaned up via _listeners in dispose().)
  _bindTheme() {
    this._on(document, 'themechange', () => {
      this.pal = resolvePalette();
      // Repaint the active canvas tool, and rebuild chrome that embeds inline
      // theme colors (active-tool highlights, help popover) so it follows suit.
      if (this.tool === 'flow') this._drawFlowCanvas();
      else if (this.ctx) this._drawCanvas();
      if (this._helpEl) { this._toggleHelp(); this._toggleHelp(); }  // refresh popover colors
    });
  }

  // ---- public API ----------------------------------------------------------
  setModel(model) {
    this._normalize(model);
    this.selected = null;
    this.conveyorDraft = null;
    this.wallDraft = null;
    this.routeDraft = null;
    this._renderTool();
  }

  resize() {
    if (!this.canvas) return;
    this._fitCanvas();
    if (this.tool === 'flow') this._drawFlowCanvas();
    else this._drawCanvas();
  }

  dispose() {
    for (const [el, type, fn] of this._listeners) el.removeEventListener(type, fn);
    this._listeners = [];
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._helpEl && this._helpEl.parentNode) this._helpEl.parentNode.removeChild(this._helpEl);
    this._helpEl = null;
    this.container.innerHTML = '';
  }

  // ---- help / legend overlay ------------------------------------------------
  _toggleHelp() {
    if (this._helpEl) { this._helpEl.remove(); this._helpEl = null; return; }
    const box = document.createElement('div');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', '設計エディタのヘルプ');
    box.style.cssText = 'position:absolute;top:48px;right:16px;z-index:30;width:320px;max-width:calc(100% - 32px);'
      + 'background:var(--bg-panel);border:1px solid var(--line-strong);border-radius:10px;box-shadow:var(--sh-lg);'
      + 'padding:14px 16px;font-size:12px;color:var(--ink-secondary);line-height:1.7;';
    box.innerHTML = '<div style="font-weight:700;font-size:13px;margin-bottom:6px;color:var(--ink-primary);">操作ヘルプ</div>'
      + '<div><b>レイアウト</b>: パレットを選んで床をクリックで配置。ゾーンをドラッグで移動、右下のハンドルでサイズ変更。</div>'
      + '<div><b>設備</b>: 床をクリックで設置、マーカーで選択。コンベアは頂点を追加してダブルクリックで確定。</div>'
      + '<div><b>躯体</b>: 壁は頂点を追加してダブルクリックで確定。ドアは縁をクリックで配置。</div>'
      + '<div><b>フロー</b>: 工程をクリックで作業方法を設定。「床図でフロー配置」で工程→ゾーンを割当。</div>'
      + '<div><b>動線</b>: 床をクリックで頂点追加、ダブルクリックで確定。距離と所要時間を自動計算。</div>'
      + '<div style="margin-top:8px;border-top:1px solid var(--line-hair);padding-top:8px;">'
      + '<b>キーボード</b><br>選択を削除: <b>Delete</b> / 取消: <b>Esc</b><br>'
      + '元に戻す: <b>Ctrl/⌘+Z</b> / やり直す: <b>Ctrl/⌘+Shift+Z</b></div>'
      + '<div style="margin-top:8px;color:var(--ink-tertiary);">変更は「適用（保存）」を押すまでサーバーに保存されません。</div>';
    const close = document.createElement('button');
    close.textContent = '閉じる';
    close.style.cssText = 'margin-top:10px;padding:5px 10px;border:1px solid var(--line-hair);border-radius:6px;background:var(--bg-app);color:var(--ink-primary);cursor:pointer;font-size:12px;';
    this._on(close, 'click', () => this._toggleHelp());
    box.appendChild(close);
    this.container.appendChild(box);
    this._helpEl = box;
  }

  // ---- model normalization (defensive against missing fields) --------------
  _normalize(model) {
    const m = clone(model);
    m.layout = m.layout || {};
    m.layout.bounds = m.layout.bounds || { width: 80, depth: 40 };
    m.layout.bounds.width = +m.layout.bounds.width || 80;
    m.layout.bounds.depth = +m.layout.bounds.depth || 40;
    m.layout.zones = Array.isArray(m.layout.zones) ? m.layout.zones : [];
    m.layout.zones.forEach((z, i) => { if (!z.id) z.id = uid('zone'); if (!z.type) z.type = 'storage'; });
    m.layout.walls = Array.isArray(m.layout.walls) ? m.layout.walls : [];
    m.layout.walls.forEach((w) => {
      if (!w.id) w.id = uid('wall');
      if (!Array.isArray(w.points)) w.points = [];
      if (!(+w.thickness > 0)) w.thickness = 0.3;
    });
    m.layout.doors = Array.isArray(m.layout.doors) ? m.layout.doors : [];
    m.layout.doors.forEach((d) => {
      if (!d.id) d.id = uid('door');
      if (!DOOR_JP[d.type]) d.type = 'dock';
      d.x = +d.x || 0; d.y = +d.y || 0;
      if (!(+d.w > 0)) d.w = d.type === 'dock' ? 3 : d.type === 'shutter' ? 4 : 1;
    });
    m.resources = m.resources || {};
    m.resources.workers = m.resources.workers || [];
    m.resources.equipment = Array.isArray(m.resources.equipment) ? m.resources.equipment : [];
    m.resources.conveyors = Array.isArray(m.resources.conveyors) ? m.resources.conveyors : [];
    m.resources.stations = Array.isArray(m.resources.stations) ? m.resources.stations : [];
    m.resources.equipment.forEach((e) => { if (!e.id) e.id = uid('eq'); });
    m.resources.conveyors.forEach((c) => { if (!c.id) c.id = uid('cv'); if (!Array.isArray(c.points)) c.points = []; });
    m.resources.stations.forEach((s) => { if (!s.id) s.id = uid('st'); });
    m.process = m.process || {};
    if (!Array.isArray(m.process.stages) || !m.process.stages.length) {
      m.process.stages = [
        { id: 'receive', label: '入荷', method: 'manual', zone: 'receiving' },
        { id: 'putaway', label: '格納', method: 'manual', zone: 'storage' },
        { id: 'pick', label: 'ピッキング', method: 'manual', zone: 'picking' },
        { id: 'pack', label: '梱包', method: 'manual', zone: 'packing' },
        { id: 'ship', label: '出荷', method: 'manual', zone: 'shipping' },
      ];
    }
    // Stage spatial/work fields are optional (always-runnable): keep zone as the
    // bound zone id (or null) and leave work === null unless explicitly designed.
    m.process.stages.forEach((st) => {
      if (st.zone === undefined) st.zone = null;
      if (st.work === undefined) st.work = null;
    });
    // flow = ordered list of stage ids; default to stage order if absent.
    if (!Array.isArray(m.process.flow) || !m.process.flow.length) {
      m.process.flow = m.process.stages.map((st) => st.id);
    }
    m.process.pick_strategy = m.process.pick_strategy || 'discrete';
    m.routes = Array.isArray(m.routes) ? m.routes : [];
    m.routes.forEach((rt, i) => {
      if (!rt.id) rt.id = uid('route');
      if (!MOVER_JP[rt.mover]) rt.mover = 'person';
      if (!rt.name) rt.name = `動線${i + 1}`;
      if (!(+rt.speed_mps > 0)) rt.speed_mps = MOVER_SPEED[rt.mover] || 1.2;
      rt.points = Array.isArray(rt.points) ? rt.points : [];
    });
    this.model = m;
  }

  // ---- shell: top tool tabs, body, save row --------------------------------
  _buildShell() {
    const c = this.container;
    c.innerHTML = '';
    c.classList.add('designer-root');
    c.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;gap:8px;font-size:13px;position:relative;';

    // tool switch bar
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';
    this._toolBtns = {};
    const TOOL_TIP = {
      layout: 'ゾーン（区画）の配置・移動・サイズ変更',
      equip: 'AGV・コンベア・自動倉庫・梱包台などの設備を設置',
      building: '建屋の壁とドア（ドック/通用口/シャッター）を作図',
      flow: '工程の順序と作業方法、各工程の場所（ゾーン）を設定',
      route: '作業員・フォークリフトの動線を作図し距離/時間を確認',
    };
    for (const [key, label] of [['layout', 'レイアウト'], ['equip', '設備'], ['building', '躯体'], ['flow', 'フロー'], ['route', '動線']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = TOOL_TIP[key] || label;
      b.setAttribute('aria-label', `${label}: ${TOOL_TIP[key] || ''}`);
      this._on(b, 'click', () => this._selectTool(key));
      bar.appendChild(b);
      this._toolBtns[key] = b;
    }
    // help / legend toggle (keyboard shortcuts + tool guide)
    const help = document.createElement('button');
    help.textContent = '?';
    help.title = 'ヘルプ / ショートカット';
    help.setAttribute('aria-label', 'ヘルプとキーボードショートカット');
    this._on(help, 'click', () => this._toggleHelp());
    bar.appendChild(help);
    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    bar.appendChild(spacer);
    // undo / redo
    this._undoBtn = document.createElement('button');
    this._undoBtn.textContent = '元に戻す';
    this._undoBtn.title = '元に戻す (Ctrl/⌘+Z)';
    this._undoBtn.setAttribute('aria-label', '元に戻す');
    this._on(this._undoBtn, 'click', () => this._undo());
    bar.appendChild(this._undoBtn);
    this._redoBtn = document.createElement('button');
    this._redoBtn.textContent = 'やり直す';
    this._redoBtn.title = 'やり直す (Ctrl/⌘+Shift+Z)';
    this._redoBtn.setAttribute('aria-label', 'やり直す');
    this._on(this._redoBtn, 'click', () => this._redo());
    bar.appendChild(this._redoBtn);
    this._refreshUndoBtns();
    const save = document.createElement('button');
    save.className = 'primary';
    save.textContent = '適用（保存）';
    save.style.fontWeight = '700';
    this._on(save, 'click', () => this._save());
    bar.appendChild(save);
    this._saveBtn = save;
    this._saveMsg = document.createElement('span');
    this._saveMsg.style.cssText = 'font-size:12px;color:var(--ink-secondary);max-width:340px;';
    bar.appendChild(this._saveMsg);
    c.appendChild(bar);

    // "編集はPC推奨" note (CSS shows it only ≤880px).
    const pcNote = document.createElement('div');
    pcNote.className = 'designer-pc-note';
    pcNote.textContent = '細かな配置・ドラッグ編集はマウスのあるPCを推奨します。スマホ/タブレットでは閲覧とタップ配置のみご利用ください。';
    c.appendChild(pcNote);

    // body: canvas area + side editor (filled per tool)
    this.body = document.createElement('div');
    this.body.style.cssText = 'flex:1;min-height:0;display:flex;gap:8px;flex-wrap:wrap;';
    c.appendChild(this.body);
  }

  _selectTool(key) {
    this.tool = key;
    this.selected = null;
    this.layoutBrush = null;
    this.conveyorDraft = null;
    this.wallDraft = null;
    this.routeDraft = null;
    this.flowMethodStage = null;
    if (key !== 'flow') this.flowMode = false;
    for (const k in this._toolBtns) {
      const active = k === key;
      const b = this._toolBtns[k];
      b.style.cssText = active
        ? 'background:var(--ink-primary);color:var(--bg-app);border-color:var(--ink-primary);font-weight:700;'
        : '';
    }
    this._renderTool();
  }

  _renderTool() {
    this.body.innerHTML = '';
    if (this.tool === 'flow') { this._renderFlow(); return; }
    if (this.tool === 'route') { this._renderRoute(); return; }
    // canvas-based tools (layout / equip / building) share the floor view + a side panel.
    // The レイアウト tool gets a control bar above the canvas (palette / underlay / inventory).
    let canvasHost;
    if (this.tool === 'layout') {
      const left = document.createElement('div');
      left.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;';
      this._renderLayoutBar(left);
      const wrap = document.createElement('div');
      wrap.style.cssText = 'flex:1;min-height:0;position:relative;border:1px solid var(--line-hair);border-radius:8px;background:var(--bg-app);overflow:hidden;';
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText = `width:100%;height:100%;display:block;cursor:${this.layoutBrush ? 'crosshair' : 'default'};`;
      wrap.appendChild(this.canvas);
      left.appendChild(wrap);
      this.body.appendChild(left);
      canvasHost = wrap;
    } else {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'flex:1;min-width:0;position:relative;border:1px solid var(--line-hair);border-radius:8px;background:var(--bg-app);overflow:hidden;';
      this.canvas = document.createElement('canvas');
      // equip/building tools are click-to-place: a crosshair signals placement.
      this.canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:crosshair;';
      wrap.appendChild(this.canvas);
      this.body.appendChild(wrap);
      canvasHost = wrap;
    }

    this.side = document.createElement('div');
    this.side.style.cssText = 'width:240px;flex:0 0 240px;overflow-y:auto;border:1px solid var(--line-hair);border-radius:8px;background:var(--bg-sunken);padding:10px;';
    this.body.appendChild(this.side);

    this.ctx = this.canvas.getContext('2d');
    this._bindCanvas();
    this._fitCanvas();
    this._renderSide();
    this._drawCanvas();
  }

  // ---- レイアウト control bar: object palette + underlay toggle + inventory ----
  _renderLayoutBar(parent) {
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;border:1px solid var(--line-hair);border-radius:8px;background:var(--bg-sunken);';

    const palLbl = document.createElement('span');
    palLbl.textContent = '配置:';
    palLbl.style.cssText = 'font-size:12px;color:var(--ink-secondary);font-weight:700;';
    bar.appendChild(palLbl);

    // PPT-like object palette: click an object, then click the floor to place it.
    for (const p of LAYOUT_PALETTE) {
      const b = this._btn(bar, p.label, () => {
        this.layoutBrush = (this.layoutBrush === p.key) ? null : p.key;
        this.selected = null;
        this._renderTool();
      });
      if (this.layoutBrush === p.key) b.style.cssText += ';background:var(--ink-primary);color:var(--bg-app);border-color:var(--ink-primary);font-weight:700;';
    }

    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    bar.appendChild(spacer);

    // DXF underlay toggle (only meaningful when walls exist, but always shown)
    const ulLbl = document.createElement('label');
    ulLbl.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;color:var(--ink-secondary);cursor:pointer;';
    const ulCb = document.createElement('input');
    ulCb.type = 'checkbox';
    ulCb.checked = !!this.showUnderlay;
    this._on(ulCb, 'change', () => { this.showUnderlay = ulCb.checked; this._drawCanvas(); });
    ulLbl.appendChild(ulCb);
    ulLbl.appendChild(document.createTextNode('下地を表示'));
    bar.appendChild(ulLbl);

    // inventory assignment button (calls optional handlers.assignInventory)
    this._btn(bar, '在庫を割付', () => this._assignInventory());

    // status line for placement hint / inventory result
    this._layoutStatus = document.createElement('span');
    this._layoutStatus.style.cssText = 'font-size:12px;color:var(--ink-secondary);max-width:100%;flex-basis:100%;';
    this._layoutStatus.textContent = this.layoutBrush
      ? `「${(LAYOUT_PALETTE.find((q) => q.key === this.layoutBrush) || {}).label}」を選択中。床をクリックして配置します。`
      : 'パレットから配置する物を選ぶか、既存のゾーンをクリックして編集します。';
    bar.appendChild(this._layoutStatus);

    parent.appendChild(bar);
  }

  // ---- 在庫を割付: call optional async handler, surface its Japanese summary ----
  async _assignInventory() {
    if (!this.handlers.assignInventory) {
      if (this._layoutStatus) this._layoutStatus.textContent = '在庫割付ハンドラがありません。';
      return;
    }
    if (this._layoutStatus) {
      this._layoutStatus.style.color = 'var(--ink-secondary)';
      this._layoutStatus.textContent = '在庫を割付中…';
    }
    try {
      const r = await this.handlers.assignInventory();
      const msg = (r && r.message)
        ? r.message
        : (r ? `割付 ${r.assigned ?? '?'} / ロケーション ${r.locations ?? '?'} / SKU ${r.skus ?? '?'}` : '割付が完了しました。');
      if (this._layoutStatus) { this._layoutStatus.style.color = 'var(--ok)'; this._layoutStatus.textContent = msg; }
    } catch (err) {
      if (this._layoutStatus) {
        this._layoutStatus.style.color = 'var(--bad)';
        this._layoutStatus.textContent = 'エラー: ' + (err && err.message ? err.message : String(err));
      }
    }
  }

  // ---- 動線 tool: floor view + control bar + live distance/time table ------
  _renderRoute() {
    // left column: control bar above the floor canvas
    const left = document.createElement('div');
    left.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;';

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;border:1px solid var(--line-hair);border-radius:8px;background:var(--bg-sunken);';
    // mover selector
    const moverSel = this._select(bar, MOVER_OPTS, this.routeMover);
    this._on(moverSel, 'change', () => {
      this.routeMover = moverSel.value;
      this.routeSpeed = MOVER_SPEED[this.routeMover] || 1.2;
      this._renderRoute();
    });
    // speed input (m/s)
    const spLbl = document.createElement('span');
    spLbl.textContent = '速度(m/s)';
    spLbl.style.cssText = 'font-size:12px;color:var(--ink-secondary);';
    bar.appendChild(spLbl);
    const spInp = this._num(this.routeSpeed, (v) => { this.routeSpeed = Math.max(0.1, v); }, 0.1);
    spInp.style.cssText += ';width:70px;padding:5px 7px;border:1px solid var(--line-hair);border-radius:6px;font-size:13px;background:var(--bg-app);color:var(--ink-primary);';
    bar.appendChild(spInp);
    this._btn(bar, '新規ルート', () => {
      if (this.routeDraft && this.routeDraft.length >= 2) this._finishRoute();
      this.routeDraft = [];
      this.selected = null;
      this._renderRoute();
    });
    this._btn(bar, '確定', () => this._finishRoute());
    this._btn(bar, '削除', () => this._deleteSelectedRoute(), 'color:var(--bad);');
    left.appendChild(bar);

    // floor canvas
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;min-height:0;position:relative;border:1px solid var(--line-hair);border-radius:8px;background:var(--bg-app);overflow:hidden;';
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:crosshair;';
    wrap.appendChild(this.canvas);
    left.appendChild(wrap);
    this.body.appendChild(left);

    // right column: live 動線一覧 table
    this.side = document.createElement('div');
    this.side.style.cssText = 'width:300px;flex:0 0 300px;overflow-y:auto;border:1px solid var(--line-hair);border-radius:8px;background:var(--bg-sunken);padding:10px;';
    this.body.appendChild(this.side);

    this.ctx = this.canvas.getContext('2d');
    this._bindCanvas();
    this._fitCanvas();
    this._renderRouteTable();
    this._drawCanvas();
  }

  // length of a polyline in meters
  _routeLength(pts) {
    if (!Array.isArray(pts) || pts.length < 2) return 0;
    let d = 0;
    for (let i = 1; i < pts.length; i++) {
      d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    return d;
  }

  _renderRouteTable() {
    const s = this.side; if (!s) return;
    s.innerHTML = '';
    this._h(s, '動線一覧');
    this._note(s, '床をクリックで頂点追加、ダブルクリックか「確定」で完了。ルート付近をクリックで選択。');

    const routes = this.model.routes || [];
    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;';
    const thead = document.createElement('tr');
    for (const t of ['名称', '種別', '距離(m)', '所要(秒)']) {
      const th = document.createElement('th');
      th.textContent = t;
      th.style.cssText = 'text-align:left;padding:4px 6px;border-bottom:2px solid var(--line-hair);color:var(--ink-secondary);font-weight:700;';
      thead.appendChild(th);
    }
    table.appendChild(thead);

    let totalD = 0, totalT = 0;
    for (const rt of routes) {
      const dist = this._routeLength(rt.points);
      const time = rt.speed_mps > 0 ? dist / rt.speed_mps : 0;
      totalD += dist; totalT += time;
      const tr = document.createElement('tr');
      const selRow = this._isSel('route', rt.id);
      tr.style.cssText = 'cursor:pointer;' + (selRow ? 'background:var(--bg-hover);font-weight:700;' : '');
      this._on(tr, 'click', () => {
        this.selected = { kind: 'route', id: rt.id };
        this._renderRouteTable(); this._drawCanvas();
      });
      const cells = [
        rt.name || rt.id,
        MOVER_JP[rt.mover] || rt.mover,
        dist.toFixed(1),
        Math.round(time),
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        td.textContent = String(c);
        td.style.cssText = 'padding:4px 6px;border-bottom:1px solid var(--line-hair);'
          + (i >= 2 ? 'text-align:right;font-variant-numeric:tabular-nums;' : '');
        if (i === 0) td.style.cssText += `border-left:3px solid ${MOVER_COLOR[rt.mover] || '#777'};`;
        tr.appendChild(td);
      });
      table.appendChild(tr);
    }
    // total row
    const tot = document.createElement('tr');
    for (const [i, c] of [[0, '合計'], [1, ''], [2, totalD.toFixed(1)], [3, String(Math.round(totalT))]]) {
      const td = document.createElement('td');
      td.textContent = c;
      td.style.cssText = 'padding:6px;border-top:2px solid var(--line-hair);font-weight:700;'
        + (i >= 2 ? 'text-align:right;font-variant-numeric:tabular-nums;' : '');
      tot.appendChild(td);
    }
    table.appendChild(tot);
    s.appendChild(table);
    if (!routes.length) this._note(s, '動線がまだありません。「新規ルート」から作図してください。');

    // selected-route editor
    const rt = this.selected && this.selected.kind === 'route'
      ? routes.find((q) => q.id === this.selected.id) : null;
    if (rt) {
      this._h(s, `選択中: ${rt.name}`);
      this._field(s, '種別', () => {
        const sel = this._select(null, MOVER_OPTS, rt.mover);
        this._on(sel, 'change', () => { rt.mover = sel.value; this._renderRouteTable(); this._drawCanvas(); });
        return sel;
      });
      this._field(s, '速度 (m/s)', () => this._num(rt.speed_mps, (v) => {
        rt.speed_mps = Math.max(0.1, v); this._renderRouteTable();
      }, 0.1));
      this._btn(s, '削除', () => this._deleteSelectedRoute(), 'margin-top:10px;color:var(--bad);');
    }
  }

  // --- 動線 tool canvas interaction ---
  _routeDown(px, py) {
    const mx = snap(this._mx(px)), my = snap(this._my(py));
    const b = this.model.layout.bounds;
    const inside = mx >= 0 && mx <= b.width && my >= 0 && my <= b.depth;

    // when not actively drawing, a click near a finished route selects it
    if (!this.routeDraft || !this.routeDraft.length) {
      const hit = this._routeHit(px, py);
      if (hit) {
        this.selected = { kind: 'route', id: hit.id };
        this._renderRouteTable(); this._drawCanvas();
        return;
      }
    }
    if (!inside && (!this.routeDraft || !this.routeDraft.length)) {
      this.selected = null; this._renderRouteTable(); this._drawCanvas();
      return;
    }
    if (!this.routeDraft) this.routeDraft = [];
    this.routeDraft.push([clamp(mx, 0, b.width), clamp(my, 0, b.depth)]);
    this._renderRouteTable(); this._drawCanvas();
  }

  _routeHit(px, py) {
    for (let i = this.model.routes.length - 1; i >= 0; i--) {
      const rt = this.model.routes[i];
      const pts = rt.points || [];
      for (let j = 0; j < pts.length - 1; j++) {
        if (this._distToSeg(px, py, this._X(pts[j][0]), this._Y(pts[j][1]),
            this._X(pts[j + 1][0]), this._Y(pts[j + 1][1])) <= 7) {
          return rt;
        }
      }
    }
    return null;
  }

  _finishRoute() {
    if (this.routeDraft && this.routeDraft.length >= 2) {
      this._pushUndo();
      const n = this.model.routes.length + 1;
      const rt = {
        id: uid('route'),
        name: `動線${n}`,
        mover: this.routeMover,
        speed_mps: Math.max(0.1, +this.routeSpeed || MOVER_SPEED[this.routeMover] || 1.2),
        points: this.routeDraft.slice(),
      };
      this.model.routes.push(rt);
      this.selected = { kind: 'route', id: rt.id };
    }
    this.routeDraft = null;
    this._renderRouteTable(); this._drawCanvas();
  }

  _deleteSelectedRoute() {
    if (!this.selected || this.selected.kind !== 'route') return;
    this._pushUndo();
    this.model.routes = this.model.routes.filter((q) => q.id !== this.selected.id);
    this.selected = null;
    this._renderRouteTable(); this._drawCanvas();
  }

  _drawRoute(pts, color, draft, name) {
    if (!pts || pts.length === 0) return;
    const ctx = this.ctx;
    ctx.strokeStyle = color; ctx.lineWidth = draft ? 3 : 3.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (draft) ctx.setLineDash([7, 5]);
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(this._X(pts[0][0]), this._Y(pts[0][1]));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(this._X(pts[i][0]), this._Y(pts[i][1]));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    for (const p of pts) { ctx.beginPath(); ctx.arc(this._X(p[0]), this._Y(p[1]), 3.2, 0, 7); ctx.fill(); }
    if (name && pts.length) {
      ctx.fillStyle = color; ctx.font = '12px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(name, this._X(pts[0][0]) + 6, this._Y(pts[0][1]) - 4);
    }
  }

  // ---- canvas geometry (meters <-> pixels, y flipped) ----------------------
  _fitCanvas() {
    if (!this.canvas) return;
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, r.width * dpr);
    this.canvas.height = Math.max(1, r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = r.width, h = r.height, pad = 18;
    const b = this.model.layout.bounds;
    const sc = Math.min((w - 2 * pad) / b.width, (h - 2 * pad) / b.depth) || 1;
    this._view = {
      w, h, sc,
      ox: (w - b.width * sc) / 2,
      oy: (h - b.depth * sc) / 2,
    };
  }
  _X(x) { return this._view.ox + x * this._view.sc; }
  _Y(y) { return this._view.h - this._view.oy - y * this._view.sc; }      // flip y
  _mx(px) { return (px - this._view.ox) / this._view.sc; }                // px -> meters x
  _my(py) { return (this._view.h - this._view.oy - py) / this._view.sc; } // px -> meters y

  // ---- drawing -------------------------------------------------------------
  _drawCanvas() {
    if (!this.ctx) return;
    const ctx = this.ctx, { w, h, sc } = this._view;
    const P = this.pal;
    const b = this.model.layout.bounds;
    ctx.clearRect(0, 0, w, h);
    // dim canvas fill in dark mode (transparent in light → parent --bg-app shows)
    if (P.bg && P.bg !== 'transparent') { ctx.fillStyle = P.bg; ctx.fillRect(0, 0, w, h); }

    // floor
    ctx.strokeStyle = P.shell; ctx.lineWidth = 1.5;
    ctx.strokeRect(this._X(0), this._Y(b.depth), b.width * sc, b.depth * sc);

    // DXF underlay: in the レイアウト tool, draw imported walls as a faint gray
    // trace beneath everything so the user can trace over the building outline.
    if (this.tool === 'layout' && this.showUnderlay) {
      const walls = this.model.layout.walls || [];
      if (walls.length) {
        ctx.save();
        ctx.globalAlpha = 0.28;
        for (const w of walls) this._drawWall(w.points, w.thickness, false, false);
        ctx.restore();
      }
    }

    const dim = this.tool === 'equip' || this.tool === 'building' || this.tool === 'route';   // zones rendered faintly under equipment/walls/routes
    for (const z of this.model.layout.zones) {
      const sel = this.tool === 'layout' && this.selected && this.selected.kind === 'zone' && this.selected.id === z.id;
      const color = z.color || ZONE_DEFAULT_COLOR[z.type] || '#cccccc';
      ctx.fillStyle = hexA(color, dim ? 0.12 : (sel ? 0.42 : 0.3));
      ctx.fillRect(this._X(z.x), this._Y(z.y + z.h), z.w * sc, z.h * sc);
      ctx.strokeStyle = sel ? P.sel : hexA(color, 0.8);
      ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeRect(this._X(z.x), this._Y(z.y + z.h), z.w * sc, z.h * sc);
      // rack preview grid for storage zones
      if (z.type === 'storage' && z.shelves && z.shelves.length) this._drawShelves(z);
      else if (z.type === 'storage' && z.rack) this._drawRack(z);
      // label
      ctx.fillStyle = dim ? P.inkDim : P.ink;
      ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ZONE_JP[z.type] || z.type, this._X(z.x + z.w / 2), this._Y(z.y + z.h / 2));
      // resize handle + live size badge when selected in layout tool
      if (sel) {
        ctx.fillStyle = P.sel;
        ctx.fillRect(this._X(z.x + z.w) - HANDLE, this._Y(z.y) - HANDLE, HANDLE, HANDLE);
        this._sizeBadge(z);
      }
    }

    // conveyors (under markers)
    for (const cv of this.model.resources.conveyors) this._drawConveyor(cv.points, '#33a02c', false);
    if (this.conveyorDraft) this._drawConveyor(this.conveyorDraft, P.draft, true);

    // equipment markers
    for (const e of this.model.resources.equipment) {
      const p = EQUIP_PALETTE.find((x) => x.type === e.type);
      this._marker(e.x, e.y, p ? p.color : '#777', (p ? p.label.split('(')[0] : e.type) + `×${e.count ?? 0}`,
        this._isSel('equip', e.id));
    }
    // pack stations as blue stars
    for (const s of this.model.resources.stations) {
      this._star(this._X(s.x), this._Y(s.y), '#08519c', this._isSel('station', s.id));
      this._label(this._X(s.x), this._Y(s.y) + 16, `梱包台×${s.count ?? 0}`);
    }

    // building tool: walls + doors (drawn above the faint zones)
    if (this.tool === 'building') {
      for (const w of this.model.layout.walls) this._drawWall(w.points, w.thickness, this._isSel('wall', w.id), false);
      if (this.wallDraft) this._drawWall(this.wallDraft, 0.3, false, true);
      for (const d of this.model.layout.doors) this._drawDoor(d, this._isSel('door', d.id));
    }

    // 動線 tool: faint walls for context, then colored route polylines
    if (this.tool === 'route') {
      ctx.save();
      ctx.globalAlpha = 0.35;
      for (const w of this.model.layout.walls) this._drawWall(w.points, w.thickness, false, false);
      ctx.restore();
      for (const rt of this.model.routes) {
        const sel = this._isSel('route', rt.id);
        const color = MOVER_COLOR[rt.mover] || '#777';
        ctx.save();
        if (!sel) ctx.globalAlpha = 0.85;
        this._drawRoute(rt.points, sel ? P.sel : color, false, rt.name);
        ctx.restore();
      }
      if (this.routeDraft) this._drawRoute(this.routeDraft, MOVER_COLOR[this.routeMover] || P.draft, true, null);
    }

    // hint text
    if (this.tool === 'equip') {
      ctx.fillStyle = P.inkFaint; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const hint = this.equipBrush === 'conveyor'
        ? 'コンベア: 床をクリックで頂点追加、ダブルクリックか「確定」で完了'
        : '床をクリックして設置 / マーカーをクリックで選択';
      ctx.fillText(hint, 8, 8);
    } else if (this.tool === 'building') {
      ctx.fillStyle = P.inkFaint; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const hint = this.buildMode === 'door'
        ? 'ドア: 床をクリックして配置 / マーカーをクリックで選択'
        : '壁: 床をクリックで頂点追加、ダブルクリックか「壁を確定」で完了';
      ctx.fillText(hint, 8, 8);
    }
  }

  _drawWall(pts, thickness, sel, draft) {
    if (!pts || pts.length === 0) return;
    const ctx = this.ctx;
    const wpx = Math.max(3, (+thickness || 0.3) * this._view.sc);
    ctx.strokeStyle = sel ? this.pal.sel : (draft ? this.pal.draft : this.pal.wall);
    ctx.lineWidth = wpx; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (draft) ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(this._X(pts[0][0]), this._Y(pts[0][1]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(this._X(pts[i][0]), this._Y(pts[i][1]));
    ctx.stroke();
    ctx.setLineDash([]);
    // vertices
    ctx.fillStyle = sel ? this.pal.sel : (draft ? this.pal.draft : this.pal.wall);
    for (const p of pts) { ctx.beginPath(); ctx.arc(this._X(p[0]), this._Y(p[1]), 3, 0, 7); ctx.fill(); }
  }

  _drawDoor(d, sel) {
    const ctx = this.ctx, px = this._X(d.x), py = this._Y(d.y);
    const pal = DOOR_PALETTE.find((x) => x.type === d.type);
    const color = pal ? pal.color : '#888888';
    const half = Math.max(6, (+d.w || 1) * this._view.sc / 2);
    ctx.fillStyle = hexA(color, 0.55);
    ctx.strokeStyle = sel ? this.pal.sel : color;
    ctx.lineWidth = sel ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.rect(px - half, py - 6, half * 2, 12);
    ctx.fill(); ctx.stroke();
    this._label(px, py + 12, `${DOOR_JP[d.type] || d.type} ${(+d.w || 1)}m`);
  }

  _drawShelves(z) {
    // Draw each authored SHELF area as a rack body (tinted by equipment type)
    // with its cells at the type's pitch — MapMaker SHELF → cells, in the editor.
    const ctx = this.ctx;
    // A lone shelf tracks the zone footprint (so resizing the zone resizes it).
    if (z.shelves.length === 1) Object.assign(z.shelves[0], { x: z.x, y: z.y, w: z.w, h: z.h });
    for (const sh of z.shelves) {
      const rt = RACK_TYPES[sh.rack_type] || RACK_TYPES.medium;
      const bay = +sh.cell_w || rt.bay, depth = +sh.cell_d || rt.depth;
      const vertical = sh.h >= sh.w;
      const px = Math.max(0.3, vertical ? depth : bay);
      const py = Math.max(0.3, vertical ? bay : depth);
      ctx.fillStyle = hexA(rt.color, 0.16);
      ctx.strokeStyle = hexA(rt.color, 0.55); ctx.lineWidth = 1;
      ctx.fillRect(this._X(sh.x), this._Y(sh.y + sh.h), sh.w * this._view.sc, sh.h * this._view.sc);
      ctx.strokeRect(this._X(sh.x), this._Y(sh.y + sh.h), sh.w * this._view.sc, sh.h * this._view.sc);
      ctx.fillStyle = hexA(rt.color, 0.85);
      for (let cx = sh.x + px / 2; cx <= sh.x + sh.w - px / 2 + 1e-6; cx += px) {
        for (let cy = sh.y + py / 2; cy <= sh.y + sh.h - py / 2 + 1e-6; cy += py) {
          ctx.fillRect(this._X(cx) - 1.4, this._Y(cy) - 1.4, 2.8, 2.8);
        }
      }
    }
  }

  _drawRack(z) {
    const ctx = this.ctx, r = z.rack;
    const cs = +r.col_spacing || 4, rs = +r.row_spacing || 3, mg = +r.margin || 0;
    if (z.w - 2 * mg <= 0 || z.h - 2 * mg <= 0) return;
    ctx.fillStyle = this.pal.rack;
    for (let cx = z.x + mg; cx <= z.x + z.w - mg + 1e-6; cx += cs) {
      for (let cy = z.y + mg; cy <= z.y + z.h - mg + 1e-6; cy += rs) {
        ctx.fillRect(this._X(cx) - 1.5, this._Y(cy) - 1.5, 3, 3);
      }
    }
  }

  _drawConveyor(pts, color, draft) {
    if (!pts || pts.length === 0) return;
    const ctx = this.ctx;
    ctx.strokeStyle = color; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (draft) ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(this._X(pts[0][0]), this._Y(pts[0][1]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(this._X(pts[i][0]), this._Y(pts[i][1]));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    for (const p of pts) { ctx.beginPath(); ctx.arc(this._X(p[0]), this._Y(p[1]), 3.5, 0, 7); ctx.fill(); }
  }

  _marker(x, y, color, label, sel) {
    const ctx = this.ctx, px = this._X(x), py = this._Y(y);
    ctx.fillStyle = color; ctx.strokeStyle = sel ? this.pal.sel : this.pal.markerStroke; ctx.lineWidth = sel ? 2.5 : 1.5;
    ctx.beginPath(); ctx.arc(px, py, 9, 0, 7); ctx.fill(); ctx.stroke();
    this._label(px, py + 16, label);
  }
  _star(px, py, color, sel) {
    const ctx = this.ctx;
    ctx.fillStyle = color; ctx.strokeStyle = sel ? this.pal.sel : this.pal.markerStroke; ctx.lineWidth = sel ? 2.5 : 1.2;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 4 : 9;
      const fx = px + Math.cos(a) * r, fy = py + Math.sin(a) * r;
      i ? ctx.lineTo(fx, fy) : ctx.moveTo(fx, fy);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  _label(px, py, text) {
    const ctx = this.ctx;
    ctx.fillStyle = this.pal.ink; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(text, px, py);
  }
  // size badge in metres (e.g. "12.0 × 8.0 m") near a zone's top-left corner
  _sizeBadge(z) {
    const ctx = this.ctx;
    const text = `${(+z.w || 0).toFixed(1)} × ${(+z.h || 0).toFixed(1)} m`;
    const px = this._X(z.x) + 4, py = this._Y(z.y + z.h) + 4;
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const w = ctx.measureText(text).width;
    ctx.fillStyle = this.pal.badgeBg;
    ctx.fillRect(px, py, w + 8, 16);
    ctx.fillStyle = this.pal.selInk;
    ctx.fillText(text, px + 4, py + 2);
  }
  _isSel(kind, id) { return this.selected && this.selected.kind === kind && this.selected.id === id; }

  // ---- canvas event handling ----------------------------------------------
  // Window-level drag listeners are bound ONCE in the constructor (they read the
  // current `this.canvas` / `this.drag`), so re-rendering a tool — which creates a
  // fresh canvas — does not leak a new pair of window listeners each time. Only the
  // per-canvas listeners (which die with the canvas element) are (re)bound here.
  _bindWindow() {
    this._on(window, 'mousemove', (e) => this._onMove(e));
    this._on(window, 'mouseup', () => this._onUp());
  }
  _bindCanvas() {
    this._on(this.canvas, 'mousedown', (e) => this._onDown(e));
    this._on(this.canvas, 'dblclick', (e) => this._onDbl(e));
    this._on(this.canvas, 'touchstart', (e) => this._onTouch(e), { passive: false });
  }
  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  }

  _onDown(e) {
    const { px, py } = this._pt(e);
    if (this.tool === 'layout') return this._layoutDown(px, py);
    if (this.tool === 'equip') return this._equipDown(px, py);
    if (this.tool === 'building') return this._buildingDown(px, py);
    if (this.tool === 'route') return this._routeDown(px, py);
    if (this.tool === 'flow') return this._flowDown(px, py);
  }

  // --- layout tool: place (palette) / select / move / resize zones ---
  _layoutDown(px, py) {
    const zs = this.model.layout.zones;
    // palette brush active: click the floor to place a new object there
    if (this.layoutBrush) {
      const mx = snap(this._mx(px)), my = snap(this._my(py));
      const b = this.model.layout.bounds;
      if (mx >= 0 && mx <= b.width && my >= 0 && my <= b.depth) {
        this._placeFromPalette(this.layoutBrush, mx, my);
      }
      return;
    }
    // resize handle of the currently selected zone?
    if (this.selected && this.selected.kind === 'zone') {
      const z = zs.find((q) => q.id === this.selected.id);
      if (z) {
        const hx = this._X(z.x + z.w), hy = this._Y(z.y);
        if (px >= hx - HANDLE && px <= hx && py >= hy - HANDLE && py <= hy) {
          this.drag = { mode: 'resize', id: z.id };
          return;
        }
      }
    }
    // hit-test zones top-most first
    for (let i = zs.length - 1; i >= 0; i--) {
      const z = zs[i];
      const mx = this._mx(px), my = this._my(py);
      if (mx >= z.x && mx <= z.x + z.w && my >= z.y && my <= z.y + z.h) {
        this.selected = { kind: 'zone', id: z.id };
        this.drag = { mode: 'move', id: z.id, dx: mx - z.x, dy: my - z.y };
        this._renderSide(); this._drawCanvas();
        return;
      }
    }
    this.selected = null; this._renderSide(); this._drawCanvas();
  }

  // --- equipment tool: place / select ---
  _equipDown(px, py) {
    const mx = snap(this._mx(px)), my = snap(this._my(py));
    const b = this.model.layout.bounds;
    const inside = mx >= 0 && mx <= b.width && my >= 0 && my <= b.depth;

    // first: hit-test existing equipment & stations for selection/move
    const hitEq = this.model.resources.equipment.find((q) => Math.hypot(this._X(q.x) - px, this._Y(q.y) - py) <= 11);
    const hitSt = this.model.resources.stations.find((q) => Math.hypot(this._X(q.x) - px, this._Y(q.y) - py) <= 11);
    if (this.equipBrush !== 'conveyor' && (hitEq || hitSt)) {
      const o = hitEq || hitSt;
      this.selected = { kind: hitEq ? 'equip' : 'station', id: o.id };
      this.drag = { mode: 'moveObj', kind: this.selected.kind, id: o.id };
      this._renderSide(); this._drawCanvas();
      return;
    }
    if (!inside) { this.selected = null; this._renderSide(); this._drawCanvas(); return; }

    if (this.equipBrush === 'conveyor') {
      if (!this.conveyorDraft) this.conveyorDraft = [];
      this.conveyorDraft.push([mx, my]);
      this._drawCanvas(); this._renderSide();
    } else if (this.equipBrush === 'station') {
      this._pushUndo();
      const s = { id: uid('st'), zone: 'packing', x: mx, y: my, count: 1 };
      this.model.resources.stations.push(s);
      this.selected = { kind: 'station', id: s.id };
      this._renderSide(); this._drawCanvas();
    } else { // agv / asrs / robot_arm / crane
      this._pushUndo();
      const fast = this.equipBrush === 'agv';
      const e = {
        id: uid('eq'), type: this.equipBrush,
        count: fast ? 5 : 1,
        speed_mps: fast ? 1.6 : 1.0,
        x: mx, y: my,
      };
      this.model.resources.equipment.push(e);
      this.selected = { kind: 'equip', id: e.id };
      this._renderSide(); this._drawCanvas();
    }
  }

  _onMove(e) {
    if (!this.drag || !this.canvas) return;
    const { px, py } = this._pt(e);
    const b = this.model.layout.bounds;
    // Snapshot once, on the first actual movement of a drag, so a plain
    // select-click (down→up, no move) does not create a no-op undo entry.
    if (!this.drag._snapped) { this.drag._snapped = true; this._pushUndo(); }
    if (this.drag.mode === 'move' || this.drag.mode === 'resize') {
      const z = this.model.layout.zones.find((q) => q.id === this.drag.id);
      if (!z) return;
      if (this.drag.mode === 'move') {
        z.x = clamp(snap(this._mx(px) - this.drag.dx), 0, b.width - z.w);
        z.y = clamp(snap(this._my(py) - this.drag.dy), 0, b.depth - z.h);
      } else {
        z.w = clamp(snap(this._mx(px) - z.x), MIN_M, b.width - z.x);
        z.h = clamp(snap(this._my(py) - z.y), MIN_M, b.depth - z.y);
      }
    } else if (this.drag.mode === 'moveObj') {
      const arr = this.drag.kind === 'equip' ? this.model.resources.equipment : this.model.resources.stations;
      const o = arr.find((q) => q.id === this.drag.id);
      if (!o) return;
      o.x = clamp(snap(this._mx(px)), 0, b.width);
      o.y = clamp(snap(this._my(py)), 0, b.depth);
    } else if (this.drag.mode === 'moveDoor') {
      const o = this.model.layout.doors.find((q) => q.id === this.drag.id);
      if (!o) return;
      o.x = clamp(snap(this._mx(px)), 0, b.width);
      o.y = clamp(snap(this._my(py)), 0, b.depth);
    }
    this._drawCanvas();
  }

  _onUp() {
    if (this.drag) { this.drag = null; this._renderSide(); }
  }

  _onDbl(e) {
    if (this.tool === 'equip' && this.equipBrush === 'conveyor') this._finishConveyor();
    if (this.tool === 'building' && this.buildMode === 'wall') this._finishWall();
    if (this.tool === 'route') this._finishRoute();
  }

  // Basic touch support: map a single-finger tap to a canvas "down" so the same
  // place/select logic runs on tablets. Multi-touch (pinch/zoom) is left to the
  // browser. Continuous touch-drag is intentionally not wired (編集はPC推奨).
  _onTouch(e) {
    if (!e.touches || e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    const r = this.canvas.getBoundingClientRect();
    const px = t.clientX - r.left, py = t.clientY - r.top;
    if (this.tool === 'layout') this._layoutDown(px, py);
    else if (this.tool === 'equip') this._equipDown(px, py);
    else if (this.tool === 'building') this._buildingDown(px, py);
    else if (this.tool === 'route') this._routeDown(px, py);
    else if (this.tool === 'flow') this._flowDown(px, py);
    this.drag = null;  // no touch-drag; a tap should not start a move
  }

  // ---- undo/redo (lightweight model snapshots) -----------------------------
  // We snapshot the four editable sections just before a mutating action. The
  // stack is bounded; redo is cleared on a fresh edit. Drafts (in-progress
  // polylines) are deliberately not part of history.
  _snapshot() {
    return {
      layout: clone(this.model.layout),
      resources: clone(this.model.resources),
      process: clone(this.model.process),
      routes: clone(this.model.routes),
    };
  }
  _pushUndo() {
    if (!this._undoStack) this._undoStack = [];
    this._undoStack.push(this._snapshot());
    if (this._undoStack.length > 50) this._undoStack.shift();
    this._redoStack = [];
    this._refreshUndoBtns();
  }
  _applySnapshot(snap) {
    this.model.layout = clone(snap.layout);
    this.model.resources = clone(snap.resources);
    this.model.process = clone(snap.process);
    this.model.routes = clone(snap.routes);
    this.selected = null;
    this.drag = null;
    this.conveyorDraft = this.wallDraft = this.routeDraft = null;
    this._renderTool();
    this._refreshUndoBtns();
  }
  _undo() {
    if (!this._undoStack || !this._undoStack.length) return;
    this._redoStack = this._redoStack || [];
    this._redoStack.push(this._snapshot());
    this._applySnapshot(this._undoStack.pop());
  }
  _redo() {
    if (!this._redoStack || !this._redoStack.length) return;
    this._undoStack = this._undoStack || [];
    this._undoStack.push(this._snapshot());
    this._applySnapshot(this._redoStack.pop());
  }
  _refreshUndoBtns() {
    if (this._undoBtn) this._undoBtn.disabled = !(this._undoStack && this._undoStack.length);
    if (this._redoBtn) this._redoBtn.disabled = !(this._redoStack && this._redoStack.length);
  }

  // ---- keyboard: Delete removes selection, Esc cancels, Ctrl/⌘+Z undo ------
  _bindKeys() {
    this._on(window, 'keydown', (e) => this._onKey(e));
  }
  _onKey(e) {
    // Only act when the Designer is the visible surface and focus isn't in a field.
    if (!this.container || !this.container.isConnected || this.container.offsetParent === null) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const meta = e.ctrlKey || e.metaKey;
    if (meta && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) { e.preventDefault(); this._undo(); return; }
    if (meta && ((e.key === 'z' || e.key === 'Z') && e.shiftKey || e.key === 'y' || e.key === 'Y')) {
      e.preventDefault(); this._redo(); return;
    }
    if (e.key === 'Escape') {
      if (this.conveyorDraft || this.wallDraft || this.routeDraft) {
        this.conveyorDraft = this.wallDraft = this.routeDraft = null;
        this._renderTool();
      } else if (this.selected) {
        this.selected = null; this._renderTool();
      }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      e.preventDefault();
      this._deleteSelected();
    }
  }

  // Delete whatever is selected, regardless of tool (used by the Delete key).
  _deleteSelected() {
    const sel = this.selected;
    if (!sel) return;
    this._pushUndo();
    const L = this.model.layout, R = this.model.resources;
    if (sel.kind === 'zone') L.zones = L.zones.filter((q) => q.id !== sel.id);
    else if (sel.kind === 'equip') R.equipment = R.equipment.filter((q) => q.id !== sel.id);
    else if (sel.kind === 'station') R.stations = R.stations.filter((q) => q.id !== sel.id);
    else if (sel.kind === 'wall') L.walls = L.walls.filter((q) => q.id !== sel.id);
    else if (sel.kind === 'door') L.doors = L.doors.filter((q) => q.id !== sel.id);
    else if (sel.kind === 'route') this.model.routes = this.model.routes.filter((q) => q.id !== sel.id);
    this.selected = null;
    this._renderTool();
  }

  _finishConveyor() {
    if (this.conveyorDraft && this.conveyorDraft.length >= 2) {
      this._pushUndo();
      const cv = { id: uid('cv'), points: this.conveyorDraft.slice(), speed_mps: 0.5 };
      this.model.resources.conveyors.push(cv);
    }
    this.conveyorDraft = null;
    this._renderSide(); this._drawCanvas();
  }

  // --- building tool: walls (polyline) + doors (markers) ---
  _buildingDown(px, py) {
    const mx = snap(this._mx(px)), my = snap(this._my(py));
    const b = this.model.layout.bounds;
    const inside = mx >= 0 && mx <= b.width && my >= 0 && my <= b.depth;

    if (this.buildMode === 'door') {
      // hit-test existing doors first for selection / move
      const hit = this.model.layout.doors.find((q) => Math.hypot(this._X(q.x) - px, this._Y(q.y) - py) <= 12);
      if (hit) {
        this.selected = { kind: 'door', id: hit.id };
        this.drag = { mode: 'moveDoor', id: hit.id };
        this._renderSide(); this._drawCanvas();
        return;
      }
      if (!inside) { this.selected = null; this._renderSide(); this._drawCanvas(); return; }
      this._pushUndo();
      const pal = DOOR_PALETTE.find((x) => x.type === this.doorBrush) || DOOR_PALETTE[0];
      const w = pal.type === 'dock' ? 3 : pal.type === 'shutter' ? 4 : 1;
      const d = { id: uid('door'), type: pal.type, x: mx, y: my, w };
      this.model.layout.doors.push(d);
      this.selected = { kind: 'door', id: d.id };
      this._renderSide(); this._drawCanvas();
      return;
    }

    // wall mode: hit-test walls for selection, else extend draft polyline
    if (!this.wallDraft) {
      const hit = this._wallHit(px, py);
      if (hit) {
        this.selected = { kind: 'wall', id: hit.id };
        this._renderSide(); this._drawCanvas();
        return;
      }
    }
    if (!inside && !this.wallDraft) { this.selected = null; this._renderSide(); this._drawCanvas(); return; }
    if (!this.wallDraft) this.wallDraft = [];
    this.wallDraft.push([mx, my]);
    this._renderSide(); this._drawCanvas();
  }

  _wallHit(px, py) {
    for (let i = this.model.layout.walls.length - 1; i >= 0; i--) {
      const w = this.model.layout.walls[i];
      const pts = w.points || [];
      for (let j = 0; j < pts.length - 1; j++) {
        if (this._distToSeg(px, py, this._X(pts[j][0]), this._Y(pts[j][1]),
            this._X(pts[j + 1][0]), this._Y(pts[j + 1][1])) <= Math.max(6, (w.thickness || 0.3) * this._view.sc / 2 + 4)) {
          return w;
        }
      }
    }
    return null;
  }

  _distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  _finishWall() {
    if (this.wallDraft && this.wallDraft.length >= 2) {
      this._pushUndo();
      const w = { id: uid('wall'), points: this.wallDraft.slice(), thickness: 0.3 };
      this.model.layout.walls.push(w);
      this.selected = { kind: 'wall', id: w.id };
    }
    this.wallDraft = null;
    this._renderSide(); this._drawCanvas();
  }

  // ---- side editor panels (layout + equip tools) ---------------------------
  _renderSide() {
    if (!this.side) return;
    const s = this.side; s.innerHTML = '';
    if (this.tool === 'layout') this._sideLayout(s);
    else if (this.tool === 'building') this._sideBuilding(s);
    else this._sideEquip(s);
  }

  _sideBuilding(s) {
    this._h(s, '躯体（建屋）');
    // mode switch: walls vs doors
    const modeRow = this._div(s, 'display:flex;gap:6px;margin-bottom:8px;');
    for (const [m, label] of [['wall', '壁'], ['door', 'ドア']]) {
      const b = this._btn(modeRow, label, () => {
        this.buildMode = m;
        if (m !== 'wall') this.wallDraft = null;
        this.selected = null;
        this._renderSide(); this._drawCanvas();
      });
      b.style.flex = '1';
      if (this.buildMode === m) b.style.cssText += ';background:var(--ink-primary);color:var(--bg-app);border-color:var(--ink-primary);';
    }

    if (this.buildMode === 'wall') {
      this._btn(s, '壁を確定', () => this._finishWall(), 'margin-bottom:8px;');
      this._note(s, `頂点 ${this.wallDraft ? this.wallDraft.length : 0} 点。床をクリックで追加、ダブルクリックか「壁を確定」で完了。`);
      const w = this.selected && this.selected.kind === 'wall'
        ? this.model.layout.walls.find((q) => q.id === this.selected.id) : null;
      if (w) {
        this._h(s, '選択中の壁');
        this._field(s, '厚さ (m)', () => this._num(w.thickness, (v) => { w.thickness = Math.max(0.05, v); this._drawCanvas(); }));
        this._note(s, `頂点 ${(w.points || []).length} 点。`);
        this._btn(s, '削除', () => {
          this._pushUndo();
          this.model.layout.walls = this.model.layout.walls.filter((q) => q.id !== w.id);
          this.selected = null; this._renderSide(); this._drawCanvas();
        }, 'margin-top:10px;color:var(--bad);');
      } else {
        this._note(s, '壁をクリックして選択すると編集・削除できます。');
      }
    } else {
      this._h(s, 'ドアの種類');
      const pal = this._div(s, 'display:flex;flex-direction:column;gap:4px;margin-bottom:8px;');
      for (const p of DOOR_PALETTE) {
        const b = this._btn(pal, p.label, () => { this.doorBrush = p.type; this._renderSide(); this._drawCanvas(); });
        if (this.doorBrush === p.type) b.style.cssText += ';background:var(--ink-primary);color:var(--bg-app);border-color:var(--ink-primary);';
      }
      const d = this.selected && this.selected.kind === 'door'
        ? this.model.layout.doors.find((q) => q.id === this.selected.id) : null;
      if (d) {
        this._h(s, `選択中: ${DOOR_JP[d.type] || d.type}`);
        this._field(s, '種別', () => {
          const sel = this._select(null, DOOR_PALETTE.map((p) => ({ value: p.type, label: p.label })), d.type);
          this._on(sel, 'change', () => { d.type = sel.value; this._renderSide(); this._drawCanvas(); });
          return sel;
        });
        this._field(s, '幅 (m)', () => this._num(d.w, (v) => { d.w = Math.max(0.3, v); this._drawCanvas(); }));
        this._btn(s, '削除', () => {
          this._pushUndo();
          this.model.layout.doors = this.model.layout.doors.filter((q) => q.id !== d.id);
          this.selected = null; this._renderSide(); this._drawCanvas();
        }, 'margin-top:10px;color:var(--bad);');
      } else {
        this._note(s, '建屋の縁をクリックしてドアを配置、または既存のドアをクリックして編集します。');
      }
    }
  }

  _sideLayout(s) {
    const head = this._h(s, 'ゾーン');
    // add-zone control
    const addRow = this._div(s, 'display:flex;gap:6px;margin-bottom:8px;');
    const typeSel = this._select(addRow, ZONE_TYPES.map((t) => ({ value: t, label: ZONE_JP[t] })), 'storage');
    const addBtn = this._btn(addRow, 'ゾーン追加', () => this._addZone(typeSel.value));
    addBtn.style.flex = '0 0 auto';

    // Warehouse size (倉庫サイズ) — set the floor extents up front, MapMaker-style.
    this._h(s, '倉庫サイズ');
    const bnd = this.model.layout.bounds;
    this._field(s, '幅 W (m)', () => this._num(bnd.width, (v) => {
      bnd.width = Math.max(MIN_M, v); this._fitCanvas(); this._drawCanvas(); }));
    this._field(s, '奥行 D (m)', () => this._num(bnd.depth, (v) => {
      bnd.depth = Math.max(MIN_M, v); this._fitCanvas(); this._drawCanvas(); }));
    // Default storage equipment applied to new 棚ブロック.
    this._field(s, '棚種別(新規)', () => {
      const sel = this._select(null, RACK_ORDER.map((k) => ({ value: k, label: RACK_TYPES[k].label })), this.shelfType);
      this._on(sel, 'change', () => { this.shelfType = sel.value; });
      return sel;
    });

    const z = this.selected && this.selected.kind === 'zone'
      ? this.model.layout.zones.find((q) => q.id === this.selected.id) : null;
    if (!z) { this._note(s, 'ゾーンをクリックして選択すると編集できます。'); return; }

    this._h(s, '選択中のゾーン');
    // type
    this._field(s, '種別', () => {
      const sel = this._select(null, ZONE_TYPES.map((t) => ({ value: t, label: ZONE_JP[t] })), z.type);
      this._on(sel, 'change', () => {
        z.type = sel.value;
        if (z.type === 'storage') {
          if ((!z.shelves || !z.shelves.length) && !z.rack)
            z.shelves = [{ id: uid('s'), x: z.x, y: z.y, w: z.w, h: z.h, rack_type: this.shelfType }];
        } else { z.rack = null; z.shelves = []; }
        this._renderSide(); this._drawCanvas();
      });
      return sel;
    });
    // position / size (numeric, parametric)
    for (const [label, key, max] of [['X (m)', 'x', this.model.layout.bounds.width],
                                     ['Y (m)', 'y', this.model.layout.bounds.depth],
                                     ['幅 (m)', 'w', this.model.layout.bounds.width],
                                     ['奥行 (m)', 'h', this.model.layout.bounds.depth]]) {
      this._field(s, label, () => this._num(z[key], (v) => {
        z[key] = clamp(v, key === 'w' || key === 'h' ? MIN_M : 0, max);
        if (z.x + z.w > this.model.layout.bounds.width) z.x = Math.max(0, this.model.layout.bounds.width - z.w);
        if (z.y + z.h > this.model.layout.bounds.depth) z.y = Math.max(0, this.model.layout.bounds.depth - z.h);
        this._drawCanvas();
      }));
    }
    // storage equipment (棚種別) — drives the cell footprint & capacity
    if (z.type === 'storage') {
      if ((!z.shelves || !z.shelves.length) && !z.rack)
        z.shelves = [{ id: uid('s'), x: z.x, y: z.y, w: z.w, h: z.h, rack_type: this.shelfType }];
      if (z.shelves && z.shelves.length) {
        const cur = z.shelves[0].rack_type || 'medium';
        this._h(s, '保管設備（棚種別）');
        this._field(s, '種別', () => {
          const sel = this._select(null, RACK_ORDER.map((k) => ({ value: k, label: RACK_TYPES[k].label })), cur);
          this._on(sel, 'change', () => {
            z.shelves.forEach((sh) => { sh.rack_type = sel.value; });
            this._renderSide(); this._drawCanvas();
          });
          return sel;
        });
        const rt = RACK_TYPES[cur] || RACK_TYPES.medium;
        this._note(s, `セル ${rt.bay}×${rt.depth} m・${z.shelves.length}ブロック。棚を描いた結果ロケーションが生成されます。`);
      } else if (z.rack) {
        this._h(s, 'ラック（保管棚・従来）');
        for (const [label, key] of [['列間隔 (m)', 'col_spacing'], ['段間隔 (m)', 'row_spacing'], ['余白 (m)', 'margin']]) {
          this._field(s, label, () => this._num(z.rack[key], (v) => { z.rack[key] = Math.max(0.1, v); this._drawCanvas(); }));
        }
      }
    }
    this._btn(s, '削除', () => this._deleteZone(z.id), 'margin-top:10px;color:var(--bad);');
  }

  _sideEquip(s) {
    this._h(s, '設備パレット');
    const pal = this._div(s, 'display:flex;flex-direction:column;gap:4px;margin-bottom:8px;');
    for (const p of EQUIP_PALETTE) {
      const b = this._btn(pal, p.label, () => { this.equipBrush = p.key; this.conveyorDraft = null; this._renderSide(); this._drawCanvas(); });
      if (this.equipBrush === p.key) b.style.cssText += ';background:var(--ink-primary);color:var(--bg-app);border-color:var(--ink-primary);';
    }
    if (this.equipBrush === 'conveyor') {
      this._btn(s, '確定（コンベア完了）', () => this._finishConveyor(), 'margin-bottom:8px;');
      this._note(s, `頂点 ${this.conveyorDraft ? this.conveyorDraft.length : 0} 点。床をクリックで追加。`);
    }

    // selected object editor
    const sel = this.selected;
    if (sel && sel.kind === 'equip') {
      const e = this.model.resources.equipment.find((q) => q.id === sel.id);
      if (e) {
        const p = EQUIP_PALETTE.find((x) => x.type === e.type);
        this._h(s, `選択中: ${p ? p.label : e.type}`);
        this._field(s, '台数', () => this._num(e.count, (v) => { e.count = Math.max(0, Math.round(v)); this._drawCanvas(); }, 1));
        this._field(s, '速度 (m/s)', () => this._num(e.speed_mps, (v) => { e.speed_mps = Math.max(0, v); }));
        this._btn(s, '削除', () => { this._pushUndo(); this.model.resources.equipment = this.model.resources.equipment.filter((q) => q.id !== e.id); this.selected = null; this._renderSide(); this._drawCanvas(); }, 'margin-top:10px;color:var(--bad);');
      }
    } else if (sel && sel.kind === 'station') {
      const st = this.model.resources.stations.find((q) => q.id === sel.id);
      if (st) {
        this._h(s, '選択中: 梱包台');
        this._field(s, '台数', () => this._num(st.count, (v) => { st.count = Math.max(0, Math.round(v)); this._drawCanvas(); }, 1));
        this._btn(s, '削除', () => { this._pushUndo(); this.model.resources.stations = this.model.resources.stations.filter((q) => q.id !== st.id); this.selected = null; this._renderSide(); this._drawCanvas(); }, 'margin-top:10px;color:var(--bad);');
      }
    } else {
      this._note(s, '床をクリックして設置、または既存マーカーをクリックして編集します。');
    }

    if (this.model.resources.conveyors.length) {
      this._h(s, `コンベア (${this.model.resources.conveyors.length})`);
      const last = this.model.resources.conveyors[this.model.resources.conveyors.length - 1];
      this._btn(s, '最後のコンベアを削除', () => { this._pushUndo(); this.model.resources.conveyors.pop(); this._drawCanvas(); this._renderSide(); });
    }
  }

  // place an object from the レイアウト palette, centered on (mx,my), clamped to floor
  _placeFromPalette(key, mx, my) {
    const p = LAYOUT_PALETTE.find((q) => q.key === key);
    if (!p) return;
    this._pushUndo();
    const b = this.model.layout.bounds;
    const w = Math.min(p.w, b.width), h = Math.min(p.h, b.depth);
    const x = clamp(snap(mx - w / 2), 0, Math.max(0, b.width - w));
    const y = clamp(snap(my - h / 2), 0, Math.max(0, b.depth - h));
    const z = {
      id: uid('zone'), type: p.zoneType, x, y, w, h,
      color: ZONE_DEFAULT_COLOR[p.zoneType] || null,
      rack: null,
    };
    // Storage zones author a SHELF area (MapMaker-style) of the chosen equipment
    // type filling the block; cells materialise inside it on save.
    if (p.zoneType === 'storage') {
      z.shelves = [{ id: uid('s'), x, y, w, h, rack_type: this.shelfType }];
    }
    this.model.layout.zones.push(z);
    this.selected = { kind: 'zone', id: z.id };
    // keep the brush active so the user can drop several of the same object (PPT-like)
    this._renderSide(); this._drawCanvas();
    if (this._layoutStatus) this._layoutStatus.textContent = `「${p.label}」を配置しました。続けて配置するか、選択を解除して編集できます。`;
  }

  _addZone(type) {
    this._pushUndo();
    const b = this.model.layout.bounds;
    const w = Math.min(12, b.width / 2), h = Math.min(8, b.depth / 2);
    const z = {
      id: uid('zone'), type, x: clamp(2, 0, b.width - w), y: clamp(2, 0, b.depth - h),
      w, h, color: ZONE_DEFAULT_COLOR[type] || null,
      rack: type === 'storage' ? { col_spacing: 4, row_spacing: 3, margin: 2 } : null,
    };
    this.model.layout.zones.push(z);
    this.selected = { kind: 'zone', id: z.id };
    this._renderSide(); this._drawCanvas();
  }

  _deleteZone(id) {
    this._pushUndo();
    this.model.layout.zones = this.model.layout.zones.filter((z) => z.id !== id);
    this.selected = null;
    this._renderSide(); this._drawCanvas();
  }

  // ---- flow tool: spatial flow on the floor plan + workflow strip ----------
  // The flow is bound to zone ids (process.stages[].zone) and ordered by
  // process.flow (stage ids). The floor canvas and the DOM strip are two views
  // of the same process.stages, so an edit in either reflects in the other.
  _renderFlow() {
    // left column: a control bar above the floor canvas
    const left = document.createElement('div');
    left.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;';

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;border:1px solid var(--line-hair);border-radius:8px;background:var(--bg-sunken);';
    // toggle: spatial flow-building mode (click zones in sequence)
    const flowBtn = this._btn(bar, this.flowMode ? '配置を終了' : '床図でフロー配置', () => {
      this.flowMode = !this.flowMode;
      if (this.flowMode) { this.flowCursor = 0; this.flowMethodStage = null; }
      this._renderFlow();
    });
    if (this.flowMode) flowBtn.style.cssText += ';background:var(--ink-primary);color:var(--bg-app);border-color:var(--ink-primary);font-weight:700;';
    // reset all zone bindings (back to "always runnable" unbound state)
    this._btn(bar, 'ゾーン割当をリセット', () => {
      this.model.process.stages.forEach((st) => { st.zone = null; });
      this.flowCursor = 0;
      this._renderFlow();
    });
    this._flowStatus = document.createElement('span');
    this._flowStatus.style.cssText = 'font-size:12px;color:var(--ink-secondary);flex-basis:100%;';
    bar.appendChild(this._flowStatus);
    left.appendChild(bar);

    // floor canvas (clickable zones)
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;min-height:0;position:relative;border:1px solid var(--line-hair);border-radius:8px;background:var(--bg-app);overflow:hidden;';
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = `width:100%;height:100%;display:block;cursor:${this.flowMode ? 'pointer' : 'default'};`;
    wrap.appendChild(this.canvas);
    this._flowCanvasHost = wrap;
    left.appendChild(wrap);
    this.body.appendChild(left);

    // right column: the workflow strip + pick strategy + (in-context) method panel
    this.side = document.createElement('div');
    this.side.style.cssText = 'width:340px;flex:0 0 340px;overflow-y:auto;border:1px solid var(--line-hair);border-radius:8px;background:var(--bg-sunken);padding:10px;';
    this.body.appendChild(this.side);

    this.ctx = this.canvas.getContext('2d');
    this._bindCanvas();
    this._fitCanvas();
    this._renderFlowSide();
    this._drawFlowCanvas();
  }

  // center of a zone in meters
  _zoneCenter(z) { return [z.x + z.w / 2, z.y + z.h / 2]; }

  _zoneById(id) { return (this.model.layout.zones || []).find((z) => z.id === id); }

  // the ordered list of stages (process.flow drives order; fall back to stage order)
  _orderedStages() {
    const stages = this.model.process.stages || [];
    const byId = {}; stages.forEach((s) => { byId[s.id] = s; });
    const flow = Array.isArray(this.model.process.flow) ? this.model.process.flow : [];
    const seen = new Set();
    const out = [];
    for (const id of flow) { if (byId[id] && !seen.has(id)) { out.push(byId[id]); seen.add(id); } }
    for (const s of stages) { if (!seen.has(s.id)) out.push(s); }
    return out;
  }

  _flowStatusText() {
    if (!this.flowMode) {
      return 'ゾーンをクリックすると、その工程の作業方法を設定できます。「床図でフロー配置」で工程→ゾーンの割当を引けます。';
    }
    const order = this._orderedStages();
    const st = order[this.flowCursor];
    if (!st) return 'すべての工程にゾーンを割り当てました。「配置を終了」で完了します。';
    return `「${st.label || st.id}」の場所をクリックしてください（${this.flowCursor + 1}/${order.length}）。`;
  }

  // ---- flow floor canvas: zones + directed arrows along the flow -----------
  _drawFlowCanvas() {
    if (!this.ctx) return;
    const ctx = this.ctx, { w, h, sc } = this._view;
    const P = this.pal;
    const b = this.model.layout.bounds;
    ctx.clearRect(0, 0, w, h);
    if (P.bg && P.bg !== 'transparent') { ctx.fillStyle = P.bg; ctx.fillRect(0, 0, w, h); }
    // floor outline
    ctx.strokeStyle = P.shell; ctx.lineWidth = 1.5;
    ctx.strokeRect(this._X(0), this._Y(b.depth), b.width * sc, b.depth * sc);

    const order = this._orderedStages();
    const cursorStage = this.flowMode ? order[this.flowCursor] : null;

    // zones (clickable). Highlight the one bound to the open/cursor stage.
    for (const z of this.model.layout.zones) {
      const color = z.color || ZONE_DEFAULT_COLOR[z.type] || '#cccccc';
      const isCursorTarget = this.flowMode && cursorStage != null;
      const boundStage = order.find((st) => st.zone === z.id);
      const isOpen = this.flowMethodStage && boundStage && boundStage.id === this.flowMethodStage;
      ctx.fillStyle = hexA(color, isOpen ? 0.5 : (boundStage ? 0.34 : 0.18));
      ctx.fillRect(this._X(z.x), this._Y(z.y + z.h), z.w * sc, z.h * sc);
      ctx.strokeStyle = isOpen ? P.sel : (isCursorTarget ? P.accent : hexA(color, 0.8));
      ctx.lineWidth = (isOpen || isCursorTarget) ? 2.5 : 1;
      if (isCursorTarget) ctx.setLineDash([6, 4]);
      ctx.strokeRect(this._X(z.x), this._Y(z.y + z.h), z.w * sc, z.h * sc);
      ctx.setLineDash([]);
      // label: zone type + bound stage name(s)
      ctx.fillStyle = P.ink; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const cx = this._X(z.x + z.w / 2), cy = this._Y(z.y + z.h / 2);
      ctx.fillText(ZONE_JP[z.type] || z.type, cx, cy - 7);
      const bound = order.filter((st) => st.zone === z.id).map((st) => st.label || st.id);
      if (bound.length) {
        ctx.fillStyle = P.sel; ctx.font = 'bold 11px sans-serif';
        ctx.fillText(bound.join('・'), cx, cy + 9);
      }
    }

    // directed arrows along the flow, between consecutive bound zones.
    for (let i = 0; i < order.length - 1; i++) {
      const za = this._zoneById(order[i].zone), zb = this._zoneById(order[i + 1].zone);
      if (!za || !zb || za.id === zb.id) continue;
      const [ax, ay] = this._zoneCenter(za), [bx, by] = this._zoneCenter(zb);
      this._drawArrow(this._X(ax), this._Y(ay), this._X(bx), this._Y(by), P.accent);
    }

    // numbered step badges on each bound stage's zone, in flow order
    let step = 0;
    for (const st of order) {
      if (!st.zone) continue;
      const z = this._zoneById(st.zone);
      if (!z) continue;
      step += 1;
      const [zx, zy] = this._zoneCenter(z);
      const px = this._X(zx), py = this._Y(zy);
      ctx.fillStyle = P.accent; ctx.strokeStyle = P.markerStroke; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px - 1, py - 24, 10, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(step), px - 1, py - 24);
    }

    if (this._flowStatus) this._flowStatus.textContent = this._flowStatusText();
    if (!this.model.layout.zones.length) {
      ctx.fillStyle = P.inkFaint; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('レイアウトにゾーンがありません。「レイアウト」タブで配置してください。', w / 2, h / 2);
    }
  }

  _drawArrow(ax, ay, bx, by, color) {
    const ctx = this.ctx;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    const ang = Math.atan2(by - ay, bx - ax);
    const hl = 11, mx = ax + (bx - ax) * 0.6, my = ay + (by - ay) * 0.6;  // arrowhead at 60%
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(mx - hl * Math.cos(ang - 0.4), my - hl * Math.sin(ang - 0.4));
    ctx.lineTo(mx - hl * Math.cos(ang + 0.4), my - hl * Math.sin(ang + 0.4));
    ctx.closePath(); ctx.fill();
  }

  // --- flow canvas click: place flow (assign zone) OR open the method popover ---
  _flowDown(px, py) {
    const mx = this._mx(px), my = this._my(py);
    const zs = this.model.layout.zones;
    let hit = null;
    for (let i = zs.length - 1; i >= 0; i--) {
      const z = zs[i];
      if (mx >= z.x && mx <= z.x + z.w && my >= z.y && my <= z.y + z.h) { hit = z; break; }
    }
    if (!hit) {
      if (!this.flowMode) { this.flowMethodStage = null; this._renderFlowSide(); this._drawFlowCanvas(); }
      return;
    }
    if (this.flowMode) {
      // bind the current cursor stage to the clicked zone, advance the cursor
      const order = this._orderedStages();
      const st = order[this.flowCursor];
      if (st) {
        st.zone = hit.id;
        this.flowCursor = Math.min(this.flowCursor + 1, order.length);
      }
      this._renderFlowSide(); this._drawFlowCanvas();
    } else {
      // open the in-context method popover for the (first) stage bound to this zone
      const order = this._orderedStages();
      const st = order.find((s) => s.zone === hit.id);
      this.flowMethodStage = st ? st.id : null;
      this._renderFlowSide(); this._drawFlowCanvas();
      if (!st && this._flowStatus) {
        this._flowStatus.textContent = `「${ZONE_JP[hit.type] || hit.type}」にはまだ工程が割り当てられていません。「床図でフロー配置」で割り当ててください。`;
      }
    }
  }

  // ---- flow side panel: the workflow strip (synced) + method panel ---------
  _renderFlowSide() {
    const s = this.side; if (!s) return;
    s.innerHTML = '';
    this._h(s, '作業フロー（工程ごとに作業方法）');
    this._note(s, '工程をクリックすると作業方法を設定できます。床図のゾーンと同じデータを表示しています。');

    const order = this._orderedStages();
    const strip = this._div(s, 'display:flex;flex-direction:column;gap:0;margin:8px 0 14px;');
    order.forEach((st, i) => {
      const open = this.flowMethodStage === st.id;
      const box = this._div(strip, `display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 11px;border-radius:9px;cursor:pointer;border:2px solid ${METHOD_COLOR[st.method] || 'var(--ink-tertiary)'};background:${open ? hexA(METHOD_COLOR[st.method] || 'var(--ink-tertiary)', 0.28) : hexA(METHOD_COLOR[st.method] || 'var(--ink-tertiary)', 0.1)};`);
      this._on(box, 'click', () => {
        this.flowMethodStage = (this.flowMethodStage === st.id) ? null : st.id;
        this._renderFlowSide(); this._drawFlowCanvas();
      });
      const lblWrap = this._div(box, 'display:flex;flex-direction:column;gap:2px;');
      const lbl = this._div(lblWrap, 'font-weight:700;font-size:14px;');
      lbl.textContent = `${i + 1}. ${st.label || st.id}`;
      const zname = this._div(lblWrap, 'font-size:11px;color:var(--ink-secondary);');
      const z = st.zone ? this._zoneById(st.zone) : null;
      zname.textContent = z ? `場所: ${ZONE_JP[z.type] || z.type}` : '場所: 未割当';
      const badge = this._div(box, `font-size:11px;color:#fff;background:${METHOD_COLOR[st.method] || 'var(--ink-tertiary)'};padding:2px 7px;border-radius:10px;white-space:nowrap;`);
      badge.textContent = (METHOD_OPTS.find((o) => o.value === st.method) || {}).label || st.method;
      // arrow connector
      if (i < order.length - 1) {
        const arrow = this._div(strip, 'text-align:center;color:var(--ink-secondary);font-size:16px;line-height:1;margin:1px 0;');
        arrow.textContent = '↓';
      }
    });

    // in-context method panel for the open stage
    const open = this.flowMethodStage
      ? this.model.process.stages.find((st) => st.id === this.flowMethodStage) : null;
    if (open) this._renderMethodPanel(s, open);

    this._h(s, 'ピッキング戦略（互換）');
    const psSel = this._select(s, PICK_STRATS, this.model.process.pick_strategy);
    this._on(psSel, 'change', () => { this.model.process.pick_strategy = psSel.value; });
    this._note(s, '5軸の作業方法を設定すると、こちらより優先されます。');
  }

  // ---- in-context method panel -------------------------------------------
  // The pick stage exposes all 5 axes (with live reverse-name + 推奨); other
  // stages expose just transport (人が歩く / 物が来る).
  _renderMethodPanel(s, st) {
    const isPick = st.id === 'pick';
    this._h(s, `作業方法: ${st.label || st.id}`);

    if (!isPick) {
      // non-pick node: just transport (A axis), stored on st.method.
      this._field(s, '誰が動く？', () => {
        const sel = this._select(null, METHOD_OPTS, st.method);
        this._on(sel, 'change', () => { st.method = sel.value; this._renderFlowSide(); this._drawFlowCanvas(); });
        return sel;
      });
      this._note(s, '人手＝人が歩いて運ぶ。AGV/コンベア/自動倉庫＝物が来る。');
      return;
    }

    // pick node: ensure a 5-axis work object exists (always valid).
    if (!st.work) st.work = clone(DEFAULT_WORK);
    const work = st.work;
    // keep legacy st.method in sync with transport so the strip color/badge follows.
    st.method = work.transport;

    // live reverse-name banner (filled by the backend)
    const banner = this._div(s, 'margin:6px 0 10px;padding:9px 11px;border-radius:9px;background:var(--accent-tint);border:1px solid var(--accent-ring);');
    this._methodBanner = banner;
    banner.innerHTML = '<div style="font-weight:700;color:var(--accent-ink);">＝ …</div>';

    // 推奨 button
    const recRow = this._div(s, 'margin-bottom:10px;');
    this._btn(recRow, '推奨を表示', () => this._recommendWork(st), 'background:var(--accent);color:var(--ink-onAccent);border-color:var(--accent);font-weight:700;');
    this._recReason = this._div(s, 'font-size:12px;color:var(--ok);line-height:1.5;margin-bottom:8px;');

    // axis A: transport (select)
    this._methodAxis(s, work, 'transport', () => {
      st.method = work.transport;  // mirror to legacy
    });
    // axis B: orders_per_trip (number, plain label)
    this._field(s, '1回で何オーダー？', () => this._num(work.orders_per_trip, (v) => {
      work.orders_per_trip = Math.max(1, Math.round(v));
      this._refreshMethodBanner(work);
    }, 1));
    const sub = this._div(s, 'font-size:11px;color:var(--ink-tertiary);margin:-2px 0 8px;');
    sub.textContent = 'まとめ度 (orders_per_trip)';
    // axis C, D, E (selects)
    this._methodAxis(s, work, 'zoning');
    this._methodAxis(s, work, 'consolidation');
    this._methodAxis(s, work, 'release');
    // wave interval (only meaningful when release == wave)
    this._field(s, 'ウェーブ間隔（分）', () => this._num(Math.round((work.wave_interval_s || 1800) / 60), (v) => {
      work.wave_interval_s = Math.max(1, Math.round(v)) * 60;
      this._refreshMethodBanner(work);
    }, 1));

    this._refreshMethodBanner(work);
  }

  // one 5-axis control (select) with plain label + small expert sub-label
  _methodAxis(s, work, key, after) {
    const ax = WORK_AXES[key];
    if (!ax) return;
    this._field(s, ax.label, () => {
      const sel = this._select(null, ax.opts, work[key]);
      this._on(sel, 'change', () => {
        work[key] = sel.value;
        if (after) after();
        this._refreshMethodBanner(work);
        this._renderFlowSide();  // reflect transport change into strip
        this._drawFlowCanvas();
      });
      return sel;
    });
    const sub = this._div(s, 'font-size:11px;color:var(--ink-tertiary);margin:-2px 0 8px;');
    sub.textContent = ax.sub;
  }

  // live-call the backend to reverse-name the current 5-axis combination.
  async _refreshMethodBanner(work) {
    const banner = this._methodBanner;
    if (!banner || !this.handlers.workmethodName) return;
    try {
      const r = await this.handlers.workmethodName(clone(work));
      banner.innerHTML = `<div style="font-weight:700;color:var(--accent-ink);">＝ ${r.name || ''}</div>`
        + `<div style="font-size:12px;color:var(--ink-primary);margin-top:3px;">${r.explain || ''}</div>`;
    } catch (err) {
      banner.innerHTML = `<div style="font-size:12px;color:var(--bad);">方式名の取得に失敗しました</div>`;
    }
  }

  // call the recommend endpoint and load the suggested axes + show the reason.
  async _recommendWork(st) {
    if (!this.handlers.recommendWork) {
      if (this._recReason) this._recReason.textContent = '推奨ハンドラがありません。';
      return;
    }
    if (this._recReason) { this._recReason.style.color = 'var(--ink-secondary)'; this._recReason.textContent = '推奨を計算中…'; }
    try {
      const r = await this.handlers.recommendWork();
      if (r && r.work) {
        st.work = Object.assign(clone(DEFAULT_WORK), r.work);
        st.method = st.work.transport;
      }
      if (this._recReason) {
        this._recReason.style.color = 'var(--ok)';
        this._recReason.textContent = `推奨: ${r.name || ''} — ${r.reason || ''}`;
      }
      this._renderFlowSide();  // reloads panel with new axis values
      this._drawFlowCanvas();
    } catch (err) {
      if (this._recReason) {
        this._recReason.style.color = 'var(--bad)';
        this._recReason.textContent = 'エラー: ' + (err && err.message ? err.message : String(err));
      }
    }
  }

  // ---- save ----------------------------------------------------------------
  async _save() {
    if (!this.handlers.save) { this._saveMsg.textContent = '保存ハンドラがありません。'; return; }
    if (this.tool === 'equip' && this.conveyorDraft) this._finishConveyor();
    if (this.tool === 'building' && this.wallDraft) this._finishWall();
    if (this.routeDraft && this.routeDraft.length >= 2) this._finishRoute();
    this.routeDraft = null;
    this._saveBtn.disabled = true;
    this._saveMsg.style.color = 'var(--ink-secondary)';
    this._saveMsg.textContent = '保存中…';
    try {
      const r = await this.handlers.save({
        layout: clone(this.model.layout),
        resources: clone(this.model.resources),
        process: clone(this.model.process),
        routes: clone(this.model.routes),
      });
      const prov = r && r.provenance_summary ? ` / ${r.provenance_summary}` : '';
      this._saveMsg.style.color = 'var(--ok)';
      this._saveMsg.textContent = '保存しました' + prov;
    } catch (err) {
      this._saveMsg.style.color = 'var(--bad)';
      this._saveMsg.textContent = 'エラー: ' + (err && err.message ? err.message : String(err));
    } finally {
      this._saveBtn.disabled = false;
    }
  }

  // ---- tiny DOM builders ---------------------------------------------------
  _on(el, type, fn) { el.addEventListener(type, fn); this._listeners.push([el, type, fn]); }
  _div(parent, css) { const d = document.createElement('div'); if (css) d.style.cssText = css; if (parent) parent.appendChild(d); return d; }
  _h(parent, text) {
    const h = document.createElement('div');
    h.textContent = text;
    h.style.cssText = 'font-size:12px;font-weight:700;color:var(--ink-secondary);margin:10px 0 6px;';
    parent.appendChild(h); return h;
  }
  _note(parent, text) {
    const n = document.createElement('div');
    n.textContent = text;
    n.style.cssText = 'font-size:12px;color:var(--ink-tertiary);line-height:1.5;';
    parent.appendChild(n); return n;
  }
  _field(parent, label, makeInput) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;';
    const l = document.createElement('label');
    l.textContent = label;
    l.style.cssText = 'font-size:12px;flex:1;';
    row.appendChild(l);
    const inp = makeInput();
    inp.style.cssText += ';width:96px;padding:5px 7px;border:1px solid var(--line-hair);border-radius:6px;font-size:13px;background:var(--bg-app);color:var(--ink-primary);';
    row.appendChild(inp);
    parent.appendChild(row);
    return inp;
  }
  _num(value, onChange, step) {
    const i = document.createElement('input');
    i.type = 'number'; i.step = step ? String(step) : 'any';
    i.value = value == null ? '' : String(value);
    this._on(i, 'change', () => { const v = parseFloat(i.value); if (!Number.isNaN(v)) onChange(v); });
    return i;
  }
  _select(parent, opts, value) {
    const sel = document.createElement('select');
    sel.style.cssText = 'padding:5px 7px;border:1px solid var(--line-hair);border-radius:6px;font-size:13px;background:var(--bg-app);color:var(--ink-primary);';
    for (const o of opts) {
      const op = document.createElement('option');
      op.value = o.value; op.textContent = o.label;
      if (o.value === value) op.selected = true;
      sel.appendChild(op);
    }
    if (parent) parent.appendChild(sel);
    return sel;
  }
  _btn(parent, text, onClick, css) {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'padding:6px 10px;border:1px solid var(--line-hair);border-radius:6px;background:var(--bg-app);color:var(--ink-primary);font-size:13px;cursor:pointer;' + (css || '');
    this._on(b, 'click', onClick);
    if (parent) parent.appendChild(b);
    return b;
  }
}
