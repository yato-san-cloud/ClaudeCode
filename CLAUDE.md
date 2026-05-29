# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**US Day Trader** — a browser-based US stock day-trading paper-trading app
(Vite + React + TypeScript). It streams live or simulated quotes, renders
candlestick charts, and runs a virtual $100k account with long/short paper
trading and real-time P&L. See `README.md` for full docs.

## Commands

- Install: `npm install`
- Dev server: `npm run dev`
- Build (type-checks first): `npm run build`
- Tests: `npm test` (Vitest); single file: `npx vitest run src/lib/portfolio.test.ts`; watch: `npm run test:watch`
- Typecheck only: `npm run typecheck`
- Lint: `npm run lint`

## Architecture

- `src/lib/portfolio.ts` — pure trading/P&L engine (signed-quantity model
  supporting long & short, weighted-average cost, realized/unrealized P&L).
  All money math lives here and is unit-tested; keep it side-effect free.
- `src/market/` — pluggable market data. `SimulatedProvider` (default,
  API-key-free GBM simulator, deterministic via injectable RNG) and
  `FinnhubProvider` (real quotes via REST polling). `createProvider()` in
  `index.ts` selects based on `VITE_FINNHUB_TOKEN`.
- `src/store/` — Zustand stores: `useAccountStore` (persisted to localStorage:
  portfolio, watchlist, selection) and `useQuotesStore` (ephemeral live quotes).
- `src/components/` — UI (Header, Watchlist, Chart, OrderTicket, Positions,
  TradeHistory); `src/hooks/useMarketData.ts` wires the watchlist to the feed.

## Conventions

- Keep `portfolio.ts` pure and well-tested — it is the correctness core.
- Live quotes are high-frequency: never persist them; subscribe with narrow
  Zustand selectors so only affected rows re-render.
- Optional real data is configured via `.env` (`VITE_FINNHUB_TOKEN`); the app
  must always work with no env set (simulated feed).

## Git Workflow

- Active development branch for Claude-authored changes: `claude/add-claude-documentation-oNCDe`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
