// render2d.js — the 2D replay canvas renderer + shared playback clock for the
// whsim frontend shell.
//
// This is the 2D-specific half of the SPA's replay views: the <canvas#canvas2d>
// draw pipeline (layout → congestion heatmap → racks/shelves → agents → live HUD
// → legend) plus the shared rAF `loop` that advances the global playhead `S.t`
// for BOTH the 2D and 3D views (view3d reads `S.t`). It was lifted verbatim out
// of app.js; behaviour, DOM writes, and the per-frame hot path are unchanged.
//
// It reads the shared SPA state (`S`), the frontend helper `$`, and the label/
// colour constant maps; it never mutates project/run state beyond the playback
// fields it already owned in app.js (`S.t`, `S._needs2d`). The shell still owns
// view switching, so app.js calls `draw2d()` / `fitCanvas()` / `refreshPalette()`
// / `loop()` and imports `JP_TO_TYPE` for the 3D bottleneck spotlight.
import { $ } from './util.js';
import { S } from './state.js';
import {
  ZONE_JP, EQUIP_JP, ABC_COLOR, STATE_COLOR, RACK_COLOR, AGV_COLOR,
} from './constants.js';

const DOOR_COLOR = { dock: '#1f78b4', personnel: '#33a02c', shutter: '#8d99ae' };
// Full circle in radians — replaces the `arc(...,0,7)` magic number in 2D draws.
const TAU = Math.PI * 2;

// ---- theme-aware canvas palette --------------------------------------------
// Resolved from CSS custom properties at draw time (cached, refreshed on the
// `themechange` event). Fallbacks equal the previous hardcoded values so LIGHT
// mode is pixel-identical; the dark variants live in styles.css.
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
let PALETTE = null;
export function refreshPalette() {
  PALETTE = {
    shell:        cssVar('--canvas-shell', '#333'),
    zoneInk:      cssVar('--canvas-zone-ink', '#8a93a0'),
    inkFaint:     cssVar('--canvas-ink-faint', '#9aa4b0'),
    wall:         cssVar('--canvas-wall-rep', '#6b7785'),
    equip:        cssVar('--canvas-equip', '#444'),
    equipInk:     cssVar('--canvas-equip-ink', '#555'),
    markerStroke: cssVar('--canvas-marker-stroke', '#fff'),
    agentStroke:  cssVar('--canvas-agent-stroke', '#000'),
    conveyor:     cssVar('--canvas-conveyor-rep', '#8d99ae'),
    // Brand cyan accent (theme-aware) for HUD/legend/playhead/routes.
    accent:       cssVar('--accent', '#34e3ff'),
    // Floating-card panel (HUD/legend) fill + secondary ink, theme-aware. The
    // fallback is a touch lighter than the old flat 0b1320 so it lifts off the
    // Void bg as a card; the accent border (added at draw time) completes it.
    panelBg:      cssVar('--canvas-panel-bg', 'rgba(20,30,46,0.78)'),
    panelInk:     cssVar('--canvas-panel-ink', '#9fb4c8'),
    // Pick-station marker fill.
    station:      cssVar('--canvas-station', '#08519c'),
  };
  return PALETTE;
}
// Bottleneck-stage label → zone type. Inverts ZONE_JP (so any zone type can
// match) plus synonyms not in ZONE_JP. Hoisted to module scope so drawBottleneck
// allocates nothing on the per-frame hot path.
export const JP_TO_TYPE = Object.assign(
  Object.fromEntries(Object.entries(ZONE_JP).map(([type, jp]) => [jp, type])),
  { '検品': 'inspection', '格納': 'storage' });

// ---- keyframe interpolation (must match the 3D view) -----------------------
function interp(keyframes, t) {
  if (!keyframes || !keyframes.length) return [0, 0, 'idle'];
  if (t <= keyframes[0][0]) return [keyframes[0][1], keyframes[0][2], 'idle'];
  const last = keyframes[keyframes.length - 1];
  if (t >= last[0]) return [last[1], last[2], last[3]];
  let lo = 0, hi = keyframes.length - 1;
  while (lo + 1 < hi) { const m = (lo + hi) >> 1; (keyframes[m][0] <= t ? lo = m : hi = m); }
  const k0 = keyframes[lo], k1 = keyframes[lo + 1];
  const f = Math.min(Math.max((t - k0[0]) / Math.max(k1[0] - k0[0], 1e-9), 0), 1);
  return [k0[1] + (k1[1] - k0[1]) * f, k0[2] + (k1[2] - k0[2]) * f, k0[3]];
}

