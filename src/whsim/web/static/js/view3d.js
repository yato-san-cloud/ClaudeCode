// view3d.js — three.js 3D replay view of a warehouse simulation (whsim WS3).
//
// Coordinate mapping: replay positions are METERS on a floor.
//   floor (px, py) -> THREE position (px, 0, py)   (three.js y is UP, py is depth)
//
// Build static geometry once from `replay`, then run a rAF loop that reads
// getTime() and interpolates worker positions/states via keyframes.
import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/controls/OrbitControls.js';
// Shared 2D/3D rack swatch palette (CSS strings) — single source of truth so the
// 3D legend can't drift from the 2D editor/replay or whsim.racktypes.
import { RACK_COLOR } from './constants.js';

// Worker state -> color.
const STATE_COLOR = {
  idle:   0x9e9e9e,
  travel: 0x1f78b4,
  carry:  0x6a3d9a,
  pick:   0x33a02c,
  pack:   0xe31a1c,
  inspect: 0xffb300,
};
// Rack ABC class -> color.
const ABC_COLOR = { A: 0xd7301f, B: 0xfc8d59, C: 0xfdcc8a };
// AGV action -> color.
const AGV_COLOR = {
  idle:    0x9e9e9e,
  travel:  0x1f78b4,
  pickup:  0x33a02c,
  dropoff: 0xf57f17,
  charge:  0x8e24aa,
};
// Height (m) at which AGV boxes ride, centered on their thin body.
const AGV_Y = 0.2;

// --- Storage-equipment dimensions, mirrored from src/whsim/racktypes.py -------
// One source of truth lives in Python (RACK_TYPES); this is its JS twin so the
// 3D bay/depth/level numbers match the materialised location grid + the 2D PNG.
// `bay`/`depth` are metres (one storage position); `levels` is the shelf count;
// `h` is the realistic *overall rack height* in metres (NOT in racktypes.py —
// added here because the engine only needs footprint, but the 3D needs height).
// This is what FIXES the user's #1 complaint: racks are now 2.0–5.6–16 m tall,
// taller than the 1.7 m human picker, so nothing "突き抜け"s anymore.
const RACK_DIMS = {
  light:     { bay: 0.9, depth: 0.45, levels: 5, h: 2.0 },   // 軽量棚
  medium:    { bay: 1.2, depth: 0.60, levels: 4, h: 2.4 },   // 中量棚
  pallet:    { bay: 1.1, depth: 1.10, levels: 4, h: 5.6 },   // パレットラック
  nestainer: { bay: 1.1, depth: 1.40, levels: 3, h: 3.6 },   // ネステナー段積み
  flow:      { bay: 1.0, depth: 1.50, levels: 3, h: 2.6 },   // フローラック
  asrs:      { bay: 0.8, depth: 1.20, levels: 12, h: 16.0 }, // 自動倉庫(AS/RS)
};
const RACK_DEFAULT = 'medium';
function rackDims(rt) { return RACK_DIMS[rt] || RACK_DIMS[RACK_DEFAULT]; }

// Legend metadata for the on-screen 3D guide: Japanese label + a swatch colour
// matching the 2D editor/replay (RACK_COLOR in app.js) so the same rack reads as
// the same colour across 2D and 3D. Display-only; never feeds geometry.
const RACK_LEGEND = {
  light:     { label: '軽量棚', sw: RACK_COLOR.light },
  medium:    { label: '中量棚', sw: RACK_COLOR.medium },
  pallet:    { label: 'パレットラック', sw: RACK_COLOR.pallet },
  nestainer: { label: 'ネステナー', sw: RACK_COLOR.nestainer },
  flow:      { label: 'フローラック', sw: RACK_COLOR.flow },
  asrs:      { label: '自動倉庫(AS/RS)', sw: RACK_COLOR.asrs },
};

// Steel / accent colours shared by the realistic rack builders.
const RACK_STEEL = 0x3b434d;     // upright frames / neutral structure
const RACK_BEAM = 0xff7a1a;      // pallet-rack load beams (signature orange)
const RACK_BOARD = 0x6b727b;     // shelf boards (light/medium)
const PALLET_WOOD = 0xb08247;    // wooden pallet base under pallet loads
const ROLLER_COLOR = 0x9aa3ad;   // flow-rack inclined roller lanes
const ASRS_FRAME = 0x8d949c;     // AS/RS tower frame
const ASRS_CRANE = 0xf0c020;     // AS/RS stacker-crane mast (hi-vis yellow)

// Pick-event highlight: target cell pulse + connector colour.
const PICK_GLOW = 0xffe14d;      // warm amber pulse on the reached cell
const PICK_LINE = 0xffe14d;

// Cyan accent used for the "active machine glow" (WITNESS-beating chrome).
const GLOW_CYAN = 0x00d4f0;
// Agent states that read as "working/moving" → glow ramps up; others decay.
const ACTIVE_WORKER = { travel: 1, carry: 1, pick: 1, pack: 1, inspect: 1 };
const ACTIVE_AGV = { travel: 1, pickup: 1, dropoff: 1 };
// States in which an AGV/forklift is hauling a load → show its tote box.
const CARRY_AGV = { pickup: 1, dropoff: 1, travel: 1 };

