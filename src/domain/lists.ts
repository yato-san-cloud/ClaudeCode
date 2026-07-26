/**
 * 買い物リストの操作。1世帯につき active なリストは常に高々1つ。
 */

import { newId } from '../util/id';
import { categorize, OTHER_CATEGORY } from './categories';
import {
  upsertItem,
  findByName,
  findByIds,
  recordPurchase,
  recentPurchaseDows,
  voteCategory,
} from './catalog';
import { inferShoppingDow } from './suggest';
import {
  MIN_ITEMS_FOR_LEARNING,
  categorySequence,
  inferCategoryFromNeighbors,
  normalizedPosition,
  precedencePairs,
  routeOrder,
  sortByCheckoff,
  type PrecedenceCount,
} from './route';
import { recordCheckoffOrder } from './routeStore';
import { setShoppingDow } from './households';
import type { ParsedItem } from '../parser';
import type { ListItemRow, ListItemWithRoute, ListRow } from '../types';

export async function getActiveList(
  db: D1Database,
  householdId: string,
): Promise<ListRow | null> {
  return db
    .prepare(
      `SELECT * FROM shopping_lists
       WHERE household_id = ? AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(householdId)
    .first<ListRow>();
}

export async function ensureActiveList(
  db: D1Database,
  householdId: string,
  createdBy: string | null,
  now: number = Date.now(),
): Promise<ListRow> {
  const existing = await getActiveList(db, householdId);
  if (existing) return existing;

  const list: ListRow = {
    id: newId('sl', now),
    household_id: householdId,
    title: null,
    status: 'active',
    created_by: createdBy,
    created_at: now,
    completed_at: null,
  };
  await db
    .prepare(
      `INSERT INTO shopping_lists (id, household_id, title, status, created_by, created_at, completed_at)
       VALUES (?, ?, NULL, 'active', ?, ?, NULL)`,
    )
    .bind(list.id, householdId, createdBy, now)
    .run();
  return list;
}

/**
 * リストの中身。学習済みの順路位置を catalog_items から結合して返すので、
 * 呼び出し側は同じ売り場の中も歩く順に並べられる。
 */
export async function getItems(
  db: D1Database,
  listId: string,
): Promise<ListItemWithRoute[]> {
  const { results } = await db
    .prepare(
      `SELECT i.*, c.route_position AS route_position
       FROM list_items i
       LEFT JOIN catalog_items c ON c.id = i.catalog_item_id
       WHERE i.list_id = ?
       ORDER BY i.position, i.created_at`,
    )
    .bind(listId)
    .all<ListItemWithRoute>();
  return results ?? [];
}

export async function getItem(db: D1Database, itemId: string): Promise<ListItemRow | null> {
  return db.prepare('SELECT * FROM list_items WHERE id = ?').bind(itemId).first<ListItemRow>();
}

/** 品物が属するリストの世帯ID。権限チェックに使う。 */
export async function householdOfItem(
  db: D1Database,
  itemId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT l.household_id AS household_id FROM list_items i
       JOIN shopping_lists l ON l.id = i.list_id
       WHERE i.id = ?`,
    )
    .bind(itemId)
    .first<{ household_id: string }>();
  return row?.household_id ?? null;
}

export interface AddResult {
  added: ListItemWithRoute[];
  /** すでに載っていて数量だけ更新したもの */
  updated: ListItemWithRoute[];
}

/**
 * 解析済みの品物をリストに追加する。
 * 同じものが未チェックで載っていれば重複させず、数量とメモだけ更新する
 * (妻が二度書いても、夫のリストは1行のまま)。
 */
