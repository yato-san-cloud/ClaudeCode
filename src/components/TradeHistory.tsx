import { useAccountStore } from '../store/useAccountStore';
import { fmtPrice, fmtQty, fmtTime } from '../lib/format';

export function TradeHistory() {
  const orders = useAccountStore((s) => s.portfolio.orders);

  return (
    <section className="panel history">
      <h2>
        Order history <span className="count">{orders.length}</span>
      </h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Side</th>
              <th>Symbol</th>
              <th>Qty</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 && (
              <tr className="empty-row">
                <td colSpan={5}>No orders yet.</td>
              </tr>
            )}
            {orders.slice(0, 100).map((o) => (
              <tr key={o.id}>
                <td>{fmtTime(o.time)}</td>
                <td className={o.side === 'buy' ? 'up' : 'down'}>{o.side.toUpperCase()}</td>
                <td className="ticker">{o.symbol}</td>
                <td>{fmtQty(o.quantity)}</td>
                <td>{fmtPrice(o.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
