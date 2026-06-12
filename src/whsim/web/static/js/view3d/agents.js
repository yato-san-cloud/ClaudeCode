// view3d/agents.js — Scene3D's moving population + their per-frame animation:
// the human picker figures, the timetable staffing snapshot, AGVs, moving
// forklifts, manual route flow-lines, the soft contact-shadow blobs, the
// additive cyan activity halos (pseudo-bloom), the pooled pick-event markers,
// and every _update*() that interpolates them off the keyframe sampler each
// frame (workers/AGVs/forklifts/AS-RS crane/staging buffer/belts/shadows/halos).
// Mixed into Scene3D.prototype by view3d.js; every method is moved verbatim (no
// value changes) and runs with `this` bound to the Scene3D instance, so the
// shared agent records + tracked GPU resources match the monolith exactly.
import * as THREE from '../../vendor/three/three.module.js';
import {
  STATE_COLOR, ABC_COLOR, AGV_COLOR, AGV_Y, GLOW_CYAN,
  ACTIVE_WORKER, ACTIVE_AGV, CARRY_AGV, ROUTE_COLOR,
  PICK_GLOW, PICK_LINE, sampleKeyframes, approach, _enableShadows,
} from './constants.js';

export const agentMethods = {
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
      const rec = {
        mesh: g, vestMat, armPivot, tote, keyframes: wk.keyframes || [],
        glow: 0, reach: 0, faceYaw: 0, idx: this._workers.length, kind: 'worker',
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
      const rec = { mesh, keyframes: a.keyframes || [], mat, tote, dome, domeMat, glow: 0, kind: 'agv', idx: this._agvs.length };
      mesh.userData.agentRef = rec; // raycaster hit → agent record (see _pickAgent)
      this._agvs.push(rec);
    }
  },

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
      const rec = {
        group: g, keyframes: f.keyframes || [], yaw: 0, carriage, load, lift: 0,
        kind: 'forklift', idx: this._forklifts.length,
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
  },

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
  },

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
    const y = Math.min(1.3, (r.dims.h || 2.0) * 0.45); // mid-reach height
    out.set(cx + nx * off, y, cz + nz * off);
    return out;
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