export async function addParsedItems(
  db: D1Database,
  householdId: string,
  list: ListRow,
  items: readonly ParsedItem[],
  source: ListItemRow['source'],
  now: number = Date.now(),
): Promise<AddResult> {
  const existing = await getItems(db, list.id);
  const added: ListItemWithRoute[] = [];
  const updated: ListItemWithRoute[] = [];
  let position = existing.reduce((max, row) => Math.max(max, row.position), 0);

  for (const parsed of items) {
    const catalogItem = await upsertItem(
      db,
      householdId,
      parsed.name,
      { unit: parsed.unit, quantity: parsed.quantity, category: parsed.category },
      now,
    );

    const duplicate = existing.find(
      (row) => row.checked === 0 && row.catalog_item_id === catalogItem.id,
    );

    if (duplicate) {
      const quantity = parsed.quantity ?? duplicate.quantity;
      const unit = parsed.unit ?? duplicate.unit;
      const note = mergeNotes(duplicate.note, parsed.note);
      await db
        .prepare(
          `UPDATE list_items SET quantity = ?, unit = ?, note = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(quantity, unit, note, now, duplicate.id)
        .run();
      updated.push({ ...duplicate, quantity, unit, note, updated_at: now });
      continue;
    }

    position += 1;
    const row: ListItemWithRoute = {
      id: newId('li', now),
      list_id: list.id,
      catalog_item_id: catalogItem.id,
      raw_text: parsed.raw,
      name: parsed.name,
      quantity: parsed.quantity,
      unit: parsed.unit,
      note: parsed.note,
      // 学習済みの売り場があればそちらを優先する (「その他」から昇格した品物)
      category: catalogItem.category || parsed.category || categorize(parsed.name),
      route_position: catalogItem.route_position,
      checked: 0,
      checked_at: null,
      checked_by: null,
      source,
      confidence: parsed.confidence,
      position,
      created_at: now,
      updated_at: now,
    };

    await db
      .prepare(
        `INSERT INTO list_items
           (id, list_id, catalog_item_id, raw_text, name, quantity, unit, note, category,
            checked, checked_at, checked_by, source, confidence, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id, row.list_id, row.catalog_item_id, row.raw_text, row.name, row.quantity,
        row.unit, row.note, row.category, row.source, row.confidence, row.position, now, now,
      )
      .run();

    added.push(row);
    existing.push(row);
  }

  return { added, updated };
}

function mergeNotes(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b || a.includes(b)) return a;
  return `${a} / ${b}`;
}

export async function setChecked(
  db: D1Database,
  itemId: string,
  checked: boolean,
  byUserId: string | null,
  now: number = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE list_items SET checked = ?, checked_at = ?, checked_by = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(checked ? 1 : 0, checked ? now : null, checked ? byUserId : null, now, itemId)
    .run();
}

export async function removeItem(db: D1Database, itemId: string): Promise<void> {
  await db.prepare('DELETE FROM list_items WHERE id = ?').bind(itemId).run();
}

/** 名前でリストから外す。LINEの「削除 牛乳」用。 */
export async function removeByName(
  db: D1Database,
  householdId: string,
  listId: string,
  name: string,
): Promise<ListItemRow | null> {
  const catalogItem = await findByName(db, householdId, name);
  const items = await getItems(db, listId);
  const target = catalogItem
    ? items.find((row) => row.catalog_item_id === catalogItem.id)
    : items.find((row) => row.name === name);
  if (!target) return null;
  await removeItem(db, target.id);
  return target;
}

export interface CompleteResult {
  purchased: ListItemWithRoute[];
  /** チェックが付かないまま残った品物。次のリストに繰り越す。 */
  carriedOver: ListItemWithRoute[];
  nextListId: string | null;
  /** この買い物で「その他」から実際の売り場へ昇格した品物 */
  promoted: Array<{ name: string; category: string }>;
  /** 順路の学習が進んだか (品数が少ない買い物では進まない) */
  routeLearned: boolean;
}

/**
 * 買い物を完了する。ここが学習のすべての入口。
 *
 * チェック済みの品物について、
 *   - 購入イベントを記録し、購入周期と回数を更新する
 *   - 消し込み順から売り場の前後関係を観測し、順路を更新する
 *   - 「その他」に落ちていた品物の売り場を、前後の品物から推定する
 * 未チェックのものは新しいリストに繰り越す。
 */
export async function completeList(
  db: D1Database,
  householdId: string,
  list: ListRow,
  now: number = Date.now(),
): Promise<CompleteResult> {
  const items = await getItems(db, list.id);
  const carriedOver = items.filter((row) => row.checked === 0);

  // 消し込み順 = その店を歩いた順。以降の学習はすべてこの並びを見る。
  const purchased = sortByCheckoff(items.filter((row) => row.checked === 1));
  const enoughToLearn = purchased.length >= MIN_ITEMS_FOR_LEARNING;

  const catalogById = await findByIds(
    db,
    purchased.map((item) => item.catalog_item_id).filter((id): id is string => id !== null),
  );

  // --- 順路 (売り場の並び) の学習 ---
  let routeLearned = false;
  if (enoughToLearn) {
    const sequence = categorySequence(purchased.map((item) => item.category));
    const pairs = precedencePairs(sequence);
    if (pairs.length > 0) {
      await recordCheckoffOrder(db, householdId, pairs, now);
      routeLearned = true;
    }
  }

  // --- 購入イベントと、品物ごとの順路上の位置 ---
  for (const [index, item] of purchased.entries()) {
    if (!item.catalog_item_id) continue;
    const catalogItem = catalogById.get(item.catalog_item_id);
    if (!catalogItem) continue;

    await recordPurchase(
      db,
      householdId,
      catalogItem,
      {
        quantity: item.quantity,
        unit: item.unit,
        listId: list.id,
        routePosition: enoughToLearn ? normalizedPosition(index, purchased.length) : null,
      },
      now,
    );
  }

  // --- 「その他」の品物の売り場推定 ---
  // recordPurchase より後に回している。同じ行を2回更新するが、こちらが
  // category を書き換える側なので、順序を固定しておかないと結果が読みにくい。
  const promoted: Array<{ name: string; category: string }> = [];
  if (enoughToLearn) {
    const categories = purchased.map((item) => item.category);
    for (const [index, item] of purchased.entries()) {
      if (item.category !== OTHER_CATEGORY || !item.catalog_item_id) continue;
      const catalogItem = catalogById.get(item.catalog_item_id);
      if (!catalogItem || catalogItem.category !== OTHER_CATEGORY) continue;

      const candidate = inferCategoryFromNeighbors(categories, index);
      if (!candidate) continue;

      const newCategory = await voteCategory(db, catalogItem, candidate, now);
      if (newCategory) promoted.push({ name: catalogItem.canonical_name, category: newCategory });
    }
  }

  await db
    .prepare(`UPDATE shopping_lists SET status = 'done', completed_at = ? WHERE id = ?`)
    .bind(now, list.id)
    .run();

  let nextListId: string | null = null;
  if (carriedOver.length > 0) {
    const next = await ensureActiveList(db, householdId, list.created_by, now);
    nextListId = next.id;
    let position = 0;
    for (const item of carriedOver) {
      position += 1;
      await db
        .prepare(
          `INSERT INTO list_items
             (id, list_id, catalog_item_id, raw_text, name, quantity, unit, note, category,
              checked, checked_at, checked_by, source, confidence, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId('li', now), next.id, item.catalog_item_id, item.raw_text, item.name,
          item.quantity, item.unit, item.note, item.category, item.source, item.confidence,
          position, now, now,
        )
        .run();
    }
  }

  // 買い物曜日を学習し直す
  const dows = await recentPurchaseDows(db, householdId);
  await setShoppingDow(db, householdId, inferShoppingDow(dows));

  return { purchased, carriedOver, nextListId, promoted, routeLearned };
}

export interface GroupedItems {
  category: string;
  items: ListItemWithRoute[];
}

/**
 * 売り場ごとにまとめる。
 *
 * @param precedence 学習した売り場の前後関係。省略すると組み込みの既定順路。
 *
 * 並べ替えは「いまリストに載っている売り場」だけを対象に行う。全売り場で
 * 比べると、既定順路の前方にある売り場が構造的に有利になり、実観測が
 * それを覆せなくなるため (route.ts の rankCategories を参照)。
 *
 * 売り場の中も、学習済みの位置がある品物を歩く順に並べる。未学習の品物は
 * その売り場の末尾に置く (推測で既知のものより前に出さない)。
 */
export function groupByCategory(
  items: readonly ListItemWithRoute[],
  precedence: readonly PrecedenceCount[] = [],
): GroupedItems[] {
  const present = [...new Set(items.map((item) => item.category))];
  const rank = new Map(routeOrder(precedence, present).map((key, index) => [key, index]));
  const positionOf = (category: string) =>
    rank.get(category) ?? Number.MAX_SAFE_INTEGER;

  const groups = new Map<string, ListItemWithRoute[]>();
  for (const item of items) {
    const bucket = groups.get(item.category);
    if (bucket) bucket.push(item);
    else groups.set(item.category, [item]);
  }

  for (const bucket of groups.values()) {
    bucket.sort((a, b) => {
      if (a.route_position !== null && b.route_position !== null) {
        return a.route_position - b.route_position || a.position - b.position;
      }
      if (a.route_position !== null) return -1;
      if (b.route_position !== null) return 1;
      return a.position - b.position;
    });
  }

  return [...groups.entries()]
    .map(([category, groupItems]) => ({ category, items: groupItems }))
    .sort((a, b) => positionOf(a.category) - positionOf(b.category));
}
