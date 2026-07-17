/* ============================================================
 * Power BI 道場 v5 — app.js(シェル担当)
 * 状態管理・全画面・ゲーミフィケーション。
 * 前提: window.DojoEditor / window.DOJO_UNITS(UI_CONTRACT.md 準拠)
 * 任意: window.DOJO_DICT(関数辞典・存在しなくても動く)
 * v5: トラック構造 / 関数辞典 / SRS復習 / ストリーク強化(Earn-Back・ウェイジャー) /
 *     自己ベスト&ゴースト / 実力診断 / 認定証 / オンボーディング / インターリービング
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
  function nowDate() {
    // テスト用に window.__DOJO_NOW で「現在時刻」を上書き可能(通常は未設定)
    try { if (window.__DOJO_NOW) return new Date(window.__DOJO_NOW); } catch (e) {}
    return new Date();
  }
  function dstr(d) {
    d = d || nowDate();
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
  // カレンダー演算で日を進める(ms加算だとDSTの25時間日で日付が進まないため)
  function addDays(s, n) { var d = parseD(s); d.setDate(d.getDate() + n); return dstr(d); }
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
  function fmtTime(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ":" + pad2(s % 60);
  }

  /* ================= 定数 ================= */
  var STORE_KEY = "pbdojo_v2"; // 契約: キー名はv2のまま(中身に version:5)
  var V1_KEY = "pbdojo_v1";
  var XP_BASE = { mc: 10, fill: 15, type: 20 };
  var BELTS = [
    ["白帯", 0], ["黄帯", 150], ["橙帯", 400], ["緑帯", 800], ["青帯", 1400],
    ["紫帯", 2200], ["茶帯", 3200], ["赤帯", 4500], ["黒帯", 6000], ["師範", 8000]
  ];
  var SRS_STEPS = [1, 3, 7, 18, 30]; // 復習間隔(日)。正解で次段、上限30で卒業
  var STREAK_MILESTONES = [7, 25, 50, 100];
  var TRACKS = [
    { id: "overview",       icon: "📖", name: "全体概要",        diag: false },
    { id: "basic",          icon: "🔰", name: "基礎",            diag: true },
    { id: "advanced",       icon: "🧠", name: "応用",            diag: true },
    { id: "tips",           icon: "🛠️", name: "実務Tips",        diag: false },
    { id: "practice-basic", icon: "🏭", name: "実践基礎(物流)", diag: true },
    { id: "practice-adv",   icon: "🚀", name: "実践応用(物流)", diag: true }
  ];

  var QUEST_POOL = [
    { id: "xp60",     text: "XPを60稼ぐ",             counter: "xp",       goal: 60, reward: 25 },
    { id: "lessons2", text: "レッスンを2つクリアする", counter: "lessons",  goal: 2,  reward: 30 },
    { id: "type3",    text: "type問題に3問正解する",   counter: "type",     goal: 3,  reward: 30, freeze: true },
    { id: "fill4",    text: "fill問題に4問正解する",   counter: "fill",     goal: 4,  reward: 25 },
    { id: "combo5",   text: "コンボ5を達成する",       counter: "combo",    goal: 5,  reward: 20, freeze: true },
    { id: "review1",  text: "復習を1回完了する",       counter: "reviews",  goal: 1,  reward: 20 },
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
    ],
    // 経過日数連動(再訪時)。{n}を日数に置換
    back2: ["おっ、{n}日ぶりだな相棒!ちょうど荷物が溜まってきた頃だワン。", "{n}日ぶりの出勤だな!まずは軽い便から流すか。"],
    back4: ["{n}日ぶりだワン…倉庫のホコリを払っておいたぞ。復習から再開だ!", "久しぶりだな、相棒!{n}日分の遅れは復習便で取り返せるワン。"],
    back8: ["{n}日ぶり!心配してたんだワン…。焦らず1レッスンから積み直そう。", "おかえり!{n}日空いても、戻ってきたやつが一番強いワン。"]
  };

  var BADGES = [
    { id: "first",    icon: "🥋", name: "入門",         desc: "初めてレッスンをクリアする",       test: function (s) { return Object.keys(s.stars).some(function (k) { return s.stars[k] >= 1; }); } },
    { id: "streak7",  icon: "🔥", name: "皆勤の火",     desc: "7日連続で学習する",               test: function (s) { return s.bestStreak >= 7; } },
    { id: "streak25", icon: "🏮", name: "二十五夜便",   desc: "25日連続で学習する",              test: function (s) { return s.bestStreak >= 25; } },
    { id: "streak30", icon: "🌙", name: "月間無欠便",   desc: "30日連続で学習する",              test: function (s) { return s.bestStreak >= 30; } },
    { id: "streak50", icon: "🚛", name: "五十日行",     desc: "50日連続で学習する",              test: function (s) { return s.bestStreak >= 50; } },
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
    { id: "diag1",    icon: "⚡", name: "腕試し",       desc: "実力診断でトラックを解放する",    test: function (s) { return Object.keys(s.trackUnlocked || {}).length >= 1; } },
    { id: "wager1",   icon: "🎌", name: "有言実行",     desc: "7日ウェイジャーを達成する",       test: function (s) { return (s.stats.wagersWon || 0) >= 1; } },
    { id: "cert",     icon: "📜", name: "免許皆伝",     desc: "認定証を獲得する",                test: function (s) { return certEligible(s); } },
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
  function certEligible(s) {
    if (!allClear(s)) return false;
    // final:true ユニットの最終レッスン(卒業試験)★1以上 — allClearに含まれるが明示チェック
    var fin = null;
    UNITS.forEach(function (u) { if (u.final) fin = u; });
    if (!fin) return true; // finalユニット欠落時はallClearのみで判定
    var last = (fin.lessons || []).length - 1;
    return last < 0 ? false : (s.stars[fin.id + ":" + last] || 0) >= 1;
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

  /* ================= ユニットデータ(no順ソート+トラック分類) ================= */
  var UNITS = (window.DOJO_UNITS || []).slice().sort(function (a, b) {
    return (a.no || 0) - (b.no || 0);
  });
  function trackOf(unit) {
    var t = unit && unit.track;
    for (var i = 0; i < TRACKS.length; i++) if (TRACKS[i].id === t) return t;
    return "overview"; // track未指定/未知は先頭トラック扱い(壊さない)
  }
  // track id -> UNITS内index配列(no順を維持)
  var TRACK_UNITS = {};
  UNITS.forEach(function (u, i) {
    var t = trackOf(u);
    (TRACK_UNITS[t] = TRACK_UNITS[t] || []).push(i);
  });
  function trackMeta(tid) {
    for (var i = 0; i < TRACKS.length; i++) if (TRACKS[i].id === tid) return TRACKS[i];
    return { id: tid, icon: "📦", name: tid, diag: false };
  }

  /* ================= 状態 ================= */
  var state = null;
  var session = null;
  var view = "home";
  var viewCtx = {};
  var appEl = null;
  var visitGap = 0; // 前回訪問からの経過日数(セリフ用)

  function freshState() {
    return {
      v: 5,
      xp: 0, xpToday: 0, xpDate: "",
      streak: 0, bestStreak: 0, lastStudyDate: null, freezes: 0,
      recentDays: [], stars: {}, weak: [],
      daily: null,
      badges: {},
      migratedV1: false, legacy: false,
      stats: { answers: 0, mc: 0, fill: 0, type: 0, perfects: 0, reviews: 0, deliveries: 0, night: false, early: false, wagersWon: 0 },
      settings: { sound: true, dailyGoal: 60, theme: "auto" },
      /* ---- v5 ---- */
      nickname: "",
      onboarded: false,
      srs: {},            // qid -> { iv: 日数, due: "YYYY-MM-DD" }
      trackUnlocked: {},  // track id -> 診断合格日
      collapsed: {},      // track id -> true(パス折りたたみ)
      collapsedInit: false, // 初回デフォルト折りたたみを適用済みか
      lastTrack: null,    // 最後にプレイしたトラックid(「続きから」用)
      wager: null,        // { start, done, last } 7日ウェイジャー
      earnBack: null,     // { streak, date } 当日限定の復元チャレンジ権
      dailyBest: null,    // { date, correct, total, timeMs, paces:[] }
      xpDays: {},         // "YYYY-MM-DD" -> その日のXP(直近14日グラフ用)
      lastSeen: null      // 最終訪問日(セリフ用)
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
          if (!s.srs || typeof s.srs !== "object" || Array.isArray(s.srs)) s.srs = {};
          if (!s.trackUnlocked || typeof s.trackUnlocked !== "object") s.trackUnlocked = {};
          if (!s.collapsed || typeof s.collapsed !== "object") s.collapsed = {};
          if (!s.xpDays || typeof s.xpDays !== "object") s.xpDays = {};
          if (typeof s.nickname !== "string") s.nickname = "";
          if (typeof s.lastTrack !== "string") s.lastTrack = null;
          if (s.wager && (typeof s.wager !== "object" || !sanitizeDate(s.wager.start))) s.wager = null;
          if (s.earnBack && (typeof s.earnBack !== "object" || !sanitizeDate(s.earnBack.date))) s.earnBack = null;
          if (s.dailyBest && (typeof s.dailyBest !== "object" || typeof s.dailyBest.correct !== "number")) s.dailyBest = null;
          if (s.daily && (typeof s.daily !== "object" || !Array.isArray(s.daily.quests) ||
              !s.daily.counters || typeof s.daily.counters !== "object" ||
              !s.daily.claimed || typeof s.daily.claimed !== "object" ||
              !sanitizeDate(s.daily.date))) s.daily = null; // 壊れたdailyはensureDailyが再生成
        }
      }
    } catch (e) { /* 壊れた保存データは捨てる */ }
    s.lastStudyDate = sanitizeDate(s.lastStudyDate);
    s.lastSeen = sanitizeDate(s.lastSeen);
    s.v = 5;
    migrateStarKeys(s);
    migrateSrs(s);
    return s;
  }
  // 旧index基準キー("0:2"等)→ unit.id基準("unit01:2")へ移行
  function migrateStarKeys(s) {
    Object.keys(s.stars).forEach(function (k) {
      var m = /^(\d+):(\d+)$/.exec(k);
      if (!m) return;
      var u = UNITS[+m[1]];
      if (u && u.id) {
        var nk = u.id + ":" + m[2];
        if ((s.stars[nk] || 0) < s.stars[k]) s.stars[nk] = s.stars[k];
      }
      delete s.stars[k];
    });
  }
  // srsエントリの健全化 + 既存weakにsrs未登録なら期日今日で登録(v2→v5移行)
  function migrateSrs(s) {
    Object.keys(s.srs).forEach(function (q) {
      var e = s.srs[q];
      if (!e || typeof e !== "object" || !sanitizeDate(e.due)) { delete s.srs[q]; return; }
      if (typeof e.iv !== "number" || !(e.iv >= 1)) e.iv = 1;
    });
    var t = dstr();
    s.weak.forEach(function (q) {
      if (!s.srs[q]) s.srs[q] = { iv: 1, due: t };
    });
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
    var ids = QUEST_POOL.filter(function (q) {
      // 復習キューが空の日にreview1を割り当てると達成不能になるため候補から除外
      return q.id !== "review1" || reviewCount() > 0;
    }).map(function (q) { return q.id; });
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
    if (n > 0) {
      var t = dstr();
      state.xpDays[t] = (state.xpDays[t] || 0) + n;
      pruneXpDays();
      note = touchStreak(t);
    }
    return note;
  }
  function pruneXpDays() {
    var keys = Object.keys(state.xpDays).filter(sanitizeDate).sort();
    while (keys.length > 30) { delete state.xpDays[keys[0]]; keys.shift(); }
  }
  function touchStreak(t) {
    var note = null;
    var counted = false; // 今日を新規カウントしたか
    if (state.lastStudyDate === t) {
      // 今日はカウント済み
    } else if (!state.lastStudyDate) {
      state.streak = state.streak > 0 ? state.streak + 1 : 1; // v1引継ぎ分は継続扱い
      counted = true;
    } else {
      var diff = dayDiff(state.lastStudyDate, t);
      if (diff <= 0) {
        // 時計が巻き戻った等 → 何もしない
      } else if (diff === 1) {
        state.streak += 1;
        counted = true;
      } else if (diff - 1 <= state.freezes) {
        state.freezes -= (diff - 1);
        state.streak += 1;
        counted = true;
        note = "🧊 ストリークフリーズを" + (diff - 1) + "個消費して連続記録を守った!";
        toast(note);
      } else {
        state.streak = 1;
        counted = true;
      }
    }
    state.lastStudyDate = t;
    if (state.streak > state.bestStreak) state.bestStreak = state.streak;
    if (state.recentDays.indexOf(t) < 0) {
      state.recentDays.push(t);
      if (state.recentDays.length > 21) state.recentDays.shift();
    }
    if (counted) {
      touchWager(t);
      if (STREAK_MILESTONES.indexOf(state.streak) >= 0) {
        toast("🎉 " + state.streak + "日連続達成!継続は力だワン!");
        sfx("fanfare");
      }
    }
    return note;
  }
  /* ---- 7日ウェイジャー ---- */
  function touchWager(t) {
    var w = state.wager;
    if (!w) return;
    if (!w.last) {
      w.done = 1; w.last = t;
    } else {
      var d = dayDiff(w.last, t);
      if (d === 0) return;
      if (d === 1) { w.done += 1; w.last = t; }
      else { state.wager = null; return; } // 途切れ: ペナルティなしで宣言消滅
    }
    if (w.done >= 7) {
      state.wager = null;
      state.stats.wagersWon = (state.stats.wagersWon || 0) + 1;
      addXP(100);
      toast("🎌 ウェイジャー達成!7日連続 +100XP!");
      sfx("fanfare");
    }
  }
  function startWager() {
    if (state.wager) { toast("すでに宣言中だワン!"); return; }
    var t = dstr();
    state.wager = { start: t, done: 0, last: null };
    // 今日すでに学習済みなら1日目としてカウント
    if (state.lastStudyDate === t) { state.wager.done = 1; state.wager.last = t; }
    toast("🎌 7日連続を宣言した!達成で+100XPだワン!");
    save();
    render();
  }
  // 起動時: 放置でウェイジャーが途切れていたら静かに消す
  function expireWager() {
    var w = state.wager;
    if (!w) return;
    var t = dstr();
    var anchor = w.last || w.start;
    if (dayDiff(anchor, t) > 1) state.wager = null;
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

  /* ---- 弱点キュー + SRS ---- */
  function addWeak(qid) {
    if (state.weak.indexOf(qid) < 0) {
      state.weak.push(qid);
      if (state.weak.length > 60) state.weak.shift();
    }
  }
  function removeWeak(qid) {
    state.weak = state.weak.filter(function (q) { return q !== qid; });
  }
  // 不正解: 期日=翌日・間隔リセット
  function srsFail(qid) {
    state.srs[qid] = { iv: 1, due: addDays(dstr(), 1) };
    addWeak(qid);
  }
  // 復習で正解: 間隔を1→3→7→18→30と伸ばす。30で正解したら卒業(キューから外す)
  function srsPass(qid) {
    removeWeak(qid);
    var e = state.srs[qid];
    if (!e) return;
    var cur = +e.iv || 1;
    if (cur >= SRS_STEPS[SRS_STEPS.length - 1]) { delete state.srs[qid]; return; }
    var next = SRS_STEPS[SRS_STEPS.length - 1];
    for (var i = 0; i < SRS_STEPS.length; i++) {
      if (SRS_STEPS[i] > cur) { next = SRS_STEPS[i]; break; }
    }
    e.iv = next;
    e.due = addDays(dstr(), next);
  }
  function dueQids() {
    var t = dstr();
    return Object.keys(state.srs)
      .filter(function (q) { return state.srs[q].due <= t; })
      .sort(function (a, b) { return state.srs[a].due < state.srs[b].due ? -1 : 1; });
  }
  // 復習対象の総数(期日到来 + srs未登録の旧weak)
  function reviewCount() {
    var due = dueQids();
    var extra = state.weak.filter(function (q) { return !state.srs[q]; });
    return due.length + extra.length;
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
  // インターリーブ: 同一ユニットの問題が連続しないよう並べ替え(spec/RESEARCH-engagement.md §3.3)
  function unitOfQid(qid) { return String(qid).split(":")[0]; }
  function interleaveItems(items) {
    var arr = items.slice();
    for (var i = 1; i < arr.length; i++) {
      if (unitOfQid(arr[i].qid) !== unitOfQid(arr[i - 1].qid)) continue;
      for (var j = i + 1; j < arr.length; j++) {
        if (unitOfQid(arr[j].qid) !== unitOfQid(arr[i - 1].qid)) {
          var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
          break;
        }
      }
    }
    return arr;
  }

  /* ---- 解放ロジック(v5: トラック独立) ---- */
  function starOf(u, l) { return state.stars[UNITS[u].id + ":" + l] || 0; }
  function unitUnlocked(u) {
    var unit = UNITS[u];
    if (!unit) return false;
    var tid = trackOf(unit);
    var list = TRACK_UNITS[tid] || [];
    var pos = list.indexOf(u);
    if (pos <= 0) return true; // 各トラックの先頭ユニットは常に解放
    if (state.trackUnlocked && state.trackUnlocked[tid]) return true; // 実力診断合格で全解放
    var prevIdx = list[pos - 1];
    var prev = UNITS[prevIdx];
    if (!prev || !(prev.lessons || []).length) return true; // 欠落ユニットは飛ばす
    return prev.lessons.every(function (_, i) { return starOf(prevIdx, i) >= 1; });
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
      startAt: Date.now(), paces: [],
      diagTrack: null,
      earnBackStreak: null, earnBackDate: null,
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
    state.lastTrack = trackOf(unit); // 「続きから」用に最後にプレイしたトラックを記録
    session = makeSession("lesson", list, u, l);
    ensureDaily();
    view = "session";
    render();
  }
  function unlockedPool() {
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
    return pool;
  }
  function startDaily() {
    ensureDaily();
    if (state.daily.deliveryDone) { toast("今日の配送便は納品済み!また明日だワン"); return; }
    var pool = unlockedPool();
    if (!pool.length) { toast("まずは最初のレッスンから始めよう!"); return; }
    // SRS期日到来の復習問題を1〜2問混ぜる(V5追補3)
    var revItems = dueQids().map(resolveQid).filter(Boolean).slice(0, 2).map(function (w) {
      return { ex: w.ex, qid: w.qid, isReview: true };
    });
    var revIds = revItems.map(function (w) { return w.qid; });
    var rest = shuffle(pool.filter(function (p) { return revIds.indexOf(p.qid) < 0; }));
    var list = interleaveItems(shuffle(revItems.concat(rest).slice(0, 5)));
    session = makeSession("daily", list);
    session.dailyDate = state.daily.date; // 日付跨ぎ完了時に翌日分を消費しないための記録
    view = "session";
    render();
  }
  function startReview() {
    ensureDaily();
    // 期日到来分を優先し、旧weak(srs未登録)で補充、最大7問(V5追補3)
    var due = dueQids();
    var extra = shuffle(state.weak.filter(function (q) { return due.indexOf(q) < 0 && !state.srs[q]; }));
    var qids = due.concat(extra).slice(0, 7);
    var items = qids.map(resolveQid).filter(Boolean).map(function (w) {
      return { ex: w.ex, qid: w.qid, isReview: true };
    });
    if (!items.length) { toast("復習キューは空だ!素晴らしいワン!"); return; }
    session = makeSession("review", interleaveItems(items));
    view = "session";
    render();
  }
  /* ---- 実力診断(V5追補6) ---- */
  function startDiagnosis(tid) {
    var idxs = TRACK_UNITS[tid] || [];
    var pool = [];
    idxs.forEach(function (u) {
      var unit = UNITS[u];
      (unit.lessons || []).forEach(function (ls, l) {
        (ls.exercises || []).forEach(function (ex, e) {
          pool.push({ ex: ex, qid: unit.id + ":" + l + ":" + e });
        });
      });
    });
    if (!pool.length) { toast("このトラックの問題がまだ無いワン"); return; }
    // mc/fill中心(typeは足りない場合のみ補充)
    var noType = pool.filter(function (p) { return p.ex.type !== "type"; });
    var typeOnly = pool.filter(function (p) { return p.ex.type === "type"; });
    var picked = shuffle(noType).slice(0, 8);
    if (picked.length < 8) picked = picked.concat(shuffle(typeOnly).slice(0, 8 - picked.length));
    var list = interleaveItems(shuffle(picked));
    session = makeSession("diag", list);
    session.diagTrack = tid;
    ensureDaily();
    view = "session";
    render();
  }
  /* ---- Earn-Back復元チャレンジ(V5追補4) ---- */
  function startEarnBack() {
    if (!state.earnBack || state.earnBack.date !== dstr()) {
      state.earnBack = null;
      toast("復元チャレンジの期限は切断当日までだワン…");
      save(); render();
      return;
    }
    var due = dueQids();
    var extra = state.weak.filter(function (q) { return due.indexOf(q) < 0; });
    var qids = due.concat(shuffle(extra)).slice(0, 5);
    var items = qids.map(resolveQid).filter(Boolean).map(function (w) {
      return { ex: w.ex, qid: w.qid, isReview: true };
    });
    if (items.length < 5) {
      // 復習在庫が足りなければ解放済みプールから補充
      var ids = items.map(function (w) { return w.qid; });
      var fillers = shuffle(unlockedPool().filter(function (p) { return ids.indexOf(p.qid) < 0; })).slice(0, 5 - items.length);
      items = items.concat(fillers);
    }
    if (!items.length) { toast("まだ問題がないワン。まずはレッスンから!"); return; }
    // 復元権はセッション開始時に消費する(中断・リロードでの再挑戦を防ぐ「1回/切断」の保証)
    var eb = state.earnBack;
    state.earnBack = null;
    save();
    session = makeSession("earnback", interleaveItems(items));
    session.earnBackStreak = eb.streak;
    session.earnBackDate = eb.date;
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
    var isDiag = s.kind === "diag"; // 診断はXP・★の対象外なのでクエストカウンターも進めない
    state.stats.answers++;
    if (s.kind === "daily") s.paces.push(Date.now() - s.startAt); // ゴースト用ペース記録
    if (ok) {
      s.correct++;
      s.combo++;
      if (s.combo > s.maxCombo) s.maxCombo = s.combo;
      if (!isDiag && s.combo > c.combo) c.combo = s.combo;
      if (ex.type === "type") { state.stats.type++; if (!isDiag) c.type++; }
      else if (ex.type === "fill") { state.stats.fill++; if (!isDiag) c.fill++; }
      else state.stats.mc++;
      var base = XP_BASE[ex.type] || 10;
      var mult = s.combo >= 5 ? 2 : s.combo >= 3 ? 1.5 : 1;
      var gained = Math.ceil(base * mult);
      s.base += base;
      s.extra += gained - base;
      if (s.hintUsed) s.hintPen += 5;
      if (it.isReview) srsPass(it.qid); // SRS: 復習正解 → 間隔を伸ばす
      sfx("correct");
    } else {
      s.combo = 0;
      srsFail(it.qid); // SRS: 不正解 → 翌日期日でキュー登録(weakにも追加)
      sfx("wrong");
    }
    if (!isDiag) checkQuests(); // カウンター更新直後に達成判定(セッション中断でも取り逃さない)
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

  function judgeLevel(correct, total) {
    var r = total ? correct / total : 0;
    if (r >= 1) return "師範代級!このトラックは目をつぶっても運べるワン!";
    if (correct >= 7 || r >= 0.875) return "有段者レベル!基礎はもう身についているワン!";
    if (r >= 0.6) return "中堅レベル。要点の再確認で一気に伸びるワン!";
    if (r >= 0.35) return "若手レベル。順番にレッスンを進めるのが近道だワン。";
    return "入門レベル。焦らず最初のユニットから積み込もうワン!";
  }

  function finishSession() {
    var s = session;
    var total = s.list.length, correct = s.correct;
    var perfect = total > 0 && correct === total;

    /* ---- 実力診断: XP/★なし・解放のみ(V5追補6) ---- */
    if (s.kind === "diag") {
      var need = total >= 8 ? 7 : Math.max(1, total - 1);
      var passed = correct >= need;
      var tm = trackMeta(s.diagTrack);
      var already = !!state.trackUnlocked[s.diagTrack];
      if (passed) state.trackUnlocked[s.diagTrack] = state.trackUnlocked[s.diagTrack] || dstr();
      s.summary = {
        diag: true, track: s.diagTrack, trackName: tm.icon + " " + tm.name,
        passed: passed, need: need, correct: correct, total: total,
        level: judgeLevel(correct, total),
        unlockedNow: passed && !already,
        lines: [], totalXP: 0, star: 0, firstClear: false, perfect: perfect,
        promoted: null, freezeNote: null
      };
      checkBadges();
      save();
      view = "result";
      render();
      sfx(passed ? "fanfare" : "jingle");
      if (passed) confettiBurst(140);
      return;
    }

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
    if (s.kind === "review" || s.kind === "earnback") { c.reviews++; state.stats.reviews++; }

    /* ---- デイリー: 自己ベスト更新判定(V5追補5) ---- */
    var newBest = false;
    if (s.kind === "daily") {
      // 開始時と同じ日付のときだけ本日分を消費(日付跨ぎ完了で翌日便を封鎖しない)
      if (state.daily.date === s.dailyDate) state.daily.deliveryDone = true;
      state.stats.deliveries++;
      var timeMs = Date.now() - s.startAt;
      var b = state.dailyBest;
      if (!b || correct > b.correct || (correct === b.correct && timeMs < b.timeMs)) {
        state.dailyBest = { date: dstr(), correct: correct, total: total, timeMs: timeMs, paces: s.paces.slice() };
        newBest = true;
      }
    }
    if (perfect) { c.perfects++; state.stats.perfects++; }

    /* ---- Earn-Back: 全問正解でストリーク復元(V5追補4) ---- */
    var restored = 0, restoreFailed = false;
    if (s.kind === "earnback") {
      // 権利は開始時に消費済み(startEarnBack)。セッションが保持する権利で判定する
      if (perfect && typeof s.earnBackStreak === "number" && s.earnBackDate === dstr()) {
        state.streak = s.earnBackStreak + 1; // 前日までの記録+今日
        if (state.streak > state.bestStreak) state.bestStreak = state.streak;
        restored = state.streak;
      } else {
        restoreFailed = true; // 1回/切断: 失敗でも権利消滅
      }
      state.earnBack = null; // 念のため(通常は開始時にnull済み)
    }

    var h = nowDate().getHours();
    if (h >= 22) state.stats.night = true;
    if (h < 7) state.stats.early = true;

    s.summary = {
      lines: lines, totalXP: totalXP, correct: correct, total: total,
      star: star, firstClear: firstClear, perfect: perfect,
      promoted: beltAfter.idx > beltBefore ? beltAfter.name : null,
      freezeNote: freezeNote,
      newBest: newBest, restored: restored, restoreFailed: restoreFailed
    };
    checkQuests();
    checkBadges();
    save();
    view = "result";
    render();
    sfx(s.summary.promoted || restored ? "fanfare" : "jingle");
    confettiBurst(s.summary.promoted || restored ? 160 : perfect ? 110 : 70);
  }

  function goHome() {
    session = null;
    view = "home";
    render();
  }

  /* ================= 描画 ================= */
  var lastRenderedView = null; // スクロール制御用: 直前に描画したview
  var homeScrollY = 0;         // ホームのスクロール位置(復帰時に復元)
  function render() {
    try {
      var viewChanged = view !== lastRenderedView;
      // ホームを離れる前にスクロール位置を退避(innerHTML差し替えで失われるため)
      if (viewChanged && lastRenderedView === "home") {
        try { homeScrollY = window.pageYOffset || document.documentElement.scrollTop || 0; } catch (eS) {}
      }
      if (view !== "result") stopConfetti(); // 結果画面以外へ遷移したら紙吹雪を打ち切る
      if (view === "home") renderHome();
      else if (view === "lesson") renderLesson();
      else if (view === "session") renderSession();
      else if (view === "result") renderResult();
      else if (view === "profile") renderProfile();
      else if (view === "settings") renderSettings();
      else if (view === "dict") renderDict();
      else if (view === "cert") renderCert();
      else if (view === "onboard") renderOnboard();
      else renderHome();
      // viewが切り替わったときのみスクロールを調整(セッション中の再描画では動かさない)
      if (viewChanged) {
        try {
          if (view === "home") window.scrollTo(0, homeScrollY);
          else window.scrollTo(0, 0);
        } catch (eS2) {}
      }
      lastRenderedView = view;
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
  function miniRingHTML(pct, label) {
    var dash = Math.min(100, Math.round(pct * 1000) / 10);
    return '<svg class="ring mini" viewBox="0 0 40 40" role="img" aria-label="' + esc(label) + " " + Math.round(pct * 100) + '%">' +
      '<circle class="ring-bg" cx="20" cy="20" r="15.9"></circle>' +
      '<circle class="ring-fg" cx="20" cy="20" r="15.9" stroke-dasharray="' + dash + ' 100"></circle>' +
      '<text x="20" y="23" text-anchor="middle">' + Math.round(pct * 100) + "%</text></svg>";
  }
  function codeBlock(code, lang, extraClass) {
    var html;
    try { html = DojoEditor.highlight(code, lang || "dax"); }
    catch (e) { html = esc(code); }
    return '<pre class="code' + (extraClass ? " " + extraClass : "") + '">' + html + "</pre>";
  }
  function shibaHomeLine() {
    // 経過日数連動セリフを最優先(V5追補4)
    if (visitGap >= 2) {
      var pool2 = visitGap >= 8 ? SHIBA.back8 : visitGap >= 4 ? SHIBA.back4 : SHIBA.back2;
      return pool2[hashStr(dstr() + "|back") % pool2.length].replace("{n}", visitGap);
    }
    var pool = SHIBA.home.slice();
    if (state.streak >= 3) pool.push("🔥" + state.streak + "日連続!良い流れだワン!");
    if (state.daily && !state.daily.deliveryDone) pool.push("今日の配送便、まだ積み込みが済んでないぞ。");
    var rc = reviewCount();
    if (rc >= 3) pool.push("復習便が" + rc + "件待機中。再配達に行くワン!");
    if (state.wager) pool.push("🎌 ウェイジャー挑戦中!" + (state.wager.done || 0) + "/7日、油断するなワン!");
    return pool[hashStr(dstr() + "|shiba") % pool.length];
  }

  /* ---- ホーム(パス画面) ---- */
  function trackProgress(tid) {
    var idxs = TRACK_UNITS[tid] || [];
    var total = 0, done = 0;
    idxs.forEach(function (u) {
      (UNITS[u].lessons || []).forEach(function (_, l) {
        total++;
        if (starOf(u, l) >= 1) done++;
      });
    });
    return { total: total, done: done, pct: total ? done / total : 0 };
  }
  // 「現在地」トラック: 最後にプレイしたトラック > 進行中トラック > 先頭トラック
  function currentTrack() {
    if (state.lastTrack && (TRACK_UNITS[state.lastTrack] || []).length) return state.lastTrack;
    for (var i = 0; i < TRACKS.length; i++) {
      var tid = TRACKS[i].id;
      if (!(TRACK_UNITS[tid] || []).length) continue;
      var pr = trackProgress(tid);
      if (pr.done > 0 && pr.done < pr.total) return tid;
    }
    for (var j = 0; j < TRACKS.length; j++) {
      if ((TRACK_UNITS[TRACKS[j].id] || []).length) return TRACKS[j].id;
    }
    var keys = Object.keys(TRACK_UNITS);
    return keys.length ? keys[0] : null;
  }
  // 初回のみ: 現在地トラック以外をデフォルト折りたたみ(以降はユーザー操作を尊重)
  function ensureCollapsedDefault() {
    if (state.collapsedInit) return;
    state.collapsedInit = true;
    if (Object.keys(state.collapsed).length === 0) {
      var act = currentTrack();
      Object.keys(TRACK_UNITS).forEach(function (tid) {
        if (tid !== act) state.collapsed[tid] = true;
      });
    }
    save();
  }
  // 「▶ 続きから」: 現在地トラックを展開し、最初の未クリアノードへスクロール
  function continueFromLast() {
    var act = currentTrack();
    if (!act) return;
    if (state.collapsed[act]) {
      state.collapsed[act] = false;
      save();
      render();
    }
    try {
      var sec = appEl.querySelector('.track[data-track="' + act + '"]');
      var node = (sec && sec.querySelector(".node.next")) || appEl.querySelector(".node.next");
      if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
      else if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {}
  }
  function renderHome() {
    ensureDaily();
    ensureCollapsedDefault(); // 初回は現在地トラック以外を折りたたむ(v5-ux: 迷子防止)
    checkQuests(); // 到達済みで未クレームのクエストをホーム表示時にも回収
    var belt = beltOf(state.xp);
    var goal = +state.settings.dailyGoal || 60;
    var xpToday = state.xpDate === dstr() ? state.xpToday : 0;
    var rc = reviewCount();
    var h = "";
    h += '<header class="topbar">' +
      '<span class="stat" title="連続学習日数">🔥<b>' + state.streak + "</b></span>" +
      (state.freezes ? '<span class="stat" title="ストリークフリーズ">🧊<b>' + state.freezes + "</b></span>" : "") +
      '<span class="stat">⭐<b>' + state.xp + "</b>XP</span>" +
      '<span class="belt">' + esc(belt.name) + "</span>" +
      ringHTML(Math.min(1, xpToday / goal), xpToday, goal) +
      "</header>";
    h += '<div class="mascot"><span class="m-dog" aria-hidden="true">🐕‍🦺</span><div class="bubble">' +
      (state.nickname ? esc(state.nickname) + "、" : "") + esc(shibaHomeLine()) + "</div></div>";
    // Earn-Back復元バナー(切断当日のみ)
    if (state.earnBack && state.earnBack.date === dstr()) {
      h += '<div class="banner earnback">🚑 ストリーク(🔥' + state.earnBack.streak + '日)が切れた!今日中なら復元できる!' +
        '<button class="btn" data-action="earnback">復元チャレンジ(5問全問正解)</button></div>';
    }
    // ウェイジャーバナー
    if (state.wager) {
      h += '<div class="banner wager">🎌 7日ウェイジャー挑戦中: <b>' + (state.wager.done || 0) + '/7日</b> 達成で+100XP!</div>';
    } else if (state.xp > 0) {
      h += '<div class="banner wager-offer">🎌 「7日連続でやる」と宣言して自分を追い込む?' +
        '<button class="btn ghost" data-action="wager-start">宣言する(達成+100XP)</button></div>';
    }
    var bestLine = state.dailyBest
      ? '<small class="best-line">🏁 自己ベスト ' + state.dailyBest.correct + "/" + state.dailyBest.total + "問・" + fmtTime(state.dailyBest.timeMs) + "</small>"
      : "";
    h += '<div class="actions">' +
      '<button class="btn" data-action="continue">▶ 続きから</button>' +
      '<button class="btn" data-action="daily"' + (state.daily.deliveryDone ? " disabled" : "") + ">⚔️ 今日の配送便" + (state.daily.deliveryDone ? " ✅" : "") + bestLine + "</button>" +
      '<button class="btn ghost" data-action="review"' + (rc ? "" : " disabled") + ">📝 復習" + (rc ? ' <span class="due-badge">' + rc + "</span>" : "(0問)") + "</button>" +
      '<button class="btn ghost" data-action="dict">📚 関数辞典</button>' +
      '<button class="btn ghost" data-action="profile">👤 プロフィール</button>' +
      '<button class="btn ghost" data-action="cert">📜 認定証</button>' +
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
  /* v5: トラック大見出し→ユニット→レッスンノード(一括innerHTML+イベント委譲) */
  function pathHTML() {
    if (!UNITS.length) return '<div class="card">教材データが見つからないワン…(units未読込)</div>';
    var h = "";
    var seen = {};
    var order = TRACKS.map(function (t) { return t.id; });
    Object.keys(TRACK_UNITS).forEach(function (tid) {
      if (order.indexOf(tid) < 0) order.push(tid); // 未知トラックも末尾に表示
    });
    order.forEach(function (tid) {
      var idxs = TRACK_UNITS[tid];
      if (!idxs || !idxs.length || seen[tid]) return;
      seen[tid] = true;
      var tm = trackMeta(tid);
      var pr = trackProgress(tid);
      var collapsed = !!state.collapsed[tid];
      h += '<section class="track' + (collapsed ? " collapsed" : "") + '" data-track="' + esc(tid) + '">';
      h += '<button class="track-head" data-action="track-toggle" data-t="' + esc(tid) + '" aria-expanded="' + (!collapsed) + '">' +
        '<span class="t-icon">' + tm.icon + "</span>" +
        '<span class="t-name">' + esc(tm.name) + "</span>" +
        '<span class="t-prog">' + pr.done + "/" + pr.total + "(" + Math.round(pr.pct * 100) + "%)</span>" +
        '<span class="t-arrow">' + (collapsed ? "▸" : "▾") + "</span></button>";
      if (!collapsed) {
        h += '<div class="track-body">';
        if (tm.diag) {
          h += '<div class="diag-row"><button class="btn ghost diag-btn" data-action="diag" data-t="' + esc(tid) + '">⚡ 実力診断(8問・7問正解で全解放)</button>' +
            (state.trackUnlocked[tid] ? '<span class="diag-ok">✅ 診断合格済み(全ユニット解放)</span>' : "") + "</div>";
        }
        idxs.forEach(function (u) { h += unitHTML(u); });
        h += "</div>";
      }
      h += "</section>";
    });
    return h;
  }
  function unitHTML(u) {
    var unit = UNITS[u];
    var uOpen = unitUnlocked(u);
    var h = '<section class="unit' + (uOpen ? "" : " locked") + '">' +
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
  var KIND_LABEL = {
    daily: "⚔️ 今日の配送便", review: "📝 復習", diag: "⚡ 実力診断",
    earnback: "🚑 復元チャレンジ", lesson: "🎯 演習"
  };
  function renderSession() {
    var s = session;
    if (!s) { goHome(); return; }
    var ex = currentEx();
    if (!ex) { finishSession(); return; }
    var pct = Math.round(((s.i + (s.answered ? 1 : 0)) / s.list.length) * 100);
    var kindLabel = KIND_LABEL[s.kind] || KIND_LABEL.lesson;
    // ゴーストペース(V5追補5): 前回ベストが今の経過時間で何問目相当かを🏁で表示
    var ghost = "";
    var ghostInfo = "";
    if (s.kind === "daily" && state.dailyBest && (state.dailyBest.paces || []).length) {
      var elMs = Date.now() - s.startAt;
      var g = 0;
      state.dailyBest.paces.forEach(function (p) { if (p <= elMs) g++; });
      var gp = Math.min(100, Math.round((g / s.list.length) * 100));
      ghost = '<span class="ghost-flag" style="left:' + gp + '%" title="前回ベストのペース(' + g + '問目相当)">🏁</span>';
      ghostInfo = '<div class="ghost-info">🏁 自己ベスト ' + state.dailyBest.correct + "/" + state.dailyBest.total +
        "問・" + fmtTime(state.dailyBest.timeMs) + "(ゴースト: " + g + "問目相当)</div>";
    }
    var h = '<header class="s-head">' +
      '<button class="icon-btn" data-action="abort" aria-label="中断">✕</button>' +
      '<div class="p-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i>' + ghost + "</div>" +
      (s.combo >= 2 ? '<span class="combo">🔥×' + s.combo + "</span>" : '<span class="combo dim">' + kindLabel + "</span>") +
      "</header>";
    h += ghostInfo;
    h += '<div class="ex-card' + (s.answered ? (s.lastOk ? " pop" : " shake") : "") + '">';
    h += '<div class="ex-no">問題 ' + (s.i + 1) + " / " + s.list.length +
      (s.list[s.i].isReview ? ' <span class="rev-tag">📝 復習</span>' : "") + "</div>";
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
    if (!ok) h += '<div class="fb-exp"><small>📝 この問題は明日の復習便に積んだワン(「復習」から再挑戦できるぞ)</small></div>';
    h += '<button class="btn" data-action="next">次へ ▶</button></div>';
    return h;
  }

  /* ---- 結果画面 ---- */
  function renderResult() {
    var s = session;
    if (!s || !s.summary) { goHome(); return; }
    var m = s.summary;
    var h = '<div class="result card">';
    /* 実力診断の結果 */
    if (m.diag) {
      h += '<div class="r-shiba">🐕‍🦺「診断完了!実力を見せてもらったワン!」</div>';
      h += "<h1>⚡ 実力診断: " + esc(m.trackName) + "</h1>";
      h += '<div class="r-score">正解 ' + m.correct + " / " + m.total + "(合格ライン " + m.need + "問)</div>";
      h += '<div class="diag-level">あなたは──<b>' + esc(m.level) + "</b></div>";
      if (m.passed) {
        h += '<div class="promo">🔓 トラック内の全ユニットを解放した!' + (m.unlockedNow ? "" : "(解放済み)") + "</div>";
      } else {
        h += '<div class="fb-exp">あと' + (m.need - m.correct) + "問。順番にレッスンを進めてまた挑戦するワン(何度でも受け直せる)</div>";
      }
      h += '<div class="fb-exp"><small>※診断はXP・★の対象外(解放のみ)</small></div>';
      h += '<button class="btn big" data-action="home">ホームへ</button></div>';
      appEl.innerHTML = h;
      return;
    }
    var lineH = m.lines.map(function (l) {
      return '<div class="xp-line"><span>' + esc(l[0]) + "</span><b>" + (l[1] >= 0 ? "+" : "") + l[1] + "XP</b></div>";
    }).join("");
    h += '<div class="r-shiba">🐕‍🦺「' + esc(pick(SHIBA.result)) + "」</div>";
    h += "<h1>" + (m.perfect ? "💮 パーフェクト!" : m.correct > 0 ? "🚚 納品完了!" : "🌧 今日は荒れ模様…") + "</h1>";
    h += '<div class="r-score">正解 ' + m.correct + " / " + m.total +
      (s.kind === "lesson" ? " " + starsHTML(m.star) : "") + "</div>";
    h += '<div class="xp-lines">' + lineH +
      '<div class="xp-line total"><span>合計</span><b>+' + m.totalXP + "XP</b></div></div>";
    if (m.promoted) h += '<div class="promo">🎉 昇段! <b>' + esc(m.promoted) + "</b> になった!</div>";
    if (m.restored) h += '<div class="promo">🚑 ストリーク復元成功!🔥' + m.restored + "日として再開!</div>";
    if (m.restoreFailed) h += '<div class="r-freeze">🚑 復元ならず…今日からまた積み上げるワン(🔥1日目)</div>';
    if (m.newBest) h += '<div class="promo best">🏁 デイリー自己ベスト更新! ' + m.correct + "/" + m.total + "問・" + fmtTime(state.dailyBest.timeMs) + "</div>";
    h += '<div class="r-streak">🔥 連続' + state.streak + "日" + (state.freezes ? " 🧊×" + state.freezes : "") + "</div>";
    if (m.freezeNote) h += '<div class="r-freeze">' + esc(m.freezeNote) + "</div>";
    h += '<button class="btn big" data-action="home">ホームへ</button></div>';
    appEl.innerHTML = h;
  }

  /* ---- プロフィール ---- */
  function statBox(label, val) {
    return '<div class="sbox"><b>' + val + "</b><span>" + esc(label) + "</span></div>";
  }
  /* 直近14日XPバー(CSS自前描画・V5追補5/10) */
  function xpChartHTML() {
    var days = [];
    var t = dstr();
    for (var i = 13; i >= 0; i--) days.push(addDays(t, -i));
    var max = 1;
    days.forEach(function (d) { max = Math.max(max, state.xpDays[d] || 0); });
    var cols = days.map(function (d, i) {
      var v = state.xpDays[d] || 0;
      var hh = v ? Math.max(6, Math.round((v / max) * 100)) : 2;
      var lab = i === 0 || i === 13 ? d.slice(5).replace("-", "/") : "";
      return '<div class="xpc-col" title="' + esc(d) + ": " + v + 'XP">' +
        '<i style="height:' + hh + '%" class="' + (v ? "" : "zero") + '"></i>' +
        '<small>' + lab + "</small></div>";
    }).join("");
    return '<div class="xp-chart" role="img" aria-label="直近14日のXP推移">' + cols + "</div>";
  }
  function renderProfile() {
    var belt = beltOf(state.xp);
    var h = '<header class="sub-head"><button class="icon-btn" data-action="home" aria-label="戻る">←</button><h1>👤 プロフィール</h1></header>';
    h += '<div class="card prof-top">' +
      (state.nickname ? '<div class="nick">' + esc(state.nickname) + "</div>" : "") +
      '<div class="belt-big">' + esc(belt.name) + "</div>" +
      "<div>⭐" + state.xp + "XP" + (belt.next ? "(次の" + esc(belt.next) + "まで あと" + (belt.nextXp - state.xp) + "XP)" : "") + "</div>" +
      "<div>🔥 連続" + state.streak + "日(最高" + state.bestStreak + "日) 🧊フリーズ×" + state.freezes + "</div></div>";
    /* 直近14日XP */
    h += '<section class="card"><h2>📈 直近14日のXP</h2>' + xpChartHTML() + "</section>";
    /* 自己ベスト */
    h += '<section class="card"><h2>🏁 自己ベスト</h2>';
    if (state.dailyBest) {
      h += '<div class="best-row">⚔️ 今日の配送便: <b>' + state.dailyBest.correct + "/" + state.dailyBest.total +
        "問</b>・" + fmtTime(state.dailyBest.timeMs) + " <small>(" + esc(state.dailyBest.date) + ")</small></div>";
    } else {
      h += '<div class="best-row"><small>まだ記録なし。配送便に挑戦して自己ベストを作ろう!</small></div>';
    }
    h += '<div class="best-row">🔥 最長ストリーク: <b>' + state.bestStreak + "日</b></div></section>";
    /* 統計 */
    h += '<section class="card"><h2>📊 統計</h2><div class="stat-grid">' +
      statBox("総回答数", state.stats.answers) +
      statBox("type正解", state.stats.type) +
      statBox("fill正解", state.stats.fill) +
      statBox("パーフェクト", state.stats.perfects) +
      statBox("復習完了", state.stats.reviews) +
      statBox("配送便", state.stats.deliveries) +
      statBox("最長ストリーク", state.bestStreak) +
      statBox("復習待ち", reviewCount()) +
      statBox("ウェイジャー達成", state.stats.wagersWon || 0) +
      "</div>";
    /* トラック別進捗リング(V5追補10) */
    h += '<div class="track-rings">' + TRACKS.map(function (tm) {
      if (!(TRACK_UNITS[tm.id] || []).length) return "";
      var pr = trackProgress(tm.id);
      return '<div class="t-ring">' + miniRingHTML(pr.pct, tm.name) +
        '<small>' + tm.icon + " " + esc(tm.name) + "</small></div>";
    }).join("") + "</div>";
    /* ユニット別進捗 */
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

  /* ---- 関数辞典(V5追補2) ---- */
  function dictData() {
    var d = window.DOJO_DICT;
    return Array.isArray(d) ? d : []; // 別担当が並行実装中: 無くても動く
  }
  function dictListHTML() {
    var q = (viewCtx.dictQ || "").toLowerCase();
    var lf = viewCtx.dictLang || "all";
    var all = dictData();
    if (!all.length) return '<div class="card"><p>📦 辞典データを積み込み中…(dictionary.js 未搭載でも他機能は使えるワン)</p></div>';
    var list = all.filter(function (e) {
      if (!e || typeof e !== "object") return false;
      if (lf !== "all" && e.lang !== lf) return false;
      if (!q) return true;
      return (String(e.name || "").toLowerCase().indexOf(q) >= 0 ||
              String(e.desc || "").toLowerCase().indexOf(q) >= 0);
    });
    if (!list.length) return '<div class="card"><p>「' + esc(viewCtx.dictQ || "") + '」に一致する関数は見つからないワン。</p></div>';
    // 検索時は 名前前方一致 > 名前部分一致 > 説明マッチ の順に並べ替え(同点は元の順を維持)
    if (q) {
      var dictScore = function (e) {
        var name = String(e.name || "").toLowerCase();
        if (name.indexOf(q) === 0) return 3;
        if (name.indexOf(q) >= 0) return 2;
        return 1; // filter通過済み = 説明マッチ
      };
      list = list.map(function (e, i) { return { e: e, i: i, s: dictScore(e) }; })
        .sort(function (a, b) { return b.s - a.s || a.i - b.i; })
        .map(function (x) { return x.e; });
    }
    // cat別グループ(登場順を維持。検索時は最良ヒットを含むカテゴリが先頭になる)
    var cats = [], byCat = {};
    list.forEach(function (e) {
      var c = e.cat || "その他";
      if (!byCat[c]) { byCat[c] = []; cats.push(c); }
      byCat[c].push(e);
    });
    return cats.map(function (c) {
      var items = byCat[c].map(function (e) {
        var h = '<div class="dict-item">' +
          '<div class="d-head"><span class="d-name">' + esc(e.name) + "</span>" +
          '<span class="d-lang ' + (e.lang === "m" ? "m" : "dax") + '">' + (e.lang === "m" ? "M" : "DAX") + "</span></div>";
        if (e.syntax) h += codeBlock(e.syntax, e.lang, "d-syntax");
        if (e.desc) h += '<div class="d-desc">' + esc(e.desc) + "</div>";
        if (e.ex) h += '<div class="fb-label">例</div>' + codeBlock(e.ex, e.lang, "d-ex");
        return h + "</div>";
      }).join("");
      return '<section class="card dict-cat"><h2>' + esc(c) + " <small>(" + byCat[c].length + ")</small></h2>" + items + "</section>";
    }).join("");
  }
  function renderDict() {
    var lf = viewCtx.dictLang || "all";
    var chip = function (v, label) {
      return '<button class="chip lang-chip' + (lf === v ? " on" : "") + '" data-action="dict-lang" data-v="' + v + '">' + label + "</button>";
    };
    var h = '<header class="sub-head"><button class="icon-btn" data-action="home" aria-label="戻る">←</button><h1>📚 関数辞典</h1></header>';
    h += '<div class="dict-tools card">' +
      '<input type="search" id="dict-search" placeholder="関数名・説明で検索(例: CALCULATE)" value="' + esc(viewCtx.dictQ || "") + '" aria-label="関数を検索">' +
      '<div class="lang-chips">' + chip("all", "全部") + chip("dax", "DAX") + chip("m", "M") + "</div></div>";
    h += '<div id="dict-list">' + dictListHTML() + "</div>";
    appEl.innerHTML = h;
  }

  /* ---- 認定証(V5追補7) ---- */
  function certProgress() {
    var total = 0, done = 0;
    UNITS.forEach(function (u, ui) {
      (u.lessons || []).forEach(function (_, l) {
        total++;
        if (starOf(ui, l) >= 1) done++;
      });
    });
    return { total: total, done: done, remain: total - done };
  }
  function renderCert() {
    var h = '<header class="sub-head"><button class="icon-btn" data-action="home" aria-label="戻る">←</button><h1>📜 認定証</h1></header>';
    if (certEligible(state)) {
      h += '<div class="card cert-card"><canvas id="cert-cv" width="840" height="594" aria-label="物流データアナリスト認定証"></canvas>' +
        '<button class="btn big" data-action="cert-dl">🖨 PNGをダウンロード</button>' +
        '<p><small>おめでとう!全トラック制覇+卒業試験クリアの証だワン!</small></p></div>';
      appEl.innerHTML = h;
      var cv = appEl.querySelector("#cert-cv");
      if (cv) drawCert(cv);
      return;
    }
    var pr = certProgress();
    h += '<div class="card"><h2>🔒 まだ授与できないワン</h2>' +
      "<p>条件: <b>全トラックの全レッスン★1以上</b> + <b>卒業試験クリア</b></p>" +
      '<div class="q-bar"><i style="width:' + (pr.total ? Math.round((pr.done / pr.total) * 100) : 0) + '%"></i></div>' +
      "<p>進捗: " + pr.done + " / " + pr.total + " レッスン(あと<b>" + pr.remain + "</b>レッスン)</p>" +
      '<button class="btn" data-action="home">パスへ戻る</button></div>';
    appEl.innerHTML = h;
  }
  function drawCert(cv) {
    try {
      var ctx = cv.getContext("2d");
      if (!ctx) return;
      var W = cv.width, H = cv.height;
      ctx.fillStyle = "#fffdf6";
      ctx.fillRect(0, 0, W, H);
      // 二重枠
      ctx.strokeStyle = "#e8641b"; ctx.lineWidth = 10; ctx.strokeRect(18, 18, W - 36, H - 36);
      ctx.strokeStyle = "#a94a10"; ctx.lineWidth = 2; ctx.strokeRect(34, 34, W - 68, H - 68);
      ctx.fillStyle = "#26241f";
      ctx.textAlign = "center";
      ctx.font = "bold 30px serif";
      ctx.fillText("認 定 証", W / 2, 100);
      ctx.font = "16px serif";
      ctx.fillText("Power BI 道場 〜物流データアナリスト養成〜", W / 2, 135);
      var name = state.nickname || "名無しの修行者";
      ctx.font = "bold 40px serif";
      ctx.fillText(name + " 殿", W / 2, 220);
      ctx.font = "20px serif";
      ctx.fillText("あなたは本道場の全課程を修了し、卒業試験に合格したので", W / 2, 290);
      ctx.fillText("「物流データアナリスト認定」の称号をここに授与する", W / 2, 322);
      ctx.font = "bold 26px serif";
      ctx.fillStyle = "#e8641b";
      ctx.fillText("🏆 物流データアナリスト認定 🏆", W / 2, 390);
      ctx.fillStyle = "#26241f";
      ctx.font = "18px serif";
      ctx.fillText("達成日: " + dstr() + "   総獲得XP: " + state.xp + "   帯: " + beltOf(state.xp).name, W / 2, 450);
      ctx.font = "40px serif";
      ctx.fillText("🐕‍🦺", W / 2 + 250, 520);
      ctx.font = "16px serif";
      ctx.fillText("Power BI 道場 師範 ロジ柴", W / 2 + 250, 550);
    } catch (e) {}
  }
  function downloadCert() {
    try {
      var cv = document.getElementById("cert-cv");
      if (!cv) return;
      var a = document.createElement("a");
      a.download = "powerbi-dojo-certificate.png";
      a.href = cv.toDataURL("image/png");
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast("📜 認定証を出荷したワン!");
    } catch (e) { toast("ダウンロードに失敗…ブラウザの設定を確認してほしいワン"); }
  }

  /* ---- オンボーディング(V5追補8) ---- */
  function renderOnboard() {
    var step = viewCtx.obStep || 0;
    var h = '<div class="onboard card">';
    if (step === 0) {
      h += '<div class="ob-dog">🐕‍🦺</div><h1>ようこそ、Power BI 道場へ!</h1>' +
        "<p>ここは物流の現場データを使って DAX と M(Power Query)を鍛える道場だワン。" +
        "1日5分、レッスンと演習を積み重ねて「物流データアナリスト」を目指そう!</p>" +
        (state.xp > 0 ? '<p class="tip-mini">これまでの進捗(⭐' + state.xp + "XP)はそのまま引き継いでいるワン!</p>" : "") +
        '<button class="btn big" data-action="ob-next">はじめる 🚚</button>';
    } else if (step === 1) {
      h += '<div class="ob-dog">🐕‍🦺</div><h1>呼び名を教えてほしいワン</h1>' +
        "<p>認定証にも使うニックネームだ(あとで設定から変更できる・スキップ可)</p>" +
        '<input type="text" id="ob-nick" maxlength="16" placeholder="例: 倉庫番タロウ" value="' + esc(state.nickname || "") + '" aria-label="ニックネーム">' +
        '<div class="ob-btns"><button class="btn" data-action="ob-next">これでいく</button>' +
        '<button class="btn ghost" data-action="ob-skip">スキップ</button></div>';
    } else if (step === 2) {
      h += '<div class="ob-dog">🐕‍🦺</div><h1>1日の目標を決めよう</h1>' +
        "<p>毎日の目標XPだ。あとで設定から変えられるワン。</p>" +
        '<div class="ob-goals">' +
        '<button class="btn ghost" data-action="ob-goal" data-v="30">🌱 ゆるり<br><b>30XP/日</b></button>' +
        '<button class="btn ghost" data-action="ob-goal" data-v="60">🚚 標準<br><b>60XP/日</b></button>' +
        '<button class="btn ghost" data-action="ob-goal" data-v="100">🔥 ガチ<br><b>100XP/日</b></button></div>';
    } else {
      h += '<div class="ob-dog">🐕‍🦺</div><h1>準備完了だワン!</h1>' +
        "<p>進め方は2通り:</p>" +
        '<p>🔰 <b>初心者</b>は「📖 全体概要」トラックの最初のレッスンから。<br>' +
        '⚡ <b>経験者</b>は基礎・応用・実践トラックの「実力診断」(8問中7問正解)でユニットを一気に解放できるワン。</p>' +
        '<p class="tip-mini">間違えた問題は自動で「📝 復習」に積まれ、忘れた頃(1→3→7→18→30日)に再出題されるぞ。</p>' +
        '<button class="btn big" data-action="ob-done">道場に入る 🥋</button>';
    }
    h += "</div>";
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
    h += '<div class="set-row"><span>🏷 ニックネーム</span>' +
      '<button class="btn ghost" data-action="set-nick">' + (state.nickname ? esc(state.nickname) + " ✏️" : "設定する") + "</button></div>";
    h += '<div class="set-row"><span>🎌 7日ウェイジャー</span>' +
      (state.wager
        ? "<span>挑戦中 " + (state.wager.done || 0) + "/7日</span>"
        : '<button class="btn ghost" data-action="wager-start">7日連続を宣言(達成+100XP)</button>') + "</div>";
    h += '<div class="set-row"><span>🗑 データリセット</span>' +
      '<button class="btn danger" data-action="reset">全データを消去</button></div>';
    h += "</div>";
    h += '<div class="card about"><b>Power BI 道場 バージョン: v5</b><br>' +
      "<small>企画・教材・実装: Power BI 道場プロジェクト / マスコット: ロジ柴 🐕‍🦺<br>" +
      "学習設計はDuolingo・Anki等の継続メカニクス研究(spec/RESEARCH-engagement.md)に基づく。<br>" +
      "データはこの端末のlocalStorageにのみ保存されます。</small></div>";
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
    state.onboarded = true; // リセット直後に再オンボーディングはしない(データ消去の文脈のため)
    ensureDaily();
    save();
    toast("データをリセットしました");
    goHome();
  }
  function editNick() {
    var v = null;
    try { v = prompt("ニックネーム(16文字まで・認定証に使われます)", state.nickname || ""); } catch (e) {}
    if (v === null) return;
    state.nickname = String(v).slice(0, 16).trim();
    save();
    render();
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
            toast("🔒 直前のレッスンを★1以上でクリア(または⚡実力診断合格)で解放だワン");
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
        case "dict": viewCtx = { dictQ: "", dictLang: "all" }; view = "dict"; render(); break;
        case "dict-lang": viewCtx.dictLang = el.getAttribute("data-v") || "all"; render(); break;
        case "cert": view = "cert"; render(); break;
        case "cert-dl": downloadCert(); break;
        case "diag": startDiagnosis(el.getAttribute("data-t")); break;
        case "track-toggle": {
          var t = el.getAttribute("data-t");
          state.collapsed[t] = !state.collapsed[t];
          save(); render();
          break;
        }
        case "wager-start": startWager(); break;
        case "earnback": startEarnBack(); break;
        case "continue": continueFromLast(); break;
        case "ob-next": {
          var step = viewCtx.obStep || 0;
          if (step === 1) {
            var inp = document.getElementById("ob-nick");
            if (inp) state.nickname = String(inp.value || "").slice(0, 16).trim();
            save();
          }
          viewCtx.obStep = step + 1;
          render();
          break;
        }
        case "ob-skip": viewCtx.obStep = (viewCtx.obStep || 0) + 1; render(); break;
        case "ob-goal":
          state.settings.dailyGoal = +el.getAttribute("data-v") || 60;
          viewCtx.obStep = (viewCtx.obStep || 0) + 1;
          save(); render();
          break;
        case "ob-done":
          state.onboarded = true;
          save();
          toast("🥋 入門完了!まずは1レッスンだワン!");
          goHome();
          break;
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
        case "set-nick": editNick(); break;
        case "reset": doReset(); break;
      }
    } catch (e) {
      try { console.error(e); } catch (e2) {}
    }
  }
  // 辞典検索: リスト部分のみ差し替え(フォーカス保持)
  function onInput(ev) {
    try {
      var t = ev.target;
      if (t && t.id === "dict-search" && view === "dict") {
        viewCtx.dictQ = t.value || "";
        var list = document.getElementById("dict-list");
        if (list) list.innerHTML = dictListHTML();
      }
    } catch (e) {}
  }

  /* ================= 起動 ================= */
  function boot() {
    appEl = document.getElementById("app");
    if (!appEl) throw new Error("#app が見つかりません");
    state = loadState();
    migrateV1();
    ensureDaily();
    var today = dstr();
    // 前回訪問からの経過日数(セリフ用)
    visitGap = state.lastSeen ? Math.max(0, dayDiff(state.lastSeen, today)) : 0;
    state.lastSeen = today;
    // 途切れたストリークの遅延リセット + Earn-Back権の発行(V5追補4)
    if (state.lastStudyDate) {
      var diff = dayDiff(state.lastStudyDate, today);
      if (diff > 1 && diff - 1 > state.freezes && state.streak > 0) {
        // 切断当日(=気づいた日)に限り復元チャレンジ可。2日以上前の切断でも「今日気づいた」を起点にする
        if (state.streak >= 2) state.earnBack = { streak: state.streak, date: today };
        state.streak = 0;
      }
    }
    // 期限切れのEarn-Back権を破棄
    if (state.earnBack && state.earnBack.date !== today) state.earnBack = null;
    expireWager();
    applyTheme();
    appEl.addEventListener("click", onClick);
    appEl.addEventListener("input", onInput);
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
      // 追加フック(v2互換)
      useHint: useHint,
      surrender: surrender,
      pickChip: pickChip,
      clearSlot: clearSlot,
      ensureDaily: ensureDaily,
      checkQuests: checkQuests,
      checkBadges: checkBadges,
      render: render,
      toast: toast,
      // v5フック
      startDiagnosis: startDiagnosis,
      startEarnBack: startEarnBack,
      startWager: startWager,
      openDict: function () { viewCtx = { dictQ: "", dictLang: "all" }; view = "dict"; render(); },
      openCert: function () { view = "cert"; render(); },
      dueQids: dueQids,
      reviewCount: reviewCount,
      reload: function () { state = loadState(); migrateV1(); ensureDaily(); render(); }
    };

    view = state.onboarded ? "home" : "onboard";
    viewCtx = view === "onboard" ? { obStep: 0 } : {};
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
