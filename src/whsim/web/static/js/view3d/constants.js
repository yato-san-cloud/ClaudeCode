// view3d/constants.js — pure data tables + stateless helpers shared by the
// Scene3D mixins. Extracted verbatim from view3d.js (no value changes): colour
// maps, the RACK_DIMS twin of racktypes.py, art PRESETS / FLOOR_TONES, and the
// `this`-free helpers (sampleKeyframes / approach / meta_grid / _enableShadows /
// rackDims). Imported by view3d.js and every view3d/*.js mixin so the same
// tables drive geometry, materials, animation and the legend.
import * as THREE from '../../vendor/three/three.module.js';
// Shared 2D/3D rack swatch palette (CSS strings) — single source of truth so the
// 3D legend can't drift from the 2D editor/replay or whsim.racktypes.
import { RACK_COLOR } from '../constants.js';

// Worker state -> color.
export const STATE_COLOR = {
  idle:   0x9e9e9e,
  travel: 0x1f78b4,
  carry:  0x6a3d9a,
  pick:   0x33a02c,
  pack:   0xe31a1c,
  inspect: 0xffb300,
};
// Rack ABC class -> color.
export const ABC_COLOR = { A: 0xd7301f, B: 0xfc8d59, C: 0xfdcc8a };
// AGV action -> color.
export const AGV_COLOR = {
  idle:    0x9e9e9e,
  travel:  0x1f78b4,
  pickup:  0x33a02c,
  dropoff: 0xf57f17,
  charge:  0x8e24aa,
};
// Height (m) at which AGV boxes ride, centered on their thin body.
export const AGV_Y = 0.2;

// Default workbench footprint (metres, plan view). A replay may override it per
// station with `w`/`d`; these are the values every scene rendered before that
// was possible, so an unstated station is unchanged.
export const STATION_W = 2.0;
export const STATION_D = 0.9;

// Agent state → Japanese label for the click-to-select tooltip. Covers both the
// worker STATE_COLOR keys and the AGV_COLOR action keys; unknown states fall back
// to the raw string so the card is always informative.
export const SEL_STATE_LABEL = {
  idle: '待機', travel: '移動', carry: '搬送', pick: 'ピック', pack: '梱包',
  inspect: '検品', pickup: '積込', dropoff: '荷下し', charge: '充電',
};

// --- Storage-equipment dimensions, mirrored from src/whsim/racktypes.py -------
// One source of truth lives in Python (RACK_TYPES); this is its JS twin so the
// 3D bay/depth/level numbers match the materialised location grid + the 2D PNG.
// `bay`/`depth` are metres (one storage position); `levels` is the shelf count;
// `h` is the realistic *overall rack height* in metres (NOT in racktypes.py —
// added here because the engine only needs footprint, but the 3D needs height).
// This is what FIXES the user's #1 complaint: racks are now 2.0–5.6–16 m tall,
// taller than the 1.7 m human picker, so nothing "突き抜け"s anymore.
export const RACK_DIMS = {
  light:     { bay: 0.9, depth: 0.45, levels: 5, h: 2.0 },   // 軽量棚
  medium:    { bay: 1.2, depth: 0.60, levels: 4, h: 2.4 },   // 中量棚
  pallet:    { bay: 1.1, depth: 1.10, levels: 4, h: 5.6 },   // パレットラック
  nestainer: { bay: 1.1, depth: 1.40, levels: 3, h: 3.6 },   // ネステナー段積み
  flow:      { bay: 1.0, depth: 1.50, levels: 3, h: 2.6 },   // フローラック
  asrs:      { bay: 0.8, depth: 1.20, levels: 12, h: 16.0 }, // 自動倉庫(AS/RS)
  mezzanine: { bay: 2.0, depth: 2.00, levels: 2, h: 4.5 },   // メザニン (中二階)
  mobile:    { bay: 1.2, depth: 0.65, levels: 5, h: 2.6 },   // 移動ラック (レール台車)
  hanger:    { bay: 1.8, depth: 0.60, levels: 1, h: 2.2 },   // ハンガーラック (吊るし)
};
export const RACK_DEFAULT = 'medium';
export function rackDims(rt) { return RACK_DIMS[rt] || RACK_DIMS[RACK_DEFAULT]; }

