import { useEffect, useMemo } from 'react';
import { getProvider } from '../market';
import { useAccountStore } from '../store/useAccountStore';
import { useQuotesStore } from '../store/useQuotesStore';

/**
 * Subscribe to live quotes for every symbol on the watchlist (plus the
 * currently selected one) and feed them into the quotes store. Subscriptions
 * are torn down and rebuilt only when the symbol set actually changes.
 */
export function useMarketData(): string {
  const watchlist = useAccountStore((s) => s.watchlist);
  const selectedSymbol = useAccountStore((s) => s.selectedSymbol);

  const symbols = useMemo(
    () => Array.from(new Set([...watchlist, selectedSymbol].filter(Boolean))),
    [watchlist, selectedSymbol],
  );
  const key = symbols.join(',');

  useEffect(() => {
    const provider = getProvider();
    const setQuote = useQuotesStore.getState().setQuote;
    const unsubs = symbols.map((sym) => provider.subscribe(sym, setQuote));
    return () => unsubs.forEach((u) => u());
    // `key` captures the symbol set; `symbols` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return getProvider().name;
}
