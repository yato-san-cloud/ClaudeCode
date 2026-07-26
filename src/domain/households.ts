import { newId } from '../util/id';
import type { HouseholdRow } from '../types';

export type LineSourceType = 'group' | 'room' | 'user';

/**
 * トークルーム (グループ / 複数人トーク / 1:1) を世帯として登録する。
 * グループと1:1の両方でBotを使えるようにしているので、どちらから来ても
 * 同じ経路でここに落ちる。
 */
export async function ensureHousehold(
  db: D1Database,
  sourceType: LineSourceType,
  sourceId: string,
  now: number = Date.now(),
): Promise<HouseholdRow> {
  const existing = await db
    .prepare('SELECT * FROM households WHERE line_source_id = ?')
    .bind(sourceId)
    .first<HouseholdRow>();
  if (existing) return existing;

  const household: HouseholdRow = {
    id: newId('hh', now),
    line_source_type: sourceType,
    line_source_id: sourceId,
    display_name: null,
    shopping_dow: null,
    last_draft_on: null,
    route_trips: 0,
    created_at: now,
    updated_at: now,
  };

  await db
    .prepare(
      `INSERT INTO households
         (id, line_source_type, line_source_id, display_name, shopping_dow, last_draft_on, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(line_source_id) DO NOTHING`,
    )
    .bind(household.id, sourceType, sourceId, now, now)
    .run();

  // 競合したときは相手が入れた行を読み直す
  return (
    (await db
      .prepare('SELECT * FROM households WHERE line_source_id = ?')
      .bind(sourceId)
      .first<HouseholdRow>()) ?? household
  );
}

export async function ensureMember(
  db: D1Database,
  householdId: string,
  lineUserId: string,
  displayName: string | null,
  now: number = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO members (id, household_id, line_user_id, display_name, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(household_id, line_user_id)
       DO UPDATE SET display_name = COALESCE(excluded.display_name, members.display_name)`,
    )
    .bind(newId('mb', now), householdId, lineUserId, displayName, now)
    .run();
}

/** そのLINEユーザーが所属する世帯。新しく使われたものから順。 */
export async function householdsForUser(
  db: D1Database,
  lineUserId: string,
): Promise<HouseholdRow[]> {
  const { results } = await db
    .prepare(
      `SELECT h.* FROM households h
       JOIN members m ON m.household_id = h.id
       WHERE m.line_user_id = ?
       ORDER BY h.updated_at DESC`,
    )
    .bind(lineUserId)
    .all<HouseholdRow>();
  return results ?? [];
}

export async function getHousehold(
  db: D1Database,
  householdId: string,
): Promise<HouseholdRow | null> {
  return db
    .prepare('SELECT * FROM households WHERE id = ?')
    .bind(householdId)
    .first<HouseholdRow>();
}

/** そのユーザーがこの世帯を触ってよいか */
export async function isMember(
  db: D1Database,
  householdId: string,
  lineUserId: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM members WHERE household_id = ? AND line_user_id = ?')
    .bind(householdId, lineUserId)
    .first<{ ok: number }>();
  return row !== null;
}

export async function touchHousehold(
  db: D1Database,
  householdId: string,
  now: number = Date.now(),
): Promise<void> {
  await db
    .prepare('UPDATE households SET updated_at = ? WHERE id = ?')
    .bind(now, householdId)
    .run();
}

export async function setShoppingDow(
  db: D1Database,
  householdId: string,
  dow: number | null,
): Promise<void> {
  await db
    .prepare('UPDATE households SET shopping_dow = ? WHERE id = ?')
    .bind(dow, householdId)
    .run();
}

export async function markDraftCreated(
  db: D1Database,
  householdId: string,
  jstDate: string,
): Promise<void> {
  await db
    .prepare('UPDATE households SET last_draft_on = ? WHERE id = ?')
    .bind(jstDate, householdId)
    .run();
}

export async function allHouseholds(db: D1Database): Promise<HouseholdRow[]> {
  const { results } = await db.prepare('SELECT * FROM households').all<HouseholdRow>();
  return results ?? [];
}
