// dashboard/stage.js — ダッシュボードの主役ステージに重ねる「ガラスの計器類」.
//
// This module owns NOTHING of the 3D scene itself: the integrator mounts the
// three.js Scene3D into hosts.stage3d and hands the live instance over as
// `ctx.scene3d` (may be null / may appear later). What lives here is everything
// FLOATING on top of that picture:
//
//   (a) hosts.ovLeft  — 表示切替   (radio list derived from the zones really present)
//   (b) hosts.ovLeft  — シミュレーション状況 (clock / orders / progress bar)
//   (c) hosts.ovRight — 稼働ステータス (one row per resource class present)
//   (d) hosts.pins    — floor name pins, camera-projected each frame
//
// Pins are projected with the LIVE camera when one is reachable (plain matrix
// math on camera.projectionMatrix × camera.matrixWorldInverse — no THREE import,
// so a missing/failed 3D scene can never break this module), and fall back to a
// static top-down fit of replay.meta.bounds otherwise. never-blocks: no run ⇒ one
// quiet centred line, never a throw and never a blank box.
//
// EN comments / JA UI.
import { esc } from '../util.js';

// ---- small helpers ---------------------------------------------------------
const num = (n) => (n == null || !isFinite(n) ? null : Number(n));
const fmt = (n, d = 0) => (num(n) == null ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));
const reduceMotion = () => {
  try { return matchMedia('(prefers-reduced-motion:reduce)').matches; } catch (_) { return false; }
};
// Ratios arrive either as 0..1 or already as percent depending on the field.
const asRatio = (v) => {
  const n = num(v);
  if (n == null) return null;
  return n > 1.0000001 ? n / 100 : n;
};
// Zone `color` comes from data — only ever let a plain hex / rgb() through.
const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\))$/;
const safeColor = (c, fb) => (typeof c === 'string' && SAFE_COLOR.test(c.trim()) ? c.trim() : fb);

// Canonical zone-type vocabulary (order = display order of the toggle).
const ZONE_JP = {
  receiving: '入荷エリア',
  storage: '保管エリア',
  picking: 'ピッキングエリア',
  processing: '流通加工',
  packing: '梱包エリア',
  shipping: '出荷エリア',
  staging: '仮置きエリア',
};
const ZONE_ORDER = ['receiving', 'storage', 'picking', 'processing', 'packing', 'shipping', 'staging'];
const MAX_PINS = 24;

// A zone `type` is data, so it can be anything: classList.add() THROWS on a
// value containing a space, which would take the whole panel down. Every use of
// a type inside a class name goes through this.
const slug = (t) => (String(t == null ? '' : t).replace(/[^A-Za-z0-9_-]/g, '_') || 'all');
// One dim rule per focusable type (attribute selector keeps the raw value).
const dimRule = (t) => `
  .dst-focus-${slug(t)} .dst-pin:not([data-zt="${String(t).replace(/["\\]/g, '\\$&')}"]){--dim:.16}`;

