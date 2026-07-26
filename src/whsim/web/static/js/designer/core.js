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
// class itself (state, lifecycle, normalize, shell, camera/coordinate transforms,
// canvas event wiring, undo/redo, keyboard, save). Cohesive method groups live in
// sibling modules and are mixed onto Designer.prototype at the bottom of this file
// (Object.assign) — a pure structural split that preserves every method's `this`
// semantics and call graph verbatim:
//   ./library.js — object LIBRARY (cards, brush arming, icons, rack pick/assign)
//   ./render.js  — Canvas2D draw loop (grid/ghost/glyphs/selection chrome)
//   ./place.js   — placement pointer (stamp/zone hit-test/wall/door/conveyor)
//   ./shelf.js   — M2 shelf editor (select/drag/resize/snap, bulk/area dialogs)
//   ./select.js  — PowerPoint-style marquee multi-select + group move/delete
//   ./flow.js    — フロー tool (stage strip, flow canvas, per-stage work method)
//   ./route.js   — 動線 tool (aisle net, A→B measure, route table)
//   ./side.js    — right-hand object inspector panels
//
// Public API (must stay stable — app.js imports the facade designer.js):
//   new Designer(container, model, handlers)
//   .save() .setModel(model) .resize() .dispose()
//   .assignInventory() .recommendWork()
import {
  ZONE_JP, EQUIP_PALETTE, RACK_TYPES, RACK_ORDER, RACK_SILHOUETTE_FALLBACK, DOOR_JP, MOVER_JP, MOVER_SPEED, MIN_M, SHELF_MIN_M,
} from './constants.js';
import { resolvePalette, clone, clamp, snap, uid } from './geometry.js';
// Cohesive method groups live in sibling modules and are mixed into the
// Designer prototype below (pure structural split — no behaviour change).
import { libraryMethods } from './library.js';
import { renderMethods } from './render.js';
import { placeMethods } from './place.js';
import { shelfMethods } from './shelf.js';
import { selectMethods } from './select.js';
import { flowMethods } from './flow.js';
import { routeMethods } from './route.js';
import { sideMethods } from './side.js';
import { sidePanelMethods } from './sidepanel.js';

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
    // PowerPoint-style multi-select: non-shelf objects in the selection union
    // ([{kind,id}], see ./select.js) + the live rubber-band rect while dragging.
    this.selObjs = [];             // multi-selected zones/equipment/stations/doors
    this.marquee = null;           // {x0,y0,x1,y1} world rect while rubber-banding
    this.handTool = false;         // 🖐: left-drag pans (toolbar toggle)
    this._spaceDown = false;       // Space held → left-drag pans (PowerPoint/Figma)
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
    // Docked side-table (保管設計・棚割り) inside the layout screen. Built after the
    // shell so it can reserve body width; survives _renderTool (body-child rebuilds).
    this._spInjectStyle();
    this._buildSidePanel();
    this._bindWindow();
    this._bindKeys();
    this._bindTheme();
    this._bindFlowBus();
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

  // ②マテリアルフロー and ③設計フロー are two views of ONE graph (flowgraph.py), so
  // an edit in either must show in the other. materialflow.js already listened to
  // this bus; the designer only ever DISPATCHED on it, which made the sync
  // one-way. Ignore our own events so a save here cannot loop back into a redraw.
  _bindFlowBus() {
    this._on(document, 'whsim:flow-changed', (e) => {
      const src = (e && e.detail && e.detail.source) || '';
      if (src === 'designer') return;
      if (this.tool !== 'flow') return;      // re-read happens on next entry
      if (this.handlers && this.handlers.reloadModel) {
        Promise.resolve(this.handlers.reloadModel()).then((m) => {
          if (m) this.setModel(m); else this._renderFlow();
        }).catch(() => this._renderFlow());
      } else {
        this._renderFlow();
      }
    });
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
    this.selObjs = [];
    this.marquee = null;
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
    this._spDispose();   // tear down hosted 保管設計/棚割り modules first
    for (const [el, type, fn] of this._listeners) el.removeEventListener(type, fn);
    this._listeners = [];
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._camRaf) cancelAnimationFrame(this._camRaf);
    this._pflowStop();                      // 人流アニメーションの rAF
    if (this._auditTimer) clearTimeout(this._auditTimer);
    this._auditTimer = 0;
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
      + '<div><b>選択</b>: クリックで選択（<b>Shift</b>＋クリックで追加/解除）、ドラッグで移動、ハンドルでサイズ変更。'
      + '空き床を左ドラッグすると<b>範囲選択</b>（PowerPoint風）— まとめて移動・削除できます。'
      + '右パネルで名前・寸法・台数などを数値編集。</div>'
      + '<div><b>棚</b>: クリック=1台スタンプ / ドラッグ=角から角で1枚。エッジに自動スナップ'
      + '（<b>Ctrl</b>で無効）。<b>一括生成</b>＝間口の向き・連結数を指定、<b>面積生成</b>＝矩形から棚列＋通路を自動配置。</div>'
      + '<div><b>壁</b>: クリックで頂点追加（<b>Shift</b>=水平/垂直固定、長さ表示）、ダブルクリックで確定。</div>'
      + '<div><b>コンベア</b>: クリックで頂点追加、ダブルクリックで確定。</div>'
      + '<div><b>フロー</b>: 工程をクリックで作業方法を設定。「床図でフロー配置」で工程→ゾーンを割当。</div>'
      + '<div><b>動線</b>: 床をクリックで頂点追加、ダブルクリックで確定。距離と所要時間を自動計算。</div>'
      + '<div style="margin-top:6px;">ホイールで拡大縮小。表示の移動は<b>右ドラッグ</b> / '
      + '<b>Space</b>＋ドラッグ / 中ボタンドラッグ / 🖐ボタン。「全体表示」でリセット。</div>'
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

    // Per-tool purpose hint (one line). フロー and 動線 look similar but are
    // distinct concerns; this line keeps the difference visible at a glance.
    this._toolHint = document.createElement('div');
    this._toolHint.style.cssText = 'font-size:11.5px;color:var(--ink-tertiary);line-height:1.5;margin:-2px 0 0;';
    c.appendChild(this._toolHint);

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
    this.selObjs = [];
    this.marquee = null;
    this.shelfDraft = null;
    this.snapLine = null;
    this.conveyorDraft = null;
    this.wallDraft = null;
    this.routeDraft = null;
    this.flowMethodStage = null;
    if (key !== 'flow') this.flowMode = false;
    if (key !== 'route') this._pflowStop();
    this._auditChip = null;          // rebuilt by whichever tool _renderTool draws
    for (const k in this._toolBtns) {
      const active = k === key;
      const b = this._toolBtns[k];
      b.style.cssText = active
        ? 'background:var(--ink-primary);color:var(--bg-app);border-color:var(--ink-primary);font-weight:700;'
        : '';
    }
    // one-line purpose hint per tool (フロー vs 動線 are distinct — see below).
    if (this._toolHint) {
      const HINT = {
        place: '配置: 棚・設備・ゾーン・壁を床に置いて編集。右の「保管設計・棚割り」で什器算定と棚割りも調整できます。',
        flow: 'フロー: 工程（入荷→格納→…→出荷）の順序・場所・作業方法を決める〈工程の設計〉。',
        route: '動線: 作業員/フォークリフトの移動経路を引き、距離と所要時間を測る〈移動の計測〉。',
      };
      this._toolHint.textContent = HINT[key] || '';
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
    this.canvas.style.cssText = `width:100%;height:100%;display:block;cursor:${this._canvasCursor()};`;
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
    this._auditSoon();          // first レイアウト診断 for this floor
  }

  // ---- thin bar above the canvas: zoom-to-fit / underlay / inventory --------
  _renderCanvasBar(parent) {
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 8px;'
      + 'border:1px solid var(--line-hair);border-radius:var(--r-md);background:var(--bg-sunken);';
    this._btn(bar, '全体表示', () => this._zoomToFit(), 'font-size:12px;').title = '全体が収まるように表示（ホイールで拡大縮小、右ドラッグ/Space＋ドラッグで移動）';
    // 🖐 hand tool: discoverable pan — while ON, plain left-drag pans the view.
    this._handBtn = this._btn(bar, '🖐 移動', () => {
      this.handTool = !this.handTool;
      this._refreshHandBtn();
      if (this.canvas) this.canvas.style.cursor = this._canvasCursor();
    }, 'font-size:12px;');
    this._handBtn.title = '手のひらツール: ドラッグで表示を移動（右ドラッグ / Space＋ドラッグ / 中ボタンでも移動できます）';
    this._handBtn.setAttribute('aria-pressed', this.handTool ? 'true' : 'false');
    this._refreshHandBtn();
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
    // レイアウト診断 chip: 到達できない棚 / 床の分断 / 狭い通路 — live while you draw.
    // (Same chip the 動線 tab shows; this is the tab where shelves actually move.)
    this._auditChip = this._div(bar, 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;');
    this._renderAuditChip();
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
    // persistent pan/zoom hint (MapMaker discoverability — no docs needed).
    const hint = this._div(bar, 'margin-left:auto;color:var(--ink-tertiary);white-space:nowrap;');
    hint.textContent = '移動: 右ドラッグ / Space＋ドラッグ ・ ズーム: ホイール';
    this._stZoom = this._div(bar, '');
    parent.appendChild(bar);
  }

  // hand-tool button active state (the canvas bar is rebuilt per tool render).
  _refreshHandBtn() {
    if (!this._handBtn || !this._handBtn.isConnected) return;
    const base = 'padding:6px 10px;border:1px solid var(--line-hair);border-radius:var(--r-sm);'
      + 'background:var(--bg-app);color:var(--ink-primary);font-size:12px;cursor:pointer;';
    this._handBtn.style.cssText = this.handTool
      ? base + 'background:var(--ink-primary);color:var(--bg-app);border-color:var(--ink-primary);font-weight:700;'
      : base;
    this._handBtn.setAttribute('aria-pressed', this.handTool ? 'true' : 'false');
  }

  // The cursor the canvas should show when no drag is active (pan affordances win).
  _canvasCursor() {
    if (this._spaceDown || (this.handTool && this.tool === 'place')) return 'grab';
    if (this.tool === 'route') return 'crosshair';
    if (this.tool === 'flow') return this.flowMode ? 'pointer' : 'default';
    return this.brush && this.brush.kind === 'select' ? 'default' : 'crosshair';
  }

  _updateStatus() {
    if (!this._stPos) return;
    const h = this.hover;
    this._stPos.textContent = h ? `X ${h.mx.toFixed(2)}m  Y ${h.my.toFixed(2)}m` : 'X —  Y —';
    this._stBrush.textContent = `配置: ${this._brushLabel()}`;
    let sel = '';
    if (this.selObjs && this.selObjs.length) {
      sel = `${this._multiCount()}個選択中（${this._multiBreakdown()}）`;
    } else if (this.selShelves && this.selShelves.size) {
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
    if (!b || b.kind === 'select') return 'ライブラリから置きたい物を選択（またはカードを床へドラッグ）。クリックで編集、空き床をドラッグで範囲選択。';
    if (b.kind === 'rack') return 'クリック=1台 / ドラッグ=角から角で1枚。Esc・右クリックで選択に戻る。';
    if (b.kind === 'wall') return 'クリックで頂点追加（Shift=水平/垂直）、ダブルクリックで確定。';
    if (b.kind === 'equip' && b.key === 'conveyor') return 'クリックで頂点追加、ダブルクリックで確定。';
    if (b.kind === 'door') return '建屋の縁をクリックして配置。';
    return '床をクリックで配置。連続で置けます。Esc・右クリックで選択に戻る。';
  }
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
    // Right-drag = pan (MapMaker), so the menu is suppressed after a real drag.
    // A plain right-CLICK keeps its old meanings: back to 選択 while placing
    // (Minecraft "empty the hand"), browser menu otherwise.
    this._on(this.canvas, 'contextmenu', (e) => {
      if (this._suppressCtx) { e.preventDefault(); this._suppressCtx = false; return; }
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
    // Pan the camera (works in every tool so the view is always repositionable):
    //   middle-drag (CAD habit) / RIGHT-drag (MapMaker habit) /
    //   Space＋left-drag or the 🖐 hand tool (PowerPoint/Figma habit).
    if (e.button === 1 || e.button === 2
        || (e.button === 0 && (this._spaceDown || (this.handTool && this.tool === 'place')))) {
      if (e.button !== 2) e.preventDefault();
      this._startPan(px, py, e.button);
      return;
    }
    if (e.button !== 0 && e.button !== undefined) return;
    if (this.tool === 'place') return this._placeDown(px, py, e);
    if (this.tool === 'route') return this._routeDown(px, py);
    if (this.tool === 'flow') return this._flowDown(px, py);
  }
  _startPan(px, py, button) {
    const b = this.model.layout.bounds;
    this.drag = { mode: 'pan', button, moved: false, startPx: px, startPy: py,
      camCx: this._cam.cx == null ? b.width / 2 : this._cam.cx,
      camCy: this._cam.cy == null ? b.depth / 2 : this._cam.cy };
    if (this.canvas) this.canvas.style.cursor = 'grabbing';
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
    // Camera pan (middle/right/Space/hand drag): no model mutation, no undo entry.
    if (this.drag.mode === 'pan') {
      if (Math.abs(px - this.drag.startPx) + Math.abs(py - this.drag.startPy) > 2) this.drag.moved = true;
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
    // Rubber-band marquee (select tool, started on empty floor): pure selection
    // UI — no model mutation, no undo entry, just track + repaint.
    if (this.drag.mode === 'marquee') {
      if (this.marquee) { this.marquee.x1 = this.hover.mx; this.marquee.y1 = this.hover.my; }
      this._repaint();
      return;
    }
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
    } else if (this.drag.mode === 'groupMove') {
      // PowerPoint group drag: the whole multi-selection moves as one body.
      this._groupMoveApply(this._mx(px), this._my(py));
    }
    this._drawCanvas();
    this._updateStatus();
  }

  _onUp() {
    if (!this.drag) return;
    const mode = this.drag.mode;
    if (mode === 'pan') {
      // a real right-drag pan suppresses the context menu that follows mouseup.
      if (this.drag.button === 2 && this.drag.moved) this._suppressCtx = true;
      this.drag = null;
      if (this.canvas) this.canvas.style.cursor = this._canvasCursor();
      return;
    }
    if (mode === 'marquee') {
      const additive = !!this.drag.additive;
      this.drag = null;
      this._marqueeCommit(additive);
      return;
    }
    // a real mutation just ended (create / move / resize) — re-score the rail
    // with the FINAL geometry (the drag-start _pushUndo only saw the old state).
    const mutated = mode !== 'pan';
    if (mode === 'shelfCreate') { this._shelfCreateCommit(); this.drag = null; this.snapLine = null; this._renderSide(); this._repaint(); if (mutated) this._emitDirty(); return; }
    if (mode === 'shelfMove' || mode === 'shelfResize') {
      this.snapLine = null; this.drag = null; this._renderSide(); this._repaint(); this._updateStatus(); this._emitDirty(); return;
    }
    this.drag = null; this._renderSide(); this._updateStatus();
    if (mutated) this._emitDirty();
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
    this.marquee = null;  // a tap should not leave a dangling rubber-band
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
    this._emitDirty();
  }

  // Broadcast the live (UNSAVED) edit sections so the 採点表レール re-scores while
  // you edit — drag a shelf and 原価/人員/坪数 move, no save needed. Deduped by a
  // snapshot hash so a per-frame drag doesn't spam the bus (app.js also debounces).
  _emitDirty() {
    const sections = {
      layout: clone(this.model.layout),
      resources: clone(this.model.resources),
      process: clone(this.model.process),
      routes: clone(this.model.routes),
    };
    const sig = JSON.stringify(sections);
    if (sig === this._dirtySig) return;
    this._dirtySig = sig;
    document.dispatchEvent(new CustomEvent('whsim:design-dirty', { detail: { sections } }));
    // 動線タブ: re-run the レイアウト診断 on the live (unsaved) layout. Moving a
    // shelf that seals an aisle must flip the chip red immediately — no save.
    this._auditSoon();
  }
  _applySnapshot(snap) {
    this.model.layout = clone(snap.layout);
    this.model.resources = clone(snap.resources);
    this.model.process = clone(snap.process);
    this.model.routes = clone(snap.routes);
    this.selected = null;
    this.selShelves = new Set();
    this.selObjs = [];
    this.marquee = null;
    this.shelfDraft = null;
    this.snapLine = null;
    this.drag = null;
    this.conveyorDraft = this.wallDraft = this.routeDraft = null;
    this._renderTool();
    this._refreshUndoBtns();
    this._emitDirty();   // undo/redo changed the model → re-score the rail
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
    // Space release ends the temporary pan mode (cursor back to the tool's own).
    this._on(window, 'keyup', (e) => {
      if (e.code !== 'Space' || !this._spaceDown) return;
      this._spaceDown = false;
      if (this.canvas && (!this.drag || this.drag.mode !== 'pan')) {
        this.canvas.style.cursor = this._canvasCursor();
      }
    });
  }
  _onKey(e) {
    // Only act when the Designer is the visible surface and focus isn't in a field.
    if (!this.container || !this.container.isConnected || this.container.offsetParent === null) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    // Space held = temporary hand tool (left-drag pans; the page must not
    // scroll). Buttons OUTSIDE the designer keep their native Space activation;
    // inside, pan wins — a toolbar click leaves focus on that button, and
    // Space＋drag must still pan right after it (Enter still activates).
    if (e.code === 'Space') {
      if (tag === 'BUTTON' && !this.container.contains(e.target)) return;
      if (!this._spaceDown) {
        this._spaceDown = true;
        if (this.canvas && !this.drag) this.canvas.style.cursor = 'grab';
      }
      e.preventDefault();
      return;
    }
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
      } else if ((this.selShelves && this.selShelves.size) || (this.selObjs && this.selObjs.length)) {
        this.selShelves = new Set(); this.selObjs = []; this._renderTool();
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
      if (this.tool === 'place' && this.selObjs && this.selObjs.length) {
        e.preventDefault(); this._deleteMultiSelection(); return;
      }
      if (this.tool === 'place' && this.selShelves && this.selShelves.size) {
        e.preventDefault(); this._deleteShelves(); return;
      }
      if (this.selected) { e.preventDefault(); this._deleteSelected(); }
    }
  }
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

// ---- prototype synthesis ---------------------------------------------------
// Compose the extracted method groups onto Designer.prototype. Order is
// irrelevant (the groups are disjoint — no method name appears in two modules),
// and each method still runs with `this` bound to the Designer instance, so the
// shared mutable state and call graph are byte-for-byte what the monolith had.
Object.assign(
  Designer.prototype,
  libraryMethods,
  renderMethods,
  placeMethods,
  shelfMethods,
  selectMethods,
  flowMethods,
  routeMethods,
  sideMethods,
  sidePanelMethods,
);
