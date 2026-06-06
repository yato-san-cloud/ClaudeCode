// whsim frontend: design -> import -> confirm headline -> run -> animated replay.
import { Scene3D } from './js/view3d.js';
import { Designer } from './js/designer.js';
import { CompareView } from './js/compare.js';
import { ExportView } from './js/export.js';
import { mountAnalysis } from './js/analysis.js';
import { mountCody, codyAvatarSVG } from './js/cody.js';
import { mountChat } from './js/chat.js';
import { mountSettings } from './js/settings.js';
import { mountOnboarding } from './js/onboarding.js';
import { mountJourney } from './js/journey.js';
import { mountOverview } from './js/overview.js';
import { mountBI } from './js/bi.js';
import { mountBIAnalytics } from './js/bianalytics.js';
import { mountPhaseHint } from './js/phasehint.js';
import { mountTimetable } from './js/timetable.js';
import { mountDataAnalysis } from './js/dataanalysis.js';
import { mountMaterialFlow } from './js/materialflow.js';
import { mountNotes } from './js/notes.js';

const EQUIP_JP = { agv: 'AGV', forklift: 'フォークリフト', asrs: '自動倉庫',
                   robot_arm: 'ロボットアーム', crane: 'クレーン' };
const DOOR_COLOR = { dock: '#1f78b4', personnel: '#33a02c', shutter: '#8d99ae' };

const $ = (id) => document.getElementById(id);
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
};

// ---- toast notifications (small, accessible, Japanese) ---------------------
function toast(message, kind = 'info', ms = 4200) {
  const host = $('toastHost');
  if (!host) return;
  const t = document.createElement('div');
  t.className = 'toast ' + (kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : 'info');
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const body = document.createElement('span');
  body.className = 'toast-msg';
  body.textContent = String(message == null ? '' : message);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', '閉じる');
  close.textContent = '×';
  const dismiss = () => {
    if (!t.parentNode) return;
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 200);
  };
  close.onclick = dismiss;
  t.appendChild(body);
  t.appendChild(close);
  host.appendChild(t);
  if (ms > 0) setTimeout(dismiss, ms);
  return t;
}

const STATE_COLOR = { idle: '#9e9e9e', travel: '#1f78b4', carry: '#6a3d9a',
                      pick: '#33a02c', pack: '#e31a1c', inspect: '#ffb300' };
const ABC_COLOR = { A: '#d7301f', B: '#fc8d59', C: '#fdcc8a' };
// Storage-equipment colors (mirror whsim.racktypes) — tints the 2D shelf bodies.
const RACK_COLOR = { light: '#7fb0f2', medium: '#2ee6a0', pallet: '#f5b05a',
                     nestainer: '#9b6bff', flow: '#34e3ff', asrs: '#5cebff' };

// ---- theme-aware canvas palette --------------------------------------------
// Resolved from CSS custom properties at draw time (cached, refreshed on the
// `themechange` event). Fallbacks equal the previous hardcoded values so LIGHT
// mode is pixel-identical; the dark variants live in styles.css.
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
let PALETTE = null;
function refreshPalette() {
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
  };
  return PALETTE;
}
const ZONE_JP = { receiving: '入荷', storage: '保管', picking: 'ピッキング',
                  packing: '梱包', shipping: '出荷', staging: '一時保管' };

const S = {
  project: null, replay: null, scene3d: null, designer: null, compare: null,
  export: null, cody: null, chat: null, settings: null, onboarding: null, timetable: null,
  dataanalysis: null, materialflow: null, notes: null, journey: null, overview: null, bi: null, bianalytics: null, phaseHint: null,
  hasData: false, hasRun: false, preset: 'brand',
  t: 0, window: 1, playing: true, speed: 60, view: 'chat',
};
const AGV_COLOR = { idle: '#9e9e9e', travel: '#1f78b4', pickup: '#33a02c',
                    dropoff: '#f57f17', charge: '#8e24aa' };

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

// ---- 2D canvas -------------------------------------------------------------
const canvas = $('canvas2d');
const ctx = canvas.getContext('2d');
function fitCanvas() {
  const r = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function draw2d() {
  const rep = S.replay;
  const P = PALETTE || refreshPalette();
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!rep) {
    ctx.fillStyle = P.inkFaint; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('プロジェクトを作成して「実行」すると、ここに動きが表示されます', w / 2, h / 2);
    return;
  }
  const b = rep.meta.bounds, pad = 16;
  const sc = Math.min((w - 2 * pad) / b.width, (h - 2 * pad) / b.depth);
  const ox = (w - b.width * sc) / 2, oy = (h - b.depth * sc) / 2;
  const X = (x) => ox + x * sc, Y = (y) => h - oy - y * sc; // flip y

  ctx.strokeStyle = P.shell; ctx.lineWidth = 1.5;
  ctx.strokeRect(X(0), Y(b.depth), b.width * sc, b.depth * sc);
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
    ctx.strokeStyle = 'rgba(52,227,255,0.20)'; ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const [i, j] of (rep.navnet.edges || [])) {
      const a = wp[i], b = wp[j];
      if (!a || !b) continue;
      ctx.moveTo(X(a[0]), Y(a[1])); ctx.lineTo(X(b[0]), Y(b[1]));
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(52,227,255,0.45)';
    for (const p of wp) { ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 1.8, 0, 7); ctx.fill(); }
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
    ctx.fillStyle = '#08519c'; ctx.beginPath();
    ctx.arc(X(s.x), Y(s.y), 7, 0, 7); ctx.fill();
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
    ctx.strokeStyle = rt.mover === 'forklift' ? '#f57f17' : '#00b8d4';
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
    const hue = Math.round((1 - util) * 120); // 120=green (empty) → 0=red (full/jam)
    ctx.fillStyle = `hsla(${hue},85%,50%,${0.22 + util * 0.5})`;
    ctx.fillRect(X(sg.x), Y(sg.y + sg.h), sg.w * sc, sg.h * sc);
    ctx.strokeStyle = `hsl(${hue},85%,38%)`; ctx.lineWidth = 1.2;
    ctx.strokeRect(X(sg.x), Y(sg.y + sg.h), sg.w * sc, sg.h * sc);
    ctx.fillStyle = util > 0.55 ? '#fff' : '#243244';
    ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`仮置 ${wip}/${sg.capacity}`, X(sg.x + sg.w / 2), Y(sg.y + sg.h / 2));
  }
  // workers — role decides the glyph (●picker ▲forklift ■packer/inspector),
  // state still tints the fill. Falls back to the legacy round dot for any
  // unknown role, so older replays render identically.
  for (const wk of rep.workers) {
    const [x, y, st] = interp(wk.keyframes, S.t);
    ctx.fillStyle = STATE_COLOR[st] || '#999';
    ctx.strokeStyle = P.agentStroke; ctx.lineWidth = 0.7;
    agentGlyph(X(x), Y(y), wk.role, 6);
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

  // Geometry: small panel pinned top-right of the canvas.
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const pad = 10, W = Math.min(220, cw - 2 * pad), H = 84;
  const x0 = cw - W - pad, y0 = pad;
  // Plot rect inside the panel (room for header text on top).
  const plX = x0 + 10, plY = y0 + 28, plW = W - 20, plH = H - 38;

  // Domains. Use the playback window for x (matches the loop's S.window wrap)
  // so the playhead position is consistent with the scrubber; fall back to the
  // series' own time span if the window is missing.
  const tMax = (typeof S.window === 'number' && S.window > 0)
    ? S.window : (series[series.length - 1].t || 1);
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
  const cyan = '#34e3ff';
  const a0 = ctx.globalAlpha;
  ctx.save();

  // Translucent panel.
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(11,19,32,0.72)';
  ctx.strokeStyle = 'rgba(126,160,200,0.18)'; ctx.lineWidth = 1;
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
  ctx.fillStyle = '#9fb4c8';
  const wipCol = curWip > 0 ? '#f5b05a' : '#9fb4c8';
  ctx.fillText(`完了 ${curDone}`, x0 + W - 56, y0 + 18);
  ctx.fillStyle = wipCol;
  ctx.fillText(`仮置 ${curWip}`, x0 + W - 10, y0 + 18);

  // Baseline of the plot.
  ctx.strokeStyle = 'rgba(126,160,200,0.20)'; ctx.lineWidth = 1;
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
  ctx.globalAlpha = 1; ctx.strokeStyle = reduce ? 'rgba(52,227,255,0.6)' : cyan;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(phX, plY); ctx.lineTo(phX, plY + plH); ctx.stroke();
  ctx.fillStyle = cyan;
  ctx.beginPath(); ctx.arc(phX, PY(cur.rate), 2.6, 0, 7); ctx.fill();

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
    ctx.arc(cx, cy, r, 0, 7);
  }
  ctx.fill(); ctx.stroke();
}

