// designer/library.js — the object LIBRARY (Minecraft-style hotbar/palette) for
// the 配置 tool: brush arming, the scrollable card list, the canvas-drawn top-view
// icons (棚/ゾーン/設備/壁/ドア), rack-type pick/assign, and the storage-zone
// accessors. Mixed into Designer.prototype by core.js; methods keep `this`-state
// semantics identical to the pre-split class (pure structural move).
//
// SYNTHESIS: core.js does `Object.assign(Designer.prototype, libraryMethods)`.

import {
  DOOR_PALETTE, EQUIP_PALETTE, LAYOUT_PALETTE, LIBRARY_DIGITS, RACK_ORDER, RACK_SILHOUETTE_FALLBACK, RACK_TYPES, ZONE_DEFAULT_COLOR, ZONE_JP, ZONE_TYPES,
} from './constants.js';
import { hexA } from './geometry.js';

export const libraryMethods = {
  // ===========================================================================
  // The object LIBRARY (Minecraft-style hotbar/palette).
  // Every placeable thing is a visual card in one scrollable panel, grouped by
  // category (編集 / 保管設備(棚) / ゾーン / マテハン設備 / 躯体). Clicking a card
  // arms it as the active brush; dragging a card onto the floor places it at the
  // drop point. Digit keys 1-9 jump to the pinned brushes (MapMaker parity).
  // ===========================================================================
  _setBrush(brush) {
    this.brush = brush || { kind: 'select' };
    // leaving a draft-y brush cancels its in-progress polyline.
    if (this.brush.kind !== 'wall') this.wallDraft = null;
    if (!(this.brush.kind === 'equip' && this.brush.key === 'conveyor')) this.conveyorDraft = null;
    this.shelfDraft = null;
    this.snapLine = null;
    if (this.brush.kind !== 'select') { this.selected = null; this.selShelves = new Set(); }
    if (this.canvas) this.canvas.style.cursor = this.brush.kind === 'select' ? 'default' : 'crosshair';
    if (this._layoutStatus) {
      this._layoutStatus.style.color = 'var(--ink-secondary)';
      this._layoutStatus.textContent = this._brushHint();
    }
    if (this.lib) this._renderLibrary(this.lib);
    this._renderSide();
    this._updateStatus();
    this._repaint();
  },
  // digit→brush map: digit 3 is "棚" = the ACTIVE rack type.
  _digitBrush(d) {
    const ent = LIBRARY_DIGITS.find((q) => q.digit === d);
    if (!ent) return null;
    if (ent.kind === 'rack') return { kind: 'rack', key: this.shelfType };
    return { kind: ent.kind, key: ent.key };
  },
  _digitFor(kind, key) {
    const ent = LIBRARY_DIGITS.find((q) => q.kind === kind && (q.kind === 'rack' || q.kind === 'select' || q.kind === 'wall' || q.key === key));
    return ent ? ent.digit : null;
  },
  _renderLibrary(host) {
    host.innerHTML = '';
    const sec = (title) => {
      const h = this._div(host, 'font-size:11px;font-weight:700;color:var(--ink-tertiary);'
        + 'letter-spacing:.06em;margin:10px 2px 5px;');
      h.textContent = title;
      return h;
    };
    const b = this.brush || {};

    // --- 編集 ---------------------------------------------------------------
    sec('編集');
    host.appendChild(this._libCard({
      icon: this._selIcon(), label: '選択 / 移動', sub: 'クリックで選択・ドラッグで移動',
      active: b.kind === 'select', digit: this._digitFor('select'),
      onPick: () => this._setBrush({ kind: 'select' }),
    }));

    // --- 保管設備（棚） -------------------------------------------------------
    sec('保管設備（棚）');
    // bulk tools row (apply to the active rack type)
    const tools = this._div(host, 'display:flex;gap:5px;margin:0 0 6px;');
    const bulkBtn = this._btn(tools, '一括生成', () => this._openBulkGenDialog(), 'flex:1;font-size:11.5px;padding:4px 4px;');
    bulkBtn.title = '間口の向き・連結数を指定してまとめて生成';
    const areaBtn = this._btn(tools, '面積生成', () => {
      this._setBrush({ kind: 'rack', key: this.shelfType, area: true });
    }, 'flex:1;font-size:11.5px;padding:4px 4px;');
    areaBtn.title = '矩形をドラッグで描くと棚列＋通路を自動でタイル配置';
    if (b.kind === 'rack' && b.area) areaBtn.style.cssText += ';background:var(--ink-primary);color:var(--bg-app);border-color:var(--ink-primary);font-weight:700;';
    // multi storage-zone: which zone receives new shelves
    const stores = this._storageZones();
    if (stores.length > 1) {
      if (!this.shelfZoneId || !stores.find((z) => z.id === this.shelfZoneId)) this.shelfZoneId = stores[0].id;
      const zrow = this._div(host, 'display:flex;align-items:center;gap:5px;margin:0 0 6px;font-size:11px;color:var(--ink-secondary);');
      zrow.appendChild(document.createTextNode('配置先:'));
      const sel = this._select(zrow, stores.map((z, i) => ({ value: z.id, label: `保管ゾーン${i + 1}` })), this.shelfZoneId);
      sel.style.flex = '1';
      this._on(sel, 'change', () => { this.shelfZoneId = sel.value; this.selShelves = new Set(); this._repaint(); });
    }
    const selCount = (this.selShelves && this.selShelves.size) || 0;
    if (selCount) {
      this._div(host, 'font-size:10.5px;color:var(--ink-tertiary);margin:0 2px 5px;')
        .textContent = `カードを押すと選択中の ${selCount} 棚に種別を適用`;
    }
    RACK_ORDER.forEach((key) => {
      const rt = RACK_TYPES[key];
      if (!rt) return;
      const selType = selCount ? this._selectionRackType() : null;
      const active = selCount ? selType === key : (b.kind === 'rack' && !b.area && (b.key || this.shelfType) === key)
        || (b.kind === 'rack' && b.area && this.shelfType === key);
      host.appendChild(this._libCard({
        icon: this._rackIcon(rt), label: rt.label,
        sub: `間口${rt.bay}×奥行${rt.depth}m・${rt.levels || 1}段・収容${rt.capacity || 0}`,
        title: rt.desc || rt.label, color: rt.color, active,
        digit: key === this.shelfType ? this._digitFor('rack') : null,
        drag: { kind: 'rack', key },
        onPick: () => this._pickRackType(key),
      }));
    });

    // --- ゾーン ---------------------------------------------------------------
    sec('ゾーン（区画）');
    for (const t of ZONE_TYPES) {
      host.appendChild(this._libCard({
        icon: this._zoneIcon(t), label: ZONE_JP[t] || t,
        sub: this._zoneDefaults(t).desc, color: ZONE_DEFAULT_COLOR[t],
        active: b.kind === 'zone' && b.key === t,
        digit: t === 'storage' ? this._digitFor('zone', 'storage') : null,
        drag: { kind: 'zone', key: t },
        onPick: () => this._setBrush({ kind: 'zone', key: t }),
      }));
    }

    // --- マテハン設備 ----------------------------------------------------------
    sec('マテハン設備');
    for (const p of EQUIP_PALETTE) {
      host.appendChild(this._libCard({
        icon: this._equipIcon(p), label: p.label,
        sub: p.w ? `${p.w}×${p.d}m` : 'ライン（頂点を描く）',
        title: p.desc || p.label, color: p.color,
        active: b.kind === 'equip' && b.key === p.key,
        digit: this._digitFor('equip', p.key),
        drag: p.key === 'conveyor' ? null : { kind: 'equip', key: p.key },
        onPick: () => this._setBrush({ kind: 'equip', key: p.key }),
      }));
    }

    // --- 躯体 ------------------------------------------------------------------
    sec('躯体（建屋）');
    host.appendChild(this._libCard({
      icon: this._wallIcon(), label: '壁', sub: '頂点をクリック・Shift=直交・W×繰返',
      active: b.kind === 'wall', digit: this._digitFor('wall'),
      onPick: () => this._setBrush({ kind: 'wall' }),
    }));
    for (const p of DOOR_PALETTE) {
      host.appendChild(this._libCard({
        icon: this._doorIcon(p), label: p.label,
        sub: p.type === 'dock' ? 'トラック接車口 (幅3m)' : p.type === 'shutter' ? '大型開口 (幅4m)' : '人の出入口 (幅1m)',
        color: p.color,
        active: b.kind === 'door' && b.key === p.type,
        digit: this._digitFor('door', p.type),
        drag: { kind: 'door', key: p.type },
        onPick: () => this._setBrush({ kind: 'door', key: p.type }),
      }));
    }
  },
  // One library card: [icon] label/sub [digit]. Draggable when opts.drag is set.
  _libCard(opts) {
    const card = document.createElement('button');
    card.type = 'button';
    card.title = opts.title || opts.label;
    card.setAttribute('aria-pressed', opts.active ? 'true' : 'false');
    const accent = opts.color || 'var(--acc)';
    card.style.cssText = 'display:flex;align-items:center;gap:7px;width:100%;box-sizing:border-box;'
      + 'text-align:left;padding:5px 7px;margin:0 0 4px;border-radius:var(--r-md);cursor:pointer;'
      + `border:2px solid ${opts.active ? accent : 'var(--line-hair)'};`
      + `background:${opts.active ? hexA(typeof accent === 'string' && accent[0] === '#' ? accent : '#39c2ff', 0.14) : 'var(--bg-app)'};`
      + 'color:var(--ink-primary);';
    card.appendChild(opts.icon);
    const txt = this._div(card, 'flex:1;min-width:0;');
    const name = this._div(txt, 'font-size:12px;font-weight:700;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
    name.textContent = opts.label;
    if (opts.sub) {
      const sub = this._div(txt, 'font-size:10px;color:var(--ink-tertiary);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;');
      sub.textContent = opts.sub;
    }
    if (opts.digit) {
      const kb = this._div(card, 'flex:0 0 auto;font-size:10px;color:var(--ink-tertiary);border:1px solid var(--line-hair);'
        + 'border-radius:4px;padding:0 4px;line-height:15px;font-variant-numeric:tabular-nums;');
      kb.textContent = String(opts.digit);
    }
    this._on(card, 'click', opts.onPick);
    // drag a card onto the canvas → place at the drop point (and arm the brush).
    if (opts.drag) {
      card.draggable = true;
      this._on(card, 'dragstart', (e) => {
        this._dragBrush = opts.drag;
        try { e.dataTransfer.setData('text/plain', JSON.stringify(opts.drag)); } catch (_e) { /* IE-ish */ }
        e.dataTransfer.effectAllowed = 'copy';
      });
      this._on(card, 'dragend', () => { this._dragBrush = null; this.hover = null; this._repaint(); });
    }
    return card;
  },
  // The canvas accepts library-card drops: dragover tracks the ghost, drop stamps.
  _bindCanvasDrop(wrap) {
    this._on(wrap, 'dragover', (e) => {
      if (!this._dragBrush) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const r = this.canvas.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      this.hover = { mx: this._mx(px), my: this._my(py), px, py, ghost: this._dragBrush };
      this._repaint();
      this._updateStatus();
    });
    this._on(wrap, 'drop', (e) => {
      if (!this._dragBrush) return;
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      const mx = this._mx(e.clientX - r.left), my = this._my(e.clientY - r.top);
      const brush = this._dragBrush;
      this._dragBrush = null;
      this._setBrush(brush);          // arm it (so repeat-placement continues)…
      this._stampAt(brush, mx, my);   // …and place this first one at the drop point.
    });
  },
  // ---- tiny library icons (top-view, canvas-drawn so they match the floor) --
  _iconCanvas(bg) {
    const W = 26, H = 22, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = document.createElement('canvas');
    c.width = W * dpr; c.height = H * dpr;
    c.style.cssText = `width:${W}px;height:${H}px;flex:0 0 auto;border-radius:3px;background:${bg};`;
    c.setAttribute('aria-hidden', 'true');
    const x = c.getContext('2d');
    x.scale(dpr, dpr);
    return [c, x, W, H];
  },
  _selIcon() {
    const [c, x, W, H] = this._iconCanvas('var(--bg-sunken)');
    // cursor arrow
    x.fillStyle = '#9aa4b0'; x.strokeStyle = '#9aa4b0'; x.lineWidth = 1.2;
    x.beginPath();
    x.moveTo(9, 4); x.lineTo(9, 16); x.lineTo(12.2, 13); x.lineTo(14.6, 18);
    x.lineTo(16.6, 17); x.lineTo(14.2, 12.2); x.lineTo(18.5, 12); x.closePath();
    x.fill();
    return c;
  },
  _zoneIcon(t) {
    const color = ZONE_DEFAULT_COLOR[t] || '#999';
    const [c, x, W, H] = this._iconCanvas(hexA(color, 0.10));
    x.fillStyle = hexA(color, 0.35); x.strokeStyle = color; x.lineWidth = 1.4;
    x.fillRect(4, 4, W - 8, H - 8); x.strokeRect(4, 4, W - 8, H - 8);
    return c;
  },
  _wallIcon() {
    const [c, x, W, H] = this._iconCanvas('var(--bg-sunken)');
    x.strokeStyle = '#8a93a0'; x.lineWidth = 3; x.lineCap = 'square';
    x.beginPath(); x.moveTo(4, H - 5); x.lineTo(4, 5); x.lineTo(W - 5, 5); x.stroke();
    return c;
  },
  _doorIcon(p) {
    const [c, x, W, H] = this._iconCanvas(hexA(p.color, 0.10));
    // wall segment with a gap + swing arc = the universal plan-view door symbol
    x.strokeStyle = '#8a93a0'; x.lineWidth = 2.4;
    x.beginPath(); x.moveTo(2, 6); x.lineTo(8, 6); x.stroke();
    x.beginPath(); x.moveTo(18, 6); x.lineTo(W - 2, 6); x.stroke();
    x.strokeStyle = p.color; x.lineWidth = 1.4;
    x.beginPath(); x.moveTo(8, 6); x.lineTo(8, 17); x.stroke();          // leaf
    x.beginPath(); x.arc(8, 6, 11, 0, Math.PI / 2); x.stroke();          // swing
    return c;
  },
  _equipIcon(p) {
    const [c, x, W, H] = this._iconCanvas(hexA(p.color, 0.10));
    x.strokeStyle = p.color; x.fillStyle = p.color; x.lineWidth = 1.4; x.lineCap = 'round';
    if (p.key === 'agv') {
      // rounded chassis + 2 wheels + heading notch
      x.globalAlpha = 0.9; x.strokeRect(5, 7, W - 10, H - 13);
      x.globalAlpha = 0.5; x.fillRect(7, H - 5.4, 4, 2); x.fillRect(W - 11, H - 5.4, 4, 2);
      x.globalAlpha = 1;
      x.beginPath(); x.moveTo(W - 5, H / 2 - 2.5); x.lineTo(W - 2.4, H / 2); x.lineTo(W - 5, H / 2 + 2.5); x.closePath(); x.fill();
    } else if (p.key === 'conveyor') {
      // belt with rollers
      x.strokeRect(3, 8, W - 6, 6);
      x.globalAlpha = 0.7;
      for (let cx = 6; cx < W - 4; cx += 4) { x.beginPath(); x.arc(cx, 11, 1.2, 0, 7); x.stroke(); }
      x.globalAlpha = 1;
    } else if (p.key === 'asrs') {
      // high-bay block + crane aisle
      x.globalAlpha = 0.9; x.strokeRect(4, 4, 7, H - 8); x.strokeRect(W - 11, 4, 7, H - 8);
      x.setLineDash([2, 2]); x.beginPath(); x.moveTo(W / 2, 4); x.lineTo(W / 2, H - 4); x.stroke(); x.setLineDash([]);
      x.globalAlpha = 1;
    } else if (p.key === 'station') {
      // work bench: table top + legs
      x.strokeRect(4, 7, W - 8, 7);
      x.beginPath(); x.moveTo(6, 14); x.lineTo(6, 18); x.moveTo(W - 6, 14); x.lineTo(W - 6, 18); x.stroke();
    } else if (p.key === 'robot_arm') {
      // base + articulated arm
      x.beginPath(); x.arc(8, H - 7, 3.4, 0, 7); x.fill();
      x.lineWidth = 2.2;
      x.beginPath(); x.moveTo(8, H - 7); x.lineTo(14, 8); x.lineTo(20, 11); x.stroke();
      x.lineWidth = 1.4;
      x.beginPath(); x.arc(20.5, 11.2, 1.8, 0, 7); x.stroke();
    } else { // crane
      // gantry: two rails + trolley hook
      x.beginPath(); x.moveTo(4, 6); x.lineTo(W - 4, 6); x.moveTo(4, H - 6); x.lineTo(W - 4, H - 6); x.stroke();
      x.lineWidth = 2.4; x.beginPath(); x.moveTo(W / 2, 6); x.lineTo(W / 2, H - 6); x.stroke();
      x.lineWidth = 1.4; x.beginPath(); x.arc(W / 2, H / 2, 2, 0, 7); x.stroke();
    }
    return c;
  },
  // Zone-brush defaults: footprint + a one-line description for the card.
  _zoneDefaults(t) {
    const p = LAYOUT_PALETTE.find((q) => q.zoneType === t);
    const base = { w: p ? p.w : 10, h: p ? p.h : 6 };
    const desc = {
      receiving: '入荷・検品の区画', storage: '棚の容れ物（保管区画）',
      picking: 'ピッキング区画', packing: '梱包・出荷検品の区画',
      shipping: '出荷バース前の区画', staging: '一時保管・仮置きの区画',
    }[t] || '';
    return { ...base, desc: `${desc}（${base.w}×${base.h}m）` };
  },
  // The homogeneous rack_type of the current selection, or null if mixed/empty.
  _selectionRackType() {
    const objs = this._selShelfObjs();
    if (!objs.length) return null;
    const t = objs[0].sh.rack_type;
    return objs.every(({ sh }) => sh.rack_type === t) ? t : null;
  },
  // Pick a rack type from the library. If shelves are selected, re-assign their
  // rack_type (undoable, re-fits cells via the save→materialize path); otherwise
  // arm the rack brush with that type and refresh the bulk/area defaults.
  _pickRackType(key) {
    if (!RACK_TYPES[key]) return;
    if (this.selShelves && this.selShelves.size) {
      this._assignRackTypeToSelection(key);
      return;
    }
    this.shelfType = key;
    this._syncRackDefaults(key);
    this._setBrush({ kind: 'rack', key });
  },
  // Re-assign the active rack_type to every selected shelf (M3 deliverable #4).
  // Cells re-fit on save (materialize_racks reads rack_type), so the 2D colour
  // and 3D geometry both update; we also nudge the active type for subsequent draws.
  _assignRackTypeToSelection(key) {
    const objs = this._selShelfObjs();
    if (!objs.length) { this.shelfType = key; this._renderTool(); return; }
    this._pushUndo();
    objs.forEach(({ sh }) => {
      sh.rack_type = key;
      // drop any stale explicit cell pitch so cells re-fit at the new type's pitch.
      delete sh.cell_w; delete sh.cell_d;
    });
    this.shelfType = key;
    this._syncRackDefaults(key);
    if (this._layoutStatus) {
      this._layoutStatus.style.color = 'var(--ink-secondary)';
      this._layoutStatus.textContent = `${objs.length} 棚を「${RACK_TYPES[key].label}」に変更しました。`;
    }
    this._renderTool();
  },
  // M3 deliverable #2: when the active type changes, refresh the bulk-gen and
  // area-fill dialogs' 間口幅・奥行き so they propose this preset's bay×depth (mm).
  // The user can still override inside the dialog; we only touch the cached
  // dimension fields (not face/count/prefix/aisle preferences).
  _syncRackDefaults(key) {
    const rt = RACK_TYPES[key] || RACK_TYPES.medium;
    if (this._bulkPrefs) {
      this._bulkPrefs.frontage = Math.round(rt.bay * 1000);
      this._bulkPrefs.depth = Math.round(rt.depth * 1000);
    }
    if (this._areaPrefs) {
      this._areaPrefs.front = Math.round(rt.bay * 1000);
      this._areaPrefs.depth = Math.round(rt.depth * 1000);
    }
  },
  // ---- tiny 2D silhouette icon (24×20) hinting the rack's 3D form -----------
  // Drawn on a small canvas so it scales crisply and matches view3d.js families:
  //   shelving  — horizontal shelf boards (light/medium)
  //   pallet    — orange load beams + a pallet unit (signature pallet rack)
  //   nestainer — stacked nesting frames (段積み)
  //   flow      — inclined roller lanes (FIFO flow)
  //   asrs      — tall uprights + a crane column (high-bay AS/RS)
  _rackIcon(rt) {
    const W = 26, H = 22, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = document.createElement('canvas');
    c.width = W * dpr; c.height = H * dpr;
    c.style.cssText = `width:${W}px;height:${H}px;flex:0 0 auto;border-radius:3px;background:${hexA(rt.color, 0.12)};`;
    c.setAttribute('aria-hidden', 'true');
    const x = c.getContext('2d');
    x.scale(dpr, dpr);
    x.strokeStyle = rt.color; x.fillStyle = rt.color; x.lineWidth = 1.2; x.lineCap = 'round';
    const sil = rt.silhouette || RACK_SILHOUETTE_FALLBACK;
    const frame = () => { x.globalAlpha = 0.9; x.strokeRect(4, 3, W - 8, H - 6); x.globalAlpha = 1; };
    if (sil === 'pallet') {
      // two uprights + 2 thick (beam) shelves, a pallet block on the lower beam.
      frame();
      x.lineWidth = 2.2;
      for (const yy of [9, 15]) { x.beginPath(); x.moveTo(4, yy); x.lineTo(W - 4, yy); x.stroke(); }
      x.lineWidth = 1.2; x.globalAlpha = 0.55;
      x.fillRect(8, 15.5, 9, 3.2);           // pallet load on bottom beam
      x.globalAlpha = 1;
    } else if (sil === 'flow') {
      // inclined roller lanes (diagonal lines) → FIFO flow rack.
      frame();
      x.globalAlpha = 0.85;
      for (const yy of [7, 12, 17]) { x.beginPath(); x.moveTo(5, yy); x.lineTo(W - 5, yy - 3); x.stroke(); }
      x.globalAlpha = 1;
    } else if (sil === 'nestainer') {
      // stacked nesting frames: three trapezoid-ish stacked boxes.
      x.globalAlpha = 0.9;
      for (const yy of [4, 10, 16]) { x.strokeRect(6, yy, W - 12, 4.6); }
      x.globalAlpha = 1;
    } else if (sil === 'asrs') {
      // tall uprights + many tiers + a crane column on the left (high-bay).
      x.globalAlpha = 0.9; x.strokeRect(8, 2, W - 12, H - 4);
      for (let yy = 5; yy < H - 3; yy += 3.5) { x.beginPath(); x.moveTo(8, yy); x.lineTo(W - 4, yy); x.stroke(); }
      x.lineWidth = 2.2; x.beginPath(); x.moveTo(4, 2); x.lineTo(4, H - 2); x.stroke();  // crane mast
      x.lineWidth = 1.2; x.globalAlpha = 1;
    } else {
      // shelving (light/medium): frame + evenly spaced horizontal boards.
      frame();
      x.globalAlpha = 0.85;
      for (const yy of [8, 12, 16]) { x.beginPath(); x.moveTo(5, yy); x.lineTo(W - 5, yy); x.stroke(); }
      x.globalAlpha = 1;
    }
    return c;
  },
  _storageZones() {
    return (this.model.layout.zones || []).filter((z) => z.type === 'storage');
  },
  _activeStoreZone() {
    const stores = this._storageZones();
    if (!stores.length) return null;
    return stores.find((z) => z.id === this.shelfZoneId) || stores[0];
  },
  _allShelves() {
    // [{zone, sh}] across all storage zones (for snapping + drawing).
    const out = [];
    for (const z of this._storageZones()) for (const sh of (z.shelves || [])) out.push({ zone: z, sh });
    return out;
  },
};
