# US Day Trader — Paper Trading Terminal

A browser-based **US stock day-trading simulator**. Track live (or simulated)
quotes, watch candlestick charts, place market orders against a virtual
$100,000 account, and follow your P&L in real time — no brokerage, no risk.

> ⚠️ For education and practice only. Prices in the default mode are
> **synthetic** (a random-walk simulation), and even with a real data feed this
> app does **not** place real trades. Nothing here is financial advice.

## Features

- **Live quotes** — a built-in geometric-Brownian-motion simulator streams
  per-second ticks with no API key required. Plug in a [Finnhub](https://finnhub.io)
  token to use real US market quotes instead.
- **Watchlist** — add/remove tickers; color-coded last price and day change.
- **Candlestick + volume chart** — 1-minute bars that update live as quotes arrive
  (powered by [lightweight-charts](https://github.com/tradingview/lightweight-charts)).
- **Paper trading** — market buy/sell with buying-power checks and a flat
  commission. Supports both **long and short** positions.
- **P&L** — per-position average cost, unrealized & realized P&L, market value,
  plus account equity and day P&L in the header. One-click **Close** for any position.
- **Order history** and **persistence** — your account, positions, and watchlist
  survive page reloads via `localStorage`.

## Getting started

```bash
npm install
npm run dev      # start the dev server (http://localhost:5173)
```

The app runs fully offline using the simulated feed.

### Optional: real-time quotes via Finnhub

```bash
cp .env.example .env
# then set VITE_FINNHUB_TOKEN=your_token in .env
```

When `VITE_FINNHUB_TOKEN` is set, quotes are polled live from Finnhub. (Finnhub's
free tier no longer serves intraday candles, so chart history is synthesized
around the latest real price; the streaming quote itself is real.)

## Scripts

| Command             | Description                              |
| ------------------- | ---------------------------------------- |
| `npm run dev`       | Start the Vite dev server                |
| `npm run build`     | Type-check and build for production      |
| `npm run preview`   | Preview the production build             |
| `npm test`          | Run the unit test suite (Vitest)         |
| `npm run typecheck` | Type-check without emitting              |
| `npm run lint`      | Lint with ESLint                         |

## Architecture

```
src/
  types.ts                 Shared domain types (Quote, Candle, Order, Position…)
  lib/
    portfolio.ts           Pure trading/P&L engine (long+short, signed quantity)
    format.ts              Money / percent / time formatters
  market/
    types.ts               MarketDataProvider interface
    SimulatedProvider.ts   API-key-free GBM price simulator (deterministic, seedable)
    FinnhubProvider.ts      Real quotes via Finnhub REST polling
    index.ts               Provider factory (env-driven selection)
    symbols.ts             Seed universe of liquid US tickers
  store/
    useAccountStore.ts     Persisted account state + order actions (Zustand)
    useQuotesStore.ts      Ephemeral live quotes (Zustand)
  hooks/useMarketData.ts   Subscribes the watchlist to the active provider
  components/              Header, Watchlist, Chart, OrderTicket, Positions, TradeHistory
  App.tsx                  Three-column trading-terminal layout
```

**Data flow:** `MarketDataProvider` → `useMarketData` → `useQuotesStore` →
components. Orders go through `useAccountStore.placeOrder` → the pure
`applyFill` engine → persisted portfolio. Keeping the money math in a pure,
side-effect-free module makes it thoroughly unit-testable (see
`src/lib/portfolio.test.ts`).

## Testing

The trading engine is covered by unit tests for opening, averaging, partial
closes, full round-trips, long→short flips, short covers, validation, and
mark-to-market valuation. The simulator is tested for determinism, positivity,
and subscription lifecycle.

```bash
npm test
```
