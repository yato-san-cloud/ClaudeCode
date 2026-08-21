// designer/route.js — the 動線 tool: aisle-network fetch/draw, A→B measure, route
// polyline drawing + table, save-measure-as-route, 工程フロー動線自動生成, and the
// レイアウト診断 + 人流アニメーション (design-time validation while you draw).
// Mixed into Designer.prototype by core.js (pure structural move).
//
// SYNTHESIS: core.js does `Object.assign(Designer.prototype, routeMethods)`.

import {
  AUDIT_DEBOUNCE_MS, MOVER_COLOR, MOVER_JP, MOVER_OPTS, MOVER_SPEED,
  PFLOW_TOUR_S, PFLOW_WALKERS,
} from './constants.js';
import { clamp, snap, uid } from './geometry.js';

export const routeMethods = {
  // ---- 動線 tool: floor view + control bar + live distance/time table ------
  _renderRoute() {
    if (!this.routeMode) this.routeMode = 'measure';   // 'measure' | 'draw'
    if (this.routeNetOn == null) this.routeNetOn = true;
    if (this.pflowOn == null) this.pflowOn = false;
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
    // 人流アニメーション: walkers on REAL routes — the fastest way to see whether
    // every棚 can actually be reached and the aisles connect (MapMaker風).
    const pfLbl = document.createElement('label');
    pfLbl.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;color:var(--ink-secondary);cursor:pointer;font-weight:700;';
    pfLbl.title = '入荷→ピック面→出荷を、壁・棚を迂回した実際の最短経路で人が歩きます。'
      + '止まったまま動かない棚があれば、そこは到達できていません。';
    const pfCb = document.createElement('input');
    pfCb.type = 'checkbox';
    pfCb.id = 'pflowToggle';
    pfCb.checked = !!this.pflowOn;
    this._on(pfCb, 'change', () => this._setPeopleFlow(pfCb.checked));
    pfLbl.appendChild(pfCb);
    pfLbl.appendChild(document.createTextNode('人流アニメーション'));
    bar.appendChild(pfLbl);
    left.appendChild(bar);

    // レイアウト診断 status chip (quiet green when everything is fine).
    const chipBar = document.createElement('div');
    chipBar.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-height:26px;';
    this._auditChip = chipBar;
    left.appendChild(chipBar);
    this._renderAuditChip();

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
  // Every DRAWN rack footprint, in floor metres — the JS mirror of the server's
  // `rackgeom.rack_rects`. Authored 棚 (ShelfArea) AND parametric zones both count:
  // the routing graph must see exactly what the canvas draws, otherwise the 動線
  // (and the audit built on it) would happily walk through a rack row.
  _rackRectsForRouting() {
    const out = [];
    for (const z of this.model.layout.zones || []) {
      if (z.type !== 'storage') continue;
      if (z.shelves && z.shelves.length) {
        for (const sh of z.shelves) {
          if (+sh.w > 0 && +sh.h > 0) out.push([+sh.x, +sh.y, +sh.w, +sh.h]);
        }
        continue;
      }
      if (!z.rack) continue;
      // Materialised locations reconstruct into the same runs render._drawRack draws.
      const locs = this._zoneLocations(z);
      if (locs.length) {
        for (const run of this._reconstructRuns(locs)) {
          out.push([run.x - run.depth / 2, run.y0, run.depth, run.y1 - run.y0]);
        }
        continue;
      }
      // Parametric fallback (nothing materialised yet) — mirrors _drawRack.
      const r = z.rack;
      const cs = +r.col_spacing || 4, mg = +r.margin || 0;
      if (z.w - 2 * mg <= 0 || z.h - 2 * mg <= 0) continue;
      const depth = Math.max(0.3, Math.min(cs * 0.42, 1.5));
      const y0 = z.y + mg, y1 = z.y + z.h - mg;
      for (let cx = z.x + mg + depth / 2; cx <= z.x + z.w - mg + 1e-6; cx += cs) {
        out.push([cx - depth / 2, y0, depth, y1 - y0]);
      }
    }
    return out;
  },
  _routeLayoutPayload() {
    const L = this.model.layout;
    return {
      bounds: { width: L.bounds.width, depth: L.bounds.depth },
      walls: (L.walls || []).map((w) => ({ points: w.points || [] })),
      shelves: this._rackRectsForRouting(),
    };
  },
  async _fetchRouteNet() {
    if (this._routeNetBusy) { this._routeNetAgain = true; return; }
    this._routeNetBusy = true;
    try {
      const res = await fetch('/api/routes/network', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...this._routeLayoutPayload(), include_edges: true, audit: true,
        }),
      });
      if (res.ok) {
        this.routeNet = await res.json();
        this.routeAudit = this.routeNet.audit || null;
        this._renderAuditChip();
        // the 動線 side panel hosts the findings list; 配置 keeps its inspector.
        if (this.tool === 'route') {
          this._renderRouteTable();
          if (this.pflowOn) this._fetchPeopleFlow();
        }
        this._drawCanvas();
      }
    } catch (_e) { /* offline: the tab still works for manual drawing */ }
    this._routeNetBusy = false;
    if (this._routeNetAgain) { this._routeNetAgain = false; this._fetchRouteNet(); }
  },
  // ---- レイアウト診断: live re-audit on every (debounced) layout edit --------
  // Moving a shelf that seals an aisle must turn the chip red *while you drag* —
  // that immediacy is the whole point, so this is wired to the designer's own
  // dirty bus (core._emitDirty) rather than to a save.
  _auditSoon() {
    // Runs in 配置 too — that is the tab where a shelf actually gets dragged
    // across an aisle, so that is where the chip has to go red.
    if (this.tool !== 'route' && this.tool !== 'place') return;
    if (this._auditTimer) clearTimeout(this._auditTimer);
    this._auditTimer = setTimeout(() => {
      this._auditTimer = 0;
      this._fetchRouteNet();
    }, AUDIT_DEBOUNCE_MS);
  },
  _auditSummary() {
    return (this.routeAudit && this.routeAudit.summary) || null;
  },
  // One-line verdict: {text, tone} where tone is ok|warn|bad.
  _auditVerdict() {
    const s = this._auditSummary();
    if (!s) return { text: '通路を診断中…', tone: 'idle' };
    if (s.unreachable_n > 0) return { text: `⚠ 到達できない棚 ${s.unreachable_n}`, tone: 'bad' };
    if (s.components > 1) return { text: `⚠ 床が分断 ${s.components}区画`, tone: 'bad' };
    if (s.narrow_person_n > 0) return { text: `△ 狭い通路 ${s.narrow_person_n}`, tone: 'warn' };
    if (!s.racks_n) return { text: '棚がまだありません', tone: 'idle' };
    return { text: '✓ 通路OK', tone: 'ok' };
  },
  _renderAuditChip() {
    const host = this._auditChip;
    if (!host) return;
    host.innerHTML = '';
    const s = this._auditSummary();
    const v = this._auditVerdict();
    const COLOR = {
      ok: ['var(--ok, #1db954)', 'rgba(29,185,84,0.12)'],
      warn: ['#d98200', 'rgba(217,130,0,0.14)'],
      bad: ['var(--bad, #e3401c)', 'rgba(227,64,28,0.14)'],
      idle: ['var(--ink-secondary)', 'var(--bg-sunken)'],
    };
    const mk = (text, tone, title) => {
      const [fg, bg] = COLOR[tone] || COLOR.idle;
      const el = document.createElement('span');
      el.textContent = text;
      el.style.cssText = `display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;`
        + `font-size:12px;font-weight:700;color:${fg};background:${bg};border:1px solid ${fg};`;
      if (title) el.title = title;
      host.appendChild(el);
      return el;
    };
    const main = mk(v.text, v.tone, 'レイアウト診断: 棚の到達性・床の連結・通路幅を、シミュレーションと同じ経路網で判定します。');
    main.id = 'auditChip';
    if (!s) return;
    if (s.narrow_n - s.narrow_person_n > 0) {
      mk(`フォークリフト不可の通路 ${s.narrow_n - s.narrow_person_n}`, 'warn',
        `幅 ${this.routeAudit.thresholds.forklift_m}m 未満の通路。人は通れますがフォークリフトは通れません。`);
    }
    if (s.min_aisle_m != null) {
      mk(`最小通路 ${s.min_aisle_m}m`, 'idle', '棚と棚（および壁）の間の最も狭い隙間。');
    }
  },
  // ---- 人流アニメーション ---------------------------------------------------
  _setPeopleFlow(on) {
    this.pflowOn = !!on;
    if (this.pflowOn) {
      this._fetchPeopleFlow();
    } else {
      this._pflowStop();
      this.pflowWalkers = null;
      this._drawCanvas();
    }
  },
  // Plausible origin/destination: 入荷 → ピック面 → 出荷/梱包. Falls back to the
  // floor edges so the animation runs even on a bare template ("never blocks").
  _pflowHub(types, fallback) {
    for (const t of types) {
      const z = (this.model.layout.zones || []).find((q) => q.type === t);
      if (z) return [z.x + z.w / 2, z.y + z.h / 2];
    }
    return fallback;
  },
  async _fetchPeopleFlow() {
    const b = this.model.layout.bounds;
    const picks = (this.routeAudit && this.routeAudit.pick_points) || [];
    if (!picks.length) { this.pflowWalkers = null; this._drawCanvas(); return; }
    const from = this._pflowHub(['receiving', 'staging'], [1, b.depth - 1]);
    const to = this._pflowHub(['shipping', 'packing'], [1, 1]);
    // Evenly sample pick faces across the whole rack field so the walkers spread.
    const n = Math.min(PFLOW_WALKERS, picks.length);
    const step = picks.length / n;
    const targets = [];
    for (let i = 0; i < n; i++) targets.push(picks[Math.floor(i * step)]);
    const queries = [];
    for (const p of targets) { queries.push({ a: from, b: p }); queries.push({ a: p, b: to }); }
    try {
      const res = await fetch('/api/routes/network', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...this._routeLayoutPayload(), queries }),
      });
      if (!res.ok) return;
      const d = await res.json();
      this.pflowWalkers = this._buildWalkers(d.paths || []);
      if (this.pflowOn) this._pflowStart();
    } catch (_e) { /* offline: no walkers, everything else still works */ }
  },
  // Turn (in-leg, out-leg) path pairs into looping walkers with staggered phases.
  _buildWalkers(paths) {
    const out = [];
    for (let i = 0; i + 1 < paths.length; i += 2) {
      const a = (paths[i] && paths[i].points) || [];
      const bpts = (paths[i + 1] && paths[i + 1].points) || [];
      if (a.length < 2 && bpts.length < 2) continue;
      const pts = a.concat(bpts.length && a.length ? bpts.slice(1) : bpts);
      if (pts.length < 2) continue;
      const cum = [0];
      let total = 0;
      for (let k = 1; k < pts.length; k++) {
        total += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        cum.push(total);
      }
      if (total < 0.5) continue;
      const pickAt = a.length ? Math.max(0, a.length - 1) : 0;
      const idx = out.length;
      out.push({
        pts, cum, total,
        pickDist: cum[Math.min(pickAt, cum.length - 1)],
        // Same wall-clock tour for everyone (so the flow reads as one cadence),
        // phase-shifted so they never march in a parade.
        dur: PFLOW_TOUR_S,
        phase: (idx * 0.618) % 1,
      });
    }
    return out;
  },
  _pflowStart() {
    if (this._reducedMotion()) { this._drawCanvas(); return; }  // static preview
    if (this._pflowRaf) return;
    this._pflowT0 = performance.now();
    const step = () => {
      this._pflowRaf = 0;
      if (!this.pflowOn || this.tool !== 'route' || !this.ctx) return;
      this._drawCanvas();
      this._pflowRaf = requestAnimationFrame(step);
    };
    this._pflowRaf = requestAnimationFrame(step);
  },
  _pflowStop() {
    if (this._pflowRaf) cancelAnimationFrame(this._pflowRaf);
    this._pflowRaf = 0;
  },
  // Point + heading at arc-length `d` along a walker's polyline.
  _pflowAt(w, d) {
    const { pts, cum } = w;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) {                       // binary search the segment
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid; else hi = mid;
    }
    const seg = Math.max(1e-9, cum[hi] - cum[lo]);
    const t = clamp((d - cum[lo]) / seg, 0, 1);
    const a = pts[lo], bb = pts[hi];
    return [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t,
      Math.atan2(bb[1] - a[1], bb[0] - a[0])];
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
      ctx.shadowColor = this.pal.accent; ctx.shadowBlur = 8;
      ctx.setLineDash([9, 6]);
      ctx.beginPath();
      ctx.moveTo(this._X(p.points[0][0]), this._Y(p.points[0][1]));
      for (let i = 1; i < p.points.length; i++) ctx.lineTo(this._X(p.points[i][0]), this._Y(p.points[i][1]));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      const mid = p.points[Math.floor(p.points.length / 2)];
      const t = p.distance_m / Math.max(0.1, +this.routeSpeed || 1.2);
      this._chipLabel(this._X(mid[0]), this._Y(mid[1]) - 14, `${p.distance_m.toFixed(1)} m / ${t.toFixed(0)} 秒`, 'center');
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
  // レイアウト診断の内訳 (右パネル): what is wrong, where, and how wide.
  _renderAuditPanel(s) {
    const a = this.routeAudit;
    this._h(s, 'レイアウト診断');
    if (!a) { this._note(s, '通路と棚の到達性を確認しています…'); return; }
    const sm = a.summary || {};
    const v = this._auditVerdict();
    const box = this._div(s, 'padding:8px 10px;border-radius:var(--r-md);margin-bottom:8px;font-size:12px;line-height:1.7;'
      + `border:1px solid ${v.tone === 'ok' ? 'var(--ok, #1db954)' : (v.tone === 'bad' ? 'var(--bad, #e3401c)' : '#d98200')};`
      + 'background:var(--bg-app);');
    box.innerHTML = `<div style="font-weight:700;font-size:13px;margin-bottom:2px;">${v.text}</div>`
      + `<div style="color:var(--ink-secondary);">棚 ${sm.racks_n ?? 0} / 到達不可 ${sm.unreachable_n ?? 0}`
      + ` ・ 床の区画 ${sm.components ?? 0} ・ 狭い通路 ${sm.narrow_n ?? 0}`
      + (sm.min_aisle_m != null ? ` ・ 最小通路 ${sm.min_aisle_m}m` : '') + '</div>';
    if ((a.unreachable || []).length) {
      this._note(s, '赤い棚は、通路からたどり着けません。前面をふさいでいる棚・壁を動かすか、通路を開けてください。');
      for (const u of a.unreachable.slice(0, 8)) {
        const why = u.reason === 'blocked' ? '全面が塞がれています' : '通路とつながっていません';
        this._note(s, `・棚 (${u.rect[0]}, ${u.rect[1]}) — ${why}`);
      }
    }
    const pockets = (a.components || []).filter((c) => !c.main);
    if (pockets.length) {
      this._note(s, `床が ${(a.components || []).length} 区画に分断されています（行き来できません）。`);
      for (const c of pockets.slice(0, 5)) this._note(s, `・孤立した床 ${c.area_m2}㎡ 付近 (${c.point[0]}, ${c.point[1]})`);
    }
    const narrow = a.narrow || [];
    if (narrow.length) {
      const th = a.thresholds || {};
      this._note(s, `通路幅の目安: 人 ${th.person_m}m / フォークリフト ${th.forklift_m}m`);
      for (const nz of narrow.filter((q) => q.level === 'person').slice(0, 6)) {
        this._note(s, `・幅 ${nz.gap_m}m × 長さ ${nz.length_m}m (人も通れません)`);
      }
      // フォークリフト不可 is usually the same width repeated across every aisle —
      // group it so the panel stays a summary, not a wall of identical rows.
      const byGap = new Map();
      for (const nz of narrow) {
        if (nz.level === 'person') continue;
        byGap.set(nz.gap_m, (byGap.get(nz.gap_m) || 0) + 1);
      }
      for (const [gap, cnt] of [...byGap].sort((x, y) => x[0] - y[0]).slice(0, 4)) {
        this._note(s, `・幅 ${gap}m の通路 ${cnt}本 (フォークリフト不可)`);
      }
    }
    if (v.tone === 'ok') {
      this._note(s, '棚はすべて通路からたどり着けて、床もつながっています。'
        + '「人流アニメーション」をONにすると、実際の経路を人が歩く様子で確認できます。');
    }
  },
  _renderRouteTable() {
    const s = this.side; if (!s) return;
    s.innerHTML = '';
    this._renderAuditPanel(s);

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
    ctx.save();
    // accent ribbon: a soft outer glow under a rounded stroke reads as a routed
    // path rather than a debug polyline.
    if (!draft) { ctx.shadowColor = color; ctx.shadowBlur = 8; }
    ctx.strokeStyle = color; ctx.lineWidth = draft ? 2.6 : 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (draft) ctx.setLineDash([7, 5]);
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(this._X(pts[0][0]), this._Y(pts[0][1]));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(this._X(pts[i][0]), this._Y(pts[i][1]));
      ctx.stroke();
    }
    ctx.restore();
    ctx.setLineDash([]);
    // endpoint dots (start + end only — no per-vertex noise on long auto paths).
    ctx.fillStyle = color;
    for (const p of [pts[0], pts[pts.length - 1]]) {
      ctx.beginPath(); ctx.arc(this._X(p[0]), this._Y(p[1]), 3.4, 0, 7); ctx.fill();
    }
    // direction arrowhead on the final segment.
    if (pts.length >= 2 && !draft) {
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      this._routeArrow(this._X(a[0]), this._Y(a[1]), this._X(b[0]), this._Y(b[1]), color);
    }
    // name + distance chip at the route start (reuses the shared pill label).
    if (name && pts.length) {
      const dist = this._routeLength(pts);
      this._chipLabel(this._X(pts[0][0]) + 8, this._Y(pts[0][1]) - 10,
        `${name} · ${dist.toFixed(1)}m`, 'left');
    }
  },
  // small filled arrowhead pointing from (ax,ay)→(bx,by), tip at (bx,by).
  _routeArrow(ax, ay, bx, by, color) {
    const ctx = this.ctx, ang = Math.atan2(by - ay, bx - ax), hl = 9;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - hl * Math.cos(ang - 0.42), by - hl * Math.sin(ang - 0.42));
    ctx.lineTo(bx - hl * Math.cos(ang + 0.42), by - hl * Math.sin(ang + 0.42));
    ctx.closePath(); ctx.fill();
    ctx.restore();
  },
};
