import type { Candle, Quote } from '../types';
import type { MarketDataProvider, QuoteListener } from './types';
import { findSeed } from './symbols';

/** Deterministic PRNG (mulberry32) so simulations are reproducible in tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal sample via Box–Muller from a uniform generator. */
export function normalFrom(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Approximate number of one-second ticks in a trading year (252 days * 6.5h).
const TRADING_SECONDS_PER_YEAR = 252 * 6.5 * 3600;

interface SymState {
  price: number;
  prevClose: number;
  volatility: number;
}

export interface SimulatedProviderOptions {
  tickMs?: number;
  /** Uniform [0,1) generator; injectable for deterministic tests. */
  rng?: () => number;
  now?: () => number;
}

const DEFAULT_PRICE = 100;
const DEFAULT_VOL = 0.4;

/**
 * A self-contained, API-key-free market simulator. Each subscribed symbol
 * follows a geometric Brownian motion so prices stay positive and produce
 * realistic intraday wiggle for the chart and P&L.
 */
export class SimulatedProvider implements MarketDataProvider {
  readonly name = 'Simulated';

  private readonly tickMs: number;
  private readonly rng: () => number;
  private readonly now: () => number;
  private readonly states = new Map<string, SymState>();
  private readonly listeners = new Map<string, Set<QuoteListener>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SimulatedProviderOptions = {}) {
    this.tickMs = opts.tickMs ?? 1000;
    this.rng = opts.rng ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  private stateFor(symbol: string): SymState {
    const key = symbol.toUpperCase();
    let s = this.states.get(key);
    if (!s) {
      const seed = findSeed(key);
      const price = seed?.seedPrice ?? DEFAULT_PRICE;
      s = { price, prevClose: price, volatility: seed?.volatility ?? DEFAULT_VOL };
      this.states.set(key, s);
    }
    return s;
  }

  private quoteFor(symbol: string): Quote {
    const s = this.stateFor(symbol);
    return {
      symbol: symbol.toUpperCase(),
      price: round2(s.price),
      prevClose: round2(s.prevClose),
      time: this.now(),
    };
  }

  /** Advance every tracked symbol by one tick. Public for deterministic tests. */
  step(): void {
    const dt = this.tickMs / 1000 / TRADING_SECONDS_PER_YEAR;
    for (const [symbol, s] of this.states) {
      const drift = -0.5 * s.volatility * s.volatility * dt;
      const shock = s.volatility * Math.sqrt(dt) * normalFrom(this.rng);
      s.price = Math.max(0.01, s.price * Math.exp(drift + shock));
      this.emit(symbol);
    }
  }

  private emit(symbol: string): void {
    const set = this.listeners.get(symbol.toUpperCase());
    if (!set) return;
    const q = this.quoteFor(symbol);
    for (const fn of set) fn(q);
  }

  subscribe(symbol: string, listener: QuoteListener): () => void {
    const key = symbol.toUpperCase();
    this.stateFor(key);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    // Emit an initial quote so subscribers render immediately.
    listener(this.quoteFor(key));
    this.ensureRunning();

    return () => {
      const s = this.listeners.get(key);
      if (s) {
        s.delete(listener);
        if (s.size === 0) this.listeners.delete(key);
      }
      this.maybeStop();
    };
  }

  private ensureRunning(): void {
    if (this.timer === null && typeof setInterval !== 'undefined') {
      this.timer = setInterval(() => this.step(), this.tickMs);
    }
  }

  private maybeStop(): void {
    if (this.timer !== null && this.listeners.size === 0) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Stop the internal timer (useful for teardown). */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async getCandles(symbol: string, count = 120): Promise<Candle[]> {
    const s = this.stateFor(symbol);
    const sigmaPerBar = s.volatility * Math.sqrt(60 / 1 / TRADING_SECONDS_PER_YEAR);
    // Walk backward from the current price so the most recent close is live.
    const closes = new Array<number>(count);
    closes[count - 1] = s.price;
    for (let i = count - 2; i >= 0; i--) {
      const r = normalFrom(this.rng) * sigmaPerBar;
      closes[i] = Math.max(0.01, closes[i + 1] * Math.exp(-r));
    }

    const nowSec = Math.floor(this.now() / 1000);
    const candles: Candle[] = [];
    for (let i = 0; i < count; i++) {
      const close = closes[i];
      const open = i === 0 ? close : closes[i - 1];
      const wick = Math.abs(normalFrom(this.rng)) * sigmaPerBar * close;
      const high = Math.max(open, close) + wick;
      const low = Math.max(0.01, Math.min(open, close) - wick);
      const volume = Math.floor(50_000 + this.rng() * 200_000);
      candles.push({
        time: nowSec - (count - 1 - i) * 60,
        open: round2(open),
        high: round2(high),
        low: round2(low),
        close: round2(close),
        volume,
      });
    }
    return candles;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