function injectStyle() {
  if (document.getElementById('dst-style')) return;
  const s = document.createElement('style');
  s.id = 'dst-style';
  // Dim rules for the 表示切替 focus: pins keep their own visibility in --vis
  // (set inline by the projector) and the focus only touches --dim, so the two
  // never fight over `opacity`.
  const dimRules = ZONE_ORDER.map(dimRule).join('');
  s.textContent = `
  .dst-card{background:var(--bg-overlay);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
    border:1px solid var(--line-soft);border-radius:var(--r-md,10px);box-shadow:var(--sh-xs);
    padding:var(--sp-3,10px) var(--sp-3,10px);margin-bottom:var(--sp-2,8px);min-width:158px}
  .dst-card h4{display:flex;align-items:baseline;justify-content:space-between;gap:var(--sp-3,10px);
    margin:0 0 var(--sp-2,8px);font-size:var(--fs-micro,10px);letter-spacing:.08em;
    font-weight:var(--fw-semibold,600);color:var(--ink-tertiary);text-transform:none}
  .dst-card h4 span{font-weight:var(--fw-regular,400);color:var(--ink-faint);letter-spacing:0}
  .dst-card:last-child{margin-bottom:0}
  /* (a) 表示切替 */
  .dst-radio{display:flex;align-items:center;gap:var(--sp-2,8px);padding:3px 2px;cursor:pointer;
    font-size:var(--fs-xs,11.5px);color:var(--ink-secondary);border-radius:var(--r-xs,5px)}
  .dst-radio:hover{background:var(--bg-hover);color:var(--ink-primary)}
  .dst-radio input{appearance:none;-webkit-appearance:none;margin:0;padding:0;box-sizing:border-box;
    width:11px;height:11px;min-height:0;flex:none;
    border:1px solid var(--line-strong);border-radius:50%;background:transparent;cursor:pointer}
  .dst-radio input:checked{border-color:var(--accent);box-shadow:inset 0 0 0 2.5px var(--accent)}
  .dst-radio input:focus-visible{outline:2px solid var(--line-focus,var(--accent));outline-offset:2px}
  .dst-radio.on{color:var(--ink-primary);font-weight:var(--fw-medium,500)}
  .dst-swatch{width:7px;height:7px;border-radius:2px;flex:none}
  /* (b) シミュレーション状況 */
  .dst-row{display:flex;align-items:baseline;justify-content:space-between;gap:var(--sp-3,10px);
    padding:2.5px 0;font-size:var(--fs-xs,11.5px);color:var(--ink-tertiary);white-space:nowrap}
  .dst-row b{color:var(--ink-primary);font-weight:var(--fw-semibold,600);
    font-variant-numeric:tabular-nums;font-size:var(--fs-sm,12.5px)}
  .dst-row b .u{font-size:var(--fs-micro,10px);font-weight:var(--fw-regular,400);
    color:var(--ink-tertiary);margin-left:2px}
  .dst-pill{display:inline-flex;align-items:center;gap:5px;border-radius:var(--r-pill,999px);
    padding:1px 8px;font-size:var(--fs-micro,10px);font-weight:var(--fw-semibold,600)}
  .dst-pill i{width:5px;height:5px;border-radius:50%;background:currentColor;display:block}
  .dst-pill.on{background:var(--ok-tint);color:var(--ok-ink,var(--ok))}
  .dst-pill.off{background:var(--bg-hover);color:var(--ink-tertiary)}
  .dst-bar{height:4px;border-radius:var(--r-pill,999px);background:var(--bg-hover);
    margin-top:var(--sp-2,8px);overflow:hidden}
  .dst-bar i{display:block;height:100%;border-radius:inherit;background:var(--accent);
    transition:width .35s ease}
  .dst-nomo .dst-bar i{transition:none}
  /* (c) 機器ステータス */
  .dst-eq{display:flex;align-items:center;gap:var(--sp-2,8px);padding:3px 0;font-size:var(--fs-xs,11.5px)}
  .dst-eq .dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--ink-faint)}
  .dst-eq .lb{color:var(--ink-secondary);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
  .dst-eq .fr{font-variant-numeric:tabular-nums;color:var(--ink-tertiary);white-space:nowrap}
  .dst-eq .fr b{color:var(--ink-primary);font-weight:var(--fw-semibold,600)}
  /* (d) floor pins */
  .dst-pin{position:absolute;left:0;top:0;transform:translate(-50%,-50%);opacity:calc(var(--vis,1)*var(--dim,1));
    display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:var(--r-pill,999px);
    font-size:var(--fs-micro,10px);font-weight:var(--fw-semibold,600);letter-spacing:.02em;
    white-space:nowrap;pointer-events:none;will-change:transform,opacity;
    background:var(--bg-overlay);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
    border:1px solid var(--line-soft);color:var(--ink-primary);box-shadow:var(--sh-xs);
    transition:opacity .18s linear}
  .dst-nomo .dst-pin{transition:none}
  .dst-pin i{width:6px;height:6px;border-radius:2px;flex:none;background:var(--ink-faint)}
  .dst-pin.rack{font-family:var(--font-mono,monospace);letter-spacing:.04em;
    background:var(--bg-panel);color:var(--ink-secondary);font-size:var(--fs-micro,10px)}
  .dst-quiet{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    color:var(--ink-tertiary);font-size:var(--fs-sm,12.5px);letter-spacing:.02em;text-align:center;padding:var(--sp-4,14px)}
  ${dimRules}
  `;
  document.head.appendChild(s);
}

