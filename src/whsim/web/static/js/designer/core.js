// designer/core.js — interactive, structured/parametric warehouse design editor.
//
// One unified 配置 (place) tool + two line tools share one container and one
// deep-copied model:
//   (1) 配置   — Canvas2D floor view with an object LIBRARY (Minecraft-style):
//                every placeable thing (棚9種 / ゾーン / マテハン設備 / 壁・ドア)
//                is a visual card; click or drag-onto-the-floor arms it as the
//                active brush, a ghost previews the real footprint under the
//                cursor, click stamps it. 選択 brush edits everything in place
//                (zones, shelves, equipment, walls, doors — unified hit-test).
//   (2) フロー — DOM workflow strip of stages with per-stage method dropdowns.
//   (3) 動線   — walking/forklift route polylines with distance/time readout.
//
// Pure DOM / Canvas2D. Mutates an internal deep copy of `model` and only writes
// back to the host via handlers.save({layout, resources, process}). The palettes,
// label maps and geometry constants live in ./constants.js; the pure geometry /
// colour / palette helpers live in ./geometry.js. This file owns the Designer
// class itself (state, lifecycle, render loop, canvas interaction, save).
//
// Public API (must stay stable — app.js imports the facade designer.js):
//   new Designer(container, model, handlers)
//   .save() .setModel(model) .resize() .dispose()
//   .assignInventory() .recommendWork()
import {
  ZONE_JP,
  ZONE_TYPES, ZONE_DEFAULT_COLOR, EQUIP_PALETTE, LAYOUT_PALETTE,
  RACK_TYPES, RACK_ORDER, RACK_SILHOUETTE_FALLBACK,
  DOOR_PALETTE, DOOR_JP, METHOD_OPTS, METHOD_COLOR, PICK_STRATS,
  WORK_AXES, DEFAULT_WORK, MOVER_OPTS, MOVER_JP, MOVER_SPEED, MOVER_COLOR,
  HANDLE, MIN_M, SNAP_PX, SHELF_MIN_M, CP_HALF, CONTROL_POINTS, SHELFGEN_FACES,
  LIBRARY_DIGITS, EQUIP_ZONE_RULES, STAGE_ZONE_TYPES,
} from './constants.js';
import { resolvePalette, clone, clamp, snap, uid, hexA } from './geometry.js';

export class Designer {
  constructor(container, model, handlers) {
    this.container = container;
    this.handlers = handlers || {};
    this.tool = 'place';           // 'place' | 'flow' | 'route'
    // The active brush (Minecraft hotbar model). One of:
    //   {kind:'select'}                  — edit: click selects, drag moves/resizes
    //   {kind:'rack',  key:<rack id>}    — stamp/drag a shelf of that type
    //   {kind:'zone',  key:<zone type>}  — stamp a zone (default footprint)
    //   {kind:'equip', key:<equip key>}  — stamp equipment (conveyor = vertices)
    //   {kind:'wall'}                    — click vertices (Shift=ortho), dbl=確定
    //   {kind:'door',  key:<door type>}  — stamp a door on the building edge
    this.brush = { kind: 'select' };
    this.hover = null;             // {mx,my} cursor in meters (ghost + status bar)
    this.selected = null;          // {kind, id} of selected canvas object
    // M2: when shelves are selected, `selShelves` is a Set of shelf ids inside the
    // active storage zone (`shelfZoneId`). Single zone selection still uses `selected`.
    this.selShelves = new Set();   // selected ShelfArea ids (MapMaker multi-select)
    this.shelfZoneId = null;       // storage zone whose shelves are being edited
    this.shelfDraft = null;        // {x0,y0,x1,y1} while corner-dragging a new shelf
    this.snapLine = null;          // {x?, y?} green snap guide in world coords
    this.noSnap = false;           // true while Ctrl held (disables edge snapping)
    this.shelfType = 'medium';     // storage-equipment preset applied to new 棚
    this.showUnderlay = true;      // draw DXF walls as a faint trace underlay
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
    // M2 camera: world-space center (cx,cy in meters) + a zoom multiplier on top
    // of the fit-to-bounds scale. `_cam` is the live (rendered) camera; `_camGoal`
    // is the target — pan/zoom ease `_cam` → `_camGoal` over rAF for the スルスル feel.
    // zoom=1 means "fit the whole floor"; >1 zooms in. cx/cy=null => recentre on fit.
    this._cam = { cx: null, cy: null, zoom: 1 };
    this._camGoal = { cx: null, cy: null, zoom: 1 };
    this._normalize(model);
    this._adoptModelView();        // honour imported view{centerX,centerY,zoom}
    this._buildShell();
    this._bindWindow();
    this._bindKeys();
    this._bindTheme();
    this._selectTool('place');
    // M3: pull the live storage-equipment catalog (/api/racktypes) so the palette
    // tracks the backend presets; falls back silently to the seed RACK_TYPES.
    this._loadRackCatalog();
  }

