import type { MarketDataProvider } from './types';
import { SimulatedProvider } from './SimulatedProvider';
import { FinnhubProvider } from './FinnhubProvider';

export type { MarketDataProvider, QuoteListener } from './types';
export { SimulatedProvider } from './SimulatedProvider';
export { FinnhubProvider } from './FinnhubProvider';

/**
 * Pick the market data provider based on environment configuration.
 * Falls back to the simulator whenever no Finnhub token is supplied.
 */
export function createProvider(): MarketDataProvider {
  const token = import.meta.env.VITE_FINNHUB_TOKEN as string | undefined;
  const pollMs = Number(import.meta.env.VITE_QUOTE_POLL_MS) || 2000;
  if (token && token.trim()) {
    return new FinnhubProvider({ token: token.trim(), pollMs });
  }
  return new SimulatedProvider({ tickMs: 1000 });
}

let singleton: MarketDataProvider | null = null;

/** Lazily-created shared provider for the running app. */
export function getProvider(): MarketDataProvider {
  if (!singleton) singleton = createProvider();
  return singleton;
}