// Read the upper-段 (level) meta off the keyframe segment the playhead `t` sits
// in. A `pick` keyframe at a level above the ground carries a 5th element:
//   { lv:int(1=ground), by:"manual"|"forklift"|"crane", h:pick-face metres, ... }
// Level-1 picks are 4-tuples (no meta). Returns the meta object ONLY while the
// active segment is a pick AND lv>1; otherwise null, so ground picks draw
// nothing new. Mirrors interp's segment search (binary, allocation-free on the
// hot path) and honours a tail-keyframe pick (matching interp's last-state hold).
function pickMeta(keyframes, t) {
  if (!keyframes || !keyframes.length) return null;
  let kf;
  const last = keyframes[keyframes.length - 1];
  if (t >= last[0]) kf = last;
  else if (t <= keyframes[0][0]) return null;   // pre-roll is idle in interp()
  else {
    let lo = 0, hi = keyframes.length - 1;
    while (lo + 1 < hi) { const m = (lo + hi) >> 1; (keyframes[m][0] <= t ? lo = m : hi = m); }
    kf = keyframes[lo];
  }
  if (kf[3] !== 'pick' || kf.length < 5) return null;
  const meta = kf[4];
  return (meta && meta.lv > 1) ? meta : null;
}

// Upper-段 pick cue colours, keyed by how the reach is performed (`meta.by`).
// 2D is top-down and can't show real height, so these read as "going up": amber
// for an unaided 手作業 reach, orange/red for a フォークリフト lift, cyan for a
// クレーン/自動倉庫. Unknown movers fall back to amber.
const LEVEL_BY_COLOR = { manual: '#f5b05a', forklift: '#ff5a78', crane: '#34e3ff' };

