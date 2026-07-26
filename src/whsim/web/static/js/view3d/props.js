// props.js — declarative CONCEPT-SCENE props for Scene3D.
//
// The rest of view3d/ renders a SIMULATION: entities exist because the engine
// produced them (workers, AGVs, racks, totes), and their motion comes out of a
// SimPy run. That is the right contract for 検証, and the wrong one for a
// concept scene — a scene whose job is to show "how a proposed method moves"
// before any capacity claim exists. Those scenes are storyboards: the shapes,
// the choreography and the camera are all AUTHORED, and forcing them through
// the engine would mean inventing a capacity model just to get a picture.
//
// So this module adds one generic primitive — `replay.props[]` — and nothing
// customer- or method-specific. A prop is a box/cylinder/plane with a position,
// a colour, an optional keyframe track and an optional set of named STATES. The
// state machine is the load-bearing part: "this container's lid is closed" is a
// material swap on a keyframe, which is how a storyboard says something changed
// without a number on screen. Anything a particular scene needs beyond that is
// expressed by composing props in its own JSON, not by adding code here.
//
// Everything is additive: a replay with no `props` key builds nothing, costs
// nothing, and every existing view is byte-for-byte unchanged.
//
// Coordinates match the rest of view3d: floor (x, z) in METRES, y is UP.
// For boxes and cylinders `y` is the BOTTOM of the prop (so y:0 sits on the
// floor) — authoring a table at "height 0.7" should not require knowing that
// three.js centres its geometry.
import * as THREE from '../../vendor/three/three.module.js';

// Local 2D canvas helper (scene.js has its own module-private copy; duplicating
// six lines is cheaper than widening that module's exports for this).
function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d') };
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// Scratch vector for the per-frame caption range check (no per-frame allocation).
const _wp = new THREE.Vector3();

// Resolve a colour that may be '#RRGGBB', 0xRRGGBB or absent.
function col(v, fallback) {
  if (v === undefined || v === null || v === '') return new THREE.Color(fallback);
  return new THREE.Color(v);
}

// Sample an authored prop track [[t, x, y, z, state], ...] at time t.
// Position lerps; STATE DOES NOT — a lid is open or closed, never 40% closed.
// The state of a span is the state of its LEFT keyframe, so a storyboard reads
// "at t=22 it becomes closed" exactly as written.
function samplePropKeys(keys, t) {
  if (!keys || keys.length === 0) return null;
  const first = keys[0];
  if (t <= num(first[0])) {
    return { x: num(first[1]), y: num(first[2]), z: num(first[3]), state: first[4] || null };
  }
  const last = keys[keys.length - 1];
  if (t >= num(last[0])) {
    return { x: num(last[1]), y: num(last[2]), z: num(last[3]), state: last[4] || null };
  }
  let i = 0;
  for (; i < keys.length - 1; i++) {
    if (num(keys[i][0]) <= t && t < num(keys[i + 1][0])) break;
  }
  const k0 = keys[i];
  const k1 = keys[i + 1];
  const span = num(k1[0]) - num(k0[0]);
  let f = span > 0 ? (t - num(k0[0])) / span : 0;
  f = Math.max(0, Math.min(1, f));
  // Ease long spans so a 10-second glide does not read as a conveyor jerk;
  // short hops stay linear. Endpoints are exact either way.
  if (span > 0.3) f = f * f * (3 - 2 * f);
  return {
    x: num(k0[1]) + (num(k1[1]) - num(k0[1])) * f,
    y: num(k0[2]) + (num(k1[2]) - num(k0[2])) * f,
    z: num(k0[3]) + (num(k1[3]) - num(k0[3])) * f,
    state: k0[4] || null,
  };
}