// ---- 1D gap clustering (used to find rack rows / columns) -------------------
// Splits a sorted list of coordinates wherever the gap exceeds `tol`.
function clusters(values, tol) {
  const v = values.slice().sort((a, b) => a - b);
  if (!v.length) return [];
  const out = [];
  let cur = [v[0]];
  for (let i = 1; i < v.length; i++) {
    if (v[i] - v[i - 1] > tol) { out.push(cur); cur = []; }
    cur.push(v[i]);
  }
  out.push(cur);
  return out;
}

const uniqSorted = (vals) => [...new Set(vals.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b);
// Typical spacing between distinct coordinates on one axis (median gap).
function medGap(u) {
  if (!u || u.length < 2) return null;
  const d = [];
  for (let i = 1; i < u.length; i++) d.push(u[i] - u[i - 1]);
  d.sort((a, b) => a - b);
  // lower median: with only a couple of gaps this keeps the TIGHT spacing as
  // "typical", which is what tells a rack run apart from an aisle pitch.
  return d[Math.floor((d.length - 1) / 2)] || null;
}

// Assigns every rack point to a block: letter = row band, number = column index.
// The COLUMN axis is the one racks are spaced further apart on (the aisle
// pitch); the other axis is the direction each rack run extends along, so a
// dense 0.5 m run stays one block instead of exploding into confetti. Mirrors
// the mockup's A01 A02 / B01 B02.
function rackBlocks(racks) {
  // Coerce here: isFinite() happily accepts null ("0") and numeric STRINGS, and a
  // string coordinate turns every later `+` into concatenation.
  const pts = [];
  for (const r of (racks || [])) {
    if (!r) continue;
    const x = num(r.x); const y = num(r.y);
    if (x == null || y == null) continue;
    pts.push({ x, y });
  }
  if (!pts.length) return [];
  const gx = medGap(uniqSorted(pts.map((p) => p.x)));
  const gy = medGap(uniqSorted(pts.map((p) => p.y)));
  const domX = gx == null ? false : (gy == null ? true : gx >= gy);
  const dom = (p) => (domX ? p.x : p.y);        // column axis
  const cross = (p) => (domX ? p.y : p.x);      // run axis
  const gCol = (domX ? gx : gy) || 1;
  const gRun = (domX ? gy : gx) || 1;
  const tolCol = Math.max(0.6, gCol * 0.6);     // err toward splitting: culling protects us
  const tolRun = Math.max(2.0, gRun * 3);

  const bands = clusters(pts.map(cross), tolRun);
  const bandOf = (val) => {
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (val >= b[0] - 1e-6 && val <= b[b.length - 1] + 1e-6) return i;
    }
    return bands.length - 1;
  };
  const byBand = new Map();
  for (const p of pts) {
    const bi = bandOf(cross(p));
    if (!byBand.has(bi)) byBand.set(bi, []);
    byBand.get(bi).push(p);
  }
  const blocks = [];
  for (const [bi, members] of [...byBand.entries()].sort((a, b) => a[0] - b[0])) {
    const cols = clusters(members.map(dom), tolCol);
    cols.forEach((col, ci) => {
      const lo = col[0] - 1e-6; const hi = col[col.length - 1] + 1e-6;
      const mine = members.filter((p) => dom(p) >= lo && dom(p) <= hi);
      if (!mine.length) return;
      const cx = mine.reduce((s, p) => s + p.x, 0) / mine.length;
      const cy = mine.reduce((s, p) => s + p.y, 0) / mine.length;
      const letter = String.fromCharCode(65 + (bi % 26));
      blocks.push({ code: letter + String(ci + 1).padStart(2, '0'), x: cx, y: cy, n: mine.length });
    });
  }
  return blocks;
}

