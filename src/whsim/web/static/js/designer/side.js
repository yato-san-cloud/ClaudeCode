// designer/side.js — the 配置-tool right-hand object inspector: the per-selection
// side panels (floor / shelf / building / layout-zone / equipment) that number-
// edit the selected object. Mixed into Designer.prototype by core.js (structural move).
//
// SYNTHESIS: core.js does `Object.assign(Designer.prototype, sideMethods)`.

import {
  DOOR_JP, DOOR_PALETTE, EQUIP_PALETTE, MIN_M, RACK_ORDER, RACK_TYPES, SHELF_MIN_M, ZONE_JP, ZONE_TYPES,
} from './constants.js';
import { cellAddress, clamp, shelfCells, uid } from './geometry.js';

export const sideMethods = {
  // ---- side editor panels (layout + equip tools) ---------------------------
  // The side panel is now an OBJECT INSPECTOR: it shows the editor for whatever
  // is selected (shelf / zone / equipment / wall / door), and floor-level
  // settings (倉庫サイズ etc.) when nothing is. The placement palettes that used
  // to live here moved to the library on the left.
  _renderSide() {
    if (!this.side) return;
    const s = this.side; s.innerHTML = '';
    // PowerPoint-style multi-selection (marquee / Shift-click across object
    // kinds) gets its own group panel; shelves-only keeps the rich M2 editor.
    if (this.selObjs && this.selObjs.length) { this._sideMulti(s); return; }
    if (this.selShelves && this.selShelves.size) { this._sideShelf(s); return; }
    const k = this.selected && this.selected.kind;
    if (k === 'zone') this._sideLayout(s);
    else if (k === 'wall' || k === 'door') this._sideBuilding(s);
    else if (k === 'equip' || k === 'station') this._sideEquip(s);
    else this._sideFloor(s);
  },
  // ---- multi-selection inspector: count + type breakdown + group actions ----
  _sideMulti(s) {
    const n = this._multiCount();
    this._h(s, `${n}個選択中`);
    const breakdown = this._multiBreakdown();
    if (breakdown) this._note(s, `内訳: ${breakdown}`);
    this._note(s, 'ドラッグでまとめて移動できます。Shift＋クリックで追加/解除、Escで選択解除。');
    this._btn(s, '削除', () => this._deleteMultiSelection(), 'margin-top:10px;color:var(--bad);');
  },
  // ---- no-selection inspector: floor settings + active drafts ---------------
  _sideFloor(s) {
    const b = this.brush || {};
    // active draft controls (wall / conveyor mid-draw)
    if (this.wallDraft) {
      this._h(s, '壁を作図中');
      this._note(s, `頂点 ${this.wallDraft.length} 点。クリックで追加（Shift=水平/垂直）、ダブルクリックか下のボタンで確定。`);
      this._btn(s, '壁を確定', () => this._finishWall(), 'margin-bottom:8px;');
    } else if (this.conveyorDraft) {
      this._h(s, 'コンベアを作図中');
      this._note(s, `頂点 ${this.conveyorDraft.length} 点。クリックで追加、ダブルクリックか下のボタンで確定。`);
      this._btn(s, 'コンベアを確定', () => this._finishConveyor(), 'margin-bottom:8px;');
    } else if (b.kind && b.kind !== 'select') {
      this._h(s, `配置中: ${this._brushLabel()}`);
      this._note(s, this._brushHint());
      if (b.kind === 'rack') {
        const rt = RACK_TYPES[this.shelfType] || RACK_TYPES.medium;
        this._note(s, `${rt.label}: 間口${rt.bay}m × 奥行${rt.depth}m・${rt.levels || 1}段・収容${rt.capacity || 0}。${rt.desc || ''}`);
      }
      this._btn(s, '選択モードに戻る (Esc)', () => this._setBrush({ kind: 'select' }), 'margin-bottom:8px;');
    } else {
      this._h(s, 'オブジェクト情報');
      this._note(s, '床の物をクリックすると、名前・寸法・台数をここで数値編集できます。');
      // …and while nothing is selected, say what IS on this floor. An inspector
      // that only says 「クリックしてください」 tells the reader nothing about the
      // model they are looking at; the tally is the cheapest honest answer to
      // 「この図面には何が置いてあるのか」.
      this._floorTally(s);
    }

    // 倉庫サイズ — set the floor extents up front, MapMaker-style.
    this._h(s, '倉庫サイズ');
    const bnd = this.model.layout.bounds;
    this._field(s, '幅 W (m)', () => this._num(bnd.width, (v) => {
      bnd.width = Math.max(MIN_M, v); this._fitCanvas(); this._drawCanvas(); }));
    this._field(s, '奥行 D (m)', () => this._num(bnd.depth, (v) => {
      bnd.depth = Math.max(MIN_M, v); this._fitCanvas(); this._drawCanvas(); }));

    if ((this.model.resources.conveyors || []).length) {
      this._h(s, `コンベア (${this.model.resources.conveyors.length})`);
      this._btn(s, '最後のコンベアを削除', () => { this._pushUndo(); this.model.resources.conveyors.pop(); this._drawCanvas(); this._renderSide(); });
    }
  },
  // ---- 「この床には何があるか」 tally shown when nothing is selected ------------
  // Reads only what is already in the model — no fetch, no new contract. A kind
  // with zero of it is omitted rather than printed as 0 (a list of zeroes reads
  // as an error report; an omission reads as "not used here").
  _floorTally(s) {
    const L = this.model.layout || {};
    const R = this.model.resources || {};
    // Authored shelves AND materialised (parametric) rack runs both draw as racks
    // on the floor, so a tally that counted only the authored ones read 「棚 0」
    // next to fifteen visible rack rows. Count what the canvas actually draws.
    let shelves = this._allShelves ? this._allShelves().length : 0;
    let slots = 0;
    for (const z of (L.zones || [])) {
      if (z.type !== 'storage' || (z.shelves || []).length) continue;
      const locs = this._zoneLocations ? this._zoneLocations(z) : [];
      slots += locs.length;
      if (locs.length && this._reconstructRuns) shelves += this._reconstructRuns(locs).length;
    }
    const rows = [
      ['棚（ラック列）', shelves, '列'],
      ['ロケーション', slots, '間口'],
      ['ゾーン', (L.zones || []).length, '区画'],
      ['マテハン設備', (R.equipment || []).length, '基'],
      ['梱包台', (R.stations || []).length, '台'],
      ['コンベア', (R.conveyors || []).length, '本'],
      ['壁', (L.walls || []).length, '本'],
      ['ドア', (L.doors || []).length, 'ヶ所'],
    ].filter(([, n]) => n > 0);
    if (!rows.length) {
      this._note(s, '床はまだ空です。左のライブラリからカードを選ぶか、床へドラッグしてください。');
      return;
    }
    const box = this._div(s, 'margin-top:8px;display:flex;flex-direction:column;gap:3px;'
      + 'border-top:1px solid var(--line-hair);padding-top:8px;');
    for (const [label, n, unit] of rows) {
      const row = this._div(box, 'display:flex;justify-content:space-between;gap:8px;font-size:12px;');
      const l = this._div(row, 'color:var(--ink-tertiary);');
      l.textContent = label;
      const v = this._div(row, 'color:var(--ink-primary);font-weight:700;font-variant-numeric:tabular-nums;');
      v.textContent = `${n} ${unit}`;
    }
  },
  // ---- per-shelf editor (ShelfEditor.java port): name / type / facing / size ----
  _sideShelf(s) {
    const objs = this._selShelfObjs();
    const zone = this._activeStoreZone();
    const total = zone ? (zone.shelves || []).length : 0;
    this._h(s, `この保管ゾーンの棚: ${total}`);

    if (!objs.length) { this._note(s, '棚を選択すると、名前・種別・間口・サイズを編集できます。'); return; }
    if (objs.length > 1) {
      this._h(s, `選択中: ${objs.length} 棚`);
      // bulk rack-type + facing for the multi-selection.
      this._field(s, '種別（一括）', () => {
        const sel = this._select(null, RACK_ORDER.map((k) => ({ value: k, label: RACK_TYPES[k].label })), objs[0].sh.rack_type);
        this._on(sel, 'change', () => { this._pushUndo(); objs.forEach(({ sh }) => { sh.rack_type = sel.value; }); this._repaint(); });
        return sel;
      });
      this._field(s, '間口の向き（一括）', () => {
        const sel = this._select(null, [
          { value: 'down', label: '下' }, { value: 'up', label: '上' },
          { value: 'right', label: '右' }, { value: 'left', label: '左' },
        ], objs[0].sh.facing);
        this._on(sel, 'change', () => { this._pushUndo(); objs.forEach(({ sh }) => { sh.facing = sel.value; }); this._repaint(); });
        return sel;
      });
      this._btn(s, '複製（+1m）', () => this._duplicateShelves(), 'margin-top:8px;');
      this._btn(s, '削除', () => this._deleteShelves(), 'margin-top:8px;color:var(--bad);');
      return;
    }

    // single shelf editor
    const sh = objs[0].sh;
    this._h(s, '選択中の棚');
    this._kindBadge(s, '棚');
    // name — verbatim, unique, comma-banned (live validation like ShelfEditor).
    const nameRow = this._div(s, 'margin-bottom:6px;');
    const nl = this._div(nameRow, 'font-size:12px;margin-bottom:3px;');
    nl.textContent = '棚名';
    const nameInp = document.createElement('input');
    nameInp.type = 'text'; nameInp.value = sh.name || '';
    nameInp.style.cssText = 'width:100%;box-sizing:border-box;padding:5px 7px;border:1px solid var(--line-hair);border-radius:var(--r-sm);font-size:13px;background:var(--bg-app);color:var(--ink-primary);';
    const nameErr = this._div(nameRow, 'font-size:11px;color:var(--bad);min-height:14px;');
    const validateName = () => {
      const v = nameInp.value;
      if (v.indexOf(',') !== -1 || v.indexOf('、') !== -1) { nameErr.textContent = '棚名にカンマは使用できません。'; return false; }
      // duplicate check (excluding self)
      for (const { sh: o } of this._allShelves()) { if (o !== sh && o.name && o.name === v) { nameErr.textContent = '棚名が重複しています。'; return false; } }
      nameErr.textContent = '';
      return true;
    };
    this._on(nameInp, 'input', () => validateName());
    this._on(nameInp, 'change', () => { if (validateName()) { this._pushUndo(); sh.name = nameInp.value; this._repaint(); } });
    nameRow.appendChild(nameInp); nameRow.appendChild(nameErr);

    // rack type
    this._field(s, '種別', () => {
      const sel = this._select(null, RACK_ORDER.map((k) => ({ value: k, label: RACK_TYPES[k].label })), sh.rack_type);
      this._on(sel, 'change', () => { this._pushUndo(); sh.rack_type = sel.value; this._repaint(); });
      return sel;
    });
    // facing (間口)
    this._field(s, '間口の向き', () => {
      const sel = this._select(null, [
        { value: 'down', label: '下を向く' }, { value: 'up', label: '上を向く' },
        { value: 'right', label: '右を向く' }, { value: 'left', label: '左を向く' },
      ], sh.facing);
      this._on(sel, 'change', () => { this._pushUndo(); sh.facing = sel.value; this._repaint(); });
      return sel;
    });
    // size (横長/縦長 mm in ShelfEditor; whsim uses meters W/H for consistency)
    const b = this.model.layout.bounds;
    this._field(s, '幅 W (m)', () => this._num(sh.w, (v) => { this._pushUndo(); sh.w = clamp(v, SHELF_MIN_M, b.width); this._repaint(); }, 0.1));
    this._field(s, '奥行 H (m)', () => this._num(sh.h, (v) => { this._pushUndo(); sh.h = clamp(v, SHELF_MIN_M, b.depth); this._repaint(); }, 0.1));
    this._field(s, 'X (m)', () => this._num(sh.x, (v) => { this._pushUndo(); sh.x = clamp(v, 0, b.width - sh.w); this._repaint(); }, 0.1));
    this._field(s, 'Y (m)', () => this._num(sh.y, (v) => { this._pushUndo(); sh.y = clamp(v, 0, b.depth - sh.h); this._repaint(); }, 0.1));

    // 棚番号 (location address) — the structured 通路-連-段 address this shelf's
    // locations will carry. Previewed client-side (mirror of design._address) so
    // the user sees it WITHOUT saving; the server regenerates the same scheme.
    this._shelfAddressInfo(s, sh);

    this._btn(s, '複製（+1m）', () => this._duplicateShelves(), 'margin-top:8px;');
    this._btn(s, '削除', () => this._deleteShelves(), 'margin-top:8px;color:var(--bad);');
  },
  // 棚番号 section: shows the kind (棚=保管設備), how many locations the shelf
  // makes (bays × 段), the address RANGE, and a re-number action that saves
  // (the server re-materialises addresses deterministically on save).
  _shelfAddressInfo(s, sh) {
    const rt = RACK_TYPES[sh.rack_type] || RACK_TYPES.medium;
    const levels = Math.max(1, rt.levels || 1);
    const cells = shelfCells(sh, rt);
    const first = cells[0];
    const last = cells[cells.length - 1];
    const a0 = cellAddress(first[0], first[1], 1);
    const a1 = cellAddress(last[0], last[1], levels);
    const total = cells.length * levels;
    this._h(s, '棚番号 (ロケーション)');
    this._note(s, `この棚は 保管設備 です。間口${cells.length} × ${levels}段 = ${total}ロケーション。`);
    // address chip — the representative first address (bottom level).
    const chip = this._div(s, 'font-family:var(--font-mono,monospace);font-size:14px;font-weight:700;'
      + 'color:var(--ink-primary);background:var(--bg-app);border:1px solid var(--line-hair);'
      + 'border-radius:var(--r-sm);padding:6px 9px;margin:2px 0 6px;display:inline-block;');
    chip.textContent = a0;
    if (total > 1) this._note(s, `採番範囲: ${a0} 〜 ${a1}（通路-連-段）。`);
    this._btn(s, '棚番号を振り直す', () => this._renumberLocations(),
      'margin-top:4px;').title = '保管設備のロケーションに通路-連-段の棚番号を一括で振り直して保存します。';
  },
  // Re-number = re-materialise: the server regenerates every location's 棚番号
  // (deterministic 通路-連-段) and persists. We just trigger a save.
  _renumberLocations() {
    if (this._saveMsg) { this._saveMsg.style.color = 'var(--ink-secondary)'; this._saveMsg.textContent = '棚番号を振り直しています…'; }
    this._save();
  },
  // Kind badge: every placed object is one of 棚 / ゾーン / 設備 / 壁 / ドア /
  // ステーション. ONLY 棚 (storage) carry 棚番号/locations — surface that so the
  // user knows where addresses do (and don't) live ("保管設備だけ").
  _kindBadge(s, kind) {
    const row = this._div(s, 'display:flex;align-items:center;gap:6px;margin:2px 0 4px;');
    const b = this._div(row, 'font-size:11px;font-weight:700;letter-spacing:.04em;'
      + 'background:var(--bg-app);border:1px solid var(--line-hair);border-radius:999px;'
      + 'padding:2px 8px;color:var(--ink-secondary);');
    b.textContent = kind;
    if (kind !== '棚') {
      const t = this._div(row, 'font-size:11px;color:var(--ink-tertiary);');
      t.textContent = '棚番号なし（棚番号は保管設備の棚だけ）';
    }
  },
  // selected wall / door inspector (placement happens via the library brushes).
  _sideBuilding(s) {
    const w = this.selected && this.selected.kind === 'wall'
      ? this.model.layout.walls.find((q) => q.id === this.selected.id) : null;
    if (w) {
      this._h(s, '選択中の壁');
      this._kindBadge(s, '壁');
      this._field(s, '厚さ (m)', () => this._num(w.thickness, (v) => { w.thickness = Math.max(0.05, v); this._drawCanvas(); }));
      const pts = w.points || [];
      let len = 0;
      for (let i = 0; i < pts.length - 1; i++) len += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      this._note(s, `頂点 ${pts.length} 点・全長 ${len.toFixed(2)} m。`);
      this._btn(s, '削除', () => {
        this._pushUndo();
        this.model.layout.walls = this.model.layout.walls.filter((q) => q.id !== w.id);
        this.selected = null; this._renderSide(); this._drawCanvas();
      }, 'margin-top:10px;color:var(--bad);');
      return;
    }
    const d = this.selected && this.selected.kind === 'door'
      ? this.model.layout.doors.find((q) => q.id === this.selected.id) : null;
    if (d) {
      this._h(s, `選択中: ${DOOR_JP[d.type] || d.type}`);
      this._kindBadge(s, 'ドア');
      this._field(s, '種別', () => {
        const sel = this._select(null, DOOR_PALETTE.map((p) => ({ value: p.type, label: p.label })), d.type);
        this._on(sel, 'change', () => { d.type = sel.value; this._renderSide(); this._drawCanvas(); });
        return sel;
      });
      this._field(s, '幅 (m)', () => this._num(d.w, (v) => { d.w = Math.max(0.3, v); this._drawCanvas(); }));
      this._field(s, 'X (m)', () => this._num(d.x, (v) => { d.x = clamp(v, 0, this.model.layout.bounds.width); this._drawCanvas(); }, 0.1));
      this._field(s, 'Y (m)', () => this._num(d.y, (v) => { d.y = clamp(v, 0, this.model.layout.bounds.depth); this._drawCanvas(); }, 0.1));
      this._btn(s, '削除', () => {
        this._pushUndo();
        this.model.layout.doors = this.model.layout.doors.filter((q) => q.id !== d.id);
        this.selected = null; this._renderSide(); this._drawCanvas();
      }, 'margin-top:10px;color:var(--bad);');
    }
  },
  // selected zone inspector (zones are placed from the library's ゾーン cards).
  _sideLayout(s) {
    const z = this.selected && this.selected.kind === 'zone'
      ? this.model.layout.zones.find((q) => q.id === this.selected.id) : null;
    if (!z) { this._sideFloor(s); return; }

    this._h(s, '選択中のゾーン');
    this._kindBadge(s, 'ゾーン');
    if (z.type === 'storage')
      this._note(s, '保管ゾーンです。中に置いた棚（保管設備）が棚番号付きのロケーションになります。');
    // type
    this._field(s, '種別', () => {
      const sel = this._select(null, ZONE_TYPES.map((t) => ({ value: t, label: ZONE_JP[t] })), z.type);
      this._on(sel, 'change', () => {
        z.type = sel.value;
        if (z.type === 'storage') {
          if ((!z.shelves || !z.shelves.length) && !z.rack)
            z.shelves = [{ id: uid('s'), x: z.x, y: z.y, w: z.w, h: z.h, rack_type: this.shelfType }];
        } else { z.rack = null; z.shelves = []; }
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
    // storage equipment (棚種別) — drives the cell footprint & capacity
    if (z.type === 'storage') {
      if ((!z.shelves || !z.shelves.length) && !z.rack)
        z.shelves = [{ id: uid('s'), x: z.x, y: z.y, w: z.w, h: z.h, rack_type: this.shelfType }];
      if (z.shelves && z.shelves.length) {
        const cur = z.shelves[0].rack_type || 'medium';
        this._h(s, '保管設備（棚種別）');
        this._field(s, '種別', () => {
          const sel = this._select(null, RACK_ORDER.map((k) => ({ value: k, label: RACK_TYPES[k].label })), cur);
          this._on(sel, 'change', () => {
            z.shelves.forEach((sh) => { sh.rack_type = sel.value; });
            this._renderSide(); this._drawCanvas();
          });
          return sel;
        });
        const rt = RACK_TYPES[cur] || RACK_TYPES.medium;
        this._note(s, `セル ${rt.bay}×${rt.depth} m・${z.shelves.length}ブロック。棚を描いた結果ロケーションが生成されます。`);
      } else if (z.rack) {
        this._h(s, 'ラック（保管棚・従来）');
        for (const [label, key] of [['列間隔 (m)', 'col_spacing'], ['段間隔 (m)', 'row_spacing'], ['余白 (m)', 'margin']]) {
          this._field(s, label, () => this._num(z.rack[key], (v) => { z.rack[key] = Math.max(0.1, v); this._drawCanvas(); }));
        }
      }
    }
    this._btn(s, '削除', () => this._deleteZone(z.id), 'margin-top:10px;color:var(--bad);');
  },
  // selected equipment / station inspector (placement via the library brushes).
  _sideEquip(s) {
    const sel = this.selected;
    if (sel && sel.kind === 'equip') {
      const e = this.model.resources.equipment.find((q) => q.id === sel.id);
      if (e) {
        const p = EQUIP_PALETTE.find((x) => x.type === e.type);
        this._h(s, `選択中: ${p ? p.label : e.type}`);
        this._kindBadge(s, '設備');
        if (p && p.desc) this._note(s, p.desc);
        this._field(s, '台数', () => this._num(e.count, (v) => { e.count = Math.max(0, Math.round(v)); this._drawCanvas(); }, 1));
        this._field(s, '速度 (m/s)', () => this._num(e.speed_mps, (v) => { e.speed_mps = Math.max(0, v); }));
        this._field(s, 'X (m)', () => this._num(e.x, (v) => { e.x = clamp(v, 0, this.model.layout.bounds.width); this._drawCanvas(); }, 0.1));
        this._field(s, 'Y (m)', () => this._num(e.y, (v) => { e.y = clamp(v, 0, this.model.layout.bounds.depth); this._drawCanvas(); }, 0.1));
        this._btn(s, '削除', () => { this._pushUndo(); this.model.resources.equipment = this.model.resources.equipment.filter((q) => q.id !== e.id); this.selected = null; this._renderSide(); this._drawCanvas(); }, 'margin-top:10px;color:var(--bad);');
      }
    } else if (sel && sel.kind === 'station') {
      const st = this.model.resources.stations.find((q) => q.id === sel.id);
      if (st) {
        this._h(s, '選択中: 梱包台');
        this._kindBadge(s, 'ステーション');
        this._field(s, '台数', () => this._num(st.count, (v) => { st.count = Math.max(0, Math.round(v)); this._drawCanvas(); }, 1));
        this._field(s, 'X (m)', () => this._num(st.x, (v) => { st.x = clamp(v, 0, this.model.layout.bounds.width); this._drawCanvas(); }, 0.1));
        this._field(s, 'Y (m)', () => this._num(st.y, (v) => { st.y = clamp(v, 0, this.model.layout.bounds.depth); this._drawCanvas(); }, 0.1));
        this._btn(s, '削除', () => { this._pushUndo(); this.model.resources.stations = this.model.resources.stations.filter((q) => q.id !== st.id); this.selected = null; this._renderSide(); this._drawCanvas(); }, 'margin-top:10px;color:var(--bad);');
      }
    }
  },
};
