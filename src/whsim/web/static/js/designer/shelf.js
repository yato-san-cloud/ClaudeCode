// designer/shelf.js — the M2 shelf editor: unified select/drag/resize hit-testing,
// edge snapping, corner-drag shelf creation + overlap warnings, 棚一括生成 / 面積
// オート生成, shelf duplicate/delete, and the modal-dialog helpers those tools use.
// Mixed into Designer.prototype by core.js (pure structural move).
//
// SYNTHESIS: core.js does `Object.assign(Designer.prototype, shelfMethods)`.

import {
  CONTROL_POINTS, CP_HALF, HANDLE, RACK_ORDER, RACK_TYPES, SHELFGEN_FACES, SHELF_MIN_M, SNAP_PX,
} from './constants.js';
import { clamp, uid } from './geometry.js';

export const shelfMethods = {
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
  },
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
  },
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
  },
  _snapWorldY(wy, hints) {
    if (this.noSnap) return null;
    let best = null, bestD = SNAP_PX + 1;
    const sy = this._Y(wy);
    for (const hy of hints.ys) {
      const d = Math.abs(this._Y(hy) - sy);
      if (d <= SNAP_PX && d < bestD) { bestD = d; best = hy; }
    }
    return best;
  },
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
  },
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
  },
  _selShelfObjs() {
    return this._allShelves().filter(({ sh }) => this.selShelves.has(sh.id));
  },
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
  },
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
  },
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
  },
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
  },
  // --- shelf name generation (prefix + counter, dedup; mirrors ShelfArrayGenerator) ---
  _usedShelfNames() {
    const used = new Set();
    for (const { sh } of this._allShelves()) if (sh.name) used.add(sh.name);
    return used;
  },
  _nextShelfName(prefix) {
    const used = this._usedShelfNames();
    const p = prefix && prefix.trim() ? prefix.trim() : '棚';
    let n = 1;
    let name = `${p}${String(n).padStart(2, '0')}`;
    while (used.has(name)) { n += 1; name = `${p}${String(n).padStart(2, '0')}`; }
    return name;
  },
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
  },
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
  },
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
  },
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
  },
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
  },
  // dialog field builders (label on the left, control on the right of the grid).
  _dlgLabel(parent, text) {
    const l = document.createElement('label');
    l.textContent = text;
    l.style.cssText = 'font-size:12px;color:var(--ink-secondary);';
    parent.appendChild(l);
    return l;
  },
  _dlgNum(parent, label, value) {
    this._dlgLabel(parent, label);
    const i = document.createElement('input');
    i.type = 'number';
    i.value = String(value);
    i.style.cssText = 'padding:5px 7px;border:1px solid var(--line-hair);border-radius:var(--r-sm);font-size:13px;background:var(--bg-app);color:var(--ink-primary);width:100%;box-sizing:border-box;';
    parent.appendChild(i);
    return i;
  },
  _dlgText(parent, label, value) {
    this._dlgLabel(parent, label);
    const i = document.createElement('input');
    i.type = 'text';
    i.value = value == null ? '' : String(value);
    i.style.cssText = 'padding:5px 7px;border:1px solid var(--line-hair);border-radius:var(--r-sm);font-size:13px;background:var(--bg-app);color:var(--ink-primary);width:100%;box-sizing:border-box;';
    parent.appendChild(i);
    return i;
  },
  _dlgSelect(parent, label, opts, value) {
    this._dlgLabel(parent, label);
    const sel = this._select(parent, opts, value);
    sel.style.cssText += ';width:100%;box-sizing:border-box;';
    return sel;
  },
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
  },
  _deleteShelves() {
    const ids = new Set(this.selShelves);
    if (!ids.size) return;
    this._pushUndo();
    for (const z of this._storageZones()) z.shelves = (z.shelves || []).filter((sh) => !ids.has(sh.id));
    this.selShelves = new Set();
    this._renderTool();
  },
};
