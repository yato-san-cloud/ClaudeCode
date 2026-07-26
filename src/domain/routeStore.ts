/** 順路学習の永続化。純粋なロジックは route.ts にある。 */

import { routeProgress, type PrecedenceCount, type RouteProgress } from './route';

export interface HouseholdRoute {
  /**
   * 売り場どうしの前後関係の観測。並べ替えはリストに載っている売り場だけを
   * 対象に行うので、順序そのものではなく観測を持ち回る。
   */
  counts: PrecedenceCount[];
  progress: RouteProgress;
}

export async function loadPrecedence(
  db: D1Database,
  householdId: string,
): Promise<PrecedenceCount[]> {
  const { results } = await db
    .prepare(
      'SELECT before_key AS "before", after_key AS "after", count FROM category_route_stats WHERE household_id = ?',
    )
    .bind(householdId)
    .all<PrecedenceCount>();
  return results ?? [];
}

/**
 * その世帯の順路モデル。観測がゼロでも既定順路にフォールバックするので、
 * 呼び出し側は学習前後で分岐しなくてよい。
 */
export async function loadRoute(
  db: D1Database,
  householdId: string,
): Promise<HouseholdRoute> {
  const [counts, household] = await Promise.all([
    loadPrecedence(db, householdId),
    db
      .prepare('SELECT route_trips FROM households WHERE id = ?')
      .bind(householdId)
      .first<{ route_trips: number }>(),
  ]);

  return { counts, progress: routeProgress(household?.route_trips ?? 0) };
}

/** 1回の買い物で観測した前後関係を積み上げ、観測回数を1つ進める。 */
export async function recordCheckoffOrder(
  db: D1Database,
  householdId: string,
  pairs: ReadonlyArray<[string, string]>,
  now: number,
): Promise<void> {
  if (pairs.length === 0) return;

  const statements = pairs.map(([before, after]) =>
    db
      .prepare(
        `INSERT INTO category_route_stats (household_id, before_key, after_key, count, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(household_id, before_key, after_key)
         DO UPDATE SET count = category_route_stats.count + 1, updated_at = excluded.updated_at`,
      )
      .bind(householdId, before, after, now),
  );

  statements.push(
    db
      .prepare('UPDATE households SET route_trips = route_trips + 1 WHERE id = ?')
      .bind(householdId),
  );

  await db.batch(statements);
}
