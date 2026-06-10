// designer.js — facade for the structured/parametric warehouse design editor.
//
// The editor was split into a cohesive `designer/` package so future features
// touch one small module:
//   designer/constants.js — palettes, label maps, geometry constants.
//   designer/geometry.js  — pure helpers (clone/clamp/snap/uid/hexA, palette).
//   designer/core.js      — the Designer class (state, lifecycle, render, save).
//
// This module stays as the public entry point so the host import path is
// unchanged: `import { Designer } from './js/designer.js'`.
export { Designer } from './designer/core.js';
