import type { Order, Portfolio, Position, Side } from '../types';

/** Commission charged per filled order (flat fee, simplified). */
export const COMMISSION_PER_ORDER = 1;

export const INITIAL_CASH = 100_000;

export function createPortfolio(cash: number = INITIAL_CASH): Portfolio {
  return { cash, positions: {}, orders: [] };
}

function emptyPosition(symbol: string): Position {
  return { symbol, quantity: 0, avgPrice: 0, realizedPnL: 0 };
}

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

export interface FillRequest {
  symbol: string;
  side: Side;
  /** Positive share count. */
  quantity: number;
  /** Fill price per share. */
  price: number;
  time?: number;
  commission?: number;
}

export interface FillResult {
  ok: boolean;
  reason?: string;
  portfolio: Portfolio;
  order?: Order;
}

/**
 * Apply a market fill to a portfolio, returning a new portfolio (pure).
 *
 * Supports long and short positions using a signed-quantity model with a
 * weighted-average entry price. Reducing or flipping a position realizes P&L
 * on the closed portion. Commission is deducted from cash and folded into
 * realized P&L so the books always balance.
 */
export function applyFill(portfolio: Portfolio, req: FillRequest): FillResult {
  const quantity = Math.floor(req.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, reason: 'Quantity must be a positive whole number.', portfolio };
  }
  if (!Number.isFinite(req.price) || req.price <= 0) {
    return { ok: false, reason: 'Invalid price.', portfolio };
  }

  const commission = req.commission ?? COMMISSION_PER_ORDER;
  // Signed trade quantity: buys add shares, sells remove them.
  const tradeQty = req.side === 'buy' ? quantity : -quantity;
  // Cash impact of the shares: buying spends cash, selling/shorting raises it.
  const cashFromShares = -tradeQty * req.price;
  const newCash = portfolio.cash + cashFromShares - commission;

  if (newCash < 0) {
    return {
      ok: false,
      reason: 'Insufficient buying power for this order.',
      portfolio,
    };
  }

  const prev = portfolio.positions[req.symbol] ?? emptyPosition(req.symbol);
  const next = updatePosition(prev, tradeQty, req.price, commission);

  const order: Order = {
    id:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    symbol: req.symbol,
    side: req.side,
    quantity,
    price: req.price,
    commission,
    time: req.time ?? Date.now(),
  };

  const positions = { ...portfolio.positions };
  if (next.quantity === 0 && next.realizedPnL === 0) {
    delete positions[req.symbol];
  } else {
    positions[req.symbol] = next;
  }

  return {
    ok: true,
    order,
    portfolio: {
      cash: newCash,
      positions,
      orders: [order, ...portfolio.orders],
    },
  };
}

/**
 * Update a single position with a signed trade. Pure helper exported for tests.
 */
export function updatePosition(
  prev: Position,
  tradeQty: number,
  price: number,
  commission: number,
): Position {
  const prevQty = prev.quantity;
  const newQty = prevQty + tradeQty;
  let avgPrice = prev.avgPrice;
  let realizedPnL = prev.realizedPnL - commission;

  if (prevQty === 0 || sign(prevQty) === sign(tradeQty)) {
    // Opening or increasing the position in the same direction: blend cost.
    const prevAbs = Math.abs(prevQty);
    const tradeAbs = Math.abs(tradeQty);
    avgPrice = (prev.avgPrice * prevAbs + price * tradeAbs) / (prevAbs + tradeAbs);
  } else {
    // Reducing, closing, or flipping the position: realize P&L on the closed part.
    const closingQty = Math.min(Math.abs(tradeQty), Math.abs(prevQty));
    // For a long (prevQty>0) profit = (price - avg); for a short the sign flips.
    realizedPnL += closingQty * (price - prev.avgPrice) * sign(prevQty);

    if (sign(newQty) === -sign(prevQty)) {
      // Flipped through zero: the remainder opens a fresh position at `price`.
      avgPrice = price;
    } else if (newQty === 0) {
      avgPrice = 0;
    }
    // Otherwise (partial reduction) the average entry price is unchanged.
  }

  return {
    symbol: prev.symbol,
    quantity: newQty,
    avgPrice: newQty === 0 ? 0 : avgPrice,
    realizedPnL,
  };
}

/** Unrealized P&L for a position given the current mark price. */
export function unrealizedPnL(position: Position, markPrice: number): number {
  if (position.quantity === 0) return 0;
  return (markPrice - position.avgPrice) * position.quantity;
}

/** Current market value (signed) of a position. */
export function marketValue(position: Position, markPrice: number): number {
  return position.quantity * markPrice;
}

/**
 * Total account equity = cash + mark-to-market value of all open positions.
 * `marks` maps symbol -> current price.
 */
export function equity(portfolio: Portfolio, marks: Record<string, number>): number {
  let total = portfolio.cash;
  for (const pos of Object.values(portfolio.positions)) {
    const mark = marks[pos.symbol];
    if (pos.quantity !== 0 && Number.isFinite(mark)) {
      total += marketValue(pos, mark);
    }
  }
  return total;
}

/** Total realized P&L across all symbols. */
export function totalRealizedPnL(portfolio: Portfolio): number {
  return Object.values(portfolio.positions).reduce((sum, p) => sum + p.realizedPnL, 0);
}

/** Total unrealized P&L across open positions. */
export function totalUnrealizedPnL(
  portfolio: Portfolio,
  marks: Record<string, number>,
): number {
  let total = 0;
  for (const pos of Object.values(portfolio.positions)) {
    const mark = marks[pos.symbol];
    if (Number.isFinite(mark)) total += unrealizedPnL(pos, mark);
  }
  return total;
}
