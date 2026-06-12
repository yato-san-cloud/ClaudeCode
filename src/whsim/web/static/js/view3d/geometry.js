// view3d/geometry.js — three.js geometry/material builders for Scene3D: the
// realistic per-rack_type storage equipment (pallet beams, shelving tiers, flow
// roller lanes, nestainer/hanger/mezzanine/mobile, AS/RS tower + crane), the
// legacy point-rack fallback, and the static placed-equipment composites
// (forklift/AS-RS/robot arm/crane/dock/sorter). Mixed into Scene3D.prototype by
// view3d.js via Object.assign; every method is moved verbatim (no value changes)
// and still runs with `this` bound to the Scene3D instance, so the scene graph,
// draw-call counts and shared state (_geometries/_materials/_rackMaterials/
// _shelfRuns/_belts/_asrsCrane) are byte-for-byte what the monolith built.
import * as THREE from '../../vendor/three/three.module.js';
import {
  ABC_COLOR, RACK_DIMS, RACK_DEFAULT, rackDims,
  RACK_STEEL, RACK_BEAM, RACK_BOARD, PALLET_WOOD, ROLLER_COLOR,
  ASRS_FRAME, ASRS_CRANE, EQUIP_COLOR, _enableShadows,
} from './constants.js';

export const geometryMethods = {
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
        case 'hanger':    this._buildHangerRack(bays); break;
        case 'mezzanine': this._buildMezzanine(bays); break;
        case 'mobile':    this._buildMobileRack(bays); break;
        case 'light':
        case 'medium':
        default:          this._buildShelving(bays, rt); break;
      }
    }
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
    const y0 = run.y0 || 0, y1 = run.y1 || 0;
    const length = Math.max(0.1, Math.abs(y1 - y0));
    return {
      x0: run.x || 0, z0: Math.min(y0, y1), ux: 0, uz: 1,
      length, bayW, yaw: 0, depth: run.depth || dims.depth,
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
  },

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
  },

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
  },

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
  },

  // ハンガーラック (hanger rack, apparel): end posts + a top rail with garments
  // hanging from it — narrow ABC-tinted slabs at varied drops, reading instantly
  // as 吊るし保管. 3 instanced pieces (posts / rail / garments).
  _buildHangerRack(bays) {
    const dims = RACK_DIMS.hanger;
    const H = dims.h, depth = dims.depth;
    const s = this._scratch();
    const postG = new THREE.BoxGeometry(0.07, H, 0.07);
    const railG = new THREE.BoxGeometry(1, 0.06, 0.06);
    const garmG = new THREE.BoxGeometry(1, H * 0.5, depth * 0.45);
    this._geometries.push(postG, railG, garmG);
    const steelMat = this._rackMat({ color: RACK_STEEL, roughness: 0.5, metalness: 0.6 });
    const garmMat = this._rackMat({ color: 0xffffff, roughness: 0.9, metalness: 0.0,
      emissive: new THREE.Color(0x111111), emissiveIntensity: 0.05 }, true);
    // End posts (2 per bay, at the bay edges).
    this._instancePieces(postG, steelMat, bays, 2, (j, bay) => {
      const sgn = j ? 0.5 : -0.5;
      this._bayLocal(s, bay, sgn * (bay.bw - 0.07), H / 2, 0);
      return s;
    });
    // Top rail spanning the bay.
    this._instancePieces(railG, steelMat, bays, 1, (j, bay) => {
      this._bayLocal(s, bay, 0, H * 0.93, 0);
      s.scale.set(bay.bw, 1, 1);
      return s;
    });
    // Hanging garments: 4 per bay, spread along the rail, alternating drop so the
    // rack silhouette reads as clothes on hangers (not boxes).
    this._instancePieces(garmG, garmMat, bays, 4, (j, bay) => {
      const fx = (j + 0.5) / 4 - 0.5;             // -0.375 .. 0.375 along the bay
      const drop = (j % 2) ? 0.62 : 0.66;          // slight stagger
      this._bayLocal(s, bay, fx * bay.bw, H * drop, 0);
      s.scale.set(bay.bw * 0.2, 1, 1);
      return s;
    }, true);
  },

  // メザニン (mezzanine): columns + a mid-height deck slab with an edge railing,
  // ABC-tinted goods on BOTH the floor and the deck — the 床面積を倍化 story in
  // one glance. 4 instanced pieces (columns / deck / railing / goods×2levels).
  _buildMezzanine(bays) {
    const dims = RACK_DIMS.mezzanine;
    const H = dims.h, depth = dims.depth;
    const deckY = H * 0.52;
    const s = this._scratch();
    const colG = new THREE.BoxGeometry(0.14, deckY, 0.14);
    const deckG = new THREE.BoxGeometry(1, 0.12, depth);
    const railG = new THREE.BoxGeometry(1, 0.55, 0.05);
    const goodsG = new THREE.BoxGeometry(1, H * 0.30, depth * 0.7);
    this._geometries.push(colG, deckG, railG, goodsG);
    const steelMat = this._rackMat({ color: RACK_STEEL, roughness: 0.55, metalness: 0.55 });
    const deckMat = this._rackMat({ color: 0x8a939e, roughness: 0.75, metalness: 0.3 });
    const goodsMat = this._rackMat({ color: 0xffffff, roughness: 0.84, metalness: 0.04,
      emissive: new THREE.Color(0x111111), emissiveIntensity: 0.06 }, true);
    // 4 support columns per bay (corners, under the deck).
    this._instancePieces(colG, steelMat, bays, 4, (j, bay) => {
      const sgnX = (j & 1) ? 0.5 : -0.5, sgnZ = (j & 2) ? 0.5 : -0.5;
      this._bayLocal(s, bay, sgnX * (bay.bw - 0.14), deckY / 2, sgnZ * (depth - 0.14));
      return s;
    });
    // Deck slab.
    this._instancePieces(deckG, deckMat, bays, 1, (j, bay) => {
      this._bayLocal(s, bay, 0, deckY, 0);
      s.scale.set(bay.bw, 1, 1);
      return s;
    });
    // Edge railing on the pick-face (+Z) side of the deck.
    this._instancePieces(railG, steelMat, bays, 1, (j, bay) => {
      this._bayLocal(s, bay, 0, deckY + 0.34, depth * 0.48);
      s.scale.set(bay.bw, 1, 1);
      return s;
    });
    // Goods on the floor (below the deck) and on the deck.
    this._instancePieces(goodsG, goodsMat, bays, 2, (j, bay) => {
      const y = j ? deckY + 0.06 + H * 0.15 : H * 0.15;
      this._bayLocal(s, bay, 0, y, 0);
      s.scale.set(bay.bw * 0.8, 1, 1);
      return s;
    }, true);
  },

  // 移動ラック (mobile rack): a standard shelving body riding a dark base
  // carriage on floor rails that extend cross-aisle — the 通路を共有して保管効率
  // 最大 story. 5 instanced pieces (rails / carriage / frame / boards / goods).
  _buildMobileRack(bays) {
    const dims = RACK_DIMS.mobile;
    const H = dims.h, tiers = dims.levels, depth = dims.depth;
    const bodyH = H - 0.24;
    const tierH = bodyH / tiers;
    const s = this._scratch();
    const railG = new THREE.BoxGeometry(0.08, 0.05, depth * 2.6);
    const carrG = new THREE.BoxGeometry(1, 0.2, depth * 1.12);
    const frameG = new THREE.BoxGeometry(1, bodyH, depth);
    const boardG = new THREE.BoxGeometry(1, 0.04, depth * 0.96);
    const goodsG = new THREE.BoxGeometry(1, tierH * 0.58, depth * 0.78);
    this._geometries.push(railG, carrG, frameG, boardG, goodsG);
    const railMat = this._rackMat({ color: 0x2c333c, roughness: 0.45, metalness: 0.7 });
    const carrMat = this._rackMat({ color: 0x3a424d, roughness: 0.5, metalness: 0.6 });
    const frameMat = this._rackMat({ color: RACK_STEEL, roughness: 0.6, metalness: 0.45,
      transparent: true, opacity: 0.3 });
    const boardMat = this._rackMat({ color: RACK_BOARD, roughness: 0.7, metalness: 0.3 });
    const goodsMat = this._rackMat({ color: 0xffffff, roughness: 0.82, metalness: 0.05,
      emissive: new THREE.Color(0x111111), emissiveIntensity: 0.06 }, true);
    // Floor rails (2 per bay) running cross-aisle so the carriages read as sliding.
    this._instancePieces(railG, railMat, bays, 2, (j, bay) => {
      const sgn = j ? 0.32 : -0.32;
      this._bayLocal(s, bay, sgn * bay.bw, 0.03, 0);
      return s;
    });
    // Base carriage under the shelving body.
    this._instancePieces(carrG, carrMat, bays, 1, (j, bay) => {
      this._bayLocal(s, bay, 0, 0.12, 0);
      s.scale.set(bay.bw * 0.98, 1, 1);
      return s;
    });
    // Shelving body (frame cage + boards + ABC goods), lifted onto the carriage.
    this._instancePieces(frameG, frameMat, bays, 1, (j, bay) => {
      this._bayLocal(s, bay, 0, 0.24 + bodyH / 2, 0);
      s.scale.set(bay.bw, 1, 1);
      return s;
    });
    this._instancePieces(boardG, boardMat, bays, tiers, (j, bay) => {
      this._bayLocal(s, bay, 0, 0.24 + tierH * j + 0.02, 0);
      s.scale.set(bay.bw * 0.96, 1, 1);
      return s;
    });
    this._instancePieces(goodsG, goodsMat, bays, tiers, (j, bay) => {
      this._bayLocal(s, bay, 0, 0.24 + tierH * (j + 0.5), 0);
      s.scale.set(bay.bw * 0.8, 1, 1);
      return s;
    }, true);
  },

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
  },

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