// ---- projection ------------------------------------------------------------
// clip = P · V · p  with column-major three.js matrix elements. Returns null if
// the camera is not usable; w<=0 means the point sits behind the eye.
function projectWithCamera(cam, x, y, z) {
  const P = cam.projectionMatrix && cam.projectionMatrix.elements;
  const V = cam.matrixWorldInverse && cam.matrixWorldInverse.elements;
  if (!P || !V) return null;
  const e = (m, r, c) => m[c * 4 + r];
  // view-space point
  const vx = e(V, 0, 0) * x + e(V, 0, 1) * y + e(V, 0, 2) * z + e(V, 0, 3);
  const vy = e(V, 1, 0) * x + e(V, 1, 1) * y + e(V, 1, 2) * z + e(V, 1, 3);
  const vz = e(V, 2, 0) * x + e(V, 2, 1) * y + e(V, 2, 2) * z + e(V, 2, 3);
  const vw = e(V, 3, 0) * x + e(V, 3, 1) * y + e(V, 3, 2) * z + e(V, 3, 3);
  // clip-space
  const cx = e(P, 0, 0) * vx + e(P, 0, 1) * vy + e(P, 0, 2) * vz + e(P, 0, 3) * vw;
  const cy = e(P, 1, 0) * vx + e(P, 1, 1) * vy + e(P, 1, 2) * vz + e(P, 1, 3) * vw;
  const cw = e(P, 3, 0) * vx + e(P, 3, 1) * vy + e(P, 3, 2) * vz + e(P, 3, 3) * vw;
  if (!isFinite(cx) || !isFinite(cy) || !isFinite(cw) || cw <= 1e-6) return null;
  return { ndcX: cx / cw, ndcY: cy / cw };
}

