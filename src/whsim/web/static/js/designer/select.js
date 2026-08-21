// designer/select.js — PowerPoint-style multi-select for the 配置 tool: the
// rubber-band marquee (left-drag on empty floor), the mixed multi-selection
// state (`selObjs` = non-shelf objects, joining the existing `selShelves`),
// Shift-click toggling, and the group operations (move-together / delete-all).
// Mixed into Designer.prototype by core.js (same synthesis as the siblings).
//
// SYNTHESIS: core.js does `Object.assign(Designer.prototype, selectMethods)`.
//
// Selection model recap (one union, three fields):
//   this.selected   — single non-shelf object {kind,id} (rich inspector)
//   this.selShelves — Set of shelf ids (the M2 shelf multi-select)
//   this.selObjs    — [{kind,id}] non-shelf objects in a MULTI selection
//                     (kind: 'zone' | 'equip' | 'station' | 'door')
// `selected` and `selObjs` are mutually exclusive: promoting to multi migrates
// the single selection in; collapsing to one object restores `selected` so the
// full per-object inspector comes back. Walls stay single-select only.

import { clamp, snap } from './geometry.js';

const MULTI_KINDS = ['zone', 'equip', 'station', 'door'];
const MULTI_KIND_JP = { zone: 'ゾーン', equip: '設備', station: '梱包台', door: 'ドア' };

