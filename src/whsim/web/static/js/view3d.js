// view3d.js — three.js 3D replay view of a warehouse simulation (whsim WS3).
//
// Coordinate mapping: replay positions are METERS on a floor.
//   floor (px, py) -> THREE position (px, 0, py)   (three.js y is UP, py is depth)
//
// Build static geometry once from `replay`, then run a rAF loop that reads
// getTime() and interpolates worker positions/states via keyframes.
import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/controls/OrbitControls.js';

// Worker state -> color.
const STATE_COLOR = {
  idle:   0x9e9e9e,
  travel: 0x1f78b4,
  carry:  0x6a3d9a,
  pick:   0x33a02c,
  pack:   0xe31a1c,
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

// Render / art presets. Each tweaks background, fog, light intensities/colors
// and tone-mapping exposure ONLY — never static geometry. See setPreset().
// `shadow`: enable hard cast shadows for this preset; `shadowOpacity` controls
// how dark the contact shadow reads (lower = softer/lighter).
const PRESETS = {
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
const ROUTE_COLOR = { forklift: 0xff7a00, person: 0x00b8d4 };

// Equipment type -> base color (placed/static equipment models).
const EQUIP_COLOR = {
  agv:       0x3949ab,
  forklift:  0xf57c00,
  asrs:      0x8d949c,
  robot_arm: 0x9aa3ad,
  crane:     0x424a52,
};

// Sample [t, x, y, state] from a worker's sorted keyframe array (see spec).
function sampleKeyframes(keyframes, t) {
  if (!keyframes || keyframes.length === 0) return { x: 0, y: 0, state: 'idle' };
  const first = keyframes[0];
  if (t <= first[0]) return { x: first[1], y: first[2], state: 'idle' };
  const last = keyframes[keyframes.length - 1];
  if (t >= last[0]) return { x: last[1], y: last[2], state: last[3] };
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
  return {
    x: k0[1] + (k1[1] - k0[1]) * f,
    y: k0[2] + (k1[2] - k0[2]) * f,
    state: k0[3],
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
    this._preset = 'natural';

    const meta = this.replay.meta || {};
    const bounds = meta.bounds || { width: 20, depth: 20 };
    this.bounds = { width: bounds.width || 20, depth: bounds.depth || 20 };

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);

    // Renderer.
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
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
    this.scene.background = new THREE.Color(0xeef1f5);
    // Gentle distance fog keeps the far edge of large floors soft. The actual
    // colors/exposure are set by applyPreset(); near/far distances are fixed.
    const fogStart = Math.max(this.bounds.width, this.bounds.depth) * 2.0;
    this.scene.fog = new THREE.Fog(0xeef1f5, fogStart, fogStart * 2.5);

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 5000);
    const cx = this.bounds.width / 2;
    const cz = this.bounds.depth / 2;
    const span = Math.max(this.bounds.width, this.bounds.depth);
    this.camera.position.set(cx, span * 0.9, cz + span * 1.1);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(cx, 0, cz);
    this.controls.update();

    this._buildLights();
    this._buildFloor();
    this._buildShell();
    this._buildZones();
    this._buildRacks();
    this._buildStations();
    this._buildConveyors();
    this._buildEquipment();
    this._buildWorkers();
    this._buildAgvs();
    this._buildForklifts();
    this._buildRoutes();

    // Apply the default art preset (mutates lights/renderer/scene only).
    this.setPreset(this._preset);

    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
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
    tex.anisotropy = this.renderer.capabilities ? this.renderer.capabilities.getMaxAnisotropy() : 1;
    this._textures.push(tex);
    return tex;
  }

  _buildFloor() {
    const { width, depth } = this.bounds;
    const geom = new THREE.BoxGeometry(width, 0.1, depth);
    const tex = this._makeFloorTexture(meta_grid(this.replay));
    const mat = new THREE.MeshStandardMaterial({
      color: 0xeef1f5, roughness: 1.0, metalness: 0.0, map: tex,
    });
    const floor = new THREE.Mesh(geom, mat);
    floor.position.set(width / 2, -0.05, depth / 2);
    floor.receiveShadow = true; // catches contact shadows of every object
    this.scene.add(floor);
    this._track(geom, mat);

    // Subtle grid aligned to the floor; GridHelper is centered at origin.
    const grid = meta_grid(this.replay);
    const divisions = Math.max(1, Math.round(Math.max(width, depth) / grid));
    const helper = new THREE.GridHelper(Math.max(width, depth), divisions, 0xb0b8c0, 0xc8cfd6);
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

  _buildRacks() {
    const racks = this.replay.racks || [];
    if (racks.length === 0) return;
    const geom = new THREE.BoxGeometry(0.8, 1.2, 0.8); // shared geometry
    this._geometries.push(geom);
    for (const r of racks) {
      const color = ABC_COLOR[r.abc] || 0xfdcc8a;
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 0.78, metalness: 0.08,
        emissive: new THREE.Color(color), emissiveIntensity: 0.06,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(r.x || 0, 0.6, r.y || 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this._materials.push(mat);
      this._rackMaterials.push(mat); // preset adjusts emissiveIntensity (night glow)
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
    for (const c of conveyors) {
      const pts = c.points || [];
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
        const mat = new THREE.MeshStandardMaterial({
          color: 0x9aa3ad, roughness: 0.35, metalness: 0.7,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(
          (p0[0] || 0) + dx / 2, yMid, (p0[1] || 0) + dz / 2,
        );
        mesh.rotation.y = -Math.atan2(dz, dx);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        this._track(geom, mat);
      }
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
    // Rack emissive glow: subtle by day, strong at night.
    for (const m of this._rackMaterials) {
      if (m) m.emissiveIntensity = p.rackEmissive;
    }
  }

  // Currently active preset name.
  getPreset() {
    return this._preset;
  }

  _buildWorkers() {
    const workers = this.replay.workers || [];
    if (workers.length === 0) return;
    const geom = new THREE.SphereGeometry(0.6, 16, 12);
    this._geometries.push(geom);
    for (const wk of workers) {
      const mat = new THREE.MeshStandardMaterial({
        color: STATE_COLOR.idle, roughness: 0.45, metalness: 0.05,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(0, 0.7, 0);
      mesh.castShadow = true;
      this.scene.add(mesh);
      this._materials.push(mat);
      this._workers.push({ mesh, keyframes: wk.keyframes || [] });
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
    for (const a of agvs) {
      const mat = new THREE.MeshStandardMaterial({
        color: AGV_COLOR.idle, roughness: 0.35, metalness: 0.55,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(0, AGV_Y, 0);
      mesh.castShadow = true;
      this.scene.add(mesh);
      this._materials.push(mat);
      this._agvs.push({ mesh, keyframes: a.keyframes || [] });
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
      for (const dx of [-0.25, 0.25]) {
        const p = new THREE.Mesh(prongGeom, forkMat);
        p.position.set(dx, 0.1, 1.4);
        g.add(p);
      }
      _enableShadows(g);
      this.scene.add(g);
      this._forklifts.push({ group: g, keyframes: f.keyframes || [], yaw: 0 });
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

  // Per-frame: interpolate each worker's position + state color.
  _updateWorkers(t) {
    for (const w of this._workers) {
      const s = sampleKeyframes(w.keyframes, t);
      w.mesh.position.set(s.x, 0.7, s.y);
      const color = STATE_COLOR[s.state] !== undefined ? STATE_COLOR[s.state] : STATE_COLOR.idle;
      w.mesh.material.color.set(color);
    }
  }

  // Per-frame: interpolate each AGV's position + action color (same sampler).
  _updateAgvs(t) {
    for (const a of this._agvs) {
      const s = sampleKeyframes(a.keyframes, t);
      a.mesh.position.set(s.x, AGV_Y, s.y);
      const color = AGV_COLOR[s.state] !== undefined ? AGV_COLOR[s.state] : AGV_COLOR.idle;
      a.mesh.material.color.set(color);
    }
  }

  // Per-frame: interpolate each moving forklift's position (same sampler) and
  // yaw it toward its direction of travel using a small look-ahead sample.
  _updateForklifts(t) {
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
      if (vx * vx + vz * vz > 1e-6) {
        // Model's forks face +Z, so yaw rotates +Z onto (vx, vz).
        f.yaw = Math.atan2(vx, vz);
      }
      f.group.rotation.y = f.yaw;
    }
  }

  _loop() {
    if (this._disposed) return;
    const t = this.getTime() || 0;
    this._updateWorkers(t);
    this._updateAgvs(t);
    this._updateForklifts(t);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this._raf = requestAnimationFrame(this._loop);
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
    if (this._raf) cancelAnimationFrame(this._raf);
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
    if (this.renderer) {
      this.renderer.dispose();
      const el = this.renderer.domElement;
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
  }
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
