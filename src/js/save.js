/*
 * save.js — Game.Save: localStorage persistence, migration, autosave.
 * Degrades gracefully to in-memory if localStorage is unavailable (sandboxed
 * iframes sometimes block it). Never throws to callers.
 */
Game.Save = (function () {
  'use strict';
  var U = Game.Util;
  var PREFIX = 'makiba.save.v1.slot';
  var SETTINGS_KEY = 'makiba.settings';
  var _mem = {};        // in-memory fallback store
  var _lsOk = null;     // cached availability

  function ls() {
    if (_lsOk === false) return null;
    try {
      var k = '__makiba_probe__';
      window.localStorage.setItem(k, '1'); window.localStorage.removeItem(k);
      _lsOk = true; return window.localStorage;
    } catch (e) { _lsOk = false; return null; }
  }
  function readRaw(key) { var s = ls(); try { return s ? s.getItem(key) : (_mem[key] || null); } catch (e) { return _mem[key] || null; } }
  function writeRaw(key, val) { var s = ls(); try { if (s) s.setItem(key, val); else _mem[key] = val; } catch (e) { _mem[key] = val; } }
  function removeRaw(key) { var s = ls(); try { if (s) s.removeItem(key); else delete _mem[key]; } catch (e) { delete _mem[key]; } }

  function keyFor(slot) { return PREFIX + (slot || 0); }

  function serialize(state) {
    var wrapper = { v: Game.State.SCHEMA_VERSION, t: Date.now(), state: state };
    return JSON.stringify(wrapper);
  }
  function deserialize(str) {
    var w = JSON.parse(str);
    return w;
  }

  // migrations[from] = function(state)->state, applied until v === SCHEMA_VERSION
  var migrations = {};

  function migrate(wrapper) {
    var v = wrapper.v || 1;
    while (v < Game.State.SCHEMA_VERSION) {
      var m = migrations[v];
      if (!m) { v = Game.State.SCHEMA_VERSION; break; }
      wrapper.state = m(wrapper.state);
      v++;
      wrapper.v = v;
    }
    return wrapper;
  }

  function save(slot) {
    slot = slot || 0;
    try {
      var str = serialize(Game.state);
      writeRaw(keyFor(slot), str);
      saveSettings();
      Game.bus.emit('save', { slot: slot, version: Game.State.SCHEMA_VERSION });
      return true;
    } catch (e) {
      if (Game._recordError) Game._recordError('save', e);
      return false;
    }
  }

  function load(slot) {
    slot = slot || 0;
    var raw = readRaw(keyFor(slot));
    if (!raw) return false;
    try {
      var w = deserialize(raw);
      if (!w || !w.state) return false;
      if (w.v > Game.State.SCHEMA_VERSION) { return false; } // newer save: refuse, keep current
      w = migrate(w);
      // backfill any missing top-level keys from a fresh default
      var merged = U.deepMerge(w.state, Game.State.defaults());
      Game.State.set(merged);
      Game.bus.emit('load', { slot: slot, version: w.v });
      Game.bus.emit('state:replaced', { reason: 'load' });
      return true;
    } catch (e) {
      if (Game._recordError) Game._recordError('load', e);
      return false;
    }
  }

  function hasSave(slot) { return !!readRaw(keyFor(slot || 0)); }
  function deleteSave(slot) { removeRaw(keyFor(slot || 0)); }

  function saveSettings() {
    try { if (Game.state && Game.state.settings) writeRaw(SETTINGS_KEY, JSON.stringify(Game.state.settings)); } catch (e) { }
  }
  function loadSettings() {
    var raw = readRaw(SETTINGS_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  var _autosaveDays = 1, _autosaveArmed = false, _lastAutosaveDay = 0;
  function enableAutosave(days) {
    _autosaveDays = days || 1;
    if (_autosaveArmed) return;
    _autosaveArmed = true;
    // Reset the day-cursor whenever the live state is swapped (new game / load / reset),
    // otherwise a fresh game starting at day 1 after a long prior session would never
    // re-arm the scheduled autosave until day count caught back up to the old cursor.
    Game.bus.on('state:replaced', function () { _lastAutosaveDay = 0; });
    Game.bus.on('day:advance', function (p) {
      if ((p.day - _lastAutosaveDay) >= _autosaveDays) { _lastAutosaveDay = p.day; save(0); }
    });
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') save(0);
      });
    } catch (e) { }
  }

  function exportString() {
    try { return btoa(unescape(encodeURIComponent(serialize(Game.state)))); }
    catch (e) { return ''; }
  }
  function importString(b64) {
    try {
      var str = decodeURIComponent(escape(atob(b64)));
      var w = migrate(deserialize(str));
      if (!w || !w.state) return false;
      Game.State.set(U.deepMerge(w.state, Game.State.defaults()));
      Game.bus.emit('state:replaced', { reason: 'import' });
      return true;
    } catch (e) { return false; }
  }

  function init() { /* nothing at init; boot decides load-or-new */ }

  return {
    init: init, save: save, load: load, hasSave: hasSave, deleteSave: deleteSave,
    serialize: serialize, deserialize: deserialize, migrate: migrate,
    enableAutosave: enableAutosave, exportString: exportString, importString: importString,
    saveSettings: saveSettings, loadSettings: loadSettings, migrations: migrations
  };
})();
