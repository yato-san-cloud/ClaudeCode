/*
 * util.js — Game.Util helpers + Game.bus (EventBus singleton).
 * No state ownership. Pure helpers. Game.Util.rng() reads/advances
 * Game.state.rngState so gameplay randomness is seeded & deterministic
 * across save/load. (Initial seed generation in state.js is the ONE place
 * Math.random/Date.now are allowed.)
 */
Game.Util = (function () {
  'use strict';

  // ---------- EventBus ----------
  function makeEventBus() {
    var map = Object.create(null);
    function on(ev, fn) {
      (map[ev] || (map[ev] = [])).push(fn);
      return function unsub() { off(ev, fn); };
    }
    function once(ev, fn) {
      var u = on(ev, function (p) { u(); fn(p); });
      return u;
    }
    function off(ev, fn) {
      var a = map[ev]; if (!a) return;
      var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    }
    function emit(ev, payload) {
      var a = map[ev]; if (!a) return;
      // copy so handlers can unsubscribe during dispatch
      var list = a.slice();
      for (var i = 0; i < list.length; i++) {
        try { list[i](payload); }
        catch (e) {
          if (Game._recordError) Game._recordError('bus:' + ev, e);
          else if (typeof console !== 'undefined') console.error('bus handler error [' + ev + ']', e);
        }
      }
    }
    return { on: on, once: once, off: off, emit: emit, _map: map };
  }

  // ---------- Seeded RNG (mulberry32) ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeRng(seed) { return mulberry32(seed >>> 0); }

  var _fallbackSeed = 123456789;
  // State-bound RNG: advances Game.state.rngState (persisted). Falls back to a
  // module-local cursor before Game.state exists.
  function rng() {
    var s = Game.state;
    var a = s ? (s.rngState >>> 0) : _fallbackSeed;
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    var out = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    if (s) s.rngState = a >>> 0; else _fallbackSeed = a >>> 0;
    return out;
  }
  function randInt(min, max) { return min + Math.floor(rng() * (max - min + 1)); }
  function randRange(min, max) { return min + rng() * (max - min); }
  function pick(arr) { return arr[(rng() * arr.length) | 0]; }
  function chance(p) { return rng() < p; }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = (rng() * (i + 1)) | 0; var tmp = a[i]; a[i] = a[j]; a[j] = tmp; }
    return a;
  }
  // Deterministic hash-based pseudo-random for cosmetic per-entity jitter that
  // must NOT disturb the sim RNG stream (e.g. render sway). Stable per (id,salt).
  function hash01(n, salt) {
    var h = ((n | 0) * 374761393 + (salt | 0) * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // ---------- math ----------
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function invLerp(a, b, v) { return b === a ? 0 : (v - a) / (b - a); }
  function dist2(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
  function aabb(ax, ay, aw, ah, bx, by, bw, bh) { return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by; }
  function approach(cur, target, maxDelta) {
    if (cur < target) return Math.min(cur + maxDelta, target);
    if (cur > target) return Math.max(cur - maxDelta, target);
    return target;
  }

  var ease = {
    linear: function (t) { return t; },
    inOut: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
    out: function (t) { return 1 - (1 - t) * (1 - t); },
    in: function (t) { return t * t; },
    outBack: function (t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    outElastic: function (t) {
      var c4 = (2 * Math.PI) / 3;
      return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    },
    outBounce: function (t) {
      var n1 = 7.5625, d1 = 2.75;
      if (t < 1 / d1) return n1 * t * t;
      if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
      if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
      return n1 * (t -= 2.625 / d1) * t + 0.984375;
    }
  };

  // ---------- formatting ----------
  function formatG(n) {
    n = Math.round(n || 0);
    var neg = n < 0; if (neg) n = -n;
    var s = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + s + 'G';
  }
  function formatNum(n) {
    n = Math.round(n || 0);
    var neg = n < 0; if (neg) n = -n;
    return (neg ? '-' : '') + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function formatTime(min) {
    min = ((Math.floor(min) % 1440) + 1440) % 1440;
    var h = Math.floor(min / 60), m = min % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  function uid(state, key) { var v = state[key] || 1; state[key] = v + 1; return v; }
  function deepClone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function deepMerge(target, src) {
    if (src == null || typeof src !== 'object') return target;
    Object.keys(src).forEach(function (k) {
      var sv = src[k];
      if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        deepMerge(target[k], sv);
      } else if (target[k] === undefined) {
        target[k] = Array.isArray(sv) ? sv.slice() : sv;
      }
    });
    return target;
  }

  return {
    makeEventBus: makeEventBus,
    makeRng: makeRng, rng: rng, randInt: randInt, randRange: randRange,
    pick: pick, chance: chance, shuffle: shuffle, hash01: hash01,
    clamp: clamp, lerp: lerp, invLerp: invLerp, dist2: dist2, aabb: aabb, approach: approach,
    ease: ease,
    formatG: formatG, formatNum: formatNum, formatTime: formatTime,
    uid: uid, deepClone: deepClone, deepMerge: deepMerge
  };
})();

// Singleton event bus used across all modules.
Game.bus = Game.Util.makeEventBus();
