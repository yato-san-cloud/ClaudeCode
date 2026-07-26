// state.js — the single shared SPA state object for the whsim frontend shell.
//
// `S` was previously a module-local const in app.js. It is hoisted here, unchanged,
// so that the extracted shell modules (imports.js / projectmenu.js) read and write
// the SAME singleton — there must be exactly one `S` across the whole frontend.
// app.js still imports this `S` and uses it identically; no field is added or
// removed, so behaviour is byte-identical in effect.
//
// Vanilla ES module, no dependencies (and it must never import app.js — keeping the
// dependency arrow one-way avoids an import cycle).
export const S = {
  project: null, replay: null, scene3d: null, designer: null, compare: null,
  export: null, cody: null, chat: null, settings: null, onboarding: null, timetable: null,
  dataanalysis: null, materialflow: null, notes: null, journey: null, overview: null, bi: null, bianalytics: null, phaseHint: null,
  dashboard: null, dashScene: null,
  hasData: false, hasRun: false, preset: 'brand',
  t: 0, window: 1, playing: true, speed: 60, view: 'overview',
};
