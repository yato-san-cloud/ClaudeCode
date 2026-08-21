// designer/flow.js — the フロー tool: the stage strip, the flow canvas (zones +
// arrows), 工程→エリア割当 (_flowDown / _layoutAreasFromFlow), the per-stage method
// panel (5-axis work method), and the work-method recommendation. Mixed into
// Designer.prototype by core.js (pure structural move).
//
// The 設備配線 half of the tool (設備ゴースト / エッジの直接操作 / エッジ・
// インスペクタ / 診断 / 物量ラベル) lives in ./flowwire.js and is spread into the
// same method bag below, so core.js's single Object.assign still mounts everything.
//
// SYNTHESIS: core.js does `Object.assign(Designer.prototype, flowMethods)`.

import {
  DEFAULT_WORK, METHOD_COLOR, METHOD_OPTS, PICK_STRATS, STAGE_ZONE_TYPES, WORK_AXES, ZONE_DEFAULT_COLOR, ZONE_JP,
} from './constants.js';
import { clone, hexA, snap, uid } from './geometry.js';
import { flowWireMethods } from './flowwire.js';

export const flowMethods = {
  ...flowWireMethods,
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
    // 配線の注意 (flow-graph diagnostics) live directly under the canvas: they are
    // warnings, so they get their own non-growing strip rather than a modal.
    this._fwDiagHost = document.createElement('div');
    this._fwDiagHost.style.cssText = 'flex:0 0 auto;max-height:120px;overflow-y:auto;';
    left.appendChild(this._fwDiagHost);
    this.body.appendChild(left);

    // right column: the workflow strip + pick strategy + (in-context) method panel
    this.side = document.createElement('div');
    this.side.style.cssText = 'width:340px;flex:0 0 340px;overflow-y:auto;border:1px solid var(--line-hair);border-radius:var(--r-md);background:var(--bg-sunken);padding:10px;';
    this.side.classList.add('dz-enter');
    this.body.appendChild(this.side);

    this.ctx = this.canvas.getContext('2d');
    this._bindCanvas();
    this._fitCanvas();
    this._fwEnsure();          // flow-graph wiring layer (loads once per mount)
    this._fwRenderDiagnostics();
    this._renderFlowSide();
    this._drawFlowCanvas();
  },
  // center of a zone in meters
  _zoneCenter(z) { return [z.x + z.w / 2, z.y + z.h / 2]; },
  _zoneById(id) { return (this.model.layout.zones || []).find((z) => z.id === id); },
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
  },
  _flowStatusText() {
    if (!this.flowMode) {
      // While a flow edge is selected the canvas is in wiring mode; say so.
      const wiring = this._fwStatusText();
      if (wiring) return wiring;
      return 'ゾーンをクリックすると作業方法、工程間の矢印をクリックすると搬送設備を設定できます。'
        + '「床図でフロー配置」で工程→ゾーンの割当を引けます。';
    }
    const order = this._orderedStages();
    const st = order[this.flowCursor];
    if (!st) return 'すべての工程にゾーンを割り当てました。「配置を終了」で完了します。';
    return `「${st.label || st.id}」の場所をクリックしてください（${this.flowCursor + 1}/${order.length}）。`;
  },
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

    // 設備ゴースト: the placed conveyors/equipment, muted, UNDER the zone+arrow
    // layer — you cannot wire a flow to a belt you cannot see.
    this._fwDrawEquipment();

    const order = this._orderedStages();
    const cursorStage = this.flowMode ? order[this.flowCursor] : null;

    // zones (clickable). Flat low-saturation tint + crisp hue border + rounded
    // corners, matching the 配置 tool; the open/cursor zone lifts with a glow.
    for (const z of this.model.layout.zones) {
      const color = z.color || ZONE_DEFAULT_COLOR[z.type] || '#cccccc';
      const isCursorTarget = this.flowMode && cursorStage != null;
      const boundStage = order.find((st) => st.zone === z.id);
      const isOpen = this.flowMethodStage && boundStage && boundStage.id === this.flowMethodStage;
      const zx = this._X(z.x), zt = this._Y(z.y + z.h), zw = z.w * sc, zh = z.h * sc;
      const rr = Math.min(6, zw / 2, zh / 2);
      ctx.save();
      if (isOpen) { ctx.shadowColor = hexA(P.sel, 0.5); ctx.shadowBlur = 14; }
      ctx.fillStyle = hexA(color, isOpen ? 0.18 : (boundStage ? 0.12 : 0.07));
      this._roundRectPath(zx, zt, zw, zh, rr); ctx.fill();
      ctx.restore();
      // faint rack hint inside storage so the biggest area doesn't read as empty.
      if (z.type === 'storage') {
        if (z.shelves && z.shelves.length) this._drawShelves(z, { hint: true });
        else if (z.rack) this._drawRack(z, { hint: true });
      }
      ctx.strokeStyle = isOpen ? P.sel : (isCursorTarget ? P.accent : hexA(color, 0.85));
      ctx.lineWidth = (isOpen || isCursorTarget) ? 2.4 : 1.5;
      if (isCursorTarget) ctx.setLineDash([6, 4]);
      this._roundRectPath(zx, zt, zw, zh, rr); ctx.stroke();
      ctx.setLineDash([]);
      // type chip at top-left; bound stage name(s) centred below the step badge.
      this._zoneChip(z.x, z.y + z.h, ZONE_JP[z.type] || z.type, color, false);
      const bound = order.filter((st) => st.zone === z.id).map((st) => st.label || st.id);
      if (bound.length) {
        const cx = this._X(z.x + z.w / 2), cy = this._Y(z.y + z.h / 2);
        ctx.fillStyle = P.ink; ctx.font = '600 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(bound.join('・'), cx, cy + 6);
      }
    }

    // directed flow ribbons. The wiring layer draws them first, coloured by the
    // transport that carries each leg (+ a tie-line to the bound belt); if it has
    // no drawable edge yet, we fall back to the historical accent ribbons between
    // consecutive bound zones — so the diagram is never empty.
    if (!this._fwDrawEdges()) {
      for (let i = 0; i < order.length - 1; i++) {
        const za = this._zoneById(order[i].zone), zb = this._zoneById(order[i + 1].zone);
        if (!za || !zb || za.id === zb.id) continue;
        const [ax, ay] = this._zoneCenter(za), [bx, by] = this._zoneCenter(zb);
        this._drawArrow(this._X(ax), this._Y(ay), this._X(bx), this._Y(by), P.accent);
      }
    }

    // numbered step badges on each bound stage's zone, tinted by the zone hue so
    // the badge, the ribbon and the area all read as one step.
    let step = 0;
    for (const st of order) {
      if (!st.zone) continue;
      const z = this._zoneById(st.zone);
      if (!z) continue;
      step += 1;
      const color = z.color || ZONE_DEFAULT_COLOR[z.type] || P.accent;
      const [zx, zy] = this._zoneCenter(z);
      const px = this._X(zx), py = this._Y(zy) - 24;
      ctx.save();
      ctx.shadowColor = hexA(color, 0.55); ctx.shadowBlur = 8;
      ctx.fillStyle = color; ctx.strokeStyle = P.markerStroke; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, 11, 0, 7); ctx.fill(); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(step), px, py);
    }
    // legend line: name the diagram so the numbered badges + ribbons read at a
    // glance as the material flow (入荷→…→出荷), not a debug overlay.
    this._flowLegend();
    // …plus a transport key, so the newly-coloured ribbons are readable.
    this._fwLegend();

    if (this._flowStatus) this._flowStatus.textContent = this._flowStatusText();
    if (!this.model.layout.zones.length) {
      ctx.fillStyle = P.inkFaint; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('レイアウトにゾーンがありません。「レイアウト」タブで配置してください。', w / 2, h / 2);
    }
  },
  // A flow ribbon: a gently bowed quadratic curve with a soft glow and a filled
  // arrowhead on the tangent — reads as マテリアルフロー, not a debug zigzag.
  _drawArrow(ax, ay, bx, by, color) {
    const ctx = this.ctx;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    // control point bowed perpendicular to the chord (~14% of its length).
    const bow = Math.min(48, len * 0.14);
    const nx = -dy / len, ny = dx / len;
    const cxp = (ax + bx) / 2 + nx * bow, cyp = (ay + by) / 2 + ny * bow;
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.shadowColor = color; ctx.shadowBlur = 7;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cxp, cyp, bx, by); ctx.stroke();
    ctx.restore();
    // arrowhead at ~62% along the curve, oriented along the local tangent.
    const t = 0.62, mt = 1 - t;
    const px = mt * mt * ax + 2 * mt * t * cxp + t * t * bx;
    const py = mt * mt * ay + 2 * mt * t * cyp + t * t * by;
    const tx = 2 * mt * (cxp - ax) + 2 * t * (bx - cxp);
    const ty = 2 * mt * (cyp - ay) + 2 * t * (by - cyp);
    const ang = Math.atan2(ty, tx), hl = 12;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(px + hl * 0.5 * Math.cos(ang), py + hl * 0.5 * Math.sin(ang));
    ctx.lineTo(px - hl * Math.cos(ang - 0.42), py - hl * Math.sin(ang - 0.42));
    ctx.lineTo(px - hl * Math.cos(ang + 0.42), py - hl * Math.sin(ang + 0.42));
    ctx.closePath(); ctx.fill();
    ctx.restore();
  },
  // one-line legend pill anchored bottom-left of the flow canvas (a solid pill so
  // it stays legible over whatever zone happens to sit in the corner).
  _flowLegend() {
    const ctx = this.ctx, { w, h } = this._view;
    const P = this.pal;
    const text = 'マテリアルフロー（工程順 ①→⑤）';
    ctx.save();
    ctx.font = '600 11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width;
    const padX = 9, pillH = 22, swatch = 26, gap = 8;
    const pw = padX * 2 + swatch + gap + tw;
    const x = 10, y = h - 10 - pillH;
    if (pw > w - 20) { ctx.restore(); return; }   // too narrow: skip rather than clip
    // pill background
    ctx.fillStyle = P.badgeBg;
    this._roundRectPath(x, y, pw, pillH, 7); ctx.fill();
    // sample ribbon swatch
    const cy = y + pillH / 2;
    ctx.strokeStyle = P.accent; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.shadowColor = P.accent; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(x + padX, cy); ctx.lineTo(x + padX + swatch, cy); ctx.stroke();
    ctx.shadowBlur = 0;
    // small arrowhead on the swatch
    ctx.fillStyle = P.accent;
    ctx.beginPath();
    ctx.moveTo(x + padX + swatch + 3, cy);
    ctx.lineTo(x + padX + swatch - 3, cy - 3);
    ctx.lineTo(x + padX + swatch - 3, cy + 3);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = P.selInk;
    ctx.fillText(text, x + padX + swatch + gap, cy + 0.5);
    ctx.restore();
  },
  // --- flow canvas click: place flow (assign zone) OR open the method popover ---
  _flowDown(px, py) {
    // Wiring layer first (not while laying the flow — that mode owns the clicks):
    // select an edge / bind it to the clicked equipment / unbind it. Returns true
    // only when it consumed the click, so the zone behaviour below is untouched.
    if (!this.flowMode && this._fwDown(px, py)) return;
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
  },
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
  },
  // Snapshot the process flow (id/label/zone+zone-type/method) and dispatch it
  // for any live listener (マテリアルフロー). Deduped: only emits on change.
  //
  // The payload now also carries the 設備配線 (edges/equipment). `stages` stays
  // first-class and always present — the existing consumer reads it — so this is
  // purely additive for anyone already on the bus.
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
    const wiring = this._fwEmitPayload();
    const snap = JSON.stringify([stages, wiring]);
    if (snap === this._flowSnap && !this._fwForceEmit) return;
    this._flowSnap = snap;
    const detail = { stages };
    if (wiring) { detail.edges = wiring.edges; detail.equipment = wiring.equipment; detail.authored = wiring.authored; }
    document.dispatchEvent(new CustomEvent('whsim:flow-changed',
      { detail: { ...detail, source: 'designer' } }));
  },
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
  },
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

    // エッジ・インスペクタ: the precise/keyboard path for the selected flow edge
    // (the canvas click is the fast path; both write the same edge).
    this._fwRenderInspector(s);

    // in-context method panel for the open stage
    const open = this.flowMethodStage
      ? this.model.process.stages.find((st) => st.id === this.flowMethodStage) : null;
    if (open) this._renderMethodPanel(s, open);

    this._h(s, 'ピッキング戦略（互換）');
    const psSel = this._select(s, PICK_STRATS, this.model.process.pick_strategy);
    this._on(psSel, 'change', () => { this.model.process.pick_strategy = psSel.value; });
    this._note(s, '5軸の作業方法を設定すると、こちらより優先されます。');
  },
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
    this._field(s, 'バッチ間隔（分）', () => this._num(Math.round((work.wave_interval_s || 1800) / 60), (v) => {
      work.wave_interval_s = Math.max(1, Math.round(v)) * 60;
      this._refreshMethodBanner(work);
    }, 1));

    this._refreshMethodBanner(work);
  },
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
  },
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
  },
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
  },
};