// ---- 2D canvas -------------------------------------------------------------
const canvas = $('canvas2d');
const ctx = canvas.getContext('2d');
export function fitCanvas() {
  const r = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Cache the CSS pixel size so draw2d/drawLiveHUD don't trigger a layout read
  // (clientWidth/clientHeight) on the per-frame hot path.
  canvas._cssW = r.width; canvas._cssH = r.height;
  S._needs2d = true;  // size changed → one repaint even while paused
}
export function draw2d() {
  const rep = S.replay;
  const P = PALETTE || refreshPalette();
  // Use the cached CSS size (set by fitCanvas) to avoid a layout read each frame.
  const w = canvas._cssW || canvas.clientWidth, h = canvas._cssH || canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!rep) {
    drawEmptyState(w, h, P);
    return;
  }
  const b = rep.meta.bounds, pad = 16;
  const sc = Math.min((w - 2 * pad) / b.width, (h - 2 * pad) / b.depth);
  const ox = (w - b.width * sc) / 2, oy = (h - b.depth * sc) / 2;
  const X = (x) => ox + x * sc, Y = (y) => h - oy - y * sc; // flip y

  ctx.strokeStyle = P.shell; ctx.lineWidth = 1.5;
  ctx.strokeRect(X(0), Y(b.depth), b.width * sc, b.depth * sc);
  // Congestion heatmap: translucent floor density underlay (calm cyan → hot red),
  // drawn beneath zones/racks/agents so the live agents read on top. Presence-
  // guarded so legacy replays are unaffected; cells are sparse + normalised in
  // render/replay.py (_congestion_grid). A computed ramp like the staging HSL.
  const cong = rep.congestion;
  if (cong && cong.cells && cong.cells.length) {
    const gm = cong.grid_m || 1, cw = gm * sc;
    for (const [gx, gy, d] of cong.cells) {
      if (!(d > 0)) continue;
      ctx.fillStyle = `hsla(${(190 * (1 - d)).toFixed(0)},85%,55%,${(0.12 + 0.32 * d).toFixed(3)})`;
      ctx.fillRect(X(gx * gm), Y((gy + 1) * gm), cw, cw);
    }
  }
  for (const z of rep.zones) {
    // V3 viewport: zones read as outlined figures (faint fill + crisp outline)
    // rather than flat colour fills. Same colour token, just lighter weight.
    ctx.fillStyle = hexA(z.color || '#eeeeee', 0.12);
    ctx.fillRect(X(z.x), Y(z.y + z.h), z.w * sc, z.h * sc);
    ctx.strokeStyle = hexA(z.color || '#8a93a0', 0.55); ctx.lineWidth = 1;
    ctx.strokeRect(X(z.x), Y(z.y + z.h), z.w * sc, z.h * sc);
    ctx.fillStyle = P.zoneInk; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(ZONE_JP[z.type] || z.type, X(z.x + z.w / 2), Y(z.y + z.h / 2));
  }
  // MapMaker-style waypoint navigation network (Delaunay over aisle waypoints):
  // faint edges + nodes, drawn under the racks/agents as a routing underlay.
  if (rep.navnet && rep.navnet.waypoints && rep.navnet.waypoints.length) {
    const wp = rep.navnet.waypoints;
    ctx.strokeStyle = hexA(P.accent, 0.20); ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const [i, j] of (rep.navnet.edges || [])) {
      const a = wp[i], b = wp[j];
      if (!a || !b) continue;
      ctx.moveTo(X(a[0]), Y(a[1])); ctx.lineTo(X(b[0]), Y(b[1]));
    }
    ctx.stroke();
    ctx.fillStyle = hexA(P.accent, 0.45);
    for (const p of wp) { ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 1.8, 0, TAU); ctx.fill(); }
  }
  // Storage as MapMaker-style shelf runs (rack blocks + ABC bays); older replays
  // without `shelves` fall back to the legacy per-location dots.
  if (rep.shelves && rep.shelves.length) {
    for (const sh of rep.shelves) {
      const d = sh.depth, w = d * sc;
      const x0 = X(sh.x - d / 2), yTop = Y(sh.y1), h = (sh.y1 - sh.y0) * sc;
      const rc = RACK_COLOR[sh.rack_type] || '#8aa0b8';
      ctx.fillStyle = hexA(rc, 0.18);
      ctx.fillRect(x0, yTop, w, h);
      ctx.strokeStyle = hexA(rc, 0.5); ctx.lineWidth = 0.7;
      ctx.strokeRect(x0, yTop, w, h);
      const pitch = sh.pitch || 1;
      for (const c of sh.cells) {
        ctx.fillStyle = ABC_COLOR[c.abc] || '#ccc';
        ctx.fillRect(x0, Y(c.y + pitch * 0.4), w, pitch * 0.8 * sc);
      }
    }
    ctx.lineWidth = 1;
  } else {
    for (const r of rep.racks) {
      ctx.fillStyle = ABC_COLOR[r.abc] || '#ccc';
      ctx.fillRect(X(r.x) - 2, Y(r.y) - 2, 4, 4);
    }
  }
  for (const s of rep.stations) {
    ctx.fillStyle = P.station; ctx.beginPath();
    ctx.arc(X(s.x), Y(s.y), 7, 0, TAU); ctx.fill();
  }
  // building shell: walls + doors (躯体)
  for (const wl of (rep.walls || [])) {
    if (!wl.points || wl.points.length < 2) continue;
    ctx.strokeStyle = P.wall; ctx.lineWidth = Math.max(2, (wl.thickness || 0.2) * sc);
    ctx.lineCap = 'round'; ctx.beginPath();
    wl.points.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])));
    ctx.stroke(); ctx.lineWidth = 1;
  }
  for (const dr of (rep.doors || [])) {
    ctx.fillStyle = DOOR_COLOR[dr.type] || '#1f78b4';
    ctx.fillRect(X(dr.x) - (dr.w * sc) / 2, Y(dr.y) - 3, dr.w * sc, 6);
  }
  // placed equipment (static markers, labelled)
  for (const eq of (rep.equipment || [])) {
    ctx.fillStyle = P.equip; ctx.strokeStyle = P.markerStroke; ctx.lineWidth = 1;
    ctx.fillRect(X(eq.x) - 7, Y(eq.y) - 7, 14, 14);
    ctx.strokeRect(X(eq.x) - 7, Y(eq.y) - 7, 14, 14);
    ctx.fillStyle = P.equipInk; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(EQUIP_JP[eq.type] || eq.type, X(eq.x), Y(eq.y) - 10);
  }
  // conveyors (static)
  for (const cv of (rep.conveyors || [])) {
    if (!cv.points || cv.points.length < 2) continue;
    ctx.strokeStyle = P.conveyor; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath();
    cv.points.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])));
    ctx.stroke(); ctx.lineWidth = 1;
  }
  // manual flow-line routes (動線)
  for (const rt of (rep.routes || [])) {
    if (!rt.points || rt.points.length < 2) continue;
    ctx.strokeStyle = rt.mover === 'forklift' ? '#f57f17' : P.accent;
    ctx.lineWidth = 3; ctx.setLineDash([6, 4]); ctx.beginPath();
    rt.points.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])));
    ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
  }
  // forklifts (moving ▲ — matches the legend glyph & 3D view)
  for (const fk of (rep.forklifts || [])) {
    const [x, y, st] = interp(fk.keyframes, S.t);
    ctx.fillStyle = st === 'putaway' ? '#e65100' : '#ffb74d';
    ctx.strokeStyle = P.agentStroke; ctx.lineWidth = 0.7;
    agentGlyph(X(x), Y(y), 'forklift', 7);
  }
  // AGVs (moving ◆ — matches the legend glyph, distinct from round workers)
  for (const ag of (rep.agvs || [])) {
    const [x, y, st] = interp(ag.keyframes, S.t);
    ctx.fillStyle = AGV_COLOR[st] || '#1f78b4';
    ctx.strokeStyle = P.agentStroke; ctx.lineWidth = 0.7;
    agentGlyph(X(x), Y(y), 'agv', 6);
  }
  // 仮置き(staging) buffer: WIP heat rectangle + live 滞留数 (staged mode only).
  const sg = rep.staging;
  if (sg) {
    const tl = sg.timeline || [];
    let wip = 0;
    for (let i = 0; i < tl.length; i++) { if (tl[i][0] <= S.t) wip = tl[i][1]; else break; }
    const util = Math.min(1, wip / Math.max(sg.capacity, 1));
    // Match the staging RING ramp (cyan→amber→red by threshold) so the rectangle
    // and the fill-ring read as one branded object, not two heat scales.
    const heat = stagingColor(util);
    ctx.fillStyle = hexA(heat, 0.22 + util * 0.5);
    ctx.fillRect(X(sg.x), Y(sg.y + sg.h), sg.w * sc, sg.h * sc);
    ctx.strokeStyle = heat; ctx.lineWidth = 1.2;
    ctx.strokeRect(X(sg.x), Y(sg.y + sg.h), sg.w * sc, sg.h * sc);
    ctx.fillStyle = util > 0.55 ? P.markerStroke : P.panelInk;
    // Mono face for the numeric readout (matches the HUD/legend numerics).
    ctx.font = '600 11px "Space Mono", ui-monospace, monospace'; ctx.textAlign = 'center';
    ctx.fillText(`仮置 ${wip}/${sg.capacity}`, X(sg.x + sg.w / 2), Y(sg.y + sg.h / 2));
  }
  // workers — role decides the glyph (●picker ▲forklift ■packer/inspector),
  // state still tints the fill. Falls back to the legacy round dot for any
  // unknown role, so older replays render identically.
  for (const wk of rep.workers) {
    const [x, y, st] = interp(wk.keyframes, S.t);
    const px = X(x), py = Y(y);
    ctx.fillStyle = STATE_COLOR[st] || '#999';
    ctx.strokeStyle = P.agentStroke; ctx.lineWidth = 0.7;
    agentGlyph(px, py, wk.role, 6);
    // Upper-段 reach cue: when this picker's current keyframe is a pick at a
    // level above the ground, the 2D (top-down) view can't show the height, so
    // we drop a small "going up" badge + lift gauge beside the agent. Null on a
    // ground pick / non-pick → nothing drawn (unchanged for those frames).
    const lm = (st === 'pick') ? pickMeta(wk.keyframes, S.t) : null;
    if (lm) drawLevelCue(px, py, lm, rep);
  }
  // V3 viewport extras (additive; each guarded so absent data = legacy render):
  // staging fill-ring + bottleneck ⚠ marker + bottom-left legend.
  if (sg) drawStagingRing(X(sg.x + sg.w / 2), Y(sg.y + sg.h / 2), sg);
  drawBottleneck(rep, X, Y);
  drawLegend(rep, w, h, P);
  drawLiveHUD(ctx, rep, S.t);
}

