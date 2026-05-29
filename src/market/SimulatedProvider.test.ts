import { afterEach, describe, expect, it, vi } from 'vitest';
import { mulberry32, normalFrom, SimulatedProvider } from './SimulatedProvider';
import type { Quote } from '../types';

describe('mulberry32 / normalFrom', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces finite normal samples', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      expect(Number.isFinite(normalFrom(rng))).toBe(true);
    }
  });
});

describe('SimulatedProvider', () => {
  afterEach(() => vi.useRealTimers());

  it('emits an initial quote on subscribe and updates on step', () => {
    const provider = new SimulatedProvider({ rng: mulberry32(1), tickMs: 1000 });
    const quotes: Quote[] = [];
    const unsub = provider.subscribe('AAPL', (q) => quotes.push(q));

    expect(quotes).toHaveLength(1);
    expect(quotes[0].symbol).toBe('AAPL');
    expect(quotes[0].price).toBeGreaterThan(0);

    provider.step();
    expect(quotes.length).toBeGreaterThanOrEqual(2);

    unsub();
    provider.dispose();
  });

  it('keeps prices positive across many steps', () => {
    const provider = new SimulatedProvider({ rng: mulberry32(99), tickMs: 1000 });
    let last: Quote | null = null;
    const unsub = provider.subscribe('NVDA', (q) => (last = q));
    for (let i = 0; i < 500; i++) provider.step();
    expect(last!.price).toBeGreaterThan(0);
    unsub();
    provider.dispose();
  });

  it('stops emitting after unsubscribe', () => {
    const provider = new SimulatedProvider({ rng: mulberry32(3), tickMs: 1000 });
    let count = 0;
    const unsub = provider.subscribe('SPY', () => count++);
    unsub();
    const before = count;
    provider.step();
    expect(count).toBe(before);
    provider.dispose();
  });

  it('returns ascending, anchored candles', async () => {
    const now = 1_700_000_000_000;
    const provider = new SimulatedProvider({ rng: mulberry32(5), now: () => now });
    const candles = await provider.getCandles('AAPL', 60);
    expect(candles).toHaveLength(60);
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i].time).toBeGreaterThan(candles[i - 1].time);
      expect(candles[i].high).toBeGreaterThanOrEqual(candles[i].low);
    }
    // Most recent close anchors to the live (seed) price.
    expect(candles[candles.length - 1].close).toBeCloseTo(195, 1);
    provider.dispose();
  });

  it('does not start a real timer when only stepping manually', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const provider = new SimulatedProvider({ rng: mulberry32(2), tickMs: 1000 });
    // No subscription -> no interval scheduled.
    provider.step();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    provider.dispose();
  });
});
