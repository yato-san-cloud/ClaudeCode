// view3d/overlay.js — Scene3D's interactive + presentation layer: the bottleneck
// spotlight (warm shaft + pulsing/sonar rings + real SpotLight + floating ⚠
// label, with the zone/congestion anchor resolver shared with the 2D ⚠), the
// click-to-select interactivity (raycast + floor ring + DOM tooltip + soft
// follow-camera), the scene legend / controls-hint DOM overlay, the live
// productivity HUD (sparkline DOM overlay), and the one-shot intro camera tween.
// Mixed into Scene3D.prototype by view3d.js; every method is moved verbatim (no
// value changes) and runs with `this` bound to the Scene3D instance, so the
// selection state, DOM overlays and bottleneck refs match the monolith exactly.
import * as THREE from '../../vendor/three/three.module.js';
import {
  RACK_DEFAULT, RACK_LEGEND, GLOW_CYAN, SEL_STATE_LABEL, sampleKeyframes,
} from './constants.js';

export const overlayMethods = {
  // -- Bottleneck spotlight --------------------------------------------------
  // Dramatise the run's binding constraint in 3D: a warm translucent light
  // SHAFT (additive cone — real SpotLights don't scatter in air without a
  // volumetric pass, none vendored), a pulsing floor ring, and a floating ⚠
  // label over the bottleneck zone, plus an actual SpotLight that genuinely
  // brightens that floor. Driven externally (mount3d resolves the bottleneck
  // label → zone type via JP_TO_TYPE and calls this); no-ops when the zone
  // isn't found, so it's fully backward-compatible. Re-callable: it tears down
  // any previous marker first. Mirrors the 2D ⚠ overlay so the proposal's
  // ③検証 bottleneck reads the same across PNG / 2D / 3D.
  setBottleneck(zoneType) {
    this._disposeBottleneck();
    if (!zoneType) return;
    const anchor = this._resolveBottleneckAnchor(zoneType);
    if (!anchor) return; // no matching zone and no congestion to fall back on
    const { cx, cz, r, src } = anchor;
    const span = Math.max(this.bounds.width, this.bounds.depth);
    const beamH = Math.max(8, span * 0.85);
    const AMBER = 0xf5b05a;
    const group = new THREE.Group();
    const geoms = [];
    const mats = [];
    const texs = [];

    // 1) Volumetric-looking light shaft: hollow additive cone, wide base on the
    //    floor narrowing toward a point above. Faint so it reads as a god-ray.
    const beamGeom = new THREE.ConeGeometry(r * 1.05, beamH, 40, 1, true);
    const beamMat = new THREE.MeshBasicMaterial({
      color: AMBER, transparent: true, opacity: 0.12, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const beam = new THREE.Mesh(beamGeom, beamMat);
    beam.position.set(cx, beamH / 2, cz); // base at floor, tip up
    group.add(beam);
    geoms.push(beamGeom); mats.push(beamMat);

    // 2) Bold pulsing floor ring (annulus) laid flat at the zone — the primary
    //    top-down signal, thick + bright so it reads even amid amber ABC racks.
    const ringGeom = new THREE.RingGeometry(r * 0.74, r * 1.12, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: AMBER, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cx, 0.06, cz);
    group.add(ring);
    geoms.push(ringGeom); mats.push(ringMat);

    // 3) Expanding "sonar" ring — a UNIT annulus (radius ~1) scaled + faded
    //    outward every cycle in _updateBottleneck. Motion is what catches the eye
    //    from the default near-top-down camera, where a static ring blends in.
    const sonarGeom = new THREE.RingGeometry(0.92, 1.0, 64);
    const sonarMat = new THREE.MeshBasicMaterial({
      color: AMBER, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const sonar = new THREE.Mesh(sonarGeom, sonarMat);
    sonar.rotation.x = -Math.PI / 2;
    sonar.position.set(cx, 0.07, cz);
    group.add(sonar);
    geoms.push(sonarGeom); mats.push(sonarMat);

    // 4) A real SpotLight so the zone floor genuinely brightens (cheap; shadows
    //    off — the key directional already owns the scene's contact shadows).
    const light = new THREE.SpotLight(0xffd9a0, 3.6, beamH * 1.6,
      Math.atan2(r * 1.2, beamH) + 0.05, 0.6, 1.0);
    light.position.set(cx, beamH, cz);
    light.target.position.set(cx, 0, cz);
    light.castShadow = false;
    group.add(light);
    group.add(light.target);

    // 5) Floating ⚠ label, billboarded (always faces camera, depthTest off so it
    //    never hides behind racks), bobbing above rack height.
    const tex = this._makeWarnLabelTexture();
    const labelMat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false,
    });
    const label = new THREE.Sprite(labelMat);
    const labY = Math.max(5, span * 0.10);
    const labW = Math.max(10, r * 2.4);
    label.scale.set(labW, labW * 0.5, 1);
    label.position.set(cx, labY, cz);
    label.center.set(0.5, 0.0);
    group.add(label);
    mats.push(labelMat); texs.push(tex);

    this.scene.add(group);
    this._bottleneck = {
      group, beam, beamMat, ring, ringMat, sonar, sonarMat,
      light, label, labelMat, cx, cz, labY, baseRing: r, geoms, mats, texs,
    };
    // Opt-in placement confirmation for the headless screenshot PDCA loop
    // (invisible in production; enable with localStorage 'whsim-3ddebug').
    try {
      if (window.localStorage && localStorage.getItem('whsim-3ddebug')) {
        // eslint-disable-next-line no-console
        console.info(`[whsim] bottleneck spotlight: ${zoneType} via ${src} @ `
          + `(${cx.toFixed(1)}, ${cz.toFixed(1)}) r=${r.toFixed(1)}`);
      }
    } catch (e) { /* no localStorage (sandboxed) — ignore */ }
  },

  // Where does the bottleneck live on the floor? Prefer an explicit process zone
  // of that type (receiving/picking/packing/…). Many real layouts have no such
  // zone — picking happens across the storage racks — so fall back to the
  // congestion hotspot (the value-weighted centre of the busiest cells), which
  // for a process-bound run IS that process's floor. Returns {cx,cz,r,src} or
  // null. Mirrors what the 2D ⚠ overlay *should* do, generalised.
  _resolveBottleneckAnchor(zoneType) {
    const z = (this.replay.zones || []).find((zz) => zz.type === zoneType);
    if (z && z.w > 0 && z.h > 0) {
      // A focused ring inside the zone (capped so a floor-sized zone like a
      // single 'storage' area doesn't ring the whole building).
      const r = Math.max(1.6, Math.min(Math.min(z.w, z.h) * 0.5, 10));
      return { cx: (z.x || 0) + z.w / 2, cz: (z.y || 0) + z.h / 2, r, src: 'zone' };
    }
    const c = this.replay.congestion;
    if (c && Array.isArray(c.cells) && c.cells.length && c.grid_m > 0) {
      let max = 0;
      for (const cell of c.cells) { if (cell[2] > max) max = cell[2]; }
      if (max <= 0) return null;
      // Value-weighted centroid over the hot cells (>= 60% of peak) so a single
      // noisy peak doesn't yank the marker; weight by value to bias to the core.
      const thr = max * 0.6;
      let sx = 0, sz = 0, sw = 0;
      for (const [ix, iy, v] of c.cells) {
        if (v < thr) continue;
        const wgt = v;
        sx += (ix + 0.5) * c.grid_m * wgt;
        sz += (iy + 0.5) * c.grid_m * wgt;
        sw += wgt;
      }
      if (sw <= 0) return null;
      return { cx: sx / sw, cz: sz / sw, r: Math.max(3.5, c.grid_m * 1.4), src: 'congestion' };
    }
    return null;
  },

  // ⚠ + "ボトルネック" drawn on a transparent canvas for the floating label.
  // Dark pill + amber border so it stays legible over any floor tone / racks.
  _makeWarnLabelTexture() {
    const W = 512, H = 256; // hi-res so it stays crisp when scaled up in world
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    // Pill backdrop with an amber outline (reads as a warning chip from afar).
    const pad = 14, rad = 40;
    ctx.fillStyle = 'rgba(18,14,8,0.82)';
    ctx.strokeStyle = '#f5b05a';
    ctx.lineWidth = 6;
    if (ctx.roundRect) {
      ctx.beginPath(); ctx.roundRect(pad, pad, W - 2 * pad, H - 2 * pad, rad);
      ctx.fill(); ctx.stroke();
    } else { ctx.fillRect(pad, pad, W - 2 * pad, H - 2 * pad); }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffcf7a';
    ctx.font = 'bold 104px sans-serif';
    ctx.fillText('⚠', W / 2, 92);
    ctx.fillStyle = '#ffe6bf';
    ctx.font = 'bold 58px sans-serif';
    ctx.fillText('ボトルネック', W / 2, 188);
    const tex = new THREE.CanvasTexture(canvas);
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    return tex; // owned by this._bottleneck.texs (disposed in _disposeBottleneck)
  },

  // Per-frame: static ring breathes, sonar ring expands+fades, beam shimmers,
  // label bobs. Uses direct mesh refs (no child-index coupling).
  _updateBottleneck() {
    const b = this._bottleneck;
    if (!b) return;
    const e = this._clock.elapsedTime; // continuous; getDelta() resets only delta
    const pulse = 0.5 + 0.5 * Math.sin(e * 2.2); // 0..1
    if (b.ringMat) b.ringMat.opacity = 0.55 + 0.4 * pulse;
    if (b.ring) { const s = 1 + 0.05 * pulse; b.ring.scale.set(s, s, 1); }
    // Sonar: a UNIT ring grown from ~0.9× to ~2.3× the base radius, fading out,
    // restarting each cycle — the motion cue that reads from straight overhead.
    if (b.sonar && b.sonarMat) {
      const sp = (e % 1.8) / 1.8;            // 0..1 sweep
      const sc = b.baseRing * (0.9 + sp * 1.4);
      b.sonar.scale.set(sc, sc, 1);
      b.sonarMat.opacity = 0.55 * (1 - sp);  // brightest at birth, gone at edge
    }
    if (b.beamMat) b.beamMat.opacity = 0.09 + 0.07 * pulse;
    if (b.label) b.label.position.y = b.labY + 0.35 * Math.sin(e * 1.6);
  },

  _disposeBottleneck() {
    const b = this._bottleneck;
    if (!b) return;
    if (b.light && b.light.target && b.group) b.group.remove(b.light.target);
    if (b.group) this.scene.remove(b.group);
    for (const g of (b.geoms || [])) { if (g && g.dispose) g.dispose(); }
    for (const m of (b.mats || [])) { if (m && m.dispose) m.dispose(); }
    for (const t of (b.texs || [])) { if (t && t.dispose) t.dispose(); }
    this._bottleneck = null;
  },

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
  },

  // -- Click-to-select interactivity ----------------------------------------
  // Lets the user click any moving agent (worker / AGV / forklift) to SELECT it.
  // A bright cyan floor ring tracks the selection every frame, a small DOM card
  // (`.v3d-seltip`, child of the container, pointer-events:none) shows its role /
  // state / (x,z) in metres, and an optional soft follow-camera eases the orbit
  // target toward it. Everything here is additive and torn down in dispose().
  _buildSelection() {
    this._sel = null;
    // Nothing to select against → skip the whole feature (no listener, no DOM).
    const any = this._workers.length || this._agvs.length || this._forklifts.length;
    if (!any) return;

    // Container must be a positioning context for the absolute tooltip child
    // (the HUD/info overlay likely already ensured this; harmless to repeat).
    try {
      const cs = window.getComputedStyle(this.container);
      if (cs && cs.position === 'static') this.container.style.position = 'relative';
    } catch (_e) { /* ignore */ }

    // Floor ring marker — additive cyan torus laid flat, repositioned each frame
    // under the selected agent. Hidden until something is selected.
    const ringG = new THREE.RingGeometry(0.55, 0.78, 40);
    this._geometries.push(ringG);
    const ringMat = new THREE.MeshBasicMaterial({
      color: GLOW_CYAN, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._materials.push(ringMat);
    const ring = new THREE.Mesh(ringG, ringMat);
    ring.rotation.x = -Math.PI / 2; // lay flat on the floor
    ring.position.y = 0.03;
    ring.renderOrder = 6;           // draw over the floor/zones
    ring.visible = false;
    this.scene.add(ring);

    // Live DOM info card — mirrors the HUD/info card styling (dark translucent,
    // cyan accent). pointer-events:none so it never eats canvas drags.
    const tip = document.createElement('div');
    tip.className = 'v3d-seltip';
    tip.setAttribute('data-v3d-sel', '1');
    tip.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'z-index:6',
      'transform:translate(-50%,calc(-100% - 14px))',
      'min-width:120px', 'max-width:200px', 'padding:6px 9px', 'border-radius:8px',
      'background:rgba(15,20,29,0.82)', 'backdrop-filter:blur(4px)',
      'color:#e6edf3', 'font:11px/1.4 system-ui,-apple-system,sans-serif',
      'pointer-events:none', 'box-shadow:0 2px 10px rgba(0,0,0,0.4)',
      'border:1px solid rgba(0,184,212,0.45)', 'white-space:nowrap', 'display:none',
    ].join(';');
    const tipRole = document.createElement('div');
    tipRole.style.cssText = 'color:#00d4f0;font-weight:600;margin-bottom:2px';
    const tipState = document.createElement('div');
    tipState.style.cssText = 'color:#cdd6e0';
    const tipPos = document.createElement('div');
    tipPos.style.cssText = 'color:#8b98a8;font-size:10px;margin-top:1px';
    const tipHint = document.createElement('div');
    tipHint.style.cssText = 'color:#566273;font-size:9px;margin-top:3px';
    tipHint.textContent = 'ダブルクリックで追従';
    tip.appendChild(tipRole); tip.appendChild(tipState); tip.appendChild(tipPos);
    tip.appendChild(tipHint);
    this.container.appendChild(tip);

    // Raycaster + pointer state. We record the down position so a click that is
    // really a camera-drag does not trigger a (de)selection.
    this._sel = {
      ring, ringMat, tip, tipRole, tipState, tipPos,
      ref: null, follow: false,
      raycaster: new THREE.Raycaster(),
      ndc: new THREE.Vector2(),
      proj: new THREE.Vector3(),
      downX: 0, downY: 0, downT: 0,
    };

    const el = this.renderer.domElement;
    this._onSelDown = (e) => {
      this._sel.downX = e.clientX; this._sel.downY = e.clientY;
      this._sel.downT = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    };
    this._onSelUp = (e) => {
      const s = this._sel;
      if (!s) return;
      // Treat as a click only if the pointer barely moved (else it was a drag).
      const dx = e.clientX - s.downX, dy = e.clientY - s.downY;
      if (dx * dx + dy * dy > 36) return; // >6px → camera drag, ignore
      const hit = this._pickAgent(e);
      if (hit) this._selectAgent(hit);
      else this._deselect();
    };
    // Double-click toggles the soft follow-camera on the current selection.
    this._onSelDbl = () => {
      const s = this._sel;
      if (s && s.ref) { s.follow = !s.follow; this._refreshSelTip(); }
    };
    el.addEventListener('pointerdown', this._onSelDown);
    el.addEventListener('pointerup', this._onSelUp);
    el.addEventListener('dblclick', this._onSelDbl);
  },

  // Raycast the pointer against the agent meshes and return the nearest agent
  // record (walking up parents to the tagged mesh/group), or null on empty space.
  _pickAgent(e) {
    const s = this._sel;
    if (!s) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    s.ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    s.ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    s.raycaster.setFromCamera(s.ndc, this.camera);
    // Targets: worker groups + AGV meshes + forklift groups (recursive).
    const targets = [];
    for (const w of this._workers) targets.push(w.mesh);
    for (const a of this._agvs) targets.push(a.mesh);
    for (const f of this._forklifts) targets.push(f.group);
    if (!targets.length) return null;
    const hits = s.raycaster.intersectObjects(targets, true);
    for (const h of hits) {
      // Walk up from the hit child to the object tagged with the agent record.
      let o = h.object;
      while (o) {
        if (o.userData && o.userData.agentRef) return o.userData.agentRef;
        o = o.parent;
      }
    }
    return null;
  },

  // Make `ref` the selected agent: show the ring, reveal the tooltip.
  _selectAgent(ref) {
    const s = this._sel;
    if (!s) return;
    s.ref = ref;
    s.ring.visible = true;
    s.tip.style.display = 'block';
    this._refreshSelTip();
  },

  // Clear the selection: hide the ring + tooltip and drop follow.
  _deselect() {
    const s = this._sel;
    if (!s) return;
    s.ref = null;
    s.follow = false;
    s.ring.visible = false;
    s.tip.style.display = 'none';
  },

  // Role label for a selected agent record.
  _selRole(ref) {
    if (ref.kind === 'agv') return 'AGV';
    if (ref.kind === 'forklift') return 'フォークリフト';
    return 'ピッカー（人）';
  },

  // Refresh the static parts of the tooltip (role + follow hint). The state/pos
  // lines are refreshed every frame in _updateSelection.
  _refreshSelTip() {
    const s = this._sel;
    if (!s || !s.ref) return;
    const n = (s.ref.idx != null ? s.ref.idx + 1 : '');
    s.tipRole.textContent = this._selRole(s.ref) + (n !== '' ? ' #' + n : '');
    s.tip.style.borderColor = s.follow ? 'rgba(0,212,240,0.85)' : 'rgba(0,184,212,0.45)';
  },

  // Per-frame: track the ring under the selected agent, project its world
  // position to screen for the tooltip, refresh the state/pos readout, and
  // gently ease the orbit target toward it when follow is on.
  _updateSelection(t, dt) {
    const s = this._sel;
    if (!s || !s.ref) return;
    const ref = s.ref;
    const obj = ref.mesh || ref.group;
    if (!obj) return;
    const px = obj.position.x, pz = obj.position.z;
    // Ring tracks the floor anchor.
    s.ring.position.set(px, 0.03, pz);
    // Gentle pulse so the marker reads as "live" without being gaudy.
    const pulse = 1 + 0.06 * Math.sin(this._clock.elapsedTime * 4);
    s.ring.scale.set(pulse, pulse, 1);

    // State/pos readout from the same keyframe sampler the per-frame updates use.
    const sample = sampleKeyframes(ref.keyframes, t);
    const label = SEL_STATE_LABEL[sample.state] || sample.state || '–';
    s.tipState.textContent = '状態: ' + label;
    s.tipPos.textContent = `位置: ${px.toFixed(1)}, ${pz.toFixed(1)} m`;

    // Project the agent's head-height world position to screen pixels.
    s.proj.set(px, 1.6, pz).project(this.camera);
    const rect = this.renderer.domElement;
    const w = rect.clientWidth, h = rect.clientHeight;
    const sx = (s.proj.x * 0.5 + 0.5) * w;
    const sy = (-s.proj.y * 0.5 + 0.5) * h;
    // Hide the card when the agent is behind the camera (z>1) or off-canvas.
    const onScreen = s.proj.z < 1 && sx >= -40 && sx <= w + 40 && sy >= -40 && sy <= h + 40;
    s.tip.style.display = onScreen ? 'block' : 'none';
    if (onScreen) { s.tip.style.left = sx + 'px'; s.tip.style.top = sy + 'px'; }

    // Soft follow-camera: ease controls.target toward the agent without snapping,
    // so OrbitControls stays fully usable (the user can still drag/zoom freely).
    if (s.follow && this.controls) {
      const k = 1 - Math.exp(-(dt > 0 ? dt : 0.016) * 2.0);
      this.controls.target.x += (px - this.controls.target.x) * k;
      this.controls.target.z += (pz - this.controls.target.z) * k;
    }
  },

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
  },

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
  },

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
  },

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
  },

  _cancelIntro() {
    if (!this._intro) return;
    // Snap to the intended final framing and re-enable controls.
    this.camera.position.copy(this._intro.to);
    this._intro = null;
    if (this.controls) this.controls.enabled = true;
  },

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
  },
};
