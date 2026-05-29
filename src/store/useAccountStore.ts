import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Portfolio, Side } from '../types';
import { applyFill, createPortfolio, equity, INITIAL_CASH } from '../lib/portfolio';
import { DEFAULT_WATCHLIST } from '../market/symbols';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface OrderTicket {
  symbol: string;
  side: Side;
  quantity: number;
  price: number;
}

interface AccountState {
  portfolio: Portfolio;
  watchlist: string[];
  selectedSymbol: string;
  /** Equity baseline used to compute the day's P&L. */
  sessionStartEquity: number;
  sessionDate: string;

  selectSymbol: (symbol: string) => void;
  addSymbol: (symbol: string) => boolean;
  removeSymbol: (symbol: string) => void;

  /** Place a market order. Returns an error message, or null on success. */
  placeOrder: (ticket: OrderTicket) => string | null;
  resetAccount: () => void;
  /** Roll the day baseline if we've crossed into a new calendar day. */
  rollSessionIfNeeded: (currentEquity: number) => void;
}

export const useAccountStore = create<AccountState>()(
  persist(
    (set, get) => ({
      portfolio: createPortfolio(),
      watchlist: [...DEFAULT_WATCHLIST],
      selectedSymbol: DEFAULT_WATCHLIST[0],
      sessionStartEquity: INITIAL_CASH,
      sessionDate: today(),

      selectSymbol: (symbol) => set({ selectedSymbol: symbol.toUpperCase() }),

      addSymbol: (symbol) => {
        const sym = symbol.trim().toUpperCase();
        if (!sym || !/^[A-Z.-]{1,8}$/.test(sym)) return false;
        const { watchlist } = get();
        if (watchlist.includes(sym)) {
          set({ selectedSymbol: sym });
          return true;
        }
        set({ watchlist: [...watchlist, sym], selectedSymbol: sym });
        return true;
      },

      removeSymbol: (symbol) => {
        const sym = symbol.toUpperCase();
        const { watchlist, selectedSymbol } = get();
        const next = watchlist.filter((s) => s !== sym);
        set({
          watchlist: next,
          selectedSymbol:
            selectedSymbol === sym ? (next[0] ?? selectedSymbol) : selectedSymbol,
        });
      },

      placeOrder: (ticket) => {
        const result = applyFill(get().portfolio, {
          symbol: ticket.symbol.toUpperCase(),
          side: ticket.side,
          quantity: ticket.quantity,
          price: ticket.price,
        });
        if (!result.ok) return result.reason ?? 'Order rejected.';
        set({ portfolio: result.portfolio });
        return null;
      },

      resetAccount: () =>
        set({
          portfolio: createPortfolio(),
          sessionStartEquity: INITIAL_CASH,
          sessionDate: today(),
        }),

      rollSessionIfNeeded: (currentEquity) => {
        if (get().sessionDate !== today()) {
          set({ sessionStartEquity: currentEquity, sessionDate: today() });
        }
      },
    }),
    {
      name: 'us-daytrader-account',
      version: 1,
      partialize: (s) => ({
        portfolio: s.portfolio,
        watchlist: s.watchlist,
        selectedSymbol: s.selectedSymbol,
        sessionStartEquity: s.sessionStartEquity,
        sessionDate: s.sessionDate,
      }),
    },
  ),
);

/** Convenience selector: equity given a marks map. */
export function selectEquity(state: AccountState, marks: Record<string, number>): number {
  return equity(state.portfolio, marks);
}
