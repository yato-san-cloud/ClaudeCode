import { create } from 'zustand';
import type { Quote } from '../types';

interface QuotesState {
  quotes: Record<string, Quote>;
  setQuote: (quote: Quote) => void;
}

/** Ephemeral, high-frequency live quotes. Never persisted. */
export const useQuotesStore = create<QuotesState>((set) => ({
  quotes: {},
  setQuote: (quote) =>
    set((state) => ({ quotes: { ...state.quotes, [quote.symbol]: quote } })),
}));

/** Snapshot of current prices keyed by symbol (for P&L math outside React). */
export function currentMarks(): Record<string, number> {
  const marks: Record<string, number> = {};
  for (const [sym, q] of Object.entries(useQuotesStore.getState().quotes)) {
    marks[sym] = q.price;
  }
  return marks;
}
