/*
 * state.js — Game.State: central state factory + schema version.
 * newGame() returns a COMPLETE initial world as plain data (grid, starter
 * buildings, the free first cow, inventory, market). Module init() methods
 * only wire behavior; they never create starter content.
 *
 * Convention: all modules read the LIVE global `Game.state`. Never cache the
 * state object reference — Save.load()/test.newGame() swap it via State.set().
 */
Game.State = (function () {
  'use strict';
  var U = Game.Util, D = Game.DATA, K = Game.DATA.const;
  var SCHEMA_VERSION = 1;

  function makeSeed() {
    // The one sanctioned use of Math.random/Date.now: pick a fresh master seed.
    var a = (Date.now() >>> 0) ^ ((Math.random() * 0xffffffff) >>> 0);
    return (a >>> 0) || 123456789;
  }

  function makeGrid(w, h) {
    var tiles = new Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        tiles[y * w + x] = {
          terrain: 'grass', buildingId: null, cropId: null,
          walkable: true, fenced: false, unlocked: true, variant: (U.hash01(x * 131 + y * 57, 7) * 4) | 0
        };
      }
    }
    return { w: w, h: h, tiles: tiles };
  }

  function tileIdx(grid, x, y) { return y * grid.w + x; }
  function setTerrainRect(grid, x, y, w, h, terrain, walkable) {
    for (var yy = y; yy < y + h; yy++) for (var xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= grid.w || yy >= grid.h) continue;
      var t = grid.tiles[tileIdx(grid, xx, yy)];
      t.terrain = terrain; if (walkable != null) t.walkable = walkable;
    }
  }

  function placeBuilding(state, type, tx, ty) {
    var b = D.buildings[type]; if (!b) return null;
    var fp = b.footprint || [2, 2], w = fp[0], h = fp[1];
    var id = U.uid(state, 'nextBuildingId');
    var cap = b.capacity || 0;
    var bld = {
      id: id, type: type, tx: tx, ty: ty, w: w, h: h, level: 1,
      capacity: cap, inhabitants: [], storage: {}, progress: 0, builtDay: 1
    };
    state.buildings.push(bld);
    for (var yy = ty; yy < ty + h; yy++) for (var xx = tx; xx < tx + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= state.grid.w || yy >= state.grid.h) continue;
      var t = state.grid.tiles[tileIdx(state.grid, xx, yy)];
      t.buildingId = id; t.walkable = false; if (t.terrain === 'grass') t.terrain = 'dirt';
    }
    return bld;
  }

  function unlockedFor(rank) {
    function ids(list) { return (list || []).filter(function (o) { return (o.unlockRank || 1) <= rank; }).map(function (o) { return o.id; }); }
    return {
      buildings: ids(D.buildingsList),
      animals: ids(D.cowBreedsList).concat(ids(D.animalsList)),
      crops: (D.cropsList || []).map(function (c) { return c.id; }) // crops gated by season, all buyable
    };
  }

  function newGame(seed) {
    seed = (seed >>> 0) || makeSeed();
    var start = D.startSpec || {};
    var W = K.WORLD_W, H = K.WORLD_H;

    var state = {
      version: SCHEMA_VERSION,
      seed: seed,
      rngState: seed,
      createdAt: Date.now(),
      playtimeMs: 0,

      money: start.money != null ? start.money : 500,
      rank: 1,
      rankXp: 0,

      tick: 0,
      minuteOfDay: K.START_MINUTE,
      day: 1,
      dayOfSeason: 1,
      season: start.season || 'spring',
      year: start.year || 1,
      weather: start.weather || 'sunny',
      weatherTicksLeft: 0,

      grid: makeGrid(W, H),
      buildings: [],
      nextBuildingId: 1,

      crops: [],
      nextCropId: 1,

      animals: [],
      nextAnimalId: 1,

      inventory: {},
      seeds: {},

      market: { prices: {}, trend: {}, index: {}, glut: {}, lastUpdateDay: 1, history: {} },

      upgrades: {},
      unlocked: unlockedFor(1),
      research: 0,

      buffs: [],           // temporary event buffs: {target, mult, add, daysLeft, label}
      loan: { principal: 0 },
      lastStipendDay: -99,

      goals: {},
      achievements: {},

      tutorial: { active: true, step: 0, seen: {} },

      settings: {
        master: 0.8, sfx: 0.9, music: 0.5, muted: false,
        speed: 1, showParticles: true, reduceMotion: false, lang: 'ja'
      },
      paused: false,

      camera: { x: 0, y: 0, zoom: 1 },

      stats: {
        totalEarned: 0, totalSpent: 0, totalSales: 0, animalsBorn: 0,
        cropsHarvested: 0, itemsSold: 0, buildingsBuilt: 0, daysPlayed: 0,
        totalMilk: 0, totalCheese: 0, totalEggs: 0, totalTruffle: 0,
        totalWool: 0, totalPets: 0, maxAnimals: 1
      },

      flags: {}            // misc one-shot flags (event onceOnly, etc.)
    };

    // --- terrain flavor: a pond + a couple of paths (cosmetic, still cute) ---
    var pondX = Math.floor(W * 0.62), pondY = Math.floor(H * 0.30);
    setTerrainRect(state.grid, pondX, pondY, 3, 2, 'water', false);

    // --- starter buildings, spaced so typical footprints (<=4) never collide ---
    var cx = Math.floor(W * 0.30), cy = Math.floor(H * 0.42);
    var layout = [
      { type: 'house', tx: cx, ty: cy },
      { type: 'barn', tx: cx + 6, ty: cy },
      { type: 'market_stall', tx: cx, ty: cy + 6 },
      { type: 'pasture', tx: cx + 6, ty: cy + 6 }
    ];
    var barn = null;
    layout.forEach(function (L) {
      var b = placeBuilding(state, L.type, L.tx, L.ty);
      if (b && L.type === 'barn') barn = b;
    });
    // a little dirt path between house and barn
    setTerrainRect(state.grid, cx + 3, cy + 1, 3, 1, 'path', true);

    // --- the free first cow (adult), living in the barn ---
    var cowStats = start.startingCowStats || { hunger: 85, happiness: 70, health: 85, cleanliness: 80, temperament: 52, ageDays: 30 };
    var breedId = start.startingCow || 'holstein';
    var homeId = barn ? barn.id : null;
    var spawnTx = barn ? barn.tx + barn.w + 1 : cx + 8;
    var spawnTy = barn ? barn.ty + 1 : cy + 1;
    var cow = makeAnimal(state, breedId, spawnTx, spawnTy, {
      adult: true, ageDays: cowStats.ageDays || 30, name: 'モモ', sex: 'f',
      homeBuildingId: homeId, needs: {
        hunger: cowStats.hunger, happiness: cowStats.happiness,
        health: cowStats.health, cleanliness: cowStats.cleanliness
      }, temperament: cowStats.temperament
    });
    if (barn) barn.inhabitants.push(cow.id);

    // --- starting inventory & seeds ---
    var sf = start.startingFeed || { hay: 6 };
    Object.keys(sf).forEach(function (k) { state.inventory[k] = (state.inventory[k] || 0) + sf[k]; });
    var ss = start.startingSeeds || { grass: 8, carrot: 2, turnip: 2 };
    Object.keys(ss).forEach(function (k) { state.seeds[k] = (state.seeds[k] || 0) + ss[k]; });

    // --- seed market prices at index 1.0 from base prices ---
    var bp = (D.market && D.market.basePrices) || {};
    Object.keys(bp).forEach(function (id) {
      state.market.prices[id] = bp[id];
      state.market.index[id] = 1.0;
      state.market.trend[id] = 0;
      state.market.glut[id] = 0;
      state.market.history[id] = [bp[id]];
    });

    // --- achievements map (all locked) ---
    (D.achievementsList || []).forEach(function (a) { state.achievements[a.id] = null; });

    // camera centered on the starter cluster (world units)
    state.camera.x = (cx - 4) * K.TILE;
    state.camera.y = (cy - 3) * K.TILE;
    state.camera.zoom = 1;

    return state;
  }

  // Build a bare animal record (used by newGame and Animals.spawn).
  function makeAnimal(state, breedId, tx, ty, opts) {
    opts = opts || {};
    var sp = D.species[breedId] || {};
    var id = U.uid(state, 'nextAnimalId');
    var needs = opts.needs || { hunger: 80, happiness: 65, health: 80, cleanliness: 78 };
    var itemId = D.productOf(breedId);
    var a = {
      id: id, breed: breedId, species: sp.species || (sp.isCow ? 'cow' : breedId),
      name: opts.name || defaultName(breedId, id),
      tx: tx, ty: ty, x: (tx + 0.5) * K.TILE, y: (ty + 0.5) * K.TILE,
      ageDays: opts.ageDays != null ? opts.ageDays : 0,
      adult: opts.adult != null ? opts.adult : false,
      sex: opts.sex || (U.chance(0.5) ? 'f' : 'm'),
      temperament: opts.temperament != null ? opts.temperament : 50,
      traits: opts.traits || [],
      needs: {
        hunger: needs.hunger, happiness: needs.happiness,
        health: needs.health, cleanliness: needs.cleanliness
      },
      lastFeedQuality: 0.3,
      petBonus: 0,
      production: { ready: false, itemId: itemId, amount: 0, cooldownDays: 0, cycleProgress: 0 },
      pregnant: false, gestationDaysLeft: 0, mateBreed: null, cooldownDaysLeft: 0,
      homeBuildingId: opts.homeBuildingId != null ? opts.homeBuildingId : null,
      ai: { mode: 'idle', targetTx: null, targetTy: null, blinkTimer: U.randRange(1, 5), hopPhase: U.randRange(0, 6.28), moveCd: U.randRange(1, 4), facing: 1 }
    };
    state.animals.push(a);
    return a;
  }

  var NAME_POOL = ['モモ', 'ミルク', 'ハナ', 'そら', 'こむぎ', 'だいふく', 'マロン', 'ぷりん', 'きなこ', 'あんこ', 'ゆき', 'ちょこ', 'まめ', 'くり', 'ラテ', 'もち', 'すず', 'こはる', 'ひなた', 'つき'];
  function defaultName(breedId, id) {
    return NAME_POOL[id % NAME_POOL.length];
  }

  function set(stateObj) { Game.state = stateObj; return Game.state; }
  function defaults() { return newGame(1); }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    newGame: newGame,
    makeAnimal: makeAnimal,
    placeBuilding: placeBuilding,
    unlockedFor: unlockedFor,
    defaultName: defaultName,
    set: set,
    defaults: defaults
  };
})();
