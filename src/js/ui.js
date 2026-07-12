/*
 * ui.js — Game.UI: the whole HTML/CSS overlay.
 *
 * Builds the HUD (money / date / weather / clock / rank / speed / mute) into
 * #hud, a bottom #dock of big cute buttons, and every panel (shop, barn,
 * inspector, upgrades, goals, market, almanac, settings). Owns notifications
 * (toasts), tooltips, modals, the event modal, the placement banner and the
 * title screen. UI only *reads* the sim and mutates through public setters /
 * bus events — never reaches into sim internals.
 *
 * Golden rules honored: no top-level side effects (all DOM/bus/state work is
 * inside init()); reads live Game.state fresh; cross-module refs are resolved
 * inside functions and null-guarded; tick(now) is cheap (only changed numbers).
 */
Game.UI = (function () {
  'use strict';

  var U = Game.Util, D = Game.DATA, K = Game.DATA.const, bus = Game.bus;

  // ---- transient DOM refs (rebuilt each init; never persisted) ----
  var appEl, hudEl, dockEl, panelsEl, toastLayer, overlayEl;
  var bannerEl, tooltipEl, modalLayer;
  var hud = {};                 // cached HUD nodes for cheap updates
  var hudCache = {};            // last rendered values (skip DOM writes when equal)
  var panelDefs = {};           // id -> def
  var openId = null;            // currently-open panel id
  var openPayload = null;       // payload the open panel was rendered with
  var panelEl = null;           // current panel card DOM
  var scrimEl = null;
  var toasts = [];              // active toast records
  var refreshQueued = false;    // rAF-debounced live-panel refresh flag
  var dockButtons = {};         // panelId -> button el (for active state)
  var titleShown = false;

  // panels whose bodies benefit from live re-render on state changes
  var LIVE_PANELS = { barn: 1, market: 1, shop: 1, upgrades: 1, goals: 1, inspector: 1, almanac: 1 };

  // =====================================================================
  //  Tiny DOM helpers
  // =====================================================================
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function on(node, ev, fn) { if (node) node.addEventListener(ev, fn); return node; }
  function frag() { return document.createDocumentFragment(); }
  function S() { return Game.state; }

  // cross-module getters (resolved at call time; may be absent early)
  function ECO() { return Game.Economy || null; }
  function ANI() { return Game.Animals || null; }
  function WOR() { return Game.World || null; }
  function INP() { return Game.Input || null; }
  function AUD() { return Game.Audio || null; }
  function SPR() { return Game.Sprites || null; }
  function SAV() { return Game.Save || null; }

  function sfx(id) { var a = AUD(); if (a && a.sfx) { try { a.sfx(id); } catch (e) { } } }
  function gramt(n) { return U.formatG(n); }

  // Draw a kawaii portrait into a fresh canvas element (drawn once).
  function portrait(breedId, px, mood) {
    px = px || 66;
    var c = el('canvas');
    var dpr = Math.min(2, (window.devicePixelRatio || 1));
    c.width = px * dpr; c.height = px * dpr;
    c.style.width = px + 'px'; c.style.height = px + 'px';
    try {
      var ctx = c.getContext('2d');
      ctx.scale(dpr, dpr);
      var sp = SPR();
      if (sp && sp.animal) {
        var scale = px / 78;
        sp.animal(ctx, breedId, px * 0.5, px * 0.80, {
          size: scale, adult: true, mood: mood || 'happy',
          hopPhase: 0.6, facing: 1, blink: 0
        });
      } else {
        var def = D.species[breedId];
        ctx.font = (px * 0.6) + 'px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText((def && def.emoji) || '🐾', px / 2, px / 2);
      }
    } catch (e) { Game._recordError('UI.portrait', e); }
    return c;
  }

  function needBar(kind, icon, label, value) {
    var low = value < 30;
    var row = el('div', 'need ' + kind + (low ? ' low' : ''));
    row.appendChild(el('span', 'n-ic', icon));
    row.appendChild(el('span', 'n-lb', label));
    var track = el('div', 'n-track');
    var fill = el('i', 'n-fill'); fill.style.width = U.clamp(value, 0, 100) + '%';
    track.appendChild(fill); row.appendChild(track);
    row.appendChild(el('span', 'n-val', Math.round(value)));
    return row;
  }

  // =====================================================================
  //  HUD
  // =====================================================================
  function buildHud() {
    clear(hudEl);
    var left = el('div', 'hud-bar hud-left');

    // money
    var money = el('div', 'hud-chip money-chip');
    money.appendChild(el('span', 'coin', '🪙'));
    hud.money = el('span', 'money-val', '0G');
    money.appendChild(hud.money);
    left.appendChild(money);
    hud.moneyChip = money;

    // date / weather / clock
    var date = el('div', 'hud-chip date-chip');
    hud.season = el('span', 'season', '🌸春');
    hud.day = el('span', 'day', '1日目');
    hud.weather = el('span', 'weather', '☀️');
    hud.clock = el('span', 'clock', '06:00');
    date.appendChild(hud.season);
    date.appendChild(el('span', 'sep'));
    date.appendChild(hud.day);
    date.appendChild(el('span', 'sep'));
    date.appendChild(hud.weather);
    date.appendChild(hud.clock);
    left.appendChild(date);

    // rank + xp
    var rank = el('div', 'hud-chip rank-chip');
    hud.stars = el('div', 'stars', '★');
    var xpbar = el('div', 'xpbar'); hud.xp = el('i'); xpbar.appendChild(hud.xp);
    rank.appendChild(hud.stars); rank.appendChild(xpbar);
    on(rank, 'click', function () { openPanel('goals'); });
    rank.style.cursor = 'pointer';
    left.appendChild(rank);

    hudEl.appendChild(left);

    // right controls
    var right = el('div', 'hud-bar hud-right');
    hud.pause = el('button', 'hud-btn', '⏸');
    on(hud.pause, 'click', function () { if (Game.togglePause) Game.togglePause(); sfx('click'); refreshHUD(); });

    var speedGroup = el('div', 'speed-group');
    hud.speed = {};
    (K.SPEEDS || [1, 2, 3]).forEach(function (sp) {
      var b = el('button', 'sp', sp + '×');
      on(b, 'click', function () { if (Game.setSpeed) Game.setSpeed(sp); sfx('click'); refreshHUD(); });
      speedGroup.appendChild(b); hud.speed[sp] = b;
    });

    hud.mute = el('button', 'hud-btn', '🔊');
    on(hud.mute, 'click', function () {
      var s = S(); if (!s) return;
      s.settings.muted = !s.settings.muted;
      var a = AUD(); if (a && a.setMuted) a.setMuted(s.settings.muted);
      var sv = SAV(); if (sv && sv.saveSettings) sv.saveSettings();
      sfx('click'); refreshHUD();
    });

    right.appendChild(hud.pause);
    right.appendChild(speedGroup);
    right.appendChild(hud.mute);
    hudEl.appendChild(right);
  }

  function rankStars(rank) {
    var max = (D.ranksList && D.ranksList.length) || 7;
    var s = '';
    for (var i = 1; i <= max; i++) s += (i <= rank ? '★' : '☆');
    return s;
  }

  // Cheap per-frame HUD refresh: only writes DOM when a value actually changed.
  function tick(now) {
    var s = S(); if (!s || !hud.money) return;
    try {
      var mv = gramt(s.money);
      if (mv !== hudCache.money) {
        hud.money.textContent = mv;
        if (hudCache.money != null) { hud.moneyChip.classList.remove('flash'); void hud.moneyChip.offsetWidth; hud.moneyChip.classList.add('flash'); }
        hudCache.money = mv;
      }
      var seasonTxt = (K.SEASON_NAMES[s.season] || '') ;
      var seasonEmoji = { spring: '🌸', summer: '🌻', autumn: '🍁', winter: '❄️' }[s.season] || '🌸';
      var st = seasonEmoji + seasonTxt;
      if (st !== hudCache.season) { hud.season.textContent = st; hudCache.season = st; }

      var dayTxt = s.day + '日目';
      if (dayTxt !== hudCache.day) { hud.day.textContent = dayTxt; hudCache.day = dayTxt; }

      var wEmoji = { sunny: '☀️', cloudy: '☁️', rainy: '🌧️', snowy: '❄️' }[s.weather] || '☀️';
      if (wEmoji !== hudCache.weather) { hud.weather.textContent = wEmoji; hudCache.weather = wEmoji; }

      var clk = U.formatTime(s.minuteOfDay);
      if (clk !== hudCache.clock) { hud.clock.textContent = clk; hudCache.clock = clk; }

      var rk = s.rank || 1;
      if (rk !== hudCache.rank) { hud.stars.textContent = rankStars(rk); hudCache.rank = rk; }

      var E = ECO();
      var prog = 0;
      if (E && E.rankInfo) { try { prog = E.rankInfo().progress || 0; } catch (e) { } }
      var pw = Math.round(prog * 100);
      if (pw !== hudCache.xp) { hud.xp.style.width = pw + '%'; hudCache.xp = pw; }

      // pause / speed / mute reflect live state
      var paused = !!s.paused;
      var pIcon = paused ? '▶️' : '⏸';
      if (pIcon !== hudCache.pauseIcon) { hud.pause.textContent = pIcon; hud.pause.classList.toggle('on', paused); hudCache.pauseIcon = pIcon; }

      var spd = paused ? 0 : (s.settings.speed || 1);
      if (spd !== hudCache.speed) {
        for (var k in hud.speed) hud.speed[k].classList.toggle('active', !paused && (+k === (s.settings.speed || 1)));
        hudCache.speed = spd;
      }
      var muted = !!s.settings.muted;
      if (muted !== hudCache.muted) { hud.mute.textContent = muted ? '🔇' : '🔊'; hud.mute.classList.toggle('on', muted); hudCache.muted = muted; }

      // fade toast timers
      updateToasts(now);
    } catch (e) { Game._recordError('UI.tick', e); }
  }

  function refreshHUD() { hudCache = {}; tick(performance ? performance.now() : Date.now()); }

  // =====================================================================
  //  Dock
  // =====================================================================
  var DOCK = [
    { icon: '🛒', label: 'ショップ', panel: 'shop', payload: { tab: 'animals' }, key: 'shop:animals' },
    { icon: '🐄', label: 'どうぶつ', panel: 'barn', key: 'barn' },
    { icon: '🔨', label: 'たてる', panel: 'shop', payload: { tab: 'buildings' }, key: 'shop:buildings' },
    { icon: '🌱', label: 'さくもつ', panel: 'shop', payload: { tab: 'seeds' }, key: 'shop:seeds' },
    { icon: '⬆️', label: 'アップグレード', panel: 'upgrades', key: 'upgrades' },
    { icon: '🎯', label: 'もくひょう', panel: 'goals', key: 'goals' },
    { icon: '📈', label: 'マーケット', panel: 'market', key: 'market' },
    { icon: '📖', label: 'ずかん', panel: 'almanac', key: 'almanac' },
    { icon: '⚙️', label: 'せってい', panel: 'settings', key: 'settings' }
  ];

  function buildDock() {
    clear(dockEl);
    var inner = el('div', 'dock-inner');
    DOCK.forEach(function (d) {
      var b = el('button', 'dock-btn');
      b.appendChild(el('span', 'ic', d.icon));
      b.appendChild(el('span', 'lb', d.label));
      on(b, 'click', function () {
        sfx('click');
        // toggle: same panel + same tab closes
        var sameTab = (openId === d.panel) && sameKey(openPayload, d.payload);
        if (sameTab) { closePanel(d.panel); }
        else { openPanel(d.panel, d.payload); }
      });
      inner.appendChild(b);
      dockButtons[d.key] = b;
    });
    dockEl.appendChild(inner);
  }
  function sameKey(a, b) {
    var ta = (a && a.tab) || null, tb = (b && b.tab) || null;
    return ta === tb;
  }
  function refreshDockActive() {
    var activeKey = null;
    if (openId) {
      activeKey = openId;
      if (openId === 'shop') activeKey = 'shop:' + ((openPayload && openPayload.tab) || 'animals');
    }
    for (var k in dockButtons) dockButtons[k].classList.toggle('active', k === activeKey);
  }

  // =====================================================================
  //  Panel framework
  // =====================================================================
  function registerPanel(def) {
    if (!def || !def.id) return;
    panelDefs[def.id] = def;
  }

  function openPanel(id, payload) {
    var def = panelDefs[id];
    if (!def) return;
    try {
      // If a *different* panel is open, remove it immediately (no cross-fade clutter).
      if (openId && openId !== id && panelEl) removePanelDom(true);

      if (openId === id && panelEl) {
        // same panel, re-render (e.g., tab switch) in place
        openPayload = payload || openPayload || {};
        renderPanelBody(def, openPayload);
        refreshDockActive();
        return;
      }

      openId = id; openPayload = payload || {};

      if (!scrimEl) {
        scrimEl = el('div', 'panel-scrim');
        on(scrimEl, 'click', function () { closePanel(openId); });
        panelsEl.appendChild(scrimEl);
      }
      requestAnimationFrame(function () { if (scrimEl) scrimEl.classList.add('show'); });

      panelEl = el('div', 'panel');
      var head = el('div', 'panel-head');
      head.appendChild(el('span', 'p-ic', def.icon || '📋'));
      head.appendChild(el('span', 'p-title', def.title || ''));
      var close = el('button', 'panel-close', '✕');
      on(close, 'click', function () { closePanel(id); });
      head.appendChild(close);
      panelEl.appendChild(head);

      var body = el('div', 'panel-body');
      panelEl.appendChild(body);
      panelEl._body = body;
      panelsEl.appendChild(panelEl);

      renderPanelBody(def, openPayload);

      requestAnimationFrame(function () { if (panelEl) panelEl.classList.add('open'); });
      if (def.onOpen) { try { def.onOpen(); } catch (e) { Game._recordError('panel.onOpen:' + id, e); } }
      bus.emit('ui:panel:open', { panel: id });
      sfx('pop');
      refreshDockActive();
    } catch (e) { Game._recordError('UI.openPanel:' + id, e); }
  }

  function renderPanelBody(def, payload) {
    var body = panelEl && panelEl._body;
    if (!body) return;
    var scrollTop = body.scrollTop;
    clear(body);
    try { def.render(body, S(), payload || {}); }
    catch (e) { Game._recordError('panel.render:' + def.id, e); body.appendChild(el('div', 'empty-note', 'ちょっと調子がわるいみたい…')); }
    body.scrollTop = scrollTop;
  }

  function removePanelDom(immediate) {
    var p = panelEl; panelEl = null;
    if (p) {
      if (immediate) { if (p.parentNode) p.parentNode.removeChild(p); }
      else {
        p.classList.add('closing');
        setTimeout(function () { if (p && p.parentNode) p.parentNode.removeChild(p); }, 340);
      }
    }
  }

  function closePanel(id) {
    if (id && openId && id !== openId) return;
    var def = openId ? panelDefs[openId] : null;
    var closingId = openId;
    if (def && def.onClose) { try { def.onClose(); } catch (e) { } }
    removePanelDom(false);
    if (scrimEl) {
      scrimEl.classList.remove('show');
      var sc = scrimEl; scrimEl = null;
      setTimeout(function () { if (sc && sc.parentNode) sc.parentNode.removeChild(sc); }, 300);
    }
    openId = null; openPayload = null;
    if (closingId) bus.emit('ui:panel:close', { panel: closingId });
    refreshDockActive();
  }

  function togglePanel(id, payload) {
    if (openId === id) closePanel(id); else openPanel(id, payload);
  }

  function queuePanelRefresh() {
    if (refreshQueued) return;
    if (!openId || !LIVE_PANELS[openId]) return;
    refreshQueued = true;
    requestAnimationFrame(function () {
      refreshQueued = false;
      if (openId && panelDefs[openId] && LIVE_PANELS[openId]) renderPanelBody(panelDefs[openId], openPayload);
    });
  }

  // =====================================================================
  //  Placement handoff (build / plant / decor tools)
  // =====================================================================
  function startPlacement(type, isDecor) {
    var inp = INP();
    var def = isDecor ? (D.decorations && D.decorations[type]) : (D.buildings && D.buildings[type]);
    var name = (def && def.name) || 'たてもの';
    var emoji = (def && def.emoji) || '🏗️';
    closePanel(openId);
    if (inp && inp.setTool) {
      try { inp.setTool('build', { type: type, decor: !!isDecor }); } catch (e) { Game._recordError('UI.startPlacement', e); }
      setPlacementBanner(emoji + ' ' + name + ' を おきたい ばしょを タップ');
    } else {
      notify({ text: 'いま せっちできないみたい（準備中）', icon: emoji, kind: 'warn' });
    }
  }
  function startPlant(cropId) {
    var inp = INP();
    var def = D.crops && D.crops[cropId];
    var name = (def && def.name) || 'たね';
    var emoji = (def && def.emoji) || '🌱';
    closePanel(openId);
    if (inp && inp.setTool) {
      try { inp.setTool('plant', { cropId: cropId }); } catch (e) { Game._recordError('UI.startPlant', e); }
      setPlacementBanner(emoji + ' ' + name + ' を うえる ばしょを タップ');
    } else {
      notify({ text: 'いま うえられないみたい（準備中）', icon: emoji, kind: 'warn' });
    }
  }

  function setPlacementBanner(text) {
    if (!bannerEl) return;
    if (text == null) { bannerEl.classList.remove('show'); return; }
    clear(bannerEl);
    bannerEl.appendChild(el('span', 'b-txt', text));
    var cancel = el('button', 'b-cancel', '✕');
    on(cancel, 'click', function () {
      var inp = INP(); if (inp && inp.clearTool) { try { inp.clearTool(); } catch (e) { } }
      setPlacementBanner(null); sfx('click');
    });
    bannerEl.appendChild(cancel);
    bannerEl.classList.add('show');
  }

  // =====================================================================
  //  PANEL: shop  (animals / buildings / seeds / decorations)
  // =====================================================================
  function renderShop(body, s, payload) {
    var tab = (payload && payload.tab) || 'animals';
    var tabbar = el('div', 'tabbar');
    [['animals', '🐄 どうぶつ'], ['buildings', '🔨 たてもの'], ['seeds', '🌱 さくもつ'], ['decor', '🎀 かざり']].forEach(function (t) {
      var b = el('button', 'tab' + (tab === t[0] ? ' active' : ''), t[1]);
      on(b, 'click', function () { openPanel('shop', { tab: t[0] }); });
      tabbar.appendChild(b);
    });
    body.appendChild(tabbar);

    if (tab === 'animals') renderShopAnimals(body, s);
    else if (tab === 'buildings') renderShopBuildings(body, s);
    else if (tab === 'seeds') renderShopSeeds(body, s);
    else renderShopDecor(body, s);
  }

  function renderShopAnimals(body, s) {
    var E = ECO();
    var grid = el('div', 'card-grid');
    var list = (D.cowBreedsList || []).concat(D.animalsList || []);
    list.forEach(function (def) {
      var unlocked = E && E.isUnlocked ? E.isUnlocked('animals', def.id) : ((def.unlockRank || 1) <= (s.rank || 1));
      var card = el('div', 'card' + (unlocked ? '' : ' locked'));
      card.appendChild(portrait(def.id, 66, 'happy'));
      card.appendChild(el('div', 'c-name', (def.emoji || '🐾') + ' ' + def.name));
      if (def.rarity) {
        var rr = el('div', 'c-row');
        rr.appendChild(el('span', 'rarity ' + def.rarity, rarityJa(def.rarity)));
        rr.appendChild(el('span', 'price', U.formatNum(def.buyPrice || 0)));
        card.appendChild(rr);
      } else {
        var rr2 = el('div', 'c-row');
        rr2.appendChild(el('span', 'pill', prodPill(def)));
        rr2.appendChild(el('span', 'price', U.formatNum(def.buyPrice || 0)));
        card.appendChild(rr2);
      }
      card.appendChild(el('div', 'c-blurb', def.cutenessBlurb || ''));
      if (unlocked) {
        var buy = el('button', 'btn mint sm wide', 'おむかえ');
        on(buy, 'click', function () {
          var a = ANI();
          if (a && a.buy) {
            var r = a.buy(def.id, null);
            if (r && r.ok) { sfx('pop'); queuePanelRefresh(); }
            else sfx('error');
          }
        });
        card.appendChild(buy);
      } else {
        veil(card, '★' + (def.unlockRank || 1) + 'で かいほう');
      }
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }

  function renderShopBuildings(body, s) {
    var E = ECO();
    var grid = el('div', 'card-grid');
    (D.buildingsList || []).forEach(function (def) {
      // hide pure upgrade variants (reached via building inspector) to reduce clutter
      if (def.upgradeOf) return;
      var unlocked = E && E.isUnlocked ? E.isUnlocked('buildings', def.id) : ((def.unlockRank || 1) <= (s.rank || 1));
      var card = el('div', 'card' + (unlocked ? '' : ' locked'));
      var top = el('div', 'card-top');
      top.style.justifyContent = 'center';
      top.appendChild(el('span', 'c-emoji', def.emoji || '🏠')); top.querySelector('.c-emoji').style.fontSize = '38px';
      card.appendChild(top);
      card.appendChild(el('div', 'c-name', def.name));
      var r = el('div', 'c-row');
      var fp = def.footprint || [2, 2];
      r.appendChild(el('span', 'pill', fp[0] + '×' + fp[1] + ' マス'));
      r.appendChild(el('span', 'price', U.formatNum(def.buildCost || 0)));
      card.appendChild(r);
      if (def.capacity) card.appendChild(el('div', 'c-blurb', 'しゅうよう ' + def.capacity + '　' + (def.cutenessBlurb || '')));
      else card.appendChild(el('div', 'c-blurb', def.cutenessBlurb || def.function || ''));
      if (unlocked) {
        var b = el('button', 'btn sky sm wide', '🔨 たてる');
        on(b, 'click', function () { startPlacement(def.id, false); });
        card.appendChild(b);
      } else {
        veil(card, '★' + (def.unlockRank || 1) + 'で かいほう');
      }
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }

  function renderShopSeeds(body, s) {
    var E = ECO();
    var grid = el('div', 'card-grid');
    (D.cropsList || []).forEach(function (def) {
      if (def.isDecor) return;
      var card = el('div', 'card');
      var top = el('div', 'card-top'); top.style.justifyContent = 'center';
      var em = el('span', 'c-emoji', def.emoji || '🌱'); em.style.fontSize = '36px';
      top.appendChild(em);
      card.appendChild(top);
      card.appendChild(el('div', 'c-name', def.name));
      var seasons = el('div', 'c-row'); seasons.style.flexWrap = 'wrap'; seasons.style.justifyContent = 'center';
      (def.season || []).forEach(function (ss) {
        var inNow = (ss === s.season);
        var p = el('span', 'pill' + (inNow ? ' season' : ''), (K.SEASON_NAMES[ss] || ss));
        seasons.appendChild(p);
      });
      card.appendChild(seasons);
      var owned = (s.seeds && s.seeds[def.id]) || 0;
      var r = el('div', 'c-row');
      r.appendChild(el('span', 'pill', 'そだち ' + (def.growDays || '?') + '日'));
      r.appendChild(el('span', 'pill', 'たね×' + owned));
      card.appendChild(r);
      var priceRow = el('div', 'c-row');
      priceRow.appendChild(el('span', '', 'たね'));
      priceRow.appendChild(el('span', 'price', U.formatNum(def.seedPrice || 0)));
      card.appendChild(priceRow);

      var row = el('div', 'btn-row');
      var buy = el('button', 'btn pri sm', '🛒 かう');
      on(buy, 'click', function () {
        if (E && E.buySeed) { if (E.buySeed(def.id, 1)) { sfx('coin'); queuePanelRefresh(); } else sfx('error'); }
      });
      var plant = el('button', 'btn mint sm', '🌱 うえる');
      if (owned <= 0) plant.setAttribute('disabled', '');
      on(plant, 'click', function () { startPlant(def.id); });
      row.appendChild(buy); row.appendChild(plant);
      card.appendChild(row);
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }

  function renderShopDecor(body, s) {
    var grid = el('div', 'card-grid');
    (D.decorationsList || []).forEach(function (def) {
      var card = el('div', 'card');
      var top = el('div', 'card-top'); top.style.justifyContent = 'center';
      var em = el('span', 'c-emoji', def.emoji || '🎀'); em.style.fontSize = '36px';
      top.appendChild(em); card.appendChild(top);
      card.appendChild(el('div', 'c-name', def.name));
      var r = el('div', 'c-row');
      if (def.happinessBoost) r.appendChild(el('span', 'pill good', '💖+' + def.happinessBoost));
      r.appendChild(el('span', 'price', U.formatNum(def.cost || 0)));
      card.appendChild(r);
      card.appendChild(el('div', 'c-blurb', def.cutenessBlurb || ''));
      var b = el('button', 'btn pink sm wide', '🎀 おく');
      on(b, 'click', function () { startPlacement(def.id, true); });
      card.appendChild(b);
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }

  function prodPill(def) {
    var pid = def.product;
    var pd = pid && D.products[pid];
    return (pd ? (pd.emoji + pd.name) : (def.kind || '')) ;
  }
  function rarityJa(r) {
    return { common: 'ふつう', uncommon: 'レア', rare: 'レア＋', epic: 'エピック', legendary: 'でんせつ' }[r] || r;
  }
  function veil(card, txt) {
    var v = el('div', 'card-lock-veil');
    v.appendChild(el('div', 'big', '🔒'));
    v.appendChild(el('div', '', txt));
    card.appendChild(v);
  }

  // =====================================================================
  //  PANEL: barn  (all animals + buildings)
  // =====================================================================
  function renderBarn(body, s) {
    var a = ANI();
    var animals = (s.animals || []).slice();
    var head = el('div', 'section-title', '🐾 どうぶつ ' + animals.length + 'ひき');
    body.appendChild(head);

    if (!animals.length) {
      body.appendChild(emptyNote('🐄', 'まだ どうぶつが いないよ。\nショップから おむかえしよう！', 'ショップへ', function () { openPanel('shop', { tab: 'animals' }); }));
    } else {
      animals.sort(function (x, y) { return (x.homeBuildingId || 0) - (y.homeBuildingId || 0); });
      animals.forEach(function (an) {
        var sum = (a && a.needSummary) ? a.needSummary(an.id) : an.needs;
        var row = el('div', 'a-row');
        row.appendChild(portraitRow(an, sum));
        var info = el('div', 'a-info');
        var name = el('div', 'a-name');
        name.appendChild(document.createTextNode((speciesEmoji(an.breed)) + ' ' + an.name));
        if (an.pregnant) name.appendChild(el('span', 'pill season', '🤰'));
        if (!an.adult) name.appendChild(el('span', 'pill', 'あかちゃん'));
        info.appendChild(name);
        info.appendChild(el('div', 'a-mood', moodFace(sum.mood) + ' ' + (sum.label || '')));
        var mn = el('div', 'mini-needs');
        mn.appendChild(miniNeed(sum.hunger, 'var(--need-hunger)'));
        mn.appendChild(miniNeed(sum.happiness, 'var(--need-happy)'));
        mn.appendChild(miniNeed(sum.health, 'var(--need-health)'));
        mn.appendChild(miniNeed(sum.cleanliness, 'var(--need-clean)'));
        info.appendChild(mn);
        row.appendChild(info);
        if (an.production && an.production.ready) {
          var badge = el('div', 'pill good', productEmoji(an.production.itemId));
          badge.style.flex = '0 0 auto';
          row.appendChild(badge);
        }
        on(row, 'click', function () { openInspector('animal', an.id); });
        body.appendChild(row);
      });
    }

    // buildings quick list
    if (s.buildings && s.buildings.length) {
      body.appendChild(el('div', 'section-title', '🏠 たてもの'));
      s.buildings.forEach(function (b) {
        var def = D.buildings[b.type]; if (!def) return;
        var row = el('div', 'a-row');
        var ic = el('div', 'a-port');
        ic.style.display = 'flex'; ic.style.alignItems = 'center'; ic.style.justifyContent = 'center'; ic.style.fontSize = '30px';
        ic.textContent = def.emoji || '🏠';
        row.appendChild(ic);
        var info = el('div', 'a-info');
        info.appendChild(el('div', 'a-name', def.name + (b.level > 1 ? ' Lv' + b.level : '')));
        var sub = def.capacity ? ('しゅうよう ' + (b.inhabitants ? b.inhabitants.length : 0) + ' / ' + (b.capacity || 0)) : (def.function || '');
        info.appendChild(el('div', 'a-mood', sub));
        row.appendChild(info);
        on(row, 'click', function () { openInspector('building', b.id); });
        body.appendChild(row);
      });
    }
  }

  function portraitRow(an, sum) {
    var c = portrait(an.breed, 54, sum ? sum.mood : 'neutral');
    c.className = 'a-port';
    return c;
  }
  function miniNeed(v, color) {
    var m = el('div', 'mn'); var i = el('i');
    i.style.width = U.clamp(v, 0, 100) + '%';
    i.style.background = (v < 30) ? 'var(--alert)' : color;
    m.appendChild(i); return m;
  }
  function speciesEmoji(breed) { var d = D.species[breed]; return (d && d.emoji) || '🐾'; }
  function productEmoji(pid) { var p = pid && D.products[pid]; return (p && p.emoji) || '📦'; }
  function productName(pid) { var p = pid && D.products[pid]; return (p && p.name) || pid; }
  function moodFace(mood) {
    return { blissful: '😍', happy: '😊', content: '🙂', hungry: '😟', starving: '😵', dirty: '😖', sick: '🤒', unhappy: '🥺' }[mood] || '🙂';
  }

  // =====================================================================
  //  PANEL: inspector  (animal | building)
  // =====================================================================
  function renderInspector(body, s, payload) {
    if (!payload || payload.kind == null) { body.appendChild(emptyNote('🔍', 'なにも えらばれていないよ')); return; }
    if (payload.kind === 'animal') renderAnimalInspector(body, s, payload.id);
    else if (payload.kind === 'building') renderBuildingInspector(body, s, payload.id);
  }

  function renderAnimalInspector(body, s, id) {
    var a = ANI();
    var an = a && a.get ? a.get(id) : findAnimal(id);
    if (!an) { body.appendChild(emptyNote('🐾', 'いなくなっちゃった…')); return; }
    var def = D.species[an.breed] || {};
    var sum = (a && a.needSummary) ? a.needSummary(id) : an.needs;

    var hero = el('div', 'insp-hero');
    var hp = portrait(an.breed, 108, sum.mood); hp.className = 'hero-port';
    hero.appendChild(hp);
    var meta = el('div', 'hero-meta');
    var nm = el('div', 'hero-name');
    nm.appendChild(document.createTextNode(an.name));
    var ren = el('button', 'panel-close', '✏️'); ren.style.width = '32px'; ren.style.height = '32px'; ren.style.fontSize = '15px';
    on(ren, 'click', function () { doRename(an); });
    nm.appendChild(ren);
    meta.appendChild(nm);
    var subTxt = (def.emoji || '') + (def.name || an.breed) + '　' + (an.sex === 'f' ? '♀' : '♂') +
      '　' + (an.adult ? 'おとな' : 'あかちゃん') + '　' + Math.floor(an.ageDays || 0) + '日';
    meta.appendChild(el('div', 'hero-sub', subTxt));
    meta.appendChild(el('span', 'hero-mood', moodFace(sum.mood) + ' ' + (sum.label || '')));
    if (an.traits && an.traits.length) {
      var tb = el('div', ''); tb.style.marginTop = '6px'; tb.style.display = 'flex'; tb.style.gap = '4px'; tb.style.flexWrap = 'wrap';
      an.traits.forEach(function (t) { tb.appendChild(el('span', 'trait-badge', traitJa(t))); });
      meta.appendChild(tb);
    }
    hero.appendChild(meta);
    body.appendChild(hero);

    // need bars
    var needs = el('div', 'needs');
    needs.appendChild(needBar('hunger', '🍚', 'まんぷく', sum.hunger));
    needs.appendChild(needBar('happy', '💖', 'きげん', sum.happiness));
    needs.appendChild(needBar('health', '❤️‍🩹', 'けんこう', sum.health));
    needs.appendChild(needBar('clean', '🫧', 'きれい', sum.cleanliness));
    body.appendChild(needs);

    // production status
    var ps = el('div', 'prod-status');
    if (an.production && an.production.ready && an.production.amount > 0) {
      ps.appendChild(el('span', 'ps-ic', productEmoji(an.production.itemId)));
      ps.appendChild(el('span', '', productName(an.production.itemId) + ' ×' + Math.round(an.production.amount) + ' が とれるよ！'));
    } else if (!an.adult) {
      ps.appendChild(el('span', 'ps-ic', '🍼'));
      ps.appendChild(el('span', '', 'おとなになると せいさんを はじめるよ'));
    } else {
      ps.appendChild(el('span', 'ps-ic', '⏳'));
      var prog = an.production ? Math.round((an.production.cycleProgress || 0) * 100) : 0;
      ps.appendChild(el('span', '', productName(an.production && an.production.itemId) + ' じゅんびちゅう… ' + prog + '%'));
    }
    body.appendChild(ps);

    if (def.cutenessBlurb) body.appendChild(el('div', 'blurb', '💬 ' + def.cutenessBlurb));

    // actions
    var acts = el('div', 'btn-row');
    if (an.production && an.production.ready && an.production.amount > 0) {
      var col = el('button', 'btn pri', productEmoji(an.production.itemId) + ' あつめる');
      on(col, 'click', function () { if (a && a.collect) { a.collect(id); queuePanelRefresh(); } });
      acts.appendChild(col);
    }
    var feed = el('button', 'btn mint', '🍚 ごはん');
    on(feed, 'click', function () { doFeed(an); });
    var pet = el('button', 'btn pink', '💖 なでる');
    on(pet, 'click', function () { if (a && a.pet) { a.pet(id); queuePanelRefresh(); } });
    var clean = el('button', 'btn sky', '🫧 おそうじ');
    on(clean, 'click', function () { if (a && a.clean) { a.clean(id); queuePanelRefresh(); } });
    acts.appendChild(feed); acts.appendChild(pet); acts.appendChild(clean);
    body.appendChild(acts);

    var acts2 = el('div', 'btn-row'); acts2.style.marginTop = '8px';
    var breed = el('button', 'btn ghost', '💕 こうはい');
    on(breed, 'click', function () { doBreed(an); });
    var sell = el('button', 'btn danger', '💰 うる');
    on(sell, 'click', function () { doSellAnimal(an); });
    acts2.appendChild(breed); acts2.appendChild(sell);
    body.appendChild(acts2);
  }

  function renderBuildingInspector(body, s, id) {
    var W = WOR();
    var b = (W && W.getBuilding) ? W.getBuilding(id) : findBuilding(id);
    if (!b) { body.appendChild(emptyNote('🏠', 'たてものが みつからない…')); return; }
    var def = D.buildings[b.type] || {};

    var hero = el('div', 'insp-hero');
    var ic = el('div', 'hero-port');
    ic.style.display = 'flex'; ic.style.alignItems = 'center'; ic.style.justifyContent = 'center'; ic.style.fontSize = '56px';
    ic.textContent = def.emoji || '🏠';
    hero.appendChild(ic);
    var meta = el('div', 'hero-meta');
    meta.appendChild(el('div', 'hero-name', def.name + (b.level > 1 ? ' Lv' + b.level : '')));
    meta.appendChild(el('div', 'hero-sub', def.function || def.cutenessBlurb || ''));
    if (def.capacity) meta.appendChild(el('span', 'hero-mood', '🏡 ' + (b.inhabitants ? b.inhabitants.length : 0) + ' / ' + (b.capacity || 0)));
    hero.appendChild(meta);
    body.appendChild(hero);

    // storage
    var storeKeys = b.storage ? Object.keys(b.storage).filter(function (k) { return b.storage[k] > 0; }) : [];
    if (storeKeys.length) {
      body.appendChild(el('div', 'section-title', '📦 ほかん'));
      storeKeys.forEach(function (k) {
        var row = el('div', 'storage-row');
        row.appendChild(el('span', '', productEmoji(k) + ' ' + productName(k)));
        var qty = el('span', ''); qty.style.marginLeft = 'auto'; qty.textContent = '×' + b.storage[k];
        row.appendChild(qty);
        body.appendChild(row);
      });
    }

    // inhabitants
    if (b.inhabitants && b.inhabitants.length) {
      body.appendChild(el('div', 'section-title', '🐾 すんでいる子'));
      b.inhabitants.forEach(function (aid) {
        var an = findAnimal(aid); if (!an) return;
        var a = ANI();
        var sum = (a && a.needSummary) ? a.needSummary(aid) : an.needs;
        var row = el('div', 'a-row');
        row.appendChild(portraitRow(an, sum));
        var info = el('div', 'a-info');
        info.appendChild(el('div', 'a-name', speciesEmoji(an.breed) + ' ' + an.name));
        info.appendChild(el('div', 'a-mood', moodFace(sum.mood) + ' ' + (sum.label || '')));
        row.appendChild(info);
        on(row, 'click', function () { openInspector('animal', aid); });
        body.appendChild(row);
      });
    }

    // actions
    body.appendChild(el('div', 'section-title', ''));
    var acts = el('div', 'btn-row');
    // collect (animal houses)
    var a = ANI();
    if (def.capacity && a && a.collectBuilding) {
      var col = el('button', 'btn pri', '🧺 まとめて あつめる');
      on(col, 'click', function () { var r = a.collectBuilding(id); queuePanelRefresh(); });
      acts.appendChild(col);
    }
    if (def.capacity && a && a.feedBuilding) {
      var fb = el('button', 'btn mint', '🍚 みんなに ごはん');
      on(fb, 'click', function () { feedBuildingAll(b); });
      acts.appendChild(fb);
    }
    body.appendChild(acts);

    var acts2 = el('div', 'btn-row'); acts2.style.marginTop = '8px';
    var upCost = upgradeCostOf(b);
    var up = el('button', 'btn sky', upCost != null ? ('🔧 改築 約' + gramt(upCost)) : '🔧 最高レベル');
    if (upCost == null) up.setAttribute('disabled', '');
    on(up, 'click', function () { if (W && W.upgrade) { if (W.upgrade(id)) { sfx('levelup'); queuePanelRefresh(); } } });
    acts2.appendChild(up);
    if (def.capacity) {
      var add = el('button', 'btn ghost', '➕ どうぶつ');
      on(add, 'click', function () { openPanel('shop', { tab: 'animals' }); });
      acts2.appendChild(add);
    }
    body.appendChild(acts2);
  }

  function upgradeCostOf(b) {
    // approximate World's generic escalating-cost formula for a helpful label;
    // World.upgrade remains authoritative (charges the real cost / notifies if maxed).
    var def = D.buildings[b.type]; if (!def) return null;
    var maxLvl = 4;
    if ((b.level || 1) >= maxLvl) return null;
    return Math.round((def.buildCost || 200) * (0.75 + 0.55 * (b.level || 1)));
  }

  function feedBuildingAll(b) {
    var a = ANI(), E = ECO(); if (!a || !a.feedBuilding) return;
    var feedId = pickFeedItem();
    if (!feedId) { notify({ text: 'エサが ないよ〜。さくもつを しゅうかくしよう', icon: '🌾', kind: 'warn' }); sfx('error'); return; }
    var n = a.feedBuilding(b.id, feedId);
    if (n > 0) { sfx('pop'); queuePanelRefresh(); }
    else notify({ text: 'みんな おなかいっぱいみたい', icon: '😌', kind: 'info' });
  }

  function doFeed(an) {
    var a = ANI(); if (!a || !a.feed) return;
    var feedId = pickFeedItem();
    if (!feedId) { notify({ text: 'エサが ないよ〜。さくもつを しゅうかくしよう', icon: '🌾', kind: 'warn' }); sfx('error'); return; }
    if (a.feed(an.id, feedId)) { sfx('pop'); queuePanelRefresh(); }
    else notify({ text: an.name + 'は おなかいっぱいみたい', icon: '😌', kind: 'info' });
  }

  // pick the best available feed item present in inventory (data-driven).
  // Prefer higher feedQuality/hunger from balance.feed.feedItems.
  function pickFeedItem() {
    var s = S(); var inv = s.inventory || {};
    var items = (D.feed && D.feed.feedItems) || null;
    if (items) {
      var keys = Object.keys(items).filter(function (k) { return (inv[k] || 0) > 0; });
      keys.sort(function (x, y) {
        var fx = items[x] || {}, fy = items[y] || {};
        return ((fy.feedQuality || 0) * 100 + (fy.hunger || 0)) - ((fx.feedQuality || 0) * 100 + (fx.hunger || 0));
      });
      if (keys.length) return keys[0];
    }
    var order = ['alfalfa', 'corn', 'wheat', 'hay', 'clover', 'grass', 'carrot', 'turnip', 'pumpkin'];
    for (var i = 0; i < order.length; i++) if ((inv[order[i]] || 0) > 0) return order[i];
    for (var k in inv) { if (inv[k] > 0 && D.crops[k]) return k; }
    return null;
  }

  function doRename(an) {
    promptText('なまえを つける', an.name, function (val) {
      val = (val || '').trim().slice(0, 12);
      if (!val) return;
      var a = ANI(); if (a && a.rename) a.rename(an.id, val);
      queuePanelRefresh();
      sfx('pop');
    });
  }

  function doSellAnimal(an) {
    var a = ANI(); if (!a) return;
    var def = D.species[an.breed] || {};
    var val = def.sellValue != null ? def.sellValue : Math.round((def.buyPrice || 0) * 0.5);
    confirm(an.name + ' を ' + gramt(val) + ' で てばなしますか？').then(function (yes) {
      if (!yes) return;
      if (a.sell) { var r = a.sell(an.id); if (r && r.ok) { sfx('coin'); openPanel('barn'); } }
    });
  }

  function doBreed(an) {
    var a = ANI(); if (!a) return;
    var s = S();
    // eligible partners
    var cands = (s.animals || []).filter(function (o) {
      if (o.id === an.id) return false;
      if (a.canBreed) { try { return a.canBreed(an.id, o.id); } catch (e) { return false; } }
      return o.species === an.species && o.adult && o.sex !== an.sex;
    });
    if (!cands.length) {
      modal({ title: '💕 こうはい', body: '<span class="big-emoji">🥚</span>いま ペアに できる おともだちが いないみたい。<br>おなじ種類で、おとな・ごきげんな子が ひつようだよ。', buttons: [{ label: 'とじる', value: 'ok', kind: 'ghost' }] });
      return;
    }
    var list = el('div');
    list.appendChild(el('div', 'blurb', an.name + ' の おあいての子を えらんでね💕'));
    cands.forEach(function (o) {
      var a2 = ANI();
      var sum = (a2 && a2.needSummary) ? a2.needSummary(o.id) : o.needs;
      var row = el('div', 'a-row');
      row.appendChild(portraitRow(o, sum));
      var info = el('div', 'a-info');
      info.appendChild(el('div', 'a-name', speciesEmoji(o.breed) + ' ' + o.name + ' ' + (o.sex === 'f' ? '♀' : '♂')));
      info.appendChild(el('div', 'a-mood', moodFace(sum.mood) + ' ' + (sum.label || '')));
      row.appendChild(info);
      on(row, 'click', function () {
        closeModal('picked');
        var r = a.breed ? a.breed(an.id, o.id) : { ok: false };
        if (r && r.ok) { sfx('heart'); notify({ text: '💕 なかよし！ あかちゃんが たのしみだね', icon: '💕', kind: 'good' }); }
        else if (r && r.reason) { notify({ text: r.reason, icon: '💔', kind: 'warn' }); }
        queuePanelRefresh();
      });
      list.appendChild(row);
    });
    modal({ title: '💕 こうはい', body: list, buttons: [{ label: 'やめる', value: 'cancel', kind: 'ghost' }] });
  }

  function traitJa(t) {
    return { sparkle_coat: '✨キラ毛', heterochromia: '👀オッドアイ', golden: '🌟ゴールデン', hardy: '💪じょうぶ', friendly: '🥰なつっこい', lazy: '😴のんびり' }[t] || t;
  }

  function findAnimal(id) { var s = S(); for (var i = 0; i < s.animals.length; i++) if (s.animals[i].id === id) return s.animals[i]; return null; }
  function findBuilding(id) { var s = S(); for (var i = 0; i < s.buildings.length; i++) if (s.buildings[i].id === id) return s.buildings[i]; return null; }

  // =====================================================================
  //  PANEL: upgrades
  // =====================================================================
  function renderUpgrades(body, s) {
    var E = ECO();
    var grid = el('div', 'card-grid');
    grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(200px, 1fr))';
    (D.upgradesList || []).forEach(function (u) {
      var owned = E && E.hasUpgrade ? E.hasUpgrade(u.id) : !!(s.upgrades && s.upgrades[u.id]);
      var rankOk = (u.unlockRank || 1) <= (s.rank || 1);
      var reqOk = true, reqMissing = null;
      (u.requires || []).forEach(function (rq) {
        var has = E && E.hasUpgrade ? E.hasUpgrade(rq) : !!(s.upgrades && s.upgrades[rq]);
        if (!has) { reqOk = false; reqMissing = D.upgrades[rq]; }
      });
      var card = el('div', 'card' + (owned ? '' : (rankOk && reqOk ? '' : ' locked')));
      var top = el('div', 'card-top');
      top.appendChild(el('span', 'c-emoji', u.emoji || '⭐')); top.querySelector('.c-emoji').style.fontSize = '26px';
      top.appendChild(el('span', 'c-name', u.name));
      top.querySelector('.c-name').style.textAlign = 'left';
      card.appendChild(top);
      card.appendChild(el('div', 'c-blurb', u.description || ''));
      var footer = el('div', 'c-row');
      if (owned) {
        footer.appendChild(el('span', 'pill good', '✓ どうにゅう済み'));
        card.appendChild(footer);
      } else if (!rankOk) {
        footer.appendChild(el('span', 'pill', '★' + u.unlockRank + 'で かいほう'));
        card.appendChild(footer);
      } else if (!reqOk) {
        footer.appendChild(el('span', 'pill', '要: ' + (reqMissing ? reqMissing.name : '前提')));
        card.appendChild(footer);
      } else {
        footer.appendChild(el('span', 'price', U.formatNum(u.cost || 0)));
        card.appendChild(footer);
        var b = el('button', 'btn pri sm wide', '⬆️ どうにゅう');
        var afford = E && E.canAfford ? E.canAfford(u.cost || 0) : true;
        if (!afford) { b.setAttribute('disabled', ''); }
        on(b, 'click', function () { if (E && E.buyUpgrade) { if (E.buyUpgrade(u.id)) { sfx('levelup'); queuePanelRefresh(); } else sfx('error'); } });
        card.appendChild(b);
      }
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }

  // =====================================================================
  //  PANEL: goals + achievements
  // =====================================================================
  function renderGoals(body, s) {
    var E = ECO();
    // rank banner
    if (E && E.rankInfo) {
      var ri = E.rankInfo();
      var banner = el('div', 'insp-hero');
      banner.style.background = 'linear-gradient(180deg, #fff2c9, var(--panel-2))';
      var ic = el('div', 'hero-port');
      ic.style.display = 'flex'; ic.style.alignItems = 'center'; ic.style.justifyContent = 'center'; ic.style.fontSize = '44px';
      ic.textContent = '🏆';
      banner.appendChild(ic);
      var meta = el('div', 'hero-meta');
      meta.appendChild(el('div', 'hero-name', '★' + ri.rank + ' ' + (ri.title || '')));
      meta.appendChild(el('div', 'hero-sub', ri.max ? 'さいこうランク たっせい！すごい！' : ('つぎのランクまで ' + gramt(Math.max(0, (ri.next || 0) - ri.net)))));
      if (!ri.max) {
        var track = el('div', 'g-track'); track.style.marginTop = '8px';
        var fill = el('div', 'g-fill'); fill.style.width = Math.round((ri.progress || 0) * 100) + '%';
        track.appendChild(fill); meta.appendChild(track);
      }
      banner.appendChild(meta);
      body.appendChild(banner);
    }

    body.appendChild(el('div', 'section-title', '🎯 もくひょう'));
    var goals = (E && E.goalBoard) ? E.goalBoard() : [];
    goals.forEach(function (g) {
      var pct = g.target ? U.clamp((g.progress / g.target) * 100, 0, 100) : (g.done ? 100 : 0);
      var wrap = el('div', 'goal' + (g.done ? ' done' : ''));
      var top = el('div', 'g-top');
      top.appendChild(el('span', 'g-ic', g.done ? '✅' : (g.icon || '🎯')));
      top.appendChild(el('span', '', g.label));
      top.appendChild(el('span', 'g-num', fmtProg(g.progress, g.target)));
      wrap.appendChild(top);
      var track = el('div', 'g-track'); var fill = el('div', 'g-fill'); fill.style.width = pct + '%';
      track.appendChild(fill); wrap.appendChild(track);
      body.appendChild(wrap);
    });

    // achievements
    body.appendChild(el('div', 'section-title', '🏅 じっせき'));
    var grid = el('div', 'ach-grid');
    (D.achievementsList || []).forEach(function (ac) {
      var got = s.achievements && s.achievements[ac.id] != null;
      var cell = el('div', 'ach ' + (got ? 'got' : 'locked'));
      cell.appendChild(el('div', 'a-badge', got ? (ac.emoji || '🏅') : '🔒'));
      var txt = el('div', 'a-txt');
      txt.appendChild(el('div', 't1', got ? ac.name : '？？？'));
      txt.appendChild(el('div', 't2', got ? (ac.description || '') : (ac.description || 'かくれた じっせき')));
      cell.appendChild(txt);
      grid.appendChild(cell);
    });
    body.appendChild(grid);
  }
  function fmtProg(p, t) {
    if (!t) return '';
    if (t >= 1000) return U.formatNum(Math.min(p, t)) + ' / ' + U.formatNum(t);
    return Math.min(Math.floor(p), t) + ' / ' + t;
  }

  // =====================================================================
  //  PANEL: market
  // =====================================================================
  function renderMarket(body, s) {
    var E = ECO();
    var inv = s.inventory || {};
    var sellable = Object.keys(inv).filter(function (k) { return inv[k] > 0 && D.products[k]; });
    // also list crop items that have sell value
    Object.keys(inv).forEach(function (k) { if (inv[k] > 0 && !D.products[k] && D.crops[k] && (D.crops[k].sellValue || 0) > 0 && sellable.indexOf(k) < 0) sellable.push(k); });

    var bulk = false;
    if (E) {
      try { bulk = (E.hasFlag && E.hasFlag('bulkSell')) || (E.hasUpgrade && (E.hasUpgrade('delivery_truck') || E.hasUpgrade('market_contract'))); } catch (e) { bulk = false; }
    }
    if (bulk && sellable.length) {
      var allBtn = el('button', 'btn pri wide', '💰 ぜんぶ まとめて うる');
      on(allBtn, 'click', function () {
        var total = 0, any = false;
        sellable.slice().forEach(function (id) { var q = inv[id] || 0; if (q > 0 && E.sell) { var r = E.sell(id, q); if (r && r.ok) { total += r.total; any = true; } } });
        if (any) { sfx('coin'); notify({ text: '💰 ' + gramt(total) + ' の うりあげ！', icon: '🪙', kind: 'good' }); }
        queuePanelRefresh();
      });
      body.appendChild(allBtn);
      body.appendChild(el('div', '', '')).style.height = '10px';
    }

    if (!sellable.length) {
      body.appendChild(emptyNote('🧺', 'うれる ものが まだ ないよ。\nミルクを しぼったり さくもつを そだてよう！'));
      return;
    }

    sellable.forEach(function (id) {
      var qty = inv[id] || 0;
      var price = E && E.price ? E.price(id) : (D.basePrice ? D.basePrice(id) : 1);
      var prod = D.products[id] || D.crops[id] || {};
      var row = el('div', 'mkt-row');
      row.appendChild(el('span', 'm-ic', prod.emoji || '📦'));
      var main = el('div', 'm-main');
      main.appendChild(el('div', 'm-name', (prod.name || id) + ' ×' + qty));
      var trend = trendInfo(s, id, price);
      main.appendChild(el('div', 'm-sub', trend.txt));
      row.appendChild(main);
      row.appendChild(sparkline(s, id));
      var right = el('div', ''); right.style.display = 'flex'; right.style.flexDirection = 'column'; right.style.alignItems = 'flex-end'; right.style.gap = '4px';
      right.appendChild(el('div', 'm-price', gramt(price)));
      var sell = el('button', 'btn pri sm', 'うる');
      on(sell, 'click', function () {
        if (E && E.sell) { var r = E.sell(id, qty); if (r && r.ok) { sfx('coin'); queuePanelRefresh(); } }
      });
      right.appendChild(sell);
      row.appendChild(right);
      body.appendChild(row);
    });
  }

  function trendInfo(s, id, price) {
    var h = s.market.history && s.market.history[id];
    if (!h || h.length < 2) return { txt: 'きほん ' + gramt(D.basePrice(id)), dir: 0 };
    var prev = h[h.length - 2] || price;
    var diff = price - prev;
    if (diff > 0.5) return { txt: '📈 ' + gramt(D.basePrice(id)) + ' → じょうしょう', dir: 1 };
    if (diff < -0.5) return { txt: '📉 ' + gramt(D.basePrice(id)) + ' → げらく', dir: -1 };
    return { txt: 'きほん ' + gramt(D.basePrice(id)), dir: 0 };
  }

  function sparkline(s, id) {
    var days = (D.market && D.market.trendSparklineDays) || 7;
    var h = (s.market.history && s.market.history[id]) || [];
    h = h.slice(-days);
    var w = 62, ht = 26, pad = 3;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'spark'); svg.setAttribute('viewBox', '0 0 ' + w + ' ' + ht);
    if (h.length < 2) { return svg; }
    var min = Math.min.apply(null, h), max = Math.max.apply(null, h);
    var rng = (max - min) || 1;
    var pts = h.map(function (v, i) {
      var x = pad + (i / (h.length - 1)) * (w - pad * 2);
      var y = ht - pad - ((v - min) / rng) * (ht - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    pl.setAttribute('points', pts);
    var up = h[h.length - 1] >= h[0];
    pl.setAttribute('stroke', up ? 'var(--good)' : 'var(--alert)');
    svg.appendChild(pl);
    return svg;
  }

  // =====================================================================
  //  PANEL: almanac (encyclopedia)
  // =====================================================================
  function renderAlmanac(body, s, payload) {
    var tab = (payload && payload.tab) || 'animals';
    var tabbar = el('div', 'tabbar');
    [['animals', '🐄 どうぶつ'], ['crops', '🌱 さくもつ'], ['products', '🧺 せいひん'], ['buildings', '🏠 たてもの']].forEach(function (t) {
      var b = el('button', 'tab' + (tab === t[0] ? ' active' : ''), t[1]);
      on(b, 'click', function () { openPanel('almanac', { tab: t[0] }); });
      tabbar.appendChild(b);
    });
    body.appendChild(tabbar);

    var E = ECO();
    if (tab === 'animals') {
      var list = (D.cowBreedsList || []).concat(D.animalsList || []);
      var found = 0;
      var grid = el('div', 'card-grid');
      list.forEach(function (def) {
        var disc = (E && E.isUnlocked) ? E.isUnlocked('animals', def.id) : ((def.unlockRank || 1) <= (s.rank || 1));
        if (disc) found++;
        grid.appendChild(almanacCard(def, disc, 'animal'));
      });
      body.insertBefore(discBar(found, list.length), body.children[1] || null);
      body.appendChild(grid);
    } else if (tab === 'crops') {
      var grid2 = el('div', 'card-grid');
      (D.cropsList || []).forEach(function (def) { grid2.appendChild(almanacCard(def, true, 'crop')); });
      body.appendChild(grid2);
    } else if (tab === 'products') {
      var grid3 = el('div', 'card-grid');
      (D.productsList || []).forEach(function (def) {
        var made = producedItem(s, def.id);
        grid3.appendChild(almanacCard(def, made, 'product'));
      });
      body.appendChild(grid3);
    } else {
      var grid4 = el('div', 'card-grid');
      (D.buildingsList || []).forEach(function (def) {
        var disc = (E && E.isUnlocked) ? E.isUnlocked('buildings', def.id) : ((def.unlockRank || 1) <= (s.rank || 1));
        grid4.appendChild(almanacCard(def, disc, 'building'));
      });
      body.appendChild(grid4);
    }
  }
  function discBar(found, total) {
    var d = el('div', 'section-title', '📖 みっけた ' + found + ' / ' + total);
    return d;
  }
  function producedItem(s, id) {
    var st = s.stats || {};
    var map = { milk: st.totalMilk, quality_milk: st.totalMilk, cheese: st.totalCheese, egg: st.totalEggs, truffle: st.totalTruffle, wool: st.totalWool, fine_wool: st.totalWool };
    if (map[id] != null) return map[id] > 0;
    return (s.inventory && s.inventory[id] > 0) || false;
  }
  function almanacCard(def, discovered, kind) {
    var card = el('div', 'card' + (discovered ? '' : ' locked'));
    var top = el('div', 'card-top'); top.style.justifyContent = 'center';
    if (discovered && kind === 'animal') {
      card.appendChild(portrait(def.id, 60, 'happy'));
    } else {
      var em = el('span', 'c-emoji', discovered ? (def.emoji || '❓') : '❓'); em.style.fontSize = '34px';
      top.appendChild(em); card.appendChild(top);
    }
    card.appendChild(el('div', 'c-name', discovered ? ((kind === 'animal' ? '' : (def.emoji || '') + ' ') + def.name) : '？？？'));
    if (discovered) {
      var blurb = def.cutenessBlurb || def.description || def.function || '';
      if (blurb) card.appendChild(el('div', 'c-blurb', blurb));
      if (kind === 'product' && def.basePrice != null) { var r = el('div', 'c-row'); r.appendChild(el('span', 'pill', catJa(def.category))); r.appendChild(el('span', 'price', U.formatNum(def.basePrice))); card.appendChild(r); }
    } else {
      card.appendChild(el('div', 'c-blurb', 'まだ みつけていない…'));
    }
    return card;
  }
  function catJa(c) { return { dairy: 'にゅうせいひん', egg: 'たまご', fiber: 'せんい', luxury: 'こうきゅう', crop: 'さくもつ', feed: 'えさ', fertilizer: 'ひりょう', decor: 'かざり' }[c] || c || ''; }

  // =====================================================================
  //  PANEL: settings
  // =====================================================================
  function renderSettings(body, s) {
    var st = s.settings;

    // audio
    var g1 = el('div', 'set-group');
    g1.appendChild(elh('h4', '🔊 おと'));
    g1.appendChild(volRow('ぜんたい', 'master', st.master));
    g1.appendChild(volRow('こうか音', 'sfx', st.sfx));
    g1.appendChild(volRow('おんがく', 'music', st.music));
    var muteRow = el('div', 'set-row');
    muteRow.appendChild(el('span', 's-lb', 'ミュート'));
    muteRow.appendChild(toggleEl(st.muted, function (v) {
      st.muted = v; var a = AUD(); if (a && a.setMuted) a.setMuted(v); saveSettings();
    }));
    g1.appendChild(muteRow);
    body.appendChild(g1);

    // display
    var g2 = el('div', 'set-group');
    g2.appendChild(elh('h4', '✨ ひょうじ'));
    var rmRow = el('div', 'set-row');
    rmRow.appendChild(el('span', 's-lb', 'モーション軽減'));
    rmRow.appendChild(toggleEl(st.reduceMotion, function (v) { st.reduceMotion = v; applyReduceMotion(); saveSettings(); }));
    g2.appendChild(rmRow);
    var pRow = el('div', 'set-row');
    pRow.appendChild(el('span', 's-lb', 'パーティクル'));
    pRow.appendChild(toggleEl(st.showParticles, function (v) { st.showParticles = v; saveSettings(); }));
    g2.appendChild(pRow);
    var spdRow = el('div', 'set-row');
    spdRow.appendChild(el('span', 's-lb', 'スピード'));
    var seg = el('div', 'seg');
    (K.SPEEDS || [1, 2, 3]).forEach(function (sp) {
      var b = el('button', (st.speed === sp && !s.paused ? 'active' : ''), sp + '×');
      on(b, 'click', function () { if (Game.setSpeed) Game.setSpeed(sp); refreshHUD(); queuePanelRefresh(); });
      seg.appendChild(b);
    });
    spdRow.appendChild(seg);
    g2.appendChild(spdRow);
    body.appendChild(g2);

    // data
    var g3 = el('div', 'set-group');
    g3.appendChild(elh('h4', '💾 データ'));
    var row = el('div', 'btn-row');
    var saveBtn = el('button', 'btn mint', '💾 セーブ');
    on(saveBtn, 'click', function () { var sv = SAV(); if (sv && sv.save) { sv.save(0); notify({ text: 'セーブしたよ！', icon: '💾', kind: 'good' }); } });
    var expBtn = el('button', 'btn sky', '📤 エクスポート');
    on(expBtn, 'click', doExport);
    var impBtn = el('button', 'btn sky', '📥 インポート');
    on(impBtn, 'click', doImport);
    var resetBtn = el('button', 'btn danger', '🗑️ リセット');
    on(resetBtn, 'click', function () {
      confirm('ほんとうに はじめから やりなおしますか？\n（このデータは きえます）').then(function (yes) {
        if (yes && Game.resetGame) { Game.resetGame(); closePanel('settings'); notify({ text: 'あたらしい牧場を はじめたよ🌱', icon: '🌱', kind: 'good' }); }
      });
    });
    row.appendChild(saveBtn); row.appendChild(expBtn); row.appendChild(impBtn); row.appendChild(resetBtn);
    g3.appendChild(row);
    body.appendChild(g3);

    // credits
    var g4 = el('div', 'set-group');
    g4.appendChild(elh('h4', '💛 クレジット'));
    var cr = el('div', 'credits');
    cr.innerHTML = '「まきばのしずく」<br>ちいさな牧場の いちにちを あなたと。<br>🐄🌱🧀🥚🐑<br>のんびり あそんでね。';
    g4.appendChild(cr);
    body.appendChild(g4);
  }
  function elh(tag, txt) { var e = el(tag); e.textContent = txt; return e; }
  function volRow(label, key, val) {
    var row = el('div', 'set-row');
    row.appendChild(el('span', 's-lb', label));
    var range = el('input'); range.type = 'range'; range.min = '0'; range.max = '100';
    range.value = Math.round((val != null ? val : 0.8) * 100);
    on(range, 'input', function () {
      var s = S(); s.settings[key] = (+range.value) / 100;
      var a = AUD(); if (a && a.setVolumes) a.setVolumes({ master: s.settings.master, sfx: s.settings.sfx, music: s.settings.music });
    });
    on(range, 'change', saveSettings);
    row.appendChild(range);
    return row;
  }
  function toggleEl(val, cb) {
    var t = el('div', 'toggle' + (val ? ' on' : ''));
    t.appendChild(el('i'));
    on(t, 'click', function () { var nv = !t.classList.contains('on'); t.classList.toggle('on', nv); cb(nv); sfx('click'); });
    return t;
  }
  function saveSettings() { var sv = SAV(); if (sv && sv.saveSettings) { try { sv.saveSettings(); } catch (e) { } } }

  function doExport() {
    var sv = SAV(); if (!sv || !sv.exportString) { notify({ text: 'エクスポートできないみたい', kind: 'warn' }); return; }
    var str = '';
    try { str = sv.exportString(); } catch (e) { }
    var area = el('textarea', 'io-area'); area.value = str; area.readOnly = true;
    var body = el('div');
    body.appendChild(el('div', 'blurb', 'この もじれつを コピーして ほかんしてね📋'));
    body.appendChild(area);
    modal({ title: '📤 エクスポート', body: body, buttons: [{ label: 'コピー', value: 'copy', kind: 'mint' }, { label: 'とじる', value: 'ok', kind: 'ghost' }] }).then(function (v) {
      if (v === 'copy') { try { area.select(); document.execCommand('copy'); notify({ text: 'コピーしたよ！', icon: '📋', kind: 'good' }); } catch (e) { } }
    });
  }
  function doImport() {
    var area = el('textarea', 'io-area'); area.placeholder = 'ここに エクスポートした もじれつを はりつけてね';
    var body = el('div');
    body.appendChild(el('div', 'blurb', 'いまの データは うわがきされるよ。だいじょうぶ？'));
    body.appendChild(area);
    modal({ title: '📥 インポート', body: body, buttons: [{ label: 'よみこむ', value: 'go', kind: 'pri' }, { label: 'やめる', value: 'cancel', kind: 'ghost' }] }).then(function (v) {
      if (v !== 'go') return;
      var sv = SAV(); if (sv && sv.importString) {
        var ok = false; try { ok = sv.importString(area.value.trim()); } catch (e) { }
        if (ok) { bus.emit('state:replaced', { reason: 'import' }); refreshHUD(); closePanel('settings'); notify({ text: 'よみこんだよ！おかえり🐄', icon: '📥', kind: 'good' }); }
        else notify({ text: 'うまく よみこめなかった…', icon: '😢', kind: 'bad' });
      }
    });
  }

  // =====================================================================
  //  Toasts / notify
  // =====================================================================
  function notify(opts) {
    opts = opts || {};
    try {
      var kind = opts.kind || 'info';
      var t = el('div', 'toast ' + kind);
      if (opts.icon) t.appendChild(el('span', 't-ic', opts.icon));
      t.appendChild(el('span', 't-txt', opts.text || ''));
      toastLayer.appendChild(t);
      var rec = { el: t, die: (performance ? performance.now() : Date.now()) + (opts.ttl || 3200), out: false };
      toasts.push(t._rec = rec);
      requestAnimationFrame(function () { t.classList.add('show'); });
      // cap stack
      while (toasts.length > 4) { var old = toasts.shift(); removeToast(old); }
    } catch (e) { Game._recordError('UI.notify', e); }
  }
  function toast(text) { notify({ text: text }); }
  function removeToast(rec) {
    if (!rec || rec.out) return; rec.out = true;
    rec.el.classList.add('hide');
    setTimeout(function () { if (rec.el && rec.el.parentNode) rec.el.parentNode.removeChild(rec.el); }, 340);
  }
  function updateToasts(now) {
    now = now || (performance ? performance.now() : Date.now());
    for (var i = toasts.length - 1; i >= 0; i--) {
      var rec = toasts[i];
      if (!rec.out && now >= rec.die) { removeToast(rec); }
      if (rec.out && (!rec.el.parentNode)) { toasts.splice(i, 1); }
    }
  }

  // =====================================================================
  //  Tooltip
  // =====================================================================
  function tooltip(show, x, y, html) {
    if (!tooltipEl) return;
    if (!show) { tooltipEl.classList.remove('show'); return; }
    tooltipEl.innerHTML = html || '';
    tooltipEl.style.left = x + 'px';
    tooltipEl.style.top = y + 'px';
    tooltipEl.classList.add('show');
  }

  // =====================================================================
  //  Modal / confirm
  // =====================================================================
  var _modalResolve = null;
  function modal(opts) {
    return new Promise(function (resolve) {
      try {
        // close any existing modal first (resolve it null)
        if (_modalResolve) { var r = _modalResolve; _modalResolve = null; closeModalDom(); r(null); }
        opts = opts || {};
        var layer = el('div', 'ui-modal-layer');
        var card = el('div', 'ui-modal');
        var head = el('div', 'm-head');
        head.textContent = opts.title || '';
        card.appendChild(head);
        var mbody = el('div', 'm-body');
        if (opts.body instanceof Node) mbody.appendChild(opts.body);
        else mbody.innerHTML = opts.body || '';
        card.appendChild(mbody);
        var foot = el('div', 'm-foot');
        var buttons = opts.buttons || [{ label: 'OK', value: 'ok', kind: 'pri' }];
        buttons.forEach(function (bd) {
          var b = el('button', 'btn ' + (bd.kind || 'ghost'), bd.label);
          on(b, 'click', function () { resolveModal(bd.value); });
          foot.appendChild(b);
        });
        card.appendChild(foot);
        layer.appendChild(card);
        on(layer, 'click', function (e) { if (e.target === layer && opts.dismissable !== false) resolveModal(null); });
        modalLayer.appendChild(layer);
        modalLayer._current = layer;
        _modalResolve = resolve;
        requestAnimationFrame(function () { layer.classList.add('show'); });
        sfx('pop');
      } catch (e) { Game._recordError('UI.modal', e); resolve(null); }
    });
  }
  function resolveModal(value) {
    var r = _modalResolve; _modalResolve = null;
    closeModalDom();
    if (r) r(value);
  }
  function closeModal() { resolveModal(null); }
  function closeModalDom() {
    var layer = modalLayer && modalLayer._current;
    if (layer) {
      layer.classList.remove('show');
      modalLayer._current = null;
      setTimeout(function () { if (layer.parentNode) layer.parentNode.removeChild(layer); }, 260);
    }
  }
  function confirm(msg) {
    return modal({
      title: '',
      body: '<span class="big-emoji">🐄</span>' + escapeHtml(msg).replace(/\n/g, '<br>'),
      buttons: [{ label: 'いいえ', value: false, kind: 'ghost' }, { label: 'はい', value: true, kind: 'pri' }]
    }).then(function (v) { return v === true; });
  }
  function promptText(title, initial, cb) {
    var input = el('input', 'm-input'); input.type = 'text'; input.value = initial || ''; input.maxLength = 12;
    var body = el('div'); body.appendChild(input);
    modal({ title: title, body: body, buttons: [{ label: 'やめる', value: null, kind: 'ghost' }, { label: 'けってい', value: 'ok', kind: 'pri' }] }).then(function (v) {
      if (v === 'ok') cb(input.value);
    });
    setTimeout(function () { try { input.focus(); input.select(); } catch (e) { } }, 60);
  }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // =====================================================================
  //  Event modal (bus event:trigger)
  // =====================================================================
  function showEventModal(payload) {
    try {
      var ev = payload && payload.event; if (!ev) return;
      var choices = payload.choices || ev.choices || [];
      var E = ECO();
      var bodyHtml = '<span class="big-emoji">' + (ev.emoji || '✨') + '</span>' + escapeHtml(ev.description || '');
      var buttons;
      if (choices.length) {
        buttons = choices.map(function (c, i) {
          var label = c.label || ('えらぶ ' + (i + 1));
          if (c.cost) label += '（' + gramt(c.cost) + '）';
          return { label: label, value: i, kind: i === 0 ? 'pri' : 'ghost' };
        });
      } else {
        buttons = [{ label: 'なるほど！', value: 'ok', kind: 'pri' }];
      }
      modal({ title: (ev.emoji || '✨') + ' ' + (ev.name || 'できごと'), body: bodyHtml, buttons: buttons, dismissable: !choices.length }).then(function (v) {
        if (choices.length && typeof v === 'number') {
          if (E && E.resolveEvent) { E.resolveEvent(ev.id, v); }
          sfx('pop');
        }
      });
    } catch (e) { Game._recordError('UI.showEventModal', e); }
  }

  // =====================================================================
  //  Title screen
  // =====================================================================
  function showTitle() {
    if (!overlayEl || titleShown) return;
    titleShown = true;
    var scr = el('div', 'title-screen');
    // drifting clouds
    for (var i = 0; i < 3; i++) { var cl = el('div', 'title-cloud', '☁️'); cl.style.top = (12 + i * 22) + '%'; cl.style.animationDelay = (-i * 8) + 's'; scr.appendChild(cl); }
    scr.appendChild(el('div', 't-drop', '💧'));
    scr.appendChild(elh('h1', 'まきばのしずく'));
    scr.appendChild(el('div', 't-sub', '🐄 ちいさな牧場の のんびり けいえい 🌱'));
    var menu = el('div', 't-menu');

    var sv = SAV();
    var hasSave = sv && sv.hasSave && sv.hasSave(0);
    if (hasSave) {
      var cont = el('button', 'btn mint', '▶️ つづきから');
      on(cont, 'click', function () { if (Game.continueGame) Game.continueGame(); hideTitle(); });
      menu.appendChild(cont);
    }
    var neu = el('button', 'btn pri', (hasSave ? '🌱 はじめから' : '🌱 はじめる'));
    on(neu, 'click', function () {
      if (hasSave) {
        confirm('あたらしく はじめると いまのデータは きえるよ。いい？').then(function (yes) {
          if (yes) { if (Game.newGame) Game.newGame(); hideTitle(); }
        });
      } else { if (!Game.state) { } hideTitle(); }
    });
    menu.appendChild(neu);
    var setBtn = el('button', 'btn sky', '⚙️ せってい');
    on(setBtn, 'click', function () { hideTitle(); openPanel('settings'); });
    menu.appendChild(setBtn);
    scr.appendChild(menu);
    scr.appendChild(el('div', 't-foot', 'タップして あそぼう 💛'));
    overlayEl.appendChild(scr);
    overlayEl._title = scr;
    if (Game.pause) Game.pause();
  }
  function hideTitle() {
    var scr = overlayEl && overlayEl._title; if (!scr) return;
    scr.classList.add('hide');
    setTimeout(function () { if (scr.parentNode) scr.parentNode.removeChild(scr); }, 520);
    overlayEl._title = null;
    if (Game.resume) Game.resume();
    sfx('pop');
  }

  // =====================================================================
  //  Shared small builders
  // =====================================================================
  function emptyNote(emoji, text, btnLabel, btnCb) {
    var d = el('div', 'empty-note');
    d.appendChild(el('span', 'big', emoji));
    var lines = String(text).split('\n');
    lines.forEach(function (ln, i) { if (i) d.appendChild(el('br')); d.appendChild(document.createTextNode(ln)); });
    if (btnLabel && btnCb) {
      var wrap = el('div'); wrap.style.marginTop = '14px';
      var b = el('button', 'btn pri', btnLabel);
      on(b, 'click', btnCb);
      wrap.appendChild(b); d.appendChild(wrap);
    }
    return d;
  }

  function applyReduceMotion() {
    var s = S(); if (!appEl) return;
    appEl.classList.toggle('reduce-motion', !!(s && s.settings && s.settings.reduceMotion));
  }

  function openInspector(kind, id) { openPanel('inspector', { kind: kind, id: id }); }

  // =====================================================================
  //  init
  // =====================================================================
  function init(ctx) {
    try {
      appEl = (ctx && ctx.root) || document.getElementById('app');
      hudEl = (ctx && ctx.hud) || document.getElementById('hud');
      dockEl = (ctx && ctx.dock) || document.getElementById('dock');
      panelsEl = (ctx && ctx.panels) || document.getElementById('panels');
      toastLayer = (ctx && ctx.toast) || document.getElementById('toast');
      overlayEl = (ctx && ctx.overlay) || document.getElementById('overlay');
      if (!hudEl || !dockEl || !panelsEl) return; // headless / no DOM

      // banner + tooltip live inside app; modalLayer is a persistent host that
      // each modal appends its own .ui-modal-layer into (those re-enable pointer events)
      bannerEl = el('div', 'ui-banner'); appEl.appendChild(bannerEl);
      tooltipEl = el('div', 'ui-tooltip'); appEl.appendChild(tooltipEl);
      modalLayer = el('div', 'ui-modal-host');
      modalLayer.style.position = 'absolute'; modalLayer.style.inset = '0';
      modalLayer.style.zIndex = '80'; modalLayer.style.pointerEvents = 'none';
      appEl.appendChild(modalLayer);

      buildHud();
      buildDock();

      // built-in panels
      registerPanel({ id: 'shop', title: 'ショップ', icon: '🛒', render: renderShop });
      registerPanel({ id: 'barn', title: 'どうぶつ', icon: '🐄', render: renderBarn });
      registerPanel({ id: 'inspector', title: 'くわしく', icon: '🔍', render: renderInspector });
      registerPanel({ id: 'upgrades', title: 'アップグレード', icon: '⬆️', render: renderUpgrades });
      registerPanel({ id: 'goals', title: 'もくひょう', icon: '🎯', render: renderGoals });
      registerPanel({ id: 'market', title: 'マーケット', icon: '📈', render: renderMarket });
      registerPanel({ id: 'almanac', title: 'ずかん', icon: '📖', render: renderAlmanac });
      registerPanel({ id: 'settings', title: 'せってい', icon: '⚙️', render: renderSettings });

      applyReduceMotion();
      refreshHUD();

      // ---- bus wiring ----
      bus.on('notify', function (p) { notify(p || {}); });
      bus.on('event:trigger', function (p) { showEventModal(p); });
      bus.on('entity:select', function (p) { if (p && (p.kind === 'animal' || p.kind === 'building')) openInspector(p.kind, p.id); });
      bus.on('levelup', function (p) {
        var E = ECO(); var title = (E && E.rankInfo) ? E.rankInfo().title : '';
        notify({ text: '🎉 ランクアップ！ ★' + (p ? p.rank : '') + ' ' + title, icon: '🏆', kind: 'good', ttl: 4200 });
        refreshHUD();
      });
      bus.on('achievement:unlock', function (p) {
        var ac = p && D.achievements[p.achId];
        if (ac) notify({ text: '🏅 じっせき「' + ac.name + '」' + (ac.rewardG ? ' +' + gramt(ac.rewardG) : ''), icon: ac.emoji || '🏅', kind: 'good', ttl: 4200 });
      });
      bus.on('tool:change', function (p) { if (!p || !p.tool || p.tool === 'inspect' || p.tool === 'none') setPlacementBanner(null); });
      bus.on('state:replaced', function () { closePanel(openId); refreshHUD(); });
      bus.on('season:change', function (p) {
        var nm = K.SEASON_NAMES[p && p.season] || '';
        notify({ text: (({ spring: '🌸', summer: '🌻', autumn: '🍁', winter: '❄️' })[p && p.season] || '🌱') + ' ' + nm + 'が やってきた！', icon: '📅', kind: 'info', ttl: 3600 });
      });

      // live-panel refresh triggers (debounced)
      ['money:change', 'inventory:change', 'sale', 'purchase', 'day:advance', 'animal:produce', 'animal:spawn', 'animal:born', 'build', 'build:remove', 'goal:complete', 'market:update'].forEach(function (evn) {
        bus.on(evn, queuePanelRefresh);
      });

      // title screen on first load
      showTitle();

    } catch (e) { Game._recordError('UI.init', e); }
  }

  // =====================================================================
  //  Public API
  // =====================================================================
  return {
    init: init,
    tick: tick,
    registerPanel: registerPanel,
    openPanel: openPanel,
    closePanel: closePanel,
    togglePanel: togglePanel,
    notify: notify,
    toast: toast,
    tooltip: tooltip,
    modal: modal,
    confirm: confirm,
    openInspector: openInspector,
    refreshHUD: refreshHUD,
    setPlacementBanner: setPlacementBanner
  };
})();
