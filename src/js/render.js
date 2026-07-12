/*
 * render.js — Game.Render: camera + layered Canvas2D draw + particle juice.
 *
 * Owns: state.camera {x,y,zoom} (world-unit top-left focus) and a transient,
 * NON-persisted particle pool + screen-shake + float-text.
 *
 * Contract highlights (see architecture §5, art-bible §9/§12):
 *   - World is drawn under a camera transform so Sprites.* receive WORLD-unit
 *     coordinates at a fixed 48px/tile scale (they never need to know the zoom).
 *   - Sky, weather, day-night light, air particles + float text are drawn in
 *     SCREEN space (crisp, zoom-independent).
 *   - All heavy sim lives elsewhere; Render only reads state and never mutates it.
 *   - Cross-module refs (Sprites/World/Animals/Crops/Time/Input) are resolved
 *     INSIDE functions and null-guarded — peers may not exist at eval time.
 *
 * Cosmetic randomness uses a module-local LCG (crand) or Util.hash01 so it never
 * perturbs the seeded sim RNG stream (Game.Util.rng), per the golden rules.
 */
Game.Render = (function () {
  'use strict';

  var U = Game.Util;
  var K = Game.DATA.const;
  var TILE = K.TILE;

  // ---- palette (local copy of art-bible §14 so we never depend on load order) ----
  var PAL = {
    sky: {
      dawn:  { top: '#8FA9D8', mid: '#F3B7C0', low: '#FDE9C8' },
      day:   { top: '#6FC3EE', mid: '#A5DEF5', low: '#DCF4FB' },
      dusk:  { top: '#5B4E8C', mid: '#EF9A7A', low: '#FBD79E' },
      night: { top: '#172443', mid: '#283A6B', low: '#46568F' }
    },
    grass: { light: '#B6E870', base: '#93D95C', mid: '#6EBB45', dark: '#4F9A37', blade: '#57A83A' },
    soil:  { light: '#CBA074', base: '#A9744A', dark: '#7E5230', till: '#8A5A38' },
    water: { light: '#9FD9E8', base: '#6FBDD6', dark: '#4E9CBB' },
    path:  { light: '#E5D3AE', base: '#D8BE90', dark: '#B79A6A' },
    wood:  { light: '#DBA772', base: '#B77F4E', dark: '#8A5A34' },
    roof:  { red: '#E27A5F', redDark: '#C15A44', blue: '#7FB4D6', blueDark: '#5E93B6' },
    ui:    { cream: '#FFF6E3', panel: '#FFFBF0', border: '#E7C596', text: '#6B4A2F', shadow: '#3A2A1A' },
    accent:{ pink: '#FF9CC2', pinkDeep: '#FF6FA5', pinkLight: '#FFD1E3', mint: '#85E0BE',
             mintDeep: '#4FC79C', yellow: '#FFD84D', sky: '#8FD6F2', lav: '#C9B6F2' },
    status:{ alert: '#FF6B6B', amber: '#FFB454', good: '#7ED957' },
    light: { night: '#101C3A', lamp: '#FFE7A8', moon: '#FDF6E3', star: '#FFFDF0', sun: '#FFF3B0' },
    wx:    { cloud: '#FFFFFF', cloudShade: '#DCE6EE', rain: '#A9D8EC', fog: '#EAF2F4', snow: '#FFFFFF' },
    season:{ spring: '#A9EE6B', summer: '#74C63F', autumn: '#CDA64C', winter: '#DDEBE4' },
    foliage:{ spring: '#FFC7DD', summer: '#FFE27A', autumn: '#E8894B', winter: '#FFFFFF' }
  };

  // Per-season world recolor applied over terrain so each season reads at a glance.
  // {color, mode, alpha} with an optional second pass {color2, mode2, alpha2}.
  var SEASON_FX = {
    spring: { color: '#CBF3A2', mode: 'overlay', alpha: 0.13 },
    summer: { color: '#83CE44', mode: 'multiply', alpha: 0.12 },
    autumn: { color: '#D98F2E', mode: 'multiply', alpha: 0.30, mode2: 'screen', color2: '#F4CE6A', alpha2: 0.34 },
    winter: { color: '#E9F2F8', mode: 'screen', alpha: 0.42, mode2: 'overlay', color2: '#AED2E6', alpha2: 0.16 }
  };

  // Sky keyframes: [fraction-of-day, {top,mid,low}]. Interpolated per channel.
  var SKY_KEYS = [
    [0.00, PAL.sky.night], [0.15, PAL.sky.night], [0.22, PAL.sky.dawn],
    [0.30, PAL.sky.day],   [0.66, PAL.sky.day],   [0.74, PAL.sky.dusk],
    [0.82, PAL.sky.dusk],  [0.88, PAL.sky.night], [1.00, PAL.sky.night]
  ];

  // ---- module-local state (transient; canvas/context grabbed in init) ----
  var canvas = null, ctx = null;
  var dpr = 1, cssW = 960, cssH = 600;
  var _present = 0, _lastNow = 0;
  var _particles = [];          // pooled transient FX
  var _rain = null, _snow = null, _clouds = null, _motes = null; // weather buffers
  var _shake = { x: 0, y: 0, mag: 0, t: 0, dur: 180 };
  var _pops = {};               // buildingId -> spawn present-time (placement squish)
  var _selected = null;         // {kind,id}
  var _crngState = 0x9e3779b9;  // cosmetic LCG seed (never touches sim rng)
  var _unsubs = [];

  var MAX_PARTICLES = 250;

  // ---------- tiny cosmetic RNG (NOT the sim rng; render-only jitter) ----------
  function crand() {
    _crngState = (Math.imul(_crngState ^ (_crngState >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0;
    return ((_crngState >>> 0) % 100000) / 100000;
  }
  function crange(a, b) { return a + crand() * (b - a); }

  // ---------- color helpers ----------
  function hx(h) {
    h = h.charCodeAt(0) === 35 ? h.slice(1) : h;
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgba(rgb, a) { return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')'; }
  function mix(a, b, t) {
    var ca = hx(a), cb = hx(b);
    return 'rgb(' + Math.round(U.lerp(ca[0], cb[0], t)) + ',' + Math.round(U.lerp(ca[1], cb[1], t)) + ',' + Math.round(U.lerp(ca[2], cb[2], t)) + ')';
  }

  // ---------- context / camera helpers ----------
  function cam() {
    var s = Game.state;
    var c = (s && s.camera) || { x: 0, y: 0, zoom: 1 };
    if (!(c.zoom > 0)) c.zoom = 1;
    c.zoom = U.clamp(c.zoom, K.ZOOM_MIN, K.ZOOM_MAX);
    return c;
  }
  function reduceMotion() { var s = Game.state; return !!(s && s.settings && s.settings.reduceMotion); }
  function particlesOn() { var s = Game.state; return !s || !s.settings || s.settings.showParticles !== false; }

  function setScreenTransform() { if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
  function setWorldTransform() {
    if (!ctx) return;
    var c = cam(), z = c.zoom;
    ctx.setTransform(z * dpr, 0, 0, z * dpr, (-c.x * z + _shake.x) * dpr, (-c.y * z + _shake.y) * dpr);
  }

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // =====================================================================
  //  PUBLIC: coordinate transforms (screen<->world<->tile), CSS px screen
  // =====================================================================
  function worldToScreen(wx, wy) {
    var c = cam();
    return { sx: (wx - c.x) * c.zoom, sy: (wy - c.y) * c.zoom };
  }
  function screenToWorld(sx, sy) {
    var c = cam();
    return { wx: sx / c.zoom + c.x, wy: sy / c.zoom + c.y };
  }
  function screenToTile(sx, sy) {
    var w = screenToWorld(sx, sy);
    return { tx: Math.floor(w.wx / TILE), ty: Math.floor(w.wy / TILE) };
  }

  // =====================================================================
  //  PUBLIC: camera manipulation
  // =====================================================================
  function panBy(dxScreen, dyScreen) {
    var c = cam();
    c.x -= dxScreen / c.zoom;
    c.y -= dyScreen / c.zoom;
    clampCamera();
  }
  function zoomAt(sx, sy, factor) {
    var c = cam();
    if (sx == null) sx = cssW / 2;
    if (sy == null) sy = cssH / 2;
    var before = screenToWorld(sx, sy);
    c.zoom = U.clamp(c.zoom * factor, K.ZOOM_MIN, K.ZOOM_MAX);
    c.x = before.wx - sx / c.zoom;
    c.y = before.wy - sy / c.zoom;
    clampCamera();
  }
  function worldSize() {
    var s = Game.state, g = s && s.grid;
    return { w: (g ? g.w : K.WORLD_W) * TILE, h: (g ? g.h : K.WORLD_H) * TILE };
  }
  function clampCamera() {
    var c = cam(), ws = worldSize();
    var viewW = cssW / c.zoom, viewH = cssH / c.zoom;
    var M = 3 * TILE; // let a little apron of world show past the edge
    if (ws.w <= viewW) c.x = (ws.w - viewW) / 2;
    else c.x = U.clamp(c.x, -M, ws.w - viewW + M);
    if (ws.h <= viewH) c.y = (ws.h - viewH) / 2;
    else c.y = U.clamp(c.y, -M, ws.h - viewH + M);
  }
  function centerOn(tx, ty) {
    var c = cam();
    c.x = (tx + 0.5) * TILE - (cssW / c.zoom) / 2;
    c.y = (ty + 0.5) * TILE - (cssH / c.zoom) / 2;
    clampCamera();
  }
  function centerOnStart() {
    var s = Game.state; if (!s) return;
    var b = null, list = s.buildings || [];
    for (var i = 0; i < list.length; i++) { if (list[i].type === 'house') { b = list[i]; break; } }
    if (!b && list.length) b = list[0];
    if (b) centerOn(b.tx + (b.w || 2) / 2 - 0.5, b.ty + (b.h || 2) / 2 - 0.5);
    else centerOn(K.WORLD_W / 2, K.WORLD_H / 2);
  }

  // =====================================================================
  //  PUBLIC: sizing (DPR-aware backing store)
  // =====================================================================
  function resize() {
    try {
      dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
      dpr = U.clamp(dpr, 1, 3);
      if (canvas) {
        var w = canvas.clientWidth || canvas.width || 960;
        var h = canvas.clientHeight || canvas.height || 600;
        cssW = w; cssH = h;
        var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
        if (canvas.width !== bw) canvas.width = bw;
        if (canvas.height !== bh) canvas.height = bh;
      }
      buildWeatherBuffers();
      clampCamera();
    } catch (e) { Game._recordError('Render.resize', e); }
  }

  // =====================================================================
  //  PARTICLE POOL (transient, not persisted)
  // =====================================================================
  function push(p) {
    if (_particles.length >= MAX_PARTICLES) _particles.shift();
    _particles.push(p);
  }
  // kinds: heart, sparkle, coin, star, confetti, droplet, zzz, steam, float (air);
  //        dust, splash, ripple, leaf (ground)
  function spawnParticle(kind, wx, wy, opts) {
    if (!particlesOn() && kind !== 'float') return;
    opts = opts || {};
    var ground = (kind === 'dust' || kind === 'splash' || kind === 'ripple' || kind === 'leaf');
    var life = opts.life != null ? opts.life : (kind === 'coin' ? 620 : kind === 'confetti' ? 1400 : kind === 'ripple' ? 700 : 900);
    push({
      kind: kind, space: ground ? 'ground' : 'air',
      x: wx, y: wy,
      vx: opts.vx != null ? opts.vx : 0,
      vy: opts.vy != null ? opts.vy : 0,
      g: opts.g != null ? opts.g : 0,
      life: life, max: life,
      size: opts.size != null ? opts.size : 10,
      rot: opts.rot != null ? opts.rot : 0,
      vrot: opts.vrot != null ? opts.vrot : 0,
      color: opts.color || null,
      text: opts.text || null,
      delay: opts.delay || 0
    });
  }
  function emitFloatText(wx, wy, text, color) {
    push({
      kind: 'float', space: 'air', x: wx, y: wy,
      vx: 0, vy: -26, g: 0, life: 1100, max: 1100,
      size: 14, rot: 0, vrot: 0, color: color || PAL.accent.yellow, text: String(text), delay: 0
    });
  }
  function shake(mag) {
    if (reduceMotion()) return;
    mag = U.clamp(mag || 0, 0, 3);
    if (mag > _shake.mag * (1 - _shake.t / _shake.dur)) { _shake.mag = mag; _shake.t = 0; }
  }

  // ---- burst helpers ----
  function heartsBurst(wx, wy, n) {
    if (!particlesOn()) return;
    n = n || 4;
    for (var i = 0; i < n; i++) {
      spawnParticle('heart', wx + crange(-6, 6), wy - crange(0, 8), {
        vx: crange(-14, 14), vy: crange(-42, -26), g: 6, size: crange(11, 16),
        rot: crange(-0.3, 0.3), vrot: crange(-1, 1), color: crand() < 0.5 ? PAL.accent.pink : PAL.accent.pinkDeep,
        delay: i * 70, life: 1000
      });
    }
  }
  function sparkleBurst(wx, wy, n, color) {
    if (!particlesOn()) return;
    n = n || 5;
    for (var i = 0; i < n; i++) {
      spawnParticle('sparkle', wx + crange(-16, 16), wy + crange(-16, 16), {
        vx: crange(-8, 8), vy: crange(-20, -4), g: 4, size: crange(7, 13),
        vrot: crange(-2, 2), color: color || (crand() < 0.5 ? PAL.accent.yellow : PAL.light.star),
        delay: i * 45, life: 620
      });
    }
  }
  function coinBurst(wx, wy, n) {
    if (!particlesOn()) return;
    n = n || 4;
    for (var i = 0; i < n; i++) {
      spawnParticle('coin', wx + crange(-8, 8), wy, {
        vx: crange(-26, 26), vy: crange(-70, -46), g: 150, size: crange(9, 13),
        vrot: crange(-3, 3), delay: i * 55, life: 640
      });
    }
  }
  function confettiBurst(wx, wy, n) {
    if (!particlesOn()) return;
    n = n || 22;
    var cols = [PAL.accent.pink, PAL.accent.yellow, PAL.accent.mint, PAL.accent.sky, PAL.accent.lav, PAL.accent.pinkDeep];
    for (var i = 0; i < n; i++) {
      var mixk = crand();
      spawnParticle(mixk < 0.25 ? 'heart' : mixk < 0.5 ? 'sparkle' : 'confetti', wx + crange(-14, 14), wy + crange(-10, 10), {
        vx: crange(-70, 70), vy: crange(-150, -70), g: 190, size: crange(7, 13),
        rot: crange(0, 6.28), vrot: crange(-5, 5), color: cols[(crand() * cols.length) | 0], life: crange(1100, 1700)
      });
    }
  }
  function dustRing(wx, wy, r) {
    if (!particlesOn()) return;
    var n = 8;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * 6.283;
      spawnParticle('dust', wx, wy, {
        vx: Math.cos(a) * crange(30, 55), vy: Math.sin(a) * crange(14, 26) - 6, g: 10,
        size: crange(8, 14), color: PAL.soil.light, life: 420
      });
    }
  }

  // =====================================================================
  //  particle / shake integration
  // =====================================================================
  function updateShake(dt) {
    if (_shake.mag <= 0) { _shake.x = 0; _shake.y = 0; return; }
    _shake.t += dt;
    var p = U.clamp(_shake.t / _shake.dur, 0, 1);
    var amp = _shake.mag * (1 - U.ease.out(p));
    if (amp <= 0.02) { _shake.mag = 0; _shake.x = 0; _shake.y = 0; return; }
    var a = crand() * 6.283;
    _shake.x = Math.cos(a) * amp;
    _shake.y = Math.sin(a) * amp;
  }
  function updateParticles(dt) {
    var ds = dt / 1000;
    for (var i = _particles.length - 1; i >= 0; i--) {
      var p = _particles[i];
      if (p.delay > 0) { p.delay -= dt; continue; }
      p.life -= dt;
      if (p.life <= 0) { _particles.splice(i, 1); continue; }
      p.vy += p.g * ds;
      p.x += p.vx * ds;
      p.y += p.vy * ds;
      p.rot += p.vrot * ds;
    }
  }

  // =====================================================================
  //  WEATHER buffers + update
  // =====================================================================
  function buildWeatherBuffers() {
    var area = cssW * cssH;
    var cap = U.clamp((area / 9000) | 0, 40, 170);
    _rain = mkField(cap, function () { return { x: crange(-40, cssW + 40), y: crange(-cssH, cssH), v: crange(680, 900), len: crange(10, 18) }; });
    _snow = mkField((cap * 0.7) | 0, function () { return { x: crange(0, cssW), y: crange(-cssH, cssH), v: crange(40, 90), r: crange(1.5, 3.4), ph: crange(0, 6.28) }; });
    _clouds = mkField(5, function () { return { x: crange(-120, cssW), y: crange(0, cssH * 0.4), v: crange(6, 16), s: crange(90, 190) }; });
    _motes = mkField((cap * 0.45) | 0, function () { return { x: crange(0, cssW), y: crange(0, cssH), v: crange(6, 16), r: crange(1, 2.6), ph: crange(0, 6.28), drift: crange(-8, 8) }; });
  }
  function mkField(n, f) { var a = []; for (var i = 0; i < n; i++) a.push(f()); return a; }
  function weatherId() { var s = Game.state; return (s && s.weather) || 'sunny'; }

  function updateWeather(dt) {
    if (!particlesOn()) return;
    var ds = dt / 1000, w = weatherId();
    if (w === 'rainy' && _rain) {
      for (var i = 0; i < _rain.length; i++) {
        var d = _rain[i]; d.y += d.v * ds; d.x -= d.v * 0.28 * ds;
        if (d.y > cssH + 10) { d.y = crange(-30, -4); d.x = crange(-40, cssW + 40); }
      }
    } else if (w === 'snowy' && _snow) {
      for (var j = 0; j < _snow.length; j++) {
        var f = _snow[j]; f.ph += ds * 1.4; f.y += f.v * ds;
        f.x += Math.sin(f.ph) * 10 * ds;
        if (f.y > cssH + 6) { f.y = crange(-20, -2); f.x = crange(0, cssW); }
      }
    }
    if (_clouds && (w === 'cloudy' || w === 'rainy')) {
      for (var c = 0; c < _clouds.length; c++) {
        var cl = _clouds[c]; cl.x += cl.v * ds;
        if (cl.x > cssW + 200) cl.x = -cl.s - crange(20, 160);
      }
    }
    // ambient motes only on clear days
    if (_motes && w === 'sunny') {
      for (var m = 0; m < _motes.length; m++) {
        var mo = _motes[m]; mo.ph += ds; mo.y -= mo.v * ds; mo.x += Math.sin(mo.ph) * mo.drift * ds;
        if (mo.y < -6) { mo.y = cssH + crange(0, 40); mo.x = crange(0, cssW); }
      }
    }
  }

  // =====================================================================
  //  SPRITE dispatch (call peer Sprites.* if present, else cute fallback)
  // =====================================================================
  function SP() { return Game.Sprites; }

  function drawShadow(wx, wy, r) {
    ctx.save();
    ctx.globalAlpha = 0.20;
    ctx.fillStyle = PAL.ui.shadow;
    ctx.beginPath();
    ctx.ellipse(wx, wy, r, r * 0.42, 0, 0, 6.2832);
    ctx.fill();
    ctx.restore();
  }

  function drawTileSprite(terrain, wx, wy, variant) {
    var s = SP();
    if (s && typeof s.tile === 'function') { try { s.tile(ctx, terrain, wx, wy, TILE, variant); return; } catch (e) { Game._recordError('Sprites.tile', e); } }
    // fallback tile
    var base = PAL.grass.base, edge = PAL.grass.mid;
    if (terrain === 'water') { base = PAL.water.base; edge = PAL.water.dark; }
    else if (terrain === 'dirt') { base = PAL.soil.base; edge = PAL.soil.dark; }
    else if (terrain === 'path') { base = PAL.path.base; edge = PAL.path.dark; }
    var shade = (variant & 1) ? 0.05 : 0;
    ctx.fillStyle = shade ? mix(base, edge, 0.18) : base;
    ctx.fillRect(wx, wy, TILE + 1, TILE + 1);
    if (terrain === 'grass') {
      ctx.strokeStyle = rgba(hx(PAL.grass.blade), 0.5);
      ctx.lineWidth = 1.5;
      var bx = wx + (variant * 11 + 6) % (TILE - 8) + 4, by = wy + TILE - 4;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - 2, by - 7); ctx.moveTo(bx + 3, by); ctx.lineTo(bx + 4, by - 6); ctx.stroke();
    } else if (terrain === 'water') {
      ctx.fillStyle = rgba(hx(PAL.water.light), 0.5);
      var yy = wy + 10 + (Math.sin(_present * 0.002 + wx * 0.05) * 2);
      ctx.fillRect(wx + 6, yy, TILE - 14, 2);
    }
  }

  function drawBuildingSprite(b, lit, scale) {
    var wx = (b.tx + b.w / 2) * TILE, wy = (b.ty + b.h) * TILE; // feet center
    ctx.save();
    if (scale !== 1) { ctx.translate(wx, wy); ctx.scale(scale, scale); ctx.translate(-wx, -wy); }
    var s = SP();
    if (s && typeof s.building === 'function') {
      try { s.building(ctx, b.type, b.tx * TILE, b.ty * TILE, { level: b.level || 1, w: b.w, h: b.h, lit: lit, size: TILE }); ctx.restore(); return; }
      catch (e) { Game._recordError('Sprites.building', e); }
    }
    // fallback building
    var pw = b.w * TILE, ph = b.h * TILE, x = b.tx * TILE, y = b.ty * TILE;
    var bodyH = ph * 0.6, roofH = ph * 0.5;
    var isBlue = (b.type === 'dairy' || b.type === 'well' || b.type === 'market_stall');
    var roofC = isBlue ? PAL.roof.blue : PAL.roof.red;
    var roofD = isBlue ? PAL.roof.blueDark : PAL.roof.redDark;
    // body
    ctx.fillStyle = PAL.wood.base;
    roundRect(x + 4, y + ph - bodyH, pw - 8, bodyH - 2, 6); ctx.fill();
    ctx.fillStyle = rgba(hx(PAL.wood.dark), 0.35);
    ctx.fillRect(x + pw * 0.45, y + ph - bodyH, 2, bodyH - 4);
    // roof
    ctx.fillStyle = roofC;
    ctx.beginPath();
    ctx.moveTo(x + 1, y + ph - bodyH + 4);
    ctx.lineTo(x + pw / 2, y + ph - bodyH - roofH);
    ctx.lineTo(x + pw - 1, y + ph - bodyH + 4);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = rgba(hx(roofD), 0.5);
    ctx.fillRect(x + 2, y + ph - bodyH + 1, pw - 4, 4);
    // door / window
    ctx.fillStyle = lit ? PAL.light.lamp : mix(PAL.wood.dark, PAL.ui.text, 0.3);
    roundRect(x + pw / 2 - 7, y + ph - bodyH * 0.62, 14, bodyH * 0.55, 4); ctx.fill();
    ctx.restore();
  }

  function drawAnimalSprite(a) {
    var adult = a.adult !== false;
    var size = adult ? 40 : 26;
    // idle bob (breathe) + tiny walk hop; interpolation already in a.x,a.y
    var amp = reduceMotion() ? 1.4 : 3.2;
    var hop = a.ai ? a.ai.hopPhase || 0 : 0;
    var moving = a.ai && a.ai.mode === 'walk';
    var bob = Math.sin(_present * 0.005 + hop) * amp + (moving ? Math.abs(Math.sin(_present * 0.012 + hop)) * amp * 0.8 : 0);
    var wx = a.x, wy = a.y;
    var happy = (a.needs && a.needs.happiness) || 60;
    var mood = happy > 70 ? 'happy' : (happy < 35 ? 'sad' : 'neutral');
    var facing = (a.ai && a.ai.facing) || 1;
    // blink via cosmetic hash (does not disturb sim rng)
    var bt = _present * 0.001 + U.hash01(a.id, 11) * 9;
    var blink = ((bt % 4.2)) < 0.14;

    var s = SP();
    if (s && typeof s.animal === 'function') {
      try {
        // Sprites.animal treats `size` as a ~1.0 scale multiplier (U = 46*size*breed*baby)
        // and draws its own contact shadow + idle bob. Pass a multiplier, NOT pixels.
        s.animal(ctx, a.breed, wx, wy, { size: 0.98, facing: facing, hopPhase: hop, blink: blink, mood: mood, adult: adult });
        return;
      } catch (e) { Game._recordError('Sprites.animal', e); }
    }
    // fallback animal: chunky plush blob (render its own shadow + bob)
    drawShadow(wx, wy + size * 0.18, size * 0.42);
    ctx.save();
    ctx.translate(0, -bob);
    var col = a.species === 'cow' ? '#FFFDF6' : (a.breed === 'chicken' ? '#FFF3C4' : a.breed === 'pig' ? '#F5B7C4' : '#EAD9B4');
    var r = size * 0.5;
    ctx.save();
    ctx.translate(wx, wy - r * 0.7);
    ctx.scale(facing < 0 ? -1 : 1, 1);
    ctx.fillStyle = col;
    roundRect(-r, -r * 0.7, r * 2, r * 1.5, r * 0.7); ctx.fill();
    ctx.strokeStyle = rgba(hx(PAL.ui.shadow), 0.18); ctx.lineWidth = 1.5; ctx.stroke();
    // head
    ctx.beginPath(); ctx.arc(r * 0.55, -r * 0.55, r * 0.62, 0, 6.2832); ctx.fillStyle = col; ctx.fill(); ctx.stroke();
    // eyes
    ctx.fillStyle = '#2A2430';
    if (!blink) {
      ctx.beginPath(); ctx.arc(r * 0.42, -r * 0.62, r * 0.11, 0, 6.2832); ctx.arc(r * 0.78, -r * 0.62, r * 0.11, 0, 6.2832); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(r * 0.46, -r * 0.66, r * 0.04, 0, 6.2832); ctx.arc(r * 0.82, -r * 0.66, r * 0.04, 0, 6.2832); ctx.fill();
    } else {
      ctx.strokeStyle = '#2A2430'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(r * 0.33, -r * 0.6); ctx.lineTo(r * 0.51, -r * 0.6); ctx.moveTo(r * 0.69, -r * 0.6); ctx.lineTo(r * 0.87, -r * 0.6); ctx.stroke();
    }
    // blush + mouth
    ctx.fillStyle = rgba(hx(PAL.accent.pinkLight), 0.8);
    ctx.beginPath(); ctx.arc(r * 0.28, -r * 0.42, r * 0.1, 0, 6.2832); ctx.arc(r * 0.9, -r * 0.42, r * 0.1, 0, 6.2832); ctx.fill();
    if (mood === 'sad') { ctx.strokeStyle = '#6B4A2F'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(r * 0.6, -r * 0.32, r * 0.14, 3.6, 5.8); ctx.stroke(); }
    ctx.restore();
    ctx.restore();
  }

  function drawCropSprite(c) {
    var wx = (c.tx + 0.5) * TILE, wy = (c.ty + 1) * TILE;
    var sway = reduceMotion() ? 0 : Math.sin(_present * 0.003 + U.hash01(c.tx * 71 + c.ty, 5) * 6.28) * 0.12;
    drawShadow(wx, wy - 2, TILE * 0.24);
    var s = SP();
    if (s && typeof s.crop === 'function') {
      try { s.crop(ctx, c.cropId, wx, wy, { stage: c.stage || 0, watered: !!c.watered, sway: sway }); return; }
      catch (e) { Game._recordError('Sprites.crop', e); }
    }
    // fallback crop
    var stage = c.stage || 0;
    var D = Game.DATA, cd = D.crops[c.cropId] || {};
    var top = cd.isDecor ? PAL.accent.pink : (c.dead ? '#9A8C6B' : PAL.grass.mid);
    var h = [6, 12, 20, 28][stage] || 10;
    ctx.save(); ctx.translate(wx, wy); ctx.rotate(sway);
    ctx.strokeStyle = PAL.grass.dark; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -h); ctx.stroke();
    ctx.fillStyle = top;
    ctx.beginPath(); ctx.arc(0, -h, 5 + stage * 1.6, 0, 6.2832); ctx.fill();
    if (stage >= 3) { ctx.fillStyle = PAL.accent.yellow; ctx.beginPath(); ctx.arc(0, -h, 2.4, 0, 6.2832); ctx.fill(); }
    if (c.watered && !c.dead) { ctx.fillStyle = rgba(hx(PAL.water.base), 0.35); ctx.beginPath(); ctx.ellipse(0, 1, 9, 3, 0, 0, 6.2832); ctx.fill(); }
    ctx.restore();
  }

  // little cosmetic ground flowers (deterministic, culled) — free charm
  function drawGroundFlower(wx, wy, seed, season) {
    var col = PAL.foliage[season] || PAL.accent.pink;
    ctx.save();
    ctx.translate(wx, wy);
    ctx.fillStyle = col;
    for (var i = 0; i < 5; i++) {
      var a = (i / 5) * 6.283;
      ctx.beginPath(); ctx.arc(Math.cos(a) * 2.6, Math.sin(a) * 2.6, 1.7, 0, 6.2832); ctx.fill();
    }
    ctx.fillStyle = PAL.accent.yellow;
    ctx.beginPath(); ctx.arc(0, 0, 1.5, 0, 6.2832); ctx.fill();
    ctx.restore();
  }

  // =====================================================================
  //  LAYER DRAWS
  // =====================================================================
  function skyAt(t) {
    t = ((t % 1) + 1) % 1;
    for (var i = 0; i < SKY_KEYS.length - 1; i++) {
      if (t >= SKY_KEYS[i][0] && t <= SKY_KEYS[i + 1][0]) {
        var f = U.invLerp(SKY_KEYS[i][0], SKY_KEYS[i + 1][0], t);
        var a = SKY_KEYS[i][1], b = SKY_KEYS[i + 1][1];
        return { top: mix(a.top, b.top, f), mid: mix(a.mid, b.mid, f), low: mix(a.low, b.low, f) };
      }
    }
    return SKY_KEYS[0][1];
  }

  function drawSky() {
    var s = Game.state;
    var t = ((s.minuteOfDay % 1440) / 1440);
    var sky = skyAt(t);
    var g = ctx.createLinearGradient(0, 0, 0, cssH);
    g.addColorStop(0, sky.top);
    g.addColorStop(0.55, sky.mid);
    g.addColorStop(1, sky.low);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cssW, cssH);

    // sun / moon arc across the sky
    var Time = Game.Time;
    var light = Time && Time.lightLevel ? Time.lightLevel() : 1;
    var isNight = Time && Time.isNight ? Time.isNight() : (t > 0.83 || t < 0.16);
    // day arc: t 0.15..0.85 -> sun ; else moon
    var arcT, celest, glow, cr;
    if (!isNight) {
      arcT = U.clamp(U.invLerp(0.15, 0.85, t), 0, 1);
      celest = PAL.light.sun; glow = PAL.light.sun; cr = 20;
    } else {
      var nt = t < 0.16 ? t + 1 : t;
      arcT = U.clamp(U.invLerp(0.83, 1.16, nt), 0, 1);
      celest = PAL.light.moon; glow = PAL.light.moon; cr = 15;
    }
    var cxp = cssW * (0.1 + arcT * 0.8);
    var cyp = cssH * (0.62 - Math.sin(arcT * Math.PI) * 0.5);
    var gg = ctx.createRadialGradient(cxp, cyp, 2, cxp, cyp, cr * 3.2);
    gg.addColorStop(0, rgba(hx(glow), 0.6)); gg.addColorStop(1, rgba(hx(glow), 0));
    ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(cxp, cyp, cr * 3.2, 0, 6.2832); ctx.fill();
    ctx.fillStyle = celest; ctx.beginPath(); ctx.arc(cxp, cyp, cr, 0, 6.2832); ctx.fill();
    if (isNight) { // crescent bite
      ctx.fillStyle = sky.top; ctx.beginPath(); ctx.arc(cxp + cr * 0.5, cyp - cr * 0.35, cr * 0.9, 0, 6.2832); ctx.fill();
    }
    // stars at night
    if (isNight) {
      var starA = U.clamp((1 - light) * 1.4, 0, 1);
      ctx.fillStyle = rgba(hx(PAL.light.star), starA * 0.9);
      for (var i = 0; i < 40; i++) {
        var sx = (U.hash01(i, 3) * cssW), sy = U.hash01(i, 7) * cssH * 0.6;
        var tw = 0.6 + 0.4 * Math.sin(_present * 0.002 + i);
        ctx.globalAlpha = starA * tw; ctx.fillRect(sx, sy, 2, 2);
      }
      ctx.globalAlpha = 1;
    }
    // hazy clouds in cloudy/rainy weather (soft, drawn in sky band)
    var w = weatherId();
    if ((w === 'cloudy' || w === 'rainy') && _clouds && particlesOn()) {
      for (var c = 0; c < _clouds.length; c++) {
        var cl = _clouds[c];
        ctx.fillStyle = rgba(hx(PAL.wx.cloud), w === 'rainy' ? 0.55 : 0.7);
        puff(cl.x, cl.y + 12, cl.s);
      }
    }
  }
  function puff(x, y, s) {
    ctx.beginPath();
    ctx.arc(x, y, s * 0.28, 0, 6.2832);
    ctx.arc(x + s * 0.32, y - s * 0.1, s * 0.34, 0, 6.2832);
    ctx.arc(x + s * 0.66, y, s * 0.28, 0, 6.2832);
    ctx.arc(x + s * 0.34, y + s * 0.12, s * 0.3, 0, 6.2832);
    ctx.fill();
  }

  function viewRect() {
    var c = cam();
    return { x: c.x, y: c.y, w: cssW / c.zoom, h: cssH / c.zoom };
  }

  function drawTerrain() {
    var s = Game.state, g = s.grid; if (!g) return;
    var vr = viewRect();
    var x0 = Math.max(0, Math.floor(vr.x / TILE) - 1), y0 = Math.max(0, Math.floor(vr.y / TILE) - 1);
    var x1 = Math.min(g.w - 1, Math.ceil((vr.x + vr.w) / TILE) + 1), y1 = Math.min(g.h - 1, Math.ceil((vr.y + vr.h) / TILE) + 1);
    var season = s.season || 'spring';
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var t = g.tiles[y * g.w + x]; if (!t) continue;
        drawTileSprite(t.terrain, x * TILE, y * TILE, t.variant || 0);
        // cosmetic flowers on some grass tiles
        if (t.terrain === 'grass' && !t.cropId && !t.buildingId && U.hash01(x * 131 + y * 57, 21) > 0.9) {
          drawGroundFlower(x * TILE + 12 + U.hash01(x, 2) * 20, y * TILE + 16 + U.hash01(y, 4) * 18, x + y, season);
        }
      }
    }
    // season atmosphere: recolor the whole visible world so each season reads at a glance
    var fx = SEASON_FX[season];
    if (fx) {
      ctx.save();
      ctx.globalCompositeOperation = fx.mode;
      ctx.globalAlpha = fx.alpha;
      ctx.fillStyle = fx.color;
      ctx.fillRect(vr.x - TILE, vr.y - TILE, vr.w + TILE * 2, vr.h + TILE * 2);
      if (fx.mode2) {
        ctx.globalCompositeOperation = fx.mode2;
        ctx.globalAlpha = fx.alpha2;
        ctx.fillStyle = fx.color2;
        ctx.fillRect(vr.x - TILE, vr.y - TILE, vr.w + TILE * 2, vr.h + TILE * 2);
      }
      ctx.restore();
    }
  }

  function drawEntities() {
    var s = Game.state;
    var vr = viewRect();
    var pad = TILE * 3;
    var list = [];
    var i, arr;
    arr = s.crops || [];
    for (i = 0; i < arr.length; i++) {
      var c = arr[i]; var cwx = (c.tx + 0.5) * TILE, cwy = (c.ty + 1) * TILE;
      if (cwx < vr.x - pad || cwx > vr.x + vr.w + pad || cwy < vr.y - pad || cwy > vr.y + vr.h + pad) continue;
      list.push({ y: cwy, kind: 'crop', ref: c });
    }
    arr = s.buildings || [];
    for (i = 0; i < arr.length; i++) {
      var b = arr[i]; var bwx = (b.tx + b.w / 2) * TILE, bwy = (b.ty + b.h) * TILE;
      if (bwx < vr.x - pad - b.w * TILE || bwx > vr.x + vr.w + pad || bwy < vr.y - pad || bwy > vr.y + vr.h + pad + b.h * TILE) continue;
      list.push({ y: bwy, kind: 'building', ref: b });
    }
    arr = s.animals || [];
    for (i = 0; i < arr.length; i++) {
      var a = arr[i];
      if (a.x < vr.x - pad || a.x > vr.x + vr.w + pad || a.y < vr.y - pad || a.y > vr.y + vr.h + pad) continue;
      list.push({ y: a.y, kind: 'animal', ref: a });
    }
    list.sort(function (p, q) { return p.y - q.y; });

    var Time = Game.Time;
    var night = Time && Time.isNight ? Time.isNight() : false;
    for (i = 0; i < list.length; i++) {
      var it = list[i];
      try {
        if (it.kind === 'crop') drawCropSprite(it.ref);
        else if (it.kind === 'building') {
          var lit = night && (it.ref.type === 'house' || (it.ref.inhabitants && it.ref.inhabitants.length > 0));
          drawBuildingSprite(it.ref, lit, popScale(it.ref.id));
        } else drawAnimalSprite(it.ref);
      } catch (e) { Game._recordError('Render.entity', e); }
    }
  }

  function popScale(id) {
    var start = _pops[id]; if (start == null) return 1;
    var p = (_present - start) / 260;
    if (p >= 1) { delete _pops[id]; return 1; }
    if (reduceMotion()) return U.lerp(0.9, 1, p);
    return U.lerp(0.55, 1, U.ease.outBack(U.clamp(p, 0, 1)));
  }

  function drawGroundParticles() {
    for (var i = 0; i < _particles.length; i++) {
      var p = _particles[i]; if (p.delay > 0 || p.space !== 'ground') continue;
      var a = U.clamp(p.life / p.max, 0, 1);
      if (p.kind === 'dust') {
        ctx.fillStyle = rgba(hx(p.color || PAL.soil.light), a * 0.6);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.4 - a * 0.5), 0, 6.2832); ctx.fill();
      } else if (p.kind === 'ripple' || p.kind === 'splash') {
        ctx.strokeStyle = rgba(hx(PAL.water.light), a * 0.8); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, p.size * (1.8 - a * 1.3) * 8, p.size * (1.8 - a * 1.3) * 3, 0, 0, 6.2832); ctx.stroke();
      } else if (p.kind === 'leaf') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = rgba(hx(p.color || PAL.foliage.autumn), a);
        ctx.beginPath(); ctx.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, 6.2832); ctx.fill(); ctx.restore();
      }
    }
  }

  function drawWeather() {
    if (!particlesOn()) return;
    var w = weatherId();
    if (w === 'rainy' && _rain) {
      ctx.strokeStyle = rgba(hx(PAL.wx.rain), 0.5); ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      ctx.beginPath();
      for (var i = 0; i < _rain.length; i++) { var d = _rain[i]; ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - d.len * 0.28, d.y + d.len); }
      ctx.stroke();
    } else if (w === 'snowy' && _snow) {
      ctx.fillStyle = rgba(hx(PAL.wx.snow), 0.9);
      for (var j = 0; j < _snow.length; j++) { var f = _snow[j]; ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 6.2832); ctx.fill(); }
      ctx.globalAlpha = 1;
    } else if (w === 'cloudy') {
      // moving soft shadow blobs on the ground
      if (_clouds) for (var c = 0; c < _clouds.length; c++) {
        var cl = _clouds[c];
        ctx.fillStyle = rgba(hx(PAL.wx.cloudShade), 0.06);
        ctx.beginPath(); ctx.ellipse(cl.x + 40, cssH * 0.6, cl.s * 0.8, cl.s * 0.32, 0, 0, 6.2832); ctx.fill();
      }
    } else if (w === 'sunny' && _motes) {
      var s = Game.state, season = (s && s.season) || 'spring';
      var mc = PAL.foliage[season] || PAL.accent.yellow;
      for (var m = 0; m < _motes.length; m++) {
        var mo = _motes[m];
        ctx.globalAlpha = 0.5 + 0.3 * Math.sin(mo.ph);
        ctx.fillStyle = mc;
        ctx.beginPath(); ctx.arc(mo.x, mo.y, mo.r, 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // weather color wash
    if (w === 'rainy') { ctx.fillStyle = 'rgba(58,74,106,0.16)'; ctx.fillRect(0, 0, cssW, cssH); }
    else if (w === 'cloudy') { ctx.fillStyle = 'rgba(220,230,238,0.08)'; ctx.fillRect(0, 0, cssW, cssH); }
  }

  function nightFactor() {
    var Time = Game.Time;
    var light = Time && Time.lightLevel ? Time.lightLevel() : 1;
    return U.clamp(1 - light, 0, 1);
  }

  function drawNightOverlay() {
    var nf = nightFactor();
    var s = Game.state;
    var t = ((s.minuteOfDay % 1440) / 1440);
    // golden hour warm wash near dawn/dusk
    var phase = Game.Time && Game.Time.phaseAt ? Game.Time.phaseAt(s.minuteOfDay) : 'day';
    if (phase === 'morning' || phase === 'evening') {
      ctx.fillStyle = rgba(hx(PAL.sky.dusk.mid), 0.12);
      ctx.fillRect(0, 0, cssW, cssH);
    }
    if (nf <= 0.02) return;
    var alpha = U.clamp(nf * 0.55, 0, 0.5);
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    var g = ctx.createLinearGradient(0, 0, 0, cssH);
    g.addColorStop(0, rgba(hx(PAL.light.night), alpha));
    g.addColorStop(1, rgba(hx(PAL.light.night), alpha * 0.7));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.restore();
  }

  function drawLampGlows() {
    var nf = nightFactor();
    if (nf <= 0.05) return;
    var s = Game.state, arr = s.buildings || [];
    var c = cam();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < arr.length; i++) {
      var b = arr[i];
      var occupied = b.type === 'house' || (b.inhabitants && b.inhabitants.length > 0);
      if (!occupied) continue;
      var wx = (b.tx + b.w / 2) * TILE, wy = (b.ty + b.h * 0.55) * TILE;
      var sc = worldToScreen(wx, wy);
      var sx = sc.sx + _shake.x, sy = sc.sy + _shake.y;
      var rad = (b.w + 1) * TILE * 0.5 * c.zoom;
      if (sx < -rad || sx > cssW + rad || sy < -rad || sy > cssH + rad) continue;
      var g = ctx.createRadialGradient(sx, sy, 2, sx, sy, rad);
      g.addColorStop(0, rgba(hx(PAL.light.lamp), 0.5 * nf));
      g.addColorStop(1, rgba(hx(PAL.light.lamp), 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sx, sy, rad, 0, 6.2832); ctx.fill();
    }
    ctx.restore();
  }

  // ---- air particles drawn in SCREEN space (crisp, zoom-independent) ----
  function drawAirParticles() {
    var s = SP();
    for (var i = 0; i < _particles.length; i++) {
      var p = _particles[i]; if (p.delay > 0 || p.space !== 'air') continue;
      var sc = worldToScreen(p.x, p.y);
      var x = sc.sx + _shake.x, y = sc.sy + _shake.y;
      if (x < -40 || x > cssW + 40 || y < -60 || y > cssH + 40) continue;
      var a = U.clamp(p.life / p.max, 0, 1);
      var grow = p.max - p.life < 140 ? (p.max - p.life) / 140 : 1; // pop-in
      var scl = Math.min(grow, 1) * (0.6 + a * 0.4);
      ctx.globalAlpha = p.kind === 'float' ? U.clamp(a * 1.6, 0, 1) : a;
      if (p.kind === 'float') {
        drawFloatText(x, y, p.text, p.color, U.clamp(a * 1.6, 0, 1));
      } else if (p.kind === 'heart') {
        if (s && s.heart) { try { s.heart(ctx, x, y, 1 - a); } catch (e) { fbHeart(x, y, p.size * scl, p.color); } }
        else fbHeart(x, y, p.size * scl, p.color);
      } else if (p.kind === 'sparkle' || p.kind === 'star') {
        if (s && s.sparkle) { try { s.sparkle(ctx, x, y, 1 - a); } catch (e) { fbSparkle(x, y, p.size * scl, p.color, p.rot); } }
        else fbSparkle(x, y, p.size * scl, p.color, p.rot);
      } else if (p.kind === 'coin') {
        if (s && s.coin) { try { s.coin(ctx, x, y, 1 - a); } catch (e) { fbCoin(x, y, p.size * scl, p.rot); } }
        else fbCoin(x, y, p.size * scl, p.rot);
      } else if (p.kind === 'confetti') {
        ctx.save(); ctx.translate(x, y); ctx.rotate(p.rot);
        ctx.fillStyle = p.color || PAL.accent.pink; ctx.fillRect(-p.size / 2 * scl, -p.size / 2 * scl, p.size * scl, p.size * scl);
        ctx.restore();
      } else if (p.kind === 'droplet') {
        fbDroplet(x, y, p.size * scl);
      } else if (p.kind === 'zzz') {
        ctx.fillStyle = rgba(hx(PAL.accent.sky), a); ctx.font = 'bold ' + (p.size * scl) + 'px sans-serif'; ctx.fillText('Z', x, y);
      } else if (p.kind === 'steam') {
        ctx.fillStyle = rgba([255, 255, 255], a * 0.5); ctx.beginPath(); ctx.arc(x, y, p.size * scl, 0, 6.2832); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawFloatText(x, y, text, color, a) {
    ctx.save();
    ctx.font = '700 15px "Hiragino Maru Gothic ProN", "Rounded Mplus 1c", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3.5; ctx.strokeStyle = rgba(hx(PAL.ui.cream), a); ctx.strokeText(text, x, y);
    ctx.fillStyle = color || PAL.accent.yellow; ctx.globalAlpha = a; ctx.fillText(text, x, y);
    ctx.restore();
  }
  function fbHeart(x, y, r, color) {
    ctx.save(); ctx.translate(x, y); ctx.scale(r / 12, r / 12);
    ctx.fillStyle = color || PAL.accent.pink;
    ctx.beginPath();
    ctx.moveTo(0, 4);
    ctx.bezierCurveTo(-7, -3, -9, 4, 0, 10);
    ctx.bezierCurveTo(9, 4, 7, -3, 0, 4);
    ctx.fill();
    ctx.restore();
  }
  function fbSparkle(x, y, r, color, rot) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot || 0);
    ctx.fillStyle = color || PAL.accent.yellow;
    ctx.beginPath();
    for (var i = 0; i < 4; i++) {
      var a = i * Math.PI / 2;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.lineTo(Math.cos(a + Math.PI / 4) * r * 0.32, Math.sin(a + Math.PI / 4) * r * 0.32);
    }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  function fbCoin(x, y, r, rot) {
    ctx.save(); ctx.translate(x, y);
    var sx = Math.abs(Math.cos(rot || 0)) * 0.6 + 0.4;
    ctx.scale(sx, 1);
    ctx.fillStyle = PAL.accent.yellow; ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.2832); ctx.fill();
    ctx.fillStyle = '#E8B93A'; ctx.beginPath(); ctx.arc(0, 0, r * 0.6, 0, 6.2832); ctx.fill();
    ctx.restore();
  }
  function fbDroplet(x, y, r) {
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = PAL.accent.sky;
    ctx.beginPath(); ctx.moveTo(0, -r); ctx.bezierCurveTo(r, 0, r * 0.7, r, 0, r); ctx.bezierCurveTo(-r * 0.7, r, -r, 0, 0, -r); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.beginPath(); ctx.arc(-r * 0.25, 0, r * 0.22, 0, 6.2832); ctx.fill();
    ctx.restore();
  }

  // ---- selection highlight + placement ghost (world space) ----
  function drawSelection() {
    if (!_selected) return;
    var s = Game.state;
    try {
      if (_selected.kind === 'animal') {
        var a = null, arr = s.animals || [];
        for (var i = 0; i < arr.length; i++) if (arr[i].id === _selected.id) { a = arr[i]; break; }
        if (a) {
          ctx.strokeStyle = PAL.accent.mintDeep; ctx.lineWidth = 3; ctx.setLineDash([6, 5]);
          ctx.lineDashOffset = -(_present * 0.03) % 11;
          ctx.beginPath(); ctx.ellipse(a.x, a.y + 6, 26, 12, 0, 0, 6.2832); ctx.stroke();
          ctx.setLineDash([]);
        }
      } else if (_selected.kind === 'building') {
        var b = null, ba = s.buildings || [];
        for (var j = 0; j < ba.length; j++) if (ba[j].id === _selected.id) { b = ba[j]; break; }
        if (b) highlightTiles(b.tx, b.ty, b.w, b.h, PAL.accent.mintDeep);
      }
    } catch (e) { Game._recordError('Render.selection', e); }
  }
  function highlightTiles(tx, ty, w, h, color) {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.setLineDash([7, 5]);
    ctx.lineDashOffset = -(_present * 0.03) % 12;
    roundRect(tx * TILE + 2, ty * TILE + 2, w * TILE - 4, h * TILE - 4, 6); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawGhost() {
    var Input = Game.Input; if (!Input) return;
    var hover = null, tool = null;
    try { hover = Input.hoverTile ? Input.hoverTile() : null; } catch (e) { }
    try { tool = Input.getTool ? Input.getTool() : null; } catch (e) { }
    if (!hover) return;
    // hover tile shimmer
    ctx.save();
    ctx.fillStyle = rgba(hx(PAL.ui.cream), 0.12 + 0.05 * Math.sin(_present * 0.006));
    ctx.fillRect(hover.tx * TILE, hover.ty * TILE, TILE, TILE);
    ctx.restore();
    // tool-provided ghost
    if (tool && typeof tool === 'object' && typeof tool.ghost === 'function') {
      try { tool.ghost(ctx, hover.tx, hover.ty); } catch (e) { Game._recordError('tool.ghost', e); }
    }
  }

  // =====================================================================
  //  MAIN FRAME
  // =====================================================================
  function frame(now) {
    if (!ctx || !Game.state) return;
    if (!_lastNow) _lastNow = now;
    var dt = now - _lastNow; _lastNow = now;
    if (dt < 0) dt = 0; if (dt > 100) dt = 100;
    _present += dt;

    try {
      updateShake(dt);
      updateParticles(dt);
      updateWeather(dt);
    } catch (e) { Game._recordError('Render.update', e); }

    try {
      // 1. sky (screen)
      setScreenTransform();
      ctx.clearRect(0, 0, cssW, cssH);
      drawSky();

      // 2-7. world (camera transform)
      setWorldTransform();
      drawTerrain();
      drawEntities();
      // 8. ground particles
      drawGroundParticles();

      // 9. weather overlay (screen)
      setScreenTransform();
      drawWeather();
      // 10. day-night light + lamp glows (screen)
      drawNightOverlay();
      drawLampGlows();
      // 11. air particles + float text (screen)
      drawAirParticles();

      // 12. selection + placement ghost (world)
      setWorldTransform();
      drawSelection();
      drawGhost();

      setScreenTransform();
    } catch (e) {
      Game._recordError('Render.frame', e);
      setScreenTransform();
    }
  }

  // =====================================================================
  //  EVENT WIRING (all inside init)
  // =====================================================================
  function centerWorldPoint() {
    var vr = viewRect();
    return { x: vr.x + vr.w / 2, y: vr.y + vr.h / 2 };
  }
  function animalById(id) {
    var arr = Game.state.animals || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }
  function firstBuildingType(type) {
    var arr = Game.state.buildings || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].type === type) return arr[i];
    return null;
  }

  function wire() {
    var bus = Game.bus;
    _unsubs.push(bus.on('fx:heart', function (p) { if (p) heartsBurst(p.x, p.y, 5); }));
    _unsubs.push(bus.on('fx:sparkle', function (p) { if (p) sparkleBurst(p.x, p.y, 6); }));
    _unsubs.push(bus.on('fx:coin', function (p) {
      if (!p) return;
      coinBurst(p.x, p.y, 4);
      if (p.amount != null) emitFloatText(p.x, p.y - 10, '+' + U.formatG(p.amount), PAL.accent.yellow);
    }));
    _unsubs.push(bus.on('sale', function (p) {
      if (!p) return;
      var b = firstBuildingType('market_stall');
      var wx, wy;
      if (b) { wx = (b.tx + b.w / 2) * TILE; wy = (b.ty + 0.2) * TILE; }
      else { var cp = centerWorldPoint(); wx = cp.x; wy = cp.y; }
      coinBurst(wx, wy, 3);
      if (p.total != null) emitFloatText(wx, wy - 12, '+' + U.formatG(p.total), PAL.accent.yellow);
    }));
    _unsubs.push(bus.on('animal:produce', function (p) {
      if (!p) return; var a = animalById(p.id); if (!a) return;
      var premium = /quality|fine_wool|truffle/.test(p.itemId || '');
      if (premium) sparkleBurst(a.x, a.y - 18, 6, PAL.accent.lav);
      else spawnParticle('droplet', a.x, a.y - 16, { vy: -18, g: 40, size: 8, life: 700 });
    }));
    _unsubs.push(bus.on('animal:born', function (p) {
      if (!p) return; var m = animalById(p.motherId) || animalById(p.id);
      if (m) { heartsBurst(m.x, m.y - 10, 6); sparkleBurst(m.x, m.y - 10, 4); }
    }));
    _unsubs.push(bus.on('crop:ready', function (p) {
      if (!p || p.tx == null) return;
      sparkleBurst((p.tx + 0.5) * TILE, (p.ty + 0.5) * TILE, 3, PAL.accent.mint);
    }));
    _unsubs.push(bus.on('build', function (p) {
      if (!p) return;
      _pops[p.buildingId] = _present;
      var b = null, arr = Game.state.buildings || [];
      for (var i = 0; i < arr.length; i++) if (arr[i].id === p.buildingId) { b = arr[i]; break; }
      if (b) { dustRing((b.tx + b.w / 2) * TILE, (b.ty + b.h) * TILE); if ((b.w * b.h) >= 9) shake(1.6); else shake(0.8); }
    }));
    _unsubs.push(bus.on('levelup', function () {
      var cp = centerWorldPoint();
      confettiBurst(cp.x, cp.y - 30, 30);
      sparkleBurst(cp.x, cp.y - 30, 10);
      emitFloatText(cp.x, cp.y - 60, 'ランクアップ！', PAL.accent.pinkDeep);
      shake(2);
    }));
    _unsubs.push(bus.on('achievement:unlock', function () {
      var cp = centerWorldPoint(); confettiBurst(cp.x, cp.y, 18);
    }));
    _unsubs.push(bus.on('entity:select', function (p) { _selected = (p && p.id != null) ? { kind: p.kind, id: p.id } : null; }));
    _unsubs.push(bus.on('tool:change', function (p) { if (p && p.tool && p.tool !== 'inspect') _selected = null; }));
    _unsubs.push(bus.on('state:replaced', function () {
      _particles.length = 0; _pops = {}; _selected = null; _lastNow = 0;
      buildWeatherBuffers();
      centerOnStart();
    }));
    // rain splashes on water occasionally + puddle ripples (cheap ambient)
    _unsubs.push(bus.on('weather:change', function () { /* buffers already persistent; nothing heavy */ }));
  }

  // =====================================================================
  //  INIT
  // =====================================================================
  function init(ctxObj) {
    try {
      canvas = (ctxObj && ctxObj.canvas) || (typeof document !== 'undefined' ? document.getElementById('world') : null);
      if (canvas && canvas.getContext) {
        ctx = canvas.getContext('2d');
        if (ctx) { ctx.imageSmoothingEnabled = true; }
      }
    } catch (e) { Game._recordError('Render.init.canvas', e); }

    resize();

    try {
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('resize', function () { resize(); });
      }
    } catch (e) { Game._recordError('Render.init.resize', e); }

    try { wire(); } catch (e) { Game._recordError('Render.init.wire', e); }

    // seed the camera clamp against the loaded world
    clampCamera();
  }

  return {
    init: init,
    frame: frame,
    worldToScreen: worldToScreen,
    screenToWorld: screenToWorld,
    screenToTile: screenToTile,
    panBy: panBy,
    zoomAt: zoomAt,
    clampCamera: clampCamera,
    centerOn: centerOn,
    centerOnStart: centerOnStart,
    resize: resize,
    spawnParticle: spawnParticle,
    emitFloatText: emitFloatText,
    shake: shake
  };
})();
