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
      const zx = this._X(z.x), zt = this._Y(z.y + z.h), zw = z.w * sc, zh = z.h * sc;
      // Flat, very-low-saturation tinted fill (proposal-grade平面図トーン): the
      // hue reads as a wash, not a muddy slab. Selection lifts the tint + adds a
      // soft outer glow so it stands out without a heavy border.
      const rr = Math.min(6, zw / 2, zh / 2);
      ctx.save();
      if (sel) { ctx.shadowColor = hexA(P.sel, 0.45); ctx.shadowBlur = 14; }
      ctx.fillStyle = hexA(color, dim ? 0.06 : (sel ? 0.16 : 0.1));
      this._roundRectPath(zx, zt, zw, zh, rr); ctx.fill();
      ctx.restore();
      // crisp border in the zone hue (1.5px), heavier + accent when selected.
      ctx.strokeStyle = sel ? P.sel : hexA(color, dim ? 0.45 : 0.85);
      ctx.lineWidth = sel ? 2.2 : 1.5;
      this._roundRectPath(zx, zt, zw, zh, rr); ctx.stroke();
      // rack preview grid for storage zones (physical rack runs, drawn inside).
      // In the 動線 tool the runs render as a calm hint so the aisle network reads.
      const rackHint = { hint: this.tool === 'route' };
      if (z.type === 'storage' && z.shelves && z.shelves.length) this._drawShelves(z, rackHint);
      else if (z.type === 'storage' && z.rack) this._drawRack(z, rackHint);
      // name label as a small rounded chip pinned to the zone's top-left corner —
      // ink-on-tint, always legible, and (unlike a centred label) never fighting
      // the rack rows or the door notches on the left wall.
      this._zoneChip(z.x, z.y + z.h, ZONE_JP[z.type] || z.type, color, dim);
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
      for (const d of this.model.layout.doors) this._drawDoor(d, this._isSel('door', d.id) || this._inMultiSel('door', d.id), true);
      // door labels are laid out in a de-collided post-pass so a wall lined with
      // dock doors no longer shows a stack of overlapping/clipped 「ドックドア 3m」.
      this._drawDoorLabels();
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
      // auto-generated 通路ネットワーク: light DASHED aisle lines (corridors read
      // as walkable lanes, walls/shelves as holes) — the same graph the sim routes
      // on. Dashed + accent-tinted so it reads as an aisle map, not a debug grid.
      if (this.routeNetOn && this.routeNet && Array.isArray(this.routeNet.edges)) {
        ctx.save();
        ctx.strokeStyle = P.accent;
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = 1.2;
        ctx.lineCap = 'round';
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        for (const [x1, y1, x2, y2] of this.routeNet.edges) {
          ctx.moveTo(this._X(x1), this._Y(y1));
          ctx.lineTo(this._X(x2), this._Y(y2));
        }
        ctx.stroke();
        ctx.setLineDash([]);
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
  // ---- CAD grid (1m hairline / 5m accent) -----------------------------------
  // Barely-there engineering paper: 1m minor hairlines fade in only when close,
  // 5m major lines get a whisper more weight so the eye can still count spans.
  // Deliberately much fainter than the old grid so the floor never reads as
  // graph paper — the rack rows and zones own the ink now.
  _drawGrid() {
    const ctx = this.ctx, { sc } = this._view;
    const b = this.model.layout.bounds;
    if (sc < 2.5) return;                       // zoomed way out: skip the noise
    const x0 = this._X(0), x1 = this._X(b.width);
    const yTop = this._Y(b.depth), yBot = this._Y(0);
    const grid = this.pal.grid || 'rgba(128,140,160,0.18)';
    // minor fades 0→0.28 over the zoom range; major sits a touch above it.
    const minorA = Math.min(0.28, Math.max(0, (sc - 2.5) / 42));
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = grid;
    for (let gx = 0; gx <= b.width + 1e-6; gx += 1) {
      const major = gx % 5 === 0;
      if (!major && sc < 6) continue;           // minor lines only when close
      ctx.globalAlpha = major ? Math.min(0.34, minorA * 2.4 + 0.06) : minorA;
      const X = this._X(gx);
      ctx.beginPath(); ctx.moveTo(X, yTop); ctx.lineTo(X, yBot); ctx.stroke();
    }
    for (let gy = 0; gy <= b.depth + 1e-6; gy += 1) {
      const major = gy % 5 === 0;
      if (!major && sc < 6) continue;
      ctx.globalAlpha = major ? Math.min(0.34, minorA * 2.4 + 0.06) : minorA;
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
  // Which building edge a door sits on (its opening spans ALONG that wall). Used
  // to orient the notch and to place the label just inside the floor.
  _doorEdge(d) {
    const b = this.model.layout.bounds;
    const dl = Math.abs(d.x), dr = Math.abs(b.width - d.x);
    const db = Math.abs(d.y), dt = Math.abs(b.depth - d.y);
    const m = Math.min(dl, dr, db, dt);
    if (m === dl) return 'left';
    if (m === dr) return 'right';
    if (m === db) return 'bottom';
    return 'top';
  },
  // A door renders as a clean notch on its wall: the opening spans ALONG the wall
  // (a vertical slot on the left/right walls, a horizontal slot on top/bottom),
  // with a thin colour cap so it reads as an opening, not a floating chip. The
  // label is drawn separately (de-collided) unless `noLabel` is false.
  _drawDoor(d, sel, noLabel) {
    const ctx = this.ctx, px = this._X(d.x), py = this._Y(d.y), sc = this._view.sc;
    const pal = DOOR_PALETTE.find((x) => x.type === d.type);
    const color = pal ? pal.color : '#888888';
    const half = Math.max(6, (+d.w || 1) * sc / 2);
    const edge = this._doorEdge(d);
    const vert = edge === 'left' || edge === 'right';
    const cap = 4;                                   // notch thickness (px) into the floor
    ctx.save();
    ctx.fillStyle = hexA(color, sel ? 0.7 : 0.5);
    ctx.strokeStyle = sel ? this.pal.sel : color;
    ctx.lineWidth = sel ? 2.4 : 1.6;
    ctx.beginPath();
    if (vert) ctx.rect(px - cap, py - half, cap * 2, half * 2);
    else ctx.rect(px - half, py - cap, half * 2, cap * 2);
    ctx.fill(); ctx.stroke();
    // bright inner line = the actual clear opening on the wall centreline.
    ctx.strokeStyle = hexA(color, 0.95); ctx.lineWidth = 2;
    ctx.beginPath();
    if (vert) { ctx.moveTo(px, py - half + 1); ctx.lineTo(px, py + half - 1); }
    else { ctx.moveTo(px - half + 1, py); ctx.lineTo(px + half - 1, py); }
    ctx.stroke();
    ctx.restore();
    if (noLabel) return;
    this._label(px, py + 12, `${DOOR_JP[d.type] || d.type} ${(+d.w || 1)}m`);
  },
  // ---- de-collided door labels ----------------------------------------------
  // A wall lined with dock doors used to stamp one 「ドックドア 3m」 per door,
  // stacking into an unreadable clipped column. Instead: cluster consecutive
  // same-type doors on the same edge and print ONE chip ("ドックドア ×5") at the
  // cluster centre, clamped inside the floor so nothing clips the wall edge.
  _drawDoorLabels() {
    const doors = this.model.layout.doors || [];
    if (!doors.length) return;
    const groups = {};                              // edge → [{d, edge}]
    for (const d of doors) {
      const edge = this._doorEdge(d);
      (groups[edge] = groups[edge] || []).push(d);
    }
    const clusters = [];
    for (const edge of Object.keys(groups)) {
      const arr = groups[edge];
      const vert = edge === 'left' || edge === 'right';
      arr.sort((a, bb) => (vert ? a.y - bb.y : a.x - bb.x));
      let cur = null;
      for (const d of arr) {
        const pos = vert ? d.y : d.x;
        const gapM = ((+d.w || 1) * 2.5);           // merge if notches nearly touch
        if (cur && cur.type === d.type && Math.abs(pos - cur.last) <= gapM) {
          cur.n += 1; cur.last = pos; cur.sum += pos;
        } else {
          cur = { edge, vert, type: d.type, n: 1, first: pos, last: pos, sum: pos, w: +d.w || 1 };
          clusters.push(cur);
        }
      }
    }
    const b = this.model.layout.bounds;
    for (const c of clusters) {
      const mid = c.sum / c.n;
      const label = `${DOOR_JP[c.type] || c.type}${c.n > 1 ? ` ×${c.n}` : ` ${c.w}m`}`;
      let wx, wy, align;
      if (c.vert) {                                 // left/right wall → label inside, mid-height
        wx = c.edge === 'left' ? b.width * 0 : b.width;
        wy = mid;
        this._chipLabel(this._X(wx) + (c.edge === 'left' ? 8 : -8),
          this._Y(wy), label, c.edge === 'left' ? 'left' : 'right');
      } else {                                      // top/bottom wall
        wx = mid; wy = c.edge === 'bottom' ? 0 : b.depth;
        this._chipLabel(this._X(wx), this._Y(wy) + (c.edge === 'bottom' ? 14 : -14), label, 'center');
      }
    }
  },
  _drawShelves(z, o) {
    // Draw each authored SHELF area as a physical rack RUN (tinted by equipment
    // type, bay separators + pick-face stripe) via the shared _drawRackRun — so
    // authored shelves and materialised rack fills read with one visual language.
    const hint = !!(o && o.hint);
    const shelfMode = this.tool === 'place';
    for (const sh of z.shelves) {
      const rt = RACK_TYPES[sh.rack_type] || RACK_TYPES.medium;
      const bay = +sh.cell_w || rt.bay;
      const isSel = shelfMode && this.selShelves && this.selShelves.has(sh.id);
      this._drawRackRun(sh.x, sh.y, sh.w, sh.h, rt, { sel: isSel, facing: sh.facing, pitchLong: bay, hint });
      if (shelfMode && !hint) this._drawShelfDecor(sh, rt);
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
  // ---- parametric rack fill → physical rack RUNS ----------------------------
  // A storage zone with a parametric `rack` fill is materialised server-side into
  // a flat `model.locations` grid. Rendering each slot as a lone dot read as
  // graph-paper noise (and hundreds of shelves looked *invisible*). Instead we
  // group the zone's locations into column RUNS — the same reconstruction the
  // server PNG / replay use — and draw each as a real rack row. Falls back to the
  // parametric params only for a freshly-drawn zone whose locations aren't
  // materialised yet (materialise happens on save).
  _drawRack(z, o) {
    const hint = !!(o && o.hint);
    const locs = this._zoneLocations(z);
    if (locs.length) {
      const runs = this._reconstructRuns(locs);
      runs.forEach((run, i) => {
        const rt = RACK_TYPES[run.rack_type] || RACK_TYPES.medium;
        // alternate pick faces so neighbouring rows front the shared aisle.
        const facing = i % 2 === 0 ? 'right' : 'left';
        this._drawRackRun(run.x - run.depth / 2, run.y0, run.depth, run.y1 - run.y0, rt,
          { facing, pitchLong: run.pitch, hint });
      });
      return;
    }
    // parametric fallback (no materialised locations yet)
    const r = z.rack;
    const cs = +r.col_spacing || 4, rs = +r.row_spacing || 3, mg = +r.margin || 0;
    if (z.w - 2 * mg <= 0 || z.h - 2 * mg <= 0) return;
    const rt = RACK_TYPES[this.shelfType] || RACK_TYPES.medium;
    const depth = Math.max(0.3, Math.min(cs * 0.42, 1.5));
    const y0 = z.y + mg, y1 = z.y + z.h - mg;
    let i = 0;
    for (let cx = z.x + mg + depth / 2; cx <= z.x + z.w - mg + 1e-6; cx += cs, i++) {
      const facing = i % 2 === 0 ? 'right' : 'left';
      this._drawRackRun(cx - depth / 2, y0, depth, y1 - y0, rt, { facing, pitchLong: rs, hint });
    }
  },
  // Locations that fall inside a zone rect (point-in-rect; locations don't
  // back-reference their zone id, and geometry is robust to multiple zones).
  _zoneLocations(z) {
    const locs = this.model.locations;
    if (!Array.isArray(locs) || !locs.length) return [];
    const out = [], eps = 1e-6;
    for (const l of locs) {
      const lx = +l.x, ly = +l.y;
      if (lx >= z.x - eps && lx <= z.x + z.w + eps && ly >= z.y - eps && ly <= z.y + z.h + eps) out.push(l);
    }
    return out;
  },
  // Group a flat location list into column RUNS (JS mirror of the server-side
  // render/shelves._reconstructed_runs): slots sharing an X become one vertical
  // rack-run rectangle spanning y0..y1.
  _reconstructRuns(locs) {
    const xs = locs.map((l) => +l.x), ys = locs.map((l) => +l.y);
    const pitchX = this._minGap(xs, 4.0);
    const pitchY = this._minGap(ys, 1.0);
    const depth = Math.max(0.3, Math.min(pitchX * 0.42, 1.5));
    const pad = pitchY * 0.5;
    const cols = new Map();
    for (const l of locs) {
      const k = Math.round(+l.x * 10) / 10;
      if (!cols.has(k)) cols.set(k, []);
      cols.get(k).push(l);
    }
    const runs = [];
    for (const [x, items] of cols) {
      let y0 = Infinity, y1 = -Infinity, rtid = 'medium';
      for (const l of items) { y0 = Math.min(y0, +l.y); y1 = Math.max(y1, +l.y); rtid = l.rack_type || rtid; }
      runs.push({ x, y0: y0 - pad, y1: y1 + pad, depth, pitch: pitchY, rack_type: rtid });
    }
    runs.sort((a, bb) => a.x - bb.x);
    return runs;
  },
  _minGap(vals, def) {
    const u = [...new Set(vals.map((v) => Math.round(v * 1000) / 1000))].sort((a, bb) => a - bb);
    let g = Infinity;
    for (let i = 1; i < u.length; i++) { const d = u[i] - u[i - 1]; if (d > 1e-6) g = Math.min(g, d); }
    return Number.isFinite(g) ? g : def;
  },
  // ---- one physical rack RUN (shared by authored shelves + parametric fills) -
  // A tinted body with a soft drop shadow, crisp border, bay separators along the
  // long axis, a darker back edge and a bright pick-face (間口) stripe — so a run
  // reads as a real rack row, not a slab of dots. `hint` = a calm faint variant
  // for the 動線/フロー context (body only, no internals).
  _drawRackRun(rx, ry, rw, rh, rt, o) {
    o = o || {};
    const ctx = this.ctx, sc = this._view.sc;
    const L = this._X(rx), R = this._X(rx + rw);
    const T = this._Y(ry + rh), B = this._Y(ry);
    const wPx = R - L, hPx = B - T;
    if (wPx < 1.2 || hPx < 1.2) return;
    const col = (rt && rt.color) || '#8a93a0';
    const vertical = rh >= rw;
    const sel = !!o.sel, hint = !!o.hint;
    const rr = Math.min(3, wPx / 3, hPx / 3);
    // fill (+ soft drop shadow — skipped mid-drag/pan so a big rack field pans
    // smoothly; the shadow reappears when the gesture ends). A restrained tint so
    // runs read as outlined rack rows on a calm floor, not neon bars.
    ctx.save();
    if (!hint && !this.drag) { ctx.shadowColor = 'rgba(10,16,24,0.28)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1.5; }
    ctx.fillStyle = hexA(col, hint ? 0.1 : (sel ? 0.3 : 0.16));
    this._roundRectPath(L, T, wPx, hPx, rr); ctx.fill();
    ctx.restore();
    // crisp body border
    ctx.strokeStyle = hexA(col, sel ? 0.95 : (hint ? 0.28 : 0.62));
    ctx.lineWidth = sel ? 1.8 : 1;
    this._roundRectPath(L, T, wPx, hPx, rr); ctx.stroke();
    if (hint) return;
    ctx.save();
    ctx.lineCap = 'butt';
    // bay separators along the long axis (only when a bay is wide enough on screen)
    const pitch = Math.max(0.3, +o.pitchLong || (rt && rt.bay) || 1);
    if (pitch * sc >= 5) {
      ctx.strokeStyle = hexA(col, 0.3); ctx.lineWidth = 1; ctx.beginPath();
      if (vertical) {
        for (let y = ry + pitch; y < ry + rh - 1e-6; y += pitch) { const Y = this._Y(y); ctx.moveTo(L + 1, Y); ctx.lineTo(R - 1, Y); }
      } else {
        for (let x = rx + pitch; x < rx + rw - 1e-6; x += pitch) { const X = this._X(x); ctx.moveTo(X, T + 1); ctx.lineTo(X, B - 1); }
      }
      ctx.stroke();
    }
    // darker back edge + bright pick-face stripe (間口/facing)
    const facing = o.facing || (vertical ? 'right' : 'down');
    const line = (x1, y1, x2, y2, style, lw) => { ctx.strokeStyle = style; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
    if (vertical) {
      const faceLeft = facing === 'left';
      line(faceLeft ? R : L, T + 1, faceLeft ? R : L, B - 1, hexA(col, 0.7), 1.8);    // back
      line(faceLeft ? L : R, T + 1, faceLeft ? L : R, B - 1, hexA(col, 0.9), 2.4);    // pick face
    } else {
      const faceUp = facing === 'up';
      line(L + 1, faceUp ? B : T, R - 1, faceUp ? B : T, hexA(col, 0.7), 1.8);        // back
      line(L + 1, faceUp ? T : B, R - 1, faceUp ? T : B, hexA(col, 0.9), 2.4);        // pick face
    }
    ctx.restore();
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
  // size badge in metres (e.g. "12.0 × 8.0 m"), tucked just BELOW the zone's
  // name chip at the top-left so the two never overlap on a selected zone.
  _sizeBadge(z) {
    const ctx = this.ctx;
    const text = `${(+z.w || 0).toFixed(1)} × ${(+z.h || 0).toFixed(1)} m`;
    const px = this._X(z.x) + 6, py = this._Y(z.y + z.h) + 28;
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const w = ctx.measureText(text).width;
    ctx.fillStyle = this.pal.badgeBg;
    ctx.fillRect(px, py, w + 8, 16);
    ctx.fillStyle = this.pal.selInk;
    ctx.fillText(text, px + 4, py + 2);
  },
  // rounded-rect path helper (uses native roundRect when available). Leaves the
  // current path set so the caller can fill()/stroke() it.
  _roundRectPath(x, y, w, h, r) {
    const ctx = this.ctx;
    r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  },
  // zone name chip pinned to the zone's top-left corner (ink-on-tint pill), kept
  // inside the floor so an edge-hugging zone's label never clips off-canvas.
  _zoneChip(wx, wtop, label, hue, dim) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '600 11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width;
    const padX = 7, chipH = 18;
    const b = this.model.layout.bounds;
    let cx = Math.max(this._X(wx) + 6, this._X(0) + 4);
    let cy = Math.max(this._Y(wtop) + 6, this._Y(b.depth) + 4);
    ctx.globalAlpha = dim ? 0.55 : 1;
    ctx.fillStyle = hexA(hue, dim ? 0.14 : 0.2);
    this._roundRectPath(cx, cy, tw + padX * 2, chipH, 5); ctx.fill();
    ctx.strokeStyle = hexA(hue, dim ? 0.3 : 0.6); ctx.lineWidth = 1;
    this._roundRectPath(cx, cy, tw + padX * 2, chipH, 5); ctx.stroke();
    ctx.fillStyle = dim ? this.pal.inkDim : this.pal.ink;
    ctx.fillText(label, cx + padX, cy + chipH / 2 + 0.5);
    ctx.restore();
  },
  // small solid pill label (badge bg + sel ink) anchored by align: left|center|right.
  _chipLabel(px, py, text, align) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '600 10.5px sans-serif'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width;
    const padX = 6, h = 16;
    let x = px;
    if (align === 'center') x = px - tw / 2 - padX;
    else if (align === 'right') x = px - tw - padX * 2;
    const y = py - h / 2;
    ctx.fillStyle = this.pal.badgeBg;
    this._roundRectPath(x, y, tw + padX * 2, h, 5); ctx.fill();
    ctx.fillStyle = this.pal.selInk; ctx.textAlign = 'left';
    ctx.fillText(text, x + padX, py + 0.5);
    ctx.restore();
  },
  _isSel(kind, id) { return this.selected && this.selected.kind === kind && this.selected.id === id; },
};