  // ---- M3: live storage-equipment catalog (/api/racktypes) -----------------
  // Best-effort fetch of the server's rack-type presets. On success we merge the
  // catalog into RACK_TYPES / RACK_ORDER (preserving our silhouette + height
  // hints, which are view3d-side and not in the API) and repaint the active tool
  // so the palette/legend pick up any label/spec/colour changes. Any failure is
  // swallowed — the seed catalog already makes every model valid and runnable.
  async _loadRackCatalog() {
    try {
      const res = await fetch('/api/racktypes', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const list = await res.json();
      if (!Array.isArray(list) || !list.length) return;
      const order = [];
      for (const p of list) {
        if (!p || !p.id) continue;
        const seed = RACK_TYPES[p.id] || {};
        RACK_TYPES[p.id] = {
          label: p.label || seed.label || p.id,
          bay: +p.bay || seed.bay || 1.0,
          depth: +p.depth || seed.depth || 0.6,
          levels: +p.levels || seed.levels || 1,
          capacity: +p.capacity || seed.capacity || 0,
          color: p.color || seed.color || '#888888',
          desc: p.desc || seed.desc || '',
          // silhouette/height are view3d-side hints, not part of the API.
          silhouette: seed.silhouette || RACK_SILHOUETTE_FALLBACK,
          h: seed.h || 2.4,
        };
        order.push(p.id);
      }
      if (order.length) { RACK_ORDER.length = 0; RACK_ORDER.push(...order); }
      // ensure the active type still exists in the (possibly reordered) catalog.
      if (!RACK_TYPES[this.shelfType]) this.shelfType = RACK_ORDER[0] || 'medium';
      // repaint so the library cards reflect the live catalog.
      if (this.tool === 'place') this._renderTool();
    } catch (_e) { /* offline / not-served: keep the seed catalog */ }
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
    this.selShelves = new Set();
    this.shelfZoneId = null;
    this.shelfDraft = null;
    this.conveyorDraft = null;
    this.wallDraft = null;
    this.routeDraft = null;
    this._adoptModelView();      // honour imported view{centerX,centerY,zoom}
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
    if (this._camRaf) cancelAnimationFrame(this._camRaf);
    if (this._dialogEl && this._dialogEl.parentNode) this._dialogEl.parentNode.removeChild(this._dialogEl);
    this._dialogEl = null;
    if (this._helpEl && this._helpEl.parentNode) this._helpEl.parentNode.removeChild(this._helpEl);
    this._helpEl = null;
    this.container.innerHTML = '';
  }

  // ---- help / legend overlay ------------------------------------------------
  _toggleHelp() {
    if (this._helpEl) { this._helpEl.remove(); this._helpEl = null; return; }
    const box = document.createElement('div');
    box.classList.add('dz-enter');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', '設計エディタのヘルプ');
    box.style.cssText = 'position:absolute;top:48px;right:16px;z-index:30;width:320px;max-width:calc(100% - 32px);'
      + 'background:var(--bg-panel);border:1px solid var(--line-strong);border-radius:var(--r-lg);box-shadow:var(--sh-lg);'
      + 'padding:14px 16px;font-size:12px;color:var(--ink-secondary);line-height:1.7;';
    box.innerHTML = '<div style="font-weight:700;font-size:13px;margin-bottom:6px;color:var(--ink-primary);">操作ヘルプ</div>'
      + '<div><b>配置</b>: 左のライブラリから置きたい物を選ぶ（またはカードを床へドラッグ）。'
      + 'カーソルに実寸のゴーストが出るので、床をクリックで配置。連続で置けます。'
      + '<b>Esc</b>か右クリックで「選択」に戻ります。</div>'
      + '<div><b>選択</b>: クリックで選択（棚はShiftで複数）、ドラッグで移動、ハンドルでサイズ変更。'
      + '右パネルで名前・寸法・台数などを数値編集。</div>'
      + '<div><b>棚</b>: クリック=1台スタンプ / ドラッグ=角から角で1枚。エッジに自動スナップ'
      + '（<b>Ctrl</b>で無効）。<b>一括生成</b>＝間口の向き・連結数を指定、<b>面積生成</b>＝矩形から棚列＋通路を自動配置。</div>'
      + '<div><b>壁</b>: クリックで頂点追加（<b>Shift</b>=水平/垂直固定、長さ表示）、ダブルクリックで確定。</div>'
      + '<div><b>コンベア</b>: クリックで頂点追加、ダブルクリックで確定。</div>'
      + '<div><b>フロー</b>: 工程をクリックで作業方法を設定。「床図でフロー配置」で工程→ゾーンを割当。</div>'
      + '<div><b>動線</b>: 床をクリックで頂点追加、ダブルクリックで確定。距離と所要時間を自動計算。</div>'
      + '<div style="margin-top:6px;">ホイールで拡大縮小、中ボタンドラッグで移動、「全体表示」でリセット。</div>'
      + '<div style="margin-top:8px;border-top:1px solid var(--line-hair);padding-top:8px;">'
      + '<b>キーボード</b><br>ライブラリ: <b>1</b>=選択 <b>2</b>=保管ゾーン <b>3</b>=棚 <b>4</b>=壁 '
      + '<b>5</b>=梱包台 <b>6</b>=AGV <b>7</b>=コンベア <b>8</b>=自動倉庫 <b>9</b>=ドックドア<br>'
      + '選択を削除: <b>Delete</b> / 複製(棚): <b>D</b> / 取消: <b>Esc</b><br>'
      + '元に戻す: <b>Ctrl/⌘+Z</b> / やり直す: <b>Ctrl/⌘+Shift+Z</b></div>'
      + '<div style="margin-top:8px;color:var(--ink-tertiary);">変更は「レイアウトを保存」を押すまでサーバーに保存されません。</div>';
    const close = document.createElement('button');
    close.textContent = '閉じる';
    close.style.cssText = 'margin-top:10px;padding:5px 10px;border:1px solid var(--line-hair);border-radius:var(--r-sm);background:var(--bg-app);color:var(--ink-primary);cursor:pointer;font-size:12px;';
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
    m.layout.zones.forEach((z, i) => {
      if (!z.id) z.id = uid('zone');
      if (!z.type) z.type = 'storage';
      // M2: normalize authored SHELF areas so every shelf carries name + facing
      // (the downstream materialize_racks reads both). Defaults keep models valid.
      if (Array.isArray(z.shelves)) {
        z.shelves.forEach((sh) => {
          if (!sh.id) sh.id = uid('s');
          if (typeof sh.name !== 'string') sh.name = '';
          if (!['up', 'down', 'left', 'right'].includes(sh.facing)) sh.facing = 'down';
          if (!sh.rack_type) sh.rack_type = 'medium';
          sh.x = +sh.x || 0; sh.y = +sh.y || 0;
          sh.w = +sh.w || SHELF_MIN_M; sh.h = +sh.h || SHELF_MIN_M;
        });
      } else {
        z.shelves = z.shelves || [];
      }
    });
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

  // ---- scoped V3 polish (Figma-flavoured): cosmetic + motion only ----------
  // One-time <style> injected on first mount. Every rule is scoped under
  // `.designer-root` so it can never leak into the rest of the app, and it only
  // touches transform / opacity / colour / shadow / border — never layout flow,
  // never any element's behaviour. Motion uses the app's existing tokens
  // (--ease-out / --dur-*) and fully degrades under prefers-reduced-motion.
  _injectStyle() {
    if (document.getElementById('designer-v3-style')) return;
    const s = document.createElement('style');
    s.id = 'designer-v3-style';
    s.textContent = `
    /* press feedback shared by all designer buttons (transform only) */
    .designer-root button{
      transition:background var(--dur-1,90ms) var(--ease-out,ease),
        color var(--dur-1,90ms) var(--ease-out,ease),
        border-color var(--dur-1,90ms) var(--ease-out,ease),
        box-shadow var(--dur-1,90ms) var(--ease-out,ease),
        transform var(--dur-1,90ms) var(--ease-out,ease);
    }
    @media (hover:hover){
      .designer-root button:not(:disabled):hover{
        border-color:var(--accent,#2383E2);
        color:var(--ink-primary,#16202e);
      }
      .designer-root button.primary:not(:disabled):hover{
        color:var(--bg-app,#fff);filter:brightness(1.05);
      }
    }
    .designer-root button:not(:disabled):active{transform:scale(.97)}
    .designer-root button:disabled{opacity:.45;cursor:default}
    .designer-root button:focus-visible{
      outline:2px solid var(--accent,#2383E2);outline-offset:2px;
    }
    /* selects & numeric inputs: focus ring + hover hairline */
    .designer-root select,.designer-root input{
      transition:border-color var(--dur-1,90ms) var(--ease-out,ease),
        box-shadow var(--dur-1,90ms) var(--ease-out,ease);
    }
    @media (hover:hover){
      .designer-root select:hover,.designer-root input:hover{
        border-color:var(--line-strong);
      }
    }
    .designer-root select:focus,.designer-root input:focus{
      outline:none;border-color:var(--accent,#2383E2);
      box-shadow:0 0 0 3px var(--accent-tint,rgba(35,131,226,.12));
    }
    /* canvas frame polish: soft inset + lift on hover (cosmetic only) */
    .designer-root .dz-canvas-wrap{
      transition:border-color var(--dur-2,160ms) var(--ease-out,ease),
        box-shadow var(--dur-2,160ms) var(--ease-out,ease);
      box-shadow:0 1px 2px rgba(15,23,32,.04);
    }
    @media (hover:hover){
      .designer-root .dz-canvas-wrap:hover{
        border-color:var(--accent-ring,rgba(35,131,226,.35));
        box-shadow:0 6px 22px rgba(15,23,32,.08),
          0 0 0 1px var(--accent-tint,rgba(35,131,226,.12));
      }
    }
    /* the active canvas gets a whisper-thin cyan accent edge (brand <5%) */
    .designer-root .dz-canvas-wrap::after{
      content:"";position:absolute;inset:0;border-radius:var(--r-md);pointer-events:none;
      box-shadow:inset 0 0 0 1px rgba(52,227,255,.10);
      opacity:0;transition:opacity var(--dur-2,160ms) var(--ease-out,ease);
    }
    .designer-root .dz-canvas-wrap:hover::after{opacity:1}
    /* side panels & help popover: gentle entrance (opacity + scale .985->1) */
    .designer-root .dz-enter{animation:dz-enter var(--dur-2,160ms) var(--ease-out,ease) both}
    @keyframes dz-enter{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:scale(1)}}
    /* canvas wrap also lifts its accent edge while a field inside the panel is
       focused (keyboard users get the same affordance as hover) */
    .designer-root .dz-canvas-wrap:focus-within{
      border-color:var(--accent-ring,rgba(35,131,226,.35));
    }
    /* tool-tab / palette toggle row buttons: a touch more lift on hover so the
       active (filled) state reads as raised, like a Figma toolbar (cosmetic) */
    @media (hover:hover){
      .designer-root button:not(:disabled):not(.primary):hover{
        box-shadow:0 1px 2px rgba(15,23,32,.06);
      }
    }
    /* checkbox / toggle: subtle accent on hover (transform/colour only) */
    @media (hover:hover){
      .designer-root input[type=checkbox]:hover{accent-color:var(--accent,#2383E2)}
    }
    .designer-root input[type=checkbox]{
      transition:accent-color var(--dur-1,90ms) var(--ease-out,ease)}
    /* help popover entrance reuse */
    @media (prefers-reduced-motion:reduce){
      .designer-root *,.designer-root *::after{
        animation:none!important;transition:none!important;
      }
    }
    /* M2 modal dialog (棚一括生成 / 面積オート生成). Scoped overlay + card. */
    .designer-root .dz-dialog-overlay{
      position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;
      background:rgba(15,23,32,.32);backdrop-filter:blur(1px);
    }
    .designer-root .dz-dialog{
      width:380px;max-width:calc(100% - 32px);max-height:calc(100% - 32px);overflow:auto;
      background:var(--bg-panel);border:1px solid var(--line-strong);border-radius:var(--r-lg);
      box-shadow:var(--sh-lg);padding:16px 18px;color:var(--ink-secondary);font-size:13px;
    }
    .designer-root .dz-dialog-title{
      font-weight:700;font-size:14px;color:var(--ink-primary);margin-bottom:12px;
    }
    `;
    document.head.appendChild(s);
  }

  // ---- shell: top tool tabs, body, save row --------------------------------
  _buildShell() {
    const c = this.container;
    c.innerHTML = '';
    c.classList.add('designer-root');
    this._injectStyle();
    c.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;gap:8px;font-size:13px;position:relative;';

    // tool switch bar
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';
    this._toolBtns = {};
    const TOOL_TIP = {
      place: 'ライブラリから棚・設備・ゾーン・壁を選んで床に配置（編集も）',
      flow: '工程の順序と作業方法、各工程の場所（ゾーン）を設定',
      route: '作業員・フォークリフトの動線を作図し距離/時間を確認',
    };
    for (const [key, label] of [['place', '配置'], ['flow', 'フロー'], ['route', '動線']]) {
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
    save.textContent = 'レイアウトを保存';
    save.title = 'レイアウト・ゾーン・棚・工程・人員の変更をサーバーに保存します';
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

    // next-step footer: an unobtrusive "what now?" affordance pinned below the
    // canvas (flex:none so it never steals canvas height). Editing happens in the
    // body above; this row routes the user onward once the layout is shaped.
    this._buildNextSteps(c);
  }

  // ---- next-step CTA row (実行する / タイムチャートを見る) -------------------
  // Dispatches app-level events (app.js owns the actual run + navigation); the
  // designer only signals intent so it stays decoupled from the host shell.
  _buildNextSteps(parent) {
    const foot = this._div(parent,
      'flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;gap:var(--sp-2);'
      + 'padding-top:var(--sp-2);margin-top:var(--sp-1);border-top:1px solid var(--line-hair);');
    const hint = this._div(foot,
      'flex:1;min-width:0;font-size:var(--fs-xs);color:var(--ink-tertiary);');
    hint.textContent = '配置ができたら次へ:';
    // secondary: jump to the timetable view (ghost styling from _btn)
    this._btn(foot, 'タイムチャートを見る →', () => {
      document.dispatchEvent(new CustomEvent('whsim:nav', { detail: { view: 'timetable' } }));
    });
    // primary: apply + run the simulation
    const run = document.createElement('button');
    run.className = 'primary';
    run.textContent = '実行する →';
    run.style.cssText = 'padding:6px 12px;border-radius:var(--r-sm);font-size:var(--fs-sm);font-weight:700;cursor:pointer;';
    this._on(run, 'click', () => {
      document.dispatchEvent(new CustomEvent('whsim:apply-run', { detail: {} }));
    });
    foot.appendChild(run);
  }

  _selectTool(key) {
    this.tool = key;
    this.selected = null;
    this.selShelves = new Set();
    this.shelfDraft = null;
    this.snapLine = null;
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
    if (this.tool === 'flow' || this.tool === 'route') {
      this.lib = null; this._stPos = null;       // drop stale 配置-tool DOM refs
      this.body.style.flexWrap = 'wrap';
      if (this.tool === 'flow') this._renderFlow(); else this._renderRoute();
      return;
    }
    // 配置 tool must NOT wrap: with wrap, the flex line's height grows to the
    // tall library content, blowing the canvas past the viewport (clicks then
    // land outside the floor). nowrap keeps all three columns at panel height
    // and lets the library scroll internally.
    this.body.style.flexWrap = 'nowrap';
    // 配置 tool: [library | canvas+status | object editor] in one row.
    this.lib = document.createElement('div');
    this.lib.style.cssText = 'width:218px;flex:0 0 218px;min-height:0;overflow-y:auto;'
      + 'border:1px solid var(--line-hair);border-radius:var(--r-md);background:var(--bg-sunken);padding:8px;';
    this.lib.classList.add('dz-enter');
    this.body.appendChild(this.lib);
    this._renderLibrary(this.lib);

    const mid = document.createElement('div');
    mid.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;';
    this._renderCanvasBar(mid);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;min-height:0;position:relative;border:1px solid var(--line-hair);border-radius:var(--r-md);background:var(--bg-app);overflow:hidden;';
    wrap.classList.add('dz-canvas-wrap');
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = `width:100%;height:100%;display:block;cursor:${this.brush.kind === 'select' ? 'default' : 'crosshair'};`;
    wrap.appendChild(this.canvas);
    // canvas accepts drops from the library cards (drag a card → place at drop).
    this._bindCanvasDrop(wrap);
    mid.appendChild(wrap);
    this._buildStatusBar(mid);
    this.body.appendChild(mid);

    this.side = document.createElement('div');
    this.side.style.cssText = 'width:240px;flex:0 0 240px;overflow-y:auto;border:1px solid var(--line-hair);border-radius:var(--r-md);background:var(--bg-sunken);padding:10px;';
    this.side.classList.add('dz-enter');
    this.body.appendChild(this.side);

    this.ctx = this.canvas.getContext('2d');
    this._bindCanvas();
    this._fitCanvas();
    this._renderSide();
    this._drawCanvas();
    this._updateStatus();
  }

  // ---- thin bar above the canvas: zoom-to-fit / underlay / inventory --------
  _renderCanvasBar(parent) {
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 8px;'
      + 'border:1px solid var(--line-hair);border-radius:var(--r-md);background:var(--bg-sunken);';
    this._btn(bar, '全体表示', () => this._zoomToFit(), 'font-size:12px;').title = '全体が収まるように表示（ホイールで拡大縮小、中ボタンドラッグで移動）';
    const ulLbl = document.createElement('label');
    ulLbl.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;color:var(--ink-secondary);cursor:pointer;';
    const ulCb = document.createElement('input');
    ulCb.type = 'checkbox';
    ulCb.checked = !!this.showUnderlay;
    this._on(ulCb, 'change', () => { this.showUnderlay = ulCb.checked; this._drawCanvas(); });
    ulLbl.appendChild(ulCb);
    ulLbl.appendChild(document.createTextNode('下地(壁)を表示'));
    bar.appendChild(ulLbl);
    this._btn(bar, '在庫を割付', () => this._assignInventory(), 'font-size:12px;');
    const spacer = document.createElement('div'); spacer.style.flex = '1'; bar.appendChild(spacer);
    // status line for placement hint / inventory result (kept from the old bar).
    this._layoutStatus = document.createElement('span');
    this._layoutStatus.style.cssText = 'font-size:12px;color:var(--ink-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%;';
    this._layoutStatus.textContent = this._brushHint();
    bar.appendChild(this._layoutStatus);
    parent.appendChild(bar);
  }

  // ---- CAD-style status bar under the canvas ---------------------------------
  // Live readout: cursor position (m) / armed brush / selection size / zoom. The
  // numbers are what make the editor feel trustworthy — you always see exactly
  // where you are and how big things are (MapMaker/CAD convention).
  _buildStatusBar(parent) {
    const bar = document.createElement('div');
    bar.style.cssText = 'flex:0 0 auto;display:flex;gap:14px;align-items:center;padding:3px 10px;'
      + 'border:1px solid var(--line-hair);border-radius:var(--r-md);background:var(--bg-sunken);'
      + 'font-size:11.5px;color:var(--ink-secondary);font-variant-numeric:tabular-nums;min-height:22px;';
    this._stPos = this._div(bar, 'min-width:120px;');
    this._stBrush = this._div(bar, 'min-width:150px;font-weight:700;color:var(--ink-primary);');
    this._stSel = this._div(bar, 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
    this._stZoom = this._div(bar, 'margin-left:auto;');
    parent.appendChild(bar);
  }

  _updateStatus() {
    if (!this._stPos) return;
    const h = this.hover;
    this._stPos.textContent = h ? `X ${h.mx.toFixed(2)}m  Y ${h.my.toFixed(2)}m` : 'X —  Y —';
    this._stBrush.textContent = `配置: ${this._brushLabel()}`;
    let sel = '';
    if (this.selShelves && this.selShelves.size) {
      const objs = this._selShelfObjs();
      if (objs.length === 1) {
        const sh = objs[0].sh;
        sel = `棚「${sh.name || sh.id}」 ${sh.w.toFixed(2)}×${sh.h.toFixed(2)}m @ (${sh.x.toFixed(2)}, ${sh.y.toFixed(2)})`;
      } else if (objs.length > 1) sel = `棚 ${objs.length}枚を選択中`;
    } else if (this.selected) {
      const k = this.selected.kind;
      if (k === 'zone') {
        const z = this._zoneById(this.selected.id);
        if (z) sel = `${ZONE_JP[z.type] || z.type} ${z.w.toFixed(1)}×${z.h.toFixed(1)}m @ (${z.x.toFixed(1)}, ${z.y.toFixed(1)})`;
      } else if (k === 'equip') {
        const e = (this.model.resources.equipment || []).find((q) => q.id === this.selected.id);
        const p = e && EQUIP_PALETTE.find((x) => x.type === e.type);
        if (e) sel = `${p ? p.label : e.type} ×${e.count ?? 1} @ (${(+e.x).toFixed(1)}, ${(+e.y).toFixed(1)})`;
      } else if (k === 'station') {
        const st = (this.model.resources.stations || []).find((q) => q.id === this.selected.id);
        if (st) sel = `梱包台 ×${st.count ?? 1} @ (${(+st.x).toFixed(1)}, ${(+st.y).toFixed(1)})`;
      } else if (k === 'wall') {
        const w = (this.model.layout.walls || []).find((q) => q.id === this.selected.id);
        if (w) sel = `壁 ${(w.points || []).length}頂点 / 厚 ${(w.thickness || 0.3).toFixed(2)}m`;
      } else if (k === 'door') {
        const d = (this.model.layout.doors || []).find((q) => q.id === this.selected.id);
        if (d) sel = `${DOOR_JP[d.type] || d.type} 幅${(d.w || 1).toFixed(1)}m @ (${(+d.x).toFixed(1)}, ${(+d.y).toFixed(1)})`;
      }
    }
    this._stSel.textContent = sel ? `選択: ${sel}` : '';
    const zoomPct = this._view ? Math.round((this._cam.zoom || 1) * 100) : 100;
    this._stZoom.textContent = `倍率 ${zoomPct}%`;
  }

  _brushLabel() {
    const b = this.brush;
    if (!b || b.kind === 'select') return '選択 / 編集';
    if (b.kind === 'rack') { const rt = RACK_TYPES[b.key || this.shelfType]; return `棚: ${rt ? rt.label : ''}`; }
    if (b.kind === 'zone') return `ゾーン: ${ZONE_JP[b.key] || b.key}`;
    if (b.kind === 'equip') { const p = EQUIP_PALETTE.find((x) => x.key === b.key); return p ? p.label : b.key; }
    if (b.kind === 'wall') return '壁';
    if (b.kind === 'door') return DOOR_JP[b.key] || 'ドア';
    return '';
  }

  _brushHint() {
    const b = this.brush;
    if (!b || b.kind === 'select') return 'ライブラリから置きたい物を選択（またはカードを床へドラッグ）。クリックで編集。';
    if (b.kind === 'rack') return 'クリック=1台 / ドラッグ=角から角で1枚。Esc・右クリックで選択に戻る。';
    if (b.kind === 'wall') return 'クリックで頂点追加（Shift=水平/垂直）、ダブルクリックで確定。';
    if (b.kind === 'equip' && b.key === 'conveyor') return 'クリックで頂点追加、ダブルクリックで確定。';
    if (b.kind === 'door') return '建屋の縁をクリックして配置。';
    return '床をクリックで配置。連続で置けます。Esc・右クリックで選択に戻る。';
  }

  // ===========================================================================
  // The object LIBRARY (Minecraft-style hotbar/palette).
  // Every placeable thing is a visual card in one scrollable panel, grouped by
  // category (編集 / 保管設備(棚) / ゾーン / マテハン設備 / 躯体). Clicking a card
  // arms it as the active brush; dragging a card onto the floor places it at the
  // drop point. Digit keys 1-9 jump to the pinned brushes (MapMaker parity).
  // ===========================================================================
  _setBrush(brush) {
    this.brush = brush || { kind: 'select' };
    // leaving a draft-y brush cancels its in-progress polyline.
    if (this.brush.kind !== 'wall') this.wallDraft = null;
    if (!(this.brush.kind === 'equip' && this.brush.key === 'conveyor')) this.conveyorDraft = null;
    this.shelfDraft = null;
    this.snapLine = null;
    if (this.brush.kind !== 'select') { this.selected = null; this.selShelves = new Set(); }
    if (this.canvas) this.canvas.style.cursor = this.brush.kind === 'select' ? 'default' : 'crosshair';
    if (this._layoutStatus) {
      this._layoutStatus.style.color = 'var(--ink-secondary)';
      this._layoutStatus.textContent = this._brushHint();
    }
    if (this.lib) this._renderLibrary(this.lib);
    this._renderSide();
    this._updateStatus();
    this._repaint();
  }

  // digit→brush map: digit 3 is "棚" = the ACTIVE rack type.
  _digitBrush(d) {
    const ent = LIBRARY_DIGITS.find((q) => q.digit === d);
    if (!ent) return null;
    if (ent.kind === 'rack') return { kind: 'rack', key: this.shelfType };
    return { kind: ent.kind, key: ent.key };
  }
  _digitFor(kind, key) {
    const ent = LIBRARY_DIGITS.find((q) => q.kind === kind && (q.kind === 'rack' || q.kind === 'select' || q.kind === 'wall' || q.key === key));
    return ent ? ent.digit : null;
  }

  _renderLibrary(host) {
    host.innerHTML = '';
    const sec = (title) => {
      const h = this._div(host, 'font-size:11px;font-weight:700;color:var(--ink-tertiary);'
        + 'letter-spacing:.06em;margin:10px 2px 5px;');
      h.textContent = title;
      return h;
    };
    const b = this.brush || {};

    // --- 編集 ---------------------------------------------------------------
    sec('編集');
    host.appendChild(this._libCard({
      icon: this._selIcon(), label: '選択 / 移動', sub: 'クリックで選択・ドラッグで移動',
      active: b.kind === 'select', digit: this._digitFor('select'),
      onPick: () => this._setBrush({ kind: 'select' }),
    }));

    // --- 保管設備（棚） -------------------------------------------------------
    sec('保管設備（棚）');
    // bulk tools row (apply to the active rack type)
    const tools = this._div(host, 'display:flex;gap:5px;margin:0 0 6px;');
    const bulkBtn = this._btn(tools, '一括生成', () => this._openBulkGenDialog(), 'flex:1;font-size:11.5px;padding:4px 4px;');
    bulkBtn.title = '間口の向き・連結数を指定してまとめて生成';
    const areaBtn = this._btn(tools, '面積生成', () => {
      this._setBrush({ kind: 'rack', key: this.shelfType, area: true });
    }, 'flex:1;font-size:11.5px;padding:4px 4px;');
    areaBtn.title = '矩形をドラッグで描くと棚列＋通路を自動でタイル配置';
    if (b.kind === 'rack' && b.area) areaBtn.style.cssText += ';background:var(--ink-primary);color:var(--bg-app);border-color:var(--ink-primary);font-weight:700;';
    // multi storage-zone: which zone receives new shelves
    const stores = this._storageZones();
    if (stores.length > 1) {
      if (!this.shelfZoneId || !stores.find((z) => z.id === this.shelfZoneId)) this.shelfZoneId = stores[0].id;
      const zrow = this._div(host, 'display:flex;align-items:center;gap:5px;margin:0 0 6px;font-size:11px;color:var(--ink-secondary);');
      zrow.appendChild(document.createTextNode('配置先:'));
      const sel = this._select(zrow, stores.map((z, i) => ({ value: z.id, label: `保管ゾーン${i + 1}` })), this.shelfZoneId);
      sel.style.flex = '1';
      this._on(sel, 'change', () => { this.shelfZoneId = sel.value; this.selShelves = new Set(); this._repaint(); });
    }
    const selCount = (this.selShelves && this.selShelves.size) || 0;
    if (selCount) {
      this._div(host, 'font-size:10.5px;color:var(--ink-tertiary);margin:0 2px 5px;')
        .textContent = `カードを押すと選択中の ${selCount} 棚に種別を適用`;
    }
    RACK_ORDER.forEach((key) => {
      const rt = RACK_TYPES[key];
      if (!rt) return;
      const selType = selCount ? this._selectionRackType() : null;
      const active = selCount ? selType === key : (b.kind === 'rack' && !b.area && (b.key || this.shelfType) === key)
        || (b.kind === 'rack' && b.area && this.shelfType === key);
      host.appendChild(this._libCard({
        icon: this._rackIcon(rt), label: rt.label,
        sub: `間口${rt.bay}×奥行${rt.depth}m・${rt.levels || 1}段・収容${rt.capacity || 0}`,
        title: rt.desc || rt.label, color: rt.color, active,
        digit: key === this.shelfType ? this._digitFor('rack') : null,
        drag: { kind: 'rack', key },
        onPick: () => this._pickRackType(key),
      }));
    });

    // --- ゾーン ---------------------------------------------------------------
    sec('ゾーン（区画）');
    for (const t of ZONE_TYPES) {
      host.appendChild(this._libCard({
        icon: this._zoneIcon(t), label: ZONE_JP[t] || t,
        sub: this._zoneDefaults(t).desc, color: ZONE_DEFAULT_COLOR[t],
        active: b.kind === 'zone' && b.key === t,
        digit: t === 'storage' ? this._digitFor('zone', 'storage') : null,
        drag: { kind: 'zone', key: t },
        onPick: () => this._setBrush({ kind: 'zone', key: t }),
      }));
    }

    // --- マテハン設備 ----------------------------------------------------------
    sec('マテハン設備');
    for (const p of EQUIP_PALETTE) {
      host.appendChild(this._libCard({
        icon: this._equipIcon(p), label: p.label,
        sub: p.w ? `${p.w}×${p.d}m` : 'ライン（頂点を描く）',
        title: p.desc || p.label, color: p.color,
        active: b.kind === 'equip' && b.key === p.key,
        digit: this._digitFor('equip', p.key),
        drag: p.key === 'conveyor' ? null : { kind: 'equip', key: p.key },
        onPick: () => this._setBrush({ kind: 'equip', key: p.key }),
      }));
    }

    // --- 躯体 ------------------------------------------------------------------
    sec('躯体（建屋）');
    host.appendChild(this._libCard({
      icon: this._wallIcon(), label: '壁', sub: '頂点をクリック・Shift=直交・W×繰返',
      active: b.kind === 'wall', digit: this._digitFor('wall'),
      onPick: () => this._setBrush({ kind: 'wall' }),
    }));
    for (const p of DOOR_PALETTE) {
      host.appendChild(this._libCard({
        icon: this._doorIcon(p), label: p.label,
        sub: p.type === 'dock' ? 'トラック接車口 (幅3m)' : p.type === 'shutter' ? '大型開口 (幅4m)' : '人の出入口 (幅1m)',
        color: p.color,
        active: b.kind === 'door' && b.key === p.type,
        digit: this._digitFor('door', p.type),
        drag: { kind: 'door', key: p.type },
        onPick: () => this._setBrush({ kind: 'door', key: p.type }),
      }));
    }
  }

  // One library card: [icon] label/sub [digit]. Draggable when opts.drag is set.
  _libCard(opts) {
    const card = document.createElement('button');
    card.type = 'button';
    card.title = opts.title || opts.label;
    card.setAttribute('aria-pressed', opts.active ? 'true' : 'false');
    const accent = opts.color || 'var(--acc)';
    card.style.cssText = 'display:flex;align-items:center;gap:7px;width:100%;box-sizing:border-box;'
      + 'text-align:left;padding:5px 7px;margin:0 0 4px;border-radius:var(--r-md);cursor:pointer;'
      + `border:2px solid ${opts.active ? accent : 'var(--line-hair)'};`
      + `background:${opts.active ? hexA(typeof accent === 'string' && accent[0] === '#' ? accent : '#39c2ff', 0.14) : 'var(--bg-app)'};`
      + 'color:var(--ink-primary);';
    card.appendChild(opts.icon);
    const txt = this._div(card, 'flex:1;min-width:0;');
    const name = this._div(txt, 'font-size:12px;font-weight:700;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
    name.textContent = opts.label;
    if (opts.sub) {
      const sub = this._div(txt, 'font-size:10px;color:var(--ink-tertiary);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;');
      sub.textContent = opts.sub;
    }
    if (opts.digit) {
      const kb = this._div(card, 'flex:0 0 auto;font-size:10px;color:var(--ink-tertiary);border:1px solid var(--line-hair);'
        + 'border-radius:4px;padding:0 4px;line-height:15px;font-variant-numeric:tabular-nums;');
      kb.textContent = String(opts.digit);
    }
    this._on(card, 'click', opts.onPick);
    // drag a card onto the canvas → place at the drop point (and arm the brush).
    if (opts.drag) {
      card.draggable = true;
      this._on(card, 'dragstart', (e) => {
        this._dragBrush = opts.drag;
        try { e.dataTransfer.setData('text/plain', JSON.stringify(opts.drag)); } catch (_e) { /* IE-ish */ }
        e.dataTransfer.effectAllowed = 'copy';
      });
      this._on(card, 'dragend', () => { this._dragBrush = null; this.hover = null; this._repaint(); });
    }
    return card;
  }

  // The canvas accepts library-card drops: dragover tracks the ghost, drop stamps.
  _bindCanvasDrop(wrap) {
    this._on(wrap, 'dragover', (e) => {
      if (!this._dragBrush) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const r = this.canvas.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      this.hover = { mx: this._mx(px), my: this._my(py), px, py, ghost: this._dragBrush };
      this._repaint();
      this._updateStatus();
    });
    this._on(wrap, 'drop', (e) => {
      if (!this._dragBrush) return;
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      const mx = this._mx(e.clientX - r.left), my = this._my(e.clientY - r.top);
      const brush = this._dragBrush;
      this._dragBrush = null;
      this._setBrush(brush);          // arm it (so repeat-placement continues)…
      this._stampAt(brush, mx, my);   // …and place this first one at the drop point.
    });
  }

  // ---- tiny library icons (top-view, canvas-drawn so they match the floor) --
  _iconCanvas(bg) {
    const W = 26, H = 22, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = document.createElement('canvas');
    c.width = W * dpr; c.height = H * dpr;
    c.style.cssText = `width:${W}px;height:${H}px;flex:0 0 auto;border-radius:3px;background:${bg};`;
    c.setAttribute('aria-hidden', 'true');
    const x = c.getContext('2d');
    x.scale(dpr, dpr);
    return [c, x, W, H];
  }
  _selIcon() {
    const [c, x, W, H] = this._iconCanvas('var(--bg-sunken)');
    // cursor arrow
    x.fillStyle = '#9aa4b0'; x.strokeStyle = '#9aa4b0'; x.lineWidth = 1.2;
    x.beginPath();
    x.moveTo(9, 4); x.lineTo(9, 16); x.lineTo(12.2, 13); x.lineTo(14.6, 18);
    x.lineTo(16.6, 17); x.lineTo(14.2, 12.2); x.lineTo(18.5, 12); x.closePath();
    x.fill();
    return c;
  }
  _zoneIcon(t) {
    const color = ZONE_DEFAULT_COLOR[t] || '#999';
    const [c, x, W, H] = this._iconCanvas(hexA(color, 0.10));
    x.fillStyle = hexA(color, 0.35); x.strokeStyle = color; x.lineWidth = 1.4;
    x.fillRect(4, 4, W - 8, H - 8); x.strokeRect(4, 4, W - 8, H - 8);
    return c;
  }
  _wallIcon() {
    const [c, x, W, H] = this._iconCanvas('var(--bg-sunken)');
    x.strokeStyle = '#8a93a0'; x.lineWidth = 3; x.lineCap = 'square';
    x.beginPath(); x.moveTo(4, H - 5); x.lineTo(4, 5); x.lineTo(W - 5, 5); x.stroke();
    return c;
  }
  _doorIcon(p) {
    const [c, x, W, H] = this._iconCanvas(hexA(p.color, 0.10));
    // wall segment with a gap + swing arc = the universal plan-view door symbol
    x.strokeStyle = '#8a93a0'; x.lineWidth = 2.4;
    x.beginPath(); x.moveTo(2, 6); x.lineTo(8, 6); x.stroke();
    x.beginPath(); x.moveTo(18, 6); x.lineTo(W - 2, 6); x.stroke();
    x.strokeStyle = p.color; x.lineWidth = 1.4;
    x.beginPath(); x.moveTo(8, 6); x.lineTo(8, 17); x.stroke();          // leaf
    x.beginPath(); x.arc(8, 6, 11, 0, Math.PI / 2); x.stroke();          // swing
    return c;
  }
  _equipIcon(p) {
    const [c, x, W, H] = this._iconCanvas(hexA(p.color, 0.10));
    x.strokeStyle = p.color; x.fillStyle = p.color; x.lineWidth = 1.4; x.lineCap = 'round';
    if (p.key === 'agv') {
      // rounded chassis + 2 wheels + heading notch
      x.globalAlpha = 0.9; x.strokeRect(5, 7, W - 10, H - 13);
      x.globalAlpha = 0.5; x.fillRect(7, H - 5.4, 4, 2); x.fillRect(W - 11, H - 5.4, 4, 2);
      x.globalAlpha = 1;
      x.beginPath(); x.moveTo(W - 5, H / 2 - 2.5); x.lineTo(W - 2.4, H / 2); x.lineTo(W - 5, H / 2 + 2.5); x.closePath(); x.fill();
    } else if (p.key === 'conveyor') {
      // belt with rollers
      x.strokeRect(3, 8, W - 6, 6);
      x.globalAlpha = 0.7;
      for (let cx = 6; cx < W - 4; cx += 4) { x.beginPath(); x.arc(cx, 11, 1.2, 0, 7); x.stroke(); }
      x.globalAlpha = 1;
    } else if (p.key === 'asrs') {
      // high-bay block + crane aisle
      x.globalAlpha = 0.9; x.strokeRect(4, 4, 7, H - 8); x.strokeRect(W - 11, 4, 7, H - 8);
      x.setLineDash([2, 2]); x.beginPath(); x.moveTo(W / 2, 4); x.lineTo(W / 2, H - 4); x.stroke(); x.setLineDash([]);
      x.globalAlpha = 1;
    } else if (p.key === 'station') {
      // work bench: table top + legs
      x.strokeRect(4, 7, W - 8, 7);
      x.beginPath(); x.moveTo(6, 14); x.lineTo(6, 18); x.moveTo(W - 6, 14); x.lineTo(W - 6, 18); x.stroke();
    } else if (p.key === 'robot_arm') {
      // base + articulated arm
      x.beginPath(); x.arc(8, H - 7, 3.4, 0, 7); x.fill();
      x.lineWidth = 2.2;
      x.beginPath(); x.moveTo(8, H - 7); x.lineTo(14, 8); x.lineTo(20, 11); x.stroke();
      x.lineWidth = 1.4;
      x.beginPath(); x.arc(20.5, 11.2, 1.8, 0, 7); x.stroke();
    } else { // crane
      // gantry: two rails + trolley hook
      x.beginPath(); x.moveTo(4, 6); x.lineTo(W - 4, 6); x.moveTo(4, H - 6); x.lineTo(W - 4, H - 6); x.stroke();
      x.lineWidth = 2.4; x.beginPath(); x.moveTo(W / 2, 6); x.lineTo(W / 2, H - 6); x.stroke();
      x.lineWidth = 1.4; x.beginPath(); x.arc(W / 2, H / 2, 2, 0, 7); x.stroke();
    }
    return c;
  }

  // Zone-brush defaults: footprint + a one-line description for the card.
  _zoneDefaults(t) {
    const p = LAYOUT_PALETTE.find((q) => q.zoneType === t);
    const base = { w: p ? p.w : 10, h: p ? p.h : 6 };
    const desc = {
      receiving: '入荷・検品の区画', storage: '棚の容れ物（保管区画）',
      picking: 'ピッキング区画', packing: '梱包・出荷検品の区画',
      shipping: '出荷バース前の区画', staging: '一時保管・仮置きの区画',
    }[t] || '';
    return { ...base, desc: `${desc}（${base.w}×${base.h}m）` };
  }

  // The homogeneous rack_type of the current selection, or null if mixed/empty.
  _selectionRackType() {
    const objs = this._selShelfObjs();
    if (!objs.length) return null;
    const t = objs[0].sh.rack_type;
    return objs.every(({ sh }) => sh.rack_type === t) ? t : null;
  }

  // Pick a rack type from the library. If shelves are selected, re-assign their
  // rack_type (undoable, re-fits cells via the save→materialize path); otherwise
  // arm the rack brush with that type and refresh the bulk/area defaults.
  _pickRackType(key) {
    if (!RACK_TYPES[key]) return;
    if (this.selShelves && this.selShelves.size) {
      this._assignRackTypeToSelection(key);
      return;
    }
    this.shelfType = key;
    this._syncRackDefaults(key);
    this._setBrush({ kind: 'rack', key });
  }

  // Re-assign the active rack_type to every selected shelf (M3 deliverable #4).
  // Cells re-fit on save (materialize_racks reads rack_type), so the 2D colour
  // and 3D geometry both update; we also nudge the active type for subsequent draws.
  _assignRackTypeToSelection(key) {
    const objs = this._selShelfObjs();
    if (!objs.length) { this.shelfType = key; this._renderTool(); return; }
    this._pushUndo();
    objs.forEach(({ sh }) => {
      sh.rack_type = key;
      // drop any stale explicit cell pitch so cells re-fit at the new type's pitch.
      delete sh.cell_w; delete sh.cell_d;
    });
    this.shelfType = key;
    this._syncRackDefaults(key);
    if (this._layoutStatus) {
      this._layoutStatus.style.color = 'var(--ink-secondary)';
      this._layoutStatus.textContent = `${objs.length} 棚を「${RACK_TYPES[key].label}」に変更しました。`;
    }
    this._renderTool();
  }

  // M3 deliverable #2: when the active type changes, refresh the bulk-gen and
  // area-fill dialogs' 間口幅・奥行き so they propose this preset's bay×depth (mm).
  // The user can still override inside the dialog; we only touch the cached
  // dimension fields (not face/count/prefix/aisle preferences).
  _syncRackDefaults(key) {
    const rt = RACK_TYPES[key] || RACK_TYPES.medium;
    if (this._bulkPrefs) {
      this._bulkPrefs.frontage = Math.round(rt.bay * 1000);
      this._bulkPrefs.depth = Math.round(rt.depth * 1000);
    }
    if (this._areaPrefs) {
      this._areaPrefs.front = Math.round(rt.bay * 1000);
      this._areaPrefs.depth = Math.round(rt.depth * 1000);
    }
  }

  // ---- tiny 2D silhouette icon (24×20) hinting the rack's 3D form -----------
  // Drawn on a small canvas so it scales crisply and matches view3d.js families:
  //   shelving  — horizontal shelf boards (light/medium)
  //   pallet    — orange load beams + a pallet unit (signature pallet rack)
  //   nestainer — stacked nesting frames (段積み)
  //   flow      — inclined roller lanes (FIFO flow)
  //   asrs      — tall uprights + a crane column (high-bay AS/RS)
  _rackIcon(rt) {
    const W = 26, H = 22, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = document.createElement('canvas');
    c.width = W * dpr; c.height = H * dpr;
    c.style.cssText = `width:${W}px;height:${H}px;flex:0 0 auto;border-radius:3px;background:${hexA(rt.color, 0.12)};`;
    c.setAttribute('aria-hidden', 'true');
    const x = c.getContext('2d');
    x.scale(dpr, dpr);
    x.strokeStyle = rt.color; x.fillStyle = rt.color; x.lineWidth = 1.2; x.lineCap = 'round';
    const sil = rt.silhouette || RACK_SILHOUETTE_FALLBACK;
    const frame = () => { x.globalAlpha = 0.9; x.strokeRect(4, 3, W - 8, H - 6); x.globalAlpha = 1; };
    if (sil === 'pallet') {
      // two uprights + 2 thick (beam) shelves, a pallet block on the lower beam.
      frame();
      x.lineWidth = 2.2;
      for (const yy of [9, 15]) { x.beginPath(); x.moveTo(4, yy); x.lineTo(W - 4, yy); x.stroke(); }
      x.lineWidth = 1.2; x.globalAlpha = 0.55;
      x.fillRect(8, 15.5, 9, 3.2);           // pallet load on bottom beam
      x.globalAlpha = 1;
    } else if (sil === 'flow') {
      // inclined roller lanes (diagonal lines) → FIFO flow rack.
      frame();
      x.globalAlpha = 0.85;
      for (const yy of [7, 12, 17]) { x.beginPath(); x.moveTo(5, yy); x.lineTo(W - 5, yy - 3); x.stroke(); }
      x.globalAlpha = 1;
    } else if (sil === 'nestainer') {
      // stacked nesting frames: three trapezoid-ish stacked boxes.
      x.globalAlpha = 0.9;
      for (const yy of [4, 10, 16]) { x.strokeRect(6, yy, W - 12, 4.6); }
      x.globalAlpha = 1;
    } else if (sil === 'asrs') {
      // tall uprights + many tiers + a crane column on the left (high-bay).
      x.globalAlpha = 0.9; x.strokeRect(8, 2, W - 12, H - 4);
      for (let yy = 5; yy < H - 3; yy += 3.5) { x.beginPath(); x.moveTo(8, yy); x.lineTo(W - 4, yy); x.stroke(); }
      x.lineWidth = 2.2; x.beginPath(); x.moveTo(4, 2); x.lineTo(4, H - 2); x.stroke();  // crane mast
      x.lineWidth = 1.2; x.globalAlpha = 1;
    } else {
      // shelving (light/medium): frame + evenly spaced horizontal boards.
      frame();
      x.globalAlpha = 0.85;
      for (const yy of [8, 12, 16]) { x.beginPath(); x.moveTo(5, yy); x.lineTo(W - 5, yy); x.stroke(); }
      x.globalAlpha = 1;
    }
    return c;
  }

  _storageZones() {
    return (this.model.layout.zones || []).filter((z) => z.type === 'storage');
  }
  _activeStoreZone() {
    const stores = this._storageZones();
    if (!stores.length) return null;
    return stores.find((z) => z.id === this.shelfZoneId) || stores[0];
  }
  _allShelves() {
    // [{zone, sh}] across all storage zones (for snapping + drawing).
    const out = [];
    for (const z of this._storageZones()) for (const sh of (z.shelves || [])) out.push({ zone: z, sh });
    return out;
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
    if (!this.routeMode) this.routeMode = 'measure';   // 'measure' | 'draw'
    if (this.routeNetOn == null) this.routeNetOn = true;
    // left column: control bar above the floor canvas
    const left = document.createElement('div');
    left.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;';

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;border:1px solid var(--line-hair);border-radius:var(--r-md);background:var(--bg-sunken);';
    // mode: A→B計測 (auto shortest path) vs 手動で描く (legacy free polyline)
    for (const [m, label, tip] of [
      ['measure', 'A→B計測', '2点をクリックすると、壁・棚を迂回した最短経路と距離/時間を自動計算'],
      ['draw', '手動で描く', '床をクリックで頂点追加、ダブルクリックで確定（自由線）'],
    ]) {
      const b = this._btn(bar, label, () => {
        this.routeMode = m;
        this.routeDraft = null;
        this._measureA = this._measureB = this._measurePath = null;
        this.selected = null;
        this._renderRoute();
      });
      b.title = tip;
      if (this.routeMode === m) b.style.cssText += ';background:var(--ink-primary);color:var(--bg-app);border-color:var(--ink-primary);font-weight:700;';
    }
    // mover selector + speed (used by 計測の時間換算 and by new manual routes)
    const moverSel = this._select(bar, MOVER_OPTS, this.routeMover);
    this._on(moverSel, 'change', () => {
      this.routeMover = moverSel.value;
      this.routeSpeed = MOVER_SPEED[this.routeMover] || 1.2;
      this._renderRoute();
    });
    const spLbl = document.createElement('span');
    spLbl.textContent = '速度(m/s)';
    spLbl.style.cssText = 'font-size:12px;color:var(--ink-secondary);';
    bar.appendChild(spLbl);
    const spInp = this._num(this.routeSpeed, (v) => { this.routeSpeed = Math.max(0.1, v); this._renderRouteTable(); }, 0.1);
    spInp.style.cssText += ';width:70px;padding:5px 7px;border:1px solid var(--line-hair);border-radius:var(--r-sm);font-size:13px;background:var(--bg-app);color:var(--ink-primary);transition:border-color var(--dur-1) var(--ease-out);';
    bar.appendChild(spInp);
    if (this.routeMode === 'draw') {
      this._btn(bar, '新規ルート', () => {
        if (this.routeDraft && this.routeDraft.length >= 2) this._finishRoute();
        this.routeDraft = [];
        this.selected = null;
        this._renderRoute();
      });
      this._btn(bar, '確定', () => this._finishRoute());
    }
    this._btn(bar, '削除', () => this._deleteSelectedRoute(), 'color:var(--bad);');
    const spacer2 = document.createElement('div'); spacer2.style.flex = '1'; bar.appendChild(spacer2);
    // 工程フロー動線: auto-generate routes along the process flow (one per leg)
    const genBtn = this._btn(bar, '工程フロー動線を自動生成', () => this._genFlowRoutes());
    genBtn.title = '入荷→…→出荷の各工程間の最短経路を自動計算し、動線として一括作成します';
    genBtn.className = 'primary';
    // 通路ネットワーク display toggle
    const netLbl = document.createElement('label');
    netLbl.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;color:var(--ink-secondary);cursor:pointer;';
    const netCb = document.createElement('input');
    netCb.type = 'checkbox';
    netCb.checked = !!this.routeNetOn;
    this._on(netCb, 'change', () => { this.routeNetOn = netCb.checked; this._drawCanvas(); });
    netLbl.appendChild(netCb);
    netLbl.appendChild(document.createTextNode('通路網'));
    bar.appendChild(netLbl);
    left.appendChild(bar);

    // floor canvas
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;min-height:0;position:relative;border:1px solid var(--line-hair);border-radius:var(--r-md);background:var(--bg-app);overflow:hidden;';
    wrap.classList.add('dz-canvas-wrap');
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:crosshair;';
    wrap.appendChild(this.canvas);
    left.appendChild(wrap);
    this.body.appendChild(left);

    // right column: live 動線一覧 table
    this.side = document.createElement('div');
    this.side.style.cssText = 'width:300px;flex:0 0 300px;overflow-y:auto;border:1px solid var(--line-hair);border-radius:var(--r-md);background:var(--bg-sunken);padding:10px;';
    this.side.classList.add('dz-enter');
    this.body.appendChild(this.side);

    this.ctx = this.canvas.getContext('2d');
    this._bindCanvas();
    this._fitCanvas();
    this._renderRouteTable();
    this._drawCanvas();
    // fetch the walkable lane network for the CURRENT (possibly unsaved) layout.
    this._fetchRouteNet();
  }

  // ---- 経路ネットワーク自動生成 (engine.graph as a service) -------------------
  // The 動線 tab routes with the SAME AisleGraph the simulation uses, via the
  // stateless POST /api/routes/network — so drawn 動線 and simulated travel agree.
  _routeLayoutPayload() {
    const L = this.model.layout;
    const shelves = [];
    for (const z of L.zones || []) {
      if (z.type !== 'storage') continue;
      for (const sh of z.shelves || []) shelves.push([sh.x, sh.y, sh.w, sh.h]);
    }
    return {
      bounds: { width: L.bounds.width, depth: L.bounds.depth },
      walls: (L.walls || []).map((w) => ({ points: w.points || [] })),
      shelves,
    };
  }

  async _fetchRouteNet() {
    if (this._routeNetBusy) return;
    this._routeNetBusy = true;
    try {
      const res = await fetch('/api/routes/network', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...this._routeLayoutPayload(), include_edges: true }),
      });
      if (res.ok) {
        this.routeNet = await res.json();
        if (this.tool === 'route') this._drawCanvas();
      }
    } catch (_e) { /* offline: the tab still works for manual drawing */ }
    this._routeNetBusy = false;
  }

  // A→B計測: ask the server for the wall/棚-aware shortest path between 2 points.
  async _measureQuery() {
    if (!this._measureA || !this._measureB) return;
    try {
      const res = await fetch('/api/routes/network', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...this._routeLayoutPayload(),
          queries: [{ a: this._measureA, b: this._measureB }],
        }),
      });
      if (res.ok) {
        const d = await res.json();
        this._measurePath = (d.paths && d.paths[0]) || null;
        this._renderRouteTable();
        this._drawCanvas();
      }
    } catch (_e) { /* leave the markers; user can retry */ }
  }

  // 工程フロー動線を自動生成: shortest path for every consecutive flow leg whose
  // stages are both bound to zones; existing auto legs are replaced (re-runnable).
  async _genFlowRoutes() {
    const stages = this._orderedStages().filter((st) => st.zone && this._zoneById(st.zone));
    const legs = [];
    for (let i = 0; i < stages.length - 1; i++) {
      const a = this._zoneCenter(this._zoneById(stages[i].zone));
      const b = this._zoneCenter(this._zoneById(stages[i + 1].zone));
      legs.push({ from: stages[i], to: stages[i + 1], a, b });
    }
    if (!legs.length) {
      this._renderRouteTable();
      if (this.side) this._note(this.side, '工程にゾーンが割り当てられていません。フロータブの「床図でフロー配置」で工程→ゾーンを割り当ててください。');
      return;
    }
    try {
      const res = await fetch('/api/routes/network', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...this._routeLayoutPayload(),
          queries: legs.map((l) => ({ a: l.a, b: l.b })),
        }),
      });
      if (!res.ok) return;
      const d = await res.json();
      this._pushUndo();
      // replace previous auto-generated legs, keep hand-drawn routes untouched.
      this.model.routes = (this.model.routes || []).filter((r) => !String(r.id).startsWith('autoflow'));
      d.paths.forEach((p, i) => {
        const leg = legs[i];
        if (!leg || !p || !(p.points || []).length) return;
        // 格納 leg is typically forklift work; everything else walks.
        const mover = (leg.to.id === 'putaway' || leg.from.id === 'putaway') ? 'forklift' : 'person';
        this.model.routes.push({
          id: `autoflow_${leg.from.id}_${leg.to.id}`,
          name: `${leg.from.label || leg.from.id}→${leg.to.label || leg.to.id}`,
          mover, speed_mps: MOVER_SPEED[mover] || 1.2,
          points: p.points,
        });
      });
      this.selected = null;
      this._renderRouteTable();
      this._drawCanvas();
    } catch (_e) { /* network down: nothing generated, nothing destroyed */ }
  }

  // save the current A→B measurement as a persistent route (shows in 2D/3D).
  _saveMeasureAsRoute() {
    const p = this._measurePath;
    if (!p || !(p.points || []).length) return;
    this._pushUndo();
    const n = (this.model.routes || []).filter((r) => String(r.id).startsWith('measure')).length + 1;
    this.model.routes.push({
      id: uid('measure'),
      name: `計測${n}`,
      mover: this.routeMover,
      speed_mps: Math.max(0.1, +this.routeSpeed || MOVER_SPEED[this.routeMover] || 1.2),
      points: p.points,
    });
    this._measureA = this._measureB = this._measurePath = null;
    this._renderRouteTable();
    this._drawCanvas();
  }

  // A→B計測 overlay: A/B pins + the computed wall/棚-aware shortest path.
  _drawMeasure() {
    if (this.routeMode !== 'measure') return;
    const ctx = this.ctx;
    const pin = (pt, color, label) => {
      const x = this._X(pt[0]), y = this._Y(pt[1]);
      ctx.fillStyle = color;
      ctx.strokeStyle = this.pal.markerStroke; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, x, y + 0.5);
    };
    const p = this._measurePath;
    if (p && Array.isArray(p.points) && p.points.length >= 2) {
      ctx.save();
      ctx.strokeStyle = this.pal.accent; ctx.lineWidth = 3.5;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.setLineDash([9, 6]);
      ctx.beginPath();
      ctx.moveTo(this._X(p.points[0][0]), this._Y(p.points[0][1]));
      for (let i = 1; i < p.points.length; i++) ctx.lineTo(this._X(p.points[i][0]), this._Y(p.points[i][1]));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      const mid = p.points[Math.floor(p.points.length / 2)];
      const t = p.distance_m / Math.max(0.1, +this.routeSpeed || 1.2);
      this._label(this._X(mid[0]), this._Y(mid[1]) - 14, `${p.distance_m.toFixed(1)} m / ${t.toFixed(0)} 秒`);
    }
    if (this._measureA) pin(this._measureA, '#1db954', 'A');
    if (this._measureB) pin(this._measureB, '#e3401c', 'B');
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

    // A→B計測 panel (auto shortest-path measurement)
    if (this.routeMode === 'measure') {
      this._h(s, 'A→B計測');
      if (!this._measureA) {
        this._note(s, '床をクリックして始点Aを置いてください。壁・棚を迂回した最短経路を自動計算します。');
      } else if (!this._measureB) {
        this._note(s, '次に終点Bをクリックしてください。');
      } else if (this._measurePath) {
        const p = this._measurePath;
        const t = p.distance_m / Math.max(0.1, +this.routeSpeed || 1.2);
        const box = this._div(s, 'padding:8px 10px;border:1px solid var(--line-strong);border-radius:var(--r-md);'
          + 'background:var(--bg-app);margin-bottom:8px;font-variant-numeric:tabular-nums;');
        box.innerHTML = `<div style="font-size:18px;font-weight:700;">${p.distance_m.toFixed(1)} m</div>`
          + `<div style="font-size:12px;color:var(--ink-secondary);">${MOVER_JP[this.routeMover] || this.routeMover}`
          + ` ${(+this.routeSpeed).toFixed(1)} m/s → 約 ${t.toFixed(0)} 秒</div>`;
        this._btn(s, '動線として保存', () => this._saveMeasureAsRoute(), 'margin-bottom:8px;');
        this._note(s, 'もう一度クリックすると新しいAから測り直します。');
      } else {
        this._note(s, '経路を計算中…');
      }
    }

    this._h(s, '動線一覧');
    this._note(s, this.routeMode === 'measure'
      ? '「工程フロー動線を自動生成」で入荷→…→出荷の経路を一括作成。行をクリックで選択。'
      : '床をクリックで頂点追加、ダブルクリックか「確定」で完了。ルート付近をクリックで選択。');

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

    // A→B計測 mode: 1st click = A, 2nd = B (auto-route), 3rd starts over.
    if (this.routeMode === 'measure') {
      // a click near an existing route still selects it (so 削除 works here too)
      const hit = this._routeHit(px, py);
      if (hit) {
        this.selected = { kind: 'route', id: hit.id };
        this._renderRouteTable(); this._drawCanvas();
        return;
      }
      if (!inside) return;
      if (!this._measureA || this._measureB) {
        this._measureA = [mx, my];
        this._measureB = null;
        this._measurePath = null;
      } else {
        this._measureB = [mx, my];
        this._measureQuery();         // async; draws when the path returns
      }
      this._renderRouteTable(); this._drawCanvas();
      return;
    }

    // 手動で描く mode (legacy free polyline)
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
  // The view is the *fit* scale (whole floor in the viewport) multiplied by the
  // camera zoom, panned so the camera center (_cam.cx,cy in meters) maps to the
  // viewport center. cx/cy=null falls back to the floor center, so an unzoomed
  // camera is byte-identical to the old fit-to-bounds behaviour.
  _fitCanvas() {
    if (!this.canvas) return;
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, r.width * dpr);
    this.canvas.height = Math.max(1, r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = r.width, h = r.height, pad = 18;
    const b = this.model.layout.bounds;
    const fit = Math.min((w - 2 * pad) / b.width, (h - 2 * pad) / b.depth) || 1;
    const zoom = Math.max(0.2, this._cam.zoom || 1);
    const sc = fit * zoom;
    const cx = this._cam.cx == null ? b.width / 2 : this._cam.cx;
    const cy = this._cam.cy == null ? b.depth / 2 : this._cam.cy;
    // ox/oy place the camera center at the viewport center.
    //   _X(cx) === w/2  =>  ox = w/2 - cx*sc
    //   _Y(cy) === h/2  =>  oy = h - cy*sc - h/2   (since _Y(y) = h - oy - y*sc)
    this._view = {
      w, h, sc, fit,
      ox: w / 2 - cx * sc,
      oy: h - cy * sc - h / 2,
    };
  }
  _X(x) { return this._view.ox + x * this._view.sc; }
  _Y(y) { return this._view.h - this._view.oy - y * this._view.sc; }      // flip y
  _mx(px) { return (px - this._view.ox) / this._view.sc; }                // px -> meters x
  _my(py) { return (this._view.h - this._view.oy - py) / this._view.sc; } // px -> meters y

  // ---- M2 smooth pan/zoom (camera interpolation) ---------------------------
  // Honour the imported view{centerX,centerY,zoom} once if the model carries it.
  _adoptModelView() {
    const v = this.model.layout && this.model.layout.view;
    if (v && (v.centerX != null || v.centerY != null || v.zoom != null)) {
      const b = this.model.layout.bounds;
      this._cam = {
        cx: v.centerX == null ? b.width / 2 : +v.centerX,
        cy: v.centerY == null ? b.depth / 2 : +v.centerY,
        zoom: Math.max(0.2, +v.zoom || 1),
      };
      this._camGoal = { ...this._cam };
    }
  }
  // Ease _cam → _camGoal over rAF (exponential smoothing ≈ "スルスル"). Stops
  // when within an epsilon. Under prefers-reduced-motion we snap instantly.
  _animateCamera() {
    if (this._reducedMotion()) {
      this._cam = { ...this._camGoal };
      this._fitCanvas();
      this._repaint();
      return;
    }
    if (this._camRaf) return;  // already animating
    const step = () => {
      this._camRaf = 0;
      const c = this._cam, g = this._camGoal;
      const b = this.model.layout.bounds;
      const cx = c.cx == null ? b.width / 2 : c.cx;
      const cy = c.cy == null ? b.depth / 2 : c.cy;
      const gx = g.cx == null ? b.width / 2 : g.cx;
      const gy = g.cy == null ? b.depth / 2 : g.cy;
      const k = 0.22;  // easing factor per frame
      const nx = cx + (gx - cx) * k;
      const ny = cy + (gy - cy) * k;
      const nz = c.zoom + (g.zoom - c.zoom) * k;
      const done = Math.abs(gx - nx) < 0.01 && Math.abs(gy - ny) < 0.01
        && Math.abs(g.zoom - nz) < 0.001;
      this._cam = done ? { ...g } : { cx: nx, cy: ny, zoom: nz };
      this._fitCanvas();
      this._repaint();
      if (!done) this._camRaf = requestAnimationFrame(step);
    };
    this._camRaf = requestAnimationFrame(step);
  }
  _reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  // Repaint whichever canvas tool is active (flow has its own draw routine).
  _repaint() {
    if (this.tool === 'flow') this._drawFlowCanvas();
    else if (this.ctx) this._drawCanvas();
  }
  // Set the zoom goal around a screen anchor (keep the world point under the
  // cursor fixed), then animate. Used by the wheel handler.
  _zoomAt(px, py, factor) {
    const b = this.model.layout.bounds;
    const wx = this._mx(px), wy = this._my(py);
    const cur = this._cam.zoom || 1;
    const next = clamp(cur * factor, 0.3, 12);
    // After zooming, choose cx/cy so (wx,wy) stays under (px,py).
    // viewport center maps to camera center; offset of cursor from center scales.
    const v = this._view;
    const dxMeters = (px - v.w / 2) / (v.fit * next);
    const dyMeters = (v.h / 2 - py) / (v.fit * next);
    this._camGoal = {
      cx: clamp(wx - dxMeters, 0, b.width),
      cy: clamp(wy - dyMeters, 0, b.depth),
      zoom: next,
    };
    this._animateCamera();
    this._updateStatus();   // live 倍率 readout in the status bar
  }
  // Zoom-to-fit: recenter the floor and reset zoom to 1, animated.
  _zoomToFit() {
    const b = this.model.layout.bounds;
    this._camGoal = { cx: b.width / 2, cy: b.depth / 2, zoom: 1 };
    this._animateCamera();
  }

  // ---- drawing -------------------------------------------------------------
  _drawCanvas() {
    if (!this.ctx) return;
    const ctx = this.ctx, { w, h, sc } = this._view;
    const P = this.pal;
    const b = this.model.layout.bounds;
    ctx.clearRect(0, 0, w, h);
    // dim canvas fill in dark mode (transparent in light → parent --bg-app shows)
    if (P.bg && P.bg !== 'transparent') { ctx.fillStyle = P.bg; ctx.fillRect(0, 0, w, h); }

    // CAD grid: 1m minor / 5m major lines, faded with zoom so the floor never
    // turns into noise. The grid is what makes snapping *visible* and the sheet
    // feel like an engineering drawing instead of a blank page.
    this._drawGrid();

    // floor
    ctx.strokeStyle = P.shell; ctx.lineWidth = 1.5;
    ctx.strokeRect(this._X(0), this._Y(b.depth), b.width * sc, b.depth * sc);

    // DXF underlay: imported walls as a faint gray trace beneath everything so
    // the user can trace over the building outline.
    if (this.tool === 'place' && this.showUnderlay) {
      const walls = this.model.layout.walls || [];
      if (walls.length) {
        ctx.save();
        ctx.globalAlpha = 0.28;
        for (const w of walls) this._drawWall(w.points, w.thickness, false, false);
        ctx.restore();
      }
    }

    const dim = this.tool === 'route';   // zones rendered faintly under routes
    for (const z of this.model.layout.zones) {
      const sel = this.tool === 'place' && this.selected && this.selected.kind === 'zone' && this.selected.id === z.id;
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
      // resize handle + live size badge when selected
      if (sel) {
        ctx.fillStyle = P.sel;
        ctx.fillRect(this._X(z.x + z.w) - HANDLE, this._Y(z.y) - HANDLE, HANDLE, HANDLE);
        this._sizeBadge(z);
      }
    }

    // walls + doors — ALWAYS drawn at full strength in the 配置 tool (the old
    // per-tab hiding made the floor look different per tab, which read as bugs).
    if (this.tool === 'place') {
      for (const w of this.model.layout.walls) this._drawWall(w.points, w.thickness, this._isSel('wall', w.id), false);
      if (this.wallDraft) this._drawWallDraft();
      for (const d of this.model.layout.doors) this._drawDoor(d, this._isSel('door', d.id));
    }

    // conveyors (under equipment glyphs)
    for (const cv of this.model.resources.conveyors) this._drawConveyor(cv.points, '#33a02c', false);
    if (this.conveyorDraft) this._drawConveyorDraft();

    // equipment + stations as CAD-style top-view glyphs (real-meter footprints)
    for (const e of this.model.resources.equipment) {
      this._drawEquipGlyph(e, this._isSel('equip', e.id));
    }
    for (const s of this.model.resources.stations) {
      this._drawStationGlyph(s, this._isSel('station', s.id));
    }

    // 動線 tool: walkable lane network + walls for context + route polylines
    if (this.tool === 'route') {
      // auto-generated 通路ネットワーク (faint lattice: aisles read as corridors,
      // walls/shelves as holes) — the same graph the simulation routes on.
      if (this.routeNetOn && this.routeNet && Array.isArray(this.routeNet.edges)) {
        ctx.save();
        ctx.strokeStyle = P.accent;
        ctx.globalAlpha = 0.13;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const [x1, y1, x2, y2] of this.routeNet.edges) {
          ctx.moveTo(this._X(x1), this._Y(y1));
          ctx.lineTo(this._X(x2), this._Y(y2));
        }
        ctx.stroke();
        ctx.restore();
      }
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
      // A→B計測 overlay: endpoint markers + the computed shortest path.
      this._drawMeasure();
    }

    // placement ghost: the armed brush's real footprint under the cursor.
    if (this.tool === 'place') this._drawGhost();

    // Figma-flavoured selection chrome (additive overlay; reads state only).
    this._drawSelectionChrome();
    // M2 shelf editor chrome (bbox + control points + snap guides + draft rect).
    this._drawShelfChrome();
  }

  // ---- CAD grid (1m minor, 5m major) ----------------------------------------
  _drawGrid() {
    const ctx = this.ctx, { sc } = this._view;
    const b = this.model.layout.bounds;
    if (sc < 2.5) return;                       // zoomed way out: skip the noise
    const x0 = this._X(0), x1 = this._X(b.width);
    const yTop = this._Y(b.depth), yBot = this._Y(0);
    const minorA = Math.min(0.5, Math.max(0, (sc - 2.5) / 30));  // fade in with zoom
    ctx.save();
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= b.width + 1e-6; gx += 1) {
      const major = gx % 5 === 0;
      if (!major && sc < 6) continue;           // minor lines only when close
      ctx.strokeStyle = this.pal.grid || 'rgba(128,140,160,0.18)';
      ctx.globalAlpha = major ? Math.min(0.5, minorA * 2.2) : minorA;
      const X = this._X(gx);
      ctx.beginPath(); ctx.moveTo(X, yTop); ctx.lineTo(X, yBot); ctx.stroke();
    }
    for (let gy = 0; gy <= b.depth + 1e-6; gy += 1) {
      const major = gy % 5 === 0;
      if (!major && sc < 6) continue;
      ctx.strokeStyle = this.pal.grid || 'rgba(128,140,160,0.18)';
      ctx.globalAlpha = major ? Math.min(0.5, minorA * 2.2) : minorA;
      const Y = this._Y(gy);
      ctx.beginPath(); ctx.moveTo(x0, Y); ctx.lineTo(x1, Y); ctx.stroke();
    }
    ctx.restore();
  }

  // ---- placement ghost (real footprint under the cursor) --------------------
  _drawGhost() {
    const hov = this.hover;
    const brush = (hov && hov.ghost) || this.brush;
    if (!hov || !brush || brush.kind === 'select') return;
    if (this.drag) return;                       // mid-drag drafts draw themselves
    const ctx = this.ctx, { sc } = this._view;
    const b = this.model.layout.bounds;
    const inside = hov.mx >= 0 && hov.mx <= b.width && hov.my >= 0 && hov.my <= b.depth;
    if (!inside && brush.kind !== 'wall') return;
    // live area-semantics feedback: an invalid spot draws the ghost in the
    // warning colour with the reason, BEFORE the user clicks into an error.
    const chk = this._placeCheck(brush, hov.mx, hov.my);
    ctx.save();
    ctx.globalAlpha = 0.55;
    if (brush.kind === 'rack' && !brush.area) {
      const rt = RACK_TYPES[brush.key || this.shelfType] || RACK_TYPES.medium;
      let x = hov.mx - rt.bay / 2, y = hov.my - rt.depth / 2;
      if (!this.noSnap) {
        const hints = this._snapHints(null);
        const sx = this._snapWorldX(x, hints), sx2 = this._snapWorldX(x + rt.bay, hints);
        if (sx != null) x = sx; else if (sx2 != null) x = sx2 - rt.bay;
        const sy = this._snapWorldY(y, hints), sy2 = this._snapWorldY(y + rt.depth, hints);
        if (sy != null) y = sy; else if (sy2 != null) y = sy2 - rt.depth;
      }
      x = clamp(x, 0, b.width - rt.bay); y = clamp(y, 0, b.depth - rt.depth);
      const col = chk.ok ? rt.color : this.pal.draft;
      ctx.fillStyle = hexA(col[0] === '#' ? col : '#e31a1c', 0.4);
      ctx.strokeStyle = col; ctx.lineWidth = 1.6;
      ctx.fillRect(this._X(x), this._Y(y + rt.depth), rt.bay * sc, rt.depth * sc);
      ctx.strokeRect(this._X(x), this._Y(y + rt.depth), rt.bay * sc, rt.depth * sc);
      ctx.globalAlpha = 1;
      this._label(this._X(x + rt.bay / 2), this._Y(y + rt.depth) - 9,
        chk.ok ? `${rt.label} ${rt.bay}×${rt.depth}m` : `⚠ ${chk.reason}`);
    } else if (brush.kind === 'rack' && brush.area) {
      // area brush: crosshair hint only (the rectangle appears on drag).
      ctx.strokeStyle = this.pal.draft; ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(hov.px - 14, hov.py); ctx.lineTo(hov.px + 14, hov.py); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hov.px, hov.py - 14); ctx.lineTo(hov.px, hov.py + 14); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      this._label(hov.px, hov.py - 16, 'ドラッグで範囲を指定 → 棚列を自動配置');
    } else if (brush.kind === 'zone') {
      const d = this._zoneDefaults(brush.key);
      const w = Math.min(d.w, b.width), hh = Math.min(d.h, b.depth);
      const x = clamp(snap(hov.mx - w / 2), 0, Math.max(0, b.width - w));
      const y = clamp(snap(hov.my - hh / 2), 0, Math.max(0, b.depth - hh));
      const color = ZONE_DEFAULT_COLOR[brush.key] || '#999';
      ctx.fillStyle = hexA(color, 0.25); ctx.strokeStyle = color; ctx.lineWidth = 1.6;
      ctx.setLineDash([6, 4]);
      ctx.fillRect(this._X(x), this._Y(y + hh), w * sc, hh * sc);
      ctx.strokeRect(this._X(x), this._Y(y + hh), w * sc, hh * sc);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      this._label(this._X(x + w / 2), this._Y(y + hh) - 9, `${ZONE_JP[brush.key] || brush.key} ${w}×${hh}m`);
    } else if (brush.kind === 'equip') {
      const p = EQUIP_PALETTE.find((q) => q.key === brush.key);
      if (p && p.key !== 'conveyor') {
        const mx = snap(hov.mx), my = snap(hov.my);
        if (p.key === 'station') this._drawStationGlyph({ x: mx, y: my }, false, true);
        else this._drawEquipGlyph({ type: p.key, x: mx, y: my, count: '' }, false, true);
        if (!chk.ok) {
          // warning ring over the ghost: this spot rejects this equipment.
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = this.pal.draft; ctx.lineWidth = 2;
          const rPx = (Math.max(p.w || 1.2, p.d || 0.9) / 2) * sc + 8;
          ctx.beginPath(); ctx.arc(this._X(mx), this._Y(my), Math.max(rPx, 16), 0, 7); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        this._label(this._X(mx), this._Y(my) - (Math.max(p.d || 1, 0.8) / 2) * sc - 9,
          chk.ok ? `${p.label} ${p.w}×${p.d}m` : `⚠ ${chk.reason}`);
      } else if (p) {
        // conveyor: rubber segment from the draft's last vertex to the cursor.
        this._drawPolyGhost(this.conveyorDraft, p.color);
      }
    } else if (brush.kind === 'door') {
      const p = DOOR_PALETTE.find((q) => q.type === brush.key) || DOOR_PALETTE[0];
      // the ghost previews the SNAPPED position (on the envelope), so what you
      // see is exactly what a click will produce.
      const pos = this._snapDoorPos(hov.mx, hov.my);
      this._drawDoor({ type: p.type, x: pos.x, y: pos.y, w: p.type === 'dock' ? 3 : p.type === 'shutter' ? 4 : 1 }, false);
      ctx.globalAlpha = 1;
      this._label(this._X(pos.x), this._Y(pos.y) - 14, DOOR_JP[p.type] || 'ドア');
    } else if (brush.kind === 'wall') {
      this._drawPolyGhost(this.wallDraft, this.pal.draft, true);
    }
    ctx.restore();
  }

  // rubber-band segment from a draft polyline's last vertex to the cursor, with
  // a live length label (and Shift-ortho preview for walls).
  _drawPolyGhost(draft, color, ortho) {
    const hov = this.hover;
    if (!hov) return;
    const ctx = this.ctx;
    let tx = snap(hov.mx), ty = snap(hov.my);
    if (draft && draft.length) {
      const [lx, ly] = draft[draft.length - 1];
      if (ortho && hov.shift) {
        if (Math.abs(tx - lx) >= Math.abs(ty - ly)) ty = ly; else tx = lx;
      }
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(this._X(lx), this._Y(ly)); ctx.lineTo(this._X(tx), this._Y(ty)); ctx.stroke();
      ctx.setLineDash([]);
      const len = Math.hypot(tx - lx, ty - ly);
      ctx.globalAlpha = 1;
      this._label((this._X(lx) + this._X(tx)) / 2, (this._Y(ly) + this._Y(ty)) / 2 - 10, `${len.toFixed(2)} m`);
    } else {
      // no vertices yet: crosshair + start hint
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(hov.px - 12, hov.py); ctx.lineTo(hov.px + 12, hov.py); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hov.px, hov.py - 12); ctx.lineTo(hov.px, hov.py + 12); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // wall draft polyline + per-segment lengths (CAD trust: numbers while drawing).
  _drawWallDraft() {
    const pts = this.wallDraft;
    if (!pts || !pts.length) return;
    this._drawWall(pts, 0.3, false, true);
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      this._label((this._X(ax) + this._X(bx)) / 2, (this._Y(ay) + this._Y(by)) / 2 - 10, `${len.toFixed(2)} m`);
    }
  }

  _drawConveyorDraft() {
    this._drawConveyor(this.conveyorDraft, this.pal.draft, true);
  }

  // ---- CAD-style top-view equipment glyphs (replace the old circles) --------
  // Footprints come from EQUIP_PALETTE (meters) so symbols scale with zoom; a
  // minimum pixel size keeps them legible when zoomed out.
  _drawEquipGlyph(e, sel, ghost) {
    const ctx = this.ctx, { sc } = this._view;
    const p = EQUIP_PALETTE.find((x) => x.type === e.type) || { color: '#777', w: 1.2, d: 0.9, label: e.type };
    const wPx = Math.max((p.w || 1.2) * sc, 18), dPx = Math.max((p.d || 0.9) * sc, 14);
    const cx = this._X(e.x), cy = this._Y(e.y);
    const l = cx - wPx / 2, t = cy - dPx / 2;
    ctx.save();
    ctx.fillStyle = hexA(p.color, ghost ? 0.4 : 0.22);
    ctx.strokeStyle = sel ? this.pal.sel : p.color;
    ctx.lineWidth = sel ? 2.4 : 1.6;
    const r = Math.min(4, wPx / 5);
    // body (rounded rect)
    ctx.beginPath();
    ctx.moveTo(l + r, t);
    ctx.arcTo(l + wPx, t, l + wPx, t + dPx, r);
    ctx.arcTo(l + wPx, t + dPx, l, t + dPx, r);
    ctx.arcTo(l, t + dPx, l, t, r);
    ctx.arcTo(l, t, l + wPx, t, r);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // type-specific internals
    ctx.strokeStyle = p.color; ctx.fillStyle = p.color; ctx.lineWidth = 1.4;
    if (e.type === 'agv') {
      // heading arrow + wheel pads
      ctx.beginPath();
      ctx.moveTo(cx + wPx * 0.32, cy - dPx * 0.22);
      ctx.lineTo(cx + wPx * 0.46, cy);
      ctx.lineTo(cx + wPx * 0.32, cy + dPx * 0.22);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.fillRect(l + wPx * 0.12, t + dPx - 3, wPx * 0.18, 2.4);
      ctx.fillRect(l + wPx * 0.70, t + dPx - 3, wPx * 0.18, 2.4);
      ctx.globalAlpha = 1;
    } else if (e.type === 'asrs') {
      // crane aisle (dashed center line) + side racks
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(l + 4, cy); ctx.lineTo(l + wPx - 4, cy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.45;
      ctx.fillRect(l + 3, t + 2.5, wPx - 6, dPx * 0.18);
      ctx.fillRect(l + 3, t + dPx - 2.5 - dPx * 0.18, wPx - 6, dPx * 0.18);
      ctx.globalAlpha = 1;
    } else if (e.type === 'robot_arm') {
      // base + articulated arm
      ctx.beginPath(); ctx.arc(cx - wPx * 0.18, cy + dPx * 0.16, Math.max(2.6, wPx * 0.12), 0, 7); ctx.fill();
      ctx.lineWidth = Math.max(2, wPx * 0.08);
      ctx.beginPath();
      ctx.moveTo(cx - wPx * 0.18, cy + dPx * 0.16);
      ctx.lineTo(cx + wPx * 0.05, cy - dPx * 0.2);
      ctx.lineTo(cx + wPx * 0.3, cy - dPx * 0.05);
      ctx.stroke();
    } else if (e.type === 'crane') {
      // gantry rails + trolley
      ctx.beginPath(); ctx.moveTo(l + 3, t + 3); ctx.lineTo(l + wPx - 3, t + 3); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(l + 3, t + dPx - 3); ctx.lineTo(l + wPx - 3, t + dPx - 3); ctx.stroke();
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(cx, t + 3); ctx.lineTo(cx, t + dPx - 3); ctx.stroke();
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(cx, cy, 2.2, 0, 7); ctx.stroke();
    }
    ctx.restore();
    if (!ghost) {
      const lbl = (p.label || e.type).split('(')[0] + (e.count != null && e.count !== '' ? `×${e.count}` : '');
      this._label(cx, t + dPx + 10, lbl);
    }
  }

  _drawStationGlyph(s, sel, ghost) {
    const ctx = this.ctx, { sc } = this._view;
    const p = EQUIP_PALETTE.find((x) => x.key === 'station') || { color: '#08519c', w: 1.8, d: 0.9 };
    const wPx = Math.max(p.w * sc, 20), dPx = Math.max(p.d * sc, 12);
    const cx = this._X(s.x), cy = this._Y(s.y);
    const l = cx - wPx / 2, t = cy - dPx / 2;
    ctx.save();
    ctx.fillStyle = hexA(p.color, ghost ? 0.4 : 0.22);
    ctx.strokeStyle = sel ? this.pal.sel : p.color;
    ctx.lineWidth = sel ? 2.4 : 1.6;
    ctx.fillRect(l, t, wPx, dPx);
    ctx.strokeRect(l, t, wPx, dPx);
    // worktop edge (the operator side) — a thicker line on the bottom edge
    ctx.strokeStyle = p.color; ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.moveTo(l + 2, t + dPx - 2); ctx.lineTo(l + wPx - 2, t + dPx - 2); ctx.stroke();
    ctx.restore();
    if (!ghost) this._label(cx, t + dPx + 10, `梱包台×${s.count ?? 0}`);
  }

  // ---- selection chrome (Figma-style, additive, read-only) ------------------
  // Draws a cyan bounding box + 8 resize handles + a centred "W × H m" tag and
  // light edge rulers for the currently selected LAYOUT zone. Purely cosmetic:
  // reads this.selected / this.model / this._view only, mutates no state, adds
  // no listeners. No selection (or non-zone selection) → draws nothing, so the
  // prior behaviour is byte-for-byte preserved.
  _drawSelectionChrome() {
    if (this.tool !== 'place') return;
    if (!this.selected || this.selected.kind !== 'zone') return;
    const z = (this.model.layout.zones || []).find((q) => q.id === this.selected.id);
    if (!z) return;
    const ctx = this.ctx;
    const CY = '#34E3FF';                            // mock accent (Cyan)
    // box corners in pixels (y is flipped via _Y; top-left = smaller py)
    const x0 = this._X(z.x), x1 = this._X(z.x + z.w);
    const yTop = this._Y(z.y + z.h), yBot = this._Y(z.y);
    const bx = Math.min(x0, x1), by = Math.min(yTop, yBot);
    const bw = Math.abs(x1 - x0), bh = Math.abs(yBot - yTop);
    if (!(bw > 0) || !(bh > 0)) return;

    ctx.save();

    // light edge rulers: faint ticks projecting the selection extent onto the
    // top and left margins (cheap; a few stroke calls).
    ctx.strokeStyle = hexA(CY, 0.5);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(bx, 0); ctx.lineTo(bx, 6);            // top ruler: left extent
    ctx.moveTo(bx + bw, 0); ctx.lineTo(bx + bw, 6);  // top ruler: right extent
    ctx.moveTo(0, by); ctx.lineTo(6, by);            // left ruler: top extent
    ctx.moveTo(0, by + bh); ctx.lineTo(6, by + bh);  // left ruler: bottom extent
    ctx.stroke();
    ctx.setLineDash([]);

    // bounding box
    ctx.strokeStyle = CY;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bx, by, bw, bh);

    // 8 handles: 4 corners + 4 edge midpoints (small filled squares)
    const HS = 7, h = HS / 2;
    const xs = [bx, bx + bw / 2, bx + bw];
    const ys = [by, by + bh / 2, by + bh];
    ctx.fillStyle = CY;
    ctx.strokeStyle = this.pal.selInk || '#fff';
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i === 1 && j === 1) continue;            // skip centre
        ctx.fillRect(xs[i] - h, ys[j] - h, HS, HS);
        ctx.strokeRect(xs[i] - h, ys[j] - h, HS, HS);
      }
    }

    // dimension tag centred under the box: "W.x × H.x m" (Space Mono)
    const text = `${(+z.w || 0).toFixed(1)} × ${(+z.h || 0).toFixed(1)} m`;
    ctx.font = '700 11px "Space Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(text).width;
    const padX = 7, tagH = 16;
    const tagX = bx + bw / 2 - tw / 2 - padX;
    const tagY = by + bh + 7;
    ctx.fillStyle = CY;
    ctx.beginPath();                                 // rounded-ish pill (rects)
    ctx.fillRect(tagX, tagY, tw + padX * 2, tagH);
    ctx.fillStyle = '#04141a';                       // mock ink-on-cyan
    ctx.fillText(text, bx + bw / 2, tagY + 3);

    ctx.restore();
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
    // The 配置 tool always edits shelves in place (the old zone-mode auto-sync of
    // a lone shelf to its zone footprint is gone — shelves own their geometry).
    const shelfMode = this.tool === 'place';
    for (const sh of z.shelves) {
      const rt = RACK_TYPES[sh.rack_type] || RACK_TYPES.medium;
      const bay = +sh.cell_w || rt.bay, depth = +sh.cell_d || rt.depth;
      const vertical = sh.h >= sh.w;
      const px = Math.max(0.3, vertical ? depth : bay);
      const py = Math.max(0.3, vertical ? bay : depth);
      const isSel = shelfMode && this.selShelves && this.selShelves.has(sh.id);
      ctx.fillStyle = hexA(rt.color, isSel ? 0.3 : 0.16);
      ctx.strokeStyle = hexA(rt.color, isSel ? 0.95 : 0.55); ctx.lineWidth = isSel ? 1.6 : 1;
      ctx.fillRect(this._X(sh.x), this._Y(sh.y + sh.h), sh.w * this._view.sc, sh.h * this._view.sc);
      ctx.strokeRect(this._X(sh.x), this._Y(sh.y + sh.h), sh.w * this._view.sc, sh.h * this._view.sc);
      ctx.fillStyle = hexA(rt.color, 0.85);
      for (let cx = sh.x + px / 2; cx <= sh.x + sh.w - px / 2 + 1e-6; cx += px) {
        for (let cy = sh.y + py / 2; cy <= sh.y + sh.h - py / 2 + 1e-6; cy += py) {
          ctx.fillRect(this._X(cx) - 1.4, this._Y(cy) - 1.4, 2.8, 2.8);
        }
      }
      if (shelfMode) this._drawShelfDecor(sh, rt);
    }
  }

  // Shelf name label + 間口 (facing) chevron, drawn only in the shelf editor.
  _drawShelfDecor(sh, rt) {
    const ctx = this.ctx;
    const cx = this._X(sh.x + sh.w / 2), cy = this._Y(sh.y + sh.h / 2);
    // facing chevron: a small triangle on the open (間口) side pointing outward.
    const sxL = this._X(sh.x), sxR = this._X(sh.x + sh.w);
    const syT = this._Y(sh.y + sh.h), syB = this._Y(sh.y);   // top(px) / bottom(px)
    ctx.fillStyle = hexA(rt.color, 0.95);
    const tri = (ax, ay, bx, by, tx, ty) => { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(tx, ty); ctx.closePath(); ctx.fill(); };
    const m = 6;
    if (sh.facing === 'down') tri(cx - m, syB, cx + m, syB, cx, syB + m);
    else if (sh.facing === 'up') tri(cx - m, syT, cx + m, syT, cx, syT - m);
    else if (sh.facing === 'right') tri(sxR, cy - m, sxR, cy + m, sxR + m, cy);
    else if (sh.facing === 'left') tri(sxL, cy - m, sxL, cy + m, sxL - m, cy);
    // name label (only if the shelf is large enough on screen to fit it).
    if (sh.name && sh.w * this._view.sc > 22 && sh.h * this._view.sc > 12) {
      ctx.fillStyle = this.pal.ink;
      ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(sh.name, cx, cy);
    }
  }

  // ---- M2 shelf selection chrome: bbox + 8 control points + snap guides + draft -
  _drawShelfChrome() {
    if (this.tool !== 'place') return;
    const ctx = this.ctx;
    const CY = '#34E3FF';
    // draft rectangle while corner-dragging (draw=cyan dashed, area=red dashed),
    // with a live W×D readout — CAD trust: you see the numbers while you drag.
    if (this.shelfDraft) {
      const d = this.shelfDraft;
      const x0 = this._X(Math.min(d.x0, d.x1)), x1 = this._X(Math.max(d.x0, d.x1));
      const y0 = this._Y(Math.max(d.y0, d.y1)), y1 = this._Y(Math.min(d.y0, d.y1));
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = d.kind === 'area' ? this.pal.draft : CY;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
      const wM = Math.abs(d.x1 - d.x0), hM = Math.abs(d.y1 - d.y0);
      if (wM > 0.05 || hM > 0.05) {
        this._label((x0 + x1) / 2, y0 - 14, `${wM.toFixed(2)} × ${hM.toFixed(2)} m`);
      }
    }
    // selection bbox + control points
    const bb = this._selBBox();
    if (bb) {
      const x0 = this._X(bb.l), x1 = this._X(bb.r);
      const yTop = this._Y(bb.t), yBot = this._Y(bb.b);
      const bx = Math.min(x0, x1), by = Math.min(yTop, yBot);
      const bw = Math.abs(x1 - x0), bh = Math.abs(yTop - yBot);
      ctx.save();
      ctx.strokeStyle = CY; ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, by, bw, bh);
      // 8 control-point handles (white fill, cyan stroke).
      ctx.fillStyle = '#fff'; ctx.strokeStyle = CY; ctx.lineWidth = 1.2;
      const xs = [bx, bx + bw / 2, bx + bw], ys = [by, by + bh / 2, by + bh];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        if (i === 1 && j === 1) continue;
        ctx.fillRect(xs[i] - CP_HALF, ys[j] - CP_HALF, CP_HALF * 2, CP_HALF * 2);
        ctx.strokeRect(xs[i] - CP_HALF, ys[j] - CP_HALF, CP_HALF * 2, CP_HALF * 2);
      }
      // size tag (W × H m) under the bbox.
      const text = `${(bb.r - bb.l).toFixed(1)} × ${(bb.b - bb.t).toFixed(1)} m`;
      ctx.font = '700 11px "Space Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = CY; ctx.fillRect(bx + bw / 2 - tw / 2 - 7, by + bh + 7, tw + 14, 16);
      ctx.fillStyle = '#04141a'; ctx.fillText(text, bx + bw / 2, by + bh + 10);
      ctx.restore();
    }
    // green snap guide lines (port of ObjectEditorPanel snapLineX/snapLineY).
    if (this.snapLine) {
      ctx.save();
      ctx.strokeStyle = '#1ec773'; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      if (this.snapLine.x != null) { const x = this._X(this.snapLine.x); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this._view.h); ctx.stroke(); }
      if (this.snapLine.y != null) { const y = this._Y(this.snapLine.y); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this._view.w, y); ctx.stroke(); }
      ctx.restore();
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
    // M2: wheel = smooth zoom toward the cursor; middle-drag = pan (handled in
    // _onMove via this.drag.mode==='pan'). All tools get pan/zoom for free.
    this._on(this.canvas, 'wheel', (e) => this._onWheel(e), { passive: false });
    // Right-click = back to 選択 (Minecraft "empty the hand"). Suppress the
    // browser menu only when a placing brush/draft is active, so inspect etc.
    // still work in select mode.
    this._on(this.canvas, 'contextmenu', (e) => {
      if (this.tool !== 'place') return;
      const placing = (this.brush && this.brush.kind !== 'select') || this.wallDraft || this.conveyorDraft;
      if (!placing) return;
      e.preventDefault();
      this._setBrush({ kind: 'select' });
    });
    // leaving the canvas drops the ghost (no stale preview in the corner).
    this._on(this.canvas, 'mouseleave', () => {
      this.hover = null;
      this._updateStatus();
      if (this.brush && this.brush.kind !== 'select') this._repaint();
    });
  }

  // ---- M2 wheel zoom (toward cursor) ---------------------------------------
  _onWheel(e) {
    e.preventDefault();
    const { px, py } = this._pt(e);
    // Trackpad/ wheel: each notch scales by ~1.12; clamp delta to keep it smooth.
    const dir = e.deltaY < 0 ? 1 : -1;
    const factor = Math.pow(1.12, dir * Math.min(3, Math.abs(e.deltaY) / 50 + 1));
    this._zoomAt(px, py, factor);
  }
  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  }

  _onDown(e) {
    const { px, py } = this._pt(e);
    // Middle button (or Space-less right-drag avoided): pan the camera. Works in
    // every tool so the user can always reposition the view.
    if (e.button === 1) {
      e.preventDefault();
      this.drag = { mode: 'pan', startPx: px, startPy: py,
        camCx: this._cam.cx == null ? this.model.layout.bounds.width / 2 : this._cam.cx,
        camCy: this._cam.cy == null ? this.model.layout.bounds.depth / 2 : this._cam.cy };
      return;
    }
    if (e.button !== 0 && e.button !== undefined) return;
    if (this.tool === 'place') return this._placeDown(px, py, e);
    if (this.tool === 'route') return this._routeDown(px, py);
    if (this.tool === 'flow') return this._flowDown(px, py);
  }

  // --- 配置 tool: brush dispatch (place) or unified select/move/resize -------
  _placeDown(px, py, e) {
    const b = this.brush || { kind: 'select' };
    const bounds = this.model.layout.bounds;
    const mxRaw = this._mx(px), myRaw = this._my(py);
    const inside = mxRaw >= 0 && mxRaw <= bounds.width && myRaw >= 0 && myRaw <= bounds.depth;

    if (b.kind === 'select') return this._selectDown(px, py, e);

    if (b.kind === 'rack') {
      // area-fill: corner-drag a rectangle, tiled on mouse-up.
      if (b.area) {
        this.shelfDraft = { x0: mxRaw, y0: myRaw, x1: mxRaw, y1: myRaw, kind: 'area' };
        this.drag = { mode: 'shelfCreate' };
        return;
      }
      // draw: corner-to-corner drag (a tiny click-drag stamps one bay×depth unit
      // on commit — Minecraft-style click-click-click lays bays).
      const hints = this._snapHints(null);
      const sx = this._snapWorldX(mxRaw, hints), sy = this._snapWorldY(myRaw, hints);
      this.snapLine = { x: sx, y: sy };
      this.shelfDraft = { x0: sx == null ? mxRaw : sx, y0: sy == null ? myRaw : sy,
        x1: mxRaw, y1: myRaw, kind: 'draw' };
      this.drag = { mode: 'shelfCreate' };
      return;
    }

    if (b.kind === 'wall') {
      if (!inside && !this.wallDraft) return;
      if (!this.wallDraft) this.wallDraft = [];
      let mx = snap(mxRaw), my = snap(myRaw);
      // Shift = ortho lock against the previous vertex (CAD line discipline).
      if (e && e.shiftKey && this.wallDraft.length) {
        const [lx, ly] = this.wallDraft[this.wallDraft.length - 1];
        if (Math.abs(mx - lx) >= Math.abs(my - ly)) my = ly; else mx = lx;
      }
      this.wallDraft.push([mx, my]);
      this._renderSide(); this._drawCanvas();
      return;
    }

    if (b.kind === 'equip' && b.key === 'conveyor') {
      if (!inside) return;
      if (!this.conveyorDraft) this.conveyorDraft = [];
      this.conveyorDraft.push([snap(mxRaw), snap(myRaw)]);
      this._drawCanvas(); this._renderSide();
      return;
    }

    if (!inside) return;
    this._stampAt(b, mxRaw, myRaw);
  }

  // Stamp a brush at (mx,my) — shared by canvas click and library-card drop.
  _stampAt(b, mxRaw, myRaw) {
    const bounds = this.model.layout.bounds;
    const mx = snap(clamp(mxRaw, 0, bounds.width)), my = snap(clamp(myRaw, 0, bounds.depth));
    // area-semantics gate: a 梱包台 in the 保管エリア (etc.) is a design error.
    const chk = this._placeCheck(b, mxRaw, myRaw);
    if (!chk.ok) {
      if (this._layoutStatus) {
        this._layoutStatus.style.color = 'var(--bad)';
        this._layoutStatus.textContent = chk.reason;
      }
      return;
    }
    if (b.kind === 'zone') { this._placeZone(b.key, mxRaw, myRaw); return; }
    if (b.kind === 'door') {
      this._pushUndo();
      const pal = DOOR_PALETTE.find((x) => x.type === b.key) || DOOR_PALETTE[0];
      const w = pal.type === 'dock' ? 3 : pal.type === 'shutter' ? 4 : 1;
      // doors live ON the building envelope: project onto the nearest bounds
      // edge / wall segment (a door floating mid-floor is always a mistake).
      const pos = this._snapDoorPos(mxRaw, myRaw);
      const d = { id: uid('door'), type: pal.type, x: pos.x, y: pos.y, w };
      this.model.layout.doors.push(d);
      this.selected = { kind: 'door', id: d.id };
      this._renderSide(); this._drawCanvas(); this._updateStatus();
      return;
    }
    if (b.kind === 'rack') {
      // drop / synthetic stamp: one bay×depth unit of the active type.
      this._stampRackUnit(mxRaw, myRaw);
      return;
    }
    if (b.kind === 'equip') {
      if (b.key === 'station') {
        this._pushUndo();
        const s = { id: uid('st'), zone: 'packing', x: mx, y: my, count: 1 };
        this.model.resources.stations.push(s);
        this.selected = { kind: 'station', id: s.id };
      } else {
        this._pushUndo();
        const fast = b.key === 'agv';
        const eq = {
          id: uid('eq'), type: b.key,
          count: fast ? 5 : 1,
          speed_mps: fast ? 1.6 : 1.0,
          x: mx, y: my,
        };
        this.model.resources.equipment.push(eq);
        this.selected = { kind: 'equip', id: eq.id };
      }
      this._renderSide(); this._drawCanvas(); this._updateStatus();
    }
  }

  // One rack unit (bay×depth, facing down) centered at the point, edge-snapped.
  _stampRackUnit(mxRaw, myRaw) {
    const chk = this._placeCheck({ kind: 'rack' }, mxRaw, myRaw);
    if (!chk.ok) {
      if (this._layoutStatus) {
        this._layoutStatus.style.color = 'var(--bad)';
        this._layoutStatus.textContent = chk.reason;
      }
      return;
    }
    const rt = RACK_TYPES[this.shelfType] || RACK_TYPES.medium;
    const zone = this._zoneForShelfAt(mxRaw, myRaw);
    if (!zone) return;
    const bounds = this.model.layout.bounds;
    let x = mxRaw - rt.bay / 2, y = myRaw - rt.depth / 2;
    if (!this.noSnap) {
      const hints = this._snapHints(null);
      const sx = this._snapWorldX(x, hints), sx2 = this._snapWorldX(x + rt.bay, hints);
      if (sx != null) x = sx; else if (sx2 != null) x = sx2 - rt.bay;
      const sy = this._snapWorldY(y, hints), sy2 = this._snapWorldY(y + rt.depth, hints);
      if (sy != null) y = sy; else if (sy2 != null) y = sy2 - rt.depth;
    }
    x = clamp(x, 0, bounds.width - rt.bay);
    y = clamp(y, 0, bounds.depth - rt.depth);
    this._pushUndo();
    const sh = {
      id: uid('s'), name: this._nextShelfName(''),
      x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100,
      w: rt.bay, h: rt.depth,
      rack_type: this.shelfType, facing: 'down',
    };
    zone.shelves.push(sh);
    this._warnOverlap([sh], zone);
    this._renderSide(); this._repaint(); this._updateStatus();
  }

  // Top-most zone containing the point (zones later in the list draw on top).
  _zoneAt(mx, my) {
    const zs = this.model.layout.zones || [];
    for (let i = zs.length - 1; i >= 0; i--) {
      const z = zs[i];
      if (mx >= z.x && mx <= z.x + z.w && my >= z.y && my <= z.y + z.h) return z;
    }
    return null;
  }

  // Area-semantics check for a placement (whole-warehouse design discipline):
  // fixed equipment belongs to an area whose 工程 can use it — 梱包台 in the
  // 保管エリア is a design error, 棚 outside a 保管エリア likewise. Bare floor
  // (no zone under the cursor) stays free. Returns {ok, reason}.
  _placeCheck(b, mx, my) {
    if (!b || b.kind === 'select' || b.kind === 'wall' || b.kind === 'door' || b.kind === 'zone') {
      return { ok: true, reason: null };
    }
    const zone = this._zoneAt(mx, my);
    if (b.kind === 'rack') {
      if (zone && zone.type !== 'storage') {
        return { ok: false,
          reason: `棚は保管エリアに配置します（ここは${ZONE_JP[zone.type] || zone.type}エリア）` };
      }
      return { ok: true, reason: null };
    }
    if (b.kind === 'equip') {
      const rule = EQUIP_ZONE_RULES[b.key];
      if (rule && zone && !rule.allow.includes(zone.type)) {
        return { ok: false,
          reason: `${rule.jp}（ここは${ZONE_JP[zone.type] || zone.type}エリア）` };
      }
    }
    return { ok: true, reason: null };
  }

  // Storage zone receiving a shelf at (mx,my): the zone under the cursor, else
  // the active one, else the first, else AUTO-CREATE one spanning the floor —
  // "never blocks": stamping a shelf on an empty floor just works.
  _zoneForShelfAt(mx, my) {
    const stores = this._storageZones();
    const undercursor = stores.find((z) => mx >= z.x && mx <= z.x + z.w && my >= z.y && my <= z.y + z.h);
    if (undercursor) { this.shelfZoneId = undercursor.id; return undercursor; }
    const active = stores.find((z) => z.id === this.shelfZoneId) || stores[0];
    if (active) { this.shelfZoneId = active.id; return active; }
    const b = this.model.layout.bounds;
    this._pushUndo();
    const z = {
      id: uid('zone'), type: 'storage', x: 0, y: 0, w: b.width, h: b.depth,
      color: ZONE_DEFAULT_COLOR.storage, rack: null, shelves: [],
    };
    this.model.layout.zones.push(z);
    this.shelfZoneId = z.id;
    if (this._layoutStatus) this._layoutStatus.textContent = '保管ゾーンを自動作成しました（床全面）。';
    return z;
  }

  // --- 選択 brush: one hit-test across every object family --------------------
  // Priority: shelf control-points > equipment/stations > doors > shelves >
  // walls > zone resize handle > zones. Small things win over big things so a
  // click lands on what the eye sees on top.
  _selectDown(px, py, e) {
    const zs = this.model.layout.zones;
    const mx = this._mx(px), my = this._my(py);

    // 1) shelf control points (resize of an existing shelf selection)
    if (this.selShelves.size) {
      const cp = this._controlAt(px, py);
      if (cp) {
        this._pushUndo();
        const bb = this._selBBox();
        const rel = [];
        for (const { sh } of this._selShelfObjs()) {
          rel.push({ sh,
            pL: bb.r === bb.l ? 0 : (sh.x - bb.l) / (bb.r - bb.l),
            pR: bb.r === bb.l ? 1 : (sh.x + sh.w - bb.l) / (bb.r - bb.l),
            pT: bb.b === bb.t ? 0 : (sh.y - bb.t) / (bb.b - bb.t),
            pB: bb.b === bb.t ? 1 : (sh.y + sh.h - bb.t) / (bb.b - bb.t) });
        }
        this.drag = { mode: 'shelfResize', cp, bb: { ...bb }, rel };
        return;
      }
    }

    // 2) equipment / stations (point markers, generous 14px halo)
    const hitEq = (this.model.resources.equipment || []).find((q) => Math.hypot(this._X(q.x) - px, this._Y(q.y) - py) <= 14);
    const hitSt = (this.model.resources.stations || []).find((q) => Math.hypot(this._X(q.x) - px, this._Y(q.y) - py) <= 14);
    if (hitEq || hitSt) {
      const o = hitEq || hitSt;
      this.selShelves = new Set();
      this.selected = { kind: hitEq ? 'equip' : 'station', id: o.id };
      this.drag = { mode: 'moveObj', kind: this.selected.kind, id: o.id };
      this._renderSide(); this._drawCanvas(); this._updateStatus();
      return;
    }

    // 3) doors
    const hitDoor = (this.model.layout.doors || []).find((q) => Math.hypot(this._X(q.x) - px, this._Y(q.y) - py) <= 12);
    if (hitDoor) {
      this.selShelves = new Set();
      this.selected = { kind: 'door', id: hitDoor.id };
      this.drag = { mode: 'moveDoor', id: hitDoor.id };
      this._renderSide(); this._drawCanvas(); this._updateStatus();
      return;
    }

    // 4) shelves (Shift = add/remove from the multi-selection)
    const hit = this._shelfAt(px, py);
    if (hit) {
      const additive = e && e.shiftKey;
      if (!additive && !this.selShelves.has(hit.sh.id)) this.selShelves = new Set();
      if (additive && this.selShelves.has(hit.sh.id)) {
        this.selShelves.delete(hit.sh.id);
        this.selected = null; this._renderSide(); this._repaint(); this._updateStatus();
        return;
      }
      this.selShelves.add(hit.sh.id);
      this.shelfZoneId = hit.zone.id;
      this.selected = null;
      this._pushUndo();
      const items = this._selShelfObjs().map(({ sh }) => ({ sh, ox: sh.x, oy: sh.y }));
      this.drag = { mode: 'shelfMove', items, downX: mx, downY: my, _snapped: true };
      this._renderSide(); this._repaint(); this._updateStatus();
      return;
    }

    // 5) walls
    const hitWall = this._wallHit(px, py);
    if (hitWall) {
      this.selShelves = new Set();
      this.selected = { kind: 'wall', id: hitWall.id };
      this._renderSide(); this._drawCanvas(); this._updateStatus();
      return;
    }

    // 6) zone resize handle of the current selection
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

    // 7) zones, top-most first
    for (let i = zs.length - 1; i >= 0; i--) {
      const z = zs[i];
      if (mx >= z.x && mx <= z.x + z.w && my >= z.y && my <= z.y + z.h) {
        this.selShelves = new Set();
        this.selected = { kind: 'zone', id: z.id };
        this.drag = { mode: 'move', id: z.id, dx: mx - z.x, dy: my - z.y };
        this._renderSide(); this._drawCanvas(); this._updateStatus();
        return;
      }
    }

    // empty space: clear all selection
    this.selShelves = new Set();
    this.selected = null;
    this._renderSide(); this._drawCanvas(); this._updateStatus();
  }

  // ===========================================================================
  // M2 — MapMaker shelf editing (free placement / edge-snap / control points /
  // bulk-gen / area-fill). Shelves are ShelfArea objects in zone.shelves.
  // ===========================================================================

  // --- edge snapping (port of MapInputHandler.snapX/snapY + point hints) ---
  // Collect candidate snap X/Y values from: building bounds, every storage-zone
  // rectangle, and every existing shelf's edges (excluding the ones being moved).
  _snapHints(excludeIds) {
    const xs = [], ys = [];
    const b = this.model.layout.bounds;
    xs.push(0, b.width); ys.push(0, b.depth);
    for (const z of this._storageZones()) {
      xs.push(z.x, z.x + z.w); ys.push(z.y, z.y + z.h);
      for (const sh of (z.shelves || [])) {
        if (excludeIds && excludeIds.has(sh.id)) continue;
        xs.push(sh.x, sh.x + sh.w); ys.push(sh.y, sh.y + sh.h);
      }
    }
    return { xs, ys };
  }
  // Snap a world X (in meters) to the nearest hint if it is within SNAP_PX
  // *screen* pixels. Returns the snapped world X or null (mirrors snapX()).
  _snapWorldX(wx, hints) {
    if (this.noSnap) return null;
    let best = null, bestD = SNAP_PX + 1;
    const sx = this._X(wx);
    for (const hx of hints.xs) {
      const d = Math.abs(this._X(hx) - sx);
      if (d <= SNAP_PX && d < bestD) { bestD = d; best = hx; }
    }
    return best;
  }
  _snapWorldY(wy, hints) {
    if (this.noSnap) return null;
    let best = null, bestD = SNAP_PX + 1;
    const sy = this._Y(wy);
    for (const hy of hints.ys) {
      const d = Math.abs(this._Y(hy) - sy);
      if (d <= SNAP_PX && d < bestD) { bestD = d; best = hy; }
    }
    return best;
  }

  // --- hit-testing within the shelf editor ---
  _shelfAt(px, py) {
    // top-most shelf under the cursor across all storage zones.
    const all = this._allShelves();
    for (let i = all.length - 1; i >= 0; i--) {
      const { zone, sh } = all[i];
      if (px >= this._X(sh.x) && px <= this._X(sh.x + sh.w)
          && py <= this._Y(sh.y) && py >= this._Y(sh.y + sh.h)) {
        return { zone, sh };
      }
    }
    return null;
  }
  // Bounding box of the current shelf selection (world coords) or null.
  _selBBox() {
    if (!this.selShelves || !this.selShelves.size) return null;
    let l = null, r = null, t = null, btm = null;
    for (const { sh } of this._selShelfObjs()) {
      l = l == null ? sh.x : Math.min(l, sh.x);
      r = r == null ? sh.x + sh.w : Math.max(r, sh.x + sh.w);
      t = t == null ? sh.y : Math.min(t, sh.y);
      btm = btm == null ? sh.y + sh.h : Math.max(btm, sh.y + sh.h);
    }
    return l == null ? null : { l, r, t, b: btm };
  }
  _selShelfObjs() {
    return this._allShelves().filter(({ sh }) => this.selShelves.has(sh.id));
  }
  // Control-point hit-test against the selection bbox: returns {dx,dy} or null.
  _controlAt(px, py) {
    const bb = this._selBBox();
    if (!bb) return null;
    const x0 = this._X(bb.l), x1 = this._X(bb.r);
    const yTop = this._Y(bb.t), yBot = this._Y(bb.b);  // yTop < yBot in px? y flips: _Y(t) is larger
    const xs = { '-1': Math.min(x0, x1), '0': (x0 + x1) / 2, '1': Math.max(x0, x1) };
    const ys = { '-1': Math.min(yTop, yBot), '0': (yTop + yBot) / 2, '1': Math.max(yTop, yBot) };
    // Note: in world coords dy=-1 is the top (smaller y) which in screen is the
    // larger py (y flipped). Map masks → screen via this correspondence:
    //   dyMask -1 (world top)    => screen max py
    //   dyMask +1 (world bottom) => screen min py
    const screenForDy = { '-1': Math.max(yTop, yBot), '0': (yTop + yBot) / 2, '1': Math.min(yTop, yBot) };
    for (const cp of CONTROL_POINTS) {
      const cx = xs[String(cp.dx)];
      const cy = screenForDy[String(cp.dy)];
      if (Math.abs(cx - px) <= CP_HALF + 1 && Math.abs(cy - py) <= CP_HALF + 1) return cp;
    }
    return null;
  }

  // --- mousedown in shelf mode ---
  // --- mousemove in shelf drags (create / move / resize) ---
  _shelfMove(px, py) {
    const b = this.model.layout.bounds;
    let mx = this._mx(px), my = this._my(py);
    if (this.drag.mode === 'shelfCreate' && this.shelfDraft) {
      if (this.shelfDraft.kind === 'draw') {
        const hints = this._snapHints(null);
        const sx = this._snapWorldX(mx, hints), sy = this._snapWorldY(my, hints);
        this.snapLine = { x: sx, y: sy };
        this.shelfDraft.x1 = sx == null ? mx : sx;
        this.shelfDraft.y1 = sy == null ? my : sy;
      } else { // area
        this.shelfDraft.x1 = clamp(mx, 0, b.width);
        this.shelfDraft.y1 = clamp(my, 0, b.depth);
      }
      this._repaint();
      return;
    }
    if (this.drag.mode === 'shelfMove') {
      const dx = mx - this.drag.downX, dy = my - this.drag.downY;
      // Compute group edge-snap: try snapping the group's left/right/top/bottom.
      const ids = new Set(this.drag.items.map((it) => it.sh.id));
      const hints = this._snapHints(ids);
      // moved bbox before snap
      let l = null, r = null, t = null, btm = null;
      for (const it of this.drag.items) {
        const nx = it.ox + dx, ny = it.oy + dy;
        l = l == null ? nx : Math.min(l, nx); r = r == null ? nx + it.sh.w : Math.max(r, nx + it.sh.w);
        t = t == null ? ny : Math.min(t, ny); btm = btm == null ? ny + it.sh.h : Math.max(btm, ny + it.sh.h);
      }
      // pick the better of (snap left edge) vs (snap right edge), like ObjectEditorPanel.dragged.
      const sL = this._snapWorldX(l, hints), sR = this._snapWorldX(r, hints);
      let snapDX = 0, snapX = null;
      const scoreL = sL == null ? null : Math.abs(sL - l), scoreR = sR == null ? null : Math.abs(sR - r);
      if (scoreL != null && (scoreR == null || scoreL <= scoreR)) { snapDX = sL - l; snapX = sL; }
      else if (scoreR != null) { snapDX = sR - r; snapX = sR; }
      const sT = this._snapWorldY(t, hints), sB = this._snapWorldY(btm, hints);
      let snapDY = 0, snapY = null;
      const scoreT = sT == null ? null : Math.abs(sT - t), scoreB = sB == null ? null : Math.abs(sB - btm);
      if (scoreT != null && (scoreB == null || scoreT <= scoreB)) { snapDY = sT - t; snapY = sT; }
      else if (scoreB != null) { snapDY = sB - btm; snapY = sB; }
      this.snapLine = { x: snapX, y: snapY };
      for (const it of this.drag.items) {
        it.sh.x = clamp(it.ox + dx + snapDX, 0, b.width - it.sh.w);
        it.sh.y = clamp(it.oy + dy + snapDY, 0, b.depth - it.sh.h);
      }
      this._repaint();
      return;
    }
    if (this.drag.mode === 'shelfResize') {
      const cp = this.drag.cp, bb = this.drag.bb;
      // snap the moving edge to hints (exclude selection's own edges).
      const ids = new Set(this.drag.rel.map((rr) => rr.sh.id));
      const hints = this._snapHints(ids);
      let toX = null, toY = null;
      if (cp.dx !== 0) {
        const sX = this._snapWorldX(mx, hints);
        this.snapLine = { ...(this.snapLine || {}), x: sX };
        toX = sX == null ? mx : sX;
      } else { this.snapLine = { ...(this.snapLine || {}), x: null }; }
      if (cp.dy !== 0) {
        const sY = this._snapWorldY(my, hints);
        this.snapLine = { ...(this.snapLine || {}), y: sY };
        toY = sY == null ? my : sY;
      } else { this.snapLine = { ...(this.snapLine || {}), y: null }; }
      // New bbox extents: the moving edge becomes `to*`, the opposite stays fixed.
      let nl = bb.l, nr = bb.r, nt = bb.t, nb = bb.b;
      if (cp.dx < 0) nl = Math.min(toX, bb.r - SHELF_MIN_M);
      else if (cp.dx > 0) nr = Math.max(toX, bb.l + SHELF_MIN_M);
      if (cp.dy < 0) nt = Math.min(toY, bb.b - SHELF_MIN_M);  // world top
      else if (cp.dy > 0) nb = Math.max(toY, bb.t + SHELF_MIN_M);
      // Map each member's cached 0..1 position into the new bbox (proportional).
      for (const rr of this.drag.rel) {
        if (cp.dx !== 0) {
          const x = nl + rr.pL * (nr - nl);
          const x2 = nl + rr.pR * (nr - nl);
          rr.sh.x = Math.min(x, x2);
          rr.sh.w = Math.max(SHELF_MIN_M, Math.abs(x2 - x));
        }
        if (cp.dy !== 0) {
          const y = nt + rr.pT * (nb - nt);
          const y2 = nt + rr.pB * (nb - nt);
          rr.sh.y = Math.min(y, y2);
          rr.sh.h = Math.max(SHELF_MIN_M, Math.abs(y2 - y));
        }
      }
      this._repaint();
      return;
    }
  }

  // --- commit a corner-drag (draw → 1 shelf or a stamp, area → tiled fill) ---
  _shelfCreateCommit() {
    const d = this.shelfDraft;
    this.shelfDraft = null;
    if (!d) return;
    let l = Math.min(d.x0, d.x1), r = Math.max(d.x0, d.x1);
    let t = Math.min(d.y0, d.y1), btm = Math.max(d.y0, d.y1);
    if (d.kind === 'draw') {
      // A click (or tiny wiggle) stamps one bay×depth unit of the active type —
      // Minecraft-style block laying. A real drag draws corner-to-corner.
      if (r - l < SHELF_MIN_M && btm - t < SHELF_MIN_M) {
        this._stampRackUnit(d.x0, d.y0);
        return;
      }
      const chk = this._placeCheck({ kind: 'rack' }, (l + r) / 2, (t + btm) / 2);
      if (!chk.ok) {
        if (this._layoutStatus) {
          this._layoutStatus.style.color = 'var(--bad)';
          this._layoutStatus.textContent = chk.reason;
        }
        return;
      }
      const zone = this._zoneForShelfAt((l + r) / 2, (t + btm) / 2);
      if (!zone) return;
      // enforce min size (MapMaker AddObjectPanel.regionSelected grows to min).
      if (r - l < SHELF_MIN_M) r = l + SHELF_MIN_M;
      if (btm - t < SHELF_MIN_M) btm = t + SHELF_MIN_M;
      this._pushUndo();
      const sh = {
        id: uid('s'), name: this._nextShelfName(''),
        x: l, y: t, w: r - l, h: btm - t,
        rack_type: this.shelfType,
        // facing: a freehand shelf opens toward its long side's aisle; default by
        // aspect — tall (depth ≥ width) faces right, wide faces down (advisory only).
        facing: (btm - t) >= (r - l) ? 'right' : 'down',
      };
      zone.shelves.push(sh);
      // overlap warn (touching allowed) — MapMaker rejects; whsim only warns.
      this._warnOverlap([sh], zone);
    } else if (d.kind === 'area') {
      const zone = this._zoneForShelfAt((l + r) / 2, (t + btm) / 2);
      if (!zone) return;
      if (r - l < 1 || btm - t < 1) {
        if (this._layoutStatus) this._layoutStatus.textContent = '面積が小さすぎます。もう少し大きな矩形を描いてください。';
        return;
      }
      // open the area-fill chooser; the actual tiling runs on OK.
      this._openAreaFillDialog(zone, { l, t, w: r - l, h: btm - t });
    }
    this._renderSide();
  }

  // Warn (non-blocking) if any new shelf strictly overlaps another object.
  _warnOverlap(news, zone) {
    let overlap = false;
    const others = this._allShelves().filter(({ sh }) => !news.includes(sh));
    for (const n of news) {
      for (const { sh: o } of others) {
        if (n.x < o.x + o.w && n.x + n.w > o.x && n.y < o.y + o.h && n.y + n.h > o.y) { overlap = true; break; }
      }
    }
    if (this._layoutStatus) {
      this._layoutStatus.style.color = overlap ? 'var(--bad)' : 'var(--ink-secondary)';
      this._layoutStatus.textContent = overlap
        ? '注意: 棚が他の棚と重なっています（接触は可、重なりは経路に影響します）。'
        : '棚を作成しました。';
    }
    return overlap;
  }

  // --- shelf name generation (prefix + counter, dedup; mirrors ShelfArrayGenerator) ---
  _usedShelfNames() {
    const used = new Set();
    for (const { sh } of this._allShelves()) if (sh.name) used.add(sh.name);
    return used;
  }
  _nextShelfName(prefix) {
    const used = this._usedShelfNames();
    const p = prefix && prefix.trim() ? prefix.trim() : '棚';
    let n = 1;
    let name = `${p}${String(n).padStart(2, '0')}`;
    while (used.has(name)) { n += 1; name = `${p}${String(n).padStart(2, '0')}`; }
    return name;
  }

  // ===========================================================================
  // 棚一括生成 — port of ShelfArrayGenerator.java. The user picks a 間口 (pick
  // face) direction + frontage/depth/count/gap/prefix; shelves are laid side by
  // side ALONG the frontage so the 間口 stays open (never stacked in depth).
  // ===========================================================================
  _openBulkGenDialog() {
    // auto-creates a floor-spanning storage zone when none exists (never blocks).
    const b = this.model.layout.bounds;
    const zone = this._zoneForShelfAt(b.width / 2, b.depth / 2);
    if (!zone) return;
    const rt = RACK_TYPES[this.shelfType] || RACK_TYPES.medium;
    // remember last inputs across opens (whsim equivalent of Prefs).
    const st = this._bulkPrefs || (this._bulkPrefs = {
      face: 0, frontage: Math.round((rt.bay) * 1000), depth: Math.round(rt.depth * 1000),
      count: 10, gap: 0, prefix: '',
    });
    const body = document.createElement('div');
    body.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;align-items:center;';
    const faceSel = this._dlgSelect(body, '間口（ピック面）の向き',
      SHELFGEN_FACES.map((f, i) => ({ value: String(i), label: f.label })), String(st.face));
    const frontInp = this._dlgNum(body, '間口の幅 (mm)', st.frontage);
    const depthInp = this._dlgNum(body, '奥行き (mm)', st.depth);
    const countInp = this._dlgNum(body, '連結数 (何連)', st.count);
    const gapInp = this._dlgNum(body, '棚どうしの間隔 (mm)', st.gap);
    const prefixInp = this._dlgText(body, '棚名プレフィックス(空=自動)', st.prefix);
    this._openDialog('棚を一括生成（間口指定）', body, () => {
      const face = parseInt(faceSel.value, 10) || 0;
      const frontage = parseFloat(frontInp.value), depth = parseFloat(depthInp.value);
      const count = parseInt(countInp.value, 10), gap = parseFloat(gapInp.value) || 0;
      const prefix = prefixInp.value.trim();
      if (!(frontage > 0) || !(depth > 0) || !(count > 0)) {
        return 'サイズと連結数は正の数で入力してください。';
      }
      Object.assign(st, { face, frontage, depth, count, gap, prefix });
      this._bulkGenerate(zone, face, frontage / 1000, depth / 1000, gap / 1000, count, prefix);
      return null;  // success closes the dialog
    });
  }

  // Generate `count` shelves along the frontage axis (ShelfArrayGenerator.generate),
  // centered on the active storage zone. All values arrive in meters.
  _bulkGenerate(zone, face, frontage, depth, gap, count, prefix) {
    const f = SHELFGEN_FACES[face] || SHELFGEN_FACES[0];
    const horizontalRow = f.axis === 'x';  // 下/上 connect left-right; 右/左 up-down.
    let w, h, stepX, stepY;
    if (horizontalRow) { w = frontage; h = depth; stepX = w + gap; stepY = 0; }
    else { w = depth; h = frontage; stepX = 0; stepY = h + gap; }
    const totalW = horizontalRow ? (count * w + (count - 1) * gap) : w;
    const totalH = horizontalRow ? h : (count * h + (count - 1) * gap);
    // center on the active zone (whsim centers on the zone rather than the view).
    const startX = zone.x + (zone.w - totalW) / 2;
    const startY = zone.y + (zone.h - totalH) / 2;
    this._pushUndo();
    const used = this._usedShelfNames();
    let auto = 1;
    const created = [];
    for (let i = 0; i < count; i++) {
      const x = startX + stepX * i, y = startY + stepY * i;
      let name;
      if (prefix) { do { name = `${prefix}${auto++}`; } while (used.has(name)); }
      else { name = this._nextShelfName(''); while (used.has(name)) name = `棚${String(auto++).padStart(2, '0')}`; }
      used.add(name);
      const sh = { id: uid('s'), name, x, y, w, h, rack_type: this.shelfType, facing: f.facing };
      zone.shelves.push(sh);
      created.push(sh);
    }
    this.selShelves = new Set(created.map((s) => s.id));
    const dir = horizontalRow ? '左右' : '上下';
    if (this._layoutStatus) {
      this._layoutStatus.style.color = 'var(--ink-secondary)';
      this._layoutStatus.textContent = `${created.length} 連の棚を生成（間口を空けて${dir}に連結）。`;
    }
    this._warnOverlap(created, zone);
    this._renderTool();
  }

  // ===========================================================================
  // 面積オート生成 (new) — tile a drawn rectangle with alternating shelf-run bands
  // and aisle bands, faces toward the aisles, sequential area-bay-position names.
  // ===========================================================================
  _openAreaFillDialog(zone, rect) {
    const rt = RACK_TYPES[this.shelfType] || RACK_TYPES.medium;
    const st = this._areaPrefs || (this._areaPrefs = {
      front: Math.round(rt.bay * 1000), depth: Math.round(rt.depth * 1000),
      aisle: 2000, runAxis: 'x', backToBack: true, prefix: 'A',
    });
    const body = document.createElement('div');
    body.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;align-items:center;';
    const rackSel = this._dlgSelect(body, '標準棚', RACK_ORDER.map((k) => ({ value: k, label: RACK_TYPES[k].label })), this.shelfType);
    const frontInp = this._dlgNum(body, '間口幅 (mm)', st.front);
    const depthInp = this._dlgNum(body, '奥行き (mm)', st.depth);
    const aisleInp = this._dlgNum(body, '通路幅 (mm)', st.aisle);
    const axisSel = this._dlgSelect(body, '棚列の向き', [
      { value: 'x', label: '横（左右に伸びる棚列）' }, { value: 'y', label: '縦（上下に伸びる棚列）' },
    ], st.runAxis);
    const b2bSel = this._dlgSelect(body, '背中合わせ', [
      { value: 'yes', label: '背中合わせ（2列1組）' }, { value: 'no', label: '単列' },
    ], st.backToBack ? 'yes' : 'no');
    const prefixInp = this._dlgText(body, '棚名プレフィックス', st.prefix);
    this._openDialog('面積オート生成（棚列＋通路）', body, () => {
      const rackType = rackSel.value;
      const front = parseFloat(frontInp.value) / 1000, depth = parseFloat(depthInp.value) / 1000;
      const aisle = parseFloat(aisleInp.value) / 1000;
      const runAxis = axisSel.value, backToBack = b2bSel.value === 'yes';
      const prefix = prefixInp.value.trim() || 'A';
      if (!(front > 0) || !(depth > 0) || !(aisle > 0)) return '寸法は正の数で入力してください。';
      Object.assign(st, { front: front * 1000, depth: depth * 1000, aisle: aisle * 1000, runAxis, backToBack, prefix });
      this.shelfType = rackType;
      this._areaFill(zone, rect, { rackType, front, depth, aisle, runAxis, backToBack, prefix });
      return null;
    });
  }

  // Tile `rect` (world l/t/w/h) with shelf-run bands + aisle bands. The run axis
  // is the direction shelves extend; bays subdivide each run along that axis;
  // bands stack across the perpendicular (depth) axis. Faces point at the aisle.
  _areaFill(zone, rect, opt) {
    this._pushUndo();
    const { front, depth, aisle, runAxis, backToBack, prefix } = opt;
    const created = [];
    // Cross axis = perpendicular to the run. Bands repeat across it.
    // For a back-to-back pair, two shelf bands (2*depth) share aisles on both
    // outer sides; otherwise each shelf band gets its own aisle.
    const runLen = runAxis === 'x' ? rect.w : rect.h;     // length a shelf run can span
    const crossLen = runAxis === 'x' ? rect.h : rect.w;   // depth-stacking extent
    const bayCount = Math.max(1, Math.floor(runLen / front));
    if (bayCount < 1) return;
    const bandDepth = backToBack ? depth * 2 : depth;
    const period = bandDepth + aisle;       // one shelf-band + one aisle
    const bandCount = Math.max(1, Math.floor((crossLen + aisle) / period));
    let area = 0;
    // helper to push one shelf run at cross-offset `co` with thickness `th`,
    // facing `fc`. Names: prefix + band(area) + sequential bay.
    const pushRun = (co, th, fc, areaIdx) => {
      for (let bi = 0; bi < bayCount; bi++) {
        const along = bi * front;
        let x, y, w, h;
        if (runAxis === 'x') { x = rect.l + along; y = rect.t + co; w = front; h = th; }
        else { x = rect.l + co; y = rect.t + along; w = th; h = front; }
        const name = `${prefix}${String(areaIdx + 1).padStart(2, '0')}-${String(bi + 1).padStart(2, '0')}`;
        created.push({ id: uid('s'), name, x, y, w, h, rack_type: opt.rackType, facing: fc });
      }
    };
    for (let band = 0; band < bandCount; band++) {
      const bandStart = band * period;       // cross offset of this band
      if (backToBack) {
        // two runs back-to-back: first faces the aisle BEFORE it, second AFTER.
        // facing directions depend on the run axis (x → up/down, y → left/right).
        const faceA = runAxis === 'x' ? 'up' : 'left';
        const faceB = runAxis === 'x' ? 'down' : 'right';
        pushRun(bandStart, depth, faceA, area); area++;
        pushRun(bandStart + depth, depth, faceB, area); area++;
      } else {
        // single run: face the following aisle (down for x-runs, right for y-runs).
        const fc = runAxis === 'x' ? 'down' : 'right';
        pushRun(bandStart, depth, fc, area); area++;
      }
    }
    // dedup names against existing shelves (append -n on collision).
    const used = this._usedShelfNames();
    for (const sh of created) {
      let nm = sh.name, k = 2;
      while (used.has(nm)) { nm = `${sh.name}_${k++}`; }
      sh.name = nm; used.add(nm);
      zone.shelves.push(sh);
    }
    this.selShelves = new Set(created.map((s) => s.id));
    if (this._layoutStatus) {
      this._layoutStatus.style.color = 'var(--ink-secondary)';
      this._layoutStatus.textContent = `面積から ${created.length} 棚を自動生成しました（${bandCount}列帯）。`;
    }
    this._renderTool();
  }

  // ---- reusable modal dialog (injected; OK validator returns error string or null) ----
  _openDialog(title, bodyEl, onOk) {
    if (this._dialogEl) { this._dialogEl.remove(); this._dialogEl = null; }
    const overlay = document.createElement('div');
    overlay.className = 'dz-dialog-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    const box = document.createElement('div');
    box.className = 'dz-dialog dz-enter';
    const h = document.createElement('div');
    h.className = 'dz-dialog-title';
    h.textContent = title;
    box.appendChild(h);
    box.appendChild(bodyEl);
    const err = document.createElement('div');
    err.style.cssText = 'color:var(--bad);font-size:12px;min-height:16px;margin-top:8px;';
    box.appendChild(err);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;';
    const cancel = document.createElement('button');
    cancel.textContent = 'キャンセル';
    cancel.style.cssText = 'padding:6px 12px;border:1px solid var(--line-hair);border-radius:var(--r-sm);background:var(--bg-app);color:var(--ink-primary);cursor:pointer;';
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = '生成';
    ok.style.cssText = 'padding:6px 14px;border-radius:var(--r-sm);font-weight:700;cursor:pointer;';
    const close = () => { if (this._dialogEl) { this._dialogEl.remove(); this._dialogEl = null; } };
    this._on(cancel, 'click', close);
    this._on(ok, 'click', () => {
      const msg = onOk();
      if (msg) { err.textContent = msg; return; }
      close();
    });
    this._on(overlay, 'mousedown', (e) => { if (e.target === overlay) close(); });
    this._on(overlay, 'keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(row);
    overlay.appendChild(box);
    this.container.appendChild(overlay);
    this._dialogEl = overlay;
    // focus the first input for keyboard users.
    const first = bodyEl.querySelector('input,select');
    if (first) first.focus();
  }
  // dialog field builders (label on the left, control on the right of the grid).
  _dlgLabel(parent, text) {
    const l = document.createElement('label');
    l.textContent = text;
    l.style.cssText = 'font-size:12px;color:var(--ink-secondary);';
    parent.appendChild(l);
    return l;
  }
  _dlgNum(parent, label, value) {
    this._dlgLabel(parent, label);
    const i = document.createElement('input');
    i.type = 'number';
    i.value = String(value);
    i.style.cssText = 'padding:5px 7px;border:1px solid var(--line-hair);border-radius:var(--r-sm);font-size:13px;background:var(--bg-app);color:var(--ink-primary);width:100%;box-sizing:border-box;';
    parent.appendChild(i);
    return i;
  }
  _dlgText(parent, label, value) {
    this._dlgLabel(parent, label);
    const i = document.createElement('input');
    i.type = 'text';
    i.value = value == null ? '' : String(value);
    i.style.cssText = 'padding:5px 7px;border:1px solid var(--line-hair);border-radius:var(--r-sm);font-size:13px;background:var(--bg-app);color:var(--ink-primary);width:100%;box-sizing:border-box;';
    parent.appendChild(i);
    return i;
  }
  _dlgSelect(parent, label, opts, value) {
    this._dlgLabel(parent, label);
    const sel = this._select(parent, opts, value);
    sel.style.cssText += ';width:100%;box-sizing:border-box;';
    return sel;
  }

  _onMove(e) {
    if (!this.canvas) return;
    const { px, py } = this._pt(e);
    const b = this.model.layout.bounds;
    this.noSnap = !!(e.ctrlKey || e.metaKey);  // Ctrl disables edge snapping
    // Hover tracking (no drag): drive the placement ghost + the status readout.
    if (!this.drag) {
      if (this.tool !== 'place') return;
      this.hover = { mx: this._mx(px), my: this._my(py), px, py, shift: !!e.shiftKey };
      this._updateStatus();
      // ghost preview repaint only when a placing brush (or a draft) is armed —
      // select mode stays repaint-free on hover for cheapness.
      if ((this.brush && this.brush.kind !== 'select') || this.wallDraft || this.conveyorDraft) this._repaint();
      return;
    }
    // Camera pan (middle-drag): no model mutation, no undo entry.
    if (this.drag.mode === 'pan') {
      const dxMeters = (px - this.drag.startPx) / this._view.sc;
      const dyMeters = (this.drag.startPy - py) / this._view.sc;  // y flipped
      this._cam = { cx: clamp(this.drag.camCx - dxMeters, 0, b.width),
        cy: clamp(this.drag.camCy - dyMeters, 0, b.depth), zoom: this._cam.zoom };
      this._camGoal = { ...this._cam };
      this._fitCanvas(); this._repaint();
      return;
    }
    this.hover = { mx: this._mx(px), my: this._my(py), px, py, shift: !!e.shiftKey };
    this._updateStatus();
    // Shelf drags (create / move / resize) have their own handler.
    if (this.tool === 'place'
        && (this.drag.mode === 'shelfCreate' || this.drag.mode === 'shelfMove' || this.drag.mode === 'shelfResize')) {
      return this._shelfMove(px, py);
    }
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
      // dragged doors stay on the envelope too (project, don't free-place).
      const pos = this._snapDoorPos(this._mx(px), this._my(py));
      o.x = pos.x; o.y = pos.y;
    }
    this._drawCanvas();
    this._updateStatus();
  }

  _onUp() {
    if (!this.drag) return;
    const mode = this.drag.mode;
    if (mode === 'pan') { this.drag = null; return; }
    if (mode === 'shelfCreate') { this._shelfCreateCommit(); this.drag = null; this.snapLine = null; this._renderSide(); this._repaint(); return; }
    if (mode === 'shelfMove' || mode === 'shelfResize') {
      this.snapLine = null; this.drag = null; this._renderSide(); this._repaint(); this._updateStatus(); return;
    }
    this.drag = null; this._renderSide(); this._updateStatus();
  }

  _onDbl(e) {
    if (this.tool === 'place') {
      if (this.conveyorDraft) this._finishConveyor();
      if (this.wallDraft) this._finishWall();
    }
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
    if (this.tool === 'place') {
      // a tap with the rack brush stamps a unit directly (no drag on touch).
      if (this.brush && this.brush.kind === 'rack' && !this.brush.area) {
        const bounds = this.model.layout.bounds;
        const mx = this._mx(px), my = this._my(py);
        if (mx >= 0 && mx <= bounds.width && my >= 0 && my <= bounds.depth) this._stampRackUnit(mx, my);
      } else {
        this._placeDown(px, py, { shiftKey: false });
      }
    } else if (this.tool === 'route') this._routeDown(px, py);
    else if (this.tool === 'flow') this._flowDown(px, py);
    this.drag = null;  // no touch-drag; a tap should not start a move
    this.shelfDraft = null;  // a tap should not leave a dangling shelf draft
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
    this.selShelves = new Set();
    this.shelfDraft = null;
    this.snapLine = null;
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
      if (this._dialogEl) { this._dialogEl.remove(); this._dialogEl = null; return; }
      if (this.shelfDraft) { this.shelfDraft = null; this.drag = null; this.snapLine = null; this._repaint(); return; }
      if (this.tool === 'route' && (this._measureA || this._measurePath)) {
        this._measureA = this._measureB = this._measurePath = null;
        this._renderRouteTable(); this._drawCanvas();
        return;
      }
      if (this.conveyorDraft || this.wallDraft || this.routeDraft) {
        this.conveyorDraft = this.wallDraft = this.routeDraft = null;
        this._renderTool();
      } else if (this.tool === 'place' && this.brush && this.brush.kind !== 'select') {
        // armed brush → back to 選択 (the Minecraft "empty hand").
        this._setBrush({ kind: 'select' });
      } else if (this.selShelves && this.selShelves.size) {
        this.selShelves = new Set(); this._renderTool();
      } else if (this.selected) {
        this.selected = null; this._renderTool();
      }
      return;
    }
    // M2: duplicate selected shelves (MapMaker 'd' key).
    if ((e.key === 'd' || e.key === 'D') && !meta && this.tool === 'place'
        && this.selShelves && this.selShelves.size) {
      e.preventDefault(); this._duplicateShelves(); return;
    }
    // Digits 1-9 = pinned library brushes (MapMaker's fixed digit toolbar).
    // With shelves selected, the rack digit applies the ACTIVE type to them.
    if (!meta && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key) && this.tool === 'place') {
      const brush = this._digitBrush(parseInt(e.key, 10));
      if (brush) {
        e.preventDefault();
        if (brush.kind === 'rack' && this.selShelves && this.selShelves.size) {
          this._assignRackTypeToSelection(this.shelfType);
        } else {
          this._setBrush(brush);
        }
      }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.tool === 'place' && this.selShelves && this.selShelves.size) {
        e.preventDefault(); this._deleteShelves(); return;
      }
      if (this.selected) { e.preventDefault(); this._deleteSelected(); }
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
  // Project a world point onto the building envelope: the nearest point on any
  // wall segment or bounds edge. Doors always sit ON a wall/edge (MapMaker
  // discipline) — free placement mid-floor reads as an error, snap reads as CAD.
  _snapDoorPos(mx, my) {
    const b = this.model.layout.bounds;
    const segs = [];
    // 4 bounds edges
    segs.push([[0, 0], [b.width, 0]], [[0, b.depth], [b.width, b.depth]],
              [[0, 0], [0, b.depth]], [[b.width, 0], [b.width, b.depth]]);
    for (const w of this.model.layout.walls || []) {
      const pts = w.points || [];
      for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
    }
    let best = null, bestD = Infinity;
    for (const [[ax, ay], [bx, by]] of segs) {
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? ((mx - ax) * dx + (my - ay) * dy) / len2 : 0;
      t = clamp(t, 0, 1);
      const qx = ax + t * dx, qy = ay + t * dy;
      const d = Math.hypot(mx - qx, my - qy);
      if (d < bestD) { bestD = d; best = { x: qx, y: qy }; }
    }
    if (!best) return { x: snap(mx), y: snap(my) };
    return { x: Math.round(best.x * 100) / 100, y: Math.round(best.y * 100) / 100 };
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
      // drop consecutive duplicate vertices (the finishing dblclick re-adds the
      // last point) so saved walls carry no degenerate zero-length segments.
      const pts = this.wallDraft.filter((p, i, a) =>
        i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 1e-6);
      if (pts.length >= 2) {
        this._pushUndo();
        const w = { id: uid('wall'), points: pts, thickness: 0.3 };
        this.model.layout.walls.push(w);
        this.selected = { kind: 'wall', id: w.id };
      }
    }
    this.wallDraft = null;
    this._renderSide(); this._drawCanvas();
  }

  // ---- side editor panels (layout + equip tools) ---------------------------
  // The side panel is now an OBJECT INSPECTOR: it shows the editor for whatever
  // is selected (shelf / zone / equipment / wall / door), and floor-level
  // settings (倉庫サイズ etc.) when nothing is. The placement palettes that used
  // to live here moved to the library on the left.
  _renderSide() {
    if (!this.side) return;
    const s = this.side; s.innerHTML = '';
    if (this.selShelves && this.selShelves.size) { this._sideShelf(s); return; }
    const k = this.selected && this.selected.kind;
    if (k === 'zone') this._sideLayout(s);
    else if (k === 'wall' || k === 'door') this._sideBuilding(s);
    else if (k === 'equip' || k === 'station') this._sideEquip(s);
    else this._sideFloor(s);
  }

  // ---- no-selection inspector: floor settings + active drafts ---------------
  _sideFloor(s) {
    const b = this.brush || {};
    // active draft controls (wall / conveyor mid-draw)
    if (this.wallDraft) {
      this._h(s, '壁を作図中');
      this._note(s, `頂点 ${this.wallDraft.length} 点。クリックで追加（Shift=水平/垂直）、ダブルクリックか下のボタンで確定。`);
      this._btn(s, '壁を確定', () => this._finishWall(), 'margin-bottom:8px;');
    } else if (this.conveyorDraft) {
      this._h(s, 'コンベアを作図中');
      this._note(s, `頂点 ${this.conveyorDraft.length} 点。クリックで追加、ダブルクリックか下のボタンで確定。`);
      this._btn(s, 'コンベアを確定', () => this._finishConveyor(), 'margin-bottom:8px;');
    } else if (b.kind && b.kind !== 'select') {
      this._h(s, `配置中: ${this._brushLabel()}`);
      this._note(s, this._brushHint());
      if (b.kind === 'rack') {
        const rt = RACK_TYPES[this.shelfType] || RACK_TYPES.medium;
        this._note(s, `${rt.label}: 間口${rt.bay}m × 奥行${rt.depth}m・${rt.levels || 1}段・収容${rt.capacity || 0}。${rt.desc || ''}`);
      }
      this._btn(s, '選択モードに戻る (Esc)', () => this._setBrush({ kind: 'select' }), 'margin-bottom:8px;');
    } else {
      this._h(s, 'オブジェクト情報');
      this._note(s, '床の物をクリックすると、ここで名前・寸法・台数などを数値で編集できます。');
    }

    // 倉庫サイズ — set the floor extents up front, MapMaker-style.
    this._h(s, '倉庫サイズ');
    const bnd = this.model.layout.bounds;
    this._field(s, '幅 W (m)', () => this._num(bnd.width, (v) => {
      bnd.width = Math.max(MIN_M, v); this._fitCanvas(); this._drawCanvas(); }));
    this._field(s, '奥行 D (m)', () => this._num(bnd.depth, (v) => {
      bnd.depth = Math.max(MIN_M, v); this._fitCanvas(); this._drawCanvas(); }));

    if ((this.model.resources.conveyors || []).length) {
      this._h(s, `コンベア (${this.model.resources.conveyors.length})`);
      this._btn(s, '最後のコンベアを削除', () => { this._pushUndo(); this.model.resources.conveyors.pop(); this._drawCanvas(); this._renderSide(); });
    }
  }

  // ---- per-shelf editor (ShelfEditor.java port): name / type / facing / size ----
  _sideShelf(s) {
    const objs = this._selShelfObjs();
    const zone = this._activeStoreZone();
    const total = zone ? (zone.shelves || []).length : 0;
    this._h(s, `この保管ゾーンの棚: ${total}`);

    if (!objs.length) { this._note(s, '棚を選択すると、名前・種別・間口・サイズを編集できます。'); return; }
    if (objs.length > 1) {
      this._h(s, `選択中: ${objs.length} 棚`);
      // bulk rack-type + facing for the multi-selection.
      this._field(s, '種別（一括）', () => {
        const sel = this._select(null, RACK_ORDER.map((k) => ({ value: k, label: RACK_TYPES[k].label })), objs[0].sh.rack_type);
        this._on(sel, 'change', () => { this._pushUndo(); objs.forEach(({ sh }) => { sh.rack_type = sel.value; }); this._repaint(); });
        return sel;
      });
      this._field(s, '間口の向き（一括）', () => {
        const sel = this._select(null, [
          { value: 'down', label: '下' }, { value: 'up', label: '上' },
          { value: 'right', label: '右' }, { value: 'left', label: '左' },
        ], objs[0].sh.facing);
        this._on(sel, 'change', () => { this._pushUndo(); objs.forEach(({ sh }) => { sh.facing = sel.value; }); this._repaint(); });
        return sel;
      });
      this._btn(s, '複製（+1m）', () => this._duplicateShelves(), 'margin-top:8px;');
      this._btn(s, '削除', () => this._deleteShelves(), 'margin-top:8px;color:var(--bad);');
      return;
    }

    // single shelf editor
    const sh = objs[0].sh;
    this._h(s, '選択中の棚');
    // name — verbatim, unique, comma-banned (live validation like ShelfEditor).
    const nameRow = this._div(s, 'margin-bottom:6px;');
    const nl = this._div(nameRow, 'font-size:12px;margin-bottom:3px;');
    nl.textContent = '棚名';
    const nameInp = document.createElement('input');
    nameInp.type = 'text'; nameInp.value = sh.name || '';
    nameInp.style.cssText = 'width:100%;box-sizing:border-box;padding:5px 7px;border:1px solid var(--line-hair);border-radius:var(--r-sm);font-size:13px;background:var(--bg-app);color:var(--ink-primary);';
    const nameErr = this._div(nameRow, 'font-size:11px;color:var(--bad);min-height:14px;');
    const validateName = () => {
      const v = nameInp.value;
      if (v.indexOf(',') !== -1 || v.indexOf('、') !== -1) { nameErr.textContent = '棚名にカンマは使用できません。'; return false; }
      // duplicate check (excluding self)
      for (const { sh: o } of this._allShelves()) { if (o !== sh && o.name && o.name === v) { nameErr.textContent = '棚名が重複しています。'; return false; } }
      nameErr.textContent = '';
      return true;
    };
    this._on(nameInp, 'input', () => validateName());
    this._on(nameInp, 'change', () => { if (validateName()) { this._pushUndo(); sh.name = nameInp.value; this._repaint(); } });
    nameRow.appendChild(nameInp); nameRow.appendChild(nameErr);

    // rack type
    this._field(s, '種別', () => {
      const sel = this._select(null, RACK_ORDER.map((k) => ({ value: k, label: RACK_TYPES[k].label })), sh.rack_type);
      this._on(sel, 'change', () => { this._pushUndo(); sh.rack_type = sel.value; this._repaint(); });
      return sel;
    });
    // facing (間口)
    this._field(s, '間口の向き', () => {
      const sel = this._select(null, [
        { value: 'down', label: '下を向く' }, { value: 'up', label: '上を向く' },
        { value: 'right', label: '右を向く' }, { value: 'left', label: '左を向く' },
      ], sh.facing);
      this._on(sel, 'change', () => { this._pushUndo(); sh.facing = sel.value; this._repaint(); });
      return sel;
    });
    // size (横長/縦長 mm in ShelfEditor; whsim uses meters W/H for consistency)
    const b = this.model.layout.bounds;
    this._field(s, '幅 W (m)', () => this._num(sh.w, (v) => { this._pushUndo(); sh.w = clamp(v, SHELF_MIN_M, b.width); this._repaint(); }, 0.1));
    this._field(s, '奥行 H (m)', () => this._num(sh.h, (v) => { this._pushUndo(); sh.h = clamp(v, SHELF_MIN_M, b.depth); this._repaint(); }, 0.1));
    this._field(s, 'X (m)', () => this._num(sh.x, (v) => { this._pushUndo(); sh.x = clamp(v, 0, b.width - sh.w); this._repaint(); }, 0.1));
    this._field(s, 'Y (m)', () => this._num(sh.y, (v) => { this._pushUndo(); sh.y = clamp(v, 0, b.depth - sh.h); this._repaint(); }, 0.1));

    this._btn(s, '複製（+1m）', () => this._duplicateShelves(), 'margin-top:8px;');
    this._btn(s, '削除', () => this._deleteShelves(), 'margin-top:8px;color:var(--bad);');
  }

  // duplicate the selected shelves offset by +1m, auto-named (MapMaker 'd' key).
  _duplicateShelves() {
    const objs = this._selShelfObjs();
    if (!objs.length) return;
    this._pushUndo();
    const newIds = new Set();
    for (const { zone, sh } of objs) {
      const copy = { ...sh, id: uid('s'), name: this._nextShelfName(sh.name.replace(/\d+$/, '')), x: sh.x + 1, y: sh.y + 1 };
      zone.shelves.push(copy);
      newIds.add(copy.id);
    }
    this.selShelves = newIds;
    this._renderTool();
  }
  _deleteShelves() {
    const ids = new Set(this.selShelves);
    if (!ids.size) return;
    this._pushUndo();
    for (const z of this._storageZones()) z.shelves = (z.shelves || []).filter((sh) => !ids.has(sh.id));
    this.selShelves = new Set();
    this._renderTool();
  }

  // selected wall / door inspector (placement happens via the library brushes).
  _sideBuilding(s) {
    const w = this.selected && this.selected.kind === 'wall'
      ? this.model.layout.walls.find((q) => q.id === this.selected.id) : null;
    if (w) {
      this._h(s, '選択中の壁');
      this._field(s, '厚さ (m)', () => this._num(w.thickness, (v) => { w.thickness = Math.max(0.05, v); this._drawCanvas(); }));
      const pts = w.points || [];
      let len = 0;
      for (let i = 0; i < pts.length - 1; i++) len += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      this._note(s, `頂点 ${pts.length} 点・全長 ${len.toFixed(2)} m。`);
      this._btn(s, '削除', () => {
        this._pushUndo();
        this.model.layout.walls = this.model.layout.walls.filter((q) => q.id !== w.id);
        this.selected = null; this._renderSide(); this._drawCanvas();
      }, 'margin-top:10px;color:var(--bad);');
      return;
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
      this._field(s, 'X (m)', () => this._num(d.x, (v) => { d.x = clamp(v, 0, this.model.layout.bounds.width); this._drawCanvas(); }, 0.1));
      this._field(s, 'Y (m)', () => this._num(d.y, (v) => { d.y = clamp(v, 0, this.model.layout.bounds.depth); this._drawCanvas(); }, 0.1));
      this._btn(s, '削除', () => {
        this._pushUndo();
        this.model.layout.doors = this.model.layout.doors.filter((q) => q.id !== d.id);
        this.selected = null; this._renderSide(); this._drawCanvas();
      }, 'margin-top:10px;color:var(--bad);');
    }
  }

  // selected zone inspector (zones are placed from the library's ゾーン cards).
  _sideLayout(s) {
    const z = this.selected && this.selected.kind === 'zone'
      ? this.model.layout.zones.find((q) => q.id === this.selected.id) : null;
    if (!z) { this._sideFloor(s); return; }

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

  // selected equipment / station inspector (placement via the library brushes).
  _sideEquip(s) {
    const sel = this.selected;
    if (sel && sel.kind === 'equip') {
      const e = this.model.resources.equipment.find((q) => q.id === sel.id);
      if (e) {
        const p = EQUIP_PALETTE.find((x) => x.type === e.type);
        this._h(s, `選択中: ${p ? p.label : e.type}`);
        if (p && p.desc) this._note(s, p.desc);
        this._field(s, '台数', () => this._num(e.count, (v) => { e.count = Math.max(0, Math.round(v)); this._drawCanvas(); }, 1));
        this._field(s, '速度 (m/s)', () => this._num(e.speed_mps, (v) => { e.speed_mps = Math.max(0, v); }));
        this._field(s, 'X (m)', () => this._num(e.x, (v) => { e.x = clamp(v, 0, this.model.layout.bounds.width); this._drawCanvas(); }, 0.1));
        this._field(s, 'Y (m)', () => this._num(e.y, (v) => { e.y = clamp(v, 0, this.model.layout.bounds.depth); this._drawCanvas(); }, 0.1));
        this._btn(s, '削除', () => { this._pushUndo(); this.model.resources.equipment = this.model.resources.equipment.filter((q) => q.id !== e.id); this.selected = null; this._renderSide(); this._drawCanvas(); }, 'margin-top:10px;color:var(--bad);');
      }
    } else if (sel && sel.kind === 'station') {
      const st = this.model.resources.stations.find((q) => q.id === sel.id);
      if (st) {
        this._h(s, '選択中: 梱包台');
        this._field(s, '台数', () => this._num(st.count, (v) => { st.count = Math.max(0, Math.round(v)); this._drawCanvas(); }, 1));
        this._field(s, 'X (m)', () => this._num(st.x, (v) => { st.x = clamp(v, 0, this.model.layout.bounds.width); this._drawCanvas(); }, 0.1));
        this._field(s, 'Y (m)', () => this._num(st.y, (v) => { st.y = clamp(v, 0, this.model.layout.bounds.depth); this._drawCanvas(); }, 0.1));
        this._btn(s, '削除', () => { this._pushUndo(); this.model.resources.stations = this.model.resources.stations.filter((q) => q.id !== st.id); this.selected = null; this._renderSide(); this._drawCanvas(); }, 'margin-top:10px;color:var(--bad);');
      }
    }
  }

  // place an object from the レイアウト palette, centered on (mx,my), clamped to floor
  _placeZone(type, mx, my) {
    const d = this._zoneDefaults(type);
    this._pushUndo();
    const b = this.model.layout.bounds;
    const w = Math.min(d.w, b.width), h = Math.min(d.h, b.depth);
    const x = clamp(snap(mx - w / 2), 0, Math.max(0, b.width - w));
    const y = clamp(snap(my - h / 2), 0, Math.max(0, b.depth - h));
    const z = {
      id: uid('zone'), type, x, y, w, h,
      color: ZONE_DEFAULT_COLOR[type] || null,
      rack: null,
      // Storage zones start EMPTY — shelves are stamped/drawn with the 棚 brush
      // (or 一括/面積生成), so the zone is just the container.
      shelves: [],
    };
    this.model.layout.zones.push(z);
    if (type === 'storage') this.shelfZoneId = z.id;
    // keep the brush armed so the user can drop several of the same object.
    this._renderSide(); this._drawCanvas(); this._updateStatus();
    if (this._layoutStatus) this._layoutStatus.textContent = `「${ZONE_JP[type] || type}」を配置しました。続けて置けます（Escで選択へ）。`;
  }

  _addZone(type) {
    this._pushUndo();
    const b = this.model.layout.bounds;
    const w = Math.min(12, b.width / 2), h = Math.min(8, b.depth / 2);
    const z = {
      id: uid('zone'), type, x: clamp(2, 0, b.width - w), y: clamp(2, 0, b.depth - h),
      w, h, color: ZONE_DEFAULT_COLOR[type] || null,
      rack: null,
      shelves: [],
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
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;border:1px solid var(--line-hair);border-radius:var(--r-md);background:var(--bg-sunken);';
    // toggle: spatial flow-building mode (click zones in sequence)
    const flowBtn = this._btn(bar, this.flowMode ? '配置を終了' : '床図でフロー配置', () => {
      this.flowMode = !this.flowMode;
      if (this.flowMode) { this.flowCursor = 0; this.flowMethodStage = null; }
      this._renderFlow();
    });
    if (this.flowMode) flowBtn.style.cssText += ';background:var(--ink-primary);color:var(--bg-app);border-color:var(--ink-primary);font-weight:700;';
    // "落とし込む": author the physical エリア for every 工程 (in flow order) and
    // bind them — the process chain (decided in ②分析) dropped onto the drawing.
    const genBtn = this._btn(bar, '工程フローからエリアを配置', () => this._layoutAreasFromFlow());
    genBtn.className = 'primary';
    genBtn.title = '入荷→格納→…→出荷の各工程エリアを、フロー順に床へ自動配置して割り当てます';
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
    wrap.style.cssText = 'flex:1;min-height:0;position:relative;border:1px solid var(--line-hair);border-radius:var(--r-md);background:var(--bg-app);overflow:hidden;';
    wrap.classList.add('dz-canvas-wrap');
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = `width:100%;height:100%;display:block;cursor:${this.flowMode ? 'pointer' : 'default'};`;
    wrap.appendChild(this.canvas);
    this._flowCanvasHost = wrap;
    left.appendChild(wrap);
    this.body.appendChild(left);

    // right column: the workflow strip + pick strategy + (in-context) method panel
    this.side = document.createElement('div');
    this.side.style.cssText = 'width:340px;flex:0 0 340px;overflow-y:auto;border:1px solid var(--line-hair);border-radius:var(--r-md);background:var(--bg-sunken);padding:10px;';
    this.side.classList.add('dz-enter');
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
    // Broadcast the live 工程→エリア state so the マテリアルフロー view reflects
    // spatial-flow edits in real time (before any save). Deduped by snapshot so
    // the per-frame redraw doesn't spam the bus.
    this._emitFlowChanged();
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

  // 落とし込む: turn the (fixed) process chain into physical エリア on the floor.
  // Each 工程 gets a zone of its canonical type, tiled left→right in flow order
  // (材料の流れ＝図面の左から右), proportional to the floor width; each stage is
  // bound to its new zone. Existing 棚 in a reused storage zone are preserved.
  _layoutAreasFromFlow() {
    const order = this._orderedStages();
    if (!order.length) return;
    // canonical zone type per stage id (first of the allowed set).
    const TYPE = { receive: 'receiving', putaway: 'storage', pick: 'storage',
      pack: 'packing', ship: 'shipping' };
    // collapse consecutive stages that share a zone type (格納+ピッキングは同じ
    // 保管エリアを共有) into one physical lane so we don't draw two 保管 boxes.
    const lanes = [];
    for (const st of order) {
      const t = TYPE[st.id] || 'staging';
      const last = lanes[lanes.length - 1];
      if (last && last.type === t) last.stages.push(st);
      else lanes.push({ type: t, stages: [st] });
    }
    this._pushUndo();
    const round2 = (v) => Math.round(v * 100) / 100;
    const b = this.model.layout.bounds;
    const margin = Math.min(2, b.width * 0.03, b.depth * 0.06);
    const gap = Math.min(1.5, b.width * 0.02);
    const usableW = b.width - margin * 2 - gap * (lanes.length - 1);
    const laneW = Math.max(2, usableW / lanes.length);
    const y = margin, h = Math.max(2, b.depth - margin * 2);
    let x = margin;
    // reuse an existing zone of the same type when possible (keep its 棚); else
    // create one. Zones we don't touch are left intact.
    const pool = {};
    for (const z of this.model.layout.zones) { (pool[z.type] = pool[z.type] || []).push(z); }
    const used = new Set();
    for (const lane of lanes) {
      let z = (pool[lane.type] || []).find((q) => !used.has(q.id));
      if (z) {
        used.add(z.id);
        Object.assign(z, { x: round2(x), y: round2(y), w: round2(laneW), h: round2(h) });
      } else {
        z = { id: uid('zone'), type: lane.type, x: round2(x), y: round2(y),
          w: round2(laneW), h: round2(h), color: ZONE_DEFAULT_COLOR[lane.type] || null,
          rack: null, shelves: [] };
        this.model.layout.zones.push(z);
      }
      for (const st of lane.stages) st.zone = z.id;
      if (lane.type === 'storage') this.shelfZoneId = z.id;
      x += laneW + gap;
    }
    this.flowMode = false;
    this.flowCursor = order.length;
    this._fitCanvas();
    this._renderFlow();
    if (this._flowStatus) {
      this._flowStatus.textContent = `工程フローから ${lanes.length} エリアを配置し、全工程に割り当てました。`;
    }
  }

  // Snapshot the process flow (id/label/zone+zone-type/method) and dispatch it
  // for any live listener (マテリアルフロー). Deduped: only emits on change.
  _emitFlowChanged() {
    const order = this._orderedStages();
    const stages = order.map((st) => {
      const z = st.zone ? this._zoneById(st.zone) : null;
      const area = this._stageAreaStatus(st);
      return {
        id: st.id, label: st.label || st.id, method: st.method || 'manual',
        zone: st.zone || null, zone_type: z ? z.type : null,
        area_ok: area.ok, area_warn: area.warn,
      };
    });
    const snap = JSON.stringify(stages);
    if (snap === this._flowSnap) return;
    this._flowSnap = snap;
    document.dispatchEvent(new CustomEvent('whsim:flow-changed', { detail: { stages } }));
  }

  // ---- flow side panel: the workflow strip (synced) + method panel ---------
  // Area-chain status for one stage: is it bound to a zone whose TYPE can host
  // the 工程 (AnyLogic-style area semantics)? Returns {ok, warn} for the list.
  _stageAreaStatus(st) {
    const expected = STAGE_ZONE_TYPES[st.id];
    const z = st.zone ? this._zoneById(st.zone) : null;
    if (!z) return { ok: false, warn: '未割当 — 床図でエリアを割り当ててください' };
    if (expected && !expected.includes(z.type)) {
      const want = expected.map((t) => ZONE_JP[t] || t).join('・');
      return { ok: false,
        warn: `種別不一致 — ${st.label || st.id}は${want}エリアへ（現在: ${ZONE_JP[z.type] || z.type}）` };
    }
    return { ok: true, warn: null };
  }

  _renderFlowSide() {
    const s = this.side; if (!s) return;
    s.innerHTML = '';
    this._h(s, '作業フロー（工程ごとに作業方法）');
    this._note(s, '工程をクリックすると作業方法を設定できます。床図のゾーンと同じデータを表示しています。');

    const order = this._orderedStages();
    // エリア連鎖サマリ: 入庫→仮置き→保管→…が正しい種別のエリアで繋がっているか。
    const issues = order.map((st) => this._stageAreaStatus(st)).filter((r) => !r.ok);
    const chain = this._div(s, 'padding:7px 10px;border-radius:var(--r-md);margin:8px 0 4px;font-size:12px;'
      + (issues.length
        ? 'border:1px solid var(--bad);background:rgba(227,64,28,0.08);color:var(--ink-primary);'
        : 'border:1px solid var(--ok, #1db954);background:rgba(29,185,84,0.08);color:var(--ink-primary);'));
    chain.textContent = issues.length
      ? `⚠ エリア連鎖に${issues.length}件の問題（下の工程の警告を確認）`
      : '✓ エリア連鎖OK — 全工程が正しい種別のエリアに繋がっています';

    const strip = this._div(s, 'display:flex;flex-direction:column;gap:0;margin:8px 0 14px;');
    order.forEach((st, i) => {
      const open = this.flowMethodStage === st.id;
      const area = this._stageAreaStatus(st);
      const box = this._div(strip, `display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 11px;border-radius:var(--r-md);cursor:pointer;border:2px solid ${METHOD_COLOR[st.method] || 'var(--ink-tertiary)'};background:${open ? hexA(METHOD_COLOR[st.method] || 'var(--ink-tertiary)', 0.28) : hexA(METHOD_COLOR[st.method] || 'var(--ink-tertiary)', 0.1)};`);
      this._on(box, 'click', () => {
        this.flowMethodStage = (this.flowMethodStage === st.id) ? null : st.id;
        this._renderFlowSide(); this._drawFlowCanvas();
      });
      const lblWrap = this._div(box, 'display:flex;flex-direction:column;gap:2px;min-width:0;');
      const lbl = this._div(lblWrap, 'font-weight:700;font-size:14px;');
      lbl.textContent = `${i + 1}. ${st.label || st.id}`;
      const zname = this._div(lblWrap, 'font-size:11px;color:var(--ink-secondary);');
      const z = st.zone ? this._zoneById(st.zone) : null;
      zname.textContent = z ? `場所: ${ZONE_JP[z.type] || z.type}` : '場所: 未割当';
      if (!area.ok) {
        const warn = this._div(lblWrap, 'font-size:11px;color:var(--bad);line-height:1.4;');
        warn.textContent = `⚠ ${area.warn}`;
      }
      const badge = this._div(box, `font-size:11px;color:#fff;background:${METHOD_COLOR[st.method] || 'var(--ink-tertiary)'};padding:2px 7px;border-radius:var(--r-pill);white-space:nowrap;`);
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
    const banner = this._div(s, 'margin:6px 0 10px;padding:9px 11px;border-radius:var(--r-md);background:var(--accent-tint);border:1px solid var(--accent-ring);');
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
    if (this.conveyorDraft) this._finishConveyor();
    if (this.wallDraft) this._finishWall();
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
    inp.style.cssText += ';width:96px;padding:5px 7px;border:1px solid var(--line-hair);border-radius:var(--r-sm);font-size:13px;background:var(--bg-app);color:var(--ink-primary);transition:border-color var(--dur-1) var(--ease-out);';
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
    sel.style.cssText = 'padding:5px 7px;border:1px solid var(--line-hair);border-radius:var(--r-sm);font-size:13px;background:var(--bg-app);color:var(--ink-primary);transition:border-color var(--dur-1) var(--ease-out);';
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
    b.style.cssText = 'padding:6px 10px;border:1px solid var(--line-hair);border-radius:var(--r-sm);background:var(--bg-app);color:var(--ink-primary);font-size:13px;cursor:pointer;' + (css || '');
    this._on(b, 'click', onClick);
    if (parent) parent.appendChild(b);
    return b;
  }
}