// Ease a camera cut. Storyboard cuts are authored as "be here at t=10, there at
// t=35"; a linear tween between them reads as a dolly on rails, which is what a
// concept video wants — but the ends need to settle, hence smoothstep.
function sampleTrack(track, t) {
  if (!track || track.length === 0) return null;
  const at = (k) => ({
    pos: Array.isArray(k.pos) ? k.pos.map((v) => num(v)) : [0, 10, 10],
    look: Array.isArray(k.look) ? k.look.map((v) => num(v)) : [0, 0, 0],
  });
  if (t <= num(track[0].t)) return at(track[0]);
  const last = track[track.length - 1];
  if (t >= num(last.t)) return at(last);
  let i = 0;
  for (; i < track.length - 1; i++) {
    if (num(track[i].t) <= t && t < num(track[i + 1].t)) break;
  }
  const a = track[i];
  const b = track[i + 1];
  const span = num(b.t) - num(a.t);
  let f = span > 0 ? (t - num(a.t)) / span : 0;
  f = Math.max(0, Math.min(1, f));
  // `cut: true` on the RIGHT key means jump, don't glide (scene change).
  if (b.cut) return f >= 1 ? at(b) : at(a);
  f = f * f * (3 - 2 * f);
  const A = at(a);
  const B = at(b);
  const mix = (u, v) => u + (v - u) * f;
  return {
    pos: [mix(A.pos[0], B.pos[0]), mix(A.pos[1], B.pos[1]), mix(A.pos[2], B.pos[2])],
    look: [mix(A.look[0], B.look[0]), mix(A.look[1], B.look[1]), mix(A.look[2], B.look[2])],
  };
}

