/**
 * LIFF ミニアプリ向けの JSON API。
 *
 * すべてのルートで「呼び出したユーザーがその世帯のメンバーか」を確認する。
 * 世帯IDはURLに現れるので、ここを抜くと他人の買い物リストが見えてしまう。
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { authenticate } from './auth';
import {
  ensureMember,
  getHousehold,
  householdsForUser,
  isMember,
} from '../domain/households';
import {
  addParsedItems,
  completeList,
  ensureActiveList,
  getActiveList,
  getItems,
  groupByCategory,
  householdOfItem,
  removeItem,
  setChecked,
} from '../domain/lists';
import {
  appearanceCounts,
  listCatalog,
  searchCatalog,
  toSnapshot,
} from '../domain/catalog';
import { suggestItems, usualItems } from '../domain/suggest';
import { categoryLabel } from '../domain/categories';
import { categorize } from '../domain/categories';
import type { ParsedItem } from '../parser';
import type { ListItemRow } from '../types';

type Variables = { userId: string; displayName: string | null };

export const api = new Hono<{ Bindings: Env; Variables: Variables }>();

api.use('*', async (c, next) => {
  const user = await authenticate(c.req.raw, c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  c.set('userId', user.userId);
  c.set('displayName', user.displayName);
  await next();
});

/** householdId を検証して返す。権限が無ければ null。 */
async function authorizeHousehold(
  c: { env: Env; get: (key: 'userId') => string },
  householdId: string | undefined,
): Promise<string | null> {
  if (!householdId) return null;
  const ok = await isMember(c.env.DB, householdId, c.get('userId'));
  return ok ? householdId : null;
}

function serializeItem(item: ListItemRow) {
  return {
    id: item.id,
    name: item.name,
    raw: item.raw_text,
    quantity: item.quantity,
    unit: item.unit,
    note: item.note,
    category: item.category,
    categoryLabel: categoryLabel(item.category),
    checked: item.checked === 1,
    uncertain: item.confidence < 0.5,
    source: item.source,
  };
}

/** 所属する世帯の一覧。画面上部の切り替えに使う。 */
api.get('/households', async (c) => {
  const households = await householdsForUser(c.env.DB, c.get('userId'));
  return c.json({
    households: households.map((h) => ({
      id: h.id,
      name: h.display_name ?? (h.line_source_type === 'user' ? 'ひとりのメモ' : '家族のリスト'),
      sourceType: h.line_source_type,
    })),
  });
});

/** いま進行中のリスト。売り場ごとにまとめて返す。 */
api.get('/lists/active', async (c) => {
  const householdId = await authorizeHousehold(c, c.req.query('householdId'));
  if (!householdId) return c.json({ error: 'forbidden' }, 403);

  const list = await getActiveList(c.env.DB, householdId);
  if (!list) return c.json({ list: null, groups: [], remaining: 0, done: 0 });

  const items = await getItems(c.env.DB, list.id);
  const groups = groupByCategory(items).map((group) => ({
    category: group.category,
    label: categoryLabel(group.category),
    items: group.items.map(serializeItem),
  }));

  return c.json({
    list: { id: list.id, createdAt: list.created_at },
    groups,
    remaining: items.filter((item) => item.checked === 0).length,
    done: items.filter((item) => item.checked === 1).length,
    // クライアントは updatedAt を見て、相手の変更が来ているかを判定する
    updatedAt: items.reduce((max, item) => Math.max(max, item.updated_at), list.created_at),
  });
});

/** 品物を1つ追加する (画面のフォームから) */
api.post('/lists/items', async (c) => {
  const body = await c.req.json<{
    householdId?: string;
    name?: string;
    quantity?: number | null;
    unit?: string | null;
    note?: string | null;
  }>();

  const householdId = await authorizeHousehold(c, body.householdId);
  if (!householdId) return c.json({ error: 'forbidden' }, 403);

  const name = body.name?.trim();
  if (!name) return c.json({ error: 'name is required' }, 400);

  const now = Date.now();
  const list = await ensureActiveList(c.env.DB, householdId, c.get('userId'), now);
  const parsed: ParsedItem = {
    raw: name,
    name,
    quantity: typeof body.quantity === 'number' ? body.quantity : null,
    unit: body.unit?.trim() || null,
    note: body.note?.trim() || null,
    category: categorize(name),
    confidence: 1,
  };
  const result = await addParsedItems(c.env.DB, householdId, list, [parsed], 'liff', now);
  const item = result.added[0] ?? result.updated[0];
  return c.json({ item: item ? serializeItem(item) : null });
});

