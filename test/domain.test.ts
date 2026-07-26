import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  categorize,
  categoryLabel,
  compareByCategory,
  isKnownItem,
} from '../src/domain/categories';
import { groupByCategory } from '../src/domain/lists';
import { parseCommand } from '../src/line/commands';
import { formatQuantity, formatItemLine, addedSummary } from '../src/line/messages';
import { verifyLineSignature, timingSafeEqual } from '../src/line/signature';
import { DAY_MS, daysBetween, humanizeDaysAgo, jstDateString, jstDayOfWeek } from '../src/util/time';
import { newId } from '../src/util/id';
import type { ListItemWithRoute } from '../src/types';

function listItem(overrides: Partial<ListItemWithRoute> = {}): ListItemWithRoute {
  return {
    route_position: null,
    id: 'li_1',
    list_id: 'sl_1',
    catalog_item_id: 'ci_1',
    raw_text: '牛乳2本',
    name: '牛乳',
    quantity: 2,
    unit: '本',
    note: null,
    category: 'dairy',
    checked: 0,
    checked_at: null,
    checked_by: null,
    source: 'line',
    confidence: 0.95,
    position: 1,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe('categories', () => {
  it.each([
    ['牛乳', 'dairy'],
    ['豚こま', 'meat'],
    ['キャベツ', 'produce'],
    ['トイレットペーパー', 'household'],
    ['食器用洗剤', 'cleaning'],
    ['ビール', 'alcohol'],
    ['冷凍餃子', 'frozen'],
    ['よくわからないもの', 'other'],
  ])('%s → %s', (name, expected) => {
    expect(categorize(name)).toBe(expected);
  });

  it('カタカナ・ひらがなの表記ゆれを吸収する', () => {
    expect(categorize('ぎゅうにゅう')).toBe('dairy');
    expect(categorize('トイレットペーパー')).toBe(categorize('といれっとぺーぱー'));
  });

  it('長いキーワードを優先する', () => {
    // 「洗剤」より「食器用洗剤」が先に当たっても同じ売り場に落ちる
    expect(categorize('食器用洗剤')).toBe('cleaning');
  });

  it('辞書にあるものを既知と判定する', () => {
    expect(isKnownItem('納豆')).toBe(true);
    expect(isKnownItem('ほげほげ')).toBe(false);
  });

  it('カテゴリキーが重複していない', () => {
    const keys = CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('その他が最後に並ぶ', () => {
    expect(compareByCategory('produce', 'other')).toBeLessThan(0);
    expect(categoryLabel('other')).toBe('その他');
  });
});

describe('groupByCategory', () => {
  it('売り場順に並べる', () => {
    const items = [
      listItem({ id: 'a', category: 'household' }),
      listItem({ id: 'b', category: 'produce' }),
      listItem({ id: 'c', category: 'dairy' }),
    ];
    expect(groupByCategory(items).map((g) => g.category)).toEqual([
      'produce',
      'dairy',
      'household',
    ]);
  });

  it('同じ売り場をひとまとめにする', () => {
    const items = [
      listItem({ id: 'a', category: 'produce' }),
      listItem({ id: 'b', category: 'produce' }),
    ];
    const groups = groupByCategory(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(2);
  });

  it('学習した前後関係が渡されればそちらに従う', () => {
    const items = [
      listItem({ id: 'a', category: 'produce' }),
      listItem({ id: 'b', category: 'household' }),
      listItem({ id: 'c', category: 'dairy' }),
    ];
    // この店は日用品が入口すぐ、野菜が最後、という観測を8回ぶん
    const precedence = [
      { before: 'household', after: 'dairy', count: 8 },
      { before: 'household', after: 'produce', count: 8 },
      { before: 'dairy', after: 'produce', count: 8 },
    ];
    expect(groupByCategory(items, precedence).map((g) => g.category)).toEqual([
      'household',
      'dairy',
      'produce',
    ]);
  });

  it('売り場の中も学習済みの位置順に並べる', () => {
    const items = [
      listItem({ id: 'late', category: 'produce', position: 1, route_position: 0.8 }),
      listItem({ id: 'early', category: 'produce', position: 2, route_position: 0.1 }),
    ];
    expect(groupByCategory(items)[0]!.items.map((i) => i.id)).toEqual(['early', 'late']);
  });

  it('未学習の品物は売り場の末尾に置く', () => {
    const items = [
      listItem({ id: 'unknown', category: 'produce', position: 1, route_position: null }),
      listItem({ id: 'known', category: 'produce', position: 2, route_position: 0.5 }),
    ];
    expect(groupByCategory(items)[0]!.items.map((i) => i.id)).toEqual(['known', 'unknown']);
  });
});

describe('parseCommand', () => {
  it.each([
    ['リスト', 'show'],
    ['完了', 'complete'],
    ['いつもの', 'usual'],
    ['そろそろ', 'suggest'],
    ['全部消す', 'clear'],
    ['ヘルプ', 'help'],
  ])('%s → %s', (input, kind) => {
    expect(parseCommand(input).kind).toBe(kind);
  });

  it('削除は対象名を取り出す', () => {
    expect(parseCommand('削除 牛乳')).toEqual({ kind: 'remove', name: '牛乳' });
    expect(parseCommand('けして トマト缶')).toEqual({ kind: 'remove', name: 'トマト缶' });
    expect(parseCommand('消して トマト缶')).toEqual({ kind: 'remove', name: 'トマト缶' });
    expect(parseCommand('削除：牛乳')).toEqual({ kind: 'remove', name: '牛乳' });
  });

  it('削除に似た商品名をコマンドと誤認しない', () => {
    // 「消しゴム」は「消して」に一致しない
    expect(parseCommand('消しゴム').kind).toBe('items');
  });

  it('ふつうの買い物メモは items 扱い', () => {
    expect(parseCommand('牛乳2本と卵').kind).toBe('items');
    // 「リスト」を含んでいても完全一致でなければコマンドにしない
    expect(parseCommand('リストに牛乳追加して').kind).toBe('items');
  });
});

describe('messages', () => {
  it('数量と単位を整形する', () => {
    expect(formatQuantity({ quantity: 2, unit: '本' })).toBe('2本');
    expect(formatQuantity({ quantity: 300, unit: 'g' })).toBe('300g');
    expect(formatQuantity({ quantity: null, unit: null })).toBe('');
  });

  it('確信度が低い品物に印を付ける', () => {
    expect(formatItemLine(listItem({ confidence: 0.3 }))).toContain('⚠️');
    expect(formatItemLine(listItem({ confidence: 0.95 }))).not.toContain('⚠️');
  });

  it('補足を括弧で併記する', () => {
    expect(formatItemLine(listItem({ note: '安いやつ' }))).toContain('（安いやつ）');
  });

  it('何も追加できなかったときに助け船を出す', () => {
    expect(addedSummary([], [], 2)).toContain('品名だけ送って');
  });
});

describe('LINE signature', () => {
  const secret = 'test-channel-secret';

  async function sign(body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    let binary = '';
    for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  it('正しい署名を受け入れる', async () => {
    const body = '{"events":[]}';
    const signature = await sign(body);
    const raw = new TextEncoder().encode(body);
    await expect(
      verifyLineSignature(secret, raw.buffer as ArrayBuffer, signature),
    ).resolves.toBe(true);
  });

  it('改竄されたボディを拒否する', async () => {
    const signature = await sign('{"events":[]}');
    const raw = new TextEncoder().encode('{"events":[{"type":"message"}]}');
    await expect(
      verifyLineSignature(secret, raw.buffer as ArrayBuffer, signature),
    ).resolves.toBe(false);
  });

  it('署名が無ければ拒否する', async () => {
    const raw = new TextEncoder().encode('{}');
    await expect(verifyLineSignature(secret, raw.buffer as ArrayBuffer, null)).resolves.toBe(false);
  });

  it('長さの違う文字列を安全に比較する', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });
});

describe('time (JST)', () => {
  it('JSTの曜日を返す', () => {
    // 2026-07-26 12:00 JST は日曜日
    expect(jstDayOfWeek(Date.UTC(2026, 6, 26, 3, 0, 0))).toBe(0);
  });

  it('UTC深夜がJSTの翌日になる', () => {
    // 2026-07-25 23:00 UTC = 2026-07-26 08:00 JST
    expect(jstDateString(Date.UTC(2026, 6, 25, 23, 0, 0))).toBe('2026-07-26');
  });

  it('日数差を小数で返す', () => {
    expect(daysBetween(0, 3.5 * DAY_MS)).toBeCloseTo(3.5, 5);
  });

  it.each([
    [0, '今日'],
    [1, '昨日'],
    [3, '3日前'],
    [14, '2週間前'],
    [60, '2か月前'],
  ])('%i日前 → %s', (days, expected) => {
    expect(humanizeDaysAgo(days)).toBe(expected);
  });
});

describe('newId', () => {
  it('接頭辞を付けて時刻順にソートできるIDを作る', () => {
    const earlier = newId('li', 1_000_000);
    const later = newId('li', 2_000_000);
    expect(earlier.startsWith('li_')).toBe(true);
    expect(earlier < later).toBe(true);
  });

  it('同じ時刻でも衝突しない', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId('li', 1_000_000)));
    expect(ids.size).toBe(200);
  });
});