export const selectMethods = {
  // ---- selection-union accessors --------------------------------------------
  _inMultiSel(kind, id) {
    return !!(this.selObjs && this.selObjs.some((q) => q.kind === kind && q.id === id));
  },
  _multiCount() {
    return ((this.selObjs && this.selObjs.length) || 0)
      + ((this.selShelves && this.selShelves.size) || 0);
  },
  // Resolve a multi-selection ref to its live model object (or null if gone).
  _multiObj(ref) {
    const L = this.model.layout, R = this.model.resources;
    if (ref.kind === 'zone') return (L.zones || []).find((q) => q.id === ref.id) || null;
    if (ref.kind === 'equip') return (R.equipment || []).find((q) => q.id === ref.id) || null;
    if (ref.kind === 'station') return (R.stations || []).find((q) => q.id === ref.id) || null;
    if (ref.kind === 'door') return (L.doors || []).find((q) => q.id === ref.id) || null;
    return null;
  },
  // Japanese object-type breakdown of the union, e.g. 「棚3・ゾーン1・梱包台2」.
  _multiBreakdown() {
    const parts = [];
    if (this.selShelves && this.selShelves.size) parts.push(`棚${this.selShelves.size}`);
    const counts = {};
    for (const ref of this.selObjs || []) counts[ref.kind] = (counts[ref.kind] || 0) + 1;
    for (const k of MULTI_KINDS) if (counts[k]) parts.push(`${MULTI_KIND_JP[k]}${counts[k]}`);
    return parts.join('・');
  },
  // Fold a lingering single selection into the multi union (Shift-click on a
  // second object must keep the first one selected, PowerPoint-style).
  _migrateSelectedToMulti() {
    const s = this.selected;
    if (s && MULTI_KINDS.includes(s.kind) && !this._inMultiSel(s.kind, s.id)) {
      this.selObjs = (this.selObjs || []).concat([{ kind: s.kind, id: s.id }]);
    }
    this.selected = null;
  },
  // Shift-click toggle of one non-shelf object in/out of the multi selection.
  _toggleMultiObj(kind, id) {
    this._migrateSelectedToMulti();
    this.selObjs = this.selObjs || [];
    const i = this.selObjs.findIndex((q) => q.kind === kind && q.id === id);
    if (i >= 0) this.selObjs.splice(i, 1);
    else this.selObjs.push({ kind, id });
    // a lone object collapses back to the rich single-object inspector.
    if (this.selObjs.length === 1 && !(this.selShelves && this.selShelves.size)) {
      this.selected = this.selObjs[0];
      this.selObjs = [];
    }
    this._renderSide(); this._repaint(); this._updateStatus();
  },
  // ---- marquee (rubber-band) commit -----------------------------------------
  // Select every object INTERSECTING the dragged world-space rectangle:
  // shelves / zones / equipment / stations / doors. Walls are excluded (they
  // stay single-select via their own hit-test). A tiny drag is just the
  // click-on-empty that already cleared the selection on mousedown.
  _marqueeCommit(additive) {
    const m = this.marquee;
    this.marquee = null;
    if (!m) return;
    const l = Math.min(m.x0, m.x1), r = Math.max(m.x0, m.x1);
    const t = Math.min(m.y0, m.y1), b = Math.max(m.y0, m.y1);
    if (r - l < 0.15 && b - t < 0.15) {
      this._renderSide(); this._repaint(); this._updateStatus();
      return;
    }
    if (additive) this._migrateSelectedToMulti();
    const shelves = additive ? new Set(this.selShelves) : new Set();
    const objs = additive ? (this.selObjs || []).slice() : [];
    const addObj = (kind, id) => {
      if (!objs.some((q) => q.kind === kind && q.id === id)) objs.push({ kind, id });
    };
    const rectHit = (x, y, w, h) => x < r && x + w > l && y < b && y + h > t;
    const ptHit = (x, y) => x >= l && x <= r && y >= t && y <= b;
    for (const { sh } of this._allShelves()) {
      if (rectHit(sh.x, sh.y, sh.w, sh.h)) shelves.add(sh.id);
    }
    for (const z of this.model.layout.zones || []) if (rectHit(z.x, z.y, z.w, z.h)) addObj('zone', z.id);
    for (const q of this.model.resources.equipment || []) if (ptHit(+q.x, +q.y)) addObj('equip', q.id);
    for (const q of this.model.resources.stations || []) if (ptHit(+q.x, +q.y)) addObj('station', q.id);
    for (const d of this.model.layout.doors || []) if (ptHit(+d.x, +d.y)) addObj('door', d.id);
    // normalize: one lone object → single select; shelves-only → the M2 path.
    this.selected = null;
    if (objs.length === 1 && !shelves.size) {
      this.selObjs = [];
      this.selShelves = new Set();
      this.selected = objs[0];
    } else {
      this.selObjs = objs.length ? objs : [];
      this.selShelves = shelves;
    }
    if (shelves.size) {
      const first = this._allShelves().find(({ sh }) => shelves.has(sh.id));
      if (first) this.shelfZoneId = first.zone.id;
    }
    const n = this._multiCount() + (this.selected ? 1 : 0);
    if (this._layoutStatus) {
      this._layoutStatus.style.color = 'var(--ink-secondary)';
      this._layoutStatus.textContent = n
        ? `${n}個のオブジェクトを選択しました。ドラッグでまとめて移動、Deleteで削除。`
        : this._brushHint();
    }
    if (this.lib) this._renderLibrary(this.lib);  // 棚カードの「選択中に適用」表示を更新
    this._renderSide(); this._repaint(); this._updateStatus();
  },
  // ---- group move (the whole union moves as one) -----------------------------
  // Captures original positions + the union bbox so the DELTA can be clamped —
  // the formation never deforms against the floor edge. Undo: the generic
  // first-movement snapshot in _onMove makes the whole gesture ONE undo entry.
  _groupMoveStart(mx, my) {
    const shelves = this._selShelfObjs().map(({ sh }) => ({ sh, ox: sh.x, oy: sh.y }));
    const objs = [];
    for (const ref of this.selObjs || []) {
      const o = this._multiObj(ref);
      if (o) {
        objs.push({ ref, o, ox: +o.x || 0, oy: +o.y || 0,
          w: ref.kind === 'zone' ? +o.w || 0 : 0, h: ref.kind === 'zone' ? +o.h || 0 : 0 });
      }
    }
    if (!shelves.length && !objs.length) return false;
    let l = Infinity, r = -Infinity, t = Infinity, btm = -Infinity;
    const acc = (x, y, w, h) => {
      l = Math.min(l, x); r = Math.max(r, x + w);
      t = Math.min(t, y); btm = Math.max(btm, y + h);
    };
    for (const it of shelves) acc(it.ox, it.oy, it.sh.w, it.sh.h);
    for (const it of objs) acc(it.ox, it.oy, it.w, it.h);
    this.drag = { mode: 'groupMove', downX: mx, downY: my, shelves, objs,
      bb: { l, r, t, b: btm } };
    return true;
  },
  // Apply the (grid-snapped, bounds-clamped) delta to every member. Doors stay
  // projected onto the building envelope (MapMaker discipline survives a group move).
  _groupMoveApply(mx, my) {
    const b = this.model.layout.bounds;
    const d = this.drag, bb = d.bb;
    let dx = snap(mx - d.downX), dy = snap(my - d.downY);
    dx = clamp(dx, -bb.l, Math.max(-bb.l, b.width - bb.r));
    dy = clamp(dy, -bb.t, Math.max(-bb.t, b.depth - bb.b));
    for (const it of d.shelves) { it.sh.x = it.ox + dx; it.sh.y = it.oy + dy; }
    for (const it of d.objs) {
      if (it.ref.kind === 'door') {
        const pos = this._snapDoorPos(it.ox + dx, it.oy + dy);
        it.o.x = pos.x; it.o.y = pos.y;
      } else {
        it.o.x = it.ox + dx; it.o.y = it.oy + dy;
      }
    }
  },
  // ---- group delete (one undo entry for the whole union) ---------------------
  _deleteMultiSelection() {
    const objIds = { zone: new Set(), equip: new Set(), station: new Set(), door: new Set() };
    for (const ref of this.selObjs || []) if (objIds[ref.kind]) objIds[ref.kind].add(ref.id);
    const shelfIds = new Set(this.selShelves || []);
    const n = shelfIds.size + ((this.selObjs && this.selObjs.length) || 0);
    if (!n) return;
    this._pushUndo();
    const L = this.model.layout, R = this.model.resources;
    for (const z of this._storageZones()) {
      z.shelves = (z.shelves || []).filter((sh) => !shelfIds.has(sh.id));
    }
    L.zones = L.zones.filter((z) => !objIds.zone.has(z.id));
    R.equipment = R.equipment.filter((q) => !objIds.equip.has(q.id));
    R.stations = R.stations.filter((q) => !objIds.station.has(q.id));
    L.doors = L.doors.filter((q) => !objIds.door.has(q.id));
    this.selObjs = [];
    this.selShelves = new Set();
    this.selected = null;
    this._renderTool();
    if (this._layoutStatus) {
      this._layoutStatus.style.color = 'var(--ink-secondary)';
      this._layoutStatus.textContent = `${n}個のオブジェクトを削除しました（Ctrl/⌘+Zで元に戻せます）。`;
    }
  },
};
