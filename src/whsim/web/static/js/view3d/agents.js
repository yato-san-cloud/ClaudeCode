// view3d/agents.js — Scene3D's moving population + their per-frame animation:
// the ARTICULATED human picker figures (walk cycle / idle stance / reach), the
// timetable staffing snapshot, the AMR-style AGVs, the counterbalance forklifts
// (mast + fork carriage + seated driver + rolling/steering wheels + beacon),
// manual route flow-lines, the instanced soft contact-shadow decals, the additive
// cyan activity halos (pseudo-bloom), the pooled pick-event markers, and every
// _update*() that interpolates them off the keyframe sampler each frame.
// Mixed into Scene3D.prototype by view3d.js; every method runs with `this` bound
// to the Scene3D instance, so the shared agent records + tracked GPU resources
// match what the shell expects.
//
// ANIMATION MODEL (the part that makes a replay feel alive):
//   * Nothing is driven by wall-clock alone. Locomotion phase is advanced by the
//     agent's REAL per-frame displacement (`dist / STRIDE_M`), so feet never slide
//     regardless of playback speed, scene scale or frame rate.
//   * Every pose is a blend between an idle pose and a moving pose, eased with
//     `approach()` so starts/stops are smooth instead of popping.
//   * Each agent carries a deterministic phase offset (from its index) so a crowd
//     never marches in lockstep.
//   * Geometry/materials are shared across agents and merged where parts are
//     rigid, so dozens of movers stay cheap (no per-frame allocation anywhere).
import * as THREE from '../../vendor/three/three.module.js';
import {
  STATE_COLOR, AGV_COLOR, AGV_Y, GLOW_CYAN,
  ACTIVE_WORKER, ACTIVE_AGV, CARRY_AGV, ROUTE_COLOR,
  PICK_GLOW, PICK_LINE, CARTON_BASE, CARTON_TONES,
  sampleKeyframes, approach, _enableShadows,
} from './constants.js';

// ---------------------------------------------------------------------------
// Rig constants (metres / radians)
// ---------------------------------------------------------------------------
const TWO_PI = Math.PI * 2;
// A 1.72 m warehouse operator. `spine`-local coordinates are measured UP FROM
// THE HIPS, so the leg chain and the torso chain never fight each other.
const HIP_Y = 0.86;          // hip joint height above the floor
const SHOULDER_SY = 0.52;    // shoulder height, spine-local (world 1.38)
// Shoulders sit OUTSIDE the vest silhouette (vest half-width is 0.23) so the
// swinging arms read as arms instead of disappearing into the torso block.
const SHOULDER_X = 0.245;
const THIGH_L = 0.42;
const SHIN_L = 0.44;
const UPPER_ARM_L = 0.30;
// Ground distance covered by ONE FULL walk cycle (= two steps). Phase advances by
// realDistance / STRIDE_M, which is exactly what removes foot-sliding.
const STRIDE_M = 1.45;
// Cap the cycle rate so 60× playback reads as "hurrying", not a strobe.
const MAX_CYCLES_PER_S = 2.6;
const WALK_SPEED_FULL = 0.55; // m/s at which the gait blend reaches a full stride

// Forklift / AGV wheel radii (used to roll wheels by real distance travelled).
const FK_WHEEL_R = 0.24;
const AGV_WHEEL_R = 0.10;

// ---------------------------------------------------------------------------
// 荷物（ワーク） — the goods themselves
// ---------------------------------------------------------------------------
// `replay.totes` = [{ id, keyframes: [[t, x, y, state], …] }], state ∈
//   "carry" (in a picker's hands) | "belt" (riding a conveyor) | "pack" (at the
//   station). Keyframes are already emitted along the conveyor POLYLINE, so a
//   plain lerp follows the path round its corners.
// Heights are read off the objects the work actually sits on, so a box never
// floats or sinks into the thing carrying it:
const BELT_TOP_Y = 0.21;     // conveyor tread surface (scene.js: yMid .12 + h/2)
const STATION_TOP_Y = 0.885; // pack bench top (scene.js _buildStations)
const TOTE_H = 0.26;         // A.gTote box height — the box rests ON the surface
const CARRY_Y = 1.06;        // fallback hand height (no picker within reach)
// A tote's keyframe state is "<place>" or "<place>:<mark>". `place` is the
// existing vocabulary (carry / pack / belt) and decides WHERE the box sits;
// `mark` is optional and decides how it LOOKS. They are genuinely independent:
// a lidded container is still on the bench, then still on the belt, and the one
// thing the audience has to see is the moment the lid goes on. Without the
// split that moment can only be expressed by moving the box somewhere, which is
// a lie about the process. No colon ⇒ exactly today's behaviour.
const _kraft = new THREE.Color(CARTON_BASE);
const TOTE_MARK_COLOR = {
  sealed: 0x2e7d32,   // 蓋つき・封止済み
  open:   0x9cc8ec,   // 蓋が開いている
  hold:   0xb3261e,   // 保留・隔離
};
// A `carry` tote is handed to the nearest picker within this radius (the rig
// already owns a tote/carton child, so drawing ours too would double-draw).
const CARRY_SNAP_M = 1.8;
// Once past its last keyframe the work is done: shrink it away over this long
// instead of popping out of existence.
const PACK_FADE_S = 0.9;

// ---------------------------------------------------------------------------
// Build-time geometry helpers (never called per frame)
// ---------------------------------------------------------------------------
const _bE = new THREE.Euler();
const _bQ = new THREE.Quaternion();
const _bV = new THREE.Vector3();
const _bS = new THREE.Vector3(1, 1, 1);

// Describe one rigid sub-part of a merged mesh: a geometry placed at a local
// offset/rotation. Returns { geom, matrix } for _merge().
function _part(geom, x, y, z, rx, ry, rz) {
  _bE.set(rx || 0, ry || 0, rz || 0);
  _bQ.setFromEuler(_bE);
  _bV.set(x || 0, y || 0, z || 0);
  return { geom, matrix: new THREE.Matrix4().compose(_bV, _bQ, _bS) };
}

// Merge rigid parts into ONE BufferGeometry (position/normal/uv). The vendored
// three build has no BufferGeometryUtils (that lives in addons), and fewer meshes
// = fewer draw calls, which is what keeps dozens of articulated agents cheap.
// The SOURCE geometries are throwaway build scratch and are disposed here.
function _merge(parts) {
  const prepped = [];
  let total = 0;
  for (const p of parts) {
    const src = p.geom;
    const g = src.index ? src.toNonIndexed() : src.clone();
    if (p.matrix) g.applyMatrix4(p.matrix);
    prepped.push(g);
    total += g.attributes.position.count;
    src.dispose();
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o3 = 0, o2 = 0;
  for (const g of prepped) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o2);
    o3 += n * 3;
    o2 += n * 2;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

// Rounded-rectangle Shape (centred on the origin) — the AMR silhouette. Shape /
// ExtrudeGeometry are three CORE classes, so this needs no addon.
function _roundedRect(w, l, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -l / 2;
  const rr = Math.min(r, Math.min(w, l) / 2);
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + l - rr);
  s.quadraticCurveTo(x + w, y + l, x + w - rr, y + l);
  s.lineTo(x + rr, y + l);
  s.quadraticCurveTo(x, y + l, x, y + l - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  return s;
}

// A rounded slab lying in the XZ plane, `h` tall, base at local y = 0.
function _slab(w, l, r, h, bevel) {
  const g = new THREE.ExtrudeGeometry(_roundedRect(w, l, r), {
    depth: h, curveSegments: 5, bevelEnabled: !!bevel,
    bevelSize: 0.018, bevelThickness: 0.018, bevelSegments: 1,
  });
  g.rotateX(-Math.PI / 2); // extrude along +Z → stand it up along +Y
  return g;
}

// A wheel whose spin axis is local X (so `mesh.rotation.x += …` rolls it).
function _wheel(r, width, seg) {
  const g = new THREE.CylinderGeometry(r, r, width, seg || 12);
  g.rotateZ(Math.PI / 2);
  return g;
}

// ---------------------------------------------------------------------------
// Per-frame math helpers (allocation-free)
// ---------------------------------------------------------------------------
// Shortest signed difference a-b wrapped to (-π, π].
function _angDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= TWO_PI;
  while (d < -Math.PI) d += TWO_PI;
  return d;
}
function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
// smoothstep(0,1,x)
function _smooth(x) { const t = _clamp(x, 0, 1); return t * t * (3 - 2 * t); }

// Vertical-pick envelope: given a worker's keyframes and the playback time `t`,
// return how "raised" the picker should be (0 at the start of the pick dwell,
// EASES up to 1, HOLDS, then EASES back down to 0 by the end of the dwell span).
// Mirrors sampleKeyframes' bracket scan (no allocation) but reads `f` within the
// current pair so the lift tracks the sim-clock playback exactly. Returns 0 when
// `t` is not inside a bracketed span (start/end clamp → resting on the floor).
const _LIFT_EDGE = 0.28; // fraction of the dwell spent easing up / easing down
function _dwellEnv(keyframes, t) {
  if (!keyframes || keyframes.length < 2) return 0;
  if (t <= keyframes[0][0] || t >= keyframes[keyframes.length - 1][0]) return 0;
  let i = 0;
  for (; i < keyframes.length - 1; i++) {
    if (keyframes[i][0] <= t && t < keyframes[i + 1][0]) break;
  }
  const k0 = keyframes[i];
  const k1 = keyframes[i + 1];
  const span = k1[0] - k0[0];
  if (span <= 0) return 0;
  const f = (t - k0[0]) / span; // 0..1 progress through this dwell
  let e;
  if (f < _LIFT_EDGE) e = f / _LIFT_EDGE;                  // ease up
  else if (f > 1 - _LIFT_EDGE) e = (1 - f) / _LIFT_EDGE;   // ease down
  else e = 1;                                              // hold at the level
  e = _clamp(e, 0, 1);
  return e * e * (3 - 2 * e); // smoothstep the edges
}

// Track an agent's REAL ground motion between frames and keep a locomotion phase
// in sync with the distance actually covered. `rec` gains _px/_pz/speed/phase/
// gait/_yawPrev. Returns the distance moved this frame (metres).
// This one function is why nothing foot-slides: the cycle is a function of
// DISTANCE, not of time.
function _stepMotion(rec, x, z, dt) {
  if (rec._px === undefined) { rec._px = x; rec._pz = z; }
  const dx = x - rec._px, dz = z - rec._pz;
  rec._px = x; rec._pz = z;
  let dist = Math.sqrt(dx * dx + dz * dz);
  // A teleport (scrub / loop wrap) must not spin the wheels for a kilometre. The
  // threshold has to stay well ABOVE a legitimate fast-playback step: at 60×
  // speed a walking picker legitimately covers ~1.3 m per 60 fps frame, and far
  // more on a slow GPU, so only a genuine jump (a scrub, or the replay looping)
  // clears this bar.
  if (dist > 30) dist = 0;
  rec._vx = dx; rec._vz = dz;
  const inst = dt > 0 ? dist / dt : 0;
  rec.speed = approach(rec.speed || 0, inst, dt, 7);
  // Advance the cycle by ground covered, capped so extreme playback speeds read
  // as a fast walk rather than a blur.
  const capped = Math.min(dist, MAX_CYCLES_PER_S * STRIDE_M * Math.max(dt, 0));
  rec.phase = (rec.phase || 0) + (capped / STRIDE_M) * TWO_PI;
  if (rec.phase > TWO_PI) rec.phase -= TWO_PI * Math.floor(rec.phase / TWO_PI);
  return dist;
}

