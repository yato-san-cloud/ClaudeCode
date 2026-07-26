/**
 * 学習された商品マスタ。「妻がどう書くか」と「どのくらいの周期で買うか」を
 * 世帯ごとに覚えておく場所。
 */

import { newId } from '../util/id';
import { matchKey } from '../parser/normalize';
import { categorize } from './categories';
import { updateInterval, type CatalogSnapshot } from './suggest';
import { jstDayOfWeek } from '../util/time';
import type { CatalogRow } from '../types';

export async function listCatalog(
  db: D1Database,
  householdId: string,
): Promise<CatalogRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM catalog_items WHERE household_id = ? ORDER BY purchase_count DESC')
    .bind(householdId)
    .all<CatalogRow>();
  return results ?? [];
}

export function toSnapshot(row: CatalogRow): CatalogSnapshot {
  return {
    id: row.id,
    canonical_name: row.canonical_name,
    category: row.category,
    default_unit: row.default_unit,
    default_quantity: row.default_quantity,
    purchase_count: row.purchase_count,
    last_purchased_at: row.last_purchased_at,
    mean_interval_days: row.mean_interval_days,
    interval_samples: row.interval_samples,
  };
}

/**
 * 名前から商品を引く。エイリアス (表記ゆれ) 経由でも引ける。
 * 「ぎゅーにゅー」で書かれても、過去に「牛乳」と紐付けていれば当たる。
 */
export async function findByName(
  db: D1Database,
  householdId: string,
  name: string,
): Promise<CatalogRow | null> {
  const key = matchKey(name);
  if (!key) return null;

  const direct = await db
    .prepare('SELECT * FROM catalog_items WHERE household_id = ? AND match_key = ?')
    .bind(householdId, key)
    .first<CatalogRow>();
  if (direct) return direct;

  return db
    .prepare(
      `SELECT c.* FROM catalog_items c
       JOIN item_aliases a ON a.catalog_item_id = c.id
       WHERE a.household_id = ? AND a.alias_key = ?`,
    )
    .bind(householdId, key)
    .first<CatalogRow>();
}

/** 無ければ作る。既にあれば売り場と既定値だけ補強する。 */
export async function upsertItem(
  db: D1Database,
  householdId: string,
  name: string,
  options: { unit?: string | null; quantity?: number | null; category?: string } = {},
  now: number = Date.now(),
): Promise<CatalogRow> {
  const existing = await findByName(db, householdId, name);
  if (existing) {
    // 別表記で書かれていたら、その表記をエイリアスとして覚える
    const key = matchKey(name);
    if (key && key !== existing.match_key) {
      await recordAlias(db, householdId, key, existing.id, now);
    }
    return existing;
  }

  const row: CatalogRow = {
    id: newId('ci', now),
    household_id: householdId,
    canonical_name: name,
    match_key: matchKey(name),
    category: options.category ?? categorize(name),
    default_unit: options.unit ?? null,
    default_quantity: options.quantity ?? null,
    purchase_count: 0,
    last_purchased_at: null,
    mean_interval_days: null,
    interval_samples: 0,
    created_at: now,
    updated_at: now,
  };

  await db
    .prepare(
      `INSERT INTO catalog_items
         (id, household_id, canonical_name, match_key, category, default_unit, default_quantity,
          purchase_count, last_purchased_at, mean_interval_days, interval_samples, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0, ?, ?)
       ON CONFLICT(household_id, match_key) DO NOTHING`,
    )
    .bind(
      row.id, householdId, row.canonical_name, row.match_key, row.category,
      row.default_unit, row.default_quantity, now, now,
    )
    .run();

  return (await findByName(db, householdId, name)) ?? row;
}

export async function recordAlias(
  db: D1Database,
  householdId: string,
  aliasKey: string,
  catalogItemId: string,
  now: number = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO item_aliases (id, household_id, alias_key, catalog_item_id, hits, created_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(household_id, alias_key) DO UPDATE SET hits = item_aliases.hits + 1`,
    )
    .bind(newId('al', now), householdId, aliasKey, catalogItemId, now)
    .run();
}

/**
 * 購入を記録し、周期と回数を更新する。ここが学習の本体。
 * 買い物完了 (= チェック済み品の確定) のときだけ呼ぶ。
 */
export async function recordPurchase(
  db: D1Database,
  householdId: string,
  item: CatalogRow,
  options: { quantity?: number | null; unit?: string | null; listId?: string },
  now: number = Date.now(),
): Promise<void> {
  const { mean, samples } = updateInterval(
    item.mean_interval_days,
    item.interval_samples,
    item.last_purchased_at,
    now,
  );

  await db.batch([
    db
      .prepare(
        `UPDATE catalog_items
         SET purchase_count = purchase_count + 1,
             last_purchased_at = ?,
             mean_interval_days = ?,
             interval_samples = ?,
             default_unit = COALESCE(?, default_unit),
             default_quantity = COALESCE(?, default_quantity),
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(now, mean, samples, options.unit ?? null, options.quantity ?? null, now, item.id),
    db
      .prepare(
        `INSERT INTO purchase_events
           (id, household_id, catalog_item_id, list_id, quantity, unit, purchased_at, dow)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId('pe', now),
        householdId,
        item.id,
        options.listId ?? null,
        options.quantity ?? null,
        options.unit ?? null,
        now,
        jstDayOfWeek(now),
      ),
  ]);
}

/** 直近 n 回の買い物における、商品ごとの登場回数。「いつもの」判定に使う。 */
export async function appearanceCounts(
  db: D1Database,
  householdId: string,
  recentTrips: number,
): Promise<{ counts: Map<string, number>; trips: number }> {
  const { results: tripRows } = await db
    .prepare(
      `SELECT id FROM shopping_lists
       WHERE household_id = ? AND status = 'done'
       ORDER BY completed_at DESC LIMIT ?`,
    )
    .bind(householdId, recentTrips)
    .all<{ id: string }>();

  const tripIds = (tripRows ?? []).map((row) => row.id);
  if (tripIds.length === 0) return { counts: new Map(), trips: 0 };

  const placeholders = tripIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT catalog_item_id, COUNT(DISTINCT list_id) AS appearances
       FROM purchase_events
       WHERE household_id = ? AND list_id IN (${placeholders})
       GROUP BY catalog_item_id`,
    )
    .bind(householdId, ...tripIds)
    .all<{ catalog_item_id: string; appearances: number }>();

  const counts = new Map<string, number>();
  for (const row of results ?? []) counts.set(row.catalog_item_id, row.appearances);
  return { counts, trips: tripIds.length };
}

/** 買い物曜日の推定に使う、直近の購入曜日 */
export async function recentPurchaseDows(
  db: D1Database,
  householdId: string,
  limit = 40,
): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT list_id, dow FROM purchase_events
       WHERE household_id = ? AND list_id IS NOT NULL
       ORDER BY purchased_at DESC LIMIT ?`,
    )
    .bind(householdId, limit)
    .all<{ list_id: string; dow: number }>();
  return (results ?? []).map((row) => row.dow);
}

/** LIFFのオートコンプリート用 */
export async function searchCatalog(
  db: D1Database,
  householdId: string,
  query: string,
  limit = 10,
): Promise<CatalogRow[]> {
  const key = matchKey(query);
  if (!key) return [];
  const { results } = await db
    .prepare(
      `SELECT * FROM catalog_items
       WHERE household_id = ? AND match_key LIKE ?
       ORDER BY purchase_count DESC LIMIT ?`,
    )
    .bind(householdId, `%${key}%`, limit)
    .all<CatalogRow>();
  return results ?? [];
}
