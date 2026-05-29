import type { Candle, Quote } from '../types';
import type { MarketDataProvider, QuoteListener } from './types';
import { SimulatedProvider } from './SimulatedProvider';

interface FinnhubQuote {
  c: number; // current price
  pc: number; // previous close
  t: number; // unix seconds
}

export interface FinnhubProviderOptions {
  token: string;
  pollMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Live US quotes from Finnhub (https://finnhub.io) via REST polling.
 *
 * Finnhub's free tier no longer serves intraday candles, so historical bars
 * are synthesized around the latest real price using the local simulator.
 * Quotes are real; the chart history is illustrative.
 */
export class FinnhubProvider implements MarketDataProvider {
  readonly name = 'Finnhub';

  private readonly token: string;
  private readonly pollMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly listeners = new Map<string, Set<QuoteListener>>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly lastPrice = new Map<string, number>();
  private readonly fallback = new SimulatedProvider();

  constructor(opts: FinnhubProviderOptions) {
    this.token = opts.token;
    this.pollMs = opts.pollMs ?? 2000;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  private async poll(symbol: string): Promise<void> {
    const key = symbol.toUpperCase();
    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
        key,
      )}&token=${encodeURIComponent(this.token)}`;
      const res = await this.fetchImpl(url);
      if (!res.ok) return;
      const data = (await res.json()) as FinnhubQuote;
      if (!data || !Number.isFinite(data.c) || data.c <= 0) return;
      this.lastPrice.set(key, data.c);
      const quote: Quote = {
        symbol: key,
        price: data.c,
        prevClose: Number.isFinite(data.pc) && data.pc > 0 ? data.pc : data.c,
        time: data.t ? data.t * 1000 : Date.now(),
      };
      const set = this.listeners.get(key);
      if (set) for (const fn of set) fn(quote);
    } catch {
      // Network hiccup — keep the last good quote and try again next tick.
    }
  }

  subscribe(symbol: string, listener: QuoteListener): () => void {
    const key = symbol.toUpperCase();
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);

    if (!this.timers.has(key)) {
      void this.poll(key);
      this.timers.set(
        key,
        setInterval(() => void this.poll(key), this.pollMs),
      );
    }

    return () => {
      const s = this.listeners.get(key);
      if (s) {
        s.delete(listener);
        if (s.size === 0) {
          this.listeners.delete(key);
          const t = this.timers.get(key);
          if (t) {
            clearInterval(t);
            this.timers.delete(key);
          }
        }
      }
    };
  }

  async getCandles(symbol: string, count = 120): Promise<Candle[]> {
    // Anchor synthesized history to the latest real price when we have one.
    const candles = await this.fallback.getCandles(symbol, count);
    const real = this.lastPrice.get(symbol.toUpperCase());
    if (real && candles.length) {
      const last = candles[candles.length - 1].close;
      const scale = real / last;
      return candles.map((c) => ({
        ...c,
        open: round2(c.open * scale),
        high: round2(c.high * scale),
        low: round2(c.low * scale),
        close: round2(c.close * scale),
      }));
    }
    return candles;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
