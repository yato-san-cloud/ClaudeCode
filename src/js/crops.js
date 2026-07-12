/*
 * crops.js — Game.Crops: plant / grow / water / harvest crop entities on tiles.
 * Owns: state.crops, state.nextCropId (+ writes tile.cropId on the World grid).
 *
 * THE DAILY MODEL: all growth, withering and regrow happen once per in-game day
 * inside the bus.on('day:advance', ...) handler registered in init(). update(steps)
 * is per-tick and COSMETIC ONLY (a global sway phase for render) — it never grows
 * crops, so fast-forward (which fires day:advance with no update() calls) stays exact.
 *
 * Numbers come from Game.DATA.cropsBalance (mechanics source of truth) merged with
 * Game.DATA.crops (display fields). Cross-module calls (World/Economy/Audio) are made
 * only inside functions and are always null-guarded.
 */
Game.Crops = (function () {
  'use strict';
  var U = Game.Util, D = Game.DATA;
  var bus = Game.bus;
  var TILE = (D.const && D.const.TILE) || 48;

  // ---- balance tables (frozen, safe to read at eval time) ----
  var CB = D.cropsBalance || {};
  var TABLE = CB.table || {};
  var WE = CB.waterEffect || { watered: 1, dry: 0.45, sprinklerAuto: 1 };
  var SE = CB.seasonEffect || { inSeason: 1.15, neutral: 1, offSeason: 0.5, deadSeason: 0 };
  var FE = CB.fertilizerEffect || { none: 1, manure: 1.25 };
  var WF = CB.weatherEffect || { sunny: 1.05, cloudy: 1, rainy: 1, snowy: 0.6 };
  var WR = CB.witherRules || {};
  var RAIN_WATERS = CB.rainWaters !== false;
  var DRY_TO_WILT = WR.dryDaysToWilt != null ? WR.dryDaysToWilt : 3;
  var DRY_TO_WITHER = WR.dryDaysToWither != null ? WR.dryDaysToWither : 5;
  var WITHER_MANURE = WR.witherProducesManure != null ? WR.witherProducesManure : 1;
  var WINTER_KILLS = WR.winterKillsNonHardy !== false;
  var OVERRIPE_DAYS = WR.overripeDaysToQualityLoss != null ? WR.overripeDaysToQualityLoss : 3;
  var OVERRIPE_MULT = WR.overripeSellMult != null ? WR.overripeSellMult : 0.7;
  var GROW_MULT_DEFAULT = CB.cropGrowMultDefault != null ? CB.cropGrowMultDefault : 1;

  var HARDY = {};
  (CB.hardyCrops || []).forEach(function (id) { HARDY[id] = true; });

  // ---- small guarded cross-module helpers (runtime only) ----
  function econ() { return Game.Economy || null; }
  function world() { return Game.World || null; }
  function sfx(id) { try { if (Game.Audio && Game.Audio.sfx) Game.Audio.sfx(id); } catch (e) { /* audio optional */ } }
  function notify(text, kind, icon) {
    try { bus.emit('notify', { text: text, kind: kind || 'info', icon: icon || '🌱', ttl: 2600 }); } catch (e) { /* ignore */ }
  }
  function particlesOn() {
    var s = Game.state;
    return !s || !s.settings || s.settings.showParticles !== false;
  }

  // Resolve a tile object, preferring World's accessor, falling back to the raw grid.
  function getTile(tx, ty) {
    var W = world();
    if (W && W.tileAt) { var t = W.tileAt(tx, ty); if (t) return t; }
    var g = Game.state && Game.state.grid;
    if (!g) return null;
    if (tx < 0 || ty < 0 || tx >= g.w || ty >= g.h) return null;
    return g.tiles[ty * g.w + tx];
  }

  // Merge balance table (mechanics) + content crop (display) into one def.
  function cropDef(cropId) {
    var content = D.crops[cropId];
    var tbl = TABLE[cropId];
    if (!content && !tbl) return null;
    content = content || {};
    tbl = tbl || {};
    var growDays = tbl.growDays != null ? tbl.growDays : (content.growDays != null ? content.growDays : 3);
    return {
      id: cropId,
      name: content.name || cropId,
      emoji: content.emoji || '🌱',
      growDays: growDays > 0 ? growDays : 1,
      yield: tbl.yield != null ? tbl.yield : (content.yieldAmount != null ? content.yieldAmount : 1),
      season: tbl.season || content.season || [],
      hardy: !!tbl.hardy || !!HARDY[cropId],
      regrow: !!tbl.regrow,
      regrowDays: tbl.regrowDays != null ? tbl.regrowDays : growDays,
      decor: !!tbl.decor || !!content.isDecor,
      seedPrice: content.seedPrice != null ? content.seedPrice : (tbl.seedCost || 0)
    };
  }

  // Season multiplier; 0 => deadSeason (crop cannot progress / will wither).
  function seasonEffectFor(def, season) {
    if (!def.season || !def.season.length) return SE.neutral;
    if (def.season.indexOf(season) >= 0) return SE.inSeason;
    if (season === 'winter' && WINTER_KILLS && !def.hardy) return SE.deadSeason;
    return SE.offSeason; // off-season (and hardy crops in winter) grow slowly
  }

  function stageFromGrowth(g) {
    if (g < 0.25) return 0; // seed
    if (g < 0.6) return 1;  // sprout
    if (g < 1) return 2;    // growing
    return 3;               // ready
  }

  // Does the ranch auto-water crops each morning (sprinkler / auto-water upgrade)?
  function hasAutoWater() {
    var E = econ();
    if (!E) return false;
    try {
      if (E.hasUpgrade && (E.hasUpgrade('sprinkler_network') || E.hasUpgrade('auto_water') || E.hasUpgrade('sprinkler'))) return true;
      if (E.upgradeMult) { var m = E.upgradeMult('autoWater'); if (m && m > 1) return true; }
    } catch (e) { /* economy optional */ }
    return false;
  }

  function cropGrowMult() {
    var E = econ();
    if (E && E.upgradeMult) {
      try { var m = E.upgradeMult('cropGrow'); if (m && m > 0) return m; } catch (e) { /* ignore */ }
    }
    return GROW_MULT_DEFAULT || 1;
  }

  function cropYieldMult() {
    var E = econ();
    if (E && E.upgradeMult) {
      try { var m = E.upgradeMult('cropYield'); if (m && m > 0) return m; } catch (e) { /* ignore */ }
    }
    return 1;
  }

  function hasManure() {
    var E = econ();
    if (E && E.itemCount) { try { return E.itemCount('manure') > 0; } catch (e) { /* ignore */ } }
    return false;
  }

  function removeCrop(crop) {
    var s = Game.state;
    if (s && s.crops) { var i = s.crops.indexOf(crop); if (i >= 0) s.crops.splice(i, 1); }
    var t = getTile(crop.tx, crop.ty);
    if (t && t.cropId === crop.id) t.cropId = null;
    crop.dead = true;
  }

  function witherCrop(crop, def) {
    var E = econ();
    try { if (E && E.addItem && WITHER_MANURE > 0) E.addItem('manure', WITHER_MANURE); } catch (e) { /* ignore */ }
    notify(((def && def.name) || '作物') + 'が枯れちゃった…たいひが少し残ったよ', 'warn', '🥀');
    removeCrop(crop);
  }

  // ---------- daily simulation (registered on day:advance) ----------
  function processDay() {
    var s = Game.state;
    if (!s || !s.crops || !s.crops.length) return;
    var season = s.season, weather = s.weather;
    var auto = hasAutoWater();
    var rainy = RAIN_WATERS && weather === 'rainy';
    var fertEff = hasManure() ? FE.manure : FE.none;
    var weatherEff = WF[weather] != null ? WF[weather] : 1;
    var growMult = cropGrowMult();

    // iterate a snapshot so wither/removal during the loop is safe
    var list = s.crops.slice();
    for (var i = 0; i < list.length; i++) {
      var crop = list[i];
      if (!crop || crop.dead) continue;
      try {
        var def = cropDef(crop.cropId);
        if (!def) { removeCrop(crop); continue; }

        var seasonEff = seasonEffectFor(def, season);
        // deadSeason (winter kills non-hardy): the crop cannot survive
        if (seasonEff === 0) { witherCrop(crop, def); continue; }

        // watered today? manual flag OR rain OR auto-water rig
        var watered = crop.watered || rainy || auto;
        if (watered) { crop.dryDays = 0; crop.wilted = false; }
        else {
          crop.dryDays = (crop.dryDays || 0) + 1;
          if (crop.dryDays >= DRY_TO_WITHER) { witherCrop(crop, def); continue; }
          if (crop.dryDays >= DRY_TO_WILT) crop.wilted = true;
        }
        var waterEff = watered ? WE.watered : WE.dry;

        if (crop.growth >= 1) {
          // already ripe — track over-ripening (soft quality loss, never punishing)
          crop.overripeDays = (crop.overripeDays || 0) + 1;
          if (crop.overripeDays >= OVERRIPE_DAYS) crop.overripe = true;
        } else {
          var perDay = (1 / (def.growDays * growMult)) * waterEff * seasonEff * fertEff * weatherEff;
          if (perDay > 0) crop.growth += perDay;
          if (crop.growth > 1) crop.growth = 1;
          if (crop.growth >= 1 && !crop._readyEmitted) {
            crop._readyEmitted = true;
            crop.stage = 3;
            try { bus.emit('crop:ready', { id: crop.id, cropId: crop.cropId, tx: crop.tx, ty: crop.ty }); } catch (e2) { /* ignore */ }
            notify(def.emoji + ' ' + def.name + 'がしゅうかくできるよ！', 'good', def.emoji);
          }
        }

        crop.stage = stageFromGrowth(crop.growth);
        crop.watered = false; // consume today's watering; must re-water tomorrow
      } catch (e) {
        Game._recordError('Crops.processDay', e);
      }
    }
  }

  // ---------- public API ----------
  function canPlant(cropId, tx, ty) {
    var def = cropDef(cropId);
    if (!def) return { ok: false, reason: 'その作物は植えられないよ' };
    var W = world();
    if (W && W.inBounds && !W.inBounds(tx, ty)) return { ok: false, reason: '牧場の外だよ' };
    var t = getTile(tx, ty);
    if (!t) return { ok: false, reason: '牧場の外だよ' };
    if (t.unlocked === false) return { ok: false, reason: 'まだ開放されていない区画だよ' };
    if (t.terrain === 'water') return { ok: false, reason: '水の上には植えられないよ' };
    if (t.buildingId != null) return { ok: false, reason: '建物があるよ' };
    if (t.cropId != null) return { ok: false, reason: 'すでに作物があるよ' };
    if (!(t.terrain === 'grass' || t.terrain === 'dirt' || t.terrain === 'path')) return { ok: false, reason: 'ここには植えられないよ' };
    if (t.walkable === false) return { ok: false, reason: 'ここには植えられないよ' };
    var seff = seasonEffectFor(def, Game.state.season);
    if (seff === 0) return { ok: false, reason: def.name + 'は今の季節だと枯れちゃう' };
    var offSeason = def.season && def.season.length && def.season.indexOf(Game.state.season) < 0;
    return { ok: true, reason: offSeason ? '季節はずれ：ゆっくり育つよ' : null, offSeason: !!offSeason };
  }

  function plant(cropId, tx, ty) {
    try {
      var chk = canPlant(cropId, tx, ty);
      if (!chk.ok) { notify(chk.reason || 'ここには植えられないよ', 'warn'); sfx('error'); return -1; }
      var s = Game.state;
      var have = (s.seeds && s.seeds[cropId]) || 0;
      if (have < 1) { notify((cropDef(cropId).name || 'タネ') + 'のタネがないよ', 'warn', '🌰'); sfx('error'); return -1; }
      s.seeds[cropId] = have - 1;

      var id = U.uid(s, 'nextCropId');
      var crop = {
        id: id, cropId: cropId, tx: tx, ty: ty,
        stage: 0, growth: 0, watered: false, plantedTick: s.tick, dead: false,
        dryDays: 0, wilted: false, overripeDays: 0, overripe: false, _readyEmitted: false
      };
      s.crops.push(crop);

      var t = getTile(tx, ty);
      if (t) { t.cropId = id; if (t.terrain === 'grass' || t.terrain === 'path') t.terrain = 'dirt'; }

      try { bus.emit('crop:plant', { id: id, cropId: cropId, tx: tx, ty: ty }); } catch (e2) { /* ignore */ }
      if (particlesOn()) { try { bus.emit('fx:sparkle', { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE }); } catch (e3) { /* ignore */ } }
      sfx('plant');
      return id;
    } catch (e) {
      Game._recordError('Crops.plant', e);
      return -1;
    }
  }

  function water(tx, ty) {
    try {
      var crop = cropAt(tx, ty);
      if (!crop) return false;
      crop.watered = true;
      crop.dryDays = 0;
      crop.wilted = false;
      if (particlesOn()) { try { bus.emit('fx:sparkle', { x: (tx + 0.5) * TILE, y: (ty + 0.35) * TILE }); } catch (e2) { /* ignore */ } }
      sfx('pop');
      return true;
    } catch (e) {
      Game._recordError('Crops.water', e);
      return false;
    }
  }

  function harvest(tx, ty) {
    try {
      var crop = cropAt(tx, ty);
      if (!crop) return { ok: false, reason: 'ここには作物がないよ' };
      if (crop.growth < 1) return { ok: false, reason: 'まだ育っていないよ' };
      var def = cropDef(crop.cropId) || { yield: 1, regrow: false, name: '作物', growDays: 1, regrowDays: 1 };

      var qty = Math.max(1, Math.round((def.yield || 1) * cropYieldMult()));
      if (crop.overripe) qty = Math.max(1, Math.round(qty * OVERRIPE_MULT));
      var itemId = crop.cropId; // produce/feed item shares the crop id

      var E = econ();
      if (E && E.addItem) E.addItem(itemId, qty);
      if (E && E.stat) E.stat('cropsHarvested', qty);

      var wx = (tx + 0.5) * TILE, wy = (ty + 0.4) * TILE;
      try { bus.emit('crop:harvest', { id: crop.id, cropId: crop.cropId, itemId: itemId, qty: qty }); } catch (e2) { /* ignore */ }
      if (particlesOn()) { try { bus.emit('fx:sparkle', { x: wx, y: wy }); } catch (e3) { /* ignore */ } }
      sfx('harvest');
      notify(def.emoji + ' ' + def.name + ' ×' + qty + ' をしゅうかく！', 'good', def.emoji);

      if (def.regrow) {
        // regrow: fall back to an earlier stage instead of vanishing
        var back = def.regrowDays / Math.max(1, def.growDays);
        crop.growth = U.clamp(1 - back, 0.05, 0.9);
        crop.stage = stageFromGrowth(crop.growth);
        crop.dead = false;
        crop.watered = false;
        crop.dryDays = 0;
        crop.wilted = false;
        crop.overripe = false;
        crop.overripeDays = 0;
        crop._readyEmitted = false;
      } else {
        removeCrop(crop);
      }
      return { ok: true, itemId: itemId, qty: qty };
    } catch (e) {
      Game._recordError('Crops.harvest', e);
      return { ok: false, reason: 'しゅうかくに失敗しちゃった' };
    }
  }

  function cropAt(tx, ty) {
    var s = Game.state;
    if (!s || !s.crops) return null;
    for (var i = 0; i < s.crops.length; i++) {
      var c = s.crops[i];
      if (c && !c.dead && c.tx === tx && c.ty === ty) return c;
    }
    return null;
  }

  function cropById(id) {
    var s = Game.state;
    if (!s || !s.crops) return null;
    for (var i = 0; i < s.crops.length; i++) { if (s.crops[i] && s.crops[i].id === id) return s.crops[i]; }
    return null;
  }

  function isReady(id) {
    var c = cropById(id);
    return !!(c && !c.dead && c.growth >= 1);
  }

  function stageOf(crop) {
    if (!crop) return 0;
    return stageFromGrowth(crop.growth || 0);
  }

  // ---------- cosmetic per-tick (NO growth here — see processDay) ----------
  var _swayPhase = 0;
  function update(steps) {
    var s = Game.state;
    if (!s) return;
    if (s.settings && s.settings.reduceMotion) return;
    // advance a global sway phase used by Render for gentle crop bobbing.
    _swayPhase = (_swayPhase + 0.05 * (steps || 1)) % 6.28318;
  }
  function swayPhase() { return _swayPhase; }

  // ---------- init / wiring ----------
  var _unsubs = [];
  function init() {
    for (var i = 0; i < _unsubs.length; i++) { try { _unsubs[i](); } catch (e) { /* ignore */ } }
    _unsubs = [];
    _unsubs.push(bus.on('day:advance', function () {
      try { processDay(); } catch (e) { Game._recordError('Crops.day:advance', e); }
    }));
    // auto-water rig: freshen the visual watered flag each morning (growth already
    // accounts for auto-water in processDay; this keeps sprites looking dewy).
    _unsubs.push(bus.on('day:break', function () {
      try {
        if (!hasAutoWater()) return;
        var s = Game.state;
        if (!s || !s.crops) return;
        for (var k = 0; k < s.crops.length; k++) { var c = s.crops[k]; if (c && !c.dead) { c.watered = true; c.wilted = false; } }
      } catch (e) { Game._recordError('Crops.autoWater', e); }
    }));
  }

  return {
    init: init,
    update: update,
    canPlant: canPlant,
    plant: plant,
    water: water,
    harvest: harvest,
    cropAt: cropAt,
    isReady: isReady,
    stageOf: stageOf,
    // extras used by Render/UI (safe read-only helpers)
    cropDef: cropDef,
    stageFromGrowth: stageFromGrowth,
    swayPhase: swayPhase
  };
})();
