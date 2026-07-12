/*
 * animals.js — Game.Animals: the heart of the ranch.
 * Owns: state.animals, state.nextAnimalId.
 *
 * THE DAILY MODEL (critical): every heavy piece of simulation — need decay,
 * feeding, happiness/health, aging, gestation/birth, and PRODUCTION — happens
 * exactly once per in-game day inside the bus.on('day:advance', ...) handler
 * registered in init(). It runs AFTER Crops (Animals init after Crops, and the
 * bus dispatches handlers in registration order). update(steps) is per-tick and
 * COSMETIC ONLY (gentle wander, blink, hop) so fast-forward — which fires
 * day:advance with no update() calls — stays exact and deterministic.
 *
 * Discipline honored: numbers from Game.DATA; money via Economy.debit/credit,
 * inventory via Economy.addItem/removeItem; gameplay randomness via Game.Util.rng
 * (only inside day:advance / player actions), cosmetic jitter via Game.Util.hash01
 * (in update, never rng); every cross-module ref resolved inside functions with
 * null-guards; risky work wrapped in try/catch + Game._recordError. Neglect is
 * SOFT — animals never die, never bankrupt; low needs only soften yield/quality.
 */
Game.Animals = (function () {
  'use strict';
  var U = Game.Util, D = Game.DATA, K = D.const;
  var bus = Game.bus;
  var TILE = (K && K.TILE) || 48;

  // ---- frozen balance snapshots (safe to read at eval time) ----
  var NEEDS = D.needs || {};
  var THR = NEEDS.thresholds || {};
  var BR = D.breeding || {};
  var PROD = D.production || {};
  var BYBREED = PROD.byBreed || {};
  var OTHER = PROD.otherAnimals || {};
  var MILKY = PROD.milkYield || {};
  var QUAL = PROD.quality || {};
  var FEED = D.feed || {};
  var FEEDITEMS = FEED.feedItems || {};
  var TRAITS = D.speciesTraits || {};
  var AUR = D.auras || {};
  var RP = D.referencePrices || {};
  var NW = D.netWorthSpec || {};

  // ---- numeric constants with gentle fallbacks ----
  var HUNGER_DECAY = num(NEEDS.hungerDecayPerDay, 40);
  var HUNGER_WMULT = NEEDS.hungerDecayWeatherMult || { sunny: 1, cloudy: 1, rainy: 1.05, snowy: 1.2 };
  var CLEAN_DECAY = num(NEEDS.cleanlinessDecayPerDay, 30);
  var CLEAN_WMULT = NEEDS.cleanlinessDecayWeatherMult || { sunny: 1, cloudy: 1, rainy: 1.6, snowy: 1.3 };
  var CLEAN_RESTORE = NEEDS.cleanRestore || { sweep: 60, groom: 45, wellWater: 40, sprinklerAuto: 25 };
  var HAP_BASE = num(NEEDS.happinessBase, 45);
  var HAP_FED = num(NEEDS.happinessFromFed, 25);
  var HAP_CLEAN = num(NEEDS.happinessFromClean, 15);
  var HAP_PET = num(NEEDS.happinessFromPet, 18);
  var HAP_SHELTER = num(NEEDS.happinessFromShelter, 6);
  var HAP_EASE = num(NEEDS.happinessEasePerDay, 0.5);
  var HAP_WPEN = NEEDS.happinessWeatherPenaltyUnsheltered || { sunny: 0, cloudy: -2, rainy: -6, snowy: -8 };
  var PET_DECAY = num(NEEDS.petDecayPerDay, 12);
  var PET_MAXSTACKS = num(NEEDS.petMaxStacks, 3);
  var PET_PERTAP = num(NEEDS.petPerTapHappiness, 6);
  var PET_MAX = PET_PERTAP * PET_MAXSTACKS; // hard cap on the pet-love bonus
  var COMPANION_CAP = num(NEEDS.companionAuraCap, 24);
  var HEALTH_HAPPY = num(NEEDS.healthFromHappyPerDay, 8);
  var HEALTH_STARVE = num(NEEDS.healthLossFromStarvingPerDay, 10);
  var HEALTH_DIRTY = num(NEEDS.healthLossFromDirtyPerDay, 5);
  var HEALTH_PULL = num(NEEDS.healthBaselinePull, 60);
  var HEALTH_PULL_EASE = num(NEEDS.healthBaselineEasePerDay, 0.1);

  var T_STARVE = num(THR.starving, 20);
  var T_HUNGRY = num(THR.hungry, 45);
  var T_DIRTY = num(THR.dirty, 35);
  var T_SICK = num(THR.sick, 30);
  var T_HAPPY = num(THR.happy, 75);

  var HEAT_STRESS = num(MILKY.heatStress, 0.25);
  var COLD_STRESS = num(MILKY.coldStress, 0.30);
  var MILK_CAP_DAYS = num(MILKY.uncollectedCapDays, 2);

  var MIN_HAPPY_BREED = num(BR.minHappinessToBreed, 65);
  var MIN_HEALTH_BREED = num(BR.minHealthToBreed, 55);
  var MIN_AGE_BREED = num(BR.minAgeDaysToBreed, 8);
  var GESTATION = BR.gestationDays || { default: 6 };
  var COOLDOWN = BR.cooldownDays || { default: 5 };
  var BABYGROW = BR.babyGrowthDays || { default: 5 };
  var TWINS = BR.chanceOfTwins || { default: 0.08 };
  var OFF = BR.offspringInheritRules || {};
  var RARE_CHANCE = num(OFF.rareTraitChance, 0.03);
  var RARE_TRAITS = OFF.rareTraits || ['sparkle_coat', 'heterochromia', 'golden'];
  var RARE_AURA = num(OFF.rareTraitHappinessAura, 3);
  var BABY_SCALE = num(OFF.babyScale, 0.6);

  var ANIMAL_VALUE_PCT = num(NW.animalValuePct, 0.70);
  var BABY_VALUE_PCT = num(NW.babyAnimalValuePct, 0.40);

  // Feed auto-selection preference: premium first, treats last.
  var FEED_PREF = ['alfalfa', 'corn', 'wheat', 'hay', 'clover', 'carrot', 'grass'];

  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function clamp01to100(v) { return v < 0 ? 0 : (v > 100 ? 100 : v); }
  function cheb(ax, ay, bx, by) { var dx = Math.abs(ax - bx), dy = Math.abs(ay - by); return dx > dy ? dx : dy; }

  // ---- guarded cross-module accessors (runtime only) ----
  function state() { return Game.state; }
  function eco() { return Game.Economy || null; }
  function world() { return Game.World || null; }
  function sfx(id) { try { if (Game.Audio && Game.Audio.sfx) Game.Audio.sfx(id); } catch (e) { /* audio optional */ } }
  function notify(text, kind, icon, ttl) {
    try { bus.emit('notify', { text: text, kind: kind || 'info', icon: icon || '🐮', ttl: ttl || 2600 }); }
    catch (e) { /* ignore */ }
  }
  function particlesOn() {
    var s = state();
    return !s || !s.settings || s.settings.showParticles !== false;
  }
  function reduceMotion() {
    var s = state();
    return !!(s && s.settings && s.settings.reduceMotion);
  }

  // Species / breed definition lookups.
  function isCow(breedId) { try { return !!(D.isCow && D.isCow(breedId)); } catch (e) { return false; } }
  function speciesDef(breedId) { return (D.species && D.species[breedId]) || (D.animalsById && D.animalsById[breedId]) || (D.breeds && D.breeds[breedId]) || null; }
  function speciesIdOf(a) { return a ? (a.species || (isCow(a.breed) ? 'cow' : a.breed)) : null; }
  function speciesKeyForTraits(a) { return isCow(a.breed) ? a.breed : (a.species || a.breed); }

  function byBreedKey(a) {
    // returns the breeding-table key: 'cow' for cows, else the species id
    return isCow(a.breed) ? 'cow' : (a.species || a.breed);
  }

  // ---- Economy-backed helpers (all null-guarded) ----
  function safeMult(target) {
    var E = eco();
    if (E && E.upgradeMult) {
      try { var m = E.upgradeMult(target); if (typeof m === 'number' && isFinite(m) && m > 0) return m; }
      catch (e) { /* ignore */ }
    }
    return 1;
  }
  function hasFlag(name) {
    var E = eco();
    if (!E) return false;
    try {
      if (E.hasUpgrade && E.hasUpgrade(name)) return true;
      if (E.upgradeMult) { var m = E.upgradeMult(name); if (typeof m === 'number' && m !== 1 && m > 0) return true; }
    } catch (e) { /* ignore */ }
    return false;
  }
  function isAnimalUnlocked(breedId) {
    var E = eco();
    if (E && E.isUnlocked) { try { return !!E.isUnlocked('animals', breedId); } catch (e) { /* fall through */ } }
    var def = speciesDef(breedId);
    var need = (def && def.unlockRank) || 1;
    var s = state();
    return (s ? (s.rank || 1) : 1) >= need;
  }

  // ---------- lookups (public) ----------
  function get(id) {
    var s = state();
    if (!s || id == null) return null;
    var arr = s.animals;
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }
  function at(tx, ty) {
    var s = state();
    if (!s) return null;
    for (var i = 0; i < s.animals.length; i++) {
      var a = s.animals[i];
      if (a.tx === tx && a.ty === ty) return a;
    }
    return null;
  }
  function inBuilding(buildingId) {
    var s = state();
    if (!s || buildingId == null) return [];
    var out = [];
    for (var i = 0; i < s.animals.length; i++) {
      if (s.animals[i].homeBuildingId === buildingId) out.push(s.animals[i]);
    }
    return out;
  }

  function worldPos(a) {
    return {
      x: (a && a.x != null) ? a.x : ((a ? a.tx : 0) + 0.5) * TILE,
      y: (a && a.y != null) ? a.y : ((a ? a.ty : 0) + 0.5) * TILE
    };
  }
  function bump(a, key, amt) {
    if (!a || !a.needs) return;
    a.needs[key] = clamp01to100((a.needs[key] || 0) + amt);
  }

  // ---------- home / building helpers ----------
  function homeTypesFor(breedId) {
    if (isCow(breedId)) return ['barn', 'barn_big'];
    var def = speciesDef(breedId);
    var want = def && def.buildingNeeded;
    if (!want) return ['pasture', 'barn', 'barn_big', 'coop', 'pond', 'house'];
    if (want === 'barn') return ['barn', 'barn_big'];
    return [want];
  }
  function buildingsOfType(type) {
    var W = world();
    if (W && W.buildingsOfType) { try { return W.buildingsOfType(type) || []; } catch (e) { /* ignore */ } }
    var s = state(); if (!s) return [];
    return s.buildings.filter(function (b) { return b.type === type; });
  }
  function getBuilding(id) {
    var W = world();
    if (W && W.getBuilding) { try { return W.getBuilding(id); } catch (e) { /* ignore */ } }
    var s = state(); if (!s || id == null) return null;
    for (var i = 0; i < s.buildings.length; i++) if (s.buildings[i].id === id) return s.buildings[i];
    return null;
  }
  function hasFreeSpace(b) { return !!b && (b.inhabitants ? b.inhabitants.length : 0) < (b.capacity || 0); }
  function pickFreeBuilding(breedId) {
    var types = homeTypesFor(breedId);
    for (var t = 0; t < types.length; t++) {
      var list = buildingsOfType(types[t]);
      for (var i = 0; i < list.length; i++) if (hasFreeSpace(list[i])) return list[i];
    }
    return null;
  }
  function addInhabitant(buildingId, animalId) {
    var W = world();
    if (W && W.addInhabitant) { try { return !!W.addInhabitant(buildingId, animalId); } catch (e) { /* ignore */ } }
    var b = getBuilding(buildingId);
    if (!b) return false;
    if (!b.inhabitants) b.inhabitants = [];
    if (b.inhabitants.indexOf(animalId) >= 0) return true;
    if (b.inhabitants.length >= (b.capacity || 0)) return false;
    b.inhabitants.push(animalId);
    return true;
  }
  function removeInhabitant(buildingId, animalId) {
    var W = world();
    if (W && W.removeInhabitant) { try { W.removeInhabitant(buildingId, animalId); return; } catch (e) { /* ignore */ } }
    var b = getBuilding(buildingId);
    if (!b || !b.inhabitants) return;
    var i = b.inhabitants.indexOf(animalId);
    if (i >= 0) b.inhabitants.splice(i, 1);
  }
  function freeTileNear(tx, ty) {
    var W = world();
    if (W && W.freeTileNear) { try { var t = W.freeTileNear(tx, ty); if (t) return t; } catch (e) { /* ignore */ } }
    // fallback: scan a small ring
    for (var r = 0; r <= 6; r++) {
      for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
        var x = tx + dx, y = ty + dy;
        if (W && W.isWalkable && W.isWalkable(x, y)) return { tx: x, ty: y };
      }
    }
    return { tx: tx, ty: ty };
  }
  function buildingCenterTile(b) { return { tx: (b.tx + (b.w || 1) / 2) | 0, ty: (b.ty + (b.h || 1) / 2) | 0 }; }

  // ---------- spawn ----------
  function spawn(breedId, tx, ty, opts) {
    try {
      var s = state();
      if (!s) return -1;
      opts = opts || {};
      var a = Game.State.makeAnimal(s, breedId, tx, ty, opts);
      if (!a) return -1;
      // assign a home building if requested (and it has room)
      var homeId = opts.homeBuildingId != null ? opts.homeBuildingId : a.homeBuildingId;
      if (homeId != null) {
        if (addInhabitant(homeId, a.id)) a.homeBuildingId = homeId;
        else a.homeBuildingId = null; // no room -> free-range (soft, never punished)
      }
      // maxAnimals stat
      var E = eco();
      if (E && E.stat) { try { E.stat('maxAnimals', 0); } catch (e) { /* ignore */ } }
      if (s.stats && s.animals.length > (s.stats.maxAnimals || 0)) s.stats.maxAnimals = s.animals.length;

      try { bus.emit('animal:spawn', { id: a.id, breed: a.breed, tx: a.tx, ty: a.ty }); } catch (e2) { /* ignore */ }
      return a.id;
    } catch (e) {
      Game._recordError('Animals.spawn', e);
      return -1;
    }
  }

  // ---------- buy ----------
  function priceFor(breedId) {
    var def = speciesDef(breedId);
    if (def && def.buyPrice != null) return def.buyPrice;
    var ra = RP.animals || {};
    if (ra[breedId] != null) return ra[breedId];
    return 500;
  }
  function buy(breedId, buildingId) {
    try {
      var s = state();
      if (!s) return { ok: false, reason: 'まだ準備中だよ' };
      var def = speciesDef(breedId);
      if (!def) return { ok: false, reason: 'その動物はいないよ' };

      // unlock / rank gate
      if (!isAnimalUnlocked(breedId)) {
        var need = (def.unlockRank || 1);
        var r = { ok: false, reason: 'ランク' + need + 'で お迎えできるよ' };
        notify(r.reason, 'warn', def.emoji || '🔒'); sfx('error');
        return r;
      }

      // find a suitable home with free capacity
      var b = null;
      if (buildingId != null) {
        b = getBuilding(buildingId);
        var okTypes = homeTypesFor(breedId);
        if (!b || okTypes.indexOf(b.type) < 0) {
          notify('その建物には住めないよ', 'warn', def.emoji || '🏠'); sfx('error');
          return { ok: false, reason: 'その建物には住めないよ' };
        }
        if (!hasFreeSpace(b)) {
          notify((buildingLabel(b)) + 'がいっぱいだよ', 'warn', def.emoji || '🏠'); sfx('error');
          return { ok: false, reason: 'いっぱいだよ' };
        }
      } else {
        b = pickFreeBuilding(breedId);
        if (!b) {
          // Pets / utility animals (dog, cat, rabbit, horse) roam the ranch and need no
          // dedicated housing — spawn them free-range instead of failing. Livestock/poultry
          // still require a proper building.
          var isPetLike = (def.kind === 'pet' || def.kind === 'utility');
          if (!isPetLike) {
            var want = homeTypesFor(breedId)[0];
            var wantName = (D.buildings && D.buildings[want] && D.buildings[want].name) || 'おうち';
            notify(wantName + 'の あきスペースがないよ', 'warn', def.emoji || '🏠'); sfx('error');
            return { ok: false, reason: wantName + 'が必要だよ' };
          }
          // b stays null -> free-range spawn below
        }
      }

      // affordability + debit
      var cost = priceFor(breedId);
      var E = eco();
      if (E && E.canAfford && !E.canAfford(cost)) {
        notify('おかねが足りないよ（' + U.formatG(cost) + '）', 'warn', '💰'); sfx('error');
        return { ok: false, reason: 'おかねが足りないよ' };
      }
      if (E && E.debit) {
        if (!E.debit(cost, 'buyAnimal:' + breedId)) {
          notify('おかねが足りないよ', 'warn', '💰'); sfx('error');
          return { ok: false, reason: 'おかねが足りないよ' };
        }
      }

      // spawn at a free tile near the home (free-range pets spawn near the house/ranch)
      var homeId = b ? b.id : null;
      var anchor = b || buildingsOfType('house')[0] || (s.buildings && s.buildings[0]) || null;
      var spot = null;
      if (anchor) { var c = buildingCenterTile(anchor); spot = freeTileNear(anchor.tx + (anchor.w || 1), c.ty); }
      if (!spot) spot = { tx: (s.grid.w >> 1), ty: (s.grid.h >> 1) };
      var startNeeds = { hunger: 80, happiness: 70, health: 82, cleanliness: 80 };
      var temperament = 50;
      if (isCow(breedId) && BYBREED[breedId] && BYBREED[breedId].temperamentBase != null) temperament = BYBREED[breedId].temperamentBase;
      else if (OTHER[byBreedKey({ breed: breedId, species: breedId })] && OTHER[breedId] && OTHER[breedId].temperamentBase != null) temperament = OTHER[breedId].temperamentBase;

      var id = spawn(breedId, spot.tx, spot.ty, {
        adult: true, ageDays: (def.matureAgeDays || 12) + 2,
        homeBuildingId: homeId, needs: startNeeds, temperament: temperament
      });
      if (id < 0) {
        // refund if the spawn somehow failed
        if (E && E.credit && cost > 0) E.credit(cost, 'buyAnimal:refund:' + breedId);
        return { ok: false, reason: 'お迎えに失敗しちゃった' };
      }

      if (E && E.stat) { try { E.stat('animalsBought', 1); } catch (e) { /* optional key */ } }

      var a = get(id);
      var p = worldPos(a);
      if (particlesOn()) { try { bus.emit('fx:heart', { x: p.x, y: p.y - TILE * 0.4 }); } catch (e) { /* ignore */ } }
      sfx(isCow(breedId) ? 'moo' : (speciesIdOf(a) === 'chicken' || speciesIdOf(a) === 'duck' ? 'chick' : 'pop'));
      notify((def.emoji || '🐮') + ' ' + (a.name || def.name) + ' をお迎えしたよ！', 'good', def.emoji || '🐮');
      return { ok: true, id: id };
    } catch (e) {
      Game._recordError('Animals.buy', e);
      return { ok: false, reason: 'お迎えに失敗しちゃった' };
    }
  }
  function buildingLabel(b) {
    var def = b && D.buildings && D.buildings[b.type];
    return (def && def.name) || 'おうち';
  }

  // ---------- sell ----------
  function marketValue(a) {
    var ra = RP.animals || {};
    var base = (ra[a.breed] != null) ? ra[a.breed] : priceFor(a.breed);
    return base;
  }
  function sell(id) {
    try {
      var s = state();
      var a = get(id);
      if (!a) return { ok: false, total: 0 };
      var base = marketValue(a);
      var pct = a.adult ? ANIMAL_VALUE_PCT : BABY_VALUE_PCT;
      // rare traits sweeten the value a touch
      if (a.traits && a.traits.length) pct += num(OFF.rareTraitValueBonusPct, 0.25) * 0.5;
      var total = Math.max(1, Math.round(base * pct));

      // remove from home + state
      if (a.homeBuildingId != null) removeInhabitant(a.homeBuildingId, a.id);
      var i = s.animals.indexOf(a);
      if (i >= 0) s.animals.splice(i, 1);

      var E = eco();
      if (E && E.credit) E.credit(total, 'sellAnimal:' + a.breed);
      if (E && E.stat) { try { E.stat('totalSales', total); } catch (e) { /* optional */ } }

      var p = worldPos(a);
      if (particlesOn()) { try { bus.emit('fx:coin', { x: p.x, y: p.y, amount: total }); } catch (e) { /* ignore */ } }
      sfx('coin');
      var def = speciesDef(a.breed) || {};
      notify((def.emoji || '🐮') + ' ' + (a.name || def.name || '動物') + ' をお別れしたよ（+' + U.formatG(total) + '）', 'good', def.emoji || '👋');
      return { ok: true, total: total };
    } catch (e) {
      Game._recordError('Animals.sell', e);
      return { ok: false, total: 0 };
    }
  }

  // ---------- feed ----------
  function feed(id, feedItemId) {
    try {
      var a = get(id);
      if (!a) return false;
      var fi = FEEDITEMS[feedItemId];
      if (!fi) { notify('それは ごはんじゃないみたい', 'warn', '🌾'); return false; }
      var E = eco();
      if (E && E.itemCount && E.itemCount(feedItemId) < 1) {
        notify((productName(feedItemId)) + 'の ストックがないよ', 'warn', '🌾'); sfx('error');
        return false;
      }
      if (E && E.removeItem) {
        if (!E.removeItem(feedItemId, 1)) { notify('ごはんが足りないよ', 'warn', '🌾'); sfx('error'); return false; }
      }
      applyFeed(a, feedItemId, fi);
      var p = worldPos(a);
      if (particlesOn()) { try { bus.emit('fx:sparkle', { x: p.x, y: p.y - TILE * 0.2 }); } catch (e) { /* ignore */ } }
      sfx('pop');
      return true;
    } catch (e) {
      Game._recordError('Animals.feed', e);
      return false;
    }
  }
  function applyFeed(a, feedItemId, fi) {
    bump(a, 'hunger', num(fi.hunger, 15));
    a.lastFeedItem = feedItemId;
    a.lastFeedQuality = num(fi.feedQuality, 0.4);
    if (fi.treatHappiness) bump(a, 'happiness', num(fi.treatHappiness, 0));
  }
  function feedBuilding(buildingId, feedItemId) {
    try {
      var members = inBuilding(buildingId);
      var n = 0;
      for (var i = 0; i < members.length; i++) {
        if (feed(members[i].id, feedItemId)) n++;
      }
      if (n > 0) notify('みんなに ごはんをあげたよ（' + n + '匹）', 'good', '🌾');
      return n;
    } catch (e) {
      Game._recordError('Animals.feedBuilding', e);
      return 0;
    }
  }

  // ---------- pet ----------
  function pet(id) {
    try {
      var a = get(id);
      if (!a) return;
      a.petBonus = Math.min(PET_MAX, (a.petBonus || 0) + PET_PERTAP);
      bump(a, 'happiness', PET_PERTAP);
      var E = eco();
      if (E && E.stat) E.stat('totalPets', 1);
      var p = worldPos(a);
      if (particlesOn()) {
        try { bus.emit('fx:heart', { x: p.x, y: p.y - TILE * 0.45 }); } catch (e) { /* ignore */ }
      }
      sfx('heart');
      // gentle mood chirp
      var sp = speciesIdOf(a);
      if (isCow(a.breed)) sfx('moo');
      else if (sp === 'chicken' || sp === 'duck') sfx('chick');
    } catch (e) {
      Game._recordError('Animals.pet', e);
    }
  }

  // ---------- clean ----------
  function clean(id) {
    try {
      var a = get(id);
      if (!a) return;
      bump(a, 'cleanliness', num(CLEAN_RESTORE.sweep, 60));
      bump(a, 'happiness', 2);
      var p = worldPos(a);
      if (particlesOn()) { try { bus.emit('fx:sparkle', { x: p.x, y: p.y - TILE * 0.3 }); } catch (e) { /* ignore */ } }
      sfx('pop');
    } catch (e) {
      Game._recordError('Animals.clean', e);
    }
  }

  // ---------- collect ----------
  function statKeyFor(itemId) {
    if (itemId === 'milk' || itemId === 'quality_milk') return 'totalMilk';
    if (itemId === 'egg') return 'totalEggs';
    if (itemId === 'wool' || itemId === 'fine_wool') return 'totalWool';
    if (itemId === 'truffle') return 'totalTruffle';
    return null;
  }
  function productName(itemId) {
    var p = D.products && D.products[itemId];
    return (p && p.name) || itemId;
  }
  function productEmoji(itemId) {
    var p = D.products && D.products[itemId];
    return (p && p.emoji) || '📦';
  }
  function collect(id) {
    try {
      var a = get(id);
      if (!a || !a.production || !a.production.ready) return { ok: false, itemId: null, amount: 0 };
      var itemId = a.production.itemId;
      var amount = Math.max(0, Math.round(a.production.amount || 0));
      if (amount <= 0 || !itemId) { a.production.ready = false; a.production.amount = 0; return { ok: false, itemId: itemId, amount: 0 }; }

      var E = eco();
      if (E && E.addItem) E.addItem(itemId, amount);
      a.production.ready = false;
      a.production.amount = 0;

      try { bus.emit('animal:produce', { id: a.id, itemId: itemId, amount: amount }); } catch (e2) { /* ignore */ }
      var p = worldPos(a);
      if (particlesOn()) {
        try { bus.emit('fx:sparkle', { x: p.x, y: p.y - TILE * 0.4 }); } catch (e3) { /* ignore */ }
        try { bus.emit('fx:coin', { x: p.x, y: p.y - TILE * 0.5, amount: 0 }); } catch (e4) { /* ignore */ }
      }
      sfx('pop');
      notify(productEmoji(itemId) + ' ' + productName(itemId) + ' ×' + amount + ' をあつめたよ！', 'good', productEmoji(itemId));
      return { ok: true, itemId: itemId, amount: amount };
    } catch (e) {
      Game._recordError('Animals.collect', e);
      return { ok: false, itemId: null, amount: 0 };
    }
  }
  function collectBuilding(buildingId) {
    try {
      var members = inBuilding(buildingId);
      var items = {};
      for (var i = 0; i < members.length; i++) {
        var r = collect(members[i].id);
        if (r.ok) items[r.itemId] = (items[r.itemId] || 0) + r.amount;
      }
      return { items: items };
    } catch (e) {
      Game._recordError('Animals.collectBuilding', e);
      return { items: {} };
    }
  }

  // ---------- breeding ----------
  function canBreed(aId, bId) {
    var a = (typeof aId === 'object') ? aId : get(aId);
    var b = (typeof bId === 'object') ? bId : get(bId);
    if (!a || !b || a === b) return false;
    if (!a.adult || !b.adult) return false;
    if (speciesIdOf(a) !== speciesIdOf(b)) return false;
    // utility/pet species that produce no offspring in this ranch (dogs/cats/horses stay singular pals)
    var sp = speciesIdOf(a);
    if (sp === 'dog' || sp === 'cat' || sp === 'horse') return false;
    // need one of each sex so a mother can carry
    if (a.sex === b.sex) return false;
    if (a.pregnant || b.pregnant) return false;
    if ((a.cooldownDaysLeft || 0) > 0 || (b.cooldownDaysLeft || 0) > 0) return false;
    if ((a.ageDays || 0) < MIN_AGE_BREED || (b.ageDays || 0) < MIN_AGE_BREED) return false;
    if (a.needs.happiness < MIN_HAPPY_BREED || b.needs.happiness < MIN_HAPPY_BREED) return false;
    if (a.needs.health < MIN_HEALTH_BREED || b.needs.health < MIN_HEALTH_BREED) return false;
    return true;
  }
  function breed(aId, bId) {
    try {
      var a = (typeof aId === 'object') ? aId : get(aId);
      var b = (typeof bId === 'object') ? bId : get(bId);
      if (!a || !b) return { ok: false, reason: 'その子が見つからないよ' };
      if (a === b) return { ok: false, reason: 'ひとりでは むりだよ' };
      if (speciesIdOf(a) !== speciesIdOf(b)) return { ok: false, reason: 'おなじ種類じゃないとダメだよ' };
      var sp = speciesIdOf(a);
      if (sp === 'dog' || sp === 'cat' || sp === 'horse') return { ok: false, reason: 'この子は はんしょくできないよ' };
      if (!a.adult || !b.adult) return { ok: false, reason: 'おとな同士じゃないとダメだよ' };
      if (a.sex === b.sex) return { ok: false, reason: 'おす と めす のペアが必要だよ' };
      if (a.pregnant || b.pregnant) return { ok: false, reason: 'もう赤ちゃんがいるよ' };
      if ((a.cooldownDaysLeft || 0) > 0 || (b.cooldownDaysLeft || 0) > 0) return { ok: false, reason: 'もう少し おやすみが必要だよ' };
      if ((a.ageDays || 0) < MIN_AGE_BREED || (b.ageDays || 0) < MIN_AGE_BREED) return { ok: false, reason: 'まだ 若すぎるよ' };
      if (a.needs.happiness < MIN_HAPPY_BREED || b.needs.happiness < MIN_HAPPY_BREED) return { ok: false, reason: 'しあわせ度が足りないよ（65以上）' };
      if (a.needs.health < MIN_HEALTH_BREED || b.needs.health < MIN_HEALTH_BREED) return { ok: false, reason: '健康じゃないとダメだよ（55以上）' };

      var mother = a.sex === 'f' ? a : b;
      var father = mother === a ? b : a;
      var key = byBreedKey(a);
      mother.pregnant = true;
      mother.gestationDaysLeft = num(GESTATION[key], num(GESTATION.default, 6));
      mother.mateBreed = father.breed;
      var cd = num(COOLDOWN[key], num(COOLDOWN.default, 5));
      mother.cooldownDaysLeft = cd;
      father.cooldownDaysLeft = cd;

      var p = worldPos(mother);
      if (particlesOn()) { try { bus.emit('fx:heart', { x: p.x, y: p.y - TILE * 0.5 }); } catch (e) { /* ignore */ } }
      sfx('heart');
      var def = speciesDef(mother.breed) || {};
      notify((def.emoji || '🐮') + ' ' + (mother.name || '') + ' に 赤ちゃんが やってくるよ♪', 'good', '🍼');
      return { ok: true };
    } catch (e) {
      Game._recordError('Animals.breed', e);
      return { ok: false, reason: 'はんしょくに失敗しちゃった' };
    }
  }

  function birthFrom(mother) {
    try {
      var s = state();
      if (!s) return;
      var key = byBreedKey(mother);
      // inherited breed: same-breed parents -> that breed; else 50/50 pick a parent's breed
      var breedId = mother.breed;
      if (mother.mateBreed && mother.mateBreed !== mother.breed) {
        breedId = U.chance(0.5) ? mother.breed : mother.mateBreed;
      }
      var tA = mother.temperament != null ? mother.temperament : 50;
      var tB = tA; // father may have wandered off / been sold; bias off the mother
      var temperament = U.clamp(Math.round((tA + tB) / 2 + U.randRange(-8, 12)), 10, 100);

      var traits = [];
      if (U.chance(RARE_CHANCE)) traits.push(U.pick(RARE_TRAITS));

      var litter = 1;
      if (U.chance(num(TWINS[key], num(TWINS.default, 0.08)))) litter = 2;

      var home = mother.homeBuildingId != null ? getBuilding(mother.homeBuildingId) : null;
      for (var n = 0; n < litter; n++) {
        var spot = freeTileNear(mother.tx, mother.ty);
        var opts = {
          adult: false, ageDays: 0, temperament: temperament, traits: traits.slice(),
          needs: { hunger: 90, happiness: 85, health: 90, cleanliness: 85 }
        };
        if (home && hasFreeSpace(home)) opts.homeBuildingId = home.id;
        var babyId = spawn(breedId, spot.tx, spot.ty, opts);
        if (babyId < 0) continue;
        var baby = get(babyId);
        if (baby) { baby.babyScale = BABY_SCALE; baby._born = true; }
        try { bus.emit('animal:born', { id: babyId, breed: breedId, motherId: mother.id }); } catch (e2) { /* ignore */ }
        var E = eco();
        if (E && E.stat) E.stat('animalsBorn', 1);
        var bp = baby ? worldPos(baby) : worldPos(mother);
        if (particlesOn()) { try { bus.emit('fx:heart', { x: bp.x, y: bp.y - TILE * 0.4 }); } catch (e3) { /* ignore */ } }
      }
      sfx('heart');
      var def = speciesDef(breedId) || {};
      notify('🍼 ' + (def.name || '赤ちゃん') + 'の 赤ちゃんが 生まれたよ！' + (litter > 1 ? '（ふたご！）' : ''), 'good', '🍼');

      mother.pregnant = false;
      mother.gestationDaysLeft = 0;
      mother.mateBreed = null;
    } catch (e) {
      Game._recordError('Animals.birth', e);
      mother.pregnant = false;
      mother.gestationDaysLeft = 0;
    }
  }

  // ---------- rename / summary ----------
  function rename(id, name) {
    var a = get(id);
    if (!a) return;
    name = ('' + (name == null ? '' : name)).trim().slice(0, 12);
    if (name) a.name = name;
  }
  function needSummary(id) {
    var a = get(id);
    if (!a) return { hunger: 0, happiness: 0, health: 0, cleanliness: 0, mood: 'unknown', label: '' };
    var nh = a.needs || {};
    var mood = 'content', label = 'ごきげん';
    if (nh.hunger < T_STARVE) { mood = 'starving'; label = 'おなかぺこぺこ'; }
    else if (nh.health < T_SICK) { mood = 'sick'; label = 'ぐあいがわるそう'; }
    else if (nh.cleanliness < T_DIRTY) { mood = 'dirty'; label = 'よごれちゃった'; }
    else if (nh.hunger < T_HUNGRY) { mood = 'hungry'; label = 'おなかすいた'; }
    else if (nh.happiness >= num(THR.blissful, 88)) { mood = 'blissful'; label = 'とってもしあわせ'; }
    else if (nh.happiness >= T_HAPPY) { mood = 'happy'; label = 'うれしそう'; }
    else if (nh.happiness < num(THR.unhappy, 35)) { mood = 'unhappy'; label = 'さみしそう'; }
    return {
      hunger: Math.round(nh.hunger || 0),
      happiness: Math.round(nh.happiness || 0),
      health: Math.round(nh.health || 0),
      cleanliness: Math.round(nh.cleanliness || 0),
      mood: mood, label: label,
      adult: !!a.adult, pregnant: !!a.pregnant
    };
  }

  // ---------- resist / yield math ----------
  function resistFor(a) {
    var heat, cold;
    if (isCow(a.breed) && BYBREED[a.breed]) {
      heat = num(BYBREED[a.breed].heatResist, 0.4);
      cold = num(BYBREED[a.breed].coldResist, 0.5);
    } else {
      var tr = TRAITS[speciesKeyForTraits(a)] || {};
      heat = num(tr.heatResist, 0.5);
      cold = num(tr.coldResist, 0.5);
    }
    if (hasFlag('summer_cooler') || (eco() && eco().hasUpgrade && eco().hasUpgrade('summer_cooler'))) heat = Math.min(1, heat + 0.3);
    if (hasFlag('winter_heater') || (eco() && eco().hasUpgrade && eco().hasUpgrade('winter_heater'))) cold = Math.min(1, cold + 0.3);
    return { heat: heat, cold: cold };
  }
  function seasonMultFor(season, res) {
    if (season === 'spring') return 1.05;
    if (season === 'autumn') return 1.00;
    if (season === 'summer') return 1 - HEAT_STRESS * (1 - res.heat);
    if (season === 'winter') return 1 - COLD_STRESS * (1 - res.cold);
    return 1.0;
  }
  function coreMults(a, season) {
    var nh = a.needs || {};
    var happinessMult = U.clamp(0.40 + 0.008 * (nh.happiness || 0), 0.40, 1.20);
    var healthMult = U.clamp(0.55 + 0.0045 * (nh.health || 0), 0.55, 1.00);
    var res = resistFor(a);
    var seasonMult = seasonMultFor(season, res);
    return { happiness: happinessMult, health: healthMult, season: seasonMult };
  }
  function feedMultFor(a) {
    if ((a.needs && a.needs.hunger) < T_STARVE) return 0.70;
    var fi = FEEDITEMS[a.lastFeedItem];
    if (fi) {
      if (fi.premium || fi.tier === 'premium') return 1.15;
      if (fi.tier === 'good') return 1.05;
      return 0.95;
    }
    return 0.95;
  }
  // Stochastic rounding keeps sub-1.0/day yields fair over time (uses sim rng — only in day:advance).
  function stochRound(x) {
    if (x <= 0) return 0;
    var f = Math.floor(x);
    return f + (U.rng() < (x - f) ? 1 : 0);
  }

  // ---------- companion aura pre-compute (per day) ----------
  function buildAuraContext() {
    var s = state();
    var ctx = { miniCows: [], rabbits: [], rareAura: [], ponds: [], sunflowers: [], clovers: [], hasDog: false, hasCat: false };
    if (!s) return ctx;
    for (var i = 0; i < s.animals.length; i++) {
      var a = s.animals[i];
      var sp = speciesIdOf(a);
      if (a.breed === 'mini_cow') ctx.miniCows.push(a);
      if (sp === 'rabbit') ctx.rabbits.push(a);
      if (sp === 'dog') ctx.hasDog = true;
      if (sp === 'cat') ctx.hasCat = true;
      if (a.traits && a.traits.length) ctx.rareAura.push(a);
    }
    ctx.ponds = buildingsOfType('pond');
    if (s.crops) {
      for (var c = 0; c < s.crops.length; c++) {
        var crop = s.crops[c];
        if (!crop || crop.dead) continue;
        if (crop.cropId === 'sunflower') ctx.sunflowers.push(crop);
        else if (crop.cropId === 'clover') ctx.clovers.push(crop);
      }
    }
    return ctx;
  }
  function companionBonusFor(a, ctx) {
    var total = 0, i, src, aur;
    aur = AUR.mini_cow || { happinessAura: 6, radiusTiles: 4 };
    for (i = 0; i < ctx.miniCows.length; i++) {
      src = ctx.miniCows[i]; if (src === a) continue;
      if (cheb(a.tx, a.ty, src.tx, src.ty) <= num(aur.radiusTiles, 4)) total += num(aur.happinessAura, 6);
    }
    aur = AUR.rabbit || { happinessAura: 4, radiusTiles: 3 };
    for (i = 0; i < ctx.rabbits.length; i++) {
      src = ctx.rabbits[i]; if (src === a) continue;
      if (cheb(a.tx, a.ty, src.tx, src.ty) <= num(aur.radiusTiles, 3)) total += num(aur.happinessAura, 4);
    }
    aur = AUR.sunflower || { happinessAura: 3, radiusTiles: 2 };
    for (i = 0; i < ctx.sunflowers.length; i++) {
      src = ctx.sunflowers[i];
      if (cheb(a.tx, a.ty, src.tx, src.ty) <= num(aur.radiusTiles, 2)) { total += num(aur.happinessAura, 3); break; }
    }
    aur = AUR.clover || { happinessAura: 2, radiusTiles: 1 };
    for (i = 0; i < ctx.clovers.length; i++) {
      src = ctx.clovers[i];
      if (cheb(a.tx, a.ty, src.tx, src.ty) <= num(aur.radiusTiles, 1)) { total += num(aur.happinessAura, 2); break; }
    }
    aur = AUR.pond || { happinessAura: 3, radiusTiles: 3, duckHappinessBonus: 10 };
    for (i = 0; i < ctx.ponds.length; i++) {
      var b = ctx.ponds[i], ct = buildingCenterTile(b);
      if (cheb(a.tx, a.ty, ct.tx, ct.ty) <= num(aur.radiusTiles, 3)) {
        total += num(aur.happinessAura, 3);
        if (speciesIdOf(a) === 'duck') total += num(aur.duckHappinessBonus, 10);
        break;
      }
    }
    // rare-trait companions spread a little joy
    for (i = 0; i < ctx.rareAura.length; i++) {
      src = ctx.rareAura[i]; if (src === a) continue;
      if (cheb(a.tx, a.ty, src.tx, src.ty) <= 4) { total += RARE_AURA; break; }
    }
    // 看板犬/看板猫 lift the whole ranch's spirits a touch
    if (ctx.hasDog) total += num(NEEDS.happinessFromCompanion, 8) * 0.5;
    if (ctx.hasCat) total += num(NEEDS.happinessFromCompanion, 8) * 0.5;
    return total;
  }

  // ---------- auto-feed (trough / silo) ----------
  function feedFromStores(a) {
    var E = eco();
    if (!E || !E.itemCount || !E.removeItem) return false;
    // prefer premium, but don't waste premium when basic would do; simplest cute rule: best available
    for (var i = 0; i < FEED_PREF.length; i++) {
      var id = FEED_PREF[i];
      try {
        if (E.itemCount(id) >= 1) {
          if (E.removeItem(id, 1)) { applyFeed(a, id, FEEDITEMS[id] || {}); return true; }
        }
      } catch (e) { /* ignore and try next */ }
    }
    return false;
  }
  function troughNear(a, troughs, radius) {
    for (var i = 0; i < troughs.length; i++) {
      var b = troughs[i], ct = buildingCenterTile(b);
      if (cheb(a.tx, a.ty, ct.tx, ct.ty) <= radius) return true;
    }
    return false;
  }

  // ---------- production ----------
  function otherDef(a) {
    var sp = speciesIdOf(a);
    return OTHER[sp] || OTHER[a.breed] || null;
  }
  function pigHasForage(a) {
    // truffles need earth to root in: a pasture home or standing on grass/dirt counts
    var home = a.homeBuildingId != null ? getBuilding(a.homeBuildingId) : null;
    if (home && (home.type === 'pasture')) return true;
    var W = world();
    if (W && W.tileAt) { var t = W.tileAt(a.tx, a.ty); if (t && (t.terrain === 'grass' || t.terrain === 'dirt')) return true; }
    if (buildingsOfType('pasture').length > 0) return true;
    return false;
  }
  function depositProduct(a, itemId, amount, auto, dailyBase) {
    if (amount <= 0 || !itemId) return;
    var E = eco();
    if (auto && E && E.addItem) {
      E.addItem(itemId, amount);
      try { bus.emit('animal:produce', { id: a.id, itemId: itemId, amount: amount }); } catch (e) { /* ignore */ }
    } else {
      if (!a.production) a.production = { ready: false, itemId: itemId, amount: 0, cooldownDays: 0, cycleProgress: 0 };
      // if the ready item changed (e.g., normal vs quality milk), keep the higher-value id
      if (a.production.itemId !== itemId && (itemId === 'quality_milk')) a.production.itemId = itemId;
      else if (!a.production.ready) a.production.itemId = itemId;
      a.production.amount = (a.production.amount || 0) + amount;
      a.production.ready = true;
      // soft cap for milk so it never "wastes" — just a gentle heads-up
      if ((a.production.itemId === 'milk' || a.production.itemId === 'quality_milk') && dailyBase > 0) {
        var cap = Math.ceil(dailyBase * (MILK_CAP_DAYS + 1));
        if (a.production.amount > cap) {
          a.production.amount = cap;
          if (!a._milkFullWarned) { a._milkFullWarned = true; notify('🥛 ミルクがいっぱい！ しぼってあげてね', 'info', '🥛'); }
        } else if (a.production.amount < cap) {
          a._milkFullWarned = false;
        }
      }
    }
    var sk = statKeyFor(itemId);
    if (sk && E && E.stat) E.stat(sk, amount);
  }
  function produce(a, season) {
    var m = coreMults(a, season);
    var baseMult = m.happiness * m.health * m.season;

    if (isCow(a.breed)) {
      var bb = BYBREED[a.breed] || {};
      var base = num(bb.baseMilkPerDay, 4);
      var feedMult = feedMultFor(a);
      var upMult = safeMult('milkYield') * safeMult('allYield');
      var yieldF = base * baseMult * feedMult * upMult; // ageMult = 1 (adult)
      var amount = stochRound(yieldF);
      // quality roll -> quality_milk
      var itemId = 'milk';
      var qScore = 0.40 * a.needs.happiness + 0.25 * a.needs.health + 0.20 * (num(a.lastFeedQuality, 0.3) * 100) + 0.15 * (a.temperament || 50);
      var affinity = num(bb.premiumAffinity, 0.5);
      var premChance = U.clamp((qScore - 60) / 40, 0, 1) * affinity;
      if (a.breed === 'wagyu' && QUAL.wagyuAlwaysPremium) itemId = 'quality_milk';
      else if (U.rng() < premChance) itemId = 'quality_milk';
      var auto = hasFlag('autoMilk') || hasFlag('autoCollect') || hasFlag('autoHerd');
      depositProduct(a, itemId, amount, auto, base * feedMult * upMult);
      return;
    }

    var od = otherDef(a);
    var sp = speciesIdOf(a);

    // goat milk (per-day, dairy)
    if (sp === 'goat') {
      var gbase = num(od && od.perDay, 2.5);
      var gUp = safeMult('goatMilkYield') * safeMult('allYield');
      var gAmt = stochRound(gbase * baseMult * gUp);
      depositProduct(a, 'goat_milk', gAmt, hasFlag('autoCollect') || hasFlag('autoHerd'), gbase * gUp);
      return;
    }

    // poultry eggs (per-day)
    if (sp === 'chicken' || sp === 'duck') {
      var ebase = num(od && od.perDay, sp === 'chicken' ? 1.0 : 0.6);
      if (sp === 'duck' && od && od.pondBonusPerDay) {
        // ducks near a pond lay a little more
        var ponds = buildingsOfType('pond');
        for (var pi = 0; pi < ponds.length; pi++) {
          var ct = buildingCenterTile(ponds[pi]);
          if (cheb(a.tx, a.ty, ct.tx, ct.ty) <= num((AUR.pond || {}).radiusTiles, 3)) { ebase += num(od.pondBonusPerDay, 0.3); break; }
        }
      }
      var eUp = safeMult('eggYield') * safeMult('allYield');
      var eAmt = stochRound(ebase * baseMult * eUp);
      if (od && od.doubleChance && U.rng() < num(od.doubleChance, 0.08)) eAmt *= 2;
      depositProduct(a, 'egg', eAmt, hasFlag('autoCollect') || hasFlag('autoHerd'), ebase * eUp);
      return;
    }

    // cycle products: wool / fine_wool / truffle
    if (sp === 'sheep' || sp === 'alpaca' || sp === 'pig') {
      if (!a.production) a.production = { ready: false, itemId: null, amount: 0, cooldownDays: 0, cycleProgress: 0 };
      var cycleDays = num(od && od.cycleDays, sp === 'sheep' ? 4 : (sp === 'alpaca' ? 5 : 6));
      var perCycle = num(od && od.perCycle, 1);
      var inc = baseMult; // happier/healthier animals mature the cycle a touch faster
      if (sp === 'pig' && od && od.requiresForageTile && !pigHasForage(a)) inc *= num(od.foragePenaltyIfNone, 0.4);
      a.production.cycleProgress = (a.production.cycleProgress || 0) + inc;
      if (a.production.cycleProgress >= cycleDays) {
        a.production.cycleProgress -= cycleDays;
        var itemId2 = sp === 'sheep' ? 'wool' : (sp === 'alpaca' ? 'fine_wool' : 'truffle');
        var upTarget = sp === 'pig' ? 'truffleYield' : 'woolYield';
        var amt2 = Math.max(1, Math.round(perCycle * safeMult(upTarget) * safeMult('allYield')));
        var auto2 = hasFlag('autoCollect') || hasFlag('autoShear') || hasFlag('autoHerd');
        depositProduct(a, itemId2, amt2, auto2, 0);
      }
      return;
    }

    // rabbit / others: no ready product (manure handled by accrual below)
  }

  function accrueManure(a) {
    var sp = speciesIdOf(a);
    var rate;
    if (sp === 'rabbit') rate = num((D.animalsById && D.animalsById.rabbit && D.animalsById.rabbit.productPerDay), 1) || 1;
    else rate = num((OTHER.allAnimals && OTHER.allAnimals.perDay), 0.5);
    a._manure = (a._manure || 0) + rate;
    if (a._manure >= 1) {
      var whole = Math.floor(a._manure);
      a._manure -= whole;
      var E = eco();
      if (E && E.addItem) E.addItem('manure', whole);
      var sk = statKeyFor('manure'); // null; manure has no lifetime stat, fine
      if (sk && E && E.stat) E.stat(sk, whole);
    }
  }

  // ---------- need warnings (gentle, throttled) ----------
  function warnNeed(a, need, value, thresh) {
    if (!a._warn) a._warn = {};
    if (value < thresh) {
      if (!a._warn[need]) {
        a._warn[need] = true;
        try { bus.emit('animal:need', { id: a.id, need: need, value: Math.round(value) }); } catch (e) { /* ignore */ }
      }
    } else if (value > thresh + 10) {
      a._warn[need] = false;
    }
  }

  // ---------- THE DAILY SIM (registered on day:advance, runs after Crops) ----------
  function processDay() {
    var s = state();
    if (!s || !s.animals || !s.animals.length) return;
    var season = s.season, weather = s.weather;
    var hungerWM = num(HUNGER_WMULT[weather], 1);
    var cleanWM = num(CLEAN_WMULT[weather], 1);
    var decayMult = safeMult('needsDecay'); // <1 slows decay
    var happyGain = Math.max(1, safeMult('happiness')); // cozy_bedding etc. speed recovery
    var wPenBase = num(HAP_WPEN[weather], 0);
    var rainSheltered = hasFlag('rainShelter');
    var autoFeedFlag = hasFlag('autoFeed');
    var troughs = buildingsOfType('feed_trough');
    var ctx = buildAuraContext();

    var list = s.animals.slice(); // snapshot: births during the loop won't be processed today
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a) continue;
      try {
        if (!a.needs) a.needs = { hunger: 80, happiness: 65, health: 80, cleanliness: 78 };

        // 1) decay hunger & cleanliness (weather + upgrade modified)
        a.needs.hunger = clamp01to100(a.needs.hunger - HUNGER_DECAY * hungerWM * decayMult);
        a.needs.cleanliness = clamp01to100(a.needs.cleanliness - CLEAN_DECAY * cleanWM * decayMult);

        // 2) auto-feed via trough nearby or ranch-wide autoFeed research
        if (a.needs.hunger < 100 && (autoFeedFlag || troughNear(a, troughs, 5))) {
          if (a.needs.hunger < T_HUNGRY || troughs.length || autoFeedFlag) feedFromStores(a);
        }

        // 3) happiness target & ease
        var sheltered = (a.homeBuildingId != null) || rainSheltered;
        var companion = Math.min(COMPANION_CAP, companionBonusFor(a, ctx));
        var petBonus = Math.min(PET_MAX, a.petBonus || 0);
        var shelterBonus = sheltered ? HAP_SHELTER : 0;
        var weatherPenalty = sheltered ? 0 : wPenBase;
        var target = U.clamp(
          HAP_BASE
          + HAP_FED * (a.needs.hunger / 100)
          + HAP_CLEAN * (a.needs.cleanliness / 100)
          + petBonus
          + companion
          + shelterBonus
          + weatherPenalty,
          0, 100);
        var delta = (target - a.needs.happiness) * HAP_EASE;
        if (delta > 0) delta *= happyGain;
        a.needs.happiness = clamp01to100(a.needs.happiness + delta);

        // 4) health update
        var hp = a.needs.health;
        hp += (a.needs.happiness >= T_HAPPY ? HEALTH_HAPPY : 0);
        hp -= (a.needs.hunger < T_STARVE ? HEALTH_STARVE : 0);
        hp -= (a.needs.cleanliness < T_DIRTY ? HEALTH_DIRTY : 0);
        if (hp < HEALTH_PULL) hp += (HEALTH_PULL - hp) * HEALTH_PULL_EASE;
        a.needs.health = clamp01to100(hp);

        // 5) pet-love decays
        if (a.petBonus) a.petBonus = U.clamp(a.petBonus - PET_DECAY, 0, PET_MAX);

        // 6) aging: babies grow up
        if (!a.adult) {
          a.ageDays = (a.ageDays || 0) + 1;
          var key = byBreedKey(a);
          var def = speciesDef(a.breed) || {};
          var grow = num(BABYGROW[key], num(BABYGROW.default, 5));
          var mature = num(def.matureAgeDays, grow);
          var threshold = Math.min(grow, mature) || grow;
          if (a.ageDays >= threshold) {
            a.adult = true;
            a.babyScale = null;
            notify((def.emoji || '🐮') + ' ' + (a.name || def.name || '子') + ' が おとなになったよ！', 'good', '🎉');
          }
        } else {
          a.ageDays = (a.ageDays || 0) + 1;
        }

        // 7) cooldown ticking
        if (a.cooldownDaysLeft > 0) a.cooldownDaysLeft = Math.max(0, a.cooldownDaysLeft - 1);

        // 8) gestation -> birth
        if (a.pregnant) {
          a.gestationDaysLeft = (a.gestationDaysLeft || 0) - 1;
          if (a.gestationDaysLeft <= 0) birthFrom(a);
        }

        // 9) production (adults only)
        if (a.adult) produce(a, season);

        // 10) manure accrual (all animals)
        accrueManure(a);

        // gentle need warnings
        warnNeed(a, 'hunger', a.needs.hunger, T_STARVE);
        warnNeed(a, 'cleanliness', a.needs.cleanliness, T_DIRTY);
        warnNeed(a, 'health', a.needs.health, T_SICK);
      } catch (e) {
        Game._recordError('Animals.processDay', e);
      }
    }
  }

  // ---------- cosmetic per-tick (NO sim here — see processDay) ----------
  // Uses hash01 (never rng) so the sim RNG stream is never perturbed by render rate.
  function update(steps) {
    var s = state();
    if (!s || !s.animals || !s.animals.length) return;
    steps = steps || 1;
    var rm = reduceMotion();
    var moveSpeed = (rm ? 0.6 : 1.4) * steps; // world units per step
    var list = s.animals;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a) continue;
      var ai = a.ai || (a.ai = { mode: 'idle', targetTx: null, targetTy: null, blinkTimer: 0, hopPhase: 0, moveCd: 8, facing: 1 });

      // ensure world coords exist
      if (a.x == null) a.x = (a.tx + 0.5) * TILE;
      if (a.y == null) a.y = (a.ty + 0.5) * TILE;

      // retarget occasionally
      ai.moveCd = (ai.moveCd || 0) - steps;
      if (ai.moveCd <= 0 || ai.targetTx == null) {
        ai.moveSeq = (ai.moveSeq || 0) + 1;
        var seq = ai.moveSeq;
        // roam around the home building (or current tile) within a small radius
        var homeTx = a.tx, homeTy = a.ty;
        if (a.homeBuildingId != null) {
          var b = getBuilding(a.homeBuildingId);
          if (b) { var ct = buildingCenterTile(b); homeTx = ct.tx; homeTy = ct.ty; }
        }
        var R = rm ? 1 : 2;
        var dx = Math.round((U.hash01(a.id, seq * 13 + 1) * 2 - 1) * R);
        var dy = Math.round((U.hash01(a.id, seq * 13 + 7) * 2 - 1) * R);
        var nx = homeTx + dx, ny = homeTy + dy;
        var W = world();
        if (!W || !W.isWalkable || W.isWalkable(nx, ny)) { ai.targetTx = nx; ai.targetTy = ny; }
        else { ai.targetTx = a.tx; ai.targetTy = a.ty; }
        ai.moveCd = 24 + Math.floor(U.hash01(a.id, seq * 13 + 3) * 72);
      }

      // ease toward target center
      var goalX = (ai.targetTx + 0.5) * TILE;
      var goalY = (ai.targetTy + 0.5) * TILE;
      var ddx = goalX - a.x, ddy = goalY - a.y;
      if (ddx > 0.01) ai.facing = 1; else if (ddx < -0.01) ai.facing = -1;
      a.x = U.approach(a.x, goalX, moveSpeed);
      a.y = U.approach(a.y, goalY, moveSpeed);
      // arrived? adopt the logical tile so auras/picking stay coherent
      if (Math.abs(ddx) < 0.5 && Math.abs(ddy) < 0.5) {
        a.tx = ai.targetTx; a.ty = ai.targetTy;
        ai.mode = 'idle';
      } else {
        ai.mode = 'walk';
      }

      // animation phases (cheap)
      if (!rm) {
        var happy = a.needs && a.needs.happiness >= T_HAPPY;
        ai.hopPhase = (ai.hopPhase || 0) + (happy ? 0.22 : 0.12) * steps;
        if (ai.hopPhase > 6.28318) ai.hopPhase -= 6.28318;
        ai.blinkTimer = (ai.blinkTimer || 0) - 0.03 * steps;
        if (ai.blinkTimer <= 0) ai.blinkTimer = 2 + U.hash01(a.id, (ai.moveSeq || 0) + 99) * 5;
      }
    }
  }

  // ---------- init / wiring ----------
  var _unsubs = [];
  function init() {
    for (var i = 0; i < _unsubs.length; i++) { try { _unsubs[i](); } catch (e) { /* ignore */ } }
    _unsubs = [];
    // Registered AFTER Crops (init order) so this fires after crop growth each morning.
    _unsubs.push(bus.on('day:advance', function () {
      try { processDay(); } catch (e) { Game._recordError('Animals.day:advance', e); }
    }));
  }

  return {
    init: init,
    update: update,
    spawn: spawn,
    buy: buy,
    sell: sell,
    get: get,
    at: at,
    inBuilding: inBuilding,
    feed: feed,
    feedBuilding: feedBuilding,
    pet: pet,
    clean: clean,
    collect: collect,
    collectBuilding: collectBuilding,
    canBreed: canBreed,
    breed: breed,
    rename: rename,
    needSummary: needSummary
  };
})();