// 再生ヘッド同期のライブ生産性HUD: a small playhead-synced line chart of
// throughput (rate, 件/h) over time, plus live cumulative 完了 and 仮置き WIP.
// Drawn only when the replay carries `rep.series` ([{t, done, rate, wip}]);
// absent => nothing drawn (full backward compatibility). Read-only: it reads
// the replay + the current playhead `t` and never mutates any state. Restores
// every ctx property it touches so the rest of draw2d is unaffected.
function drawLiveHUD(ctx, rep, t) {
  const series = rep && rep.series;
  if (!Array.isArray(series) || series.length < 2) return;
  const P = PALETTE || refreshPalette();

  // Geometry: small panel pinned top-right of the canvas. Use the cached CSS
  // size (set by fitCanvas) to avoid a layout read on the per-frame hot path.
  const cw = canvas._cssW || canvas.clientWidth;
  const pad = 10, W = Math.min(220, cw - 2 * pad), H = 84;
  const x0 = cw - W - pad, y0 = pad;
  // Plot rect inside the panel (room for header text on top).
  const plX = x0 + 10, plY = y0 + 28, plW = W - 20, plH = H - 38;

  // Domains. Prefer the replay SERIES' own time span for x so the playhead and
  // the productivity line can never desync; fall back to the playback window.
  const tMax = (series[series.length - 1].t > 0)
    ? series[series.length - 1].t
    : ((typeof S.window === 'number' && S.window > 0) ? S.window : 1);
  let rMax = 0;
  for (const p of series) { const r = +p.rate || 0; if (r > rMax) rMax = r; }
  if (rMax <= 0) rMax = 1;

  const PX = (tt) => plX + (Math.max(0, Math.min(tt, tMax)) / tMax) * plW;
  const PY = (rr) => plY + plH - (Math.max(0, Math.min(rr, rMax)) / rMax) * plH;

  // Live values at the current playhead (step-hold like the staging timeline).
  let cur = series[0];
  for (let i = 0; i < series.length; i++) { if (series[i].t <= t) cur = series[i]; else break; }
  const curRate = Math.round(+cur.rate || 0);
  const curDone = Math.round(+cur.done || 0);
  const curWip = Math.round(+cur.wip || 0);

  const reduce = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cyan = P.accent;
  const a0 = ctx.globalAlpha;
  ctx.save();

  // Translucent panel — reads as a floating card on the Void bg: a slightly
  // lighter fill + a faint accent low-alpha border for dark-mode contrast.
  ctx.globalAlpha = 1;
  ctx.fillStyle = P.panelBg;
  ctx.strokeStyle = hexA(P.accent, 0.22); ctx.lineWidth = 1;
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x0, y0, W, H, 6); ctx.fill(); ctx.stroke(); }
  else { ctx.fillRect(x0, y0, W, H); ctx.strokeRect(x0, y0, W, H); }

  // Header: live throughput readout in a Space Mono-ish monospace face.
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.font = '600 13px "Space Mono", ui-monospace, monospace';
  ctx.fillStyle = cyan;
  ctx.fillText(`${curRate} 件/h`, x0 + 10, y0 + 18);
  // Cumulative done + staging WIP, smaller, with semantic colours.
  ctx.font = '10px "Space Mono", ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.fillStyle = P.panelInk;
  const wipCol = curWip > 0 ? '#f5b05a' : P.panelInk;
  ctx.fillText(`完了 ${curDone}`, x0 + W - 56, y0 + 18);
  ctx.fillStyle = wipCol;
  ctx.fillText(`仮置 ${curWip}`, x0 + W - 10, y0 + 18);

  // Baseline of the plot.
  ctx.strokeStyle = hexA(P.panelInk, 0.20); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(plX, plY + plH); ctx.lineTo(plX + plW, plY + plH); ctx.stroke();

  // Future portion (t >= playhead): faint line.
  ctx.lineWidth = 1.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = cyan; ctx.globalAlpha = 0.22;
  ctx.beginPath();
  series.forEach((p, i) => { const xx = PX(p.t), yy = PY(p.rate);
    i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
  ctx.stroke();

  // Past portion (t <= playhead): solid line, clipped to the playhead x.
  const phX = PX(t);
  ctx.save();
  ctx.beginPath(); ctx.rect(plX, plY, Math.max(0, phX - plX), plH); ctx.clip();
  ctx.globalAlpha = 1; ctx.strokeStyle = cyan; ctx.lineWidth = 1.6;
  ctx.beginPath();
  series.forEach((p, i) => { const xx = PX(p.t), yy = PY(p.rate);
    i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
  ctx.stroke();
  ctx.restore();

  // Playhead vertical line + current-value dot.
  ctx.globalAlpha = 1; ctx.strokeStyle = reduce ? hexA(P.accent, 0.6) : cyan;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(phX, plY); ctx.lineTo(phX, plY + plH); ctx.stroke();
  ctx.fillStyle = cyan;
  ctx.beginPath(); ctx.arc(phX, PY(cur.rate), 2.6, 0, TAU); ctx.fill();

  ctx.restore();
  ctx.globalAlpha = a0; ctx.lineWidth = 1; ctx.lineCap = 'butt';
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}

// Role → symbol (Mini-Metro style). Shapes match the V3 mock & 3D view:
// ● picker, ◆ AGV, ▲ forklift, ■ packer / inspector. Fill/stroke are set by
// the caller (state colour). Unknown roles fall back to the round dot.
function agentGlyph(cx, cy, role, r) {
  ctx.beginPath();
  if (role === 'forklift') {                       // ▲
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r * 0.9, cy + r * 0.75);
    ctx.lineTo(cx - r * 0.9, cy + r * 0.75); ctx.closePath();
  } else if (role === 'agv') {                      // ◆
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
  } else if (role === 'packer' || role === 'inspector') { // ■
    ctx.rect(cx - r * 0.85, cy - r * 0.85, r * 1.7, r * 1.7);
  } else {                                          // ● picker / fallback
    ctx.arc(cx, cy, r, 0, TAU);
  }
  ctx.fill(); ctx.stroke();
}

// Per-replay max 段, cached on the rep object (lazy, computed once) so the lift
// gauge can scale by lv/maxLevel when a pick-face height isn't a useful bound.
// Cheap: scans pick keyframes only on the first cue of a run, then memoised.
function replayMaxLevel(rep) {
  if (rep._maxLv != null) return rep._maxLv;
  let mx = 1;
  for (const wk of (rep.workers || [])) {
    for (const kf of (wk.keyframes || [])) {
      if (kf.length >= 5 && kf[3] === 'pick' && kf[4] && kf[4].lv > mx) mx = kf[4].lv;
    }
  }
  rep._maxLv = mx;
  return mx;
}

// Upper-段 pick cue: drawn beside a picker (cx,cy) only while it is reaching an
// upper level. Two parts, kept small + unobtrusive so ground picks (which draw
// nothing) stay the visual baseline:
//   1) a vertical "lift gauge" — a short track with a fill that rises UPWARD in
//      proportion to the pick-face height `h` (clamped), or to lv/maxLevel when
//      `h` is absent, so it literally reads as "reaching up";
//   2) a "段{lv}" badge, colour-coded by `meta.by` (手作業=amber / フォーク=red /
//      クレーン=cyan), pinned just above the agent.
// A subtle pulse (only while playing) animates the fill so the reach feels live.
function drawLevelCue(cx, cy, meta, rep) {
  const col = LEVEL_BY_COLOR[meta.by] || LEVEL_BY_COLOR.manual;
  // Fill fraction: prefer real height (≈6 m caps a high pallet rack), else level
  // ratio. Floor at 0.18 so even 段2 reads as a clearly raised bar.
  let frac = (typeof meta.h === 'number' && meta.h > 0)
    ? meta.h / 6
    : (meta.lv - 1) / Math.max(replayMaxLevel(rep) - 1, 1);
  frac = Math.max(0.18, Math.min(1, frac));
  // Gentle "rising" pulse while actively playing (a reach in progress); static
  // when paused. Cheap sine; restores everything it touches.
  const pulse = S.playing ? 0.8 + 0.2 * (0.5 + 0.5 * Math.sin(performance.now() / 240)) : 1;

  const a0 = ctx.globalAlpha;
  const gx = cx + 10, gBot = cy + 7, gTop = cy - 9, gH = gBot - gTop, gW = 3.2;
  ctx.save();
  // Gauge track (faint) + upward fill (level colour).
  ctx.globalAlpha = a0 * 0.45;
  ctx.fillStyle = '#000';
  ctx.fillRect(gx - 0.6, gTop - 0.6, gW + 1.2, gH + 1.2);   // thin contrast backing
  ctx.globalAlpha = a0 * 0.30;
  ctx.fillStyle = col;
  ctx.fillRect(gx, gTop, gW, gH);                            // empty track
  const fillH = gH * frac * pulse;
  ctx.globalAlpha = a0;
  ctx.fillStyle = col;
  ctx.fillRect(gx, gBot - fillH, gW, fillH);                // fill rises from the floor
  // Tiny up-arrow cap so the direction reads even at a glance.
  ctx.beginPath();
  ctx.moveTo(gx + gW / 2, gTop - 3.4);
  ctx.lineTo(gx + gW + 0.4, gTop + 0.6);
  ctx.lineTo(gx - 0.4, gTop + 0.6);
  ctx.closePath(); ctx.fill();

  // "段{lv}" badge above the agent — pill backing + level-colour text.
  const label = `段${meta.lv}`;
  ctx.font = '700 9px "Space Mono", ui-monospace, monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width;
  const bx = cx + 7, by = cy - 16, bw = tw + 8, bh = 12;
  ctx.globalAlpha = a0 * 0.82;
  ctx.fillStyle = 'rgba(8,12,20,0.85)';
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by - bh / 2, bw, bh, 3); ctx.fill(); }
  else ctx.fillRect(bx, by - bh / 2, bw, bh);
  ctx.globalAlpha = a0;
  ctx.strokeStyle = col; ctx.lineWidth = 0.8;
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by - bh / 2, bw, bh, 3); ctx.stroke(); }
  else ctx.strokeRect(bx, by - bh / 2, bw, bh);
  ctx.fillStyle = col;
  ctx.fillText(label, bx + 4, by + 0.5);

  ctx.restore();
  ctx.globalAlpha = a0; ctx.lineWidth = 1;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}

