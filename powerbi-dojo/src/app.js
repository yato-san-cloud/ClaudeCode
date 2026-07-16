/* ============================================================
 * Power BI 道場 v2 — app.js(シェル担当)
 * 状態管理・全画面・ゲーミフィケーション。
 * 前提: window.DojoEditor / window.DOJO_UNITS(UI_CONTRACT.md 準拠)
 * ============================================================ */
(function () {
  "use strict";

  /* ================= ヘルパー ================= */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  // q / e / hint 用: エスケープ後、属性なしの <code> <b> のみ復元
  function escQ(s) {
    return esc(s).replace(/&lt;(\/?)(code|b)&gt;/g, "<$1$2>");
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function dstr(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function sanitizeDate(s) {
    return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }
  function parseD(s) {
    var p = s.split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function dayDiff(a, b) { return Math.round((parseD(b) - parseD(a)) / 86400000); }
  function hashStr(s) {
    var h = 7;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function pick(pool) { return pool[Math.floor(Math.random() * pool.length)]; }

  /* ================= 定数 ================= */
  var STORE_KEY = "pbdojo_v2";
  var V1_KEY = "pbdojo_v1";
  var XP_BASE = { mc: 10, fill: 15, type: 20 };
  var BELTS = [
    ["白帯", 0], ["黄帯", 150], ["橙帯", 400], ["緑帯", 800], ["青帯", 1400],
    ["紫帯", 2200], ["茶帯", 3200], ["赤帯", 4500], ["黒帯", 6000], ["師範", 8000]
  ];

  var QUEST_POOL = [
    { id: "xp60",     text: "XPを60稼ぐ",             counter: "xp",       goal: 60, reward: 25 },
    { id: "lessons2", text: "レッスンを2つクリアする", counter: "lessons",  goal: 2,  reward: 30 },
    { id: "type3",    text: "type問題に3問正解する",   counter: "type",     goal: 3,  reward: 30, freeze: true },
    { id: "fill4",    text: "fill問題に4問正解する",   counter: "fill",     goal: 4,  reward: 25 },
    { id: "combo5",   text: "コンボ5を達成する",       counter: "combo",    goal: 5,  reward: 20, freeze: true },
    { id: "review1",  text: "弱点復習を1回完了する",   counter: "reviews",  goal: 1,  reward: 20 },
    { id: "perfect1", text: "全問正解クリアを1回",     counter: "perfects", goal: 1,  reward: 40 }
  ];

  var SHIBA = {
    correct: [
      "ナイスピッキング!完璧だワン!",
      "その調子だワン!荷崩れなしの美しい答えだ!",
      "検品合格!即日出荷級の速さだワン!",
      "伝票の読みが冴えてるな!",
      "うむ、良い積み付けだ。師範も見ているぞ。",
      "バース目掛けて一直線!気持ちいい正解だワン!"
    ],
    wrong: [
      "焦るな、再配達すればいい。",
      "誤出荷は誰にでもある。原因を確認するワン。",
      "ラベルをよく見るんだワン。次は当てられる。",
      "棚番違いだ。もう一度ピッキングし直そう!",
      "出荷前検品で気づけたからセーフだワン。"
    ],
    result: [
      "今日の便も無事納品完了だワン!",
      "積み重ねが強い倉庫を作るワン。",
      "よく働いた!バースを閉めるぞ。",
      "この調子なら繁忙期も怖くないワン!",
      "明日の便も頼んだぞ、相棒!"
    ],
    home: [
      "積載率が10%上がると便数は約1割減らせるぞ。",
      "在庫は「寝ている現金」。回転率を見るワン。",
      "誤出荷1件のリカバリコストは正常出荷の何倍にもなるワン。",
      "物量の波動は移動平均でならして見るのがコツだ。",
      "OTD98%は現場の誇り。データで守るワン!",
      "先入れ先出し!学びも毎日コツコツ出荷だワン。",
      "ピークの波を知る者が配車を制すのだ。",
      "庫内も学びも5S(整理・整頓)が基本だワン!",
      "今日も一便、確実に届けよう!"
    ]
  };

  var BADGES = [
    { id: "first",    icon: "🥋", name: "入門",         desc: "初めてレッスンをクリアする",       test: function (s) { return Object.keys(s.stars).some(function (k) { return s.stars[k] >= 1; }); } },
    { id: "streak7",  icon: "🔥", name: "皆勤の火",     desc: "7日連続で学習する",               test: function (s) { return s.bestStreak >= 7; } },
    { id: "streak30", icon: "🌙", name: "月間無欠便",   desc: "30日連続で学習する",              test: function (s) { return s.bestStreak >= 30; } },
    { id: "streak100",icon: "🏯", name: "百日行",       desc: "100日連続で学習する",             test: function (s) { return s.bestStreak >= 100; } },
    { id: "type50",   icon: "⌨️", name: "写経の達人",   desc: "type問題に50問正解する",          test: function (s) { return s.stats.type >= 50; } },
    { id: "fill50",   icon: "🧩", name: "組み立て名人", desc: "fill問題に50問正解する",          test: function (s) { return s.stats.fill >= 50; } },
    { id: "perfect10",icon: "💯", name: "無事故無違反", desc: "全問正解クリアを10回達成する",    test: function (s) { return s.stats.perfects >= 10; } },
    { id: "unit3star",icon: "🌟", name: "ユニット皆伝", desc: "1ユニットの全レッスンで★3を取る", test: unitAll3 },
    { id: "allclear", icon: "🗺️", name: "全線開通",     desc: "全ユニットの全レッスンをクリア",  test: allClear },
    { id: "shihan",   icon: "🎖️", name: "師範",         desc: "師範帯(8000XP)に到達する",        test: function (s) { return s.xp >= 8000; } },
    { id: "night",    icon: "🌃", name: "深夜の修行",   desc: "22時以降にセッションを完了する",  test: function (s) { return !!s.stats.night; } },
    { id: "early",    icon: "🌅", name: "朝練",         desc: "7時前にセッションを完了する",     test: function (s) { return !!s.stats.early; } },
    { id: "weekend",  icon: "🛻", name: "週末戦士",     desc: "土曜と日曜の両方で学習する",      test: weekendTest },
    { id: "ans500",   icon: "📦", name: "出荷500件",    desc: "通算500問に回答する",             test: function (s) { return s.stats.answers >= 500; } },
    { id: "daily30",  icon: "⚔️", name: "配送便の常連", desc: "今日の配送便を30回完了する",      test: function (s) { return s.stats.deliveries >= 30; } },
    { id: "legacy",   icon: "🏮", name: "道場生え抜き", desc: "v1からデータを引き継ぐ",          test: function (s) { return !!s.legacy; } }
  ];

  function unitAll3(s) {
    return UNITS.some(function (u, ui) {
      return (u.lessons || []).length > 0 && u.lessons.every(function (_, l) {
        return (s.stars[u.id + ":" + l] || 0) >= 3;
      });
    });
  }
  function allClear(s) {
    return UNITS.length > 0 && UNITS.every(function (u) {
      return (u.lessons || []).length > 0 && u.lessons.every(function (_, l) {
        return (s.stars[u.id + ":" + l] || 0) >= 1;
      });
    });
  }
  function weekendTest(s) {
    var days = s.recentDays || [];
    return days.some(function (d) {
      if (!sanitizeDate(d)) return false;
      var dt = parseD(d);
      if (dt.getDay() !== 6) return false;
      return days.indexOf(dstr(new Date(dt.getTime() + 86400000))) >= 0;
    });
  }

  /* ================= ユニットデータ ================= */
  var UNITS = (window.DOJO_UNITS || []).slice().sort(function (a, b) {
    return (a.no || 0) - (b.no || 0);
  });

  /* ================= 状態 ================= */
  var state = null;
  var session = null;
  var view = "home";
  var viewCtx = {};
  var appEl = null;

  function freshState() {
    return {
      v: 2,
      xp: 0, xpToday: 0, xpDate: "",
      streak: 0, bestStreak: 0, lastStudyDate: null, freezes: 0,
      recentDays: [], stars: {}, weak: [],
      daily: null,
      badges: {},
      migratedV1: false, legacy: false,
      stats: { answers: 0, mc: 0, fill: 0, type: 0, perfects: 0, reviews: 0, deliveries: 0, night: false, early: false },
      settings: { sound: true, dailyGoal: 60, theme: "auto" }
    };
  }
  function loadState() {
    var s = freshState();
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && typeof d === "object") {
          Object.keys(s).forEach(function (k) { if (d[k] !== undefined) s[k] = d[k]; });
          var f = freshState();
          s.stats = assign(f.stats, d.stats || {});
          s.settings = assign(f.settings, d.settings || {});
          if (!s.stars || typeof s.stars !== "object") s.stars = {};
          if (!Array.isArray(s.weak)) s.weak = [];
          if (!Array.isArray(s.recentDays)) s.recentDays = [];
          if (!s.badges || typeof s.badges !== "object") s.badges = {};
          if (s.daily && (typeof s.daily !== "object" || !Array.isArray(s.daily.quests) ||
              !s.daily.counters || typeof s.daily.counters !== "object" ||
              !s.daily.claimed || typeof s.daily.claimed !== "object" ||
              !sanitizeDate(s.daily.date))) s.daily = null; // 壊れたdailyはensureDailyが再生成
        }
      }
    } catch (e) { /* 壊れた保存データは捨てる */ }
    s.lastStudyDate = sanitizeDate(s.lastStudyDate);
    return s;
  }
  function assign(base, over) {
    var o = {};
    Object.keys(base).forEach(function (k) { o[k] = base[k]; });
    Object.keys(over).forEach(function (k) { o[k] = over[k]; });
    return o;
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 容量超過等は無視 */ }
  }

  /* ---- v1移行 ---- */
  function migrateV1() {
    if (state.migratedV1) return;
    var raw = null;
    try { raw = localStorage.getItem(V1_KEY); } catch (e) {}
    if (!raw) return;
    try {
      var v1 = JSON.parse(raw) || {};
      var v1xp = +v1.xp || +v1.totalXp || 0;
      if (v1xp > 0) state.xp += v1xp;
      state.streak = Math.max(state.streak, +v1.streak || 0);
      state.bestStreak = Math.max(state.bestStreak, +v1.bestStreak || +v1.best || +v1.streak || 0);
      var ld = sanitizeDate(v1.lastStudyDate || v1.lastDate);
      if (ld) state.lastStudyDate = ld;
      state.legacy = true;
      state.migratedV1 = true;
      state.badges.legacy = dstr();
      toast("🏮 v1のデータを引き継いだ!「道場生え抜き」獲得!");
    } catch (e) {
      state.migratedV1 = true; // 壊れたv1データは以後無視
    }
    save();
  }

  /* ---- デイリー(クエスト・配送便・カウンター) ---- */
  function ensureDaily() {
    var t = dstr();
    if (!state.daily || state.daily.date !== t) {
      state.daily = {
        date: t,
        quests: pickQuests(t),
        claimed: {},
        allBonus: false,
        deliveryDone: false,
        counters: { xp: 0, lessons: 0, type: 0, fill: 0, combo: 0, reviews: 0, perfects: 0 }
      };
    }
    // 欠けたカウンターキーを0で補完(NaN進行を防ぐ)
    var cdef = { xp: 0, lessons: 0, type: 0, fill: 0, combo: 0, reviews: 0, perfects: 0 };
    Object.keys(cdef).forEach(function (k) {
      if (typeof state.daily.counters[k] !== "number" || state.daily.counters[k] !== state.daily.counters[k]) state.daily.counters[k] = 0;
    });
    if (state.xpDate !== t) { state.xpDate = t; state.xpToday = 0; }
  }
  function pickQuests(t) {
    var seed = hashStr(t);
    var ids = QUEST_POOL.map(function (q) { return q.id; });
    var out = [];
    for (var i = 0; i < 3 && ids.length; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      out.push(ids.splice(seed % ids.length, 1)[0]);
    }
    return out;
  }
  function questById(id) {
    for (var i = 0; i < QUEST_POOL.length; i++) if (QUEST_POOL[i].id === id) return QUEST_POOL[i];
    return null;
  }
  function checkQuests() {
    ensureDaily();
    var d = state.daily, c = d.counters;
    var changed = false;
    d.quests.forEach(function (qid) {
      var q = questById(qid);
      if (!q || d.claimed[qid]) return;
      if ((c[q.counter] || 0) >= q.goal) {
        d.claimed[qid] = dstr();
        addXP(q.reward);
        if (q.freeze) state.freezes = Math.min(2, state.freezes + 1);
        toast("🎯 クエスト達成! " + q.text + " +" + q.reward + "XP" + (q.freeze ? " 🧊+1" : ""));
        sfx("jingle");
        changed = true;
      }
    });
    if (!d.allBonus && d.quests.length && d.quests.every(function (id) { return d.claimed[id]; })) {
      d.allBonus = true;
      addXP(30);
      toast("🏆 デイリークエスト全達成! +30XP");
      changed = true;
    }
    if (changed) save();
  }

  /* ---- XP・ストリーク・帯 ---- */
  function addXP(n) {
    ensureDaily();
    state.xp += n;
    state.xpToday += n;
    var note = null;
    if (n > 0) note = touchStreak(dstr());
    return note;
  }
  function touchStreak(t) {
    var note = null;
    if (state.lastStudyDate === t) {
      // 今日はカウント済み
    } else if (!state.lastStudyDate) {
      state.streak = state.streak > 0 ? state.streak + 1 : 1; // v1引継ぎ分は継続扱い
    } else {
      var diff = dayDiff(state.lastStudyDate, t);
      if (diff <= 0) {
        // 時計が巻き戻った等 → 何もしない
      } else if (diff === 1) {
        state.streak += 1;
      } else if (diff - 1 <= state.freezes) {
        state.freezes -= (diff - 1);
        state.streak += 1;
        note = "🧊 ストリークフリーズを" + (diff - 1) + "個消費して連続記録を守った!";
        toast(note);
      } else {
        state.streak = 1;
      }
    }
    state.lastStudyDate = t;
    if (state.streak > state.bestStreak) state.bestStreak = state.streak;
    if (state.recentDays.indexOf(t) < 0) {
      state.recentDays.push(t);
      if (state.recentDays.length > 21) state.recentDays.shift();
    }
    return note;
  }
  function beltOf(xp) {
    var idx = 0;
    for (var i = 0; i < BELTS.length; i++) if (xp >= BELTS[i][1]) idx = i;
    var next = BELTS[idx + 1] || null;
    return { idx: idx, name: BELTS[idx][0], next: next ? next[0] : null, nextXp: next ? next[1] : null };
  }

  /* ---- バッジ ---- */
  function checkBadges() {
    BADGES.forEach(function (b) {
      if (state.badges[b.id]) return;
      var ok = false;
      try { ok = b.test(state); } catch (e) {}
      if (ok) {
        state.badges[b.id] = dstr();
        toast("🏅 実績解除: " + b.icon + " " + b.name);
      }
    });
  }

  /* ---- 弱点キュー ---- */
  function addWeak(qid) {
    if (state.weak.indexOf(qid) < 0) {
      state.weak.push(qid);
      if (state.weak.length > 60) state.weak.shift();
    }
  }
  function removeWeak(qid) {
    state.weak = state.weak.filter(function (q) { return q !== qid; });
  }
  function resolveQid(qid) {
    var p = String(qid).split(":");
    for (var i = 0; i < UNITS.length; i++) {
      if (UNITS[i].id === p[0]) {
        var ls = (UNITS[i].lessons || [])[+p[1]];
        var ex = ls && (ls.exercises || [])[+p[2]];
        return ex ? { ex: ex, qid: qid } : null;
      }
    }
    return null;
  }

  /* ---- 解放ロジック ---- */
  function starOf(u, l) { return state.stars[UNITS[u].id + ":" + l] || 0; }
  function unitUnlocked(u) {
    if (u === 0) return true;
    var prev = UNITS[u - 1];
    if (!prev || !(prev.lessons || []).length) return true; // 欠落ユニットは飛ばす
    return prev.lessons.every(function (_, i) { return starOf(u - 1, i) >= 1; });
  }
  function lessonUnlocked(u, l) {
    if (!UNITS[u] || !(UNITS[u].lessons || [])[l]) return false;
    if (!unitUnlocked(u)) return false;
    return l === 0 || starOf(u, l - 1) >= 1;
  }

  /* ================= 効果音(WebAudio合成) ================= */
  var audioCtx = null;
  function initAudio() {
    if (audioCtx) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    } catch (e) {}
  }
  function tone(freq, start, dur, type, vol) {
    var o = audioCtx.createOscillator();
    var g = audioCtx.createGain();
    var t0 = audioCtx.currentTime + start;
    o.type = type || "triangle";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.16, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
  function sfx(kind) {
    if (!state || !state.settings.sound) return;
    initAudio();
    if (!audioCtx) return;
    try {
      if (kind === "correct") { tone(660, 0, 0.12); tone(880, 0.1, 0.16); }
      else if (kind === "wrong") { tone(150, 0, 0.3, "sawtooth", 0.1); }
      else if (kind === "fanfare") {
        [523, 659, 784, 1047].forEach(function (f, i) { tone(f, i * 0.13, 0.18, "square", 0.12); });
        tone(1319, 0.55, 0.45, "triangle", 0.15);
      }
      else if (kind === "jingle") { tone(523, 0, 0.12); tone(659, 0.11, 0.12); tone(784, 0.22, 0.22); }
    } catch (e) {}
  }

  /* ================= 紙吹雪 ================= */
  function reducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) { return true; }
  }
  var confettiRun = false;
  function stopConfetti() {
    if (!confettiRun) return;
    confettiRun = false;
    try {
      var cv = document.getElementById("fx");
      if (cv) {
        if (cv.getContext) {
          var ctx = cv.getContext("2d");
          if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
        }
        cv.classList.remove("on");
      }
    } catch (e) {}
  }
  function confettiBurst(n) {
    if (reducedMotion()) return;
    try {
      var cv = document.getElementById("fx");
      if (!cv || !cv.getContext) return;
      var ctx = cv.getContext("2d");
      if (!ctx) return;
      cv.width = window.innerWidth || 390;
      cv.height = window.innerHeight || 700;
      cv.classList.add("on");
      var colors = ["#e8641b", "#f2b705", "#2f8f46", "#7cb0ff", "#c2452d", "#9ece6a"];
      var parts = [];
      for (var i = 0; i < n; i++) {
        parts.push({
          x: cv.width / 2 + (Math.random() - 0.5) * cv.width * 0.6,
          y: cv.height * 0.25,
          vx: (Math.random() - 0.5) * 7,
          vy: Math.random() * -8 - 2,
          r: Math.random() * 5 + 3,
          c: colors[i % colors.length],
          a: Math.random() * Math.PI
        });
      }
      var t0 = Date.now();
      confettiRun = true;
      (function frame() {
        if (!confettiRun) return; // stopConfetti済み(clear/クラス除去は実施済み)
        var el = Date.now() - t0;
        ctx.clearRect(0, 0, cv.width, cv.height);
        parts.forEach(function (p) {
          p.vy += 0.18; p.x += p.vx; p.y += p.vy; p.a += 0.12;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.a);
          ctx.fillStyle = p.c;
          ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
          ctx.restore();
        });
        if (el < 2200) requestAnimationFrame(frame);
        else { confettiRun = false; ctx.clearRect(0, 0, cv.width, cv.height); cv.classList.remove("on"); }
      })();
    } catch (e) {}
  }

  /* ================= トースト ================= */
  function toast(msg) {
    try {
      var wrap = document.getElementById("toasts");
      if (!wrap) return;
      var el = document.createElement("div");
      el.className = "toast";
      el.textContent = msg;
      wrap.appendChild(el);
      setTimeout(function () { try { el.classList.add("out"); } catch (e) {} }, 2700);
      setTimeout(function () { try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) {} }, 3200);
    } catch (e) {}
  }

  /* ================= セッションロジック ================= */
  function makeSession(kind, list, u, l) {
    return {
      kind: kind, list: list, u: u, l: l,
      i: 0, correct: 0, combo: 0, maxCombo: 0,
      base: 0, extra: 0, hintPen: 0,
      answered: false, lastOk: false, lastPick: -1,
      hintUsed: false, showHint: false, closeRetry: false, closeMsg: false,
      surrendered: false, fill: null, editor: null, typedValue: "",
      dailyDate: null,
      summary: null
    };
  }
  function startLesson(u, l) {
    u = +u; l = +l;
    var unit = UNITS[u];
    var ls = unit && (unit.lessons || [])[l];
    if (!ls || !(ls.exercises || []).length) { toast("このレッスンはまだ準備中だワン"); return; }
    var list = ls.exercises.map(function (ex, e) {
      return { ex: ex, qid: unit.id + ":" + l + ":" + e };
    });
    session = makeSession("lesson", list, u, l);
    ensureDaily();
    view = "session";
    render();
  }
  function startDaily() {
    ensureDaily();
    if (state.daily.deliveryDone) { toast("今日の配送便は納品済み!また明日だワン"); return; }
    var pool = [];
    UNITS.forEach(function (unit, u) {
      if (!unitUnlocked(u)) return;
      (unit.lessons || []).forEach(function (ls, l) {
        if (!lessonUnlocked(u, l)) return;
        (ls.exercises || []).forEach(function (ex, e) {
          pool.push({ ex: ex, qid: unit.id + ":" + l + ":" + e });
        });
      });
    });
    if (!pool.length) { toast("まずは最初のレッスンから始めよう!"); return; }
    // 弱点問題を優先ミックス(あれば最大2問)
    var weakItems = shuffle(state.weak.map(resolveQid).filter(Boolean)).slice(0, 2);
    var weakQids = weakItems.map(function (w) { return w.qid; });
    var rest = shuffle(pool.filter(function (p) { return weakQids.indexOf(p.qid) < 0; }));
    var list = shuffle(weakItems.concat(rest).slice(0, 5));
    session = makeSession("daily", list);
    session.dailyDate = state.daily.date; // 日付跨ぎ完了時に翌日分を消費しないための記録
    view = "session";
    render();
  }
  function startReview() {
    ensureDaily();
    var items = shuffle(state.weak.map(resolveQid).filter(Boolean)).slice(0, 7);
    if (!items.length) { toast("弱点キューは空だ!素晴らしいワン!"); return; }
    session = makeSession("review", items);
    view = "session";
    render();
  }

  function currentEx() { return session && session.list[session.i] ? session.list[session.i].ex : null; }

  function recordAnswer(ok) {
    var s = session;
    if (!s || s.answered) return;
    var it = s.list[s.i], ex = it.ex;
    s.answered = true;
    s.lastOk = !!ok;
    ensureDaily();
    var c = state.daily.counters;
    state.stats.answers++;
    if (ok) {
      s.correct++;
      s.combo++;
      if (s.combo > s.maxCombo) s.maxCombo = s.combo;
      if (s.combo > c.combo) c.combo = s.combo;
      if (ex.type === "type") { state.stats.type++; c.type++; }
      else if (ex.type === "fill") { state.stats.fill++; c.fill++; }
      else state.stats.mc++;
      var base = XP_BASE[ex.type] || 10;
      var mult = s.combo >= 5 ? 2 : s.combo >= 3 ? 1.5 : 1;
      var gained = Math.ceil(base * mult);
      s.base += base;
      s.extra += gained - base;
      if (s.hintUsed) s.hintPen += 5;
      if (s.kind === "review") removeWeak(it.qid);
      sfx("correct");
    } else {
      s.combo = 0;
      addWeak(it.qid);
      sfx("wrong");
    }
    checkQuests(); // カウンター更新直後に達成判定(セッション中断でも取り逃さない)
    save();
    render();
  }

  function answerMC(i) {
    var s = session;
    if (!s || s.answered) return;
    var ex = currentEx();
    if (!ex || ex.type !== "mc") return;
    s.lastPick = +i;
    recordAnswer(+i === +ex.a);
  }
  function pickChip(b) {
    var s = session;
    if (!s || s.answered || !s.fill) return;
    if (s.fill.slots.indexOf(+b) >= 0) return; // 使用済みチップ(同一index)の再投入を防ぐ
    var n = s.fill.slots.indexOf(null);
    if (n < 0) return;
    s.fill.slots[n] = +b;
    render();
  }
  function clearSlot(n) {
    var s = session;
    if (!s || s.answered || !s.fill) return;
    s.fill.slots[+n] = null;
    render();
  }
  function submitFill() {
    var s = session;
    if (!s || s.answered) return;
    var ex = currentEx();
    if (!ex || ex.type !== "fill" || !s.fill) return;
    if (s.fill.slots.some(function (v) { return v === null; })) return;
    var ok = s.fill.slots.every(function (b, n) {
      return ex.bank[b] === ex.bank[ex.answers[n]]; // 同一トークンの別indexも正解扱い
    });
    recordAnswer(ok);
  }
  function submitType() {
    var s = session;
    if (!s || s.answered) return;
    var ex = currentEx();
    if (!ex || ex.type !== "type") return;
    var val = s.editor ? s.editor.getValue() : (s.typedValue || "");
    s.typedValue = val;
    var res;
    try { res = DojoEditor.check(val, ex.answer, ex.accept || []); }
    catch (e) { res = { ok: false, closeness: 0 }; }
    if (!res.ok && res.closeness >= 0.85 && !s.closeRetry) {
      s.closeRetry = true;
      s.closeMsg = true;
      sfx("wrong");
      render();
      return;
    }
    recordAnswer(res.ok);
  }
  function useHint() {
    var s = session;
    if (!s || s.answered || s.hintUsed) return;
    var ex = currentEx();
    if (!ex || ex.type !== "type") return;
    if (s.editor) s.typedValue = s.editor.getValue();
    s.hintUsed = true;
    s.showHint = true;
    render();
  }
  function surrender() {
    var s = session;
    if (!s || s.answered) return;
    var ex = currentEx();
    if (!ex || ex.type !== "type") return;
    if (s.editor) s.typedValue = s.editor.getValue();
    s.surrendered = true;
    recordAnswer(false);
  }
  function next() {
    var s = session;
    if (!s || !s.answered) return;
    s.i++;
    s.answered = false; s.lastOk = false; s.lastPick = -1;
    s.hintUsed = false; s.showHint = false; s.closeRetry = false; s.closeMsg = false;
    s.surrendered = false; s.fill = null; s.editor = null; s.typedValue = "";
    if (s.i >= s.list.length) finishSession();
    else render();
  }

  function finishSession() {
    var s = session;
    var total = s.list.length, correct = s.correct;
    var perfect = total > 0 && correct === total;
    var lines = [["基本XP", s.base]];
    if (s.extra) lines.push(["コンボボーナス 🔥×" + s.maxCombo, s.extra]);
    if (s.hintPen) lines.push(["ヒント使用", -s.hintPen]);
    var star = 0, firstClear = false;
    var bonus = 0;
    if (s.kind === "lesson") {
      var pct = total ? correct / total : 0;
      star = pct >= 1 ? 3 : pct >= 0.8 ? 2 : pct >= 0.5 ? 1 : 0;
      var key = UNITS[s.u].id + ":" + s.l;
      var prev = state.stars[key] || 0;
      if (prev === 0 && star >= 1) { firstClear = true; bonus += 20; lines.push(["初クリアボーナス", 20]); }
      if (star > prev) state.stars[key] = star; // ★はベスト値を保持
    }
    if (perfect) { bonus += 15; lines.push(["全問正解ボーナス", 15]); }
    var totalXP = s.base + s.extra - s.hintPen + bonus;
    if (totalXP < 0) totalXP = 0;
    if (s.kind === "daily") {
      lines.push(["⚔️ 配送便2倍", totalXP]);
      totalXP *= 2;
      if (perfect) { totalXP += 30; lines.push(["無事故配送ボーナス", 30]); }
    }
    var beltBefore = beltOf(state.xp).idx;
    var freezeNote = addXP(totalXP);
    var beltAfter = beltOf(state.xp);

    ensureDaily();
    var c = state.daily.counters;
    c.xp += totalXP;
    if (s.kind === "lesson" && star >= 1) c.lessons++;
    if (s.kind === "review") { c.reviews++; state.stats.reviews++; }
    if (s.kind === "daily") {
      // 開始時と同じ日付のときだけ本日分を消費(日付跨ぎ完了で翌日便を封鎖しない)
      if (state.daily.date === s.dailyDate) state.daily.deliveryDone = true;
      state.stats.deliveries++;
    }
    if (perfect) { c.perfects++; state.stats.perfects++; }

    var h = new Date().getHours();
    if (h >= 22) state.stats.night = true;
    if (h < 7) state.stats.early = true;

    s.summary = {
      lines: lines, totalXP: totalXP, correct: correct, total: total,
      star: star, firstClear: firstClear, perfect: perfect,
      promoted: beltAfter.idx > beltBefore ? beltAfter.name : null,
      freezeNote: freezeNote
    };
    checkQuests();
    checkBadges();
    save();
    view = "result";
    render();
    sfx(s.summary.promoted ? "fanfare" : "jingle");
    confettiBurst(s.summary.promoted ? 160 : perfect ? 110 : 70);
  }

  function goHome() {
    session = null;
    view = "home";
    render();
  }

  /* ================= 描画 ================= */
  function render() {
    try {
      if (view !== "result") stopConfetti(); // 結果画面以外へ遷移したら紙吹雪を打ち切る
      if (view === "home") renderHome();
      else if (view === "lesson") renderLesson();
      else if (view === "session") renderSession();
      else if (view === "result") renderResult();
      else if (view === "profile") renderProfile();
      else if (view === "settings") renderSettings();
      else renderHome();
    } catch (e) {
      try {
        appEl.innerHTML = '<div class="fatal">画面の描画でエラーが発生しました: ' + esc(e && e.message ? e.message : e) + "</div>" +
          '<button class="btn ghost" data-action="home">ホームへ戻る</button>';
      } catch (e2) {}
    }
  }

  function starsHTML(n) {
    var h = "";
    for (var i = 0; i < 3; i++) h += '<span class="' + (i < n ? "on" : "off") + '">★</span>';
    return '<span class="stars">' + h + "</span>";
  }
  function ringHTML(pct, today, goal) {
    var dash = Math.min(100, Math.round(pct * 1000) / 10);
    return '<svg class="ring" viewBox="0 0 40 40" role="img" aria-label="デイリー目標 ' + today + "/" + goal + 'XP">' +
      '<circle class="ring-bg" cx="20" cy="20" r="15.9"></circle>' +
      '<circle class="ring-fg" cx="20" cy="20" r="15.9" stroke-dasharray="' + dash + ' 100"></circle>' +
      '<text x="20" y="23" text-anchor="middle">' + Math.min(999, Math.round(pct * 100)) + "%</text></svg>";
  }
  function codeBlock(code, lang, extraClass) {
    var html;
    try { html = DojoEditor.highlight(code, lang || "dax"); }
    catch (e) { html = esc(code); }
    return '<pre class="code' + (extraClass ? " " + extraClass : "") + '">' + html + "</pre>";
  }
  function shibaHomeLine() {
    var pool = SHIBA.home.slice();
    if (state.streak >= 3) pool.push("🔥" + state.streak + "日連続!良い流れだワン!");
    if (state.daily && !state.daily.deliveryDone) pool.push("今日の配送便、まだ積み込みが済んでないぞ。");
    if (state.weak.length >= 3) pool.push("弱点が" + state.weak.length + "問たまってる。再配達に行くワン!");
    return pool[hashStr(dstr() + "|shiba") % pool.length];
  }

  /* ---- ホーム(パス画面) ---- */
  function renderHome() {
    ensureDaily();
    checkQuests(); // 到達済みで未クレームのクエストをホーム表示時にも回収
    var belt = beltOf(state.xp);
    var goal = +state.settings.dailyGoal || 60;
    var xpToday = state.xpDate === dstr() ? state.xpToday : 0;
    var h = "";
    h += '<header class="topbar">' +
      '<span class="stat" title="連続学習日数">🔥<b>' + state.streak + "</b></span>" +
      (state.freezes ? '<span class="stat" title="ストリークフリーズ">🧊<b>' + state.freezes + "</b></span>" : "") +
      '<span class="stat">⭐<b>' + state.xp + "</b>XP</span>" +
      '<span class="belt">' + esc(belt.name) + "</span>" +
      ringHTML(Math.min(1, xpToday / goal), xpToday, goal) +
      "</header>";
    h += '<div class="mascot"><span class="m-dog" aria-hidden="true">🐕‍🦺</span><div class="bubble">' + esc(shibaHomeLine()) + "</div></div>";
    h += '<div class="actions">' +
      '<button class="btn" data-action="daily"' + (state.daily.deliveryDone ? " disabled" : "") + ">⚔️ 今日の配送便" + (state.daily.deliveryDone ? " ✅" : "") + "</button>" +
      '<button class="btn ghost" data-action="review"' + (state.weak.length ? "" : " disabled") + ">📝 弱点復習(" + state.weak.length + "問)</button>" +
      '<button class="btn ghost" data-action="profile">👤 プロフィール</button>' +
      '<button class="btn ghost" data-action="settings">⚙️ 設定</button>' +
      "</div>";
    h += questPanel();
    h += pathHTML();
    appEl.innerHTML = h;
  }
  function questPanel() {
    var d = state.daily, c = d.counters;
    var rows = d.quests.map(function (qid) {
      var q = questById(qid);
      if (!q) return "";
      var prog = Math.min(c[q.counter] || 0, q.goal);
      var done = !!d.claimed[qid];
      return '<div class="quest' + (done ? " done" : "") + '">' +
        '<span class="q-ic">' + (done ? "✅" : "🎯") + "</span>" +
        '<div class="q-body"><div class="q-text">' + esc(q.text) + " <small>(" + prog + "/" + q.goal + ")</small></div>" +
        '<div class="q-bar"><i style="width:' + Math.round((prog / q.goal) * 100) + '%"></i></div></div>' +
        '<span class="q-r">+' + q.reward + "XP" + (q.freeze ? " 🧊" : "") + "</span></div>";
    }).join("");
    return '<section class="quests card"><h2>📋 デイリークエスト</h2>' + rows +
      (d.allBonus ? '<div class="q-all">🏆 全達成 +30XP!</div>' : "") + "</section>";
  }
  function pathHTML() {
    var h = "";
    if (!UNITS.length) return '<div class="card">教材データが見つからないワン…(units未読込)</div>';
    UNITS.forEach(function (unit, u) {
      var uOpen = unitUnlocked(u);
      h += '<section class="unit' + (uOpen ? "" : " locked") + '">' +
        '<div class="unit-head" style="--uc:' + esc(unit.color || "#e8641b") + '">' +
        '<span class="u-icon">' + esc(unit.icon || "📦") + "</span>" +
        "<div><div class=\"u-name\">" + esc(unit.name || unit.id) + "</div>" +
        '<div class="u-desc">' + esc(unit.desc || "") + "</div></div></div>";
      h += '<div class="path">';
      (unit.lessons || []).forEach(function (ls, l) {
        var open = lessonUnlocked(u, l);
        var star = starOf(u, l);
        var x = [0, 60, 0, -60][l % 4];
        var cls = "node " + (open ? (star ? "done" : "next") : "lock");
        var inner = !open ? "🔒" : star ? "✓" : esc(unit.icon || "⚔️");
        h += '<div class="node-wrap" style="transform:translateX(' + x + 'px)">' +
          '<button class="' + cls + '" style="--uc:' + esc(unit.color || "#e8641b") + '" data-action="node" data-u="' + u + '" data-l="' + l + '" aria-label="' + esc(ls.title || "レッスン") + (open ? "" : "(ロック中)") + '">' + inner + "</button>" +
          "<div>" + starsHTML(star) + "</div>" +
          '<div class="node-name">' + esc(ls.title || "") + "</div></div>";
      });
      h += "</div></section>";
    });
    return h;
  }

  /* ---- レッスン(解説doc) ---- */
  function renderLesson() {
    var unit = UNITS[viewCtx.u];
    var ls = unit && (unit.lessons || [])[viewCtx.l];
    if (!ls) { goHome(); return; }
    var h = '<header class="sub-head">' +
      '<button class="icon-btn" data-action="home" aria-label="戻る">←</button>' +
      "<h1>" + esc(unit.icon || "") + " " + esc(ls.title) + "</h1>" + starsHTML(starOf(viewCtx.u, viewCtx.l)) +
      "</header>";
    h += '<article class="doc card">' + (ls.doc || "<p>(解説準備中)</p>") + "</article>"; // docのみ信頼済みHTML
    h += '<button class="btn big" data-action="start-ex">演習へ 🎯</button>';
    appEl.innerHTML = h;
  }

  /* ---- 演習セッション ---- */
  function renderSession() {
    var s = session;
    if (!s) { goHome(); return; }
    var ex = currentEx();
    if (!ex) { finishSession(); return; }
    var pct = Math.round(((s.i + (s.answered ? 1 : 0)) / s.list.length) * 100);
    var kindLabel = s.kind === "daily" ? "⚔️ 今日の配送便" : s.kind === "review" ? "📝 弱点復習" : "🎯 演習";
    var h = '<header class="s-head">' +
      '<button class="icon-btn" data-action="abort" aria-label="中断">✕</button>' +
      '<div class="p-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></div>' +
      (s.combo >= 2 ? '<span class="combo">🔥×' + s.combo + "</span>" : '<span class="combo dim">' + kindLabel + "</span>") +
      "</header>";
    h += '<div class="ex-card' + (s.answered ? (s.lastOk ? " pop" : " shake") : "") + '">';
    h += '<div class="ex-no">問題 ' + (s.i + 1) + " / " + s.list.length + "</div>";
    h += '<div class="ex-q">' + escQ(ex.q) + "</div>";
    if (ex.type === "mc") {
      if (ex.code) h += codeBlock(ex.code, ex.lang);
      h += mcHTML(ex, s);
    } else if (ex.type === "fill") {
      h += fillHTML(ex, s);
    } else if (ex.type === "type") {
      h += typeHTML(ex, s);
    } else {
      h += '<div class="fb-exp">未対応の問題タイプ: ' + esc(ex.type) + "</div>";
    }
    h += "</div>";
    h += feedbackHTML(ex, s);
    appEl.innerHTML = h;
    if (ex.type === "type" && !s.answered) {
      var host = appEl.querySelector("#ed-host");
      if (host) {
        try {
          s.editor = DojoEditor.mount(host, {
            lang: ex.lang || "dax",
            value: s.typedValue || ex.scaffold || "",
            onInput: function (v) { s.typedValue = v; }
          });
        } catch (e) { s.editor = null; }
      }
    }
  }
  function mcHTML(ex, s) {
    var opts = (ex.c || []).map(function (c, i) {
      var cls = "opt";
      if (s.answered) {
        if (i === +ex.a) cls += " ok";
        else if (i === s.lastPick) cls += " bad";
        cls += " locked";
      }
      return '<button class="' + cls + '" data-action="mc" data-i="' + i + '"' + (s.answered ? " disabled" : "") + '>' +
        '<span class="opt-key">' + (i + 1) + "</span><span>" + esc(c) + "</span></button>";
    }).join("");
    return '<div class="opts">' + opts + "</div>";
  }
  function fillHTML(ex, s) {
    if (!s.fill) {
      s.fill = {
        slots: (ex.answers || []).map(function () { return null; }),
        order: shuffle((ex.bank || []).map(function (_, i) { return i; }))
      };
    }
    var parts = String(ex.code || "").split(/【(\d+)】/);
    var codeH = "";
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        try { codeH += DojoEditor.highlight(parts[i], ex.lang || "dax"); }
        catch (e) { codeH += esc(parts[i]); }
      } else {
        var n = +parts[i];
        var b = s.fill.slots[n];
        var cls = "slot" + (b === null || b === undefined ? " empty" : "");
        if (s.answered && b !== null && b !== undefined) {
          cls += ex.bank[b] === ex.bank[ex.answers[n]] ? " ok" : " bad";
        }
        codeH += '<button class="' + cls + '" data-action="slot" data-n="' + n + '"' + (s.answered ? " disabled" : "") +
          ' aria-label="スロット' + (n + 1) + '">' +
          (b === null || b === undefined ? "＿＿＿" : esc(ex.bank[b])) + "</button>";
      }
    }
    var h = '<pre class="code fill-code">' + codeH + "</pre>";
    if (!s.answered) {
      var bankH = s.fill.order.map(function (b) {
        var used = s.fill.slots.indexOf(b) >= 0; // slotsはbank indexを保持するためindex比較
        return '<button class="chip' + (used ? " used" : "") + '" data-action="chip" data-b="' + b + '"' + (used ? " disabled" : "") + '>' + esc(ex.bank[b]) + "</button>";
      }).join("");
      var full = s.fill.slots.every(function (v) { return v !== null && v !== undefined; });
      h += '<div class="bank">' + bankH + "</div>" +
        '<button class="btn big" data-action="check-fill"' + (full ? "" : " disabled") + ">答え合わせ</button>";
    }
    return h;
  }
  function typeHTML(ex, s) {
    var h = "";
    if (s.answered) {
      h += '<div class="fb-label">あなたの答え</div>' + codeBlock(s.typedValue || "(未入力)", ex.lang);
      return h;
    }
    h += '<div id="ed-host" class="ed-host"></div>';
    if (s.showHint && ex.hint) h += '<div class="hint">💡 ' + escQ(ex.hint) + " <small>(この問題のXP-5)</small></div>";
    if (s.closeMsg) h += '<div class="close-msg">🤏 おしい!タイプミスがないか確認しよう(ノーペナルティで再挑戦)</div>';
    h += '<div class="type-btns">' +
      '<button class="btn" data-action="check-type">答え合わせ</button>' +
      '<button class="btn ghost" data-action="hint"' + (s.hintUsed ? " disabled" : "") + ">💡 ヒント</button>" +
      '<button class="btn ghost" data-action="giveup">🏳️ 白旗</button></div>';
    return h;
  }
  function fillSolvedCode(ex) {
    return String(ex.code || "").replace(/【(\d+)】/g, function (_, n) {
      return ex.bank[ex.answers[+n]];
    });
  }
  function feedbackHTML(ex, s) {
    if (!s.answered) return "";
    var ok = s.lastOk;
    var line = pick(ok ? SHIBA.correct : SHIBA.wrong);
    var h = '<div class="feedback ' + (ok ? "good" : "ouch") + '">';
    h += '<div class="fb-head">' + (ok ? "✓ 正解!" : s.surrendered ? "🏳️ 降参…答えを確認" : "✗ 不正解") +
      (ok && s.combo >= 2 ? ' <span class="combo">🔥×' + s.combo + "</span>" : "") +
      ' <span class="fb-shiba">🐕‍🦺「' + esc(line) + "」</span></div>";
    if (ex.type === "fill" && !ok) {
      h += '<div class="fb-label">正解コード</div>' + codeBlock(fillSolvedCode(ex), ex.lang);
    }
    if (ex.type === "type") {
      h += '<div class="fb-label">正解コード</div>' + codeBlock(ex.answer, ex.lang);
    }
    if (ex.e) h += '<div class="fb-exp">' + escQ(ex.e) + "</div>";
    h += '<button class="btn" data-action="next">次へ ▶</button></div>';
    return h;
  }

  /* ---- 結果画面 ---- */
  function renderResult() {
    var s = session;
    if (!s || !s.summary) { goHome(); return; }
    var m = s.summary;
    var lineH = m.lines.map(function (l) {
      return '<div class="xp-line"><span>' + esc(l[0]) + "</span><b>" + (l[1] >= 0 ? "+" : "") + l[1] + "XP</b></div>";
    }).join("");
    var h = '<div class="result card">';
    h += '<div class="r-shiba">🐕‍🦺「' + esc(pick(SHIBA.result)) + "」</div>";
    h += "<h1>" + (m.perfect ? "💮 パーフェクト!" : m.correct > 0 ? "🚚 納品完了!" : "🌧 今日は荒れ模様…") + "</h1>";
    h += '<div class="r-score">正解 ' + m.correct + " / " + m.total +
      (s.kind === "lesson" ? " " + starsHTML(m.star) : "") + "</div>";
    h += '<div class="xp-lines">' + lineH +
      '<div class="xp-line total"><span>合計</span><b>+' + m.totalXP + "XP</b></div></div>";
    if (m.promoted) h += '<div class="promo">🎉 昇段! <b>' + esc(m.promoted) + "</b> になった!</div>";
    h += '<div class="r-streak">🔥 連続' + state.streak + "日" + (state.freezes ? " 🧊×" + state.freezes : "") + "</div>";
    if (m.freezeNote) h += '<div class="r-freeze">' + esc(m.freezeNote) + "</div>";
    h += '<button class="btn big" data-action="home">ホームへ</button></div>';
    appEl.innerHTML = h;
  }

  /* ---- プロフィール ---- */
  function statBox(label, val) {
    return '<div class="sbox"><b>' + val + "</b><span>" + esc(label) + "</span></div>";
  }
  function renderProfile() {
    var belt = beltOf(state.xp);
    var h = '<header class="sub-head"><button class="icon-btn" data-action="home" aria-label="戻る">←</button><h1>👤 プロフィール</h1></header>';
    h += '<div class="card prof-top"><div class="belt-big">' + esc(belt.name) + "</div>" +
      "<div>⭐" + state.xp + "XP" + (belt.next ? "(次の" + esc(belt.next) + "まで あと" + (belt.nextXp - state.xp) + "XP)" : "") + "</div>" +
      "<div>🔥 連続" + state.streak + "日(最高" + state.bestStreak + "日) 🧊フリーズ×" + state.freezes + "</div></div>";
    h += '<section class="card"><h2>📊 統計</h2><div class="stat-grid">' +
      statBox("総回答数", state.stats.answers) +
      statBox("type正解", state.stats.type) +
      statBox("fill正解", state.stats.fill) +
      statBox("パーフェクト", state.stats.perfects) +
      statBox("弱点復習", state.stats.reviews) +
      statBox("配送便", state.stats.deliveries) +
      "</div>";
    h += '<div class="u-progress">' + UNITS.map(function (unit, u) {
      var lessons = unit.lessons || [];
      var max = lessons.length * 3;
      var got = lessons.reduce(function (a, _, l) { return a + starOf(u, l); }, 0);
      return '<div class="up-row"><span>' + esc(unit.icon || "") + " " + esc(unit.name || unit.id) + "</span>" +
        '<div class="q-bar"><i style="width:' + (max ? Math.round((got / max) * 100) : 0) + '%"></i></div>' +
        "<small>" + got + "/" + max + "★</small></div>";
    }).join("") + "</div></section>";
    h += '<section class="card"><h2>🏅 実績バッジ(' + Object.keys(state.badges).length + "/" + BADGES.length + ')</h2><div class="badges">' +
      BADGES.map(function (b) {
        var got = state.badges[b.id];
        return '<div class="badge' + (got ? " got" : " no") + '">' +
          '<span class="b-ic">' + b.icon + "</span>" +
          '<span class="b-name">' + esc(b.name) + "</span>" +
          '<span class="b-sub">' + (got ? "獲得 " + esc(got) : esc(b.desc)) + "</span></div>";
      }).join("") + "</div></section>";
    appEl.innerHTML = h;
  }

  /* ---- 設定 ---- */
  function segBtn(action, v, label, on) {
    return '<button class="seg-btn' + (on ? " on" : "") + '" data-action="' + action + '" data-v="' + v + '">' + esc(label) + "</button>";
  }
  function renderSettings() {
    var st = state.settings;
    var h = '<header class="sub-head"><button class="icon-btn" data-action="home" aria-label="戻る">←</button><h1>⚙️ 設定</h1></header>';
    h += '<div class="card">';
    h += '<div class="set-row"><span>🔊 効果音</span><span class="seg">' +
      segBtn("set-sound", "1", "ON", st.sound) + segBtn("set-sound", "0", "OFF", !st.sound) + "</span></div>";
    h += '<div class="set-row"><span>🎯 デイリー目標</span><span class="seg">' +
      segBtn("set-goal", "30", "30XP", +st.dailyGoal === 30) +
      segBtn("set-goal", "60", "60XP", +st.dailyGoal === 60) +
      segBtn("set-goal", "100", "100XP", +st.dailyGoal === 100) + "</span></div>";
    h += '<div class="set-row"><span>🌗 テーマ</span><span class="seg">' +
      segBtn("set-theme", "auto", "自動", st.theme === "auto") +
      segBtn("set-theme", "light", "ライト", st.theme === "light") +
      segBtn("set-theme", "dark", "ダーク", st.theme === "dark") + "</span></div>";
    h += '<div class="set-row"><span>🗑 データリセット</span>' +
      '<button class="btn danger" data-action="reset">全データを消去</button></div>';
    h += "</div>";
    appEl.innerHTML = h;
  }
  function applyTheme() {
    try {
      var t = state.settings.theme;
      if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
      else document.documentElement.removeAttribute("data-theme");
    } catch (e) {}
  }
  function doReset() {
    var ok = false;
    try { ok = confirm("本当にリセットしますか?") && confirm("全ての進捗・バッジ・XPが消えます。よろしいですか?"); } catch (e) {}
    if (!ok) return;
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    try { localStorage.removeItem(V1_KEY); } catch (e) {}
    state = freshState();
    ensureDaily();
    save();
    toast("データをリセットしました");
    goHome();
  }

  /* ================= イベント(デリゲート) ================= */
  function findAction(el) {
    var hops = 0;
    while (el && hops++ < 12) {
      if (el.getAttribute && el.getAttribute("data-action")) return el;
      el = el.parentNode;
    }
    return null;
  }
  function onClick(ev) {
    try {
      var el = findAction(ev.target);
      if (!el) return;
      var a = el.getAttribute("data-action");
      switch (a) {
        case "node": {
          var u = +el.getAttribute("data-u"), l = +el.getAttribute("data-l");
          if (!lessonUnlocked(u, l)) {
            toast("🔒 直前のレッスンを★1以上でクリアすると解放だワン");
            sfx("wrong");
          } else {
            viewCtx = { u: u, l: l };
            view = "lesson";
            render();
          }
          break;
        }
        case "start-ex": startLesson(viewCtx.u, viewCtx.l); break;
        case "daily": startDaily(); break;
        case "review": startReview(); break;
        case "profile": view = "profile"; render(); break;
        case "settings": view = "settings"; render(); break;
        case "home": goHome(); break;
        case "mc": answerMC(+el.getAttribute("data-i")); break;
        case "chip": pickChip(+el.getAttribute("data-b")); break;
        case "slot": clearSlot(+el.getAttribute("data-n")); break;
        case "check-fill": submitFill(); break;
        case "check-type": submitType(); break;
        case "hint": useHint(); break;
        case "giveup": surrender(); break;
        case "next": next(); break;
        case "abort": {
          var yes = false;
          try { yes = confirm("セッションを中断しますか?このセッションのXPは保存されません"); } catch (e) { yes = true; }
          if (yes) goHome();
          break;
        }
        case "set-sound":
          state.settings.sound = el.getAttribute("data-v") === "1";
          save(); render();
          break;
        case "set-goal":
          state.settings.dailyGoal = +el.getAttribute("data-v") || 60;
          save(); render();
          break;
        case "set-theme":
          state.settings.theme = el.getAttribute("data-v") || "auto";
          applyTheme(); save(); render();
          break;
        case "reset": doReset(); break;
      }
    } catch (e) {
      try { console.error(e); } catch (e2) {}
    }
  }

  /* ================= 起動 ================= */
  function boot() {
    appEl = document.getElementById("app");
    if (!appEl) throw new Error("#app が見つかりません");
    state = loadState();
    migrateV1();
    ensureDaily();
    // 途切れたストリークの遅延リセット(表示用)
    if (state.lastStudyDate) {
      var diff = dayDiff(state.lastStudyDate, dstr());
      if (diff > 1 && diff - 1 > state.freezes) state.streak = 0;
    }
    applyTheme();
    appEl.addEventListener("click", onClick);
    document.addEventListener("pointerdown", initAudio, { once: true });
    checkBadges();
    save();

    // テスト用フック
    window.Dojo = {
      get state() { return state; },
      get session() { return session; },
      get view() { return view; },
      save: save,
      startLesson: startLesson,
      startDaily: startDaily,
      startReview: startReview,
      answerMC: answerMC,
      submitFill: submitFill,
      submitType: submitType,
      next: next,
      goHome: goHome,
      // 追加フック
      useHint: useHint,
      surrender: surrender,
      pickChip: pickChip,
      clearSlot: clearSlot,
      ensureDaily: ensureDaily,
      checkQuests: checkQuests,
      checkBadges: checkBadges,
      render: render,
      toast: toast
    };

    view = "home";
    render();
  }

  try {
    boot();
  } catch (err) {
    try {
      var el = document.getElementById("app");
      if (el) el.innerHTML = '<div class="fatal">起動エラーが発生しました: ' + esc(err && err.message ? err.message : err) + "<br>ページを再読み込みしてください。</div>";
    } catch (e2) {}
    try { console.error(err); } catch (e3) {}
  }
})();
