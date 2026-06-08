// constants.js — shared label/colour maps for the whsim frontend.
//
// These were previously mirrored (by hand) across app.js / designer.js /
// timetable.js / view3d.js. This is the single canonical source. Colours are
// CSS strings (canvas / DOM). view3d.js needs THREE.js numeric hex for its
// material colours, so it keeps its own numeric twins, but its display-only
// rack swatch palette imports RACK_COLOR from here so it can't drift.

// Zone type -> Japanese label. Superset (includes `office`) so every consumer
// can share one map; consumers only look up the zone types present in data.
export const ZONE_JP = {
  receiving: '入荷', storage: '保管', picking: 'ピッキング',
  packing: '梱包', shipping: '出荷', staging: '一時保管', office: '事務',
};

// Equipment type -> Japanese label.
export const EQUIP_JP = {
  agv: 'AGV', forklift: 'フォークリフト', asrs: '自動倉庫',
  robot_arm: 'ロボットアーム', crane: 'クレーン',
};

// Rack ABC class -> colour.
export const ABC_COLOR = { A: '#d7301f', B: '#fc8d59', C: '#fdcc8a' };

// Worker/agent state -> colour.
export const STATE_COLOR = {
  idle: '#9e9e9e', travel: '#1f78b4', carry: '#6a3d9a',
  pick: '#33a02c', pack: '#e31a1c', inspect: '#ffb300',
};

// Storage-equipment colours (mirror whsim.racktypes) — tints the 2D shelf bodies
// and the 3D rack swatch legend.
export const RACK_COLOR = {
  light: '#7fb0f2', medium: '#2ee6a0', pallet: '#f5b05a',
  nestainer: '#9b6bff', flow: '#34e3ff', asrs: '#5cebff',
};

// AGV action -> colour.
export const AGV_COLOR = {
  idle: '#9e9e9e', travel: '#1f78b4', pickup: '#33a02c',
  dropoff: '#f57f17', charge: '#8e24aa',
};
