export interface SymbolSeed {
  symbol: string;
  name: string;
  /** Plausible reference price used to seed the simulator. */
  seedPrice: number;
  /** Annualized volatility used by the random-walk simulator. */
  volatility: number;
}

/** A starter universe of liquid, well-known US tickers. */
export const SYMBOL_UNIVERSE: SymbolSeed[] = [
  { symbol: 'AAPL', name: 'Apple Inc.', seedPrice: 195.0, volatility: 0.25 },
  { symbol: 'MSFT', name: 'Microsoft Corp.', seedPrice: 420.0, volatility: 0.22 },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', seedPrice: 120.0, volatility: 0.45 },
  { symbol: 'TSLA', name: 'Tesla Inc.', seedPrice: 250.0, volatility: 0.55 },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', seedPrice: 185.0, volatility: 0.3 },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', seedPrice: 175.0, volatility: 0.28 },
  { symbol: 'META', name: 'Meta Platforms Inc.', seedPrice: 500.0, volatility: 0.35 },
  { symbol: 'AMD', name: 'Advanced Micro Devices', seedPrice: 160.0, volatility: 0.5 },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF', seedPrice: 540.0, volatility: 0.15 },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', seedPrice: 470.0, volatility: 0.18 },
];

const seedBySymbol = new Map(SYMBOL_UNIVERSE.map((s) => [s.symbol, s]));

export function findSeed(symbol: string): SymbolSeed | undefined {
  return seedBySymbol.get(symbol.toUpperCase());
}

export const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SPY'];
