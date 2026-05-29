import { useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { Watchlist } from './components/Watchlist';
import { Chart } from './components/Chart';
import { OrderTicket } from './components/OrderTicket';
import { Positions } from './components/Positions';
import { TradeHistory } from './components/TradeHistory';
import { useMarketData } from './hooks/useMarketData';
import { useAccountStore } from './store/useAccountStore';
import { useQuotesStore } from './store/useQuotesStore';
import { equity } from './lib/portfolio';
import './App.css';

export default function App() {
  const providerName = useMarketData();
  const selectedSymbol = useAccountStore((s) => s.selectedSymbol);
  const rolled = useRef(false);

  // Roll the day P&L baseline once after the feed warms up on a new calendar day.
  useEffect(() => {
    if (rolled.current) return;
    const t = setTimeout(() => {
      const marks: Record<string, number> = {};
      for (const [sym, q] of Object.entries(useQuotesStore.getState().quotes)) {
        marks[sym] = q.price;
      }
      const eq = equity(useAccountStore.getState().portfolio, marks);
      useAccountStore.getState().rollSessionIfNeeded(eq);
      rolled.current = true;
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="app">
      <Header providerName={providerName} />
      <main className="layout">
        <aside className="col-left">
          <Watchlist />
        </aside>
        <section className="col-center">
          <div className="chart-card panel">
            <div className="chart-card-head">
              <h2>{selectedSymbol}</h2>
              <span className="hint">1-minute candles · live</span>
            </div>
            <Chart symbol={selectedSymbol} />
          </div>
          <Positions />
        </section>
        <aside className="col-right">
          <OrderTicket />
          <TradeHistory />
        </aside>
      </main>
    </div>
  );
}
