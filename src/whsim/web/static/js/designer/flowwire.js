// designer/flowwire.js — ③設計「フロー」: 業務フロー(工程間の物の流れ)を、床に
// 置いた実物のマテハン設備へ配線するツール。
//
// The フロー canvas used to draw zones and a generic ribbon between them: the
// salesperson could say WHERE a step happens but not WHAT MOVES THE GOODS. This
// module adds the missing half:
//
//   1. 設備ゴースト — the placed conveyors (real polyline) and equipment (x/y)
//      are drawn UNDER the zone/arrow layer in a muted tone, so you can see what
//      you are wiring TO.
//   2. エッジの直接操作 — the arrows between 工程 are selectable; with an edge
//      selected, clicking a belt/AGV/自動倉庫 BINDS it (transport from the
//      equipment kind, equipment_ref = its id). Clicking bare floor unbinds.
//   3. エッジ・インスペクタ — the same edge, edited precisely (搬送手段 / 使用設備
//      / 荷姿(容器・台車) / 分岐率) from the keyboard.
//
// 荷姿 (load units): a leg also says WHAT THE GOODS ARE IN (容器 = 折コン/トレー)
// and WHAT THEY RIDE ON (台車 = カゴ台車/6輪カート/平台車). Both come from the
// project's 荷姿カタログ (`whsim/loadunit.py`) — the same catalogue the ②分析
// 基礎物量 screen edits — so 入数 has ONE source. The 換算 shown under the selects
// is the SERVER's own string (GET /loadunits/convert), never a formula re-written
// here; with no measured 物量 we show nothing rather than invent one.
//
// Data contract (GET/POST /api/projects/{name}/flow):
//   nodes[]     {id, role, zone, section, simulated}
//   edges[]     {src, dst, transport, equipment_ref, share, derived,
//                container_ref, carrier_ref}
//   equipment[] {id, kind, label, speed_mps?, points?, count?, x?, y?}
//   load_units[]{id, name, kind, capacity, footprint_m2, provisional}
//   roles[], authored, diagnostics[] {kind, message, ...}
// POST body is {edges:[{src,dst,transport,equipment_ref,share,container_ref,
// carrier_ref}]}; an empty array resets to the derived graph.
//
// NEVER-BLOCKS: the endpoint may be absent (older server), the project may not be
// open, the graph may be empty and equipment may not exist. Every one of those
// paths renders a calm state and keeps the legacy behaviour — nothing throws. When
// the endpoint is unreachable we still synthesise the derived graph locally from
// `process.stages`, so the wiring UI works on the drawing and simply cannot
// persist (the inspector says so).
//
// SYNTHESIS: mixed into Designer.prototype via flow.js's `flowMethods` spread.

import { EQUIP_PALETTE, METHOD_COLOR, METHOD_OPTS, MOVER_COLOR } from './constants.js';
import { hexA } from './geometry.js';
import { esc } from '../util.js';

// ---- transport vocabulary ---------------------------------------------------
// The API's `transport` adds フォークリフト to the editor's 4 stage methods, so we
// extend (never fork) the shared METHOD_OPTS / METHOD_COLOR vocabulary. The
// forklift hue is the one the 動線 tool already uses for that mover.
const FORKLIFT_OPT = { value: 'forklift', label: 'フォークリフト' };
export const TRANSPORT_OPTS = METHOD_OPTS.concat([FORKLIFT_OPT]);
const TRANSPORT_JP = {};
TRANSPORT_OPTS.forEach((o) => { TRANSPORT_JP[o.value] = o.label; });
// Equipment kind → the transport it implies (what actually moves the goods).
const KIND_TRANSPORT = {
  conveyor: 'conveyor', agv: 'agv', amr: 'agv', asrs: 'asrs',
  forklift: 'forklift', crane: 'forklift', station: 'manual', robot_arm: 'manual',
};
// Transport → the equipment kinds that can serve it (drives the 使用設備 select).
const TRANSPORT_KINDS = {
  conveyor: ['conveyor'], agv: ['agv', 'amr'], asrs: ['asrs'],
  forklift: ['forklift', 'crane'], manual: [],
};
// Canonical 工程 → the 工程マスタ key the volume payloads are keyed by. This
// mirrors whsim.analysis.staffing.profile.volumes_from_bi's own mapping — it is
// the backend's table, not an invention of this module.
const ROLE_VOL_KEY = {
  receive: '入荷検品', putaway: '格納', pick: 'ピッキング',
  inspect: '検品', pack: '梱包', ship: '出荷',
};

const EDGE_HIT_PX = 11;        // click tolerance around an edge ribbon
const EQUIP_HIT_PX = 9;        // click tolerance around a conveyor polyline
// An edge is anchored at its two zone CENTRES, which is exactly where the user
// clicks to open a 工程's 作業方法 panel (and where the step badge sits). Keep a
// dead zone around each end so the hub belongs to the zone and the span belongs
// to the edge — otherwise wiring silently swallows the old zone interaction.
const EDGE_END_GUARD_PX = 22;
const SAVE_DEBOUNCE_MS = 400;  // POST debounce after an edit

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const fmt = (n) => (n == null || !Number.isFinite(+n) ? '—'
  : Math.round(+n).toLocaleString('ja-JP'));

// Colour of a transport ribbon. Category hues (not chrome) so they are identical
// in light and dark — chrome colours all come from `this.pal` (CSS custom props).
function transportColor(t) {
  if (t === 'forklift') return MOVER_COLOR.forklift;
  return METHOD_COLOR[t] || METHOD_COLOR.manual;
}
// Severity tone for a diagnostic. `severity`/`level` win; otherwise the kind is
// sniffed. Diagnostics are WARNINGS, so the default tone is 警告 — never a blocker.
function diagTone(d) {
  const s = String((d && (d.severity || d.level)) || '').toLowerCase();
  if (s.startsWith('err') || s === 'bad' || s === 'critical') return 'bad';
  if (s.startsWith('warn')) return 'warn';
  if (s === 'info' || s === 'hint' || s === 'ok') return 'info';
  const k = String((d && d.kind) || '').toLowerCase();
  if (/(missing|unreachable|orphan|broken|conflict|invalid|error|disconnect)/.test(k)) return 'bad';
  if (/(info|hint|note)/.test(k)) return 'info';
  return 'warn';
}
const TONE_CSS = {
  bad: 'border-color:var(--bad-line, var(--bad));background:var(--bad-tint);color:var(--ink-primary);',
  warn: 'border-color:var(--warn-line, var(--warn));background:var(--warn-tint);color:var(--ink-primary);',
  info: 'border-color:var(--line-hair);background:var(--bg-app);color:var(--ink-secondary);',
};
const TONE_MARK = { bad: '⚠', warn: '⚠', info: 'ℹ' };