// 仮置きバッファ充満リング (Mini Metro): a perimeter arc over the staging box
// centre showing live WIP / capacity, cyan→amber→red by threshold. Additive to
// the existing staging heat rectangle; only called when rep.staging exists.
function drawStagingRing(cx, cy, sg) {
  const tl = sg.timeline || [];
  let wip = 0;
  for (let i = 0; i < tl.length; i++) { if (tl[i][0] <= S.t) wip = tl[i][1]; else break; }
  const frac = Math.min(1, wip / Math.max(sg.capacity, 1));
  const col = frac < 0.60 ? '#34e3ff' : frac < 0.85 ? '#f5b05a' : '#ff5a78';
  const R = 13;
  // Gentle pulse when nearly full (≥85%) and actively playing — a Mini-Metro
  // "overcrowding" cue. Restores globalAlpha so nothing downstream is affected.
  const pulse = (frac >= 0.85 && S.playing)
    ? 0.65 + 0.35 * (0.5 + 0.5 * Math.sin(performance.now() / 280))
    : 1;
  const a0 = ctx.globalAlpha;
  ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(126,160,200,0.20)';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.stroke();
  ctx.globalAlpha = a0 * pulse;
  ctx.strokeStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + frac * 2 * Math.PI); ctx.stroke();
  ctx.globalAlpha = a0;
  ctx.lineWidth = 1; ctx.lineCap = 'butt';
}

// Bottleneck ⚠ overlay: read the bottleneck stage from the replay's KPIs and
// drop a warning marker on the matching zone centre. No KPIs / no matching
// zone => nothing drawn (full backward compatibility).
function drawBottleneck(rep, X, Y) {
  const k = rep.kpis;
  if (!k || !k.bottleneck_jp) return;
  // Map the bottleneck label back to a zone type across ALL stages
  // (入荷/検品/格納/ピッキング/梱包/出荷…), not just picking/packing. Built by
  // inverting ZONE_JP so any zone type can match; unmatched => nothing drawn.
  const JP_TO_TYPE = Object.fromEntries(
    Object.entries(ZONE_JP).map(([type, jp]) => [jp, type]));
  const extra = { '検品': 'inspection', '格納': 'storage' }; // synonyms not in ZONE_JP
  const stage = JP_TO_TYPE[k.bottleneck_jp] || extra[k.bottleneck_jp] || null;
  const z = stage ? (rep.zones || []).find(zz => zz.type === stage) : null;
  if (!z) return;
  const cx = X(z.x + z.w / 2), cy = Y(z.y + z.h / 2);
  ctx.fillStyle = 'rgba(245,176,90,0.12)';
  ctx.strokeStyle = '#f5b05a'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(cx, cy - 16, 11, 0, 7); ctx.fill(); ctx.stroke();
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
  ctx.fillStyle = 'rgba(11,19,32,0.72)'; ctx.strokeStyle = 'rgba(126,160,200,0.18)';
  ctx.lineWidth = 1;
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x0, y0, bw, bh, 6); ctx.fill(); ctx.stroke(); }
  else { ctx.fillRect(x0, y0, bw, bh); ctx.strokeRect(x0, y0, bw, bh); }
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = '10px sans-serif';
  items.forEach(([role, label], i) => {
    const gy = y0 + 9 + i * lh;
    ctx.fillStyle = '#34e3ff'; ctx.strokeStyle = P.agentStroke; ctx.lineWidth = 0.6;
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

// ---- shared clock / render loop -------------------------------------------
let lastTs = performance.now();
function loop(ts) {
  const dt = (ts - lastTs) / 1000; lastTs = ts;
  if (S.playing && S.replay) {
    S.t += dt * S.speed;
    if (S.t > S.window) S.t = 0;
    $('scrub').value = String(Math.round((S.t / S.window) * 1000));
    $('clock').textContent = (S.t / 60).toFixed(1) + ' 分';
  }
  if (S.view === 'view2d') draw2d();
  requestAnimationFrame(loop);
}

// ---- data flow -------------------------------------------------------------
async function loadTemplates() {
  const ts = await api('/api/templates');
  $('templateSelect').innerHTML = ts.map(t =>
    `<option value="${t.template_id}">${t.name || t.template_id}</option>`).join('');
}
async function refreshProjects(select) {
  const ps = await api('/api/projects');
  const sel = $('projectSelect');
  sel.innerHTML = '<option value="">（新規作成）</option>';
  ps.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    sel.appendChild(opt);
  });
  if (select) sel.value = select;
  updateProjMenuState();
  if (S.onboarding && S.onboarding.refreshCTA) S.onboarding.refreshCTA();
}
function updateProjMenuState() {
  const btn = $('projMenuBtn');
  if (btn) btn.disabled = !S.project;
}
// Core create flow, shared by the sidebar button and the Cody chat.
async function doCreate(name, template) {
  await api('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, template }),
  });
  await refreshProjects(name);
  await openProject(name);
}
async function openProject(name) {
  S.project = name;
  const m = await api(`/api/projects/${name}/model`);
  renderHeadline(m.headline_fields, m.headline_values);
  $('provenance').textContent = m.provenance_summary;
  $('runBtn').disabled = false;
  $('status').textContent = `プロジェクト「${name}」を開きました。設計を調整して実行できます。`;
  updateProjMenuState();
  // Reset replay/analysis state and restore this project's chat thread.
  S.replay = null;
  S.hasRun = false;
  // "% your data" > 0 ⇒ real customer data has been imported (not just template).
  S.hasData = /([1-9]\d*)\s*%/.test(m.provenance_summary || '');
  refreshReadiness();
  if (S.chat && S.chat.loadFor) S.chat.loadFor(name);
  if (S.settings && S.settings.loadFor) S.settings.loadFor(name);
  if (S.view === 'design') mountDesigner();
  if (S.view === 'analysis') mountAnalysis($('analysis'), S.project);
}

