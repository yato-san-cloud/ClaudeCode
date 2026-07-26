import { describe, expect, it } from 'vitest';
import {
  MIN_BASKETS,
  findCompanions,
  groupIntoBaskets,
  type Basket,
} from '../src/domain/basket';

/** 「1回の買い物でこれを買った」を並べるだけの読みやすいヘルパ */
function trips(...lists: string[][]): Basket[] {
  return lists.map((itemIds, index) => ({ listId: `sl_${index}`, itemIds }));
}

const onList = (...ids: string[]) => new Set(ids);

describe('groupIntoBaskets', () => {
  it('list_id ごとにカゴへまとめる', () => {
    const baskets = groupIntoBaskets([
      { listId: 'a', itemId: '牛乳' },
      { listId: 'a', itemId: 'パン' },
      { listId: 'b', itemId: '卵' },
    ]);
    expect(baskets).toHaveLength(2);
    expect(baskets.find((b) => b.listId === 'a')?.itemIds).toEqual(['牛乳', 'パン']);
  });

  it('履歴が無ければ空', () => {
    expect(groupIntoBaskets([])).toEqual([]);
  });
});

describe('findCompanions', () => {
  it('いつも一緒に買うのに今日入っていないものを見つける', () => {
    // カレーの日は必ず ルー・じゃがいも・にんじん が揃う
    const baskets = trips(
      ['ルー', 'じゃがいも', 'にんじん'],
      ['ルー', 'じゃがいも', 'にんじん'],
      ['ルー', 'じゃがいも', 'にんじん'],
      ['ルー', 'じゃがいも', 'にんじん'],
      ['パン', '牛乳'],
      ['パン', '卵'],
      ['米', '醤油'],
      ['パン', '米'],
    );

    // 今日はルーとにんじんだけ入れた
    const found = findCompanions(baskets, { onList: onList('ルー', 'にんじん') });
    expect(found.map((c) => c.itemId)).toEqual(['じゃがいも']);
    expect(found[0]!.confidence).toBe(1);
    expect(found[0]!.together).toBe(4);
  });

  it('すでにリストにあるものは出さない', () => {
    const baskets = trips(
      ['ルー', 'じゃがいも'],
      ['ルー', 'じゃがいも'],
      ['ルー', 'じゃがいも'],
      ['パン'],
    );
    const found = findCompanions(baskets, { onList: onList('ルー', 'じゃがいも') });
    expect(found).toEqual([]);
  });

  it('毎回買う常連は出さない（「いつもの」の担当なので）', () => {
    // 牛乳は全部の買い物に入っている。ルーとの結びつきではない。
    const baskets = trips(
      ['ルー', '牛乳'],
      ['ルー', '牛乳'],
      ['ルー', '牛乳'],
      ['パン', '牛乳'],
      ['米', '牛乳'],
      ['卵', '牛乳'],
    );
    const found = findCompanions(baskets, { onList: onList('ルー') });
    expect(found.map((c) => c.itemId)).not.toContain('牛乳');
  });

  it('たまたま一緒だっただけの組み合わせは出さない', () => {
    // じゃがいもは半分の買い物に入るが、ルーとの結びつきは無い
    const baskets = trips(
      ['ルー', 'じゃがいも'],
      ['ルー', 'パン'],
      ['ルー', '卵'],
      ['ルー', '米'],
      ['じゃがいも', 'パン'],
      ['じゃがいも', '卵'],
      ['じゃがいも', '米'],
      ['じゃがいも', '醤油'],
    );
    const found = findCompanions(baskets, { onList: onList('ルー') });
    // 確信度 1/4 = 0.25 なので閾値に届かない
    expect(found).toEqual([]);
  });

  it('履歴が少なすぎるうちは何も言わない', () => {
    const baskets = trips(['ルー', 'じゃがいも'], ['ルー', 'じゃがいも']);
    expect(baskets.length).toBeLessThan(MIN_BASKETS);
    expect(findCompanions(baskets, { onList: onList('ルー') })).toEqual([]);
  });

  it('同時に買われた回数が少なければ出さない', () => {
    const baskets = trips(
      ['ルー', 'らっきょう'],
      ['ルー'],
      ['ルー'],
      ['ルー'],
      ['パン'],
    );
    expect(findCompanions(baskets, { onList: onList('ルー') })).toEqual([]);
  });

  it('同じ品物が複数のきっかけから挙がっても1件にまとめる', () => {
    const baskets = trips(
      ['ルー', 'にんじん', 'じゃがいも'],
      ['ルー', 'にんじん', 'じゃがいも'],
      ['ルー', 'にんじん', 'じゃがいも'],
      ['ルー', 'にんじん', 'じゃがいも'],
      ['パン'],
      ['米'],
    );
    const found = findCompanions(baskets, { onList: onList('ルー', 'にんじん') });
    expect(found).toHaveLength(1);
    expect(found[0]!.itemId).toBe('じゃがいも');
  });

  it('確信度の高い順に並ぶ', () => {
    const baskets = trips(
      ['鍋の素', '白菜', 'ねぎ'],
      ['鍋の素', '白菜', 'ねぎ'],
      ['鍋の素', '白菜', 'ねぎ'],
      ['鍋の素', '白菜'],
      ['パン'],
      ['米'],
      ['卵'],
      ['醤油'],
    );
    const found = findCompanions(baskets, { onList: onList('鍋の素') });
    // 白菜 4/4、ねぎ 3/4
    expect(found.map((c) => c.itemId)).toEqual(['白菜', 'ねぎ']);
  });

  it('件数の上限を守る', () => {
    const baskets = trips(
      ['きっかけ', 'a', 'b', 'c', 'd', 'e'],
      ['きっかけ', 'a', 'b', 'c', 'd', 'e'],
      ['きっかけ', 'a', 'b', 'c', 'd', 'e'],
      ['きっかけ', 'a', 'b', 'c', 'd', 'e'],
      ['パン'],
      ['米'],
      ['卵'],
      ['醤油'],
    );
    expect(findCompanions(baskets, { onList: onList('きっかけ'), limit: 2 })).toHaveLength(2);
  });

  it('リストが空なら何も言わない', () => {
    const baskets = trips(
      ['ルー', 'じゃがいも'],
      ['ルー', 'じゃがいも'],
      ['ルー', 'じゃがいも'],
      ['ルー', 'じゃがいも'],
    );
    expect(findCompanions(baskets, { onList: onList() })).toEqual([]);
  });

  it('同じカゴに同じ品物が重複していても二重に数えない', () => {
    const baskets = [
      { listId: 'a', itemIds: ['ルー', 'ルー', 'じゃがいも'] },
      { listId: 'b', itemIds: ['ルー', 'じゃがいも'] },
      { listId: 'c', itemIds: ['ルー', 'じゃがいも'] },
      { listId: 'd', itemIds: ['パン'] },
    ];
    const found = findCompanions(baskets, { onList: onList('ルー') });
    expect(found[0]?.triggerTotal).toBe(3);
    expect(found[0]?.together).toBe(3);
  });
});
