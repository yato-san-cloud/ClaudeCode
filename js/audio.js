/*
 * audio.js — WebAudio で効果音を合成する（外部ファイル不要）。
 *
 * オフライン/公開どちらでも鳴るように、音源ファイルを一切持たず
 * オシレータとノイズだけで沼の "チン…" や大当たりのファンファーレを作る。
 */
(function (global) {
  'use strict';
  const Numa = (global.Numa = global.Numa || {});

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.muted = false;
    }

    /** ユーザー操作後に呼ぶ（自動再生ポリシー対策）。 */
    ensure() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return;
      }
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    }

    setMuted(m) {
      this.muted = m;
      if (this.master) this.master.gain.value = m ? 0 : 0.35;
    }

    _beep(freq, dur, type, vol, slideTo) {
      if (!this.ctx || this.muted) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(freq, t);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.3, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }

    _noise(dur, vol) {
      if (!this.ctx || this.muted) return;
      const t = this.ctx.currentTime;
      const n = Math.floor(this.ctx.sampleRate * dur);
      const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = vol || 0.15;
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1200;
      src.connect(hp);
      hp.connect(g);
      g.connect(this.master);
      src.start(t);
    }

    launch() {
      this._beep(420, 0.05, 'square', 0.12, 680);
    }
    peg() {
      this._beep(900 + Math.random() * 400, 0.03, 'triangle', 0.06);
    }
    chucker() {
      this._beep(660, 0.08, 'square', 0.2, 990);
    }
    wing() {
      this._beep(300, 0.06, 'sawtooth', 0.12);
    }
    capture() {
      this._beep(520, 0.1, 'sine', 0.2, 780);
    }
    out() {
      this._beep(220, 0.12, 'sine', 0.12, 120);
    }
    /** Vゾーン入賞＝大当たり！ */
    jackpot() {
      const notes = [523, 659, 784, 1046];
      notes.forEach((f, i) => {
        setTimeout(() => this._beep(f, 0.28, 'square', 0.28), i * 110);
      });
      this._noise(0.5, 0.1);
    }
    round() {
      this._beep(784, 0.12, 'square', 0.22, 1046);
    }
    payout() {
      this._beep(1320, 0.04, 'square', 0.1);
    }
    win() {
      [659, 784, 880, 1046, 1318].forEach((f, i) =>
        setTimeout(() => this._beep(f, 0.35, 'square', 0.3), i * 140)
      );
    }
    fail() {
      this._beep(330, 0.5, 'sawtooth', 0.2, 90);
    }
  }

  Numa.audio = new AudioEngine();
})(window);
