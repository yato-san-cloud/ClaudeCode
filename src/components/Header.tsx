import { useMemo } from 'react';
import { useAccountStore } from '../store/useAccountStore';
import { useQuotesStore } from '../store/useQuotesStore';
import { equity, totalRealizedPnL, totalUnrealizedPnL } from '../lib/portfolio';
import { fmtMoney, fmtPercent, fmtSignedMoney, signClass } from '../lib/format';

interface Props {
  providerName: string;
}

export function Header({ providerName }: Props) {
  const portfolio = useAccountStore((s) => s.portfolio);
  const sessionStartEquity = useAccountStore((s) => s.sessionStartEquity);
  const resetAccount = useAccountStore((s) => s.resetAccount);
  const quotes = useQuotesStore((s) => s.quotes);

  const { totalEquity, cash, dayPnL, dayPnLPct, unreal, real } = useMemo(() => {
    const marks: Record<string, number> = {};
    for (const [sym, q] of Object.entries(quotes)) marks[sym] = q.price;
    const totalEquity = equity(portfolio, marks);
    const dayPnL = totalEquity - sessionStartEquity;
    return {
      totalEquity,
      cash: portfolio.cash,
      dayPnL,
      dayPnLPct: sessionStartEquity ? dayPnL / sessionStartEquity : 0,
      unreal: totalUnrealizedPnL(portfolio, marks),
      real: totalRealizedPnL(portfolio),
    };
  }, [portfolio, quotes, sessionStartEquity]);

  return (
    <header className="app-header">
      <div className="brand">
        <span className="logo">▲</span>
        <div>
          <h1>US Day Trader</h1>
          <span className="subtitle">Paper trading · {providerName} feed</span>
        </div>
      </div>

      <div className="stats">
        <Stat label="Equity" value={fmtMoney(totalEquity)} />
        <Stat label="Cash" value={fmtMoney(cash)} />
        <Stat
          label="Day P&L"
          value={`${fmtSignedMoney(dayPnL)} (${fmtPercent(dayPnLPct)})`}
          tone={signClass(dayPnL)}
        />
        <Stat label="Unrealized" value={fmtSignedMoney(unreal)} tone={signClass(unreal)} />
        <Stat label="Realized" value={fmtSignedMoney(real)} tone={signClass(real)} />
      </div>

      <button
        className="reset-btn"
        onClick={() => {
          if (confirm('Reset the paper account to $100,000 and clear all positions?')) {
            resetAccount();
          }
        }}
      >
        Reset
      </button>
    </header>
  );
}

function Stat({
  label,
  value,
  tone = 'flat',
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down' | 'flat';
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone}`}>{value}</span>
    </div>
  );
}
