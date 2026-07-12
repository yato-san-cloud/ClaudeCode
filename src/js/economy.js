/*
 * economy.js — Game.Economy: the economic heart of まきばのしずく.
 *
 * Owns: money, rank, rankXp, inventory, seeds, market, upgrades, unlocked,
 *       goals, achievements, stats, buffs, loan, research, lastStipendDay, flags.
 *
 * Daily model (see architecture §4 / brief §0.7):
 *   - Handler A (updateMarket) is registered in init() so it is the FIRST
 *     day:advance subscriber -> runs before Crops/Animals.
 *   - Handler B (processing, overflow, events, goals, achievements, rank-up,
 *     stipend, buff decay) is bound on 'game:ready' so it runs AFTER Crops and
 *     Animals have taken their day:advance turn (canonical order).
 *
 * All money flows through debit/credit; all inventory through addItem/removeItem.
 * Every cross-module reference (World/Animals/Time) is looked up lazily and
 * null-guarded. All randomness uses Game.Util.rng.
 */
Game.Economy = (function () {
  'use strict';

  var U = Game.Util, D = Game.DATA, bus = Game.bus;
  var K = D.const;

  // ---- convenience live-state accessor (NEVER cache the object) ----
  function S() { return Game.state; }

  // Additive-natured upgrade/buff targets (base 0, tokens sum). Everything else
  // is treated multiplicatively (base 1, '*' tokens multiply).
  var ADDITIVE_TARGETS = {
    priceBonus: 0, capacity: 0, processSlots: 0, autoCollectRadius: 0,
    waterRadius: 0, offspringQuality: 0, coldResist: 0, heatResist: 0,
    allHappiness: 0, milkQuality: 0, research: 0
  };

  // Targets that legacy event effect-strings map onto as temporary buffs read
  // back through upgradeMult() by other modules (milk/egg/crop yield etc.).
  var YIELD_BUFF_TARGETS = {
    milkYield: 1, allYield: 1, eggYield: 1, woolYield: 1, goatMilkYield: 1,
    truffleYield: 1, cropYield: 1, cropGrow: 1, dairyYield: 1, feedCost: 1,
    shopDiscount: 1, happinessGain: 1, feedProduction: 1
  };

  var _effectCache = {};   // upgrade effect string -> parsed token array
  var _dailyBound = false; // guard so Handler B binds exactly once
  var _pendingEvents = {}; // id -> event def awaiting resolveEvent()

  // ------------------------------------------------------------------
  //  Effect / condition mini-language parsing
  // ------------------------------------------------------------------
  // A token is either "TARGET OP VALUE" (op in * + - =) or a bare FLAG.
  function parseToken(tok) {
    tok = String(tok || '').trim();
    if (!tok) return null;
    var m = tok.match(/^([a-zA-Z0-9_.:<>]+?)\s*([*+\-=])\s*([-]?[0-9.]+)$/);
    if (m) return { target: m[1], op: m[2], val: parseFloat(m[3]), bare: false, raw: tok };
    return { target: tok, op: null, val: null, bare: true, raw: tok };
  }
  function parseEffect(effect) {
    if (effect == null) return [];
    if (Array.isArray(effect)) {
      return effect.map(parseToken).filter(Boolean);
    }
    var key = String(effect);
    if (_effectCache[key]) return _effectCache[key];
    var out = key.split(',').map(parseToken).filter(Boolean);
    _effectCache[key] = out;
    return out;
  }

  // ------------------------------------------------------------------
  //  Notifications / particle helpers
  // ------------------------------------------------------------------
  function notify(text, kind, icon, ttl) {
    try { bus.emit('notify', { text: text, kind: kind || 'info', icon: icon || '', ttl: ttl || 3200 }); }
    catch (e) { Game._recordError('economy.notify', e); }
  }
  function fx(name, payload) { try { bus.emit(name, payload || {}); } catch (e) { } }

  // ------------------------------------------------------------------
  //  Money
  // ------------------------------------------------------------------
  function canAfford(cost) { return (S().money || 0) >= (cost || 0); }

  function debit(amount, reason) {
    var s = S();
    amount = Math.max(0, Math.round(amount || 0));
    if (amount === 0) return true;
    if ((s.money || 0) < amount) return false; // graceful fail; never overdraw
    s.money -= amount;
    if (s.money < 0) s.money = 0;
    s.stats.totalSpent = (s.stats.totalSpent || 0) + amount;
    bus.emit('money:change', { money: s.money, delta: -amount, reason: reason || 'spend' });
    bus.emit('purchase', { kind: reason || 'buy', id: null, cost: amount, meta: null });
    return true;
  }

  function credit(amount, reason) {
    var s = S();
    amount = Math.max(0, Math.round(amount || 0));
    if (amount === 0) return;
    s.money += amount;
    s.stats.totalEarned = (s.stats.totalEarned || 0) + amount;
    // gentle mentor-loan auto-repay from sales (never forced, never spirals)
    if (reason && reason.indexOf('sale') === 0 && s.loan && s.loan.principal > 0) {
      var pct = (D.difficulty.mentorLoan && D.difficulty.mentorLoan.repayFromSalesPct) || 0.10;
      var pay = Math.min(s.loan.principal, Math.round(amount * pct));
      if (pay > 0) { s.money -= pay; s.loan.principal -= pay; }
    }
    bus.emit('money:change', { money: s.money, delta: amount, reason: reason || 'income' });
  }

  // ------------------------------------------------------------------
  //  Inventory
  // ------------------------------------------------------------------
  function addItem(itemId, qty) {
    if (!itemId) return;
    qty = Math.round(qty || 0);
    if (qty === 0) return;
    var s = S();
    var next = Math.max(0, (s.inventory[itemId] || 0) + qty);
    s.inventory[itemId] = next;
    bus.emit('inventory:change', { itemId: itemId, qty: next, delta: qty });
  }
  function removeItem(itemId, qty) {
    if (!itemId) return false;
    qty = Math.round(qty || 0);
    if (qty <= 0) return true;
    var s = S();
    var have = s.inventory[itemId] || 0;
    if (have < qty) return false;
    s.inventory[itemId] = have - qty;
    bus.emit('inventory:change', { itemId: itemId, qty: s.inventory[itemId], delta: -qty });
    return true;
  }
  function itemCount(itemId) { return (S().inventory[itemId] || 0); }

  // ------------------------------------------------------------------
  //  Market
  // ------------------------------------------------------------------
  function categoryOf(itemId) {
    var pc = (D.market && D.market.productCategory) || {};
    if (pc[itemId]) return pc[itemId];
    var p = D.products[itemId];
    if (p && p.category) {
      // map product-file categories onto market categories
      var map = { dairy: 'dairy', poultry: 'egg', textile: 'fiber', gourmet: 'luxury', fertilizer: 'fertilizer' };
      return map[p.category] || p.category;
    }
    if (D.crops[itemId]) return 'crop';
    return null;
  }

  function stallBonusPct() {
    var W = Game.World;
    if (!W || !W.buildingsOfType) return 0;
    var stalls;
    try { stalls = W.buildingsOfType('market_stall') || []; } catch (e) { return 0; }
    if (!stalls.length) return 0;
    var tier = 0;
    for (var i = 0; i < stalls.length; i++) tier = Math.max(tier, (stalls[i].level || 1) - 1);
    var arr = (D.market && D.market.marketStallTierBonusPct) || [0.10, 0.16, 0.22];
    return arr[U.clamp(tier, 0, arr.length - 1)] || 0;
  }

  // Dog/cat 看板犬/看板猫 market aura (capped).
  function marketAuraPct() {
    var s = S(), bonus = 0;
    var au = D.auras || {};
    var hasDog = false, hasCat = false;
    for (var i = 0; i < s.animals.length; i++) {
      var b = s.animals[i].breed;
      if (b === 'dog') hasDog = true; else if (b === 'cat') hasCat = true;
    }
    if (hasDog && au.dog) bonus += au.dog.marketPriceBonusPct || 0;
    if (hasCat && au.cat) bonus += au.cat.marketPriceBonusPct || 0;
    var cap = au.marketAuraCapPct != null ? au.marketAuraCapPct : 0.12;
    return U.clamp(bonus, 0, cap);
  }

  // Temporary sell-price buffs from events (priceAll / price:cat / price:good).
  function buffPriceMult(itemId, cat) {
    var s = S(), m = 1;
    var buffs = s.buffs || [];
    for (var i = 0; i < buffs.length; i++) {
      var b = buffs[i];
      if (b.mult == null) continue;
      if (b.target === 'priceAll') m *= b.mult;
      else if (b.target === 'price') {
        if (b.good && b.good === itemId) m *= b.mult;
        else if (b.cat && b.cat === cat) m *= b.mult;
      }
    }
    return m;
  }

  // Invisible rubber-band: nudge prices up ~10% if net worth trails the curve.
  function belowCurveMult() {
    try {
      var arcs = D.balance && D.balance.costs && D.balance.costs.stageMoneyArcs;
      if (!arcs) return 1;
      var keys = ['S1', 'S2', 'S3', 'S4', 'S5'];
      var arc = arcs[keys[U.clamp((S().rank || 1) - 1, 0, 4)]];
      if (!arc) return 1;
      if (netWorth() < arc[0]) {
        var pct = (D.difficulty.antiStall && D.difficulty.antiStall.belowCurveCatchUpPct) || 0.10;
        return 1 + pct;
      }
    } catch (e) { }
    return 1;
  }

  // Full realized SELL price for one unit of itemId (net of fee, incl. bonuses).
  function price(itemId) {
    var s = S();
    var base = D.basePrice(itemId);
    var mk = D.market || {};
    var idx = (s.market.index && s.market.index[itemId] != null) ? s.market.index[itemId] : 1.0;
    var cat = categoryOf(itemId);
    var season = s.season;
    var sd = 1, wd = 1;
    if (cat && mk.seasonalDemand && mk.seasonalDemand[cat] && mk.seasonalDemand[cat][season] != null) sd = mk.seasonalDemand[cat][season];
    if (cat && mk.weatherDemand && mk.weatherDemand[cat] && mk.weatherDemand[cat][s.weather] != null) wd = mk.weatherDemand[cat][s.weather];
    var glut = (s.market.glut && s.market.glut[itemId]) || 0;
    var fee = mk.sellFeePct != null ? mk.sellFeePct : 0.05;
    var stall = stallBonusPct() + (upgradeMult('priceBonus') || 0);
    var sellUp = upgradeMult('sellPrice');      // multiplicative upgrades (market_contract…)
    var aura = 1 + marketAuraPct();
    var buffM = buffPriceMult(itemId, cat);
    var curve = belowCurveMult();

    var p = base * idx * sd * wd * (1 - glut) * (1 - fee + stall) * sellUp * aura * buffM * curve;
    p = Math.round(p);
    if (p < 1) p = 1; // floor: no good ever worthless
    return p;
  }

  function seedMarketIfNeeded() {
    var s = S();
    if (!s.market) s.market = { prices: {}, index: {}, trend: {}, glut: {}, lastUpdateDay: s.day, history: {} };
    var bp = (D.market && D.market.basePrices) || {};
    Object.keys(bp).forEach(function (id) {
      if (s.market.index[id] == null) s.market.index[id] = 1.0;
      if (s.market.glut[id] == null) s.market.glut[id] = 0;
      if (s.market.trend[id] == null) s.market.trend[id] = 0;
      if (s.market.prices[id] == null) s.market.prices[id] = bp[id];
      if (!s.market.history[id]) s.market.history[id] = [bp[id]];
    });
  }

  // Daily clamped mean-reverting random walk on every good's price index.
  function updateMarket() {
    try {
      var s = S();
      seedMarketIfNeeded();
      var mk = D.market || {};
      var vol = mk.baseVolatility != null ? mk.baseVolatility : 0.08;
      var jit = mk.moodJitter != null ? mk.moodJitter : 0.04;
      var mean = mk.meanReversion != null ? mk.meanReversion : 0.15;
      var band = mk.priceBand || [0.60, 1.60];
      var recover = (mk.supplyGlut && mk.supplyGlut.recoverPerDay) || 0.06;
      var keepN = mk.trendSparklineDays || 7;

      Object.keys(s.market.index).forEach(function (id) {
        var idx = s.market.index[id];
        var next = idx + U.randRange(-vol, vol) + U.randRange(-jit, jit) + (1.0 - idx) * mean;
        next = U.clamp(next, band[0], band[1]);
        s.market.trend[id] = next > idx + 0.001 ? 1 : (next < idx - 0.001 ? -1 : 0);
        s.market.index[id] = next;
        // supply glut recovers toward 0
        if (s.market.glut[id] > 0) s.market.glut[id] = Math.max(0, s.market.glut[id] - recover);
      });

      // recompute realized prices + push sparkline history (keep last N)
      Object.keys(s.market.index).forEach(function (id) {
        var pr = price(id);
        s.market.prices[id] = pr;
        var h = s.market.history[id] || (s.market.history[id] = []);
        h.push(pr);
        while (h.length > keepN) h.shift();
      });
      s.market.lastUpdateDay = s.day;
      bus.emit('market:update', { prices: s.market.prices });
    } catch (e) { Game._recordError('economy.updateMarket', e); }
  }

  function applyGlut(itemId, qty) {
    var s = S();
    var sg = (D.market && D.market.supplyGlut) || {};
    var thr = sg.thresholdUnits != null ? sg.thresholdUnits : 50;
    var per = sg.dropPerUnitOver != null ? sg.dropPerUnitOver : 0.004;
    var maxD = sg.maxDropPct != null ? sg.maxDropPct : 0.35;
    var over = Math.max(0, qty - thr);
    if (over <= 0) return;
    var cur = s.market.glut[itemId] || 0;
    s.market.glut[itemId] = Math.min(maxD, cur + over * per);
  }

  // ------------------------------------------------------------------
  //  Selling
  // ------------------------------------------------------------------
  function sell(itemId, qty) {
    try {
      var s = S();
      var have = itemCount(itemId);
      qty = Math.min(Math.round(qty || 0), have);
      if (qty <= 0) return { ok: false, total: 0 };
      var unit = price(itemId);
      var total = unit * qty;
      if (!removeItem(itemId, qty)) return { ok: false, total: 0 };
      credit(total, 'sale:' + itemId);
      applyGlut(itemId, qty);
      s.stats.itemsSold = (s.stats.itemsSold || 0) + qty;
      s.stats.totalSales = (s.stats.totalSales || 0) + total;
      // reflect the depressed price into today's history tail
      var h = s.market.history[itemId];
      if (h && h.length) h[h.length - 1] = price(itemId);
      bus.emit('sale', { itemId: itemId, qty: qty, unitPrice: unit, total: total });
      fx('fx:coin', { amount: total });
      return { ok: true, total: total };
    } catch (e) { Game._recordError('economy.sell', e); return { ok: false, total: 0 }; }
  }

  // Warehouse soft-cap: gentle overflow auto-sell at 70% (dailyTick step 6).
  function warehouseCap() {
    var cap = (D.capacities && D.capacities.starterWarehouseless) || 80;
    var W = Game.World;
    if (W && W.buildingsOfType) {
      try {
        var whs = W.buildingsOfType('warehouse') || [];
        if (whs.length) {
          cap = 0;
          for (var i = 0; i < whs.length; i++) cap += (whs[i].capacity || (D.capacities && D.capacities.warehouse) || 200);
          cap = Math.round(cap * (upgradeMult('stockStorage') || 1));
        }
      } catch (e) { }
    }
    return cap;
  }
  function inventoryUnits() {
    var s = S(), n = 0;
    Object.keys(s.inventory).forEach(function (k) { n += s.inventory[k]; });
    return n;
  }
  function overflowAutoSell() {
    try {
      var s = S();
      var cap = warehouseCap();
      var total = inventoryUnits();
      if (total <= cap) return;
      var overflow = total - cap;
      var rate = (D.cropsBalance && D.cropsBalance.witherRules && 0) || 0.70; // gentle 70%
      // sell from the most-abundant sellable goods first
      var goods = Object.keys(s.inventory).filter(function (k) { return s.inventory[k] > 0; });
      goods.sort(function (a, b) { return s.inventory[b] - s.inventory[a]; });
      var earned = 0, soldUnits = 0;
      for (var i = 0; i < goods.length && overflow > 0; i++) {
        var id = goods[i];
        var take = Math.min(s.inventory[id], overflow);
        if (take <= 0) continue;
        var gain = Math.round(price(id) * take * rate);
        if (removeItem(id, take)) { credit(gain, 'overflow'); earned += gain; soldUnits += take; overflow -= take; }
      }
      if (soldUnits > 0) {
        notify('倉庫がいっぱい！ ' + soldUnits + 'こ おすそわけ (+' + U.formatG(earned) + ')', 'info', '📦', 3600);
      }
    } catch (e) { Game._recordError('economy.overflow', e); }
  }

  // ------------------------------------------------------------------
  //  Seeds
  // ------------------------------------------------------------------
  function seedCost(cropId) {
    var tbl = D.cropsBalance && D.cropsBalance.table && D.cropsBalance.table[cropId];
    if (tbl && tbl.seedCost != null) return tbl.seedCost;
    var c = D.crops[cropId];
    return c && c.seedPrice != null ? c.seedPrice : 10;
  }
  function buySeed(cropId, qty) {
    var c = D.crops[cropId];
    if (!c) return false;
    qty = Math.max(1, Math.round(qty || 1));
    var cost = seedCost(cropId) * qty;
    if (!canAfford(cost)) { notify('おかねが たりないよ〜', 'warn', '💰'); return false; }
    if (!debit(cost, 'seed:' + cropId)) return false;
    var s = S();
    s.seeds[cropId] = (s.seeds[cropId] || 0) + qty;
    notify((c.name || cropId) + 'のたね ×' + qty, 'good', c.emoji || '🌱', 2400);
    return true;
  }

  // ------------------------------------------------------------------
  //  Upgrades & flags
  // ------------------------------------------------------------------
  function hasUpgrade(id) { return !!(S().upgrades && S().upgrades[id]); }

  function buyUpgrade(id) {
    var u = D.upgrades[id];
    if (!u) return false;
    var s = S();
    if (hasUpgrade(id)) { notify('すでに どうにゅう済み', 'info', u.emoji); return false; }
    if ((u.unlockRank || 1) > (s.rank || 1)) { notify('ランクが たりないよ', 'warn', '🔒'); return false; }
    var reqs = u.requires || [];
    for (var i = 0; i < reqs.length; i++) {
      if (!hasUpgrade(reqs[i])) {
        var pr = D.upgrades[reqs[i]];
        notify('さきに「' + (pr ? pr.name : reqs[i]) + '」が ひつよう', 'warn', '🔒');
        return false;
      }
    }
    if (!canAfford(u.cost || 0)) { notify('おかねが たりないよ〜', 'warn', '💰'); return false; }
    if (!debit(u.cost || 0, 'upgrade:' + id)) return false;
    s.upgrades[id] = true;
    fx('fx:sparkle', {});
    notify((u.emoji || '⭐') + ' ' + (u.name || id) + ' を どうにゅう！', 'good', u.emoji || '⭐', 3600);
    return true;
  }

  // Aggregate every owned-upgrade + active-buff modifier for a numeric target.
  function upgradeMult(target) {
    var additive = Object.prototype.hasOwnProperty.call(ADDITIVE_TARGETS, target);
    var acc = additive ? (ADDITIVE_TARGETS[target] || 0) : 1;
    function apply(t) {
      if (!t || t.target !== target || t.bare) return;
      if (additive) {
        if (t.op === '+') acc += t.val;
        else if (t.op === '-') acc -= t.val;
        else if (t.op === '=') acc = t.val;
        else if (t.op === '*') acc += (t.val - 1);
      } else {
        if (t.op === '*') acc *= t.val;
        else if (t.op === '+') acc *= (1 + t.val);
        else if (t.op === '-') acc *= (1 - t.val);
        else if (t.op === '=') acc = t.val;
      }
    }
    var s = S();
    var ups = s.upgrades || {};
    for (var id in ups) {
      if (!ups[id]) continue;
      var u = D.upgrades[id];
      if (!u) continue;
      parseEffect(u.effect).forEach(apply);
    }
    var buffs = s.buffs || [];
    for (var i = 0; i < buffs.length; i++) {
      var b = buffs[i];
      if (b.target !== target) continue;
      apply({ target: target, op: b.op || '*', val: (b.mult != null ? b.mult : (b.add != null ? b.add : 1)), bare: false });
    }
    return acc;
  }

  function hasFlag(flag) {
    var ups = S().upgrades || {};
    for (var id in ups) {
      if (!ups[id]) continue;
      var u = D.upgrades[id];
      if (!u) continue;
      var ts = parseEffect(u.effect);
      for (var i = 0; i < ts.length; i++) if (ts[i].bare && ts[i].target === flag) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  //  Unlocks
  // ------------------------------------------------------------------
  function isUnlocked(cat, id) {
    var s = S();
    var arr = s.unlocked && s.unlocked[cat];
    if (arr && arr.indexOf(id) >= 0) return true;
    // fall back to rank gating from data
    var def = null;
    if (cat === 'buildings') def = D.buildings[id];
    else if (cat === 'animals') def = D.species[id];
    else if (cat === 'crops') return true;
    if (def) return (def.unlockRank || 1) <= (s.rank || 1);
    return false;
  }
  function unlock(cat, id) {
    var s = S();
    if (!s.unlocked[cat]) s.unlocked[cat] = [];
    if (s.unlocked[cat].indexOf(id) < 0) s.unlocked[cat].push(id);
  }
  function unlockRankContent(rank) {
    try {
      var fresh = Game.State.unlockedFor(rank);
      var s = S();
      ['buildings', 'animals', 'crops'].forEach(function (cat) {
        (fresh[cat] || []).forEach(function (id) { unlock(cat, id); });
      });
    } catch (e) { Game._recordError('economy.unlockRankContent', e); }
  }

  // ------------------------------------------------------------------
  //  Net worth & rank
  // ------------------------------------------------------------------
  function animalMarketValue(a) {
    var sp = D.species[a.breed] || {};
    if (sp.sellValue != null) return sp.sellValue;
    if (sp.buyPrice != null) return Math.round(sp.buyPrice * 0.5);
    var ref = D.referencePrices && D.referencePrices.animals;
    if (ref && ref[a.breed] != null) return Math.round(ref[a.breed] * 0.5);
    return 200;
  }
  function netWorth() {
    var s = S();
    var nw = s.money || 0;
    var spec = D.netWorthSpec || {};
    var aPct = spec.animalValuePct != null ? spec.animalValuePct : 0.70;
    var babyPct = spec.babyAnimalValuePct != null ? spec.babyAnimalValuePct : 0.40;
    var bPct = spec.buildingValuePct != null ? spec.buildingValuePct : 0.60;
    var lPct = spec.landValuePct != null ? spec.landValuePct : 0.50;
    var i;
    for (i = 0; i < s.animals.length; i++) {
      var a = s.animals[i];
      nw += animalMarketValue(a) * (a.adult ? aPct : babyPct);
    }
    for (i = 0; i < s.buildings.length; i++) {
      var b = s.buildings[i];
      var bd = D.buildings[b.type];
      if (bd) nw += (bd.buildCost || 0) * bPct;
    }
    Object.keys(s.inventory).forEach(function (id) {
      var q = s.inventory[id];
      if (q > 0) nw += q * D.basePrice(id);
    });
    var landPaid = s.landPaid || 0;
    if (typeof landPaid === 'number') nw += landPaid * lPct;
    return Math.round(nw);
  }

  function rankTitle(rank) {
    if (D.rankTitles && D.rankTitles[rank]) return D.rankTitles[rank];
    var r = D.ranks[rank - 1];
    return r ? r.name : ('★' + rank);
  }
  function rankInfo() {
    var s = S();
    var rank = s.rank || 1;
    var next = D.rankNetWorth[rank + 1];
    return {
      rank: rank,
      title: rankTitle(rank),
      xp: s.rankXp || 0,
      net: netWorth(),
      next: next != null ? next : null,
      progress: next ? U.clamp(netWorth() / next, 0, 1) : 1,
      max: next == null
    };
  }
  function addXp(n) {
    var s = S();
    s.rankXp = (s.rankXp || 0) + (n || 0);
  }
  function rankReward(rank) {
    return Math.min(50000, 250 * rank * rank);
  }
  function checkRankUp() {
    try {
      var s = S();
      var guard = 0;
      while (guard++ < 8) {
        var rank = s.rank || 1;
        var need = D.rankNetWorth[rank + 1];
        if (need == null) break;              // already at max rank
        if (netWorth() < need) break;
        var prev = rank;
        s.rank = rank + 1;
        unlockRankContent(s.rank);
        var reward = rankReward(s.rank);
        if (reward > 0) credit(reward, 'rankup');
        var rdef = D.ranks[s.rank - 1];
        fx('fx:sparkle', {});
        bus.emit('levelup', { rank: s.rank, prevRank: prev });
        notify('ランクアップ！ ★' + s.rank + ' ' + rankTitle(s.rank) + (reward ? '（+' + U.formatG(reward) + '）' : ''),
          'good', '⭐', 5000);
        if (rdef && rdef.rewardBlurb) notify(rdef.rewardBlurb, 'good', '🎁', 4200);
      }
    } catch (e) { Game._recordError('economy.checkRankUp', e); }
  }

  // ------------------------------------------------------------------
  //  Stats
  // ------------------------------------------------------------------
  function stat(key, delta) {
    var s = S();
    if (!key) return;
    if (delta == null) delta = 1;
    s.stats[key] = (s.stats[key] || 0) + delta;
  }

  // ------------------------------------------------------------------
  //  Condition mini-language evaluator (achievements / event triggers)
  // ------------------------------------------------------------------
  function countAnimals(pred) {
    var s = S(), n = 0;
    for (var i = 0; i < s.animals.length; i++) if (pred(s.animals[i])) n++;
    return n;
  }
  function distinct(fn) {
    var s = S(), set = {};
    for (var i = 0; i < s.animals.length; i++) { var v = fn(s.animals[i]); if (v != null) set[v] = 1; }
    return Object.keys(set).length;
  }
  function avgHappiness() {
    var s = S();
    if (!s.animals.length) return 0;
    var t = 0;
    for (var i = 0; i < s.animals.length; i++) t += (s.animals[i].needs ? s.animals[i].needs.happiness : 0);
    return t / s.animals.length;
  }
  function countBuildingsOfType(type) {
    var s = S(), n = 0;
    for (var i = 0; i < s.buildings.length; i++) if (s.buildings[i].type === type) n++;
    return n;
  }

  function getStat(token) {
    var s = S(), st = s.stats || {};
    if (token.indexOf('buildings.') === 0) return countBuildingsOfType(token.slice(10));
    switch (token) {
      case 'money': return s.money || 0;
      case 'netWorth': return netWorth();
      case 'day': return s.day || 1;
      case 'year': return s.year || 1;
      case 'season': return s.season;
      case 'weather': return s.weather;
      case 'rank':
      case 'ranchRank': return s.rank || 1;
      case 'rankXp': return s.rankXp || 0;
      case 'cows': return countAnimals(function (a) { return a.species === 'cow'; });
      case 'chickens': return countAnimals(function (a) { return a.breed === 'chicken'; });
      case 'sheep': return countAnimals(function (a) { return a.breed === 'sheep'; });
      case 'animals': return s.animals.length;
      case 'species':
      case 'animalSpeciesOwned': return distinct(function (a) { return a.species === 'cow' ? 'cow' : a.breed; });
      case 'breeds':
      case 'cowBreedsOwned': return distinct(function (a) { return a.species === 'cow' ? a.breed : null; });
      case 'babies': return countAnimals(function (a) { return !a.adult; });
      case 'petsOwned': return countAnimals(function (a) { var sp = D.species[a.breed]; return sp && sp.kind === 'pet'; });
      case 'maxHappyAnimals': return countAnimals(function (a) { return a.needs && a.needs.happiness >= (D.needs.thresholds ? D.needs.thresholds.blissful : 88); });
      case 'avgHappiness': return avgHappiness();
      case 'upgrades':
      case 'upgradesOwned': return Object.keys(s.upgrades || {}).filter(function (k) { return s.upgrades[k]; }).length;
      case 'achievements': return Object.keys(s.achievements || {}).filter(function (k) { return s.achievements[k]; }).length;
      case 'cropsHarvested': return st.cropsHarvested || 0;
      case 'totalMilk':
      case 'milkCollected': return st.totalMilk || 0;
      case 'totalCheese':
      case 'cheeseMade': return st.totalCheese || 0;
      case 'totalEggs':
      case 'eggsCollected': return st.totalEggs || 0;
      case 'totalTruffle':
      case 'trufflesFound': return st.totalTruffle || 0;
      case 'totalWool':
      case 'woolCollected': return st.totalWool || 0;
      case 'totalPets': return st.totalPets || 0;
      case 'totalSales': return st.totalSales || 0;
      case 'totalEarned': return st.totalEarned || 0;
      case 'totalSpent': return st.totalSpent || 0;
      case 'calvesBorn':
      case 'animalsBorn': return st.animalsBorn || 0;
      case 'daysPlayed': return st.daysPlayed || 0;
      case 'buildingsBuilt': return st.buildingsBuilt || 0;
      case 'decorationsPlaced': return st.decorationsPlaced || 0;
      case 'festivalsAttended': return st.festivalsAttended || 0;
      default: return st[token] != null ? st[token] : 0;
    }
  }

  function cmp(a, op, b) {
    switch (op) {
      case '>=': return a >= b; case '>': return a > b;
      case '<=': return a <= b; case '<': return a < b;
      case '==': return a == b; case '!=': return a != b;
    }
    return false;
  }
  function evalClause(clause) {
    var m = clause.match(/^\s*([a-zA-Z0-9_.]+)\s*(>=|<=|==|!=|>|<)\s*([a-zA-Z0-9_.\-]+)\s*$/);
    if (!m) return false;
    var lv = getStat(m[1]);
    var rhs = m[3];
    var rn = parseFloat(rhs);
    if (!isNaN(rn) && /^-?[0-9.]+$/.test(rhs)) return cmp(Number(lv), m[2], rn);
    return cmp(String(lv), m[2], rhs); // string compare (season==autumn …)
  }
  function evalCondition(cond) {
    if (!cond) return false;
    try {
      if (cond.indexOf('&&') >= 0) return cond.split('&&').every(evalClause);
      if (cond.indexOf('||') >= 0) return cond.split('||').some(evalClause);
      return evalClause(cond);
    } catch (e) { Game._recordError('economy.evalCondition', e); return false; }
  }

  // ------------------------------------------------------------------
  //  Achievements
  // ------------------------------------------------------------------
  function checkAchievements() {
    try {
      var s = S();
      var list = D.achievementsList || [];
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (s.achievements[a.id]) continue; // already unlocked (truthy day)
        if (evalCondition(a.condition)) {
          s.achievements[a.id] = s.day;
          if (a.rewardG) credit(a.rewardG, 'achievement:' + a.id);
          addXp(Math.round((a.rewardG || 0) / 10));
          fx('fx:sparkle', {});
          bus.emit('achievement:unlock', { achId: a.id });
          notify('じっせき かいじょ！ ' + (a.emoji || '🏆') + ' ' + a.name +
            (a.rewardG ? '（+' + U.formatG(a.rewardG) + '）' : ''), 'good', a.emoji || '🏆', 4600);
        }
      }
    } catch (e) { Game._recordError('economy.checkAchievements', e); }
  }

  // ------------------------------------------------------------------
  //  Goal board
  // ------------------------------------------------------------------
  function goalBoard() {
    var s = S();
    var out = [];
    // 1) next-rank net-worth goal (from ranks)
    var rank = s.rank || 1;
    var need = D.rankNetWorth[rank + 1];
    if (need != null) {
      out.push({ id: 'rank_next', label: '★' + (rank + 1) + ' ' + rankTitle(rank + 1) + ' をめざす', progress: Math.min(netWorth(), need), target: need, done: netWorth() >= need });
    } else {
      out.push({ id: 'rank_next', label: '★7 しずくの守り人 に とうたつ！', progress: 1, target: 1, done: true });
    }
    // 2) a few evergreen milestone goals so the board always has life
    var st = s.stats || {};
    var milestones = [
      { id: 'own_3_animals', label: 'どうぶつを 3ひき そろえる', value: s.animals.length, target: 3, icon: '🐾' },
      { id: 'harvest_10', label: '作物を 10かい しゅうかく', value: st.cropsHarvested || 0, target: 10, icon: '🌱' },
      { id: 'make_cheese', label: 'チーズを つくる', value: st.totalCheese || 0, target: 1, icon: '🧀' },
      { id: 'earn_2000', label: '2,000G かせぐ', value: st.totalEarned || 0, target: 2000, icon: '💰' },
      { id: 'pet_10', label: 'どうぶつを 10かい なでる', value: st.totalPets || 0, target: 10, icon: '💖' }
    ];
    milestones.forEach(function (g) {
      out.push({ id: g.id, label: g.label, icon: g.icon, progress: Math.min(g.value, g.target), target: g.target, done: g.value >= g.target });
    });
    return out;
  }

  function checkGoals() {
    try {
      var s = S();
      if (!s.goals) s.goals = {};
      var board = goalBoard();
      board.forEach(function (g) {
        var rec = s.goals[g.id] || (s.goals[g.id] = { done: false, progress: 0 });
        rec.progress = g.target ? U.clamp(g.progress / g.target, 0, 1) : 1;
        bus.emit('goal:progress', { goalId: g.id, progress: rec.progress });
        if (g.done && !rec.done) {
          rec.done = true;
          bus.emit('goal:complete', { goalId: g.id, progress: 1 });
        }
      });
    } catch (e) { Game._recordError('economy.checkGoals', e); }
  }

  // ------------------------------------------------------------------
  //  Buffs
  // ------------------------------------------------------------------
  function pushBuff(buff) {
    var s = S();
    if (!s.buffs) s.buffs = [];
    s.buffs.push(buff);
  }
  function decayBuffs() {
    var s = S();
    if (!s.buffs || !s.buffs.length) return;
    var kept = [];
    for (var i = 0; i < s.buffs.length; i++) {
      var b = s.buffs[i];
      b.daysLeft = (b.daysLeft != null ? b.daysLeft : 1) - 1;
      if (b.daysLeft > 0) kept.push(b);
    }
    s.buffs = kept;
  }

  // ------------------------------------------------------------------
  //  Effect-token application (events / achievement rewards / grants)
  // ------------------------------------------------------------------
  function bumpAllHappiness(n, species) {
    var A = Game.Animals;
    var s = S();
    for (var i = 0; i < s.animals.length; i++) {
      var a = s.animals[i];
      if (species && a.breed !== species && a.species !== species) continue;
      if (a.needs) a.needs.happiness = U.clamp(a.needs.happiness + n, 0, 100);
    }
    if (A && A.needSummary) { /* no-op hook: keeps reference legal & guarded */ }
  }
  function bumpAllHealth(n) {
    var s = S();
    for (var i = 0; i < s.animals.length; i++) if (s.animals[i].needs) s.animals[i].needs.health = U.clamp(s.animals[i].needs.health + n, 0, 100);
  }

  function homeForBreed(breedId) {
    var sp = D.species[breedId] || {};
    var need = sp.buildingNeeded || (sp.isCow || sp.species === 'cow' ? 'barn' : 'pasture');
    var W = Game.World;
    if (!W) return null;
    var types = [need];
    if (need === 'barn') types.push('barn_big');
    for (var t = 0; t < types.length; t++) {
      var list = W.buildingsOfType ? (W.buildingsOfType(types[t]) || []) : [];
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if ((b.inhabitants ? b.inhabitants.length : 0) < (b.capacity || 0)) return b;
      }
    }
    // any building of the needed type even if full, else any building
    var any = W.buildingsOfType ? (W.buildingsOfType(need) || []) : [];
    if (any.length) return any[0];
    return S().buildings[0] || null;
  }

  function spawnGiftAnimal(breedId, opts) {
    try {
      var A = Game.Animals, W = Game.World;
      if (!A || !A.spawn) return false;
      var home = homeForBreed(breedId);
      var tx, ty, homeId = null;
      if (home) {
        homeId = home.id;
        var free = W && W.freeTileNear ? W.freeTileNear(home.tx + (home.w || 1), home.ty + (home.h || 1)) : null;
        if (free) { tx = free.tx; ty = free.ty; } else { tx = home.tx; ty = home.ty; }
      } else {
        var g = S().grid;
        tx = (g.w / 2) | 0; ty = (g.h / 2) | 0;
      }
      var o = opts || {};
      o.homeBuildingId = homeId;
      var id = A.spawn(breedId, tx, ty, o);
      if (id > 0 && home && W && W.addInhabitant) W.addInhabitant(homeId, id);
      return id > 0;
    } catch (e) { Game._recordError('economy.spawnGift', e); return false; }
  }

  // Apply an array of effect tokens (strings). Handles both the modern
  // eventsSpec tokens and the legacy content.events[] effect strings.
  function applyEffectTokens(arr, ctx) {
    if (!arr) return;
    if (!Array.isArray(arr)) arr = String(arr).split(',');
    ctx = ctx || {};
    // pre-scan for a shared duration (legacy "durationN" / "days:N")
    var dur = 1;
    for (var d = 0; d < arr.length; d++) {
      var dm = String(arr[d]).trim().match(/^(?:duration|days:)\s*([0-9]+)$/);
      if (dm) dur = parseInt(dm[1], 10) || 1;
    }

    arr.forEach(function (raw) {
      try {
        var tok = String(raw).trim();
        if (!tok) return;
        var lower = tok;

        // --- duration marker: already consumed above ---
        if (/^(?:duration[0-9]+|days:[0-9]+)$/.test(tok)) return;

        // --- money ---
        var mm = tok.match(/^money([*+\-])([0-9.]+)$/);
        if (mm) {
          var v = parseFloat(mm[2]);
          if (mm[1] === '+') credit(v, ctx.source || 'gift');
          else if (mm[1] === '-') { var s = S(); s.money = Math.max(0, s.money - Math.round(v)); bus.emit('money:change', { money: s.money, delta: -Math.round(v), reason: 'event' }); }
          else if (mm[1] === '*') { var s2 = S(); var nv = Math.round(s2.money * v); credit(Math.max(0, nv - s2.money), 'event'); }
          return;
        }

        // --- happiness (all / species) ---
        var hs = tok.match(/^happiness:([a-z_]+)([+\-])([0-9.]+)$/);
        if (hs) { bumpAllHappiness((hs[2] === '-' ? -1 : 1) * parseFloat(hs[3]), hs[1]); return; }
        var ha = tok.match(/^happiness(?:All)?([+\-])([0-9.]+)$/);
        if (ha) { bumpAllHappiness((ha[1] === '-' ? -1 : 1) * parseFloat(ha[2]), null); return; }
        var he = tok.match(/^health(?:All)?([+\-])([0-9.]+)$/);
        if (he) { bumpAllHealth((he[1] === '-' ? -1 : 1) * parseFloat(he[2]), null); return; }

        // --- spawns ---
        if (tok === 'spawnCalf') {
          var cow = null, s3 = S();
          for (var i = 0; i < s3.animals.length; i++) if (s3.animals[i].species === 'cow' && s3.animals[i].adult) { cow = s3.animals[i]; break; }
          var breed = cow ? cow.breed : 'holstein';
          if (spawnGiftAnimal(breed, { adult: false, ageDays: 0 })) { stat('animalsBorn', 1); notify('赤ちゃんが うまれたよ！ 🍼', 'good', '🍼', 4200); }
          return;
        }
        var sa = tok.match(/^spawnAnimal:([a-z_]+)$/) || tok.match(/^gainPet_([a-z_]+)$/) || tok.match(/^gain([A-Za-z_]+)$/);
        if (sa) {
          var bid = sa[1];
          if (D.species[bid] && spawnGiftAnimal(bid, {})) {
            var sp = D.species[bid];
            notify('あたらしい なかま！ ' + (sp.emoji || '🐾') + ' ' + (sp.name || bid), 'good', sp.emoji || '🐾', 4200);
          }
          return;
        }

        // --- item / seed grants ---
        var gi = tok.match(/^give:([a-z_]+)\+([0-9.]+)$/);
        if (gi) { addItem(gi[1], parseInt(gi[2], 10)); var pr = D.products[gi[1]]; notify('もらった！ ' + (pr ? pr.name : gi[1]) + ' ×' + gi[2], 'good', pr ? pr.emoji : '🎁', 3200); return; }
        var se = tok.match(/^seeds:([a-z_]+)\+([0-9.]+)$/);
        if (se) { var s4 = S(); s4.seeds[se[1]] = (s4.seeds[se[1]] || 0) + parseInt(se[2], 10); var cr = D.crops[se[1]]; notify('たね もらった！ ' + (cr ? cr.name : se[1]) + ' ×' + se[2], 'good', cr ? cr.emoji : '🌱', 3200); return; }

        // --- unlocks ---
        var un = tok.match(/^unlock:([a-z_]+):([a-z_]+)$/);
        if (un) {
          var typ = un[1], uid = un[2];
          var cat = typ === 'building' ? 'buildings' : (typ === 'animal' ? 'animals' : (typ === 'crop' ? 'crops' : null));
          if (cat) { unlock(cat, uid); notify('あたらしく つくれるように なった！', 'good', '🔓', 3600); }
          else if (typ === 'recipe') { S().flags['recipe_' + uid] = true; }
          return;
        }

        // --- temporary price buffs ---
        var pa = tok.match(/^(?:priceAll|sellPrice)\*([0-9.]+)$/);
        if (pa) { pushBuff({ target: 'priceAll', mult: parseFloat(pa[1]), daysLeft: dur, label: 'いちば' }); return; }
        var pg = tok.match(/^price:([a-z_]+)\*([0-9.]+)$/);
        if (pg) { pushBuff({ target: 'price', good: pg[1], mult: parseFloat(pg[2]), daysLeft: dur, label: pg[1] }); return; }
        var dp = tok.match(/^dairyPrice\*([0-9.]+)$/);
        if (dp) { pushBuff({ target: 'price', cat: 'dairy', mult: parseFloat(dp[1]), daysLeft: dur, label: '乳製品' }); return; }

        // --- generic named buff: buff:<target>*F:days or buff:<target>*F ---
        var bf = tok.match(/^buff:([a-zA-Z_]+)\*([0-9.]+)(?::([0-9]+))?$/);
        if (bf) { pushBuff({ target: bf[1], mult: parseFloat(bf[2]), daysLeft: bf[3] ? parseInt(bf[3], 10) : dur, label: bf[1] }); return; }

        // --- yield-style buffs (legacy content strings) ---
        var yt = tok.match(/^([a-zA-Z_]+)\*([0-9.]+)$/);
        if (yt && Object.prototype.hasOwnProperty.call(YIELD_BUFF_TARGETS, yt[1])) {
          pushBuff({ target: yt[1], mult: parseFloat(yt[2]), daysLeft: dur, label: yt[1] });
          return;
        }

        // --- research / weather / decor / misc (soft, best-effort) ---
        var rp = tok.match(/^research\+([0-9.]+)$/);
        if (rp) { S().research = (S().research || 0) + parseFloat(rp[1]); return; }
        var wp = tok.match(/^weather:([a-z]+)$/);
        if (wp && Game.Time && Game.Time.setWeather) { Game.Time.setWeather(wp[1]); return; }
        var sd = tok.match(/^spawnDecor:([a-z_]+)$/);
        if (sd) { stat('decorationsPlaced', 1); fx('fx:sparkle', {}); return; }
        // luck+N, needCare, autoHerd, duration markers, unknown flags -> safe no-op
      } catch (e) { Game._recordError('economy.applyEffectToken', e); }
    });
  }

  // ------------------------------------------------------------------
  //  Events
  // ------------------------------------------------------------------
  var EVENT_CHANCE_PER_DAY = 0.14;
  var DEFAULT_EVENT_COOLDOWN = 3;

  function eventCooldownOk(ev) {
    var s = S();
    if (!s.flags._evCd) s.flags._evCd = {};
    if (ev.onceOnly && s.flags._evOnce && s.flags._evOnce[ev.id]) return false;
    var last = s.flags._evCd[ev.id];
    if (last == null) return true;
    var cd = ev.cooldownDays != null ? ev.cooldownDays : DEFAULT_EVENT_COOLDOWN;
    return (s.day - last) >= cd;
  }
  function markEventFired(ev) {
    var s = S();
    if (!s.flags._evCd) s.flags._evCd = {};
    s.flags._evCd[ev.id] = s.day;
    if (ev.onceOnly) { if (!s.flags._evOnce) s.flags._evOnce = {}; s.flags._evOnce[ev.id] = true; }
    if (ev.kind === 'festival') stat('festivalsAttended', 1);
  }

  function fireEvent(ev) {
    markEventFired(ev);
    if (ev.choices && ev.choices.length) {
      _pendingEvents[ev.id] = ev;
      bus.emit('event:trigger', { event: ev, choices: ev.choices });
      notify((ev.emoji || '✨') + ' ' + ev.name, 'info', ev.emoji || '✨', 4200);
      return;
    }
    applyEffectTokens(ev.effect, { source: 'event', kind: ev.kind });
    var kind = ev.kind === 'bad' ? 'warn' : (ev.kind === 'festival' ? 'good' : (ev.kind === 'good' ? 'good' : 'info'));
    notify((ev.emoji || '✨') + ' ' + ev.name + '：' + (ev.description || ''), kind, ev.emoji || '✨', 4600);
  }

  function resolveEvent(id, choiceIdx) {
    try {
      var ev = _pendingEvents[id];
      if (!ev) return false;
      delete _pendingEvents[id];
      var choice = ev.choices && ev.choices[choiceIdx];
      if (!choice) return false;
      if (choice.cost) {
        if (typeof choice.cost === 'number') {
          if (!canAfford(choice.cost)) { notify('おかねが たりないよ〜', 'warn', '💰'); return false; }
          debit(choice.cost, 'event:' + id);
        }
      }
      applyEffectTokens(choice.effect || [], { source: 'event', kind: ev.kind });
      return true;
    } catch (e) { Game._recordError('economy.resolveEvent', e); return false; }
  }

  function rollEvents() {
    try {
      var s = S();
      var rank = s.rank || 1;
      var eligible = (D.eventsList || []).filter(function (e) {
        if ((e.minRank || 1) > rank) return false;
        return eventCooldownOk(e);
      });
      if (!eligible.length) return;
      if (!U.chance(EVENT_CHANCE_PER_DAY)) return;
      // weighted pick
      var total = 0, i;
      for (i = 0; i < eligible.length; i++) total += (eligible[i].weight || 1);
      var r = U.rng() * total, acc = 0, chosen = eligible[eligible.length - 1];
      for (i = 0; i < eligible.length; i++) { acc += (eligible[i].weight || 1); if (r <= acc) { chosen = eligible[i]; break; } }
      fireEvent(chosen);
    } catch (e) { Game._recordError('economy.rollEvents', e); }
  }

  // ------------------------------------------------------------------
  //  Dairy processing (milk -> cheese/butter/yogurt) — overnight, daily
  // ------------------------------------------------------------------
  function bestRecipe(tier) {
    var proc = D.production && D.production.processing && D.production.processing.dairy;
    if (!proc || !proc.recipes) return null;
    var recipes = proc.recipes;
    var best = null, bestVal = 0;
    Object.keys(recipes).forEach(function (rid) {
      var rc = recipes[rid];
      if (rc.tierRequired && tier < (rc.tierRequired - 1)) return;
      // can we afford the inputs?
      var ins = rc.in || {}, ok = true, inCost = 0;
      Object.keys(ins).forEach(function (item) {
        if (itemCount(item) < ins[item]) ok = false;
        inCost += price(item) * ins[item];
      });
      if (!ok) return;
      var outs = rc.out || {}, outVal = 0;
      Object.keys(outs).forEach(function (item) { outVal += price(item) * outs[item] * (rc.sellMult || 1); });
      var val = outVal - inCost;
      if (val > bestVal) { bestVal = val; best = { id: rid, rc: rc }; }
    });
    return best;
  }

  function processDairies() {
    try {
      var W = Game.World;
      if (!W || !W.buildingsOfType) return;
      var dairies = W.buildingsOfType('dairy') || [];
      if (!dairies.length) return;
      var proc = D.production.processing.dairy;
      var slotsByTier = proc.slotsByTier || [2, 3, 5];
      var yieldMult = upgradeMult('dairyYield') * upgradeMult('allYield');
      for (var di = 0; di < dairies.length; di++) {
        var d = dairies[di];
        var tier = U.clamp((d.level || 1) - 1, 0, slotsByTier.length - 1);
        var slots = slotsByTier[tier] + (upgradeMult('processSlots') || 0);
        var effSlots = Math.max(1, Math.round(slots * yieldMult));
        var made = {};
        for (var batch = 0; batch < effSlots; batch++) {
          var pick = bestRecipe(tier);
          if (!pick) break;
          var ins = pick.rc.in || {}, outs = pick.rc.out || {}, okAll = true;
          Object.keys(ins).forEach(function (item) { if (itemCount(item) < ins[item]) okAll = false; });
          if (!okAll) break;
          Object.keys(ins).forEach(function (item) { removeItem(item, ins[item]); });
          Object.keys(outs).forEach(function (item) {
            addItem(item, outs[item]);
            made[item] = (made[item] || 0) + outs[item];
            if (item === 'cheese') stat('totalCheese', outs[item]);
          });
        }
        var keys = Object.keys(made);
        if (keys.length) {
          var label = keys.map(function (k) { var p = D.products[k]; return (p ? p.emoji + p.name : k) + '×' + made[k]; }).join(' ');
          notify('加工所から ' + label + ' ができたよ！', 'good', '🧀', 3600);
        }
      }
    } catch (e) { Game._recordError('economy.processDairies', e); }
  }

  // ------------------------------------------------------------------
  //  Soft-failure stipend
  // ------------------------------------------------------------------
  function stipendCheck() {
    try {
      var s = S();
      var sf = D.difficulty.softFailure || {};
      var amt = sf.zeroCashStipend != null ? sf.zeroCashStipend : 150;
      var cd = sf.stipendCooldownDays != null ? sf.stipendCooldownDays : 2;
      if ((s.money || 0) <= 0 && (s.day - (s.lastStipendDay || -99)) >= cd) {
        credit(amt, 'stipend');
        s.lastStipendDay = s.day;
        notify(sf.stipendMessage || 'シズクの応援ボーナス♪', 'good', '💧', 4200);
      }
    } catch (e) { Game._recordError('economy.stipend', e); }
  }

  // ------------------------------------------------------------------
  //  Daily handlers
  // ------------------------------------------------------------------
  function onMarketDay() {         // FIRST day:advance subscriber
    updateMarket();
  }

  function onEconomyDay() {         // bound after Crops+Animals (game:ready)
    try {
      var s = S();
      stat('daysPlayed', 1);
      s.stats.maxAnimals = Math.max(s.stats.maxAnimals || 0, s.animals.length);
      processDairies();     // step 7
      overflowAutoSell();   // step 6 overflow safety
      rollEvents();         // step 9
      checkAchievements();
      checkGoals();
      checkRankUp();
      stipendCheck();
      decayBuffs();
    } catch (e) { Game._recordError('economy.onEconomyDay', e); }
  }

  // ------------------------------------------------------------------
  //  Lifecycle
  // ------------------------------------------------------------------
  function init(ctx) {
    try {
      seedMarketIfNeeded();
      // Handler A: market must run first each day (registered before World/Crops/Animals init).
      bus.on('day:advance', onMarketDay);
      // Handler B: bind after all modules are ready so it runs AFTER Crops/Animals.
      if (!_dailyBound) {
        bus.once('game:ready', function () {
          if (_dailyBound) return;
          _dailyBound = true;
          bus.on('day:advance', onEconomyDay);
        });
      }
      // If we were constructed after game:ready somehow (e.g. re-init), bind now.
      if (Game._ready && !_dailyBound) { _dailyBound = true; bus.on('day:advance', onEconomyDay); }
    } catch (e) { Game._recordError('economy.init', e); }
  }

  function update(steps) {
    // Per-tick cosmetic only. All economic simulation is daily (day:advance).
    // Intentionally light: nothing here may alter the sim outcome, so a paused
    // or fast-forwarded game is identical.
  }

  // ------------------------------------------------------------------
  //  Public API
  // ------------------------------------------------------------------
  return {
    init: init,
    update: update,

    // money
    canAfford: canAfford,
    debit: debit,
    credit: credit,

    // inventory
    addItem: addItem,
    removeItem: removeItem,
    itemCount: itemCount,

    // market / trade
    sell: sell,
    buySeed: buySeed,
    price: price,
    updateMarket: updateMarket,

    // progression
    addXp: addXp,
    rankInfo: rankInfo,
    netWorth: netWorth,

    // upgrades / flags / unlocks
    buyUpgrade: buyUpgrade,
    hasUpgrade: hasUpgrade,
    hasFlag: hasFlag,
    upgradeMult: upgradeMult,
    isUnlocked: isUnlocked,
    unlock: unlock,

    // stats / goals / achievements
    stat: stat,
    checkGoals: checkGoals,
    goalBoard: goalBoard,

    // events
    applyEffectTokens: applyEffectTokens,
    resolveEvent: resolveEvent
  };
})();