// 仮置きバッファ充満リング (Mini Metro): a perimeter arc over the staging box
// centre showing live WIP / capacity, cyan→amber→red by threshold. Additive to
// the existing staging heat rectangle; only called when rep.staging exists.
function drawStagingRing(cx, cy, sg) {
  const tl = sg.timeline || [];
  let wip = 0;
  for (let i = 0; i < tl.length; i++) { if (tl[i][0] <= S.t) wip = tl[i][1]; else break; }
  const frac = Math.min(1, wip / Math.max(sg.capacity, 1));
  const col = stagingColor(frac);  // shared ramp → ring & rectangle read as one
  const R = 13;
  // Gentle pulse when nearly full (≥85%) and actively playing — a Mini-Metro
  // "overcrowding" cue. Restores globalAlpha so nothing downstream is affected.
  const pulse = (frac >= 0.85 && S.playing)
    ? 0.65 + 0.35 * (0.5 + 0.5 * Math.sin(performance.now() / 280))
    : 1;
  const a0 = ctx.globalAlpha;
  const P = PALETTE || refreshPalette();
  ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.strokeStyle = hexA(P.panelInk, 0.20);
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
  ctx.globalAlpha = a0 * pulse;
  ctx.strokeStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + frac * TAU); ctx.stroke();
  ctx.globalAlpha = a0;
  ctx.lineWidth = 1; ctx.lineCap = 'butt';
}