// Legend metadata for the on-screen 3D guide: Japanese label + a swatch colour
// matching the 2D editor/replay (RACK_COLOR in app.js) so the same rack reads as
// the same colour across 2D and 3D. Display-only; never feeds geometry.
export const RACK_LEGEND = {
  light:     { label: '軽量棚', sw: RACK_COLOR.light },
  medium:    { label: '中量棚', sw: RACK_COLOR.medium },
  pallet:    { label: 'パレットラック', sw: RACK_COLOR.pallet },
  nestainer: { label: 'ネステナー', sw: RACK_COLOR.nestainer },
  flow:      { label: 'フローラック', sw: RACK_COLOR.flow },
  asrs:      { label: '自動倉庫(AS/RS)', sw: RACK_COLOR.asrs },
  mezzanine: { label: 'メザニン', sw: RACK_COLOR.mezzanine },
  mobile:    { label: '移動ラック', sw: RACK_COLOR.mobile },
  hanger:    { label: 'ハンガーラック', sw: RACK_COLOR.hanger },
};

// Steel / accent colours shared by the realistic rack builders.
export const RACK_STEEL = 0x3b434d;     // upright frames / neutral structure
export const RACK_BEAM = 0xff7a1a;      // pallet-rack load beams (signature orange)
export const RACK_BOARD = 0x6b727b;     // shelf boards (light/medium)
export const PALLET_WOOD = 0xb08247;    // wooden pallet base under pallet loads
export const ROLLER_COLOR = 0x9aa3ad;   // flow-rack inclined roller lanes
export const ASRS_FRAME = 0x8d949c;     // AS/RS tower frame
export const ASRS_CRANE = 0xf0c020;     // AS/RS stacker-crane mast (hi-vis yellow)

// --- Realistic storage-equipment palette (v0.3.0 圧倒的にリアル) --------------
// Real racking is painted steel, not neutral slabs: uprights are a deep blue
// (the industry's most common frame colour), load beams a signature orange, and
// decking/bracing raw galvanised grey. These feed PBR MeshStandardMaterials so
// Lane A's lighting/environment makes them read as painted + galvanised steel.
export const RACK_UPRIGHT = 0x2c5f9e;   // painted upright frame (deep blue)
export const RACK_BRACE = 0x2f6cae;     // frame bracing (same paint, a touch lighter)
export const RACK_FOOT = 0x252c36;      // upright footplate / anchor shoe (dark)
export const RACK_GALV = 0x99a3ae;      // galvanised wire mesh deck / shelf panel
export const SHELF_PANEL = 0x7e8894;    // 軽量/中量棚 shelf panel (painted steel)
export const CARRIAGE_DARK = 0x333b46;  // 移動ラック carriage body
export const RAIL_STEEL = 0x555f6b;     // floor rails (mobile rack / AS-RS crane)

// Cardboard: a kraft base plus a few subtle per-carton tone multipliers so a
// stack never reads as one flat colour. instanceColor multiplies the shared
// corrugated CanvasTexture, so these stay *materially* cardboard (never neon).
export const CARTON_BASE = 0xc49a68;
export const CARTON_TONES = [0xffffff, 0xf0e6da, 0xe8dccb, 0xfdf6ec, 0xdccdb8];
// Plastic totes (flow rack / AS-RS bins) — muted logistics greys/blues.
export const TOTE_TONES = [0x4a5c72, 0x3f5166, 0x55677d, 0x45566b];
// Apparel on hangers: muted retail garment tones (never neon).
export const GARMENT_TONES = [
  0x51607a, 0x7a4f52, 0x4d6155, 0x6b6072, 0x8a7a5e, 0x455063, 0x77626a,
];

