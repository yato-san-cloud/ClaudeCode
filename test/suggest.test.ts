import { describe, expect, it } from 'vitest';
import {
  EMA_ALPHA,
  frequencyScore,
  inferShoppingDow,
  stalenessRatio,
  suggestItems,
  updateInterval,
  usualItems,
  type CatalogSnapshot,
} from '../src/domain/suggest';
import { DAY_MS } from '../src/util/time';

const NOW = Date.UTC(2026, 6, 26, 3, 0, 0); // 2026-07-26 12:00 JST

function item(overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    id: 'ci_1',
    canonical_name: '牛乳',
    category: 'dairy',
    default_unit: '本',
    default_quantity: 2,
    purchase_count: 5,
    last_purchased_at: NOW - 10 * DAY_MS,
    mean_interval_days: 10,
    interval_samples: 4,
    ...overrides,
  };
}

describe('updateInterval', () => {
  it('初回の観測はそのまま平均になる', () => {
    const result = updateInterval(null, 0, NOW - 7 * DAY_MS, NOW);
    expect(result.mean).toBeCloseTo(7, 5);
    expect(result.samples).toBe(1);
  });

  it('2回目以降は指数移動平均で寄せる', () => {
    const result = updateInterval(10, 3, NOW - 14 * DAY_MS, NOW);
    expect(result.mean).toBeCloseTo(10 * (1 - EMA_ALPHA) + 14 * EMA_ALPHA, 5);
    expect(result.samples).toBe(4);
  });

  it('前回購入が無ければ学習しない', () => {
    expect(updateInterval(null, 0, null, NOW)).toEqual({ mean: null, samples: 0 });
  });

  it('同日中の重複記録は学習に使わない', () => {
    const result = updateInterval(10, 3, NOW - 2 * 60 * 60 * 1000, NOW);
    expect(result).toEqual({ mean: 10, samples: 3 });
  });

  it('極端に長い間隔で平均を汚さない', () => {
    const result = updateInterval(10, 3, NOW - 400 * DAY_MS, NOW);
    expect(result).toEqual({ mean: 10, samples: 3 });
  });
});

describe('stalenessRatio', () => {
  it('周期ちょうどで 1.0', () => {
    expect(stalenessRatio(item(), NOW)).toBeCloseTo(1, 5);
  });

  it('周期の半分なら 0.5', () => {
    expect(stalenessRatio(item({ last_purchased_at: NOW - 5 * DAY_MS }), NOW)).toBeCloseTo(0.5, 5);
  });

  it('周期が未学習なら null', () => {
    expect(stalenessRatio(item({ mean_interval_days: null }), NOW)).toBeNull();
  });
});

describe('frequencyScore', () => {
  it('0回なら 0', () => {
    expect(frequencyScore(0)).toBe(0);
  });

  it('回数が増えるほど上がるが 1 を超えない', () => {
    expect(frequencyScore(1)).toBeLessThan(frequencyScore(5));
    expect(frequencyScore(5)).toBeLessThan(frequencyScore(20));
    expect(frequencyScore(1000)).toBeLessThanOrEqual(1);
  });
});

describe('suggestItems', () => {
  it('周期が来ているものを上位に出す', () => {
    const overdue = item({ id: 'overdue', canonical_name: '牛乳', last_purchased_at: NOW - 12 * DAY_MS });
    const fresh = item({ id: 'fresh', canonical_name: '米', last_purchased_at: NOW - 1 * DAY_MS });

    const result = suggestItems([fresh, overdue], { now: NOW });
    expect(result[0]?.item.id).toBe('overdue');
  });

  it('まだ買ったばかりのものは出さない', () => {
    const fresh = item({ last_purchased_at: NOW - 1 * DAY_MS, purchase_count: 3 });
    expect(suggestItems([fresh], { now: NOW })).toHaveLength(0);
  });

  it('すでにリストにあるものは除外する', () => {
    const result = suggestItems([item()], { now: NOW, excludeIds: new Set(['ci_1']) });
    expect(result).toHaveLength(0);
  });

  it('理由に周期と経過を書く', () => {
    const result = suggestItems([item({ last_purchased_at: NOW - 15 * DAY_MS })], { now: NOW });
    expect(result[0]?.reason).toContain('10日周期');
  });

  it('周期未学習でも購入回数が多ければ候補に残る', () => {
    const frequent = item({
      mean_interval_days: null,
      interval_samples: 0,
      purchase_count: 15,
      last_purchased_at: NOW - 3 * DAY_MS,
    });
    const result = suggestItems([frequent], { now: NOW, minScore: 0.3 });
    expect(result).toHaveLength(1);
  });

  it('limit を超えない', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      item({ id: `ci_${i}`, last_purchased_at: NOW - 20 * DAY_MS }),
    );
    expect(suggestItems(many, { now: NOW, limit: 5 })).toHaveLength(5);
  });
});

describe('usualItems', () => {
  it('直近の買い物の半分以上に出てくるものを定番とみなす', () => {
    const milk = item({ id: 'milk' });
    const wine = item({ id: 'wine' });
    const counts = new Map([
      ['milk', 6],
      ['wine', 1],
    ]);

    const result = usualItems([milk, wine], counts, 8);
    expect(result.map((row) => row.id)).toEqual(['milk']);
  });

  it('登場が1回だけなら定番にしない', () => {
    const counts = new Map([['ci_1', 1]]);
    expect(usualItems([item()], counts, 2)).toHaveLength(0);
  });

  it('履歴が無ければ空', () => {
    expect(usualItems([item()], new Map(), 0)).toHaveLength(0);
  });
});

describe('inferShoppingDow', () => {
  it('偏りがあれば最頻の曜日を返す', () => {
    // 土曜(6)が多い
    expect(inferShoppingDow([6, 6, 6, 2, 6, 3])).toBe(6);
  });

  it('サンプルが少なすぎれば null', () => {
    expect(inferShoppingDow([6, 6])).toBeNull();
  });

  it('バラけていれば null', () => {
    expect(inferShoppingDow([0, 1, 2, 3, 4, 5, 6])).toBeNull();
  });
});