// Resolve where the bottleneck lives in WORLD coords: prefer an explicit
// process zone of the bottleneck type; else fall back to the congestion hotspot
// (value-weighted centre of the busiest cells) — many layouts have no dedicated
// 'picking' zone (it happens across the storage racks), so the zone lookup alone
// silently drew nothing. Returns {wx, wy} or null. Shared spine with the 3D
// Scene3D._resolveBottleneckAnchor so PNG / 2D / 3D point at the same spot.
function resolveBottleneckXY(rep) {
  const k = rep.kpis;
  if (!k || !k.bottleneck_jp) return null;
  const stage = JP_TO_TYPE[k.bottleneck_jp] || null;
  const z = stage ? (rep.zones || []).find(zz => zz.type === stage) : null;
  if (z) return { wx: z.x + z.w / 2, wy: z.y + z.h / 2 };
  const c = rep.congestion;
  if (c && Array.isArray(c.cells) && c.cells.length && c.grid_m > 0) {
    let max = 0;
    for (const cell of c.cells) { if (cell[2] > max) max = cell[2]; }
    if (max <= 0) return null;
    const thr = max * 0.6;
    let sx = 0, sy = 0, sw = 0;
    for (const [ix, iy, v] of c.cells) {
      if (v < thr) continue;
      sx += (ix + 0.5) * c.grid_m * v; sy += (iy + 0.5) * c.grid_m * v; sw += v;
    }
    if (sw > 0) return { wx: sx / sw, wy: sy / sw };
  }
  return null;
}

