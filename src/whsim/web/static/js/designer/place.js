// designer/place.js — the 配置 placement pointer + commit logic: stamping a brush
// (rack/zone/equip/door) onto the floor, zone hit-tests + compatibility checks,
// zone add/delete, selection delete, and finishing the wall/conveyor/door drafts.
// Mixed into Designer.prototype by core.js (pure structural move).
//
// SYNTHESIS: core.js does `Object.assign(Designer.prototype, placeMethods)`.

import {
  DOOR_PALETTE, EQUIP_ZONE_RULES, RACK_TYPES, ZONE_DEFAULT_COLOR, ZONE_JP,
} from './constants.js';
import { clamp, snap, uid } from './geometry.js';

export const placeMethods = {
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
  },
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
  },
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
  },
  // Top-most zone containing the point (zones later in the list draw on top).
  _zoneAt(mx, my) {
    const zs = this.model.layout.zones || [];
    for (let i = zs.length - 1; i >= 0; i--) {
      const z = zs[i];
      if (mx >= z.x && mx <= z.x + z.w && my >= z.y && my <= z.y + z.h) return z;
    }
    return null;
  },
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
  },
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
  },
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
  },
  _finishConveyor() {
    if (this.conveyorDraft && this.conveyorDraft.length >= 2) {
      this._pushUndo();
      const cv = { id: uid('cv'), points: this.conveyorDraft.slice(), speed_mps: 0.5 };
      this.model.resources.conveyors.push(cv);
    }
    this.conveyorDraft = null;
    this._renderSide(); this._drawCanvas();
  },
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
  },
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
  },
  _distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  },
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
  },
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
  },
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
  },
  _deleteZone(id) {
    this._pushUndo();
    this.model.layout.zones = this.model.layout.zones.filter((z) => z.id !== id);
    this.selected = null;
    this._renderSide(); this._drawCanvas();
  },
};
