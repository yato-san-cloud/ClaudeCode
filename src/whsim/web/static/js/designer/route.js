// designer/route.js — the 動線 tool: aisle-network fetch/draw, A→B measure, route
// polyline drawing + table, save-measure-as-route, and 工程フロー動線自動生成.
// Mixed into Designer.prototype by core.js (pure structural move).
//
// SYNTHESIS: core.js does `Object.assign(Designer.prototype, routeMethods)`.

import {
  MOVER_COLOR, MOVER_JP, MOVER_OPTS, MOVER_SPEED,
} from './constants.js';
import { clamp, snap, uid } from './geometry.js';

export const routeMethods = {
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
  // length of a polyline in meters
  _routeLength(pts) {
    if (!Array.isArray(pts) || pts.length < 2) return 0;
    let d = 0;
    for (let i = 1; i < pts.length; i++) {
      d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    return d;
  },
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
  },
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
  },
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
  },
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
  },
  _deleteSelectedRoute() {
    if (!this.selected || this.selected.kind !== 'route') return;
    this._pushUndo();
    this.model.routes = this.model.routes.filter((q) => q.id !== this.selected.id);
    this.selected = null;
    this._renderRouteTable(); this._drawCanvas();
  },
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
  },
};
