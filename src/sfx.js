// WebAudio で鳴らす簡易効果音。外部ファイルを持たないので単体 HTML のまま配布できる。

export const sfx = {
  ctx: null,
  muted: false,

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) this.ctx = new AC();
  },

  tone(freq, dur, { type = 'square', gain = 0.05, slide = 0, delay = 0 } = {}) {
    if (this.muted || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    amp.gain.setValueAtTime(0, t0);
    amp.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  },

  tap() { this.tone(520, 0.05, { gain: 0.04 }); },
  pull() { this.tone(300, 0.16, { type: 'sawtooth', slide: 380, gain: 0.05 }); },
  coin() { this.tone(1050, 0.06, { type: 'triangle', gain: 0.035 }); this.tone(1500, 0.07, { type: 'triangle', gain: 0.03, delay: 0.05 }); },
  merge() { [520, 660, 830].forEach((f, i) => this.tone(f, 0.09, { type: 'triangle', gain: 0.045, delay: i * 0.05 })); },
  fail() { this.tone(200, 0.5, { type: 'sawtooth', slide: -140, gain: 0.06 }); },
  win() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.16, { type: 'square', gain: 0.05, delay: i * 0.09 })); },
  popup() { this.tone(880, 0.08, { type: 'sine', gain: 0.04 }); },
  cash() { [1320, 1760].forEach((f, i) => this.tone(f, 0.12, { type: 'sine', gain: 0.04, delay: i * 0.08 })); },
};
