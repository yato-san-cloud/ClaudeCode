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

// Worker/agent state -> colour. Half a step off full saturation so a floor of
// them reads as a shift rather than a pinball table; hues (= the meaning) are
// unchanged. MUST stay numerically equal to the twin in `js/view3d/constants.js`
// — the 2D dot and the 3D vest are the same worker (invariant 11).
export const STATE_COLOR = {
  idle: '#9aa0a6', travel: '#3f719d', carry: '#6b5289',
  pick: '#4d8c47', pack: '#c0554c', inspect: '#d9a441',
};

// Storage-equipment colours (mirror whsim.racktypes) — tints the 2D shelf bodies
// and the 3D rack swatch legend.
export const RACK_COLOR = {
  light: '#7fb0f2', medium: '#2ee6a0', pallet: '#f5b05a',
  nestainer: '#9b6bff', flow: '#34e3ff', asrs: '#5cebff',
  mezzanine: '#b0885f', mobile: '#e07ad2', hanger: '#c8d44e',
};

// AGV action -> colour (same de-saturation pass as STATE_COLOR above).
export const AGV_COLOR = {
  idle: '#9aa0a6', travel: '#3f719d', pickup: '#4d8c47',
  dropoff: '#d08a30', charge: '#7e5c9c',
};

// 荷物（ワーク） state -> colour. The GOODS, as opposed to the people and
// machines moving them (`replay.totes[].keyframes[][3]`). Deliberately a warm
// cardboard/amber family so work reads as *cargo* against the cool blue/green
// agent palette above, and so a box on a grey belt is the brightest thing on
// that belt. `belt` is the family's anchor and is what the legends swatch.
export const WORK_COLOR = {
  carry: '#c9a36b',   // 作業者の手の中 (kraft — matches the 3D carton)
  belt:  '#ffc94d',   // コンベヤ搬送中 (amber — pops off the grey belt line)
  pack:  '#ff7a59',   // 梱包ステーション着荷
};
export const WORK_DEFAULT = WORK_COLOR.carry;