async function mountDesigner() {
  if (!S.project) return;
  // Re-entrancy guard: tearing down the old Designer up-front (so a concurrent
  // mount can't orphan it), then bailing if the project/view changed while the
  // model fetch was in flight — otherwise two rapid mounts could leak listeners.
  if (S.designer) { S.designer.dispose(); S.designer = null; }
  const epoch = (S._designerEpoch = (S._designerEpoch || 0) + 1);
  const proj = S.project;
  const model = await api(`/api/projects/${proj}/full`);
  if (epoch !== S._designerEpoch || S.view !== 'design' || S.project !== proj) return;
  S.designer = new Designer($('design'), model, {
    save: async (sections) => {
      const r = await api(`/api/projects/${S.project}/design`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sections),
      });
      $('provenance').textContent = r.provenance_summary;
      $('status').textContent = '設計を保存しました。「実行」で検証できます。';
      await openProjectQuiet();  // refresh headline values after re-materialise
      return r;
    },
    // Slot the loaded inventory onto the created locations (velocity/ABC).
    assignInventory: async (strategy = 'abc') => {
      const s = await api(`/api/projects/${S.project}/assign-inventory`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy }),
      });
      $('status').textContent = '在庫割付: ' + (s.message || '完了');
      return s;
    },
    // Reverse-name a 5-axis work method (live, as the user turns the knobs).
    workmethodName: async (work) => api('/api/workmethod/name', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(work),
    }),
    // Suggest a work method from the loaded project's order profile.
    recommendWork: async () => api(`/api/projects/${S.project}/workmethod/recommend`),
  });
  S.designer.resize();
}
async function openProjectQuiet() {
  const m = await api(`/api/projects/${S.project}/model`);
  renderHeadline(m.headline_fields, m.headline_values);
}
function renderHeadline(fields, values) {
  const el = $('headline'); el.innerHTML = '';
  for (const f of fields) {
    let v = values[f.path];
    const id = 'hf_' + f.path.replace(/\W/g, '_');
    const scale = f.scale || 1;
    let input;
    if (f.type === 'choice') {
      const opts = (f.choices || []).map(c => {
        const val = (typeof c === 'object') ? c.value : c;
        const lab = (typeof c === 'object') ? c.label : c;
        return `<option value="${val}" ${val === v ? 'selected' : ''}>${lab}</option>`;
      }).join('');
      input = `<select id="${id}" data-path="${f.path}">${opts}</select>`;
    } else {
      const shown = (v ?? 0) / scale;
      input = `<input id="${id}" data-path="${f.path}" data-scale="${scale}" ` +
        `type="number" step="any" value="${shown}" />`;
    }
    const unit = f.unit ? `<span class="unit">${f.unit}</span>` : '';
    el.insertAdjacentHTML('beforeend',
      `<div class="field"><label>${f.label}</label>${input}${unit}</div>`);
  }
}
async function applyHeadline() {
  if (!S.project) return;
  const payload = {};
  document.querySelectorAll('#headline [data-path]').forEach(inp => {
    let v = inp.value;
    if (inp.type === 'number') v = parseFloat(v) * (parseFloat(inp.dataset.scale) || 1);
    payload[inp.dataset.path] = v;
  });
  const r = await api(`/api/projects/${S.project}/headline`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  $('provenance').textContent = r.provenance_summary;
  $('status').textContent = 'キー項目を反映しました。';
  toast('キー項目を反映しました。', 'ok');
}
// Core run flow, shared by the sidebar button and the Cody chat. Throws on
// failure (callers decide how to surface it); returns the run payload.
async function doRun() {
  if (!S.project) throw new Error('先にプロジェクトを作ってね。');
  if (S.running) throw new Error('いまシミュレーション中だよ。終わるまで少し待ってね。');
  S.running = true;
  try {
    const r = await api(`/api/projects/${S.project}/run`, { method: 'POST' });
    S.hasRun = true;
    refreshReadiness();
    renderKpis(r.kpis);
    await loadReplay();
    $('pngImg').src = `/api/projects/${S.project}/png?ts=${Date.now()}`;
    if (S.export) S.export.refresh();
    if (S.view === 'analysis') mountAnalysis($('analysis'), S.project);
    return r;
  } finally {
    S.running = false;
  }
}
async function runSim() {
  if (!S.project) return;
  setBtnBusy($('runBtn'), true, '実行中…');
  $('status').textContent = '重厚なシミュレーションを実行中…';
  cody('thinking', 'シミュレーション中…動きを最後まで追ってるよ。');
  try {
    const r = await doRun();
    $('status').textContent = `完了（${r.run}）。`;
    cody('success', '完了！「分析」タブに指摘と次の一手をまとめたよ。');
  } catch (e) {
    $('status').textContent = 'エラー: ' + e.message;
    toast('シミュレーションに失敗しました: ' + e.message, 'error');
    cody('error', 'エラー: ' + e.message + ' — 落ち着いて直そう。');
  } finally {
    setBtnBusy($('runBtn'), false);
  }
}
async function loadReplay() {
  const rep = await api(`/api/projects/${S.project}/replay`);
  S.replay = rep;
  S.window = rep.meta.replay_window_s || rep.meta.duration_s || 1;
  S.t = 0;
  S.playing = true;
  $('playBtn').disabled = false; $('scrub').disabled = false;
  $('playBtn').textContent = '⏸';
  if (S.scene3d) { S.scene3d.dispose(); S.scene3d = null; }
  if (S.view === 'view3d') mount3d();
}
function renderKpis(k) {
  const cls = k.can_handle_demand ? 'ok' : 'bad';
  const cards = [
    ['スループット', k.throughput_p5 != null
      ? `${k.throughput_per_hr.toFixed(0)} 件/時 (${k.throughput_p5.toFixed(0)}–${k.throughput_p95.toFixed(0)})`
      : `${k.throughput_per_hr.toFixed(0)} 件/時`],
    ['出荷完了', `${k.orders_completed.toFixed(0)} / ${k.orders_arrived.toFixed(0)}`],
    ['ボトルネック', `${k.bottleneck_jp || ''} ${(k.bottleneck_utilization*100).toFixed(0)}%`],
    ['ピッカー稼働率', `${k.n_pickers}名 ${(k.picker_utilization*100).toFixed(0)}%`],
    ['梱包台稼働率', `${k.n_packers}台 ${(k.packer_utilization*100).toFixed(0)}%`],
    ['処理時間 中央値/最悪', `${(k.cycle_p50_s/60).toFixed(0)}/${(k.cycle_p95_s/60).toFixed(0)} 分`],
    ['1件あたり歩行', `${k.walk_per_order_m.toFixed(0)} m`],
  ];
  const cur = k.currency || '¥';
  if (k.robustness != null && k.replications > 1)
    cards.push(['安定度', `${(k.robustness*100).toFixed(0)}% (${k.replications}回検証)`]);
  if (k.n_agvs) cards.push(['AGV稼働率', `${k.n_agvs}台 ${(k.agv_utilization*100).toFixed(0)}%`]);
  if (k.total_cost_per_order) cards.push(['1件あたりコスト', `${cur}${k.total_cost_per_order.toFixed(1)}`]);
  if (k.monthly_cost) cards.push(['月間コスト', `${cur}${Math.round(k.monthly_cost).toLocaleString()}`]);
  $('kpiBar').innerHTML = `<div class="verdict ${cls}">${k.verdict}</div>` +
    cards.map(([kk, vv]) => `<div class="kpi"><div class="k">${kk}</div><div class="v">${vv}</div></div>`).join('');
}

// Core scenario-compare flow, shared by the button and the Cody chat.
async function doRunScenarios() {
  if (!S.project) throw new Error('先にプロジェクトを作ってね。');
  if (S.running) throw new Error('いま実行中だよ。終わるまで少し待ってね。');
  S.running = true;
  try {
    const data = await api(`/api/projects/${S.project}/run-scenarios`, { method: 'POST' });
    if (S.compare) S.compare.dispose();
    $('compareView').innerHTML = '';  // clear any skeleton placeholder
    S.compare = new CompareView($('compareView'), data);
    return data;
  } finally {
    S.running = false;
  }
}
async function runScenarios() {
  if (!S.project) { toast('先にプロジェクトを作ってください。', 'error'); return; }
  setBtnBusy($('runScenariosBtn'), true, '比較中…');
  $('compareStatus').textContent = '3シナリオを重厚シミュレーション中…';
  if (S.compare && S.compare.dispose) S.compare.dispose();
  $('compareView').innerHTML = '<div class="skeleton-block" aria-hidden="true"></div>'
    + '<div class="skeleton-block" aria-hidden="true"></div>';
  try {
    await doRunScenarios();
    $('compareStatus').textContent = '完了。';
  } catch (e) {
    $('compareStatus').textContent = 'エラー: ' + e.message;
    $('compareView').innerHTML = '';
    toast('シナリオ比較に失敗しました: ' + e.message, 'error');
  } finally {
    setBtnBusy($('runScenariosBtn'), false);
  }
}

function mount3d() {
  const el = $('view3d');
  if (!S.replay) return;
  if (S.scene3d) { S.scene3d.dispose(); S.scene3d = null; }
  // Clear any leftover fallback message from a previous failed mount.
  const fb = el.querySelector('.view3d-fallback');
  if (fb) fb.remove();
  try {
    S.scene3d = new Scene3D(el, S.replay, () => S.t);
    if (S.preset && S.scene3d.setPreset) S.scene3d.setPreset(S.preset);
    applyStaffing3d();   // overlay the timetable staffing if one has been computed
    S.scene3d.resize();
  } catch (e) {
    // WebGL may be unavailable (no GPU / context loss). Don't let the failure
    // escape the click handler; show a graceful fallback in the panel instead.
    S.scene3d = null;
    el.innerHTML = '<div class="view3d-fallback">3D表示を初期化できませんでした'
      + '（お使いの環境でWebGLが利用できない可能性があります）。'
      + '「2D アニメーション」タブでも動きを確認できます。</div>';
  }
}

function mountExport() {
  if (S.export) { S.export.refresh(); return; }
  S.export = new ExportView($('export'), {
    getProjectName: () => S.project,
    toast: (msg, kind) => toast(msg, kind),
  });
  S.export.refresh();
}

function mountDataAnalysisView() {
  if (S.dataanalysis) return;
  S.dataanalysis = mountDataAnalysis($('dataanalysis'), {
    getProject: () => S.project,
    toast: (msg, kind) => toast(msg, kind),
  });
}

function mountMaterialFlowView() {
  if (S.materialflow) return;
  S.materialflow = mountMaterialFlow($('materialflow'), {
    toast: (msg, kind) => toast(msg, kind),
  });
}

function mountNotesView() {
  if (!S.notes) {
    S.notes = mountNotes($('notes'), {
      getProject: () => S.project,
      toast: (msg, kind) => toast(msg, kind),
    });
  } else {
    S.notes.refresh();   // re-read the current project's board
  }
}

// ---- readiness / 動線 (Cody home status + soft-gated result tabs) -----------
// The product never blocks (every model is runnable from provisional values), so
// the result tier is *soft*-gated: tabs stay visible but carry a 「要実行」 badge
// and clicking one before a run nudges toward 実行 instead of showing emptiness.
function refreshReadiness() {
  const hasP = !!S.project, run = !!S.hasRun, data = !!S.hasData;
  const pill = $('statusPill');
  if (pill) {
    const set = (step, on) => {
      const c = pill.querySelector(`.sp-chip[data-step="${step}"]`);
      if (c) c.classList.toggle('on', on);
    };
    set('project', hasP);
    set('data', data);
    set('run', run);
    const runChip = pill.querySelector('.sp-chip[data-step="run"]');
    if (runChip) runChip.lastChild.textContent = run ? '実行済' : '未実行';
    const dataEl = $('spData');
    if (dataEl) dataEl.textContent = data ? '取込済' : 'テンプレ仮値';
  }
  // The 5-phase stepper re-evaluates its ✓/🔒 flags + sub-tab hints from S.
  if (S.journey) S.journey.refresh();
  if (S.view) updatePhaseHint(S.view);
}

// ---- import ----------------------------------------------------------------
async function uploadZip(file) {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  const fd = new FormData(); fd.append('file', file);
  $('importLog').textContent = '取り込み中…';
  try {
    const r = await api(`/api/projects/${S.project}/import`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">取り込み: ${r.updated.join(', ') || 'なし'}</span>`];
    for (const w of r.warnings) lines.push(`<span class="warn">! ${w}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    $('provenance').textContent = r.provenance_summary;
    S.hasData = true;
    await openProject(S.project); // refresh headline values (also refreshes readiness)
    if (S.dataanalysis) S.dataanalysis.refresh();
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('取り込みに失敗しました: ' + e.message, 'error'); }
}

async function uploadDistances(file) {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  const fd = new FormData(); fd.append('file', file);
  $('importLog').textContent = '棚間距離を取込中…';
  try {
    const r = await api(`/api/projects/${S.project}/import-distances`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">棚間距離: ${r.count}件取込（実測距離で動線を補正）</span>`];
    for (const w of (r.warnings || []).slice(0, 5)) lines.push(`<span class="warn">! ${w}</span>`);
    $('importLog').innerHTML = lines.join('\n');
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('取り込みに失敗しました: ' + e.message, 'error'); }
}

async function uploadMapcsv(file) {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  const fd = new FormData(); fd.append('file', file);
  $('importLog').textContent = 'MapMaker地図を解析中…';
  try {
    const r = await api(`/api/projects/${S.project}/import-mapcsv`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">地図取込: 棚${r.shelves}・壁${r.walls}・ステーション${r.stations}` +
      ` → ロケーション${r.locations}件生成（${r.stats && r.stats.units || 'm'}）</span>`];
    for (const w of (r.warnings || []).slice(0, 5)) lines.push(`<span class="warn">! ${w}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    await openProject(S.project); // refresh headline/provenance/readiness
    if (S.view === 'design') mountDesigner();
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('地図取込に失敗しました: ' + e.message, 'error'); }
}

// ---- unified 入荷/出荷/商品マスタ import with editable column mapping ---------
let _tableFile = null, _tableKind = 'shipments';
async function uploadTable(file) {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  _tableFile = file; _tableKind = $('tableKind').value;
  await doTableImport(null);
}
async function doTableImport(mapping) {
  const fd = new FormData(); fd.append('file', _tableFile);
  let url = `/api/projects/${S.project}/import-table?kind=${_tableKind}`;
  if (mapping) url += '&mapping=' + encodeURIComponent(JSON.stringify(mapping));
  $('importLog').textContent = '取込中…';
  try {
    const r = await api(url, { method: 'POST', body: fd });
    renderTableMapping(r);
    if (r.provenance_summary) $('provenance').textContent = r.provenance_summary;
    await openProject(S.project);
    toast('取込しました。', 'ok');
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('取込に失敗しました: ' + e.message, 'error'); }
}
function renderTableMapping(r) {
  const opts = (sel) => ['<option value="">（なし）</option>']
    .concat((r.columns || []).map(c => `<option${c === sel ? ' selected' : ''}>${c}</option>`)).join('');
  const rows = Object.entries(r.mapping || {}).map(([k, m]) =>
    `<div class="row" style="gap:6px;margin:3px 0;align-items:center">
       <span style="flex:1;font-size:12px">${m.label}${m.required ? ' <b style="color:var(--bad)">*</b>' : ''}</span>
       <select data-mapfield="${k}" style="flex:1">${opts(m.column)}</select>
     </div>`).join('');
  const cnt = Object.entries(r.counts || {}).map(([k, v]) => `${k}: ${v}`).join(' / ');
  $('importLog').innerHTML =
    `<span class="ok">取込（${cnt || '0'}）</span>
     <div style="margin-top:6px;font-size:11px;color:var(--muted-2)">列マッピング（必要なら直して再取込）</div>${rows}
     <button id="remapBtn" style="margin-top:6px;width:100%">この対応で再取込</button>`;
  $('remapBtn').onclick = () => {
    const mp = {};
    $('importLog').querySelectorAll('[data-mapfield]').forEach(s => { mp[s.dataset.mapfield] = s.value || null; });
    doTableImport(mp);
  };
}

async function generateMissing() {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  setBtnBusy($('genMissingBtn'), true, '生成中…');
  try {
    const r = await api(`/api/projects/${S.project}/generate-missing`, { method: 'POST' });
    const lines = (r.generated && r.generated.length)
      ? r.generated.map(g => `<span class="ok">＋ ${g}</span>`)
      : ['<span class="warn">生成できる不足データはありませんでした。</span>'];
    $('importLog').innerHTML = lines.join('\n');
    if (r.provenance_summary) $('provenance').textContent = r.provenance_summary;
    await openProject(S.project);  // refresh headline/provenance/readiness
    toast('不足データを生成しました。', 'ok');
    cody('excited', '不足していたマスタを実データから補ったよ。これで実行できる。');
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('生成に失敗しました: ' + e.message, 'error'); }
  finally { setBtnBusy($('genMissingBtn'), false); }
}

async function uploadCad(file) {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  const fd = new FormData(); fd.append('file', file);
  $('importLog').textContent = 'CAD図面を解析中…';
  try {
    const r = await api(`/api/projects/${S.project}/import-cad`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">図面取込: 壁${r.walls}本 / ゾーン${r.zones}個 / ` +
      `外形 ${r.bounds ? r.bounds.width.toFixed(0) + '×' + r.bounds.depth.toFixed(0) + 'm' : '—'}</span>`];
    for (const w of (r.warnings || [])) lines.push(`<span class="warn">! ${w}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    if (S.view === 'design') mountDesigner();
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('取り込みに失敗しました: ' + e.message, 'error'); }
}

// ---- theme (light/dark, manual toggle, persisted) -------------------------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('themeToggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀ ライト' : '🌙 ダーク';
  // Let canvas/SVG views (2D replay, analysis charts) re-read colors.
  document.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}
function initTheme() {
  // Dark-first per the brand handoff; the manual toggle still wins when set.
  const saved = localStorage.getItem('whsim-theme');
  applyTheme(saved || 'dark');
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('whsim-theme', next);
  applyTheme(next);
}

// ---- Cody mascot companion (help / suggestion / error reactions) -----------
function cody(mood, say) { if (S.cody) S.cody.setMood(mood, say ? { say } : {}); }

// ---- shared busy state (spinner on a button + disable controls) -------------
function setBtnBusy(btn, on, busyLabel) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${busyLabel || btn.dataset.label}`;
  } else {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
    if (btn.dataset.label != null) { btn.textContent = btn.dataset.label; }
  }
}

// ---- view switching (shared by the tab bar and the Cody chat) -------------
function switchView(view) {
  if (!view || !$(view)) return;
  S.view = view;
  document.querySelectorAll('.tab').forEach(x => {
    const on = x.dataset.tab === view;
    x.classList.toggle('active', on);
    x.setAttribute('aria-selected', on ? 'true' : 'false');
    x.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.panel').forEach(x => {
    const on = x.id === view;
    x.classList.toggle('active', on);
    x.hidden = !on;
  });
  // Designer sets inline display on #design; override it so the panel hides.
  $('design').style.display = (view === 'design') ? 'flex' : 'none';
  // The replay transport only belongs to the 2D/3D animation views.
  const replayView = (view === 'view2d' || view === 'view3d');
  document.querySelector('.transport').style.display = replayView ? 'flex' : 'none';
  // The chat home, analysis dashboards and timetable carry their own summaries.
  $('kpiBar').style.display =
    (view === 'analysis' || view === 'dataanalysis' || view === 'materialflow'
      || view === 'notes' || view === 'chat' || view === 'timetable' || view === 'overview'
      || view === 'bi' || view === 'bianalytics')
      ? 'none' : '';
  // Soft guidance: opening a run-gated result view before any run nudges toward 実行.
  const tabBtn = document.querySelector(`.tab[data-tab="${view}"]`);
  if (tabBtn && tabBtn.dataset.need === 'run' && !S.hasRun) {
    cody('curious', S.project
      ? 'この結果はシミュレーション実行後に表示されるよ。左の「▶ シミュレーション実行」を押してね。'
      : 'まずプロジェクトを作って、左で「実行」しよう。結果はそのあとここに出るよ。');
  }
  // The chat view embeds Cody in the thread; hide the floating companion there
  // so it doesn't overlap the composer (it returns on every other view).
  if (S.cody) { if (view === 'chat') S.cody.hide(); else S.cody.show(); }
  if (view === 'design') mountDesigner();
  if (view === 'analysis') { mountAnalysis($('analysis'), S.project); if (S.project) cody('curious', '結果を読み解こう。気になる指摘があれば言って。'); }
  if (view === 'view3d') mount3d();
  if (view === 'view2d') fitCanvas();
  if (view === 'export') mountExport();
  if (view === 'dataanalysis') mountDataAnalysisView();
  if (view === 'materialflow') mountMaterialFlowView();
  if (view === 'notes') mountNotesView();
  if (view === 'timetable') mountTimetableView();
  if (view === 'overview') mountOverviewView();
  if (view === 'bi') mountBIView();
  if (view === 'bianalytics') mountBIAnalyticsView();
  if (view === 'chat' && S.chat) S.chat.focus();
  // Keep the 5-phase stepper highlight + the per-phase hint banner in sync with
  // whatever drove the view change (journey click, Cody, or programmatic).
  if (S.journey) S.journey.setActive(view);
  updatePhaseHint(view);
}

// viewId → phase id (mirrors journey.js PHASES). Cross-cutting views map to null.
const VIEW_PHASE = {
  overview: 'intake', dataanalysis: 'analyze',
  bianalytics: 'analyze',
  bi: 'design', design: 'design', materialflow: 'design', timetable: 'design',
  analysis: 'validate', view2d: 'validate', view3d: 'validate',
  viewpng: 'propose', compare: 'propose', export: 'propose',
};

// Show the phase-goal + next-step banner; for run-gated phases without a run
// (and analyze without data / intake without a project) surface the empty state.
function updatePhaseHint(view) {
  if (!S.phaseHint) return;
  const phase = VIEW_PHASE[view];
  if (!phase) { S.phaseHint.hide(); return; } // chat / notes are cross-cutting
  let empty = false;
  if (phase === 'validate' || phase === 'propose') empty = !S.hasRun;
  else if (phase === 'analyze') empty = !S.hasData;
  else if (phase === 'intake') empty = !S.project;
  S.phaseHint.show(phase, { empty });
}

function mountBIAnalyticsView() {
  if (!S.bianalytics) {
    S.bianalytics = mountBIAnalytics($('bianalytics'), {
      getProject: () => S.project,
      toast: (m, k) => toast(m, k),
      // Delegate a free-text question to Cody: jump to the chat view and ask.
      askCody: (q) => { switchView('chat'); if (S.chat && S.chat.ask) S.chat.ask(q); },
    });
  } else { S.bianalytics.refresh(); }
}

// Mount the 物量BI split view (ETL→material-flow); refresh on revisit.
function mountBIView() {
  if (!S.bi) {
    S.bi = mountBI($('bi'), {
      getProject: () => S.project,
      toast: (m, k) => toast(m, k),
    });
  } else {
    S.bi.refresh();
  }
}

// Mount the ①取込 overview home once; refresh it on every revisit.
function mountOverviewView() {
  if (!S.overview) {
    S.overview = mountOverview($('overview'), {
      getState: () => S,
      getProject: () => api(`/api/projects/${S.project}/model`),
      switchTo: switchView,
      toast: (m, k) => toast(m, k),
    });
  } else {
    S.overview.refresh();
  }
}

// ---- timetable (作業タイムチャート) — mounted once; holds editable state ------
// The staffing solve runs client-side, so it works without a project/run. Its
// live map draws the loaded project's real zones (棚配置) with per-time workers;
// the per-time headcount it emits also feeds the 2D view (時刻連動).
let _ttProj;
async function fetchLayoutFor(name) {
  if (!name) return null;
  try {
    const f = await api(`/api/projects/${name}/full`);
    return f && f.layout ? { bounds: f.layout.bounds, zones: f.layout.zones } : null;
  } catch (_e) { return null; }
}
function mountTimetableView() {
  if (S.timetable) {
    S.timetable.resize();
    if (_ttProj !== S.project) {       // project switched since last visit → refresh map
      _ttProj = S.project;
      fetchLayoutFor(S.project).then((l) => { if (S.timetable) S.timetable.setLayout(l); });
    }
    return;
  }
  _ttProj = S.project;
  S.timetable = mountTimetable($('timetable'), {
    getProject: () => S.project,
    fetchLayout: () => fetchLayoutFor(S.project),
    onChange: (payload) => {
      S.timetableStaffing = payload;
      if (S.view === 'view2d') draw2d();
      if (S.view === 'view3d' && S.scene3d) applyStaffing3d();
    },
  });
}

// Push the timetable's per-time, per-section headcount into the 3D scene as
// worker spheres placed in their zones (時刻連動). No-op without a staffing
// snapshot or a live scene.
function applyStaffing3d() {
  const p = S.timetableStaffing;
  if (!S.scene3d || !p || !S.scene3d.setStaffing) return;
  const count = S.scene3d.setStaffing({ by_section: p.by_section, zmap: p.section_zone_type, colors: p.colors });
  // Lightweight signal (count of worker spheres placed) for observers/tests.
  document.dispatchEvent(new CustomEvent('whsim:staffing3d', { detail: { count, minute: p.minute } }));
}

// ---- apply structured edits then re-run (closes the analysis loop) ---------
// Dispatched from analysis.js / chat.js via CustomEvent('whsim:apply-run').
async function applyAndRun(edits) {
  if (!S.project) { toast('先にプロジェクトを作ってください。', 'error'); return; }
  if (S.running) { toast('いま実行中です。完了までお待ちください。', 'info'); return; }
  if (!edits || typeof edits !== 'object' || !Object.keys(edits).length) return;
  $('status').textContent = '変更を適用して再実行中…';
  cody('thinking', '提案を反映して、もう一度シミュレーションするよ。');
  try {
    const a = await api(`/api/projects/${S.project}/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits }),
    });
    if (a && a.provenance_summary) $('provenance').textContent = a.provenance_summary;
    if (a && Array.isArray(a.skipped) && a.skipped.length) {
      toast(`一部の変更は適用できませんでした（${a.skipped.length}件）。`, 'info');
    }
    await openProjectQuiet();
    const r = await doRun();
    $('status').textContent = `再実行が完了しました（${r.run}）。`;
    toast('変更を適用して再実行しました。', 'ok');
    cody('success', '反映して再実行したよ。分析を見比べてみて。');
    switchView('analysis');
  } catch (e) {
    $('status').textContent = 'エラー: ' + e.message;
    toast('適用に失敗しました: ' + e.message, 'error');
    cody('error', 'うまく適用できなかった: ' + e.message);
  }
}
document.addEventListener('whsim:apply-run', (e) => {
  const edits = e && e.detail && e.detail.edits;
  applyAndRun(edits);
});

// Cross-view drill navigation: a module asks the shell to switch views
// (e.g. 分析BI "物量BIで見る →" / "人員設計へ →").
document.addEventListener('whsim:nav', (e) => {
  const view = e && e.detail && e.detail.view;
  if (typeof view === 'string' && view) switchView(view);
});

// データ分析タブ → タイムチャート: place the day from the measured volumes.
document.addEventListener('whsim:load-timetable', (e) => {
  const scenario = e && e.detail && e.detail.scenario;
  if (!scenario) { toast('先に物量を分析してください。', 'info'); return; }
  switchView('timetable');           // mounts the timetable if needed
  if (S.timetable && S.timetable.loadExternal) {
    S.timetable.loadExternal(scenario);
    toast('実データの物量でタイムチャートに人員配置しました。', 'ok');
  }
});

// Re-resolve the cached canvas palette when the theme flips. draw2d already runs
// in the RAF loop, so it just re-reads PALETTE on the next frame; force one draw
// for the static (paused / no-replay) case so the canvas repaints immediately.
document.addEventListener('themechange', () => {
  refreshPalette();
  if (S.view === 'view2d') draw2d();
});

// Modules (e.g. the timetable tab) request a toast via a CustomEvent so they
// stay decoupled from the shell's notification host.
document.addEventListener('whsim:toast', (e) => {
  const d = (e && e.detail) || {};
  if (d.msg) toast(d.msg, d.kind || 'info');
});

// ---- project management menu (duplicate / rename / delete) -----------------
function closeProjMenu() {
  const menu = $('projMenu'), btn = $('projMenuBtn');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', onDocClickProjMenu, true);
  document.removeEventListener('keydown', onProjMenuKey, true);
}
function openProjMenu() {
  const menu = $('projMenu'), btn = $('projMenuBtn');
  if (!menu || !S.project) return;
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  const first = menu.querySelector('[role="menuitem"]');
  if (first) first.focus();
  document.addEventListener('click', onDocClickProjMenu, true);
  document.addEventListener('keydown', onProjMenuKey, true);
}
function onDocClickProjMenu(e) {
  if (!$('projMenu').contains(e.target) && e.target !== $('projMenuBtn')) closeProjMenu();
}
function onProjMenuKey(e) {
  const menu = $('projMenu');
  const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
  const idx = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); closeProjMenu(); $('projMenuBtn').focus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
  else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  else if (e.key === 'Tab') { closeProjMenu(); }
}
async function projDuplicate() {
  const from = S.project;
  if (!from) return;
  const to = (prompt(`「${from}」を複製します。新しい名前を入力してください。`, from + '-copy') || '').trim();
  if (!to) return;
  try {
    const r = await api(`/api/projects/${from}/duplicate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    await refreshProjects(r.name || to);
    await openProject(r.name || to);
    toast(`「${from}」を複製しました。`, 'ok');
  } catch (e) { toast('複製に失敗しました: ' + e.message, 'error'); }
}
async function projRename() {
  const from = S.project;
  if (!from) return;
  const to = (prompt(`「${from}」の新しい名前を入力してください。`, from) || '').trim();
  if (!to || to === from) return;
  try {
    const r = await api(`/api/projects/${from}/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    if (S.chat && S.chat.renameBucket) S.chat.renameBucket(from, r.name || to);
    await refreshProjects(r.name || to);
    await openProject(r.name || to);
    toast(`「${to}」に名前を変更しました。`, 'ok');
  } catch (e) { toast('名前変更に失敗しました: ' + e.message, 'error'); }
}
async function projDelete() {
  const name = S.project;
  if (!name) return;
  if (!confirm(`プロジェクト「${name}」を削除します。元に戻せません。よろしいですか？`)) return;
  try {
    await api(`/api/projects/${name}`, { method: 'DELETE' });
    if (S.chat && S.chat.clearBucket) S.chat.clearBucket(name);
    clearProjectState();
    await refreshProjects('');
    toast(`「${name}」を削除しました。`, 'ok');
  } catch (e) { toast('削除に失敗しました: ' + e.message, 'error'); }
}
// Reset everything tied to a now-gone project.
function clearProjectState() {
  S.project = null;
  S.replay = null;
  S.hasRun = false;
  S.hasData = false;
  refreshReadiness();
  if (S.settings && S.settings.clear) S.settings.clear();
  if (S.scene3d) { S.scene3d.dispose(); S.scene3d = null; }
  $('projectSelect').value = '';
  $('runBtn').disabled = true;
  $('playBtn').disabled = true; $('scrub').disabled = true;
  $('headline').innerHTML = '';
  $('kpiBar').innerHTML = '';
  $('importLog').innerHTML = '';
  $('pngImg').removeAttribute('src');
  $('provenance').textContent = '— your data';
  $('status').textContent = 'プロジェクトを選択するか、新規に作成してください。';
  updateProjMenuState();
  if (S.chat && S.chat.loadFor) S.chat.loadFor(null);
  if (S.view === 'analysis') mountAnalysis($('analysis'), null);
}

// ---- actions the Cody chat invokes to drive whsim --------------------------
const chatActions = {
  listTemplates: () => api('/api/templates'),
  createProject: (name, template) => doCreate(name, template || $('templateSelect').value || 'ecommerce_small'),
  runSim: async () => { const r = await doRun(); return r.kpis; },
  openView: (view) => switchView(view),
  runScenarios: () => doRunScenarios(),
  getAnalysis: () => (S.project ? api(`/api/projects/${S.project}/analysis`) : Promise.resolve(null)),
};

// ---- collapsible sidebar (hamburger; persisted) ----------------------------
function initSidebar() {
  const layout = document.querySelector('.layout');
  const saved = localStorage.getItem('whsim-sidebar');
  const collapsed = saved ? saved === 'collapsed' : window.innerWidth <= 880;
  layout.classList.toggle('sidebar-collapsed', collapsed);
  $('sidebarToggle').onclick = () => {
    const isCol = layout.classList.toggle('sidebar-collapsed');
    localStorage.setItem('whsim-sidebar', isCol ? 'collapsed' : 'open');
    // Re-fit canvas/3D/designer once the grid transition settles.
    setTimeout(() => {
      fitCanvas();
      if (S.scene3d) S.scene3d.resize();
      if (S.designer) S.designer.resize();
    }, 280);
  };
}

// ---- wire up ---------------------------------------------------------------
function initUI() {
  $('createBtn').onclick = async () => {
    const name = $('newName').value.trim();
    if (!name) {
      $('status').textContent = 'プロジェクト名を入力してください。';
      toast('プロジェクト名を入力してください。', 'info');
      $('newName').focus();
      return;
    }
    setBtnBusy($('createBtn'), true, '作成中…');
    try {
      await doCreate(name, $('templateSelect').value);
      $('newName').value = '';
      toast(`「${name}」を作成しました。`, 'ok');
      cody('excited', `「${name}」を用意したよ。まずは設計を触ってみよう。`);
    } catch (e) {
      $('status').textContent = '作成に失敗: ' + e.message;
      toast('作成に失敗しました: ' + e.message, 'error');
      cody('error', '作成でつまずいた: ' + e.message + ' — 直せるよ。');
    } finally {
      setBtnBusy($('createBtn'), false);
    }
  };
  $('projectSelect').onchange = (e) => { if (e.target.value) openProject(e.target.value); };
  $('applyBtn').onclick = async () => {
    try { await applyHeadline(); }
    catch (e) {
      $('status').textContent = 'エラー: ' + e.message;
      toast('反映に失敗しました: ' + e.message, 'error');
    }
  };
  $('runBtn').onclick = runSim;
  $('runScenariosBtn').onclick = runScenarios;

  // 5-phase guided journey (replaces the flat tab bar). The stepper owns view
  // selection; switchView keeps it (and the phase-hint banner) in sync.
  S.journey = mountJourney($('journey'), {
    getState: () => S,
    onSelectView: (v) => switchView(v),
  });
  S.phaseHint = mountPhaseHint($('phaseHint'), {
    onCta: (target) => switchView(target),
    onRun: () => runSim(),
  });
  // Sync the initial highlight with the default landing view (Cody home).
  S.journey.setActive(S.view);
  updatePhaseHint(S.view);

  // project management menu
  $('projMenuBtn').onclick = (e) => {
    e.stopPropagation();
    if ($('projMenu').hidden) openProjMenu(); else closeProjMenu();
  };
  $('projMenu').querySelectorAll('[role="menuitem"]').forEach((mi) => {
    mi.onclick = () => {
      const act = mi.dataset.act;
      closeProjMenu();
      if (act === 'duplicate') projDuplicate();
      else if (act === 'rename') projRename();
      else if (act === 'delete') projDelete();
    };
  });

  $('themeToggle').onclick = toggleTheme;

  $('presetSelect').onchange = (e) => {
    S.preset = e.target.value;
    if (S.scene3d) S.scene3d.setPreset(S.preset);
  };

  // transport
  $('playBtn').onclick = () => {
    S.playing = !S.playing;
    $('playBtn').textContent = S.playing ? '⏸' : '▶';
  };
  $('scrub').oninput = (e) => {
    if (!S.replay) return;
    S.playing = false; $('playBtn').textContent = '▶';  // don't fight the user
    S.t = (parseFloat(e.target.value) / 1000) * S.window;
    $('clock').textContent = (S.t / 60).toFixed(1) + ' 分';
  };
  $('speed').onchange = (e) => { S.speed = parseFloat(e.target.value); };

  // dropzone
  const dz = $('dropzone'), fi = $('fileInput');
  dz.onclick = () => fi.click();
  fi.onchange = () => fi.files[0] && uploadZip(fi.files[0]);
  $('cadBtn').onclick = () => $('cadInput').click();
  $('cadInput').onchange = () => $('cadInput').files[0] && uploadCad($('cadInput').files[0]);
  $('distBtn').onclick = () => $('distInput').click();
  $('distInput').onchange = () => $('distInput').files[0] && uploadDistances($('distInput').files[0]);
  $('mapcsvBtn').onclick = () => $('mapcsvInput').click();
  $('mapcsvInput').onchange = () => $('mapcsvInput').files[0] && uploadMapcsv($('mapcsvInput').files[0]);
  $('genMissingBtn').onclick = generateMissing;
  $('tableBtn').onclick = () => $('tableInput').click();
  $('tableInput').onchange = () => $('tableInput').files[0] && uploadTable($('tableInput').files[0]);
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault(); dz.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault(); dz.classList.remove('drag');
  }));
  dz.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.zip')) {
      $('importLog').textContent = 'ZIP ファイルをドロップしてください。';
      return;
    }
    uploadZip(f);
  });

  window.addEventListener('resize', () => {
    fitCanvas();
    if (S.scene3d) S.scene3d.resize();
    if (S.designer) S.designer.resize();
  });
  $('playBtn').disabled = true; $('scrub').disabled = true; // until a run exists
  // Default view is the Cody chat home: no replay transport, no KPI footer.
  document.querySelector('.transport').style.display = 'none';
  $('kpiBar').style.display = 'none';
  refreshReadiness();
  fitCanvas();
}

(async function main() {
  initTheme();
  refreshPalette();
  initUI();
  initSidebar();
  S.cody = mountCody(document.body, { mood: 'idle' });
  // Default view is the chat home, which embeds Cody in the thread — keep the
  // floating companion hidden there (switchView toggles it on other views).
  if (S.view === 'chat') S.cody.hide();
  // Chat home: the conversation owns the greeting, so the floating mascot
  // stays quiet until it reacts to an action.
  S.chat = mountChat($('chat'), {
    getProject: () => S.project,
    avatarSVG: codyAvatarSVG,
    onMood: (mood, say) => cody(mood, say),
    actions: chatActions,
  });
  S.settings = mountSettings({
    getProject: () => S.project,
    toast: (msg, kind) => toast(msg, kind),
    hasRun: () => S.hasRun,
    onRerun: () => runSim(),
  });
  S.onboarding = mountOnboarding({
    toast: (msg, kind) => toast(msg, kind),
    openProject: async (name) => { await refreshProjects(name); await openProject(name); },
    refreshProjects: () => refreshProjects(),
    hasProjects: async () => {
      const sel = $('projectSelect');
      // Options beyond the leading "（新規作成）" placeholder mean projects exist.
      return !!(sel && sel.options && sel.options.length > 1);
    },
  });
  await loadTemplates();
  await refreshProjects();
  // First-run: show the sample CTA if there are no projects yet.
  if (S.onboarding) {
    S.onboarding.maybeShowFirstRunCTA();
    // Subtle first-visit guide (shown once; localStorage 'whsim-onboarded').
    setTimeout(() => { try { S.onboarding.startGuide(false); } catch (_e) { /* ignore */ } }, 600);
  }
  S.chat.focus();
  requestAnimationFrame(loop);
  // Dismiss the boot splash once the shell is mounted and interactive.
  const boot = $('boot');
  if (boot) {
    setTimeout(() => boot.classList.add('gone'), 400);
    setTimeout(() => boot.remove(), 1100);
  }
})();