// --- Rack level-of-detail (LOD) ---------------------------------------------
// Storage detail is generated per BAY, so a 616-location DC can ask for tens of
// thousands of parts. Two independent, documented rules keep it fast:
//
//  1. COUNT-based geometry tier, chosen once at build time from the scene's
//     total bay count (`RACK_LOD.fine` / `RACK_LOD.coarse` thresholds):
//       tier 0 (fine)   — bracing, wire-mesh decking, footplates, stringer
//                         pallets, 3–5 varied cartons per slot, ABC labels
//       tier 1 (mid)    — bracing + decking kept, simplified pallets, 2 cartons
//                         per slot, labels kept
//       tier 2 (coarse) — silhouette only: uprights + beams/panels + ONE merged
//                         load block per slot; no bracing/decking/labels
//  2. APPARENT-SIZE visibility for the finest meshes (footplates, bracing, wire
//     decking, ABC labels). The first cut of this rule used a raw camera→target
//     DISTANCE (34 m), which silently broke the default hero framing: a 108 m
//     building can never be framed from inside 34 m, so the salesperson's very
//     first look at the warehouse showed racks stripped of their detail. What
//     actually matters is how BIG a metre is on screen, which depends on the
//     canvas height and the vertical fov as much as on distance:
//
//       pxPerM = canvasHeightPx / (2 · dist · tan(fov/2))
//
//     so the same scene shows detail sooner in a maximised (⛶ 拡大) view than in
//     a small docked one — which is exactly the behaviour you want. Thresholds
//     are per COUNT tier (a 3000-bay floor has to be stingier than a 200-bay
//     one) and carry hysteresis so an orbit that hovers on the boundary doesn't
//     flicker the meshes on and off.
export const RACK_LOD = {
  fine: 260,        // <= this many bays in the scene → tier 0
  coarse: 900,      // <= this many bays → tier 1; above → tier 2
  // Screen pixels per world metre at/above which fine meshes are shown, per tier.
  detailPxPerM: [2.2, 3.0, 6.0],
  detailHysteresis: 0.8,   // turn OFF only below threshold × this
};

// Pick-event highlight: target cell pulse + connector colour.
export const PICK_GLOW = 0xffe14d;      // warm amber pulse on the reached cell
export const PICK_LINE = 0xffe14d;

// Cyan accent used for the "active machine glow" (WITNESS-beating chrome).
export const GLOW_CYAN = 0x00d4f0;
// Agent states that read as "working/moving" → glow ramps up; others decay.
export const ACTIVE_WORKER = { travel: 1, carry: 1, pick: 1, pack: 1, inspect: 1 };
export const ACTIVE_AGV = { travel: 1, pickup: 1, dropoff: 1 };
// States in which an AGV/forklift is hauling a load → show its tote box.
export const CARRY_AGV = { pickup: 1, dropoff: 1, travel: 1 };

// Render / art presets. Each tweaks background, fog, light intensities/colors
// and tone-mapping exposure ONLY — never static geometry. See setPreset().
// `shadow`: enable hard cast shadows for this preset; `shadowOpacity` controls
// how dark the contact shadow reads (lower = softer/lighter).
export const PRESETS = {
  // Dark-first brand preset (default) — matches the cool-slate + cyan chrome.
  brand: {
    background: 0x0f141d, fogColor: 0x121a26,
    hemiSky: 0x6a8ba8, hemiGround: 0x0c1018, hemiInt: 0.5,
    ambient: 0x2b3b52, ambientInt: 0.30,
    dirColor: 0xbfe6ff, dirInt: 0.72,
    exposure: 1.0, rackEmissive: 0.16,
    shadow: true, shadowOpacity: 0.55,
  },
  natural: {
    background: 0xeef1f5, fogColor: 0xeef1f5,
    hemiSky: 0xffffff, hemiGround: 0xb7c0cc, hemiInt: 0.85,
    ambient: 0xffffff, ambientInt: 0.25,
    dirColor: 0xfff4e6, dirInt: 0.85,
    exposure: 1.05, rackEmissive: 0.06,
    shadow: true, shadowOpacity: 0.9,
  },
  evening: {
    background: 0x2e2438, fogColor: 0x3a2c44,
    hemiSky: 0xffd9a0, hemiGround: 0x40303a, hemiInt: 0.55,
    ambient: 0xffe0b0, ambientInt: 0.18,
    dirColor: 0xff9d4d, dirInt: 1.15,
    exposure: 1.15, rackEmissive: 0.1,
    shadow: true, shadowOpacity: 1.0,
  },
  night: {
    background: 0x0a1020, fogColor: 0x0c1426,
    hemiSky: 0x4a6080, hemiGround: 0x05080f, hemiInt: 0.4,
    ambient: 0x2a3a55, ambientInt: 0.22,
    dirColor: 0xbcd0ff, dirInt: 0.6,
    exposure: 0.95, rackEmissive: 0.35,
    shadow: false, shadowOpacity: 0.4,
  },
  mono: {
    background: 0xdfe4ea, fogColor: 0xdfe4ea,
    hemiSky: 0xf2f4f7, hemiGround: 0xaeb6c2, hemiInt: 0.95,
    ambient: 0xc8d0da, ambientInt: 0.45,
    dirColor: 0xc3ccda, dirInt: 0.55,
    exposure: 1.0, rackEmissive: 0.0,
    shadow: false, shadowOpacity: 0.5,
  },
};

