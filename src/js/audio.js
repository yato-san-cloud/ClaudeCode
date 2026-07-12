/*
 * audio.js — Game.Audio: 100% synthesized WebAudio. No files, no CDN.
 *
 * Contract (architecture §9 / brief):
 *   init(ctx)                      lazy AudioContext + resume() on first gesture,
 *                                  build master/sfx/music gains from settings,
 *                                  wire bus events -> sfx.
 *   update(now)                    advance the music scheduler (look-ahead).
 *   sfx(id, opts?)                 short pleasant synth blips.
 *   playMusic(id) / stopMusic()    gentle looping pastoral pad + music-box melody.
 *   duckFor(ms)                    momentarily lower music (for jingles/UI).
 *   setVolumes({master,sfx,music}) / setMuted(bool)   mixer, from settings.
 *
 * Golden rules honored:
 *   - Single top-level assignment, no eval-time side effects.
 *   - Other sim modules referenced only inside functions (none needed here).
 *   - Reads LIVE Game.state.settings; never caches the state object.
 *   - Everything no-ops safely when WebAudio is unavailable (headless QA) — never throws.
 *   - Music melody uses a PRIVATE seeded RNG (Game.Util.makeRng) so it is
 *     deterministic yet never perturbs the sim RNG stream (state.rngState).
 */
