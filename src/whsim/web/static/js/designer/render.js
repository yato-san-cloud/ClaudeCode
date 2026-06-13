// designer/render.js — the Canvas2D draw loop for the 配置 floor view: floor/grid,
// the placement ghost, every object glyph (shelves/racks/equipment/stations/walls/
// doors/conveyors), and the selection/handle chrome. Mixed into Designer.prototype
// by core.js; every method is moved verbatim (no pixel changes).
//
// SYNTHESIS: core.js does `Object.assign(Designer.prototype, renderMethods)`.

import {
  CP_HALF, DOOR_JP, DOOR_PALETTE, EQUIP_PALETTE, HANDLE, MOVER_COLOR, RACK_TYPES, ZONE_DEFAULT_COLOR, ZONE_JP,
} from './constants.js';
import { cellAddress, clamp, hexA, shelfCells, snap } from './geometry.js';

export const renderMethods = {
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
      const selSingle = this.tool === 'place' && this.selected && this.selected.kind === 'zone' && this.selected.id === z.id;
      // multi-selected zones get the selected outline, but no resize handle
      // (only a single selection exposes the zone's resize affordance).
      const sel = selSingle || (this.tool === 'place' && this._inMultiSel('zone', z.id));
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
      // resize handle + live size badge when (singly) selected
      if (selSingle) {
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
      for (const d of this.model.layout.doors) this._drawDoor(d, this._isSel('door', d.id) || this._inMultiSel('door', d.id));
    }

    // conveyors (under equipment glyphs)
    for (const cv of this.model.resources.conveyors) this._drawConveyor(cv.points, '#33a02c', false);
    if (this.conveyorDraft) this._drawConveyorDraft();

    // equipment + stations as CAD-style top-view glyphs (real-meter footprints)
    for (const e of this.model.resources.equipment) {
      this._drawEquipGlyph(e, this._isSel('equip', e.id) || this._inMultiSel('equip', e.id));
    }
    for (const s of this.model.resources.stations) {
      this._drawStationGlyph(s, this._isSel('station', s.id) || this._inMultiSel('station', s.id));
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
    // PowerPoint rubber-band rectangle while multi-selecting.
    if (this.tool === 'place' && this.marquee) this._drawMarquee();
  },
  // ---- marquee (rubber-band multi-select) rectangle --------------------------
  _drawMarquee() {
    const m = this.marquee;
    if (!m) return;
    const ctx = this.ctx;
    const CY = '#34E3FF';                           // same accent as the selection chrome
    const x0 = this._X(Math.min(m.x0, m.x1)), x1 = this._X(Math.max(m.x0, m.x1));
    const y0 = this._Y(Math.max(m.y0, m.y1)), y1 = this._Y(Math.min(m.y0, m.y1));
    ctx.save();
    ctx.fillStyle = hexA(CY, 0.08);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = CY;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  },
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
  },
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
  },
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
  },
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
  },
  _drawConveyorDraft() {
    this._drawConveyor(this.conveyorDraft, this.pal.draft, true);
  },
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
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
    // 棚番号 (location address) label at HIGH ZOOM: once cells are big enough on
    // screen, stamp each cell's 通路-連-段 address (bottom level) so the user can
    // read addresses off the floor plan. Mirrors design._address.
    if (this._view.sc >= 18) this._drawShelfAddresses(sh, rt);
  },
  // Per-cell 棚番号 labels (only when zoomed in enough that they won't overlap).
  _drawShelfAddresses(sh, rt) {
    const ctx = this.ctx;
    const cells = shelfCells(sh, rt);
    const bayPx = (rt.bay || 1) * this._view.sc;
    if (bayPx < 30) return;                  // too dense to label legibly
    ctx.fillStyle = this.pal.ink;
    ctx.font = '8px var(--font-mono, monospace)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [x, y] of cells) {
      ctx.fillText(cellAddress(x, y, 1), this._X(x), this._Y(y) + 6);
    }
  },
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
    // selection bbox + control points — shelf-only selections. A MIXED multi
    // selection (selObjs non-empty) shows per-object outlines instead; resize
    // handles would only act on the shelves, which reads as a bug.
    const bb = (this.selObjs && this.selObjs.length) ? null : this._selBBox();
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
  },
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
  },
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
  },
  _label(px, py, text) {
    const ctx = this.ctx;
    ctx.fillStyle = this.pal.ink; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(text, px, py);
  },
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
  },
  _isSel(kind, id) { return this.selected && this.selected.kind === kind && this.selected.id === id; },
};
