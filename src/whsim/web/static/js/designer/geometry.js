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
