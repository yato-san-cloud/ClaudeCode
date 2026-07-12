// sound.js — retro SFX via WebAudio. Global `Sound` namespace; never throws.
// If AudioContext is unavailable, every method is a silent no-op.
const Sound = (function () {
  const MASTER = 0.14;
  let ctx = null;
  let master = null;
  let supported = true;

  function ensure() {
    if (!supported) return null;
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { supported = false; return null; }
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = MASTER;
        master.connect(ctx.destination);
      }
      return ctx;
    } catch (e) {
      supported = false;
      return null;
    }
  }

  // Whether we should actually make noise right now.
  function live() {
    if (api.muted) return null;
    const c = ensure();
    if (!c) return null;
    return c;
  }

  // One oscillator blip with a fast decay envelope.
  // type: waveform; f0->f1: freq sweep; dur seconds; gain peak; delay seconds.
  function blip(type, f0, f1, dur, gain, delay) {
    const c = live();
    if (!c) return;
    try {
      const t0 = c.currentTime + (delay || 0);
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(f0, t0);
      if (f1 && f1 !== f0) {
        try { osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur); }
        catch (e) { osc.frequency.linearRampToValueAtTime(f1, t0 + dur); }
      }
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch (e) { /* no-op */ }
  }

  // Short filtered noise burst (for explosions).
  function noise(dur, gain, cutoff) {
    const c = live();
    if (!c) return;
    try {
      const t0 = c.currentTime;
      const frames = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, frames, c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) {
        // fade the noise toward the end for a punchier tail
        data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
      }
      const src = c.createBufferSource();
      src.buffer = buf;
      const g = c.createGain();
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      let node = src;
      try {
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(cutoff || 900, t0);
        lp.frequency.exponentialRampToValueAtTime(Math.max(80, (cutoff || 900) * 0.25), t0 + dur);
        src.connect(lp);
        lp.connect(g);
      } catch (e) {
        src.connect(g);
      }
      g.connect(master);
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    } catch (e) { /* no-op */ }
  }

  const api = {
    muted: false,

    resume: function () {
      try {
        const c = ensure();
        if (c && c.state === 'suspended' && typeof c.resume === 'function') {
          c.resume();
        }
      } catch (e) { /* no-op */ }
    },

    toggleMute: function () {
      try {
        api.muted = !api.muted;
        if (master && ctx) {
          master.gain.setValueAtTime(api.muted ? 0 : MASTER, ctx.currentTime);
        }
      } catch (e) {
        api.muted = !api.muted;
      }
      return api.muted;
    },

    // Short click when dropping a bomb.
    place: function () {
      blip('square', 220, 110, 0.08, 0.5, 0);
    },

    // Low noise burst + downward tonal sweep.
    explode: function () {
      noise(0.32, 0.9, 1100);
      blip('sawtooth', 180, 40, 0.34, 0.5, 0);
    },

    // Rising two-note chirp.
    pickup: function () {
      blip('square', 660, 660, 0.07, 0.45, 0);
      blip('square', 990, 990, 0.09, 0.5, 0.07);
    },

    // Sad downward warble.
    death: function () {
      blip('triangle', 440, 220, 0.18, 0.55, 0);
      blip('triangle', 220, 90, 0.3, 0.5, 0.16);
    },

    // Bright ascending triad.
    win: function () {
      blip('square', 523, 523, 0.12, 0.4, 0);     // C5
      blip('square', 659, 659, 0.12, 0.4, 0.12);  // E5
      blip('square', 784, 784, 0.12, 0.4, 0.24);  // G5
      blip('square', 1047, 1047, 0.22, 0.45, 0.36); // C6
    },

    // Tiny footstep tick.
    step: function () {
      blip('square', 150, 120, 0.03, 0.18, 0);
    }
  };

  return api;
})();