// Bottleneck ⚠ overlay: drop a warning marker on the bottleneck's floor anchor
// (matching zone, else the congestion hotspot). No KPIs / no anchor => nothing
// drawn (full backward compatibility).
function drawBottleneck(rep, X, Y) {
  const a = resolveBottleneckXY(rep);
  if (!a) return;
  const cx = X(a.wx), cy = Y(a.wy);
  ctx.fillStyle = 'rgba(245,176,90,0.12)';
  ctx.strokeStyle = '#f5b05a'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(cx, cy - 16, 11, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f5b05a'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚠', cx, cy - 15);
  ctx.textBaseline = 'alphabetic'; ctx.lineWidth = 1;
}

// Small bottom-left legend (role glyphs). Drawn only when the replay actually
// carries moving agents, so an empty layout stays clean.
function drawLegend(rep, w, h, P) {
  const items = [];
  if ((rep.workers || []).some(o => o.role === 'picker' || !o.role)) items.push(['picker', 'ピッカー']);
  if ((rep.agvs || []).length || (rep.workers || []).some(o => o.role === 'agv')) items.push(['agv', 'AGV']);
  if ((rep.forklifts || []).length || (rep.workers || []).some(o => o.role === 'forklift')) items.push(['forklift', 'フォーク']);
  if ((rep.workers || []).some(o => o.role === 'packer' || o.role === 'inspector')) items.push(['packer', '検品/梱包']);
  if (!items.length) return;
  const pad = 10, lh = 16, bw = 96, bh = items.length * lh + 10;
  const x0 = pad, y0 = h - bh - pad;
  // Floating card on the Void bg: panel fill + faint accent low-alpha border
  // (matches the HUD card so the two overlays read as one brand surface).
  ctx.fillStyle = P.panelBg; ctx.strokeStyle = hexA(P.accent, 0.22);
  ctx.lineWidth = 1;
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x0, y0, bw, bh, 6); ctx.fill(); ctx.stroke(); }
  else { ctx.fillRect(x0, y0, bw, bh); ctx.strokeRect(x0, y0, bw, bh); }
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = '10px sans-serif';
  items.forEach(([role, label], i) => {
    const gy = y0 + 9 + i * lh;
    ctx.fillStyle = P.accent; ctx.strokeStyle = P.agentStroke; ctx.lineWidth = 0.6;
    agentGlyph(x0 + 12, gy, role, 4);
    ctx.fillStyle = P.zoneInk || '#8a93a0';
    ctx.fillText(label, x0 + 24, gy);
  });
  ctx.textBaseline = 'alphabetic'; ctx.lineWidth = 1;
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
// Shared staging heat ramp (cyan→amber→red by threshold). Used by BOTH the
// staging RECTANGLE and the fill-RING so they read as one branded object. The
// cyan end is the theme-aware brand accent; amber/red are semantic ramp stops.
function stagingColor(frac) {
  const P = PALETTE || refreshPalette();
  return frac < 0.60 ? P.accent : frac < 0.85 ? '#f5b05a' : '#ff5a78';
}
// Empty / no-replay placeholder: a cheap, designed state instead of a single
// gray line — a faint dashed building outline + an accent-muted message,
// centred. Drawn once (works with the dirty-flag; no animation here).
function drawEmptyState(w, h, P) {
  const pad = Math.min(w, h) * 0.16;
  const bx = pad, by = pad, bw = w - 2 * pad, bh = h - 2 * pad;
  ctx.save();
  // Faint dashed building outline (the "shell" we're waiting to fill).
  ctx.strokeStyle = hexA(P.accent, 0.22); ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 6]);
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 10); ctx.stroke(); }
  else { ctx.strokeRect(bx, by, bw, bh); }
  ctx.setLineDash([]);
  // Accent-muted message.
  ctx.fillStyle = hexA(P.accent, 0.55);
  ctx.font = '600 14px "Space Mono", ui-monospace, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('実行するとここに2Dリプレイが表示されます', w / 2, h / 2);
  ctx.restore();
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.lineWidth = 1;
}