// Normalise a polyline to [[x,y],…] of finite numbers ([{x,y}] is accepted too).
function toPts(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const p of points) {
    let x, y;
    if (Array.isArray(p)) { x = +p[0]; y = +p[1]; }
    else if (p && typeof p === 'object') { x = +p.x; y = +p.y; }
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}
// Squared distance from a point to a segment (all in the same space).
function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return [(px - qx) ** 2 + (py - qy) ** 2, qx, qy];
}

export const flowWireMethods = {
  // ---- lifecycle -----------------------------------------------------------
  // Called from _renderFlow(). Loads the graph once per mount; every later
  // render just repaints from the cached state (edits are local + POSTed).
  _fwEnsure() {
    this._fwInjectStyle();
    const name = this._fwProject();
    // Re-key on the project so a setModel() into a different workspace cannot
    // keep showing the previous project's wiring.
    if (this._fwState && this._fwState.project === name) return;
    this._fwState = { project: name, graph: null, sel: null, note: '', saveMsg: '',
      reachable: null, units: [], base: null, chains: {} };
    this._fwLoad();
    this._fwLoadUnits();
    this._fwLoadVolumes();
    this._fwBusOnce();
  },
  // The 荷姿カタログ can be edited on ②分析「基礎物量」; re-read it when it changes
  // so the two screens never offer different 入数. Bound once (cleaned by dispose).
  _fwBusOnce() {
    if (this._fwBus) return;
    this._fwBus = true;
    this._on(document, 'whsim:loadunits-changed', (ev) => {
      if (ev && ev.detail && ev.detail.source === 'flow') return;
      const st = this._fwState; if (!st) return;
      st.chains = {};
      this._fwLoadUnits(true);
    });
  },
  // Scoped cosmetic rules for the diagnostics list (hover/tone only). Follows the
  // app's injectStyle() convention; every colour is a design token.
  _fwInjectStyle() {
    if (document.getElementById('designer-flowwire-style')) return;
    const s = document.createElement('style');
    s.id = 'designer-flowwire-style';
    s.textContent = `
    .designer-root .fw-diag{display:flex;flex-direction:column;gap:4px;margin-top:6px}
    .designer-root .fw-diag-h{font-size:11px;font-weight:700;color:var(--ink-tertiary);
      letter-spacing:var(--ls-micro,.04em)}
    .designer-root .fw-diag-row{display:flex;gap:7px;align-items:flex-start;
      padding:5px 9px;border:1px solid var(--line-hair);border-radius:var(--r-sm,6px);
      font-size:11.5px;line-height:1.5}
    .designer-root .fw-diag-mark{flex:0 0 auto;font-weight:700}
    .designer-root .fw-diag-kind{flex:0 0 auto;color:var(--ink-tertiary);font-size:10.5px;
      padding-top:1px}
    .designer-root .fw-diag-msg{flex:1;min-width:0;word-break:break-word}
    `;
    document.head.appendChild(s);
  },
  // Resolve the open project without a host handler (same rule the docked side
  // panel uses). Returns null when nothing is open — a calm empty state.
  _fwProject() {
    if (typeof this._spProject === 'function') { try { return this._spProject(); } catch (_e) { /* fall through */ } }
    const sel = document.getElementById('projectSelect');
    return (sel && sel.value) ? sel.value : null;
  },
  _fwAlive() { return !!(this.container && this.container.isConnected); },

  // ---- load / save ---------------------------------------------------------
  async _fwLoad() {
    const st = this._fwState; if (!st) return;
    const name = this._fwProject();
    if (!name) { st.reachable = false; st.note = 'プロジェクトを開くと、工程間の配線を編集できます。'; return; }
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(name)}/flow`,
        { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(String(r.status));
      const g = await r.json();
      if (!this._fwAlive() || this._fwState !== st) return;
      st.graph = (g && typeof g === 'object') ? g : null;
      st.reachable = true;
      st.note = '';
      // /flow already carries the catalogue — take it and skip the extra call.
      if (g && Array.isArray(g.load_units) && g.load_units.length) {
        st.units = g.load_units.filter((u) => u && u.id);
      }
    } catch (_e) {
      if (!this._fwAlive() || this._fwState !== st) return;
      // Older server / offline: keep working on a locally derived graph so the
      // wiring UI still teaches and edits; it just cannot persist.
      st.graph = null;
      st.reachable = false;
      st.note = '配線APIに接続できません。図面上の配線は編集できますが保存されません。';
    }
    this._fwRefresh();
  },
  // 荷姿カタログ (資材マスタ). /flow usually carries it; this is the fallback (and
  // the refresh path when ②基礎物量 edits it). A 404 / offline server simply leaves
  // the list empty — the inspector then omits the 容器/台車 controls entirely.
  async _fwLoadUnits(force) {
    const st = this._fwState; if (!st) return;
    if (!force && Array.isArray(st.units) && st.units.length) return;
    const name = this._fwProject(); if (!name) return;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(name)}/loadunits`,
        { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      if (!this._fwAlive() || this._fwState !== st) return;
      if (d && Array.isArray(d.units)) st.units = d.units.filter((u) => u && u.id);
    } catch (_e) {
      if (!this._fwAlive() || this._fwState !== st) return;
      if (!Array.isArray(st.units)) st.units = [];   // 旧サーバ: 荷姿の欄を出さない
      return;
    }
    this._fwRefresh();
  },
  // Optional 物量: the BI→タイムチャート bridge (already persisted for this
  // project) plus the 工程マスタ for units. Both are best-effort — if neither is
  // reachable we simply DON'T label the edges. We never invent a volume.
  // `/bi/volumes` is pulled too: it is the only source of バラ点数/ケース数, which
  // is what a 荷姿 conversion needs (the per-工程 volumes above are 行/件).
  async _fwLoadVolumes() {
    const st = this._fwState; if (!st) return;
    const name = this._fwProject(); if (!name) return;
    const get = async (path) => {
      const r = await fetch(`/api/projects/${encodeURIComponent(name)}${path}`,
        { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    };
    const [bi, master, base] = await Promise.all([
      get('/timetable/from-bi').catch(() => null),
      get('/work-processes').catch(() => null),
      get('/bi/volumes').catch(() => null),
    ]);
    if (!this._fwAlive() || this._fwState !== st) return;
    if (base && typeof base === 'object') st.base = base;
    const vols = (bi && bi.available && bi.volumes && typeof bi.volumes === 'object') ? bi.volumes : null;
    if (vols) {
      const units = {};
      const procs = (master && Array.isArray(master.processes)) ? master.processes : [];
      for (const p of procs) { if (p && p.id) units[p.id] = p.unit || ''; }
      st.vol = { volumes: vols, units };
    }
    this._fwRefresh();
  },
  // Repaint everything this module owns (canvas + side + diagnostics).
  _fwRefresh() {
    if (!this._fwAlive() || this.tool !== 'flow') return;
    this._fwRenderDiagnostics();
    this._renderFlowSide();
    this._drawFlowCanvas();
  },
  // Debounced persist. Also re-broadcasts the flow bus so ②マテリアルフロー
  // live-updates. A failed POST is surfaced in the inspector, never thrown.
  _fwTouch() {
    const st = this._fwState; if (!st) return;
    st.saveMsg = '保存中…';
    if (this._fwSaveTimer) clearTimeout(this._fwSaveTimer);
    this._fwSaveTimer = setTimeout(() => { this._fwSaveTimer = 0; this._fwSave(); }, SAVE_DEBOUNCE_MS);
    this._fwEmit();
    this._fwRefresh();
  },
  async _fwSave() {
    const st = this._fwState; if (!st || !this._fwAlive()) return;
    const name = this._fwProject();
    if (!name) { st.saveMsg = 'プロジェクトが開いていないため保存できません。'; this._fwRefresh(); return; }
    const edges = this._fwEdges().map((e) => ({
      src: e.src, dst: e.dst, transport: e.transport || 'manual',
      equipment_ref: e.equipment_ref || null, share: num(e.share, 1),
      // 荷姿: 何に入れて (容器) 何に載せて (台車) 運ぶか。'' = 指定なし。
      container_ref: e.container_ref || '', carrier_ref: e.carrier_ref || '',
    }));
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(name)}/flow`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ edges }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const g = await r.json().catch(() => null);
      if (!this._fwAlive() || this._fwState !== st) return;
      // The server recomputes diagnostics; adopt the fresh graph and re-resolve
      // the selection by key so the inspector stays on the same edge.
      if (g && Array.isArray(g.edges)) { st.graph = g; st.reachable = true; }
      st.saveMsg = '配線を保存しました。';
    } catch (_e) {
      if (!this._fwAlive() || this._fwState !== st) return;
      st.saveMsg = '配線を保存できませんでした（未接続）。図面上の設定は保持しています。';
    }
    this._fwRefresh();
  },
  // Drop every authored edge → the server returns to the derived graph.
  _fwReset() {
    const st = this._fwState; if (!st) return;
    st.sel = null;
    if (st.graph) st.graph.edges = [];
    st.local = null;
    st.saveMsg = '保存中…';
    if (this._fwSaveTimer) clearTimeout(this._fwSaveTimer);
    const name = this._fwProject();
    if (!name) { st.saveMsg = 'プロジェクトが開いていないため保存できません。'; this._fwRefresh(); return; }
    fetch(`/api/projects/${encodeURIComponent(name)}/flow`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ edges: [] }),
    }).then((r) => (r.ok ? r.json() : null)).then((g) => {
      if (!this._fwAlive() || this._fwState !== st) return;
      if (g && Array.isArray(g.edges)) { st.graph = g; st.reachable = true; }
      st.saveMsg = '既定の流れに戻しました。';
      this._fwRefresh();
    }).catch(() => {
      if (!this._fwAlive() || this._fwState !== st) return;
      st.saveMsg = '初期化を保存できませんでした（未接続）。';
      this._fwRefresh();
    });
    this._fwRefresh();
  },

  // ---- graph accessors (always return something drawable) ------------------
  // The live edge list. Prefers the API graph; otherwise a locally derived chain
  // built from the ordered 工程 (so the tool is usable before/without the API).
  _fwEdges() {
    const st = this._fwState; if (!st) return [];
    const g = st.graph;
    if (g && Array.isArray(g.edges) && g.edges.length) return g.edges;
    if (!st.local) st.local = this._fwLocalEdges();
    return st.local;
  },
  // Derived chain: consecutive 工程 pairs, transport seeded from the stage's own
  // method so the drawing starts consistent with the model.
  _fwLocalEdges() {
    const order = this._orderedStages();
    const out = [];
    for (let i = 0; i < order.length - 1; i++) {
      out.push({
        src: order[i].id, dst: order[i + 1].id,
        transport: order[i].method || 'manual',
        equipment_ref: null, share: 1, derived: true,
        container_ref: '', carrier_ref: '',
      });
    }
    return out;
  },
  _fwNodes() {
    const st = this._fwState;
    const g = st && st.graph;
    if (g && Array.isArray(g.nodes) && g.nodes.length) return g.nodes;
    return this._orderedStages().map((s) => ({
      id: s.id, role: s.id, zone: s.zone || null, section: null, simulated: true,
    }));
  },
  _fwNode(id) { return this._fwNodes().find((n) => n && n.id === id) || null; },
  _fwNodeLabel(id) {
    const st = (this.model.process.stages || []).find((s) => s.id === id);
    if (st) return st.label || st.id;
    const n = this._fwNode(id);
    if (n) {
      const byRole = (this.model.process.stages || []).find((s) => s.id === n.role);
      if (byRole) return byRole.label || byRole.id;
      return n.role || n.id;
    }
    return String(id == null ? '' : id);
  },
  // World position (metres) of a flow node: its bound zone's centre. Falls back
  // through zone-id → zone-type → the same-id 工程's zone → the node's section.
  _fwNodePos(id) {
    const zones = this.model.layout.zones || [];
    const n = this._fwNode(id);
    let z = null;
    if (n && n.zone) z = zones.find((q) => q.id === n.zone) || zones.find((q) => q.type === n.zone) || null;
    if (!z) {
      const st = (this.model.process.stages || [])
        .find((s) => s.id === id || (n && s.id === n.role));
      if (st && st.zone) z = zones.find((q) => q.id === st.zone) || null;
    }
    if (!z && n && n.section) z = zones.find((q) => q.type === n.section) || null;
    return z ? this._zoneCenter(z) : null;
  },
  _fwKey(e, i) { return `${e && e.src}\u0000${e && e.dst}\u0000${i}`; },
  _fwSelEdge() {
    const st = this._fwState; if (!st || !st.sel) return null;
    const edges = this._fwEdges();
    for (let i = 0; i < edges.length; i++) if (this._fwKey(edges[i], i) === st.sel) return edges[i];
    // The graph was refetched and reordered: fall back to a src/dst match.
    const [s, d] = String(st.sel).split('\u0000');
    return edges.find((e) => e && e.src === s && e.dst === d) || null;
  },

  // ---- equipment (API list, or derived from the live drawing) ---------------
  // Normalised to {id, kind, label, points?, x?, y?, count?}. Deriving from the
  // in-editor model means the ghost reflects UNSAVED placements too.
  _fwEquipment() {
    const st = this._fwState;
    const api = st && st.graph && Array.isArray(st.graph.equipment) ? st.graph.equipment : null;
    if (api && api.length) {
      return api.filter((e) => e && e.id).map((e) => ({
        id: e.id, kind: e.kind || 'station', label: e.label || e.kind || e.id,
        points: toPts(e.points), x: Number.isFinite(+e.x) ? +e.x : null,
        y: Number.isFinite(+e.y) ? +e.y : null, count: e.count,
      }));
    }
    const res = this.model.resources || {};
    const lbl = (type) => {
      const p = EQUIP_PALETTE.find((q) => q.type === type || q.key === type);
      return p ? p.label : type;
    };
    const out = [];
    for (const c of (res.conveyors || [])) {
      const pts = toPts(c.points);
      if (pts.length >= 2) out.push({ id: c.id, kind: 'conveyor', label: c.name || 'コンベア', points: pts });
    }
    for (const e of (res.equipment || [])) {
      if (!e || !Number.isFinite(+e.x) || !Number.isFinite(+e.y)) continue;
      out.push({ id: e.id, kind: e.type || 'station', label: lbl(e.type), x: +e.x, y: +e.y, count: e.count, points: [] });
    }
    for (const s of (res.stations || [])) {
      if (!s || !Number.isFinite(+s.x) || !Number.isFinite(+s.y)) continue;
      out.push({ id: s.id, kind: 'station', label: '梱包台', x: +s.x, y: +s.y, count: s.count, points: [] });
    }
    return out;
  },
  _fwEquipById(id) {
    if (!id) return null;
    return this._fwEquipment().find((e) => e.id === id) || null;
  },
  _fwEquipColor(kind) {
    const p = EQUIP_PALETTE.find((q) => q.type === kind || q.key === kind);
    if (p) return p.color;
    return transportColor(KIND_TRANSPORT[kind] || 'manual');
  },

  // ---- canvas: 設備ゴースト (under the zone/arrow layer) --------------------
  _fwDrawEquipment() {
    if (!this.ctx || !this._view) return;
    const ctx = this.ctx, { sc } = this._view;
    const selEdge = this._fwSelEdge();
    const boundId = selEdge ? selEdge.equipment_ref : null;
    for (const eq of this._fwEquipment()) {
      const color = this._fwEquipColor(eq.kind);
      const lit = !!boundId && eq.id === boundId;      // wired to the open edge
      ctx.save();
      if (eq.points && eq.points.length >= 2) {
        // conveyor: its REAL polyline, muted (a brighter core when wired).
        ctx.strokeStyle = hexA(color, lit ? 0.85 : 0.3);
        ctx.lineWidth = lit ? 6 : 5;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(this._X(eq.points[0][0]), this._Y(eq.points[0][1]));
        for (let i = 1; i < eq.points.length; i++) ctx.lineTo(this._X(eq.points[i][0]), this._Y(eq.points[i][1]));
        ctx.stroke();
        ctx.fillStyle = hexA(color, lit ? 0.9 : 0.35);
        for (const p of eq.points) { ctx.beginPath(); ctx.arc(this._X(p[0]), this._Y(p[1]), lit ? 3.5 : 2.6, 0, 7); ctx.fill(); }
      } else if (eq.x != null && eq.y != null) {
        const p = EQUIP_PALETTE.find((q) => q.type === eq.kind || q.key === eq.kind);
        const wPx = Math.max((p && p.w ? p.w : 1.2) * sc, 16);
        const dPx = Math.max((p && p.d ? p.d : 0.9) * sc, 12);
        const cx = this._X(eq.x), cy = this._Y(eq.y);
        ctx.fillStyle = hexA(color, lit ? 0.36 : 0.12);
        ctx.strokeStyle = hexA(color, lit ? 0.95 : 0.4);
        ctx.lineWidth = lit ? 2.2 : 1.2;
        this._roundRectPath(cx - wPx / 2, cy - dPx / 2, wPx, dPx, Math.min(4, wPx / 5));
        ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }
  },

  // ---- canvas: wired edges --------------------------------------------------
  // Draws every resolvable edge in its transport colour, with a tie-line to the
  // bound belt/equipment and (when a measured volume exists) a 物量 chip.
  // Returns true when it drew at least one edge, so the legacy ribbon loop in
  // flow.js can stand down. Never throws — an unresolvable edge is skipped.
  _fwDrawEdges() {
    this._fwDrew = false;
    if (!this.ctx || !this._view) return false;
    const st = this._fwState; if (!st) return false;
    const edges = this._fwEdges();
    if (!edges.length) return false;
    const selEdge = this._fwSelEdge();
    let drew = 0;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (!e || e.src === e.dst) continue;
      const a = this._fwNodePos(e.src), b = this._fwNodePos(e.dst);
      if (!a || !b) continue;
      const ax = this._X(a[0]), ay = this._Y(a[1]);
      const bx = this._X(b[0]), by = this._Y(b[1]);
      if (Math.hypot(bx - ax, by - ay) < 1) continue;
      const t = e.transport || 'manual';
      const color = transportColor(t);
      const isSel = selEdge === e;
      const ctx = this.ctx;
      // selection halo (drawn under the ribbon so the hue stays true)
      if (isSel) {
        ctx.save();
        ctx.strokeStyle = hexA(color, 0.32); ctx.lineWidth = 11; ctx.lineCap = 'round';
        this._fwCurvePath(ax, ay, bx, by); ctx.stroke();
        ctx.restore();
      }
      this._drawArrow(ax, ay, bx, by, color);
      drew += 1;
      const [mx, my] = this._fwCurveMid(ax, ay, bx, by);
      // tie-line: edge midpoint → the bound belt/equipment (what carries it)
      const eq = this._fwEquipById(e.equipment_ref);
      if (eq) {
        const anchor = this._fwEquipAnchor(eq, mx, my);
        if (anchor) {
          ctx.save();
          ctx.strokeStyle = hexA(color, 0.7); ctx.lineWidth = 1.4; ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(anchor[0], anchor[1]); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = color;
          ctx.beginPath(); ctx.arc(anchor[0], anchor[1], 3.2, 0, 7); ctx.fill();
          ctx.restore();
        }
      }
      // 物量 chip (only when a measured volume exists for this leg)
      const vol = this._fwVolume(e);
      if (vol) this._chipLabel(mx, my - 15, vol.text, 'center');
    }
    this._fwDrew = drew > 0;
    return this._fwDrew;
  },
  // The bowed quadratic used by _drawArrow, as a path (for the selection halo).
  _fwCurvePath(ax, ay, bx, by) {
    const ctx = this.ctx;
    const [cxp, cyp] = this._fwCurveCtrl(ax, ay, bx, by);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cxp, cyp, bx, by);
  },
  _fwCurveCtrl(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(48, len * 0.14);
    return [(ax + bx) / 2 + (-dy / len) * bow, (ay + by) / 2 + (dx / len) * bow];
  },
  _fwCurveAt(ax, ay, bx, by, t) {
    const [cxp, cyp] = this._fwCurveCtrl(ax, ay, bx, by);
    const mt = 1 - t;
    return [mt * mt * ax + 2 * mt * t * cxp + t * t * bx,
      mt * mt * ay + 2 * mt * t * cyp + t * t * by];
  },
  _fwCurveMid(ax, ay, bx, by) { return this._fwCurveAt(ax, ay, bx, by, 0.5); },
  // Nearest point of a piece of equipment to (px,py), in screen px.
  _fwEquipAnchor(eq, px, py) {
    if (eq.points && eq.points.length >= 2) {
      let best = null;
      for (let i = 0; i < eq.points.length - 1; i++) {
        const [d2, qx, qy] = segDist2(px, py,
          this._X(eq.points[i][0]), this._Y(eq.points[i][1]),
          this._X(eq.points[i + 1][0]), this._Y(eq.points[i + 1][1]));
        if (!best || d2 < best[0]) best = [d2, qx, qy];
      }
      return best ? [best[1], best[2]] : null;
    }
    if (eq.x != null && eq.y != null) return [this._X(eq.x), this._Y(eq.y)];
    return null;
  },

  // ---- 物量 (measured only — never fabricated) ------------------------------
  // The volume through an edge is the SOURCE 工程's daily volume, split by the
  // user's own 分岐率. Returns null whenever no measured number is available.
  _fwVolume(e) {
    const st = this._fwState;
    const v = st && st.vol; if (!v || !e) return null;
    const n = this._fwNode(e.src);
    const keys = [];
    if (n) { if (n.role) keys.push(n.role, ROLE_VOL_KEY[n.role]); if (n.id) keys.push(n.id, ROLE_VOL_KEY[n.id]); }
    keys.push(e.src, ROLE_VOL_KEY[e.src], this._fwNodeLabel(e.src));
    let key = null;
    for (const k of keys) { if (k && v.volumes[k] != null) { key = k; break; } }
    if (key == null) return null;
    const base = +v.volumes[key];
    if (!Number.isFinite(base) || base <= 0) return null;
    const share = Math.max(0, Math.min(1, num(e.share, 1)));
    const unit = v.units[key] || '';
    const value = base * share;
    const pct = share < 1 ? `（${Math.round(share * 100)}%）` : '';
    return { value, unit, text: `${fmt(value)}${unit}/日${pct}` };
  },

  // ---- 荷姿 (容器/台車) — 入数は荷姿カタログが持つ唯一の値 --------------------
  // The catalogue comes from the server (loadunit.catalog): resolved, defaulted,
  // and shared with ②分析「基礎物量」. Empty ⇒ this module shows no 荷姿 controls.
  _fwUnits(kinds) {
    const st = this._fwState;
    const list = (st && Array.isArray(st.units)) ? st.units : [];
    return kinds ? list.filter((u) => u && kinds.includes(u.kind)) : list;
  },
  _fwUnitName(id) {
    if (!id) return '';
    const u = this._fwUnits().find((q) => q.id === id);
    return (u && u.name) || String(id);
  },
  // Options for one 荷姿 slot. An unknown ref stays visible rather than being
  // silently dropped (the same rule 使用設備 follows for a deleted machine).
  _fwUnitOpts(kinds, cur) {
    const opts = [{ value: '', label: '指定なし' }]
      .concat(this._fwUnits(kinds).map((u) => ({ value: u.id, label: u.name || u.id })));
    if (cur && !opts.some((o) => o.value === cur)) {
      opts.push({ value: cur, label: `${this._fwUnitName(cur)}（カタログに無い荷姿）` });
    }
    return opts;
  },
  // バラ点数/ケース数 flowing through this leg. The source 工程's section picks
  // 入荷 vs 出荷 and the user's 分岐率 scales it. null when nothing was measured —
  // we would rather show no 換算 than a fabricated one.
  _fwLegAmounts(e) {
    const st = this._fwState;
    const b = st && st.base;
    if (!b || !e) return null;
    const n = this._fwNode(e.src);
    const inbound = !!(n && n.section === '入荷');
    const pieces = Math.max(num(inbound ? b.in_pieces : b.out_pieces, 0), 0);
    const cases = Math.max(num(inbound ? b.in_cases : b.out_cases, 0), 0);
    if (pieces <= 0 && cases <= 0) return null;
    const share = Math.max(0, Math.min(1, num(e.share, 1)));
    return { pieces: Math.round(pieces * share), cases: Math.round(cases * share) };
  },
  // The SERVER's own 換算 line for this leg (GET /loadunits/convert), cached by its
  // inputs so a repaint never re-requests. Returns null until it is known; an
  // absent/failed endpoint stays null, i.e. the inspector shows nothing.
  _fwChain(e) {
    const st = this._fwState; if (!st || !e) return null;
    if (!st.chains) st.chains = {};
    const container = e.container_ref || '', carrier = e.carrier_ref || '';
    if (!container && !carrier) return null;
    const amt = this._fwLegAmounts(e); if (!amt) return null;
    const key = `${container}\0${carrier}\0${amt.pieces}\0${amt.cases}`;
    if (st.chains[key] !== undefined) return st.chains[key] || null;
    const name = this._fwProject(); if (!name) return null;
    st.chains[key] = '';        // in flight — one request per input set
    const q = `pieces=${amt.pieces}&cases=${amt.cases}`
      + `&container=${encodeURIComponent(container)}&carrier=${encodeURIComponent(carrier)}`;
    fetch(`/api/projects/${encodeURIComponent(name)}/loadunits/convert?${q}`,
      { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!this._fwAlive() || this._fwState !== st) return;
        const chain = (d && typeof d.chain === 'string') ? d.chain : '';
        if (!chain) return;
        st.chains[key] = chain;
        this._fwRefresh();
      })
      .catch(() => { /* 旧サーバ/未接続: 換算は出さない */ });
    return null;
  },

  // ---- canvas interaction ---------------------------------------------------
  // Returns true when the click was consumed by the wiring layer. Priority:
  //   1) an edge is open + you clicked equipment → BIND it
  //   2) you clicked an edge                     → SELECT it
  //   3) an edge is open + you clicked elsewhere → UNBIND (then, if already
  //      unbound, deselect and let the normal zone handler have the click)
  _fwDown(px, py) {
    const st = this._fwState; if (!st) return false;
    const sel = this._fwSelEdge();
    if (sel) {
      const eq = this._fwHitEquip(px, py);
      if (eq) { this._fwBind(sel, eq); return true; }
    }
    const hit = this._fwHitEdge(px, py);
    if (hit) {
      st.sel = hit.key;
      st.saveMsg = '';
      this._fwRefresh();
      return true;
    }
    if (sel) {
      if (sel.equipment_ref || (sel.transport && sel.transport !== 'manual')) {
        this._fwUnbind(sel);
        return true;
      }
      st.sel = null;           // already 人手: release the click to the zone layer
      this._fwRefresh();
    }
    return false;
  },
  // Nearest edge within EDGE_HIT_PX of the click (curve sampled at 25 points).
  _fwHitEdge(px, py) {
    if (!this._view) return null;
    const edges = this._fwEdges();
    let best = null;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (!e || e.src === e.dst) continue;
      const a = this._fwNodePos(e.src), b = this._fwNodePos(e.dst);
      if (!a || !b) continue;
      const ax = this._X(a[0]), ay = this._Y(a[1]);
      const bx = this._X(b[0]), by = this._Y(b[1]);
      // never steal the click from the 工程 hub at either end
      if (Math.hypot(px - ax, py - ay) < EDGE_END_GUARD_PX) continue;
      if (Math.hypot(px - bx, py - by) < EDGE_END_GUARD_PX) continue;
      let prev = [ax, ay];
      for (let s = 1; s <= 24; s++) {
        const pt = this._fwCurveAt(ax, ay, bx, by, s / 24);
        const [d2] = segDist2(px, py, prev[0], prev[1], pt[0], pt[1]);
        if (d2 <= EDGE_HIT_PX * EDGE_HIT_PX && (!best || d2 < best.d2)) {
          best = { d2, edge: e, key: this._fwKey(e, i) };
        }
        prev = pt;
      }
    }
    return best;
  },
  // Equipment under the cursor (conveyor polyline, or a point item's footprint).
  _fwHitEquip(px, py) {
    if (!this._view) return null;
    const { sc } = this._view;
    let best = null;
    for (const eq of this._fwEquipment()) {
      if (eq.points && eq.points.length >= 2) {
        for (let i = 0; i < eq.points.length - 1; i++) {
          const [d2] = segDist2(px, py,
            this._X(eq.points[i][0]), this._Y(eq.points[i][1]),
            this._X(eq.points[i + 1][0]), this._Y(eq.points[i + 1][1]));
          if (d2 <= EQUIP_HIT_PX * EQUIP_HIT_PX && (!best || d2 < best.d2)) best = { d2, eq };
        }
      } else if (eq.x != null && eq.y != null) {
        const p = EQUIP_PALETTE.find((q) => q.type === eq.kind || q.key === eq.kind);
        const wPx = Math.max((p && p.w ? p.w : 1.2) * sc, 16);
        const dPx = Math.max((p && p.d ? p.d : 0.9) * sc, 12);
        const cx = this._X(eq.x), cy = this._Y(eq.y);
        const dx = Math.abs(px - cx) - wPx / 2, dy = Math.abs(py - cy) - dPx / 2;
        if (dx <= 3 && dy <= 3) {
          const d2 = (px - cx) ** 2 + (py - cy) ** 2;
          if (!best || d2 < best.d2) best = { d2, eq };
        }
      }
    }
    return best ? best.eq : null;
  },

  // ---- edge mutation --------------------------------------------------------
  _fwBind(edge, eq) {
    const st = this._fwState; if (!st) return;
    const t = KIND_TRANSPORT[eq.kind] || 'manual';
    edge.transport = t;
    edge.equipment_ref = (t === 'manual') ? null : eq.id;
    edge.derived = false;
    this._fwMirrorStage(edge);
    st.note = (t === 'manual')
      ? `「${eq.label}」は搬送設備ではないため、人手のままにしました。`
      : `${this._fwNodeLabel(edge.src)}→${this._fwNodeLabel(edge.dst)} を「${eq.label}」に接続しました。`;
    this._fwTouch();
  },
  _fwUnbind(edge) {
    const st = this._fwState; if (!st) return;
    edge.transport = 'manual';
    edge.equipment_ref = null;
    edge.derived = false;
    this._fwMirrorStage(edge);
    st.note = `${this._fwNodeLabel(edge.src)}→${this._fwNodeLabel(edge.dst)} の接続を外し、人手に戻しました。`;
    this._fwTouch();
  },
  // Keep the legacy per-stage method in step when the edge's source IS a 工程 and
  // the transport is one the stage vocabulary can express (フォークリフト is a flow
  // concept only). This makes the strip badge / DES honour the wiring at once.
  _fwMirrorStage(edge) {
    const t = edge.transport || 'manual';
    if (!METHOD_OPTS.some((o) => o.value === t)) return;
    const st = (this.model.process.stages || []).find((s) => s.id === edge.src);
    if (!st) return;
    st.method = t;
    if (st.work) st.work.transport = t;
    if (typeof this._emitDirty === 'function') this._emitDirty();
  },
  // Broadcast the wiring alongside the 工程→エリア chain so ②マテリアルフロー can
  // live-update. `stages` MUST stay in the payload — the existing consumer reads it.
  _fwEmit() {
    if (typeof this._emitFlowChanged === 'function') {
      this._fwForceEmit = true;
      this._emitFlowChanged();
      this._fwForceEmit = false;
    }
  },
  // The wiring slice of the whsim:flow-changed payload.
  _fwEmitPayload() {
    const st = this._fwState;
    if (!st) return null;
    return {
      edges: this._fwEdges().map((e) => ({
        src: e.src, dst: e.dst, src_label: this._fwNodeLabel(e.src),
        dst_label: this._fwNodeLabel(e.dst), transport: e.transport || 'manual',
        equipment_ref: e.equipment_ref || null, share: num(e.share, 1),
        // additive: ②マテリアルフロー can show 何で運ぶか alongside 搬送手段.
        container_ref: e.container_ref || '', carrier_ref: e.carrier_ref || '',
        container_label: this._fwUnitName(e.container_ref),
        carrier_label: this._fwUnitName(e.carrier_ref),
      })),
      equipment: this._fwEquipment().map((e) => ({ id: e.id, kind: e.kind, label: e.label })),
      load_units: (st.units || []).map((u) => ({ id: u.id, name: u.name, kind: u.kind })),
      authored: !!(st.graph && st.graph.authored),
    };
  },

  // ---- side panel: エッジ・インスペクタ ------------------------------------
  _fwRenderInspector(s) {
    const st = this._fwState; if (!st || !s) return;
    const edge = this._fwSelEdge();
    if (!edge) {
      this._h(s, '設備への配線');
      this._note(s, '床図の矢印（工程間の流れ）をクリックすると、その流れを運ぶ設備を指定できます。'
        + '矢印を選んでからコンベアやAGVをクリックすると接続、何もない床をクリックで人手に戻ります。');
      if (st.note) {
        const n = this._div(s, 'margin-top:6px;font-size:11.5px;color:var(--ink-secondary);line-height:1.5;');
        n.textContent = st.note;
      }
      return;
    }
    this._h(s, `配線: ${this._fwNodeLabel(edge.src)} → ${this._fwNodeLabel(edge.dst)}`);

    const t = edge.transport || 'manual';
    const badge = this._div(s, `margin-bottom:8px;display:inline-block;font-size:11px;color:#fff;`
      + `background:${transportColor(t)};padding:2px 9px;border-radius:var(--r-pill);`);
    badge.textContent = TRANSPORT_JP[t] || t;

    // 搬送手段 (A axis vocabulary + フォークリフト, which the flow graph adds)
    this._field(s, '搬送手段', () => {
      const sel = this._select(null, TRANSPORT_OPTS, t);
      this._on(sel, 'change', () => {
        edge.transport = sel.value;
        const kinds = TRANSPORT_KINDS[sel.value] || [];
        const cur = this._fwEquipById(edge.equipment_ref);
        if (!cur || !kinds.includes(cur.kind)) edge.equipment_ref = null;
        edge.derived = false;
        this._fwMirrorStage(edge);
        st.note = '';
        this._fwTouch();
      });
      return sel;
    });

    // 使用設備 — only the equipment that can serve the chosen transport.
    const kinds = TRANSPORT_KINDS[edge.transport || 'manual'] || [];
    const matches = this._fwEquipment().filter((e) => kinds.includes(e.kind));
    if (!kinds.length) {
      this._note(s, '人手の流れです。搬送手段を選ぶと、その設備を指定できます。');
    } else {
      const opts = [{ value: '', label: '指定なし' }]
        .concat(matches.map((e) => ({ value: e.id, label: e.label || e.id })));
      // Keep an unknown ref visible rather than silently dropping the user's data.
      if (edge.equipment_ref && !matches.some((e) => e.id === edge.equipment_ref)) {
        opts.push({ value: edge.equipment_ref, label: `${edge.equipment_ref}（図面に無い設備）` });
      }
      this._field(s, '使用設備', () => {
        const sel = this._select(null, opts, edge.equipment_ref || '');
        this._on(sel, 'change', () => {
          edge.equipment_ref = sel.value || null;
          const eq = this._fwEquipById(edge.equipment_ref);
          if (eq) edge.transport = KIND_TRANSPORT[eq.kind] || edge.transport;
          edge.derived = false;
          this._fwMirrorStage(edge);
          st.note = '';
          this._fwTouch();
        });
        return sel;
      });
      if (!matches.length) {
        this._note(s, 'この搬送手段に使える設備が図面にありません。「配置」タブで設備を置いてください。');
      }
    }

    // 荷姿 — 何に入れて (容器) 何に載せて (台車) 運ぶか。選択肢も入数も 荷姿カタログ
    // (②分析「基礎物量」で編集するのと同じもの) から来る。人手の区間は台車が、
    // ベルト/自動倉庫の区間は容器が効くので、効くほうを先に置く。
    if (this._fwUnits().length) {
      const beltish = (edge.transport === 'conveyor' || edge.transport === 'asrs');
      const packField = (label, kinds, prop) => this._field(s, label, () => {
        const sel = this._select(null, this._fwUnitOpts(kinds, edge[prop] || ''), edge[prop] || '');
        this._on(sel, 'change', () => {
          edge[prop] = sel.value || '';
          edge.derived = false;
          st.note = '';
          this._fwTouch();
        });
        return sel;
      });
      const container = () => packField('容器（何に入れて運ぶか）', ['container'], 'container_ref');
      const carrier = () => packField('台車（何に載せて運ぶか）', ['carrier', 'pallet'], 'carrier_ref');
      this._h(s, '荷姿');
      if (beltish) { container(); carrier(); } else { carrier(); container(); }
      const hint = this._div(s, 'font-size:11px;color:var(--ink-tertiary);margin:-2px 0 6px;line-height:1.5;');
      hint.textContent = beltish
        ? 'ベルトを流れるのは容器です（オリコンが流れる）。'
        : '人が運ぶ区間は台車が効きます（カゴ台車で運ぶ）。';
      // 換算のこだま: サーバの計算式をそのまま出す。物量が分からなければ何も出さない。
      const chain = this._fwChain(edge);
      if (chain) {
        const c = this._div(s, 'font-size:11px;color:var(--ink-tertiary);margin:0 0 8px;line-height:1.5;');
        c.textContent = `換算: ${chain}`;
      }
    }

    // 分岐率 — how much of the source 工程's flow takes this leg.
    this._field(s, '分岐率（%）', () => this._num(Math.round(num(edge.share, 1) * 100), (v) => {
      edge.share = Math.max(0, Math.min(1, v / 100));
      edge.derived = false;
      st.note = '';
      this._fwTouch();
    }, 1));
    const sub = this._div(s, 'font-size:11px;color:var(--ink-tertiary);margin:-2px 0 8px;line-height:1.5;');
    sub.textContent = '同じ工程から複数の流れが出るとき、この流れが受け持つ割合。';

    // 物量 (only when measured; otherwise say so instead of showing a number)
    const vol = this._fwVolume(edge);
    const volRow = this._div(s, 'font-size:11.5px;color:var(--ink-secondary);margin:2px 0 8px;line-height:1.5;');
    volRow.textContent = vol
      ? `物量: ${vol.text}（②分析の基礎物量より）`
      : '物量: 未取込（②分析で基礎物量を取り込むと矢印に表示されます）';

    const nSrc = this._fwNode(edge.src), nDst = this._fwNode(edge.dst);
    if ((nSrc && nSrc.simulated === false) || (nDst && nDst.simulated === false)) {
      const w = this._div(s, 'font-size:11.5px;color:var(--warn);line-height:1.5;margin-bottom:6px;');
      w.textContent = '⚠ この流れの工程はシミュレーション対象外です（検証の対象になりません）。';
    }

    const row = this._div(s, 'display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;');
    this._btn(row, '選択解除', () => { st.sel = null; st.note = ''; this._fwRefresh(); }, 'font-size:12px;');
    this._btn(row, '配線をリセット', () => this._fwReset(), 'font-size:12px;')
      .title = 'すべての配線を消し、工程順から自動で引き直した既定の流れに戻します';

    if (st.saveMsg) {
      const m = this._div(s, 'font-size:11.5px;margin-top:6px;line-height:1.5;color:'
        + (/できません|失敗/.test(st.saveMsg) ? 'var(--bad)' : 'var(--ink-secondary)') + ';');
      m.textContent = st.saveMsg;
    }
    if (st.note) {
      const n = this._div(s, 'font-size:11.5px;color:var(--ink-secondary);margin-top:4px;line-height:1.5;');
      n.textContent = st.note;
    }
  },

  // ---- diagnostics list (under the canvas) ---------------------------------
  // Compact, tone-coded WARNINGS. Never blocks anything; an empty/absent list
  // renders nothing at all (and an unreachable API renders one calm line).
  _fwRenderDiagnostics() {
    const host = this._fwDiagHost;
    if (!host || !host.isConnected) return;
    const st = this._fwState;
    host.innerHTML = '';
    if (!st) return;
    const list = (st.graph && Array.isArray(st.graph.diagnostics)) ? st.graph.diagnostics : [];
    const rows = [];
    let warnings = 0;
    if (st.note && st.reachable === false) {
      rows.push(`<div class="fw-diag-row" style="${TONE_CSS.info}">`
        + `<span class="fw-diag-mark">ℹ</span><span class="fw-diag-msg">${esc(st.note)}</span></div>`);
    }
    for (const d of list) {
      if (!d) continue;
      const tone = diagTone(d);
      const msg = d.message || d.detail || d.kind || '';
      if (!msg) continue;
      const kind = d.kind && d.message ? `<span class="fw-diag-kind">${esc(d.kind)}</span>` : '';
      rows.push(`<div class="fw-diag-row" style="${TONE_CSS[tone]}">`
        + `<span class="fw-diag-mark">${TONE_MARK[tone]}</span>${kind}`
        + `<span class="fw-diag-msg">${esc(msg)}</span></div>`);
      warnings += 1;
    }
    if (!rows.length) return;
    const head = warnings ? `配線の注意（${warnings}件・参考）` : '配線';
    host.innerHTML = `<div class="fw-diag"><div class="fw-diag-h">${esc(head)}</div>`
      + rows.join('') + '</div>';
  },

  // ---- canvas legend: what the ribbon colours mean -------------------------
  // Sits just above the existing マテリアルフロー legend pill and lists ONLY the
  // transports actually present, so the key never outgrows the diagram. Chrome
  // (pill background / ink) comes from the theme palette; the swatches are the
  // shared transport hues.
  _fwLegend() {
    if (!this.ctx || !this._view || !this._fwDrew) return;
    const used = [];
    for (const e of this._fwEdges()) {
      const t = (e && e.transport) || 'manual';
      if (!used.includes(t)) used.push(t);
    }
    if (used.length < 2) return;                 // one transport: nothing to key
    const ctx = this.ctx, { w, h } = this._view;
    const P = this.pal;
    ctx.save();
    ctx.font = '600 10.5px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const items = used.map((t) => ({ t, label: TRANSPORT_JP[t] || t }));
    const padX = 9, pillH = 20, sw = 14, gap = 5, itemGap = 12;
    let pw = padX * 2;
    for (const it of items) pw += sw + gap + ctx.measureText(it.label).width + itemGap;
    pw -= itemGap;
    if (pw > w - 20) { ctx.restore(); return; }  // too narrow: skip rather than clip
    const x = 10, y = h - 10 - 22 - 4 - pillH, cy = y + pillH / 2;
    ctx.fillStyle = P.badgeBg;
    this._roundRectPath(x, y, pw, pillH, 7); ctx.fill();
    let cx = x + padX;
    for (const it of items) {
      ctx.strokeStyle = transportColor(it.t); ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + sw, cy); ctx.stroke();
      cx += sw + gap;
      ctx.fillStyle = P.selInk;
      ctx.fillText(it.label, cx, cy + 0.5);
      cx += ctx.measureText(it.label).width + itemGap;
    }
    ctx.restore();
  },

  // One-line hint for the flow status bar while wiring.
  _fwStatusText() {
    const st = this._fwState; if (!st) return '';
    const edge = this._fwSelEdge();
    if (!edge) return '';
    const eq = this._fwEquipById(edge.equipment_ref);
    const head = `選択中の流れ: ${this._fwNodeLabel(edge.src)} → ${this._fwNodeLabel(edge.dst)}`;
    const tail = eq ? `（${eq.label}）` : `（${TRANSPORT_JP[edge.transport || 'manual'] || ''}）`;
    return `${head}${tail} — 設備をクリックで接続、何もない床をクリックで人手に戻します。`;
  },
};
