// view3d.js — three.js 3D replay view of a warehouse simulation (whsim WS3).
//
// Coordinate mapping: replay positions are METERS on a floor.
//   floor (px, py) -> THREE position (px, 0, py)   (three.js y is UP, py is depth)
//
// Build static geometry once from `replay`, then run a rAF loop that reads
// getTime() and interpolates worker positions/states via keyframes.
//
// This file is the Scene3D SHELL: the public class (constructor + state +
// _loop/_monitorFps/_degrade/resize/dispose). The bulk of the implementation
// lives in cohesive view3d/*.js method groups, mixed onto Scene3D.prototype via
// Object.assign (a pure structural split — every method still runs with `this`
// bound to the Scene3D instance, so the scene graph, shared state and call graph
// are byte-for-byte what the monolith had):
//   view3d/constants.js — pure data tables + stateless helpers (sampleKeyframes…)
//   view3d/geometry.js   — rack / equipment builders
//   view3d/scene.js      — lights / floor / zones / shell / heat + presets
//   view3d/agents.js     — workers / AGVs / forklifts / fx + per-frame updates
//   view3d/overlay.js    — bottleneck / selection / HUD / legend / intro
import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/controls/OrbitControls.js';
import { geometryMethods } from './view3d/geometry.js';
import { sceneMethods } from './view3d/scene.js';
import { agentMethods } from './view3d/agents.js';
import { overlayMethods } from './view3d/overlay.js';

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
    this._bottleneck = null;  // { group, beamMat, ringMat, label, ... } spotlight or null
    this._hud = null;         // DOM overlay { root, ... } or null
    this._info = null;        // controls-hint + legend DOM overlay or null
    this._intro = null;       // intro camera tween state or null
    this._preset = 'brand';
    this._belts = [];         // animated conveyor belt mats { mat, speed }
    this._beltSpeed = 1;      // global multiplier (0 = static, e.g. reduced-motion)
    this._fps = null;         // fps monitor / auto-degrade state or null
    this._sel = null;         // agent selection state { ring, tip, ... } or null
    this._clock = new THREE.Clock(); // delta-time source for belt flow
    this._envRT = null;       // PMREM render target backing scene.environment
    this._ceilH = 0;          // memoised building clear height (m)
    this._env = null;         // memoised envelope segments
    this._obstacles = null;   // memoised rack footprints (column/paint dodging)
    this._pointLights = [];   // optional real high-bay PointLights (preset-gated)
    this._shellMats = [];     // per-segment wall panel clones (preset re-tint)
    // Shadow refresh cadence. Re-rendering a 2048² shadow map for a 600-rack
    // floor EVERY frame is the single most expensive thing in the scene, and the
    // static geometry that dominates it never moves — agents already carry their
    // own soft blob shadows. Refreshing every Nth frame keeps the shadows honest
    // at roughly a third of the cost. _degrade() can freeze it entirely.
    this._shadowEvery = 3;
    this._shadowFrame = 0;
    this._shadowFrozen = false;

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
    // Colour pipeline: render linear, output sRGB, and land it through the ACES
    // filmic curve so bright fixtures/skylights roll off instead of clipping to
    // flat white. Exposure is re-tuned per art preset (setPreset).
    if ('outputColorSpace' in this.renderer) {
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    }
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // Soft, proposal-grade shadows. PCFSoft gives a fixed wide kernel in ONE
    // pass — VSM's blur passes would cost two extra full shadow-map renders per
    // frame for a softness we get from the fitted frustum anyway.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // Scene + camera.
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f141d);
    // Distance fog dissolves the far edge of a large floor (and the outdoor
    // apron) into the background colour. Colour AND near/far are retuned per
    // preset in setPreset(); these are just safe initial values.
    const fogSpan = Math.max(this.bounds.width, this.bounds.depth);
    this.scene.fog = new THREE.Fog(0x121a26, fogSpan * 0.75, fogSpan * 2.9);

    // Near plane at 0.1 on a 100 m building wastes most of the depth buffer and
    // shows up as z-fighting on the floor decals; 0.35 is still closer than the
    // camera ever gets and buys a couple of bits of precision back.
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.35, Math.max(2000, fogSpan * 12));
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

    // Image-based lighting FIRST: the baked environment map is what gives every
    // MeshStandardMaterial built below a real specular response.
    this._buildEnvironment();
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
    // Click-to-select interactivity: a floor ring marker + a live DOM tooltip,
    // driven by a raycaster on the canvas. Additive; cleaned up in dispose().
    this._buildSelection();
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
    this._updateBottleneck();     // pulse the bottleneck spotlight (if any)
    this._updateSelection(t, dt); // track ring/tooltip under the selected agent
    this._updateHud(t);           // sync DOM productivity overlay (if present)
    this._monitorFps(dt);         // auto-degrade if frame time gets heavy
    this._tickShadows();          // refresh the shadow map on a cadence, not every frame
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this._raf = requestAnimationFrame(this._loop);
  }

  // Drive the shadow map off a frame cadence instead of every frame. The scene's
  // shadow cost is dominated by re-rasterising hundreds of static rack
  // InstancedMeshes into a 2048² depth map; nothing about that changes between
  // frames, and the only movers (pickers/AGVs) already have soft blob shadows
  // under them. `_shadowFrozen` (set by _degrade tier 2) stops it entirely.
  _tickShadows() {
    const sm = this.renderer && this.renderer.shadowMap;
    if (!sm) return;
    if (this._shadowFrozen) { sm.autoUpdate = false; return; }
    sm.autoUpdate = false;
    this._shadowFrame = (this._shadowFrame + 1) % Math.max(1, this._shadowEvery);
    if (this._shadowFrame === 0) sm.needsUpdate = true;
  }

  // -- FPS monitor / auto-degrade -------------------------------------------
  // Lightweight rolling-average frame timer. If sustained fps drops below a
  // floor, shed cost in a safe order. There is NO post-processing in this build
  // (no EffectComposer/Bloom vendored), so the levers are: (1) drop the pixel
  // ratio to 1, (2) stop the conveyor belt texture scroll, (3) disable dynamic
  // shadow updates, then (4) drop the additive glow halos (the pseudo-bloom).
  // All are additive/reversible and never touch geometry or the data contract.
  _monitorFps(dt) {
    if (dt <= 0) return;
    const f = this._fps || (this._fps = {
      ema: 60, acc: 0, level: 0, savedBelt: this._beltSpeed,
    });
    // Exponential moving average of instantaneous fps.
    const inst = 1 / dt;
    f.ema = f.ema * 0.9 + inst * 0.1;
    // Only act after a short warm-up window of sustained low fps.
    if (f.ema < 30 && f.level < 4) {
      f.acc += dt;
      if (f.acc > 2.0) { this._degrade(f); f.acc = 0; }
    } else {
      f.acc = Math.max(0, f.acc - dt * 0.5);
    }
  }

  // Shed one tier of cost (pixel ratio → belts → shadows → glow halos).
  // Reduced-motion already froze belts, so on weak GPUs this mainly drops
  // resolution, then shadow updates, then halos.
  _degrade(f) {
    if (f.level === 0) {
      // Tier 1: drop to 1 device pixel per CSS pixel. On a fragment-bound
      // device this is by far the biggest saving for the least visible loss —
      // the lighting, shadows and materials all survive intact.
      if (this.renderer && this.renderer.getPixelRatio() > 1) {
        this.renderer.setPixelRatio(1);
        this.resize();
      }
      f.level = 1;
    } else if (f.level === 1) {
      // Tier 2: freeze conveyor scroll (cheapest visual to lose).
      this._beltSpeed = 0;
      f.level = 2;
    } else if (f.level === 2) {
      // Tier 3: stop updating cast shadows (keeps the last shadow frame static).
      this._shadowFrozen = true;
      if (this.renderer) this.renderer.shadowMap.autoUpdate = false;
      f.level = 3;
    } else if (f.level === 3) {
      // Tier 4: drop the additive glow halos and hide any showing now.
      this._glowEnabled = false;
      for (const h of this._glowSprites) { if (h.sprite) h.sprite.visible = false; }
      f.level = 4;
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
    // Tear down click-to-select: detach canvas listeners, drop the floor ring
    // from the scene (its geom/mat are tracked in _geometries/_materials and
    // freed below), and remove the DOM tooltip card. Then null the state.
    if (this._sel) {
      const el = this.renderer && this.renderer.domElement;
      if (el) {
        if (this._onSelDown) el.removeEventListener('pointerdown', this._onSelDown);
        if (this._onSelUp) el.removeEventListener('pointerup', this._onSelUp);
        if (this._onSelDbl) el.removeEventListener('dblclick', this._onSelDbl);
      }
      if (this._sel.ring) this.scene.remove(this._sel.ring);
      if (this._sel.tip && this._sel.tip.parentNode) {
        this._sel.tip.parentNode.removeChild(this._sel.tip);
      }
    }
    this._sel = null;
    this._onSelDown = null;
    this._onSelUp = null;
    this._onSelDbl = null;
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
    this._disposeBottleneck();    // remove spotlight group + free its own GPU refs
    // Free the baked PMREM environment (a WebGLRenderTarget, so it is not in the
    // generic _textures list) and drop any preset-gated high-bay PointLights.
    this._disposeEnvironment();
    this._shellMats = [];
    this._env = null;
    this._obstacles = null;
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

// ---- prototype synthesis ---------------------------------------------------
// Compose the extracted method groups onto Scene3D.prototype. Order is
// irrelevant (the groups are disjoint — no method name appears in two modules),
// and each method still runs with `this` bound to the Scene3D instance, so the
// shared mutable state and call graph are byte-for-byte what the monolith had.
Object.assign(
  Scene3D.prototype,
  geometryMethods,
  sceneMethods,
  agentMethods,
  overlayMethods,
);
