import type { Candle, Quote } from '../types';

export type QuoteListener = (quote: Quote) => void;

export interface MarketDataProvider {
  /** Human-readable label, e.g. "Simulated" or "Finnhub". */
  readonly name: string;

  /**
   * Subscribe to live quote updates for a symbol. Returns an unsubscribe fn.
   * Implementations should emit an initial quote promptly after subscribing.
   */
  subscribe(symbol: string, listener: QuoteListener): () => void;

  /** Fetch (or synthesize) recent candles for charting. */
  getCandles(symbol: string, count?: number): Promise<Candle[]>;
}
