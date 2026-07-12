/*
 * tutorial.js — Game.Tutorial: gentle, skippable onboarding.
 * Narrated by the dewdrop fairy シズク (and sometimes ハナおばあちゃん).
 *
 * Design notes (per IMPLEMENTER_BRIEF §0):
 *  - No top-level side effects. All DOM/bus/state work happens in init()/later.
 *  - Reads the LIVE Game.state every time; never caches the state object.
 *  - Other sim modules (Economy/World/Animals/Render/UI) are referenced ONLY
 *    inside functions and always null-guarded — they may not exist at eval time.
 *  - The coach-mark speech bubble is fully self-contained DOM (so it works even
 *    if UI isn't ready) and NEVER hard-blocks the world: it sits at the bottom,
 *    is pointer-transparent except for its own buttons, and a スキップ button
 *    ends onboarding at any moment.
 *  - Heavy sim lives elsewhere; the tutorial only listens to bus events + a light
 *    throttled poll to detect when the player has completed each gentle step.
 */
Game.Tutorial = (function () {
  'use strict';

  var U = Game.Util;
  var bus = Game.bus;
  var D = Game.DATA;

  // ---- module-local runtime (NOT the state object; safe to cache) ----
  var _ctx = null;
  var _wired = false;
  var _running = false;      // bubble currently on screen for a step
  var _els = null;           // { root, card, avatar, name, text, hintRow, btnRow, primary, skip, hint, forward }
  var _idx = 0;              // mirror of state.tutorial.step
  var _flags = { fed: false, sold: false };
  var _baselinePets = 0;
  var _baselineCrops = 0;
  var _giftGiven = false;
  var _autoTimer = 0;
  var _pollAccum = 0;

  // Small onboarding thank-you gift. Narrative reward, not a balance rate.
  var GIFT_G = 150;

  // Feed item ids (from balance) — used to detect "the player fed an animal".
  var FEED_IDS = (function () {
    try {
      var f = D && D.feed && D.feed.feedItems;
      if (f) return Object.keys(f);
    } catch (e) { /* ignore */ }
    return ['grass', 'hay', 'corn', 'wheat', 'alfalfa', 'carrot', 'clover', 'turnip'];
  })();
  function isFeedItem(id) { return FEED_IDS.indexOf(id) >= 0; }

  // ---------- tiny safe accessors (live state, null-guarded modules) ----------
  function S() { return Game.state; }
  function eco() { return Game.Economy || null; }
  function world() { return Game.World || null; }
  function render() { return Game.Render || null; }
  function ui() { return Game.UI || null; }

  function itemCount(id) {
    var E = eco();
    if (E && E.itemCount) { try { return E.itemCount(id) || 0; } catch (e) { /* fall through */ } }
    var s = S();
    return (s && s.inventory && s.inventory[id]) || 0;
  }
  function firstCow() {
    var s = S(); if (!s || !s.animals) return null;
    for (var i = 0; i < s.animals.length; i++) {
      var a = s.animals[i];
      if (a && (a.species === 'cow' || (D.isCow && D.isCow(a.breed)))) return a;
    }
    return s.animals[0] || null;
  }
  function hasCoop() {
    var s = S(); if (!s || !s.buildings) return false;
    for (var i = 0; i < s.buildings.length; i++) { if (s.buildings[i].type === 'coop') return true; }
    return false;
  }
  function hasChicken() {
    var s = S(); if (!s || !s.animals) return false;
    for (var i = 0; i < s.animals.length; i++) {
      var a = s.animals[i];
      if (a && (a.species === 'chicken' || a.breed === 'chicken')) return true;
    }
    return false;
  }

  function notify(text, kind, icon) {
    try { bus.emit('notify', { text: text, icon: icon || '💧', kind: kind || 'info', ttl: 3200 }); }
    catch (e) { /* non-fatal */ }
  }
  function openPanel(id) {
    var UI = ui();
    if (UI && UI.openPanel) { try { UI.openPanel(id); } catch (e) { /* ignore */ } }
    else { try { bus.emit('ui:panel:open', { panel: id }); } catch (e2) { /* ignore */ } }
  }
  function reduceMotion() {
    var s = S();
    return !!(s && s.settings && s.settings.reduceMotion);
  }

  // ---------- step definitions ----------
  // Each step: { id, who:'shizuku'|'hana', text, hint, manual?, isFinish?,
  //              gate?(s)->bool, onEnter?(step) }
  var STEPS = [
    {
      id: 'welcome', who: 'shizuku', manual: true,
      text: 'ようこそ、まきばへ！わたしは しずくの妖精 シズク。いっしょに せかいで いちばん すてきな牧場を つくろうね！',
      hint: ''
    },
    {
      id: 'pet', who: 'shizuku',
      text: 'まずは 牛の モモ に ごあいさつ。モモを タップして やさしく なでてあげて♪',
      hint: '🐮 モモを なでてみよう',
      onEnter: function () {
        var cow = firstCow();
        var R = render();
        if (cow && R && R.centerOn) { try { R.centerOn(cow.tx, cow.ty); } catch (e) { /* ignore */ } }
        if (cow) {
          try {
            var s = S(), TILE = (D.const && D.const.TILE) || 48;
            bus.emit('fx:sparkle', { x: (cow.x != null ? cow.x : (cow.tx + 0.5) * TILE), y: (cow.y != null ? cow.y : (cow.ty + 0.5) * TILE) - TILE * 0.6 });
          } catch (e2) { /* ignore */ }
        }
      },
      gate: function (s) { return (s.stats && (s.stats.totalPets || 0) > _baselinePets); }
    },
    {
      id: 'feed', who: 'shizuku',
      text: 'モモの おなかが すいてるみたい。ほし草（ごはん）を えらんで あげてみよう🌾',
      hint: '🌾 モモに ごはんを あげよう',
      onEnter: function () { _flags.fed = false; },
      gate: function () { return _flags.fed; }
    },
    {
      id: 'milk', who: 'hana',
      text: 'あさに なると おいしい ミルクが とれるんじゃよ。すこし時間を すすめて、ミルクを あつめておくれ🥛',
      hint: '🥛 ミルクが 1こ たまるまで まってね',
      gate: function () { return itemCount('milk') + itemCount('quality_milk') >= 1; }
    },
    {
      id: 'sell', who: 'shizuku',
      text: 'とれた ミルクは マーケットで うれるよ！マーケットを ひらいて、ミルクを うってみよう💰',
      hint: '💰 マーケットで ミルクを うろう',
      onEnter: function () { _flags.sold = false; openPanel('market'); },
      gate: function () { return _flags.sold; }
    },
    {
      id: 'coop', who: 'shizuku',
      text: 'つぎは なかまを ふやそう！鶏小屋（とりごや）を たてて、ニワトリを むかえてね🐔',
      hint: '🐔 鶏小屋 と ニワトリを むかえよう',
      onEnter: function () { openPanel('shop'); },
      gate: function () { return hasCoop() || hasChicken(); }
    },
    {
      id: 'plant', who: 'hana',
      text: '牧草の タネを まいておくと、まいにちの ごはんに なるよ。あいてる 土に タネを まいてごらん🌱',
      hint: '🌱 牧草の タネを まこう',
      onEnter: function () { var s = S(); _baselineCrops = (s && s.crops) ? s.crops.length : 0; },
      gate: function (s) { return (s.crops && s.crops.length > _baselineCrops); }
    },
    {
      id: 'finish', who: 'shizuku', manual: true, isFinish: true,
      text: 'りっぱな牧場主に なってきたね！これは おいわいの プレゼント♪ これからも のんびり、たのしんでね。こまったら いつでも よんでね💧',
      hint: ''
    }
  ];

  function stepAt(i) { return (i >= 0 && i < STEPS.length) ? STEPS[i] : null; }

  // ---------- DOM (self-contained coach-mark) ----------
  var STYLE_ID = 'tutorial-coach-style';
  function injectStyle() {
    try {
      if (document.getElementById(STYLE_ID)) return;
      var css = ''
        + '.tut-root{position:absolute;left:0;right:0;bottom:0;z-index:60;display:flex;justify-content:center;'
        + 'pointer-events:none;padding:0 12px 16px;font-family:inherit;}'
        + '.tut-card{pointer-events:auto;position:relative;max-width:520px;width:100%;'
        + 'background:#FFFBF0;border:3px solid #E7C596;border-radius:20px;'
        + 'box-shadow:0 10px 24px rgba(107,74,47,.22),0 2px 0 #E7C596;'
        + 'padding:14px 16px 12px 78px;color:#6B4A2F;transform-origin:50% 100%;}'
        + '.tut-pop{animation:tutPop .38s cubic-bezier(.34,1.56,.64,1);}'
        + '@keyframes tutPop{0%{transform:translateY(18px) scale(.9);opacity:0}100%{transform:translateY(0) scale(1);opacity:1}}'
        + '.tut-avatar{position:absolute;left:-6px;bottom:6px;width:66px;height:66px;border-radius:50%;'
        + 'background:radial-gradient(circle at 38% 32%,#EAF7FF 0%,#B9E4F5 62%,#8FD6F2 100%);'
        + 'border:3px solid #FFF6E3;box-shadow:0 4px 10px rgba(107,74,47,.22);'
        + 'display:flex;align-items:center;justify-content:center;font-size:34px;line-height:1;}'
        + '.tut-avatar.hana{background:radial-gradient(circle at 38% 32%,#FFF3E0 0%,#FFD9B0 62%,#FFC38F 100%);}'
        + '.tut-bob{animation:tutBob 2.4s ease-in-out infinite;}'
        + '@keyframes tutBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}'
        + '.tut-name{font-weight:800;font-size:13px;letter-spacing:.02em;color:#4FC79C;margin:0 0 2px;}'
        + '.tut-name.hana{color:#E27A5F;}'
        + '.tut-text{font-size:15px;line-height:1.5;margin:0 0 6px;font-weight:600;}'
        + '.tut-hint{display:inline-block;font-size:12.5px;font-weight:800;color:#6B4A2F;'
        + 'background:#FFF6D6;border:2px solid #FFD84D;border-radius:999px;padding:3px 12px;margin:2px 0 8px;'
        + 'animation:tutGlow 1.6s ease-in-out infinite;}'
        + '@keyframes tutGlow{0%,100%{box-shadow:0 0 0 0 rgba(255,216,77,.0)}50%{box-shadow:0 0 0 5px rgba(255,216,77,.28)}}'
        + '.tut-btns{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}'
        + '.tut-btn{pointer-events:auto;cursor:pointer;border:none;border-radius:999px;font-weight:800;'
        + 'font-family:inherit;font-size:14px;padding:9px 20px;color:#fff;background:#4FC79C;'
        + 'box-shadow:0 3px 0 #3AA983;transition:transform .08s ease;}'
        + '.tut-btn:hover{transform:translateY(-1px);}'
        + '.tut-btn:active{transform:translateY(2px);box-shadow:0 1px 0 #3AA983;}'
        + '.tut-link{pointer-events:auto;cursor:pointer;background:none;border:none;font-family:inherit;'
        + 'font-size:12.5px;font-weight:700;color:#B79A7C;text-decoration:underline;padding:6px 4px;}'
        + '.tut-link:hover{color:#6B4A2F;}'
        + '.tut-skip{position:absolute;top:8px;right:12px;}'
        + '.tut-dots{display:flex;gap:5px;margin-left:auto;}'
        + '.tut-dot{width:7px;height:7px;border-radius:50%;background:#EBD9BE;}'
        + '.tut-dot.on{background:#4FC79C;}'
        + '.tut-reduced .tut-pop,.tut-reduced .tut-bob,.tut-reduced .tut-hint,.tut-reduced .tut-avatar{animation:none!important;}';
      var st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
    } catch (e) { if (Game._recordError) Game._recordError('Tutorial.injectStyle', e); }
  }

  function buildDom() {
    if (_els) return _els;
    injectStyle();
    var root = document.createElement('div');
    root.className = 'tut-root';
    root.setAttribute('aria-live', 'polite');

    var card = document.createElement('div');
    card.className = 'tut-card';

    var avatar = document.createElement('div');
    avatar.className = 'tut-avatar tut-bob';
    avatar.textContent = '💧';

    var skip = document.createElement('button');
    skip.className = 'tut-link tut-skip';
    skip.type = 'button';
    skip.textContent = 'スキップ ✕';
    skip.addEventListener('click', function () { skipAll(); });

    var name = document.createElement('div');
    name.className = 'tut-name';
    name.textContent = 'シズク';

    var text = document.createElement('p');
    text.className = 'tut-text';

    var hint = document.createElement('span');
    hint.className = 'tut-hint';
    hint.style.display = 'none';

    var btnRow = document.createElement('div');
    btnRow.className = 'tut-btns';

    var primary = document.createElement('button');
    primary.className = 'tut-btn';
    primary.type = 'button';
    primary.textContent = 'つぎへ ▶';
    primary.addEventListener('click', function () { onPrimary(); });

    var forward = document.createElement('button');
    forward.className = 'tut-link';
    forward.type = 'button';
    forward.textContent = 'とばす ▶';
    forward.addEventListener('click', function () { next(); });

    var dots = document.createElement('div');
    dots.className = 'tut-dots';

    btnRow.appendChild(primary);
    btnRow.appendChild(forward);
    btnRow.appendChild(dots);

    card.appendChild(avatar);
    card.appendChild(skip);
    card.appendChild(name);
    card.appendChild(text);
    card.appendChild(hint);
    card.appendChild(btnRow);
    root.appendChild(card);

    var host = (_ctx && _ctx.overlay) || (_ctx && _ctx.root) || document.body;
    try { host.appendChild(root); } catch (e) { try { document.body.appendChild(root); } catch (e2) { /* ignore */ } }

    _els = { root: root, card: card, avatar: avatar, name: name, text: text, hint: hint, btnRow: btnRow, primary: primary, forward: forward, dots: dots };
    return _els;
  }

  function renderDots(activeIdx) {
    if (!_els) return;
    var host = _els.dots;
    while (host.firstChild) host.removeChild(host.firstChild);
    for (var i = 0; i < STEPS.length; i++) {
      var d = document.createElement('span');
      d.className = 'tut-dot' + (i <= activeIdx ? ' on' : '');
      host.appendChild(d);
    }
  }

  function showBubble(step) {
    var els = buildDom();
    var who = step.who === 'hana' ? 'hana' : 'shizuku';
    els.avatar.textContent = who === 'hana' ? '👵' : '💧';
    els.avatar.className = 'tut-avatar tut-bob' + (who === 'hana' ? ' hana' : '');
    els.name.className = 'tut-name' + (who === 'hana' ? ' hana' : '');
    els.name.textContent = who === 'hana' ? 'ハナおばあちゃん' : 'シズク';
    els.text.textContent = step.text || '';

    if (step.hint) { els.hint.textContent = step.hint; els.hint.style.display = 'inline-block'; }
    else { els.hint.style.display = 'none'; }

    // buttons: manual steps show a primary; gated steps wait (offer a gentle とばす)
    if (step.isFinish) {
      els.primary.textContent = '牧場を はじめる ✿';
      els.primary.style.display = '';
      els.forward.style.display = 'none';
    } else if (step.manual) {
      els.primary.textContent = 'はじめる ▶';
      els.primary.style.display = '';
      els.forward.style.display = 'none';
    } else {
      els.primary.style.display = 'none';
      els.forward.style.display = '';
    }

    renderDots(_idx);

    els.root.style.display = 'flex';
    els.card.classList.remove('tut-pop');
    els.root.classList.toggle('tut-reduced', reduceMotion());
    if (!reduceMotion()) { void els.card.offsetWidth; els.card.classList.add('tut-pop'); }
  }

  function hideBubble() {
    if (_els && _els.root) _els.root.style.display = 'none';
    if (_autoTimer) { try { clearTimeout(_autoTimer); } catch (e) { } _autoTimer = 0; }
  }

  // ---------- flow ----------
  function enterStep(i) {
    var s = S();
    if (!s || !s.tutorial) return;
    _idx = U.clamp ? U.clamp(i, 0, STEPS.length - 1) : Math.max(0, Math.min(i, STEPS.length - 1));
    s.tutorial.step = _idx;
    var step = stepAt(_idx);
    if (!step) { complete(); return; }

    // record baselines used by gates
    if (step.id === 'pet') _baselinePets = (s.stats && s.stats.totalPets) || 0;

    try { if (step.onEnter) step.onEnter(step); }
    catch (e) { if (Game._recordError) Game._recordError('Tutorial.onEnter:' + step.id, e); }

    if (step.isFinish) { grantGift(); }

    _running = true;
    showBubble(step);

    try { bus.emit('tutorial:step', { step: _idx, id: step.id }); }
    catch (e2) { /* ignore */ }

    if (s.tutorial.seen) s.tutorial.seen[step.id] = true;

    // If a gated step is already satisfied (e.g. resuming a save), auto-advance gently.
    if (!step.manual && typeof step.gate === 'function') {
      var ok = false;
      try { ok = !!step.gate(s); } catch (e3) { ok = false; }
      if (ok) {
        if (_autoTimer) { try { clearTimeout(_autoTimer); } catch (e4) { } }
        _autoTimer = setTimeout(function () { _autoTimer = 0; advance(); }, 650);
      }
    }
  }

  function advance() {
    if (_idx + 1 >= STEPS.length) { complete(); return; }
    enterStep(_idx + 1);
  }

  function onPrimary() {
    var step = stepAt(_idx);
    if (step && step.isFinish) { complete(); return; }
    advance();
  }

  function grantGift() {
    if (_giftGiven) return;
    _giftGiven = true;
    var E = eco();
    try { if (E && E.credit) E.credit(GIFT_G, 'tutorial_gift'); } catch (e) { /* ignore */ }
    notify('シズクからの おくりもの！ ' + (U.formatG ? U.formatG(GIFT_G) : GIFT_G + 'G') + ' を もらったよ♪', 'good', '🎁');
    try {
      var s = S(); if (s && s.flags) s.flags.tutorialGift = true;
    } catch (e2) { /* ignore */ }
  }

  function complete() {
    var s = S();
    if (s && s.tutorial) { s.tutorial.active = false; s.tutorial.step = STEPS.length - 1; }
    _running = false;
    hideBubble();
    try { bus.emit('tutorial:done', {}); } catch (e) { /* ignore */ }
  }

  function skipAll() {
    var s = S();
    if (s && s.tutorial) { s.tutorial.active = false; }
    _running = false;
    hideBubble();
    notify('チュートリアルを おわったよ。いつでも のんびり あそんでね💧', 'info', '💧');
    try { bus.emit('tutorial:done', { skipped: true }); } catch (e) { /* ignore */ }
  }

  // ---------- gate evaluation (driven by bus events + light poll) ----------
  function evaluate() {
    if (!_running) return;
    var s = S();
    if (!s || !s.tutorial || !s.tutorial.active) { hideBubble(); _running = false; return; }
    var step = stepAt(_idx);
    if (!step || step.manual || typeof step.gate !== 'function') return;
    var ok = false;
    try { ok = !!step.gate(s); } catch (e) { ok = false; }
    if (ok) advance();
  }

  // ---------- wiring ----------
  function wire() {
    if (_wired) return;
    _wired = true;

    bus.on('fx:heart', function () { evaluate(); });
    bus.on('animal:produce', function () { evaluate(); });
    bus.on('sale', function () { _flags.sold = true; evaluate(); });
    bus.on('build', function () { evaluate(); });
    bus.on('animal:spawn', function () { evaluate(); });
    bus.on('crop:plant', function () { evaluate(); });
    bus.on('day:advance', function () { evaluate(); });
    bus.on('inventory:change', function (p) {
      try { if (p && p.delta < 0 && isFeedItem(p.itemId)) _flags.fed = true; } catch (e) { /* ignore */ }
      evaluate();
    });

    // Light safety poll (covers anything a missed event wouldn't). Cheap: only
    // does real work a few times per second and only while a step is showing.
    bus.on('tick', function (p) {
      if (!_running) return;
      _pollAccum += (p && p.dt) ? p.dt : 1;
      if (_pollAccum >= 30) { _pollAccum = 0; evaluate(); }
    });

    // If the world is swapped (load / new game), drop our bubble; game.js will
    // call start() again for a fresh tutorial.
    bus.on('state:replaced', function () {
      _running = false; _giftGiven = false; hideBubble();
    });
  }

  // ---------- public API ----------
  function init(ctx) {
    try {
      _ctx = ctx || _ctx;
      wire();
    } catch (e) { if (Game._recordError) Game._recordError('Tutorial.init', e); }
  }

  function start() {
    try {
      var s = S();
      if (!s || !s.tutorial) return;
      if (!s.tutorial.active) return;      // finished/skipped previously
      wire();
      _giftGiven = !!(s.flags && s.flags.tutorialGift);
      var i = (s.tutorial.step | 0) || 0;
      if (i < 0) i = 0;
      if (i >= STEPS.length) { complete(); return; }
      enterStep(i);
    } catch (e) { if (Game._recordError) Game._recordError('Tutorial.start', e); }
  }

  function skip() { try { skipAll(); } catch (e) { if (Game._recordError) Game._recordError('Tutorial.skip', e); } }

  function next() {
    try {
      var step = stepAt(_idx);
      if (step && step.isFinish) { complete(); return; }
      advance();
    } catch (e) { if (Game._recordError) Game._recordError('Tutorial.next', e); }
  }

  function current() {
    var s = S();
    if (!s || !s.tutorial || !s.tutorial.active) return null;
    if (!_running) return null;
    var step = stepAt(_idx);
    if (!step) return null;
    return { id: step.id, step: _idx, text: step.text, hint: step.hint || '', who: step.who || 'shizuku' };
  }

  function isActive() {
    var s = S();
    return !!(s && s.tutorial && s.tutorial.active && _running);
  }

  return {
    init: init,
    start: start,
    skip: skip,
    next: next,
    current: current,
    isActive: isActive
  };
})();
