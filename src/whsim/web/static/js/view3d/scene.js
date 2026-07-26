// view3d/scene.js — Scene3D's static environment + art presets.
//
// This is the RENDERER/ENVIRONMENT lane: everything that makes the replay read as
// a photographed building rather than a flat diagram.
//   * image-based lighting — a procedural "high-bay room" is baked through
//     PMREMGenerator into `scene.environment`, so every MeshStandardMaterial in
//     the scene (racks, AGVs, conveyors, the shell) gets real specular response
//     instead of a lambert wash. This is the single biggest realism win and it
//     costs one off-screen bake at mount, nothing per frame.
//   * a believable high-bay light rig — key (shadow-casting, with an
//     orthographic frustum FITTED to the building AABB so shadow texels are
//     dense), soft fill, weak upward bounce, hemisphere + ambient floor, and a
//     grid of emissive high-bay fixtures hanging off the roof steel.
//   * the building shell — clear-height roof deck, open-web joists on girders,
//     a column grid that dodges the rack runs, perimeter sandwich-panel walls,
//     sectional dock doors with bumpers + levellers, and skylight strips. The
//     roof deck and the wall panels are SINGLE-SIDED and face inward, so the
//     building is an automatic cutaway: from outside/above you look straight in,
//     from inside you are in a real warehouse.
//   * floor realism — procedural concrete (albedo + roughness + a normal map
//     derived from it) plus a separate world-aligned decal carrying the painted
//     safety markings (rack footprint lines, zone outlines, dock keep-clear
//     hatching, a green pedestrian loop) generated from the actual layout.
//   * atmosphere — an outdoor apron + distance fog tuned per preset so a large
//     floor dissolves into the horizon instead of floating in a void.
//
// Everything is additive and guarded: a bare model with no walls, doors, zones
// or shelves still renders (it just gets fewer props). setPreset() remains the
// only method that mutates a live render, and it still touches lights / fog /
// exposure / material intensities ONLY — never geometry. Mixed into
// Scene3D.prototype by view3d.js; every method runs with `this` bound to the
// Scene3D instance.
import * as THREE from '../../vendor/three/three.module.js';
import { FLOOR_TONES, PRESETS, meta_grid, rackDims } from './constants.js';

// ---------------------------------------------------------------------------
// Art direction extension table.
//
// The shared PRESETS table lives in constants.js (owned by another lane) and
// carries background/fog/hemi/ambient/dir/exposure/rackEmissive. Realistic
// rendering needs more knobs — environment intensity, fixture brightness, fog
// distances, shell tints — so they live here, keyed by the SAME preset ids and
// merged on top. An unknown preset id falls back to ART_BASE, so presets can
// never break the scene.
// ---------------------------------------------------------------------------
// FOG NOTE (the single biggest cause of the "brand renders almost black" merge
// regression): fogNear/fogFar are multiples of the building span, but the DEFAULT
// CAMERA sits at a distance derived from a frame FIT (frameDefault), not from a
// span multiple. On a wide canvas that fit lands past the old fogNear, so the
// whole warehouse was rendered ~40% blended into a near-black fog colour before
// tone mapping ever ran. setPreset() now clamps the fog band to start behind the
// hero framing, so fog does what it is for — dissolving the outdoor apron and the
// far end of a long aisle — and never greys out the subject.
const ART_BASE = {
  env: 0.55,          // scene.environment intensity multiplier
  exposure: null,     // null = use PRESETS[..].exposure verbatim
  fogNear: 1.05,      // x span (floor; the hero-distance clamp may push it out)
  fogFar: 3.4,        // x span
  // Rebalance factors on the shared PRESETS intensities. The stock values were
  // tuned for a flat hemi+ambient wash; once IBL carries the ambient term they
  // have to come DOWN or the key light has nothing to contrast against and no
  // shadow is readable. Kept as MULTIPLIERS so the shared table stays the single
  // source of truth for colour. Rule of thumb: key ≈ 1.4x the sum of all the
  // ambient terms, which puts shadowed faces near 40% of lit — a real interior.
  hemiScale: 0.32, ambScale: 0.28, dirScale: 1.65,
  fillColor: 0xbcd2ea, fillInt: 0.20,
  bounceColor: 0xffe6c8, bounceInt: 0.10,
  // Procedural IBL room: ceiling strip / wall / floor luminance + tint.
  roomStrip: 0xffffff, roomStripInt: 6.0,
  roomWall: 0x8d97a6, roomWallInt: 1.0,
  roomFloor: 0x2b3038,
  // Building shell tints.
  wall: 0xa2aab3, curb: 0x6d747c, ceil: 0xb8bec5, ceilEmissive: 0.05,
  steel: 0x767d87, column: 0x9aa1a9, parapet: 0x8f969e,
  fixture: 4.2,       // emissive intensity of the high-bay lens
  skylight: 0.9,      // skylight strip brightness
  points: 0,          // real PointLights hung in the fixture grid (perf-gated)
  floorTint: 0x9aa0a7, // multiplies the concrete albedo
  mark: 0.85,         // painted-marking decal opacity
  grid: 0.10,         // CAD grid opacity
  apron: 0x3a4048,    // outdoor ground colour
};

// Re-tuned against the MERGED materials (painted-steel uprights at metalness
// 0.18, galvanised decking at 0.9, matte kraft cartons, hi-vis agents). Every
// preset is checked at BOTH framings that matter — the hero overview and an
// interior aisle — and none may fall to a near-black plate.
const ART = {
  // ブランド — dark, cinematic hall; the fixtures do most of the work. The one
  // that shipped near-black: fog started at 0.55·span (in FRONT of the hero
  // camera), the key was the weakest of any preset, and the shell/floor tints
  // were only a few levels above the background. All three are corrected here.
  brand: {
    env: 0.98, exposure: 1.32,
    fogNear: 1.10, fogFar: 3.8,
    hemiScale: 0.58, ambScale: 0.58, dirScale: 2.00,
    fillColor: 0x8fb4de, fillInt: 0.30,
    bounceColor: 0x51739c, bounceInt: 0.16,
    roomStrip: 0xdcefff, roomStripInt: 6.2,
    roomWall: 0x4a5666, roomWallInt: 1.05, roomFloor: 0x11171f,
    wall: 0x5d6875, curb: 0x39424d, ceil: 0x3e4854, ceilEmissive: 0.10,
    steel: 0x6d7887, column: 0x6b7684, parapet: 0x4c5764,
    fixture: 7.0, skylight: 0.55, points: 0,
    floorTint: 0x6d7783, mark: 0.80, grid: 0.16, apron: 0x171f2c,
  },
  // ナチュラル (昼) — daylight high-bay, the neutral "photo" preset.
  natural: {
    env: 0.64, exposure: 0.96,
    fogNear: 1.20, fogFar: 4.2,
    hemiScale: 0.34, ambScale: 0.30, dirScale: 1.74,
    fillColor: 0xcfe0f2, fillInt: 0.22,
    bounceColor: 0xffeacd, bounceInt: 0.12,
    roomStrip: 0xffffff, roomStripInt: 6.5,
    roomWall: 0x9aa4b2, roomWallInt: 1.05, roomFloor: 0x3a3f46,
    wall: 0xa6aeb8, curb: 0x6b727a, ceil: 0xb2b8bf, ceilEmissive: 0.05,
    steel: 0x8d949d, column: 0x9aa2aa, parapet: 0x929aa3,
    fixture: 3.0, skylight: 0.75, points: 0,
    floorTint: 0xa1a6ad, mark: 0.92, grid: 0.09, apron: 0x4d545c,
  },
  // 夕 — low warm key raking through the skylights.
  evening: {
    env: 0.76, exposure: 1.18,
    fogNear: 1.00, fogFar: 3.5,
    hemiScale: 0.44, ambScale: 0.50, dirScale: 1.70,
    fillColor: 0xffb27a, fillInt: 0.24,
    bounceColor: 0xff9a5c, bounceInt: 0.18,
    roomStrip: 0xffd9a8, roomStripInt: 5.4,
    roomWall: 0x7a5e70, roomWallInt: 1.0, roomFloor: 0x281d28,
    wall: 0x8f7885, curb: 0x54424e, ceil: 0x6c5765, ceilEmissive: 0.09,
    steel: 0x8a7583, column: 0x927a87, parapet: 0x765f6c,
    fixture: 5.5, skylight: 0.7, points: 0,
    floorTint: 0x8a7681, mark: 0.75, grid: 0.08, apron: 0x2f232d,
  },
  // 夜 (ドラマチック) — the hall is lit by its own fixtures only.
  night: {
    env: 0.72, exposure: 1.30,
    fogNear: 0.95, fogFar: 3.2,
    hemiScale: 0.60, ambScale: 0.74, dirScale: 1.25,
    fillColor: 0x7d97c4, fillInt: 0.16,
    bounceColor: 0x46679a, bounceInt: 0.12,
    roomStrip: 0xcfe6ff, roomStripInt: 5.0,
    roomWall: 0x33405e, roomWallInt: 0.9, roomFloor: 0x080d16,
    wall: 0x414c65, curb: 0x252d3c, ceil: 0x2d3648, ceilEmissive: 0.13,
    steel: 0x53607a, column: 0x56617a, parapet: 0x3a4459,
    fixture: 9.0, skylight: 0.35, points: 3,
    floorTint: 0x4d5769, mark: 0.62, grid: 0.13, apron: 0x0b121d,
  },
  // モノ (図面風) — flat, even, drawing-like: strong grid, no drama.
  mono: {
    env: 0.50, exposure: 1.00,
    fogNear: 1.60, fogFar: 5.0,
    hemiScale: 0.62, ambScale: 0.7, dirScale: 1.05,
    fillColor: 0xdfe4ea, fillInt: 0.30,
    bounceColor: 0xdfe4ea, bounceInt: 0.16,
    roomStrip: 0xffffff, roomStripInt: 4.0,
    roomWall: 0xc8d0da, roomWallInt: 1.3, roomFloor: 0x9aa2ac,
    wall: 0xd2d8de, curb: 0xacb3bb, ceil: 0xe4e8ec, ceilEmissive: 0.10,
    steel: 0xa9b0b8, column: 0xc2c8cf, parapet: 0xbcc3ca,
    fixture: 1.6, skylight: 1.0, points: 0,
    floorTint: 0xd4d9de, mark: 0.55, grid: 0.42, apron: 0xc2c8ce,
  },
};

function art(name) {
  return Object.assign({}, ART_BASE, ART[name] || ART.natural);
}

const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

// Small deterministic PRNG (mulberry32) so the procedural concrete/panel textures
// are identical between mounts — no "the floor changed" flicker on remount.
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w));
  c.height = Math.max(2, Math.round(h));
  return { c, ctx: c.getContext('2d') };
}

