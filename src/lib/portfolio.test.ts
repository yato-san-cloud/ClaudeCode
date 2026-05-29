import { describe, expect, it } from 'vitest';
import {
  applyFill,
  COMMISSION_PER_ORDER,
  createPortfolio,
  equity,
  INITIAL_CASH,
  totalRealizedPnL,
  unrealizedPnL,
} from './portfolio';

describe('applyFill — long lifecycle', () => {
  it('opens a long position and debits cash + commission', () => {
    const p = createPortfolio();
    const r = applyFill(p, { symbol: 'AAPL', side: 'buy', quantity: 10, price: 100 });
    expect(r.ok).toBe(true);
    expect(r.portfolio.cash).toBe(INITIAL_CASH - 1000 - COMMISSION_PER_ORDER);
    const pos = r.portfolio.positions.AAPL;
    expect(pos.quantity).toBe(10);
    expect(pos.avgPrice).toBe(100);
    expect(r.portfolio.orders).toHaveLength(1);
  });

  it('blends the average price when adding to a long', () => {
    let p = createPortfolio();
    p = applyFill(p, { symbol: 'AAPL', side: 'buy', quantity: 10, price: 100 }).portfolio;
    p = applyFill(p, { symbol: 'AAPL', side: 'buy', quantity: 10, price: 120 }).portfolio;
    const pos = p.positions.AAPL;
    expect(pos.quantity).toBe(20);
    expect(pos.avgPrice).toBe(110);
  });

  it('realizes P&L on a partial close without changing the average', () => {
    let p = createPortfolio();
    p = applyFill(p, { symbol: 'AAPL', side: 'buy', quantity: 10, price: 100 }).portfolio;
    p = applyFill(p, { symbol: 'AAPL', side: 'sell', quantity: 4, price: 110 }).portfolio;
    const pos = p.positions.AAPL;
    expect(pos.quantity).toBe(6);
    expect(pos.avgPrice).toBe(100);
    // +40 gain minus two $1 commissions = 38
    expect(pos.realizedPnL).toBeCloseTo(38, 6);
  });

  it('reconciles realized P&L with cash flows on a full round-trip', () => {
    let p = createPortfolio();
    p = applyFill(p, { symbol: 'AAPL', side: 'buy', quantity: 10, price: 100 }).portfolio;
    p = applyFill(p, { symbol: 'AAPL', side: 'sell', quantity: 4, price: 110 }).portfolio;
    p = applyFill(p, { symbol: 'AAPL', side: 'sell', quantity: 6, price: 90 }).portfolio;
    const pos = p.positions.AAPL;
    expect(pos.quantity).toBe(0);
    expect(pos.avgPrice).toBe(0);
    // shares P&L (980 - 1000) - 3 commissions = -23
    expect(pos.realizedPnL).toBeCloseTo(-23, 6);
    expect(p.cash).toBeCloseTo(INITIAL_CASH - 23, 6);
  });
});

describe('applyFill — shorting and flips', () => {
  it('flips from long to short and anchors the new average', () => {
    let p = createPortfolio();
    p = applyFill(p, { symbol: 'TSLA', side: 'buy', quantity: 10, price: 100 }).portfolio;
    p = applyFill(p, { symbol: 'TSLA', side: 'sell', quantity: 30, price: 120 }).portfolio;
    const pos = p.positions.TSLA;
    expect(pos.quantity).toBe(-20);
    expect(pos.avgPrice).toBe(120);
    // closed 10 longs for +200, minus 2 commissions
    expect(pos.realizedPnL).toBeCloseTo(198, 6);
  });

  it('covers a short for a gain and reconciles cash', () => {
    let p = createPortfolio();
    p = applyFill(p, { symbol: 'TSLA', side: 'buy', quantity: 10, price: 100 }).portfolio;
    p = applyFill(p, { symbol: 'TSLA', side: 'sell', quantity: 30, price: 120 }).portfolio;
    p = applyFill(p, { symbol: 'TSLA', side: 'buy', quantity: 20, price: 110 }).portfolio;
    const pos = p.positions.TSLA;
    expect(pos.quantity).toBe(0);
    expect(pos.realizedPnL).toBeCloseTo(397, 6);
    expect(p.cash).toBeCloseTo(INITIAL_CASH + 397, 6);
  });
});

describe('applyFill — validation', () => {
  it('rejects orders that exceed buying power', () => {
    const p = createPortfolio();
    const r = applyFill(p, { symbol: 'AAPL', side: 'buy', quantity: 2000, price: 100 });
    expect(r.ok).toBe(false);
    expect(r.portfolio).toBe(p);
  });

  it('rejects non-positive quantities and bad prices', () => {
    const p = createPortfolio();
    expect(applyFill(p, { symbol: 'AAPL', side: 'buy', quantity: 0, price: 100 }).ok).toBe(
      false,
    );
    expect(applyFill(p, { symbol: 'AAPL', side: 'buy', quantity: 5, price: 0 }).ok).toBe(
      false,
    );
  });

  it('floors fractional share quantities', () => {
    const p = createPortfolio();
    const r = applyFill(p, { symbol: 'AAPL', side: 'buy', quantity: 10.9, price: 100 });
    expect(r.portfolio.positions.AAPL.quantity).toBe(10);
  });
});

describe('valuation helpers', () => {
  it('computes unrealized P&L for longs and shorts symmetrically', () => {
    expect(unrealizedPnL({ symbol: 'X', quantity: 10, avgPrice: 100, realizedPnL: 0 }, 105)).toBe(
      50,
    );
    expect(
      unrealizedPnL({ symbol: 'X', quantity: -10, avgPrice: 100, realizedPnL: 0 }, 95),
    ).toBe(50);
  });

  it('marks total equity to market', () => {
    let p = createPortfolio();
    p = applyFill(p, { symbol: 'AAPL', side: 'buy', quantity: 10, price: 100 }).portfolio;
    expect(equity(p, { AAPL: 110 })).toBeCloseTo(INITIAL_CASH - 1 + 100, 6);
  });

  it('sums realized P&L across symbols', () => {
    let p = createPortfolio();
    p = applyFill(p, { symbol: 'AAPL', side: 'buy', quantity: 10, price: 100 }).portfolio;
    p = applyFill(p, { symbol: 'AAPL', side: 'sell', quantity: 10, price: 110 }).portfolio;
    expect(totalRealizedPnL(p)).toBeCloseTo(98, 6); // +100 - 2 commissions
  });
});
