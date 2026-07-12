/*
 * 00-data.js — normalizes the raw content+balance JSON (injected by the build as
 * Game.RAW) into the frozen Game.DATA API. This is the SINGLE place that reconciles
 * the content DB's field names with the rest of the code. All logic modules read
 * balance/content exclusively through Game.DATA (never magic numbers).
 *
 * Field-name notes (content.json actual fields, preserved as-is):
 *   cowBreeds[]:  {id,name,emoji,rarity,buyPrice,sellValue,baseMilkPerDay,milkQuality,
 *                  matureAgeDays,lifespanDays,feedPerDay,coldResist,heatResist,
 *                  cutenessBlurb,personality,unlockRank}
 *   animals[]:    {id,name,emoji,kind,buyPrice,product,productPerDay,feedPerDay,
 *                  buildingNeeded,cutenessBlurb,unlockRank}
 *   crops[]:      {id,name,emoji,seedPrice,growDays,feedValue,sellValue,season[],
 *                  waterNeed,isDecor,yieldAmount,cutenessBlurb}
 *   buildings[]:  {id,name,emoji,buildCost,footprint[w,h],capacity,function,
 *                  unlockRank,upgradeOf,cutenessBlurb}
 *   products[]:   {id,name,emoji,basePrice,category,spoilDays,craftedFrom?}
 *   upgrades[]:   {id,name,emoji,cost,effect,description,unlockRank,requires[]}
 *   ranks[]:      {star,name,requiredG,rewardBlurb,unlocksBlurb}
 *
 * IMPORTANT for yield math: use Game.DATA.balance.production.byBreed[breed].baseMilkPerDay
 * (the TUNED value) for the milk formula — NOT content cowBreeds[].baseMilkPerDay (a
 * rougher display value). Mechanics source of truth = balance.json; display = content.json.
 */
