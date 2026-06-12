// view3d/scene.js — Scene3D's static environment + art presets: lights, the
// procedural concrete floor + grid, zone overlays, the staging buffer box,
// stations, conveyors (with the scrolling belt texture), the building shell
// (walls + doors), the 3D congestion heat patches, and setPreset/getPreset (the
// only methods here that mutate the live render — lights/fog/exposure/floor tone
// only, never geometry). Mixed into Scene3D.prototype by view3d.js; every method
// is moved verbatim (no value changes) and runs with `this` bound to the Scene3D
// instance, so the scene graph + tracked GPU resources match the monolith.
import * as THREE from '../../vendor/three/three.module.js';
import { FLOOR_TONES, PRESETS, meta_grid } from './constants.js';

export const sceneMethods = {
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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  // -- Building shell --------------------------------------------------------
  // Walls: thin tall boxes along each polyline segment. Doors: short colored
  // frame markers. Both defensive against missing/empty arrays.
  _buildShell() {
    this._buildWalls();
    this._buildDoors();
  },

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
  },

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
  },

  // Currently active preset name.
  getPreset() {
    return this._preset;
  },
};