// Route mover -> bright line color.
// Floor + grid tones per preset (the concrete texture multiplies `floor`, so a
// dark floor reads as dark concrete with faint joints). Keeps the 3D floor in
// step with the dark-first chrome instead of a bright white slab.
export const FLOOR_TONES = {
  brand:   { floor: 0x141b26, gridA: 0x2a3a52, gridB: 0x1c2636 },
  natural: { floor: 0xeef1f5, gridA: 0xb0b8c0, gridB: 0xc8cfd6 },
  evening: { floor: 0x241d2e, gridA: 0x46384f, gridB: 0x33293c },
  night:   { floor: 0x0c1426, gridA: 0x24365a, gridB: 0x162540 },
  mono:    { floor: 0xdfe4ea, gridA: 0xb0b8c0, gridB: 0xc8cfd6 },
};

export const ROUTE_COLOR = { forklift: 0xff7a00, person: 0x00b8d4 };

// Equipment type -> base color (placed/static equipment models).
export const EQUIP_COLOR = {
  agv:       0x3949ab,
  forklift:  0xf57c00,
  asrs:      0x8d949c,
  robot_arm: 0x9aa3ad,
  crane:     0x424a52,
  sorter:    0x2bb6a3,   // 仕分機/ソーター — industrial teal
};

// Sample [t, x, y, state, hit?] from a worker's sorted keyframe array (see spec).
// A keyframe may carry an optional 5th element `hit` ({run_id, along, sku, qty})
// on `pick` frames; we surface the active frame's hit so the caller can drive the
// pick-event viz. Backward-compatible: 4-tuple frames simply have `hit === null`.
export function sampleKeyframes(keyframes, t) {
  if (!keyframes || keyframes.length === 0) return { x: 0, y: 0, state: 'idle', hit: null };
  const first = keyframes[0];
  if (t <= first[0]) return { x: first[1], y: first[2], state: 'idle', hit: null };
  const last = keyframes[keyframes.length - 1];
  if (t >= last[0]) return { x: last[1], y: last[2], state: last[3], hit: last[4] || null };
  // Linear scan for the bracketing pair k0 <= t < k1.
  let i = 0;
  for (; i < keyframes.length - 1; i++) {
    if (keyframes[i][0] <= t && t < keyframes[i + 1][0]) break;
  }
  const k0 = keyframes[i];
  const k1 = keyframes[i + 1];
  const span = k1[0] - k0[0];
  let f = span > 0 ? (t - k0[0]) / span : 0;
  f = Math.max(0, Math.min(1, f));
  // Long, sparse spans look stiff under constant-velocity lerp; smoothstep eases
  // their start/end. Short spans stay linear (cheap) and exact endpoints (f=0/1)
  // are preserved either way, so this never alters the actual keyframe values.
  if (span > 0.3) f = f * f * (3 - 2 * f);
  return {
    x: k0[1] + (k1[1] - k0[1]) * f,
    y: k0[2] + (k1[2] - k0[2]) * f,
    state: k0[3],
    hit: k0[4] || null,
  };
}

// Frame-rate-independent exponential approach of `cur` toward `target`.
// `rate` is the responsiveness (larger = snappier). Used to ramp emissive glow
// up/down smoothly without per-frame allocation. Safe for dt<=0 / NaN.
export function approach(cur, target, dt, rate) {
  if (!(dt > 0)) return cur;
  const k = 1 - Math.exp(-rate * dt);
  return cur + (target - cur) * k;
}

// Read meta.grid_m defensively, defaulting to 1m.
export function meta_grid(replay) {
  const g = replay && replay.meta && replay.meta.grid_m;
  return g && g > 0 ? g : 1;
}

// Flag every mesh under an object3D to cast and receive shadows.
export function _enableShadows(obj) {
  obj.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}
