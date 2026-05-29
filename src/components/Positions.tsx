import { useAccountStore } from '../store/useAccountStore';
import { useQuotesStore } from '../store/useQuotesStore';
import { marketValue, unrealizedPnL } from '../lib/portfolio';
import { fmtMoney, fmtPrice, fmtQty, fmtSignedMoney, signClass } from '../lib/format';
import type { Position } from '../types';

function PositionRow({ position }: { position: Position }) {
  const quote = useQuotesStore((s) => s.quotes[position.symbol]);
  const selectSymbol = useAccountStore((s) => s.selectSymbol);
  const placeOrder = useAccountStore((s) => s.placeOrder);

  const mark = quote?.price ?? position.avgPrice;
  const upnl = unrealizedPnL(position, mark);
  const mv = marketValue(position, mark);
  const isLong = position.quantity > 0;

  const close = () => {
    if (!quote) return;
    placeOrder({
      symbol: position.symbol,
      side: isLong ? 'sell' : 'buy',
      quantity: Math.abs(position.quantity),
      price: quote.price,
    });
  };

  return (
    <tr onClick={() => selectSymbol(position.symbol)}>
      <td className="ticker">{position.symbol}</td>
      <td className={isLong ? 'up' : 'down'}>
        {isLong ? 'LONG' : 'SHORT'} {fmtQty(Math.abs(position.quantity))}
      </td>
      <td>{fmtPrice(position.avgPrice)}</td>
      <td>{quote ? fmtPrice(mark) : '—'}</td>
      <td>{fmtMoney(mv)}</td>
      <td className={signClass(upnl)}>{fmtSignedMoney(upnl)}</td>
      <td className={signClass(position.realizedPnL)}>
        {fmtSignedMoney(position.realizedPnL)}
      </td>
      <td>
        <button
          className="close-btn"
          disabled={!quote}
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
        >
          Close
        </button>
      </td>
    </tr>
  );
}

export function Positions() {
  const positions = useAccountStore((s) => s.portfolio.positions);
  const open = Object.values(positions).filter((p) => p.quantity !== 0);
  const closedRealized = Object.values(positions)
    .filter((p) => p.quantity === 0)
    .reduce((sum, p) => sum + p.realizedPnL, 0);

  return (
    <section className="panel positions">
      <h2>
        Positions <span className="count">{open.length}</span>
      </h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Position</th>
              <th>Avg</th>
              <th>Last</th>
              <th>Mkt value</th>
              <th>Unreal. P&L</th>
              <th>Real. P&L</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {open.length === 0 && (
              <tr className="empty-row">
                <td colSpan={8}>No open positions.</td>
              </tr>
            )}
            {open.map((p) => (
              <PositionRow key={p.symbol} position={p} />
            ))}
          </tbody>
        </table>
      </div>
      {closedRealized !== 0 && (
        <p className="closed-pnl">
          Realized on closed positions:{' '}
          <span className={signClass(closedRealized)}>{fmtSignedMoney(closedRealized)}</span>
        </p>
      )}
    </section>
  );
}
