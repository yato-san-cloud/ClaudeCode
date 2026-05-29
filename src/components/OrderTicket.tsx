import { useEffect, useState } from 'react';
import { useAccountStore } from '../store/useAccountStore';
import { useQuotesStore } from '../store/useQuotesStore';
import { COMMISSION_PER_ORDER } from '../lib/portfolio';
import { fmtMoney, fmtPercent, fmtPrice, signClass } from '../lib/format';
import type { Side } from '../types';

export function OrderTicket() {
  const symbol = useAccountStore((s) => s.selectedSymbol);
  const quote = useQuotesStore((s) => s.quotes[symbol]);
  const cash = useAccountStore((s) => s.portfolio.cash);
  const placeOrder = useAccountStore((s) => s.placeOrder);

  const [side, setSide] = useState<Side>('buy');
  const [qty, setQty] = useState('10');
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  // Clear any transient message when the symbol changes.
  useEffect(() => setFlash(null), [symbol]);

  const price = quote?.price ?? 0;
  const quantity = Math.floor(Number(qty));
  const estimate = quantity > 0 && price > 0 ? quantity * price : 0;
  const change = quote ? (quote.price - quote.prevClose) / quote.prevClose : 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!price) {
      setFlash({ kind: 'err', msg: 'No live price yet.' });
      return;
    }
    if (!(quantity > 0)) {
      setFlash({ kind: 'err', msg: 'Enter a positive quantity.' });
      return;
    }
    const err = placeOrder({ symbol, side, quantity, price });
    if (err) {
      setFlash({ kind: 'err', msg: err });
    } else {
      setFlash({
        kind: 'ok',
        msg: `${side === 'buy' ? 'Bought' : 'Sold'} ${quantity} ${symbol} @ ${fmtPrice(price)}`,
      });
    }
  };

  return (
    <section className="panel order-ticket">
      <div className="ticket-head">
        <div>
          <span className="ticket-symbol">{symbol}</span>
          <span className={`ticket-change ${signClass(change)}`}>{fmtPercent(change)}</span>
        </div>
        <span className="ticket-price">{quote ? fmtPrice(price) : '—'}</span>
      </div>

      <form onSubmit={submit}>
        <div className="side-toggle">
          <button
            type="button"
            className={`buy ${side === 'buy' ? 'active' : ''}`}
            onClick={() => setSide('buy')}
          >
            Buy
          </button>
          <button
            type="button"
            className={`sell ${side === 'sell' ? 'active' : ''}`}
            onClick={() => setSide('sell')}
          >
            Sell
          </button>
        </div>

        <label className="field">
          <span>Quantity (shares)</span>
          <input
            type="number"
            min={1}
            step={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            aria-label="Order quantity"
          />
        </label>

        <div className="quick-qty">
          {[10, 25, 50, 100].map((n) => (
            <button type="button" key={n} onClick={() => setQty(String(n))}>
              {n}
            </button>
          ))}
        </div>

        <dl className="ticket-summary">
          <div>
            <dt>Order type</dt>
            <dd>Market</dd>
          </div>
          <div>
            <dt>Est. value</dt>
            <dd>{fmtMoney(estimate)}</dd>
          </div>
          <div>
            <dt>Commission</dt>
            <dd>{fmtMoney(COMMISSION_PER_ORDER)}</dd>
          </div>
          <div>
            <dt>Buying power</dt>
            <dd>{fmtMoney(cash)}</dd>
          </div>
        </dl>

        <button type="submit" className={`submit ${side}`}>
          {side === 'buy' ? 'Buy' : 'Sell'} {symbol}
        </button>
      </form>

      {flash && <p className={`flash ${flash.kind}`}>{flash.msg}</p>}
    </section>
  );
}
