/*
 * game.js — bootstrap + main loop + orchestration + test hooks.
 * Wires init order, owns the RAF loop with a fixed-timestep sim decoupled from
 * render, and exposes Game.test.* for the headless QA harness.
 *
 * Robustness: every per-frame module call is crash-isolated — a throw is
 * recorded to Game._errors and the loop keeps running, so a single subsystem
 * bug never freezes the whole game (critical for iterative QA).
 */
(function () {
  'use strict';
  var K = Game.DATA.const;

  // ---------- global error capture ----------
  Game._errors = [];
  Game._recordError = function (where, err) {
    var msg = (err && err.stack) ? err.stack : String(err);
    Game._errors.push({ where: where, msg: msg });
    if (Game._errors.length > 200) Game._errors.shift();
    if (typeof console !== 'undefined') console.error('[' + where + ']', err);
  };
  try {
    window.addEventListener('error', function (e) { Game._recordError('window.onerror', e.error || e.message); });
    window.addEventListener('unhandledrejection', function (e) { Game._recordError('unhandledrejection', e.reason); });
  } catch (e) { }

  var MODULE_INIT_ORDER = ['Time', 'Economy', 'World', 'Crops', 'Animals', 'Sprites', 'Render', 'Audio', 'Input', 'UI', 'Tutorial'];

  function callInit(ns, ctx) {
    var m = Game[ns];
    if (m && typeof m.init === 'function') {
      try { m.init(ctx); }
      catch (e) { Game._recordError('init:' + ns, e); }
    }
  }
  function callSafe(ns, method, arg) {
    var m = Game[ns];
    if (m && typeof m[method] === 'function') {
      try { return m[method](arg); }
      catch (e) { Game._recordError(ns + '.' + method, e); }
    }
    return undefined;
  }

  function buildCtx() {
    var byId = function (id) { try { return document.getElementById(id); } catch (e) { return null; } };
    return {
      canvas: byId('world'),
      root: byId('app'),
      hud: byId('hud'),
      dock: byId('dock'),
      panels: byId('panels'),
      toast: byId('toast'),
      overlay: byId('overlay'),
      get state() { return Game.state; }
    };
  }

  var _ctx = null;

  // ---------- boot ----------
  Game.boot = function () {
    // apply persisted settings early (volume/reduceMotion) if any
    var savedSettings = Game.Save && Game.Save.loadSettings ? Game.Save.loadSettings() : null;

    // decide: continue existing save, else fresh new game
    var loaded = false;
    if (Game.Save && Game.Save.hasSave && Game.Save.hasSave(0)) {
      loaded = Game.Save.load(0);
    }
    if (!loaded) {
      Game.State.set(Game.State.newGame());
    }
    if (savedSettings && Game.state && Game.state.settings) {
      Game.Util.deepMerge(Game.state.settings, savedSettings);
    }

    _ctx = buildCtx();

    // init all modules in canonical order (guarded)
    MODULE_INIT_ORDER.forEach(function (ns) { callInit(ns, _ctx); });

    if (Game.Save && Game.Save.enableAutosave) Game.Save.enableAutosave(1);

    callSafe('Render', 'resize');
    callSafe('Render', 'centerOnStart');

    Game._ready = true;
    Game.bus.emit('game:ready', {});

    // start tutorial only for a brand-new game
    if (!loaded && Game.state.tutorial && Game.state.tutorial.active) {
      callSafe('Tutorial', 'start');
    }

    Game.start();
  };

  // ---------- main loop ----------
  var SIM_DT = 1000 / K.SIM_HZ;
  var MIN_PER_STEP = K.MINUTES_PER_DAY / (K.REAL_SECONDS_PER_DAY * K.SIM_HZ); // 1.5 min/step @1x
  var _raf = 0, _last = 0, _acc = 0, _running = false;
  var _presentation = 0;

  function simStep() {
    var speed = (Game.state.settings && Game.state.settings.speed) || 1;
    var minutes = MIN_PER_STEP * speed;
    callSafe('Time', 'step', minutes);
    callSafe('Crops', 'update', 1);
    callSafe('Animals', 'update', 1);
    callSafe('Economy', 'update', 1);
    callSafe('World', 'update', 1);
  }

  function frame(now) {
    if (!_running) return;
    var dt = now - _last; _last = now;
    if (dt < 0) dt = 0; if (dt > 250) dt = 250; // spike guard
    _presentation += dt;
    if (Game.state) Game.state.playtimeMs += dt;

    if (Game.state && !Game.state.paused) {
      _acc += dt;
      var steps = 0;
      while (_acc >= SIM_DT && steps < 6) { simStep(); _acc -= SIM_DT; steps++; }
      if (_acc > SIM_DT * 8) _acc = 0; // hard clamp after long stalls
    }

    callSafe('Render', 'frame', now);
    callSafe('Audio', 'update', now);
    callSafe('UI', 'tick', now);

    _raf = requestAnimationFrame(frame);
  }

  Game.start = function () {
    if (_running) return;
    _running = true; _last = (typeof performance !== 'undefined' ? performance.now() : Date.now()); _acc = 0;
    _raf = requestAnimationFrame(frame);
  };
  Game.stop = function () { _running = false; if (_raf) cancelAnimationFrame(_raf); _raf = 0; };

  Game.pause = function () { if (Game.state) { Game.state.paused = true; Game.bus.emit('game:pause', {}); } };
  Game.resume = function () { if (Game.state) { Game.state.paused = false; Game.bus.emit('game:resume', {}); } };
  Game.togglePause = function () { if (Game.state.paused) Game.resume(); else Game.pause(); };
  Game.isPaused = function () { return !!(Game.state && Game.state.paused); };
  Game.setSpeed = function (s) {
    if (!Game.state) return;
    var speeds = K.SPEEDS;
    if (speeds.indexOf(s) < 0) s = 1;
    Game.state.settings.speed = s;
    Game.state.paused = false;
    Game.bus.emit('speed:change', { speed: s });
  };

  // ---------- new / continue / reset ----------
  function freshState(skipTutorial) {
    Game.State.set(Game.State.newGame());
    if (skipTutorial && Game.state.tutorial) Game.state.tutorial.active = false;
    Game.bus.emit('state:replaced', { reason: 'newgame' });
    callSafe('Render', 'centerOnStart');
    callSafe('UI', 'refreshHUD');
    Game.bus.emit('game:ready', {});
  }
  Game.newGame = function () { freshState(false); if (Game.state.tutorial && Game.state.tutorial.active) callSafe('Tutorial', 'start'); };
  Game.continueGame = function () { if (Game.Save.hasSave(0)) { Game.Save.load(0); Game.bus.emit('state:replaced', { reason: 'continue' }); callSafe('Render', 'centerOnStart'); callSafe('UI', 'refreshHUD'); } };
  Game.resetGame = function () { Game.Save.deleteSave(0); freshState(false); };
  Game.hardReload = function () { try { location.reload(); } catch (e) { } };

  // ---------- test hooks (headless QA harness) ----------
  function firstBuildingWithCapacity(kinds) {
    var s = Game.state;
    for (var i = 0; i < s.buildings.length; i++) {
      var b = s.buildings[i];
      if (kinds.indexOf(b.type) >= 0 && b.inhabitants.length < (b.capacity || 0)) return b;
    }
    return null;
  }
  Game.test = {
    ready: function () { return !!(Game.state && Game._ready); },
    newGame: function () { freshState(true); return { ok: true }; },
    snapshot: function () {
      var s = Game.state; if (!s) return { err: 'no state' };
      var cows = 0, babies = 0; s.animals.forEach(function (a) { if (a.species === 'cow') cows++; if (!a.adult) babies++; });
      return {
        money: Math.round(s.money), day: s.day, season: s.season, year: s.year,
        rank: s.rank, weather: s.weather, minuteOfDay: Math.round(s.minuteOfDay),
        animals: s.animals.length, cows: cows, babies: babies,
        buildings: s.buildings.length, crops: s.crops.length,
        inventoryKinds: Object.keys(s.inventory).length,
        inventoryUnits: Object.keys(s.inventory).reduce(function (n, k) { return n + s.inventory[k]; }, 0),
        errors: Game._errors.length
      };
    },
    advanceDays: function (n) { n = n || 1; for (var i = 0; i < n; i++) callSafe('Time', 'step', 1440); return { ok: true, day: Game.state.day }; },
    advanceMinutes: function (m) { callSafe('Time', 'step', m || 60); return { ok: true }; },
    buyAnimal: function (breedId) {
      breedId = breedId || 'chicken';
      var isCow = Game.DATA.isCow(breedId);
      var b = firstBuildingWithCapacity(isCow ? ['barn', 'barn_big'] : ['coop', 'barn', 'barn_big', 'pasture']);
      if (Game.Animals && Game.Animals.buy) { var r = Game.Animals.buy(breedId, b ? b.id : null); return r || { ok: true }; }
      return { ok: false, err: 'Animals.buy missing' };
    },
    build: function (type, tx, ty) {
      if (Game.World && Game.World.place) { var id = Game.World.place(type, tx, ty); return { ok: id > 0, id: id }; }
      return { ok: false, err: 'World.place missing' };
    },
    plant: function (cropId, tx, ty) {
      if (Game.Crops && Game.Crops.plant) { var id = Game.Crops.plant(cropId, tx, ty); return { ok: id > 0, id: id }; }
      return { ok: false, err: 'Crops.plant missing' };
    },
    harvestAll: function () {
      var s = Game.state, got = 0;
      if (Game.Crops && Game.Crops.harvest) {
        s.crops.slice().forEach(function (c) { if (Game.Crops.isReady && Game.Crops.isReady(c.id)) { var r = Game.Crops.harvest(c.tx, c.ty); if (r && r.ok) got++; } });
      }
      return { ok: true, harvested: got };
    },
    sellAll: function () {
      var s = Game.state, sold = 0;
      if (Game.Economy && Game.Economy.sell) {
        Object.keys(s.inventory).forEach(function (id) {
          var q = s.inventory[id]; var prod = Game.DATA.products[id];
          if (q > 0 && prod) { var r = Game.Economy.sell(id, q); if (r && r.ok) sold += q; }
        });
      }
      return { ok: true, sold: sold };
    },
    petRandom: function () {
      var s = Game.state; if (!s.animals.length) return { ok: true };
      var a = s.animals[(Game.Util.rng() * s.animals.length) | 0];
      if (Game.Animals && Game.Animals.pet) Game.Animals.pet(a.id);
      return { ok: true, id: a.id };
    },
    save: function () { return { ok: Game.Save.save(0) }; },
    load: function () { return { ok: Game.Save.load(0) }; },
    setSpeed: function (s) { Game.setSpeed(s); return { ok: true }; },
    errors: function () { return Game._errors.slice(); },
    state: function () { return Game.state; }
  };
})();