/** カタログから複数まとめて追加する (提案 / いつもの) */
api.post('/lists/items/bulk', async (c) => {
  const body = await c.req.json<{ householdId?: string; catalogItemIds?: string[] }>();
  const householdId = await authorizeHousehold(c, body.householdId);
  if (!householdId) return c.json({ error: 'forbidden' }, 403);

  const ids = body.catalogItemIds ?? [];
  if (ids.length === 0) return c.json({ added: 0 });

  const catalog = await listCatalog(c.env.DB, householdId);
  const byId = new Map(catalog.map((row) => [row.id, row]));
  const parsed: ParsedItem[] = ids
    .map((id) => byId.get(id))
    .filter((row): row is NonNullable<typeof row> => row !== undefined)
    .map((row) => ({
      raw: row.canonical_name,
      name: row.canonical_name,
      quantity: row.default_quantity,
      unit: row.default_unit,
      note: null,
      category: row.category,
      confidence: 1,
    }));

  const now = Date.now();
  const list = await ensureActiveList(c.env.DB, householdId, c.get('userId'), now);
  const result = await addParsedItems(c.env.DB, householdId, list, parsed, 'suggestion', now);
  return c.json({ added: result.added.length, updated: result.updated.length });
});

/** チェックの付け外し */
api.patch('/items/:id', async (c) => {
  const itemId = c.req.param('id');
  const owner = await householdOfItem(c.env.DB, itemId);
  if (!owner || !(await authorizeHousehold(c, owner))) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json<{ checked?: boolean }>();
  if (typeof body.checked !== 'boolean') return c.json({ error: 'checked is required' }, 400);

  await setChecked(c.env.DB, itemId, body.checked, c.get('userId'));
  return c.json({ ok: true });
});

api.delete('/items/:id', async (c) => {
  const itemId = c.req.param('id');
  const owner = await householdOfItem(c.env.DB, itemId);
  if (!owner || !(await authorizeHousehold(c, owner))) return c.json({ error: 'forbidden' }, 403);

  await removeItem(c.env.DB, itemId);
  return c.json({ ok: true });
});

/** 買い物完了。ここで学習が進む。 */
api.post('/lists/:id/complete', async (c) => {
  const listId = c.req.param('id');
  const list = await c.env.DB
    .prepare('SELECT * FROM shopping_lists WHERE id = ?')
    .bind(listId)
    .first<import('../types').ListRow>();
  if (!list) return c.json({ error: 'not found' }, 404);
  if (!(await authorizeHousehold(c, list.household_id))) return c.json({ error: 'forbidden' }, 403);

  const result = await completeList(c.env.DB, list.household_id, list);
  return c.json({
    purchased: result.purchased.length,
    carriedOver: result.carriedOver.map((item) => item.name),
  });
});

/** そろそろ切れそうなもの */
api.get('/suggestions', async (c) => {
  const householdId = await authorizeHousehold(c, c.req.query('householdId'));
  if (!householdId) return c.json({ error: 'forbidden' }, 403);

  const catalog = (await listCatalog(c.env.DB, householdId)).map(toSnapshot);
  const list = await getActiveList(c.env.DB, householdId);
  const onList = new Set(
    list
      ? (await getItems(c.env.DB, list.id))
          .map((item) => item.catalog_item_id)
          .filter((value): value is string => value !== null)
      : [],
  );

  const suggestions = suggestItems(catalog, { now: Date.now(), excludeIds: onList, limit: 12 });
  const { counts, trips } = await appearanceCounts(c.env.DB, householdId, 8);
  const usual = usualItems(catalog, counts, trips).filter((item) => !onList.has(item.id));

  return c.json({
    suggestions: suggestions.map((s) => ({
      id: s.item.id,
      name: s.item.canonical_name,
      category: s.item.category,
      categoryLabel: categoryLabel(s.item.category),
      reason: s.reason,
    })),
    usual: usual.map((item) => ({
      id: item.id,
      name: item.canonical_name,
      category: item.category,
      categoryLabel: categoryLabel(item.category),
    })),
  });
});

/** 入力補完 & 履歴からの呼び出し */
api.get('/catalog', async (c) => {
  const householdId = await authorizeHousehold(c, c.req.query('householdId'));
  if (!householdId) return c.json({ error: 'forbidden' }, 403);

  const query = c.req.query('q')?.trim();
  const rows = query
    ? await searchCatalog(c.env.DB, householdId, query, 12)
    : (await listCatalog(c.env.DB, householdId)).slice(0, 40);

  return c.json({
    items: rows.map((row) => ({
      id: row.id,
      name: row.canonical_name,
      category: row.category,
      categoryLabel: categoryLabel(row.category),
      count: row.purchase_count,
      defaultQuantity: row.default_quantity,
      defaultUnit: row.default_unit,
    })),
  });
});

/**
 * LIFF初回起動時にメンバー登録する。
 * グループにBotを入れたが、まだそのトークで発言していない人でも
 * 画面を開けるようにするための導線。
 */
api.post('/households/:id/join', async (c) => {
  const householdId = c.req.param('id');
  const household = await getHousehold(c.env.DB, householdId);
  if (!household) return c.json({ error: 'not found' }, 404);
  await ensureMember(c.env.DB, householdId, c.get('userId'), c.get('displayName'));
  return c.json({ ok: true });
});
