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
    this.equipBrush = 'agv';       // active palette key in 設備 tool
    this.doorBrush = 'dock';       // active door type in 躯体 tool
    this.buildMode = 'wall';       // 'wall' | 'door' within the 躯体 tool
    this.wallDraft = null;         // [[x,y],...] while drawing a wall polyline
    this.conveyorDraft = null;     // [[x,y],...] while drawing a conveyor
    this.routeMover = 'person';    // active mover for new 動線 routes
    this.routeSpeed = MOVER_SPEED.person; // active speed (m/s) for new routes
    this.routeDraft = null;        // [[x,y],...] while drawing a 動線 polyline
    this.drag = null;              // active drag state on the canvas
    this._listeners = [];          // [el, type, fn] for clean dispose()
    this._normalize(model);
    this._buildShell();
    this._selectTool('layout');
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
    if (this.tool === 'flow') return;
    this._fitCanvas();
    this._drawCanvas();
  }

  dispose() {
    for (const [el, type, fn] of this._listeners) el.removeEventListener(type, fn);
    this._listeners = [];
    if (this._raf) cancelAnimationFrame(this._raf);
    this.container.innerHTML = '';
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
        { id: 'receive', label: '入荷', method: 'manual' },
        { id: 'putaway', label: '格納', method: 'manual' },
        { id: 'pick', label: 'ピッキング', method: 'manual' },
        { id: 'pack', label: '梱包', method: 'manual' },
        { id: 'ship', label: '出荷', method: 'manual' },
      ];
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
    c.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;gap:8px;font-size:13px;';

    // tool switch bar
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';
    this._toolBtns = {};
    for (const [key, label] of [['layout', 'レイアウト'], ['equip', '設備'], ['building', '躯体'], ['flow', 'フロー'], ['route', '動線']]) {
      const b = document.createElement('button');
      b.textContent = label;
      this._on(b, 'click', () => this._selectTool(key));
      bar.appendChild(b);
      this._toolBtns[key] = b;
    }
    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    bar.appendChild(spacer);
    const save = document.createElement('button');
    save.className = 'primary';
    save.textContent = '適用（保存）';
    save.style.fontWeight = '700';
    this._on(save, 'click', () => this._save());
    bar.appendChild(save);
    this._saveBtn = save;
    this._saveMsg = document.createElement('span');
    this._saveMsg.style.cssText = 'font-size:12px;color:#6b7785;max-width:340px;';
    bar.appendChild(this._saveMsg);
    c.appendChild(bar);

    // body: canvas area + side editor (filled per tool)
    this.body = document.createElement('div');
    this.body.style.cssText = 'flex:1;min-height:0;display:flex;gap:8px;';
    c.appendChild(this.body);
  }

  _selectTool(key) {
    this.tool = key;
    this.selected = null;
    this.conveyorDraft = null;
    this.wallDraft = null;
    this.routeDraft = null;
    for (const k in this._toolBtns) {
      const active = k === key;
      const b = this._toolBtns[k];
      b.style.cssText = active
        ? 'background:#1f2733;color:#fff;border-color:#1f2733;font-weight:700;'
        : '';
    }
    this._renderTool();
  }

  _renderTool() {
    this.body.innerHTML = '';
    if (this.tool === 'flow') { this._renderFlow(); return; }
    if (this.tool === 'route') { this._renderRoute(); return; }
    // canvas-based tools (layout / equip) share the floor view + a side panel
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;min-width:0;position:relative;border:1px solid #e3e8ee;border-radius:8px;background:#fff;overflow:hidden;';
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:default;';
    wrap.appendChild(this.canvas);
    this.body.appendChild(wrap);

    this.side = document.createElement('div');
    this.side.style.cssText = 'width:240px;flex:0 0 240px;overflow-y:auto;border:1px solid #e3e8ee;border-radius:8px;background:#fafbfc;padding:10px;';
    this.body.appendChild(this.side);

    this.ctx = this.canvas.getContext('2d');
    this._bindCanvas();
    this._fitCanvas();
    this._renderSide();
    this._drawCanvas();
  }

  // ---- 動線 tool: floor view + control bar + live distance/time table ------
  _renderRoute() {
    // left column: control bar above the floor canvas
    const left = document.createElement('div');
    left.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;';

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;border:1px solid #e3e8ee;border-radius:8px;background:#fafbfc;';
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
    spLbl.style.cssText = 'font-size:12px;color:#6b7785;';
    bar.appendChild(spLbl);
    const spInp = this._num(this.routeSpeed, (v) => { this.routeSpeed = Math.max(0.1, v); }, 0.1);
    spInp.style.cssText += ';width:70px;padding:5px 7px;border:1px solid #e3e8ee;border-radius:6px;font-size:13px;';
    bar.appendChild(spInp);
    this._btn(bar, '新規ルート', () => {
      if (this.routeDraft && this.routeDraft.length >= 2) this._finishRoute();
      this.routeDraft = [];
      this.selected = null;
      this._renderRoute();
    });
    this._btn(bar, '確定', () => this._finishRoute());
    this._btn(bar, '削除', () => this._deleteSelectedRoute(), 'color:#b30000;');
    left.appendChild(bar);

    // floor canvas
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;min-height:0;position:relative;border:1px solid #e3e8ee;border-radius:8px;background:#fff;overflow:hidden;';
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:crosshair;';
    wrap.appendChild(this.canvas);
    left.appendChild(wrap);
    this.body.appendChild(left);

    // right column: live 動線一覧 table
    this.side = document.createElement('div');
    this.side.style.cssText = 'width:300px;flex:0 0 300px;overflow-y:auto;border:1px solid #e3e8ee;border-radius:8px;background:#fafbfc;padding:10px;';
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
      th.style.cssText = 'text-align:left;padding:4px 6px;border-bottom:2px solid #e3e8ee;color:#6b7785;font-weight:700;';
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
      tr.style.cssText = 'cursor:pointer;' + (selRow ? 'background:#eef2f7;font-weight:700;' : '');
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
        td.style.cssText = 'padding:4px 6px;border-bottom:1px solid #eef0f3;'
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
      td.style.cssText = 'padding:6px;border-top:2px solid #e3e8ee;font-weight:700;'
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
      this._btn(s, '削除', () => this._deleteSelectedRoute(), 'margin-top:10px;color:#b30000;');
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
    const b = this.model.layout.bounds;
    ctx.clearRect(0, 0, w, h);

    // floor
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5;
    ctx.strokeRect(this._X(0), this._Y(b.depth), b.width * sc, b.depth * sc);

    const dim = this.tool === 'equip' || this.tool === 'building' || this.tool === 'route';   // zones rendered faintly under equipment/walls/routes
    for (const z of this.model.layout.zones) {
      const sel = this.tool === 'layout' && this.selected && this.selected.kind === 'zone' && this.selected.id === z.id;
      const color = z.color || ZONE_DEFAULT_COLOR[z.type] || '#cccccc';
      ctx.fillStyle = hexA(color, dim ? 0.12 : (sel ? 0.42 : 0.3));
      ctx.fillRect(this._X(z.x), this._Y(z.y + z.h), z.w * sc, z.h * sc);
      ctx.strokeStyle = sel ? '#1f2733' : hexA(color, 0.8);
      ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeRect(this._X(z.x), this._Y(z.y + z.h), z.w * sc, z.h * sc);
      // rack preview grid for storage zones
      if (z.type === 'storage' && z.rack) this._drawRack(z);
      // label
      ctx.fillStyle = dim ? '#aab2bd' : '#3a4452';
      ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ZONE_JP[z.type] || z.type, this._X(z.x + z.w / 2), this._Y(z.y + z.h / 2));
      // resize handle when selected in layout tool
      if (sel) {
        ctx.fillStyle = '#1f2733';
        ctx.fillRect(this._X(z.x + z.w) - HANDLE, this._Y(z.y) - HANDLE, HANDLE, HANDLE);
      }
    }

    // conveyors (under markers)
    for (const cv of this.model.resources.conveyors) this._drawConveyor(cv.points, '#33a02c', false);
    if (this.conveyorDraft) this._drawConveyor(this.conveyorDraft, '#e31a1c', true);

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
        this._drawRoute(rt.points, sel ? '#1f2733' : color, false, rt.name);
        ctx.restore();
      }
      if (this.routeDraft) this._drawRoute(this.routeDraft, MOVER_COLOR[this.routeMover] || '#e31a1c', true, null);
    }

    // hint text
    if (this.tool === 'equip') {
      ctx.fillStyle = '#9aa4b0'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const hint = this.equipBrush === 'conveyor'
        ? 'コンベア: 床をクリックで頂点追加、ダブルクリックか「確定」で完了'
        : '床をクリックして設置 / マーカーをクリックで選択';
      ctx.fillText(hint, 8, 8);
    } else if (this.tool === 'building') {
      ctx.fillStyle = '#9aa4b0'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
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
    ctx.strokeStyle = sel ? '#1f2733' : (draft ? '#e31a1c' : '#5a6472');
    ctx.lineWidth = wpx; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (draft) ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(this._X(pts[0][0]), this._Y(pts[0][1]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(this._X(pts[i][0]), this._Y(pts[i][1]));
    ctx.stroke();
    ctx.setLineDash([]);
    // vertices
    ctx.fillStyle = sel ? '#1f2733' : (draft ? '#e31a1c' : '#5a6472');
    for (const p of pts) { ctx.beginPath(); ctx.arc(this._X(p[0]), this._Y(p[1]), 3, 0, 7); ctx.fill(); }
  }

  _drawDoor(d, sel) {
    const ctx = this.ctx, px = this._X(d.x), py = this._Y(d.y);
    const pal = DOOR_PALETTE.find((x) => x.type === d.type);
    const color = pal ? pal.color : '#888888';
    const half = Math.max(6, (+d.w || 1) * this._view.sc / 2);
    ctx.fillStyle = hexA(color, 0.55);
    ctx.strokeStyle = sel ? '#1f2733' : color;
    ctx.lineWidth = sel ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.rect(px - half, py - 6, half * 2, 12);
    ctx.fill(); ctx.stroke();
    this._label(px, py + 12, `${DOOR_JP[d.type] || d.type} ${(+d.w || 1)}m`);
  }

  _drawRack(z) {
    const ctx = this.ctx, r = z.rack;
    const cs = +r.col_spacing || 4, rs = +r.row_spacing || 3, mg = +r.margin || 0;
    if (z.w - 2 * mg <= 0 || z.h - 2 * mg <= 0) return;
    ctx.fillStyle = 'rgba(60,72,90,0.5)';
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
    ctx.fillStyle = color; ctx.strokeStyle = sel ? '#1f2733' : '#fff'; ctx.lineWidth = sel ? 2.5 : 1.5;
    ctx.beginPath(); ctx.arc(px, py, 9, 0, 7); ctx.fill(); ctx.stroke();
    this._label(px, py + 16, label);
  }
  _star(px, py, color, sel) {
    const ctx = this.ctx;
    ctx.fillStyle = color; ctx.strokeStyle = sel ? '#1f2733' : '#fff'; ctx.lineWidth = sel ? 2.5 : 1.2;
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
    ctx.fillStyle = '#3a4452'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(text, px, py);
  }
  _isSel(kind, id) { return this.selected && this.selected.kind === kind && this.selected.id === id; }

  // ---- canvas event handling ----------------------------------------------
  _bindCanvas() {
    this._on(this.canvas, 'mousedown', (e) => this._onDown(e));
    this._on(window, 'mousemove', (e) => this._onMove(e));
    this._on(window, 'mouseup', () => this._onUp());
    this._on(this.canvas, 'dblclick', (e) => this._onDbl(e));
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
  }

  // --- layout tool: select / move / resize zones ---
  _layoutDown(px, py) {
    // resize handle of the currently selected zone?
    const zs = this.model.layout.zones;
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
      const s = { id: uid('st'), zone: 'packing', x: mx, y: my, count: 1 };
      this.model.resources.stations.push(s);
      this.selected = { kind: 'station', id: s.id };
      this._renderSide(); this._drawCanvas();
    } else { // agv / asrs / robot_arm / crane
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

  _finishConveyor() {
    if (this.conveyorDraft && this.conveyorDraft.length >= 2) {
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
      if (this.buildMode === m) b.style.cssText += ';background:#1f2733;color:#fff;border-color:#1f2733;';
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
          this.model.layout.walls = this.model.layout.walls.filter((q) => q.id !== w.id);
          this.selected = null; this._renderSide(); this._drawCanvas();
        }, 'margin-top:10px;color:#b30000;');
      } else {
        this._note(s, '壁をクリックして選択すると編集・削除できます。');
      }
    } else {
      this._h(s, 'ドアの種類');
      const pal = this._div(s, 'display:flex;flex-direction:column;gap:4px;margin-bottom:8px;');
      for (const p of DOOR_PALETTE) {
        const b = this._btn(pal, p.label, () => { this.doorBrush = p.type; this._renderSide(); this._drawCanvas(); });
        if (this.doorBrush === p.type) b.style.cssText += ';background:#1f2733;color:#fff;border-color:#1f2733;';
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
          this.model.layout.doors = this.model.layout.doors.filter((q) => q.id !== d.id);
          this.selected = null; this._renderSide(); this._drawCanvas();
        }, 'margin-top:10px;color:#b30000;');
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

    const z = this.selected && this.selected.kind === 'zone'
      ? this.model.layout.zones.find((q) => q.id === this.selected.id) : null;
    if (!z) { this._note(s, 'ゾーンをクリックして選択すると編集できます。'); return; }

    this._h(s, '選択中のゾーン');
    // type
    this._field(s, '種別', () => {
      const sel = this._select(null, ZONE_TYPES.map((t) => ({ value: t, label: ZONE_JP[t] })), z.type);
      this._on(sel, 'change', () => {
        z.type = sel.value;
        if (z.type === 'storage' && !z.rack) z.rack = { col_spacing: 4, row_spacing: 3, margin: 2 };
        if (z.type !== 'storage') z.rack = null;
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
    // rack spacing (storage only) — live updates the preview grid
    if (z.type === 'storage') {
      if (!z.rack) z.rack = { col_spacing: 4, row_spacing: 3, margin: 2 };
      this._h(s, 'ラック（保管棚）');
      for (const [label, key] of [['列間隔 (m)', 'col_spacing'], ['段間隔 (m)', 'row_spacing'], ['余白 (m)', 'margin']]) {
        this._field(s, label, () => this._num(z.rack[key], (v) => { z.rack[key] = Math.max(0.1, v); this._drawCanvas(); }));
      }
    }
    this._btn(s, '削除', () => this._deleteZone(z.id), 'margin-top:10px;color:#b30000;');
  }

  _sideEquip(s) {
    this._h(s, '設備パレット');
    const pal = this._div(s, 'display:flex;flex-direction:column;gap:4px;margin-bottom:8px;');
    for (const p of EQUIP_PALETTE) {
      const b = this._btn(pal, p.label, () => { this.equipBrush = p.key; this.conveyorDraft = null; this._renderSide(); this._drawCanvas(); });
      if (this.equipBrush === p.key) b.style.cssText += ';background:#1f2733;color:#fff;border-color:#1f2733;';
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
        this._btn(s, '削除', () => { this.model.resources.equipment = this.model.resources.equipment.filter((q) => q.id !== e.id); this.selected = null; this._renderSide(); this._drawCanvas(); }, 'margin-top:10px;color:#b30000;');
      }
    } else if (sel && sel.kind === 'station') {
      const st = this.model.resources.stations.find((q) => q.id === sel.id);
      if (st) {
        this._h(s, '選択中: 梱包台');
        this._field(s, '台数', () => this._num(st.count, (v) => { st.count = Math.max(0, Math.round(v)); this._drawCanvas(); }, 1));
        this._btn(s, '削除', () => { this.model.resources.stations = this.model.resources.stations.filter((q) => q.id !== st.id); this.selected = null; this._renderSide(); this._drawCanvas(); }, 'margin-top:10px;color:#b30000;');
      }
    } else {
      this._note(s, '床をクリックして設置、または既存マーカーをクリックして編集します。');
    }

    if (this.model.resources.conveyors.length) {
      this._h(s, `コンベア (${this.model.resources.conveyors.length})`);
      const last = this.model.resources.conveyors[this.model.resources.conveyors.length - 1];
      this._btn(s, '最後のコンベアを削除', () => { this.model.resources.conveyors.pop(); this._drawCanvas(); this._renderSide(); });
    }
  }

  _addZone(type) {
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
    this.model.layout.zones = this.model.layout.zones.filter((z) => z.id !== id);
    this.selected = null;
    this._renderSide(); this._drawCanvas();
  }

  // ---- flow tool: workflow strip + pick strategy ---------------------------
  _renderFlow() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;min-width:0;overflow:auto;padding:14px;';
    this.body.appendChild(wrap);

    this._h(wrap, '作業フロー（工程ごとに作業方法を選択）');
    const strip = document.createElement('div');
    strip.style.cssText = 'display:flex;align-items:stretch;gap:0;flex-wrap:wrap;margin-bottom:18px;';
    const stages = this.model.process.stages;
    stages.forEach((st, i) => {
      const box = document.createElement('div');
      box.style.cssText = `display:flex;flex-direction:column;gap:8px;min-width:140px;padding:12px;border-radius:10px;border:2px solid ${METHOD_COLOR[st.method] || '#9aa4b0'};background:${hexA(METHOD_COLOR[st.method] || '#9aa4b0', 0.12)};`;
      const lbl = document.createElement('div');
      lbl.textContent = st.label || st.id;
      lbl.style.cssText = 'font-weight:700;font-size:14px;';
      box.appendChild(lbl);
      const sel = this._select(box, METHOD_OPTS, st.method);
      this._on(sel, 'change', () => { st.method = sel.value; this._renderTool(); });
      box.appendChild(sel);
      strip.appendChild(box);
      if (i < stages.length - 1) {
        const arrow = document.createElement('div');
        arrow.textContent = '→';
        arrow.style.cssText = 'display:flex;align-items:center;padding:0 10px;font-size:22px;color:#6b7785;';
        strip.appendChild(arrow);
      }
    });
    wrap.appendChild(strip);

    this._h(wrap, 'ピッキング戦略');
    const psSel = this._select(wrap, PICK_STRATS, this.model.process.pick_strategy);
    this._on(psSel, 'change', () => { this.model.process.pick_strategy = psSel.value; });
  }

  // ---- save ----------------------------------------------------------------
  async _save() {
    if (!this.handlers.save) { this._saveMsg.textContent = '保存ハンドラがありません。'; return; }
    if (this.tool === 'equip' && this.conveyorDraft) this._finishConveyor();
    if (this.tool === 'building' && this.wallDraft) this._finishWall();
    if (this.routeDraft && this.routeDraft.length >= 2) this._finishRoute();
    this.routeDraft = null;
    this._saveBtn.disabled = true;
    this._saveMsg.style.color = '#6b7785';
    this._saveMsg.textContent = '保存中…';
    try {
      const r = await this.handlers.save({
        layout: clone(this.model.layout),
        resources: clone(this.model.resources),
        process: clone(this.model.process),
        routes: clone(this.model.routes),
      });
      const prov = r && r.provenance_summary ? ` / ${r.provenance_summary}` : '';
      this._saveMsg.style.color = '#1a7a3c';
      this._saveMsg.textContent = '保存しました' + prov;
    } catch (err) {
      this._saveMsg.style.color = '#b30000';
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
    h.style.cssText = 'font-size:12px;font-weight:700;color:#6b7785;margin:10px 0 6px;';
    parent.appendChild(h); return h;
  }
  _note(parent, text) {
    const n = document.createElement('div');
    n.textContent = text;
    n.style.cssText = 'font-size:12px;color:#9aa4b0;line-height:1.5;';
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
    inp.style.cssText += ';width:96px;padding:5px 7px;border:1px solid #e3e8ee;border-radius:6px;font-size:13px;';
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
    sel.style.cssText = 'padding:5px 7px;border:1px solid #e3e8ee;border-radius:6px;font-size:13px;background:#fff;';
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
    b.style.cssText = 'padding:6px 10px;border:1px solid #e3e8ee;border-radius:6px;background:#fff;font-size:13px;cursor:pointer;' + (css || '');
    this._on(b, 'click', onClick);
    if (parent) parent.appendChild(b);
    return b;
  }
}
