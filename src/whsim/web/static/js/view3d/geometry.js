// view3d/geometry.js — three.js geometry/material builders for Scene3D: the
// realistic per-rack_type storage equipment (pallet-rack uprights/beams/bracing/
// wire decking, shelving panels, flow roller lanes, nestainer/hanger/mezzanine/
// mobile carriages, AS/RS tower + stacker crane), the palletised + cartonised
// LOAD, the legacy point-rack fallback, and the static placed-equipment
// composites (forklift/AS-RS/robot arm/crane/dock/sorter). Mixed into
// Scene3D.prototype by view3d.js via Object.assign; every method runs with
// `this` bound to the Scene3D instance, so the scene graph and shared state
// (_geometries/_materials/_textures/_rackMaterials/_shelfRuns/_belts/_asrsCrane)
// stay exactly the contract the rest of the view expects.
//
// Everything storage-side is built as InstancedMesh over per-bay/per-slot
// transforms and, crucially, as MERGED part geometries: one bay's whole upright
// frame (posts + footplates + bracing) is a single BufferGeometry instanced once
// per bay, so a 616-location DC costs ~6 draw calls per rack type instead of
// thousands of meshes. See RACK_LOD in constants.js for the count-based tier and
// the distance-based fine-detail rule that keep it fast at scale.
import * as THREE from '../../vendor/three/three.module.js';
import {
  ABC_COLOR, RACK_DIMS, RACK_DEFAULT, rackDims,
  RACK_STEEL, RACK_BEAM, RACK_BOARD, PALLET_WOOD, ROLLER_COLOR,
  ASRS_FRAME, ASRS_CRANE, EQUIP_COLOR, _enableShadows,
  RACK_UPRIGHT, RACK_BRACE, RACK_FOOT, RACK_GALV, SHELF_PANEL,
  CARRIAGE_DARK, RAIL_STEEL, CARTON_BASE, CARTON_TONES, TOTE_TONES,
  GARMENT_TONES, RACK_LOD,
} from './constants.js';

// ---- tiny deterministic hash -----------------------------------------------
// Stable pseudo-random in [0,1) from two integers. Used ONLY for cosmetic
// variation (carton size/rotation/tone, which slot reads as empty when the model
// carries no quantities) so the same model always renders identically.
function _rnd(a, b) {
  let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 1274126177) >>> 0; h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}

// Rotate a bay-local (dx, dz) offset into world XZ around the bay centre. Same
// convention as _bayLocal (local +Z is the bay's open/pick face).
function _worldXZ(bay, dx, dz, out) {
  const c = Math.cos(bay.yaw), s = Math.sin(bay.yaw);
  out[0] = bay.x + dx * c + dz * s;
  out[1] = bay.z - dx * s + dz * c;
  return out;
}

