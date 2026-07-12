/*
 * world.js — Game.World: the tile grid + buildings.
 *
 * Owns: state.grid, state.buildings, state.nextBuildingId.
 * Responsibilities: tile queries (tileAt/inBounds/isWalkable), building
 * placement validation & execution (canPlace/place), removal with refund &
 * inhabitant eviction (remove), lookups (buildingAt/getBuilding/buildingsOfType),
 * upgrades, capacity accounting, and BFS spawn-tile search (freeTileNear).
 *
 * Integration rules honored: no top-level side effects; all cross-module refs
 * (Economy/Animals) resolved inside functions with null-guards; money moves ONLY
 * via Economy.debit/credit; numbers come from Game.DATA; risky work try/caught.
 * The world in v1 is fully unlocked, so buyPlot() is a friendly no-op.
 */
Game.World = (function () {
  'use strict';
  var U = Game.Util, D = Game.DATA, K = Game.DATA.const;
  var bus = Game.bus;
  var TILE = K.TILE;

  // Building types that house animals (head-count capacity). Storage buildings
  // (silo/warehouse) also carry a `capacity` but for item stacks, not animals.
  var ANIMAL_HOUSE = { barn: 1, barn_big: 1, coop: 1, pasture: 1, pond: 1, house: 1 };

  // ---------- tiny internal helpers ----------
  function state() { return Game.state; }
  function grid() { var s = state(); return s ? s.grid : null; }
  function idx(g, x, y) { return y * g.w + x; }

  function bdef(type) { return (D.buildings && D.buildings[type]) || null; }
  function footprintOf(type) { var b = bdef(type); var fp = (b && b.footprint) || [2, 2]; return { w: fp[0], h: fp[1] }; }

  function refundPct() {
    var lp = D.landPlots || {};
    var p = lp.relocationRefundPct;
    return (typeof p === 'number') ? p : 0.9;
  }
  function centerWorld(b) {
    return { x: (b.tx + b.w / 2) * TILE, y: (b.ty + b.h / 2) * TILE };
  }

  // Economy is optional at some call sites (early boot / headless tests). Guard.
  function eco() { return Game.Economy || null; }

  function notify(text, icon, kind, ttl) {
    try { bus.emit('notify', { text: text, icon: icon || '🏗️', kind: kind || 'info', ttl: ttl || 2600 }); }
    catch (e) { Game._recordError('World.notify', e); }
  }
  function sparkleAt(b) {
    var s = state();
    if (s && s.settings && s.settings.showParticles === false) return;
    var c = centerWorld(b);
    try { bus.emit('fx:sparkle', { x: c.x, y: c.y }); } catch (e) { /* render may be absent */ }
  }

  // ---------- tile queries ----------
  function inBounds(tx, ty) {
    var g = grid();
    return !!g && tx >= 0 && ty >= 0 && tx < g.w && ty < g.h;
  }
  function tileAt(tx, ty) {
    var g = grid();
    if (!g || !inBounds(tx, ty)) return null;
    return g.tiles[idx(g, tx, ty)] || null;
  }
  function isWalkable(tx, ty) {
    var t = tileAt(tx, ty);
    if (!t) return false;
    return t.walkable !== false && t.unlocked !== false && t.terrain !== 'water';
  }

  // ---------- building lookups ----------
  function getBuilding(id) {
    var s = state();
    if (!s || id == null) return null;
    var arr = s.buildings;
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }
  function buildingAt(tx, ty) {
    var t = tileAt(tx, ty);
    if (!t || t.buildingId == null) return null;
    return getBuilding(t.buildingId);
  }
  function buildingsOfType(type) {
    var s = state(); if (!s) return [];
    return s.buildings.filter(function (b) { return b.type === type; });
  }

  // ---------- capacity ----------
  function capacityFor(type) {
    var list = buildingsOfType(type);
    var used = 0, max = 0;
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      used += (b.inhabitants ? b.inhabitants.length : 0);
      max += (b.capacity || 0);
    }
    return { used: used, max: max };
  }
  function hasFreeSpace(b) {
    if (!b) return false;
    return (b.inhabitants ? b.inhabitants.length : 0) < (b.capacity || 0);
  }

  // ---------- placement validation ----------
  function canPlace(type, tx, ty) {
    var b = bdef(type);
    if (!b) return { ok: false, reason: 'ふしぎな建物だよ' };
    var s = state();
    if (!s) return { ok: false, reason: 'まだ準備中だよ' };

    // rank gate
    var need = b.unlockRank || 1;
    if ((s.rank || 1) < need) return { ok: false, reason: 'ランク' + need + 'で開放されるよ' };

    var fp = footprintOf(type), w = fp.w, h = fp.h;
    // footprint fully in-bounds?
    if (!inBounds(tx, ty) || !inBounds(tx + w - 1, ty + h - 1)) {
      return { ok: false, reason: '牧場からはみ出しちゃう' };
    }
    // every covered tile must be unlocked, empty, walkable-buildable, not water
    for (var yy = ty; yy < ty + h; yy++) {
      for (var xx = tx; xx < tx + w; xx++) {
        var t = tileAt(xx, yy);
        if (!t) return { ok: false, reason: '牧場からはみ出しちゃう' };
        if (t.unlocked === false) return { ok: false, reason: 'まだ開放されていない区画だよ' };
        if (t.terrain === 'water') return { ok: false, reason: '水の上には置けないよ' };
        if (t.buildingId != null) return { ok: false, reason: 'ほかの建物があるよ' };
        if (t.cropId != null) return { ok: false, reason: '作物があるよ' };
        if (t.walkable === false) return { ok: false, reason: 'ここには置けないよ' };
      }
    }
    // affordable?
    var cost = b.buildCost || 0;
    var E = eco();
    if (E && E.canAfford && !E.canAfford(cost)) {
      return { ok: false, reason: 'おかねが足りないよ' };
    }
    return { ok: true };
  }

  // ---------- place ----------
  function place(type, tx, ty) {
    try {
      var chk = canPlace(type, tx, ty);
      if (!chk.ok) {
        var bd0 = bdef(type);
        notify(chk.reason || 'ここには置けないよ', bd0 ? bd0.emoji : '🚧', 'warn');
        try { if (Game.Audio && Game.Audio.sfx) Game.Audio.sfx('error'); } catch (e) { }
        return -1;
      }
      var b = bdef(type);
      var cost = b.buildCost || 0;
      var E = eco();
      if (E && E.debit) {
        if (!E.debit(cost, 'build:' + type)) {
          notify('おかねが足りないよ', b.emoji, 'warn');
          return -1;
        }
      }
      var bld = Game.State.placeBuilding(state(), type, tx, ty);
      if (!bld) {
        // extremely defensive: refund the debit if placement somehow failed
        if (E && E.credit && cost > 0) E.credit(cost, 'build:refund:' + type);
        return -1;
      }
      bld.builtDay = state().day || 1;

      if (E && E.stat) E.stat('buildingsBuilt', 1);
      bus.emit('build', { buildingId: bld.id, type: type, tx: tx, ty: ty });

      notify((b.name || '建物') + 'をたてたよ！', b.emoji, 'good');
      sparkleAt(bld);
      return bld.id;
    } catch (e) {
      Game._recordError('World.place', e);
      return -1;
    }
  }

  // ---------- inhabitants ----------
  function addInhabitant(buildingId, animalId) {
    var b = getBuilding(buildingId);
    if (!b || animalId == null) return false;
    if (!b.inhabitants) b.inhabitants = [];
    if (b.inhabitants.indexOf(animalId) >= 0) return true;
    if (b.inhabitants.length >= (b.capacity || 0)) return false;
    b.inhabitants.push(animalId);
    return true;
  }
  function removeInhabitant(buildingId, animalId) {
    var b = getBuilding(buildingId);
    if (!b || !b.inhabitants) return;
    var i = b.inhabitants.indexOf(animalId);
    if (i >= 0) b.inhabitants.splice(i, 1);
  }

  // Which building type does this animal want to live in?
  function neededTypeForAnimal(a) {
    if (!a) return null;
    try {
      if (D.isCow && D.isCow(a.breed)) return 'barn';
      var def = (D.animalsById && D.animalsById[a.breed]) || (D.species && D.species[a.breed]);
      return (def && def.buildingNeeded) || null;
    } catch (e) { return null; }
  }
  // Find a home (other than excludeId) that can take this animal on eviction.
  function suitableHomeFor(a, excludeId) {
    var s = state(); if (!s) return null;
    var want = neededTypeForAnimal(a);
    // preferred: exact needed type (barns also satisfied by barn_big for cows)
    var prefTypes = [];
    if (want === 'barn') prefTypes = ['barn', 'barn_big'];
    else if (want) prefTypes = [want];
    var i, b;
    for (i = 0; i < s.buildings.length; i++) {
      b = s.buildings[i];
      if (b.id === excludeId) continue;
      if (prefTypes.indexOf(b.type) >= 0 && hasFreeSpace(b)) return b;
    }
    // fallback: any animal-house with free space
    for (i = 0; i < s.buildings.length; i++) {
      b = s.buildings[i];
      if (b.id === excludeId) continue;
      if (ANIMAL_HOUSE[b.type] && hasFreeSpace(b)) return b;
    }
    return null;
  }

  // ---------- remove ----------
  function remove(buildingId) {
    try {
      var s = state();
      var b = getBuilding(buildingId);
      if (!s || !b) return false;

      // 1) evict inhabitants to another suitable home, else let them wander
      var occupants = (b.inhabitants || []).slice();
      var Animals = Game.Animals || null;
      occupants.forEach(function (aId) {
        var a = (Animals && Animals.get) ? Animals.get(aId) : null;
        var home = suitableHomeFor(a, buildingId);
        if (home) {
          if (!home.inhabitants) home.inhabitants = [];
          if (home.inhabitants.indexOf(aId) < 0) home.inhabitants.push(aId);
          if (a) a.homeBuildingId = home.id;
        } else if (a) {
          a.homeBuildingId = null; // wander freely (soft, never punished)
        }
      });
      b.inhabitants = [];

      // 2) free the tiles: restore walkable grass, clear ownership
      var g = s.grid;
      for (var yy = b.ty; yy < b.ty + b.h; yy++) {
        for (var xx = b.tx; xx < b.tx + b.w; xx++) {
          if (xx < 0 || yy < 0 || xx >= g.w || yy >= g.h) continue;
          var t = g.tiles[idx(g, xx, yy)];
          if (t.buildingId === buildingId) t.buildingId = null;
          t.walkable = true;
          if (t.terrain !== 'water') t.terrain = 'grass';
        }
      }

      // 3) refund ~90% of build cost
      var def = bdef(b.type);
      var buildCost = (def && def.buildCost) || 0;
      var refund = Math.round(buildCost * refundPct());
      var E = eco();
      if (E && E.credit && refund > 0) E.credit(refund, 'build:remove:' + b.type);

      // 4) splice out of the buildings list
      var i = s.buildings.indexOf(b);
      if (i >= 0) s.buildings.splice(i, 1);

      bus.emit('build:remove', { buildingId: buildingId, type: b.type });
      notify((def ? def.name : '建物') + 'をかたづけたよ（+' + U.formatG(refund) + '）', def ? def.emoji : '📦', 'good');
      return true;
    } catch (e) {
      Game._recordError('World.remove', e);
      return false;
    }
  }

  // ---------- upgrade ----------
  var GENERIC_MAX_LEVEL = 3;
  function upgradeTiers(type) {
    var rp = D.referencePrices || {};
    var t = rp.buildingUpgradeTiers || {};
    return t[type] || null;
  }
  function upgradeCost(b) {
    var tiers = upgradeTiers(b.type);
    if (tiers) {
      // tiers[0] = base build (level 1). Cost to reach level L+1 = tiers[L].
      if (b.level >= tiers.length) return null; // maxed
      return tiers[b.level];
    }
    var def = bdef(b.type);
    var base = (def && def.buildCost) || 0;
    if (b.level >= GENERIC_MAX_LEVEL) return null;
    // gentle escalating cost for buildings without an explicit tier table
    return Math.round(base * (0.75 + 0.55 * b.level));
  }
  function upgrade(buildingId) {
    try {
      var b = getBuilding(buildingId);
      if (!b) return false;
      var def = bdef(b.type);
      var cost = upgradeCost(b);
      if (cost == null) {
        notify((def ? def.name : '建物') + 'はもう最高レベルだよ', def ? def.emoji : '⭐', 'info');
        return false;
      }
      var E = eco();
      if (E && E.canAfford && !E.canAfford(cost)) {
        notify('改築には ' + U.formatG(cost) + ' 必要だよ', def ? def.emoji : '🔨', 'warn');
        try { if (Game.Audio && Game.Audio.sfx) Game.Audio.sfx('error'); } catch (e) { }
        return false;
      }
      if (E && E.debit && cost > 0) {
        if (!E.debit(cost, 'upgrade:' + b.type)) {
          notify('おかねが足りないよ', def ? def.emoji : '🔨', 'warn');
          return false;
        }
      }
      b.level = (b.level || 1) + 1;
      // capacity buildings (animal houses & storage) grow with level
      var baseCap = (def && def.capacity) || 0;
      if (baseCap > 0) {
        var inc = Math.max(1, Math.round(baseCap * 0.5));
        b.capacity = (b.capacity || 0) + inc;
      }
      bus.emit('build', { buildingId: b.id, type: b.type, tx: b.tx, ty: b.ty, upgrade: true });
      notify((def ? def.name : '建物') + 'をLv' + b.level + 'に改築したよ！', def ? def.emoji : '⭐', 'good');
      sparkleAt(b);
      try { if (Game.Audio && Game.Audio.sfx) Game.Audio.sfx('levelup'); } catch (e) { }
      return true;
    } catch (e) {
      Game._recordError('World.upgrade', e);
      return false;
    }
  }

  // ---------- spawn / AI tile search ----------
  // BFS-style expanding ring search for a walkable, empty tile near (tx,ty).
  function freeTileNear(tx, ty, pred) {
    var g = grid();
    if (!g) return null;
    var test = function (x, y) {
      if (!isWalkable(x, y)) return false;
      var t = tileAt(x, y);
      if (!t || t.cropId != null || t.buildingId != null) return false;
      if (pred) { try { return !!pred(t, x, y); } catch (e) { return false; } }
      return true;
    };
    if (test(tx, ty)) return { tx: tx, ty: ty };
    var maxR = Math.max(g.w, g.h);
    for (var r = 1; r <= maxR; r++) {
      // walk the perimeter of the Chebyshev ring at radius r
      for (var dx = -r; dx <= r; dx++) {
        var topY = ty - r, botY = ty + r, x = tx + dx;
        if (test(x, topY)) return { tx: x, ty: topY };
        if (test(x, botY)) return { tx: x, ty: botY };
      }
      for (var dy = -r + 1; dy <= r - 1; dy++) {
        var leftX = tx - r, rightX = tx + r, y = ty + dy;
        if (test(leftX, y)) return { tx: leftX, ty: y };
        if (test(rightX, y)) return { tx: rightX, ty: y };
      }
    }
    return null;
  }

  // ---------- land plots (v1: fully unlocked) ----------
  function buyPlot(n) {
    return { ok: false, reason: '全区画開放済み' };
  }

  // ---------- lifecycle ----------
  function init(ctx) {
    // Nothing to wire: world content is created by State.newGame/Save.load.
    // All heavy per-day work belongs to other modules; World is query-driven.
  }
  function update(steps) {
    // World has no per-tick simulation (cosmetic-free). Intentionally trivial.
  }

  return {
    init: init,
    update: update,
    tileAt: tileAt,
    inBounds: inBounds,
    isWalkable: isWalkable,
    canPlace: canPlace,
    place: place,
    remove: remove,
    buildingAt: buildingAt,
    getBuilding: getBuilding,
    buildingsOfType: buildingsOfType,
    upgrade: upgrade,
    freeTileNear: freeTileNear,
    capacityFor: capacityFor,
    addInhabitant: addInhabitant,
    removeInhabitant: removeInhabitant,
    buyPlot: buyPlot
  };
})();
