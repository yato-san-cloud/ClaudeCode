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

    const meta = this.replay.meta || {};
    const bounds = meta.bounds || { width: 20, depth: 20 };
    this.bounds = { width: bounds.width || 20, depth: bounds.depth || 20 };

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);

    // Renderer.
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    // Scene + camera.
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf2f4f7);

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
    this._buildZones();
    this._buildRacks();
    this._buildStations();
    this._buildWorkers();

    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  // Track meshes so dispose() can free GPU resources.
  _track(geom, mat) {
    if (geom) this._geometries.push(geom);
    if (mat) this._materials.push(mat);
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x808080, 0.9);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(this.bounds.width, this.bounds.depth, this.bounds.depth);
    this.scene.add(dir);
  }

  _buildFloor() {
    const { width, depth } = this.bounds;
    const geom = new THREE.BoxGeometry(width, 0.1, depth);
    const mat = new THREE.MeshLambertMaterial({ color: 0xdfe3e8 });
    const floor = new THREE.Mesh(geom, mat);
    floor.position.set(width / 2, -0.05, depth / 2);
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
      const mat = new THREE.MeshLambertMaterial({ color });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(r.x || 0, 0.6, r.y || 0);
      this.scene.add(mesh);
      this._materials.push(mat);
    }
  }

  _buildStations() {
    const stations = this.replay.stations || [];
    if (stations.length === 0) return;
    const geom = new THREE.CylinderGeometry(0.5, 0.5, 1.4, 16);
    this._geometries.push(geom);
    for (const s of stations) {
      const mat = new THREE.MeshLambertMaterial({ color: 0x08519c });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(s.x || 0, 0.7, s.y || 0);
      this.scene.add(mesh);
      this._materials.push(mat);
    }
  }

  _buildWorkers() {
    const workers = this.replay.workers || [];
    if (workers.length === 0) return;
    const geom = new THREE.SphereGeometry(0.6, 16, 12);
    this._geometries.push(geom);
    for (const wk of workers) {
      const mat = new THREE.MeshLambertMaterial({ color: STATE_COLOR.idle });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(0, 0.7, 0);
      this.scene.add(mesh);
      this._materials.push(mat);
      this._workers.push({ mesh, keyframes: wk.keyframes || [] });
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

  _loop() {
    if (this._disposed) return;
    const t = this.getTime() || 0;
    this._updateWorkers(t);
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
    this._geometries = [];
    this._materials = [];
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
