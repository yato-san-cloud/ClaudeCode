// designer/geometry.js — pure helpers for the design editor.
//
// Stateless utilities (no DOM mutation, no `this`): clone/clamp/snap/uid math,
// the "#rrggbb"→rgba colour helper, and the theme-aware canvas palette resolver
// (reads CSS custom properties at draw time). Moved verbatim from designer.js so
// the geometry/colour helpers live in one small, independently testable module.
import { SNAP } from './constants.js';

// ---- theme-aware canvas palette --------------------------------------------
// Drawing colors are resolved from CSS custom properties at draw time (cached on
// the instance, refreshed on the `themechange` event). Fallbacks equal the prior
// hardcoded hexes so LIGHT mode is pixel-identical; dark variants live in
// styles.css. Chrome (toolbar/help/side panels) uses the app's CSS vars directly.
export function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
export function resolvePalette() {
  return {
    bg:           cssVar('--canvas-bg', 'transparent'),
    shell:        cssVar('--canvas-shell', '#333'),
    ink:          cssVar('--canvas-ink', '#3a4452'),
    inkDim:       cssVar('--canvas-ink-dim', '#aab2bd'),
    inkFaint:     cssVar('--canvas-ink-faint', '#9aa4b0'),
    rack:         cssVar('--canvas-rack', 'rgba(60,72,90,0.5)'),
    sel:          cssVar('--canvas-sel', '#1f2733'),
    selInk:       cssVar('--canvas-sel-ink', '#fff'),
    markerStroke: cssVar('--canvas-marker-stroke', '#fff'),
    badgeBg:      cssVar('--canvas-badge-bg', 'rgba(31,39,51,0.88)'),
    wall:         cssVar('--canvas-wall', '#5a6472'),
    draft:        cssVar('--canvas-draft', '#e31a1c'),
    accent:       cssVar('--accent', '#1f78b4'),
    grid:         cssVar('--canvas-grid', 'rgba(128,140,160,0.45)'),
  };
}

// ---- small helpers ---------------------------------------------------------
export const clone = (o) => JSON.parse(JSON.stringify(o || {}));
export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
export const snap = (v) => Math.round(v / SNAP) * SNAP;
export const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 7)}`;
export function hexA(hex, a) {                       // "#rrggbb" -> rgba()
  if (!hex || hex[0] !== '#') hex = '#cccccc';
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---- 棚番号 (location address) — JS MIRROR of design._address (keep in parity) ---
// Addresses are 通路-連-段 (aisle-bay-level), e.g. "A03-12-2": aisle LETTER from
// an x-band, 連 (bay) number from the y-position along the run, 段 (level) suffix.
// This mirrors src/whsim/design.py so the inspector can preview the exact 棚番号
// the server will materialise — WITHOUT a save round-trip.
const AISLE_BAND_M = 4.0;   // metres of x per aisle letter (must match design.py)

export function aisleLetter(idx) {                   // 0->A .. 25->Z, 26->AA ...
  idx = Math.max(0, idx | 0);
  let s = '';
  for (;;) {
    s = String.fromCharCode(65 + (idx % 26)) + s;
    idx = Math.floor(idx / 26) - 1;
    if (idx < 0) break;
  }
  return s;
}
function pad2(n) { return String(n).padStart(2, '0'); }
export function cellAddress(x, y, level, x0 = 0) {   // mirrors design._address
  const aisle = Math.floor((x - x0) / AISLE_BAND_M);
  const bay = Math.round(y / 0.5) + 1;
  return `${aisleLetter(aisle)}${pad2(aisle + 1)}-${pad2(bay)}-${level}`;
}

// Enumerate cell (x,y) centres of a shelf at its rack type's pitch — MIRROR of
// design._shelf_slots (bays along the long axis, depth across the short axis).
export function shelfCells(sh, rt) {
  const bay = Math.max(+sh.cell_w || rt.bay, 0.3);
  const depth = Math.max(+sh.cell_d || rt.depth, 0.3);
  const vertical = sh.h >= sh.w;
  const px = vertical ? depth : bay;
  const py = vertical ? bay : depth;
  const xs = [];
  const ys = [];
  for (let x = sh.x + px / 2; x <= sh.x + sh.w - px / 2 + 1e-9; x += px) xs.push(Math.round(x * 1e3) / 1e3);
  for (let y = sh.y + py / 2; y <= sh.y + sh.h - py / 2 + 1e-9; y += py) ys.push(Math.round(y * 1e3) / 1e3);
  if (!xs.length) xs.push(Math.round((sh.x + sh.w / 2) * 1e3) / 1e3);
  if (!ys.length) ys.push(Math.round((sh.y + sh.h / 2) * 1e3) / 1e3);
  const out = [];
  for (const x of xs) for (const y of ys) out.push([x, y]);
  return out;
}
