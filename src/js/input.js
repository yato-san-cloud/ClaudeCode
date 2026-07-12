/*
 * input.js — Game.Input: pointer + touch + keyboard on the world canvas.
 *
 * Responsibilities
 *  - Drag to pan (Render.panBy), wheel & pinch to zoom (Render.zoomAt anchored at
 *    cursor / pinch midpoint), two-finger pan.
 *  - Tap-vs-drag disambiguation via a movement threshold; press-hold detection.
 *  - Placement TOOLS (build / plant / buyAnimal / decorate): register/set/clear,
 *    draw a ghost (Render pulls tool.ghost), route taps to onTileClick/onEntityClick,
 *    hover feedback via onTileEnter. Right-click cancels or rotates the active tool.
 *  - Default INSPECT mode: a light tap PETs an animal (juicy), a press-hold opens its
 *    inspector; buildings open their inspector; ready crops get harvested.
 *  - Keyboard: WASD/arrows pan, +/- (=/-) zoom, space toggles pause, 1/2/3 speed,
 *    Esc cancels tool / closes panel, m mutes.
 *
 * Everything is guarded; a handler never throws out to the browser. All cross-module
 * references (Render/Animals/World/Crops/UI/Audio) happen inside functions and are
 * null-guarded, per the integration rules.
 */
