/**
 * LINE Webhook のイベント処理。
 *
 * グループトークと1:1トークの両方を受ける。グループでは Bot 宛以外の発言も
 * すべて届くので、「買い物メモらしくない発言」はパーサ側で落としている
 * (segment.ts の isLikelyChatter)。
 */

import type { Env } from '../types';
import { parseMessage } from '../parser';
import { ensureHousehold, ensureMember, touchHousehold, type LineSourceType } from '../domain/households';
import {
  addParsedItems,
  completeList,
  ensureActiveList,
  getActiveList,
  getItems,
  removeByName,
} from '../domain/lists';
import {
  appearanceCounts,
  listCatalog,
  toSnapshot,
} from '../domain/catalog';
import { suggestItems, usualItems } from '../domain/suggest';
import { loadRoute } from '../domain/routeStore';
import { parseCommand } from './commands';
import { reply } from './client';
import {
  HELP_TEXT,
  WELCOME_TEXT,
  addedSummary,
  completionSummary,
  formatItemLine,
  listCard,
  suggestionCard,
  text,
} from './messages';
import type { ParsedItem } from '../parser';
import type { LineMessage } from './client';

interface LineSource {
  type: LineSourceType;
  userId?: string;
  groupId?: string;
  roomId?: string;
}

interface LineEvent {
  type: string;
  webhookEventId?: string;
  replyToken?: string;
  source?: LineSource;
  message?: { type: string; text?: string };
  postback?: { data: string };
}

export interface WebhookBody {
  events?: LineEvent[];
}

function sourceId(source: LineSource): string | null {
  return source.groupId ?? source.roomId ?? source.userId ?? null;
}

/** LINEは同じイベントを再送することがある。処理済みなら黙って捨てる。 */
async function alreadyProcessed(db: D1Database, eventId: string | undefined, now: number) {
  if (!eventId) return false;
  const result = await db
    .prepare('INSERT INTO processed_events (event_id, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING')
    .bind(eventId, now)
    .run();
  return (result.meta.changes ?? 0) === 0;
}

export async function handleWebhook(body: WebhookBody, env: Env): Promise<void> {
  for (const event of body.events ?? []) {
    try {
      await handleEvent(event, env);
    } catch (error) {
      // 1イベントの失敗で残りを落とさない
      console.error('[webhook] event failed:', error);
    }
  }
}

async function handleEvent(event: LineEvent, env: Env): Promise<void> {
  const now = Date.now();
  const source = event.source;
  if (!source) return;
  const id = sourceId(source);
  if (!id) return;

  if (await alreadyProcessed(env.DB, event.webhookEventId, now)) return;

  const household = await ensureHousehold(env.DB, source.type, id, now);
  if (source.userId) {
    await ensureMember(env.DB, household.id, source.userId, null, now);
  }
  await touchHousehold(env.DB, household.id, now);

  const token = env.LINE_CHANNEL_ACCESS_TOKEN;

  if (event.type === 'follow' || event.type === 'join') {
    if (event.replyToken) await reply(token, event.replyToken, [text(WELCOME_TEXT)]);
    return;
  }

  if (event.type === 'postback' && event.replyToken) {
    await handlePostback(event.postback?.data ?? '', household.id, event.replyToken, env, now);
    return;
  }

  if (event.type !== 'message' || event.message?.type !== 'text') return;
  const body = event.message.text?.trim();
  if (!body || !event.replyToken) return;

  const messages = await handleTextMessage(body, household.id, source.userId ?? null, env, now);
  await reply(token, event.replyToken, messages);
}

