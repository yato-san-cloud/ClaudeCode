/**
 * 買い物リストの操作。1世帯につき active なリストは常に高々1つ。
 */

import { newId } from '../util/id';
import { categorize, compareByCategory } from './categories';
import { upsertItem, findByName, recordPurchase, recentPurchaseDows } from './catalog';
import { inferShoppingDow } from './suggest';
import { setShoppingDow } from './households';
import type { ParsedItem } from '../parser';
import type { ListItemRow, ListRow } from '../types';

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

export async function getItems(db: D1Database, listId: string): Promise<ListItemRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM list_items WHERE list_id = ? ORDER BY position, created_at')
    .bind(listId)
    .all<ListItemRow>();
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
  added: ListItemRow[];
  /** すでに載っていて数量だけ更新したもの */
  updated: ListItemRow[];
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
  const added: ListItemRow[] = [];
  const updated: ListItemRow[] = [];
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
    const row: ListItemRow = {
      id: newId('li', now),
      list_id: list.id,
      catalog_item_id: catalogItem.id,
      raw_text: parsed.raw,
      name: parsed.name,
      quantity: parsed.quantity,
      unit: parsed.unit,
      note: parsed.note,
      category: parsed.category || categorize(parsed.name),
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
  purchased: ListItemRow[];
  /** チェックが付かないまま残った品物。次のリストに繰り越す。 */
  carriedOver: ListItemRow[];
  nextListId: string | null;
}

/**
 * 買い物を完了する。チェック済みの品物を購入イベントとして記録し
 * (= 学習の入力)、未チェックが残っていれば新しいリストに繰り越す。
 */
export async function completeList(
  db: D1Database,
  householdId: string,
  list: ListRow,
  now: number = Date.now(),
): Promise<CompleteResult> {
  const items = await getItems(db, list.id);
  const purchased = items.filter((row) => row.checked === 1);
  const carriedOver = items.filter((row) => row.checked === 0);

  for (const item of purchased) {
    if (!item.catalog_item_id) continue;
    const catalogItem = await db
      .prepare('SELECT * FROM catalog_items WHERE id = ?')
      .bind(item.catalog_item_id)
      .first<import('../types').CatalogRow>();
    if (!catalogItem) continue;
    await recordPurchase(
      db,
      householdId,
      catalogItem,
      { quantity: item.quantity, unit: item.unit, listId: list.id },
      now,
    );
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

  return { purchased, carriedOver, nextListId };
}

export interface GroupedItems {
  category: string;
  items: ListItemRow[];
}

/** 売り場ごとにまとめる。順路の順に並ぶ。 */
export function groupByCategory(items: readonly ListItemRow[]): GroupedItems[] {
  const groups = new Map<string, ListItemRow[]>();
  for (const item of items) {
    const bucket = groups.get(item.category);
    if (bucket) bucket.push(item);
    else groups.set(item.category, [item]);
  }
  return [...groups.entries()]
    .map(([category, groupItems]) => ({ category, items: groupItems }))
    .sort((a, b) => compareByCategory(a.category, b.category));
}