Game.Input = (function () {
  'use strict';
  var U = Game.Util;
  var bus = Game.bus;
  var K = Game.DATA.const;
  var TILE = K.TILE;

  // ---- tuning (interaction feel, not gameplay balance) ----
  var DRAG_THRESHOLD = 6;      // CSS px of movement before a press becomes a pan
  var TAP_MAX_MS = 500;        // max press duration still counted as a tap
  var HOLD_MS = 420;           // press-hold duration to open an inspector
  var HOLD_MOVE_TOL = 8;       // px of wobble tolerated during a hold
  var WHEEL_ZOOM_K = 0.0016;   // wheel delta -> zoom factor exponent
  var KEY_ZOOM_STEP = 1.14;    // per keypress zoom factor
  var KEY_PAN_STEP = 64;       // CSS px panned per pan-key press

  // ---- module-local transient state (never persisted) ----
  var canvas = null;
  var _unsubs = [];
  var _listeners = [];         // {el,type,fn,opts} for teardown
  var _tools = Object.create(null);
  var _activeTool = null;      // tool def object, or null for INSPECT
  var _hover = null;           // {tx,ty} last hovered tile
  var _lastHoverKey = '';      // "tx,ty" to fire onTileEnter only on change

  // pointer bookkeeping (Pointer Events unify mouse/touch/pen)
  var _pointers = Object.create(null); // id -> rec
  var _pointerCount = 0;
  var _primaryId = null;       // pointer driving tap/drag
  var _dragging = false;       // primary pointer passed the drag threshold
  var _pinch = null;           // {dist, mx, my} last pinch sample
  var _holdTimer = 0;
  var _holdFired = false;
  var _suppressTap = false;    // set by pinch / multi-touch so lift doesn't tap

  // ---------- small guarded accessors to sibling modules ----------
  function R() { return Game.Render || null; }
  function state() { return Game.state || null; }

  function screenOf(e) {
    // CSS-pixel coordinates relative to the canvas top-left (matches Render's space)
    var r;
    try { r = canvas.getBoundingClientRect(); }
    catch (_e) { r = { left: 0, top: 0 }; }
    return { sx: (e.clientX || 0) - r.left, sy: (e.clientY || 0) - r.top };
  }
  function tileAtScreen(sx, sy) {
    var r = R();
    if (r && r.screenToTile) { try { return r.screenToTile(sx, sy); } catch (_e) { } }
    return null;
  }

  // =====================================================================
  //  TOOLS (placement modes)
  // =====================================================================
  function registerTool(def) {
    try {
      if (!def || def.id == null) return;
      _tools[def.id] = def;
    } catch (e) { Game._recordError('Input.registerTool', e); }
  }

  function setTool(id, payload) {
    try {
      var def = _tools[id];
      if (!def) { clearTool(); return; }
      if (_activeTool && _activeTool !== def && typeof _activeTool.onExit === 'function') {
        try { _activeTool.onExit(); } catch (e) { Game._recordError('tool.onExit', e); }
      }
      _activeTool = def;
      def.payload = (payload != null) ? payload : def.payload;
      applyCursor(def.cursor || 'crosshair');
      _lastHoverKey = ''; // force a fresh onTileEnter on next hover
      var UI = Game.UI;
      if (UI && UI.setPlacementBanner) {
        try { UI.setPlacementBanner(def.banner || def.label || null); } catch (e) { }
      }
      // seed onTileEnter for wherever the cursor already is
      if (_hover) fireTileEnter(_hover.tx, _hover.ty);
      bus.emit('tool:change', { tool: def.id, def: def, payload: def.payload });
    } catch (e) { Game._recordError('Input.setTool', e); }
  }

  function clearTool() {
    try {
      var prev = _activeTool;
      if (prev && typeof prev.onExit === 'function') {
        try { prev.onExit(); } catch (e) { Game._recordError('tool.onExit', e); }
      }
      _activeTool = null;
      applyCursor('grab');
      var UI = Game.UI;
      if (UI && UI.setPlacementBanner) { try { UI.setPlacementBanner(null); } catch (e) { } }
      if (prev) bus.emit('tool:change', { tool: 'inspect', def: null });
    } catch (e) { Game._recordError('Input.clearTool', e); }
  }

  // Render pulls the active tool object (it looks for tool.ghost). null => INSPECT.
  function getTool() { return _activeTool; }
  function getToolId() { return _activeTool ? _activeTool.id : 'inspect'; }

  function applyCursor(c) {
    try { if (canvas) canvas.style.cursor = c || 'default'; } catch (e) { }
  }

  function fireTileEnter(tx, ty) {
    var key = tx + ',' + ty;
    if (key === _lastHoverKey) return;
    _lastHoverKey = key;
    if (_activeTool && typeof _activeTool.onTileEnter === 'function') {
      try { _activeTool.onTileEnter(tx, ty); } catch (e) { Game._recordError('tool.onTileEnter', e); }
    }
  }

  // =====================================================================
  //  PICKING
  // =====================================================================
  // Nearest animal to a screen point (uses interpolated world x,y so wandering
  // critters stay tappable), falling back to the exact-tile lookup.
  function pickAnimal(sx, sy, tx, ty) {
    var s = state(), r = R();
    var best = null, bestD = Infinity;
    if (s && s.animals && r && r.worldToScreen) {
      var reach = (TILE * 0.62) * ((s.camera && s.camera.zoom) || 1);
      var reach2 = reach * reach;
      for (var i = 0; i < s.animals.length; i++) {
        var a = s.animals[i];
        var wx = (a.x != null) ? a.x : (a.tx + 0.5) * TILE;
        var wy = (a.y != null) ? a.y : (a.ty + 0.5) * TILE;
        var p;
        try { p = r.worldToScreen(wx, wy); } catch (_e) { p = null; }
        if (!p) continue;
        var dx = p.sx - sx, dy = p.sy - sy, d2 = dx * dx + dy * dy;
        if (d2 < bestD && d2 <= reach2) { bestD = d2; best = a; }
      }
    }
    if (best) return best;
    // exact-tile fallback via the public API
    var An = Game.Animals;
    if (An && An.at && tx != null) { try { return An.at(tx, ty) || null; } catch (_e) { } }
    return null;
  }

  function pickAt(sx, sy) {
    var tile = tileAtScreen(sx, sy);
    var tx = tile ? tile.tx : 0, ty = tile ? tile.ty : 0;
    try {
      var a = pickAnimal(sx, sy, tx, ty);
      if (a) return { kind: 'animal', id: a.id, tx: a.tx, ty: a.ty };
      var Cr = Game.Crops;
      if (Cr && Cr.cropAt) { var c = Cr.cropAt(tx, ty); if (c) return { kind: 'crop', id: c.id, tx: tx, ty: ty }; }
      var W = Game.World;
      if (W && W.buildingAt) { var b = W.buildingAt(tx, ty); if (b) return { kind: 'building', id: b.id, tx: tx, ty: ty }; }
    } catch (e) { Game._recordError('Input.pickAt', e); }
    return { kind: 'tile', tx: tx, ty: ty };
  }

  function hoverTile() { return _hover; }

  // =====================================================================
  //  TAP RESOLUTION
  // =====================================================================
  function worldCenterOfTile(tx, ty) { return { wx: (tx + 0.5) * TILE, wy: (ty + 0.5) * TILE }; }

  function doTap(sx, sy, button) {
    var tile = tileAtScreen(sx, sy);
    if (!tile) return;
    var tx = tile.tx, ty = tile.ty;

    // ---- active placement tool: route the click ----
    if (_activeTool) {
      var pick = pickAt(sx, sy);
      if (pick.kind !== 'tile' && typeof _activeTool.onEntityClick === 'function') {
        try { _activeTool.onEntityClick(pick.kind, pick.id, tx, ty, button); }
        catch (e) { Game._recordError('tool.onEntityClick', e); }
        return;
      }
      if (typeof _activeTool.onTileClick === 'function') {
        try { _activeTool.onTileClick(tx, ty, button); }
        catch (e) { Game._recordError('tool.onTileClick', e); }
      }
      return;
    }

    // ---- INSPECT (default): pet / harvest / open inspector ----
    var p = pickAt(sx, sy);
    if (p.kind === 'animal') {
      petAnimal(p.id);
      bus.emit('entity:select', { kind: 'animal', id: p.id });
      return;
    }
    if (p.kind === 'crop') {
      var Cr = Game.Crops;
      var ready = false;
      try { ready = !!(Cr && Cr.isReady && Cr.isReady(p.id)); } catch (_e) { }
      if (ready && Cr && Cr.harvest) {
        try {
          var res = Cr.harvest(tx, ty);
          if (res && res.ok) {
            var wc = worldCenterOfTile(tx, ty);
            bus.emit('fx:sparkle', { x: wc.wx, y: wc.wy - 6 });
          }
        } catch (e) { Game._recordError('Input.harvest', e); }
      }
      bus.emit('entity:select', { kind: 'crop', id: p.id });
      return;
    }
    if (p.kind === 'building') {
      openInspector('building', p.id);
      bus.emit('entity:select', { kind: 'building', id: p.id });
      return;
    }
    // empty tile: deselect
    bus.emit('entity:select', { kind: 'tile', id: null, tx: tx, ty: ty });
  }

  function petAnimal(id) {
    var An = Game.Animals;
    var a = (An && An.get) ? (function () { try { return An.get(id); } catch (_e) { return null; } })() : null;
    if (An && An.pet) { try { An.pet(id); } catch (e) { Game._recordError('Input.pet', e); } }
    if (a) {
      var wx = (a.x != null) ? a.x : (a.tx + 0.5) * TILE;
      var wy = (a.y != null) ? a.y : (a.ty + 0.5) * TILE;
      bus.emit('fx:heart', { x: wx, y: wy - 14 });
    }
  }

  function openInspector(kind, id) {
    var UI = Game.UI;
    if (UI && UI.openInspector) { try { UI.openInspector(kind, id); } catch (e) { Game._recordError('Input.openInspector', e); } }
  }

  // Press-hold on an animal opens its inspector (light tap already pets).
  function doHold(sx, sy) {
    if (_activeTool) return; // tools don't use hold
    var p = pickAt(sx, sy);
    if (p.kind === 'animal') { openInspector('animal', p.id); bus.emit('entity:select', { kind: 'animal', id: p.id }); }
    else if (p.kind === 'building') { openInspector('building', p.id); bus.emit('entity:select', { kind: 'building', id: p.id }); }
  }

  // =====================================================================
  //  POINTER HANDLERS
  // =====================================================================
  function onPointerDown(e) {
    try {
      var pos = screenOf(e);
      var rec = { id: e.pointerId, x: pos.sx, y: pos.sy, sx0: pos.sx, sy0: pos.sy, t0: now(), button: e.button || 0, moved: false };
      if (!_pointers[e.pointerId]) _pointerCount++;
      _pointers[e.pointerId] = rec;
      try { if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId); } catch (_e) { }

      if (_pointerCount >= 2) {
        // entering pinch: cancel any pending tap/hold
        _suppressTap = true;
        cancelHold();
        _pinch = pinchSample();
        _dragging = false;
        return;
      }

      // single pointer: candidate for tap / drag / hold
      _primaryId = e.pointerId;
      _dragging = false;
      _holdFired = false;
      _suppressTap = false;
      applyCursor(_activeTool ? (_activeTool.cursor || 'crosshair') : 'grabbing');

      // right / middle button: no hold, no pan-drag (handled on up/contextmenu)
      if ((e.button || 0) === 0) {
        cancelHold();
        _holdTimer = setTimeoutSafe(function () {
          var r = _pointers[_primaryId];
          if (!r || r.moved) return;
          _holdFired = true;
          doHold(r.x, r.y);
        }, HOLD_MS);
      }
    } catch (err) { Game._recordError('Input.pointerdown', err); }
  }

  function onPointerMove(e) {
    try {
      var pos = screenOf(e);
      var rec = _pointers[e.pointerId];
      // hover tracking (mouse / pen) even without a button down
      updateHover(pos.sx, pos.sy);

      if (rec) { rec.x = pos.sx; rec.y = pos.sy; }

      if (_pointerCount >= 2) {
        handlePinch();
        return;
      }
      if (!rec || e.pointerId !== _primaryId) return;

      var dx = pos.sx - rec.sx0, dy = pos.sy - rec.sy0;
      if (!rec.moved && (dx * dx + dy * dy) > DRAG_THRESHOLD * DRAG_THRESHOLD) {
        rec.moved = true;
        _dragging = true;
        cancelHold();
      }
      if (_dragging) {
        // grab-and-drag pan: content follows the finger
        var mvx = pos.sx - (rec.lastX != null ? rec.lastX : rec.sx0);
        var mvy = pos.sy - (rec.lastY != null ? rec.lastY : rec.sy0);
        var r = R();
        if (r && r.panBy) { try { r.panBy(mvx, mvy); } catch (_e) { } }
      } else if (!_holdFired && (dx * dx + dy * dy) > HOLD_MOVE_TOL * HOLD_MOVE_TOL) {
        cancelHold();
      }
      rec.lastX = pos.sx; rec.lastY = pos.sy;
    } catch (err) { Game._recordError('Input.pointermove', err); }
  }

  function onPointerUp(e) {
    try {
      var rec = _pointers[e.pointerId];
      try { if (canvas.releasePointerCapture) canvas.releasePointerCapture(e.pointerId); } catch (_e) { }
      if (_pointers[e.pointerId]) { delete _pointers[e.pointerId]; _pointerCount = Math.max(0, _pointerCount - 1); }

      if (_pointerCount >= 2) { _pinch = pinchSample(); return; }
      if (_pointerCount === 1) {
        // dropped from pinch back to a single finger: re-anchor, keep suppressing tap
        _pinch = null;
        var remaining = firstPointer();
        if (remaining) { remaining.moved = true; remaining.lastX = remaining.x; remaining.lastY = remaining.y; _primaryId = remaining.id; }
        _dragging = false;
        _suppressTap = true;
        return;
      }

      // last finger up
      cancelHold();
      applyCursor(_activeTool ? (_activeTool.cursor || 'crosshair') : 'grab');
      _dragging = false;
      var wasPinch = _suppressTap; _suppressTap = false;
      _pinch = null;
      if (!rec) { _primaryId = null; return; }

      var dt = now() - rec.t0;
      var isTap = !rec.moved && !wasPinch && !_holdFired && dt <= TAP_MAX_MS;
      _primaryId = null;
      if (!isTap) return;

      var button = rec.button || 0;
      if (button === 2) { onRightAction(rec.x, rec.y); return; }  // right-tap (rare on touch)
      doTap(rec.x, rec.y, button);
    } catch (err) { Game._recordError('Input.pointerup', err); }
  }

  function onPointerCancel(e) {
    try {
      if (_pointers[e.pointerId]) { delete _pointers[e.pointerId]; _pointerCount = Math.max(0, _pointerCount - 1); }
      cancelHold();
      if (_pointerCount < 2) _pinch = null;
      if (_pointerCount === 0) { _dragging = false; _primaryId = null; _suppressTap = false; applyCursor(_activeTool ? (_activeTool.cursor || 'crosshair') : 'grab'); }
    } catch (err) { Game._recordError('Input.pointercancel', err); }
  }

  // ---- pinch helpers ----
  function firstPointer() { for (var k in _pointers) { if (_pointers[k]) return _pointers[k]; } return null; }
  function twoPointers() {
    var out = [];
    for (var k in _pointers) { if (_pointers[k]) { out.push(_pointers[k]); if (out.length === 2) break; } }
    return out.length === 2 ? out : null;
  }
  function pinchSample() {
    var pr = twoPointers();
    if (!pr) return null;
    var dx = pr[0].x - pr[1].x, dy = pr[0].y - pr[1].y;
    return { dist: Math.sqrt(dx * dx + dy * dy) || 0.0001, mx: (pr[0].x + pr[1].x) / 2, my: (pr[0].y + pr[1].y) / 2 };
  }
  function handlePinch() {
    var cur = pinchSample();
    if (!cur || !_pinch) { _pinch = cur; return; }
    var r = R();
    if (r) {
      var factor = cur.dist / _pinch.dist;
      if (isFinite(factor) && factor > 0 && Math.abs(factor - 1) > 0.001 && r.zoomAt) {
        try { r.zoomAt(cur.mx, cur.my, factor); } catch (_e) { }
      }
      // two-finger drag = pan by midpoint movement
      if (r.panBy) {
        var mvx = cur.mx - _pinch.mx, mvy = cur.my - _pinch.my;
        if (mvx || mvy) { try { r.panBy(mvx, mvy); } catch (_e) { } }
      }
    }
    _pinch = cur;
  }

  function updateHover(sx, sy) {
    var tile = tileAtScreen(sx, sy);
    if (!tile) { _hover = null; return; }
    _hover = { tx: tile.tx, ty: tile.ty };
    fireTileEnter(tile.tx, tile.ty);
  }

  // =====================================================================
  //  WHEEL / RIGHT-CLICK
  // =====================================================================
  function onWheel(e) {
    try {
      if (e.preventDefault) e.preventDefault();
      var pos = screenOf(e);
      var delta = e.deltaY || 0;
      if (e.deltaMode === 1) delta *= 16;       // lines -> approx px
      else if (e.deltaMode === 2) delta *= 400;  // pages -> approx px
      var factor = Math.exp(-delta * WHEEL_ZOOM_K);
      var r = R();
      if (r && r.zoomAt) r.zoomAt(pos.sx, pos.sy, factor);
    } catch (err) { Game._recordError('Input.wheel', err); }
  }

  function onContextMenu(e) {
    // never show the browser menu on the world; right-click is a game gesture
    try { if (e.preventDefault) e.preventDefault(); } catch (_e) { }
    try {
      var pos = screenOf(e);
      onRightAction(pos.sx, pos.sy);
    } catch (err) { Game._recordError('Input.contextmenu', err); }
    return false;
  }

  // Right-click: rotate the active tool if it supports it, otherwise cancel it.
  function onRightAction(sx, sy) {
    if (_activeTool) {
      if (typeof _activeTool.rotate === 'function') {
        try { _activeTool.rotate(); } catch (e) { Game._recordError('tool.rotate', e); }
        if (_hover) { _lastHoverKey = ''; fireTileEnter(_hover.tx, _hover.ty); }
      } else if (typeof _activeTool.onRightClick === 'function') {
        var t = tileAtScreen(sx, sy) || { tx: 0, ty: 0 };
        try { _activeTool.onRightClick(t.tx, t.ty); } catch (e) { Game._recordError('tool.onRightClick', e); }
      } else {
        clearTool();
      }
    }
  }

  // =====================================================================
  //  KEYBOARD
  // =====================================================================
  function isTextTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function onKeyDown(e) {
    try {
      if (isTextTarget(e.target)) return;
      var k = e.key;
      var code = e.code;
      var r = R();
      var handled = true;

      switch (code) {
        case 'ArrowLeft': case 'KeyA': if (r && r.panBy) r.panBy(KEY_PAN_STEP, 0); break;
        case 'ArrowRight': case 'KeyD': if (r && r.panBy) r.panBy(-KEY_PAN_STEP, 0); break;
        case 'ArrowUp': case 'KeyW': if (r && r.panBy) r.panBy(0, KEY_PAN_STEP); break;
        case 'ArrowDown': case 'KeyS': if (r && r.panBy) r.panBy(0, -KEY_PAN_STEP); break;
        case 'Space': if (Game.togglePause) Game.togglePause(); break;
        case 'Escape': onEscape(); break;
        case 'Digit1': case 'Numpad1': if (Game.setSpeed) Game.setSpeed(1); break;
        case 'Digit2': case 'Numpad2': if (Game.setSpeed) Game.setSpeed(2); break;
        case 'Digit3': case 'Numpad3': if (Game.setSpeed) Game.setSpeed(3); break;
        case 'KeyM': toggleMute(); break;
        default: handled = false;
      }

      if (!handled) {
        // zoom keys vary by keyboard layout; match on the produced character
        if (k === '+' || k === '=') { zoomCenter(KEY_ZOOM_STEP); handled = true; }
        else if (k === '-' || k === '_') { zoomCenter(1 / KEY_ZOOM_STEP); handled = true; }
      }

      if (handled && e.preventDefault) e.preventDefault();
    } catch (err) { Game._recordError('Input.keydown', err); }
  }

  function zoomCenter(factor) {
    var r = R();
    if (r && r.zoomAt) { try { r.zoomAt(null, null, factor); } catch (_e) { } }
  }

  function onEscape() {
    if (_activeTool) { clearTool(); return; }
    var UI = Game.UI;
    if (UI) {
      if (UI.closeTopPanel) { try { UI.closeTopPanel(); return; } catch (_e) { } }
      if (UI.closeInspector) { try { UI.closeInspector(); } catch (_e) { } }
    }
    bus.emit('input:cancel', {});
  }

  function toggleMute() {
    var s = state();
    var muted = s && s.settings ? !s.settings.muted : true;
    if (s && s.settings) s.settings.muted = muted;
    var A = Game.Audio;
    if (A && A.setMuted) { try { A.setMuted(muted); } catch (_e) { } }
    bus.emit('notify', { text: muted ? 'ミュート' : 'ミュート解除', icon: muted ? '🔇' : '🔊', kind: 'info', ttl: 1200 });
  }

  // ---------- tiny helpers ----------
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function setTimeoutSafe(fn, ms) { try { return setTimeout(fn, ms); } catch (_e) { return 0; } }
  function cancelHold() { if (_holdTimer) { try { clearTimeout(_holdTimer); } catch (_e) { } _holdTimer = 0; } }

  function addL(el, type, fn, opts) {
    if (!el || !el.addEventListener) return;
    try { el.addEventListener(type, fn, opts); _listeners.push({ el: el, type: type, fn: fn, opts: opts }); }
    catch (_e) { }
  }

  function resetTransient() {
    cancelHold();
    _pointers = Object.create(null);
    _pointerCount = 0; _primaryId = null; _dragging = false; _pinch = null;
    _holdFired = false; _suppressTap = false; _hover = null; _lastHoverKey = '';
  }

  // =====================================================================
  //  INIT
  // =====================================================================
  function init(ctx) {
    try {
      canvas = (ctx && ctx.canvas) || (typeof document !== 'undefined' ? document.getElementById('world') : null);
      if (!canvas) { Game._recordError('Input.init', new Error('no canvas')); return; }

      // touch-friendly: we own all gestures on the canvas
      try {
        canvas.style.touchAction = 'none';
        canvas.style.cursor = 'grab';
        if (canvas.setAttribute) canvas.setAttribute('tabindex', '0');
      } catch (_e) { }

      var supportsPointer = (typeof window !== 'undefined') && ('PointerEvent' in window);
      if (supportsPointer) {
        addL(canvas, 'pointerdown', onPointerDown, { passive: true });
        addL(window, 'pointermove', onPointerMove, { passive: true });
        addL(window, 'pointerup', onPointerUp, { passive: true });
        addL(window, 'pointercancel', onPointerCancel, { passive: true });
      } else {
        // legacy mouse fallback (very old browsers) — pointer events cover all modern ones
        addL(canvas, 'mousedown', function (e) { e.pointerId = 1; e.isPrimary = true; onPointerDown(e); }, { passive: true });
        addL(window, 'mousemove', function (e) { e.pointerId = 1; onPointerMove(e); }, { passive: true });
        addL(window, 'mouseup', function (e) { e.pointerId = 1; onPointerUp(e); }, { passive: true });
      }

      addL(canvas, 'wheel', onWheel, { passive: false });
      addL(canvas, 'contextmenu', onContextMenu, { passive: false });
      addL(window, 'keydown', onKeyDown, { passive: false });

      // world swapped (load / new game): drop transient state & any active tool
      _unsubs.push(bus.on('state:replaced', function () { resetTransient(); clearTool(); }));
      // if paused/resumed elsewhere, nothing to do; cursor stays valid

      resetTransient();
    } catch (e) { Game._recordError('Input.init', e); }
  }

  function destroy() {
    try {
      for (var i = 0; i < _listeners.length; i++) {
        var L = _listeners[i];
        try { L.el.removeEventListener(L.type, L.fn, L.opts); } catch (_e) { }
      }
      _listeners = [];
      for (var j = 0; j < _unsubs.length; j++) { try { _unsubs[j](); } catch (_e) { } }
      _unsubs = [];
      resetTransient();
    } catch (e) { Game._recordError('Input.destroy', e); }
  }

  return {
    init: init,
    destroy: destroy,
    registerTool: registerTool,
    setTool: setTool,
    getTool: getTool,
    getToolId: getToolId,
    clearTool: clearTool,
    pickAt: pickAt,
    hoverTile: hoverTile
  };
})();