Game.Audio = (function () {
  'use strict';
  var U = Game.Util;
  var bus = Game.bus;

  // ---- audio graph (all transient, created lazily) ----
  var ac = null;            // AudioContext
  var master = null;        // master gain -> destination
  var sfxBus = null;        // sfx gain -> master
  var musicBus = null;      // music gain (post-duck) -> master
  var noiseBuf = null;      // cached white-noise buffer
  var unavailable = false;  // true once we know WebAudio can't run (headless)
  var wired = false;        // bus/gesture listeners attached once
  var started = false;      // first-gesture resume happened
  var activeVoices = 0;     // simultaneous sfx oscillators (soft cap)
  var MAX_VOICES = 16;

  // ---- ducking ----
  var duckUntil = 0;        // ctx time until which music is ducked
  var duckAmt = 0.35;       // music multiplier while ducked

  // ---- music state ----
  var music = null;         // { id, padOsc[], padGain, filter, lfo, melodyGain,
                            //   chordIndex, nextChordTime, nextNoteTime, rng,
                            //   root, chordDur, beat, beatsLeft }
  var wantMusic = null;     // id requested before context/gesture ready

  // Chord progression: I - V - vi - IV (semitone stacks over the key root).
  var PROG = [
    [0, 4, 7, 12],   // I
    [7, 11, 14, 19], // V
    [9, 12, 16, 21], // vi
    [5, 9, 12, 17]   // IV
  ];
  var MAJOR = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16]; // scale degrees for the melody

  // Per-season key root (Hz, ~octave 3) + tempo (seconds per chord).
  var SEASON_MUSIC = {
    spring: { root: 261.63, chordDur: 3.6 }, // C
    summer: { root: 293.66, chordDur: 3.2 }, // D  (a touch brighter/faster)
    autumn: { root: 246.94, chordDur: 4.0 }, // B  (mellow)
    winter: { root: 220.00, chordDur: 4.4 }  // A  (calm, slow)
  };

  // ---------------------------------------------------------------- helpers
  function now() { return ac ? ac.currentTime : 0; }
  function semis(root, n) { return root * Math.pow(2, n / 12); }

  function settings() {
    var s = Game.state;
    return (s && s.settings) || { master: 0.8, sfx: 0.9, music: 0.5, muted: false, reduceMotion: false };
  }

  function hidden() {
    try { return typeof document !== 'undefined' && document.hidden === true; }
    catch (e) { return false; }
  }

  // Create the AudioContext + gain graph on demand. Returns true if usable.
  function ensureContext() {
    if (ac) return true;
    if (unavailable) return false;
    try {
      var AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (!AC) { unavailable = true; return false; }
      ac = new AC();
      master = ac.createGain();
      sfxBus = ac.createGain();
      musicBus = ac.createGain();
      sfxBus.connect(master);
      musicBus.connect(master);
      master.connect(ac.destination);
      applyVolumes();
      return true;
    } catch (e) {
      unavailable = true; ac = null;
      // Never let audio break the game.
      if (Game._recordError) Game._recordError('Audio.ensureContext', e);
      return false;
    }
  }

  function whiteNoise() {
    if (!ac) return null;
    if (noiseBuf) return noiseBuf;
    try {
      var len = Math.floor(ac.sampleRate * 0.4);
      noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
      var d = noiseBuf.getChannelData(0);
      // fill with a private RNG so we never touch the sim RNG stream
      for (var j = 0; j < len; j++) d[j] = whiteRng() * 2 - 1;
      return noiseBuf;
    } catch (e) { return null; }
  }
  // private RNG for noise/melody (does NOT advance Game.state.rngState)
  var whiteRng = U.makeRng ? U.makeRng(0x9E3779B1) : function () { return 0.5; };

  // Smoothly set a gain param, avoiding clicks & zero-value exponential errors.
  function ramp(param, target, t0, dur) {
    try {
      var v = Math.max(0.0001, param.value);
      param.cancelScheduledValues(t0);
      param.setValueAtTime(v, t0);
      if (target <= 0.0001) param.exponentialRampToValueAtTime(0.0001, t0 + dur);
      else param.exponentialRampToValueAtTime(target, t0 + dur);
    } catch (e) { try { param.setValueAtTime(target, t0); } catch (e2) {} }
  }

  // One short oscillator voice with an attack/decay envelope. Soft-capped.
  function voice(opts) {
    if (!ac || !sfxBus) return;
    if (activeVoices >= MAX_VOICES) return;
    try {
      var t0 = (opts.at != null ? opts.at : now());
      var type = opts.type || 'sine';
      var g = ac.createGain();
      var osc = ac.createOscillator();
      osc.type = type;

      var f0 = opts.f0 || 440;
      osc.frequency.setValueAtTime(f0, t0);
      if (opts.f1 != null) {
        // pitch glide (linear in log space feels natural but linear is fine here)
        osc.frequency.setValueAtTime(f0, t0);
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.f1), t0 + (opts.glide || (opts.dur || 0.15)));
      }
      if (opts.detune) osc.detune.setValueAtTime(opts.detune, t0);

      var peak = (opts.gain != null ? opts.gain : 0.3);
      var atk = opts.atk != null ? opts.atk : 0.006;
      var dur = opts.dur != null ? opts.dur : 0.14;

      var out = g;
      // optional lowpass shaping
      if (opts.lp) {
        var f = ac.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(opts.lp, t0);
        if (opts.lp1 != null) f.frequency.exponentialRampToValueAtTime(Math.max(60, opts.lp1), t0 + dur);
        osc.connect(f); f.connect(g);
      } else {
        osc.connect(g);
      }

      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + atk);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      out.connect(opts.bus || sfxBus);

      activeVoices++;
      osc.onended = function () { activeVoices--; try { g.disconnect(); } catch (e) {} };
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch (e) {
      if (Game._recordError) Game._recordError('Audio.voice', e);
    }
  }

  // Filtered-noise burst (for thunks / build sfx).
  function noiseBurst(opts) {
    if (!ac || !sfxBus) return;
    if (activeVoices >= MAX_VOICES) return;
    var buf = whiteNoise();
    if (!buf) return;
    try {
      var t0 = (opts.at != null ? opts.at : now());
      var src = ac.createBufferSource();
      src.buffer = buf;
      var f = ac.createBiquadFilter();
      f.type = opts.filter || 'lowpass';
      f.frequency.setValueAtTime(opts.cut || 900, t0);
      if (opts.cut1 != null) f.frequency.exponentialRampToValueAtTime(Math.max(80, opts.cut1), t0 + (opts.dur || 0.18));
      if (opts.q != null) f.Q.setValueAtTime(opts.q, t0);
      var g = ac.createGain();
      var peak = opts.gain != null ? opts.gain : 0.3;
      var dur = opts.dur != null ? opts.dur : 0.18;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(opts.bus || sfxBus);
      activeVoices++;
      src.onended = function () { activeVoices--; try { g.disconnect(); } catch (e) {} };
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    } catch (e) {
      if (Game._recordError) Game._recordError('Audio.noiseBurst', e);
    }
  }

  // ---------------------------------------------------------------- SFX bank
  function playSfx(id, opts) {
    if (unavailable) return;
    if (!ensureContext()) return;
    // Try to resume if a gesture already unlocked us; otherwise the sound is
    // simply inaudible (no throw) until the first gesture.
    try { if (ac.state === 'suspended' && started) ac.resume(); } catch (e) {}
    if (!master) return;
    opts = opts || {};
    var t = now() + 0.001;
    var v = (opts.vol != null ? opts.vol : 1);

    switch (id) {
      case 'coin': {
        // quick rising major arpeggio, triangle — bright & satisfying
        var base = 660;
        var seq = [0, 4, 7, 12];
        for (var i = 0; i < seq.length; i++) {
          voice({ type: 'triangle', f0: semis(base, seq[i]), at: t + i * 0.045, dur: 0.12, gain: 0.22 * v, atk: 0.004 });
        }
        break;
      }
      case 'pop': {
        // little upward pop with a quick pitch drop tail
        voice({ type: 'sine', f0: 520, f1: 880, glide: 0.05, at: t, dur: 0.09, gain: 0.26 * v, atk: 0.003 });
        break;
      }
      case 'moo': {
        // low detuned sine gliding down — cozy cow
        voice({ type: 'sine', f0: 196, f1: 130, glide: 0.42, at: t, dur: 0.5, gain: 0.3 * v, atk: 0.03, lp: 700, detune: -6 });
        voice({ type: 'sine', f0: 200, f1: 132, glide: 0.42, at: t, dur: 0.5, gain: 0.22 * v, atk: 0.03, detune: +8 });
        break;
      }
      case 'chick': {
        // two high square chirps
        voice({ type: 'square', f0: 1560, f1: 1980, glide: 0.03, at: t, dur: 0.05, gain: 0.12 * v, atk: 0.002, lp: 4200 });
        voice({ type: 'square', f0: 1720, f1: 2100, glide: 0.03, at: t + 0.08, dur: 0.05, gain: 0.11 * v, atk: 0.002, lp: 4200 });
        break;
      }
      case 'build': {
        // filtered-noise thunk + a soft low thump
        noiseBurst({ filter: 'lowpass', cut: 1400, cut1: 260, dur: 0.16, gain: 0.32 * v, q: 1.2 });
        voice({ type: 'sine', f0: 150, f1: 70, glide: 0.14, at: t, dur: 0.2, gain: 0.34 * v, atk: 0.004 });
        break;
      }
      case 'click': {
        // tiny sine tick
        voice({ type: 'sine', f0: 880, at: t, dur: 0.045, gain: 0.14 * v, atk: 0.002 });
        break;
      }
      case 'error': {
        // soft descending two-note — gentle, never harsh
        voice({ type: 'triangle', f0: 440, at: t, dur: 0.13, gain: 0.2 * v, atk: 0.004, lp: 2200 });
        voice({ type: 'triangle', f0: 349.23, at: t + 0.11, dur: 0.18, gain: 0.2 * v, atk: 0.004, lp: 2000 });
        break;
      }
      case 'levelup': {
        // rising arpeggio + sparkle shimmer on top
        var lu = [0, 4, 7, 12, 16];
        for (var k = 0; k < lu.length; k++) {
          voice({ type: 'triangle', f0: semis(523.25, lu[k]), at: t + k * 0.07, dur: 0.2, gain: 0.22 * v, atk: 0.004 });
        }
        for (var s2 = 0; s2 < 5; s2++) {
          var sp = 1800 + s2 * 260;
          voice({ type: 'sine', f0: sp, at: t + 0.34 + s2 * 0.05, dur: 0.14, gain: 0.06 * v, atk: 0.003 });
        }
        break;
      }
      case 'heart': {
        // bright, gentle ping (two-osc bell-ish)
        voice({ type: 'sine', f0: 1180, f1: 1320, glide: 0.06, at: t, dur: 0.22, gain: 0.16 * v, atk: 0.003 });
        voice({ type: 'triangle', f0: 1770, at: t + 0.02, dur: 0.16, gain: 0.06 * v, atk: 0.003 });
        break;
      }
      case 'plant': {
        // short soft earthy blip
        voice({ type: 'triangle', f0: 330, f1: 392, glide: 0.05, at: t, dur: 0.1, gain: 0.2 * v, atk: 0.004, lp: 1600 });
        break;
      }
      case 'harvest': {
        // cheerful two-note pluck up
        voice({ type: 'triangle', f0: 587.33, at: t, dur: 0.1, gain: 0.2 * v, atk: 0.003 });
        voice({ type: 'triangle', f0: 783.99, at: t + 0.07, dur: 0.13, gain: 0.2 * v, atk: 0.003 });
        break;
      }
      default: {
        // unknown id -> tiny neutral click, never throw
        voice({ type: 'sine', f0: 660, at: t, dur: 0.05, gain: 0.12 * v, atk: 0.002 });
      }
    }
  }

  // ---------------------------------------------------------------- MUSIC
  function seasonKey() {
    var s = Game.state;
    var season = (s && s.season) || 'spring';
    return SEASON_MUSIC[season] || SEASON_MUSIC.spring;
  }

  function buildMusic(id) {
    if (!ac || !musicBus) return null;
    try {
      var key = seasonKey();
      var padGain = ac.createGain();
      padGain.gain.value = 0.0001;
      var filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      filter.Q.value = 0.4;

      // gentle filter wobble for a living pad
      var lfo = ac.createOscillator();
      var lfoGain = ac.createGain();
      lfo.frequency.value = 0.06;
      lfoGain.gain.value = 220;
      lfo.connect(lfoGain); lfoGain.connect(filter.frequency);

      var padOsc = [];
      var types = ['sine', 'triangle', 'sine', 'sine'];
      for (var i = 0; i < PROG[0].length; i++) {
        var o = ac.createOscillator();
        o.type = types[i % types.length];
        o.frequency.value = semis(key.root, PROG[0][i] - 12); // an octave down for warmth
        if (i > 0) o.detune.value = (i % 2 === 0 ? 4 : -4);
        o.connect(filter);
        padOsc.push(o);
      }
      filter.connect(padGain);
      padGain.connect(musicBus);

      var melodyGain = ac.createGain();
      melodyGain.gain.value = 1;
      melodyGain.connect(musicBus);

      var t = now();
      padOsc.forEach(function (o) { try { o.start(t); } catch (e) {} });
      try { lfo.start(t); } catch (e) {}
      // fade pad in
      ramp(padGain.gain, 0.09, t, 2.0);

      return {
        id: id,
        padOsc: padOsc, padGain: padGain, filter: filter,
        lfo: lfo, lfoGain: lfoGain, melodyGain: melodyGain,
        chordIndex: 0,
        nextChordTime: t + key.chordDur,
        nextNoteTime: t + 0.5,
        rng: U.makeRng ? U.makeRng((Game.state && Game.state.seed) ? (Game.state.seed ^ 0x1234) : 12345) : function () { return whiteRng(); },
        root: key.root,
        chordDur: key.chordDur,
        beat: key.chordDur / 4
      };
    } catch (e) {
      if (Game._recordError) Game._recordError('Audio.buildMusic', e);
      return null;
    }
  }

  function retuneChord(m, chordIdx, atTime) {
    var key = seasonKey();
    m.root = key.root; m.chordDur = key.chordDur; m.beat = key.chordDur / 4;
    var chord = PROG[chordIdx % PROG.length];
    for (var i = 0; i < m.padOsc.length; i++) {
      var target = semis(m.root, chord[i % chord.length] - 12);
      try {
        m.padOsc[i].frequency.cancelScheduledValues(atTime);
        m.padOsc[i].frequency.setValueAtTime(m.padOsc[i].frequency.value, atTime);
        m.padOsc[i].frequency.linearRampToValueAtTime(target, atTime + 0.8);
      } catch (e) {}
    }
  }

  // Sparse music-box melody note (bright triangle + short decay).
  function melodyNote(m, atTime) {
    if (!ac) return;
    var key = seasonKey();
    var chord = PROG[m.chordIndex % PROG.length];
    // ~55% chance of a note per beat -> sparse & pretty
    if (m.rng() > 0.55) return;
    // pick a scale degree, biased toward chord tones
    var pickChordTone = m.rng() < 0.6;
    var deg;
    if (pickChordTone) deg = chord[(m.rng() * chord.length) | 0];
    else deg = MAJOR[(m.rng() * MAJOR.length) | 0];
    var octave = m.rng() < 0.35 ? 12 : 0;
    var f = semis(m.root, deg + octave);
    voice({
      type: 'triangle', f0: f, at: atTime, dur: 0.5, gain: 0.07, atk: 0.005,
      lp: 3200, bus: m.melodyGain
    });
    // faint octave sparkle
    if (m.rng() < 0.25) {
      voice({ type: 'sine', f0: f * 2, at: atTime + 0.01, dur: 0.3, gain: 0.025, atk: 0.004, bus: m.melodyGain });
    }
  }

  function advanceMusic() {
    if (!music || !ac) return;
    var lookahead = 0.25; // seconds
    var t = now();
    var horizon = t + lookahead;
    var guard = 0;

    // chord changes
    while (music.nextChordTime < horizon && guard++ < 32) {
      music.chordIndex = (music.chordIndex + 1) % PROG.length;
      retuneChord(music, music.chordIndex, music.nextChordTime);
      music.nextChordTime += music.chordDur;
    }
    // melody beats
    guard = 0;
    while (music.nextNoteTime < horizon && guard++ < 64) {
      melodyNote(music, music.nextNoteTime);
      music.nextNoteTime += music.beat;
    }
  }

  function stopMusicNow() {
    if (!music) { wantMusic = null; return; }
    var m = music; music = null;
    var t = now();
    try { ramp(m.padGain.gain, 0.0001, t, 0.6); } catch (e) {}
    var stopAt = t + 0.8;
    try { m.padOsc.forEach(function (o) { try { o.stop(stopAt); } catch (e) {} }); } catch (e) {}
    try { m.lfo.stop(stopAt); } catch (e) {}
    // disconnect a little after the fade completes
    setTimeoutSafe(function () {
      try { m.padGain.disconnect(); } catch (e) {}
      try { m.filter.disconnect(); } catch (e) {}
      try { m.melodyGain.disconnect(); } catch (e) {}
      try { m.lfoGain.disconnect(); } catch (e) {}
    }, 900);
  }

  function setTimeoutSafe(fn, ms) {
    try { if (typeof setTimeout !== 'undefined') setTimeout(fn, ms); } catch (e) {}
  }

  // ---------------------------------------------------------------- MIXER
  function applyVolumes() {
    if (!master) return;
    var st = settings();
    var t = now();
    var muted = !!st.muted || hidden();
    var mv = muted ? 0.0001 : Math.max(0.0001, (st.master != null ? st.master : 0.8));
    var sv = Math.max(0.0001, (st.sfx != null ? st.sfx : 0.9));
    // duck the music channel when requested
    var duck = (duckUntil > t) ? duckAmt : 1;
    var muv = Math.max(0.0001, (st.music != null ? st.music : 0.5) * duck);
    try {
      ramp(master.gain, mv, t, 0.08);
      ramp(sfxBus.gain, sv, t, 0.05);
      ramp(musicBus.gain, muv, t, 0.12);
    } catch (e) {}
  }

  // ---------------------------------------------------------------- gestures / wiring
  function onFirstGesture() {
    if (started) return;
    if (!ensureContext()) return;
    started = true;
    try { if (ac.state === 'suspended') ac.resume(); } catch (e) {}
    applyVolumes();
    // start pastoral music once we're allowed to make sound
    var st = settings();
    if (wantMusic == null && !st.muted) wantMusic = 'ranch';
    if (wantMusic != null && !music) {
      music = buildMusic(wantMusic);
      wantMusic = null;
    }
  }

  function attachGestureListeners() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    var handler = function () {
      onFirstGesture();
      try {
        window.removeEventListener('pointerdown', handler, true);
        window.removeEventListener('keydown', handler, true);
        window.removeEventListener('touchstart', handler, true);
      } catch (e) {}
    };
    try {
      window.addEventListener('pointerdown', handler, true);
      window.addEventListener('keydown', handler, true);
      window.addEventListener('touchstart', handler, true);
    } catch (e) {}
  }

  function attachVisibility() {
    if (typeof document === 'undefined' || !document.addEventListener) return;
    try {
      document.addEventListener('visibilitychange', function () {
        applyVolumes();
        // pause/resume the context to save CPU when tab is hidden
        try {
          if (!ac) return;
          if (hidden()) { if (ac.state === 'running') ac.suspend(); }
          else if (started && ac.state === 'suspended') ac.resume();
        } catch (e) {}
      });
    } catch (e) {}
  }

  function wireBus() {
    if (wired) return; wired = true;
    function on(ev, fn) { try { bus.on(ev, fn); } catch (e) {} }

    on('sale', function () { playSfx('coin'); });
    on('purchase', function () { playSfx('pop'); });
    on('build', function () { playSfx('build'); });
    on('animal:born', function () { playSfx('heart'); });
    on('levelup', function () { playSfx('levelup'); });
    on('crop:plant', function () { playSfx('plant'); });
    on('crop:harvest', function () { playSfx('harvest'); });
    on('fx:heart', function () { playSfx('heart'); });
    on('notify', function (p) { if (p && p.kind === 'bad') playSfx('error'); });

    // keep mixer in sync when settings change elsewhere
    on('speed:change', function () { /* no-op; hook point */ });
    on('season:change', function () {
      // gently re-key the running pad to the new season on its next chord
      if (music) { var key = seasonKey(); music.chordDur = key.chordDur; music.beat = key.chordDur / 4; }
    });
    on('game:pause', function () { duckUntil = now() + 0.4; applyVolumes(); });
    on('game:resume', function () { applyVolumes(); });
    on('state:replaced', function () {
      // new game / load: reseed melody & refresh mixer
      if (music && U.makeRng) music.rng = U.makeRng((Game.state && Game.state.seed) ? (Game.state.seed ^ 0x1234) : 12345);
      applyVolumes();
    });
  }

  // ---------------------------------------------------------------- public API
  function init(ctx) {
    try {
      wireBus();
      attachGestureListeners();
      attachVisibility();
      // Build the graph now if the environment allows it (so mixer reflects
      // settings immediately). It stays suspended until the first user gesture.
      ensureContext();
      applyVolumes();
    } catch (e) {
      if (Game._recordError) Game._recordError('Audio.init', e);
    }
  }

  function update() {
    if (unavailable || !ac || !started) return;
    try {
      // re-apply duck decay each frame (cheap) and advance the scheduler
      applyVolumes();
      if (music) advanceMusic();
    } catch (e) {
      if (Game._recordError) Game._recordError('Audio.update', e);
    }
  }

  function sfx(id, opts) {
    try { playSfx(id, opts); }
    catch (e) { if (Game._recordError) Game._recordError('Audio.sfx:' + id, e); }
  }

  function playMusic(id) {
    id = id || 'ranch';
    try {
      if (!ensureContext()) { wantMusic = id; return; }
      if (!started) { wantMusic = id; return; } // wait for gesture unlock
      if (music && music.id === id) return;
      if (music) stopMusicNow();
      music = buildMusic(id);
    } catch (e) {
      if (Game._recordError) Game._recordError('Audio.playMusic', e);
    }
  }

  function stopMusic() {
    try { wantMusic = null; stopMusicNow(); }
    catch (e) { if (Game._recordError) Game._recordError('Audio.stopMusic', e); }
  }

  function duckFor(ms) {
    if (!ac) return;
    try {
      duckUntil = now() + (Math.max(0, ms || 300) / 1000);
      applyVolumes();
    } catch (e) {}
  }

  function setVolumes(v) {
    // Persist into live settings (UI owns settings, but Audio may be asked to
    // apply directly). Only touch provided keys; never cache the state object.
    try {
      var st = Game.state && Game.state.settings;
      if (st && v) {
        if (v.master != null) st.master = U.clamp(v.master, 0, 1);
        if (v.sfx != null) st.sfx = U.clamp(v.sfx, 0, 1);
        if (v.music != null) st.music = U.clamp(v.music, 0, 1);
      }
      applyVolumes();
    } catch (e) { if (Game._recordError) Game._recordError('Audio.setVolumes', e); }
  }

  function setMuted(b) {
    try {
      var st = Game.state && Game.state.settings;
      if (st) st.muted = !!b;
      applyVolumes();
    } catch (e) { if (Game._recordError) Game._recordError('Audio.setMuted', e); }
  }

  return {
    init: init,
    update: update,
    sfx: sfx,
    playMusic: playMusic,
    stopMusic: stopMusic,
    duckFor: duckFor,
    setVolumes: setVolumes,
    setMuted: setMuted
  };
})();
