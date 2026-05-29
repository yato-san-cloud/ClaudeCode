import { useState } from 'react';
import { useAccountStore } from '../store/useAccountStore';
import { useQuotesStore } from '../store/useQuotesStore';
import { fmtPercent, fmtPrice, signClass } from '../lib/format';
import { findSeed } from '../market/symbols';

function WatchRow({ symbol }: { symbol: string }) {
  const quote = useQuotesStore((s) => s.quotes[symbol]);
  const selectedSymbol = useAccountStore((s) => s.selectedSymbol);
  const selectSymbol = useAccountStore((s) => s.selectSymbol);
  const removeSymbol = useAccountStore((s) => s.removeSymbol);

  const change = quote ? (quote.price - quote.prevClose) / quote.prevClose : 0;
  const name = findSeed(symbol)?.name;

  return (
    <li
      className={`watch-row ${symbol === selectedSymbol ? 'active' : ''}`}
      onClick={() => selectSymbol(symbol)}
    >
      <div className="watch-sym">
        <span className="ticker">{symbol}</span>
        {name && <span className="name">{name}</span>}
      </div>
      <div className="watch-px">
        <span className="px">{quote ? fmtPrice(quote.price) : '—'}</span>
        <span className={`chg ${signClass(change)}`}>{fmtPercent(change)}</span>
      </div>
      <button
        className="remove"
        title={`Remove ${symbol}`}
        onClick={(e) => {
          e.stopPropagation();
          removeSymbol(symbol);
        }}
      >
        ×
      </button>
    </li>
  );
}

export function Watchlist() {
  const watchlist = useAccountStore((s) => s.watchlist);
  const addSymbol = useAccountStore((s) => s.addSymbol);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    if (addSymbol(input)) {
      setInput('');
      setError('');
    } else {
      setError('Invalid ticker');
    }
  };

  return (
    <section className="panel watchlist">
      <h2>Watchlist</h2>
      <form className="add-symbol" onSubmit={submit}>
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError('');
          }}
          placeholder="Add ticker (e.g. AAPL)"
          aria-label="Add ticker"
          maxLength={8}
        />
        <button type="submit">Add</button>
      </form>
      {error && <p className="form-error">{error}</p>}
      <ul className="watch-list">
        {watchlist.length === 0 && <li className="empty">No symbols. Add one above.</li>}
        {watchlist.map((sym) => (
          <WatchRow key={sym} symbol={sym} />
        ))}
      </ul>
    </section>
  );
}
