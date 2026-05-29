export type Side = 'buy' | 'sell';

export interface Quote {
  symbol: string;
  /** Last trade price. */
  price: number;
  /** Previous close, used to compute the day change. */
  prevClose: number;
  /** Epoch millis of the last update. */
  time: number;
}

export interface Candle {
  /** Epoch seconds (lightweight-charts convention for the time axis). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Order {
  id: string;
  symbol: string;
  side: Side;
  /** Number of shares (always positive). */
  quantity: number;
  /** Fill price. */
  price: number;
  /** Commission charged on the fill. */
  commission: number;
  time: number;
}

export interface Position {
  symbol: string;
  /** Signed share count: positive = long, negative = short, 0 = flat. */
  quantity: number;
  /** Average entry price of the currently open position. 0 when flat. */
  avgPrice: number;
  /** Cumulative realized P&L for this symbol (net of commissions). */
  realizedPnL: number;
}

export interface Portfolio {
  /** Available cash balance. */
  cash: number;
  positions: Record<string, Position>;
  orders: Order[];
}