// Render / art presets. Each tweaks background, fog, light intensities/colors
// and tone-mapping exposure ONLY — never static geometry. See setPreset().
// `shadow`: enable hard cast shadows for this preset; `shadowOpacity` controls
// how dark the contact shadow reads (lower = softer/lighter).
const PRESETS = {
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
const FLOOR_TONES = {
  brand:   { floor: 0x141b26, gridA: 0x2a3a52, gridB: 0x1c2636 },
  natural: { floor: 0xeef1f5, gridA: 0xb0b8c0, gridB: 0xc8cfd6 },
  evening: { floor: 0x241d2e, gridA: 0x46384f, gridB: 0x33293c },
  night:   { floor: 0x0c1426, gridA: 0x24365a, gridB: 0x162540 },
  mono:    { floor: 0xdfe4ea, gridA: 0xb0b8c0, gridB: 0xc8cfd6 },
};

const ROUTE_COLOR = { forklift: 0xff7a00, person: 0x00b8d4 };

// Equipment type -> base color (placed/static equipment models).
const EQUIP_COLOR = {
  agv:       0x3949ab,
  forklift:  0xf57c00,
  asrs:      0x8d949c,
  robot_arm: 0x9aa3ad,
  crane:     0x424a52,
};

// Sample [t, x, y, state, hit?] from a worker's sorted keyframe array (see spec).
// A keyframe may carry an optional 5th element `hit` ({run_id, along, sku, qty})
// on `pick` frames; we surface the active frame's hit so the caller can drive the
// pick-event viz. Backward-compatible: 4-tuple frames simply have `hit === null`.
function sampleKeyframes(keyframes, t) {
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

export class Scene3D {
  constructor(container, replay, getTime) {
    this.container = container;
    this.replay = replay || {};
    this.getTime = typeof getTime === 'function' ? getTime : () => 0;
    this._disposed = false;
    this._geometries = [];
    this._materials = [];
    this._workers = []; // { mesh, keyframes }
    this._agvs = [];    // { mesh, keyframes }
    this._forklifts = []; // { group, keyframes, prevX, prevZ }
    this._staffMeshes = []; // timetable staffing spheres (per-zone, per current time)
    this._staffMats = [];   // their materials (disposed/rebuilt on each setStaffing)
    this._staffGeom = null;
    this._rackMaterials = []; // rack mats (preset tweaks their emissiveIntensity)
    this._textures = []; // CanvasTextures to dispose
    this._shadowSprites = []; // { sprite, follow } soft blob shadows under agents
    this._glowSprites = [];   // { sprite, mat, kind, ref, base } additive activity halos
    this._glowEnabled = true; // gated off by fps auto-degrade (tier 3)
    this._heat = null;        // { mesh, mat } instanced congestion patches
    this._hud = null;         // DOM overlay { root, ... } or null
    this._info = null;        // controls-hint + legend DOM overlay or null
    this._intro = null;       // intro camera tween state or null
    this._preset = 'brand';
    this._belts = [];         // animated conveyor belt mats { mat, speed }
    this._beltSpeed = 1;      // global multiplier (0 = static, e.g. reduced-motion)
    this._fps = null;         // fps monitor / auto-degrade state or null
    this._clock = new THREE.Clock(); // delta-time source for belt flow

    const meta = this.replay.meta || {};
    const bounds = meta.bounds || { width: 20, depth: 20 };
    this.bounds = { width: bounds.width || 20, depth: bounds.depth || 20 };

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);

    // Renderer.
    this.renderer = new THREE.WebGLRenderer({
      antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    // Modern color handling: sRGB output + soft filmic tone mapping.
    if ('outputColorSpace' in this.renderer) {
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    }
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    // Soft, proposal-grade contact shadows. Map size capped for performance.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // Scene + camera.
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f141d);
    // Gentle distance fog keeps the far edge of large floors soft. The actual
    // colors/exposure are set by applyPreset(); near/far distances are fixed.
    const fogStart = Math.max(this.bounds.width, this.bounds.depth) * 2.0;
    this.scene.fog = new THREE.Fog(0x121a26, fogStart, fogStart * 2.5);

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 5000);
    const cx = this.bounds.width / 2;
    const cz = this.bounds.depth / 2;
    const span = Math.max(this.bounds.width, this.bounds.depth);
    this.camera.position.set(cx, span * 0.9, cz + span * 1.1);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    // Default dampingFactor (0.05) is twitchy at warehouse scale; soften it so
    // orbit/zoom glides to rest. controls.update() runs every frame in _loop().
    this.controls.dampingFactor = 0.10;
    this.controls.target.set(cx, 0, cz);
    this.controls.update();

    this._buildLights();
    this._buildFloor();
    this._buildShell();
    this._buildZones();
    this._buildStaging();
    this._buildRacks();
    this._buildStations();
    this._buildConveyors();
    this._buildEquipment();
    this._buildWorkers();
    this._buildAgvs();
    this._buildForklifts();
    this._buildRoutes();
    this._buildHeat();           // 3D congestion patches (only if replay.heat)
    this._buildContactShadows(); // soft blob shadows under moving agents
    this._buildGlowHalos();      // additive cyan activity halos (pseudo-bloom)
    this._buildPickFx();         // pooled pick-event pulse markers + connectors

    // Reduced-motion users get a fully static scene (belts + glow pulse off).
    if (this._reducedMotion()) this._beltSpeed = 0;

    // Apply the default art preset (mutates lights/renderer/scene only).
    this.setPreset(this._preset);

    // Live productivity HUD (DOM overlay) — only when replay.series exists.
    this._buildHud();
    // Controls hint + scene legend (DOM overlay) — tells the salesperson what
    // they're looking at and how to move the camera. Pure DOM, no render change.
    this._buildInfoOverlay();
    // Gentle one-shot intro camera move (skipped under reduced-motion).
    this._startIntro();

    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  // Whether the user prefers reduced motion (disables intro camera move).
  _reducedMotion() {
    try {
      return window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_e) { return false; }
  }

  // Track meshes so dispose() can free GPU resources.
  _track(geom, mat) {
    if (geom) this._geometries.push(geom);
    if (mat) this._materials.push(mat);
  }

  _buildLights() {
    const span = Math.max(this.bounds.width, this.bounds.depth);
    // Sky/ground hemisphere for soft, even ambient fill. Refs kept for presets.
    const hemi = new THREE.HemisphereLight(0xffffff, 0xb7c0cc, 0.85);
    hemi.position.set(this.bounds.width / 2, span, this.bounds.depth / 2);
    this.scene.add(hemi);
    this._hemi = hemi;
    // A touch of pure ambient so shadowed sides never go fully flat-dark.
    const ambient = new THREE.AmbientLight(0xffffff, 0.25);
    this.scene.add(ambient);
    this._ambient = ambient;
    // Key directional light, slightly warm, angled across the floor. Casts the
    // scene's shadows from a fitted orthographic shadow camera.
    const dir = new THREE.DirectionalLight(0xfff4e6, 0.85);
    // Pull the light well above and to the side so shadows rake across the floor.
    dir.position.set(this.bounds.width * 0.85, span * 1.4 + 8, this.bounds.depth * 0.25);
    dir.target.position.set(this.bounds.width / 2, 0, this.bounds.depth / 2);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    // Fit the orthographic shadow frustum to cover the whole floor (+margin) so
    // every object on it casts/receives crisp shadows without wasting texels.
    const half = span * 0.75 + 4;
    const cam = dir.shadow.camera;
    cam.left = -half; cam.right = half;
    cam.top = half; cam.bottom = -half;
    cam.near = 1;
    cam.far = span * 3.5 + 40;
    cam.updateProjectionMatrix();
    dir.shadow.bias = -0.0008;
    dir.shadow.normalBias = 0.04;
    dir.shadow.radius = 3; // soften PCF edges
    this.scene.add(dir);
    this.scene.add(dir.target);
    this._dir = dir;
  }

  // Faint procedural floor texture: aisle tile lines on a near-matte base so the
  // floor reads as a real surface, not a flat fill. Returns a CanvasTexture
  // tiled to roughly one repeat per `tileM` meters.
  _makeFloorTexture(tileM) {
    const S = 512;
    const canvas = document.createElement('canvas');
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext('2d');
    // Base with a very subtle vignette toward edges for tonal variation.
    ctx.fillStyle = '#e9ecf1';
    ctx.fillRect(0, 0, S, S);
    const grad = ctx.createRadialGradient(S / 2, S / 2, S * 0.1, S / 2, S / 2, S * 0.75);
    grad.addColorStop(0, 'rgba(255,255,255,0.10)');
    grad.addColorStop(1, 'rgba(120,130,145,0.10)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, S, S);
    // Faint tile grid lines.
    ctx.strokeStyle = 'rgba(150,160,172,0.45)';
    ctx.lineWidth = 2;
    const cells = 4;
    const step = S / cells;
    for (let i = 0; i <= cells; i++) {
      const p = Math.round(i * step) + 0.5;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(S, p); ctx.stroke();
    }
    // A lighter inner hairline per tile for a poured-concrete-joint feel.
    ctx.strokeStyle = 'rgba(255,255,255,0.30)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= cells; i++) {
      const p = Math.round(i * step) + 2.5;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(S, p); ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    const reps = Math.max(1, Math.round(Math.max(this.bounds.width, this.bounds.depth) / (tileM * cells)));
    tex.repeat.set(reps, reps);
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    // Clamp anisotropy to a sane max: full GPU anisotropy can be 16x and is
    // wasted on a faint floor texture; cap at 8 for crisp-enough joints cheaply.
    tex.anisotropy = Math.min(this.renderer.capabilities?.getMaxAnisotropy?.() ?? 1, 8);
    this._textures.push(tex);
    return tex;
  }

  _buildFloor() {
    const { width, depth } = this.bounds;
    const geom = new THREE.BoxGeometry(width, 0.1, depth);
    const tone = FLOOR_TONES[this._preset] || FLOOR_TONES.brand;
    const tex = this._makeFloorTexture(meta_grid(this.replay));
    const mat = new THREE.MeshStandardMaterial({
      color: tone.floor, roughness: 1.0, metalness: 0.0, map: tex,
    });
    this._floorMat = mat;
    const floor = new THREE.Mesh(geom, mat);
    floor.position.set(width / 2, -0.05, depth / 2);
    floor.receiveShadow = true; // catches contact shadows of every object
    this.scene.add(floor);
    this._track(geom, mat);

    // Subtle grid aligned to the floor; GridHelper is centered at origin.
    const grid = meta_grid(this.replay);
    const divisions = Math.max(1, Math.round(Math.max(width, depth) / grid));
    const helper = new THREE.GridHelper(Math.max(width, depth), divisions, tone.gridA, tone.gridB);
    helper.position.set(width / 2, 0.011, depth / 2);
    this.scene.add(helper);
    if (helper.geometry) this._geometries.push(helper.geometry);
    if (helper.material) this._materials.push(helper.material);
  }

  _buildZones() {
    const zones = this.replay.zones || [];
    for (const z of zones) {
      const w = z.w || 0;
      const h = z.h || 0;
      if (w <= 0 || h <= 0) continue;
      const geom = new THREE.PlaneGeometry(w, h);
      const color = z.color ? new THREE.Color(z.color) : new THREE.Color(0xcccccc);
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.rotation.x = -Math.PI / 2; // lay flat on the floor
      mesh.position.set((z.x || 0) + w / 2, 0.02, (z.y || 0) + h / 2);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this._track(geom, mat);
    }
  }

  _buildStaging() {
    this._staging = null;
    const sg = this.replay.staging;
    if (!sg) return;
    const w = sg.w || 2, h = sg.h || 2;
    const geom = new THREE.BoxGeometry(w, 1, h); // unit height; scaled per-frame by WIP
    const mat = new THREE.MeshStandardMaterial({
      color: 0x33a02c, transparent: true, opacity: 0.6, roughness: 0.5, metalness: 0.05,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set((sg.x || 0) + w / 2, 0.1, (sg.y || 0) + h / 2);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this._track(geom, mat);
    this._staging = { mesh, timeline: sg.timeline || [], capacity: sg.capacity || 1 };
  }

  // Racks: build realistic storage equipment from `replay.shelves` (the MapMaker
  // run contract: {x, y0, y1, depth, pitch, rack_type, cells, [rect, facing,
  // vertical]}). Each run is subdivided into BAYS at the rack type's bay pitch,
  // oriented so the pick face opens toward the aisle (from `facing`), and built
  // with per-rack_type realistic geometry (pallet beams, shelving tiers, flow
  // roller lanes, AS/RS tower + crane). Everything is InstancedMesh — one draw
  // call per (piece-type × rack_type), ABC tint via instanceColor on the load
  // pieces — so hundreds of runs stay well under ~120 draw calls.
  //
  // Falls back to the legacy per-point builder when there are no shelf runs.
  _buildRacks() {
    const shelves = this.replay.shelves || [];
    if (shelves.length === 0) {
      this._buildRacksFromPoints();   // legacy fallback (racks = location points)
      return;
    }

    // 1) Expand every run into a flat list of BAYS. A bay is one storage cell with
    //    a world centre (x,z), a yaw (so its pick face points to the aisle), a
    //    width along the run, the rack_type, and an ABC class (from the matching
    //    authored cell, else the run's modal class). This decouples geometry
    //    construction (step 2) from layout maths.
    const baysByType = {}; // rack_type -> [{x, z, yaw, bw, abc, cell}]
    // Also remember, per run, the first bay's frame so pick-events can locate a
    // target cell quickly (run_id + along → world position) without re-deriving.
    this._shelfRuns = [];   // [{x0,z0, ux,uz, length, yaw, rt, dims}] per run
    for (let ri = 0; ri < shelves.length; ri++) {
      const run = shelves[ri];
      const rt = RACK_DIMS[run.rack_type] ? run.rack_type : RACK_DEFAULT;
      const dims = rackDims(rt);
      const frame = this._runFrame(run, dims);   // axis + footprint of this run
      this._shelfRuns.push({ ...frame, ri, rt, dims });
      const cells = run.cells || [];
      const bayW = frame.bayW;
      const nBays = Math.max(1, Math.round(frame.length / bayW));
      const list = baysByType[rt] || (baysByType[rt] = []);
      for (let b = 0; b < nBays; b++) {
        // Bay centre marches along the run's unit axis from its start.
        const along = (b + 0.5) * (frame.length / nBays);
        const x = frame.x0 + frame.ux * along;
        const z = frame.z0 + frame.uz * along;
        // ABC: prefer the authored cell nearest this bay's along-fraction.
        const cell = cells.length
          ? cells[Math.min(cells.length - 1, Math.floor((along / frame.length) * cells.length))]
          : null;
        const abc = cell && ABC_COLOR[cell.abc] !== undefined ? cell.abc : 'C';
        list.push({ x, z, yaw: frame.yaw, bw: frame.length / nBays, abc, depth: dims.depth });
      }
    }

    // 2) Build each rack_type's bays with its dedicated realistic builder. Each
    //    builder pushes InstancedMeshes (low draw-call) into the scene.
    for (const rt of Object.keys(baysByType)) {
      const bays = baysByType[rt];
      if (!bays.length) continue;
      switch (rt) {
        case 'pallet':    this._buildPalletRack(bays); break;
        case 'flow':      this._buildFlowRack(bays); break;
        case 'asrs':      this._buildAsrsRack(bays); break;
        case 'nestainer': this._buildNestainer(bays); break;
        case 'light':
        case 'medium':
        default:          this._buildShelving(bays, rt); break;
      }
    }
  }

  // Resolve a run's world-space frame: a start point (x0,z0), a unit axis (ux,uz)
  // along which bays march, the run length, the bay width, a yaw that orients each
  // bay so its pick face opens to the aisle, and the depth axis. Prefers the
  // authored `rect`+`facing` (free-placed MapMaker shelves); otherwise derives a
  // vertical run from the legacy {x, y0, y1, depth} column contract.
  _runFrame(run, dims) {
    const bayW = (run.pitch && run.pitch > 0.2) ? run.pitch : dims.bay;
    if (run.rect && typeof run.rect.w === 'number') {
      // Authored rectangle: bays run along its LONG edge; depth is the short edge.
      const r = run.rect;
      const vertical = run.vertical !== undefined ? run.vertical : (r.h >= r.w);
      let x0, z0, ux, uz, length, depth;
      if (vertical) {
        // Long axis is +Z (depth of floor); centred on rect X.
        x0 = r.x + r.w / 2; z0 = r.y; ux = 0; uz = 1; length = r.h; depth = r.w;
      } else {
        // Long axis is +X; centred on rect Y.
        x0 = r.x; z0 = r.y + r.h / 2; ux = 1; uz = 0; length = r.w; depth = r.h;
      }
      // Yaw orients a bay's local +Z (its pick face) toward the aisle. The model
      // bays face their depth normal; we yaw so the open face points per `facing`.
      const yaw = this._facingYaw(run.facing, vertical);
      return { x0, z0, ux, uz, length, bayW, yaw, depth };
    }
    // Legacy vertical column: x is the centre, y0..y1 the Y span, depth across.
    const y0 = run.y0 || 0, y1 = run.y1 || 0;
    const length = Math.max(0.1, Math.abs(y1 - y0));
    return {
      x0: run.x || 0, z0: Math.min(y0, y1), ux: 0, uz: 1,
      length, bayW, yaw: 0, depth: run.depth || dims.depth,
    };
  }

  // Map an authored facing (up/down/left/right, floor coords where +Y is "down")
  // to a yaw that rotates a bay's local pick face (+Z) toward the aisle. Advisory
  // only — the bays still read correctly if facing is absent (defaults open the
  // face along the run's depth normal).
  _facingYaw(facing, vertical) {
    // Bay local +Z is the open/pick face. For a vertical run the depth normal is
    // ±X; for a horizontal run it is ±Z. We rotate so +Z lands on the aisle side.
    switch (facing) {
      case 'left':  return -Math.PI / 2;  // face -X
      case 'right': return Math.PI / 2;   // face +X
      case 'up':    return Math.PI;       // face -Z
      case 'down':  return 0;             // face +Z
      default:      return vertical ? Math.PI / 2 : 0;
    }
  }

  // Helper: make + register a standard rack material (tracked for dispose). When
  // `glowable`, it is also registered in _rackMaterials so presets pulse its
  // night-time emissive glow exactly like the legacy goods boxes.
  _rackMat(opts, glowable) {
    const mat = new THREE.MeshStandardMaterial(opts);
    this._materials.push(mat);
    if (glowable) this._rackMaterials.push(mat);
    return mat;
  }

  // Push an InstancedMesh from a piece geometry + material, filling per-bay
  // transforms via the supplied callback `place(i, bay) -> {pos, quat, scale}`
  // returning scratch objects. `perBay` instances per bay. Optional `tintAbc`
  // colours each instance by its bay's ABC class (instanceColor). Returns nothing
  // (added straight to the scene). Keeps draw calls = (#piece-types × #rack-types).
  _instancePieces(geom, mat, bays, perBay, place, tintAbc) {
    const n = bays.length * perBay;
    if (n === 0) return;
    const inst = new THREE.InstancedMesh(geom, mat, n);
    inst.castShadow = true;
    inst.receiveShadow = true;
    const m4 = new THREE.Matrix4();
    const col = tintAbc ? new THREE.Color() : null;
    let k = 0;
    for (let i = 0; i < bays.length; i++) {
      for (let j = 0; j < perBay; j++) {
        const T = place(j, bays[i]);
        m4.compose(T.pos, T.quat, T.scale);
        inst.setMatrixAt(k, m4);
        if (col) { col.setHex(ABC_COLOR[bays[i].abc] || ABC_COLOR.C); inst.setColorAt(k, col); }
        k++;
      }
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    this.scene.add(inst);
    return inst;
  }

  // Shared scratch for placement callbacks (no per-instance allocation).
  _scratch() {
    if (!this._sc) {
      this._sc = {
        pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1), euler: new THREE.Euler(),
      };
    }
    return this._sc;
  }

  // パレットラック (pallet rack): tall steel uprights at each bay edge, two pairs
  // of signature ORANGE load beams per level, and a wooden pallet + ABC-tinted
  // load on each level. ~5.6 m tall — towers over the picker. 4 instanced pieces.
  _buildPalletRack(bays) {
    const dims = RACK_DIMS.pallet;
    const H = dims.h, levels = dims.levels, depth = dims.depth;
    const lvH = H / levels;
    const s = this._scratch();
    // Geometries (shared, tracked).
    const uprightG = new THREE.BoxGeometry(0.10, H, 0.10);
    const beamG = new THREE.BoxGeometry(1, 0.12, 0.08);     // x-scaled to bay width
    const palletG = new THREE.BoxGeometry(1, 0.12, depth * 0.9);
    const loadG = new THREE.BoxGeometry(1, lvH * 0.55, depth * 0.8);
    this._geometries.push(uprightG, beamG, palletG, loadG);
    const steelMat = this._rackMat({ color: RACK_STEEL, roughness: 0.55, metalness: 0.5,
      emissive: new THREE.Color(0x10151c), emissiveIntensity: 0 });
    const beamMat = this._rackMat({ color: RACK_BEAM, roughness: 0.45, metalness: 0.35,
      emissive: new THREE.Color(RACK_BEAM), emissiveIntensity: 0.05 }, true);
    const palletMat = this._rackMat({ color: PALLET_WOOD, roughness: 0.9, metalness: 0.02 });
    const loadMat = this._rackMat({ color: 0xffffff, roughness: 0.85, metalness: 0.04,
      emissive: new THREE.Color(0x111111), emissiveIntensity: 0.05 }, true);

    // 4 uprights per bay (front/back × left/right), set near the bay edges.
    this._instancePieces(uprightG, steelMat, bays, 4, (j, bay) => {
      const sgnX = (j & 1) ? 0.5 : -0.5, sgnZ = (j & 2) ? 0.5 : -0.5;
      this._bayLocal(s, bay, sgnX * (bay.bw - 0.1), H / 2, sgnZ * (depth - 0.1));
      return s;
    });
    // Load beams: front & back beam at each level (2 × levels per bay).
    this._instancePieces(beamG, beamMat, bays, 2 * levels, (j, bay) => {
      const lvl = Math.floor(j / 2), front = (j % 2) ? 0.5 : -0.5;
      this._bayLocal(s, bay, 0, lvH * (lvl + 0.5) - lvH * 0.5 + 0.06, front * (depth - 0.1));
      s.scale.set(bay.bw, 1, 1);
      return s;
    }, false);
    // Wooden pallet base per level.
    this._instancePieces(palletG, palletMat, bays, levels, (j, bay) => {
      this._bayLocal(s, bay, 0, lvH * j + 0.12, 0);
      s.scale.set(bay.bw * 0.92, 1, 1);
      return s;
    });
    // ABC-tinted load on each pallet.
    this._instancePieces(loadG, loadMat, bays, levels, (j, bay) => {
      this._bayLocal(s, bay, 0, lvH * j + 0.18 + lvH * 0.30, 0);
      s.scale.set(bay.bw * 0.86, 1, 1);
      return s;
    }, true);
  }

  // 軽量棚 / 中量棚 (light/medium shelving): a steel cage + a board on every tier
  // with an ABC-tinted goods box. 2.0–2.4 m tall. 3 instanced pieces per type.
  _buildShelving(bays, rt) {
    const dims = rackDims(rt);
    const H = dims.h, tiers = dims.levels, depth = dims.depth;
    const tierH = H / tiers;
    const s = this._scratch();
    const frameG = new THREE.BoxGeometry(1, H, depth);          // x-scaled to bay
    const boardG = new THREE.BoxGeometry(1, 0.04, depth * 0.96);
    const goodsG = new THREE.BoxGeometry(1, tierH * 0.6, depth * 0.78);
    this._geometries.push(frameG, boardG, goodsG);
    // Open cage: a thin, low-metalness frame box reads as shelving uprights.
    const frameMat = this._rackMat({ color: RACK_STEEL, roughness: 0.6, metalness: 0.45,
      transparent: true, opacity: 0.32, emissive: new THREE.Color(0x10151c),
      emissiveIntensity: 0 });
    const boardMat = this._rackMat({ color: RACK_BOARD, roughness: 0.7, metalness: 0.3 });
    const goodsMat = this._rackMat({ color: 0xffffff, roughness: 0.82, metalness: 0.05,
      emissive: new THREE.Color(0x111111), emissiveIntensity: 0.06 }, true);
    // Frame cage (1 per bay).
    this._instancePieces(frameG, frameMat, bays, 1, (j, bay) => {
      this._bayLocal(s, bay, 0, H / 2, 0);
      s.scale.set(bay.bw, 1, 1);
      return s;
    });
    // Boards + goods per tier.
    this._instancePieces(boardG, boardMat, bays, tiers, (j, bay) => {
      this._bayLocal(s, bay, 0, tierH * j + 0.02, 0);
      s.scale.set(bay.bw * 0.96, 1, 1);
      return s;
    });
    this._instancePieces(goodsG, goodsMat, bays, tiers, (j, bay) => {
      this._bayLocal(s, bay, 0, tierH * (j + 0.5), 0);
      s.scale.set(bay.bw * 0.8, 1, 1);
      return s;
    }, true);
  }

  // フローラック (flow rack): inclined roller lanes feeding the pick face. We tilt
  // each lane board about the run's cross-axis so cartons appear to roll forward.
  // Steel frame + 3 inclined lanes + an ABC-tinted carton at the low (pick) end.
  _buildFlowRack(bays) {
    const dims = RACK_DIMS.flow;
    const H = dims.h, lanes = dims.levels, depth = dims.depth;
    const laneH = H / lanes;
    const s = this._scratch();
    const frameG = new THREE.BoxGeometry(1, H, depth);
    const laneG = new THREE.BoxGeometry(1, 0.05, depth * 0.95);
    const cartonG = new THREE.BoxGeometry(1, laneH * 0.4, depth * 0.3);
    this._geometries.push(frameG, laneG, cartonG);
    const frameMat = this._rackMat({ color: RACK_STEEL, roughness: 0.6, metalness: 0.45,
      transparent: true, opacity: 0.3 });
    const laneMat = this._rackMat({ color: ROLLER_COLOR, roughness: 0.4, metalness: 0.6 });
    const cartonMat = this._rackMat({ color: 0xffffff, roughness: 0.85, metalness: 0.04,
      emissive: new THREE.Color(0x111111), emissiveIntensity: 0.06 }, true);
    const tilt = 0.14; // radians: gentle forward incline toward the pick face
    this._instancePieces(frameG, frameMat, bays, 1, (j, bay) => {
      this._bayLocal(s, bay, 0, H / 2, 0);
      s.scale.set(bay.bw, 1, 1);
      return s;
    });
    // Inclined lanes: tilt about the bay's local X (cross-run) so the +Z (pick)
    // end dips. Compose bay yaw with the tilt via Euler order applied after.
    this._instancePieces(laneG, laneMat, bays, lanes, (j, bay) => {
      this._bayLocalTilt(s, bay, 0, laneH * (j + 0.55), 0, tilt);
      s.scale.set(bay.bw * 0.96, 1, 1);
      return s;
    });
    // Carton waiting at the low (pick-face) end of each lane.
    this._instancePieces(cartonG, cartonMat, bays, lanes, (j, bay) => {
      this._bayLocal(s, bay, 0, laneH * (j + 0.5) - laneH * 0.18, depth * 0.32);
      s.scale.set(bay.bw * 0.7, 1, 1);
      return s;
    }, true);
  }

  // ネステナー (nestainer): stacked nesting frames — a base frame + a stacked
  // upper frame, each carrying an ABC-tinted load. Reads as portable steel cages
  // stacked two high. 3 instanced pieces.
  _buildNestainer(bays) {
    const dims = RACK_DIMS.nestainer;
    const H = dims.h, depth = dims.depth;
    const stacks = 2, stackH = H / stacks;
    const s = this._scratch();
    const frameG = new THREE.BoxGeometry(1, stackH * 0.92, depth);
    const postG = new THREE.BoxGeometry(0.08, stackH, 0.08);
    const loadG = new THREE.BoxGeometry(1, stackH * 0.5, depth * 0.8);
    this._geometries.push(frameG, postG, loadG);
    const frameMat = this._rackMat({ color: RACK_STEEL, roughness: 0.6, metalness: 0.5,
      transparent: true, opacity: 0.28 });
    const postMat = this._rackMat({ color: RACK_STEEL, roughness: 0.55, metalness: 0.55 });
    const loadMat = this._rackMat({ color: 0xffffff, roughness: 0.84, metalness: 0.04,
      emissive: new THREE.Color(0x111111), emissiveIntensity: 0.06 }, true);
    // 4 corner posts per stack.
    this._instancePieces(postG, postMat, bays, 4 * stacks, (j, bay) => {
      const st = Math.floor(j / 4), corner = j % 4;
      const sgnX = (corner & 1) ? 0.5 : -0.5, sgnZ = (corner & 2) ? 0.5 : -0.5;
      this._bayLocal(s, bay, sgnX * (bay.bw - 0.08), stackH * (st + 0.5), sgnZ * (depth - 0.08));
      return s;
    });
    // ABC-tinted load per stack.
    this._instancePieces(loadG, loadMat, bays, stacks, (j, bay) => {
      this._bayLocal(s, bay, 0, stackH * j + stackH * 0.5, 0);
      s.scale.set(bay.bw * 0.86, 1, 1);
      return s;
    }, true);
  }

  // 自動倉庫 (AS/RS): a tall multi-level tower (~16 m) per bay column that vanishes
  // into the fog, plus ONE shared stacker-crane mast sliding the front aisle. The
  // tower is an instanced frame + many ABC-tinted totes; the crane is a single
  // group, animated gently along the run in _updateAsrs.
  _buildAsrsRack(bays) {
    const dims = RACK_DIMS.asrs;
    const H = dims.h, levels = dims.levels, depth = dims.depth;
    const lvH = H / levels;
    const s = this._scratch();
    const towerG = new THREE.BoxGeometry(1, H, depth);
    const toteG = new THREE.BoxGeometry(1, lvH * 0.6, depth * 0.7);
    this._geometries.push(towerG, toteG);
    const towerMat = this._rackMat({ color: ASRS_FRAME, roughness: 0.5, metalness: 0.55,
      transparent: true, opacity: 0.22 });
    const toteMat = this._rackMat({ color: 0xffffff, roughness: 0.8, metalness: 0.05,
      emissive: new THREE.Color(0x111111), emissiveIntensity: 0.08 }, true);
    this._instancePieces(towerG, towerMat, bays, 1, (j, bay) => {
      this._bayLocal(s, bay, 0, H / 2, 0);
      s.scale.set(bay.bw, 1, 1);
      return s;
    });
    this._instancePieces(toteG, toteMat, bays, levels, (j, bay) => {
      this._bayLocal(s, bay, 0, lvH * (j + 0.5), 0);
      s.scale.set(bay.bw * 0.82, 1, 1);
      return s;
    }, true);
    // A single hi-vis stacker crane mast that patrols the front of the AS/RS bays.
    this._buildAsrsCrane(bays, H, depth);
  }

  // One stacker-crane mast (a tall thin column with a shuttle box) that slides
  // along the AS/RS run's front face. Stored for a gentle per-frame patrol.
  _buildAsrsCrane(bays, H, depth) {
    if (!bays.length) return;
    const g = new THREE.Group();
    const mastG = new THREE.BoxGeometry(0.18, H, 0.18);
    const railG = new THREE.BoxGeometry(0.3, 0.12, 0.3);
    const shuttleG = new THREE.BoxGeometry(0.6, 0.5, depth * 0.8);
    this._geometries.push(mastG, railG, shuttleG);
    const craneMat = this._rackMat({ color: ASRS_CRANE, roughness: 0.4, metalness: 0.5,
      emissive: new THREE.Color(ASRS_CRANE), emissiveIntensity: 0.12 });
    const mast = new THREE.Mesh(mastG, craneMat); mast.position.y = H / 2; g.add(mast);
    const base = new THREE.Mesh(railG, craneMat); base.position.y = 0.06; g.add(base);
    const shuttle = new THREE.Mesh(shuttleG, craneMat); shuttle.position.y = H * 0.3; g.add(shuttle);
    _enableShadows(g);
    // Patrol axis: from the first to the last bay of this AS/RS set, offset to the
    // pick face. Endpoints + the cross-axis offset are baked once.
    const a = bays[0], b = bays[bays.length - 1];
    // Cross-axis (pick face normal) from bay yaw.
    const nx = Math.sin(a.yaw), nz = Math.cos(a.yaw);
    const off = (a.depth || depth) * 0.7;
    g.position.set(a.x + nx * off, 0, a.z + nz * off);
    this.scene.add(g);
    this._asrsCrane = {
      group: g, shuttle, H,
      ax: a.x + nx * off, az: a.z + nz * off,
      bx: b.x + nx * off, bz: b.z + nz * off,
    };
  }

  // Place scratch transform for a bay-local offset (dx along run width, y up, dz
  // along depth), rotated by the bay yaw and translated to the bay centre.
  _bayLocal(s, bay, dx, y, dz) {
    s.euler.set(0, bay.yaw, 0);
    s.quat.setFromEuler(s.euler);
    // Rotate the local (dx, dz) offset by yaw into world XZ.
    const cz = Math.cos(bay.yaw), sz = Math.sin(bay.yaw);
    const wx = dx * cz + dz * sz;
    const wz = -dx * sz + dz * cz;
    s.pos.set(bay.x + wx, y, bay.z + wz);
    s.scale.set(1, 1, 1);
    return s;
  }

  // Like _bayLocal but adds a forward tilt (about the bay's local X) for flow-rack
  // inclined lanes. Tilt + yaw are composed via a small Euler (YXZ).
  _bayLocalTilt(s, bay, dx, y, dz, tilt) {
    this._bayLocal(s, bay, dx, y, dz);
    s.euler.set(tilt, bay.yaw, 0, 'YXZ');
    s.quat.setFromEuler(s.euler);
    return s;
  }

  // Legacy fallback: one small instanced shelving unit per location point (the
  // pre-shelves behaviour), used only when `replay.shelves` is empty. Kept so old
  // replays (or models with no authored/materialised shelves) still render racks.
  _buildRacksFromPoints() {
    const racks = this.replay.racks || [];
    if (racks.length === 0) return;
    const RW = 0.8, RD = 0.8, RH = 2.0;   // raised to 2.0m so pickers don't tower
    const TIERS = 4;
    const tierH = RH / TIERS;

    const byClass = {};
    for (const r of racks) {
      const k = ABC_COLOR[r.abc] !== undefined ? r.abc : 'C';
      (byClass[k] || (byClass[k] = [])).push(r);
    }

    const frameGeom = new THREE.BoxGeometry(RW, RH, RD);
    const shelfGeom = new THREE.BoxGeometry(RW * 0.96, 0.05, RD * 0.96);
    const boxGeom = new THREE.BoxGeometry(RW * 0.72, tierH * 0.62, RD * 0.72);
    this._geometries.push(frameGeom, shelfGeom, boxGeom);

    const frameMat = new THREE.MeshStandardMaterial({
      color: RACK_STEEL, roughness: 0.6, metalness: 0.45,
      emissive: new THREE.Color(0x10151c), emissiveIntensity: 0.0,
    });
    const shelfMat = new THREE.MeshStandardMaterial({
      color: RACK_BOARD, roughness: 0.7, metalness: 0.3,
    });
    this._materials.push(frameMat, shelfMat);

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();

    for (const cls of Object.keys(byClass)) {
      const list = byClass[cls];
      const color = ABC_COLOR[cls] || 0xfdcc8a;
      const goodsMat = new THREE.MeshStandardMaterial({
        color, roughness: 0.82, metalness: 0.05,
        emissive: new THREE.Color(color), emissiveIntensity: 0.06,
      });
      this._materials.push(goodsMat);
      this._rackMaterials.push(goodsMat);

      const n = list.length;
      const frames = new THREE.InstancedMesh(frameGeom, frameMat, n);
      const shelves = new THREE.InstancedMesh(shelfGeom, shelfMat, n * TIERS);
      const goods = new THREE.InstancedMesh(boxGeom, goodsMat, n * TIERS);
      frames.castShadow = frames.receiveShadow = true;
      shelves.castShadow = shelves.receiveShadow = true;
      goods.castShadow = goods.receiveShadow = true;

      let si = 0, gi = 0;
      for (let i = 0; i < n; i++) {
        const r = list[i];
        const x = r.x || 0, z = r.y || 0;
        pos.set(x, RH / 2, z);
        m4.compose(pos, q, sc); frames.setMatrixAt(i, m4);
        for (let t = 0; t < TIERS; t++) {
          const y = tierH * (t + 0.5);
          pos.set(x, tierH * t + 0.02, z);
          m4.compose(pos, q, sc); shelves.setMatrixAt(si++, m4);
          pos.set(x, y, z);
          m4.compose(pos, q, sc); goods.setMatrixAt(gi++, m4);
        }
      }
      frames.instanceMatrix.needsUpdate = true;
      shelves.instanceMatrix.needsUpdate = true;
      goods.instanceMatrix.needsUpdate = true;
      this.scene.add(frames, shelves, goods);
    }
  }

  _buildStations() {
    const stations = this.replay.stations || [];
    if (stations.length === 0) return;
    const geom = new THREE.CylinderGeometry(0.5, 0.5, 1.4, 16);
    this._geometries.push(geom);
    for (const s of stations) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x08519c, roughness: 0.5, metalness: 0.1,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(s.x || 0, 0.7, s.y || 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this._materials.push(mat);
    }
  }

  // Conveyors: a chain of thin elongated boxes laid along each polyline,
  // low to the floor, neutral metallic gray. Missing/empty -> nothing.
  _buildConveyors() {
    const conveyors = this.replay.conveyors || [];
    if (conveyors.length === 0) return;
    const BELT_W = 0.5;   // belt width (m)
    const BELT_H = 0.18;  // belt thickness (m)
    const yMid = 0.12;    // raised slightly off the floor
    // One shared scrolling belt-tread texture for every segment's TOP face. The
    // map.offset is advanced every frame (delta-based) in _updateBelts() so the
    // tread appears to flow toward the conveyor's downstream end — a cheap,
    // GPU-only motion cue. Reduced-motion leaves it static (_beltSpeed = 0).
    const beltTex = this._makeBeltTexture();
    for (const c of conveyors) {
      const pts = c.points || [];
      const dir = (c.speed_mps || 0) < 0 ? -1 : 1; // flow direction along the chain
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        if (!p0 || !p1) continue;
        const dx = (p1[0] || 0) - (p0[0] || 0);
        const dz = (p1[1] || 0) - (p0[1] || 0);
        const len = Math.hypot(dx, dz);
        if (len <= 0) continue;
        // Box's local X is its length; rotate about Y to align to the segment.
        const geom = new THREE.BoxGeometry(len, BELT_H, BELT_W);
        // Side rails / structure stay matte gray; the belt tread (the moving
        // texture) is a separate, lightly-emissive material so it reads under any
        // preset. Six-material BoxGeometry: index 2 is the +Y (top) face.
        const railMat = new THREE.MeshStandardMaterial({
          color: 0x9aa3ad, roughness: 0.35, metalness: 0.7,
        });
        const treadTex = beltTex.clone();
        treadTex.needsUpdate = true;
        // Repeat the tread ~1 per metre along the run so motion speed reads right.
        treadTex.repeat.set(Math.max(1, Math.round(len)), 1);
        this._textures.push(treadTex);
        const treadMat = new THREE.MeshStandardMaterial({
          color: 0x2b323b, roughness: 0.55, metalness: 0.25, map: treadTex,
          emissive: new THREE.Color(0x121821), emissiveIntensity: 0.25,
        });
        const mats = [railMat, railMat, treadMat, railMat, railMat, railMat];
        const mesh = new THREE.Mesh(geom, mats);
        mesh.position.set(
          (p0[0] || 0) + dx / 2, yMid, (p0[1] || 0) + dz / 2,
        );
        mesh.rotation.y = -Math.atan2(dz, dx);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        // railMat is shared per-segment; track both materials + geom for dispose.
        this._geometries.push(geom);
        this._materials.push(railMat, treadMat);
        // Speed: belt linear speed (m/s) scaled to texture repeats; sign = flow.
        const sp = Math.min(2.5, Math.abs(c.speed_mps || 0.6) || 0.6) * dir;
        this._belts.push({ mat: treadMat, speed: sp });
      }
    }
  }

  // Belt-tread texture: dark rubber with light chevron/cleat bands across the
  // run so scrolling map.offset reads as forward motion. Cached as a base
  // CanvasTexture; each segment clones it (cheap, shares the canvas bitmap).
  _makeBeltTexture() {
    const S = 64;
    const canvas = document.createElement('canvas');
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#20262e';
    ctx.fillRect(0, 0, S, S);
    // Two light cleat bands per tile (perpendicular to flow = vertical here).
    ctx.fillStyle = 'rgba(150,165,180,0.55)';
    ctx.fillRect(2, 0, 5, S);
    ctx.fillRect(Math.round(S / 2) + 2, 0, 5, S);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(2, 0, 2, S);
    ctx.fillRect(Math.round(S / 2) + 2, 0, 2, S);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    this._textures.push(tex);
    return tex;
  }

  // Per-frame: scroll each conveyor belt's tread texture by delta * speed.
  // _beltSpeed gates it globally (0 under reduced-motion or fps auto-degrade).
  _updateBelts(dt) {
    if (this._belts.length === 0 || this._beltSpeed === 0) return;
    const d = dt * this._beltSpeed;
    for (const b of this._belts) {
      const m = b.mat.map;
      if (!m) continue;
      m.offset.x = (m.offset.x + d * b.speed * 0.5) % 1;
    }
  }

  // -- Building shell --------------------------------------------------------
  // Walls: thin tall boxes along each polyline segment. Doors: short colored
  // frame markers. Both defensive against missing/empty arrays.
  _buildShell() {
    this._buildWalls();
    this._buildDoors();
  }

  _buildWalls() {
    const walls = this.replay.walls || [];
    if (walls.length === 0) return;
    const WALL_H = 3.0;     // wall height (m)
    const DEFAULT_T = 0.2;  // default wall thickness (m)
    const mat = new THREE.MeshStandardMaterial({
      color: 0xd6d9dd, roughness: 0.9, metalness: 0.02,
    });
    this._materials.push(mat);
    for (const wall of walls) {
      const pts = wall.points || [];
      const t = wall.thickness > 0 ? wall.thickness : DEFAULT_T;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        if (!p0 || !p1) continue;
        const dx = (p1[0] || 0) - (p0[0] || 0);
        const dz = (p1[1] || 0) - (p0[1] || 0);
        const len = Math.hypot(dx, dz);
        if (len <= 0) continue;
        // Local X = segment length; thin in Z; rotate about Y to align.
        const geom = new THREE.BoxGeometry(len, WALL_H, t);
        this._geometries.push(geom);
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(
          (p0[0] || 0) + dx / 2, WALL_H / 2, (p0[1] || 0) + dz / 2,
        );
        mesh.rotation.y = -Math.atan2(dz, dx);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
      }
    }
  }

  _buildDoors() {
    const doors = this.replay.doors || [];
    if (doors.length === 0) return;
    const DOOR_COLOR = { dock: 0x1f78b4, personnel: 0x33a02c, shutter: 0x9aa3ad };
    const DOOR_H = 2.6;  // door frame height (m)
    const FRAME_T = 0.12;
    for (const d of doors) {
      const w = d.w > 0 ? d.w : 1.5;
      const color = DOOR_COLOR[d.type] !== undefined ? DOOR_COLOR[d.type] : DOOR_COLOR.shutter;
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 0.5, metalness: 0.15,
        emissive: new THREE.Color(color), emissiveIntensity: 0.25,
      });
      this._materials.push(mat);
      // A thin slab marking the door opening: wide as the door, full height.
      const geom = new THREE.BoxGeometry(w, DOOR_H, FRAME_T);
      this._geometries.push(geom);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(d.x || 0, DOOR_H / 2, d.y || 0);
      mesh.castShadow = true;
      this.scene.add(mesh);
    }
  }

  // -- Placed equipment models ----------------------------------------------
  // Static, recognizable primitive composites at (x, 0, y). Distinct from the
  // moving AGV agents in replay.agvs. Each model is one THREE.Group.
  _buildEquipment() {
    const equipment = this.replay.equipment || [];
    if (equipment.length === 0) return;
    for (const e of equipment) {
      const x = e.x || 0;
      const y = e.y || 0;
      const base = EQUIP_COLOR[e.type] !== undefined ? EQUIP_COLOR[e.type] : 0x8d949c;
      // Vehicles/metal hardware read a bit more metallic & polished than racks.
      const metalish = e.type === 'forklift' || e.type === 'agv' ||
                       e.type === 'crane' || e.type === 'robot_arm';
      const mat = new THREE.MeshStandardMaterial({
        color: base,
        roughness: metalish ? 0.4 : 0.6,
        metalness: metalish ? 0.55 : 0.25,
      });
      this._materials.push(mat);
      let group;
      switch (e.type) {
        case 'forklift':  group = this._makeForklift(mat); break;
        case 'asrs':      group = this._makeAsrs(mat); break;
        case 'robot_arm': group = this._makeRobotArm(mat); break;
        case 'crane':     group = this._makeCrane(mat); break;
        case 'agv':       group = this._makeDock(mat); break;
        default:          group = this._makeDock(mat); break;
      }
      group.position.set(x, 0, y);
      _enableShadows(group);
      this.scene.add(group);
    }
  }

  // Small body box + two fork prongs + a vertical mast (orange via mat).
  _makeForklift(mat) {
    const g = new THREE.Group();
    const body = new THREE.BoxGeometry(1.0, 0.7, 1.6);
    this._geometries.push(body);
    const bodyMesh = new THREE.Mesh(body, mat);
    bodyMesh.position.set(0, 0.55, 0);
    g.add(bodyMesh);
    // Vertical mast at the front.
    const mast = new THREE.BoxGeometry(0.8, 1.8, 0.12);
    this._geometries.push(mast);
    const mastMesh = new THREE.Mesh(mast, mat);
    mastMesh.position.set(0, 1.0, 0.9);
    g.add(mastMesh);
    // Two fork prongs sticking out forward at floor level.
    const prong = new THREE.BoxGeometry(0.12, 0.08, 1.0);
    this._geometries.push(prong);
    for (const dx of [-0.25, 0.25]) {
      const p = new THREE.Mesh(prong, mat);
      p.position.set(dx, 0.1, 1.4);
      g.add(p);
    }
    return g;
  }

  // 自動倉庫: tall multi-level rack tower (gray), taller than normal racks,
  // with horizontal shelf lines.
  _makeAsrs(mat) {
    const g = new THREE.Group();
    const H = 6.0;
    const tower = new THREE.BoxGeometry(2.4, H, 1.6);
    this._geometries.push(tower);
    const towerMesh = new THREE.Mesh(tower, mat);
    towerMesh.position.set(0, H / 2, 0);
    g.add(towerMesh);
    // Horizontal shelf lines: thin darker slabs banding the tower.
    const shelfMat = new THREE.MeshStandardMaterial({
      color: 0x5a6068, roughness: 0.6, metalness: 0.3,
    });
    this._materials.push(shelfMat);
    const shelf = new THREE.BoxGeometry(2.5, 0.08, 1.7);
    this._geometries.push(shelf);
    const levels = 6;
    for (let i = 1; i < levels; i++) {
      const s = new THREE.Mesh(shelf, shelfMat);
      s.position.set(0, (H / levels) * i, 0);
      g.add(s);
    }
    return g;
  }

  // Base cylinder + 2 jointed arm segments (boxes) angled up (metallic).
  _makeRobotArm(mat) {
    const g = new THREE.Group();
    const base = new THREE.CylinderGeometry(0.6, 0.7, 0.5, 16);
    this._geometries.push(base);
    const baseMesh = new THREE.Mesh(base, mat);
    baseMesh.position.set(0, 0.25, 0);
    g.add(baseMesh);
    // First segment: rises from the base, tilted back.
    const seg1 = new THREE.BoxGeometry(0.25, 1.8, 0.25);
    this._geometries.push(seg1);
    const s1 = new THREE.Mesh(seg1, mat);
    s1.position.set(0, 1.3, 0);
    s1.rotation.z = 0.35;
    g.add(s1);
    // Second segment: jointed off the top of the first, angled forward.
    const seg2 = new THREE.BoxGeometry(0.2, 1.4, 0.2);
    this._geometries.push(seg2);
    const s2 = new THREE.Mesh(seg2, mat);
    s2.position.set(-0.55, 2.25, 0.45);
    s2.rotation.z = -0.6;
    s2.rotation.x = 0.4;
    g.add(s2);
    return g;
  }

  // ホイストクレーン: overhead gantry beam on two legs spanning a few meters.
  _makeCrane(mat) {
    const g = new THREE.Group();
    const SPAN = 5.0;   // beam length (m)
    const LEG_H = 4.0;  // leg height (m)
    // Two legs at the ends of the span.
    const leg = new THREE.BoxGeometry(0.3, LEG_H, 0.3);
    this._geometries.push(leg);
    for (const dx of [-SPAN / 2, SPAN / 2]) {
      const l = new THREE.Mesh(leg, mat);
      l.position.set(dx, LEG_H / 2, 0);
      g.add(l);
    }
    // Overhead beam spanning the legs.
    const beam = new THREE.BoxGeometry(SPAN + 0.3, 0.4, 0.5);
    this._geometries.push(beam);
    const beamMesh = new THREE.Mesh(beam, mat);
    beamMesh.position.set(0, LEG_H, 0);
    g.add(beamMesh);
    // A hoist block hanging from the beam.
    const hoist = new THREE.BoxGeometry(0.5, 0.6, 0.5);
    this._geometries.push(hoist);
    const h = new THREE.Mesh(hoist, mat);
    h.position.set(0, LEG_H - 0.8, 0);
    g.add(h);
    return g;
  }

  // Placed AGV dock: a low charging-dock pad with a small upright marker.
  _makeDock(mat) {
    const g = new THREE.Group();
    const pad = new THREE.BoxGeometry(1.6, 0.12, 1.6);
    this._geometries.push(pad);
    const padMesh = new THREE.Mesh(pad, mat);
    padMesh.position.set(0, 0.06, 0);
    g.add(padMesh);
    // Upright charging post at the back edge.
    const post = new THREE.BoxGeometry(0.2, 0.8, 0.2);
    this._geometries.push(post);
    const postMesh = new THREE.Mesh(post, mat);
    postMesh.position.set(0, 0.4, -0.7);
    g.add(postMesh);
    return g;
  }

  // -- Render / art presets --------------------------------------------------
  // Adjust background, fog color, light intensities/colors, rack emissive glow,
  // and tone-mapping exposure ONLY. Never rebuilds static geometry.
  setPreset(name) {
    const p = PRESETS[name] || PRESETS.natural;
    this._preset = PRESETS[name] ? name : 'natural';
    if (this.scene) {
      if (this.scene.background && this.scene.background.set) {
        this.scene.background.set(p.background);
      } else {
        this.scene.background = new THREE.Color(p.background);
      }
      if (this.scene.fog && this.scene.fog.color) {
        this.scene.fog.color.set(p.fogColor);
      }
    }
    if (this._hemi) {
      this._hemi.color.set(p.hemiSky);
      this._hemi.groundColor.set(p.hemiGround);
      this._hemi.intensity = p.hemiInt;
    }
    if (this._ambient) {
      this._ambient.color.set(p.ambient);
      this._ambient.intensity = p.ambientInt;
    }
    if (this._dir) {
      this._dir.color.set(p.dirColor);
      this._dir.intensity = p.dirInt;
      // Soften/disable harsh raking shadows for the dim/flat presets.
      this._dir.castShadow = p.shadow !== false;
    }
    if (this.renderer) {
      this.renderer.toneMappingExposure = p.exposure;
      // Lower-key presets get lighter contact shadows.
      this.renderer.shadowMap.needsUpdate = true;
    }
    // Floor concrete tone follows the preset (multiplies the baked texture).
    if (this._floorMat && this._floorMat.color) {
      const tone = FLOOR_TONES[this._preset] || FLOOR_TONES.brand;
      this._floorMat.color.setHex(tone.floor);
    }
    // Rack emissive glow: subtle by day, strong at night.
    for (const m of this._rackMaterials) {
      if (m) m.emissiveIntensity = p.rackEmissive;
    }
  }

  // Currently active preset name.
  getPreset() {
    return this._preset;
  }

  // Workers are now ~1.7 m HUMANS, not spheres — the fix for the user's #1
  // complaint (spheres towered over the old 1.2 m racks and "突き抜け"-ed). Each
  // figure is a small Group: legs + a state-coloured hi-vis vest torso + skin
  // head + helmet + a near arm that REACHES on pick + a tote held when carrying.
  // Geometry is shared across all workers; only the vest material is per-worker
  // (so it can lerp to the state colour) plus a reused glow-emissive on the vest.
  // The Group exposes a `position` proxy at floor level, so the existing contact
  // shadows / glow halos (which read `ref.mesh.position`) keep working unchanged.
  _buildWorkers() {
    const workers = this.replay.workers || [];
    if (workers.length === 0) return;
    // Shared geometries for the human figure (metres).
    const legG = new THREE.BoxGeometry(0.18, 0.7, 0.22);
    const torsoG = new THREE.BoxGeometry(0.46, 0.62, 0.28);   // hi-vis vest
    const headG = new THREE.SphereGeometry(0.13, 14, 12);
    const helmetG = new THREE.SphereGeometry(0.15, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    const armG = new THREE.BoxGeometry(0.11, 0.5, 0.11);
    const toteG = new THREE.BoxGeometry(0.34, 0.26, 0.30);
    this._geometries.push(legG, torsoG, headG, helmetG, armG, toteG);
    // Shared non-vest materials.
    const legMat = new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.8, metalness: 0.05 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xe0b48a, roughness: 0.7, metalness: 0.02 });
    const helmetMat = new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.45, metalness: 0.1 });
    const armMat = new THREE.MeshStandardMaterial({ color: 0xd9dde2, roughness: 0.7, metalness: 0.05 });
    const toteMat = new THREE.MeshStandardMaterial({ color: 0xc9a36b, roughness: 0.85, metalness: 0.04 });
    this._materials.push(legMat, skinMat, helmetMat, armMat, toteMat);

    for (const wk of workers) {
      const g = new THREE.Group();
      // Two legs.
      for (const dx of [-0.12, 0.12]) {
        const leg = new THREE.Mesh(legG, legMat);
        leg.position.set(dx, 0.35, 0);
        g.add(leg);
      }
      // Hi-vis vest torso — per-worker material (state colour + glow emissive).
      const vestMat = new THREE.MeshStandardMaterial({
        color: STATE_COLOR.idle, roughness: 0.5, metalness: 0.05,
        emissive: new THREE.Color(GLOW_CYAN), emissiveIntensity: 0.0,
      });
      this._materials.push(vestMat);
      const torso = new THREE.Mesh(torsoG, vestMat);
      torso.position.set(0, 1.0, 0);
      g.add(torso);
      // Head + helmet.
      const head = new THREE.Mesh(headG, skinMat);
      head.position.set(0, 1.45, 0);
      g.add(head);
      const helmet = new THREE.Mesh(helmetG, helmetMat);
      helmet.position.set(0, 1.5, 0);
      g.add(helmet);
      // Near arm pivoting from the shoulder — reaches forward (+Z) on pick. We
      // parent it to a pivot at the shoulder so a rotation swings the hand up.
      const armPivot = new THREE.Group();
      armPivot.position.set(0.27, 1.22, 0);
      const arm = new THREE.Mesh(armG, armMat);
      arm.position.set(0, -0.22, 0); // hangs down from the pivot at rest
      armPivot.add(arm);
      g.add(armPivot);
      // Tote held in front while carrying (hidden otherwise).
      const tote = new THREE.Mesh(toteG, toteMat);
      tote.position.set(0, 0.95, 0.32);
      tote.visible = false;
      g.add(tote);

      _enableShadows(g);
      this.scene.add(g);
      // `mesh` proxy = the group (its .position is the floor anchor) so shadow /
      // glow followers keep working. Extra refs drive the pick reach + carry tote.
      this._workers.push({
        mesh: g, vestMat, armPivot, tote, keyframes: wk.keyframes || [],
        glow: 0, reach: 0, faceYaw: 0, idx: this._workers.length,
      });
    }
  }

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
  }

  // AGVs: small flat boxes (distinct from worker spheres), raised slightly,
  // colored by action. Missing/empty `replay.agvs` -> nothing.
  _buildAgvs() {
    const agvs = this.replay.agvs || [];
    if (agvs.length === 0) return;
    const geom = new THREE.BoxGeometry(1.0, 0.35, 1.4); // shared, flat & low
    this._geometries.push(geom);
    // Shared little tote box that rides on an AGV while it hauls a load. Created
    // once per AGV (never per frame); toggled visible by carry state each frame.
    const toteGeom = new THREE.BoxGeometry(0.7, 0.5, 0.95);
    // Status dome: a small hemisphere beacon on top, emissive in the action
    // colour (idle gray → travel blue → pickup green → dropoff amber → charge
    // purple), so an AGV's job reads at a glance like a real warehouse robot.
    const domeGeom = new THREE.SphereGeometry(0.16, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    this._geometries.push(toteGeom, domeGeom);
    for (const a of agvs) {
      // Cyan emissive baked in but starting dark; pulsed up while the AGV works.
      const mat = new THREE.MeshStandardMaterial({
        color: AGV_COLOR.idle, roughness: 0.35, metalness: 0.55,
        emissive: new THREE.Color(GLOW_CYAN), emissiveIntensity: 0.0,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(0, AGV_Y, 0);
      mesh.castShadow = true;
      this.scene.add(mesh);
      this._materials.push(mat);
      // Carried tote: a child of the AGV mesh so it follows position + needs no
      // separate per-frame placement. Lightly cyan-emissive cardboard.
      const toteMat = new THREE.MeshStandardMaterial({
        color: 0xc9a36b, roughness: 0.85, metalness: 0.05,
        emissive: new THREE.Color(GLOW_CYAN), emissiveIntensity: 0.0,
      });
      this._materials.push(toteMat);
      const tote = new THREE.Mesh(toteGeom, toteMat);
      tote.position.set(0, 0.42, 0); // sits on top of the flat AGV body
      tote.castShadow = true;
      tote.visible = false;
      mesh.add(tote);
      // Status beacon dome (action-coloured, emissive). Sits at a back corner so
      // it stays visible even when a tote rides the body.
      const domeMat = new THREE.MeshStandardMaterial({
        color: AGV_COLOR.idle, roughness: 0.4, metalness: 0.1,
        emissive: new THREE.Color(AGV_COLOR.idle), emissiveIntensity: 0.6,
      });
      this._materials.push(domeMat);
      const dome = new THREE.Mesh(domeGeom, domeMat);
      dome.position.set(0, 0.2, -0.5);
      mesh.add(dome);
      this._agvs.push({ mesh, keyframes: a.keyframes || [], mat, tote, dome, domeMat, glow: 0 });
    }
  }

  // Moving forklifts: each is a forklift composite (adapted from the static
  // placed model) interpolated with the SAME sampleKeyframes() helper as
  // workers/AGVs, and yawed to face its direction of travel. The local model
  // faces +Z (its forks point +Z), so yaw = atan2(vx, vz). Missing/empty -> ok.
  _buildForklifts() {
    const forklifts = this.replay.forklifts || [];
    if (forklifts.length === 0) return;
    // Shared geometries/materials across all moving forklifts (perf).
    const bodyGeom = new THREE.BoxGeometry(1.0, 0.7, 1.6);
    const cabGeom = new THREE.BoxGeometry(0.85, 0.7, 0.7);
    const mastGeom = new THREE.BoxGeometry(0.8, 1.8, 0.12);
    const prongGeom = new THREE.BoxGeometry(0.12, 0.08, 1.0);
    this._geometries.push(bodyGeom, cabGeom, mastGeom, prongGeom);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xf57c00, roughness: 0.42, metalness: 0.5,
    });
    const cabMat = new THREE.MeshStandardMaterial({
      color: 0x2b2f33, roughness: 0.5, metalness: 0.4,
    });
    const forkMat = new THREE.MeshStandardMaterial({
      color: 0xb0b6bd, roughness: 0.35, metalness: 0.7,
    });
    this._materials.push(bodyMat, cabMat, forkMat);
    // A pallet load that rides the forks while carrying. Shared geometry/material.
    const loadGeom = new THREE.BoxGeometry(0.9, 0.7, 1.0);
    this._geometries.push(loadGeom);
    const loadMat = new THREE.MeshStandardMaterial({
      color: 0xc9a36b, roughness: 0.85, metalness: 0.04,
    });
    this._materials.push(loadMat);
    for (const f of forklifts) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyGeom, bodyMat);
      body.position.set(0, 0.55, 0);
      g.add(body);
      const cab = new THREE.Mesh(cabGeom, cabMat);
      cab.position.set(0, 1.0, -0.4);
      g.add(cab);
      const mastMesh = new THREE.Mesh(mastGeom, forkMat);
      mastMesh.position.set(0, 1.0, 0.9);
      g.add(mastMesh);
      // Forks + load ride a small carriage group so they RAISE together when the
      // forklift is carrying (driven in _updateForklifts off the carry state).
      const carriage = new THREE.Group();
      for (const dx of [-0.25, 0.25]) {
        const p = new THREE.Mesh(prongGeom, forkMat);
        p.position.set(dx, 0, 1.4);
        carriage.add(p);
      }
      const load = new THREE.Mesh(loadGeom, loadMat);
      load.position.set(0, 0.4, 1.35);
      load.visible = false;
      carriage.add(load);
      carriage.position.y = 0.1; // resting fork height
      g.add(carriage);
      _enableShadows(g);
      this.scene.add(g);
      this._forklifts.push({
        group: g, keyframes: f.keyframes || [], yaw: 0, carriage, load, lift: 0,
      });
    }
  }

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
  }

  // -- 3D congestion heat patches ------------------------------------------
  // If the replay carries a `heat` grid, lay glowing floor tiles (green→red by
  // intensity) just above the floor. Accepts either a 2D array `heat.cells`
  // (rows of [0..1]) with `heat.grid_m`, or a flat list `heat.patches` of
  // {x,y,v}. Purely additive: absent/empty → nothing drawn. One InstancedMesh
  // (single draw call) keeps it cheap; emissive colour is baked per instance.
  _buildHeat() {
    this._heat = null;
    const heat = this.replay.heat;
    if (!heat) return;
    // Normalize to a list of { x, y, v(0..1), size } cells.
    const cells = [];
    const grid = (heat.grid_m && heat.grid_m > 0) ? heat.grid_m : meta_grid(this.replay);
    if (Array.isArray(heat.patches)) {
      for (const p of heat.patches) {
        if (!p) continue;
        const v = Math.max(0, Math.min(1, +p.v || +p.value || 0));
        if (v <= 0.001) continue;
        cells.push({ x: +p.x || 0, y: +p.y || 0, v, size: +p.size || grid });
      }
    } else if (Array.isArray(heat.cells)) {
      // Find max for normalization (defensive if values aren't pre-normalized).
      let mx = 0;
      for (const row of heat.cells) {
        if (!Array.isArray(row)) continue;
        for (const c of row) if (+c > mx) mx = +c;
      }
      const norm = mx > 0 ? mx : 1;
      for (let r = 0; r < heat.cells.length; r++) {
        const row = heat.cells[r];
        if (!Array.isArray(row)) continue;
        for (let c = 0; c < row.length; c++) {
          const v = Math.max(0, Math.min(1, (+row[c] || 0) / norm));
          if (v <= 0.02) continue;
          cells.push({ x: (c + 0.5) * grid, y: (r + 0.5) * grid, v, size: grid });
        }
      }
    }
    if (cells.length === 0) return;

    const geom = new THREE.PlaneGeometry(1, 1);
    this._geometries.push(geom);
    // Emissive so patches read as glowing zones under any preset lighting.
    const mat = new THREE.MeshStandardMaterial({
      transparent: true, opacity: 0.55, side: THREE.DoubleSide,
      depthWrite: false, roughness: 1.0, metalness: 0.0,
      emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.9,
    });
    this._materials.push(mat);
    const inst = new THREE.InstancedMesh(geom, mat, cells.length);

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    q.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)); // lay flat
    const pos = new THREE.Vector3();
    const sc = new THREE.Vector3(1, 1, 1);
    const col = new THREE.Color();
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      pos.set(c.x, 0.03, c.y);
      sc.set(c.size * 0.96, c.size * 0.96, 1);
      m4.compose(pos, q, sc);
      inst.setMatrixAt(i, m4);
      // Green (low) → yellow → red (high) via HSL hue 0.33→0.
      col.setHSL((1 - c.v) * 0.33, 0.9, 0.5);
      inst.setColorAt(i, col);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.renderOrder = 2;
    this.scene.add(inst);
    this._heat = { mesh: inst, mat };
  }

  // -- Soft contact shadows --------------------------------------------------
  // A faint radial-gradient blob sprite under each moving agent (worker / AGV /
  // forklift). Cheaper & softer than per-object cast shadows for fast movers,
  // and always grounds them visually. Sprites are tracked for dispose. Each
  // `follow` holds the agent ref + a getter for its current (x, z) and a y/scale.
  _buildContactShadows() {
    this._shadowSprites = [];
    const tex = this._makeBlobTexture();
    this._shadowTex = tex;
    const mkSprite = (size) => {
      const mat = new THREE.SpriteMaterial({
        map: tex, color: 0x000000, transparent: true, opacity: 0.32,
        depthWrite: false,
      });
      this._materials.push(mat);
      const sp = new THREE.Sprite(mat);
      sp.scale.set(size, size, 1);
      sp.position.y = 0.04;
      sp.center.set(0.5, 0.5);
      // Keep flat on the floor: sprites face the camera by default, but a small
      // contact blob reads fine billboarded; we instead lock it flat via a tiny
      // rotation trick is not available on Sprite, so we keep it billboarded —
      // it stays near the floor and is visually a soft contact patch.
      this.scene.add(sp);
      return sp;
    };
    for (const w of this._workers) {
      this._shadowSprites.push({ sprite: mkSprite(1.4), kind: 'worker', ref: w });
    }
    for (const a of this._agvs) {
      this._shadowSprites.push({ sprite: mkSprite(1.8), kind: 'agv', ref: a });
    }
    for (const f of this._forklifts) {
      this._shadowSprites.push({ sprite: mkSprite(2.2), kind: 'forklift', ref: f });
    }
  }

  // Radial soft-alpha blob used by contact shadows. Cached as a CanvasTexture.
  _makeBlobTexture() {
    const S = 128;
    const canvas = document.createElement('canvas');
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.85)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(canvas);
    this._textures.push(tex);
    return tex;
  }

  // -- Additive activity glow halos (pseudo-bloom) --------------------------
  // A soft radial cyan billboard Sprite riding on top of each active agent
  // (worker / AGV+tote / forklift). This is a CHEAP approximation of bloom: one
  // shared CanvasTexture + AdditiveBlending makes overlapping active machines
  // "bleed" light, reading like a glow without any post-processing pass (none is
  // vendored). It rides the SAME activity ramp as the existing emissive pulse
  // (worker.glow / agv.glow + a new forklift glow), so it appears only while the
  // agent works/moves and fully vanishes when idle. depthWrite:false keeps it
  // from occluding; depthTest stays true so it tucks naturally behind geometry.
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
      // Forklifts have no glow ramp of their own yet; seed one for the halo.
      if (f.glow === undefined) f.glow = 0;
      const s = mkSprite(3.0, 0.9);
      this._glowSprites.push({ ...s, kind: 'forklift', ref: f, base: 3.0 });
    }
  }

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
  }

  // Per-frame: follow each agent and ramp halo opacity/scale off the SAME glow
  // value used by the emissive pulse, so the two read as one effect. No `new`
  // per frame; sprites/material/texture are reused. Gated by fps auto-degrade.
  _updateGlowHalos() {
    if (!this._glowSprites || this._glowSprites.length === 0) return;
    if (!this._glowEnabled) return;
    // Reduced-motion holds glow steady-off (workers/AGVs already skip ramping),
    // so halos naturally stay hidden; nothing extra to do here.
    for (const h of this._glowSprites) {
      const ref = h.ref;
      const g = ref.glow || 0;
      const sp = h.sprite;
      if (g <= 0.01) { if (sp.visible) sp.visible = false; continue; }
      sp.visible = true;
      // Follow the agent's current ground position.
      const p = (h.kind === 'forklift') ? ref.group.position : ref.mesh.position;
      sp.position.x = p.x;
      sp.position.z = p.z;
      // Ramp opacity with a gentle gamma so low activity still reads as a glow
      // (linear g felt dim); peak a touch brighter to sell the pseudo-bloom.
      h.mat.opacity = Math.pow(g, 0.7) * 0.75;
      // Scale breathes with activity, plus a subtle organic time-based sine so a
      // steadily-working machine still feels alive. Reduced-motion (belts frozen)
      // drops the breathing for a fully static halo.
      let breath = 0;
      if (this._beltSpeed !== 0) {
        breath = Math.sin(this._clock.elapsedTime * 2.4 + h.base) * 0.05 * g;
      }
      const s = h.base * (0.85 + 0.25 * g + breath);
      sp.scale.set(s, s, 1);
    }
  }

  // -- Pick-event visualization ---------------------------------------------
  // When a worker's keyframe carries a `hit` ({run_id, along, sku, qty}) — the
  // best-effort nearest authored shelf cell it is reaching into (set in
  // render/replay.py) — we (a) PULSE-GLOW a small marker on the target cell and
  // (b) draw a thin connector from the picker's hand to that cell. This is the
  // "ピッカーが実 SKU ヒット箇所に歩いて取る" money shot. Markers/lines are POOLED
  // (one per worker, reused every frame — no per-frame allocation), reduced-motion
  // aware (no pulse, steady marker), and dropped entirely under fps pressure
  // (tier-3 degrade also disables this via `_glowEnabled`, sharing the halo gate).
  _buildPickFx() {
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
  }

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
    const y = Math.min(1.3, (r.dims.h || 2.0) * 0.45); // mid-reach height
    out.set(cx + nx * off, y, cz + nz * off);
    return out;
  }

  // Per-frame per-worker: drive the pick-event marker + connector for a worker's
  // current sample. Hidden unless the worker is picking AND carries a resolvable
  // hit. Pulses the marker opacity/scale (steady under reduced-motion) and points
  // the connector from the worker's hand to the target cell. Pooled + gated.
  _updatePickEvent(w, s, t) {
    const fx = this._pickFx && this._pickFx[w.idx];
    if (!fx) return;
    const showable = this._glowEnabled && s.state === 'pick' && s.hit;
    if (!showable) {
      if (fx.marker.visible) { fx.marker.visible = false; fx.line.visible = false; }
      return;
    }
    if (!fx._p) fx._p = new THREE.Vector3();
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
    // Connector: worker hand (approx shoulder + forward) → target cell.
    fx.line.visible = true;
    const wp = w.mesh.position;
    const hy = 1.2; // hand height
    // Hand a touch in front of the body along its facing.
    const hx = wp.x + Math.sin(w.faceYaw) * 0.3;
    const hz = wp.z + Math.cos(w.faceYaw) * 0.3;
    const arr = fx.lineGeom.attributes.position.array;
    arr[0] = hx; arr[1] = hy; arr[2] = hz;
    arr[3] = p.x; arr[4] = p.y; arr[5] = p.z;
    fx.lineGeom.attributes.position.needsUpdate = true;
    fx.lineMat.opacity = pulse * 0.55;
  }

  // -- Controls hint + scene legend (DOM overlay) ---------------------------
  // A small top-left panel that tells a non-technical salesperson (a) how to move
  // the camera ("ドラッグで回転 / ホイールで拡大") and (b) what the realistic racks,
  // agents and the amber pick-glow mean. The legend is data-driven (only rack
  // types / agents actually present are shown) and starts collapsed if the user
  // dismissed it before (localStorage). Pure DOM: never touches the three.js
  // render contract, mirrors the HUD's card styling, and is removed in dispose().
  _buildInfoOverlay() {
    this._info = null;
    // Container must be a positioning context for absolute children (the HUD may
    // already have set this; setting it again is harmless).
    try {
      const cs = window.getComputedStyle(this.container);
      if (cs && cs.position === 'static') this.container.style.position = 'relative';
    } catch (_e) { /* ignore */ }

    let collapsed = false;
    try { collapsed = localStorage.getItem('whsim-3d-legend') === 'off'; } catch (_e) { /* ignore */ }

    const root = document.createElement('div');
    root.className = 'whsim-info3d';
    root.style.cssText = [
      'position:absolute', 'left:10px', 'top:10px', 'z-index:5',
      'max-width:230px', 'padding:8px 10px', 'border-radius:8px',
      'background:rgba(15,20,29,0.72)', 'backdrop-filter:blur(4px)',
      'color:#e6edf3', 'font:11px/1.4 system-ui,-apple-system,sans-serif',
      'box-shadow:0 2px 10px rgba(0,0,0,0.35)',
      'border:1px solid rgba(0,184,212,0.25)',
    ].join(';');

    // Header: controls hint + a collapse/expand toggle ("?" ⇄ "×").
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px';
    const hint = document.createElement('div');
    hint.style.cssText = 'flex:1;color:#cfe8ef';
    hint.innerHTML = '<span style="color:#00b8d4;font-weight:600">操作</span>'
      + ' ドラッグで回転・ホイールで拡大';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.style.cssText = 'flex:none;width:20px;height:20px;line-height:1;padding:0;border:0;'
      + 'border-radius:5px;background:rgba(255,255,255,0.08);color:#cfe8ef;font-size:13px;cursor:pointer';
    head.appendChild(hint);
    head.appendChild(toggle);
    root.appendChild(head);

    // Body: the legend (rack types present + agent roles + pick glow).
    const body = document.createElement('div');
    body.style.cssText = 'margin-top:7px;display:flex;flex-direction:column;gap:4px';

    const swatchRow = (color, label, round) => {
      const r = document.createElement('div');
      r.style.cssText = 'display:flex;align-items:center;gap:7px';
      const sw = document.createElement('span');
      sw.style.cssText = `width:11px;height:11px;flex:0 0 auto;background:${color};`
        + `border-radius:${round ? '50%' : '3px'};box-shadow:inset 0 0 0 1px rgba(0,0,0,0.25)`;
      const tx = document.createElement('span');
      tx.style.cssText = 'color:#cdd6e0';
      tx.textContent = label;
      r.appendChild(sw); r.appendChild(tx);
      return r;
    };

    // Rack types actually present in this replay (dedup, in catalog order).
    const present = new Set((this.replay.shelves || []).map((s) => s.rack_type || RACK_DEFAULT));
    const rackKeys = Object.keys(RACK_LEGEND).filter((k) => present.has(k));
    if (rackKeys.length) {
      const cap = document.createElement('div');
      cap.style.cssText = 'color:#8b98a8;margin-top:1px';
      cap.textContent = '保管設備';
      body.appendChild(cap);
      for (const k of rackKeys) body.appendChild(swatchRow(RACK_LEGEND[k].sw, RACK_LEGEND[k].label, false));
    }

    // Agents present (workers/AGVs/forklifts) + the pick-event glow cue.
    // Swatch colours mirror the live agent colours in the scene (worker pick
    // state / AGV travel / forklift) so the legend reads true.
    const agents = [];
    if ((this.replay.workers || []).length) agents.push(['#33a02c', 'ピッカー（人）']);
    if ((this.replay.agvs || []).length) agents.push(['#1f78b4', 'AGV']);
    if ((this.replay.forklifts || []).length) agents.push(['#f57c00', 'フォークリフト']);
    if (agents.length) {
      const cap = document.createElement('div');
      cap.style.cssText = 'color:#8b98a8;margin-top:3px';
      cap.textContent = '作業者・搬送';
      body.appendChild(cap);
      for (const [c, l] of agents) body.appendChild(swatchRow(c, l, true));
    }
    // Pick-event glow: only meaningful when the replay carries pick targets.
    const hasPickFx = (this.replay.workers || []).some(
      (w) => Array.isArray(w.keyframes) && w.keyframes.some((kf) => kf && kf[4]));
    if (hasPickFx) {
      const cap = document.createElement('div');
      cap.style.cssText = 'color:#8b98a8;margin-top:3px';
      cap.textContent = '動き';
      body.appendChild(cap);
      body.appendChild(swatchRow('#ffe14d', 'ピック箇所が発光', false));
    }

    root.appendChild(body);
    this.container.appendChild(root);

    const apply = (isCollapsed) => {
      body.hidden = isCollapsed;
      toggle.textContent = isCollapsed ? '?' : '×';
      toggle.setAttribute('aria-label', isCollapsed ? '凡例を開く' : '凡例を閉じる');
      toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    };
    // If there's nothing to legend (no racks/agents), keep just the controls hint.
    const hasLegend = body.childElementCount > 0;
    if (!hasLegend) { toggle.style.display = 'none'; }
    else {
      toggle.onclick = () => {
        const next = !body.hidden;
        apply(next);
        try { localStorage.setItem('whsim-3d-legend', next ? 'off' : 'on'); } catch (_e) { /* ignore */ }
      };
    }
    apply(hasLegend ? collapsed : true);
    this._info = { root };
  }

  // -- Live productivity HUD (DOM overlay) ----------------------------------
  // Only built when replay.series exists & is non-empty. A small absolutely-
  // positioned panel inside the container with a sparkline (canvas 2D) and live
  // numeric readouts (done / rate / wip), synced to getTime() each frame. Does
  // NOT touch the three.js render — pure DOM, so it can never break the scene.
  _buildHud() {
    this._hud = null;
    const series = this.replay.series;
    if (!Array.isArray(series) || series.length === 0) return;
    // Container must be a positioning context for absolute children.
    try {
      const cs = window.getComputedStyle(this.container);
      if (cs && cs.position === 'static') this.container.style.position = 'relative';
    } catch (_e) { /* ignore */ }

    const root = document.createElement('div');
    root.className = 'whsim-hud3d';
    root.style.cssText = [
      'position:absolute', 'right:10px', 'bottom:10px', 'z-index:5',
      'width:220px', 'padding:8px 10px', 'border-radius:8px',
      'background:rgba(15,20,29,0.72)', 'backdrop-filter:blur(4px)',
      'color:#e6edf3', 'font:11px/1.35 system-ui,-apple-system,sans-serif',
      'pointer-events:none', 'box-shadow:0 2px 10px rgba(0,0,0,0.35)',
      'border:1px solid rgba(0,184,212,0.25)',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '生産性 (ライブ)';
    title.style.cssText = 'color:#00b8d4;font-weight:600;margin-bottom:4px;letter-spacing:.02em';
    root.appendChild(title);

    const canvas = document.createElement('canvas');
    const CW = 200, CH = 48;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = CW * dpr; canvas.height = CH * dpr;
    canvas.style.cssText = `width:${CW}px;height:${CH}px;display:block`;
    root.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const readout = document.createElement('div');
    readout.style.cssText = 'display:flex;justify-content:space-between;margin-top:5px;gap:6px';
    const mkStat = (label) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'text-align:center;flex:1';
      const v = document.createElement('div');
      v.style.cssText = 'font-size:14px;font-weight:700;color:#fff';
      v.textContent = '–';
      const l = document.createElement('div');
      l.style.cssText = 'font-size:9px;color:#8b98a8';
      l.textContent = label;
      wrap.appendChild(v); wrap.appendChild(l);
      readout.appendChild(wrap);
      return v;
    };
    const vDone = mkStat('完了');
    const vRate = mkStat('件/時');
    const vWip = mkStat('滞留');
    root.appendChild(readout);
    this.container.appendChild(root);

    // Precompute axis maxima once.
    let maxRate = 1, maxT = 0;
    for (const s of series) {
      if ((s.rate || 0) > maxRate) maxRate = s.rate;
      if ((s.t || 0) > maxT) maxT = s.t;
    }
    this._hud = {
      root, canvas, ctx, CW, CH, series, maxRate, maxT,
      vDone, vRate, vWip, lastIdx: -1, lastHeadX: -1,
    };
    this._drawHudSpark(); // initial static draw
  }

  // Draw the sparkline grid + filled rate curve (static part; the moving head is
  // overlaid each frame in _updateHud via a cheap redraw only when index moves).
  _drawHudSpark(headFrac) {
    const h = this._hud;
    if (!h) return;
    const { ctx, CW, CH, series, maxRate } = h;
    ctx.clearRect(0, 0, CW, CH);
    // baseline
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, CH - 0.5); ctx.lineTo(CW, CH - 0.5); ctx.stroke();
    const n = series.length;
    const xOf = (i) => (n <= 1 ? CW : (i / (n - 1)) * CW);
    const yOf = (r) => CH - 2 - (Math.max(0, r) / maxRate) * (CH - 4);
    // Filled area under the rate curve.
    ctx.beginPath();
    ctx.moveTo(0, CH);
    for (let i = 0; i < n; i++) ctx.lineTo(xOf(i), yOf(series[i].rate || 0));
    ctx.lineTo(CW, CH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, CH);
    grad.addColorStop(0, 'rgba(0,184,212,0.55)');
    grad.addColorStop(1, 'rgba(0,184,212,0.04)');
    ctx.fillStyle = grad;
    ctx.fill();
    // Curve stroke.
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xOf(i), y = yOf(series[i].rate || 0);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#00d4f0';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Playback head marker.
    if (typeof headFrac === 'number') {
      const hx = Math.max(0, Math.min(1, headFrac)) * CW;
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, CH); ctx.stroke();
    }
  }

  // Per-frame HUD sync: find the series bucket at the current playback time and
  // update the numeric readouts + head marker. Cheap: only repaints when the
  // bucket index or head position actually changes.
  _updateHud(t) {
    const h = this._hud;
    if (!h) return;
    const series = h.series;
    // Locate the latest bucket whose edge <= t (forward-fill).
    let idx = 0;
    for (let i = 0; i < series.length; i++) {
      if ((series[i].t || 0) <= t) idx = i; else break;
    }
    const headFrac = h.maxT > 0 ? Math.min(1, t / h.maxT) : 0;
    const headX = Math.round(headFrac * h.CW);
    if (idx !== h.lastIdx) {
      const s = series[idx] || {};
      h.vDone.textContent = (s.done != null) ? String(s.done) : '–';
      h.vRate.textContent = (s.rate != null) ? String(Math.round(s.rate)) : '–';
      h.vWip.textContent = (s.wip != null) ? String(s.wip) : '–';
      h.lastIdx = idx;
    }
    if (headX !== h.lastHeadX) {
      this._drawHudSpark(headFrac);
      h.lastHeadX = headX;
    }
  }

  // -- Intro camera move -----------------------------------------------------
  // One-shot gentle orbit/zoom into the overview preset on startup. Skipped when
  // the user prefers reduced motion. Tweens camera position only (target stays);
  // disables OrbitControls during the tween and restores afterwards so it never
  // fights user input. Any user interaction cancels it early.
  _startIntro() {
    this._intro = null;
    if (this._reducedMotion()) return;
    const cx = this.bounds.width / 2;
    const cz = this.bounds.depth / 2;
    const span = Math.max(this.bounds.width, this.bounds.depth);
    // Start: high, far, slightly rotated; End: the default framing set in ctor.
    const from = new THREE.Vector3(cx - span * 0.5, span * 1.6, cz + span * 1.6);
    const to = this.camera.position.clone();
    this.camera.position.copy(from);
    this.controls.enabled = false;
    const cancel = () => this._cancelIntro();
    this._introCancel = cancel;
    this.renderer.domElement.addEventListener('pointerdown', cancel, { once: true });
    this.renderer.domElement.addEventListener('wheel', cancel, { once: true, passive: true });
    this._intro = { from, to, start: (performance.now ? performance.now() : Date.now()), dur: 2200 };
  }

  _cancelIntro() {
    if (!this._intro) return;
    // Snap to the intended final framing and re-enable controls.
    this.camera.position.copy(this._intro.to);
    this._intro = null;
    if (this.controls) this.controls.enabled = true;
  }

  // Advance the intro tween; returns when finished (restoring controls).
  _updateIntro() {
    const it = this._intro;
    if (!it) return;
    const now = performance.now ? performance.now() : Date.now();
    let f = (now - it.start) / it.dur;
    if (f >= 1) { this._cancelIntro(); return; }
    f = Math.max(0, Math.min(1, f));
    const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2; // easeInOutQuad
    this.camera.position.lerpVectors(it.from, it.to, e);
  }

  // Per-frame: keep contact-shadow blobs under their agents.
  _updateContactShadows() {
    if (!this._shadowSprites || this._shadowSprites.length === 0) return;
    for (const s of this._shadowSprites) {
      const sp = s.sprite;
      if (s.kind === 'forklift') {
        const p = s.ref.group.position;
        sp.position.set(p.x, 0.04, p.z);
      } else {
        const p = s.ref.mesh.position;
        sp.position.set(p.x, 0.04, p.z);
      }
    }
  }

  // Per-frame: interpolate each worker (a human figure) — floor position, vest
  // state colour, working-glow ramp, the arm REACH on pick, the carried tote, a
  // facing yaw toward travel, and (if the frame carries a `hit`) the pick-event
  // viz on the reached shelf cell.
  _updateWorkers(t, dt) {
    const glowOn = this._beltSpeed !== 0; // reduced-motion → hold glow steady-off
    for (const w of this._workers) {
      const s = sampleKeyframes(w.keyframes, t);
      w.mesh.position.set(s.x, 0, s.y); // group anchored at floor (legs reach down)
      const color = STATE_COLOR[s.state] !== undefined ? STATE_COLOR[s.state] : STATE_COLOR.idle;
      // Ease state→state color over ~100ms (frame-rate-independent) so idle→travel
      // transitions don't pop. Target color cached on the entry (no per-frame new).
      if (!w._target) w._target = new THREE.Color();
      w._target.set(color);
      w.vestMat.color.lerp(w._target, 1 - Math.exp(-dt * 12));
      const active = (glowOn && ACTIVE_WORKER[s.state]) ? 1 : 0;
      w.glow = approach(w.glow, active, dt, 4);
      w.vestMat.emissiveIntensity = w.glow * 0.30;

      // Face the direction of travel (look-ahead sample), so the body + reaching
      // arm orient naturally. Hold the last yaw when essentially stationary.
      const ahead = sampleKeyframes(w.keyframes, t + 0.3);
      let vx = ahead.x - s.x, vz = ahead.y - s.y;
      if (vx * vx + vz * vz > 1e-5) w.faceYaw = Math.atan2(vx, vz);
      if (!w._qT) { w._qT = new THREE.Quaternion(); w._eT = new THREE.Euler(); }
      w._eT.set(0, w.faceYaw, 0);
      w._qT.setFromEuler(w._eT);
      w.mesh.quaternion.slerp(w._qT, 1 - Math.exp(-dt * 10));

      // Arm reach: ramp toward 1 while picking (swing the forearm up/forward),
      // back to rest otherwise. The pivot rotates about local X so the hand lifts.
      const reaching = (s.state === 'pick') ? 1 : 0;
      w.reach = approach(w.reach, reaching, dt, 6);
      if (w.armPivot) w.armPivot.rotation.x = -w.reach * 1.15; // up to ~66° forward

      // Carried tote: visible while carrying (種まき/搬送) — picks the held box.
      if (w.tote) w.tote.visible = (s.state === 'carry' || s.state === 'pack');

      // Pick-event viz: pulse the reached cell + draw a connector from the hand.
      this._updatePickEvent(w, s, t);
    }
  }

  // Per-frame: interpolate each AGV's position + action color (same sampler),
  // ramp its cyan working-glow up/down, and show the carried tote while hauling.
  _updateAgvs(t, dt) {
    for (const a of this._agvs) {
      const s = sampleKeyframes(a.keyframes, t);
      a.mesh.position.set(s.x, AGV_Y, s.y);
      const color = AGV_COLOR[s.state] !== undefined ? AGV_COLOR[s.state] : AGV_COLOR.idle;
      // Ease action→action color over ~100ms (frame-rate-independent), matching
      // the worker transition. Target color cached on the entry (no per-frame new).
      if (!a._target) a._target = new THREE.Color();
      a._target.set(color);
      a.mesh.material.color.lerp(a._target, 1 - Math.exp(-dt * 12));
      const active = ACTIVE_AGV[s.state] ? 1 : 0;
      a.glow = approach(a.glow, active, dt, 4);
      a.mat.emissiveIntensity = a.glow * 0.55;
      // Status dome tracks the action colour (always lit, so idle reads gray).
      if (a.domeMat) {
        if (!a._dT) a._dT = new THREE.Color();
        a._dT.set(color);
        a.domeMat.color.lerp(a._dT, 1 - Math.exp(-dt * 12));
        a.domeMat.emissive.copy(a.domeMat.color);
        a.domeMat.emissiveIntensity = 0.5 + a.glow * 0.4;
      }
      if (a.tote) {
        a.tote.visible = !!CARRY_AGV[s.state];
        a.tote.material.emissiveIntensity = a.glow * 0.35;
      }
    }
  }

  // Per-frame: interpolate each moving forklift's position (same sampler) and
  // yaw it toward its direction of travel using a small look-ahead sample.
  _updateForklifts(t, dt) {
    const glowOn = this._beltSpeed !== 0; // reduced-motion → hold glow off
    for (const f of this._forklifts) {
      const s = sampleKeyframes(f.keyframes, t);
      f.group.position.set(s.x, 0, s.y);
      // Estimate velocity by sampling slightly ahead; fall back to behind.
      let ahead = sampleKeyframes(f.keyframes, t + 0.25);
      let vx = ahead.x - s.x;
      let vz = ahead.y - s.y;
      if (vx * vx + vz * vz < 1e-6) {
        const behind = sampleKeyframes(f.keyframes, t - 0.25);
        vx = s.x - behind.x;
        vz = s.y - behind.y;
      }
      const moving = vx * vx + vz * vz > 1e-6;
      if (moving) {
        // Model's forks face +Z, so yaw rotates +Z onto (vx, vz). Only update the
        // target while actually moving (velocity ~0 → keep previous yaw, no NaN).
        f.yaw = Math.atan2(vx, vz);
      }
      // Slerp the group toward the target yaw over ~150–200ms instead of snapping.
      // Cache scratch quaternions on the entry so there is no per-frame alloc.
      if (!f._qTarget) { f._qTarget = new THREE.Quaternion(); f._eTarget = new THREE.Euler(); }
      f._eTarget.set(0, f.yaw, 0);
      f._qTarget.setFromEuler(f._eTarget);
      f.group.quaternion.slerp(f._qTarget, 1 - Math.exp(-dt * 8));
      // Drive the activity halo (forklifts have no emissive ramp of their own).
      const active = (glowOn && moving) ? 1 : 0;
      f.glow = approach(f.glow || 0, active, dt, 4);

      // Carry: raise the fork carriage + reveal its pallet load while hauling
      // (pickup/dropoff/travel/carry states). The lift ramps so forks glide up.
      const carrying = (CARRY_AGV[s.state] || s.state === 'carry') ? 1 : 0;
      f.lift = approach(f.lift || 0, carrying, dt, 5);
      if (f.carriage) f.carriage.position.y = 0.1 + f.lift * 1.0; // up to ~1.1m
      if (f.load) f.load.visible = f.lift > 0.15;
    }
  }

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
  }

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
  }

  _loop() {
    if (this._disposed) return;
    const t = this.getTime() || 0;
    // Frame delta (s), clamped so a backgrounded tab can't jump animations.
    const dt = Math.min(0.1, this._clock.getDelta());
    this._updateIntro();          // gentle one-shot camera move (if active)
    this._updateWorkers(t, dt);
    this._updateAgvs(t, dt);
    this._updateForklifts(t, dt);
    this._updateAsrs(t);          // patrol the AS/RS stacker crane (if any)
    this._updateStaging(t);
    this._updateBelts(dt);        // scroll conveyor tread textures (delta-based)
    this._updateContactShadows(); // keep blob shadows under moving agents
    this._updateGlowHalos();      // additive cyan activity halos (pseudo-bloom)
    this._updateHud(t);           // sync DOM productivity overlay (if present)
    this._monitorFps(dt);         // auto-degrade if frame time gets heavy
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this._raf = requestAnimationFrame(this._loop);
  }

  // -- FPS monitor / auto-degrade -------------------------------------------
  // Lightweight rolling-average frame timer. If sustained fps drops below a
  // floor, shed cost in a safe order. There is NO post-processing in this build
  // (no EffectComposer/Bloom vendored), so the only levers are: (1) stop the
  // conveyor belt texture scroll, (2) disable dynamic shadow updates, then (3)
  // drop the additive glow halos (the pseudo-bloom). All are additive/reversible
  // and never touch geometry or the data contract.
  _monitorFps(dt) {
    if (dt <= 0) return;
    const f = this._fps || (this._fps = {
      ema: 60, acc: 0, level: 0, savedBelt: this._beltSpeed,
    });
    // Exponential moving average of instantaneous fps.
    const inst = 1 / dt;
    f.ema = f.ema * 0.9 + inst * 0.1;
    // Only act after a short warm-up window of sustained low fps.
    if (f.ema < 30 && f.level < 3) {
      f.acc += dt;
      if (f.acc > 2.0) { this._degrade(f); f.acc = 0; }
    } else {
      f.acc = Math.max(0, f.acc - dt * 0.5);
    }
  }

  // Shed one tier of cost (belts → shadows → glow halos). Reduced-motion already
  // froze belts, so this mainly drops shadow updates / halos on weak GPUs.
  _degrade(f) {
    if (f.level === 0) {
      // Tier 1: freeze conveyor scroll (cheapest visual to lose).
      this._beltSpeed = 0;
      f.level = 1;
    } else if (f.level === 1) {
      // Tier 2: stop updating cast shadows (keeps the last shadow frame static).
      if (this.renderer) this.renderer.shadowMap.autoUpdate = false;
      f.level = 2;
    } else if (f.level === 2) {
      // Tier 3: drop the additive glow halos and hide any showing now.
      this._glowEnabled = false;
      for (const h of this._glowSprites) { if (h.sprite) h.sprite.visible = false; }
      f.level = 3;
    }
  }

  resize() {
    if (this._disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    // Cancel the pending frame and null the handle so no zombie RAF can survive.
    // The loop also bails on this._disposed before re-requesting, so a frame that
    // fired between cancel and this flag set will exit without rescheduling.
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    // Cancel any pending intro tween + its one-shot listeners.
    if (this._introCancel && this.renderer && this.renderer.domElement) {
      this.renderer.domElement.removeEventListener('pointerdown', this._introCancel);
      this.renderer.domElement.removeEventListener('wheel', this._introCancel);
    }
    this._intro = null;
    this._introCancel = null;
    // Remove the DOM HUD overlay (no GPU resources; pure DOM).
    if (this._hud && this._hud.root && this._hud.root.parentNode) {
      this._hud.root.parentNode.removeChild(this._hud.root);
    }
    this._hud = null;
    // Remove the controls-hint + legend DOM overlay (pure DOM, no GPU resources).
    if (this._info && this._info.root && this._info.root.parentNode) {
      this._info.root.parentNode.removeChild(this._info.root);
    }
    this._info = null;
    // Remove contact-shadow sprites (their materials are tracked in _materials,
    // the shared blob texture in _textures — both freed below).
    for (const s of this._shadowSprites) {
      if (s && s.sprite) this.scene.remove(s.sprite);
    }
    this._shadowSprites = [];
    // Remove additive glow halos (their SpriteMaterials are tracked in
    // _materials, the shared glow CanvasTexture in _textures — both freed below).
    for (const h of this._glowSprites) {
      if (h && h.sprite) this.scene.remove(h.sprite);
    }
    this._glowSprites = [];
    this._glowTex = null;
    // Remove pooled pick-event markers/lines (their materials/geometries are
    // tracked in _materials/_geometries — freed below; just drop scene refs).
    for (const fx of (this._pickFx || [])) {
      if (fx.marker) this.scene.remove(fx.marker);
      if (fx.line) this.scene.remove(fx.line);
    }
    this._pickFx = [];
    if (this._asrsCrane && this._asrsCrane.group) this.scene.remove(this._asrsCrane.group);
    this._asrsCrane = null;
    this._shelfRuns = [];
    this._sc = null;
    this._heat = null;
    if (this.controls) this.controls.dispose();
    for (const g of this._geometries) { if (g && g.dispose) g.dispose(); }
    for (const m of this._materials) { if (m && m.dispose) m.dispose(); }
    for (const t of this._textures) { if (t && t.dispose) t.dispose(); }
    this._geometries = [];
    this._materials = [];
    this._textures = [];
    for (const mat of this._staffMats) { if (mat && mat.dispose) mat.dispose(); }
    this._workers = [];
    this._agvs = [];
    this._forklifts = [];
    this._staffMeshes = [];
    this._staffMats = [];
    this._rackMaterials = [];
    // Belt mats/textures are tracked in _materials/_textures (freed above); just
    // drop the per-frame update list + fps state so nothing dangles.
    this._belts = [];
    this._fps = null;
    if (this.renderer) {
      this.renderer.dispose();
      const el = this.renderer.domElement;
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
  }
}

// Frame-rate-independent exponential approach of `cur` toward `target`.
// `rate` is the responsiveness (larger = snappier). Used to ramp emissive glow
// up/down smoothly without per-frame allocation. Safe for dt<=0 / NaN.
function approach(cur, target, dt, rate) {
  if (!(dt > 0)) return cur;
  const k = 1 - Math.exp(-rate * dt);
  return cur + (target - cur) * k;
}

// Read meta.grid_m defensively, defaulting to 1m.
function meta_grid(replay) {
  const g = replay && replay.meta && replay.meta.grid_m;
  return g && g > 0 ? g : 1;
}

// Flag every mesh under an object3D to cast and receive shadows.
function _enableShadows(obj) {
  obj.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}