export const agentMethods = {
  // -- Shared agent art assets ----------------------------------------------
  // Every geometry + every non-per-agent material used by the human figures, the
  // AMRs and the forklifts, built ONCE per scene and shared by all agents (this
  // is what makes "dozens of movers" affordable). Tracked in _geometries /
  // _materials so Scene3D.dispose() frees them exactly as before.
  _agentAssets() {
    if (this._aa) return this._aa;
    const G = [];
    const M = [];
    const geo = (g) => { G.push(g); return g; };
    const mat = (o) => { const m = new THREE.MeshStandardMaterial(o); M.push(m); return m; };

    // ---- materials -------------------------------------------------------
    const A = {
      // human
      mSkin: mat({ color: 0xe3b98d, roughness: 0.72, metalness: 0.02 }),
      mShirt: mat({ color: 0x33404f, roughness: 0.85, metalness: 0.03 }),
      mTrouser: mat({ color: 0x232c38, roughness: 0.9, metalness: 0.02 }),
      mBand: mat({
        color: 0xe8eef2, roughness: 0.32, metalness: 0.15,
        emissive: new THREE.Color(0x9fb6c2), emissiveIntensity: 0.22,
      }),
      mCap: mat({ color: 0xf2c200, roughness: 0.5, metalness: 0.08 }),
      mTote: mat({ color: 0xc9a36b, roughness: 0.85, metalness: 0.04 }),
      mCarton: mat({ color: 0xd8b483, roughness: 0.9, metalness: 0.02 }),
      // order-picker platform
      mDeck: mat({ color: 0xf57c00, roughness: 0.5, metalness: 0.4 }),
      mMast: mat({ color: 0xb0b6bd, roughness: 0.4, metalness: 0.6 }),
      // forklift
      mFkBody: mat({ color: 0xf5a021, roughness: 0.42, metalness: 0.45 }),
      mFkDark: mat({ color: 0x272c33, roughness: 0.6, metalness: 0.35 }),
      mFkSteel: mat({ color: 0xa8afb7, roughness: 0.34, metalness: 0.72 }),
      mTyre: mat({ color: 0x14181d, roughness: 0.95, metalness: 0.02 }),
      mPallet: mat({ color: 0xb08247, roughness: 0.92, metalness: 0.02 }),
      // AGV
      mAgvShell: mat({ color: 0x2b3441, roughness: 0.42, metalness: 0.35 }),
      mAgvDeck: mat({ color: 0x1a212b, roughness: 0.7, metalness: 0.2 }),
    };
    A._mats = M;

    // ---- human figure ----------------------------------------------------
    // torsoBase = pelvis + waist + chest + neck (rigid, one draw call). The three
    // stacked boxes taper, which is what stops the figure reading as one slab.
    // Spine-local: y = 0 is the hip joint, +y is up.
    A.gTorso = geo(_merge([
      _part(new THREE.BoxGeometry(0.355, 0.24, 0.235), 0, -0.02, 0),  // pelvis
      _part(new THREE.BoxGeometry(0.375, 0.20, 0.235), 0, 0.16, 0),   // waist
      _part(new THREE.BoxGeometry(0.425, 0.36, 0.25), 0, 0.40, 0),    // chest
      _part(new THREE.CylinderGeometry(0.055, 0.060, 0.11, 8), 0, 0.615, 0), // neck
    ]));
    // Hi-vis over-vest (state-coloured, per-worker material) — proud of the shirt
    // but narrower than the shoulders, so the arms stay visible beside it.
    A.gVest = geo(new THREE.BoxGeometry(0.455, 0.38, 0.285));
    // Two reflective bands wrapping the vest + short shoulder straps.
    A.gBands = geo(_merge([
      _part(new THREE.BoxGeometry(0.465, 0.036, 0.295), 0, 0.245, 0),
      _part(new THREE.BoxGeometry(0.465, 0.036, 0.295), 0, 0.395, 0),
      _part(new THREE.BoxGeometry(0.048, 0.13, 0.295), -0.135, 0.485, 0),
      _part(new THREE.BoxGeometry(0.048, 0.13, 0.295), 0.135, 0.485, 0),
    ]));
    A.gHead = geo(new THREE.SphereGeometry(0.113, 14, 12));
    A.gCap = geo(_merge([   // crown + peak
      _part(new THREE.SphereGeometry(0.122, 14, 8, 0, TWO_PI, 0, Math.PI / 2), 0, 0, 0),
      _part(new THREE.BoxGeometry(0.225, 0.020, 0.13), 0, 0.006, 0.112),
    ]));
    A.gThigh = geo(new THREE.BoxGeometry(0.155, THIGH_L, 0.185));
    A.gShin = geo(_merge([  // shin + shoe (rigid below the knee)
      _part(new THREE.BoxGeometry(0.135, SHIN_L, 0.155), 0, -SHIN_L / 2, 0),
      _part(new THREE.BoxGeometry(0.155, 0.085, 0.265), 0, -SHIN_L + 0.042, 0.048),
    ]));
    A.gUpperArm = geo(new THREE.BoxGeometry(0.100, UPPER_ARM_L, 0.112));
    A.gForearm = geo(_merge([ // forearm + hand
      _part(new THREE.BoxGeometry(0.088, 0.30, 0.100), 0, -0.15, 0),
      _part(new THREE.BoxGeometry(0.092, 0.10, 0.104), 0, -0.345, 0.012),
    ]));
    A.gTote = geo(new THREE.BoxGeometry(0.36, 0.26, 0.28));
    A.gCarton = geo(new THREE.BoxGeometry(0.21, 0.17, 0.19));
    // Order-picker deck (cage floor + two rails) and its telescoping mast.
    A.gDeck = geo(_merge([
      _part(new THREE.BoxGeometry(0.78, 0.06, 0.78), 0, 0, 0),
      _part(new THREE.BoxGeometry(0.78, 0.05, 0.05), 0, 0.5, -0.37),
      _part(new THREE.BoxGeometry(0.05, 0.05, 0.78), -0.37, 0.5, 0),
      _part(new THREE.BoxGeometry(0.05, 0.05, 0.78), 0.37, 0.5, 0),
      _part(new THREE.BoxGeometry(0.05, 0.5, 0.05), -0.37, 0.25, -0.37),
      _part(new THREE.BoxGeometry(0.05, 0.5, 0.05), 0.37, 0.25, -0.37),
    ]));
    A.gDeckMast = geo(new THREE.BoxGeometry(0.12, 1.0, 0.12)); // scaled in y

    // ---- forklift (counterbalance truck, forks pointing +Z) ---------------
    A.gFkChassis = geo(_merge([
      _part(new THREE.BoxGeometry(1.06, 0.52, 1.30), 0, 0.44, -0.28),  // frame
      _part(new THREE.BoxGeometry(0.98, 0.44, 0.62), 0, 0.80, -0.80),  // counterweight
      _part(new THREE.BoxGeometry(1.02, 0.08, 0.62), 0, 0.74, -0.36),  // operator floor
    ]));
    A.gFkGuard = geo(_merge([   // ROPS overhead guard: 4 posts + roof
      _part(new THREE.BoxGeometry(0.07, 1.40, 0.07), -0.47, 1.36, -0.16),
      _part(new THREE.BoxGeometry(0.07, 1.40, 0.07), 0.47, 1.36, -0.16),
      _part(new THREE.BoxGeometry(0.07, 1.40, 0.07), -0.47, 1.36, -0.94),
      _part(new THREE.BoxGeometry(0.07, 1.40, 0.07), 0.47, 1.36, -0.94),
      _part(new THREE.BoxGeometry(1.06, 0.07, 0.94), 0, 2.08, -0.55),
    ]));
    A.gFkSeat = geo(_merge([
      _part(new THREE.BoxGeometry(0.44, 0.11, 0.44), 0, 0.98, -0.66),
      _part(new THREE.BoxGeometry(0.44, 0.44, 0.11), 0, 1.24, -0.90),
    ]));
    A.gFkWheelF = geo(_wheel(FK_WHEEL_R, 0.20, 14));
    A.gFkWheelR = geo(_wheel(0.19, 0.17, 12));
    A.gFkMast = geo(_merge([    // two rails + a cross member (tilts as a unit)
      _part(new THREE.BoxGeometry(0.11, 1.95, 0.11), -0.35, 0.98, 0),
      _part(new THREE.BoxGeometry(0.11, 1.95, 0.11), 0.35, 0.98, 0),
      _part(new THREE.BoxGeometry(0.81, 0.09, 0.09), 0, 1.92, 0),
      _part(new THREE.BoxGeometry(0.81, 0.09, 0.09), 0, 0.10, 0),
    ]));
    A.gFkCarriage = geo(_merge([ // backrest + two forks (rides up the mast)
      _part(new THREE.BoxGeometry(0.78, 0.46, 0.06), 0, 0.26, 0.09),
      _part(new THREE.BoxGeometry(0.11, 0.20, 0.07), -0.23, 0.10, 0.09),
      _part(new THREE.BoxGeometry(0.11, 0.20, 0.07), 0.23, 0.10, 0.09),
      _part(new THREE.BoxGeometry(0.115, 0.045, 1.00), -0.23, 0.02, 0.62),
      _part(new THREE.BoxGeometry(0.115, 0.045, 1.00), 0.23, 0.02, 0.62),
    ]));
    A.gPallet = geo(_merge([
      _part(new THREE.BoxGeometry(0.92, 0.035, 1.00), 0, 0.12, 0),
      _part(new THREE.BoxGeometry(0.92, 0.030, 1.00), 0, 0.015, 0),
      _part(new THREE.BoxGeometry(0.11, 0.075, 1.00), -0.38, 0.07, 0),
      _part(new THREE.BoxGeometry(0.11, 0.075, 1.00), 0, 0.07, 0),
      _part(new THREE.BoxGeometry(0.11, 0.075, 1.00), 0.38, 0.07, 0),
    ]));
    A.gLoad = geo(_merge([   // shrink-wrapped carton stack on the pallet
      _part(new THREE.BoxGeometry(0.86, 0.30, 0.94), 0, 0.15, 0),
      _part(new THREE.BoxGeometry(0.80, 0.28, 0.88), 0, 0.44, 0),
    ]));
    A.gWheelSm = geo(_wheel(AGV_WHEEL_R, 0.07, 10));
    A.gDome = geo(new THREE.SphereGeometry(0.10, 12, 7, 0, TWO_PI, 0, Math.PI / 2));
    A.gSteering = geo(new THREE.TorusGeometry(0.135, 0.024, 6, 14));
    // Seated driver: hips on the cushion (y≈1.03), knees forward, feet on the
    // operator floor (y≈0.78), hands out to the steering wheel (y≈1.27).
    A.gDriverBody = geo(_merge([
      _part(new THREE.BoxGeometry(0.37, 0.48, 0.25), 0, 1.33, -0.68),          // torso
      _part(new THREE.BoxGeometry(0.10, 0.09, 0.38), -0.17, 1.29, -0.46, 0.4, 0, 0),
      _part(new THREE.BoxGeometry(0.10, 0.09, 0.38), 0.17, 1.29, -0.46, 0.4, 0, 0),
    ]));
    A.gDriverLegs = geo(_merge([
      _part(new THREE.BoxGeometry(0.32, 0.17, 0.46), 0, 1.10, -0.42),          // thighs
      _part(new THREE.BoxGeometry(0.30, 0.30, 0.17), 0, 0.92, -0.22),          // shins
    ]));
    A.gDriverBands = geo(_merge([
      _part(new THREE.BoxGeometry(0.385, 0.038, 0.265), 0, 1.25, -0.68),
      _part(new THREE.BoxGeometry(0.385, 0.038, 0.265), 0, 1.39, -0.68),
    ]));

    // ---- AGV / AMR (base at local y = -AGV_Y so the mesh origin rides high) --
    const B = -AGV_Y;
    A.gAgvShell = geo(_slab(0.96, 1.36, 0.26, 0.30, true));           // base at 0
    A.gAgvShell.translate(0, B + 0.055, 0);
    A.gAgvDeck = geo(_slab(0.80, 1.16, 0.20, 0.045, false));
    A.gAgvDeck.translate(0, B + 0.365, 0);
    A.gAgvBand = geo(_slab(1.00, 1.40, 0.28, 0.045, false));          // light skirt
    A.gAgvBand.translate(0, B + 0.185, 0);
    A.gAgvStrip = geo(_merge([   // direction-of-travel bar + two rear markers
      _part(new THREE.BoxGeometry(0.46, 0.045, 0.035), 0, B + 0.30, 0.685),
      _part(new THREE.BoxGeometry(0.11, 0.045, 0.035), -0.30, B + 0.30, -0.685),
      _part(new THREE.BoxGeometry(0.11, 0.045, 0.035), 0.30, B + 0.30, -0.685),
    ]));
    A.gAgvLeds = geo(_merge([    // status pods on the deck corners
      _part(new THREE.SphereGeometry(0.055, 10, 6, 0, TWO_PI, 0, Math.PI / 2), -0.32, B + 0.385, -0.46),
      _part(new THREE.SphereGeometry(0.055, 10, 6, 0, TWO_PI, 0, Math.PI / 2), 0.32, B + 0.385, -0.46),
    ]));
    A.gAgvCasters = geo(_merge([
      _part(new THREE.SphereGeometry(0.07, 8, 6), -0.30, B + 0.07, 0.50),
      _part(new THREE.SphereGeometry(0.07, 8, 6), 0.30, B + 0.07, 0.50),
      _part(new THREE.SphereGeometry(0.07, 8, 6), -0.30, B + 0.07, -0.50),
      _part(new THREE.SphereGeometry(0.07, 8, 6), 0.30, B + 0.07, -0.50),
    ]));
    A.gAgvTote = geo(new THREE.BoxGeometry(0.62, 0.44, 0.84));
    A.agvBase = B;

    for (const g of G) this._geometries.push(g);
    for (const m of M) this._materials.push(m);
    this._aa = A;
    return A;
  },

  // Cast/receive flags for agent parts: only the big silhouette pieces feed the
  // shadow map (LEDs/bands/beacons add cost and contribute nothing), and every
  // mover also gets a contact-shadow decal, which is what really grounds it.
  _shadeAgent(root) {
    _enableShadows(root);
    root.traverse((c) => {
      if (c.isMesh && c.userData.noShadow) { c.castShadow = false; c.receiveShadow = false; }
    });
  },

  // Workers are ARTICULATED ~1.72 m humans: a two-segment leg chain (hip→knee)
  // and arm chain (shoulder→elbow) hanging off a spine that leans/bobs, wearing
  // work trousers, a shirt, a state-coloured hi-vis over-vest with reflective
  // bands, and a cap. The Group `g` is the FLOOR ANCHOR (its .position is the
  // agent's ground position), so contact shadows / glow halos / the selection
  // ring — which all read `ref.mesh.position` — keep working unchanged.
  //
  // Hierarchy (why it's shaped this way):
  //   g ── lifter ── body ─┬─ hipL/hipR ── kneeL/kneeR      (legs stay vertical)
  //                        └─ spine ─┬─ torso/vest/head/cap (lean + bob + twist)
  //                                  └─ shoulderL/R ── elbowL/R
  //   g ── platform                                          (order-picker deck)
  _buildWorkers() {
    const workers = this.replay.workers || [];
    if (workers.length === 0) return;
    const A = this._agentAssets();

    for (const wk of workers) {
      const g = new THREE.Group();
      // `lifter` raises the whole figure like an order-picker deck WITHOUT moving
      // `g` (the floor anchor the shadow/halo followers track).
      const lifter = new THREE.Group();
      g.add(lifter);
      const body = new THREE.Group();   // walk bob lives here
      lifter.add(body);

      // --- legs (rooted at the hips, never inherit the torso lean) ----------
      const hips = [];
      const knees = [];
      for (const sx of [-1, 1]) {
        const hip = new THREE.Group();
        hip.position.set(sx * 0.105, HIP_Y, 0);
        const thigh = new THREE.Mesh(A.gThigh, A.mTrouser);
        thigh.position.y = -THIGH_L / 2;
        hip.add(thigh);
        const knee = new THREE.Group();
        knee.position.y = -THIGH_L;
        const shin = new THREE.Mesh(A.gShin, A.mTrouser);
        knee.add(shin);
        hip.add(knee);
        body.add(hip);
        hips.push(hip);
        knees.push(knee);
      }

      // --- spine (torso chain) ---------------------------------------------
      const spine = new THREE.Group();
      spine.position.y = HIP_Y;
      body.add(spine);
      const torso = new THREE.Mesh(A.gTorso, A.mShirt);
      spine.add(torso);
      // Per-worker vest material: lerps to the state colour + carries the glow.
      const vestMat = new THREE.MeshStandardMaterial({
        color: STATE_COLOR.idle, roughness: 0.48, metalness: 0.05,
        emissive: new THREE.Color(GLOW_CYAN), emissiveIntensity: 0.0,
      });
      this._materials.push(vestMat);
      const vest = new THREE.Mesh(A.gVest, vestMat);
      vest.position.y = 0.32;
      spine.add(vest);
      const bands = new THREE.Mesh(A.gBands, A.mBand);
      bands.userData.noShadow = true;
      spine.add(bands);
      const head = new THREE.Mesh(A.gHead, A.mSkin);
      head.position.y = 0.745;
      spine.add(head);
      const cap = new THREE.Mesh(A.gCap, A.mCap);
      cap.position.y = 0.762;
      spine.add(cap);

      // --- arms --------------------------------------------------------------
      const shoulders = [];
      const elbows = [];
      for (const sx of [-1, 1]) {
        const sh = new THREE.Group();
        sh.position.set(sx * SHOULDER_X, SHOULDER_SY, 0);
        const ua = new THREE.Mesh(A.gUpperArm, A.mShirt);
        ua.position.y = -UPPER_ARM_L / 2;
        sh.add(ua);
        const el = new THREE.Group();
        el.position.y = -UPPER_ARM_L;
        const fa = new THREE.Mesh(A.gForearm, A.mSkin);
        el.add(fa);
        sh.add(el);
        spine.add(sh);
        shoulders.push(sh);
        elbows.push(el);
      }
      // Carton grabbed at the end of a reach — rides in the right hand.
      const carton = new THREE.Mesh(A.gCarton, A.mCarton);
      carton.position.set(0, -0.40, 0.03);
      carton.visible = false;
      elbows[1].add(carton);
      // Tote carried in front of the chest while hauling.
      const tote = new THREE.Mesh(A.gTote, A.mTote);
      tote.position.set(0, 0.10, 0.32);
      tote.visible = false;
      spine.add(tote);

      // --- order-picker platform (hidden unless a forklift-served 段 lifts) ---
      const platform = new THREE.Group();
      const platDeck = new THREE.Mesh(A.gDeck, A.mDeck);
      platDeck.position.y = 0.03;
      const platMast = new THREE.Mesh(A.gDeckMast, A.mMast);
      platMast.position.set(-0.40, 0.5, -0.40);
      platform.add(platDeck);
      platform.add(platMast);
      platform.visible = false;
      g.add(platform);

      this._shadeAgent(g);
      this.scene.add(g);
      const idx = this._workers.length;
      const rec = {
        mesh: g, lifter, body, spine, vestMat, tote, carton,
        hips, knees, shoulders, elbows,
        // `armPivot` kept as an alias of the reaching (right) shoulder so any
        // external/legacy reference to the reach joint still resolves.
        armPivot: shoulders[1],
        platform, platDeck, platMast,
        keyframes: wk.keyframes || [],
        glow: 0, reach: 0, lift: 0, faceYaw: 0, speed: 0, gait: 0,
        phase: (idx * 2.399963) % TWO_PI,  // golden-angle offset → no lockstep
        seed: (idx * 0.7548776662) % 1,
        roll: 0, lean: 0, carry: 0,
        idx, kind: 'worker',
      };
      g.userData.agentRef = rec; // raycaster hit → agent record (see _pickAgent)
      this._workers.push(rec);
    }
  },

  // Timetable 時刻連動: place section-coloured worker spheres into their zones,
  // count = the headcount at the timetable's current time. Distinct from the DES
  // agents (those move; these are the planned staffing snapshot). Re-callable —
  // old meshes/materials are removed and freed first so cursor moves don't leak.
  // payload: { by_section:{sec:n}, zmap:{sec:zoneType}, colors:{sec:hex} }
  setStaffing(payload) {
    for (const m of this._staffMeshes) this.scene.remove(m);
    for (const mat of this._staffMats) { if (mat && mat.dispose) mat.dispose(); }
    this._staffMeshes = [];
    this._staffMats = [];
    if (this._disposed || !payload || !payload.by_section) return 0;
    const zones = this.replay.zones || [];
    const zmap = payload.zmap || {};
    const colors = payload.colors || {};
    if (!this._staffGeom) {
      this._staffGeom = new THREE.SphereGeometry(0.42, 12, 10);
      this._geometries.push(this._staffGeom);
    }
    const geom = this._staffGeom;
    let fallbackX = 1; // sections with no matching zone line up along the front edge
    for (const sec of Object.keys(payload.by_section)) {
      const n = payload.by_section[sec] || 0;
      if (n <= 0) continue;
      const cap = Math.min(n, 60);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(colors[sec] || 0x4477aa), roughness: 0.5, metalness: 0.05,
      });
      this._staffMats.push(mat);
      const zone = zones.find((z) => z.type === zmap[sec]);
      let place;
      if (zone) {
        const cols = Math.max(1, Math.ceil(Math.sqrt(cap * ((zone.w || 1) / (zone.h || 1)))));
        const cw = (zone.w || 1) / cols, ch = (zone.h || 1) / Math.ceil(cap / cols);
        place = (k) => [(zone.x || 0) + cw * ((k % cols) + 0.5), (zone.y || 0) + ch * (Math.floor(k / cols) + 0.5)];
      } else {
        const startX = fallbackX; fallbackX += cap * 0.9 + 2;
        place = (k) => [startX + k * 0.9, 1];
      }
      for (let k = 0; k < cap; k++) {
        const [px, pz] = place(k);
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(px, 0.7, pz);
        mesh.castShadow = true;
        this.scene.add(mesh);
        this._staffMeshes.push(mesh);
      }
    }
    return this._staffMeshes.length;
  },

  // AGVs are low-profile AMRs: a rounded extruded chassis, a recessed deck, an
  // emissive light SKIRT + status pods + a direction-of-travel bar (all coloured
  // by the action), four wheels that roll with real distance, and a tote that
  // visibly sits on the deck while hauling. Missing/empty `replay.agvs` → nothing.
  _buildAgvs() {
    const agvs = this.replay.agvs || [];
    if (agvs.length === 0) return;
    const A = this._agentAssets();
    for (const a of agvs) {
      // The chassis IS the root mesh, so `rec.mesh.material` stays the chassis
      // material (the colour the action-lerp drives) exactly as before.
      const mat = new THREE.MeshStandardMaterial({
        color: AGV_COLOR.idle, roughness: 0.38, metalness: 0.5,
        emissive: new THREE.Color(GLOW_CYAN), emissiveIntensity: 0.0,
      });
      this._materials.push(mat);
      const mesh = new THREE.Mesh(A.gAgvShell, mat);
      mesh.position.set(0, AGV_Y, 0);
      this.scene.add(mesh);

      const deck = new THREE.Mesh(A.gAgvDeck, A.mAgvDeck);
      mesh.add(deck);
      // Emissive skirt + strip + pods share ONE per-AGV material so the whole
      // light signature changes colour with the action in a single lerp.
      const ledMat = new THREE.MeshStandardMaterial({
        color: AGV_COLOR.idle, roughness: 0.35, metalness: 0.1,
        emissive: new THREE.Color(AGV_COLOR.idle), emissiveIntensity: 0.7,
      });
      this._materials.push(ledMat);
      const band = new THREE.Mesh(A.gAgvBand, ledMat);
      band.userData.noShadow = true;
      mesh.add(band);
      const strip = new THREE.Mesh(A.gAgvStrip, ledMat);
      strip.userData.noShadow = true;
      mesh.add(strip);
      const dome = new THREE.Mesh(A.gAgvLeds, ledMat);
      dome.userData.noShadow = true;
      mesh.add(dome);
      const casters = new THREE.Mesh(A.gAgvCasters, A.mTyre);
      mesh.add(casters);
      // Two driven wheels roll with distance travelled.
      const wheels = [];
      for (const sx of [-1, 1]) {
        const w = new THREE.Mesh(A.gWheelSm, A.mTyre);
        w.position.set(sx * 0.475, A.agvBase + AGV_WHEEL_R, 0);
        mesh.add(w);
        wheels.push(w);
      }
      // Carried tote: a child of the chassis so it follows position for free.
      const toteMat = new THREE.MeshStandardMaterial({
        color: 0xc9a36b, roughness: 0.85, metalness: 0.05,
        emissive: new THREE.Color(GLOW_CYAN), emissiveIntensity: 0.0,
      });
      this._materials.push(toteMat);
      const tote = new THREE.Mesh(A.gAgvTote, toteMat);
      tote.position.set(0, A.agvBase + 0.61, 0);
      tote.visible = false;
      mesh.add(tote);

      this._shadeAgent(mesh);
      const idx = this._agvs.length;
      const rec = {
        mesh, keyframes: a.keyframes || [], mat, tote, dome, domeMat: ledMat,
        ledMat, band, strip, wheels, glow: 0, kind: 'agv', idx,
        speed: 0, phase: 0, yaw: 0, bob: 0, pitch: 0,
        seed: (idx * 0.7548776662) % 1,
      };
      mesh.userData.agentRef = rec; // raycaster hit → agent record (see _pickAgent)
      this._agvs.push(rec);
    }
  },

  // Moving forklifts: a real counterbalance-truck silhouette — chassis +
  // counterweight, ROPS overhead guard, seat + SEATED DRIVER, steering wheel,
  // a two-rail MAST that tilts, a fork CARRIAGE that rides up the mast (to the
  // pick height when the keyframe carries one), four wheels that roll with real
  // distance (the rear pair steers), an amber rotating beacon and reverse lamps.
  // The local model faces +Z (forks point +Z), so yaw = atan2(vx, vz).
  _buildForklifts() {
    const forklifts = this.replay.forklifts || [];
    if (forklifts.length === 0) return;
    const A = this._agentAssets();
    for (const f of forklifts) {
      const g = new THREE.Group();
      // Body group: takes the pitch/squat under acceleration so the wheels (which
      // are its children) stay planted relative to the chassis.
      const chassis = new THREE.Mesh(A.gFkChassis, A.mFkBody);
      g.add(chassis);
      const guard = new THREE.Mesh(A.gFkGuard, A.mFkDark);
      g.add(guard);
      const seat = new THREE.Mesh(A.gFkSeat, A.mFkDark);
      g.add(seat);
      // Seated driver.
      const driverVest = new THREE.MeshStandardMaterial({
        color: 0xf0a500, roughness: 0.55, metalness: 0.05,
      });
      this._materials.push(driverVest);
      const dBody = new THREE.Mesh(A.gDriverBody, driverVest);
      const dLegs = new THREE.Mesh(A.gDriverLegs, A.mTrouser);
      const dBands = new THREE.Mesh(A.gDriverBands, A.mBand);
      dBands.userData.noShadow = true;
      const dHead = new THREE.Mesh(A.gHead, A.mSkin);
      dHead.position.set(0, 1.68, -0.67);
      const dCap = new THREE.Mesh(A.gCap, A.mCap);
      dCap.position.set(0, 1.70, -0.67);
      const driver = new THREE.Group();
      driver.add(dBody); driver.add(dLegs); driver.add(dBands);
      driver.add(dHead); driver.add(dCap);
      g.add(driver);
      const steer = new THREE.Mesh(A.gSteering, A.mFkDark);
      steer.position.set(0, 1.27, -0.30);
      // Euler XYZ composes as RX·RY·RZ, so the local Z spin (the wheel turning on
      // its column) is applied BEFORE the rake — exactly what we want.
      steer.rotation.x = 1.15;
      g.add(steer);

      // Wheels: front pair drives, rear pair steers (each on its own pivot).
      const wheelsF = [];
      const steerPivots = [];
      const wheelsR = [];
      for (const sx of [-1, 1]) {
        const w = new THREE.Mesh(A.gFkWheelF, A.mTyre);
        w.position.set(sx * 0.46, FK_WHEEL_R, 0.30);
        g.add(w);
        wheelsF.push(w);
        const piv = new THREE.Group();
        piv.position.set(sx * 0.40, 0.19, -0.86);
        const rw = new THREE.Mesh(A.gFkWheelR, A.mTyre);
        piv.add(rw);
        g.add(piv);
        steerPivots.push(piv);
        wheelsR.push(rw);
      }

      // Mast (tilts) → carriage (rides up) → forks + pallet load.
      const mast = new THREE.Group();
      mast.position.set(0, 0, 0.34);
      const mastMesh = new THREE.Mesh(A.gFkMast, A.mFkSteel);
      mast.add(mastMesh);
      const carriage = new THREE.Group();
      const carriageMesh = new THREE.Mesh(A.gFkCarriage, A.mFkSteel);
      carriage.add(carriageMesh);
      const pallet = new THREE.Mesh(A.gPallet, A.mPallet);
      pallet.position.set(0, 0.045, 0.60);
      pallet.visible = false;
      carriage.add(pallet);
      const load = new THREE.Mesh(A.gLoad, A.mCarton);
      load.position.set(0, 0.182, 0.60); // stack base = pallet top
      load.visible = false;
      carriage.add(load);
      carriage.position.y = 0.06; // resting fork height
      mast.add(carriage);
      g.add(mast);

      // Amber rotating beacon on the guard + rear reverse lamps.
      const beaconMat = new THREE.MeshStandardMaterial({
        color: 0xffb300, roughness: 0.3, metalness: 0.1,
        emissive: new THREE.Color(0xffb300), emissiveIntensity: 0.6,
      });
      this._materials.push(beaconMat);
      const beacon = new THREE.Mesh(A.gDome, beaconMat);
      beacon.position.set(0, 2.12, -0.55);
      beacon.scale.set(0.85, 0.8, 0.85);
      beacon.userData.noShadow = true;
      g.add(beacon);
      const lampMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.3, metalness: 0.1,
        emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.0,
      });
      this._materials.push(lampMat);
      const lamps = new THREE.Group();
      for (const sx of [-1, 1]) {
        const lg = new THREE.Mesh(A.gDome, lampMat);
        lg.position.set(sx * 0.32, 0.72, -1.10);
        lg.rotation.x = -Math.PI / 2;
        lg.scale.set(0.55, 0.5, 0.55);
        lg.userData.noShadow = true;
        lamps.add(lg);
      }
      g.add(lamps);

      this._shadeAgent(g);
      this.scene.add(g);
      const idx = this._forklifts.length;
      const rec = {
        group: g, keyframes: f.keyframes || [], yaw: 0, carriage, load, pallet,
        mast, chassis, driver, steer, wheelsF, wheelsR, steerPivots,
        beacon, beaconMat, lampMat,
        lift: 0, glow: 0, speed: 0, spin: 0, steerAng: 0, tilt: 0, revLamp: 0,
        phase: 0, seed: (idx * 0.7548776662) % 1,
        kind: 'forklift', idx,
      };
      g.userData.agentRef = rec; // raycaster hit → agent record (see _pickAgent)
      this._forklifts.push(rec);
    }
  },

  // -- Routes (manual flow lines) -------------------------------------------
  // Bright tubes on the floor + small node spheres at each vertex. mover
  // 'forklift' vs 'person' get distinct colors. Defensive against missing arrays.
  _buildRoutes() {
    const routes = this.replay.routes || [];
    if (routes.length === 0) return;
    const Y = 0.08; // float just above floor so the tube reads clearly
    // Shared node-marker geometry across all routes.
    const nodeGeom = new THREE.SphereGeometry(0.22, 12, 10);
    this._geometries.push(nodeGeom);
    for (const r of routes) {
      const raw = r.points || [];
      const pts = [];
      for (const p of raw) {
        if (!p) continue;
        pts.push(new THREE.Vector3(p[0] || 0, Y, p[1] || 0));
      }
      if (pts.length < 2) continue;
      const color = ROUTE_COLOR[r.mover] !== undefined ? ROUTE_COLOR[r.mover] : 0xffd400;
      const lineMat = new THREE.MeshStandardMaterial({
        color, roughness: 0.5, metalness: 0.1,
        emissive: new THREE.Color(color), emissiveIntensity: 0.6,
      });
      const nodeMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.4, metalness: 0.1,
        emissive: new THREE.Color(color), emissiveIntensity: 0.45,
      });
      this._materials.push(lineMat, nodeMat);
      // Smooth tube following the polyline.
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.2);
      const segs = Math.max(8, pts.length * 12);
      const tubeGeom = new THREE.TubeGeometry(curve, segs, 0.12, 8, false);
      this._geometries.push(tubeGeom);
      const tube = new THREE.Mesh(tubeGeom, lineMat);
      // Routes are flow annotations, not physical objects: no shadows.
      this.scene.add(tube);
      // Node markers at each original vertex.
      for (const v of pts) {
        const node = new THREE.Mesh(nodeGeom, nodeMat);
        node.position.copy(v);
        this.scene.add(node);
      }
    }
  },

  // -- Soft contact shadows --------------------------------------------------
  // A soft radial blob laid FLAT on the floor under every mover. Two upgrades
  // over a billboarded sprite: (a) it is a real ground decal, so it stays a
  // shadow when the camera drops to eye level instead of standing up like a
  // card, and (b) all of them live in ONE InstancedMesh = one draw call for the
  // whole crowd. This is the cheapest possible groundedness cue and is what lets
  // dozens of agents look planted without a second shadow-map pass.
  _buildContactShadows() {
    this._shadowSprites = [];
    this._shadowRefs = [];
    const tex = this._makeBlobTexture();
    this._shadowTex = tex;
    const n = this._workers.length + this._agvs.length + this._forklifts.length;
    if (n === 0) return;
    const geom = new THREE.PlaneGeometry(1, 1);
    geom.rotateX(-Math.PI / 2); // lie flat on the floor
    this._geometries.push(geom);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, color: 0x000000, transparent: true, opacity: 0.46,
      depthWrite: false, depthTest: true,
    });
    this._materials.push(mat);
    const inst = new THREE.InstancedMesh(geom, mat, n);
    inst.frustumCulled = false;
    inst.renderOrder = 3;       // over the floor/zones/heat, under the agents
    inst.castShadow = false;
    inst.receiveShadow = false;
    this.scene.add(inst);
    // InstancedMesh.dispose() frees its instance buffers; parking it in the
    // tracked-geometry list means Scene3D.dispose() calls it with everything else.
    this._geometries.push(inst);
    for (const w of this._workers) this._shadowRefs.push({ ref: w, kind: 'worker', size: 1.25 });
    for (const a of this._agvs) this._shadowRefs.push({ ref: a, kind: 'agv', size: 1.75 });
    for (const f of this._forklifts) this._shadowRefs.push({ ref: f, kind: 'forklift', size: 2.5 });
    this._shadowInst = inst;
    // dispose() walks _shadowSprites and scene.remove()s each `.sprite`.
    this._shadowSprites.push({ sprite: inst, kind: 'instanced' });
  },

  // Radial soft-alpha blob used by contact shadows. Cached as a CanvasTexture.
  _makeBlobTexture() {
    const S = 128;
    const canvas = document.createElement('canvas');
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.92)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.75, 'rgba(0,0,0,0.18)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(canvas);
    this._textures.push(tex);
    return tex;
  },

  // -- Additive activity glow halos (pseudo-bloom) --------------------------
  // A soft radial cyan billboard Sprite riding on top of each active agent
  // (worker / AGV+tote / forklift). This is a CHEAP approximation of bloom: one
  // shared CanvasTexture + AdditiveBlending makes overlapping active machines
  // "bleed" light, reading like a glow without any post-processing pass (none is
  // vendored). It rides the SAME activity ramp as the existing emissive pulse
  // (worker.glow / agv.glow / forklift.glow), so it appears only while the agent
  // works/moves and fully vanishes when idle. depthWrite:false keeps it from
  // occluding; depthTest stays true so it tucks naturally behind geometry.
  _buildGlowHalos() {
    this._glowSprites = [];
    const tex = this._makeGlowTexture();
    this._glowTex = tex;
    // One SpriteMaterial per sprite (so each can ramp its own opacity), but all
    // share the single additive CanvasTexture above. Tracked for dispose.
    const mkSprite = (size, yLift) => {
      const mat = new THREE.SpriteMaterial({
        map: tex, color: GLOW_CYAN, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      this._materials.push(mat);
      const sp = new THREE.Sprite(mat);
      sp.scale.set(size, size, 1);
      sp.position.y = yLift;
      sp.center.set(0.5, 0.5);
      sp.visible = false; // hidden until activity ramps it up
      this.scene.add(sp);
      return { sprite: sp, mat };
    };
    for (const w of this._workers) {
      const s = mkSprite(2.2, 0.7);
      this._glowSprites.push({ ...s, kind: 'worker', ref: w, base: 2.2 });
    }
    for (const a of this._agvs) {
      const s = mkSprite(2.6, AGV_Y + 0.2);
      this._glowSprites.push({ ...s, kind: 'agv', ref: a, base: 2.6 });
    }
    for (const f of this._forklifts) {
      if (f.glow === undefined) f.glow = 0;
      const s = mkSprite(3.0, 0.9);
      this._glowSprites.push({ ...s, kind: 'forklift', ref: f, base: 3.0 });
    }
  },

  // Radial cyan gradient (transparent core→edge) sized for additive blending.
  // Black edge so AdditiveBlending contributes nothing outside the falloff.
  // Cached as a CanvasTexture, shared by every halo sprite.
  _makeGlowTexture() {
    const S = 128;
    const canvas = document.createElement('canvas');
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0.0, 'rgba(190,245,255,0.95)');
    g.addColorStop(0.35, 'rgba(0,212,240,0.45)');
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(canvas);
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    this._textures.push(tex);
    return tex;
  },

  // -- Pick-event visualization ---------------------------------------------
  // When a worker's keyframe carries a `hit` ({run_id, along, sku, qty}) — the
  // best-effort nearest authored shelf cell it is reaching into (set in
  // render/replay.py) — we (a) PULSE-GLOW a small marker on the target cell and
  // (b) draw a thin connector from the picker's HAND to that cell. This is the
  // "ピッカーが実 SKU ヒット箇所に歩いて取る" money shot. Markers/lines are POOLED
  // (one per worker, reused every frame — no per-frame allocation), reduced-motion
  // aware (no pulse, steady marker), and dropped entirely under fps pressure
  // (tier-3 degrade also disables this via `_glowEnabled`, sharing the halo gate).
  _buildPickFx() {
    // 荷物（ワーク）. The scene's build chain lives in view3d.js (a file this lane
    // must not touch), so the tote builder rides in on the LAST build hook that
    // is already ours. It must run after _buildContactShadows (it reuses that
    // blob texture) and is idempotent, so the ordering is safe either way.
    this._buildTotes();
    this._pickFx = [];
    const n = (this.replay.workers || []).length;
    if (n === 0) return;
    // Shared additive glow texture (reuse the halo's if built, else make one).
    const tex = this._glowTex || this._makeGlowTexture();
    // Pre-resolve which runs are pickable (have rect/along geometry). Without any
    // shelf runs (legacy point racks) we cannot place a target → skip the pool.
    if (!this._shelfRuns || this._shelfRuns.length === 0) return;
    const markerG = new THREE.PlaneGeometry(1, 1);
    this._geometries.push(markerG);
    for (let i = 0; i < n; i++) {
      // Pulse marker: an additive amber billboard quad laid on the cell face.
      const markerMat = new THREE.SpriteMaterial({
        map: tex, color: PICK_GLOW, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      this._materials.push(markerMat);
      const marker = new THREE.Sprite(markerMat);
      marker.scale.set(0.7, 0.7, 1);
      marker.visible = false;
      this.scene.add(marker);
      // Connector line: a 2-point line from hand to cell. BufferGeometry positions
      // are rewritten each active frame (6 floats); cheap and pooled.
      const lineGeom = new THREE.BufferGeometry();
      lineGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      this._geometries.push(lineGeom);
      const lineMat = new THREE.LineBasicMaterial({
        color: PICK_LINE, transparent: true, opacity: 0, depthWrite: false,
      });
      this._materials.push(lineMat);
      const line = new THREE.Line(lineGeom, lineMat);
      line.visible = false;
      line.frustumCulled = false;
      this.scene.add(line);
      this._pickFx.push({ marker, markerMat, line, lineGeom, lineMat, phase: i });
    }
  },

  // Resolve a hit ({run_id, along}) to a world position on the shelf's pick face.
  // Returns a cached scratch Vector3 or null when the run id is unknown. `out` is
  // reused (no allocation). The point sits at a representative reach height and is
  // pushed out to the open (pick) face along the bay's facing normal.
  _hitWorld(hit, out) {
    const runs = this._shelfRuns;
    if (!runs || !hit) return null;
    const r = runs[hit.run_id];
    if (!r) return null;
    const along = Math.max(0, Math.min(1, hit.along || 0)) * r.length;
    const cx = r.x0 + r.ux * along;
    const cz = r.z0 + r.uz * along;
    // Push to the pick face: bay yaw's +Z normal, half the depth out.
    const nx = Math.sin(r.yaw), nz = Math.cos(r.yaw);
    const off = (r.dims.depth || 0.6) * 0.5 + 0.1;
    // Vertical: upper-段 picks carry the real pick-face height in meta.h — lift the
    // marker to it (capped to the rack's overall height). Ground/段1 picks (no h)
    // keep the legacy mid-reach height so they look EXACTLY as before.
    let y;
    if (hit.h !== undefined && hit.h !== null) {
      const cap = (r.dims.h || 2.0) + 0.3;
      y = Math.max(0.2, Math.min(cap, hit.h));
    } else {
      y = Math.min(1.3, (r.dims.h || 2.0) * 0.45); // mid-reach height
    }
    out.set(cx + nx * off, y, cz + nz * off);
    return out;
  },

  // Per-frame per-worker: drive the pick-event marker + connector for a worker's
  // current sample. Hidden unless the worker is picking AND carries a resolvable
  // hit. Pulses the marker opacity/scale (steady under reduced-motion) and points
  // the connector from the worker's REAL hand (the animated forearm tip) to the
  // target cell. Pooled + gated.
  _updatePickEvent(w, s, t) {
    const fx = this._pickFx && this._pickFx[w.idx];
    if (!fx) return;
    const showable = this._glowEnabled && s.state === 'pick' && s.hit;
    if (!showable) {
      if (fx.marker.visible) { fx.marker.visible = false; fx.line.visible = false; }
      return;
    }
    if (!fx._p) fx._p = new THREE.Vector3();
    if (!fx._h) fx._h = new THREE.Vector3();
    const p = this._hitWorld(s.hit, fx._p);
    if (!p) {
      if (fx.marker.visible) { fx.marker.visible = false; fx.line.visible = false; }
      return;
    }
    // Pulse (reduced-motion → steady mid glow). Sine on a per-worker phase so a
    // bank of pickers doesn't blink in unison.
    let pulse = 0.7;
    if (this._beltSpeed !== 0) {
      pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this._clock.elapsedTime * 5 + fx.phase));
    }
    fx.marker.visible = true;
    fx.marker.position.copy(p);
    fx.markerMat.opacity = pulse * 0.9;
    const ms = 0.55 + 0.25 * pulse;
    fx.marker.scale.set(ms, ms, 1);
    // Connector: start at the picker's actual hand. The arm is articulated now,
    // so read the reaching elbow's world position (refreshed for this one agent
    // only, and only while it is picking — negligible cost).
    fx.line.visible = true;
    const hand = w.elbows && w.elbows[1];
    let hx, hy, hz;
    if (hand) {
      hand.updateWorldMatrix(true, false);
      fx._h.set(0, -0.36, 0.02).applyMatrix4(hand.matrixWorld);
      hx = fx._h.x; hy = fx._h.y; hz = fx._h.z;
    } else {
      const wp = w.mesh.position;
      hy = 1.2 + (w.lift || 0);
      hx = wp.x + Math.sin(w.faceYaw) * 0.3;
      hz = wp.z + Math.cos(w.faceYaw) * 0.3;
    }
    const arr = fx.lineGeom.attributes.position.array;
    arr[0] = hx; arr[1] = hy; arr[2] = hz;
    arr[3] = p.x; arr[4] = p.y; arr[5] = p.z;
    fx.lineGeom.attributes.position.needsUpdate = true;
    fx.lineMat.opacity = pulse * 0.55;
  },

  // -- 荷物（ワーク）: the goods, made visible ------------------------------
  // Before this, a replay showed a conveyor whose tread scrolled under workers
  // who teleported their cartons to packing: there was no work ENTITY at all.
  // `replay.totes` is the contract that fixes it, and everything here is
  // ADDITIVE and GUARDED — a replay without `totes` (i.e. every run made before
  // the contract landed) builds nothing and renders exactly as it did.
  //
  // ONE InstancedMesh holds every tote (shared A.gTote geometry — the same box
  // the pickers and AGVs carry — one kraft material, per-instance tone via
  // instanceColor), so the whole shift's worth of goods is TWO draw calls (boxes
  // + their shadow decals) however many boxes there are.
  //
  // A run's `totes` array is the whole SHIFT, but only the handful in flight at
  // the playhead are ever on screen, so _updateTotes COMPACTS: it writes the
  // visible boxes into slots 0…k-1 and sets `.count = k`. That matters — an
  // InstancedMesh submits `count` instances to BOTH the colour and the shadow
  // pass whether or not they are degenerate, so parking the other 1,980 boxes
  // at zero scale would still run ~72k vertex shader invocations per pass for
  // nothing (measured: 9.4 → 6.3 fps on the software rasteriser at N=2000).
  // Compaction makes the cost track what is VISIBLE, not what the run recorded.
  _buildTotes() {
    if (this._totes) return;           // idempotent (see the _buildPickFx hook)
    this._totes = [];
    const totes = (this.replay && this.replay.totes) || [];
    if (!Array.isArray(totes) || totes.length === 0) return;
    const A = this._agentAssets();
    const n = totes.length;
    // Cardboard, not a neon marker: the kraft base is multiplied by the same
    // per-carton tone table the racks use, so a queue of boxes on a belt never
    // reads as one flat extruded strip.
    // WHITE base, kraft folded into the per-instance colour. InstancedMesh
    // multiplies instanceColor by material.color, so a kraft base silently
    // tinted every per-instance colour — fine while they were all near-white
    // carton tones, wrong the moment a tote carries a deliberate mark (a green
    // "sealed" came out olive). Unmarked totes are byte-identical: the product
    // CARTON_BASE × tone is now baked into the tone itself.
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.86, metalness: 0.03,
      emissive: new THREE.Color(0x3a2a18), emissiveIntensity: 0.14,
    });
    this._materials.push(mat);
    const inst = new THREE.InstancedMesh(A.gTote, mat, n);
    inst.frustumCulled = false;        // matrices move every frame
    inst.castShadow = true;
    inst.receiveShadow = false;
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(inst);
    // InstancedMesh.dispose() frees the instance buffers; parking it in the
    // tracked-geometry list means Scene3D.dispose() frees it with everything
    // else (the shared A.gTote geometry is tracked separately and untouched).
    this._geometries.push(inst);
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      // Seed the colour buffer so `instanceColor` exists; _updateTotes rewrites
      // slot colours as boxes are compacted into different slots each frame.
      col.setHex(CARTON_TONES[i % CARTON_TONES.length]).multiply(_kraft);
      inst.setColorAt(i, col);
      const src = totes[i] || {};
      const kfs = Array.isArray(src.keyframes) ? src.keyframes : [];
      this._totes.push({
        id: src.id || `tote${i}`,
        keyframes: kfs,
        t0: kfs.length ? kfs[0][0] : 0,
        t1: kfs.length ? kfs[kfs.length - 1][0] : 0,
        beltId: src.belt_id || '',
        // 段積み: 0=デッキ直置き、1=その上。コンベアの上で容器を2段に積むのは
        // 普通の運用（同じ搬送で倍運ぶ）で、載る高さは容器1個ぶん上がるだけ。
        // 位置(x,z)は下の段と同じなので、キーフレームを2本書けば段積みになる。
        // これは既定値で、キーフレームの5要素目があればそちらが勝つ — 積まれた
        // 荷は途中で降ろされるものだから、段は一生ものではなくその時の状態。
        stack: Math.max(0, Math.round(Number(src.stack) || 0)),
        seed: (i * 0.7548776662) % 1,
        tone: new THREE.Color(CARTON_TONES[i % CARTON_TONES.length]).multiply(_kraft),
        yaw: 0, on: false, idx: i,
      });
    }
    inst.count = 0;                    // nothing in flight until the first update
    if (inst.instanceColor) {
      inst.instanceColor.setUsage(THREE.DynamicDrawUsage);
      inst.instanceColor.needsUpdate = true;
    }
    this._toteInst = inst;

    // Contact-shadow decals, the same cheap grounding cue the agents get — but
    // on a PER-TOTE Y, because a box riding a belt must drop its blob on the
    // BELT (0.21 m) and a box landed at packing onto the BENCH (0.885 m). The
    // agents' shared decal mesh is floor-locked, so totes carry their own.
    const sGeom = new THREE.PlaneGeometry(1, 1);
    sGeom.rotateX(-Math.PI / 2);
    this._geometries.push(sGeom);
    const sMat = new THREE.MeshBasicMaterial({
      map: this._shadowTex || this._makeBlobTexture(), color: 0x000000,
      transparent: true, opacity: 0.34, depthWrite: false, depthTest: true,
    });
    this._materials.push(sMat);
    const shade = new THREE.InstancedMesh(sGeom, sMat, n);
    shade.frustumCulled = false;
    shade.renderOrder = 3;             // over the surface, under the boxes
    shade.castShadow = false;
    shade.receiveShadow = false;
    shade.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    shade.count = 0;
    this.scene.add(shade);
    this._geometries.push(shade);
    this._toteShadow = shade;
  },

  // Tread height of the conveyor segment nearest (x, z), or the historical
  // single-level constant when there is no belt (or none close enough).
  // `beltId` restricts the search to one conveyor, which is how a box that
  // spends part of its life OFF the belt (staged on a floor, waiting) still
  // lands on the right deck once it is on: out of range of its own belt it
  // falls back to the ground-level constant instead of snapping to whichever
  // deck happens to be nearest.
  _deckYAt(x, z, beltId) {
    const decks = this._beltDecks;
    if (!decks || decks.length === 0) return BELT_TOP_Y;
    let bestY = BELT_TOP_Y;
    let bestD = 2.5 * 2.5;             // a box more than 2.5 m off any belt is not on one
    for (const d of decks) {
      if (beltId && d.id !== beltId) continue;
      // Two decks of a multi-level conveyor occupy the SAME plan position, so
      // distance alone cannot choose between them. Without a declared belt, take
      // the LOWEST — a box does not levitate onto an upper deck; something has
      // to put it there, and declaring belt_id is how the scene says so.
      // Squared distance from the point to the segment.
      const vx = d.x1 - d.x0;
      const vz = d.z1 - d.z0;
      const len2 = vx * vx + vz * vz;
      let f = len2 > 0 ? ((x - d.x0) * vx + (z - d.z0) * vz) / len2 : 0;
      f = f < 0 ? 0 : (f > 1 ? 1 : f);
      const dx = x - (d.x0 + vx * f);
      const dz = z - (d.z0 + vz * f);
      const dd = dx * dx + dz * dz;
      if (dd < bestD - 1e-6) { bestD = dd; bestY = d.y; }
      else if (Math.abs(dd - bestD) <= 1e-6 && d.y < bestY) { bestY = d.y; }
    }
    return bestY;
  },

  // Nearest picker to (x, z) within `maxD` metres, or null. Used to hand a
  // `carry` tote to the human who is actually carrying it.
  _nearestWorker(x, z, maxD) {
    let best = null;
    let bestD = maxD * maxD;
    for (const w of this._workers) {
      const p = w.mesh.position;
      const dx = p.x - x, dz = p.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = w; }
    }
    return best;
  },

  // Per-frame: place every tote off its keyframes. Behaviour by state:
  //   carry → handed to the nearest picker (its rig's own tote is revealed and
  //           the standalone box is hidden, so the carton is never double-drawn);
  //           with no picker in reach we draw it at hand height rather than lose
  //           the work entirely (never-blocks).
  //   belt  → rides the belt: sat ON the tread surface, yawed along the
  //           direction of travel, with a subtle bob (frozen under reduced
  //           motion / fps degrade, like every other motion cue here).
  //   pack  → set down on the station bench, then shrunk away over PACK_FADE_S
  //           once its last keyframe passes.
  // Boxes that are in HAND, not yet released, or already shipped simply are not
  // written into the instance buffer at all (see the compaction note on
  // _buildTotes), so the GPU only ever sees the work that is actually in flight.
  // Allocation-free: one cached Matrix4/Quaternion/Euler/Vector3 set, reused.
  // Takes only `t` (like _updateAsrs / _updateStaging): every easing here is a
  // function of the playhead or of the render clock, never of the frame delta.
  _updateTotes(t) {
    const T = this._totes;
    const inst = this._toteInst;
    if (!T || T.length === 0 || !inst) return;
    if (!this._tM) {
      this._tM = new THREE.Matrix4();
      this._tQ = new THREE.Quaternion();
      this._tE = new THREE.Euler();
      this._tP = new THREE.Vector3();
      this._tS = new THREE.Vector3(1, 1, 1);
    }
    const m = this._tM, q = this._tQ, e = this._tE, p = this._tP, sv = this._tS;
    const shade = this._toteShadow;
    const motion = this._beltSpeed !== 0;
    const now = this._clock.elapsedTime;
    let k = 0;                          // next free instance slot (compaction)
    for (let i = 0; i < T.length; i++) {
      const r = T[i];
      const kfs = r.keyframes;
      let show = kfs.length >= 2 && t >= r.t0 && t <= r.t1 + PACK_FADE_S;
      let px = 0, pz = 0, py = 0, surfaceY = 0, scale = 1;
      if (show) {
        const s = sampleKeyframes(kfs, t);
        px = s.x; pz = s.y;
        // Facing: real displacement is the truthful signal; a look-ahead covers
        // the frames where the box is parked or playback is paused.
        let vx = px - (r._px === undefined ? px : r._px);
        let vz = pz - (r._pz === undefined ? pz : r._pz);
        r._px = px; r._pz = pz;
        if (vx * vx + vz * vz < 1e-8) {
          const ahead = sampleKeyframes(kfs, t + 0.4);
          vx = ahead.x - px; vz = ahead.y - pz;
        }
        // A.gTote's long axis is local +X, and a Y-rotation of -atan2(vz, vx)
        // is exactly what maps local +X onto (vx, vz) — the SAME expression
        // scene.js uses to lay a belt segment down, so box and belt agree.
        if (vx * vx + vz * vz > 1e-9) r.yaw = -Math.atan2(vz, vx);
        // Split "<place>:<mark>" once; `place` drives geometry, `mark` colour.
        const raw = typeof s.state === 'string' ? s.state : '';
        const ci = raw.indexOf(':');
        const place = ci < 0 ? raw : raw.slice(0, ci);
        const mark = ci < 0 ? '' : raw.slice(ci + 1);
        r.mark = TOTE_MARK_COLOR[mark];
        // 段はキーフレームの5要素目（sampleKeyframes は `hit` として返す）。
        // 状態と同じで補間しない — 0.5段に載っている箱は無い。
        const lvl = (s.hit === null || s.hit === undefined)
          ? r.stack : Math.max(0, Math.round(Number(s.hit) || 0));
        if (place === 'carry') {
          const w = this._nearestWorker(px, pz, CARRY_SNAP_M);
          if (w) {
            if (w.tote) w.tote.visible = true;   // it's in HIS hands, not ours
            show = false;
          }
          surfaceY = 0;
          py = CARRY_Y;
        } else if (place === 'pack') {
          surfaceY = STATION_TOP_Y;
          py = STATION_TOP_Y + TOTE_H / 2 + lvl * TOTE_H;
        } else {                                  // 'belt' + any unknown state
          // Ride the deck of the belt actually underfoot, not a global constant:
          // with multi-level conveyors a fixed height puts the upper deck's
          // boxes inside the lower deck.
          surfaceY = this._deckYAt(px, pz, r.beltId);
          py = surfaceY + TOTE_H / 2 + lvl * TOTE_H;
          if (motion) py += 0.014 * Math.sin(now * 7.5 + r.seed * TWO_PI);
        }
        if (t > r.t1) {
          scale = 1 - _clamp((t - r.t1) / PACK_FADE_S, 0, 1);
          py -= (1 - scale) * 0.08;              // settles as it goes
        }
        if (scale <= 0.02) show = false;
      }
      if (!show) { r.on = false; continue; }
      e.set(0, r.yaw, 0);
      q.setFromEuler(e);
      p.set(px, py, pz);
      sv.set(scale, scale, scale);
      m.compose(p, q, sv);
      inst.setMatrixAt(k, m);
      // A marked tote overrides its carton tone (see TOTE_MARK_COLOR).
      if (r.mark !== undefined) {
        if (!r._markC) r._markC = new THREE.Color();
        inst.setColorAt(k, r._markC.setHex(r.mark));
      } else {
        inst.setColorAt(k, r.tone);     // slot ↔ box changes frame to frame
      }
      r.on = true;
      if (shade) {
        const sk = 0.66 * scale;
        m.makeScale(sk, 1, sk);
        m.setPosition(px, surfaceY + 0.012, pz);
        shade.setMatrixAt(k, m);
      }
      k++;
    }
    inst.count = k;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    if (shade) {
      shade.count = k;
      shade.instanceMatrix.needsUpdate = true;
    }
  },

  // Per-frame: scroll each conveyor belt's tread texture by delta * speed.
  // _beltSpeed gates it globally (0 under reduced-motion or fps auto-degrade).
  //
  // DIRECTION (this used to be backwards). three samples `uv * repeat + offset`,
  // so RAISING offset.x slides the pattern toward -u; and the belt box's local
  // +X — which is its u axis — points DOWNSTREAM (scene.js lays each segment
  // out p0→p1 with rotation.y = -atan2(dz, dx)). The old `+=` therefore ran the
  // cleats UPSTREAM: fine while the belt was empty, but now that real totes ride
  // it, a belt flowing against its own boxes is worse than no animation at all.
  // Subtracting makes the tread and the work travel the same way.
  _updateBelts(dt) {
    if (this._belts.length === 0 || this._beltSpeed === 0) return;
    const d = dt * this._beltSpeed;
    for (const b of this._belts) {
      const m = b.mat.map;
      if (!m) continue;
      const o = m.offset.x - d * b.speed * 0.5;
      m.offset.x = o - Math.floor(o);   // wrap into [0,1) (JS % keeps the sign)
    }
  },

  // Per-frame: follow each agent and ramp halo opacity/scale off the SAME glow
  // value used by the emissive pulse, so the two read as one effect. No `new`
  // per frame; sprites/material/texture are reused. Gated by fps auto-degrade.
  _updateGlowHalos() {
    if (!this._glowSprites || this._glowSprites.length === 0) return;
    if (!this._glowEnabled) return;
    for (const h of this._glowSprites) {
      const ref = h.ref;
      const g = ref.glow || 0;
      const sp = h.sprite;
      if (g <= 0.01) { if (sp.visible) sp.visible = false; continue; }
      sp.visible = true;
      const p = (h.kind === 'forklift') ? ref.group.position : ref.mesh.position;
      sp.position.x = p.x;
      sp.position.z = p.z;
      h.mat.opacity = Math.pow(g, 0.7) * 0.75;
      let breath = 0;
      if (this._beltSpeed !== 0) {
        breath = Math.sin(this._clock.elapsedTime * 2.4 + h.base) * 0.05 * g;
      }
      const s = h.base * (0.85 + 0.25 * g + breath);
      sp.scale.set(s, s, 1);
    }
  },

  // Per-frame: rewrite the contact-shadow instance matrices so every blob tracks
  // its agent. One InstancedMesh → one buffer upload, no per-agent draw call.
  // A raised order-picker deck spreads + softens its blob (bigger, lower contrast
  // by area), which is what a real diffuse shadow does as the caster lifts.
  _updateContactShadows() {
    const inst = this._shadowInst;
    if (!inst || !this._shadowRefs) return;
    if (!this._shMat) { this._shMat = new THREE.Matrix4(); this._shPos = new THREE.Vector3(); }
    const m = this._shMat;
    const refs = this._shadowRefs;
    for (let i = 0; i < refs.length; i++) {
      const s = refs[i];
      const ref = s.ref;
      const p = (s.kind === 'forklift') ? ref.group.position : ref.mesh.position;
      // Lift spreads the blob; carried loads widen the forklift's.
      let k = s.size;
      if (s.kind === 'worker') k *= 1 + (ref.lift || 0) * 0.28;
      else if (s.kind === 'forklift') k *= 1 + (ref.lift || 0) * 0.10;
      m.makeScale(k, 1, k * (s.kind === 'forklift' ? 1.25 : 1));
      m.setPosition(p.x, 0.035, p.z);
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
  },

  // Per-frame: interpolate + ANIMATE each worker. Position/state/glow/vest colour
  // and the pick-event viz are as before; the new part is the rig:
  //   • locomotion phase advanced by real ground covered (no foot-sliding),
  //   • a gait blend so idle↔walk eases instead of popping,
  //   • counter-swinging arms, knee flex, torso bob/lean/twist, roll into turns,
  //   • an idle stance with a slow breathing/weight-shift,
  //   • a reach pose aimed at the ACTUAL pick height (meta.h) on pick frames.
  _updateWorkers(t, dt) {
    const glowOn = this._beltSpeed !== 0; // reduced-motion → hold glow steady-off
    const now = this._clock.elapsedTime;
    for (const w of this._workers) {
      const s = sampleKeyframes(w.keyframes, t);
      w.mesh.position.set(s.x, 0, s.y); // group anchored at floor (legs reach down)

      // --- state colour + activity glow -------------------------------------
      const color = STATE_COLOR[s.state] !== undefined ? STATE_COLOR[s.state] : STATE_COLOR.idle;
      if (!w._target) w._target = new THREE.Color();
      w._target.set(color);
      w.vestMat.color.lerp(w._target, 1 - Math.exp(-dt * 12));
      const active = (glowOn && ACTIVE_WORKER[s.state]) ? 1 : 0;
      w.glow = approach(w.glow, active, dt, 4);
      w.vestMat.emissiveIntensity = w.glow * 0.30;

      // --- motion: real displacement drives speed + walk phase ---------------
      _stepMotion(w, s.x, s.y, dt);
      // Face the direction of travel. Real displacement is the truthful signal;
      // a look-ahead sample covers the frames where playback is paused/slow.
      let vx = w._vx, vz = w._vz;
      if (vx * vx + vz * vz < 1e-8) {
        const ahead = sampleKeyframes(w.keyframes, t + 0.3);
        vx = ahead.x - s.x; vz = ahead.y - s.y;
      }
      if (vx * vx + vz * vz > 1e-7) w.faceYaw = Math.atan2(vx, vz);
      if (!w._qT) { w._qT = new THREE.Quaternion(); w._eT = new THREE.Euler(); }
      w._eT.set(0, w.faceYaw, 0);
      w._qT.setFromEuler(w._eT);
      w.mesh.quaternion.slerp(w._qT, 1 - Math.exp(-dt * 9));

      // Lean INTO the turn: yaw rate × speed, smoothed so it never snaps. The
      // figure faces +Z with +X to its right, so a positive yaw rate is a turn to
      // the right and must roll the torso toward +X ⇒ a NEGATIVE z-rotation.
      const dyaw = _angDelta(w.faceYaw, w._yawPrev === undefined ? w.faceYaw : w._yawPrev);
      w._yawPrev = w.faceYaw;
      const turn = dt > 0 ? _clamp(-(dyaw / dt) * Math.min(w.speed, 2) * 0.05, -0.20, 0.20) : 0;
      w.roll = approach(w.roll, turn, dt, 6);

      // --- gait blend (0 = standing, 1 = full stride) ------------------------
      const wantGait = (s.state === 'pick' || s.state === 'pack') ? 0
        : _smooth(w.speed / WALK_SPEED_FULL);
      w.gait = approach(w.gait, wantGait, dt, 7);
      const gait = w.gait;

      // --- reach / carry poses ----------------------------------------------
      w.reach = approach(w.reach, (s.state === 'pick') ? 1 : 0, dt, 6);
      w.carry = approach(w.carry, (s.state === 'carry' || s.state === 'pack') ? 1 : 0, dt, 5);

      // --- vertical pick motion (upper 段) -----------------------------------
      // The 5th keyframe element merges the engine's level meta {lv, by, h} with
      // the derived cell {run_id, along, …}. lv>1 means the SKU sits on an upper
      // level; how we reach it depends on `by`:
      //   manual   → the ARM extends up toward h (reach/ladder), figure grounded
      //   forklift → RAISE the whole figure on an order-picker deck up to h
      //   crane    → AS/RS: the marker does the work, the figure barely moves
      const meta = s.hit;
      const upper = !!(meta && meta.lv > 1 && meta.h);
      const by = upper ? (meta.by || 'manual') : null;
      const env = upper ? _dwellEnv(w.keyframes, t) : 0; // 0→1→0 across the dwell
      const liftH = (by === 'forklift') ? Math.max(0, meta.h - 1.2) * env : 0;
      w.lift = approach(w.lift, liftH, dt, 6);
      w.lifter.position.y = w.lift;

      // --- the rig ------------------------------------------------------------
      const p = w.phase;
      const cosP = Math.cos(p), sinP = Math.sin(p);
      // Legs. Contact (leg forward, knee straight) at p = 0; toe-off at p = π.
      // Forward swing is a NEGATIVE hip rotation (the figure faces +Z).
      const thighA = 0.52 * gait;   // ±30° hip swing = a brisk warehouse walk
      const kneeA = 1.10 * gait;
      const hipR = w.hips[1], hipL = w.hips[0];
      hipR.rotation.x = -thighA * cosP;
      hipL.rotation.x = thighA * cosP;
      // Knees only fold backwards. `max(0, -sin(p + 0.35))` is exactly the SWING
      // half of the cycle (p≈π→2π, peaking mid-swing) and is 0 at heel strike, so
      // the leg is straight when it lands; the small sin(p) term is the stance
      // flex that keeps the body from looking stilted.
      w.knees[1].rotation.x = kneeA * Math.max(0, -Math.sin(p + 0.35))
        + 0.06 + 0.10 * gait * Math.max(0, sinP);
      w.knees[0].rotation.x = kneeA * Math.max(0, -Math.sin(p + Math.PI + 0.35))
        + 0.06 + 0.10 * gait * Math.max(0, -sinP);

      // Torso: 2 rises per cycle (highest at each mid-stance, so the planted foot
      // never punches through the floor) + a slow breath while standing.
      const breath = Math.sin(now * 1.15 + w.seed * 6.28);
      w.body.position.y = 0.028 * gait * (0.5 - 0.5 * Math.cos(2 * p))
        + 0.007 * (1 - gait) * breath;
      // Lean forward with speed, and dip further while reaching low.
      const reachTargetY = (meta && meta.h) ? meta.h : 1.05;
      const lowReach = _clamp((1.15 - reachTargetY) / 0.9, 0, 1); // 1 = floor level
      const wantLean = 0.10 * gait * _clamp(w.speed / 1.4, 0, 1)
        + w.reach * (0.10 + 0.30 * lowReach)
        + (1 - gait) * (1 - w.reach) * 0.012 * breath;
      w.lean = approach(w.lean, wantLean, dt, 8);
      w.spine.rotation.x = w.lean;
      w.spine.rotation.z = w.roll + (1 - gait) * 0.022 * Math.sin(now * 0.37 + w.seed * 5);
      w.spine.rotation.y = 0.10 * gait * cosP; // shoulders counter-rotate to the hips

      // Arms: counter-swing to the same-side leg, blended with the reach/carry.
      const armA = 0.46 * gait;
      const swingR = armA * cosP;
      const swingL = -armA * cosP;
      const elbowBase = 0.30 + 0.22 * gait * (0.5 + 0.5 * cosP);
      // Reach: aim the right arm at the real pick-face height. Hand offset is
      // (forward 0.52 m, dy = target − shoulder world height); the shoulder pitch
      // that points a downward-hanging arm at (dy, d) is atan2(−d, −dy).
      const shoulderWorldY = HIP_Y + SHOULDER_SY + w.lift;
      const dy = _clamp(reachTargetY - shoulderWorldY, -1.15, 1.15);
      const reachPitch = Math.atan2(-0.52, -dy);
      // Carry: both forearms up, holding the tote against the chest.
      const carryShoulder = -0.75, carryElbow = -1.05;
      const rw = w.reach, cw2 = w.carry * (1 - w.reach);
      const base = 1 - rw - cw2;
      w.shoulders[1].rotation.x = base * swingR + rw * reachPitch + cw2 * carryShoulder;
      w.shoulders[0].rotation.x = base * swingL + rw * (swingL * 0.3 - 0.15) + cw2 * carryShoulder;
      w.elbows[1].rotation.x = base * -elbowBase + rw * -0.10 + cw2 * carryElbow;
      w.elbows[0].rotation.x = base * -elbowBase + rw * -elbowBase * 0.6 + cw2 * carryElbow;
      // Manual upper-段 picks: swing a little wider so an overhead reach reads.
      if (by === 'manual' && env > 0) {
        w.shoulders[1].rotation.x -= 0.25 * env * rw;
      }

      // Held items: a carton appears in the hand at the top of a reach; the tote
      // is held against the chest while hauling/packing.
      if (w.carton) w.carton.visible = w.reach > 0.55;
      if (w.tote) w.tote.visible = w.carry > 0.35;

      // Order-picker platform: show the deck + telescoping mast only while the
      // forklift lift is meaningfully raised; ride the deck up with the worker and
      // scale the mast to the current height. Hidden (deck gone) otherwise.
      if (w.platform) {
        const show = (by === 'forklift') && w.lift > 0.05;
        if (w.platform.visible !== show) w.platform.visible = show;
        if (show) {
          w.platDeck.position.y = 0.03 + w.lift;
          const my = Math.max(0.1, w.lift + 0.05);
          w.platMast.scale.y = my;          // box base height is 1.0 m → scale = metres
          w.platMast.position.y = my / 2;   // grow from the floor up
        }
      }

      // Pick-event viz: pulse the reached cell + draw a connector from the hand.
      this._updatePickEvent(w, s, t);
    }
    // 荷物（ワーク）. Runs AFTER the worker loop (and from inside it) for two
    // reasons: the per-frame update chain lives in view3d.js, which this lane
    // must not touch, and a `carry` tote overrides the picker's tote visibility
    // — which only sticks if the worker loop has already had its say. No-ops
    // (and allocates nothing) when the replay carries no `totes`.
    this._updateTotes(t);
  },

  // Per-frame: interpolate each AGV's position + action colour, ramp its cyan
  // working-glow, roll its wheels by real distance, bob/pitch it on its
  // suspension, pulse the light skirt + direction bar, and show the carried tote.
  _updateAgvs(t, dt) {
    const now = this._clock.elapsedTime;
    const motion = this._beltSpeed !== 0;
    for (const a of this._agvs) {
      const s = sampleKeyframes(a.keyframes, t);
      const dist = _stepMotion(a, s.x, s.y, dt);

      // Face travel (AMRs drive nose-first). Hold the last yaw when stopped.
      let vx = a._vx, vz = a._vz;
      if (vx * vx + vz * vz < 1e-8) {
        const ahead = sampleKeyframes(a.keyframes, t + 0.3);
        vx = ahead.x - s.x; vz = ahead.y - s.y;
      }
      if (vx * vx + vz * vz > 1e-7) a.yaw = Math.atan2(vx, vz);

      // Suspension: a small bob while rolling + a pitch that leans into
      // acceleration (nose down on the go, nose up on the stop).
      const accel = dt > 0 ? (a.speed - (a._sPrev || 0)) / dt : 0;
      a._sPrev = a.speed;
      const bobT = motion ? 0.012 * Math.sin(now * 9 + a.seed * 6.28) * Math.min(1, a.speed) : 0;
      a.bob = approach(a.bob, bobT, dt, 12);
      a.pitch = approach(a.pitch, _clamp(-accel * 0.012, -0.05, 0.05), dt, 8);
      a.mesh.position.set(s.x, AGV_Y + a.bob, s.y);
      // 'YXZ' = heading then pitch, so the suspension tilt happens about the
      // robot's OWN lateral axis whatever direction it is driving in.
      if (!a._qT) { a._qT = new THREE.Quaternion(); a._eT = new THREE.Euler(0, 0, 0, 'YXZ'); }
      a._eT.set(a.pitch, a.yaw, 0, 'YXZ');
      a._qT.setFromEuler(a._eT);
      a.mesh.quaternion.slerp(a._qT, 1 - Math.exp(-dt * 9));

      // Wheels roll exactly as far as the robot moved.
      if (a.wheels) {
        const spin = dist / AGV_WHEEL_R;
        for (const w of a.wheels) w.rotation.x -= spin;
      }

      // Action colour on the chassis AND the whole light signature.
      const color = AGV_COLOR[s.state] !== undefined ? AGV_COLOR[s.state] : AGV_COLOR.idle;
      if (!a._target) a._target = new THREE.Color();
      a._target.set(color);
      const k = 1 - Math.exp(-dt * 12);
      a.mesh.material.color.lerp(a._target, k);
      const activeState = ACTIVE_AGV[s.state] ? 1 : 0;
      a.glow = approach(a.glow, (motion ? activeState : 0), dt, 4);
      a.mat.emissiveIntensity = a.glow * 0.45;
      if (a.ledMat) {
        a.ledMat.color.lerp(a._target, k);
        a.ledMat.emissive.copy(a.ledMat.color);
        // Working robots breathe their light band; idle ones sit at a dim steady.
        const pulse = motion ? (0.5 + 0.5 * Math.sin(now * 3.2 + a.seed * 6.28)) : 0.5;
        a.ledMat.emissiveIntensity = 0.35 + a.glow * (0.55 + 0.45 * pulse);
      }
      if (a.tote) {
        a.tote.visible = !!CARRY_AGV[s.state];
        // Keep the carried tote reading as CARDBOARD — a full glow ramp on it
        // washes the box out to the same cyan as the robot it rides on.
        a.tote.material.emissiveIntensity = a.glow * 0.18;
        // Load settles on its own tiny spring as the robot starts/stops.
        a.tote.position.y = this._aa.agvBase + 0.61 + a.bob * 0.4;
      }
    }
  },

  // Per-frame: drive each moving forklift — position + travel yaw, wheels rolling
  // at the real ground speed with the rear pair STEERING into the turn, a mast
  // that tilts with acceleration, a fork carriage that rides up (to the keyframe's
  // pick height when one is carried), a pallet load that appears on the forks, a
  // blinking amber beacon, and reverse lamps when it backs up.
  _updateForklifts(t, dt) {
    const motion = this._beltSpeed !== 0;
    const now = this._clock.elapsedTime;
    for (const f of this._forklifts) {
      const s = sampleKeyframes(f.keyframes, t);
      f.group.position.set(s.x, 0, s.y);
      const dist = _stepMotion(f, s.x, s.y, dt);

      // Travel direction: prefer real displacement, else a look-ahead/behind.
      let vx = f._vx, vz = f._vz;
      if (vx * vx + vz * vz < 1e-8) {
        const ahead = sampleKeyframes(f.keyframes, t + 0.25);
        vx = ahead.x - s.x; vz = ahead.y - s.y;
        if (vx * vx + vz * vz < 1e-8) {
          const behind = sampleKeyframes(f.keyframes, t - 0.25);
          vx = s.x - behind.x; vz = s.y - behind.y;
        }
      }
      const moving = vx * vx + vz * vz > 1e-7;
      if (moving) {
        // A real forklift does not pirouette to leave a rack face — it BACKS OUT
        // and only then swings round. So when the travel direction flips more
        // than ~115° away from where the truck is pointing, hold the facing (=
        // reverse) and let the yaw creep round over about a second.
        const dirYaw = Math.atan2(vx, vz);
        const diff = _angDelta(dirYaw, f.yaw);
        if (Math.abs(diff) > 2.0) {
          f.yaw += diff * Math.min(1, dt * 0.8);
          f.reverse = true;
        } else {
          f.yaw = dirYaw;
          f.reverse = false;
        }
      }
      if (!f._qTarget) { f._qTarget = new THREE.Quaternion(); f._eTarget = new THREE.Euler(); }
      f._eTarget.set(0, f.yaw, 0);
      f._qTarget.setFromEuler(f._eTarget);
      f.group.quaternion.slerp(f._qTarget, 1 - Math.exp(-dt * 7));

      // Wheels roll by the real ground distance (backwards while reversing); the
      // rear pair steers into the turn — a counterbalance truck steers from the
      // back, and that rear swing is its signature move.
      const dirSign = f.reverse ? -1 : 1;
      const spin = (dist / FK_WHEEL_R) * dirSign;
      if (f.wheelsF) for (const w of f.wheelsF) w.rotation.x -= spin;
      if (f.wheelsR) for (const w of f.wheelsR) w.rotation.x -= (dist / 0.19) * dirSign;
      const dyaw = _angDelta(f.yaw, f._yawPrev === undefined ? f.yaw : f._yawPrev);
      f._yawPrev = f.yaw;
      const wantSteer = dt > 0 ? _clamp(-(dyaw / dt) * 0.55, -0.85, 0.85) : 0;
      f.steerAng = approach(f.steerAng, wantSteer, dt, 5);
      if (f.steerPivots) for (const p of f.steerPivots) p.rotation.y = f.steerAng;
      if (f.steer) f.steer.rotation.z = -f.steerAng * 2.2; // driver's wheel follows

      // Mast tilt: back under acceleration, forward as it sets a load down.
      const accel = dt > 0 ? (f.speed - (f._sPrev || 0)) / dt : 0;
      f._sPrev = f.speed;
      const wantTilt = _clamp(-0.05 - accel * 0.02, -0.14, 0.02);
      f.tilt = approach(f.tilt, wantTilt, dt, 6);
      if (f.mast) f.mast.rotation.x = f.tilt;
      if (f.driver) f.driver.rotation.x = -f.tilt * 0.35; // driver braces against it

      // Activity halo ramp (forklifts have no emissive body ramp of their own).
      f.glow = approach(f.glow || 0, (motion && moving) ? 1 : 0, dt, 4);

      // Fork height. A keyframe that carries a pick-height meta wins (that IS the
      // level it is servicing); otherwise the carry state raises it to travel
      // height. Both ease, so the forks glide rather than snap.
      const meta = s.hit;
      let wantLift;
      if (meta && meta.h) {
        wantLift = _clamp(meta.h, 0.06, 5.0) * _dwellEnv(f.keyframes, t);
      } else {
        const carrying = (CARRY_AGV[s.state] || s.state === 'carry'
          || s.state === 'putaway' || s.state === 'replen') ? 1 : 0;
        wantLift = carrying * 0.95;
      }
      f.lift = approach(f.lift || 0, wantLift, dt, 3.5);
      if (f.carriage) f.carriage.position.y = 0.06 + f.lift;
      const showLoad = f.lift > 0.12;
      if (f.load) f.load.visible = showLoad;
      if (f.pallet) f.pallet.visible = showLoad;

      // Beacon: an amber rotating lamp — sweeps round and pulses. Reverse lamps
      // light when the truck is travelling backwards relative to its facing.
      if (f.beaconMat) {
        const on = motion ? (0.35 + 0.65 * Math.abs(Math.sin(now * 4.5 + f.seed * 6.28))) : 0.5;
        f.beaconMat.emissiveIntensity = 0.25 + on * (0.5 + 0.9 * f.glow);
        if (f.beacon && motion) f.beacon.rotation.y = now * 5.0;
      }
      if (f.lampMat) {
        // Reverse lamps: on (and blinking, like the reversing alarm) exactly
        // while the truck is backing up.
        const blink = motion ? (Math.sin(now * 9) > 0 ? 1 : 0.15) : 1;
        f.revLamp = approach(f.revLamp || 0, (moving && f.reverse) ? blink : 0, dt, 14);
        f.lampMat.emissiveIntensity = f.revLamp * 1.6;
      }
    }
  },

  // AS/RS stacker crane: glide the mast back and forth along the AS/RS run and
  // raise/lower its shuttle, so the automated aisle reads as alive. Purely a
  // cosmetic patrol (no DES data drives it); frozen under reduced-motion.
  _updateAsrs(t) {
    const c = this._asrsCrane;
    if (!c) return;
    if (this._beltSpeed === 0) return; // reduced-motion / degrade → hold position
    const f = 0.5 + 0.5 * Math.sin(this._clock.elapsedTime * 0.4);
    c.group.position.x = c.ax + (c.bx - c.ax) * f;
    c.group.position.z = c.az + (c.bz - c.az) * f;
    // Shuttle bobs up/down the mast on a slower cycle.
    const lift = 0.5 + 0.5 * Math.sin(this._clock.elapsedTime * 0.7 + 1.0);
    c.shuttle.position.y = c.H * (0.15 + 0.7 * lift);
  },

  // 仮置き(staging) buffer: a box whose height + colour track its WIP over time
  // (green/low → red/full). Packers themselves ride in `workers` so they animate
  // with the standard worker sampler; this is the buffer they drain.
  _updateStaging(t) {
    const sg = this._staging;
    if (!sg) return;
    let wip = 0;
    const tl = sg.timeline;
    for (let i = 0; i < tl.length; i++) { if (tl[i][0] <= t) wip = tl[i][1]; else break; }
    const util = Math.min(1, wip / Math.max(sg.capacity, 1));
    const hgt = 0.2 + util * 2.2;
    sg.mesh.scale.y = hgt;
    sg.mesh.position.y = hgt / 2;
    // green→red by hue, and brighten lightness as it fills so a near-full buffer
    // reads as a clearer urgency cue (dim when empty, hot when backed up).
    sg.mesh.material.color.setHSL((1 - util) * 0.33, 0.85, 0.40 + util * 0.15);
  },
};