export const geometryMethods = {
  // Racks: build realistic storage equipment from `replay.shelves` (the MapMaker
  // run contract: {x, y0, y1, depth, pitch, rack_type, cells, [rect, facing,
  // vertical]}). Each run is subdivided into BAYS at the rack type's bay pitch,
  // oriented so the pick face opens toward the aisle (from `facing`), and built
  // with per-rack_type realistic geometry.
  //
  // Falls back to the legacy per-point builder when there are no shelf runs.
  _buildRacks() {
    const shelves = this.replay.shelves || [];
    this._rackDetail = [];   // fine meshes toggled by the distance LOD rule
    if (shelves.length === 0) {
      this._buildRacksFromPoints();   // legacy fallback (racks = location points)
      return;
    }

    // 1) Expand every run into a flat list of BAYS. A bay is one storage position
    //    with a world centre (x,z), a yaw (so its pick face points to the aisle),
    //    a width along the run, the rack_type, an ABC class and the authored cell
    //    (SKU/qty) it came from. This decouples geometry construction (step 2)
    //    from layout maths.
    const baysByType = {}; // "rack_type|bayWidth" -> { rt, bw, bays: [...] }
    // Also remember, per run, the first bay's frame so pick-events can locate a
    // target cell quickly (run_id + along → world position) without re-deriving.
    this._shelfRuns = [];   // [{x0,z0, ux,uz, length, yaw, rt, dims}] per run
    let bi = 0;             // global bay index (stable seed for cosmetic variation)
    let maxQty = 0;
    for (const run of shelves) {
      for (const c of (run.cells || [])) { if (+c.qty > maxQty) maxQty = +c.qty; }
    }
    for (let ri = 0; ri < shelves.length; ri++) {
      const run = shelves[ri];
      const rt = RACK_DIMS[run.rack_type] ? run.rack_type : RACK_DEFAULT;
      const dims = rackDims(rt);
      const frame = this._runFrame(run, dims);   // axis + footprint of this run
      this._shelfRuns.push({ ...frame, ri, rt, dims });
      const cells = run.cells || [];
      const bayW = frame.bayW;
      const nBays = Math.max(1, Math.round(frame.length / bayW));
      const bw = frame.length / nBays;
      // Group by (type, bay width quantised to 5 cm): merged bay geometry is
      // built at a FIXED width, so bays of the same width share one draw call.
      const key = rt + '|' + (Math.round(bw * 20) / 20).toFixed(2);
      const grp = baysByType[key] || (baysByType[key] = { rt, bw, bays: [] });
      for (let b = 0; b < nBays; b++) {
        // Bay centre marches along the run's unit axis from its start.
        const along = (b + 0.5) * bw;
        const x = frame.x0 + frame.ux * along;
        const z = frame.z0 + frame.uz * along;
        // Prefer the authored cell nearest this bay's along-fraction.
        const cell = cells.length
          ? cells[Math.min(cells.length - 1, Math.floor((along / frame.length) * cells.length))]
          : null;
        const abc = cell && ABC_COLOR[cell.abc] !== undefined ? cell.abc : 'C';
        // Occupancy is DATA: a bay whose cell carries no SKU (and no qty) reads
        // as an empty position. Runs with no authored cells at all keep the
        // legacy "stocked" look. `fill` scales how many levels read as full —
        // real quantities when the model has them, else a light cosmetic scatter.
        const occupied = cells.length === 0
          ? true
          : !!(cell && (cell.sku || +cell.qty > 0));
        const fill = (cell && maxQty > 0 && +cell.qty > 0)
          ? Math.max(0.3, Math.min(1, +cell.qty / maxQty))
          : 0.88;
        grp.bays.push({
          x, z, yaw: frame.yaw, bw, abc, depth: dims.depth, cell, bi: bi++,
          occupied, fill,
        });
      }
    }

    // 2) Pick the geometry detail tier from the total bay count (see RACK_LOD).
    this._rackLod = this._rackLodTier(bi);

    // 3) Build each group with its dedicated realistic builder. Each builder
    //    pushes InstancedMeshes (low draw-call) into the scene.
    for (const key of Object.keys(baysByType)) {
      const { rt, bw, bays } = baysByType[key];
      if (!bays.length) continue;
      switch (rt) {
        case 'pallet':    this._buildPalletRack(bays, bw); break;
        case 'flow':      this._buildFlowRack(bays, bw); break;
        case 'asrs':      this._buildAsrsRack(bays, bw); break;
        case 'nestainer': this._buildNestainer(bays, bw); break;
        case 'hanger':    this._buildHangerRack(bays, bw); break;
        case 'mezzanine': this._buildMezzanine(bays, bw); break;
        case 'mobile':    this._buildMobileRack(bays, bw); break;
        case 'light':
        case 'medium':
        default:          this._buildShelving(bays, rt, bw); break;
      }
    }

    // 4) Arm the distance-based fine-detail rule (no-op when nothing is fine).
    this._armRackDetailLod();
  },

  // COUNT-based LOD tier for the whole scene (0 fine / 1 mid / 2 coarse).
  _rackLodTier(totalBays) {
    if (totalBays <= RACK_LOD.fine) return 0;
    if (totalBays <= RACK_LOD.coarse) return 1;
    return 2;
  },

  // DISTANCE-based fine-detail rule. Bracing / wire decking / ABC labels are
  // sub-pixel from a wide overview camera, so they are hidden until the camera
  // orbits within RACK_LOD.detailDist metres of its target. Driven by a 1-triangle
  // always-rendered probe whose onBeforeRender gives us a per-frame camera hook
  // WITHOUT touching the renderer/agent loops (other lanes own those files).
  _armRackDetailLod() {
    const detail = this._rackDetail || [];
    if (!detail.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    const m = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false });
    this._geometries.push(g);
    this._materials.push(m);
    const probe = new THREE.Mesh(g, m);
    probe.frustumCulled = false;
    probe.renderOrder = -1000;
    probe.onBeforeRender = (renderer, scene, camera) => {
      if (this._disposed) return;
      const tgt = (this.controls && this.controls.target) || probe.position;
      const d = camera.position.distanceTo(tgt);
      const on = d <= RACK_LOD.detailDist;
      if (on === this._rackDetailOn) return;
      this._rackDetailOn = on;
      for (const mesh of detail) mesh.visible = on;
    };
    this._rackDetailOn = null;
    this.scene.add(probe);
  },

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
    // The run marches along +Z, so a bay's WIDTH must lie along Z and its depth
    // (and pick face) along ±X — i.e. the same vertical-run yaw the authored path
    // uses. (Before v0.3.0 this returned yaw 0, which laid each bay's width across
    // the run and left half-metre gaps between them instead of a continuous rack
    // run; the 2D/PNG views always drew these runs as one solid rectangle.)
    const y0 = run.y0 || 0, y1 = run.y1 || 0;
    const length = Math.max(0.1, Math.abs(y1 - y0));
    return {
      x0: run.x || 0, z0: Math.min(y0, y1), ux: 0, uz: 1,
      length, bayW, yaw: this._facingYaw(run.facing, true),
      depth: run.depth || dims.depth,
    };
  },

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
  },

  // Helper: make + register a standard rack material (tracked for dispose). When
  // `glowable`, it is also registered in _rackMaterials so presets pulse its
  // night-time emissive glow exactly like the legacy goods boxes.
  _rackMat(opts, glowable) {
    const mat = new THREE.MeshStandardMaterial(opts);
    this._materials.push(mat);
    if (glowable) this._rackMaterials.push(mat);
    return mat;
  },

  // -- procedural textures (cheap, shared, 3 canvases total) -----------------
  // Corrugated kraft cardboard with a taped centre seam and a shipping label.
  // instanceColor multiplies this, so per-carton tone variation stays *paper*.
  _cartonTexture() {
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const c = cv.getContext('2d');
    // Kraft base: a slight top-lit gradient around the reference kraft tone.
    const kraft = new THREE.Color(CARTON_BASE);
    const g = c.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, '#' + kraft.clone().offsetHSL(0, 0, 0.09).getHexString());
    g.addColorStop(1, '#' + kraft.clone().offsetHSL(0, 0, -0.05).getHexString());
    c.fillStyle = g; c.fillRect(0, 0, S, S);
    // Fluting: fine horizontal corrugation lines.
    c.strokeStyle = 'rgba(90,60,30,0.10)'; c.lineWidth = 1;
    for (let y = 2; y < S; y += 4) {
      c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(S, y + 0.5); c.stroke();
    }
    // Centre flap seam + packing tape over it.
    c.fillStyle = 'rgba(70,45,20,0.28)'; c.fillRect(S / 2 - 1, 0, 2, S);
    c.fillStyle = 'rgba(226,206,170,0.75)'; c.fillRect(S / 2 - 9, 0, 18, S);
    c.fillStyle = 'rgba(255,255,255,0.20)'; c.fillRect(S / 2 - 9, 0, 3, S);
    // Shipping label: white patch + text rules + a barcode block.
    c.fillStyle = '#f4f2ec'; c.fillRect(12, 74, 46, 32);
    c.fillStyle = 'rgba(60,60,60,0.55)';
    c.fillRect(16, 80, 34, 2); c.fillRect(16, 85, 26, 2);
    for (let i = 0; i < 13; i++) {
      if (i % 3 === 0) continue;
      c.fillRect(16 + i * 2.6, 92, 1.3, 10);
    }
    // A stencil-ish handling mark on the other side.
    c.strokeStyle = 'rgba(70,45,20,0.35)'; c.lineWidth = 2;
    c.strokeRect(78, 22, 30, 30);
    const tex = new THREE.CanvasTexture(cv);
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    this._textures.push(tex);
    return tex;
  },

  // Galvanised welded wire mesh (rack decking) — light wires on a dark void so a
  // decked level reads see-through-ish without paying for real transparency.
  _meshTexture() {
    const S = 64;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const c = cv.getContext('2d');
    c.fillStyle = '#5f6873'; c.fillRect(0, 0, S, S);   // the shaded gaps
    c.strokeStyle = '#eef3f8'; c.lineWidth = 3;        // the galvanised wires
    for (let i = 0; i <= 4; i++) {
      const p = i * (S / 4) + 0.5;
      c.beginPath(); c.moveTo(p, 0); c.lineTo(p, S); c.stroke();
      c.beginPath(); c.moveTo(0, p); c.lineTo(S, p); c.stroke();
    }
    // A darker hairline beside each wire reads as its shadow on the pallet below.
    c.strokeStyle = 'rgba(20,26,34,0.45)'; c.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const p = i * (S / 4) + 2.5;
      c.beginPath(); c.moveTo(p, 0); c.lineTo(p, S); c.stroke();
      c.beginPath(); c.moveTo(0, p); c.lineTo(S, p); c.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 3);
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    this._textures.push(tex);
    return tex;
  },

  // Perforated upright: the punched slot pattern every real rack frame carries.
  // Mostly white so the material's paint colour shows through; the slots are the
  // dark holes. Repeated up the post.
  _perfTexture() {
    const W = 32, H = 128;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(10,14,20,0.72)';
    for (let y = 6; y < H; y += 16) {
      c.fillRect(W / 2 - 3, y, 6, 9);
    }
    // Faint edge shading so the post reads as a folded C-section, not a slab.
    const g = c.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.16)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.14)');
    g.addColorStop(1, 'rgba(0,0,0,0.16)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 6);
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    this._textures.push(tex);
    return tex;
  },

  // Shared PBR material library for every rack builder. Built once per scene and
  // reused across rack types so materials/textures/draw-state stay tiny. Steel is
  // metallic + smooth-ish (so Lane A's env/lights make it read as steel);
  // cardboard is fully matte dielectric.
  _rackMatlib() {
    if (this._matlib) return this._matlib;
    const perf = this._perfTexture();
    const mesh = this._meshTexture();
    const carton = this._cartonTexture();
    // PBR note: rack frames/beams/panels are PAINTED steel — physically a
    // dielectric coat, so low metalness keeps their colour readable with or
    // without an environment map. Only BARE metal (galvanised decking/bracing,
    // machined rails, zinc rollers, the chrome hanging bar) is truly metallic, so
    // those are the parts Lane A's env map will make glint like real steel.
    const L = {
      upright: this._rackMat({
        color: RACK_UPRIGHT, roughness: 0.42, metalness: 0.18, map: perf,
        emissive: new THREE.Color(0x0d1420), emissiveIntensity: 0,
      }),
      brace: this._rackMat({ color: RACK_BRACE, roughness: 0.46, metalness: 0.18 }),
      foot: this._rackMat({ color: RACK_FOOT, roughness: 0.7, metalness: 0.3 }),
      beam: this._rackMat({
        color: RACK_BEAM, roughness: 0.4, metalness: 0.15,
        emissive: new THREE.Color(RACK_BEAM), emissiveIntensity: 0.05,
      }, true),
      deck: this._rackMat({ color: RACK_GALV, roughness: 0.42, metalness: 0.9, map: mesh }),
      panel: this._rackMat({ color: SHELF_PANEL, roughness: 0.5, metalness: 0.2 }),
      galv: this._rackMat({ color: RACK_GALV, roughness: 0.38, metalness: 0.9 }),
      steel: this._rackMat({ color: RACK_STEEL, roughness: 0.55, metalness: 0.25 }),
      rail: this._rackMat({ color: RAIL_STEEL, roughness: 0.25, metalness: 0.95 }),
      carriage: this._rackMat({ color: CARRIAGE_DARK, roughness: 0.5, metalness: 0.25 }),
      wood: this._rackMat({ color: PALLET_WOOD, roughness: 0.92, metalness: 0.0 }),
      roller: this._rackMat({ color: ROLLER_COLOR, roughness: 0.25, metalness: 0.92 }),
      // Cardboard: matte, textured, per-instance kraft tone via instanceColor
      // (base stays white so the corrugated map + tone carry the colour).
      carton: this._rackMat({
        color: 0xffffff, roughness: 0.96, metalness: 0.0, map: carton,
        emissive: new THREE.Color(0x0e0b08), emissiveIntensity: 0.05,
      }, true),
      // AS/RS structure: light galvanised tower frame (bare metal).
      asrs: this._rackMat({ color: ASRS_FRAME, roughness: 0.42, metalness: 0.85 }),
      // Plastic totes (flow / AS-RS bins): satin dielectric.
      tote: this._rackMat({
        color: 0xffffff, roughness: 0.42, metalness: 0.05,
        emissive: new THREE.Color(0x0a0e14), emissiveIntensity: 0.05,
      }, true),
      // ABC is expressed *materially*: a small printed label/tape flash on the
      // front of the load, not a neon slab.
      label: this._rackMat({ color: 0xffffff, roughness: 0.85, metalness: 0.0 }),
      cloth: this._rackMat({ color: 0xffffff, roughness: 0.95, metalness: 0.0 }),
    };
    this._matlib = L;
    return L;
  },

  // -- merged part geometry ---------------------------------------------------
  // Merge a list of {g, x,y,z, rx,ry,rz, sx,sy,sz} temp geometries into ONE
  // indexed BufferGeometry (position/normal/uv). Every input geometry is disposed
  // (they are always freshly-made temporaries). This is what turns "10 boxes per
  // bay" into ONE instanced draw call while keeping the same silhouette.
  _mergeParts(parts) {
    const pos = [], nor = [], uvs = [], idx = [];
    const m4 = new THREE.Matrix4();
    const nm = new THREE.Matrix3();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const t = new THREE.Vector3();
    const s = new THREE.Vector3();
    let off = 0;
    for (const p of parts) {
      const g = p.g;
      if (!g || !g.attributes || !g.attributes.position) continue;
      e.set(p.rx || 0, p.ry || 0, p.rz || 0);
      q.setFromEuler(e);
      t.set(p.x || 0, p.y || 0, p.z || 0);
      s.set(p.sx === undefined ? 1 : p.sx, p.sy === undefined ? 1 : p.sy,
        p.sz === undefined ? 1 : p.sz);
      m4.compose(t, q, s);
      nm.getNormalMatrix(m4);
      const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(m4);
        pos.push(v.x, v.y, v.z);
        if (N) { v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); nor.push(v.x, v.y, v.z); }
        else nor.push(0, 1, 0);
        if (U) uvs.push(U.getX(i), U.getY(i)); else uvs.push(0, 0);
      }
      const I = g.index;
      if (I) { for (let i = 0; i < I.count; i++) idx.push(I.getX(i) + off); }
      else { for (let i = 0; i < P.count; i++) idx.push(i + off); }
      off += P.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    out.setIndex(idx);
    out.computeBoundingSphere();
    this._geometries.push(out);
    return out;
  },

  // Push an InstancedMesh from a piece geometry + material, filling per-bay
  // transforms via the supplied callback `place(i, bay) -> {pos, quat, scale}`
  // returning scratch objects. `perBay` instances per bay. Optional `tintAbc`
  // colours each instance by its bay's ABC class (instanceColor). Returns the
  // mesh. Keeps draw calls = (#piece-types × #rack-types).
  //
  // The v0.3.0 builders place merged bay geometry via _instanceBay/_instanceList
  // instead, but this callback form (and the _scratch/_bayLocal/_bayLocalTilt
  // trio below) is kept working, unchanged, as the module's original helper API.
  _instancePieces(geom, mat, bays, perBay, place, tintAbc) {
    const n = bays.length * perBay;
    if (n === 0) return null;
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
  },

  // Whether a rack piece should be rendered into the SHADOW MAP. The shadow pass
  // re-rasterises every caster at the full shadow-map resolution regardless of
  // canvas size, so it is the single biggest cost at scale. LOD rule:
  //   tier 0  — everything except explicitly thin detail casts
  //   tier 1  — structure casts, LOAD (cartons/pallets/totes/garments) does not
  //   tier 2  — nothing storage-side casts; the floor keeps agent contact shadows
  _castsShadow(o) {
    if (o.noShadow) return false;
    if (this._rackLod >= 2) return false;
    if (o.load && this._rackLod >= 1) return false;
    return true;
  },

  // One instance of a merged BAY geometry per bay, at the bay centre with the
  // bay's yaw. `opt.fine` registers it with the distance LOD rule; `opt.noShadow`
  // keeps thin detail out of the shadow pass (real cost saver at scale).
  _instanceBay(geom, mat, bays, opt) {
    const o = opt || {};
    const inst = new THREE.InstancedMesh(geom, mat, bays.length);
    inst.castShadow = this._castsShadow(o);
    inst.receiveShadow = !o.noShadow;
    const m4 = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < bays.length; i++) {
      const b = bays[i];
      e.set(0, b.yaw, 0); q.setFromEuler(e);
      p.set(b.x, o.y || 0, b.z);
      m4.compose(p, q, s);
      inst.setMatrixAt(i, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
    this.scene.add(inst);
    if (o.fine) this._rackDetail.push(inst);
    return inst;
  },

  // One instance per entry of an explicit world-space list
  // ({x,y,z,yaw,sx,sy,sz,[color]}), used for LOAD pieces whose count/size/tone
  // varies per slot. Per-instance colour rides instanceColor (one draw call).
  _instanceList(geom, mat, list, opt) {
    if (!list.length) return null;
    const o = opt || {};
    const inst = new THREE.InstancedMesh(geom, mat, list.length);
    inst.castShadow = this._castsShadow(o);
    inst.receiveShadow = !o.noShadow;
    const m4 = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const col = new THREE.Color();
    let tinted = false;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      e.set(t.rx || 0, t.yaw || 0, 0, 'YXZ'); q.setFromEuler(e);
      p.set(t.x, t.y, t.z);
      s.set(t.sx, t.sy, t.sz);
      m4.compose(p, q, s);
      inst.setMatrixAt(i, m4);
      if (t.color !== undefined) { col.setHex(t.color); inst.setColorAt(i, col); tinted = true; }
    }
    inst.instanceMatrix.needsUpdate = true;
    if (tinted && inst.instanceColor) inst.instanceColor.needsUpdate = true;
    this.scene.add(inst);
    if (o.fine) this._rackDetail.push(inst);
    return inst;
  },

  // Shared scratch for placement callbacks (no per-instance allocation).
  _scratch() {
    if (!this._sc) {
      this._sc = {
        pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1), euler: new THREE.Euler(),
      };
    }
    return this._sc;
  },

  // -- LOAD (cartons / totes / pallets / ABC labels) --------------------------
  // How full one storage position reads: 0 = genuinely empty (the model says the
  // slot has no SKU / no stock), else 0.55..1.0 of the usable slot height. Driven
  // by the authored cell (SKU + qty); when the model has no quantities a small
  // deterministic scatter keeps a wall of racks from looking implausibly 100% full.
  _slotFill(bay, lvl) {
    if (!bay.occupied) return 0;
    if (_rnd(bay.bi, lvl * 7 + 3) > bay.fill) return 0;
    return 0.55 + 0.45 * _rnd(bay.bi, lvl * 13 + 91);
  },

  // Append one slot's carton stack (world space) to `out`. Cartons vary in size,
  // yaw and kraft tone per slot so no two positions look stamped. LOD tiers cut
  // the count: 3–5 (fine) → 2 (mid) → 1 merged block (coarse). `labels` gets an
  // ABC-coloured printed label on the front carton (fine/mid only).
  _pushCartons(out, labels, bay, lvl, y0, slotH, w, d) {
    const fill = this._slotFill(bay, lvl);
    if (fill <= 0) return;              // EMPTY position — nothing is drawn
    const lod = this._rackLod;
    const H = Math.max(0.12, slotH * fill);
    const xy = [0, 0];
    if (lod >= 2) {
      // Coarse: one merged block per slot (silhouette only).
      _worldXZ(bay, 0, 0, xy);
      out.push({
        x: xy[0], y: y0 + H / 2, z: xy[1], yaw: bay.yaw,
        sx: w * 0.9, sy: H, sz: d * 0.86,
        color: CARTON_TONES[bay.bi % CARTON_TONES.length],
      });
      return;
    }
    const n = lod === 0 ? 2 + Math.floor(_rnd(bay.bi, lvl) * 3) : 2;  // 2..4 / 2
    const cw = (w * 0.94) / n;
    for (let i = 0; i < n; i++) {
      const r1 = _rnd(bay.bi * 3 + i, lvl * 5 + 1);
      const r2 = _rnd(bay.bi * 5 + i, lvl * 11 + 2);
      const h = H * (0.72 + 0.28 * r1);
      const cd = d * (0.72 + 0.2 * r2);
      const dx = (i + 0.5) * cw - (w * 0.94) / 2;
      const jitter = lod === 0 ? (r2 - 0.5) * 0.12 : 0;
      _worldXZ(bay, dx, (r1 - 0.5) * d * 0.06, xy);
      out.push({
        x: xy[0], y: y0 + h / 2, z: xy[1], yaw: bay.yaw + jitter,
        sx: cw * 0.92, sy: h, sz: cd,
        color: CARTON_TONES[(bay.bi + i + lvl) % CARTON_TONES.length],
      });
      // One printed ABC label on the front-most carton of the slot.
      if (labels && i === 0) {
        _worldXZ(bay, dx, d * 0.5 * (0.72 + 0.2 * r2) + 0.004, xy);
        labels.push({
          x: xy[0], y: y0 + h * 0.62, z: xy[1], yaw: bay.yaw + jitter,
          sx: Math.min(0.22, cw * 0.5), sy: Math.min(0.12, h * 0.28), sz: 0.008,
          color: ABC_COLOR[bay.abc] || ABC_COLOR.C,
        });
      }
    }
  },

  // A real EUR-style pallet: top deck boards, three stringers/blocks, bottom
  // boards. LOD trims it to 5 then 2 parts. Returns a merged geometry centred on
  // the pallet footprint with its base at y = 0 (total height ~0.145 m).
  _palletGeom(w, d) {
    const lod = this._rackLod;
    const parts = [];
    const B = (sx, sy, sz, x, y, z) => ({ g: new THREE.BoxGeometry(sx, sy, sz), x, y, z });
    if (lod >= 2) {
      parts.push(B(w, 0.045, d, 0, 0.12, 0), B(w, 0.05, d * 0.9, 0, 0.03, 0));
      return this._mergeParts(parts);
    }
    // Blocks / stringers (3, running along the depth axis).
    for (const bx of [-w / 2 + 0.09, 0, w / 2 - 0.09]) {
      parts.push(B(0.14, 0.09, d, bx, 0.065, 0));
    }
    // Top deck boards.
    const nTop = lod === 0 ? 5 : 3;
    for (let i = 0; i < nTop; i++) {
      const z = -d / 2 + (i + 0.5) * (d / nTop);
      parts.push(B(w, 0.021, (d / nTop) * 0.82, 0, 0.121, z));
    }
    // Bottom boards (fine only).
    if (lod === 0) {
      for (const z of [-d / 2 + 0.08, 0, d / 2 - 0.08]) {
        parts.push(B(w, 0.019, 0.13, 0, 0.0095, z));
      }
    }
    return this._mergeParts(parts);
  },

  // -- パレットラック (pallet rack) ------------------------------------------
  // Real anatomy: perforated painted UPRIGHTS on footplates, welded diagonal +
  // horizontal BRACING between the front/back post of each frame, ORANGE box-
  // section LOAD BEAMS at every level, galvanised WIRE MESH DECKING, and a real
  // stringer pallet carrying a varied carton stack in each position.
  _buildPalletRack(bays, bw) {
    const L = this._rackMatlib();
    const dims = RACK_DIMS.pallet;
    const H = dims.h, levels = dims.levels, d = dims.depth;
    const lvH = H / levels;
    const lod = this._rackLod;
    const B = (sx, sy, sz, x, y, z, rx) => ({ g: new THREE.BoxGeometry(sx, sy, sz), x, y, z, rx });
    const px = bw / 2 - 0.055, pz = d / 2 - 0.06;

    // Frame: 4 perforated uprights (+ dark anchor footplates at tier 0).
    const frame = [], feet = [];
    for (const sx of [-px, px]) {
      for (const sz of [-pz, pz]) {
        frame.push(B(0.095, H, 0.075, sx, H / 2, sz));
        if (lod === 0) feet.push(B(0.24, 0.028, 0.19, sx, 0.014, sz));
      }
    }
    this._instanceBay(this._mergeParts(frame), L.upright, bays, { });
    if (feet.length) this._instanceBay(this._mergeParts(feet), L.foot, bays, { fine: true });

    // Bracing (its own galvanised material): per frame side a horizontal tie at
    // each level plus alternating diagonals — the giveaway that this is racking.
    if (lod < 2) {
      const span = d - 0.12;
      const brace = [];
      for (const sx of [-px, px]) {
        for (let l = 0; l < levels; l++) {
          const y = lvH * l + lvH * 0.5;
          brace.push(B(0.05, 0.05, span, sx, y, 0));
          const dl = Math.hypot(span, lvH);
          const ang = Math.atan2(span, lvH) * ((l % 2) ? 1 : -1);
          brace.push(B(0.045, dl, 0.045, sx, y, 0, ang));
        }
        brace.push(B(0.05, 0.05, span, sx, H - 0.12, 0));
      }
      this._instanceBay(this._mergeParts(brace), L.brace, bays, { fine: true, noShadow: true });
    }

    // Load beams: a stepped box section (web + top lip) front & back per level.
    // The lip is what makes a beam read as a real step-beam profile; at the
    // coarse tier the plain web alone carries the silhouette for half the tris.
    const beams = [];
    for (let l = 1; l < levels; l++) {
      const y = lvH * l;
      for (const sz of [-pz, pz]) {
        beams.push(B(bw, 0.115, 0.05, 0, y + 0.058, sz));
        if (lod < 2) beams.push(B(bw, 0.022, 0.095, 0, y + 0.126, sz));
      }
    }
    this._instanceBay(this._mergeParts(beams), L.beam, bays, { });

    // Wire mesh decking on every beam level.
    if (lod < 2) {
      const deck = [];
      for (let l = 1; l < levels; l++) {
        deck.push(B(bw - 0.05, 0.022, d - 0.14, 0, lvH * l + 0.15, 0));
      }
      this._instanceBay(this._mergeParts(deck), L.deck, bays, { fine: true, noShadow: true });
    }

    // Pallets + cartons per level (level 0 sits on the floor).
    const palW = Math.min(bw * 0.92, 1.15), palD = Math.min(d * 0.92, 1.2);
    const palG = this._palletGeom(palW, palD);
    const pallets = [], cartons = [], labels = [];
    const xy = [0, 0];
    for (const bay of bays) {
      for (let l = 0; l < levels; l++) {
        if (this._slotFill(bay, l) <= 0) continue;   // empty position: no pallet
        const base = l === 0 ? 0.0 : lvH * l + 0.16;
        _worldXZ(bay, 0, 0, xy);
        pallets.push({ x: xy[0], y: base, z: xy[1], yaw: bay.yaw, sx: 1, sy: 1, sz: 1 });
        this._pushCartons(cartons, lod < 2 ? labels : null, bay, l,
          base + 0.145, lvH * 0.66, palW * 0.96, palD * 0.94);
      }
    }
    this._instanceList(palG, L.wood, pallets, { load: true });
    this._instanceList(this._unitBox(), L.carton, cartons, { load: true });
    this._instanceList(this._unitBox(), L.label, labels, { fine: true, noShadow: true });
  },

  // -- 軽量棚 / 中量棚 (light / medium shelving) ------------------------------
  // Thin angle POSTS on footplates, an X-brace across the back, painted steel
  // SHELF PANELS with a front lip at every tier, and small varied carton/tote
  // stacks on the panels. 2.0–2.4 m tall.
  _buildShelving(bays, rt, bw) {
    const L = this._rackMatlib();
    const dims = rackDims(rt);
    const H = dims.h, tiers = dims.levels, d = dims.depth;
    const tierH = H / tiers;
    const lod = this._rackLod;
    const B = (sx, sy, sz, x, y, z, rz, rx) =>
      ({ g: new THREE.BoxGeometry(sx, sy, sz), x, y, z, rz, rx });
    const px = bw / 2 - 0.03, pz = d / 2 - 0.03;

    // Posts + feet.
    const frame = [];
    for (const sx of [-px, px]) {
      for (const sz of [-pz, pz]) {
        frame.push(B(0.05, H, 0.05, sx, H / 2, sz));
        if (lod === 0) frame.push(B(0.13, 0.02, 0.11, sx, 0.01, sz));
      }
    }
    this._instanceBay(this._mergeParts(frame), L.panel, bays, {});

    // Back X-bracing + end diagonals — reads instantly as light-duty shelving.
    if (lod < 2) {
      const brace = [];
      const wSpan = bw - 0.06, dl = Math.hypot(wSpan, H - 0.1);
      const a = Math.atan2(wSpan, H - 0.1);
      brace.push(B(0.028, dl, 0.028, 0, H / 2, -pz, a));
      brace.push(B(0.028, dl, 0.028, 0, H / 2, -pz, -a));
      if (lod === 0) {
        const dSpan = d - 0.06, dl2 = Math.hypot(dSpan, H - 0.1);
        const a2 = Math.atan2(dSpan, H - 0.1);
        brace.push(B(0.024, dl2, 0.024, -px, H / 2, 0, 0, a2));
        brace.push(B(0.024, dl2, 0.024, px, H / 2, 0, 0, -a2));
      }
      this._instanceBay(this._mergeParts(brace), L.galv, bays, { fine: true, noShadow: true });
    }

    // Shelf panels (one per tier + a top cap) with a folded front lip.
    const shelves = [];
    for (let t = 0; t < tiers; t++) {
      const y = tierH * t;
      shelves.push(B(bw - 0.02, 0.024, d - 0.02, 0, y + 0.012, 0));
      if (lod === 0) shelves.push(B(bw - 0.02, 0.035, 0.016, 0, y + 0.03, d / 2 - 0.02));
    }
    // Top cap panel: pure silhouette polish, only worth it at the fine tier.
    if (lod === 0) shelves.push(B(bw - 0.02, 0.024, d - 0.02, 0, H - 0.012, 0));
    this._instanceBay(this._mergeParts(shelves), L.panel, bays, {});

    // Cartons on each tier.
    const cartons = [], labels = [];
    for (const bay of bays) {
      for (let t = 0; t < tiers; t++) {
        this._pushCartons(cartons, lod < 2 ? labels : null, bay, t,
          tierH * t + 0.026, tierH * 0.74, bw - 0.09, d - 0.08);
      }
    }
    this._instanceList(this._unitBox(), L.carton, cartons, { load: true });
    this._instanceList(this._unitBox(), L.label, labels, { fine: true, noShadow: true });
  },

  // -- フローラック (flow rack) ----------------------------------------------
  // Inclined gravity lanes: a steel frame, per-lane side rails carrying a row of
  // real ROLLERS on a visible incline toward the pick face, an end stop, and
  // cartons queued at the low (pick) end so the FIFO story reads at a glance.
  _buildFlowRack(bays, bw) {
    const L = this._rackMatlib();
    const dims = RACK_DIMS.flow;
    const H = dims.h, lanes = dims.levels, d = dims.depth;
    const laneH = H / lanes;
    const lod = this._rackLod;
    const tilt = 0.16;  // rad: forward incline toward the pick face (+Z)
    const B = (sx, sy, sz, x, y, z, rx) => ({ g: new THREE.BoxGeometry(sx, sy, sz), x, y, z, rx });
    const px = bw / 2 - 0.04, pz = d / 2 - 0.05;

    // Frame: 4 posts + feet + rear tie.
    const frame = [];
    for (const sx of [-px, px]) {
      for (const sz of [-pz, pz]) {
        frame.push(B(0.06, H, 0.06, sx, H / 2, sz));
        if (lod < 2) frame.push(B(0.16, 0.022, 0.14, sx, 0.011, sz));
      }
      frame.push(B(0.04, 0.04, d - 0.1, sx, H - 0.06, 0));
    }
    this._instanceBay(this._mergeParts(frame), L.upright, bays, {});

    // Lanes: side rails + rollers + end stop, all tilted about local X.
    const laneParts = [];
    const rollN = lod === 0 ? 8 : (lod === 1 ? 5 : 0);
    const span = d - 0.1;
    for (let l = 0; l < lanes; l++) {
      const y = laneH * (l + 0.42);
      for (const sx of [-px + 0.02, px - 0.02]) {
        laneParts.push(B(0.035, 0.075, span, sx, y, 0, tilt));
      }
      if (rollN > 0) {
        for (let r = 0; r < rollN; r++) {
          const t = (r + 0.5) / rollN - 0.5;
          const zc = t * span;             // position along the lane (local Z)
          const g = new THREE.CylinderGeometry(0.026, 0.026, bw - 0.11, 8, 1);
          // Roller axis lies across the lane (local X) → spin the cylinder 90°
          // about Z; its HEIGHT follows the lane's incline so the bed is planar.
          laneParts.push({
            g, x: 0, y: y + 0.045 - zc * Math.tan(tilt), z: zc,
            rx: 0, ry: 0, rz: Math.PI / 2,
          });
        }
      } else {
        // Coarse tier: a single ribbed bed (mesh texture) instead of rollers.
        laneParts.push(B(bw - 0.1, 0.03, span, 0, y + 0.05, 0, tilt));
      }
      // End stop at the low (pick) end.
      laneParts.push(B(bw - 0.1, 0.09, 0.022, 0, y + 0.06 - (span / 2) * Math.tan(tilt),
        span / 2, tilt));
    }
    this._instanceBay(this._mergeParts(laneParts), rollN > 0 ? L.roller : L.deck,
      bays, { noShadow: lod > 0 });

    // Cartons queued down each lane (denser toward the pick face).
    const cartons = [], labels = [];
    const xy = [0, 0];
    for (const bay of bays) {
      for (let l = 0; l < lanes; l++) {
        const fill = this._slotFill(bay, l);
        if (fill <= 0) continue;
        const n = lod === 0 ? 3 : (lod === 1 ? 2 : 1);
        const y = laneH * (l + 0.42) + 0.09;
        for (let i = 0; i < n; i++) {
          const cz = span / 2 - 0.18 - i * (d * 0.24);
          const ch = Math.min(laneH * 0.55, 0.34) * (0.85 + 0.15 * _rnd(bay.bi + i, l));
          _worldXZ(bay, 0, cz, xy);
          cartons.push({
            x: xy[0], y: y - cz * Math.tan(tilt) + ch / 2, z: xy[1],
            yaw: bay.yaw, rx: tilt,
            sx: bw - 0.16, sy: ch, sz: d * 0.2,
            color: CARTON_TONES[(bay.bi + i + l) % CARTON_TONES.length],
          });
          if (labels && i === 0 && lod < 2) {
            _worldXZ(bay, 0, cz + d * 0.1 + 0.004, xy);
            labels.push({
              x: xy[0], y: y - cz * Math.tan(tilt) + ch * 0.6, z: xy[1],
              yaw: bay.yaw, rx: tilt, sx: 0.2, sy: 0.1, sz: 0.008,
              color: ABC_COLOR[bay.abc] || ABC_COLOR.C,
            });
          }
        }
      }
    }
    this._instanceList(this._unitBox(), L.carton, cartons, { load: true });
    this._instanceList(this._unitBox(), L.label, labels, { fine: true, noShadow: true });
  },

  // -- ネステナー (nestainer) -------------------------------------------------
  // Portable NESTING frames stacked on top of each other: a runner base, four
  // slightly inward-leaning corner posts (that is what lets an empty one nest),
  // and a welded top perimeter — carrying a pallet load per stack.
  _buildNestainer(bays, bw) {
    const L = this._rackMatlib();
    const dims = RACK_DIMS.nestainer;
    const H = dims.h, stacks = dims.levels, d = dims.depth;
    const stackH = H / stacks;
    const lod = this._rackLod;
    const B = (sx, sy, sz, x, y, z, rz, rx) =>
      ({ g: new THREE.BoxGeometry(sx, sy, sz), x, y, z, rz, rx });
    const px = bw / 2 - 0.06, pz = d / 2 - 0.07;

    const parts = [];
    for (let s = 0; s < stacks; s++) {
      const y0 = stackH * s;
      // Runner base (2 skids + a cross tie) — the fork entry.
      for (const sx of [-px, px]) parts.push(B(0.11, 0.09, d, sx, y0 + 0.045, 0));
      parts.push(B(bw - 0.06, 0.05, 0.11, 0, y0 + 0.115, 0));
      // Four corner posts, leaning in slightly (the nesting taper).
      for (const sx of [-px, px]) {
        for (const sz of [-pz, pz]) {
          parts.push(B(0.062, stackH - 0.14, 0.062, sx, y0 + stackH / 2,
            sz, (sx > 0 ? 1 : -1) * 0.035, 0));
        }
      }
      // Top perimeter frame.
      for (const sz of [-pz, pz]) parts.push(B(bw - 0.05, 0.055, 0.055, 0, y0 + stackH - 0.05, sz));
      if (lod < 2) {
        for (const sx of [-px, px]) parts.push(B(0.055, 0.055, d - 0.06, sx, y0 + stackH - 0.05, 0));
      }
    }
    this._instanceBay(this._mergeParts(parts), L.steel, bays, {});

    // Pallet + carton load inside each stack.
    const palW = Math.min(bw * 0.86, 1.1), palD = Math.min(d * 0.8, 1.15);
    const palG = this._palletGeom(palW, palD);
    const pallets = [], cartons = [], labels = [];
    const xy = [0, 0];
    for (const bay of bays) {
      for (let s = 0; s < stacks; s++) {
        if (this._slotFill(bay, s) <= 0) continue;
        const base = stackH * s + 0.14;
        _worldXZ(bay, 0, 0, xy);
        pallets.push({ x: xy[0], y: base, z: xy[1], yaw: bay.yaw, sx: 1, sy: 1, sz: 1 });
        this._pushCartons(cartons, lod < 2 ? labels : null, bay, s,
          base + 0.145, stackH * 0.6, palW * 0.96, palD * 0.94);
      }
    }
    this._instanceList(palG, L.wood, pallets, { load: true });
    this._instanceList(this._unitBox(), L.carton, cartons, { load: true });
    this._instanceList(this._unitBox(), L.label, labels, { fine: true, noShadow: true });
  },

  // -- ハンガーラック (hanger rack) -------------------------------------------
  // Apparel 吊るし保管: two end posts on feet, a round chrome HANGING BAR, and a
  // row of garments on hangers at varied drops/tones (never neon — muted retail
  // colours; ABC rides a small tag).
  _buildHangerRack(bays, bw) {
    const L = this._rackMatlib();
    const dims = RACK_DIMS.hanger;
    const H = dims.h, d = dims.depth;
    const lod = this._rackLod;
    const B = (sx, sy, sz, x, y, z) => ({ g: new THREE.BoxGeometry(sx, sy, sz), x, y, z });
    const px = bw / 2 - 0.05;

    const parts = [];
    for (const sx of [-px, px]) {
      parts.push(B(0.055, H, 0.055, sx, H / 2, 0));
      parts.push(B(0.09, 0.05, d, sx, 0.025, 0));                 // foot
      if (lod < 2) parts.push(B(0.05, 0.05, d * 0.7, sx, H * 0.5, 0));  // mid tie
    }
    // Round hanging bar across the bay.
    parts.push({
      g: new THREE.CylinderGeometry(0.022, 0.022, bw - 0.06, 10, 1),
      x: 0, y: H * 0.92, z: 0, rz: Math.PI / 2,
    });
    this._instanceBay(this._mergeParts(parts), L.galv, bays, {});

    // Garments: tapered slabs at staggered drops + a hook wire (fine only).
    const n = lod === 0 ? 12 : (lod === 1 ? 8 : 4);
    const garments = [], hooks = [], labels = [];
    const xy = [0, 0];
    for (const bay of bays) {
      if (this._slotFill(bay, 0) <= 0) continue;
      for (let i = 0; i < n; i++) {
        const r = _rnd(bay.bi, i);
        const dx = ((i + 0.5) / n - 0.5) * (bw - 0.14);
        const drop = H * (0.52 + 0.1 * r);
        _worldXZ(bay, dx, 0, xy);
        garments.push({
          x: xy[0], y: H * 0.9 - drop / 2, z: xy[1], yaw: bay.yaw + (r - 0.5) * 0.25,
          sx: (bw - 0.14) / n * (0.7 + 0.3 * r), sy: drop, sz: d * (0.3 + 0.15 * r),
          color: GARMENT_TONES[(bay.bi + i) % GARMENT_TONES.length],
        });
        if (lod === 0) {
          hooks.push({
            x: xy[0], y: H * 0.915, z: xy[1], yaw: bay.yaw,
            sx: 0.012, sy: 0.06, sz: 0.012,
          });
        }
        if (i === 0 && lod < 2) {
          _worldXZ(bay, dx, d * 0.2, xy);
          labels.push({
            x: xy[0], y: H * 0.9 - drop * 0.2, z: xy[1], yaw: bay.yaw,
            sx: 0.07, sy: 0.05, sz: 0.006,
            color: ABC_COLOR[bay.abc] || ABC_COLOR.C,
          });
        }
      }
    }
    this._instanceList(this._unitBox(), L.cloth, garments, { load: true });
    this._instanceList(this._unitBox(), L.galv, hooks, { fine: true, noShadow: true });
    this._instanceList(this._unitBox(), L.label, labels, { fine: true, noShadow: true });
  },

  // -- メザニン (mezzanine) ---------------------------------------------------
  // A raised DECK PLATFORM: columns on baseplates, a checker-plate deck with an
  // edge beam, a proper HANDRAIL (top + mid rail on stanchions + a toe board) on
  // the aisle side, goods on both levels — plus ONE real STAIR FLIGHT per run.
  _buildMezzanine(bays, bw) {
    const L = this._rackMatlib();
    const dims = RACK_DIMS.mezzanine;
    const H = dims.h, d = dims.depth;
    const deckY = H * 0.52;
    const lod = this._rackLod;
    const B = (sx, sy, sz, x, y, z, rx) => ({ g: new THREE.BoxGeometry(sx, sy, sz), x, y, z, rx });
    const px = bw / 2 - 0.12, pz = d / 2 - 0.12;

    const struct = [];
    for (const sx of [-px, px]) {
      for (const sz of [-pz, pz]) {
        struct.push(B(0.14, deckY, 0.14, sx, deckY / 2, sz));
        struct.push(B(0.3, 0.03, 0.3, sx, 0.015, sz));           // baseplate
      }
      struct.push(B(0.1, 0.24, d - 0.2, sx, deckY - 0.14, 0));   // main beam
    }
    struct.push(B(bw, 0.09, d, 0, deckY + 0.045, 0));            // deck plate
    struct.push(B(bw, 0.2, 0.07, 0, deckY - 0.02, d / 2 - 0.03));// fascia
    this._instanceBay(this._mergeParts(struct), L.steel, bays, {});

    // Handrail on the pick face (+Z): stanchions + top/mid rail + toe board.
    if (lod < 2) {
      const rail = [];
      const ry = deckY + 0.09;
      rail.push(B(bw, 0.045, 0.045, 0, ry + 1.05, d / 2 - 0.06));
      rail.push(B(bw, 0.035, 0.035, 0, ry + 0.55, d / 2 - 0.06));
      rail.push(B(bw, 0.12, 0.02, 0, ry + 0.06, d / 2 - 0.06));   // toe board
      for (const sx of [-px, 0, px]) rail.push(B(0.045, 1.07, 0.045, sx, ry + 0.53, d / 2 - 0.06));
      this._instanceBay(this._mergeParts(rail), L.galv, bays, { fine: true, noShadow: true });
    }

    // One stair flight at the head of the run (not per bay — a real building has
    // one). Built as a merged group + single mesh, so it costs a single call.
    if (bays.length) {
      const a = bays[0];
      const steps = [];
      const nStep = Math.max(6, Math.round(deckY / 0.19));
      const rise = deckY / nStep, run = 0.26;
      for (let i = 0; i < nStep; i++) {
        steps.push(B(1.0, 0.035, run, 0, rise * (i + 1), -run * (i + 0.5)));
        steps.push(B(1.0, rise * 0.75, 0.02, 0, rise * (i + 0.6), -run * i - 0.01));
      }
      const runLen = run * nStep;
      const strAng = Math.atan2(deckY, runLen);
      for (const sx of [-0.52, 0.52]) {
        steps.push(B(0.04, 0.26, Math.hypot(deckY, runLen), sx, deckY / 2, -runLen / 2, strAng));
        steps.push(B(0.035, 0.035, Math.hypot(deckY, runLen), sx, deckY / 2 + 1.0, -runLen / 2, strAng));
        for (let i = 0; i < 3; i++) {
          const f = (i + 0.5) / 3;
          steps.push(B(0.035, 1.0, 0.035, sx, deckY * f + 0.5, -runLen * (1 - f)));
        }
      }
      const g = this._mergeParts(steps);
      const stair = new THREE.Mesh(g, L.galv);
      const xy = _worldXZ(a, -(bw / 2 + 0.6), d / 2, [0, 0]);
      stair.position.set(xy[0], 0, xy[1]);
      stair.rotation.y = a.yaw;
      stair.castShadow = true; stair.receiveShadow = true;
      this.scene.add(stair);
    }

    // Goods on the floor level and on the deck.
    const palW = Math.min(bw * 0.44, 1.15), palD = Math.min(d * 0.5, 1.2);
    const palG = this._palletGeom(palW, palD);
    const pallets = [], cartons = [], labels = [];
    const xy = [0, 0];
    for (const bay of bays) {
      for (let l = 0; l < 2; l++) {
        if (this._slotFill(bay, l) <= 0) continue;
        const base = l ? deckY + 0.09 : 0;
        for (const dx of [-bw * 0.24, bw * 0.24]) {
          _worldXZ(bay, dx, 0, xy);
          pallets.push({ x: xy[0], y: base, z: xy[1], yaw: bay.yaw, sx: 1, sy: 1, sz: 1 });
        }
        this._pushCartons(cartons, lod < 2 ? labels : null, bay, l,
          base + 0.145, Math.min(1.1, (deckY - 0.3)), bw * 0.88, palD);
      }
    }
    this._instanceList(palG, L.wood, pallets, { load: true });
    this._instanceList(this._unitBox(), L.carton, cartons, { load: true });
    this._instanceList(this._unitBox(), L.label, labels, { fine: true, noShadow: true });
  },

  // -- 移動ラック (mobile rack) -----------------------------------------------
  // Shelving riding a powered CARRIAGE on floor RAILS: twin rails running cross-
  // aisle, a dark carriage chassis with visible wheel bogies and a hand-crank
  // wheel on the end face, then the shelving body lifted onto it.
  _buildMobileRack(bays, bw) {
    const L = this._rackMatlib();
    const dims = RACK_DIMS.mobile;
    const H = dims.h, tiers = dims.levels, d = dims.depth;
    const carH = 0.22;
    const bodyH = H - carH;
    const tierH = bodyH / tiers;
    const lod = this._rackLod;
    const B = (sx, sy, sz, x, y, z, rz) => ({ g: new THREE.BoxGeometry(sx, sy, sz), x, y, z, rz });
    const px = bw / 2 - 0.03, pz = d / 2 - 0.03;

    // Floor rails, extended well past the unit so the travel path reads.
    const rails = [];
    for (const sx of [-bw * 0.3, bw * 0.3]) rails.push(B(0.07, 0.045, d * 3.0, sx, 0.022, 0));
    this._instanceBay(this._mergeParts(rails), L.rail, bays, { noShadow: true });

    // Carriage chassis + wheel bogies + hand wheel.
    const car = [];
    car.push(B(bw, carH * 0.7, d + 0.06, 0, carH * 0.62, 0));
    for (const sx of [-bw * 0.3, bw * 0.3]) {
      for (const sz of [-pz + 0.05, pz - 0.05]) {
        car.push({
          g: new THREE.CylinderGeometry(0.075, 0.075, 0.05, 10, 1),
          x: sx, y: 0.075, z: sz, rz: Math.PI / 2,
        });
      }
    }
    if (lod < 2) {
      car.push({
        g: new THREE.CylinderGeometry(0.16, 0.16, 0.035, 14, 1),
        x: bw / 2 + 0.05, y: carH + 0.5, z: 0, rz: Math.PI / 2,
      });
      car.push(B(0.05, 0.05, 0.05, bw / 2 + 0.05, carH + 0.5, 0));
    }
    this._instanceBay(this._mergeParts(car), L.carriage, bays, {});

    // Shelving body on the carriage: posts + panels.
    const body = [];
    for (const sx of [-px, px]) {
      for (const sz of [-pz, pz]) body.push(B(0.05, bodyH, 0.05, sx, carH + bodyH / 2, sz));
    }
    for (let t = 0; t < tiers; t++) {
      body.push(B(bw - 0.02, 0.022, d - 0.02, 0, carH + tierH * t + 0.011, 0));
    }
    body.push(B(bw - 0.02, 0.022, d - 0.02, 0, H - 0.011, 0));
    this._instanceBay(this._mergeParts(body), L.panel, bays, {});

    const cartons = [], labels = [];
    for (const bay of bays) {
      for (let t = 0; t < tiers; t++) {
        this._pushCartons(cartons, lod < 2 ? labels : null, bay, t,
          carH + tierH * t + 0.024, tierH * 0.74, bw - 0.09, d - 0.08);
      }
    }
    this._instanceList(this._unitBox(), L.carton, cartons, { load: true });
    this._instanceList(this._unitBox(), L.label, labels, { fine: true, noShadow: true });
  },

  // -- 自動倉庫 AS/RS ---------------------------------------------------------
  // A tall, DENSE structure: slim uprights with a cross tie + tote support arms
  // at every one of its 12 levels (~16 m — it vanishes into the fog), filled with
  // plastic bins, plus a real stacker CRANE on a floor rail in the aisle.
  _buildAsrsRack(bays, bw) {
    const L = this._rackMatlib();
    const dims = RACK_DIMS.asrs;
    const H = dims.h, levels = dims.levels, d = dims.depth;
    const lvH = H / levels;
    const lod = this._rackLod;
    const B = (sx, sy, sz, x, y, z) => ({ g: new THREE.BoxGeometry(sx, sy, sz), x, y, z });
    const px = bw / 2 - 0.04, pz = d / 2 - 0.05;

    const parts = [];
    for (const sx of [-px, px]) {
      for (const sz of [-pz, pz]) parts.push(B(0.07, H, 0.07, sx, H / 2, sz));
    }
    const step = lod >= 2 ? 3 : 1;   // coarse tier ties every 3rd level only
    for (let l = 0; l < levels; l += step) {
      const y = lvH * l;
      for (const sz of [-pz, pz]) parts.push(B(bw - 0.02, 0.04, 0.04, 0, y, sz));
      for (const sx of [-px, px]) parts.push(B(0.035, 0.028, d - 0.08, sx, y + 0.02, 0));
    }
    this._instanceBay(this._mergeParts(parts), L.asrs, bays, {});

    // Plastic totes with a moulded rim, tinted per bin.
    const toteG = this._mergeParts([
      { g: new THREE.BoxGeometry(1, 1, 1), x: 0, y: 0.5, z: 0 },
      { g: new THREE.BoxGeometry(1.06, 0.1, 1.06), x: 0, y: 0.96, z: 0 },
    ]);
    const totes = [];
    const xy = [0, 0];
    for (const bay of bays) {
      for (let l = 0; l < levels; l++) {
        if (this._slotFill(bay, l) <= 0) continue;
        _worldXZ(bay, 0, 0, xy);
        totes.push({
          x: xy[0], y: lvH * l + 0.05, z: xy[1], yaw: bay.yaw,
          sx: bw - 0.14, sy: Math.min(lvH * 0.72, 0.9), sz: d - 0.18,
          color: TOTE_TONES[(bay.bi + l) % TOTE_TONES.length],
        });
      }
    }
    this._instanceList(toteG, L.tote, totes, { load: true });

    // A single hi-vis stacker crane that patrols the front of the AS/RS bays.
    this._buildAsrsCrane(bays, H, d);
  },

  // The stacker crane: twin masts on a bottom carriage riding a floor RAIL, a top
  // guide rail, and a lift carriage with telescoping forks. The rails are static
  // (they span the aisle); the crane group patrols along them (see _updateAsrs).
  _buildAsrsCrane(bays, H, depth) {
    if (!bays.length) return;
    const L = this._rackMatlib();
    const craneMat = this._rackMat({
      color: ASRS_CRANE, roughness: 0.4, metalness: 0.55,
      emissive: new THREE.Color(ASRS_CRANE), emissiveIntensity: 0.12,
    });
    const B = (sx, sy, sz, x, y, z) => ({ g: new THREE.BoxGeometry(sx, sy, sz), x, y, z });

    // Patrol axis: from the first to the last bay, offset out to the pick face.
    const a = bays[0], b = bays[bays.length - 1];
    const nx = Math.sin(a.yaw), nz = Math.cos(a.yaw);
    const off = (a.depth || depth) * 0.75;
    const ax = a.x + nx * off, az = a.z + nz * off;
    const bx = b.x + nx * off, bz = b.z + nz * off;
    const runLen = Math.hypot(bx - ax, bz - az) + 2;

    // Static rails along the aisle (floor rail + overhead guide).
    if (runLen > 2.5) {
      const railG = this._mergeParts([
        { g: new THREE.BoxGeometry(0.12, 0.09, runLen), x: 0, y: 0.045, z: 0 },
        { g: new THREE.BoxGeometry(0.09, 0.09, runLen), x: 0, y: H - 0.1, z: 0 },
      ]);
      const rail = new THREE.Mesh(railG, L.rail);
      rail.position.set((ax + bx) / 2, 0, (az + bz) / 2);
      rail.rotation.y = -Math.atan2(bz - az, bx - ax) + Math.PI / 2;
      rail.castShadow = true; rail.receiveShadow = true;
      this.scene.add(rail);
    }

    // Crane body: bottom carriage + twin masts + top head.
    const body = [];
    body.push(B(0.55, 0.22, 1.0, 0, 0.16, 0));
    for (const sx of [-0.16, 0.16]) body.push(B(0.12, H - 0.4, 0.12, sx, H / 2, 0));
    body.push(B(0.5, 0.16, 0.5, 0, H - 0.22, 0));
    for (const sz of [-0.4, 0.4]) {
      body.push({
        g: new THREE.CylinderGeometry(0.08, 0.08, 0.06, 10, 1),
        x: 0, y: 0.08, z: sz, rz: Math.PI / 2,
      });
    }
    const bodyG = this._mergeParts(body);
    const g = new THREE.Group();
    g.add(new THREE.Mesh(bodyG, craneMat));

    // Lift carriage with telescoping forks (bobs up/down in _updateAsrs).
    const shuttleG = this._mergeParts([
      { g: new THREE.BoxGeometry(0.62, 0.42, 0.9), x: 0, y: 0, z: 0 },
      { g: new THREE.BoxGeometry(0.14, 0.07, depth * 1.3), x: -0.18, y: -0.24, z: 0 },
      { g: new THREE.BoxGeometry(0.14, 0.07, depth * 1.3), x: 0.18, y: -0.24, z: 0 },
    ]);
    const shuttle = new THREE.Mesh(shuttleG, craneMat);
    shuttle.position.y = H * 0.3;
    g.add(shuttle);
    _enableShadows(g);
    g.position.set(ax, 0, az);
    g.rotation.y = a.yaw;
    this.scene.add(g);
    this._asrsCrane = { group: g, shuttle, H, ax, az, bx, bz };
  },

  // A shared unit BoxGeometry (1×1×1) for every per-instance-scaled load piece.
  _unitBox() {
    if (!this._unitBoxG) {
      this._unitBoxG = new THREE.BoxGeometry(1, 1, 1);
      this._geometries.push(this._unitBoxG);
    }
    return this._unitBoxG;
  },

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
  },

  // Like _bayLocal but adds a forward tilt (about the bay's local X) for flow-rack
  // inclined lanes. Tilt + yaw are composed via a small Euler (YXZ).
  _bayLocalTilt(s, bay, dx, y, dz, tilt) {
    this._bayLocal(s, bay, dx, y, dz);
    s.euler.set(tilt, bay.yaw, 0, 'YXZ');
    s.quat.setFromEuler(s.euler);
    return s;
  },

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
  },

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
        case 'sorter':    group = this._makeSorter(mat); break;
        case 'agv':       group = this._makeDock(mat); break;
        default:          group = this._makeDock(mat); break;
      }
      group.position.set(x, 0, y);
      _enableShadows(group);
      this.scene.add(group);
    }
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  // 仕分機/ソーター: an elevated belt deck on legs with a scrolling tread (reuses
  // the conveyor belt texture + _belts registry so it flows), flanked by a row of
  // angled diverter chutes — reads instantly as a sortation line. ~8m long.
  _makeSorter(mat) {
    const g = new THREE.Group();
    const LEN = 8, W = 1.4, DECK_Y = 0.95;
    // Deck frame (matte) + moving belt tread on its top face (six-material box).
    const deckGeom = new THREE.BoxGeometry(LEN, 0.34, W);
    this._geometries.push(deckGeom);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x6b7681, roughness: 0.4, metalness: 0.7 });
    this._materials.push(frameMat);
    const treadTex = this._makeBeltTexture().clone();
    treadTex.needsUpdate = true;
    treadTex.repeat.set(LEN, 1);
    this._textures.push(treadTex);
    const treadMat = new THREE.MeshStandardMaterial({
      color: 0x222a31, roughness: 0.55, metalness: 0.25, map: treadTex,
      emissive: new THREE.Color(0x0f2b27), emissiveIntensity: 0.3,
    });
    this._materials.push(treadMat);
    const deck = new THREE.Mesh(deckGeom, [frameMat, frameMat, treadMat, frameMat, frameMat, frameMat]);
    deck.position.set(0, DECK_Y, 0);
    deck.castShadow = true; deck.receiveShadow = true;
    g.add(deck);
    this._belts.push({ mat: treadMat, speed: 1.4 });   // flows like a conveyor
    // Support legs.
    const legGeom = new THREE.BoxGeometry(0.18, DECK_Y, 0.18);
    this._geometries.push(legGeom);
    for (const lx of [-LEN / 2 + 0.5, -LEN / 6, LEN / 6, LEN / 2 - 0.5]) {
      for (const lz of [-W / 2 + 0.15, W / 2 - 0.15]) {
        const leg = new THREE.Mesh(legGeom, frameMat);
        leg.position.set(lx, DECK_Y / 2, lz);
        g.add(leg);
      }
    }
    // Diverter chutes fanning off one side (the sort destinations) — accent mat.
    const chuteGeom = new THREE.BoxGeometry(1.5, 0.08, 0.7);
    this._geometries.push(chuteGeom);
    for (let i = 0; i < 5; i++) {
      const chute = new THREE.Mesh(chuteGeom, mat);
      chute.position.set(-LEN / 2 + 1.2 + i * 1.5, DECK_Y - 0.18, W / 2 + 0.7);
      chute.rotation.set(-0.18, 0, 0);  // tilt down toward the floor
      chute.castShadow = true;
      g.add(chute);
    }
    return g;
  },
};