export const sceneMethods = {
  // -- image-based lighting --------------------------------------------------
  // Bake a tiny procedural room (bright ceiling strips over neutral walls and a
  // dark floor) into a PMREM environment map. No addon needed: the "room" is
  // eight boxes built here, rendered once, then thrown away. Result is assigned
  // to scene.environment, which every MeshStandardMaterial picks up for free.
  //
  // Guarded end to end: if PMREMGenerator is unavailable or the bake throws
  // (context loss on a weak GPU), the scene simply renders without IBL.
  _buildEnvironment() {
    this._envRT = null;
    if (!this.renderer || typeof THREE.PMREMGenerator !== 'function') return;
    const a = art(this._preset);
    const room = new THREE.Scene();
    const junkG = [];
    const junkM = [];
    // Emissive panel: MeshBasicMaterial whose colour is pushed ABOVE 1 so the
    // half-float PMREM target captures it as a real HDR source (this is how the
    // stock RoomEnvironment fakes area lights).
    const panel = (w, h, d, x, y, z, hex, intensity) => {
      const g = new THREE.BoxGeometry(w, h, d);
      const m = new THREE.MeshBasicMaterial();
      m.color.setHex(hex).multiplyScalar(intensity);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      room.add(mesh);
      junkG.push(g); junkM.push(m);
      return mesh;
    };
    // The enclosing box, seen from the inside.
    {
      const g = new THREE.BoxGeometry(24, 13, 24);
      const m = new THREE.MeshStandardMaterial({
        side: THREE.BackSide, roughness: 1.0, metalness: 0.0,
      });
      m.color.setHex(a.roomWall).multiplyScalar(a.roomWallInt);
      const mesh = new THREE.Mesh(g, m);
      room.add(mesh);
      junkG.push(g); junkM.push(m);
    }
    // Darker floor slab: keeps the lower hemisphere from washing everything out
    // and gives verticals a believable top-lit gradient.
    panel(24, 0.4, 24, 0, -6.3, 0, a.roomFloor, 1.0);
    // Four ceiling strips = the long specular streaks you see on real racking.
    for (let i = 0; i < 4; i++) {
      panel(20, 0.3, 1.8, 0, 5.9, -7.5 + i * 5, a.roomStrip, a.roomStripInt);
    }
    // Two soft side panels for wrap-around fill, one warmer accent behind.
    panel(0.3, 7, 18, -11.4, 0.5, 0, a.roomStrip, a.roomStripInt * 0.16);
    panel(0.3, 7, 18, 11.4, 0.5, 0, a.roomStrip, a.roomStripInt * 0.12);
    panel(18, 6, 0.3, 0, 0.0, -11.4, a.roomStrip, a.roomStripInt * 0.08);

    let rt = null;
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      rt = pmrem.fromScene(room, 0.035, 0.1, 120);
      pmrem.dispose();   // the generator's scratch targets; `rt` survives
    } catch (_e) {
      rt = null;
    }
    for (const g of junkG) g.dispose();
    for (const m of junkM) m.dispose();
    if (rt && rt.texture) {
      this.scene.environment = rt.texture;
      this._envRT = rt;   // freed by Scene3D.dispose()
    }
  },

  // Re-apply the active preset's environment intensity to every lit material in
  // the scene. Called from setPreset (rare), so a full traverse is cheap and is
  // always correct even for materials other lanes add later.
  _applyEnvIntensity(k) {
    if (!this.scene) return;
    this.scene.traverse((obj) => {
      const mats = obj.material;
      if (!mats) return;
      const list = Array.isArray(mats) ? mats : [mats];
      for (const m of list) {
        if (!m || m.envMapIntensity === undefined) continue;
        if (m.userData && m.userData.noEnv) { m.envMapIntensity = 0; continue; }
        const scale = (m.userData && m.userData.envScale) || 1;
        m.envMapIntensity = k * scale;
        m.needsUpdate = false;
      }
    });
  },

  // -- building metrics ------------------------------------------------------
  // Clear height (m) under the roof steel, derived from the tallest storage
  // equipment in the model and bounded to values a real DC would build.
  _clearHeight() {
    if (this._ceilH) return this._ceilH;
    let tall = 2.4;
    for (const run of (this.replay.shelves || [])) {
      const d = rackDims(run && run.rack_type);
      if (d && d.h > tall) tall = d.h;
    }
    for (const e of (this.replay.equipment || [])) {
      if (e && (e.type === 'asrs' || e.type === 'crane')) tall = Math.max(tall, 12);
    }
    const shortSide = Math.max(6, Math.min(this.bounds.width, this.bounds.depth));
    this._ceilH = Math.min(
      clamp(tall + 4.2, 8.5, 26),
      Math.max(7.0, shortSide * 0.6),
    );
    return this._ceilH;
  },

  // Envelope segments [{x0,z0,x1,z1}] + the interior centroid. Prefers the
  // authored wall polylines; falls back to the layout bounds rectangle so a bare
  // model still gets a building.
  _envelope() {
    if (this._env) return this._env;
    const { width, depth } = this.bounds;
    const segs = [];
    for (const wall of (this.replay.walls || [])) {
      const pts = wall && wall.points;
      if (!Array.isArray(pts)) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        if (!p0 || !p1) continue;
        const x0 = +p0[0] || 0, z0 = +p0[1] || 0;
        const x1 = +p1[0] || 0, z1 = +p1[1] || 0;
        if (Math.hypot(x1 - x0, z1 - z0) < 0.05) continue;
        segs.push({ x0, z0, x1, z1 });
      }
    }
    if (segs.length === 0) {
      segs.push(
        { x0: 0, z0: 0, x1: width, z1: 0 },
        { x0: width, z0: 0, x1: width, z1: depth },
        { x0: width, z0: depth, x1: 0, z1: depth },
        { x0: 0, z0: depth, x1: 0, z1: 0 },
      );
    }
    this._env = { segs, cx: width / 2, cz: depth / 2 };
    return this._env;
  },

  // Rack footprints (world rects) used to keep columns and floor paint out of
  // the racking. A deliberately simple mirror of geometry.js's run frame — this
  // only decides where paint and pillars go, never what gets built.
  _obstacleRects() {
    if (this._obstacles) return this._obstacles;
    const out = [];
    for (const run of (this.replay.shelves || [])) {
      if (!run) continue;
      if (run.rect && typeof run.rect.w === 'number') {
        out.push({ x: +run.rect.x || 0, y: +run.rect.y || 0,
          w: Math.max(0.2, +run.rect.w || 0), h: Math.max(0.2, +run.rect.h || 0) });
        continue;
      }
      const ya = +run.y0 || 0;
      const yb = +run.y1 || 0;
      const d = Math.max(0.3, +run.depth || 0.6);
      out.push({
        x: (+run.x || 0) - d / 2, y: Math.min(ya, yb),
        w: d, h: Math.max(0.3, Math.abs(yb - ya)),
      });
    }
    if (out.length === 0) {
      for (const r of (this.replay.racks || [])) {
        if (!r) continue;
        out.push({ x: (+r.x || 0) - 0.6, y: (+r.y || 0) - 0.6, w: 1.2, h: 1.2 });
      }
    }
    this._obstacles = out;
    return out;
  },

  _hitsObstacle(x, z, pad) {
    for (const r of this._obstacleRects()) {
      if (x > r.x - pad && x < r.x + r.w + pad
        && z > r.y - pad && z < r.y + r.h + pad) return true;
    }
    return false;
  },

  // -- lighting rig ----------------------------------------------------------
  _buildLights() {
    const a = art(this._preset);
    const p = PRESETS[this._preset] || PRESETS.natural;
    const { width, depth } = this.bounds;
    const span = Math.max(width, depth);
    const cx = width / 2;
    const cz = depth / 2;

    // Hemisphere: sky over ground, the base ambient wrap. Refs kept for presets.
    const hemi = new THREE.HemisphereLight(p.hemiSky, p.hemiGround, p.hemiInt * a.hemiScale);
    hemi.position.set(cx, this._clearHeight() * 2, cz);
    this.scene.add(hemi);
    this._hemi = hemi;

    // A touch of pure ambient so shadowed sides never go fully flat-dark.
    const ambient = new THREE.AmbientLight(p.ambient, p.ambientInt * a.ambScale);
    this.scene.add(ambient);
    this._ambient = ambient;

    // KEY: a high, slightly off-axis sun. Elevation ~53°, raking across the
    // aisles so racks read as volumes and cast long, legible shadows.
    const dir = new THREE.DirectionalLight(p.dirColor, p.dirInt * a.dirScale);
    const L = new THREE.Vector3(0.42, 0.80, 0.43).normalize().multiplyScalar(span * 1.15);
    dir.position.set(cx + L.x, Math.max(this._clearHeight() * 1.6, L.y), cz + L.z);
    dir.target.position.set(cx, 0, cz);
    dir.castShadow = true;
    const size = this._shadowMapSize();
    dir.shadow.mapSize.set(size, size);
    this.scene.add(dir);
    this.scene.add(dir.target);
    dir.target.updateMatrixWorld();
    this._dir = dir;
    this._fitShadow(dir);

    // FILL: opposite side, no shadow, cool — opens up the dark faces.
    const fill = new THREE.DirectionalLight(a.fillColor, a.fillInt);
    fill.position.set(cx - width * 0.7, this._clearHeight() * 2.4, cz - depth * 0.8);
    fill.target.position.set(cx, 0, cz);
    this.scene.add(fill);
    this.scene.add(fill.target);
    this._fill = fill;

    // BOUNCE: weak up-light standing in for floor bounce onto rack undersides.
    const bounce = new THREE.DirectionalLight(a.bounceColor, a.bounceInt);
    bounce.position.set(cx, -span * 0.35, cz + depth * 0.2);
    bounce.target.position.set(cx, this._clearHeight() * 0.6, cz);
    this.scene.add(bounce);
    this.scene.add(bounce.target);
    this._bounce = bounce;

    this._pointLights = [];
  },

  // Shadow map resolution: dense enough for a 100 m floor, capped by the GPU.
  // Kept at 2048 by default — combined with the fitted frustum below that is
  // ~6 cm per texel on a 108 m building, which is finer than any rack member.
  _shadowMapSize() {
    const cap = (this.renderer && this.renderer.capabilities
      && this.renderer.capabilities.maxTextureSize) || 2048;
    return Math.min(cap, 2048);
  },

  // Fit the key light's orthographic shadow frustum TIGHTLY around the building
  // AABB (floor rect × clear height) in light space. A fixed square frustum
  // wastes most of its texels on empty apron; this spends them all on the
  // building, which is what actually kills both shadow acne and blockiness.
  // Bias/normalBias are derived from the resulting world-space texel size.
  _fitShadow(dir) {
    const { width, depth } = this.bounds;
    const h = this._clearHeight() + 2.5;
    const cam = dir.shadow.camera;
    const view = new THREE.Matrix4();
    view.lookAt(dir.position, dir.target.position, new THREE.Vector3(0, 1, 0));
    view.setPosition(dir.position);
    view.invert();   // world -> light space
    const v = new THREE.Vector3();
    const pad = 2.5;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const x of [-pad, width + pad]) {
      for (const y of [-1.0, h]) {
        for (const z of [-pad, depth + pad]) {
          v.set(x, y, z).applyMatrix4(view);
          if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
          if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
          if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
        }
      }
    }
    cam.left = minX; cam.right = maxX;
    cam.bottom = minY; cam.top = maxY;
    // The light looks down its -Z, so visible depth runs from -maxZ to -minZ.
    cam.near = Math.max(0.5, -maxZ - 1);
    cam.far = Math.max(cam.near + 1, -minZ + 1);
    cam.updateProjectionMatrix();
    // World size of one shadow texel drives the peter-panning-free bias pair.
    const texel = (maxX - minX) / Math.max(1, dir.shadow.mapSize.x);
    dir.shadow.bias = -0.00035;
    dir.shadow.normalBias = clamp(texel * 1.6, 0.02, 0.35);
    dir.shadow.radius = 2.2;   // used by PCF/VSM filtering
  },

  // -- procedural floor ------------------------------------------------------
  // Concrete albedo: mottled slab with fine aggregate speckle and saw-cut
  // expansion joints along the tile edges. Seamless-ish (blobs near an edge are
  // redrawn wrapped) and tiled to one repeat per `tileM` metres.
  _makeFloorTexture(tileM) {
    const S = 1024;
    const { c, ctx } = canvas2d(S, S);
    const rand = rng(0x5eed10);
    ctx.fillStyle = '#b7bbc0';
    ctx.fillRect(0, 0, S, S);
    // Low-frequency mottling: soft radial blobs, half lighter / half darker.
    const blob = (x, y, r, light, alpha) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const col = light ? '255,255,255' : '70,76,84';
      g.addColorStop(0, `rgba(${col},${alpha})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    for (let i = 0; i < 460; i++) {
      const r = 22 + rand() * 155;
      const x = rand() * S;
      const y = rand() * S;
      const light = rand() > 0.48;
      const alpha = 0.05 + rand() * 0.12;
      blob(x, y, r, light, alpha);
      // Wrap copies so the tile stays seamless at its edges.
      if (x < r) blob(x + S, y, r, light, alpha);
      if (x > S - r) blob(x - S, y, r, light, alpha);
      if (y < r) blob(x, y + S, r, light, alpha);
      if (y > S - r) blob(x, y - S, r, light, alpha);
    }
    // Fine aggregate speckle (per-pixel, cheap single pass).
    const img = ctx.getImageData(0, 0, S, S);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() - 0.5) * 22;
      d[i] = clamp(d[i] + n, 0, 255);
      d[i + 1] = clamp(d[i + 1] + n, 0, 255);
      d[i + 2] = clamp(d[i + 2] + n, 0, 255);
    }
    ctx.putImageData(img, 0, 0);
    // Saw-cut expansion joints on the tile seam + their bright arris.
    ctx.strokeStyle = 'rgba(48,53,60,0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(1.5, 0); ctx.lineTo(1.5, S);
    ctx.moveTo(0, 1.5); ctx.lineTo(S, 1.5);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(4.5, 0); ctx.lineTo(4.5, S);
    ctx.moveTo(0, 4.5); ctx.lineTo(S, 4.5);
    ctx.stroke();

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    const reps = Math.max(1, Math.round(Math.max(this.bounds.width, this.bounds.depth) / tileM));
    tex.repeat.set(reps, reps);
    tex.anisotropy = this._maxAniso();
    this._textures.push(tex);
    this._floorCanvas = c;   // reused as the height source for the normal map
    return tex;
  },

  _maxAniso() {
    const f = this.renderer && this.renderer.capabilities
      && this.renderer.capabilities.getMaxAnisotropy;
    return f ? Math.min(f.call(this.renderer.capabilities), 16) : 1;
  },

  // Roughness map: polished/burnished patches over a matte slab, joints rougher.
  // DATA map — stays in linear space (never tagged sRGB).
  _makeFloorRoughness(tileM) {
    const S = 512;
    const { c, ctx } = canvas2d(S, S);
    const rand = rng(0xb00c1e);
    ctx.fillStyle = '#b4b4b4';   // ~0.70 roughness base
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 180; i++) {
      const r = 30 + rand() * 130;
      const x = rand() * S;
      const y = rand() * S;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      // Burnished (smoother = darker roughness) vs worn (rougher = lighter).
      // The smooth end goes low enough (~0.38) that power-washed patches pick up
      // a broad reflection of the high-bay fixtures — the tell of real concrete.
      const v = rand() > 0.5 ? '40,40,40' : '225,225,225';
      g.addColorStop(0, `rgba(${v},${0.2 + rand() * 0.4})`);
      g.addColorStop(1, `rgba(${v},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';   // joints read rough
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(1.5, 0); ctx.lineTo(1.5, S);
    ctx.moveTo(0, 1.5); ctx.lineTo(S, 1.5);
    ctx.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    if ('colorSpace' in tex) tex.colorSpace = THREE.NoColorSpace;
    const reps = Math.max(1, Math.round(Math.max(this.bounds.width, this.bounds.depth) / tileM));
    tex.repeat.set(reps, reps);
    tex.anisotropy = this._maxAniso();
    this._textures.push(tex);
    this._roughCanvas = c;
    return tex;
  },

  // Normal map derived by Sobel from the roughness slab, so the bumps and the
  // gloss variation agree (physically plausible and free of a second noise
  // field). Deliberately shallow — concrete is nearly flat.
  _makeFloorNormal(tileM) {
    const src = this._roughCanvas;
    if (!src) return null;
    const S = src.width;
    let hs;
    try {
      hs = src.getContext('2d').getImageData(0, 0, S, S).data;
    } catch (_e) { return null; }
    const { c, ctx } = canvas2d(S, S);
    const out = ctx.createImageData(S, S);
    const o = out.data;
    const at = (x, y) => hs[(((y + S) % S) * S + ((x + S) % S)) * 4] / 255;
    const STRENGTH = 2.4;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * STRENGTH;
        const dy = (at(x, y + 1) - at(x, y - 1)) * STRENGTH;
        // Normalise (-dx, -dy, 1) into 0..255.
        const len = Math.sqrt(dx * dx + dy * dy + 1);
        const i = (y * S + x) * 4;
        o[i] = ((-dx / len) * 0.5 + 0.5) * 255;
        o[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
        o[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
        o[i + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    if ('colorSpace' in tex) tex.colorSpace = THREE.NoColorSpace;
    const reps = Math.max(1, Math.round(Math.max(this.bounds.width, this.bounds.depth) / tileM));
    tex.repeat.set(reps, reps);
    tex.anisotropy = this._maxAniso();
    this._textures.push(tex);
    return tex;
  },

  // Painted floor markings, drawn in WORLD coordinates onto one non-tiling decal
  // so every line lands exactly on the layout it describes: rack footprint
  // lines, zone outlines, dock keep-clear hatching and a green pedestrian loop.
  // Absent zones/doors/shelves simply mean fewer marks — never an error.
  _makeMarkingTexture() {
    const { width, depth } = this.bounds;
    const ppm = clamp(2048 / Math.max(width, depth, 1), 6, 26);
    const W = Math.min(2048, Math.round(width * ppm));
    const H = Math.min(2048, Math.round(depth * ppm));
    const { c, ctx } = canvas2d(W, H);
    const sx = W / Math.max(1, width);
    const sz = H / Math.max(1, depth);
    const px = (m) => m * sx;      // metres -> canvas px (x)
    const pz = (m) => m * sz;      // metres -> canvas px (z)
    const lw = (m) => Math.max(1.1, m * sx);

    // 1) Rack footprint outlines — the white lines painted round every run.
    ctx.strokeStyle = 'rgba(238,240,243,0.55)';
    for (const r of this._obstacleRects()) {
      ctx.lineWidth = lw(0.09);
      ctx.strokeRect(px(r.x - 0.22), pz(r.y - 0.22),
        px(r.w + 0.44), pz(r.h + 0.44));
    }

    // 2) Zone outlines in safety yellow, inset so they read as painted borders.
    for (const z of (this.replay.zones || [])) {
      const w = +z.w || 0;
      const h = +z.h || 0;
      if (w <= 0.5 || h <= 0.5) continue;
      ctx.strokeStyle = 'rgba(240,196,32,0.55)';
      ctx.lineWidth = lw(0.12);
      ctx.strokeRect(px((+z.x || 0) + 0.35), pz((+z.y || 0) + 0.35),
        px(w - 0.7), pz(h - 0.7));
    }

    // 3) Keep-clear hatching in front of every dock door (yellow diagonals with
    //    a solid border), oriented by the envelope edge the door sits on.
    for (const d of (this.replay.doors || [])) {
      if (!d || (d.type && d.type !== 'dock' && d.type !== 'shutter')) continue;
      const dx = +d.x || 0;
      const dz = +d.y || 0;
      const dw = (+d.w > 0 ? +d.w : 3) + 1.2;
      const n = this._inwardNormal(dx, dz);
      const DEEP = 4.0;
      // Axis-aligned keep-clear rect projected inward from the door.
      const ax = Math.abs(n.nx) > Math.abs(n.nz);
      const rx = ax ? (n.nx > 0 ? dx : dx - DEEP) : dx - dw / 2;
      const rz = ax ? dz - dw / 2 : (n.nz > 0 ? dz : dz - DEEP);
      const rw = ax ? DEEP : dw;
      const rh = ax ? dw : DEEP;
      ctx.save();
      ctx.beginPath();
      ctx.rect(px(rx), pz(rz), px(rw), pz(rh));
      ctx.clip();
      ctx.strokeStyle = 'rgba(240,196,32,0.42)';
      ctx.lineWidth = lw(0.18);
      const step = px(0.7);
      const diag = px(rw) + pz(rh);
      for (let s = -pz(rh); s < diag; s += step) {
        ctx.beginPath();
        ctx.moveTo(px(rx) + s, pz(rz));
        ctx.lineTo(px(rx) + s + pz(rh), pz(rz) + pz(rh));
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = 'rgba(240,196,32,0.75)';
      ctx.lineWidth = lw(0.14);
      ctx.strokeRect(px(rx), pz(rz), px(rw), pz(rh));
    }

    // 4) Pedestrian loop: a green walkway following the building perimeter,
    //    erased wherever racking stands in the way (drawn offscreen so the
    //    erase can't touch the paint above).
    const walk = canvas2d(W, H);
    const wctx = walk.ctx;
    const INSET = 1.7;
    const WIDE = 1.3;
    if (width > 8 && depth > 8) {
      wctx.strokeStyle = 'rgba(46,138,87,0.55)';
      wctx.lineWidth = Math.max(2, px(WIDE));
      wctx.strokeRect(px(INSET), pz(INSET),
        px(width - INSET * 2), pz(depth - INSET * 2));
      wctx.globalCompositeOperation = 'destination-out';
      for (const r of this._obstacleRects()) {
        wctx.fillStyle = '#000';
        wctx.fillRect(px(r.x - 0.5), pz(r.y - 0.5), px(r.w + 1.0), pz(r.h + 1.0));
      }
      wctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(walk.c, 0, 0);
      // White edging on the surviving walkway (drawn as a thin inner/outer pair).
      ctx.strokeStyle = 'rgba(255,255,255,0.30)';
      ctx.lineWidth = lw(0.08);
      ctx.strokeRect(px(INSET - WIDE / 2), pz(INSET - WIDE / 2),
        px(width - (INSET - WIDE / 2) * 2), pz(depth - (INSET - WIDE / 2) * 2));
      ctx.strokeRect(px(INSET + WIDE / 2), pz(INSET + WIDE / 2),
        px(width - (INSET + WIDE / 2) * 2), pz(depth - (INSET + WIDE / 2) * 2));
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this._maxAniso();
    this._textures.push(tex);
    return tex;
  },

  // Which way is "inside" from a point on the envelope? Uses the nearest bounds
  // edge, which is exact for rectangular shells and a sane guess otherwise.
  _inwardNormal(x, z) {
    const { width, depth } = this.bounds;
    const dLeft = Math.abs(x);
    const dRight = Math.abs(width - x);
    const dTop = Math.abs(z);
    const dBot = Math.abs(depth - z);
    const m = Math.min(dLeft, dRight, dTop, dBot);
    if (m === dLeft) return { nx: 1, nz: 0 };
    if (m === dRight) return { nx: -1, nz: 0 };
    if (m === dTop) return { nx: 0, nz: 1 };
    return { nx: 0, nz: -1 };
  },

  _buildFloor() {
    const { width, depth } = this.bounds;
    const a = art(this._preset);
    const TILE = 6.0;   // metres per concrete-texture repeat (slab pour size)

    const geom = new THREE.BoxGeometry(width, 0.2, depth);
    // A studio floor is a plain matte sweep. The photoreal concrete (slab joints,
    // stains, tyre marks) is doing storytelling of its own, and under a concept
    // scene's flat zone tints it just competes with them for the eye.
    if (this.replay.meta && this.replay.meta.studio) {
      const smat = new THREE.MeshStandardMaterial({
        color: 0xd9dee4, roughness: 0.92, metalness: 0.0,
      });
      const smesh = new THREE.Mesh(geom, smat);
      smesh.position.set(width / 2, -0.1, depth / 2);
      smesh.receiveShadow = true;
      this.scene.add(smesh);
      this._track(geom, smat);
      this._buildGrid();
      return;
    }
    const map = this._makeFloorTexture(TILE);
    const rough = this._makeFloorRoughness(TILE);
    const norm = this._makeFloorNormal(TILE);
    const mat = new THREE.MeshStandardMaterial({
      color: a.floorTint, roughness: 0.78, metalness: 0.02,
      map, roughnessMap: rough,
    });
    if (norm) {
      mat.normalMap = norm;
      mat.normalScale = new THREE.Vector2(0.35, 0.35);
    }
    mat.envMapIntensity = a.env;
    this._floorMat = mat;
    const floor = new THREE.Mesh(geom, mat);
    floor.position.set(width / 2, -0.1, depth / 2);
    floor.receiveShadow = true;   // catches contact shadows of every object
    this.scene.add(floor);
    this._track(geom, mat);

    // Painted safety markings: one world-aligned decal just above the slab.
    const mgeom = new THREE.PlaneGeometry(width, depth);
    const mmat = new THREE.MeshBasicMaterial({
      map: this._makeMarkingTexture(), transparent: true, opacity: a.mark,
      depthWrite: false,
    });
    mmat.userData.noEnv = true;
    const decal = new THREE.Mesh(mgeom, mmat);
    decal.rotation.x = -Math.PI / 2;
    decal.position.set(width / 2, 0.012, depth / 2);
    decal.renderOrder = 1;
    this.scene.add(decal);
    this._markMat = mmat;
    this._track(mgeom, mmat);

    // CAD grid, sized EXACTLY to the floor (the old square GridHelper overshot
    // any non-square building). Faint by default, loud in the 図面風 preset.
    this._buildGrid();

    // Outdoor apron so a large floor sits on ground instead of in a void; fog
    // dissolves its far edge into the background colour. Deliberately UNLIT
    // (MeshBasic + fog): it fills a large share of the frame in wide shots and a
    // full PBR+IBL shader there buys nothing — it is a flat, fogged ground tone
    // either way, and skipping it is the cheapest frame time in the scene.
    const span = Math.max(width, depth);
    const ageom = new THREE.PlaneGeometry(span * 3, span * 3);
    const amat = new THREE.MeshBasicMaterial({ color: a.apron });
    amat.userData.noEnv = true;
    const apron = new THREE.Mesh(ageom, amat);
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(width / 2, -0.22, depth / 2);
    this.scene.add(apron);
    this._apronMat = amat;
    this._track(ageom, amat);
  },

  _buildGrid() {
    // Studio scenes have no survey grid: it reads as a claim of measured
    // dimensions, which is the one thing a 概念モデル must not imply.
    if (this.replay.meta && this.replay.meta.studio) { this._gridMat = null; return; }
    const { width, depth } = this.bounds;
    const a = art(this._preset);
    const tone = FLOOR_TONES[this._preset] || FLOOR_TONES.brand;
    const step = Math.max(1, meta_grid(this.replay) * 5);
    const pts = [];
    for (let x = 0; x <= width + 0.001; x += step) {
      pts.push(Math.min(x, width), 0, 0, Math.min(x, width), 0, depth);
    }
    for (let z = 0; z <= depth + 0.001; z += step) {
      pts.push(0, 0, Math.min(z, depth), width, 0, Math.min(z, depth));
    }
    if (pts.length === 0) { this._gridMat = null; return; }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({
      color: tone.gridA, transparent: true, opacity: a.grid, depthWrite: false,
    });
    const lines = new THREE.LineSegments(geom, mat);
    lines.position.y = 0.02;
    lines.renderOrder = 1;
    this.scene.add(lines);
    this._gridMat = mat;
    this._track(geom, mat);
  },

  _buildZones() {
    const zones = this.replay.zones || [];
    for (const z of zones) {
      const w = z.w || 0;
      const h = z.h || 0;
      if (w <= 0 || h <= 0) continue;
      const geom = new THREE.PlaneGeometry(w, h);
      const color = z.color ? new THREE.Color(z.color) : new THREE.Color(0xcccccc);
      // Lighter than before: the concrete + painted markings now carry the floor,
      // so the zone tint is a hint, not a paint bucket.
      // 0.22 is a hint laid over photoreal concrete, which is right when the
      // floor is doing its own storytelling. A zone whose colour IS the message
      // ("位置＝状態") can ask for more; absent, nothing changes.
      const zOpacity = Number.isFinite(Number(z.opacity)) ? Number(z.opacity) : 0.22;
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: zOpacity < 1, opacity: zOpacity, side: THREE.DoubleSide,
        depthWrite: false,
      });
      mat.userData.noEnv = true;
      const mesh = new THREE.Mesh(geom, mat);
      mesh.rotation.x = -Math.PI / 2; // lay flat on the floor
      mesh.position.set((z.x || 0) + w / 2, 0.008, (z.y || 0) + h / 2);
      this.scene.add(mesh);
      this._track(geom, mat);
    }
  },

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
  },

  // Packing/processing stations: a real workbench (frame + worktop + a monitor)
  // instead of the old marker cylinder. Instanced, so any number of stations
  // costs three draw calls.
  _buildStations() {
    const stations = (this.replay.stations || []).filter((s) => s);
    const n = stations.length;
    if (n === 0) return;
    const steel = new THREE.MeshStandardMaterial({
      color: 0x5d6874, roughness: 0.42, metalness: 0.72,
    });
    const top = new THREE.MeshStandardMaterial({
      color: 0xd9dde2, roughness: 0.55, metalness: 0.08,
    });
    const screen = new THREE.MeshStandardMaterial({
      color: 0x101720, roughness: 0.25, metalness: 0.3,
      emissive: new THREE.Color(0x123a52), emissiveIntensity: 0.7,
    });
    this._materials.push(steel, top, screen);
    const legG = new THREE.BoxGeometry(0.08, 0.85, 0.08);
    const topG = new THREE.BoxGeometry(2.0, 0.07, 0.9);
    const monG = new THREE.BoxGeometry(0.5, 0.34, 0.04);
    this._geometries.push(legG, topG, monG);

    const legs = new THREE.InstancedMesh(legG, steel, n * 4);
    const tops = new THREE.InstancedMesh(topG, top, n);
    const mons = new THREE.InstancedMesh(monG, screen, n);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    let li = 0;
    for (let i = 0; i < n; i++) {
      const s = stations[i];
      const x = +s.x || 0;
      const z = +s.y || 0;
      for (const ox of [-0.9, 0.9]) {
        for (const oz of [-0.38, 0.38]) {
          pos.set(x + ox, 0.425, z + oz);
          m4.compose(pos, q, one);
          legs.setMatrixAt(li++, m4);
        }
      }
      pos.set(x, 0.885, z);
      m4.compose(pos, q, one);
      tops.setMatrixAt(i, m4);
      pos.set(x, 1.10, z - 0.38);
      m4.compose(pos, q, one);
      mons.setMatrixAt(i, m4);
    }
    for (const mesh of [legs, tops, mons]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  },

  // Conveyors: a chain of thin elongated boxes laid along each polyline,
  // low to the floor, neutral metallic gray. Missing/empty -> nothing.
  _buildConveyors() {
    const conveyors = this.replay.conveyors || [];
    if (conveyors.length === 0) return;
    const BELT_W = 0.5;   // belt width (m)
    const BELT_H = 0.18;  // belt thickness (m)
    const Y_DEFAULT = 0.12; // raised slightly off the floor
    // Deck heights, so _updateTotes can put a box on the belt it is actually
    // riding. A two-tier drive conveyor — outbound over, empties back under — is
    // ordinary warehouse hardware, and until now every belt sat at one height,
    // which meant a box on the upper deck floated through the lower one.
    this._belts.length = 0;
    this._beltDecks = [];
    // One shared scrolling belt-tread texture for every segment's TOP face. The
    // map.offset is advanced every frame (delta-based) in _updateBelts() so the
    // tread appears to flow toward the conveyor's downstream end — a cheap,
    // GPU-only motion cue. Reduced-motion leaves it static (_beltSpeed = 0).
    const beltTex = this._makeBeltTexture();
    for (const c of conveyors) {
      const pts = c.points || [];
      const dir = (c.speed_mps || 0) < 0 ? -1 : 1; // flow direction along the chain
      // `elevation_m` is the belt's TREAD height; absent ⇒ the historical 0.21.
      const yMid = Number.isFinite(Number(c.elevation_m))
        ? Math.max(0, Number(c.elevation_m)) - BELT_H / 2
        : Y_DEFAULT;
      const deckY = yMid + BELT_H / 2;
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
        this._beltDecks.push({
          id: c.id || '', y: deckY,
          x0: p0[0] || 0, z0: p0[1] || 0, x1: p1[0] || 0, z1: p1[1] || 0,
        });
        // Legs, so an elevated deck is standing on something instead of hovering.
        if (deckY > 0.4) {
          const nLeg = Math.max(2, Math.round(len / 3));
          for (let s2 = 0; s2 <= nLeg; s2++) {
            const f = s2 / nLeg;
            const lg = new THREE.CylinderGeometry(0.05, 0.05, yMid, 8);
            const lm = new THREE.Mesh(lg, railMat);
            lm.position.set((p0[0] || 0) + dx * f, yMid / 2, (p0[1] || 0) + dz * f);
            lm.castShadow = true;
            this.scene.add(lm);
            this._geometries.push(lg);
          }
        }
      }
    }
  },

  // Belt-tread texture: dark rubber with light chevron/cleat bands across the
  // run so scrolling map.offset reads as forward motion. Cached as a base
  // CanvasTexture; each segment clones it (cheap, shares the canvas bitmap).
  _makeBeltTexture() {
    const S = 64;
    const { c, ctx } = canvas2d(S, S);
    ctx.fillStyle = '#20262e';
    ctx.fillRect(0, 0, S, S);
    // Two light cleat bands per tile (perpendicular to flow = vertical here).
    ctx.fillStyle = 'rgba(150,165,180,0.55)';
    ctx.fillRect(2, 0, 5, S);
    ctx.fillRect(Math.round(S / 2) + 2, 0, 5, S);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(2, 0, 2, S);
    ctx.fillRect(Math.round(S / 2) + 2, 0, 2, S);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    this._textures.push(tex);
    return tex;
  },

  // -- Building shell --------------------------------------------------------
  // Roof steel + deck, high-bay fixture grid, column grid, perimeter sandwich
  // panels, a roof-line parapet and dock doors. Every part is optional: an empty
  // envelope, no doors or a tiny footprint just yields fewer pieces.
  //
  // CUTAWAY CONTRACT (see _updateCutaway): the shell is a real, enclosed building
  // when you stand inside it, and an architectural cutaway model when you look at
  // it from outside. Two collections drive that, both filled here:
  //   _roofParts   — deck / skylights / roof steel / high-bay fixtures. Visible
  //                  only while the camera is INSIDE the hall; from an overview
  //                  camera they would be a lattice of dark steel laid over the
  //                  whole layout (exactly what made the merged build unreadable).
  //   _wallPanels  — per-segment {mesh, inward normal, midpoint}. A panel is
  //                  hidden when the camera sits on its OUTSIDE face, so the near
  //                  walls open up and the far walls stay standing.
  // The perimeter curb and the parapet never hide: they are what keeps the
  // building's footprint and roof line readable in the cutaway.
  _buildShell() {
    this._shellMats = [];
    this._roofParts = [];
    this._wallPanels = [];
    this._cutInside = null;
    // `meta.studio` drops the building: no walls, roof, parapet, columns, high-bay
    // fixtures or doors. A concept scene is a diagram that happens to be in 3D —
    // the audience is reading the FLOW, and a real envelope adds a roofline, a
    // cutaway that swings with the camera, and structural columns that land in
    // the middle of the very aisle the storyboard is following. It also asserts a
    // building shape the scene has no data for.
    if (this.replay.meta && this.replay.meta.studio) return;
    this._buildWalls();
    this._buildRoof();
    this._buildParapet();
    this._buildColumns();
    this._buildFixtures();
    this._buildDoors();
  },

  // Per-frame cutaway state (called from Scene3D._loop). Pure visibility flags on
  // a handful of objects — no geometry, no material, no allocation.
  _updateCutaway() {
    const parts = this._roofParts;
    const panels = this._wallPanels;
    if ((!parts || !parts.length) && (!panels || !panels.length)) return;
    const ceil = this._clearHeight();
    const c = this.camera.position;
    const { width, depth } = this.bounds;
    // "Inside" = under the roof steel AND within the footprint (a small margin so
    // a camera hugging a wall still counts as indoors).
    const inside = c.y < ceil - 0.2
      && c.x > -1.5 && c.x < width + 1.5
      && c.z > -1.5 && c.z < depth + 1.5;
    if (inside !== this._cutInside) {
      this._cutInside = inside;
      for (const m of (parts || [])) m.visible = inside;
      // Exception: in the presets where the building lights ITSELF (夜/夕/ブランド)
      // the high-bay lenses stay lit through the cutaway, so the overview reads
      // like a night aerial of a working DC rather than an unlit model. Daylight
      // presets keep them hidden — dim white quads floating over the racks just
      // look like artefacts.
      if (this._fixtureLens && this._lensAlwaysOn) this._fixtureLens.visible = true;
    }
    for (const w of (panels || [])) {
      // dot(camera - midpoint, inward normal) > 0 ⇒ the camera is on the panel's
      // interior side ⇒ keep it. Inside the hall every panel qualifies anyway.
      const vis = inside
        || ((c.x - w.mx) * w.nx + (c.z - w.mz) * w.nz) > 0;
      if (w.mesh.visible !== vis) w.mesh.visible = vis;
    }
  },

  // Perimeter: a solid low curb (reads as a building edge from outside) plus
  // full-height sandwich panels that face INWARD and are single-sided, so the
  // building is an automatic cutaway — you look straight in from outside, and
  // stand in a real enclosed hall once the camera drops inside.
  _buildWalls() {
    const a = art(this._preset);
    const env = this._envelope();
    const ceil = this._clearHeight();
    const CURB_H = 1.05;
    const seam = this._makePanelTexture();
    const panelMat = new THREE.MeshStandardMaterial({
      color: a.wall, roughness: 0.58, metalness: 0.22, map: seam,
      side: THREE.FrontSide,
    });
    const curbMat = new THREE.MeshStandardMaterial({
      color: a.curb, roughness: 0.85, metalness: 0.05,
    });
    this._materials.push(panelMat, curbMat);
    this._wallMat = panelMat;
    this._curbMat = curbMat;
    for (const s of env.segs) {
      const dx = s.x1 - s.x0;
      const dz = s.z1 - s.z0;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const mx = (s.x0 + s.x1) / 2;
      const mz = (s.z0 + s.z1) / 2;
      const yaw = -Math.atan2(dz, dx);
      // Curb (solid, visible from both sides).
      const cg = new THREE.BoxGeometry(len, CURB_H, 0.3);
      const curb = new THREE.Mesh(cg, curbMat);
      curb.position.set(mx, CURB_H / 2, mz);
      curb.rotation.y = yaw;
      curb.receiveShadow = true;
      this.scene.add(curb);
      this._geometries.push(cg);
      // Panel above the curb, normal pointing at the interior centroid.
      const ph = Math.max(0.5, ceil - CURB_H);
      const pg = new THREE.PlaneGeometry(len, ph);
      const wall = new THREE.Mesh(pg, panelMat);
      wall.position.set(mx, CURB_H + ph / 2, mz);
      // A plane's normal is +Z; rotate it to face inward.
      let nx = -dz / len;
      let nz = dx / len;
      if ((env.cx - mx) * nx + (env.cz - mz) * nz < 0) { nx = -nx; nz = -nz; }
      wall.rotation.y = Math.atan2(nx, nz);
      wall.receiveShadow = true;
      this.scene.add(wall);
      this._geometries.push(pg);
      // Register for the per-frame cutaway (near walls open, far walls stand).
      this._wallPanels.push({ mesh: wall, nx, nz, mx, mz });
      // Per-segment UV scale so panel seams stay ~1.2 m wide on every wall.
      if (len > 0) {
        const t = seam.clone();
        t.repeat.set(Math.max(1, Math.round(len / 3.6)), Math.max(1, Math.round(ph / 3.6)));
        t.needsUpdate = true;
        this._textures.push(t);
        const m = panelMat.clone();
        m.map = t;
        this._materials.push(m);
        this._shellMats.push(m);
        wall.material = m;
      }
    }
  },

  // Sandwich-panel cladding: vertical seams with a soft rib shade between them.
  _makePanelTexture() {
    const S = 256;
    const { c, ctx } = canvas2d(S, S);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, S, S);
    // Three panels per tile with a shaded groove at each joint.
    for (let i = 0; i < 3; i++) {
      const x = Math.round((i * S) / 3);
      const g = ctx.createLinearGradient(x, 0, x + S / 3, 0);
      g.addColorStop(0.00, 'rgba(0,0,0,0.16)');
      g.addColorStop(0.06, 'rgba(255,255,255,0.10)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.02)');
      g.addColorStop(1.00, 'rgba(0,0,0,0.05)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, Math.ceil(S / 3), S);
    }
    // Horizontal joint at the tile top so tall walls show a course line too.
    ctx.fillStyle = 'rgba(0,0,0,0.13)';
    ctx.fillRect(0, 0, S, 3);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this._maxAniso();
    this._textures.push(tex);
    return tex;
  },

  // Roof: a downward-facing deck (invisible from above so the overview camera
  // still sees the layout), skylight strips, girders spanning the short side and
  // open-web joists on top of them. Nothing up here casts shadows — a solid roof
  // would simply switch the key light off.
  _buildRoof() {
    const a = art(this._preset);
    const { width, depth } = this.bounds;
    const ceil = this._clearHeight();
    if (width < 4 || depth < 4) return;

    // Deck: single-sided, facing DOWN.
    const dg = new THREE.PlaneGeometry(width, depth);
    const dm = new THREE.MeshStandardMaterial({
      color: a.ceil, roughness: 0.92, metalness: 0.08, side: THREE.FrontSide,
      map: this._makeDeckTexture(),
      emissive: new THREE.Color(a.ceil), emissiveIntensity: a.ceilEmissive,
    });
    dm.userData.envScale = 0.5;
    const deck = new THREE.Mesh(dg, dm);
    deck.rotation.x = Math.PI / 2;   // normal -> -Y
    deck.position.set(width / 2, ceil, depth / 2);
    this.scene.add(deck);
    this._roofParts.push(deck);
    this._ceilMat = dm;
    this._track(dg, dm);

    // Skylight strips: like the deck, they face DOWN only, and they ride the same
    // cutaway list — from inside they are the daylight slots in the roof, from an
    // overview camera the whole roof is gone so nothing floats over the layout.
    const nSky = clamp(Math.round(depth / 18), 1, 4);
    const skyMat = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
    skyMat.color.setHex(0xffffff).multiplyScalar(a.skylight);
    skyMat.userData.noEnv = true;
    this._materials.push(skyMat);
    this._skyMat = skyMat;
    const sg = new THREE.PlaneGeometry(width * 0.80, 1.7);
    this._geometries.push(sg);
    for (let i = 0; i < nSky; i++) {
      const strip = new THREE.Mesh(sg, skyMat);
      strip.rotation.x = Math.PI / 2;   // normal -> -Y, same as the deck
      strip.position.set(width / 2, ceil - 0.03, ((i + 0.5) * depth) / nSky);
      this.scene.add(strip);
      this._roofParts.push(strip);
    }

    this._buildStructure(ceil);
  },

  // Roof-line parapet: a solid capping band that follows the envelope. It is the
  // ONE piece of the roof that never hides, and it is what makes the cutaway read
  // as a building instead of a plate — from outside you see a real roof line and
  // eaves shadow above the walls; from inside it is out of shot behind the deck.
  _buildParapet() {
    const a = art(this._preset);
    const env = this._envelope();
    const ceil = this._clearHeight();
    const H = 0.95;                 // band height (upstand above the roof line)
    const T = 0.42;                 // thickness (proud of the wall panel)
    const mat = new THREE.MeshStandardMaterial({
      color: a.parapet, roughness: 0.62, metalness: 0.25,
    });
    this._materials.push(mat);
    this._parapetMat = mat;
    for (const s of env.segs) {
      const dx = s.x1 - s.x0;
      const dz = s.z1 - s.z0;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      // Overrun by the thickness at each end so corners close cleanly.
      const g = new THREE.BoxGeometry(len + T, H, T);
      const band = new THREE.Mesh(g, mat);
      const mx = (s.x0 + s.x1) / 2;
      const mz = (s.z0 + s.z1) / 2;
      band.position.set(mx, ceil - 0.1 + H / 2, mz);
      band.rotation.y = -Math.atan2(dz, dx);
      band.castShadow = false;      // a shadow-casting ring would rim the floor
      band.receiveShadow = true;
      this.scene.add(band);
      this._geometries.push(g);
      // The band rides the SAME cutaway as its wall panel: a near-side parapet
      // seen from an elevated camera projects as a dark bar straight across the
      // layout it is supposed to frame.
      let nx = -dz / len;
      let nz = dx / len;
      if ((env.cx - mx) * nx + (env.cz - mz) * nz < 0) { nx = -nx; nz = -nz; }
      this._wallPanels.push({ mesh: band, nx, nz, mx, mz });
    }
  },

  // Corrugated deck: fine rib lines so the ceiling isn't a flat fill.
  _makeDeckTexture() {
    const S = 128;
    const { c, ctx } = canvas2d(S, S);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < S; i += 8) {
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(i, 0, 2, S);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(i + 2, 0, 1, S);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    tex.repeat.set(Math.max(2, Math.round(this.bounds.width / 6)),
      Math.max(2, Math.round(this.bounds.depth / 6)));
    tex.anisotropy = this._maxAniso();
    this._textures.push(tex);
    return tex;
  },

  // Roof steel: girders spanning the depth every ~12 m, open-web joists running
  // the width above them, all instanced (5 draw calls for the whole roof).
  _buildStructure(ceil) {
    const { width, depth } = this.bounds;
    const a = art(this._preset);
    // Shop-primed structural steel: mostly dielectric paint over a metal core.
    const mat = new THREE.MeshStandardMaterial({
      color: a.steel, roughness: 0.5, metalness: 0.32,
    });
    this._materials.push(mat);
    this._steelMat = mat;

    const girderPitch = clamp(width / Math.max(1, Math.round(width / 12)), 8, 16);
    const nG = Math.max(1, Math.round(width / girderPitch));
    const joistPitch = clamp(depth / Math.max(1, Math.round(depth / 6)), 4, 9);
    const nJ = Math.max(1, Math.round(depth / joistPitch));

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const one = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();

    // Girders: deep beams along Z, sitting under the joists.
    const gG = new THREE.BoxGeometry(0.24, 0.85, depth);
    this._geometries.push(gG);
    const girders = new THREE.InstancedMesh(gG, mat, nG);
    for (let i = 0; i < nG; i++) {
      pos.set(((i + 0.5) * width) / nG, ceil - 1.55, depth / 2);
      m4.compose(pos, q, one);
      girders.setMatrixAt(i, m4);
    }
    girders.instanceMatrix.needsUpdate = true;
    this.scene.add(girders);
    this._roofParts.push(girders);

    // Joists: top + bottom chord along X, with vertical posts and zig-zag webs.
    const chordTopY = ceil - 0.22;
    const chordBotY = ceil - 0.95;
    const webH = chordTopY - chordBotY;
    const cG = new THREE.BoxGeometry(width, 0.11, 0.13);
    this._geometries.push(cG);
    const chords = new THREE.InstancedMesh(cG, mat, nJ * 2);
    const panelStep = clamp(width / Math.max(1, Math.round(width / 3.2)), 2.0, 4.0);
    const nPanels = Math.max(1, Math.round(width / panelStep));
    const wG = new THREE.BoxGeometry(0.07, webH, 0.07);
    this._geometries.push(wG);
    const posts = new THREE.InstancedMesh(wG, mat, nJ * (nPanels + 1));
    const diagLen = Math.hypot(panelStep, webH);
    const dG = new THREE.BoxGeometry(0.06, diagLen, 0.06);
    this._geometries.push(dG);
    const diags = new THREE.InstancedMesh(dG, mat, nJ * nPanels);
    const diagTilt = Math.atan2(panelStep, webH);
    let ci = 0, pi = 0, di = 0;
    for (let j = 0; j < nJ; j++) {
      const z = ((j + 0.5) * depth) / nJ;
      pos.set(width / 2, chordTopY, z);
      m4.compose(pos, q, one); chords.setMatrixAt(ci++, m4);
      pos.set(width / 2, chordBotY, z);
      m4.compose(pos, q, one); chords.setMatrixAt(ci++, m4);
      for (let k = 0; k <= nPanels; k++) {
        pos.set((k * width) / nPanels, (chordTopY + chordBotY) / 2, z);
        m4.compose(pos, q, one); posts.setMatrixAt(pi++, m4);
      }
      for (let k = 0; k < nPanels; k++) {
        pos.set(((k + 0.5) * width) / nPanels, (chordTopY + chordBotY) / 2, z);
        e.set(0, 0, k % 2 === 0 ? diagTilt : -diagTilt);
        q.setFromEuler(e);
        m4.compose(pos, q, one); diags.setMatrixAt(di++, m4);
        q.identity();
      }
    }
    for (const mesh of [chords, posts, diags]) {
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
      this._roofParts.push(mesh);
    }
  },

  // Column grid, phase-shifted so the pillars land in the AISLES rather than
  // inside the racking; any column that would still collide is simply skipped.
  _buildColumns() {
    const { width, depth } = this.bounds;
    const a = art(this._preset);
    const ceil = this._clearHeight();
    const top = Math.max(2, ceil - 2.1);
    const pitchX = clamp(width / Math.max(1, Math.round(width / 12)), 8, 18);
    const pitchZ = clamp(depth / Math.max(1, Math.round(depth / 12)), 8, 18);
    const HALF = 0.22;      // half the column section, for the clearance test
    const best = { n: -1, ox: 0, oz: 0 };
    for (const ox of [0, 1, 1.5, 2, 2.5, 3]) {
      for (const oz of [0, 1, 2]) {
        let n = 0;
        for (let x = pitchX / 2 + ox; x < width - 1; x += pitchX) {
          for (let z = pitchZ / 2 + oz; z < depth - 1; z += pitchZ) {
            if (!this._hitsObstacle(x, z, HALF + 0.25)) n++;
          }
        }
        if (n > best.n) { best.n = n; best.ox = ox; best.oz = oz; }
      }
    }
    const spots = [];
    for (let x = pitchX / 2 + best.ox; x < width - 1; x += pitchX) {
      for (let z = pitchZ / 2 + best.oz; z < depth - 1; z += pitchZ) {
        if (this._hitsObstacle(x, z, HALF + 0.25)) continue;
        spots.push([x, z]);
      }
    }
    if (spots.length === 0) return;
    // PAINTED steel, not bare: at metalness 0.55 a column reads as a black spike
    // against a dim environment (a forest of them was the loudest thing in the
    // wide shot). A dielectric paint coat keeps its colour legible under every
    // preset, which is also what a real primed/painted RC or steel column does.
    const mat = new THREE.MeshStandardMaterial({
      color: a.column, roughness: 0.58, metalness: 0.16,
    });
    this._materials.push(mat);
    this._columnMat = mat;
    const shaftG = new THREE.BoxGeometry(0.36, top, 0.36);
    const baseG = new THREE.BoxGeometry(0.75, 0.09, 0.75);
    this._geometries.push(shaftG, baseG);
    const shafts = new THREE.InstancedMesh(shaftG, mat, spots.length);
    const bases = new THREE.InstancedMesh(baseG, mat, spots.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    for (let i = 0; i < spots.length; i++) {
      pos.set(spots[i][0], top / 2, spots[i][1]);
      m4.compose(pos, q, one); shafts.setMatrixAt(i, m4);
      pos.set(spots[i][0], 0.045, spots[i][1]);
      m4.compose(pos, q, one); bases.setMatrixAt(i, m4);
    }
    for (const mesh of [shafts, bases]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  },

  // High-bay fixtures on a grid under the roof steel: a dark housing, a bright
  // emissive lens and two drop rods. Emissive-only by default (three instanced
  // draw calls, no per-light shading cost); presets that read as "lit by the
  // building" may also hang a few real PointLights — see art().points.
  _buildFixtures() {
    const { width, depth } = this.bounds;
    const a = art(this._preset);
    const ceil = this._clearHeight();
    if (width < 4 || depth < 4) return;
    const pitch = clamp(Math.max(width, depth) / 9, 8, 14);
    const nx = Math.max(1, Math.round(width / pitch));
    const nz = Math.max(1, Math.round(depth / pitch));
    const n = nx * nz;
    const y = ceil - 2.55;

    const housing = new THREE.MeshStandardMaterial({
      color: 0x59626c, roughness: 0.4, metalness: 0.7,
    });
    const lens = new THREE.MeshBasicMaterial();
    lens.color.setHex(0xfff6e2).multiplyScalar(clamp(a.fixture / 4, 0.35, 3));
    lens.userData.noEnv = true;
    const rodMat = new THREE.MeshStandardMaterial({
      color: 0x555d66, roughness: 0.5, metalness: 0.8,
    });
    this._materials.push(housing, lens, rodMat);
    this._fixtureMat = lens;

    // The lens overhangs the housing on every side so the fixture reads as LIT
    // from an oblique aisle view, not as a black box with a hidden bulb.
    const hG = new THREE.BoxGeometry(1.6, 0.2, 0.5);
    const lG = new THREE.BoxGeometry(1.78, 0.09, 0.62);
    const rG = new THREE.BoxGeometry(0.05, 2.35, 0.05);
    this._geometries.push(hG, lG, rG);
    const hM = new THREE.InstancedMesh(hG, housing, n);
    const lM = new THREE.InstancedMesh(lG, lens, n);
    const rM = new THREE.InstancedMesh(rG, rodMat, n * 2);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    let i = 0, ri = 0;
    const spots = [];
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const x = ((ix + 0.5) * width) / nx;
        const z = ((iz + 0.5) * depth) / nz;
        spots.push([x, z]);
        pos.set(x, y, z); m4.compose(pos, q, one); hM.setMatrixAt(i, m4);
        pos.set(x, y - 0.12, z); m4.compose(pos, q, one); lM.setMatrixAt(i, m4);
        for (const ox of [-0.6, 0.6]) {
          pos.set(x + ox, y + 1.28, z);
          m4.compose(pos, q, one); rM.setMatrixAt(ri++, m4);
        }
        i++;
      }
    }
    for (const mesh of [hM, lM, rM]) {
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
      this._roofParts.push(mesh);
    }
    hM.castShadow = false;
    this._fixtureLens = lM;          // kept lit through the cutaway (see _updateCutaway)
    this._lensAlwaysOn = a.fixture >= 5;
    this._fixtureSpots = spots;
    this._fixtureY = y;
    this._syncPointLights(a);
  },

  // Optional real PointLights hung in the fixture grid. Kept to a handful and
  // spread across the floor: each one costs shading work in EVERY lit draw call,
  // so presets opt in (art().points) rather than getting them by default.
  _syncPointLights(a) {
    const want = Math.max(0, Math.min(4, a.points | 0));
    this._pointLights = this._pointLights || [];
    const spots = this._fixtureSpots || [];
    while (this._pointLights.length > want) {
      const l = this._pointLights.pop();
      this.scene.remove(l);
    }
    while (this._pointLights.length < want && spots.length > 0) {
      const idx = Math.floor(((this._pointLights.length + 0.5) / want) * spots.length);
      const s = spots[Math.min(spots.length - 1, idx)];
      const span = Math.max(this.bounds.width, this.bounds.depth);
      const l = new THREE.PointLight(0xffe9c4, 0, span * 0.55, 2);
      l.position.set(s[0], this._fixtureY || 6, s[1]);
      this.scene.add(l);
      this._pointLights.push(l);
    }
    for (const l of this._pointLights) l.intensity = a.fixture * 6;
  },

  // Dock doors: a sectional leaf in a steel frame with rubber bumpers and a
  // leveller plate, oriented onto the envelope edge nearest the door. Personnel
  // doors get a smaller leaf. Instanced per piece so N doors stay at 4 calls.
  _buildDoors() {
    const doors = (this.replay.doors || []).filter((d) => d);
    if (doors.length === 0) return;
    const ceil = this._clearHeight();
    const leafTex = this._makeDoorTexture();
    const leafMat = new THREE.MeshStandardMaterial({
      color: 0xb4bcc4, roughness: 0.45, metalness: 0.55, map: leafTex,
    });
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x4d545c, roughness: 0.5, metalness: 0.6,
    });
    const bumperMat = new THREE.MeshStandardMaterial({
      color: 0x17191c, roughness: 0.95, metalness: 0.0,
    });
    const plateMat = new THREE.MeshStandardMaterial({
      color: 0x6f767e, roughness: 0.38, metalness: 0.8,
    });
    this._materials.push(leafMat, frameMat, bumperMat, plateMat);
    this._doorMats = [leafMat, frameMat, plateMat];

    const n = doors.length;
    const leafG = new THREE.BoxGeometry(1, 1, 0.14);
    const frameG = new THREE.BoxGeometry(1, 1, 0.22);
    const bumperG = new THREE.BoxGeometry(0.28, 0.9, 0.3);
    const plateG = new THREE.BoxGeometry(1, 0.07, 1);
    this._geometries.push(leafG, frameG, bumperG, plateG);
    const leaves = new THREE.InstancedMesh(leafG, leafMat, n);
    const frames = new THREE.InstancedMesh(frameG, frameMat, n * 3);
    const bumpers = new THREE.InstancedMesh(bumperG, bumperMat, n * 2);
    const plates = new THREE.InstancedMesh(plateG, plateMat, n);

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const sc = new THREE.Vector3();
    let fi = 0, bi = 0;
    for (let i = 0; i < n; i++) {
      const d = doors[i];
      const personnel = d.type === 'personnel';
      const w = Math.max(0.8, +d.w > 0 ? +d.w : (personnel ? 1.0 : 3.0));
      const h = personnel ? 2.1 : Math.min(4.3, Math.max(2.6, ceil - 1.6));
      const x = +d.x || 0;
      const z = +d.y || 0;
      const nrm = this._inwardNormal(x, z);
      // Yaw so the leaf's local +Z points into the building.
      const yaw = Math.atan2(nrm.nx, nrm.nz);
      e.set(0, yaw, 0);
      q.setFromEuler(e);
      // Leaf, pushed just inside the wall plane.
      pos.set(x + nrm.nx * 0.16, h / 2, z + nrm.nz * 0.16);
      sc.set(w, h, 1);
      m4.compose(pos, q, sc);
      leaves.setMatrixAt(i, m4);
      // Frame: two jambs + a header.
      const px = -nrm.nz;   // unit vector along the wall
      const pz = nrm.nx;
      for (const side of [-1, 1]) {
        pos.set(x + px * side * (w / 2 + 0.13) + nrm.nx * 0.14, h / 2,
          z + pz * side * (w / 2 + 0.13) + nrm.nz * 0.14);
        sc.set(0.26, h + 0.3, 1);
        m4.compose(pos, q, sc);
        frames.setMatrixAt(fi++, m4);
      }
      pos.set(x + nrm.nx * 0.14, h + 0.14, z + nrm.nz * 0.14);
      sc.set(w + 0.55, 0.3, 1);
      m4.compose(pos, q, sc);
      frames.setMatrixAt(fi++, m4);
      // Bumpers + leveller only for dock/shutter doors.
      if (!personnel) {
        for (const side of [-1, 1]) {
          pos.set(x + px * side * (w / 2 + 0.3) + nrm.nx * 0.34, 0.55,
            z + pz * side * (w / 2 + 0.3) + nrm.nz * 0.34);
          sc.set(1, 1, 1);
          m4.compose(pos, q, sc);
          bumpers.setMatrixAt(bi++, m4);
        }
        pos.set(x + nrm.nx * 1.5, 0.06, z + nrm.nz * 1.5);
        sc.set(w * 0.92, 1, 2.6);
        m4.compose(pos, q, sc);
        plates.setMatrixAt(i, m4);
      } else {
        pos.set(x, -50, z);   // park unused instances out of sight
        sc.set(0.001, 0.001, 0.001);
        m4.compose(pos, q, sc);
        plates.setMatrixAt(i, m4);
        for (const _s of [-1, 1]) {
          m4.compose(pos, q, sc);
          bumpers.setMatrixAt(bi++, m4);
        }
      }
    }
    for (const mesh of [leaves, frames, bumpers, plates]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  },

  // Sectional door leaf: horizontal panel ribs with a vision-light band.
  _makeDoorTexture() {
    const S = 256;
    const { c, ctx } = canvas2d(S, S);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, S, S);
    const rows = 6;
    for (let i = 0; i < rows; i++) {
      const y = (i * S) / rows;
      const g = ctx.createLinearGradient(0, y, 0, y + S / rows);
      g.addColorStop(0.0, 'rgba(0,0,0,0.22)');
      g.addColorStop(0.12, 'rgba(255,255,255,0.20)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.03)');
      g.addColorStop(1.0, 'rgba(0,0,0,0.10)');
      ctx.fillStyle = g;
      ctx.fillRect(0, y, S, Math.ceil(S / rows));
    }
    // Vision lights in the second panel from the top.
    ctx.fillStyle = 'rgba(30,44,58,0.75)';
    const vy = Math.round(S / rows) + Math.round(S / rows) * 0.25;
    for (let k = 0; k < 3; k++) {
      ctx.fillRect(Math.round(S * (0.16 + k * 0.26)), vy,
        Math.round(S * 0.16), Math.round(S / rows) * 0.5);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this._maxAniso();
    this._textures.push(tex);
    return tex;
  },

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
    mat.userData.noEnv = true;
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
  },

  // -- Default (hero) camera framing -----------------------------------------
  // The merged build inherited a fixed camera offset (span·0.9 up, span·1.1 back)
  // which, on a wide canvas, left a 108 m building occupying about a third of the
  // frame. Framing is a FIT problem, not a constant: solve for the exact distance
  // at which the building's bounding box fills `fill` of the current viewport,
  // given the live aspect ratio. That way the hero shot is equally well framed in
  // the small docked panel and in the maximised (⛶ 拡大) view, and the
  // apparent-size rack LOD gets the closest camera the framing allows.
  //
  // Camera direction: an architectural three-quarter view — elevated ~27° (high
  // enough to read the layout through the cutaway, low enough that the walls and
  // roof line still read as a building), looking along the building's LONG axis
  // so the widest dimension spans the widest side of the frame, and twisted
  // toward the dock face so the doors are part of the shot.
  frameDefault(fill) {
    const { width, depth } = this.bounds;
    const ceil = this._clearHeight();
    const target = new THREE.Vector3(width / 2, ceil * 0.38, depth / 2);
    const dir = this._heroDir();
    const d = this._fitDistance(target, dir, fill || 0.92);
    this.camera.position.copy(dir).multiplyScalar(d).add(target);
    this.camera.updateProjectionMatrix();
    if (this.controls) {
      this.controls.target.copy(target);
      this.controls.update();
    }
    this._heroDist = d;
    this._syncFog();   // the fog band is clamped behind the (new) hero distance
    return d;
  },

  // Unit vector from the orbit target toward the camera for the hero shot.
  _heroDir() {
    const { width, depth } = this.bounds;
    const ELEV = 27 * (Math.PI / 180);
    // Stand off the long side so the long axis spans the frame horizontally.
    let hx = 0, hz = 1;
    if (depth > width) { hx = 1; hz = 0; }
    // Twist toward the wall that carries the most doors, so the dock face is in
    // shot rather than hidden round the back. Falls back to a fixed twist.
    const n = this._dockNormal();
    let tw = 28 * (Math.PI / 180);
    if (n) {
      // Rotate the base bearing toward the OUTSIDE of the dock wall (-n). The 2D
      // cross product picks the shorter way round: positive ⇒ rotate positively.
      const cross = hx * -n.nz - hz * -n.nx;
      if (cross < 0) tw = -tw;
    }
    const c = Math.cos(tw), s = Math.sin(tw);
    const rx = hx * c - hz * s;
    const rz = hx * s + hz * c;
    const ce = Math.cos(ELEV);
    return new THREE.Vector3(rx * ce, Math.sin(ELEV), rz * ce).normalize();
  },

  // Inward normal of the envelope edge carrying the most dock doors (or null).
  _dockNormal() {
    const tally = new Map();
    for (const d of (this.replay.doors || [])) {
      if (!d) continue;
      const n = this._inwardNormal(+d.x || 0, +d.y || 0);
      const k = `${n.nx},${n.nz}`;
      tally.set(k, (tally.get(k) || 0) + 1);
    }
    let best = null, bn = 0;
    for (const [k, v] of tally) {
      if (v > bn) { bn = v; const p = k.split(','); best = { nx: +p[0], nz: +p[1] }; }
    }
    return best;
  },

  // Distance along `dir` at which the building AABB fills `fill` of the frame,
  // WITH the shot recentred. Two coupled problems:
  //   * fit — per AABB corner, the constraints |x| ≤ tanH·depth and |y| ≤ tanV·depth
  //     in camera space; the binding corner sets the distance.
  //   * centring — under perspective the near end of a 108 m hall projects much
  //     larger than the far end, so aiming at the geometric centre leaves the
  //     building low and left with dead sky above it, and the fit then has to pull
  //     back to keep the near corner in frame. Nudging the aim point until the
  //     PROJECTED bounding box is centred and re-fitting converges in 2-3 passes
  //     and buys a materially bigger warehouse for the same frame.
  // `target` is mutated in place with the recentred aim point.
  _fitDistance(target, dir, fill) {
    const cam = this.camera;
    const f = clamp(fill, 0.2, 1.0);
    const tanVf = Math.tan((cam.fov * Math.PI) / 360);   // true half-frustum
    const tanHf = tanVf * (cam.aspect || 1);
    const tanV = tanVf * f;                              // fitted (with margin)
    const tanH = tanHf * f;
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, dir);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const camUp = new THREE.Vector3().crossVectors(dir, right).normalize();
    const { width, depth } = this.bounds;
    const top = this._clearHeight() + 1.2;   // include the parapet band
    const v = new THREE.Vector3();
    const corners = [];
    for (const x of [0, width]) {
      for (const y of [0, top]) {
        for (const z of [0, depth]) corners.push([x, y, z]);
      }
    }
    const lo = Math.max(8, top * 1.6);
    const hi = Math.max(width, depth) * 6;
    let d = lo;
    for (let pass = 0; pass < 4; pass++) {
      d = 0;
      for (const c of corners) {
        v.set(c[0], c[1], c[2]).sub(target);
        const a = v.dot(dir);                 // + = toward the camera
        d = Math.max(d, a + Math.abs(v.dot(right)) / tanH,
          a + Math.abs(v.dot(camUp)) / tanV);
      }
      d = clamp(d, lo, hi);
      // Projected (NDC) bounding box at this distance.
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, zs = 0;
      for (const c of corners) {
        v.set(c[0], c[1], c[2]).sub(target);
        const depthC = Math.max(0.5, d - v.dot(dir));
        const sx = v.dot(right) / (depthC * tanHf);
        const sy = v.dot(camUp) / (depthC * tanVf);
        if (sx < x0) x0 = sx; if (sx > x1) x1 = sx;
        if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
        zs += depthC;
      }
      const ox = (x0 + x1) / 2;
      const oy = (y0 + y1) / 2;
      if (Math.abs(ox) < 0.004 && Math.abs(oy) < 0.004) break;
      const dm = zs / corners.length;
      target.addScaledVector(right, ox * tanHf * dm);
      target.addScaledVector(camUp, oy * tanVf * dm);
    }
    return d;
  },

  // -- Render / art presets --------------------------------------------------
  // Retune the WHOLE look coherently: background + fog distances, the four-light
  // rig, tone-mapping exposure, environment intensity, the shell tints, the
  // brightness of the high-bay fixtures/skylights and the painted-marking and
  // grid opacity. Geometry is never rebuilt, so this stays instant and safe.
  setPreset(name) {
    const p = PRESETS[name] || PRESETS.natural;
    this._preset = PRESETS[name] ? name : 'natural';
    const a = art(this._preset);
    const span = Math.max(this.bounds.width, this.bounds.depth);

    if (this.scene) {
      if (this.scene.background && this.scene.background.set) {
        this.scene.background.set(p.background);
      } else {
        this.scene.background = new THREE.Color(p.background);
      }
      if (this.scene.fog && this.scene.fog.color) this.scene.fog.color.set(p.fogColor);
      this._syncFog();
    }
    if (this._hemi) {
      this._hemi.color.set(p.hemiSky);
      this._hemi.groundColor.set(p.hemiGround);
      this._hemi.intensity = p.hemiInt * a.hemiScale;
    }
    if (this._ambient) {
      this._ambient.color.set(p.ambient);
      this._ambient.intensity = p.ambientInt * a.ambScale;
    }
    if (this._dir) {
      this._dir.color.set(p.dirColor);
      this._dir.intensity = p.dirInt * a.dirScale;
      // Soften/disable harsh raking shadows for the dim/flat presets.
      this._dir.castShadow = p.shadow !== false;
    }
    if (this._fill) {
      this._fill.color.set(a.fillColor);
      this._fill.intensity = a.fillInt;
    }
    if (this._bounce) {
      this._bounce.color.set(a.bounceColor);
      this._bounce.intensity = a.bounceInt;
    }
    if (this.renderer) {
      this.renderer.toneMappingExposure = a.exposure != null ? a.exposure : p.exposure;
      this.renderer.shadowMap.needsUpdate = true;
    }
    // Image-based lighting strength (the specular character of every material).
    this._applyEnvIntensity(a.env);
    // Floor concrete tone follows the preset (multiplies the baked texture).
    if (this._floorMat && this._floorMat.color) this._floorMat.color.setHex(a.floorTint);
    if (this._apronMat) this._apronMat.color.setHex(a.apron);
    if (this._markMat) this._markMat.opacity = a.mark;
    if (this._gridMat) {
      const tone = FLOOR_TONES[this._preset] || FLOOR_TONES.brand;
      this._gridMat.color.setHex(tone.gridA);
      this._gridMat.opacity = a.grid;
    }
    // Building shell tints.
    if (this._wallMat) this._wallMat.color.setHex(a.wall);
    for (const m of (this._shellMats || [])) m.color.setHex(a.wall);
    if (this._curbMat) this._curbMat.color.setHex(a.curb);
    if (this._ceilMat) {
      this._ceilMat.color.setHex(a.ceil);
      if (this._ceilMat.emissive) this._ceilMat.emissive.setHex(a.ceil);
      this._ceilMat.emissiveIntensity = a.ceilEmissive;
    }
    if (this._steelMat) this._steelMat.color.setHex(a.steel);
    if (this._columnMat) this._columnMat.color.setHex(a.column);
    if (this._parapetMat) this._parapetMat.color.setHex(a.parapet);
    // High-bay fixtures + skylights: the building's own light sources.
    if (this._fixtureMat) {
      this._fixtureMat.color.setHex(0xfff6e2).multiplyScalar(clamp(a.fixture / 4, 0.35, 3));
    }
    // Whether the lenses survive the roof cutaway (see _updateCutaway).
    this._lensAlwaysOn = a.fixture >= 5;
    if (this._fixtureLens) {
      this._fixtureLens.visible = this._cutInside !== false || this._lensAlwaysOn;
    }
    if (this._skyMat) this._skyMat.color.setHex(0xffffff).multiplyScalar(a.skylight);
    this._syncPointLights(a);
    // Rack emissive glow: subtle by day, strong at night.
    for (const m of this._rackMaterials) {
      if (m) m.emissiveIntensity = p.rackEmissive;
    }
    // Studio scenes finish on a seamless light sweep. Every preset paints a dark
    // background with a fog band tuned to dissolve the far wall of a BUILDING;
    // with the shell removed that fog is the only thing in the upper half of a
    // wide shot, and it reads as a black void the floor is floating in. This
    // runs LAST so the preset's lights and materials are all still applied — only
    // the sky, the fog and the apron change.
    if (this.replay.meta && this.replay.meta.studio && this.scene) {
      const bg = 0xeef2f6;
      if (this.scene.background && this.scene.background.setHex) this.scene.background.setHex(bg);
      else this.scene.background = new THREE.Color(bg);
      this.scene.fog = null;
      if (this._apronMat) this._apronMat.color.setHex(bg);
    }
  },

  // Fog band. Distances follow the preset so "夜/ドラマチック" hazes sooner than
  // "図面風" — but the band is ALWAYS pushed behind the hero framing distance, so
  // a preset can shade the horizon without greying out the warehouse itself.
  // Called from setPreset AND from frameDefault, because the hero distance is a
  // fit against the viewport and therefore changes on every resize (⛶ 拡大).
  _syncFog() {
    const fog = this.scene && this.scene.fog;
    if (!fog || !('near' in fog)) return;
    const a = art(this._preset);
    const span = Math.max(this.bounds.width, this.bounds.depth);
    const hero = this._heroDist || span * 1.25;
    const near = Math.max(span * a.fogNear, hero * 1.02);
    fog.near = near;
    fog.far = Math.max(span * a.fogFar, near + Math.max(span, hero) * 1.8);
  },

  // Currently active preset name.
  getPreset() {
    return this._preset;
  },

  // Free the baked environment map (its render target is not tracked in the
  // generic _textures list because PMREM owns a WebGLRenderTarget, not a
  // Texture). Called from Scene3D.dispose().
  _disposeEnvironment() {
    if (this.scene) this.scene.environment = null;
    if (this._envRT && this._envRT.dispose) this._envRT.dispose();
    this._envRT = null;
    for (const l of (this._pointLights || [])) {
      if (this.scene) this.scene.remove(l);
    }
    this._pointLights = [];
  },
};