Game.DATA = (function () {
  'use strict';
  var RAW = (Game.RAW && typeof Game.RAW === 'object') ? Game.RAW : { content: {}, balance: {} };
  var C = RAW.content || {};
  var B = RAW.balance || {};

  function byId(arr, key) {
    var m = {};
    (arr || []).forEach(function (o) { if (o && o[key] != null) m[o[key]] = o; });
    return m;
  }

  var cowBreeds = C.cowBreeds || [];
  var otherAnimals = C.animals || [];

  // Merged species map (cows + other animals) keyed by id, tagging cow vs species.
  var species = {};
  cowBreeds.forEach(function (o) { species[o.id] = Object.assign({ species: 'cow', kind: o.kind || 'livestock', isCow: true }, o); });
  otherAnimals.forEach(function (o) { species[o.id] = Object.assign({ species: o.id, isCow: false }, o); });

  var DATA = {
    // ---- list forms (for iteration / shop grids) ----
    cowBreedsList: cowBreeds,
    animalsList: otherAnimals,
    cropsList: C.crops || [],
    productsList: C.products || [],
    buildingsList: C.buildings || [],
    upgradesList: C.upgrades || [],
    achievementsList: C.achievements || [],
    eventsList: C.events || [],
    npcsList: C.npcs || [],
    decorationsList: C.decorations || [],
    ranksList: C.ranks || [],

    // ---- keyed maps (for O(1) lookup by id) ----
    breeds: byId(cowBreeds, 'id'),      // cow breeds only
    animalsById: byId(otherAnimals, 'id'), // non-cow species only
    species: species,                   // everything keepable, by id
    crops: byId(C.crops, 'id'),
    products: byId(C.products, 'id'),
    buildings: byId(C.buildings, 'id'),
    upgrades: byId(C.upgrades, 'id'),
    achievements: byId(C.achievements, 'id'),
    events: byId(C.events, 'id'),
    npcs: byId(C.npcs, 'id'),
    decorations: byId(C.decorations, 'id'),
    ranks: C.ranks || [],

    // ---- balance (mechanics source of truth) ----
    balance: B,
    needs: B.needs || {},
    production: B.production || {},
    feed: B.feed || {},
    market: B.market || {},
    breeding: B.breeding || {},
    cropsBalance: B.crops || {},
    weatherModel: B.weather || {},
    speciesTraits: B.speciesTraits || {},
    auras: B.auras || {},
    capacities: B.capacities || {},
    landPlots: B.landPlots || {},
    netWorthSpec: B.netWorth || {},
    dailyTickOrder: (B.dailyTick && B.dailyTick.order) || [],
    upgradesEffectSpec: B.upgradesEffectSpec || {},
    achievementsSpec: B.achievementsSpec || {},
    eventsSpec: B.eventsSpec || {},
    difficulty: B.difficultyCurve || {},
    startSpec: B.start || {}
  };

  var t = B.time || {};
  var lp = B.landPlots || {};
  DATA.const = {
    TILE: 48,
    DAYS_PER_SEASON: t.daysPerSeason || 12,
    DAYS_PER_YEAR: t.daysPerYear || 48,
    SEASONS_PER_YEAR: t.seasonsPerYear || 4,
    SEASON_ORDER: t.seasonOrder || ['spring', 'summer', 'autumn', 'winter'],
    MINUTES_PER_DAY: 1440,
    TICKS_PER_DAY: 1440,
    SIM_HZ: 8,
    REAL_SECONDS_PER_DAY: t.realSecondsPerGameDay || 120,
    SPEEDS: (t.speeds && t.speeds.length ? t.speeds : [1, 2, 3]),
    START_MINUTE: 360, // 06:00 dawn
    PHASES: t.phasesPerDay || { morning: [0, 0.25], day: [0.25, 0.58], evening: [0.58, 0.8], night: [0.8, 1] },
    AMBIENT_LIGHT: t.ambientLight || { morning: 0.72, day: 1, evening: 0.6, night: 0.3 },
    LIGHT_TINT: t.lightTintHint || { morning: '#ffe6c2', day: '#ffffff', evening: '#ffcf99', night: '#3a4a8c' },
    ZOOM_MIN: 0.55,
    ZOOM_MAX: 2.6,
    // Playable world size (vast but performant with culling). One contiguous ranch.
    WORLD_W: 48,
    WORLD_H: 36,
    PLOT_W: (lp.plotSizeTiles && lp.plotSizeTiles[0]) || 16,
    PLOT_H: (lp.plotSizeTiles && lp.plotSizeTiles[1]) || 12,
    // Season display names / colors (art layer may override tints)
    SEASON_NAMES: { spring: '春', summer: '夏', autumn: '秋', winter: '冬' },
    WEATHER_NAMES: { sunny: '晴れ', cloudy: 'くもり', rainy: '雨', snowy: '雪' }
  };

  // Rank net-worth thresholds: balance.costs is authoritative for mechanics.
  DATA.rankNetWorth = (B.costs && B.costs.rankNetWorthThreshold) || { 1: 500, 2: 5000, 3: 30000, 4: 150000, 5: 750000, 6: 3000000, 7: 15000000 };
  DATA.rankTitles = (B.costs && B.costs.rankTitles) || {};
  DATA.referencePrices = (B.costs && B.costs.referencePrices) || {};

  // Generic accessor: Game.DATA.get('crops','corn'), Game.DATA.get('ranks', 3)
  DATA.get = function (category, id) {
    var m = DATA[category];
    if (!m) return undefined;
    if (Array.isArray(m)) {
      for (var i = 0; i < m.length; i++) {
        if (m[i] && (m[i].id === id || m[i].star === id)) return m[i];
      }
      return undefined;
    }
    return m[id];
  };
  DATA.speciesOf = function (id) { return DATA.species[id]; };
  DATA.isCow = function (id) { return !!DATA.breeds[id]; };
  DATA.productOf = function (speciesId) {
    var s = DATA.species[speciesId];
    if (!s) return null;
    if (s.isCow) return 'milk';
    return s.product || null;
  };
  DATA.basePrice = function (itemId) {
    var mk = (B.market && B.market.basePrices) || {};
    if (mk[itemId] != null) return mk[itemId];
    var p = DATA.products[itemId];
    if (p && p.basePrice != null) return p.basePrice;
    var cr = DATA.crops[itemId];
    if (cr && cr.sellValue != null) return cr.sellValue;
    return 1;
  };

  // Best-effort deep freeze (data is modest in size).
  function freeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      var ks = Object.keys(o);
      for (var i = 0; i < ks.length; i++) freeze(o[ks[i]]);
    }
    return o;
  }
  freeze(DATA);
  return DATA;
})();
