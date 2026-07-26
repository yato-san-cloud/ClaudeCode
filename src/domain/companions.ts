/**
 * 「買い忘れかも」の組み立て。純粋なロジックは basket.ts。
 *
 * いまリストに載っているものを条件に、いつも一緒に買っているのに今日は
 * 入っていない品物を探す。使いどころは2つ:
 *   - 妻が書いているとき  … 「カレールー」と書いた時点で「じゃがいもは?」
 *   - 夫が買っているとき  … ゴール直前に「じゃがいもが入っていません」
 */

import { findCompanions } from './basket';
import { listCatalog, loadBaskets } from './catalog';
import { getActiveList, getItems } from './lists';
import { categoryLabel } from './categories';

export interface CompanionSuggestion {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  /** 画面にそのまま出す理由書き */
  reason: string;
  confidence: number;
  /** きっかけになった品物の名前 */
  trigger: string;
}

export async function missingCompanions(
  db: D1Database,
  householdId: string,
  options: { limit?: number } = {},
): Promise<CompanionSuggestion[]> {
  const list = await getActiveList(db, householdId);
  if (!list) return [];

  const items = await getItems(db, list.id);
  const onList = new Set(
    items
      .map((item) => item.catalog_item_id)
      .filter((id): id is string => id !== null),
  );
  if (onList.size === 0) return [];

  const [baskets, catalog] = await Promise.all([
    loadBaskets(db, householdId),
    listCatalog(db, householdId),
  ]);

  const byId = new Map(catalog.map((row) => [row.id, row]));
  const companions = findCompanions(baskets, { onList, limit: options.limit ?? 4 });

  return companions.flatMap((companion) => {
    const item = byId.get(companion.itemId);
    const trigger = byId.get(companion.triggerId);
    if (!item || !trigger) return [];

    return [
      {
        id: item.id,
        name: item.canonical_name,
        category: item.category,
        categoryLabel: categoryLabel(item.category),
        reason: `${trigger.canonical_name} と ${companion.together}/${companion.triggerTotal} 回 一緒に買っています`,
        confidence: companion.confidence,
        trigger: trigger.canonical_name,
      },
    ];
  });
}