// ---- shared clock / render loop -------------------------------------------
// The shared loop advances the global playhead (S.t) and the transport readout
// for BOTH the 2D and 3D replay views (view3d reads S.t), so it always runs.
// draw2d is the only 2D-specific cost and is gated on the active view. We skip
// redundant DOM writes on the scrub/clock when their displayed value is
// unchanged — form-control + textContent churn was a measurable per-frame cost.
let lastTs = performance.now();
let _lastScrub = -1, _lastClock = '';
export function loop(ts) {
  // Clamp dt so a GC pause / tab-throttle hitch can't snap all agents forward
  // (anti-teleport): a single hitched frame advances at most 0.1s of wall-time.
  const dt = Math.min((ts - lastTs) / 1000, 0.1); lastTs = ts;
  if (S.playing && S.replay) {
    S.t += dt * S.speed;
    if (S.t > S.window) S.t = 0;
    const sv = Math.round((S.t / S.window) * 1000);
    if (sv !== _lastScrub) { $('scrub').value = String(sv); _lastScrub = sv; }
    const cv = (S.t / 60).toFixed(1) + ' 分';
    if (cv !== _lastClock) { $('clock').textContent = cv; _lastClock = cv; }
  }
  // Dirty-flag redraw: while playing the frame genuinely changes every tick, but
  // when paused an identical frame is wasteful — only redraw on an explicit
  // one-shot request (S._needs2d), set wherever a static repaint is needed.
  if (S.view === 'view2d' && (S.playing || S._needs2d)) {
    draw2d();
    S._needs2d = false;
  }
  requestAnimationFrame(loop);
}
