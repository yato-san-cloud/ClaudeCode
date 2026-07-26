import { describe, expect, it } from 'vitest';
import {
  CONFIDENT_TRIPS,
  DEFAULT_ROUTE,
  PROMOTE_VOTES,
  ROUTE_EMA_ALPHA,
  categorySequence,
  inferCategoryFromNeighbors,
  normalizedPosition,
  precedencePairs,
  rankCategories,
  routeOrder,
  routeProgress,
  sortByCheckoff,
  updateCategoryVote,
  updateRoutePosition,
  type PrecedenceCount,
} from '../src/domain/route';

/** 買い物1回ぶんの観測を前後関係の集計に変換する */
function observe(...trips: string[][]): PrecedenceCount[] {
  const counts = new Map<string, number>();
  for (const trip of trips) {
    for (const [before, after] of precedencePairs(categorySequence(trip))) {
      const key = `${before}>${after}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([key, count]) => {
    const [before, after] = key.split('>');
    return { before: before!, after: after!, count };
  });
}

describe('sortByCheckoff', () => {
  it('チェック時刻の順に並べる', () => {
    const items = [
      { id: 'b', checked_at: 200, position: 1 },
      { id: 'a', checked_at: 100, position: 2 },
    ];
    expect(sortByCheckoff(items).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('未チェックは末尾に回す', () => {
    const items = [
      { id: 'none', checked_at: null, position: 1 },
      { id: 'checked', checked_at: 500, position: 2 },
    ];
    expect(sortByCheckoff(items).map((i) => i.id)).toEqual(['checked', 'none']);
  });

  it('同時刻なら元の並び順で決める', () => {
    const items = [
      { id: 'second', checked_at: 100, position: 2 },
      { id: 'first', checked_at: 100, position: 1 },
    ];
    expect(sortByCheckoff(items).map((i) => i.id)).toEqual(['first', 'second']);
  });

  it('元の配列を破壊しない', () => {
    const items = [
      { id: 'b', checked_at: 200, position: 1 },
      { id: 'a', checked_at: 100, position: 2 },
    ];
    sortByCheckoff(items);
    expect(items.map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('categorySequence', () => {
  it('初出の順に売り場を並べる', () => {
    expect(categorySequence(['produce', 'produce', 'meat', 'dairy'])).toEqual([
      'produce',
      'meat',
      'dairy',
    ]);
  });

  it('買い忘れて引き返した1回で順路を壊さない', () => {
    // 乳製品 → 精肉 → 乳製品に戻った、というケース
    expect(categorySequence(['dairy', 'meat', 'dairy'])).toEqual(['dairy', 'meat']);
  });

  it('その他は順路の証拠にしない', () => {
    expect(categorySequence(['produce', 'other', 'dairy'])).toEqual(['produce', 'dairy']);
  });
});

describe('precedencePairs', () => {
  it('全順序ペアを列挙する', () => {
    expect(precedencePairs(['a', 'b', 'c'])).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
  });

  it('1件だけならペアは無い', () => {
    expect(precedencePairs(['a'])).toEqual([]);
  });
});

describe('rankCategories', () => {
  it('観測が無ければ既定順路のまま', () => {
    expect(rankCategories([], DEFAULT_ROUTE)).toEqual([...DEFAULT_ROUTE]);
  });

  it('渡した売り場だけを返す', () => {
    expect(rankCategories([], ['dairy', 'produce'])).toEqual(['produce', 'dairy']);
  });

  it('一貫して逆順に消し込めば順路がひっくり返る', () => {
    // 既定は 野菜 → 乳製品。この店は入口が乳製品側だとする。
    const reversed = Array.from({ length: 6 }, () => ['dairy', 'produce']);
    const ranked = rankCategories(observe(...reversed), ['produce', 'dairy']);
    expect(ranked).toEqual(['dairy', 'produce']);
  });

  it('観測1回だけでは既定順路を覆さない', () => {
    // 事前分布 (PRIOR_STRENGTH=3) が効いて、単発のブレでは動かない
    const ranked = rankCategories(observe(['dairy', 'produce']), ['produce', 'dairy']);
    expect(ranked).toEqual(['produce', 'dairy']);
  });

  it('観測が無い売り場も落とさず既定の位置に置く', () => {
    const ranked = rankCategories(observe(['dairy', 'produce']), ['dairy', 'produce', 'bakery']);
    expect(new Set(ranked)).toEqual(new Set(['dairy', 'produce', 'bakery']));
  });

  it('回る範囲が違う買い物が混ざっても偏らない', () => {
    // 野菜と乳製品しか買わなかった日が多くても、乳製品が末尾に引っ張られては
    // いけない。生の回数で足すとここが壊れる (ペアごとに比率へ正規化している)。
    const trips = [
      ['produce', 'dairy'],
      ['produce', 'dairy'],
      ['produce', 'dairy'],
      ['produce', 'meat', 'dairy', 'household', 'cleaning'],
    ];
    const present = ['produce', 'meat', 'dairy', 'household', 'cleaning'];
    const ranked = rankCategories(observe(...trips), present);
    expect(ranked).toEqual(['produce', 'meat', 'dairy', 'household', 'cleaning']);
  });

  it('店のレイアウトを学習しきる', () => {
    // 日用品が入口すぐ、野菜が最後、という既定と大きく違う店を8回ぶん観測する
    const layout = ['household', 'cleaning', 'dairy', 'meat', 'produce'];
    const trips = Array.from({ length: 8 }, () => layout);
    expect(rankCategories(observe(...trips), layout)).toEqual(layout);
  });

  it('リストに載っていない売り場の観測に引きずられない', () => {
    // 精肉と鮮魚を毎回逆順で回っていても、それらが載っていない日の
    // 野菜と乳製品の並びには影響しない
    const trips = Array.from({ length: 8 }, () => ['seafood', 'meat']);
    expect(rankCategories(observe(...trips), ['produce', 'dairy'])).toEqual([
      'produce',
      'dairy',
    ]);
  });
});

describe('routeOrder', () => {
  it('その他があれば最後に置く', () => {
    expect(routeOrder([], ['other', 'dairy', 'produce'])).toEqual([
      'produce',
      'dairy',
      'other',
    ]);
  });

  it('その他が無ければ足さない', () => {
    expect(routeOrder([], ['dairy', 'produce'])).toEqual(['produce', 'dairy']);
  });

  it('その他は学習で前に出てこない', () => {
    // その他は店中の品物が混ざる寄せ集めなので、位置を学習させない
    const trips = Array.from({ length: 8 }, () => ['other', 'produce', 'dairy']);
    const order = routeOrder(observe(...trips), ['other', 'produce', 'dairy']);
    expect(order[order.length - 1]).toBe('other');
  });
});

describe('normalizedPosition', () => {
  it('先頭が0、末尾が1', () => {
    expect(normalizedPosition(0, 5)).toBe(0);
    expect(normalizedPosition(4, 5)).toBe(1);
  });

  it('1件だけなら真ん中扱い', () => {
    expect(normalizedPosition(0, 1)).toBe(0.5);
  });
});

describe('updateRoutePosition', () => {
  it('初回はそのまま採用する', () => {
    expect(updateRoutePosition(null, 0, 0.4)).toEqual({ position: 0.4, samples: 1 });
  });

  it('2回目以降は指数移動平均で寄せる', () => {
    const result = updateRoutePosition(0.2, 3, 0.6);
    expect(result.position).toBeCloseTo(0.2 * (1 - ROUTE_EMA_ALPHA) + 0.6 * ROUTE_EMA_ALPHA, 5);
    expect(result.samples).toBe(4);
  });
});

describe('inferCategoryFromNeighbors', () => {
  it('前後が同じ売り場ならそこに寄せる', () => {
    const categories = ['dairy', 'other', 'dairy'];
    expect(inferCategoryFromNeighbors(categories, 1)).toBe('dairy');
  });

  it('売り場の境目なら直前に寄せる', () => {
    const categories = ['meat', 'other', 'dairy'];
    expect(inferCategoryFromNeighbors(categories, 1)).toBe('meat');
  });

  it('先頭で拾ったものは後ろの売り場に寄せる', () => {
    const categories = ['other', 'produce', 'dairy'];
    expect(inferCategoryFromNeighbors(categories, 0)).toBe('produce');
  });

  it('その他しか無ければ推定しない', () => {
    expect(inferCategoryFromNeighbors(['other', 'other'], 0)).toBeNull();
  });

  it('間にその他が挟まっていても飛ばして見る', () => {
    const categories = ['dairy', 'other', 'other', 'dairy'];
    expect(inferCategoryFromNeighbors(categories, 1)).toBe('dairy');
  });
});

describe('updateCategoryVote', () => {
  it('初回は候補をそのまま採用する', () => {
    expect(updateCategoryVote(null, 0, 'dairy')).toEqual({ category: 'dairy', votes: 1 });
  });

  it('一致すれば加点する', () => {
    expect(updateCategoryVote('dairy', 2, 'dairy')).toEqual({ category: 'dairy', votes: 3 });
  });

  it('食い違えば減点する（すぐには乗り換えない）', () => {
    expect(updateCategoryVote('dairy', 2, 'meat')).toEqual({ category: 'dairy', votes: 1 });
  });

  it('票が尽きたら候補を乗り換える', () => {
    const after = updateCategoryVote('dairy', 1, 'meat');
    expect(after).toEqual({ category: 'dairy', votes: 0 });
    expect(updateCategoryVote(after.category, after.votes, 'meat')).toEqual({
      category: 'meat',
      votes: 1,
    });
  });

  it('一貫していれば PROMOTE_VOTES 回で昇格ラインに届く', () => {
    let vote = { category: null as string | null, votes: 0 };
    for (let i = 0; i < PROMOTE_VOTES; i++) {
      vote = updateCategoryVote(vote.category, vote.votes, 'dairy');
    }
    expect(vote.votes).toBeGreaterThanOrEqual(PROMOTE_VOTES);
  });

  it('毎回ぶれる品物は昇格しない', () => {
    let vote = { category: null as string | null, votes: 0 };
    for (const candidate of ['dairy', 'meat', 'dairy', 'produce', 'dairy', 'meat']) {
      vote = updateCategoryVote(vote.category, vote.votes, candidate);
      expect(vote.votes).toBeLessThan(PROMOTE_VOTES);
    }
  });
});

describe('routeProgress', () => {
  it('観測ゼロなら未学習', () => {
    expect(routeProgress(0)).toEqual({ trips: 0, learned: false, remaining: CONFIDENT_TRIPS });
  });

  it('規定回数に達したら学習済み', () => {
    expect(routeProgress(CONFIDENT_TRIPS).learned).toBe(true);
    expect(routeProgress(CONFIDENT_TRIPS).remaining).toBe(0);
  });

  it('残り回数が負にならない', () => {
    expect(routeProgress(CONFIDENT_TRIPS + 10).remaining).toBe(0);
  });
});