async function handleTextMessage(
  body: string,
  householdId: string,
  userId: string | null,
  env: Env,
  now: number,
): Promise<LineMessage[]> {
  const command = parseCommand(body);

  switch (command.kind) {
    case 'help':
      return [text(HELP_TEXT)];

    case 'show': {
      const list = await getActiveList(env.DB, householdId);
      const items = list ? await getItems(env.DB, list.id) : [];
      const route = await loadRoute(env.DB, householdId);
      return [listCard(items, env.LIFF_ID, { precedence: route.counts })];
    }

    case 'complete': {
      const list = await getActiveList(env.DB, householdId);
      if (!list) return [text('いま進行中のリストはありません。')];
      const result = await completeList(env.DB, householdId, list, now);
      // 完了処理の中で観測回数が進むので、進捗はここで読み直す
      const route = await loadRoute(env.DB, householdId);
      return [
        text(
          completionSummary(
            result.purchased.length,
            result.carriedOver,
            result.promoted,
            route.progress,
          ),
        ),
      ];
    }

    case 'usual': {
      const catalog = (await listCatalog(env.DB, householdId)).map(toSnapshot);
      const { counts, trips } = await appearanceCounts(env.DB, householdId, 8);
      const usual = usualItems(catalog, counts, trips);
      if (usual.length === 0) {
        return [text('まだ「いつもの」を判断できるほど履歴がありません。何回か買い物を記録すると使えるようになります。')];
      }
      const list = await ensureActiveList(env.DB, householdId, userId, now);
      const parsed: ParsedItem[] = usual.map((item) => ({
        raw: item.canonical_name,
        name: item.canonical_name,
        quantity: item.default_quantity,
        unit: item.default_unit,
        note: null,
        category: item.category,
        confidence: 1,
      }));
      const result = await addParsedItems(env.DB, householdId, list, parsed, 'suggestion', now);
      const items = await getItems(env.DB, list.id);
      const route = await loadRoute(env.DB, householdId);
      return [
        text(`いつもの ${result.added.length} 件を追加しました。`),
        listCard(items, env.LIFF_ID, { precedence: route.counts }),
      ];
    }

    case 'suggest': {
      const catalog = (await listCatalog(env.DB, householdId)).map(toSnapshot);
      const list = await getActiveList(env.DB, householdId);
      const onList = new Set(
        list
          ? (await getItems(env.DB, list.id))
              .map((item) => item.catalog_item_id)
              .filter((value): value is string => value !== null)
          : [],
      );
      const suggestions = suggestItems(catalog, { now, excludeIds: onList });
      return [suggestionCard(suggestions, env.LIFF_ID)];
    }

    case 'clear': {
      const list = await getActiveList(env.DB, householdId);
      if (!list) return [text('リストはすでに空です。')];
      await env.DB.prepare('DELETE FROM list_items WHERE list_id = ?').bind(list.id).run();
      return [text('リストを空にしました。')];
    }

    case 'remove': {
      const list = await getActiveList(env.DB, householdId);
      if (!list) return [text('いま進行中のリストはありません。')];
      const removed = await removeByName(env.DB, householdId, list.id, command.name);
      return [
        removed
          ? text(`${removed.name} を外しました。`)
          : text(`「${command.name}」はリストにありませんでした。`),
      ];
    }

    case 'items': {
      const catalog = await listCatalog(env.DB, householdId);
      const result = await parseMessage(body, {
        knownItems: catalog.map((row) => row.canonical_name),
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_MODEL,
      });

      if (result.items.length === 0) {
        // 買い物メモではなかった = ふつうの会話。Botは黙る。
        return [];
      }

      const list = await ensureActiveList(env.DB, householdId, userId, now);
      const added = await addParsedItems(env.DB, householdId, list, result.items, 'line', now);
      const items = await getItems(env.DB, list.id);
      const route = await loadRoute(env.DB, householdId);
      return [
        text(addedSummary(added.added, added.updated, result.ignored.length)),
        listCard(items, env.LIFF_ID, { precedence: route.counts }),
      ];
    }
  }
}

async function handlePostback(
  data: string,
  householdId: string,
  replyToken: string,
  env: Env,
  now: number,
): Promise<void> {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;

  if (data.startsWith('add:')) {
    const catalogItemId = data.slice(4);
    const row = await env.DB
      .prepare('SELECT * FROM catalog_items WHERE id = ? AND household_id = ?')
      .bind(catalogItemId, householdId)
      .first<import('../types').CatalogRow>();
    if (!row) {
      await reply(token, replyToken, [text('その品物は見つかりませんでした。')]);
      return;
    }
    const list = await ensureActiveList(env.DB, householdId, null, now);
    const result = await addParsedItems(
      env.DB,
      householdId,
      list,
      [
        {
          raw: row.canonical_name,
          name: row.canonical_name,
          quantity: row.default_quantity,
          unit: row.default_unit,
          note: null,
          category: row.category,
          confidence: 1,
        },
      ],
      'suggestion',
      now,
    );
    const label = result.added[0] ?? result.updated[0];
    await reply(token, replyToken, [
      text(label ? `${formatItemLine(label)} を追加しました。` : '追加しました。'),
    ]);
    return;
  }

  await reply(token, replyToken, [text('その操作はわかりませんでした。')]);
}