export const propMethods = {
  // Build `replay.props[]`. No key ⇒ no-op, so every existing replay is
  // untouched. Props are built AFTER the engine geometry so a concept scene can
  // sit on the same floor/shell as a real layout if it wants to.
  _buildProps() {
    this._props = [];
    const specs = Array.isArray(this.replay.props) ? this.replay.props : [];
    if (specs.length === 0) return;
    const byId = new Map();
    for (const spec of specs) {
      const built = this._buildProp(spec);
      if (!built) continue;
      if (spec.id) byId.set(String(spec.id), built);
      // A prop may hang off another prop, so a lid can be authored in the
      // container's local frame and inherit its whole journey down the line.
      const parent = spec.parent ? byId.get(String(spec.parent)) : null;
      if (parent) parent.group.add(built.group);
      else this.scene.add(built.group);
      this._props.push(built);
    }
  },

  // One prop → { group, mesh, mats, spec, states } .
  _buildProp(spec) {
    if (!spec || spec.shape === 'none') return null;
    const shape = String(spec.shape || 'box');
    const group = new THREE.Group();

    let geom = null;
    let yOffset = 0; // geometry centre relative to the authored anchor
    if (shape === 'box') {
      const w = num(spec.w, 1);
      const h = num(spec.h, 1);
      const d = num(spec.d, 1);
      geom = new THREE.BoxGeometry(w, h, d);
      yOffset = h / 2; // author from the floor up, not from the centre
    } else if (shape === 'cyl' || shape === 'cylinder') {
      const r = num(spec.r, 0.5);
      const h = num(spec.h, 1);
      geom = new THREE.CylinderGeometry(r, num(spec.r2, r), h, num(spec.seg, 16));
      yOffset = h / 2;
    } else if (shape === 'plane' || shape === 'floor') {
      geom = new THREE.PlaneGeometry(num(spec.w, 1), num(spec.d, 1));
    } else if (shape === 'label') {
      return this._buildFloorLabel(spec, group);
    } else {
      return null;
    }

    const wire = !!spec.wireframe;
    const opacity = num(spec.opacity, 1);
    // Floor planes are unlit on purpose: a zone tint that reacts to the key
    // light stops reading as a painted floor marking.
    const mat = (shape === 'plane' || shape === 'floor')
      ? new THREE.MeshBasicMaterial({
        color: col(spec.color, 0xcccccc),
        transparent: opacity < 1,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
      : new THREE.MeshStandardMaterial({
        color: col(spec.color, 0xb0b6bd),
        roughness: num(spec.roughness, 0.6),
        metalness: num(spec.metalness, 0.1),
        transparent: opacity < 1 || wire,
        opacity,
        wireframe: wire,
        emissive: col(spec.emissive, 0x000000),
        emissiveIntensity: num(spec.emissiveIntensity, 1),
      });
    if (shape === 'plane' || shape === 'floor') mat.userData.noEnv = true;

    const mesh = new THREE.Mesh(geom, mat);
    const flat = shape === 'plane' || shape === 'floor';
    if (flat) mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = yOffset;
    // A floor plane authored at y:0 is coplanar with the slab and z-fights into
    // a moiré that looks like a rendering fault. Lift it by default; anything
    // that needs a specific stacking order says so explicitly.
    if (flat && spec.y === undefined) mesh.position.y = 0.01;
    // Flat props are transparent and depth-write nothing, so three.js orders them
    // by camera distance — and two decals 1 cm apart sort arbitrarily. Without an
    // explicit order a zone tint can paint over the label lying on top of it and
    // wash the text out. Tints at 2, labels at 3 (see _buildFloorLabel).
    if (flat) mesh.renderOrder = num(spec.renderOrder, 2);
    const solid = shape !== 'plane' && shape !== 'floor';
    mesh.castShadow = solid && spec.cast !== false;
    mesh.receiveShadow = spec.receive !== false;
    group.add(mesh);
    this._track(geom, mat);

    group.position.set(num(spec.x), num(spec.y), num(spec.z));
    group.rotation.y = num(spec.ry);

    const sprite = spec.label ? this._attachBillboard(group, spec, num(spec.h, 1)) : null;

    const built = {
      spec,
      group,
      sprite,
      mesh,
      mat,
      base: {
        color: mat.color.clone(),
        opacity: mat.opacity,
        wireframe: !!mat.wireframe,
        transparent: mat.transparent,
      },
      keys: Array.isArray(spec.keys) ? spec.keys : null,
      states: spec.states && typeof spec.states === 'object' ? spec.states : null,
      curState: undefined,
      from: spec.from === undefined ? null : num(spec.from),
      to: spec.to === undefined ? null : num(spec.to),
    };
    // Apply the authored initial state once so a scene paused at t=0 is right.
    if (built.states && spec.state) this._applyPropState(built, String(spec.state));
    return built;
  },

  // A text plate painted flat on the floor — how a concept scene names a zone
  // without a DOM overlay that would fall out of a recorded frame.
  _buildFloorLabel(spec, group) {
    const text = String(spec.text || '');
    const w = num(spec.w, 4);
    const d = num(spec.d, 1);
    const PX = 128; // texels per metre of the long side
    const cw = Math.max(64, Math.min(2048, Math.round(w * PX)));
    const ch = Math.max(32, Math.min(1024, Math.round(d * PX)));
    const { c, ctx } = canvas2d(cw, ch);
    ctx.clearRect(0, 0, cw, ch);
    if (spec.plate) {
      ctx.fillStyle = spec.plate === true ? 'rgba(255,255,255,0.72)' : String(spec.plate);
      ctx.fillRect(0, 0, cw, ch);
    }
    ctx.fillStyle = String(spec.color || '#1F497D');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Fit the text to the plate. A fixed size silently truncates the longer
    // names — 「梱包工程（無変更）」 lost its last two characters, which is the
    // one label whose whole job is to say the packing step is unchanged.
    const font = (px) => `700 ${px}px "Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif`;
    let fs = Math.round(ch * num(spec.textScale, 0.52));
    ctx.font = font(fs);
    const room = cw * 0.94;
    const wide = ctx.measureText(text).width;
    if (wide > room) {
      fs = Math.max(8, Math.floor(fs * room / wide));
      ctx.font = font(fs);
    }
    ctx.fillText(text, cw / 2, ch / 2);
    const tex = new THREE.CanvasTexture(c);
    // Canvas pixels are sRGB. Without saying so the renderer treats them as
    // linear and every label comes out washed pale — navy text reads as a ghost.
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    // Floor text is always seen at a grazing angle; without anisotropy the
    // mipmap chain smears it into an unreadable blur at any distance.
    tex.anisotropy = this._maxAniso ? this._maxAniso() : 1;
    this._textures.push(tex);
    const geom = new THREE.PlaneGeometry(w, d);
    // `overlay` lifts a plate out of the floor's depth ordering entirely. Most
    // floor text IS a floor marking and should be hidden by whatever stands on
    // it — but a closing disclaimer is a caption that happens to be laid flat,
    // and a workbench cutting three characters out of it defeats the whole
    // reason it is in the scene rather than in the deck.
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      opacity: num(spec.opacity, 1),
      depthTest: !spec.overlay,
    });
    mat.userData.noEnv = true;
    const mesh = new THREE.Mesh(geom, mat);
    mesh.rotation.x = -Math.PI / 2;
    // Zone tints live at y=0.008 and floor markings just under; sit above both.
    mesh.position.y = num(spec.y, 0.02);
    // Always painted after the tints (see _buildProp) so text never washes out.
    mesh.renderOrder = num(spec.renderOrder, spec.overlay ? 40 : 3);
    group.add(mesh);
    this._track(geom, mat);
    group.position.set(num(spec.x), 0, num(spec.z));
    group.rotation.y = num(spec.ry);
    return {
      spec, group, mesh, mat, isLabel: true,
      base: { color: mat.color.clone(), opacity: mat.opacity, wireframe: false, transparent: true },
      keys: Array.isArray(spec.keys) ? spec.keys : null,
      states: null,
      curState: undefined,
      from: spec.from === undefined ? null : num(spec.from),
      to: spec.to === undefined ? null : num(spec.to),
    };
  },

  // A camera-facing caption above a prop (station names, 停A/停B …).
  _attachBillboard(group, spec, h) {
    const text = String(spec.label || '');
    const W = 512;
    const H = 128;
    const { c, ctx } = canvas2d(W, H);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = String(spec.labelBg || 'rgba(255,255,255,0.88)');
    const r = 16;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(4, 24, W - 8, H - 48, r) : ctx.rect(4, 24, W - 8, H - 48);
    ctx.fill();
    ctx.fillStyle = String(spec.labelColor || '#1F497D');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 54px "Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif';
    ctx.fillText(text, W / 2, H / 2);
    const tex = new THREE.CanvasTexture(c);
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    this._textures.push(tex);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
    const sp = new THREE.Sprite(mat);
    const scale = num(spec.labelScale, 1);
    sp.scale.set(2.4 * scale, 0.6 * scale, 1);
    sp.position.y = h + num(spec.labelLift, 0.55);
    group.add(sp);
    this._materials.push(mat);
    return sp;
  },

  // Swap the material to a named state. Absent keys inherit the base look, so a
  // state can say only "color" and leave opacity/wireframe alone.
  _applyPropState(p, name) {
    if (!p.states || p.curState === name) return;
    const s = p.states[name];
    p.curState = name;
    if (!s) {
      p.mat.color.copy(p.base.color);
      p.mat.opacity = p.base.opacity;
      p.mat.wireframe = p.base.wireframe;
      p.mat.transparent = p.base.transparent;
      p.mat.needsUpdate = true;
      return;
    }
    p.mat.color.copy(s.color !== undefined ? col(s.color, 0xffffff) : p.base.color);
    p.mat.opacity = s.opacity !== undefined ? num(s.opacity, 1) : p.base.opacity;
    p.mat.wireframe = s.wireframe !== undefined ? !!s.wireframe : p.base.wireframe;
    p.mat.transparent = p.mat.opacity < 1 || p.mat.wireframe;
    if (p.mat.emissive) {
      p.mat.emissive.copy(s.emissive !== undefined ? col(s.emissive, 0x000000) : new THREE.Color(0x000000));
      p.mat.emissiveIntensity = num(s.emissiveIntensity, 1);
    }
    p.mat.needsUpdate = true;
  },

  // Per-frame: position from the track, look from the state, visibility from
  // the authored window.
  _updateProps(t) {
    const props = this._props;
    if (!props || props.length === 0) return;
    for (const p of props) {
      let vis = true;
      if (p.from !== null && t < p.from) vis = false;
      if (p.to !== null && t >= p.to) vis = false;
      if (p.group.visible !== vis) p.group.visible = vis;
      if (!vis) continue;
      if (p.keys) {
        const s = samplePropKeys(p.keys, t);
        if (s) {
          p.group.position.set(s.x, s.y, s.z);
          if (s.state && p.states) this._applyPropState(p, s.state);
        }
      }
      // Floor text has a reading direction, and a storyboard visits the same
      // zone from both sides — the packing zone is shot from -z in the hand-off
      // cut and from +z in every overview. Painted text that is upside down in
      // half the film is worse than no text, so flip it to face the camera. It
      // stays a floor marking (the brief asks for the zone names on the floor);
      // only its reading direction follows the viewer. The dead band stops a
      // camera that grazes the label's own axis from strobing between the two.
      if (p.isLabel && p.spec.faceCamera !== false) {
        const dz = this.camera.position.z - p.group.position.z;
        if (Math.abs(dz) > 0.75) {
          const flip = dz < 0 ? Math.PI : 0;
          const want = num(p.spec.ry) + flip;
          if (p.group.rotation.y !== want) p.group.rotation.y = want;
        }
      }
      // A caption is sized in metres, so a close-up walks straight into it and a
      // 2 m-wide name plate swallows the shot it was meant to annotate. Captions
      // are for the wide and mid cuts; inside `labelNear` they get out of the way.
      if (p.sprite) {
        const near = num(p.spec.labelNear, 4.5);
        p.group.getWorldPosition(_wp);
        p.sprite.visible = _wp.distanceTo(this.camera.position) > near;
      }
    }
  },

  // Drive the camera from `meta.camera_track`. Only active when a track exists,
  // and it yields the moment the viewer touches the controls — a recorded take
  // is scripted, but the same page has to stay explorable by a human.
  _updateCameraTrack(t) {
    const track = this.replay.meta && this.replay.meta.camera_track;
    if (!Array.isArray(track) || track.length === 0) return;
    if (this._userMoved) return;
    const s = sampleTrack(track, t);
    if (!s) return;
    // Cancel the generic intro tween; the storyboard owns the camera now.
    this._intro = null;
    this.camera.position.set(s.pos[0], s.pos[1], s.pos[2]);
    this.controls.target.set(s.look[0], s.look[1], s.look[2]);
    this.camera.lookAt(s.look[0], s.look[1], s.look[2]);
  },

  // Persistent corner disclaimer + title. A concept scene has to carry its own
  // caveat INTO the recording — a caption added later in the deck is not on the
  // frame someone screenshots. Pure DOM over the canvas; no scene cost.
  _buildConceptOverlay() {
    const meta = this.replay.meta || {};
    if (!meta.watermark && !meta.title) return;
    const host = document.createElement('div');
    host.className = 'v3d-concept';
    host.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
      + 'font-family:"Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;'
      + 'z-index:6';
    if (meta.title) {
      const h = document.createElement('div');
      h.textContent = String(meta.title);
      h.style.cssText = 'position:absolute;left:28px;top:22px;color:#1F497D;'
        + 'font-size:26px;font-weight:700;letter-spacing:.02em;'
        + 'text-shadow:0 1px 3px rgba(255,255,255,.85)';
      host.appendChild(h);
    }
    if (meta.watermark) {
      const w = document.createElement('div');
      w.textContent = String(meta.watermark);
      w.style.cssText = 'position:absolute;right:24px;bottom:18px;color:#5A6B80;'
        + 'font-size:15px;font-weight:600;background:rgba(255,255,255,.72);'
        + 'padding:6px 12px;border-radius:4px';
      host.appendChild(w);
    }
    const parent = this.container;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    parent.appendChild(host);
    this._concept = host;
  },
};

export { samplePropKeys, sampleTrack };