export function mountStage(hosts, ctx) {
  injectStyle();
  if (!hosts || !hosts.stage) return { update() {}, dispose() {} };

  const stage = hosts.stage;
  const ovL = hosts.ovLeft;
  const ovR = hosts.ovRight;
  const pinHost = hosts.pins;
  if (reduceMotion()) stage.classList.add('dst-nomo');
  // The shell already sets position:relative, but never assume.
  try {
    if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
  } catch (_) { /* noop */ }

  let cur = ctx || {};
  let focus = 'all';                 // selected 表示切替 entry
  let toggleSig = '';                // rebuild the radio list only when it changes
  let pins = [];                     // [{el, wx, wy, wz}]
  let pinSig = '';
  let raf = 0;
  let ro = null;
  let camSig = '';                   // cheap "did the camera move" fingerprint
  let lastScene = null;              // identity of the Scene3D we last saw
  let lastClockTxt = '';
  const els = {};                    // cached nodes of the status panel
  const dimDone = new Set();         // extra zone types that already have a dim rule

  // ---------- (a) 表示切替 ---------------------------------------------------
  function zoneTypes() {
    const zs = (cur.replay && Array.isArray(cur.replay.zones)) ? cur.replay.zones : [];
    const seen = new Map();
    for (const z of zs) {
      if (!z || !z.type) continue;
      if (!seen.has(z.type)) seen.set(z.type, safeColor(z.color, ''));
    }
    const known = ZONE_ORDER.filter((t) => seen.has(t));
    const extra = [...seen.keys()].filter((t) => !ZONE_ORDER.includes(t));
    return [...known, ...extra].map((t) => ({ type: t, label: ZONE_JP[t] || t, color: seen.get(t) }));
  }

  // A zone type outside the canonical vocabulary still has to dim its peers, so
  // append its rule to the shared sheet the first time it is selected.
  function ensureDimRule(type) {
    if (!type || type === 'all' || ZONE_ORDER.includes(type) || dimDone.has(type)) return;
    dimDone.add(type);
    const sheet = document.getElementById('dst-style');
    if (sheet) sheet.textContent += dimRule(type);
  }

  function applyFocus(type) {
    focus = type || 'all';
    ensureDimRule(focus);
    for (const c of [...stage.classList]) if (c.startsWith('dst-focus-')) stage.classList.remove(c);
    stage.classList.add('dst-focus-' + slug(focus));
    try {
      const s3 = cur.scene3d;
      if (s3 && typeof s3.setBottleneck === 'function') s3.setBottleneck(focus === 'all' ? null : focus);
    } catch (_) { /* a 3D hiccup must never break the panel */ }
  }

  function renderToggle(types) {
    if (!ovL) return;
    const sig = types.map((t) => t.type).join('|');
    if (sig === toggleSig && els.toggle) {
      if (els.toggle.parentNode !== ovL) ovL.insertBefore(els.toggle, ovL.firstChild);
      return;
    }
    toggleSig = sig;
    if (!types.some((t) => t.type === focus)) focus = 'all';
    const rows = [{ type: 'all', label: '全体', color: '' }, ...types].map((t) => `
      <label class="dst-radio${t.type === focus ? ' on' : ''}" data-t="${esc(t.type)}">
        <input type="radio" name="dst-view" value="${esc(t.type)}"${t.type === focus ? ' checked' : ''}/>
        ${t.color ? `<span class="dst-swatch" style="background:${esc(t.color)}"></span>` : ''}
        <span>${esc(t.label)}</span>
      </label>`).join('');
    els.toggle = els.toggle || document.createElement('div');
    els.toggle.className = 'dst-card dst-toggle';
    els.toggle.innerHTML = `<h4>表示切替</h4>${rows}`;
    if (els.toggle.parentNode !== ovL) ovL.appendChild(els.toggle);
    els.toggle.querySelectorAll('input[name=dst-view]').forEach((inp) => {
      inp.addEventListener('change', () => {
        applyFocus(inp.value);
        els.toggle.querySelectorAll('.dst-radio').forEach((l) => {
          l.classList.toggle('on', l.dataset.t === focus);
        });
      });
    });
    applyFocus(focus);
  }

  // ---------- (b) シミュレーション状況 --------------------------------------
  // Live value at the replay clock from the sampled series (forward fill).
  function seriesAt(key) {
    const s = cur.replay && Array.isArray(cur.replay.series) ? cur.replay.series : null;
    if (!s || !s.length) return null;
    const t = num(cur.getTime && cur.getTime()) || 0;
    let v = null;
    for (const p of s) { if (p && p.t <= t) v = num(p[key]); else break; }
    return v;
  }

  function clockText() {
    const dur = num(cur.replay && cur.replay.meta && cur.replay.meta.duration_s)
      || num(cur.kpis && cur.kpis.duration_s);
    const t = num(cur.getTime && cur.getTime()) || 0;
    const a = (t / 3600);
    const b = dur ? dur / 3600 : null;
    return b == null ? `${fmt(a, 1)} 時間` : `${fmt(a, 1)} / ${fmt(b, 1)} 時間`;
  }

  function renderStatus() {
    if (!ovL) return;
    const k = cur.kpis || {};
    const playing = !!(cur.getPlaying && cur.getPlaying());
    const done = seriesAt('done');
    const rows = [];
    const push = (label, html) => rows.push(
      `<div class="dst-row"><span>${esc(label)}</span>${html}</div>`);

    push('現在のステータス', `<span class="dst-pill ${playing ? 'on' : 'off'}" data-pill><i></i>${playing ? '運用中' : '停止中'}</span>`);
    push('経過時間', `<b data-clock>${esc(clockText())}</b>`);
    if (num(k.orders_completed) != null || num(k.orders_arrived) != null) {
      push('処理オーダー数',
        `<b>${fmt(k.orders_completed)} / ${fmt(k.orders_arrived)}<span class="u">件</span></b>`);
    }
    if (num(k.orders_arrived) != null) push('到着オーダー', `<b>${fmt(k.orders_arrived)}<span class="u">件</span></b>`);
    const shipped = done != null ? done : num(k.orders_completed);
    if (shipped != null) push('出荷数', `<b data-shipped>${fmt(shipped)}<span class="u">件</span></b>`);
    // `wip` / `wip_avg` are orders in flight, NOT stock on hand — the run has no
    // inventory count, so this row must not be sold as 在庫数.
    const wip = seriesAt('wip');
    const stock = wip != null ? wip : num(k.wip_avg);
    if (stock != null) push('仕掛オーダー', `<b data-wip>${fmt(stock, wip != null ? 0 : 1)}<span class="u">件</span></b>`);

    const rate = asRatio(k.completion_rate);
    let bar = '';
    if (rate != null) {
      const p = Math.max(0, Math.min(1, rate));
      const tone = p >= 0.95 ? 'var(--ok)' : p >= 0.7 ? 'var(--accent)' : p >= 0.4 ? 'var(--warn)' : 'var(--bad)';
      bar = `<div class="dst-row" style="padding-top:6px"><span>完了率</span><b>${fmt(p * 100, 0)}<span class="u">%</span></b></div>
        <div class="dst-bar"><i style="width:${(p * 100).toFixed(1)}%;background:${tone}"></i></div>`;
    }
    els.status = els.status || document.createElement('div');
    els.status.className = 'dst-card dst-status';
    els.status.innerHTML = `<h4>シミュレーション状況</h4>${rows.join('')}${bar}`;
    if (els.status.parentNode !== ovL) ovL.appendChild(els.status);
    lastClockTxt = clockText();
  }

  // ---------- (c) 機器ステータス --------------------------------------------
  function renderEquipment() {
    if (!ovR) return;
    const k = cur.kpis || {};
    const r = cur.replay || {};
    const classes = [
      { label: 'AGV', n: num(k.n_agvs), u: asRatio(k.agv_utilization) },
      { label: 'フォークリフト', n: (Array.isArray(r.forklifts) ? r.forklifts.length : null), u: null },
      { label: 'コンベヤ', n: num(k.n_conveyors), u: asRatio(k.conveyor_utilization) },
      // n_packers / n_pickers are HEADCOUNTS, not machines — label them as people.
      { label: '梱包作業者', n: num(k.n_packers), u: asRatio(k.packer_utilization) },
      { label: 'ピッカー', n: num(k.n_pickers), u: asRatio(k.picker_utilization) },
    ].filter((c) => c.n != null && c.n > 0);

    ovR.innerHTML = '';
    if (!classes.length) return;
    const rows = classes.map((c) => {
      const tone = c.u == null ? 'var(--ink-faint)'
        : c.u > 0.95 ? 'var(--bad)' : c.u > 0.80 ? 'var(--warn)' : 'var(--ok)';
      const busy = c.u == null ? '—' : fmt(Math.max(0, Math.min(c.n, Math.round(c.u * c.n))));
      return `<div class="dst-eq"><span class="dot" style="background:${tone}"></span>
        <span class="lb">${esc(c.label)}</span>
        <span class="fr"><b>${busy}</b> / ${fmt(c.n)}</span></div>`;
    }).join('');
    const card = document.createElement('div');
    card.className = 'dst-card dst-equip';
    card.innerHTML = `<h4>稼働ステータス<span>使用中 / 総数</span></h4>${rows}`;
    ovR.appendChild(card);
  }

  // ---------- (d) floor pins -------------------------------------------------
  function buildPins() {
    if (!pinHost) return;
    const r = cur.replay || {};
    const zones = Array.isArray(r.zones) ? r.zones : [];
    const blocks = rackBlocks(r.racks);
    // GEOMETRY, not just counts: editing the layout and re-running keeps the same
    // zone/rack counts under the same project name, and a counts-only signature
    // left every pin frozen at its old spot.
    let geo = 0;
    for (const z of zones) {
      if (!z) continue;
      geo += (num(z.x) || 0) * 3 + (num(z.y) || 0) * 5 + (num(z.w) || 0) * 7 + (num(z.h) || 0) * 11;
    }
    for (const b of blocks) geo += b.x * 13 + b.y * 17 + b.n;
    const sig = `${zones.length}:${(r.racks || []).length}:${(r.meta && r.meta.name) || ''}:${blocks.length}:${geo.toFixed(2)}`;
    if (sig === pinSig && pins.length) return;
    pinSig = sig;
    pinHost.innerHTML = '';
    pins = [];
    if (!zones.length && !blocks.length) return;

    const mk = (html, zt, cls) => {
      const el = document.createElement('div');
      el.className = 'dst-pin' + (cls ? ' ' + cls : '');
      el.dataset.zt = zt;
      el.style.setProperty('--vis', '0');
      el.innerHTML = html;
      pinHost.appendChild(el);
      return el;
    };

    // Zones first — they carry the meaning; racks fill whatever budget is left.
    for (const z of zones) {
      if (pins.length >= MAX_PINS) break;
      if (!z) continue;
      const zx = num(z.x); const zy = num(z.y);
      if (zx == null || zy == null) continue;
      const label = ZONE_JP[z.type] || (typeof z.id === 'string' ? z.id : z.type || 'エリア');
      const col = safeColor(z.color, '');
      pins.push({
        el: mk(`${col ? `<i style="background:${esc(col)}"></i>` : '<i></i>'}${esc(label)}`, z.type || '', ''),
        wx: zx + (num(z.w) || 0) / 2, wy: 0.2, wz: zy + (num(z.h) || 0) / 2,
      });
    }
    const budget = Math.max(0, MAX_PINS - pins.length);
    blocks.sort((a, b) => b.n - a.n).slice(0, budget)
      .sort((a, b) => a.code.localeCompare(b.code))
      .forEach((b) => {
        pins.push({ el: mk(esc(b.code), 'storage', 'rack'), wx: b.x, wy: 1.9, wz: b.y });
      });
  }

  // Live camera if the integrator handed one over, else null.
  function camera() {
    const s3 = cur.scene3d;
    const cam = s3 && (s3.camera || (s3.getCamera && s3.getCamera()));
    return cam && cam.projectionMatrix && cam.matrixWorldInverse ? cam : null;
  }

  function canvasRect() {
    const s3 = cur.scene3d;
    let el = null;
    try { el = (s3 && s3.renderer && s3.renderer.domElement) || null; } catch (_) { el = null; }
    if (!el && hosts.stage3d) el = hosts.stage3d.querySelector('canvas') || hosts.stage3d;
    return el || stage;
  }

  // Screen-space de-clutter: zones are laid out first (they lead the array), so
  // a rack code that would sit on top of an already-placed chip simply hides.
  // Without this, 30 rack columns 2 m apart become an unreadable smear.
  function place(hits, host) {
    const kept = [];
    // The floating panels sit above the pins — a chip half-swallowed by a card
    // reads as a glitch, so treat the cards as occluders.
    const blocks = [];
    for (const ov of [ovL, ovR]) {
      if (!ov) continue;
      for (const card of ov.children) {
        const r = card.getBoundingClientRect();
        if (r.width > 0) blocks.push({ l: r.left - host.left, t: r.top - host.top, r: r.right - host.left, b: r.bottom - host.top });
      }
    }
    for (const p of pins) {
      const hit = hits.get(p);
      if (!hit) { p.el.style.setProperty('--vis', '0'); continue; }
      if (blocks.some((b) => hit.x > b.l - 8 && hit.x < b.r + 8 && hit.y > b.t - 8 && hit.y < b.b + 8)) {
        p.el.style.setProperty('--vis', '0'); continue;
      }
      if (!p.w) p.w = p.el.offsetWidth || (String(p.el.textContent || '').length * 9 + 18);
      let clash = false;
      for (const q of kept) {
        if (Math.abs(hit.x - q.x) < (p.w + q.w) * 0.5 + 4 && Math.abs(hit.y - q.y) < 19) { clash = true; break; }
      }
      if (clash) { p.el.style.setProperty('--vis', '0'); continue; }
      kept.push({ x: hit.x, y: hit.y, w: p.w });
      p.el.style.transform = `translate(-50%,-50%) translate(${hit.x.toFixed(1)}px,${hit.y.toFixed(1)}px)`;
      p.el.style.setProperty('--vis', '1');
    }
  }

  function projectPins(force) {
    if (!pins.length || !pinHost) return;
    if (stage.offsetParent === null && !force) return;   // panel hidden — don't burn frames
    const host = pinHost.getBoundingClientRect();
    if (host.width < 4 || host.height < 4) return;
    const cam = camera();

    if (cam) {
      const P = cam.projectionMatrix.elements; const V = cam.matrixWorldInverse.elements;
      const sig = `${P[0].toFixed(4)},${P[5].toFixed(4)},${V[12].toFixed(3)},${V[13].toFixed(3)},${V[14].toFixed(3)},${V[0].toFixed(4)},${V[6].toFixed(4)},${host.width | 0},${host.height | 0}`;
      if (sig === camSig && !force) return;
      camSig = sig;
      const cr = canvasRect().getBoundingClientRect();
      const w = cr.width || host.width; const h = cr.height || host.height;
      const ox = cr.left - host.left; const oy = cr.top - host.top;
      const hits = new Map();
      for (const p of pins) {
        const q = projectWithCamera(cam, p.wx, p.wy, p.wz);   // null ⇒ behind the eye
        if (!q) continue;
        if (q.ndcX < -1.08 || q.ndcX > 1.08 || q.ndcY < -1.08 || q.ndcY > 1.08) continue; // off-screen
        hits.set(p, { x: ox + (q.ndcX * 0.5 + 0.5) * w, y: oy + (-q.ndcY * 0.5 + 0.5) * h });
      }
      place(hits, host);
      return;
    }

    // Fallback: static top-down fit of meta.bounds onto the stage rect.
    camSig = '';
    const b = (cur.replay && cur.replay.meta && cur.replay.meta.bounds) || null;
    const bw = num(b && b.width) || 0; const bd = num(b && b.depth) || 0;
    if (bw <= 0 || bd <= 0) { for (const p of pins) p.el.style.setProperty('--vis', '0'); return; }
    const pad = 0.08;
    const availW = host.width * (1 - pad * 2); const availH = host.height * (1 - pad * 2);
    const k = Math.min(availW / bw, availH / bd);
    const ox = (host.width - bw * k) / 2; const oy = (host.height - bd * k) / 2;
    const hits = new Map();
    for (const p of pins) hits.set(p, { x: ox + p.wx * k, y: oy + p.wz * k });
    place(hits, host);
  }

  // ---------- empty state ----------------------------------------------------
  function renderEmpty() {
    if (ovL) ovL.innerHTML = '';
    if (ovR) ovR.innerHTML = '';
    els.toggle = null; els.status = null; toggleSig = ''; pinSig = ''; pins = [];
    if (pinHost) pinHost.innerHTML = '<div class="dst-quiet">シミュレーション未実行</div>';
    for (const c of [...stage.classList]) if (c.startsWith('dst-focus-')) stage.classList.remove(c);
  }

  // ---------- lifecycle ------------------------------------------------------
  function render() {
    const hasZones = !!(cur.replay && (Array.isArray(cur.replay.zones) ? cur.replay.zones.length : 0));
    if (!cur.replay || (!hasZones && !cur.kpis)) { renderEmpty(); return; }
    if (pinHost && pinHost.querySelector('.dst-quiet')) { pinHost.innerHTML = ''; pinSig = ''; }
    // The 3D scene can be handed over AFTER the first update — re-arm both the
    // bottleneck highlight and the projector when the instance changes.
    if (cur.scene3d !== lastScene) {
      lastScene = cur.scene3d;
      camSig = '';
      if (focus !== 'all') applyFocus(focus);
    }
    renderToggle(zoneTypes());
    renderStatus();
    renderEquipment();
    buildPins();
    projectPins(true);
  }

  // Own rAF loop: the PM's tick() fires once per data refresh, but pins must
  // follow the camera while the user orbits. Cheap — the camera fingerprint
  // short-circuits every frame in which nothing moved.
  function loop() {
    raf = requestAnimationFrame(loop);
    tickClock();
  }

  function tickClock() {
    try {
      projectPins(false);
      if (els.status && stage.offsetParent !== null) {
        const t = clockText();
        if (t !== lastClockTxt) {
          lastClockTxt = t;
          const c = els.status.querySelector('[data-clock]');
          if (c) c.textContent = t;
        }
        // The series is sampled every ~30 s but the clock TEXT only moves every
        // 0.1 h, so gating these on the clock froze 出荷数 for minutes at a time.
        const live = (sel, v) => {
          if (v == null) return;
          const el = els.status.querySelector(sel);
          if (!el || el.dataset.v === String(v)) return;
          el.dataset.v = String(v);
          el.innerHTML = `${fmt(v)}<span class="u">件</span>`;
        };
        live('[data-shipped]', seriesAt('done'));
        live('[data-wip]', seriesAt('wip'));
        const playing = !!(cur.getPlaying && cur.getPlaying());
        const pill = els.status.querySelector('[data-pill]');
        if (pill && pill.classList.contains('on') !== playing) {
          pill.className = 'dst-pill ' + (playing ? 'on' : 'off');
          pill.innerHTML = `<i></i>${playing ? '運用中' : '停止中'}`;
        }
      }
    } catch (_) { /* never let a frame throw */ }
  }

  try {
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => { camSig = ''; projectPins(true); });
      ro.observe(stage);
    }
  } catch (_) { ro = null; }

  render();
  raf = requestAnimationFrame(loop);

  return {
    update(next) {
      cur = next || cur || {};
      try { render(); } catch (_) { renderEmpty(); }
    },
    resize() { camSig = ''; projectPins(true); },
    tickClock,
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (ro) { try { ro.disconnect(); } catch (_) { /* noop */ } ro = null; }
      if (ovL) ovL.innerHTML = '';
      if (ovR) ovR.innerHTML = '';
      if (pinHost) pinHost.innerHTML = '';
      pins = [];
      for (const c of [...stage.classList]) if (c.startsWith('dst-focus-')) stage.classList.remove(c);
      stage.classList.remove('dst-nomo');
    },
  };
}
